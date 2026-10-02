/**
 * Pure UCI protocol helpers: parsing engine output lines into our contract types, building
 * commands, and assembling MultiPV batches. No DOM, no timers — unit-tested in node.
 */
import type { PvLine, Score } from './types';

/** One parsed `info` line (everything optional except `pv`, which may be empty). */
export interface UciInfo {
  depth?: number;
  seldepth?: number;
  /** 1-based MultiPV index (absent on e.g. `info depth 0 score mate 0`). */
  multipv?: number;
  score?: Score;
  bound?: 'lower' | 'upper';
  wdl?: [number, number, number];
  nodes?: number;
  nps?: number;
  timeMs?: number;
  hashfull?: number;
  pv: string[];
}

/** A classified engine output line. */
export type UciMessage =
  | { type: 'uciok' }
  | { type: 'readyok' }
  | { type: 'info'; info: UciInfo }
  /** `move` is null for `bestmove (none)` (no legal moves). */
  | { type: 'bestmove'; move: string | null; ponder?: string }
  /** `info string CRITICAL ERROR: …` — the engine rejected a command and will not finish the search. */
  | { type: 'error'; message: string }
  /** Banner, `id …`, `option …`, `info string …` and anything else we don't act on. */
  | { type: 'other' };

const NUMERIC_FIELDS: Record<string, keyof UciInfo> = {
  depth: 'depth',
  seldepth: 'seldepth',
  multipv: 'multipv',
  nodes: 'nodes',
  nps: 'nps',
  time: 'timeMs',
  hashfull: 'hashfull',
};

/** Parses an `info` line. Returns null for non-info lines and for `info string …` messages. */
export function parseInfo(line: string): UciInfo | null {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'info' || t[1] === 'string') return null;
  const out: UciInfo = { pv: [] };
  for (let i = 1; i < t.length; i++) {
    const key = t[i];
    const numeric = NUMERIC_FIELDS[key];
    if (numeric) {
      const n = Number(t[++i]);
      if (Number.isFinite(n)) (out as unknown as Record<string, number>)[numeric] = n;
    } else if (key === 'score') {
      const kind = t[i + 1];
      const value = Number(t[i + 2]);
      if ((kind === 'cp' || kind === 'mate') && Number.isFinite(value)) out.score = { kind, value };
      i += 2;
    } else if (key === 'lowerbound') {
      out.bound = 'lower';
    } else if (key === 'upperbound') {
      out.bound = 'upper';
    } else if (key === 'wdl') {
      const w = [Number(t[i + 1]), Number(t[i + 2]), Number(t[i + 3])];
      if (w.every(Number.isFinite)) out.wdl = w as [number, number, number];
      i += 3;
    } else if (key === 'currmove' || key === 'refutation' || key === 'currline') {
      // Not used; `currmove` takes one argument. Skip it (the others never appear without pv).
      i += 1;
    } else if (key === 'pv') {
      out.pv = t.slice(i + 1).filter(Boolean);
      break;
    } else if (key === 'string') {
      return null;
    }
    // Unknown tokens (tbhits, currmovenumber, …) are skipped; numeric args are skipped next turn
    // because they are not keys we know.
  }
  return out;
}

/**
 * Converts a parsed info line into a PvLine. Returns null unless it has a depth, a score and a
 * non-empty pv (so `info depth 0 score mate 0` in a mated position yields null).
 */
export function toPvLine(info: UciInfo): PvLine | null {
  if (info.depth === undefined || !info.score || info.pv.length === 0) return null;
  const line: PvLine = { multipv: info.multipv ?? 1, depth: info.depth, score: info.score, pv: info.pv };
  if (info.seldepth !== undefined) line.seldepth = info.seldepth;
  if (info.bound) line.bound = info.bound;
  if (info.wdl) line.wdl = info.wdl;
  if (info.nodes !== undefined) line.nodes = info.nodes;
  if (info.nps !== undefined) line.nps = info.nps;
  if (info.timeMs !== undefined) line.timeMs = info.timeMs;
  return line;
}

/** Convenience: parses an `info` line straight into a PvLine (null if it isn't a scored PV line). */
export function parsePvLine(line: string): PvLine | null {
  const info = parseInfo(line);
  return info ? toPvLine(info) : null;
}

/** Parses `bestmove <move> [ponder <move>]`. `(none)` / `0000` become null. */
export function parseBestMove(line: string): { move: string | null; ponder?: string } | null {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'bestmove') return null;
  const raw = t[1];
  const move = !raw || raw === '(none)' || raw === '0000' ? null : raw;
  const pi = t.indexOf('ponder');
  const ponder = pi > 1 ? t[pi + 1] : undefined;
  return ponder ? { move, ponder } : { move };
}

/** Classifies one line of engine output. */
export function parseUciLine(line: string): UciMessage {
  const s = line.trim();
  if (s === 'uciok') return { type: 'uciok' };
  if (s === 'readyok') return { type: 'readyok' };
  if (s.startsWith('bestmove')) {
    const b = parseBestMove(s);
    return b ? { type: 'bestmove', ...b } : { type: 'other' };
  }
  if (s.startsWith('info string')) {
    const msg = s.slice('info string'.length).trim();
    return /^CRITICAL ERROR/i.test(msg) ? { type: 'error', message: msg } : { type: 'other' };
  }
  if (s.startsWith('info')) {
    const info = parseInfo(s);
    return info ? { type: 'info', info } : { type: 'other' };
  }
  return { type: 'other' };
}

/** Search limits for `go`. */
export interface GoLimits {
  depth?: number;
  nodes?: number;
  movetime?: number;
}

/** Default depth when a search is requested without any limit. */
export const DEFAULT_SEARCH_DEPTH = 18;

/** Builds a finite `go` command (never `infinite`); falls back to depth 18 when no limit is given. */
export function goCommand(limits: GoLimits): string {
  const parts = ['go'];
  const add = (key: keyof GoLimits) => {
    const v = limits[key];
    if (v !== undefined && Number.isFinite(v) && v > 0) parts.push(key, String(Math.max(1, Math.round(v))));
  };
  add('depth');
  add('nodes');
  add('movetime');
  if (parts.length === 1) parts.push('depth', String(DEFAULT_SEARCH_DEPTH));
  return parts.join(' ');
}

export type OptionValue = string | number | boolean;

/** `setoption name <name> value <value>` (booleans as `true`/`false`). */
export function setOptionCommand(name: string, value: OptionValue): string {
  return `setoption name ${name} value ${String(value)}`;
}

/**
 * Assembles MultiPV output into complete batches. Stockfish prints `multipv 1..N` once per
 * finished iteration; after a `stop`/limit (or >10M nodes) it can print a mixed batch where some
 * lines are bounds (`lowerbound`/`upperbound`) or one depth shallower. Only a batch where all N
 * lines are present, exact and at the same depth is returned.
 */
export class MultiPvCollector {
  private pending: (PvLine | undefined)[] = [];

  /** @param expected number of lines per batch = min(MultiPV, legal move count). */
  constructor(readonly expected: number) {}

  /** Feeds one PV line; returns the complete batch (sorted by multipv) when this line completes one. */
  push(line: PvLine): PvLine[] | null {
    const idx = line.multipv - 1;
    if (idx < 0 || idx >= this.expected) return null;
    if (idx === 0) this.pending = [];
    this.pending[idx] = line;
    if (idx !== this.expected - 1) return null;
    const first = this.pending[0];
    if (!first) return null;
    for (let i = 0; i < this.expected; i++) {
      const l = this.pending[i];
      if (!l || l.bound || l.depth !== first.depth) return null;
    }
    const batch = this.pending as PvLine[];
    this.pending = [];
    return batch;
  }
}
