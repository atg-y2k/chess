import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { Classification, Explanation } from '../../src/analysis/types';
import { answerFreeLines, concession, mentionsMove, recaptureTip, repetitionExplanation, verdictTitle } from '../../src/game/coach';

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
});

describe('repetitionExplanation', () => {
  it('explains a draw that threw away a win', () => {
    const e = repetitionExplanation('Ng5', cl({ bestMoveSan: 'd4' }), { human: true, botName: 'Pip' });
    expect(e.headline).toBe('Ng5 repeats the position for the third time, so the game is a draw.');
    expect(e.details).toEqual(['You were winning: when you are ahead, avoid repeating the position.', 'Best was d4.']);
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
