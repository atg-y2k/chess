/**
 * The opening explorer: the tree of book moves (src/bot/book.ts) with names and shares, the
 * positions of a catalog line for stepping through it, and helpers to start or steer a game into a
 * line. Free features (see OPENINGS_FEATURE_TIERS in ./index).
 *
 * Needs the opening book for `children`, `nameAt` and `lineAt` (and for names in `pathTo`), and the
 * catalog for anything that takes a line id: `loadExplorer()` loads both. Like book.ts, every
 * function is synchronous and returns "nothing" (null / []) until the data it needs has loaded.
 */
import { Chess } from 'chess.js';
import { BOOK_BLUNDER_CP, bookMoves, loadOpenings, openingAt } from '../bot/book';
import type { OpeningInfo } from '../bot/types';
import { fenKey, parseUci, START_FEN, toUci } from '../chess/utils';
import type { Color } from '../game/types';
import { getLine, linesNamed, loadCatalog, splitLineName, type OpeningLine } from './catalog';

/** A book move from a position, for the explorer. */
export interface TreeMove {
  uci: string;
  san: string;
  /** FEN after the move (move counters continue from the input FEN). */
  fenAfter: string;
  /** The opening named exactly at the resulting position, if any. */
  name?: OpeningInfo;
  /** Id of the catalog line that ends at the resulting position (when the catalog has loaded). */
  lineId?: string;
  /**
   * Book weight (see BookMove.weight): how much named theory follows the move. It counts dataset
   * lines, not games, so heavily analyzed gambits score high.
   */
  weight: number;
  /**
   * 0..1: this move's share of the book weight among the moves from this position (they sum to 1).
   * A "how much theory" share for sorting and bars; do not label it "% of games".
   */
  share: number;
  /**
   * The main move here: the highest-weight move that is not dubious (a dubious move only when every
   * move here is); exactly one move per position.
   */
  isMain: boolean;
  /** Engine centipawn loss vs the best move (when the book has it). */
  cpLoss?: number;
  /** A known trap-line blunder (cpLoss >= BOOK_BLUNDER_CP): show it as "dubious", not as theory. */
  dubious: boolean;
}

/** The name of a position, possibly inherited from an earlier one. */
export interface PositionName extends OpeningInfo {
  family: string;
  variation: string;
  /** Named at this very position (false: the last named position before it). */
  exact: boolean;
}

/** One position of a line, for stepping through it. */
export interface LineStep {
  /** Plies played (0 = the initial position). */
  ply: number;
  /** Full FEN. */
  fen: string;
  /** The move that led here (null at ply 0). */
  uci: string | null;
  san: string | null;
  /** Who played that move (null at ply 0). */
  color: Color | null;
  /** "3. Bb5" / "3... a6" (null at ply 0). */
  label: string | null;
  /** The opening named exactly at this position (needs the book; the last step always has the line's name). */
  name?: OpeningInfo;
  /** The move that led here is a known trap-line blunder (cpLoss >= BOOK_BLUNDER_CP; needs the book). */
  dubious?: boolean;
}

/** Loads what the explorer needs: the opening book and the catalog. */
export async function loadExplorer(): Promise<void> {
  await Promise.all([loadOpenings(), loadCatalog()]);
}

/** "3. Bb5" for White's move at 0-based `ply` 4, "3... a6" for Black's at ply 5. */
export function moveLabel(ply: number, san: string): string {
  const n = Math.floor(ply / 2) + 1;
  return ply % 2 === 0 ? `${n}. ${san}` : `${n}... ${san}`;
}

/** A FEN with move counters ("... w KQkq -" from an EPD gets " 0 1"). */
function fullFen(fen: string): string {
  const parts = fen.trim().split(/\s+/);
  return parts.length >= 6 ? parts.slice(0, 6).join(' ') : [...parts.slice(0, 4), '0', '1'].join(' ');
}

/** EPD without the en-passant square: book keys and FENs from other sources agree on it. */
const looseKey = (fen: string): string => fenKey(fen.trim()).split(' ').slice(0, 3).join(' ');

/**
 * Book moves from this position, highest share first (sound moves before dubious ones of the same
 * weight), with their names. [] when the position is out of book, the FEN is invalid, or the book
 * has not loaded.
 */
export function children(fen: string): TreeMove[] {
  const list = bookMoves(fen);
  if (!list.length) return [];
  let chess: Chess;
  try {
    chess = new Chess(fullFen(fen));
  } catch {
    return [];
  }
  const total = list.reduce((s, m) => s + m.weight, 0) || 1;
  const out: TreeMove[] = [];
  for (const m of list) {
    let san: string;
    try {
      san = chess.move(parseUci(m.uci)).san;
    } catch {
      continue; // not legal here (cannot happen with consistent data)
    }
    const fenAfter = chess.fen();
    chess.undo();
    const name = openingAt(fenAfter) ?? undefined;
    const lineId = name ? lineAt(fenAfter)?.id : undefined;
    out.push({
      uci: m.uci,
      san,
      fenAfter,
      ...(name ? { name } : {}),
      ...(lineId ? { lineId } : {}),
      weight: m.weight,
      share: m.weight / total,
      isMain: false,
      ...(m.cpLoss !== undefined ? { cpLoss: m.cpLoss } : {}),
      dubious: (m.cpLoss ?? 0) >= BOOK_BLUNDER_CP,
    });
  }
  out.sort(
    (a, b) =>
      b.weight - a.weight ||
      Number(a.dubious) - Number(b.dubious) ||
      (a.cpLoss ?? 0) - (b.cpLoss ?? 0) ||
      (a.uci < b.uci ? -1 : 1),
  );
  const main = out.find((m) => !m.dubious) ?? out[0];
  if (main) main.isMain = true;
  return out;
}

/**
 * The opening name for a position: its own name, or else (like `currentOpening`) the most recent
 * named position in `history`, so transpositions are recognized and leaving book keeps the name.
 * @param history FENs of the earlier positions, oldest first.
 */
export function nameAt(fen: string, history: readonly string[] = []): PositionName | null {
  const here = openingAt(fen);
  if (here) return { ...here, ...splitLineName(here.name), exact: true };
  for (let i = history.length - 1; i >= 0; i--) {
    const o = openingAt(history[i]);
    if (o) return { ...o, ...splitLineName(o.name), exact: false };
  }
  return null;
}

/** The catalog line that ends at this position (needs the book and the catalog), or null. */
export function lineAt(fen: string): OpeningLine | null {
  const o = openingAt(fen);
  if (!o) return null;
  const cands = linesNamed(o.name, o.eco);
  if (cands.length <= 1) return cands[0] ?? null;
  const key = looseKey(fen);
  return cands.find((l) => looseKey(l.epd) === key) ?? cands[0];
}

const stepCache = new Map<string, readonly LineStep[]>();

function resolve(line: OpeningLine | string): OpeningLine | null {
  return typeof line === 'string' ? getLine(line) : line;
}

/** Positions of a line without names (cached per line id). */
function positions(line: OpeningLine): readonly LineStep[] {
  const cached = stepCache.get(line.id);
  if (cached) return cached;
  const chess = new Chess();
  const steps: LineStep[] = [{ ply: 0, fen: chess.fen(), uci: null, san: null, color: null, label: null }];
  try {
    line.san.forEach((san, i) => {
      const color = chess.turn();
      const mv = chess.move(san);
      steps.push({ ply: i + 1, fen: chess.fen(), uci: toUci(mv), san: mv.san, color, label: moveLabel(i, mv.san) });
    });
  } catch {
    /* keep the legal prefix (the data is validated at build time) */
  }
  const frozen = Object.freeze(steps.map((s) => Object.freeze(s)));
  stepCache.set(line.id, frozen);
  return frozen;
}

/**
 * Every position of a line, from the initial position (ply 0) to its end, for stepping through it
 * with names where the book names a position. [] for an unknown id (or before the catalog loads).
 */
export function pathTo(line: OpeningLine | string): LineStep[] {
  const l = resolve(line);
  if (!l) return [];
  const steps = positions(l);
  return steps.map((s, i) => {
    const name = openingAt(s.fen) ?? (i === steps.length - 1 && i === l.plies ? { eco: l.eco, name: l.name } : null);
    const known = i > 0 ? bookMoves(steps[i - 1].fen).find((m) => m.uci === s.uci) : undefined;
    const dubious = (known?.cpLoss ?? 0) >= BOOK_BLUNDER_CP;
    return { ...s, ...(name ? { name } : {}), ...(dubious ? { dubious } : {}) };
  });
}

/**
 * Where a game played from a line starts: the moves (UCI, from the initial position) and the FEN
 * after the first `plies` plies (default, or not a finite number: the whole line; clamped to the
 * line), and whose move it is there. Null for an unknown id.
 */
export function lineStart(
  line: OpeningLine | string,
  plies?: number,
): { startFen: string; moves: string[]; fen: string; turn: Color } | null {
  const l = resolve(line);
  if (!l) return null;
  const steps = positions(l);
  const last = steps.length - 1;
  const n = plies !== undefined && Number.isFinite(plies) ? Math.max(0, Math.min(Math.floor(plies), last)) : last;
  const fen = steps[n].fen;
  const moves = steps.slice(1, n + 1).map((s) => s.uci as string);
  return { startFen: START_FEN, moves, fen, turn: fen.split(' ')[1] === 'b' ? 'b' : 'w' };
}

/**
 * The line's move from this position, for steering a game into the line (a bot playing it, or a
 * coach suggesting it): the position may come from any move order (transpositions count). Null
 * when the position is not on the line or the line ends there.
 */
export function nextLineMove(line: OpeningLine | string, fen: string): { uci: string; san: string; ply: number } | null {
  const l = resolve(line);
  if (!l) return null;
  const steps = positions(l);
  const key = looseKey(fen);
  for (let i = 0; i < steps.length - 1; i++) {
    if (looseKey(steps[i].fen) === key) {
      const next = steps[i + 1];
      return { uci: next.uci as string, san: next.san as string, ply: i };
    }
  }
  return null;
}
