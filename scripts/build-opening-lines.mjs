#!/usr/bin/env node
// scripts/build-opening-lines.mjs
//
// Builds src/data/opening-lines.json (the catalog behind the Openings section: every named line of
// the lichess chess-openings dataset with its moves, plus a per-family index) from
// https://github.com/lichess-org/chess-openings (CC0 / public domain).
// Plain node (>= 18, needs global fetch) + chess.js; no build step. Run it manually when refreshing
// the data and commit the output: it is NOT part of `vite build`.
//
// The dataset is pinned to DEFAULT_REF, the commit src/data/openings.json (the opening book, see
// scripts/build-openings.mjs) was built from, so every catalog line is also book: refresh both
// files together with the same --ref, book first (popularity is read from it).
//
// Usage (from the project root; to add an npm script for it, use
// "build:opening-lines": "node scripts/build-opening-lines.mjs"):
//   node scripts/build-opening-lines.mjs                          # download a..e.tsv at DEFAULT_REF
//   node scripts/build-opening-lines.mjs --ref <sha|tag|master>   # another git ref
//   node scripts/build-opening-lines.mjs --src path/to/chess-openings   # local a..e.tsv instead
//   node scripts/build-opening-lines.mjs --book src/data/openings.json  (default; popularity source)
//   node scripts/build-opening-lines.mjs --out src/data/opening-lines.json  (default)
//
// ---------------------------------------------------------------------------------------------
// Output (the runtime, src/openings/catalog.ts, derives the rest: ids, family/variation, and the
// UCI moves and final position of a line on first use, by replaying its SAN with chess.js):
//
// {
//   "v": 1,
//   "meta": { source, ref, license, lines, families, maxPly, built, cols },
//   "lines": [[eco, name, san, pop], ...],                               // dataset order (by ECO)
//   "families": { "<family>": { n, eco, main, w, pop, side }, ... }      // by w, descending
// }
//
// lines (tuples, column order in meta.cols):
//   san  space-separated SAN moves from the initial position (no move numbers).
//   pop  popularity, 0..1: product over the line's moves of weight / sum of sibling weights in
//        openings.json (3 significant digits); 0 if the book does not know a move. The book
//        weights count named dataset lines, not games: this ranks how central a line is to
//        opening theory, not how often it is played.
// families (family = the name before ":", with ", with ..." suffixes folded in, see splitLineName):
//   n     number of lines; eco: "B20-B99" (or a single code);
//   main  index (in "lines") of the main line: the family's base line (the line named exactly the
//         family, e.g. "Benoni Defense", not "Benoni Defense: Old Benoni"), the most popular one when
//         the dataset repeats it (then the shortest); a family without a base line takes its
//         shortest line (ties: the book weight of its last move, then pop). Then by SAN;
//   w     book weight (openings.json) of the main line's last move from the position before it:
//         how much named theory starts the family that way (the sort key);
//   pop   the main line's pop; side: the side that chooses the opening ("w" | "b"), from the
//         family name ("Defense" -> b, "Opening" -> w, see sidesOf) or else the main line's last move,
//         with SIDE_OVERRIDES for the few families those rules get wrong.
// Line ids ("b90-sicilian-defense-najdorf-variation") are derived at runtime from eco + name, see
// buildCatalog() in src/openings/catalog.ts (mirrored by lineIds() here). Saved drill progress is
// keyed by them, so the build warns when a refresh gives an existing id to other moves or drops it.
// ---------------------------------------------------------------------------------------------

import { Chess } from 'chess.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const FILES = ['a', 'b', 'c', 'd', 'e'];

/**
 * lichess-org/chess-openings master from 2026-09-20 to 2026-10-02 (3815 lines; checked on
 * 2026-10-06): the data src/data/openings.json was built from (its `names` match these TSVs exactly).
 */
const DEFAULT_REF = 'c67912be581f0793dbaa776be5ccf111e01f88d9';

function parseArgs(argv) {
  const a = { src: null, ref: DEFAULT_REF, out: 'src/data/opening-lines.json', book: 'src/data/openings.json' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--src') a.src = argv[++i];
    else if (k === '--ref') a.ref = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--book') a.book = argv[++i];
    else if (k === '-h' || k === '--help') {
      console.log('node scripts/build-opening-lines.mjs [--src dir] [--ref gitref] [--book openings.json] [--out file]');
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

/**
 * Family and variation of a dataset name. Keep in sync with splitLineName in
 * src/openings/catalog.ts (tests/openings check the families index against it).
 */
function splitLineName(name) {
  const i = name.indexOf(':');
  let family = i < 0 ? name : name.slice(0, i);
  let variation = i < 0 ? '' : name.slice(i + 1).trim();
  const w = family.indexOf(', with ');
  if (w > 0) {
    const extra = family.slice(w + 2);
    family = family.slice(0, w);
    variation = variation ? `${extra}, ${variation}` : extra;
  }
  return { family, variation };
}

/** Families whose side the naming rules below get wrong (checked in tests/openings/data.test.ts). */
const SIDE_OVERRIDES = new Map([
  ['Creepy Crawly Formation', 'w'], // 1.h3 and 2.a3: White's setup, though its only line ends on a Black move
]);

/**
 * The side that chooses each family's opening (Map family -> "w" | "b"). "X Gambit Accepted" /
 * "Declined" (and "... Game Accepted") belong to the side facing X; otherwise "... Defense",
 * "Countergambit", "Accepted" and "Declined" are Black's, "... Opening", "Attack", "System" and
 * "Game" White's, and anything else (gambits, formations) belongs to whoever plays the main line's
 * last move.
 * @param mainPlies Map family -> number of plies of its main line.
 */
function sidesOf(mainPlies) {
  const own = (family) => {
    if (/Defen[cs]e|Countergambit|Accepted|Declined/.test(family)) return 'b';
    if (/Opening|Attack|System|Game/.test(family)) return 'w';
    return mainPlies.get(family) % 2 ? 'w' : 'b';
  };
  const sides = new Map();
  for (const family of mainPlies.keys()) {
    const m = /^(.*) (Accepted|Declined)$/.exec(family);
    if (SIDE_OVERRIDES.has(family)) sides.set(family, SIDE_OVERRIDES.get(family));
    else if (m && /[Gg]ambit|Game/.test(m[1]) && mainPlies.has(m[1])) sides.set(family, own(m[1]) === 'w' ? 'b' : 'w');
    else sides.set(family, own(family));
  }
  return sides;
}

/** Book weights from openings.json: Map(epd -> Map(uci -> weight)), plus its names table. */
async function loadBook(path) {
  if (!existsSync(path)) return null;
  const book = JSON.parse(await readFile(path, 'utf8'));
  const moves = new Map();
  for (const [epd, s] of Object.entries(book.moves)) {
    moves.set(
      epd,
      new Map(
        s.split(' ').map((tok) => {
          const [u, w] = tok.split(':');
          return [u, Number(w)];
        }),
      ),
    );
  }
  return { moves, names: book.names };
}

/**
 * Lower-case text without accents or apostrophes, other punctuation as single spaces. Keep in sync
 * with normalizeText in src/openings/catalog.ts.
 */
function normalizeText(s) {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['\u2018\u2019`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** 32-bit FNV-1a in base 36 (same as hash36 in src/openings/catalog.ts). */
function hash36(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Line ids as src/openings/catalog.ts (buildCatalog) derives them: the slug of ECO + name; when
 * the dataset repeats a slug, its shortest line keeps it and the others get "-" + a hash of their
 * moves. Map id -> SAN (space-separated).
 */
function lineIds(rows) {
  const bySlug = new Map();
  for (const r of rows) {
    const slug = normalizeText(`${r.eco} ${r.name}`).replace(/ /g, '-');
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(r);
  }
  const ids = new Map();
  for (const [slug, group] of bySlug) {
    const plies = (s) => s.split(' ').length;
    group.sort((a, b) => plies(a.san) - plies(b.san) || (a.san < b.san ? -1 : a.san > b.san ? 1 : 0));
    group.forEach((r, i) => {
      let id = i === 0 ? slug : `${slug}-${hash36(r.san)}`;
      while (ids.has(id)) id += 'x';
      ids.set(id, r.san);
    });
  }
  return ids;
}

async function main() {
  const args = parseArgs(process.argv);
  const START_EPD = epdOf(new Chess().fen());
  const book = await loadBook(resolve(args.book));
  const problems = [];
  const warnings = [];
  if (!book) warnings.push(`${args.book} not found: every pop and weight is 0`);

  const lines = []; // { eco, name, family, san: string[], pop, lastWeight }
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
      const san = [];
      let pop = 1;
      let lastWeight = 0;
      let epd = START_EPD;
      try {
        for (const token of sanTokens(pgn)) {
          const mv = chess.move(token); // throws on illegal / ambiguous SAN (chess.js 1.x)
          const uci = mv.from + mv.to + (mv.promotion ?? '');
          const siblings = book?.moves.get(epd);
          const w = siblings?.get(uci) ?? 0;
          let total = 0;
          for (const x of siblings?.values() ?? []) total += x;
          pop *= total ? w / total : 0;
          lastWeight = w;
          san.push(mv.san); // canonical SAN (the dataset's own tokens may differ, e.g. "+" marks)
          epd = epdOf(mv.after);
        }
      } catch (e) {
        return void problems.push(`${letter}.tsv:${idx + 1}: ${name}: ${e.message}`);
      }
      if (!san.length) return void problems.push(`${letter}.tsv:${idx + 1}: ${name}: no moves`);
      if (book && pop === 0) warnings.push(`${letter}.tsv:${idx + 1}: ${name}: a move is not in ${args.book}`);
      if (book && JSON.stringify(book.names[epd]) !== JSON.stringify([eco, name])) {
        warnings.push(`${letter}.tsv:${idx + 1}: ${name}: not named so in ${args.book} (rebuild it with --ref ${args.ref})`);
      }
      const { family, variation } = splitLineName(name);
      lines.push({ index: lines.length, eco, name, family, base: variation === '', san, pop, lastWeight });
    });
  }

  // ---- families index
  const byFamily = new Map();
  for (const l of lines) {
    if (!byFamily.has(l.family)) byFamily.set(l.family, []);
    byFamily.get(l.family).push(l);
  }
  const mains = new Map(
    [...byFamily].map(([family, members]) => {
      const bases = members.filter((l) => l.base);
      const byPop = (x, y) =>
        y.pop - x.pop || x.san.length - y.san.length || y.lastWeight - x.lastWeight || (x.san.join(' ') < y.san.join(' ') ? -1 : 1);
      const byLength = (x, y) =>
        x.san.length - y.san.length || y.lastWeight - x.lastWeight || y.pop - x.pop || (x.san.join(' ') < y.san.join(' ') ? -1 : 1);
      return [family, bases.length ? bases.sort(byPop)[0] : members.slice().sort(byLength)[0]];
    }),
  );
  const sides = sidesOf(new Map([...mains].map(([family, main]) => [family, main.san.length])));
  const families = [...byFamily].map(([family, members]) => {
    const main = mains.get(family);
    const ecos = members.map((l) => l.eco).sort();
    const eco = ecos[0] === ecos.at(-1) ? ecos[0] : `${ecos[0]}-${ecos.at(-1)}`;
    return { family, n: members.length, eco, main: main.index, w: main.lastWeight, pop: main.pop, side: sides.get(family) };
  });
  families.sort((x, y) => y.w - x.w || y.pop - x.pop || (x.family < y.family ? -1 : 1));

  const sig = (p) => Number(p.toPrecision(3));
  const meta = {
    source: 'https://github.com/lichess-org/chess-openings',
    ref: args.src ? 'local' : args.ref,
    license: 'CC0-1.0',
    lines: lines.length,
    families: families.length,
    maxPly: Math.max(...lines.map((l) => l.san.length)),
    built: new Date().toISOString().slice(0, 10),
    cols: ['eco', 'name', 'san', 'pop'],
  };
  // One entry per text line: readable, small diffs when the dataset changes.
  const json =
    `{"v":1,"meta":${JSON.stringify(meta)},\n"lines":[\n` +
    lines.map((l) => JSON.stringify([l.eco, l.name, l.san.join(' '), sig(l.pop)])).join(',\n') +
    '\n],\n"families":{\n' +
    families
      .map(({ family, n, eco, main, w, pop, side }) => `${JSON.stringify(family)}:${JSON.stringify({ n, eco, main, w, pop: sig(pop), side })}`)
      .join(',\n') +
    '\n}}\n';
  JSON.parse(json); // sanity check
  const outPath = resolve(args.out);
  if (existsSync(outPath)) {
    // Saved progress is keyed by line id: flag ids that a refresh moves to other moves or drops.
    try {
      const prev = JSON.parse(await readFile(outPath, 'utf8'));
      const before = lineIds(prev.lines.map(([eco, name, san]) => ({ eco, name, san })));
      const after = lineIds(lines.map((l) => ({ eco: l.eco, name: l.name, san: l.san.join(' ') })));
      for (const [id, san] of before) {
        if (!after.has(id)) warnings.push(`line id ${id} (${san}) is gone: saved progress for it is orphaned`);
        else if (after.get(id) !== san) warnings.push(`line id ${id} moved from "${san}" to "${after.get(id)}"`);
      }
    } catch (e) {
      warnings.push(`could not compare line ids with the previous ${args.out}: ${e.message}`);
    }
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, json);

  for (const w of warnings.slice(0, 50)) console.warn('WARN', w);
  if (warnings.length > 50) console.warn(`WARN ... and ${warnings.length - 50} more`);
  for (const p of problems) console.error('ERROR', p);
  const kib = (n) => (n / 1024).toFixed(1) + ' KiB';
  console.log(`opening lines: ${lines.length} lines, ${families.length} families, max ${meta.maxPly} plies`);
  console.log(`wrote ${args.out}: ${kib(Buffer.byteLength(json))} raw, ${kib(gzipSync(json, { level: 9 }).length)} gzip`);
  if (problems.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
