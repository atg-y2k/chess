/**
 * Per-move and per-game accuracy, following lichess exactly (lila `AccuracyPercent`).
 * chess.com's CAPS2 formula is private, so these numbers are "lichess-style" accuracy.
 */
import type { Score } from '../engine/types';
import type { Color } from '../game/types';
import { CP_CEILING, cpToWin } from './winprob';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * Per-move accuracy (0..100) from the mover's expected score before (best play) and after the move,
 * both 0..1. lichess: 103.1668 * exp(-0.043544 * Δwin%) - 3.1669, plus a 1-point bonus, clamped.
 */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  const before = winBefore * 100;
  const after = winAfter * 100;
  if (after >= before) return 100;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * (before - after)) - 3.166924740191411;
  return clamp(raw + 1, 0, 100);
}

/**
 * Centipawns lichess uses for accuracy: cp clamped to ±1000, any mate counts as ±1000.
 * `mate 0` (side to move checkmated) counts as -1000 for the side the score belongs to.
 */
export function accuracyCp(score: Score): number {
  if (score.kind === 'cp') return clamp(score.value, -CP_CEILING, CP_CEILING);
  return score.value > 0 ? CP_CEILING : -CP_CEILING;
}

/** Win probability (0..1) as lichess computes it for accuracy (clamped, mate = ±1000 cp). */
export function accuracyWin(score: Score): number {
  return cpToWin(accuracyCp(score));
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

/** Population standard deviation. */
const stdev = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};

/** Harmonic mean with every value floored at 1 (scalalib `Maths.harmonicMean`). */
const harmonicMean = (a: number[]) => a.length / a.reduce((s, v) => s + 1 / Math.max(1, v), 0);

const weightedMean = (a: [number, number][]): number | null => {
  let sv = 0;
  let sw = 0;
  for (const [v, w] of a) {
    sv += v * w;
    sw += w;
  }
  return sw === 0 ? null : sv / sw;
};

/** Eval lichess assumes for the standard start position (White POV, centipawns). */
export const INITIAL_CP = 15;

export interface GameAccuracyOptions {
  /** Side to move in the position at index 0 (default White). */
  startColor?: Color;
}

/**
 * Game accuracy per colour (0..100, unrounded), lichess method: the mean of a volatility-weighted
 * mean and a harmonic mean of per-move accuracies.
 *
 * @param evalsWhite White-POV evaluation of every position: index 0 = start position, index i = after
 *   ply i. `null` entries are tolerated; moves whose window touches one are skipped, as on lichess.
 *   A missing start eval (index 0) defaults to lichess's +0.15 (`INITIAL_CP`). A `mate 0` entry
 *   (checkmate on the board) is resolved from the index parity, so a `-0` lost in JSON does not matter.
 * @returns null for a colour that has no scorable move.
 */
export function gameAccuracy(
  evalsWhite: (Score | null)[],
  opts: GameAccuracyOptions = {},
): { w: number | null; b: number | null } {
  const startColor = opts.startColor ?? 'w';
  const stmAt = (i: number): Color => (i % 2 === 0 ? startColor : startColor === 'w' ? 'b' : 'w');
  const whiteCp = (s: Score | null, i: number): number | null => {
    if (s == null) return null;
    if (s.kind === 'mate' && s.value === 0) return stmAt(i) === 'w' ? -CP_CEILING : CP_CEILING;
    return accuracyCp(s);
  };
  // White win% (0..100) per position.
  const all = evalsWhite.map((s, i) => {
    const cp = i === 0 && s == null ? INITIAL_CP : whiteCp(s, i);
    return cp == null ? null : cpToWin(cp) * 100;
  });
  const plies = all.length - 1;
  if (plies < 1) return { w: null, b: null };

  const windowSize = clamp(Math.floor(plies / 10), 2, 8);
  const windows: (number | null)[][] = [];
  for (let i = 0; i < Math.min(windowSize, all.length) - 2; i++) windows.push(all.slice(0, windowSize));
  if (all.length <= windowSize) windows.push(all.slice());
  else for (let i = 0; i + windowSize <= all.length; i++) windows.push(all.slice(i, i + windowSize));
  const weights = windows.map((w) =>
    w.some((x) => x == null) ? null : clamp(stdev(w as number[]), 0.5, 12),
  );

  const per: Record<Color, [number, number][]> = { w: [], b: [] };
  for (let i = 0; i < plies; i++) {
    const prev = all[i];
    const next = all[i + 1];
    const weight = weights[i];
    if (prev == null || next == null || weight == null) continue;
    const color = stmAt(i);
    const acc = color === 'w' ? moveAccuracy(prev / 100, next / 100) : moveAccuracy(1 - prev / 100, 1 - next / 100);
    per[color].push([acc, weight]);
  }
  const side = (a: [number, number][]): number | null => {
    if (!a.length) return null;
    const wm = weightedMean(a);
    return wm == null ? null : (wm + harmonicMean(a.map((x) => x[0]))) / 2;
  };
  return { w: side(per.w), b: side(per.b) };
}
