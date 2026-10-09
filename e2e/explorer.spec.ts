/**
 * The explorer end to end, on the production build with the real engine (iPhone 15 Pro emulation):
 * during a rated game it opens at once with its engine off (no question, no eval bar, arrows or
 * badges; moves for both sides by tapping squares, Back, "Play" committing a move to the game, the
 * game still rated), then the Engine switch (the question, Keep off, Turn on: the Unrated pill, the
 * eval bar, the rating badges, arrows, Best here, Reset, Engine reply, Exit); and in Game Review
 * (the engine on, no question, the review comes back on Exit). The game itself must never change
 * while exploring.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

interface Hook {
  controller: {
    newGame(settings: object, opts?: { startFen?: string }): void;
    resign(): void;
    store: {
      settings: { value: object };
      phase: { value: string };
      humanToMove: { value: boolean };
      isLive: { value: boolean };
      liveFen: { value: string };
      viewIndex: { value: number | null };
      plies: { value: { san: string }[] };
      explorer: { value: { cursor: number; moves: { san: string; rating?: object }[] } | null };
      explorerPosition: { value: { fen: string; dests: Map<string, string[]> } | null };
      review: { value: { progress: number | null } | null };
      board: { value: { fen: string } };
    };
  };
}
/** The page's debug hook (src/main.tsx). */
type Win = { __chessCoach?: Hook };

const board = (page: Page): Locator => page.locator('.board cg-board').first();
const tool = (page: Page, id: string): Locator => page.locator(`.toolbar-btn[data-id="${id}"]`);
const panel = (page: Page): Locator => page.locator('.app-panel .xpanel');
const lineMoves = (page: Page): Locator => page.locator('.app-moves .mlist-move:not(.mlist-lead)');
const engineSwitch = (page: Page): Locator => panel(page).locator('[data-id="explorer-engine"]');
/** Engine arrows (auto shapes; their arrowheads stay defined once drawn) and verdict badges (custom SVGs) on the board. */
const arrows = (page: Page): Locator => page.locator('.cg-shapes line');
const badges = (page: Page): Locator => page.locator('.cg-custom-svgs [cgHash]');

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

async function tapMove(page: Page, uci: string): Promise<void> {
  for (const sq of [uci.slice(0, 2), uci.slice(2, 4)]) {
    const { x, y } = await squareCenter(page, sq);
    await page.touchscreen.tap(x, y);
  }
}

async function waitForMyTurn(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as unknown as Win).__chessCoach?.controller.store;
    return !!s && s.phase.value === 'playing' && s.humanToMove.value && s.isLive.value;
  });
}

/** The first of `wanted` that is legal on the explorer's board (else any legal move). */
async function explorerMove(page: Page, wanted: string[]): Promise<string> {
  const all = await page.evaluate(() => {
    const out: string[] = [];
    const pos = (window as unknown as Win).__chessCoach!.controller.store.explorerPosition.value!;
    for (const [from, tos] of pos.dests) for (const to of tos) out.push(from + to);
    return out;
  });
  expect(all.length).toBeGreaterThan(0);
  return wanted.find((m) => all.includes(m)) ?? all[0];
}

const gameSans = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.plies.value.map((p) => p.san));
const evalText = async (page: Page) => (await page.locator('.evalbar').getAttribute('aria-valuetext')) ?? '';

async function startGame(page: Page): Promise<void> {
  await page.goto('./');
  const sheet = page.getByRole('dialog', { name: 'New game' });
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await sheet.locator('[data-bot="pip"]').tap();
  await sheet.locator('.ngs-color[data-color="w"]').tap();
  await sheet.getByRole('button', { name: 'Play' }).tap();
  await expect(sheet).toBeHidden();
}

test.describe('Explorer', () => {
  test('during a rated game: no question and no engine, moves for both sides, Play keeps it rated; the Engine switch asks, then everything', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await startGame(page);
    await waitForMyTurn(page);
    await tapMove(page, 'e2e4');
    await expect(page.locator('.app-moves .mlist-move')).toHaveCount(2, { timeout: 30_000 });
    await waitForMyTurn(page);
    const game = await gameSans(page);
    const live = await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.liveFen.value);
    await expect(page.locator('.evalbar[role="meter"]')).toBeVisible(); // the game's own bar

    // Explore opens at once, with the engine off: the game stays rated.
    await tool(page, 'explore').tap();
    await expect(page.locator('.app[data-exploring]')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Turn on the engine?' })).toHaveCount(0);
    await expect(page.locator('[data-id="exploring"]')).toHaveText('Exploring');
    await expect(page.locator('.app-player--bottom')).not.toContainText('Unrated');
    await expect(panel(page).locator('.xpanel-title')).toHaveText('White to move');
    await expect(panel(page)).toContainText('Engine off: try moves for both sides. Your game stays rated.');
    await expect(engineSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(engineSwitch(page)).toHaveAccessibleName('Engine');
    await expect(page.locator('.evalbar[role="meter"]')).toHaveCount(0);
    await expect(page.locator('.evalbar-off')).toHaveAttribute('aria-label', 'Evaluation: engine off');
    await expect(tool(page, 'explorerReply')).toBeDisabled(); // in its place, so the toolbar keeps its shape
    await expect(page.locator('.app-moves .mlist-lead')).toContainText('From 1…');

    // Moves for both sides by tapping squares: no ratings, arrows, badges or best move.
    const white = await explorerMove(page, ['g1f3', 'b1c3', 'd2d4']);
    await tapMove(page, white);
    await expect(lineMoves(page)).toHaveCount(1);
    await tapMove(page, await explorerMove(page, ['b8c6', 'g8f6', 'd7d6']));
    await expect(lineMoves(page)).toHaveCount(2);
    await expect(panel(page).locator('.xpanel-title')).toHaveText(/^2… \S+$/);
    await page.waitForTimeout(3_000); // time enough for an engine answer, were one asked for
    await expect(page.locator('.app-moves .class-icon')).toHaveCount(0);
    await expect(panel(page).locator('.class-icon, .xpanel-verdict, .xpanel-eval, .xpanel-best')).toHaveCount(0);
    await expect(arrows(page)).toHaveCount(0);
    await expect(badges(page)).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.explorer.value!.moves.some((m) => m.rating)),
    ).toBe(false);

    // Back, then "Play 2. X" commits the first move to the game; the game is still rated.
    await tool(page, 'prev').tap();
    await expect(panel(page).locator('.xpanel-title')).toHaveText(/^2\. \S+$/);
    expect(await gameSans(page)).toEqual(game);
    expect(await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.liveFen.value)).toBe(live);
    const first = await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.explorer.value!.moves[0].san);
    const play = panel(page).locator('[data-action="play"]');
    await expect(play).toHaveText(`Play 2. ${first}`);
    await play.tap();
    await expect(page.locator('.app[data-exploring]')).toHaveCount(0);
    await expect.poll(() => gameSans(page)).toEqual([...game, first]);
    await expect(page.locator('.app-moves .mlist-move')).toHaveCount(4, { timeout: 30_000 });
    await expect(page.locator('.app-panel .coach')).toBeVisible();
    await expect(page.locator('.app-player--bottom')).not.toContainText('Unrated');

    // The Engine switch asks first; Keep off changes nothing.
    await waitForMyTurn(page);
    await tool(page, 'explore').tap();
    await expect(page.locator('.app[data-exploring]')).toBeVisible();
    await expect(engineSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await engineSwitch(page).tap();
    const ask = page.getByRole('dialog', { name: 'Turn on the engine?' });
    await expect(ask).toBeVisible();
    await expect(ask).toContainText(
      'The engine’s evaluation, best moves and move ratings will show while you explore. Turning it on makes this game unrated: win or lose, your rating stays the same. Switching it off again won’t undo that.',
    );
    const backAt = (await tool(page, 'prev').boundingBox())!.x;
    await ask.getByRole('button', { name: 'Keep off' }).tap();
    await expect(ask).toBeHidden();
    await expect(engineSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('.app-player--bottom')).not.toContainText('Unrated');

    // Turn on: the game becomes unrated, and the engine shows everything.
    await engineSwitch(page).tap();
    await ask.locator('[data-id="confirm-ok"]').tap();
    await expect(ask).toBeHidden();
    await expect(engineSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.app-player--bottom')).toContainText('Unrated');
    await expect(page.locator('.evalbar[role="meter"]')).toBeVisible();
    expect((await tool(page, 'prev').boundingBox())!.x).toBe(backAt); // the toolbar did not move
    await tapMove(page, await explorerMove(page, ['d2d4', 'd2d3', 'b1c3']));
    await expect(lineMoves(page)).toHaveCount(1);
    await tapMove(page, await explorerMove(page, ['d7d6', 'g8f6', 'a7a6']));
    await expect(lineMoves(page)).toHaveCount(2);
    await expect(page.locator('.app-moves .mlist-move:not(.mlist-lead) .class-icon')).toHaveCount(2, { timeout: 30_000 });
    await expect(panel(page).locator('.xpanel-move .class-icon, .xpanel-move .xpanel-verdict').first()).toBeVisible();
    await expect(panel(page).locator('.xpanel-eval')).toHaveText(/^[+-]?(\d+\.\d|M\d+)$/, { timeout: 30_000 });
    await expect(panel(page).locator('.xpanel-best')).toHaveText(/^Best here: \S+ \(/, { timeout: 30_000 });
    await expect.poll(() => evalText(page), { timeout: 30_000 }).toMatch(/^[+-]?(\d+\.\d|M\d+)/);
    await expect(arrows(page).first()).toBeAttached();
    await expect(panel(page).locator('[data-action="arrows"]')).toHaveText('Arrows on');

    // Reset, then Engine reply plays White's best move.
    await tool(page, 'explorerReset').tap();
    await expect(lineMoves(page)).toHaveCount(0);
    await expect(page.locator('.app-moves .mlist-empty')).toHaveText('Try a move for either side');
    await tool(page, 'explorerReply').tap();
    await expect(lineMoves(page)).toHaveCount(1, { timeout: 30_000 });

    // Off again: everything hides at once; the game stays unrated.
    await engineSwitch(page).tap();
    await expect(page.getByRole('dialog', { name: 'Turn on the engine?' })).toHaveCount(0);
    await expect(engineSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('.evalbar[role="meter"]')).toHaveCount(0);
    await expect(page.locator('.app-moves .class-icon')).toHaveCount(0);
    await expect(arrows(page)).toHaveCount(0);
    await expect(tool(page, 'explorerReply')).toBeDisabled();
    await expect(page.locator('.app-player--bottom')).toContainText('Unrated');
    await expect(panel(page)).toContainText('Engine off: try moves for both sides. This game is already unrated.');

    // Exit back to the game as it was.
    await tool(page, 'explorerExit').tap();
    await expect(page.locator('.app[data-exploring]')).toHaveCount(0);
    await expect(page.locator('.app-moves .mlist-move')).toHaveCount(4);
    await expect(tool(page, 'undo')).toBeVisible();
    await expect(page.locator('.evalbar[role="meter"]')).toBeVisible();
    const shown = await page.evaluate(() => {
      const s = (window as unknown as Win).__chessCoach!.controller.store;
      return { board: s.board.value.fen, live: s.liveFen.value, explorer: s.explorer.value };
    });
    expect(shown.explorer).toBeNull();
    expect(shown.board).toBe(shown.live);
    expect(errors).toEqual([]);
  });

  test('a move started in the explorer never finishes in the game, nor the other way round', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('./');
    await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible({ timeout: 30_000 });
    const start = (startFen: string) =>
      page.evaluate((fen) => {
        const c = (window as unknown as Win).__chessCoach!.controller;
        // Best-move arrows: unrated from the start, so Explore opens without a question.
        c.newGame({ ...c.store.settings.value, playerColor: 'w', botId: 'pip', botElo: 100, adaptive: false, showBestMoves: true }, { startFen: fen });
      }, startFen);
    const tapSquare = async (sq: string) => {
      const { x, y } = await squareCenter(page, sq);
      await page.touchscreen.tap(x, y);
    };
    const picker = page.locator('.board-promo');
    // (chessground hides the squares it no longer needs rather than removing them)
    const selected = page.locator('.board cg-board square.selected').filter({ visible: true });
    const exploring = page.locator('.app[data-exploring]');

    // A promotion picker opened in the explorer: Exit closes it, and the game stays as it was.
    await start('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    await waitForMyTurn(page);
    await tool(page, 'explore').tap();
    await expect(exploring).toBeVisible();
    await tapSquare('a7');
    await tapSquare('a8');
    await expect(picker).toBeVisible();
    await tool(page, 'explorerExit').tap();
    await expect(exploring).toHaveCount(0);
    await expect(picker).toHaveCount(0);
    await tapSquare('a8'); // where the queen was offered
    await page.waitForTimeout(300);
    expect(await gameSans(page)).toEqual([]);

    // A piece selected in the explorer: Exit drops it, so one tap in the game moves nothing.
    await start('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    await waitForMyTurn(page);
    await tool(page, 'explore').tap();
    await expect(exploring).toBeVisible();
    await tapSquare('e2');
    await expect(selected).toHaveCount(1);
    await tool(page, 'explorerExit').tap();
    await expect(exploring).toHaveCount(0);
    await expect(selected).toHaveCount(0);
    await expect(page.locator('.board cg-board square.move-dest').filter({ visible: true })).toHaveCount(0);
    await tapSquare('e4');
    await page.waitForTimeout(300);
    expect(await gameSans(page)).toEqual([]);

    // And a piece selected in the game does not move in the explorer.
    await tapSquare('d2');
    await expect(selected).toHaveCount(1);
    await tool(page, 'explore').tap();
    await expect(exploring).toBeVisible();
    await expect(selected).toHaveCount(0);
    await tapSquare('d4');
    await page.waitForTimeout(300);
    await expect(lineMoves(page)).toHaveCount(0);
    expect(await gameSans(page)).toEqual([]);
  });

  test('short phone and landscape: the news from the game shows collapsed, the Engine switch stays in sight, the panel never squeezes its text, Flip stays', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('./');
    await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => {
      const c = (window as unknown as Win).__chessCoach!.controller;
      c.newGame({ ...c.store.settings.value, playerColor: 'w', botId: 'pip', botElo: 100, adaptive: false, showBestMoves: true });
    });
    await waitForMyTurn(page);
    await tapMove(page, 'e2e4');
    await tool(page, 'explore').tap(); // the bot's turn: it plays on in the game
    await expect(page.locator('.app[data-exploring]')).toBeVisible();
    const row = page.locator('.app-panel .xpanel--collapsed');
    await expect(row).toBeVisible();
    // The one-row panel keeps the Engine switch beside its row (no need to open it first).
    await expect(row.locator('[data-id="explorer-engine"]')).toHaveAttribute('aria-checked', 'false');
    await expect(row.locator('[data-id="explorer-engine"]')).toHaveAccessibleName('Engine');
    await expect(row.locator('.xpanel-notice')).toHaveText(/^Pip (is thinking|played 1… \S+) in your game/);
    await expect.poll(() => gameSans(page), { timeout: 30_000 }).toHaveLength(2);
    await expect(row.locator('.xpanel-notice')).toHaveText(/^Pip played 1… \S+ in your game$/);

    // Landscape: the explorer collapses rather than leave its explanation a line or less. The
    // engine goes on at once (an unrated game) from its switch, which either form of the panel
    // shows (so the tap needs no guess about which form the resize has settled on).
    await page.setViewportSize({ width: 852, height: 393 });
    await engineSwitch(page).tap();
    await expect(page.locator('.evalbar[role="meter"]')).toBeVisible();
    await expect(engineSwitch(page)).toHaveAttribute('aria-checked', 'true'); // still in sight after the switch
    await expect(tool(page, 'explorerReply')).toBeVisible();
    await tapMove(page, await explorerMove(page, ['g1f3', 'b1c3', 'd2d4']));
    await expect(page.locator('.app-moves .mlist-move:not(.mlist-lead) .class-icon')).toHaveCount(1, { timeout: 30_000 });
    const body = await page.locator('.app-panel .xpanel-body').evaluateAll((els) => els.map((e) => [e.clientHeight, e.scrollHeight]));
    for (const [shown, full] of body) expect(shown >= 38 || shown >= full).toBe(true);
    await expect(tool(page, 'flip')).toBeVisible();

    // The "Exploring" tag goes back to the game; the game's bar keeps Flip (New is in the Menu).
    await page.locator('[data-id="exploring"]').tap();
    await expect(page.locator('.app[data-exploring]')).toHaveCount(0);
    await expect(tool(page, 'flip')).toBeVisible();
    await expect(tool(page, 'newGame')).toBeHidden();
    await page.setViewportSize({ width: 393, height: 852 });
    await expect(tool(page, 'newGame')).toBeVisible();
  });

  test('in Game Review: the engine on, no question, and Exit returns to the move being reviewed', async ({ page }) => {
    test.setTimeout(180_000);
    await startGame(page);
    await waitForMyTurn(page);
    await tapMove(page, 'e2e4');
    await expect(page.locator('.app-moves .mlist-move')).toHaveCount(2, { timeout: 30_000 });
    await waitForMyTurn(page);
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.resign());
    const over = page.getByRole('dialog', { name: 'You lost You resigned' });
    await over.getByRole('button', { name: 'Game Review' }).tap();
    const review = page.getByRole('region', { name: 'Game Review' });
    await expect(review.locator('.review-progress')).toHaveCount(0, { timeout: 90_000 });
    await tool(page, 'prev').tap();
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.viewIndex.value)).toBe(1);
    const ratingBefore = await page.locator('.app-player--bottom').textContent();

    await tool(page, 'explore').tap();
    await expect(page.locator('.app[data-exploring]')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Turn on the engine?' })).toHaveCount(0);
    await expect(engineSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.evalbar[role="meter"]')).toBeVisible();
    await expect(page.locator('.app-moves .mlist-lead')).toHaveText('From 1. e4');
    await tapMove(page, await explorerMove(page, ['e7e5', 'c7c5', 'e7e6']));
    await expect(lineMoves(page)).toHaveCount(1);
    await expect(page.locator('.app-moves .mlist-move:not(.mlist-lead) .class-icon')).toHaveCount(1, { timeout: 30_000 });

    await page.keyboard.press('Escape'); // leaves the explorer too
    await expect(page.locator('.app[data-exploring]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.phase.value)).toBe('review');
    expect(await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.viewIndex.value)).toBe(1);
    await expect(tool(page, 'summary')).toBeVisible();
    await expect(page.locator('.app-player--bottom')).toHaveText(ratingBefore ?? '');
    await expect(page.locator('.app-player--bottom')).not.toContainText('Unrated');
  });
});
