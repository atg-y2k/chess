import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { StockfishEngine, inspectPosition } from '../../src/engine/StockfishEngine';
import { EngineLoadError, engineFailureKind } from '../../src/engine/errors';
import type { AnalysisResult, DownloadProgress, EngineTransport } from '../../src/engine/types';
import { createNodeTransport, type NodeTransport } from '../helpers/nodeTransport';

const FENS = {
  start: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  italian: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
  middle: 'r2q1rk1/1b1nbppp/p2ppn2/1p6/3NP3/1BN1BP2/PPPQ2PP/2KR3R w - - 0 12',
  afterE4: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  twoMoves: 'k7/8/2K5/8/8/8/8/7R b - - 0 1',
  mateIn2: 'r1b2k1r/ppp1bppp/8/1B1Q4/5q2/2P5/PPP2PPP/R3R1K1 w - - 1 1',
  mated: '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1',
  stalemate: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** FEN after playing UCI `moves` from `start`. */
function play(start: string, moves: string[]): string {
  const c = new Chess(start);
  for (const m of moves) c.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
  return c.fen();
}

function legalIn(fen: string, uci: string | null | undefined): boolean {
  if (!uci) return false;
  try {
    new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return true;
  } catch {
    return false;
  }
}

/** Every reported line starts with a move that is legal in `fen`. */
function linesBelongTo(r: AnalysisResult, fen: string): boolean {
  return r.lines.every((l) => legalIn(fen, l.pv[0]));
}

interface Tapped {
  engine: StockfishEngine;
  log: { dir: 'in' | 'out'; line: string }[];
}

function tappedEngine(opts: ConstructorParameters<typeof StockfishEngine>[1] = {}, factory = createNodeTransport): Tapped {
  const log: Tapped['log'] = [];
  const engine = new StockfishEngine(factory, { ...opts, onLine: (line, dir) => log.push({ dir, line }) });
  return { engine, log };
}

describe('StockfishEngine (real engine)', () => {
  let t: Tapped;
  beforeAll(async () => {
    t = tappedEngine({ hashMb: 16, showWdl: true, name: 'test' });
    await t.engine.init();
  });
  afterAll(() => t.engine.terminate());

  it('init is idempotent and applies default options', async () => {
    await t.engine.init();
    const out = t.log.filter((l) => l.dir === 'out').map((l) => l.line);
    expect(out.filter((l) => l === 'uci')).toHaveLength(1);
    expect(out).toContain('setoption name Hash value 16');
    expect(out).toContain('setoption name UCI_ShowWDL value true');
  });

  it('runs a depth-limited search', async () => {
    const infos: AnalysisResult[] = [];
    const r = await t.engine.search(FENS.start, { depth: 10, onInfo: (p) => infos.push(p) });
    expect(r.done).toBe(true);
    expect(r.aborted).toBeFalsy();
    expect(r.depth).toBe(10);
    expect(r.lines).toHaveLength(1);
    expect(legalIn(FENS.start, r.bestMove)).toBe(true);
    expect(r.lines[0].wdl).toHaveLength(3);
    expect(r.lines[0].score.kind).toBe('cp');
    expect(infos.length).toBeGreaterThan(3);
    expect(infos.every((p, i) => i === 0 || p.depth >= infos[i - 1].depth)).toBe(true);
    expect(infos.every((p) => !p.done && p.bestMove === null && p.fen === FENS.start)).toBe(true);
  });

  it('returns ordered, complete MultiPV sets (also while streaming)', async () => {
    const infos: AnalysisResult[] = [];
    const r = await t.engine.search(FENS.italian, { depth: 12, multiPv: 3, onInfo: (p) => infos.push(p) });
    expect(r.lines.map((l) => l.multipv)).toEqual([1, 2, 3]);
    expect(new Set(r.lines.map((l) => l.depth))).toEqual(new Set([12]));
    expect(new Set(r.lines.map((l) => l.pv[0])).size).toBe(3);
    expect(r.lines.every((l) => !l.bound)).toBe(true);
    const cps = r.lines.map((l) => (l.score.kind === 'cp' ? l.score.value : 0));
    expect(cps[0]).toBeGreaterThanOrEqual(cps[1]);
    expect(cps[1]).toBeGreaterThanOrEqual(cps[2]);
    expect(linesBelongTo(r, FENS.italian)).toBe(true);
    for (const p of infos) {
      expect(p.lines).toHaveLength(3);
      expect(p.lines.every((l) => l.depth === p.depth && !l.bound)).toBe(true);
    }
  });

  it('caps the line count at the number of legal moves', async () => {
    const r = await t.engine.search(FENS.twoMoves, { depth: 8, multiPv: 3 });
    expect(r.lines).toHaveLength(2);
    expect(r.done).toBe(true);
  });

  it('finds a mate in 2', async () => {
    const r = await t.engine.search(FENS.mateIn2, { depth: 10 });
    expect(r.lines[0].score).toEqual({ kind: 'mate', value: 2 });
    expect(r.bestMove).toBe('d5d8');
  });

  it('answers positions without legal moves without the engine', async () => {
    const gos = t.log.filter((l) => l.dir === 'out' && l.line.startsWith('go')).length;
    const mated = await t.engine.search(FENS.mated, { depth: 10 });
    expect(mated).toEqual({ fen: FENS.mated, depth: 0, lines: [], bestMove: null, done: true, terminal: 'checkmate' });
    const stale = await t.engine.search(FENS.stalemate);
    expect(stale.terminal).toBe('stalemate');
    expect(t.log.filter((l) => l.dir === 'out' && l.line.startsWith('go')).length).toBe(gos);
  });

  it('rejects invalid FENs and stays usable', async () => {
    await expect(t.engine.search('xyz')).rejects.toThrow(/Invalid FEN/);
    await expect(t.engine.search('8/8/8/8/8/8/8/8 w - - 0 1')).rejects.toThrow(/Invalid FEN/);
    // Legal-looking but the side not to move is in check (Stockfish would print CRITICAL ERROR).
    await expect(t.engine.search('7k/7R/8/8/8/8/8/K7 w - - 0 1')).rejects.toThrow(/in check/);
    const r = await t.engine.search(FENS.start, { depth: 6 });
    expect(r.done).toBe(true);
    expect(t.engine.respawnCount).toBe(0);
  });

  it('pre-emption: the old search resolves aborted, the new one gets only its own lines', async () => {
    const aInfos: AnalysisResult[] = [];
    let preempted = false;
    const a = t.engine.search(FENS.middle, {
      depth: 40,
      multiPv: 2,
      onInfo: (p) => {
        if (preempted) throw new Error('onInfo after pre-emption');
        aInfos.push(p);
      },
    });
    await sleep(250);
    preempted = true;
    const bInfos: AnalysisResult[] = [];
    const b = t.engine.search(FENS.afterE4, { depth: 10, onInfo: (p) => bInfos.push(p) });
    const ra = await a;
    expect(ra.aborted).toBe(true);
    expect(ra.done).toBe(false);
    expect(ra.bestMove).toBeNull();
    expect(ra.lines.length).toBe(2); // partial result from the last complete batch
    expect(linesBelongTo(ra, FENS.middle)).toBe(true);
    const rb = await b;
    expect(rb.done).toBe(true);
    expect(legalIn(FENS.afterE4, rb.bestMove)).toBe(true);
    expect(linesBelongTo(rb, FENS.afterE4)).toBe(true);
    expect(bInfos.every((p) => linesBelongTo(p, FENS.afterE4))).toBe(true);
  });

  it('never lets a stale bestmove resolve the next search (rapid pre-emption + natural-finish races)', async () => {
    const fens = [FENS.middle, FENS.afterE4, FENS.italian, FENS.start];
    const pending: { fen: string; p: Promise<AnalysisResult> }[] = [];
    for (let i = 0; i < 24; i++) {
      const fen = fens[i % fens.length];
      // Mix tiny searches (finish before the next request => stop arrives after bestmove) with long ones.
      pending.push({ fen, p: t.engine.search(fen, { depth: i % 3 === 0 ? 2 : 30, multiPv: 1 + (i % 2) }) });
      await sleep(i % 4 === 0 ? 0 : 5 + (i % 3) * 7);
    }
    const last = t.engine.search(FENS.italian, { depth: 9 });
    const results = await Promise.all(pending.map((x) => x.p));
    results.forEach((r, i) => {
      expect(linesBelongTo(r, pending[i].fen)).toBe(true);
      if (r.done) expect(legalIn(pending[i].fen, r.bestMove)).toBe(true);
      else expect(r.aborted).toBe(true);
    });
    expect(results.filter((r) => r.aborted).length).toBeGreaterThan(10);
    const rl = await last;
    expect(rl.done).toBe(true);
    expect(rl.depth).toBe(9);
    expect(legalIn(FENS.italian, rl.bestMove)).toBe(true);
    // Single flight: never two `go` commands without a bestmove in between.
    let inFlight = 0;
    for (const l of t.log) {
      if (l.dir === 'out' && l.line.startsWith('go')) inFlight++;
      if (l.dir === 'in' && l.line.startsWith('bestmove')) inFlight--;
      expect(inFlight).toBeLessThanOrEqual(1);
      expect(inFlight).toBeGreaterThanOrEqual(0);
    }
  });

  it('stop() then an immediate new search', async () => {
    const a = t.engine.search(FENS.middle, { depth: 40 });
    await sleep(120);
    t.engine.stop();
    const b = t.engine.search(FENS.afterE4, { depth: 8 });
    expect((await a).aborted).toBe(true);
    const rb = await b;
    expect(rb.done).toBe(true);
    expect(legalIn(FENS.afterE4, rb.bestMove)).toBe(true);
  });

  it('AbortSignal aborts the search; a pre-aborted signal does nothing', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const a = t.engine.search(FENS.middle, { depth: 40, signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    const ra = await a;
    expect(ra.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    const pre = new AbortController();
    pre.abort();
    const rp = await t.engine.search(FENS.start, { depth: 5, signal: pre.signal });
    expect(rp).toMatchObject({ aborted: true, lines: [], done: false });
    const rn = await t.engine.search(FENS.start, { depth: 6 });
    expect(rn.done).toBe(true);
  });

  it('sends only changed options, and only while idle', async () => {
    const mark = t.log.length;
    await t.engine.search(FENS.start, { depth: 4, multiPv: 3 });
    await t.engine.search(FENS.start, { depth: 4, multiPv: 3 });
    await t.engine.search(FENS.italian, { depth: 4, skillLevel: 5 });
    await t.engine.search(FENS.italian, { depth: 4, limitStrengthElo: 1000 });
    await t.engine.search(FENS.italian, { depth: 4 });
    const out = t.log.slice(mark).filter((l) => l.dir === 'out' && l.line.startsWith('setoption')).map((l) => l.line);
    expect(out).toEqual([
      'setoption name MultiPV value 3',
      'setoption name MultiPV value 1',
      'setoption name Skill Level value 5',
      'setoption name UCI_LimitStrength value true',
      'setoption name UCI_Elo value 1320',
      'setoption name UCI_LimitStrength value false',
      'setoption name Skill Level value 20',
    ]);
    let searching = false;
    for (const l of t.log) {
      if (searching && l.dir === 'out') expect(l.line).toMatch(/^(stop|isready)$/);
      if (l.dir === 'out' && l.line.startsWith('go')) searching = true;
      if (l.dir === 'in' && l.line.startsWith('bestmove')) searching = false;
    }
  });

  it('newGame sends ucinewgame once idle', async () => {
    const a = t.engine.search(FENS.start, { depth: 8 });
    const ng = t.engine.newGame();
    await a;
    await ng;
    const idx = t.log.findLastIndex((l) => l.line === 'ucinewgame');
    expect(idx).toBeGreaterThan(-1);
    const lastBest = t.log.findLastIndex((l) => l.dir === 'in' && l.line.startsWith('bestmove'));
    expect(idx).toBeGreaterThan(lastBest);
  });

  it('sees a threefold repetition when given the game moves (the bare FEN cannot)', async () => {
    // White is a queen up. Both kings have shuffled g1-h1 / g8-h8 twice, so Kg8 now repeats the
    // position for the third time: a draw, and Black's only way to save the game.
    const start = '6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1';
    const moves = ['g1h1', 'g8h8', 'h1g1', 'h8g8', 'g1h1', 'g8h8', 'h1g1'];
    const fen = play(start, moves);
    const mark = t.log.length;
    const blind = await t.engine.search(fen, { depth: 12, multiPv: 2 });
    const seen = await t.engine.search(fen, { depth: 12, multiPv: 2, history: { startFen: start, moves } });
    expect(blind.bestMove).not.toBe('h8g8');
    expect(blind.lines[0].score.kind === 'mate' || blind.lines[0].score.value < -300).toBe(true);
    expect(seen).toMatchObject({ fen, done: true, bestMove: 'h8g8' });
    expect(seen.lines[0].score).toEqual({ kind: 'cp', value: 0 });
    expect(seen.lines[1].score.kind === 'mate' || seen.lines[1].score.value < -300).toBe(true);
    const sent = t.log.slice(mark).filter((l) => l.dir === 'out' && l.line.startsWith('position'));
    expect(sent.map((l) => l.line)).toEqual([`position fen ${fen}`, `position fen ${start} moves ${moves.join(' ')}`]);
  });

  it('sends only the moves since the last irreversible one, and the bare FEN for a history that does not fit', async () => {
    const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'];
    const mark = t.log.length;
    const respawns = t.engine.respawnCount;
    const ok = await t.engine.search(FENS.italian, { depth: 6, history: { startFen: FENS.start, moves } });
    const illegal = await t.engine.search(FENS.italian, {
      depth: 6,
      history: { startFen: FENS.start, moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c5'] },
    });
    const elsewhere = await t.engine.search(FENS.italian, { depth: 6, history: { startFen: FENS.start, moves: ['e2e4'] } });
    for (const r of [ok, illegal, elsewhere]) {
      expect(r.done).toBe(true);
      expect(legalIn(FENS.italian, r.bestMove)).toBe(true);
    }
    const sent = t.log.slice(mark).filter((l) => l.dir === 'out' && l.line.startsWith('position'));
    expect(sent.map((l) => l.line)).toEqual([
      `position fen ${play(FENS.start, moves.slice(0, 2))} moves g1f3 b8c6 f1c4`,
      `position fen ${FENS.italian}`,
      `position fen ${FENS.italian}`,
    ]);
    expect(t.engine.respawnCount).toBe(respawns);
  });
});

/** Transport wrapper for fault injection. */
function faulty(inner: NodeTransport, hooks: { mute?: () => boolean; rewrite?: (cmd: string) => string }): EngineTransport {
  return {
    post: (cmd) => inner.post(hooks.rewrite ? hooks.rewrite(cmd) : cmd),
    onLine: (cb) => inner.onLine((line) => (hooks.mute?.() ? undefined : cb(line))),
    onError: (cb) => inner.onError(cb),
    terminate: () => inner.terminate(),
  };
}

describe('StockfishEngine recovery', () => {
  it('respawns after the engine process is killed', async () => {
    const transports: NodeTransport[] = [];
    const engine = new StockfishEngine(() => {
      const tr = createNodeTransport();
      transports.push(tr);
      return tr;
    });
    try {
      await engine.init();
      const a = engine.search(FENS.middle, { depth: 40 });
      await sleep(150);
      transports[0].kill();
      const ra = await a;
      expect(ra.aborted).toBe(true);
      const rb = await engine.search(FENS.afterE4, { depth: 8 });
      expect(rb.done).toBe(true);
      expect(legalIn(FENS.afterE4, rb.bestMove)).toBe(true);
      expect(engine.respawnCount).toBe(1);
      expect(transports).toHaveLength(2);
    } finally {
      engine.terminate();
    }
  });

  it('respawns after CRITICAL ERROR output', async () => {
    let poison = false;
    const engine = new StockfishEngine(() =>
      faulty(createNodeTransport(), {
        rewrite: (cmd) => (poison && cmd.startsWith('position') ? 'position fen 8/8/8/8/8/8/8/8 w - - 0 1' : cmd),
      }),
    );
    try {
      await engine.init();
      poison = true;
      const ra = await engine.search(FENS.start, { depth: 10 });
      poison = false;
      expect(ra.aborted).toBe(true);
      const rb = await engine.search(FENS.italian, { depth: 8 });
      expect(rb.done).toBe(true);
      expect(engine.respawnCount).toBe(1);
    } finally {
      engine.terminate();
    }
  });

  it('detects a hung engine with the heartbeat and recovers', async () => {
    let mute = false;
    let spawned = 0;
    const engine = new StockfishEngine(
      () => {
        spawned++;
        return faulty(createNodeTransport(), { mute: () => mute && spawned === 1 });
      },
      { watchdog: { tickMs: 50, pingAfterMs: 200, hangMs: 400, stopTimeoutMs: 400 } },
    );
    try {
      await engine.init();
      const a = engine.search(FENS.middle, { depth: 40 });
      await sleep(100);
      mute = true; // from now on the first process "hangs" (we see no output)
      const started = Date.now();
      const ra = await a;
      expect(ra.aborted).toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
      const rb = await engine.search(FENS.afterE4, { depth: 8 });
      expect(rb.done).toBe(true);
      expect(engine.respawnCount).toBe(1);
    } finally {
      engine.terminate();
    }
  });

  it('rejects init when the engine never starts (load timeout)', async () => {
    const silent: EngineTransport = { post: () => {}, onLine: () => {}, terminate: () => {} };
    const engine = new StockfishEngine(() => silent, { loadTimeoutMs: 300, watchdog: { tickMs: 50 } });
    const search = engine.search(FENS.start);
    const err = await engine.init().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/did not start/);
    expect(engineFailureKind(err)).toBe('timeout');
    await expect(search).rejects.toThrow(/did not start/);
    await expect(engine.search(FENS.start)).rejects.toThrow();
  });

  it('terminate resolves the in-flight search as aborted and rejects later searches', async () => {
    const engine = new StockfishEngine(createNodeTransport);
    await engine.init();
    const a = engine.search(FENS.middle, { depth: 40 });
    await sleep(100);
    engine.terminate();
    expect((await a).aborted).toBe(true);
    await expect(engine.search(FENS.start)).rejects.toThrow(/terminated/);
    await expect(engine.newGame()).resolves.toBeUndefined();
  });
});

/**
 * A fake engine process that "downloads" its .wasm for `downloadMs` (progress every `everyMs`),
 * optionally stalling at `stallAt` of 1000 bytes, and then answers the UCI handshake.
 */
function loadingTransport(o: { downloadMs: number; everyMs: number; stallAt?: number }): EngineTransport {
  let emitLine: (line: string) => void = () => {};
  let emitProgress: (p: DownloadProgress) => void = () => {};
  let loadedAll = false;
  const queued: string[] = [];
  const answer = (cmd: string) => {
    if (cmd === 'uci') emitLine('uciok');
    else if (cmd === 'isready') emitLine('readyok');
  };
  const total = 1000;
  const t0 = Date.now();
  const timer = setInterval(() => {
    const loaded = Math.min(total, Math.round((total * (Date.now() - t0)) / o.downloadMs));
    if (o.stallAt !== undefined && loaded >= o.stallAt) {
      clearInterval(timer); // the connection dropped: no more bytes, no error
      return;
    }
    emitProgress({ loaded, total });
    if (loaded < total) return;
    clearInterval(timer);
    loadedAll = true;
    for (const cmd of queued.splice(0)) answer(cmd);
  }, o.everyMs);
  return {
    post: (cmd) => (loadedAll ? void setTimeout(() => answer(cmd), 1) : void queued.push(cmd)),
    onLine: (cb) => void (emitLine = cb),
    onProgress: (cb) => void (emitProgress = cb),
    terminate: () => clearInterval(timer),
  };
}

describe('StockfishEngine loading', () => {
  it('a slow but steady download is not a dead engine: progress restarts the load timeout', async () => {
    const seen: DownloadProgress[] = [];
    const engine = new StockfishEngine(() => loadingTransport({ downloadMs: 900, everyMs: 40 }), {
      loadTimeoutMs: 300,
      watchdog: { tickMs: 50 },
      onProgress: (p) => seen.push(p),
    });
    const started = Date.now();
    await engine.init();
    expect(Date.now() - started).toBeGreaterThan(800); // three times the load timeout
    expect(seen.length).toBeGreaterThan(10);
    expect(seen.every((p, i) => i === 0 || p.loaded >= seen[i - 1].loaded)).toBe(true);
    expect(seen.at(-1)).toEqual({ loaded: 1000, total: 1000 });
    engine.terminate();
  });

  it('a download that stops halfway fails as a download problem', async () => {
    const engine = new StockfishEngine(() => loadingTransport({ downloadMs: 400, everyMs: 20, stallAt: 500 }), {
      loadTimeoutMs: 300,
      watchdog: { tickMs: 50 },
    });
    const err = await engine.init().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineLoadError);
    expect(engineFailureKind(err)).toBe('download');
    expect((err as Error).message).toMatch(/download stalled at \d+%/);
  });

  it('keeps the kind of a transport load error, and reports other start-up errors as crashes', async () => {
    const failing = (err: Error): EngineTransport => {
      let report: (e: Error) => void = () => {};
      setTimeout(() => report(err), 5);
      return { post: () => {}, onLine: () => {}, onError: (cb) => void (report = cb), terminate: () => {} };
    };
    const a = new StockfishEngine(() => failing(new EngineLoadError('HTTP 404', 'download')));
    expect(engineFailureKind(await a.init().catch((e: unknown) => e))).toBe('download');
    const b = new StockfishEngine(() => failing(new Error('engine process exited (SIGKILL)')));
    const eb = await b.init().catch((e: unknown) => e);
    expect(engineFailureKind(eb)).toBe('crash');
    expect((eb as Error).message).toMatch(/SIGKILL/);
  });
});

describe('inspectPosition', () => {
  it('normalises and classifies positions', () => {
    expect(inspectPosition(FENS.start).legalMoves).toBe(20);
    expect(inspectPosition(FENS.mated).terminal).toBe('checkmate');
    expect(inspectPosition(FENS.stalemate).terminal).toBe('stalemate');
    expect(inspectPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -').fen).toBe(FENS.start);
    expect(() => inspectPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e3 0 1')).toThrow(/Invalid FEN/);
  });
});
