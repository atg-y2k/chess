/**
 * Chess Coach Pro end to end, on a build made with VITE_PAYWALL=1 (playwright.config.ts serves it
 * on its own port): Pro features are locked, and the mock App Store (src/native/purchases.ts) is
 * steered through `window.__mockStore`. Covers the locked coach (teaser, locked Show best and Hint),
 * the paywall with the store's price, a purchase that unlocks everything, cancelled / failed /
 * pending (Ask to Buy) purchases, Restore Purchases (also offline and cancelled), a refund, the
 * locked Game Review, the locked explorer, the opponent's move ratings (verdicts free, explanations
 * locked), the always-reachable privacy policy, Escape over stacked sheets, and the Openings section
 * (browsing, the moves of any line, the move tree and playing free; guide text and drills locked).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

interface MockStoreSettings {
  result?: 'purchased' | 'cancelled' | 'pending' | 'failed';
  price?: string;
  available?: boolean;
  owned?: boolean;
  delayMs?: number;
  restoreError?: 'cancelled' | 'failed' | null;
}
interface Hook {
  controller: {
    newGame(settings: object, opts?: { startFen?: string }): void;
    entitlements: { pro: { value: boolean } };
    store: {
      settings: { value: object };
      phase: { value: string };
      humanToMove: { value: boolean };
      isLive: { value: boolean };
    };
  };
}
/** The page's debug hook (src/main.tsx) and the mock store's controls (src/native/purchases.ts). */
type Win = {
  __chessCoach: Hook;
  __mockStore: MockStoreSettings & { setUnlocked(unlocked: boolean): void };
};

/** 1.e4 e5 2.Qh5 Nc6: White to move, and 3.Qxf7+?? gives the queen away (Kxf7). */
const QXF7_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3';
const TEASER = /^The coach can show you /;

const paywall = (page: Page): Locator => page.getByRole('dialog', { name: 'Unlock Chess Coach Pro' });
const coach = (page: Page): Locator => page.locator('.app-panel .coach');
const board = (page: Page): Locator => page.locator('.board cg-board').first();

/** Opens the app with the mock store set up as given (merged into its defaults). */
async function open(page: Page, store: MockStoreSettings = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((s) => {
    (window as unknown as Win).__mockStore = { delayMs: 200, ...s } as Win['__mockStore'];
  }, store);
  await page.goto('./');
  await expect(page.getByRole('dialog', { name: 'New game' })).toBeVisible({ timeout: 30_000 });
  return errors;
}

/** Starts a rated game as White against Biscuit from `fen` (the New game sheet closes). */
async function startFrom(page: Page, fen: string): Promise<void> {
  await page.evaluate((startFen) => {
    const c = (window as unknown as Win).__chessCoach.controller;
    c.newGame({ ...c.store.settings.value, playerColor: 'w', botId: 'biscuit', botElo: 250, adaptive: false, coach: true, sound: false }, { startFen });
  }, fen);
  await expect(page.getByRole('dialog', { name: 'New game' })).toBeHidden();
}

async function waitForMyTurn(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as unknown as Win).__chessCoach?.controller.store;
    return !!s && s.phase.value === 'playing' && s.humanToMove.value && s.isLive.value;
  });
}

async function tapSquare(page: Page, square: string): Promise<void> {
  const box = await board(page).boundingBox();
  if (!box) throw new Error('board not visible');
  const size = box.width / 8;
  const col = square.charCodeAt(0) - 97;
  const row = 8 - Number(square[1]);
  await page.touchscreen.tap(box.x + (col + 0.5) * size, box.y + (row + 0.5) * size);
}

/** Plays 3.Qxf7+ and waits for the coach's verdict on it. */
async function blunderQueen(page: Page): Promise<void> {
  await waitForMyTurn(page);
  await tapSquare(page, 'h5');
  await tapSquare(page, 'f7');
  await expect(coach(page).locator('.coach-title')).toContainText('3. Qxf7+ is a', { timeout: 30_000 });
  await expect(coach(page).locator('.coach-head .class-icon')).toBeVisible();
}

const setStore = (page: Page, s: MockStoreSettings) =>
  page.evaluate((v) => {
    (window as unknown as Win).__mockStore = v as Win['__mockStore'];
  }, s);

async function openMenu(page: Page): Promise<Locator> {
  await page.locator('.toolbar-btn[data-id="menu"]').tap();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('Chess Coach Pro (paywall build)', () => {
  test('locked coach and Hint, the paywall with the store’s price, and a purchase that unlocks them', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await open(page, { price: '$4.99', delayMs: 500 });
    await startFrom(page, QXF7_FEN);
    await blunderQueen(page);

    // The verdict and its icon are free; the why, Show best and Hint are locked.
    const lines = coach(page).locator('.coach-line');
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toHaveText(TEASER);
    await expect(coach(page).getByRole('button', { name: 'Unlock to see why' })).toBeVisible();
    await expect(coach(page).locator('[data-action="showBest"][data-locked]')).toBeVisible();
    await expect(coach(page).locator('[data-action="retry"]')).toBeVisible(); // takebacks stay free
    await expect(page.locator('.toolbar-btn[data-id="hint"] .locked-icon-badge')).toBeVisible();
    await expect(page.locator('.cg-shapes line')).toHaveCount(0);

    // Show best opens the paywall: its line first, the price from the store on the button.
    await coach(page).locator('[data-action="showBest"]').tap();
    await expect(paywall(page)).toBeVisible();
    await expect(paywall(page).locator('[data-id="paywall-lead"]')).toHaveText('Show best is part of Pro.');
    await expect(paywall(page).locator('[data-id="paywall-buy"]')).toHaveText('Unlock for $4.99');
    await expect(paywall(page).locator('[data-id="paywall-terms-line"]')).toHaveText('One-time purchase · No subscription · Family Sharing');
    await expect(paywall(page).locator('[data-id="paywall-restore"]')).toHaveText('Restore Purchases');
    await expect(paywall(page).locator('[data-id="paywall-privacy"]')).toHaveAttribute('href', 'https://atg-y2k.github.io/chess/privacy.html');
    await expect(paywall(page).locator('[data-id="paywall-terms"]')).toHaveAttribute('href', 'https://atg-y2k.github.io/chess/terms.html');
    await paywall(page).getByRole('button', { name: 'Close' }).tap();
    await expect(paywall(page)).toBeHidden();
    await expect(page.locator('.cg-shapes line')).toHaveCount(0); // nothing was shown

    // Hint opens it too (instead of the "unrated" question).
    await waitForMyTurn(page);
    await page.locator('.toolbar-btn[data-id="hint"]').tap();
    await expect(paywall(page).locator('[data-id="paywall-lead"]')).toHaveText('Hints are part of Pro.');
    await expect(page.getByRole('dialog', { name: 'Use a hint?' })).toHaveCount(0);
    await paywall(page).getByRole('button', { name: 'Close' }).tap();
    await expect(paywall(page)).toBeHidden();

    // "Unlock to see why" -> buy: the mock store says purchased; the sheet thanks and closes.
    await coach(page).getByRole('button', { name: 'Unlock to see why' }).tap();
    await expect(paywall(page).locator('[data-id="paywall-lead"]')).toHaveText('Find out why each move is good or bad.');
    await expect(paywall(page).locator('.paywall-item[data-current]')).toHaveAttribute('data-feature', 'coachExplanations');
    await paywall(page).locator('[data-id="paywall-buy"]').tap();
    await expect(paywall(page).locator('[data-id="paywall-buy"]')).toHaveText('Purchasing…');
    await expect(paywall(page).locator('[data-id="paywall-done"]')).toBeVisible();
    await expect(paywall(page).locator('.paywall-title')).toHaveText('Chess Coach Pro is unlocked');
    await expect(paywall(page)).toBeHidden({ timeout: 5_000 });

    // Unlocked: the coach explains, Show best and Hint work.
    await expect(lines.first()).not.toHaveText(TEASER);
    await expect(coach(page).locator('[data-locked]')).toHaveCount(0);
    await expect(page.locator('.toolbar-btn[data-id="hint"] .locked-icon-badge')).toHaveCount(0);
    await coach(page).locator('[data-action="showBest"]').tap();
    await expect(coach(page).locator('.coach-title')).toContainText(/^Best was /);
    await expect(page.locator('.cg-shapes line').first()).toBeAttached();
    await coach(page).getByRole('button', { name: 'Back to game' }).tap();

    // It stays unlocked after a relaunch.
    await page.reload();
    await waitForMyTurn(page);
    expect(await page.evaluate(() => (window as unknown as Win).__chessCoach.controller.entitlements.pro.value)).toBe(true);
    await expect(page.locator('.toolbar-btn[data-id="hint"] .locked-icon-badge')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('cancelled, failed and pending (Ask to Buy) purchases; the approval unlocks Pro', async ({ page }) => {
    const errors = await open(page, { delayMs: 500 });
    await page.getByRole('dialog', { name: 'New game' }).getByRole('button', { name: 'Close' }).tap();
    const menu = await openMenu(page);
    const status = menu.locator('[data-id="pro-status"]');
    await expect(status).toContainText('Chess Coach Pro');
    await expect(status).toContainText('Explanations, hints and full reviews');
    // Best-move arrows show a lock and open the paywall instead of switching on.
    const arrows = menu.locator('.toggle[data-id="showBestMoves"]');
    await expect(arrows).toHaveAttribute('aria-checked', 'false');
    await arrows.tap();
    await expect(paywall(page).locator('[data-id="paywall-lead"]')).toHaveText('Best-move arrows are part of Pro.');
    await expect(arrows).toHaveAttribute('aria-checked', 'false');
    await paywall(page).getByRole('button', { name: 'Close' }).tap();
    await expect(paywall(page)).toBeHidden();

    await menu.locator('[data-id="pro-unlock"]').tap();
    await expect(paywall(page)).toBeVisible();
    await expect(paywall(page).locator('[data-id="paywall-lead"]')).toHaveText('Learn from every move you make.');
    const buy = paywall(page).locator('[data-id="paywall-buy"]');
    await expect(buy).toHaveText('Unlock for $9.99');

    // Cancelled: nothing happens.
    await setStore(page, { result: 'cancelled' });
    await buy.tap();
    await expect(buy).toHaveText('Purchasing…');
    await expect(buy).toHaveText('Unlock for $9.99');
    await expect(paywall(page).locator('.paywall-msg')).toHaveCount(0);

    // Failed: an error with Try again.
    await setStore(page, { result: 'failed' });
    await buy.tap();
    const msg = paywall(page).locator('.paywall-msg');
    await expect(msg).toHaveAttribute('data-tone', 'error');
    await expect(msg).toContainText('The purchase didn’t go through.');

    // Pending: Try again -> waiting for approval.
    await setStore(page, { result: 'pending' });
    await msg.getByRole('button', { name: 'Try again' }).tap();
    await expect(msg).toHaveAttribute('data-status', 'pending');
    await expect(msg).toContainText('Waiting for approval (Ask to Buy)');
    expect(await page.evaluate(() => (window as unknown as Win).__chessCoach.controller.entitlements.pro.value)).toBe(false);
    await paywall(page).getByRole('button', { name: 'Close' }).tap();
    await expect(paywall(page)).toBeHidden();
    await expect(status).toContainText('Waiting for approval');

    // A parent approves: Pro unlocks, with a toast (the paywall is closed).
    await page.evaluate(() => (window as unknown as Win).__mockStore.setUnlocked(true));
    await expect(page.locator('.app-toast')).toHaveText('Chess Coach Pro is unlocked');
    await expect(status).toContainText('Unlocked ✓');
    await expect(menu.locator('[data-id="pro-unlock"]')).toHaveCount(0);
    await arrows.tap();
    await expect(arrows).toHaveAttribute('aria-checked', 'true');
    await expect(paywall(page)).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('Restore Purchases: cancelled, offline, nothing to restore, then a purchase made elsewhere; a refund locks again', async ({ page }) => {
    const errors = await open(page);
    await page.getByRole('dialog', { name: 'New game' }).getByRole('button', { name: 'Close' }).tap();
    const menu = await openMenu(page);
    const status = menu.locator('[data-id="pro-status"]');
    const menuRestore = menu.locator('[data-id="pro-restore"]');

    // From the Menu: the player closes the App Store sign-in, so nothing is said.
    await setStore(page, { restoreError: 'cancelled' });
    await menuRestore.tap();
    await expect(menuRestore).toHaveText('Restoring…');
    await expect(menuRestore).toHaveText('Restore Purchases');
    await expect(page.locator('.app-toast')).toHaveCount(0);
    // Offline: not "nothing was found".
    await setStore(page, { restoreError: 'failed' });
    await menuRestore.tap();
    await expect(page.locator('.app-toast')).toHaveText('Couldn’t reach the App Store');
    // Nothing bought.
    await setStore(page, { restoreError: null });
    await menuRestore.tap();
    await expect(page.locator('.app-toast')).toHaveText('No earlier purchase of Pro was found');
    await expect(status).toContainText('Explanations, hints and full reviews');

    // From the paywall: offline gives an error with Try again; then nothing to restore.
    await menu.locator('[data-id="pro-unlock"]').tap();
    const restore = paywall(page).locator('[data-id="paywall-restore"]');
    const msg = paywall(page).locator('.paywall-msg');
    await setStore(page, { restoreError: 'failed' });
    await restore.tap();
    await expect(msg).toHaveAttribute('data-status', 'restoreFailed');
    await expect(msg).toContainText('Couldn’t reach the App Store');
    await setStore(page, { restoreError: null });
    await msg.getByRole('button', { name: 'Try again' }).tap();
    await expect(msg).toContainText('No earlier purchase of Pro was found');

    // The Apple Account owns Pro (bought on another device): Restore unlocks it.
    await setStore(page, { owned: true, delayMs: 500 });
    await restore.tap();
    await expect(restore).toHaveText('Restoring…');
    await expect(paywall(page).locator('.paywall-title')).toHaveText('Chess Coach Pro is unlocked');
    await expect(paywall(page)).toBeHidden({ timeout: 5_000 });
    await expect(status).toContainText('Unlocked ✓');

    // Restoring again while unlocked says so.
    await menuRestore.tap();
    await expect(page.locator('.app-toast')).toHaveText('Purchases restored');

    // Refunded: locked again.
    await page.evaluate(() => (window as unknown as Win).__mockStore.setUnlocked(false));
    await expect(status).toContainText('Explanations, hints and full reviews');
    await expect(menu.locator('[data-id="pro-unlock"]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('About links the privacy policy, terms and support page, with Pro locked or unlocked', async ({ page }) => {
    const errors = await open(page);
    await page.getByRole('dialog', { name: 'New game' }).getByRole('button', { name: 'Close' }).tap();
    const links = {
      'about-privacy': 'https://atg-y2k.github.io/chess/privacy.html',
      'about-terms': 'https://atg-y2k.github.io/chess/terms.html',
      'about-support': 'https://atg-y2k.github.io/chess/support.html',
    };
    let menu = await openMenu(page);
    for (const [id, href] of Object.entries(links)) {
      await expect(menu.locator(`[data-id="${id}"]`)).toHaveAttribute('href', href);
    }
    await menu.getByRole('button', { name: 'Close' }).first().tap();
    await expect(menu).toBeHidden();

    // Unlocked (bought, restored or shared by the family): no paywall to open any more, and the
    // privacy policy is still one tap away.
    await page.evaluate(() => (window as unknown as Win).__mockStore.setUnlocked(true));
    menu = await openMenu(page);
    await expect(menu.locator('[data-id="pro-status"]')).toContainText('Unlocked ✓');
    await expect(menu.locator('[data-id="pro-unlock"]')).toHaveCount(0);
    for (const [id, href] of Object.entries(links)) {
      await expect(menu.locator(`[data-id="${id}"]`)).toHaveAttribute('href', href);
    }
    expect(errors).toEqual([]);
  });

  test('Escape closes the paywall, not the sheet under it', async ({ page }) => {
    const errors = await open(page);
    const newGame = page.getByRole('dialog', { name: 'New game' });
    const arrows = (sheet: Locator) => sheet.locator('.toggle[data-id="showBestMoves"]');

    // Over the New game sheet.
    await arrows(newGame).tap();
    await expect(paywall(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(paywall(page)).toBeHidden();
    await expect(newGame).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(newGame).toBeHidden();

    // Over the Menu.
    const menu = await openMenu(page);
    await arrows(menu).tap();
    await expect(paywall(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(paywall(page)).toBeHidden();
    await expect(menu).toBeVisible();
    await menu.locator('[data-id="pro-unlock"]').tap();
    await expect(paywall(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(paywall(page)).toBeHidden();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('Game Review: accuracy and counts are free, key moments and comments are locked', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = await open(page);
    await startFrom(page, QXF7_FEN);
    await blunderQueen(page);
    await waitForMyTurn(page);

    const menu = await openMenu(page);
    await menu.locator('.menu-tile[data-id="resign"]').tap();
    await menu.locator('[data-id="resign-confirm"]').tap();
    const over = page.getByRole('dialog', { name: 'You lost You resigned' });
    await expect(over).toBeVisible();
    await over.getByRole('button', { name: 'Game Review' }).tap();

    const review = page.getByRole('region', { name: 'Game Review' });
    await expect(review.locator('.review-acc').first()).toHaveText(/^\d+\.\d$/, { timeout: 90_000 });
    await expect(review.locator('.review-progress')).toHaveCount(0);
    await expect(review.locator('.review-row, .review-table tbody tr').first()).toBeVisible();
    const locked = review.locator('[data-id="review-locked"]');
    await expect(locked).toBeVisible();
    await expect(locked).toContainText(/\d+ key moments? found/);
    await expect(review.locator('.review-moment')).toHaveCount(0);

    // A move in review: the verdict, the teaser, no best-move arrow.
    await page.locator('.toolbar-btn[data-id="prev"]').tap();
    await expect(coach(page).locator('.coach-title')).toContainText(/\d+(\.|…) /);
    await expect(coach(page).locator('.coach-line').first()).toHaveText(TEASER);
    await expect(page.locator('.cg-shapes line')).toHaveCount(0);

    // The unlock card opens the paywall; buying shows the key moments.
    await page.locator('.toolbar-btn[data-id="summary"]').tap();
    await locked.getByRole('button', { name: 'Unlock' }).tap();
    await expect(paywall(page).locator('[data-id="paywall-lead"]')).toHaveText('See the moments that decided the game.');
    await paywall(page).locator('[data-id="paywall-buy"]').tap();
    await expect(paywall(page)).toBeHidden({ timeout: 5_000 });
    await expect(review.locator('.review-moment').first()).toBeVisible();
    await expect(locked).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('rating the opponent’s moves: its verdict and badge are free, its explanation and Show best are Pro', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await open(page);
    await page.evaluate((startFen) => {
      const c = (window as unknown as Win).__chessCoach.controller;
      const s = { ...c.store.settings.value, playerColor: 'w', botId: 'biscuit', botElo: 250, adaptive: false, coach: true, sound: false };
      c.newGame({ ...s, rateOpponent: true }, { startFen });
    }, QXF7_FEN);
    await expect(page.locator('.app-player--bottom')).toContainText('Unrated');
    await waitForMyTurn(page);
    await tapSquare(page, 'h5');
    await tapSquare(page, 'f7');
    // Your blunder stays expanded after the bot's reply (3… Kxf7), which is the row below it, with its icon.
    await expect(coach(page).locator('.coach-title')).toHaveText(/^3\. Qxf7\+ is a blunder/, { timeout: 30_000 });
    const other = coach(page).locator('.coach-other');
    await expect(other).toHaveAttribute('data-place', 'after');
    await expect(other).toContainText('Biscuit');
    await expect(other.locator('.class-icon')).toBeVisible({ timeout: 30_000 });
    // Its row expands the bot's move: the verdict in the third person, with its icon; yours is the row above.
    await other.tap();
    await expect(coach(page).locator('.coach-title')).toHaveText(/^Biscuit’s 3… \S+ is /);
    await expect(coach(page).locator('.coach-head .class-icon')).toBeVisible();
    await expect(coach(page).locator('.coach-other')).toContainText('3. Qxf7+');
    await expect(coach(page).locator('.coach-other .class-icon')).toBeVisible();
    await expect(page.locator('.cg-custom-svgs [cgHash]').first()).toBeAttached();
    const lines = coach(page).locator('.coach-line');
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toHaveText(TEASER);
    const best = coach(page).locator('[data-action="showBest"]');
    if (await best.count()) await expect(best).toHaveAttribute('data-locked', '');
    await coach(page).getByRole('button', { name: 'Unlock to see why' }).tap();
    await expect(paywall(page)).toBeVisible();
    await expect(paywall(page).locator('[data-id="paywall-lead"]')).toHaveText('Find out why each move is good or bad.');
    expect(errors).toEqual([]);
  });

  test('the explorer is part of Pro: Explore shows a lock and opens the paywall, without asking about the rating', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await open(page);
    await startFrom(page, QXF7_FEN);
    await waitForMyTurn(page);
    const explore = page.locator('.toolbar-btn[data-id="explore"]');
    await expect(explore.locator('.locked-icon-badge')).toBeVisible();
    await explore.tap();
    await expect(paywall(page)).toBeVisible();
    await expect(paywall(page).locator('.paywall-item[data-current]')).toHaveAttribute('data-feature', 'explorer');
    await expect(page.getByRole('dialog', { name: 'Explore this position?' })).toHaveCount(0);
    await paywall(page).getByRole('button', { name: 'Close' }).tap();
    await expect(paywall(page)).toBeHidden();
    await expect(page.locator('.app[data-exploring]')).toHaveCount(0);
    await expect(page.locator('.app-player--bottom')).not.toContainText('Unrated');
    expect(errors).toEqual([]);
  });
  test('openings: browsing, the moves of any line, the move tree and playing are free; guide text and drills are Pro', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await open(page);
    const title = page.locator('[data-id="openings-title"]');
    await page.getByRole('dialog', { name: 'New game' }).locator('[data-id="learn-openings"]').tap();
    await expect(title).toHaveText('Openings', { timeout: 15_000 });
    await page.locator('[data-id="intro-dismiss"]').tap();

    // Start here: names and moves only (no difficulty, pitch or progress).
    const card = page.locator('.op-card[data-family="Italian Game"]');
    await expect(card).toContainText(/1\.\s+e4 e5/);
    await expect(card.locator('.op-pill')).toHaveCount(0);
    await expect(card.locator('.op-card-pitch')).toHaveCount(0);
    await expect(card.locator('.op-ring')).toHaveCount(0);
    await expect(page.locator('[data-id="practice"]')).toHaveCount(0);
    await card.tap();
    await expect(title).toHaveText('Italian Game');

    // The guide: a teaser and Unlock, never its text.
    const teaser = page.locator('[data-id="guide-teaser"]');
    await expect(teaser).toContainText('What’s the idea behind the Italian Game?');
    await expect(page.locator('[data-id="guide"]')).toHaveCount(0);
    await expect(page.locator('.op-family')).not.toContainText('Fried Liver');
    await expect(page.locator('[data-id="drill-main"] .op-action-lock')).toBeVisible();
    await teaser.locator('[data-id="unlock"]').tap();
    await expect(paywall(page)).toBeVisible();
    await expect(paywall(page).locator('[data-id="paywall-lead"]')).toHaveText(
      'Learn why every move is played, and drill lines until you know them.',
    );
    await expect(paywall(page).locator('.paywall-item[data-current]')).toHaveAttribute('data-feature', 'openingGuides');
    await expect(paywall(page).locator('.paywall-item[data-feature="openingDrills"]')).toContainText('Opening drills');
    // Escape closes the paywall first (it is on top), then goes back a page.
    await page.keyboard.press('Escape');
    await expect(paywall(page)).toBeHidden();
    await expect(title).toHaveText('Italian Game');

    // Learn: the moves, the names, the evaluation and the other moves are free; the notes are not.
    await page.locator('[data-id="learn-main"]').tap();
    for (let i = 0; i < 5; i++) await page.locator('[data-id="next"]').tap();
    await expect(page.locator('[data-id="move-title"]')).toContainText('3. Bc4');
    await expect(page.locator('[data-id="position-name"]')).toContainText('Italian Game');
    await expect(page.locator('[data-id="note-teaser"]')).toContainText('Why is this move played?');
    await expect(page.locator('[data-id="move-note"]')).toHaveCount(0);
    await expect(page.locator('[data-id="other-moves"] [data-uci="g8f6"]')).toBeVisible();

    // Drills are Pro.
    await page.locator('[data-id="drill-line"]').tap();
    await expect(paywall(page).locator('.paywall-item[data-current]')).toHaveAttribute('data-feature', 'openingDrills');
    await paywall(page).getByRole('button', { name: 'Close' }).tap();
    await expect(paywall(page)).toBeHidden();
    await expect(title).toHaveText('Main line');

    // Playing it is free.
    await page.locator('[data-id="play-line"]').tap();
    const play = page.getByRole('dialog', { name: 'Play the Italian Game' });
    await expect(play.locator('[data-id="play-start"]')).toHaveText('Play');
    await play.getByRole('button', { name: 'Close' }).tap();
    await expect(play).toBeHidden();

    // The move tree is free too.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(title).toHaveText('Openings');
    await page.locator('[data-id="explore-moves"]').tap();
    await page.locator('[data-id="tree-moves"] [data-uci="d2d4"]').tap();
    await expect(page.locator('[data-id="position-name"]')).toContainText('Queen');
    await expect(page.locator('[data-id="tree-learn"]')).toBeVisible();

    // Buying Pro shows the notes at once, and the drill opens.
    await page.keyboard.press('Escape');
    await expect(title).toHaveText('Openings');
    await card.tap();
    await page.locator('[data-id="learn-main"]').tap();
    for (let i = 0; i < 5; i++) await page.locator('[data-id="next"]').tap();
    await expect(page.locator('[data-id="note-teaser"]')).toBeVisible();
    await page.locator('[data-id="note-teaser"] [data-id="unlock"]').tap();
    await paywall(page).locator('[data-id="paywall-buy"]').tap();
    await expect(paywall(page)).toBeHidden({ timeout: 5_000 });
    await expect(page.locator('[data-id="note-teaser"]')).toHaveCount(0);
    await expect(page.locator('[data-id="move-note"]')).toContainText('f7');
    await page.locator('[data-id="drill-line"]').tap();
    await expect(page.locator('[data-id="drill-setup"]')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
