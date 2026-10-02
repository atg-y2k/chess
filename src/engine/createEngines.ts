/**
 * Creates the app's engines: an analysis engine (Hash 32, WDL, full strength) and a bot engine
 * (Hash 16). Falls back to ONE shared worker via EngineMux (bot searches take priority and
 * transparently pause/resume analysis) when:
 *  - `?engines=1` is in the URL or `forceSingle` is passed,
 *  - the second worker fails to initialise,
 *  - the previous dual boot looks like it was killed. WebKit can spike memory while
 *    OMG-compiling this Asyncify build (bug 304810), and iOS jetsams the page. A boot flag is
 *    written before the second worker spawns and cleared once the dual setup has run ~20 s
 *    in the foreground, or when the engines are terminated. It is only kept while the page is
 *    visible: hiding or unloading the page clears it (a backgrounded app that iOS evicts later
 *    was not killed by the engines), and coming back during that window sets it again. If the
 *    flag is still there on the next start, single mode is remembered for 14 days, after which
 *    two engines are tried again. `?engines=2` or `resetEngineMode()` clears that decision.
 */
import { START_FEN } from '../chess/utils';
import { createEngineMux } from './EngineMux';
import { EngineLoadError } from './errors';
import { StockfishEngine } from './StockfishEngine';
import type { ChessEngine, DownloadProgress, EngineTransport } from './types';
import { createWorkerTransport } from './workerTransport';

export interface EngineSet {
  analysis: ChessEngine;
  bot: ChessEngine;
  mode: 'dual' | 'single';
  terminate(): void;
}

/** Minimal event source (document / window). */
export interface LifecycleTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Where the crash heuristic learns that the page was hidden or unloaded. */
export interface PageLifecycle {
  /** Fires `visibilitychange` and has `visibilityState` (the document). */
  document: LifecycleTarget & { readonly visibilityState: string };
  /** Fires `pagehide` (the window). */
  window: LifecycleTarget;
}

/** `.wasm` download progress of one engine. */
export interface EngineLoadProgress extends DownloadProgress {
  engine: 'analysis' | 'bot';
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface CreateEnginesOptions {
  forceSingle?: boolean;
  /** Download progress of the engines' `.wasm` (browser only), e.g. for the loading screen. */
  onProgress?: (progress: EngineLoadProgress) => void;
  /** Test hook: engine process factory (default: Web Worker). */
  createTransport?: () => EngineTransport;
  /** Test hook: storage for the crash heuristics (default: localStorage; null disables). */
  storage?: KeyValueStore | null;
  /** Test hook: URL query string (default: location.search). */
  query?: string;
  /** How long a dual start must survive before it counts as healthy. Default 20000 ms. */
  healthyAfterMs?: number;
  /** Test hook: page visibility / unload events (default: document and window; null = none). */
  lifecycle?: PageLifecycle | null;
  /** Test hook: clock for the remembered single mode (default: Date.now). */
  now?: () => number;
}

export const ENGINE_BOOT_KEY = 'chesscoach.engineBoot';
/** Remembered single mode: JSON `{ "mode": "single", "at": <ms> }` (older builds wrote plain `single`). */
export const ENGINE_MODE_KEY = 'chesscoach.engineMode';
/** How long single mode is remembered after a dual start that looked killed. */
export const SINGLE_MODE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function defaultStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultLifecycle(): PageLifecycle | null {
  if (typeof document === 'undefined') return null;
  return { document, window: typeof window === 'undefined' ? document : window };
}

/** localStorage access that never throws (private mode, disabled storage). */
function safe(storage: KeyValueStore | null | undefined) {
  return {
    get(key: string): string | null {
      try {
        return storage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        storage?.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    remove(key: string): void {
      try {
        storage?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

type SafeStore = ReturnType<typeof safe>;

function rememberSingle(store: SafeStore, at: number): void {
  store.set(ENGINE_MODE_KEY, JSON.stringify({ mode: 'single', at }));
}

/** When single mode was remembered (ms), or null. A plain `single` from an older build counts from now. */
function rememberedSince(store: SafeStore, now: number): number | null {
  const raw = store.get(ENGINE_MODE_KEY);
  if (raw === null) return null;
  if (raw === 'single') {
    rememberSingle(store, now);
    return now;
  }
  try {
    const v = JSON.parse(raw) as { mode?: unknown; at?: unknown } | null;
    if (v?.mode === 'single' && typeof v.at === 'number' && Number.isFinite(v.at)) return v.at;
  } catch {
    /* not ours */
  }
  store.remove(ENGINE_MODE_KEY);
  return null;
}

/**
 * The remembered single-engine decision (for diagnostics or a settings row): since when, and
 * when two engines will be tried again. Null when nothing is remembered.
 */
export function rememberedEngineMode(
  storage: KeyValueStore | null = defaultStorage(),
  now: number = Date.now(),
): { mode: 'single'; since: number; until: number } | null {
  const since = rememberedSince(safe(storage), now);
  return since === null ? null : { mode: 'single', since, until: since + SINGLE_MODE_TTL_MS };
}

/** Forgets the remembered single-engine decision: the next start tries two engines again. */
export function resetEngineMode(storage: KeyValueStore | null = defaultStorage()): void {
  const store = safe(storage);
  store.remove(ENGINE_MODE_KEY);
  store.remove(ENGINE_BOOT_KEY);
}

/**
 * Creates the analysis engine first, then the bot engine. Resolves once both are initialised
 * (or single mode was chosen). Rejects only if the first engine cannot start at all (with an
 * `EngineLoadError` saying why, when known).
 */
export async function createEngines(opts: CreateEnginesOptions = {}): Promise<EngineSet> {
  const store = safe(opts.storage === undefined ? defaultStorage() : opts.storage);
  const now = opts.now ?? Date.now;
  const query = new URLSearchParams(opts.query ?? (typeof location === 'undefined' ? '' : location.search));
  const param = query.get('engines');
  const factory = opts.createTransport ?? (() => createWorkerTransport());
  const onProgress = opts.onProgress;
  const progress = (engine: EngineLoadProgress['engine']) =>
    onProgress && ((p: DownloadProgress) => onProgress({ engine, loaded: p.loaded, total: p.total }));

  if (param === '2') {
    store.remove(ENGINE_MODE_KEY);
    store.remove(ENGINE_BOOT_KEY);
  } else if (store.get(ENGINE_BOOT_KEY) !== null) {
    // The last dual boot never reported healthy: it was probably killed. Stay single for a while.
    console.warn('[engines] previous dual-engine start did not complete; using one shared engine');
    rememberSingle(store, now());
    store.remove(ENGINE_BOOT_KEY);
  }
  let since = param === '2' ? null : rememberedSince(store, now());
  if (since !== null && now() - since >= SINGLE_MODE_TTL_MS) {
    console.info('[engines] remembered single-engine mode expired; trying two engines again');
    store.remove(ENGINE_MODE_KEY);
    since = null;
  }
  const single = opts.forceSingle === true || param === '1' || since !== null;

  const analysis = new StockfishEngine(factory, { hashMb: 32, showWdl: true, name: 'analysis', onProgress: progress('analysis') });
  try {
    await analysis.init();
  } catch (e) {
    analysis.terminate();
    throw e;
  }
  if (single) return singleSet(analysis);

  const bot = new StockfishEngine(factory, { hashMb: 16, name: 'bot', onProgress: progress('bot') });
  const guard = bootGuard(
    store,
    opts.lifecycle === undefined ? defaultLifecycle() : opts.lifecycle,
    opts.healthyAfterMs ?? 20_000,
    () => !analysis.isDead && !bot.isDead,
  );
  try {
    await bot.init();
  } catch (e) {
    console.warn('[engines] second engine failed to start; using one shared engine', e);
    guard.dispose();
    bot.terminate();
    // A download problem says nothing about memory: use one engine now, try two next time.
    if (!(e instanceof EngineLoadError && e.kind === 'download')) rememberSingle(store, now());
    return singleSet(analysis);
  }

  // Warm both engines up together while the boot flag is set, so a WebKit compile-memory spike
  // (if any) happens now and is attributed to the dual setup.
  void analysis.search(START_FEN, { depth: 10 }).catch(() => undefined);
  void bot.search(START_FEN, { depth: 10 }).catch(() => undefined);
  guard.started();

  return {
    analysis,
    bot,
    mode: 'dual',
    terminate() {
      guard.dispose();
      bot.terminate();
      analysis.terminate();
    },
  };
}

/**
 * The boot flag of a dual start (see the module comment). It is set right away unless the page
 * is hidden, cleared whenever the page is hidden or unloaded, and set again when the page comes
 * back before the start was confirmed healthy: `healthyAfterMs` in the foreground after
 * `started()`, with both engines alive.
 */
function bootGuard(store: SafeStore, page: PageLifecycle | null, healthyAfterMs: number, alive: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let done = false;
  const hidden = () => page?.document.visibilityState === 'hidden';
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    store.remove(ENGINE_BOOT_KEY);
  };
  const arm = () => {
    if (done || hidden()) return;
    store.set(ENGINE_BOOT_KEY, String(Date.now()));
    if (running && !timer) {
      timer = setTimeout(() => {
        timer = null;
        if (alive()) dispose();
      }, healthyAfterMs);
    }
  };
  const onVisibility = () => (hidden() ? disarm() : arm());
  const dispose = () => {
    done = true;
    disarm();
    page?.document.removeEventListener('visibilitychange', onVisibility);
    page?.window.removeEventListener('pagehide', disarm);
  };
  page?.document.addEventListener('visibilitychange', onVisibility);
  page?.window.addEventListener('pagehide', disarm);
  arm();
  return {
    /** Both engines are up: start the healthy countdown (if visible). */
    started() {
      running = true;
      if (hidden()) disarm();
      else arm();
    },
    /** Healthy or shut down on purpose: clear the flag and stop listening. */
    dispose,
  };
}

function singleSet(engine: StockfishEngine): EngineSet {
  const { high, low } = createEngineMux(engine);
  return {
    analysis: low,
    bot: high,
    mode: 'single',
    terminate() {
      high.terminate();
      low.terminate();
      engine.terminate();
    },
  };
}
