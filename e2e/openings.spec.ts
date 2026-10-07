/**
 * The Openings section end to end, on the production build (iPhone 15 Pro emulation; the plain web
 * build has everything unlocked): open it from the Menu, the beginner card, Start here, a family,
 * Learn (step with the buttons, the move notes, a branch into another line through "Other moves
 * here", the browser's Back), Explore by moves (tapping moves and moving on the board), search,
 * a drill as Black with wrong and correct moves made by tapping squares and a hint, the result and
 * the progress on the family's card, and playing the opening against the computer; the entry
 * from the New game sheet and from a game's opening name; the section offline (its lazy chunks are
 * precached); and how fast it opens and searches on a small phone with a 4x slower CPU.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

interface Hook {
  controller: {
    store: {
      phase: { value: string };
      plies: { value: { san: string }[] };
      game: { value: { playerColor: string; opening?: { line: { id: string }; mode: string } } | null };
    };
  };
}
type Win = { __chessCoach?: Hook };

const shell = (page: Page): Locator => page.getByRole('dialog', { name: 'Openings' });
const title = (page: Page): Locator => page.locator('[data-id="openings-title"]');
const opBoard = (page: Page): Locator => page.locator('.op-view .board cg-board');

/** Taps a square of the Openings board (from its box and orientation). */
async function tapSquare(page: Page, square: string): Promise<void> {
  // The page scrolls: bring the whole board into view first.
  await opBoard(page).evaluate(async (el) => {
    // A page that is still sliding in (its board measures itself when the slide ends).
    await Promise.all(document.querySelector('.op-page')?.getAnimations().map((a) => a.finished) ?? []);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    // Chessground re-measures the board on the scroll event, which comes with the next frame.
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

async function tapMove(page: Page, uci: string): Promise<void> {
  await tapSquare(page, uci.slice(0, 2));
  await tapSquare(page, uci.slice(2, 4));
}

/**
 * The drill waits for the player (no computer move pending, no wrong move on show) after `done` of
 * their moves. The count comes first: chessground reports a move a moment after the tap, so until
 * the page has taken it the old "Your move" is still on show.
 */
async function drillReady(page: Page, done: number): Promise<void> {
  await expect(page.locator('[data-id="drill-count"]')).toHaveText(`${done} of 5`);
  await expect(page.locator('[data-id="drill-run"]')).not.toHaveAttribute('data-busy', '');
  await expect(page.locator('[data-id="drill-status"]')).toContainText('Your move');
}

/** Opens the app and closes the New game sheet (the setup screen). */
async function openApp(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./');
  const sheet = page.getByRole('dialog', { name: 'New game' });
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await sheet.getByRole('button', { name: 'Close' }).tap();
  await expect(sheet).toBeHidden();
  return errors;
}

async function openFromMenu(page: Page): Promise<void> {
  await page.locator('.toolbar-btn[data-id="menu"]').tap();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu).toBeVisible();
  await menu.locator('[data-id="openings"]').tap();
  await expect(shell(page)).toBeVisible();
  await expect(title(page)).toHaveText('Openings', { timeout: 15_000 });
}

test.describe('Openings', () => {
  test('learn, explore, search, drill and play an opening', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = await openApp(page);
    await openFromMenu(page);
    // Focus (a screen reader's, a keyboard's) is in the section, not on the Menu under it.
    expect(await page.evaluate(() => !!document.activeElement?.closest('.openings-shell'))).toBe(true);

    // Done goes back to where it was opened from: the Menu, as it was, its Openings row focused.
    await page.locator('[data-id="openings-done"]').tap();
    await expect(shell(page)).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Menu' }).locator('[data-id="openings"]')).toBeFocused();
    await page.getByRole('dialog', { name: 'Menu' }).locator('[data-id="openings"]').tap();
    await expect(title(page)).toHaveText('Openings');

    // The beginner card, once.
    const intro = page.locator('[data-id="openings-intro"]');
    await expect(intro).toContainText('New to openings?');
    await expect(intro).toContainText('Book move');
    await intro.locator('[data-id="intro-dismiss"]').tap();
    await expect(intro).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('chesscoach.openings-intro'))).toBe('1');

    // Start here: White, the Italian Game.
    await expect(page.locator('[data-id="start-side"] [aria-checked="true"]')).toHaveText('I play White');
    const italian = page.locator('.op-card[data-family="Italian Game"]');
    await expect(italian).toContainText(/1\.\s+e4 e5 2\.\s+Nf3 Nc6 3\.\s+Bc4/);
    await expect(italian.locator('.op-pill')).toHaveText('Beginner-friendly');
    await italian.tap();
    await expect(title(page)).toHaveText('Italian Game');
    await expect(page.locator('.op-hero-side')).toContainText('An opening for White');
    await expect(page.locator('[data-id="guide"]')).toContainText('Your plans (White)');
    // Escape goes back a page; so does the Back button.
    await page.keyboard.press('Escape');
    await expect(title(page)).toHaveText('Openings');
    await italian.tap();
    await expect(title(page)).toHaveText('Italian Game');

    // Learn the main line: step with the buttons, read the notes.
    await page.locator('[data-id="learn-main"]').tap();
    await expect(title(page)).toHaveText('Main line');
    await expect(page.locator('[data-id="line-intro"]')).toBeVisible();
    for (let i = 0; i < 5; i++) await page.locator('[data-id="next"]').tap();
    await expect(page.locator('[data-id="move-title"]')).toContainText('3. Bc4');
    await expect(page.locator('[data-id="move-note"]')).toContainText('f7');
    await expect(page.locator('[data-id="position-name"]')).toContainText('Italian Game');
    await expect(page.locator('.op-strip-move[aria-current="true"]')).toHaveText('Bc4');
    await page.locator('[data-id="prev"]').tap();
    await expect(page.locator('[data-id="move-title"]')).toContainText('2... Nc6');
    await page.locator('[data-id="next"]').tap();
    await expect(page.locator('[data-id="move-title"]')).toContainText('3. Bc4');
    // The engine's evaluation of the position.
    await expect.poll(async () => (await page.locator('.op-view .evalbar').getAttribute('aria-valuetext')) ?? '', { timeout: 30_000 }).toMatch(/^[+-]?\d+\.\d$/);

    // Other moves here: 3... Nf6 branches into the Two Knights Defense.
    const nf6 = page.locator('[data-id="other-moves"] [data-uci="g8f6"]');
    await expect(nf6).toContainText('Two Knights Defense');
    await nf6.tap();
    await expect(page.locator('[data-id="move-title"]')).toContainText('3... Nf6');
    await expect(page.locator('[data-id="position-name"]')).toContainText('Two Knights Defense');
    await expect(page.locator('[data-id="openings-back"]')).toContainText('Main line');
    // The browser's (Android's) Back goes back to the line we came from, at the same move.
    await page.evaluate(() => history.back());
    await expect(title(page)).toHaveText('Main line');
    await expect(page.locator('[data-id="move-title"]')).toContainText('3. Bc4');
    // A move off the book on the board: the line waits with a way back.
    await tapMove(page, 'a7a5');
    await expect(page.locator('[data-id="off-book"]')).toContainText('leaves the opening book');
    await page.locator('[data-id="back-to-line"]').tap();
    await expect(page.locator('[data-id="move-title"]')).toContainText('3. Bc4');

    // Explore by moves: tap moves, then play one on the board.
    await page.locator('[data-id="openings-back"]').tap();
    await page.locator('[data-id="openings-back"]').tap();
    await expect(title(page)).toHaveText('Openings');
    await page.locator('[data-id="explore-moves"]').tap();
    await expect(title(page)).toHaveText('Explore by moves');
    await page.locator('[data-id="tree-moves"] [data-uci="e2e4"]').tap();
    await page.locator('[data-id="tree-moves"] [data-uci="c7c5"]').tap();
    await expect(page.locator('[data-id="position-name"]')).toContainText('Sicilian Defense');
    await expect(page.locator('[data-id="tree-moves"] [data-uci="g1f3"]')).toContainText('Main line');
    await tapMove(page, 'b1c3');
    await expect(page.locator('.op-trail-step[aria-current="true"]')).toHaveText('2. Nc3');
    await expect(page.locator('[data-id="position-name"]')).toContainText('Closed');
    await expect(page.locator('[data-id="tree-learn"]')).toBeVisible();
    await page.locator('[data-id="tree-back"]').tap();
    await expect(page.locator('.op-trail-step[aria-current="true"]')).toHaveText('1... c5');

    // Search: an opening by name comes first, as the way to its page.
    await page.locator('[data-id="openings-back"]').tap();
    await page.locator('[data-id="openings-search"]').fill('sicilian');
    await expect(page.locator('[data-id="search-openings"] .op-row').first()).toHaveAttribute('data-family', 'Sicilian Defense');
    await expect(page.locator('[data-id="eco-note"]')).toContainText('ECO codes');
    // Search by name: the Najdorf.
    await page.locator('[data-id="openings-search"]').fill('najdorf');
    const najdorf = page.locator('[data-id="search-results"] [data-line="b90-sicilian-defense-najdorf-variation"]');
    await expect(najdorf).toContainText('Najdorf Variation');
    await najdorf.tap();
    await expect(title(page)).toHaveText('Najdorf Variation');

    // Drill it as Black (the opening's side): a wrong move, correct moves, a hint, to the end.
    await page.locator('[data-id="drill-line"]').tap();
    await expect(page.locator('[data-id="drill-side"] [aria-checked="true"]')).toContainText('Black');
    await expect(page.locator('[data-id="drill-mode"] [aria-checked="true"]')).toHaveText('Strict: only this line');
    await page.locator('[data-id="drill-start"]').tap();
    await drillReady(page, 0);
    await expect(page.locator('[data-id="drill-last"]')).toHaveText('White played 1. e4.');
    // 1... a6 is a book move too, but not this line's.
    await tapMove(page, 'a7a6');
    await expect(page.locator('[data-id="drill-feedback"]')).toHaveAttribute('data-kind', 'alternative');
    await expect(page.locator('[data-id="drill-feedback"]')).toContainText('this line continues with 1... c5');
    await drillReady(page, 0);
    await tapMove(page, 'c7c5');
    await expect(page.locator('[data-id="drill-feedback"]')).toHaveAttribute('data-kind', 'correct');
    await drillReady(page, 1);
    // 2... h5 is not a book move: it is shown, then taken back.
    await tapMove(page, 'h7h5');
    await expect(page.locator('[data-id="drill-feedback"]')).toHaveAttribute('data-kind', 'wrong');
    await expect(page.locator('[data-id="drill-feedback"]')).toContainText('Try again');
    await drillReady(page, 1);
    await page.locator('[data-id="drill-hintbtn"]').tap();
    await expect(page.locator('[data-id="drill-hint"]')).toContainText('Move');
    await tapMove(page, 'd7d6');
    await expect(page.locator('[data-id="drill-feedback"]')).toHaveAttribute('data-kind', 'correct');
    for (const [i, mv] of ['c5d4', 'g8f6', 'a7a6'].entries()) {
      await drillReady(page, 2 + i);
      await tapMove(page, mv);
    }
    const end = page.locator('[data-id="drill-end"]');
    await expect(end).toBeVisible();
    await expect(page.locator('[data-id="drill-score"]')).toHaveText('60%');
    await expect(end).toContainText('3 of 5 moves found first time');
    await expect(page.locator('[data-id="drill-missed"]')).toContainText('1... c5');
    await expect(page.locator('[data-id="drill-missed"]')).toContainText('2... d6');
    await expect(page.locator('[data-id="drill-mastery"]')).toContainText('New → Learning');

    // The progress shows on the family's card and page. Back returns to the search as it was.
    await page.locator('[data-id="openings-back"]').tap();
    await page.locator('[data-id="openings-back"]').tap();
    await expect(title(page)).toHaveText('Openings');
    await expect(page.locator('[data-id="openings-search"]')).toHaveValue('najdorf');
    await expect(najdorf).toBeVisible();
    await page.getByRole('button', { name: 'Clear the search' }).tap();
    await page.locator('[data-id="start-side"] [data-value="b"]').tap();
    // The easiest openings for Black first; the Sicilian is under "Show all".
    await expect(page.locator('.op-card').first()).toHaveAttribute('data-family', 'Caro-Kann Defense');
    await page.locator('[data-id="starters-all"]').tap();
    const sicilian = page.locator('.op-card[data-family="Sicilian Defense"]');
    await expect(sicilian.locator('[data-id="card-progress"]')).toHaveText('Learning · 1 line practiced');
    await expect(sicilian.locator('.op-ring')).toHaveAttribute('data-level', '1');
    await expect(page.locator('[data-id="practice"]')).toContainText('Najdorf Variation');
    await sicilian.tap();
    await expect(page.locator('[data-id="family-progress"]')).toContainText('1 line practiced');

    // Play it against the computer, from move 1: the game starts and follows the line.
    await page.locator('[data-id="play-family"]').tap();
    const play = page.getByRole('dialog', { name: 'Play the Sicilian Defense' });
    await expect(play).toBeVisible();
    await expect(play.locator('[data-id="play-side"] [aria-checked="true"]')).toContainText('Black: play it');
    await expect(play.locator('[data-id="play-mode"] [aria-checked="true"]')).toHaveText('From move 1');
    await expect(play.locator('[data-id="play-unrated"]')).toContainText('unrated');
    await play.locator('[data-id="play-start"]').tap();
    await expect(shell(page)).toBeHidden();
    const game = await page.evaluate(() => {
      const g = (window as unknown as Win).__chessCoach!.controller.store.game.value;
      return { color: g?.playerColor, mode: g?.opening?.mode, line: g?.opening?.line.id };
    });
    // The game follows the line Learn and Drill teach: the guide's own main line, by its moves.
    expect(game).toMatchObject({ color: 'b', mode: 'steer', line: 'guide:Sicilian Defense' });
    await expect(page.locator('.app-panel [data-id="opening-banner"]')).toContainText('Sicilian Defense');
    // The computer plays the line's first move for White.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.plies.value[0]?.san ?? ''), { timeout: 30_000 })
      .toBe('e4');
    expect(errors).toEqual([]);
  });

  test('opens from the New game sheet and from the game’s opening name', async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('./');
    const sheet = page.getByRole('dialog', { name: 'New game' });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await sheet.locator('[data-id="learn-openings"]').tap();
    await expect(title(page)).toHaveText('Openings', { timeout: 15_000 });
    await page.locator('[data-id="openings-done"]').tap();
    await expect(shell(page)).toBeHidden();
    await expect(sheet).toBeVisible();

    // A game whose position has a name: the chip opens that line, its family under it.
    await page.evaluate(() => {
      const c = (window as unknown as { __chessCoach: { controller: { newGame(s: object, o: object): void; store: { settings: { value: object } } } } })
        .__chessCoach.controller;
      c.newGame(
        { ...c.store.settings.value, playerColor: 'w', botId: 'custom', botElo: 800, adaptive: false },
        { startFen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3' },
      );
    });
    const chip = page.locator('[data-id="opening-chip"]');
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toContainText('Italian Game');
    await chip.tap();
    await expect(shell(page)).toBeVisible();
    await expect(page.locator('[data-id="openings-back"]')).toContainText('Italian Game', { timeout: 15_000 });
    // A rated game is in progress: the section shows no engine evaluation (that would be live help).
    await expect(page.locator('[data-id="eval-hidden"]')).toContainText('hidden while your rated game is in progress');
    await expect(page.locator('.op-view .evalbar')).toHaveCount(0);
    await expect(page.locator('[data-id="eval-words"]')).toHaveCount(0);
    await page.locator('[data-id="openings-back"]').tap();
    await expect(title(page)).toHaveText('Italian Game');
    // Back to Home, and Escape there closes it: the game is as it was.
    await page.locator('[data-id="openings-back"]').tap();
    await expect(title(page)).toHaveText('Openings');
    await expect(page.locator('[data-id="openings-back"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(shell(page)).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.store.phase.value)).toBe('playing');
    expect(errors).toEqual([]);
  });
});

test.describe('Openings offline', () => {
  test('opens, searches and steps through a line offline, never opened before (its chunks are precached)', async ({ page, context }) => {
    test.setTimeout(90_000);
    await page.goto('./');
    await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible({ timeout: 30_000 });
    // The service worker controls the page once the precache is complete.
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, { timeout: 60_000 });
    await context.setOffline(true);
    try {
      await page.reload();
      const sheet = page.getByRole('dialog', { name: 'New game' });
      await expect(sheet).toBeVisible({ timeout: 30_000 });
      await sheet.locator('[data-id="learn-openings"]').tap();
      await expect(page.locator('.op-card[data-family="Italian Game"]')).toBeVisible({ timeout: 15_000 });
      await page.locator('[data-id="openings-search"]').fill('caro');
      await expect(page.locator('[data-id="search-results"] .op-row').first()).toContainText('Caro-Kann Defense');
      await page.locator('[data-id="search-results"] .op-row').first().tap();
      await page.locator('[data-id="next"]').tap();
      await expect(page.locator('[data-id="move-title"]')).toContainText('1. e4');
    } finally {
      await context.setOffline(false);
    }
  });
});

test.describe('Openings on a small phone with a slow CPU', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('opens and searches quickly (4x CPU throttling)', async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => {
      const w = window as unknown as { __longTasks: number[] };
      w.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push(e.duration);
      }).observe({ type: 'longtask', buffered: false });
    });

    await page.locator('.toolbar-btn[data-id="menu"]').tap();
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
    const t0 = Date.now();
    await page.getByRole('dialog', { name: 'Menu' }).locator('[data-id="openings"]').tap();
    await expect(page.locator('.op-card').first()).toBeVisible({ timeout: 20_000 });
    const openMs = Date.now() - t0;
    const openTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks.splice(0));

    const input = page.locator('[data-id="openings-search"]');
    const t1 = Date.now();
    await input.fill('najdorf');
    await expect(page.locator('[data-id="search-results"] .op-row').first()).toContainText('Najdorf');
    const searchMs = Date.now() - t1;
    const t2 = Date.now();
    await input.fill('1. e4 c5 2.Nf3');
    await expect(page.locator('[data-id="search-results"] .op-row').first()).toContainText('Sicilian');
    const movesMs = Date.now() - t2;
    const searchTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks.splice(0));

    const max = (a: number[]) => Math.round(Math.max(0, ...a));
    const report = `open ${openMs} ms (longest task ${max(openTasks)} ms); search "najdorf" ${searchMs} ms, moves ${movesMs} ms (longest task ${max(searchTasks)} ms)`;
    test.info().annotations.push({ type: 'performance (375x667, CPU 4x)', description: report });
    console.log(`[openings perf] ${report}`);
    expect(openMs).toBeLessThan(6_000);
    expect(searchMs).toBeLessThan(1_500);
    expect(max(searchTasks)).toBeLessThan(400);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  });
});
