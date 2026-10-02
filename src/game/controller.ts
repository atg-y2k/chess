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
import { AnalysisService, defaultEnsureNodes, type AnalysisServiceOptions, type EnsureOptions } from '../engine/AnalysisService';
import { createEngines, type EngineLoadProgress, type EngineSet } from '../engine/createEngines';
import { EngineLoadError, engineFailureKind } from '../engine/errors';
import { inspectPosition } from '../engine/StockfishEngine';
import type { AnalysisResult, ChessEngine, Score } from '../engine/types';
import { engineSupported } from '../engine/workerTransport';
import {
  applyGameResult,
  loadProfile,
  playerScoreFor,
  saveProfile,
  setStartingRating as withStartingRating,
  updateGameRecord,
} from '../rating/rating';
import type { GameRecord } from '../rating/types';
import { answerFreeLines, mentionsMove, repetitionExplanation } from './coach';
import { getEntitlements, type Entitlements, type ProFeature } from './entitlements';
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
  type SavedResult,
} from './persistence';
import { buildPgn, type PgnPlayer } from './pgn';
import { emptyCounts, summarizeGame } from './review';
import { playSound, setSoundEnabled, soundForSan, type SoundKind } from './sound';
import {
  SHALLOW_DEPTH,
  annotationKey,
  createState,
  createStore,
  personaForSettings,
  uciArrow,
  whiteScore,
  type CoachActionId,
  type CoachMode,
  type GameInfo,
  type PendingAssist,
  type ReadonlyStore,
  type SheetName,
  type Store,
} from './store';
import type { Color, GameOutcome, GameSettings, Ply, PromotionPiece } from './types';

/** Depth of the per-ply annotations (and hints, Show best and the review), within ANNOTATE_NODES. */
export const ANNOTATE_DEPTH = 14;
/** MultiPV of the per-ply annotations. */
export const ANNOTATE_MULTIPV = 3;
/**
 * Node budget of those searches (1.2M: about 2.5 s on an iPhone). Most positions reach
 * ANNOTATE_DEPTH well within it; in the few where one iteration takes millions of nodes, the
 * search stops at the budget and its (shallower, finished) result is the verdict, so the coach
 * never waits minutes for one move.
 */
export const ANNOTATE_NODES = defaultEnsureNodes(ANNOTATE_MULTIPV);
/** The `ensure()` request of every annotation, hint, Show best and review search. */
const ANNOTATE: EnsureOptions = { minDepth: ANNOTATE_DEPTH, multiPv: ANNOTATE_MULTIPV, maxNodes: ANNOTATE_NODES };
/** Shown when the engine cannot start. */
export const ENGINE_START_FAILED = 'The chess engine could not start.';
/** Advice when the browser lacks Web Workers or WebAssembly SIMD. */
export const ENGINE_ADVICE = 'Your browser may not support WebAssembly SIMD (iOS 16.4+ required).';
/** Advice when the engine files could not be downloaded (the app retries once when back online). */
export const ENGINE_DOWNLOAD_ADVICE = 'Couldn’t download the chess engine. Check your connection and tap Try again.';
/** Advice for any other start failure (a timeout or a crash while loading). */
export const ENGINE_RETRY_ADVICE = 'Tap Try again. If it keeps happening, close and reopen the app.';
/** Shown when an engine stops working during a game (it crashed and could not be restarted). */
export const ENGINE_STOPPED = 'The chess engine stopped working.';
export const ENGINE_STOPPED_ADVICE = 'Tap Try again to restart it. Your game is saved.';

/** Sound output (default: game/sound.ts). */
export interface SoundPort {
  play(kind: SoundKind): void;
  setEnabled(on: boolean): void;
}

/** What the controller needs from a bot (BotPlayer implements it). */
export interface BotLike {
  newGame(elo: number): Promise<void>;
  /**
   * `history` = UCI moves from `startFen` (the game's start position; default the initial
   * position), so the bot can use its opening book and see repetitions.
   */
  move(fen: string, elo: number, history: string[], signal?: AbortSignal, startFen?: string): Promise<BotMove | null>;
}

/** What the controller passes to the engine factory. */
export interface CreateEnginesRequest {
  /** `.wasm` download progress of each engine (the boot splash shows the analysis engine's). */
  onProgress: (progress: EngineLoadProgress) => void;
}

/** Minimal event source for the `online` event (the window). */
export interface OnlineEvents {
  addEventListener(type: 'online', listener: () => void): void;
  removeEventListener(type: 'online', listener: () => void): void;
}

/** Injectable dependencies (all optional; tests replace the engine, storage, clock and randomness). */
export interface ControllerDeps {
  /**
   * Engine factory (default: `createEngines()` after a Web Worker / WebAssembly SIMD check). A
   * rejection should be an `EngineLoadError` when the cause is known (see engine/errors.ts).
   */
  createEngines?: (request: CreateEnginesRequest) => Promise<EngineSet>;
  /** Where the `online` event comes from, to retry a failed engine download (default: window; null = none). */
  onlineEvents?: OnlineEvents | null;
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
  /** Pro and the paywall (default: the app's, `getEntitlements()`). */
  entitlements?: Entitlements;
}

export interface NewGameOptions {
  /** Start from this position instead of the initial one (must be legal). */
  startFen?: string;
}

type AnnotateResult = 'done' | 'stale' | 'failed';

const isAnnotated = (p: Ply): boolean => !!(p.classification && p.explanation && p.evalWhite);
const uciOf = (m: Pick<Move, 'from' | 'to' | 'promotion'>): string => m.from + m.to + (m.promotion ?? '');
/** Explanation details that spell out a variation ("Main line: …"); "Show best" has its own. */
const LINE_DETAIL = /^(Main line|Key line|The finish):/;
const prevMoveOf = (p: Ply): PrevMove => ({ to: p.uci.slice(2, 4), ...(p.captured ? { captured: p.captured } : {}) });

async function defaultCreateEngines(request: CreateEnginesRequest): Promise<EngineSet> {
  if (!engineSupported()) throw new EngineLoadError('Web Workers or WebAssembly SIMD are not available.', 'unsupported');
  return createEngines({ onProgress: request.onProgress });
}

/** The error screen's advice for an engine that could not start. */
export function engineStartAdvice(e: unknown): string {
  switch (engineFailureKind(e)) {
    case 'unsupported':
      return ENGINE_ADVICE;
    case 'download':
      return ENGINE_DOWNLOAD_ADVICE;
    default:
      return ENGINE_RETRY_ADVICE;
  }
}

/**
 * Wraps an engine to notice when it breaks for good. `ChessEngine.search` (and init / newGame)
 * reject only when the engine is broken or terminated, or for an invalid FEN; BotPlayer and
 * AnalysisService swallow such failures (heuristic bot moves, empty analyses), so the controller
 * listens here instead.
 */
function monitorEngine(engine: ChessEngine, onFatal: (e: unknown) => void): ChessEngine {
  const watch = <T>(p: Promise<T>, fen?: string): Promise<T> =>
    p.catch((e: unknown) => {
      let badFen = false;
      if (fen !== undefined) {
        try {
          inspectPosition(fen);
        } catch {
          badFen = true;
        }
      }
      if (!badFen) onFatal(e);
      throw e;
    });
  return {
    init: () => watch(engine.init()),
    search: (fen, opts) => watch(engine.search(fen, opts), fen),
    stop: () => engine.stop(),
    newGame: () => watch(engine.newGame()),
    terminate: () => engine.terminate(),
  };
}

/** Whether ply `index` repeats a position for the third time (the game is then drawn). */
function isThirdRepetition(startFen: string, plies: readonly Ply[], index: number): boolean {
  const key = fenKey(plies[index].fenAfter);
  let seen = fenKey(startFen) === key ? 1 : 0;
  for (let i = 0; i <= index; i++) if (fenKey(plies[i].fenAfter) === key) seen++;
  return seen >= 3;
}

/**
 * The coach mode after a restore: the verdict on the human's last move, while it is still the
 * move being discussed (the last ply, or followed only by the bot's reply), as in live play.
 * (A saved "Try again" prompt after a Retry takes precedence, see `restore`.)
 */
function restoredCoachMode(plies: readonly Ply[], playerColor: Color): CoachMode {
  for (let i = plies.length - 1; i >= 0 && i >= plies.length - 2; i--) {
    if (plies[i].color === playerColor) return { kind: 'feedback', index: i };
  }
  return { kind: 'idle' };
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
  /**
   * Pro: which features are locked (the store's view models hide them) and the paywall, which the
   * gated actions (Hint, Show best, best-move arrows, the coach's "Unlock to see why") open.
   */
  readonly entitlements: Entitlements;

  private readonly s: Store;
  private readonly storage: KeyValueStorage | null | undefined;
  private readonly rng: () => number;
  private readonly sound: SoundPort;
  private readonly now: () => number;
  private readonly thinkDelay: boolean;
  private readonly makeEngines: (request: CreateEnginesRequest) => Promise<EngineSet>;
  private readonly onlineEvents: OnlineEvents | null;
  /** Removes the pending "retry when back online" listener, if any. */
  private offlineRetry: (() => void) | null = null;
  private readonly makeBotPlayer: NonNullable<ControllerDeps['createBot']>;
  private readonly createId: () => string;
  private readonly analysisOptions: AnalysisServiceOptions;

  private engines: EngineSet | null = null;
  /** The bot engine, monitored for failure (see monitorEngine). */
  private botEngine: ChessEngine | null = null;
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
  /** Completing a Show best whose engine lines were not cached (see `showBest`). */
  private showBestTask: Promise<void> | null = null;
  private booting: Promise<void> | null = null;
  private hidden = false;
  private openingsReady: Promise<void> = Promise.resolve();
  /** Stops following `entitlements.locked`. */
  private unwatchLocks: () => void;

  constructor(deps: ControllerDeps = {}) {
    this.storage = deps.storage;
    this.rng = deps.rng ?? Math.random;
    this.sound = deps.sound ?? { play: playSound, setEnabled: setSoundEnabled };
    this.now = deps.now ?? Date.now;
    this.thinkDelay = deps.thinkDelay ?? true;
    this.makeEngines = deps.createEngines ?? defaultCreateEngines;
    this.onlineEvents =
      deps.onlineEvents !== undefined ? deps.onlineEvents : typeof window === 'undefined' ? null : (window as OnlineEvents);
    this.makeBotPlayer = deps.createBot ?? ((engine, opts) => new BotPlayer(engine, opts));
    this.createId = deps.createId ?? createGameId;
    this.analysisOptions = deps.analysisOptions ?? {};
    this.entitlements = deps.entitlements ?? getEntitlements();
    this.s = createStore(
      createState({
        settings: loadSettings(this.storage),
        profile: loadProfile(this.storage),
        locked: this.entitlements.locked,
      }),
    );
    this.store = this.s;
    this.unwatchLocks = this.entitlements.locked.subscribe((locked) => this.onLocksChanged(locked));
  }

  /**
   * Pro features became locked (at start, or after a refund) or unlocked. A hint or Show best
   * that is now locked is closed, and best-move arrows are switched off while they are locked, so
   * buying Pro later does not switch them on in the middle of a rated game.
   */
  private onLocksChanged(locked: ReadonlySet<ProFeature>): void {
    const s = this.s;
    if (locked.has('bestMoveArrows') && s.settings.value.showBestMoves) {
      const next = { ...s.settings.value, showBestMoves: false };
      s.settings.value = next;
      saveSettings(next, this.storage);
    }
    const m = s.coachMode.value;
    if (m.kind === 'hint' && locked.has('hint')) this.dismissHint();
    else if (m.kind === 'showBest' && locked.has('showBest')) this.backFromShowBest();
    this.updateWatch();
  }

  // -----------------------------------------------------------------------------------------------
  // Boot

  /**
   * Loads settings and profile, starts the engines (then the opening book, which only a game
   * needs), then restores a saved game (the bot moves if it is its turn) or enters 'setup' with
   * the new-game sheet open.
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
    this.cancelOnlineRetry();
    this.unwatchLocks();
    this.teardown();
  }

  private async doBoot(): Promise<void> {
    const s = this.s;
    this.cancelOnlineRetry();
    batch(() => {
      s.phase.value = 'boot';
      s.error.value = null;
      s.engineDownload.value = null;
      s.settings.value = loadSettings(this.storage);
      s.profile.value = loadProfile(this.storage);
    });
    // Sound starts enabled; turning it on (which unlocks Web Audio) waits for a tap: newGame() / setSettings().
    if (!s.settings.value.sound) this.sound.setEnabled(false);
    let engines: EngineSet;
    const onProgress = (p: EngineLoadProgress) => {
      if (p.engine !== 'analysis' || s.phase.value !== 'boot' || !(p.total > 0)) return;
      s.engineDownload.value = Math.max(0, Math.min(1, p.loaded / p.total));
    };
    try {
      engines = await this.makeEngines({ onProgress });
    } catch (e) {
      console.error('[game] engine start failed', e);
      batch(() => {
        s.error.value = {
          message: ENGINE_START_FAILED,
          advice: engineStartAdvice(e),
          detail: e instanceof Error ? e.message : String(e),
        };
        s.engineDownload.value = null;
        s.phase.value = 'error';
      });
      if (engineFailureKind(e) === 'download') this.retryWhenOnline();
      return;
    }
    s.engineDownload.value = null;
    // The opening book (~0.9 MB) is only needed once a game starts (the bot and the annotations
    // wait for it), so on a slow first visit it does not share the connection with the engine.
    this.openingsReady = loadOpenings().then(
      () => this.refreshOpenings(),
      (e: unknown) => console.warn('[game] opening book unavailable', e),
    );
    this.engines = engines;
    const fatal = (which: 'analysis' | 'bot') => (e: unknown) => this.onEngineFailure(engines, which, e);
    this.botEngine = monitorEngine(engines.bot, fatal('bot'));
    this.analysis = new AnalysisService(monitorEngine(engines.analysis, fatal('analysis')), this.analysisOptions);
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

  /** After a failed engine download: boot again (once) when the device comes back online. */
  private retryWhenOnline(): void {
    const target = this.onlineEvents;
    if (!target) return;
    this.cancelOnlineRetry();
    const error = this.s.error.value;
    const onOnline = () => {
      this.cancelOnlineRetry();
      if (this.s.phase.value === 'error' && this.s.error.value === error) void this.retry();
    };
    target.addEventListener('online', onOnline);
    this.offlineRetry = () => target.removeEventListener('online', onOnline);
  }

  private cancelOnlineRetry(): void {
    this.offlineRetry?.();
    this.offlineRetry = null;
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
    this.botEngine = null;
    this.analysis = null;
  }

  /**
   * An engine broke for good mid-session (it kept crashing): no more analysis, and the bot would
   * only play heuristic moves in a rated game. Saves the game and shows the error screen, whose
   * "Try again" (`retry()`) starts fresh engines and restores the game.
   */
  private onEngineFailure(engines: EngineSet, which: 'analysis' | 'bot', e: unknown): void {
    const s = this.s;
    if (this.engines !== engines || s.phase.value === 'error' || s.phase.value === 'boot') return;
    console.error(`[game] the ${which} engine stopped working`, e);
    this.save();
    this.abortBot();
    this.epoch++;
    batch(() => {
      s.error.value = {
        message: ENGINE_STOPPED,
        advice: ENGINE_STOPPED_ADVICE,
        detail: e instanceof Error ? e.message : String(e),
      };
      s.sheet.value = null;
      s.pendingAssist.value = null;
      s.phase.value = 'error';
    });
  }

  /**
   * Rebuilds a saved game (plies + annotations) and continues it, or shows it finished (game-over
   * state, ready for review) when it had ended.
   */
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
    const over = saved.over ?? null;
    this.chess = chess;
    this.epoch++;
    this.clearFailed();
    this.bot = this.makeBot(game.id);
    this.botReady = this.bot.newGame(game.botElo).catch((e: unknown) => console.warn('[game] bot newGame failed', e));
    this.analysis?.watch(null);
    batch(() => {
      s.game.value = game;
      s.plies.value = plies;
      s.startEval.value = isScore(startEval) ? startEval : null;
      s.viewIndex.value = null;
      s.flipped.value = false;
      s.outcome.value = over?.outcome ?? null;
      s.ratingChange.value = over?.ratingChange ?? null;
      s.reviewState.value = null;
      s.coachMode.value = over
        ? { kind: 'idle' }
        : saved.retry && chess.turn() === game.playerColor
          ? { kind: 'retry', ...saved.retry }
          : restoredCoachMode(plies, game.playerColor);
      s.coachCollapsed.value = null;
      s.live.value = null;
      s.botThinking.value = false;
      s.sheet.value = null;
      s.pendingAssist.value = null;
      s.phase.value = over ? 'over' : 'playing';
    });
    this.updateWatch();
    this.kickAnnotations();
    if (over) this.ensureRecorded(game, over);
    else if (!this.checkGameEnd()) this.requestBotMove();
  }

  /** A restored finished game whose result is missing from the history (e.g. the profile failed to save) is recorded now. */
  private ensureRecorded(g: GameInfo, over: SavedResult): void {
    const s = this.s;
    if (s.profile.value.history.some((r) => r.id === g.id)) return;
    const record = this.recordResult(g, over.outcome, over.ratingChange.rated);
    s.ratingChange.value = { before: record.ratingBefore, after: record.ratingAfter, rated: record.rated };
    this.save();
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
    if (next.showBestMoves && !this.entitlements.isAllowed('bestMoveArrows')) next.showBestMoves = false;
    this.s.settings.value = next;
    saveSettings(next, this.storage);
    this.sound.setEnabled(next.sound);
    this.startGame(next, opts.startFen);
  }

  /**
   * Same opponent and colour (adaptive games re-match the new rating). The other options, such as
   * best-move arrows (which decide whether the game is rated), are the current settings.
   */
  rematch(): void {
    const s = this.s;
    const g = s.game.value;
    if (!g) {
      this.openSheet('new');
      return;
    }
    this.startGame(
      {
        ...s.settings.value,
        botId: g.settings.botId,
        botElo: g.settings.botElo,
        adaptive: g.settings.adaptive,
        playerColor: g.playerColor,
      },
      g.startFen,
    );
  }

  /**
   * Sets the player's rating to a starting level (see STARTING_LEVELS in rating/rating.ts) and
   * saves the profile: the New Game sheet's "Your level" for a brand-new player, and the Menu's
   * "Set my level". The rating becomes provisional again; "Match my rating" follows it.
   */
  setStartingRating(rating: number): void {
    if (!Number.isFinite(rating)) return;
    const s = this.s;
    const profile = withStartingRating(s.profile.value, rating);
    saveProfile(profile, this.storage);
    s.profile.value = profile;
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
    // The opponent the New Game sheet showed: an adaptive ("Match my rating") Elo comes from the
    // rating before the loss that abandoning the current game records below.
    const bot = personaForSettings(settings, s.profile.value);
    this.abandonCurrent();
    this.abortBot();
    this.analysis.cancelAll();
    // Forget the live target: a new game on the position already watched (a new game or rematch
    // before the first move) must emit its analysis again, or the eval bar and arrows stay blank.
    this.analysis.watch(null);
    this.epoch++;
    this.clearFailed();
    const playerColor: Color =
      settings.playerColor === 'random' ? (this.rng() < 0.5 ? 'w' : 'b') : settings.playerColor;
    const id = this.createId();
    const game: GameInfo = {
      id,
      startFen,
      playerColor,
      bot,
      botElo: bot.elo,
      startedAt: new Date(this.now()).toISOString(),
      assisted: settings.showBestMoves && this.entitlements.isAllowed('bestMoveArrows'),
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
      s.pendingAssist.value = null;
      s.phase.value = 'playing';
    });
    this.sound.play('gameStart');
    this.updateWatch();
    this.save();
    if (!this.checkGameEnd()) this.requestBotMove();
  }

  /**
   * A game in progress that is replaced by a new one counts as a loss by abandonment (rated unless
   * assisted) once the human has moved; before that it is simply discarded (an abort).
   */
  private abandonCurrent(): void {
    const s = this.s;
    const g = s.game.value;
    if (!g || s.phase.value !== 'playing' || s.outcome.value) return;
    if (!s.plies.value.some((p) => p.color === g.playerColor)) return;
    const winner = otherColor(g.playerColor);
    this.recordResult(g, { result: winner === 'w' ? '1-0' : '0-1', winner, reason: 'Abandoned' }, !g.assisted);
  }

  private makeBot(gameId: string): BotLike {
    return this.makeBotPlayer(this.botEngine ?? this.engines!.bot, {
      rng: mulberry32(hashSeed(gameId)),
      thinkDelay: this.thinkDelay,
    });
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

  /**
   * Asks the bot for a move when it is its turn (no-op otherwise, while the page is hidden, or
   * while a takeback waits for confirmation).
   */
  private requestBotMove(): void {
    const s = this.s;
    const g = s.game.value;
    if (!g || !this.bot || s.phase.value !== 'playing' || s.outcome.value || this.hidden || this.botCtl) return;
    if (this.chess.turn() === g.playerColor || this.chess.isGameOver()) return;
    // A takeback waiting for confirmation: the reply waits for the answer (see requestAssist).
    if (s.pendingAssist.value) return;
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
        const move = await bot.move(fen, g.botElo, history, ctl.signal, g.startFen);
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

  /**
   * Ends the game: rating (rated unless assisted, or `rated: false`), history record with PGN,
   * game-over sheet. The finished game stays saved (with its result) until the next one starts,
   * so an iOS restart brings back its game-over state and review.
   */
  private finish(outcome: GameOutcome, opts: { rated?: boolean } = {}): void {
    const s = this.s;
    const g = s.game.value!;
    this.abortBot();
    this.epoch++;
    const record = this.recordResult(g, outcome, (opts.rated ?? true) && !g.assisted);
    batch(() => {
      s.outcome.value = outcome;
      s.ratingChange.value = { before: record.ratingBefore, after: record.ratingAfter, rated: record.rated };
      s.phase.value = 'over';
      s.sheet.value = 'gameOver';
      s.viewIndex.value = null;
      s.coachMode.value = { kind: 'idle' };
      s.pendingAssist.value = null;
    });
    this.save();
    this.sound.play('gameEnd');
    this.updateWatch();
  }

  /** Adds the game's result to the profile (rating + history, once per game id) and saves it. */
  private recordResult(g: GameInfo, outcome: GameOutcome, rated: boolean): GameRecord {
    const s = this.s;
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
      pgn: this.pgnText(outcome, false),
    });
    if (profile !== s.profile.value) {
      saveProfile(profile, this.storage);
      s.profile.value = profile;
    }
    return record;
  }

  /**
   * Takes back the human's last move (and the bot's reply, if any), aborting a pending bot move.
   * Only while playing, with takebacks allowed and a human move to take back. Marks the game
   * assisted (unrated). Returns whether anything was undone. (The toolbar calls `requestUndo()`.)
   */
  undo(): boolean {
    const target = this.undoTarget();
    if (target === null) return false;
    const s = this.s;
    this.truncate(target);
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

  /** Number of plies to keep for an undo, or null when there is nothing to take back. */
  private undoTarget(): number | null {
    const s = this.s;
    const g = s.game.value;
    if (!g || s.phase.value !== 'playing' || s.outcome.value || !s.settings.value.allowTakebacks) return null;
    const ps = s.plies.value;
    let target = ps.length;
    while (target > 0 && ps[target - 1].color !== g.playerColor) target--;
    return target === 0 ? null : target - 1;
  }

  private canRetry(index: number): boolean {
    const s = this.s;
    const g = s.game.value;
    const ply = s.plies.value[index];
    return (
      !!g &&
      !!ply &&
      ply.color === g.playerColor &&
      s.phase.value === 'playing' &&
      !s.outcome.value &&
      s.settings.value.allowTakebacks
    );
  }

  /** "Retry" after a mistake: back to the position before human ply `index` (assisted). */
  private retryMove(index: number): void {
    const s = this.s;
    const ply = s.plies.value[index];
    if (!this.canRetry(index)) return;
    this.truncate(index);
    this.markAssisted();
    const cl = ply.classification;
    batch(() => {
      s.viewIndex.value = null;
      s.coachMode.value = {
        kind: 'retry',
        san: ply.san,
        cls: cl?.cls ?? 'mistake',
        // Only what does not give the better move away.
        headline: cl ? (answerFreeLines(ply.explanation, cl)[0] ?? null) : (ply.explanation?.headline ?? null),
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

  /**
   * Resigns the game in progress: a loss, rated unless assisted. Before the human's first move it
   * is unrated (like abandoning a game before moving, which is not counted at all).
   */
  resign(): void {
    const s = this.s;
    const g = s.game.value;
    if (!g || s.phase.value !== 'playing' || s.outcome.value) return;
    const winner = otherColor(g.playerColor);
    const moved = s.plies.value.some((p) => p.color === g.playerColor);
    this.finish({ result: winner === 'w' ? '1-0' : '0-1', winner, reason: 'Resignation' }, { rated: moved });
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
   * Hint on the human's turn: analyses the position (depth 14, MultiPV 3, within ANNOTATE_NODES)
   * and shows why the best move is good, with its arrow. Marks the game assisted once the hint is
   * shown (not when none could be found). Calling it while a hint is shown dismisses the hint.
   * (The toolbar calls `requestHint()`.)
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
    if (!svc || !g || !this.canHint() || !this.entitlements.isAllowed('hint')) return;
    const fen = s.liveFen.value;
    const epoch = this.epoch;
    s.coachMode.value = { kind: 'hint', fen, explanation: null, prev: m };
    this.updateWatch();
    let r: AnalysisResult;
    try {
      r = await svc.ensure(fen, ANNOTATE);
    } catch {
      r = { fen, depth: 0, lines: [], bestMove: null, done: false, aborted: true };
    }
    const now = s.coachMode.value;
    if (this.epoch !== epoch || s.game.value?.id !== g.id || now.kind !== 'hint' || now.fen !== fen) return;
    const line = r.lines[0];
    const prev = s.plies.value.at(-1);
    let explanation: Explanation;
    if (line) {
      const e = explainBestMove(fen, line, {
        prevMove: prev ? prevMoveOf(prev) : undefined,
        perspective: 'you',
        lines: r.lines,
      });
      explanation = { ...e, arrows: e.arrows?.length ? e.arrows : uciArrow(line.pv[0], 'best') };
      this.markAssisted();
    } else {
      explanation = { headline: 'No hint is available for this position.', details: [] };
    }
    s.coachMode.value = { ...now, explanation };
  }

  private canHint(): boolean {
    const s = this.s;
    return !!s.game.value && s.humanToMove.value && s.isLive.value && s.coachMode.value.kind !== 'showBest';
  }

  /**
   * Toolbar Hint: dismisses a shown hint, else asks first in a rated game (see `requestAssist`).
   * While hints are locked (Pro) it opens the paywall instead.
   */
  requestHint(): void {
    if (this.s.coachMode.value.kind === 'hint') this.dismissHint();
    else if (this.canHint() && this.entitlements.requirePro('hint')) this.requestAssist({ kind: 'hint' });
  }

  /** Toolbar Undo (asks first in a rated game, see `requestAssist`). */
  requestUndo(): void {
    if (this.undoTarget() !== null) this.requestAssist({ kind: 'undo' });
  }

  /**
   * A hint, takeback or Retry makes a rated game unrated, so the first one in a rated game opens
   * the 'assist' sheet to confirm (`confirmAssist()` runs it, `closeSheet()` cancels). In an
   * unrated game it runs at once. While a takeback (Undo, Retry) waits for the answer, the bot's
   * reply is put on hold, as an unrated takeback cancels it at once: otherwise a reply that ends
   * the game would drop the takeback and record the rated loss the player was taking back.
   */
  private requestAssist(a: PendingAssist): void {
    const s = this.s;
    if (s.game.value?.assisted === false) {
      if (a.kind !== 'hint') this.abortBot();
      batch(() => {
        s.pendingAssist.value = a;
        s.sheet.value = 'assist';
      });
      return;
    }
    this.runAssist(a);
  }

  /** Runs the help waiting in the 'assist' sheet. */
  confirmAssist(): void {
    const s = this.s;
    const a = s.pendingAssist.value;
    batch(() => {
      s.pendingAssist.value = null;
      if (s.sheet.value === 'assist') s.sheet.value = null;
    });
    if (a) this.runAssist(a);
    this.requestBotMove(); // the held reply, when nothing was taken back after all
  }

  private runAssist(a: PendingAssist): void {
    if (a.kind === 'undo') this.undo();
    else if (a.kind === 'hint') void this.hint();
    else if (a.index !== undefined) this.retryMove(a.index);
  }

  /** Hides the hint (back to what the coach showed before). */
  dismissHint(): void {
    const m = this.s.coachMode.value;
    if (m.kind === 'hint') this.s.coachMode.value = m.prev;
    this.updateWatch();
  }

  /**
   * Runs a coach-panel action by id (the ids in `store.coach.value.actions`). A locked Pro action
   * (Show best) opens the paywall instead; 'unlock' opens it for the panel's locked feature.
   */
  runAction(id: CoachActionId): void {
    const s = this.s;
    const m = s.coachMode.value;
    switch (id) {
      case 'unlock':
        this.entitlements.openPaywall(s.coach.value.actions.find((a) => a.id === 'unlock')?.feature ?? null);
        return;
      case 'showBest': {
        if (!this.entitlements.requirePro('showBest')) return;
        const index = s.phase.value === 'playing' && s.isLive.value && m.kind === 'feedback' ? m.index : s.current.value - 1;
        if (index >= 0) this.showBest(index);
        return;
      }
      case 'retry': {
        const index = m.kind === 'feedback' || m.kind === 'showBest' ? m.index : -1;
        if (index >= 0 && this.canRetry(index)) this.requestAssist({ kind: 'retry', index });
        return;
      }
      case 'retryAnalysis':
        this.clearFailed();
        if (s.phase.value === 'review') void this.startReview();
        else this.kickAnnotations();
        return;
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

  /**
   * Shows the position before ply `index` with the best move and the played move as arrows, and
   * explains the best move from the engine lines of that position. When they are not at hand
   * (the analysis cache lives in memory only: after a relaunch, or in the review of a restored
   * game) the panel first shows what the saved explanation says, busy, and fills in the
   * explanation and the best line once the position has been analysed again.
   */
  private showBest(index: number): void {
    const s = this.s;
    const g = s.game.value;
    const ply = s.plies.value[index];
    if (!g || !ply?.classification) return;
    const svc = this.analysis;
    const text = this.showBestText(g, ply, svc?.get(ply.fenBefore));
    const pending = !text.explained && !!svc;
    batch(() => {
      s.coachMode.value = {
        kind: 'showBest',
        index,
        bestUci: text.bestUci,
        bestSan: text.bestSan,
        lines: text.lines,
        returnTo: s.viewIndex.value,
        prev: s.coachMode.value,
        ...(pending ? { pending: true } : {}),
      };
      s.viewIndex.value = index;
    });
    this.updateWatch();
    if (pending) this.trackShowBest(this.fillShowBest(svc, g.id, ply));
  }

  /** Analyses the position before `ply` and completes the Show best text (see `showBest`). */
  private async fillShowBest(svc: AnalysisService, gameId: string, ply: Ply): Promise<void> {
    const s = this.s;
    let r: AnalysisResult | undefined;
    try {
      r = await svc.ensure(ply.fenBefore, ANNOTATE);
    } catch (e) {
      console.warn('[game] show best: analysis failed', e);
    }
    const m = s.coachMode.value;
    const g = s.game.value;
    const now = s.plies.value[ply.index];
    if (
      this.analysis !== svc ||
      !g ||
      g.id !== gameId ||
      m.kind !== 'showBest' ||
      m.index !== ply.index ||
      !m.pending ||
      now?.fenBefore !== ply.fenBefore ||
      now.uci !== ply.uci
    ) {
      return;
    }
    const text = r ? this.showBestText(g, now, r) : null;
    const { pending: _done, ...rest } = m;
    s.coachMode.value = text?.explained
      ? { ...rest, bestUci: text.bestUci, bestSan: text.bestSan, lines: text.lines }
      : rest; // no line for the best move (an aborted or different search): keep the saved text
  }

  private trackShowBest(task: Promise<void>): void {
    const t: Promise<void> = task
      .catch((e: unknown) => console.error('[game] show best failed', e))
      .finally(() => {
        if (this.showBestTask === t) this.showBestTask = null;
      });
    this.showBestTask = t;
  }

  /**
   * The Show best text for `ply`: the best move explained from the engine lines `before` (of the
   * position before the ply), what was played, and the best line. `explained` is false when
   * `before` has no line for the best move: the text is then built from the saved explanation.
   */
  private showBestText(
    g: GameInfo,
    ply: Ply,
    before: AnalysisResult | undefined,
  ): { bestUci: string | null; bestSan: string | null; lines: string[]; explained: boolean } {
    const s = this.s;
    const cl = ply.classification!;
    const bestUci = cl.bestMoveUci ?? before?.lines[0]?.pv[0] ?? null;
    const bestSan = cl.bestMoveSan ?? (bestUci ? uciToSan(ply.fenBefore, bestUci) : null);
    const line = before?.lines.find((l) => l.pv[0] === bestUci) ?? null;
    const human = ply.color === g.playerColor;
    const prev = ply.index > 0 ? s.plies.value[ply.index - 1] : undefined;
    const saved = ply.explanation;
    const played = human ? `You played ${ply.san}.` : `${g.bot.name} played ${ply.san}.`;
    const why = saved?.headline;
    const lines: string[] = [];
    if (line) {
      const e = explainBestMove(ply.fenBefore, line, {
        prevMove: prev ? prevMoveOf(prev) : undefined,
        perspective: human ? 'you' : 'neutral',
        // All engine lines, as the hint and the feedback on a best move use them (same wording).
        lines: before?.lines,
      });
      // What was wrong with the played move, unless it only restates the best move, which the
      // lines above already explain: "Best was X …", "You missed X, which wins a rook.", "You
      // missed a forced mate in 2." (A missed chance that does not name the move still says what
      // kind of chance it was.)
      const restatesBest =
        !!why &&
        (why.startsWith('Best was') ||
          (!!bestSan && mentionsMove(why, bestSan)) ||
          (saved?.motifs?.includes('missedMate') ?? false));
      const playedLine = why && !restatesBest ? `${played} ${why}` : played;
      const san = pvToSan(ply.fenBefore, line.pv, 8);
      const bestLine = san.length > 1 ? `Best line: ${formatLine(ply.fenBefore, san)}` : null;
      // The "Best line" below already shows the variation: skip the explanation's own copy.
      const details = bestLine ? e.details.filter((d) => !LINE_DETAIL.test(d)) : e.details;
      lines.push(e.headline, ...details.slice(0, 2), playedLine);
      if (bestLine) lines.push(bestLine);
      return { bestUci, bestSan, lines, explained: true };
    }
    // No engine lines: what the saved explanation says. Its "Best was X, which …" becomes the
    // reason for X ("X wins a rook."), as the engine explanation would put it first.
    const reason = saved?.details
      .map((d) => /^Best was (\S+?), which (.+)$/.exec(d))
      .find((mm) => mm && (!bestSan || mm[1] === bestSan));
    if (reason) lines.push(`${reason[1]} ${reason[2]}`);
    lines.push(why && !why.startsWith('Best was') ? `${played} ${why}` : played);
    const bestLineSan = saved?.bestLineSan ?? [];
    const bestLine =
      bestLineSan.length > 1 && (!bestSan || bestLineSan[0] === bestSan)
        ? `Best line: ${formatLine(ply.fenBefore, bestLineSan)}`
        : null;
    const details = (saved?.details ?? []).filter((d) => !d.startsWith('Best was') && !(bestLine && LINE_DETAIL.test(d)));
    lines.push(...details.slice(0, 2));
    if (bestLine) lines.push(bestLine);
    return { bestUci, bestSan, lines, explained: false };
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
   * game marks it assisted (while they are locked, Pro, it opens the paywall instead).
   */
  setSettings(partial: Partial<GameSettings>): void {
    const s = this.s;
    const prev = s.settings.value;
    if (partial.showBestMoves && !prev.showBestMoves && !this.entitlements.requirePro('bestMoveArrows')) {
      const { showBestMoves: _locked, ...rest } = partial;
      if (!Object.keys(rest).length) return;
      partial = rest;
    }
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
    batch(() => {
      if (name !== 'assist') this.s.pendingAssist.value = null;
      this.s.sheet.value = name;
    });
    this.requestBotMove(); // a cancelled takeback releases the bot's reply
  }

  /** Closes the open sheet (cancelling a pending assist, which lets a held bot reply go ahead). */
  closeSheet(): void {
    batch(() => {
      this.s.pendingAssist.value = null;
      this.s.sheet.value = null;
    });
    this.requestBotMove();
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
   * Game Review (after the game): analyses every position (depth 14, MultiPV 3, within
   * ANNOTATE_NODES, reusing the cache), classifies and explains any ply still missing, then fills
   * `store.review` with accuracy, counts and key moments and stores the player's accuracy in the
   * game record. Resolves when the review is complete (or abandoned).
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
    this.clearFailed();
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
        const r = await svc.ensure(g.startFen, ANNOTATE);
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
      this.clearFailed(); // one more try for plies whose analysis failed
    }
    if (!alive()) return;
    const summary = summarizeGame(g.startFen, s.startEval.value, s.plies.value);
    s.reviewState.value = { ...summary, progress: null };
    this.save(); // the review's annotations survive a restart
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
      const failed = this.s.failedAnnotations.value;
      const ply = this.s.plies.value.find((p) => !isAnnotated(p) && !failed.has(annotationKey(g.id, p)));
      if (!ply) return;
      const res = await this.annotate(g.id, ply);
      if (res === 'failed') this.markFailed(annotationKey(g.id, ply));
    }
  }

  /** Plies whose analysis failed are skipped by the background queue (the review retries them once). */
  private markFailed(key: string): void {
    const next = new Set(this.s.failedAnnotations.value);
    next.add(key);
    this.s.failedAnnotations.value = next;
  }

  private clearFailed(): void {
    if (this.s.failedAnnotations.value.size) this.s.failedAnnotations.value = new Set();
  }

  /**
   * Analyses the positions before and after `ply` (depth 14, MultiPV 3, within ANNOTATE_NODES),
   * then classifies and explains it. The previous ply is annotated first (queue order), so its
   * winLoss is known.
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
    let before: AnalysisResult;
    let after: AnalysisResult;
    try {
      before = await svc.ensure(ply.fenBefore, ANNOTATE);
      if (!current()) return 'stale';
      after = await svc.ensure(ply.fenAfter, ANNOTATE);
    } catch (e) {
      console.warn('[game] analysis failed', e);
      return current() ? 'failed' : 'stale';
    }
    if (!current()) return 'stale';
    // A search cut short (pre-empted, cancelled, or the engine restarted) below the annotation
    // depth is not a verdict: retry later. A terminal position legitimately has depth 0, and a
    // search that finished at its node budget (done, not aborted) is one, however deep it got.
    const shallow = (r: AnalysisResult) => r.aborted === true && !r.terminal && r.depth < ANNOTATE_DEPTH;
    if (shallow(before) || shallow(after)) return 'failed';
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
    // The engine sees positions, not the game: a third repetition ends the game in a draw, which
    // it cannot know. Classify the move against that result (a terminal draw for classifyMove).
    const repetition = isThirdRepetition(g.startFen, plies, index);
    const classification = classifyMove({
      fenBefore: ply.fenBefore,
      moveUci: ply.uci,
      before,
      after: repetition ? { ...after, terminal: 'stalemate' } : after,
      opponentPrevWinLoss: prev?.classification?.winLoss,
      isBook,
      playerRating: human ? s.profile.value.rating : g.botElo,
      prevMove: prevMove ? { to: prevMove.to } : undefined,
      prevFenBefore: prev?.fenBefore,
    });
    const explanation = repetition
      ? repetitionExplanation(ply.san, classification, { human, botName: g.bot.name })
      : explainMove({
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
      evalWhite: repetition ? { kind: 'cp', value: 0 } : toWhitePov(afterScore, ply.fenAfter),
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
    const arrows = st.showBestMoves && this.entitlements.isAllowed('bestMoveArrows');
    if (p === 'over' || p === 'review') fen = s.displayedFen.value;
    else if (p === 'playing' && (st.showEvalBar || st.coach || arrows || s.coachMode.value.kind === 'hint')) {
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
   * Whether a service-worker update may reload the page now (the update gate in pwa.ts also waits
   * until the page is hidden or untouched). Yes before a game (setup) and on the engine error
   * screen. Yes on a finished game: it is saved with its result and restored as it was (phase
   * 'over', same result, rating and history), unless a sheet is open over it, such as the
   * game-over sheet the player may be reading: then only while the app is in the background
   * (`hidden`). Never while playing or reviewing, which a reload would interrupt, nor while the
   * paywall is open or a purchase is on its way. When it stays no, the new service worker is
   * active anyway and the next launch runs the new version.
   */
  canReloadNow(opts: { hidden?: boolean } = {}): boolean {
    const s = this.s;
    const p = s.phase.value;
    const pro = this.entitlements;
    if (pro.paywall.value.open || pro.status.value === 'buying' || pro.status.value === 'restoring') return false;
    if (p === 'setup' || p === 'error') return true;
    if (p === 'over') return s.sheet.value === null || opts.hidden === true;
    return false;
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

  /** Saves the game in progress, or the finished game with its result (phase over / review). */
  private save(): void {
    const s = this.s;
    const g = s.game.value;
    const phase = s.phase.value;
    const o = s.outcome.value;
    const playing = phase === 'playing' && !o;
    const finished = (phase === 'over' || phase === 'review') && !!o;
    if (!g || (!playing && !finished)) return;
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
    // The "Try again" prompt after a Retry (also under a hint asked for meanwhile): the retried
    // move is gone from `moves`, so a restore could not rebuild it.
    const m0 = s.coachMode.value;
    const m = m0.kind === 'hint' ? m0.prev : m0;
    if (playing && m.kind === 'retry') saved.retry = { san: m.san, cls: m.cls, headline: m.headline };
    if (finished && o) {
      const rc = s.ratingChange.value;
      const rating = s.profile.value.rating;
      saved.over = { outcome: o, ratingChange: rc ?? { before: rating, after: rating, rated: false } };
    }
    saveGame(saved, this.storage);
  }

  // -----------------------------------------------------------------------------------------------
  // Test / e2e support

  /**
   * Resolves once no boot, bot move, background annotation, review or Show best analysis is
   * pending. For tests and e2e scripts (do not await it while a bot move is blocked on purpose).
   */
  async idle(): Promise<void> {
    const pending = () =>
      [this.booting, this.botTask, this.annotating, this.reviewTask, this.showBestTask].filter((p) => p !== null);
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
