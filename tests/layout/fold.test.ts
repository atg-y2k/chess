import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FOLD_SETTING,
  FOLD,
  FOLD_SETTING_KEY,
  NO_FOLD_LAYOUT,
  assumedFold,
  chooseFoldLayout,
  detectFold,
  foldFromSegments,
  isFoldableInner,
  loadFoldSetting,
  saveFoldSetting,
  watchFold,
  type FoldEnvironment,
  type FoldInfo,
  type Insets,
} from '../../src/layout/fold';

const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
/** The App Store app's WKWebView (no "Safari" or "Version"). */
const UA_WKWEBVIEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
/** Safari on an iPad (and maybe on the Duo's inner display): the desktop user agent, with touch. */
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const UA_CHROME_DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** Safari keeps screen.width/height in portrait, whatever the orientation. */
function env(over: Partial<FoldEnvironment> & { window: FoldEnvironment['window'] }): FoldEnvironment {
  return {
    userAgent: UA_IPHONE,
    maxTouchPoints: 5,
    screen: { width: 626, height: 890 },
    segments: null,
    posture: null,
    ...over,
  };
}

const INNER_L = { width: 890, height: 626 };
const INNER_P = { width: 626, height: 890 };
/** The Duo's open state: the system UI along the right edge. */
const BOOK_INSETS: Insets = { top: 0, right: 56, bottom: 20, left: 0 };

describe('fold detection', () => {
  it('finds the inner display by its size: the heuristic fold across the middle of the long side', () => {
    const landscape = detectFold(env({ window: INNER_L }));
    expect(landscape.source).toBe('heuristic');
    expect(landscape.axis).toBe('vertical');
    expect(landscape.segments).toEqual([
      { x: 0, y: 0, width: 445, height: 626 },
      { x: 445, y: 0, width: 445, height: 626 },
    ]);
    expect(landscape.offered).toBe(true);
    expect(landscape.reported).toBe(false);

    const portrait = detectFold(env({ window: INNER_P }));
    expect(portrait.source).toBe('heuristic');
    expect(portrait.axis).toBe('horizontal');
    expect(portrait.segments).toEqual([
      { x: 0, y: 0, width: 626, height: 445 },
      { x: 0, y: 445, width: 626, height: 445 },
    ]);
  });

  it('works with a screen that rotates with the device (Chromium) and in the App Store app', () => {
    expect(detectFold(env({ screen: { width: 890, height: 626 }, window: INNER_L })).source).toBe('heuristic');
    expect(detectFold(env({ userAgent: UA_WKWEBVIEW, window: INNER_P })).source).toBe('heuristic');
  });

  it('finds it with the desktop user agent and touch on a screen smaller than any iPad', () => {
    expect(detectFold(env({ userAgent: UA_MAC, window: INNER_L })).source).toBe('heuristic');
    // Without touch it is a Mac.
    expect(detectFold(env({ userAgent: UA_MAC, maxTouchPoints: 0, window: INNER_L })).source).toBe('none');
  });

  it('never takes the outer display, regular iPhones, iPads or desktops for an inner display', () => {
    const outer = { width: 466, height: 678 };
    expect(detectFold(env({ screen: outer, window: outer }))).toMatchObject({ source: 'none', segments: null, assumed: null, offered: false });
    expect(detectFold(env({ screen: outer, window: { width: 678, height: 466 } }))).toMatchObject({ source: 'none', assumed: null, offered: false });
    const iphone = { width: 393, height: 852 };
    for (const window of [iphone, { width: 852, height: 393 }]) {
      expect(detectFold(env({ screen: iphone, window }))).toMatchObject({ source: 'none', assumed: null, offered: false });
    }
    // An iPad is shaped like an inner display (size alone can't tell them apart): the Menu offers the setting.
    const ipad = { width: 820, height: 1180 };
    expect(detectFold(env({ userAgent: UA_MAC, screen: ipad, window: { width: 1180, height: 820 } }))).toMatchObject({
      source: 'none',
      offered: true,
    });
    const desktop = { width: 1440, height: 900 };
    expect(detectFold(env({ userAgent: UA_CHROME_DESKTOP, maxTouchPoints: 0, screen: desktop, window: desktop }))).toMatchObject({
      source: 'none',
      assumed: null,
      offered: false,
    });
    expect(isFoldableInner({ userAgent: UA_IPHONE, maxTouchPoints: 5, screen: { width: 430, height: 932 } })).toBe(false);
  });

  it('knows no fold in Split View: the window is only part of the screen, and the setting is not offered', () => {
    for (const width of [445, 296, 594, 320, 375]) {
      for (const height of [626, 556]) {
        const info = detectFold(env({ window: { width, height } }));
        expect(info.source, `${width}x${height}`).toBe('none');
        expect(info.assumed, `${width}x${height}`).toBeNull();
        expect(info.offered, `${width}x${height}`).toBe(false);
      }
    }
    // A window a few px off (rounding) still covers the screen.
    expect(detectFold(env({ window: { width: 889, height: 627 } })).source).toBe('heuristic');
  });

  it('a Safari tab held like a book: as wide as the screen, its toolbars taking some height, still splits', () => {
    for (const height of [556, 576, 600]) {
      const tab = detectFold(env({ window: { width: 890, height } }));
      expect(tab, `${height}`).toMatchObject({ source: 'heuristic', axis: 'vertical', offered: true });
      expect(tab.segments![1].x).toBe(445);
      expect(tab.segments![0].height).toBe(height);
      expect(chooseFoldLayout({ ...tab, insets: BOOK_INSETS }, 'auto'), `${height}`).toMatchObject({ kind: 'book', start: 445 });
    }
    // The desktop user agent too; but not a window much shorter than the screen, or taller than it.
    expect(detectFold(env({ userAgent: UA_MAC, window: { width: 890, height: 552 } })).source).toBe('heuristic');
    expect(detectFold(env({ window: { width: 890, height: 400 } })).source).toBe('none');
    expect(detectFold(env({ window: { width: 890, height: 700 } })).source).toBe('none');
    // Upright, toolbars at the top or bottom would move the fold within the window: none assumed.
    const upright = detectFold(env({ window: { width: 626, height: 790 } }));
    expect(upright).toMatchObject({ source: 'none', assumed: null, offered: false });
    expect(chooseFoldLayout(upright, 'split')).toEqual(NO_FOLD_LAYOUT);
  });

  it('takes the @2x possibility too (an iPhone user agent, 1335 × 939)', () => {
    const info = detectFold(env({ screen: { width: 939, height: 1335 }, window: { width: 1335, height: 939 } }));
    expect(info.source).toBe('heuristic');
    expect(info.segments![0].width).toBeCloseTo(667.5);
    // A known blind spot (FOLD.ipadMinShort): with the desktop user agent it looks like an iPad, so
    // Automatic finds no fold; the setting is offered and can still split it.
    const mac = detectFold(env({ userAgent: UA_MAC, screen: { width: 939, height: 1335 }, window: { width: 1335, height: 939 } }));
    expect(mac).toMatchObject({ source: 'none', offered: true });
    expect(mac.assumed).not.toBeNull();
    expect(chooseFoldLayout(mac, 'auto')).toEqual(NO_FOLD_LAYOUT);
  });

  it('trusts the Viewport Segments API when it is there', () => {
    const book = detectFold(
      env({
        userAgent: UA_CHROME_DESKTOP,
        window: INNER_L,
        // In any order: sorted left first.
        segments: [
          { x: 450, y: 0, width: 440, height: 626 },
          { x: 0, y: 0, width: 440, height: 626 },
        ],
      }),
    );
    expect(book).toMatchObject({ source: 'api', axis: 'vertical', offered: true, reported: true });
    expect(book.segments![0].x).toBe(0);
    const stacked = foldFromSegments([
      { x: 0, y: 445, width: 626, height: 445 },
      { x: 0, y: 0, width: 626, height: 445 },
    ]);
    expect(stacked?.axis).toBe('horizontal');
    expect(stacked?.segments[0].y).toBe(0);
    // One segment: no fold in this window or posture, even on a screen the heuristic would take.
    const one = detectFold(env({ window: INNER_L, segments: [{ x: 0, y: 0, width: 890, height: 626 }] }));
    expect(one).toMatchObject({ source: 'none', segments: null, offered: true, reported: true });
    expect(one.assumed).not.toBeNull();
    // A phone with the API (Chromium): one segment, nothing to offer.
    const phone = { width: 393, height: 852 };
    expect(detectFold(env({ screen: phone, window: phone, segments: [{ x: 0, y: 0, ...phone }] }))).toMatchObject({ offered: false, assumed: null });
    expect(foldFromSegments(null)).toBeNull();
  });

  it('passes the posture through', () => {
    expect(detectFold(env({ window: INNER_P, posture: 'folded' })).posture).toBe('folded');
    expect(detectFold(env({ window: INNER_P, posture: 'continuous' })).posture).toBe('continuous');
    expect(detectFold(env({ window: INNER_P })).posture).toBe('unknown');
    // A posture from the browser means it can tell a half-folded screen.
    expect(detectFold(env({ window: INNER_P, posture: 'continuous' })).reported).toBe(true);
    expect(detectFold(env({ window: INNER_P })).reported).toBe(false);
  });

  it('assumes the fold from the screen, not from the window or its safe areas', () => {
    expect(assumedFold({ screen: { width: 626, height: 890 }, window: INNER_L })?.segments[1].x).toBe(445);
    expect(assumedFold({ screen: { width: 626, height: 890 }, window: { width: 834, height: 606 } })).toBeNull();
    expect(assumedFold({ screen: { width: 0, height: 0 }, window: INNER_L })).toBeNull();
  });
});

describe('fold layout', () => {
  const info = (over: Partial<FoldInfo>): FoldInfo => ({
    segments: null,
    axis: null,
    posture: 'unknown',
    source: 'none',
    assumed: null,
    offered: true,
    reported: true,
    insets: BOOK_INSETS,
    ...over,
  });
  const heuristicL = detectFold(env({ window: INNER_L, insets: BOOK_INSETS }));
  const heuristicP = detectFold(env({ window: INNER_P, insets: { top: 56, right: 0, bottom: 20, left: 0 } }));

  it('Automatic: the inner display held like a book splits along the fold, the board on the left', () => {
    expect(chooseFoldLayout(heuristicL, 'auto')).toEqual({ kind: 'book', start: 445, end: 445, boardSide: 'start' });
  });

  it('Automatic: in portrait the screen is used whole unless it is half folded (tabletop)', () => {
    expect(chooseFoldLayout(heuristicP, 'auto')).toEqual(NO_FOLD_LAYOUT);
    expect(chooseFoldLayout({ ...heuristicP, posture: 'folded' }, 'auto')).toEqual({ kind: 'tabletop', start: 445, end: 445, boardSide: 'start' });
  });

  it('Automatic: two segments from the browser split in any posture, around a hinge mask', () => {
    const api = info({
      source: 'api',
      axis: 'vertical',
      posture: 'continuous',
      segments: [
        { x: 0, y: 0, width: 440, height: 626 },
        { x: 450, y: 0, width: 440, height: 626 },
      ],
    });
    expect(chooseFoldLayout(api, 'auto')).toEqual({ kind: 'book', start: 440, end: 450, boardSide: 'start' });
    const stacked = info({
      source: 'api',
      axis: 'horizontal',
      posture: 'continuous',
      insets: { top: 56, right: 0, bottom: 20, left: 0 },
      segments: [
        { x: 0, y: 0, width: 626, height: 445 },
        { x: 0, y: 445, width: 626, height: 445 },
      ],
    });
    expect(chooseFoldLayout(stacked, 'auto').kind).toBe('tabletop');
  });

  it('Use the whole screen never splits; Keep the board off the fold uses the assumed fold', () => {
    expect(chooseFoldLayout(heuristicL, 'whole')).toEqual(NO_FOLD_LAYOUT);
    expect(chooseFoldLayout(heuristicP, 'split').kind).toBe('tabletop');
    // Safari hides the fold (an iPad-style user agent at @2x): the setting still splits it.
    const hidden = detectFold(env({ userAgent: UA_MAC, screen: { width: 939, height: 1335 }, window: { width: 1335, height: 939 } }));
    expect(chooseFoldLayout(hidden, 'auto')).toEqual(NO_FOLD_LAYOUT);
    expect(chooseFoldLayout(hidden, 'split')).toMatchObject({ kind: 'book', start: 667.5 });
    // In Split View nothing is known: no split, whatever the setting.
    const split = detectFold(env({ window: { width: 445, height: 626 } }));
    expect(chooseFoldLayout(split, 'split')).toEqual(NO_FOLD_LAYOUT);
  });

  it('Keep the board off the fold never splits a screen without one: the outer display, phones (the Menu can’t change it there)', () => {
    // Both of the Duo's displays share one storage, and the App Store app's backups carry the key to a new phone.
    const outer = { width: 466, height: 678 };
    for (const window of [outer, { width: 678, height: 466 }]) {
      const info = detectFold(env({ screen: outer, window, insets: { top: 54, right: 0, bottom: 28, left: 0 } }));
      expect(info.offered).toBe(false);
      expect(chooseFoldLayout(info, 'split'), `${window.width}x${window.height}`).toEqual(NO_FOLD_LAYOUT);
    }
    for (const phone of [
      { width: 393, height: 852 },
      { width: 375, height: 667 },
      { width: 440, height: 956 },
    ]) {
      for (const window of [phone, { width: phone.height, height: phone.width }]) {
        const info = detectFold(env({ screen: phone, window }));
        expect(info.offered).toBe(false);
        expect(chooseFoldLayout(info, 'split'), `${window.width}x${window.height}`).toEqual(NO_FOLD_LAYOUT);
      }
    }
    const desktop = { width: 1440, height: 900 };
    const info = detectFold(env({ userAgent: UA_CHROME_DESKTOP, maxTouchPoints: 0, screen: desktop, window: desktop }));
    expect(chooseFoldLayout(info, 'split')).toEqual(NO_FOLD_LAYOUT);
  });

  it('puts the board in the segment clear of the system UI when the device is turned around', () => {
    const turned = { ...heuristicL, insets: { top: 0, right: 0, bottom: 20, left: 56 } };
    expect(chooseFoldLayout(turned, 'auto')).toMatchObject({ kind: 'book', boardSide: 'end' });
  });

  it('does not split when a pane would be too small', () => {
    const small = info({
      source: 'api',
      axis: 'vertical',
      segments: [
        { x: 0, y: 0, width: 250, height: 400 },
        { x: 250, y: 0, width: 250, height: 400 },
      ],
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expect(chooseFoldLayout(small, 'auto')).toEqual(NO_FOLD_LAYOUT);
    // A wide right inset eats the panel's segment.
    const eaten = { ...heuristicL, insets: { top: 0, right: 445 - FOLD.minPane, bottom: 0, left: 0 } };
    expect(chooseFoldLayout(eaten, 'auto')).toEqual(NO_FOLD_LAYOUT);
    // Side by side, the panel's column needs the height for its toolbar, moves and coach.
    const low = info({
      source: 'api',
      axis: 'vertical',
      segments: [
        { x: 0, y: 0, width: 445, height: FOLD.minBookHeight + 20 },
        { x: 445, y: 0, width: 445, height: FOLD.minBookHeight + 20 },
      ],
      insets: { top: 0, right: 0, bottom: 21, left: 0 },
    });
    expect(chooseFoldLayout(low, 'auto')).toEqual(NO_FOLD_LAYOUT);
    expect(chooseFoldLayout({ ...low, insets: { top: 0, right: 0, bottom: 0, left: 0 } }, 'auto').kind).toBe('book');
  });
});

describe('watchFold', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A window on the inner display held like a book (no segments API), its shell padded by `pad`. */
  function fakeWindow() {
    const pad = { top: '0px', right: '56px', bottom: '20px', left: '0px' };
    const shell = { id: 'app' };
    const frames: (() => void)[] = [];
    const observers: (() => void)[] = [];
    const listeners = new Map<string, () => void>();
    const target = () => ({ addEventListener: (t: string, f: () => void) => listeners.set(t, f), removeEventListener: () => {} });
    const win = {
      ...target(),
      navigator: { userAgent: UA_IPHONE, maxTouchPoints: 5 },
      screen: { width: 626, height: 890, orientation: target() },
      innerWidth: 890,
      innerHeight: 626,
      document: {
        getElementById: (id: string) => (id === 'app' ? shell : null),
        body: { append: () => {} },
        createElement: () => ({ style: {}, setAttribute: () => {}, remove: () => {} }),
      },
      matchMedia: () => ({ matches: false, ...target() }),
      requestAnimationFrame: (f: () => void) => frames.push(f),
      cancelAnimationFrame: () => {},
      ResizeObserver: class {
        constructor(cb: () => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    };
    vi.stubGlobal('getComputedStyle', (el: unknown) =>
      el === shell ? { paddingTop: pad.top, paddingRight: pad.right, paddingBottom: pad.bottom, paddingLeft: pad.left } : {},
    );
    const flush = () => {
      for (const f of frames.splice(0)) f();
    };
    return { win: win as unknown as Window, pad, observers, flush, listeners };
  }

  it('re-reads the safe areas when the shell’s padding changes without a resize (the system UI moving sides)', () => {
    const { win, pad, observers, flush } = fakeWindow();
    const { info, stop } = watchFold(win);
    flush();
    expect(info.value.insets).toEqual({ top: 0, right: 56, bottom: 20, left: 0 });
    expect(chooseFoldLayout(info.value, 'auto').boardSide).toBe('start');
    // Turned around: the system UI along the left edge, the window the same size.
    pad.right = '0px';
    pad.left = '56px';
    expect(observers).toHaveLength(1);
    observers[0]();
    flush();
    expect(info.value.insets.left).toBe(56);
    expect(chooseFoldLayout(info.value, 'auto')).toMatchObject({ kind: 'book', boardSide: 'end' });
    stop();
  });
});

describe('the Foldable screen setting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const memoryStorage = (init: Record<string, string> = {}) => {
    const data = new Map(Object.entries(init));
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  };

  it('defaults to Automatic, also when storage is missing, broken or holds nonsense', () => {
    expect(DEFAULT_FOLD_SETTING).toBe('auto');
    vi.stubGlobal('localStorage', undefined);
    expect(loadFoldSetting()).toBe('auto');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(loadFoldSetting()).toBe('auto');
    expect(() => saveFoldSetting('split')).not.toThrow();
    vi.stubGlobal('localStorage', memoryStorage({ [FOLD_SETTING_KEY]: 'sideways' }));
    expect(loadFoldSetting()).toBe('auto');
  });

  it('round-trips through localStorage under a mirrored key', () => {
    const store = memoryStorage();
    vi.stubGlobal('localStorage', store);
    saveFoldSetting('whole');
    expect(store.data.get(FOLD_SETTING_KEY)).toBe('whole');
    expect(loadFoldSetting()).toBe('whole');
    saveFoldSetting('split');
    expect(loadFoldSetting()).toBe('split');
    expect(FOLD_SETTING_KEY.startsWith('chesscoach.')).toBe(true);
  });
});
