/**
 * EngineTransport over a classic Web Worker running the vendored Stockfish 19 lite
 * single-threaded WASM build (public/engine/). The worker posts every output line as a plain
 * string; the `.wasm` is fetched from the same directory with the same basename.
 */
import type { EngineTransport } from './types';

/** URL of the engine worker script (respects Vite's `base`, e.g. `/chess/`). */
export function engineScriptUrl(): string {
  return `${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`;
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

/**
 * Spawns the engine worker. Lines emitted before a listener is attached are buffered.
 * Worker `error` events (missing script, uncaught engine abort) are reported via `onError`;
 * a WASM fetch/compile failure fires no event, so callers need a load timeout.
 */
export function createWorkerTransport(url: string = engineScriptUrl()): EngineTransport {
  const worker = new Worker(url); // classic worker: the script uses importScripts-style globals
  const lineListeners: ((line: string) => void)[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  let buffered: string[] = [];
  let pendingError: Error | null = null;
  let closed = false;

  const emitLine = (line: string) => {
    if (lineListeners.length === 0) buffered.push(line);
    else for (const cb of lineListeners) cb(line);
  };
  const emitError = (error: Error) => {
    if (errorListeners.length === 0) pendingError = error;
    else for (const cb of errorListeners) cb(error);
  };

  worker.onmessage = (e: MessageEvent) => {
    if (closed || typeof e.data !== 'string') return; // e.g. download-progress objects
    for (const raw of e.data.split('\n')) {
      const line = raw.trimEnd();
      if (line) emitLine(line);
    }
  };
  worker.onerror = (e: ErrorEvent) => {
    e.preventDefault();
    if (closed) return;
    emitError(new Error(`Engine worker error: ${e.message || 'failed to load the worker script'}`));
  };
  worker.onmessageerror = () => {
    if (!closed) emitError(new Error('Engine worker message could not be deserialised'));
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
    terminate() {
      if (closed) return;
      closed = true;
      try {
        worker.postMessage('quit');
      } catch {
        /* ignore */
      }
      worker.terminate();
    },
  };
}
