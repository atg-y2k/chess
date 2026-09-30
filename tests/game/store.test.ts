import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { Classification, Explanation } from '../../src/analysis/types';
import { customPersona } from '../../src/bot/personas';
import { fenKey } from '../../src/chess/utils';
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

describe('a praised move whose text says what it gives away (Explanation.concedes)', () => {
  // 10… Kd8 leaves the queen on b4 en prise; the position was lost, so the class is Excellent.
  const FEN = '1nb1kbnr/1p4pp/1rp1Pp2/p7/1q1P4/P1NB1N2/1PP2PPP/R1BQR1K1 b k - 0 10';

  function concedeStore(phase: 'review' | 'playing', concedes?: Explanation['concedes']) {
    const chess = new Chess(FEN);
    const mv = chess.move('Kd8');
    const ply: Ply = {
      index: 0,
      color: 'b',
      san: mv.san,
      uci: 'e8d8',
      fenBefore: FEN,
      fenAfter: chess.fen(),
      evalWhite: { kind: 'cp', value: 1600 },
      evalDepth: 14,
      classification: cl({
        cls: 'excellent',
        winBefore: 0.02,
        winAfter: 0.003,
        winLoss: 0.017,
        accuracy: 95,
        bestMoveUci: 'b4d6',
        bestMoveSan: 'Qd6',
        playedMoveSan: 'Kd8',
      }),
      explanation: {
        headline: 'This does nothing about the threat to your queen on b4.',
        details: ['White plays axb4 and wins the queen for a pawn.', 'The position was already lost.'],
        ...(concedes ? { concedes } : {}),
      },
    };
    const bot = customPersona(1200);
    const state = createState({ settings: DEFAULT_SETTINGS, profile: defaultProfile() });
    state.game.value = {
      id: 'g1',
      startFen: FEN,
      playerColor: 'b',
      bot,
      botElo: bot.elo,
      startedAt: new Date(0).toISOString(),
      assisted: false,
      settings: { ...DEFAULT_SETTINGS, playerColor: 'b' },
    };
    state.plies.value = [ply];
    state.phase.value = phase;
    if (phase === 'review') state.viewIndex.value = 1;
    else state.coachMode.value = { kind: 'feedback', index: 0 };
    return createStore(state);
  }

  for (const phase of ['review', 'playing'] as const) {
    it(`${phase}: a neutral title, and no praise icon on the coach, the board or the move list`, () => {
      const store = concedeStore(phase, 'material');
      const coach = store.coach.value;
      expect(coach.title).toBe('10… Kd8 doesn’t change the result');
      expect(coach.titleMove).toBe('10… Kd8');
      expect(coach.cls).toBeUndefined();
      expect(coach.lines[0]).toBe('This does nothing about the threat to your queen on b4.');
      expect(coach.actions.map((a) => a.id)).toContain('showBest');
      expect(store.board.value.badge).toBeUndefined();
      expect(store.moveList.value.plies[0].classification).toBeUndefined();
    });

    it(`${phase}: without the flag, the class verdict, badge and icon`, () => {
      const store = concedeStore(phase);
      expect(store.coach.value.title).toBe('10… Kd8 is excellent');
      expect(store.coach.value.cls).toBe('excellent');
      expect(store.board.value.badge).toEqual({ square: 'd8', cls: 'excellent' });
      expect(store.moveList.value.plies[0].classification?.cls).toBe('excellent');
    });
  }

  it('browsing back to the move during the game shows the same neutral verdict', () => {
    const store = concedeStore('playing', 'mate');
    store.viewIndex.value = 1; // not live: the history view of the same move
    expect(store.isLive.value).toBe(false);
    expect(store.coach.value.title).toBe('10… Kd8 doesn’t change the result');
    expect(store.coach.value.cls).toBeUndefined();
    expect(store.board.value.badge).toBeUndefined();
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

describe('eval bar', () => {
  // After 9.Qa3+ (see tests/engine/nodeBudget.test.ts): one iteration can take millions of nodes.
  const FEN = 'r1bq1br1/pp2pppp/3k4/8/3P4/Q7/PP3PPP/RNB1KBNR b KQ - 3 9';

  function liveStore(depth: number, done: boolean) {
    const bot = customPersona(1200);
    const state = createState({ settings: DEFAULT_SETTINGS, profile: defaultProfile() });
    state.game.value = {
      id: 'g1',
      startFen: FEN,
      playerColor: 'w',
      bot,
      botElo: bot.elo,
      startedAt: new Date(0).toISOString(),
      assisted: false,
      settings: { ...DEFAULT_SETTINGS, playerColor: 'w' },
    };
    state.phase.value = 'playing';
    state.live.value = {
      key: fenKey(FEN),
      result: {
        fen: FEN,
        depth,
        lines: [{ multipv: 1, depth, score: { kind: 'cp', value: -1300 }, pv: ['d6e6'] }],
        bestMove: done ? 'd6e6' : null,
        done,
      },
    };
    return createStore(state);
  }

  it('pulses while the live search is shallow, and stops once it finished (e.g. at its node budget)', () => {
    const searching = liveStore(11, false).evalBar.value;
    expect(searching).toMatchObject({ label: '+13.0', thinking: true, depth: 11 });
    expect(liveStore(11, true).evalBar.value).toMatchObject({ label: '+13.0', thinking: false, depth: 11 });
    expect(liveStore(12, false).evalBar.value.thinking).toBe(false);
  });
});

describe('idle coach tip', () => {
  function playingStore(sans: string[]) {
    const chess = new Chess();
    const plies: Ply[] = sans.map((san, index) => {
      const fenBefore = chess.fen();
      const m = chess.move(san);
      return {
        index,
        color: m.color,
        san: m.san,
        uci: m.lan,
        fenBefore,
        fenAfter: chess.fen(),
        ...(m.captured ? { captured: m.captured } : {}),
      };
    });
    const bot = customPersona(1800);
    const state = createState({ settings: DEFAULT_SETTINGS, profile: defaultProfile() });
    state.game.value = {
      id: 'g1',
      startFen: new Chess().fen(),
      playerColor: 'w',
      bot,
      botElo: bot.elo,
      startedAt: new Date(0).toISOString(),
      assisted: false,
      settings: { ...DEFAULT_SETTINGS, playerColor: 'w' },
    };
    state.plies.value = plies;
    state.phase.value = 'playing';
    return { store: createStore(state), bot };
  }

  it('after the opponent takes a piece you can take back, asks for the recapture instead of a general tip', () => {
    // Game C of the acceptance test: the tip was "Improve your worst-placed piece." after 8… Bxc1.
    const { store, bot } = playingStore('d4 d5 c4 c6 e3 Nd7 Nf3 Ngf6 Bd3 g6 Nc3 dxc4 Bxc4 Bh6 e4 Bxc1'.split(' '));
    expect(store.coach.value.title).toBe('Your move');
    expect(store.coach.value.lines.at(-1)).toBe(`${bot.name} just took your bishop on c1. Can you recapture?`);
  });

  it('otherwise gives a general tip', () => {
    const { store } = playingStore('d4 d5 c4 c6 e3 Nd7 Nf3 Ngf6 Bd3 g6 Nc3 dxc4 Bxc4 Bh6 e4 O-O'.split(' '));
    expect(store.coach.value.title).toBe('Your move');
    expect(store.coach.value.lines.at(-1)).not.toMatch(/recapture/);
  });
});
