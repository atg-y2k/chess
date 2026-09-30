/**
 * Player rating: Elo maths against the bot ladder plus profile persistence.
 *
 * The rating is a plain Elo estimate: E = 1 / (1 + 10^((Rbot - R) / 400)), R += K * (S - E), with
 * K = 60 for the first 10 rated games, 32 up to game 30, then 16 (research/strength.md). This makes
 * the player's rating self-consistent with the bot ladder whatever its absolute offset is.
 *
 * No DOM access: storage is `localStorage` when present (or an injected stand-in), and every
 * storage call is wrapped so private mode, quota errors or corrupt data never throw.
 */
import type { Color, GameResult } from '../game/types';
import type { GameRecord, PlayerProfile } from './types';

export const MIN_RATING = 100;
export const MAX_RATING = 3200;
export const DEFAULT_RATING = 800;
/** Maximum number of games kept in `PlayerProfile.history` (most recent first). */
export const HISTORY_LIMIT = 200;
/** localStorage key of the profile. The value is `{ version: 1, profile: PlayerProfile }`. */
export const PROFILE_KEY = 'chesscoach.profile';
const PROFILE_VERSION = 1;

/** The subset of the Web Storage API used here (localStorage or an in-memory stand-in). */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Game data passed to `applyGameResult`; the rating fields are filled in by it. */
export type GameRecordInput = Omit<GameRecord, 'ratingBefore' | 'ratingAfter'>;

const RESULTS: readonly GameResult[] = ['1-0', '0-1', '1/2-1/2'];

/** Rounds and clamps a rating to 100..3200 (non-finite input gives the default rating). */
export function clampRating(rating: number): number {
  if (!Number.isFinite(rating)) return DEFAULT_RATING;
  return Math.min(MAX_RATING, Math.max(MIN_RATING, Math.round(rating)));
}

/** Elo expected score (0..1) of a player rated `rating` against `opponent`. */
export function expectedScore(rating: number, opponent: number): number {
  return 1 / (1 + Math.pow(10, (opponent - rating) / 400));
}

/** K-factor for the next rated game: 60 for the first 10 games, 32 up to game 30, then 16. */
export function kFactor(gamesPlayed: number): number {
  if (gamesPlayed < 10) return 60;
  if (gamesPlayed < 30) return 32;
  return 16;
}

/** The player's score (1 win, 0.5 draw, 0 loss) for a result. */
export function playerScoreFor(result: GameResult, playerColor: Color): 1 | 0.5 | 0 {
  if (result === '1/2-1/2') return 0.5;
  return (result === '1-0') === (playerColor === 'w') ? 1 : 0;
}

/** A fresh profile: rating 800, no games. */
export function defaultProfile(): PlayerProfile {
  return {
    rating: DEFAULT_RATING,
    gamesPlayed: 0,
    peak: DEFAULT_RATING,
    wins: 0,
    draws: 0,
    losses: 0,
    history: [],
  };
}

/**
 * Records a finished game and returns the updated profile plus the completed record.
 *
 * - Rated games move the rating by K * (score - expected) (rounded, clamped to 100..3200) and
 *   increment `gamesPlayed` (the rated-game count that drives the K-factor).
 * - Unrated games keep the rating and `gamesPlayed` as they are (ratingBefore === ratingAfter),
 *   but are still added to the history and to wins / draws / losses.
 * - `history` is newest first and capped at HISTORY_LIMIT.
 * - A record whose id is already in the history is not applied twice: the profile is returned
 *   unchanged together with the stored record.
 *
 * Pure: the input profile is not mutated.
 */
export function applyGameResult(
  profile: PlayerProfile,
  record: GameRecordInput,
): { profile: PlayerProfile; record: GameRecord } {
  const existing = profile.history.find((r) => r.id === record.id);
  if (existing) return { profile, record: existing };

  const ratingBefore = profile.rating;
  const delta = kFactor(profile.gamesPlayed) * (record.playerScore - expectedScore(ratingBefore, record.botElo));
  const ratingAfter = record.rated ? clampRating(ratingBefore + delta) : ratingBefore;
  const full: GameRecord = { ...record, ratingBefore, ratingAfter };

  return {
    record: full,
    profile: {
      ...profile,
      rating: ratingAfter,
      gamesPlayed: profile.gamesPlayed + (record.rated ? 1 : 0),
      peak: Math.max(profile.peak, ratingAfter),
      wins: profile.wins + (record.playerScore === 1 ? 1 : 0),
      draws: profile.draws + (record.playerScore === 0.5 ? 1 : 0),
      losses: profile.losses + (record.playerScore === 0 ? 1 : 0),
      history: [full, ...profile.history].slice(0, HISTORY_LIMIT),
    },
  };
}

/**
 * Updates fields of a recorded game that do not affect the rating (e.g. `accuracy` once the game
 * has been reviewed). Returns the same profile object when no record has that id.
 */
export function updateGameRecord(
  profile: PlayerProfile,
  id: string,
  patch: Partial<Pick<GameRecord, 'accuracy' | 'pgn' | 'reason'>>,
): PlayerProfile {
  const index = profile.history.findIndex((r) => r.id === id);
  if (index < 0) return profile;
  const history = profile.history.slice();
  history[index] = { ...history[index], ...patch };
  return { ...profile, history };
}

/** Opponent Elo that matches the player: the rating rounded to the nearest 50, within 100..3200. */
export function suggestedOpponentElo(profile: PlayerProfile): number {
  return Math.min(MAX_RATING, Math.max(MIN_RATING, Math.round(clampRating(profile.rating) / 50) * 50));
}

// ---------------------------------------------------------------------------------------------
// Persistence

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Loads the profile. Missing, unreadable or corrupt data gives a sanitised or default profile. */
export function loadProfile(storage: KeyValueStorage | null = defaultStorage()): PlayerProfile {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(PROFILE_KEY) ?? null;
  } catch {
    return defaultProfile();
  }
  if (!raw) return defaultProfile();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return defaultProfile();
    // Versioned envelope; a bare profile object is accepted too.
    return sanitizeProfile(isObject(parsed.profile) ? parsed.profile : parsed);
  } catch {
    return defaultProfile();
  }
}

/**
 * Saves the profile. If the storage quota is exceeded it retries with a slimmer history (PGNs of
 * older games dropped, then only the 20 most recent games). Returns whether anything was stored.
 */
export function saveProfile(p: PlayerProfile, storage: KeyValueStorage | null = defaultStorage()): boolean {
  if (!storage) return false;
  const full = p.history.slice(0, HISTORY_LIMIT);
  const attempts: (() => GameRecord[])[] = [
    () => full,
    () => full.map((r, i) => (i < 20 ? r : { ...r, pgn: '' })),
    () => full.slice(0, 20),
  ];
  for (const history of attempts) {
    try {
      storage.setItem(PROFILE_KEY, JSON.stringify({ version: PROFILE_VERSION, profile: { ...p, history: history() } }));
      return true;
    } catch {
      /* quota exceeded or storage unavailable: try a smaller payload */
    }
  }
  return false;
}

/** Validates untrusted profile data field by field, falling back to defaults for bad fields. */
export function sanitizeProfile(raw: unknown): PlayerProfile {
  if (!isObject(raw)) return defaultProfile();
  const seen = new Set<string>();
  const history: GameRecord[] = [];
  if (Array.isArray(raw.history)) {
    for (const item of raw.history) {
      const rec = sanitizeRecord(item);
      if (!rec || seen.has(rec.id)) continue;
      seen.add(rec.id);
      history.push(rec);
      if (history.length >= HISTORY_LIMIT) break;
    }
  }
  // A lost rating is recovered from the newest game when possible.
  const rating = isFiniteNumber(raw.rating) ? clampRating(raw.rating) : (history[0]?.ratingAfter ?? DEFAULT_RATING);
  return {
    rating,
    gamesPlayed: count(raw.gamesPlayed),
    peak: Math.max(rating, isFiniteNumber(raw.peak) ? clampRating(raw.peak) : rating),
    wins: count(raw.wins),
    draws: count(raw.draws),
    losses: count(raw.losses),
    history,
  };
}

function sanitizeRecord(raw: unknown): GameRecord | null {
  if (!isObject(raw)) return null;
  const { id, playerColor, result } = raw;
  if (typeof id !== 'string' || !id) return null;
  if (playerColor !== 'w' && playerColor !== 'b') return null;
  if (!RESULTS.includes(result as GameResult)) return null;
  if (!isFiniteNumber(raw.botElo) || !isFiniteNumber(raw.ratingBefore) || !isFiniteNumber(raw.ratingAfter)) return null;
  const score = raw.playerScore;
  const record: GameRecord = {
    id,
    date: typeof raw.date === 'string' ? raw.date : '',
    playerColor,
    botName: typeof raw.botName === 'string' ? raw.botName : 'Bot',
    botElo: Math.round(raw.botElo),
    result: result as GameResult,
    playerScore: score === 1 || score === 0.5 || score === 0 ? score : playerScoreFor(result as GameResult, playerColor),
    rated: raw.rated === true,
    ratingBefore: clampRating(raw.ratingBefore),
    ratingAfter: clampRating(raw.ratingAfter),
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    pgn: typeof raw.pgn === 'string' ? raw.pgn : '',
  };
  if (isFiniteNumber(raw.accuracy) && raw.accuracy >= 0 && raw.accuracy <= 100) record.accuracy = raw.accuracy;
  return record;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function count(v: unknown): number {
  return isFiniteNumber(v) && v > 0 ? Math.floor(v) : 0;
}
