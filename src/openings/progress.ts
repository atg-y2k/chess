/**
 * Saved drill progress per opening line, in localStorage under PROGRESS_KEY (its `chesscoach.`
 * prefix puts it in the App Store app's Preferences backup, see src/native/storage.ts).
 *
 * Mastery: 0 New (never drilled), 1 Learning (drilled, no clean run yet), 2 Familiar (a clean run),
 * 3 Mastered (clean runs on MASTERED_DAYS different local calendar days, each counted day at least
 * MIN_CLEAN_GAP_HOURS after the previous one, so it takes 40 hours at the least). Only full drills
 * count towards it (see recordDrill). It never goes down; `isDue` says when a line is worth
 * practicing again.
 *
 * No DOM access: storage is `localStorage` when present, or an injected stand-in. No call throws:
 * unavailable storage and quota errors give empty progress and skip saving; saved data that cannot
 * be read is never overwritten silently (see recordDrill). A Pro feature (see ./index).
 */
import { getFamily, getLine, linesOfFamily } from './catalog';
import type { DrillResult } from './drill';

/** localStorage key. The value is `{ v: 1, lines: { [lineId]: StoredLine } }`. */
export const PROGRESS_KEY = 'chesscoach.openings';
/** Where unreadable saved progress is copied before it is replaced (see recordDrill). */
export const PROGRESS_BACKUP_KEY = `${PROGRESS_KEY}.bak`;
const VERSION = 1;

/** Clean runs on this many different days make a line Mastered. */
export const MASTERED_DAYS = 3;
/** A clean run counts as a new clean day only this long after the run that added the last one. */
export const MIN_CLEAN_GAP_HOURS = 20;
/** How many clean days are kept per line (only the count up to MASTERED_DAYS matters). */
const MAX_CLEAN_DAYS = 10;

/** The subset of the Web Storage API used here (localStorage or an in-memory stand-in). */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type MasteryLevel = 0 | 1 | 2 | 3;

export const MASTERY_LABELS: Readonly<Record<MasteryLevel, string>> = Object.freeze({
  0: 'New',
  1: 'Learning',
  2: 'Familiar',
  3: 'Mastered',
});

export interface LineProgress {
  lineId: string;
  /** Completed drills. */
  attempts: number;
  /** Completed drills without mistakes or hints. */
  cleanRuns: number;
  /** ISO timestamp of the last completed drill (null: never). */
  lastPracticed: string | null;
  /** Whether the last completed drill was clean. */
  lastClean: boolean;
  /** Best score (0..100, see DrillResult.score). */
  bestScore: number;
  /** Local calendar days (YYYY-MM-DD) with a clean run, oldest first (the last few only). */
  cleanDays: readonly string[];
  mastery: MasteryLevel;
}

/** Progress over the lines of one family. */
export interface FamilyProgress {
  family: string;
  /** Lines in the family (0 while the catalog is not loaded). */
  lines: number;
  /** Lines drilled at least once. */
  practiced: number;
  learning: number;
  familiar: number;
  mastered: number;
  /** Completed drills over all its lines. */
  attempts: number;
  lastPracticed: string | null;
}

export interface ProgressOptions {
  /** Default: localStorage (null: nothing is read or saved). */
  storage?: KeyValueStorage | null;
  /** Default: the current time. */
  now?: Date;
}

/**
 * What `recordDrill` needs from a drill's outcome (a DrillResult has it). `playerMoves` 0 means
 * there was nothing to find (not recorded); `partial` means the drill skipped some of the player's
 * moves (practice only). Both are optional for hand-made outcomes (default: a full drill).
 */
export type DrillOutcome = Pick<DrillResult, 'clean'> & Partial<Pick<DrillResult, 'score' | 'playerMoves' | 'partial'>>;

interface StoredLine {
  attempts: number;
  cleanRuns: number;
  lastPracticed: string | null;
  lastClean: boolean;
  bestScore: number;
  cleanDays: string[];
  /** ISO time of the clean run that added the newest clean day (spacing, see MIN_CLEAN_GAP_HOURS). */
  cleanDayAt?: string;
  /** The line's family when it was recorded (summaries work before the catalog loads). */
  family?: string;
}

/** How reading the saved progress went. */
type ReadStatus = 'ok' | 'unavailable' | 'corrupt' | 'newer';

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const storageOf = (opts?: ProgressOptions): KeyValueStorage | null =>
  opts?.storage !== undefined ? opts.storage : defaultStorage();

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** Ids that are safe as keys of a plain object (no "__proto__") and of sane length. */
const validId = (id: string): boolean => id.length > 0 && id.length <= 200 && id !== '__proto__';

/** A stored record made safe, or null when it is unusable. */
function sanitize(v: unknown): StoredLine | null {
  if (!isObject(v)) return null;
  const attempts = count(v.attempts);
  const days = Array.isArray(v.cleanDays) ? v.cleanDays.filter((d): d is string => typeof d === 'string' && DAY_RE.test(d)) : [];
  const cleanDays = [...new Set(days)].sort().slice(-MAX_CLEAN_DAYS);
  const cleanRuns = Math.min(attempts, Math.max(count(v.cleanRuns), cleanDays.length));
  const last = isTime(v.lastPracticed) ? v.lastPracticed : null;
  const out: StoredLine = {
    attempts: Math.max(attempts, cleanRuns),
    cleanRuns,
    lastPracticed: last,
    lastClean: v.lastClean === true,
    bestScore: attempts ? Math.min(100, count(v.bestScore)) : 0,
    cleanDays: cleanRuns ? cleanDays : [],
  };
  if (out.cleanDays.length && isTime(v.cleanDayAt)) out.cleanDayAt = v.cleanDayAt;
  if (typeof v.family === 'string' && v.family) out.family = v.family;
  return out;
}

/**
 * The saved progress. `status` says whether it can be written back: 'ok' (also when nothing is
 * saved), 'unavailable' (no storage, or reading failed), 'corrupt' (not JSON or not this format;
 * `raw` holds it) or 'newer' (a later format version, e.g. after rolling an update back).
 */
function readAll(storage: KeyValueStorage | null): { lines: Map<string, StoredLine>; status: ReadStatus; raw: string | null } {
  const lines = new Map<string, StoredLine>();
  if (!storage) return { lines, status: 'unavailable', raw: null };
  let raw: string | null;
  try {
    raw = storage.getItem(PROGRESS_KEY);
  } catch {
    return { lines, status: 'unavailable', raw: null };
  }
  if (!raw) return { lines, status: 'ok', raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { lines, status: 'corrupt', raw };
  }
  if (isObject(parsed) && typeof parsed.v === 'number' && parsed.v > VERSION) return { lines, status: 'newer', raw };
  if (!isObject(parsed) || parsed.v !== VERSION || !isObject(parsed.lines)) return { lines, status: 'corrupt', raw };
  for (const [id, rec] of Object.entries(parsed.lines)) {
    const line = validId(id) ? sanitize(rec) : null;
    if (line) lines.set(id, line);
  }
  return { lines, status: 'ok', raw };
}

/**
 * Saves the progress over what `read` found. Never overwrites saved progress that could not be
 * read ('unavailable') or that a newer version wrote ('newer'); corrupt data is first copied to
 * PROGRESS_BACKUP_KEY. Returns whether storage was updated.
 */
function writeAll(storage: KeyValueStorage | null, read: ReturnType<typeof readAll>, lines: Map<string, StoredLine>): boolean {
  if (!storage || read.status === 'unavailable' || read.status === 'newer') return false;
  try {
    if (read.status === 'corrupt' && read.raw !== null) storage.setItem(PROGRESS_BACKUP_KEY, read.raw);
    if (lines.size) storage.setItem(PROGRESS_KEY, JSON.stringify({ v: VERSION, lines: Object.fromEntries(lines) }));
    else storage.removeItem(PROGRESS_KEY);
    return true;
  } catch {
    return false; // quota exceeded or storage unavailable
  }
}

/** Mastery level from the counters (see the module comment). */
export function masteryOf(p: Pick<LineProgress, 'attempts' | 'cleanRuns' | 'cleanDays'>): MasteryLevel {
  if (p.attempts <= 0) return 0;
  if (p.cleanDays.length >= MASTERED_DAYS) return 3;
  return p.cleanRuns > 0 ? 2 : 1;
}

function toProgress(lineId: string, s: StoredLine | undefined): LineProgress {
  const base = s ?? { attempts: 0, cleanRuns: 0, lastPracticed: null, lastClean: false, bestScore: 0, cleanDays: [] };
  const cleanDays = Object.freeze(base.cleanDays.slice());
  const p = {
    lineId,
    attempts: base.attempts,
    cleanRuns: base.cleanRuns,
    lastPracticed: base.lastPracticed,
    lastClean: base.lastClean,
    bestScore: base.bestScore,
    cleanDays,
  };
  return { ...p, mastery: masteryOf(p) };
}

/** "2026-10-06" for a date in local time. */
function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Progress of one line (mastery 0, zero counters when never drilled). */
export function getProgress(lineId: string, opts?: ProgressOptions): LineProgress {
  return toProgress(lineId, readAll(storageOf(opts)).lines.get(lineId));
}

/** Progress of every drilled line, by line id. */
export function allProgress(opts?: ProgressOptions): Record<string, LineProgress> {
  const out: Record<string, LineProgress> = {};
  for (const [id, s] of readAll(storageOf(opts)).lines) out[id] = toProgress(id, s);
  return out;
}

/**
 * Records a completed drill of a line and returns its new progress (also when it could not be
 * saved). A full, clean run counts towards Mastered when it falls on a new local calendar day at
 * least MIN_CLEAN_GAP_HOURS after the run that added the previous clean day. A partial drill
 * (`partial`, started past some of the player's moves) counts as practice only: an attempt, but no
 * clean run, clean day or best score. A drill with nothing to find (`playerMoves` 0) is not
 * recorded. Saved progress that cannot be read is not overwritten: from a newer app version or
 * unreadable storage the run is not saved; corrupt data is copied to PROGRESS_BACKUP_KEY first.
 */
export function recordDrill(lineId: string, result: DrillOutcome, opts?: ProgressOptions): LineProgress {
  const storage = storageOf(opts);
  const now = opts?.now ?? new Date();
  const read = readAll(storage);
  const prev = read.lines.get(lineId);
  if (result.playerMoves === 0 || !validId(lineId)) return toProgress(lineId, prev);
  const base = prev ?? { attempts: 0, cleanRuns: 0, lastPracticed: null, lastClean: false, bestScore: 0, cleanDays: [] };
  const full = result.partial !== true;
  const clean = result.clean === true;
  const counts = full && clean;
  const raw = typeof result.score === 'number' && Number.isFinite(result.score) ? result.score : clean ? 100 : 0;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const day = localDay(now);
  const lastAt = base.cleanDayAt ? Date.parse(base.cleanDayAt) : Number.NEGATIVE_INFINITY;
  const newDay =
    counts && !base.cleanDays.includes(day) && now.getTime() - lastAt >= MIN_CLEAN_GAP_HOURS * 3_600_000;
  const next: StoredLine = {
    attempts: base.attempts + 1,
    cleanRuns: base.cleanRuns + (counts ? 1 : 0),
    lastPracticed: now.toISOString(),
    lastClean: clean,
    bestScore: full ? Math.max(base.bestScore, score) : base.bestScore,
    cleanDays: newDay ? [...base.cleanDays, day].sort().slice(-MAX_CLEAN_DAYS) : base.cleanDays.slice(),
  };
  const cleanDayAt = newDay ? now.toISOString() : base.cleanDayAt;
  if (cleanDayAt) next.cleanDayAt = cleanDayAt;
  const family = getLine(lineId)?.family ?? base.family;
  if (family) next.family = family;
  read.lines.set(lineId, next);
  writeAll(storage, read, read.lines);
  return toProgress(lineId, next);
}

/**
 * Forgets the progress of one line, or of every line (also unreadable or newer saved data: an
 * explicit reset). Returns whether storage was updated.
 */
export function resetProgress(lineId?: string, opts?: ProgressOptions): boolean {
  const storage = storageOf(opts);
  if (lineId === undefined) {
    if (!storage) return false;
    try {
      storage.removeItem(PROGRESS_KEY);
      return true;
    } catch {
      return false;
    }
  }
  const read = readAll(storage);
  if (!read.lines.delete(lineId)) return false;
  return writeAll(storage, read, read.lines);
}

/**
 * Whether a drilled line is worth practicing now: its last run had mistakes, or the time since
 * then has reached its mastery's interval (Learning: any time, Familiar: 1 day, Mastered: 7 days).
 * Never-drilled lines are not "due" (they are new).
 */
export function isDue(p: LineProgress, now: Date = new Date()): boolean {
  if (p.attempts === 0 || !p.lastPracticed) return false;
  if (!p.lastClean || p.mastery <= 1) return true;
  const days = (now.getTime() - Date.parse(p.lastPracticed)) / 86_400_000;
  return days >= (p.mastery === 3 ? 7 : 1);
}

function summarize(family: string, total: number, records: [string, StoredLine][]): FamilyProgress {
  const out: FamilyProgress = { family, lines: total, practiced: 0, learning: 0, familiar: 0, mastered: 0, attempts: 0, lastPracticed: null };
  for (const [id, s] of records) {
    const p = toProgress(id, s);
    if (!p.attempts) continue;
    out.practiced++;
    out.attempts += p.attempts;
    if (p.mastery === 1) out.learning++;
    else if (p.mastery === 2) out.familiar++;
    else if (p.mastery === 3) out.mastered++;
    if (p.lastPracticed && (!out.lastPracticed || p.lastPracticed > out.lastPracticed)) out.lastPracticed = p.lastPracticed;
  }
  return out;
}

const familyOf = (id: string, s: StoredLine): string | undefined => getLine(id)?.family ?? s.family;

/**
 * Progress over one family's lines (counts lines by mastery). The name is matched like
 * `getFamily` ("ruy lopez" -> "Ruy Lopez") once the catalog has loaded.
 */
export function familyProgress(family: string, opts?: ProgressOptions): FamilyProgress {
  const name = getFamily(family)?.name ?? family;
  const total = linesOfFamily(name).length;
  const records = [...readAll(storageOf(opts)).lines].filter(([id, s]) => familyOf(id, s) === name);
  return summarize(name, total, records);
}

/** Progress per family, for every family with a drilled line, most recently practiced first. */
export function progressSummary(opts?: ProgressOptions): FamilyProgress[] {
  const byFamily = new Map<string, [string, StoredLine][]>();
  for (const [id, s] of readAll(storageOf(opts)).lines) {
    const f = familyOf(id, s);
    if (!f) continue;
    const list = byFamily.get(f);
    if (list) list.push([id, s]);
    else byFamily.set(f, [[id, s]]);
  }
  return [...byFamily]
    .map(([family, records]) => summarize(family, linesOfFamily(family).length, records))
    .sort((a, b) => ((b.lastPracticed ?? '') < (a.lastPracticed ?? '') ? -1 : (b.lastPracticed ?? '') > (a.lastPracticed ?? '') ? 1 : 0) || (a.family < b.family ? -1 : 1));
}
