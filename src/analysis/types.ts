/** Shared analysis / coaching contracts. */
import type { Score } from '../engine/types';

export type MoveClass =
  | 'brilliant'
  | 'great'
  | 'best'
  | 'excellent'
  | 'good'
  | 'book'
  | 'forced'
  | 'inaccuracy'
  | 'mistake'
  | 'miss'
  | 'blunder';

/** Ordered for display in review summaries (best to worst). */
export const MOVE_CLASS_ORDER: MoveClass[] = [
  'brilliant',
  'great',
  'best',
  'excellent',
  'good',
  'book',
  'forced',
  'inaccuracy',
  'mistake',
  'miss',
  'blunder',
];

export interface Classification {
  cls: MoveClass;
  /** Expected score (0..1) for the mover before the move, assuming best play. */
  winBefore: number;
  /** Expected score (0..1) for the mover after the played move. */
  winAfter: number;
  /** max(0, winBefore - winAfter). */
  winLoss: number;
  /** Per-move accuracy 0..100. */
  accuracy: number;
  bestMoveUci: string | null;
  bestMoveSan: string | null;
  playedMoveSan: string;
  /**
   * The engine's top moves that are about as good as its best one (analysis/nearEqual.ts), best
   * first and the best included, at most 3 (the coach's MultiPV). When the played move was not
   * about as good itself, the moves it matched are left out (only the ones clearly better than it
   * are named with the best). Absent in older saves and when the position had no engine lines.
   */
  equalBest?: EqualMove[];
  /**
   * The played move was about as good as the engine's best (same rule), or was the best. Absent when
   * the played move's evaluation is unknown, and in older saves (the coach then corrects the move as
   * before: "Best was X.").
   */
  nearBest?: boolean;
  /**
   * With `nearBest`: the played move scored at least as well as the engine's best (a mate or a draw
   * the best line lacks, or its own search rates it higher), so the coach adds no note on the best
   * move. Absent otherwise.
   */
  aboveBest?: boolean;
}

/** One of `Classification.equalBest`. */
export interface EqualMove {
  san: string;
  uci: string;
  /** The engine's score for it, side to move before the move (the mover's point of view). */
  score?: Score;
}

/** Arrow kinds; 'line' is opening practice's next move of the line (a light guide, not engine advice). */
export type ArrowBrush = 'best' | 'alt' | 'threat' | 'played' | 'line';

export interface Arrow {
  from: string; // e.g. "e2"
  to: string; // e.g. "e4"
  brush: ArrowBrush;
}

export interface Explanation {
  /** One short sentence, e.g. "This hangs your knight on f3." */
  headline: string;
  /** 0-3 further short sentences. */
  details: string[];
  /** Best continuation in SAN, if relevant (up to ~6 plies). */
  bestLineSan?: string[];
  /** Arrows worth drawing on the board to illustrate the explanation. */
  arrows?: Arrow[];
  /** Short topic of the explanation, e.g. "Fork", "Hanging piece", "Missed mate", "Opening principle". */
  title?: string;
  /** Machine-readable tags for what the text talks about, e.g. ["fork"], ["hanging"], ["allowsMate", "backRank"]. */
  motifs?: string[];
  /**
   * Set when the class praises the move (Good or Excellent: in a decided position the expected
   * score barely moves) but the text says what it gives away: 'material' (it hangs a piece, or
   * loses at least a minor piece in a lost position: "This hangs your queen on b4.") or 'mate'
   * ("This lets White mate faster."). The UI should not show a praising title or badge for it.
   */
  concedes?: 'material' | 'mate';
}
