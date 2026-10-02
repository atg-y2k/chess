/**
 * Which app this is: the App Store app (Capacitor on iOS) or the web app (PWA).
 *
 * `nativeBuild` is a build-time constant (VITE_NATIVE=1, `npm run build:native`). Capacitor's
 * JavaScript is loaded only through `nativePlugins`, whose imports sit behind it in this module, so
 * the web build contains no Capacitor code at all. (The bundler folds `nativeBuild` only inside this
 * module: a dynamic import elsewhere behind an imported `nativeBuild`/`isNative` would still be
 * emitted as a chunk, and precached by the PWA.) `isNative` also needs the native runtime: the
 * native build opened in a browser (e.g. the dist-native smoke test) behaves like the web app,
 * without the native touches.
 */

/** Built for the App Store app: bundled files, no service worker, no update logic. */
export const nativeBuild: boolean = import.meta.env.VITE_NATIVE === '1';

/**
 * True in the Capacitor iOS app, false on the web. This is `Capacitor.isNativePlatform()`, read from
 * the `Capacitor` global that the native bridge injects before any page script runs (the same object
 * @capacitor/core wraps), so the web build does not need @capacitor/core.
 */
export const isNative: boolean = nativeBuild && isNativeRuntime(globalThis);

/** Whether `Capacitor.isNativePlatform()` says so on `g` (exported for tests). */
export function isNativeRuntime(g: object): boolean {
  try {
    return (g as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/**
 * Whether Pro features are sold (and locked until bought): always in the App Store app; on the web
 * only in a build made with VITE_PAYWALL=1, to test the paywall against a mock store.
 */
export const paywallEnabled: boolean = isNative || import.meta.env.VITE_PAYWALL === '1';

/** The app's name as the user sees it (APP_NAME in capacitor.config.ts, injected by vite.config.ts). */
export const APP_NAME: string = (import.meta.env.VITE_APP_NAME as string | undefined) || 'Chess Coach';

/**
 * The privacy policy, terms of use (EULA) and support pages (public/*.html, published with the web
 * app on GitHub Pages; the same URLs go in App Store Connect). Where Pro is sold, About links to all
 * three at any time (App Review wants the privacy policy easy to reach) and the paywall to the first two.
 */
export const LEGAL_URLS = {
  privacy: 'https://atg-y2k.github.io/chess/privacy.html',
  terms: 'https://atg-y2k.github.io/chess/terms.html',
  support: 'https://atg-y2k.github.io/chess/support.html',
} as const;

/** The app's version (package.json, injected by vite.config.ts); '' where it is not known (tests). */
export const APP_VERSION: string = (import.meta.env.VITE_APP_VERSION as string | undefined) || '';

const notNative = (): Promise<never> => Promise.reject(new Error('Capacitor is only available in the native build'));

/**
 * Capacitor's JavaScript (the core and the plugins this app uses), loaded on first use. Use these
 * rather than `import('@capacitor/…')` (see the module comment); in the web build they reject.
 * Native calls only work when `isNative` is true.
 */
export const nativePlugins = {
  core: (): Promise<typeof import('@capacitor/core')> => (nativeBuild ? import('@capacitor/core') : notNative()),
  haptics: (): Promise<typeof import('@capacitor/haptics')> =>
    nativeBuild ? import('@capacitor/haptics') : notNative(),
  preferences: (): Promise<typeof import('@capacitor/preferences')> =>
    nativeBuild ? import('@capacitor/preferences') : notNative(),
  share: (): Promise<typeof import('@capacitor/share')> => (nativeBuild ? import('@capacitor/share') : notNative()),
  splashScreen: (): Promise<typeof import('@capacitor/splash-screen')> =>
    nativeBuild ? import('@capacitor/splash-screen') : notNative(),
  statusBar: (): Promise<typeof import('@capacitor/status-bar')> =>
    nativeBuild ? import('@capacitor/status-bar') : notNative(),
};
