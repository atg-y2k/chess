/**
 * Try again (src/game/practice.ts), the pure part: which of a game's moves can be tried again, one
 * try's transitions (a move, the move made in the game, the engine's verdict, a failed check, hints,
 * the answer), what counts as a better move, and the wording.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { Classification, Explanation, MoveClass } from '../../src/analysis/types';
import { personaById } from '../../src/bot/personas';
import {
  FOUND_BEST_LINE,
  FOUND_NEAR_LINE,
  SAME_MOVE_LINE,
  answerMove,
  attemptFailed,
  awaitsMove,
  canTryAgain,
  hintText,
  isSettled,
  isSolution,
  judgeAttempt,
  lastMomentLine,
  moreHint,
  nextMoment,
  playAttempt,
  playedLine,
  practiceFen,
  practiceMoments,
  practiceTitle,
  revealAnswer,
  solvedLine,
  startPractice,
  triedLine,
  withAnswer,
  type PracticeGame,
  type PracticeRating,
} from '../../src/game/practice';
import type { Color, Ply } from '../../src/game/types';

const cl = (cls: MoveClass, over: Partial<Classification> = {}): Classification => ({
  cls,
  winBefore: 0.5,
  winAfter: 0.5,
  winLoss: 0,
  accuracy: 100,
  bestMoveUci: 'g1f3',
  bestMoveSan: 'Nf3',
  playedMoveSan: '',
  ...over,
});

/** A game from the start position with these moves, each with its class (undefined: none). */
function gameOf(moves: string[], classes: (MoveClass | undefined)[], o: { playerColor?: Color; preplayed?: number } = {}): PracticeGame {
  const chess = new Chess();
  const plies: Ply[] = moves.map((san, index) => {
    const mv = chess.move(san);
    const p: Ply = { index, color: mv.color, san: mv.san, uci: mv.from + mv.to + (mv.promotion ?? ''), fenBefore: mv.before, fenAfter: mv.after };
    const c = classes[index];
    if (c) {
      p.classification = cl(c, { playedMoveSan: mv.san });
      p.explanation = { headline: `${mv.san} explained.`, details: [] };
    }
    return p;
  });
  return {
    id: 'g1',
    startFen: plies[0]?.fenBefore ?? new Chess().fen(),
    playerColor: o.playerColor ?? 'w',
    bot: personaById('pip')!,
    botElo: 100,
    plies,
    ...(o.preplayed ? { preplayed: o.preplayed } : {}),
    source: 'archive',
  };
}

const rating = (c: Classification, e: Partial<Explanation> = {}): PracticeRating => ({
  classification: c,
  explanation: { headline: 'Why.', details: [], ...e },
  evalWhite: { kind: 'cp', value: 20 },
  evalDepth: 14,
});

// 1. e4 e5 2. Qh5 Nc6 3. Qxf7+?? Kxf7 4. d4 (the player's second weak move, a mistake) d5 5. Nc3?! (an inaccuracy)
const MOVES = ['e4', 'e5', 'Qh5', 'Nc6', 'Qxf7+', 'Kxf7', 'd4', 'd5', 'Nc3'];
const CLASSES: (MoveClass | undefined)[] = ['book', 'book', 'inaccuracy', 'mistake', 'blunder', 'best', 'mistake', 'best', 'good'];

describe('Try again: the moves to try', () => {
  it('the player’s key moments that were an inaccuracy or worse, in game order (never the opponent’s)', () => {
    const g = gameOf(MOVES, CLASSES);
    // Key moments: 2… Nc6 (the opponent's mistake), 3. Qxf7+ and 4. d4; with three there, no inaccuracy is listed.
    expect(practiceMoments(g)).toEqual([4, 6]);
    expect(canTryAgain(g, 4)).toBe(true);
    expect(canTryAgain(g, 3)).toBe(false); // the opponent's
    expect(canTryAgain(g, 2)).toBe(false); // an inaccuracy, not among the key moments here
    expect(nextMoment(g, 4)).toBe(6);
    expect(nextMoment(g, 6)).toBeNull();
    expect(nextMoment(g, 0)).toBe(4);
  });

  it('inaccuracies count when Game Review lists them (fewer than three key moments)', () => {
    const g = gameOf(MOVES, ['book', 'book', 'inaccuracy', 'best', 'blunder', 'best', 'good', 'best', 'excellent']);
    expect(practiceMoments(g)).toEqual([2, 4]);
    expect(lastMomentLine(g)).toBe('That was your last mistake in this game.');
    expect(lastMomentLine(gameOf(MOVES.slice(0, 5), ['book', 'book', 'best', 'best', 'blunder']))).toBe('That was your only mistake in this game.');
  });

  it('as Black, and never the moves the game started with (opening practice)', () => {
    const black = gameOf(MOVES, ['book', 'blunder', 'best', 'mistake', 'best', 'best', 'best', 'best', 'best'], { playerColor: 'b' });
    expect(practiceMoments(black)).toEqual([1, 3]);
    const pre = gameOf(MOVES, ['book', 'blunder', 'best', 'mistake', 'best', 'best', 'best', 'best', 'best'], { playerColor: 'b', preplayed: 2 });
    expect(practiceMoments(pre)).toEqual([3]);
    expect(practiceMoments(gameOf([], []))).toEqual([]);
  });
});

describe('Try again: one try', () => {
  const g = gameOf(MOVES, CLASSES);
  const ply = g.plies[4]; // 3. Qxf7+??

  it('starts on the position before the move, the player to move', () => {
    const p = startPractice(g, 4, 1);
    expect(p).toMatchObject({ index: 4, status: 'waiting', attempt: null, tried: null, tries: 0, hint: 0, failed: false, session: 1 });
    expect(p.answer).toBeUndefined();
    expect(practiceFen(p)).toBe(ply.fenBefore);
    expect(awaitsMove(p)).toBe(true);
    expect(isSettled(p)).toBe(false);
  });

  it('a move is checked on the board; an illegal one is refused; a pawn to the last rank becomes a queen', () => {
    const p = startPractice(g, 4, 1);
    expect(playAttempt(p, 'h5', 'h1')).toBeNull();
    const a = playAttempt(p, 'g1', 'f3')!;
    expect(a.status).toBe('checking');
    expect(a.attempt).toMatchObject({ uci: 'g1f3', san: 'Nf3', color: 'w', fenBefore: ply.fenBefore });
    expect(practiceFen(a)).toBe(a.attempt!.fenAfter);
    expect(awaitsMove(a)).toBe(false);
    expect(playAttempt(a, 'f1', 'c4')).toBeNull(); // one at a time
    const promo = startPractice(
      { ...g, plies: [{ ...ply, fenBefore: '8/P6k/8/8/8/8/8/K7 w - - 0 1', uci: 'a1b1', san: 'Kb1' }] },
      0,
      1,
    );
    expect(playAttempt(promo, 'a7', 'a8')!.attempt).toMatchObject({ uci: 'a7a8q', san: 'a8=Q' });
    expect(playAttempt(promo, 'a7', 'a8', 'n')!.attempt).toMatchObject({ uci: 'a7a8n', san: 'a8=N' });
  });

  it('the move made in the game is "not quite" at once, without the engine', () => {
    const p = playAttempt(startPractice(g, 4, 1), 'h5', 'f7')!;
    expect(p).toMatchObject({ status: 'wrong', attempt: null, tries: 1, tried: { uci: 'h5f7', same: true } });
    expect(practiceFen(p)).toBe(ply.fenBefore);
    expect(triedLine(p.tried!)).toBe(SAME_MOVE_LINE);
    expect(awaitsMove(p)).toBe(true);
  });

  it('the verdict: a better move ends the try; any other is taken back and counted', () => {
    const checking = playAttempt(startPractice(g, 4, 1), 'g1', 'f3')!;
    const solved = judgeAttempt(checking, rating(cl('best', { bestMoveUci: 'g1f3' })));
    expect(solved).toMatchObject({ status: 'solved', attempt: { uci: 'g1f3', rating: { classification: { cls: 'best' } } }, tries: 0 });
    expect(isSettled(solved)).toBe(true);
    const wrong = judgeAttempt(checking, rating(cl('blunder', { bestMoveUci: 'f1c4', bestMoveSan: 'Bc4' })));
    expect(wrong).toMatchObject({ status: 'wrong', attempt: null, tries: 1, tried: { uci: 'g1f3' } });
    expect(practiceFen(wrong)).toBe(ply.fenBefore);
    expect(triedLine(wrong.tried!)).toBe('Nf3 is a blunder.');
    // Only the attempt being checked gets a verdict.
    expect(judgeAttempt(wrong, rating(cl('best')))).toBe(wrong);
  });

  it('a check that fails takes the move back, to be tried again', () => {
    const failed = attemptFailed(playAttempt(startPractice(g, 4, 1), 'g1', 'f3')!);
    expect(failed).toMatchObject({ status: 'waiting', attempt: null, tried: null, failed: true, tries: 0 });
    expect(attemptFailed(failed)).toBe(failed);
    // The next move clears the flag.
    expect(playAttempt(failed, 'g1', 'f3')!.failed).toBe(false);
  });

  it('hints: the piece, then its square (two at most); the answer ends the try', () => {
    let p = startPractice(g, 4, 1);
    p = moreHint(p);
    expect(p.hint).toBe(1);
    p = moreHint(moreHint(p));
    expect(p.hint).toBe(2);
    const checking = playAttempt(startPractice(g, 4, 1), 'g1', 'f3')!;
    expect(moreHint(checking)).toBe(checking); // not while a move is checked
    const revealed = revealAnswer(p);
    expect(revealed).toMatchObject({ status: 'revealed', attempt: null });
    expect(revealAnswer(revealed)).toBe(revealed);
    expect(moreHint(revealed)).toBe(revealed);
    expect(playAttempt(revealed, 'g1', 'f3')).toBeNull();
    expect(withAnswer(p, { uci: 'g1f3', san: 'Nf3', lines: [] }).answer).toEqual({ uci: 'g1f3', san: 'Nf3', lines: [] });
    expect(withAnswer(p, null).answer).toBeNull();
  });
});

describe('Try again: what counts as better', () => {
  const played = 'h5f7';
  it('the best move, a move about as good, or a good one that gives nothing away; never the game’s move', () => {
    expect(isSolution(rating(cl('excellent', { bestMoveUci: 'g1f3' })), 'g1f3', played)).toBe(true);
    expect(isSolution(rating(cl('inaccuracy', { nearBest: true })), 'b1c3', played)).toBe(true);
    for (const c of ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'forced'] as MoveClass[]) {
      expect(isSolution(rating(cl(c)), 'b1c3', played), c).toBe(true);
    }
    for (const c of ['inaccuracy', 'mistake', 'miss', 'blunder'] as MoveClass[]) {
      expect(isSolution(rating(cl(c)), 'b1c3', played), c).toBe(false);
    }
    // A Good move that gives up material (a decided position) is no answer.
    expect(isSolution(rating(cl('good'), { concedes: 'material' }), 'b1c3', played)).toBe(false);
    expect(isSolution(rating(cl('best', { bestMoveUci: played })), played, played)).toBe(false);
  });

  it('the answer: the engine’s best move that is not the game’s, else the saved best move', () => {
    const ply = { uci: 'h5f7', classification: cl('blunder', { bestMoveUci: 'f1c4' }) };
    expect(answerMove(ply, [{ pv: ['g1f3', 'g8f6'] }, { pv: ['f1c4'] }])).toBe('g1f3');
    expect(answerMove(ply, [{ pv: ['h5f7'] }, { pv: ['f1c4'] }])).toBe('f1c4');
    expect(answerMove(ply, undefined)).toBe('f1c4');
    expect(answerMove({ uci: 'h5f7', classification: cl('blunder', { bestMoveUci: 'h5f7' }) }, [])).toBeNull();
    expect(answerMove({ uci: 'h5f7' }, [])).toBeNull();
  });
});

describe('Try again: wording', () => {
  const g = gameOf(MOVES, CLASSES);
  it('the prompt and the move in the game', () => {
    expect(practiceTitle(g.plies[4])).toBe('Find a better move than Qxf7+');
    expect(playedLine(g.plies[4])).toBe('In the game you played 3. Qxf7+, a blunder.');
    expect(playedLine(g.plies[2])).toBe('In the game you played 2. Qh5, an inaccuracy.');
    expect(playedLine({ ...g.plies[3], classification: undefined })).toBe('In the game you played 2… Nc6.');
  });

  it('hints name the piece, then its square (castling is a king move)', () => {
    const fen = g.plies[4].fenBefore;
    expect(hintText(fen, 'g1f3', 1)).toBe('Move a knight.');
    expect(hintText(fen, 'g1f3', 2)).toBe('Move the knight on g1.');
    expect(hintText(fen, 'h5f7', 1)).toBe('Move your queen.');
    expect(hintText('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1', 1)).toBe('Move your king.');
    expect(hintText('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1', 2)).toBe('Move the king on e1.');
  });

  it('a move that was not better, and one that was', () => {
    const base = { uci: 'b1c3', san: 'Nc3', color: 'w' as const, fenBefore: '', fenAfter: '' };
    expect(triedLine({ ...base, rating: rating(cl('inaccuracy')) })).toBe('Nc3 is an inaccuracy.');
    expect(triedLine({ ...base, rating: rating(cl('miss')) })).toBe('Nc3 is a miss.');
    expect(triedLine({ ...base, rating: rating(cl('good'), { concedes: 'material' }) })).toBe('Nc3 gives up material.');
    expect(triedLine({ ...base })).toBe('Nc3 is no better.');
    expect(solvedLine({ ...base, rating: rating(cl('excellent', { bestMoveUci: 'b1c3' })) }, 'Qxf7+')).toBe(FOUND_BEST_LINE);
    expect(solvedLine({ ...base, rating: rating(cl('best')) }, 'Qxf7+')).toBe(FOUND_BEST_LINE);
    expect(solvedLine({ ...base, rating: rating(cl('excellent', { nearBest: true })) }, 'Qxf7+')).toBe(FOUND_NEAR_LINE);
    expect(solvedLine({ ...base, rating: rating(cl('good', { nearBest: false })) }, 'Qxf7+')).toBe('That’s better than Qxf7+.');
  });
});
