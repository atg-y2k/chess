/**
 * Elo-scaled move selection for the computer opponent (Elo 100..3200). Pure: no DOM, no engine I/O.
 *
 * The engine always searches at FULL strength (we never set UCI_LimitStrength / Skill Level); all
 * weakening happens here, in JS, from the MultiPV lines, so a move is a pure function of
 * (position, search result, plan, rng) and games are replayable with a seeded rng.
 *
 * Three bands (calibrated with ~1,500 engine games, see research/strength.md):
 *  - 100..1319 `custom`: the engine scores EVERY legal move (MultiPV 256, depth 2). The bot then
 *    plays like a weak human: a softmax over win%/centipawn loss plus surface "appeal" (captures,
 *    checks), "oversight" moves that ignore the opponent's reply, and probabilistic mate vision.
 *  - 1320..3199 `skill`: Stockfish's own Skill Level weakening (`Skill::pick_best`) re-implemented
 *    on MultiPV-4 lines searched to depth level+1. The integer level is stochastically rounded per
 *    move (Fairy-Stockfish idea) so strength changes smoothly with Elo.
 *  - 3200 `full`: the engine's best move.
 *
 * Decided positions deliberately deviate from the weakening above (and from upstream pick_best, which
 * picks almost uniformly between mate-in-1 and mate-in-2 lines and so never finishes a won ending):
 *  - Skill band: a forced mate among the lines is always played, shortest first.
 *  - Conversion (a lone king, or king + pawns / one minor piece, against at least a rook's worth
 *    more material, with a clearly winning score): an extra deep search (`conversionSearchFor`) gives a
 *    move that makes progress. The skill band plays it; the custom band plays it with an
 *    Elo-dependent probability and otherwise stays human-ish but only among moves that keep the win
 *    (never hanging the queen to a bare king, never stalemating).
 *  - Repetition guard: when the bot is clearly better, moves that complete a threefold repetition
 *    (or let the opponent complete one with a single reply) are avoided, using the game's position
 *    counts (`ChooseContext.positions`; BotPlayer replays the move history for them). BotPlayer also
 *    gives the engine the game's moves (`SearchOptions.history`), so Stockfish scores a move that
 *    repeats a position for the third time as a draw. The guard is still needed: weakened levels do
 *    not always play the engine's top move, and it also covers the opponent's repeating reply.
 *
 * Searches are depth/node limited, never `movetime`: iOS freezes workers in the background and a
 * wall-clock limit would return a shallow move on resume. Node caps are sized for ~0.5-0.8 Mnps
 * (iPhone estimate) so the strongest levels think at most ~2.5 s.
 */
import { Chess, type Move, type Square } from 'chess.js';
import type { AnalysisResult, PvLine, Score, SearchOptions } from '../engine/types';

export const MIN_ELO = 100;
export const MAX_ELO = 3200;
/** At and above this Elo the bot uses the (emulated) Stockfish Skill Level. */
export const ENGINE_SWITCH_ELO = 1320;
/** At and above this Elo the bot plays the engine's best move. */
export const FULL_STRENGTH_ELO = 3200;

/** Safety cap for the custom band (depth 2 normally needs far fewer nodes). */
export const CUSTOM_NODES_CAP = 250_000;
/** Node cap for skill levels: ~1.5-2.4 s at 0.5-0.8 Mnps; binds only for levels >= ~16. */
export const SKILL_NODES_CAP = 1_200_000;
/** Node budget for full strength (MultiPV 1 reaches depth ~18-22 with it). */
export const FULL_NODES = 1_200_000;
const FULL_DEPTH = 30;

/**
 * Conversion search (see `conversionSearchFor`): deep enough to make progress in K+Q/K+R vs K and
 * similar endings (a few thousand to ~300k nodes there, ~0.1-0.5 s on an iPhone).
 */
export const CONVERT_DEPTH = 14;
export const CONVERT_NODES = 300_000;
/**
 * Conversion mode needs at least this score (cp, bot's POV; damped with the 50-move counter like
 * Stockfish's eval). Shallow KRK scores are only ~+300..+500.
 */
export const CONVERT_MIN_CP = 200;
/** Custom band in conversion mode: only moves within this many cp of the best one are considered. */
const CONVERT_SAFE_CP = 150;
/** The repetition guard is active when the bot's best score is at least this (cp, damped likewise). */
export const REPETITION_GUARD_CP = 150;

/**
 * Nominal Elo of integer Skill Level L: Stockfish's own fit (src/search.h, struct Skill) evaluated
 * at L; L1 = 1444 ... L19 = 3212. Anchored to CCRL 40/4 (engine scale, not human ratings).
 *
 * L0 is re-fitted to our own custom band instead (Stockfish's fit says 1347): in bot-vs-bot games
 * pure Level 0 (a depth-1 search) scored only ~40% against custom 1300/1319, i.e. it plays ~70 Elo
 * below the top of the custom band. Anchoring it at 1250 makes 1320 a Level 0/1 mix (36% Level 1)
 * so strength keeps rising across the band switch.
 */
export const SF_LEVEL_ELO = [
  1250, 1444, 1566, 1729, 1953, 2197, 2383, 2518, 2624, 2711, 2786, 2851, 2910, 2963, 3012, 3057, 3099, 3139, 3176, 3212,
];

/** Custom band (Elo < 1320): the engine scores every legal move and the bot errs like a human. */
export interface CustomPlan {
  mode: 'custom';
  elo: number;
  depth: number;
  multiPv: number;
  nodes: number;
  /** Softmax temperature on win%-point loss. */
  temperature: number;
  /** Softmax temperature on centipawn loss, in pawns (keeps won positions being converted). */
  cpTemp: number;
  /** Weight of surface appeal (captures, checks, ...) in the softmax. */
  salience: number;
  /** Per-move probability of an "oversight" move chosen on appeal alone. */
  blunderChance: number;
  /** Max win%-loss allowed for an oversight move (>= 100 = uncapped). */
  maxBlunderLoss: number;
  /** Softmax temperature over appeal in oversight mode (pawns). */
  appealTemp: number;
  /** Forced mates up to this length (moves) are visible... */
  mateSeeDepth: number;
  /** ...with this probability per move. */
  mateSeeProb: number;
  /** Conversion mode: probability of playing the deep search's move (else a safe human-ish move). */
  convertProb: number;
}

/** Skill band: Stockfish Skill Level, stochastically rounded between `lo` and `hi` per move. */
export interface SkillPlan {
  mode: 'skill';
  elo: number;
  lo: number;
  hi: number;
  /** Probability of playing a move at level `hi`. */
  pHi: number;
  nodes: number;
}

/** Full strength. */
export interface FullPlan {
  mode: 'full';
  elo: number;
  depth: number;
  nodes: number;
}

export type BotPlan = CustomPlan | SkillPlan | FullPlan;

/** A skill-band move with its integer level already drawn. */
export interface SkillMovePlan {
  mode: 'skillMove';
  elo: number;
  level: number;
  nodes: number;
}

/** Concrete plan for ONE move (see `planMove`). */
export type MovePlan = CustomPlan | SkillMovePlan | FullPlan;

export type MoveReason =
  | 'forced' // only legal move
  | 'engine' // full strength best move
  | 'skill' // emulated Stockfish pick_best
  | 'mate' // saw a short forced mate
  | 'convert' // deep-search move in a won ending (conversion mode)
  | 'oversight' // surface-appeal move ignoring the reply
  | 'softmax' // normal human-like choice
  | 'fallback'; // no usable engine lines

export interface ChosenMove {
  uci: string;
  reason: MoveReason;
}

// -------------------------------------------------------------------------------------------------
// Plans

//             elo  depth    T    Tcp   sal  blunder maxBL appealT mateD mateP convP
const KNOTS: number[][] = [
  [100, 2, 80.0, 5.0, 0.3, 0.6, 100, 2.0, 1, 0.25, 0.3],
  [250, 2, 58.0, 5.0, 0.5, 0.5, 100, 1.8, 1, 0.28, 0.35],
  [400, 2, 39.0, 5.0, 0.7, 0.39, 100, 1.55, 1, 0.33, 0.4],
  [550, 2, 24.0, 4.0, 0.6, 0.3, 100, 1.4, 1, 0.5, 0.47],
  [700, 2, 17.1, 3.4, 0.49, 0.234, 82, 1.3, 1, 0.62, 0.55],
  [850, 2, 13.0, 2.95, 0.4, 0.181, 67, 1.22, 2, 0.71, 0.62],
  [1000, 2, 10.3, 2.62, 0.32, 0.135, 54, 1.16, 2, 0.79, 0.7],
  [1150, 2, 8.3, 2.35, 0.26, 0.093, 43, 1.09, 3, 0.87, 0.8],
  [1320, 2, 6.7, 2.11, 0.18, 0.051, 31, 1.03, 3, 0.94, 0.9],
];

function interp(elo: number, col: number): number {
  if (elo <= KNOTS[0][0]) return KNOTS[0][col];
  for (let i = 1; i < KNOTS.length; i++) {
    if (elo <= KNOTS[i][0]) {
      const a = KNOTS[i - 1];
      const b = KNOTS[i];
      const t = (elo - a[0]) / (b[0] - a[0]);
      return a[col] + t * (b[col] - a[col]);
    }
  }
  return KNOTS[KNOTS.length - 1][col];
}

/** Clamps and rounds an Elo into the supported 100..3200 range (NaN -> 100). */
export function clampElo(elo: number): number {
  if (!Number.isFinite(elo)) return MIN_ELO;
  return Math.min(MAX_ELO, Math.max(MIN_ELO, Math.round(elo)));
}

/** The playing plan for a bot of this Elo (clamped to 100..3200). Compute once per game / Elo change. */
export function planForElo(eloIn: number): BotPlan {
  const elo = clampElo(eloIn);
  if (elo >= FULL_STRENGTH_ELO) return { mode: 'full', elo, depth: FULL_DEPTH, nodes: FULL_NODES };
  if (elo >= ENGINE_SWITCH_ELO) {
    let lo = 19;
    let hi = 19;
    let pHi = 0;
    if (elo <= SF_LEVEL_ELO[0]) {
      lo = hi = 0;
    } else {
      for (let L = 0; L < SF_LEVEL_ELO.length - 1; L++) {
        if (elo < SF_LEVEL_ELO[L + 1]) {
          lo = L;
          hi = L + 1;
          pHi = (elo - SF_LEVEL_ELO[L]) / (SF_LEVEL_ELO[L + 1] - SF_LEVEL_ELO[L]);
          break;
        }
      }
    }
    return { mode: 'skill', elo, lo, hi, pHi, nodes: SKILL_NODES_CAP };
  }
  return {
    mode: 'custom',
    elo,
    depth: Math.round(interp(elo, 1)),
    multiPv: 256,
    nodes: CUSTOM_NODES_CAP,
    temperature: interp(elo, 2),
    cpTemp: interp(elo, 3),
    salience: interp(elo, 4),
    blunderChance: interp(elo, 5),
    maxBlunderLoss: interp(elo, 6),
    appealTemp: interp(elo, 7),
    mateSeeDepth: Math.round(interp(elo, 8)),
    mateSeeProb: interp(elo, 9),
    convertProb: interp(elo, 10),
  };
}

/** Draws this move's concrete plan (stochastic skill rounding). Call once per bot move, before searching. */
export function planMove(plan: BotPlan, rng: () => number): MovePlan {
  if (plan.mode !== 'skill') return plan;
  const level = plan.hi !== plan.lo && rng() < plan.pHi ? plan.hi : plan.lo;
  return { mode: 'skillMove', elo: plan.elo, level, nodes: plan.nodes };
}

/**
 * Search limits for the bot's ChessEngine. Always full strength (no limitStrengthElo / skillLevel)
 * and never movetime: depth plus a node cap.
 */
export function searchOptionsFor(mp: MovePlan): SearchOptions {
  switch (mp.mode) {
    case 'custom':
      return { depth: mp.depth, nodes: mp.nodes, multiPv: mp.multiPv };
    case 'skillMove':
      return { depth: mp.level + 1, nodes: mp.nodes, multiPv: 4 };
    case 'full':
      return { depth: mp.depth, nodes: mp.nodes, multiPv: 1 };
  }
}

// -------------------------------------------------------------------------------------------------
// Scores

/** lichess win% (0..100) for the side a centipawn score belongs to. */
export const winPct = (cp: number): number => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

/** Effective centipawns of a score: mates beyond any real eval, shorter mates better, longer defence better. */
export function scoreCp(score: Score): number {
  if (score.kind === 'mate') {
    if (score.value === 0) return -3000;
    return score.value > 0 ? 3000 - 10 * score.value : -3000 - 10 * score.value;
  }
  return Math.max(-2500, Math.min(2500, score.value));
}

/** PawnValue (208 internal units) expressed in UCI-printed cp for this material (src/uci.cpp to_cp). */
export function sfPawnCp(fen: string): number {
  const V: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  let mat = 0;
  for (const ch of fen.split(' ')[0]) mat += V[ch.toLowerCase()] ?? 0;
  const m = Math.min(78, Math.max(17, mat)) / 58;
  const a = ((-142.72052667 * m + 372.35176398) * m - 340.71073572) * m + 415.23490212;
  return (100 * 208) / a;
}

/** A usable engine line: legal first move + its score. */
interface Cand {
  uci: string;
  cp: number;
  /** Mate distance (side-to-move POV) when the score is a mate. */
  mate?: number;
}

/**
 * Exact port of Stockfish `Skill::pick_best` (src/search.cpp) on UCI-printed scores, with our rng.
 * `cands` must be non-empty and sorted best first.
 */
function sfPickBest(cands: Cand[], level: number, rng: () => number, fen: string): string {
  const sc = cands.map((c) =>
    c.mate !== undefined ? (c.mate > 0 ? 32000 - 2 * c.mate : -32000 - 2 * c.mate) : c.cp,
  );
  const top = Math.max(...sc);
  const min = Math.min(...sc);
  const delta = Math.min(top - min, sfPawnCp(fen));
  const weakness = 120 - 2 * level;
  let maxScore = -Infinity;
  let best = cands[0].uci;
  for (let i = 0; i < cands.length; i++) {
    const r = Math.floor(rng() * 4294967296) % Math.trunc(weakness);
    const push = Math.trunc(Math.trunc(weakness * (top - sc[i]) + delta * r) / 128);
    if (sc[i] + push >= maxScore) {
      maxScore = sc[i] + push;
      best = cands[i].uci;
    }
  }
  return best;
}

// -------------------------------------------------------------------------------------------------
// Decided positions: mates, conversion, repetitions

const PIECE_VALUE: Record<string, number> = { n: 3, b: 3, r: 5, q: 9 };

/**
 * Material test for conversion mode: the side to move has at least a rook's worth more piece
 * material than the opponent, who has at most one minor piece (plus pawns), and enough to mate
 * (a queen, a rook, or a bishop with another minor piece).
 */
export function isConversionMaterial(fen: string): boolean {
  const [placement, turn] = fen.split(' ');
  if (!placement || (turn !== 'w' && turn !== 'b')) return false;
  const mine: Record<string, number> = { n: 0, b: 0, r: 0, q: 0 };
  let myValue = 0;
  let theirValue = 0;
  for (const ch of placement) {
    const t = ch.toLowerCase();
    const v = PIECE_VALUE[t];
    if (!v) continue;
    if ((ch === t) === (turn === 'b')) {
      mine[t]++;
      myValue += v;
    } else {
      theirValue += v;
    }
  }
  if (theirValue > 3 || myValue - theirValue < 5) return false;
  return mine.q > 0 || mine.r > 0 || (mine.b > 0 && mine.b + mine.n >= 2);
}

/**
 * A score threshold (cp) for this position, damped the way Stockfish damps its evaluation as the
 * 50-move counter rises (roughly by clock/200), so a won ending stays "won" near move 50.
 */
function damped(threshold: number, fen: string): number {
  const clock = Math.min(100, Math.max(0, Number(fen.split(' ')[4]) || 0));
  return threshold * (1 - clock / 200);
}

/** Conversion mode: a conversion ending (see `isConversionMaterial`) with a clearly winning best line. */
function isConverting(fen: string, cands: readonly Cand[]): boolean {
  return (
    cands.length > 0 && Math.max(...cands.map((c) => c.cp)) >= damped(CONVERT_MIN_CP, fen) && isConversionMaterial(fen)
  );
}

/** The shortest forced mate for the side to move among the lines, if any. */
function shortestMate(cands: readonly Cand[]): Cand | undefined {
  let best: Cand | undefined;
  for (const c of cands) if (c.mate !== undefined && c.mate > 0 && (!best || c.mate < (best.mate ?? 0))) best = c;
  return best;
}

/**
 * The extra search conversion mode needs, or null: the bot is clearly winning a conversion ending
 * (and, in the skill band, has no forced mate among its lines) while its own search is shallower
 * than CONVERT_DEPTH. BotPlayer runs it after the normal search and passes the result to
 * `chooseMove` as `ctx.deep`.
 */
export function conversionSearchFor(fen: string, result: AnalysisResult, mp: MovePlan): SearchOptions | null {
  if (mp.mode === 'full' || result.terminal || (searchOptionsFor(mp).depth ?? 0) >= CONVERT_DEPTH) return null;
  const info = legalInfo(fen);
  if (!info || info.moves.length < 2) return null;
  const cands = usableCands(result.lines ?? [], new Map(info.moves.map((m) => [uciOf(m), m] as const)));
  if (!isConverting(fen, cands) || (mp.mode === 'skillMove' && shortestMate(cands))) return null;
  return { depth: CONVERT_DEPTH, nodes: CONVERT_NODES, multiPv: 1 };
}

/**
 * Conversion mode, human-ish moves: does this move keep the win? It must not stalemate, nor leave a
 * queen or rook capturable for less (by a pawn or minor piece, or by the king when undefended).
 * Checked with chess.js: shallow MultiPV scores are not reliable enough for this (a depth-2 search
 * has been seen scoring a stalemating rook move at +6.5).
 */
function keepsTheWin(m: Move): boolean {
  const c = new Chess(m.after);
  if (c.isStalemate()) return false;
  const us = m.color;
  const them = us === 'w' ? 'b' : 'w';
  for (const row of c.board()) {
    for (const sq of row) {
      if (!sq || sq.color !== us || (sq.type !== 'q' && sq.type !== 'r')) continue;
      const attackers = c.attackers(sq.square, them);
      if (!attackers.length) continue;
      if (!c.isAttacked(sq.square, us) || attackers.some((a) => c.get(a)?.type !== 'k')) return false;
    }
  }
  return true;
}

/** First move of a (possibly partial) deep search, if legal here. */
function deepMoveOf(deep: AnalysisResult | undefined, legal: ReadonlyMap<string, Move>): string | undefined {
  if (!deep || deep.terminal) return undefined;
  const first = [...(deep.lines ?? [])].sort((a, b) => a.multipv - b.multipv)[0]?.pv?.[0];
  for (const uci of [deep.bestMove, first]) if (uci && legal.has(uci)) return uci;
  return undefined;
}

/** Repetition key of a FEN: placement, side to move, castling and en passant (no move counters). */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

/** The 64 squares of a FEN placement, a8..h8, a7..h1 ('' = empty). */
function expandPlacement(placement: string): string[] {
  const out: string[] = [];
  for (const ch of placement) {
    if (ch === '/') continue;
    if (ch >= '1' && ch <= '8') for (let i = 0; i < Number(ch); i++) out.push('');
    else out.push(ch);
  }
  return out;
}

const squareName = (i: number): Square => `${'abcdefgh'[i % 8]}${8 - Math.floor(i / 8)}` as Square;

/**
 * Legal moves (verbose, all from the same position) after which the game can end in a threefold
 * repetition: the move itself reaches a position already seen twice, or the opponent can with one
 * reply. `counts` = occurrences of each `positionKey` in the game so far.
 */
function repetitionMoves(moves: readonly Move[], counts: ReadonlyMap<string, number>): Set<string> {
  const out = new Set<string>();
  const twice = [...counts].filter(([, n]) => n >= 2).map(([k]) => k);
  if (!twice.length || !moves.length) return out;
  const twiceSet = new Set(twice);
  const me = moves[0].color;
  // Positions the opponent's reply could reach have us to move again.
  const targets = twice
    .map((key) => key.split(' '))
    .filter((f) => f[1] === me)
    .map((f) => ({ key: f.join(' '), board: expandPlacement(f[0]) }));
  for (const m of moves) {
    if (twiceSet.has(positionKey(m.after))) {
      out.add(uciOf(m));
      continue;
    }
    if (!targets.length) continue;
    const board = expandPlacement(m.after.split(' ')[0]);
    for (const t of targets) {
      // A repeating reply is a quiet piece move (captures and pawn moves are irreversible): exactly
      // one opponent piece on a different, previously empty square.
      const diff: number[] = [];
      for (let i = 0; i < 64 && diff.length <= 2; i++) if (board[i] !== t.board[i]) diff.push(i);
      if (diff.length !== 2) continue;
      const [from, to] = board[diff[0]] ? diff : [diff[1], diff[0]];
      const piece = board[from];
      if (!piece || board[to] || t.board[from] || t.board[to] !== piece) continue;
      if ((piece === piece.toLowerCase()) === (me === 'b')) continue; // our own piece: not a reply
      try {
        const c = new Chess(m.after);
        c.move({ from: squareName(from), to: squareName(to) });
        if (positionKey(c.fen()) === t.key) {
          out.add(uciOf(m));
          break;
        }
      } catch {
        /* not a legal reply */
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Move choice

const uciOf = (m: Move): string => m.from + m.to + (m.promotion ?? '');
const APPEAL_VALUE: Record<string, number> = { p: 1, n: 3, b: 3.2, r: 5, q: 9, k: 0 };

/** Surface "appeal" of a move to a weak human (pawn units): grabs, checks, activity. Ignores replies. */
export function appeal(m: Move, color: 'w' | 'b', ply: number): number {
  let a = 0;
  const castle = m.flags.includes('k') || m.flags.includes('q');
  if (m.captured) a += APPEAL_VALUE[m.captured];
  if (m.san.endsWith('#')) a += 4;
  else if (m.san.endsWith('+')) a += 1.2;
  if (m.promotion) a += m.promotion === 'q' ? 6 : 1;
  if (castle) a += 1.0;
  const dr = (+m.to[1] - +m.from[1]) * (color === 'w' ? 1 : -1);
  a += 0.25 * Math.max(-1, Math.min(2, dr));
  if (m.piece === 'k' && !castle) a -= 1.0;
  if (ply < 20 && (m.piece === 'n' || m.piece === 'b') && (m.from[1] === '1' || m.from[1] === '8')) a += 0.6;
  if (ply < 16 && m.piece === 'q') a -= 0.3;
  if (m.piece === 'p' && 'cdef'.includes(m.to[0]) && ply < 16) a += 0.3;
  return a;
}

function sampleIndex(weights: number[], rng: () => number): number {
  let s = 0;
  for (const w of weights) s += w;
  let r = rng() * s;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/** Engine lines whose first move is legal here, deduplicated, best (lowest multipv) first. */
function usableCands(lines: PvLine[], legal: Map<string, Move>): Cand[] {
  const out: Cand[] = [];
  const seen = new Set<string>();
  for (const l of [...lines].sort((a, b) => a.multipv - b.multipv)) {
    const uci = l.pv?.[0];
    if (!uci || seen.has(uci) || !legal.has(uci)) continue;
    seen.add(uci);
    out.push({ uci, cp: scoreCp(l.score), ...(l.score.kind === 'mate' ? { mate: l.score.value } : {}) });
  }
  return out;
}

/**
 * Legal moves of a FEN (null if invalid), memoised for the last few positions: chess.js verbose
 * move generation costs a few ms (it builds SAN and FENs for every move) and callers often ask twice.
 * The returned arrays are shared, so treat them as read-only.
 */
interface LegalInfo {
  moves: Move[];
  turn: 'w' | 'b';
  /** Plies played, derived from the FEN's move number. */
  ply: number;
}
const legalCache = new Map<string, LegalInfo | null>();
function legalInfo(fen: string): LegalInfo | null {
  if (legalCache.has(fen)) return legalCache.get(fen) ?? null;
  let info: LegalInfo | null = null;
  try {
    const chess = new Chess(fen);
    const turn = chess.turn();
    info = { moves: chess.moves({ verbose: true }), turn, ply: (chess.moveNumber() - 1) * 2 + (turn === 'b' ? 1 : 0) };
  } catch {
    info = null;
  }
  if (legalCache.size >= 16) legalCache.delete(legalCache.keys().next().value as string);
  legalCache.set(fen, info);
  return info;
}

/** Legal moves (verbose) of a FEN; [] if the FEN is invalid or the game is over. Read-only result. */
export function legalMovesOf(fen: string): readonly Move[] {
  return legalInfo(fen)?.moves ?? [];
}

/** Human-ish move without engine data: softmax over surface appeal. */
function fallbackMove(legal: readonly Move[], color: 'w' | 'b', ply: number, rng: () => number): ChosenMove {
  const w = legal.map((m) => Math.exp(appeal(m, color, ply)));
  return { uci: uciOf(legal[sampleIndex(w, rng)]), reason: 'fallback' };
}

/** Optional game context for `chooseMove` (both parts are optional; without them it still works). */
export interface ChooseContext {
  /** Result of the `conversionSearchFor` search, when one was run. */
  deep?: AnalysisResult;
  /**
   * Occurrences of each `positionKey` in the game so far, the current position included. Enables the
   * repetition guard (without them only the engine's own repetition detection is left, and only
   * when it was given the game's moves).
   */
  positions?: ReadonlyMap<string, number>;
}

/**
 * Chooses the bot's move from a full-strength search of `fen` (see `searchOptionsFor`).
 * Pure and deterministic given `rng`. Never returns an illegal move: engine lines are checked
 * against chess.js, and without usable lines (aborted search, engine failure) it falls back to a
 * human-ish heuristic move. Returns null only when `fen` has no legal moves (or is invalid).
 */
export function chooseMove(
  fen: string,
  result: AnalysisResult,
  mp: MovePlan,
  rng: () => number,
  ctx: ChooseContext = {},
): ChosenMove | null {
  const info = legalInfo(fen);
  if (!info || !info.moves.length) return null;
  const legalList = info.moves;
  if (legalList.length === 1) return { uci: uciOf(legalList[0]), reason: 'forced' };
  const legal = new Map(legalList.map((m) => [uciOf(m), m] as const));
  const color = info.turn;
  const ply = info.ply;
  let cands = result.terminal ? [] : usableCands(result.lines ?? [], legal);

  if (mp.mode === 'full') {
    const best = result.bestMove && legal.has(result.bestMove) ? result.bestMove : cands[0]?.uci;
    return best ? { uci: best, reason: 'engine' } : fallbackMove(legalList, color, ply, rng);
  }

  const converting = isConverting(fen, cands);
  // Repetition guard: while clearly better, avoid moves that let the game end in a threefold
  // repetition, as long as a clearly better line remains.
  const guardCp = damped(REPETITION_GUARD_CP, fen);
  let repeat = new Set<string>();
  if (ctx.positions && cands.length && Math.max(...cands.map((c) => c.cp)) >= guardCp) {
    repeat = repetitionMoves(legalList, ctx.positions);
    const keep = cands.filter((c) => !repeat.has(c.uci));
    if (repeat.size && keep.length && Math.max(...keep.map((c) => c.cp)) >= guardCp) cands = keep;
    else repeat = new Set();
  }

  if (mp.mode === 'skillMove') {
    if (!cands.length) {
      if (result.bestMove && legal.has(result.bestMove)) return { uci: result.bestMove, reason: 'skill' };
      return fallbackMove(legalList, color, ply, rng);
    }
    // A seen forced mate is always played, shortest first (pick_best would dither between mates).
    const mate = shortestMate(cands);
    if (mate) return { uci: mate.uci, reason: 'mate' };
    if (converting) {
      // Our own lines are deep enough at high levels; otherwise the extra conversion search.
      const deep = (searchOptionsFor(mp).depth ?? 0) >= CONVERT_DEPTH ? cands[0].uci : deepMoveOf(ctx.deep, legal);
      if (deep && !repeat.has(deep)) return { uci: deep, reason: 'convert' };
    }
    return { uci: sfPickBest(cands, mp.level, rng, fen), reason: 'skill' };
  }

  // Custom band.
  if (!cands.length) return fallbackMove(legalList, color, ply, rng);

  // 1) Mate vision: short forced mates are seen with probability mateSeeProb, else invisible this move.
  const mates = cands
    .filter((c) => c.mate !== undefined && c.mate > 0 && c.mate <= mp.mateSeeDepth)
    .sort((a, b) => (a.mate ?? 0) - (b.mate ?? 0));
  let blind = new Set<string>();
  if (mates.length) {
    if (rng() < mp.mateSeeProb) return { uci: mates[0].uci, reason: 'mate' };
    blind = new Set(mates.map((c) => c.uci));
    if (blind.size < cands.length) cands = cands.filter((c) => !blind.has(c.uci));
    else blind = new Set();
  }
  let pool0 = legalList.filter((m) => !blind.has(uciOf(m)) && !repeat.has(uciOf(m)));

  const bestCp = Math.max(...cands.map((c) => c.cp));
  const bestW = winPct(bestCp);
  const known = new Map(cands.map((c) => [c.uci, c.cp] as const));
  const worstCp = Math.min(...cands.map((c) => c.cp));
  const cpOf = (m: Move) => known.get(uciOf(m)) ?? worstCp - 50;
  const dW = (m: Move) => bestW - winPct(cpOf(m));
  const dCp = (m: Move) => Math.min(bestCp - cpOf(m), 1500);

  // Conversion mode: often the deep search's move; otherwise only moves that keep the win (no
  // hanging the queen to a bare king, no stalemate), still chosen the human-ish way below.
  if (converting) {
    const deep = deepMoveOf(ctx.deep, legal);
    if (deep && !blind.has(deep) && !repeat.has(deep) && rng() < mp.convertProb) return { uci: deep, reason: 'convert' };
    const close = pool0.filter((m) => dCp(m) <= CONVERT_SAFE_CP);
    const sound = close.filter(keepsTheWin);
    pool0 = sound.length ? sound : close;
  }

  // 2) Oversight: a surface-appeal move that ignores the reply; loss capped by maxBlunderLoss.
  if (rng() < mp.blunderChance) {
    const pool = pool0.filter((m) => mp.maxBlunderLoss >= 100 || dW(m) <= mp.maxBlunderLoss);
    if (pool.length) {
      const w = pool.map((m) => Math.exp(appeal(m, color, ply) / mp.appealTemp));
      return { uci: uciOf(pool[sampleIndex(w, rng)]), reason: 'oversight' };
    }
  }

  // 3) Normal: softmax(-dW/T - dCp/(100*Tcp) + salience*appeal) over all visible legal moves.
  const logits = pool0.map(
    (m) => -dW(m) / mp.temperature - dCp(m) / (100 * mp.cpTemp) + mp.salience * appeal(m, color, ply),
  );
  const mx = Math.max(...logits);
  const w = logits.map((z) => Math.exp(z - mx));
  return { uci: uciOf(pool0[sampleIndex(w, rng)]), reason: 'softmax' };
}

// -------------------------------------------------------------------------------------------------
// Think time

export interface PositionDifficulty {
  /** Engine lines within 10 win% of the best one. */
  goodMoves: number;
  /** One move clearly stands out (>= 25 win% ahead of the second line). */
  obvious: boolean;
}

/** How "hard" a position looks from its MultiPV lines (drives the visible think time). */
export function positionDifficulty(result: AnalysisResult): PositionDifficulty {
  const w = (result.lines ?? [])
    .filter((l) => l.pv?.length)
    .map((l) => winPct(scoreCp(l.score)))
    .sort((a, b) => b - a);
  if (!w.length) return { goodMoves: 0, obvious: false };
  return { goodMoves: w.filter((x) => w[0] - x <= 10).length, obvious: w.length >= 2 && w[0] - w[1] >= 25 };
}

export interface ThinkTimeParams {
  elo: number;
  /** Plies already played in the game. */
  ply: number;
  source: 'book' | 'engine' | 'forced';
  legalMoves: number;
  /** From `positionDifficulty` (engine moves). */
  goodMoves?: number;
  /** A recapture / only-move / mate: answered quickly. */
  obvious?: boolean;
}

/** Standard normal draw (Box-Muller, two rng calls). */
function gaussian(rng: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

/**
 * Human-like visible think time in ms, INCLUDING the engine's search time (the caller waits only
 * for the remainder). Weak bots, forced, book and obvious moves are quick; strong bots in
 * positions with many good options take longer. Deterministic given rng.
 */
export function thinkTimeMs(p: ThinkTimeParams, rng: () => number): number {
  const elo = clampElo(p.elo);
  if (p.source === 'forced' || p.legalMoves <= 1) return Math.round(250 + 200 * rng());
  if (p.source === 'book') {
    const t = (300 + 0.15 * elo) * Math.exp(0.35 * gaussian(rng)); // ~315 ms @100 ... ~780 ms @3200
    return Math.round(Math.min(1400, Math.max(250, t)));
  }
  let t = (500 + 0.3 * elo) * Math.exp(0.45 * gaussian(rng)); // median ~530 ms @100 ... ~1460 ms @3200
  if (p.ply < 10) t *= 0.6; // opening moves are quick
  if ((p.goodMoves ?? 0) >= 4) t *= 1.25; // many reasonable options
  if (p.obvious) t *= 0.55;
  return Math.round(Math.min(4000, Math.max(300, t)));
}

// -------------------------------------------------------------------------------------------------
// Randomness

/** Seedable PRNG (mulberry32) returning floats in [0, 1). Seed per game to make games replayable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a hash of a string, e.g. a game id, for seeding `mulberry32`. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
