#!/usr/bin/env node
/**
 * App Store screenshots: renders the App Store build of the app in Chromium at the iPhone 6.9"
 * size (440 x 956 points at 3x = 1320 x 2868 pixels, the size App Store Connect requires) and saves
 * one PNG (RGB, no alpha) per screen to appstore/screenshots/:
 *
 *   01-new-game.png  the New game sheet (bot picker)
 *   02-coach.png     a game in progress: evaluation bar, move badge and the coach's explanation (Pro)
 *   03-hint.png      a hint: the best move as an arrow, with the reason (Pro)
 *   04-review.png    Game Review of a finished game: accuracy and move counts (both free)
 *   iap-review/paywall.png  the Pro paywall, with its price: ONLY the in-app purchase's App Review
 *                    screenshot (App Store Connect > the in-app purchase > Review Information), never
 *                    a product-page screenshot (Guideline 2.3.7: no prices in screenshots)
 *
 * Screens that show a Pro feature get a "Pro · in-app purchase" tag on the coach panel, as
 * Guideline 2.3.2 requires (screenshots must say which features need an extra purchase).
 *
 * Run it from the repository root (needs `npm ci`; takes a few minutes, mostly the engine):
 *
 *   node scripts/appstore-screenshots.mjs [options]
 *     --only=coach,hint   only these screens (names as above, without number and extension)
 *     --theme=light       light theme instead of the default dark one
 *     --no-status-bar     leave out the drawn iOS status bar ("9:41") at the top
 *     --skip-build        reuse the previous build (node_modules/.cache/chess-coach-screenshots)
 *     --port=5640         port for the local preview server (default 5640)
 *     --out=DIR           output folder (default appstore/screenshots)
 *
 * How: it builds the web app as the App Store app does (VITE_NATIVE=1: no service worker, files
 * served from the root) plus VITE_PAYWALL=1, so Pro is sold through the mock store of
 * src/native/purchases.ts. The build goes to node_modules/.cache, never to dist-native/ (which
 * `npx cap sync` copies into the iOS app). It serves that build with `vite preview` on 127.0.0.1,
 * drives the app through its debug hook (`window.__chessCoach.controller`) with the real engine,
 * and stops the server at the end. Each screen starts from seeded storage (a player rated 1180, a
 * game from a fixed move list); Pro is unlocked (`chesscoach.mockPro`) except for the paywall.
 * The safe areas of an iPhone 16/17 Pro Max (62 pt top, 34 pt bottom) are applied, so the layout
 * matches the device.
 *
 * Chromium: PW_CHROMIUM_PATH, else /opt/pw-browsers/chromium when present, else Playwright's own
 * (`npx playwright install chromium`). Fonts come from the machine: run it on a Mac for the iOS
 * system font, or take the screenshots on an iPhone or in the Simulator instead (see
 * docs/APP_STORE.md). The output folder gets a .gitignore, so the images are never committed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(ROOT, 'node_modules/.cache/chess-coach-screenshots');
const HOST = '127.0.0.1';

/** iPhone 6.9" (iPhone 16/17 Pro Max): 440 x 956 pt at 3x = 1320 x 2868 px. */
const VIEWPORT = { width: 440, height: 956 };
const SCALE = 3;
/** Safe-area insets of that iPhone in portrait (status bar / Dynamic Island, home indicator). */
const SAFE = { top: 62, bottom: 34 };

// ------------------------------------------------------------------------------------------------
// Options

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
};
if (flag('help') || flag('h')) {
  console.log('Usage: node scripts/appstore-screenshots.mjs [--only=a,b] [--theme=dark|light] [--no-status-bar] [--skip-build] [--port=5640] [--out=DIR]');
  process.exit(0);
}
const PORT = Number(option('port', process.env.SCREENSHOTS_PORT ?? '5640'));
const OUT = resolve(ROOT, option('out', 'appstore/screenshots'));
const THEME = option('theme', 'dark') === 'light' ? 'light' : 'dark';
const STATUS_BAR = !flag('no-status-bar');
const ONLY = option('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const BASE_URL = `http://${HOST}:${PORT}/`;

// ------------------------------------------------------------------------------------------------
// Seed data (localStorage keys and formats from src/game/persistence.ts, src/rating/rating.ts,
// src/theme.ts, src/native/purchases.ts and src/game/entitlements.ts)

/** The Opera Game (Paris, 1858): public-domain moves with sacrifices and a mate, a good review. */
const OPERA =
  'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#'.split(' ');

/** The Englund Gambit up to White's 6th move (White to move). */
const ENGLUND = 'd4 e5 dxe5 Nc6 Nf3 Qe7 Bf4 Qb4+ Bd2 Qxb2'.split(' ');

const SETTINGS = {
  playerColor: 'w',
  botId: 'otis',
  botElo: 1200,
  adaptive: false,
  coach: true,
  showEvalBar: true,
  showBestMoves: false,
  sound: false,
  allowTakebacks: true,
};

const PROFILE = { rating: 1180, gamesPlayed: 14, peak: 1215, wins: 7, draws: 2, losses: 5, history: [] };

/** A saved game against Otis (1200) with these SAN moves from the start; `over` = finished. */
function savedGame(id, moves, over) {
  return {
    version: 1,
    id,
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves,
    playerColor: 'w',
    botId: 'otis',
    botElo: 1200,
    botName: 'Otis',
    assisted: false,
    startedAt: '2026-10-01T18:30:00.000Z',
    annotations: {},
    ...(over ? { over } : {}),
  };
}

/** localStorage for a screen: the player, settings and theme, Pro unlocked unless `locked`. */
function storage({ game = null, locked = false } = {}) {
  const items = {
    'chesscoach.theme': THEME,
    'chesscoach.settings': JSON.stringify({ version: 1, settings: SETTINGS }),
    'chesscoach.profile': JSON.stringify({ version: 1, profile: PROFILE }),
  };
  if (game) items['chesscoach.game'] = JSON.stringify(game);
  if (!locked) {
    items['chesscoach.mockPro'] = '1'; // MOCK_PRO_KEY: the mock store's purchase
    items['chesscoach.pro'] = '1'; // PRO_CACHE_KEY: so the first frame is unlocked too
  }
  return items;
}

// ------------------------------------------------------------------------------------------------
// Screens. Each gets a fresh browser context with its storage, then `run(page)` gets it ready.

/** The tag on screens that show a Pro feature (Guideline 2.3.2). */
const PRO_TAG = 'Pro · in-app purchase';

/**
 * `file`: where the PNG goes in the output folder (default: the numbered product-page screenshot).
 * `proTag`: the screen shows a Pro feature, so it gets PRO_TAG.
 * @type {{ name: string; file?: string; proTag?: boolean; storage: Record<string, string>; run: (page: import('@playwright/test').Page) => Promise<void> }[]}
 */
const SCREENS = [
  {
    name: 'new-game',
    storage: storage(),
    async run(page) {
      await waitForApp(page);
      const sheet = page.getByRole('dialog', { name: 'New game' });
      await sheet.waitFor({ state: 'visible' });
      await page.waitForTimeout(800); // the sheet's slide-in
    },
  },
  {
    // The Englund Gambit trap: 1.d4 e5 2.dxe5 Nc6 3.Nf3 Qe7 4.Bf4 Qb4+ 5.Bd2 Qxb2, then the player
    // blunders 6.Bc3?? and the coach explains the double attack (Bb4) that wins a rook.
    name: 'coach',
    proTag: true,
    storage: storage({ game: savedGame('appstore-coach', ENGLUND) }),
    async run(page) {
      await waitForMyTurn(page);
      await idle(page);
      await play(page, 'd2', 'c3');
      await idle(page); // the coach's verdict and the bot's reply
      await waitForCoachVerdict(page);
      await waitForEval(page);
    },
  },
  {
    // Legal's trap: 1.e4 e5 2.Nf3 d6 3.Bc4 Bg4 4.Nc3 g6?, and the hint shows 5.Nxe5!
    name: 'hint',
    proTag: true,
    storage: storage({ game: savedGame('appstore-hint', 'e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6'.split(' ')) }),
    async run(page) {
      await waitForMyTurn(page);
      await idle(page);
      await page.evaluate(() => window.__chessCoach.controller.hint());
      await page.waitForFunction(() => {
        const m = window.__chessCoach.controller.store.coachMode.value;
        return m.kind === 'hint' && !!m.explanation;
      }, null, { timeout: 120_000 });
      await page.locator('.cg-shapes line').first().waitFor({ state: 'attached' });
      await waitForEval(page);
    },
  },
  {
    name: 'review',
    storage: storage({
      game: savedGame('appstore-review', OPERA, {
        outcome: { result: '1-0', winner: 'w', reason: 'Checkmate' },
        ratingChange: { before: 1164, after: 1180, rated: true },
      }),
    }),
    async run(page) {
      await waitForApp(page);
      await page.waitForFunction(() => window.__chessCoach.controller.store.phase.value === 'over');
      await page.evaluate(() => window.__chessCoach.controller.startReview());
      await page.waitForFunction(() => window.__chessCoach.controller.store.review.value?.progress === null, null, {
        timeout: 600_000,
      });
      await idle(page);
      await page.waitForTimeout(600);
    },
  },
  {
    // The coach screen's blunder with Pro locked: the verdict is free, "Unlock to see why" opens the
    // paywall. It shows the price, so it is only for the in-app purchase's App Review screenshot.
    name: 'paywall',
    file: 'iap-review/paywall.png',
    storage: storage({ game: savedGame('appstore-paywall', ENGLUND), locked: true }),
    async run(page) {
      await waitForMyTurn(page);
      await idle(page);
      await play(page, 'd2', 'c3');
      await idle(page);
      await waitForCoachVerdict(page);
      await page.locator('.app-panel .coach').getByRole('button', { name: 'Unlock to see why' }).tap();
      const paywall = page.getByRole('dialog', { name: /^Unlock .* Pro$/ });
      await paywall.waitFor({ state: 'visible' });
      await paywall.locator('[data-id="paywall-buy"]').filter({ hasText: /\$/ }).waitFor();
      await page.waitForTimeout(800); // the sheet's slide-in
    },
  },
];

// ------------------------------------------------------------------------------------------------
// Page helpers (the app's debug hook, see src/main.tsx)

async function waitForApp(page) {
  await page.waitForFunction(
    () => {
      const s = window.__chessCoach?.controller.store;
      return !!s && s.phase.value !== 'boot';
    },
    null,
    { timeout: 90_000 },
  );
  const phase = await page.evaluate(() => window.__chessCoach.controller.store.phase.value);
  if (phase === 'error') throw new Error('The engine could not start (phase "error"); try ?enginetest in the build.');
}

async function waitForMyTurn(page) {
  await waitForApp(page);
  await page.waitForFunction(
    () => {
      const s = window.__chessCoach.controller.store;
      return s.phase.value === 'playing' && s.humanToMove.value && s.isLive.value;
    },
    null,
    { timeout: 120_000 },
  );
}

/** Waits for the bot, background annotations, reviews and Show best to finish. */
const idle = (page) => page.evaluate(() => window.__chessCoach.controller.idle());

async function play(page, from, to) {
  const ok = await page.evaluate(([f, t]) => window.__chessCoach.controller.playerMove(f, t), [from, to]);
  if (!ok) throw new Error(`The move ${from}-${to} was not accepted.`);
}

/** The coach shows its verdict on the last move ("10. Nxb5 is …") with text, not a spinner. */
async function waitForCoachVerdict(page) {
  await page.waitForFunction(
    () => {
      const c = window.__chessCoach.controller.store.coach.value;
      return !!c && c.kind === 'coach' && !c.busy && !!c.cls && c.lines.length > 0;
    },
    null,
    { timeout: 120_000 },
  );
}

/** The evaluation bar has a settled number (not the pulsing "still thinking" state). */
async function waitForEval(page) {
  await page
    .waitForFunction(() => window.__chessCoach.controller.store.evalBar.value.thinking === false, null, { timeout: 30_000 })
    .catch(() => console.warn('  (the evaluation bar was still thinking)'));
  await page.waitForTimeout(500); // the bar's animation
}

// ------------------------------------------------------------------------------------------------
// The device frame: safe areas and an iOS-style status bar

function deviceCss() {
  return `
:root:root {
  --safe-top: ${SAFE.top}px !important;
  --safe-bottom: ${SAFE.bottom}px !important;
}
#appstore-status-bar {
  position: fixed; top: 0; left: 0; right: 0; height: 54px; z-index: 2147483647;
  display: flex; align-items: center; justify-content: space-between; padding: 6px 32px 0 52px;
  box-sizing: border-box; pointer-events: none;
  color: ${THEME === 'light' ? '#000' : '#fff'};
  font: 600 17px/1 -apple-system, "SF Pro Text", system-ui, "Helvetica Neue", Arial, sans-serif;
  letter-spacing: -0.2px;
}
#appstore-status-bar .icons { display: flex; gap: 7px; align-items: center; }
.app-panel .coach-bubble { position: relative; }
#appstore-pro-tag {
  position: absolute; top: -11px; right: 12px; z-index: 5; pointer-events: none;
  padding: 4px 10px; border-radius: 999px; background: #e3b341; color: #1d1c1a;
  font: 700 12px/1.2 -apple-system, "SF Pro Text", system-ui, "Helvetica Neue", Arial, sans-serif;
  letter-spacing: 0.2px; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
`;
}

/** Tags the coach panel with PRO_TAG (the screen shows a Pro feature). */
async function tagPro(page) {
  await page.evaluate((text) => {
    const bubble = document.querySelector('.app-panel .coach-bubble');
    if (!bubble) throw new Error('No coach panel to tag as Pro');
    const tag = document.createElement('span');
    tag.id = 'appstore-pro-tag';
    tag.textContent = text;
    bubble.append(tag);
  }, PRO_TAG);
}

function statusBarHtml() {
  // Cellular bars, Wi-Fi and a full battery, drawn in the text color.
  return `<div id="appstore-status-bar" aria-hidden="true"><span>9:41</span><span class="icons">
<svg width="19" height="12" viewBox="0 0 19 12" fill="currentColor"><rect x="0" y="8" width="3.2" height="4" rx="0.8"/><rect x="5" y="5.5" width="3.2" height="6.5" rx="0.8"/><rect x="10" y="3" width="3.2" height="9" rx="0.8"/><rect x="15" y="0" width="3.2" height="12" rx="0.8"/></svg>
<svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><path d="M8.5 2.3c2.4 0 4.6.9 6.3 2.5l1.2-1.2C14 1.6 11.4.5 8.5.5S3 1.6 1 3.6l1.2 1.2C3.9 3.2 6.1 2.3 8.5 2.3Z"/><path d="M8.5 5.6c1.5 0 2.9.6 3.9 1.6l1.2-1.2C12.3 4.7 10.5 3.9 8.5 3.9S4.7 4.7 3.4 6l1.2 1.2c1-1 2.4-1.6 3.9-1.6Z"/><path d="M8.5 8.8c.7 0 1.3.3 1.7.7L8.5 11.3 6.8 9.5c.4-.4 1-.7 1.7-.7Z"/></svg>
<svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" stroke="currentColor" opacity="0.4"/><rect x="2" y="2" width="20" height="9" rx="2.2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="currentColor" opacity="0.4"/></svg>
</span></div>`;
}

// ------------------------------------------------------------------------------------------------
// Build, serve, capture

function run(cmd, cmdArgs, env) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (${r.status ?? r.signal})`);
}

function viteCli() {
  const require = createRequire(join(ROOT, 'package.json'));
  return join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
}

function build() {
  console.log('Building the App Store web app with the mock store (VITE_NATIVE=1 VITE_PAYWALL=1)…');
  run(process.execPath, [viteCli(), 'build', '--outDir', BUILD_DIR, '--emptyOutDir', '--logLevel', 'warn'], {
    VITE_NATIVE: '1',
    VITE_PAYWALL: '1',
    BASE_PATH: '/',
  });
}

async function serve() {
  const server = spawn(
    process.execPath,
    [viteCli(), 'preview', '--outDir', BUILD_DIR, '--port', String(PORT), '--strictPort', '--host', HOST],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, VITE_NATIVE: '1', VITE_PAYWALL: '1' } },
  );
  let stderr = '';
  server.stderr.on('data', (d) => (stderr += d));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`vite preview exited: ${stderr.trim() || server.exitCode}`);
    try {
      if ((await fetch(BASE_URL)).ok) return server;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  server.kill();
  throw new Error(`vite preview did not answer on ${BASE_URL}: ${stderr.trim()}`);
}

function chromiumPath() {
  if (process.env.PW_CHROMIUM_PATH) return process.env.PW_CHROMIUM_PATH;
  return existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
}

/** Width, height and PNG color type (2 = RGB, 6 = RGBA) of a PNG file. */
function pngInfo(file) {
  const fd = openSync(file, 'r');
  const b = Buffer.alloc(26);
  readSync(fd, b, 0, 26, 0);
  closeSync(fd);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

/** The output file of a screen: its `file`, or the numbered product-page screenshot. */
function outFile(screen, number) {
  return join(OUT, screen.file ?? `${String(number).padStart(2, '0')}-${screen.name}.png`);
}

async function capture(browser, screen, number) {
  const context = await browser.newContext({
    ...devices['iPhone 15 Pro'],
    viewport: VIEWPORT,
    screen: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: THEME,
    serviceWorkers: 'block',
  });
  await context.addInitScript(
    ({ items, css, bar }) => {
      try {
        if (!sessionStorage.getItem('appstore-screenshots')) {
          localStorage.clear();
          for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
          sessionStorage.setItem('appstore-screenshots', '1');
        }
      } catch {
        // storage blocked: the app starts fresh
      }
      const add = () => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.append(style);
        if (bar) document.body.insertAdjacentHTML('beforeend', bar);
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
      else add();
    },
    { items: screen.storage, css: deviceCss(), bar: STATUS_BAR ? statusBarHtml() : '' },
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(BASE_URL);
    await screen.run(page);
    if (screen.proTag) await tagPro(page);
    const file = outFile(screen, number);
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
    const info = pngInfo(file);
    const note = info.colorType === 2 ? '' : ` (WARNING: PNG color type ${info.colorType}, App Store needs RGB without alpha)`;
    console.log(`  ${relative(process.cwd(), file)}: ${info.width} x ${info.height}${note}`);
    if (errors.length) console.warn(`  page errors: ${errors.join(' | ')}`);
  } finally {
    await context.close();
  }
}

async function main() {
  // Product-page screenshots are numbered in order; the others (`file`) are not.
  let n = 0;
  const screens = SCREENS.map((s) => ({ ...s, number: s.file ? 0 : ++n })).filter(
    (s) => !ONLY.length || ONLY.includes(s.name),
  );
  if (!screens.length) throw new Error(`No screen matches --only=${ONLY.join(',')} (have: ${SCREENS.map((s) => s.name).join(', ')})`);
  if (!flag('skip-build') || !existsSync(join(BUILD_DIR, 'index.html'))) build();
  mkdirSync(OUT, { recursive: true });
  // Never commit the images (they are rebuilt from the app whenever needed).
  writeFileSync(join(OUT, '.gitignore'), '# Generated by scripts/appstore-screenshots.mjs\n*\n');

  const server = await serve();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromiumPath() });
    console.log(`Capturing ${screens.length} screen(s) at ${VIEWPORT.width * SCALE} x ${VIEWPORT.height * SCALE} (${THEME} theme)…`);
    for (const s of screens) await capture(browser, s, s.number);
  } finally {
    await browser?.close();
    server.kill();
  }
  console.log(`Done: ${relative(process.cwd(), OUT) || '.'}/`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
