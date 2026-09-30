import type { Score } from '../engine/types';
import type { Classification, Explanation } from '../analysis/types';

export type Color = 'w' | 'b';
export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

export interface Ply {
  /** 0-based ply index in the game. */
  index: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  /** Lower-case piece letter captured on this ply, if any. */
  captured?: string;
  /** Evaluation of the position AFTER this ply, from White's point of view. */
  evalWhite?: Score;
  /** Depth of `evalWhite`. */
  evalDepth?: number;
  classification?: Classification;
  explanation?: Explanation;
  /** Resulting position is a known opening position. */
  isBook?: boolean;
  /** Opening name after this ply (if known). */
  opening?: { eco: string; name: string };
}

export interface GameSettings {
  /** Colour the human asked for; 'random' is resolved when the game starts. */
  playerColor: Color | 'random';
  /** Persona id from `src/bot/personas.ts`, or 'custom' for a slider-chosen Elo. */
  botId: string;
  /** Opponent Elo (100..3200). */
  botElo: number;
  /** Opponent Elo follows the player's rating for the next game. */
  adaptive: boolean;
  /** Coach feedback (classification + explanation) after each of your moves. */
  coach: boolean;
  /** Vertical evaluation bar + eval graph. */
  showEvalBar: boolean;
  /** Live best-move arrows for the side to move while it is your turn. */
  showBestMoves: boolean;
  sound: boolean;
  allowTakebacks: boolean;
}

export const DEFAULT_SETTINGS: GameSettings = {
  playerColor: 'w',
  botId: 'custom',
  botElo: 800,
  adaptive: false,
  coach: true,
  showEvalBar: true,
  showBestMoves: false,
  sound: true,
  allowTakebacks: true,
};

export type GameResult = '1-0' | '0-1' | '1/2-1/2';

export interface GameOutcome {
  result: GameResult;
  winner: Color | null;
  /** Human readable, e.g. "Checkmate", "Resignation", "Stalemate", "Threefold repetition", "Insufficient material", "50-move rule". */
  reason: string;
}
