import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Score } from '../../src/engine/types';
import type { Color } from '../../src/game/types';
import { accuracyWin, gameAccuracy, moveAccuracy } from '../../src/analysis/accuracy';

const cp = (value: number): Score => ({ kind: 'cp', value });
const mate = (value: number): Score => ({ kind: 'mate', value });
const rep = <T>(n: number, xs: T[]): T[] => Array.from({ length: n }, () => xs).flat();
/** lichess convention: evals after each ply, preceded by +0.15 for the start position. */
const game = (cps: number[], startColor: Color = 'w') => gameAccuracy([cp(15), ...cps.map(cp)], { startColor });

describe('moveAccuracy', () => {
  it('matches lila AccuracyPercent.fromWinPercents', () => {
    const table: [number, number][] = [
      [0, 100],
      [2, 92.395],
      [5, 80.815],
      [10, 64.58],
      [15, 51.521],
      [20, 41.017],
      [30, 25.772],
      [50, 9.528],
      [80, 1.0],
      [100, 0],
    ];
    for (const [lossPct, acc] of table) {
      expect(moveAccuracy(1, 1 - lossPct / 100)).toBeCloseTo(acc, 2);
    }
    expect(moveAccuracy(0.6, 0.5)).toBeCloseTo(64.58, 2);
    expect(moveAccuracy(0.55, 0.53)).toBeCloseTo(92.395, 2);
  });

  it('gives 100 when the position did not get worse and stays within 0..100', () => {
    expect(moveAccuracy(0.5, 0.7)).toBe(100);
    expect(moveAccuracy(0.5, 0.5)).toBe(100);
    expect(moveAccuracy(1, 0)).toBe(0);
    for (let b = 0; b <= 1; b += 0.1) {
      for (let a = 0; a <= 1; a += 0.1) {
        const v = moveAccuracy(b, a);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it('uses lichess win% for accuracy (clamped, mate = ±1000 cp)', () => {
    expect(accuracyWin(cp(300))).toBeCloseTo(0.75113, 5);
    expect(accuracyWin(cp(1500))).toBeCloseTo(0.97545, 5);
    expect(accuracyWin(mate(3))).toBeCloseTo(0.97545, 5);
    expect(accuracyWin(mate(-1))).toBeCloseTo(0.02455, 5);
    expect(accuracyWin(mate(0))).toBeCloseTo(0.02455, 5);
  });
});

describe('gameAccuracy (lila AccuracyPercentTest port)', () => {
  // [name, evals after each ply, start colour, expected [white, black] or null, lila tolerance]
  const cases: [string, number[], Color, [number | null, number | null], [number, number]][] = [
    ['empty game', [], 'w', [null, null], [0, 0]],
    ['two good moves', [15, 15], 'w', [100, 100], [1, 1]],
    ['white blunders first', [-900, -900], 'w', [10, 100], [5, 1]],
    ['black blunders first', [15, 900], 'w', [100, 10], [1, 5]],
    ['both blunder first', [-900, 0], 'w', [10, 10], [5, 5]],
    ['20 perfect moves', rep(20, [15]), 'w', [100, 100], [1, 1]],
    ['20 perfect + white blunder', [...rep(20, [15]), -900], 'w', [50, 100], [5, 1]],
    ['21 perfect + black blunder', [...rep(21, [15]), 900], 'w', [100, 50], [1, 5]],
    ['5 x (-50, 15)', rep(5, [-50, 15]), 'w', [76, 76], [8, 8]],
    ['50 x (-50, 15)', rep(50, [-50, 15]), 'w', [76, 76], [8, 8]],
    ['50 x (-135, 15)', rep(50, [-135, 15]), 'w', [54, 54], [8, 8]],
    ['50 x (-435, 15)', rep(50, [-435, 15]), 'w', [20, 20], [8, 8]],
    ['black first, two good moves', [15, 15], 'b', [100, 100], [1, 1]],
    ['black first, black blunders', [900, 900], 'b', [100, 10], [1, 5]],
    ['black first, white blunders', [15, -900], 'b', [10, 100], [5, 1]],
    ['black first, both blunder', [900, 0], 'b', [10, 10], [5, 5]],
  ];
  for (const [name, cps, start, [w, b], [tw, tb]] of cases) {
    it(name, () => {
      const acc = game(cps, start);
      if (w == null) expect(acc.w).toBeNull();
      else expect(Math.abs(acc.w! - w)).toBeLessThanOrEqual(tw);
      if (b == null) expect(acc.b).toBeNull();
      else expect(Math.abs(acc.b! - b)).toBeLessThanOrEqual(tb);
    });
  }

  it('reproduces the exact reference values', () => {
    expect(game([-900, -900]).w).toBeCloseTo(10.664, 3);
    expect(game([15, 900]).b).toBeCloseTo(12.303, 3);
    expect(game([...rep(20, [15]), -900]).w).toBeCloseTo(46.853, 3);
    expect(game(rep(50, [-50, 15])).w).toBeCloseTo(77.383, 3);
    expect(game(rep(50, [-435, 15])).b).toBeCloseTo(20.695, 3);
  });

  it('returns null only for a colour without a scorable move', () => {
    expect(gameAccuracy([])).toEqual({ w: null, b: null });
    expect(gameAccuracy([cp(15)])).toEqual({ w: null, b: null });
    const one = gameAccuracy([cp(15), cp(20)]);
    expect(one.w).toBe(100);
    expect(one.b).toBeNull();
  });

  it('tolerates missing evals by skipping the moves whose window touches them', () => {
    const full = rep(15, [cp(-60), cp(10)]);
    const withGap: (Score | null)[] = [cp(15), ...full];
    withGap[9] = null;
    const acc = gameAccuracy(withGap);
    expect(acc.w).not.toBeNull();
    expect(acc.b).not.toBeNull();
    expect(gameAccuracy([null, null, null])).toEqual({ w: null, b: null });
    // A missing start eval falls back to lichess's +0.15.
    const cps = [-900, -900];
    expect(gameAccuracy([null, ...cps.map(cp)])).toEqual(game(cps));
  });

  it('treats mate scores as ±1000 cp and resolves a final checkmate from the index', () => {
    // 1. f3 e5 2. g4 Qh4#: the last position has White to move and checkmated.
    const foolsMate: Score[] = [cp(15), cp(-60), cp(-30), mate(-1), mate(0)];
    const a = gameAccuracy(foolsMate);
    expect(a.b!).toBeGreaterThan(85);
    expect(a.w!).toBeLessThan(50);
    // Black checkmated on the last ply: an unsigned 0 must not count as White being mated.
    const blackMated: Score[] = [cp(15), cp(60), cp(30), cp(400), mate(1), mate(0)];
    expect(gameAccuracy(blackMated).w).toBe(100);
  });
});

interface LichessGame {
  id: string;
  accuracy: [number, number];
  division: { middle?: number; end?: number };
  phases: Record<Color, Record<string, number>>;
  evals: (number | string | null)[];
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/classify-lichess-games.json', import.meta.url), 'utf8'),
) as { games: LichessGame[] };

const decode = (e: number | string | null): Score | null =>
  e == null ? null : typeof e === 'number' ? cp(e) : mate(Number(e.slice(1)));

describe('gameAccuracy against real lichess server analysis', () => {
  it(`matches all ${fixture.games.length} games (both colours, rounded like lichess)`, () => {
    expect(fixture.games.length).toBeGreaterThanOrEqual(20);
    let ok = 0;
    for (const g of fixture.games) {
      const acc = gameAccuracy([cp(15), ...g.evals.map(decode)]);
      const mine = [Math.round(acc.w!), Math.round(acc.b!)];
      expect(mine, g.id).toEqual(g.accuracy);
      ok += 2;
    }
    expect(ok).toBe(fixture.games.length * 2);
  });

  it('matches every lichess phase accuracy (opening / middlegame / endgame)', () => {
    let checked = 0;
    for (const g of fixture.games) {
      const all = [cp(15), ...g.evals.map(decode)];
      const { middle, end } = g.division;
      if (!middle) continue;
      const phaseOf = (ply: number) =>
        ply < middle ? 'opening' : end != null && end <= ply ? 'endgame' : 'middlegame';
      for (const phase of ['opening', 'middlegame', 'endgame']) {
        const plies = g.evals.map((_, i) => i + 1).filter((ply) => phaseOf(ply) === phase);
        if (!plies.length) continue;
        const first = plies[0];
        const acc = gameAccuracy([all[first - 1], ...plies.map((ply) => all[ply])], {
          startColor: first % 2 === 1 ? 'w' : 'b',
        });
        for (const color of ['w', 'b'] as const) {
          const expected = g.phases[color][phase];
          if (expected === undefined) continue;
          expect(Math.round(acc[color]!), `${g.id} ${phase} ${color}`).toBe(expected);
          checked++;
        }
      }
    }
    expect(checked).toBe(140);
  });
});
