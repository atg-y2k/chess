/**
 * Real engine: THE USER'S CASE (1.d4 d5 2.c4 Nf6 3.cxd5 Nxd5) annotated as the app does it, with
 * the app's StockfishEngine (Hash 32, WDL) and AnalysisService and the controller's ANNOTATE
 * request, in game order. At that budget the best line and the played move's own search are both
 * noisy (over 80 runs with live analysis, the best line came out between -0.40 and -0.77, Nxd5's
 * own search between -0.66 and -0.97), and in 11 of them Nxd5 landed outside the band of the best
 * line and was corrected. The second opinion (analysis/nearEqual.ts, `nearBestRecheck`) compares
 * like with like: Nxd5 is "about as good" in 76 of the 80 runs, against 69 without it.
 *
 * Live analysis made those runs differ; here deterministic searches stand in for it (an `ensure`
 * of the human's and the bot's positions at depth 13 to 16 before the annotation, which the
 * analysis cache then serves, as it serves the live result in the app). Each history below put
 * Nxd5 outside the band of the best line, the third as one of the engine's own lines.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { classifyMove, nearBestRecheck, type ClassifyMoveInput } from '../../src/analysis/classify';
import { explainMove } from '../../src/analysis/explain';
import { AnalysisService } from '../../src/engine/AnalysisService';
import { StockfishEngine } from '../../src/engine/StockfishEngine';
import { ANNOTATE_DEPTH, ANNOTATE_MULTIPV, ANNOTATE_NODES } from '../../src/game/controller';
import { createNodeTransport } from '../helpers/nodeTransport';

const ANNOTATE = { minDepth: ANNOTATE_DEPTH, multiPv: ANNOTATE_MULTIPV, maxNodes: ANNOTATE_NODES };

/** The user's game: the position before each move, the move, and the position after it. */
function steps(sans: string[]) {
  const c = new Chess();
  return sans.map((san) => {
    const fen = c.fen();
    const m = c.move(san);
    return { fen, uci: m.from + m.to + (m.promotion ?? ''), fenAfter: c.fen() };
  });
}

/**
 * Annotates the user's line in game order as GameController.annotate does, after searching the
 * human's (Black's) positions to `humanDepth` and the bot's to `botDepth` (0: not at all). Returns
 * what the coach says about 3...Nxd5, with and without the second opinion.
 */
async function userCase(humanDepth: number, botDepth: number) {
  const engine = new StockfishEngine(createNodeTransport, { hashMb: 32, showWdl: true });
  await engine.init();
  try {
    const svc = new AnalysisService(engine, { throttleMs: 0 });
    const st = steps(['d4', 'd5', 'c4', 'Nf6', 'cxd5', 'Nxd5']);
    let prev: { winLoss: number; uci: string; fen: string } | undefined;
    for (let i = 0; i < st.length; i++) {
      const depth = i % 2 === 1 ? humanDepth : botDepth;
      if (depth > 0) await svc.ensure(st[i].fen, { minDepth: depth, multiPv: 3, maxNodes: 50_000_000 });
      const before = await svc.ensure(st[i].fen, ANNOTATE);
      const after = await svc.ensure(st[i].fenAfter, ANNOTATE);
      const input: ClassifyMoveInput = {
        fenBefore: st[i].fen,
        moveUci: st[i].uci,
        before,
        after,
        opponentPrevWinLoss: prev?.winLoss,
        playerRating: 1200,
        prevMove: prev ? { to: prev.uci.slice(2, 4) } : undefined,
        prevFenBefore: prev?.fen,
      };
      const recheck = nearBestRecheck(input);
      const bestAfter = recheck ? await svc.ensure(recheck, ANNOTATE) : undefined;
      const classification = classifyMove({ ...input, ...(bestAfter ? { bestAfter } : {}) });
      if (i === st.length - 1) {
        const e = explainMove({ fenBefore: st[i].fen, moveUci: st[i].uci, classification, before, after });
        return { recheck, alone: classifyMove(input), classification, text: [e.headline, ...e.details] };
      }
      prev = { winLoss: classification.winLoss, uci: st[i].uci, fen: st[i].fen };
    }
    throw new Error('unreachable');
  } finally {
    engine.terminate();
  }
}

describe('THE USER’S CASE with the real engine: 3...Nxd5 stays "about as good" when the searches are noisy', () => {
  for (const [humanDepth, botDepth, what] of [
    [0, 13, 'Nxd5’s own search 29 cp behind the c6 line'],
    [16, 16, 'depth-16 lines from the cache, Nxd5 28 cp behind'],
    [0, 16, 'Nxd5 one of the lines, 33 cp behind c6'],
  ] as const) {
    it(`${what} (human positions searched to depth ${humanDepth}, the bot’s to ${botDepth})`, { timeout: 120_000 }, async () => {
      const r = await userCase(humanDepth, botDepth);
      // Outside the band of the best line: the coach asks for the second opinion...
      expect(r.recheck).not.toBeNull();
      // ...without which Nxd5 would be corrected...
      expect(r.alone.nearBest).toBe(false);
      // ...and with which it is about as good: no correction.
      expect(r.classification).toMatchObject({ cls: 'good', nearBest: true });
      expect(r.text.some((l) => l.startsWith('Your Nxd5 was fine: '))).toBe(true);
      for (const line of r.text) expect(line).not.toMatch(/Best was|was better|more accurate/);
    });
  }
});
