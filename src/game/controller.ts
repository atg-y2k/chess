/**
 * Game flow and analysis orchestration: player move -> coach -> bot move, live evaluation,
 * background annotation of every ply, hints, takebacks, game end + rating, review and PGN.
 *
 * The UI renders `controller.store` (signals + computed view models, see store.ts) and calls the
 * methods below. Every async continuation (bot move, annotation, hint, review) is guarded by the
 * game id plus an epoch/ply token, so undo, new game or resign can never apply stale results.
 */
import { batch } from '@preact/signals';
import { Chess, type Move } from 'chess.js';
import { classifyMove } from '../analysis/classify';
import { explainBestMove, explainMove, type PrevMove } from '../analysis/explain';
import type { Explanation } from '../analysis/types';
import { resultScore } from '../analysis/winprob';
import { BotPlayer } from '../bot/BotPlayer';
import { currentOpening, isBookMove, loadOpenings } from '../bot/book';
import { customPersona, personaById } from '../bot/personas';
import { hashSeed, mulberry32 } from '../bot/strength';
import type { BotMove } from '../bot/types';
import { START_FEN, fenKey, formatLine, otherColor, parseUci, pvToSan, toWhitePov, uciToSan } from '../chess/utils';
import { AnalysisService, type AnalysisServiceOptions } from '../engine/AnalysisService';
import { createEngines, type EngineSet } from '../engine/createEngines';
import { inspectPosition } from '../engine/StockfishEngine';
import type { AnalysisResult, ChessEngine, Score } from '../engine/types';
import { engineSupported } from '../engine/workerTransport';
import { applyGameResult, loadProfile, playerScoreFor, saveProfile, updateGameRecord } from '../rating/rating';
import {
  clearGame,
  createGameId,
  loadGame,
  loadSettings,
  saveGame,
  saveSettings,
  type KeyValueStorage,
  type PlyAnnotation,
  type SavedGame,
} from './persistence';
import { buildPgn, type PgnPlayer } from './pgn';
import { emptyCounts, summarizeGame } from './review';
import { playSound, setSoundEnabled, soundForSan, type SoundKind } from './sound';
import {
  SHALLOW_DEPTH,
  createState,
  createStore,
  personaForSettings,
  uciArrow,
  whiteScore,
  type CoachActionId,
  type GameInfo,
  type ReadonlyStore,
  type SheetName,
  type Store,
} from './store';
import type { Color, GameOutcome, GameSettings, Ply, PromotionPiece } from './types';

/** Minimum depth of the per-ply annotations (and hints / review). */
export const ANNOTATE_DEPTH = 14;
/** MultiPV of the per-ply annotations. */
export const ANNOTATE_MULTIPV = 3;
/** Shown when the engine cannot start. */
export const ENGINE_ADVICE = 'Your browser may not support WebAssembly SIMD (iOS 16.4+ required).';

/** Sound output (default: game/sound.ts). */
export interface SoundPort {
  play(kind: SoundKind): void;
  setEnabled(on: boolean): void;
}

/** What the controller needs from a bot (BotPlayer implements it). */
export interface BotLike {
  newGame(elo: number): Promise<void>;
  move(fen: string, elo: number, history: string[], signal?: AbortSignal): Promise<BotMove | null>;
}

/** Injectable dependencies (all optional; tests replace the engine, storage, clock and randomness). */
export interface ControllerDeps {
  /** Engine factory (default: `createEngines()` after a WebAssembly SIMD check). */
  createEngines?: () => Promise<EngineSet>;
  /** Storage for settings, profile and the saved game (default: localStorage). */
  storage?: KeyValueStorage | null;
  /** Randomness for the "random" colour (default Math.random). */
  rng?: () => number;
  sound?: SoundPort;
  /** Clock in ms since the epoch (default Date.now). */
  now?: () => number;
  /** Human-like bot think delay (default true). */
  thinkDelay?: boolean;
  /** Bot factory (default: `new BotPlayer(engine, opts)`); `rng` is seeded from the game id. */
  createBot?: (engine: ChessEngine, opts: { rng: () => number; thinkDelay: boolean }) => BotLike;
  /** Game id factory (default: createGameId()). */
  createId?: () => string;
  /** AnalysisService tuning (live depth etc.). */
  analysisOptions?: AnalysisServiceOptions;
}

export interface NewGameOptions {
  /** Start from this position instead of the initial one (must be legal). */
  startFen?: string;
}

type AnnotateResult = 'done' | 'stale' | 'failed';

const isAnnotated = (p: Ply): boolean => !!(p.classification && p.explanation && p.evalWhite);
const annotationKey = (gameId: string, p: Ply): string => `${gameId}|${p.index}|${p.fenBefore}|${p.uci}`;
const uciOf = (m: Pick<Move, 'from' | 'to' | 'promotion'>): string => m.from + m.to + (m.promotion ?? '');
const prevMoveOf = (p: Ply): PrevMove => ({ to: p.uci.slice(2, 4), ...(p.captured ? { captured: p.captured } : {}) });

async function defaultCreateEngines(): Promise<EngineSet> {
  if (!engineSupported()) throw new Error('Web Workers or WebAssembly SIMD are not available.');
  return createEngines();
}

function isScore(v: unknown): v is Score {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as { kind?: unknown; value?: unknown };
  return (s.kind === 'cp' || s.kind === 'mate') && typeof s.value === 'number' && Number.isFinite(s.value);
}

/**
 * The app's game controller. Create one, call `boot()`, render `store` (view models in store.ts),
 * and forward UI events to the methods below. One instance per page.
 */
export class GameController {
  /** Signals and view models for the UI (read-only). */
  readonly store: ReadonlyStore;

  private readonly s: Store;
  private readonly storage: KeyValueStorage | null | undefined;
  private readonly rng: () => number;
  private readonly sound: SoundPort;
  private readonly now: () => number;
  private readonly thinkDelay: boolean;
  private readonly makeEngines: () => Promise<EngineSet>;
  private readonly makeBotPlayer: NonNullable<ControllerDeps['createBot']>;
  private readonly createId: () => string;
  private readonly analysisOptions: AnalysisServiceOptions;

  private engines: EngineSet | null = null;
  private analysis: AnalysisService | null = null;
  private unsubscribe: (() => void) | null = null;
  private bot: BotLike | null = null;
  private botReady: Promise<void> = Promise.resolve();
  /** The live game (history kept for threefold repetition). */
  private chess = new Chess();
  /** Bumped whenever the move sequence is rewritten (new game, undo, restore, game end). */
  private epoch = 0;
  private botCtl: AbortController | null = null;
  private botTask: Promise<void> | null = null;
  private annotating: Promise<void> | null = null;
  private reviewTask: Promise<void> | null = null;
  private booting: Promise<void> | null = null;
  /** Plies whose analysis failed (skipped by the background queue; the review retries them). */
  private readonly failed = new Set<string>();
  private hidden = false;
  private openingsReady: Promise<void> = Promise.resolve();

  constructor(deps: ControllerDeps = {}) {
    this.storage = deps.storage;
    this.rng = deps.rng ?? Math.random;
    this.sound = deps.sound ?? { play: playSound, setEnabled: setSoundEnabled };
    this.now = deps.now ?? Date.now;
    this.thinkDelay = deps.thinkDelay ?? true;
    this.makeEngines = deps.createEngines ?? defaultCreateEngines;
    this.makeBotPlayer = deps.createBot ?? ((engine, opts) => new BotPlayer(engine, opts));
    this.createId = deps.createId ?? createGameId;
    this.analysisOptions = deps.analysisOptions ?? {};
    this.s = createStore(createState({ settings: loadSettings(this.storage), profile: loadProfile(this.storage) }));
    this.store = this.s;
  }

  // -----------------------------------------------------------------------------------------------
  // Boot

  /**
   * Loads settings and profile, starts the engines and the opening book, then restores a saved
   * game (the bot moves if it is its turn) or enters 'setup' with the new-game sheet open.
   * On engine failure the phase becomes 'error' (see `store.error`); call `retry()`.
   */
  boot(): Promise<void> {
    this.booting ??= this.doBoot().finally(() => {
      this.booting = null;
    });
    return this.booting;
  }

  /** Tears down the engines and boots again (the error screen's "Try again"). */
  retry(): Promise<void> {
    this.teardown();
    return this.boot();
  }

  /** Stops everything and terminates the engines. */
  dispose(): void {
    this.teardown();
  }

  private async doBoot(): Promise<void> {
    const s = this.s;
    batch(() => {
      s.phase.value = 'boot';
      s.error.value = null;
      s.settings.value = loadSettings(this.storage);
      s.profile.value = loadProfile(this.storage);
    });
    // Sound starts enabled; turning it on (which unlocks Web Audio) waits for a tap: newGame() / setSettings().
    if (!s.settings.value.sound) this.sound.setEnabled(false);
    this.openingsReady = loadOpenings().then(
      () => this.refreshOpenings(),
      (e: unknown) => console.warn('[game] opening book unavailable', e),
    );
    let engines: EngineSet;
    try {
      engines = await this.makeEngines();
    } catch (e) {
      console.error('[game] engine start failed', e);
      batch(() => {
        s.error.value = {
          message: 'The chess engine could not start.',
          advice: ENGINE_ADVICE,
          detail: e instanceof Error ? e.message : String(e),
        };
        s.phase.value = 'error';
      });
      return;
    }
    this.engines = engines;
    this.analysis = new AnalysisService(engines.analysis, this.analysisOptions);
    this.unsubscribe = this.analysis.subscribe((r) => this.onLive(r));
    if (this.hidden) this.analysis.setPaused(true);
    s.engineMode.value = engines.mode;
    let saved = loadGame(this.storage);
    if (saved) {
      try {
        inspectPosition(saved.startFen);
      } catch {
        clearGame(this.storage);
        saved = null;
      }
    }
    if (saved) this.restore(saved);
    else {
      batch(() => {
        s.phase.value = 'setup';
        s.sheet.value = 'new';
      });
    }
  }

  private teardown(): void {
    this.abortBot();
    this.epoch++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.analysis) {
      this.analysis.watch(null);
      this.analysis.cancelAll();
    }
    this.engines?.terminate();
    this.engines = null;
    this.analysis = null;
  }

  /** Rebuilds a saved game (plies + annotations) and continues it. */
  private restore(saved: SavedGame): void {
    const s = this.s;
    const chess = new Chess(saved.startFen);
    const plies: Ply[] = [];
    for (const uci of saved.moves) {
      let mv: Move;
      try {
        mv = chess.move(parseUci(uci));
      } catch {
        break;
      }
      const ply = this.plyFromMove(mv, plies);
      const a = saved.annotations[ply.index];
      if (a) Object.assign(ply, a);
      plies.push(ply);
    }
    const settings = s.settings.value;
    const persona = (saved.botId !== 'custom' && personaById(saved.botId)) || customPersona(saved.botElo);
    const game: GameInfo = {
      id: saved.id,
      startFen: saved.startFen,
      playerColor: saved.playerColor,
      bot: persona,
      botElo: saved.botElo,
      startedAt: saved.startedAt,
      assisted: saved.assisted,
      settings: {
        ...settings,
        playerColor: saved.playerColor,
        botId: persona.id,
        botElo: saved.botElo,
        adaptive: settings.adaptive && persona.id === 'custom',
      },
    };
    const startEval = (saved as SavedGame & { startEval?: unknown }).startEval;
    this.chess = chess;
    this.epoch++;
    this.failed.clear();
    this.bot = this.makeBot(game.id);
    this.botReady = this.bot.newGame(game.botElo).catch((e: unknown) => console.warn('[game] bot newGame failed', e));
    batch(() => {
      s.game.value = game;
      s.plies.value = plies;
      s.startEval.value = isScore(startEval) ? startEval : null;
      s.viewIndex.value = null;
      s.flipped.value = false;
      s.outcome.value = null;
      s.ratingChange.value = null;
      s.reviewState.value = null;
      s.coachMode.value = { kind: 'idle' };
      s.coachCollapsed.value = null;
      s.live.value = null;
      s.botThinking.value = false;
      s.sheet.value = null;
      s.phase.value = 'playing';
    });
    this.updateWatch();
    this.kickAnnotations();
    if (!this.checkGameEnd()) this.requestBotMove();
  }

  // -----------------------------------------------------------------------------------------------
  // Game flow

  /**
   * Starts a new game with these settings (persisted as the new defaults): resolves a 'random'
   * colour, the opponent (persona, custom Elo, or the adaptive "match my rating" Elo), seeds the
   * bot from the game id, and lets the bot move first when the human plays Black.
   */
  newGame(settings: GameSettings, opts: NewGameOptions = {}): void {
    const next = { ...settings };
    this.s.settings.value = next;
    saveSettings(next, this.storage);
    this.sound.setEnabled(next.sound);
    this.startGame(next, opts.startFen);
  }

  /** Same opponent, same colour, same options (adaptive games re-match the new rating). */
  rematch(): void {
    const g = this.s.game.value;
    if (!g) {
      this.openSheet('new');
      return;
    }
    this.startGame({ ...g.settings, playerColor: g.playerColor }, g.startFen);
  }

  private startGame(settings: GameSettings, startFen = START_FEN): void {
    if (!this.analysis || !this.engines) return;
    let chess: Chess;
    try {
      inspectPosition(startFen); // chess.js validity plus "the side not to move is not in check"
      chess = new Chess(startFen);
    } catch {
      console.warn('[game] invalid start position; using the initial position', startFen);
      startFen = START_FEN;
      chess = new Chess();
    }
    const s = this.s;
    this.abortBot();
    this.analysis.cancelAll();
    this.epoch++;
    this.failed.clear();
    const playerColor: Color =
      settings.playerColor === 'random' ? (this.rng() < 0.5 ? 'w' : 'b') : settings.playerColor;
    const bot = personaForSettings(settings, s.profile.value);
    const id = this.createId();
    const game: GameInfo = {
      id,
      startFen,
      playerColor,
      bot,
      botElo: bot.elo,
      startedAt: new Date(this.now()).toISOString(),
      assisted: settings.showBestMoves,
      settings: { ...settings },
    };
    this.chess = chess;
    this.bot = this.makeBot(id);
    this.botReady = this.bot.newGame(bot.elo).catch((e: unknown) => console.warn('[game] bot newGame failed', e));
    batch(() => {
      s.game.value = game;
      s.plies.value = [];
      s.startEval.value = null;
      s.viewIndex.value = null;
      s.flipped.value = false;
      s.outcome.value = null;
      s.ratingChange.value = null;
      s.reviewState.value = null;
      s.coachMode.value = { kind: 'idle' };
      s.coachCollapsed.value = null;
      s.live.value = null;
      s.botThinking.value = false;
      s.sheet.value = null;
      s.phase.value = 'playing';
    });
    this.sound.play('gameStart');
    this.updateWatch();
    this.save();
    if (!this.checkGameEnd()) this.requestBotMove();
  }

  private makeBot(gameId: string): BotLike {
    return this.makeBotPlayer(this.engines!.bot, { rng: mulberry32(hashSeed(gameId)), thinkDelay: this.thinkDelay });
  }

  /**
   * The human's move (Board `onMove`). Validated with chess.js; when legal, `store.plies` (and so
   * `store.board.fen`) is updated synchronously, then the coach, the annotation queue and the bot
   * reply are started. Returns false (and plays the "illegal" sound) when the move is rejected.
   */
  playerMove(from: string, to: string, promotion?: PromotionPiece): boolean {
    const s = this.s;
    if (!s.game.value || !s.humanToMove.value || !s.isLive.value || s.coachMode.value.kind === 'showBest') return false;
    let mv: Move;
    try {
      mv = this.chess.move({ from, to, promotion });
    } catch {
      try {
        if (promotion) throw new Error('illegal');
        mv = this.chess.move({ from, to, promotion: 'q' });
      } catch {
        this.sound.play('illegal');
        return false;
      }
    }
    this.pushPly(mv);
    return true;
  }

  /** Appends a ply (either side) and runs everything that follows a move. */
  private pushPly(mv: Move): Ply {
    const s = this.s;
    const g = s.game.value!;
    const ply = this.plyFromMove(mv, s.plies.value);
    batch(() => {
      s.plies.value = [...s.plies.value, ply];
      if (ply.color === g.playerColor) s.coachMode.value = { kind: 'feedback', index: ply.index };
    });
    this.sound.play(soundForSan(ply.san));
    this.updateWatch();
    this.kickAnnotations();
    if (!this.checkGameEnd()) {
      this.save();
      this.requestBotMove();
    }
    return ply;
  }

  private plyFromMove(mv: Move, previous: readonly Ply[]): Ply {
    const ply: Ply = {
      index: previous.length,
      color: mv.color,
      san: mv.san,
      uci: uciOf(mv),
      fenBefore: mv.before,
      fenAfter: mv.after,
    };
    if (mv.captured) ply.captured = mv.captured;
    const o = currentOpening([...previous.map((p) => p.fenAfter), mv.after]);
    if (o) ply.opening = { eco: o.eco, name: o.name };
    return ply;
  }

  /** Asks the bot for a move when it is its turn (no-op otherwise, or while the page is hidden). */
  private requestBotMove(): void {
    const s = this.s;
    const g = s.game.value;
    if (!g || !this.bot || s.phase.value !== 'playing' || s.outcome.value || this.hidden || this.botCtl) return;
    if (this.chess.turn() === g.playerColor || this.chess.isGameOver()) return;
    const ctl = new AbortController();
    this.botCtl = ctl;
    const epoch = this.epoch;
    const plyCount = s.plies.value.length;
    const bot = this.bot;
    const fen = this.chess.fen();
    const history = s.plies.value.map((p) => p.uci);
    const stillCurrent = () =>
      !ctl.signal.aborted &&
      this.epoch === epoch &&
      s.game.value?.id === g.id &&
      s.plies.value.length === plyCount &&
      !s.outcome.value;
    s.botThinking.value = true;
    const run = async (): Promise<void> => {
      try {
        await this.botReady;
        if (!stillCurrent()) return;
        const move = await bot.move(fen, g.botElo, history, ctl.signal);
        if (this.botCtl === ctl) {
          this.botCtl = null;
          s.botThinking.value = false;
        }
        if (!move || !stillCurrent()) return;
        this.applyBotMove(move.uci);
      } catch (e) {
        console.error('[game] bot move failed', e);
        if (this.botCtl === ctl) {
          this.botCtl = null;
          s.botThinking.value = false;
        }
      }
    };
    const task = run();
    this.botTask = task;
    void task.then(() => {
      if (this.botTask === task) this.botTask = null;
    });
  }

  private applyBotMove(uci: string): void {
    let mv: Move;
    try {
      mv = this.chess.move(parseUci(uci));
    } catch {
      console.warn('[game] the bot chose an illegal move; playing the first legal one', uci);
      const legal = this.chess.moves({ verbose: true });
      if (!legal.length) return;
      mv = this.chess.move({ from: legal[0].from, to: legal[0].to, promotion: legal[0].promotion });
    }
    this.pushPly(mv);
  }

  private abortBot(): void {
    if (this.botCtl) {
      this.botCtl.abort();
      this.botCtl = null;
    }
    if (this.s.botThinking.value) this.s.botThinking.value = false;
  }

  /** Detects checkmate / draws on the live position and finishes the game. */
  private checkGameEnd(): boolean {
    const c = this.chess;
    let outcome: GameOutcome | null = null;
    if (c.isCheckmate()) {
      const winner = otherColor(c.turn());
      outcome = { result: winner === 'w' ? '1-0' : '0-1', winner, reason: 'Checkmate' };
    } else if (c.isStalemate()) outcome = { result: '1/2-1/2', winner: null, reason: 'Stalemate' };
    else if (c.isInsufficientMaterial()) outcome = { result: '1/2-1/2', winner: null, reason: 'Insufficient material' };
    else if (c.isThreefoldRepetition()) outcome = { result: '1/2-1/2', winner: null, reason: 'Threefold repetition' };
    else if (c.isDrawByFiftyMoves()) outcome = { result: '1/2-1/2', winner: null, reason: '50-move rule' };
    if (!outcome) return false;
    this.finish(outcome);
    return true;
  }

  /** Ends the game: rating (rated unless assisted), history record with PGN, game-over sheet. */
  private finish(outcome: GameOutcome): void {
    const s = this.s;
    const g = s.game.value!;
    this.abortBot();
    this.epoch++;
    const rated = !g.assisted;
    const pgn = this.pgnText(outcome, false);
    const { profile, record } = applyGameResult(s.profile.value, {
      id: g.id,
      date: new Date(this.now()).toISOString(),
      playerColor: g.playerColor,
      botName: g.bot.name,
      botElo: g.botElo,
      result: outcome.result,
      playerScore: playerScoreFor(outcome.result, g.playerColor),
      rated,
      reason: outcome.reason,
      pgn,
    });
    saveProfile(profile, this.storage);
    clearGame(this.storage);
    batch(() => {
      s.outcome.value = outcome;
      s.profile.value = profile;
      s.ratingChange.value = { before: record.ratingBefore, after: record.ratingAfter, rated: record.rated };
      s.phase.value = 'over';
      s.sheet.value = 'gameOver';
      s.viewIndex.value = null;
      s.coachMode.value = { kind: 'idle' };
    });
    this.sound.play('gameEnd');
    this.updateWatch();
  }

  /**
   * Takes back the human's last move (and the bot's reply, if any), aborting a pending bot move.
   * Only while playing, with takebacks allowed and a human move to take back. Marks the game
   * assisted (unrated). Returns whether anything was undone.
   */
  undo(): boolean {
    const s = this.s;
    const g = s.game.value;
    if (!g || s.phase.value !== 'playing' || s.outcome.value || !s.settings.value.allowTakebacks) return false;
    const ps = s.plies.value;
    let target = ps.length;
    while (target > 0 && ps[target - 1].color !== g.playerColor) target--;
    if (target === 0) return false;
    this.truncate(target - 1);
    this.markAssisted();
    batch(() => {
      s.coachMode.value = { kind: 'idle' };
      s.viewIndex.value = null;
    });
    this.updateWatch();
    this.save();
    this.requestBotMove();
    return true;
  }

  /** "Retry" after a mistake: back to the position before human ply `index` (assisted). */
  private retryMove(index: number): void {
    const s = this.s;
    const g = s.game.value;
    const ply = s.plies.value[index];
    if (!g || !ply || ply.color !== g.playerColor) return;
    if (s.phase.value !== 'playing' || s.outcome.value || !s.settings.value.allowTakebacks) return;
    this.truncate(index);
    this.markAssisted();
    batch(() => {
      s.viewIndex.value = null;
      s.coachMode.value = {
        kind: 'retry',
        san: ply.san,
        cls: ply.classification?.cls ?? 'mistake',
        headline: ply.explanation?.headline ?? null,
      };
    });
    this.updateWatch();
    this.save();
  }

  private truncate(n: number): void {
    this.abortBot();
    this.epoch++;
    const ps = this.s.plies.value;
    for (let i = ps.length; i > n; i--) this.chess.undo();
    this.s.plies.value = ps.slice(0, n);
  }

  /** Resigns the game in progress (a loss; rated unless assisted). */
  resign(): void {
    const s = this.s;
    const g = s.game.value;
    if (!g || s.phase.value !== 'playing' || s.outcome.value) return;
    const winner = otherColor(g.playerColor);
    this.finish({ result: winner === 'w' ? '1-0' : '0-1', winner, reason: 'Resignation' });
  }

  private markAssisted(): void {
    const s = this.s;
    const g = s.game.value;
    if (!g || g.assisted || s.phase.value !== 'playing') return;
    s.game.value = { ...g, assisted: true };
    this.save();
  }

  // -----------------------------------------------------------------------------------------------
  // Coach, hints, settings

  /**
   * Hint on the human's turn: analyses the position (depth 14, MultiPV 3) and shows why the best
   * move is good, with its arrow. Marks the game assisted. Calling it while a hint is shown
   * dismisses the hint.
   */
  async hint(): Promise<void> {
    const s = this.s;
    const svc = this.analysis;
    const m = s.coachMode.value;
    if (m.kind === 'hint') {
      this.dismissHint();
      return;
    }
    const g = s.game.value;
    if (!svc || !g || !s.humanToMove.value || !s.isLive.value || m.kind === 'showBest') return;
    const fen = s.liveFen.value;
    const epoch = this.epoch;
    this.markAssisted();
    s.coachMode.value = { kind: 'hint', fen, explanation: null, prev: m };
    this.updateWatch();
    let r: AnalysisResult;
    try {
      r = await svc.ensure(fen, { minDepth: ANNOTATE_DEPTH, multiPv: ANNOTATE_MULTIPV });
    } catch {
      r = { fen, depth: 0, lines: [], bestMove: null, done: false, aborted: true };
    }
    const now = s.coachMode.value;
    if (this.epoch !== epoch || s.game.value?.id !== g.id || now.kind !== 'hint' || now.fen !== fen) return;
    const line = r.lines[0];
    const prev = s.plies.value.at(-1);
    let explanation: Explanation;
    if (line) {
      const e = explainBestMove(fen, line, { prevMove: prev ? prevMoveOf(prev) : undefined, perspective: 'you' });
      explanation = { ...e, arrows: e.arrows?.length ? e.arrows : uciArrow(line.pv[0], 'best') };
    } else {
      explanation = { headline: 'No hint is available for this position.', details: [] };
    }
    s.coachMode.value = { ...now, explanation };
  }

  /** Hides the hint (back to what the coach showed before). */
  dismissHint(): void {
    const m = this.s.coachMode.value;
    if (m.kind === 'hint') this.s.coachMode.value = m.prev;
    this.updateWatch();
  }

  /** Runs a coach-panel action by id (the ids in `store.coach.value.actions`). */
  runAction(id: CoachActionId): void {
    const s = this.s;
    const m = s.coachMode.value;
    switch (id) {
      case 'showBest': {
        const index = s.phase.value === 'playing' && s.isLive.value && m.kind === 'feedback' ? m.index : s.current.value - 1;
        if (index >= 0) this.showBest(index);
        return;
      }
      case 'retry': {
        const index = m.kind === 'feedback' || m.kind === 'showBest' ? m.index : -1;
        if (index >= 0) this.retryMove(index);
        return;
      }
      case 'backToGame':
        if (m.kind === 'showBest') this.backFromShowBest();
        else this.goTo(null);
        return;
      case 'dismissHint':
        this.dismissHint();
        return;
      case 'review':
        void this.startReview();
        return;
      case 'newGame':
        this.openSheet('new');
        return;
      case 'rematch':
        this.rematch();
        return;
      case 'retryBoot':
        void this.retry();
        return;
    }
  }

  /** Shows the position before ply `index` with the best move and the played move as arrows. */
  private showBest(index: number): void {
    const s = this.s;
    const g = s.game.value;
    const ply = s.plies.value[index];
    const cl = ply?.classification;
    if (!g || !ply || !cl) return;
    const before = this.analysis?.get(ply.fenBefore);
    const bestUci = cl.bestMoveUci ?? before?.lines[0]?.pv[0] ?? null;
    const line = before?.lines.find((l) => l.pv[0] === bestUci) ?? null;
    const human = ply.color === g.playerColor;
    const prev = index > 0 ? s.plies.value[index - 1] : undefined;
    const lines: string[] = [];
    if (line) {
      const e = explainBestMove(ply.fenBefore, line, {
        prevMove: prev ? prevMoveOf(prev) : undefined,
        perspective: human ? 'you' : 'neutral',
      });
      lines.push(e.headline, ...e.details.slice(0, 2));
      const san = pvToSan(ply.fenBefore, line.pv, 8);
      if (san.length > 1) lines.push(`Best line: ${formatLine(ply.fenBefore, san)}`);
    }
    lines.push(human ? `You played ${ply.san}.` : `${g.bot.name} played ${ply.san}.`);
    const bestSan = cl.bestMoveSan ?? (bestUci ? uciToSan(ply.fenBefore, bestUci) : null);
    batch(() => {
      s.coachMode.value = {
        kind: 'showBest',
        index,
        bestUci,
        bestSan,
        lines,
        returnTo: s.viewIndex.value,
        prev: s.coachMode.value,
      };
      s.viewIndex.value = index;
    });
    this.updateWatch();
  }

  private backFromShowBest(): void {
    const s = this.s;
    const m = s.coachMode.value;
    if (m.kind !== 'showBest') return;
    batch(() => {
      s.viewIndex.value = m.returnTo;
      s.coachMode.value = m.prev.kind === 'showBest' ? { kind: 'idle' } : m.prev;
    });
    this.updateWatch();
  }

  /**
   * Changes settings (persisted). Applies sound on/off; switching best-move arrows on during a
   * game marks it assisted.
   */
  setSettings(partial: Partial<GameSettings>): void {
    const s = this.s;
    const prev = s.settings.value;
    const next: GameSettings = { ...prev, ...partial };
    s.settings.value = next;
    saveSettings(next, this.storage);
    if (next.sound !== prev.sound) this.sound.setEnabled(next.sound);
    if (next.coach !== prev.coach) s.coachCollapsed.value = null;
    if (next.showBestMoves && !prev.showBestMoves) this.markAssisted();
    this.updateWatch();
  }

  /** Toolbar "Coach" toggle. */
  toggleCoach(): void {
    this.setSettings({ coach: !this.s.settings.value.coach });
  }

  /** Collapses / expands the coach panel (overrides the automatic state). */
  toggleCoachCollapsed(): void {
    this.s.coachCollapsed.value = !this.s.coach.value.collapsed;
  }

  /** Flips the board (the player strips swap too). */
  flip(): void {
    this.s.flipped.value = !this.s.flipped.value;
  }

  openSheet(name: SheetName): void {
    this.s.sheet.value = name;
  }

  closeSheet(): void {
    this.s.sheet.value = null;
  }

  // -----------------------------------------------------------------------------------------------
  // History browsing

  /**
   * Shows the position after `index` plies (null or >= plies.length = live). The board is
   * read-only while browsing; new bot moves do not move the view. Leaves a "Show best" preview.
   */
  goTo(index: number | null): void {
    const s = this.s;
    if (!s.game.value) return;
    const n = s.plies.value.length;
    const v = index === null || index >= n ? null : Math.max(0, Math.floor(index));
    batch(() => {
      const m = s.coachMode.value;
      if (m.kind === 'showBest') s.coachMode.value = m.prev.kind === 'showBest' ? { kind: 'idle' } : m.prev;
      s.viewIndex.value = v;
    });
    this.updateWatch();
  }

  /** One ply back (toolbar ‹). */
  stepBack(): void {
    const c = this.s.current.value;
    if (c > 0) this.goTo(c - 1);
  }

  /** One ply forward (toolbar ›); reaching the last ply returns to live. */
  stepForward(): void {
    if (this.s.isLive.value) return;
    this.goTo(this.s.current.value + 1);
  }

  /** The "Back to game" chip. */
  backToLive(): void {
    if (this.s.coachMode.value.kind === 'showBest') this.backFromShowBest();
    this.goTo(null);
  }

  // -----------------------------------------------------------------------------------------------
  // Review

  /**
   * Game review (after the game): analyses every position (depth 14, MultiPV 3, reusing the
   * cache), classifies and explains any ply still missing, then fills `store.review` with
   * accuracy, counts and key moments and stores the player's accuracy in the game record.
   * Resolves when the review is complete (or abandoned).
   */
  startReview(): Promise<void> {
    const s = this.s;
    const g = s.game.value;
    if (!g || (s.phase.value !== 'over' && s.phase.value !== 'review')) return Promise.resolve();
    if (s.phase.value === 'review' && this.reviewTask) return this.reviewTask;
    batch(() => {
      s.phase.value = 'review';
      s.sheet.value = null;
      s.coachMode.value = { kind: 'idle' };
      s.reviewState.value = { progress: 0, accuracy: { w: null, b: null }, counts: emptyCounts(), keyMoments: [] };
    });
    this.failed.clear();
    this.updateWatch();
    this.updateReviewProgress();
    const task: Promise<void> = this.runReview(g.id)
      .catch((e: unknown) => console.error('[game] review failed', e))
      .finally(() => {
        if (this.reviewTask === task) this.reviewTask = null;
      });
    this.reviewTask = task;
    return task;
  }

  /** Leaves the review (back to the finished game). */
  exitReview(): void {
    const s = this.s;
    if (s.phase.value !== 'review') return;
    batch(() => {
      s.phase.value = 'over';
      s.coachMode.value = { kind: 'idle' };
      s.viewIndex.value = null;
    });
    this.updateWatch();
  }

  private async runReview(gameId: string): Promise<void> {
    const s = this.s;
    const svc = this.analysis;
    const alive = () => s.game.value?.id === gameId && s.phase.value === 'review';
    const g = s.game.value!;
    if (svc && !s.startEval.value) {
      try {
        const r = await svc.ensure(g.startFen, { minDepth: ANNOTATE_DEPTH, multiPv: ANNOTATE_MULTIPV });
        if (!alive()) return;
        const sc = whiteScore(r);
        if (sc) s.startEval.value = sc;
      } catch (e) {
        console.warn('[game] review: start position analysis failed', e);
      }
    }
    this.updateReviewProgress();
    for (let attempt = 0; attempt < 2; attempt++) {
      this.kickAnnotations();
      while (this.annotating) await this.annotating;
      if (!alive()) return;
      if (s.plies.value.every(isAnnotated)) break;
      this.failed.clear(); // one more try for plies whose analysis failed
    }
    if (!alive()) return;
    const summary = summarizeGame(g.startFen, s.startEval.value, s.plies.value);
    s.reviewState.value = { ...summary, progress: null };
    const acc = summary.accuracy[g.playerColor];
    if (acc !== null) {
      const profile = updateGameRecord(s.profile.value, g.id, { accuracy: Math.round(acc * 10) / 10 });
      if (profile !== s.profile.value) {
        s.profile.value = profile;
        saveProfile(profile, this.storage);
      }
    }
  }

  private updateReviewProgress(): void {
    const s = this.s;
    const r = s.reviewState.value;
    if (s.phase.value !== 'review' || !r || r.progress === null) return;
    const ps = s.plies.value;
    const done = ps.filter(isAnnotated).length + (s.startEval.value ? 1 : 0);
    const progress = Math.min(0.99, done / (ps.length + 1));
    if (progress !== r.progress) s.reviewState.value = { ...r, progress };
  }

  // -----------------------------------------------------------------------------------------------
  // Annotations (background, in ply order)

  private kickAnnotations(): void {
    if (this.annotating || !this.analysis) return;
    const task: Promise<void> = this.runAnnotations()
      .catch((e: unknown) => console.error('[game] annotation failed', e))
      .finally(() => {
        if (this.annotating === task) this.annotating = null;
      });
    this.annotating = task;
  }

  private async runAnnotations(): Promise<void> {
    for (;;) {
      const g = this.s.game.value;
      if (!g || !this.analysis) return;
      const ply = this.s.plies.value.find((p) => !isAnnotated(p) && !this.failed.has(annotationKey(g.id, p)));
      if (!ply) return;
      const res = await this.annotate(g.id, ply);
      if (res === 'failed') this.failed.add(annotationKey(g.id, ply));
    }
  }

  /**
   * Analyses the positions before and after `ply` (depth 14, MultiPV 3), then classifies and
   * explains it. The previous ply is annotated first (queue order), so its winLoss is known.
   */
  private async annotate(gameId: string, ply: Ply): Promise<AnnotateResult> {
    const s = this.s;
    const svc = this.analysis!;
    const index = ply.index;
    const current = () => {
      const p = s.plies.value[index];
      return (
        this.analysis === svc &&
        s.game.value?.id === gameId &&
        !!p &&
        p.fenBefore === ply.fenBefore &&
        p.uci === ply.uci
      );
    };
    const opts = { minDepth: ANNOTATE_DEPTH, multiPv: ANNOTATE_MULTIPV };
    let before: AnalysisResult;
    let after: AnalysisResult;
    try {
      before = await svc.ensure(ply.fenBefore, opts);
      if (!current()) return 'stale';
      after = await svc.ensure(ply.fenAfter, opts);
    } catch (e) {
      console.warn('[game] analysis failed', e);
      return current() ? 'failed' : 'stale';
    }
    if (!current()) return 'stale';
    const afterScore = resultScore(after);
    if (!before.lines.length || !afterScore) return 'failed';
    await this.openingsReady;
    if (!current()) return 'stale';

    const g = s.game.value!;
    const plies = s.plies.value;
    const prev = index > 0 ? plies[index - 1] : undefined;
    const human = ply.color === g.playerColor;
    const isBook = (index === 0 || prev?.isBook === true) && isBookMove(ply.fenBefore, ply.uci, ply.fenAfter);
    const prevMove = prev ? prevMoveOf(prev) : undefined;
    const classification = classifyMove({
      fenBefore: ply.fenBefore,
      moveUci: ply.uci,
      before,
      after,
      opponentPrevWinLoss: prev?.classification?.winLoss,
      isBook,
      playerRating: human ? s.profile.value.rating : g.botElo,
      prevMove: prevMove ? { to: prevMove.to } : undefined,
    });
    const explanation = explainMove({
      fenBefore: ply.fenBefore,
      moveUci: ply.uci,
      classification,
      before,
      after,
      prevMove,
      perspective: human ? 'you' : 'neutral',
    });
    const next = plies.slice();
    next[index] = {
      ...plies[index],
      evalWhite: toWhitePov(afterScore, ply.fenAfter),
      evalDepth: after.depth,
      classification,
      explanation,
      isBook,
    };
    batch(() => {
      s.plies.value = next;
      if (index === 0) {
        const sb = whiteScore(before);
        if (sb) s.startEval.value = sb;
      }
    });
    this.save();
    this.updateReviewProgress();
    return 'done';
  }

  /** Fills in opening names once the book has loaded. */
  private refreshOpenings(): void {
    const s = this.s;
    const ps = s.plies.value;
    if (!ps.length) return;
    const fens: string[] = [];
    let changed = false;
    const next = ps.map((p) => {
      fens.push(p.fenAfter);
      const o = currentOpening(fens);
      if (!o || (p.opening && p.opening.name === o.name && p.opening.eco === o.eco)) return p;
      changed = true;
      return { ...p, opening: { eco: o.eco, name: o.name } };
    });
    if (changed) s.plies.value = next;
  }

  // -----------------------------------------------------------------------------------------------
  // Live analysis

  /** Points live analysis at the displayed position when anything needs it. */
  private updateWatch(): void {
    const svc = this.analysis;
    if (!svc) return;
    const s = this.s;
    const p = s.phase.value;
    const st = s.settings.value;
    let fen: string | null = null;
    if (p === 'over' || p === 'review') fen = s.displayedFen.value;
    else if (p === 'playing' && (st.showEvalBar || st.coach || st.showBestMoves || s.coachMode.value.kind === 'hint')) {
      fen = s.displayedFen.value;
    }
    svc.watch(fen);
  }

  private onLive(r: AnalysisResult): void {
    const s = this.s;
    const key = fenKey(r.fen);
    s.live.value = { key, result: r };
    const g = s.game.value;
    if (g && !s.startEval.value && key === fenKey(g.startFen) && r.depth >= SHALLOW_DEPTH) {
      const sc = whiteScore(r);
      if (sc) s.startEval.value = sc;
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Page lifecycle

  /**
   * Page hidden: pauses analysis and aborts a pending bot move. Visible again: resumes analysis
   * and asks the bot again if it is its turn. (AnalysisService does not watch visibility itself.)
   */
  onVisibilityChange(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.analysis?.setPaused(hidden);
    if (hidden) {
      this.abortBot();
      this.save();
    } else {
      this.requestBotMove();
    }
  }

  /**
   * Whether a service-worker update may reload the page now: only before a game (setup) or on the
   * engine error screen. Not while playing, and not after a game either: a finished game is not
   * saved, so a reload would lose its game-over screen and review. A new service worker is active
   * anyway, so the next launch runs the new version.
   */
  canReloadNow(): boolean {
    const p = this.s.phase.value;
    return p === 'setup' || p === 'error';
  }

  // -----------------------------------------------------------------------------------------------
  // PGN & persistence

  /** PGN of the current / last game, with `[%eval]` comments and NAGs where annotated ('' without a game). */
  exportPgn(): string {
    return this.pgnText(this.s.outcome.value, true);
  }

  private pgnText(outcome: GameOutcome | null, annotations: boolean): string {
    const s = this.s;
    const g = s.game.value;
    if (!g) return '';
    const rc = s.ratingChange.value;
    const human: PgnPlayer = { name: 'You', elo: rc ? rc.before : s.profile.value.rating };
    const bot: PgnPlayer = { name: g.bot.name, elo: g.botElo };
    const opening = [...s.plies.value].reverse().find((p) => p.opening)?.opening ?? null;
    return buildPgn({
      startFen: g.startFen,
      plies: s.plies.value,
      white: g.playerColor === 'w' ? human : bot,
      black: g.playerColor === 'w' ? bot : human,
      date: new Date(g.startedAt),
      result: outcome?.result ?? '*',
      ...(outcome ? { termination: outcome.reason } : {}),
      opening,
      annotations,
    });
  }

  private save(): void {
    const s = this.s;
    const g = s.game.value;
    if (!g || s.phase.value !== 'playing' || s.outcome.value) return;
    const annotations: Record<number, PlyAnnotation> = {};
    for (const p of s.plies.value) {
      const a: PlyAnnotation = {};
      if (p.evalWhite) a.evalWhite = p.evalWhite;
      if (p.evalDepth !== undefined) a.evalDepth = p.evalDepth;
      if (p.classification) a.classification = p.classification;
      if (p.explanation) a.explanation = p.explanation;
      if (p.isBook !== undefined) a.isBook = p.isBook;
      if (Object.keys(a).length) annotations[p.index] = a;
    }
    const saved: SavedGame & { startEval?: Score } = {
      version: 1,
      id: g.id,
      startFen: g.startFen,
      moves: s.plies.value.map((p) => p.uci),
      playerColor: g.playerColor,
      botId: g.bot.id,
      botElo: g.botElo,
      botName: g.bot.name,
      assisted: g.assisted,
      startedAt: g.startedAt,
      annotations,
    };
    if (s.startEval.value) saved.startEval = s.startEval.value;
    saveGame(saved, this.storage);
  }

  // -----------------------------------------------------------------------------------------------
  // Test / e2e support

  /**
   * Resolves once no boot, bot move, background annotation or review is pending. For tests and
   * e2e scripts (do not await it while a bot move is blocked on purpose).
   */
  async idle(): Promise<void> {
    const pending = () => [this.booting, this.botTask, this.annotating, this.reviewTask].filter((p) => p !== null);
    for (let i = 0; i < 100_000; i++) {
      const p = pending();
      if (p.length) {
        await Promise.allSettled(p);
        continue;
      }
      await new Promise((r) => setTimeout(r, 0));
      if (!pending().length) return;
    }
  }
}

/**
 * Wires `document.visibilitychange` to `controller.onVisibilityChange` (and applies the current
 * state once). Returns a function that removes the listener.
 */
export function bindPageLifecycle(controller: GameController, doc: Document = document): () => void {
  const onChange = () => controller.onVisibilityChange(doc.visibilityState === 'hidden');
  doc.addEventListener('visibilitychange', onChange);
  onChange();
  return () => doc.removeEventListener('visibilitychange', onChange);
}
