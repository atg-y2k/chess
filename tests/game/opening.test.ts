import { Chess } from 'chess.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { START_FEN } from '../../src/chess/utils';
import { lineMoveAt, lineMoveNumber, lineMoves, lineProgress } from '../../src/game/opening';
import { getLine, type OpeningLine } from '../../src/openings/catalog';
import { loadExplorer } from '../../src/openings/tree';

let italian: OpeningLine;
let najdorf: OpeningLine;

beforeAll(async () => {
  await loadExplorer();
  italian = getLine('c50-italian-game')!;
  najdorf = getLine('b90-sicilian-defense-najdorf-variation')!;
});

/** The plies of a SAN move list from the initial position (only `fenAfter` matters here). */
function plies(sans: string[]): { fenAfter: string }[] {
  const chess = new Chess();
  return sans.map((san) => {
    chess.move(san);
    return { fenAfter: chess.fen() };
  });
}

describe('lineProgress', () => {
  it('is on the line at the start, with its first move', () => {
    const p = lineProgress(italian, START_FEN, []);
    expect(p).toMatchObject({ status: 'on-line', reached: 0, left: null, completedAt: null });
    expect(p.next).toEqual({ uci: 'e2e4', san: 'e4', label: '1. e4', color: 'w', ply: 0 });
  });

  it('follows the line move by move', () => {
    const p = lineProgress(italian, START_FEN, plies(['e4', 'e5', 'Nf3', 'Nc6']));
    expect(p.status).toBe('on-line');
    expect(p.reached).toBe(4);
    expect(p.next).toMatchObject({ san: 'Bc4', label: '3. Bc4', color: 'w', ply: 4 });
    expect(lineProgress(italian, START_FEN, plies(['e4', 'e5', 'Nf3'])).next?.label).toBe('2… Nc6');
  });

  it('is complete once the line’s last position is reached, and stays complete', () => {
    const done = lineProgress(italian, START_FEN, plies(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']));
    expect(done).toMatchObject({ status: 'complete', reached: 5, next: null, completedAt: 4 });
    const later = lineProgress(italian, START_FEN, plies(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'd3']));
    expect(later).toMatchObject({ status: 'complete', completedAt: 4 });
  });

  it('reports the move that left the line and the line’s move there', () => {
    const p = lineProgress(italian, START_FEN, plies(['e4', 'e5', 'Nc3', 'Nf6', 'Bc4']));
    expect(p.status).toBe('left');
    expect(p.reached).toBe(2);
    expect(p.left).toEqual({ index: 2, expected: { uci: 'g1f3', san: 'Nf3', label: '2. Nf3', color: 'w', ply: 2 } });
    // Black can leave it too.
    const b = lineProgress(najdorf, START_FEN, plies(['e4', 'e6']));
    expect(b.left?.index).toBe(1);
    expect(b.left?.expected.label).toBe('1… c5');
  });

  it('counts transpositions: another move order back onto the line', () => {
    const off = lineProgress(italian, START_FEN, plies(['Nf3', 'Nc6']));
    expect(off.status).toBe('left');
    expect(off.left?.index).toBe(0);
    // 1. Nf3 Nc6 2. e4 e5 = 1. e4 e5 2. Nf3 Nc6: back on the line, its next move numbered as in this game.
    const back = lineProgress(italian, START_FEN, plies(['Nf3', 'Nc6', 'e4', 'e5']));
    expect(back).toMatchObject({ status: 'on-line', reached: 4 });
    expect(back.next?.label).toBe('3. Bc4');
    // The Najdorf with 4... a6 before 5... Nf6: off the line after 4... a6, complete after 5... Nf6.
    const najdorfOrder = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'a6', 'Nc3', 'Nf6'];
    expect(lineProgress(najdorf, START_FEN, plies(najdorfOrder.slice(0, 8))).status).toBe('left');
    expect(lineProgress(najdorf, START_FEN, plies(najdorfOrder))).toMatchObject({ status: 'complete', completedAt: 9 });
  });

  it('a transposition that numbers the move differently keeps the game’s numbers', () => {
    // 1. e4 Nc6 2. Nf3 e5 is the line's position after 2... Nc6.
    const p = lineProgress(italian, START_FEN, plies(['e4', 'Nc6', 'Nf3', 'e5']));
    expect(p.status).toBe('on-line');
    expect(p.next?.label).toBe('3. Bc4');
    const knights = lineProgress(italian, START_FEN, plies(['Nf3', 'Nf6', 'Ng1', 'Ng8']));
    // Back at the initial position, at move 3: the line's first move is "3. e4" in this game.
    expect(knights).toMatchObject({ status: 'on-line', reached: 0 });
    expect(knights.next?.label).toBe('3. e4');
  });

  it('lineMoveAt is null off the line and at its end', () => {
    expect(lineMoveAt(italian, plies(['d4'])[0].fenAfter)).toBeNull();
    expect(lineMoveAt(italian, plies(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'])[4].fenAfter)).toBeNull();
  });
});

describe('line length', () => {
  it('counts moves as White’s and Black’s together', () => {
    expect(lineMoves(italian)).toBe(3);
    expect(lineMoves(najdorf)).toBe(5);
    expect([0, 1, 2, 3, 4].map(lineMoveNumber)).toEqual([1, 1, 2, 2, 3]);
  });
});
