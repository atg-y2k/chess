import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { StockfishEngine } from '../../src/engine/StockfishEngine';
import { createEngineMux } from '../../src/engine/EngineMux';
import type { AnalysisResult, ChessEngine } from '../../src/engine/types';
import { createNodeTransport } from '../helpers/nodeTransport';

const FENS = {
  start: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  italian: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
  middle: 'r2q1rk1/1b1nbppp/p2ppn2/1p6/3NP3/1BN1BP2/PPPQ2PP/2KR3R w - - 0 12',
  afterE4: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  mated: '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1',
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

describe('EngineMux (real engine)', () => {
  let physical: StockfishEngine;
  let high: ChessEngine;
  let low: ChessEngine;
  const out: string[] = [];
  const gosFor = (fenPrefix: string) => {
    let n = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i].startsWith('go') && out[i - 1]?.startsWith(`position fen ${fenPrefix}`)) n++;
    }
    return n;
  };

  beforeAll(async () => {
    physical = new StockfishEngine(createNodeTransport, {
      hashMb: 16,
      showWdl: true,
      onLine: (line, dir) => dir === 'out' && out.push(line),
    });
    ({ high, low } = createEngineMux(physical));
    await high.init();
    await low.init();
  });
  afterAll(() => {
    high.terminate();
    low.terminate();
  });

  it('a high search pauses the low one, which resumes transparently', async () => {
    const lowInfos: AnalysisResult[] = [];
    let lowSettled = false;
    const lowP = low.search(FENS.middle, { depth: 13, multiPv: 2, onInfo: (p) => lowInfos.push(p) });
    void lowP.then(() => (lowSettled = true));
    await sleep(120);
    const depthBefore = lowInfos.at(-1)?.depth ?? 0;
    const h = await high.search(FENS.afterE4, { depth: 10, skillLevel: 3 });
    expect(h.done).toBe(true);
    expect(legalIn(FENS.afterE4, h.bestMove)).toBe(true);
    expect(lowSettled).toBe(false); // not resolved as aborted by the pause
    const r = await lowP;
    expect(r.done).toBe(true);
    expect(r.aborted).toBeFalsy();
    expect(r.depth).toBe(13);
    expect(r.lines).toHaveLength(2);
    expect(r.lines.every((l) => legalIn(FENS.middle, l.pv[0]))).toBe(true);
    // Restarted with the same options, streaming never went backwards.
    expect(gosFor(FENS.middle.split(' ')[0])).toBe(2);
    expect(lowInfos.every((p, i) => i === 0 || p.depth >= lowInfos[i - 1].depth)).toBe(true);
    expect(lowInfos.every((p) => p.lines.length === 2 && p.lines.every((l) => legalIn(FENS.middle, l.pv[0])))).toBe(true);
    expect(depthBefore).toBeGreaterThan(0);
  });

  it('a low search requested during a high search waits for it', async () => {
    const h = high.search(FENS.middle, { depth: 11 });
    const l = low.search(FENS.italian, { depth: 8 });
    const rh = await h;
    expect(rh.done).toBe(true);
    const rl = await l;
    expect(rl.done).toBe(true);
    expect(legalIn(FENS.italian, rl.bestMove)).toBe(true);
  });

  it('a new low search pre-empts the previous low search', async () => {
    const a = low.search(FENS.middle, { depth: 30 });
    await sleep(80);
    const b = low.search(FENS.afterE4, { depth: 8 });
    expect((await a).aborted).toBe(true);
    const rb = await b;
    expect(rb.done).toBe(true);
    expect(legalIn(FENS.afterE4, rb.bestMove)).toBe(true);
  });

  it('a new high search pre-empts the previous high search', async () => {
    const a = high.search(FENS.middle, { depth: 30 });
    await sleep(80);
    const b = high.search(FENS.italian, { depth: 8 });
    expect((await a).aborted).toBe(true);
    expect((await b).done).toBe(true);
  });

  it('aborting a paused low search resolves it and it is not restarted', async () => {
    const ac = new AbortController();
    const lowP = low.search(FENS.middle, { depth: 30, signal: ac.signal });
    await sleep(80);
    const h = high.search(FENS.italian, { depth: 12 });
    await sleep(10);
    const middle = FENS.middle.split(' ')[0];
    const gosBefore = gosFor(middle);
    ac.abort();
    const r = await lowP;
    expect(r.aborted).toBe(true);
    expect(r.lines.every((l) => legalIn(FENS.middle, l.pv[0]))).toBe(true);
    await h;
    await sleep(60);
    expect(gosFor(middle)).toBe(gosBefore);
  });

  it('terminal positions on the high lane do not pause the low lane', async () => {
    const lowP = low.search(FENS.italian, { depth: 12 });
    await sleep(30);
    const gos = gosFor(FENS.italian.split(' ')[0]);
    const t = await high.search(FENS.mated);
    expect(t.terminal).toBe('checkmate');
    const r = await lowP;
    expect(r.done).toBe(true);
    expect(gosFor(FENS.italian.split(' ')[0])).toBe(gos);
  });

  it('stop() on the low lane stops only low work', async () => {
    const lowP = low.search(FENS.middle, { depth: 30 });
    await sleep(50);
    high.stop(); // no high work: must not touch the low search
    await sleep(50);
    low.stop();
    expect((await lowP).aborted).toBe(true);
    const r = await low.search(FENS.start, { depth: 6 });
    expect(r.done).toBe(true);
  });

  it('rejects invalid FENs on both lanes without disturbing work', async () => {
    await expect(high.search('nope')).rejects.toThrow(/Invalid FEN/);
    await expect(low.search('nope')).rejects.toThrow(/Invalid FEN/);
  });
});

describe('EngineMux termination', () => {
  it('terminates the physical engine when both lanes are terminated', async () => {
    const physical = new StockfishEngine(createNodeTransport);
    const { high, low } = createEngineMux(physical);
    await high.init();
    const lowP = low.search(FENS.middle, { depth: 30 });
    await sleep(50);
    high.terminate();
    expect(physical.isDead).toBe(false);
    await expect(high.search(FENS.start)).rejects.toThrow();
    low.terminate();
    expect((await lowP).aborted).toBe(true);
    expect(physical.isDead).toBe(true);
  });
});
