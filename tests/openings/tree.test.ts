import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { fenKey, START_FEN } from '../../src/chess/utils';
import { families, getLine } from '../../src/openings/catalog';
import { children, lineAt, lineStart, loadExplorer, moveLabel, nameAt, nextLineMove, pathTo } from '../../src/openings/tree';

/** FENs after each ply of a SAN line (oldest first). */
function fens(sans: string[]): string[] {
  const chess = new Chess();
  return sans.map((s) => {
    chess.move(s);
    return chess.fen();
  });
}
const after = (sans: string[]) => fens(sans).at(-1) ?? START_FEN;
const NAJDORF = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'];

describe('before loadExplorer()', () => {
  it('answers nothing instead of throwing', () => {
    expect(children(START_FEN)).toEqual([]);
    expect(nameAt(after(['e4', 'c5']))).toBeNull();
    expect(lineAt(after(['e4', 'c5']))).toBeNull();
    expect(pathTo('c60-ruy-lopez')).toEqual([]);
    expect(lineStart('c60-ruy-lopez')).toBeNull();
    expect(nextLineMove('c60-ruy-lopez', START_FEN)).toBeNull();
  });
});

describe('children', () => {
  it('lists the main first moves with names and shares', async () => {
    await loadExplorer();
    const kids = children(START_FEN);
    const sans = kids.map((k) => k.san);
    expect(sans).toEqual(expect.arrayContaining(['e4', 'd4', 'c4', 'Nf3']));
    expect(sans.slice(0, 4)).toEqual(['e4', 'd4', 'c4', 'Nf3']);
    expect(kids.reduce((s, k) => s + k.share, 0)).toBeCloseTo(1, 9);
    const shares = kids.map((k) => k.share);
    expect(shares).toEqual([...shares].sort((a, b) => b - a));
    expect(kids.filter((k) => k.isMain).map((k) => k.san)).toEqual(['e4']);
    const e4 = kids[0];
    expect(e4).toMatchObject({
      uci: 'e2e4',
      name: { eco: 'B00', name: "King's Pawn Game" },
      lineId: 'b00-kings-pawn-game',
      dubious: false,
    });
    expect(e4.share).toBeGreaterThan(0.3);
    expect(e4.fenAfter).toBe(after(['e4']));
  });

  it('names the resulting positions and links them to catalog lines', async () => {
    await loadExplorer();
    const kids = children(after(['e4']));
    const c5 = kids.find((k) => k.san === 'c5');
    expect(c5).toMatchObject({ name: { eco: 'B20', name: 'Sicilian Defense' }, lineId: 'b20-sicilian-defense' });
    expect(getLine(c5!.lineId!)?.epd).toBe(fenKey(c5!.fenAfter));
    // a move into an unnamed position has no name
    const najdorfKids = children(after(NAJDORF));
    expect(najdorfKids.length).toBeGreaterThan(3);
    expect(najdorfKids.every((k) => k.lineId === undefined || getLine(k.lineId)?.name === k.name?.name)).toBe(true);
  });

  it('flags trap-line blunders as dubious', async () => {
    await loadExplorer();
    const kids = children(after(['f3', 'e5']));
    expect(kids.find((k) => k.san === 'g4')).toMatchObject({ dubious: true });
    expect(kids.find((k) => k.san === 'e4')).toMatchObject({ dubious: false });
  });

  it('never makes a dubious move the main move when a sound one exists', async () => {
    await loadExplorer();
    // Equal weights: 1. a4 e5 has "a1a3:1:340 a4a5:1:28 h2h4:1:82", 1. d4 f5 2. Nf3 "e7e5:1:179 g8f6:1:0".
    const a4 = children(after(['a4', 'e5']));
    expect(a4.filter((k) => k.isMain).map((k) => k.san)).toEqual(['a5']);
    expect(a4.at(-1)).toMatchObject({ san: 'Ra3', dubious: true, isMain: false });
    const dutch = children(after(['d4', 'f5', 'Nf3']));
    expect(dutch.filter((k) => k.isMain).map((k) => k.san)).toEqual(['Nf6']);
    // Over every position of the catalog's main lines: one main move, never a dubious one beside a sound one.
    for (const f of families()) {
      const line = getLine(f.mainLineId)!;
      for (const step of pathTo(line)) {
        const kids = children(step.fen);
        if (!kids.length) continue;
        const mains = kids.filter((k) => k.isMain);
        expect(mains, `${line.id} @${step.ply}`).toHaveLength(1);
        if (kids.some((k) => !k.dubious)) expect(mains[0].dubious, `${line.id} @${step.ply}`).toBe(false);
      }
    }
  });

  it('accepts an EPD and returns [] out of book or for a bad FEN', async () => {
    await loadExplorer();
    expect(children(fenKey(START_FEN)).map((k) => k.san)).toEqual(children(START_FEN).map((k) => k.san));
    expect(children(after(['a4', 'h5', 'Ra3', 'Rh6']))).toEqual([]);
    expect(children('not a fen')).toEqual([]);
  });
});

describe('names', () => {
  it('names a position, or walks back to the last named one', async () => {
    await loadExplorer();
    const f = fens([...NAJDORF, 'a4', 'h5']);
    expect(nameAt(f[9])).toEqual({
      eco: 'B90',
      name: 'Sicilian Defense: Najdorf Variation',
      family: 'Sicilian Defense',
      variation: 'Najdorf Variation',
      exact: true,
    });
    expect(nameAt(f[11], [START_FEN, ...f.slice(0, 11)])).toMatchObject({ eco: 'B90', exact: false });
    expect(nameAt(f[11])).toBeNull();
    expect(nameAt(START_FEN)).toBeNull();
  });

  it('finds the catalog line ending at a position, also for repeated names', async () => {
    await loadExplorer();
    expect(lineAt(after(NAJDORF))?.id).toBe('b90-sicilian-defense-najdorf-variation');
    expect(lineAt(after(['f3', 'f5', 'e4', 'fxe4', 'Nc3']))?.id).toBe('a00-barnes-opening-gedult-gambit');
    expect(lineAt(after(['f3', 'd5', 'e4', 'g6', 'd4', 'dxe4', 'c3']))?.id).toBe('a00-barnes-opening-gedult-gambit-1dmuenk');
    expect(lineAt(START_FEN)).toBeNull();
  });
});

describe('stepping through a line', () => {
  it('lists every position with moves, labels and names', async () => {
    await loadExplorer();
    const steps = pathTo('b90-sicilian-defense-najdorf-variation');
    expect(steps).toHaveLength(11);
    expect(steps[0]).toMatchObject({ ply: 0, fen: START_FEN, uci: null, san: null, color: null, label: null });
    expect(steps[1]).toMatchObject({ ply: 1, uci: 'e2e4', san: 'e4', color: 'w', label: '1. e4', name: { name: "King's Pawn Game" } });
    expect(steps[2]).toMatchObject({ san: 'c5', color: 'b', label: '1... c5', name: { name: 'Sicilian Defense' } });
    expect(steps[10]).toMatchObject({ label: '5... a6', name: { eco: 'B90', name: 'Sicilian Defense: Najdorf Variation' } });
    expect(steps.map((s) => s.fen)).toEqual([START_FEN, ...fens(NAJDORF)]);
    expect(steps.some((s) => s.dubious)).toBe(false);
    expect(pathTo(getLine('a00-barnes-opening-fools-mate')!).map((s) => !!s.dubious)).toEqual([false, false, false, true, false]);
    expect(pathTo('no-such-line')).toEqual([]);
  });

  it('labels moves', () => {
    expect(moveLabel(0, 'e4')).toBe('1. e4');
    expect(moveLabel(5, 'a6')).toBe('3... a6');
  });
});

describe('playing from a line', () => {
  it('gives the moves and position to start a game from', async () => {
    await loadExplorer();
    const line = getLine('c60-ruy-lopez')!;
    expect(lineStart(line)).toEqual({
      startFen: START_FEN,
      moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'],
      fen: after(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']),
      turn: 'b',
    });
    expect(lineStart('c60-ruy-lopez', 2)).toMatchObject({ moves: ['e2e4', 'e7e5'], turn: 'w' });
    expect(lineStart('c60-ruy-lopez', 99)?.moves).toHaveLength(5);
  });

  it('copes with odd ply counts', async () => {
    await loadExplorer();
    expect(lineStart('c60-ruy-lopez', Number.NaN)?.moves).toHaveLength(5); // the whole line, no TypeError
    expect(lineStart('c60-ruy-lopez', Number.POSITIVE_INFINITY)?.moves).toHaveLength(5);
    expect(lineStart('c60-ruy-lopez', 2.7)?.moves).toEqual(['e2e4', 'e7e5']);
    expect(lineStart('c60-ruy-lopez', -3)).toMatchObject({ moves: [], fen: START_FEN, turn: 'w' });
  });

  it('steers a game into the line, through transpositions', async () => {
    await loadExplorer();
    const id = 'd35-queens-gambit-declined-normal-defense'; // 1. d4 d5 2. c4 e6 3. Nc3 Nf6
    expect(getLine(id)?.san).toEqual(['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6']);
    expect(nextLineMove(id, START_FEN)).toEqual({ uci: 'd2d4', san: 'd4', ply: 0 });
    // 1. c4 e6 2. d4 d5 reaches the position after 2... e6 of the line
    expect(nextLineMove(id, after(['c4', 'e6', 'd4', 'd5']))).toEqual({ uci: 'b1c3', san: 'Nc3', ply: 4 });
    expect(nextLineMove(id, after(['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6']))).toBeNull(); // the line ends here
    expect(nextLineMove(id, after(['e4']))).toBeNull();
  });
});
