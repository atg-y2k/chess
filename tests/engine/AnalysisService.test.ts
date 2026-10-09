import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { AnalysisService, LIVE_NODES, defaultEnsureNodes } from '../../src/engine/AnalysisService';
import { StockfishEngine } from '../../src/engine/StockfishEngine';
import type { AnalysisResult, ChessEngine, PvLine, SearchOptions } from '../../src/engine/types';
import { createNodeTransport, type NodeTransport } from '../helpers/nodeTransport';

const FENS = {
  start: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  italian: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
  middle: 'r2q1rk1/1b1nbppp/p2ppn2/1p6/3NP3/1BN1BP2/PPPQ2PP/2KR3R w - - 0 12',
  afterE4: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  qgd: 'r1bq1rk1/pppnbppp/4pn2/3p2B1/2PP4/2N1PN2/PP3PPP/R2QKB1R w KQ - 1 7',
  sicilian: 'r1bqkb1r/pp2pppp/2np1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 2 6',
  endgame: '8/5pk1/6p1/8/2R5/6P1/r4P1P/6K1 w - - 0 40',
  mated: '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1',
  twoMoves: 'k7/8/2K5/8/8/8/8/7R b - - 0 1',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function legalIn(fen: string, uci: string | null | undefined): boolean {
  if (!uci) return false;
  try {
    new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for condition');
    await sleep(10);
  }
}

describe('AnalysisService (real engine)', () => {
  let engine: StockfishEngine;
  const out: string[] = [];
  const gos = () => out.filter((l) => l.startsWith('go')).length;
  let svc: AnalysisService;

  beforeAll(async () => {
    engine = new StockfishEngine(createNodeTransport, {
      hashMb: 16,
      showWdl: true,
      onLine: (line, dir) => dir === 'out' && out.push(line),
    });
    await engine.init();
  });
  afterAll(() => engine.terminate());
  beforeEach(() => {
    svc = new AnalysisService(engine, { liveDepth: 12, liveMultiPv: 3 });
  });
  afterEach(() => {
    svc.watch(null);
    svc.cancelAll();
  });

  it('ensure() searches once and then answers from the cache (by fenKey)', async () => {
    const r = await svc.ensure(FENS.italian, { minDepth: 10, multiPv: 2 });
    expect(r.done).toBe(true);
    expect(r.depth).toBeGreaterThanOrEqual(10);
    expect(r.lines).toHaveLength(2);
    expect(legalIn(FENS.italian, r.bestMove)).toBe(true);
    const n = gos();
    const again = await svc.ensure(FENS.italian, { minDepth: 8, multiPv: 1 });
    expect(again.depth).toBe(r.depth);
    // Same position with other move counters: still a cache hit, labelled with the caller's FEN.
    const otherCounters = FENS.italian.replace('3 3', '0 9');
    const hit = await svc.ensure(otherCounters, { minDepth: 10, multiPv: 2 });
    expect(hit.fen).toBe(otherCounters);
    expect(gos()).toBe(n);
    // Wider request => new search.
    const wide = await svc.ensure(FENS.italian, { minDepth: 10, multiPv: 3 });
    expect(wide.lines).toHaveLength(3);
    expect(gos()).toBe(n + 1);
    expect(svc.get(FENS.italian)!.lines).toHaveLength(3);
    expect(svc.get(FENS.middle)).toBeUndefined();
  });

  it('accepts fewer lines than multiPv when the position has fewer legal moves', async () => {
    const r = await svc.ensure(FENS.twoMoves, { minDepth: 8, multiPv: 3 });
    expect(r.lines).toHaveLength(2);
    const n = gos();
    await svc.ensure(FENS.twoMoves, { minDepth: 8, multiPv: 3 });
    expect(gos()).toBe(n);
  });

  it('dedupes concurrent requests and runs them FIFO', async () => {
    const n = gos();
    const order: string[] = [];
    const a = svc.ensure(FENS.qgd, { minDepth: 10 }).then((r) => (order.push('qgd'), r));
    const b = svc.ensure(FENS.sicilian, { minDepth: 8 }).then((r) => (order.push('sic'), r));
    const b2 = svc.ensure(FENS.sicilian, { minDepth: 10, multiPv: 2 }).then((r) => (order.push('sic2'), r));
    const a2 = svc.ensure(FENS.qgd, { minDepth: 9 }).then((r) => (order.push('qgd2'), r));
    const [ra, rb, rb2, ra2] = await Promise.all([a, b, b2, a2]);
    expect(gos() - n).toBe(2); // one search per position; the second sicilian request upgraded the queued job
    expect(ra.depth).toBeGreaterThanOrEqual(10);
    expect(ra2.depth).toBeGreaterThanOrEqual(9);
    expect(rb.depth).toBeGreaterThanOrEqual(8);
    expect(rb2.lines).toHaveLength(2);
    expect(order.indexOf('qgd')).toBeLessThan(order.indexOf('sic2'));
  });

  it('watch() streams throttled, monotonic updates and stops at liveDepth', async () => {
    const updates: AnalysisResult[] = [];
    svc.subscribe((r) => updates.push(r));
    const t0 = Date.now();
    svc.watch(FENS.middle);
    await until(() => updates.some((u) => u.done));
    const elapsed = Date.now() - t0;
    expect(updates.every((u) => u.fen === FENS.middle && u.lines.length === 3)).toBe(true);
    expect(updates.every((u, i) => i === 0 || u.depth >= updates[i - 1].depth)).toBe(true);
    expect(updates.at(-1)!.depth).toBe(12);
    // Throttled to ~120 ms (+1 immediate first update, +1 flushed final update).
    expect(updates.length).toBeLessThanOrEqual(Math.ceil(elapsed / 120) + 2);
    const n = gos();
    await sleep(100);
    expect(gos()).toBe(n); // no further searching once liveDepth is reached
  });

  it('emits the cached result immediately when the target changes back', async () => {
    const updates: AnalysisResult[] = [];
    svc.subscribe((r) => updates.push(r));
    svc.watch(FENS.start);
    await until(() => updates.some((u) => u.done && u.fen === FENS.start));
    svc.watch(FENS.afterE4);
    await until(() => updates.some((u) => u.fen === FENS.afterE4));
    const before = updates.length;
    svc.watch(FENS.start);
    expect(updates.length).toBe(before + 1); // synchronous, from the cache
    expect(updates.at(-1)).toMatchObject({ fen: FENS.start, depth: 12 });
    svc.watch(null);
  });

  it('ensure() pre-empts live analysis, which then resumes', async () => {
    const updates: AnalysisResult[] = [];
    svc.subscribe((r) => updates.push(r));
    svc.watch(FENS.endgame);
    await until(() => updates.some((u) => u.fen === FENS.endgame));
    const r = await svc.ensure(FENS.afterE4, { minDepth: 11, multiPv: 2 });
    expect(r.depth).toBeGreaterThanOrEqual(11);
    expect(r.lines.every((l) => legalIn(FENS.afterE4, l.pv[0]))).toBe(true);
    await until(() => updates.some((u) => u.fen === FENS.endgame && u.done));
    const end = updates.filter((u) => u.fen === FENS.endgame);
    expect(end.every((u, i) => i === 0 || u.depth >= end[i - 1].depth)).toBe(true);
    expect(end.every((u) => u.lines.every((l) => legalIn(FENS.endgame, l.pv[0])))).toBe(true);
    expect(end.at(-1)!.depth).toBe(12);
    svc.watch(null);
  });

  it('ensure() for the watched position joins the live search instead of restarting', async () => {
    const fen = 'r1bqkb1r/pp3ppp/2nppn2/8/3NP3/2N1B3/PPP2PPP/R2QKB1R w KQkq - 0 7';
    const updates: AnalysisResult[] = [];
    svc.subscribe((u) => updates.push(u));
    svc.watch(fen);
    await until(() => updates.length > 0); // live search is running
    const n = gos();
    // A node budget as large as the live search's (a smaller one pre-empts it, see below).
    const r = await svc.ensure(fen, { minDepth: 9, multiPv: 2, maxNodes: LIVE_NODES });
    expect(r.depth).toBeGreaterThanOrEqual(9);
    expect(r.lines.length).toBeGreaterThanOrEqual(2);
    expect(gos()).toBe(n);
    svc.watch(null);
  });

  it('setPaused() holds work and resumes it', async () => {
    const fen = 'rnbqkb1r/pp2pppp/3p1n2/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq - 1 5';
    let resolved = false;
    const p = svc.ensure(fen, { minDepth: 11, multiPv: 2 }).then((r) => ((resolved = true), r));
    await sleep(20);
    svc.setPaused(true);
    await sleep(300);
    expect(resolved).toBe(false);
    const n = gos();
    await sleep(100);
    expect(gos()).toBe(n); // nothing runs while paused
    svc.setPaused(false);
    const r = await p;
    expect(r.aborted).toBeFalsy();
    expect(r.depth).toBeGreaterThanOrEqual(11);
  });

  it('cancelAll() resolves pending requests with the best so far', async () => {
    const f1 = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 1 5';
    const f2 = 'rnbqkb1r/ppp2ppp/4pn2/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 0 4';
    const a = svc.ensure(f1, { minDepth: 30 });
    const b = svc.ensure(f2, { minDepth: 30 });
    await sleep(150);
    svc.cancelAll();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.aborted).toBe(true);
    expect(ra.depth).toBeGreaterThan(0); // partial from the running search
    expect(ra.lines.every((l) => legalIn(f1, l.pv[0]))).toBe(true);
    expect(rb).toMatchObject({ aborted: true, depth: 0, lines: [] });
    // The engine is free again.
    const r = await svc.ensure(FENS.start, { minDepth: 6 });
    expect(r.done || r.depth >= 6).toBe(true);
  });

  it('handles terminal and invalid positions', async () => {
    const updates: AnalysisResult[] = [];
    svc.subscribe((r) => updates.push(r));
    svc.watch(FENS.mated);
    await until(() => updates.length > 0);
    expect(updates[0]).toMatchObject({ terminal: 'checkmate', lines: [], done: true });
    const r = await svc.ensure(FENS.mated, { minDepth: 20, multiPv: 3 });
    expect(r.terminal).toBe('checkmate');
    await expect(svc.ensure('bad fen', { minDepth: 5 })).rejects.toThrow(/Invalid FEN/);
    svc.watch(null);
  });

  it('analyses positions only: the engine never gets game moves (results are shared by fenKey)', async () => {
    const mark = out.length;
    await svc.ensure(FENS.qgd, { minDepth: 6 });
    svc.watch(FENS.sicilian);
    await until(() => (svc.get(FENS.sicilian)?.depth ?? 0) >= 6);
    const positions = out.slice(mark).filter((l) => l.startsWith('position'));
    expect(positions).toContain(`position fen ${FENS.qgd}`);
    expect(positions).toContain(`position fen ${FENS.sicilian}`);
    expect(positions.some((l) => l.includes(' moves '))).toBe(false);
  });
});

/** A ChessEngine whose searches the test ends by hand (one at a time, like the real one). */
class ManualEngine implements ChessEngine {
  readonly calls: { fen: string; opts: SearchOptions; end: (r: Partial<AnalysisResult>) => void; ended: boolean }[] = [];
  failNext: Error | null = null;

  init(): Promise<void> {
    return Promise.resolve();
  }
  search(fen: string, opts: SearchOptions = {}): Promise<AnalysisResult> {
    this.stop();
    if (this.failNext) return Promise.reject(this.failNext);
    return new Promise((resolve) => {
      const call = {
        fen,
        opts,
        ended: false,
        end: (r: Partial<AnalysisResult>) => {
          if (call.ended) return;
          call.ended = true;
          resolve({ fen, depth: 0, lines: [], bestMove: null, done: false, ...r });
        },
      };
      opts.signal?.addEventListener('abort', () => call.end({ aborted: true }), { once: true });
      this.calls.push(call);
    });
  }
  stop(): void {
    this.calls.at(-1)?.end({ aborted: true });
  }
  newGame(): Promise<void> {
    return Promise.resolve();
  }
  terminate(): void {
    this.stop();
  }
}

const lines = (depth: number, n = 3): PvLine[] =>
  ['e2e4', 'd2d4', 'g1f3'].slice(0, n).map((m, i) => ({ multipv: i + 1, depth, score: { kind: 'cp', value: 30 - i }, pv: [m] }));
const partial = (depth: number, n = 3): AnalysisResult => ({ fen: FENS.start, depth, lines: lines(depth, n), bestMove: null, done: false });
const tickle = () => new Promise((r) => setTimeout(r, 0));

describe('AnalysisService after an engine restart', () => {
  it('re-issues an ensure() whose search was cut short, instead of resolving the shallow partial', async () => {
    const eng = new ManualEngine();
    const svc = new AnalysisService(eng);
    let got: AnalysisResult | null = null;
    void svc.ensure(FENS.start, { minDepth: 14, multiPv: 3 }).then((r) => (got = r));
    expect(eng.calls).toHaveLength(1);
    eng.calls[0].opts.onInfo?.(partial(7));
    eng.calls[0].end({ depth: 7, lines: lines(7), aborted: true }); // the worker crashed and respawned
    await tickle();
    expect(got).toBeNull();
    expect(eng.calls).toHaveLength(2);
    expect(eng.calls[1].opts).toMatchObject({ depth: 14, multiPv: 3 });
    eng.calls[1].end({ depth: 14, lines: lines(14), bestMove: 'e2e4', done: true });
    await tickle();
    expect(got).toMatchObject({ depth: 14, done: true });
    expect(got!.aborted).toBeFalsy();
  });

  it('retries a live search that an ensure() joined at the ensure depth, then resumes live analysis', async () => {
    const eng = new ManualEngine();
    const svc = new AnalysisService(eng, { liveDepth: 18, liveMultiPv: 3, liveNodes: defaultEnsureNodes(3) });
    svc.watch(FENS.start);
    expect(eng.calls[0].opts).toMatchObject({ depth: 18, multiPv: 3, nodes: 1_200_000 });
    let got: AnalysisResult | null = null;
    void svc.ensure(FENS.start, { minDepth: 14, multiPv: 3 }).then((r) => (got = r));
    expect(eng.calls).toHaveLength(1); // joined the live search
    eng.calls[0].end({ depth: 7, lines: lines(7), aborted: true });
    await tickle();
    expect(eng.calls).toHaveLength(2);
    expect(eng.calls[1].opts).toMatchObject({ depth: 14, multiPv: 3 });
    eng.calls[1].end({ depth: 14, lines: lines(14), bestMove: 'e2e4', done: true });
    await tickle();
    expect(got).toMatchObject({ depth: 14, done: true });
    expect(eng.calls).toHaveLength(3);
    expect(eng.calls[2].opts).toMatchObject({ depth: 18, multiPv: 3 }); // live analysis resumed
    svc.watch(null);
  });

  it('gives up after two retries and resolves the deepest result so far', async () => {
    const eng = new ManualEngine();
    const svc = new AnalysisService(eng);
    let got: AnalysisResult | null = null;
    void svc.ensure(FENS.start, { minDepth: 14, multiPv: 3 }).then((r) => (got = r));
    for (const d of [5, 9, 6]) {
      const call = eng.calls.at(-1)!;
      call.opts.onInfo?.(partial(d));
      call.end({ depth: d, lines: lines(d), aborted: true });
      await tickle();
    }
    expect(eng.calls).toHaveLength(3);
    expect(got).toMatchObject({ aborted: true, depth: 9 });
    // The service still works.
    void svc.ensure(FENS.afterE4, { minDepth: 10 });
    expect(eng.calls).toHaveLength(4);
  });

  it('resolves best-so-far when the engine breaks while retrying', async () => {
    const eng = new ManualEngine();
    const svc = new AnalysisService(eng);
    const p = svc.ensure(FENS.start, { minDepth: 14, multiPv: 3 });
    eng.calls[0].opts.onInfo?.(partial(4));
    eng.failNext = new Error('Engine "analysis" keeps crashing');
    eng.calls[0].end({ depth: 4, lines: lines(4), aborted: true });
    const r = await p;
    expect(r).toMatchObject({ aborted: true, depth: 4 });
    expect(eng.calls).toHaveLength(1);
  });

  it('does not retry searches it pre-empted itself (cancelAll)', async () => {
    const eng = new ManualEngine();
    const svc = new AnalysisService(eng);
    const p = svc.ensure(FENS.start, { minDepth: 14, multiPv: 3 });
    eng.calls[0].opts.onInfo?.(partial(6));
    svc.cancelAll();
    expect(await p).toMatchObject({ aborted: true, depth: 6 });
    await tickle();
    expect(eng.calls).toHaveLength(1);
  });

  it('real engine: a crash mid-search is followed by a full-depth search on the respawned engine', async () => {
    const transports: NodeTransport[] = [];
    const gosFor: string[] = [];
    let armed = false;
    const engine = new StockfishEngine(
      () => {
        const t = createNodeTransport();
        transports.push(t);
        return t;
      },
      {
        onLine: (line, dir) => {
          if (dir === 'out' && line.startsWith('position fen ')) gosFor.push(line.slice(13));
          if (armed && dir === 'in' && /^info depth 5 .* multipv 3 /.test(line)) {
            armed = false;
            transports.at(-1)!.kill(); // the worker dies halfway through the annotation search
          }
        },
      },
    );
    try {
      await engine.init();
      const svc = new AnalysisService(engine);
      armed = true;
      const r = await svc.ensure(FENS.italian, { minDepth: 12, multiPv: 3 });
      expect(engine.respawnCount).toBe(1);
      expect(r.aborted).toBeFalsy();
      expect(r.done).toBe(true);
      expect(r.depth).toBeGreaterThanOrEqual(12);
      expect(r.lines).toHaveLength(3);
      expect(r.lines.every((l) => legalIn(FENS.italian, l.pv[0]))).toBe(true);
      expect(gosFor.filter((f) => f === FENS.italian)).toHaveLength(2);
    } finally {
      engine.terminate();
    }
  });
});

/**
 * After 1.d4 Nf6 2.c4 d5 3.cxd5 Nxd5 4.e4 Nd7 5.exd5 c6 6.dxc6 Rg8 7.cxd7+ Kxd7 8.Qa4+ Kd6 9.Qa3+:
 * Stockfish (MultiPV 3) can reach depth 11 after about 6k nodes and depth 12 only after about 4M,
 * so an unbudgeted depth-14 search took a minute in the browser (see the real-engine test in
 * nodeBudget.test.ts). The scripted searches below use node counts from such a run.
 */
const STALL = 'r1bq1br1/pp2pppp/3k4/8/3P4/Q7/PP3PPP/RNB1KBNR b KQ - 3 9';
const stallLines = (depth: number, nodes: number): PvLine[] =>
  ['d6e6', 'd6c6', 'd6c7'].map((m, i) => ({ multipv: i + 1, depth, score: { kind: 'cp', value: -1400 - i }, nodes, pv: [m] }));
const stallPartial = (depth: number, nodes: number): AnalysisResult => ({
  fen: STALL,
  depth,
  lines: stallLines(depth, nodes),
  bestMove: null,
  done: false,
});
/** The final result of a search that ran out of nodes after finishing `depth`. */
const outOfNodes = (depth: number, nodes: number): Partial<AnalysisResult> => ({
  depth,
  lines: stallLines(depth, nodes),
  bestMove: 'd6e6',
  done: true,
});

describe('AnalysisService node budgets', () => {
  it('gives every search a node budget: 1.2M for MultiPV 3, 600k for one line, the one asked for, or none', async () => {
    const eng = new ManualEngine();
    const svc = new AnalysisService(eng);
    expect(defaultEnsureNodes(3)).toBe(1_200_000);
    expect(defaultEnsureNodes(1)).toBe(600_000);
    void svc.ensure(FENS.start, { minDepth: 14, multiPv: 3 });
    expect(eng.calls[0].opts).toMatchObject({ depth: 14, multiPv: 3, nodes: 1_200_000 });
    eng.calls[0].end({ depth: 14, lines: lines(14), bestMove: 'e2e4', done: true });
    await tickle();
    void svc.ensure(FENS.afterE4, { minDepth: 12 });
    expect(eng.calls[1].opts).toMatchObject({ depth: 12, multiPv: 1, nodes: 600_000 });
    eng.calls[1].end({ depth: 12, lines: lines(12, 1), bestMove: 'e2e4', done: true });
    await tickle();
    void svc.ensure(FENS.italian, { minDepth: 10, multiPv: 2, maxNodes: 50_000 });
    expect(eng.calls[2].opts).toMatchObject({ depth: 10, multiPv: 2, nodes: 50_000 });
    eng.calls[2].end({ depth: 10, lines: lines(10, 2), bestMove: 'e2e4', done: true });
    await tickle();
    void svc.ensure(FENS.qgd, { minDepth: 10, maxNodes: Number.POSITIVE_INFINITY });
    expect(eng.calls[3].opts.depth).toBe(10);
    expect(eng.calls[3].opts.nodes).toBeUndefined();
    eng.calls[3].end({ depth: 10, lines: lines(10, 1), bestMove: 'e2e4', done: true });
    await tickle();
    svc.watch(FENS.middle); // live analysis: depth 18, MultiPV 3, LIVE_NODES
    expect(eng.calls[4].opts).toMatchObject({ depth: 18, multiPv: 3, nodes: LIVE_NODES });
    svc.watch(null);
    // The service's own defaults.
    const tuned = new AnalysisService(eng, { liveNodes: 2_000_000, ensureNodes: (n) => n * 1000 });
    tuned.watch(FENS.sicilian);
    expect(eng.calls[5].opts).toMatchObject({ nodes: 2_000_000 });
    void tuned.ensure(FENS.endgame, { minDepth: 14, multiPv: 3 });
    expect(eng.calls[6].opts).toMatchObject({ depth: 14, nodes: 3000 });
    tuned.watch(null);
    tuned.cancelAll();
  });

  it('a search that runs out of nodes below minDepth answers the request (done, not aborted), and is remembered', async () => {
    const eng = new ManualEngine();
    const svc = new AnalysisService(eng);
    const p = svc.ensure(STALL, { minDepth: 14, multiPv: 3 });
    eng.calls[0].opts.onInfo?.(stallPartial(11, 5_518));
    eng.calls[0].end(outOfNodes(11, 5_518)); // stopped at 1.2M nodes, halfway through depth 12
    const r = await p;
    expect(r).toMatchObject({ fen: STALL, depth: 11, done: true, bestMove: 'd6e6' });
    expect(r.aborted).toBeUndefined();
    expect(r.lines).toHaveLength(3);
    // Asked again (the next move's "before" analysis, other move counters): from the cache.
    const again = await svc.ensure(STALL.replace(/ 3 9$/, ' 0 12'), { minDepth: 14, multiPv: 3 });
    expect(again).toMatchObject({ depth: 11, done: true });
    // Also for a deeper request with the same budget, and for a smaller budget.
    expect((await svc.ensure(STALL, { minDepth: 18, multiPv: 3 })).depth).toBe(11);
    expect((await svc.ensure(STALL, { minDepth: 14, multiPv: 2 })).depth).toBe(11);
    expect(eng.calls).toHaveLength(1);
    expect(svc.get(STALL)).toMatchObject({ depth: 11, done: true });
    // A larger budget does search again.
    void svc.ensure(STALL, { minDepth: 14, multiPv: 3, maxNodes: 5_000_000 });
    expect(eng.calls).toHaveLength(2);
    expect(eng.calls[1].opts).toMatchObject({ depth: 14, multiPv: 3, nodes: 5_000_000 });
    svc.cancelAll();
  });

  it('a result that took at least the budget answers at once, even a partial one of a long live search', async () => {
    const eng = new ManualEngine();
    const svc = new AnalysisService(eng);
    svc.watch(STALL);
    const live = eng.calls[0];
    live.opts.onInfo?.(stallPartial(11, 5_518));
    live.opts.onInfo?.(stallPartial(12, 4_023_437));
    const r = await svc.ensure(STALL, { minDepth: 14, multiPv: 3 });
    expect(r.depth).toBe(12); // 4M nodes >= 1.2M: as good as the request gets
    expect(eng.calls).toHaveLength(1);
    expect(live.ended).toBe(false); // the live search goes on
    svc.watch(null);
  });

  it('an ensure() with a smaller budget pre-empts the live search, which streams its partials and resumes after', async () => {
    const eng = new ManualEngine();
    const svc = new AnalysisService(eng, { throttleMs: 0 });
    const updates: AnalysisResult[] = [];
    svc.subscribe((u) => updates.push(u));
    svc.watch(STALL);
    expect(eng.calls[0].opts).toMatchObject({ depth: 18, multiPv: 3, nodes: LIVE_NODES });
    eng.calls[0].opts.onInfo?.(stallPartial(9, 3_423));
    let got: AnalysisResult | null = null;
    void svc.ensure(STALL, { minDepth: 14, multiPv: 3 }).then((r) => (got = r));
    // Joining the live search (up to 5M nodes) would wait past the 1.2M budget: it runs its own.
    expect(eng.calls).toHaveLength(2);
    expect(eng.calls[0].ended).toBe(true);
    expect(eng.calls[1].opts).toMatchObject({ depth: 14, multiPv: 3, nodes: 1_200_000 });
    eng.calls[1].opts.onInfo?.(stallPartial(11, 5_518));
    expect(updates.at(-1)).toMatchObject({ depth: 11, done: false }); // the eval bar follows it
    eng.calls[1].end(outOfNodes(11, 5_518));
    await tickle();
    expect(got).toMatchObject({ depth: 11, done: true });
    // Live analysis resumes with its own budget and streams again.
    expect(eng.calls).toHaveLength(3);
    expect(eng.calls[2].opts).toMatchObject({ depth: 18, multiPv: 3, nodes: LIVE_NODES });
    eng.calls[2].opts.onInfo?.(stallPartial(12, 4_023_437));
    expect(updates.at(-1)).toMatchObject({ depth: 12, done: false });
    // It runs out of nodes at depth 13: finished, not restarted.
    eng.calls[2].end(outOfNodes(13, 4_066_737));
    await tickle();
    expect(updates.at(-1)).toMatchObject({ depth: 13, done: true });
    expect(eng.calls).toHaveLength(3);
    // Coming back to the position shows that result without searching it again.
    svc.watch(FENS.start);
    svc.watch(STALL);
    expect(updates.at(-1)).toMatchObject({ fen: STALL, depth: 13 });
    expect(eng.calls.filter((c) => c.fen === STALL)).toHaveLength(3);
    svc.watch(null);
  });

  it('a request that joined a search with a smaller budget is searched again with its own when that one runs out', async () => {
    const eng = new ManualEngine();
    const svc = new AnalysisService(eng, { liveNodes: 500_000 });
    svc.watch(STALL);
    let got: AnalysisResult | null = null;
    void svc.ensure(STALL, { minDepth: 14, multiPv: 3 }).then((r) => (got = r));
    expect(eng.calls).toHaveLength(1); // joined: the live search never runs past 1.2M nodes
    eng.calls[0].end(outOfNodes(10, 4_386)); // ... but it ran out at 500k, below depth 14
    await tickle();
    expect(got).toBeNull();
    expect(eng.calls).toHaveLength(2);
    expect(eng.calls[1].opts).toMatchObject({ depth: 14, multiPv: 3, nodes: 1_200_000 });
    eng.calls[1].end(outOfNodes(11, 5_518));
    await tickle();
    expect(got).toMatchObject({ depth: 11, done: true });
    expect(eng.calls).toHaveLength(2); // and that also covers the live analysis (500k nodes)
    svc.watch(null);
  });

  it('answers from the deepest result once one is good enough (a later search on a warm hash may need fewer nodes)', async () => {
    const eng = new ManualEngine();
    const svc = new AnalysisService(eng);
    void svc.ensure(STALL, { minDepth: 14, multiPv: 3 });
    eng.calls[0].end(outOfNodes(11, 5_518)); // spent 1.2M
    await tickle();
    void svc.ensure(STALL, { minDepth: 13, multiPv: 3, maxNodes: 2_000_000 });
    expect(eng.calls).toHaveLength(2);
    eng.calls[1].end({ ...outOfNodes(13, 900_000) }); // depth 13 reached after 900k nodes
    await tickle();
    const r = await svc.ensure(STALL, { minDepth: 14, multiPv: 3 });
    expect(r.depth).toBe(13);
    expect(eng.calls).toHaveLength(2);
  });
});

describe('AnalysisService: withdrawn requests (EnsureOptions.signal)', () => {
  it('a queued request is dropped, the running one gives way, and another request on it keeps it', async () => {
    const eng = new ManualEngine();
    const svc = new AnalysisService(eng);
    const ctl = new AbortController();
    const running = svc.ensure(FENS.italian, { minDepth: 14, multiPv: 3, signal: ctl.signal });
    const queued = svc.ensure(FENS.qgd, { minDepth: 14, multiPv: 3, signal: ctl.signal });
    let game: AnalysisResult | null = null;
    void svc.ensure(FENS.sicilian, { minDepth: 14, multiPv: 3 }).then((r) => (game = r));
    expect(eng.calls.map((c) => c.fen)).toEqual([FENS.italian]);
    eng.calls[0].opts.onInfo?.({ ...partial(6), fen: FENS.italian });

    ctl.abort();
    expect(await running).toMatchObject({ aborted: true, depth: 6 });
    expect(await queued).toMatchObject({ aborted: true, depth: 0 });
    // The withdrawn search stopped, and the next request (not the withdrawn one) runs at once.
    expect(eng.calls[0].ended).toBe(true);
    await tickle();
    expect(eng.calls.map((c) => c.fen)).toEqual([FENS.italian, FENS.sicilian]);
    eng.calls[1].end({ depth: 14, lines: lines(14), bestMove: 'e2e4', done: true });
    await tickle();
    expect(game).toMatchObject({ depth: 14, done: true });

    // Two requests share a search: withdrawing one leaves the other's.
    const mine = new AbortController();
    const a = svc.ensure(FENS.middle, { minDepth: 14, multiPv: 3, signal: mine.signal });
    let b: AnalysisResult | null = null;
    void svc.ensure(FENS.middle, { minDepth: 14, multiPv: 3 }).then((r) => (b = r));
    expect(eng.calls).toHaveLength(3);
    mine.abort();
    expect(await a).toMatchObject({ aborted: true });
    expect(eng.calls[2].ended).toBe(false);
    eng.calls[2].end({ depth: 14, lines: lines(14), bestMove: 'e2e4', done: true });
    await tickle();
    expect(b).toMatchObject({ depth: 14, done: true });
    // Already aborted: answered at once, with no search.
    expect(await svc.ensure(FENS.endgame, { minDepth: 14, signal: mine.signal })).toMatchObject({ aborted: true });
    expect(eng.calls).toHaveLength(3);
  });

  it('a withdrawn search of the watched position goes on as its live analysis', async () => {
    const eng = new ManualEngine();
    const svc = new AnalysisService(eng, { liveDepth: 18, liveMultiPv: 3 });
    const ctl = new AbortController();
    const p = svc.ensure(FENS.italian, { minDepth: 14, multiPv: 3, signal: ctl.signal });
    svc.watch(FENS.italian); // the ensure search covers it for now
    expect(eng.calls).toHaveLength(1);
    ctl.abort();
    expect(await p).toMatchObject({ aborted: true });
    expect(eng.calls[0].ended).toBe(false); // still searching, now for the eval bar
    const updates: AnalysisResult[] = [];
    svc.subscribe((r) => updates.push(r));
    eng.calls[0].end({ depth: 14, lines: lines(14), bestMove: 'e2e4', done: true });
    await tickle();
    expect(updates.at(-1)).toMatchObject({ depth: 14 });
    svc.watch(null);
  });
});
