/**
 * App state as signals, plus the computed view models the UI passes straight into components.
 *
 * Only the GameController writes the state signals; the UI reads the view models (e.g.
 * `store.board.value` is BoardProps minus `onMove`) and calls controller methods for input.
 * Every view model is a pure function of the state, so it can be unit-tested without an engine.
 */
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import { Chess } from 'chess.js';
import type { Arrow, Explanation, MoveClass } from '../analysis/types';
import { formatScore, resultScore, whiteBarFraction } from '../analysis/winprob';
import { personaById, customPersona, BOTS } from '../bot/personas';
import type { BotPersona } from '../bot/types';
import {
  START_FEN,
  capturedPieces,
  fenKey,
  material,
  otherColor,
  sideToMove,
  toWhitePov,
} from '../chess/utils';
import type { AnalysisResult, Score } from '../engine/types';
import { suggestedOpponentElo } from '../rating/rating';
import type { PlayerProfile } from '../rating/types';
import type { BoardProps } from '../ui/Board';
import type { CoachPanelProps } from '../ui/CoachPanel';
import type { EvalBarProps } from '../ui/EvalBar';
import type { EvalGraphProps } from '../ui/EvalGraph';
import type { MoveListProps } from '../ui/MoveList';
import type { PlayerStripProps } from '../ui/PlayerStrip';
import type { ReviewPanelProps } from '../ui/ReviewPanel';
import {
  KEY_CLASSES,
  RETRY_CLASSES,
  TOP_CLASSES,
  answerFreeLines,
  classLabel,
  classSentence,
  coachTip,
  moveLabel,
} from './coach';
import type { ReviewSummary } from './review';
import { DEFAULT_SETTINGS, type Color, type GameOutcome, type GameSettings, type Ply } from './types';

// -------------------------------------------------------------------------------------------------
// State

/** Screen phase. 'setup' = no game yet (NewGameSheet); 'over' = finished game, not reviewing. */
export type Phase = 'boot' | 'error' | 'setup' | 'playing' | 'over' | 'review';
export type SheetName = 'new' | 'menu' | 'gameOver' | 'assist';
export type EngineMode = 'dual' | 'single';

/** Help that makes a rated game unrated; the first use in a rated game asks for confirmation. */
export type AssistKind = 'hint' | 'undo' | 'retry';

/** An assist waiting for the player's confirmation (the 'assist' sheet). */
export interface PendingAssist {
  kind: AssistKind;
  /** Retry: the human ply to take back. */
  index?: number;
}

/** Depth below which the live eval is shown as "still thinking". */
export const SHALLOW_DEPTH = 12;

export interface AppError {
  message: string;
  /** What the user can do about it. */
  advice: string;
  /** Technical detail (for a disclosure / the console). */
  detail?: string;
}

/** The game being played (or just finished / reviewed). */
export interface GameInfo {
  id: string;
  startFen: string;
  /** Resolved colour of the human. */
  playerColor: Color;
  bot: BotPersona;
  botElo: number;
  /** ISO timestamp. */
  startedAt: string;
  /** Takebacks, hints or best-move arrows were used: the game will not be rated. */
  assisted: boolean;
  /**
   * Settings the game was started with (colour resolved). A rematch keeps its opponent and colour;
   * the assistance options come from the current settings.
   */
  settings: GameSettings;
}

export interface RatingChange {
  before: number;
  after: number;
  rated: boolean;
}

/** What the coach panel is doing (besides the phase defaults). */
export type CoachMode =
  | { kind: 'idle' }
  /** Feedback on the human's ply `index` (busy until it is annotated). */
  | { kind: 'feedback'; index: number }
  /** A hint for `fen` (explanation null while analysing). `prev` is restored when dismissed. */
  | { kind: 'hint'; fen: string; explanation: Explanation | null; prev: CoachMode }
  /** Previewing the best move instead of ply `index` (the board shows the position before it). */
  | {
      kind: 'showBest';
      index: number;
      bestUci: string | null;
      bestSan: string | null;
      lines: string[];
      /** View index to return to on "Back" (null = live). */
      returnTo: number | null;
      prev: CoachMode;
    }
  /** The human took back a bad move via "Retry". */
  | { kind: 'retry'; san: string; cls: MoveClass; headline: string | null };

/** Review data (null progress = complete). */
export interface ReviewState extends ReviewSummary {
  progress: number | null;
}

/** Latest live analysis of the watched position. */
export interface LiveAnalysis {
  key: string;
  result: AnalysisResult;
}

/** Writable state signals (the controller owns them). */
export interface AppState {
  phase: Signal<Phase>;
  error: Signal<AppError | null>;
  engineMode: Signal<EngineMode | null>;
  settings: Signal<GameSettings>;
  profile: Signal<PlayerProfile>;
  game: Signal<GameInfo | null>;
  plies: Signal<Ply[]>;
  /** White-POV eval of the start position, when known. */
  startEval: Signal<Score | null>;
  /** Number of plies shown on the board; null = live (follows new moves). */
  viewIndex: Signal<number | null>;
  flipped: Signal<boolean>;
  botThinking: Signal<boolean>;
  outcome: Signal<GameOutcome | null>;
  ratingChange: Signal<RatingChange | null>;
  sheet: Signal<SheetName | null>;
  live: Signal<LiveAnalysis | null>;
  coachMode: Signal<CoachMode>;
  /** User override of the coach panel's collapsed state (null = automatic). */
  coachCollapsed: Signal<boolean | null>;
  reviewState: Signal<ReviewState | null>;
  /** Help waiting for confirmation because it would make a rated game unrated. */
  pendingAssist: Signal<PendingAssist | null>;
  /** `annotationKey`s of plies whose analysis failed (the coach offers to try again). */
  failedAnnotations: Signal<ReadonlySet<string>>;
}

// -------------------------------------------------------------------------------------------------
// View models

export type BoardView = Omit<BoardProps, 'onMove'>;

export interface EvalBarView extends EvalBarProps {
  /** False when the eval bar is switched off (settings.showEvalBar) during play. */
  visible: boolean;
  /** Depth of the shown eval (0 = unknown). */
  depth: number;
}

export interface EvalGraphView extends Omit<EvalGraphProps, 'onSelect' | 'height' | 'minSpan'> {
  visible: boolean;
}

export type MoveListView = Omit<MoveListProps, 'onSelect'> & { iconSet: 'notable' | 'all' };

export type CoachActionId =
  | 'showBest'
  | 'retry'
  | 'backToGame'
  | 'dismissHint'
  | 'review'
  | 'newGame'
  | 'rematch'
  | 'retryBoot'
  | 'retryAnalysis';

export interface CoachActionView {
  id: CoachActionId;
  label: string;
  primary?: boolean;
}

/** What the panel shows: 'coach' feedback, a 'hint', 'minimal' (coach off), 'review', or 'status'. */
export type CoachViewKind = 'coach' | 'hint' | 'minimal' | 'review' | 'status';

export interface CoachView extends Omit<CoachPanelProps, 'actions' | 'onToggleCollapsed' | 'collapsed'> {
  busy: boolean;
  collapsed: boolean;
  actions: CoachActionView[];
  kind: CoachViewKind;
}

export type ToolbarId =
  | 'newGame'
  | 'undo'
  | 'hint'
  | 'flip'
  | 'coach'
  | 'menu'
  | 'prev'
  | 'next'
  | 'review'
  | 'resign'
  | 'exportPgn';

export interface ToolState {
  disabled: boolean;
  /** Toggle state (coach on, hint shown, reviewing). */
  active?: boolean;
}

export type ToolbarView = Record<ToolbarId, ToolState>;

export interface SheetsView {
  open: SheetName | null;
  newGame: {
    initial: GameSettings;
    playerRating: number;
    bots: BotPersona[];
    /** A game the human has moved in is still going: starting another ends it (a loss unless unrated). */
    inProgress: { rated: boolean } | null;
  };
  /** The unrated-help confirmation (null unless one is pending). */
  assist: { kind: AssistKind } | null;
  menu: { settings: GameSettings; profile: PlayerProfile; canResign: boolean };
  /** Null until a game has finished. */
  gameOver: {
    outcome: GameOutcome;
    playerColor: Color;
    botName: string;
    botEmoji: string;
    botColor: string;
    botElo: number;
    ratingChange?: RatingChange;
  } | null;
}

export type ReviewView = Omit<ReviewPanelProps, 'onSelectPly' | 'onClose'>;

/** Facts about the displayed position (memoised per FEN). */
export interface PositionInfo {
  fen: string;
  turn: Color;
  check: boolean;
  terminal: 'checkmate' | 'stalemate' | null;
  /** Legal moves grouped by origin square. */
  dests: Map<string, string[]>;
}

export interface GameSummaryView {
  id: string;
  playerColor: Color;
  botName: string;
  botElo: number;
  assisted: boolean;
  /** Opening of the displayed position (walks back to the last named one). */
  opening: { eco: string; name: string } | null;
}

/** Everything the UI reads. */
export interface Store extends AppState {
  /** FEN after the last ply (the game's current position). */
  liveFen: ReadonlySignal<string>;
  /** Number of plies shown on the board (viewIndex ?? plies.length). */
  current: ReadonlySignal<number>;
  /** The board follows the game (not browsing history or previewing). */
  isLive: ReadonlySignal<boolean>;
  displayedFen: ReadonlySignal<string>;
  position: ReadonlySignal<PositionInfo>;
  /** It is the human's turn in the live game, and they may move now. */
  humanToMove: ReadonlySignal<boolean>;
  gameSummary: ReadonlySignal<GameSummaryView | null>;
  board: ReadonlySignal<BoardView>;
  evalBar: ReadonlySignal<EvalBarView>;
  evalGraph: ReadonlySignal<EvalGraphView>;
  moveList: ReadonlySignal<MoveListView>;
  coach: ReadonlySignal<CoachView>;
  topPlayer: ReadonlySignal<PlayerStripProps>;
  bottomPlayer: ReadonlySignal<PlayerStripProps>;
  toolbar: ReadonlySignal<ToolbarView>;
  sheets: ReadonlySignal<SheetsView>;
  /** ReviewPanel props (minus handlers) while reviewing, else null. */
  review: ReadonlySignal<ReviewView | null>;
}

/** The store as the UI should see it: every signal read-only. */
export type ReadonlyStore = {
  readonly [K in keyof Store]: Store[K] extends Signal<infer T> ? ReadonlySignal<T> : Store[K];
};

// -------------------------------------------------------------------------------------------------
// Helpers (pure)

const HUMAN_EMOJI = '🙂';
/** Shared empty values, so unchanged view models keep their identity (fewer chessground updates). */
const NO_DESTS: Map<string, string[]> = new Map();
const NO_ARROWS: Arrow[] = [];

/** Identifies one ply of one game (move and position), e.g. for failed analyses. */
export function annotationKey(gameId: string, p: Pick<Ply, 'index' | 'fenBefore' | 'uci'>): string {
  return `${gameId}|${p.index}|${p.fenBefore}|${p.uci}`;
}

/** Legal-move map, check and game-over state of a FEN (never throws). */
export function positionInfo(fen: string): PositionInfo {
  const dests = new Map<string, string[]>();
  try {
    const chess = new Chess(fen);
    for (const m of chess.moves({ verbose: true })) {
      const list = dests.get(m.from);
      if (list) {
        if (!list.includes(m.to)) list.push(m.to);
      } else dests.set(m.from, [m.to]);
    }
    const check = chess.inCheck();
    const terminal = dests.size === 0 ? (check ? 'checkmate' : 'stalemate') : null;
    return { fen, turn: chess.turn(), check, terminal, dests };
  } catch {
    return { fen, turn: sideToMove(fen), check: false, terminal: null, dests };
  }
}

/** The persona the settings describe (adaptive = custom opponent at the suggested Elo). */
export function personaForSettings(s: GameSettings, profile: PlayerProfile): BotPersona {
  if (s.adaptive) return customPersona(suggestedOpponentElo(profile));
  const p = s.botId === 'custom' ? undefined : personaById(s.botId);
  return p ?? customPersona(s.botElo);
}

/** UCI -> arrow. */
export function uciArrow(uci: string | null | undefined, brush: Arrow['brush']): Arrow[] {
  if (!uci || uci.length < 4) return [];
  return [{ from: uci.slice(0, 2), to: uci.slice(2, 4), brush }];
}

/** Arrows for the top MultiPV lines: 'best' for #1, 'alt' for the rest (deduplicated). */
export function lineArrows(result: AnalysisResult, max = 3): Arrow[] {
  const out: Arrow[] = [];
  const seen = new Set<string>();
  for (const [i, line] of result.lines.slice(0, max).entries()) {
    const uci = line.pv[0];
    if (!uci || seen.has(uci.slice(0, 4))) continue;
    seen.add(uci.slice(0, 4));
    out.push(...uciArrow(uci, i === 0 ? 'best' : 'alt'));
  }
  return out;
}

/** White-POV score of an analysis result (null when nothing is known). */
export function whiteScore(result: AnalysisResult): Score | null {
  const s = resultScore(result);
  return s ? toWhitePov(s, result.fen) : null;
}

/** Bar fraction for a White-POV eval of a position (resolves a finished mate from the FEN). */
export function winForWhite(scoreWhite: Score, fen: string): number {
  return whiteBarFraction(scoreWhite, sideToMove(fen));
}

// -------------------------------------------------------------------------------------------------
// Store

/** Creates the state signals with their initial values. */
export function createState(init: { settings?: GameSettings; profile: PlayerProfile }): AppState {
  return {
    phase: signal<Phase>('boot'),
    error: signal<AppError | null>(null),
    engineMode: signal<EngineMode | null>(null),
    settings: signal<GameSettings>(init.settings ?? { ...DEFAULT_SETTINGS }),
    profile: signal<PlayerProfile>(init.profile),
    game: signal<GameInfo | null>(null),
    plies: signal<Ply[]>([]),
    startEval: signal<Score | null>(null),
    viewIndex: signal<number | null>(null),
    flipped: signal(false),
    botThinking: signal(false),
    outcome: signal<GameOutcome | null>(null),
    ratingChange: signal<RatingChange | null>(null),
    sheet: signal<SheetName | null>(null),
    live: signal<LiveAnalysis | null>(null),
    coachMode: signal<CoachMode>({ kind: 'idle' }),
    coachCollapsed: signal<boolean | null>(null),
    reviewState: signal<ReviewState | null>(null),
    pendingAssist: signal<PendingAssist | null>(null),
    failedAnnotations: signal<ReadonlySet<string>>(new Set()),
  };
}

/** Adds the computed view models to a state. */
export function createStore(state: AppState): Store {
  const { phase, settings, profile, game, plies, viewIndex, flipped, botThinking, outcome, live, coachMode } = state;

  const liveFen = computed(() => plies.value.at(-1)?.fenAfter ?? game.value?.startFen ?? START_FEN);
  const current = computed(() => {
    const n = plies.value.length;
    const v = viewIndex.value;
    return v === null ? n : Math.max(0, Math.min(n, v));
  });
  const isLive = computed(() => viewIndex.value === null);
  const displayedFen = computed(() => {
    const k = current.value;
    return k === 0 ? (game.value?.startFen ?? START_FEN) : plies.value[k - 1].fenAfter;
  });
  const position = computed(() => positionInfo(displayedFen.value));
  const liveTurn = computed(() => sideToMove(liveFen.value));

  const humanToMove = computed(
    () =>
      phase.value === 'playing' &&
      !outcome.value &&
      !!game.value &&
      liveTurn.value === game.value.playerColor &&
      !botThinking.value,
  );

  const humanColor = computed<Color>(() => {
    const g = game.value;
    if (g) return g.playerColor;
    return settings.value.playerColor === 'b' ? 'b' : 'w';
  });

  const orientation = computed<'white' | 'black'>(() => {
    const white = humanColor.value === 'w';
    return white !== flipped.value ? 'white' : 'black';
  });

  /** The ply whose result is on the board (null at the start position). */
  const displayedPly = computed(() => (current.value > 0 ? plies.value[current.value - 1] : null));

  const opening = computed(() => {
    const k = current.value;
    return k > 0 ? (plies.value[k - 1].opening ?? null) : null;
  });

  const liveForDisplayed = computed(() => {
    const l = live.value;
    return l && l.key === fenKey(displayedFen.value) ? l.result : null;
  });

  const inReviewLike = computed(() => phase.value === 'review' || phase.value === 'over');

  // --- board ---------------------------------------------------------------------------------
  const arrows = computed<Arrow[]>(() => {
    const m = coachMode.value;
    if (m.kind === 'showBest') {
      const ply = plies.value[m.index];
      if (!ply) return NO_ARROWS;
      return [...uciArrow(ply.uci, 'played'), ...uciArrow(m.bestUci, 'best')];
    }
    if (m.kind === 'hint' && isLive.value && m.fen === liveFen.value) {
      const e = m.explanation;
      return e?.arrows?.length ? e.arrows : NO_ARROWS;
    }
    if (phase.value === 'review') {
      const ply = displayedPly.value;
      const best = ply?.classification?.bestMoveUci;
      if (ply && best && best !== ply.uci && !TOP_CLASSES.has(ply.classification!.cls)) return uciArrow(best, 'best');
      return NO_ARROWS;
    }
    if (settings.value.showBestMoves && humanToMove.value && isLive.value) {
      const r = liveForDisplayed.value;
      return r ? lineArrows(r) : NO_ARROWS;
    }
    return NO_ARROWS;
  });

  const badge = computed<BoardView['badge']>(() => {
    const m = coachMode.value;
    if (m.kind === 'showBest') return undefined;
    if (m.kind === 'feedback' && phase.value === 'playing' && isLive.value && settings.value.coach) {
      // The verdict on your last move stays on its square after the bot's reply (unless the reply
      // landed there), until your next move.
      const fb = plies.value[m.index];
      const cls = fb?.classification?.cls;
      if (!fb || !cls) return undefined;
      const square = fb.uci.slice(2, 4);
      if (plies.value[m.index + 1]?.uci.slice(2, 4) === square) return undefined;
      return { square, cls };
    }
    const ply = displayedPly.value;
    const cls = ply?.classification?.cls;
    if (!ply || !cls) return undefined;
    const show =
      inReviewLike.value || (phase.value === 'playing' && settings.value.coach && ply.color === game.value?.playerColor);
    return show ? { square: ply.uci.slice(2, 4), cls } : undefined;
  });

  const board = computed<BoardView>(() => {
    const pos = position.value;
    const movable = humanToMove.value && isLive.value && coachMode.value.kind !== 'showBest';
    const ply = displayedPly.value;
    const view: BoardView = {
      fen: displayedFen.value,
      orientation: orientation.value,
      dests: movable ? pos.dests : NO_DESTS,
      check: pos.check,
      arrows: arrows.value,
    };
    if (movable) view.movableColor = game.value!.playerColor === 'w' ? 'white' : 'black';
    if (ply) view.lastMove = [ply.uci.slice(0, 2), ply.uci.slice(2, 4)];
    const b = badge.value;
    if (b) view.badge = b;
    return view;
  });

  // --- eval bar & graph ------------------------------------------------------------------------
  const evalsVisible = computed(
    () => settings.value.showEvalBar || phase.value === 'over' || phase.value === 'review',
  );

  const evalBar = computed<EvalBarView>(() => {
    const fen = displayedFen.value;
    const pos = position.value;
    let score: Score | null = null;
    let depth = 0;
    const r = liveForDisplayed.value;
    if (r) {
      score = whiteScore(r);
      depth = r.depth;
    }
    const k = current.value;
    // A drawn game's final position is 0.0, whatever the engine (which does not see repetitions) says.
    const o = outcome.value;
    const drawnEnd = !!o && o.winner === null && k === plies.value.length;
    if (!score) {
      const known = k > 0 ? plies.value[k - 1] : null;
      if (known?.evalWhite) {
        score = known.evalWhite;
        depth = known.evalDepth ?? 0;
      } else if (k === 0 && state.startEval.value) {
        score = state.startEval.value;
        depth = SHALLOW_DEPTH;
      }
    }
    const final = !!pos.terminal || drawnEnd;
    if (pos.terminal) {
      score = pos.terminal === 'checkmate' ? { kind: 'mate', value: 0 } : { kind: 'cp', value: 0 };
      score = toWhitePov(score, fen);
    } else if (drawnEnd) {
      score = { kind: 'cp', value: 0 };
    }
    if (!score) {
      // Unknown yet: keep the nearest earlier eval (bar and number, pulsing) so neither jumps
      // back to 50% / blank after every move.
      for (let i = k - 1; i >= 0 && !score; i--) {
        const e = i > 0 ? plies.value[i - 1].evalWhite : state.startEval.value;
        if (e) score = e;
      }
      const whiteWinProb = score ? whiteBarFraction(score) : 0.5;
      const thinking = phase.value === 'playing' || phase.value === 'over' || phase.value === 'review';
      const label = score ? formatScore(score) : '';
      return { visible: evalsVisible.value, whiteWinProb, label, orientation: orientation.value, thinking, depth: 0 };
    }
    return {
      visible: evalsVisible.value,
      whiteWinProb: whiteBarFraction(score, pos.turn),
      label: formatScore(score, pos.turn),
      orientation: orientation.value,
      thinking: !final && depth < SHALLOW_DEPTH,
      depth: final ? 0 : depth,
    };
  });

  /** Classifications visible during play: only the human's moves (the review shows all). */
  const showsClass = (p: Ply): boolean => phase.value !== 'playing' || p.color === game.value?.playerColor;

  const evalGraph = computed<EvalGraphView>(() => {
    const ps = plies.value;
    const g = game.value;
    const l = live.value;
    const liveWin = (fen: string): number | null => {
      if (!l || l.key !== fenKey(fen)) return null;
      const s = whiteScore(l.result);
      return s ? winForWhite(s, fen) : null;
    };
    const startFen = g?.startFen ?? START_FEN;
    const start = state.startEval.value;
    const points: (number | null)[] = [start ? winForWhite(start, startFen) : liveWin(startFen)];
    for (const p of ps) points.push(p.evalWhite ? winForWhite(p.evalWhite, p.fenAfter) : liveWin(p.fenAfter));
    const o = outcome.value;
    if (o && o.winner === null) points[points.length - 1] = 0.5;
    const markers = ps
      .filter((p) => p.classification && KEY_CLASSES.has(p.classification.cls) && showsClass(p))
      .map((p) => ({ index: p.index + 1, cls: p.classification!.cls }));
    return { visible: evalsVisible.value, points, current: current.value, markers };
  });

  // --- move list -------------------------------------------------------------------------------
  const moveList = computed<MoveListView>(() => {
    const review = phase.value === 'review';
    const ps = phase.value === 'playing' ? plies.value.map((p) => (showsClass(p) ? p : stripClass(p))) : plies.value;
    return {
      plies: ps,
      current: current.value,
      showClassIcons: settings.value.coach || inReviewLike.value,
      iconSet: review ? 'all' : 'notable',
    };
  });

  // --- coach -------------------------------------------------------------------------------------
  const coach = computed<CoachView>(() => {
    const view = coachContent();
    const auto = view.kind === 'minimal';
    return { ...view, collapsed: state.coachCollapsed.value ?? auto };
  });

  function coachContent(): Omit<CoachView, 'collapsed'> {
    const status = (title: string, lines: string[], actions: CoachActionView[] = [], busy = false) => ({
      kind: 'status' as const,
      title,
      lines,
      actions,
      busy,
    });
    switch (phase.value) {
      case 'boot':
        return status('Starting the engine…', [], [], true);
      case 'error': {
        const e = state.error.value;
        return status(
          e?.message ?? 'The engine could not start.',
          [e?.advice ?? 'Something went wrong.'],
          [{ id: 'retryBoot', label: 'Try again', primary: true }],
        );
      }
      case 'setup':
        return status('Ready when you are', ['Pick an opponent and a color to start a game.'], [
          { id: 'newGame', label: 'New game', primary: true },
        ]);
      case 'review':
        return reviewCoach();
      case 'over':
        return current.value < plies.value.length || coachMode.value.kind === 'showBest' ? reviewCoach() : overCoach();
      case 'playing':
        return playingCoach();
    }
  }

  function overCoach(): Omit<CoachView, 'collapsed'> {
    const o = outcome.value;
    const g = game.value;
    const human = g?.playerColor ?? 'w';
    const title = !o || o.winner === null ? 'Draw' : o.winner === human ? 'You won!' : 'You lost';
    const lines = [o ? `${o.reason}.` : 'The game is over.', 'Review the game to see where it was won and lost.'];
    return {
      kind: 'status',
      title,
      lines,
      busy: false,
      actions: [
        { id: 'review', label: 'Game review', primary: true },
        { id: 'rematch', label: 'Rematch' },
        { id: 'newGame', label: 'New game' },
      ],
    };
  }

  function showBestCoach(m: Extract<CoachMode, { kind: 'showBest' }>): Omit<CoachView, 'collapsed'> {
    const ply = plies.value[m.index];
    const actions: CoachActionView[] = [{ id: 'backToGame', label: phase.value === 'playing' ? 'Back to game' : 'Back', primary: true }];
    if (ply && canRetry(ply)) actions.push({ id: 'retry', label: 'Retry' });
    return {
      kind: phase.value === 'playing' ? 'coach' : 'review',
      cls: 'best',
      title: m.bestSan ? `Best was ${m.bestSan}` : 'Best move',
      lines: m.lines,
      busy: false,
      actions,
    };
  }

  function canRetry(ply: Ply): boolean {
    const cls = ply.classification?.cls;
    return (
      phase.value === 'playing' &&
      !outcome.value &&
      settings.value.allowTakebacks &&
      ply.color === game.value?.playerColor &&
      !!cls &&
      RETRY_CLASSES.has(cls)
    );
  }

  function reviewCoach(): Omit<CoachView, 'collapsed'> {
    const m = coachMode.value;
    if (m.kind === 'showBest') return showBestCoach(m);
    const ply = displayedPly.value;
    if (!ply) {
      return {
        kind: 'review',
        title: 'Start position',
        lines: ['Step through the game, or tap a key moment to jump to it.'],
        busy: false,
        actions: [],
      };
    }
    const cl = ply.classification;
    if (!cl) {
      if (analysisFailed(ply)) {
        return {
          kind: 'review',
          title: moveLabel(ply),
          lines: ['This move could not be analyzed.'],
          busy: false,
          actions: [{ id: 'retryAnalysis', label: 'Try again', primary: true }],
        };
      }
      return { kind: 'review', title: moveLabel(ply), lines: [], busy: true, actions: [] };
    }
    const lines = explanationLines(ply.explanation, cl.bestMoveSan && !TOP_CLASSES.has(cl.cls) ? `Best was ${cl.bestMoveSan}.` : null);
    const actions: CoachActionView[] =
      !TOP_CLASSES.has(cl.cls) && cl.bestMoveUci && cl.bestMoveUci !== ply.uci ? [{ id: 'showBest', label: 'Show best' }] : [];
    return { kind: 'review', cls: cl.cls, title: classSentence(moveLabel(ply), cl.cls), lines, busy: false, actions };
  }

  function playingCoach(): Omit<CoachView, 'collapsed'> {
    const m = coachMode.value;
    const g = game.value!;
    const s = settings.value;
    if (m.kind === 'hint') {
      return {
        kind: 'hint',
        title: 'Hint',
        lines: m.explanation ? explanationLines(m.explanation) : [],
        busy: !m.explanation,
        actions: m.explanation ? [{ id: 'dismissHint', label: 'Got it' }] : [],
      };
    }
    if (m.kind === 'showBest') return showBestCoach(m);
    if (!isLive.value) {
      // Browsing history during the game.
      const ply = displayedPly.value;
      const back: CoachActionView[] = [{ id: 'backToGame', label: 'Back to game', primary: true }];
      if (ply && s.coach && ply.color === g.playerColor && ply.classification) {
        const cl = ply.classification;
        // The move the coach is discussing may still be retried: keep its answer hidden here too.
        const hide = m.kind === 'feedback' && m.index === ply.index && canRetry(ply);
        return {
          kind: 'coach',
          cls: cl.cls,
          title: classSentence(moveLabel(ply), cl.cls),
          lines: hide ? answerFreeLines(ply.explanation, cl) : explanationLines(ply.explanation),
          busy: false,
          actions: back,
        };
      }
      return {
        kind: 'status',
        title: ply ? `Viewing ${moveLabel(ply)}` : 'Viewing the start position',
        lines: ['The board is paused here. Go back to the game to keep playing.'],
        busy: false,
        actions: back,
      };
    }
    if (!s.coach) return minimalCoach();
    if (m.kind === 'retry') {
      const lines = [`Find a better move than ${m.san}.`];
      if (m.headline) lines.push(m.headline);
      return { kind: 'coach', title: 'Try again', lines, busy: false, actions: [] };
    }
    if (m.kind === 'feedback') {
      const ply = plies.value[m.index];
      if (ply) {
        const cl = ply.classification;
        if (!cl || !ply.explanation) {
          if (analysisFailed(ply)) {
            return {
              kind: 'coach',
              title: `Couldn’t check ${ply.san}`,
              lines: ['The engine did not finish analyzing this move.'],
              busy: false,
              actions: [{ id: 'retryAnalysis', label: 'Try again', primary: true }],
            };
          }
          return { kind: 'coach', title: `Checking ${ply.san}…`, lines: [], busy: true, actions: [] };
        }
        const retry = canRetry(ply);
        // While Retry is on offer, the text must not give the better move away ("Show best" does).
        const lines = retry ? answerFreeLines(ply.explanation, cl) : explanationLines(ply.explanation);
        const reply = plies.value[m.index + 1];
        const rc = reply?.classification?.cls;
        // Pointing out the bot's mistake is a live hint, so only in games that are unrated anyway.
        if (g.assisted && reply && rc && (rc === 'mistake' || rc === 'blunder')) {
          lines.push(`${g.bot.name}’s ${reply.san} was a ${classLabel(rc).toLowerCase()}. Look for a way to punish it!`);
        }
        const actions: CoachActionView[] = [];
        // In a rated game Retry costs the rating, so the free "Show best" is the main action.
        if (!TOP_CLASSES.has(cl.cls) && cl.bestMoveUci) actions.push({ id: 'showBest', label: 'Show best', primary: !g.assisted });
        if (retry) actions.push({ id: 'retry', label: 'Retry', primary: g.assisted });
        if (!actions.some((a) => a.primary) && actions.length) actions[0] = { ...actions[0], primary: true };
        return { kind: 'coach', cls: cl.cls, title: classSentence(moveLabel(ply), cl.cls), lines, busy: false, actions };
      }
    }
    return idleCoach();
  }

  function idleCoach(): Omit<CoachView, 'collapsed'> {
    const g = game.value!;
    const ps = plies.value;
    if (!humanTurnLive()) {
      return {
        kind: 'coach',
        title: `${g.bot.name} is thinking…`,
        lines: ps.length === 0 ? [`“${g.bot.greeting}”`] : [],
        busy: false,
        actions: [],
      };
    }
    const lines: string[] = [];
    if (ps.length === 0) lines.push(`${g.bot.name}: “${g.bot.greeting}”`);
    const o = ps.at(-1)?.opening;
    if (o) lines.push(`Opening: ${o.name}`);
    lines.push(coachTip(liveFen.value, ps.length, position.value.check));
    return { kind: 'coach', title: 'Your move', lines, busy: false, actions: [] };
  }

  function minimalCoach(): Omit<CoachView, 'collapsed'> {
    const g = game.value!;
    const last = plies.value.at(-1);
    const o = last?.opening;
    const title = o ? o.name : humanTurnLive() ? 'Your move' : `${g.bot.name} is thinking…`;
    const lines = last ? [`${last.color === g.playerColor ? 'You' : g.bot.name} played ${moveLabel(last)}.`] : [];
    return { kind: 'minimal', title, lines, busy: false, actions: [] };
  }

  function analysisFailed(ply: Ply): boolean {
    const g = game.value;
    return !!g && state.failedAnnotations.value.has(annotationKey(g.id, ply));
  }

  function humanTurnLive(): boolean {
    const g = game.value;
    return !!g && liveTurn.value === g.playerColor && !botThinking.value;
  }

  // --- players -----------------------------------------------------------------------------------
  const players = computed(() => {
    const g = game.value;
    const human = humanColor.value;
    const bot: BotPersona = g?.bot ?? personaForSettings(settings.value, profile.value);
    const botElo = g?.botElo ?? bot.elo;
    const fen = displayedFen.value;
    const captured = capturedPieces(fen);
    const mat = material(fen);
    const turn = position.value.turn;
    const playing = phase.value === 'playing';
    const strip = (c: Color, isHuman: boolean): PlayerStripProps => ({
      name: isHuman ? 'You' : bot.name,
      rating: isHuman ? profile.value.rating : botElo,
      emoji: isHuman ? HUMAN_EMOJI : bot.emoji,
      ...(isHuman ? {} : { avatarColor: bot.color }),
      captured: captured[c],
      capturedColor: otherColor(c),
      materialDiff: Math.max(0, mat[c] - mat[otherColor(c)]),
      active: playing && !!g && turn === c,
      thinking: !isHuman && botThinking.value,
      ...(isHuman && g?.assisted ? { unrated: true } : {}),
    });
    const humanStrip = strip(human, true);
    const botStrip = strip(otherColor(human), false);
    return flipped.value ? { top: humanStrip, bottom: botStrip } : { top: botStrip, bottom: humanStrip };
  });
  const topPlayer = computed(() => players.value.top);
  const bottomPlayer = computed(() => players.value.bottom);

  // --- toolbar -----------------------------------------------------------------------------------
  const toolbar = computed<ToolbarView>(() => {
    const p = phase.value;
    const booting = p === 'boot' || p === 'error';
    const playing = p === 'playing' && !outcome.value;
    const g = game.value;
    const hasHumanPly = !!g && plies.value.some((x) => x.color === g.playerColor);
    const m = coachMode.value;
    return {
      newGame: { disabled: booting },
      undo: { disabled: !(playing && settings.value.allowTakebacks && hasHumanPly) },
      hint: {
        disabled: !(humanToMove.value && isLive.value && m.kind !== 'showBest'),
        active: m.kind === 'hint',
      },
      flip: { disabled: p === 'boot' },
      coach: { disabled: p === 'boot', active: settings.value.coach },
      menu: { disabled: p === 'boot' },
      prev: { disabled: !g || current.value === 0 || m.kind === 'showBest' },
      next: { disabled: !g || isLive.value || m.kind === 'showBest' },
      review: { disabled: !(p === 'over' || p === 'review'), active: p === 'review' },
      resign: { disabled: !playing },
      exportPgn: { disabled: !g || plies.value.length === 0 },
    };
  });

  // --- sheets ------------------------------------------------------------------------------------
  const sheets = computed<SheetsView>(() => {
    const g = game.value;
    const o = outcome.value;
    const rc = state.ratingChange.value;
    const inProgress =
      g && phase.value === 'playing' && !o && plies.value.some((p) => p.color === g.playerColor)
        ? { rated: !g.assisted }
        : null;
    const pending = state.pendingAssist.value;
    return {
      open: state.sheet.value,
      newGame: { initial: settings.value, playerRating: profile.value.rating, bots: BOTS, inProgress },
      assist: pending ? { kind: pending.kind } : null,
      menu: {
        settings: settings.value,
        profile: profile.value,
        canResign: phase.value === 'playing' && !o,
      },
      gameOver:
        g && o
          ? {
              outcome: o,
              playerColor: g.playerColor,
              botName: g.bot.name,
              botEmoji: g.bot.emoji,
              botColor: g.bot.color,
              botElo: g.botElo,
              ...(rc ? { ratingChange: rc } : {}),
            }
          : null,
    };
  });

  // --- review ------------------------------------------------------------------------------------
  const review = computed<ReviewView | null>(() => {
    const r = state.reviewState.value;
    const g = game.value;
    if (phase.value !== 'review' || !r || !g) return null;
    const botName = g.bot.name;
    return {
      progress: r.progress,
      accuracy: r.accuracy,
      counts: r.counts,
      playerColor: g.playerColor,
      names: g.playerColor === 'w' ? { w: 'You', b: botName } : { w: botName, b: 'You' },
      keyMoments: r.keyMoments,
    };
  });

  const gameSummary = computed<GameSummaryView | null>(() => {
    const g = game.value;
    if (!g) return null;
    return {
      id: g.id,
      playerColor: g.playerColor,
      botName: g.bot.name,
      botElo: g.botElo,
      assisted: g.assisted,
      opening: opening.value ?? plies.value.at(-1)?.opening ?? null,
    };
  });

  return {
    ...state,
    liveFen,
    current,
    isLive,
    displayedFen,
    position,
    humanToMove,
    gameSummary,
    board,
    evalBar,
    evalGraph,
    moveList,
    coach,
    topPlayer,
    bottomPlayer,
    toolbar,
    sheets,
    review,
  };
}

/** [headline, ...details] of an explanation, plus an optional extra line. */
function explanationLines(e: Explanation | undefined | null, extra?: string | null): string[] {
  const lines = e ? [e.headline, ...e.details] : [];
  if (extra && !lines.some((l) => l.includes(extra.replace(/\.$/, '')))) lines.push(extra);
  return lines;
}

function stripClass(p: Ply): Ply {
  if (!p.classification) return p;
  const { classification: _c, ...rest } = p;
  return rest;
}
