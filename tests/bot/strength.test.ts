import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult, PvLine, Score } from '../../src/engine/types';
import {
  CUSTOM_NODES_CAP,
  FULL_NODES,
  SF_LEVEL_ELO,
  SKILL_NODES_CAP,
  chooseMove,
  hashSeed,
  legalMovesOf,
  mulberry32,
  planForElo,
  planMove,
  positionDifficulty,
  scoreCp,
  searchOptionsFor,
  thinkTimeMs,
  type CustomPlan,
  type MovePlan,
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
    // Engine band: a mate in the MultiPV lines always wins pick_best.
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
