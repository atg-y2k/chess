/**
 * The status bar and the launch screen in the App Store app (@capacitor/status-bar,
 * @capacitor/splash-screen). No-ops on the web, where index.html's meta tags do this job.
 */
import { isNative, nativePlugins } from './platform';

/**
 * Keeps the status bar text readable: light on the dark theme, dark on the light one. Follows
 * `data-theme` on <html> (set by src/theme.ts, including when "Automatic" follows iOS), so it needs
 * no hook in the theme code. The web view runs under the status bar (capacitor.config.ts
 * `overlaysWebView`), as in the Home Screen web app.
 */
export function syncStatusBarWithTheme(root: HTMLElement = document.documentElement): void {
  if (!isNative) return;
  let current = '';
  const sync = () => {
    const theme = root.dataset.theme === 'light' ? 'light' : 'dark';
    if (theme === current) return;
    current = theme;
    void nativePlugins
      .statusBar()
      .then(({ StatusBar, Style }) => StatusBar.setStyle({ style: theme === 'light' ? Style.Light : Style.Dark }))
      .catch(() => {});
  };
  sync();
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
}

let splashHidden = false;

/**
 * Hides the native launch screen (capacitor.config.ts sets `launchAutoHide: false`; it also blocks
 * touches while it shows). Call it once the app has rendered, or failed to; later calls do nothing.
 */
export function hideSplash(): void {
  if (!isNative || splashHidden) return;
  splashHidden = true;
  void nativePlugins
    .splashScreen()
    .then(({ SplashScreen }) => SplashScreen.hide({ fadeOutDuration: 200 }))
    .catch(() => {});
}
