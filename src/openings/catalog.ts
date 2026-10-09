/**
 * The opening catalog behind the Openings section: every named line of the lichess chess-openings
 * dataset (CC0), grouped into families, with search. Data: src/data/opening-lines.json, built by
 * scripts/build-opening-lines.mjs from the same dataset commit as the opening book
 * (src/data/openings.json), so every catalog line is book and its final position is named by
 * `openingAt()` with the line's own ECO code and name.
 *
 * The table (~60 KiB gzip) is lazy-loaded with a dynamic import, like the book: call
 * `loadCatalog()` once; every other function is synchronous and returns "nothing" (null / [])
 * until it has loaded. Nothing here needs the opening book. Browsing and searching are free
 * features (see OPENINGS_FEATURE_TIERS in ./index).
 */
import { Chess } from 'chess.js';
import { fenKey, toUci } from '../chess/utils';
import type { Color } from '../game/types';

/** Where the data comes from (for the licenses / about screens). */
export interface CatalogMeta {
  source: string;
  /** Git commit of lichess-org/chess-openings the data was built from. */
  ref: string;
  license: string;
  lines: number;
  families: number;
  maxPly: number;
  /** Build date, YYYY-MM-DD. */
  built: string;
}

/** One named line of the dataset. Frozen; `uci` and `epd` are computed on first access. */
export interface OpeningLine {
  /**
   * Id: slug of ECO + name ("b90-sicilian-defense-najdorf-variation"). The dataset repeats a few
   * names with other move orders: the shortest keeps the plain slug, the others get "-" + a hash
   * of their moves. Saved progress is keyed by it; ids stay the same as long as the pinned dataset
   * does (scripts/build-opening-lines.mjs warns when a refresh would change one).
   */
  readonly id: string;
  readonly eco: string;
  /** Full dataset name ("Sicilian Defense: Najdorf Variation"), as `openingAt()` names the final position. */
  readonly name: string;
  /** "Sicilian Defense" (see `splitLineName`). */
  readonly family: string;
  /** "Najdorf Variation"; '' for a family's base line. */
  readonly variation: string;
  /** SAN moves from the initial position. */
  readonly san: readonly string[];
  /** UCI moves from the initial position ("e2e4", "e7e8q"). */
  readonly uci: readonly string[];
  /** EPD (first 4 FEN fields, as chess.js writes them) of the final position. */
  readonly epd: string;
  /** Number of plies (half-moves). */
  readonly plies: number;
  /**
   * 0..1: the product of each move's book share among its siblings (see TreeMove.share): how central
   * the line is to opening theory. A score for sorting, NOT how often the line occurs in games (the
   * book weights count named dataset lines, not games), so do not show it as "% of games".
   */
  readonly popularity: number;
}

/** An opening family ("Sicilian Defense") with its index entry. */
export interface OpeningFamily {
  readonly name: string;
  /** Number of lines in the family. */
  readonly lineCount: number;
  /** "B20-B99", or one code ("D06"). */
  readonly ecoRange: string;
  /**
   * The family's main line: its base line (named exactly the family, e.g. "Benoni Defense"), the
   * most popular one if the dataset repeats it; else its shortest line.
   */
  readonly mainLineId: string;
  /**
   * Book weight of the main line's last move: how much named theory starts the family that way (a
   * proxy for importance, not a game count). `families()` sorts by it.
   */
  readonly weight: number;
  /** The main line's popularity (0..1, see OpeningLine.popularity). */
  readonly popularity: number;
  /** The side that chooses this opening ("Sicilian Defense" -> 'b', "Ruy Lopez" -> 'w'). */
  readonly side: Color;
}

/** How a search result matched, best first. */
export type SearchMatch = 'eco' | 'moves' | 'family' | 'family-prefix' | 'variation' | 'words' | 'substring';

export interface SearchResult {
  line: OpeningLine;
  match: SearchMatch;
}

/**
 * Well-known openings to start with, by the side that plays them, most recommended first. Every
 * entry is an exact family name in the catalog and has an opening guide (tests/openings check
 * both). For the Pro learn and drill modes, a guide's own annotated line (`guideMainLine` in
 * src/data/opening-guides.ts) can differ from the family's main line here (e.g. London System).
 */
export const BEGINNER_FAMILIES: Readonly<Record<Color, readonly string[]>> = Object.freeze({
  w: Object.freeze([
    'Italian Game',
    'Ruy Lopez',
    "Queen's Gambit",
    'London System',
    'Scotch Game',
    'Vienna Game',
    'English Opening',
    'Four Knights Game',
    "Bishop's Opening",
    "King's Gambit",
    'Catalan Opening',
    'Réti Opening',
    "King's Indian Attack",
    'Bird Opening',
  ]),
  b: Object.freeze([
    'Sicilian Defense',
    'French Defense',
    'Caro-Kann Defense',
    "Queen's Gambit Declined",
    'Slav Defense',
    "King's Indian Defense",
    'Nimzo-Indian Defense',
    'Scandinavian Defense',
    "Petrov's Defense",
    'Pirc Defense',
    'Modern Defense',
    'Alekhine Defense',
    "Queen's Gambit Accepted",
    'Grünfeld Defense',
    'Dutch Defense',
    'Philidor Defense',
  ]),
});

// -------------------------------------------------------------------------------------------------
// Data

interface LinesData {
  v: number;
  meta: CatalogMeta & { cols?: string[] };
  /** [eco, name, san (space-separated), popularity] */
  lines: [string, string, string, number][];
  families: Record<string, { n: number; eco: string; main: number; w: number; pop: number; side: Color }>;
}

interface SearchEntry {
  line: OpeningLine;
  name: string;
  family: string;
  /** Normalized variation parts ("Najdorf Variation, English Attack" -> ["najdorf variation", "english attack"]). */
  parts: string[];
  words: string[];
  /** SAN moves through normMove. */
  moves: string[];
  isMain: boolean;
}

interface Catalog {
  meta: CatalogMeta;
  lines: OpeningLine[];
  byId: Map<string, OpeningLine>;
  /** Exact name -> lines, the one with the plain id first. */
  byName: Map<string, OpeningLine[]>;
  /** By weight, highest first. */
  families: readonly OpeningFamily[];
  familyByName: Map<string, OpeningFamily>;
  /** Family -> its lines, main line first, then by popularity. */
  familyLines: Map<string, OpeningLine[]>;
  mainIds: Set<string>;
  search: SearchEntry[] | null;
}

let catalog: Catalog | null = null;
let loading: Promise<void> | null = null;

/** Loads the catalog (once; concurrent calls share the promise; a failed load can be retried). */
export function loadCatalog(): Promise<void> {
  loading ??= import('../data/opening-lines.json')
    .then((m) => {
      catalog = buildCatalog(((m as { default?: unknown }).default ?? m) as LinesData);
    })
    .catch((e: unknown) => {
      loading = null;
      throw e;
    });
  return loading;
}

/** True once `loadCatalog()` has completed. */
export function catalogLoaded(): boolean {
  return catalog !== null;
}

/** Source, commit and license of the data; null until loaded. */
export function catalogMeta(): CatalogMeta | null {
  if (!catalog) return null;
  const { source, ref, license, lines, families, maxPly, built } = catalog.meta;
  return { source, ref, license, lines, families, maxPly, built };
}

/**
 * Family and variation of a dataset name: the part before ":" is the family, and a ", with ..."
 * qualifier of the family moves into the variation ("London System, with Bd3" -> "London System" /
 * "with Bd3"). Mirrors scripts/build-opening-lines.mjs, which builds the families index with it.
 */
export function splitLineName(name: string): { family: string; variation: string } {
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

/**
 * Lower-case text without accents or apostrophes, other punctuation turned into single spaces:
 * "Queen's Gambit" and "Queen’s Gambit" -> "queens gambit", "Grünfeld" -> "grunfeld",
 * "Caro-Kann" -> "caro kann".
 */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['\u2018\u2019`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "B90", "Sicilian Defense: Najdorf Variation" -> "b90-sicilian-defense-najdorf-variation". */
function slugOf(eco: string, name: string): string {
  return normalizeText(`${eco} ${name}`).replace(/ /g, '-');
}

/** 32-bit FNV-1a in base 36: a short, stable fingerprint of a move list. */
function hash36(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** UCI moves and final EPD of a SAN line from the initial position (stops at a bad move). */
function replay(san: readonly string[]): { uci: readonly string[]; epd: string } {
  const chess = new Chess();
  const uci: string[] = [];
  try {
    for (const s of san) uci.push(toUci(chess.move(s)));
  } catch {
    /* the build validates every line; keep what replayed */
  }
  return { uci: Object.freeze(uci), epd: fenKey(chess.fen()) };
}

function makeLine(id: string, eco: string, name: string, sans: string, popularity: number): OpeningLine {
  const { family, variation } = splitLineName(name);
  const san = Object.freeze(sans.split(' '));
  let replayed: { uci: readonly string[]; epd: string } | null = null;
  const lazy = () => (replayed ??= replay(san));
  const line = { id, eco, name, family, variation, san, plies: san.length, popularity };
  Object.defineProperties(line, {
    uci: { get: () => lazy().uci, enumerable: true },
    epd: { get: () => lazy().epd, enumerable: true },
  });
  return Object.freeze(line) as unknown as OpeningLine;
}

const byPopularity = (a: OpeningLine, b: OpeningLine): number =>
  b.popularity - a.popularity || a.plies - b.plies || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function buildCatalog(d: LinesData): Catalog {
  // Ids: the shortest line of each (eco, name) slug keeps the plain slug.
  const rows = d.lines.map(([eco, name, san, pop], index) => ({ eco, name, san, pop, index, slug: slugOf(eco, name) }));
  const plies = (s: string) => s.split(' ').length;
  const bySlug = new Map<string, typeof rows>();
  for (const r of rows) {
    const g = bySlug.get(r.slug);
    if (g) g.push(r);
    else bySlug.set(r.slug, [r]);
  }
  const ids: string[] = [];
  const used = new Set<string>();
  for (const [slug, group] of bySlug) {
    group.sort((a, b) => plies(a.san) - plies(b.san) || (a.san < b.san ? -1 : a.san > b.san ? 1 : 0));
    group.forEach((r, i) => {
      let id = i === 0 ? slug : `${slug}-${hash36(r.san)}`;
      while (used.has(id)) id += 'x'; // never happens with this data; keeps ids unique regardless
      used.add(id);
      ids[r.index] = id;
    });
  }

  const lines = rows.map((r) => makeLine(ids[r.index], r.eco, r.name, r.san, r.pop));
  const byId = new Map(lines.map((l) => [l.id, l]));
  const byName = new Map<string, OpeningLine[]>();
  for (const [, group] of bySlug) {
    for (const r of group) {
      const l = lines[r.index];
      const list = byName.get(l.name);
      if (list) list.push(l);
      else byName.set(l.name, [l]);
    }
  }

  const families = Object.entries(d.families)
    .map(
      ([name, f]): OpeningFamily =>
        Object.freeze({
          name,
          lineCount: f.n,
          ecoRange: f.eco,
          mainLineId: lines[f.main]?.id ?? '',
          weight: f.w,
          popularity: f.pop,
          side: f.side === 'b' ? 'b' : 'w',
        }),
    )
    .sort((a, b) => b.weight - a.weight || b.popularity - a.popularity || (a.name < b.name ? -1 : 1));
  const familyByName = new Map(families.map((f) => [f.name, f]));
  const mainIds = new Set(families.map((f) => f.mainLineId));
  const familyLines = new Map<string, OpeningLine[]>();
  for (const l of lines) {
    const list = familyLines.get(l.family);
    if (list) list.push(l);
    else familyLines.set(l.family, [l]);
  }
  for (const list of familyLines.values()) {
    list.sort((a, b) => Number(mainIds.has(b.id)) - Number(mainIds.has(a.id)) || byPopularity(a, b));
  }

  return {
    meta: d.meta,
    lines,
    byId,
    byName,
    families: Object.freeze(families),
    familyByName,
    familyLines,
    mainIds,
    search: null,
  };
}

// -------------------------------------------------------------------------------------------------
// Lookups

/** Every line, in dataset order (by ECO code). */
export function allLines(): readonly OpeningLine[] {
  return catalog?.lines ?? [];
}

/** The line with this id, or null (unknown id, or not loaded yet). */
export function getLine(id: string): OpeningLine | null {
  return catalog?.byId.get(id) ?? null;
}

/**
 * The line with this exact dataset name (and ECO code, when given); for a name the dataset
 * repeats with other move orders, the one with the plain id (the shortest). Null if none.
 */
export function findLine(name: string, eco?: string): OpeningLine | null {
  const list = catalog?.byName.get(name) ?? [];
  return list.find((l) => eco === undefined || l.eco === eco) ?? null;
}

/** Every line with this exact name (and ECO code, when given), the one with the plain id first. */
export function linesNamed(name: string, eco?: string): OpeningLine[] {
  return (catalog?.byName.get(name) ?? []).filter((l) => eco === undefined || l.eco === eco);
}

/** All families, most important first (by `weight`, see OpeningFamily.weight). */
export function families(): readonly OpeningFamily[] {
  return catalog?.families ?? [];
}

/** The family with this exact name (or the same name ignoring case, accents and apostrophes). */
export function getFamily(name: string): OpeningFamily | null {
  if (!catalog) return null;
  const exact = catalog.familyByName.get(name);
  if (exact) return exact;
  const n = normalizeText(name);
  return catalog.families.find((f) => normalizeText(f.name) === n) ?? null;
}

/** The family's main line (see OpeningFamily.mainLineId), or null. */
export function mainLine(family: string): OpeningLine | null {
  const f = getFamily(family);
  return f ? getLine(f.mainLineId) : null;
}

/** Whether this line is the main line of its family. */
export function isMainLine(line: OpeningLine | string): boolean {
  return catalog?.mainIds.has(typeof line === 'string' ? line : line.id) ?? false;
}

/**
 * The lines of a family. 'popularity' (default): the main line first, then most popular first
 * (shorter first among equals); 'eco': by ECO code, then name, then length; 'name': by name.
 */
export function linesOfFamily(family: string, order: 'popularity' | 'eco' | 'name' = 'popularity'): OpeningLine[] {
  const f = getFamily(family);
  const list = (f && catalog?.familyLines.get(f.name)) || [];
  const out = list.slice();
  if (order === 'eco') {
    out.sort((a, b) => (a.eco < b.eco ? -1 : a.eco > b.eco ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.plies - b.plies);
  } else if (order === 'name') {
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.plies - b.plies);
  }
  return out;
}

/**
 * Families that belong with this one: "Queen's Gambit" -> "Queen's Gambit Declined", "Queen's
 * Gambit Accepted"; "King's Gambit Accepted" -> "King's Gambit", "King's Gambit Declined".
 * Highest weight first (as in `families()`).
 */
export function relatedFamilies(family: string): OpeningFamily[] {
  const f = getFamily(family);
  if (!f || !catalog) return [];
  const base = f.name.replace(/ (Accepted|Declined)$/, '');
  return catalog.families.filter((o) => o.name !== f.name && (o.name === base || o.name.startsWith(`${base} `)));
}

/** The curated starter families for one side (BEGINNER_FAMILIES), in order; [] until loaded. */
export function beginnerFamilies(color: Color): OpeningFamily[] {
  return BEGINNER_FAMILIES[color].map((n) => catalog?.familyByName.get(n)).filter((f): f is OpeningFamily => !!f);
}

// -------------------------------------------------------------------------------------------------
// Search

const ECO_RE = /^[a-e]\d\d$/i;
/** A normalized SAN token (see normMove). */
const SAN_RE = /^(?:[kqrbn]?[a-h]?[1-8]?x?[a-h][1-8][qrbn]?|o-o(?:-o)?)$/;
const MATCH_RANK: Record<SearchMatch, number> = {
  eco: 0,
  moves: 0,
  family: 1,
  'family-prefix': 2,
  variation: 3,
  words: 4,
  substring: 5,
};

/**
 * Other names people search for (normalized, see normalizeText) -> exact family names. A query
 * equal to an alias matches the family's lines as 'family'; the start of a longer alias (4+
 * characters) as 'family-prefix'.
 */
export const FAMILY_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  spanish: ['Ruy Lopez'],
  'spanish game': ['Ruy Lopez'],
  'spanish opening': ['Ruy Lopez'],
  'russian game': ["Petrov's Defense"],
  'russian defense': ["Petrov's Defense"],
  petroff: ["Petrov's Defense"],
  'petroff defense': ["Petrov's Defense"],
  'center counter': ['Scandinavian Defense'],
  'center counter defense': ['Scandinavian Defense'],
  qgd: ["Queen's Gambit Declined"],
  qga: ["Queen's Gambit Accepted"],
  kid: ["King's Indian Defense"],
  kia: ["King's Indian Attack"],
  qid: ["Queen's Indian Defense"],
  nid: ['Nimzo-Indian Defense'],
  gruenfeld: ['Grünfeld Defense'],
  'gruenfeld defense': ['Grünfeld Defense'],
  bogoljubov: ['Bogo-Indian Defense'],
  volga: ['Benko Gambit'],
  'volga gambit': ['Benko Gambit'],
  sokolsky: ['Polish Opening'],
  orangutan: ['Polish Opening'],
});

/** British spellings of words in opening names, as queries may use them. */
const QUERY_SPELLINGS: readonly [RegExp, string][] = [
  [/\bdefence\b/g, 'defense'],
  [/\bcentre\b/g, 'center'],
];

function searchIndex(c: Catalog): SearchEntry[] {
  c.search ??= c.lines.map((line) => {
    const name = normalizeText(line.name);
    return {
      line,
      name,
      family: normalizeText(line.family),
      parts: line.variation ? line.variation.split(',').map(normalizeText).filter(Boolean) : [],
      words: name.split(' '),
      moves: line.san.map(normMove),
      isMain: c.mainIds.has(line.id),
    };
  });
  return c.search;
}

/** Lower case without check, annotation and promotion marks, castling with letters: "e8=Q+" -> "e8q", "0-0" -> "o-o". */
function normMove(san: string): string {
  return san.toLowerCase().replace(/[+#!?=]/g, '').replace(/0/g, 'o');
}

/** "1. e4 c5 2.Nf3" -> ["e4", "c5", "nf3"] when the query is a list of moves, else null. */
function queryMoves(query: string): string[] | null {
  const tokens = query
    .replace(/\d+\.(\.\.)?/g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(normMove);
  return tokens.length && tokens.every((t) => SAN_RE.test(t)) ? tokens : null;
}

/** A text query: normalized, British spellings made American ("Sicilian Defence" -> "sicilian defense"). */
function normalizeQuery(query: string): string {
  let q = normalizeText(query);
  for (const [re, to] of QUERY_SPELLINGS) q = q.replace(re, to);
  return q;
}

/** The families an alias query names: exactly ('family') or by the start of the alias ('family-prefix'). */
function aliasFamilies(q: string): { exact: Set<string>; prefix: Set<string> } {
  const exact = new Set<string>(Object.hasOwn(FAMILY_ALIASES, q) ? FAMILY_ALIASES[q] : []);
  const prefix = new Set<string>();
  if (q.length >= 4) {
    for (const [alias, names] of Object.entries(FAMILY_ALIASES)) {
      if (alias !== q && alias.startsWith(q)) for (const n of names) if (!exact.has(n)) prefix.add(n);
    }
  }
  return { exact, prefix };
}

/** How `e` matches the normalized text query `q` (tokens `qt`, alias families `alias`), or null. */
function textMatch(e: SearchEntry, q: string, qt: string[], alias: ReturnType<typeof aliasFamilies>): SearchMatch | null {
  if (e.family === q || alias.exact.has(e.line.family)) return 'family';
  if (e.family.startsWith(q) || alias.prefix.has(e.line.family)) return 'family-prefix';
  if (e.parts.some((p) => p.startsWith(q))) return 'variation';
  if (qt.every((t) => e.words.some((w) => w.startsWith(t)))) return 'words';
  if (e.name.includes(q)) return 'substring';
  return null;
}

/** Every match of the query, ranked (not deduplicated). */
function rankedMatches(query: string): { e: SearchEntry; match: SearchMatch }[] {
  if (!catalog) return [];
  const index = searchIndex(catalog);
  const raw = query.trim();
  const out: { e: SearchEntry; match: SearchMatch }[] = [];
  let moves: string[] | null = null;
  if (ECO_RE.test(raw)) {
    const eco = raw.toUpperCase();
    for (const e of index) if (e.line.eco === eco) out.push({ e, match: 'eco' });
  } else {
    moves = queryMoves(raw);
    if (moves) {
      const m = moves;
      for (const e of index) {
        if (e.moves.length >= m.length && m.every((x, i) => e.moves[i] === x)) out.push({ e, match: 'moves' });
      }
    }
    if (!out.length) {
      moves = null;
      const q = normalizeQuery(raw);
      if (!q) return [];
      const qt = q.split(' ');
      const alias = aliasFamilies(q);
      for (const e of index) {
        const match = textMatch(e, q, qt, alias);
        if (match) out.push({ e, match });
      }
    }
  }
  if (moves) {
    // Moves: the line that is exactly the typed moves first, then by popularity (the main-line boost
    // would put every obscure family that starts this way ahead of the popular variations).
    const n = moves.length;
    out.sort((a, b) => Number(b.e.moves.length === n) - Number(a.e.moves.length === n) || byPopularity(a.e.line, b.e.line));
  } else {
    out.sort(
      (a, b) =>
        MATCH_RANK[a.match] - MATCH_RANK[b.match] ||
        Number(b.e.isMain) - Number(a.e.isMain) ||
        byPopularity(a.e.line, b.e.line),
    );
  }
  return out;
}

/**
 * Searches the lines by family, variation, words of the name (prefixes, any order), ECO code
 * ("B90"), moves ("e4 c5 Nf3", move numbers optional) or a common other name ("Spanish Game",
 * "Petroff", "QGD", "KID"). Case, accents, apostrophes and British spellings do not matter
 * ("queens gambit", "grunfeld", "caro", "sicilian defence"). Ranked: ECO / moves; exact family;
 * family prefix; variation prefix; all words; substring. Within a rank: family main lines first,
 * then the more popular (and shorter) lines; for moves, the line that is exactly the typed moves,
 * then by popularity. Each ECO code + name appears once (its best-ranked line; the dataset repeats a
 * few with other move orders). [] until loaded, or when `limit` is not positive.
 */
export function search(query: string, limit = 30): SearchResult[] {
  if (!(limit > 0)) return [];
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const { e, match } of rankedMatches(query)) {
    const key = `${e.line.eco} ${e.line.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ line: e.line, match });
    if (results.length >= limit) break;
  }
  return results;
}

/**
 * Families matching the query (the families of the lines `search` finds), ranked by their best
 * line's match, then by the popularity of their most popular line with that match, then by
 * weight: "queens gambit" -> Queen's Gambit, Queen's Gambit Declined, Queen's Gambit Accepted,
 * ...; "najdorf" -> Sicilian Defense; "e4 e5" -> King's Pawn Game first.
 */
export function searchFamilies(query: string, limit = 10): OpeningFamily[] {
  if (!catalog || !(limit > 0)) return [];
  const best = new Map<string, { rank: number; pop: number }>();
  for (const { e, match } of rankedMatches(query)) {
    const rank = MATCH_RANK[match];
    const b = best.get(e.line.family);
    if (!b || rank < b.rank) best.set(e.line.family, { rank, pop: e.line.popularity });
    else if (rank === b.rank && e.line.popularity > b.pop) b.pop = e.line.popularity;
  }
  return [...best]
    .map(([name, b]) => ({ f: catalog?.familyByName.get(name), ...b }))
    .filter((x): x is { f: OpeningFamily; rank: number; pop: number } => !!x.f)
    .sort((a, b) => a.rank - b.rank || b.pop - a.pop || b.f.weight - a.f.weight || (a.f.name < b.f.name ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.f);
}
