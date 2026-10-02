import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  absolutePinner,
  attacksFrom,
  between,
  effectiveAttackers,
  exchangeCounts,
  hangingPieces,
  scratch,
  see,
  winningCaptures,
} from '../../src/analysis/see';

const fenOf = (sans: string) => {
  const c = new Chess();
  for (const s of sans.split(' ').filter(Boolean)) c.move(s);
  return c.fen();
};

describe('exchangeCounts', () => {
  it('counts x-ray attackers and leaves pinned defenders out', () => {
    // Queen with the rook behind it against the king.
    expect(exchangeCounts('3qk3/8/8/8/8/8/3Q4/3RK3 w - - 0 1', 'd8', 'w', 'd2')).toEqual({ attackers: 2, defenders: 1 });
    // The knight on e7 is pinned by the rook on e1.
    expect(exchangeCounts('4k3/4n1pp/8/3p4/8/1B6/5PPP/4R1K1 w - - 0 1', 'd5', 'w')).toEqual({ attackers: 1, defenders: 0 });
    // Two pawns against a knight and the queen behind it.
    expect(exchangeCounts('rnbqkb1r/ppp2ppp/5n2/3p4/2PPP3/8/PP3PPP/RNBQKBNR w KQkq - 0 4', 'd5', 'w', 'c4')).toEqual({
      attackers: 2,
      defenders: 2,
    });
  });
});

describe('see (static exchange evaluation)', () => {
  it('matches the swap-algorithm reference values', () => {
    expect(see('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', 'd5', 'w')).toBe(1); // pawn takes a free pawn
    expect(see('4k3/8/2p5/3p4/8/8/8/3RK3 w - - 0 1', 'd5', 'w')).toBe(-4); // rook takes a pawn defended by a pawn
    expect(see('4k3/3r4/8/3p4/8/8/3R4/3RK3 w - - 0 1', 'd5', 'w')).toBe(1); // doubled rooks (x-ray) vs one defender
    expect(see('4k3/3r4/8/3p4/8/8/3R4/3QK3 w - - 0 1', 'd5', 'w')).toBe(1); // R+Q battery vs a rook
    // R+Q battery vs R+N (needs exact values, not CPW's sign-only pruning)
    expect(see('4k3/3rn3/8/3p4/8/8/3R4/3QK3 w - - 0 1', 'd5', 'w')).toBe(-4);
    // the king cannot recapture into a defended square
    expect(see('8/8/8/3pk3/2P5/8/8/3RK3 w - - 0 1', 'd5', 'w')).toBe(1);
    expect(see('1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'b8', 'w')).toBe(13); // capture-promotion
  });

  it('returns 0 when nobody attacks the square', () => {
    expect(see('4k3/8/8/3p4/8/8/8/4K3 w - - 0 1', 'd5', 'w')).toBe(0);
  });

  it('ignores a defender that is pinned to its king', () => {
    // Pawn c6 would recapture on d5, but Ba4 pins it to the king on e8.
    const fen = '4k3/8/2p5/3n4/B7/8/8/3RK3 w - - 0 1';
    expect(see(fen, 'd5', 'w')).toBe(3);
    // Without the pin the pawn recaptures and the rook is lost for a knight.
    expect(see('4k3/8/2p5/3n4/8/8/8/3RK3 w - - 0 1', 'd5', 'w')).toBe(-2);
  });

  it('ignores an attacker that is pinned to its king', () => {
    // Nf3 attacks e5 but is pinned to Kg2 by Bb7.
    const fen = '4k3/1b6/8/4p3/8/5N2/6K1/8 w - - 0 1';
    expect(see(fen, 'e5', 'w')).toBe(0);
    expect(hangingPieces(fen, 'b')).toEqual([]);
  });

  it('lets a pinned piece capture along the pin line', () => {
    // Re2 is pinned by Re8 but may take it.
    expect(see('4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1', 'e8', 'w')).toBe(5);
  });
});

describe('attack helpers', () => {
  it('attacksFrom walks rays and stops at the first piece', () => {
    const b = scratch('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    const rookRays = ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'b1', 'c1', 'd1', 'e1'];
    expect(attacksFrom(b, 'a1').sort()).toEqual(rookRays.sort());
    expect(attacksFrom(b, 'e1').sort()).toEqual(['d1', 'd2', 'e2', 'f1', 'f2'].sort());
  });

  it('between is strict and only for straight lines', () => {
    expect(between('a1', 'h8', 'd4')).toBe(true);
    expect(between('a1', 'h8', 'a1')).toBe(false);
    expect(between('a1', 'h8', 'h8')).toBe(false);
    expect(between('a1', 'b3', 'a2')).toBe(false);
  });

  it('finds absolute pins and pin-aware attackers', () => {
    const b = scratch('4k3/1b6/8/4p3/8/5N2/6K1/8 w - - 0 1');
    expect(absolutePinner(b, 'f3')).toBe('b7');
    expect(absolutePinner(b, 'e5')).toBeNull();
    expect(b.attackers('e5', 'w')).toEqual(['f3']);
    expect(effectiveAttackers(b, 'e5', 'w')).toEqual([]);
    expect(effectiveAttackers(b, 'd4', 'w')).toEqual([]);
    expect(effectiveAttackers(b, 'e4', 'b')).toEqual(['b7']);
  });
});

describe('hangingPieces / winningCaptures', () => {
  it('finds the queen hanging after 3.Qg4??', () => {
    const fen = fenOf('e4 e5 Nc3 Nf6 Qg4');
    const h = hangingPieces(fen, 'w');
    const rows = h.map((x) => [x.piece.type, x.piece.square, x.see, x.defenders, x.lowerAttacker?.type]);
    expect(rows).toEqual([['q', 'g4', 9, 0, 'n']]);
  });

  it('lists legal winning captures, best first', () => {
    const fen = fenOf('e4 e5 Nc3 Nf6 Qg4');
    const w = winningCaptures(fen);
    expect(w[0]).toMatchObject({ san: 'Nxg4', from: 'f6', to: 'g4', gain: 9 });
    expect(winningCaptures(new Chess().fen())).toEqual([]);
  });

  it('skips captures by pinned pieces', () => {
    expect(winningCaptures('4k3/1b6/8/4p3/8/5N2/6K1/8 w - - 0 1')).toEqual([]);
  });
});
