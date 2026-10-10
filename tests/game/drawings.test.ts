/**
 * The player's drawings by position (src/game/drawings.ts): the position key, drawing the same
 * shape again to take it off, another color replacing it, and Clear.
 */
import { describe, expect, it } from 'vitest';
import { NO_DRAWINGS, clearOn, drawOn, positionKey, sameSquares, shapesAt, toggleShape, type UserShape } from '../../src/game/drawings';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

describe('positionKey', () => {
  it('is the piece placement and the side to move', () => {
    expect(positionKey(START)).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w');
    expect(positionKey(E4)).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b');
  });

  it('ignores castling rights, the en passant square and the move counters', () => {
    expect(positionKey(E4)).toBe(positionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b - - 7 30'));
    expect(positionKey(START)).toBe(positionKey('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w Kq - 12 9'));
  });

  it('tells apart the same placement with the other side to move', () => {
    expect(positionKey(START)).not.toBe(positionKey(START.replace(' w ', ' b ')));
  });
});

describe('toggleShape', () => {
  const arrow: UserShape = { orig: 'e2', dest: 'e4', brush: 'green' };
  const circle: UserShape = { orig: 'd4', brush: 'red' };

  it('adds a new arrow or circle on top', () => {
    expect(toggleShape([], arrow)).toEqual([arrow]);
    expect(toggleShape([arrow], circle)).toEqual([arrow, circle]);
  });

  it('the same squares in the same color take it off again', () => {
    expect(toggleShape([arrow, circle], { ...arrow })).toEqual([circle]);
    expect(toggleShape([arrow, circle], { orig: 'd4', brush: 'red' })).toEqual([arrow]);
  });

  it('the same squares in another color change its color', () => {
    expect(toggleShape([arrow, circle], { ...arrow, brush: 'blue' })).toEqual([circle, { ...arrow, brush: 'blue' }]);
  });

  it('an arrow the other way, or a circle on its square, is another shape', () => {
    expect(toggleShape([arrow], { orig: 'e4', dest: 'e2', brush: 'green' })).toHaveLength(2);
    expect(toggleShape([arrow], { orig: 'e2', brush: 'green' })).toHaveLength(2);
  });

  it('an "arrow" to its own square is a circle', () => {
    expect(toggleShape([], { orig: 'c3', dest: 'c3', brush: 'orange' })).toEqual([{ orig: 'c3', brush: 'orange' }]);
    expect(toggleShape([{ orig: 'c3', brush: 'orange' }], { orig: 'c3', dest: 'c3', brush: 'orange' })).toEqual([]);
    expect(sameSquares({ orig: 'c3', brush: 'red' }, { orig: 'c3', brush: 'blue' })).toBe(true);
  });
});

describe('drawings by position', () => {
  it('keeps each position’s drawings apart, and the same position shares them', () => {
    let d = drawOn(NO_DRAWINGS, START, { orig: 'e2', dest: 'e4', brush: 'green' });
    d = drawOn(d, E4, { orig: 'e7', dest: 'e5', brush: 'red' });
    expect(shapesAt(d, START)).toEqual([{ orig: 'e2', dest: 'e4', brush: 'green' }]);
    expect(shapesAt(d, E4)).toEqual([{ orig: 'e7', dest: 'e5', brush: 'red' }]);
    // The same position reached later (other counters, no en passant square).
    expect(shapesAt(d, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 4 3')).toHaveLength(1);
    expect(shapesAt(d, START.replace(' w ', ' b '))).toEqual([]);
  });

  it('never changes the map it was given', () => {
    const d1 = drawOn(NO_DRAWINGS, START, { orig: 'g1', dest: 'f3', brush: 'blue' });
    const d2 = drawOn(d1, START, { orig: 'g1', dest: 'f3', brush: 'blue' });
    expect(shapesAt(d1, START)).toHaveLength(1);
    expect(shapesAt(d2, START)).toEqual([]);
    expect(d2.size).toBe(0); // a position left with none is forgotten
    expect(NO_DRAWINGS.size).toBe(0);
  });

  it('Clear removes one position’s drawings only', () => {
    let d = drawOn(NO_DRAWINGS, START, { orig: 'd2', dest: 'd4', brush: 'green' });
    d = drawOn(d, START, { orig: 'd4', brush: 'orange' });
    d = drawOn(d, E4, { orig: 'c7', dest: 'c5', brush: 'red' });
    const cleared = clearOn(d, START);
    expect(shapesAt(cleared, START)).toEqual([]);
    expect(shapesAt(cleared, E4)).toHaveLength(1);
    expect(clearOn(cleared, START)).toBe(cleared); // nothing to clear: the same map
  });
});
