/**
 * The player's own drawings on the board (Draw mode): arrows and circles in four colors, kept per
 * position for the current game session, in memory only (pure: no DOM, signals or engine).
 *
 * A position is its piece placement and the side to move (`positionKey`): the same position
 * reached by another move order, or with other castling rights, an en passant square or move
 * counters, shows the same drawings. The game, the explorer and Game Review share them.
 */

/**
 * The colors of the player's drawings (chessground brush names: Board gives them the `--draw-*`
 * colors, and draws their arrows dashed, a look the engine's arrows never have).
 */
export type DrawColor = 'green' | 'red' | 'blue' | 'orange';

/** In the order the Draw bar offers them (the first is the default). */
export const DRAW_COLORS: readonly DrawColor[] = ['green', 'red', 'blue', 'orange'];

/** Their names (the swatches' labels). */
export const DRAW_COLOR_NAMES: Readonly<Record<DrawColor, string>> = {
  green: 'Green',
  red: 'Red',
  blue: 'Blue',
  orange: 'Orange',
};

/** Draw mode's first-use tip (until the first drawing on the device). */
export const DRAW_TIP = 'Drag for an arrow, tap a square for a circle. Draw it again to erase it. Tap Done to move pieces.';

/** One drawing: an arrow from `orig` to `dest`, or a circle on `orig` (no `dest`). Squares as "e4". */
export interface UserShape {
  orig: string;
  dest?: string;
  brush: DrawColor;
}

/** Drawings by `positionKey`. */
export type Drawings = ReadonlyMap<string, readonly UserShape[]>;

/** No drawings (shared, so an empty board keeps its identity). */
export const NO_SHAPES: readonly UserShape[] = [];
export const NO_DRAWINGS: Drawings = new Map();

/** The position a FEN shows, for its drawings: the piece placement and the side to move. */
export function positionKey(fen: string): string {
  const [placement = '', turn = 'w'] = fen.trim().split(/\s+/);
  return `${placement} ${turn}`;
}

/** Same squares (an arrow's direction counts; a circle has no `dest`). */
export function sameSquares(a: UserShape, b: UserShape): boolean {
  return a.orig === b.orig && (a.dest ?? null) === (b.dest ?? null);
}

/**
 * Drawing `shape` on `shapes`: the same squares in the same color take it off again, in another
 * color it changes color (as on lichess), else it is added on top.
 */
export function toggleShape(shapes: readonly UserShape[], shape: UserShape): readonly UserShape[] {
  const drawn = normalized(shape);
  const at = shapes.findIndex((s) => sameSquares(s, drawn));
  if (at < 0) return [...shapes, drawn];
  const rest = shapes.filter((_, i) => i !== at);
  return shapes[at].brush === drawn.brush ? rest : [...rest, drawn];
}

/** The drawings on the position `fen`. */
export function shapesAt(d: Drawings, fen: string): readonly UserShape[] {
  return d.get(positionKey(fen)) ?? NO_SHAPES;
}

/** Draws `shape` on the position `fen` (see `toggleShape`); a position left with none is forgotten. */
export function drawOn(d: Drawings, fen: string, shape: UserShape): Drawings {
  const key = positionKey(fen);
  const next = toggleShape(d.get(key) ?? NO_SHAPES, shape);
  const out = new Map(d);
  if (next.length) out.set(key, next);
  else out.delete(key);
  return out;
}

/** Removes the drawings on the position `fen` (the others stay). */
export function clearOn(d: Drawings, fen: string): Drawings {
  const key = positionKey(fen);
  if (!d.has(key)) return d;
  const out = new Map(d);
  out.delete(key);
  return out;
}

/** A circle never carries a `dest` equal to its square; an arrow keeps both squares. */
function normalized(shape: UserShape): UserShape {
  return shape.dest && shape.dest !== shape.orig
    ? { orig: shape.orig, dest: shape.dest, brush: shape.brush }
    : { orig: shape.orig, brush: shape.brush };
}
