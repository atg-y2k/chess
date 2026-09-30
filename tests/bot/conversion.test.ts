/**
 * Real-engine regression tests (Stockfish WASM in node) for decided positions: the bot plays a seen
 * mate in one, and finishes K+Q / K+R v K against a sensible defence instead of drawing it
 * (Stockfish's own pick_best dithered between mates; the custom band hung the queen to the bare king).
 */
import { Chess } from 'chess.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BotPlayer } from '../../src/bot/BotPlayer';
import { mulberry32 } from '../../src/bot/strength';
import { StockfishEngine } from '../../src/engine/StockfishEngine';
import { createNodeTransport } from '../helpers/nodeTransport';

const KQK = '8/8/3k4/8/8/2Q5/8/4K3 w - - 0 1';
const KRK = '8/8/8/4k3/8/8/8/3RK3 w - - 0 1';

describe('bots finish won positions (real engine)', () => {
  let botEngine: StockfishEngine;
  let defender: StockfishEngine;

  beforeAll(async () => {
    botEngine = new StockfishEngine(createNodeTransport, { hashMb: 16, name: 'bot' });
    defender = new StockfishEngine(createNodeTransport, { hashMb: 16, name: 'defender' });
    await Promise.all([botEngine.init(), defender.init()]);
  }, 60_000);

  afterAll(() => {
    botEngine?.terminate();
    defender?.terminate();
  });

  /** Bot (White) against a depth-8 Stockfish defence, played to the end like the app does. */
  async function play(start: string, elo: number, seed: number): Promise<{ end: string; plies: number }> {
    const bot = new BotPlayer(botEngine, { rng: mulberry32(seed), thinkDelay: false });
    await bot.newGame(elo);
    await defender.newGame();
    const chess = new Chess(start);
    const history: string[] = [];
    while (history.length < 160) {
      if (chess.isCheckmate()) return { end: chess.turn() === 'b' ? 'bot mates' : 'bot mated', plies: history.length };
      if (chess.isDraw()) return { end: 'draw', plies: history.length };
      const uci =
        chess.turn() === 'w'
          ? (await bot.move(chess.fen(), elo, history, undefined, start))!.uci
          : (await defender.search(chess.fen(), { depth: 8, multiPv: 1 })).bestMove!;
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      history.push(uci);
    }
    return { end: 'unfinished', plies: history.length };
  }

  it('always plays a seen mate in one (was 11-33% of the time at 1600-3100)', async () => {
    // From a recorded game: the engine's lines are Ra6# and three mates in 2.
    const fen = 'k7/2K5/3R4/1pP5/1P6/8/8/8 w - - 35 94';
    for (const elo of [1400, 2000, 2600]) {
      const bot = new BotPlayer(botEngine, { rng: mulberry32(elo), thinkDelay: false });
      await bot.newGame(elo);
      for (let i = 0; i < 8; i++) expect((await bot.move(fen, elo, []))!.uci).toBe('d6a6');
    }
  }, 60_000);

  it.each([
    ['K+Q v K', KQK, 700],
    ['K+R v K', KRK, 1000],
    ['K+R v K', KRK, 1800],
  ])('%s at %i: mates within the 50-move rule', async (_name, start, elo) => {
    const r = await play(start, elo, elo);
    expect(r.end).toBe('bot mates');
    expect(r.plies).toBeLessThanOrEqual(100);
  }, 120_000);
});
