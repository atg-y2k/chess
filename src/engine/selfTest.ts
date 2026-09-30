/**
 * Engine diagnostics for a real device (dev gallery `?g=engine`, app `?enginetest`).
 * Creates the engine set the app would use, then checks and times: init, a depth-12 search,
 * MultiPV 3, a mate in 2, terminal positions, bot strength options, the analysis cache, and
 * both engines working at the same time for ~8 s (in single mode: bot searches pausing and
 * resuming analysis). Logs human-readable lines and resolves PASS (true) / FAIL (false).
 */
import { Chess } from 'chess.js';
import { START_FEN, pvToSan, toWhitePov } from '../chess/utils';
import { AnalysisService } from './AnalysisService';
import { createEngines, type EngineSet } from './createEngines';
import type { AnalysisResult, PvLine, Score } from './types';
import { engineSupported } from './workerTransport';

export interface SelfTestOptions {
  forceSingle?: boolean;
  /** Duration of the concurrency phase. Default 8000 ms. */
  concurrentMs?: number;
}

const POS = {
  middlegame: 'r2q1rk1/1b1nbppp/p2ppn2/1p6/3NP3/1BN1BP2/PPPQ2PP/2KR3R w - - 0 12',
  italian: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3',
  mateIn2: 'r1b2k1r/ppp1bppp/8/1B1Q4/5q2/2P5/PPP2PPP/R3R1K1 w - - 1 1',
  checkmated: '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1',
  botPositions: [
    START_FEN,
    'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    'r1bqkb1r/pp2pppp/2np1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 2 6',
    'r1bq1rk1/pppnbppp/4pn2/3p2B1/2PP4/2N1PN2/PP3PPP/R2QKB1R w KQ - 1 7',
    '8/5pk1/6p1/8/2R5/6P1/r4P1P/6K1 w - - 0 40',
  ],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function legal(fen: string, uci: string | null | undefined): boolean {
  if (!uci) return false;
  try {
    new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return true;
  } catch {
    return false;
  }
}

function fmtScore(score: Score, fen: string): string {
  const w = toWhitePov(score, fen);
  if (w.kind === 'mate') return w.value >= 0 ? `M${w.value}` : `-M${-w.value}`;
  const v = w.value / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

function fmtLine(fen: string, l: PvLine): string {
  return `#${l.multipv} ${fmtScore(l.score, fen).padStart(6)} d${l.depth} ${pvToSan(fen, l.pv, 4).join(' ')}`;
}

const kn = (n: number | undefined) => (n === undefined ? '?' : `${Math.round(n / 1000)}k`);

/** Runs the diagnostics; every step is logged. Resolves true when everything passed. */
export async function runEngineSelfTest(log: (line: string) => void, opts: SelfTestOptions = {}): Promise<boolean> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const say = (s: string) => log(`[${String(ms()).padStart(6)} ms] ${s}`);
  let failures = 0;
  const check = (ok: boolean, what: string) => {
    say(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures++;
    return ok;
  };

  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  say(`UA: ${nav?.userAgent ?? 'n/a'}`);
  say(
    `cores: ${nav?.hardwareConcurrency ?? '?'}, memory: ${(nav as { deviceMemory?: number } | undefined)?.deviceMemory ?? '?'} GB, ` +
      `WASM SIMD: ${engineSupported() ? 'yes' : 'NO'}`,
  );
  if (!check(engineSupported(), 'browser supports WebAssembly SIMD (iOS 16.4+)')) {
    say('RESULT: FAIL');
    return false;
  }

  let set: EngineSet;
  const tInit = performance.now();
  try {
    set = await createEngines({ forceSingle: opts.forceSingle });
  } catch (e) {
    check(false, `engines start: ${e instanceof Error ? e.message : String(e)}`);
    say('RESULT: FAIL');
    return false;
  }
  check(true, `engines ready in ${Math.round(performance.now() - tInit)} ms (mode: ${set.mode})`);

  try {
    // 1. Depth 12 from the start position.
    let t = performance.now();
    const r1 = await set.analysis.search(START_FEN, { depth: 12 });
    const l1 = r1.lines[0];
    check(
      r1.done && r1.depth === 12 && legal(START_FEN, r1.bestMove),
      `startpos d12: ${r1.bestMove} ${l1 ? fmtScore(l1.score, START_FEN) : ''} in ${Math.round(performance.now() - t)} ms, ` +
        `${kn(l1?.nodes)} nodes, ${kn(l1?.nps)} nps`,
    );

    // 2. MultiPV 3.
    t = performance.now();
    const r2 = await set.analysis.search(POS.middlegame, { depth: 12, multiPv: 3 });
    const distinct = new Set(r2.lines.map((l) => l.pv[0])).size === 3;
    const sameDepth = r2.lines.every((l) => l.depth === r2.depth && !l.bound);
    check(
      r2.lines.length === 3 && distinct && sameDepth && r2.lines.every((l) => legal(POS.middlegame, l.pv[0])),
      `middlegame MultiPV 3 d12 in ${Math.round(performance.now() - t)} ms, ${kn(r2.lines[0]?.nps)} nps`,
    );
    for (const l of r2.lines) say(`     ${fmtLine(POS.middlegame, l)}`);

    // 3. Mate in 2.
    t = performance.now();
    const r3 = await set.analysis.search(POS.mateIn2, { depth: 12 });
    const s3 = r3.lines[0]?.score;
    check(
      s3?.kind === 'mate' && s3.value === 2 && r3.bestMove === 'd5d8',
      `mate in 2: ${r3.bestMove} ${s3 ? fmtScore(s3, POS.mateIn2) : '?'} in ${Math.round(performance.now() - t)} ms`,
    );

    // 4. Terminal position (answered without the engine).
    const r4 = await set.analysis.search(POS.checkmated);
    check(r4.terminal === 'checkmate' && r4.lines.length === 0 && r4.done, 'checkmated position → terminal');

    // 5. Bot strength options.
    t = performance.now();
    const b1 = await set.bot.search(POS.italian, { depth: 10, skillLevel: 3 });
    const b2 = await set.bot.search(POS.italian, { depth: 10, limitStrengthElo: 1500 });
    const b3 = await set.bot.search(POS.italian, { depth: 10 });
    check(
      [b1, b2, b3].every((b) => b.done && legal(POS.italian, b.bestMove)),
      `bot skill 3 / Elo 1500 / full: ${b1.bestMove}, ${b2.bestMove}, ${b3.bestMove} in ${Math.round(performance.now() - t)} ms`,
    );

    // 6. Analysis cache.
    const svc = new AnalysisService(set.analysis, { liveDepth: 14 });
    t = performance.now();
    const c1 = await svc.ensure(POS.italian, { minDepth: 12, multiPv: 2 });
    const tFirst = Math.round(performance.now() - t);
    t = performance.now();
    const c2 = await svc.ensure(POS.italian, { minDepth: 10, multiPv: 1 });
    const tSecond = Math.round(performance.now() - t);
    check(c1.depth >= 12 && c2.depth === c1.depth && tSecond < 20, `analysis cache: ${tFirst} ms, then ${tSecond} ms (cached)`);

    // 7. Both engines at once.
    await concurrency(set, opts.concurrentMs ?? 8000, say, check);
  } catch (e) {
    check(false, `unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    set.terminate();
  }

  const ok = failures === 0;
  say(`RESULT: ${ok ? 'PASS' : `FAIL (${failures})`} in ${(ms() / 1000).toFixed(1)} s`);
  return ok;
}

async function concurrency(
  set: EngineSet,
  durationMs: number,
  say: (s: string) => void,
  check: (ok: boolean, what: string) => boolean,
): Promise<void> {
  say(`concurrency: analysis runs while the bot plays for ${(durationMs / 1000).toFixed(0)} s (${set.mode} mode)…`);
  const ac = new AbortController();
  let last: AnalysisResult | null = null;
  let updates = 0;
  const t = performance.now();
  const analysis = set.analysis.search(POS.middlegame, {
    depth: 60,
    multiPv: 2,
    signal: ac.signal,
    onInfo: (p) => {
      last = p;
      updates++;
    },
  });
  const deadline = performance.now() + durationMs;
  let botMoves = 0;
  let botLegal = true;
  let botNps = 0;
  let botMs = 0;
  while (performance.now() < deadline) {
    const fen = POS.botPositions[botMoves % POS.botPositions.length];
    const tb = performance.now();
    const b = await set.bot.search(fen, { depth: 13, skillLevel: 10 });
    botMs += performance.now() - tb;
    botLegal &&= legal(fen, b.bestMove);
    botNps += b.lines[0]?.nps ?? 0;
    botMoves++;
    await sleep(250); // the "human" thinks
  }
  ac.abort();
  const r = await analysis;
  const best = (last ?? r) as AnalysisResult;
  const aNps = best.lines[0]?.nps;
  check(
    botMoves >= 3 && botLegal,
    `bot: ${botMoves} searches (d13), avg ${Math.round(botMs / Math.max(1, botMoves))} ms, avg ${kn(botNps / Math.max(1, botMoves))} nps`,
  );
  // One worker: analysis only runs between bot moves, so expect less depth.
  const minDepth = set.mode === 'dual' ? 14 : 10;
  check(
    best.depth >= minDepth && updates > 0 && best.lines.every((l) => legal(POS.middlegame, l.pv[0])),
    `analysis: depth ${best.depth} after ${Math.round(performance.now() - t)} ms, ${updates} updates, ${kn(aNps)} nps`,
  );
}
