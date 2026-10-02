import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the production build (`vite build` + `vite preview`), because the
 * service worker and precache only exist there. `BASE_PATH=/chess/ npx playwright test` checks the
 * GitHub Pages layout.
 *
 * WebKit is not available in every environment, so the iPhone project uses Chromium with the
 * iPhone 15 Pro descriptor (user agent, DPR 3, touch). Set PW_CHROMIUM_PATH to use a specific
 * Chromium binary; /opt/pw-browsers/chromium is picked up automatically when present.
 *
 * e2e/paywall.spec.ts runs against a second build made with VITE_PAYWALL=1 (Pro locked, a mock
 * App Store steered through `window.__mockStore`, see src/native/purchases.ts), served on its own
 * port from a git-ignored folder, so the PWA build the other tests use stays unlocked.
 */
const PORT = 4173;
const PAYWALL_PORT = 4174;
const HOST = '127.0.0.1';
const BASE_PATH = process.env.BASE_PATH ?? '/';
const BASE_URL = `http://${HOST}:${PORT}${BASE_PATH}`;
const PAYWALL_URL = `http://${HOST}:${PAYWALL_PORT}${BASE_PATH}`;
/** Where the VITE_PAYWALL=1 build goes (inside node_modules: ignored by git, never deployed). */
const PAYWALL_DIR = 'node_modules/.cache/chess-coach-paywall';
const PAYWALL_SPEC = /paywall\.spec\.ts$/;

const LOCAL_CHROMIUM = '/opt/pw-browsers/chromium';
const chromiumPath = process.env.PW_CHROMIUM_PATH || (existsSync(LOCAL_CHROMIUM) ? LOCAL_CHROMIUM : undefined);

const IPHONE = {
  ...devices['iPhone 15 Pro'],
  browserName: 'chromium' as const,
  // The installed (Home Screen) app gets the whole screen, not Safari's 393x659 viewport.
  viewport: { width: 393, height: 852 },
  launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
};

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `npx vite build && npx vite preview --port ${PORT} --strictPort --host ${HOST}`,
      url: BASE_URL,
      // Always test a fresh build rather than whatever happens to be listening on the port.
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command:
        `npx vite build --outDir ${PAYWALL_DIR} --emptyOutDir && ` +
        `npx vite preview --outDir ${PAYWALL_DIR} --port ${PAYWALL_PORT} --strictPort --host ${HOST}`,
      env: { VITE_PAYWALL: '1' },
      url: PAYWALL_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
  projects: [
    {
      name: 'iphone',
      testIgnore: PAYWALL_SPEC,
      use: IPHONE,
    },
    {
      name: 'iphone-paywall',
      testMatch: PAYWALL_SPEC,
      use: { ...IPHONE, baseURL: PAYWALL_URL },
    },
  ],
});
