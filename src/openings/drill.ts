/**
 * Drilling a line: the app plays the opponent's moves of the line, the player must find their own.
 * A pure state machine: every function takes a DrillState and returns a new one (frozen, plain
 * JSON data, so it can be kept in a signal or saved); nothing is mutated and nothing is random.
 *
 *   let s = createDrill(getLine(id)!, 'b');      // status 'opponent': the app moves first
 *   s = playOpponent(s);                          // 1. e4 (after a short pause, for the animation)
 *   const c = checkMove(s, 'c7c5');               // the player's move -> 'correct' | 'alternative' | ...
 *   s = c.state;                                  // ...repeat until s.status === 'complete'
 *   recordDrill(s.lineId, drillResult(s)!);       // ./progress
 *
 * 'alternative' (another book move) and 'wrong' need the opening book (`loadOpenings()`); without
 * it every move that is not the line's counts as 'wrong'. A Pro feature (see ./index).
 */
import { Chess, type Square } from 'chess.js';
import { BOOK_BLUNDER_CP, bookMoves, isBookMove, type BookMove } from '../bot/book';
import { parseUci, PIECE_NAMES, START_FEN, toUci } from '../chess/utils';
import type { Color } from '../game/types';
import { moveLabel } from './tree';

/** Whose move it is in the drill, or 'complete' once the whole line has been played. */
export type DrillStatus = 'player' | 'opponent' | 'complete';

/** How a player's move compares with the line. */
export type DrillCheckResult = 'correct' | 'alternative' | 'wrong' | 'illegal';

export type HintLevel = 1 | 2 | 3;

/** What a drill needs from a line (an OpeningLine has it all). */
export interface DrillLine {
  readonly id: string;
  /** UCI moves from `startFen`. */
  readonly uci: readonly string[];
  readonly name?: string;
  /** Default: the initial position. */
  readonly startFen?: string;
}

export interface DrillOptions {
  /**
   * Another book move is a near miss, not counted in `mistakes` (default false: it is a mistake).
   * Either way the player is told the line's move and must play it to go on, so the move counts as
   * not found first time (`missed`): it lowers the score and the run is not clean.
   */
  acceptAlternatives?: boolean;
  /** Plies played automatically before the drill starts, e.g. to skip "1. e4 c5" (default 0). */
  fromPly?: number;
}

/** A move with its SAN and its numbered label ("2. Nf3", "2... Nc6"). */
export interface DrillMove {
  uci: string;
  san: string;
  label: string;
  /**
   * Set on `DrillCheck.expected` when the line's move is itself a known trap-line blunder
   * (cpLoss >= BOOK_BLUNDER_CP): the line shows how that mistake gets punished.
   */
  dubious?: true;
}

export interface DrillState {
  readonly lineId: string;
  readonly lineName: string;
  readonly startFen: string;
  /** The line's moves (UCI and SAN). */
  readonly moves: readonly string[];
  readonly sans: readonly string[];
  readonly playerColor: Color;
  readonly acceptAlternatives: boolean;
  readonly fromPly: number;
  /** Plies of the line on the board. */
  readonly ply: number;
  /** The current position. */
  readonly fen: string;
  readonly status: DrillStatus;
  /** The last move on the board (for highlighting), with who played it. */
  readonly lastMove: (DrillMove & { color: Color }) | null;
  /** Wrong moves, plus other book moves unless `acceptAlternatives`. */
  readonly mistakes: number;
  /** Other book moves tried (counted whether or not they are mistakes). */
  readonly alternatives: number;
  /**
   * Hint levels revealed: each level shown counts once, including the levels a jump skips (going
   * straight to level 3 counts 3, the same as asking for 1, 2 and 3).
   */
  readonly hints: number;
  /** Hint level shown for the current move (0 = none). */
  readonly hintLevel: 0 | HintLevel;
  /** Moves tried at the current move that were not the line's. */
  readonly triesThisMove: number;
  /**
   * Plies (indices into `moves`) of the player's moves not found first time without a hint (after a
   * wrong move, another book move, or a hint).
   */
  readonly missed: readonly number[];
}

/** The outcome of `checkMove`. */
export interface DrillCheck {
  state: DrillState;
  result: DrillCheckResult;
  /** The move played (null when illegal or not the player's turn). */
  played: DrillMove | null;
  /** The line's move here (null when it is not the player's turn). */
  expected: DrillMove | null;
  /** The other sound book moves here, most popular first (never the line's move). */
  alternatives: DrillMove[];
  /** Plain-English feedback. */
  message: string;
}

export interface DrillHint {
  level: HintLevel;
  /** The piece to move ('p', 'n', 'b', 'r', 'q', 'k'; castling is a king move). */
  piece: string;
  /** From-square (level 2 and up). */
  from?: string;
  /** The move itself (level 3). */
  move?: DrillMove;
  /** "Move a knight." / "Move the knight on g1." / "Play 2. Nf3." */
  text: string;
}

/** The score of a completed drill (input to `recordDrill` in ./progress). */
export interface DrillResult {
  lineId: string;
  playerColor: Color;
  /** Plies played automatically before the drill started (DrillOptions.fromPly). */
  fromPly: number;
  /**
   * The drill skipped some of the player's moves (`fromPly`): it counts as practice, not towards
   * mastery (see recordDrill).
   */
  partial: boolean;
  /** Moves the player had to find (0: nothing to find, e.g. Black in a line that ends with 1. e4). */
  playerMoves: number;
  /** Of those, found first time without a hint. */
  found: number;
  mistakes: number;
  alternatives: number;
  hints: number;
  /** Every move found first time without a hint (and at least one move to find). */
  clean: boolean;
  /** 0..100: share of the player's moves found first time without a hint (0 when there were none). */
  score: number;
}

/** The book lookups a drill uses (the opening book by default; a stand-in in tests). */
export interface DrillBook {
  bookMoves(fen: string): readonly BookMove[];
  isBookMove(fenBefore: string, uci: string, fenAfter: string): boolean;
}

const DEFAULT_BOOK: DrillBook = { bookMoves, isBookMove };

/** Whether the book knows `uci` at `fen` as a trap-line blunder. */
const isBlunder = (book: DrillBook, fen: string, uci: string): boolean =>
  book.bookMoves(fen).some((m) => m.uci === uci && (m.cpLoss ?? 0) >= BOOK_BLUNDER_CP);

// -------------------------------------------------------------------------------------------------

const turnOf = (fen: string): Color => (fen.split(' ')[1] === 'b' ? 'b' : 'w');

/** Who plays the line's move at `ply` (0-based) from `startFen`. */
const moverAt = (startFen: string, ply: number): Color => (turnOf(startFen) === 'w') === (ply % 2 === 0) ? 'w' : 'b';

/** Label of the move at `ply`, numbered from the start position's move number and side. */
function labelAt(s: Pick<DrillState, 'startFen'>, ply: number, san: string): string {
  const fields = s.startFen.split(' ');
  const offset = (Math.max(1, Number(fields[5]) || 1) - 1) * 2 + (turnOf(s.startFen) === 'b' ? 1 : 0);
  return moveLabel(offset + ply, san);
}

function statusOf(s: Pick<DrillState, 'ply' | 'moves' | 'startFen' | 'playerColor'>): DrillStatus {
  if (s.ply >= s.moves.length) return 'complete';
  return moverAt(s.startFen, s.ply) === s.playerColor ? 'player' : 'opponent';
}

function freeze(s: Omit<DrillState, 'status'>): DrillState {
  return Object.freeze({ ...s, status: statusOf(s) });
}

/** The line's moves (UCI, normalized) and SAN from `startFen`; throws on an illegal move. */
function replayLine(startFen: string, uci: readonly string[]): { moves: string[]; sans: string[]; fens: string[] } {
  const chess = new Chess(startFen);
  const moves: string[] = [];
  const sans: string[] = [];
  const fens: string[] = [chess.fen()];
  for (const u of uci) {
    const mv = chess.move(parseUci(u)); // throws: not a playable line
    moves.push(toUci(mv));
    sans.push(mv.san);
    fens.push(chess.fen());
  }
  return { moves, sans, fens };
}

/**
 * Starts a drill of `line` with the player on `playerColor`. The first `fromPly` plies are on the
 * board already; the status says who moves next ('opponent': call `playOpponent`).
 * Throws if the line's moves are not legal.
 */
export function createDrill(line: DrillLine, playerColor: Color, opts: DrillOptions = {}): DrillState {
  const startFen = line.startFen ?? START_FEN;
  const { moves, sans, fens } = replayLine(startFen, line.uci);
  const fromPly = Math.max(0, Math.min(moves.length, Math.floor(opts.fromPly ?? 0)));
  const last = fromPly > 0 ? fromPly - 1 : -1;
  const base = { startFen };
  return freeze({
    lineId: line.id,
    lineName: line.name ?? '',
    startFen,
    moves: Object.freeze(moves),
    sans: Object.freeze(sans),
    playerColor,
    acceptAlternatives: opts.acceptAlternatives ?? false,
    fromPly,
    ply: fromPly,
    fen: fens[fromPly],
    lastMove:
      last >= 0
        ? { uci: moves[last], san: sans[last], label: labelAt(base, last, sans[last]), color: moverAt(startFen, last) }
        : null,
    mistakes: 0,
    alternatives: 0,
    hints: 0,
    hintLevel: 0,
    triesThisMove: 0,
    missed: Object.freeze([]),
  });
}

/** The same drill from the start (same line, side and options), counters reset. */
export function restartDrill(s: DrillState): DrillState {
  return createDrill(
    { id: s.lineId, uci: s.moves, name: s.lineName, startFen: s.startFen },
    s.playerColor,
    { acceptAlternatives: s.acceptAlternatives, fromPly: s.fromPly },
  );
}

/** Side to move in the drill's position. */
export function drillTurn(s: DrillState): Color {
  return turnOf(s.fen);
}

/** The line's next move, whoever plays it (null once complete). */
export function expectedMove(s: DrillState): DrillMove | null {
  if (s.ply >= s.moves.length) return null;
  return { uci: s.moves[s.ply], san: s.sans[s.ply], label: labelAt(s, s.ply, s.sans[s.ply]) };
}

/** The move the app should play now for the opponent (null unless the status is 'opponent'). */
export function opponentMove(s: DrillState): DrillMove | null {
  return s.status === 'opponent' ? expectedMove(s) : null;
}

/** Plays the line's next move on the board (no checks, no counters). */
function advance(s: DrillState): DrillState {
  const mv = expectedMove(s);
  if (!mv) return s;
  const chess = new Chess(s.fen);
  const color = turnOf(s.fen);
  chess.move(parseUci(mv.uci));
  return freeze({ ...s, ply: s.ply + 1, fen: chess.fen(), lastMove: { ...mv, color }, hintLevel: 0, triesThisMove: 0 });
}

/** Plays the opponent's line move (unchanged state unless the status is 'opponent'). */
export function playOpponent(s: DrillState): DrillState {
  return s.status === 'opponent' ? advance(s) : s;
}

const withMissed = (missed: readonly number[], ply: number): readonly number[] =>
  missed.includes(ply) ? missed : Object.freeze([...missed, ply]);

/** Sound book moves at the drill's position other than the line's, most popular first. */
function bookAlternatives(s: DrillState, book: DrillBook, chess: Chess): DrillMove[] {
  const expected = s.moves[s.ply];
  const out: DrillMove[] = [];
  for (const m of book.bookMoves(s.fen)) {
    if (m.uci === expected || (m.cpLoss ?? 0) >= BOOK_BLUNDER_CP) continue;
    try {
      const san = chess.move(parseUci(m.uci)).san;
      chess.undo();
      out.push({ uci: m.uci, san, label: labelAt(s, s.ply, san) });
    } catch {
      /* not legal here: skip */
    }
  }
  return out;
}

/**
 * Checks the player's move. 'correct' plays it (then it is usually the opponent's turn);
 * 'alternative' (another book move, transpositions included) and 'wrong' (not book, or a known
 * trap-line blunder) leave the position as it was so the player tries again; 'illegal' (or not
 * the player's turn) changes nothing and counts nothing. `expected.dubious` flags a line whose own
 * move is a known blunder (a trap line drilled from the losing side, see `dubiousPlayerMoves`).
 */
export function checkMove(s: DrillState, uci: string, book: DrillBook = DEFAULT_BOOK): DrillCheck {
  const none = { played: null, alternatives: [] as DrillMove[] };
  if (s.status !== 'player') {
    const message = s.status === 'complete' ? 'This line is complete.' : "Wait for the opponent's move.";
    return { state: s, result: 'illegal', expected: null, message, ...none };
  }
  const expected = expectedMove(s) as DrillMove;
  if (isBlunder(book, s.fen, expected.uci)) expected.dubious = true;
  const chess = new Chess(s.fen);
  let played: DrillMove;
  let fenAfter: string;
  try {
    const mv = chess.move(parseUci(uci));
    played = { uci: toUci(mv), san: mv.san, label: labelAt(s, s.ply, mv.san) };
    fenAfter = chess.fen();
    chess.undo();
  } catch {
    return { state: s, result: 'illegal', expected, message: 'That move is not possible here.', ...none };
  }
  const alternatives = bookAlternatives(s, book, chess);
  if (played.uci === expected.uci) {
    const message = expected.dubious
      ? `Correct for this line: ${played.label}. It is a known mistake, and this line shows how it gets punished.`
      : `Correct: ${played.label}.`;
    return { state: advance(s), result: 'correct', played, expected, alternatives, message };
  }
  const isAlternative = book.isBookMove(s.fen, played.uci, fenAfter);
  if (isAlternative) {
    const state = freeze({
      ...s,
      alternatives: s.alternatives + 1,
      mistakes: s.mistakes + (s.acceptAlternatives ? 0 : 1),
      missed: withMissed(s.missed, s.ply),
      triesThisMove: s.triesThisMove + 1,
    });
    const message = `${played.label} is also a book move, but this line continues with ${expected.label}.`;
    return { state, result: 'alternative', played, expected, alternatives, message };
  }
  const trap = isBlunder(book, s.fen, played.uci);
  const state = freeze({
    ...s,
    mistakes: s.mistakes + 1,
    missed: withMissed(s.missed, s.ply),
    triesThisMove: s.triesThisMove + 1,
  });
  const message = trap
    ? `${played.label} is a known mistake here. Try again.`
    : `${played.label} is not part of the opening theory here. Try again.`;
  return { state, result: 'wrong', played, expected, alternatives, message };
}

/**
 * A hint for the player's current move: level 1 names the piece ("Move a knight."), level 2 its
 * square ("Move the knight on g1."), level 3 the move ("Play 2. Nf3."). Without `level`, the next
 * level after the one shown. Each newly revealed level counts as a hint (jumping from none to 3
 * counts 3) and marks the move as missed; asking again for a level already shown does not. Null
 * unless it is the player's turn.
 */
export function drillHint(s: DrillState, level?: HintLevel): { state: DrillState; hint: DrillHint | null } {
  if (s.status !== 'player') return { state: s, hint: null };
  const want = Math.min(3, Math.max(1, level ?? Math.min(3, s.hintLevel + 1))) as HintLevel;
  const mv = expectedMove(s) as DrillMove;
  const chess = new Chess(s.fen);
  const { from } = parseUci(mv.uci);
  const piece = chess.get(from as Square)?.type ?? 'p';
  const pieceName = PIECE_NAMES[piece] ?? 'piece';
  const color = turnOf(s.fen);
  const count = chess
    .board()
    .flat()
    .filter((sq) => sq && sq.color === color && sq.type === piece).length;
  let text: string;
  if (want === 1) text = `Move ${count === 1 ? 'your' : 'a'} ${pieceName}.`;
  else if (want === 2) text = `Move the ${pieceName} on ${from}.`;
  else if (mv.san.startsWith('O-O-O')) text = `Play ${mv.label} (castle queenside).`;
  else if (mv.san.startsWith('O-O')) text = `Play ${mv.label} (castle kingside).`;
  else text = `Play ${mv.label}.`;
  const h: DrillHint = { level: want, piece, ...(want >= 2 ? { from } : {}), ...(want === 3 ? { move: mv } : {}), text };
  if (want <= s.hintLevel) return { state: s, hint: h };
  const state = freeze({ ...s, hintLevel: want, hints: s.hints + (want - s.hintLevel), missed: withMissed(s.missed, s.ply) });
  return { state, hint: h };
}

/** How many moves the player has to find in a line (from `fromPly`). */
export function playerMoveCount(line: DrillLine, playerColor: Color, fromPly = 0): number {
  const startFen = line.startFen ?? START_FEN;
  let n = 0;
  for (let i = Math.max(0, fromPly); i < line.uci.length; i++) if (moverAt(startFen, i) === playerColor) n++;
  return n;
}

/**
 * Plies (0-based indices into the line's moves) of the player's own moves that the book knows as
 * trap-line blunders, e.g. 2. g4 in "Barnes Opening: Fool's Mate" for White. Such a line shows a
 * trap from the losing side: the UI can warn, or offer the other side instead. [] without the book.
 */
export function dubiousPlayerMoves(line: DrillLine, playerColor: Color, book: DrillBook = DEFAULT_BOOK): number[] {
  const startFen = line.startFen ?? START_FEN;
  const out: number[] = [];
  let chess: Chess;
  try {
    chess = new Chess(startFen);
  } catch {
    return out;
  }
  for (let i = 0; i < line.uci.length; i++) {
    const fen = chess.fen();
    let uci: string;
    try {
      uci = toUci(chess.move(parseUci(line.uci[i])));
    } catch {
      break; // not a playable line: keep what was found
    }
    if (moverAt(startFen, i) === playerColor && isBlunder(book, fen, uci)) out.push(i);
  }
  return out;
}

/** The score of a completed drill; null while it is still going. */
export function drillResult(s: DrillState): DrillResult | null {
  if (s.status !== 'complete') return null;
  const line = { id: s.lineId, uci: s.moves, startFen: s.startFen };
  const playerMoves = playerMoveCount(line, s.playerColor, s.fromPly);
  const found = Math.max(0, playerMoves - s.missed.length);
  return {
    lineId: s.lineId,
    playerColor: s.playerColor,
    fromPly: s.fromPly,
    partial: playerMoves < playerMoveCount(line, s.playerColor, 0),
    playerMoves,
    found,
    mistakes: s.mistakes,
    alternatives: s.alternatives,
    hints: s.hints,
    clean: playerMoves > 0 && found === playerMoves,
    score: playerMoves ? Math.round((100 * found) / playerMoves) : 0,
  };
}
