/**
 * Bootstrap: iOS guards (zoom, first-tap audio unlock), the service worker (offline + updates),
 * page visibility -> controller, then either the game (<App/>) or, with `?enginetest`, the engine
 * self-test page for checking Stockfish on a real device.
 */
import { render } from 'preact';
import './styles/app.css';
import { App } from './App';
import { GameController, bindPageLifecycle } from './game/controller';
import { unlockAudio } from './game/sound';
import { installIosGuards } from './ios';
import { registerServiceWorker } from './pwa';
import { applyTheme, loadTheme } from './theme';

const root = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

applyTheme(loadTheme());
installIosGuards({ onFirstGesture: unlockAudio });

if (params.has('enginetest')) {
  let running = true;
  registerServiceWorker({ canReloadNow: () => !running });
  void Promise.all([import('./ui/SelfTestPage'), import('./engine/selfTest')]).then(([{ SelfTestPage }, { runEngineSelfTest }]) => {
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
  });
} else {
  const controller = new GameController();
  registerServiceWorker({ canReloadNow: () => controller.canReloadNow() });
  bindPageLifecycle(controller);
  render(<App controller={controller} />, root);
  void controller.boot();
  // Debug / e2e hook (e.g. `await __chessCoach.controller.idle()` in the console).
  (window as unknown as { __chessCoach?: { controller: GameController } }).__chessCoach = { controller };
}
