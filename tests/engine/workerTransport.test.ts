import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineFailureKind } from '../../src/engine/errors';
import type { DownloadProgress, EngineTransport } from '../../src/engine/types';
import { createWorkerTransport, engineWasmUrl } from '../../src/engine/workerTransport';

const SCRIPT = 'http://localhost/chess/engine/stockfish-19-lite-single.js';
const WASM = 'http://localhost/chess/engine/stockfish-19-lite-single.wasm';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for condition');
    await sleep(5);
  }
}

/** Stand-in for the engine's Web Worker: records what it is sent, lets the test play the worker. */
class FakeWorker {
  static last: FakeWorker | null = null;
  readonly sent: unknown[] = [];
  progressPort: MessagePort | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message?: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;

  constructor(readonly url: string) {
    FakeWorker.last = this;
  }
  postMessage(data: unknown): void {
    const port = (data as { progressPort?: MessagePort } | null)?.progressPort;
    if (port) this.progressPort = port;
    else this.sent.push(data);
  }
  terminate(): void {
    this.terminated = true;
    this.progressPort?.close();
  }
  // --- the worker's side
  print(line: string): void {
    this.onmessage?.({ data: line });
  }
  progress(loaded: number, total = 1000): void {
    this.progressPort?.postMessage({ percent: loaded / total, loaded, total, speedText: '1 MB/s' });
  }
  fail(message?: string): void {
    this.onerror?.({ message, preventDefault() {} });
  }
}

function listen(t: EngineTransport) {
  const got = { lines: [] as string[], errors: [] as Error[], progress: [] as DownloadProgress[] };
  t.onLine((l) => got.lines.push(l));
  t.onError?.((e) => got.errors.push(e));
  t.onProgress?.((p) => got.progress.push(p));
  return got;
}

let fetches: string[] = [];
let inits: RequestInit[] = [];
let respond: (init: RequestInit) => Promise<Response> = async () =>
  new Response('wasm', { headers: { 'content-type': 'application/wasm' } });

/** Like a real fetch that never gets an answer: pending until its signal aborts, then an AbortError. */
const hang = (init: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  });

beforeEach(() => {
  fetches = [];
  inits = [];
  respond = async () => new Response('wasm', { headers: { 'content-type': 'application/wasm' } });
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    fetches.push(String(url));
    inits.push(init);
    return respond(init);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createWorkerTransport', () => {
  it('derives the .wasm URL the way the vendored script does', () => {
    expect(engineWasmUrl(SCRIPT)).toBe(WASM);
    expect(engineWasmUrl(`${SCRIPT}?v=2#x`)).toBe(WASM);
  });

  it('forwards .wasm download progress, then output lines; a talking engine is never probed', async () => {
    const t = createWorkerTransport(SCRIPT, { probeAfterMs: 60 });
    const got = listen(t);
    const w = FakeWorker.last!;
    expect(w.progressPort).not.toBeNull();
    for (const loaded of [250, 500, 750, 1000]) {
      w.progress(loaded);
      await sleep(30);
    }
    expect(got.progress).toEqual([250, 500, 750, 1000].map((loaded) => ({ loaded, total: 1000 })));
    w.print('Stockfish 19\nuciok');
    expect(got.lines).toEqual(['Stockfish 19', 'uciok']);
    await sleep(200);
    expect(fetches).toEqual([]); // progress kept arriving, then the engine spoke
    expect(got.errors).toEqual([]);
    t.post('isready');
    expect(w.sent).toEqual(['isready']);
    t.terminate();
    expect(w.terminated).toBe(true);
  });

  it('reports a missing .wasm (HTTP 404) as a download error within the probe delay', async () => {
    respond = async () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } });
    const t = createWorkerTransport(SCRIPT, { probeAfterMs: 50 });
    const got = listen(t);
    await sleep(150);
    expect(fetches).toEqual([WASM]);
    expect(got.errors).toHaveLength(1);
    expect(engineFailureKind(got.errors[0])).toBe('download');
    expect(got.errors[0].message).toMatch(/HTTP 404/);
    t.terminate();
  });

  it('reports a network failure (offline) as a download error', async () => {
    respond = async () => {
      throw new TypeError('Load failed');
    };
    const t = createWorkerTransport(SCRIPT, { probeAfterMs: 50 });
    const got = listen(t);
    await sleep(150);
    expect(engineFailureKind(got.errors[0])).toBe('download');
    expect(got.errors[0].message).toMatch(/Load failed/);
    t.terminate();
  });

  it('reports a .wasm served with the wrong content type', async () => {
    respond = async () => new Response('<html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const t = createWorkerTransport(SCRIPT, { probeAfterMs: 50 });
    const got = listen(t);
    await sleep(150);
    expect(engineFailureKind(got.errors[0])).toBe('download');
    expect(got.errors[0].message).toMatch(/text\/html/);
    t.terminate();
  });

  it('probes only after a quiet spell, backs off after a good probe, and stops when closed', async () => {
    const t = createWorkerTransport(SCRIPT, { probeAfterMs: 100 });
    const got = listen(t);
    const w = FakeWorker.last!;
    for (let loaded = 100; loaded <= 500; loaded += 100) {
      w.progress(loaded); // bytes keep arriving: no probe
      await sleep(40);
    }
    expect(fetches).toEqual([]);
    const t0 = Date.now();
    while (fetches.length === 0 && Date.now() - t0 < 1000) await sleep(5); // stalled: probe
    expect(fetches).toHaveLength(1);
    await sleep(120); // the .wasm is fine: no error, next probe only after twice the delay (200 ms)
    expect(fetches).toHaveLength(1);
    await sleep(160);
    expect(fetches).toHaveLength(2);
    expect(got.errors).toEqual([]);
    t.terminate();
    await sleep(400);
    expect(fetches).toHaveLength(2);
  });

  it('classifies worker error events: a script that failed to load vs an engine abort', () => {
    const a = createWorkerTransport(SCRIPT, { probeAfterMs: 10_000 });
    const ga = listen(a);
    FakeWorker.last!.fail(); // bare error event: the script itself could not be fetched
    expect(engineFailureKind(ga.errors[0])).toBe('download');
    a.terminate();

    const b = createWorkerTransport(SCRIPT, { probeAfterMs: 10_000 });
    const gb = listen(b);
    FakeWorker.last!.print('uciok');
    FakeWorker.last!.fail('Uncaught RuntimeError: unreachable');
    expect(engineFailureKind(gb.errors[0])).toBe('crash');
    expect(gb.errors[0].message).toMatch(/unreachable/);
    b.terminate();
  });

  it('reads only the headers: a GET (served by the service worker offline) aborted once they arrive', async () => {
    let pulled = 0;
    // A body that would stream forever: the probe must not read it.
    respond = async () =>
      new Response(new ReadableStream({ pull: (c) => void (pulled++, c.enqueue(new Uint8Array(65536))) }), {
        headers: { 'content-type': 'application/wasm' },
      });
    const t = createWorkerTransport(SCRIPT, { probeAfterMs: 50 });
    const got = listen(t);
    await sleep(120);
    expect(fetches).toEqual([WASM]);
    expect(inits[0].method ?? 'GET').toBe('GET'); // Workbox answers only GETs: a HEAD would miss the precache
    expect(inits[0].signal?.aborted).toBe(true); // aborted right after the headers
    expect(pulled).toBeLessThanOrEqual(1); // at most the stream's initial fill, never read on
    expect(got.errors).toEqual([]);
    t.terminate();
  });

  it('abandons a probe that gets no headers in time (no verdict) and tries again later', async () => {
    respond = hang;
    const t = createWorkerTransport(SCRIPT, { probeAfterMs: 50, probeTimeoutMs: 100 });
    const got = listen(t);
    await until(() => fetches.length === 1);
    expect(inits[0].signal?.aborted).toBe(false);
    await until(() => !!inits[0].signal?.aborted); // given up after probeTimeoutMs
    expect(got.errors).toEqual([]); // a slow answer is not a failed download: the load timeout decides
    await until(() => fetches.length === 2); // tried again (after twice the delay)
    expect(inits[1].signal?.aborted).toBe(false);
    t.terminate();
    expect(inits[1].signal?.aborted).toBe(true); // closing aborts the probe in flight
    await sleep(150);
    expect(fetches).toHaveLength(2);
    expect(got.errors).toEqual([]);
  });

  it('aborts a probe in flight when the engine speaks', async () => {
    respond = hang;
    const t = createWorkerTransport(SCRIPT, { probeAfterMs: 50 });
    const got = listen(t);
    await until(() => fetches.length === 1);
    FakeWorker.last!.print('uciok');
    expect(inits[0].signal?.aborted).toBe(true);
    await sleep(20);
    expect(got.errors).toEqual([]);
    expect(got.lines).toEqual(['uciok']);
    t.terminate();
  });
});
