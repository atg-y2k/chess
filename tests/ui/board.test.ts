import { describe, expect, it } from 'vitest';
import { pieceOnSquare, promotionColor, snapBoardSize } from '../../src/ui/Board';
import { graphSpan, knownRange, valueAt, whiteAreaPath } from '../../src/ui/EvalGraph';
import { evalBarText, isLongEvalText } from '../../src/ui/EvalBar';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
describe('Board helpers', () => {
  it('pieceOnSquare', () => {
    expect(pieceOnSquare(START, 'e1')).toBe('K');
    expect(pieceOnSquare(START, 'd8')).toBe('q');
    expect(pieceOnSquare(START, 'e4')).toBe(null);
    expect(pieceOnSquare('8/1P2P1p1/8/8/8/8/8/k6K w - - 0 1', 'e7')).toBe('P');
    expect(pieceOnSquare('8/1P2P1p1/8/8/8/8/8/k6K w - - 0 1', 'f7')).toBe(null);
    expect(pieceOnSquare('8/1P2P1p1/8/8/8/8/8/k6K w - - 0 1', 'g7')).toBe('p');
    expect(pieceOnSquare('8/8/8/8/8/8/8/k6K w - - 0 1', 'h1')).toBe('K');
  });
  it('promotionColor', () => {
    const fen = 'r1r3k1/1P2P1p1/7p/8/8/7P/5Pp1/6K1 b - - 0 1';
    expect(promotionColor(fen, 'b7', 'a8')).toBe('white');
    expect(promotionColor(fen, 'g2', 'f1')).toBe('black');
    expect(promotionColor(fen, 'g7', 'g6')).toBe(null);
    expect(promotionColor(fen, 'h3', 'h4')).toBe(null);
  });
  it('snapBoardSize', () => {
    expect(snapBoardSize(377, 3)).toBeCloseTo(376, 6);
    expect(snapBoardSize(564, 1)).toBe(560);
    expect(snapBoardSize(377, 2)).toBe(376);
    expect(snapBoardSize(1, 1)).toBe(8);
  });
});
describe('EvalGraph geometry', () => {
  const pts = [0.5, null, 0.7, 0.3, null, null];
  it('knownRange / valueAt', () => {
    expect(knownRange(pts)).toEqual([0, 3]);
    expect(knownRange([null, null])).toBe(null);
    expect(valueAt(pts, 1)).toBeCloseTo(0.6);
    expect(valueAt(pts, 4)).toBe(null);
    expect(valueAt([2, -1], 0)).toBe(1);
  });
  it('graphSpan', () => {
    expect(graphSpan(0)).toBe(1);
    expect(graphSpan(41)).toBe(40);
    expect(graphSpan(3, 20)).toBe(20);
  });
  it('whiteAreaPath', () => {
    expect(whiteAreaPath(pts, 5)).toBe('M0.0 100L0.0 50.00L400.0 30.00L600.0 70.00L600.0 100Z');
    expect(whiteAreaPath([null], 1)).toBe('');
  });
});
describe('EvalBar', () => {
  it('evalBarText', () => {
    expect(evalBarText('+1.3')).toBe('1.3');
    expect(evalBarText('-0.4')).toBe('0.4');
    expect(evalBarText('-M2')).toBe('M2');
    expect(evalBarText('0-1')).toBe('0-1');
    expect(evalBarText('0.0')).toBe('0.0');
    expect(evalBarText('+12.3')).toBe('12');
    expect(evalBarText('-9.9')).toBe('9.9');
    expect(isLongEvalText('M10')).toBe(true);
    expect(isLongEvalText('9.9')).toBe(false);
    expect(isLongEvalText('1-0')).toBe(false);
  });
});
