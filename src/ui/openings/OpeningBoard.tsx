/**
 * The Openings section's board: the game's Board (same chessground theme, pieces and coordinates)
 * with an evaluation bar beside it, on its own position. It knows nothing about the game: the
 * page passes the position, who may move, and what to do with a move.
 */
import { Chess } from 'chess.js';
import { useMemo } from 'preact/hooks';
import type { Arrow, MoveClass } from '../../analysis/types';
import type { PromotionPiece } from '../../game/types';
import { Board, type BoardColor } from '../Board';
import { EvalBar } from '../EvalBar';
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
  onMove: (from: string, to: string, promotion?: PromotionPiece) => void;
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

export function OpeningBoard({ fen, orientation, movable, lastMove, arrows, badge, session, evaluation, onMove }: OpeningBoardProps) {
  const pos = useMemo(() => positionOf(fen), [fen]);
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
          onMove={onMove}
        />
      </div>
    </div>
  );
}
