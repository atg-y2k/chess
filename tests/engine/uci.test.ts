import { describe, expect, it } from 'vitest';
import {
  MultiPvCollector,
  goCommand,
  parseBestMove,
  parseInfo,
  parsePvLine,
  parseUciLine,
  setOptionCommand,
} from '../../src/engine/uci';
import type { PvLine } from '../../src/engine/types';

// Real output of stockfish-19-lite-single (node CLI), captured 2026-09-30.
const L = {
  mpv1:
    'info depth 10 seldepth 14 multipv 1 score cp -12 wdl 11 960 29 nodes 65008 nps 408855 hashfull 25 time 159 pv g8f6 f3g5 d7d5 e4d5 c6a5 c4b5 c8d7',
  upper:
    'info depth 16 seldepth 19 multipv 2 score cp 42 upperbound wdl 84 913 3 nodes 661390 nps 504492 hashfull 252 time 1311 pv a2a3 d7e5',
  lower:
    'info depth 17 seldepth 26 multipv 1 score cp 30 lowerbound nodes 1056123 nps 502915 hashfull 311 time 2100 pv a2a3',
  mate: 'info depth 12 seldepth 6 multipv 1 score mate 3 wdl 1000 0 0 nodes 46894 nps 558261 hashfull 16 time 84 pv f8c5 d4c5 f6b6 c5d5 b6d6',
  mated: 'info depth 0 score mate 0',
  stalemate: 'info depth 0 score cp 0',
  nnue: 'info string NNUE evaluation using nn-61e7af4bb97d.nnue (1MiB, (768, 1024, 32, 32, 1))',
  critical: 'info string CRITICAL ERROR: Command `` failed. Reason: Unsupported position. King can be captured.',
  noWdl: 'info depth 12 seldepth 14 multipv 1 score cp 31 nodes 12743 nps 289613 hashfull 4 time 44 pv e2e4 c7c5 b1c3',
};

describe('parseInfo / parsePvLine', () => {
  it('parses a full MultiPV line with WDL', () => {
    expect(parsePvLine(L.mpv1)).toEqual<PvLine>({
      multipv: 1,
      depth: 10,
      seldepth: 14,
      score: { kind: 'cp', value: -12 },
      wdl: [11, 960, 29],
      nodes: 65008,
      nps: 408855,
      timeMs: 159,
      pv: ['g8f6', 'f3g5', 'd7d5', 'e4d5', 'c6a5', 'c4b5', 'c8d7'],
    });
  });

  it('marks upper/lower bounds', () => {
    const up = parsePvLine(L.upper)!;
    expect(up.bound).toBe('upper');
    expect(up.multipv).toBe(2);
    expect(up.score).toEqual({ kind: 'cp', value: 42 });
    expect(up.wdl).toEqual([84, 913, 3]);
    expect(up.pv).toEqual(['a2a3', 'd7e5']);
    const low = parsePvLine(L.lower)!;
    expect(low.bound).toBe('lower');
    expect(low.wdl).toBeUndefined();
  });

  it('parses mate scores', () => {
    const m = parsePvLine(L.mate)!;
    expect(m.score).toEqual({ kind: 'mate', value: 3 });
    expect(m.pv[0]).toBe('f8c5');
  });

  it('handles lines without WDL', () => {
    const l = parsePvLine(L.noWdl)!;
    expect(l.wdl).toBeUndefined();
    expect(l.score).toEqual({ kind: 'cp', value: 31 });
    expect(l.timeMs).toBe(44);
  });

  it('keeps depth-0 terminal info but does not turn it into a PvLine', () => {
    expect(parseInfo(L.mated)).toEqual({ depth: 0, score: { kind: 'mate', value: 0 }, pv: [] });
    expect(parseInfo(L.stalemate)!.score).toEqual({ kind: 'cp', value: 0 });
    expect(parsePvLine(L.mated)).toBeNull();
    expect(parsePvLine(L.stalemate)).toBeNull();
  });

  it('ignores info string and non-info lines', () => {
    expect(parseInfo(L.nnue)).toBeNull();
    expect(parseInfo('bestmove e2e4')).toBeNull();
    expect(parseInfo('uciok')).toBeNull();
    expect(parsePvLine(L.nnue)).toBeNull();
  });

  it('skips unknown tokens and currmove', () => {
    const i = parseInfo('info depth 5 currmove e2e4 currmovenumber 1 tbhits 0 score cp 7 pv e2e4')!;
    expect(i.depth).toBe(5);
    expect(i.score).toEqual({ kind: 'cp', value: 7 });
    expect(i.pv).toEqual(['e2e4']);
  });
});

describe('parseBestMove / parseUciLine', () => {
  it('parses bestmove with and without ponder', () => {
    expect(parseBestMove('bestmove g8f6 ponder f3g5')).toEqual({ move: 'g8f6', ponder: 'f3g5' });
    expect(parseBestMove('bestmove d1d8')).toEqual({ move: 'd1d8' });
    expect(parseBestMove('bestmove (none)')).toEqual({ move: null });
    expect(parseBestMove('info depth 1')).toBeNull();
  });

  it('classifies engine output', () => {
    expect(parseUciLine('uciok')).toEqual({ type: 'uciok' });
    expect(parseUciLine('readyok')).toEqual({ type: 'readyok' });
    expect(parseUciLine('bestmove (none)')).toEqual({ type: 'bestmove', move: null });
    expect(parseUciLine(L.critical)).toEqual({
      type: 'error',
      message: 'CRITICAL ERROR: Command `` failed. Reason: Unsupported position. King can be captured.',
    });
    expect(parseUciLine(L.nnue)).toEqual({ type: 'other' });
    expect(parseUciLine('Stockfish 19 Lite WASM by the Stockfish developers (see AUTHORS file)')).toEqual({ type: 'other' });
    expect(parseUciLine('option name MultiPV type spin default 1 min 1 max 256')).toEqual({ type: 'other' });
    const info = parseUciLine(L.mpv1);
    expect(info.type).toBe('info');
  });
});

describe('commands', () => {
  it('builds go commands (depth 18 default, never infinite)', () => {
    expect(goCommand({})).toBe('go depth 18');
    expect(goCommand({ depth: 12 })).toBe('go depth 12');
    expect(goCommand({ nodes: 300000, movetime: 1500.4 })).toBe('go nodes 300000 movetime 1500');
    expect(goCommand({ depth: 0 })).toBe('go depth 18');
  });

  it('builds setoption commands', () => {
    expect(setOptionCommand('UCI_ShowWDL', true)).toBe('setoption name UCI_ShowWDL value true');
    expect(setOptionCommand('Skill Level', 5)).toBe('setoption name Skill Level value 5');
  });
});

describe('MultiPvCollector', () => {
  const feed = (c: MultiPvCollector, lines: string[]) => {
    const out: PvLine[][] = [];
    for (const l of lines) {
      const pv = parsePvLine(l);
      if (!pv) continue;
      const b = c.push(pv);
      if (b) out.push(b);
    }
    return out;
  };

  it('commits complete, exact, same-depth batches only', () => {
    // Tail of a stopped MultiPV 3 search: d15 complete, then a mixed d16/upperbound/d15 batch.
    const lines = [
      'info depth 15 seldepth 30 multipv 1 score cp 46 wdl 98 900 2 nodes 550155 nps 509874 hashfull 208 time 1079 pv g2g4 d7c5 h1g1',
      'info depth 15 seldepth 26 multipv 2 score cp 44 wdl 89 908 3 nodes 550155 nps 509874 hashfull 208 time 1079 pv a2a3 d7e5 g2g4',
      'info depth 15 seldepth 27 multipv 3 score cp 43 wdl 87 910 3 nodes 550155 nps 509402 hashfull 208 time 1080 pv h1g1 d7c5 g2g4',
      'info depth 16 seldepth 29 multipv 1 score cp 46 wdl 99 899 2 nodes 661390 nps 504492 hashfull 252 time 1311 pv g2g4 d7c5 g4g5',
      L.upper,
      'info depth 15 seldepth 27 multipv 3 score cp 43 wdl 87 910 3 nodes 661390 nps 504492 hashfull 252 time 1311 pv h1g1 d7c5 g2g4',
    ];
    const batches = feed(new MultiPvCollector(3), lines);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((l) => [l.multipv, l.depth, l.pv[0]])).toEqual([
      [1, 15, 'g2g4'],
      [2, 15, 'a2a3'],
      [3, 15, 'h1g1'],
    ]);
  });

  it('handles fewer legal moves than MultiPV via the expected count', () => {
    const c = new MultiPvCollector(2);
    const b = feed(c, [
      'info depth 3 seldepth 3 multipv 1 score cp 900 nodes 50 pv a1b1',
      'info depth 3 seldepth 3 multipv 2 score cp 800 nodes 50 pv a1a2',
    ]);
    expect(b).toHaveLength(1);
    expect(b[0]).toHaveLength(2);
  });

  it('ignores a bound line for MultiPV 1 until the exact line arrives', () => {
    const c = new MultiPvCollector(1);
    expect(c.push(parsePvLine(L.lower)!)).toBeNull();
    expect(c.push(parsePvLine(L.noWdl)!)).toHaveLength(1);
  });

  it('rejects a batch with a missing line', () => {
    const c = new MultiPvCollector(3);
    const b = feed(c, [
      'info depth 4 multipv 1 score cp 10 pv e2e4',
      'info depth 4 multipv 3 score cp 5 pv c2c4',
    ]);
    expect(b).toHaveLength(0);
  });
});
