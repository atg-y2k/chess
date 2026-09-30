import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// src/pwa.ts imports the plugin's virtual module, which only exists inside a Vite build.
vi.mock('virtual:pwa-register', () => ({ registerSW: vi.fn() }));

import {
  createRegistrationKeeper,
  createReloadGate,
  type KeeperRegistration,
  type KeeperWorker,
  type RegisterServiceWorkerOptions,
  type ReloadGatePage,
} from '../../src/pwa';

/** A minimal `document`: visibility plus event listeners. */
class FakePage implements ReloadGatePage {
  visibilityState: DocumentVisibilityState = 'visible';
  readonly listeners = new Map<string, Map<() => void, AddEventListenerOptions | undefined>>();
  addEventListener(type: string, listener: () => void, options?: AddEventListenerOptions): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Map());
    this.listeners.get(type)!.set(listener, options);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const l of [...(this.listeners.get(type)?.keys() ?? [])]) l();
  }
  count(): number {
    let n = 0;
    for (const m of this.listeners.values()) n += m.size;
    return n;
  }
  hide(): void {
    this.visibilityState = 'hidden';
    this.fire('visibilitychange');
  }
  show(): void {
    this.visibilityState = 'visible';
    this.fire('visibilitychange');
  }
}

describe('createReloadGate', () => {
  let page: FakePage;
  let allowed: boolean;
  let reload: ReturnType<typeof vi.fn<() => void>>;
  const gate = (pollMs = 1000) => createReloadGate(() => allowed, reload, { page, pollMs });

  beforeEach(() => {
    vi.useFakeTimers();
    page = new FakePage();
    allowed = true;
    reload = vi.fn<() => void>();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reloads at once when allowed and the page has not been touched', () => {
    const g = gate();
    g.request();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(g.pending()).toBe(false);
  });

  it('never reloads a visible page the user has touched (e.g. choosing an opponent)', () => {
    const g = gate();
    page.fire('pointerdown'); // picked a bot in the New game sheet
    g.request();
    vi.advanceTimersByTime(60_000);
    expect(reload).not.toHaveBeenCalled();
    expect(g.pending()).toBe(true);
    page.hide(); // switched to another app
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('counts touches made before the update arrived', () => {
    const g = gate();
    page.fire('touchstart');
    vi.advanceTimersByTime(2000);
    g.request();
    expect(reload).not.toHaveBeenCalled();
  });

  it('counts key presses as use', () => {
    const g = gate();
    page.fire('keydown');
    g.request();
    expect(reload).not.toHaveBeenCalled();
  });

  it('waits for canReloadNow while the page is untouched, re-checking on the poll', () => {
    allowed = false; // game in progress
    const g = gate(1000);
    g.request();
    vi.advanceTimersByTime(5000);
    expect(reload).not.toHaveBeenCalled();
    allowed = true;
    vi.advanceTimersByTime(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload a hidden page while canReloadNow is false', () => {
    allowed = false;
    const g = gate();
    page.fire('pointerdown');
    g.request();
    page.hide();
    vi.advanceTimersByTime(10_000);
    expect(reload).not.toHaveBeenCalled();
    allowed = true;
    vi.advanceTimersByTime(1000); // the poll picks up the change while the page is still hidden
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('treats a page brought back to the front as untouched', () => {
    allowed = false;
    const g = gate();
    page.fire('pointerdown');
    g.request();
    page.hide();
    allowed = true;
    page.show(); // resumed: nothing touched yet, so the update may load now
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting after a resume once the user touches the page', () => {
    allowed = false;
    const g = gate();
    g.request();
    page.hide();
    page.show();
    page.fire('pointerdown');
    allowed = true;
    vi.advanceTimersByTime(30_000);
    expect(reload).not.toHaveBeenCalled();
    page.hide();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload if canReloadNow throws', () => {
    const g = createReloadGate(
      () => {
        throw new Error('boom');
      },
      reload,
      { page, pollMs: 1000 },
    );
    g.request();
    vi.advanceTimersByTime(5000);
    page.hide();
    expect(reload).not.toHaveBeenCalled();
    expect(g.pending()).toBe(true);
  });

  it('reloadNow ignores every condition, once', () => {
    allowed = false;
    const g = gate();
    page.fire('pointerdown');
    g.request();
    g.reloadNow();
    g.reloadNow();
    g.request();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(g.pending()).toBe(false);
  });

  it('removes its listeners once it has reloaded or is disposed', () => {
    const g1 = gate();
    expect(page.count()).toBe(4); // pointerdown, touchstart, keydown, visibilitychange
    g1.request();
    expect(page.count()).toBe(0);

    const g2 = gate();
    allowed = false;
    g2.request();
    g2.dispose();
    expect(page.count()).toBe(0);
    allowed = true;
    g2.request();
    vi.advanceTimersByTime(10_000);
    expect(reload).toHaveBeenCalledTimes(1); // only g1's
    expect(g2.pending()).toBe(false);
  });

  it('listens to input passively in the capture phase (never delays or blocks a tap)', () => {
    gate();
    for (const type of ['pointerdown', 'touchstart', 'keydown']) {
      const opts = [...(page.listeners.get(type)?.values() ?? [])][0];
      expect(opts).toMatchObject({ capture: true, passive: true });
    }
  });

  it('only depends on canReloadNow without a page (node)', () => {
    allowed = false;
    const g = createReloadGate(() => allowed, reload, { pollMs: 1000 });
    g.request();
    expect(reload).not.toHaveBeenCalled();
    allowed = true;
    vi.advanceTimersByTime(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

/** A service worker that moves through its states on demand. */
class FakeWorker implements KeeperWorker {
  readonly listeners = new Set<() => void>();
  constructor(public state: ServiceWorkerState = 'installing') {}
  addEventListener(_type: 'statechange', listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'statechange', listener: () => void): void {
    this.listeners.delete(listener);
  }
  set(state: ServiceWorkerState): void {
    this.state = state;
    for (const l of [...this.listeners]) l();
  }
}

const SCOPE = 'https://example.test/chess/';

class FakeRegistration implements KeeperRegistration {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  readonly update = vi.fn(async () => {});
  constructor(readonly scope = SCOPE) {}
}

/**
 * The browser side of `navigator.serviceWorker`: `register()` starts a first install, and a failed
 * first install deletes the registration, as the Service Workers spec requires.
 */
class FakeServiceWorkers {
  current: FakeRegistration | undefined;
  constructor(readonly scope = SCOPE) {}
  readonly getRegistration = vi.fn(async () => this.current);
  readonly register = vi.fn(async (): Promise<KeeperRegistration | undefined> => {
    if (this.current?.active) return this.current; // a returning visit
    const reg = new FakeRegistration(this.scope);
    reg.installing = new FakeWorker();
    this.current = reg;
    return reg;
  });
  /** A precache download failed: the first install fails and the registration is deleted. */
  failInstall(): void {
    const reg = this.current!;
    this.current = undefined;
    reg.installing!.set('redundant');
  }
  /** The first install completed and the worker activated. */
  completeInstall(): void {
    const reg = this.current!;
    const sw = reg.installing!;
    reg.installing = null;
    reg.active = sw;
    sw.set('installed');
    sw.set('activated');
  }
  /** An installed app from an earlier visit. */
  installed(): FakeRegistration {
    const reg = new FakeRegistration(this.scope);
    reg.active = new FakeWorker('activated');
    this.current = reg;
    return reg;
  }
}

describe('createRegistrationKeeper', () => {
  let sw: FakeServiceWorkers;
  let online: boolean;
  let onReady: ReturnType<typeof vi.fn<() => void>>;
  const keeper = () =>
    createRegistrationKeeper({
      scope: SCOPE,
      getRegistration: sw.getRegistration,
      register: sw.register,
      onReady,
      online: () => online,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    sw = new FakeServiceWorkers();
    online = true;
    onReady = vi.fn<() => void>();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers at startup and reports offline-ready once the first install completes', async () => {
    const k = keeper();
    await k.start();
    expect(sw.register).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled();
    sw.completeInstall();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('reports an app installed on an earlier visit as offline-ready at startup', async () => {
    sw.installed();
    await keeper().start();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('registers again at the next check when a failed first install deleted the registration', async () => {
    const k = keeper();
    await k.start();
    sw.failInstall(); // e.g. the connection dropped while the engine downloaded
    await k.check(); // back online a few seconds after launch: no 60 s wait for this
    expect(sw.register).toHaveBeenCalledTimes(2);
    sw.completeInstall();
    expect(onReady).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_600_000); // no retry is left pending
    expect(sw.register).toHaveBeenCalledTimes(2);
  });

  it('retries a failed first install by itself, backing off (a failure the user never saw)', async () => {
    const k = keeper();
    await k.start();
    sw.failInstall(); // one icon failed to download: no error on screen
    await vi.advanceTimersByTimeAsync(29_000);
    expect(sw.register).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sw.register).toHaveBeenCalledTimes(2);
    sw.failInstall();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sw.register).toHaveBeenCalledTimes(2); // now waits 60 s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sw.register).toHaveBeenCalledTimes(3);
    sw.completeInstall();
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('retries when registering failed (e.g. sw.js could not be fetched)', async () => {
    sw.register.mockResolvedValueOnce(undefined);
    const k = keeper();
    await k.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sw.register).toHaveBeenCalledTimes(2);
  });

  it('notices a first install that failed before it could be followed', async () => {
    sw.register.mockImplementationOnce(async () => {
      const reg = new FakeRegistration();
      reg.installing = new FakeWorker('redundant');
      return reg;
    });
    await keeper().start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sw.register).toHaveBeenCalledTimes(2);
  });

  it('shares one registration between overlapping checks (online + visible at once)', async () => {
    const k = keeper();
    await k.start();
    sw.failInstall();
    await Promise.all([k.check(), k.check(), k.check(true)]);
    expect(sw.register).toHaveBeenCalledTimes(2);
  });

  it('does not register a second time while the first registration is under way', async () => {
    const k = keeper();
    const started = k.start();
    await k.check();
    await started;
    expect(sw.register).toHaveBeenCalledTimes(1);
  });

  it('updates a healthy registration instead of registering again, at most once a minute unless forced', async () => {
    const reg = sw.installed();
    const k = keeper();
    await k.start();
    await k.check();
    expect(reg.update).not.toHaveBeenCalled(); // registering just checked
    await vi.advanceTimersByTimeAsync(61_000);
    await k.check();
    expect(reg.update).toHaveBeenCalledTimes(1);
    await k.check();
    expect(reg.update).toHaveBeenCalledTimes(1);
    await k.check(true); // the hourly check
    expect(reg.update).toHaveBeenCalledTimes(2);
    expect(sw.register).toHaveBeenCalledTimes(1);
  });

  it('does not look for an update while one is installing', async () => {
    const reg = sw.installed();
    const k = keeper();
    await k.start();
    reg.installing = new FakeWorker();
    await k.check(true);
    expect(reg.update).not.toHaveBeenCalled();
    expect(sw.register).toHaveBeenCalledTimes(1);
  });

  it('keeps quiet offline and registers once back online', async () => {
    const k = keeper();
    await k.start();
    sw.failInstall();
    online = false;
    await k.check();
    await vi.advanceTimersByTimeAsync(30_000); // the retry finds the browser offline
    expect(sw.register).toHaveBeenCalledTimes(1);
    online = true;
    await k.check(); // the 'online' event
    expect(sw.register).toHaveBeenCalledTimes(2);
  });

  it("ignores another app's registration at the origin root", async () => {
    const k = keeper();
    await k.start();
    sw.failInstall();
    const other = new FakeRegistration('https://example.test/');
    other.active = new FakeWorker('activated');
    sw.getRegistration.mockResolvedValueOnce(other);
    await k.check();
    expect(other.update).not.toHaveBeenCalled();
    expect(sw.register).toHaveBeenCalledTimes(2);
  });

  it('survives getRegistration or update rejecting', async () => {
    const reg = sw.installed();
    const k = keeper();
    await k.start();
    sw.getRegistration.mockRejectedValueOnce(new Error('InvalidStateError'));
    await k.check(true);
    reg.update.mockRejectedValueOnce(new Error('offline'));
    await k.check(true);
    await k.check(true);
    expect(reg.update).toHaveBeenCalledTimes(2);
  });
});

describe('registerServiceWorker', () => {
  type Listener = () => void;
  const on = (listeners: Map<string, Listener[]>) => (type: string, l: Listener) => {
    listeners.set(type, [...(listeners.get(type) ?? []), l]);
  };
  const fire = (listeners: Map<string, Listener[]>, type: string) => {
    for (const l of listeners.get(type) ?? []) l();
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('registers again when back online after a failed first install, and still reloads onto updates', async () => {
    vi.useFakeTimers();
    vi.resetModules(); // a fresh module: it registers only once per page load
    const { registerServiceWorker } = await import('../../src/pwa');
    const { registerSW } = await import('virtual:pwa-register');
    const sw = new FakeServiceWorkers('https://example.test/'); // BASE_URL is '/' in tests
    const windowListeners = new Map<string, Listener[]>();
    const documentListeners = new Map<string, Listener[]>();
    const reload = vi.fn();
    vi.stubGlobal('window', {
      isSecureContext: true,
      location: { href: 'https://example.test/', reload },
      addEventListener: on(windowListeners),
    });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: on(documentListeners),
      removeEventListener: () => {},
    });
    vi.stubGlobal('navigator', { onLine: true, serviceWorker: { getRegistration: sw.getRegistration } });
    const calls: Parameters<typeof registerSW>[0][] = [];
    vi.mocked(registerSW).mockImplementation((options = {}) => {
      calls.push(options);
      void sw.register().then((reg) => options.onRegisteredSW?.('/sw.js', reg as unknown as ServiceWorkerRegistration));
      return async () => {};
    });
    const onOfflineReady = vi.fn();
    const options: RegisterServiceWorkerOptions = { canReloadNow: () => true, onOfflineReady };

    registerServiceWorker(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    sw.failInstall(); // the engine download failed: error screen, then the app recovers online
    fire(windowListeners, 'online');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    expect(sw.getRegistration).toHaveBeenCalledWith('https://example.test/');

    // The new registration's workbox-window instance reports as usual.
    calls[1]!.onOfflineReady?.();
    sw.completeInstall();
    expect(onOfflineReady).toHaveBeenCalledTimes(1);
    calls[1]!.onNeedReload?.(); // a later update took over; the page is untouched
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a lazy chunk that fails while an update waits reloads even on a touched page, never over a game', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { registerServiceWorker } = await import('../../src/pwa');
    const { registerSW } = await import('virtual:pwa-register');
    const sw = new FakeServiceWorkers('https://example.test/');
    const windowListeners = new Map<string, Listener[]>();
    const documentListeners = new Map<string, Listener[]>();
    const reload = vi.fn();
    vi.stubGlobal('window', {
      isSecureContext: true,
      location: { href: 'https://example.test/', reload },
      addEventListener: on(windowListeners),
    });
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: on(documentListeners),
      removeEventListener: () => {},
    });
    vi.stubGlobal('navigator', { onLine: true, serviceWorker: { getRegistration: sw.getRegistration } });
    const calls: Parameters<typeof registerSW>[0][] = [];
    vi.mocked(registerSW).mockImplementation((options = {}) => {
      calls.push(options);
      void sw.register().then((reg) => options.onRegisteredSW?.('/sw.js', reg as unknown as ServiceWorkerRegistration));
      return async () => {};
    });
    let playing = true;
    registerServiceWorker({ canReloadNow: () => !playing });
    await vi.advanceTimersByTimeAsync(0);

    fire(windowListeners, 'vite:preloadError'); // no update waiting: an ordinary failure
    fire(documentListeners, 'pointerdown'); // the user is using the page
    calls[0]!.onNeedReload?.();
    fire(windowListeners, 'vite:preloadError'); // a game is in progress
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reload).not.toHaveBeenCalled();

    playing = false; // the game is over, but the page is still in use: the gate alone would wait
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reload).not.toHaveBeenCalled();
    fire(windowListeners, 'vite:preloadError');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
