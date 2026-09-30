/**
 * Tactical and positional detectors for the coach: forks, pins, skewers, discovered attacks,
 * trapped pieces, back-rank weaknesses, mate / promotion / material threats (null-move probes on
 * scratch boards), material won or lost along an engine line, and opening / positional principles.
 *
 * Pure logic (no DOM), engine-free; built on chess.js and the SEE helpers in `./see`. Rules follow
 * the lichess puzzle tagger where one exists. All results are machine-readable; `./explain`
 * turns them into sentences.
 */
import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js';
import { parseUci } from '../chess/utils';
import {
  VALUE,
  attacksFrom,
  between,
  fileOf,
  hangingPieces,
  kingSquare,
  other,
  pieceAt,
  pieces,
  rankOf,
  rayHits,
  scratch,
  see,
  slideDirs,
  squareAt,
  winningCaptures,
  type Hanging,
  type PieceOn,
  type WinningCapture,
} from './see';

/** A tactical or structural pattern, from the point of view of the side that created it. */
export type Motif =
  | { kind: 'checkmate' }
  | { kind: 'check'; double: boolean; discovered: boolean }
  | { kind: 'fork'; by: PieceOn; targets: PieceOn[] }
  | { kind: 'doubleThreat'; threats: { san: string; target: PieceOn }[] }
  /**
   * `exploit`: the pin already existed and the move attacks the pinned piece. `frozen`: pinned to
   * the king and unable to move at all (a knight, or a piece that cannot move along the pin line).
   */
  | { kind: 'pin'; by: PieceOn; pinned: PieceOn; behind: PieceOn; exploit?: boolean; frozen?: boolean }
  | { kind: 'skewer'; by: PieceOn; front: PieceOn; back: PieceOn }
  | { kind: 'discovered'; by: PieceOn; target: PieceOn }
  | { kind: 'freeCapture'; captured: PieceOn; attackers: number; defenders: number }
  | { kind: 'losingCapture'; captured: PieceOn; see: number }
  | ({ kind: 'hanging' } & Hanging)
  | { kind: 'trapped'; piece: PieceOn }
  | { kind: 'mateThreat'; san: string }
  | { kind: 'promotionThreat'; san: string }
  | { kind: 'threat'; san: string; target: PieceOn }
  | { kind: 'attacks'; target: PieceOn }
  | { kind: 'promotion'; to: PieceSymbol }
  | { kind: 'backRank'; color: Color };

export type MotifKind = Motif['kind'];

/** Squares a motif is "about"; used to rank motifs by where material actually changes hands. */
export function motifSquares(m: Motif): Square[] {
  switch (m.kind) {
    case 'fork':
      return m.targets.map((t) => t.square);
    case 'doubleThreat':
      return m.threats.map((t) => t.target.square);
    case 'pin':
      return [m.pinned.square];
    case 'skewer':
      return [m.back.square];
    case 'discovered':
    case 'threat':
    case 'attacks':
      return [m.target.square];
    case 'freeCapture':
    case 'losingCapture':
      return [m.captured.square];
    case 'hanging':
    case 'trapped':
      return [m.piece.square];
    default:
      return [];
  }
}

// ------------------------------------------------------------------ mate and null-move probes

/** Mating moves (SAN) for the side to move. chess.js SAN already carries the `#`. */
export function mateInOne(fen: string): string[] {
  return new Chess(fen).moves().filter((m) => m.endsWith('#'));
}

/**
 * The position after the side to move "passes" (chess.js null move, on a scratch board), or null
 * when the side to move is in check (a null move would be illegal).
 */
export function nullMoveFen(fen: string): string | null {
  const c = new Chess(fen);
  if (c.inCheck()) return null;
  c.move(null);
  return c.fen();
}

/**
 * A short forced mate for the side to move: mate in one, or (when `maxMoves` >= 2) a checking move
 * after which every reply allows mate in one. Returns the SAN line (1 or 3 plies) or null.
 */
export function forcedMateLine(fen: string, maxMoves = 2): string[] | null {
  const m1 = mateInOne(fen);
  if (m1.length) return [m1[0]];
  if (maxMoves < 2) return null;
  const c = new Chess(fen);
  for (const san of c.moves().filter((s) => s.endsWith('+'))) {
    c.move(san);
    const replies = c.moves();
    let line: string[] | null = replies.length ? [] : null;
    for (const r of replies) {
      c.move(r);
      const mate = mateInOne(c.fen())[0];
      c.undo();
      if (!mate) {
        line = null;
        break;
      }
      if (line && !line.length) line = [san, r, mate];
    }
    c.undo();
    if (line?.length) return line;
  }
  return null;
}

/** A pawn push (not a capture) that promotes and keeps at least a pawn's worth of the new queen. */
export interface PromotionThreat {
  san: string;
  from: Square;
  to: Square;
}

/** Non-capturing promotions available to the side to move that net at least one pawn (SEE). */
export function promotionPushes(fen: string): PromotionThreat[] {
  const c = new Chess(fen);
  const me = c.turn();
  const seventh = me === 'w' ? 6 : 1;
  const out: PromotionThreat[] = [];
  for (const p of pieces(c, me)) {
    if (p.type !== 'p' || rankOf(p.square) !== seventh) continue;
    for (const m of c.moves({ square: p.square, verbose: true })) {
      if (m.promotion !== 'q' || m.captured) continue;
      const net = 8 - Math.max(0, see(m.after, m.to, other(me)));
      if (net >= 1) out.push({ san: m.san, from: m.from, to: m.to });
    }
  }
  return out;
}

/** Something the side NOT to move could do next if the side to move passed. */
export interface Threat {
  kind: 'mate' | 'promotion' | 'material';
  san: string;
  from: Square;
  to: Square;
  /** Material the threat wins (pawns); 'material' threats only. */
  gain?: number;
  /** The piece that would be captured; 'material' threats only. */
  target?: PieceOn;
}

/**
 * Threats against the side to move (null-move probe on a scratch board), most serious first:
 * mates in one, then promotions, then captures that win material by SEE (one per target square).
 * Empty when the side to move is in check (the check itself is the threat).
 */
export function threatsAgainst(fen: string): Threat[] {
  const nf = nullMoveFen(fen);
  if (!nf) return [];
  const out: Threat[] = [];
  const c = new Chess(nf);
  for (const san of mateInOne(nf)) {
    const m = c.move(san);
    c.undo();
    out.push({ kind: 'mate', san, from: m.from, to: m.to });
  }
  for (const p of promotionPushes(nf)) out.push({ kind: 'promotion', ...p });
  const seen = new Set<Square>();
  for (const w of winningCaptures(nf)) {
    if (seen.has(w.to)) continue;
    seen.add(w.to);
    out.push({ kind: 'material', san: w.san, from: w.from, to: w.to, gain: w.gain, target: w.target });
  }
  return out;
}

/**
 * The most serious threat against the side to move (see `threatsAgainst`) that `uci` stops, or
 * null. A move that gives check is not counted as stopping anything (it only delays the threat),
 * and nothing counts as stopped while the opponent still has a mate in one. A material threat is
 * stopped only when the target is safe afterwards (on its new square if it moved) and no threat
 * of the same size or bigger is left; a capture never "saves" a piece (it takes or trades).
 */
export function stoppedThreat(fen: string, uci: string): Threat | null {
  const threats = threatsAgainst(fen);
  if (!threats.length) return null;
  const c = new Chess(fen);
  const mv = c.move(parseUci(uci));
  if (c.inCheck()) return null;
  const after = c.fen();
  const opp = c.turn();
  if (mateInOne(after).length) return null;
  let promos: PromotionThreat[] | null = null;
  let caps: WinningCapture[] | null = null;
  for (const t of threats) {
    if (t.kind === 'mate') return t;
    if (t.kind === 'promotion') {
      promos ??= promotionPushes(after);
      if (!promos.some((p) => p.to === t.to)) return t;
      continue;
    }
    if (mv.captured || !t.target) continue;
    caps ??= winningCaptures(after);
    const moved = t.target.square === mv.from;
    const lost = moved ? see(after, mv.to, opp) > 0 : caps.some((w) => w.to === t.target!.square);
    if (lost) continue;
    return caps.some((w) => w.gain >= (t.gain ?? 1)) ? null : t;
  }
  return null;
}

// ------------------------------------------------------------------ static patterns

/**
 * Fork by the piece on `s` (lichess tagger rule): the forker is safe (unless it is a king), and at
 * least two attacked enemy pieces are worth more than it (the king counts) or are undefended and
 * cannot take it. Undefended pawns count as extra targets but never make a fork on their own.
 */
export function forkTargets(fen: string, s: Square): PieceOn[] {
  const c = scratch(fen);
  const me = pieceAt(c, s);
  if (!me) return [];
  const opp = other(me.color);
  if (me.type !== 'k' && see(fen, s, opp) > 0) return [];
  const targets: PieceOn[] = [];
  for (const t of attacksFrom(c, s)) {
    const v = pieceAt(c, t);
    if (!v || v.color === me.color) continue;
    const moreValuable = VALUE[v.type] > VALUE[me.type];
    const undefended = c.attackers(t, opp).length === 0 && !c.attackers(s, opp).includes(t);
    if (v.type === 'p' && !undefended) continue;
    if (moreValuable || undefended) targets.push(v);
  }
  targets.sort((a, b) => VALUE[b.type] - VALUE[a.type]);
  return targets.length >= 2 && targets.some((t) => t.type !== 'p') ? targets : [];
}

/**
 * For a fork that gives check (`after`: the opponent to move): true when every legal reply still
 * lets the forker's side win material on a target (followed if it moved) or on the forker's square.
 */
function checkForkHolds(after: string, forker: Square, targets: readonly PieceOn[]): boolean {
  const c = new Chess(after);
  const loot = targets.filter((t) => t.type !== 'k');
  for (const r of c.moves({ verbose: true })) {
    const squares: Square[] = [forker, ...loot.map((t) => (t.square === r.from ? r.to : t.square))];
    if (!winningCaptures(r.after).some((w) => squares.includes(w.to))) return false;
  }
  return true;
}

/**
 * Pins and skewers by the sliders of `color` (optionally only the slider on `only`). A pin is a
 * piece (not a pawn) in front of a more valuable king, queen or rook; a skewer is a king or a more
 * valuable piece in front of a piece that SEE shows is won once the front piece steps aside.
 */
export function linesFrom(fen: string, color: Color, only?: Square): Motif[] {
  const c = scratch(fen);
  const out: Motif[] = [];
  // Can the opponent win the piece on `sq`? With the opponent to move, only legal captures count
  // (a side in check cannot take the pinner); otherwise static exchange.
  let legalWins: Square[] | null = null;
  const lost = (sq: Square) => {
    if (c.turn() === color) return see(fen, sq, other(color)) > 0;
    legalWins ??= safe(() => winningCaptures(fen).map((w) => w.to), [] as Square[]);
    return legalWins.includes(sq);
  };
  for (const s of pieces(c, color)) {
    if (only && s.square !== only) continue;
    for (const [df, dr] of slideDirs(s.type)) {
      const [a, b] = rayHits(c, s.square, df, dr);
      if (!a || !b || a.color === color || b.color === color) continue;
      const pin =
        a.type !== 'k' &&
        a.type !== 'p' &&
        VALUE[b.type] > VALUE[a.type] &&
        (b.type === 'k' || b.type === 'q' || b.type === 'r') &&
        (b.type === 'k' || VALUE[b.type] > VALUE[s.type]);
      // A pinner or skewerer the opponent simply wins (e.g. the "pinned" piece takes it) is neither.
      if ((pin || a.type === 'k' || VALUE[a.type] > VALUE[b.type]) && lost(s.square)) continue;
      if (pin) {
        const diagonal = df !== 0 && dr !== 0;
        const frozen = b.type === 'k' && (a.type === 'n' || a.type === (diagonal ? 'r' : 'b'));
        out.push({ kind: 'pin', by: s, pinned: a, behind: b, ...(frozen ? { frozen } : {}) });
      } else if ((a.type === 'k' || VALUE[a.type] > VALUE[b.type]) && b.type !== 'p') {
        const t = scratch(fen);
        t.remove(a.square);
        if (see(t.fen(), b.square, color, s.square) > 0) out.push({ kind: 'skewer', by: s, front: a, back: b });
      }
    }
  }
  return out;
}

/**
 * Pieces (not pawns or the king) of the side to move that are attacked, lose material where they
 * stand, and lose material on every square they can go to (lichess tagger `is_trapped`).
 */
export function trappedPieces(fen: string): PieceOn[] {
  const c = new Chess(fen);
  if (c.inCheck()) return [];
  const owner = c.turn();
  const opp = other(owner);
  const out: PieceOn[] = [];
  for (const p of pieces(c, owner)) {
    if (p.type === 'p' || p.type === 'k' || see(fen, p.square, opp) <= 0) continue;
    const escapes = c
      .moves({ square: p.square, verbose: true })
      .some((m) => (m.captured && VALUE[m.captured] >= VALUE[p.type]) || see(m.after, m.to, opp) <= 0);
    if (!escapes) out.push(p);
  }
  return out;
}

/**
 * The king of `color` sits on its first rank with no flight square on the second rank, and the
 * enemy has a rook or queen.
 */
export function backRankWeak(fen: string, color: Color): boolean {
  const c = scratch(fen);
  const k = kingSquare(c, color);
  if (!k) return false;
  const home = color === 'w' ? 0 : 7;
  const fwd = color === 'w' ? 1 : -1;
  if (rankOf(k) !== home) return false;
  if (!pieces(c, other(color)).some((p) => p.type === 'r' || p.type === 'q')) return false;
  for (let df = -1; df <= 1; df++) {
    const t = squareAt(fileOf(k) + df, home + fwd);
    if (!t) continue;
    const occ = c.get(t);
    if (!(occ && occ.color === color) && !c.isAttacked(t, other(color))) return false;
  }
  return true;
}

/** Checkmate delivered along the mated king's first rank (lichess `back_rank_mate`). */
export function isBackRankMate(fen: string): boolean {
  const c = new Chess(fen);
  if (!c.isCheckmate()) return false;
  const loser = c.turn();
  const k = kingSquare(c, loser);
  if (!k) return false;
  const home = loser === 'w' ? '1' : '8';
  return k[1] === home && backRankWeak(fen, loser) && c.attackers(k, other(loser)).every((s) => s[1] === home);
}

// ------------------------------------------------------------------ motifs of one move

/** Everything `moveMotifs` learns about one move. */
export interface MoveMotifs {
  move: Move;
  /** FEN after the move. */
  after: string;
  motifs: readonly Motif[];
}

const MOTIF_CACHE_SIZE = 128;
const motifCache = new Map<string, MoveMotifs | null>();

/**
 * All motifs created by playing `uci` in `fen`, from the mover's point of view: mate/check,
 * promotion, free or losing capture, fork, pins and skewers (new ones, and existing pins the
 * moved piece now hits), discovered attacks, trapped enemy pieces, and new threats found with a
 * null-move probe (mate, promotion, one or two winning captures). Null for an illegal move.
 * Results are memoised; treat them as read-only.
 */
export function moveMotifs(fen: string, uci: string): MoveMotifs | null {
  const key = `${fen}|${uci}`;
  const hit = motifCache.get(key);
  if (hit !== undefined) return hit;
  let res: MoveMotifs | null = null;
  try {
    res = computeMoveMotifs(fen, uci);
  } catch {
    res = null;
  }
  if (motifCache.size >= MOTIF_CACHE_SIZE) motifCache.clear();
  motifCache.set(key, res);
  return res;
}

/** Runs `fn`, returning `fallback` if a detector throws on an odd position. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function computeMoveMotifs(fen: string, uci: string): MoveMotifs {
  const c = new Chess(fen);
  const me = c.turn();
  const opp = other(me);
  const before = scratch(fen);
  const move = c.move(parseUci(uci));
  const after = c.fen();
  const motifs: Motif[] = [];

  if (c.isCheckmate()) motifs.push({ kind: 'checkmate' });
  else if (c.inCheck()) {
    const k = kingSquare(c, opp);
    const checkers = k ? c.attackers(k, me) : [];
    motifs.push({ kind: 'check', double: checkers.length > 1, discovered: !checkers.includes(move.to) });
  }
  if (move.promotion) motifs.push({ kind: 'promotion', to: move.promotion });
  if (move.captured) {
    // SEE sees an empty target square for en passant: add the pawn taken.
    const g = see(fen, move.to, me, move.from) + (move.isEnPassant() ? 1 : 0);
    const square = move.isEnPassant() ? ((move.to[0] + move.from[1]) as Square) : move.to;
    const captured: PieceOn = { square, type: move.captured, color: opp };
    if (g >= VALUE[move.captured] && g > 0) {
      motifs.push({
        kind: 'freeCapture',
        captured,
        attackers: before.attackers(move.to, me).length,
        defenders: before.attackers(move.to, opp).length,
      });
    } else if (g < 0) motifs.push({ kind: 'losingCapture', captured, see: g });
  }

  // Squares of the pieces that moved (castling also moves a rook).
  const rank = me === 'w' ? '1' : '8';
  const active: Square[] = [move.to];
  if (move.isKingsideCastle()) active.push(`f${rank}` as Square);
  if (move.isQueensideCastle()) active.push(`d${rank}` as Square);

  let fork = safe(() => forkTargets(after, move.to), []);
  // A forking check must win something whatever the reply (a block or king move can defuse it).
  if (fork.some((t) => t.type === 'k') && !safe(() => checkForkHolds(after, move.to, fork), true)) fork = [];
  const moved = pieceAt(c, move.to);
  if (fork.length && moved) motifs.push({ kind: 'fork', by: moved, targets: fork });

  for (const sq of active) motifs.push(...safe(() => linesFrom(after, me, sq), []));
  // Exploiting an existing pin: a moved piece now attacks a pinned piece.
  const hitByMover = new Set(active.flatMap((sq) => attacksFrom(c, sq)));
  for (const l of safe(() => linesFrom(after, me), [])) {
    if (l.kind === 'pin' && !active.includes(l.by.square) && hitByMover.has(l.pinned.square)) {
      motifs.push({ ...l, exploit: true });
    }
  }

  // Discovered attacks: a slider behind the moved piece now hits something new.
  safe(() => {
    for (const s of pieces(c, me)) {
      if (active.includes(s.square) || !slideDirs(s.type).length) continue;
      const beforeHits = new Set(attacksFrom(before, s.square));
      for (const t of attacksFrom(c, s.square)) {
        const v = pieceAt(c, t);
        if (!v || v.color !== opp || beforeHits.has(t) || !between(s.square, t, move.from)) continue;
        if (v.type === 'k' || VALUE[v.type] > VALUE[s.type] || see(after, t, me) > 0) {
          motifs.push({ kind: 'discovered', by: s, target: v });
        }
      }
    }
  }, undefined);

  // Only pieces this move traps (not ones that were trapped already).
  const trappedBefore = safe(() => {
    const nf = nullMoveFen(fen);
    return nf ? trappedPieces(nf).map((p) => p.square) : [];
  }, [] as Square[]);
  for (const p of safe(() => trappedPieces(after), [])) {
    if (!trappedBefore.includes(p.square)) motifs.push({ kind: 'trapped', piece: p });
  }

  // A threat by a piece the opponent can simply take (for more than it captured) is no threat.
  const moverSafe = safe(() => see(after, move.to, opp) <= (move.captured ? VALUE[move.captured] : 0), true);

  // New threats: what could the mover do next if the opponent passed?
  if (!c.inCheck()) {
    safe(() => {
      const nf = nullMoveFen(after);
      if (!nf) return;
      const oldMates = new Set(mateInOne(fen));
      const probe = new Chess(nf);
      // A mate threatened by the moved piece is no threat when the opponent can simply take it.
      const byMover = (san: string) => {
        const m = probe.move(san);
        probe.undo();
        return m.from === move.to;
      };
      const mates = mateInOne(nf).filter((m) => !oldMates.has(m) && (moverSafe || !byMover(m)));
      if (mates.length) motifs.push({ kind: 'mateThreat', san: mates[0] });
      const oldPromos = new Set(promotionPushes(fen).map((p) => p.to));
      const promo = promotionPushes(nf).find((p) => !oldPromos.has(p.to));
      if (promo && !move.promotion) motifs.push({ kind: 'promotionThreat', san: promo.san });
      if (!moverSafe) return;
      // Targets already explained by a discovered attack are not repeated as plain threats.
      const oldTargets = new Set([
        ...winningCaptures(fen).map((w) => w.to),
        ...motifs.flatMap((m) => (m.kind === 'discovered' ? [m.target.square] : [])),
      ]);
      // One capture per target, the best one (winningCaptures sorts best first).
      const byTarget: WinningCapture[] = [];
      for (const w of winningCaptures(nf)) {
        if (!oldTargets.has(w.to) && !byTarget.some((x) => x.to === w.to)) byTarget.push(w);
      }
      if (byTarget.length >= 2 && !fork.length) {
        const threats = byTarget.slice(0, 2).map((w) => ({ san: w.san, target: w.target }));
        motifs.push({ kind: 'doubleThreat', threats });
      } else if (byTarget.length === 1 && !fork.length) {
        motifs.push({ kind: 'threat', san: byTarget[0].san, target: byTarget[0].target });
      }
    }, undefined);
  }

  // A plain attack on a bigger piece by a piece that is safe where it stands.
  if (!fork.length) {
    safe(() => {
      for (const t of attacksFrom(c, move.to)) {
        const v = pieceAt(c, t);
        if (!v || v.color !== opp || v.type === 'k' || VALUE[v.type] <= VALUE[move.piece]) continue;
        if (see(after, move.to, opp) <= 0) motifs.push({ kind: 'attacks', target: v });
      }
    }, undefined);
  }
  return { move, after, motifs: Object.freeze(motifs) };
}

/** Motif kinds that explain HOW material is won, in priority order. */
export const TACTICAL_KINDS: readonly MotifKind[] = [
  'fork',
  'skewer',
  'discovered',
  'pin',
  'trapped',
  'doubleThreat',
  'freeCapture',
  'mateThreat',
  'promotionThreat',
  'promotion',
];

const PRIORITY: readonly MotifKind[] = [
  'checkmate',
  ...TACTICAL_KINDS,
  'threat',
  'check',
  'attacks',
  'losingCapture',
  'backRank',
  'hanging',
];

/** Sorts motifs: those about a square in `hot` (where material changes hands) first, then by kind. */
export function rankMotifs(ms: readonly Motif[], hot: readonly Square[] = []): Motif[] {
  const rel = (m: Motif) => (motifSquares(m).some((s) => hot.includes(s)) ? 0 : 1);
  return [...ms].sort((a, b) => rel(a) - rel(b) || PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
}

// ------------------------------------------------------------------ material along a line

export type Counts = Record<PieceSymbol, number>;
const zero = (): Counts => ({ p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 });

/** Piece counts per colour. */
export function counts(board: Chess): Record<Color, Counts> {
  const out = { w: zero(), b: zero() };
  for (const p of pieces(board)) out[p.color][p.type]++;
  return out;
}

/** Material value (pawns, king excluded) of a partial piece count. */
export function worth(x: Partial<Counts>): number {
  let s = 0;
  for (const k of Object.keys(x) as PieceSymbol[]) if (k !== 'k') s += (x[k] ?? 0) * VALUE[k];
  return s;
}

/** Material balance in pawns from `pov`'s side. */
export function materialBalance(board: Chess, pov: Color): number {
  const k = counts(board);
  return worth(k[pov]) - worth(k[other(pov)]);
}

/** What changes hands along an engine line. */
export interface MaterialOutcome {
  /** Pawn units won (+) or lost (-) by `pov`. */
  net: number;
  /** Enemy material removed, after cancelling like-for-like trades. */
  won: Partial<Counts>;
  /** Own material removed (promoted pawns excluded; a promoted piece taken again counts as a pawn). */
  lost: Partial<Counts>;
  /** Promotions by `pov` inside the window whose new piece is still on the board at its end. */
  promotions: number;
  /** The piece types of those promotions (e.g. ['q'], or ['n'] for an underpromotion). */
  promoted: PieceSymbol[];
  /** The same for the other side: promotions `pov` allows inside the window. */
  theirPromoted: PieceSymbol[];
  /** SAN of the plies consumed. */
  sans: string[];
  /** Squares where `pov` captured something (for motif relevance). */
  captureSquares: Square[];
  /** Position at the end of the counted window. */
  fen: string;
  /** The window ends on a quiet ply (false: the line stops in the middle of an exchange). */
  settled: boolean;
}

/** Plays a UCI line from `fen` (stopping at the first illegal move), returning SAN, moves and FENs. */
export function playLine(
  fen: string,
  pv: readonly string[],
  max = 99,
): { sans: string[]; moves: Move[]; fens: string[] } {
  const sans: string[] = [];
  const moves: Move[] = [];
  const fens = [fen];
  try {
    const c = new Chess(fen);
    for (const u of pv.slice(0, max)) {
      const m = c.move(parseUci(u));
      sans.push(m.san);
      moves.push(m);
      fens.push(c.fen());
    }
  } catch {
    /* stop at the first illegal move */
  }
  return { sans, moves, fens };
}

/**
 * Material is settled: the side to move has no winning capture and at most one piece en prise,
 * which it can simply move away (it is not trapped).
 */
function calm(fen: string): boolean {
  const stm: Color = fen.split(' ')[1] === 'b' ? 'b' : 'w';
  if (hangingPieces(fen, other(stm)).length) return false;
  // A pawn that can queen next move (for either side) is not settled material either.
  if (promotionPushes(fen).length) return false;
  const nf = nullMoveFen(fen);
  if (nf && promotionPushes(nf).length) return false;
  const own = hangingPieces(fen, stm);
  if (own.length === 0) return true;
  return own.length === 1 && !trappedPieces(fen).some((p) => p.square === own[0].piece.square);
}

const ORDER: PieceSymbol[] = ['q', 'r', 'b', 'n', 'p'];

/**
 * Material won or lost by `pov` along an engine line. Plays up to `maxPlies` and stops at the
 * first ply >= 2 that is quiet (no capture, promotion or check, next move not a capture) and calm
 * (pending forks and double attacks are cashed in first). Falls back to the last quiet ply; if the
 * window ends mid-exchange the last capture square is settled with SEE. Like-for-like trades are
 * cancelled (identical types, then bishop for knight).
 */
export function materialOutcome(fen: string, pv: readonly string[], pov: Color, maxPlies = 10): MaterialOutcome {
  const empty: MaterialOutcome = {
    net: 0,
    won: {},
    lost: {},
    promotions: 0,
    promoted: [],
    theirPromoted: [],
    sans: [],
    captureSquares: [],
    fen,
    settled: true,
  };
  const c = new Chess(fen);
  const start = counts(c);
  type Promos = Record<Color, Partial<Counts>>;
  const snaps: {
    counts: Record<Color, Counts>;
    plies: number;
    promos: Promos;
    adj: number;
    quiet: boolean;
    calm: boolean;
    fen: string;
  }[] = [];
  const sans: string[] = [];
  const caps: Square[] = [];
  // The first minor piece each side captured: a single net minor is named after it.
  const firstMinor: Partial<Record<Color, PieceSymbol>> = {};
  const promos: Promos = { w: {}, b: {} };
  for (let i = 0; i < Math.min(pv.length, maxPlies); i++) {
    let m: Move;
    try {
      m = c.move(parseUci(pv[i]));
    } catch {
      break;
    }
    sans.push(m.san);
    if (m.color === pov && m.captured) caps.push(m.to);
    if ((m.captured === 'n' || m.captured === 'b') && !firstMinor[m.color]) firstMinor[m.color] = m.captured;
    if (m.promotion) promos[m.color][m.promotion] = (promos[m.color][m.promotion] ?? 0) + 1;
    const next = pv[i + 1];
    const nextCaptures = !!next && !!c.get(next.slice(2, 4) as Square);
    const quiet = !m.isCapture() && !m.isPromotion() && !c.inCheck() && !nextCaptures;
    let adj = 0;
    if (m.isCapture()) {
      const g = see(c.fen(), m.to, c.turn());
      adj = c.turn() === pov ? g : -g;
    }
    const isCalm = quiet && calm(c.fen());
    snaps.push({
      counts: counts(c),
      plies: i + 1,
      promos: { w: { ...promos.w }, b: { ...promos.b } },
      adj,
      quiet,
      calm: isCalm,
      fen: c.fen(),
    });
    if (i >= 1 && isCalm) break;
  }
  const rev = [...snaps].reverse();
  const pick =
    rev.find((s) => s.plies >= 2 && s.calm) ?? rev.find((s) => s.plies >= 2 && s.quiet) ?? snaps[snaps.length - 1];
  if (!pick) return empty;
  const end = pick.counts;
  const them = other(pov);
  // Pieces each side lost inside the window. A promoted pawn is not lost; a promoted piece that is
  // captured again is named as the pawn it was (and its promotion no longer counts).
  const removed = (side: Color): { lost: Partial<Counts>; kept: Partial<Counts> } => {
    const p = pick.promos[side];
    const kept: Partial<Counts> = { ...p };
    let promoted = 0;
    for (const t of ORDER) promoted += p[t] ?? 0;
    const lost: Partial<Counts> = {};
    for (const t of ORDER) {
      const d = start[side][t] - end[side][t] + (p[t] ?? 0) - (t === 'p' ? promoted : 0);
      if (d > 0) lost[t] = d;
    }
    for (const t of ORDER) {
      const back = Math.min(kept[t] ?? 0, t === 'p' ? 0 : (lost[t] ?? 0));
      if (back) {
        kept[t] = (kept[t] ?? 0) - back;
        lost[t] = (lost[t] ?? 0) - back;
        lost.p = (lost.p ?? 0) + back;
      }
    }
    return { lost, kept };
  };
  const mine = removed(pov);
  const theirs = removed(them);
  const won: Partial<Counts> = theirs.lost;
  const lost: Partial<Counts> = mine.lost;
  for (const t of ORDER) {
    const m = Math.min(won[t] ?? 0, lost[t] ?? 0);
    if (m) {
      won[t] = (won[t] ?? 0) - m;
      lost[t] = (lost[t] ?? 0) - m;
    }
  }
  const cross = Math.min((won.b ?? 0) + (won.n ?? 0), (lost.b ?? 0) + (lost.n ?? 0));
  for (let k = 0; k < cross; k++) {
    for (const w of [won, lost]) {
      if (w.b) w.b--;
      else if (w.n) w.n--;
    }
  }
  for (const w of [won, lost]) for (const k of Object.keys(w) as PieceSymbol[]) if (!w[k]) delete w[k];
  // Bishop-for-bishop plus a knight reads "wins a knight" even when the bishop was taken first:
  // name a single net minor after the first minor piece actually captured.
  for (const [w, side] of [[won, pov], [lost, them]] as const) {
    const first = firstMinor[side];
    if (first && (w.b ?? 0) + (w.n ?? 0) === 1 && !w[first]) {
      delete w.b;
      delete w.n;
      w[first] = 1;
    }
  }
  const list = (x: Partial<Counts>) => ORDER.flatMap((t) => Array<PieceSymbol>(x[t] ?? 0).fill(t));
  const promoted = list(mine.kept);
  const theirPromoted = list(theirs.kept);
  const promoGain = (xs: PieceSymbol[]) => xs.reduce((n, t) => n + VALUE[t] - 1, 0);
  const net = worth(won) - worth(lost) + promoGain(promoted) - promoGain(theirPromoted) + (pick.quiet ? 0 : pick.adj);
  return {
    net,
    won,
    lost,
    promotions: promoted.length,
    promoted,
    theirPromoted,
    sans: sans.slice(0, pick.plies),
    captureSquares: caps,
    fen: pick.fen,
    settled: pick.quiet,
  };
}

// ------------------------------------------------------------------ principles

export type PrincipleKind =
  | 'castles'
  | 'kingWalk'
  | 'develops'
  | 'centrePawn'
  | 'centreControl'
  | 'earlyQueen'
  | 'edgePawn'
  | 'fPawn'
  | 'knightRim'
  | 'luft'
  | 'passedPawn'
  | 'rookSeventh'
  | 'openFile'
  | 'opensLine'
  | 'tradeAhead'
  | 'trade'
  | 'bishopPair'
  | 'kingActive'
  | 'activates';

/** A general principle a move follows (good) or breaks (bad). */
export interface Principle {
  kind: PrincipleKind;
  good: boolean;
  /** The moved piece. */
  piece: PieceSymbol;
  /** Destination square of the move. */
  to: Square;
  /** Captured piece, for trades. */
  captured?: PieceSymbol;
  /** The piece a pawn move frees ('opensLine'). */
  freed?: PieceOn;
}

const CENTRE: Square[] = ['d4', 'e4', 'd5', 'e5'];

function isPassed(board: Chess, pawn: Square, color: Color): boolean {
  const f = fileOf(pawn);
  const r = rankOf(pawn);
  const ahead = (s: Square) => (color === 'w' ? rankOf(s) > r : rankOf(s) < r);
  return !pieces(board, other(color)).some(
    (p) => p.type === 'p' && Math.abs(fileOf(p.square) - f) <= 1 && ahead(p.square),
  );
}

const centreDistance = (s: Square) => Math.max(Math.abs(fileOf(s) * 2 - 7), Math.abs(rankOf(s) * 2 - 7));

/**
 * Opening and positional principles for `uci` in `fen`, most important first: castling, king
 * walks, development, centre pawns and control, early queen, edge and f-pawn moves, knights on
 * the rim, escape squares, passed pawns, rooks on the 7th and open files, freeing a bishop,
 * trades (and the bishop pair), king activity in endgames and piece activity.
 */
export function principles(fen: string, uci: string): Principle[] {
  const c = new Chess(fen);
  const me = c.turn();
  const fullmove = Number(fen.split(' ')[5]) || 1;
  const before = scratch(fen);
  const inCheckBefore = c.inCheck();
  const rightsBefore = c.getCastlingRights(me);
  const hasRights = rightsBefore.k || rightsBefore.q;
  const m = c.move(parseUci(uci));
  const after = c.fen();
  const out: Principle[] = [];
  const P = (kind: PrincipleKind, good: boolean, extra: Partial<Principle> = {}) =>
    out.push({ kind, good, piece: m.piece, to: m.to, ...extra });
  const nonPawn = pieces(before).reduce((n, p) => n + (p.type === 'p' || p.type === 'k' ? 0 : VALUE[p.type]), 0);
  const opening = fullmove <= 12 && nonPawn >= 40;
  const homeRank = me === 'w' ? '1' : '8';
  const minorsHome = pieces(before, me).filter(
    (p) => (p.type === 'n' || p.type === 'b') && p.square[1] === homeRank,
  ).length;
  const castles = m.isKingsideCastle() || m.isQueensideCastle();
  const relRank = (s: Square) => (me === 'w' ? rankOf(s) : 7 - rankOf(s));

  if (castles) P('castles', true);
  else if (m.piece === 'k' && hasRights && !inCheckBefore) P('kingWalk', false);
  if (opening && (m.piece === 'n' || m.piece === 'b') && m.from[1] === homeRank) P('develops', true);
  if (opening && m.piece === 'p' && CENTRE.includes(m.to) && !m.captured) P('centrePawn', true);
  if (opening && m.piece === 'q' && fullmove <= 6 && minorsHome >= 3 && !m.captured) P('earlyQueen', false);
  if (opening && m.piece === 'p' && (m.to[0] === 'a' || m.to[0] === 'h') && minorsHome >= 2) P('edgePawn', false);
  if (opening && m.piece === 'p' && m.from[0] === 'f' && !m.captured && hasRights && fullmove <= 10) P('fPawn', false);
  if (opening && m.piece === 'n' && (m.to[0] === 'a' || m.to[0] === 'h') && !m.captured) P('knightRim', false);
  const ctrl = (b: Chess) => CENTRE.reduce((n, s) => n + b.attackers(s, me).length, 0);
  if (opening && !out.some((p) => p.kind === 'centrePawn') && ctrl(c) - ctrl(before) >= 2) P('centreControl', true);
  const king = kingSquare(before, me);
  const luft =
    !opening &&
    m.piece === 'p' &&
    !m.captured &&
    Math.abs(rankOf(m.to) - rankOf(m.from)) <= 2 &&
    !!king &&
    Math.abs(fileOf(m.from) - fileOf(king)) <= 1 &&
    safe(() => backRankWeak(fen, me) && !backRankWeak(after, me), false);
  if (luft) P('luft', true);
  if (m.piece === 'p' && !m.promotion && relRank(m.to) >= 4 && isPassed(c, m.to, me)) P('passedPawn', true);
  if (m.piece === 'r') {
    const enemyKing = kingSquare(c, other(me));
    const enemySeventhPawns = pieces(c, other(me)).some((p) => p.type === 'p' && relRank(p.square) === 6);
    const target = (enemyKing && relRank(enemyKing) === 7) || enemySeventhPawns;
    if (relRank(m.to) === 6 && relRank(m.from) !== 6 && target) {
      P('rookSeventh', true);
    } else if (m.from[0] !== m.to[0] && !pieces(c).some((p) => p.type === 'p' && p.square[0] === m.to[0])) {
      P('openFile', true);
    }
  }
  if (m.piece === 'p' && !m.captured && !m.promotion) {
    let best: { p: PieceOn; gain: number } | null = null;
    for (const s of pieces(c, me)) {
      if (s.type !== 'b' && s.type !== 'q') continue;
      const gain = attacksFrom(c, s.square).length - attacksFrom(before, s.square).length;
      if (gain >= 3 && (!best || gain > best.gain)) best = { p: s, gain };
    }
    if (best) P('opensLine', true, { freed: best.p });
  }
  if (m.captured) {
    const even = Math.abs(see(fen, m.to, me, m.from)) < 1;
    const bishopPair = pieces(before, me).filter((p) => p.type === 'b').length === 2;
    if (even && m.piece === 'b' && m.captured === 'n' && bishopPair) {
      P('bishopPair', false, { captured: m.captured });
    }
    if (even && m.captured !== 'p' && materialBalance(before, me) >= 2) P('tradeAhead', true, { captured: m.captured });
    else if (even && (m.captured !== 'p' || m.piece === 'p')) P('trade', true, { captured: m.captured });
  }
  if (m.piece === 'k' && !castles && !inCheckBefore && nonPawn <= 20 && centreDistance(m.to) < centreDistance(m.from)) {
    P('kingActive', true);
  }
  if ((m.piece === 'n' || m.piece === 'b' || m.piece === 'r' || m.piece === 'q') && !m.captured && !castles) {
    const gain = attacksFrom(c, m.to).length - attacksFrom(before, m.from).length;
    if (gain >= 3 && !out.length) P('activates', true);
  }
  return out;
}
