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
 * Searches are depth/node limited, never `movetime`: iOS freezes workers in the background and a
 * wall-clock limit would return a shallow move on resume. Node caps are sized for ~0.5-0.8 Mnps
 * (iPhone estimate) so the strongest levels think at most ~2.5 s.
 */
import { Chess, type Move } from 'chess.js';
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
 * Nominal Elo of integer Skill Level L: Stockfish's own fit (src/search.h, struct Skill) evaluated
 * at L; L0 = 1347 ... L19 = 3212. Anchored to CCRL 40/4 (engine scale, not human ratings).
 */
export const SF_LEVEL_ELO = [
  1347, 1444, 1566, 1729, 1953, 2197, 2383, 2518, 2624, 2711, 2786, 2851, 2910, 2963, 3012, 3057, 3099, 3139, 3176, 3212,
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
  | 'oversight' // surface-appeal move ignoring the reply
  | 'softmax' // normal human-like choice
  | 'fallback'; // no usable engine lines

export interface ChosenMove {
  uci: string;
  reason: MoveReason;
}

// -------------------------------------------------------------------------------------------------
// Plans

//             elo  depth    T    Tcp   sal  blunder maxBL appealT mateD mateP
const KNOTS: number[][] = [
  [100, 2, 80.0, 5.0, 0.3, 0.6, 100, 2.0, 1, 0.25],
  [250, 2, 58.0, 5.0, 0.5, 0.5, 100, 1.8, 1, 0.28],
  [400, 2, 39.0, 5.0, 0.7, 0.39, 100, 1.55, 1, 0.33],
  [550, 2, 24.0, 4.0, 0.6, 0.3, 100, 1.4, 1, 0.5],
  [700, 2, 17.1, 3.4, 0.49, 0.234, 82, 1.3, 1, 0.62],
  [850, 2, 13.0, 2.95, 0.4, 0.181, 67, 1.22, 2, 0.71],
  [1000, 2, 10.3, 2.62, 0.32, 0.135, 54, 1.16, 2, 0.79],
  [1150, 2, 8.3, 2.35, 0.26, 0.093, 43, 1.09, 3, 0.87],
  [1320, 2, 6.7, 2.11, 0.18, 0.051, 31, 1.03, 3, 0.94],
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

/**
 * Chooses the bot's move from a full-strength search of `fen` (see `searchOptionsFor`).
 * Pure and deterministic given `rng`. Never returns an illegal move: engine lines are checked
 * against chess.js, and without usable lines (aborted search, engine failure) it falls back to a
 * human-ish heuristic move. Returns null only when `fen` has no legal moves (or is invalid).
 */
export function chooseMove(fen: string, result: AnalysisResult, mp: MovePlan, rng: () => number): ChosenMove | null {
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
  if (mp.mode === 'skillMove') {
    if (cands.length) return { uci: sfPickBest(cands, mp.level, rng, fen), reason: 'skill' };
    if (result.bestMove && legal.has(result.bestMove)) return { uci: result.bestMove, reason: 'skill' };
    return fallbackMove(legalList, color, ply, rng);
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
  const pool0 = legalList.filter((m) => !blind.has(uciOf(m)));

  const bestCp = Math.max(...cands.map((c) => c.cp));
  const bestW = winPct(bestCp);
  const known = new Map(cands.map((c) => [c.uci, c.cp] as const));
  const worstCp = Math.min(...cands.map((c) => c.cp));
  const cpOf = (m: Move) => known.get(uciOf(m)) ?? worstCp - 50;
  const dW = (m: Move) => bestW - winPct(cpOf(m));
  const dCp = (m: Move) => Math.min(bestCp - cpOf(m), 1500);

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
