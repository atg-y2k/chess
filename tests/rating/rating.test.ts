import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RATING,
  HISTORY_LIMIT,
  PROFILE_KEY,
  applyGameResult,
  clampRating,
  defaultProfile,
  expectedScore,
  kFactor,
  loadProfile,
  playerScoreFor,
  saveProfile,
  suggestedOpponentElo,
  updateGameRecord,
} from '../../src/rating/rating';
import type { GameRecordInput } from '../../src/rating/rating';
import type { PlayerProfile } from '../../src/rating/types';

/** Minimal in-memory Storage installed on globalThis (the app code reads `localStorage`). */
class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

let storage: MemoryStorage;
const g = globalThis as { localStorage?: unknown };

beforeEach(() => {
  storage = new MemoryStorage();
  g.localStorage = storage;
});
afterEach(() => {
  delete g.localStorage;
});

let seq = 0;
function game(over: Partial<GameRecordInput> = {}): GameRecordInput {
  seq++;
  return {
    id: `g${seq}`,
    date: '2026-09-30T12:00:00.000Z',
    playerColor: 'w',
    botName: 'Test Bot',
    botElo: 800,
    result: '1-0',
    playerScore: 1,
    rated: true,
    reason: 'Checkmate',
    pgn: '1. e4 e5 *',
    ...over,
  };
}

function profile(over: Partial<PlayerProfile> = {}): PlayerProfile {
  return { ...defaultProfile(), ...over };
}

describe('Elo maths', () => {
  it('kFactor: 60 for the first 10 games, 32 up to game 30, then 16', () => {
    expect(kFactor(0)).toBe(60);
    expect(kFactor(9)).toBe(60);
    expect(kFactor(10)).toBe(32);
    expect(kFactor(29)).toBe(32);
    expect(kFactor(30)).toBe(16);
    expect(kFactor(5000)).toBe(16);
  });

  it('expectedScore follows the Elo logistic and is symmetric', () => {
    expect(expectedScore(800, 800)).toBe(0.5);
    expect(expectedScore(1200, 800)).toBeCloseTo(10 / 11, 10);
    expect(expectedScore(800, 1200)).toBeCloseTo(1 / 11, 10);
    expect(expectedScore(1000, 1000 + 200)).toBeCloseTo(0.2403, 4);
    for (const [a, b] of [[800, 1350], [100, 3200], [2000, 1990]]) {
      expect(expectedScore(a, b) + expectedScore(b, a)).toBeCloseTo(1, 12);
    }
  });

  it('clampRating rounds and clamps to 100..3200', () => {
    expect(clampRating(812.6)).toBe(813);
    expect(clampRating(12)).toBe(100);
    expect(clampRating(4000)).toBe(3200);
    expect(clampRating(Number.NaN)).toBe(DEFAULT_RATING);
  });

  it('playerScoreFor reads the result from the player side', () => {
    expect(playerScoreFor('1-0', 'w')).toBe(1);
    expect(playerScoreFor('1-0', 'b')).toBe(0);
    expect(playerScoreFor('0-1', 'b')).toBe(1);
    expect(playerScoreFor('0-1', 'w')).toBe(0);
    expect(playerScoreFor('1/2-1/2', 'b')).toBe(0.5);
  });
});

describe('applyGameResult', () => {
  it('starts from a default profile rated 800', () => {
    expect(defaultProfile()).toEqual({ rating: 800, gamesPlayed: 0, peak: 800, wins: 0, draws: 0, losses: 0, history: [] });
  });

  it('a win against an equal bot with K = 60 gains 30 points', () => {
    const before = profile();
    const { profile: p, record } = applyGameResult(before, game({ botElo: 800 }));
    expect(p.rating).toBe(830);
    expect(p.gamesPlayed).toBe(1);
    expect(p.peak).toBe(830);
    expect([p.wins, p.draws, p.losses]).toEqual([1, 0, 0]);
    expect(record.ratingBefore).toBe(800);
    expect(record.ratingAfter).toBe(830);
    expect(p.history[0]).toEqual(record);
    expect(before).toEqual(defaultProfile()); // input is not mutated
  });

  it('a draw against a stronger bot gains, a loss to a weaker bot costs', () => {
    const draw = applyGameResult(profile(), game({ botElo: 1000, result: '1/2-1/2', playerScore: 0.5 }));
    // 60 * (0.5 - 0.2403) = 15.58
    expect(draw.profile.rating).toBe(816);
    expect([draw.profile.wins, draw.profile.draws, draw.profile.losses]).toEqual([0, 1, 0]);

    const loss = applyGameResult(profile(), game({ botElo: 600, result: '0-1', playerScore: 0 }));
    // 60 * (0 - 0.7597) = -45.58
    expect(loss.profile.rating).toBe(754);
    expect(loss.profile.peak).toBe(800); // peak never drops
    expect([loss.profile.wins, loss.profile.draws, loss.profile.losses]).toEqual([0, 0, 1]);
  });

  it('uses the K-factor of the number of rated games played so far', () => {
    expect(applyGameResult(profile({ gamesPlayed: 10 }), game()).profile.rating).toBe(816);
    expect(applyGameResult(profile({ gamesPlayed: 30 }), game()).profile.rating).toBe(808);
  });

  it('unrated games keep the rating and game count but are recorded', () => {
    const start = profile({ rating: 1234, gamesPlayed: 12, peak: 1300 });
    const { profile: p, record } = applyGameResult(start, game({ rated: false, botElo: 2000 }));
    expect(p.rating).toBe(1234);
    expect(p.gamesPlayed).toBe(12);
    expect(p.peak).toBe(1300);
    expect(p.wins).toBe(1);
    expect(record.ratingBefore).toBe(1234);
    expect(record.ratingAfter).toBe(1234);
    expect(record.rated).toBe(false);
    expect(p.history).toHaveLength(1);
  });

  it('clamps the rating to 100..3200', () => {
    expect(applyGameResult(profile({ rating: 3190, peak: 3190 }), game({ botElo: 3200 })).profile.rating).toBe(3200);
    const low = applyGameResult(profile({ rating: 110 }), game({ botElo: 100, result: '0-1', playerScore: 0 }));
    expect(low.profile.rating).toBe(100);
    expect(low.record.ratingAfter).toBe(100);
  });

  it('keeps history newest first, capped at 200', () => {
    let p = profile();
    const ids: string[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 15; i++) {
      const input = game({ result: i % 2 ? '1-0' : '0-1', playerScore: i % 2 ? 1 : 0 });
      ids.push(input.id);
      p = applyGameResult(p, input).profile;
    }
    expect(p.history).toHaveLength(HISTORY_LIMIT);
    expect(p.history[0].id).toBe(ids[ids.length - 1]);
    expect(p.history[HISTORY_LIMIT - 1].id).toBe(ids[15]);
    expect(p.gamesPlayed).toBe(HISTORY_LIMIT + 15);
    expect(p.wins + p.losses).toBe(HISTORY_LIMIT + 15);
  });

  it('does not apply the same game twice', () => {
    const input = game();
    const first = applyGameResult(profile(), input);
    const again = applyGameResult(first.profile, input);
    expect(again.profile).toBe(first.profile);
    expect(again.record).toEqual(first.record);
  });

  it('updateGameRecord patches a record without touching the rating', () => {
    const { profile: p, record } = applyGameResult(profile(), game());
    const patched = updateGameRecord(p, record.id, { accuracy: 87.5 });
    expect(patched.history[0].accuracy).toBe(87.5);
    expect(patched.rating).toBe(p.rating);
    expect(p.history[0].accuracy).toBeUndefined();
    expect(updateGameRecord(p, 'nope', { accuracy: 1 })).toBe(p);
  });
});

describe('suggestedOpponentElo', () => {
  it('rounds to the nearest 50 within 100..3200', () => {
    expect(suggestedOpponentElo(profile({ rating: 812 }))).toBe(800);
    expect(suggestedOpponentElo(profile({ rating: 825 }))).toBe(850);
    expect(suggestedOpponentElo(profile({ rating: 1374 }))).toBe(1350);
    expect(suggestedOpponentElo(profile({ rating: 100 }))).toBe(100);
    expect(suggestedOpponentElo(profile({ rating: 60 }))).toBe(100);
    expect(suggestedOpponentElo(profile({ rating: 3190 }))).toBe(3200);
    expect(suggestedOpponentElo(profile({ rating: 9999 }))).toBe(3200);
  });
});

describe('profile persistence', () => {
  it('returns the default profile when nothing is stored', () => {
    expect(loadProfile()).toEqual(defaultProfile());
  });

  it('round-trips through localStorage under a chesscoach. key with a version', () => {
    let p = profile();
    p = applyGameResult(p, game()).profile;
    p = applyGameResult(p, game({ rated: false, result: '1/2-1/2', playerScore: 0.5 })).profile;
    p = updateGameRecord(p, p.history[0].id, { accuracy: 91.2 });
    expect(saveProfile(p)).toBe(true);
    expect(PROFILE_KEY.startsWith('chesscoach.')).toBe(true);
    const stored = JSON.parse(storage.getItem(PROFILE_KEY)!);
    expect(stored.version).toBe(1);
    expect(loadProfile()).toEqual(p);
  });

  it('recovers from corrupt JSON and wrong shapes', () => {
    for (const bad of ['{not json', 'null', '42', '"str"', '[]', '{"version":1,"profile":7}']) {
      storage.setItem(PROFILE_KEY, bad);
      expect(loadProfile()).toEqual(defaultProfile());
    }
  });

  it('sanitises individual fields and drops invalid history records', () => {
    const good = applyGameResult(profile(), game()).record;
    storage.setItem(
      PROFILE_KEY,
      JSON.stringify({
        version: 1,
        profile: {
          rating: 99999,
          gamesPlayed: -4,
          peak: 'high',
          wins: 3.7,
          draws: null,
          losses: 2,
          history: [
            good,
            null,
            { id: 'x' }, // missing required fields
            { ...good, id: 'bad-result', result: '2-0' },
            { ...good, id: 'bad-color', playerColor: 'white' },
            { ...good }, // duplicate id
            { ...good, id: 'no-score', playerScore: 'win', accuracy: 400, pgn: 5 },
          ],
        },
      }),
    );
    const p = loadProfile();
    expect(p.rating).toBe(3200);
    expect(p.gamesPlayed).toBe(0);
    expect(p.peak).toBe(3200);
    expect([p.wins, p.draws, p.losses]).toEqual([3, 0, 2]);
    expect(p.history.map((r) => r.id)).toEqual([good.id, 'no-score']);
    expect(p.history[1].playerScore).toBe(1); // derived from result + colour
    expect(p.history[1].accuracy).toBeUndefined();
    expect(p.history[1].pgn).toBe('');
  });

  it('recovers a missing rating from the newest game', () => {
    const { profile: p } = applyGameResult(profile(), game());
    storage.setItem(PROFILE_KEY, JSON.stringify({ version: 1, profile: { ...p, rating: 'oops' } }));
    expect(loadProfile().rating).toBe(830);
  });

  it('accepts a bare (unversioned) profile object', () => {
    storage.setItem(PROFILE_KEY, JSON.stringify(profile({ rating: 1111, peak: 1200, gamesPlayed: 3 })));
    expect(loadProfile()).toMatchObject({ rating: 1111, peak: 1200, gamesPlayed: 3 });
  });

  it('never throws when storage is missing or broken', () => {
    delete g.localStorage;
    expect(loadProfile()).toEqual(defaultProfile());
    expect(saveProfile(defaultProfile())).toBe(false);

    g.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    expect(loadProfile()).toEqual(defaultProfile());
    expect(saveProfile(defaultProfile())).toBe(false);
  });

  it('falls back to a slimmer history when the quota is exceeded', () => {
    let p = profile();
    for (let i = 0; i < 60; i++) p = applyGameResult(p, game({ pgn: 'x'.repeat(2000) })).profile;
    const limited = new MemoryStorage();
    limited.setItem = function (k: string, v: string) {
      if (v.length > 60_000) throw new Error('QuotaExceededError');
      MemoryStorage.prototype.setItem.call(this, k, v);
    };
    expect(saveProfile(p, limited)).toBe(true);
    const back = loadProfile(limited);
    expect(back.rating).toBe(p.rating);
    expect(back.history).toHaveLength(60);
    expect(back.history[0].pgn).toHaveLength(2000);
    expect(back.history[59].pgn).toBe('');
  });
});
