/**
 * Foldable screens (written for the iPhone Duo): where the fold is, and whether the game screen
 * splits along it (the board on one side of the fold, the coach and the controls on the other).
 *
 * Three sources, best first:
 * - The Viewport Segments API (`window.viewport.segments`): the browser says where the screen's two
 *   segments are. Chromium has it; WebKit had not shipped it as of mid-2026.
 * - The Device Posture API (`navigator.devicePosture`, or the `(device-posture)` media feature):
 *   'folded' (half open, like a laptop or a tent) or 'continuous' (flat).
 * - A heuristic for when the segments API is missing (Safari, the App Store app's WKWebView): an
 *   iPhone-class device with a big, nearly square screen is a foldable's inner display, and its fold
 *   runs across the middle of the screen's long side. It only applies while the window spans the
 *   screen: in Split View the window is part of the screen, and where the fold falls in it is
 *   unknown. Side by side (landscape) the window need only be as wide as the screen, so a Safari tab
 *   (its toolbars take some height, not width) splits too; stacked (portrait) it must cover the
 *   whole screen, since toolbars at the top or bottom would move the fold within it.
 *
 * The pure functions here take what the browser reports (`FoldEnvironment`) and are unit-tested;
 * `watchFold()` is the small reactive wrapper the app uses. Everything is in viewport CSS px.
 *
 * The iPhone Duo's point sizes, scale factor and safe areas, and whether Safari and WKWebView will
 * report its fold, were not published when this was written: the numbers in FOLD are estimates from
 * its announced pixel sizes (inner display 2670 × 1878 px, outer 1398 × 2034 px), to revisit once the
 * device (or its simulator) is out. They and e2e/foldable.spec.ts's test viewports are the place to
 * tune, with the window-shape thresholds of the Duo's whole-screen layouts in src/App.css (short,
 * wide portrait; big portrait; squat landscape).
 */
import { signal, type ReadonlySignal } from '@preact/signals';

/** A box in viewport CSS px. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Safe-area insets in CSS px: where the system UI is (the Duo's open state puts it along the right edge). */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The fold line's direction: 'vertical' runs top to bottom (segments side by side, like a book). */
export type FoldAxis = 'vertical' | 'horizontal';
/** 'folded': half open (tabletop, tent, a book held open); 'continuous': flat; 'unknown': not reported. */
export type Posture = 'folded' | 'continuous' | 'unknown';
/** Where the fold came from: the browser ('api'), the screen's size ('heuristic'), or nowhere. */
export type FoldSource = 'api' | 'heuristic' | 'none';

export interface FoldInfo {
  /** The screen's two segments (first: left or top), or null: no fold known in this window. */
  segments: readonly [Rect, Rect] | null;
  axis: FoldAxis | null;
  posture: Posture;
  source: FoldSource;
  /**
   * Where the fold would be on a foldable whose browser doesn't say (the screen's center line across
   * its long side), on a touch screen shaped like a foldable's inner display while the window spans
   * it (see assumedFold); null otherwise, and always on a phone or the Duo's outer display. "Keep the
   * board off the fold" uses it when nothing reports a fold.
   */
  assumed: readonly [Rect, Rect] | null;
  /**
   * The Menu offers the "Foldable screen" setting: a fold is reported or can be assumed here, so the
   * setting can act (and a stored choice never acts where the Menu can't change it).
   */
  offered: boolean;
  /**
   * The browser reports the fold or the posture (the segments API or the Device Posture API, as
   * Chromium does), so Automatic can tell a half-folded screen; WebKit reports neither (mid-2026).
   */
  reported: boolean;
  insets: Insets;
}

/**
 * Estimates, to revisit once the device is out (see the module comment). CSS px at the Duo's
 * presumed @3x: inner display ≈ 890 × 626 (2670 × 1878 px), outer ≈ 466 × 678 (1398 × 2034 px).
 */
export const FOLD = {
  /** Smallest short side of a foldable's inner display (the Duo's ≈ 626; iPhones are 375–440). */
  innerMinShort: 540,
  /** Largest long / short ratio of an inner display (the Duo's ≈ 1.42; iPhones are ≈ 2.17). */
  innerMaxAspect: 1.6,
  /**
   * iPads send the same desktop (Mac) user agent as the Duo's inner display might, with touch; their
   * short side is 744 or more (iPad mini), so below this such a user agent can be a foldable. A blind
   * spot: should the Duo turn out to be @2x (≈ 1335 × 939) and send that user agent, it looks like an
   * iPad (the same size and shape), so Automatic doesn't split it; "Keep the board off the fold"
   * still does, as would WebKit shipping the Viewport Segments API.
   */
  ipadMinShort: 740,
  /** How far (CSS px) the window may differ from the screen's size and still cover it (rounding). */
  fullScreenSlack: 4,
  /**
   * Side by side, the least share of the screen's height a window as wide as the screen must have:
   * Safari's toolbars (a tab, not the installed app) take some of it.
   */
  tabMinHeight: 0.75,
  /** Room kept clear on each side of the fold and its hinge mask (CSS px). */
  clearance: 8,
  /** Smallest pane (CSS px, either way) a segment must leave inside the safe area for the screen to split. */
  minPane: 260,
  /**
   * Smallest height (inside the safe area) for side-by-side panes: the panel's column needs room for
   * the toolbar, the graph, a few rows of moves and an expanded coach (the Duo's is ≈ 606).
   */
  minBookHeight: 400,
} as const;

/** What the browser reports (`readFoldEnvironment`). */
export interface FoldEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  /** `screen.width` / `screen.height`: Safari keeps them in portrait whatever the orientation. */
  screen: { width: number; height: number };
  /** The window (layout viewport): `innerWidth` / `innerHeight`. */
  window: { width: number; height: number };
  /** `window.viewport.segments`, or null when the API is missing. */
  segments: readonly Rect[] | null;
  /** `navigator.devicePosture.type` or the `(device-posture)` media feature; null when neither exists. */
  posture: 'folded' | 'continuous' | null;
  insets?: Insets;
}

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Two segments from the Viewport Segments API (sorted: left or top first), or null for one segment. */
export function foldFromSegments(segments: readonly Rect[] | null): { segments: [Rect, Rect]; axis: FoldAxis } | null {
  if (!segments || segments.length !== 2) return null;
  const [a, b] = segments;
  const sideBySide = Math.abs(a.y - b.y) < 1 && Math.abs(a.height - b.height) < 1;
  const sorted: [Rect, Rect] = (sideBySide ? a.x <= b.x : a.y <= b.y) ? [a, b] : [b, a];
  return { segments: sorted, axis: sideBySide ? 'vertical' : 'horizontal' };
}

/**
 * The fold of a foldable that doesn't report it: the center line across the screen's long side, in
 * the window's coordinates, while the window spans the screen (else null: in Split View or Slide
 * Over the window is part of the screen). Side by side (landscape), a window as wide as the screen
 * and most of its height (a Safari tab under its toolbars) has the fold at its own center line;
 * stacked (portrait), only a window covering the whole screen does. Screen geometry, not the safe
 * area: the system UI along one edge does not move the fold.
 */
export function assumedFold(env: Pick<FoldEnvironment, 'screen' | 'window'>): { segments: [Rect, Rect]; axis: FoldAxis } | null {
  const short = Math.min(env.screen.width, env.screen.height);
  const long = Math.max(env.screen.width, env.screen.height);
  const { width, height } = env.window;
  if (short <= 0 || width <= 0 || height <= 0) return null;
  const landscape = width > height;
  const [sw, sh] = landscape ? [long, short] : [short, long];
  const slack = FOLD.fullScreenSlack;
  if (Math.abs(width - sw) > slack || height > sh + slack) return null;
  if (height < (landscape ? sh * FOLD.tabMinHeight : sh - slack)) return null;
  if (landscape) {
    const half = width / 2;
    return {
      segments: [
        { x: 0, y: 0, width: half, height },
        { x: half, y: 0, width: width - half, height },
      ],
      axis: 'vertical',
    };
  }
  const half = height / 2;
  return {
    segments: [
      { x: 0, y: 0, width, height: half },
      { x: 0, y: half, width, height: height - half },
    ],
    axis: 'horizontal',
  };
}

/**
 * A touch screen as big and as nearly square as a foldable's inner display (iPads are too, and some
 * touch laptops: size and shape alone can't tell them apart). Phones (≈ 2.2 : 1, or smaller), the
 * Duo's outer display and screens without touch never are.
 */
export function isFoldableShaped(env: Pick<FoldEnvironment, 'userAgent' | 'maxTouchPoints' | 'screen'>): boolean {
  const short = Math.min(env.screen.width, env.screen.height);
  const long = Math.max(env.screen.width, env.screen.height);
  const touch = env.maxTouchPoints > 0 || /\biPhone\b/.test(env.userAgent);
  return touch && short >= FOLD.innerMinShort && long / short <= FOLD.innerMaxAspect;
}

/**
 * Whether this looks like a foldable's inner display: an iPhone (Safari or the App Store app), or the
 * iPad-style desktop user agent with touch on a screen smaller than any iPad's; and a big, nearly
 * square screen. Regular iPhones (≈ 2.2 : 1), iPads and desktops never match.
 */
export function isFoldableInner(env: Pick<FoldEnvironment, 'userAgent' | 'maxTouchPoints' | 'screen'>): boolean {
  const short = Math.min(env.screen.width, env.screen.height);
  const iPhone = /\biPhone\b/.test(env.userAgent);
  const ipadStyle = /\bMacintosh\b/.test(env.userAgent) && env.maxTouchPoints > 1 && short < FOLD.ipadMinShort;
  return (iPhone || ipadStyle) && isFoldableShaped(env);
}

/** What is known about the fold (see the module comment for the order of the sources). */
export function detectFold(env: FoldEnvironment): FoldInfo {
  const posture: Posture = env.posture ?? 'unknown';
  // Only where a foldable's inner display could be: never on a phone or the outer display.
  const assumed = isFoldableShaped(env) ? assumedFold(env) : null;
  const base = {
    posture,
    assumed: assumed?.segments ?? null,
    offered: assumed !== null,
    reported: env.segments !== null || env.posture !== null,
    insets: env.insets ?? NO_INSETS,
  };
  // The segments API is there: it knows (one segment means no fold in this window or posture).
  if (env.segments) {
    const api = foldFromSegments(env.segments);
    if (api) return { ...base, segments: api.segments, axis: api.axis, source: 'api', offered: true };
    return { ...base, segments: null, axis: null, source: 'none' };
  }
  if (assumed && isFoldableInner(env)) {
    return { ...base, segments: assumed.segments, axis: assumed.axis, source: 'heuristic' };
  }
  return { ...base, segments: null, axis: null, source: 'none' };
}

// -------------------------------------------------------------------------------------------------
// The setting and the layout

/**
 * The Menu's "Foldable screen" setting. 'auto': split along the fold when the screen is open like a
 * book (or half folded, tabletop); 'split': always keep the board off the fold (where the fold is
 * known or assumed); 'whole': never split, the board as big as the whole screen allows.
 */
export type FoldSetting = 'auto' | 'split' | 'whole';

export const FOLD_SETTINGS: readonly { value: FoldSetting; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'split', label: 'Keep the board off the fold' },
  { value: 'whole', label: 'Use the whole screen' },
];

/** localStorage key (mirrored in the App Store app like every `chesscoach.` key). */
export const FOLD_SETTING_KEY = 'chesscoach.fold';
export const DEFAULT_FOLD_SETTING: FoldSetting = 'auto';

const isFoldSetting = (v: unknown): v is FoldSetting => v === 'auto' || v === 'split' || v === 'whole';

/** The stored setting (default 'auto'); never throws. */
export function loadFoldSetting(): FoldSetting {
  try {
    const v = localStorage.getItem(FOLD_SETTING_KEY);
    return isFoldSetting(v) ? v : DEFAULT_FOLD_SETTING;
  } catch {
    return DEFAULT_FOLD_SETTING;
  }
}

/** Stores the setting; never throws. */
export function saveFoldSetting(value: FoldSetting): void {
  try {
    localStorage.setItem(FOLD_SETTING_KEY, value);
  } catch {
    // Private mode / storage disabled: the choice lasts for this session only.
  }
}

/**
 * How the game screen uses the fold. 'book': side by side (the board in one segment, the panel in
 * the other); 'tabletop': the board in the top segment, the rest in the bottom one; 'none': one
 * layout across the whole window.
 */
export type FoldLayoutKind = 'book' | 'tabletop' | 'none';

export interface FoldLayout {
  kind: FoldLayoutKind;
  /**
   * The fold along the split (x for 'book', y for 'tabletop'), viewport px: `start` is where the
   * first segment ends, `end` where the second begins (they differ by a hinge mask, if any).
   */
  start: number;
  end: number;
  /**
   * 'book': the segment the board takes. The first (left) one, unless the system UI is along the
   * left edge (the device turned around): the board then takes the segment clear of it.
   */
  boardSide: 'start' | 'end';
}

export const NO_FOLD_LAYOUT: FoldLayout = { kind: 'none', start: 0, end: 0, boardSide: 'start' };

/**
 * The layout for this fold and setting. Automatic: two segments from the browser split in any
 * posture; the heuristic's side-by-side halves (the inner display in landscape, held like a book)
 * split; its top and bottom halves (in portrait the fold runs across the middle) split only when
 * the posture is 'folded' (tabletop), else the screen is used whole. WebKit reports no posture (as of
 * mid-2026), so in Safari and the App Store app half folded is a choice: "Keep the board off the
 * fold". That one splits along the reported or assumed fold, and so only where the Menu offers it.
 * Nothing splits when a pane would be too small (FOLD.minPane inside the safe area).
 */
export function chooseFoldLayout(info: FoldInfo, setting: FoldSetting): FoldLayout {
  if (setting === 'whole') return NO_FOLD_LAYOUT;
  let segments: readonly [Rect, Rect] | null = null;
  if (setting === 'split') segments = info.segments ?? info.assumed;
  else if (info.source === 'api') segments = info.segments;
  else if (info.source === 'heuristic' && (info.axis === 'vertical' || info.posture === 'folded')) segments = info.segments;
  if (!segments) return NO_FOLD_LAYOUT;
  const [a, b] = segments;
  const i = info.insets;
  const c = FOLD.clearance;
  const book = Math.abs(a.y - b.y) < 1;
  if (book) {
    const start = a.x + a.width;
    const end = b.x;
    const first = start - i.left - c;
    const second = b.x + b.width - i.right - end - c;
    const tall = Math.min(a.height, b.height) - i.top - i.bottom;
    if (Math.min(first, second) < FOLD.minPane || tall < FOLD.minBookHeight) return NO_FOLD_LAYOUT;
    return { kind: 'book', start, end, boardSide: i.left > i.right ? 'end' : 'start' };
  }
  const start = a.y + a.height;
  const end = b.y;
  const top = start - i.top - c;
  const bottom = b.y + b.height - i.bottom - end - c;
  const wide = Math.min(a.width, b.width) - i.left - i.right;
  if (Math.min(top, bottom, wide) < FOLD.minPane) return NO_FOLD_LAYOUT;
  return { kind: 'tabletop', start, end, boardSide: 'start' };
}

/**
 * Puts a layout on <html>, where every layer can see it (the game screen, the game viewer, the sheets,
 * the Openings section): `data-fold` ('book' or 'tabletop'; none for 'none'), `data-fold-board` ('end'
 * when the board takes the second segment) and the fold's position, `--fold-start` and `--fold-end`
 * in viewport px. The CSS does the rest.
 */
export function applyFoldLayout(layout: FoldLayout, root: HTMLElement = document.documentElement): void {
  if (layout.kind === 'none') {
    delete root.dataset.fold;
    delete root.dataset.foldBoard;
    root.style.removeProperty('--fold-start');
    root.style.removeProperty('--fold-end');
    return;
  }
  root.dataset.fold = layout.kind;
  if (layout.boardSide === 'end') root.dataset.foldBoard = 'end';
  else delete root.dataset.foldBoard;
  root.style.setProperty('--fold-start', `${layout.start}px`);
  root.style.setProperty('--fold-end', `${layout.end}px`);
}

// -------------------------------------------------------------------------------------------------
// The browser

interface ViewportSegments {
  segments?: readonly Rect[] | null;
}
type PostureNavigator = Navigator & { devicePosture?: { type?: string } & EventTarget };

/** The posture from `navigator.devicePosture`, or else the `(device-posture)` media feature; null: neither. */
function readPosture(win: Window): 'folded' | 'continuous' | null {
  const type = (win.navigator as PostureNavigator).devicePosture?.type;
  if (type === 'folded' || type === 'continuous') return type;
  if (typeof win.matchMedia === 'function') {
    if (win.matchMedia('(device-posture: folded)').matches) return 'folded';
    if (win.matchMedia('(device-posture: continuous)').matches) return 'continuous';
  }
  return null;
}

/** The safe-area insets: the padding the app shell (#app) gets from them (src/styles/app.css). */
function readInsets(el: Element | null): Insets {
  if (!el) return NO_INSETS;
  const cs = getComputedStyle(el);
  const px = (v: string) => Math.max(0, parseFloat(v) || 0);
  return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
}

/** Reads what the browser reports now. */
export function readFoldEnvironment(win: Window = window, shell: Element | null = win.document.getElementById('app')): FoldEnvironment {
  const vp = (win as Window & { viewport?: ViewportSegments }).viewport;
  const segments = vp && Array.isArray(vp.segments) ? vp.segments.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })) : null;
  return {
    userAgent: win.navigator.userAgent,
    maxTouchPoints: win.navigator.maxTouchPoints || 0,
    screen: { width: win.screen.width, height: win.screen.height },
    window: { width: win.innerWidth, height: win.innerHeight },
    segments,
    posture: readPosture(win),
    insets: readInsets(shell),
  };
}

/**
 * The fold as a signal, kept up to date: re-read (at most once a frame) when the window is resized
 * or rotated (folding, unfolding and Split View all resize it), when the posture or the number of
 * segments changes, and when the safe areas do without a resize (WKWebView may report them only
 * after its first layout; a turn by 180° moves the system UI to the other side, perhaps a frame
 * after the orientation event). `stop()` removes every listener.
 */
export function watchFold(win: Window = window): { info: ReadonlySignal<FoldInfo>; stop: () => void } {
  const read = () => detectFold(readFoldEnvironment(win));
  const info = signal(read());
  let key = JSON.stringify(info.peek());
  let frame = 0;
  const update = () => {
    frame = 0;
    const next = read();
    const nextKey = JSON.stringify(next);
    if (nextKey === key) return;
    key = nextKey;
    info.value = next;
  };
  const schedule = () => {
    if (!frame) frame = win.requestAnimationFrame(update);
  };
  const off: (() => void)[] = [];
  const listen = (target: EventTarget | null | undefined, type: string) => {
    if (!target) return;
    target.addEventListener(type, schedule);
    off.push(() => target.removeEventListener(type, schedule));
  };
  listen(win, 'resize');
  listen(win, 'orientationchange');
  listen(win.screen.orientation, 'change');
  listen((win.navigator as PostureNavigator).devicePosture, 'change');
  if (typeof win.matchMedia === 'function') {
    for (const q of ['(device-posture: folded)', '(horizontal-viewport-segments: 2)', '(vertical-viewport-segments: 2)']) {
      listen(win.matchMedia(q), 'change');
    }
  }
  // The safe areas (the --safe-* properties, src/styles/app.css): two hidden boxes as big as them,
  // left × top and right × bottom, so a resize observer sees any change, also the system UI moving
  // to the other side at the same size (the shell's own box wouldn't change then).
  const Observer = (win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  const body = win.document.body as HTMLElement | null;
  if (Observer && body) {
    const observer = new Observer(schedule);
    for (const [w, h] of [
      ['--safe-left', '--safe-top'],
      ['--safe-right', '--safe-bottom'],
    ]) {
      const probe = win.document.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = `position: fixed; left: 0; top: 0; width: var(${w}); height: var(${h}); visibility: hidden; pointer-events: none;`;
      body.append(probe);
      observer.observe(probe);
      off.push(() => probe.remove());
    }
    off.push(() => observer.disconnect());
  }
  // The safe areas come from CSS: read them again once the styles are in (the first read may precede them).
  schedule();
  return {
    info,
    stop: () => {
      for (const f of off) f();
      if (frame) win.cancelAnimationFrame(frame);
    },
  };
}
