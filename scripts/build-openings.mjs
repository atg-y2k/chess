#!/usr/bin/env node
// scripts/build-openings.mjs
//
// Builds src/data/openings.json (opening names + the bots' opening book) from the lichess
// chess-openings dataset https://github.com/lichess-org/chess-openings (CC0 / public domain).
// Plain node (>= 18, needs global fetch) + chess.js; no build step. Run it manually when refreshing
// the data and commit the output: it is NOT part of `vite build`.
//
// Usage (from the project root; `npm run build:openings -- <args>` works too):
//   node scripts/build-openings.mjs                       # download a..e.tsv (master) and build
//   node scripts/build-openings.mjs --src path/to/chess-openings   # use local a..e.tsv instead
//   node scripts/build-openings.mjs --ref <sha|tag>       # pin a git ref when downloading
//   node scripts/build-openings.mjs --eval                # + Stockfish soundness pass (cp loss per book move)
//   node scripts/build-openings.mjs --eval --depth 12 --jobs 4 --stockfish path/to/stockfish.js
//   node scripts/build-openings.mjs --out src/data/openings.json   (default)
//
// Without --eval, cp-loss values already present in the existing output file are reused for
// unchanged (position, move) pairs, so refreshing the dataset does not throw evals away.
// With --eval, only positions that have a move without a cp value are (re)evaluated;
// add --eval-all to re-evaluate everything (~4 min on 4 cores at depth 12).
// The engine defaults to the vendored public/engine/stockfish-19-lite-single.{js,wasm}; it is run
// from a `.cjs` copy in the OS temp dir because package.json declares "type": "module".
//
// ---------------------------------------------------------------------------------------------
// Output (keys are EPD = first 4 FEN fields; chess.js >= 1.0 `fen()` only writes an en-passant
// square when an en-passant capture is legal, exactly like python-chess `board.epd()` and the
// `epd` column of lichess' dist/ files, so runtime lookups use chess.js fen() directly):
//
// {
//   "v": 1,
//   "meta":  { source, ref, license, lines, named, positions, edges, maxPly, evalDepth, built },
//   "names": { "<epd>": ["B90", "Sicilian Defense: Najdorf Variation"], ... },
//   "moves": { "<epd>": "e2e4:2033:0 d2d4:1419:4 ...", ... }
// }
//
// names : every position that ends a dataset line (upstream lint guarantees 1 row per EPD).
// moves : every position with >= 1 continuation in some dataset line -> space-separated tokens
//         "uci:weight[:cpLoss]" sorted by weight desc.
//   weight = round(sqrt(L * R)), where
//     L = number of dataset lines that play this move from this position (dataset lines use
//         "the most common move order in master games", so L tracks real move-order popularity)
//     R = number of distinct named positions reachable from the resulting position through the
//         transposition-merged graph (how much named theory is behind the move).
//     sqrt(L*R) damps both failure modes: R alone over-credits transposing moves (1.d4 e6 -> 681),
//     L alone ignores transpositions (1.c4 Nf6 -> 45).
//   cpLoss = Stockfish centipawn loss of the move vs the engine's best move from the mover's point
//     of view (0..999, only with --eval / reused). The dataset contains trap lines ("Fool's Mate",
//     "Sea-Cadet Mate", ...) whose book moves are blunders, so bots must filter on it.
// Book positions = keys(names) U keys(moves).
// ---------------------------------------------------------------------------------------------

import { Chess } from 'chess.js';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const FILES = ['a', 'b', 'c', 'd', 'e'];

function parseArgs(argv) {
  const a = {
    src: null, ref: 'master', out: 'src/data/openings.json',
    eval: false, evalAll: false, depth: 12, jobs: Math.max(1, Math.min(8, cpus().length)), stockfish: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--src') a.src = argv[++i];
    else if (k === '--ref') a.ref = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--eval') a.eval = true;
    else if (k === '--eval-all') a.eval = a.evalAll = true;
    else if (k === '--depth') a.depth = Number(argv[++i]);
    else if (k === '--jobs') a.jobs = Number(argv[++i]);
    else if (k === '--stockfish') a.stockfish = argv[++i];
    else if (k === '-h' || k === '--help') {
      console.log('node scripts/build-openings.mjs [--src dir] [--ref gitref] [--out file] [--eval|--eval-all] [--depth n] [--jobs n] [--stockfish file.js]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${k}`);
  }
  return a;
}

async function loadTsv(args, letter) {
  if (args.src) return readFile(join(args.src, `${letter}.tsv`), 'utf8');
  const url = `https://raw.githubusercontent.com/lichess-org/chess-openings/${args.ref}/${letter}.tsv`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

/** EPD = FEN without halfmove clock and fullmove number. */
const epdOf = (fen) => fen.split(' ').slice(0, 4).join(' ');

/** "1. e4 e5 2. Nf3" -> ["e4", "e5", "Nf3"] */
const sanTokens = (pgn) => pgn.trim().split(/\s+/).filter((t) => t && !/^\d+\.(\.\.)?$/.test(t));

// ------------------------------------------------------------------ Stockfish (optional) ----

/** Vendored engine (public/engine), copied to a runnable `.cjs` (+ its .wasm) in the temp dir. */
function resolveStockfish(explicit) {
  if (explicit) return resolve(explicit);
  const base = 'stockfish-19-lite-single';
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/engine');
  const srcJs = join(srcDir, `${base}.js`);
  const srcWasm = join(srcDir, `${base}.wasm`);
  if (!existsSync(srcJs) || !existsSync(srcWasm)) {
    throw new Error(`${srcJs} not found; pass --stockfish <path to a UCI stockfish .js/.cjs>`);
  }
  const dir = join(tmpdir(), `chesscoach-openings-sf-${statSync(srcWasm).size}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(srcJs, join(dir, `${base}.cjs`));
  copyFileSync(srcWasm, join(dir, `${base}.wasm`));
  return join(dir, `${base}.cjs`);
}

class Engine {
  constructor(file) {
    this.proc = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = '';
    this.listener = null;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        this.listener?.(line);
      }
    });
  }
  send(cmd) { this.proc.stdin.write(cmd + '\n'); }
  /** Send cmd, collect lines until `done(line)` is true. */
  run(cmd, done) {
    return new Promise((res) => {
      const lines = [];
      this.listener = (l) => { lines.push(l); if (done(l)) { this.listener = null; res(lines); } };
      this.send(cmd);
    });
  }
  async init() {
    await this.run('uci', (l) => l === 'uciok');
    this.send('setoption name Hash value 32');
    await this.run('isready', (l) => l === 'readyok');
  }
  /** Returns Map(uci -> score in cp from side-to-move POV) for the final depth. */
  async search(epd, depth, searchmoves) {
    const multipv = searchmoves ? searchmoves.length : 1;
    this.send('ucinewgame'); // clear hash -> results independent of task scheduling (deterministic)
    this.send(`setoption name MultiPV value ${multipv}`);
    this.send(`position fen ${epd} 0 1`);
    const lines = await this.run(
      `go depth ${depth}${searchmoves ? ' searchmoves ' + searchmoves.join(' ') : ''}`,
      (l) => l.startsWith('bestmove'),
    );
    const byPv = new Map();
    for (const l of lines) {
      if (!l.startsWith('info ') || !l.includes(' pv ') || /bound/.test(l)) continue;
      const pv = Number(/ multipv (\d+)/.exec(l)?.[1] ?? 1);
      const m = / score (cp|mate) (-?\d+)/.exec(l);
      if (!m) continue;
      const n = Number(m[2]);
      const score = m[1] === 'cp' ? n : n > 0 ? 10000 - n : -10000 - n;
      byPv.set(pv, [/ pv (\S+)/.exec(l)[1], score]);
    }
    return new Map(byPv.values());
  }
  quit() { this.send('quit'); this.proc.stdin.end(); }
}

/** tasks: [{epd, ucis}] -> Map(epd -> Map(uci -> cpLoss)) */
async function evaluate(tasks, { depth, jobs, stockfish }) {
  const file = resolveStockfish(stockfish);
  const result = new Map();
  let next = 0, done = 0;
  const t0 = Date.now();
  const worker = async () => {
    const e = new Engine(file);
    await e.init();
    while (next < tasks.length) {
      const { epd, ucis } = tasks[next++];
      const best = Math.max(...(await e.search(epd, depth, null)).values());
      const scores = await e.search(epd, depth, ucis);
      const losses = new Map();
      for (const u of ucis) {
        const s = scores.get(u);
        losses.set(u, s === undefined ? 999 : Math.min(999, Math.max(0, best - s)));
      }
      result.set(epd, losses);
      if (++done % 250 === 0 || done === tasks.length) {
        const secs = (Date.now() - t0) / 1000;
        console.log(`  eval ${done}/${tasks.length} positions, ${secs.toFixed(0)}s`);
      }
    }
    e.quit();
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  return result;
}

// ------------------------------------------------------------------------------- build ----

async function main() {
  const args = parseArgs(process.argv);
  const START_EPD = epdOf(new Chess().fen());

  const names = new Map(); // epd -> [eco, name]
  const edges = new Map(); // epd -> Map(uci -> child epd)
  const edgeLines = new Map(); // "epd|uci" -> number of dataset lines playing it
  const problems = [];
  let lines = 0, maxPly = 0;

  for (const letter of FILES) {
    const rows = (await loadTsv(args, letter)).split(/\r?\n/);
    rows.forEach((row, idx) => {
      if (!row.trim()) return;
      const cols = row.split('\t');
      if (idx === 0) {
        if (cols.join(',') !== 'eco,name,pgn') throw new Error(`${letter}.tsv: unexpected header "${row}"`);
        return;
      }
      if (cols.length !== 3) return void problems.push(`${letter}.tsv:${idx + 1}: expected 3 columns`);
      const [eco, name, pgn] = cols;
      const chess = new Chess();
      const sans = sanTokens(pgn);
      const path = [];
      let prev = START_EPD;
      try {
        for (const san of sans) {
          const mv = chess.move(san); // throws on illegal / ambiguous SAN (chess.js 1.x)
          const uci = mv.from + mv.to + (mv.promotion ?? '');
          const next = epdOf(mv.after);
          path.push([prev, uci, next]);
          prev = next;
        }
      } catch (e) {
        return void problems.push(`${letter}.tsv:${idx + 1}: ${name}: ${e.message}`);
      }
      const seenInLine = new Set();
      for (const [from, uci, to] of path) {
        let out = edges.get(from);
        if (!out) edges.set(from, (out = new Map()));
        out.set(uci, to);
        const key = `${from}|${uci}`;
        if (!seenInLine.has(key)) {
          seenInLine.add(key);
          edgeLines.set(key, (edgeLines.get(key) ?? 0) + 1);
        }
      }
      lines++;
      maxPly = Math.max(maxPly, sans.length);
      if (names.has(prev)) problems.push(`${letter}.tsv:${idx + 1}: duplicate EPD, dropping "${name}"`);
      else names.set(prev, [eco, name]);
    });
  }

  // R(epd) = distinct named positions reachable from epd (incl. itself); per-root visited set
  // is robust to (theoretical) cycles and cheap at this size (~8k nodes).
  const reachCache = new Map();
  const reach = (root) => {
    if (reachCache.has(root)) return reachCache.get(root);
    const seen = new Set([root]);
    const stack = [root];
    let count = 0;
    while (stack.length) {
      const n = stack.pop();
      if (names.has(n)) count++;
      for (const child of edges.get(n)?.values() ?? []) {
        if (!seen.has(child)) { seen.add(child); stack.push(child); }
      }
    }
    reachCache.set(root, count);
    return count;
  };

  // ---- cp losses: reuse from existing output, optionally evaluate missing ones
  const cp = new Map(); // "epd|uci" -> cpLoss
  const outPath = resolve(args.out);
  let evalDepth = null;
  if (existsSync(outPath) && !args.evalAll) {
    try {
      const old = JSON.parse(await readFile(outPath, 'utf8'));
      evalDepth = old.meta?.evalDepth ?? null;
      for (const [epd, s] of Object.entries(old.moves ?? {})) {
        for (const tok of s.split(' ')) {
          const [u, , c] = tok.split(':');
          if (c !== undefined) cp.set(`${epd}|${u}`, Number(c));
        }
      }
    } catch { /* ignore unreadable previous output */ }
  }
  if (args.eval) {
    const tasks = [];
    for (const [epd, out] of edges) {
      const ucis = [...out.keys()];
      if (args.evalAll || ucis.some((u) => !cp.has(`${epd}|${u}`))) tasks.push({ epd, ucis });
    }
    tasks.sort((x, y) => (x.epd < y.epd ? -1 : 1));
    if (tasks.length) {
      console.log(`evaluating ${tasks.length} positions at depth ${args.depth} with ${args.jobs} engine(s)...`);
      const res = await evaluate(tasks, args);
      for (const [epd, m] of res) for (const [u, c] of m) cp.set(`${epd}|${u}`, c);
      evalDepth = args.depth;
    } else console.log('eval: nothing to do (all book moves already have cp values)');
  }

  // ---- serialise (sorted keys => deterministic output, small diffs, ~25% better gzip)
  const namesOut = {};
  for (const epd of [...names.keys()].sort()) namesOut[epd] = names.get(epd);
  const movesOut = {};
  let edgeCount = 0, dubious = 0;
  for (const epd of [...edges.keys()].sort()) {
    const list = [...edges.get(epd)].map(([uci, child]) => {
      const w = Math.max(1, Math.round(Math.sqrt(edgeLines.get(`${epd}|${uci}`) * reach(child))));
      const c = cp.get(`${epd}|${uci}`);
      if (c !== undefined && c >= 150) dubious++;
      return { uci, w, c };
    });
    list.sort((a, b) => b.w - a.w || (a.uci < b.uci ? -1 : 1));
    edgeCount += list.length;
    movesOut[epd] = list.map(({ uci, w, c }) => (c === undefined ? `${uci}:${w}` : `${uci}:${w}:${c}`)).join(' ');
  }

  const allPositions = new Set([...names.keys(), ...edges.keys()]);
  const result = {
    v: 1,
    meta: {
      source: 'https://github.com/lichess-org/chess-openings',
      ref: args.src ? 'local' : args.ref,
      license: 'CC0-1.0',
      lines,
      named: names.size,
      positions: allPositions.size,
      edges: edgeCount,
      maxPly,
      evalDepth,
      built: new Date().toISOString().slice(0, 10),
    },
    names: namesOut,
    moves: movesOut,
  };

  const json = JSON.stringify(result);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, json + '\n');

  for (const p of problems) console.warn('WARN', p);
  const kib = (n) => (n / 1024).toFixed(1) + ' KiB';
  console.log(
    `openings: ${lines} lines, ${names.size} named, ${allPositions.size} book positions, ` +
      `${edgeCount} book moves (${cp.size ? dubious + ' with cpLoss>=150' : 'no evals'}), max ${maxPly} plies`,
  );
  console.log(`wrote ${args.out}: ${kib(Buffer.byteLength(json))} raw, ${kib(gzipSync(json, { level: 9 }).length)} gzip`);
  if (problems.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
