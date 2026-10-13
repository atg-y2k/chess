/**
 * Threat alerts and "can you punish it?" end to end, on the production build with the real engine
 * (iPhone 15 Pro emulation): the bot's only move threatens the queen, and the coach warns about it
 * with a threat arrow (gone once you move); switching threat alerts on in the Menu during a rated
 * game asks first (Cancel keeps it rated, Turn on makes it unrated); with the opponent's moves rated,
 * its blunder asks for the punishment without naming it, "Show me" is offered, and your punishing
 * move is praised.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

interface Hook {
  controller: {
    newGame(settings: unknown, opts?: unknown): Promise<void>;
    store: {
      phase: { value: string };
      humanToMove: { value: boolean };
      isLive: { value: boolean };
      settings: { value: Record<string, unknown> };
      plies: { value: { san: string }[] };
    };
  };
}
/** The page's debug hook (src/main.tsx). */
type Win = { __chessCoach?: Hook };

/** Black, in check from the queen on c8, has one move (…Rf8), which attacks the queen. You are White. */
const ROOK_BLOCKS = '2Q3k1/6p1/1P3r1p/6N1/5P2/3K4/7n/8 b - - 0 30';

const board = (page: Page): Locator => page.locator('.board cg-board').first();
const coach = (page: Page): Locator => page.locator('.app-panel .coach');
const moves = (page: Page): Locator => page.locator('.app-moves .mlist-move');
/** An engine arrow of the board (`brush`: 'threat', 'best', …), see Board.tsx. */
const arrow = (page: Page, from: string, to: string, brush: string): Locator =>
  page.locator(`.cg-shapes g[cgHash$=",${from},${to},${brush}"]`);

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

/** Opens the app and starts a game against Pip (100) as White through the debug hook. */
async function start(page: Page, settings: Record<string, unknown>, opts?: unknown): Promise<void> {
  await page.goto('./');
  await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(
    async ([s, o]) => {
      const c = (window as unknown as Win).__chessCoach!.controller;
      await c.newGame({ ...c.store.settings.value, playerColor: 'w', botId: 'pip', botElo: 100, adaptive: false, coach: true, ...s }, o);
    },
    [settings, opts] as const,
  );
  await expect(page.getByRole('dialog', { name: 'New game' })).toBeHidden();
}

test.describe('Coach tools', () => {
  test('threat alerts: the bot’s move threatens the queen; the warning and its arrow, gone once you move', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await start(page, { threatAlerts: true, rateOpponent: false }, { startFen: ROOK_BLOCKS });
    // Unrated from the start.
    await expect(page.locator('.app-player--bottom')).toContainText('Unrated');
    await waitForMyTurn(page);
    expect(await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.plies.value.map((p) => p.san))).toEqual(['Rf8']);
    const alert = coach(page).locator('.coach-alert');
    await expect(alert).toHaveText(/Pip threatens Rxc8, winning your queen on c8\./, { timeout: 30_000 });
    await expect(alert).toHaveAttribute('role', 'status');
    await expect(arrow(page, 'f8', 'c8', 'threat')).toHaveCount(1);
    // It names only the threat: no defense (such as a queen move) is suggested.
    await expect(alert).not.toContainText('Q');
    // Your move: the warning is about the old position, so it goes at once.
    await tapSquare(page, 'c8');
    await tapSquare(page, 'c4');
    await expect(alert).toHaveCount(0);
    await expect(arrow(page, 'f8', 'c8', 'threat')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('threat alerts switched on in the Menu during a rated game: asks first (Cancel keeps it rated), then unrated', async ({ page }) => {
    test.setTimeout(120_000);
    await start(page, { threatAlerts: false, rateOpponent: false, showBestMoves: false });
    await waitForMyTurn(page);
    await playAndWait(page, 'e2e4');
    await expect(page.locator('.app-player--bottom')).not.toContainText('Unrated');

    const menu = page.getByRole('dialog', { name: 'Menu' });
    const ask = page.getByRole('dialog', { name: 'Turn on threat alerts?' });
    await page.locator('.toolbar-btn[data-id="menu"]').tap();
    await expect(menu).toBeVisible();
    const toggle = menu.locator('.toggle[data-id="threatAlerts"]');
    await expect(toggle).toContainText('Warns you of threats, and makes your games unrated while it’s on');
    await toggle.tap();
    await expect(ask).toBeVisible();
    await expect(ask).toContainText('so it makes this game unrated');
    await ask.locator('[data-id="confirm-cancel"]').tap();
    await expect(ask).toBeHidden();
    await expect(menu).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('.app-player--bottom')).not.toContainText('Unrated');

    await toggle.tap();
    await ask.locator('[data-id="confirm-ok"]').tap();
    await expect(ask).toBeHidden();
    await expect(menu).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await menu.getByRole('button', { name: 'Close' }).tap();
    await expect(menu).toBeHidden();
    await expect(page.locator('.app-player--bottom')).toContainText('Unrated');
  });

  test('can you punish it? The bot’s blunder hides its answer until your move, which is praised', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // A line the bot follows (opening practice): 1.e4 e5 2.Nf3 Qh4??, with its moves rated.
    await start(
      page,
      { rateOpponent: true, threatAlerts: false, showBestMoves: false },
      { opening: { lineId: 'test:queen-blunder', mode: 'steer', moves: ['e2e4', 'e7e5', 'g1f3', 'd8h4'], name: 'Queen blunder' } },
    );
    await waitForMyTurn(page);
    await playAndWait(page, 'e2e4');
    await playAndWait(page, 'g1f3');
    expect(await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.plies.value.map((p) => p.san))).toEqual([
      'e4',
      'e5',
      'Nf3',
      'Qh4',
    ]);
    // The verdict (free) and the question; nothing names Nxh4, and "Show me" is offered.
    await expect(coach(page).locator('.coach-title')).toHaveText(/^Pip’s 2… Qh4 is a blunder/, { timeout: 30_000 });
    await expect(coach(page).locator('.coach-body')).toContainText('Pip blundered — can you punish it?');
    await expect(coach(page)).not.toContainText('Nxh4');
    await expect(coach(page).locator('[data-action="showPunishment"]')).toHaveText('Show me');
    await expect(coach(page).locator('[data-action="showBest"]')).toHaveCount(0);
    await expect(page.locator('.cg-shapes g[cgHash$=",best"]')).toHaveCount(0);

    // Your move punishes it: said first, with your move's feedback kept open.
    await tapSquare(page, 'f3');
    await tapSquare(page, 'h4');
    await expect(coach(page).locator('.coach-line').first()).toHaveText('You punished it!', { timeout: 30_000 });
    await expect(coach(page).locator('.coach-title')).toHaveText(/^3\. Nxh4 /);
    expect(errors).toEqual([]);
  });
});
