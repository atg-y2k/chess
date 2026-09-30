import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GAME_KEY,
  SETTINGS_KEY,
  clearGame,
  createGameId,
  loadGame,
  loadSettings,
  requestPersistentStorage,
  saveGame,
  saveSettings,
} from '../../src/game/persistence';
import type { SavedGame } from '../../src/game/persistence';
import { DEFAULT_SETTINGS } from '../../src/game/types';
import type { GameSettings } from '../../src/game/types';
import type { Classification } from '../../src/analysis/types';

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
  vi.unstubAllGlobals();
});

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const classification: Classification = {
  cls: 'inaccuracy',
  winBefore: 0.52,
  winAfter: 0.45,
  winLoss: 0.07,
  accuracy: 71.3,
  bestMoveUci: 'g8f6',
  bestMoveSan: 'Nf6',
  playedMoveSan: 'f6',
};

function savedGame(over: Partial<SavedGame> = {}): SavedGame {
  return {
    version: 1,
    id: 'game-1',
    startFen: START,
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'],
    playerColor: 'w',
    botId: 'custom',
    botElo: 1200,
    botName: 'Custom bot',
    assisted: false,
    startedAt: '2026-09-30T10:00:00.000Z',
    annotations: {
      0: { evalWhite: { kind: 'cp', value: 30 }, evalDepth: 18, isBook: true },
      3: {
        evalWhite: { kind: 'mate', value: -3 },
        classification,
        explanation: { headline: 'Develops a piece.', details: ['Knights before bishops.'], bestLineSan: ['Nf6'], motifs: ['development'] },
      },
    },
    ...over,
  };
}

describe('saved game', () => {
  it('round-trips and clears', () => {
    const game = savedGame();
    expect(saveGame(game)).toBe(true);
    expect(GAME_KEY.startsWith('chesscoach.')).toBe(true);
    expect(loadGame()).toEqual(game);
    clearGame();
    expect(storage.getItem(GAME_KEY)).toBeNull();
    expect(loadGame()).toBeNull();
  });

  it('handles promotions and castling in UCI', () => {
    const fen = 'r3k3/6P1/8/8/8/8/8/R3K2R w KQq - 0 1';
    const game = savedGame({ startFen: fen, moves: ['e1g1', 'e8c8', 'g7g8q'], annotations: {} });
    saveGame(game);
    expect(loadGame()?.moves).toEqual(['e1g1', 'e8c8', 'g7g8q']);
  });

  it('cuts the game at the first illegal move and drops later annotations', () => {
    saveGame(savedGame({ moves: ['e2e4', 'e7e5', 'e1e3', 'b8c6'] }));
    const loaded = loadGame();
    expect(loaded?.moves).toEqual(['e2e4', 'e7e5']);
    expect(Object.keys(loaded!.annotations)).toEqual(['0']);
  });

  it('normalises SAN moves to UCI', () => {
    saveGame(savedGame({ moves: ['e4', 'e5', 'Nf3'], annotations: {} }));
    expect(loadGame()?.moves).toEqual(['e2e4', 'e7e5', 'g1f3']);
  });

  it('drops (and removes) unusable games', () => {
    const cases: unknown[] = [
      '{broken',
      42,
      [],
      { ...savedGame(), version: 2 },
      { ...savedGame(), startFen: 'not a fen' },
      { ...savedGame(), id: '' },
      { ...savedGame(), playerColor: 'white' },
      { ...savedGame(), moves: 'e2e4' },
      { ...savedGame(), botElo: 'strong' },
    ];
    for (const c of cases) {
      storage.setItem(GAME_KEY, typeof c === 'string' ? c : JSON.stringify(c));
      expect(loadGame()).toBeNull();
      expect(storage.getItem(GAME_KEY)).toBeNull();
    }
  });

  it('sanitises annotations and optional fields', () => {
    const raw = {
      ...savedGame(),
      botElo: 5000,
      botName: 7,
      assisted: 'yes',
      futureField: { keep: true },
      annotations: {
        '0': { evalWhite: { kind: 'cp', value: 'x' }, evalDepth: 12, isBook: 'no' },
        '1': { classification: { ...classification, cls: 'awesome' } },
        '2': { explanation: { headline: 'Hi', details: ['a'], arrows: 'nope', title: 3, extra: 'kept' } },
        '4': { explanation: { headline: 5, details: [] } },
        '99': { evalDepth: 10 },
        foo: { evalDepth: 10 },
      },
    };
    storage.setItem(GAME_KEY, JSON.stringify(raw));
    const loaded = loadGame()!;
    expect(loaded.botElo).toBe(3200);
    expect(loaded.botName).toBe('Bot');
    expect(loaded.assisted).toBe(true); // unknown flag: never let a corrupt save become a rated game
    expect((loaded as unknown as { futureField: unknown }).futureField).toEqual({ keep: true });
    expect(loaded.annotations).toEqual({
      0: { evalDepth: 12 },
      2: { explanation: { headline: 'Hi', details: ['a'], extra: 'kept' } },
    });
  });

  it('retries without explanations when the quota is exceeded', () => {
    const limited = new MemoryStorage();
    limited.setItem = function (k: string, v: string) {
      if (v.includes('Knights before bishops')) throw new Error('QuotaExceededError');
      MemoryStorage.prototype.setItem.call(this, k, v);
    };
    expect(saveGame(savedGame(), limited)).toBe(true);
    const loaded = loadGame(limited)!;
    expect(loaded.moves).toHaveLength(5);
    expect(loaded.annotations[3].explanation).toBeUndefined();
    expect(loaded.annotations[3].classification).toEqual(classification);
  });

  it('never throws when storage is missing or broken', () => {
    delete g.localStorage;
    expect(saveGame(savedGame())).toBe(false);
    expect(loadGame()).toBeNull();
    expect(() => clearGame()).not.toThrow();
    g.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(saveGame(savedGame())).toBe(false);
    expect(loadGame()).toBeNull();
    expect(() => clearGame()).not.toThrow();
  });

  it('createGameId returns distinct ids', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createGameId()));
    expect(ids.size).toBe(50);
  });
});

describe('settings', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('round-trips under a versioned key', () => {
    const s: GameSettings = {
      ...DEFAULT_SETTINGS,
      playerColor: 'random',
      botId: 'bot-1450',
      botElo: 1450,
      adaptive: true,
      showBestMoves: true,
      sound: false,
    };
    saveSettings(s);
    expect(SETTINGS_KEY.startsWith('chesscoach.')).toBe(true);
    expect(JSON.parse(storage.getItem(SETTINGS_KEY)!).version).toBe(1);
    expect(loadSettings()).toEqual(s);
  });

  it('merges partial settings over the defaults (forward compatible)', () => {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, settings: { coach: false, botElo: 1500 } }));
    expect(loadSettings()).toEqual({ ...DEFAULT_SETTINGS, coach: false, botElo: 1500 });
  });

  it('replaces fields of the wrong type or range with defaults, keeps unknown primitives', () => {
    storage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        version: 1,
        settings: {
          playerColor: 'purple',
          botId: '',
          botElo: 99999,
          adaptive: 'yes',
          coach: 0,
          sound: false,
          newToggle: true,
          nested: { a: 1 },
        },
      }),
    );
    const s = loadSettings();
    expect(s).toEqual({ ...DEFAULT_SETTINGS, botElo: 3200, sound: false, newToggle: true });
  });

  it('accepts a bare settings object and recovers from corrupt data', () => {
    storage.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, botElo: 333.3 }));
    expect(loadSettings().botElo).toBe(333);
    for (const bad of ['{oops', 'null', '[1,2]', '"x"']) {
      storage.setItem(SETTINGS_KEY, bad);
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('never throws when storage is missing or broken', () => {
    delete g.localStorage;
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
    g.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
  });
});

describe('requestPersistentStorage', () => {
  it('is false when the Storage API is missing', async () => {
    vi.stubGlobal('navigator', {});
    expect(await requestPersistentStorage()).toBe(false);
  });

  it('is true when already persisted, without asking again', async () => {
    const persist = vi.fn(async () => false);
    vi.stubGlobal('navigator', { storage: { persisted: async () => true, persist } });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('asks for persistence and reports the answer; errors give false', async () => {
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist: async () => true } });
    expect(await requestPersistentStorage()).toBe(true);
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist: async () => false } });
    expect(await requestPersistentStorage()).toBe(false);
    vi.stubGlobal('navigator', {
      storage: {
        persisted: async () => {
          throw new Error('nope');
        },
        persist: async () => true,
      },
    });
    expect(await requestPersistentStorage()).toBe(false);
  });
});
