import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MIRROR_PREFIX,
  UNRESTORED_KEY,
  installStorageMirror,
  restoreFromPreferences,
  type PreferencesLike,
} from '../../src/native/storage';
import { MemoryStorage, fakePreferences, importAs, resetPlatform } from './helpers';

const preferencesModule = vi.hoisted(() => ({ loaded: 0, impl: null as object | null }));
vi.mock('@capacitor/preferences', () => {
  preferencesModule.loaded++;
  // Like the proxy Capacitor's registerPlugin returns: it answers every property name with a
  // "native method", `then` included (which never calls back).
  const Preferences = new Proxy(
    {},
    {
      get: (_, prop) => {
        const impl = (preferencesModule.impl ?? { keys: async () => ({ keys: [] }) }) as Record<PropertyKey, unknown>;
        return prop in impl ? impl[prop] : () => new Promise(() => {});
      },
    },
  );
  return { Preferences };
});

/**
 * A Preferences whose calls take `ms` each (`keysMs` for keys()). Like the native side, a call
 * reads or writes its value when it is made, and answers later.
 */
function slowPreferences(init: Record<string, string>, ms: number, keysMs = ms) {
  const data = new Map(Object.entries(init));
  const calls: string[] = [];
  const after = <T>(v: T, t = ms): Promise<T> => new Promise((r) => setTimeout(() => r(v), t));
  const prefs: PreferencesLike & { data: Map<string, string>; calls: string[] } = {
    data,
    calls,
    keys: () => {
      calls.push('keys');
      return after({ keys: [...data.keys()] }, keysMs);
    },
    get: ({ key }) => {
      calls.push(`get ${key}`);
      return after({ value: data.get(key) ?? null });
    },
    set: ({ key, value }) => {
      calls.push(`set ${key}=${value}`);
      data.set(key, value);
      return after(undefined);
    },
    remove: ({ key }) => {
      calls.push(`remove ${key}`);
      data.delete(key);
      return after(undefined);
    },
  };
  return prefs;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Lets the mirror's queue drain (each fake Preferences call takes up to 5 ms). */
const settle = () => new Promise((r) => setTimeout(r, 120));

let uninstall: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
  resetPlatform();
});

describe('restoreFromPreferences', () => {
  it('copies back only the app keys that localStorage lost', async () => {
    expect(MIRROR_PREFIX).toBe('chesscoach.');
    const storage = new MemoryStorage({ 'chesscoach.settings': 'local' });
    const prefs = fakePreferences({
      'chesscoach.profile': '{"rating":1234}',
      'chesscoach.settings': 'backup', // localStorage has it: localStorage wins
      'other.key': 'x', // not ours
    });
    const { restored, unrestored } = await restoreFromPreferences(storage as unknown as Storage, prefs);
    expect(restored).toEqual(['chesscoach.profile']);
    expect(unrestored).toEqual([]);
    expect(Object.fromEntries(storage.data)).toEqual({
      'chesscoach.settings': 'local',
      'chesscoach.profile': '{"rating":1234}',
    });
  });

  it('never blocks startup: gives up after the time limit, and swallows failures', async () => {
    const storage = new MemoryStorage();
    const stuck = { ...fakePreferences(), keys: () => new Promise<{ keys: string[] }>(() => {}) };
    const t0 = Date.now();
    const unknown = { restored: [], unrestored: null }; // the backup's keys are not known
    expect(await restoreFromPreferences(storage as unknown as Storage, stuck, 50)).toEqual(unknown);
    expect(Date.now() - t0).toBeLessThan(1000);
    const broken = { ...fakePreferences(), keys: () => Promise.reject(new Error('no bridge')) };
    expect(await restoreFromPreferences(storage as unknown as Storage, broken)).toEqual(unknown);
    expect(
      await restoreFromPreferences(storage as unknown as Storage, () => Promise.reject(new Error('no plugin'))),
    ).toEqual(unknown);
    expect(await restoreFromPreferences(null, fakePreferences({ 'chesscoach.a': '1' }))).toEqual({
      restored: [],
      unrestored: [],
    });
  });

  it('reads the values in parallel: a failed read, or a key that does not fit, only loses that key', async () => {
    const storage = new MemoryStorage();
    const prefs = fakePreferences({
      'chesscoach.game': 'too big',
      'chesscoach.profile': 'P',
      'chesscoach.settings': 'S',
      'chesscoach.theme': 'light',
    });
    const get = prefs.get.getMockImplementation()!;
    prefs.get.mockImplementation((o) => (o.key === 'chesscoach.profile' ? Promise.reject(new Error('bridge')) : get(o)));
    const { restored, unrestored } = await restoreFromPreferences(storage as unknown as Storage, prefs);
    expect(restored.sort()).toEqual(['chesscoach.settings', 'chesscoach.theme']);
    expect(unrestored?.sort()).toEqual(['chesscoach.game', 'chesscoach.profile']);
    expect(Object.fromEntries(storage.data)).toEqual({ 'chesscoach.settings': 'S', 'chesscoach.theme': 'light' });
  });

  it('values that come too late: nothing is written after it resolves, and the app’s defaults never replace their backup', async () => {
    const storage = new MemoryStorage();
    const backup = { 'chesscoach.profile': 'P-backup', 'chesscoach.settings': 'S-backup' };
    const prefs = slowPreferences(backup, 100, 5);
    const outcome = await restoreFromPreferences(storage as unknown as Storage, prefs, 1000, 30);
    expect(outcome.restored).toEqual([]);
    expect(outcome.unrestored?.sort()).toEqual(['chesscoach.profile', 'chesscoach.settings']);
    await wait(150); // the reads answer now: too late, they must not land behind the running app
    expect(storage.data.size).toBe(0);

    // The app starts on defaults and saves them; only the other keys reach the backup.
    uninstall = installStorageMirror(storage as unknown as Storage, prefs, MemoryStorage.prototype, outcome.unrestored);
    expect(JSON.parse(storage.getItem(UNRESTORED_KEY)!).sort()).toEqual(['chesscoach.profile', 'chesscoach.settings']);
    storage.setItem('chesscoach.profile', 'P-default');
    storage.setItem('chesscoach.game', 'G');
    storage.removeItem('chesscoach.settings');
    await wait(250);
    expect(Object.fromEntries(prefs.data)).toEqual({ ...backup, 'chesscoach.game': 'G' });
    uninstall();
    uninstall = null;

    // The next launch copies the held keys back over what this session saved, and forgets the hold.
    const next = await restoreFromPreferences(storage as unknown as Storage, fakePreferences(Object.fromEntries(prefs.data)));
    expect(next.restored.sort()).toEqual(['chesscoach.profile', 'chesscoach.settings']);
    expect(next.unrestored).toEqual([]);
    expect(storage.getItem('chesscoach.profile')).toBe('P-backup');
    expect(storage.getItem('chesscoach.game')).toBe('G');
    uninstall = installStorageMirror(storage as unknown as Storage, fakePreferences(), MemoryStorage.prototype, next.unrestored);
    expect(storage.getItem(UNRESTORED_KEY)).toBeNull();
  });

  it('a key list that comes too late: the mirror holds every backed-up key the app started without', async () => {
    const storage = new MemoryStorage({ 'chesscoach.theme': 'dark' });
    const prefs = slowPreferences({ 'chesscoach.theme': 'dark', 'chesscoach.profile': 'P-backup' }, 5, 100);
    const outcome = await restoreFromPreferences(storage as unknown as Storage, prefs, 30);
    expect(outcome).toEqual({ restored: [], unrestored: null });
    await wait(150);
    expect(storage.getItem('chesscoach.profile')).toBeNull(); // no late write

    uninstall = installStorageMirror(storage as unknown as Storage, prefs, MemoryStorage.prototype, outcome.unrestored);
    storage.setItem('chesscoach.profile', 'P-default');
    storage.setItem('chesscoach.theme', 'light');
    await wait(250);
    expect(prefs.data.get('chesscoach.profile')).toBe('P-backup');
    expect(prefs.data.get('chesscoach.theme')).toBe('light');
    expect(JSON.parse(storage.getItem(UNRESTORED_KEY)!)).toEqual(['chesscoach.profile']);
  });
});

describe('installStorageMirror', () => {
  it('writes every change to an app key through to Preferences, in order', async () => {
    const storage = new MemoryStorage();
    const other = new MemoryStorage(); // e.g. sessionStorage: not mirrored
    const prefs = fakePreferences();
    uninstall = installStorageMirror(storage as unknown as Storage, prefs, MemoryStorage.prototype);
    storage.setItem('chesscoach.game', 'a');
    storage.setItem('chesscoach.game', 'b');
    storage.setItem('chesscoach.profile', 'p');
    storage.removeItem('chesscoach.game');
    storage.setItem('chesscoach.game', 'c');
    storage.setItem('unrelated', 'x');
    other.setItem('chesscoach.game', 'z');
    expect(storage.getItem('chesscoach.game')).toBe('c'); // localStorage itself still works
    await settle();
    expect(prefs.calls).toEqual([
      'set chesscoach.game=a',
      'set chesscoach.game=b',
      'set chesscoach.profile=p',
      'remove chesscoach.game',
      'set chesscoach.game=c',
    ]);
    expect(Object.fromEntries(prefs.data)).toEqual({ 'chesscoach.game': 'c', 'chesscoach.profile': 'p' });
  });

  it('backs up the keys already there, mirrors clear(), and skips writes that failed', async () => {
    const storage = new MemoryStorage({ 'chesscoach.settings': 's', unrelated: 'u' });
    const prefs = fakePreferences({ 'chesscoach.stale': 'old' });
    uninstall = installStorageMirror(storage as unknown as Storage, prefs, MemoryStorage.prototype);
    expect(() => storage.setItem('chesscoach.game', 'too big')).toThrow(/Quota/);
    await settle();
    expect(prefs.calls).toEqual(['set chesscoach.settings=s']);
    storage.clear();
    await settle();
    expect(prefs.calls.at(-1)).toBe('remove chesscoach.settings');
    expect(storage.length).toBe(0);
  });

  it('keeps localStorage working when Preferences fails', async () => {
    const storage = new MemoryStorage();
    const prefs = { ...fakePreferences(), set: vi.fn(() => Promise.reject(new Error('disk full'))) };
    uninstall = installStorageMirror(storage as unknown as Storage, prefs, MemoryStorage.prototype);
    storage.setItem('chesscoach.a', '1');
    storage.setItem('chesscoach.b', '2');
    await settle();
    expect(prefs.set).toHaveBeenCalledTimes(2); // the second write still went out after the first failed
    expect(storage.getItem('chesscoach.b')).toBe('2');
  });

  it('uninstalls cleanly', () => {
    const { setItem, removeItem, clear } = MemoryStorage.prototype;
    const storage = new MemoryStorage();
    installStorageMirror(storage as unknown as Storage, fakePreferences(), MemoryStorage.prototype)();
    expect(MemoryStorage.prototype.setItem).toBe(setItem);
    expect(MemoryStorage.prototype.removeItem).toBe(removeItem);
    expect(MemoryStorage.prototype.clear).toBe(clear);
  });
});

describe('the real plugin loader', () => {
  it('restores and mirrors through a Capacitor-like proxy (never resolves a promise with it)', async () => {
    const backup = fakePreferences({ 'chesscoach.profile': '{"rating":1234}' });
    preferencesModule.impl = backup;
    try {
      const mod = await importAs(() => import('../../src/native/storage'), { native: true });
      const storage = new MemoryStorage();
      const t0 = Date.now();
      const outcome = await mod.restoreFromPreferences(storage as unknown as Storage);
      expect(Date.now() - t0).toBeLessThan(mod.RESTORE_TIMEOUT_MS / 2);
      expect(outcome).toEqual({ restored: ['chesscoach.profile'], unrestored: [] });
      uninstall = mod.installStorageMirror(storage as unknown as Storage, undefined, MemoryStorage.prototype);
      storage.setItem('chesscoach.settings', 's');
      await settle();
      expect(backup.calls).toEqual(['set chesscoach.profile={"rating":1234}', 'set chesscoach.settings=s']);
    } finally {
      preferencesModule.impl = null;
    }
  });
});

describe('prepareNativeStorage', () => {
  it('does nothing on the web (Preferences is never loaded)', async () => {
    preferencesModule.loaded = 0;
    for (const env of [{ native: false }, { native: true, runtime: false }]) {
      const { prepareNativeStorage } = await importAs(() => import('../../src/native/storage'), env);
      await prepareNativeStorage();
    }
    expect(preferencesModule.loaded).toBe(0);
  });
});
