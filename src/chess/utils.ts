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

/**
 * Whether the position after move `index` of `moves` (played from `startFen`) occurs for the third
 * time (counting the start position): a draw by threefold repetition.
 */
export function isThirdRepetition(startFen: string, moves: readonly { fenAfter: string }[], index: number): boolean {
  const key = fenKey(moves[index].fenAfter);
  let seen = fenKey(startFen) === key ? 1 : 0;
  for (let i = 0; i <= index; i++) if (fenKey(moves[i].fenAfter) === key) seen++;
  return seen >= 3;
}

/** How often a game has had each position so far, by `fenKey`. */
export type SeenPositions = ReadonlyMap<string, number>;

/** `seen` plus one more occurrence of `fen`. */
export function withPosition(seen: SeenPositions, fen: string): Map<string, number> {
  const out = new Map(seen);
  const k = fenKey(fen);
  out.set(k, (out.get(k) ?? 0) + 1);
  return out;
}

/** The positions of a game: the start and the position after each move (`fenAfter`), for the first `upTo` moves. */
export function seenPositions(startFen: string, moves: readonly { fenAfter: string }[], upTo = moves.length): Map<string, number> {
  const out = new Map<string, number>();
  const add = (fen: string) => {
    const k = fenKey(fen);
    out.set(k, (out.get(k) ?? 0) + 1);
  };
  add(startFen);
  for (let i = 0; i < Math.min(upTo, moves.length); i++) add(moves[i].fenAfter);
  return out;
}

/**
 * The legal moves in `fen` that would repeat a position for the third time (a draw), counting the
 * game's positions in `seen` (which include `fen`). UCI.
 */
export function repetitionReplies(fen: string, seen: SeenPositions): string[] {
  try {
    const c = new Chess(fen);
    return c
      .moves({ verbose: true })
      .filter((m) => (seen.get(fenKey(m.after)) ?? 0) >= 2)
      .map((m) => toUci(m));
  } catch {
    return [];
  }
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

const CAPTURE_ORDER = ['q', 'r', 'b', 'n', 'p'];

/**
 * Pieces captured BY each colour (lower-case letters, most valuable first), derived from the
 * board so it stays correct across takebacks. A piece beyond the starting set (a promotion) was a
 * pawn, which is then not counted as captured. (A promoted piece captured later counts as a pawn:
 * `capturedByMoves` knows better when the moves are at hand.)
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
  const lost = (c: Color) => {
    const promoted = ['q', 'r', 'b', 'n'].reduce((n, p) => n + Math.max(0, (counts[c][p] ?? 0) - START_COUNTS[p]), 0);
    return CAPTURE_ORDER.flatMap((p) => {
      const have = (counts[c][p] ?? 0) + (p === 'p' ? promoted : 0);
      return Array(Math.max(0, START_COUNTS[p] - have)).fill(p) as string[];
    });
  };
  // White captured what Black lost, and vice versa.
  return { w: lost('b'), b: lost('w') };
}

/** Pieces captured BY each colour in these moves (the game's, from its start), most valuable first. */
export function capturedByMoves(moves: readonly { color: Color; captured?: string }[]): { w: string[]; b: string[] } {
  const out: { w: string[]; b: string[] } = { w: [], b: [] };
  for (const m of moves) if (m.captured) out[m.color].push(m.captured);
  const rank = (p: string) => CAPTURE_ORDER.indexOf(p);
  out.w.sort((a, b) => rank(a) - rank(b));
  out.b.sort((a, b) => rank(a) - rank(b));
  return out;
}
