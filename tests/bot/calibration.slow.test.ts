/**
 * Slow, opt-in calibration check: real bot-vs-bot games with the vendored Stockfish WASM running in
 * node child processes (one per side, driven by the tiny UCI driver below), through the real
 * BotPlayer (book + plans + chooseMove, no think delay).
 *
 *   CALIBRATE=1 npx vitest run tests/bot/calibration.slow.test.ts
 *   CALIBRATE=1 CALIBRATE_GAMES=10 CALIBRATE_PAIRS=400:1000,1000:1600,1600:2400 npx vitest run tests/bot/calibration.slow.test.ts
 *
 * CALIBRATE_GAMES = games per pairing (colours alternate, default 2); CALIBRATE_PAIRS = comma
 * separated `eloA:eloB` pairings. Games are capped at 200 plies and then adjudicated by a depth-12
 * search (|eval| >= 400 cp wins). This is a smoke test of the whole pipeline, not a rating
 * measurement: use dozens of games per pairing for Elo estimates (see research/strength.md).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { BotPlayer } from '../../src/bot/BotPlayer';
import { hashSeed, mulberry32, scoreCp } from '../../src/bot/strength';
import type { AnalysisResult, ChessEngine, PvLine, Score, SearchOptions } from '../../src/engine/types';

const RUN = !!process.env.CALIBRATE;
const GAMES = Math.max(1, Number(process.env.CALIBRATE_GAMES ?? 2) || 2);
const PAIRS: [number, number][] = (process.env.CALIBRATE_PAIRS ?? '250:1400,1000:2200,1600:3200')
  .split(',')
  .map((p) => p.split(':').map(Number) as [number, number]);
const PLY_CAP = 200;

// -------------------------------------------------------------------------------------------------
// Tiny UCI driver (ChessEngine over a node child process)

/** Runnable copy of the vendored engine: package.json is "type": "module", so node needs `.cjs`. */
function engineScript(): string {
  const srcDir = fileURLToPath(new URL('../../public/engine/', import.meta.url));
  const base = 'stockfish-19-lite-single';
  const wasm = join(srcDir, `${base}.wasm`);
  const dir = join(tmpdir(), `chesscoach-bot-sf-${statSync(wasm).size}`);
  mkdirSync(dir, { recursive: true });
  const js = join(dir, `${base}.cjs`);
  if (!existsSync(js)) copyFileSync(join(srcDir, `${base}.js`), js);
  if (!existsSync(join(dir, `${base}.wasm`))) copyFileSync(wasm, join(dir, `${base}.wasm`));
  return js;
}

interface Waiter {
  done: (line: string) => boolean;
  lines: string[];
  resolve: (lines: string[]) => void;
}

class UciEngine implements ChessEngine {
  private proc: ChildProcess | null = null;
  private buf = '';
  private waiter: Waiter | null = null;
  private multiPv = 1;
  private ready: Promise<void> | null = null;
  /** Serialises engine conversations (BotPlayer fires newGame without awaiting it). */
  private queue: Promise<unknown> = Promise.resolve();
  /** Wall time of every search (ms). */
  readonly searchMs: number[] = [];

  init(): Promise<void> {
    this.ready ??= (async () => {
      const proc = spawn(process.execPath, [engineScript()], { stdio: ['pipe', 'pipe', 'ignore'] });
      this.proc = proc;
      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (chunk: string) => {
        this.buf += chunk;
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          const w = this.waiter;
          if (!line || !w) continue;
          w.lines.push(line);
          if (w.done(line)) {
            this.waiter = null;
            w.resolve(w.lines);
          }
        }
      });
      await this.run('uci', (l) => l === 'uciok');
      this.send('setoption name Hash value 16');
      await this.run('isready', (l) => l === 'readyok');
    })();
    return this.ready;
  }

  private send(cmd: string): void {
    this.proc?.stdin?.write(`${cmd}\n`);
  }

  private run(cmd: string, done: (line: string) => boolean): Promise<string[]> {
    return new Promise((resolve) => {
      this.waiter = { done, lines: [], resolve };
      this.send(cmd);
    });
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const p = this.queue.then(op);
    this.queue = p.catch(() => {});
    return p;
  }

  search(fen: string, opts: SearchOptions = {}): Promise<AnalysisResult> {
    return this.serial(() => this.doSearch(fen, opts));
  }

  private async doSearch(fen: string, opts: SearchOptions): Promise<AnalysisResult> {
    await this.init();
    const chess = new Chess(fen);
    const legal = chess.moves().length;
    if (!legal) return { fen, depth: 0, lines: [], bestMove: null, done: true, terminal: chess.inCheck() ? 'checkmate' : 'stalemate' };
    const multiPv = Math.max(1, Math.min(256, opts.multiPv ?? 1));
    if (multiPv !== this.multiPv) {
      this.multiPv = multiPv;
      this.send(`setoption name MultiPV value ${multiPv}`);
      await this.run('isready', (l) => l === 'readyok');
    }
    const go = ['go'];
    if (opts.depth) go.push('depth', String(opts.depth));
    if (opts.nodes) go.push('nodes', String(opts.nodes));
    if (go.length === 1) go.push('depth', '10');
    this.send(`position fen ${chess.fen()}`);
    const t0 = performance.now();
    const out = await this.run(go.join(' '), (l) => l.startsWith('bestmove'));
    this.searchMs.push(performance.now() - t0);
    return parseSearch(fen, out, Math.min(multiPv, legal));
  }

  stop(): void {
    this.send('stop');
  }

  newGame(): Promise<void> {
    return this.serial(async () => {
      await this.init();
      this.send('ucinewgame');
      await this.run('isready', (l) => l === 'readyok');
    });
  }

  terminate(): void {
    this.send('quit');
    this.proc?.kill();
  }
}

/** Lines of the deepest complete, exact MultiPV batch (falls back to the latest line per rank). */
function parseSearch(fen: string, out: string[], want: number): AnalysisResult {
  const byDepth = new Map<number, Map<number, PvLine>>();
  const latest = new Map<number, PvLine>();
  let bestMove: string | null = null;
  for (const l of out) {
    if (l.startsWith('bestmove')) {
      const m = l.split(/\s+/)[1];
      bestMove = m && m !== '(none)' ? m : null;
      continue;
    }
    const m = /^info .*?\bdepth (\d+) .*?\bmultipv (\d+) .*?\bscore (cp|mate) (-?\d+)( lowerbound| upperbound)?.*? pv (.+)$/.exec(l);
    if (!m) continue;
    const line: PvLine = {
      multipv: Number(m[2]),
      depth: Number(m[1]),
      score: { kind: m[3] as Score['kind'], value: Number(m[4]) },
      pv: m[6].trim().split(/\s+/),
    };
    latest.set(line.multipv, line);
    if (m[5]) continue;
    if (!byDepth.has(line.depth)) byDepth.set(line.depth, new Map());
    byDepth.get(line.depth)!.set(line.multipv, line);
  }
  const complete = [...byDepth.entries()].filter(([, b]) => b.size >= want).sort((a, b) => b[0] - a[0])[0];
  const lines = [...(complete ? complete[1] : latest).values()].sort((a, b) => a.multipv - b.multipv);
  return { fen, depth: lines[0]?.depth ?? 0, lines, bestMove, done: true };
}

// -------------------------------------------------------------------------------------------------
// Games

interface GameRecord {
  white: number;
  black: number;
  /** Score of the white side. */
  whiteScore: number;
  plies: number;
  end: string;
  bookPlies: number;
}

async function playGame(white: number, black: number, seed: number, engines: [UciEngine, UciEngine]): Promise<GameRecord> {
  const bots = [
    new BotPlayer(engines[0], { rng: mulberry32(seed), thinkDelay: false }),
    new BotPlayer(engines[1], { rng: mulberry32(seed ^ 0x9e3779b9), thinkDelay: false }),
  ];
  await Promise.all([bots[0].newGame(white), bots[1].newGame(black)]);
  const chess = new Chess();
  const history: string[] = [];
  let bookPlies = 0;
  while (!chess.isGameOver() && history.length < PLY_CAP) {
    const side = chess.turn() === 'w' ? 0 : 1;
    const m = await bots[side].move(chess.fen(), side === 0 ? white : black, history);
    if (!m) throw new Error(`bot returned no move in ${chess.fen()}`);
    chess.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] }); // throws if illegal
    history.push(m.uci);
    if (m.source === 'book') bookPlies++;
  }
  let whiteScore = 0.5;
  let end: string;
  if (chess.isCheckmate()) {
    whiteScore = chess.turn() === 'w' ? 0 : 1;
    end = 'mate';
  } else if (chess.isGameOver()) {
    if (chess.isStalemate()) end = 'stalemate';
    else if (chess.isInsufficientMaterial()) end = 'material';
    else end = chess.isThreefoldRepetition() ? 'repetition' : '50-move';
  } else {
    const judge = await engines[0].search(chess.fen(), { depth: 12, multiPv: 1 });
    const cp = scoreCp(judge.lines[0].score) * (chess.turn() === 'w' ? 1 : -1);
    whiteScore = cp >= 400 ? 1 : cp <= -400 ? 0 : 0.5;
    end = 'adjudicated';
  }
  return { white, black, whiteScore, plies: history.length, end, bookPlies };
}

describe.skipIf(!RUN)('bot calibration (real engine, CALIBRATE=1)', () => {
  it(
    'stronger bots beat weaker ones; all moves legal; search time stays bounded',
    async () => {
      const t0 = performance.now();
      const results = await Promise.all(
        PAIRS.map(async ([a, b], pi) => {
          const engines: [UciEngine, UciEngine] = [new UciEngine(), new UciEngine()];
          const games: GameRecord[] = [];
          try {
            for (let g = 0; g < GAMES; g++) {
              const aWhite = g % 2 === 0;
              games.push(await playGame(aWhite ? a : b, aWhite ? b : a, hashSeed(`cal-${pi}-${g}`), engines));
            }
          } finally {
            engines.forEach((e) => e.terminate());
          }
          const scoreA = games.reduce((s, r) => s + (r.white === a ? r.whiteScore : 1 - r.whiteScore), 0);
          const times = engines.flatMap((e) => e.searchMs);
          return { a, b, games, scoreA, maxSearchMs: Math.max(0, ...times) };
        }),
      );

      console.log(`\nBot calibration: ${GAMES} game(s) per pairing, ${((performance.now() - t0) / 1000).toFixed(1)} s total`);
      let strongerPoints = 0;
      let total = 0;
      for (const r of results) {
        const ends = r.games.map((g) => `${g.end}/${g.plies}p/book${g.bookPlies}`).join(', ');
        console.log(
          `  ${String(r.a).padStart(4)} vs ${String(r.b).padEnd(4)}  ${r.scoreA}-${GAMES - r.scoreA}` +
            `  max search ${Math.round(r.maxSearchMs)} ms  [${ends}]`,
        );
        strongerPoints += r.a > r.b ? r.scoreA : GAMES - r.scoreA;
        total += GAMES;
        for (const g of r.games) expect(g.plies).toBeGreaterThan(0);
        // Node caps: even full strength stays within a few seconds per move on this machine.
        expect(r.maxSearchMs).toBeLessThan(8000);
      }
      console.log(`  stronger side scored ${strongerPoints}/${total}`);
      expect(strongerPoints / total).toBeGreaterThan(0.5);
    },
    60 * 60 * 1000,
  );
});
