import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult, Score } from '../../src/engine/types';
import type { MoveClass } from '../../src/analysis/types';
import { toWhitePov } from '../../src/chess/utils';
import { gameAccuracy } from '../../src/analysis/accuracy';
import {
  classifyByWinLoss,
  classifyFromEvals,
  classifyMove,
  classifyMoveDetailed,
  ratingTier,
  type ClassifyFacts,
  type MoverEval,
} from '../../src/analysis/classify';
import { capturedFreeMaterial, detectSacrifice, isObviousEscape, see, unsafePieces } from '../../src/analysis/sacrifice';
import { resultScore } from '../../src/analysis/winprob';

const cp = (value: number): Score => ({ kind: 'cp', value });
const mate = (value: number): Score => ({ kind: 'mate', value });
const result = (value: 0 | 0.5 | 1): MoverEval => ({ kind: 'result', value });
const L = (uci: string, score: MoverEval) => ({ uci, score });

describe('classifyByWinLoss (chess.com Expected Points table)', () => {
  it('uses half-open intervals', () => {
    expect(classifyByWinLoss(0)).toBe('excellent');
    expect(classifyByWinLoss(0.0199)).toBe('excellent');
    expect(classifyByWinLoss(0.02)).toBe('good');
    expect(classifyByWinLoss(0.05)).toBe('inaccuracy');
    expect(classifyByWinLoss(0.1)).toBe('mistake');
    expect(classifyByWinLoss(0.2)).toBe('blunder');
    expect(classifyByWinLoss(1)).toBe('blunder');
  });

  it('is more generous for lower ratings', () => {
    expect(ratingTier(800).brilliantMaxLoss).toBeGreaterThan(ratingTier(1500).brilliantMaxLoss);
    expect(ratingTier(1500).brilliantMaxLoss).toBeGreaterThan(ratingTier(2200).brilliantMaxLoss);
    expect(ratingTier()).toEqual(ratingTier(1500));
  });
});

describe('classifyFromEvals: reference vectors', () => {
  type Vec = { id: string; desc: string; f: Partial<ClassifyFacts> & Pick<ClassifyFacts, 'lines' | 'playedUci' | 'played'>; exp: MoveClass; reason?: string };
  const vs: Vec[] = [
    { id: 'V1', desc: 'engine top move, quiet', f: { lines: [L('e2e4', cp(30)), L('d2d4', cp(25))], playedUci: 'e2e4', played: cp(30) }, exp: 'best', reason: 'top_move' },
    { id: 'V2', desc: 'small loss 50 -> 40', f: { lines: [L('a', cp(50)), L('b', cp(45))], playedUci: 'x', played: cp(40) }, exp: 'excellent' },
    { id: 'V3', desc: '50 -> 20', f: { lines: [L('a', cp(50))], playedUci: 'x', played: cp(20) }, exp: 'good' },
    { id: 'V4', desc: '50 -> -20', f: { lines: [L('a', cp(50))], playedUci: 'x', played: cp(-20) }, exp: 'inaccuracy' },
    { id: 'V5', desc: '50 -> -80', f: { lines: [L('a', cp(50))], playedUci: 'x', played: cp(-80) }, exp: 'mistake' },
    { id: 'V6', desc: 'hangs a knight 50 -> -250', f: { lines: [L('a', cp(50))], playedUci: 'x', played: cp(-250) }, exp: 'blunder' },
    { id: 'V7', desc: 'already lost -800 -> -1500', f: { lines: [L('a', cp(-800))], playedUci: 'x', played: cp(-1500) }, exp: 'good' },
    { id: 'V8', desc: 'still crushing +1500 -> +900', f: { lines: [L('a', cp(1500))], playedUci: 'x', played: cp(900) }, exp: 'good' },
    { id: 'V9', desc: 'allows mate from +0.5', f: { lines: [L('a', cp(50))], playedUci: 'x', played: mate(-3) }, exp: 'blunder', reason: 'allowed_mate' },
    { id: 'V10', desc: 'allows mate when already -12 (floor)', f: { lines: [L('a', cp(-1200))], playedUci: 'x', played: mate(-5) }, exp: 'inaccuracy', reason: 'allowed_mate' },
    { id: 'V11', desc: 'had M3, played +12 (floor)', f: { lines: [L('a', mate(3))], playedUci: 'x', played: cp(1200) }, exp: 'inaccuracy', reason: 'lost_mate' },
    { id: 'V12', desc: 'had M2, played +3', f: { lines: [L('a', mate(2))], playedUci: 'x', played: cp(300) }, exp: 'blunder', reason: 'lost_mate' },
    { id: 'V13', desc: 'M2 available, played M5', f: { lines: [L('a', mate(2))], playedUci: 'x', played: mate(5) }, exp: 'good', reason: 'mate_slower' },
    { id: 'V14', desc: 'mated anyway: best M-5, played M-2', f: { lines: [L('a', mate(-5))], playedUci: 'x', played: mate(-2) }, exp: 'good', reason: 'mated_anyway' },
    { id: 'V15', desc: 'only legal move', f: { lines: [L('a', cp(-40))], playedUci: 'a', played: cp(-40), legalMoveCount: 1 }, exp: 'forced', reason: 'forced' },
    { id: 'V16', desc: 'book move', f: { lines: [L('a', cp(30))], playedUci: 'x', played: cp(10), isBook: true }, exp: 'book', reason: 'book' },
    { id: 'V17', desc: 'delivers checkmate', f: { lines: [L('a', mate(1))], playedUci: 'a', played: result(1) }, exp: 'best', reason: 'mate_delivered' },
    { id: 'V18', desc: 'only move: +20 vs 2nd -250', f: { lines: [L('a', cp(20)), L('b', cp(-250))], playedUci: 'a', played: cp(20) }, exp: 'great', reason: 'only_move' },
    { id: 'V19', desc: 'only move but winning anyway (2nd +8)', f: { lines: [L('a', cp(1500)), L('b', cp(800))], playedUci: 'a', played: cp(1500) }, exp: 'best' },
    { id: 'V20', desc: 'equal -> winning: 320 vs 230', f: { lines: [L('a', cp(320)), L('b', cp(230))], playedUci: 'a', played: cp(320) }, exp: 'great', reason: 'outcome_changing' },
    { id: 'V21', desc: 'only move, but a free capture / recapture', f: { lines: [L('a', cp(20)), L('b', cp(-250))], playedUci: 'a', played: cp(20), capturedFreeMaterial: true }, exp: 'best' },
    { id: 'V22', desc: 'sound knight sacrifice, best move', f: { lines: [L('s', cp(150)), L('q', cp(40))], playedUci: 's', played: cp(150), sacrifice: { netValue: 3 } }, exp: 'brilliant', reason: 'sacrifice' },
    { id: 'V23', desc: 'sacrifice but winning anyway (2nd +7.5)', f: { lines: [L('s', cp(900)), L('q', cp(750))], playedUci: 's', played: cp(900), sacrifice: { netValue: 3 } }, exp: 'best' },
    { id: 'V24', desc: 'sacrifice, best, but worse after (-0.3) -> great', f: { lines: [L('s', cp(-30)), L('q', cp(-200))], playedUci: 's', played: cp(-30), sacrifice: { netValue: 3 } }, exp: 'great' },
    { id: 'V25', desc: 'unsound sacrifice 60 -> -100', f: { lines: [L('q', cp(60))], playedUci: 's', played: cp(-100), sacrifice: { netValue: 3 } }, exp: 'mistake', reason: 'hangs_material' },
    { id: 'V26a', desc: 'near-best sacrifice (loss .027), rating 900', f: { lines: [L('q', cp(100)), L('s', cp(70))], playedUci: 's', played: cp(70), sacrifice: { netValue: 3 }, rating: 900 }, exp: 'brilliant' },
    { id: 'V26b', desc: 'same, rating 1500', f: { lines: [L('q', cp(100)), L('s', cp(70))], playedUci: 's', played: cp(70), sacrifice: { netValue: 3 }, rating: 1500 }, exp: 'good' },
    { id: 'V27', desc: 'miss: opponent blundered (+4.5 available), played +0.3', f: { lines: [L('w', cp(450))], playedUci: 'x', played: cp(30), opponentPrevWinLoss: 0.4 }, exp: 'miss', reason: 'missed_win' },
    { id: 'V28', desc: 'not a miss: ended worse than before the error', f: { lines: [L('w', cp(450))], playedUci: 'x', played: cp(-200), opponentPrevWinLoss: 0.4 }, exp: 'blunder' },
    { id: 'V29', desc: 'stalemates the opponent from +9', f: { lines: [L('a', cp(900))], playedUci: 'x', played: result(0.5) }, exp: 'blunder' },
    { id: 'V30', desc: 'stalemate trick saves a lost game', f: { lines: [L('a', cp(0)), L('b', cp(-800))], playedUci: 'a', played: result(0.5) }, exp: 'great' },
    // Extra cases beyond the research vectors.
    { id: 'X1', desc: 'book move refused when it loses mistake-level EP', f: { lines: [L('a', cp(50))], playedUci: 'x', played: cp(-250), isBook: true }, exp: 'blunder', reason: 'book_refused' },
    { id: 'X2', desc: 'book move with an inaccuracy-level loss stays book', f: { lines: [L('a', cp(50))], playedUci: 'x', played: cp(-20), isBook: true }, exp: 'book' },
    { id: 'X3', desc: 'exact MultiPV tie counts as best', f: { lines: [L('a', cp(30)), L('b', cp(30))], playedUci: 'b', played: cp(30) }, exp: 'best', reason: 'tie' },
    { id: 'X4', desc: 'separate child search with zero loss is only excellent', f: { lines: [L('a', cp(30)), L('b', cp(20))], playedUci: 'x', played: cp(45) }, exp: 'excellent' },
    { id: 'X5', desc: 'allows mate at -8 (lichess mistake band)', f: { lines: [L('a', cp(-800))], playedUci: 'x', played: mate(-2) }, exp: 'mistake', reason: 'allowed_mate' },
    { id: 'X6', desc: 'had M4, played +8 (lichess mistake band)', f: { lines: [L('a', mate(4))], playedUci: 'x', played: cp(800) }, exp: 'mistake', reason: 'lost_mate' },
    { id: 'X7', desc: 'slower mate by 1 is excellent', f: { lines: [L('a', mate(1)), L('b', mate(2))], playedUci: 'b', played: mate(2) }, exp: 'excellent', reason: 'mate_slower' },
    { id: 'X8', desc: 'much slower mate (+7 moves) is an inaccuracy', f: { lines: [L('a', mate(2))], playedUci: 'x', played: mate(9) }, exp: 'inaccuracy' },
    { id: 'X9', desc: 'same mate distance is best', f: { lines: [L('a', mate(3)), L('b', mate(3))], playedUci: 'b', played: mate(3) }, exp: 'best' },
    { id: 'X10', desc: 'mated one move sooner is excellent', f: { lines: [L('a', mate(-5))], playedUci: 'x', played: mate(-4) }, exp: 'excellent', reason: 'mated_anyway' },
    { id: 'X11', desc: 'throws away a mate into a lost position', f: { lines: [L('a', mate(2))], playedUci: 'x', played: mate(-3) }, exp: 'blunder' },
    { id: 'X12', desc: 'no Great with three legal moves or fewer', f: { lines: [L('a', cp(20)), L('b', cp(-250))], playedUci: 'a', played: cp(20), legalMoveCount: 3 }, exp: 'best' },
    { id: 'X13', desc: 'no Great when escaping check', f: { lines: [L('a', cp(20)), L('b', cp(-250))], playedUci: 'a', played: cp(20), inCheckBefore: true }, exp: 'best' },
    { id: 'X14', desc: 'no Brilliant or Great for a promotion', f: { lines: [L('s', cp(150)), L('q', cp(-100))], playedUci: 's', played: cp(150), sacrifice: { netValue: 3 }, isPromotion: true }, exp: 'best' },
    { id: 'X15', desc: 'near-best sacrifice at rating 2200 is not brilliant', f: { lines: [L('q', cp(100)), L('s', cp(85))], playedUci: 's', played: cp(85), sacrifice: { netValue: 3 }, rating: 2200 }, exp: 'excellent' },
    { id: 'X16', desc: 'near-best sacrifice (loss .013) at club level is brilliant', f: { lines: [L('q', cp(100)), L('s', cp(85))], playedUci: 's', played: cp(85), sacrifice: { netValue: 3 } }, exp: 'brilliant' },
    { id: 'X17', desc: 'small sacrifice (net 1) is not brilliant', f: { lines: [L('s', cp(150)), L('q', cp(-100))], playedUci: 's', played: cp(150), sacrifice: { netValue: 1 } }, exp: 'great' },
    { id: 'X18', desc: 'no Miss when the opponent only erred slightly', f: { lines: [L('w', cp(450))], playedUci: 'x', played: cp(30), opponentPrevWinLoss: 0.05 }, exp: 'blunder' },
    { id: 'X19', desc: 'Miss when a forced mate was missed', f: { lines: [L('w', mate(3))], playedUci: 'x', played: cp(50), opponentPrevWinLoss: 0.5 }, exp: 'miss' },
    { id: 'X20', desc: 'no Miss when the played move keeps a winning position', f: { lines: [L('w', cp(900))], playedUci: 'x', played: cp(350), opponentPrevWinLoss: 0.4 }, exp: 'mistake' },
    { id: 'X21', desc: 'unsearched move estimated from the worst line is capped at good', f: { lines: [L('a', cp(50))], playedUci: 'x', played: null }, exp: 'good', reason: 'estimated' },
    { id: 'X22', desc: 'unsearched move below a losing worst line is still a blunder', f: { lines: [L('a', cp(50)), L('b', cp(-300))], playedUci: 'x', played: null }, exp: 'blunder' },
    { id: 'X23', desc: 'no engine data at all', f: { lines: [], playedUci: 'x', played: null }, exp: 'good', reason: 'no_data' },
    { id: 'X24', desc: 'no data but forced', f: { lines: [], playedUci: 'x', played: null, legalMoveCount: 1 }, exp: 'forced' },
    { id: 'X25', desc: 'top move uses the top line value even if another eval is passed', f: { lines: [L('a', cp(40)), L('b', cp(-300))], playedUci: 'a', played: cp(-500) }, exp: 'great' },
    { id: 'X26', desc: 'ignoring a fresh threat is brilliant only as the top move', f: { lines: [L('q', cp(100)), L('s', cp(85))], playedUci: 's', played: cp(85), sacrifice: { netValue: 3, ignoresThreat: true } }, exp: 'excellent' },
    { id: 'X27', desc: 'ignoring a fresh threat as the only good move is brilliant', f: { lines: [L('s', cp(150)), L('q', cp(-40))], playedUci: 's', played: cp(150), sacrifice: { netValue: 3, ignoresThreat: true } }, exp: 'brilliant', reason: 'sacrifice' },
    { id: 'X27b', desc: 'ignoring a fresh threat as the top move among equals is only best', f: { lines: [L('s', cp(449)), L('q', cp(436))], playedUci: 's', played: cp(449), sacrifice: { netValue: 2, ignoresThreat: true } }, exp: 'best' },
    { id: 'X28', desc: 'a queen up (+6.3) is winning anyway, even below 1200', f: { lines: [L('q', cp(632)), L('s', cp(576))], playedUci: 's', played: cp(576), sacrifice: { netValue: 4 }, rating: 100 }, exp: 'excellent' },
    { id: 'X29', desc: 'no Great for moving an attacked piece to its only safe square', f: { lines: [L('a', cp(-54)), L('b', cp(-555))], playedUci: 'a', played: cp(-54), obviousEscape: true }, exp: 'best' },
  ];

  const base = { legalMoveCount: 30, inCheckBefore: false, isBook: false };
  for (const v of vs) {
    it(`${v.id} ${v.desc} -> ${v.exp}`, () => {
      const r = classifyFromEvals({ ...base, ...v.f });
      expect(r.cls).toBe(v.exp);
      if (v.reason) expect(r.reasons).toContain(v.reason);
      expect(r.winLoss).toBeCloseTo(Math.max(0, r.winBefore - r.winAfter), 12);
      expect(r.accuracy).toBeGreaterThanOrEqual(0);
      expect(r.accuracy).toBeLessThanOrEqual(100);
    });
  }

  it('has at least 30 classification vectors', () => {
    expect(vs.length).toBeGreaterThanOrEqual(30);
  });

  it('reports the reference EP numbers', () => {
    const v4 = classifyFromEvals({ ...base, lines: [L('a', cp(50))], playedUci: 'x', played: cp(-20) });
    expect(v4.winBefore).toBeCloseTo(0.5459, 4);
    expect(v4.winAfter).toBeCloseTo(0.4816, 4);
    expect(v4.winLoss).toBeCloseTo(0.0643, 4);
    expect(v4.accuracy).toBeCloseTo(75.8, 1);
    const v6 = classifyFromEvals({ ...base, lines: [L('a', cp(50))], playedUci: 'x', played: cp(-250) });
    expect(v6.winLoss).toBeCloseTo(0.261, 3);
    expect(v6.accuracy).toBeCloseTo(30.9, 1);
    const v11 = classifyFromEvals({ ...base, lines: [L('a', mate(3))], playedUci: 'x', played: cp(1200) });
    expect(v11.accuracy).toBe(100); // lichess counts any mate as +10
    const v27 = classifyFromEvals({ ...base, lines: [L('w', cp(450))], playedUci: 'x', played: cp(30), opponentPrevWinLoss: 0.4 });
    expect(v27.winBefore).toBeCloseTo(0.8398, 4);
    expect(v27.accuracy).toBeCloseTo(24.3, 1);
    const x23 = classifyFromEvals({ ...base, lines: [], playedUci: 'x', played: null });
    expect([x23.winBefore, x23.winAfter, x23.winLoss, x23.accuracy]).toEqual([0.5, 0.5, 0, 100]);
  });
});

const fenAfter = (sans: string[], fen?: string) => {
  const c = new Chess(fen);
  for (const m of sans) c.move(m);
  return c.fen();
};

const RAD1 = '8/3k1nb1/1rpp2p1/pN6/4P3/6PN/PPP2K1P/R6R w - - 0 30';

describe('sacrifice detection (legal-move SEE)', () => {
  const cases: [string, string, string, string | null][] = [
    ["Legall: 5.Nxe5 leaves the queen to Bxd1", fenAfter(['e4', 'e5', 'Nf3', 'd6', 'Bc4', 'Bg4', 'Nc3', 'g6']), 'f3e5', 'q@d1 net 5'],
    ['Greek gift 7.Bxh7+', fenAfter(['e4', 'e6', 'd4', 'd5', 'Nc3', 'Nf6', 'e5', 'Nfd7', 'Nf3', 'Be7', 'Bd3', 'O-O']), 'd3h7', 'b@h7 net 2'],
    ['Exchange Bxc6 (a trade)', fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']), 'b5c6', null],
    ['Exchange sacrifice Rxe5 dxe5', '4k3/8/3p4/4n3/8/8/8/4RK2 w - - 0 1', 'e1e5', 'r@e5 net 2'],
    ['Pawn fork: the queen escapes, the knight stays loose', '4k3/8/8/2p5/1N1Q4/8/8/4K3 w - - 0 1', 'd4e4', null],
    ['Quiet developing move', fenAfter(['e4', 'e5']), 'g1f3', null],
    ['Knight to a square guarded by a pawn (Ng5?? after h6)', fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'h6']), 'f3g5', 'n@g5 net 3'],
    ['Knight next to a pawn that is pinned to its king', '4k3/8/2p5/8/BN6/8/8/4K3 w - - 0 1', 'b4d5', null],
    ['Same knight move without the pin', '4k3/8/2p5/8/1N6/8/8/B3K3 w - - 0 1', 'b4d5', 'n@d5 net 3'],
    ['Promotion is never a sacrifice', '8/4P3/8/8/8/8/k7/4K2r w - - 0 1', 'e7e8q', null],
    ['Illegal move does not throw', fenAfter(['e4', 'e5']), 'e1e5', null],
    // A piece that was already en prise and stays en prise is not a new offer.
    ['Quiet move while a knight is already attacked', '4k3/8/8/2p5/3N4/8/P7/4K3 w - - 0 1', 'a2a3', null],
    ['Rad1 with the knight on b5 already hanging', RAD1, 'a1d1', null],
    ['Kg2 with the knight on b5 already hanging', RAD1, 'f2g2', null],
    ['Raf1 with the knight on b5 already hanging', RAD1, 'a1f1', null],
    ['Be2 with the rook on d2 already attacked', 'r2qk2r/1b3ppp/p3pn2/1p6/1bP4P/3PPNP1/1B1R1P2/1N1QKB1R w Kkq - 0 18', 'f1e2', null],
    ['Qc3 with the rook on g8 already attacked', '2r2kr1/5p1p/p3pN2/qb2Q2P/8/3PP1P1/5P2/3R2K1 b - - 4 29', 'a5c3', null],
    // A move that takes away a defender newly offers the piece.
    ['Removing the only defender of a knight', '4k3/8/8/3r4/3N4/8/8/3RK3 w - - 0 1', 'd1a1', 'n@d4 net 3'],
  ];
  for (const [name, fen, uci, exp] of cases) {
    it(name, () => {
      const s = detectSacrifice(fen, uci);
      expect(s ? `${s.piece}@${s.square} net ${s.netValue}` : null).toBe(exp);
    });
  }

  it('counts an ignored threat only when the opponent has just made it', () => {
    const fmt = (x: ReturnType<typeof detectSacrifice>) => (x ? `${x.piece}@${x.square} net ${x.netValue}${x.ignoresThreat ? ' ignores' : ''}` : null);
    // Rad1: the knight on b5 was already hanging before Black's last move (after Kf2).
    expect(fmt(detectSacrifice(RAD1, 'a1d1', '8/2pk1nb1/1r1p2p1/pN6/4P3/6PN/PPP2K1P/R6R b - - 1 29'))).toBeNull();
    // 3...a6 attacks the knight on b5 (defended by the bishop): h3 ignores that new threat.
    const beforeA6 = fenAfter(['e4', 'e5', 'Nc3', 'Nc6', 'Nb5']);
    const afterA6 = fenAfter(['a6'], beforeA6);
    expect(fmt(detectSacrifice(afterA6, 'h2h3'))).toBeNull();
    expect(fmt(detectSacrifice(afterA6, 'h2h3', beforeA6))).toBe('n@b5 net 2 ignores');
    // A pawn fork: saving the queen is not a sacrifice of the knight, even though the threat is new.
    const fork = '4k3/8/8/2p5/1N1Q4/8/8/4K3 w - - 0 1';
    expect(fmt(detectSacrifice(fork, 'd4e4', '4k3/8/2p5/8/1N1Q4/8/8/4K3 b - - 0 1'))).toBeNull();
  });

  it('isObviousEscape: an attacked piece moved to its only safe square', () => {
    // 4.b4 attacks the bishop on a5: b6 is its only safe square (Bxb4 loses it to axb4).
    const bb6 = 'rnbqk1nr/pppp1ppp/8/b3p3/1P2P3/P1N5/2PP1PPP/R1BQKBNR b KQkq - 0 4';
    expect(isObviousEscape(bb6, 'a5b6')).toBe(true);
    // A knight attacked by a pawn with several safe squares: choosing one is not obvious.
    expect(isObviousEscape('4k3/8/8/8/3p4/4N3/8/4K3 w - - 0 1', 'e3c4')).toBe(false);
    // Not attacked, a capture, or an illegal move.
    expect(isObviousEscape(fenAfter(['e4', 'e5']), 'g1f3')).toBe(false);
    expect(isObviousEscape(bb6, 'a5b4')).toBe(false);
    expect(isObviousEscape(bb6, 'a5a1')).toBe(false);
  });

  it('see() plays least valuable attacker first and may stop', () => {
    // Rook on e5 attacked by a pawn and defended by a pawn: the pawn wins the rook for a pawn.
    const c = new Chess('4k3/8/3p4/4R3/3P4/8/8/4K3 b - - 0 1');
    expect(see(c, 'e5')).toBe(4);
    expect(c.fen()).toBe('4k3/8/3p4/4R3/3P4/8/8/4K3 b - - 0 1'); // restored
    // Defended pawn attacked by a queen only: not worth taking.
    expect(see(new Chess('4k3/8/3p4/4p3/8/8/8/4QK2 w - - 0 1'), 'e5')).toBe(0);
  });

  it('unsafePieces lists loose pieces of a colour', () => {
    const loose = unsafePieces('4k3/8/8/2p5/1N1Q4/8/8/4K3 w - - 0 1', 'w');
    expect(loose.map((p) => p.square).sort()).toEqual(['b4', 'd4']);
    expect(unsafePieces(fenAfter(['e4', 'e5']), 'w')).toEqual([]);
  });

  it('capturedFreeMaterial: winning captures and plain recaptures', () => {
    // Takes an undefended knight.
    expect(capturedFreeMaterial('4k3/8/8/3n4/8/8/8/3QK3 w - - 0 1', 'd1d5')).toBe(true);
    // Queen takes a pawn defended by a pawn: loses material.
    expect(capturedFreeMaterial('4k3/8/3p4/4p3/8/8/8/4QK2 w - - 0 1', 'e1e5')).toBe(false);
    // Pawn recapture on a square the opponent defends: even by SEE, but a recapture of their last move.
    const recapture = '4k3/8/2p5/3P4/4P3/8/8/4K3 b - - 0 1';
    expect(capturedFreeMaterial(recapture, 'c6d5')).toBe(false);
    expect(capturedFreeMaterial(recapture, 'c6d5', 'd5')).toBe(true);
    // Not a capture.
    expect(capturedFreeMaterial(fenAfter(['e4', 'e5']), 'g1f3')).toBe(false);
  });
});

const line = (multipv: number, score: Score, pv: string[]) => ({ multipv, depth: 18, score, pv });
const analysis = (fen: string, lines: ReturnType<typeof line>[], extra: Partial<AnalysisResult> = {}): AnalysisResult => ({
  fen,
  depth: lines.length ? 18 : 0,
  lines,
  bestMove: lines[0]?.pv[0] ?? null,
  done: true,
  ...extra,
});

describe('classifyMove on real positions', () => {
  const ITALIAN = fenAfter(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);

  it('fills every Classification field', () => {
    const before = analysis(ITALIAN, [line(1, cp(-20), ['f8c5', 'c2c3']), line(2, cp(-25), ['g8f6']), line(3, cp(-60), ['d7d6'])]);
    const c = classifyMove({ fenBefore: ITALIAN, moveUci: 'g8f6', before });
    expect(c).toEqual({
      cls: 'excellent',
      winBefore: expect.closeTo(0.4816, 4),
      winAfter: expect.closeTo(0.4770, 4),
      winLoss: expect.closeTo(0.0046, 4),
      accuracy: expect.closeTo(98.956, 3),
      bestMoveUci: 'f8c5',
      bestMoveSan: 'Bc5',
      playedMoveSan: 'Nf6',
    });
  });

  it('uses before.lines for the played move (same search) even when after disagrees', () => {
    const before = analysis(ITALIAN, [line(1, cp(-20), ['f8c5']), line(2, cp(-25), ['g8f6'])]);
    const after = analysis(fenAfter(['Nf6'], ITALIAN), [line(1, cp(400), ['f3g5'])]);
    const c = classifyMove({ fenBefore: ITALIAN, moveUci: 'g8f6', before, after });
    expect(c.cls).toBe('excellent');
    expect(c.winAfter).toBeCloseTo(0.477, 3);
  });

  it('falls back to after.lines[0] converted to the mover when the move is not in before.lines', () => {
    const before = analysis(ITALIAN, [line(1, cp(-20), ['f8c5']), line(2, cp(-25), ['g8f6'])]);
    const afterFen = fenAfter(['Qh4'], ITALIAN);
    const after = analysis(afterFen, [line(1, cp(300), ['f3h4'])]);
    const c = classifyMove({ fenBefore: ITALIAN, moveUci: 'd8h4', before, after });
    expect(c.cls).toBe('blunder');
    expect(c.winAfter).toBeCloseTo(0.2489, 4);
    expect(c.playedMoveSan).toBe('Qh4');
    // A mate score in the child position is converted with the mate distance shifted by one move.
    const mated = classifyMoveDetailed({ fenBefore: ITALIAN, moveUci: 'd8h4', before, after: analysis(afterFen, [line(1, mate(2), ['c4f7'])]) });
    expect(mated.classification.cls).toBe('blunder');
    expect(mated.classification.winAfter).toBe(0);
    expect(mated.reasons).toContain('allowed_mate');
  });

  it('recognises a delivered checkmate from the board', () => {
    const fen = fenAfter(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6']);
    const before = analysis(fen, [line(1, mate(1), ['h5f7']), line(2, cp(-200), ['h5h4'])]);
    const after: AnalysisResult & { terminal: 'checkmate' } = { ...analysis(fenAfter(['Qxf7#'], fen), []), terminal: 'checkmate' };
    const c = classifyMove({ fenBefore: fen, moveUci: 'h5f7', before, after });
    expect(c).toMatchObject({ cls: 'best', winBefore: 1, winAfter: 1, winLoss: 0, accuracy: 100, playedMoveSan: 'Qxf7#' });
    // Without the after analysis the board alone is enough.
    expect(classifyMove({ fenBefore: fen, moveUci: 'h5f7', before }).cls).toBe('best');
  });

  it('scores a stalemate as a draw', () => {
    const fen = '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1';
    const before = analysis(fen, [line(1, mate(1), ['e7g7']), line(2, mate(1), ['e7f8'])]);
    const c = classifyMove({ fenBefore: fen, moveUci: 'e7f7', before });
    expect(c.cls).toBe('blunder');
    expect(c.winAfter).toBe(0.5);
  });

  it('marks a single legal move as forced', () => {
    const fen = fenAfter(['e4', 'e5', 'Nf3', 'd6', 'Bc4', 'Bg4', 'Nc3', 'g6', 'Nxe5', 'Bxd1', 'Bxf7+']);
    const before = analysis(fen, [line(1, mate(-1), ['e8e7'])]);
    expect(new Chess(fen).moves()).toHaveLength(1);
    const c = classifyMove({ fenBefore: fen, moveUci: 'e8e7', before });
    expect(c).toMatchObject({ cls: 'forced', winBefore: 0, winAfter: 0, winLoss: 0, playedMoveSan: 'Ke7' });
  });

  it('honours isBook unless the engine calls the move a mistake', () => {
    const start = new Chess().fen();
    const before = analysis(start, [line(1, cp(30), ['e2e4']), line(2, cp(25), ['d2d4'])]);
    const after = analysis(fenAfter(['a3']), [line(1, cp(0), ['e7e5'])]);
    expect(classifyMove({ fenBefore: start, moveUci: 'd2d4', before, isBook: true }).cls).toBe('book');
    expect(classifyMove({ fenBefore: start, moveUci: 'a2a3', before, after, isBook: true }).cls).toBe('book');
    const bad = analysis(fenAfter(['f3']), [line(1, cp(150), ['e7e5'])]);
    expect(classifyMove({ fenBefore: start, moveUci: 'f2f3', before, after: bad, isBook: true }).cls).toBe('mistake');
  });

  it('labels a Miss using the opponent previous loss', () => {
    const fen = fenAfter(['e4', 'e5', 'Nf3', 'Qh4']);
    const before = analysis(fen, [line(1, cp(855), ['f3h4']), line(2, cp(204), ['b1c3'])]);
    const after = analysis(fenAfter(['d3'], fen), [line(1, cp(-103), ['h4e7'])]);
    expect(classifyMove({ fenBefore: fen, moveUci: 'd2d3', before, after, opponentPrevWinLoss: 0.43 }).cls).toBe('miss');
    expect(classifyMove({ fenBefore: fen, moveUci: 'd2d3', before, after }).cls).toBe('blunder');
  });

  it('does not call a plain recapture Great', () => {
    const fen = '4k3/8/2p5/3P4/4P3/8/8/4K3 b - - 0 1';
    const before = analysis(fen, [line(1, cp(20), ['c6d5']), line(2, cp(-250), ['e8d7']), line(3, cp(-260), ['c6c5'])]);
    expect(classifyMove({ fenBefore: fen, moveUci: 'c6d5', before }).cls).toBe('great');
    expect(classifyMove({ fenBefore: fen, moveUci: 'c6d5', before, prevMove: { to: 'd5' } }).cls).toBe('best');
  });

  it('applies rating tiers to Brilliant', () => {
    const fen = fenAfter(['e4', 'e5', 'Nf3', 'd6', 'Bc4', 'Bg4', 'Nc3', 'g6']);
    const before = analysis(fen, [line(1, cp(100), ['d2d4']), line(2, cp(70), ['f3e5'])]);
    expect(classifyMove({ fenBefore: fen, moveUci: 'f3e5', before, playerRating: 900 }).cls).toBe('brilliant');
    expect(classifyMove({ fenBefore: fen, moveUci: 'f3e5', before, playerRating: 1500 }).cls).toBe('good');
    const detail = classifyMoveDetailed({ fenBefore: fen, moveUci: 'f3e5', before, playerRating: 900 });
    expect(detail.sacrifice).toEqual({ netValue: 5, square: 'd1', piece: 'q' });
  });

  it('does not call leaving an already hanging piece Brilliant (Rad1)', () => {
    // Na3 saves the knight; Rad1 leaves it hanging (+5 -> +4.8 is still within the <1200 tier).
    const before = analysis(RAD1, [line(1, cp(504), ['b5a3', 'b6b2']), line(2, cp(499), ['a1e1']), line(3, cp(492), ['b5d6'])]);
    const after = analysis(fenAfter(['Rad1'], RAD1), [line(1, cp(-479), ['b6b5'])]);
    const d = classifyMoveDetailed({ fenBefore: RAD1, moveUci: 'a1d1', before, after, playerRating: 800 });
    expect(d.classification.cls).toBe('excellent');
    expect(d.sacrifice).toBeNull();
  });

  it('does not call giving back material a queen up Brilliant (Rxe4+ at 100)', () => {
    const fen = 'rnbqkb2/ppppppp1/7n/8/2B1P2r/2N2N2/PPPP1PPP/R1B1K2R b KQq - 5 5';
    const before = analysis(fen, [line(1, cp(632), ['h4g4']), line(2, cp(627), ['h4h5']), line(3, cp(604), ['d7d5'])]);
    const after = analysis(fenAfter(['Rxe4+'], fen), [line(1, cp(-576), ['c3e4', 'd7d5'])]);
    const d = classifyMoveDetailed({ fenBefore: fen, moveUci: 'h4e4', before, after, playerRating: 100 });
    expect(d.sacrifice).toMatchObject({ square: 'e4', piece: 'r' });
    expect(d.classification.cls).toBe('excellent');
  });

  it('does not call queening or an obvious escape Great', () => {
    const kpkr = '8/4P3/8/8/8/k7/7r/4K3 w - - 0 1';
    const promo = analysis(kpkr, [line(1, cp(247), ['e7e8q', 'h2b2']), line(2, cp(0), ['e7e8r']), line(3, cp(-14), ['e7e8n'])]);
    expect(classifyMove({ fenBefore: kpkr, moveUci: 'e7e8q', before: promo }).cls).toBe('best');
    const bb6 = 'rnbqk1nr/pppp1ppp/8/b3p3/1P2P3/P1N5/2PP1PPP/R1BQKBNR b KQkq - 0 4';
    const esc = analysis(bb6, [line(1, cp(-54), ['a5b6', 'g1f3']), line(2, cp(-555), ['d7d5']), line(3, cp(-561), ['g8f6'])]);
    expect(classifyMove({ fenBefore: bb6, moveUci: 'a5b6', before: esc }).cls).toBe('best');
    // Still Great when the attacked piece had to find the one good square among several safe ones.
    const kn = '4k3/8/8/8/3p4/4N3/8/4K3 w - - 0 1';
    const knight = analysis(kn, [line(1, cp(200), ['e3c4']), line(2, cp(-100), ['e3f5']), line(3, cp(-120), ['e3g4'])]);
    expect(classifyMove({ fenBefore: kn, moveUci: 'e3c4', before: knight }).cls).toBe('great');
  });

  it('never throws on missing or odd input', () => {
    const empty = analysis(ITALIAN, []);
    const noLines = classifyMove({ fenBefore: ITALIAN, moveUci: 'g8f6', before: { ...empty, bestMove: 'f8c5' } });
    expect(noLines).toMatchObject({ cls: 'good', winBefore: 0.5, winAfter: 0.5, winLoss: 0, bestMoveUci: 'f8c5', bestMoveSan: 'Bc5', playedMoveSan: 'Nf6' });
    // Move not in the lines and no after analysis: estimated, capped at good.
    const before = analysis(ITALIAN, [line(1, cp(-20), ['f8c5'])]);
    expect(classifyMove({ fenBefore: ITALIAN, moveUci: 'h7h6', before }).cls).toBe('good');
    // Only after analysis available.
    const onlyAfter = classifyMove({ fenBefore: ITALIAN, moveUci: 'h7h6', before: empty, after: analysis(fenAfter(['h6'], ITALIAN), [line(1, cp(60), ['d2d4'])]) });
    expect(onlyAfter.cls).toBe('good');
    expect(onlyAfter.winAfter).toBeCloseTo(onlyAfter.winBefore, 12);
    // Illegal move and a broken FEN.
    expect(() => classifyMove({ fenBefore: ITALIAN, moveUci: 'a1a8', before })).not.toThrow();
    expect(classifyMove({ fenBefore: ITALIAN, moveUci: 'a1a8', before }).playedMoveSan).toBe('a1a8');
    expect(() => classifyMove({ fenBefore: 'not a fen', moveUci: 'e2e4', before: empty })).not.toThrow();
    // Lines with an empty PV are ignored.
    const odd = analysis(ITALIAN, [{ multipv: 1, depth: 3, score: cp(10), pv: [] }]);
    expect(() => classifyMove({ fenBefore: ITALIAN, moveUci: 'g8f6', before: odd })).not.toThrow();
  });
});

interface FixturePly {
  san: string;
  uci: string;
  before: AnalysisResult;
  after: AnalysisResult & { terminal?: 'checkmate' | 'stalemate' };
}
const engineGames = JSON.parse(
  readFileSync(new URL('../fixtures/classify-engine-games.json', import.meta.url), 'utf8'),
) as { games: { name: string; startFen: string; plies: FixturePly[] }[] };

/** Classifies a recorded game the way the controller will: sequentially, chaining the opponent's loss. */
function reviewGame(name: string) {
  const g = engineGames.games.find((x) => x.name === name)!;
  let prevLoss: number | undefined;
  let prevTo: string | undefined;
  const evals: (Score | null)[] = [toWhitePov(resultScore(g.plies[0].before)!, g.startFen)];
  const out = g.plies.map((p) => {
    const c = classifyMove({
      fenBefore: p.before.fen,
      moveUci: p.uci,
      before: p.before,
      after: p.after,
      opponentPrevWinLoss: prevLoss,
      prevMove: prevTo ? { to: prevTo } : undefined,
    });
    prevLoss = c.winLoss;
    prevTo = p.uci.slice(2, 4);
    const s = resultScore(p.after);
    evals.push(s ? toWhitePov(s, p.after.fen) : null);
    return { san: p.san, c };
  });
  const byMove = Object.fromEntries(out.map(({ san, c }) => [san, c.cls]));
  return { out, byMove, accuracy: gameAccuracy(evals, { startColor: g.startFen.split(' ')[1] === 'b' ? 'b' : 'w' }) };
}

describe('classifyMove on real Stockfish 19 analyses (fixture)', () => {
  it("Legall's mate: the queen sacrifice is brilliant, taking it is a blunder", () => {
    const { byMove, accuracy } = reviewGame("Legall's mate");
    expect(byMove).toMatchObject({ e4: 'best', g6: 'mistake', Nxe5: 'brilliant', Bxd1: 'blunder', 'Bxf7+': 'best', Ke7: 'forced', 'Nd5#': 'best' });
    expect(accuracy.w!).toBeGreaterThan(90);
    expect(accuracy.b!).toBeLessThan(60);
  });

  it("Scholar's mate: Nf6 allows mate in one", () => {
    const { byMove } = reviewGame("Scholar's mate");
    expect(byMove).toMatchObject({ Nf6: 'blunder', 'Qxf7#': 'best' });
  });

  it('a hung queen that is not taken is a Miss', () => {
    const { byMove } = reviewGame('Missed queen (miss)');
    expect(byMove).toMatchObject({ Qh4: 'blunder', d3: 'miss' });
  });

  it('Blackburne-Shilling trap', () => {
    const { byMove } = reviewGame('Blackburne Shilling');
    expect(byMove).toMatchObject({ Nxe5: 'mistake', Qg5: 'great', Nxf7: 'blunder', Qxg2: 'best', Be2: 'mistake', 'Nf3#': 'best' });
  });

  it('mate ladder and forced replies', () => {
    const { byMove } = reviewGame('Slower mate, forced reply');
    expect(byMove).toEqual({ 'Qf6+': 'excellent', Kg8: 'forced', 'Qd8#': 'best' });
  });

  it('stalemating a won position is a blunder', () => {
    const { byMove, accuracy } = reviewGame('Stalemate given away');
    expect(byMove).toEqual({ Qf7: 'blunder' });
    expect(accuracy.b).toBeNull();
  });

  it('keeps every field consistent on every recorded ply', () => {
    let plies = 0;
    for (const g of engineGames.games) {
      for (const { san, c } of reviewGame(g.name).out) {
        expect(c.playedMoveSan).toBe(san);
        for (const p of [c.winBefore, c.winAfter, c.winLoss]) {
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
        }
        expect(c.winLoss).toBeCloseTo(Math.max(0, c.winBefore - c.winAfter), 12);
        expect(c.accuracy).toBeGreaterThanOrEqual(0);
        expect(c.accuracy).toBeLessThanOrEqual(100);
        expect(c.bestMoveSan).not.toBeNull();
        plies++;
      }
    }
    expect(plies).toBeGreaterThanOrEqual(40);
  });
});
