import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult, PvLine, Score } from '../../src/engine/types';
import {
  CONVERT_DEPTH,
  CONVERT_NODES,
  CUSTOM_NODES_CAP,
  ENGINE_SWITCH_ELO,
  FULL_NODES,
  SF_LEVEL_ELO,
  SKILL_NODES_CAP,
  chooseMove,
  conversionSearchFor,
  hashSeed,
  isConversionMaterial,
  legalMovesOf,
  mulberry32,
  planForElo,
  planMove,
  positionDifficulty,
  positionKey,
  scoreCp,
  searchOptionsFor,
  thinkTimeMs,
  type CustomPlan,
  type MovePlan,
  type SkillMovePlan,
} from '../../src/bot/strength';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** White to move: Qxf7# (Scholar's mate pattern) is mate in 1; Black is otherwise fine. */
const MATE_IN_1 = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
const ELOS = [100, 250, 400, 550, 700, 850, 1000, 1150, 1300, 1320, 1500, 1800, 2200, 2600, 3000, 3199, 3200];

const uciOf = (m: { from: string; to: string; promotion?: string }) => m.from + m.to + (m.promotion ?? '');

/** Random legal positions (seeded random walks from the start position). */
function randomPositions(n: number, seed: number): string[] {
  const rng = mulberry32(seed);
  const out: string[] = [];
  while (out.length < n) {
    const chess = new Chess();
    const plies = 2 + Math.floor(rng() * 90);
    for (let i = 0; i < plies && !chess.isGameOver(); i++) {
      const moves = chess.moves();
      chess.move(moves[Math.floor(rng() * moves.length)]);
    }
    if (!chess.isGameOver()) out.push(chess.fen());
  }
  return out;
}

/** A synthetic search result: every legal move gets a random score; top `multiPv` lines reported. */
function syntheticResult(fen: string, multiPv: number, rng: () => number, overrides: Record<string, Score> = {}): AnalysisResult {
  const moves = legalMovesOf(fen).map(uciOf);
  const scored = moves.map((uci) => {
    const g = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    const score: Score = overrides[uci] ?? { kind: 'cp', value: Math.round(g * 150) };
    return { uci, score };
  });
  scored.sort((a, b) => scoreCp(b.score) - scoreCp(a.score));
  const lines: PvLine[] = scored.slice(0, multiPv).map((s, i) => ({ multipv: i + 1, depth: 2, score: s.score, pv: [s.uci] }));
  return { fen, depth: 2, lines, bestMove: lines[0]?.pv[0] ?? null, done: true };
}

const widthOf = (mp: MovePlan) => searchOptionsFor(mp).multiPv ?? 1;

describe('planForElo', () => {
  it('uses the custom band below 1320, emulated skill up to 3199, full strength at 3200', () => {
    expect(planForElo(100).mode).toBe('custom');
    expect(planForElo(1319).mode).toBe('custom');
    expect(planForElo(1320).mode).toBe('skill');
    expect(planForElo(3199).mode).toBe('skill');
    expect(planForElo(3200).mode).toBe('full');
  });

  it('clamps out-of-range Elo', () => {
    expect(planForElo(-50).elo).toBe(100);
    expect(planForElo(Number.NaN).elo).toBe(100);
    expect(planForElo(9999)).toMatchObject({ mode: 'full', elo: 3200 });
  });

  it('gets monotonically stronger across the custom band', () => {
    let prev = planForElo(100) as CustomPlan;
    for (let elo = 110; elo < 1320; elo += 10) {
      const p = planForElo(elo) as CustomPlan;
      expect(p.temperature).toBeLessThanOrEqual(prev.temperature);
      expect(p.blunderChance).toBeLessThanOrEqual(prev.blunderChance);
      expect(p.maxBlunderLoss).toBeLessThanOrEqual(prev.maxBlunderLoss);
      expect(p.cpTemp).toBeLessThanOrEqual(prev.cpTemp);
      expect(p.mateSeeProb).toBeGreaterThanOrEqual(prev.mateSeeProb);
      expect(p.mateSeeDepth).toBeGreaterThanOrEqual(prev.mateSeeDepth);
      prev = p;
    }
    expect((planForElo(100) as CustomPlan).temperature).toBeGreaterThan(10 * (planForElo(1300) as CustomPlan).temperature);
  });

  it('interpolates skill levels monotonically across the engine band', () => {
    let prev = -1;
    for (let elo = 1320; elo < 3200; elo += 5) {
      const p = planForElo(elo);
      if (p.mode !== 'skill') throw new Error('expected skill plan');
      expect(p.hi - p.lo).toBeLessThanOrEqual(1);
      expect(p.pHi).toBeGreaterThanOrEqual(0);
      expect(p.pHi).toBeLessThanOrEqual(1);
      const expected = p.lo + p.pHi;
      expect(expected).toBeGreaterThanOrEqual(prev);
      prev = expected;
    }
    // Integer-level anchors play a single level.
    const l5 = planForElo(SF_LEVEL_ELO[5]);
    expect(l5).toMatchObject({ mode: 'skill', lo: 5, pHi: 0 });
  });

  it('starts the skill band with a Level 0/1 mix, not pure Level 0 (which plays below custom 1300)', () => {
    for (let i = 1; i < SF_LEVEL_ELO.length; i++) expect(SF_LEVEL_ELO[i]).toBeGreaterThan(SF_LEVEL_ELO[i - 1]);
    expect(SF_LEVEL_ELO[0]).toBeLessThan(ENGINE_SWITCH_ELO);
    const p = planForElo(ENGINE_SWITCH_ELO);
    if (p.mode !== 'skill') throw new Error('expected skill plan');
    expect(p).toMatchObject({ lo: 0, hi: 1 });
    expect(p.pHi).toBeGreaterThan(0.25);
    expect(p.pHi).toBeLessThan(0.5);
  });

  it('draws skill levels by stochastic rounding (share of the higher level ~ pHi)', () => {
    const plan = planForElo(1500);
    if (plan.mode !== 'skill') throw new Error('expected skill plan');
    const rng = mulberry32(7);
    let hi = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const mp = planMove(plan, rng);
      if (mp.mode !== 'skillMove') throw new Error('expected skillMove');
      expect([plan.lo, plan.hi]).toContain(mp.level);
      if (mp.level === plan.hi) hi++;
    }
    expect(hi / N).toBeGreaterThan(plan.pHi - 0.03);
    expect(hi / N).toBeLessThan(plan.pHi + 0.03);
  });
});

describe('searchOptionsFor', () => {
  it('always searches at full strength with depth/node limits (never movetime)', () => {
    const rng = mulberry32(1);
    for (let elo = 100; elo <= 3200; elo += 25) {
      const mp = planMove(planForElo(elo), rng);
      const o = searchOptionsFor(mp);
      expect(o.limitStrengthElo).toBeUndefined();
      expect(o.skillLevel).toBeUndefined();
      expect(o.movetime).toBeUndefined();
      expect(o.depth).toBeGreaterThan(0);
      expect(o.nodes).toBeGreaterThan(0);
      expect(o.nodes).toBeLessThanOrEqual(Math.max(CUSTOM_NODES_CAP, SKILL_NODES_CAP, FULL_NODES));
      if (mp.mode === 'custom') expect(o).toMatchObject({ depth: 2, multiPv: 256 });
      if (mp.mode === 'skillMove') expect(o).toMatchObject({ depth: mp.level + 1, multiPv: 4, nodes: SKILL_NODES_CAP });
      if (mp.mode === 'full') expect(o).toMatchObject({ multiPv: 1, nodes: FULL_NODES });
    }
  });
});

describe('chooseMove', () => {
  const positions = randomPositions(150, 12345);

  it('never returns an illegal move (full lines, garbage lines, empty and aborted results)', () => {
    const rng = mulberry32(99);
    let checked = 0;
    for (const fen of positions) {
      const legal = new Set(new Chess(fen).moves({ verbose: true }).map(uciOf));
      for (const elo of ELOS) {
        const mp = planMove(planForElo(elo), rng);
        const good = syntheticResult(fen, widthOf(mp), rng);
        const garbage: AnalysisResult = {
          ...good,
          lines: [
            { multipv: 1, depth: 5, score: { kind: 'mate', value: 1 }, pv: ['a1a1'] },
            { multipv: 2, depth: 5, score: { kind: 'cp', value: 900 }, pv: ['e2e5'] },
            ...good.lines.slice(0, 2).map((l, i) => ({ ...l, multipv: i + 3 })),
          ],
          bestMove: 'h1h8q',
        };
        const empty: AnalysisResult = { fen, depth: 0, lines: [], bestMove: null, done: false, aborted: true };
        for (const r of [good, garbage, empty]) {
          const c = chooseMove(fen, r, mp, rng);
          expect(c).not.toBeNull();
          expect(legal.has(c!.uci)).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBe(positions.length * ELOS.length * 3);
  });

  it('returns null for positions without legal moves, and plays forced moves', () => {
    const mated = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
    const stalemate = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';
    const rng = mulberry32(1);
    for (const fen of [mated, stalemate]) {
      const terminal = fen === mated ? 'checkmate' : 'stalemate';
      const r: AnalysisResult = { fen, depth: 0, lines: [], bestMove: null, done: true, terminal };
      for (const elo of [100, 1500, 3200]) expect(chooseMove(fen, r, planMove(planForElo(elo), rng), rng)).toBeNull();
    }
    const check = 'k7/8/8/8/8/8/1r6/K1r5 w - - 0 1'; // Ka1 in check by c1 rook, b2 rook covers b-file: Kxb2 only
    const only = new Chess(check).moves({ verbose: true });
    expect(only.length).toBe(1);
    const noLines: AnalysisResult = { fen: check, depth: 0, lines: [], bestMove: null, done: false };
    const forced = chooseMove(check, noLines, planMove(planForElo(2000), rng), rng);
    expect(forced).toEqual({ uci: uciOf(only[0]), reason: 'forced' });
  });

  it('is deterministic for a given seed', () => {
    const run = (seed: number) => {
      const rng = mulberry32(seed);
      const data = mulberry32(555); // same synthetic results in both runs
      const out: string[] = [];
      for (const fen of positions.slice(0, 60)) {
        for (const elo of [150, 900, 1400, 2400]) {
          const mp = planMove(planForElo(elo), rng);
          out.push(chooseMove(fen, syntheticResult(fen, widthOf(mp), data), mp, rng)!.uci);
        }
      }
      return out;
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('plays the best move more often as Elo rises', () => {
    const bestRate = (elo: number) => {
      const rng = mulberry32(elo);
      let best = 0;
      let n = 0;
      for (const fen of positions.slice(0, 80)) {
        for (let k = 0; k < 15; k++) {
          const mp = planMove(planForElo(elo), rng);
          const r = syntheticResult(fen, widthOf(mp), mulberry32(hashSeed(fen)));
          if (chooseMove(fen, r, mp, rng)!.uci === r.bestMove) best++;
          n++;
        }
      }
      return best / n;
    };
    const rates = [100, 550, 1000, 1319, 1320, 1953, 2711, 3200].map(bestRate);
    for (let i = 1; i < rates.length; i++) {
      // Band boundary (1319 custom -> 1320 skill) is calibrated on real games, not on this proxy.
      if (i === 4) continue;
      expect(rates[i]).toBeGreaterThan(rates[i - 1]);
    }
    expect(rates[rates.length - 1]).toBe(1);
  });

  it('sees short mates with roughly the designed probability', () => {
    const legal = new Chess(MATE_IN_1).moves({ verbose: true }).map(uciOf);
    expect(legal).toContain('h5f7');
    const N = 2500;
    for (const elo of [100, 550, 1000, 1300]) {
      const plan = planForElo(elo) as CustomPlan;
      const rng = mulberry32(elo * 31);
      let mates = 0;
      for (let i = 0; i < N; i++) {
        const r = syntheticResult(MATE_IN_1, 256, rng, { h5f7: { kind: 'mate', value: 1 } });
        if (chooseMove(MATE_IN_1, r, plan, rng)!.uci === 'h5f7') mates++;
      }
      expect(Math.abs(mates / N - plan.mateSeeProb)).toBeLessThan(0.035);
    }
    // Engine band: a mate among cp lines is always played (see 'decided positions' for mate-only lines).
    for (const elo of [1320, 1700, 2500, 3200]) {
      const rng = mulberry32(elo);
      for (let i = 0; i < 300; i++) {
        const mp = planMove(planForElo(elo), rng);
        const r = syntheticResult(MATE_IN_1, widthOf(mp), rng, { h5f7: { kind: 'mate', value: 1 } });
        expect(chooseMove(MATE_IN_1, r, mp, rng)!.uci).toBe('h5f7');
      }
    }
  });

  it('weak bots hang material (oversights) while strong bots do not', () => {
    const rng = mulberry32(3);
    const reasons: Record<string, number> = {};
    const plan = planMove(planForElo(100), rng);
    for (const fen of positions.slice(0, 100)) {
      for (let k = 0; k < 10; k++) {
        const c = chooseMove(fen, syntheticResult(fen, 256, rng), plan, rng)!;
        reasons[c.reason] = (reasons[c.reason] ?? 0) + 1;
      }
    }
    // blunderChance at 100 is 0.6 (minus forced / mate moves)
    expect(reasons.oversight / 1000).toBeGreaterThan(0.5);
    expect(reasons.oversight / 1000).toBeLessThan(0.7);
  });

  it('emulates Stockfish pick_best: level 19 plays the best clear move, level 0 spreads over near-equal moves', () => {
    const fen = START;
    const lines = (cps: number[]): AnalysisResult => ({
      fen,
      depth: 10,
      done: true,
      bestMove: 'e2e4',
      lines: ['e2e4', 'd2d4', 'g1f3', 'c2c4'].map((uci, i) => ({
        multipv: i + 1,
        depth: 10,
        score: { kind: 'cp', value: cps[i] },
        pv: [uci],
      })),
    });
    const rng = mulberry32(11);
    for (let i = 0; i < 500; i++) {
      expect(chooseMove(fen, lines([150, 20, 10, 0]), { mode: 'skillMove', elo: 3190, level: 19, nodes: 1 }, rng)!.uci).toBe('e2e4');
    }
    const counts: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const u = chooseMove(fen, lines([30, 25, 20, 15]), { mode: 'skillMove', elo: 1347, level: 0, nodes: 1 }, rng)!.uci;
      counts[u] = (counts[u] ?? 0) + 1;
    }
    for (const u of ['e2e4', 'd2d4', 'g1f3', 'c2c4']) expect(counts[u] / 4000).toBeGreaterThan(0.1);
  });

  it('full strength plays the engine best move', () => {
    const rng = mulberry32(5);
    for (const fen of positions.slice(0, 30)) {
      const r = syntheticResult(fen, 1, rng);
      expect(chooseMove(fen, r, planMove(planForElo(3200), rng), rng)).toEqual({ uci: r.bestMove, reason: 'engine' });
    }
  });
});

describe('thinkTimeMs / positionDifficulty', () => {
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const sample = (n: number, f: (rng: () => number) => number) => {
    const rng = mulberry32(n);
    return Array.from({ length: n }, () => f(rng));
  };

  it('is quick for forced and book moves, and clamped for engine moves', () => {
    for (const t of sample(500, (r) => thinkTimeMs({ elo: 3200, ply: 30, source: 'forced', legalMoves: 1 }, r))) {
      expect(t).toBeGreaterThanOrEqual(250);
      expect(t).toBeLessThanOrEqual(450);
    }
    for (const t of sample(500, (r) => thinkTimeMs({ elo: 3200, ply: 4, source: 'book', legalMoves: 30 }, r))) {
      expect(t).toBeGreaterThanOrEqual(250);
      expect(t).toBeLessThanOrEqual(1400);
    }
    for (const t of sample(2000, (r) => thinkTimeMs({ elo: 2500, ply: 40, source: 'engine', legalMoves: 30, goodMoves: 4 }, r))) {
      expect(t).toBeGreaterThanOrEqual(300);
      expect(t).toBeLessThanOrEqual(4000);
    }
  });

  it('is faster for weak bots and obvious moves', () => {
    const at = (elo: number, obvious = false) =>
      median(sample(1001, (r) => thinkTimeMs({ elo, ply: 30, source: 'engine', legalMoves: 30, goodMoves: 2, obvious }, r)));
    expect(at(100)).toBeLessThan(at(1500));
    expect(at(1500)).toBeLessThan(at(3200));
    expect(at(2000, true)).toBeLessThan(0.7 * at(2000));
  });

  it('measures how many good options a position has', () => {
    const r = (cps: number[]): AnalysisResult => ({
      fen: START,
      depth: 10,
      done: true,
      bestMove: 'a2a3',
      lines: cps.map((value, i) => ({ multipv: i + 1, depth: 10, score: { kind: 'cp', value }, pv: ['a2a3'] })),
    });
    expect(positionDifficulty(r([20, 15, 10, 5]))).toEqual({ goodMoves: 4, obvious: false });
    expect(positionDifficulty(r([400, -200, -250]))).toEqual({ goodMoves: 1, obvious: true });
    const empty: AnalysisResult = { fen: START, depth: 0, lines: [], bestMove: null, done: false };
    expect(positionDifficulty(empty)).toEqual({ goodMoves: 0, obvious: false });
  });
});

describe('mulberry32 / hashSeed', () => {
  it('is reproducible and in [0, 1)', () => {
    const a = mulberry32(2024);
    const b = mulberry32(2024);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    expect(hashSeed('game-1')).toBe(hashSeed('game-1'));
    expect(hashSeed('game-1')).not.toBe(hashSeed('game-2'));
  });
});

// -------------------------------------------------------------------------------------------------
// Decided positions: mates, conversion, repetition guard

/** Lines for `fen` with the given first moves and scores (multipv in the given order). */
function linesResult(fen: string, entries: [string, Score][], depth = 6): AnalysisResult {
  const legal = new Set(legalMovesOf(fen).map(uciOf));
  for (const [uci] of entries) if (!legal.has(uci)) throw new Error(`${uci} is not legal in ${fen}`);
  return {
    fen,
    depth,
    done: true,
    bestMove: entries[0][0],
    lines: entries.map(([uci, score], i) => ({ multipv: i + 1, depth, score, pv: [uci] })),
  };
}

/** Every legal move scored: `score(uci)`, sorted best first (a MultiPV-256 custom-band search). */
function allMovesResult(fen: string, score: (uci: string) => Score): AnalysisResult {
  const entries = legalMovesOf(fen)
    .map((m) => [uciOf(m), score(uciOf(m))] as [string, Score])
    .sort((a, b) => scoreCp(b[1]) - scoreCp(a[1]));
  return linesResult(fen, entries, 2);
}

/** Replays UCI moves from `start`: the final FEN and the position counts BotPlayer would pass. */
function replay(start: string, moves: string[]): { fen: string; counts: Map<string, number> } {
  const chess = new Chess(start);
  const counts = new Map([[positionKey(chess.fen()), 1]]);
  for (const m of moves) {
    chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
    counts.set(positionKey(chess.fen()), (counts.get(positionKey(chess.fen())) ?? 0) + 1);
  }
  return { fen: chess.fen(), counts };
}

const cp = (value: number): Score => ({ kind: 'cp', value });
const mate = (value: number): Score => ({ kind: 'mate', value });
const skill = (level: number): SkillMovePlan => ({ mode: 'skillMove', elo: 2000, level, nodes: SKILL_NODES_CAP });
const CUSTOM_ELOS = [100, 400, 700, 1000, 1300];
const KQK = '8/8/8/4k3/8/8/8/3QK3 w - - 0 1';

describe('decided positions', () => {
  it('skill band: always plays a seen forced mate, the shortest one (pick_best alone dithers between mates)', () => {
    // Recorded 1600 vs 1800 game: Ra6# is mate in 1, the other lines are mates in 2..4.
    const fen = 'k7/2K5/3R4/1pP5/1P6/8/8/8 w - - 35 94';
    const allM2 = linesResult(fen, [['d6a6', mate(1)], ['d6d1', mate(2)], ['d6d2', mate(2)], ['c7b6', mate(2)]]);
    const spread = linesResult(fen, [['d6d1', mate(2)], ['d6a6', mate(1)], ['d6d2', mate(3)], ['c7b6', mate(4)]]);
    const rng = mulberry32(38);
    for (let level = 0; level <= 19; level++) {
      for (let i = 0; i < 100; i++) {
        for (const r of [allM2, spread]) expect(chooseMove(fen, r, skill(level), rng)).toEqual({ uci: 'd6a6', reason: 'mate' });
      }
    }
    for (let elo = ENGINE_SWITCH_ELO; elo < 3200; elo += 97) {
      const mp = planMove(planForElo(elo), rng);
      expect(chooseMove(fen, allM2, mp, rng)!.uci).toBe('d6a6');
    }
  });

  it('skill band: normal winning positions keep pick_best\'s spread', () => {
    const r = linesResult(START, [['e2e4', cp(700)], ['d2d4', cp(690)], ['g1f3', cp(680)], ['c2c4', cp(650)]]);
    const rng = mulberry32(12);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const u = chooseMove(START, r, skill(0), rng)!.uci;
      counts[u] = (counts[u] ?? 0) + 1;
    }
    for (const u of ['e2e4', 'd2d4', 'g1f3', 'c2c4']) expect(counts[u] / 4000).toBeGreaterThan(0.1);
  });

  it('recognises conversion material (lone king or king + pawns / one minor against a rook more)', () => {
    const yes = [
      KQK,
      '8/8/3k4/8/8/8/8/R3K3 w - - 0 1', // KR v K
      '8/8/3k4/8/8/8/8/r3K3 b - - 0 1', // Black to move with the rook
      '8/8/3k4/8/8/8/8/2BNK3 w - - 0 1', // KBN v K
      '8/5k2/5n2/8/8/8/8/2Q1K3 w - - 0 1', // KQ v KN
      '8/5k2/5ppp/8/8/8/5PPP/R5K1 w - - 0 1', // rook + pawns v pawns
    ];
    const no = [
      '8/8/3k4/8/8/8/8/r3K3 w - - 0 1', // the side to move has the lone king
      '8/5k2/5n2/8/8/8/8/R3K3 w - - 0 1', // KR v KN: only 2 more
      '8/8/3k4/8/8/8/8/1NN1K3 w - - 0 1', // two knights cannot force mate
      '8/8/3k4/8/8/8/8/2B1K3 w - - 0 1', // KB v K
      '3qk3/8/8/8/8/8/8/3QK3 w - - 0 1', // KQ v KQ
      START,
    ];
    for (const f of yes) expect(isConversionMaterial(f), f).toBe(true);
    for (const f of no) expect(isConversionMaterial(f), f).toBe(false);
  });

  it('asks for a deep conversion search only when it is needed', () => {
    const winning = allMovesResult(KQK, (u) => cp(u === 'd1d4' || u === 'd1d5' ? 0 : 650 + (u.charCodeAt(3) % 7)));
    const deep = { depth: CONVERT_DEPTH, nodes: CONVERT_NODES, multiPv: 1 };
    expect(conversionSearchFor(KQK, winning, planForElo(1000) as CustomPlan)).toEqual(deep);
    expect(conversionSearchFor(KQK, winning, skill(0))).toEqual(deep);
    expect(conversionSearchFor(KQK, winning, skill(12))).toEqual(deep); // depth 13 < CONVERT_DEPTH
    expect(conversionSearchFor(KQK, winning, skill(13))).toBeNull(); // its own search is deep enough
    expect(conversionSearchFor(KQK, winning, planMove(planForElo(3200), mulberry32(1)))).toBeNull();
    const withMate = linesResult(KQK, [['d1d4', mate(5)], ['d1d3', cp(700)]]);
    expect(conversionSearchFor(KQK, withMate, skill(4))).toBeNull(); // the mate is simply played
    expect(conversionSearchFor(KQK, allMovesResult(KQK, () => cp(120)), skill(4))).toBeNull(); // not clearly winning
    expect(conversionSearchFor(START, allMovesResult(START, () => cp(900)), skill(4))).toBeNull(); // not a conversion ending
  });

  it('skill band: in conversion mode plays the deep move (or its own top line when deep enough)', () => {
    const r = linesResult(KQK, [['d1d3', cp(700)], ['d1c2', cp(695)], ['e1f2', cp(690)], ['d1g4', cp(680)]]);
    const deep = linesResult(KQK, [['d1g4', cp(900)]], CONVERT_DEPTH);
    const rng = mulberry32(5);
    for (let level = 0; level <= 12; level++) {
      expect(chooseMove(KQK, r, skill(level), rng, { deep })).toEqual({ uci: 'd1g4', reason: 'convert' });
    }
    for (let level = 13; level <= 19; level++) expect(chooseMove(KQK, r, skill(level), rng)).toEqual({ uci: 'd1d3', reason: 'convert' });
    // Without the deep result (search failed), pick_best as usual.
    expect(chooseMove(KQK, r, skill(3), rng)!.reason).toBe('skill');
  });

  it('custom band: in conversion mode never hangs the queen to the bare king, and often plays the deep move', () => {
    // Qd4+?? / Qd5+?? hang the queen (K v K draw); every other move keeps a winning score.
    const hanging = new Set(['d1d4', 'd1d5']);
    const r = allMovesResult(KQK, (u) => cp(hanging.has(u) ? 0 : 560 + ((u.charCodeAt(2) * 7 + u.charCodeAt(3)) % 150)));
    const deep = linesResult(KQK, [['d1d3', cp(900)]], CONVERT_DEPTH);
    for (const elo of CUSTOM_ELOS) {
      const plan = planForElo(elo) as CustomPlan;
      const rng = mulberry32(elo);
      let converted = 0;
      const N = 1500;
      for (let i = 0; i < N; i++) {
        const c = chooseMove(KQK, r, plan, rng, { deep })!;
        expect(hanging.has(c.uci)).toBe(false);
        if (c.reason === 'convert') converted++;
        // Without a deep result (e.g. the search was aborted) it still keeps the queen.
        expect(hanging.has(chooseMove(KQK, r, plan, rng)!.uci)).toBe(false);
      }
      expect(Math.abs(converted / N - plan.convertProb)).toBeLessThan(0.05);
    }
    expect((planForElo(1300) as CustomPlan).convertProb).toBeGreaterThan((planForElo(400) as CustomPlan).convertProb);
  });

  it('custom band: in conversion mode never stalemates the bare king', () => {
    // Black king h8, White Qf7?? would be stalemate from Qa7-f7; Kg6 etc. keep the win.
    const fen = '7k/Q7/6K1/8/8/8/8/8 w - - 0 1';
    const stalemates = new Set(
      legalMovesOf(fen)
        .filter((m) => new Chess(m.after).isStalemate())
        .map(uciOf),
    );
    expect(stalemates.size).toBeGreaterThan(0);
    const r = allMovesResult(fen, (u) => (u === 'a7g7' ? mate(1) : stalemates.has(u) ? cp(0) : cp(800)));
    // Shallow MultiPV searches sometimes score a stalemating move as winning (seen: +652 at depth 2).
    const polluted = allMovesResult(fen, (u) => (stalemates.has(u) ? cp(810) : cp(800)));
    for (const elo of CUSTOM_ELOS) {
      const rng = mulberry32(elo + 1);
      for (let i = 0; i < 1000; i++) {
        for (const res of [r, polluted]) expect(stalemates.has(chooseMove(fen, res, planForElo(elo) as CustomPlan, rng)!.uci)).toBe(false);
      }
    }
  });

  it('custom band: in conversion mode the rook is not left en prise even when the engine lines say it is fine', () => {
    // KR v K: Rc3?? / Rc4?? / Rc5?? put the undefended rook next to the black king.
    const fen = '8/8/8/8/3k4/8/8/2R1K3 w - - 0 1';
    const hangs = new Set(
      legalMovesOf(fen)
        .filter((m) => new Chess(m.after).moves({ verbose: true }).some((reply) => reply.captured === 'r'))
        .map(uciOf),
    );
    expect(hangs.size).toBeGreaterThan(0);
    const polluted = allMovesResult(fen, (u) => cp(hangs.has(u) ? 560 : 540));
    for (const elo of CUSTOM_ELOS) {
      const rng = mulberry32(elo + 2);
      for (let i = 0; i < 1000; i++) expect(hangs.has(chooseMove(fen, polluted, planForElo(elo) as CustomPlan, rng)!.uci)).toBe(false);
    }
  });

  describe('repetition guard', () => {
    const START_KRK = '8/8/8/4k3/8/8/8/R3K3 w - - 0 1';
    // Ra2 Ke6 Ra1 Ke5 Ra2 Ke6: now Ra1 lets Black complete a threefold with Ke5.
    const replyCase = replay(START_KRK, ['a1a2', 'e5e6', 'a2a1', 'e6e5', 'a1a2', 'e5e6']);
    // Ra2 Kd5 Ra3 Ke5 Ra2 Kd5 Ra3 Ke5: now Ra2 itself is the third occurrence.
    const directCase = replay(START_KRK, ['a1a2', 'e5d5', 'a2a3', 'd5e5', 'a3a2', 'e5d5', 'a2a3', 'd5e5']);
    const cases = [
      { name: 'the opponent can complete it', ...replyCase, bad: 'a2a1' },
      { name: 'the move completes it', ...directCase, bad: 'a3a2' },
    ];

    it('the test positions really are repetitions (chess.js agrees)', () => {
      const c1 = new Chess(replyCase.fen);
      expect(c1.fen()).toBe(replyCase.fen);
      const d = new Chess(START_KRK);
      for (const m of ['a1a2', 'e5d5', 'a2a3', 'd5e5', 'a3a2', 'e5d5', 'a2a3', 'd5e5', 'a3a2']) d.move({ from: m.slice(0, 2), to: m.slice(2, 4) });
      expect(d.isThreefoldRepetition()).toBe(true);
    });

    for (const c of cases) {
      it(`avoids a threefold while winning when ${c.name}`, () => {
        const others = legalMovesOf(c.fen).map(uciOf).filter((u) => u !== c.bad && u.startsWith('a'));
        // The repeating move ranks first in the (history-blind) engine lines.
        const r = linesResult(c.fen, [[c.bad, cp(520)], ...others.slice(0, 3).map((u, i) => [u, cp(510 - i)] as [string, Score])]);
        const all = allMovesResult(c.fen, (u) => cp(u === c.bad ? 520 : u.startsWith('a') ? 500 : 480));
        const rng = mulberry32(77);
        for (let i = 0; i < 300; i++) {
          for (const level of [0, 6, 12, 19]) {
            expect(chooseMove(c.fen, r, skill(level), rng, { positions: c.counts })!.uci).not.toBe(c.bad);
          }
          for (const elo of CUSTOM_ELOS) {
            expect(chooseMove(c.fen, all, planForElo(elo) as CustomPlan, rng, { positions: c.counts })!.uci).not.toBe(c.bad);
          }
        }
        // Without the history the top line is still played at full skill; the guard is what changed it.
        expect(chooseMove(c.fen, r, skill(19), rng)!.uci).toBe(c.bad);
      });
    }

    it('is off when the bot is not clearly better (a repetition is then a fine result)', () => {
      const { fen, counts } = replyCase;
      const r = linesResult(fen, [['a2a1', cp(0)], ['a2a3', cp(-5)], ['a2a4', cp(-8)], ['a2a5', cp(-10)]]);
      const rng = mulberry32(1);
      let repeated = 0;
      for (let i = 0; i < 300; i++) if (chooseMove(fen, r, skill(19), rng, { positions: counts })!.uci === 'a2a1') repeated++;
      expect(repeated).toBeGreaterThan(30);
    });
  });
});
