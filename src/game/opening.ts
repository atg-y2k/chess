/**
 * Opening practice: a game against the bot that follows a named line of the openings catalog
 * (src/openings/catalog.ts), started with `GameController.newGame(settings, { opening })`. This
 * module says where a game stands on its line. Pure: no engine, DOM or signals.
 *
 * A position is "on the line" when the line reaches it, whatever the move order (transpositions
 * count, as in `nextLineMove`): the board, the side to move and the castling rights match one of
 * the line's positions. The game has "left" the line when its position is off it, and the line is
 * "complete" once the game has reached the line's last position.
 */
import { Chess } from 'chess.js';
import { BOOK_BLUNDER_CP, bookMoves } from '../bot/book';
import { fenKey, parseUci, sideToMove, toUci } from '../chess/utils';
import type { OpeningLine } from '../openings/catalog';
import { lineStart, nextLineMove } from '../openings/tree';
import { moveLabel } from './coach';
import type { Color, Ply } from './types';

/** 'steer': the bot plays the line's moves while the game is on it; 'skip': the line is played before the game starts. */
export type OpeningMode = 'steer' | 'skip';

/** The opening a game follows (`GameInfo.opening`). */
export interface OpeningTarget {
  line: OpeningLine;
  mode: OpeningMode;
  /** Steer only: the line's next move shows (a light arrow and a coach line) on the player's turn. */
  showLineMoves: boolean;
  /**
   * The line came with the game (its moves, name and family, see `studyOpeningLine`) rather than
   * from the catalog, e.g. an opening guide's annotated main line: it is saved with its moves.
   */
  custom?: boolean;
}

export type LineStatus = 'on-line' | 'left' | 'complete';

/** A move of the line, as the game would play it. */
export interface LineMove {
  uci: string;
  san: string;
  /** "3. Bc4" / "3… Nf6", numbered as in the game (a transposition can number it differently). */
  label: string;
  /** Who plays it. */
  color: Color;
  /** Its place in the line (0-based ply). */
  ply: number;
  /**
   * The opening book knows it as a mistake (a line that shows how it gets punished, such as 2. g4
   * in the Fool's Mate): the coach says so when it suggests it.
   */
  dubious?: true;
}

/** Where a game stands on its line. */
export interface LineProgress {
  status: LineStatus;
  /** Plies of the line reached (0..line.plies; all of them once complete). */
  reached: number;
  /** While on the line: its next move. */
  next: LineMove | null;
  /** The game left the line: the ply that left it (`index`) and the move the line had there. */
  left: { index: number; expected: LineMove } | null;
  /** The line is complete: the index of the ply that reached its end. */
  completedAt: number | null;
}

/** Position identity on a line: board, side to move and castling rights (as tree.ts compares them). */
const looseKey = (fen: string): string => fenKey(fen.trim()).split(' ').slice(0, 3).join(' ');

const placesCache = new WeakMap<OpeningLine, Map<string, number>>();

/** The line's positions (loose keys) -> their ply (the first one, should a position repeat). */
function placesOf(line: OpeningLine): Map<string, number> {
  let places = placesCache.get(line);
  if (places) return places;
  places = new Map();
  for (let k = 0; k <= line.plies; k++) {
    const at = lineStart(line, k);
    if (!at) break;
    const key = looseKey(at.fen);
    if (!places.has(key)) places.set(key, k);
  }
  placesCache.set(line, places);
  return places;
}

/** The line's move from `fen` (numbered from `fen`), or null when `fen` is off the line or at its end. */
export function lineMoveAt(line: OpeningLine, fen: string): LineMove | null {
  const next = nextLineMove(line, fen);
  if (!next) return null;
  const color = sideToMove(fen);
  const known = bookMoves(fen).find((m) => m.uci === next.uci);
  const dubious = (known?.cpLoss ?? 0) >= BOOK_BLUNDER_CP;
  return {
    uci: next.uci,
    san: next.san,
    ply: next.ply,
    color,
    label: moveLabel({ fenBefore: fen, san: next.san, color, index: next.ply }),
    ...(dubious ? { dubious: true as const } : {}),
  };
}

/** Moves a line given with a game may have at most (catalog lines have up to 36 plies). */
export const MAX_LINE_PLIES = 60;

/**
 * A line that is not in the catalog, as the game follows it (`OpeningGameOptions.moves`): `uci`
 * from the initial position, all legal (else null), at most MAX_LINE_PLIES. `name` is what the game
 * shows ("London System"); `id` keys it (e.g. "guide:London System", which the Openings section
 * opens from the game's banner).
 */
export function studyOpeningLine(id: string, uci: readonly string[], name: string, family: string): OpeningLine | null {
  if (!id || !uci.length || uci.length > MAX_LINE_PLIES) return null;
  const chess = new Chess();
  const san: string[] = [];
  const moves: string[] = [];
  try {
    for (const u of uci) {
      const mv = chess.move(parseUci(u));
      san.push(mv.san);
      moves.push(toUci(mv));
    }
  } catch {
    return null;
  }
  const shown = name.trim() || family.trim() || 'Opening';
  return Object.freeze({
    id,
    eco: '',
    name: shown,
    family: family.trim() || shown,
    variation: '',
    san: Object.freeze(san),
    uci: Object.freeze(moves),
    epd: chess.fen().split(' ').slice(0, 4).join(' '),
    plies: san.length,
    popularity: 0,
  });
}

/**
 * Where the game (`plies` from `startFen`) stands on `line`: complete once any position of the game
 * was the line's last one; else on the line when the current position is on it (with the line's next
 * move); else left, with the most recent ply that went from a position on the line to one off it.
 */
export function lineProgress(line: OpeningLine, startFen: string, plies: readonly Pick<Ply, 'fenAfter'>[]): LineProgress {
  const places = placesOf(line);
  const fenAt = (k: number): string => (k === 0 ? startFen : plies[k - 1].fenAfter);
  const placeAt = (k: number): number | undefined => places.get(looseKey(fenAt(k)));
  const end = line.plies;
  for (let k = 0; k <= plies.length; k++) {
    if (placeAt(k) === end) return { status: 'complete', reached: end, next: null, left: null, completedAt: k - 1 };
  }
  const n = plies.length;
  const here = placeAt(n);
  if (here !== undefined) {
    return { status: 'on-line', reached: here, next: lineMoveAt(line, fenAt(n)), left: null, completedAt: null };
  }
  for (let k = n; k >= 1; k--) {
    const place = placeAt(k - 1);
    const expected = place === undefined ? null : lineMoveAt(line, fenAt(k - 1));
    if (expected) return { status: 'left', reached: place ?? 0, next: null, left: { index: k - 1, expected }, completedAt: null };
  }
  return { status: 'left', reached: 0, next: null, left: null, completedAt: null };
}

/** The line's length in moves (a move = White's and Black's; lines start from the initial position). */
export function lineMoves(line: OpeningLine): number {
  return Math.ceil(line.plies / 2);
}

/** The line's move number of the move at line ply `ply` (1-based). */
export function lineMoveNumber(ply: number): number {
  return Math.floor(ply / 2) + 1;
}
