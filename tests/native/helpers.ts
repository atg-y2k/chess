/** Shared helpers for the src/native/ tests: load a module as the App Store app or the web app sees it. */
import { vi } from 'vitest';

/**
 * Re-imports `load()` with a fresh module registry, as built with VITE_NATIVE=1 (`native`) and
 * running inside Capacitor's iOS web view (`runtime`: the native bridge's `Capacitor` global).
 * Undo with `resetPlatform()`.
 */
export async function importAs<T>(
  load: () => Promise<T>,
  { native, runtime = native, paywall = false }: { native: boolean; runtime?: boolean; paywall?: boolean },
): Promise<T> {
  vi.resetModules();
  vi.stubEnv('VITE_NATIVE', native ? '1' : '');
  vi.stubEnv('VITE_PAYWALL', paywall ? '1' : '');
  vi.stubGlobal('Capacitor', runtime ? { isNativePlatform: () => true } : undefined);
  return load();
}

export function resetPlatform(): void {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
}

/** A Storage-like class (node has no localStorage); tests wrap its prototype like the app wraps Storage's. */
export class MemoryStorage {
  readonly data = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.data.set(k, v);
  }
  get length(): number {
    return this.data.size;
  }
  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (v === 'too big') throw new Error('QuotaExceededError');
    this.data.set(String(k), String(v));
  }
  removeItem(k: string): void {
    this.data.delete(String(k));
  }
  clear(): void {
    this.data.clear();
  }
}

/** An in-memory @capacitor/preferences whose calls each take a random few ms (to catch ordering bugs). */
export function fakePreferences(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  const later = <T>(f: () => T): Promise<T> => new Promise((r) => setTimeout(() => r(f()), Math.random() * 5));
  const calls: string[] = [];
  return {
    data,
    calls,
    get: vi.fn(({ key }: { key: string }) => later(() => ({ value: data.get(key) ?? null }))),
    set: vi.fn(({ key, value }: { key: string; value: string }) =>
      later(() => {
        calls.push(`set ${key}=${value}`);
        data.set(key, value);
      }),
    ),
    remove: vi.fn(({ key }: { key: string }) =>
      later(() => {
        calls.push(`remove ${key}`);
        data.delete(key);
      }),
    ),
    keys: vi.fn(() => later(() => ({ keys: [...data.keys()] }))),
  };
}
