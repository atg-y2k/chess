/**
 * Near-equal awareness (src/analysis/nearEqual.ts): when the coach treats moves as "about as
 * good", the data classifyMove records for it (`equalBest`, `nearBest`, `aboveBest`), the second
 * opinion (`nearBestRecheck`, `bestAfter`), and every wording branch.
 */
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { classifyMove, EP_THRESHOLDS, nearBestRecheck } from '../../src/analysis/classify';
import { explainBestMove, explainMove, type Perspective } from '../../src/analysis/explain';
import {
  NEAR_EQUAL_CP,
  NEAR_EQUAL_MAX,
  NEAR_EQUAL_MAX_CP,
  NEAR_EQUAL_RECHECK_CP,
  NEAR_EQUAL_SEARCH_CP,
  NEAR_EQUAL_WIN,
  aboutAsGood,
  aboutEqual,
  alternativesSentence,
  bestMoveNote,
  bestWasSentence,
  equalAlternatives,
  isNearBest,
  nearBestSentence,
  nearEqualLines,
  withAlternatives,
} from '../../src/analysis/nearEqual';
import type { Classification } from '../../src/analysis/types';
import { cpToWin } from '../../src/analysis/winprob';
import { parseUci } from '../../src/chess/utils';
import type { AnalysisResult, PvLine, Score } from '../../src/engine/types';

const cp = (value: number): Score => ({ kind: 'cp', value });
const mate = (value: number): Score => ({ kind: 'mate', value });
const pv = (score: Score, moves: string, multipv = 1): PvLine => ({ multipv, depth: 14, score, pv: moves.split(' ') });
const result = (fen: string, lines: PvLine[], extra: Partial<AnalysisResult> = {}): AnalysisResult => ({
  fen,
  depth: lines.length ? 14 : 0,
  lines: lines.map((l, i) => ({ ...l, multipv: i + 1 })),
  bestMove: lines[0]?.pv[0] ?? null,
  done: true,
  ...extra,
});
const after = (fen: string, uci: string) => {
  const c = new Chess(fen);
  c.move(parseUci(uci));
  return c.fen();
};

/** THE USER'S position: 1.d4 d5 2.c4 Nf6 3.cxd5, Black to move (they played 3...Nxd5). */
const USER = 'rnbqkb1r/ppp1pppp/5n2/3P4/3P4/8/PP2PPPP/RNBQKBNR b KQkq - 0 3';
/**
 * The coach's lines there (depth 14, MultiPV 3; side to move = Black's point of view, so -57 is
 * White better by 0.57): c6, c5 and g6 within 12 cp. A depth-24 search ranks them g6, c6, c5.
 */
const USER_BEFORE = result(USER, [
  pv(cp(-57), 'c7c6 d5c6 b8c6 g1f3 e7e5 d4e5'),
  pv(cp(-67), 'c7c5 e2e4 f6e4 d4c5 d8a5 c1d2'),
  pv(cp(-69), 'g7g6 g1f3 f8g7 d1a4 c7c6 d5c6'),
]);
/** After 3...Nxd5 the coach's search gives White +0.85 (White to move): 28 cp behind the c6 line. */
const NXD5 = after(USER, 'f6d5');
const USER_AFTER = result(NXD5, [pv(cp(85), 'e2e4 d5f6 b1c3 e7e5')]);
/**
 * The second opinion: the position after 3...c6 searched the same way gives White +0.62, so c6
 * scored like Nxd5 is 23 cp ahead of it (the real engine: c6 -60 against Nxd5 -82).
 */
const C6 = after(USER, 'c7c6');
const USER_BEST_AFTER = result(C6, [pv(cp(62), 'd5c6 b8c6 g1f3 e7e5')]);

function annotate(
  fen: string,
  uci: string,
  before: AnalysisResult,
  afterResult?: AnalysisResult,
  perspective: Perspective = 'you',
  bestAfter?: AnalysisResult,
) {
  const classification = classifyMove({ fenBefore: fen, moveUci: uci, before, after: afterResult, playerRating: 1200, bestAfter });
  const explanation = explainMove({ fenBefore: fen, moveUci: uci, classification, before, after: afterResult, perspective });
  return { classification, explanation, text: [explanation.headline, ...explanation.details] };
}

describe('the near-equal rule', () => {
  it('has named constants: 25 cp against a best line, 30 between two searches of their own (the second opinion, asked up to 60 cp behind), or under 0.02 expected score (the Excellent band) up to 50 cp apart', () => {
    expect(NEAR_EQUAL_CP).toBe(25);
    expect(NEAR_EQUAL_SEARCH_CP).toBe(30);
    expect(NEAR_EQUAL_RECHECK_CP).toBe(60);
    expect(NEAR_EQUAL_WIN).toBe(EP_THRESHOLDS.excellent);
    expect(NEAR_EQUAL_MAX_CP).toBe(50);
    expect(NEAR_EQUAL_MAX).toBe(3);
  });

  it('centipawns: at most NEAR_EQUAL_CP apart (NEAR_EQUAL_SEARCH_CP between two searches of their own)', () => {
    expect(aboutEqual(cp(0), cp(25))).toBe(true);
    expect(aboutEqual(cp(0), cp(26))).toBe(false);
    expect(aboutEqual(cp(-200), cp(-226))).toBe(false);
    expect(aboutEqual(cp(500), cp(475))).toBe(true);
    // THE USER'S Nxd5 (its own search: -85) against the line c6 (-57): 28 cp, outside the band...
    expect(aboutEqual(cp(-57), cp(-85))).toBe(false);
    // ...but against c6 scored the same way (-62): 23 cp.
    expect(aboutAsGood(cp(-85), cp(-62), NEAR_EQUAL_SEARCH_CP)).toBe(true);
    expect(aboutEqual(cp(0), cp(30), NEAR_EQUAL_SEARCH_CP)).toBe(true);
    expect(aboutEqual(cp(0), cp(31), NEAR_EQUAL_SEARCH_CP)).toBe(false);
  });

  it('expected score: under NEAR_EQUAL_WIN apart counts only up to NEAR_EQUAL_MAX_CP', () => {
    // +9.00 against +8.55: 45 cp, but both win (0.965 / 0.960).
    expect(cpToWin(900) - cpToWin(855)).toBeLessThan(NEAR_EQUAL_WIN);
    expect(aboutEqual(cp(900), cp(855))).toBe(true);
    expect(aboutEqual(cp(900), cp(850))).toBe(true);
    expect(aboutEqual(cp(900), cp(849))).toBe(false);
    // Four pawns are never about as good, however won the game is.
    expect(cpToWin(2553) - cpToWin(2140)).toBeLessThan(0.001);
    expect(aboutEqual(cp(2553), cp(2140))).toBe(false);
    // In a balanced position 45 cp is a real difference (0.04 expected score).
    expect(aboutEqual(cp(20), cp(-25))).toBe(false);
  });

  it('mates: only the same mate is about equal; never a mate and a centipawn score', () => {
    expect(aboutEqual(mate(3), mate(3))).toBe(true);
    expect(aboutEqual(mate(3), mate(4))).toBe(false);
    expect(aboutEqual(mate(5), cp(2000))).toBe(false);
    expect(aboutEqual(cp(-2000), mate(-5))).toBe(false);
    expect(aboutEqual(mate(-4), mate(-4))).toBe(true);
    expect(aboutEqual(mate(0), mate(-1))).toBe(false);
  });

  it('is symmetric', () => {
    const scores = [cp(0), cp(25), cp(31), cp(900), cp(870), cp(-400), mate(2), mate(3), mate(-2)];
    for (const a of scores) {
      for (const b of scores) {
        expect(aboutEqual(a, b)).toBe(aboutEqual(b, a));
        expect(aboutEqual(a, b, NEAR_EQUAL_SEARCH_CP)).toBe(aboutEqual(b, a, NEAR_EQUAL_SEARCH_CP));
      }
    }
  });

  it('aboutAsGood: about equal, or better (a faster mate, a longer defense)', () => {
    expect(aboutAsGood(cp(-80), cp(-57))).toBe(true);
    expect(aboutAsGood(cp(-85), cp(-57))).toBe(false);
    expect(aboutAsGood(cp(200), cp(-57))).toBe(true);
    expect(aboutAsGood(mate(2), mate(3))).toBe(true);
    expect(aboutAsGood(mate(3), mate(2))).toBe(false);
    expect(aboutAsGood(mate(4), cp(1500))).toBe(true);
    expect(aboutAsGood(cp(1500), mate(4))).toBe(false);
    expect(aboutAsGood(mate(-5), mate(-3))).toBe(true);
    expect(aboutAsGood(mate(-3), mate(-5))).toBe(false);
    expect(aboutAsGood(cp(-1500), mate(-3))).toBe(true);
    expect(aboutAsGood(mate(-3), cp(-1500))).toBe(false);
  });

  it('nearEqualLines: the best line and those about as good, at most NEAR_EQUAL_MAX', () => {
    expect(nearEqualLines(USER_BEFORE.lines).map((l) => l.pv[0])).toEqual(['c7c6', 'c7c5', 'g7g6']);
    expect(nearEqualLines([pv(cp(50), 'a'), pv(cp(10), 'b'), pv(cp(5), 'c')]).map((l) => l.pv[0])).toEqual(['a']);
    expect(nearEqualLines([pv(cp(50), 'a'), pv(cp(40), 'b'), pv(cp(10), 'c')]).map((l) => l.pv[0])).toEqual(['a', 'b']);
    const four = [pv(cp(0), 'a'), pv(cp(0), 'b'), pv(cp(0), 'c'), pv(cp(0), 'd')];
    expect(nearEqualLines(four)).toHaveLength(NEAR_EQUAL_MAX);
    expect(nearEqualLines([{ ...pv(cp(0), 'a'), pv: [] }, pv(cp(-5), 'b')]).map((l) => l.pv[0])).toEqual(['b']);
    expect(nearEqualLines([])).toEqual([]);
    // Mates: a slower mate is not as good as a faster one.
    expect(nearEqualLines([pv(mate(2), 'a'), pv(mate(3), 'b'), pv(mate(2), 'c')]).map((l) => l.pv[0])).toEqual(['a', 'c']);
  });
});

describe('the wording helpers', () => {
  const cl = (over: Partial<Classification> = {}): Classification => ({
    cls: 'good',
    winBefore: 0.45,
    winAfter: 0.42,
    winLoss: 0.03,
    accuracy: 90,
    bestMoveUci: 'c7c6',
    bestMoveSan: 'c6',
    playedMoveSan: 'Nxd5',
    equalBest: [
      { san: 'c6', uci: 'c7c6', score: cp(-57) },
      { san: 'c5', uci: 'c7c5', score: cp(-67) },
      { san: 'g6', uci: 'g7g6', score: cp(-69) },
    ],
    nearBest: true,
    ...over,
  });

  it('withAlternatives / alternativesSentence / bestWasSentence ("and", and no alternatives after a reason)', () => {
    expect(withAlternatives('Best was c6.', [])).toBe('Best was c6.');
    expect(withAlternatives('Best was c6.', ['c5'])).toBe('Best was c6 (c5 was about as good).');
    expect(withAlternatives('Best was c6.', ['c5', 'g6'])).toBe('Best was c6 (c5 and g6 were about as good).');
    expect(alternativesSentence([])).toBeNull();
    expect(alternativesSentence(['c5', 'g6', 'e6'])).toBe('c5, g6 and e6 were about as good.');
    expect(bestWasSentence('Nf3')).toBe('Best was Nf3.');
    expect(bestWasSentence('Nf3', { alternatives: ['Nc3', 'e3'] })).toBe('Best was Nf3 (Nc3 and e3 were about as good).');
    expect(bestWasSentence('Nf3', { reason: 'develops the knight' })).toBe('Best was Nf3, which develops the knight.');
    expect(bestWasSentence('Be2', { reason: 'prepares O-O, which castles' })).toBe('Best was Be2: it prepares O-O, which castles.');
    // A reason is the lesson: a parenthesis after it would read as part of it ("… with bxc4 (Re8 …)").
    expect(bestWasSentence('b5', { reason: 'threatens to win the bishop on c4 with bxc4', alternatives: ['Re8', 'Ba7'] })).toBe(
      'Best was b5, which threatens to win the bishop on c4 with bxc4.',
    );
  });

  it('equalAlternatives leaves out the best move and the played one', () => {
    expect(equalAlternatives(cl()).map((m) => m.san)).toEqual(['c5', 'g6']);
    expect(equalAlternatives(cl(), 'c7c5').map((m) => m.san)).toEqual(['g6']);
    expect(equalAlternatives({ equalBest: undefined, bestMoveUci: 'c7c6' })).toEqual([]);
    expect(equalAlternatives(null)).toEqual([]);
  });

  it('nearBestSentence: "Your Nxd5 was fine: …" for a move the engine did not list, "one of the top choices" for one it did', () => {
    expect(isNearBest(cl(), 'f6d5')).toBe(true);
    expect(nearBestSentence(cl(), 'f6d5')).toBe('Your Nxd5 was fine: c6, c5 and g6 were only slightly better.');
    // The opponent's move.
    expect(nearBestSentence(cl(), 'f6d5', 'neutral')).toBe('Nxd5 was fine: c6, c5 and g6 were only slightly better.');
    expect(nearBestSentence(cl({ equalBest: [{ san: 'c6', uci: 'c7c6' }] }), 'f6d5')).toBe(
      'Your Nxd5 was fine: c6 was only slightly better.',
    );
    expect(nearBestSentence(cl({ playedMoveSan: 'c5' }), 'c7c5')).toBe('c5 is one of the engine’s top choices, with c6 and g6.');
    // The best move itself, a move that was not about as good, an older save, and a move that
    // scored at least as well as the best (nothing to add): no such sentence.
    expect(isNearBest(cl(), 'c7c6')).toBe(false);
    expect(nearBestSentence(cl({ playedMoveSan: 'c6' }), 'c7c6')).toBeNull();
    expect(nearBestSentence(cl({ nearBest: false }), 'f6d5')).toBeNull();
    expect(nearBestSentence(cl({ nearBest: undefined, equalBest: undefined }), 'f6d5')).toBeNull();
    expect(nearBestSentence(cl({ aboveBest: true }), 'f6d5')).toBeNull();
  });

  it('bestMoveNote: the near-equal sentence (or nothing), else "Best was X" with the alternatives, else nothing', () => {
    expect(bestMoveNote(cl(), 'f6d5')).toBe('Your Nxd5 was fine: c6, c5 and g6 were only slightly better.');
    expect(bestMoveNote(cl(), 'f6d5', 'neutral')).toBe('Nxd5 was fine: c6, c5 and g6 were only slightly better.');
    expect(bestMoveNote(cl({ aboveBest: true }), 'f6d5')).toBeNull();
    expect(bestMoveNote(cl({ nearBest: false }), 'f6d5')).toBe('Best was c6 (c5 and g6 were about as good).');
    expect(bestMoveNote(cl({ nearBest: undefined, equalBest: undefined }), 'f6d5')).toBe('Best was c6.');
    expect(bestMoveNote(cl({ playedMoveSan: 'c6' }), 'c7c6')).toBeNull();
  });
});

describe('classifyMove records equalBest and nearBest', () => {
  it('THE USER’S CASE: 3...Nxd5 is 28 cp behind the c6 line, so the coach asks for a second opinion', () => {
    const input = { fenBefore: USER, moveUci: 'f6d5', before: USER_BEFORE, after: USER_AFTER, playerRating: 1200 };
    // The position after the engine's best move, to search like the one after Nxd5.
    expect(nearBestRecheck(input)).toBe(C6);
    expect(nearBestRecheck({ ...input, bestAfter: USER_BEST_AFTER })).toBeNull();
    // Without it, the move is judged against the c6 line alone: not about as good (corrected
    // mildly, as a Good move, and without naming c5 and g6, which Nxd5 matched).
    const alone = classifyMove(input);
    expect(alone).toMatchObject({ cls: 'good', nearBest: false });
    expect(alone.equalBest?.map((m) => m.san)).toEqual(['c6']);
  });

  it('THE USER’S CASE: with the second opinion, 3...Nxd5 is about as good as c6, c5 and g6 (no "Best was c6.")', () => {
    const { classification: c, explanation: e, text } = annotate(USER, 'f6d5', USER_BEFORE, USER_AFTER, 'you', USER_BEST_AFTER);
    // The class is unchanged: 0.025 expected score lost is Good. Like with like, Nxd5 (-85) is
    // 23 cp behind c6 (-62), within NEAR_EQUAL_SEARCH_CP.
    expect(c.cls).toBe('good');
    expect(c.winLoss).toBeCloseTo(0.0253, 3);
    expect(c.nearBest).toBe(true);
    expect(c.aboveBest).toBeUndefined();
    expect(c.equalBest).toEqual([
      { san: 'c6', uci: 'c7c6', score: cp(-57) },
      { san: 'c5', uci: 'c7c5', score: cp(-67) },
      { san: 'g6', uci: 'g7g6', score: cp(-69) },
    ]);
    expect(text).toContain('Your Nxd5 was fine: c6, c5 and g6 were only slightly better.');
    for (const line of text) expect(line).not.toMatch(/Best was|was better|more accurate/);
    expect(e.details.length).toBeLessThanOrEqual(3);
    // The opponent's move, in the third person.
    const theirs = annotate(USER, 'f6d5', USER_BEFORE, USER_AFTER, 'neutral', USER_BEST_AFTER);
    expect(theirs.text).toContain('Nxd5 was fine: c6, c5 and g6 were only slightly better.');
  });

  it('THE USER’S CASE at the edge (real-engine runs that were corrected before): 31 and 33 cp behind the line, about as good like with like', () => {
    // Lines Bf5 -62 / c6 -63 / c5 -64 and Nxd5 +93 (31 cp); Bf5 -56 and Nxd5 +89 (33 cp).
    const bf5 = after(USER, 'c8f5');
    for (const [top, played, own] of [
      [-62, 93, 80],
      [-56, 89, 72],
    ]) {
      const before = result(USER, [
        pv(cp(top), 'c8f5 b1c3 c7c6 d5c6'),
        pv(cp(top - 1), 'c7c6 d5c6 b8c6 g1f3'),
        pv(cp(top - 2), 'c7c5 e2e4 f6e4 d4c5'),
      ]);
      const afterNxd5 = result(NXD5, [pv(cp(played), 'e2e4 d5f6 b1c3 e7e5')]);
      expect(nearBestRecheck({ fenBefore: USER, moveUci: 'f6d5', before, after: afterNxd5 })).toBe(bf5);
      const { classification: c, text } = annotate(USER, 'f6d5', before, afterNxd5, 'you', result(bf5, [pv(cp(own), 'b1c3 c7c6 d5c6 b8c6')]));
      expect(c).toMatchObject({ cls: 'good', nearBest: true });
      expect(text).toContain('Your Nxd5 was fine: Bf5, c6 and c5 were only slightly better.');
      for (const line of text) expect(line).not.toMatch(/Best was|was better|more accurate/);
    }
  });

  it('the second opinion can confirm the correction; the moves the played one matched are then not called "about as good"', () => {
    // A real-engine run: c6 -47, c5 -71, Qxd5 -77; Nxd5 -84 (37 cp behind). Here c6 scored like
    // Nxd5 is -45: 39 cp apart, so Nxd5 was not about as good as c6. c5 is only 13 cp above it:
    // c5 is not named as "about as good" next to the correction.
    const before = result(USER, [pv(cp(-47), 'c7c6 d5c6 b8c6 g1f3'), pv(cp(-71), 'c7c5 e2e4 f6e4 d4c5'), pv(cp(-77), 'd8d5 b1c3 d5a5 c1d2')]);
    const afterNxd5 = result(NXD5, [pv(cp(84), 'e2e4 d5f6 b1c3 e7e5')]);
    const { classification: c, text } = annotate(USER, 'f6d5', before, afterNxd5, 'you', result(C6, [pv(cp(45), 'd5c6 b8c6 g1f3 e7e5')]));
    expect(c).toMatchObject({ cls: 'good', nearBest: false });
    expect(c.equalBest?.map((m) => m.san)).toEqual(['c6']);
    expect(text.some((l) => /^c6 was (better|slightly more accurate)/.test(l))).toBe(true);
    for (const line of text) expect(line).not.toMatch(/about as good|c5/);
  });

  it('no second opinion beyond NEAR_EQUAL_RECHECK_CP, nor for a weak class', () => {
    // 3...e5 at -1.30: 73 cp behind c6.
    const e5 = result(after(USER, 'e7e5'), [pv(cp(130), 'd4e5 f6g4 g1f3 b8c6')]);
    expect(nearBestRecheck({ fenBefore: USER, moveUci: 'e7e5', before: USER_BEFORE, after: e5 })).toBeNull();
    // 3...h6 at -1.15 (58 cp behind, within the window, but an Inaccuracy: never "about as good").
    const h6 = result(after(USER, 'h7h6'), [pv(cp(115), 'e2e4 f6e4 d1a4 c8d7')]);
    const c = classifyMove({ fenBefore: USER, moveUci: 'h7h6', before: USER_BEFORE, after: h6, bestAfter: USER_BEST_AFTER });
    expect(c.cls).toBe('inaccuracy');
    expect(c.nearBest).toBe(false);
    expect(nearBestRecheck({ fenBefore: USER, moveUci: 'h7h6', before: USER_BEFORE, after: h6 })).toBeNull();
  });

  it('a move clearly worse than the best keeps the correction, naming the moves about as good', () => {
    // 3...e5?! at -1.30: 73 cp worse than c6.
    const e5 = result(after(USER, 'e7e5'), [pv(cp(130), 'd4e5 f6g4 g1f3 b8c6')]);
    const { classification: c, text } = annotate(USER, 'e7e5', USER_BEFORE, e5);
    expect(c.cls).toBe('inaccuracy');
    expect(c.nearBest).toBe(false);
    expect(c.equalBest?.map((m) => m.san)).toEqual(['c6', 'c5', 'g6']);
    expect(text).toContain('Best was c6 (c5 and g6 were about as good).');
  });

  it('after a reason, the moves about as good are not named (the parenthesis would read as part of the reason)', () => {
    // A real-engine run without the second opinion: lines Bf5 -62 / c6 -63 / c5 -64, Nxd5 +93.
    const before = result(USER, [pv(cp(-62), 'c8f5 b1c3 c7c6 d5c6'), pv(cp(-63), 'c7c6 d5c6 b8c6 g1f3'), pv(cp(-64), 'c7c5 e2e4 f6e4 d4c5')]);
    const { classification: c, text } = annotate(USER, 'f6d5', before, result(NXD5, [pv(cp(93), 'e2e4 d5f6 b1c3 e7e5')]));
    expect(c).toMatchObject({ cls: 'good', nearBest: false });
    expect(c.equalBest?.map((m) => m.san)).toEqual(['Bf5', 'c6', 'c5']);
    const better = text.find((l) => l.startsWith('Bf5 was better: it '));
    expect(better).toBe('Bf5 was better: it develops the bishop.');
  });

  it('a Good move just outside the band: "slightly more accurate", without the moves it matched', () => {
    // 3...Bf5 at -0.90: 33 cp behind c6 (0.03 expected score), 23 behind c5 and 21 behind g6; c6
    // scored like it is -55, 35 cp ahead.
    const bf5 = result(after(USER, 'c8f5'), [pv(cp(90), 'd1b3 b8d7 b3b7 e7e5')]);
    const { classification: c, text } = annotate(USER, 'c8f5', USER_BEFORE, bf5, 'you', result(C6, [pv(cp(55), 'd5c6 b8c6 g1f3 e7e5')]));
    expect(c.cls).toBe('good');
    expect(c.nearBest).toBe(false);
    expect(c.equalBest?.map((m) => m.san)).toEqual(['c6']);
    expect(text.some((l) => /^c6 was (better: it .*|slightly more accurate)\.$/.test(l))).toBe(true);
  });

  it('the Kieseritzky 5...Be7: a listed move whose own search puts it far below the best line asks for the second opinion', () => {
    // Lines Nf6 +65, Be7 +40, Qe7 +34; the search after 5...Be7 gives White +0.26 (Be7 at -26,
    // 91 cp below Nf6; at depth 20 Be7 is -73 against Nf6 +60, a Mistake).
    const K = 'rnbqkbnr/pppp1p1p/8/4N3/4PppP/8/PPPP2P1/RNBQKB1R b KQkq - 1 5';
    const before = result(K, [pv(cp(65), 'g8f6 f1c4 d7d5'), pv(cp(40), 'f8e7 f1c4 e7h4'), pv(cp(34), 'd8e7 d2d4 d7d6')]);
    const be7 = result(after(K, 'f8e7'), [pv(cp(26), 'f1c4 g8f6 d2d4')]);
    const input = { fenBefore: K, moveUci: 'f8e7', before, after: be7, playerRating: 1200 };
    expect(nearBestRecheck(input)).toBe(after(K, 'g8f6'));
    // Without the second opinion: not "one of the engine’s top choices".
    const alone = classifyMove(input);
    expect(alone.nearBest).toBe(false);
    expect(alone.equalBest?.map((m) => m.san)).toEqual(['Nf6']);
    // With it (Nf6 scored the same way: +45): 71 cp apart, not about as good either.
    const nf6 = result(after(K, 'g8f6'), [pv(cp(-45), 'f1c4 d7d5 e4d5')]);
    const { classification: c, text } = annotate(K, 'f8e7', before, be7, 'you', nf6);
    expect(c.nearBest).toBe(false);
    expect(c.equalBest?.map((m) => m.san)).toEqual(['Nf6']);
    for (const line of text) expect(line).not.toMatch(/top choices|was fine/);
    // A listed move whose own search agrees stays one of the top choices without a second opinion.
    const agrees = result(after(K, 'f8e7'), [pv(cp(-20), 'f1c4 g8f6 d2d4')]);
    expect(nearBestRecheck({ ...input, after: agrees })).toBeNull();
    expect(classifyMove({ ...input, after: agrees }).nearBest).toBe(true);
  });

  it('better than the best: a mate the own search finds, or a draw from a lost position, is "aboveBest" (no note on the best move)', () => {
    // Black to move, the before search's best is Be7 (+1.50); the search after 28...Bh6 finds mate in 6.
    const S = '2kr1b1r/pp6/3p2p1/4n1N1/2PN1Rn1/2K1P1P1/PP1B2q1/8 b - - 0 28';
    const before = result(S, [pv(cp(150), 'f8e7 f4f8'), pv(cp(120), 'd8e8 d4e6'), pv(cp(60), 'e5c4 d2e1')]);
    const bh6 = result(after(S, 'f8h6'), [pv(mate(-6), 'g5f3 g4e3')]);
    const { classification: c, text } = annotate(S, 'f8h6', before, bh6);
    expect(c).toMatchObject({ nearBest: true, aboveBest: true });
    expect(nearBestRecheck({ fenBefore: S, moveUci: 'f8h6', before, after: bh6 })).toBeNull();
    expect(bestMoveNote(c, 'f8h6')).toBeNull();
    for (const line of text) expect(line).not.toMatch(/Be7|slightly|about as good|Best was/);
    // A third repetition (a draw, which no search sees) from -4.00, the repeating move unlisted.
    const R = '6k1/5ppp/8/8/8/8/q4PPP/1Q4K1 b - - 0 1';
    const lost = result(R, [pv(cp(-400), 'a2a1 g1h2'), pv(cp(-420), 'a2a3 b1b8'), pv(cp(-430), 'a2a4 b1b8')]);
    const kh8 = result(after(R, 'g8h8'), [pv(cp(500), 'b1b8 a2a1')]);
    const draw = classifyMove({ fenBefore: R, moveUci: 'g8h8', before: lost, after: { ...kh8, terminal: 'stalemate' } });
    expect(draw).toMatchObject({ nearBest: true, aboveBest: true });
    expect(nearBestRecheck({ fenBefore: R, moveUci: 'g8h8', before: lost, after: { ...kh8, terminal: 'stalemate' } })).toBeNull();
    expect(bestMoveNote(draw, 'g8h8')).toBeNull();
    // A search that scores the move a little higher than the best line is at least as good too.
    const up = classifyMove({ fenBefore: USER, moveUci: 'f6d5', before: USER_BEFORE, after: result(NXD5, [pv(cp(40), 'e2e4 d5f6')]) });
    expect(up).toMatchObject({ cls: 'excellent', nearBest: true, aboveBest: true });
  });

  it('a listed move: "one of the engine’s top choices"', () => {
    // c5 24 cp behind c6 (Good: 0.022 expected score), listed by the engine.
    const before = result(USER, [pv(cp(-40), 'c7c6 d5c6 b8c6 g1f3'), pv(cp(-64), 'c7c5 e2e4 f6e4 d4c5'), pv(cp(-120), 'e7e5 d4e5 f6g4 g1f3')]);
    const { classification: c, text } = annotate(USER, 'c7c5', before, result(after(USER, 'c7c5'), [pv(cp(70), 'e2e4 f6e4 d4c5 d8a5')]));
    expect(c.cls).toBe('good');
    expect(c.nearBest).toBe(true);
    expect(c.equalBest?.map((m) => m.san)).toEqual(['c6', 'c5']);
    expect(text).toContain('c5 is one of the engine’s top choices, with c6.');
    for (const line of text) expect(line).not.toMatch(/Best was|was better|more accurate/);
  });

  it('a listed move 28 cp behind (one search, NEAR_EQUAL_CP): not about as good', () => {
    const before = result(USER, [pv(cp(-40), 'c7c6 d5c6 b8c6 g1f3'), pv(cp(-68), 'c7c5 e2e4 f6e4 d4c5'), pv(cp(-120), 'e7e5 d4e5 f6g4 g1f3')]);
    const { classification: c, text } = annotate(USER, 'c7c5', before, result(after(USER, 'c7c5'), [pv(cp(70), 'e2e4 f6e4 d4c5 d8a5')]));
    expect(c.cls).toBe('good');
    expect(c.nearBest).toBe(false);
    expect(c.equalBest?.map((m) => m.san)).toEqual(['c6']);
    expect(text.some((l) => /^c6 was (better|slightly more accurate)/.test(l))).toBe(true);
  });

  it('the top move: nearBest true, no sentence about it', () => {
    const { classification: c, text } = annotate(USER, 'c7c6', USER_BEFORE, result(after(USER, 'c7c6'), [pv(cp(57), 'd5c6 b8c6 g1f3 e7e5')]));
    expect(c.cls).toBe('best');
    expect(c.nearBest).toBe(true);
    for (const line of text) expect(line).not.toMatch(/was fine|top choices|Best was/);
  });

  it('an unknown evaluation (unsearched move): no nearBest', () => {
    const c = classifyMove({ fenBefore: USER, moveUci: 'a7a6', before: USER_BEFORE });
    expect(c.nearBest).toBeUndefined();
    expect(c.equalBest).toHaveLength(3);
  });

  it('no engine lines: neither field', () => {
    const c = classifyMove({ fenBefore: USER, moveUci: 'f6d5', before: result(USER, []), after: USER_AFTER });
    expect(c.equalBest).toBeUndefined();
    expect(c.nearBest).toBeUndefined();
  });

  it('mates: a slower mate is not about as good, the same one is', () => {
    // White mates with Qh7# (in 1) or Qg8+ ... (in 2): the slower mate is not "about as good".
    const fen = '6k1/5ppp/8/8/8/8/1Q3PPP/6K1 w - - 0 1';
    const before = result(fen, [pv(mate(1), 'b2b8'), pv(mate(4), 'b2b7 g7g6 b7b8 g8g7'), pv(cp(800), 'g1f1')]);
    const c = classifyMove({ fenBefore: fen, moveUci: 'b2b7', before });
    expect(c.nearBest).toBe(false);
    expect(c.equalBest?.map((m) => m.uci)).toEqual(['b2b8']);
  });

  it('a mate the deeper after search finds against a listed move takes it out of equalBest', () => {
    const before = result(USER, [pv(cp(-57), 'c7c6 d5c6 b8c6 g1f3'), pv(cp(-67), 'd8d5 b1c3 d5a5 c1d2')]);
    const qxd5 = result(after(USER, 'd8d5'), [pv(mate(5), 'b1c3 d5a5 c1d2 a5b6')]);
    const c = classifyMove({ fenBefore: USER, moveUci: 'd8d5', before, after: qxd5 });
    expect(c.nearBest).toBe(false);
    expect(c.equalBest?.map((m) => m.uci)).toEqual(['c7c6']);
  });

  it('book and forced moves: the data is there, the coach says nothing extra', () => {
    const book = classifyMove({ fenBefore: USER, moveUci: 'f6d5', before: USER_BEFORE, after: USER_AFTER, bestAfter: USER_BEST_AFTER, isBook: true });
    expect(book.cls).toBe('book');
    expect(book.nearBest).toBe(true);
    const e = explainMove({ fenBefore: USER, moveUci: 'f6d5', classification: book, before: USER_BEFORE, after: USER_AFTER });
    for (const line of [e.headline, ...e.details]) expect(line).not.toMatch(/was fine|slightly|top choices|Best was|about as good/);
    // The only legal move: one line, no alternatives.
    const forcedFen = '7k/8/6K1/8/8/8/8/R7 b - - 0 1';
    const forced = classifyMove({
      fenBefore: forcedFen,
      moveUci: 'h8g8',
      before: result(forcedFen, [pv(mate(-1), 'h8g8 a1a8')]),
    });
    expect(forced.cls).toBe('forced');
    expect(forced.equalBest?.map((m) => m.uci)).toEqual(['h8g8']);
  });
});

describe('the hint and Show best use the same rule ("c5 is about as good.")', () => {
  const c6 = pv(cp(-57), 'c7c6 d5c6 b8c6 g1f3 e7e5 d4e5');
  const detailWith = (c5: number) =>
    explainBestMove(USER, c6, { lines: [c6, pv(cp(c5), 'c7c5 e2e4 f6e4 d4c5'), pv(cp(-140), 'e7e6 d5e6 c8e6 g1f3')] }).details[0];

  it('a line at most NEAR_EQUAL_CP behind is about as good (24 and 25 cp here, which near equality are 0.02 expected score or more: "more precise" before the rule), one further is not', () => {
    expect(detailWith(-81)).toBe('c5 is about as good.');
    expect(detailWith(-82)).toBe('c5 is about as good.');
    expect(detailWith(-83)).toBe('It is more precise than c5.');
  });

  it('compare: false (Show best for a near-best move) does not rank the move at all', () => {
    const e = explainBestMove(USER, c6, { lines: [c6, pv(cp(-81), 'c7c5 e2e4 f6e4 d4c5')], compare: false });
    expect(e.headline).toBe('c6 holds the position.');
    for (const d of e.details) expect(d).not.toMatch(/about as good|more precise|only/);
    // Even when the lines call it the only good move.
    const only = explainBestMove(USER, c6, { lines: [c6, pv(cp(-190), 'b8d7 e2e4 f6e4 d1a4')], compare: false });
    expect(only.headline).toBe('c6 holds the position.');
    expect(explainBestMove(USER, c6, { lines: [c6, pv(cp(-190), 'b8d7 e2e4 f6e4 d1a4')] }).headline).toMatch(/only move/);
  });
});
