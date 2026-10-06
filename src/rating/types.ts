import type { Color, GameResult } from '../game/types';

export interface GameRecord {
  id: string;
  /** ISO timestamp of when the game ended. */
  date: string;
  playerColor: Color;
  botName: string;
  botElo: number;
  result: GameResult;
  /** 1 win, 0.5 draw, 0 loss — from the player's point of view. */
  playerScore: 1 | 0.5 | 0;
  /**
   * Whether the game changed the player's rating (no takebacks, hints, Retry, explorer, best-move
   * arrows or opponent move ratings used).
   */
  rated: boolean;
  ratingBefore: number;
  ratingAfter: number;
  /** Player's accuracy % if the game was reviewed. */
  accuracy?: number;
  reason: string;
  pgn: string;
}

export interface PlayerProfile {
  rating: number;
  /** Number of rated games played since the rating was (re)set (drives the K-factor). */
  gamesPlayed: number;
  peak: number;
  wins: number;
  draws: number;
  losses: number;
  /** Most recent first; capped in length by the persistence layer. */
  history: GameRecord[];
}
