import { Chess } from 'chess.js';
import type { Score } from '../engine/types';
import type { Color, PromotionPiece } from '../game/types';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const PIECE_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const PIECE_NAMES: Record<string, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

/** Position identity for caching: placement, side to move, castling, en passant (drops move counters). */
export function fenKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function sideToMove(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

export function otherColor(c: Color): Color {
  return c === 'w' ? 'b' : 'w';
}

export interface UciMove {
  from: string;
  to: string;
  promotion?: PromotionPiece;
}

export function parseUci(uci: string): UciMove {
  const promo = uci.length > 4 ? (uci[4] as PromotionPiece) : undefined;
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), ...(promo ? { promotion: promo } : {}) };
}

export function toUci(m: { from: string; to: string; promotion?: string }): string {
  return m.from + m.to + (m.promotion ?? '');
}

/** Converts a side-to-move score (UCI convention) into White's point of view. */
export function toWhitePov(score: Score, fen: string): Score {
  return sideToMove(fen) === 'w' ? score : { kind: score.kind, value: -score.value } as Score;
}

/** Converts a White-POV score into the given colour's point of view. */
export function whitePovTo(score: Score, color: Color): Score {
  return color === 'w' ? score : { kind: score.kind, value: -score.value } as Score;
}

/** SAN for a UCI move in `fen`, or null if illegal. */
export function uciToSan(fen: string, uci: string): string | null {
  try {
    const chess = new Chess(fen);
    return chess.move(parseUci(uci)).san;
  } catch {
    return null;
  }
}

/** Converts a UCI principal variation into SAN, stopping at the first illegal move or after `max` plies. */
export function pvToSan(fen: string, pv: string[], max = pv.length): string[] {
  const out: string[] = [];
  try {
    const chess = new Chess(fen);
    for (const uci of pv.slice(0, max)) {
      out.push(chess.move(parseUci(uci)).san);
    }
  } catch {
    /* stop at first illegal move */
  }
  return out;
}

/** Formats SAN moves with move numbers, e.g. "12. Nf3 Nc6 13. O-O" or "12... Nc6 13. O-O". */
export function formatLine(fen: string, sans: string[]): string {
  const parts = fen.split(' ');
  let moveNo = Number(parts[5] ?? '1') || 1;
  let color: Color = parts[1] === 'b' ? 'b' : 'w';
  const out: string[] = [];
  sans.forEach((san, i) => {
    if (color === 'w') out.push(`${moveNo}. ${san}`);
    else out.push(i === 0 ? `${moveNo}... ${san}` : san);
    if (color === 'b') moveNo++;
    color = otherColor(color);
  });
  return out.join(' ');
}

/** Material (in pawns) for each colour on the board described by `fen`. */
export function material(fen: string): { w: number; b: number } {
  const placement = fen.split(' ')[0];
  const totals = { w: 0, b: 0 };
  for (const ch of placement) {
    const lower = ch.toLowerCase();
    if (!(lower in PIECE_VALUES)) continue;
    totals[ch === lower ? 'b' : 'w'] += PIECE_VALUES[lower];
  }
  return totals;
}

const START_COUNTS: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };

/**
 * Pieces captured BY each colour (lower-case letters, most valuable first), derived from the
 * board so it stays correct across takebacks. Promotions can make counts negative; those are clamped.
 */
export function capturedPieces(fen: string): { w: string[]; b: string[] } {
  const placement = fen.split(' ')[0];
  const counts: Record<Color, Record<string, number>> = { w: {}, b: {} };
  for (const ch of placement) {
    const lower = ch.toLowerCase();
    if (!(lower in START_COUNTS)) continue;
    const c: Color = ch === lower ? 'b' : 'w';
    counts[c][lower] = (counts[c][lower] ?? 0) + 1;
  }
  const order = ['q', 'r', 'b', 'n', 'p'];
  const lost = (c: Color) =>
    order.flatMap((p) => Array(Math.max(0, START_COUNTS[p] - (counts[c][p] ?? 0))).fill(p) as string[]);
  // White captured what Black lost, and vice versa.
  return { w: lost('b'), b: lost('w') };
}
