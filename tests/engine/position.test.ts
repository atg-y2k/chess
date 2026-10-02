import { Chess } from 'chess.js';
import { describe, expect, it, vi } from 'vitest';
import { PositionCommands, positionCommand } from '../../src/engine/position';

const START = new Chess().fen();

/** FEN after playing UCI `moves` from `start`. */
function play(start: string, moves: readonly string[]): string {
  const c = new Chess(start);
  for (const m of moves) c.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  return c.fen();
}

const bare = (fen: string) => `position fen ${fen}`;
const withMoves = (fen: string, moves: string[]) => `position fen ${fen} moves ${moves.join(' ')}`;

/** Plays the moves of a `position fen F moves …` command (as Stockfish would) and returns the FEN reached. */
function reached(cmd: string): string {
  const m = /^position fen (.+?)(?: moves (.+))?$/.exec(cmd);
  if (!m) throw new Error(`not a position command: ${cmd}`);
  return play(m[1], m[2] ? m[2].split(' ') : []);
}

const fields5 = (fen: string) => fen.split(' ').slice(0, 5).join(' ');

describe('positionCommand', () => {
  it('sends the bare FEN without a history', () => {
    const fen = play(START, ['e2e4', 'e7e5']);
    expect(positionCommand(fen)).toBe(bare(fen));
  });

  it('sends the moves since the start when none of them is irreversible', () => {
    const start = '6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1';
    const moves = ['g1h1', 'g8h8', 'h1g1', 'h8g8', 'g1h1', 'g8h8', 'h1g1'];
    expect(positionCommand(play(start, moves), { startFen: start, moves })).toBe(withMoves(start, moves));
  });

  it('starts from the position after the last capture or pawn move', () => {
    const moves = ['e2e4', 'd7d5', 'e4d5', 'g8f6', 'g1f3', 'f6g8', 'f3g1', 'g8f6'];
    const fen = play(START, moves);
    // exd5 was the last irreversible move: only the knight moves after it are sent.
    expect(positionCommand(fen, { startFen: START, moves })).toBe(
      withMoves(play(START, moves.slice(0, 3)), moves.slice(3)),
    );
    // Ending with a pawn move: nothing to repeat, the bare FEN is enough.
    const pawn = [...moves, 'd2d3'];
    expect(positionCommand(play(START, pawn), { startFen: START, moves: pawn })).toBe(bare(play(START, pawn)));
  });

  it('treats a change of castling rights as irreversible (king move, rook move, castling)', () => {
    const open = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
    const cases: [string[], number][] = [
      [['e1f1', 'e8f8', 'f1e1', 'f8e8'], 2], // both kings moved: rights gone after the second move
      [['h1g1', 'a8b8', 'g1h1', 'b8a8'], 2], // each rook move loses one right
      [['e1g1', 'e8c8', 'g1h1', 'c8b8', 'h1g1'], 2], // castling, then quiet king moves
      [['a1b1', 'h8g8', 'b1a1', 'g8h8', 'a1b1'], 2],
    ];
    for (const [moves, lastIrreversible] of cases) {
      const fen = play(open, moves);
      const cmd = positionCommand(fen, { startFen: open, moves });
      expect(cmd).toBe(withMoves(play(open, moves.slice(0, lastIrreversible)), moves.slice(lastIrreversible)));
      expect(fields5(reached(cmd))).toBe(fields5(fen));
    }
  });

  it('keeps the halfmove clock of a start position after quiet moves', () => {
    const start = '4k3/8/8/8/8/8/8/4K2R w K - 12 40';
    const moves = ['h1h2', 'e8d8', 'h2h1', 'd8e8'];
    const fen = play(start, moves);
    expect(fen.split(' ')[4]).toBe('16'); // h1h2 dropped the castling right; the clock kept counting
    const cmd = positionCommand(fen, { startFen: start, moves });
    expect(cmd).toBe(withMoves(play(start, moves.slice(0, 1)), moves.slice(1)));
    expect(reached(cmd)).toBe(fen);
  });

  it('falls back to the bare FEN for a history that is illegal, malformed or leads elsewhere', () => {
    const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
    const fen = play(START, moves);
    const bad: [string, string[]][] = [
      [START, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']], // one move too many
      [START, ['e2e4', 'e7e5', 'g1f3']], // one move short
      [START, ['e2e4', 'e7e5', 'g1f3', 'b8d6']], // illegal move
      [START, ['e2e4', 'e7e5', 'g1f3', 'B8C6']], // not UCI
      [START, ['e2e4', 'e7e5', 'g1f3', 'b8c6 ']],
      [START, ['e2e4', 'e7e5', 'g1f3', '']],
      [START, ['e2e4', 'e7e5', 'g1f3', 'Nc6']], // SAN
      ['not a fen', moves],
      ['', moves],
    ];
    for (const [startFen, h] of bad) expect(positionCommand(fen, { startFen, moves: h })).toBe(bare(fen));
    // A start position Stockfish rejects (the side not to move is in check) is never sent.
    const check = '4k3/4R3/8/8/8/8/8/4K3 w - - 0 1';
    const afterKd1 = play(check, ['e1d1']);
    expect(positionCommand(afterKd1, { startFen: check, moves: ['e1d1'] })).toBe(bare(afterKd1));
    // Same position but a different halfmove clock: the history is not this game's.
    const other = fen.replace(/ \d+ (\d+)$/, ' 7 $1');
    expect(positionCommand(other, { startFen: START, moves })).toBe(bare(other));
    // Junk shapes from untyped callers never throw.
    const junk = { startFen: START, moves: null } as unknown as { startFen: string; moves: string[] };
    expect(positionCommand(fen, junk)).toBe(bare(fen));
  });

  it('rejects a promotion written in upper case, accepts it in lower case', () => {
    const start = '8/4P3/8/8/8/8/k7/4K3 w - - 0 1';
    const fen = play(start, ['e7e8q', 'a2a3', 'e8e7']);
    expect(positionCommand(fen, { startFen: start, moves: ['e7e8Q', 'a2a3', 'e8e7'] })).toBe(bare(fen));
    expect(positionCommand(fen, { startFen: start, moves: ['e7e8q', 'a2a3', 'e8e7'] })).toBe(
      withMoves(play(start, ['e7e8q']), ['a2a3', 'e8e7']),
    );
  });

  it('matches positions by board, side, castling, en passant and clock, not by the move number', () => {
    const start = '6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1';
    const moves = ['g1h1', 'g8h8'];
    const fen = play(start, moves).replace(/ \d+$/, ' 99');
    expect(positionCommand(fen, { startFen: start, moves })).toBe(withMoves(start, moves));
  });
});

describe('PositionCommands (incremental replay)', () => {
  /** A deterministic pseudo-random game with plenty of quiet moves. */
  function randomGame(plies: number, seed: number): string[] {
    const c = new Chess();
    const out: string[] = [];
    let s = seed;
    for (let i = 0; i < plies && !c.isGameOver(); i++) {
      const ms = c.moves({ verbose: true });
      s = (s * 1103515245 + 12345) % 2147483648;
      const quiet = ms.filter((m) => !m.captured && m.piece !== 'p');
      const pool = quiet.length && s % 4 ? quiet : ms;
      const m = pool[s % pool.length];
      c.move(m);
      out.push(m.from + m.to + (m.promotion ?? ''));
    }
    return out;
  }

  /** Independent oracle: FENs after each ply (0 = start) and the expected command for each prefix. */
  function oracle(game: string[]) {
    const c = new Chess();
    const fens = [c.fen()];
    const lastIrreversible = [0];
    for (const [i, u] of game.entries()) {
      const castling = c.fen().split(' ')[2];
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      fens.push(c.fen());
      const irreversible = !!m.captured || m.piece === 'p' || c.fen().split(' ')[2] !== castling;
      lastIrreversible.push(irreversible ? i + 1 : lastIrreversible[i]);
    }
    const expected = (n: number) => {
      const k = lastIrreversible[n];
      return k === n ? bare(fens[n]) : withMoves(fens[k], game.slice(k, n));
    };
    return { fens, expected };
  }

  it('matches a fresh replay while the game grows, after takebacks and for other games', () => {
    const cmds = new PositionCommands();
    for (const seed of [1, 2]) {
      const game = randomGame(150, seed);
      const { fens, expected } = oracle(game);
      // Grow, take back a few moves, grow again, then jump back to the start.
      const order = [...game.keys()].map((i) => i + 1);
      order.push(40, 37, 38, 39, 60, 3, 0, 1);
      for (const [j, n] of order.entries()) {
        const moves = game.slice(0, n);
        const cmd = cmds.command(fens[n], { startFen: START, moves });
        expect(cmd).toBe(expected(n));
        if (j % 7 === 0) expect(fields5(reached(cmd))).toBe(fields5(fens[n]));
        expect(cmd.split(' moves ')[1]?.split(' ').length ?? 0).toBeLessThanOrEqual(100);
      }
      expect(positionCommand(fens[game.length], { startFen: START, moves: game })).toBe(expected(game.length));
    }
    // A bad history in between does not spoil the next good one.
    const game = randomGame(30, 9);
    const { fens, expected } = oracle(game);
    expect(cmds.command(fens[30], { startFen: START, moves: [...game.slice(0, 29), 'a1a1'] })).toBe(bare(fens[30]));
    expect(cmds.command(fens[30], { startFen: START, moves: game })).toBe(expected(30));
  });

  it('replays only the new moves while the history grows', () => {
    const game = randomGame(200, 4);
    const { fens } = oracle(game);
    const cmds = new PositionCommands();
    const spy = vi.spyOn(Chess.prototype, 'move');
    try {
      for (let n = 1; n <= game.length; n++) cmds.command(fens[n], { startFen: START, moves: game.slice(0, n) });
      expect(spy).toHaveBeenCalledTimes(game.length);
      spy.mockClear();
      cmds.command(fens[150], { startFen: START, moves: game.slice(0, 150) }); // a takeback: replayed again
      expect(spy).toHaveBeenCalledTimes(150);
    } finally {
      spy.mockRestore();
    }
  });
});
