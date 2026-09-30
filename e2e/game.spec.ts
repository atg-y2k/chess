/**
 * Game flow end-to-end, on the production build with the real Stockfish workers (iPhone 15 Pro
 * emulation, see playwright.config.ts): new-game sheet, moves by tapping squares, bot replies,
 * eval bar, coach feedback, hint arrows, undo, flip, reload restore, resign, game over sheet and
 * game review; a game as Black; and the `?enginetest` diagnostics page.
 *
 * Moves are made by tapping the centres of squares, computed from the board's bounding box and
 * orientation. The legal-move choice for later moves and a few waits read the app's state through
 * the debug hook `window.__chessCoach` (src/main.tsx), so the test never depends on the bot's
 * (random) replies.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

interface Hook {
  controller: {
    newGame(settings: object, opts?: { startFen?: string }): void;
    store: {
      settings: { value: object };
      phase: { value: string };
      humanToMove: { value: boolean };
      isLive: { value: boolean };
      liveFen: { value: string };
      position: { value: { dests: Map<string, string[]> } };
      coach: { value: { busy: boolean; kind: string } };
    };
  };
}
declare global {
  interface Window {
    __chessCoach?: Hook;
  }
}

const moves = (page: Page): Locator => page.locator('.mlist-move');
const board = (page: Page): Locator => page.locator('.board cg-board').first();

/** Centre of `square` (e.g. "e2") in page coordinates, from the board's box and orientation. */
async function squareCenter(page: Page, square: string): Promise<{ x: number; y: number }> {
  const box = await board(page).boundingBox();
  if (!box) throw new Error('board not visible');
  const white = await page.locator('.board .cg-wrap').first().evaluate((el) => el.classList.contains('orientation-white'));
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const size = box.width / 8;
  const col = white ? file : 7 - file;
  const row = white ? 7 - rank : rank;
  return { x: box.x + (col + 0.5) * size, y: box.y + (row + 0.5) * size };
}

async function tapSquare(page: Page, square: string): Promise<void> {
  const { x, y } = await squareCenter(page, square);
  await page.touchscreen.tap(x, y);
}

/** Waits until the human may move on the live board. */
async function waitForMyTurn(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = window.__chessCoach?.controller.store;
    return !!s && s.phase.value === 'playing' && s.humanToMove.value && s.isLive.value;
  });
}

/** Plays `uci` by tapping its two squares and waits for it to appear in the move list. */
async function play(page: Page, uci: string): Promise<void> {
  const before = await moves(page).count();
  await tapSquare(page, uci.slice(0, 2));
  await tapSquare(page, uci.slice(2, 4));
  await expect(moves(page)).toHaveCount(before + 1);
}

/** Quiet developing moves for White, tried in order (none of them can walk into a quick mate). */
const QUIET_MOVES = ['g1f3', 'b1c3', 'd2d3', 'f1e2', 'c2c3', 'a2a3', 'h2h3', 'b2b3', 'e1g1'];

/** The first legal move from QUIET_MOVES in the live position, else any legal move. */
async function quietMove(page: Page): Promise<string> {
  const all = await page.evaluate(() => {
    const out: string[] = [];
    for (const [from, tos] of window.__chessCoach!.controller.store.position.value.dests) for (const to of tos) out.push(from + to);
    return out;
  });
  expect(all.length).toBeGreaterThan(0);
  return QUIET_MOVES.find((m) => all.includes(m)) ?? all[0];
}

async function evalText(page: Page): Promise<string> {
  return (await page.locator('.evalbar').getAttribute('aria-valuetext')) ?? '';
}

/** Opens the New game sheet state from a fresh start and starts a game. */
async function startGame(page: Page, botId: string, color: 'w' | 'b'): Promise<void> {
  await page.goto('./');
  const sheet = page.getByRole('dialog', { name: 'New game' });
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await sheet.locator(`[data-bot="${botId}"]`).tap();
  await expect(sheet.locator(`[data-bot="${botId}"]`)).toHaveAttribute('aria-checked', 'true');
  await sheet.locator(`.ngs-color[data-color="${color}"]`).tap();
  await sheet.getByRole('button', { name: 'Play' }).tap();
  await expect(sheet).toBeHidden();
}

test.describe('Game', () => {
  test('plays White vs a low-Elo bot: coach, hint, undo, flip, reload, resign and review', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await startGame(page, 'biscuit', 'w');
    await expect(page.locator('.cg-wrap.orientation-white').first()).toBeVisible();
    await expect(page.locator('.app-player--top')).toContainText('Biscuit');
    await waitForMyTurn(page);

    // 1. e4 by tapping; the bot replies.
    await play(page, 'e2e4');
    await expect(moves(page)).toHaveCount(2, { timeout: 30_000 });

    // Coach feedback for e4 with a classification icon.
    const coach = page.locator('.app-panel .coach');
    await expect(coach.locator('.coach-head .class-icon')).toBeVisible({ timeout: 30_000 });
    await expect(coach.locator('.coach-line').first()).not.toBeEmpty();

    // The eval bar shows a score, and it changes as the game goes on.
    await expect.poll(() => evalText(page), { timeout: 30_000 }).toMatch(/^[+-]?(\d+\.\d|M\d+)/);
    const seen = new Set([await evalText(page)]);

    for (let i = 0; i < 3; i++) {
      await waitForMyTurn(page);
      const count = await moves(page).count();
      await play(page, await quietMove(page));
      await expect(moves(page)).toHaveCount(count + 2, { timeout: 30_000 });
      await expect.poll(() => evalText(page), { timeout: 30_000 }).not.toBe('');
      seen.add(await evalText(page));
    }
    await expect.poll(async () => seen.add(await evalText(page)).size, { timeout: 30_000 }).toBeGreaterThan(1);

    // Hint: the game is rated, so it asks first (a hint makes it unrated); then an arrow on the
    // board plus an explanation, and the player strip says the game is unrated.
    await waitForMyTurn(page);
    await expect(page.locator('.app-player--bottom .pstrip-unrated')).toHaveCount(0);
    await page.locator('.toolbar-btn[data-id="hint"]').tap();
    const confirm = page.getByRole('dialog', { name: 'Use a hint?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Show hint' }).tap();
    await expect(confirm).toBeHidden();
    await expect(coach.locator('.coach-title')).toHaveText('Hint');
    await expect(page.locator('.cg-shapes line').first()).toBeAttached({ timeout: 30_000 });
    await expect(coach.locator('.coach-line').first()).not.toBeEmpty();
    await coach.getByRole('button', { name: 'Got it' }).tap();
    await expect(page.locator('.cg-shapes line')).toHaveCount(0);
    await expect(page.locator('.app-player--bottom .pstrip-unrated')).toHaveText('Unrated');

    // Undo takes back my move and the bot's reply (no question: the game is already unrated).
    const beforeUndo = await moves(page).count();
    await page.locator('.toolbar-btn[data-id="undo"]').tap();
    await expect(moves(page)).toHaveCount(beforeUndo - 2);

    // Flip.
    await page.locator('.toolbar-btn[data-id="flip"]').tap();
    await expect(page.locator('.cg-wrap.orientation-black').first()).toBeVisible();
    await page.locator('.toolbar-btn[data-id="flip"]').tap();
    await expect(page.locator('.cg-wrap.orientation-white').first()).toBeVisible();

    // Reload mid-game: the same moves come back.
    await waitForMyTurn(page);
    const sans = await page.locator('.mlist-san').allTextContents();
    const fen = await page.evaluate(() => window.__chessCoach!.controller.store.liveFen.value);
    await page.reload();
    await expect(page.locator('.mlist-san')).toHaveText(sans, { timeout: 30_000 });
    expect(await page.evaluate(() => window.__chessCoach!.controller.store.liveFen.value)).toBe(fen);
    await waitForMyTurn(page);

    // New game mid-game: the sheet says the current game would end as a loss.
    await page.locator('.toolbar-btn[data-id="newGame"]').tap();
    const newSheet = page.getByRole('dialog', { name: 'New game' });
    await expect(newSheet.locator('[data-id="abandon-note"]')).toContainText('will end as a loss');
    await expect(newSheet.locator('[data-id="play"]')).toHaveText('Resign & play');
    await newSheet.getByRole('button', { name: 'Close' }).tap();
    await expect(newSheet).toBeHidden();

    // Resign from the menu -> game over sheet -> Game Review with accuracy.
    await page.locator('.toolbar-btn[data-id="menu"]').tap();
    const menu = page.getByRole('dialog', { name: 'Menu' });
    await expect(menu).toBeVisible();
    await menu.locator('.menu-tile[data-id="resign"]').tap();
    await menu.locator('[data-id="resign-confirm"]').tap();
    const over = page.getByRole('dialog', { name: 'You lost You resigned' });
    await expect(over).toBeVisible();
    await expect(over.locator('.gos-headline')).toHaveText('You lost');
    await over.getByRole('button', { name: 'Game Review' }).tap();
    const review = page.getByRole('region', { name: 'Game review' });
    await expect(review).toBeVisible();
    await expect(review.locator('.review-acc').first()).toHaveText(/^\d+\.\d$/, { timeout: 90_000 });
    await expect(review.locator('.review-acc').nth(1)).toHaveText(/^\d+\.\d$/);
    await expect(review.locator('.review-progress')).toHaveCount(0);

    // Stepping through the review shows the coach on that move.
    await page.locator('.toolbar-btn[data-id="prev"]').tap();
    await expect(page.locator('.app-panel .coach .coach-title')).toContainText(/\d+(\.|…) /);
    await page.locator('.toolbar-btn[data-id="summary"]').tap();
    await expect(review).toBeVisible();

    // iOS may kill the app after the game: a reload brings back the finished game, ready for review.
    const finalSans = await page.locator('.mlist-san').allTextContents();
    await page.reload();
    await expect(page.locator('.mlist-san')).toHaveText(finalSans, { timeout: 30_000 });
    expect(await page.evaluate(() => window.__chessCoach!.controller.store.phase.value)).toBe('over');
    await expect(page.locator('.toolbar-btn[data-id="review"]')).toBeEnabled();

    // Nothing overflows the screen.
    const scroll = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]);
    expect(scroll).toEqual([393, 852]);
    expect(errors).toEqual([]);
  });

  test('plays Black: the bot moves first', async ({ page }) => {
    test.setTimeout(90_000);
    await startGame(page, 'pip', 'b');
    await expect(page.locator('.cg-wrap.orientation-black').first()).toBeVisible();
    await expect(moves(page)).toHaveCount(1, { timeout: 30_000 });
    await waitForMyTurn(page);
    await play(page, 'e7e6');
    await expect(moves(page)).toHaveCount(3, { timeout: 30_000 });
    await expect(page.locator('.app-panel .coach .coach-head .class-icon')).toBeVisible({ timeout: 30_000 });
  });

  test('a promotion that mates by tapping opens the game-over sheet (and it stays open)', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('./');
    await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible({ timeout: 30_000 });
    // White to move: b8=Q is mate (back rank). Started through the controller to set the position.
    await page.evaluate((startFen) => {
      const c = window.__chessCoach!.controller;
      c.newGame({ ...c.store.settings.value, playerColor: 'w', botId: 'pip', botElo: 100, adaptive: false }, { startFen });
    }, '6k1/1P3ppp/8/8/8/8/5PPP/6K1 w - - 0 1');
    await waitForMyTurn(page);
    await tapSquare(page, 'b7');
    await tapSquare(page, 'b8');
    const queen = page.locator('.board-promo-opt[data-piece="q"]');
    await expect(queen).toBeVisible();
    await queen.tap();
    const over = page.getByRole('dialog', { name: 'You won! by checkmate' });
    await expect(over).toBeVisible();
    await expect(page.locator('.mlist-san').last()).toHaveText('b8=Q#');
    // The tail of the tap (its click) must not land on the new sheet's backdrop and close it.
    await page.waitForTimeout(800);
    await expect(over).toBeVisible();
  });

  test('the coach text is readable at every phone height (or the panel collapses to one row)', async ({ page }) => {
    test.setTimeout(90_000);
    await startGame(page, 'pip', 'w');
    await waitForMyTurn(page);
    await play(page, 'e2e4');
    await expect(page.locator('.app-panel .coach .class-icon').first()).toBeVisible({ timeout: 30_000 });
    // Safari (not installed) viewports of Plus / Pro Max / SE-class phones, and the 15 Pro's.
    for (const [width, height] of [[393, 852], [393, 659], [430, 739], [414, 715], [375, 667], [375, 812]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(150);
      const m = await page.evaluate(() => {
        const panel = document.querySelector('.app-panel')!;
        const body = panel.querySelector('.coach-body');
        return { tight: panel.hasAttribute('data-tight'), body: body?.clientHeight ?? 0 };
      });
      expect(m.tight || m.body >= 38, `${width}x${height}: ${JSON.stringify(m)}`).toBe(true);
    }
  });

  test.describe('landscape', () => {
    test.use({ viewport: { width: 852, height: 393 } });
    test('the floating review summary keeps its header (accuracy, close) on screen', async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto('./');
      await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible({ timeout: 30_000 });
      await page.evaluate(() => {
        const c = window.__chessCoach!.controller;
        c.newGame({ ...c.store.settings.value, playerColor: 'w', botId: 'pip', botElo: 100, adaptive: false });
      });
      await waitForMyTurn(page);
      await play(page, 'e2e4');
      await waitForMyTurn(page);
      await page.evaluate(() => {
        const c = window.__chessCoach!.controller as unknown as { resign(): void; startReview(): Promise<void> };
        c.resign();
        void c.startReview();
      });
      const review = page.getByRole('region', { name: 'Game review' });
      await expect(review.locator('.review-acc').first()).toHaveText(/^\d+\.\d$/, { timeout: 90_000 });
      for (const sel of ['.review-head', '.review-close']) {
        const box = await review.locator(sel).first().boundingBox();
        expect(box, sel).not.toBeNull();
        expect(box!.y, sel).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height, sel).toBeLessThanOrEqual(393);
      }
    });
  });

  test('?enginetest runs the engine self-test and passes', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('./?enginetest');
    await expect(page.getByRole('heading', { name: 'Engine self-test' })).toBeVisible();
    await expect(page.locator('[data-id="verdict"]')).toHaveText('PASS', { timeout: 100_000 });
    await expect(page.locator('.selftest-log')).toContainText('RESULT: PASS');
    await expect(page.getByRole('button', { name: 'Copy log' })).toBeEnabled();
  });
});
