import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { Classification, Explanation } from '../../src/analysis/types';
import {
  answerFreeLines,
  concession,
  mentionsMove,
  namesMove,
  nearBestShowLines,
  recaptureTip,
  repetitionExplanation,
  showBestTitle,
  verdictTitle,
} from '../../src/game/coach';
import type { Ply } from '../../src/game/types';

const cl = (over: Partial<Classification> = {}): Classification => ({
  cls: 'blunder',
  winBefore: 0.9,
  winAfter: 0.3,
  winLoss: 0.6,
  accuracy: 10,
  bestMoveUci: 'd1h5',
  bestMoveSan: 'Qxh5',
  playedMoveSan: 'Nf3',
  ...over,
});

describe('mentionsMove', () => {
  it('matches whole moves only, ignoring check signs', () => {
    expect(mentionsMove('You missed Qxh5, which wins a knight.', 'Qxh5')).toBe(true);
    expect(mentionsMove('Best was Qxf7+.', 'Qxf7+')).toBe(true);
    expect(mentionsMove('Best was Qxf7.', 'Qxf7#')).toBe(true);
    expect(mentionsMove('Black can answer Qxe4.', 'e4')).toBe(false);
    expect(mentionsMove('After e4 the centre is open.', 'e4')).toBe(true);
    expect(mentionsMove('Castling long with O-O-O.', 'O-O')).toBe(false);
    expect(mentionsMove('Nf3 develops.', 'Nf3')).toBe(true);
  });
});

describe('namesMove', () => {
  it('a pawn move written as a square counts only where it names the move, not the square', () => {
    expect(namesMove('This hangs your knight on d4.', 'd4')).toBe(false);
    expect(namesMove('The pawn to d4 is pinned.', 'd4')).toBe(false);
    expect(namesMove('Best was d4.', 'd4')).toBe(true);
    expect(namesMove('You missed d4, which forks the knights.', 'd4+')).toBe(true);
    expect(namesMove('d4 was needed.', 'd4')).toBe(true);
    // Both: the square, then the move.
    expect(namesMove('Your knight on d4 hangs: d4 was better.', 'd4')).toBe(true);
    // Every other move as mentionsMove.
    expect(namesMove('Best was Bb5, which pins the knight on c6.', 'Bb5')).toBe(true);
    expect(namesMove('Black plays exd4 and wins a knight.', 'd4')).toBe(false);
    expect(namesMove('Black plays exd4 and wins a knight.', 'exd4')).toBe(true);
  });
});

describe('answerFreeLines', () => {
  it('drops a missed tactic and its description, with a neutral lead', () => {
    const e: Explanation = {
      headline: 'You missed Qxh5, which wins a knight.',
      details: ['It takes the knight on h5, which was undefended.'],
      motifs: ['missedTactic', 'hanging'],
    };
    expect(answerFreeLines(e, cl())).toEqual(['You missed a chance to win material.']);
  });

  it('keeps what went wrong but not "Best was X"', () => {
    const e: Explanation = {
      headline: 'This hangs your bishop on a6.',
      details: ['Black plays Nxa6 and wins the bishop.', 'Best was Qxh5, which wins a knight.'],
      motifs: ['hanging'],
    };
    expect(answerFreeLines(e, cl())).toEqual(['This hangs your bishop on a6.', 'Black plays Nxa6 and wins the bishop.']);
  });

  it('a missed mate in one says so without the move', () => {
    const e: Explanation = { headline: 'You missed Qh7#, which was checkmate.', details: [], motifs: ['missedMate'] };
    expect(answerFreeLines(e, cl({ bestMoveSan: 'Qh7#', cls: 'miss' }))).toEqual(['You missed a checkmate.']);
  });

  it('an underpromotion does not say what to promote to', () => {
    const e: Explanation = {
      headline: 'e8=N+ promotes to a knight instead of a queen.',
      details: ['Best was e8=Q, which promotes to a queen.'],
      motifs: ['underpromotion'],
    };
    const lines = answerFreeLines(e, cl({ bestMoveSan: 'e8=Q', bestMoveUci: 'e7e8q', playedMoveSan: 'e8=N+' }));
    expect(lines).toEqual(['There was a much better move here.']);
    expect(lines.join(' ')).not.toMatch(/queen/);
  });

  it('never returns nothing', () => {
    expect(answerFreeLines(undefined, cl({ cls: 'mistake' }))).toEqual(['There was a clearly better move here.']);
  });

  it('names none of the moves about as good as the best one either', () => {
    const near = cl({
      cls: 'mistake',
      equalBest: [
        { san: 'Qxh5', uci: 'd1h5' },
        { san: 'Bxh5', uci: 'e2h5' },
      ],
    });
    const e: Explanation = {
      headline: 'This hangs your bishop on a6.',
      details: ['Bxh5 also wins the knight.', 'Best was Qxh5, which wins a knight (Bxh5 was about as good).'],
      motifs: ['hanging'],
    };
    expect(answerFreeLines(e, near)).toEqual(['This hangs your bishop on a6.']);
  });

  it('keeps a line that only names the square of a pawn move about as good as the best (1.e4 e5 2.Nf3 Nc6 3.Nd4??)', () => {
    // Lines Bb5 +0.32, d4 +0.29, Bc4 +0.14: d4 is one of the moves about as good as Bb5.
    const nd4 = cl({
      cls: 'blunder',
      bestMoveUci: 'f1b5',
      bestMoveSan: 'Bb5',
      playedMoveSan: 'Nd4',
      equalBest: [
        { san: 'Bb5', uci: 'f1b5' },
        { san: 'd4', uci: 'd2d4' },
        { san: 'Bc4', uci: 'f1c4' },
      ],
    });
    const e: Explanation = {
      headline: 'This hangs your knight on d4.',
      details: ['Black plays exd4 and wins a knight.', 'Best was Bb5, which develops the bishop.', 'd4 was needed to keep the center.'],
      motifs: ['hanging'],
    };
    // The headline names d4 as a square: it stays. A line naming d4 as a move does not.
    expect(answerFreeLines(e, nd4)).toEqual(['This hangs your knight on d4.', 'Black plays exd4 and wins a knight.']);
  });
});

describe('Show best for a move about as good as the best (near-equal awareness)', () => {
  // 1.d4 d5 2.c4 Nf6 3.cxd5 Nxd5 (Black): c6, c5 and g6 about as good; Nxd5 28 cp behind by its own search.
  const fenBefore = 'rnbqkb1r/ppp1pppp/5n2/3P4/3P4/8/PP2PPPP/RNBQKBNR b KQkq - 0 3';
  const fenAfter = 'rnbqkb1r/ppp1pppp/8/3n4/3P4/8/PP2PPPP/RNBQKBNR w KQkq - 0 4';
  const near = cl({
    cls: 'good',
    winBefore: 0.45,
    winAfter: 0.42,
    winLoss: 0.025,
    bestMoveUci: 'c7c6',
    bestMoveSan: 'c6',
    playedMoveSan: 'Nxd5',
    equalBest: [
      { san: 'c6', uci: 'c7c6', score: { kind: 'cp', value: -57 } },
      { san: 'c5', uci: 'c7c5', score: { kind: 'cp', value: -67 } },
      { san: 'g6', uci: 'g7g6', score: { kind: 'cp', value: -69 } },
    ],
    nearBest: true,
  });
  const ply = (over: Partial<Ply> = {}): Ply => ({
    index: 5,
    color: 'b',
    san: 'Nxd5',
    uci: 'f6d5',
    fenBefore,
    fenAfter,
    evalWhite: { kind: 'cp', value: 85 },
    classification: near,
    ...over,
  });

  it('titles: "Top choices" (or "choice"), "Slightly better: X" for an Excellent or Good move that was not, "Best was X" for the rest', () => {
    expect(showBestTitle(ply(), 'c6')).toBe('Top choices');
    expect(showBestTitle(ply({ classification: { ...near, equalBest: [{ san: 'c6', uci: 'c7c6' }] } }), 'c6')).toBe('Top choice');
    // A Good move that was not about as good: the better move was still only slightly better.
    expect(showBestTitle(ply({ classification: { ...near, nearBest: false } }), 'c6')).toBe('Slightly better: c6');
    expect(showBestTitle(ply({ classification: { ...near, nearBest: false, cls: 'excellent' } }), 'c6')).toBe('Slightly better: c6');
    // A weak move, a Good move whose text says what it gives away, an older save: "Best was".
    expect(showBestTitle(ply({ classification: { ...near, nearBest: false, cls: 'inaccuracy' } }), 'c6')).toBe('Best was c6');
    const concedes = ply({
      classification: { ...near, nearBest: false },
      explanation: { headline: 'This hangs your knight on d5.', details: [], concedes: 'material' },
    });
    expect(showBestTitle(concedes, 'c6')).toBe('Best was c6');
    expect(showBestTitle(ply({ classification: { ...near, nearBest: undefined, equalBest: undefined } }), 'c6')).toBe('Best was c6');
    expect(showBestTitle(null, null)).toBe('Best move');
  });

  it('lines: the top choices with their evaluations (White’s point of view), then the played move from its own side', () => {
    expect(nearBestShowLines(ply(), 'Your')).toEqual(['c6 +0.6 · c5 +0.7 · g6 +0.7', 'Your Nxd5: +0.9, close behind.']);
    expect(nearBestShowLines(ply(), 'Pip’s')[1]).toBe('Pip’s Nxd5: +0.9, close behind.');
    expect(nearBestShowLines(ply({ evalWhite: undefined }), 'Your')[1]).toBe('Your Nxd5 is close behind.');
    // Scored at least as well as the best (here +0.4 against c6’s +0.6 for White): no "behind".
    const above = ply({ evalWhite: { kind: 'cp', value: 40 }, classification: { ...near, cls: 'excellent', aboveBest: true } });
    expect(nearBestShowLines(above, 'Your')).toEqual(['c6 +0.6 · c5 +0.7 · g6 +0.7', 'Your Nxd5: +0.4, at least as good.']);
    // A listed move is "one of them"; a move without scores still lists the names.
    const c5 = ply({ san: 'c5', uci: 'c7c5', classification: { ...near, playedMoveSan: 'c5' } });
    expect(nearBestShowLines(c5, 'Your')).toEqual(['c6 +0.6 · c5 +0.7 · g6 +0.7', 'Your c5 is one of them.']);
    const bare = ply({ classification: { ...near, equalBest: [{ san: 'c6', uci: 'c7c6' }, { san: 'c5', uci: 'c7c5' }] } });
    expect(nearBestShowLines(bare, 'Your')[0]).toBe('c6 · c5');
    // Not near-best: nothing (the usual "Best was" Show best).
    expect(nearBestShowLines(ply({ classification: { ...near, nearBest: false } }), 'Your')).toEqual([]);
    expect(nearBestShowLines(ply({ uci: 'c7c6', san: 'c6' }), 'Your')).toEqual([]);
  });
});

describe('repetitionExplanation', () => {
  it('explains a draw that threw away a win', () => {
    const e = repetitionExplanation('Ng5', cl({ bestMoveSan: 'd4' }), { human: true, botName: 'Pip' });
    expect(e.headline).toBe('Ng5 repeats the position for the third time, so the game is a draw.');
    expect(e.details).toEqual(['You were winning: when you are ahead, avoid repeating the position.', 'Best was d4.']);
  });
  it('names the moves that were about as good as the best one', () => {
    const near = cl({ bestMoveSan: 'd4', bestMoveUci: 'd2d4', equalBest: [{ san: 'd4', uci: 'd2d4' }, { san: 'Ng5', uci: 'f3g5' }, { san: 'c4', uci: 'c2c4' }] });
    // The played move (Ng5 repeats) is never "about as good" here.
    expect(repetitionExplanation('Ng5', near, { human: true, botName: 'Pip' }).details[1]).toBe('Best was d4 (c4 was about as good).');
    const two = cl({ bestMoveSan: 'd4', bestMoveUci: 'd2d4', equalBest: [{ san: 'd4', uci: 'd2d4' }, { san: 'c4', uci: 'c2c4' }, { san: 'e4', uci: 'e2e4' }] });
    expect(repetitionExplanation('Ng5', two, { human: true, botName: 'Pip' }).details[1]).toBe('Best was d4 (c4 and e4 were about as good).');
  });
  it('and one that saved a lost game', () => {
    const e = repetitionExplanation('Kh1', cl({ winBefore: 0.1, cls: 'best' }), { human: false, botName: 'Pip' });
    expect(e.details).toEqual(['Pip was losing, so a draw is a good result for it.']);
  });
});

describe('verdictTitle / concession', () => {
  // 10… Kd8 leaves the queen on b4 en prise; in a lost position the class is still Excellent.
  const base = {
    fenBefore: '1nb1kbnr/1p4pp/1rp1Pp2/p7/1q1P4/P1NB1N2/1PP2PPP/R1BQR1K1 b k - 0 10',
    san: 'Kd8',
    color: 'b' as const,
    index: 19,
  };
  const ply = (over: Partial<Classification>, concedes?: Explanation['concedes'] | 'queen') => ({
    ...base,
    classification: cl({ cls: 'excellent', winBefore: 0.02, winAfter: 0.003, winLoss: 0.017, playedMoveSan: 'Kd8', ...over }),
    explanation: {
      headline: 'This does nothing about the threat to your queen on b4.',
      details: [],
      ...(concedes ? { concedes: concedes as Explanation['concedes'] } : {}),
    },
  });

  it('the class verdict and icon when the text does not contradict it', () => {
    expect(verdictTitle(ply({}))).toEqual({ title: '10… Kd8 is excellent', cls: 'excellent' });
    expect(verdictTitle(ply({ cls: 'blunder' }))).toEqual({ title: '10… Kd8 is a blunder', cls: 'blunder' });
    expect(verdictTitle({ ...base })).toEqual({ title: '10… Kd8' });
    expect(concession(ply({}))).toBeNull();
  });

  it('a neutral verdict and no icon for a praised move that gives something away', () => {
    expect(verdictTitle(ply({}, 'material'))).toEqual({ title: '10… Kd8 doesn’t change the result' });
    expect(verdictTitle(ply({ cls: 'good' }, 'mate'))).toEqual({ title: '10… Kd8 doesn’t change the result' });
    expect(verdictTitle(ply({ winBefore: 0.97, winAfter: 0.9, winLoss: 0.07 }, 'material'))).toEqual({
      title: '10… Kd8 still wins, but gives up material',
    });
    expect(verdictTitle(ply({ winBefore: 0.8, winAfter: 0.7, winLoss: 0.1 }, 'material'))).toEqual({
      title: '10… Kd8 gives up material',
    });
    expect(concession(ply({}, 'material'))).toBe('material');
    expect(concession(ply({ cls: 'good' }, 'mate'))).toBe('mate');
  });

  it('ignores the flag on a class that already says the move was weak, or an unknown value', () => {
    for (const cls of ['inaccuracy', 'mistake', 'miss', 'blunder'] as const) {
      expect(concession(ply({ cls }, 'material'))).toBeNull();
      expect(verdictTitle(ply({ cls }, 'material')).cls).toBe(cls);
    }
    expect(concession(ply({}, 'queen'))).toBeNull();
    expect(concession({ explanation: { headline: 'x', details: [], concedes: 'material' } })).toBeNull();
  });
});

describe('recaptureTip', () => {
  /** The position after `sans` and the last move as a ply. */
  function after(sans: string[], fen?: string) {
    const c = new Chess(fen);
    let last = null;
    for (const san of sans) {
      const m = c.move(san);
      last = { uci: m.lan, color: m.color, ...(m.captured ? { captured: m.captured } : {}) };
    }
    return { fen: c.fen(), last };
  }

  it('asks for the recapture after the opponent takes a piece that can be taken back', () => {
    // Game C of the acceptance test: the Slav, 8… Bxc1 (White can take back with the queen or the rook).
    const { fen, last } = after('d4 d5 c4 c6 e3 Nd7 Nf3 Ngf6 Bd3 g6 Nc3 dxc4 Bxc4 Bh6 e4 Bxc1'.split(' '));
    expect(recaptureTip(fen, last, 'Robot')).toBe('Robot just took your bishop on c1. Can you recapture?');
    // Nothing attacks the capturing queen on d5: no prompt.
    const t = after('e4 d5 exd5 Qxd5'.split(' '));
    expect(t.last).toMatchObject({ captured: 'p' });
    expect(recaptureTip(t.fen, t.last, 'Pip')).toBeNull();
    // Taking back a pawn with the knight holds its own.
    const p = after('e4 d5 Nc3 dxe4'.split(' '));
    expect(recaptureTip(p.fen, p.last, 'Pip')).toBe('Pip just took your pawn on e4. Can you recapture?');
  });

  it('says nothing when every recapture loses material, or when the last move was no capture', () => {
    // 5… exd5 took the knight on d5, but c6 guards it and only the queen can take back.
    const fen = 'rnbqkbnr/pp1p1ppp/2p5/3p4/8/8/PPP2PPP/RNBQKB1R w KQkq - 0 5';
    expect(recaptureTip(fen, { uci: 'e6d5', color: 'b', captured: 'n' }, 'Pip')).toBeNull();
    const quiet = after(['e4', 'e5']);
    expect(recaptureTip(quiet.fen, quiet.last, 'Pip')).toBeNull();
    expect(recaptureTip(quiet.fen, undefined, 'Pip')).toBeNull();
    // The move must be the other side's: after 3.exd5, White (not to move) has nothing to take back.
    const own = after('e4 d5 exd5'.split(' '));
    expect(recaptureTip(own.fen, { ...own.last!, color: 'b' }, 'Pip')).toBeNull();
  });
});
