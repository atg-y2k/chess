import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { BotPlayer } from '../../src/bot/BotPlayer';
import { bookMoves, loadOpenings } from '../../src/bot/book';
import { mulberry32 } from '../../src/bot/strength';
import type { AnalysisResult, ChessEngine, PvLine, SearchOptions } from '../../src/engine/types';

const START = new Chess().fen();
/** Out-of-book middlegame (random-ish position), White to move. */
const MIDDLEGAME = 'r2q1rk1/pp2bppp/2n1bn2/3p4/3P4/2NBBN2/PP3PPP/R2Q1RK1 w - - 4 11';
/** White king in check with exactly one legal move (Kxb2). */
const FORCED = 'k7/8/8/8/8/8/1r6/K1r5 w - - 0 1';
const MATED = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
const VALUES: Record<string, number> = { p: 100, n: 300, b: 310, r: 500, q: 900, k: 0 };

/** Fake ChessEngine: scores each legal move by material after it (+ a tiny deterministic tie-break). */
class FakeEngine implements ChessEngine {
  searches: { fen: string; opts: SearchOptions }[] = [];
  newGames = 0;
  delayMs = 0;
  failWith: Error | null = null;
  /** Number of upcoming searches that resolve as pre-empted (aborted without our signal). */
  preemptNext = 0;

  init(): Promise<void> {
    return Promise.resolve();
  }

  async search(fen: string, opts: SearchOptions = {}): Promise<AnalysisResult> {
    this.searches.push({ fen, opts });
    if (this.failWith) throw this.failWith;
    if (this.delayMs) {
      const aborted = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), this.delayMs);
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          resolve(true);
        });
      });
      if (aborted) return { fen, depth: 3, lines: [], bestMove: null, done: false, aborted: true };
    }
    if (this.preemptNext > 0) {
      this.preemptNext--;
      return { fen, depth: 0, lines: [], bestMove: null, done: false, aborted: true };
    }
    const chess = new Chess(fen);
    const me = chess.turn();
    const scored = chess.moves({ verbose: true }).map((m, i) => {
      chess.move(m);
      let cp = 0;
      for (const row of chess.board()) for (const sq of row) if (sq) cp += (sq.color === me ? 1 : -1) * VALUES[sq.type];
      chess.undo();
      return { uci: m.from + m.to + (m.promotion ?? ''), cp: cp + (i % 7) };
    });
    scored.sort((a, b) => b.cp - a.cp);
    const lines: PvLine[] = scored
      .slice(0, opts.multiPv ?? 1)
      .map((s, i) => ({ multipv: i + 1, depth: opts.depth ?? 10, score: { kind: 'cp', value: s.cp }, pv: [s.uci] }));
    return { fen, depth: opts.depth ?? 10, lines, bestMove: lines[0]?.pv[0] ?? null, done: true };
  }

  stop(): void {}

  newGame(): Promise<void> {
    this.newGames++;
    return Promise.resolve();
  }

  terminate(): void {}
}

const isLegal = (fen: string, uci: string) =>
  new Chess(fen).moves({ verbose: true }).some((m) => m.from + m.to + (m.promotion ?? '') === uci);

describe('BotPlayer', () => {
  it('opens from the book (no engine search) and loads the book in newGame', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const engine = new FakeEngine();
      const bot = new BotPlayer(engine, { rng: mulberry32(seed), thinkDelay: false });
      await bot.newGame(1600);
      expect(engine.newGames).toBe(1);
      const m = await bot.move(START, 1600, []);
      expect(m?.source).toBe('book');
      expect(bookMoves(START).map((b) => b.uci)).toContain(m!.uci);
      expect(engine.searches).toHaveLength(0);
    }
  });

  it('answers from the book as Black, then switches to the engine once out of book', async () => {
    let book = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const engine = new FakeEngine();
      const bot = new BotPlayer(engine, { rng: mulberry32(seed), thinkDelay: false });
      await bot.newGame(2800);
      const after = new Chess();
      after.move('e4');
      const m = (await bot.move(after.fen(), 2800, ['e2e4']))!;
      if (m.source === 'book') {
        book++;
        expect(bookMoves(after.fen()).map((b) => b.uci)).toContain(m.uci);
      }
      const mid = (await bot.move(MIDDLEGAME, 2800, Array(20).fill('e2e4')))!;
      expect(mid.source).toBe('engine');
      expect(isLegal(MIDDLEGAME, mid.uci)).toBe(true);
    }
    expect(book).toBeGreaterThanOrEqual(18); // leaveProb at 2800 is ~1.5% per move
  });

  it('searches at full strength with the plan limits for each band', async () => {
    const cases: [number, number][] = [
      [400, 256],
      [1000, 256],
      [1800, 4],
      [2600, 4],
      [3200, 1],
    ];
    for (const [elo, multiPv] of cases) {
      const engine = new FakeEngine();
      const bot = new BotPlayer(engine, { rng: mulberry32(elo), thinkDelay: false });
      await bot.newGame(elo);
      const m = (await bot.move(MIDDLEGAME, elo, Array(30).fill('e2e4')))!;
      expect(isLegal(MIDDLEGAME, m.uci)).toBe(true);
      expect(engine.searches).toHaveLength(1);
      const o = engine.searches[0].opts;
      expect(o.multiPv).toBe(multiPv);
      expect(o.limitStrengthElo).toBeUndefined();
      expect(o.skillLevel).toBeUndefined();
      expect(o.movetime).toBeUndefined();
      expect(o.nodes).toBeGreaterThan(0);
    }
  });

  it('plays forced moves immediately without searching', async () => {
    const engine = new FakeEngine();
    const bot = new BotPlayer(engine, { rng: mulberry32(3) });
    await bot.newGame(2000);
    const m = await bot.move(FORCED, 2000, Array(40).fill('e2e4'));
    expect(m).toMatchObject({ uci: 'a1b2', source: 'forced' });
    expect(m!.thinkMs).toBeGreaterThanOrEqual(240);
    expect(m!.thinkMs).toBeLessThan(700);
    expect(engine.searches).toHaveLength(0);
  });

  it('returns null without legal moves or for an already-aborted signal', async () => {
    const engine = new FakeEngine();
    const bot = new BotPlayer(engine, { thinkDelay: false });
    await bot.newGame(800);
    expect(await bot.move(MATED, 800, ['f2f3', 'e7e5', 'g2g4', 'd8h4'])).toBeNull();
    const ac = new AbortController();
    ac.abort();
    expect(await bot.move(MIDDLEGAME, 800, [], ac.signal)).toBeNull();
    expect(engine.searches).toHaveLength(0);
  });

  it('aborts during the engine search', async () => {
    const engine = new FakeEngine();
    engine.delayMs = 2000;
    const bot = new BotPlayer(engine, { rng: mulberry32(1) });
    await bot.newGame(1500);
    const ac = new AbortController();
    const t0 = Date.now();
    const p = bot.move(MIDDLEGAME, 1500, Array(30).fill('e2e4'), ac.signal);
    setTimeout(() => ac.abort(), 30);
    expect(await p).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(engine.searches).toHaveLength(1); // no retry after our own abort
  });

  it('aborts during the think delay', async () => {
    const engine = new FakeEngine();
    const bot = new BotPlayer(engine, { rng: mulberry32(2) });
    await bot.newGame(3200);
    const ac = new AbortController();
    const t0 = Date.now();
    const p = bot.move(MIDDLEGAME, 3200, Array(30).fill('e2e4'), ac.signal);
    setTimeout(() => ac.abort(), 50);
    expect(await p).toBeNull();
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it('waits a human-like think time including the search', async () => {
    const engine = new FakeEngine();
    const bot = new BotPlayer(engine, { rng: mulberry32(4) });
    await bot.newGame(100);
    const m = (await bot.move(MIDDLEGAME, 100, Array(30).fill('e2e4')))!;
    expect(m.source).toBe('engine');
    expect(m.thinkMs).toBeGreaterThanOrEqual(295);
    expect(m.thinkMs).toBeLessThan(4200);
  });

  it('is deterministic for a seeded rng (self-play)', async () => {
    const game = async (seed: number) => {
      const engine = new FakeEngine();
      const white = new BotPlayer(engine, { rng: mulberry32(seed), thinkDelay: false });
      const black = new BotPlayer(engine, { rng: mulberry32(seed + 1), thinkDelay: false });
      await white.newGame(700);
      await black.newGame(1900);
      const chess = new Chess();
      const history: string[] = [];
      const sources: string[] = [];
      for (let ply = 0; ply < 40 && !chess.isGameOver(); ply++) {
        const bot = chess.turn() === 'w' ? white : black;
        const m = (await bot.move(chess.fen(), chess.turn() === 'w' ? 700 : 1900, history))!;
        chess.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
        history.push(m.uci);
        sources.push(m.source);
      }
      return { history, sources };
    };
    const a = await game(10);
    const b = await game(10);
    expect(a).toEqual(b);
    expect(a.sources[0]).toBe('book');
    expect(a.sources).toContain('engine');
    expect((await game(11)).history).not.toEqual(a.history);
  });

  it('retries once when pre-empted, and falls back to a legal move if the engine fails', async () => {
    const engine = new FakeEngine();
    engine.preemptNext = 1;
    const bot = new BotPlayer(engine, { rng: mulberry32(9), thinkDelay: false });
    await bot.newGame(3200);
    const m = (await bot.move(MIDDLEGAME, 3200, Array(30).fill('e2e4')))!;
    expect(engine.searches).toHaveLength(2);
    expect(m.source).toBe('engine');
    const best = (await new FakeEngine().search(MIDDLEGAME, { multiPv: 1 })).bestMove;
    expect(m.uci).toBe(best);

    const broken = new FakeEngine();
    broken.failWith = new Error('engine is dead');
    const bot2 = new BotPlayer(broken, { rng: mulberry32(9), thinkDelay: false });
    await bot2.newGame(2400);
    const warn = console.warn;
    console.warn = () => {};
    try {
      const f = (await bot2.move(MIDDLEGAME, 2400, Array(30).fill('e2e4')))!;
      expect(isLegal(MIDDLEGAME, f.uci)).toBe(true);
    } finally {
      console.warn = warn;
    }
  });

  it('works without newGame (book loads lazily) and uses the book when loaded', async () => {
    await loadOpenings();
    const engine = new FakeEngine();
    const bot = new BotPlayer(engine, { rng: mulberry32(5), thinkDelay: false });
    const m = (await bot.move(START, 1200, []))!;
    expect(m.source).toBe('book');
  });
});
