/**
 * Foldable screens (the iPhone Duo) end to end, on the production build. Chromium emulates the fold
 * for real through the DevTools protocol: `Emulation.setDeviceMetricsOverride` with a display feature
 * (a 'vertical' one runs from top to bottom: two segments side by side, so `window.viewport.segments`
 * and the `(horizontal-viewport-segments: 2)` media feature report them, as Chromium does on a
 * foldable) and `Emulation.setDevicePostureOverride` ('folded': the `(device-posture: folded)` media
 * feature). WebKit's case (Safari, the App Store app), with no segments API, hides `window.viewport` so
 * the app's heuristic (an iPhone with a big, nearly square screen) finds the fold: in the installed
 * app (the window covers the screen) and in a Safari tab held like a book (shorter, under the
 * toolbars). The safe areas are simulated through the `--safe-*` custom properties (Chromium can't
 * emulate env(safe-area-inset-*)): the Duo's system UI along the right edge of its open inner
 * display, or the left one with the device turned around (the app re-reads them without a resize).
 *
 * Covered: the inner display open like a book (the board in the left segment, the panel, the move
 * list and the toolbar in the right one; moves by tapping; the coach), the heuristic in landscape (the
 * installed app and a Safari tab) and in portrait (whole screen; tabletop only with a posture, which
 * no WebKit reports yet), the segments API's stacked fold, the outer display both ways, the Split
 * View widths and the @2x size (no sideways scroll, every toolbar button in sight and at least 44 px,
 * nothing overlapping), folding and unfolding mid-game (the position, the moves, the coach, Draw mode,
 * the explorer and an open sheet kept, nothing re-created, a piece picked up put down), the sheets
 * and messages in the panel's segment, the system UI on the left, the status bar's band in the light
 * theme, and the Menu's "Foldable screen" setting (offered, and acting, only where a fold can be).
 *
 * Note: Playwright's page.screenshot() and page.setViewportSize() reset the device metrics (and the
 * fold with them), so this file sizes the page through the protocol only.
 */
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';

interface Hook {
  controller: {
    newGame(settings: object, opts?: { startFen?: string }): void;
    toggleDraw(): void;
    requestExplore(): void;
    openSheet(name: string): void;
    closeSheet(): void;
    resign(): void;
    startReview(): Promise<void>;
    exitPractice(): void;
    idle(): Promise<void>;
    store: {
      review: { value: { progress: number | null } | null };
      settings: { value: object };
      phase: { value: string };
      humanToMove: { value: boolean };
      isLive: { value: boolean };
      liveFen: { value: string };
      plies: { value: { san: string }[] };
      position: { value: { dests: Map<string, string[]> } };
    };
  };
}
type Win = { __chessCoach?: Hook };

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A window: its size, the screen it is on, the fold (a CDP display feature), the posture and the safe areas. */
interface Viewport {
  name: string;
  width: number;
  height: number;
  screen?: { width: number; height: number };
  fold?: { orientation: 'vertical' | 'horizontal'; offset: number; maskLength: number };
  posture?: 'folded' | 'continuous';
  dpr?: number;
}

/** The iPhone Duo's estimated sizes in CSS px (@3x), see src/layout/fold.ts. */
const INNER_L: Viewport = { name: 'inner landscape', width: 890, height: 626, fold: { orientation: 'vertical', offset: 445, maskLength: 0 } };
const INNER_P_API: Viewport = { name: 'inner portrait', width: 626, height: 890, fold: { orientation: 'horizontal', offset: 445, maskLength: 0 } };
const OUTER_P: Viewport = { name: 'outer portrait', width: 466, height: 678 };
const OUTER_L: Viewport = { name: 'outer landscape', width: 678, height: 466 };
/** Split View on the inner display: the window is part of the 890 × 626 screen. */
const split = (width: number): Viewport => ({ name: `Split View ${width}`, width, height: 626, screen: { width: 890, height: 626 } });
const AT_2X: Viewport = { name: '@2x', width: 1335, height: 939, dpr: 2, fold: { orientation: 'vertical', offset: 667, maskLength: 0 } };

/** The open inner display's system UI along its right edge (estimates). */
const BOOK_INSETS = { top: 0, right: 56, bottom: 20, left: 0 };

const tool = (page: Page, id: string): Locator => page.locator(`.app-tools .toolbar-btn[data-id="${id}"]`);
const boardBox = async (page: Page): Promise<Box> => (await page.locator('.app-board-cell .board').boundingBox())!;

/** Sizes the page (and its screen), with the fold and the posture, through the DevTools protocol. */
async function emulate(cdp: CDPSession, vp: Viewport): Promise<void> {
  const screen = vp.screen ?? { width: vp.width, height: vp.height };
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: vp.dpr ?? 3,
    mobile: true,
    screenWidth: screen.width,
    screenHeight: screen.height,
    ...(vp.fold ? { displayFeature: vp.fold } : {}),
  });
  if (vp.posture) await cdp.send('Emulation.setDevicePostureOverride', { posture: { type: vp.posture } });
  else await cdp.send('Emulation.clearDevicePostureOverride');
}

/** The safe areas, as the app reads them (src/styles/app.css). */
async function setInsets(page: Page, insets: { top: number; right: number; bottom: number; left: number }): Promise<void> {
  await page.evaluate((i) => {
    let style = document.getElementById('test-insets');
    if (!style) {
      style = document.createElement('style');
      style.id = 'test-insets';
      document.head.append(style);
    }
    style.textContent = `:root:root { --safe-top: ${i.top}px !important; --safe-right: ${i.right}px !important; --safe-bottom: ${i.bottom}px !important; --safe-left: ${i.left}px !important; }`;
  }, insets);
}

/** The app is up and its fold layout settled for the current size (a frame for the resize to land). */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(150);
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as unknown as Win).__chessCoach?.controller.store;
    return !!s && s.phase.value !== 'boot';
  }, null, { timeout: 30_000 });
}

async function waitForMyTurn(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as unknown as Win).__chessCoach!.controller.store;
    return s.phase.value === 'playing' && s.humanToMove.value && s.isLive.value;
  }, null, { timeout: 30_000 });
}

/** Opens the app at `vp` and starts a game against Pip (White, the coach on). */
async function openGame(page: Page, cdp: CDPSession, vp: Viewport, opts: { noSegmentsApi?: boolean } = {}): Promise<void> {
  if (opts.noSegmentsApi) {
    // Safari and the App Store app's WKWebView have no Viewport Segments API, and no Device Posture
    // API either (as of mid-2026): the posture's media feature shows again once a test sets
    // `__postureApi` (a WebKit that would have it).
    await page.addInitScript(() => {
      Object.defineProperty(window, 'viewport', { value: undefined, configurable: true });
      Object.defineProperty(Navigator.prototype, 'devicePosture', { configurable: true, get: () => undefined });
      const w = window as unknown as { __postureApi?: boolean };
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query: string) => {
        const mql = matchMedia(query);
        if (!query.includes('device-posture')) return mql;
        return new Proxy(mql, {
          get(target, key) {
            if (key === 'matches') return w.__postureApi ? target.matches : false;
            const v = Reflect.get(target, key) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        });
      };
    });
  }
  await emulate(cdp, vp);
  await page.goto('./');
  await waitForApp(page);
  await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible();
  await page.evaluate(() => {
    const c = (window as unknown as Win).__chessCoach!.controller;
    c.newGame({ ...c.store.settings.value, playerColor: 'w', botId: 'pip', botElo: 100, adaptive: false, coach: true, showEvalBar: true });
  });
  await expect(page.getByRole('dialog', { name: 'New game' })).toBeHidden();
  await waitForMyTurn(page);
  await settle(page);
}

/** The center of a square on the game's board. */
async function tapSquare(page: Page, square: string): Promise<void> {
  const box = (await page.locator('.app-board-cell .board cg-board').boundingBox())!;
  const white = await page.locator('.app-board-cell .cg-wrap').evaluate((el) => el.classList.contains('orientation-white'));
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const size = box.width / 8;
  const col = white ? file : 7 - file;
  const row = white ? 7 - rank : rank;
  await page.touchscreen.tap(box.x + (col + 0.5) * size, box.y + (row + 0.5) * size);
}

/** A quiet move by tapping its squares, the bot's reply, and the coach's panel in sight. */
async function playAndSeeCoach(page: Page, label: string): Promise<void> {
  await play(page, await quietMove(page));
  await waitForMyTurn(page);
  await expect(page.locator('.app-panel .coach').first(), label).toBeVisible();
}

async function play(page: Page, uci: string): Promise<void> {
  const before = await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.plies.value.length);
  await tapSquare(page, uci.slice(0, 2));
  await tapSquare(page, uci.slice(2, 4));
  await page.waitForFunction((n) => (window as unknown as Win).__chessCoach!.controller.store.plies.value.length > n, before);
}

/** A quiet developing move for White that is legal now. */
async function quietMove(page: Page): Promise<string> {
  const all = await page.evaluate(() => {
    const out: string[] = [];
    for (const [from, tos] of (window as unknown as Win).__chessCoach!.controller.store.position.value.dests) for (const to of tos) out.push(from + to);
    return out;
  });
  return ['g1f3', 'b1c3', 'd2d3', 'f1e2', 'c2c3', 'a2a3', 'h2h3'].find((m) => all.includes(m)) ?? all[0];
}

/** Nothing scrolls sideways, every toolbar button is in sight and at least 44 px, no text is cut, nothing overlaps. */
async function expectTidy(page: Page, label: string): Promise<void> {
  const m = await page.evaluate(() => {
    const r = (el: Element | null) => {
      const b = el?.getBoundingClientRect();
      return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
    };
    const doc = document.scrollingElement!;
    const app = document.getElementById('app')!;
    const tools = [...document.querySelectorAll('.app-tools .toolbar-btn')].map((b) => ({
      id: (b as HTMLElement).dataset.id,
      shown: (b as HTMLElement).offsetParent !== null,
      box: r(b)!,
      cut: [...b.querySelectorAll('.toolbar-label')].some((l) => l.scrollWidth > l.clientWidth + 1),
    }));
    return {
      w: innerWidth,
      h: innerHeight,
      overflow: Math.max(doc.scrollWidth, app.scrollWidth) - innerWidth,
      tools,
      board: r(document.querySelector('.app-board-cell .board')),
      panel: r(document.querySelector('.app-panel')),
      moves: r(document.querySelector('.app-moves')),
      toolbar: r(document.querySelector('.app-tools')),
    };
  });
  const tag = `${label} (${m.w}x${m.h})`;
  expect(m.overflow, `${tag}: sideways scroll`).toBeLessThanOrEqual(1);
  const shown = m.tools.filter((t) => t.shown);
  expect(shown.length, `${tag}: toolbar buttons`).toBeGreaterThanOrEqual(6);
  for (const t of shown) {
    expect(t.box.width, `${tag}: ${t.id} width`).toBeGreaterThanOrEqual(44);
    expect(t.box.height, `${tag}: ${t.id} height`).toBeGreaterThanOrEqual(44);
    expect(t.box.x >= -1 && t.box.x + t.box.width <= m.w + 1 && t.box.y + t.box.height <= m.h + 1, `${tag}: ${t.id} in sight`).toBe(true);
    expect(t.cut, `${tag}: ${t.id} label cut`).toBe(false);
  }
  const b = m.board!;
  expect(b.x >= -1 && b.y >= -1 && b.x + b.width <= m.w + 1 && b.y + b.height <= m.h + 1, `${tag}: board in sight`).toBe(true);
  const overlaps = (p: Box, q: Box) => p.x < q.x + q.width - 1 && q.x < p.x + p.width - 1 && p.y < q.y + q.height - 1 && q.y < p.y + p.height - 1;
  for (const [name, other] of [['panel', m.panel], ['moves', m.moves], ['toolbar', m.toolbar]] as const) {
    if (other && other.width > 0 && other.height > 0) expect(overlaps(b, other), `${tag}: board overlaps the ${name}`).toBe(false);
  }
  expect(overlaps(m.toolbar!, m.moves!), `${tag}: the move list overlaps the toolbar`).toBe(false);
}

/** Where a toast can show: the toast layer's box inside its padding. */
async function toastArea(page: Page): Promise<{ left: number; right: number }> {
  return page.evaluate(() => {
    const host = document.querySelector('.app-toast-host')!;
    const b = host.getBoundingClientRect();
    const cs = getComputedStyle(host);
    return { left: b.left + parseFloat(cs.paddingLeft), right: b.right - parseFloat(cs.paddingRight) };
  });
}

/**
 * The installed app's look: the `(display-mode: standalone)` rules applied as if they matched
 * (Chromium can't emulate the display mode).
 */
async function standalone(page: Page): Promise<void> {
  await page.evaluate(() => {
    const css: string[] = [];
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule && rule.conditionText.includes('display-mode: standalone')) {
          for (const inner of rule.cssRules) css.push(inner.cssText);
        }
      }
    }
    const style = document.createElement('style');
    style.id = 'test-standalone';
    style.textContent = css.join('\n');
    document.head.append(style);
  });
}

test.describe('Foldable screens', () => {
  test('open like a book: the board in the left segment, the coach and controls in the right one', async ({ page }) => {
    test.setTimeout(90_000);
    const cdp = await page.context().newCDPSession(page);
    await openGame(page, cdp, INNER_L);
    await setInsets(page, BOOK_INSETS);
    await settle(page);
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'book');
    await expect(page.locator('.app')).toHaveAttribute('data-fold', 'book');

    // The board (and its eval bar and strips) stays 8 px clear of the fold; the panel starts 8 px after it.
    const board = await boardBox(page);
    expect(board.x).toBeGreaterThanOrEqual(0);
    expect(board.x + board.width).toBeLessThanOrEqual(445 - 8 + 0.5);
    expect(board.width).toBeGreaterThan(395); // the left segment's width, not the height, limits it
    for (const sel of ['.app-player--top', '.app-player--bottom', '.evalbar']) {
      const b = (await page.locator(sel).first().boundingBox())!;
      expect(b.x + b.width, sel).toBeLessThanOrEqual(445 - 8 + 0.5);
    }
    for (const sel of ['.app-panel', '.app-moves', '.app-tools']) {
      const b = (await page.locator(sel).boundingBox())!;
      expect(b.x, sel).toBeGreaterThanOrEqual(445 + 8 - 0.5);
      // Inside the safe area: clear of the system UI along the right edge.
      expect(b.x + b.width, sel).toBeLessThanOrEqual(890 - 56 + 0.5);
    }
    // All seven buttons of a game (New is back: the panel's segment is wide enough).
    await expect(tool(page, 'newGame')).toBeVisible();
    await expectTidy(page, 'book');

    // Moves by tapping squares; the coach rates them; the move list wraps into rows.
    await play(page, 'e2e4');
    await expect(page.locator('.app-panel .coach .class-icon').first()).toBeVisible({ timeout: 30_000 });
    await waitForMyTurn(page);
    await play(page, await quietMove(page));
    await waitForMyTurn(page);
    await expect(page.locator('.app-panel .coach-title')).toHaveText(/^2\. \S+/, { timeout: 30_000 });
    const rows = await page.locator('.app-moves .mlist').evaluate((el) => getComputedStyle(el).flexWrap);
    expect(rows).toBe('wrap');
    await expectTidy(page, 'book, two moves in');
  });

  test('WebKit (no segments API): the heuristic splits the inner display in landscape, in the installed app and in a Safari tab; in portrait the screen is used whole', async ({ page }) => {
    test.setTimeout(120_000);
    const cdp = await page.context().newCDPSession(page);
    // Safari keeps screen.width/height in portrait: an iPhone (the user agent) with a 626 × 890 screen.
    const landscape: Viewport = { name: 'inner landscape (installed app)', width: 890, height: 626, screen: { width: 626, height: 890 } };
    await openGame(page, cdp, landscape, { noSegmentsApi: true });
    expect(await page.evaluate(() => 'viewport' in window && (window as { viewport?: unknown }).viewport)).toBeFalsy();
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'book');
    const board = await boardBox(page);
    expect(board.x + board.width).toBeLessThanOrEqual(445 - 8 + 0.5);
    await expectTidy(page, 'heuristic book');
    await playAndSeeCoach(page, 'heuristic book');

    // A Safari tab: its toolbars take some of the height, not the width; the fold is where it was.
    await emulate(cdp, { name: 'inner landscape (Safari tab)', width: 890, height: 556, screen: { width: 626, height: 890 } });
    await setInsets(page, BOOK_INSETS);
    await settle(page);
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'book');
    const tab = await boardBox(page);
    expect(tab.x + tab.width).toBeLessThanOrEqual(445 - 8 + 0.5);
    await expectTidy(page, 'heuristic book, Safari tab');
    // Its Menu says how to split the screen half folded (WebKit doesn't report the posture).
    await tool(page, 'menu').click();
    const menu = page.getByRole('dialog', { name: 'Menu' });
    await expect(menu.locator('[data-id="foldable"] .sheet-note')).toContainText('choose “Keep the board off the fold.”');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Turned upright: the fold runs across the middle, and the screen is used whole (the coach and
    // the move list side by side under the board).
    await emulate(cdp, { name: 'inner portrait (Safari)', width: 626, height: 890, screen: { width: 626, height: 890 } });
    await setInsets(page, { top: 56, right: 0, bottom: 20, left: 0 });
    await settle(page);
    await expect(page.locator('html')).not.toHaveAttribute('data-fold', /./);
    const whole = await boardBox(page);
    expect(whole.width).toBeGreaterThan(440);
    const panel = (await page.locator('.app-panel').boundingBox())!;
    const moves = (await page.locator('.app-moves').boundingBox())!;
    expect(moves.x, 'the move list beside the coach').toBeGreaterThanOrEqual(panel.x + panel.width - 1);
    expect(Math.abs(moves.y - panel.y), 'the move list beside the coach').toBeLessThan(12);
    await expect(page.locator('.app-panel')).not.toHaveAttribute('data-tight', /.*/); // the whole verdict, not one row
    await expectTidy(page, 'heuristic portrait');
    await playAndSeeCoach(page, 'heuristic portrait');
    // Upright in a Safari tab (toolbars at the top or bottom would move the fold in the window): no fold assumed.
    await emulate(cdp, { name: 'inner portrait (Safari tab)', width: 626, height: 800, screen: { width: 626, height: 890 } });
    await settle(page);
    await expect(page.locator('html')).not.toHaveAttribute('data-fold', /./);

    // A WebKit that reports the posture (none does as of mid-2026; here the `(device-posture)` media
    // feature, emulated) half folded (tabletop): the board in the top half, everything else in the bottom one.
    await emulate(cdp, { name: 'inner portrait, tabletop', width: 626, height: 890, screen: { width: 626, height: 890 }, posture: 'folded' });
    // (Its API there from the start, the app would hear the change; here it shows up now: a resize reads it.)
    await page.evaluate(() => {
      (window as unknown as { __postureApi?: boolean }).__postureApi = true;
      window.dispatchEvent(new Event('resize'));
    });
    await settle(page);
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'tabletop');
    const top = await boardBox(page);
    expect(top.y + top.height).toBeLessThanOrEqual(445 - 8 + 0.5);
    for (const sel of ['.app-panel', '.app-moves', '.app-tools']) {
      expect((await page.locator(sel).boundingBox())!.y, sel).toBeGreaterThanOrEqual(445 + 8 - 0.5);
    }
    await expectTidy(page, 'heuristic tabletop');
    await playAndSeeCoach(page, 'heuristic tabletop');
  });

  test('a fold from the segments API splits in any posture; the outer display, Split View and @2x stay tidy', async ({ page }) => {
    test.setTimeout(120_000);
    const cdp = await page.context().newCDPSession(page);
    await openGame(page, cdp, INNER_P_API);
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'tabletop');
    const top = await boardBox(page);
    expect(top.y + top.height).toBeLessThanOrEqual(445 - 8 + 0.5);
    await play(page, 'e2e4');
    await waitForMyTurn(page);
    await expect(page.locator('.app-panel .coach').first()).toBeVisible();
    await expectTidy(page, 'API tabletop');

    // The outer display: a short, wide screen, the board a good deal bigger than before (≈ 315 px).
    await emulate(cdp, OUTER_P);
    await setInsets(page, { top: 54, right: 0, bottom: 28, left: 0 });
    await settle(page);
    await expect(page.locator('html')).not.toHaveAttribute('data-fold', /./);
    expect((await boardBox(page)).width).toBeGreaterThanOrEqual(360);
    await expectTidy(page, 'outer portrait');
    await playAndSeeCoach(page, 'outer portrait');
    await emulate(cdp, OUTER_L);
    await setInsets(page, { top: 0, right: 54, bottom: 21, left: 54 });
    await settle(page);
    expect((await boardBox(page)).width).toBeGreaterThanOrEqual(280);
    await expectTidy(page, 'outer landscape');
    await playAndSeeCoach(page, 'outer landscape');

    // Split View: the window is part of the screen, where the fold falls in it is unknown; the layout
    // follows the window.
    await setInsets(page, { top: 0, right: 0, bottom: 20, left: 0 });
    for (const width of [445, 296, 594, 320, 375]) {
      await emulate(cdp, split(width));
      await settle(page);
      await expect(page.locator('html'), `${width}`).not.toHaveAttribute('data-fold', /./);
      await expectTidy(page, `Split View ${width}`);
      if (width === 296 || width === 594) await playAndSeeCoach(page, `Split View ${width}`);
    }

    // The @2x possibility: the same book layout, bigger.
    await emulate(cdp, AT_2X);
    await setInsets(page, { top: 0, right: 84, bottom: 30, left: 0 });
    await settle(page);
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'book');
    const big = await boardBox(page);
    expect(big.x + big.width).toBeLessThanOrEqual(667 - 8 + 0.5);
    expect(big.width).toBeGreaterThan(600);
    await expectTidy(page, '@2x');
    await playAndSeeCoach(page, '@2x');
  });

  test('folding and unfolding mid-game keeps the position, the moves, Draw mode, the explorer and an open sheet', async ({ page }) => {
    test.setTimeout(120_000);
    const cdp = await page.context().newCDPSession(page);
    await openGame(page, cdp, OUTER_P);
    await setInsets(page, { top: 54, right: 0, bottom: 28, left: 0 });
    await settle(page);
    await play(page, 'e2e4');
    await waitForMyTurn(page);
    await play(page, await quietMove(page));
    await waitForMyTurn(page);
    const state = () =>
      page.evaluate(() => {
        const s = (window as unknown as Win).__chessCoach!.controller.store;
        return { fen: s.liveFen.value, moves: s.plies.value.map((p) => p.san).join(' ') };
      });
    const before = await state();
    const moveCount = await page.locator('.mlist-move').count();
    const coach = await page.locator('.app-panel .coach-title').textContent();
    // The same board, move list and toolbar throughout: a fold is a resize, nothing is re-created (only
    // chessground redraws its squares at the new size, as on any resize).
    await page.evaluate(() => {
      for (const sel of ['.app-board-cell .board', '.app-moves .mlist', '.app-tools .toolbar']) {
        (document.querySelector(sel) as HTMLElement & { keep?: boolean }).keep = true;
      }
    });
    const kept = () =>
      page.evaluate(() =>
        ['.app-board-cell .board', '.app-moves .mlist', '.app-tools .toolbar'].every(
          (sel) => (document.querySelector(sel) as (HTMLElement & { keep?: boolean }) | null)?.keep === true,
        ),
      );
    // A piece picked up on the outer display is put down when the board changes size.
    await tapSquare(page, 'a2');
    await expect(page.locator('.app-board-cell cg-board square.selected')).toHaveCount(1);

    // Unfold, fold, unfold: the same game, move list and coach.
    for (const [vp, insets, fold] of [
      [INNER_L, BOOK_INSETS, 'book'],
      [OUTER_P, { top: 54, right: 0, bottom: 28, left: 0 }, null],
      [INNER_L, BOOK_INSETS, 'book'],
    ] as const) {
      await emulate(cdp, vp);
      await setInsets(page, insets);
      await settle(page);
      if (fold) await expect(page.locator('html')).toHaveAttribute('data-fold', fold);
      else await expect(page.locator('html')).not.toHaveAttribute('data-fold', /./);
      expect(await state(), vp.name).toEqual(before);
      expect(await kept(), `${vp.name}: re-created`).toBe(true);
      await expect(page.locator('.app-board-cell cg-board square.selected')).toHaveCount(0);
      await expect(page.locator('.mlist-move')).toHaveCount(moveCount);
      await expect(page.locator('.app-panel .coach-title')).toHaveText(coach ?? '');
      await expect(page.locator('.mlist-move[aria-current="true"]')).toBeVisible();
    }

    // Draw mode stays on through a fold and an unfold; a move still works after it.
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.toggleDraw());
    await expect(page.getByRole('toolbar', { name: 'Draw' })).toBeVisible();
    await emulate(cdp, OUTER_P);
    await settle(page);
    await expect(page.getByRole('toolbar', { name: 'Draw' })).toBeVisible();
    await emulate(cdp, INNER_L);
    await settle(page);
    await expect(page.getByRole('toolbar', { name: 'Draw' })).toBeVisible();
    await page.getByRole('toolbar', { name: 'Draw' }).getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('toolbar', { name: 'Draw' })).toBeHidden();

    // The explorer too.
    await tool(page, 'explore').click();
    await expect(page.locator('.app')).toHaveAttribute('data-exploring', '');
    await emulate(cdp, OUTER_P);
    await settle(page);
    await expect(page.locator('.app')).toHaveAttribute('data-exploring', '');
    await expect(page.locator('.xpanel').first()).toBeVisible();
    await tool(page, 'explorerExit').click();
    await expect(page.locator('.app')).not.toHaveAttribute('data-exploring', /.*/);

    // An open sheet stays open, and moves into the panel's segment when the screen splits.
    await tool(page, 'menu').click();
    const menu = page.getByRole('dialog', { name: 'Menu' });
    await expect(menu).toBeVisible();
    await emulate(cdp, INNER_L);
    await settle(page);
    await expect(menu).toBeVisible();
    await expect.poll(async () => (await menu.boundingBox())!.x).toBeGreaterThanOrEqual(445 + 8 - 0.5);
    await emulate(cdp, OUTER_P);
    await settle(page);
    await expect(menu).toBeVisible();
    expect(await state()).toEqual(before);

    // And the game goes on.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await play(page, await quietMove(page));
  });

  test('sheets open in the panel’s segment, never across the fold', async ({ page }) => {
    test.setTimeout(90_000);
    const cdp = await page.context().newCDPSession(page);
    await openGame(page, cdp, INNER_L);
    await setInsets(page, BOOK_INSETS);
    await settle(page);
    // Messages: between the fold and the system UI.
    const toast = await toastArea(page);
    expect(toast.left).toBeGreaterThanOrEqual(445 + 8 - 0.5);
    expect(toast.right).toBeLessThanOrEqual(890 - 56 + 0.5);
    const inSegment = async (dialog: Locator, label: string) => {
      await expect(dialog, label).toBeVisible();
      await expect.poll(async () => {
        const b = (await dialog.boundingBox())!;
        return b.x >= 445 + 8 - 0.5 && b.x + b.width <= 890 - 56 + 0.5;
      }, { message: label }).toBe(true);
    };
    for (const [name, title] of [['new', 'New game'], ['menu', 'Menu']] as const) {
      await page.evaluate((n) => (window as unknown as Win).__chessCoach!.controller.openSheet(n), name);
      const dialog = page.getByRole('dialog', { name: title });
      await inSegment(dialog, title);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
    // The question a hint asks in a rated game.
    await tool(page, 'hint').click();
    const confirm = page.getByRole('dialog', { name: 'Use a hint?' });
    await inSegment(confirm, 'Confirm');
    await page.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    // The game-over sheet.
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.resign());
    await inSegment(page.locator('.sheet-panel.gos'), 'Game over');

    // Without the fold (Use the whole screen), a sheet at this size is a card of at most 560 px, not a full-width sheet.
    await page.evaluate(() => localStorage.setItem('chesscoach.fold', 'whole'));
    await page.reload();
    await emulate(cdp, INNER_L);
    await waitForApp(page);
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.openSheet('menu'));
    const menu = page.getByRole('dialog', { name: 'Menu' });
    await expect(menu).toBeVisible();
    await expect.poll(async () => (await menu.boundingBox())!.width).toBeLessThanOrEqual(560);
  });

  test('the Menu’s Foldable screen setting switches the arrangement; it is offered, and acts, only where a fold can be', async ({ page }) => {
    test.setTimeout(90_000);
    const cdp = await page.context().newCDPSession(page);
    await openGame(page, cdp, INNER_L);
    await setInsets(page, BOOK_INSETS);
    await settle(page);
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'book');

    await tool(page, 'menu').click();
    const menu = page.getByRole('dialog', { name: 'Menu' });
    const group = menu.getByRole('radiogroup', { name: 'Foldable screen' });
    await group.scrollIntoViewIfNeeded();
    await expect(group.getByRole('radio', { name: 'Automatic' })).toHaveAttribute('aria-checked', 'true');

    // Use the whole screen: one layout across the fold, the board as big as the screen allows.
    await group.getByRole('radio', { name: 'Use the whole screen' }).click();
    await expect(group.getByRole('radio', { name: 'Use the whole screen' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('html')).not.toHaveAttribute('data-fold', /./);
    expect(await page.evaluate(() => localStorage.getItem('chesscoach.fold'))).toBe('whole');
    // The sheet left the panel's segment with the split; close it to look at the board.
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    const whole = await boardBox(page);
    expect(whole.x < 445 && whole.x + whole.width > 445, 'the board spans the fold').toBe(true);
    expect(whole.width).toBeGreaterThan(450);

    // Keep the board off the fold, then Automatic: split again.
    await tool(page, 'menu').click();
    await group.scrollIntoViewIfNeeded();
    await group.getByRole('radio', { name: 'Keep the board off the fold' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'book');
    // Chromium reports the fold: the note says Automatic handles half folded too.
    await expect(menu.locator('[data-id="foldable"] .sheet-note')).toHaveText(/or half folded on a table\.$/);
    await group.getByRole('radio', { name: 'Keep the board off the fold' }).click();
    await page.keyboard.press('Escape');

    // Stored as "Keep the board off the fold", which both of the Duo's displays share: the screens
    // with no fold never split, and their Menu doesn't offer what it couldn't change. In Split View
    // (where the fold falls in the window is unknown), on the outer display and on a regular iPhone.
    for (const [vp, insets] of [
      [split(594), { top: 0, right: 56, bottom: 20, left: 0 }],
      [OUTER_P, { top: 54, right: 0, bottom: 28, left: 0 }],
      [OUTER_L, { top: 0, right: 54, bottom: 21, left: 54 }],
      [{ name: 'iPhone 15 Pro', width: 393, height: 852 }, { top: 59, right: 0, bottom: 34, left: 0 }],
      [{ name: 'iPhone 15 Pro landscape', width: 852, height: 393 }, { top: 0, right: 59, bottom: 21, left: 59 }],
    ] as const) {
      await emulate(cdp, vp);
      await setInsets(page, insets);
      await settle(page);
      await expect(page.locator('html'), vp.name).not.toHaveAttribute('data-fold', /./);
      await tool(page, 'menu').click();
      await expect(menu).toBeVisible();
      await expect(menu.locator('[data-id="foldable"]'), vp.name).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
    expect(await page.evaluate(() => localStorage.getItem('chesscoach.fold'))).toBe('split');
    // The outer display's board keeps its size.
    await emulate(cdp, OUTER_P);
    await setInsets(page, { top: 54, right: 0, bottom: 28, left: 0 });
    await settle(page);
    expect((await boardBox(page)).width).toBeGreaterThanOrEqual(360);
  });

  test('the system UI along the left edge (the device turned around): the board in the right segment, the safe areas re-read without a resize', async ({ page }) => {
    test.setTimeout(90_000);
    const cdp = await page.context().newCDPSession(page);
    await openGame(page, cdp, INNER_L);
    await setInsets(page, BOOK_INSETS);
    await settle(page);
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'book');
    await expect(page.locator('html')).not.toHaveAttribute('data-fold-board', /./);
    // Turned by 180°: the same window size, the safe areas on the other side.
    await setInsets(page, { top: 0, right: 0, bottom: 20, left: 56 });
    await settle(page);
    await expect(page.locator('html')).toHaveAttribute('data-fold-board', 'end');
    const board = await boardBox(page);
    expect(board.x).toBeGreaterThanOrEqual(445 + 8 - 0.5);
    for (const sel of ['.app-panel', '.app-moves', '.app-tools']) {
      const b = (await page.locator(sel).boundingBox())!;
      expect(b.x, sel).toBeGreaterThanOrEqual(56 - 0.5);
      expect(b.x + b.width, sel).toBeLessThanOrEqual(445 - 8 + 0.5);
    }
    await expectTidy(page, 'turned around');
    // Messages too: between the safe area and the fold.
    const toast = await toastArea(page);
    expect(toast.left).toBeGreaterThanOrEqual(56 - 0.5);
    expect(toast.right).toBeLessThanOrEqual(445 - 8 + 0.5);

    // The Openings section's board pages follow: the board on the right, the text and the title on the left.
    await openOpeningsSection(page);
    await page.locator('.op-card[data-family="Italian Game"]').first().click();
    await page.locator('[data-id="learn-main"]').click();
    await expect(opTitle(page)).toHaveText('Main line');
    await settle(page);
    const opBoard = (await page.locator('.op-view .board').boundingBox())!;
    expect(opBoard.x).toBeGreaterThanOrEqual(445 + 8 - 0.5);
    expect(opBoard.x + opBoard.width).toBeLessThanOrEqual(890 + 0.5);
    const controls = (await page.locator('.op-controls').boundingBox())!;
    expect(controls.x).toBeGreaterThanOrEqual(56 - 0.5);
    expect(controls.x + controls.width).toBeLessThanOrEqual(445 - 8 + 0.5);
    const title = (await opTitle(page).boundingBox())!;
    expect(title.x + title.width).toBeLessThanOrEqual(445 + 0.5);
    await expectOffFold(page, 'vertical', 445, 'Learn, turned around');
    await expectTargets(page, '.op-controls', { left: 56, right: 0 }, 'Learn, turned around');
  });

  test('the light theme’s status bar band runs down the side the system UI is on (the installed app)', async ({ page }) => {
    test.setTimeout(90_000);
    const cdp = await page.context().newCDPSession(page);
    await openGame(page, cdp, INNER_L);
    await setInsets(page, BOOK_INSETS);
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await standalone(page);
    await settle(page);
    const band = () =>
      page.evaluate(() => {
        const cs = getComputedStyle(document.body, '::after');
        const r = { content: cs.content, left: cs.left, right: cs.right, width: cs.width, color: cs.backgroundColor };
        return r;
      });
    expect(await band()).toMatchObject({ content: '""', right: '0px', width: '56px', color: 'rgb(29, 28, 26)' });
    // Turned around: down the left edge.
    await setInsets(page, { top: 0, right: 0, bottom: 20, left: 56 });
    await settle(page);
    expect(await band()).toMatchObject({ content: '""', left: '0px', width: '56px' });
    // A regular iPhone in landscape (its status bar hidden) keeps its look: no band.
    await emulate(cdp, { name: 'iPhone 15 Pro landscape', width: 852, height: 393 });
    await setInsets(page, { top: 0, right: 59, bottom: 21, left: 59 });
    await settle(page);
    expect((await band()).content).toBe('none');
  });
});

/** Black, in check from the queen on c8, has one move (…Rf8), which attacks the queen. You are White. */
const ROOK_BLOCKS = '2Q3k1/6p1/1P3r1p/6N1/5P2/3K4/7n/8 b - - 0 30';

// -------------------------------------------------------------------------------------------------
// The other screens: the Openings section, Game Review and Try again, the game viewer, the self-test
// page, the boot splash, and the narrow windows (the outer display, Split View).

/**
 * What crosses the fold (`at`, viewport px, the line between the segments; `axis` as in Viewport):
 * every visible text, control and board, by the part of it on screen (clipped by the scrollers
 * around it), with a label for the message. Under an open sheet or section, only that layer counts.
 */
async function acrossFold(page: Page, axis: 'vertical' | 'horizontal', at: number): Promise<string[]> {
  return page.evaluate(
    ([axis, at]) => {
      const layers = ['.sheet[data-state="open"] .sheet-panel', '.openings-shell', '[data-id="game-viewer"]', '.selftest', '.app-splash', '.app'];
      let root: Element | null = null;
      for (const sel of layers) {
        const all = [...document.querySelectorAll(sel)];
        // The Play sheet lives in the Openings section: the topmost sheet is the last one.
        if (all.length) {
          root = all.at(-1)!;
          break;
        }
      }
      if (!root) return ['no screen'];
      const out: string[] = [];
      for (const el of root.querySelectorAll('button, a, input, h1, h2, h3, p, pre, .board, .op-card, .pstrip-name, .app-splash-logo')) {
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const b = el.getBoundingClientRect();
        let r = { l: Math.max(0, b.left), t: Math.max(0, b.top), r: Math.min(innerWidth, b.right), b: Math.min(innerHeight, b.bottom) };
        let hidden = false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const ps = getComputedStyle(p);
          if (ps.opacity === '0' || ps.visibility === 'hidden') hidden = true;
          if (ps.overflowX !== 'visible' || ps.overflowY !== 'visible') {
            const q = p.getBoundingClientRect();
            r = { l: Math.max(r.l, q.left), t: Math.max(r.t, q.top), r: Math.min(r.r, q.right), b: Math.min(r.b, q.bottom) };
          }
        }
        if (hidden || r.r - r.l < 2 || r.b - r.t < 2) continue;
        const crosses = axis === 'vertical' ? r.l < at - 1 && r.r > at + 1 : r.t < at - 1 && r.b > at + 1;
        if (!crosses) continue;
        // Seen on both sides of the fold (not under something else there, such as a pinned board).
        const seen = (x: number, y: number) => {
          const hit = document.elementFromPoint(x, y);
          return !!hit && (el.contains(hit) || hit.contains(el));
        };
        const mid = axis === 'vertical' ? (r.t + r.b) / 2 : (r.l + r.r) / 2;
        const both = axis === 'vertical' ? seen(at - 3, mid) && seen(at + 3, mid) : seen(mid, at - 3) && seen(mid, at + 3);
        if (both) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(el.textContent ?? '').trim().slice(0, 30)}"`);
      }
      return out;
    },
    [axis, at] as const,
  );
}

async function expectOffFold(page: Page, axis: 'vertical' | 'horizontal', at: number, label: string): Promise<void> {
  await expect.poll(() => acrossFold(page, axis, at), { message: `${label}: across the fold` }).toEqual([]);
}

/**
 * Every control in `scope` that shows is at least 44 px both ways and inside the window and its safe
 * area (polled: a page that just slid in may still be on its way).
 */
async function expectTargets(page: Page, scope: string, insets: { left: number; right: number }, label: string): Promise<void> {
  const bad = (): Promise<string[]> =>
    page.evaluate(
      ([scope, insets]) => {
        const out: string[] = [];
        for (const el of document.querySelectorAll(`${scope} button`)) {
          const b = el.getBoundingClientRect();
          if ((el as HTMLElement).offsetParent === null || b.width < 1) continue;
          const name = `${(el as HTMLElement).dataset.id ?? (el.textContent ?? '').trim().slice(0, 20)}`;
          if (b.width < 44 - 0.5 || b.height < 44 - 0.5) out.push(`${name} ${Math.round(b.width)}x${Math.round(b.height)}`);
          if (b.left < insets.left - 0.5 || b.right > innerWidth - insets.right + 0.5) out.push(`${name} out of sight (${Math.round(b.left)}–${Math.round(b.right)})`);
        }
        return out;
      },
      [scope, insets] as const,
    );
  await expect.poll(bad, { message: label }).toEqual([]);
}

/** Menu → Openings, past the beginner card. */
async function openOpeningsSection(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.openSheet('menu'));
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu).toBeVisible();
  await menu.locator('[data-id="openings"]').click();
  await expect(page.locator('[data-id="openings-title"]')).toHaveText('Openings', { timeout: 15_000 });
  const intro = page.locator('[data-id="intro-dismiss"]');
  if (await intro.isVisible()) await intro.click();
}

const opTitle = (page: Page): Locator => page.locator('[data-id="openings-title"]');

test.describe('Foldable screens: the other screens', () => {
  test('Openings open like a book: the list beside the opening it opened, the board pages off the fold', async ({ page }) => {
    test.setTimeout(120_000);
    const cdp = await page.context().newCDPSession(page);
    await openGame(page, cdp, INNER_L);
    await setInsets(page, BOOK_INSETS);
    await settle(page);
    await openOpeningsSection(page);

    // Two panes, one per segment: Home, and nothing chosen yet beside it.
    const view = page.locator('.op-view');
    await expect(view).toHaveAttribute('data-panes', 'book');
    const panes = page.locator('.op-view > .op-pane');
    await expect(panes).toHaveCount(2);
    const list = (await panes.nth(0).boundingBox())!;
    const other = (await panes.nth(1).boundingBox())!;
    expect(list.x + list.width).toBeLessThanOrEqual(445 - 8 + 0.5);
    expect(other.x).toBeGreaterThanOrEqual(445 + 8 - 0.5);
    expect(other.x + other.width).toBeLessThanOrEqual(890 + 0.5);
    await expect(page.locator('[data-id="openings-empty"]')).toBeVisible();
    await expectOffFold(page, 'vertical', 445, 'Home');
    await expectTargets(page, '.op-view', { left: 0, right: 56 }, 'Home');

    // A card opens its opening beside the list; another card replaces it (Back still leads to Home).
    await page.locator('.op-card[data-family="Italian Game"]').first().click();
    await expect(opTitle(page)).toHaveText('Italian Game');
    expect((await page.locator('[data-id="learn-main"]').boundingBox())!.x).toBeGreaterThanOrEqual(445 + 8 - 0.5);
    await expect(page.locator('.op-card[data-family="Italian Game"]').first()).toBeVisible();
    await expectOffFold(page, 'vertical', 445, 'Italian Game');
    await page.locator('.op-card[data-family="London System"]').first().click();
    await expect(opTitle(page)).toHaveText('London System');
    await page.keyboard.press('Escape');
    await expect(opTitle(page)).toHaveText('Openings');
    await expect(page.locator('[data-id="openings-empty"]')).toBeVisible();

    // A search in the list keeps its text while the opening it found shows beside it.
    await page.locator('[data-id="openings-search"]').fill('london');
    await page.locator('.op-row--opening[data-family="London System"]').click();
    await expect(opTitle(page)).toHaveText('London System');
    await expect(page.locator('[data-id="openings-search"]')).toHaveValue('london');
    await expect(page.locator('.op-view > .op-pane')).toHaveCount(2);

    // A board page: the board in the first segment, the rest in the second.
    await page.locator('[data-id="openings-search"]').fill('');
    await page.locator('.op-card[data-family="Italian Game"]').first().click();
    await page.locator('[data-id="learn-main"]').click();
    await expect(view).not.toHaveAttribute('data-panes', /./);
    await expect(opTitle(page)).toHaveText('Main line');
    await page.locator('[data-id="next"]').click();
    const board = (await page.locator('.op-view .board').boundingBox())!;
    expect(board.x + board.width).toBeLessThanOrEqual(445 - 8 + 0.5);
    expect((await page.locator('.op-controls').boundingBox())!.x).toBeGreaterThanOrEqual(445 + 8 - 0.5);
    await expectOffFold(page, 'vertical', 445, 'Learn');
    await expectTargets(page, '.op-controls', { left: 0, right: 56 }, 'Learn');

    // Folded to the outer display and open again: the same page, and Back to the two panes.
    await emulate(cdp, OUTER_P);
    await setInsets(page, { top: 54, right: 0, bottom: 28, left: 0 });
    await settle(page);
    await expect(opTitle(page)).toHaveText('Main line');
    await expectTargets(page, '.op-controls', { left: 0, right: 0 }, 'Learn, outer display');
    await emulate(cdp, INNER_L);
    await setInsets(page, BOOK_INSETS);
    await settle(page);
    await page.locator('[data-id="openings-back"]').click();
    await expect(opTitle(page)).toHaveText('Italian Game');
    await expect(page.locator('.op-view > .op-pane')).toHaveCount(2);
    await expectOffFold(page, 'vertical', 445, 'back to the two panes');
  });

  test('Openings: folding or unfolding while typing a search keeps the field, its text and its focus', async ({ page }) => {
    test.setTimeout(90_000);
    const cdp = await page.context().newCDPSession(page);
    await openGame(page, cdp, OUTER_P);
    await setInsets(page, { top: 54, right: 0, bottom: 28, left: 0 });
    await settle(page);
    await openOpeningsSection(page);
    const search = page.locator('[data-id="openings-search"]');
    await search.click();
    await page.keyboard.type('Ital');
    await search.evaluate((el) => ((el as HTMLElement & { keep?: boolean }).keep = true));
    const same = () =>
      page.evaluate(() => {
        const el = document.activeElement as (HTMLInputElement & { keep?: boolean }) | null;
        return { kept: el?.keep === true, value: el?.value ?? null };
      });
    // Unfolded: the list's pane is the same page, the same field (the iOS keyboard stays up).
    await emulate(cdp, INNER_L);
    await setInsets(page, BOOK_INSETS);
    await settle(page);
    await expect(page.locator('.op-view')).toHaveAttribute('data-panes', 'book');
    expect(await same()).toEqual({ kept: true, value: 'Ital' });
    // And folded again.
    await emulate(cdp, OUTER_P);
    await setInsets(page, { top: 54, right: 0, bottom: 28, left: 0 });
    await settle(page);
    await expect(page.locator('.op-view')).not.toHaveAttribute('data-panes', /./);
    expect(await same()).toEqual({ kept: true, value: 'Ital' });
    await page.keyboard.type('ian');
    await expect(search).toHaveValue('Italian');
  });

  test('a phone keeps its look: the Draw bar’s turn dot centered and whole', async ({ page }) => {
    test.setTimeout(60_000);
    const cdp = await page.context().newCDPSession(page);
    await openGame(page, cdp, { name: 'iPhone 15 Pro', width: 393, height: 852 });
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.toggleDraw());
    const bar = page.getByRole('toolbar', { name: 'Draw' });
    await expect(bar).toBeVisible();
    const m = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const dot = r('.drawbar-turn');
      const mode = r('.drawbar-mode');
      return { dot: dot.y + dot.height / 2, mode: mode.y + mode.height / 2, overflow: getComputedStyle(document.querySelector('.drawbar-mode')!).overflow };
    });
    expect(Math.abs(m.dot - m.mode)).toBeLessThanOrEqual(0.5);
    // Its pulsing halo isn't clipped.
    expect(m.overflow).toBe('visible');
  });

  test('Openings half folded: the list above the opening, the board kept above the fold while the page scrolls', async ({ page }) => {
    test.setTimeout(120_000);
    const cdp = await page.context().newCDPSession(page);
    await openGame(page, cdp, INNER_P_API);
    await setInsets(page, { top: 56, right: 0, bottom: 20, left: 0 });
    await settle(page);
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'tabletop');
    await openOpeningsSection(page);
    await expect(page.locator('.op-view')).toHaveAttribute('data-panes', 'tabletop');
    await page.locator('.op-card[data-family="Italian Game"]').first().click();
    await expect(opTitle(page)).toHaveText('Italian Game');
    const panes = page.locator('.op-view > .op-pane');
    expect((await panes.nth(0).boundingBox())!.y + (await panes.nth(0).boundingBox())!.height).toBeLessThanOrEqual(445 - 8 + 0.5);
    expect((await panes.nth(1).boundingBox())!.y).toBeGreaterThanOrEqual(445 + 8 - 0.5);
    await expectOffFold(page, 'horizontal', 445, 'tabletop, Italian Game');

    await page.locator('[data-id="learn-main"]').click();
    await expect(opTitle(page)).toHaveText('Main line');
    const board = page.locator('.op-view .board');
    expect((await board.boundingBox())!.y + (await board.boundingBox())!.height).toBeLessThanOrEqual(445 - 8 + 0.5);
    await expectOffFold(page, 'horizontal', 445, 'tabletop, Learn');
    // Scrolled down: the board stays put above the fold, the rest passes under it, never across.
    await page.locator('.op-scroll').evaluate((el) => el.scrollTo({ top: 260, behavior: 'instant' }));
    await settle(page);
    expect((await board.boundingBox())!.y).toBeGreaterThanOrEqual(56 - 0.5);
    expect((await board.boundingBox())!.y + (await board.boundingBox())!.height).toBeLessThanOrEqual(445 - 8 + 0.5);
    await expectOffFold(page, 'horizontal', 445, 'tabletop, Learn scrolled');
  });

  test('Game Review, Try again and the game viewer keep off the fold; tags never cover a name', async ({ page }) => {
    test.setTimeout(150_000);
    const cdp = await page.context().newCDPSession(page);
    await openGame(page, cdp, INNER_L);
    await setInsets(page, BOOK_INSETS);
    await settle(page);
    // A blunder to review: Black's only move (…Rf8) attacks the queen, and White walks the king away.
    await page.evaluate((fen) => {
      const c = (window as unknown as Win).__chessCoach!.controller;
      c.newGame({ ...c.store.settings.value, playerColor: 'w', botId: 'pip', botElo: 100, adaptive: false, coach: true, showEvalBar: true }, { startFen: fen });
    }, ROOK_BLOCKS);
    await waitForMyTurn(page);
    await play(page, 'd3d2');
    await waitForMyTurn(page);
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.resign());
    await expect(page.locator('.sheet-panel.gos')).toBeVisible();
    await expectOffFold(page, 'vertical', 445, 'game over');
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.closeSheet());
    await expect(page.locator('.sheet-panel.gos')).toBeHidden();

    // Game Review: the report beside the board.
    await page.evaluate(() => void (window as unknown as Win).__chessCoach!.controller.startReview());
    await page.waitForFunction(() => (window as unknown as Win).__chessCoach!.controller.store.review.value?.progress === null, null, { timeout: 90_000 });
    await expect(page.locator('.app-panel .review')).toBeVisible();
    expect((await page.locator('.app-panel .review').boundingBox())!.x).toBeGreaterThanOrEqual(445 + 8 - 0.5);
    await expectOffFold(page, 'vertical', 445, 'review');
    // Folded (the outer display), in Split View, upright flat (one segment: the whole screen, the
    // summary beside the move list) and on phones, it floats over the board: it leaves whole ranks
    // above it, or none, never a sliver of pieces cut in half; and never covers the opponent's strip.
    for (const [vp, insets] of [
      [OUTER_P, { top: 54, right: 0, bottom: 28, left: 0 }],
      [split(445), { top: 0, right: 0, bottom: 20, left: 0 }],
      [split(594), { top: 0, right: 56, bottom: 20, left: 0 }],
      [split(296), { top: 0, right: 0, bottom: 20, left: 0 }],
      [{ name: 'inner portrait, flat', width: 626, height: 890 }, { top: 56, right: 0, bottom: 20, left: 0 }],
      [{ name: 'iPhone 15 Pro', width: 393, height: 852 }, { top: 59, right: 0, bottom: 34, left: 0 }],
      [{ name: 'iPhone SE', width: 375, height: 667 }, { top: 20, right: 0, bottom: 0, left: 0 }],
    ] as const) {
      await emulate(cdp, vp);
      await setInsets(page, insets);
      await settle(page);
      await expect(page.locator('.app-panel'), vp.name).toHaveAttribute('data-float', '');
      const strip = (await page.locator('.app-player--top').boundingBox())!;
      const top = (await page.locator('.app-panel .review').boundingBox())!.y;
      const b = await boardBox(page);
      const shown = top - b.y;
      expect(top, `${vp.name}: under the opponent's strip`).toBeGreaterThanOrEqual(strip.y + strip.height - 1);
      const ranks = shown / (b.height / 8);
      expect(Math.abs(ranks - Math.round(ranks)) * (b.height / 8), `${vp.name}: ${shown.toFixed(1)} px of the board above the summary`).toBeLessThanOrEqual(1.5);
    }
    await emulate(cdp, INNER_L);
    await setInsets(page, BOOK_INSETS);
    await settle(page);
    // Try again on the blunder: the board stays in the first segment, its tag on the strip.
    const tryAgain = page.locator('[data-id="try-again"]').first();
    await expect(tryAgain).toBeVisible();
    await tryAgain.click();
    await expect(page.locator('.app')).toHaveAttribute('data-practice', '');
    expect((await boardBox(page)).x + (await boardBox(page)).width).toBeLessThanOrEqual(445 - 8 + 0.5);
    await expectOffFold(page, 'vertical', 445, 'Try again');

    // Half folded: the tag hangs under the opponent's strip, clear of the name.
    await emulate(cdp, INNER_P_API);
    await setInsets(page, { top: 56, right: 0, bottom: 20, left: 0 });
    await settle(page);
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'tabletop');
    const name = (await page.locator('.app-player--top .pstrip-name').boundingBox())!;
    const tag = (await page.locator('.app-player--top .app-explore-tag').boundingBox())!;
    expect(name.width, 'the name shows').toBeGreaterThan(20);
    expect(tag.y, 'the tag is under the strip').toBeGreaterThanOrEqual(name.y + name.height);
    await expectOffFold(page, 'horizontal', 445, 'tabletop Try again');
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.exitPractice());

    // The game viewer (Menu → Recent games): the board in the first segment, its header beside it.
    await emulate(cdp, INNER_L);
    await setInsets(page, BOOK_INSETS);
    await settle(page);
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.openSheet('menu'));
    const row = page.getByRole('dialog', { name: 'Menu' }).locator('[data-id="recent-game"]').first();
    await row.scrollIntoViewIfNeeded();
    await row.click();
    const viewer = page.locator('[data-id="game-viewer"]');
    await expect(viewer).toBeVisible();
    await settle(page);
    const vBoard = (await viewer.locator('.board').first().boundingBox())!;
    expect(vBoard.x + vBoard.width).toBeLessThanOrEqual(445 - 8 + 0.5);
    expect((await viewer.locator('.viewer-head').boundingBox())!.x).toBeGreaterThanOrEqual(445 + 8 - 0.5);
    await expectOffFold(page, 'vertical', 445, 'viewer');
    await expectTargets(page, '[data-id="game-viewer"] .app-tools', { left: 0, right: 56 }, 'viewer toolbar');
  });

  test('the self-test page keeps off the fold; the boot splash stays centered, as the launch screen is', async ({ page, context }) => {
    test.setTimeout(90_000);
    const cdp = await page.context().newCDPSession(page);
    await emulate(cdp, INNER_L);
    await page.goto('./?enginetest');
    await expect(page.locator('.selftest-log')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'book');
    expect((await page.locator('.selftest-log').boundingBox())!.x).toBeGreaterThanOrEqual(445 + 8 - 0.5);
    const head = (await page.locator('.selftest-title').boundingBox())!;
    expect(head.x + head.width).toBeLessThanOrEqual(445 - 8 + 0.5);
    await expectOffFold(page, 'vertical', 445, 'self-test');

    // The boot splash, held up by an engine download that never ends: centered on the whole screen,
    // where the launch screen before it (the App Store app's fades out over it) shows the mark, so
    // the mark doesn't jump sideways; it has nothing to tap.
    const second = await context.newPage();
    const cdp2 = await context.newCDPSession(second);
    await emulate(cdp2, INNER_L);
    await second.route('**/*.wasm', () => {});
    await second.goto('./');
    await expect(second.locator('.app-splash')).toBeVisible({ timeout: 20_000 });
    await expect(second.locator('html')).toHaveAttribute('data-fold', 'book');
    await settle(second);
    const logo = (await second.locator('.app-splash-logo').boundingBox())!;
    expect(Math.abs(logo.x + logo.width / 2 - 445)).toBeLessThanOrEqual(1);
    await second.close();
  });

  test('narrow windows: the Openings pages, the game viewer and Split View fit, with 44 px targets', async ({ page }) => {
    test.setTimeout(120_000);
    const cdp = await page.context().newCDPSession(page);
    await openGame(page, cdp, OUTER_L);
    await setInsets(page, { top: 0, right: 54, bottom: 21, left: 54 });
    await settle(page);
    await openOpeningsSection(page);
    await page.locator('.op-card[data-family="Italian Game"]').first().click();
    await page.locator('[data-id="learn-main"]').click();
    await expect(opTitle(page)).toHaveText('Main line');
    await settle(page);
    // Half the width for the board (not given up for a row of buttons): the step controls beside it
    // in two rows of three, inside the safe area.
    expect((await page.locator('.op-board-cell').boundingBox())!.width, 'Learn board').toBeGreaterThanOrEqual(330);
    await expectTargets(page, '.op-controls', { left: 54, right: 54 }, 'outer landscape, Learn');
    const ctl = page.locator('.op-controls .op-ctl');
    const rows = new Set(await ctl.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y))));
    expect(rows.size, 'two rows').toBe(2);
    expect(Math.round((await ctl.nth(2).boundingBox())!.y), 'three in the first').toBe(Math.round((await ctl.first().boundingBox())!.y));
    // Explore by moves (from the first page) and the drill: the same board.
    const back = page.locator('[data-id="openings-back"]');
    while ((await opTitle(page).textContent()) !== 'Openings') await back.click();
    await page.locator('[data-id="explore-moves"]').click();
    await settle(page);
    expect((await page.locator('.op-board-cell').boundingBox())!.width, 'Explore board').toBeGreaterThanOrEqual(330);
    await back.click();
    await page.locator('.op-card[data-family="Italian Game"]').first().click();
    await page.locator('[data-id="drill-main"]').click();
    await page.locator('[data-id="drill-start"]').click();
    await settle(page);
    expect((await page.locator('.op-board-cell').boundingBox())!.width, 'drill board').toBeGreaterThanOrEqual(330);
    while ((await opTitle(page).textContent()) !== 'Italian Game') await back.click();
    await page.locator('[data-id="learn-main"]').click();
    await expect(opTitle(page)).toHaveText('Main line');

    // Split View's third and half, the page still open: the controls wrap rather than run out of the window.
    for (const width of [296, 445]) {
      await emulate(cdp, split(width));
      await setInsets(page, { top: 0, right: 0, bottom: 20, left: 0 });
      await settle(page);
      await expect(opTitle(page)).toHaveText('Main line');
      await expectTargets(page, '.op-controls', { left: 0, right: 0 }, `Split View ${width}, Learn`);
      const sideways = await page.locator('.op-scroll').evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(sideways, `Split View ${width}: sideways scroll`).toBeLessThanOrEqual(1);
    }
    await page.locator('[data-id="openings-done"]').click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden();

    // The game viewer on the outer display's side: the whole title, never cut.
    await emulate(cdp, OUTER_L);
    await setInsets(page, { top: 0, right: 54, bottom: 21, left: 54 });
    await settle(page);
    await waitForMyTurn(page);
    await play(page, await quietMove(page));
    await waitForMyTurn(page);
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.resign());
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.closeSheet());
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.openSheet('menu'));
    const row = page.getByRole('dialog', { name: 'Menu' }).locator('[data-id="recent-game"]').first();
    await row.scrollIntoViewIfNeeded();
    await row.click();
    const title = page.locator('[data-id="game-viewer"] .viewer-title-main');
    await expect(title).toBeVisible();
    await settle(page);
    expect(await title.evaluate((el) => el.scrollHeight - el.clientHeight), 'the title is cut').toBeLessThanOrEqual(1);
    await expectTargets(page, '[data-id="game-viewer"] .viewer-head', { left: 54, right: 54 }, 'viewer header');
  });
});
