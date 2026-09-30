/**
 * EngineTransport over a classic Web Worker running the vendored Stockfish 19 lite
 * single-threaded WASM build (public/engine/). The worker posts every output line as a plain
 * string; the `.wasm` is fetched from the same directory with the same basename.
 *
 * The vendored script only logs a failed `.wasm` fetch or compile and then never answers, so
 * loading is made observable here:
 *  - `.wasm` download progress arrives on a MessagePort (`{ progressPort }`) and is forwarded to
 *    `onProgress`: the engine's load timeout can then tell a slow download from a dead one.
 *  - While the worker is silent (no output, no progress) for a few seconds, the `.wasm` is probed
 *    from the main thread (through the same service worker and HTTP cache). An HTTP error, a
 *    network error or a non-wasm content type is reported through `onError` right away, as an
 *    `EngineLoadError` of kind 'download', instead of after the full load timeout.
 */
import { EngineLoadError } from './errors';
import type { DownloadProgress, EngineTransport } from './types';

/** URL of the engine worker script (respects Vite's `base`, e.g. `/chess/`). */
export function engineScriptUrl(): string {
  return `${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`;
}

/** URL of the `.wasm` that a worker script loads: its own URL with `.js` replaced (as the script derives it). */
export function engineWasmUrl(scriptUrl: string = engineScriptUrl()): string {
  const u = new URL(scriptUrl, typeof location === 'undefined' ? 'http://localhost/' : location.href);
  u.search = '';
  u.hash = '';
  u.pathname = u.pathname.replace(/\.js$/i, '.wasm');
  return u.href;
}

/**
 * True when this browser can run the engine: Web Workers + WebAssembly with SIMD128
 * (Safari/iOS 16.4+). Probe module from wasm-feature-detect.
 */
export function engineSupported(): boolean {
  try {
    return (
      typeof Worker === 'function' &&
      typeof WebAssembly === 'object' &&
      WebAssembly.validate(
        new Uint8Array([
          0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
        ]),
      )
    );
  } catch {
    return false;
  }
}

export interface WorkerTransportOptions {
  /** Silence (no output, no download progress) before the `.wasm` is probed. Doubles after each good probe. Default 3000 ms. */
  probeAfterMs?: number;
}

/**
 * Spawns the engine worker. Lines emitted before a listener is attached are buffered.
 * Worker `error` events (missing script, uncaught engine abort) and failed `.wasm` probes are
 * reported via `onError`. A compile failure of a good `.wasm` still fires nothing, so callers
 * need a load timeout.
 */
export function createWorkerTransport(url: string = engineScriptUrl(), opts: WorkerTransportOptions = {}): EngineTransport {
  const worker = new Worker(url); // classic worker: the script uses importScripts-style globals
  const lineListeners: ((line: string) => void)[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  const progressListeners: ((progress: DownloadProgress) => void)[] = [];
  let buffered: string[] = [];
  let pendingError: Error | null = null;
  let lastProgress: DownloadProgress | null = null;
  let closed = false;
  /** The engine printed something: it has loaded, stop watching the download. */
  let spoke = false;
  /** Last sign of life while loading (output or download progress). */
  let lastSign = Date.now();

  const emitLine = (line: string) => {
    if (lineListeners.length === 0) buffered.push(line);
    else for (const cb of lineListeners) cb(line);
  };
  const emitError = (error: Error) => {
    if (errorListeners.length === 0) pendingError = error;
    else for (const cb of errorListeners) cb(error);
  };

  // .wasm download progress: the vendored script posts {loaded, total, percent, …} to this port
  // and closes its end once complete.
  let port: MessagePort | null = null;
  const closePort = () => {
    port?.close();
    port = null;
  };
  try {
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (e: MessageEvent) => {
      const d = e.data as { loaded?: unknown; total?: unknown } | null;
      if (closed || !d || typeof d.loaded !== 'number' || typeof d.total !== 'number') return;
      lastSign = Date.now();
      const p: DownloadProgress = { loaded: d.loaded, total: Math.max(d.total, d.loaded) };
      lastProgress = p;
      for (const cb of progressListeners) cb(p);
      if (p.loaded >= p.total) closePort();
    };
    worker.postMessage({ progressPort: channel.port2 }, [channel.port2]);
  } catch {
    closePort(); // no progress reporting: the load timeout still applies
  }

  // A failed .wasm fetch is invisible from here (the worker only logs it): if the worker stays
  // silent, look at the .wasm ourselves.
  let probeDelay = opts.probeAfterMs ?? 3000;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  const checkQuiet = () => {
    probeTimer = null;
    if (closed || spoke) return;
    const quiet = Date.now() - lastSign;
    if (quiet < probeDelay) {
      probeTimer = setTimeout(checkQuiet, probeDelay - quiet);
      return;
    }
    void probeWasm(engineWasmUrl(url)).then((problem) => {
      if (closed || spoke) return;
      if (problem) {
        emitError(new EngineLoadError(problem, 'download'));
        return;
      }
      lastSign = Date.now();
      probeDelay *= 2;
      probeTimer = setTimeout(checkQuiet, probeDelay);
    });
  };
  probeTimer = setTimeout(checkQuiet, probeDelay);
  const stopWatching = () => {
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
    closePort();
  };

  worker.onmessage = (e: MessageEvent) => {
    if (closed || typeof e.data !== 'string') return;
    if (!spoke) {
      spoke = true;
      stopWatching();
    }
    for (const raw of e.data.split('\n')) {
      const line = raw.trimEnd();
      if (line) emitLine(line);
    }
  };
  worker.onerror = (e: ErrorEvent) => {
    e.preventDefault();
    if (closed) return;
    // A worker script that could not be fetched fires a bare error event (no message); an
    // engine abort carries one.
    emitError(
      e.message
        ? new EngineLoadError(`Engine worker error: ${e.message}`, 'crash')
        : new EngineLoadError('Engine worker error: failed to load the worker script', spoke ? 'crash' : 'download'),
    );
  };
  worker.onmessageerror = () => {
    if (!closed) emitError(new EngineLoadError('Engine worker message could not be deserialised', 'crash'));
  };

  return {
    post(command: string) {
      if (!closed) worker.postMessage(command);
    },
    onLine(callback) {
      lineListeners.push(callback);
      if (buffered.length) {
        const lines = buffered;
        buffered = [];
        for (const line of lines) callback(line);
      }
    },
    onError(callback) {
      errorListeners.push(callback);
      if (pendingError) {
        const err = pendingError;
        pendingError = null;
        callback(err);
      }
    },
    onProgress(callback) {
      progressListeners.push(callback);
      if (lastProgress && !spoke) callback(lastProgress);
    },
    terminate() {
      if (closed) return;
      closed = true;
      stopWatching();
      try {
        worker.postMessage('quit');
      } catch {
        /* ignore */
      }
      worker.terminate();
    },
  };
}

/**
 * Fetches the `.wasm` from the main thread (headers only; the body is cancelled) and returns
 * what is wrong with it, or null when it looks downloadable.
 */
async function probeWasm(wasmUrl: string): Promise<string | null> {
  if (typeof fetch !== 'function') return null;
  let res: Response;
  try {
    res = await fetch(wasmUrl, { credentials: 'same-origin' });
  } catch (e) {
    return `Could not download the chess engine (${e instanceof Error ? e.message : String(e)})`;
  }
  void res.body?.cancel().catch(() => undefined);
  if (!res.ok) return `Could not download the chess engine: HTTP ${res.status} for ${wasmUrl}`;
  const type = res.headers.get('content-type');
  // WebAssembly.instantiateStreaming (used by the worker) rejects anything but application/wasm.
  if (type && !/wasm/i.test(type)) return `The chess engine file is served as "${type}" instead of application/wasm`;
  return null;
}
