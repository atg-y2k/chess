/**
 * Feedback first, end to end (production build, real engine, iPhone 15 Pro emulation): against the
 * fastest bot, with the analysis made slow on purpose through the debug hook (every analysis result
 * handed over 0.8 s late, as on a slow phone: a verdict then takes at least 1.6 s, Pip under 1 s),
 * the coach's verdict on each of your moves is painted on the screen on its own, for a moment
 * (FEEDBACK_LEAD_MS), before the bot's reply appears in the move list, and the bot shows as
 * thinking meanwhile. The screen is sampled on every animation frame (what is painted), not only on
 * DOM changes (a verdict and a reply written in the same task would never be painted apart).
 */
import { expect, test, type Page } from '@playwright/test';

interface Store {
  plies: { value: { classification?: object }[] };
  phase: { value: string };
  humanToMove: { value: boolean };
  isLive: { value: boolean };
  position: { value: { dests: Map<string, string[]> } };
}
interface Hook {
  controller: {
    store: Store;
    analysis: { ensure: (fen: string, opts: object) => Promise<unknown> };
  };
}
interface Sample {
  moves: number;
  title: string;
  thinking: boolean;
  /** performance.now() of the animation frame that showed it. */
  at: number;
}
type Win = { __chessCoach?: Hook; __feedbackLog?: Sample[] };

const QUIET = ['g1f3', 'b1c3', 'd2d3', 'e2e3', 'c2c3', 'a2a3', 'h2h3', 'b2b3'];

/** Taps the centre of `square` on the board (White at the bottom). */
async function tapSquare(page: Page, square: string): Promise<void> {
  const box = await page.locator('.board cg-board').first().boundingBox();
  if (!box) throw new Error('board not visible');
  const size = box.width / 8;
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  await page.touchscreen.tap(box.x + (file + 0.5) * size, box.y + (7 - rank + 0.5) * size);
}

test('the bot’s reply never lands before the coach’s verdict on your move', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./');
  const sheet = page.getByRole('dialog', { name: 'New game' });
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await sheet.locator('[data-bot="pip"]').tap();
  await sheet.locator('.ngs-color[data-color="w"]').tap();
  await sheet.getByRole('button', { name: 'Play' }).tap();
  await expect(sheet).toBeHidden();

  // A slow analysis engine (the debug hook): every result arrives 0.8 s after its search, so the
  // coach takes longer than Pip (100), who replies in well under a second.
  await page.evaluate(() => {
    const svc = (window as unknown as Win).__chessCoach!.controller.analysis;
    const ensure = svc.ensure.bind(svc);
    svc.ensure = (fen, opts) => ensure(fen, opts).then((r) => new Promise((res) => setTimeout(() => res(r), 800)));
    // What the screen shows, sampled on every animation frame (what gets painted): the moves listed,
    // the coach's title, the bot thinking.
    const log: Sample[] = [];
    (window as unknown as Win).__feedbackLog = log;
    const sample = (at: number) => {
      const s: Sample = {
        moves: document.querySelectorAll('.mlist-move').length,
        title: document.querySelector('.app-panel .coach .coach-title')?.textContent ?? '',
        thinking: !!document.querySelector('.app-player--top .pstrip[data-thinking]'),
        at,
      };
      const last = log.at(-1);
      if (!last || last.moves !== s.moves || last.title !== s.title || last.thinking !== s.thinking) log.push(s);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  for (let n = 0; n < 3; n++) {
    // Your turn, once the bot's move has been rated too (as a player who reads the feedback moves).
    await page.waitForFunction(() => {
      const s = (window as unknown as Win).__chessCoach?.controller.store;
      const last = s?.plies.value.at(-1);
      return !!s && s.phase.value === 'playing' && s.humanToMove.value && s.isLive.value && (!last || !!last.classification);
    }, null, { timeout: 30_000 });
    const legal = await page.evaluate(() => {
      const out: string[] = [];
      for (const [from, tos] of (window as unknown as Win).__chessCoach!.controller.store.position.value.dests) for (const to of tos) out.push(from + to);
      return out;
    });
    const uci = (n === 0 ? 'e2e4' : QUIET.find((m) => legal.includes(m))) ?? legal[0];
    const before = await page.locator('.mlist-move').count();
    await tapSquare(page, uci.slice(0, 2));
    await tapSquare(page, uci.slice(2, 4));
    await expect(page.locator('.mlist-move')).toHaveCount(before + 1);
    // While the coach checks your move, the bot's reply waits: the bot shows as thinking.
    await expect(page.locator('.app-panel .coach .coach-title')).toHaveText(/^Checking /);
    await expect(page.locator('.app-player--top .pstrip')).toHaveAttribute('data-thinking', '');
    await expect(page.locator('.mlist-move')).toHaveCount(before + 2, { timeout: 30_000 });
  }

  const log = await page.evaluate(() => (window as unknown as Win).__feedbackLog!);
  // After each of your moves (an odd number of moves listed), the coach's verdict ("1. e4 is a book
  // move", not "Checking e4…") is painted before the reply makes the count even, and stays up on its
  // own for a moment first (the bot was ready long before: the hold waited).
  for (const yours of [1, 3, 5]) {
    const first = log.findIndex((x) => x.moves === yours + 1);
    expect(first, `the reply to move ${yours}`).toBeGreaterThan(0);
    const verdict = log.findIndex((x) => x.moves === yours && x.title !== '' && !x.title.startsWith('Checking'));
    const frames = JSON.stringify(log.filter((x) => x.moves === yours || x.moves === yours + 1));
    expect(verdict, `the verdict on move ${yours}: ${frames}`).toBeGreaterThan(-1);
    expect(verdict).toBeLessThan(first);
    expect(log[first].at - log[verdict].at, `the verdict's time on its own, move ${yours}: ${frames}`).toBeGreaterThanOrEqual(400);
  }
  expect(errors).toEqual([]);
});
