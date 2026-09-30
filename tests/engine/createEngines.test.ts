import { describe, expect, it } from 'vitest';
import { ENGINE_BOOT_KEY, ENGINE_MODE_KEY, createEngines } from '../../src/engine/createEngines';
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
function brokenTransport(): EngineTransport {
  let onErr: ((e: Error) => void) | null = null;
  setTimeout(() => onErr?.(new Error('simulated worker load failure')), 10);
  return { post: () => {}, onLine: () => {}, onError: (cb) => void (onErr = cb), terminate: () => {} };
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
      expect(storage.map.get(ENGINE_MODE_KEY)).toBe('single');
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
    const storage = memoryStorage({ [ENGINE_MODE_KEY]: 'single' });
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
      expect(storage.map.get(ENGINE_MODE_KEY)).toBe('single');
      expect(storage.map.has(ENGINE_BOOT_KEY)).toBe(false);
      expect((await set.bot.search(START, { depth: 6 })).done).toBe(true);
    } finally {
      set.terminate();
    }
  });

  it('rejects when even the first engine cannot start', async () => {
    await expect(createEngines({ createTransport: brokenTransport, storage: null, query: '' })).rejects.toThrow(
      /simulated/,
    );
  });
});
