/**
 * Creates the app's engines: an analysis engine (Hash 32, WDL, full strength) and a bot engine
 * (Hash 16). Falls back to ONE shared worker via EngineMux (bot searches take priority and
 * transparently pause/resume analysis) when:
 *  - `?engines=1` is in the URL or `forceSingle` is passed,
 *  - the second worker fails to initialise,
 *  - the previous dual boot looks like it was killed. WebKit can spike memory while
 *    OMG-compiling this Asyncify build (bug 304810), and iOS jetsams the page. A boot flag is
 *    written before the second worker spawns and cleared once the dual setup has run
 *    ~20 s (or the page is hidden / engines are terminated). If the flag is still there on
 *    the next start, single mode is persisted. `?engines=2` clears that decision.
 */
import { START_FEN } from '../chess/utils';
import { createEngineMux } from './EngineMux';
import { StockfishEngine } from './StockfishEngine';
import type { ChessEngine, EngineTransport } from './types';
import { createWorkerTransport } from './workerTransport';

export interface EngineSet {
  analysis: ChessEngine;
  bot: ChessEngine;
  mode: 'dual' | 'single';
  terminate(): void;
}

export interface CreateEnginesOptions {
  forceSingle?: boolean;
  /** Test hook: engine process factory (default: Web Worker). */
  createTransport?: () => EngineTransport;
  /** Test hook: storage for the crash heuristics (default: localStorage; null disables). */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** Test hook: URL query string (default: location.search). */
  query?: string;
  /** How long a dual start must survive before it counts as healthy. Default 20000 ms. */
  healthyAfterMs?: number;
}

export const ENGINE_BOOT_KEY = 'chesscoach.engineBoot';
export const ENGINE_MODE_KEY = 'chesscoach.engineMode';

function defaultStorage(): CreateEnginesOptions['storage'] {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** localStorage access that never throws (private mode, disabled storage). */
function safe(storage: CreateEnginesOptions['storage']) {
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

/**
 * Creates the analysis engine first, then the bot engine. Resolves once both are initialised
 * (or single mode was chosen). Rejects only if the first engine cannot start at all.
 */
export async function createEngines(opts: CreateEnginesOptions = {}): Promise<EngineSet> {
  const store = safe(opts.storage === undefined ? defaultStorage() : opts.storage);
  const query = new URLSearchParams(opts.query ?? (typeof location === 'undefined' ? '' : location.search));
  const param = query.get('engines');
  const factory = opts.createTransport ?? (() => createWorkerTransport());

  if (param === '2') {
    store.remove(ENGINE_MODE_KEY);
    store.remove(ENGINE_BOOT_KEY);
  } else if (store.get(ENGINE_BOOT_KEY) !== null) {
    // The last dual boot never reported healthy: it was probably killed. Stay single from now on.
    console.warn('[engines] previous dual-engine start did not complete; using one shared engine');
    store.set(ENGINE_MODE_KEY, 'single');
    store.remove(ENGINE_BOOT_KEY);
  }
  const single =
    opts.forceSingle === true || param === '1' || (param !== '2' && store.get(ENGINE_MODE_KEY) === 'single');

  const analysis = new StockfishEngine(factory, { hashMb: 32, showWdl: true, name: 'analysis' });
  try {
    await analysis.init();
  } catch (e) {
    analysis.terminate();
    throw e;
  }
  if (single) return singleSet(analysis);

  store.set(ENGINE_BOOT_KEY, String(Date.now()));
  const bot = new StockfishEngine(factory, { hashMb: 16, name: 'bot' });
  try {
    await bot.init();
  } catch (e) {
    console.warn('[engines] second engine failed to start; using one shared engine', e);
    bot.terminate();
    store.set(ENGINE_MODE_KEY, 'single');
    store.remove(ENGINE_BOOT_KEY);
    return singleSet(analysis);
  }

  // Warm both engines up together while the boot flag is set, so a WebKit compile-memory spike
  // (if any) happens now and is attributed to the dual setup.
  void analysis.search(START_FEN, { depth: 10 }).catch(() => undefined);
  void bot.search(START_FEN, { depth: 10 }).catch(() => undefined);

  let healthyTimer: ReturnType<typeof setTimeout> | null = null;
  const markHealthy = () => {
    if (healthyTimer) clearTimeout(healthyTimer);
    healthyTimer = null;
    store.remove(ENGINE_BOOT_KEY);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') markHealthy();
  };
  healthyTimer = setTimeout(() => {
    if (!analysis.isDead && !bot.isDead) markHealthy();
  }, opts.healthyAfterMs ?? 20_000);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  return {
    analysis,
    bot,
    mode: 'dual',
    terminate() {
      markHealthy();
      bot.terminate();
      analysis.terminate();
    },
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
