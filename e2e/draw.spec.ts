/**
 * Draw mode end to end, on the production build (iPhone 15 Pro emulation, real touch events through
 * the DevTools protocol): during a rated game the Draw toggle turns the board into a drawing
 * surface (a touch drag draws an arrow, a tap a circle, the same again takes it off, colors, Clear,
 * Done), no piece moves meanwhile, a second finger draws nothing, a flipped board maps its squares,
 * the page never scrolls, and the game stays rated; drawings stay on their positions (browsing back
 * shows them again) and are shared with the explorer; Escape leaves Draw mode, then the explorer;
 * Game Review; the bar on a short phone and in landscape; and the Openings section's Learn board.
 */
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';

interface Hook {
  controller: {
    newGame(settings: object, opts?: { startFen?: string }): void;
    resign(): void;
    stepForward(): void;
    store: {
      settings: { value: object };
      phase: { value: string };
      humanToMove: { value: boolean };
      isLive: { value: boolean };
      liveFen: { value: string };
      plies: { value: { san: string }[] };
      game: { value: { assisted: boolean } | null };
      board: { value: { fen: string; shapes?: { orig: string; dest?: string; brush: string }[] } };
    };
  };
}
/** The page's debug hook (src/main.tsx). */
type Win = { __chessCoach?: Hook };

/** The `--draw-*` colors (src/styles/app.css), as chessground's brushes draw them. */
const GREEN = '#15a34a';
const RED = '#e03131';
const BLUE = '#2563eb';

const board = (page: Page): Locator => page.locator('.board cg-board').first();
const tool = (page: Page, id: string): Locator => page.locator(`.toolbar-btn[data-id="${id}"]`);
const toggle = (page: Page): Locator => page.locator('[data-id="draw"]');
const bar = (page: Page): Locator => page.getByRole('toolbar', { name: 'Draw' });
const swatch = (page: Page, color: string): Locator => bar(page).getByRole('radio', { name: color });
/** The player's arrows and circles in a color (chessground's SVG shapes). */
const arrowsIn = (page: Page, stroke: string): Locator => page.locator(`.board .cg-shapes line[stroke="${stroke}"]`);
const circlesIn = (page: Page, stroke: string): Locator => page.locator(`.board .cg-shapes circle[stroke="${stroke}"]`);
const allShapes = (page: Page): Locator => page.locator('.board .cg-shapes g[cgHash] :is(line, circle)');
const store = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as Win).__chessCoach!.controller.store;
  return { fen: s.board.value.fen, shapes: s.board.value.shapes ?? [], plies: s.plies.value.length, assisted: s.game.value?.assisted };
});

/** The center of a square on the game's board (or on the board inside `scope`). */
async function squareCenter(page: Page, square: string, scope = ''): Promise<{ x: number; y: number }> {
  const box = await page.locator(`${scope} .board cg-board`.trim()).first().boundingBox();
  if (!box) throw new Error('board not visible');
  const white = await page.locator(`${scope} .board .cg-wrap`.trim()).first().evaluate((el) => el.classList.contains('orientation-white'));
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const size = box.width / 8;
  const col = white ? file : 7 - file;
  const row = white ? 7 - rank : rank;
  return { x: box.x + (col + 0.5) * size, y: box.y + (row + 0.5) * size };
}

async function tapSquare(page: Page, square: string, scope = ''): Promise<void> {
  const { x, y } = await squareCenter(page, square, scope);
  await page.touchscreen.tap(x, y);
}

/**
 * A one-finger touch drag from one square to another (real touch events, in steps). The finger
 * rests a moment before it lifts, as a real one does: an instant flick would leave Chromium
 * swallowing the next tap (its fling's tap suppression), which has nothing to do with the app.
 */
async function touchDrag(page: Page, cdp: CDPSession, from: string, to: string, scope = ''): Promise<void> {
  const a = await squareCenter(page, from, scope);
  const b = await squareCenter(page, to, scope);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y, id: 1 }] });
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, id: 1 }] });
  }
  await lift(page, cdp);
}

/** Lifts every finger after a short rest. */
async function lift(page: Page, cdp: CDPSession): Promise<void> {
  await page.waitForTimeout(120);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** The same with the mouse (a desktop browser). */
async function mouseDrag(page: Page, from: string, to: string): Promise<void> {
  const a = await squareCenter(page, from);
  const b = await squareCenter(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

async function waitForMyTurn(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as unknown as Win).__chessCoach?.controller.store;
    return !!s && s.phase.value === 'playing' && s.humanToMove.value && s.isLive.value;
  });
}

/** A rated game as White against Pip, started from the New game sheet. */
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

/** Nothing on the page scrolled (the board blocks touch scrolling; the layout is fixed). */
async function expectNoScroll(page: Page): Promise<void> {
  const offsets = await page.evaluate(() =>
    [document.scrollingElement, document.body, document.getElementById('app'), document.querySelector('.app')].map((el) => [
      el?.scrollTop ?? 0,
      el?.scrollLeft ?? 0,
    ]),
  );
  expect(offsets.flat().every((v) => v === 0), JSON.stringify(offsets)).toBe(true);
}

test.describe('Draw mode', () => {
  test('during a rated game: arrows and circles by touch, colors, Clear and Done; no move meanwhile; still rated', async ({ page, context }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    await startGame(page);
    const start = await store(page);

    // The toggle sits on the strip under the board; the first time, a tip says how to draw.
    await expect(toggle(page)).toBeVisible();
    await expect(toggle(page)).toHaveAccessibleName('Draw on the board');
    await toggle(page).tap();
    await expect(bar(page)).toBeVisible();
    await expect(toggle(page)).toHaveCount(0);
    await expect(page.locator('.board-draw')).toBeVisible();
    const tip = bar(page).locator('.drawbar-tip');
    await expect(tip).toHaveText(
      'Drag for an arrow, tap a square for a circle. Draw it again to erase it. Tap Done to move pieces.',
    );
    await expect(tip).toHaveCSS('pointer-events', 'none'); // taps go through to what is under it
    // Your move (the strip's turn dot is under the bar): the bar shows it.
    await expect(bar(page).locator('.drawbar-turn')).toBeVisible();
    await expect(bar(page).getByRole('status').first()).toHaveText('Your move. Tap Done to move a piece.');
    await expect(swatch(page, 'Green')).toHaveAttribute('aria-checked', 'true');
    await expect(bar(page).locator('[data-id="draw-clear"]')).toBeDisabled();

    // A touch drag e2 → e4 draws a green arrow (and moves nothing); a tap on d4 a circle. The
    // player's arrows are dashed: the engine's are solid, so the two never look alike.
    await touchDrag(page, cdp, 'e2', 'e4');
    await expect(arrowsIn(page, GREEN)).toHaveCount(1);
    await expect(arrowsIn(page, GREEN)).not.toHaveCSS('stroke-dasharray', 'none');
    await expect(tip).toHaveCount(0); // the tip has made its point
    await tapSquare(page, 'd4');
    await expect(circlesIn(page, GREEN)).toHaveCount(1);
    let now = await store(page);
    expect(now.plies).toBe(0);
    expect(now.fen).toBe(start.fen);
    expect(now.shapes).toEqual([
      { orig: 'e2', dest: 'e4', brush: 'green' },
      { orig: 'd4', brush: 'green' },
    ]);
    // Tapping a piece and its square selects nothing and moves nothing.
    await tapSquare(page, 'g1');
    await tapSquare(page, 'f3');
    await expect(page.locator('.board cg-board square.selected').filter({ visible: true })).toHaveCount(0);
    expect((await store(page)).plies).toBe(0);
    // Those two taps were circles: the same again takes each off.
    await expect(circlesIn(page, GREEN)).toHaveCount(3);
    await tapSquare(page, 'g1');
    await tapSquare(page, 'f3');
    await expect(circlesIn(page, GREEN)).toHaveCount(1);

    // Red: a mouse drag, and the circle on d4 recolored, then taken off.
    await swatch(page, 'Red').tap();
    await expect(swatch(page, 'Red')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.board-draw')).toHaveAttribute('data-color', 'red');
    await mouseDrag(page, 'g1', 'f3');
    await expect(arrowsIn(page, RED)).toHaveCount(1);
    await tapSquare(page, 'd4');
    await expect(circlesIn(page, GREEN)).toHaveCount(0);
    await expect(circlesIn(page, RED)).toHaveCount(1);
    await tapSquare(page, 'd4');
    await expect(circlesIn(page, RED)).toHaveCount(0);

    // A drag that comes back to its square, or leaves the board, draws nothing; two fingers neither.
    const e2 = await squareCenter(page, 'e2');
    const e4 = await squareCenter(page, 'e4');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: e2.x, y: e2.y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: e4.x, y: e4.y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: e2.x, y: e2.y, id: 1 }] });
    await lift(page, cdp);
    const box = (await board(page).boundingBox())!;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: e2.x, y: e2.y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: e2.x, y: box.y + box.height + 30, id: 1 }] });
    await lift(page, cdp);
    const c3 = await squareCenter(page, 'c3');
    const h6 = await squareCenter(page, 'h6');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c3.x, y: c3.y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c3.x, y: c3.y, id: 1 }, { x: h6.x, y: h6.y, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: h6.x, y: h6.y, id: 1 }, { x: c3.x, y: c3.y, id: 2 }] });
    await lift(page, cdp);
    await page.waitForTimeout(200);
    now = await store(page);
    expect(now.shapes).toEqual([
      { orig: 'e2', dest: 'e4', brush: 'green' },
      { orig: 'g1', dest: 'f3', brush: 'red' },
    ]);
    await expectNoScroll(page);

    // A flipped board maps its squares: a blue arrow e7 → e5 from Black's side.
    await tool(page, 'flip').tap();
    await expect(page.locator('.board .cg-wrap.orientation-black')).toBeVisible();
    await expect(bar(page)).toBeVisible(); // Flip keeps Draw mode
    await swatch(page, 'Blue').tap();
    await touchDrag(page, cdp, 'e7', 'e5');
    await expect(arrowsIn(page, BLUE)).toHaveCount(1);
    expect((await store(page)).shapes).toContainEqual({ orig: 'e7', dest: 'e5', brush: 'blue' });
    await tool(page, 'flip').tap();

    // Clear takes them all off this position; then a green arrow again, and Done.
    await bar(page).locator('[data-id="draw-clear"]').tap();
    await expect(allShapes(page)).toHaveCount(0);
    await expect(bar(page).locator('[data-id="draw-clear"]')).toBeDisabled();
    await swatch(page, 'Green').tap();
    await touchDrag(page, cdp, 'e2', 'e4');
    await expect(arrowsIn(page, GREEN)).toHaveCount(1);
    await bar(page).locator('[data-id="draw-done"]').tap();
    await expect(bar(page)).toHaveCount(0);
    await expect(page.locator('.board-draw')).toHaveCount(0);
    await expect(toggle(page)).toBeVisible();
    await expect(arrowsIn(page, GREEN)).toHaveCount(1); // the drawing stays

    // Pieces move again: 1. e4. The new position has no drawings; browsing back shows them again.
    await tapSquare(page, 'e2');
    await tapSquare(page, 'e4');
    await expect.poll(async () => (await store(page)).plies, { timeout: 30_000 }).toBe(2);
    await waitForMyTurn(page);
    await expect(allShapes(page)).toHaveCount(0);
    await page.keyboard.press('ArrowLeft'); // after 1. e4: none
    await expect(page.locator('[data-id="back-to-game"]')).toBeVisible();
    await expect(allShapes(page)).toHaveCount(0);
    await page.keyboard.press('ArrowLeft'); // the start: the arrow again
    await expect.poll(async () => (await store(page)).fen).toBe(start.fen);
    await expect(arrowsIn(page, GREEN)).toHaveCount(1);
    await page.locator('[data-id="back-to-game"]').tap();
    await expect(allShapes(page)).toHaveCount(0);

    // Drawing is no help: the game is still rated.
    expect((await store(page)).assisted).toBe(false);
    await expect(page.locator('.app-player--bottom')).not.toContainText('Unrated');
    await expectNoScroll(page);
    expect(errors).toEqual([]);
  });

  test('the explorer shares the drawings; Escape leaves Draw mode, then the explorer; a sheet ends Draw mode', async ({ page, context }) => {
    test.setTimeout(90_000);
    const cdp = await context.newCDPSession(page);
    await startGame(page);
    await toggle(page).tap();
    await touchDrag(page, cdp, 'g1', 'f3');
    await expect(arrowsIn(page, GREEN)).toHaveCount(1);

    // Opening the explorer ends Draw mode; the live position's drawing shows there too.
    await tool(page, 'explore').tap();
    await expect(page.locator('.app[data-exploring]')).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    await expect(arrowsIn(page, GREEN)).toHaveCount(1);

    // Draw in the explorer (no Reply there with the engine off: the toggle is on the strip).
    await toggle(page).tap();
    await expect(page.locator('.app[data-exploring] .board-draw')).toBeVisible();
    await swatch(page, 'Red').tap();
    await tapSquare(page, 'e2');
    await tapSquare(page, 'e4'); // two circles, no move
    await expect(circlesIn(page, RED)).toHaveCount(2);
    await expect(page.locator('.app-moves .mlist-move:not(.mlist-lead)')).toHaveCount(0);

    // Escape: first out of Draw mode (still exploring), then out of the explorer.
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveCount(0);
    await expect(page.locator('.app[data-exploring]')).toBeVisible();
    await tapSquare(page, 'd2');
    await tapSquare(page, 'd4'); // pieces move again in the explorer
    await expect(page.locator('.app-moves .mlist-move:not(.mlist-lead)')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.app[data-exploring]')).toHaveCount(0);
    // Back on the game's position: its drawings, the explorer's included.
    await expect(arrowsIn(page, GREEN)).toHaveCount(1);
    await expect(circlesIn(page, RED)).toHaveCount(2);

    // Opening a sheet ends Draw mode.
    await toggle(page).tap();
    await expect(bar(page)).toBeVisible();
    await tool(page, 'menu').tap();
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Menu' })).toBeHidden();
    await expect(bar(page)).toHaveCount(0);
    await expect(toggle(page)).toBeVisible();
    expect((await store(page)).assisted).toBe(false);
  });

  test('in Game Review: draw on the move being reviewed; other moves show their own', async ({ page, context }) => {
    test.setTimeout(120_000);
    const cdp = await context.newCDPSession(page);
    await startGame(page);
    await tapSquare(page, 'e2');
    await tapSquare(page, 'e4');
    await expect(page.locator('.app-moves .mlist-move')).toHaveCount(2, { timeout: 30_000 });
    await waitForMyTurn(page);
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.resign());
    await page.getByRole('dialog', { name: 'You lost You resigned' }).getByRole('button', { name: 'Game Review' }).tap();
    await expect(tool(page, 'summary')).toBeVisible();
    await tool(page, 'prev').tap(); // after 1. e4
    await toggle(page).tap();
    await swatch(page, 'Blue').tap();
    await touchDrag(page, cdp, 'e7', 'e5');
    await tapSquare(page, 'e4');
    await expect(arrowsIn(page, BLUE)).toHaveCount(1);
    await expect(circlesIn(page, BLUE)).toHaveCount(1);
    await tool(page, 'next').tap(); // Draw mode stays while browsing the review
    await expect(bar(page)).toBeVisible();
    await expect(arrowsIn(page, BLUE)).toHaveCount(0);
    await tool(page, 'prev').tap();
    await expect(arrowsIn(page, BLUE)).toHaveCount(1);
    const drawn = (await store(page)).shapes;

    // A gesture whose board changes before the finger lifts (a step here, the bot's move in a game)
    // draws nothing, on either position.
    const g1 = await squareCenter(page, 'g1');
    const f3 = await squareCenter(page, 'f3');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: g1.x, y: g1.y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: f3.x, y: f3.y, id: 1 }] });
    await page.waitForTimeout(120); // the finger rests (no fling: see touchDrag), then the board changes under it
    await page.evaluate(() => (window as unknown as Win).__chessCoach!.controller.stepForward());
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(200);
    expect((await store(page)).shapes).toEqual([]);
    await tool(page, 'prev').tap();
    expect((await store(page)).shapes).toEqual(drawn);

    // The explorer here (its engine on after the game) shows the engine's arrows with the player's:
    // the engine's solid, the player's dashed, so a drawn idea never passes for the engine's.
    await tool(page, 'explore').tap();
    await expect(page.locator('.app[data-exploring]')).toBeVisible();
    const engineArrows = page.locator('.board .cg-shapes line:not([marker-end*="arrowhead-draw-"])');
    await expect(engineArrows.first()).toBeAttached({ timeout: 30_000 });
    await expect(engineArrows.first()).toHaveCSS('stroke-dasharray', 'none');
    await expect(arrowsIn(page, BLUE)).toHaveCount(1);
    await expect(arrowsIn(page, BLUE)).not.toHaveCSS('stroke-dasharray', 'none');
    await tool(page, 'explorerExit').tap();
    await expect(page.locator('.app[data-exploring]')).toHaveCount(0);
    await toggle(page).tap();
    await expect(bar(page)).toBeVisible();
    await tool(page, 'review').tap(); // Close the review: Draw mode ends, the game is shown
    await expect(bar(page)).toHaveCount(0);
  });

  test('a short phone and landscape: the bar fits the strip, never covers the board, and nothing scrolls', async ({ page, context }) => {
    test.setTimeout(90_000);
    const cdp = await context.newCDPSession(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await startGame(page);
    for (const [width, height] of [
      [375, 667],
      [852, 393],
      [393, 852],
    ]) {
      await page.setViewportSize({ width, height });
      await expect(toggle(page)).toBeVisible();
      await toggle(page).tap();
      await expect(bar(page)).toBeVisible();
      for (const c of ['Orange', 'Blue', 'Red', 'Green']) await swatch(page, c).tap();
      await touchDrag(page, cdp, 'b1', 'c3');
      const [b, d, strip] = await Promise.all([
        board(page).boundingBox(),
        bar(page).boundingBox(),
        page.locator('.app-player--bottom').boundingBox(),
      ]);
      const label = `${width}x${height}`;
      // Inside its strip and the screen, clear of the board.
      expect(d!.x, label).toBeGreaterThanOrEqual(strip!.x - 1);
      expect(d!.x + d!.width, label).toBeLessThanOrEqual(Math.min(strip!.x + strip!.width, width) + 1);
      const overlaps = d!.x < b!.x + b!.width && b!.x < d!.x + d!.width && d!.y < b!.y + b!.height && b!.y < d!.y + d!.height;
      expect(overlaps, label).toBe(false);
      for (const id of ['draw-clear', 'draw-done']) {
        const btn = await bar(page).locator(`[data-id="${id}"]`).boundingBox();
        expect(btn!.x + btn!.width, `${label} ${id}`).toBeLessThanOrEqual(d!.x + d!.width + 1);
      }
      await expectNoScroll(page);
      await bar(page).locator('[data-id="draw-done"]').tap();
    }
    // One arrow b1 → c3 drawn three times in a row: on, off, on.
    await expect(arrowsIn(page, GREEN)).toHaveCount(1);
  });

  test('the Openings section: draw on the Learn board, by position, until the section closes', async ({ page, context }) => {
    test.setTimeout(90_000);
    const cdp = await context.newCDPSession(page);
    await page.goto('./');
    const sheet = page.getByRole('dialog', { name: 'New game' });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await sheet.getByRole('button', { name: 'Close' }).tap();
    await tool(page, 'menu').tap();
    await page.getByRole('dialog', { name: 'Menu' }).locator('[data-id="openings"]').tap();
    const shell = page.locator('.openings-shell');
    const title = shell.locator('[data-id="openings-title"]');
    await expect(title).toHaveText('Openings', { timeout: 15_000 });
    await shell.locator('.op-card[data-family="Italian Game"]').tap();
    await shell.locator('[data-id="learn-main"]').tap();
    await expect(title).toHaveText('Main line');
    for (let i = 0; i < 5; i++) await shell.locator('[data-id="next"]').tap();
    await expect(shell.locator('[data-id="move-title"]')).toContainText('3. Bc4');

    // The toggle sits by the position's name; the bar takes its row.
    const scope = '.openings-shell';
    await shell.locator('[data-id="draw"]').tap();
    const opBar = shell.getByRole('toolbar', { name: 'Draw' });
    await expect(opBar).toBeVisible();
    await touchDrag(page, cdp, 'f3', 'g5', scope);
    await tapSquare(page, 'f7', scope);
    await expect(shell.locator(`.board .cg-shapes line[stroke="${GREEN}"]`)).toHaveCount(1);
    await expect(shell.locator(`.board .cg-shapes circle[stroke="${GREEN}"]`)).toHaveCount(1);
    await expect(shell.locator('[data-id="move-title"]')).toContainText('3. Bc4'); // nothing moved

    // Escape leaves Draw mode first (the page stays); stepping on and back shows them again.
    await page.keyboard.press('Escape');
    await expect(opBar).toHaveCount(0);
    await expect(title).toHaveText('Main line');
    await shell.locator('[data-id="next"]').tap();
    await expect(shell.locator('.board .cg-shapes g[cgHash] :is(line, circle)')).toHaveCount(0);
    await shell.locator('[data-id="prev"]').tap();
    await expect(shell.locator(`.board .cg-shapes line[stroke="${GREEN}"]`)).toHaveCount(1);

    // In Draw mode the header's Done (beside the bar's own) leaves Draw mode first, as Escape does:
    // the section and its drawings stay.
    await shell.locator('[data-id="draw"]').tap();
    await expect(opBar).toBeVisible();
    await shell.locator('[data-id="openings-done"]').tap();
    await expect(opBar).toHaveCount(0);
    await expect(title).toHaveText('Main line');
    await expect(shell.locator(`.board .cg-shapes line[stroke="${GREEN}"]`)).toHaveCount(1);

    // Closing the section forgets them.
    await shell.locator('[data-id="openings-done"]').tap();
    await expect(shell).toBeHidden();
    await page.getByRole('dialog', { name: 'Menu' }).locator('[data-id="openings"]').tap();
    await expect(title).toHaveText('Main line');
    await expect(shell.locator('.board .cg-shapes g[cgHash] :is(line, circle)')).toHaveCount(0);
  });
});
