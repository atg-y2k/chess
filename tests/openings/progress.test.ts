import { beforeAll, describe, expect, it } from 'vitest';
import { loadOpenings } from '../../src/bot/book';
import { MIRROR_PREFIX } from '../../src/native/storage';
import { getLine, loadCatalog } from '../../src/openings/catalog';
import { checkMove, createDrill, drillResult, expectedMove, playOpponent, type DrillState } from '../../src/openings/drill';
import {
  allProgress,
  familyProgress,
  getProgress,
  isDue,
  MASTERY_LABELS,
  masteryOf,
  PROGRESS_BACKUP_KEY,
  PROGRESS_KEY,
  progressSummary,
  recordDrill,
  resetProgress,
  type KeyValueStorage,
} from '../../src/openings/progress';

/** In-memory storage; `fail` makes every call throw. */
function memoryStorage(initial: Record<string, string> = {}, fail = false): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  const guard = () => {
    if (fail) throw new Error('storage unavailable');
  };
  return {
    data,
    getItem: (k) => (guard(), data.get(k) ?? null),
    setItem: (k, v) => {
      guard();
      data.set(k, v);
    },
    removeItem: (k) => {
      guard();
      data.delete(k);
    },
  };
}

/** Plays the player's line moves correctly and the opponent's automatically until the end. */
function finish(s: DrillState): DrillState {
  while (s.status !== 'complete') s = s.status === 'opponent' ? playOpponent(s) : checkMove(s, expectedMove(s)!.uci).state;
  return s;
}

/** Local time, so calendar days do not depend on the machine's time zone. */
const day = (d: number, h = 12) => new Date(2026, 9, d, h, 0, 0);
const NAJDORF = 'b90-sicilian-defense-najdorf-variation';
const RUY = 'c60-ruy-lopez';

beforeAll(async () => {
  await Promise.all([loadCatalog(), loadOpenings()]);
});

describe('mastery', () => {
  it('goes New -> Learning -> Familiar -> Mastered', () => {
    const storage = memoryStorage();
    expect(getProgress(NAJDORF, { storage })).toEqual({
      lineId: NAJDORF,
      attempts: 0,
      cleanRuns: 0,
      lastPracticed: null,
      lastClean: false,
      bestScore: 0,
      cleanDays: [],
      mastery: 0,
    });

    let p = recordDrill(NAJDORF, { clean: false, score: 60 }, { storage, now: day(1, 9) });
    expect(p).toMatchObject({ attempts: 1, cleanRuns: 0, mastery: 1, lastClean: false, bestScore: 60 });
    expect(p.lastPracticed).toBe(day(1, 9).toISOString());

    p = recordDrill(NAJDORF, { clean: true, score: 100 }, { storage, now: day(1, 10) });
    expect(p).toMatchObject({ attempts: 2, cleanRuns: 1, mastery: 2, cleanDays: ['2026-10-01'], bestScore: 100 });

    // more clean runs on the same day do not make it Mastered
    p = recordDrill(NAJDORF, { clean: true }, { storage, now: day(1, 11) });
    p = recordDrill(NAJDORF, { clean: true }, { storage, now: day(1, 23) });
    expect(p).toMatchObject({ cleanRuns: 3, mastery: 2, cleanDays: ['2026-10-01'] });

    p = recordDrill(NAJDORF, { clean: true }, { storage, now: day(2) });
    expect(p).toMatchObject({ mastery: 2, cleanDays: ['2026-10-01', '2026-10-02'] });
    p = recordDrill(NAJDORF, { clean: false }, { storage, now: day(3) }); // a run with mistakes does not count
    expect(p.mastery).toBe(2);
    p = recordDrill(NAJDORF, { clean: true }, { storage, now: day(4) });
    expect(p).toMatchObject({ attempts: 7, cleanRuns: 5, mastery: 3 });
    expect(MASTERY_LABELS[p.mastery]).toBe('Mastered');

    // Mastered stays Mastered after a bad run
    p = recordDrill(NAJDORF, { clean: false }, { storage, now: day(5) });
    expect(p).toMatchObject({ mastery: 3, lastClean: false, bestScore: 100 });
    expect(getProgress(NAJDORF, { storage })).toEqual(p);
  });

  it('derives mastery from the counters', () => {
    expect(masteryOf({ attempts: 0, cleanRuns: 0, cleanDays: [] })).toBe(0);
    expect(masteryOf({ attempts: 2, cleanRuns: 0, cleanDays: [] })).toBe(1);
    expect(masteryOf({ attempts: 2, cleanRuns: 2, cleanDays: ['2026-10-01'] })).toBe(2);
    expect(masteryOf({ attempts: 3, cleanRuns: 3, cleanDays: ['2026-10-01', '2026-10-02', '2026-10-05'] })).toBe(3);
  });

  it('says when a line is due for practice', () => {
    const storage = memoryStorage();
    expect(isDue(getProgress(RUY, { storage }), day(1))).toBe(false); // new, not due
    const learning = recordDrill(RUY, { clean: false }, { storage, now: day(1) });
    expect(isDue(learning, day(1, 13))).toBe(true);
    const familiar = recordDrill(RUY, { clean: true }, { storage, now: day(1, 14) });
    expect(isDue(familiar, day(1, 20))).toBe(false);
    expect(isDue(familiar, day(2, 15))).toBe(true);
    recordDrill(RUY, { clean: true }, { storage, now: day(2) });
    const mastered = recordDrill(RUY, { clean: true }, { storage, now: day(3) });
    expect(mastered.mastery).toBe(3);
    expect(isDue(mastered, day(9))).toBe(false);
    expect(isDue(mastered, day(10, 13))).toBe(true);
  });

  it('records a real drill result', () => {
    const storage = memoryStorage();
    const p = recordDrill(RUY, drillResult(finish(createDrill(getLine(RUY)!, 'w')))!, { storage, now: day(1) });
    expect(p).toMatchObject({ attempts: 1, cleanRuns: 1, mastery: 2, bestScore: 100 });
  });

  it('counts a partial drill (started past some of the player\'s moves) as practice only', () => {
    const storage = memoryStorage();
    const line = getLine(NAJDORF)!;
    const partial = drillResult(finish(createDrill(line, 'w', { fromPly: 8 })))!; // only 5. Nc3 to find
    expect(partial).toMatchObject({ playerMoves: 1, clean: true, score: 100, partial: true });
    for (const d of [1, 2, 3]) recordDrill(NAJDORF, partial, { storage, now: day(d) });
    expect(getProgress(NAJDORF, { storage })).toMatchObject({ attempts: 3, cleanRuns: 0, cleanDays: [], bestScore: 0, mastery: 1 });
    const full = drillResult(finish(createDrill(line, 'w')))!;
    expect(recordDrill(NAJDORF, full, { storage, now: day(4) })).toMatchObject({ attempts: 4, cleanRuns: 1, bestScore: 100, mastery: 2 });
  });

  it('does not record a drill with nothing to find', () => {
    const storage = memoryStorage();
    const kpg = 'b00-kings-pawn-game'; // 1. e4: nothing for Black to find
    const r = drillResult(playOpponent(createDrill(getLine(kpg)!, 'b')))!;
    expect(r.playerMoves).toBe(0);
    expect(recordDrill(kpg, r, { storage, now: day(1) })).toMatchObject({ attempts: 0, mastery: 0 });
    expect(storage.data.has(PROGRESS_KEY)).toBe(false);
  });

  it('spaces the clean days that make a line Mastered', () => {
    const storage = memoryStorage();
    const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m, 0);
    let p = recordDrill(RUY, { clean: true }, { storage, now: at(6, 23, 59) });
    p = recordDrill(RUY, { clean: true }, { storage, now: at(7, 0, 1) }); // a new calendar day, 2 minutes later
    expect(p).toMatchObject({ cleanRuns: 2, cleanDays: ['2026-10-06'], mastery: 2 });
    p = recordDrill(RUY, { clean: true }, { storage, now: at(7, 19, 0) }); // 19 h after the counted run: too soon
    expect(p.cleanDays).toEqual(['2026-10-06']);
    p = recordDrill(RUY, { clean: true }, { storage, now: at(8, 0, 1) }); // 24 h after: counts
    expect(p).toMatchObject({ cleanDays: ['2026-10-06', '2026-10-08'], mastery: 2 });
    p = recordDrill(RUY, { clean: true }, { storage, now: at(9, 0, 1) });
    expect(p).toMatchObject({ cleanRuns: 5, cleanDays: ['2026-10-06', '2026-10-08', '2026-10-09'], mastery: 3 });
  });

  it('treats a score that is not a number as no score', () => {
    const storage = memoryStorage();
    expect(recordDrill(RUY, { clean: false, score: Number.NaN }, { storage, now: day(1) }).bestScore).toBe(0);
    expect(recordDrill(NAJDORF, { clean: true, score: Number.NaN }, { storage, now: day(1) }).bestScore).toBe(100);
    expect(getProgress(RUY, { storage }).bestScore).toBe(0);
  });
});

describe('storage', () => {
  it('saves under a versioned, mirrored key', () => {
    const storage = memoryStorage();
    recordDrill(RUY, { clean: true, score: 100 }, { storage, now: day(1) });
    expect(PROGRESS_KEY.startsWith(MIRROR_PREFIX)).toBe(true);
    const saved = JSON.parse(storage.data.get(PROGRESS_KEY)!) as { v: number; lines: Record<string, Record<string, unknown>> };
    expect(saved.v).toBe(1);
    expect(saved.lines[RUY]).toMatchObject({ attempts: 1, cleanRuns: 1, cleanDays: ['2026-10-01'], family: 'Ruy Lopez' });
  });

  it('tolerates corrupt data, keeping a backup before replacing it', () => {
    for (const raw of ['not json', '{"v":1,"lines":{"c60-ruy-lopez":{"attem', '[]', 'null', '42', '{"v":1,"lines":[]}', '{"v":1}', '{"v":"1","lines":{}}']) {
      const storage = memoryStorage({ [PROGRESS_KEY]: raw });
      expect(allProgress({ storage }), raw).toEqual({});
      expect(getProgress(RUY, { storage }).mastery).toBe(0);
      expect(recordDrill(RUY, { clean: true }, { storage, now: day(1) }).attempts).toBe(1);
      expect(getProgress(RUY, { storage }).attempts, raw).toBe(1); // replaced with valid data...
      expect(storage.data.get(PROGRESS_BACKUP_KEY), raw).toBe(raw); // ...after a copy of the old value
    }
  });

  it('never overwrites progress saved by a newer version', () => {
    const newer = JSON.stringify({ v: 2, lines: { [RUY]: { attempts: 50 } } });
    const storage = memoryStorage({ [PROGRESS_KEY]: newer });
    expect(allProgress({ storage })).toEqual({});
    expect(recordDrill(NAJDORF, { clean: true }, { storage, now: day(1) }).attempts).toBe(1); // reported, not saved
    expect(resetProgress(RUY, { storage })).toBe(false);
    expect(storage.data.get(PROGRESS_KEY)).toBe(newer);
    expect(resetProgress(undefined, { storage })).toBe(true); // an explicit reset of everything still works
    expect(storage.data.has(PROGRESS_KEY)).toBe(false);
  });

  it('never overwrites progress it could not read', () => {
    const storage = memoryStorage();
    for (let d = 1; d <= 9; d++) recordDrill(RUY, { clean: false }, { storage, now: day(d) });
    const saved = storage.data.get(PROGRESS_KEY);
    const getItem = storage.getItem;
    storage.getItem = () => {
      storage.getItem = getItem; // fails once
      throw new Error('storage busy');
    };
    expect(recordDrill(NAJDORF, { clean: true }, { storage, now: day(10) }).attempts).toBe(1);
    expect(storage.data.get(PROGRESS_KEY)).toBe(saved);
    expect(getProgress(RUY, { storage }).attempts).toBe(9);
  });

  it('ignores ids that are not safe object keys', () => {
    const storage = memoryStorage({ [PROGRESS_KEY]: '{"v":1,"lines":{"__proto__":{"attempts":1},"c60-ruy-lopez":{"attempts":2}}}' });
    const all = allProgress({ storage });
    expect(Object.getPrototypeOf(all)).toBe(Object.prototype);
    expect(Object.keys(all)).toEqual([RUY]);
    expect(recordDrill('__proto__', { clean: true }, { storage, now: day(1) }).attempts).toBe(0);
  });

  it('sanitizes damaged records', () => {
    const lines = {
      [RUY]: { attempts: -5, cleanRuns: 'many', cleanDays: ['bad', 3, '2026-10-01'], lastPracticed: 'yesterday', bestScore: 900 },
      [NAJDORF]: { attempts: 4.7, cleanRuns: 9, cleanDays: ['2026-10-03', '2026-10-01', '2026-10-02', '2026-10-01'], lastClean: true },
      junk: 'nope',
      '': { attempts: 1 },
    };
    const storage = memoryStorage({ [PROGRESS_KEY]: JSON.stringify({ v: 1, lines }) });
    const all = allProgress({ storage });
    expect(Object.keys(all).sort()).toEqual([NAJDORF, RUY].sort());
    expect(all[RUY]).toMatchObject({ attempts: 0, cleanRuns: 0, cleanDays: [], lastPracticed: null, bestScore: 0, mastery: 0 });
    expect(all[NAJDORF]).toMatchObject({
      attempts: 4,
      cleanRuns: 4,
      cleanDays: ['2026-10-01', '2026-10-02', '2026-10-03'],
      lastClean: true,
      mastery: 3,
    });
  });

  it('never throws when storage fails or is missing', () => {
    const broken = memoryStorage({}, true);
    expect(getProgress(RUY, { storage: broken }).attempts).toBe(0);
    expect(recordDrill(RUY, { clean: true }, { storage: broken, now: day(1) })).toMatchObject({ attempts: 1, mastery: 2 });
    expect(resetProgress(undefined, { storage: broken })).toBe(false);
    expect(recordDrill(RUY, { clean: false }, { storage: null, now: day(1) }).attempts).toBe(1);
    expect(allProgress({ storage: null })).toEqual({});
    // the default storage (no localStorage under node) works too
    expect(getProgress(RUY).attempts).toBe(0);
  });

  it('resets one line or everything', () => {
    const storage = memoryStorage();
    recordDrill(RUY, { clean: true }, { storage, now: day(1) });
    recordDrill(NAJDORF, { clean: true }, { storage, now: day(1) });
    expect(resetProgress('nope', { storage })).toBe(false);
    expect(resetProgress(RUY, { storage })).toBe(true);
    expect(Object.keys(allProgress({ storage }))).toEqual([NAJDORF]);
    expect(resetProgress(undefined, { storage })).toBe(true);
    expect(storage.data.has(PROGRESS_KEY)).toBe(false);
  });
});

describe('family summaries', () => {
  it('counts lines by mastery per family', () => {
    const storage = memoryStorage();
    recordDrill(NAJDORF, { clean: false }, { storage, now: day(1) });
    recordDrill('b20-sicilian-defense', { clean: true }, { storage, now: day(2) });
    recordDrill(RUY, { clean: true }, { storage, now: day(3) });
    recordDrill('c84-ruy-lopez-closed', { clean: false }, { storage, now: day(3, 13) });
    expect(familyProgress('Sicilian Defense', { storage })).toEqual({
      family: 'Sicilian Defense',
      lines: 391,
      practiced: 2,
      learning: 1,
      familiar: 1,
      mastered: 0,
      attempts: 2,
      lastPracticed: day(2).toISOString(),
    });
    expect(familyProgress('French Defense', { storage })).toMatchObject({ lines: 212, practiced: 0, lastPracticed: null });
    expect(familyProgress('ruy lopez', { storage })).toMatchObject({ family: 'Ruy Lopez', lines: 235, practiced: 2 });
    expect(progressSummary({ storage }).map((f) => [f.family, f.practiced])).toEqual([
      ['Ruy Lopez', 2],
      ['Sicilian Defense', 2],
    ]);
  });
});
