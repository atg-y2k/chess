/**
 * Capacitor configuration for the App Store (iOS) app. See ios/README-native.md.
 *
 * APP_ID and APP_NAME below are the one place to change the app's bundle ID and Home Screen name:
 * `npm run build:native` copies them into the Xcode project (PRODUCT_BUNDLE_IDENTIFIER in
 * ios/App/App.xcodeproj/project.pbxproj, CFBundleDisplayName in ios/App/App/Info.plist) and into the
 * web app (`APP_NAME` in src/native/platform.ts); see nativeProjectSettings() in vite.config.ts.
 */
import type { CapacitorConfig } from '@capacitor/cli';

/** The bundle ID. It must match the app record in App Store Connect and can't change after release. */
export const APP_ID = 'io.github.atgy2k.chesscoach';
/** The name under the Home Screen icon (CFBundleDisplayName); also used in the app's About section. */
export const APP_NAME = 'Chess Coach';
/** Dark theme background (--bg in src/styles/app.css): behind the web view and on the launch screen. */
const BACKGROUND = '#1d1c1a';

const config: CapacitorConfig = {
  appId: APP_ID,
  appName: APP_NAME,
  // `npm run build:native` (VITE_NATIVE=1) builds here; `npx cap sync ios` copies it to ios/App/App/public.
  webDir: 'dist-native',
  backgroundColor: BACKGROUND,
  ios: {
    backgroundColor: BACKGROUND,
    // The CSS already pads #app with env(safe-area-inset-*) (viewport-fit=cover in index.html).
    contentInset: 'never',
    // A fixed full-screen layout (body is position: fixed); sheets and lists scroll inside it.
    scrollEnabled: false,
    allowsLinkPreview: false,
    // webContentsDebuggingEnabled is left unset: Debug builds can be inspected with Safari's Web
    // Inspector, Release builds can't.
  },
  plugins: {
    // Off (the default), stated because it matters: the engine fetches its .wasm with the browser's
    // own fetch() + WebAssembly.instantiateStreaming, which CapacitorHttp's patched fetch breaks.
    CapacitorHttp: { enabled: false },
    // src/main.tsx hides the launch screen once the app has rendered (or failed to).
    SplashScreen: { launchAutoHide: false, backgroundColor: BACKGROUND, showSpinner: false },
    // Light text over the dark theme until src/native/statusbar.ts follows the app's theme.
    StatusBar: { overlaysWebView: true, style: 'DARK' },
  },
};

export default config;
