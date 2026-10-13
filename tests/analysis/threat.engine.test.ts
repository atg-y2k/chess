/**
 * Real engine: threat alerts (analysis/threat.ts) with the app's StockfishEngine and AnalysisService
 * at the probe's own budget (THREAT_DEPTH within THREAT_NODES per search): the classic threats are
 * found and worded, and quiet positions or a hanging piece that merely escapes say nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { probeThreat } from '../../src/analysis/threat';
import { AnalysisService } from '../../src/engine/AnalysisService';
import { StockfishEngine } from '../../src/engine/StockfishEngine';
import { createNodeTransport } from '../helpers/nodeTransport';

const after = (sans: string[]): string => {
  const c = new Chess();
  for (const san of sans) c.move(san);
  return c.fen();
};

let engine: StockfishEngine;
let svc: AnalysisService;

beforeAll(async () => {
  engine = new StockfishEngine(createNodeTransport, { hashMb: 32, showWdl: true });
  await engine.init();
  svc = new AnalysisService(engine, { throttleMs: 0 });
});
afterAll(() => engine.terminate());

const probe = (fen: string) => probeThreat(fen, (f, o) => svc.ensure(f, o), { name: 'Pip' });

describe('threat alerts with the real engine', () => {
  it('finds and words the classic threats', async () => {
    // 4.Ng5 in the Two Knights: Nxf7 forks the queen and the rook.
    expect(await probe(after(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5']))).toMatchObject({
      kind: 'material',
      text: 'Pip threatens Nxf7, forking your queen and rook.',
      arrows: [{ from: 'g5', to: 'f7', brush: 'threat' }],
    });
    // The Scholar's mate.
    expect(await probe(after(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5']))).toMatchObject({ kind: 'mate', text: 'Pip threatens Qxf7#, checkmate.' });
    // A pawn attacks a bishop.
    expect((await probe(after(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'd3', 'd5'])))?.text).toBe(
      'Pip threatens dxc4, winning your bishop on c4.',
    );
    // A rook that has just blocked a check attacks the queen (the e2e position).
    expect((await probe('2Q2rk1/6p1/1P5p/6N1/5P2/3K4/7n/8 w - - 1 31'))?.text).toBe('Pip threatens Rxc8, winning your queen on c8.');
  });

  it('stays quiet when nothing real is threatened', async () => {
    expect(await probe(new Chess().fen())).toBeNull();
    expect(await probe(after(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']))).toBeNull();
    // 2…Qh4 hangs the queen: moving again, Black would only save it (and a pawn is never enough).
    expect(await probe(after(['e4', 'e5', 'Nf3', 'Qh4']))).toBeNull();
  });
});
