import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  backRankWeak,
  forcedMateLine,
  forkTargets,
  isBackRankMate,
  linesFrom,
  materialOutcome,
  mateInOne,
  moveMotifs,
  nullMoveFen,
  passTurn,
  principles,
  promotionPushes,
  stoppedThreat,
  threatsAgainst,
  trappedPieces,
} from '../../src/analysis/motifs';
import { describeMaterial } from '../../src/analysis/explain';

const fenOf = (sans: string, start?: string) => {
  const c = new Chess(start);
  for (const s of sans.split(' ').filter(Boolean)) c.move(s);
  return c.fen();
};
const START = new Chess().fen();
const kinds = (fen: string, uci: string) => moveMotifs(fen, uci)!.motifs.map((m) => m.kind);
const texts = (fen: string, uci: string) => principles(fen, uci).map((p) => p.kind);

describe('forks, pins, skewers, trapped pieces', () => {
  it('finds a royal knight fork (most valuable target first)', () => {
    expect(forkTargets('r3k3/ppN2ppp/8/8/8/8/PPP2PPP/4K3 b - - 0 1', 'c7').map((t) => t.type + t.square)).toEqual([
      'ke8',
      'ra8',
    ]);
  });

  it("finds Blackburne's Qg5 double attack on e5 and g2", () => {
    const fen = fenOf('e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5');
    expect(forkTargets(fen, 'g5').map((t) => t.type + t.square)).toEqual(['ne5', 'pg2']);
  });

  it('ignores a forker that can simply be taken', () => {
    // The knight on c7 is attacked by the queen on d8 (and nothing defends it).
    expect(forkTargets('r2qk3/ppN2ppp/8/8/8/8/PPP2PPP/4K3 b - - 0 1', 'c7')).toEqual([]);
  });

  it('finds pins and skewers', () => {
    const pin = linesFrom('4k3/8/8/4q3/8/5P2/8/4RK2 w - - 0 1', 'w');
    expect(pin).toMatchObject([{ kind: 'pin', pinned: { type: 'q' }, behind: { type: 'k' } }]);
    expect(linesFrom(fenOf('e4 e5 Nf3 Nc6 Bb5 d6'), 'w').map((m) => m.kind)).toEqual(['pin']);
    expect(linesFrom('8/8/R1k3q1/8/8/8/8/4K3 b - - 0 1', 'w').map((m) => m.kind)).toEqual(['skewer']);
    // The piece behind the king is a defended pawn: no skewer.
    expect(linesFrom('8/8/R1k2p1p/6p1/8/8/8/4K3 b - - 0 1', 'w')).toEqual([]);
  });

  it('finds a knight trapped in the corner', () => {
    const trapped = trappedPieces('N1bk1bnr/p1p1pppp/1p6/3q4/8/8/PPPPPPPP/R1BQKBNR w KQ - 0 1');
    expect(trapped.map((p) => p.type + p.square)).toEqual(['na8']);
  });

  it('a piece another move saves (a block) is not trapped', () => {
    // Légal pattern, 5.Nxe5? Nxe5: every queen move loses it, but f3 or Be2 blocks the bishop.
    const fen = fenOf('Nxe5 Nxe5', 'r2qkbnr/ppp2p1p/2np2p1/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 5');
    expect(trappedPieces(fen)).toEqual([]);
  });

  it('keeps the "before" baselines when the mover escapes check', () => {
    // The knight on a1 is already trapped when Black gives check; Kf2 does not trap it.
    const fen = '6k1/4r3/8/5B2/3Q4/1P6/P7/n3K3 w - - 0 1';
    expect(trappedPieces(passTurn(fen)).map((p) => p.square)).toEqual(['a1']);
    expect(kinds(fen, 'e1f2')).not.toContain('trapped');
    // Qxg7# (and the double attack) were threatened before ...Qe1+: Rxe1 does not create them.
    const qe1 = kinds('4r1k1/ppp2pb1/8/3n1N1P/6Q1/2P5/PP4P1/R1K1qR2 w - - 3 34', 'f1e1');
    expect(qe1).not.toContain('trapped');
    expect(qe1).not.toContain('mateThreat');
    expect(qe1).not.toContain('doubleThreat');
  });
});

describe('mates, back rank and null-move threats', () => {
  it('detects a weak back rank and back-rank mates', () => {
    expect(backRankWeak('r5k1/5ppp/8/8/8/1R6/5PPP/6K1 w - - 0 1', 'w')).toBe(true);
    expect(backRankWeak('r5k1/5ppp/8/8/8/1R5P/5PP1/6K1 w - - 0 1', 'w')).toBe(false);
    expect(isBackRankMate('6k1/5ppp/8/8/8/8/5PPP/r5K1 w - - 0 1')).toBe(true);
    expect(isBackRankMate(fenOf('e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#'))).toBe(false);
  });

  it('finds mates in one and short forced mates', () => {
    expect(mateInOne('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4')).toEqual(['Qxf7#']);
    const legal = fenOf('e4 e5 Nf3 d6 Bc4 Bg4 Nc3 Nc6 h3 Bh5 Nxe5 Bxd1');
    expect(forcedMateLine(legal)).toEqual(['Bxf7+', 'Ke7', 'Nd5#']);
    expect(forcedMateLine(START)).toBeNull();
  });

  it('makes null moves on a scratch board and refuses them in check', () => {
    expect(nullMoveFen('r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3')).toBe(
      'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4',
    );
    expect(nullMoveFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3')).toBeNull();
  });

  it('lists threats against the side to move: mate, promotion, material', () => {
    const scholar = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
    expect(threatsAgainst(scholar)[0]).toMatchObject({ kind: 'mate', san: 'Qxf7#', from: 'h5', to: 'f7' });
    const blackburne = fenOf('e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5');
    expect(threatsAgainst(blackburne)[0]).toMatchObject({ kind: 'material', san: 'Qxe5', to: 'e5', gain: 3 });
    // A plain pawn push that promotes.
    const push = threatsAgainst('8/8/8/8/8/8/p7/4K2k w - - 0 1')[0];
    expect(push).toMatchObject({ kind: 'promotion', san: 'a1=Q+', to: 'a1' });
    expect(promotionPushes('8/8/8/8/8/8/p7/4K2k b - - 0 1').map((p) => p.san)).toEqual(['a1=Q+']);
    // A guarded promotion square is no threat.
    expect(promotionPushes('8/8/8/8/8/8/p7/1R2K2k b - - 0 1')).toEqual([]);
    expect(threatsAgainst(START)).toEqual([]);
  });

  it('knows which defensive move stops a threat', () => {
    const scholar = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3';
    expect(stoppedThreat(scholar, 'g7g6')?.san).toBe('Qxf7#');
    expect(stoppedThreat(scholar, 'g8f6')).toBeNull();
  });
});

describe('materialOutcome / describeMaterial', () => {
  const say = (fen: string, pv: string[], pov: 'w' | 'b') => describeMaterial(materialOutcome(fen, pv, pov));

  it('names the material won', () => {
    expect(say('4k3/8/8/3n4/4P3/8/8/4K3 w - - 0 1', ['e4d5', 'e8d7', 'e1e2'], 'w')).toBe('wins a knight');
    expect(say('4k3/8/8/3r4/8/4N3/8/4K3 w - - 0 1', ['e3d5', 'e8d7'], 'w')).toBe('wins a rook');
    expect(say('4k3/8/2p5/3r4/8/4N3/8/4K3 w - - 0 1', ['e3d5', 'c6d5', 'e1e2', 'e8e7'], 'w')).toBe('wins the exchange');
    expect(say('8/P7/8/8/8/8/1k6/6K1 w - - 0 1', ['a7a8q', 'b2c3', 'g1f2'], 'w')).toBe('promotes to a queen');
    expect(say('3qk3/8/8/8/8/8/8/3QK3 w - - 0 1', ['d1d8', 'e8d8', 'e1e2', 'd8e7'], 'w')).toBeNull();
    expect(say('4k3/8/8/3n4/4P3/8/8/4K3 w - - 0 1', ['e4d5', 'e8d7', 'e1e2'], 'b')).toBe('loses a knight');
  });

  it('names a single net minor piece after the first one captured', () => {
    // Legal trap line: Qxh5 takes the bishop, then bishops are traded on c4 and the knight falls.
    const fen = 'r2qkbnr/ppp2ppp/3p4/4n2b/2B1P3/2N4P/PPPP1PP1/R1BQK2R w KQkq - 0 7';
    const out = materialOutcome(fen, ['d1h5', 'e5c4', 'h5b5', 'c7c6', 'b5c4'], 'w');
    expect(out.won).toEqual({ b: 1 });
  });
});

describe('moveMotifs', () => {
  it('finds a discovered attack with check', () => {
    expect(kinds('3q4/8/7k/8/3N4/8/8/3RK3 w - - 0 1', 'd4f5')).toEqual(['check', 'discovered']);
  });

  it("sees Legal's Nxe5 as a losing capture that uncovers the queen", () => {
    expect(kinds(fenOf('e4 e5 Nf3 d6 Bc4 Bg4 Nc3 Nc6 h3 Bh5'), 'f3e5')).toEqual(['losingCapture', 'discovered']);
  });

  it('finds mate and material threats created by a move', () => {
    expect(kinds(fenOf('e4 e5 Qh5 Nc6'), 'f1c4')).toContain('mateThreat');
    expect(kinds(fenOf('e4 e5'), 'g1f3')).toContain('threat');
    expect(kinds(fenOf('e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6'), 'f3b3')).toContain('doubleThreat');
  });

  it('counts the castling rook (attacking a pinned piece)', () => {
    const opera = fenOf('e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7');
    const pin = moveMotifs(opera, 'e1c1')!.motifs.find((m) => m.kind === 'pin');
    expect(pin).toMatchObject({ kind: 'pin', exploit: true, pinned: { square: 'd7' } });
  });

  it('counts the pawn taken en passant', () => {
    // exd6 e.p. is recaptured: an even trade, not a losing capture.
    expect(kinds(fenOf('e4 a6 e5 d5'), 'e5d6')).not.toContain('losingCapture');
    // Undefended: a free pawn, reported on the square it stood on.
    const free = moveMotifs('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5d6')!.motifs;
    const capture = free.find((m) => m.kind === 'freeCapture');
    expect(capture).toMatchObject({ captured: { square: 'd5', type: 'p' } });
  });

  it('returns null for an illegal move and memoises frozen results', () => {
    expect(moveMotifs(START, 'e2e5')).toBeNull();
    const a = moveMotifs(START, 'e2e4');
    expect(moveMotifs(START, 'e2e4')).toBe(a);
    expect(Object.isFrozen(a!.motifs)).toBe(true);
  });
});

describe('principles', () => {
  it('rates opening moves', () => {
    expect(texts(START, 'e2e4')).toEqual(['centrePawn', 'opensLine']);
    expect(texts(START, 'g1f3')).toEqual(['develops', 'centreControl']);
    expect(texts(START, 'b1a3')).toEqual(['develops', 'knightRim']);
    expect(texts(fenOf('e4 e5 Nf3 Nc6 Bc4 Bc5'), 'e1g1')).toEqual(['castles']);
    expect(texts(fenOf('e4 e5'), 'd1h5')).toEqual(['earlyQueen']);
    expect(texts(fenOf('e4'), 'h7h5')).toEqual(['edgePawn']);
    expect(texts(fenOf('e4 e5'), 'e1e2')).toEqual(['kingWalk']);
    expect(texts(fenOf('e4 e5'), 'f2f3')).toEqual(['fPawn']);
  });

  it('rates middlegame and endgame moves', () => {
    expect(texts('r5k1/5ppp/8/8/8/1R6/5PPP/6K1 w - - 0 1', 'h2h3')).toEqual(['luft']);
    expect(texts('2r3k1/pp3pp1/7p/8/8/8/PP3PPP/3R2K1 w - - 0 1', 'd1d7')).toEqual(['rookSeventh']);
    expect(texts('6k1/pp3pp1/7p/8/8/8/PP3PPP/R5K1 w - - 0 1', 'a1d1')).toEqual(['openFile']);
    expect(texts('8/5k2/8/3P4/8/8/5K2/8 w - - 0 1', 'd5d6')).toEqual(['passedPawn']);
    expect(texts('8/5k2/8/3P4/8/8/5K2/8 w - - 0 1', 'f2e3')).toEqual(['kingActive']);
    expect(texts('3qk3/8/8/8/8/8/5PPP/R2QK3 w - - 0 1', 'd1d8')).toEqual(['tradeAhead']);
  });
});
