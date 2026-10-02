/**
 * Bootstrap: iOS guards (zoom, first-tap audio unlock), the service worker (offline + updates,
 * "Available offline" in the UI), page visibility -> controller, then either the game (<App/>)
 * or, with `?enginetest`, the engine self-test page for checking Stockfish on a real device.
 *
 * The App Store app (`nativeBuild`, see src/native/platform.ts) has no service worker: its files
 * ship inside the app, so it is offline from the start and only updates through the App Store (and
 * says nothing about being "available offline", which would read like a cached website). In
 * the native app (`isNative`), startup first restores any storage iOS has purged
 * (src/native/storage.ts), the iOS share sheet backs `navigator.share`, every game sound also plays
 * a haptic, the status bar follows the theme, and the launch screen is hidden once the app renders.
 */
import { signal } from '@preact/signals';
import { render } from 'preact';
import './styles/app.css';
import { App } from './App';
import { GameController, bindPageLifecycle } from './game/controller';
import { isSoundEnabled, playSound, setSoundEnabled, unlockAudio } from './game/sound';
import { installIosGuards } from './ios';
import { withHaptics } from './native/haptics';
import { isNative, nativeBuild } from './native/platform';
import { installNativeShare } from './native/share';
import { prepareNativeStorage } from './native/storage';
import { hideSplash, syncStatusBarWithTheme } from './native/statusbar';
import { registerServiceWorker, type OfflineStatus } from './pwa';
import { applyTheme, loadTheme } from './theme';

const root = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

applyTheme(loadTheme());
installIosGuards({ onFirstGesture: unlockAudio });
if (isNative) {
  syncStatusBarWithTheme();
  installNativeShare();
  // Whatever happens at startup, the launch screen (which blocks touches) must not stay up.
  addEventListener('error', hideSplash);
  addEventListener('unhandledrejection', hideSplash);
}

if (params.has('enginetest')) {
  let running = true;
  if (!nativeBuild) registerServiceWorker({ canReloadNow: () => !running });
  void Promise.all([import('./ui/SelfTestPage'), import('./engine/selfTest')]).then(
    ([{ SelfTestPage }, { runEngineSelfTest }]) => {
      // A service-worker update must not reload the page in the middle of a run.
      const run = async (log: (line: string) => void) => {
        running = true;
        try {
          return await runEngineSelfTest(log);
        } finally {
          running = false;
        }
      };
      render(<SelfTestPage run={run} />, root);
      requestAnimationFrame(hideSplash);
    },
    (e: unknown) => {
      hideSplash();
      throw e;
    },
  );
} else if (isNative) {
  // The saved game, rating and settings must be back before the controller reads them.
  void prepareNativeStorage()
    .catch(() => {}) // without the backup, the app still starts
    .then(() => {
      applyTheme(loadTheme()); // in case the theme was among the restored keys
      startApp();
    });
} else {
  startApp();
}

function startApp(): void {
  const controller = new GameController(
    isNative ? { sound: withHaptics({ play: playSound, setEnabled: setSoundEnabled }, isSoundEnabled) } : {},
  );
  // Stays null in the App Store app: bundled with the app, nothing to download, nothing to update.
  const offline = signal<OfflineStatus | null>(null);
  if (!nativeBuild) {
    // A page the service worker already controls was loaded from the offline cache: nothing new to announce.
    const cachedAtStart = 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null;
    // A finished game may reload onto a new build at once; with a sheet open over it, only in the background.
    registerServiceWorker({
      canReloadNow: () => controller.canReloadNow({ hidden: document.visibilityState === 'hidden' }),
      onOfflineReady: () => {
        offline.value = cachedAtStart ? 'cached' : 'installed';
      },
    });
  }
  bindPageLifecycle(controller);
  try {
    render(<App controller={controller} offline={offline} />, root);
  } finally {
    // After the first frame of the app (its own splash shows while the engine starts).
    requestAnimationFrame(hideSplash);
  }
  void controller.boot();
  // Debug / e2e hook (e.g. `await __chessCoach.controller.idle()` in the console).
  (window as unknown as { __chessCoach?: { controller: GameController } }).__chessCoach = { controller };
}
