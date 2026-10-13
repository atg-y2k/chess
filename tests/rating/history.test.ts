/**
 * The rating history chart's data (rating/history.ts) and what the history keeps of each game
 * (rating/rating.ts): rated games only, oldest first, from the starting rating; levels set in
 * between; the peak; the games played while the rating was new (recorded, or inferred for older
 * records); the empty state; the readout's words and the axis ticks. Then the record's new fields
 * (sanitized, round trip) and the order in which a save over the quota slims the history.
 */
import { describe, expect, it } from 'vitest';
import {
  formatGameDate,
  historySummary,
  pointText,
  ratingHistory,
  ratingTicks,
  recordOutcome,
  resultWord,
} from '../../src/rating/history';
import {
  HISTORY_LIMIT,
  PROFILE_KEY,
  applyGameResult,
  defaultProfile,
  loadProfile,
  sanitizeProfile,
  saveProfile,
  setStartingRating,
  slimmedHistories,
  type GameRecordInput,
} from '../../src/rating/rating';
import type { GameRecord, PlayerProfile } from '../../src/rating/types';
import { MemoryStorage } from '../helpers/fakeEngine';

let n = 0;
const input = (over: Partial<GameRecordInput> = {}): GameRecordInput => ({
  id: `g${++n}`,
  date: new Date(2026, 9, 1 + (n % 28), 12).toISOString(),
  playerColor: 'w',
  botName: 'Pip',
  botElo: 800,
  result: '1-0',
  playerScore: 1,
  rated: true,
  reason: 'Checkmate',
  pgn: '',
  ...over,
});

/** Plays `results` (1 win, 0 loss, 0.5 draw; 'u' an unrated draw) from a fresh profile. */
function play(results: (1 | 0 | 0.5 | 'u')[], start: PlayerProfile = defaultProfile()): PlayerProfile {
  let p = start;
  for (const r of results) {
    const rated = r !== 'u';
    const score = r === 'u' ? 0.5 : r;
    p = applyGameResult(p, input({ rated, playerScore: score, result: score === 1 ? '1-0' : score === 0 ? '0-1' : '1/2-1/2' })).profile;
  }
  return p;
}

describe('ratingHistory', () => {
  it('is empty before the first rated game (unrated games do not count)', () => {
    expect(ratingHistory(defaultProfile())).toBeNull();
    expect(ratingHistory(play(['u', 'u']))).toBeNull();
  });

  it('starts at the rating before the first rated game, then one point per rated game, oldest first', () => {
    const p = play([1, 'u', 0, 1]);
    const h = ratingHistory(p)!;
    const games = [...p.history].reverse().filter((r) => r.rated);
    expect(h.points.map((x) => x.kind)).toEqual(['start', 'game', 'game', 'game']);
    expect(h.points.map((x) => x.rating)).toEqual([800, ...games.map((r) => r.ratingAfter)]);
    expect(h.points.slice(1).map((x) => x.game)).toEqual([1, 2, 3]);
    expect(h.points[1].record).toBe(games[0]);
    expect(h.games).toBe(3);
    expect(h.current).toBe(3);
    expect(h.complete).toBe(true);
    expect(h.min).toBe(Math.min(...h.points.map((x) => x.rating)));
    expect(h.max).toBe(Math.max(...h.points.map((x) => x.rating)));
  });

  it('marks the peak (the first time it was reached; a level never counts) and the current rating', () => {
    const p = play([1, 0, 1, 1, 0]);
    const h = ratingHistory(p)!;
    const ratings = h.points.map((x) => x.rating);
    const best = Math.max(...ratings.slice(1));
    expect(h.peak).toBe(ratings.indexOf(best, 1));
    expect(h.points[h.peak].kind).toBe('game');
    expect(h.points[h.current].rating).toBe(p.rating);
    // A level above every game's rating is not the peak.
    const lifted = setStartingRating(p, 2000);
    const h2 = ratingHistory(lifted)!;
    expect(h2.points.at(-1)).toEqual({ kind: 'level', rating: 2000 });
    expect(h2.current).toBe(h2.points.length - 1);
    expect(h2.points[h2.peak].rating).toBe(best);
  });

  it('shades the first 10 rated games (recorded with the game), and again after a level was set', () => {
    const p = play([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    expect(p.history.filter((r) => r.provisional)).toHaveLength(10);
    const h = ratingHistory(p)!;
    expect(h.provisional).toEqual([{ from: 1, to: 10 }]);
    const again = play([1, 0], setStartingRating(p, 1200));
    const h2 = ratingHistory(again)!;
    // The level's point sits between the games, and the two games after it are new again.
    expect(h2.points[13]).toEqual({ kind: 'level', rating: 1200 });
    expect(h2.points[14].record!.ratingBefore).toBe(1200);
    expect(h2.provisional).toEqual([
      { from: 1, to: 10 },
      { from: 14, to: 15 },
    ]);
  });

  it('infers new-rating games for older records (no flag): the first 10 of a complete history, or after a level', () => {
    const strip = (p: PlayerProfile): PlayerProfile => ({
      ...p,
      history: p.history.map((r) => {
        const { provisional: _p, ...rest } = r;
        return rest;
      }),
    });
    const h = ratingHistory(strip(play([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0])))!;
    expect(h.provisional).toEqual([{ from: 1, to: 10 }]);
    // A full history has lost its oldest games: nothing is inferred for its first stretch.
    let full = play([]);
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) full = applyGameResult(full, input()).profile;
    const hf = ratingHistory(strip(full))!;
    expect(hf.complete).toBe(false);
    expect(hf.provisional).toEqual([]);
    expect(pointText(hf, 0)).toBe('Rating before the oldest game kept');
    expect(hf.games).toBe(HISTORY_LIMIT);
  });

  it('a history a full storage cut to its newest games is not complete: no "Starting rating", no new-rating games inferred', () => {
    let p = defaultProfile();
    for (let i = 0; i < 40; i++) {
      const won = i % 2 === 1;
      p = applyGameResult(p, input({ playerScore: won ? 1 : 0, result: won ? '1-0' : '0-1', pgn: '1. e4 e5 *'.repeat(20) })).profile;
    }
    expect(ratingHistory(p)!.provisional).toEqual([{ from: 1, to: 10 }]);
    // Every rated record says whether the rating was new (false too), so nothing needs inferring.
    expect(p.history.every((r) => typeof r.provisional === 'boolean')).toBe(true);
    // A storage that only takes the 20 newest games.
    class QuotaStorage extends MemoryStorage {
      override setItem(key: string, value: string): void {
        if (value.length > 9_000) throw new DOMException('quota', 'QuotaExceededError');
        super.setItem(key, value);
      }
    }
    const storage = new QuotaStorage();
    expect(saveProfile(p, storage)).toBe(true);
    const back = loadProfile(storage);
    expect(back.history).toHaveLength(20);
    const h = ratingHistory(back)!;
    expect(h.complete).toBe(false);
    expect(pointText(h, 0)).toBe('Rating before the oldest game kept');
    expect(h.provisional).toEqual([]);
    // As many records as games played: every game is there.
    expect(ratingHistory({ ...p, history: p.history.slice(0, 20), wins: 10, draws: 0, losses: 10 })!.complete).toBe(true);
  });

  it('words a point for the readout and the chart for screen readers', () => {
    const p = play([1, 0]);
    const h = ratingHistory(p)!;
    const now = new Date(2026, 9, 30);
    expect(pointText(h, 0)).toBe('Starting rating');
    const r = h.points[2].record!;
    const d = new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(pointText(h, 2, now)).toBe(`${d} · Pip (800) · Lost · −${r.ratingBefore - r.ratingAfter}`);
    expect(historySummary(h)).toBe(`Rating history: 2 rated games, from 800 to ${p.rating}, peak ${h.points[h.peak].rating} after game 1.`);
    expect(pointText(ratingHistory(setStartingRating(p, 1600))!, 3)).toBe('Level set to 1600');
    expect(resultWord({ playerScore: 0.5 })).toBe('Draw');
    expect(recordOutcome({ playerScore: 1 })).toBe('win');
    expect(formatGameDate(new Date(2026, 9, 30, 9).toISOString(), now, 'en-US')).toBe('Today');
  });

  it('rounds the rating axis to clean ticks', () => {
    expect(ratingTicks(800, 1043)).toEqual({ ticks: [800, 900, 1000, 1100], lo: 800, hi: 1100 });
    expect(ratingTicks(800, 975).ticks).toEqual([800, 900, 1000]);
    expect(ratingTicks(1200, 1200).ticks).toEqual([1200, 1225]);
    expect(ratingTicks(400, 2100).ticks).toEqual([0, 1000, 2000, 3000]);
  });
});

describe('what the history keeps of a game', () => {
  const analysis = { v: 1 as const, s: '18', p: 'k30 k35 b-650:g1f3', h: { '2': 'This hangs your queen.' } };

  it('round trip: the opponent’s id, the moves the game started with, a new rating and the analysis', () => {
    const storage = new MemoryStorage();
    const p = applyGameResult(defaultProfile(), input({ botId: 'pip', preplayed: 4, analysis })).profile;
    expect(p.history[0]).toMatchObject({ botId: 'pip', preplayed: 4, provisional: true, analysis });
    expect(saveProfile(p, storage)).toBe(true);
    expect(loadProfile(storage)).toEqual(p);
    // An unrated game is never marked new.
    expect(applyGameResult(p, input({ rated: false })).record.provisional).toBeUndefined();
  });

  it('drops malformed new fields (an older or damaged record still loads, without them)', () => {
    const good = applyGameResult(defaultProfile(), input()).record;
    const bad = {
      ...good,
      botId: 'Pip <script>',
      preplayed: -2,
      provisional: 'yes',
      analysis: { v: 2, s: '', p: 'k30' },
    };
    const back = sanitizeProfile({ ...defaultProfile(), history: [bad] }).history[0];
    expect(back.botId).toBeUndefined();
    expect(back.preplayed).toBeUndefined();
    expect(back.provisional).toBeUndefined();
    expect(back.analysis).toBeUndefined();
    const h = sanitizeProfile({
      ...defaultProfile(),
      history: [{ ...good, analysis: { v: 1, s: 12, p: 'k30', h: { '0': 'ok', x: 'no', '1': 7 } } }],
    }).history[0];
    expect(h.analysis).toEqual({ v: 1, s: '', p: 'k30', h: { '0': 'ok' } });
    expect(sanitizeProfile({ ...defaultProfile(), history: [{ ...good, analysis: { v: 1, s: '', p: 'x'.repeat(20_000) } }] }).history[0].analysis).toBeUndefined();
    // A record that was not rated is never new.
    expect(sanitizeProfile({ ...defaultProfile(), history: [{ ...good, rated: false, provisional: true }] }).history[0].provisional).toBeUndefined();
  });

  it('over the quota: the oldest games’ analyses go first, then older PGNs, then all but the 20 newest games', () => {
    let p = defaultProfile();
    for (let i = 0; i < 80; i++) p = applyGameResult(p, input({ pgn: 'p'.repeat(400), analysis: { ...analysis, p: 'a'.repeat(400) } })).profile;
    const attempts = slimmedHistories(p.history).map((f) => f());
    const kept = (h: GameRecord[]) => ({
      games: h.length,
      analyses: h.filter((r) => r.analysis).length,
      pgns: h.filter((r) => r.pgn).length,
    });
    expect(attempts.map(kept)).toEqual([
      { games: 80, analyses: 80, pgns: 80 },
      { games: 80, analyses: 50, pgns: 80 },
      { games: 80, analyses: 20, pgns: 80 },
      { games: 80, analyses: 20, pgns: 20 },
      { games: 20, analyses: 20, pgns: 20 },
      { games: 20, analyses: 0, pgns: 20 },
    ]);
    // The newest games keep theirs at every step.
    expect(attempts[2][0].analysis).toBeDefined();
    expect(attempts[2][19].analysis).toBeDefined();
    expect(attempts[2][20].analysis).toBeUndefined();

    // A storage that takes only so much: the save drops analyses before any PGN.
    const size = (h: GameRecord[]) => JSON.stringify({ version: 1, profile: { ...p, history: h } }).length;
    const limited = (max: number) => {
      const st = new MemoryStorage();
      st.setItem = function (k: string, v: string) {
        if (v.length > max) throw new Error('QuotaExceededError');
        MemoryStorage.prototype.setItem.call(this, k, v);
      };
      return st;
    };
    const fits50 = limited(size(attempts[1]));
    expect(saveProfile(p, fits50)).toBe(true);
    let back = loadProfile(fits50);
    expect(back.history).toHaveLength(80);
    expect(back.history.every((r) => r.pgn.length === 400)).toBe(true);
    expect(back.history.filter((r) => r.analysis)).toHaveLength(50);
    const fitsPgn20 = limited(size(attempts[3]));
    expect(saveProfile(p, fitsPgn20)).toBe(true);
    back = loadProfile(fitsPgn20);
    expect(kept(back.history)).toEqual({ games: 80, analyses: 20, pgns: 20 });
    const limitedStore = fitsPgn20;
    expect(JSON.parse(limitedStore.getItem(PROFILE_KEY)!).version).toBe(1);
  });
});
