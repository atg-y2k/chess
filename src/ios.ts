/**
 * iOS Safari / Home Screen web app integration.
 *
 * - Pinch zoom: Safari ignores `user-scalable=no`, so WebKit's proprietary `gesture*` events are
 *   cancelled instead.
 * - Double-tap zoom: `touch-action: manipulation` (src/styles/app.css) covers most of the page; a
 *   quick second tap on a non-interactive element is also cancelled here. Taps on controls and on
 *   the board are never touched, so rapid button taps keep working.
 * - Audio: iOS only starts Web Audio inside a user gesture, so `onFirstGesture` runs in the first
 *   touchend/click/keydown.
 * - Storage: asks for persistent storage so iOS does not evict the saved game and profile.
 *
 * Every function is a safe no-op outside a browser.
 */

export interface IosGuardOptions {
  /**
   * Runs synchronously inside the first user gesture (touchend, click or keydown); unlock Web Audio
   * here. Return `false` to be called again on the next gesture (e.g. the AudioContext is still
   * suspended because the first touch was a drag).
   */
  onFirstGesture?: () => void | boolean;
  /** Ask for persistent storage: 'auto' (default) only on iOS or in an installed app. */
  persistStorage?: boolean | 'auto';
}

/** Two taps closer together than this count as a double tap. */
const DOUBLE_TAP_MS = 350;
/** ...and closer together than this (CSS px). */
const DOUBLE_TAP_PX = 40;
/** Taps inside these elements are left alone (they need their clicks, or handle touch themselves). */
const INTERACTIVE =
  'a, button, input, select, textarea, label, summary, video, audio, [role="button"], [role="link"], ' +
  '[role="slider"], [role="tab"], [role="option"], [role="menuitem"], [role="checkbox"], [role="switch"], ' +
  '[tabindex], [contenteditable], .cg-wrap';

/**
 * Installs the iOS guards (zoom blocking, first-gesture hook, persistent storage request).
 * Call once at startup. Returns a function that removes the listeners again.
 */
export function installIosGuards(opts: IosGuardOptions = {}): () => void {
  if (typeof document === 'undefined') return () => {};
  const off: (() => void)[] = [];
  const on = <K extends keyof DocumentEventMap>(
    type: K,
    fn: (e: DocumentEventMap[K]) => void,
    options: AddEventListenerOptions,
  ): void => {
    document.addEventListener(type, fn, options);
    off.push(() => document.removeEventListener(type, fn, options));
  };
  const prevent = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };

  // Pinch zoom (WebKit GestureEvent; not in the TS DOM lib, hence the string types).
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, prevent, { passive: false });
    off.push(() => document.removeEventListener(type, prevent));
  }

  // Double-tap zoom on non-interactive elements: a second single-finger tap soon after and close
  // to the previous one.
  let last = { time: Number.NEGATIVE_INFINITY, x: 0, y: 0 };
  on(
    'touchend',
    (e) => {
      const touch = e.changedTouches[0];
      if (!touch || e.touches.length > 0) return;
      const tap = { time: e.timeStamp, x: touch.clientX, y: touch.clientY };
      const double = tap.time - last.time < DOUBLE_TAP_MS && Math.hypot(tap.x - last.x, tap.y - last.y) < DOUBLE_TAP_PX;
      last = tap;
      if (double && !isInteractive(e.target)) prevent(e);
    },
    { passive: false },
  );
  on(
    'dblclick',
    (e) => {
      if (!isInteractive(e.target)) prevent(e);
    },
    { passive: false },
  );

  // First user gesture (audio unlock).
  const cb = opts.onFirstGesture;
  if (cb) {
    const gestureOff: (() => void)[] = [];
    const handler = (): void => {
      let again = false;
      try {
        again = cb() === false;
      } catch (err) {
        console.warn('[ios] onFirstGesture failed', err);
      }
      if (!again) for (const f of gestureOff.splice(0)) f();
    };
    for (const type of ['touchend', 'click', 'keydown'] as const) {
      const options = { capture: true, passive: true };
      document.addEventListener(type, handler, options);
      const remove = (): void => document.removeEventListener(type, handler, options);
      gestureOff.push(remove);
      off.push(remove);
    }
  }

  const persist = opts.persistStorage ?? 'auto';
  if (persist === true || (persist === 'auto' && (isIos() || isStandalone()))) {
    void requestPersistence();
  }

  return () => {
    for (const f of off.splice(0)) f();
  };
}

/** True when running as an installed app (Home Screen / standalone display mode). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || (window.matchMedia?.('(display-mode: standalone)').matches ?? false);
}

/** True on iPhone / iPad (iPadOS reports a Mac user agent but has a touch screen). */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent ?? '';
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
}

function isInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(INTERACTIVE)) return true;
  // Custom clickable elements usually say so with a pointer cursor.
  return getComputedStyle(target).cursor === 'pointer';
}

/**
 * Asks the browser not to evict our storage (saved game, settings, profile). Only done on iOS and
 * in installed apps by default, because desktop Firefox shows a permission prompt for it.
 */
async function requestPersistence(): Promise<void> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
    if (!storage || typeof storage.persist !== 'function') return;
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return;
    await storage.persist();
  } catch {
    /* unsupported or denied: storage stays best-effort */
  }
}
