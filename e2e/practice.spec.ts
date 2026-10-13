/**
 * Try again from Game Review's key moments, end to end on the production build with the real engine
 * (iPhone 15 Pro emulation): a short game with your blunder (3. Qxf7+?? from the position after 1. e4
 * e5 2. Qh5 Nc6), resigned and reviewed; the key moment's Try again sets up the position before it,
 * Back returns to the review; a move that is no better is taken back ("Not quite — try again"), a
 * hint names the piece, the engine's move finds it, and Play on from here starts an unrated game from
 * there while the earlier game stays in the history.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

interface Hook {
  controller: {
    newGame(settings: unknown, opts?: unknown): Promise<void>;
    resign(): void;
    store: {
      phase: { value: string };
      settings: { value: Record<string, unknown> };
      game: { value: { id: string; startFen: string; assisted: boolean } | null };
      plies: { value: { san: string }[] };
      profile: { value: { history: { id: string }[] } };
      practice: { value: { status: string; answer?: { uci: string; san: string } | null } | null };
    };
  };
}
/** The page's debug hook (src/main.tsx). */
type Win = { __chessCoach?: Hook };

/** 1. e4 e5 2. Qh5 Nc6: White to move (3. Qxf7+?? hangs the queen to Kxf7, the only reply). */
const QUEEN_OUT = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3';

const board = (page: Page): Locator => page.locator('.board cg-board').first();
const coach = (page: Page): Locator => page.locator('.app-panel .coach');
const review = (page: Page): Locator => page.getByRole('region', { name: 'Game Review' });
const tool = (page: Page, id: string): Locator => page.locator(`.toolbar-btn[data-id="${id}"]`);
const hook = (page: Page) => page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.practice.value);

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

async function tapMove(page: Page, uci: string): Promise<void> {
  await tapSquare(page, uci.slice(0, 2));
  await tapSquare(page, uci.slice(2, 4));
}

test.describe('Try again', () => {
  test('from Game Review: back to the review, a move that is no better, a hint, the best move, then Play on from here', async ({ page }) => {
    test.setTimeout(150_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('./');
    await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible({ timeout: 30_000 });
    await page.evaluate(async (fen) => {
      const c = (window as unknown as Win).__chessCoach!.controller;
      await c.newGame({ ...c.store.settings.value, playerColor: 'w', botId: 'pip', botElo: 100, adaptive: false, coach: true }, { startFen: fen });
    }, QUEEN_OUT);
    await expect(page.getByRole('dialog', { name: 'New game' })).toBeHidden();

    // 3. Qxf7+?? Kxf7, then resign: the game-over sheet's Game Review.
    await tapMove(page, 'h5f7');
    await expect(page.locator('.app-moves .mlist-move')).toHaveCount(2, { timeout: 30_000 });
    const oldId = await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.game.value!.id);
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.resign());
    const over = page.getByRole('dialog', { name: 'You lost You resigned' });
    await expect(over).toBeVisible();
    await over.getByRole('button', { name: 'Game Review' }).tap();
    await expect(review(page).locator('.review-acc').first()).toHaveText(/^\d+\.\d$/, { timeout: 90_000 });

    // Your blunder among the key moments, with Try again beside it.
    const tryAgain = review(page).locator('[data-id="try-again"]');
    await expect(tryAgain).toHaveCount(1);
    await expect(tryAgain).toHaveAccessibleName('Try again: find a better move than Qxf7+');
    await tryAgain.tap();
    await expect(coach(page).locator('.coach-title')).toHaveText('Find a better move than Qxf7+');
    await expect(coach(page)).toContainText('In the game you played 3. Qxf7+, a blunder.');
    await expect(page.locator('[data-id="practicing"]')).toBeVisible();
    await expect(review(page)).toHaveCount(0);

    // Back returns to the review as it was; Try again again.
    await tool(page, 'practiceExit').tap();
    await expect(review(page)).toBeVisible();
    await expect(page.locator('[data-id="practicing"]')).toHaveCount(0);
    await review(page).locator('[data-id="try-again"]').tap();
    await expect(coach(page).locator('.coach-title')).toHaveText('Find a better move than Qxf7+');

    // A move that is no better: checked, then taken back.
    await tapMove(page, 'h5e5');
    await expect(coach(page).locator('.coach-title')).toHaveText('Not quite — try again', { timeout: 30_000 });
    await expect(coach(page)).toContainText('Qxe5+ is a blunder.');
    await expect(page.locator('.cg-shapes g[cgHash$=",h5,e5,played"]')).toHaveCount(1);
    expect(await hook(page)).toMatchObject({ status: 'wrong' });

    // A hint: the piece to move (the answer is never named).
    await page.waitForFunction(() => (window as unknown as Win).__chessCoach!.controller.store.practice.value?.answer !== undefined);
    const answer = (await hook(page))!.answer!;
    await coach(page).locator('[data-action="practiceHint"]').tap();
    await expect(coach(page).locator('.coach-line').first()).toHaveText(/^Hint: move (your|a) (pawn|knight|bishop|rook|queen|king)\.$/);
    await expect(coach(page)).not.toContainText(answer.san);

    // The engine's move: found.
    await tapMove(page, answer.uci);
    await expect(coach(page).locator('.coach-line').first()).toHaveText('You found the best move!', { timeout: 30_000 });
    await expect(coach(page).locator('.coach-title')).toContainText(`3. ${answer.san}`);
    await expect(coach(page).locator('[data-action="practiceNext"]')).toHaveCount(0); // the only one
    await expect(coach(page).locator('[data-action="practiceExit"]')).toHaveText('Back to review');

    // Play on from here: an unrated game from the position before 3. Qxf7+, you to move.
    await coach(page).locator('[data-action="practicePlayOn"]').tap();
    await expect(coach(page)).toContainText('You’re playing on from your earlier game, before 3. Qxf7+. This game is unrated.');
    await expect(page.locator('.app-player--bottom')).toContainText('Unrated');
    await expect(page.locator('.app-moves .mlist-move')).toHaveCount(0);
    await expect(page.locator('[data-id="practicing"]')).toHaveCount(0);
    const now = await page.evaluate(() => {
      const s = (window as unknown as Win).__chessCoach!.controller.store;
      return { phase: s.phase.value, game: s.game.value, history: s.profile.value.history.map((r) => r.id) };
    });
    expect(now.phase).toBe('playing');
    expect(now.game).toMatchObject({ startFen: QUEEN_OUT, assisted: true });
    expect(now.game!.id).not.toBe(oldId);
    // The earlier game is in the history once, as it was recorded.
    expect(now.history.filter((id) => id === oldId)).toHaveLength(1);
    expect(now.history).not.toContain(now.game!.id);
    expect(errors).toEqual([]);
  });
});
