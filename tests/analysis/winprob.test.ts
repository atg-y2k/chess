import { describe, expect, it } from 'vitest';
import type { Score } from '../../src/engine/types';
import { toWhitePov } from '../../src/chess/utils';
import {
  childToMover,
  cpToWin,
  formatScore,
  matedSide,
  negateScore,
  resultScore,
  scoreToWin,
  whiteBarFraction,
} from '../../src/analysis/winprob';

const cp = (value: number): Score => ({ kind: 'cp', value });
const mate = (value: number): Score => ({ kind: 'mate', value });

// White to move and checkmated / Black to move and checkmated (fool's mate and a back-rank mate).
const WHITE_MATED = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
const BLACK_MATED = '3R2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1';

describe('cpToWin / scoreToWin', () => {
  it('matches the lichess logistic (k = 0.00368208)', () => {
    expect(cpToWin(0)).toBe(0.5);
    expect(cpToWin(15)).toBeCloseTo(0.5138, 4);
    expect(cpToWin(100)).toBeCloseTo(0.591, 3);
    expect(cpToWin(300)).toBeCloseTo(0.75113, 5);
    expect(cpToWin(-300)).toBeCloseTo(0.24887, 5);
    expect(cpToWin(1000)).toBeCloseTo(0.97545, 5);
    expect(cpToWin(1500)).toBeCloseTo(0.996, 3); // unclamped
  });

  it('is symmetric and monotonic', () => {
    for (const c of [1, 37, 250, 900]) {
      expect(cpToWin(c) + cpToWin(-c)).toBeCloseTo(1, 12);
      expect(cpToWin(c)).toBeGreaterThan(cpToWin(c - 1));
    }
  });

  it('maps mates to 1 / 0 for the side the score belongs to', () => {
    expect(scoreToWin(mate(3))).toBe(1);
    expect(scoreToWin(mate(-2))).toBe(0);
    expect(scoreToWin(mate(0))).toBe(0); // side to move is checkmated
    expect(scoreToWin(cp(100))).toBeCloseTo(cpToWin(100), 12);
  });
});

describe('whiteBarFraction', () => {
  it('clamps centipawns at ±1000 like lichess', () => {
    expect(whiteBarFraction(cp(0))).toBe(0.5);
    expect(whiteBarFraction(cp(1500))).toBeCloseTo(0.97545, 5);
    expect(whiteBarFraction(cp(-5000))).toBeCloseTo(0.02455, 5);
  });

  it('maps mate in N to (21 - min(10, N)) * 100 cp (lichess client)', () => {
    expect(whiteBarFraction(mate(1))).toBeCloseTo(0.99937, 5);
    expect(whiteBarFraction(mate(3))).toBeCloseTo(0.99868, 5);
    expect(whiteBarFraction(mate(15))).toBeCloseTo(0.98288, 5);
    expect(whiteBarFraction(mate(-1))).toBeCloseTo(0.00063, 5);
    expect(whiteBarFraction(mate(3))).toBeGreaterThan(whiteBarFraction(cp(1000)));
  });

  it('fills or empties the bar completely for a finished checkmate', () => {
    expect(whiteBarFraction(mate(0), 'w')).toBe(0);
    expect(whiteBarFraction(mate(0), 'b')).toBe(1);
    // Without sideToMove the sign of zero left by toWhitePov() decides.
    expect(whiteBarFraction(toWhitePov(mate(0), WHITE_MATED))).toBe(0);
    expect(whiteBarFraction(toWhitePov(mate(0), BLACK_MATED))).toBe(1);
  });
});

describe('formatScore', () => {
  it('formats centipawns as signed pawns with one decimal', () => {
    expect(formatScore(cp(130))).toBe('+1.3');
    expect(formatScore(cp(125))).toBe('+1.3');
    expect(formatScore(cp(-40))).toBe('-0.4');
    expect(formatScore(cp(-35))).toBe('-0.4');
    expect(formatScore(cp(1234))).toBe('+12.3');
    expect(formatScore(cp(5))).toBe('+0.1');
    expect(formatScore(cp(100))).toBe('+1.0');
  });

  it('shows 0.0 without a sign for (near) zero', () => {
    expect(formatScore(cp(0))).toBe('0.0');
    expect(formatScore(cp(4))).toBe('0.0');
    expect(formatScore(cp(-4))).toBe('0.0');
    expect(formatScore(cp(-0))).toBe('0.0');
  });

  it('formats mates from White POV', () => {
    expect(formatScore(mate(3))).toBe('M3');
    expect(formatScore(mate(-2))).toBe('-M2');
    expect(formatScore(mate(1))).toBe('M1');
  });

  it('shows the result for a finished checkmate', () => {
    expect(formatScore(mate(0), 'w')).toBe('0-1');
    expect(formatScore(mate(0), 'b')).toBe('1-0');
    expect(formatScore(toWhitePov(mate(0), WHITE_MATED))).toBe('0-1');
    expect(formatScore(toWhitePov(mate(0), BLACK_MATED))).toBe('1-0');
    // sideToMove wins over the sign of zero (JSON drops -0).
    expect(formatScore(JSON.parse(JSON.stringify(toWhitePov(mate(0), BLACK_MATED))), 'b')).toBe('1-0');
    expect(matedSide(mate(-0))).toBe('b');
    expect(matedSide(mate(0))).toBe('w');
  });
});

describe('negateScore / childToMover / resultScore', () => {
  it('negates without producing -0 centipawns', () => {
    expect(negateScore(cp(35))).toEqual(cp(-35));
    expect(negateScore(cp(0))).toEqual(cp(0));
    expect(Object.is(negateScore(cp(0)).value, 0)).toBe(true);
    expect(negateScore(mate(-3))).toEqual(mate(3));
    expect(negateScore(negateScore(cp(-120)))).toEqual(cp(-120));
  });

  it('converts a child-position score to the mover, counting mate from the parent', () => {
    expect(childToMover(cp(-80))).toEqual(cp(80));
    expect(childToMover(mate(-2))).toEqual(mate(3)); // opponent mated in 2 -> mover mates in 3
    expect(childToMover(mate(4))).toEqual(mate(-4)); // opponent mates in 4 -> mover mated in 4
    expect(childToMover(mate(0))).toEqual(mate(1)); // the move itself was mate
  });

  it('reads the side-to-move score of an analysis, including terminal positions', () => {
    const base = { depth: 12, bestMove: null, done: true };
    const line = { multipv: 1, depth: 12, score: cp(42), pv: ['e2e4'] };
    expect(resultScore({ ...base, fen: 'x', lines: [line] })).toEqual(cp(42));
    expect(resultScore({ ...base, fen: 'x', lines: [], terminal: 'checkmate' })).toEqual(mate(0));
    expect(resultScore({ ...base, fen: 'x', lines: [], terminal: 'stalemate' })).toEqual(cp(0));
    expect(resultScore({ ...base, fen: 'x', lines: [] })).toBeNull();
  });
});
