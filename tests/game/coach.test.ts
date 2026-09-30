import { describe, expect, it } from 'vitest';
import type { Classification, Explanation } from '../../src/analysis/types';
import { answerFreeLines, mentionsMove, repetitionExplanation } from '../../src/game/coach';

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
