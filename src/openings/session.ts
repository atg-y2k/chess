/**
 * The Openings section's UI state: whether it is open, and its stack of pages (Home, a family, a
 * line being stepped through, the move tree, a drill), each with its own state, so Back returns
 * to a page as it was (its move on the board, the drill in progress, the scroll position).
 *
 * This module is in the main bundle: it holds no opening data and imports no code from the rest of
 * src/openings (types only), so the section itself (src/ui/openings) and its data load only when
 * it opens. Line ids are catalog ids (src/openings/catalog.ts) or the study lines of
 * src/ui/openings/model.ts ("guide:Italian Game", "trap:Italian Game:0"); this module never
 * resolves them.
 *
 * `openOpenings()` is the way in: from the Menu, the New game sheet, or a game that shows an
 * opening name. Opening and closing the section never touch the game.
 */
import { batch, computed, signal, type ReadonlySignal } from '@preact/signals';
import type { Color } from '../game/types';
import type { DrillHint, DrillState } from './drill';
import type { MasteryLevel } from './progress';

/**
 * What to open: a line (catalog id or study-line id), a family, or both; or an opening by its
 * dataset name and ECO code (as a game names its position), which the section resolves to its
 * line once its data has loaded.
 */
export interface OpeningsTarget {
  lineId?: string;
  /** With `lineId`: the move of the line on the board (plies from the initial position; default 0). */
  ply?: number;
  family?: string;
  name?: string;
  eco?: string;
}

interface PageBase {
  /** Unique per pushed page (set by the stack): keys the page's view and its transition. */
  key?: number;
  /** The page's scroll offset when another page was pushed over it (restored on Back). */
  scroll?: number;
}

export interface HomePage extends PageBase {
  kind: 'home';
  /** The search box's text (Back from a result returns to the results). */
  query?: string;
  /** "Start here" shows every starter opening, not the first few. */
  allStarters?: boolean;
}

/** Every family, most important first. */
export interface FamiliesPage extends PageBase {
  kind: 'families';
  /** Only the openings for one side (default: all). */
  side?: Color;
}

export interface FamilyPage extends PageBase {
  kind: 'family';
  family: string;
  /** The whole variation list rather than the first few. */
  showAll?: boolean;
}

/** A move played on the board in a line's view that is not a book move here. */
export interface OffBookMove {
  uci: string;
  san: string;
  /** The position after it. */
  fen: string;
}

/** Stepping through a line ("Learn"). */
export interface LinePage extends PageBase {
  kind: 'line';
  lineId: string;
  /** Plies of the line on the board (0 = the initial position). */
  ply: number;
  /** A move off the book, shown after `ply` until "Back to the line" (or any step). */
  offBook: OffBookMove | null;
  /** The board turned around from the line's side. */
  flipped?: boolean;
  /** "Other moves here" lists every book move, not the first few. */
  moreOthers?: boolean;
}

/** "Explore by moves": the book's moves from a position. */
export interface TreePage extends PageBase {
  kind: 'tree';
  /** UCI moves from the initial position to the position shown. */
  path: readonly string[];
  flipped?: boolean;
}

/** What the drill page says about the player's last move. */
export interface DrillFeedback {
  kind: 'correct' | 'alternative' | 'wrong' | 'shown';
  /** Plain-English verdict ("Correct: 3. Bc4."). */
  text: string;
  /** SAN moves from the initial position through the line's move this is about (its guide note). */
  sans?: readonly string[];
}

/** Drilling a line (Pro). */
export interface DrillPage extends PageBase {
  kind: 'drill';
  lineId: string;
  /** The player's side. */
  color: Color;
  /** Another book move is not counted as a mistake (it still has to be corrected). */
  acceptAlternatives: boolean;
  /** Null while the setup (side and mode) shows. */
  state: DrillState | null;
  feedback: DrillFeedback | null;
  hint: DrillHint | null;
  /** A wrong move shown on the board for a moment before it is taken back. */
  tried: { uci: string; fen: string } | null;
  /** The line's mastery when the run started (to show what it earned). */
  before?: MasteryLevel;
  /** Mastery before and after the completed run (recorded once, when the drill completes). */
  recorded: { before: MasteryLevel; after: MasteryLevel } | null;
}

export type OpeningsPage = HomePage | FamiliesPage | FamilyPage | LinePage | TreePage | DrillPage;

/** How the last navigation went (the page transition): deeper, back, or a jump. */
export type NavDirection = 'forward' | 'back' | 'none';

const openSignal = signal(false);
const stack = signal<readonly OpeningsPage[]>([]);
const direction = signal<NavDirection>('none');
/** An opening asked for by name, waiting for the data (see `takeNamedTarget`). */
let named: { name: string; eco?: string } | null = null;
/** Opened on a line without its family: the family's page goes under it once known (`insertFamilyBelow`). */
let lineAlone = false;
let nextKey = 1;

/** The section is open. */
export const openingsOpen: ReadonlySignal<boolean> = openSignal;
/** The page stack, the root (Home) first. */
export const openingsPages: ReadonlySignal<readonly OpeningsPage[]> = stack;
/** The page on top (null while nothing was ever opened). */
export const currentPage: ReadonlySignal<OpeningsPage | null> = computed(() => stack.value.at(-1) ?? null);
export const navDirection: ReadonlySignal<NavDirection> = direction;

const keyed = <P extends OpeningsPage>(p: P): P => ({ ...p, key: nextKey++ });

/** A line page at its start. */
export function linePage(lineId: string, ply = 0): LinePage {
  return { kind: 'line', lineId, ply: Math.max(0, Math.floor(ply) || 0), offBook: null };
}

/** A drill page on its setup. */
export function drillPage(lineId: string, color: Color, acceptAlternatives = false): DrillPage {
  return { kind: 'drill', lineId, color, acceptAlternatives, state: null, feedback: null, hint: null, tried: null, recorded: null };
}

/** The pages for a target: Home, then the family, then the line (each when given). */
export function targetPages(target: OpeningsTarget = {}): OpeningsPage[] {
  const pages: OpeningsPage[] = [{ kind: 'home' }];
  if (target.family) pages.push({ kind: 'family', family: target.family });
  if (target.lineId) pages.push(linePage(target.lineId, target.ply));
  return pages.map(keyed);
}

/**
 * Opens the section. With a target, on that opening (Home, then its family and line, so Back
 * walks up); without one, where it was left (Home the first time).
 */
export function openOpenings(target?: OpeningsTarget): void {
  named = target?.name && !target.lineId && !target.family ? { name: target.name, ...(target.eco ? { eco: target.eco } : {}) } : null;
  lineAlone = !!target?.lineId && !target.family;
  batch(() => {
    if (target && (target.lineId || target.family || target.name)) stack.value = targetPages(target);
    else if (!stack.value.length) stack.value = targetPages();
    direction.value = 'none';
    openSignal.value = true;
  });
}

/**
 * The opening asked for by name (`openOpenings({ name, eco })`), once: the section resolves it
 * to its line when its data has loaded.
 */
export function takeNamedTarget(): { name: string; eco?: string } | null {
  const t = named;
  named = null;
  return t;
}

/** Closes the section (its pages are kept for the next `openOpenings()` without a target). */
export function closeOpenings(): void {
  openSignal.value = false;
}

/** Opens a page over the current one. */
export function pushPage(page: OpeningsPage): void {
  batch(() => {
    stack.value = [...stack.value, keyed(page)];
    direction.value = 'forward';
  });
}

/** Back: the page under the top one, or closes the section from its root. Returns whether it is still open. */
export function popPage(): boolean {
  if (stack.value.length <= 1) {
    closeOpenings();
    return false;
  }
  batch(() => {
    stack.value = stack.value.slice(0, -1);
    direction.value = 'back';
  });
  return true;
}

/** Back to the root (Home). */
export function popToRoot(): void {
  if (stack.value.length <= 1) return;
  batch(() => {
    stack.value = stack.value.slice(0, 1);
    direction.value = 'back';
  });
}

/** Replaces the top page with another one (e.g. the next variation's drill). */
export function replacePage(page: OpeningsPage): void {
  batch(() => {
    stack.value = [...stack.value.slice(0, -1), keyed(page)];
    direction.value = 'forward';
  });
}

/**
 * Changes the top page in place (same kind; its key stays, so its view keeps its state), e.g. the
 * line's move on the board. `kind` guards against updating another page that has meanwhile come on top.
 */
export function updatePage<K extends OpeningsPage['kind']>(
  kind: K,
  change: (page: Extract<OpeningsPage, { kind: K }>) => Extract<OpeningsPage, { kind: K }>,
): void {
  const pages = stack.value;
  const top = pages.at(-1);
  if (!top || top.kind !== kind) return;
  const next = change(top as Extract<OpeningsPage, { kind: K }>);
  if (next === top) return;
  stack.value = [...pages.slice(0, -1), { ...next, key: top.key }];
}

/**
 * Puts the family's page under a line opened by its id alone (e.g. from a game), so Back leads to
 * the family first; only once, and only while that line still sits right on Home.
 */
export function insertFamilyBelow(family: string): void {
  const pages = stack.value;
  if (!lineAlone) return;
  lineAlone = false;
  if (pages.length !== 2 || pages[0].kind !== 'home' || pages[1].kind !== 'line') return;
  stack.value = [pages[0], keyed({ kind: 'family', family }), pages[1]];
}

/** Whether a line opened alone still waits for its family's page (see `insertFamilyBelow`). */
export function lineOpenedAlone(): boolean {
  return lineAlone;
}

/** Remembers the top page's scroll offset (before another page is pushed over it). */
export function rememberScroll(scroll: number): void {
  const pages = stack.value;
  const top = pages.at(-1);
  if (!top || top.scroll === scroll) return;
  stack.value = [...pages.slice(0, -1), { ...top, scroll }];
}

// -------------------------------------------------------------------------------------------------
// Step state (pure)

/** The line page on ply `ply` (clamped to 0..plies), back on the line. */
export function goToPly(page: LinePage, ply: number, plies: number): LinePage {
  const n = Math.max(0, Math.min(Math.max(0, plies), Math.floor(ply) || 0));
  if (n === page.ply && !page.offBook) return page;
  return { ...page, ply: n, offBook: null };
}

/**
 * One step along the line (`delta` -1 or +1, or more). From a move off the book, a step back
 * returns to the line at the same ply (the move is undone) and a step forward continues the line.
 */
export function stepLine(page: LinePage, delta: number, plies: number): LinePage {
  if (page.offBook && delta < 0) return { ...page, offBook: null };
  return goToPly(page, page.ply + delta, plies);
}

/** A move off the book after the line's current ply. */
export function leaveBook(page: LinePage, move: OffBookMove): LinePage {
  return { ...page, offBook: move };
}

/** The tree one move further. */
export function treeAdvance(page: TreePage, uci: string): TreePage {
  return { ...page, path: [...page.path, uci] };
}

/** The tree back to `depth` moves from the initial position (0 = the start; clamped). */
export function treeTo(page: TreePage, depth: number): TreePage {
  const n = Math.max(0, Math.min(page.path.length, Math.floor(depth) || 0));
  return n === page.path.length ? page : { ...page, path: page.path.slice(0, n) };
}

/** Forgets everything (tests). */
export function resetOpenings(): void {
  named = null;
  lineAlone = false;
  batch(() => {
    openSignal.value = false;
    stack.value = [];
    direction.value = 'none';
  });
}
