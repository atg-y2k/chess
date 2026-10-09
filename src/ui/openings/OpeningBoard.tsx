/**
 * The Openings section's board: the game's Board (same chessground theme, pieces and coordinates)
 * with an evaluation bar beside it, on its own position. It knows nothing about the game: the
 * page passes the position, who may move, and what to do with a move.
 *
 * The Learn and Tree boards (`drawable`) take Draw mode as the game's board does: the page puts
 * `OpeningDrawControls` (the Draw toggle, or the Draw bar) in the row under the board. The
 * drawings are kept by position while the section is open (the two pages share them), in memory.
 */
import { signal } from '@preact/signals';
import { Chess } from 'chess.js';
import { useEffect, useMemo } from 'preact/hooks';
import type { Arrow, MoveClass } from '../../analysis/types';
import { DRAW_COLORS, DRAW_TIP, NO_DRAWINGS, clearOn, drawOn, shapesAt, type DrawColor, type Drawings } from '../../game/drawings';
import { loadDrawTipSeen, saveDrawTipSeen } from '../../game/persistence';
import type { PromotionPiece } from '../../game/types';
import { openingsOpen } from '../../openings/session';
import { Board, type BoardColor } from '../Board';
import { DrawBar, DrawToggle } from '../DrawBar';
import { EvalBar } from '../EvalBar';
import { useEscapeLayer } from '../Sheet';
import type { EvalView } from './useEval';

export interface OpeningBoardProps {
  fen: string;
  orientation: BoardColor;
  /** The side that may move (the side to move, or the drill's player); none: read-only. */
  movable?: BoardColor;
  lastMove?: [string, string];
  arrows?: Arrow[];
  badge?: { square: string; cls: MoveClass };
  /** What the board's moves are for (a page): a change drops a move the user had started. */
  session: string;
  /** The evaluation bar (omitted: no bar, e.g. in a drill). */
  evaluation?: EvalView | null;
  /** Draw mode and the drawings of the section (Learn, Tree; see `OpeningDrawControls`). */
  drawable?: boolean;
  onMove: (from: string, to: string, promotion?: PromotionPiece) => void;
}

/** The section's Draw mode: on or off, its color, the tip, and the drawings by position. */
const draw = {
  on: signal(false),
  color: signal<DrawColor>(DRAW_COLORS[0]),
  tip: signal(false),
  drawings: signal<Drawings>(NO_DRAWINGS),
  /** The position on the drawable board on show (what Clear clears). */
  fen: signal<string | null>(null),
};

function exitDraw(): void {
  draw.on.value = false;
  draw.tip.value = false;
}

/** The first-use tip has made its point (the first drawing): not shown again on this device. */
function tipDone(): void {
  if (!draw.tip.value) return;
  saveDrawTipSeen();
  draw.tip.value = false;
}

/**
 * The section's Done in its navigation bar: in Draw mode it leaves Draw mode first (as Escape
 * does), so the bar's own Done and it never mean "close the section and forget the drawings" at
 * once. Returns whether it did.
 */
export function leaveSectionDraw(): boolean {
  if (!draw.on.value) return false;
  exitDraw();
  return true;
}

// The section closed: its drawings go (they were for this visit), and Draw mode with them.
openingsOpen.subscribe((open) => {
  if (open) return;
  exitDraw();
  draw.drawings.value = NO_DRAWINGS;
});

/**
 * The Draw toggle of the section's drawable board, or its Draw bar while Draw mode is on (as in the
 * game; the same first-use tip, said once per device). Escape leaves Draw mode before the page.
 */
export function OpeningDrawControls() {
  const on = draw.on.value;
  useEscapeLayer(on, exitDraw);
  const fen = draw.fen.value;
  if (!on) {
    return (
      <div class="op-draw">
        <DrawToggle
          onClick={() => {
            draw.tip.value = !loadDrawTipSeen(); // until the first drawing on the device
            draw.on.value = true;
          }}
        />
      </div>
    );
  }
  return (
    <div class="op-drawbar">
      <DrawBar
        color={draw.color.value}
        colors={DRAW_COLORS}
        canClear={!!fen && shapesAt(draw.drawings.value, fen).length > 0}
        tip={draw.tip.value ? DRAW_TIP : null}
        onColor={(c) => (draw.color.value = c)}
        onClear={() => {
          if (fen) draw.drawings.value = clearOn(draw.drawings.value, fen);
        }}
        onDone={exitDraw}
      />
    </div>
  );
}

/** Legal destinations by origin square, and whether the side to move is in check. */
export function positionOf(fen: string): { dests: Map<string, string[]>; check: boolean } {
  const dests = new Map<string, string[]>();
  try {
    const chess = new Chess(fen);
    for (const m of chess.moves({ verbose: true })) {
      const list = dests.get(m.from);
      if (list) list.push(m.to);
      else dests.set(m.from, [m.to]);
    }
    return { dests, check: chess.inCheck() };
  } catch {
    return { dests, check: false };
  }
}

/** "e2e4" -> ["e2", "e4"]. */
export const squaresOf = (uci: string | null | undefined): [string, string] | undefined =>
  uci ? [uci.slice(0, 2), uci.slice(2, 4)] : undefined;

export function OpeningBoard({ fen, orientation, movable, lastMove, arrows, badge, session, evaluation, drawable, onMove }: OpeningBoardProps) {
  const pos = useMemo(() => positionOf(fen), [fen]);
  // The drawable board says which position Clear is for; leaving its page ends Draw mode.
  useEffect(() => {
    if (drawable) draw.fen.value = fen;
  }, [drawable, fen]);
  useEffect(() => (drawable ? exitDraw : undefined), [drawable, session]);
  const shapes = drawable ? shapesAt(draw.drawings.value, fen) : undefined;
  const drawColor = drawable && draw.on.value ? draw.color.value : null;
  return (
    <div class="op-board" data-evalbar={evaluation ? '' : undefined}>
      {evaluation && (
        <EvalBar
          whiteWinProb={evaluation.whiteWinProb}
          label={evaluation.label}
          orientation={orientation}
          thinking={evaluation.thinking}
        />
      )}
      <div class="op-board-cell">
        <Board
          fen={fen}
          orientation={orientation}
          movableColor={movable}
          dests={pos.dests}
          lastMove={lastMove}
          check={pos.check}
          arrows={arrows}
          badge={badge}
          session={session}
          shapes={shapes}
          drawColor={drawColor}
          onDraw={(shape, drawnOn) => {
            draw.drawings.value = drawOn(draw.drawings.value, drawnOn, shape);
            tipDone();
          }}
          onMove={onMove}
        />
      </div>
    </div>
  );
}
