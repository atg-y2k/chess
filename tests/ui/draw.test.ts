/**
 * Draw mode's gestures (src/ui/draw.ts): the square under a pointer for both orientations and
 * board sizes, and what a gesture draws (an arrow, a circle, nothing).
 */
import { describe, expect, it } from 'vitest';
import { dragThreshold, endGesture, gestureShape, moveGesture, squareAt, startGesture, type BoardRect } from '../../src/ui/draw';

const SMALL: BoardRect = { left: 10, top: 100, width: 320, height: 320 }; // 40 px squares
const BIG: BoardRect = { left: 0, top: 0, width: 800, height: 800 }; // 100 px squares

/** The client point at the center of a square (white at the bottom when 'white'). */
function center(sq: string, rect: BoardRect, side: 'white' | 'black'): [number, number] {
  const size = rect.width / 8;
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq[1]) - 1;
  const col = side === 'white' ? file : 7 - file;
  const row = side === 'white' ? 7 - rank : rank;
  return [rect.left + (col + 0.5) * size, rect.top + (row + 0.5) * size];
}

describe('squareAt', () => {
  it('maps the corners for White and Black', () => {
    expect(squareAt(11, 101, SMALL, 'white')).toBe('a8');
    expect(squareAt(329, 419, SMALL, 'white')).toBe('h1');
    expect(squareAt(11, 419, SMALL, 'white')).toBe('a1');
    expect(squareAt(11, 101, SMALL, 'black')).toBe('h1');
    expect(squareAt(329, 419, SMALL, 'black')).toBe('a8');
    expect(squareAt(329, 101, SMALL, 'black')).toBe('a1');
  });

  it('finds every square at its center, whatever the size and side', () => {
    for (const rect of [SMALL, BIG]) {
      for (const side of ['white', 'black'] as const) {
        for (const f of 'abcdefgh') {
          for (let r = 1; r <= 8; r++) {
            const sq = `${f}${r}`;
            const [x, y] = center(sq, rect, side);
            expect(squareAt(x, y, rect, side)).toBe(sq);
          }
        }
      }
    }
  });

  it('is null off the board (and for a board with no size)', () => {
    expect(squareAt(9, 200, SMALL, 'white')).toBeNull();
    expect(squareAt(200, 99, SMALL, 'white')).toBeNull();
    expect(squareAt(330, 200, SMALL, 'white')).toBeNull();
    expect(squareAt(200, 420, SMALL, 'black')).toBeNull();
    expect(squareAt(0, 0, { left: 0, top: 0, width: 0, height: 0 }, 'white')).toBeNull();
  });

  it('e2 and e4 on a phone-sized board seen from Black', () => {
    const rect: BoardRect = { left: 26, top: 103, width: 361, height: 361 };
    expect(squareAt(...center('e2', rect, 'black'), rect, 'black')).toBe('e2');
    expect(squareAt(...center('e4', rect, 'black'), rect, 'black')).toBe('e4');
    expect(squareAt(...center('e2', rect, 'white'), rect, 'black')).toBe('d7');
  });
});

describe('gestures', () => {
  it('a tap draws a circle on its square', () => {
    const [x, y] = center('d4', SMALL, 'white');
    const g = startGesture(1, x, y, SMALL, 'white')!;
    expect(g.orig).toBe('d4');
    expect(gestureShape(g, 'green')).toEqual({ orig: 'd4', brush: 'green' }); // shown at once
    expect(endGesture(g, x, y, SMALL, 'white', 'green')).toEqual({ orig: 'd4', brush: 'green' });
  });

  it('a sloppy tap that strays into the next square is still a circle on the first', () => {
    const [x, y] = center('d4', SMALL, 'white');
    const g = startGesture(1, x + 17, y, SMALL, 'white')!; // near the e4 edge
    expect(dragThreshold(SMALL)).toBe(10);
    const moved = moveGesture(g, x + 23, y, SMALL, 'white'); // 6 px, across the edge
    expect(moved.dragging).toBe(false);
    expect(moved.over).toBe('e4');
    expect(endGesture(moved, x + 23, y, SMALL, 'white', 'red')).toEqual({ orig: 'd4', brush: 'red' });
  });

  it('a drag to another square draws an arrow, previewed on the way', () => {
    for (const side of ['white', 'black'] as const) {
      const g0 = startGesture(7, ...center('e2', BIG, side), BIG, side)!;
      const g1 = moveGesture(g0, ...center('e3', BIG, side), BIG, side);
      expect(g1.dragging).toBe(true);
      expect(gestureShape(g1, 'blue')).toEqual({ orig: 'e2', dest: 'e3', brush: 'blue' });
      const g2 = moveGesture(g1, ...center('e4', BIG, side), BIG, side);
      expect(gestureShape(g2, 'blue')).toEqual({ orig: 'e2', dest: 'e4', brush: 'blue' });
      expect(endGesture(g2, ...center('e4', BIG, side), BIG, side, 'blue')).toEqual({ orig: 'e2', dest: 'e4', brush: 'blue' });
    }
  });

  it('a drag that ends on its start square or off the board draws nothing', () => {
    const g0 = startGesture(1, ...center('g1', SMALL, 'white'), SMALL, 'white')!;
    const away = moveGesture(g0, ...center('f3', SMALL, 'white'), SMALL, 'white');
    const back = moveGesture(away, ...center('g1', SMALL, 'white'), SMALL, 'white');
    expect(back.dragging).toBe(true);
    expect(gestureShape(back, 'green')).toBeNull();
    expect(endGesture(back, ...center('g1', SMALL, 'white'), SMALL, 'white', 'green')).toBeNull();
    const off = moveGesture(away, 500, 200, SMALL, 'white');
    expect(off.over).toBeNull();
    expect(gestureShape(off, 'green')).toBeNull();
    expect(endGesture(away, 500, 200, SMALL, 'white', 'green')).toBeNull();
  });

  it('a gesture cannot start off the board', () => {
    expect(startGesture(1, 0, 0, SMALL, 'white')).toBeNull();
  });

  it('a fast drag with no move events in between still draws its arrow', () => {
    const g = startGesture(1, ...center('b1', SMALL, 'white'), SMALL, 'white')!;
    expect(endGesture(g, ...center('c3', SMALL, 'white'), SMALL, 'white', 'orange')).toEqual({ orig: 'b1', dest: 'c3', brush: 'orange' });
  });
});
