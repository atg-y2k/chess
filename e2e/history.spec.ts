/**
 * Your games, end to end on the production build with the real engine (iPhone 15 Pro emulation): a
 * game played and resigned (3. Qxf7+?? from the position after 1. e4 e5 2. Qh5 Nc6), then the Menu's
 * rating chart, a tap on its point and "View game": the game viewer (its header, stepping back and
 * forward, Export PGN with the analysis), Review with its key moment, Try again on the game screen
 * and back to the viewer, Back to the Menu. Then an older game whose record has no analysis (seeded,
 * as an earlier version saved it), opened from Recent games: "Not analyzed", Review analyzes it with
 * its progress, and the record keeps the result.
 */
import { Chess } from 'chess.js';
import { expect, test, type Locator, type Page } from '@playwright/test';

interface Hook {
  controller: {
    newGame(settings: unknown, opts?: unknown): Promise<void>;
    resign(): void;
    idle(): Promise<void>;
    store: {
      settings: { value: Record<string, unknown> };
      game: { value: { id: string } | null };
      profile: { value: { history: { id: string; analysis?: { p: string }; accuracy?: number }[] } };
      viewer: { value: { review: { progress: number | null } | null } | null };
      practice: { value: unknown };
    };
  };
}
type Win = { __chessCoach?: Hook };

/** 1. e4 e5 2. Qh5 Nc6: White to move (3. Qxf7+?? hangs the queen to Kxf7, the only reply). */
const QUEEN_OUT = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3';

const board = (page: Page): Locator => page.locator('.app:not(.viewer-app) .board cg-board').first();
const viewer = (page: Page): Locator => page.locator('[data-id="game-viewer"]');
const vtool = (page: Page, id: string): Locator => viewer(page).locator(`.toolbar-btn[data-id="${id}"]`);

async function tapSquare(page: Page, square: string): Promise<void> {
  const box = await board(page).boundingBox();
  if (!box) throw new Error('board not visible');
  const white = await page.locator('.app:not(.viewer-app) .board .cg-wrap').first().evaluate((el) => el.classList.contains('orientation-white'));
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const size = box.width / 8;
  const col = white ? file : 7 - file;
  const row = white ? 7 - rank : rank;
  await page.touchscreen.tap(box.x + (col + 0.5) * size, box.y + (row + 0.5) * size);
}

/** A PGN as the app records a finished game (no analysis): 20 plies of an Italian, then a resignation. */
function oldPgn(): string {
  const chess = new Chess();
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4', 'cxd4', 'Bb4+', 'Nc3', 'Nxe4', 'O-O', 'Bxc3', 'd5', 'Bf6', 'Re1', 'Ne7']) {
    chess.move(san);
  }
  for (const [k, v] of Object.entries({
    Event: 'Chess Coach',
    Site: 'Chess Coach',
    Date: '2026.09.20',
    Round: '-',
    White: 'You',
    Black: 'Rocco',
    Result: '0-1',
    WhiteElo: '800',
    BlackElo: '400',
    Termination: 'Resignation',
  })) {
    chess.setHeader(k, v);
  }
  return chess.pgn();
}

test.describe('Your games', () => {
  test('a finished game: the rating chart, the game viewer, Export PGN, Review and Try again', async ({ page, context }) => {
    test.setTimeout(150_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('./');
    await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible({ timeout: 30_000 });
    await page.evaluate(async (fen) => {
      const c = (window as unknown as Win).__chessCoach!.controller;
      await c.newGame({ ...c.store.settings.value, playerColor: 'w', botId: 'pip', botElo: 100, adaptive: false, coach: true }, { startFen: fen });
    }, QUEEN_OUT);
    await expect(page.getByRole('dialog', { name: 'New game' })).toBeHidden();
    await tapSquare(page, 'h5');
    await tapSquare(page, 'f7');
    await expect(page.locator('.app-moves .mlist-move')).toHaveCount(2, { timeout: 30_000 });
    const id = await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.game.value!.id);
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.resign());
    const over = page.getByRole('dialog', { name: 'You lost You resigned' });
    await expect(over).toBeVisible();
    // The record keeps the game's analysis once every move is checked.
    await page.waitForFunction(
      (gameId) => !!(window as unknown as Win).__chessCoach!.controller.store.profile.value.history.find((r) => r.id === gameId)?.analysis,
      id,
      { timeout: 60_000 },
    );
    await over.getByRole('button', { name: 'Close' }).first().tap();
    await expect(over).toBeHidden();

    // Menu → Your stats: the chart, one rated game. Tap its point, then View game.
    await page.locator('.toolbar-btn[data-id="menu"]').tap();
    const chart = page.locator('[data-id="rating-chart"]');
    await chart.scrollIntoViewIfNeeded();
    await expect(chart.locator('figcaption')).toHaveText(/^Rating history: 1 rated game, from 800 to \d+/);
    const dot = await chart.locator('[data-id="rating-now"]').boundingBox();
    await page.touchscreen.tap(dot!.x + dot!.width / 2, dot!.y + dot!.height / 2);
    await expect(chart.locator('[data-id="rating-readout"]')).toContainText('Pip (100) · Lost');
    await chart.locator('[data-id="rating-open"]').tap();

    // The game viewer: its header and the final position.
    await expect(viewer(page)).toBeVisible();
    await expect(viewer(page).locator('.viewer-title-main')).toHaveText('Lost to Pip');
    await expect(viewer(page).locator('.viewer-facts')).toContainText('Resignation');
    await expect(viewer(page).locator('[data-id="viewer-rating"] .viewer-delta')).toHaveText(/^−\d+$/);
    await expect(viewer(page).locator('.mlist-move')).toHaveCount(2);
    await expect(viewer(page).locator('.coach-title')).toContainText('Kxf7');
    // Step back to the blunder and forward again.
    await vtool(page, 'viewerPrev').tap();
    await expect(viewer(page).locator('.coach-title')).toHaveText('3. Qxf7+ is a blunder');
    // It can be tried again: its better move waits (Show best, or the try).
    await expect(viewer(page).locator('.coach-body')).not.toContainText('Best was');
    await expect(viewer(page).locator('.coach [data-action="tryAgain"]')).toBeVisible();
    await expect(viewer(page).locator('.coach [data-action="showBest"]')).toBeVisible();
    await expect(vtool(page, 'viewerNext')).toBeEnabled();
    await vtool(page, 'viewerNext').tap();
    await expect(vtool(page, 'viewerNext')).toBeDisabled();
    await vtool(page, 'viewerPrev').tap();

    // Export PGN: shared or copied, with the analysis.
    await viewer(page).locator('[data-id="viewer-export"]').tap();
    await expect(page.locator('.app-toast')).toHaveText('PGN copied to the clipboard');
    const pgn = await page.evaluate(() => navigator.clipboard.readText());
    expect(pgn).toContain('[Black "Pip"]');
    expect(pgn).toMatch(/3\. Qxf7\+ \$4 \{ \[%eval/);

    // Review: the report with the key moment, and Try again on the game screen.
    await vtool(page, 'viewerReview').tap();
    const report = viewer(page).getByRole('region', { name: 'Game Review' });
    await expect(report).toBeVisible();
    const tryAgain = report.locator('[data-id="try-again"]');
    await expect(tryAgain).toHaveCount(1);
    await tryAgain.tap();
    await expect(viewer(page)).toHaveCount(0);
    await expect(page.locator('.app-panel .coach .coach-title')).toHaveText('Find a better move than Qxf7+');
    await expect(page.locator('[data-id="practicing"]')).toBeVisible();
    await page.locator('.toolbar-btn[data-id="practiceExit"]').tap();
    await expect(viewer(page)).toBeVisible();
    await expect(viewer(page).getByRole('region', { name: 'Game Review' })).toBeVisible();

    // Back: the Menu again (the game on the board as it was).
    await viewer(page).locator('[data-id="viewer-back"]').tap();
    await expect(viewer(page)).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('an older game without analysis: Recent games opens it, Review analyzes it with its progress', async ({ page }) => {
    test.setTimeout(150_000);
    const record = {
      id: 'old-1',
      date: '2026-09-20T18:00:00.000Z',
      playerColor: 'w',
      botName: 'Rocco',
      botElo: 400,
      result: '0-1',
      playerScore: 0,
      rated: true,
      ratingBefore: 800,
      ratingAfter: 702,
      reason: 'Resignation',
      pgn: oldPgn(),
    };
    await page.addInitScript((r) => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      const profile = { rating: 702, gamesPlayed: 1, peak: 702, wins: 0, draws: 0, losses: 1, history: [r] };
      localStorage.setItem('chesscoach.profile', JSON.stringify({ version: 1, profile }));
    }, record);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('./');
    await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('dialog', { name: 'New game' }).getByRole('button', { name: 'Close' }).first().tap();
    await page.locator('.toolbar-btn[data-id="menu"]').tap();
    const row = page.locator('[data-id="recent-game"][data-game="old-1"]');
    await row.scrollIntoViewIfNeeded();
    await row.tap();
    await expect(viewer(page)).toBeVisible();
    await expect(viewer(page).locator('.viewer-title-main')).toHaveText('Lost to Rocco');
    await expect(viewer(page).locator('.evalbar')).toHaveAttribute('aria-label', 'Evaluation: not analyzed');
    await expect(viewer(page).locator('.coach-line').first()).toHaveText('The coach hasn’t checked this game yet.');
    await vtool(page, 'viewerReview').tap();
    const report = viewer(page).getByRole('region', { name: 'Game Review' });
    await expect(report.getByRole('progressbar', { name: 'Analysis progress' })).toBeVisible();
    await expect(report.locator('.review-status')).toHaveText(/^Analyzing game… \d+%$/);
    await expect(report.getByRole('progressbar')).toHaveCount(0, { timeout: 120_000 });
    await expect(report.locator('.review-acc').first()).toHaveText(/^\d+\.\d$/);
    const kept = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('chesscoach.profile')!);
      return raw.profile.history[0] as { analysis?: { p: string }; accuracy?: number };
    });
    expect(kept.analysis?.p.split(' ')).toHaveLength(20);
    expect(kept.accuracy).toBeGreaterThan(0);
    await expect(viewer(page).locator('.viewer-facts')).toContainText(/Accuracy \d+%/);
    expect(errors).toEqual([]);
  });
});
