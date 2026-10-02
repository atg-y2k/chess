import { describe, expect, it } from 'vitest';
import {
  ENGINE_BOOT_KEY,
  ENGINE_MODE_KEY,
  SINGLE_MODE_TTL_MS,
  createEngines,
  rememberedEngineMode,
  resetEngineMode,
  type EngineLoadProgress,
} from '../../src/engine/createEngines';
import { EngineLoadError, engineFailureKind } from '../../src/engine/errors';
import type { EngineTransport } from '../../src/engine/types';
import { createNodeTransport } from '../helpers/nodeTransport';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memoryStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

/** A transport whose engine "fails to load" (error event right away). */
function brokenTransport(err: Error = new Error('simulated worker load failure')): EngineTransport {
  let onErr: ((e: Error) => void) | null = null;
  setTimeout(() => onErr?.(err), 10);
  return { post: () => {}, onLine: () => {}, onError: (cb) => void (onErr = cb), terminate: () => {} };
}

/** A real engine whose commands arrive `ms` late (a slow worker start). */
function slowTransport(ms: number): EngineTransport {
  const t = createNodeTransport();
  return { ...t, post: (cmd) => void setTimeout(() => t.post(cmd), ms) };
}

/** Stand-ins for document (visibility) and window (pagehide). */
function fakePage(state: 'visible' | 'hidden' = 'visible') {
  const document = Object.assign(new EventTarget(), { visibilityState: state as string });
  const window = new EventTarget();
  return {
    lifecycle: { document, window },
    hide() {
      document.visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    show() {
      document.visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    },
    pagehide() {
      window.dispatchEvent(new Event('pagehide'));
    },
  };
}

async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for condition');
    await sleep(5);
  }
}

describe('createEngines', () => {
  it('starts two engines, sets the boot flag and clears it once healthy', async () => {
    const storage = memoryStorage();
    const set = await createEngines({ createTransport: createNodeTransport, storage, query: '', healthyAfterMs: 300 });
    try {
      expect(set.mode).toBe('dual');
      expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(true);
      const [a, b] = await Promise.all([
        set.analysis.search(START, { depth: 8, multiPv: 2 }),
        set.bot.search(START, { depth: 8, skillLevel: 3 }),
      ]);
      expect(a.lines).toHaveLength(2);
      expect(a.lines[0].wdl).toBeDefined(); // analysis engine has UCI_ShowWDL
      expect(b.done).toBe(true);
      await sleep(400);
      expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(false);
      expect(storage.map.has(ENGINE_MODE_KEY)).toBe(false);
    } finally {
      set.terminate();
    }
  });

  it('falls back to single mode (and remembers it) when the last dual boot never became healthy', async () => {
    const storage = memoryStorage({ [ENGINE_BOOT_KEY]: '123' });
    const set = await createEngines({ createTransport: createNodeTransport, storage, query: '' });
    try {
      expect(set.mode).toBe('single');
      expect(rememberedEngineMode(storage)?.mode).toBe('single');
      expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(false);
      // Both logical engines work on the shared worker; the bot pre-empts and analysis resumes.
      const analysis = set.analysis.search(START, { depth: 11, multiPv: 2 });
      await sleep(30);
      const bot = await set.bot.search(START, { depth: 8, skillLevel: 5 });
      expect(bot.done).toBe(true);
      const r = await analysis;
      expect(r.done).toBe(true);
      expect(r.depth).toBe(11);
    } finally {
      set.terminate();
    }
  });

  it('?engines=2 clears the remembered single mode; ?engines=1 forces single without persisting', async () => {
    const storage = memoryStorage({ [ENGINE_MODE_KEY]: JSON.stringify({ mode: 'single', at: Date.now() }) });
    const dual = await createEngines({ createTransport: createNodeTransport, storage, query: '?engines=2' });
    expect(dual.mode).toBe('dual');
    expect(storage.map.has(ENGINE_MODE_KEY)).toBe(false);
    dual.terminate();
    expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(false); // deliberate shutdown is not a crash

    const single = await createEngines({ createTransport: createNodeTransport, storage, query: '?engines=1' });
    expect(single.mode).toBe('single');
    expect(storage.map.has(ENGINE_MODE_KEY)).toBe(false);
    single.terminate();
  });

  it('uses one shared engine when the second worker fails to start', async () => {
    const storage = memoryStorage();
    let n = 0;
    const set = await createEngines({
      createTransport: () => (++n === 2 ? brokenTransport() : createNodeTransport()),
      storage,
      query: '',
    });
    try {
      expect(set.mode).toBe('single');
      expect(rememberedEngineMode(storage)?.mode).toBe('single');
      expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(false);
      expect((await set.bot.search(START, { depth: 6 })).done).toBe(true);
    } finally {
      set.terminate();
    }
  });

  it('rejects when even the first engine cannot start, saying why', async () => {
    const plain = await createEngines({ createTransport: () => brokenTransport(), storage: null, query: '' }).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(Error);
    expect((plain as Error).message).toMatch(/simulated/);
    expect(engineFailureKind(plain)).toBe('crash');
    const http = await createEngines({
      createTransport: () => brokenTransport(new EngineLoadError('Could not download the chess engine: HTTP 404', 'download')),
      storage: null,
      query: '',
    }).catch((e: unknown) => e);
    expect(engineFailureKind(http)).toBe('download');
  });

  it('a download failure of the second engine uses one engine now but does not remember it', async () => {
    const storage = memoryStorage();
    let n = 0;
    const set = await createEngines({
      createTransport: () => (++n === 2 ? brokenTransport(new EngineLoadError('offline', 'download')) : createNodeTransport()),
      storage,
      query: '',
    });
    try {
      expect(set.mode).toBe('single');
      expect(storage.map.has(ENGINE_MODE_KEY)).toBe(false);
      expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(false);
    } finally {
      set.terminate();
    }
  });

  it('reports each engine download progress', async () => {
    const seen: EngineLoadProgress[] = [];
    const withProgress = (): EngineTransport => {
      const t = createNodeTransport();
      return { ...t, onProgress: (cb) => cb({ loaded: 1787571, total: 1787571 }) };
    };
    const set = await createEngines({ createTransport: withProgress, storage: null, query: '', onProgress: (p) => seen.push(p) });
    set.terminate();
    expect(seen.map((p) => p.engine)).toEqual(['analysis', 'bot']);
    expect(seen[0]).toMatchObject({ loaded: 1787571, total: 1787571 });
  });
});

describe('createEngines crash heuristic and page lifecycle', () => {
  it('does not leave the boot flag behind when the page is hidden while the second engine starts', async () => {
    const storage = memoryStorage();
    const page = fakePage();
    let n = 0;
    const pending = createEngines({
      createTransport: () => (++n === 2 ? slowTransport(300) : createNodeTransport()),
      storage,
      query: '',
      lifecycle: page.lifecycle,
      healthyAfterMs: 60_000,
    });
    await until(() => n === 2);
    expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(true); // armed while the second worker starts
    page.hide(); // the user switches away
    expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(false);
    const set = await pending;
    try {
      expect(set.mode).toBe('dual');
      await sleep(50);
      expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(false); // still hidden: not re-armed
      // iOS evicts the backgrounded app (no terminate()); the next launch still gets two engines.
      const next = await createEngines({
        createTransport: createNodeTransport,
        storage: memoryStorage(Object.fromEntries(storage.map)),
        query: '',
        lifecycle: fakePage().lifecycle,
      });
      expect(next.mode).toBe('dual');
      next.terminate();
    } finally {
      set.terminate();
    }
  });

  it('writes no flag while hidden, re-arms when the page comes back, and stops watching once healthy', async () => {
    const storage = memoryStorage();
    const page = fakePage('hidden');
    const set = await createEngines({
      createTransport: createNodeTransport,
      storage,
      query: '',
      lifecycle: page.lifecycle,
      healthyAfterMs: 300,
    });
    try {
      expect(set.mode).toBe('dual');
      expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(false);
      page.show(); // back in the foreground before the start was confirmed healthy
      expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(true);
      page.pagehide(); // unloaded (or put in the back-forward cache)
      expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(false);
      page.show();
      expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(true);
      await sleep(450); // healthy in the foreground
      expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(false);
      page.hide();
      page.show();
      expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(false); // no longer watching
    } finally {
      set.terminate();
    }
  });

  it('remembers single mode for SINGLE_MODE_TTL_MS, then tries two engines again', async () => {
    const t0 = 1_800_000_000_000;
    const storage = memoryStorage({ [ENGINE_BOOT_KEY]: '1' });
    const at = (t: number) => createEngines({ createTransport: createNodeTransport, storage, query: '', now: () => t });
    const first = await at(t0);
    first.terminate();
    expect(first.mode).toBe('single');
    expect(rememberedEngineMode(storage, t0)).toEqual({ mode: 'single', since: t0, until: t0 + SINGLE_MODE_TTL_MS });
    const later = await at(t0 + SINGLE_MODE_TTL_MS - 1);
    later.terminate();
    expect(later.mode).toBe('single');
    const expired = await at(t0 + SINGLE_MODE_TTL_MS);
    expired.terminate();
    expect(expired.mode).toBe('dual');
    expect(storage.map.has(ENGINE_MODE_KEY)).toBe(false);
    expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(false);
  });

  it('counts a plain "single" from an older build from now; resetEngineMode() forgets it', async () => {
    const storage = memoryStorage({ [ENGINE_MODE_KEY]: 'single' });
    expect(rememberedEngineMode(storage, 5000)).toEqual({ mode: 'single', since: 5000, until: 5000 + SINGLE_MODE_TTL_MS });
    expect(JSON.parse(storage.map.get(ENGINE_MODE_KEY)!)).toEqual({ mode: 'single', at: 5000 });
    resetEngineMode(storage);
    expect(rememberedEngineMode(storage)).toBeNull();
    const set = await createEngines({ createTransport: createNodeTransport, storage, query: '' });
    set.terminate();
    expect(set.mode).toBe('dual');
  });
});
