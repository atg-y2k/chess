import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// src/pwa.ts imports the plugin's virtual module, which only exists inside a Vite build.
vi.mock('virtual:pwa-register', () => ({ registerSW: vi.fn() }));

import { createReloadGate, type ReloadGatePage } from '../../src/pwa';

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
