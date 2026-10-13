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
   * Whether the game changed the player's rating (no takebacks, hints, Retry, engine in the
   * explorer, best-move arrows or opponent move ratings used).
   */
  rated: boolean;
  ratingBefore: number;
  ratingAfter: number;
  /** Player's accuracy % if the game was reviewed. */
  accuracy?: number;
  reason: string;
  /** The moves (with the tags): the source of truth for replaying the game. '' when it was dropped to save space. */
  pgn: string;
  /**
   * The opponent's persona id (`BotPersona.id`, 'custom' for an opponent at a chosen Elo), so the game
   * viewer and Play from here meet the same opponent. Older records have none (the name finds it).
   */
  botId?: string;
  /** Opening practice: the game began with this many book moves already played (absent = none). */
  preplayed?: number;
  /** A rated game played while the rating was still new (rating.ts `isProvisional`). Older records have none. */
  provisional?: boolean;
  /**
   * The coach's verdict on every move, compact (game/archive.ts): set once the game's moves are
   * checked, or when the game viewer analyzes an older game. Absent: not analyzed (yet).
   */
  analysis?: CompactAnalysis;
}

/**
 * A finished game's analysis as the history keeps it (game/archive.ts encodes and decodes it): a few
 * characters per move instead of the full annotations, so 200 games fit in the phone's storage.
 */
export interface CompactAnalysis {
  /** Format version. */
  v: 1;
  /** White-POV evaluation of the start position ("34", "-120", "#3", "#-2"; '' when unknown). */
  s: string;
  /**
   * One token per ply, separated by spaces: the class letter, the White-POV evaluation after the
   * move, flags, and the engine's better move ("b-512:d1h5"; "-" when the move is not analyzed).
   */
  p: string;
  /** The explanation headlines of the game's key moments, by ply index (Game Review's list, Try again). */
  h?: Record<string, string>;
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
