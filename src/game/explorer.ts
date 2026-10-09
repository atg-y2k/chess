/**
 * The explorer: try moves from a position of the game without touching the game itself.
 *
 * This module is the explorer's pure state (no engine, no DOM, no signals): the position it
 * started from, the line of moves tried from there, and a cursor within that line. Stepping back
 * and playing the move that follows keeps the rest of the line; playing another move replaces it.
 * The controller keeps one `Explorer` in `store.explorer` while exploring, adds the engine's rating
 * of each move (`setRating`), and drops it on exit: nothing here is saved, so a reload leaves the
 * explorer.
 */
import { Chess, type Move } from 'chess.js';
import type { Classification, Explanation } from '../analysis/types';
import { isThirdRepetition } from '../chess/utils';
import type { Score } from '../engine/types';
import type { Color, PromotionPiece } from './types';

/** The engine's verdict on an explored move (as the game's annotations: depth 14, MultiPV 3). */
export interface ExplorerRating {
  classification: Classification;
  explanation: Explanation;
  /** Evaluation of the position after the move, from White's point of view. */
  evalWhite: Score;
  evalDepth: number;
  /** The move is a known opening move (from a book position). */
  isBook: boolean;
}

/** One explored move. */
export interface ExplorerMove {
  uci: string;
  san: string;
  color: Color;
  fenBefore: string;
  fenAfter: string;
  /** Lower-case piece letter captured by the move, if any. */
  captured?: string;
  /** The engine's verdict, once the move has been analyzed. */
  rating?: ExplorerRating;
  /** The analysis failed (the panel offers to try again). */
  failed?: boolean;
}

export interface Explorer {
  /** The position the exploration started from. */
  baseFen: string;
  /** Plies of the game that were on the board when it started (the game's `current`). */
  baseIndex: number;
  /** It started from the game's live position, not an earlier one. */
  fromLive: boolean;
  /** Number of plies the game had when it started (later ones were played in the game meanwhile). */
  gamePlies: number;
  /** The line of explored moves from `baseFen`. */
  moves: readonly ExplorerMove[];
  /** Number of explored moves on the board (0 = the base position). */
  cursor: number;
  /** Tells one opening of the explorer from the next (the board drops a move started in another). */
  session?: number;
}

/** Where an explorer starts: the position, and the game around it then. */
export interface ExplorerBase {
  baseFen: string;
  baseIndex: number;
  fromLive: boolean;
  gamePlies: number;
}

/** Starts exploring from `baseFen` (an empty line). */
export function startExplorer(o: ExplorerBase & { session?: number }): Explorer {
  const x: Explorer = { baseFen: o.baseFen, baseIndex: o.baseIndex, fromLive: o.fromLive, gamePlies: o.gamePlies, moves: [], cursor: 0 };
  if (o.session !== undefined) x.session = o.session;
  return x;
}

/** The position on the explorer's board. */
export function explorerFen(x: Explorer): string {
  return x.cursor > 0 ? x.moves[x.cursor - 1].fenAfter : x.baseFen;
}

/** The explored move that led to the position on the board (null at the base position). */
export function currentMove(x: Explorer): ExplorerMove | null {
  return x.cursor > 0 ? x.moves[x.cursor - 1] : null;
}

const uciOf = (m: Pick<Move, 'from' | 'to' | 'promotion'>): string => m.from + m.to + (m.promotion ?? '');

/**
 * Plays `from`-`to` (with `promotion`; a pawn reaching the last rank without one becomes a queen)
 * in the explorer's position, for whichever side is to move. Returns the new explorer, or null
 * when the move is illegal. When it is the move that already follows in the line, the line is
 * kept (and its rating); otherwise the rest of the line is replaced by this move.
 */
export function playMove(x: Explorer, from: string, to: string, promotion?: PromotionPiece): Explorer | null {
  let chess: Chess;
  try {
    chess = new Chess(explorerFen(x));
  } catch {
    return null;
  }
  let mv: Move;
  try {
    mv = chess.move({ from, to, promotion });
  } catch {
    if (promotion) return null;
    try {
      mv = chess.move({ from, to, promotion: 'q' });
    } catch {
      return null;
    }
  }
  const uci = uciOf(mv);
  if (x.moves[x.cursor]?.uci === uci) return { ...x, cursor: x.cursor + 1 };
  const move: ExplorerMove = { uci, san: mv.san, color: mv.color, fenBefore: mv.before, fenAfter: mv.after };
  if (mv.captured) move.captured = mv.captured;
  return { ...x, moves: [...x.moves.slice(0, x.cursor), move], cursor: x.cursor + 1 };
}

/** Shows the position after `n` explored moves (clamped to the line). */
export function goTo(x: Explorer, n: number): Explorer {
  const cursor = Math.max(0, Math.min(x.moves.length, Math.floor(n)));
  return cursor === x.cursor ? x : { ...x, cursor };
}

/** One move back (no-op at the base position). */
export function back(x: Explorer): Explorer {
  return goTo(x, x.cursor - 1);
}

/** One move forward along the line (no-op at its end). */
export function forward(x: Explorer): Explorer {
  return goTo(x, x.cursor + 1);
}

/** Back to the base position with an empty line. */
export function reset(x: Explorer): Explorer {
  return x.moves.length === 0 && x.cursor === 0 ? x : { ...x, moves: [], cursor: 0 };
}

/** A draw the explorer's board can reach without checkmate or stalemate (the game's own wording). */
export type DrawReason = 'Insufficient material' | 'Threefold repetition' | '50-move rule';

/**
 * Why the position on the explorer's board is drawn, as the game would be there, else null: too
 * little material to mate, a third repetition (counting the game's positions up to the explorer's
 * starting one, `gamePlies`, played from `startFen`) or the 50-move rule. Checkmate and stalemate
 * are not draws of this kind (see `positionInfo`).
 */
export function drawReason(x: Explorer, startFen: string, gamePlies: readonly { fenAfter: string }[]): DrawReason | null {
  let chess: Chess;
  try {
    chess = new Chess(explorerFen(x));
  } catch {
    return null;
  }
  if (chess.isCheckmate() || chess.isStalemate()) return null;
  if (chess.isInsufficientMaterial()) return 'Insufficient material';
  const line = [...gamePlies.slice(0, x.baseIndex), ...x.moves.slice(0, x.cursor)];
  if (line.length && isThirdRepetition(startFen, line, line.length - 1)) return 'Threefold repetition';
  if (chess.isDrawByFiftyMoves()) return '50-move rule';
  return null;
}

/** Legal destinations by origin square in `fen` (empty for an invalid FEN or a finished game). */
export function legalDests(fen: string): Map<string, string[]> {
  const dests = new Map<string, string[]>();
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return dests;
  }
  for (const m of chess.moves({ verbose: true })) {
    const list = dests.get(m.from);
    if (!list) dests.set(m.from, [m.to]);
    else if (!list.includes(m.to)) list.push(m.to);
  }
  return dests;
}

/**
 * Identifies explored move `index` by the line that leads to it (its moves in UCI), so a rating
 * that arrives after the line has changed is not given to another move.
 */
export function movePath(x: Explorer, index: number): string {
  return x.moves
    .slice(0, index + 1)
    .map((m) => m.uci)
    .join(' ');
}

/**
 * Stores the rating (or the failure) of move `index`, when that move is still the one `path`
 * names (see `movePath`); otherwise returns `x` unchanged.
 */
export function setRating(
  x: Explorer,
  index: number,
  path: string,
  result: { rating: ExplorerRating } | { failed: true },
): Explorer {
  const m = x.moves[index];
  if (!m || movePath(x, index) !== path) return x;
  const { rating: _r, failed: _f, ...rest } = m;
  const next: ExplorerMove = 'rating' in result ? { ...rest, rating: result.rating } : { ...rest, failed: true };
  const moves = x.moves.slice();
  moves[index] = next;
  return { ...x, moves };
}

/** Forgets the failed ratings, so they are tried again. */
export function clearFailed(x: Explorer): Explorer {
  if (!x.moves.some((m) => m.failed)) return x;
  return {
    ...x,
    moves: x.moves.map((m) => {
      if (!m.failed) return m;
      const { failed: _f, ...rest } = m;
      return rest;
    }),
  };
}
