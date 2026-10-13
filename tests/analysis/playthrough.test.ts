/**
 * Coaching text from the play-through review (October 2026), with the engine lines the app saw:
 * the best move never "beaten by itself", a king walk in the opening not praised, a check escape
 * not credited with material won later, draws by rule said as such, and engine lines cut where the
 * game would end by repetition.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { classifyMove, classifyMoveDetailed } from '../../src/analysis/classify';
import { cutAtRepetition, explainBestMove, explainMove } from '../../src/analysis/explain';
import { repetitionReplies, seenPositions } from '../../src/chess/utils';
import { principles } from '../../src/analysis/motifs';
import type { AnalysisResult, PvLine, Score } from '../../src/engine/types';
import { nearBestShowLines, showBestTitle } from '../../src/game/coach';

const L = (multipv: number, score: Score, pv: string[], depth = 18): PvLine => ({ multipv, depth, score, pv });
const R = (fen: string, lines: PvLine[]): AnalysisResult => ({ fen, depth: 18, lines, bestMove: lines[0]?.pv[0] ?? null, done: true });
const cp = (value: number): Score => ({ kind: 'cp', value });
const mate = (value: number): Score => ({ kind: 'mate', value });
const after = (fen: string, uci: string) => {
  const c = new Chess(fen);
  c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return c.fen();
};

describe('Show best for a near-best move', () => {
  it('never says "at least as good" when the numbers it shows say worse (50… c4)', () => {
    const fen = 'R7/4k3/8/2p3p1/pr2p3/6PP/B2P1P2/3K4 b - - 7 50';
    const fenAfter = after(fen, 'c5c4');
    const before = R(fen, [L(1, cp(-520), ['e7d6', 'h3h4']), L(2, cp(-560), ['e7d7', 'a8a6']), L(3, cp(-570), ['e7f6', 'a8a6'])]);
    const res = R(fenAfter, [L(1, cp(573), ['a8a6', 'e7f8'])]);
    const bestAfter = R(after(fen, 'e7d6'), [L(1, cp(580), ['h3h4'])]);
    const cl = classifyMoveDetailed({ fenBefore: fen, moveUci: 'c5c4', before, after: res, bestAfter }).classification;
    expect(cl.aboveBest).toBe(true); // the second opinion (its own search vs bestAfter's)...
    const ply = { fenBefore: fen, fenAfter, uci: 'c5c4', san: 'c4', evalWhite: cp(573), classification: cl };
    expect(showBestTitle(ply, cl.bestMoveSan)).toBe('Top choices');
    const lines = nearBestShowLines(ply, 'Your');
    expect(lines[0]).toBe('Kd6 +5.2 · Kd7 +5.6 · Kf6 +5.7');
    // ...but the numbers on screen put c4 behind Kd6: the words follow the numbers.
    expect(lines[1]).toBe('Your c4: +5.7, close behind.');
    // When the shown numbers agree, it still says so.
    const better = { ...ply, evalWhite: cp(500) };
    expect(nearBestShowLines(better, 'Your')[1]).toBe('Your c4: +5.0, at least as good.');
  });
});

describe('mate distances', () => {
  it('the best move is never told another move was quicker (27. Qxa5, M4 then M-4)', () => {
    const fen = '8/p3k3/2pp2P1/n6p/Q1PB4/5P2/P4P1P/5RK1 w - - 0 27';
    const fenAfter = after(fen, 'a4a5');
    const before = R(fen, [
      L(1, mate(4), ['a4a5', 'e7e8', 'a5c7', 'c6c5', 'c7d6', 'c5d4', 'f1e1']),
      L(2, mate(5), ['f1e1', 'e7d7', 'a4a5']),
      L(3, mate(5), ['g6g7', 'a7a6']),
    ]);
    const res = R(fenAfter, [L(1, mate(-4), ['e7e8', 'a5c7', 'c6c5', 'c7d6', 'c5d4', 'f1e1'])]);
    const cl = classifyMove({ fenBefore: fen, moveUci: 'a4a5', before, after: res });
    expect(cl.cls).toBe('best');
    const ex = explainMove({ fenBefore: fen, moveUci: 'a4a5', classification: cl, before, after: res, prevMove: { to: 'a5', captured: 'p' } });
    expect(ex.headline).toMatch(/^Qxa5 leads to a forced mate in 4\./);
    expect(ex.details.join(' ')).not.toMatch(/quicker/);
  });

  it('a slower mate is still told about the quicker one', () => {
    const fen = '8/p3k3/2pp2P1/n6p/Q1PB4/5P2/P4P1P/5RK1 w - - 0 27';
    const before = R(fen, [L(1, mate(4), ['a4a5', 'e7e8']), L(2, mate(6), ['f1e1', 'e7d7'])]);
    const res = R(after(fen, 'f1e1'), [L(1, mate(-6), ['e7d7', 'a4a5'])]);
    const cl = classifyMove({ fenBefore: fen, moveUci: 'f1e1', before, after: res });
    const ex = explainMove({ fenBefore: fen, moveUci: 'f1e1', classification: cl, before, after: res });
    expect(ex.details).toContain('Qxa5 was even quicker: mate in 4.');
  });
});

describe('the king in the opening', () => {
  const fen = 'rnbqkbnr/1pppp2p/6p1/p7/5P2/7p/PPPPPK1P/RNBQ2NR w kq - 0 6';

  it('6. Ke3 does not "fight for the center": it walks the king out', () => {
    const ps = principles(fen, 'f2e3');
    expect(ps.some((p) => p.kind === 'centreControl')).toBe(false);
    expect(ps).toContainEqual(expect.objectContaining({ kind: 'kingExposed', good: false }));
    // Castling into safety and kings in the endgame are unchanged.
    expect(principles('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1d2').map((p) => p.kind)).toContain('kingWalk');
    expect(principles('8/8/4k3/8/8/8/4K3/8 w - - 0 40', 'e2e3').map((p) => p.kind)).toContain('kingActive');
  });

  it('its explanation is not praise', () => {
    const before = R(fen, [L(1, cp(-950), ['g1f3', 'd7d5']), L(2, cp(-980), ['d2d4', 'd7d5']), L(3, cp(-990), ['f2e3', 'd7d5'])]);
    const res = R(after(fen, 'f2e3'), [L(1, cp(990), ['d7d5', 'g1f3'])]);
    const cl = classifyMove({ fenBefore: fen, moveUci: 'f2e3', before, after: res });
    const ex = explainMove({ fenBefore: fen, moveUci: 'f2e3', classification: cl, before, after: res });
    expect(ex.headline).not.toMatch(/fights for the center/);
    expect(ex.headline).toMatch(/king/);
    expect(ex.headline).toMatch(/attacked/);
  });
});

describe('getting out of check', () => {
  it('12. Kf1 gets out of check; the queen wins the material later', () => {
    const fen = 'r4knr/pp1Q1ppp/4p3/4q3/7P/8/PPP2PP1/RNB1K2R w KQ - 1 12';
    const before = R(fen, [L(1, cp(620), ['e1f1', 'g7g6', 'd7b7', 'f8g7', 'b7a8', 'g8f6']), L(2, cp(-200), ['c1e3', 'e5e3'])]);
    const res = R(after(fen, 'e1f1'), [L(1, cp(-620), ['g7g6', 'd7b7', 'f8g7', 'b7a8', 'g8f6'])]);
    const cl = classifyMove({ fenBefore: fen, moveUci: 'e1f1', before, after: res });
    const ex = explainMove({ fenBefore: fen, moveUci: 'e1f1', classification: cl, before, after: res });
    expect(ex.headline).not.toMatch(/^Kf1 wins/);
    expect(ex.headline).toMatch(/^Kf1 gets the king out of check, and then Qxb7 and Qxa8 win a rook and a pawn\./);
  });

  it('27. Ke1 too', () => {
    const fen = '5k1r/p4p1p/1p5R/5PP1/2q1p1Q1/2N5/PPP1K1P1/R7 w - - 7 27';
    const line = ['e2e1', 'f8e7', 'g4e4', 'c4e4', 'c3e4', 'h8d8'];
    const before = R(fen, [L(1, cp(300), line)]);
    const res = R(after(fen, 'e2e1'), [L(1, cp(-300), line.slice(1))]);
    const cl = classifyMove({ fenBefore: fen, moveUci: 'e2e1', before, after: res });
    const ex = explainMove({ fenBefore: fen, moveUci: 'e2e1', classification: cl, before, after: res });
    expect(ex.headline).not.toMatch(/^Ke1 wins/);
    expect(ex.headline).toMatch(/^Ke1 gets the king out of check/);
  });
});

describe('draws by rule', () => {
  it('the move that ends the game by the 50-move rule says so', () => {
    const fen = '4k3/8/8/8/8/8/8/R3K3 w - - 99 80';
    const before = R(fen, [L(1, cp(0), ['a1a7']), L(2, cp(0), ['a1a8'])]);
    const res = R(after(fen, 'a1a7'), [L(1, cp(0), ['e8d8'])]);
    const cl = classifyMove({ fenBefore: fen, moveUci: 'a1a7', before, after: res });
    const ex = explainMove({ fenBefore: fen, moveUci: 'a1a7', classification: cl, before, after: res });
    expect(ex.headline).toBe('Ra7 makes it 50 moves by each side without a capture or a pawn move, so the game is a draw (the 50-move rule).');
    expect(ex.title).toBe('Draw');
  });

  it('...and the one that leaves too little material', () => {
    const fen = '4k3/8/8/8/3p4/5N2/8/4K3 w - - 0 1';
    const before = R(fen, [L(1, cp(0), ['f3d4'])]);
    const res = R(after(fen, 'f3d4'), [L(1, cp(0), ['e8d7'])]);
    const cl = classifyMove({ fenBefore: fen, moveUci: 'f3d4', before, after: res });
    const ex = explainMove({ fenBefore: fen, moveUci: 'f3d4', classification: cl, before, after: res });
    expect(ex.headline).toBe('Nxd4 leaves too little material for either side to checkmate, so the game is a draw.');
  });
});

describe('engine lines and threefold repetition', () => {
  // 1.Qc8+ Ke7 2.Qd7+ Kf8: the start position again (twice so far).
  const start = 'rb3k2/p1pQ2pp/P1P3PP/6K1/8/8/8/8 w - - 0 1';
  const game = ['d7c8', 'f8e7', 'c8d7', 'e7f8'];
  const plies: { fenAfter: string }[] = [];
  let fen = start;
  for (const uci of game) {
    fen = after(fen, uci);
    plies.push({ fenAfter: fen });
  }
  const seen = seenPositions(start, plies);

  it('cuts a line at the move that repeats a position for the third time', () => {
    const line = L(1, mate(2), ['d7c8', 'f8e7', 'c8d7', 'e7f8', 'd7f7']);
    const cut = cutAtRepetition(fen, line, seen);
    expect(cut.cut).toBe(true);
    expect(cut.pv).toEqual(['d7c8', 'f8e7', 'c8d7', 'e7f8']);
    expect(cut.score).toEqual(cp(0));
    // A line that never repeats is left alone.
    const mateNow = L(1, mate(1), ['d7f7']);
    expect(cutAtRepetition(fen, mateNow, seen)).toBe(mateNow);
  });

  it('3. Qc8+ is not explained with a mate that runs through the third repetition', () => {
    const before = R(fen, [L(1, mate(1), ['d7f7']), L(2, mate(2), ['d7c8', 'f8e7', 'c8d7', 'e7f8', 'd7f7'])]);
    const fenAfter = after(fen, 'd7c8');
    const res = R(fenAfter, [L(1, mate(-2), ['f8e7', 'c8d7', 'e7f8', 'd7f7'])]);
    const cl = classifyMove({ fenBefore: fen, moveUci: 'd7c8', before, after: res });
    const ex = explainMove({ fenBefore: fen, moveUci: 'd7c8', classification: cl, before, after: res, seen });
    const text = [ex.headline, ...ex.details].join(' ');
    expect(text).not.toMatch(/forced mate in 2|The finish/);
    // The hint or Show best for the position: no "finish" through the repetition either.
    const hint = explainBestMove(fen, before.lines[1], { lines: before.lines, seen });
    expect([hint.headline, ...hint.details].join(' ')).not.toMatch(/Qf7#/);
  });
});

describe('a listed move whose own search disagrees with its line', () => {
  // 51…Qb1+ (the engine's best is Qb7+): 2.1 in the MultiPV list, 4.9 by its own search.
  const fen = '5k2/p4p2/8/5P2/4K1P1/2P1Q1R1/1q6/5r2 b - - 3 51';
  const before = R(fen, [L(1, cp(522), ['b2b7', 'e4d4']), L(2, cp(209), ['b2b1', 'e4d4']), L(3, cp(22), ['f1h1', 'e3c5'])]);
  const res = R(after(fen, 'b2b1'), [L(1, cp(-491), ['e4d4', 'b1b6'])]);

  it('is judged by its own search, not rated a mistake the eval graph contradicts', () => {
    const d = classifyMoveDetailed({ fenBefore: fen, moveUci: 'b2b1', before, after: res });
    expect(['mistake', 'blunder', 'inaccuracy']).not.toContain(d.classification.cls);
    expect(d.classification.winLoss).toBeLessThan(0.05);
    // ...and asks for the best move searched the same way.
    expect(d.recheckFen).toBe(after(fen, 'b2b7'));
    const bestAfter = R(after(fen, 'b2b7'), [L(1, cp(-610), ['e4d4'])]);
    const like = classifyMoveDetailed({ fenBefore: fen, moveUci: 'b2b1', before, after: res, bestAfter });
    expect(['excellent', 'good']).toContain(like.classification.cls);
    expect(like.recheckFen).toBeNull();
  });

  it('a listed move whose own search agrees keeps its line score', () => {
    const agree = R(after(fen, 'b2b1'), [L(1, cp(-230), ['e4d4'])]);
    const d = classifyMoveDetailed({ fenBefore: fen, moveUci: 'b2b1', before, after: agree });
    expect(['mistake', 'blunder']).toContain(d.classification.cls);
  });
});

describe('repetitionReplies', () => {
  it('lists the replies that would repeat a position for the third time', () => {
    const start = 'rb3k2/p1pQ2pp/P1P3PP/6K1/8/8/8/8 w - - 0 1';
    const moves = ['d7c8', 'f8e7', 'c8d7', 'e7f8', 'd7c8', 'f8e7'];
    const plies: { fenAfter: string }[] = [];
    let f = start;
    for (const uci of moves) {
      f = after(f, uci);
      plies.push({ fenAfter: f });
    }
    const qd7 = after(f, 'c8d7');
    const seen = seenPositions(start, [...plies, { fenAfter: qd7 }]);
    expect(repetitionReplies(qd7, seen)).toEqual(['e7f8']);
    expect(repetitionReplies(f, seenPositions(start, plies))).toEqual([]);
  });
});

describe('captured pieces from the board', () => {
  it('a promotion is not a capture by the other side', async () => {
    const { capturedPieces, capturedByMoves } = await import('../../src/chess/utils');
    expect(capturedPieces('rnbqkQ2/pppppp1p/8/8/8/8/PPPPPPP1/RNBQKBNR b KQq - 0 5')).toEqual({ w: ['r', 'b', 'n', 'p'], b: [] });
    expect(capturedByMoves([{ color: 'w', captured: 'p' }, { color: 'b' }, { color: 'b', captured: 'q' }, { color: 'w', captured: 'r' }])).toEqual({
      w: ['r', 'p'],
      b: ['q'],
    });
  });
});

describe('Game Review key moments', () => {
  it('number the moves from the position (any start), say whose they are, and keep yours first', async () => {
    const { summarizeGame } = await import('../../src/game/review');
    const start = 'rbQ2k2/p1p3pp/P1P3PP/6K1/8/8/8/8 b - - 1 1';
    const moves = ['f8e7', 'c8d7', 'e7f8', 'd7c8'];
    let f = start;
    const plies = moves.map((uci, index) => {
      const fenBefore = f;
      const c = new Chess(f);
      const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
      f = c.fen();
      return {
        index,
        color: mv.color,
        san: mv.san,
        uci,
        fenBefore,
        fenAfter: f,
        evalWhite: cp(0),
        classification: { cls: 'blunder' as const, winBefore: 0.9, winAfter: 0.5, winLoss: 0.4, accuracy: 10, bestMoveUci: null, bestMoveSan: null, playedMoveSan: mv.san },
      };
    });
    const s = summarizeGame(start, null, plies, 'w');
    expect(s.keyMoments.map((m) => `${m.label} ${m.san} ${m.color}`)).toEqual(['1… Ke7 b', '2. Qd7+ w', '2… Kf8 b', '3. Qc8+ w']);
    expect(summarizeGame('8/8/8/8/8/8/8/K6k w - - 0 80', null, [], 'w').keyMoments).toEqual([]);
    // More than fit: yours first.
    const many = Array.from({ length: 20 }, (_, i) => ({ ...plies[i % 4], index: i }));
    const kept = summarizeGame(start, null, many, 'w').keyMoments;
    expect(kept).toHaveLength(12);
    expect(kept.filter((m) => m.color === 'w')).toHaveLength(10);
  });
});
