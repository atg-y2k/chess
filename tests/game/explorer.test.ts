import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { Classification } from '../../src/analysis/types';
import { START_FEN } from '../../src/chess/utils';
import {
  back,
  clearFailed,
  currentMove,
  drawReason,
  explorerFen,
  forward,
  goTo,
  legalDests,
  movePath,
  playMove,
  reset,
  setRating,
  startExplorer,
  type Explorer,
  type ExplorerRating,
} from '../../src/game/explorer';

const base = (fen = START_FEN): Explorer => startExplorer({ baseFen: fen, baseIndex: 0, fromLive: true, gamePlies: 0 });

/** Plays UCI moves in order (each must be legal). */
function line(x: Explorer, ucis: string[]): Explorer {
  for (const u of ucis) {
    const next = playMove(x, u.slice(0, 2), u.slice(2, 4), (u[4] as 'q' | undefined) ?? undefined);
    expect(next, u).not.toBeNull();
    x = next!;
  }
  return x;
}

const rating = (cls: Classification['cls'] = 'best'): ExplorerRating => ({
  classification: {
    cls,
    winBefore: 0.5,
    winAfter: 0.5,
    winLoss: 0,
    accuracy: 100,
    bestMoveUci: 'e2e4',
    bestMoveSan: 'e4',
    playedMoveSan: 'e4',
  },
  explanation: { headline: 'A fine move.', details: [] },
  evalWhite: { kind: 'cp', value: 30 },
  evalDepth: 14,
  isBook: false,
});

describe('explorer state', () => {
  it('starts empty at the base position', () => {
    const x = startExplorer({ baseFen: START_FEN, baseIndex: 4, fromLive: false, gamePlies: 6 });
    expect(x).toEqual({ baseFen: START_FEN, baseIndex: 4, fromLive: false, gamePlies: 6, moves: [], cursor: 0 });
    expect(explorerFen(x)).toBe(START_FEN);
    expect(currentMove(x)).toBeNull();
  });

  it('plays moves for both sides, with SAN, colors, positions and captures', () => {
    const x = line(base(), ['e2e4', 'd7d5', 'e4d5']);
    expect(x.cursor).toBe(3);
    expect(x.moves.map((m) => [m.san, m.color])).toEqual([
      ['e4', 'w'],
      ['d5', 'b'],
      ['exd5', 'w'],
    ]);
    expect(x.moves[2].captured).toBe('p');
    expect(x.moves[1].fenAfter).toBe(x.moves[2].fenBefore);
    const c = new Chess();
    for (const san of ['e4', 'd5', 'exd5']) c.move(san);
    expect(explorerFen(x)).toBe(c.fen());
    expect(currentMove(x)?.san).toBe('exd5');
  });

  it('rejects illegal moves (and moves from the wrong side) without changing anything', () => {
    const x = line(base(), ['e2e4']);
    expect(playMove(x, 'e4', 'e5')).toBeNull(); // Black to move
    expect(playMove(x, 'e7', 'e4')).toBeNull();
    expect(playMove(x, 'z9', 'e4')).toBeNull();
    expect(x.cursor).toBe(1);
  });

  it('promotes to a queen unless told otherwise, and to the piece asked for', () => {
    const fen = '8/P6k/8/8/8/8/8/K7 w - - 0 1';
    expect(currentMove(playMove(base(fen), 'a7', 'a8')!)?.san).toBe('a8=Q');
    expect(currentMove(playMove(base(fen), 'a7', 'a8', 'n')!)?.uci).toBe('a7a8n');
  });

  it('back / forward / goTo move the cursor within the line and keep it', () => {
    let x = line(base(), ['e2e4', 'e7e5', 'g1f3']);
    x = back(back(x));
    expect(x.cursor).toBe(1);
    expect(x.moves).toHaveLength(3);
    expect(explorerFen(x)).toBe(x.moves[0].fenAfter);
    x = forward(x);
    expect(x.cursor).toBe(2);
    expect(goTo(x, 0).cursor).toBe(0);
    expect(goTo(x, 99).cursor).toBe(3);
    expect(goTo(x, -3).cursor).toBe(0);
    expect(back(goTo(x, 0)).cursor).toBe(0);
    expect(forward(goTo(x, 3)).cursor).toBe(3);
    expect(goTo(x, 2)).toBe(x); // unchanged: same object
  });

  it('replaying the next move of the line keeps the line (and its ratings); another move replaces the rest', () => {
    let x = line(base(), ['e2e4', 'e7e5', 'g1f3']);
    x = setRating(x, 1, movePath(x, 1), { rating: rating('best') });
    x = goTo(x, 1);
    const same = playMove(x, 'e7', 'e5')!;
    expect(same.cursor).toBe(2);
    expect(same.moves).toBe(x.moves);
    expect(same.moves[1].rating?.classification.cls).toBe('best');
    const other = playMove(x, 'c7', 'c5')!;
    expect(other.cursor).toBe(2);
    expect(other.moves.map((m) => m.san)).toEqual(['e4', 'c5']);
    expect(other.moves[1].rating).toBeUndefined();
  });

  it('reset clears the line', () => {
    const x = line(base(), ['e2e4', 'e7e5']);
    const r = reset(x);
    expect(r.moves).toEqual([]);
    expect(r.cursor).toBe(0);
    expect(explorerFen(r)).toBe(START_FEN);
    expect(reset(r)).toBe(r);
  });

  it('a rating lands only on the move its path names', () => {
    let x = line(base(), ['e2e4', 'e7e5']);
    const path = movePath(x, 1);
    expect(path).toBe('e2e4 e7e5');
    x = setRating(x, 1, path, { rating: rating('excellent') });
    expect(x.moves[1].rating?.classification.cls).toBe('excellent');
    // The line changed: a late rating for the old move is dropped.
    const changed = playMove(goTo(x, 1), 'c7', 'c5')!;
    expect(setRating(changed, 1, path, { rating: rating('blunder') })).toBe(changed);
    expect(setRating(changed, 5, 'x', { failed: true })).toBe(changed);
    // A failure, then a retry clears it.
    const failed = setRating(changed, 1, movePath(changed, 1), { failed: true });
    expect(failed.moves[1].failed).toBe(true);
    const cleared = clearFailed(failed);
    expect(cleared.moves[1].failed).toBeUndefined();
    expect(clearFailed(cleared)).toBe(cleared);
    // A rating replaces a failure.
    expect(setRating(failed, 1, movePath(failed, 1), { rating: rating() }).moves[1]).not.toHaveProperty('failed');
  });

  it('lists the legal destinations of the side to move', () => {
    const d = legalDests(START_FEN);
    expect(d.get('e2')).toEqual(['e3', 'e4']);
    expect(d.get('g1')?.sort()).toEqual(['f3', 'h3']);
    expect(d.has('e7')).toBe(false);
    expect(legalDests('not a fen').size).toBe(0);
    // Checkmate: no moves.
    expect(legalDests('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3').size).toBe(0);
  });
});

describe('drawReason', () => {
  it('a third repetition counts the game’s positions up to the base, then the line up to the cursor', () => {
    // The game: 1. Nf3 Nf6 2. Ng1 Ng8 (the start position for the second time).
    const game = line(base(), ['g1f3', 'g8f6', 'f3g1', 'f6g8']).moves;
    let x = startExplorer({ baseFen: START_FEN, baseIndex: 4, fromLive: true, gamePlies: 4 });
    expect(drawReason(x, START_FEN, game)).toBeNull();
    x = line(x, ['g1f3', 'g8f6', 'f3g1', 'f6g8']);
    expect(drawReason(x, START_FEN, game)).toBe('Threefold repetition');
    expect(drawReason(back(x), START_FEN, game)).toBeNull();
    // From an earlier base, the game's later positions do not count.
    const early = line(startExplorer({ baseFen: START_FEN, baseIndex: 0, fromLive: false, gamePlies: 4 }), ['g1f3', 'g8f6', 'f3g1', 'f6g8']);
    expect(drawReason(early, START_FEN, game)).toBeNull();
  });

  it('too little material and the 50-move rule; never for checkmate or stalemate', () => {
    expect(drawReason(base('4k3/8/8/8/8/8/8/4KB2 w - - 0 1'), START_FEN, [])).toBe('Insufficient material');
    expect(drawReason(line(base('4k3/8/8/8/8/8/8/4K2R w - - 99 80'), ['h1h2']), START_FEN, [])).toBe('50-move rule');
    expect(drawReason(base('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1'), START_FEN, [])).toBeNull(); // checkmate
    expect(drawReason(base('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'), START_FEN, [])).toBeNull(); // stalemate
  });
});
