/**
 * The Openings section's view logic, without DOM: study lines (catalog lines, an opening guide's
 * own annotated main line, a guide's traps), their positions and names, where a move on the board
 * leads, the wording the pages show, and small saved preferences. Pure functions over the catalog,
 * the move tree and the guides, so tests/ui/openings.test.ts runs it in node.
 *
 * Load the data first: `loadOpeningsData()` (the opening book, the catalog and the guides, all
 * lazy chunks). The guides are loaded for everyone: their main lines' moves are free like any
 * line's; only their text is Pro (the pages check `openingGuides` before showing it).
 */
import { Chess } from 'chess.js';
import type { Score } from '../../engine/types';
import { BOOK_BLUNDER_CP, bookMoves, openingAt } from '../../bot/book';
import { parseUci, START_FEN, toUci } from '../../chess/utils';
import type { OpeningGuide } from '../../data/opening-guides';
import type { Color } from '../../game/types';
import {
  allLines,
  beginnerFamilies,
  getFamily,
  getLine,
  linesOfFamily,
  mainLine,
  normalizeText,
  type OpeningFamily,
  type OpeningLine,
  type SearchResult,
} from '../../openings/catalog';
import type { DrillCheck } from '../../openings/drill';
import { children, lineAt, loadExplorer, moveLabel, nameAt, type PositionName, type TreeMove } from '../../openings/tree';
import type { DrillFeedback } from '../../openings/session';

// -------------------------------------------------------------------------------------------------
// Data

type GuidesModule = typeof import('../../data/opening-guides');
let guidesMod: GuidesModule | null = null;
let guidesLoading: Promise<void> | null = null;

/** Loads the opening guides (once; a failed load can be retried). */
export function loadGuides(): Promise<void> {
  guidesLoading ??= import('../../data/opening-guides')
    .then((m) => {
      guidesMod = m;
    })
    .catch((e: unknown) => {
      guidesLoading = null;
      throw e;
    });
  return guidesLoading;
}

/** Everything the section needs: the opening book, the catalog and the guides. */
export function loadOpeningsData(): Promise<void> {
  return Promise.all([loadExplorer(), loadGuides()]).then(() => undefined);
}

/** The guide for a family or line name (also a guide that covers it under another name), if loaded. */
export function guideOf(familyOrName: string | null | undefined): OpeningGuide | undefined {
  return guidesMod?.guideFor(familyOrName);
}

/** The guide written for exactly this family (not one that only mentions it). */
export function ownGuide(family: string): OpeningGuide | undefined {
  const g = guideOf(family);
  return g && normalizeText(g.family) === normalizeText(family) ? g : undefined;
}

/** The guide's note on the last of `sans` (SAN moves from the initial position), if any. */
export function moveNote(guide: OpeningGuide | undefined, sans: readonly string[]): string | undefined {
  return guide && guidesMod ? guidesMod.moveNoteFor(guide, sans) : undefined;
}

const colorOf = (side: 'white' | 'black'): Color => (side === 'white' ? 'w' : 'b');

// -------------------------------------------------------------------------------------------------
// Study lines

/** Id prefix of an opening guide's own main line: "guide:Italian Game". */
export const GUIDE_PREFIX = 'guide:';
/** Id prefix of a guide's trap: "trap:Italian Game:0". */
export const TRAP_PREFIX = 'trap:';

/** A line the section can step through, drill and (unless it is a trap) play against the computer. */
export interface StudyLine {
  /** Catalog id, `guide:<family>` or `trap:<family>:<index>`. */
  id: string;
  kind: 'catalog' | 'guide' | 'trap';
  /** Full name ("Italian Game: Giuoco Piano", "Italian Game: Main line", "Italian Game: Fried Liver Attack"). */
  name: string;
  family: string;
  /** '' for a family's base line. */
  variation: string;
  /** ECO code (catalog lines only). */
  eco: string | null;
  /** SAN and UCI moves from the initial position. */
  san: readonly string[];
  uci: readonly string[];
  /** The side that plays the opening: the board shows it at the bottom by default. */
  side: Color;
  /**
   * A game can follow it (`openingStart`): catalog lines by their id, a guide's main line with its
   * moves; not a trap (the computer would have to play the blunder on purpose).
   */
  playable: boolean;
  /** A trap's title and story (Pro text), the side that profits, and the plies of the mistake. */
  trap?: { title: string; note: string; side: Color; mistakes: readonly number[] };
}

/** The family's side, or a guess from the line (the side that made its last move). */
function sideOf(family: string, san: readonly string[]): Color {
  return getFamily(family)?.side ?? (san.length % 2 === 1 ? 'w' : 'b');
}

let bySan: Map<string, OpeningLine> | null = null;

/** The catalog line with exactly these moves (the one with the plain id when the dataset repeats one). */
export function catalogLineWithMoves(san: readonly string[]): OpeningLine | null {
  if (!bySan) {
    const lines = allLines();
    if (!lines.length) return null;
    bySan = new Map();
    for (const l of lines) {
      const key = l.san.join(' ');
      if (!bySan.has(key)) bySan.set(key, l);
    }
  }
  return bySan.get(san.join(' ')) ?? null;
}

/** The longest catalog line whose moves start `san` (in the same order), or null. */
export function deepestCatalogPrefix(san: readonly string[]): OpeningLine | null {
  for (let n = san.length; n > 0; n--) {
    const l = catalogLineWithMoves(san.slice(0, n));
    if (l) return l;
  }
  return null;
}

/** SAN moves of UCI moves from the initial position (stops at an illegal move). */
export function sansOf(uci: readonly string[]): string[] {
  const chess = new Chess();
  const out: string[] = [];
  try {
    for (const u of uci) out.push(chess.move(parseUci(u)).san);
  } catch {
    /* keep the legal prefix */
  }
  return out;
}

/** UCI moves of SAN moves from the initial position (stops at an illegal move). */
export function ucisOf(san: readonly string[]): string[] {
  const chess = new Chess();
  const out: string[] = [];
  try {
    for (const s of san) out.push(toUci(chess.move(s)));
  } catch {
    /* keep the legal prefix */
  }
  return out;
}

const studyCache = new Map<string, StudyLine | null>();

/** The study line with this id, or null (unknown, or the data has not loaded). */
export function resolveLine(id: string): StudyLine | null {
  if (studyCache.has(id)) return studyCache.get(id) ?? null;
  const line = buildLine(id);
  // Only cache once the data is there (an early miss must not stick).
  if (line || (allLines().length && guidesMod)) studyCache.set(id, line);
  return line;
}

function buildLine(id: string): StudyLine | null {
  if (id.startsWith(GUIDE_PREFIX)) {
    const family = id.slice(GUIDE_PREFIX.length);
    const guide = ownGuide(family);
    const san = guide && guidesMod ? guidesMod.guideMainLine(guide) : [];
    if (!guide || !san.length) return null;
    const uci = ucisOf(san);
    const f = getFamily(guide.family)?.name ?? guide.family;
    return {
      id,
      kind: 'guide',
      name: `${f}: Main line`,
      family: f,
      variation: 'Main line',
      eco: null,
      san: san.slice(0, uci.length),
      uci,
      side: colorOf(guide.side),
      playable: true,
    };
  }
  if (id.startsWith(TRAP_PREFIX)) {
    const rest = id.slice(TRAP_PREFIX.length);
    const i = rest.lastIndexOf(':');
    const family = rest.slice(0, i);
    const index = Number(rest.slice(i + 1));
    const guide = guideOf(family);
    const trap = guide?.traps?.[index];
    if (!guide || !trap || i < 0) return null;
    const san = sansOf(trap.uci);
    const f = getFamily(family)?.name ?? family;
    return {
      id,
      kind: 'trap',
      name: `${f}: ${trap.title}`,
      family: f,
      variation: trap.title,
      eco: null,
      san,
      uci: trap.uci.slice(0, san.length),
      side: colorOf(trap.side),
      playable: false,
      trap: { title: trap.title, note: trap.note, side: colorOf(trap.side), mistakes: trap.mistakes.filter((i) => i < san.length) },
    };
  }
  const l = getLine(id);
  if (!l) return null;
  return {
    id,
    kind: 'catalog',
    name: l.name,
    family: l.family,
    variation: l.variation,
    eco: l.eco,
    san: l.san,
    uci: l.uci,
    side: sideOf(l.family, l.san),
    playable: true,
  };
}

/** The opening part of a new game for a study line (GameController `NewGameOptions.opening`). */
export interface OpeningStart {
  lineId: string;
  mode: 'steer' | 'skip';
  showLineMoves?: boolean;
  /** A line the catalog does not have (a guide's main line): its moves, the name the game shows and its family. */
  moves?: readonly string[];
  name?: string;
  family?: string;
}

/**
 * How a game follows `line` (see GameController `newGame`): a catalog line by its id; another
 * line (an opening guide's main line) with its own moves, named after its opening ("London
 * System"), so the game plays exactly the moves the section taught.
 */
export function openingStart(line: StudyLine, mode: 'steer' | 'skip', showLineMoves?: boolean): OpeningStart {
  const start: OpeningStart = { lineId: line.id, mode, ...(mode === 'steer' && showLineMoves !== undefined ? { showLineMoves } : {}) };
  return line.kind === 'catalog' ? start : { ...start, moves: line.uci, name: line.family, family: line.family };
}

/** The line ends the game (checkmate or stalemate), e.g. "Barnes Opening: Fool's Mate". */
export function endsGame(line: Pick<StudyLine, 'san'>): boolean {
  const chess = new Chess();
  try {
    for (const s of line.san) chess.move(s);
  } catch {
    return false;
  }
  return line.san.length > 0 && (chess.isCheckmate() || chess.isStalemate());
}

/**
 * The line "Learn the main line" opens for a family: the family's own guide's annotated main line
 * when there is one (its moves come with notes), else the catalog's main line.
 */
export function mainStudyLineId(family: string): string | null {
  const g = ownGuide(family);
  if (g && guidesMod?.guideMainLine(g).length) return `${GUIDE_PREFIX}${getFamily(family)?.name ?? g.family}`;
  return mainLine(family)?.id ?? null;
}

/** The lines of a family in the order the section offers them: the main study line, then the catalog's. */
export function familyStudyIds(family: string): string[] {
  const ids = linesOfFamily(family).map((l) => l.id);
  const main = mainStudyLineId(family);
  return main && !ids.includes(main) ? [main, ...ids] : ids;
}

/**
 * The line after `id` in its family's list (for "Next variation"), or null. Lines whose moves only
 * start the line just studied (the family's base line after its main line) are skipped: they would
 * teach nothing new.
 */
export function nextLineId(id: string): string | null {
  const line = resolveLine(id);
  if (!line) return null;
  const ids = familyStudyIds(line.family);
  const i = ids.indexOf(id);
  if (i < 0) return null;
  for (const next of ids.slice(i + 1)) {
    const l = resolveLine(next);
    if (l && !isPrefix(l.san, line.san)) return next;
  }
  return null;
}

/** `a` is `b`'s first moves (or all of them). */
const isPrefix = (a: readonly string[], b: readonly string[]): boolean => a.length <= b.length && a.every((s, k) => s === b[k]);

/** One position of a study line. */
export interface StudyStep {
  /** Plies played (0 = the initial position). */
  ply: number;
  fen: string;
  /** The move that led here (null at ply 0). */
  uci: string | null;
  san: string | null;
  color: Color | null;
  /** "3. Bc4" / "3... Bc5" (null at ply 0). */
  label: string | null;
  /** The move that led here is a known mistake: the book flags it, or it is a trap's mistake. */
  dubious: boolean;
  /** The opening name here (or the last named position before it). */
  name: PositionName | null;
}

const stepCache = new Map<string, readonly StudyStep[]>();

/** Every position of a line with its name, from the initial position. */
export function studySteps(line: StudyLine): readonly StudyStep[] {
  const cached = stepCache.get(line.id);
  if (cached) return cached;
  const chess = new Chess();
  const steps: StudyStep[] = [
    { ply: 0, fen: chess.fen(), uci: null, san: null, color: null, label: null, dubious: false, name: null },
  ];
  const fens: string[] = [];
  try {
    line.san.forEach((san, i) => {
      const before = chess.fen();
      const color = chess.turn();
      const mv = chess.move(san);
      const uci = toUci(mv);
      const known = bookMoves(before).find((m) => m.uci === uci);
      fens.push(before);
      const fen = chess.fen();
      steps.push({
        ply: i + 1,
        fen,
        uci,
        san: mv.san,
        color,
        label: moveLabel(i, mv.san),
        dubious: (known?.cpLoss ?? 0) >= BOOK_BLUNDER_CP || !!line.trap?.mistakes.includes(i),
        name: nameAt(fen, fens),
      });
    });
  } catch {
    /* keep the legal prefix */
  }
  const frozen = Object.freeze(steps);
  if (openingAt(START_FEN) !== undefined) stepCache.set(line.id, frozen);
  return frozen;
}

/** Where a book move from a line's position leads: another line (at a ply) or the move tree. */
export type BranchTarget = { lineId: string; ply: number } | { tree: string[] };

/**
 * Where to go when the player picks book move `move` after the SAN moves `sans` (from the initial
 * position): the line that goes on from it the main way (`mainContinuation`), else the most
 * popular catalog line with exactly these moves (either at the ply after the move), else the line
 * named at the position it reaches (another move order, at its end), else the move tree there.
 */
export function branchTarget(sans: readonly string[], move: Pick<TreeMove, 'san' | 'uci' | 'lineId'>): BranchTarget {
  const path = [...sans, move.san];
  const through = mainContinuation(path) ?? linesThrough(path);
  if (through) return { lineId: through.id, ply: path.length };
  const named = move.lineId ? getLine(move.lineId) : null;
  if (named) return { lineId: named.id, ply: named.plies };
  return { tree: ucisOf(path) };
}

/** How far `mainContinuation` follows the main moves (plies from the initial position). */
const MAIN_CONTINUATION_PLIES = 24;

/**
 * The line that goes on from `sans` the main way: follows the book's main move (TreeMove.isMain)
 * from there and returns the deepest catalog line on that path that is longer than `sans` (its
 * moves exactly `sans` and then the main moves), or null. E.g. from 1. e4 e5 it is a Ruy Lopez
 * line, not the two-move "King's Pawn Game".
 */
export function mainContinuation(sans: readonly string[]): OpeningLine | null {
  const chess = new Chess();
  try {
    for (const s of sans) chess.move(s);
  } catch {
    return null;
  }
  const path = [...sans];
  let best: OpeningLine | null = null;
  while (path.length < MAIN_CONTINUATION_PLIES) {
    const main = children(chess.fen()).find((k) => k.isMain);
    if (!main) break;
    try {
      chess.move(parseUci(main.uci));
    } catch {
      break;
    }
    path.push(main.san);
    best = catalogLineWithMoves(path) ?? best;
  }
  return best;
}

/** The most popular catalog line whose moves start with exactly `sans` (the shortest on a tie). */
export function linesThrough(sans: readonly string[]): OpeningLine | null {
  let best: OpeningLine | null = null;
  for (const l of allLines()) {
    if (l.san.length < sans.length) continue;
    let ok = true;
    for (let i = 0; i < sans.length; i++) {
      if (l.san[i] !== sans[i]) {
        ok = false;
        break;
      }
    }
    if (ok && (!best || l.popularity > best.popularity || (l.popularity === best.popularity && l.plies < best.plies))) best = l;
  }
  return best;
}

/** A position of the move tree: the moves (SAN, labels) and FENs along the path. */
export interface TreePosition {
  fen: string;
  /** FENs before each move (for `nameAt`'s history), oldest first. */
  fens: string[];
  sans: string[];
  labels: string[];
  /** The path's legal prefix (an illegal move ends it). */
  uci: string[];
}

/** Replays a tree path (UCI from the initial position). */
export function treePosition(path: readonly string[]): TreePosition {
  const chess = new Chess();
  const out: TreePosition = { fen: chess.fen(), fens: [], sans: [], labels: [], uci: [] };
  for (const u of path) {
    const before = chess.fen();
    let san: string;
    try {
      san = chess.move(parseUci(u)).san;
    } catch {
      break;
    }
    out.fens.push(before);
    out.labels.push(moveLabel(out.sans.length, san));
    out.sans.push(san);
    out.uci.push(u);
  }
  out.fen = chess.fen();
  return out;
}

/**
 * What "Learn this line" opens from a tree position: the main way on from it (`mainContinuation`,
 * at this ply), else the most popular line through it, else the line named here by another move
 * order (at its end); null when there is none.
 */
export function learnTarget(pos: Pick<TreePosition, 'fen' | 'sans'>): { lineId: string; ply: number } | null {
  if (!pos.sans.length) return null;
  const through = mainContinuation(pos.sans) ?? linesThrough(pos.sans);
  if (through) return { lineId: through.id, ply: pos.sans.length };
  const named = lineAt(pos.fen);
  return named ? { lineId: named.id, ply: named.plies } : null;
}

/**
 * What "Play" offers from a tree position: the catalog line that ends exactly here (start after
 * its moves), else a line through here (start from move 1).
 */
export function playTarget(pos: Pick<TreePosition, 'fen' | 'sans'>): { lineId: string; exact: boolean } | null {
  if (!pos.sans.length) return null;
  const here = catalogLineWithMoves(pos.sans) ?? lineAt(pos.fen);
  // A position that ends the game (the Fool's Mate) is played up to, not from.
  if (here) return { lineId: here.id, exact: !endsGame(here) };
  const through = mainContinuation(pos.sans) ?? linesThrough(pos.sans);
  return through ? { lineId: through.id, exact: false } : null;
}

// -------------------------------------------------------------------------------------------------
// Wording

/**
 * "1. e4 e5 2. Nf3 Nc6 3. Bc4", the first `max` plies (with "…" when cut). A move number and its
 * move are joined by a no-break space, so a line never wraps between them.
 */
export function movesText(san: readonly string[], max = Infinity): string {
  const shown = san.slice(0, max);
  const text = shown.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.\u00a0${s}` : s)).join(' ');
  return shown.length < san.length ? `${text} …` : text;
}

/**
 * A long line in short: its first moves, "…", and its last ones ("1. e4 c5 2. Nf3 d6 3. d4 cxd4 …
 * 6. Bg5 e6"), so lines that start alike stay apart. Lines of at most `max` plies are shown whole.
 */
export function movesSummary(san: readonly string[], max = 12, tail = 4): string {
  if (san.length <= max) return movesText(san);
  const from = san.length - tail;
  const end = san
    .slice(from)
    .map((s, j) => {
      const i = from + j;
      const n = Math.floor(i / 2) + 1;
      if (i % 2 === 0) return `${n}.\u00a0${s}`;
      return j === 0 ? `${n}...\u00a0${s}` : s;
    })
    .join(' ');
  return `${movesText(san.slice(0, max - tail))} … ${end}`;
}

/**
 * Who plays the opening, in one line: "An opening for White: you play it with the white pieces."
 * or "An opening for Black: you choose it when White starts 1. e4."
 */
export function sideSentence(side: Color, mainSan: readonly string[]): string {
  if (side === 'w') return 'An opening for White: you play it with the white pieces.';
  const first = mainSan[0];
  return first
    ? `An opening for Black: you choose it when White starts 1. ${first}.`
    : 'An opening for Black: you choose it as your answer to White’s first move.';
}

/** A move label that never wraps between its number and its move ("3...\u00a0Bc5"). */
export const nb = (label: string): string => label.replace(/ /g, '\u00a0');

/** "White" / "Black". */
export const colorName = (c: Color): string => (c === 'w' ? 'White' : 'Black');

/**
 * What a book-flagged mistake (TreeMove.dubious, cpLoss >= BOOK_BLUNDER_CP) costs, in words true of
 * all of them: some lose material or the game, others (1. g4) only give the other side the better game.
 */
export const MISTAKE_NOTE = 'A known mistake: it gives the other side the better game.';

/** How common a book move is in theory, in words (never a game percentage). */
export function commonWord(m: Pick<TreeMove, 'share' | 'isMain' | 'dubious'>): string {
  if (m.dubious) return 'Known mistake';
  if (m.isMain) return 'Main line';
  if (m.share >= 0.25) return 'Very common';
  if (m.share >= 0.08) return 'Common';
  if (m.share >= 0.02) return 'Less common';
  return 'Rare';
}

/** The guide's level as a label. */
export function difficultyLabel(level: OpeningGuide['level']): string {
  return level === 'beginner' ? 'Beginner-friendly' : level === 'intermediate' ? 'Intermediate' : 'Advanced';
}

/** The first sentence of a text (the one-line pitch of a summary). */
export function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(?=\s+[A-Z0-9"“(]|$)/.exec(text.trim());
  return m ? m[1] : text.trim();
}

/**
 * A White-POV engine score in words for beginners: "About equal", "White is slightly better",
 * "Black is better", "White is winning", "White can force mate".
 */
export function evalWords(scoreWhite: Score | null): string {
  if (!scoreWhite) return '';
  const v = scoreWhite.value;
  if (scoreWhite.kind === 'mate') {
    if (v === 0) return 'Checkmate';
    return `${v > 0 ? 'White' : 'Black'} can force mate`;
  }
  const side = v > 0 ? 'White' : 'Black';
  const a = Math.abs(v);
  if (a < 35) return 'About equal';
  if (a < 100) return `${side} is slightly better`;
  if (a < 250) return `${side} is better`;
  return `${side} is winning`;
}

/** The drill page's message for a checked move. */
export function drillFeedback(check: DrillCheck, lineSans: readonly string[]): DrillFeedback | null {
  const { result, played, expected } = check;
  if (result === 'illegal' || !played || !expected) return null;
  const upTo = (label: string) => lineSans.slice(0, plyOfLabel(label) + 1);
  if (result === 'correct') {
    const text = expected.dubious
      ? `Correct for this line: ${played.label}. It is a known mistake, and this line shows how it gets punished.`
      : `Correct: ${played.label}.`;
    return { kind: 'correct', text, sans: upTo(played.label) };
  }
  if (result === 'alternative') {
    return {
      kind: 'alternative',
      text: `${played.label} is also a book move, but this line continues with ${expected.label}. Play it to go on.`,
    };
  }
  const trap = /known mistake/.test(check.message);
  return {
    kind: 'wrong',
    text: trap ? `${played.label} is a known mistake here. Try again.` : `${played.label} is not the move in this line. Try again.`,
  };
}

/** 0-based ply of a move label ("3. Bc4" -> 4, "3... Bc5" -> 5). */
export function plyOfLabel(label: string): number {
  const m = /^(\d+)\.(\.\.)?/.exec(label);
  if (!m) return 0;
  return (Number(m[1]) - 1) * 2 + (m[2] ? 1 : 0);
}

const LEVEL_ORDER: Readonly<Record<OpeningGuide['level'], number>> = { beginner: 0, intermediate: 1, advanced: 2 };

/**
 * "Start here" for a side, easiest first: by the level of each opening's own guide (beginner,
 * intermediate, advanced; none counts as intermediate), the recommended order within a level.
 */
export function starterFamilies(side: Color): OpeningFamily[] {
  return beginnerFamilies(side)
    .map((f, i) => ({ f, i, level: LEVEL_ORDER[ownGuide(f.name)?.level ?? 'intermediate'] }))
    .sort((a, b) => a.level - b.level || a.i - b.i)
    .map((x) => x.f);
}

/**
 * The openings a search names (its results matched an opening's name, "sicilian", "spanish"), in
 * the results' order, at most `max`: offered first, as the way to the opening's page.
 */
export function familyHits(results: readonly SearchResult[], max = 3): OpeningFamily[] {
  const out: OpeningFamily[] = [];
  for (const r of results) {
    if (r.match !== 'family' && r.match !== 'family-prefix') continue;
    const f = getFamily(r.line.family);
    if (f && !out.includes(f)) out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

/** A family's display facts for cards and rows. */
export interface FamilyFacts {
  family: OpeningFamily;
  /** The main study line ("Learn the main line"). */
  mainId: string | null;
  mainSan: readonly string[];
  guide: OpeningGuide | undefined;
}

export function familyFacts(f: OpeningFamily): FamilyFacts {
  const mainId = mainStudyLineId(f.name);
  // A guide's main line as written: resolving it (`resolveLine`) replays it with chess.js, too slow
  // for a page of cards on a phone.
  const own = mainId?.startsWith(GUIDE_PREFIX) ? ownGuide(f.name) : undefined;
  const guideSan = own && guidesMod ? guidesMod.guideMainLine(own) : null;
  return { family: f, mainId, mainSan: guideSan?.length ? guideSan : (mainLine(f.name)?.san ?? []), guide: guideOf(f.name) };
}

// -------------------------------------------------------------------------------------------------
// Preferences (per device; a failing storage only forgets them)

/** The beginner card ("What is an opening?") was dismissed. */
export const INTRO_KEY = 'chesscoach.openings-intro';
/** The side last picked in "Start here". */
export const SIDE_KEY = 'chesscoach.openings-side';

function read(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage full or blocked */
  }
}

export const introDismissed = (): boolean => read(INTRO_KEY) === '1';
export const dismissIntro = (): void => write(INTRO_KEY, '1');
export const savedSide = (): Color => (read(SIDE_KEY) === 'b' ? 'b' : 'w');
export const saveSide = (c: Color): void => write(SIDE_KEY, c);
