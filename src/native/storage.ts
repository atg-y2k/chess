/**
 * A backup of the app's localStorage in the App Store app.
 *
 * iOS may clear a WKWebView's localStorage when the device runs low on space, which would lose the
 * player's rating, history, settings and saved game. So every localStorage key starting with
 * `chesscoach.` is mirrored to @capacitor/preferences (UserDefaults, which iOS does not purge):
 * - `restoreFromPreferences()` runs at startup, before the game controller reads its storage, and
 *   copies back any such key that localStorage has lost (awaited, with time limits);
 * - `installStorageMirror()` then wraps localStorage's setItem/removeItem/clear so every change is
 *   written through to Preferences (fire-and-forget, in order), and copies the current keys once.
 * localStorage stays the store the app reads; Preferences is only the backup. On the web both are
 * no-ops (see `isNative`).
 *
 * A backup the restore could not read in time must not be overwritten by the defaults the app then
 * starts with: such keys are "held" (never written through) for the session, and listed under
 * UNRESTORED_KEY so the next launch copies them back over whatever localStorage has by then.
 *
 * The plugin object is a Capacitor proxy that answers every property, `then` included, so it is
 * always passed around boxed (`{ prefs }`): a promise resolved with the proxy itself never settles.
 */
import { isNative, nativePlugins } from './platform';

/** The prefix of every key the app stores (src/game/persistence.ts, rating, theme, engine). */
export const MIRROR_PREFIX = 'chesscoach.';

/**
 * localStorage key (outside MIRROR_PREFIX, so never mirrored) listing backed-up keys whose local
 * values are not to be trusted: the restore missed them, so the app started without them. The next
 * restore copies them back from Preferences even though localStorage has them.
 */
export const UNRESTORED_KEY = 'chesscoach-native-unrestored';

/** How long startup waits for the plugin and the backup's key list (ms): a stuck bridge must not block the app. */
export const RESTORE_TIMEOUT_MS = 1500;

/** Once the key list is back (the bridge works), how long startup waits for the values (ms). */
export const RESTORE_VALUES_TIMEOUT_MS = 5000;

/** The parts of @capacitor/preferences used here (a fake in unit tests). */
export interface PreferencesLike {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
  keys(): Promise<{ keys: string[] }>;
}

/** The plugin, or a loader giving it boxed (never the bare proxy: see the module comment). */
export type PreferencesSource = PreferencesLike | (() => Promise<{ prefs: PreferencesLike }>);

/** What `restoreFromPreferences` did. */
export interface RestoreOutcome {
  /** The keys copied back into localStorage. */
  restored: string[];
  /**
   * Backed-up keys that were due to be copied back but were not (a failed or late read, or no room):
   * the mirror must not overwrite their backup. null: the backup's key list never came, so which
   * keys are affected is not known yet.
   */
  unrestored: string[] | null;
}

const isMirrored = (key: string): boolean => key.startsWith(MIRROR_PREFIX);

async function loadPreferences(): Promise<{ prefs: PreferencesLike }> {
  return { prefs: (await nativePlugins.preferences()).Preferences };
}

const boxed = (source: PreferencesSource): Promise<{ prefs: PreferencesLike }> =>
  typeof source === 'function' ? source() : Promise.resolve({ prefs: source });

/** `p`'s value, or undefined if it fails or takes longer than `ms`. */
async function within<T>(ms: number, p: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Copies every mirrored key that is in Preferences but missing from `storage` (or listed under
 * UNRESTORED_KEY) back into `storage`. Never rejects. Waits at most `timeoutMs` for the plugin and the
 * key list, then at most `valuesTimeoutMs` for the values (read in parallel); nothing is written to
 * `storage` once it has resolved.
 */
export async function restoreFromPreferences(
  storage: Storage | null = safeLocalStorage(),
  prefs: PreferencesSource = loadPreferences,
  timeoutMs = RESTORE_TIMEOUT_MS,
  valuesTimeoutMs = RESTORE_VALUES_TIMEOUT_MS,
): Promise<RestoreOutcome> {
  if (!storage) return { restored: [], unrestored: [] };
  const distrusted = readUnrestored(storage);
  const listed = await within(
    timeoutMs,
    (async () => {
      const { prefs: p } = await boxed(prefs);
      const { keys } = await p.keys();
      return { p, keys: keys.filter(isMirrored) }; // a plain object around the plugin: safe to resolve with
    })(),
  );
  if (!listed) return { restored: [], unrestored: null };
  const { p } = listed;
  const wanted = listed.keys.filter((k) => distrusted.has(k) || storage.getItem(k) === null);
  // One failed read only loses its own key.
  const values = await within(valuesTimeoutMs, Promise.allSettled(wanted.map((key) => p.get({ key }))));
  const restored: string[] = [];
  const unrestored: string[] = [];
  wanted.forEach((key, i) => {
    const r = values?.[i];
    if (!r || r.status === 'rejected') {
      unrestored.push(key);
      return;
    }
    const value = r.value?.value;
    if (typeof value !== 'string') return; // not actually backed up: nothing to protect
    try {
      storage.setItem(key, value);
      restored.push(key);
    } catch {
      unrestored.push(key); // quota or disabled storage
    }
  });
  return { restored, unrestored };
}

/** Removes the wrapper installed by `installStorageMirror` (for tests). */
export type Uninstall = () => void;

/**
 * Writes every change to a mirrored key of `storage` through to Preferences, in order, without
 * waiting (failures are ignored: localStorage stays authoritative). Also copies the current mirrored
 * keys once, so a backup made by an older build, or one that missed a write, catches up.
 * `hold`: keys whose backup must be kept as it is this session (RestoreOutcome.unrestored; null =
 * every backed-up key that `storage` lacks now, found once the plugin answers). They are recorded
 * under UNRESTORED_KEY for the next launch.
 * Wraps `Storage.prototype` (assigning to a Storage instance would store an item instead).
 */
export function installStorageMirror(
  storage: Storage | null = safeLocalStorage(),
  prefs: PreferencesSource = loadPreferences,
  proto: Pick<Storage, 'setItem' | 'removeItem' | 'clear'> = Storage.prototype,
  hold: readonly string[] | null = [],
): Uninstall {
  if (!storage) return () => {};
  const { setItem, removeItem, clear } = proto;
  const record = (keys: ReadonlySet<string>): void => {
    try {
      if (keys.size > 0) setItem.call(storage, UNRESTORED_KEY, JSON.stringify([...keys]));
      else removeItem.call(storage, UNRESTORED_KEY);
    } catch {
      // Full or blocked storage: the hold still applies to this session.
    }
  };
  const held = new Set(hold ?? readUnrestored(storage));
  const present = new Set(mirroredKeys(storage)); // before the app writes anything
  if (hold) record(held);

  // Boxed: see the module comment. null: no plugin, or nothing can safely be written.
  let ready: Promise<{ p: PreferencesLike } | null> | null = null;
  const plugin = (): Promise<{ p: PreferencesLike } | null> =>
    (ready ??= boxed(prefs)
      .then(async ({ prefs: p }) => {
        if (hold === null) {
          // The restore never saw the key list: hold every backed-up key the app started without.
          // (If the list cannot be read, nothing is written this session.)
          const { keys } = await p.keys();
          for (const k of keys) if (isMirrored(k) && !present.has(k)) held.add(k);
          record(held);
        }
        return { p };
      })
      .catch(() => null));
  // One chain, so writes reach Preferences in the order they happened.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (key: string, op: (p: PreferencesLike) => Promise<unknown>): void => {
    queue = queue
      .then(() => plugin())
      .then((box) => (box && !held.has(key) ? op(box.p) : undefined))
      .catch(() => {});
  };

  proto.setItem = function (this: Storage, key: string, value: string): void {
    setItem.call(this, key, value); // throws on quota errors, before anything is mirrored
    const k = String(key);
    if (this === storage && isMirrored(k)) {
      const v = String(value);
      enqueue(k, (p) => p.set({ key: k, value: v }));
    }
  };
  proto.removeItem = function (this: Storage, key: string): void {
    removeItem.call(this, key);
    const k = String(key);
    if (this === storage && isMirrored(k)) enqueue(k, (p) => p.remove({ key: k }));
  };
  proto.clear = function (this: Storage): void {
    const keys = this === storage ? mirroredKeys(this) : [];
    clear.call(this);
    for (const k of keys) enqueue(k, (p) => p.remove({ key: k }));
  };

  for (const k of present) {
    const v = storage.getItem(k);
    if (v !== null) enqueue(k, (p) => p.set({ key: k, value: v }));
  }

  return () => {
    proto.setItem = setItem;
    proto.removeItem = removeItem;
    proto.clear = clear;
  };
}

/**
 * Startup step for the native app (main.tsx): restores lost keys from the backup, then mirrors every
 * change. Resolves when the app may read its storage; a no-op on the web.
 */
export async function prepareNativeStorage(): Promise<void> {
  if (!isNative) return;
  const { unrestored } = await restoreFromPreferences();
  installStorageMirror(undefined, undefined, undefined, unrestored);
}

/** The keys listed under UNRESTORED_KEY (empty if none or unreadable). */
function readUnrestored(storage: Storage): Set<string> {
  try {
    const list: unknown = JSON.parse(storage.getItem(UNRESTORED_KEY) ?? '[]');
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string' && isMirrored(k)) : []);
  } catch {
    return new Set();
  }
}

function mirroredKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null && isMirrored(k)) keys.push(k);
  }
  return keys;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
