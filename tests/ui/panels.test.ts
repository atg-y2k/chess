import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { groupCaptured } from '../../src/ui/PlayerStrip';
import { pairMoves, NOTABLE_CLASSES } from '../../src/ui/MoveList';
import { visibleReviewClasses, formatAccuracy, CORE_REVIEW_CLASSES } from '../../src/ui/ReviewPanel';
import type { Ply } from '../../src/game/types';

function plies(fen: string | undefined, sans: string[]): Ply[] {
  const c = fen ? new Chess(fen) : new Chess();
  return sans.map((san, index) => {
    const fenBefore = c.fen();
    const m = c.move(san);
    return { index, color: m.color, san: m.san, uci: m.lan, fenBefore, fenAfter: c.fen() };
  });
}

describe('groupCaptured', () => {
  it('groups by type, pawns first, ignores kings/unknown', () => {
    expect(groupCaptured(['q', 'p', 'p', 'N', 'k', 'x', 'b', 'r'])).toEqual([
      { piece: 'p', count: 2 },
      { piece: 'n', count: 1 },
      { piece: 'b', count: 1 },
      { piece: 'r', count: 1 },
      { piece: 'q', count: 1 },
    ]);
    expect(groupCaptured([])).toEqual([]);
  });
});

describe('pairMoves', () => {
  it('pairs white/black with FEN move numbers', () => {
    const pairs = pairMoves(plies(undefined, ['e4', 'e5', 'Nf3']));
    expect(pairs.map((p) => [p.no, p.white?.san, p.black?.san])).toEqual([
      [1, 'e4', 'e5'],
      [2, 'Nf3', undefined],
    ]);
  });
  it('handles a game that starts with Black to move', () => {
    const pairs = pairMoves(plies('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 3 3', ['Nf6', 'Nc3', 'Bb4']));
    expect(pairs.map((p) => [p.no, p.white?.san, p.black?.san])).toEqual([
      [3, undefined, 'Nf6'],
      [4, 'Nc3', 'Bb4'],
    ]);
  });
  it('is empty for no plies', () => expect(pairMoves([])).toEqual([]));
});

describe('MoveList icon policy', () => {
  it('shows only notable classes by default', () => {
    expect([...NOTABLE_CLASSES].sort()).toEqual(['blunder', 'brilliant', 'great', 'inaccuracy', 'miss', 'mistake']);
  });
});

describe('ReviewPanel helpers', () => {
  it('keeps core rows, drops all-zero others, keeps MOVE_CLASS_ORDER', () => {
    expect(visibleReviewClasses({ w: { book: 3, great: 0 }, b: { miss: 1 } })).toEqual([
      'brilliant', 'best', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder',
    ]);
    expect(visibleReviewClasses({ w: {}, b: {} })).toEqual([...CORE_REVIEW_CLASSES]);
  });
  it('formats accuracy', () => {
    expect(formatAccuracy(86.44)).toBe('86.4');
    expect(formatAccuracy(100)).toBe('100.0');
    expect(formatAccuracy(null)).toBe('–');
    expect(formatAccuracy(Number.NaN)).toBe('–');
  });
});
