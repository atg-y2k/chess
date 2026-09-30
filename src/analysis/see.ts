/**
 * Board geometry, attack maps and static exchange evaluation (SEE) on top of chess.js.
 *
 * Pure logic (no DOM). Every function takes a FEN and works on its own scratch board, so the
 * game's `Chess` instance is never touched: `remove()` / `put()` rewrite castling rights and a
 * null move followed by `undo()` corrupts chess.js's position hash (threefold detection).
 */
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';

/** Exchange values in pawns. The king is 100 so that it never "recaptures" into a defended square. */
export const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

/** A piece and the square it stands on. */
export interface PieceOn {
  square: Square;
  type: PieceSymbol;
  color: Color;
}

export const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');

/** A scratch board for probing (never the game's own instance). */
export function scratch(fen: string): Chess {
  return new Chess(fen, { skipValidation: true });
}

export const fileOf = (s: Square): number => s.charCodeAt(0) - 97;
/** Rank index 0..7 (rank 1 = 0). */
export const rankOf = (s: Square): number => s.charCodeAt(1) - 49;

/** The square at file/rank indexes 0..7, or null when off the board. */
export function squareAt(f: number, r: number): Square | null {
  return f >= 0 && f < 8 && r >= 0 && r < 8 ? ((String.fromCharCode(97 + f) + (r + 1)) as Square) : null;
}

/** All pieces on `board`, optionally only those of `color`. */
export function pieces(board: Chess, color?: Color): PieceOn[] {
  const out: PieceOn[] = [];
  for (const row of board.board()) {
    for (const p of row) {
      if (p && (!color || p.color === color)) out.push({ square: p.square, type: p.type, color: p.color });
    }
  }
  return out;
}

/** The piece on `s`, or null. */
export function pieceAt(board: Chess, s: Square): PieceOn | null {
  const p = board.get(s);
  return p ? { square: s, type: p.type, color: p.color } : null;
}

/** Square of the king of `color`, or null (scratch boards may lack one). */
export function kingSquare(board: Chess, color: Color): Square | null {
  return board.findPiece({ type: 'k', color })[0] ?? null;
}

type Dir = readonly [number, number];
const KNIGHT: Dir[] = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const KING: Dir[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const DIAG: Dir[] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH: Dir[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const QUEEN: Dir[] = [...DIAG, ...ORTH];

/** Ray directions of a sliding piece (empty for pawns, knights and kings). */
export function slideDirs(t: PieceSymbol): Dir[] {
  return t === 'b' ? DIAG : t === 'r' ? ORTH : t === 'q' ? QUEEN : [];
}

/** Squares attacked BY the piece on `s` (chess.js only offers the reverse, `attackers()`). */
export function attacksFrom(board: Chess, s: Square): Square[] {
  const p = board.get(s);
  if (!p) return [];
  const f = fileOf(s);
  const r = rankOf(s);
  const out: Square[] = [];
  const add = (t: Square | null) => {
    if (t) out.push(t);
  };
  if (p.type === 'p') {
    const d = p.color === 'w' ? 1 : -1;
    add(squareAt(f - 1, r + d));
    add(squareAt(f + 1, r + d));
  } else if (p.type === 'n') {
    for (const [df, dr] of KNIGHT) add(squareAt(f + df, r + dr));
  } else if (p.type === 'k') {
    for (const [df, dr] of KING) add(squareAt(f + df, r + dr));
  } else {
    for (const [df, dr] of slideDirs(p.type)) {
      for (let i = 1; ; i++) {
        const t = squareAt(f + df * i, r + dr * i);
        if (!t) break;
        out.push(t);
        if (board.get(t)) break;
      }
    }
  }
  return out;
}

/** The first `max` pieces hit along a ray from `s` (for pins, skewers and x-rays). */
export function rayHits(board: Chess, s: Square, df: number, dr: number, max = 2): PieceOn[] {
  const hits: PieceOn[] = [];
  for (let i = 1; hits.length < max; i++) {
    const t = squareAt(fileOf(s) + df * i, rankOf(s) + dr * i);
    if (!t) break;
    const p = pieceAt(board, t);
    if (p) hits.push(p);
  }
  return hits;
}

/** True when `x` lies strictly between `a` and `b` on a rank, file or diagonal. */
export function between(a: Square, b: Square, x: Square): boolean {
  const nf = fileOf(b) - fileOf(a);
  const nr = rankOf(b) - rankOf(a);
  if (!(nf === 0 || nr === 0 || Math.abs(nf) === Math.abs(nr))) return false;
  const df = Math.sign(nf);
  const dr = Math.sign(nr);
  for (let i = 1; ; i++) {
    const t = squareAt(fileOf(a) + df * i, rankOf(a) + dr * i);
    if (!t || t === b) return false;
    if (t === x) return true;
  }
}

/**
 * The square of the enemy slider that pins the piece on `s` to its own king (an absolute pin), or
 * null. Reads the board as it is, so pins that disappear during an exchange are handled.
 */
export function absolutePinner(board: Chess, s: Square, king: Square | null = null): Square | null {
  const p = board.get(s);
  if (!p || p.type === 'k') return null;
  const k = king ?? kingSquare(board, p.color);
  if (!k || k === s) return null;
  const nf = fileOf(s) - fileOf(k);
  const nr = rankOf(s) - rankOf(k);
  if (!(nf === 0 || nr === 0 || Math.abs(nf) === Math.abs(nr))) return null;
  const df = Math.sign(nf);
  const dr = Math.sign(nr);
  const [first, second] = rayHits(board, k, df, dr, 2);
  if (!first || first.square !== s || !second || second.color === p.color) return null;
  const diagonal = df !== 0 && dr !== 0;
  return second.type === 'q' || second.type === (diagonal ? 'b' : 'r') ? second.square : null;
}

/** Can the piece on `from` reach `target` without leaving its king in an absolute pin? */
function pinAllows(board: Chess, from: Square, target: Square, king: Square | null): boolean {
  const pinner = absolutePinner(board, from, king);
  if (!pinner) return true;
  // A pinned piece may still move along the pin line (including capturing the pinner).
  return target === pinner || (!!king && between(king, pinner, target));
}

/**
 * Attackers of `target` belonging to `side` that could actually capture there: absolutely pinned
 * pieces are dropped unless the target lies on their pin line. Pseudo-legal otherwise (a king is
 * listed even if the square is defended; SEE's king value takes care of that).
 */
export function effectiveAttackers(board: Chess, target: Square, side: Color): Square[] {
  const king = kingSquare(board, side);
  return board.attackers(target, side).filter((from) => pinAllows(board, from, target, king));
}

function leastValuableAttacker(board: Chess, target: Square, side: Color): Square | undefined {
  let best: Square | undefined;
  let bestValue = Infinity;
  for (const s of effectiveAttackers(board, target, side)) {
    const v = VALUE[board.get(s)!.type];
    if (v < bestValue) {
      bestValue = v;
      best = s;
    }
  }
  return best;
}

const isLastRank = (s: Square) => s[1] === '8' || s[1] === '1';

/**
 * Static exchange evaluation (swap algorithm, chessprogramming.org/SEE_-_The_Swap_Algorithm):
 * net material in pawns that `side` wins by capturing on `target`, first with the piece on
 * `firstFrom` (default: its least valuable attacker), then both sides recapture with their least
 * valuable attacker and either may stop. Returns 0 when nobody can capture.
 *
 * - X-rays work because chess.js `attackers()` re-scans the rays after the capturer is removed.
 * - Absolutely pinned attackers are ignored unless they capture along the pin line.
 * - Pawn captures onto the last rank promote (+8).
 * - Also answers "is my piece safe on this square?": `see(fen, sq, enemy) > 0` means it is not.
 * - Ignores en passant and checks. No CPW pruning: it would keep only the sign of the result.
 */
export function see(fen: string, target: Square, side: Color, firstFrom?: Square): number {
  const b = scratch(fen);
  let from = firstFrom ?? leastValuableAttacker(b, target, side);
  if (!from) return 0;
  const victim = b.get(target);
  let attacker = b.get(from);
  if (!attacker) return 0;
  const gain: number[] = [victim && victim.color !== side ? VALUE[victim.type] : 0];
  let onSquare = VALUE[attacker.type];
  if (attacker.type === 'p' && isLastRank(target)) {
    gain[0] += 8;
    onSquare = 9;
  }
  let d = 0;
  let stm = side;
  for (;;) {
    b.remove(from); // the capturer leaves `from`; x-ray attackers behind it now show up
    stm = other(stm);
    from = leastValuableAttacker(b, target, stm);
    if (!from) break;
    attacker = b.get(from)!;
    d++;
    gain[d] = onSquare - gain[d - 1];
    onSquare = VALUE[attacker.type];
    if (attacker.type === 'p' && isLastRank(target)) {
      gain[d] += 8;
      onSquare = 9;
    }
  }
  while (d > 0) {
    gain[d - 1] = -Math.max(-gain[d - 1], gain[d]);
    d--;
  }
  return gain[0];
}

/** A piece the opponent can win by capture. */
export interface Hanging {
  piece: PieceOn;
  /** Net gain for the capturing side (SEE, pawns, > 0). */
  see: number;
  /** Number of (pin-aware) defenders. */
  defenders: number;
  /** The cheapest attacker worth less than the piece, if any ("can be taken by a pawn"). */
  lowerAttacker?: PieceOn;
}

/**
 * Pieces (not the king) of `color` that the other side wins material on by capturing (SEE > 0),
 * most valuable loss first. Meaningful when the other side is to move.
 */
export function hangingPieces(fen: string, color: Color): Hanging[] {
  const b = scratch(fen);
  const opp = other(color);
  const out: Hanging[] = [];
  for (const p of pieces(b, color)) {
    if (p.type === 'k') continue;
    const atk = effectiveAttackers(b, p.square, opp);
    if (!atk.length) continue;
    const g = see(fen, p.square, opp);
    if (g <= 0) continue;
    const lower = atk
      .map((s) => pieceAt(b, s)!)
      .filter((a) => a.type !== 'k' && VALUE[a.type] < VALUE[p.type])
      .sort((x, y) => VALUE[x.type] - VALUE[y.type])[0];
    out.push({
      piece: p,
      see: g,
      defenders: effectiveAttackers(b, p.square, color).length,
      ...(lower ? { lowerAttacker: lower } : {}),
    });
  }
  return out.sort((x, y) => y.see - x.see);
}

/** A legal capture that wins material by static exchange. */
export interface WinningCapture {
  san: string;
  from: Square;
  to: Square;
  gain: number;
  target: PieceOn;
}

/**
 * Legal captures for the side to move that win at least `minGain` pawns by SEE, best first.
 * Candidates come from `attackers()` + SEE (fast); chess.js only checks legality and SAN.
 */
export function winningCaptures(fen: string, minGain = 1): WinningCapture[] {
  const b = scratch(fen);
  const me = b.turn();
  const cand: Omit<WinningCapture, 'san'>[] = [];
  for (const t of pieces(b, other(me))) {
    if (t.type === 'k') continue;
    for (const from of b.attackers(t.square, me)) {
      const gain = see(fen, t.square, me, from);
      if (gain >= minGain) cand.push({ from, to: t.square, gain, target: t });
    }
  }
  if (!cand.length) return [];
  const legal = new Chess(fen);
  const out: WinningCapture[] = [];
  for (const w of cand.sort((x, y) => y.gain - x.gain)) {
    try {
      const m = legal.move({ from: w.from, to: w.to, promotion: 'q' });
      legal.undo();
      out.push({ ...w, san: m.san });
    } catch {
      /* pinned or otherwise illegal */
    }
  }
  return out;
}
