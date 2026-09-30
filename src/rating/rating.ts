/**
 * Player rating: Elo maths against the bot ladder plus profile persistence.
 *
 * The rating is an Elo estimate, E = 1 / (1 + 10^((Rbot - R) / 400)), R += K * (S - E), measured
 * against the bot ladder (so it is self-consistent with it whatever its absolute offset is). K comes
 * from Glicko-1 (see `kFactor`): a new rating is uncertain, so the first games move it a lot
 * (+-175 for the first game against an equal bot, never more than 350 however lopsided the pairing)
 * and it settles within about 10-20 games instead of crawling up from 800 in +-30 steps; established
 * ratings move by +-8. A run of results far from expectations (a player who has improved) makes K
 * provisional again (`effectiveGames`), and a new player can start from a level instead of 800
 * (`STARTING_LEVELS`, `setStartingRating`).
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

/** Glicko-1 rating deviation of a new player, and the Glicko scale constant ln(10) / 400. */
const NEW_PLAYER_RD = 350;
const Q = Math.LN10 / 400;
/** Smallest K-factor (an established rating; reached after about 42 rated games). */
export const MIN_K = 16;

/**
 * K-factor for the next rated game after `gamesPlayed` rated games: Glicko-1 against a fixed-rated
 * opponent with every game weighted as an even one. The player's rating deviation starts at 350 and
 * shrinks with each game, and K = q * RD^2 after the game: 350 for the first game, ~58 at game 10,
 * ~22 at game 30, then never below MIN_K. One game moves the rating by at most K whatever the
 * pairing. (Full Glicko-1 also weights a game by E(1-E), which raises K towards ~700 for a lopsided
 * one: a new 800 player's single loss, resignation or abandoned game against the 100 bot would
 * leave them at ~150. Counting every game as even is also how the deviation shrinks here.)
 */
export function kFactor(gamesPlayed: number): number {
  const n = Math.max(0, Number.isFinite(gamesPlayed) ? gamesPlayed : 0);
  return Math.max(MIN_K, Q / (1 / NEW_PLAYER_RD ** 2 + ((n + 1) * Q * Q) / 4));
}

/** Surprise window: the last this many rated games... */
const SURPRISE_GAMES = 6;
/** ...beating (or missing) their expected score by this many points in total... */
const SURPRISE_POINTS = 2.5;
/** ...make the rating provisional again, as if only this many games had been played. */
const SURPRISE_GAMES_PLAYED = 8;

/**
 * Game count used for the K-factor: `gamesPlayed`, lowered to 8 when the last 6 rated games
 * together beat or missed their expected scores by 2.5 points or more (e.g. six straight wins at
 * "Match my rating"): the player has probably improved (or lost form), so the rating catches up
 * quickly instead of by +-8 per game.
 */
export function effectiveGames(profile: PlayerProfile): number {
  const recent = profile.history.filter((r) => r.rated).slice(0, SURPRISE_GAMES);
  if (recent.length === SURPRISE_GAMES) {
    const surprise = recent.reduce((sum, r) => sum + r.playerScore - expectedScore(r.ratingBefore, r.botElo), 0);
    if (Math.abs(surprise) >= SURPRISE_POINTS) return Math.min(profile.gamesPlayed, SURPRISE_GAMES_PLAYED);
  }
  return profile.gamesPlayed;
}

/** The player's score (1 win, 0.5 draw, 0 loss) for a result. */
export function playerScoreFor(result: GameResult, playerColor: Color): 1 | 0.5 | 0 {
  if (result === '1/2-1/2') return 0.5;
  return (result === '1-0') === (playerColor === 'w') ? 1 : 0;
}

/** Starting levels a player can pick instead of the default 800 (first launch, or later to reset). */
export const STARTING_LEVELS: readonly { id: string; label: string; rating: number }[] = [
  { id: 'beginner', label: 'Beginner', rating: 400 },
  { id: 'casual', label: 'Casual', rating: 800 },
  { id: 'intermediate', label: 'Intermediate', rating: 1200 },
  { id: 'advanced', label: 'Advanced', rating: 1600 },
  { id: 'expert', label: 'Expert', rating: 2000 },
];

/**
 * Sets the player's rating to a chosen starting level. The rating becomes provisional again
 * (`gamesPlayed` = 0, so the next games move it a lot) and settles from there. The record and
 * history are kept; the peak keeps its maximum once rated games have been played. Pure.
 */
export function setStartingRating(profile: PlayerProfile, rating: number): PlayerProfile {
  const r = clampRating(rating);
  const earned = profile.history.some((g) => g.rated);
  return { ...profile, rating: r, gamesPlayed: 0, peak: earned ? Math.max(profile.peak, r) : r };
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
 * - Rated games move the rating by K * (score - expected) (rounded, clamped to 100..3200), with
 *   K = kFactor(effectiveGames(profile)), and increment `gamesPlayed`. The change is at most K
 *   (350 for a new rating), however much stronger or weaker the bot is.
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
  const expected = expectedScore(ratingBefore, record.botElo);
  const delta = kFactor(effectiveGames(profile)) * (record.playerScore - expected);
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
