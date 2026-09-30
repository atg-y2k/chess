/**
 * Opening names and the bots' opening book, from src/data/openings.json (built by
 * scripts/build-openings.mjs from lichess-org/chess-openings, CC0).
 *
 * The table (~125 KiB gzip) is lazy-loaded with a dynamic import so it becomes its own chunk and
 * never blocks first paint: call `loadOpenings()` once (BotPlayer.newGame awaits it). Every other
 * function is synchronous and returns "nothing" (null / false / []) until the table has loaded.
 *
 * Keys are EPDs (first 4 FEN fields) exactly as chess.js `fen()` writes them: the en-passant square
 * appears only when an en-passant capture is legal. Lookups retry without the e.p. square, so FENs
 * from other sources work too.
 */
import { fenKey } from '../chess/utils';
import type { OpeningInfo } from './types';

interface OpeningsData {
  v: number;
  meta: Record<string, unknown>;
  /** EPD -> [eco, name] for every position that ends a dataset line. */
  names: Record<string, [string, string]>;
  /** EPD -> "uci:weight[:cpLoss] ..." sorted by weight (descending). */
  moves: Record<string, string>;
}

/** A book continuation. */
export interface BookMove {
  uci: string;
  /** Popularity proxy: round(sqrt(lines through the move * named positions reachable after it)). */
  weight: number;
  /** Stockfish (depth 12) centipawn loss vs the best move, mover's POV, 0..999. */
  cpLoss?: number;
}

/** Book moves losing at least this much are trap-line blunders ("Fool's Mate", ...), not "Book". */
export const BOOK_BLUNDER_CP = 150;

let data: OpeningsData | null = null;
let loading: Promise<void> | null = null;
const parsedMoves = new Map<string, BookMove[]>();

/** Loads the opening table (once; concurrent calls share the promise; a failed load can be retried). */
export function loadOpenings(): Promise<void> {
  loading ??= import('../data/openings.json')
    .then((m) => {
      data = ((m as { default?: unknown }).default ?? m) as OpeningsData;
    })
    .catch((e: unknown) => {
      loading = null;
      throw e;
    });
  return loading;
}

/** True once `loadOpenings()` has completed. */
export function openingsLoaded(): boolean {
  return data !== null;
}

/** Lookup keys for a FEN: its EPD, plus the EPD without an en-passant square as a fallback. */
function keysOf(fen: string): string[] {
  const key = fenKey(fen.trim());
  const parts = key.split(' ');
  if (parts.length === 4 && parts[3] !== '-') return [key, `${parts.slice(0, 3).join(' ')} -`];
  return [key];
}

function lookup<T>(table: Record<string, T> | undefined, fen: string): [string, T] | null {
  if (!table) return null;
  for (const k of keysOf(fen)) {
    if (Object.hasOwn(table, k)) return [k, table[k]];
  }
  return null;
}

/** The opening named exactly at this position, or null (unnamed, out of book, or not loaded yet). */
export function openingAt(fen: string): OpeningInfo | null {
  const hit = lookup(data?.names, fen);
  if (!hit) return null;
  const [eco, name] = hit[1];
  return { eco, name };
}

/** Splits "Sicilian Defense: Najdorf Variation" into family and variation ("" when none). */
export function splitOpeningName(name: string): { family: string; variation: string } {
  const i = name.indexOf(':');
  return i < 0 ? { family: name, variation: '' } : { family: name.slice(0, i), variation: name.slice(i + 1).trim() };
}

/**
 * Live opening label (lichess convention): walks back from the latest position to the most recent
 * named one, so transpositions are recognised and leaving book keeps the last name.
 * @param fens positions AFTER each ply, oldest first (`fens[i]` = after ply i+1).
 * @returns the opening plus `ply`, the number of plies played when it was reached; null if none.
 */
export function currentOpening(fens: string[]): (OpeningInfo & { ply: number }) | null {
  for (let i = fens.length - 1; i >= 0; i--) {
    const o = openingAt(fens[i]);
    if (o) return { ...o, ply: i + 1 };
  }
  return null;
}

/** The position is known theory (named, or on the way to a named line). */
export function isBookPosition(fen: string): boolean {
  if (!data) return false;
  return lookup(data.names, fen) !== null || lookup(data.moves, fen) !== null;
}

/** Book continuations from this position, most popular first ([] when none / not loaded). */
export function bookMoves(fen: string): BookMove[] {
  const hit = lookup(data?.moves, fen);
  if (!hit) return [];
  const [key, s] = hit;
  let list = parsedMoves.get(key);
  if (!list) {
    list = s.split(' ').map((tok) => {
      const [uci, w, c] = tok.split(':');
      return c === undefined ? { uci, weight: Number(w) } : { uci, weight: Number(w), cpLoss: Number(c) };
    });
    parsedMoves.set(key, list);
  }
  return list;
}

/**
 * Whether a played move counts as "Book": the resulting position is book (transpositions count)
 * and the move is not a known trap-line blunder (cpLoss >= 150, e.g. Fool's Mate 2.g4).
 * The classifier still refuses "Book" when the engine calls the move a mistake.
 */
export function isBookMove(fenBefore: string, uci: string, fenAfter: string): boolean {
  if (!isBookPosition(fenAfter)) return false;
  const known = bookMoves(fenBefore).find((m) => m.uci === uci);
  return !(known?.cpLoss !== undefined && known.cpLoss >= BOOK_BLUNDER_CP);
}

// -------------------------------------------------------------------------------------------------
// Bots

/** How a bot uses the book in one game (see research/openings.md §4). */
export interface BookProfile {
  /** The bot consults the book only while fewer plies than this have been played (drawn per game). */
  maxPly: number;
  /** Chance, per bot move after the first ply, to leave book for the rest of the game. */
  leaveProb: number;
  /** p(move) ~ weight^alpha * exp(-cpLoss / cpTemp); alpha < 1 flattens the choice (offbeat lines). */
  alpha: number;
  /** Ignore moves whose weight < minShare * the top weight (strong bots cut fringe sidelines). */
  minShare: number;
  /** Never play a book move losing more than this. */
  maxCpLoss: number;
  cpTemp: number;
}

/** Per-game book state; once a bot leaves book it never returns. */
export interface BookState {
  left: boolean;
}

/** Continuous book profile over Elo 100..3200. Call once per game (`maxPly` is randomised). */
export function bookProfile(elo: number, rng: () => number = Math.random): BookProfile {
  const t = Math.min(1, Math.max(0, (elo - 100) / 3100));
  const base = Math.round(2 + 26 * t); // 100 -> 2, 1000 -> 10, 2000 -> 18, 3200 -> 28
  const spread = Math.round(2 + 8 * t); // + 0..(2..10) plies of randomness
  return {
    maxPly: base + Math.floor(rng() * (spread + 1)),
    leaveProb: 0.01 + 0.3 * (1 - t) ** 2, // 100: .31  1000: .16  2000: .055  3200: .01
    alpha: 0.5 + 0.5 * t, // 100: .50  1000: .65  2000: .81  3200: 1.00
    minShare: 0.05 * t * t, // 1000: .004  2000: .019  3200: .05
    maxCpLoss: Math.round(300 - 240 * t), // 100: 300  1000: 230  2000: 153  3200: 60
    cpTemp: 40 + 400 * (1 - t) ** 2, // 100: 440  1000: 242  2000: 100  3200: 40
  };
}

/**
 * A book move for the bot, or null to ask the engine (book not loaded, out of book, past
 * `maxPly`, or the bot decided to leave book, which sets `state.left`).
 * @param plies plies already played in the game.
 */
export function pickBookMove(
  fen: string,
  plies: number,
  profile: BookProfile,
  state: BookState,
  rng: () => number = Math.random,
): string | null {
  if (state.left || plies >= profile.maxPly) return null;
  let cands = bookMoves(fen);
  if (!cands.length) return null;
  if (plies > 0 && rng() < profile.leaveProb) {
    // Never leave on the very first move: keeps first-move variety.
    state.left = true;
    return null;
  }
  cands = cands.filter((m) => (m.cpLoss ?? 0) <= profile.maxCpLoss);
  const top = Math.max(0, ...cands.map((m) => m.weight));
  cands = cands.filter((m) => m.weight >= profile.minShare * top);
  if (!cands.length) return null;
  const scores = cands.map((m) => m.weight ** profile.alpha * Math.exp(-(m.cpLoss ?? 0) / profile.cpTemp));
  let r = rng() * scores.reduce((a, b) => a + b, 0);
  for (let i = 0; i < cands.length; i++) {
    r -= scores[i];
    if (r <= 0) return cands[i].uci;
  }
  return cands[cands.length - 1].uci;
}
