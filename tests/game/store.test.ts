import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { Classification, Explanation } from '../../src/analysis/types';
import { customPersona } from '../../src/bot/personas';
import { offersShowBest } from '../../src/game/coach';
import { createState, createStore, explanationLines, pieceColorAt, type GameInfo } from '../../src/game/store';
import { DEFAULT_SETTINGS, type Ply } from '../../src/game/types';
import { defaultProfile } from '../../src/rating/rating';

const cl = (over: Partial<Classification> = {}): Classification => ({
  cls: 'mistake',
  winBefore: 0.6,
  winAfter: 0.4,
  winLoss: 0.2,
  accuracy: 40,
  bestMoveUci: 'g1f3',
  bestMoveSan: 'Nf3',
  playedMoveSan: 'h3',
  ...over,
});

describe('explanationLines', () => {
  const e = (headline: string, ...details: string[]): Explanation => ({ headline, details });

  it('adds "Best was X." when no line names X', () => {
    expect(explanationLines(e('h3 loses time.', 'Your king is still in the center.'), 'Nf3')).toEqual([
      'h3 loses time.',
      'Your king is still in the center.',
      'Best was Nf3.',
    ]);
  });

  it('does not repeat X when a line already names it as a move', () => {
    for (const line of ['Nf3 was needed to stop the threat.', 'Nf3 was better, developing a piece.', 'You missed Nf3, which wins a pawn.', 'Best was Nf3, which develops.']) {
      expect(explanationLines(e('h3 loses time.', line), 'Nf3')).toEqual(['h3 loses time.', line]);
    }
    // Check signs do not matter.
    expect(explanationLines(e('You missed Qxf7, which mates.'), 'Qxf7#')).toEqual(['You missed Qxf7, which mates.']);
  });

  it('a square or a longer move with the same letters is not a mention', () => {
    expect(explanationLines(e('Black can answer Nxf3.'), 'f3')).toEqual(['Black can answer Nxf3.', 'Best was f3.']);
    expect(explanationLines(e('O-O-O was possible.'), 'O-O')).toEqual(['O-O-O was possible.', 'Best was O-O.']);
  });

  it('without a best move or explanation', () => {
    expect(explanationLines(e('Solid.'), null)).toEqual(['Solid.']);
    expect(explanationLines(undefined, 'Nf3')).toEqual(['Best was Nf3.']);
    expect(explanationLines(null)).toEqual([]);
  });
});

describe('offersShowBest', () => {
  it('offers the engine move for weaker moves and for a Brilliant that was not the top move', () => {
    expect(offersShowBest(cl(), 'h2h3')).toBe(true);
    expect(offersShowBest(cl({ cls: 'inaccuracy' }), 'h2h3')).toBe(true);
    expect(offersShowBest(cl({ cls: 'brilliant' }), 'c4f7')).toBe(true);
  });

  it('not for the top move itself, nor for Best / Great / Book / Forced', () => {
    expect(offersShowBest(cl({ cls: 'brilliant', bestMoveUci: 'c4f7' }), 'c4f7')).toBe(false);
    expect(offersShowBest(cl({ cls: 'mistake', bestMoveUci: null }), 'h2h3')).toBe(false);
    for (const cls of ['best', 'great', 'book', 'forced'] as const) expect(offersShowBest(cl({ cls }), 'h2h3')).toBe(false);
  });
});

describe('coach view: Brilliant that is not the top move', () => {
  function reviewStore(classification: Classification) {
    const chess = new Chess();
    const before = chess.fen();
    const mv = chess.move('e4');
    const ply: Ply = {
      index: 0,
      color: 'w',
      san: mv.san,
      uci: 'e2e4',
      fenBefore: before,
      fenAfter: chess.fen(),
      evalWhite: { kind: 'cp', value: 30 },
      evalDepth: 14,
      classification,
      explanation: { headline: 'e4 offers a pawn to open lines.', details: [] },
    };
    const bot = customPersona(1200);
    const game: GameInfo = {
      id: 'g1',
      startFen: before,
      playerColor: 'w',
      bot,
      botElo: bot.elo,
      startedAt: new Date(0).toISOString(),
      assisted: false,
      settings: { ...DEFAULT_SETTINGS, playerColor: 'w' },
    };
    const state = createState({ settings: DEFAULT_SETTINGS, profile: defaultProfile() });
    state.game.value = game;
    state.plies.value = [ply];
    state.phase.value = 'review';
    state.viewIndex.value = 1;
    return createStore(state);
  }

  it('offers Show best and draws the best-move arrow in review, without a "Best was" line', () => {
    const store = reviewStore(cl({ cls: 'brilliant', bestMoveUci: 'd2d4', bestMoveSan: 'd4', playedMoveSan: 'e4' }));
    expect(store.coach.value.actions.map((a) => a.id)).toEqual(['showBest']);
    expect(store.coach.value.lines).toEqual(['e4 offers a pawn to open lines.']);
    expect(store.board.value.arrows).toEqual([{ from: 'd2', to: 'd4', brush: 'best' }]);
  });

  it('a Brilliant top move has nothing more to show', () => {
    const store = reviewStore(cl({ cls: 'brilliant', bestMoveUci: 'e2e4', bestMoveSan: 'e4', playedMoveSan: 'e4' }));
    expect(store.coach.value.actions).toEqual([]);
    expect(store.board.value.arrows).toEqual([]);
  });
});

describe('pieceColorAt', () => {
  it('reads the colour of the piece on a square, null when empty', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    expect(pieceColorAt(start, 'e1')).toBe('w');
    expect(pieceColorAt(start, 'h8')).toBe('b');
    expect(pieceColorAt(start, 'a2')).toBe('w');
    expect(pieceColorAt(start, 'e4')).toBeNull();
    const fen = '4k3/8/8/8/8/3p4/8/4K3 w - - 0 1'; // after ...exd3 e.p.
    expect(pieceColorAt(fen, 'd3')).toBe('b');
    expect(pieceColorAt(fen, 'd4')).toBeNull();
    expect(pieceColorAt(fen, 'e8')).toBe('b');
    expect(pieceColorAt(fen, 'h1')).toBeNull();
    for (const sq of ['a1', 'c7', 'f5', 'h8']) {
      expect(pieceColorAt(fen, sq)).toBe(new Chess(fen).get(sq as 'a1')?.color ?? null);
    }
  });
});
