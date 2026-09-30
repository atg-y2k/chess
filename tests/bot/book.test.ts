import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  BOOK_BLUNDER_CP,
  bookMoves,
  bookProfile,
  currentOpening,
  isBookMove,
  isBookPosition,
  loadOpenings,
  openingAt,
  openingsLoaded,
  pickBookMove,
  splitOpeningName,
  type BookState,
} from '../../src/bot/book';
import { mulberry32 } from '../../src/bot/strength';

const START = new Chess().fen();

/** FENs after each ply of a SAN line (oldest first), plus the UCI moves. */
function play(sans: string[]): { fens: string[]; ucis: string[]; before: string[] } {
  const chess = new Chess();
  const fens: string[] = [];
  const ucis: string[] = [];
  const before: string[] = [];
  for (const san of sans) {
    before.push(chess.fen());
    const m = chess.move(san);
    ucis.push(m.from + m.to + (m.promotion ?? ''));
    fens.push(chess.fen());
  }
  return { fens, ucis, before };
}
const fenAfter = (sans: string[]) => play(sans).fens.at(-1)!;
const NAJDORF = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'];

describe('before loadOpenings()', () => {
  it('answers nothing instead of throwing', () => {
    expect(openingsLoaded()).toBe(false);
    expect(openingAt(fenAfter(['e4']))).toBeNull();
    expect(currentOpening(play(['e4', 'c5']).fens)).toBeNull();
    expect(isBookPosition(fenAfter(['e4']))).toBe(false);
    expect(isBookMove(START, 'e2e4', fenAfter(['e4']))).toBe(false);
    expect(bookMoves(START)).toEqual([]);
    expect(pickBookMove(START, 0, bookProfile(1500, () => 0.5), { left: false }, () => 0.5)).toBeNull();
  });
});

describe('opening names', () => {
  it('loads once (concurrent calls share the load)', async () => {
    await Promise.all([loadOpenings(), loadOpenings()]);
    expect(openingsLoaded()).toBe(true);
  });

  it('names positions', async () => {
    await loadOpenings();
    expect(openingAt(fenAfter(['e4']))).toEqual({ eco: 'B00', name: "King's Pawn Game" });
    expect(openingAt(fenAfter(['e4', 'c5']))).toEqual({ eco: 'B20', name: 'Sicilian Defense' });
    expect(openingAt(fenAfter(NAJDORF))).toEqual({ eco: 'B90', name: 'Sicilian Defense: Najdorf Variation' });
    expect(openingAt(fenAfter(['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4']))).toEqual({ eco: 'E20', name: 'Nimzo-Indian Defense' });
    expect(openingAt(START)).toBeNull();
  });

  it('recognises transpositions', async () => {
    await loadOpenings();
    expect(openingAt(fenAfter(['c4', 'e6', 'Nc3', 'd5', 'd4', 'Nf6']))?.name).toBe("Queen's Gambit Declined: Normal Defense");
  });

  it('walks back to the last named position', async () => {
    await loadOpenings();
    const { fens } = play([...NAJDORF, 'a4', 'h5']);
    expect(currentOpening(fens)).toEqual({ eco: 'B90', name: 'Sicilian Defense: Najdorf Variation', ply: 10 });
    expect(currentOpening(play(['d4', 'd5', 'Kd2']).fens)).toEqual({ eco: 'D00', name: "Queen's Pawn Game", ply: 2 });
    expect(currentOpening([])).toBeNull();
  });

  it('tolerates FENs with a non-capturable en-passant square and extra whitespace', async () => {
    await loadOpenings();
    const sfStyle = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    expect(openingAt(`  ${sfStyle} `)).toEqual({ eco: 'B00', name: "King's Pawn Game" });
  });

  it('splits family and variation', () => {
    expect(splitOpeningName('Sicilian Defense: Najdorf Variation')).toEqual({
      family: 'Sicilian Defense',
      variation: 'Najdorf Variation',
    });
    expect(splitOpeningName('Sicilian Defense')).toEqual({ family: 'Sicilian Defense', variation: '' });
  });
});

describe('book moves', () => {
  it('lists continuations by popularity with cp losses', async () => {
    await loadOpenings();
    const start = bookMoves(START);
    expect(start[0].uci).toBe('e2e4');
    expect(start.map((m) => m.uci)).toEqual(expect.arrayContaining(['d2d4', 'c2c4', 'g1f3']));
    for (let i = 1; i < start.length; i++) expect(start[i].weight).toBeLessThanOrEqual(start[i - 1].weight);
    expect(start.every((m) => typeof m.cpLoss === 'number')).toBe(true);
    expect(bookMoves(fenAfter(['d4', 'd5', 'Kd2']))).toEqual([]);
  });

  it('isBookMove: theory is book, trap-line blunders and novelties are not', async () => {
    await loadOpenings();
    const sic = play(['e4', 'c5']);
    expect(isBookMove(sic.before[1], sic.ucis[1], sic.fens[1])).toBe(true);
    const qgd = play(['c4', 'e6', 'Nc3', 'd5', 'd4', 'Nf6']);
    expect(isBookMove(qgd.before[5], qgd.ucis[5], qgd.fens[5])).toBe(true); // reached by transposition
    const naj = play(NAJDORF);
    for (let i = 0; i < NAJDORF.length; i++) expect(isBookMove(naj.before[i], naj.ucis[i], naj.fens[i])).toBe(true);
    // Fool's Mate line: 2.g4?? is in the dataset but loses outright.
    const fool = play(['f3', 'e5', 'g4']);
    expect(isBookPosition(fool.fens[2])).toBe(true);
    expect(bookMoves(fool.before[2]).find((m) => m.uci === 'g2g4')!.cpLoss).toBeGreaterThanOrEqual(BOOK_BLUNDER_CP);
    expect(isBookMove(fool.before[2], fool.ucis[2], fool.fens[2])).toBe(false);
    const nov = play(['d4', 'd5', 'Kd2']);
    expect(isBookMove(nov.before[2], nov.ucis[2], nov.fens[2])).toBe(false);
  });
});

describe('bot book usage', () => {
  it('profiles get deeper, stricter and more main-line with Elo', () => {
    const mid = () => 0.5;
    let prev = bookProfile(100, mid);
    for (let elo = 200; elo <= 3200; elo += 100) {
      const p = bookProfile(elo, mid);
      expect(p.maxPly).toBeGreaterThanOrEqual(prev.maxPly);
      expect(p.leaveProb).toBeLessThanOrEqual(prev.leaveProb);
      expect(p.maxCpLoss).toBeLessThanOrEqual(prev.maxCpLoss);
      expect(p.alpha).toBeGreaterThanOrEqual(prev.alpha);
      prev = p;
    }
    expect(bookProfile(100, () => 0).maxPly).toBe(2);
    expect(bookProfile(3200, () => 0.999).maxPly).toBe(38);
  });

  it('never leaves on the first ply, respects maxPly and remembers leaving', async () => {
    await loadOpenings();
    const p = { ...bookProfile(100, () => 0), leaveProb: 1 };
    const state: BookState = { left: false };
    expect(pickBookMove(START, 0, p, state, () => 0.5)).not.toBeNull();
    const after = fenAfter(['e4']);
    expect(pickBookMove(after, 1, p, state, () => 0.5)).toBeNull();
    expect(state.left).toBe(true);
    expect(pickBookMove(START, 0, p, state, () => 0.5)).toBeNull(); // once left, never back
    expect(pickBookMove(after, 5, { ...p, leaveProb: 0, maxPly: 5 }, { left: false }, () => 0.5)).toBeNull();
  });

  it('never plays trap-line blunders and prefers main lines at high Elo', async () => {
    await loadOpenings();
    const rng = mulberry32(8);
    const barnes = fenAfter(['f3', 'e5']); // book: 2.e4, 2.Kf2, 2.g4?? (Fool's Mate)
    for (let i = 0; i < 500; i++) {
      const m = pickBookMove(barnes, 2, { ...bookProfile(100, rng), leaveProb: 0 }, { left: false }, rng);
      expect(m).not.toBe('g2g4');
    }
    const first: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      const m = pickBookMove(START, 0, bookProfile(3200, rng), { left: false }, rng)!;
      first[m] = (first[m] ?? 0) + 1;
    }
    expect(((first.e2e4 ?? 0) + (first.d2d4 ?? 0)) / 1000).toBeGreaterThan(0.75);
    const low: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      const m = pickBookMove(START, 0, bookProfile(100, rng), { left: false }, rng)!;
      low[m] = (low[m] ?? 0) + 1;
    }
    expect(Object.keys(low).length).toBeGreaterThan(Object.keys(first).length); // weak bots wander
  });

  it('plays only legal book moves along a whole book game', async () => {
    await loadOpenings();
    const rng = mulberry32(21);
    for (let g = 0; g < 50; g++) {
      const chess = new Chess();
      const profile = bookProfile(2000, rng);
      const state: BookState = { left: false };
      for (let ply = 0; ply < 40; ply++) {
        const m = pickBookMove(chess.fen(), ply, profile, state, rng);
        if (!m) break;
        chess.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] }); // throws if illegal
        expect(isBookPosition(chess.fen())).toBe(true);
      }
    }
  });
});
