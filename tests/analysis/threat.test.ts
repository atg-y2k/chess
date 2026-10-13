/**
 * Threat alerts (analysis/threat.ts, explain.ts `explainThreat`): the null-move probe judged from two
 * engine results, its words, what is never a threat (a small one, a piece that only escapes, a
 * position already lost to a mate, a check), and the probe's budget and abort paths.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { explainThreat } from '../../src/analysis/explain';
import { nullMoveFen } from '../../src/analysis/motifs';
import {
  THREAT_DEPTH,
  THREAT_MIN_CP,
  THREAT_NODES,
  judgeThreat,
  probeThreat,
  threatProbeFen,
  type ThreatAnalyze,
} from '../../src/analysis/threat';
import type { AnalysisResult, PvLine, Score } from '../../src/engine/types';

const after = (sans: string[]): string => {
  const c = new Chess();
  for (const san of sans) c.move(san);
  return c.fen();
};

/** 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.Ng5: Black to move, White threatens Nxf7 (queen and rook). */
const FRIED = after(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5']);
/** 1.e4 e5 2.Bc4 Nc6 3.Qh5: Black to move, White threatens Qxf7#. */
const SCHOLAR = after(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5']);
/** 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nf6 4.d3 d5: White to move, the pawn attacks the bishop on c4. */
const PAWN_ON_BISHOP = after(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'd3', 'd5']);
/** 1.e4 e5 2.Nf3 Qh4: White to move; the queen hangs (it escapes when Black moves again). */
const QH4 = after(['e4', 'e5', 'Nf3', 'Qh4']);
/** 1.e4 f5 2.Qh5+: Black to move, in check. */
const CHECKED = after(['e4', 'f5', 'Qh5+']);

const line = (score: Score, pv: string[]): PvLine => ({ multipv: 1, depth: 14, score, pv });
const result = (fen: string, lines: PvLine[], extra: Partial<AnalysisResult> = {}): AnalysisResult => ({
  fen,
  depth: lines[0]?.depth ?? 0,
  lines,
  bestMove: lines[0]?.pv[0] ?? null,
  done: true,
  ...extra,
});
const cp = (value: number): Score => ({ kind: 'cp', value });
const mate = (value: number): Score => ({ kind: 'mate', value });
const probeOf = (fen: string) => nullMoveFen(fen)!;

describe('threat alerts: judging the null-move probe', () => {
  it('a fork: "Pip threatens Nxf7, forking your queen and rook.", with the threat arrow and its squares', () => {
    const now = result(FRIED, [line(cp(-40), ['d7d5', 'e4d5'])]);
    const probe = result(probeOf(FRIED), [line(cp(320), ['g5f7', 'd8e7', 'f7h8'])]);
    const t = judgeThreat(FRIED, now, probe, { name: 'Pip' });
    expect(t).toMatchObject({
      fen: FRIED,
      uci: 'g5f7',
      san: 'Nxf7',
      kind: 'material',
      text: 'Pip threatens Nxf7, forking your queen and rook.',
      arrows: [{ from: 'g5', to: 'f7', brush: 'threat' }],
    });
    expect(t!.squares).toEqual(expect.arrayContaining(['g5', 'f7', 'd8', 'h8']));
  });

  it('a mate threat: "Pip threatens Qxf7#, checkmate." (a longer one: the forced mate and its first move)', () => {
    const now = result(SCHOLAR, [line(cp(-60), ['g7g6'])]);
    const probe = result(probeOf(SCHOLAR), [line(mate(1), ['h5f7'])]);
    expect(judgeThreat(SCHOLAR, now, probe, { name: 'Pip' })).toMatchObject({ kind: 'mate', text: 'Pip threatens Qxf7#, checkmate.' });
    const longer = result(probeOf(SCHOLAR), [line(mate(2), ['h5e5', 'g8e7', 'e5e7'])]);
    expect(judgeThreat(SCHOLAR, now, longer, { name: 'Pip' })?.text).toBe('Pip threatens a forced mate in 2, starting with Qxe5+.');
  });

  it('a piece won: the static detection’s words when it finds the same move', () => {
    const now = result(PAWN_ON_BISHOP, [line(cp(40), ['e4d5'])]);
    const probe = result(probeOf(PAWN_ON_BISHOP), [line(cp(280), ['d5c4', 'd3c4'])]);
    expect(judgeThreat(PAWN_ON_BISHOP, now, probe, { name: 'Robot 800' })?.text).toBe(
      'Robot 800 threatens dxc4, winning your bishop on c4.',
    );
  });

  it('no warning noise: a small gain, a line that wins no material (a piece escaping, a tempo), or a threat while mated anyway', () => {
    const now = result(PAWN_ON_BISHOP, [line(cp(40), ['e4d5'])]);
    // Under THREAT_MIN_CP.
    const small = result(probeOf(PAWN_ON_BISHOP), [line(cp(THREAT_MIN_CP - 41), ['d5c4', 'd3c4'])]);
    expect(judgeThreat(PAWN_ON_BISHOP, now, small, { name: 'Pip' })).toBeNull();
    // The hanging queen only escapes when Black moves again: a big swing, but no material won.
    const q = result(QH4, [line(cp(800), ['f3h4'])]);
    const escape = result(probeOf(QH4), [line(cp(-30), ['h4d8', 'b1c3'])]);
    expect(judgeThreat(QH4, q, escape, { name: 'Pip' })).toBeNull();
    // A pawn won is never enough.
    const pawn = result(probeOf(QH4), [line(cp(900), ['h4e4', 'f1e2'])]);
    expect(judgeThreat(QH4, q, pawn, { name: 'Pip' })).toBeNull();
    // Being mated anyway: a mate threat changes nothing.
    const lost = result(SCHOLAR, [line(mate(-2), ['g7g6'])]);
    expect(judgeThreat(SCHOLAR, lost, result(probeOf(SCHOLAR), [line(mate(1), ['h5f7'])]), { name: 'Pip' })).toBeNull();
  });

  it('never in check (a null move would be illegal), nor once the game is over', () => {
    expect(new Chess(CHECKED).inCheck()).toBe(true);
    expect(threatProbeFen(CHECKED)).toBeNull();
    expect(threatProbeFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3')).toBeNull(); // fool's mate
    expect(threatProbeFen(FRIED)).toBe(probeOf(FRIED));
    expect(judgeThreat(CHECKED, result(CHECKED, [line(cp(0), ['g7g6'])]), result(CHECKED, [line(mate(1), ['h5e8'])]), { name: 'Pip' })).toBeNull();
  });

  it('explainThreat names only the opponent’s move (never a defense)', () => {
    const e = explainThreat(FRIED, line(cp(320), ['g5f7', 'd8e7', 'f7h8']), { name: 'Pip' })!;
    expect(e.headline).toBe('Pip threatens Nxf7, forking your queen and rook.');
    expect(e.details).toEqual([]);
    expect(e.motifs).toEqual(['fork']);
    // No defense is ever suggested: d5, Qe7 or O-O never appear.
    expect(e.headline).not.toMatch(/\b(d5|Qe7|O-O)\b/);
    expect(explainThreat(FRIED, line(cp(0), []), { name: 'Pip' })).toBeNull();
  });
});

describe('threat alerts: the probe', () => {
  it('asks for both positions at once, at THREAT_DEPTH within THREAT_NODES, one line each', async () => {
    const asked: { fen: string; opts: Parameters<ThreatAnalyze>[1] }[] = [];
    const analyze: ThreatAnalyze = (fen, opts) => {
      asked.push({ fen, opts });
      return Promise.resolve(
        fen === FRIED ? result(fen, [line(cp(-40), ['d7d5'])]) : result(fen, [line(cp(320), ['g5f7', 'd8e7', 'f7h8'])]),
      );
    };
    const t = await probeThreat(FRIED, analyze, { name: 'Pip' });
    expect(t?.text).toBe('Pip threatens Nxf7, forking your queen and rook.');
    expect(asked.map((a) => a.fen)).toEqual([FRIED, probeOf(FRIED)]);
    for (const a of asked) expect(a.opts).toMatchObject({ minDepth: THREAT_DEPTH, multiPv: 1, maxNodes: THREAT_NODES });
    expect(THREAT_NODES).toBeLessThanOrEqual(200_000);
  });

  it('says it could not tell (undefined) when a search is cut short early, fails or is withdrawn; null when there is no threat', async () => {
    const shallow: ThreatAnalyze = (fen) => Promise.resolve(result(fen, [{ ...line(cp(300), ['g5f7']), depth: 3 }], { depth: 3, aborted: true, done: false }));
    expect(await probeThreat(FRIED, shallow, { name: 'Pip' })).toBeUndefined();
    const failing: ThreatAnalyze = () => Promise.reject(new Error('bad'));
    expect(await probeThreat(FRIED, failing, { name: 'Pip' })).toBeUndefined();
    const ctl = new AbortController();
    const slow: ThreatAnalyze = (fen, opts) => {
      expect(opts.signal).toBe(ctl.signal);
      ctl.abort();
      return Promise.resolve(result(fen, [line(cp(320), ['g5f7', 'd8e7', 'f7h8'])]));
    };
    expect(await probeThreat(FRIED, slow, { name: 'Pip', signal: ctl.signal })).toBeUndefined();
    const quiet: ThreatAnalyze = (fen) => Promise.resolve(result(fen, [line(cp(20), fen === FRIED ? ['d7d5'] : ['g5f3'])]));
    expect(await probeThreat(FRIED, quiet, { name: 'Pip' })).toBeNull();
    // In check: no probe, nothing asked.
    let calls = 0;
    expect(await probeThreat(CHECKED, () => (calls++, Promise.reject(new Error('never'))), { name: 'Pip' })).toBeNull();
    expect(calls).toBe(0);
  });
});
