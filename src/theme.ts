/**
 * Colour theme: the user's preference ('dark' by default, 'light', or 'system' to follow iOS) is
 * stored in localStorage and resolved onto `<html data-theme="dark|light">`, which the CSS tokens
 * in src/styles/app.css (and the component styles) key off. index.html runs an inline copy of
 * `resolveTheme` before the first paint, so there is no flash of the wrong theme.
 */

export type ThemePref = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

/** localStorage key (also read by the inline script in index.html). */
export const THEME_KEY = 'chesscoach.theme';
export const DEFAULT_THEME: ThemePref = 'dark';

/** Background colours of the two themes (match --bg in app.css); used for `<meta name="theme-color">`. */
const THEME_BG: Record<ResolvedTheme, string> = { dark: '#1d1c1a', light: '#f4f1ec' };

const isPref = (v: unknown): v is ThemePref => v === 'dark' || v === 'light' || v === 'system';

/** The stored preference (default 'dark'); never throws. */
export function loadTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isPref(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Stores the preference; never throws. */
export function saveTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Private mode / storage disabled: the choice lasts for this session only.
  }
}

function systemPrefersLight(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
}

/** 'system' resolved against the current OS setting. */
export function resolveTheme(pref: ThemePref, prefersLight = systemPrefersLight()): ResolvedTheme {
  if (pref === 'system') return prefersLight ? 'light' : 'dark';
  return pref;
}

/** Sets `data-theme` on <html> and the browser chrome colour. */
export function applyTheme(pref: ThemePref, doc: Document = document): ResolvedTheme {
  const theme = resolveTheme(pref);
  doc.documentElement.dataset.theme = theme;
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_BG[theme];
  }
  return theme;
}

/**
 * Applies `getPref()` now and again whenever the OS switches between light and dark (only matters
 * for 'system'). Returns a function that stops listening.
 */
export function watchSystemTheme(getPref: () => ThemePref): () => void {
  applyTheme(getPref());
  if (typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia('(prefers-color-scheme: light)');
  const onChange = () => applyTheme(getPref());
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
