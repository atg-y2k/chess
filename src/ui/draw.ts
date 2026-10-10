/**
 * Draw mode's touch gestures on the board (pure geometry, no DOM): which square a pointer is on,
 * and what a gesture draws. A drag from one square to another draws an arrow (shown while
 * dragging); a tap on a square draws a circle; a drag that ends on its start square or off the
 * board draws nothing. A finger that moves less than `dragThreshold` is still a tap, so a sloppy
 * tap never turns into an arrow to the next square.
 */
import type { DrawColor, UserShape } from '../game/drawings';

export type BoardSide = 'white' | 'black';

/** The board's box on the screen (a DOMRect will do). */
export interface BoardRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The square at (x, y) (client coordinates) on a board seen from `orientation`'s side, or null off the board. */
export function squareAt(x: number, y: number, rect: BoardRect, orientation: BoardSide): string | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const col = Math.floor(((x - rect.left) / rect.width) * 8);
  const row = Math.floor(((y - rect.top) / rect.height) * 8);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  const file = orientation === 'white' ? col : 7 - col;
  const rank = orientation === 'white' ? 7 - row : row;
  return String.fromCharCode(97 + file) + (rank + 1);
}

/** How far (CSS px) a finger must move before a touch is a drag: a quarter square, at least 8 px. */
export function dragThreshold(rect: BoardRect): number {
  return Math.max(8, rect.width / 32);
}

/** A gesture in progress: one pointer, from the square it went down on. */
export interface DrawGesture {
  pointerId: number;
  orig: string;
  /** Where it went down (client px). */
  x0: number;
  y0: number;
  /** It moved past the drag threshold: a drag (an arrow), no longer a tap (a circle). */
  dragging: boolean;
  /** The square under it now (null off the board). */
  over: string | null;
}

/** A gesture starting at (x, y), or null off the board. */
export function startGesture(pointerId: number, x: number, y: number, rect: BoardRect, orientation: BoardSide): DrawGesture | null {
  const orig = squareAt(x, y, rect, orientation);
  return orig ? { pointerId, orig, x0: x, y0: y, dragging: false, over: orig } : null;
}

/** The gesture after its pointer moved to (x, y). */
export function moveGesture(g: DrawGesture, x: number, y: number, rect: BoardRect, orientation: BoardSide): DrawGesture {
  const dragging = g.dragging || Math.hypot(x - g.x0, y - g.y0) >= dragThreshold(rect);
  return { ...g, dragging, over: squareAt(x, y, rect, orientation) };
}

/**
 * What the gesture would draw if it ended now: a circle on its square while it is a tap, an arrow
 * to the square under a drag, nothing while a drag is back on its start square or off the board.
 */
export function gestureShape(g: DrawGesture, brush: DrawColor): UserShape | null {
  if (!g.dragging) return { orig: g.orig, brush };
  return g.over && g.over !== g.orig ? { orig: g.orig, dest: g.over, brush } : null;
}

/** What the gesture draws when its pointer goes up at (x, y). */
export function endGesture(g: DrawGesture, x: number, y: number, rect: BoardRect, orientation: BoardSide, brush: DrawColor): UserShape | null {
  return gestureShape(moveGesture(g, x, y, rect, orientation), brush);
}
