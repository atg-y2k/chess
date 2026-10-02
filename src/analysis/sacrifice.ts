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
  /**
   * The piece was already en prise before the move: the opponent's last move attacked it and this
   * move ignores the threat (only reported when `prevFenBefore` shows the threat is new).
   */
  ignoresThreat?: boolean;
}

/**
 * The piece sacrifice offered by `uci` in `fenBefore`, or null. Only material the move newly
 * offers counts: the moved piece, or a piece whose static-exchange loss appears or grows because of
 * the move (a removed defender, an opened line). The net value is the most the opponent can win
 * from such a piece, minus what the move captured.
 *
 * A piece that was already en prise and stays en prise is not a new offer: leaving it hanging
 * again (or playing on while the opponent declines to take it) is not a sacrifice. The exception
 * is ignoring a threat the opponent's last move just created, which needs `prevFenBefore` (the
 * position before that move); such a result has `ignoresThreat`.
 *
 * Not a sacrifice: promotions, checkmates, moves made while in check, and saving one piece of a
 * fork while the other stays loose.
 */
export function detectSacrifice(fenBefore: string, uci: string, prevFenBefore?: string): Sacrifice | null {
  try {
    const c = new Chess(fenBefore);
    const mover = c.turn();
    if (c.inCheck()) return null;
    const mv = c.move(parseUci(uci));
    if (mv.promotion || c.isCheckmate()) return null;
    const after = unsafePieces(c.fen(), mover);
    if (!after.length) return null;
    const pre = new Map(unsafePieces(fenBefore, mover, 1).map((p) => [p.square, p.gain]));
    const captured = mv.captured ? SEE_VALUES[mv.captured] : 0;
    const loose = [...pre.values()].filter((g) => g >= MIN_SACRIFICE).length;
    const offers: { p: UnsafePiece; net: number; ignoresThreat?: boolean }[] = [];
    let prevUnsafe: Map<Square, number> | null = null;
    for (const p of after) {
      const was = p.square === mv.to ? undefined : pre.get(p.square);
      if (was === undefined) {
        offers.push({ p, net: p.gain - captured });
      } else if (p.gain > was) {
        // Already loose, but the move makes it worse (e.g. takes away a defender).
        offers.push({ p, net: p.gain - was - captured });
      } else if (prevFenBefore && after.length >= loose) {
        // Still en prise: a sacrifice only when the threat is new (the opponent just created it)
        // and the move does not rescue another piece instead (one piece of a fork).
        prevUnsafe ??= new Map(unsafePieces(prevFenBefore, mover, 1).map((q) => [q.square, q.gain]));
        if ((prevUnsafe.get(p.square) ?? 0) < p.gain) offers.push({ p, net: p.gain - captured, ignoresThreat: true });
      }
    }
    const top = offers.reduce<(typeof offers)[number] | null>((a, b) => (!a || b.net > a.net ? b : a), null);
    if (!top || top.net < MIN_SACRIFICE) return null;
    return {
      netValue: top.net,
      square: top.p.square,
      piece: top.p.piece,
      ...(top.ignoresThreat ? { ignoresThreat: true } : {}),
    };
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

/**
 * True when `uci` just moves an attacked piece (N, B, R or Q that the opponent could win) to the
 * only square where it is safe: an obvious escape, which is never a "Great" only move. Captures
 * and moves made while in check are not escapes.
 */
export function isObviousEscape(fenBefore: string, uci: string): boolean {
  try {
    const c = new Chess(fenBefore);
    const mover = c.turn();
    if (c.inCheck()) return false;
    const { from } = parseUci(uci);
    if (!unsafePieces(fenBefore, mover).some((p) => p.square === from)) return false;
    let safe = 0;
    let playedSafe = false;
    for (const m of c.moves({ square: from as Square, verbose: true })) {
      const gain = unsafePieces(m.after, mover, 1).find((p) => p.square === m.to)?.gain ?? 0;
      if (gain - (m.captured ? SEE_VALUES[m.captured] : 0) >= MIN_SACRIFICE) continue;
      safe++;
      if (m.from + m.to + (m.promotion ?? '') === uci) playedSafe = !m.captured;
    }
    return playedSafe && safe === 1;
  } catch {
    return false;
  }
}
