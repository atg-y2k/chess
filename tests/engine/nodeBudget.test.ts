/**
 * Real engine: the node budgets of AnalysisService in a position where one iteration can take
 * millions of nodes. After 1.d4 Nf6 2.c4 d5 3.cxd5 Nxd5 4.e4 Nd7 5.exd5 c6 6.dxc6 Rg8 7.cxd7+ Kxd7
 * 8.Qa4+ Kd6 9.Qa3+, Stockfish 19 lite (MultiPV 3) gets to depth 11 within a few thousand nodes
 * and then often needs millions for the next iteration (how many depends on what the hash
 * holds); depth 18 takes minutes. Without a budget, the coach's depth-14 request took 13 s in
 * node and a minute in the browser, and it held the analysis queue (the coach's "Checking Qa3+…"
 * and the eval bar) all that time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { AnalysisService, LIVE_NODES } from '../../src/engine/AnalysisService';
import { StockfishEngine } from '../../src/engine/StockfishEngine';
import type { AnalysisResult } from '../../src/engine/types';
import { ANNOTATE_DEPTH, ANNOTATE_MULTIPV, ANNOTATE_NODES } from '../../src/game/controller';
import { createNodeTransport } from '../helpers/nodeTransport';

const STALL = 'r1bq1br1/pp2pppp/3k4/8/3P4/Q7/PP3PPP/RNB1KBNR b KQ - 3 9';
const ANNOTATE = { minDepth: ANNOTATE_DEPTH, multiPv: ANNOTATE_MULTIPV, maxNodes: ANNOTATE_NODES };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for condition');
    await sleep(10);
  }
}

function legalIn(fen: string, uci: string | undefined): boolean {
  if (!uci) return false;
  try {
    new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return true;
  } catch {
    return false;
  }
}

describe('node budgets in a position where one iteration takes millions of nodes (real engine)', () => {
  let engine: StockfishEngine;
  const out: string[] = [];
  const gos = () => out.filter((l) => l.startsWith('go'));
  let bestmoves = 0;

  beforeAll(async () => {
    // As the app's analysis engine: Hash 32, WDL on.
    engine = new StockfishEngine(createNodeTransport, {
      hashMb: 32,
      showWdl: true,
      onLine: (line, dir) => {
        if (dir === 'out') out.push(line);
        else if (line.startsWith('bestmove')) bestmoves++;
      },
    });
    await engine.init();
  });
  afterAll(() => engine.terminate());

  it('the coach’s request finishes within its budget, and live analysis resumes and stops at its own', async () => {
    const svc = new AnalysisService(engine); // the app's settings: live depth 18, MultiPV 3, LIVE_NODES
    const updates: AnalysisResult[] = [];
    svc.subscribe((u) => updates.push(u));
    svc.watch(STALL);
    await until(() => updates.length > 0, 10_000); // the live search is under way

    // The annotation / hint / Show best / review request pre-empts it.
    const t0 = Date.now();
    const r = await svc.ensure(STALL, ANNOTATE);
    const ms = Date.now() - t0;
    expect(gos()).toContain(`go depth ${ANNOTATE_DEPTH} nodes ${ANNOTATE_NODES}`);
    // Not cut short: a finished search (or its last report, once past the budget) that is a verdict.
    expect(r.aborted).toBeFalsy();
    expect(r.depth).toBeGreaterThanOrEqual(8); // usually 11 or 12
    expect(r.lines).toHaveLength(3);
    expect(r.lines.every((l) => legalIn(STALL, l.pv[0]))).toBe(true);
    // 1.2M nodes: about 2 s in node (2.5 s on an iPhone); generous for a loaded test machine.
    expect(ms).toBeLessThan(15_000);

    // Asked again, as the next move's "before" analysis: from the cache, no search.
    const coachGo = `go depth ${ANNOTATE_DEPTH} nodes ${ANNOTATE_NODES}`;
    const n = gos().filter((g) => g === coachGo).length;
    const again = await svc.ensure(STALL.replace(/ 3 9$/, ' 0 12'), ANNOTATE);
    expect(again.depth).toBeGreaterThanOrEqual(r.depth);
    expect(gos().filter((g) => g === coachGo)).toHaveLength(n);

    // Live analysis was not starved: it resumes at once and stops at its node budget instead of
    // searching toward depth 18 for minutes. The eval bar then shows the deepest result found
    // (never a shallower one), finished.
    await until(() => gos().at(-1) !== coachGo, 5_000);
    expect(gos().at(-1)).toBe(`go depth 18 nodes ${LIVE_NODES}`);
    const b = bestmoves;
    await until(() => bestmoves > b, 60_000); // 5M nodes: about 10 s here
    await sleep(50);
    const shown = updates.at(-1)!;
    expect(shown).toMatchObject({ fen: STALL, done: true });
    expect(shown.depth).toBeGreaterThanOrEqual(r.depth);
    expect(shown.lines.every((l) => legalIn(STALL, l.pv[0]))).toBe(true);
    // It stopped on its own limits: usually the node budget runs out below depth 18, but with a
    // lucky hash table depth 18 can be reached first, so assert the budget rather than the depth.
    // (Stockfish checks the node limit periodically, so allow a small overshoot.)
    const live = svc.get(STALL)!;
    expect(live.depth).toBeLessThanOrEqual(18);
    expect(live.lines[0]?.nodes).toBeGreaterThan(0);
    expect(live.lines[0]!.nodes!).toBeLessThanOrEqual(LIVE_NODES * 1.05);
    const k = gos().length;
    await sleep(300);
    expect(gos()).toHaveLength(k); // finished: not restarted
    svc.watch(null);
  }, 90_000);
});
