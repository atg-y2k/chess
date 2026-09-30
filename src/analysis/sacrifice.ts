/**
 * Static material tests for move classification: legal-move static exchange evaluation (so pins,
 * x-rays and checks are respected), piece-sacrifice detection and "free capture" detection.
 */
import { Chess, type Color, type Move, type Square } from 'chess.js';
import { parseUci } from '../chess/utils';

/** Exchange values in pawns (the king is effectively priceless). */
export const SEE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 1000 };

/** Smallest net material (pawns) that counts as a sacrifice. */
export const MIN_SACRIFICE = 2;

/**
 * Net material the side to move can win by starting a capture sequence on `sq` (>= 0, because it may
 * decline). Captures are tried least valuable attacker first. `chess` is restored before returning.
 */
export function see(chess: Chess, sq: Square): number {
  const target = chess.get(sq);
  if (!target || target.color === chess.turn()) return 0;
  const lastRank = sq[1] === '8' || sq[1] === '1';
  const attackers = chess
    .attackers(sq, chess.turn())
    .map((from) => ({ from, piece: chess.get(from)?.type ?? 'k' }))
    .sort((a, b) => SEE_VALUES[a.piece] - SEE_VALUES[b.piece]);
  for (const a of attackers) {
    let m: Move;
    try {
      // Throws when the capture is illegal (pinned piece, king walking into check, ...).
      m = chess.move({ from: a.from, to: sq, promotion: a.piece === 'p' && lastRank ? 'q' : undefined });
    } catch {
      continue;
    }
    const gain = SEE_VALUES[m.captured ?? 'p'] + (m.promotion ? SEE_VALUES[m.promotion] - 1 : 0);
    const v = gain - see(chess, sq);
    chess.undo();
    return Math.max(0, v);
  }
  return 0;
}

export interface UnsafePiece {
  square: Square;
  /** Lower-case piece letter (n, b, r or q). */
  piece: string;
  /** Material the opponent wins by capturing it (SEE, pawns). */
  gain: number;
}

/**
 * Pieces (N, B, R, Q) of `color` that the other side can win at least `minGain` pawns from in `fen`.
 * When `color` is to move, a null move hands the turn over first (not possible while in check).
 */
export function unsafePieces(fen: string, color: Color, minGain = MIN_SACRIFICE): UnsafePiece[] {
  const c = new Chess(fen);
  if (c.turn() === color) {
    if (c.inCheck()) return [];
    c.setTurn(color === 'w' ? 'b' : 'w');
  }
  const res: UnsafePiece[] = [];
  for (const row of c.board()) {
    for (const p of row) {
      if (!p || p.color !== color || p.type === 'p' || p.type === 'k') continue;
      const gain = see(c, p.square);
      if (gain >= minGain) res.push({ square: p.square, piece: p.type, gain });
    }
  }
  return res;
}

export interface Sacrifice {
  /** Net material offered, in pawns (>= MIN_SACRIFICE). */
  netValue: number;
  /** Square of the piece left en prise. */
  square: Square;
  /** Lower-case piece letter of that piece. */
  piece: string;
}

/**
 * The piece sacrifice offered by `uci` in `fenBefore`, or null. The net value is the most the
 * opponent can win from one of the mover's pieces after the move, minus what the move captured.
 * Not a sacrifice: promotions, checkmates, moves made while in check, and moves that reduce the
 * number of loose pieces without giving check (rescuing one piece of a fork).
 */
export function detectSacrifice(fenBefore: string, uci: string): Sacrifice | null {
  try {
    const c = new Chess(fenBefore);
    const mover = c.turn();
    if (c.inCheck()) return null;
    const mv = c.move(parseUci(uci));
    if (mv.promotion || c.isCheckmate()) return null;
    const after = unsafePieces(c.fen(), mover);
    if (!after.length) return null;
    if (!c.inCheck() && after.length < unsafePieces(fenBefore, mover).length) return null;
    const top = after.reduce((a, b) => (b.gain > a.gain ? b : a));
    const net = top.gain - (mv.captured ? SEE_VALUES[mv.captured] : 0);
    return net >= MIN_SACRIFICE ? { netValue: net, square: top.square, piece: top.piece } : null;
  } catch {
    return null;
  }
}

/**
 * True when `uci` is a capture that wins material by static exchange (the opponent cannot win it
 * back), or simply recaptures on the square of the opponent's previous move (`prevMoveTo`).
 */
export function capturedFreeMaterial(fenBefore: string, uci: string, prevMoveTo?: string): boolean {
  try {
    const c = new Chess(fenBefore);
    const mv = c.move(parseUci(uci));
    if (!mv.captured) return false;
    if (prevMoveTo === mv.to) return true;
    const gain = SEE_VALUES[mv.captured] + (mv.promotion ? SEE_VALUES[mv.promotion] - 1 : 0);
    return gain - see(c, mv.to) > 0;
  } catch {
    return false;
  }
}
