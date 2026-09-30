/**
 * Test helper: EngineTransport over the vendored Stockfish WASM build running in a node child
 * process (the build doubles as a UCI command-line engine: stdin in, stdout out).
 *
 * package.json declares `"type": "module"`, so node would load the vendored CommonJS script as
 * ESM and fail. We therefore run a `.cjs` copy (with the `.wasm` beside it, same basename) from
 * the OS temp directory.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineTransport } from '../../src/engine/types';

const ENGINE_DIR = fileURLToPath(new URL('../../public/engine/', import.meta.url));
const BASENAME = 'stockfish-19-lite-single';

let cachedScript: string | null = null;

/** Path of a runnable `.cjs` copy of the engine (created once per engine version). */
export function nodeEngineScript(): string {
  if (cachedScript && existsSync(cachedScript)) return cachedScript;
  const srcJs = join(ENGINE_DIR, `${BASENAME}.js`);
  const srcWasm = join(ENGINE_DIR, `${BASENAME}.wasm`);
  const st = statSync(srcWasm);
  const dir = join(tmpdir(), `chesscoach-sf19-${st.size}-${Math.round(st.mtimeMs)}`);
  const js = join(dir, `${BASENAME}.cjs`);
  const wasm = join(dir, `${BASENAME}.wasm`);
  mkdirSync(dir, { recursive: true });
  for (const [src, dst] of [
    [srcWasm, wasm],
    [srcJs, js],
  ]) {
    if (existsSync(dst)) continue;
    const tmp = `${dst}.${process.pid}.tmp`;
    copyFileSync(src, tmp);
    renameSync(tmp, dst); // atomic: parallel test workers never see a half-written file
  }
  cachedScript = js;
  return js;
}

export interface NodeTransport extends EngineTransport {
  readonly child: ChildProcess;
  onError(callback: (error: Error) => void): void;
  /** Simulates a crash: kills the process WITHOUT marking the transport terminated (onError fires). */
  kill(signal?: NodeJS.Signals): void;
}

/** Spawns a fresh engine process. */
export function createNodeTransport(): NodeTransport {
  const child = spawn(process.execPath, [nodeEngineScript()], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lineListeners: ((line: string) => void)[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  let terminated = false;
  let buf = '';

  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trimEnd();
      buf = buf.slice(i + 1);
      if (line) for (const cb of lineListeners) cb(line);
    }
  });
  child.stdin!.on('error', () => {
    /* EPIPE after the process died: reported via 'exit' */
  });
  const report = (error: Error) => {
    if (terminated) return;
    terminated = true;
    for (const cb of errorListeners) cb(error);
  };
  child.on('exit', (code, signal) => report(new Error(`engine process exited (${signal ?? `code ${code}`})`)));
  child.on('error', (err) => report(err));

  return {
    child,
    post(command: string) {
      if (!terminated && child.stdin!.writable) child.stdin!.write(`${command}\n`);
    },
    onLine(callback) {
      lineListeners.push(callback);
    },
    onError(callback) {
      errorListeners.push(callback);
    },
    terminate() {
      if (terminated) return;
      terminated = true;
      child.kill('SIGKILL');
    },
    kill(signal: NodeJS.Signals = 'SIGKILL') {
      child.kill(signal);
    },
  };
}
