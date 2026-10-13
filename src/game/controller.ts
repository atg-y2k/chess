/**
 * Game flow and analysis orchestration: player move -> coach -> bot move, live evaluation,
 * background annotation of every ply, hints, takebacks, game end + rating, review and PGN.
 *
 * The UI renders `controller.store` (signals + computed view models, see store.ts) and calls the
 * methods below. Every async continuation (bot move, annotation, hint, review) is guarded by the
 * game id plus an epoch/ply token, so undo, new game or resign can never apply stale results.
 */
import { batch, computed, effect, type ReadonlySignal } from '@preact/signals';
import { Chess, type Move } from 'chess.js';
import { classifyMove, secondOpinionNeed, type ClassifyMoveInput } from '../analysis/classify';
import { cutAtRepetition, explainBestMove, explainMove, type PrevMove } from '../analysis/explain';
import { ALTERNATIVES_SUFFIX, alternativesSentence, equalAlternatives } from '../analysis/nearEqual';
import { probeThreat, type ThreatAlert } from '../analysis/threat';
import type { Classification, Explanation } from '../analysis/types';
import { resultScore, scoreToWin } from '../analysis/winprob';
import { BotPlayer } from '../bot/BotPlayer';
import { currentOpening, isBookMove, loadOpenings, openingsLoaded } from '../bot/book';
import { customPersona, personaById } from '../bot/personas';
import { hashSeed, mulberry32 } from '../bot/strength';
import type { BotMove } from '../bot/types';
import {
  START_FEN,
  fenKey,
  formatLine,
  isThirdRepetition,
  otherColor,
  parseUci,
  pvToSan,
  repetitionReplies,
  seenPositions,
  sideToMove,
  toWhitePov,
  uciToSan,
  withPosition,
  type SeenPositions,
} from '../chess/utils';
import { AnalysisService, defaultEnsureNodes, type AnalysisServiceOptions, type EnsureOptions } from '../engine/AnalysisService';
import { createEngines, type EngineLoadProgress, type EngineSet } from '../engine/createEngines';
import { EngineLoadError, engineFailureKind } from '../engine/errors';
import { inspectPosition } from '../engine/StockfishEngine';
import type { AnalysisResult, ChessEngine, Score } from '../engine/types';
import { engineSupported } from '../engine/workerTransport';
import { catalogLoaded, getLine } from '../openings/catalog';
import { openingsOpen, openingsShown, openOpenings } from '../openings/session';
import { loadExplorer } from '../openings/tree';
import {
  applyGameResult,
  clampRating,
  isProvisional,
  loadProfile,
  playerScoreFor,
  saveProfile,
  setStartingRating as withStartingRating,
  updateGameRecord,
} from '../rating/rating';
import type { GameRecord } from '../rating/types';
import {
  PUNISH_CLASSES,
  answerFreeLines,
  mentionsMove,
  moveLabel,
  namesMove,
  nearBestShowLines,
  punishmentOf,
  repetitionExplanation,
} from './coach';
import { NO_DRAWINGS, clearOn, drawOn, positionKey, type DrawColor, type UserShape } from './drawings';
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
  loadDrawTipSeen,
  loadGame,
  loadSettings,
  saveDrawTipSeen,
  saveGame,
  saveSettings,
  type KeyValueStorage,
  type PlyAnnotation,
  type SavedGame,
  type SavedResult,
} from './persistence';
import { archivePgn, archivedGame, encodeAnalysis, mergeAnalysis, recordBot, sameAnalysis, type ArchivedGame } from './archive';
import { lineProgress, studyOpeningLine, type OpeningTarget } from './opening';
import { buildPgn, type PgnPlayer } from './pgn';
import {
  answerMove,
  attemptFailed,
  canTryAgain,
  judgeAttempt,
  moreHint,
  nextMoment,
  playAttempt,
  practicePly,
  revealAnswer,
  startPractice,
  tryKey,
  withAnswer,
  type Practice,
  type PracticeAnswer,
  type PracticeAttempt,
  type PracticeGame,
  type PracticeRating,
} from './practice';
import { emptyCounts, summarizeGame } from './review';
import { playSound, setSoundEnabled, soundForSan, type SoundKind } from './sound';
import {
  SHALLOW_DEPTH,
  annotationKey,
  createState,
  createStore,
  personaForSettings,
  practiceGameLabel,
  uciArrow,
  whiteScore,
  type CoachActionId,
  type CoachMode,
  type CoachSubject,
  type ExplorerActionId,
  type GameInfo,
  type GamePractice,
  type PendingAssist,
  type ReadonlyStore,
  type SheetName,
  type Store,
} from './store';
import type { Color, GameOutcome, GameSettings, Ply, PromotionPiece, Punishment } from './types';
import {
  briefPlyShown,
  openViewer,
  viewerAnalyzed,
  viewerFen,
  viewerGoTo as viewerAt,
  viewerPracticeGame,
  viewerSummary,
  viewerView,
  withAnalyzedPly,
  type GameViewer,
  type ViewerActionId,
  type ViewerView,
} from './viewer';

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
/**
 * Priorities of the analysis engine's searches (`EnsureOptions.priority`: higher first, and a
 * higher one pre-empts a running lower one; the eval bar's live analysis always yields to them):
 * - `verdict`: the player's moves while playing (their positions before and after, and their second
 *   opinion), so the coach's verdict on the latest one, which the bot's reply waits for
 *   (FEEDBACK_HOLD_MS), comes first; also an earlier move's searches while that verdict waits for
 *   them (the queue goes in order, see `annotationPriority`);
 * - `user`: what the player is waiting for on the screen (a hint, Show best, a move tried again);
 * - `opponent`: the opponent's moves while playing (their rating) and the threat probes.
 * The review, the explorer, the game viewer and the Openings section ask with the default (0).
 */
export const ANALYSIS_PRIORITY = { verdict: 40, user: 30, opponent: 20 } as const;
/**
 * The near-equal second opinion that only settles "about as good" (classify.ts `secondOpinionNeed`),
 * asked before the verdict: the position after the engine's best move to depth 14 with one line
 * (only its score is compared), within 300k nodes, a quarter of an annotation's budget. Measured on the 138 moves of the
 * near-equal calibration's 105 positions that need one (against depth-20 searches): MultiPV 1
 * reaches depth 14 in a median of 45k nodes instead of 250k (about 0.1 s on an iPhone instead of
 * 0.5 s; never shallower within 300k), and calls 16 of the 24 moves that are truly about as good
 * so (the annotation request, MultiPV 3 within 1.2M nodes: 14), with no more false comfort (21
 * against 22 moves called so that were 0.03 or more worse, 3 and 3 at 0.05). The one that can
 * change the class keeps the annotation request.
 */
export const SECOND_OPINION: EnsureOptions = { minDepth: ANNOTATE_DEPTH, multiPv: 1, maxNodes: 300_000 };
/**
 * Feedback first: with the coach on, the bot's reply to the player's move waits until the coach's
 * verdict on that move is shown (or its check failed), at most this long beyond the bot's own
 * think time, so the reply never lands before the feedback (see `holdForFeedback`).
 */
export const FEEDBACK_HOLD_MS = 3500;
/**
 * Feedback first, on the screen: the held reply comes at least this long after the verdict was
 * shown (within FEEDBACK_HOLD_MS), so the verdict is painted and can be read on its own before the
 * bot's piece moves. Nothing is added when the verdict was up that long during the bot's own think
 * time. Not in tests that switch the bot's think time off (`ControllerDeps.thinkDelay`).
 */
export const FEEDBACK_LEAD_MS = 600;
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
  /** Longest wait of the bot's reply for the coach's verdict (default FEEDBACK_HOLD_MS). */
  feedbackHoldMs?: number;
  /**
   * How long the held reply comes after the verdict at least (default FEEDBACK_LEAD_MS, or 0 with
   * `thinkDelay: false`).
   */
  feedbackLeadMs?: number;
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
/** The best move's comparison with the other engine lines ("c6 and g6 are about as good."). */
const ABOUT_AS_GOOD = /about as good\.$/;
const escapeRegExp = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

/**
 * The move to `fen` lets the opponent end the game by repetition: every legal reply repeats a
 * position for the third time, or one does and the opponent is worse off (`after`, the search of
 * `fen`, from its side), so it would take the draw. `seen` counts the game's positions, `fen` included.
 */
function letsOpponentRepeat(fen: string, seen: SeenPositions, after: AnalysisResult): boolean {
  const repeats = repetitionReplies(fen, seen);
  if (!repeats.length) return false;
  let legal = 0;
  try {
    legal = new Chess(fen).moves().length;
  } catch {
    return false;
  }
  if (repeats.length >= legal) return true;
  const score = after.lines[0]?.score;
  return !!score && scoreToWin(score) < 0.5;
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
  private readonly feedbackHoldMs: number;
  private readonly feedbackLeadMs: number;
  /** When the coach's verdict on the player's latest move was shown (`holdForFeedback`'s lead), by annotation key. */
  private verdictShown: { key: string; at: number } | null = null;
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
  /**
   * Bumped whenever an explorer opens or closes, or its engine is switched off, so its late
   * analyses are dropped.
   */
  private explorerSession = 0;
  /** The game (id) in which the explorer's engine was switched on: its next explorer opens with it on. */
  private explorerEngineGame: string | null = null;
  /** Rating the explored moves (background, in line order). */
  private explorerRating: Promise<void> | null = null;
  /** The explorer's "Engine reply" waiting for analysis, and the explorer it was asked in. */
  private explorerReplyTask: { session: number; task: Promise<void> } | null = null;
  /**
   * Withdraws the open explorer's analysis requests when it closes or its engine is switched off
   * (see `dropExplorer`, `setExplorerEngine`).
   */
  private explorerAbort: AbortController | null = null;
  /**
   * The game ended while exploring or while the Openings section was open: the game-over sheet
   * opens when it closes.
   */
  private deferredGameOver = false;
  /** Stops following the Openings section (see `onOpeningsClosed`). */
  private unwatchOpenings: () => void;
  /** Stops following the paywall (it ends Draw mode). */
  private unwatchPaywall: () => void;
  /** Bumped by every game start, so an opening game still waiting for its data never replaces a newer game. */
  private startTicket = 0;
  /**
   * Threat alerts: the probes' results for this game's positions (by `fenKey`; null = no threat), the
   * probes in flight (by `fenKey`, withdrawn when the position is no longer the live one on the
   * player's turn) and their tasks (`idle()` waits for them).
   */
  private readonly threats = new Map<string, ThreatAlert | null>();
  private readonly threatProbes = new Map<string, { ctl: AbortController; task: Promise<void> }>();
  /** Withdraws the searches asked for the player's latest move ahead of the annotation queue (`prefetchVerdict`). */
  private prefetchAbort: AbortController | null = null;
  /** The search the annotation queue is waiting for (`annotationSearch`), if any. */
  private annotationInFlight: { svc: AnalysisService; fen: string; opts: EnsureOptions } | null = null;
  /**
   * Try again (see `tryAgain`): bumped for every try, so late analyses of another one are dropped;
   * the abort withdraws the try's analysis requests when it ends; the tasks (the answer's analysis,
   * an attempt's check) are what `idle()` waits for.
   */
  private practiceSession = 0;
  private practiceAbort: AbortController | null = null;
  private readonly practiceTasks = new Set<Promise<void>>();
  /**
   * The game viewer (see `openGame`): bumped for every game opened, so late analyses of another one
   * are dropped; the abort withdraws its analysis requests when it closes; the analysis task.
   */
  private viewerSession = 0;
  private viewerAbort: AbortController | null = null;
  private viewerTask: Promise<void> | null = null;
  /** The comment being written again for the move shown (`kickViewerExplain`): its abort and task. */
  private viewerExplainAbort: AbortController | null = null;
  private viewerExplainTask: Promise<void> | null = null;
  /** The game viewer's view model (game/viewer.ts `viewerView`; null while it is closed). */
  readonly viewerView: ReadonlySignal<ViewerView | null>;

  constructor(deps: ControllerDeps = {}) {
    this.storage = deps.storage;
    this.rng = deps.rng ?? Math.random;
    this.sound = deps.sound ?? { play: playSound, setEnabled: setSoundEnabled };
    this.now = deps.now ?? Date.now;
    this.thinkDelay = deps.thinkDelay ?? true;
    this.feedbackHoldMs = deps.feedbackHoldMs ?? FEEDBACK_HOLD_MS;
    this.feedbackLeadMs = deps.feedbackLeadMs ?? (this.thinkDelay ? FEEDBACK_LEAD_MS : 0);
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
    this.viewerView = computed(() => {
      const v = this.s.viewer.value;
      if (!v) return null;
      return viewerView(v, {
        locked: this.s.locked.value,
        drawColor: this.s.drawColor.value,
        ratedGame: this.ratedGameInProgress(),
        gameInProgress: this.gameToAbandon(),
        revealed: this.s.revealedTries.value,
      });
    });
    this.unwatchLocks = this.entitlements.locked.subscribe((locked) => this.onLocksChanged(locked));
    this.unwatchOpenings = openingsOpen.subscribe((open) => {
      if (open) this.exitDraw();
      else this.onOpeningsClosed();
    });
    this.unwatchPaywall = this.entitlements.paywall.subscribe((p) => {
      if (p.open) this.exitDraw();
    });
  }

  /**
   * The Openings section closed: a game that ended while it was open (by the bot's move) shows its
   * game-over sheet now, over whatever sheet the section was opened from.
   */
  private onOpeningsClosed(): void {
    const s = this.s;
    if (!this.deferredGameOver || s.explorer.value || s.practice.value || s.viewer.value) return;
    this.deferredGameOver = false;
    if (s.outcome.value && s.phase.value === 'over') s.sheet.value = 'gameOver';
  }

  /**
   * Pro features became locked (at start, or after a refund) or unlocked. A hint or Show best
   * that is now locked is closed, the explorer's engine is switched off, and best-move arrows are
   * switched off while they are locked, so buying Pro later does not switch them on in the middle
   * of a rated game.
   */
  private onLocksChanged(locked: ReadonlySet<ProFeature>): void {
    const s = this.s;
    if (locked.has('bestMoveArrows') && s.settings.value.showBestMoves) {
      const next = { ...s.settings.value, showBestMoves: false };
      s.settings.value = next;
      saveSettings(next, this.storage);
    }
    // Threat alerts too (a later purchase does not switch them on in the middle of a rated game).
    if (locked.has('threatAlerts') && s.settings.value.threatAlerts) {
      const next = { ...s.settings.value, threatAlerts: false };
      s.settings.value = next;
      saveSettings(next, this.storage);
    }
    const m = s.coachMode.value;
    if (m.kind === 'hint' && locked.has('hint')) this.dismissHint();
    else if (m.kind === 'showBest' && locked.has('showBest')) this.backFromShowBest();
    // A question about help that is now locked (the explorer's engine, a hint, threat alerts) has no
    // answer left: it goes, and a bot reply it held goes ahead.
    const asked = s.pendingAssist.value?.kind;
    if (
      (asked === 'exploreEngine' && (locked.has('explorerEngine') || locked.has('explorer'))) ||
      (asked === 'hint' && locked.has('hint')) ||
      (asked === 'threatAlerts' && locked.has('threatAlerts'))
    ) {
      this.closeSheet();
    }
    if (locked.has('explorer')) this.exitExplorer();
    else if (locked.has('explorerEngine')) this.setExplorerEngine(false);
    // Try again is part of Game Review's details: a refund ends it.
    if (locked.has('reviewDetails')) this.exitPractice();
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
    this.unwatchPaywall();
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
    this.dropPractice();
    this.dropViewer();
    this.resetThreats();
    this.dropPrefetch();
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
    this.dropPractice();
    this.dropViewer();
    this.dropPrefetch();
    this.exitDraw();
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
        // "Match my rating" as the game was started (older saves: the New game default).
        adaptive: saved.adaptive ?? (settings.adaptive && persona.id === 'custom'),
      },
    };
    const target = saved.opening ? openingTarget(saved.opening) : null;
    if (saved.opening && !target) console.warn('[game] the saved opening line is unknown; the game goes on without it', saved.opening.lineId);
    if (target) game.opening = target;
    if (saved.preplayed) game.preplayed = Math.min(saved.preplayed, plies.length);
    if (saved.practice) game.practice = { from: saved.practice.from, ...(saved.practice.after ? { after: true } : {}) };
    const startEval = (saved as SavedGame & { startEval?: unknown }).startEval;
    const over = saved.over ?? null;
    // Another game on the board (finished, or recorded as abandoned) keeps the verdicts it has so far.
    if (s.game.value && s.game.value.id !== game.id) this.recordAnalysis({ partial: true });
    this.chess = chess;
    this.epoch++;
    this.clearFailed();
    this.dropExplorer();
    this.dropPractice();
    this.dropViewer();
    this.dropPrefetch();
    this.exitDraw();
    // Another game's drawings go (the same game again, after an engine failure, keeps them), and so
    // do its threat alerts and a punishment shown.
    if (s.game.value?.id !== game.id) {
      s.drawings.value = NO_DRAWINGS;
      s.punishReveal.value = null;
    }
    this.resetThreats();
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
      s.pendingLevel.value = over ? null : (saved.pendingLevel ?? null);
      s.phase.value = over ? 'over' : 'playing';
    });
    this.updateWatch();
    this.kickAnnotations();
    if (over) this.ensureRecorded(game, over);
    else if (!this.checkGameEnd()) {
      this.requestBotMove();
      // The hint that was open on the player's turn comes back (the engine finds it again; the
      // game is unrated by it already, so nothing is asked).
      if (saved.hint && fenKey(saved.hint.fen) === fenKey(chess.fen()) && this.entitlements.isAllowed('hint')) void this.hint();
    }
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
    if (next.threatAlerts && !this.entitlements.isAllowed('threatAlerts')) next.threatAlerts = false;
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
      g.practice,
    );
  }

  /**
   * Sets the player's rating to a starting level (see STARTING_LEVELS in rating/rating.ts) and
   * saves the profile: the New Game sheet's "Your level" for a brand-new player, and the Menu's
   * "Set my level". The rating becomes provisional again; "Match my rating" follows it.
   */
  setStartingRating(rating: number): 'now' | 'afterGame' | null {
    if (!Number.isFinite(rating)) return null;
    const s = this.s;
    const g = s.game.value;
    // A rated game the player has moved in was paired at the current rating and still counts at it
    // (with its K-factor): the new level waits until it ends. (Before the first move it applies at
    // once: the game does not count yet, and a new game drops it.)
    if (g && this.ratedGameInProgress() && this.humanMoved(g)) {
      s.pendingLevel.value = clampRating(rating);
      this.save();
      return 'afterGame';
    }
    s.pendingLevel.value = null;
    this.applyLevel(rating);
    return 'now';
  }

  private applyLevel(rating: number): void {
    const s = this.s;
    const profile = withStartingRating(s.profile.value, rating);
    saveProfile(profile, this.storage);
    s.profile.value = profile;
  }

  /** A level chosen during the game that just ended (or was abandoned) applies now. */
  private applyPendingLevel(): void {
    const level = this.s.pendingLevel.peek();
    if (level === null) return;
    this.s.pendingLevel.value = null;
    this.applyLevel(level);
  }

  /**
   * `practice`: "Play on from here" (see `practicePlayOn`), a game from a position of an earlier game,
   * unrated from the start.
   */
  private startGame(settings: GameSettings, startFen = START_FEN, opening?: OpeningTarget, practice?: GamePractice): void {
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
    // rating before the loss that abandoning the current game records below, or from the level
    // chosen during that game (it applies once the game is recorded).
    const level = s.pendingLevel.peek();
    const bot = personaForSettings(settings, level === null ? s.profile.value : withStartingRating(s.profile.value, level));
    this.abandonCurrent();
    // The game leaving the board keeps the verdicts its moves have so far (the rest are not checked now).
    this.recordAnalysis({ partial: true });
    this.applyPendingLevel();
    this.abortBot();
    this.dropExplorer();
    this.dropPractice();
    this.dropViewer();
    this.dropPrefetch();
    this.exitDraw();
    this.analysis.cancelAll();
    // Forget the live target: a new game on the position already watched (a new game or rematch
    // before the first move) must emit its analysis again, or the eval bar and arrows stay blank.
    this.analysis.watch(null);
    this.resetThreats();
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
      // Best-move arrows, the opponent's move ratings and threat alerts are live help, in opening
      // practice the computer's first moves are scripted, and Play on from here starts from a
      // position the player chose: unrated from the start.
      assisted:
        (settings.showBestMoves && this.entitlements.isAllowed('bestMoveArrows')) ||
        settings.rateOpponent ||
        (settings.threatAlerts && this.entitlements.isAllowed('threatAlerts')) ||
        !!opening ||
        !!practice,
      settings: { ...settings },
      ...(opening ? { opening } : {}),
      ...(practice ? { practice: { from: practice.from, ...(practice.after ? { after: true } : {}) } } : {}),
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
      s.drawings.value = NO_DRAWINGS;
      s.punishReveal.value = null;
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
    if (
      !s.game.value ||
      !s.humanToMove.value ||
      !s.isLive.value ||
      s.coachMode.value.kind === 'showBest' ||
      s.explorer.value ||
      s.practice.value
    ) {
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
    if (ply.color === g.playerColor) this.prefetchVerdict(ply);
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
        // Feedback first: the reply waits (still "thinking") for the coach's verdict on the move it answers.
        if (move && stillCurrent()) await this.holdForFeedback(plyCount - 1, ctl.signal);
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
   * Feedback first: whether the bot's reply to ply `index` (the move the bot answers) is held for the
   * coach's verdict on it ('off' when not), and whether that verdict is shown. Held only for the
   * player's move with the coach on, while that move is the last one of the live game and its check
   * has not failed, and while the game is on the screen: not while exploring, trying a move again,
   * in the game viewer or the Openings section, nor once the game is over. Reads signals, so
   * `holdForFeedback` follows it.
   */
  private feedbackState(index: number): 'off' | 'checking' | 'shown' {
    const s = this.s;
    const g = s.game.value;
    const ps = s.plies.value;
    const ply = ps[index];
    if (!g || !ply || !this.analysis || ply.color !== g.playerColor || index < preplayedOf(g) || ps.length !== index + 1) return 'off';
    if (s.phase.value !== 'playing' || s.outcome.value || !s.settings.value.coach) return 'off';
    if (s.explorer.value || s.practice.value || s.viewer.value || openingsOpen.value) return 'off';
    if (s.failedAnnotations.value.has(annotationKey(g.id, ply))) return 'off';
    return ply.classification && ply.explanation ? 'shown' : 'checking';
  }

  /**
   * Resolves when the bot's reply to ply `index` may be played (see `feedbackState`): FEEDBACK_LEAD_MS
   * (`ControllerDeps.feedbackLeadMs`) after the verdict was shown, so the verdict is on the screen on
   * its own first (at once when it has been up that long: no extra delay beyond the bot's own think
   * time), and at once when the reply is not held (the coach off, the check failed, the explorer, Try
   * again, the game viewer or the Openings section open, the game over). Also when `signal` aborts
   * (Undo, Retry, a new game, resigning, the page hidden, an engine failure: the reply is dropped),
   * and after FEEDBACK_HOLD_MS (`ControllerDeps.feedbackHoldMs`) at most, so it never waits for good.
   */
  private holdForFeedback(index: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.feedbackState(index) === 'off') return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      let stop: (() => void) | null = null;
      let lead: ReturnType<typeof setTimeout> | undefined;
      const release = () => {
        if (done) return;
        done = true;
        clearTimeout(cap);
        clearTimeout(lead);
        signal.removeEventListener('abort', release);
        stop?.();
        resolve();
      };
      const cap = setTimeout(release, this.feedbackHoldMs);
      signal.addEventListener('abort', release, { once: true });
      const dispose = effect(() => {
        const state = this.feedbackState(index);
        if (state === 'off') {
          release();
          return;
        }
        if (state !== 'shown' || lead !== undefined || done) return;
        // The verdict is in: the reply comes once it has been on the screen for the lead.
        const g = this.s.game.peek()!;
        const key = annotationKey(g.id, this.s.plies.peek()[index]);
        const shown = this.verdictShown?.key === key ? this.verdictShown.at : -Infinity;
        const wait = shown + this.feedbackLeadMs - this.now();
        if (wait <= 0) release();
        else lead = setTimeout(release, wait);
      });
      if (done) dispose();
      else stop = dispose;
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
    const provisional = isProvisional(s.profile.value);
    const record = this.recordResult(g, outcome, (opts.rated ?? true) && !g.assisted);
    // "Set my level" during the game: the game counted at its own rating, the level starts now.
    this.applyPendingLevel();
    // Ended by the bot's move while the player explores (the explorer says so), tries an earlier
    // game's move again, or while the Openings section or the game viewer covers the game: the
    // game-over sheet waits until it closes, and Draw mode stays on there (the explorer carries on
    // undisturbed; leaving it ends Draw mode).
    const deferred = !!s.explorer.value || openingsOpen.peek() || !!s.practice.value || !!s.viewer.value;
    if (deferred) this.deferredGameOver = true;
    else this.exitDraw();
    batch(() => {
      s.outcome.value = outcome;
      s.ratingChange.value = {
        before: record.ratingBefore,
        after: record.ratingAfter,
        rated: record.rated,
        ...(provisional && record.rated ? { provisional } : {}),
      };
      s.phase.value = 'over';
      if (!deferred) s.sheet.value = 'gameOver';
      // A question about help in the game that just ended (the explorer's engine) has no point now.
      else if (s.sheet.value === 'assist') s.sheet.value = null;
      s.viewIndex.value = null;
      s.coachMode.value = { kind: 'idle' };
      s.pendingAssist.value = null;
    });
    this.save();
    this.sound.play('gameEnd');
    this.updateWatch();
    this.recordAnalysis();
  }

  /**
   * Once every move of the finished game is checked (or could not be), saves what the history keeps
   * of it in its record: the player's accuracy (Recent games), also without a Game Review, and the
   * coach's analysis in its compact form (game/archive.ts), for the game viewer's replay, review and
   * Try again later. Saved again when it changes (the review retries the moves that failed; the
   * accuracy follows once every move has its verdict).
   *
   * `partial`: the game is about to leave the board (a new game, a rematch, Play on) before every
   * move was checked: what is known is kept ('-' for the rest, which the viewer's Review fills in),
   * also for a game just abandoned, without its accuracy. A known verdict in the record is never
   * replaced by an unknown one (`mergeAnalysis`).
   */
  private recordAnalysis(opts: { partial?: boolean } = {}): void {
    const s = this.s;
    const g = s.game.value;
    if (!g || (!s.outcome.value && !opts.partial)) return;
    const record = s.profile.value.history.find((r) => r.id === g.id);
    if (!record) return;
    const pre = preplayedOf(g);
    const failed = s.failedAnnotations.value;
    const own = s.plies.value.slice(pre);
    const settled = own.every((p) => isSettled(p, pre) || failed.has(annotationKey(g.id, p)));
    if (!settled && !opts.partial) return;
    const patch: Partial<Pick<GameRecord, 'accuracy' | 'analysis'>> = {};
    if (settled && own.some((p) => p.color === g.playerColor)) {
      // Once every move has its verdict the accuracy is final (also when an earlier save had to do
      // without the moves that failed); until then a first figure is kept, never replaced.
      const complete = own.every((p) => isSettled(p, pre));
      const acc = this.summary(g).accuracy[g.playerColor];
      const rounded = acc !== null ? Math.round(acc * 10) / 10 : null;
      if (rounded !== null && (record.accuracy === undefined || (complete && record.accuracy !== rounded))) patch.accuracy = rounded;
    }
    const known = opts.partial ? s.plies.value.some((p) => p.classification) : s.plies.value.length > 0;
    if (known) {
      const encoded = encodeAnalysis(s.plies.value, s.startEval.value, { playerColor: g.playerColor, preplayed: pre });
      const analysis = mergeAnalysis(record.analysis, encoded);
      if (!sameAnalysis(record.analysis, analysis)) patch.analysis = analysis;
    }
    if (!Object.keys(patch).length) return;
    const profile = updateGameRecord(s.profile.value, g.id, patch);
    if (profile !== s.profile.value) {
      s.profile.value = profile;
      saveProfile(profile, this.storage);
    }
  }

  /**
   * The game viewer shows the game on the board (it ended, and its record was opened): the moves'
   * verdicts that landed since it opened join the viewer's copy, so it never shows (or saves) less
   * than the board knows.
   */
  private syncBoardViewer(): void {
    const s = this.s;
    const v = s.viewer.value;
    const g = s.game.value;
    if (!v?.game || !g || v.id !== g.id || !s.outcome.value) return;
    const board = s.plies.value;
    const mine = v.game.plies;
    if (board.length !== mine.length) return;
    let changed = false;
    const plies = mine.map((p, i) => {
      const b = board[i];
      if (b.uci !== p.uci || (p.classification && p.evalWhite) || (!b.classification && !b.evalWhite)) return p;
      changed = true;
      return { ...p, ...b };
    });
    const startEval = v.game.startEval ?? s.startEval.value;
    if (!changed && startEval === v.game.startEval) return;
    this.setViewer({ ...v, game: { ...v.game, plies, startEval } });
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
      botId: g.bot.id,
      ...(g.preplayed ? { preplayed: g.preplayed } : {}),
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
    this.exitDraw();
    this.truncate(target);
    this.markAssisted();
    const g = s.game.value!;
    batch(() => {
      // Back on the position before the move taken back, the panel shows what it showed there:
      // the verdict on your previous move (beside the opponent's reply, while it is rated).
      s.coachMode.value = restoredCoachMode(s.plies.value, g.playerColor, preplayedOf(g));
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
    this.dropPrefetch();
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
      r = await svc.ensure(fen, { ...ANNOTATE, priority: ANALYSIS_PRIORITY.user });
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
        seen: seenPositions(g.startFen, s.plies.value),
      });
      explanation = { ...e, arrows: e.arrows?.length ? e.arrows : uciArrow(line.pv[0], 'best') };
      this.markAssisted();
      // The hint names the best move: the punishment of the opponent's mistake, if one was asked for.
      this.revealPunishment();
    } else {
      explanation = { headline: 'No hint is available for this position.', details: [] };
    }
    s.coachMode.value = { ...now, explanation };
    this.save(); // the open hint comes back if iOS closes the app
  }

  private canHint(): boolean {
    const s = this.s;
    return !!s.game.value && s.humanToMove.value && s.isLive.value && s.coachMode.value.kind !== 'showBest' && !s.practice.value;
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
    if (this.undoTarget() !== null && !this.s.practice.value) this.requestAssist({ kind: 'undo' });
  }

  /**
   * A hint, takeback, Retry, the engine in the explorer, rating the opponent's moves or threat
   * alerts make a rated game unrated, so the first one in a rated game opens the 'assist' sheet to confirm
   * (`confirmAssist()` runs it, `closeSheet()` cancels). In an unrated game it runs at once. While
   * a takeback (Undo, Retry) waits for the answer, the bot's reply is put on hold, as an unrated
   * takeback cancels it at once: otherwise a reply that ends the game would drop the takeback and
   * record the rated loss the player was taking back. (The explorer's engine, the opponent's
   * ratings and threat alerts can be asked for on the bot's turn: the bot goes on thinking meanwhile.) The question
   * is dropped when the game ends, a new game starts or, for the explorer's engine, the explorer
   * closes.
   */
  private requestAssist(a: PendingAssist): void {
    const s = this.s;
    this.exitDraw();
    if (s.game.value?.assisted === false) {
      if (a.kind === 'undo' || a.kind === 'retry') this.abortBot();
      // Asked from the Menu (Rate opponent's moves): either answer goes back to it.
      const from = s.sheet.peek();
      batch(() => {
        s.pendingAssist.value = from === 'menu' ? { ...a, returnTo: 'menu' } : a;
        s.sheet.value = 'assist';
      });
      return;
    }
    this.runAssist(a);
  }

  /** Runs the help waiting in the 'assist' sheet (and goes back to the Menu when it was asked there). */
  confirmAssist(): void {
    const s = this.s;
    const a = s.pendingAssist.value;
    batch(() => {
      s.pendingAssist.value = null;
      if (s.sheet.value === 'assist') s.sheet.value = a?.returnTo ?? null;
    });
    if (a) this.runAssist(a);
    this.requestBotMove(); // the held reply, when nothing was taken back after all
  }

  private runAssist(a: PendingAssist): void {
    if (a.kind === 'undo') this.undo();
    else if (a.kind === 'hint') void this.hint();
    else if (a.kind === 'exploreEngine') {
      // Locked meanwhile (a refund): the paywall, and the game stays as it is.
      if (!this.s.explorer.value || !this.entitlements.requirePro('explorerEngine')) return;
      this.markAssisted();
      this.setExplorerEngine(true);
    } else if (a.kind === 'rateOpponent') {
      this.markAssisted(); // first, so setSettings does not ask again
      this.setSettings({ rateOpponent: true });
    } else if (a.kind === 'threatAlerts') {
      // Locked meanwhile (a refund): the paywall, and the game stays rated.
      if (!this.entitlements.requirePro('threatAlerts')) return;
      this.markAssisted();
      this.setSettings({ threatAlerts: true });
    } else if (a.index !== undefined) this.retryMove(a.index);
  }

  /** Hides the hint (back to what the coach showed before). */
  dismissHint(): void {
    const m = this.s.coachMode.value;
    if (m.kind === 'hint') {
      this.s.coachMode.value = m.prev;
      this.save();
    }
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
    // What changes the board or leaves it (Show best, Retry, the review, a new game…) ends Draw mode;
    // going back to the game, closing a hint or trying the analysis again keeps it.
    if (id !== 'backToGame' && id !== 'dismissHint' && id !== 'retryAnalysis') this.exitDraw();
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
        if (index >= 0) {
          this.showBest(index);
          // After the game: a weak move that can be tried again now shows its answer (Game Review).
          if (s.phase.value !== 'playing' && s.game.value) this.revealTry(s.game.value.id, index);
        }
        return;
      }
      case 'retry': {
        const index = m.kind === 'feedback' || m.kind === 'showBest' ? m.index : -1;
        if (index >= 0 && this.canRetry(index)) this.requestAssist({ kind: 'retry', index });
        return;
      }
      case 'showPunishment':
        // "Show me": the punishment of the opponent's mistake (the best move here), which is Pro's Show best.
        if (this.entitlements.requirePro('showBest')) this.revealPunishment();
        return;
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
      case 'tryAgain': {
        // Game Review's coach on one of your weak moves: try it again.
        const index = s.coach.value.index;
        if (index !== undefined) this.tryAgain(index);
        return;
      }
      case 'practiceHint':
        this.practiceHint();
        return;
      case 'practiceAnswer':
        this.practiceShowAnswer();
        return;
      case 'practiceNext':
        this.practiceNext();
        return;
      case 'practicePlayOn':
        this.practicePlayOn();
        return;
      case 'practiceExit':
        this.exitPractice();
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
      r = await svc.ensure(ply.fenBefore, { ...ANNOTATE, priority: ANALYSIS_PRIORITY.user });
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
    // The played move was about as good as the best (analysis/nearEqual.ts): the engine's top
    // choices with their evaluations and the played move's ("Your Nxd5: +0.8, close behind."), no
    // correction. Otherwise the moves about as good as the best are named after its explanation.
    const near = nearBestShowLines(ply, human ? 'Your' : `${g.bot.name}’s`);
    const alternatives = equalAlternatives(cl, ply.uci).map((m) => m.san);
    const namesAlternatives = (ls: readonly string[]) =>
      !alternatives.length || alternatives.every((a) => ls.some((l) => mentionsMove(l, a)));
    const lines: string[] = [];
    if (line) {
      // The game's positions up to this one: engine lines stop at a third repetition.
      const seen = seenPositions(g.startFen, s.plies.value, ply.index);
      const e = explainBestMove(ply.fenBefore, line, {
        prevMove: prev ? prevMoveOf(prev) : undefined,
        perspective: human ? 'you' : 'neutral',
        // All engine lines, as the hint and the feedback on a best move use them (same wording).
        lines: before?.lines,
        // The near-equal list above ranks the moves: no "only move" or "more precise than c5" here.
        ...(near.length ? { compare: false } : {}),
        seen,
      });
      const san = pvToSan(ply.fenBefore, cutAtRepetition(ply.fenBefore, line, seen).pv, 8);
      // "Best line" when the best move was clearly better, "Engine line" when several were about as good.
      const bestLine = san.length > 1 ? `${near.length ? 'Engine line' : 'Best line'}: ${formatLine(ply.fenBefore, san)}` : null;
      // The variation below already shows the line: skip the explanation's own copy. Which moves
      // are about as good is said once: by the list (near), or by "c5 was about as good." from
      // `equalBest`, which leaves out the moves the played one matched (see Classification).
      const details = (bestLine ? e.details.filter((d) => !LINE_DETAIL.test(d)) : e.details).filter(
        (d) => !ABOUT_AS_GOOD.test(d),
      );
      if (near.length) {
        lines.push(...near, e.headline, ...details.slice(0, 2));
        if (bestLine) lines.push(bestLine);
        return { bestUci, bestSan, lines, explained: true };
      }
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
      lines.push(e.headline, ...details.slice(0, 2));
      // "c6 was about as good." unless the explanation already names them.
      const also = namesAlternatives(lines) ? null : alternativesSentence(alternatives);
      if (also) lines.push(also);
      lines.push(playedLine);
      if (bestLine) lines.push(bestLine);
      return { bestUci, bestSan, lines, explained: true };
    }
    // No engine lines: what the saved explanation says.
    const bestLineSan = saved?.bestLineSan ?? [];
    const savedLine =
      bestLineSan.length > 1 && (!bestSan || bestLineSan[0] === bestSan) ? formatLine(ply.fenBefore, bestLineSan) : null;
    if (near.length) {
      // The saved text's own "Your Nxd5 was fine: …" is what the list above says.
      lines.push(...near);
      if (savedLine) lines.push(`Engine line: ${savedLine}`);
      return { bestUci, bestSan, lines, explained: false };
    }
    const bestLine = savedLine ? `Best line: ${savedLine}` : null;
    // The saved notes on the best move become the reason for it ("X wins a rook."), as the engine
    // explanation would put it first: "Best was X, which …" or "X was better: it …" (without the
    // alternatives, which get their own line). Those notes and "X was slightly more accurate …"
    // are left out below: the title and these lines say it.
    const notes = (saved?.details ?? []).map((d) => d.replace(ALTERNATIVES_SUFFIX, ''));
    const noteOn = (d: string) =>
      /^Best was /.exec(d) ?? (bestSan ? new RegExp(`^${escapeRegExp(bestSan)} was (better|slightly more accurate)\\b`).exec(d) : null);
    const reason = notes
      .map((d) => /^Best was (\S+?), which (.+)$/.exec(d) ?? /^(\S+?) was better: it (.+)$/.exec(d))
      .find((mm) => mm && (!bestSan || mm[1] === bestSan));
    const also = alternativesSentence(alternatives);
    if (reason) lines.push(`${reason[1]} ${reason[2]}`);
    if (reason && also) lines.push(also);
    lines.push(why && !why.startsWith('Best was') ? `${played} ${why}` : played);
    if (!reason && also) lines.push(also);
    const details = notes.filter((d) => !noteOn(d) && !(bestLine && LINE_DETAIL.test(d)));
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
   * the opponent's move ratings or threat alerts on in a rated game in progress asks first (the
   * 'assist' sheet, see `requestAssist`); confirming switches them on and makes the game unrated.
   * While threat alerts are locked (Pro), switching them on opens the paywall instead.
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
    if (partial.threatAlerts && !prev.threatAlerts) {
      // Pro (the paywall instead), and help: in a rated game in progress it asks first.
      const locked = !this.entitlements.requirePro('threatAlerts');
      if (locked || this.ratedGameInProgress()) {
        const { threatAlerts: _asked, ...rest } = partial;
        if (!locked) this.requestAssist({ kind: 'threatAlerts' });
        if (!Object.keys(rest).length) return;
        partial = rest;
      }
    }
    const next: GameSettings = { ...prev, ...partial };
    s.settings.value = next;
    saveSettings(next, this.storage);
    if (next.sound !== prev.sound) this.sound.setEnabled(next.sound);
    if (next.coach !== prev.coach || next.rateOpponent !== prev.rateOpponent) s.coachCollapsed.value = null;
    if (next.showBestMoves && !prev.showBestMoves) this.markAssisted();
    if (next.rateOpponent && !prev.rateOpponent) this.markAssisted();
    if (next.threatAlerts && !prev.threatAlerts) this.markAssisted();
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

  /** Flips the board (the player strips swap too). During Try again, only the try's board turns. */
  flip(): void {
    const p = this.s.practice.value;
    if (p) {
      this.s.practice.value = { ...p, flipped: !p.flipped };
      return;
    }
    this.s.flipped.value = !this.s.flipped.value;
  }

  openSheet(name: SheetName): void {
    this.exitDraw();
    batch(() => {
      if (name !== 'assist') this.s.pendingAssist.value = null;
      this.s.sheet.value = name;
    });
    this.requestBotMove(); // a cancelled takeback releases the bot's reply
  }

  /**
   * Closes the open sheet (cancelling a pending assist, which lets a held bot reply go ahead). A
   * question asked from the Menu goes back to the Menu.
   */
  closeSheet(): void {
    const s = this.s;
    const back = s.sheet.value === 'assist' ? (s.pendingAssist.value?.returnTo ?? null) : null;
    batch(() => {
      s.pendingAssist.value = null;
      s.sheet.value = back;
    });
    this.requestBotMove();
  }

  // -----------------------------------------------------------------------------------------------
  // Threat alerts and the punishment of the opponent's mistakes

  /**
   * "Show me" (the coach's 'showPunishment', or a hint shown meanwhile): reveals the punishment of
   * the opponent's latest move while it is still to be found (rated opponent moves: store
   * `punishView`). It stays revealed for that move, also after a takeback back to it.
   */
  private revealPunishment(): void {
    const s = this.s;
    const g = s.game.value;
    const last = s.plies.value.at(-1);
    if (!g || !last || last.color === g.playerColor) return;
    s.punishReveal.value = annotationKey(g.id, last);
  }

  /** Threat alerts are on for the game: the setting, allowed (Pro), and the game unrated (as it always is with them). */
  private threatAlertsOn(): boolean {
    const s = this.s;
    return s.settings.value.threatAlerts && this.entitlements.isAllowed('threatAlerts') && !!s.game.value?.assisted;
  }

  /**
   * Threat alerts: probes the live position on the player's turn (analysis/threat.ts, two searches
   * within THREAT_NODES each, queued before the annotation of the opponent's move), once per position
   * of the game (the results are kept by position, so a takeback or Retry back to it asks for nothing
   * new). A probe for a position that is no longer the live one on the player's turn is withdrawn,
   * and its late result never shows (`store.threat` is checked against the live position too).
   */
  private kickThreat(): void {
    const s = this.s;
    const svc = this.analysis;
    const g = s.game.value;
    const fen = s.liveFen.value;
    const key = fenKey(fen);
    const wanted =
      !!svc && !!g && this.threatAlertsOn() && s.phase.value === 'playing' && !s.outcome.value && sideToMove(fen) === g.playerColor;
    // Probes for any other position stop holding the engine.
    for (const [k, p] of this.threatProbes) {
      if (!wanted || k !== key) {
        p.ctl.abort();
        this.threatProbes.delete(k);
      }
    }
    if (!wanted || !svc || !g) return;
    if (this.threats.has(key)) {
      const known = this.threats.get(key) ?? null;
      if (s.threat.peek() !== known) s.threat.value = known;
      return;
    }
    if (this.threatProbes.has(key)) return;
    const ctl = new AbortController();
    const task = probeThreat(fen, (f, o) => svc.ensure(f, { ...o, priority: ANALYSIS_PRIORITY.opponent }), { name: g.bot.name, signal: ctl.signal })
      .then((alert) => {
        // Not known (withdrawn, or a search cut short): asked again when the position comes back.
        if (alert === undefined || ctl.signal.aborted || this.analysis !== svc || s.game.value?.id !== g.id) return;
        this.threats.set(key, alert);
        if (fenKey(s.liveFen.value) === key) s.threat.value = alert;
      })
      .catch((e: unknown) => console.warn('[game] threat probe failed', e))
      .finally(() => {
        if (this.threatProbes.get(key)?.task === task) this.threatProbes.delete(key);
      });
    this.threatProbes.set(key, { ctl, task });
  }

  /** Forgets the threat alerts (a new game, a restore, new engines) and withdraws the probes in flight. */
  private resetThreats(): void {
    for (const p of this.threatProbes.values()) p.ctl.abort();
    this.threatProbes.clear();
    this.threats.clear();
    if (this.s.threat.peek()) this.s.threat.value = null;
  }

  // -----------------------------------------------------------------------------------------------
  // Try again (Game Review's key moments; see game/practice.ts)

  /**
   * The game on the board as a game to try moves of again, once it is over (its review, or its
   * final position); null before.
   */
  practiceGame(): PracticeGame | null {
    const s = this.s;
    const g = s.game.value;
    const p = s.phase.value;
    if (!g || !s.outcome.value || (p !== 'over' && p !== 'review')) return null;
    return {
      id: g.id,
      startFen: g.startFen,
      playerColor: g.playerColor,
      bot: g.bot,
      botElo: g.botElo,
      plies: s.plies.value,
      startEval: s.startEval.value,
      ...(g.preplayed ? { preplayed: g.preplayed } : {}),
      source: 'current',
    };
  }

  /**
   * "Try again" on one of the player's key moments (an inaccuracy, mistake, miss or blunder: see
   * practice.ts `practiceMoments`): the board shows the position before that move with the player
   * to move, and the player looks for a better one (`practiceMove`), with hints (`practiceHint`) and
   * the answer (`practiceShowAnswer`) at hand; then the next one (`practiceNext`), a new game from
   * there (`practicePlayOn`) or back (`exitPractice`). `game` is the game on the board by default
   * (once it is over); an earlier game from the history can be given instead (`source: 'archive'`).
   * The game and the rating never change. Part of Game Review's details (Pro): the paywall while it
   * is locked. Returns whether it started.
   */
  tryAgain(index: number, game?: PracticeGame): boolean {
    const s = this.s;
    const source = game ?? this.practiceGame();
    if (!source || !this.analysis || s.explorer.value || !canTryAgain(source, index)) return false;
    // An earlier game's move while a rated game is on: the engine's help waits until it is over.
    if (source.source === 'archive' && this.ratedGameInProgress()) return false;
    if (!this.entitlements.requirePro('reviewDetails')) return false;
    this.exitDraw();
    this.startTry(source, index);
    return true;
  }

  /**
   * Sets up a try at ply `index` of `game` and asks the engine for the answer (the hints' and Show
   * answer's move). Its board starts turned as the board it came from (the review's, the viewer's),
   * or as `flipped` says (Next mistake keeps the try's own).
   */
  private startTry(game: PracticeGame, index: number, flipped?: boolean): void {
    const s = this.s;
    this.practiceAbort?.abort();
    this.practiceAbort = new AbortController();
    const session = ++this.practiceSession;
    const v = s.viewer.value;
    const turned = flipped ?? (game.source === 'archive' ? v?.id === game.id && v.flipped : s.flipped.value);
    s.practice.value = startPractice(game, index, session, turned);
    this.updateWatch();
    this.trackPractice(this.findAnswer(session));
  }

  /**
   * A move on the board while trying again (Board `onMove`): the move made in the game is "not
   * quite" at once; any other is checked with the engine (`checkAttempt`): a better one ends the
   * try, any other is taken back. Returns false (the "illegal" sound) when no move is awaited or it
   * is illegal.
   */
  practiceMove(from: string, to: string, promotion?: PromotionPiece): boolean {
    const s = this.s;
    const p = s.practice.value;
    if (!p) return false;
    const next = playAttempt(p, from, to, promotion);
    if (!next) {
      this.sound.play('illegal');
      return false;
    }
    s.practice.value = next;
    const a = next.attempt;
    if (next.status === 'checking' && a) {
      this.sound.play(soundForSan(a.san));
      this.trackPractice(this.checkAttempt(next.session, a));
    } else {
      this.sound.play('illegal'); // the move made in the game: back it goes
    }
    return true;
  }

  /** One more hint while a move is awaited: the piece to move, then its square. */
  practiceHint(): void {
    const s = this.s;
    const p = s.practice.value;
    if (!p) return;
    this.exitDraw();
    s.practice.value = moreHint(p);
  }

  /** "Show answer": the engine's best move, with its explanation and the move made in the game. */
  practiceShowAnswer(): void {
    const s = this.s;
    const p = s.practice.value;
    if (!p) return;
    this.exitDraw();
    s.practice.value = revealAnswer(p);
    this.revealTry(p.game.id, p.index);
  }

  /**
   * The better move of a weak move that can be tried again has been shown (Show best, a try found or
   * answered): from now on its comment names it, with its arrow (Game Review, the game viewer).
   */
  private revealTry(gameId: string, index: number): void {
    const s = this.s;
    const key = tryKey(gameId, index);
    if (s.revealedTries.value.has(key)) return;
    s.revealedTries.value = new Set([...s.revealedTries.value, key]);
  }

  /** "Next mistake": the next of the game's moves to try again (game order). Returns whether there was one. */
  practiceNext(): boolean {
    const p = this.s.practice.value;
    // The game on the board as it is now (its annotations may have landed since the try began).
    const game = p?.game.source === 'current' ? (this.practiceGame() ?? p.game) : p?.game;
    const next = p && game ? nextMoment(game, p.index) : null;
    if (!p || !game || next === null) return false;
    this.exitDraw();
    this.startTry(game, next, p.flipped);
    return true;
  }

  /**
   * "Play on from here": a new game against the same opponent from the position before the move
   * tried again, the player's side to move, with the player's current options. It is unrated from
   * the start (and so is its rematch); the New game choices stay as they were, and the earlier game
   * stays in the history as it was. Never while a game the player has moved in is in progress (it
   * would count as a loss by abandonment). Returns whether the game started.
   */
  practicePlayOn(): boolean {
    const s = this.s;
    const p = s.practice.value;
    if (!p || !this.analysis || !this.engines || this.gameToAbandon()) return false;
    const ply = practicePly(p);
    const settings: GameSettings = {
      ...s.settings.value,
      playerColor: p.game.playerColor,
      botId: p.game.bot.id,
      botElo: p.game.botElo,
      adaptive: false,
    };
    this.startGame(settings, ply.fenBefore, undefined, { from: moveLabel(ply) });
    return true;
  }

  /** A game is in progress that the player has moved in (starting another would abandon it). */
  private gameToAbandon(): boolean {
    const s = this.s;
    const g = s.game.value;
    return !!g && s.phase.value === 'playing' && !s.outcome.value && this.humanMoved(g);
  }

  /**
   * Ends the try ("Back to review", Escape, the toolbar's Back): the screen shows what it showed
   * before (the review as it was, or the game). A game that ended meanwhile (an earlier game's move
   * tried while one was in progress) shows its game-over sheet now.
   */
  exitPractice(): void {
    const s = this.s;
    if (!s.practice.value) return;
    this.exitDraw();
    this.dropPractice();
    // Back to the game viewer (an earlier game's try): a game-over waits for the viewer to close.
    if (this.deferredGameOver && !s.explorer.value && !openingsOpen.peek() && !s.viewer.value) {
      this.deferredGameOver = false;
      if (s.outcome.value && s.phase.value === 'over') s.sheet.value = 'gameOver';
    }
    this.updateWatch();
  }

  /** Forgets the try and withdraws its searches (a new game, a restore, the review ending, an engine failure). */
  private dropPractice(): void {
    this.practiceSession++;
    this.practiceAbort?.abort();
    this.practiceAbort = null;
    if (this.s.practice.value) this.s.practice.value = null;
  }

  private trackPractice(task: Promise<void>): void {
    const t: Promise<void> = task
      .catch((e: unknown) => console.error('[game] try again failed', e))
      .finally(() => this.practiceTasks.delete(t));
    this.practiceTasks.add(t);
  }

  /**
   * The engine's best move in the position before the move tried again (depth 14, MultiPV 3, within
   * ANNOTATE_NODES; the cache answers a position the review analyzed), with what the coach says
   * about it. Without engine lines (a search that failed), the saved classification's best move.
   */
  private async findAnswer(session: number): Promise<void> {
    const s = this.s;
    const svc = this.analysis;
    const p0 = s.practice.value;
    if (!svc || !p0 || p0.session !== session) return;
    const ply = practicePly(p0);
    let r: AnalysisResult | undefined;
    try {
      r = await svc.ensure(ply.fenBefore, { ...ANNOTATE, signal: this.practiceAbort?.signal, priority: ANALYSIS_PRIORITY.user });
    } catch (e) {
      console.warn('[game] try again: analysis failed', e);
    }
    const p = s.practice.value;
    if (!p || p.session !== session || this.analysis !== svc) return;
    const usable = r && !(r.aborted === true && !r.terminal && r.depth < ANNOTATE_DEPTH) ? r : undefined;
    s.practice.value = withAnswer(p, this.practiceAnswer(p, usable));
  }

  /** See `findAnswer`. */
  private practiceAnswer(p: Practice, r: AnalysisResult | undefined): PracticeAnswer | null {
    const ply = practicePly(p);
    const uci = answerMove(ply, r?.lines);
    const san = uci ? uciToSan(ply.fenBefore, uci) : null;
    if (!uci || !san) return null;
    const line = r?.lines.find((l) => l.pv[0] === uci);
    const lines: string[] = [];
    if (r && line) {
      const game = p.game;
      // The game's positions up to this one: engine lines stop at a third repetition.
      const seen = seenPositions(game.startFen, game.plies, p.index);
      const prev = p.index > 0 ? game.plies[p.index - 1] : undefined;
      const e = explainBestMove(ply.fenBefore, line, {
        prevMove: prev ? prevMoveOf(prev) : undefined,
        perspective: 'you',
        lines: r.lines,
        seen,
      });
      const sans = pvToSan(ply.fenBefore, cutAtRepetition(ply.fenBefore, line, seen).pv, 8);
      const bestLine = sans.length > 1 ? `Best line: ${formatLine(ply.fenBefore, sans)}` : null;
      lines.push(e.headline, ...(bestLine ? e.details.filter((d) => !LINE_DETAIL.test(d)) : e.details).slice(0, 2));
      if (bestLine) lines.push(bestLine);
    } else if (ply.explanation) {
      // No engine line: what the game's explanation says about the better move ("Best was X, which …").
      const e = ply.explanation;
      lines.push(...[e.headline, ...e.details].filter((l) => namesMove(l, san)));
    }
    return { uci, san, lines };
  }

  /**
   * Checks an attempt like a move of the game (`rateLineMove`: the annotations' searches, the second
   * opinion, the classification and the explanation for the player), then ends the try when it is
   * a better move or takes it back (practice.ts `judgeAttempt`). A check that fails takes it back
   * too, to be tried again. Dropped when the try has moved on meanwhile.
   */
  private async checkAttempt(session: number, a: PracticeAttempt): Promise<void> {
    const s = this.s;
    const svc = this.analysis;
    const p0 = s.practice.value;
    if (!svc || !p0 || p0.session !== session) return;
    const alive = (): boolean => {
      const p = s.practice.value;
      return this.analysis === svc && !!p && p.session === session && p.status === 'checking' && p.attempt?.uci === a.uci;
    };
    const { game, index } = p0;
    const prev = index > 0 ? game.plies[index - 1] : undefined;
    const r = await this.rateLineMove(svc, {
      move: a,
      signal: this.practiceAbort?.signal,
      priority: ANALYSIS_PRIORITY.user,
      alive,
      context: () => ({
        startFen: game.startFen,
        line: [...game.plies.slice(0, index), a],
        prev,
        prevWinLoss: prev?.classification?.winLoss,
        prevBook: index === 0 || prev?.isBook === true,
        human: true,
        neutral: false,
        playerRating: s.profile.value.rating,
        botName: game.bot.name,
      }),
    });
    if (r === 'stale' || !alive()) return;
    const p = s.practice.value!;
    if (r === 'failed') {
      s.practice.value = attemptFailed(p);
      return;
    }
    const { isBook: _book, ...rating } = r;
    const next = judgeAttempt(p, rating satisfies PracticeRating);
    s.practice.value = next;
    if (next.status === 'solved') this.revealTry(next.game.id, next.index);
    // A better move: a chime. Any other goes back, with the buzz of a move that does not stand.
    this.sound.play(next.status === 'solved' ? 'notify' : 'illegal');
  }

  // -----------------------------------------------------------------------------------------------
  // Draw mode (the player's own arrows and circles on the board; see game/drawings.ts)

  /**
   * The Draw toggle: Draw mode on, where the board takes arrows and circles instead of moves (the
   * game's board, the explorer's and the review's), or off again. Free, and never help: it changes
   * nothing in the game or its rating. Until the first drawing on this device, a tip says how.
   */
  toggleDraw(): void {
    if (this.s.drawMode.value) this.exitDraw();
    else this.enterDraw();
  }

  private enterDraw(): void {
    const s = this.s;
    if (!s.draw.value) return; // no game on the board
    // The tip shows each time until the first drawing on this device.
    const tip = !loadDrawTipSeen(this.storage);
    batch(() => {
      s.drawMode.value = true;
      s.drawTip.value = tip;
    });
  }

  /**
   * Leaves Draw mode (the Draw bar's Done, Escape; also a sheet, the paywall or the Openings section
   * opening, the explorer opening or closing, a new game, the game's end, the review, and the
   * actions that make or take back a move). The drawings stay on their positions.
   */
  exitDraw(): void {
    const s = this.s;
    if (!s.drawMode.value && !s.drawTip.value) return;
    batch(() => {
      s.drawMode.value = false;
      s.drawTip.value = false;
    });
  }

  /** The Draw bar's colors. */
  setDrawColor(color: DrawColor): void {
    this.s.drawColor.value = color;
  }

  /**
   * A drawing on the position on the board (Board `onDraw`, in Draw mode): added, or taken off
   * when the same squares are drawn again in the same color (another color recolors it). `fen`,
   * the position the gesture was drawn on, must still be the one on the board (a move that landed
   * meanwhile drops it). The first drawing on the device retires the first-use tip.
   */
  drawShape(shape: UserShape, fen?: string): void {
    const s = this.s;
    if (!s.drawMode.value || !s.draw.value) return;
    const board = s.board.value.fen;
    if (fen !== undefined && positionKey(fen) !== positionKey(board)) return;
    if (s.drawTip.value) saveDrawTipSeen(this.storage); // done once: the tip has made its point
    batch(() => {
      s.drawings.value = drawOn(s.drawings.value, board, shape);
      s.drawTip.value = false;
    });
  }

  /** The Draw bar's Clear: the drawings on the position on the board go (the other positions keep theirs). */
  clearDrawings(): void {
    const s = this.s;
    s.drawings.value = clearOn(s.drawings.value, s.board.value.fen);
  }

  // -----------------------------------------------------------------------------------------------
  // History browsing

  /**
   * Shows the position after `index` plies (null or >= plies.length = live). The board is
   * read-only while browsing; new bot moves do not move the view. Leaves a "Show best" preview.
   */
  goTo(index: number | null): void {
    const s = this.s;
    // The explorer and Try again keep the game's view as it was.
    if (!s.game.value || s.explorer.value || s.practice.value) return;

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
    if (this.s.explorer.value || this.s.practice.value) return;
    if (this.s.coachMode.value.kind === 'showBest') this.backFromShowBest();
    this.goTo(null);
  }

  // -----------------------------------------------------------------------------------------------
  // Explorer (try moves without touching the game; see game/explorer.ts)

  /** A game is on the board (in progress, finished or in review) and the explorer is closed. */
  private canExplore(): boolean {
    const s = this.s;
    const p = s.phase.value;
    return !!s.game.value && !s.explorer.value && !s.practice.value && (p === 'playing' || p === 'over' || p === 'review');
  }

  /**
   * Toolbar "Explore": opens the explorer on the position on the board at once (see `explore`);
   * pressed while exploring, it closes it. It never asks and never changes the rating: only the
   * explorer's engine does (`toggleExplorerEngine`). (Were the explorer itself Pro in
   * FEATURE_TIERS, it would open the paywall while locked.)
   */
  requestExplore(): void {
    if (this.s.explorer.value) {
      this.exitExplorer();
      return;
    }
    if (!this.canExplore() || !this.entitlements.requirePro('explorer')) return;
    this.explore();
  }

  /** Where an explorer opened now would start: the position on the board, and the game then. */
  private explorerBase(): ExplorerBase {
    const s = this.s;
    return { baseFen: s.displayedFen.value, baseIndex: s.current.value, fromLive: s.isLive.value, gamePlies: s.plies.value.length };
  }

  /**
   * Opens the explorer on the position on the board: the live one, or the earlier one being
   * browsed. Either side may then move on the board (`explorerMove`). The game itself never
   * changes, its bot goes on playing (the panel then says what was played in the game since), and
   * its rating is untouched.
   *
   * Its engine (`store.explorerEngine`) starts off during a game in progress, unless it was
   * switched on in this game before (`explorerEngineGame`), and on after the game and in the review
   * (when allowed, Pro). With the engine on, the eval bar, the engine's arrows and "Best here"
   * follow the explorer's position and each explored move is rated in the background like the
   * game's moves; off, nothing is asked of the engine about the explored positions. Returns whether
   * the explorer opened.
   */
  explore(): boolean {
    const s = this.s;
    if (!this.canExplore() || !this.entitlements.isAllowed('explorer')) return false;
    const g = s.game.value!;
    const from = this.explorerBase();
    const inProgress = s.phase.value === 'playing' && !s.outcome.value;
    const engine = (!inProgress || this.explorerEngineGame === g.id) && this.entitlements.isAllowed('explorerEngine');
    this.exitDraw();
    this.explorerSession++;
    this.explorerAbort = new AbortController();
    this.explorerView = { viewIndex: s.viewIndex.value, flipped: s.flipped.value, outcome: s.outcome.value };
    this.deferredGameOver = false;
    batch(() => {
      s.explorer.value = startExplorer({ ...from, session: this.explorerSession });
      s.explorerEngine.value = engine;
      s.explorerReplying.value = false;
    });
    this.updateWatch();
    return true;
  }

  /**
   * The explorer panel's Engine switch. Switching it on shows the engine's evaluation, arrows,
   * "Best here" and the ratings of the explored moves (all of them, rated now), and offers Reply.
   * In a rated game in progress that is help, so it asks first (the 'assist' sheet, see
   * `requestAssist`) and makes the game unrated; in an unrated game, after the game and in the
   * review it switches on at once. While it is locked (Pro) it opens the paywall instead, with no
   * question. Switching it off hides all of that at once and withdraws the explorer's searches; a
   * game it made unrated stays unrated.
   */
  toggleExplorerEngine(): void {
    const s = this.s;
    if (!s.explorer.value) return;
    if (s.explorerEngine.value && this.entitlements.isAllowed('explorerEngine')) {
      this.setExplorerEngine(false);
      return;
    }
    if (!this.entitlements.requirePro('explorerEngine')) return;
    if (this.ratedGameInProgress()) this.requestAssist({ kind: 'exploreEngine' });
    else this.setExplorerEngine(true);
  }

  /**
   * Switches the open explorer's engine on (when allowed) or off. On: the watch follows the
   * explorer's position and the explored moves are rated; in a game in progress it is remembered,
   * so the next explorer in this game opens with it on. Off: the explorer's searches are withdrawn
   * (as on Exit) and its late results dropped, the watch goes back to the game, and the next
   * explorer opens with it off again.
   */
  private setExplorerEngine(on: boolean): void {
    const s = this.s;
    if (!s.explorer.value) return;
    if (on) {
      if (!this.entitlements.isAllowed('explorerEngine') || s.explorerEngine.value) return;
      const g = s.game.value;
      if (g && s.phase.value === 'playing') this.explorerEngineGame = g.id;
      s.explorerEngine.value = true;
      this.updateWatch();
      this.kickExplorerRatings();
      return;
    }
    if (!s.explorerEngine.value) return;
    this.explorerEngineGame = null; // the next explorer in this game opens with it off too
    this.explorerSession++;
    this.explorerAbort?.abort();
    this.explorerAbort = new AbortController();
    batch(() => {
      s.explorerEngine.value = false;
      s.explorerReplying.value = false;
    });
    this.updateWatch();
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
    const covered = openingsOpen.peek() || !!s.viewer.value;
    const gameOver = this.deferredGameOver && !!s.outcome.value && !covered;
    const stillDeferred = this.deferredGameOver && covered;
    this.exitDraw();
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
    if (s.explorerEngine.value) s.explorerEngine.value = false;
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
   * since closed never stands in for this one's. Only with the explorer's engine on.
   */
  explorerReply(): Promise<void> {
    this.exitDraw();
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
    if (!svc || !x || s.explorerDraw.value || !this.explorerEngineOn()) return;
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
      case 'engine':
        this.toggleExplorerEngine();
        return;
    }
  }

  /** The open explorer's engine is on (its switch, and allowed: Pro). */
  private explorerEngineOn(): boolean {
    const s = this.s;
    return !!s.explorer.value && s.explorerEngine.value && this.entitlements.isAllowed('explorerEngine');
  }

  /**
   * Rates the explored moves in the background, one at a time and in line order (a move's rating
   * uses the previous one's), so the explorer never has more than one search in the analysis queue
   * and the game's own annotations keep their turn. Only with the explorer's engine on.
   */
  private kickExplorerRatings(): void {
    const x = this.s.explorer.value;
    if (this.explorerRating || !this.analysis || !this.explorerEngineOn() || !x?.moves.some((m) => !m.rating && !m.failed)) return;
    const session = this.explorerSession;
    let failed = false;
    const task: Promise<void> = this.runExplorerRatings(session)
      .catch((e: unknown) => {
        failed = true;
        console.error('[game] explorer rating failed', e);
      })
      .finally(() => {
        if (this.explorerRating !== task) return;
        this.explorerRating = null;
        // Moves tried, a new explorer opened or the engine switched on again while this one
        // finished: rate what is left now. (Never again in the same explorer after a run that
        // failed: it would only fail again, at once and without end.)
        if (!failed || session !== this.explorerSession) this.kickExplorerRatings();
      });
    this.explorerRating = task;
  }

  /**
   * The explored moves not rated yet, in line order. Each turn first makes sure of the position on
   * the board (an `ensure` the cache answers at once once it is known): it is the watched position,
   * so its search streams to the eval bar, the arrows and "Best here", which would otherwise wait
   * for every earlier move's rating (a long line tried with the engine off, then switched on).
   */
  private async runExplorerRatings(session: number): Promise<void> {
    for (;;) {
      const x = this.s.explorer.value;
      const svc = this.analysis;
      if (!x || session !== this.explorerSession || !svc || !this.explorerEngineOn()) return;
      if (!x.moves.some((m) => !m.rating && !m.failed)) return;
      try {
        await svc.ensure(explorerFen(x), { ...ANNOTATE, signal: this.explorerAbort?.signal });
      } catch (e) {
        console.warn('[game] explorer: analysis failed', e);
      }
      const now = this.s.explorer.value;
      if (!now || session !== this.explorerSession || this.analysis !== svc || !this.explorerEngineOn()) return;
      const index = now.moves.findIndex((m) => !m.rating && !m.failed);
      if (index < 0) return;
      const path = movePath(now, index);
      try {
        await this.rateExplored(session, now, index);
      } catch (e) {
        // A rating that throws fails like a search that did ("Try again"), and the run goes on.
        console.error('[game] explorer rating failed', e);
        const later = this.s.explorer.value;
        if (later && session === this.explorerSession && movePath(later, index) === path) {
          this.s.explorer.value = setRating(later, index, path, { failed: true });
        }
      }
    }
  }

  /**
   * Rates explored move `index` like a game ply (see `rateLineMove`), with the previous move (an
   * explored one, or the game's move that led to the starting position), from the human's point of
   * view for the human's color, else neutral.
   */
  private async rateExplored(session: number, x: Explorer, index: number): Promise<void> {
    const s = this.s;
    const svc = this.analysis!;
    const gameId = s.game.value?.id;
    const m = x.moves[index];
    const path = movePath(x, index);
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
    const r = await this.rateLineMove(svc, {
      move: m,
      signal: this.explorerAbort?.signal,
      alive,
      context: () => {
        const g = s.game.value!;
        const now = s.explorer.value!;
        const plies = s.plies.value;
        const prevExplored = index > 0 ? now.moves[index - 1] : undefined;
        const prevPly = index === 0 && now.baseIndex > 0 ? plies[now.baseIndex - 1] : undefined;
        const human = m.color === g.playerColor;
        return {
          startFen: g.startFen,
          line: [...plies.slice(0, now.baseIndex), ...now.moves.slice(0, index + 1)],
          prev: prevExplored ?? prevPly,
          prevWinLoss: prevExplored ? prevExplored.rating?.classification.winLoss : prevPly?.classification?.winLoss,
          prevBook: prevExplored ? prevExplored.rating?.isBook === true : now.baseIndex === 0 || prevPly?.isBook === true,
          human,
          // The player makes both sides' moves here: the computer's side is said by its color.
          neutral: true,
          playerRating: human ? s.profile.value.rating : g.botElo,
          botName: g.bot.name,
        };
      },
    });
    if (r === 'stale') return;
    const now = s.explorer.value;
    if (!now || !alive()) return;
    // The second opinion took a search: other ratings may have landed meanwhile.
    s.explorer.value = setRating(now, index, path, r === 'failed' ? { failed: true } : { rating: r });
  }

  /**
   * The verdict on one move of a line from a game's position, as the annotations give a game's move
   * (see `annotate`): the positions before and after it at depth 14 / MultiPV 3 within
   * ANNOTATE_NODES (the analysis cache answers positions seen before), the second opinion when the
   * near-equal rule needs one, then `classifyMove` with the previous move (its winLoss, for a miss)
   * and `explainMove` from the player's point of view for `human`, else neutral. A third repetition,
   * and a move that lets the other side repeat, are a draw (counting the line's positions from
   * `startFen`). 'failed' when a search failed or was cut short, 'stale' when `alive()` turned false
   * meanwhile. `context` is read once the searches are done (an earlier rating may have landed
   * meanwhile). The explorer's ratings and Try again's attempts use it.
   */
  private async rateLineMove(
    svc: AnalysisService,
    o: {
      move: Pick<Ply, 'uci' | 'san' | 'color' | 'fenBefore' | 'fenAfter'>;
      signal?: AbortSignal;
      /** ANALYSIS_PRIORITY (default 0: the explorer, the game viewer). */
      priority?: number;
      alive: () => boolean;
      context: () => {
        startFen: string;
        /** The moves from `startFen`, the rated one last. */
        line: readonly Pick<Ply, 'fenAfter'>[];
        prev?: Pick<Ply, 'uci' | 'captured' | 'fenBefore'>;
        prevWinLoss?: number;
        /** The line was in the opening book up to the previous move. */
        prevBook: boolean;
        human: boolean;
        /** A draw by repetition said by color, never as the computer's (the explorer). */
        neutral: boolean;
        playerRating: number;
        botName: string;
      };
    },
  ): Promise<(PracticeRating & { isBook: boolean }) | 'failed' | 'stale'> {
    const m = o.move;
    const signal = o.signal;
    const priority = o.priority ?? 0;
    let before: AnalysisResult;
    let after: AnalysisResult;
    try {
      before = await svc.ensure(m.fenBefore, { ...ANNOTATE, signal, priority });
      if (!o.alive()) return 'stale';
      after = await svc.ensure(m.fenAfter, { ...ANNOTATE, signal, priority });
    } catch (e) {
      console.warn('[game] analysis failed', e);
      return o.alive() ? 'failed' : 'stale';
    }
    if (!o.alive()) return 'stale';
    const shallow = (r: AnalysisResult) => r.aborted === true && !r.terminal && r.depth < ANNOTATE_DEPTH;
    const afterScore = resultScore(after);
    if (shallow(before) || shallow(after) || !before.lines.length || !afterScore) return 'failed';
    await this.openingsReady;
    if (!o.alive()) return 'stale';

    const c = o.context();
    const isBook = c.prevBook && isBookMove(m.fenBefore, m.uci, m.fenAfter);
    const prevMove = c.prev ? prevMoveOf(c.prev) : undefined;
    // A third repetition (counting the game's positions up to the starting one) is a draw, and so
    // is a move that lets the other side repeat (see `annotate`).
    const last = c.line.length - 1;
    const seen = seenPositions(c.startFen, c.line, last);
    const repetition = isThirdRepetition(c.startFen, c.line, last);
    const allows = !repetition && letsOpponentRepeat(m.fenAfter, withPosition(seen, m.fenAfter), after);
    const drawn = repetition || allows;
    const input: ClassifyMoveInput = {
      fenBefore: m.fenBefore,
      moveUci: m.uci,
      before,
      after: drawn ? { ...after, terminal: 'stalemate' } : after,
      opponentPrevWinLoss: c.prevWinLoss,
      isBook,
      playerRating: c.playerRating,
      prevMove: prevMove ? { to: prevMove.to } : undefined,
      prevFenBefore: c.prev?.fenBefore,
    };
    // Here the near-equal verdict is part of the answer (the explorer's rating, whether a move tried
    // again found it), so the second opinion comes before it (the one that only words it with
    // SECOND_OPINION, as in the game).
    const need = secondOpinionNeed(input);
    const bestAfter = need
      ? await this.secondOpinion(svc, need.fen, { ...(need.affectsClass ? ANNOTATE : SECOND_OPINION), priority, ...(signal ? { signal } : {}) })
      : undefined;
    if (!o.alive()) return 'stale';
    const classification = classifyMove({ ...input, ...(bestAfter ? { bestAfter } : {}) });
    const explanation = drawn
      ? repetitionExplanation(m.san, classification, {
          human: c.human,
          botName: c.botName,
          ...(c.neutral ? { neutral: true, mover: m.color } : {}),
          allows,
        })
      : explainMove({
          fenBefore: m.fenBefore,
          moveUci: m.uci,
          classification,
          before,
          after,
          prevMove,
          perspective: c.human ? 'you' : 'neutral',
          seen,
        });
    return {
      classification,
      explanation,
      evalWhite: drawn ? { kind: 'cp', value: 0 } : toWhitePov(afterScore, m.fenAfter),
      evalDepth: after.depth,
      isBook,
    };
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
    this.exitDraw();
    this.dropPractice();
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
    this.exitDraw();
    this.dropPractice();
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
    this.recordAnalysis(); // the moves that failed before and were checked now
  }

  /**
   * The review's summary. In opening practice the moves played before the game started are left
   * out: accuracy and counts start from the position after them (with its eval, see `annotate`).
   */
  private summary(g: GameInfo): ReturnType<typeof summarizeGame> {
    const ps = this.s.plies.value;
    const pre = Math.min(preplayedOf(g), ps.length);
    if (!pre) return summarizeGame(g.startFen, this.s.startEval.value, ps, g.playerColor);
    return summarizeGame(ps[pre - 1].fenAfter, ps[pre - 1].evalWhite ?? null, ps.slice(pre), g.playerColor);
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
    let threw = false;
    const task: Promise<void> = this.runAnnotations()
      .catch((e: unknown) => {
        threw = true;
        console.error('[game] annotation failed', e);
      })
      .finally(() => {
        if (this.annotating !== task) return;
        this.annotating = null;
        // A move played after the queue last looked (the bot's reply, released by the verdict that
        // ended it) is annotated now.
        if (!threw && this.nextToAnnotate()) this.kickAnnotations();
      });
    this.annotating = task;
  }

  /** The first ply still to annotate (not settled, and its analysis has not failed), if any. */
  private nextToAnnotate(): { gameId: string; ply: Ply } | null {
    const g = this.s.game.value;
    if (!g || !this.analysis) return null;
    const failed = this.s.failedAnnotations.value;
    const pre = preplayedOf(g);
    const ply = this.s.plies.value.find((p) => !isSettled(p, pre) && !failed.has(annotationKey(g.id, p)));
    return ply ? { gameId: g.id, ply } : null;
  }

  private async runAnnotations(): Promise<void> {
    for (;;) {
      const next = this.nextToAnnotate();
      if (!next) return;
      const { gameId, ply } = next;
      let res: AnnotateResult;
      try {
        res = await this.annotate(gameId, ply);
      } catch (e) {
        // A bug, not the engine: the move is marked as not checked ("Couldn’t check …", Check again),
        // so the queue moves on and a reply held for its verdict goes (rather than the same throw
        // stopping every later verdict).
        console.error('[game] annotation failed', e);
        res = 'failed';
      }
      if (res === 'failed') {
        this.markFailed(annotationKey(gameId, ply));
        this.recordAnalysis();
      }
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
      before = await this.annotationSearch(svc, ply.fenBefore, { ...ANNOTATE, priority: this.annotationPriority(ply) });
      if (!current()) return 'stale';
      after = await this.annotationSearch(svc, ply.fenAfter, { ...ANNOTATE, priority: this.annotationPriority(ply) });
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
    // it cannot know. Classify the move against that result (a terminal draw for classifyMove):
    // the move that repeats, and the move that lets the opponent repeat (its only reply, or a draw
    // it would take, being worse off), which is where a won game is given away.
    const seen = seenPositions(g.startFen, plies, index);
    const repetition = isThirdRepetition(g.startFen, plies, index);
    const allows = !repetition && letsOpponentRepeat(ply.fenAfter, withPosition(seen, ply.fenAfter), after);
    const drawn = repetition || allows;
    const input: ClassifyMoveInput = {
      fenBefore: ply.fenBefore,
      moveUci: ply.uci,
      before,
      after: drawn ? { ...after, terminal: 'stalemate' } : after,
      opponentPrevWinLoss: prev?.classification?.winLoss,
      isBook,
      playerRating: human ? s.profile.value.rating : g.botElo,
      prevMove: prevMove ? { to: prevMove.to } : undefined,
      prevFenBefore: prev?.fenBefore,
    };
    // The second opinion (near-equal awareness), before the verdict, so its words never change once
    // shown: the one that only settles "about as good" with its small request (SECOND_OPINION, about
    // 0.1 s on an iPhone), the rare one that can change the class with the annotation's. Its priority
    // is asked now: your move played meanwhile waits for this one's verdict (`annotationPriority`).
    const need = secondOpinionNeed(input);
    const bestAfter = need
      ? await this.secondOpinion(svc, need.fen, { ...(need.affectsClass ? ANNOTATE : SECOND_OPINION), priority: this.annotationPriority(ply) }, true)
      : undefined;
    if (!current()) return 'stale';
    const classification = classifyMove({ ...input, ...(bestAfter ? { bestAfter } : {}) });
    const explanation = drawn
      ? repetitionExplanation(ply.san, classification, { human, botName: g.bot.name, allows })
      : explainMove({
          fenBefore: ply.fenBefore,
          moveUci: ply.uci,
          classification,
          before,
          after,
          prevMove,
          perspective: human ? 'you' : 'neutral',
          // Engine lines stop where the game would end by repetition.
          seen,
        });
    // The opponent's mistake, miss or blunder: its punishment, the best reply (asked for while its
    // moves are rated, see store `punishView`).
    const punishment: Punishment | null =
      !human && !drawn && PUNISH_CLASSES.has(classification.cls)
        ? punishmentOf(ply.fenAfter, after.lines, { prevMove: prevMoveOf(ply), seen: withPosition(seen, ply.fenAfter) })
        : null;
    // The second opinion took a search: moves may have been played meanwhile.
    const latest = s.plies.value;
    const next = latest.slice();
    next[index] = {
      ...latest[index],
      evalWhite: drawn ? { kind: 'cp', value: 0 } : toWhitePov(afterScore, ply.fenAfter),
      evalDepth: after.depth,
      classification,
      explanation,
      isBook,
      ...(punishment ? { punishment } : {}),
    };
    if (!punishment) delete next[index].punishment;
    // The first move after the ones the game started with (opening practice): the position before
    // it gets its eval (the graph's point, and the review's accuracy starts there).
    if (index > 0 && index === preplayedOf(g) && !latest[index - 1].evalWhite) {
      const sb = whiteScore(before);
      if (sb) next[index - 1] = { ...latest[index - 1], evalWhite: sb, evalDepth: before.depth };
    }
    // The player's verdict: when it was shown (the held reply's lead, `holdForFeedback`).
    if (human) this.verdictShown = { key: annotationKey(gameId, ply), at: this.now() };
    batch(() => {
      s.plies.value = next;
      if (index === 0) {
        const sb = whiteScore(before);
        if (sb) s.startEval.value = sb;
      }
    });
    this.save();
    this.updateReviewProgress();
    this.syncBoardViewer();
    this.recordAnalysis();
    return 'done';
  }

  /**
   * The priority of a ply's annotation searches (ANALYSIS_PRIORITY), asked anew for each search:
   * while playing, the player's moves first (the coach's verdict, which the bot's reply waits for),
   * then the opponent's; but an opponent's move that a later move of the player's is waiting for
   * (the queue goes in order: that verdict needs this one's) comes with that verdict's. The default
   * in the review.
   */
  private annotationPriority(ply: Pick<Ply, 'index' | 'color'>): number {
    const s = this.s;
    const g = s.game.value;
    if (!g || s.phase.value !== 'playing' || s.outcome.value) return 0;
    if (ply.color === g.playerColor) return ANALYSIS_PRIORITY.verdict;
    return s.plies.value.slice(ply.index + 1).some((p) => p.color === g.playerColor) ? ANALYSIS_PRIORITY.verdict : ANALYSIS_PRIORITY.opponent;
  }

  /**
   * One of an annotation's searches (`annotate`), remembered while it runs (`annotationInFlight`), so
   * that the player's move, whose verdict waits for it, can ask it sooner (`prefetchVerdict`).
   */
  private async annotationSearch(svc: AnalysisService, fen: string, opts: EnsureOptions): Promise<AnalysisResult> {
    const mine = { svc, fen, opts };
    this.annotationInFlight = mine;
    try {
      return await svc.ensure(fen, opts);
    } finally {
      if (this.annotationInFlight === mine) this.annotationInFlight = null;
    }
  }

  /**
   * The player's move was just played: its positions before and after are searched now, ahead of
   * anything else on the analysis engine (the opponent's previous move's rating ends with the same
   * search; a running lower-priority search is pre-empted), so its verdict does not wait for the
   * annotation queue to get there. The annotation finds them in the cache (or joins them). The
   * search an earlier move's annotation is waiting for (the opponent's second opinion, say), which
   * this verdict waits for too, is asked again with the verdict's priority: it keeps running (or
   * moves up the queue) rather than being cut short by these. Withdrawn when the moves change
   * (`dropPrefetch`).
   */
  private prefetchVerdict(ply: Ply): void {
    const svc = this.analysis;
    if (!svc || this.s.phase.value !== 'playing') return;
    this.prefetchAbort ??= new AbortController();
    const signal = this.prefetchAbort.signal;
    const asked = (r: Promise<AnalysisResult>) => r.catch((e: unknown) => console.warn('[game] analysis failed', e));
    const earlier = this.annotationInFlight;
    if (earlier?.svc === svc && (earlier.opts.priority ?? 0) < ANALYSIS_PRIORITY.verdict) {
      asked(svc.ensure(earlier.fen, { ...earlier.opts, priority: ANALYSIS_PRIORITY.verdict, signal }));
    }
    const req = { ...ANNOTATE, priority: ANALYSIS_PRIORITY.verdict, signal };
    for (const fen of [ply.fenBefore, ply.fenAfter]) asked(svc.ensure(fen, req));
  }

  /** Withdraws the searches `prefetchVerdict` asked for (a takeback, a new game, a restore, new engines). */
  private dropPrefetch(): void {
    this.prefetchAbort?.abort();
    this.prefetchAbort = null;
  }

  /**
   * The second opinion on whether a move was about as good as the engine's best (analysis/
   * nearEqual.ts, classify.ts `secondOpinionNeed`): when the move's own search puts it a little
   * outside the band of the best line, the position after the best move (`fen`) is searched too, so
   * the two moves are compared like with like: with `request` (SECOND_OPINION when it only settles
   * "about as good", ANNOTATE when it can change the class). Undefined when that search fails or is
   * cut short: the move is then judged without it (and corrected, as before the second opinion
   * existed). `annotation`: an annotation's (`annotationSearch`).
   */
  private async secondOpinion(
    svc: AnalysisService,
    fen: string,
    request: EnsureOptions,
    annotation = false,
  ): Promise<AnalysisResult | undefined> {
    try {
      const r = annotation ? await this.annotationSearch(svc, fen, request) : await svc.ensure(fen, request);
      return (r.aborted && !r.terminal && r.depth < request.minDepth) || (!r.terminal && !r.lines.length) ? undefined : r;
    } catch (e) {
      console.warn('[game] second opinion failed', e);
      return undefined;
    }
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

  /**
   * Points live analysis at the displayed position when anything needs it, and probes the live
   * position for a threat on the player's turn (threat alerts, see `kickThreat`).
   */
  private updateWatch(): void {
    const svc = this.analysis;
    if (!svc) return;
    this.kickThreat();
    const s = this.s;
    if (s.practice.value) {
      // Trying a move again: nothing live (the try's own searches check the moves, and the eval bar
      // shows what they and the game's annotations know, never a hint at the answer).
      svc.watch(null);
      return;
    }
    const x = s.explorer.value;
    if (x && this.explorerEngineOn()) {
      // Exploring with the engine: the eval bar, the arrows and "Best here" follow the explorer's
      // position. (With it off, the watch stays on the game's, as if not exploring.)
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
   * paywall is open or a purchase is on its way, nor while exploring, trying a move again or while
   * the Openings section is open (none of them is saved). When it stays no, the new service worker is active anyway and the next launch runs the new
   * version.
   */
  canReloadNow(opts: { hidden?: boolean } = {}): boolean {
    const s = this.s;
    const p = s.phase.value;
    const pro = this.entitlements;
    if (pro.paywall.value.open || pro.status.value === 'buying' || pro.status.value === 'restoring') return false;
    if (s.explorer.value || s.practice.value || s.viewer.value) return false;
    // The Openings section's pages (a drill in progress, the line on the board) are not saved. A
    // section that shows only "Loading…" or "Couldn't load" (its chunk is gone after an update)
    // holds nothing: the reload onto the new build is what fixes it.
    if (openingsOpen.peek() && openingsShown.peek()) return false;
    if (p === 'setup' || p === 'error') return true;
    if (p === 'over') return s.sheet.value === null || opts.hidden === true;
    return false;
  }

  // -----------------------------------------------------------------------------------------------
  // PGN & persistence

  /**
   * PGN of the current / last game, with `[%eval]` comments and NAGs where annotated ('' without a
   * game). During the game only the marks the app shows then: your moves' with the coach on, the
   * computer's while they are rated (`rateOpponent`, an unrated game), so a rated game's export
   * never reveals the computer's mistakes.
   */
  exportPgn(): string {
    const s = this.s;
    const g = s.game.value;
    const playing = s.phase.value === 'playing' && !s.outcome.value;
    const nag =
      playing && g
        ? (p: Ply) => (p.color === g.playerColor ? s.settings.value.coach : s.settings.value.rateOpponent && g.assisted)
        : undefined;
    return this.pgnText(s.outcome.value, true, nag);
  }

  private pgnText(outcome: GameOutcome | null, annotations: boolean, nag?: (p: Ply) => boolean): string {
    const s = this.s;
    const g = s.game.value;
    if (!g) return '';
    const rc = s.ratingChange.value;
    const human: PgnPlayer = { name: 'You', elo: rc ? rc.before : s.profile.value.rating };
    const bot: PgnPlayer = { name: g.bot.name, elo: g.botElo };
    const opening = [...s.plies.value].reverse().find((p) => p.opening)?.opening ?? null;
    const practice = g.opening?.line.name;
    const event = practice ? `Opening practice: ${practice}` : g.practice ? practiceGameLabel(g.practice) : null;
    return buildPgn({
      ...(event ? { event } : {}),
      startFen: g.startFen,
      plies: s.plies.value,
      white: g.playerColor === 'w' ? human : bot,
      black: g.playerColor === 'w' ? bot : human,
      date: new Date(g.startedAt),
      result: outcome?.result ?? '*',
      ...(outcome ? { termination: outcome.reason } : {}),
      opening,
      annotations,
      ...(nag ? { nag } : {}),
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
      if (p.punishment) a.punishment = p.punishment;
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
      adaptive: g.settings.adaptive,
    };
    if (playing && s.pendingLevel.value !== null) saved.pendingLevel = s.pendingLevel.value;
    if (g.opening) {
      const { line, mode, showLineMoves, custom } = g.opening;
      saved.opening = { lineId: line.id, mode, showLineMoves };
      // A line from outside the catalog is saved with its moves (a restore needs no lookup).
      if (custom) saved.opening = { ...saved.opening, moves: [...line.uci], name: line.name, family: line.family };
    }
    if (g.preplayed) saved.preplayed = g.preplayed;
    if (g.practice) saved.practice = { from: g.practice.from, ...(g.practice.after ? { after: true } : {}) };
    if (s.startEval.value) saved.startEval = s.startEval.value;
    // The "Try again" prompt after a Retry (also under a hint asked for meanwhile): the retried
    // move is gone from `moves`, so a restore could not rebuild it.
    const m0 = s.coachMode.value;
    const m = m0.kind === 'hint' ? m0.prev : m0;
    if (playing && m.kind === 'retry') saved.retry = { san: m.san, cls: m.cls, headline: m.headline };
    if (playing && m0.kind === 'hint') saved.hint = { fen: m0.fen };
    if (finished && o) {
      const rc = s.ratingChange.value;
      const rating = s.profile.value.rating;
      saved.over = { outcome: o, ratingChange: rc ?? { before: rating, after: rating, rated: false } };
    }
    saveGame(saved, this.storage);
  }

  // -----------------------------------------------------------------------------------------------
  // Game viewer (earlier games from the history; see game/viewer.ts)

  /**
   * Opens a game of the history (its record id) in the game viewer, at its final position: the
   * Menu's Recent games and the rating chart (`from: 'menu'`: closing it goes back to the Menu,
   * which stays open under it). The moves come from the record's PGN and the analysis from the
   * record (the game on the board, once over, from its own plies, with every explanation). It never
   * changes the game on the board or the rating; the bot goes on playing under it, and a game that
   * ends meanwhile shows its game-over sheet once the viewer closes. A try at one of the game on the
   * board's moves ends; the explorer closes. Returns whether a game opened.
   */
  openGame(id: string, opts: { from?: 'menu' } = {}): boolean {
    const s = this.s;
    const record = s.profile.value.history.find((r) => r.id === id);
    if (!record) return false;
    this.exitDraw();
    this.exitExplorer();
    if (s.practice.value) this.dropPractice();
    this.dropViewer();
    const g = s.game.value;
    const onBoard = !!g && g.id === id && !!s.outcome.value;
    const game: ArchivedGame | null = onBoard
      ? { startFen: g.startFen, plies: s.plies.value.map((p) => ({ ...p })), startEval: s.startEval.value, headers: archivedGame(record)?.headers ?? {} }
      : archivedGame(record);
    s.viewer.value = openViewer({
      record,
      game,
      bot: onBoard ? g.bot : recordBot(record),
      session: ++this.viewerSession,
      from: opts.from ?? null,
      ...(onBoard && g.preplayed ? { preplayed: g.preplayed } : {}),
      full: onBoard,
    });
    this.viewerAbort = new AbortController();
    this.kickViewerExplain();
    return true;
  }

  /**
   * Closes the game viewer (its Back, Escape): the analysis it was running stops (what it found is
   * kept in the record), and the screen it was opened from shows again: the Menu, unless a game
   * ended meanwhile (its game-over sheet then).
   */
  closeGame(): void {
    const s = this.s;
    const v = s.viewer.value;
    if (!v) return;
    this.dropViewer();
    if (this.deferredGameOver && !s.explorer.value && !s.practice.value && !openingsOpen.peek()) {
      this.deferredGameOver = false;
      if (s.outcome.value && s.phase.value === 'over') {
        s.sheet.value = 'gameOver';
        return;
      }
    }
    if (v.from === 'menu' && s.sheet.value === null) s.sheet.value = 'menu';
  }

  /** Forgets the viewer and withdraws its analysis (saving what it found). */
  private dropViewer(): void {
    const s = this.s;
    this.viewerSession++;
    this.viewerAbort?.abort();
    this.viewerAbort = null;
    this.viewerExplainAbort?.abort();
    this.viewerExplainAbort = null;
    if (!s.viewer.value) return;
    this.saveViewerAnalysis();
    s.viewer.value = null;
  }

  private setViewer(next: GameViewer): void {
    if (next !== this.s.viewer.value) this.s.viewer.value = next;
  }

  /** Shows the position after `n` plies of the viewer's game (the move list, the graph). */
  viewerGoTo(n: number): void {
    const v = this.s.viewer.value;
    if (!v) return;
    const next = viewerAt(v, n);
    if (next === v) return;
    // Stepping to a move puts the report away for the comment on it (as in Game Review).
    this.setViewer({ ...next, report: false });
    this.kickViewerExplain();
  }

  /** One ply back or forward (‹ ›, a swipe, the arrow keys). */
  viewerStep(delta: number): void {
    const v = this.s.viewer.value;
    if (v) this.viewerGoTo(v.cursor + delta);
  }

  viewerFlip(): void {
    const v = this.s.viewer.value;
    if (v) this.setViewer({ ...v, flipped: !v.flipped });
  }

  /**
   * The viewer's Review: Game Review of the game. The report shows (accuracy, counts, key moments)
   * and the moves get their arrows and every icon; a game whose record has no verdict on some moves
   * is analyzed first, with its progress (`review.progress`), and the result is kept in the record.
   * Pressed again: the report, or the comment on the move, in turn.
   */
  viewerReview(): void {
    const v = this.s.viewer.value;
    if (!v?.game || !v.game.plies.length) return;
    this.viewerExitDraw();
    if (v.review) {
      this.setViewer({ ...v, report: !v.report });
      return;
    }
    const done = viewerAnalyzed(v);
    // No new analysis while a rated game is on (no engine help during it): it waits until it is over.
    if (!done && this.ratedGameInProgress()) return;
    this.setViewer({ ...v, report: true, review: { progress: done ? null : 0, failed: 0 } });
    if (!done) this.kickViewerAnalysis();
  }

  /** Shows the report (true) or the comment on the move (false). */
  viewerShowReport(on: boolean): void {
    const v = this.s.viewer.value;
    if (v && v.review && v.report !== on) this.setViewer({ ...v, report: on });
  }

  /** The viewer panel's actions (`viewerView.coach.actions`). */
  runViewerAction(id: ViewerActionId): void {
    const v = this.s.viewer.value;
    if (!v) return;
    switch (id) {
      case 'review':
        if (!v.review || !v.report) this.viewerReview();
        return;
      case 'tryAgain':
        if (v.cursor > 0) this.viewerTryAgain(v.cursor - 1);
        return;
      case 'showBest':
        // A move that can be tried again: its better move, from now on (and its arrow).
        if (v.cursor > 0 && !this.ratedGameInProgress() && this.entitlements.requirePro('reviewDetails')) {
          this.revealTry(v.id, v.cursor - 1);
        }
        return;
      case 'unlock':
        this.entitlements.openPaywall('reviewDetails');
        return;
      case 'retryAnalysis':
        if (this.ratedGameInProgress()) return;
        if (v.review && v.review.progress === null) {
          this.setViewer({ ...v, review: { progress: 0, failed: 0 } });
          this.kickViewerAnalysis();
        }
        return;
    }
  }

  /**
   * Try again on one of the viewer's key moments (your inaccuracies and worse; Pro, as Game Review's
   * details): the try shows on the game screen (the viewer steps aside, and the Menu under it closes)
   * and its Back returns to the viewer as it was. Returns whether it started.
   */
  viewerTryAgain(index: number): boolean {
    const s = this.s;
    const v = s.viewer.value;
    const game = v ? viewerPracticeGame(v) : null;
    if (!v || !game || this.ratedGameInProgress()) return false;
    this.viewerExitDraw();
    const sheet = s.sheet.peek();
    const ok = this.tryAgain(index, game);
    if (ok && sheet === 'menu') s.sheet.value = null;
    return ok;
  }

  /**
   * "Play from here": a new game against the same opponent from the position on the viewer's board,
   * the player's side as in the game (the opponent moves first when it is its turn), with the current
   * options and without touching the New game defaults. Unrated from the start ("Play on from
   * here"'s `GamePractice`; a rematch keeps it), and the earlier game stays in the history as it was.
   * 'inProgress' while a game the player has moved in is going on (it would count as an abandoned
   * loss); 'none' when nothing can be played there (the moves were not kept, or the game is over on
   * the board).
   */
  viewerPlayFromHere(): 'started' | 'inProgress' | 'none' {
    const s = this.s;
    const v = s.viewer.value;
    const g = v?.game;
    if (!v || !g || !this.analysis || !this.engines) return 'none';
    if (this.gameToAbandon()) return 'inProgress';
    const fen = viewerFen(v);
    try {
      if (new Chess(fen).isGameOver()) return 'none';
    } catch {
      return 'none';
    }
    const next = g.plies[v.cursor];
    const before = v.cursor > 0 ? g.plies[v.cursor - 1] : null;
    // A game without moves (resigned before the first one): nothing to play on from.
    if (!next && !before) return 'none';
    const practice: GamePractice = next ? { from: moveLabel(next) } : { from: moveLabel(before!), after: true };
    const settings: GameSettings = {
      ...s.settings.value,
      playerColor: v.record.playerColor,
      botId: v.bot.id,
      botElo: v.record.botElo,
      adaptive: false,
    };
    this.startGame(settings, fen, undefined, practice);
    return s.viewer.value ? 'none' : 'started';
  }

  /** The viewer's game as PGN: annotated when it has been analyzed ('' when its moves were not kept). */
  viewerExportPgn(): string {
    const v = this.s.viewer.value;
    if (!v) return '';
    return v.game ? archivePgn(v.record, v.game) : '';
  }

  /** The viewer's Draw toggle (its board's Draw mode; the drawings are forgotten when it closes). */
  viewerToggleDraw(): void {
    const v = this.s.viewer.value;
    if (!v?.game) return;
    if (v.draw.on) this.viewerExitDraw();
    else this.setViewer({ ...v, draw: { on: true, tip: !loadDrawTipSeen(this.storage) } });
  }

  /** Leaves the viewer's Draw mode (Done, Escape, Review, Try again). */
  viewerExitDraw(): void {
    const v = this.s.viewer.value;
    if (v && (v.draw.on || v.draw.tip)) this.setViewer({ ...v, draw: { on: false, tip: false } });
  }

  /** A drawing on the viewer's board (see `drawShape`). */
  viewerDrawShape(shape: UserShape, fen?: string): void {
    const v = this.s.viewer.value;
    if (!v?.draw.on) return;
    const board = viewerFen(v);
    if (fen !== undefined && positionKey(fen) !== positionKey(board)) return;
    if (v.draw.tip) saveDrawTipSeen(this.storage);
    this.setViewer({ ...v, drawings: drawOn(v.drawings, board, shape), draw: { on: true, tip: false } });
  }

  /** The viewer's Draw bar's Clear (the position on its board). */
  viewerClearDrawings(): void {
    const v = this.s.viewer.value;
    if (v) this.setViewer({ ...v, drawings: clearOn(v.drawings, viewerFen(v)) });
  }

  /**
   * The move shown in the viewer has only the comment the history keeps of it (`GameViewer.brief`:
   * its verdict, and a key moment's headline): the coach looks at it again, as the annotations rate
   * a move (`rateLineMove`), for the whole comment, kept with the viewer while it is open (and the
   * verdict in the record when it closes). One move at a time: stepping on withdraws the searches for
   * the previous one. Not while Game Review's details are locked, while a rated game is on (no engine
   * help during it), or while the viewer's Review analyzes the game.
   */
  private kickViewerExplain(): void {
    const s = this.s;
    const v = s.viewer.value;
    const svc = this.analysis;
    const ply = v ? briefPlyShown(v) : null;
    if (v && ply && v.explaining === ply.index && this.viewerExplainAbort) return; // on it already
    this.viewerExplainAbort?.abort();
    this.viewerExplainAbort = null;
    if (v && v.explaining !== null) this.setViewer({ ...v, explaining: null });
    if (!v?.game || !ply || !svc || this.viewerTask || s.locked.value.has('reviewDetails') || this.ratedGameInProgress()) return;
    const ctl = new AbortController();
    this.viewerExplainAbort = ctl;
    const { session, record } = v;
    const index = ply.index;
    const game = v.game;
    this.setViewer({ ...s.viewer.value!, explaining: index });
    const alive = (): boolean =>
      !ctl.signal.aborted && this.analysis === svc && s.viewer.value?.session === session && s.viewer.value.explaining === index;
    const human = ply.color === record.playerColor;
    const prev = index > 0 ? game.plies[index - 1] : undefined;
    const task: Promise<void> = this.rateLineMove(svc, {
      move: ply,
      signal: ctl.signal,
      alive,
      context: () => ({
        startFen: game.startFen,
        line: game.plies.slice(0, index + 1),
        prev,
        prevWinLoss: prev?.classification?.winLoss,
        prevBook: index === 0 || prev?.isBook === true,
        human,
        neutral: false,
        playerRating: human ? record.ratingBefore : record.botElo,
        botName: v.bot.name,
      }),
    })
      .then((r) => {
        if (!alive()) return;
        const now = s.viewer.value!;
        // Not checked (the engine): the brief comment stays, and is asked for again when the move is shown again.
        if (r === 'stale' || r === 'failed') {
          this.setViewer({ ...now, explaining: null });
          return;
        }
        this.setViewer(
          withAnalyzedPly(now, index, {
            classification: r.classification,
            explanation: r.explanation,
            evalWhite: r.evalWhite,
            evalDepth: r.evalDepth,
            isBook: r.isBook,
          }),
        );
      })
      .catch((e: unknown) => console.warn('[game] game viewer: the comment could not be written', e))
      .finally(() => {
        if (this.viewerExplainTask === task) this.viewerExplainTask = null;
        if (this.viewerExplainAbort === ctl) this.viewerExplainAbort = null;
      });
    this.viewerExplainTask = task;
  }

  private kickViewerAnalysis(): void {
    if (this.viewerTask || !this.analysis) return;
    const session = this.viewerSession;
    const task: Promise<void> = this.runViewerAnalysis(session)
      .catch((e: unknown) => {
        console.error('[game] game viewer: analysis failed', e);
        const v = this.s.viewer.value;
        if (v?.session === session && v.review) this.setViewer({ ...v, review: { ...v.review, progress: null } });
      })
      .finally(() => {
        if (this.viewerTask === task) this.viewerTask = null;
      });
    this.viewerTask = task;
  }

  /**
   * Analyzes the viewer's game where its record has no verdict (an older record, or moves whose
   * analysis failed): each move as the annotations rate a game's move (`rateLineMove`: the
   * annotations' searches, the second opinion, the classification against the previous move, the
   * explanation for the player or neutral for the opponent), in game order, one search at a time, so
   * a game in progress keeps its annotations' turn in the queue. Moves that fail are tried once more.
   * What it finds is saved in the record as it goes (every 10 moves) and at the end.
   */
  private async runViewerAnalysis(session: number): Promise<void> {
    const s = this.s;
    const svc = this.analysis;
    const signal = this.viewerAbort?.signal;
    const alive = () => this.analysis === svc && s.viewer.value?.session === session && !signal?.aborted;
    const current = (): GameViewer => s.viewer.value!;
    if (!svc || !alive() || !current().game) return;
    const progress = () => {
      const v = current();
      const g = v.game!;
      const pre = v.preplayed;
      const done = g.plies.filter((p, i) => i < pre || (p.classification && p.evalWhite)).length + (g.startEval ? 1 : 0);
      if (v.review) this.setViewer({ ...v, review: { ...v.review, progress: Math.min(0.99, done / (g.plies.length + 1)) } });
    };
    const update = (change: (g: ArchivedGame) => ArchivedGame) => {
      const v = current();
      this.setViewer({ ...v, game: change(v.game!) });
    };
    const before = current().game!;
    if (!before.startEval) {
      try {
        const r = await svc.ensure(before.startFen, { ...ANNOTATE, signal });
        if (!alive()) return;
        const sc = whiteScore(r);
        if (sc && !(r.aborted && !r.terminal && r.depth < ANNOTATE_DEPTH)) update((g) => ({ ...g, startEval: sc }));
      } catch (e) {
        console.warn('[game] game viewer: start position analysis failed', e);
        if (!alive()) return;
      }
    }
    progress();
    let failed = 0;
    let unsaved = 0;
    for (let pass = 0; pass < 2; pass++) {
      failed = 0;
      const n = current().game!.plies.length;
      for (let i = current().preplayed; i < n; i++) {
        const v = current();
        const ply = v.game!.plies[i];
        if (ply.classification && ply.evalWhite) continue;
        const pre = v.preplayed;
        // The first move after the ones the game started with: the position before it gets its eval.
        if (i === pre && pre > 0 && !v.game!.plies[pre - 1].evalWhite) {
          try {
            const r = await svc.ensure(ply.fenBefore, { ...ANNOTATE, signal });
            if (!alive()) return;
            const sc = whiteScore(r);
            if (sc) update((g) => ({ ...g, plies: g.plies.map((p, k) => (k === pre - 1 ? { ...p, evalWhite: sc, evalDepth: r.depth } : p)) }));
          } catch {
            if (!alive()) return;
          }
        }
        const record = v.record;
        const human = ply.color === record.playerColor;
        const r = await this.rateLineMove(svc, {
          move: ply,
          signal,
          alive,
          context: () => {
            const ps = current().game!.plies;
            const prev = i > 0 ? ps[i - 1] : undefined;
            return {
              startFen: current().game!.startFen,
              line: ps.slice(0, i + 1),
              prev,
              prevWinLoss: prev?.classification?.winLoss,
              prevBook: i === 0 || prev?.isBook === true,
              human,
              neutral: false,
              playerRating: human ? record.ratingBefore : record.botElo,
              botName: current().bot.name,
            };
          },
        });
        if (r === 'stale' || !alive()) return;
        if (r === 'failed') {
          failed++;
          continue;
        }
        this.setViewer(
          withAnalyzedPly(current(), i, {
            classification: r.classification,
            explanation: r.explanation,
            evalWhite: r.evalWhite,
            evalDepth: r.evalDepth,
            isBook: r.isBook,
          }),
        );
        progress();
        if (++unsaved >= 10) {
          unsaved = 0;
          this.saveViewerAnalysis();
        }
      }
      if (!failed) break;
    }
    if (!alive()) return;
    this.saveViewerAnalysis();
    const v = current();
    if (v.review) this.setViewer({ ...v, review: { progress: null, failed } });
  }

  /**
   * Keeps what the viewer knows of its game in the record (game/archive.ts `encodeAnalysis`, merged
   * with what the record has), and the player's accuracy once every move is checked (Recent games);
   * never the rating.
   */
  private saveViewerAnalysis(): void {
    const s = this.s;
    const v = s.viewer.value;
    const g = v?.game;
    if (!v || !g || !g.plies.some((p) => p.classification)) return;
    const record = s.profile.value.history.find((r) => r.id === v.id);
    if (!record) return;
    const patch: Partial<Pick<GameRecord, 'accuracy' | 'analysis'>> = {};
    // Merged: a copy that knows less than the record (the game on the board, checked meanwhile)
    // never erases a verdict.
    const encoded = encodeAnalysis(g.plies, g.startEval, { playerColor: record.playerColor, preplayed: v.preplayed });
    const analysis = mergeAnalysis(record.analysis, encoded);
    if (!sameAnalysis(record.analysis, analysis)) patch.analysis = analysis;
    if (viewerAnalyzed(v)) {
      // Every move checked: the accuracy the report shows is the record's too (Recent games, the header).
      const acc = viewerSummary(v)?.accuracy[record.playerColor];
      const rounded = acc != null ? Math.round(acc * 10) / 10 : null;
      if (rounded !== null && record.accuracy !== rounded) patch.accuracy = rounded;
    }
    if (!Object.keys(patch).length) return;
    const profile = updateGameRecord(s.profile.value, v.id, patch);
    if (profile === s.profile.value) return;
    s.profile.value = profile;
    saveProfile(profile, this.storage);
    const saved = profile.history.find((r) => r.id === v.id);
    if (saved) this.setViewer({ ...v, record: saved });
  }

  // -----------------------------------------------------------------------------------------------
  // Test / e2e support

  /**
   * Resolves once no boot, bot move (held for the coach's verdict too), background annotation,
   * review, Show best analysis, explorer analysis (ratings, Engine reply), threat probe or Try again
   * analysis is pending. For tests and e2e scripts (do not
   * await it while a bot move is blocked on purpose).
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
        ...[...this.threatProbes.values()].map((p) => p.task),
        ...this.practiceTasks,
        this.viewerTask,
        this.viewerExplainTask,
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
