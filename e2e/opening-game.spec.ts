/**
 * Opening practice end to end, on the production build with the real engine (iPhone 15 Pro
 * emulation): a game started with `newGame(settings, { opening })` (the Openings section's "Play"
 * calls it; here through the page's debug hook). 'steer': the bot follows the line, the line's
 * next move shows as a light arrow and a coach line, the banner tracks the line, leaving it is said
 * once, and the game is unrated. 'skip': the line is on the board from the start and a reload keeps
 * the opening. A tap on the banner opens the line in the Openings section. A short phone shows the
 * collapsed coach with the line move and the banner on a tap.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

interface Hook {
  controller: {
    newGame(settings: unknown, opts: unknown): Promise<void>;
    store: {
      phase: { value: string };
      humanToMove: { value: boolean };
      isLive: { value: boolean };
      settings: { value: Record<string, unknown> };
      plies: { value: { san: string }[] };
      openingPractice: { value: { status: string; statusText: string } | null };
    };
  };
}
/** The page's debug hook (src/main.tsx). */
type Win = { __chessCoach?: Hook };

const ITALIAN = 'c50-italian-game';

const board = (page: Page): Locator => page.locator('.board cg-board').first();
const coach = (page: Page): Locator => page.locator('.app-panel .coach');
const banner = (page: Page): Locator => page.locator('.app-panel [data-id="opening-banner"]');
const moves = (page: Page): Locator => page.locator('.app-moves .mlist-move');
/** The opening-practice arrow from `from` to `to` (its own brush, see Board.tsx). */
const lineArrow = (page: Page, from: string, to: string): Locator => page.locator(`.cg-shapes g[cgHash$=",${from},${to},line"]`);
/** Coach text with plain spaces (move labels use no-break spaces). */
const text = (s: string): RegExp => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ \\u00a0]'));

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

const sans = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.plies.value.map((p) => p.san));

/** Opens the app and starts an opening game against Pip (100) as White. */
async function startOpening(page: Page, opening: { lineId: string; mode: 'steer' | 'skip'; showLineMoves?: boolean }): Promise<void> {
  await page.goto('./');
  await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(async (o) => {
    const c = (window as unknown as Win).__chessCoach!.controller;
    await c.newGame({ ...c.store.settings.value, playerColor: 'w', botId: 'pip', botElo: 100, adaptive: false, coach: true }, { opening: o });
  }, opening);
  await expect(page.getByRole('dialog', { name: 'New game' })).toBeHidden();
}

test.describe('Opening practice', () => {
  test('steer: the bot follows the line, the line move shows, leaving it is said once', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await startOpening(page, { lineId: ITALIAN, mode: 'steer', showLineMoves: true });
    await waitForMyTurn(page);

    // Unrated from the start; the banner, the line move in the coach and its arrow on the board.
    await expect(page.locator('.app-player--bottom')).toContainText('Unrated');
    await expect(banner(page)).toContainText('Italian Game');
    await expect(banner(page)).toContainText('Move 1 of 3');
    await expect(coach(page).locator('.coach-line').first()).toHaveText(text('Line move: 1. e4 — Italian Game'));
    await expect(lineArrow(page, 'e2', 'e4')).toHaveCount(1);

    // The bot answers with the line's move.
    await playAndWait(page, 'e2e4');
    expect(await sans(page)).toEqual(['e4', 'e5']);
    await expect(banner(page)).toContainText('Move 2 of 3');
    await expect(coach(page).locator('.coach-line').first()).toHaveText(text('Line move: 2. Nf3 — Italian Game'));
    await expect(lineArrow(page, 'g1', 'f3')).toHaveCount(1);
    await expect(lineArrow(page, 'e2', 'e4')).toHaveCount(0);

    // Leaving the line: said once in the coach, kept in the banner; no more arrow.
    await playAndWait(page, 'b1c3');
    const note = text('You left the line at 2. Nc3 (the line continues 2. Nf3) — the game goes on normally.');
    await expect(coach(page).locator('.coach-line').first()).toHaveText(note, { timeout: 30_000 });
    await expect(banner(page)).toContainText('Left at 2. Nc3');
    await expect(page.locator('.cg-shapes g[cgHash$=",line"]')).toHaveCount(0);
    await playAndWait(page, 'g1f3');
    await expect(coach(page).locator('.coach-line').filter({ hasText: note })).toHaveCount(0);
    await expect(banner(page)).toContainText('Left at 2. Nc3');

    // A tap on the banner opens the line in the Openings section; Done returns to the game as it was.
    const played = await sans(page);
    await banner(page).tap();
    const openings = page.getByRole('dialog', { name: 'Openings' });
    await expect(openings).toBeVisible();
    await expect(page.locator('[data-id="openings-title"]')).toHaveText('Italian Game', { timeout: 15_000 });
    await page.locator('[data-id="openings-done"]').tap();
    await expect(openings).toBeHidden();
    expect(await sans(page)).toEqual(played);
    await expect(banner(page)).toContainText('Left at 2. Nc3');
    expect(errors).toEqual([]);
  });

  test('skip: the line is on the board from the start, and a reload keeps the opening', async ({ page }) => {
    test.setTimeout(120_000);
    await startOpening(page, { lineId: ITALIAN, mode: 'skip' });
    // 1. e4 e5 2. Nf3 Nc6 3. Bc4 played for you; Pip (Black) replies at once.
    await expect(moves(page)).toHaveCount(6, { timeout: 30_000 });
    await waitForMyTurn(page);
    expect((await sans(page)).slice(0, 5)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    await expect(banner(page)).toContainText('Line complete');
    await expect(coach(page)).toContainText('The moves of the Italian Game line are on the board');
    await expect(page.locator('.app-player--bottom')).toContainText('Unrated');

    await page.reload();
    await waitForMyTurn(page);
    await expect(banner(page)).toContainText('Italian Game');
    await expect(banner(page)).toContainText('Line complete');
    expect((await sans(page)).length).toBe(6);
  });

  test('a short phone: the collapsed coach shows the line move; a tap floats the panel with the banner', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 375, height: 667 });
    await startOpening(page, { lineId: ITALIAN, mode: 'steer', showLineMoves: true });
    await waitForMyTurn(page);
    await playAndWait(page, 'e2e4');
    const row = page.locator('.app-panel .coach-row');
    await expect(row).toBeVisible();
    await expect(row.locator('.coach-summary')).toHaveText(text('Line move: 2. Nf3 — Italian Game'), { timeout: 30_000 });
    await expect(banner(page)).toHaveCount(0);
    await row.tap();
    await expect(page.locator('.app-panel[data-peek]')).toBeVisible();
    await expect(banner(page)).toContainText('Move 2 of 3');
  });
});
