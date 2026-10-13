/**
 * Fixes from a full playthrough, end to end (iPhone 15 Pro emulation, production build): Draw mode
 * while browsing keeps a way back in its bar (on top, not hidden under it) during the game and
 * after it, and Report in Game Review ends Draw mode; resigning from the Menu says what it costs
 * and leaves the focus in the game-over sheet, which shows the accuracy line and, while the
 * rating is new, says it moves fast (its X on top of its content); the Menu's tiles fit a 320-point-wide screen; in the Openings
 * section, the ⓘ on a move off the book (and any tap on its card) keeps the move, the move strip
 * keeps the current move in view in landscape, and a game's opening chip opens the line at the
 * game's position from the player's side with "Back to my game" in the Play sheet.
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
      viewIndex: { value: number | null };
      plies: { value: { san: string }[] };
      draw: { value: { on: boolean } | null };
      position: { value: { dests: Map<string, string[]> } };
    };
  };
}
type Win = { __chessCoach?: Hook };

const moves = (page: Page): Locator => page.locator('.app-moves .mlist-move:not(.mlist-lead)');
const tool = (page: Page, id: string): Locator => page.locator(`.toolbar-btn[data-id="${id}"]`);
const drawBar = (page: Page): Locator => page.getByRole('toolbar', { name: 'Draw' });
/** What the app's state says (the debug hook, src/main.tsx). */
const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as Win).__chessCoach!.controller.store;
    return {
      phase: s.phase.value,
      live: s.isLive.value,
      view: s.viewIndex.value,
      plies: s.plies.value.length,
      drawing: !!s.draw.value?.on,
    };
  });

async function squareCenter(page: Page, square: string): Promise<{ x: number; y: number }> {
  const box = await page.locator('.board cg-board').first().boundingBox();
  if (!box) throw new Error('board not visible');
  const white = await page.locator('.board .cg-wrap').first().evaluate((el) => el.classList.contains('orientation-white'));
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const size = box.width / 8;
  const col = white ? file : 7 - file;
  const row = white ? 7 - rank : rank;
  return { x: box.x + (col + 0.5) * size, y: box.y + (row + 0.5) * size };
}

async function waitForMyTurn(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as unknown as Win).__chessCoach?.controller.store;
    return !!s && s.phase.value === 'playing' && s.humanToMove.value && s.isLive.value;
  });
}

/** Plays `uci` by tapping its squares, then waits for the bot's reply. */
async function playAndWait(page: Page, uci: string): Promise<void> {
  const before = await moves(page).count();
  for (const sq of [uci.slice(0, 2), uci.slice(2, 4)]) {
    const { x, y } = await squareCenter(page, sq);
    await page.touchscreen.tap(x, y);
  }
  await expect(moves(page)).toHaveCount(before + 2, { timeout: 30_000 });
  await waitForMyTurn(page);
}

/** `locator` is what a finger at its center would touch (nothing covers it). */
async function onTop(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && el.contains(hit);
  });
}

/** A rated game as White against Pip (a new player: the rating is provisional). */
async function startGame(page: Page): Promise<void> {
  await page.goto('./');
  const sheet = page.getByRole('dialog', { name: 'New game' });
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await sheet.locator('[data-bot="pip"]').tap();
  await sheet.locator('.ngs-color[data-color="w"]').tap();
  await sheet.getByRole('button', { name: 'Play' }).tap();
  await expect(sheet).toBeHidden();
  await waitForMyTurn(page);
}

const shell = (page: Page): Locator => page.getByRole('dialog', { name: 'Openings' });
const opTitle = (page: Page): Locator => page.locator('[data-id="openings-title"]');
const opBoard = (page: Page): Locator => page.locator('.op-view .board cg-board');

async function opTapSquare(page: Page, square: string): Promise<void> {
  await opBoard(page).evaluate(async (el) => {
    await Promise.all(document.querySelector('.op-page')?.getAnimations().map((a) => a.finished) ?? []);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  const box = await opBoard(page).boundingBox();
  if (!box) throw new Error('board not visible');
  const white = await page.locator('.op-view .board .cg-wrap').evaluate((el) => el.classList.contains('orientation-white'));
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const size = box.width / 8;
  const col = white ? file : 7 - file;
  const row = white ? 7 - rank : rank;
  await page.touchscreen.tap(box.x + (col + 0.5) * size, box.y + (row + 0.5) * size);
}

/** Opens the app, closes the New game sheet and opens the Openings section from the Menu. */
async function openOpeningsFromMenu(page: Page): Promise<void> {
  await page.goto('./');
  const sheet = page.getByRole('dialog', { name: 'New game' });
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await sheet.getByRole('button', { name: 'Close' }).tap();
  await expect(sheet).toBeHidden();
  await tool(page, 'menu').tap();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu).toBeVisible();
  await menu.locator('[data-id="openings"]').tap();
  await expect(shell(page)).toBeVisible();
  await expect(opTitle(page)).toHaveText('Openings', { timeout: 15_000 });
}

/** Home → Italian Game → Learn the main line, stepped to 3. Bc4. */
async function italianAtBc4(page: Page): Promise<void> {
  const intro = page.locator('[data-id="intro-dismiss"]');
  if (await intro.count()) await intro.tap();
  await page.locator('.op-card[data-family="Italian Game"]').tap();
  await expect(opTitle(page)).toHaveText('Italian Game');
  await page.locator('[data-id="learn-main"]').tap();
  await expect(opTitle(page)).toHaveText('Main line');
  // Its length as chess players count it (a move is White's and Black's).
  await expect(page.locator('[data-id="line-intro"]')).toContainText(/\d+ moves \(White plays \d+, Black \d+\)/);
  for (let i = 0; i < 5; i++) await page.locator('[data-id="next"]').tap();
  await expect(page.locator('[data-id="move-title"]')).toContainText('3. Bc4');
}

test.describe('Playthrough fixes', () => {
  test('Draw mode while browsing: Back in the bar (during and after the game); resign from the Menu; Report ends Draw mode', async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await startGame(page);
    await playAndWait(page, 'e2e4');
    await playAndWait(page, 'g1f3');

    // Browse to 1. e4, then Draw: the bar covers the strip's chip, so the way back is in the bar.
    await moves(page).first().tap();
    await expect.poll(async () => (await state(page)).live).toBe(false);
    await page.locator('[data-id="draw"]').tap();
    await expect(drawBar(page)).toBeVisible();
    const back = drawBar(page).locator('[data-id="draw-back"]');
    await expect(back).toHaveText('Back');
    expect(await onTop(back), 'the bar’s Back is on top').toBe(true);
    await back.tap();
    await expect.poll(async () => (await state(page)).live).toBe(true);
    await expect(drawBar(page)).toBeVisible(); // Draw mode stays on
    await expect(back).toHaveCount(0); // live again: nothing to go back to
    await drawBar(page).locator('[data-id="draw-done"]').tap();
    await expect(drawBar(page)).toBeHidden();

    // Resign from the Menu: the confirmation says what the loss costs.
    await tool(page, 'menu').tap();
    const menu = page.getByRole('dialog', { name: 'Menu' });
    await menu.locator('.menu-tile[data-id="resign"]').tap();
    await expect(menu.locator('[data-id="resign-note"]')).toContainText(/your rating goes from \d+ to \d+ \(−\d+\)/);
    await menu.locator('[data-id="resign-confirm"]').tap();
    const over = page.getByRole('dialog', { name: /You lost/ });
    await expect(over).toBeVisible();
    // The focus moved into the game-over sheet (not left on the toolbar's Menu button behind it).
    await expect.poll(() => over.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    expect(await page.evaluate(() => !!document.activeElement?.closest('.toolbar'))).toBe(false);
    // How the game went, and the new rating's fast moves explained.
    await expect(over.locator('[data-id="gos-play"]')).toContainText(/Checking your moves|Accuracy: You/);
    await expect(over.locator('[data-id="gos-provisional"]')).toContainText('New ratings move fast at first');
    await expect(over.locator('[data-id="gos-play"]')).toContainText(/Accuracy: You \d+%/, { timeout: 60_000 });
    // Its Close button is on top of the sheet's content (a tap on the X closes it).
    const close = over.getByRole('button', { name: 'Close' });
    expect(await onTop(close), 'the X is on top').toBe(true);
    await close.tap();
    await expect(over).toBeHidden();

    // After the game: browsing back, then Draw: "Final" in the bar goes to the final position.
    await tool(page, 'prev').tap();
    await tool(page, 'prev').tap();
    await page.locator('[data-id="draw"]').tap();
    await expect(back).toHaveText('Final');
    expect(await onTop(back), 'the bar’s Final is on top').toBe(true);
    await back.tap();
    await expect.poll(async () => (await state(page)).view).toBe(null);
    await drawBar(page).locator('[data-id="draw-done"]').tap();

    // Game Review: Report floats over the board and the bar, so it ends Draw mode.
    await tool(page, 'review').tap();
    await expect(page.getByRole('region', { name: 'Game Review' })).toBeVisible({ timeout: 60_000 });
    const report = tool(page, 'summary');
    if ((await report.getAttribute('aria-pressed')) === 'true') await report.tap();
    await page.locator('[data-id="draw"]').tap();
    await expect(drawBar(page)).toBeVisible();
    await report.tap();
    await expect(drawBar(page)).toBeHidden();
    expect((await state(page)).drawing).toBe(false);
    expect(errors).toEqual([]);
  });

  test.describe('320-point-wide screen (Display Zoom)', () => {
    test.use({ viewport: { width: 320, height: 568 } });
    test('the Menu’s tiles show their whole labels', async ({ page }) => {
      await page.goto('./');
      const sheet = page.getByRole('dialog', { name: 'New game' });
      await expect(sheet).toBeVisible({ timeout: 30_000 });
      await sheet.getByRole('button', { name: 'Close' }).tap();
      await tool(page, 'menu').tap();
      const menu = page.getByRole('dialog', { name: 'Menu' });
      await expect(menu).toBeVisible();
      const labels = menu.locator('.menu-tile-label');
      await expect(labels).toHaveCount(4);
      for (const label of await labels.all()) {
        const fit = await label.evaluate((el) => ({
          text: el.textContent,
          fits: el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1,
        }));
        expect(fit.fits, `${fit.text} fits`).toBe(true);
      }
    });
  });

  test('Openings: the ⓘ on a move off the book (and a tap on its card) keeps the move', async ({ page }) => {
    test.setTimeout(90_000);
    await openOpeningsFromMenu(page);
    await italianAtBc4(page);
    await opTapSquare(page, 'a7');
    await opTapSquare(page, 'a5');
    const off = page.locator('[data-id="off-book"]');
    await expect(off).toContainText('leaves the opening book');
    // The ⓘ opens its explanation; tapping the explanation or the card's text changes nothing.
    await page.locator('[data-id="book-term"] .op-term-btn').tap();
    const note = page.locator('[data-id="book-term"] [role="note"]');
    await expect(note).toContainText('opening book');
    await note.tap();
    await expect(off).toBeVisible();
    await off.locator('.op-note-text').tap();
    await expect(off).toBeVisible();
    await expect(off).toContainText('a5');
    await page.locator('[data-id="back-to-line"]').tap();
    await expect(page.locator('[data-id="move-title"]')).toContainText('3. Bc4');
  });

  test.describe('landscape', () => {
    test.use({ viewport: { width: 852, height: 393 } });
    test('Openings: the move strip keeps the current move in view', async ({ page }) => {
      test.setTimeout(90_000);
      await openOpeningsFromMenu(page);
      await italianAtBc4(page);
      const strip = page.locator('.op-strip');
      for (const id of ['last', 'first', 'last']) {
        await page.locator(`[data-id="${id}"]`).tap();
        const current = strip.locator('.op-strip-move[aria-current="true"]');
        await expect
          .poll(async () => {
            const [s, c] = [await strip.boundingBox(), await current.boundingBox()];
            return !!s && !!c && c.x >= s.x - 1 && c.x + c.width <= s.x + s.width + 1;
          }, { message: `the current move is in view after ${id}` })
          .toBe(true);
      }
    });
  });

  test('the opening chip opens the line at the game’s position from the player’s side; Back to my game', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('./');
    await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible({ timeout: 30_000 });
    // A rated game as Black after 1. e4 e5 2. Nf3 Nc6 3. Bc4 (the Italian Game), Black to move.
    await page.evaluate(() => {
      const c = (window as unknown as Win).__chessCoach!.controller;
      c.newGame(
        { ...c.store.settings.value, playerColor: 'b', botId: 'custom', botElo: 800, adaptive: false },
        { startFen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3' },
      );
    });
    await waitForMyTurn(page);
    await playAndWait(page, 'g8f6');
    const chip = page.locator('[data-id="opening-chip"]');
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await chip.tap();
    await expect(shell(page)).toBeVisible();
    await expect(page.locator('[data-id="move-title"]')).toBeVisible({ timeout: 15_000 });
    // At the named position (not the line's start), the board from Black's side.
    await expect(page.locator('[data-id="move-title"]')).not.toContainText('1. e4');
    await expect(page.locator('.op-view .board .cg-wrap')).toHaveClass(/orientation-black/);
    // Play: the game in progress is rated, so the sheet says what starting costs and offers the way back.
    await page.locator('[data-id="openings-back"]').tap();
    await page.locator('[data-id="play-family"]').tap();
    const play = page.getByRole('dialog', { name: /^Play the / });
    await expect(play).toBeVisible();
    await expect(play.locator('[data-id="play-start"]')).toHaveText('Resign & play');
    await play.locator('[data-id="play-back-to-game"]').tap();
    await expect(shell(page)).toBeHidden();
    expect(await state(page)).toMatchObject({ phase: 'playing', plies: 2 });
  });
});
