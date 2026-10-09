/**
 * App state as signals, plus the computed view models the UI passes straight into components.
 *
 * Only the GameController writes the state signals; the UI reads the view models (e.g.
 * `store.board.value` is BoardProps minus `onMove`) and calls controller methods for input.
 * Every view model is a pure function of the state, so it can be unit-tested without an engine.
 */
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import { Chess } from 'chess.js';
import { BOOK_REASON } from '../analysis/explain';
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
  uciToSan,
} from '../chess/utils';
import type { AnalysisResult, Score } from '../engine/types';
import { suggestedOpponentElo } from '../rating/rating';
import type { PlayerProfile } from '../rating/types';
import type { BoardProps } from '../ui/Board';
import type { CoachOther, CoachPanelProps } from '../ui/CoachPanel';
import type { EvalBarProps } from '../ui/EvalBar';
import type { EvalGraphProps } from '../ui/EvalGraph';
import type { MoveListProps } from '../ui/MoveList';
import type { PlayerStripProps } from '../ui/PlayerStrip';
import type { ReviewPanelProps } from '../ui/ReviewPanel';
import {
  KEY_CLASSES,
  RETRY_CLASSES,
  TOP_CLASSES,
  UNLOCK_LABEL,
  answerFreeLines,
  classLabel,
  coachTip,
  concession,
  lockedTeaser,
  mentionsMove,
  moveLabel,
  offersShowBest,
  recaptureTip,
  verdictTitle,
} from './coach';
import { DRAW_COLORS, NO_DRAWINGS, NO_SHAPES, shapesAt, type DrawColor, type Drawings } from './drawings';
import type { ProFeature } from './entitlements';
import { currentMove, drawReason, explorerFen, type DrawReason, type Explorer, type ExplorerMove } from './explorer';
import { lineMoveNumber, lineMoves, lineProgress, type LineMove, type LineStatus, type OpeningTarget } from './opening';
import type { ReviewSummary } from './review';
import { DEFAULT_SETTINGS, type Color, type GameOutcome, type GameSettings, type Ply } from './types';

// -------------------------------------------------------------------------------------------------
// State

/** Screen phase. 'setup' = no game yet (NewGameSheet); 'over' = finished game, not reviewing. */
export type Phase = 'boot' | 'error' | 'setup' | 'playing' | 'over' | 'review';
export type SheetName = 'new' | 'menu' | 'gameOver' | 'assist';
export type EngineMode = 'dual' | 'single';

/**
 * Help that makes a rated game unrated; the first use in a rated game asks for confirmation.
 * 'exploreEngine' is switching the engine on in the explorer (exploring without it is free help).
 */
export type AssistKind = 'hint' | 'undo' | 'retry' | 'exploreEngine' | 'rateOpponent';

/** Whose move the coach's feedback is about during play: yours, or the opponent's (`rateOpponent`). */
export type CoachSubject = 'you' | 'opponent';

/** The player picked the feedback the coach panel expands, while the game had `at` plies. */
export interface CoachFocus {
  subject: CoachSubject;
  at: number;
}

/** An assist waiting for the player's confirmation (the 'assist' sheet). */
export interface PendingAssist {
  kind: AssistKind;
  /** Retry: the human ply to take back. */
  index?: number;
}

/** Depth below which the live eval is shown as "still thinking". */
export const SHALLOW_DEPTH = 12;

/** The explorer panel's line while its engine is off (the game's status may follow it). */
export const EXPLORER_ENGINE_OFF = 'Engine off: try moves for both sides.';
/** …and the tip under it. */
export const EXPLORER_ENGINE_OFF_TIP = 'Tap a piece to see where it can go. Back and Forward step through your line.';

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
  /**
   * Takebacks, hints, Retry, the engine in the explorer, best-move arrows or the opponent's move
   * ratings were used: the game will not be rated.
   */
  assisted: boolean;
  /**
   * Settings the game was started with (colour resolved). A rematch keeps its opponent and colour;
   * the assistance options come from the current settings.
   */
  settings: GameSettings;
  /** Opening practice: the line this game follows (see game/opening.ts). A rematch keeps it. */
  opening?: OpeningTarget;
  /**
   * The first `preplayed` plies were played before the game started (opening practice 'skip'):
   * book moves (classification 'book'), not analyzed by the engine, not counted for accuracy, and
   * never taken back. Absent = 0.
   */
  preplayed?: number;
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
      /**
       * The engine lines of the position were not at hand: `lines` is what the saved explanation
       * says, and the best move's explanation is on its way (the panel shows busy).
       */
      pending?: boolean;
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
  /** Download progress (0..1) of the analysis engine's `.wasm` while booting; null when not reported. */
  engineDownload: Signal<number | null>;
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
  /**
   * The feedback the player expanded when both their move and the opponent's are rated (null, or
   * `at` not the game's ply count: the panel's own pick, see `playingCoach`).
   */
  coachFocus: Signal<CoachFocus | null>;
  reviewState: Signal<ReviewState | null>;
  /** Help waiting for confirmation because it would make a rated game unrated. */
  pendingAssist: Signal<PendingAssist | null>;
  /**
   * The explorer (game/explorer.ts) while the player tries moves from a position of the game, else
   * null. The game itself is never changed by it; it is not saved.
   */
  explorer: Signal<Explorer | null>;
  /**
   * The engine is on in the explorer (its switch): the eval bar, arrows, "Best here", the explored
   * moves' ratings and Reply. Off, the explorer shows nothing from the engine about its positions.
   * Set when the explorer opens: off during a game in progress (unless it was switched on in this
   * game before), on after the game and in the review (when allowed, Pro).
   */
  explorerEngine: Signal<boolean>;
  /** The explorer draws the engine's top moves as arrows (its own toggle; default on). */
  explorerArrows: Signal<boolean>;
  /** The explorer's "Engine reply" is waiting for the analysis of its position. */
  explorerReplying: Signal<boolean>;
  /** `annotationKey`s of plies whose analysis failed (the coach offers to try again). */
  failedAnnotations: Signal<ReadonlySet<string>>;
  /**
   * Draw mode: the board takes the player's arrows and circles instead of moves (free, and never
   * help: drawing does not change the rating). Ends with Done, Escape, a sheet, the explorer
   * opening or closing, a new game, the game's end, and the actions that make or take back moves.
   */
  drawMode: Signal<boolean>;
  /** The color Draw mode draws in (the Draw bar's swatches; kept for the session). */
  drawColor: Signal<DrawColor>;
  /**
   * The player's drawings by position (game/drawings.ts `positionKey`) in this game session: the
   * game's positions, the explorer's and the review's share them. In memory only; a new game (or
   * the restore of another one) clears them.
   */
  drawings: Signal<Drawings>;
  /** The first-use tip under the Draw bar is showing ("Drag between squares for an arrow…"). */
  drawTip: Signal<boolean>;
  /**
   * Pro features that are locked (game/entitlements.ts; empty where Pro is not sold or is
   * unlocked). The view models never show what they would reveal: explanations, hints, the best
   * move, best-move arrows, the review's key moments.
   */
  locked: ReadonlySignal<ReadonlySet<ProFeature>>;
}

// -------------------------------------------------------------------------------------------------
// View models

export type BoardView = Omit<BoardProps, 'onMove' | 'onDraw'>;
/** A classification icon on a square of the board. */
export type BoardBadge = NonNullable<BoardProps['badge']>;

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
  | 'retryAnalysis'
  /** Opens the paywall for the action's `feature` (the coach's text is locked). */
  | 'unlock'
  /**
   * Opening practice: not a button of the actions row but the banner at the top of the panel
   * ("Italian Game · Move 3 of 5"); its label is the line's name, the status and the tone ('on',
   * 'done', 'off'), separated by tabs (ui/OpeningBanner.tsx `openingBannerOf`). Opens the line in
   * the Openings section.
   */
  | 'opening';

export interface CoachActionView {
  id: CoachActionId;
  label: string;
  primary?: boolean;
  /** A Pro feature that is locked: the button shows a lock and opens the paywall instead. */
  locked?: boolean;
  /** 'unlock': the feature the paywall is opened for. */
  feature?: ProFeature;
}

/** What the panel shows: 'coach' feedback, a 'hint', 'minimal' (coach off), 'review', or 'status'. */
export type CoachViewKind = 'coach' | 'hint' | 'minimal' | 'review' | 'status';

/** The other rated move as one compact row of the coach panel (CoachPanel `other`, minus its handler). */
export interface CoachOtherView extends Omit<CoachOther, 'onSelect'> {
  /** `selectCoachFeedback(subject)` expands it. */
  subject: CoachSubject;
}

export interface CoachView extends Omit<CoachPanelProps, 'actions' | 'onToggleCollapsed' | 'collapsed' | 'other'> {
  busy: boolean;
  collapsed: boolean;
  actions: CoachActionView[];
  kind: CoachViewKind;
  /** The game ply the verdict is about (Show best shows the better move for it). */
  index?: number;
  /** Whose move the verdict is about during play. */
  subject?: CoachSubject;
  /** Your move and the opponent's are both rated: the one not expanded, as a compact row. */
  other?: CoachOtherView;
  /**
   * The panel has a row more than the coach alone: the game rates both your moves and the
   * opponent's (coach and `rateOpponent` on), so it shows two of them from the opponent's first move
   * on (whether or not `other` is there yet), or it is an opening-practice game with its banner. The
   * app gives it a little more height before it collapses to one row.
   */
  paired: boolean;
}

/** A coach view before its collapsed state and pairing are added (the store's coach builders). */
type CoachContent = Omit<CoachView, 'collapsed' | 'paired'>;

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
  | 'exportPgn'
  /** Opens the explorer on the position on the board (free; its engine is Pro). */
  | 'explore'
  /** The explorer's toolbar (its ‹ and › are 'prev' and 'next'). */
  | 'explorerReset'
  | 'explorerReply'
  | 'explorerExit';

export interface ToolState {
  disabled: boolean;
  /** Toggle state (coach on, hint shown, reviewing). */
  active?: boolean;
  /** A Pro feature that is locked (Hint): the button shows a lock and opens the paywall. */
  locked?: boolean;
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
    /** No games played yet: the sheet offers a starting level ("Your level"). */
    newPlayer: boolean;
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
    /** Opening practice: the line's name ("Opening practice: Italian Game" on the sheet). */
    practice?: string;
  } | null;
}

export type ReviewView = Omit<ReviewPanelProps, 'onSelectPly' | 'onClose' | 'onUnlock'>;

/**
 * The explorer panel's buttons: commit the first move to the game, the arrows toggle, a failed
 * rating's retry, and the Engine switch (`ExplorerPanelView.engine`).
 */
export type ExplorerActionId = 'play' | 'arrows' | 'retryRating' | 'engine';

export interface ExplorerActionView {
  id: ExplorerActionId;
  label: string;
  primary?: boolean;
  /** A toggle's state (the arrows). */
  pressed?: boolean;
}

/** What the explorer panel shows (in the coach's place) while exploring. */
export interface ExplorerPanelView {
  /** The game's move before the explorer's starting position ("15… Nf6"), or null for the start position. */
  from: string | null;
  /** The explored move on the board ("16. Nf3"), or whose move it is at the starting position ("White to move"). */
  title: string;
  /** The Engine switch: on or off, and locked (Pro) while the engine in the explorer is. */
  engine: { on: boolean; locked: boolean };
  /** The move's verdict ("Excellent"), "Checking…" while it is analyzed, or null (always, with the engine off). */
  verdict: string | null;
  /** Its class icon (none for a move that gives something away, see coach.ts `concession`). */
  cls?: MoveClass;
  /** The evaluation after the move ("+0.4"), once rated. */
  evalLabel: string | null;
  busy: boolean;
  /** The move's explanation (Pro: coach explanations), or a short instruction (what the engine being off means). */
  lines: string[];
  /**
   * "Best here: Bd3 (+0.6)" for the side to move (engine on), or how the game ended there
   * ("Checkmate: White wins.", also with the engine off: the rules, not the engine, say so).
   */
  best: string | null;
  /** What happened in the real game meanwhile ("Pip played 15… Nf6 in your game."). */
  notice: string | null;
  /** The same, short, for the collapsed panel's row ("Pip played 15… Nf6 in your game"). */
  noticeShort: string | null;
  /** The notice is that the bot is still thinking in the game. */
  noticeBusy: boolean;
  actions: ExplorerActionView[];
}

/** Draw mode's toggle and bar (while a game is on the board: playing, finished or in review). */
export interface DrawView {
  /** Draw mode is on: the bar (colors, Clear, Done) shows in the toggle's place. */
  on: boolean;
  color: DrawColor;
  colors: readonly DrawColor[];
  /** The position on the board has drawings (Clear has something to clear). */
  canClear: boolean;
  /** The first-use tip (`DRAW_TIP`), until the first drawing on the device. */
  tip: boolean;
  /**
   * Draw mode is on over the live game and it is the player's move (the board would take a move
   * after Done): the bar shows the turn dot the strip under it would.
   */
  yourMove: boolean;
}

/** Facts about the displayed position (memoised per FEN). */
export interface PositionInfo {
  fen: string;
  turn: Color;
  check: boolean;
  terminal: 'checkmate' | 'stalemate' | null;
  /** Legal moves grouped by origin square. */
  dests: Map<string, string[]>;
}

/** Opening practice (`store.openingPractice`): the line the game follows and where the game stands on it. */
export interface OpeningPracticeView {
  lineId: string;
  /** The line's full name ("Italian Game: Two Knights Defense"). */
  name: string;
  /** Its family ("Italian Game"). */
  family: string;
  eco: string;
  mode: OpeningTarget['mode'];
  showLineMoves: boolean;
  /** Of the live game (not the move being viewed). */
  status: LineStatus;
  /** The line's length in moves (a move = White's and Black's: "1. e4 e5" is move 1). */
  moves: number;
  /** The line's move the game is at (1-based; `moves` once complete). */
  move: number;
  /** On the line: its next move ("3. Bc4"), whoever plays it. */
  nextMove?: LineMove;
  /** The game left the line: the move that left it ("3. Nc3"), who played it, and the line's move there. */
  leftAt?: { index: number; label: string; by: 'you' | 'opponent'; expected: LineMove };
  /** Complete: the index of the ply that reached the line's end. */
  completedAt?: number;
  /** The banner's status: "Move 3 of 5", "Line complete", "Left at 3. Nc3". */
  statusText: string;
  /** The same as one sentence: "Opening practice: Italian Game — on the line (move 3 of 5)". */
  summary: string;
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
  /** The explorer's position (null when not exploring). */
  explorerPosition: ReadonlySignal<PositionInfo | null>;
  /**
   * Why the explorer's position is drawn as the game would be there (a third repetition, the
   * 50-move rule, too little material), else null: like checkmate and stalemate, no more moves.
   */
  explorerDraw: ReadonlySignal<DrawReason | null>;
  /**
   * The first explored move when "Play" may commit it to the game (else null): the explorer started
   * from the live position, nothing was played in the game since, and it is the human's turn.
   */
  explorerPlayable: ReadonlySignal<ExplorerMove | null>;
  /** The explorer panel (in the coach panel's place) while exploring, else null. */
  explorerPanel: ReadonlySignal<ExplorerPanelView | null>;
  /** Opening practice: the line the game follows and the game's place on it; null in a normal game. */
  openingPractice: ReadonlySignal<OpeningPracticeView | null>;
  /** Draw mode's toggle and bar; null when no game is on the board. */
  draw: ReadonlySignal<DrawView | null>;
}

/** The store as the UI should see it: every signal read-only. */
export type ReadonlyStore = {
  readonly [K in keyof Store]: Store[K] extends Signal<infer T> ? ReadonlySignal<T> : Store[K];
};

// -------------------------------------------------------------------------------------------------
// Helpers (pure)

const HUMAN_EMOJI = '🙂';
/** A stored eval (White's point of view) and the depth behind it. */
interface KnownEval {
  score: Score;
  depth: number;
}

/** Shared empty values, so unchanged view models keep their identity (fewer chessground updates). */
const NO_DESTS: Map<string, string[]> = new Map();
const NO_ARROWS: Arrow[] = [];
const NONE_LOCKED: ReadonlySet<ProFeature> = new Set();
/** What "book" means, for a beginner (opening practice says it once). */
const BOOK_MEANING = 'A “book” move is a well-known opening move that players have studied for years.';
/** Your move's classes that keep its feedback expanded when the opponent's is rated too. */
const ATTENTION_CLASSES: ReadonlySet<MoveClass> = new Set<MoveClass>(['inaccuracy', 'mistake', 'miss', 'blunder']);

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

/** Colour of the piece on `square` (e.g. "e4") in a FEN, or null when the square is empty. */
export function pieceColorAt(fen: string, square: string): Color | null {
  const file = square.charCodeAt(0) - 97;
  const row = fen.split(' ')[0].split('/')[8 - Number(square[1])];
  if (!row || file < 0 || file > 7) return null;
  let f = 0;
  for (const ch of row) {
    if (ch >= '1' && ch <= '8') f += Number(ch);
    else if (f++ === file) return ch === ch.toUpperCase() ? 'w' : 'b';
    if (f > file) return null;
  }
  return null;
}

/** A brand-new player: no rated games counted and nothing in the history. */
export function isNewPlayer(p: PlayerProfile): boolean {
  return p.gamesPlayed === 0 && p.history.length === 0;
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
export function createState(init: {
  settings?: GameSettings;
  profile: PlayerProfile;
  /** Locked Pro features (default: none). */
  locked?: ReadonlySignal<ReadonlySet<ProFeature>>;
}): AppState {
  return {
    phase: signal<Phase>('boot'),
    error: signal<AppError | null>(null),
    engineMode: signal<EngineMode | null>(null),
    engineDownload: signal<number | null>(null),
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
    coachFocus: signal<CoachFocus | null>(null),
    reviewState: signal<ReviewState | null>(null),
    pendingAssist: signal<PendingAssist | null>(null),
    explorer: signal<Explorer | null>(null),
    explorerEngine: signal(false),
    explorerArrows: signal(true),
    explorerReplying: signal(false),
    failedAnnotations: signal<ReadonlySet<string>>(new Set()),
    drawMode: signal(false),
    drawColor: signal<DrawColor>(DRAW_COLORS[0]),
    drawings: signal<Drawings>(NO_DRAWINGS),
    drawTip: signal(false),
    locked: init.locked ?? signal(NONE_LOCKED),
  };
}

/** Adds the computed view models to a state. */
export function createStore(state: AppState): Store {
  const { phase, settings, profile, game, plies, viewIndex, flipped, botThinking, outcome, live, coachMode, explorer } = state;

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

  /** A Pro feature is locked (tracks `state.locked`). */
  const locked = (f: ProFeature): boolean => state.locked.value.has(f);

  /**
   * The opponent's moves are rated during play (`settings.rateOpponent`), in a game that does not
   * count for the rating: the ratings reveal the computer's mistakes, so a rated game never shows
   * them (the controller makes a game with them unrated).
   */
  const ratesOpponent = computed(() => settings.value.rateOpponent && !!game.value?.assisted);

  /** Plies the game started with (opening practice 'skip': played before it, never analyzed). */
  const preplayed = computed(() => game.value?.preplayed ?? 0);

  /** The human has moved in this game (the moves it started with do not count). */
  const humanMoved = computed(() => {
    const g = game.value;
    const pre = preplayed.value;
    return !!g && plies.value.some((p) => p.index >= pre && p.color === g.playerColor);
  });

  /** The opponent's most recent move in the game (null before it has moved). */
  const lastBotPly = computed<Ply | null>(() => {
    const g = game.value;
    const ps = plies.value;
    const pre = preplayed.value;
    for (let i = ps.length - 1; i >= pre && i >= ps.length - 2; i--) if (g && ps[i].color !== g.playerColor) return ps[i];
    return null;
  });

  // --- opening practice --------------------------------------------------------------------------
  const openingPractice = computed<OpeningPracticeView | null>(() => {
    const g = game.value;
    const o = g?.opening;
    if (!g || !o) return null;
    const { line } = o;
    const ps = plies.value;
    const p = lineProgress(line, g.startFen, ps);
    const moves = lineMoves(line);
    const move = p.status === 'complete' ? moves : lineMoveNumber(p.reached);
    const view: OpeningPracticeView = {
      lineId: line.id,
      name: line.name,
      family: line.family,
      eco: line.eco,
      mode: o.mode,
      showLineMoves: o.showLineMoves,
      status: p.status,
      moves,
      move,
      statusText: '',
      summary: '',
    };
    if (p.next) view.nextMove = p.next;
    if (p.completedAt !== null) view.completedAt = p.completedAt;
    const leftPly = p.left ? ps[p.left.index] : undefined;
    if (p.left && leftPly) {
      const by = leftPly.color === g.playerColor ? 'you' : 'opponent';
      view.leftAt = { index: p.left.index, label: moveLabel(leftPly), by, expected: p.left.expected };
    }
    if (p.status === 'on-line') {
      view.statusText = `Move ${move} of ${moves}`;
      view.summary = `Opening practice: ${line.name} — on the line (move ${move} of ${moves})`;
    } else if (p.status === 'complete') {
      view.statusText = 'Line complete';
      view.summary = `Opening practice: ${line.name} — line complete, you’re on your own now`;
    } else {
      const where = view.leftAt?.label;
      view.statusText = where ? `Left at ${where}` : 'Off the line';
      view.summary = `Opening practice: ${line.name} — ${where ? `left the line at ${where}` : 'off the line'}`;
    }
    return view;
  });

  /**
   * What the coach says about the opening during play, each said once (until your next move): the
   * line's next move on your turn (`showLineMoves`), who left the line and where, that the line is
   * complete (or set up, 'skip'), and at the start that the bot follows the line.
   */
  const practiceNotes = computed<string[]>(() => {
    const v = openingPractice.value;
    const g = game.value;
    if (!v || !g || phase.value !== 'playing' || outcome.value) return [];
    const ps = plies.value;
    const pre = preplayed.value;
    // News until the human's next move.
    const news = (index: number): boolean => !ps.some((p) => p.index > index && p.index >= pre && p.color === g.playerColor);
    const notes: string[] = [];
    // A move label never breaks after its number ("2.\u00a0Nf3").
    const move = (label: string): string => label.replace(' ', '\u00a0');
    if (v.status === 'left' && v.leftAt && news(v.leftAt.index)) {
      const who = v.leftAt.by === 'you' ? 'You' : g.bot.name;
      notes.push(
        `${who} left the line at ${move(v.leftAt.label)} (the line continues ${move(v.leftAt.expected.label)}) — the game goes on normally.`,
      );
    } else if (v.status === 'complete' && v.completedAt !== undefined && news(v.completedAt)) {
      notes.push(
        v.completedAt < pre
          ? `The moves of the ${v.name} line are on the board. You’re on your own from here!`
          : `Line complete: that was the last move of the ${v.name} line. You’re on your own now!`,
      );
    } else if (v.status === 'on-line') {
      const yours = v.nextMove?.color === g.playerColor;
      if (v.showLineMoves && v.nextMove && yours) {
        const warn = v.nextMove.dubious ? ' (a known mistake: this line shows how it gets punished)' : '';
        notes.push(`Line move: ${move(v.nextMove.label)} — ${v.family}${warn}`);
      }
      // Only 'steer' follows the line ('skip' set it up; a mate line stops short, see the controller).
      if (!humanMoved.value && v.mode === 'steer') {
        notes.push(
          v.showLineMoves
            ? `The arrow shows the line’s next move. ${g.bot.name} follows the line as long as you do.`
            : `${g.bot.name} follows the ${v.family} line as long as you do.`,
        );
      }
    }
    return notes;
  });

  /** On your turn on the line (`showLineMoves`): the line's next move as a light arrow. */
  const lineGuide = computed<Arrow[]>(() => {
    const v = openingPractice.value;
    const g = game.value;
    if (!v?.showLineMoves || v.status !== 'on-line' || !v.nextMove || v.nextMove.color !== g?.playerColor) return NO_ARROWS;
    return uciArrow(v.nextMove.uci, 'line');
  });

  // --- explorer ----------------------------------------------------------------------------------
  const exploredFen = computed(() => {
    const x = explorer.value;
    return x ? explorerFen(x) : null;
  });
  const explorerPosition = computed(() => {
    const fen = exploredFen.value;
    return fen === null ? null : positionInfo(fen);
  });
  const explorerDraw = computed<DrawReason | null>(() => {
    const x = explorer.value;
    const g = game.value;
    return x && g ? drawReason(x, g.startFen, plies.value) : null;
  });
  /**
   * The engine is on in the open explorer (its switch, and allowed: Pro). Off, nothing the engine
   * knows about an explored position shows (not even an analysis of the same position the game's
   * watch, or the cache, already has).
   */
  const explorerEngineOn = computed(() => !!explorer.value && state.explorerEngine.value && !locked('explorerEngine'));
  /** Live analysis of the explorer's position (the controller watches it while its engine is on). */
  const liveForExplorer = computed(() => {
    const l = live.value;
    const fen = exploredFen.value;
    return explorerEngineOn.value && l && fen !== null && l.key === fenKey(fen) ? l.result : null;
  });
  /** The game ply that led to the explorer's starting position (null at the game's start). */
  const explorerBasePly = computed(() => {
    const x = explorer.value;
    return x && x.baseIndex > 0 ? (plies.value[x.baseIndex - 1] ?? null) : null;
  });

  // --- board ---------------------------------------------------------------------------------
  // Locked Pro features draw no arrow at all: an arrow would give the best move away.
  const arrows = computed<Arrow[]>(() => {
    if (explorer.value) {
      // The engine's top moves for the side to move in the explorer (its engine on, and its own toggle).
      const r = liveForExplorer.value;
      return r && explorerEngineOn.value && state.explorerArrows.value && !explorerDraw.value ? lineArrows(r) : NO_ARROWS;
    }
    const m = coachMode.value;
    if (m.kind === 'showBest') {
      const ply = plies.value[m.index];
      if (!ply || locked('showBest')) return NO_ARROWS;
      return [...uciArrow(ply.uci, 'played'), ...uciArrow(m.bestUci, 'best')];
    }
    if (m.kind === 'hint' && isLive.value && m.fen === liveFen.value) {
      const e = m.explanation;
      return e?.arrows?.length && !locked('hint') ? e.arrows : NO_ARROWS;
    }
    if (phase.value === 'review') {
      const ply = displayedPly.value;
      const cl = ply?.classification;
      if (ply && cl && offersShowBest(cl, ply.uci) && !locked('reviewDetails')) return uciArrow(cl.bestMoveUci, 'best');
      return NO_ARROWS;
    }
    // Opening practice: the line's next move, under the best-move arrows when they are on.
    const guide = phase.value === 'playing' && humanToMove.value && isLive.value ? lineGuide.value : NO_ARROWS;
    if (settings.value.showBestMoves && !locked('bestMoveArrows') && humanToMove.value && isLive.value) {
      const r = liveForDisplayed.value;
      return r ? [...guide, ...lineArrows(r)] : guide;
    }
    return guide;
  });

  /** During play, a move's rating shows when it is yours with the coach on, or the opponent's while they are rated. */
  const ratedDuringPlay = (p: Ply): boolean =>
    p.color === game.value?.playerColor ? settings.value.coach : ratesOpponent.value;

  /** A ply's verdict badge on its destination; none for a move whose text says what it gives away (see `concession`). */
  const plyBadge = (p: Ply | null | undefined): BoardBadge | undefined => {
    const cls = p?.classification?.cls;
    return p && cls && !concession(p) ? { square: p.uci.slice(2, 4), cls } : undefined;
  };

  /**
   * The board's badge (on the last move, whose squares it tints), and during play the other rated
   * move's (`extra`): your last move's, while the opponent's reply has the badge.
   */
  const badges = computed<{ main?: BoardBadge; extra?: BoardBadge }>(() => {
    const x = explorer.value;
    if (x) {
      // The verdict on the explored move that is on the board (with the explorer's engine on).
      const mv = currentMove(x);
      const r = mv?.rating;
      if (!mv || !r || concession(r) || !explorerEngineOn.value) return {};
      return { main: { square: mv.uci.slice(2, 4), cls: r.classification.cls } };
    }
    const m = coachMode.value;
    if (m.kind === 'showBest') return {};
    if (phase.value === 'playing' && isLive.value) {
      // The opponent's move just played, while its moves are rated.
      const bot = lastBotPly.value;
      const theirs = ratesOpponent.value && bot && bot.index === plies.value.length - 1 ? plyBadge(bot) : undefined;
      if (m.kind === 'feedback' && settings.value.coach) {
        // The verdict on your last move stays on its square after the bot's reply (unless the reply
        // took the piece there, also en passant), until your next move.
        const fb = plies.value[m.index];
        let mine = plyBadge(fb);
        if (mine && m.index < plies.value.length - 1 && pieceColorAt(liveFen.value, mine.square) !== fb.color) mine = undefined;
        return theirs ? { main: theirs, extra: mine } : { main: mine };
      }
      if (theirs) return { main: theirs };
    }
    const ply = displayedPly.value;
    const b = plyBadge(ply);
    if (!ply || !b) return {};
    const show = inReviewLike.value || (phase.value === 'playing' && ratedDuringPlay(ply));
    return show ? { main: b } : {};
  });


  // --- draw mode ---------------------------------------------------------------------------------
  /** A game is on the board (in progress, finished or in review): Draw mode is offered. */
  const drawAvailable = computed(() => {
    const p = phase.value;
    return !!game.value && (p === 'playing' || p === 'over' || p === 'review');
  });
  /** The color Draw mode draws in on the board, while it is on. */
  const drawingColor = computed(() => (state.drawMode.value && drawAvailable.value ? state.drawColor.value : null));
  /** The player's drawings on a position (and Draw mode), for the board's view. */
  const withDrawings = (view: BoardView): BoardView => {
    const shapes = shapesAt(state.drawings.value, view.fen);
    if (shapes !== NO_SHAPES) view.shapes = shapes;
    const color = drawingColor.value;
    if (color) view.drawColor = color;
    return view;
  };

  const board = computed<BoardView>(() => {
    const x = explorer.value;
    const xpos = explorerPosition.value;
    if (x && xpos) {
      // Exploring: either side may move, from the explorer's position (not once it is drawn).
      const mv = currentMove(x);
      const last = mv ?? explorerBasePly.value;
      const dests = explorerDraw.value ? NO_DESTS : xpos.dests;
      const view: BoardView = {
        fen: xpos.fen,
        orientation: orientation.value,
        dests,
        check: xpos.check,
        arrows: arrows.value,
        session: `explorer:${x.session ?? 0}`,
      };
      if (dests.size) view.movableColor = xpos.turn === 'w' ? 'white' : 'black';
      if (last) view.lastMove = [last.uci.slice(0, 2), last.uci.slice(2, 4)];
      const b = badges.value.main;
      if (b) view.badge = b;
      return withDrawings(view);
    }
    const pos = position.value;
    const movable = humanToMove.value && isLive.value && coachMode.value.kind !== 'showBest';
    const ply = displayedPly.value;
    const view: BoardView = {
      fen: displayedFen.value,
      orientation: orientation.value,
      dests: movable ? pos.dests : NO_DESTS,
      check: pos.check,
      arrows: arrows.value,
      session: 'game',
    };
    if (movable) view.movableColor = game.value!.playerColor === 'w' ? 'white' : 'black';
    if (ply) view.lastMove = [ply.uci.slice(0, 2), ply.uci.slice(2, 4)];
    const b = badges.value;
    if (b.main) view.badge = b.main;
    if (b.extra) view.extraBadges = [b.extra];
    return withDrawings(view);
  });

  const draw = computed<DrawView | null>(() => {
    if (!drawAvailable.value) return null;
    const on = state.drawMode.value;
    return {
      on,
      color: state.drawColor.value,
      colors: DRAW_COLORS,
      canClear: shapesAt(state.drawings.value, board.value.fen).length > 0,
      tip: on && state.drawTip.value,
      yourMove: on && !explorer.value && humanToMove.value && isLive.value,
    };
  });

  // --- eval bar & graph ------------------------------------------------------------------------
  const evalsVisible = computed(
    () => settings.value.showEvalBar || phase.value === 'over' || phase.value === 'review',
  );

  /** The eval stored for the position after `k` plies of the game (the start position's for 0). */
  const knownAt = (k: number): KnownEval | null => {
    if (k > 0) {
      const p = plies.value[k - 1];
      return p?.evalWhite ? { score: p.evalWhite, depth: p.evalDepth ?? 0 } : null;
    }
    const start = state.startEval.value;
    return start ? { score: start, depth: SHALLOW_DEPTH } : null;
  };

  /** The nearest stored eval before the position after `k` plies. */
  const earlierThan = (k: number): Score | null => {
    for (let i = k - 1; i >= 0; i--) {
      const e = knownAt(i);
      if (e) return e.score;
    }
    return null;
  };

  /**
   * The bar for `fen`: the live analysis when it is there, else the stored eval (`known`); a final
   * position (`pos.terminal`, or `drawn`) is exact. With nothing known, the nearest earlier eval
   * (`earlier`) stays on the bar, pulsing, so neither the bar nor the number jumps back to 50% /
   * blank after every move.
   */
  function barFor(
    fen: string,
    pos: PositionInfo,
    r: AnalysisResult | null,
    known: KnownEval | null,
    earlier: () => Score | null,
    drawn: boolean,
    visible: boolean,
  ): EvalBarView {
    let score: Score | null = null;
    let depth = 0;
    // The search finished (at its depth, or at its node budget in a position where the next
    // iteration takes millions of nodes): nothing deeper is coming, so the bar stops pulsing.
    let finished = false;
    if (r) {
      score = whiteScore(r);
      depth = r.depth;
      finished = !!score && r.done;
    }
    if (!score && known) {
      score = known.score;
      depth = known.depth;
    }
    const final = !!pos.terminal || drawn;
    if (pos.terminal) {
      score = pos.terminal === 'checkmate' ? { kind: 'mate', value: 0 } : { kind: 'cp', value: 0 };
      score = toWhitePov(score, fen);
    } else if (drawn) {
      score = { kind: 'cp', value: 0 };
    }
    if (!score) {
      score = earlier();
      const whiteWinProb = score ? whiteBarFraction(score) : 0.5;
      const thinking = phase.value === 'playing' || phase.value === 'over' || phase.value === 'review';
      const label = score ? formatScore(score) : '';
      return { visible, whiteWinProb, label, orientation: orientation.value, thinking, depth: 0 };
    }
    return {
      visible,
      whiteWinProb: whiteBarFraction(score, pos.turn),
      label: formatScore(score, pos.turn),
      orientation: orientation.value,
      thinking: !final && !finished && depth < SHALLOW_DEPTH,
      depth: final ? 0 : depth,
    };
  }

  const evalBar = computed<EvalBarView>(() => {
    const x = explorer.value;
    const xpos = explorerPosition.value;
    if (x && xpos) {
      if (!explorerEngineOn.value) {
        // Engine off: a neutral bar that says so where the game's bar was (never the game's eval
        // next to another board), so the board keeps its size.
        return { visible: evalsVisible.value, off: true, whiteWinProb: 0.5, label: '', orientation: orientation.value, depth: 0 };
      }
      // Exploring with the engine: the explorer's position (the bar shows even when it is off for the game).
      const rated = (n: number): KnownEval | null => {
        if (n === 0) return knownAt(x.baseIndex);
        const r = x.moves[n - 1].rating;
        return r ? { score: r.evalWhite, depth: r.evalDepth } : null;
      };
      const earlier = () => {
        for (let n = x.cursor - 1; n >= 0; n--) {
          const e = rated(n);
          if (e) return e.score;
        }
        return earlierThan(x.baseIndex);
      };
      // A drawn position is 0.0, whatever the engine (which does not see repetitions) says.
      return barFor(xpos.fen, xpos, liveForExplorer.value, rated(x.cursor), earlier, !!explorerDraw.value, true);
    }
    const k = current.value;
    // A drawn game's final position is 0.0, whatever the engine (which does not see repetitions) says.
    const o = outcome.value;
    const drawnEnd = !!o && o.winner === null && k === plies.value.length;
    const earlier = () => earlierThan(k);
    return barFor(displayedFen.value, position.value, liveForDisplayed.value, knownAt(k), earlier, drawnEnd, evalsVisible.value);
  });

  /**
   * Classifications visible on the graph during play: the human's moves, and the opponent's while
   * they are rated (the finished game and the review show all).
   */
  const showsClass = (p: Ply): boolean =>
    phase.value !== 'playing' || p.color === game.value?.playerColor || ratesOpponent.value;

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
  /** The explored line as plies for the move list (indices within the line), with their verdicts (engine on). */
  const explorerPlies = computed<Ply[] | null>(() => {
    const x = explorer.value;
    if (!x) return null;
    const rated = explorerEngineOn.value;
    return x.moves.map((m, index) => {
      const p: Ply = { index, color: m.color, san: m.san, uci: m.uci, fenBefore: m.fenBefore, fenAfter: m.fenAfter };
      // Like the board badge: no icon for a move that gives something away.
      if (rated && m.rating && !concession(m.rating)) p.classification = m.rating.classification;
      return p;
    });
  });

  const moveList = computed<MoveListView>(() => {
    const x = explorer.value;
    const xplies = explorerPlies.value;
    if (x && xplies) {
      // The explored line, after a chip for its starting position ("From 15… Nf6").
      const base = explorerBasePly.value;
      return {
        plies: xplies,
        current: x.cursor,
        showClassIcons: explorerEngineOn.value,
        iconSet: 'all',
        lead: base ? `From ${moveLabel(base)}` : 'From the start',
        emptyText: 'Try a move for either side',
      };
    }
    const review = phase.value === 'review';
    const playing = phase.value === 'playing';
    // Like the board badge: no class icon (nor class in the label) for a move that gives something
    // away; during play only your moves with the coach on, and the opponent's while they are rated.
    const ps = plies.value.map((p) => ((!playing || ratedDuringPlay(p)) && !concession(p) ? p : stripClass(p)));
    return {
      plies: ps,
      current: current.value,
      showClassIcons: settings.value.coach || ratesOpponent.value || inReviewLike.value,
      iconSet: review ? 'all' : 'notable',
    };
  });

  // --- coach -------------------------------------------------------------------------------------
  const coach = computed<CoachView>(() => {
    const view = coachContent();
    const auto = view.kind === 'minimal';
    // Opening practice: the banner at the top of the panel, during the game and after it.
    const v = openingPractice.value;
    const tone = v?.status === 'complete' ? 'done' : v?.status === 'left' ? 'off' : 'on';
    const banner: CoachActionView | null =
      v && (phase.value === 'playing' || phase.value === 'over')
        ? { id: 'opening', label: [v.name, v.statusText, tone].join('\t') }
        : null;
    const paired = (phase.value === 'playing' && settings.value.coach && ratesOpponent.value) || !!banner;
    return {
      ...view,
      ...(banner ? { actions: [banner, ...view.actions] } : {}),
      collapsed: state.coachCollapsed.value ?? auto,
      paired,
    };
  });

  function coachContent(): CoachContent {
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

  function overCoach(): CoachContent {
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
        { id: 'review', label: 'Game Review', primary: true },
        { id: 'rematch', label: 'Rematch' },
        { id: 'newGame', label: 'New game' },
      ],
    };
  }

  /** The coach's "Unlock to see why" (opens the paywall for `feature`). */
  function unlockAction(feature: ProFeature, primary = false): CoachActionView {
    return { id: 'unlock', label: UNLOCK_LABEL, feature, ...(primary ? { primary } : {}) };
  }

  /** "Show best", with a lock while it is part of Pro and locked. */
  function showBestAction(primary = false): CoachActionView {
    return { id: 'showBest', label: 'Show best', ...(primary ? { primary } : {}), ...(locked('showBest') ? { locked: true } : {}) };
  }

  function showBestCoach(m: Extract<CoachMode, { kind: 'showBest' }>): CoachContent {
    const ply = plies.value[m.index];
    const actions: CoachActionView[] = [{ id: 'backToGame', label: phase.value === 'playing' ? 'Back to game' : 'Back', primary: true }];
    if (ply && canRetry(ply)) actions.push({ id: 'retry', label: 'Retry' });
    if (locked('showBest')) {
      // Not reachable from the UI (the controller asks for Pro first, and leaves Show best when Pro
      // is locked again), but the best move must never show while it is locked.
      return {
        kind: phase.value === 'playing' ? 'coach' : 'review',
        title: 'Best move',
        lines: ['Show best is part of Pro.'],
        busy: false,
        actions: [...actions, unlockAction('showBest')],
      };
    }
    return {
      kind: phase.value === 'playing' ? 'coach' : 'review',
      cls: 'best',
      title: m.bestSan ? `Best was ${m.bestSan}` : 'Best move',
      lines: m.lines,
      busy: !!m.pending,
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

  function reviewCoach(): CoachContent {
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
    if (ply.index < preplayed.value) return { kind: 'review', ...preplayedView(ply), actions: [] };
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
    const showBest = offersShowBest(cl, ply.uci);
    if (locked('reviewDetails')) {
      // The verdict and its icon are free; the comment (and the better move) are Pro.
      const actions: CoachActionView[] = [unlockAction('reviewDetails', true)];
      if (showBest) actions.push(showBestAction());
      return { kind: 'review', ...verdictTitle(ply), titleMove: moveLabel(ply), lines: [lockedTeaser(ply)], busy: false, actions, index: ply.index };
    }
    const lines = explanationLines(ply.explanation, !TOP_CLASSES.has(cl.cls) ? cl.bestMoveSan : null);
    const actions: CoachActionView[] = showBest ? [showBestAction()] : [];
    return { kind: 'review', ...verdictTitle(ply), titleMove: moveLabel(ply), lines, busy: false, actions, index: ply.index };
  }

  function playingCoach(): CoachContent {
    const m = coachMode.value;
    const s = settings.value;
    if (m.kind === 'showBest') return showBestCoach(m);
    if (!isLive.value) return historyCoach(m);
    if (m.kind === 'hint') {
      if (locked('hint')) {
        // Like a locked Show best: not reachable from the UI, and never the move.
        return {
          kind: 'hint',
          title: 'Hint',
          lines: ['Hints are part of Pro.'],
          busy: false,
          actions: [{ id: 'dismissHint', label: 'Got it' }, unlockAction('hint', true)],
        };
      }
      return {
        kind: 'hint',
        title: 'Hint',
        lines: m.explanation ? explanationLines(m.explanation) : [],
        busy: !m.explanation,
        actions: m.explanation ? [{ id: 'dismissHint', label: 'Got it' }] : [],
      };
    }
    if (s.coach && m.kind === 'retry') {
      const lines = [`Find a better move than ${m.san}.`];
      if (m.headline && !locked('coachExplanations')) lines.push(m.headline);
      // Opening practice: back on the line, its move (`showLineMoves`) after the prompt.
      lines.push(...practiceNotes.value);
      return { kind: 'coach', title: 'Try again', lines, busy: false, actions: [] };
    }
    // The verdict on your last move (the coach) and on the opponent's (while its moves are rated).
    const fb = s.coach && m.kind === 'feedback' ? (plies.value[m.index] ?? null) : null;
    const mine = fb && fb.index >= preplayed.value ? fb : null;
    const theirs = ratesOpponent.value ? lastBotPly.value : null;
    // Opening practice: what the coach says about the line comes first (see `practiceNotes`).
    const notes = practiceNotes.value;
    const withNotes = (c: CoachContent): CoachContent => {
      // Opening practice: the first "book move" verdict on your moves says what "book" means.
      const firstBook =
        !!openingPractice.value && c.subject === 'you' && mine?.classification?.cls === 'book' && isFirstHumanPly(mine);
      const lines = firstBook && !c.lines.includes(BOOK_MEANING) ? [...c.lines, BOOK_MEANING] : c.lines;
      return notes.length || firstBook ? { ...c, lines: [...notes, ...lines] } : c;
    };
    if (mine && theirs) {
      // Both: one expanded (the one the player picked, until the next move), the other as a row.
      // Your move stays expanded while it has something to fix (an inaccuracy or worse, something
      // given away, Retry, a failed check); otherwise the opponent's latest move is (while yours is
      // checked too, so the panel does not swap back and forth on every move).
      const cf = state.coachFocus.value;
      const focus: CoachSubject = cf && cf.at === plies.value.length ? cf.subject : needsAttention(mine) ? 'you' : 'opponent';
      return withNotes(
        focus === 'you'
          ? { ...ownFeedback(mine), other: feedbackRow(theirs, 'opponent') }
          : { ...opponentFeedback(theirs), other: feedbackRow(mine, 'you') },
      );
    }
    if (mine) return withNotes(ownFeedback(mine));
    if (theirs) return withNotes(opponentFeedback(theirs));
    return s.coach ? idleCoach(notes) : withNotes(minimalCoach());
  }

  /** Browsing earlier moves during the game (a hint on the live position waits until you are back). */
  function historyCoach(m: CoachMode): CoachContent {
    const g = game.value!;
    const ply = displayedPly.value;
    const back: CoachActionView[] = [{ id: 'backToGame', label: 'Back to game', primary: true }];
    if (ply && ply.index < preplayed.value) return { kind: 'coach', ...preplayedView(ply), actions: back };
    if (ply && ply.classification && ratedDuringPlay(ply)) {
      const cl = ply.classification;
      const human = ply.color === g.playerColor;
      const head = human ? { ...verdictTitle(ply), titleMove: moveLabel(ply) } : opponentTitle(ply);
      if (locked('coachExplanations')) {
        return {
          kind: 'coach',
          ...head,
          lines: [lockedTeaser(ply)],
          busy: false,
          actions: [...back, unlockAction('coachExplanations')],
        };
      }
      // The move the coach is discussing may still be retried: keep its answer hidden here too.
      const base = m.kind === 'hint' ? m.prev : m;
      const hide = human && base.kind === 'feedback' && base.index === ply.index && canRetry(ply);
      return {
        kind: 'coach',
        ...head,
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

  /** The coach's verdict on your move `ply` (busy until it is annotated). */
  function ownFeedback(ply: Ply): CoachContent {
    const g = game.value!;
    const who = { subject: 'you' as const, who: 'You', verdict: shortVerdict(ply).verdict, index: ply.index };
    const cl = ply.classification;
    if (!cl || !ply.explanation) {
      if (analysisFailed(ply)) {
        return {
          kind: 'coach',
          ...who,
          title: `Couldn’t check ${ply.san}`,
          lines: ['The engine did not finish analyzing this move.'],
          busy: false,
          actions: [{ id: 'retryAnalysis', label: 'Try again', primary: true }],
        };
      }
      return { kind: 'coach', ...who, title: `Checking ${ply.san}…`, lines: [], busy: true, actions: [] };
    }
    const retry = canRetry(ply);
    const head = { kind: 'coach' as const, ...who, ...verdictTitle(ply), titleMove: moveLabel(ply) };
    if (locked('coachExplanations')) {
      // The verdict and its icon are free; why, and what was better, are Pro.
      const actions: CoachActionView[] = [unlockAction('coachExplanations', true)];
      if (offersShowBest(cl, ply.uci)) actions.push(showBestAction());
      if (retry) actions.push({ id: 'retry', label: 'Retry' });
      return { ...head, lines: [lockedTeaser(ply)], busy: false, actions };
    }
    // While Retry is on offer, the text must not give the better move away ("Show best" does).
    const lines = retry ? answerFreeLines(ply.explanation, cl) : explanationLines(ply.explanation);
    const reply = plies.value[ply.index + 1];
    const rc = reply?.classification?.cls;
    // Pointing out the bot's mistake is a live hint, so only in games that are unrated anyway (and
    // not when its moves are rated: the panel's other row says so).
    if (g.assisted && !ratesOpponent.value && reply && rc && (rc === 'mistake' || rc === 'blunder')) {
      lines.push(`${g.bot.name}’s ${reply.san} was a ${classLabel(rc).toLowerCase()}. Look for a way to punish it!`);
    }
    const actions: CoachActionView[] = [];
    // In a rated game Retry costs the rating, so the free "Show best" is the main action.
    if (offersShowBest(cl, ply.uci)) actions.push(showBestAction(!g.assisted));
    if (retry) actions.push({ id: 'retry', label: 'Retry', primary: g.assisted });
    if (!actions.some((a) => a.primary) && actions.length) actions[0] = { ...actions[0], primary: true };
    return { ...head, lines, busy: false, actions };
  }

  /** Your move needs the coach panel's room: something to fix, to retry, or a check that failed. */
  function needsAttention(ply: Ply): boolean {
    if (analysisFailed(ply)) return true;
    const cls = ply.classification?.cls;
    if (!cls || !ply.explanation) return false;
    return ATTENTION_CLASSES.has(cls) || !!concession(ply) || canRetry(ply);
  }

  /** "Pip’s 12… Nf6 is a mistake" (see coach.ts `verdictTitle`), with the move part and the class icon. */
  function opponentTitle(ply: Ply): Pick<CoachView, 'title' | 'titleMove' | 'cls'> {
    const name = game.value!.bot.name;
    const v = verdictTitle(ply);
    return { title: `${name}’s ${v.title}`, titleMove: `${name}’s ${moveLabel(ply)}`, ...(v.cls ? { cls: v.cls } : {}) };
  }

  /**
   * The verdict on the opponent's move `ply` while its moves are rated (`rateOpponent`): like
   * yours, in the third person ("Pip’s 12… Nf6 is a mistake", the neutral explanation), with Show
   * best for what it should have played.
   */
  function opponentFeedback(ply: Ply): CoachContent {
    const name = game.value!.bot.name;
    const who = { subject: 'opponent' as const, who: name, verdict: shortVerdict(ply).verdict, index: ply.index };
    const cl = ply.classification;
    if (!cl || !ply.explanation) {
      if (analysisFailed(ply)) {
        return {
          kind: 'coach',
          ...who,
          title: `Couldn’t check ${name}’s ${ply.san}`,
          lines: ['The engine did not finish analyzing this move.'],
          busy: false,
          actions: [{ id: 'retryAnalysis', label: 'Try again', primary: true }],
        };
      }
      return { kind: 'coach', ...who, title: `Checking ${name}’s ${ply.san}…`, lines: [], busy: true, actions: [] };
    }
    const head = { kind: 'coach' as const, ...who, ...opponentTitle(ply) };
    const showBest = offersShowBest(cl, ply.uci);
    if (locked('coachExplanations')) {
      // As for your moves: the verdict and its icon are free, the explanation and Show best are Pro.
      const actions: CoachActionView[] = [unlockAction('coachExplanations', true)];
      if (showBest) actions.push(showBestAction());
      return { ...head, lines: [lockedTeaser(ply)], busy: false, actions };
    }
    return { ...head, lines: explanationLines(ply.explanation), busy: false, actions: showBest ? [showBestAction(true)] : [] };
  }

  /** A short verdict for the compact row: "Mistake", "Gives up material", "Checking…". */
  function shortVerdict(ply: Ply): { verdict: string; cls?: MoveClass; busy?: boolean } {
    const cl = ply.classification;
    if (!cl || !ply.explanation) return analysisFailed(ply) ? { verdict: 'Couldn’t check' } : { verdict: 'Checking…', busy: true };
    const c = concession(ply);
    if (c) return { verdict: c === 'mate' ? 'Faster mate' : 'Gives up material' };
    return { verdict: classLabel(cl.cls), cls: cl.cls };
  }

  /** The other rated move as a compact row ("You" first, so the rows keep their order). */
  function feedbackRow(ply: Ply, subject: CoachSubject): CoachOtherView {
    return {
      subject,
      who: subject === 'you' ? 'You' : game.value!.bot.name,
      move: moveLabel(ply),
      ...shortVerdict(ply),
      place: subject === 'you' ? 'before' : 'after',
    };
  }

  /**
   * Waiting for a move (no feedback to show). Opening practice `notes` (see `practiceNotes`) come
   * first and replace the general tip.
   */
  function idleCoach(notes: readonly string[] = []): CoachContent {
    const g = game.value!;
    const ps = plies.value;
    const first = ps.length === preplayed.value;
    if (!humanTurnLive()) {
      return {
        kind: 'coach',
        title: `${g.bot.name} is thinking…`,
        lines: notes.length ? [...notes] : first ? [`“${g.bot.greeting}”`] : [],
        busy: false,
        actions: [],
      };
    }
    if (notes.length) return { kind: 'coach', title: 'Your move', lines: [...notes], busy: false, actions: [] };
    const lines: string[] = [];
    if (first) lines.push(`${g.bot.name}: “${g.bot.greeting}”`);
    const last = ps.at(-1);
    const o = last?.opening;
    if (o) lines.push(`Opening: ${o.name}`);
    const check = position.value.check;
    // A capture that can be answered in kind comes before any general advice (not in check,
    // where the check tip already says to capture the checking piece).
    const recapture = check ? null : recaptureTip(liveFen.value, last, g.bot.name);
    lines.push(recapture ?? coachTip(liveFen.value, ps.length, check));
    return { kind: 'coach', title: 'Your move', lines, busy: false, actions: [] };
  }

  function minimalCoach(): CoachContent {
    const g = game.value!;
    const last = plies.value.at(-1);
    const o = last?.opening;
    const title = o ? o.name : humanTurnLive() ? 'Your move' : `${g.bot.name} is thinking…`;
    const lines = last ? [`${last.color === g.playerColor ? 'You' : g.bot.name} played ${moveLabel(last)}.`] : [];
    return { kind: 'minimal', title, lines, busy: false, actions: [] };
  }

  /** `ply` is the human's first move of the game (after the moves it started with). */
  function isFirstHumanPly(ply: Ply): boolean {
    const g = game.value;
    const pre = preplayed.value;
    return !!g && !plies.value.some((p) => p.index >= pre && p.index < ply.index && p.color === g.playerColor);
  }

  /** A move the game started with (opening practice 'skip'): a book move, played for you. */
  function preplayedView(ply: Ply): Pick<CoachContent, 'title' | 'titleMove' | 'cls' | 'lines' | 'busy' | 'index'> {
    const name = game.value?.opening?.line.name;
    return {
      ...verdictTitle(ply),
      titleMove: moveLabel(ply),
      lines: [
        `This move was played for you before the game started${name ? `: it is part of the ${name} line` : ''}.`,
        BOOK_MEANING,
      ],
      busy: false,
      index: ply.index,
    };
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
    // The explorer's position while exploring (its captures, material and side to move).
    const xpos = explorerPosition.value;
    const fen = xpos?.fen ?? displayedFen.value;
    const captured = capturedPieces(fen);
    const mat = material(fen);
    const turn = xpos?.turn ?? position.value.turn;
    const playing = phase.value === 'playing' || !!xpos;
    const strip = (c: Color, isHuman: boolean): PlayerStripProps => ({
      name: isHuman ? 'You' : bot.name,
      rating: isHuman ? profile.value.rating : botElo,
      emoji: isHuman ? HUMAN_EMOJI : bot.emoji,
      ...(isHuman ? {} : { avatarColor: bot.color }),
      captured: captured[c],
      capturedColor: otherColor(c),
      materialDiff: Math.max(0, mat[c] - mat[otherColor(c)]),
      active: playing && !!g && turn === c,
      // The bot thinking about the real game is the explorer panel's news, not the explored position's.
      thinking: !isHuman && botThinking.value && !xpos,
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
    const hasHumanPly = humanMoved.value;
    const m = coachMode.value;
    const x = explorer.value;
    if (x) {
      // Exploring: Reset, Flip, ‹, ›, Engine reply (with the engine on), Exit (the game's buttons are inactive).
      const off = { disabled: true };
      return {
        newGame: off,
        undo: off,
        hint: off,
        flip: { disabled: false },
        coach: { disabled: true, active: settings.value.coach },
        menu: off,
        prev: { disabled: x.cursor === 0 },
        next: { disabled: x.cursor >= x.moves.length },
        review: { disabled: true, active: p === 'review' },
        resign: off,
        exportPgn: off,
        explore: { disabled: false, active: true },
        explorerReset: { disabled: x.moves.length === 0 },
        // Off with the engine (kept in its place, so the toolbar never changes shape on the switch).
        explorerReply: {
          disabled:
            !explorerEngineOn.value || !explorerPosition.value?.dests.size || !!explorerDraw.value || state.explorerReplying.value,
        },
        explorerExit: { disabled: false },
      };
    }
    const explorable = !!g && (p === 'playing' || p === 'over' || p === 'review');
    return {
      newGame: { disabled: booting },
      undo: { disabled: !(playing && settings.value.allowTakebacks && hasHumanPly) },
      hint: {
        disabled: !(humanToMove.value && isLive.value && m.kind !== 'showBest'),
        active: m.kind === 'hint' && isLive.value,
        ...(locked('hint') ? { locked: true } : {}),
      },
      flip: { disabled: p === 'boot' },
      coach: { disabled: p === 'boot', active: settings.value.coach },
      menu: { disabled: p === 'boot' },
      prev: { disabled: !g || current.value === 0 || m.kind === 'showBest' },
      next: { disabled: !g || isLive.value || m.kind === 'showBest' },
      review: { disabled: !(p === 'over' || p === 'review'), active: p === 'review' },
      resign: { disabled: !playing },
      exportPgn: { disabled: !g || plies.value.length === 0 },
      explore: { disabled: !explorable, ...(locked('explorer') ? { locked: true } : {}) },
      explorerReset: { disabled: true },
      explorerReply: { disabled: true },
      explorerExit: { disabled: true },
    };
  });

  // --- sheets ------------------------------------------------------------------------------------
  const sheets = computed<SheetsView>(() => {
    const g = game.value;
    const o = outcome.value;
    const rc = state.ratingChange.value;
    const inProgress = g && phase.value === 'playing' && !o && humanMoved.value ? { rated: !g.assisted } : null;
    const pending = state.pendingAssist.value;
    return {
      open: state.sheet.value,
      newGame: {
        initial: settings.value,
        playerRating: profile.value.rating,
        bots: BOTS,
        inProgress,
        newPlayer: isNewPlayer(profile.value),
      },
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
              ...(g.opening ? { practice: g.opening.line.name } : {}),
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
    // Accuracy and counts are free; the key moments (each with its comment) are Pro.
    const hide = locked('reviewDetails');
    return {
      progress: r.progress,
      accuracy: r.accuracy,
      counts: r.counts,
      playerColor: g.playerColor,
      names: g.playerColor === 'w' ? { w: 'You', b: botName } : { w: botName, b: 'You' },
      keyMoments: hide ? [] : r.keyMoments,
      ...(hide ? { lockedMoments: r.keyMoments.length } : {}),
    };
  });

  // --- explorer panel --------------------------------------------------------------------------
  const explorerPlayable = computed<ExplorerMove | null>(() => {
    const x = explorer.value;
    const g = game.value;
    if (!x || !g || !x.fromLive || !x.moves.length || plies.value.length !== x.gamePlies || !humanToMove.value) return null;
    const first = x.moves[0];
    return first.color === g.playerColor ? first : null;
  });

  const explorerPanel = computed<ExplorerPanelView | null>(() => {
    const x = explorer.value;
    const g = game.value;
    const pos = explorerPosition.value;
    if (!x || !g || !pos) return null;
    const base = explorerBasePly.value;
    const mv = currentMove(x);
    const engineOn = explorerEngineOn.value;
    const view: ExplorerPanelView = {
      from: base ? moveLabel(base) : null,
      title: pos.turn === 'w' ? 'White to move' : 'Black to move',
      engine: { on: engineOn, locked: locked('explorerEngine') },
      verdict: null,
      evalLabel: null,
      busy: false,
      lines: [],
      best: null,
      notice: null,
      noticeShort: null,
      noticeBusy: false,
      actions: [],
    };
    if (!engineOn) {
      // No verdict, eval, explanation or best move: the moves are the player's to judge.
      if (mv) view.title = moveLabel({ ...mv, index: x.baseIndex + x.cursor - 1 });
      const playing = phase.value === 'playing' && !outcome.value;
      view.lines = [
        !playing ? EXPLORER_ENGINE_OFF : `${EXPLORER_ENGINE_OFF} ${g.assisted ? 'This game is already unrated.' : 'Your game stays rated.'}`,
        EXPLORER_ENGINE_OFF_TIP,
      ];
    } else if (mv) {
      const label = moveLabel({ ...mv, index: x.baseIndex + x.cursor - 1 });
      view.title = label;
      const r = mv.rating;
      if (r) {
        const v = verdictTitle({ ...mv, index: x.baseIndex + x.cursor - 1, ...r });
        if (v.cls) {
          view.cls = v.cls;
          view.verdict = classLabel(v.cls);
        } else {
          // A move that gives something away: the neutral verdict ("still wins, but gives up material").
          view.verdict = v.title.slice(label.length).trim();
        }
        view.evalLabel = formatScore(r.evalWhite, sideToMove(mv.fenAfter));
        if (!locked('coachExplanations')) view.lines = [r.explanation.headline, ...r.explanation.details.slice(0, 1)];
      } else if (mv.failed) {
        view.verdict = 'Couldn’t check this move';
        view.actions.push({ id: 'retryRating', label: 'Try again' });
      } else {
        view.verdict = 'Checking…';
        view.busy = true;
      }
    } else {
      view.lines = [
        x.moves.length
          ? 'Step forward through your line, or try another move.'
          : 'Make moves for either side to try them out: your game itself doesn’t change.',
      ];
    }
    const draw = explorerDraw.value;
    if (pos.terminal === 'checkmate') view.best = `Checkmate: ${pos.turn === 'w' ? 'Black' : 'White'} wins.`;
    else if (pos.terminal === 'stalemate') view.best = 'Stalemate: a draw.';
    else if (draw) view.best = `${draw}: a draw.`;
    else if (engineOn) {
      const line = liveForExplorer.value?.lines[0];
      const san = line?.pv[0] ? uciToSan(pos.fen, line.pv[0]) : null;
      if (line && san) view.best = `Best here: ${san} (${formatScore(toWhitePov(line.score, pos.fen), pos.turn)})`;
    }
    // The real game goes on meanwhile (exploring from the bot's turn).
    const since = plies.value.slice(x.gamePlies);
    const last = since.at(-1);
    if (last) {
      const who = last.color === g.playerColor ? 'You' : g.bot.name;
      const played = `${who} played ${moveLabel(last)}`;
      view.notice = `${played} in your game.${outcome.value ? ' The game is over.' : ''}`;
      view.noticeShort = outcome.value ? `${played}: game over` : `${played} in your game`;
    } else if (phase.value === 'playing' && botThinking.value) {
      view.notice = `${g.bot.name} is thinking about its move in your game…`;
      view.noticeShort = `${g.bot.name} is thinking in your game…`;
      view.noticeBusy = true;
    }
    // A toggle: its label says which way it is (and `pressed` for assistive technology).
    const arrowsOn = state.explorerArrows.value;
    if (engineOn) view.actions.unshift({ id: 'arrows', label: arrowsOn ? 'Arrows on' : 'Arrows off', pressed: arrowsOn });
    const playable = explorerPlayable.value;
    if (playable) {
      view.actions.push({ id: 'play', label: `Play ${moveLabel({ ...playable, index: x.baseIndex })}`, primary: true });
    }
    return view;
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
    explorerPosition,
    explorerDraw,
    explorerPlayable,
    explorerPanel,
    openingPractice,
    draw,
  };
}

/**
 * [headline, ...details] of an explanation, plus "Best was X." when `bestSan` is given and no line
 * already names X as a move ("X was needed", "X was better", "You missed X, …").
 */
export function explanationLines(e: Explanation | undefined | null, bestSan?: string | null): string[] {
  // "Nf3 is a known opening move." only repeats the verdict ("Nf3 is a book move"): say what "book" means instead.
  const lines = e ? [e.headline, ...e.details].map((l) => (BOOK_ECHO.test(l) ? BOOK_MEANING : l)) : [];
  if (bestSan && !lines.some((l) => mentionsMove(l, bestSan))) lines.push(`Best was ${bestSan}.`);
  return lines;
}

/** A book move's plain reason, which repeats its verdict (see `explanationLines`). */
const BOOK_ECHO = new RegExp(`^\\S+ ${BOOK_REASON}\\.$`);

function stripClass(p: Ply): Ply {
  if (!p.classification) return p;
  const { classification: _c, ...rest } = p;
  return rest;
}
