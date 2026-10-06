/**
 * "Rate opponent's moves" end to end, on the production build with the real engine (iPhone 15 Pro
 * emulation): switched on in the New game sheet (the game is unrated from the start), the bot's
 * reply gets its badge on the board, its rating in the move list and the coach's verdict and
 * explanation, with your own move as the panel's other row (tap it to expand); on a short phone
 * both show as one row of two halves. Switched on in the Menu during a rated game, it asks first
 * (Cancel keeps the game rated) and then shows the Unrated pill.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

interface Hook {
  controller: {
    store: {
      phase: { value: string };
      humanToMove: { value: boolean };
      isLive: { value: boolean };
      plies: { value: { san: string; classification?: { cls: string } }[] };
      moveList: { value: { plies: { classification?: { cls: string } }[] } };
      board: { value: { badge?: { square: string }; extraBadges?: { square: string }[] } };
    };
  };
}
/** The page's debug hook (src/main.tsx). */
type Win = { __chessCoach?: Hook };

const board = (page: Page): Locator => page.locator('.board cg-board').first();
const coach = (page: Page): Locator => page.locator('.app-panel .coach');
const moves = (page: Page): Locator => page.locator('.app-moves .mlist-move');

async function tapSquare(page: Page, square: string): Promise<void> {
  const box = await board(page).boundingBox();
  if (!box) throw new Error('board not visible');
  const white = await page.locator('.board .cg-wrap').first().evaluate((el) => el.classList.contains('orientation-white'));
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const size = box.width / 8;
  const col = white ? file : 7 - file;
  const row = white ? 7 - rank : rank;
  await page.touchscreen.tap(box.x + (col + 0.5) * size, box.y + (row + 0.5) * size);
}

async function waitForMyTurn(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as unknown as Win).__chessCoach?.controller.store;
    return !!s && s.phase.value === 'playing' && s.humanToMove.value && s.isLive.value;
  });
}

/** Plays `uci` by tapping its squares; waits for the bot's reply. */
async function playAndWait(page: Page, uci: string): Promise<void> {
  const before = await moves(page).count();
  await tapSquare(page, uci.slice(0, 2));
  await tapSquare(page, uci.slice(2, 4));
  await expect(moves(page)).toHaveCount(before + 2, { timeout: 30_000 });
  await waitForMyTurn(page);
}

async function newGame(page: Page, opts: { rateOpponent: boolean }): Promise<void> {
  await page.goto('./');
  const sheet = page.getByRole('dialog', { name: 'New game' });
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await sheet.locator('[data-bot="pip"]').tap();
  await sheet.locator('.ngs-color[data-color="w"]').tap();
  const toggle = sheet.locator('.toggle[data-id="rateOpponent"]');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toContainText('Rate opponent’s moves');
  await expect(sheet.locator('[data-id="unrated-note"]')).toContainText('rating your opponent’s moves make a game unrated');
  if (opts.rateOpponent) {
    await toggle.tap();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(sheet.locator('[data-id="unrated-note"]')).toHaveText(
      'Your opponent’s moves are rated, so this game won’t count for your rating.',
    );
  }
  await sheet.getByRole('button', { name: 'Play' }).tap();
  await expect(sheet).toBeHidden();
}

test.describe('Rate opponent’s moves', () => {
  test('from the New game sheet: unrated, the bot’s move gets a badge, a rating and the coach’s verdict, both rows', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await newGame(page, { rateOpponent: true });
    await expect(page.locator('.app-player--bottom')).toContainText('Unrated');
    await waitForMyTurn(page);
    await playAndWait(page, 'e2e4');
    const reply = (await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.plies.value[1].san)) as string;

    // The coach: the bot's move, expanded (the most recent), in the third person with its explanation.
    await expect(coach(page).locator('.coach-title')).toHaveText(new RegExp(`^Pip’s 1… ${reply.replace(/[+]/g, '\\+')} (is|doesn’t|still|gives)`), {
      timeout: 30_000,
    });
    await expect(coach(page).locator('.coach-line').first()).not.toBeEmpty();
    // Your move is the row above it.
    const other = coach(page).locator('.coach-other');
    await expect(other).toHaveAttribute('data-place', 'before');
    await expect(other).toContainText('You');
    await expect(other).toContainText('1. e4');

    // The board shows the reply's badge (and keeps yours); the move list has the reply's rating.
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.board.value.badge?.square)).toBeTruthy();
    await expect(page.locator('.cg-custom-svgs [cgHash]')).toHaveCount(2);
    expect(await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.moveList.value.plies[1].classification?.cls)).toBeTruthy();

    // Tapping your row expands your move; the bot's becomes the row below.
    await other.tap();
    await expect(coach(page).locator('.coach-title')).toHaveText(/^1\. e4 /);
    await expect(coach(page).locator('.coach-other')).toHaveAttribute('data-place', 'after');
    await expect(coach(page).locator('.coach-other')).toContainText('Pip');

    // A short phone: one row with a half for each move; a half opens that move's feedback over the board.
    await page.setViewportSize({ width: 375, height: 667 });
    const halves = page.locator('.app-panel .coach-half');
    await expect(halves).toHaveCount(2);
    await expect(halves.nth(0)).toContainText('You');
    await expect(halves.nth(1)).toContainText('Pip');
    await halves.nth(1).tap();
    await expect(page.locator('.app-panel[data-peek]')).toBeVisible();
    await expect(coach(page).locator('.coach-title')).toHaveText(/^Pip’s 1… /);
    expect(errors).toEqual([]);
  });

  test('landscape: both moves rated never squeeze the text to a line; a long name gives way to the verdict', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('./');
    await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => {
      const c = (window as unknown as { __chessCoach: { controller: { newGame(s: object): void; store: { settings: { value: object } } } } })
        .__chessCoach.controller;
      c.newGame({ ...c.store.settings.value, playerColor: 'w', botId: 'professor-hoot', botElo: 1100, adaptive: false, rateOpponent: true });
    });
    await page.setViewportSize({ width: 852, height: 393 });
    await waitForMyTurn(page);
    await playAndWait(page, 'e2e4');
    await playAndWait(page, 'b1c3');
    await expect(coach(page).locator('.coach-title, .coach-half-verdict').first()).not.toHaveText(/Checking/, { timeout: 30_000 });
    const panel = page.locator('.app-panel');
    const halves = panel.locator('.coach-half');
    if ((await halves.count()) === 0) {
      const [shown, full] = await panel.locator('.coach-body').evaluate((e) => [e.clientHeight, e.scrollHeight]);
      expect(shown >= 38 || shown >= full).toBe(true);
    } else {
      // One row of two halves: the verdicts are whole, the long name gives way.
      for (const v of await panel.locator('.coach-half-verdict').evaluateAll((els) => els.map((e) => e.scrollWidth <= e.clientWidth))) {
        expect(v).toBe(true);
      }
      await halves.nth(1).tap();
      await expect(panel).toHaveAttribute('data-peek', '');
    }
    // The opponent's title (expanded or floated) keeps its verdict whole.
    const title = coach(page).locator('.coach-title');
    if ((await title.count()) && (await title.textContent())?.startsWith('Professor Hoot’s')) {
      expect(await title.locator('.coach-title-verdict').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    }
  });

  test('switched on in the Menu during a rated game: asks first, then the game is unrated', async ({ page }) => {
    test.setTimeout(120_000);
    await newGame(page, { rateOpponent: false });
    await waitForMyTurn(page);
    await playAndWait(page, 'e2e4');
    await expect(page.locator('.app-player--bottom')).not.toContainText('Unrated');
    await expect(coach(page).locator('.coach-other')).toHaveCount(0);

    const menu = page.getByRole('dialog', { name: 'Menu' });
    const ask = page.getByRole('dialog', { name: 'Rate your opponent’s moves?' });
    // Cancel: nothing changes.
    await page.locator('.toolbar-btn[data-id="menu"]').tap();
    await expect(menu).toBeVisible();
    await menu.locator('.toggle[data-id="rateOpponent"]').tap();
    await expect(ask).toBeVisible();
    await expect(ask).toContainText('so it makes this game unrated');
    await ask.locator('[data-id="confirm-cancel"]').tap();
    await expect(ask).toBeHidden();
    await expect(page.locator('.app-player--bottom')).not.toContainText('Unrated');
    await page.locator('.toolbar-btn[data-id="menu"]').tap();
    await expect(menu.locator('.toggle[data-id="rateOpponent"]')).toHaveAttribute('aria-checked', 'false');

    // Turn on: the Unrated pill, and the bot's last move rated at once.
    await menu.locator('.toggle[data-id="rateOpponent"]').tap();
    await ask.locator('[data-id="confirm-ok"]').tap();
    await expect(ask).toBeHidden();
    await expect(page.locator('.app-player--bottom')).toContainText('Unrated');
    await expect(coach(page).locator('.coach-title')).toHaveText(/^Pip’s 1… /, { timeout: 30_000 });
    await expect(coach(page).locator('.coach-other')).toContainText('1. e4');
    await page.locator('.toolbar-btn[data-id="menu"]').tap();
    await expect(menu.locator('.toggle[data-id="rateOpponent"]')).toHaveAttribute('aria-checked', 'true');
  });
});
