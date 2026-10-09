import { Chess } from 'chess.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOpenings } from '../../src/bot/book';
import { START_FEN } from '../../src/chess/utils';
import { getLine, loadCatalog, type OpeningLine } from '../../src/openings/catalog';
import {
  checkMove,
  createDrill,
  drillHint,
  drillResult,
  drillTurn,
  dubiousPlayerMoves,
  expectedMove,
  opponentMove,
  playerMoveCount,
  playOpponent,
  restartDrill,
  type DrillBook,
  type DrillState,
} from '../../src/openings/drill';

let ruy: OpeningLine; // 1. e4 e5 2. Nf3 Nc6 3. Bb5
let najdorf: OpeningLine; // 1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6

beforeAll(async () => {
  await Promise.all([loadCatalog(), loadOpenings()]);
  ruy = getLine('c60-ruy-lopez')!;
  najdorf = getLine('b90-sicilian-defense-najdorf-variation')!;
});

/** Plays the player's line moves correctly and the opponent's automatically until the end. */
function finish(s: DrillState): DrillState {
  while (s.status !== 'complete') {
    if (s.status === 'opponent') s = playOpponent(s);
    else s = checkMove(s, expectedMove(s)!.uci).state;
  }
  return s;
}

describe('drilling as White', () => {
  it('runs a line: correct moves, opponent replies, completion', () => {
    let s = createDrill(ruy, 'w');
    expect(s).toMatchObject({ status: 'player', ply: 0, fen: START_FEN, lastMove: null, mistakes: 0, hints: 0 });
    expect(drillTurn(s)).toBe('w');
    expect(expectedMove(s)).toEqual({ uci: 'e2e4', san: 'e4', label: '1. e4' });
    expect(opponentMove(s)).toBeNull();

    const c = checkMove(s, 'e2e4');
    expect(c).toMatchObject({ result: 'correct', played: { san: 'e4' }, expected: { san: 'e4' }, message: 'Correct: 1. e4.' });
    expect(c.alternatives.map((m) => m.san)).toEqual(expect.arrayContaining(['d4', 'c4', 'Nf3']));
    expect(c.alternatives.some((m) => m.uci === 'e2e4')).toBe(false);
    s = c.state;
    expect(s).toMatchObject({ status: 'opponent', ply: 1, lastMove: { san: 'e4', color: 'w', label: '1. e4' } });
    expect(drillResult(s)).toBeNull();

    expect(opponentMove(s)).toEqual({ uci: 'e7e5', san: 'e5', label: '1... e5' });
    s = playOpponent(s);
    expect(s).toMatchObject({ status: 'player', ply: 2, lastMove: { san: 'e5', color: 'b' } });
    expect(playOpponent(s)).toBe(s); // not the opponent's turn: unchanged

    s = finish(s);
    expect(s.status).toBe('complete');
    expect(s.fen).toBe(new Chess('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3').fen());
    expect(drillResult(s)).toEqual({
      lineId: 'c60-ruy-lopez',
      playerColor: 'w',
      fromPly: 0,
      partial: false,
      playerMoves: 3,
      found: 3,
      mistakes: 0,
      alternatives: 0,
      hints: 0,
      clean: true,
      score: 100,
    });
    expect(checkMove(s, 'a2a3')).toMatchObject({ result: 'illegal', state: s, message: 'This line is complete.' });
  });

  it('tells another book move from a wrong one, and keeps the position', () => {
    let s = playOpponent(checkMove(createDrill(ruy, 'w'), 'e2e4').state); // 1. e4 e5, White to move

    const alt = checkMove(s, 'b1c3'); // 2. Nc3: the Vienna Game, also book
    expect(alt.result).toBe('alternative');
    expect(alt.message).toBe('2. Nc3 is also a book move, but this line continues with 2. Nf3.');
    expect(alt.expected).toEqual({ uci: 'g1f3', san: 'Nf3', label: '2. Nf3' });
    expect(alt.state).toMatchObject({ ply: 2, fen: s.fen, mistakes: 1, alternatives: 1, triesThisMove: 1, missed: [2] });
    s = alt.state;

    const wrong = checkMove(s, 'h2h4');
    expect(wrong.result).toBe('wrong');
    expect(wrong.message).toBe('2. h4 is not part of the opening theory here. Try again.');
    expect(wrong.state).toMatchObject({ ply: 2, mistakes: 2, alternatives: 1, triesThisMove: 2, missed: [2] });
    s = wrong.state;

    const illegal = checkMove(s, 'a1a5');
    expect(illegal).toMatchObject({ result: 'illegal', played: null, state: s });

    s = checkMove(s, 'g1f3').state;
    expect(s).toMatchObject({ ply: 3, triesThisMove: 0, status: 'opponent' });
    s = finish(s);
    expect(drillResult(s)).toMatchObject({ playerMoves: 3, found: 2, mistakes: 2, alternatives: 1, clean: false, score: 67 });
  });

  it('does not count another book move as a mistake with acceptAlternatives, but as not found', () => {
    let s = playOpponent(checkMove(createDrill(ruy, 'w', { acceptAlternatives: true }), 'e2e4').state);
    const alt = checkMove(s, 'b1c3');
    expect(alt.result).toBe('alternative');
    expect(alt.message).toBe('2. Nc3 is also a book move, but this line continues with 2. Nf3.');
    expect(alt.state).toMatchObject({ mistakes: 0, alternatives: 1, missed: [2] });
    s = finish(alt.state);
    expect(drillResult(s)).toMatchObject({ mistakes: 0, alternatives: 1, found: 2, clean: false, score: 67 });
  });

  it('cannot be gamed by playing another book move to read the answer', () => {
    // The message reveals the line's move, so an alternative must not count as found.
    const closed = getLine('c84-ruy-lopez-closed')!;
    let s = createDrill(closed, 'w', { acceptAlternatives: true });
    while (s.status !== 'complete') {
      if (s.status === 'opponent') {
        s = playOpponent(s);
        continue;
      }
      const c = checkMove(s, 'h2h4'); // probe: never this line's move
      const probe = checkMove(s, c.alternatives[0]?.uci ?? 'h2h4');
      s = checkMove(probe.state, probe.expected!.uci).state;
    }
    expect(drillResult(s)).toMatchObject({ playerMoves: 5, found: 0, mistakes: 0, clean: false, score: 0 });
  });

  it('flags a line whose own move is a known blunder (a trap drilled from the losing side)', () => {
    const foolsMate = getLine('a00-barnes-opening-fools-mate')!; // 1. f3 e5 2. g4?? Qh4#
    expect(dubiousPlayerMoves(foolsMate, 'w')).toEqual([2]);
    expect(dubiousPlayerMoves(foolsMate, 'b')).toEqual([]);
    expect(dubiousPlayerMoves(ruy, 'w')).toEqual([]);
    expect(dubiousPlayerMoves(foolsMate, 'w', { bookMoves: () => [], isBookMove: () => false })).toEqual([]);
    const s = playOpponent(checkMove(createDrill(foolsMate, 'w'), 'f2f3').state);
    const c = checkMove(s, 'g2g4');
    expect(c).toMatchObject({ result: 'correct', expected: { san: 'g4', dubious: true } });
    expect(c.message).toBe('Correct for this line: 2. g4. It is a known mistake, and this line shows how it gets punished.');
    expect(checkMove(createDrill(ruy, 'w'), 'e2e4').expected).not.toHaveProperty('dubious');
  });

  it('calls a known trap-line blunder a mistake', () => {
    const hammerschlag = getLine('a00-barnes-opening-hammerschlag')!; // 1. f3 e5 2. Kf2
    const s = playOpponent(checkMove(createDrill(hammerschlag, 'w'), 'f2f3').state);
    const c = checkMove(s, 'g2g4'); // 2. g4?? Qh4# (Fool's Mate): a book move, but a blunder
    expect(c.result).toBe('wrong');
    expect(c.message).toBe('2. g4 is a known mistake here. Try again.');
    expect(c.alternatives.some((m) => m.san === 'g4')).toBe(false);
  });

  it('treats every other move as wrong without a book', () => {
    const noBook: DrillBook = { bookMoves: () => [], isBookMove: () => false };
    const s = playOpponent(checkMove(createDrill(ruy, 'w'), 'e2e4', noBook).state);
    const c = checkMove(s, 'b1c3', noBook);
    expect(c).toMatchObject({ result: 'wrong', alternatives: [] });
    expect(checkMove(s, 'g1f3', noBook).result).toBe('correct');
  });
});

describe('drilling as Black', () => {
  it('lets the app move first and drills Black\'s moves', () => {
    let s = createDrill(najdorf, 'b');
    expect(s.status).toBe('opponent');
    expect(checkMove(s, 'c7c5')).toMatchObject({ result: 'illegal', state: s, message: "Wait for the opponent's move." });
    expect(drillHint(s).hint).toBeNull();
    s = playOpponent(s);
    expect(s).toMatchObject({ status: 'player', ply: 1 });
    expect(drillTurn(s)).toBe('b');
    expect(expectedMove(s)).toEqual({ uci: 'c7c5', san: 'c5', label: '1... c5' });
    s = finish(s);
    expect(drillResult(s)).toMatchObject({ playerColor: 'b', playerMoves: 5, found: 5, clean: true });
    expect(s.lastMove).toMatchObject({ san: 'a6', color: 'b', label: '5... a6' });
  });

  it('starts part-way through a line with fromPly', () => {
    const s = createDrill(najdorf, 'b', { fromPly: 3 }); // after 1. e4 c5 2. Nf3
    expect(s).toMatchObject({ status: 'player', ply: 3, fromPly: 3, lastMove: { san: 'Nf3', color: 'w', label: '2. Nf3' } });
    expect(expectedMove(s)?.label).toBe('2... d6');
    expect(playerMoveCount(najdorf, 'b', 3)).toBe(4);
    // 1... c5 was skipped: a partial drill (practice, not mastery; see recordDrill)
    expect(drillResult(finish(s))).toMatchObject({ playerMoves: 4, found: 4, clean: true, fromPly: 3, partial: true });
    // skipping only the opponent's 1. e4 is still a full drill
    expect(drillResult(finish(createDrill(najdorf, 'b', { fromPly: 1 })))).toMatchObject({ playerMoves: 5, partial: false });
    expect(drillResult(finish(createDrill(najdorf, 'w', { fromPly: 8 })))).toMatchObject({ playerMoves: 1, partial: true });
    expect(createDrill(najdorf, 'w', { fromPly: 1 }).status).toBe('opponent');
    expect(createDrill(najdorf, 'w', { fromPly: 99 }).status).toBe('complete');
  });

  it('scores a drill with nothing to find as 0, not clean', () => {
    const kpg = getLine('b00-kings-pawn-game')!; // 1. e4: nothing for Black to find
    expect(playerMoveCount(kpg, 'b')).toBe(0);
    const s = playOpponent(createDrill(kpg, 'b'));
    expect(s.status).toBe('complete');
    expect(drillResult(s)).toMatchObject({ playerMoves: 0, found: 0, clean: false, score: 0 });
  });

  it('drills a line that starts with Black\'s move', () => {
    const afterE4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const line = { id: 'custom', uci: ['e7e5', 'g1f3', 'b8c6'], startFen: afterE4 };
    let s = createDrill(line, 'b');
    expect(s.status).toBe('player');
    expect(expectedMove(s)?.label).toBe('1... e5');
    s = checkMove(s, 'e7e5').state;
    expect(opponentMove(s)?.label).toBe('2. Nf3');
    s = finish(s);
    expect(drillResult(s)).toMatchObject({ playerMoves: 2, clean: true });
    expect(playerMoveCount(line, 'b')).toBe(2);
    expect(playerMoveCount(line, 'w')).toBe(1);
  });
});

describe('hints', () => {
  it('names the piece, then its square, then the move', () => {
    let s = playOpponent(checkMove(createDrill(ruy, 'w'), 'e2e4').state); // White to play 2. Nf3
    let h = drillHint(s);
    expect(h.hint).toEqual({ level: 1, piece: 'n', text: 'Move a knight.' });
    s = h.state;
    expect(s).toMatchObject({ hintLevel: 1, hints: 1, missed: [2] });
    h = drillHint(s);
    expect(h.hint).toEqual({ level: 2, piece: 'n', from: 'g1', text: 'Move the knight on g1.' });
    s = h.state;
    h = drillHint(s);
    expect(h.hint).toMatchObject({ level: 3, from: 'g1', move: { uci: 'g1f3', san: 'Nf3' }, text: 'Play 2. Nf3.' });
    s = h.state;
    expect(s).toMatchObject({ hintLevel: 3, hints: 3 });
    expect(drillHint(playOpponent(checkMove(createDrill(ruy, 'w'), 'e2e4').state), 3).state.hints).toBe(3); // same count
    // asking again for a level already shown changes nothing
    expect(drillHint(s).state).toBe(s);
    expect(drillHint(s, 1)).toMatchObject({ state: s, hint: { level: 1 } });
    s = checkMove(s, 'g1f3').state;
    expect(s.hintLevel).toBe(0);
    expect(drillResult(finish(s))).toMatchObject({ hints: 3, mistakes: 0, found: 2, clean: false, score: 67 });
  });

  it('jumps straight to a level, and words single pieces and castling', () => {
    const closed = getLine('c84-ruy-lopez-closed')!; // ... 5. O-O Be7
    expect(closed.san.slice(0, 10)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7']);
    const s = createDrill(closed, 'w', { fromPly: 8 });
    expect(drillHint(s, 1).hint?.text).toBe('Move your king.');
    expect(drillHint(s, 2).hint?.text).toBe('Move the king on e1.');
    const three = drillHint(s, 3);
    expect(three.hint?.text).toBe('Play 5. O-O (castle kingside).');
    expect(three.state).toMatchObject({ hintLevel: 3, hints: 3 }); // levels 1 and 2 were skipped, not free
    expect(drillHint(drillHint(s, 2).state, 3).state).toMatchObject({ hintLevel: 3, hints: 3 });

    const scandi = getLine('b01-scandinavian-defense-mieses-kotroc-variation')!; // 1. e4 d5 2. exd5 Qxd5
    expect(scandi.san.slice(0, 4)).toEqual(['e4', 'd5', 'exd5', 'Qxd5']);
    const q = createDrill(scandi, 'b', { fromPly: 3 });
    expect(drillHint(q).hint?.text).toBe('Move your queen.');
  });
});

describe('purity', () => {
  it('never mutates its inputs and is deterministic', () => {
    const line = { id: 'ruy', uci: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'], name: 'Ruy Lopez' };
    const copy = structuredClone(line);
    const s0 = createDrill(line, 'w');
    expect(Object.isFrozen(s0)).toBe(true);
    const snapshot = structuredClone(s0);
    const a = checkMove(s0, 'b1c3');
    const b = checkMove(s0, 'b1c3');
    expect(a).toEqual(b);
    drillHint(s0, 3);
    playOpponent(checkMove(s0, 'e2e4').state);
    expect(s0).toEqual(snapshot);
    expect(line).toEqual(copy);
    expect(JSON.parse(JSON.stringify(s0))).toEqual(snapshot); // plain data
  });

  it('restarts with the same settings and fresh counters', () => {
    let s = createDrill(najdorf, 'b', { acceptAlternatives: true, fromPly: 3 }); // Black to play 2... d6
    s = checkMove(s, 'h2h4').state; // a White move: illegal, not counted
    s = checkMove(s, 'a7a5').state; // wrong
    s = drillHint(s).state;
    expect(s).toMatchObject({ mistakes: 1, hints: 1, missed: [3] });
    const r = restartDrill(s);
    expect(r).toEqual(createDrill(najdorf, 'b', { acceptAlternatives: true, fromPly: 3 }));
    expect(r).toMatchObject({ mistakes: 0, hints: 0, missed: [], ply: 3, acceptAlternatives: true });
  });

  it('rejects a line with an illegal move', () => {
    expect(() => createDrill({ id: 'bad', uci: ['e2e5'] }, 'w')).toThrow();
  });
});
