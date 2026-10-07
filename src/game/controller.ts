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
import type { Classification, Explanation } from '../analysis/types';
import { resultScore } from '../analysis/winprob';
import { BotPlayer } from '../bot/BotPlayer';
import { currentOpening, isBookMove, loadOpenings, openingsLoaded } from '../bot/book';
import { customPersona, personaById } from '../bot/personas';
import { hashSeed, mulberry32 } from '../bot/strength';
import type { BotMove } from '../bot/types';
import { START_FEN, fenKey, formatLine, isThirdRepetition, otherColor, parseUci, pvToSan, toWhitePov, uciToSan } from '../chess/utils';
import { AnalysisService, defaultEnsureNodes, type AnalysisServiceOptions, type EnsureOptions } from '../engine/AnalysisService';
import { createEngines, type EngineLoadProgress, type EngineSet } from '../engine/createEngines';
import { EngineLoadError, engineFailureKind } from '../engine/errors';
import { inspectPosition } from '../engine/StockfishEngine';
import type { AnalysisResult, ChessEngine, Score } from '../engine/types';
import { engineSupported } from '../engine/workerTransport';
import { catalogLoaded, getLine } from '../openings/catalog';
import { openingsOpen, openOpenings } from '../openings/session';
import { loadExplorer } from '../openings/tree';
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
  back as explorerBackOf,
  clearFailed as clearFailedRatings,
  currentMove,
  explorerFen,
  forward as explorerForwardOf,
  goTo as explorerGoToOf,
  movePath,
  playMove,
  reset as explorerResetOf,
  setRating,
  startExplorer,
  type Explorer,
  type ExplorerBase,
} from './explorer';
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
import { lineProgress, studyOpeningLine, type OpeningTarget } from './opening';
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
  type CoachSubject,
  type ExplorerActionId,
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
  /**
   * Plays `uci` (an opening line's next move, see `NewGameOptions.opening`) like a book move, with
   * its think time; null if aborted. Optional: without it the controller plays the move at once.
   */
  lineMove?(fen: string, elo: number, uci: string, history: string[], signal?: AbortSignal, startFen?: string): Promise<BotMove | null>;
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

/**
 * Play an opening (see `NewGameOptions.opening`): a game against the bot that follows a named
 * line from the openings catalog (src/openings/catalog.ts).
 */
export interface OpeningGameOptions {
  /**
   * The line: a catalog id (`OpeningLine.id`), or the id of a line given by `moves`. An unknown
   * catalog id without `moves` starts a normal game (with a warning).
   */
  lineId: string;
  /**
   * 'steer': start from the initial position; while the game is on the line, the bot plays the
   * line's next move. 'skip': start with the line's moves already played (as book plies); a line
   * that ends the game (a mate line) stops before that, on the human's turn.
   */
  mode: 'steer' | 'skip';
  /** Steer only: show the line's next move (a light arrow + a coach line) on the human's turn. */
  showLineMoves?: boolean;
  /**
   * The line's own moves, for a line that is not in the catalog (an opening guide's annotated main
   * line, "guide:London System"): UCI from the initial position, all legal (else a normal game
   * starts, with a warning). The game follows exactly these and saves them. Ignored when `lineId`
   * is a catalog id.
   */
  moves?: readonly string[];
  /** With `moves`: the opening's name as the game shows it ("London System"; default: `family`). */
  name?: string;
  /** With `moves`: its family. */
  family?: string;
}

export interface NewGameOptions {
  /** Start from this position instead of the initial one (must be legal). */
  startFen?: string;
  /** Practice an opening (ignores `startFen`); the game is unrated. */
  opening?: OpeningGameOptions;
}

type AnnotateResult = 'done' | 'stale' | 'failed';

const isAnnotated = (p: Ply): boolean => !!(p.classification && p.explanation && p.evalWhite);
/** Plies the game started with (opening practice 'skip'): never analyzed, taken back or counted. */
const preplayedOf = (g: Pick<GameInfo, 'preplayed'> | null | undefined): number => g?.preplayed ?? 0;
/** A ply that needs no more analysis: annotated, or played before the game started. */
const isSettled = (p: Ply, preplayed: number): boolean => p.index < preplayed || isAnnotated(p);
/** The classification of a line move played before the game started: book, with nothing lost. */
const bookClassification = (san: string): Classification => ({
  cls: 'book',
  winBefore: 0.5,
  winAfter: 0.5,
  winLoss: 0,
  accuracy: 100,
  bestMoveUci: null,
  bestMoveSan: null,
  playedMoveSan: san,
});
const uciOf = (m: Pick<Move, 'from' | 'to' | 'promotion'>): string => m.from + m.to + (m.promotion ?? '');
/** Explanation details that spell out a variation ("Engine line: …"); "Show best" has its own. */
const LINE_DETAIL = /^(Engine line|Main line|Key line|The finish):/;
const prevMoveOf = (p: Pick<Ply, 'uci' | 'captured'>): PrevMove => ({
  to: p.uci.slice(2, 4),
  ...(p.captured ? { captured: p.captured } : {}),
});

/**
 * The opening a game follows, from `NewGameOptions.opening` or a save: the catalog line `lineId`,
 * else the line given by its moves (see `OpeningGameOptions.moves`); null when neither is usable.
 */
function openingTarget(
  o: Pick<OpeningGameOptions, 'lineId' | 'mode' | 'showLineMoves' | 'moves' | 'name' | 'family'>,
): OpeningTarget | null {
  const mode = o.mode === 'skip' ? 'skip' : 'steer';
  const showLineMoves = mode === 'steer' && o.showLineMoves === true;
  const known = getLine(o.lineId);
  if (known) return { line: known, mode, showLineMoves };
  const family = o.family ?? o.name ?? '';
  const line = o.moves?.length ? studyOpeningLine(o.lineId, o.moves, o.name ?? family, family) : null;
  return line ? { line, mode, showLineMoves, custom: true } : null;
}

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

/**
 * The coach mode after a restore: the verdict on the human's last move, while it is still the
 * move being discussed (the last ply, or followed only by the bot's reply), as in live play.
 * (A saved "Try again" prompt after a Retry takes precedence, see `restore`.)
 */
function restoredCoachMode(plies: readonly Ply[], playerColor: Color, preplayed = 0): CoachMode {
  for (let i = plies.length - 1; i >= preplayed && i >= plies.length - 2; i--) {
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
  /** The game view the explorer left (restored on exit), and the game's result at that time. */
  private explorerView: { viewIndex: number | null; flipped: boolean; outcome: GameOutcome | null } | null = null;
  /** Bumped whenever an explorer opens or closes, so its late analyses are dropped. */
  private explorerSession = 0;
  /** Rating the explored moves (background, in line order). */
  private explorerRating: Promise<void> | null = null;
  /** The explorer's "Engine reply" waiting for analysis, and the explorer it was asked in. */
  private explorerReplyTask: { session: number; task: Promise<void> } | null = null;
  /** Withdraws the open explorer's analysis requests when it closes (see `dropExplorer`). */
  private explorerAbort: AbortController | null = null;
  /**
   * The game ended while exploring or while the Openings section was open: the game-over sheet
   * opens when it closes.
   */
  private deferredGameOver = false;
  /** Stops following the Openings section (see `onOpeningsClosed`). */
  private unwatchOpenings: () => void;
  /** Bumped by every game start, so an opening game still waiting for its data never replaces a newer game. */
  private startTicket = 0;

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
    this.unwatchOpenings = openingsOpen.subscribe((open) => {
      if (!open) this.onOpeningsClosed();
    });
  }

  /**
   * The Openings section closed: a game that ended while it was open (by the bot's move) shows its
   * game-over sheet now, over whatever sheet the section was opened from.
   */
  private onOpeningsClosed(): void {
    const s = this.s;
    if (!this.deferredGameOver || s.explorer.value) return;
    this.deferredGameOver = false;
    if (s.outcome.value && s.phase.value === 'over') s.sheet.value = 'gameOver';
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
    if (locked.has('explorer')) this.exitExplorer();
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
    this.unwatchOpenings();
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
    if (saved?.opening) {
      // An opening-practice game needs its line (the catalog) to go on steering.
      try {
        await loadExplorer();
      } catch (e) {
        console.warn('[game] the opening data could not load; the game goes on without its line', e);
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
    this.dropExplorer();
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
    this.dropExplorer();
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
    const target = saved.opening ? openingTarget(saved.opening) : null;
    if (saved.opening && !target) console.warn('[game] the saved opening line is unknown; the game goes on without it', saved.opening.lineId);
    if (target) game.opening = target;
    if (saved.preplayed) game.preplayed = Math.min(saved.preplayed, plies.length);
    const startEval = (saved as SavedGame & { startEval?: unknown }).startEval;
    const over = saved.over ?? null;
    this.chess = chess;
    this.epoch++;
    this.clearFailed();
    this.dropExplorer();
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
          : restoredCoachMode(plies, game.playerColor, preplayedOf(game));
      s.coachCollapsed.value = null;
      s.coachFocus.value = null;
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
   *
   * With `opening` (opening practice) the game follows a line of the openings catalog and is
   * unrated from the start: 'steer' starts from the initial position, and while the game is on the
   * line (transpositions count) the bot plays the line's next move; 'skip' starts with the line's
   * moves already played (as book moves). The catalog and the book load first when needed (the
   * game then starts a moment later; the returned promise resolves once it has). An unknown line
   * starts a normal game, with a warning.
   */
  newGame(settings: GameSettings, opts: NewGameOptions = {}): Promise<void> {
    const next = { ...settings };
    if (next.showBestMoves && !this.entitlements.isAllowed('bestMoveArrows')) next.showBestMoves = false;
    // Opening practice picks its own side and opponent (the Openings section's Play sheet): the
    // player's New game choices (colour, opponent, Match my rating) stay the defaults.
    const prev = this.s.settings.value;
    const defaults = opts.opening
      ? { ...next, playerColor: prev.playerColor, botId: prev.botId, botElo: prev.botElo, adaptive: prev.adaptive }
      : next;
    this.s.settings.value = defaults;
    saveSettings(defaults, this.storage);
    this.sound.setEnabled(next.sound);
    if (opts.opening) return this.startOpening(next, opts.opening);
    this.startGame(next, opts.startFen);
    return Promise.resolve();
  }

  /** Starts an opening-practice game once the catalog and the book are loaded (see `newGame`). */
  private async startOpening(settings: GameSettings, o: OpeningGameOptions): Promise<void> {
    const ticket = ++this.startTicket;
    if (!catalogLoaded() || !openingsLoaded()) {
      try {
        await loadExplorer();
      } catch (e) {
        console.warn('[game] the opening data could not load; starting a normal game', e);
      }
      if (ticket !== this.startTicket) return; // another game started meanwhile
    }
    const target = openingTarget(o);
    if (!target) console.warn('[game] unknown opening line; starting a normal game', o.lineId);
    this.startGame(settings, START_FEN, target ?? undefined);
  }

  /**
   * Same opponent and colour (adaptive games re-match the new rating), and the same opening in
   * opening practice. The other options, such as best-move arrows (which decide whether the game is
   * rated), are the current settings.
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
      g.opening,
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

  private startGame(settings: GameSettings, startFen = START_FEN, opening?: OpeningTarget): void {
    if (!this.analysis || !this.engines) return;
    this.startTicket++;
    if (opening) startFen = START_FEN; // catalog lines start from the initial position
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
    this.dropExplorer();
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
      // Best-move arrows and the opponent's move ratings are live help, and in opening practice the
      // computer's first moves are scripted: unrated from the start.
      assisted:
        (settings.showBestMoves && this.entitlements.isAllowed('bestMoveArrows')) || settings.rateOpponent || !!opening,
      settings: { ...settings },
      ...(opening ? { opening } : {}),
    };
    // Opening practice 'skip': the line's moves are on the board from the start, as book moves.
    const plies: Ply[] = [];
    if (opening?.mode === 'skip') {
      let ended = false;
      for (const uci of opening.line.uci) {
        let mv: Move;
        try {
          mv = chess.move(parseUci(uci));
        } catch {
          break;
        }
        if (chess.isGameOver()) {
          // A line that ends the game (the Fool's Mate): never a game over before the player moves.
          chess.undo();
          ended = true;
          break;
        }
        plies.push({ ...this.plyFromMove(mv, plies), isBook: true, classification: bookClassification(mv.san) });
      }
      // ...and the player moves first from there, so the bot cannot finish it either.
      if (ended && plies.length && chess.turn() !== playerColor) {
        chess.undo();
        plies.pop();
      }
      if (plies.length) game.preplayed = plies.length;
    }
    this.chess = chess;
    this.bot = this.makeBot(id);
    this.botReady = this.bot.newGame(bot.elo).catch((e: unknown) => console.warn('[game] bot newGame failed', e));
    batch(() => {
      s.game.value = game;
      s.plies.value = plies;
      s.startEval.value = null;
      s.viewIndex.value = null;
      s.flipped.value = false;
      s.outcome.value = null;
      s.ratingChange.value = null;
      s.reviewState.value = null;
      s.coachMode.value = { kind: 'idle' };
      s.coachCollapsed.value = null;
      s.coachFocus.value = null;
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
    if (!this.humanMoved(g)) return;
    const winner = otherColor(g.playerColor);
    this.recordResult(g, { result: winner === 'w' ? '1-0' : '0-1', winner, reason: 'Abandoned' }, !g.assisted);
  }

  /** The human has made a move in this game (the moves played before it started do not count). */
  private humanMoved(g: GameInfo): boolean {
    const pre = preplayedOf(g);
    return this.s.plies.value.some((p) => p.index >= pre && p.color === g.playerColor);
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
    if (!s.game.value || !s.humanToMove.value || !s.isLive.value || s.coachMode.value.kind === 'showBest' || s.explorer.value) {
      return false;
    }
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
    const pending = s.pendingAssist.value;
    if (pending && (pending.kind === 'undo' || pending.kind === 'retry')) return;
    const ctl = new AbortController();
    this.botCtl = ctl;
    const epoch = this.epoch;
    const plyCount = s.plies.value.length;
    const bot = this.bot;
    const fen = this.chess.fen();
    const history = s.plies.value.map((p) => p.uci);
    // Opening practice ('steer'): on the line, the bot plays the line's next move.
    const lineUci = this.steeredMove(g);
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
        const move = lineUci
          ? bot.lineMove
            ? await bot.lineMove(fen, g.botElo, lineUci, history, ctl.signal, g.startFen)
            : { uci: lineUci, source: 'book' as const, thinkMs: 0 }
          : await bot.move(fen, g.botElo, history, ctl.signal, g.startFen);
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

  /**
   * Opening practice ('steer'): the line's next move while the live game is on the line and has
   * not completed it yet (transpositions count), else null (the bot plays its own moves).
   */
  private steeredMove(g: GameInfo): string | null {
    const o = g.opening;
    if (!o || o.mode !== 'steer') return null;
    const p = lineProgress(o.line, g.startFen, this.s.plies.value);
    return p.status === 'on-line' && p.next && p.next.color !== g.playerColor ? p.next.uci : null;
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
    // Ended by the bot's move while the player explores (the explorer says so) or while the
    // Openings section covers the game: the game-over sheet waits until it closes.
    const deferred = !!s.explorer.value || openingsOpen.peek();
    if (deferred) this.deferredGameOver = true;
    batch(() => {
      s.outcome.value = outcome;
      s.ratingChange.value = { before: record.ratingBefore, after: record.ratingAfter, rated: record.rated };
      s.phase.value = 'over';
      if (!deferred) s.sheet.value = 'gameOver';
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
    // Never into the moves the game started with (opening practice).
    const floor = preplayedOf(g);
    let target = ps.length;
    while (target > floor && ps[target - 1].color !== g.playerColor) target--;
    return target <= floor ? null : target - 1;
  }

  private canRetry(index: number): boolean {
    const s = this.s;
    const g = s.game.value;
    const ply = s.plies.value[index];
    return (
      !!g &&
      !!ply &&
      ply.color === g.playerColor &&
      index >= preplayedOf(g) &&
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
    batch(() => {
      this.s.plies.value = ps.slice(0, n);
      // The row the player picked was about moves taken back (it would come back at the same count).
      this.s.coachFocus.value = null;
    });
  }

  /**
   * Resigns the game in progress: a loss, rated unless assisted. Before the human's first move it
   * is unrated (like abandoning a game before moving, which is not counted at all).
   */
  resign(): void {
    const s = this.s;
    const g = s.game.value;
    if (!g || s.phase.value !== 'playing' || s.outcome.value) return;
    this.exitExplorer();
    const winner = otherColor(g.playerColor);
    const moved = this.humanMoved(g);
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
   * A hint, takeback, Retry, the explorer or rating the opponent's moves makes a rated game
   * unrated, so the first one in a rated game opens the 'assist' sheet to confirm
   * (`confirmAssist()` runs it, `closeSheet()` cancels). In an unrated game it runs at once. While
   * a takeback (Undo, Retry) waits for the answer, the bot's reply is put on hold, as an unrated
   * takeback cancels it at once: otherwise a reply that ends the game would drop the takeback and
   * record the rated loss the player was taking back. (The explorer and the opponent's ratings can
   * be asked for on the bot's turn: the bot goes on thinking meanwhile.)
   */
  private requestAssist(a: PendingAssist): void {
    const s = this.s;
    if (s.game.value?.assisted === false) {
      if (a.kind === 'undo' || a.kind === 'retry') this.abortBot();
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
    else if (a.kind === 'explore') this.explore(a.base);
    else if (a.kind === 'rateOpponent') {
      this.markAssisted(); // first, so setSettings does not ask again
      this.setSettings({ rateOpponent: true });
    } else if (a.index !== undefined) this.retryMove(a.index);
  }

  /** Hides the hint (back to what the coach showed before). */
  dismissHint(): void {
    const m = this.s.coachMode.value;
    if (m.kind === 'hint') this.s.coachMode.value = m.prev;
    this.updateWatch();
  }

  /**
   * Runs a coach-panel action by id (the ids in `store.coach.value.actions`). A locked Pro action
   * (Show best) opens the paywall instead; 'unlock' opens it for the panel's locked feature;
   * 'opening' (opening practice's banner) opens the game's line in the Openings section.
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
        // The move the panel's verdict is about: yours, the opponent's (rated during play), or the one viewed.
        const index =
          s.coach.value.index ??
          (s.phase.value === 'playing' && s.isLive.value && m.kind === 'feedback' ? m.index : s.current.value - 1);
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
      case 'opening': {
        // Opening practice's banner: the line in the Openings section (the game stays as it is), at
        // the game's place on it (where the game left it, or its end once complete).
        const g = s.game.value;
        const o = g?.opening;
        if (!g || !o) return;
        const p = lineProgress(o.line, g.startFen, s.plies.value);
        openOpenings({ lineId: o.line.id, ply: p.status === 'complete' ? o.line.plies : p.reached });
        return;
      }
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
   * game marks it assisted (while they are locked, Pro, it opens the paywall instead). Switching
   * the opponent's move ratings on in a rated game in progress asks first (the 'assist' sheet,
   * see `requestAssist`); confirming switches them on and makes the game unrated.
   */
  setSettings(partial: Partial<GameSettings>): void {
    const s = this.s;
    const prev = s.settings.value;
    if (partial.showBestMoves && !prev.showBestMoves && !this.entitlements.requirePro('bestMoveArrows')) {
      const { showBestMoves: _locked, ...rest } = partial;
      if (!Object.keys(rest).length) return;
      partial = rest;
    }
    if (partial.rateOpponent && !prev.rateOpponent && this.ratedGameInProgress()) {
      const { rateOpponent: _asked, ...rest } = partial;
      this.requestAssist({ kind: 'rateOpponent' });
      if (!Object.keys(rest).length) return;
      partial = rest;
    }
    const next: GameSettings = { ...prev, ...partial };
    s.settings.value = next;
    saveSettings(next, this.storage);
    if (next.sound !== prev.sound) this.sound.setEnabled(next.sound);
    if (next.coach !== prev.coach || next.rateOpponent !== prev.rateOpponent) s.coachCollapsed.value = null;
    if (next.showBestMoves && !prev.showBestMoves) this.markAssisted();
    if (next.rateOpponent && !prev.rateOpponent) this.markAssisted();
    this.updateWatch();
  }

  /** A game in progress that still counts for the rating. */
  private ratedGameInProgress(): boolean {
    const s = this.s;
    const g = s.game.value;
    return !!g && !g.assisted && s.phase.value === 'playing' && !s.outcome.value;
  }

  /**
   * Shows the feedback on your last move or on the opponent's (the coach panel's other row, when
   * both are rated) until the next move, or a takeback; then the panel picks again (yours while it
   * has something to fix, else the opponent's, see store `playingCoach`).
   */
  selectCoachFeedback(subject: CoachSubject): void {
    const s = this.s;
    if (s.phase.value !== 'playing') return;
    s.coachFocus.value = { subject, at: s.plies.value.length };
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
    if (!s.game.value || s.explorer.value) return; // the explorer keeps the game's view as it was

    const n = s.plies.value.length;
    const v = index === null || index >= n ? null : Math.max(0, Math.floor(index));
    batch(() => {
      const m = s.coachMode.value;
      if (m.kind === 'showBest') s.coachMode.value = m.prev.kind === 'showBest' ? { kind: 'idle' } : m.prev;
      s.viewIndex.value = v;
    });
    this.updateWatch();
  }

  /** One ply back (toolbar ‹); in the explorer, one explored move back. */
  stepBack(): void {
    if (this.s.explorer.value) {
      this.explorerBack();
      return;
    }
    const c = this.s.current.value;
    if (c > 0) this.goTo(c - 1);
  }

  /** One ply forward (toolbar ›); reaching the last ply returns to live. In the explorer, along its line. */
  stepForward(): void {
    if (this.s.explorer.value) {
      this.explorerForward();
      return;
    }
    if (this.s.isLive.value) return;
    this.goTo(this.s.current.value + 1);
  }

  /** The "Back to game" chip. */
  backToLive(): void {
    if (this.s.explorer.value) return;
    if (this.s.coachMode.value.kind === 'showBest') this.backFromShowBest();
    this.goTo(null);
  }

  // -----------------------------------------------------------------------------------------------
  // Explorer (try moves without touching the game; see game/explorer.ts)

  /** A game is on the board (in progress, finished or in review) and the explorer is closed. */
  private canExplore(): boolean {
    const s = this.s;
    const p = s.phase.value;
    return !!s.game.value && !s.explorer.value && (p === 'playing' || p === 'over' || p === 'review');
  }

  /**
   * Toolbar "Explore": opens the explorer on the position on the board (see `explore`); pressed
   * while exploring, it closes it. While the explorer is locked (Pro) it opens the paywall instead.
   * In a rated game in progress it asks first, as exploring makes the game unrated (see
   * `requestAssist`); after the game and in the review it opens at once, with no effect on the
   * rating.
   */
  requestExplore(): void {
    const s = this.s;
    if (s.explorer.value) {
      this.exitExplorer();
      return;
    }
    if (!this.canExplore() || !this.entitlements.requirePro('explorer')) return;
    // The position asked about, even if the bot moves while the question is open.
    if (s.phase.value === 'playing' && !s.outcome.value) this.requestAssist({ kind: 'explore', base: this.explorerBase() });
    else this.explore();
  }

  /** Where an explorer opened now would start: the position on the board, and the game then. */
  private explorerBase(): ExplorerBase {
    const s = this.s;
    return { baseFen: s.displayedFen.value, baseIndex: s.current.value, fromLive: s.isLive.value, gamePlies: s.plies.value.length };
  }

  /**
   * Opens the explorer on the position on the board: the live one, or the earlier one being
   * browsed. Either side may then move on the board (`explorerMove`); the eval bar, the engine's
   * arrows and "Best here" follow the explorer's position, and each explored move is rated in the
   * background like the game's moves. The game itself never changes, and its bot goes on playing.
   * A game in progress becomes assisted (unrated): `requestExplore()` asks first, and the explorer
   * then opens on the position it asked about (`base`), even when the bot has moved meanwhile (the
   * panel says so, as for an explorer opened on the bot's turn). Returns whether the explorer
   * opened (not while it is locked, Pro).
   */
  explore(base?: ExplorerBase): boolean {
    const s = this.s;
    if (!this.canExplore() || !this.entitlements.isAllowed('explorer')) return false;
    const plies = s.plies.value;
    const fenAt = (k: number) => (k === 0 ? s.game.value!.startFen : plies[k - 1]?.fenAfter);
    // A base from this game's moves (the question cannot outlive them, but be sure).
    const from = base && base.gamePlies <= plies.length && fenAt(base.baseIndex) === base.baseFen ? base : this.explorerBase();
    this.markAssisted(); // only a game in progress
    this.explorerSession++;
    this.explorerAbort = new AbortController();
    this.explorerView = { viewIndex: s.viewIndex.value, flipped: s.flipped.value, outcome: s.outcome.value };
    this.deferredGameOver = false;
    batch(() => {
      s.explorer.value = startExplorer({ ...from, session: this.explorerSession });
      s.explorerReplying.value = false;
    });
    this.updateWatch();
    return true;
  }

  /**
   * Closes the explorer and brings back the game as it was shown (the move being viewed, unless the
   * game ended meanwhile, and the board's side) with no sheet open, except the game-over sheet of a
   * game that ended while exploring.
   */
  exitExplorer(): void {
    const s = this.s;
    if (!s.explorer.value) return;
    const v = this.explorerView;
    const ended = !!s.outcome.value && s.outcome.value !== v?.outcome;
    // Under the Openings section, the game-over sheet waits for it too (see `onOpeningsClosed`).
    const covered = openingsOpen.peek();
    const gameOver = this.deferredGameOver && !!s.outcome.value && !covered;
    const stillDeferred = this.deferredGameOver && covered;
    this.dropExplorer();
    this.deferredGameOver = stillDeferred;
    batch(() => {
      if (v) {
        s.flipped.value = v.flipped;
        if (!ended) s.viewIndex.value = v.viewIndex;
      }
      s.pendingAssist.value = null;
      s.sheet.value = gameOver ? 'gameOver' : null;
    });
    this.updateWatch();
  }

  /** Forgets the explorer without touching the game's view (a new game, a restore, an engine failure). */
  private dropExplorer(): void {
    const s = this.s;
    this.explorerSession++;
    // Its searches no longer hold the analysis queue (the game's own come next).
    this.explorerAbort?.abort();
    this.explorerAbort = null;
    this.explorerView = null;
    this.deferredGameOver = false;
    if (s.explorer.value) s.explorer.value = null;
    if (s.explorerReplying.value) s.explorerReplying.value = false;
  }

  /** A new explorer state: the board, the live analysis and the ratings follow it. */
  private setExplorer(next: Explorer): void {
    const s = this.s;
    if (next === s.explorer.value) return;
    s.explorer.value = next;
    this.updateWatch();
    this.kickExplorerRatings();
  }

  /**
   * A move on the explorer's board, for whichever side is to move (Board `onMove` while exploring).
   * Returns false (and plays the "illegal" sound) when it is rejected. None in a drawn position
   * (`store.explorerDraw`), as in the game.
   */
  explorerMove(from: string, to: string, promotion?: PromotionPiece): boolean {
    const x = this.s.explorer.value;
    if (!x || this.s.explorerDraw.value) return false;
    const next = playMove(x, from, to, promotion);
    if (!next) {
      this.sound.play('illegal');
      return false;
    }
    this.setExplorer(next);
    this.sound.play(soundForSan(currentMove(next)!.san));
    return true;
  }

  /** One explored move back (toolbar ‹). */
  explorerBack(): void {
    const x = this.s.explorer.value;
    if (x) this.setExplorer(explorerBackOf(x));
  }

  /** One explored move forward along the line (toolbar ›). */
  explorerForward(): void {
    const x = this.s.explorer.value;
    if (x) this.setExplorer(explorerForwardOf(x));
  }

  /** Shows the position after `n` explored moves (the move list's chips; 0 = the starting position). */
  explorerGoTo(n: number): void {
    const x = this.s.explorer.value;
    if (x) this.setExplorer(explorerGoToOf(x, n));
  }

  /** Toolbar "Reset": back to the explorer's starting position, with the line cleared. */
  explorerReset(): void {
    const x = this.s.explorer.value;
    if (x) this.setExplorer(explorerResetOf(x));
  }

  /**
   * "Engine reply": plays the engine's best move for the side to move in the explorer. It comes
   * from the analysis already at hand when that reached depth 12 (the live search usually has),
   * else from an annotation search (depth 14 within ANNOTATE_NODES, which the rating of the move
   * reuses). Dropped when the explorer has moved on meanwhile. A reply asked for in an explorer
   * since closed never stands in for this one's.
   */
  explorerReply(): Promise<void> {
    const pending = this.explorerReplyTask;
    if (pending && pending.session === this.explorerSession) return pending.task;
    const entry = { session: this.explorerSession, task: Promise.resolve() };
    entry.task = this.runExplorerReply()
      .catch((e: unknown) => console.error('[game] engine reply failed', e))
      .finally(() => {
        if (this.explorerReplyTask === entry) this.explorerReplyTask = null;
      });
    this.explorerReplyTask = entry;
    return entry.task;
  }

  private async runExplorerReply(): Promise<void> {
    const s = this.s;
    const svc = this.analysis;
    const x = s.explorer.value;
    if (!svc || !x || s.explorerDraw.value || !this.entitlements.isAllowed('explorer')) return;
    const fen = explorerFen(x);
    const session = this.explorerSession;
    const signal = this.explorerAbort?.signal;
    const known = svc.get(fen);
    let r: AnalysisResult | undefined = known && (known.depth >= SHALLOW_DEPTH || known.done) ? known : undefined;
    if (!r?.lines.length) {
      s.explorerReplying.value = true;
      try {
        r = await svc.ensure(fen, { ...ANNOTATE, signal });
      } catch (e) {
        console.warn('[game] engine reply: analysis failed', e);
        r = undefined;
      }
      if (session === this.explorerSession) s.explorerReplying.value = false;
    }
    const now = s.explorer.value;
    const uci = r?.lines[0]?.pv[0];
    if (!uci || !now || session !== this.explorerSession || explorerFen(now) !== fen) return;
    this.explorerMove(uci.slice(0, 2), uci.slice(2, 4), uci[4] as PromotionPiece | undefined);
  }

  /**
   * "Play 16. Nf3": commits the first explored move to the game through `playerMove` (the coach,
   * the annotation, the bot's reply, …) and closes the explorer. Only while `store.explorerPlayable`
   * offers it: the explorer started from the live position, nothing happened in the game since, and
   * it is the human's turn. Returns whether the move was played.
   */
  explorerPlay(): boolean {
    const m = this.s.explorerPlayable.value;
    if (!m) return false;
    this.exitExplorer();
    return this.playerMove(m.uci.slice(0, 2), m.uci.slice(2, 4), m.uci[4] as PromotionPiece | undefined);
  }

  /** Runs an explorer panel action by id (the ids in `store.explorerPanel.value.actions`). */
  runExplorerAction(id: ExplorerActionId): void {
    const s = this.s;
    switch (id) {
      case 'play':
        this.explorerPlay();
        return;
      case 'arrows':
        s.explorerArrows.value = !s.explorerArrows.value;
        return;
      case 'retryRating': {
        const x = s.explorer.value;
        if (x) this.setExplorer(clearFailedRatings(x));
        return;
      }
    }
  }

  /**
   * Rates the explored moves in the background, one at a time and in line order (a move's rating
   * uses the previous one's), so the explorer never has more than one search in the analysis queue
   * and the game's own annotations keep their turn.
   */
  private kickExplorerRatings(): void {
    if (this.explorerRating || !this.analysis || !this.s.explorer.value) return;
    const session = this.explorerSession;
    const task: Promise<void> = this.runExplorerRatings(session)
      .catch((e: unknown) => console.error('[game] explorer rating failed', e))
      .finally(() => {
        if (this.explorerRating !== task) return;
        this.explorerRating = null;
        // A new explorer opened while this one waited for the engine: rate its moves now.
        if (session !== this.explorerSession) this.kickExplorerRatings();
      });
    this.explorerRating = task;
  }

  private async runExplorerRatings(session: number): Promise<void> {
    for (;;) {
      const x = this.s.explorer.value;
      if (!x || session !== this.explorerSession || !this.analysis) return;
      const index = x.moves.findIndex((m) => !m.rating && !m.failed);
      if (index < 0) return;
      await this.rateExplored(session, x, index);
    }
  }

  /**
   * Rates explored move `index` like a game ply (see `annotate`): the positions before and after
   * it at depth 14 / MultiPV 3 within ANNOTATE_NODES (the analysis cache answers positions seen
   * before), then `classifyMove` with the previous move (an explored one, or the game's move that
   * led to the starting position) and `explainMove` from the human's point of view for the
   * human's color, else neutral.
   */
  private async rateExplored(session: number, x: Explorer, index: number): Promise<void> {
    const s = this.s;
    const svc = this.analysis!;
    const gameId = s.game.value?.id;
    const m = x.moves[index];
    const path = movePath(x, index);
    const signal = this.explorerAbort?.signal;
    const alive = (): boolean => {
      const now = s.explorer.value;
      return (
        this.analysis === svc &&
        session === this.explorerSession &&
        s.game.value?.id === gameId &&
        !!now &&
        movePath(now, index) === path
      );
    };
    const fail = (): void => {
      const now = s.explorer.value;
      if (now && alive()) s.explorer.value = setRating(now, index, path, { failed: true });
    };
    let before: AnalysisResult;
    let after: AnalysisResult;
    try {
      before = await svc.ensure(m.fenBefore, { ...ANNOTATE, signal });
      if (!alive()) return;
      after = await svc.ensure(m.fenAfter, { ...ANNOTATE, signal });
    } catch (e) {
      console.warn('[game] explorer: analysis failed', e);
      fail();
      return;
    }
    if (!alive()) return;
    const shallow = (r: AnalysisResult) => r.aborted === true && !r.terminal && r.depth < ANNOTATE_DEPTH;
    const afterScore = resultScore(after);
    if (shallow(before) || shallow(after) || !before.lines.length || !afterScore) {
      fail();
      return;
    }
    await this.openingsReady;
    if (!alive()) return;

    const g = s.game.value!;
    const now = s.explorer.value!;
    const plies = s.plies.value;
    const prevExplored = index > 0 ? now.moves[index - 1] : undefined;
    const prevPly = index === 0 && now.baseIndex > 0 ? plies[now.baseIndex - 1] : undefined;
    const prev = prevExplored ?? prevPly;
    const prevBook = prevExplored ? prevExplored.rating?.isBook === true : now.baseIndex === 0 || prevPly?.isBook === true;
    const isBook = prevBook && isBookMove(m.fenBefore, m.uci, m.fenAfter);
    const human = m.color === g.playerColor;
    const prevMove = prev ? prevMoveOf(prev) : undefined;
    // A third repetition (counting the game's positions up to the starting one) is a draw.
    const line = [...plies.slice(0, now.baseIndex), ...now.moves.slice(0, index + 1)];
    const repetition = isThirdRepetition(g.startFen, line, line.length - 1);
    const classification = classifyMove({
      fenBefore: m.fenBefore,
      moveUci: m.uci,
      before,
      after: repetition ? { ...after, terminal: 'stalemate' } : after,
      opponentPrevWinLoss: prevExplored ? prevExplored.rating?.classification.winLoss : prevPly?.classification?.winLoss,
      isBook,
      playerRating: human ? s.profile.value.rating : g.botElo,
      prevMove: prevMove ? { to: prevMove.to } : undefined,
      prevFenBefore: prev?.fenBefore,
    });
    const explanation = repetition
      ? repetitionExplanation(m.san, classification, { human, botName: g.bot.name })
      : explainMove({
          fenBefore: m.fenBefore,
          moveUci: m.uci,
          classification,
          before,
          after,
          prevMove,
          perspective: human ? 'you' : 'neutral',
        });
    s.explorer.value = setRating(now, index, path, {
      rating: {
        classification,
        explanation,
        evalWhite: repetition ? { kind: 'cp', value: 0 } : toWhitePov(afterScore, m.fenAfter),
        evalDepth: after.depth,
        isBook,
      },
    });
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
      if (s.plies.value.every((p) => isSettled(p, preplayedOf(g)))) break;
      this.clearFailed(); // one more try for plies whose analysis failed
    }
    if (!alive()) return;
    const summary = this.summary(g);
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

  /**
   * The review's summary. In opening practice the moves played before the game started are left
   * out: accuracy and counts start from the position after them (with its eval, see `annotate`).
   */
  private summary(g: GameInfo): ReturnType<typeof summarizeGame> {
    const ps = this.s.plies.value;
    const pre = Math.min(preplayedOf(g), ps.length);
    if (!pre) return summarizeGame(g.startFen, this.s.startEval.value, ps);
    return summarizeGame(ps[pre - 1].fenAfter, ps[pre - 1].evalWhite ?? null, ps.slice(pre));
  }

  private updateReviewProgress(): void {
    const s = this.s;
    const r = s.reviewState.value;
    if (s.phase.value !== 'review' || !r || r.progress === null) return;
    const ps = s.plies.value;
    const pre = preplayedOf(s.game.value);
    const done = ps.filter((p) => isSettled(p, pre)).length + (s.startEval.value ? 1 : 0);
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
      const pre = preplayedOf(g);
      const ply = this.s.plies.value.find((p) => !isSettled(p, pre) && !failed.has(annotationKey(g.id, p)));
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
    // The first move after the ones the game started with (opening practice): the position before
    // it gets its eval (the graph's point, and the review's accuracy starts there).
    if (index > 0 && index === preplayedOf(g) && !plies[index - 1].evalWhite) {
      const sb = whiteScore(before);
      if (sb) next[index - 1] = { ...plies[index - 1], evalWhite: sb, evalDepth: before.depth };
    }
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
    const x = s.explorer.value;
    if (x) {
      // Exploring: the eval bar, the arrows and "Best here" follow the explorer's position.
      svc.watch(explorerFen(x));
      return;
    }
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
   * paywall is open or a purchase is on its way, nor while exploring or while the Openings section
   * is open (neither is saved). When it stays no, the new service worker is active anyway and the next launch runs the new
   * version.
   */
  canReloadNow(opts: { hidden?: boolean } = {}): boolean {
    const s = this.s;
    const p = s.phase.value;
    const pro = this.entitlements;
    if (pro.paywall.value.open || pro.status.value === 'buying' || pro.status.value === 'restoring') return false;
    if (s.explorer.value) return false;
    // The Openings section's pages (a drill in progress, the line on the board) are not saved.
    if (openingsOpen.peek()) return false;
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
    const practice = g.opening?.line.name;
    return buildPgn({
      ...(practice ? { event: `Opening practice: ${practice}` } : {}),
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
    if (g.opening) {
      const { line, mode, showLineMoves, custom } = g.opening;
      saved.opening = { lineId: line.id, mode, showLineMoves };
      // A line from outside the catalog is saved with its moves (a restore needs no lookup).
      if (custom) saved.opening = { ...saved.opening, moves: [...line.uci], name: line.name, family: line.family };
    }
    if (g.preplayed) saved.preplayed = g.preplayed;
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
   * Resolves once no boot, bot move, background annotation, review, Show best analysis or explorer
   * analysis (ratings, Engine reply) is pending. For tests and e2e scripts (do not await it while a
   * bot move is blocked on purpose).
   */
  async idle(): Promise<void> {
    const pending = () =>
      [
        this.booting,
        this.botTask,
        this.annotating,
        this.reviewTask,
        this.showBestTask,
        this.explorerRating,
        this.explorerReplyTask?.task ?? null,
      ].filter((p) => p !== null);
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
