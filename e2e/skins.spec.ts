/**
 * Board and piece skins end to end, on the production build (iPhone 15 Pro emulation): the default
 * green board with the Classic pieces; Menu → Board & pieces opens its sheet over the Menu, where a
 * tap changes the live preview and the game board behind it (squares, texture, coordinates, pieces)
 * at once, and the king avatars; the choice stays after a reload, where the first piece drawn is
 * already the chosen set's (no flash of the default) and the board fetches only that set's files; the
 * Openings section's boards follow; an unknown stored skin falls back to the defaults. The picker
 * itself: radio groups with VoiceOver names, the arrow keys, Home and End, 44 px targets, Escape
 * closing only it, the preview kept in sight while the pickers scroll, and its layout on a small
 * phone, in landscape and on the iPhone Duo (in one segment, open like a book or half folded).
 */
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { BOARD_THEMES, PIECE_SETS, SKIN_LICENSES } from '../src/ui/skins';

const board = (page: Page): Locator => page.locator('main .board cg-board').first();
const style = (loc: Locator, prop: string): Promise<string> =>
  loc.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);

/** Opens the app and closes the New game sheet. */
async function openApp(page: Page): Promise<void> {
  await page.goto('./');
  const sheet = page.getByRole('dialog', { name: 'New game' });
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await sheet.getByRole('button', { name: 'Close' }).tap();
  await expect(sheet).toBeHidden();
}

async function openMenu(page: Page): Promise<Locator> {
  await page.locator('.toolbar-btn[data-id="menu"]').tap();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu).toBeVisible();
  return menu;
}

/** Menu → Board & pieces: its sheet, over the Menu. */
async function openPicker(page: Page, menu: Locator): Promise<Locator> {
  const row = menu.locator('[data-id="board-pieces"]');
  await row.scrollIntoViewIfNeeded();
  await row.tap();
  const sheet = page.getByRole('dialog', { name: 'Board & pieces' });
  await expect(sheet).toBeVisible();
  // Settled: the sheet has slid up into the window.
  await expect.poll(() => sheet.evaluate((el) => Math.round(el.getBoundingClientRect().bottom - innerHeight))).toBeLessThanOrEqual(0);
  return sheet;
}

test.describe('Skins', () => {
  // No service worker: its first install can reload the page under the test (the precache of every
  // set is checked in pwa.spec.ts).
  test.use({ serviceWorkers: 'block' });

  test('board and pieces change the game board, the avatars and the Openings boards, and stay after a reload', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('./');
    const sheet = page.getByRole('dialog', { name: 'New game' });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    // The default: Classic pieces, inlined (no request), also for the colour choice's kings.
    await expect(page.locator('html')).toHaveAttribute('data-board', 'green');
    await expect(page.locator('html')).toHaveAttribute('data-pieces', 'cburnett');
    expect(await style(sheet.locator('.king-glyph-piece[data-p="wk"]').first(), 'background-image')).toContain('data:image/svg+xml');
    await sheet.getByRole('button', { name: 'Close' }).tap();

    // The green board, as it always was.
    const bg = await style(board(page), 'background-image');
    expect(bg).toContain('rgb(118, 150, 86)');
    expect(bg).toContain('rgb(238, 238, 210)');
    expect(await style(page.locator('main .board piece.pawn.white').first(), 'background-image')).toContain('data:image/svg+xml');

    // Menu → Board & pieces: the row says what is in use; its sheet opens over the Menu.
    const menu = await openMenu(page);
    await expect(menu.locator('[data-id="skins-summary"]')).toHaveText('Green board · Classic pieces');
    const picker = await openPicker(page, menu);
    const wood = picker.getByRole('radio', { name: 'Wood board' });
    const chessnut = picker.getByRole('radio', { name: 'Chessnut pieces' });
    await expect(picker.getByRole('radio', { name: 'Green board' })).toHaveAttribute('aria-checked', 'true');
    await expect(picker.getByRole('radio', { name: 'Classic pieces' })).toHaveAttribute('aria-checked', 'true');
    const preview = picker.locator('[data-id="skins-preview"] cg-board');
    expect(await style(preview, 'background-image')).toContain('rgb(118, 150, 86)');
    await expect(picker.getByRole('img', { name: 'Preview of the Green board with the Classic pieces' })).toBeVisible();

    // Wood and Chessnut: applied at once, to the preview and to the game board behind the sheets.
    await wood.tap();
    await chessnut.tap();
    await expect(wood).toHaveAttribute('aria-checked', 'true');
    await expect(chessnut).toHaveAttribute('aria-checked', 'true');
    await expect(picker.getByRole('radio', { name: 'Green board' })).toHaveAttribute('aria-checked', 'false');
    await expect(picker.locator('[data-id="pieces-credit"]')).toHaveText('Pieces by Alexis Luengas · Apache-2.0');
    await expect(picker.getByRole('img', { name: 'Preview of the Wood board with the Chessnut pieces' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-board', 'wood');
    await expect(page.locator('html')).toHaveAttribute('data-pieces', 'chessnut');
    expect(await page.evaluate(() => [localStorage.getItem('chesscoach.board'), localStorage.getItem('chesscoach.pieces')])).toEqual([
      'wood',
      'chessnut',
    ]);
    expect(await style(preview, 'background-image')).toContain('rgb(180, 125, 76)');
    expect(await style(preview, 'background-image')).toContain('feTurbulence');
    expect(await style(picker.locator('[data-id="skins-preview"] piece.knight.black'), 'background-image')).toContain('/pieces/chessnut/bN.svg');
    await expect(picker.locator('[data-id="skins-preview"] square.last-move')).toHaveCount(2);
    expect(await style(board(page), 'background-image')).toContain('rgb(180, 125, 76)');
    expect(await style(page.locator('main .board piece.pawn.white').first(), 'background-image')).toContain('/pieces/chessnut/wP.svg');
    // Every set's tile shows its own white knight on the chosen board's light square and its black
    // king on the dark one (where a set and a board can blend).
    const kiwen = picker.locator('[data-skin-pieces="kiwen-suwi"]');
    expect(await style(kiwen.locator('.skin-sq--light .piece-art[data-p="wn"]'), 'background-image')).toContain('/pieces/kiwen-suwi/wN.svg');
    expect(await style(kiwen.locator('.skin-sq--dark .piece-art[data-p="bk"]'), 'background-image')).toContain('/pieces/kiwen-suwi/bK.svg');
    expect(await style(kiwen.locator('.skin-sq--dark'), 'background-color')).toBe('rgb(180, 125, 76)');
    expect(await style(kiwen.locator('.skin-sq--light'), 'background-color')).toBe('rgb(246, 220, 176)');
    // A board tile is two squares of its theme.
    expect(await style(picker.locator('[data-skin-board="ice"] .skin-swatch'), 'background-image')).toContain('rgb(169, 202, 217)');

    // Escape closes the picker only; the Menu's row now names the choice.
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-id="skins-summary"]')).toHaveText('Wood board · Chessnut pieces');
    await menu.getByRole('button', { name: 'Close' }).tap();
    await expect(menu).toBeHidden();

    // The game board: the wood squares under their grain, its coordinates, and the Chessnut pieces.
    const woodBg = await style(board(page), 'background-image');
    expect(woodBg).toContain('rgb(180, 125, 76)');
    expect(woodBg).toContain('rgb(246, 220, 176)');
    expect(woodBg).toContain('feTurbulence');
    expect(await style(page.locator('main .board coord.coord-light').first(), 'color')).toBe('rgb(138, 90, 48)');
    expect(await style(page.locator('main .board piece.pawn.white').first(), 'background-image')).toContain('/pieces/chessnut/wP.svg');
    expect(await style(page.locator('main .board piece.king.black').first(), 'background-image')).toContain('/pieces/chessnut/bK.svg');

    // The Openings section's board too.
    const menu2 = await openMenu(page);
    await menu2.locator('[data-id="openings"]').tap();
    const italian = page.locator('.op-card[data-family="Italian Game"]');
    await expect(italian).toBeVisible({ timeout: 15_000 });
    await italian.tap();
    await page.locator('[data-id="learn-main"]').tap();
    const opBoard = page.locator('.op-view .board cg-board').first();
    await expect(opBoard).toBeVisible();
    expect(await style(opBoard, 'background-image')).toContain('rgb(180, 125, 76)');
    expect(await style(page.locator('.op-view .board piece.knight.white').first(), 'background-image')).toContain('/pieces/chessnut/wN.svg');
    await page.locator('[data-id="openings-done"]').tap();

    // After a reload: the first piece on the page is already a Chessnut one, and the board asks only
    // for Chessnut's files.
    await page.addInitScript(() => {
      const w = window as unknown as { __firstPiece?: string };
      new MutationObserver((_, obs) => {
        const piece = document.querySelector('cg-board piece');
        if (!piece) return;
        w.__firstPiece = getComputedStyle(piece).backgroundImage;
        obs.disconnect();
      }).observe(document, { childList: true, subtree: true });
    });
    const pieceRequests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/pieces/')) pieceRequests.push(new URL(r.url()).pathname);
    });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-pieces', 'chessnut');
    await expect(page.locator('main .board piece').first()).toBeAttached({ timeout: 30_000 });
    expect(await page.evaluate(() => (window as unknown as { __firstPiece?: string }).__firstPiece)).toContain('/pieces/chessnut/');
    await expect.poll(() => pieceRequests.length).toBeGreaterThan(0);
    expect(pieceRequests.every((p) => p.includes('/pieces/chessnut/'))).toBe(true);
    expect(await style(board(page), 'background-image')).toContain('rgb(180, 125, 76)');
    expect(errors).toEqual([]);
  });

  test('textured boards are drawn as their catalog entry says, and coach tints follow the board', async ({ page }) => {
    test.setTimeout(90_000);
    // The unit test's contrast floors composite each texture's mean (BOARD_THEMES' `texture`) over the
    // squares: here the drawn board must match that, so a stronger texture can't slip past them.
    for (const theme of BOARD_THEMES.filter((t) => t.id === 'wood' || t.id === 'marble' || t.id === 'brown')) {
      await page.addInitScript((id) => localStorage.setItem('chesscoach.board', id), theme.id);
      await openApp(page);
      await expect(page.locator('html')).toHaveAttribute('data-board', theme.id);
      await page.addStyleTag({ content: 'main .board cg-board piece, main .board coords, main .board cg-board square { visibility: hidden !important; }' });
      const png = await board(page).screenshot({ animations: 'disabled' });
      // The mean color of each square's inner 80%, decoded in the page.
      const squares = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        [canvas.width, canvas.height] = [img.width, img.height];
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, img.width, img.height);
        const size = img.width / 8;
        const out: { light: boolean; rgb: number[] }[] = [];
        for (let file = 0; file < 8; file++) {
          for (let rank = 0; rank < 8; rank++) {
            const sum = [0, 0, 0];
            let n = 0;
            for (let y = Math.round((rank + 0.1) * size); y < Math.round((rank + 0.9) * size); y++) {
              for (let x = Math.round((file + 0.1) * size); x < Math.round((file + 0.9) * size); x++) {
                const i = (y * img.width + x) * 4;
                for (let k = 0; k < 3; k++) sum[k] += data[i + k];
                n++;
              }
            }
            out.push({ light: (file + rank) % 2 === 0, rgb: sum.map((v) => v / n) });
          }
        }
        return out;
      }, png.toString('base64'));
      const tokens = await page.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        return ['--board-light', '--board-dark'].map((t) => s.getPropertyValue(t).trim());
      });
      const rgbOf = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const tex = 'texture' in theme ? theme.texture : { color: '#000000', alpha: 0 };
      for (const [i, light] of [true, false].entries()) {
        const drawn = squares.filter((q) => q.light === light);
        const mean = [0, 1, 2].map((k) => drawn.reduce((sum, q) => sum + q.rgb[k], 0) / drawn.length);
        const expected = rgbOf(tokens[i]).map((c, k) => c * (1 - tex.alpha) + rgbOf(tex.color)[k] * tex.alpha);
        for (let k = 0; k < 3; k++) expect(Math.abs(mean[k] - expected[k]), `${theme.id} ${light ? 'light' : 'dark'}`).toBeLessThan(3);
      }
      // Square by square, every light square stays clearly lighter than every dark one.
      const lum = (c: number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const darkest = Math.min(...squares.filter((q) => q.light).map((q) => lum(q.rgb)));
      const lightest = Math.max(...squares.filter((q) => !q.light).map((q) => lum(q.rgb)));
      expect(darkest - lightest, theme.id).toBeGreaterThan(45);
    }
    // Coach tints (Board.css → --board-cls-*): Brown's own book tint, the default elsewhere.
    const tint = (): Promise<string> =>
      page.evaluate(() => {
        const sq = document.createElement('square');
        sq.className = 'cls-book';
        document.querySelector('main .board cg-board')!.append(sq);
        const color = getComputedStyle(sq).backgroundColor;
        sq.remove();
        return color;
      });
    await page.evaluate(() => (document.documentElement.dataset.board = 'brown'));
    expect(await tint()).toBe('rgba(176, 137, 14, 0.55)');
    await page.evaluate(() => (document.documentElement.dataset.board = 'green'));
    expect(await tint()).toMatch(/0\.55\)$/);
    expect(await tint()).not.toBe('rgba(176, 137, 14, 0.55)');
  });

  test('a silhouette set\'s black pieces sit on a light chip on the dark theme\'s surfaces', async ({ page }) => {
    // Kiwen Suwi's black pieces are flat dark shapes: without the chip, the "Black" king and the
    // captured black pieces would vanish into the dark surfaces.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript(() => localStorage.setItem('chesscoach.pieces', 'kiwen-suwi'));
    await page.goto('./');
    const sheet = page.getByRole('dialog', { name: 'New game' });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const blackKing = sheet.locator('.king-glyph:not(.king-glyph--split) .king-glyph-piece[data-p="bk"]').first();
    const chip = await style(blackKing, 'background-color');
    expect(chip).not.toBe('rgba(0, 0, 0, 0)');
    // Light enough to read a dark piece on: brighter than the sheet behind it.
    const lum = (c: string): number => {
      // rgb(…) in 0–255, or color(srgb …) in 0–1 (a color-mix result).
      const [r, g, b] = (c.match(/[\d.]+/g) ?? []).map(Number).map((v) => (c.startsWith('color(') ? v * 255 : v));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    expect(lum(chip)).toBeGreaterThan(150);
    // A captured black piece's group gets the same chip.
    const group = await page.evaluate(() => {
      const strip = document.querySelector('.pstrip-caps')!;
      const g = document.createElement('span');
      g.className = 'pstrip-group';
      g.innerHTML = '<i class="pstrip-piece piece-art" data-p="bp"></i>';
      strip.append(g);
      const color = getComputedStyle(g).backgroundColor;
      g.remove();
      return color;
    });
    expect(group).toBe(chip);
    // No chip in the light theme, nor for the sets whose black pieces have light detail.
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    expect(await style(blackKing, 'background-color')).toBe('rgba(0, 0, 0, 0)');
    await page.evaluate(() => Object.assign(document.documentElement.dataset, { theme: 'dark', pieces: 'cburnett' }));
    expect(await style(blackKing, 'background-color')).toBe('rgba(0, 0, 0, 0)');
  });

  test('the license notices credit every set as it ships', async ({ request }) => {
    const all = await (await request.get('THIRD-PARTY-LICENSES.txt')).text();
    const start = all.indexOf('## Chess pieces');
    expect(start).toBeGreaterThan(0);
    const pieces = all.slice(start, all.indexOf('\n## ', start + 1));
    for (const set of PIECE_SETS) expect(pieces).toContain(`### ${set.name} - ${set.author} - ${SKIN_LICENSES[set.license].name}`);
    // Chessnut's copyright notice (Apache-2.0 4(c)), MPchess as its upstream grants it, lila's changes
    // noted (CC BY 4.0 3(a)(1)(B)), and no set excluded for its license.
    expect(pieces).toContain('Copyright 2015 Alexis Luengas (pieces/chessnut/COPYRIGHT.txt)');
    expect(pieces).toContain('License: GPL-3.0-only');
    expect(pieces).toContain('made no further changes');
    expect(pieces).not.toMatch(/unmodified|merida|totoy|papercut/i);
    expect(await (await request.get('pieces/chessnut/COPYRIGHT.txt')).text()).toBe('Copyright 2015 Alexis Luengas');
    const merida = await request.get('pieces/merida/wK.svg');
    expect(merida.status() === 404 || !(merida.headers()['content-type'] ?? '').includes('svg')).toBe(true);
  });

  test('an unknown stored board or piece set falls back to the defaults', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('chesscoach.board', 'plaid');
      localStorage.setItem('chesscoach.pieces', 'pixel');
    });
    await openApp(page);
    await expect(page.locator('html')).toHaveAttribute('data-board', 'green');
    await expect(page.locator('html')).toHaveAttribute('data-pieces', 'cburnett');
    expect(await style(board(page), 'background-image')).toContain('rgb(118, 150, 86)');
    expect(await style(page.locator('main .board piece.pawn.white').first(), 'background-image')).toContain('data:image/svg+xml');
    const menu = await openMenu(page);
    await expect(menu.locator('[data-id="skins-summary"]')).toHaveText('Green board · Classic pieces');
    const picker = await openPicker(page, menu);
    await expect(picker.getByRole('radio', { name: 'Green board' })).toHaveAttribute('aria-checked', 'true');
    await expect(picker.getByRole('radio', { name: 'Classic pieces' })).toHaveAttribute('aria-checked', 'true');
  });

  test('the picker: radio groups with VoiceOver names, the arrow keys, 44 px targets, the preview kept in sight', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openApp(page);
    const menu = await openMenu(page);
    const picker = await openPicker(page, menu);
    const boards = picker.getByRole('radiogroup', { name: 'Board' });
    const pieces = picker.getByRole('radiogroup', { name: 'Pieces' });
    await expect(boards.getByRole('radio')).toHaveCount(10);
    await expect(pieces.getByRole('radio')).toHaveCount(8);
    // Every tile has its full name, and one tab stop per group (the choice).
    for (const name of ['Green board', 'Brown board', 'Wood board', 'Blue board', 'Ice board', 'Slate board', 'Marble board', 'Purple board', 'Coral board', 'Olive board']) {
      await expect(boards.getByRole('radio', { name, exact: true })).toHaveCount(1);
    }
    for (const name of ['Classic pieces', 'MPchess pieces', 'Chessnut pieces', 'Celtic pieces', 'Fantasy pieces', 'Spatial pieces', 'RhosGFX pieces', 'Kiwen Suwi pieces']) {
      await expect(pieces.getByRole('radio', { name, exact: true })).toHaveCount(1);
    }
    await expect(boards.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
    await expect(pieces.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
    // 44 px targets.
    for (const box of await picker.getByRole('radio').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }

    // The keys: → and ↓ the next, ← and ↑ the previous (wrapping), Home and End; each applied, stored and focused.
    const green = boards.getByRole('radio', { name: 'Green board' });
    await green.focus();
    await page.keyboard.press('ArrowRight');
    const brown = boards.getByRole('radio', { name: 'Brown board' });
    await expect(brown).toHaveAttribute('aria-checked', 'true');
    await expect(brown).toBeFocused();
    await expect(brown).toHaveAttribute('tabindex', '0');
    await expect(green).toHaveAttribute('tabindex', '-1');
    await expect(page.locator('html')).toHaveAttribute('data-board', 'brown');
    expect(await page.evaluate(() => localStorage.getItem('chesscoach.board'))).toBe('brown');
    await page.keyboard.press('End');
    await expect(boards.getByRole('radio', { name: 'Olive board' })).toBeFocused();
    await expect(page.locator('html')).toHaveAttribute('data-board', 'olive');
    await page.keyboard.press('ArrowDown');
    await expect(green).toBeFocused();
    await expect(green).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(boards.getByRole('radio', { name: 'Olive board' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Home');
    await expect(green).toHaveAttribute('aria-checked', 'true');
    // Tab leaves the group for the next one, on its choice.
    await page.keyboard.press('Tab');
    const classic = pieces.getByRole('radio', { name: 'Classic pieces' });
    await expect(classic).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(pieces.getByRole('radio', { name: 'MPchess pieces' })).toBeFocused();
    await expect(page.locator('html')).toHaveAttribute('data-pieces', 'mpchess');
    await page.keyboard.press('ArrowUp');
    await expect(classic).toHaveAttribute('aria-checked', 'true');
    await expect(classic).toBeFocused();

    // The preview stays in sight while the pickers scroll under it.
    const body = picker.locator('.sheet-body');
    const previewBox = async () => (await picker.locator('[data-id="skins-preview"] .board').boundingBox())!;
    const before = await previewBox();
    await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect.poll(async () => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const after = await previewBox();
    expect(Math.abs(after.y - before.y)).toBeLessThan(4);
    const panel = (await picker.boundingBox())!;
    expect(after.y).toBeGreaterThanOrEqual(panel.y);

    // Escape: the picker, then the Menu.
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('the picker fits a small phone and landscape, and stays in one segment of the iPhone Duo', async ({ page }) => {
    test.setTimeout(90_000);
    /** The sheet in sight, nothing scrolling sideways, every tile at least 44 px. */
    const expectTidy = async (picker: Locator, label: string) => {
      const m = await page.evaluate(() => {
        const panel = [...document.querySelectorAll('.sheet[data-state="open"] .sheet-panel')].at(-1)!;
        const body = panel.querySelector('.sheet-body')!;
        const r = panel.getBoundingClientRect();
        const radios = [...panel.querySelectorAll('[role="radio"]')].map((el) => el.getBoundingClientRect());
        return {
          panel: { x: r.x, y: r.y, right: r.right, bottom: r.bottom },
          w: innerWidth,
          h: innerHeight,
          sideways: Math.max(document.scrollingElement!.scrollWidth - innerWidth, body.scrollWidth - body.clientWidth),
          minW: Math.min(...radios.map((b) => b.width)),
          minH: Math.min(...radios.map((b) => b.height)),
        };
      });
      expect(m.panel.x, label).toBeGreaterThanOrEqual(-0.5);
      expect(m.panel.right, label).toBeLessThanOrEqual(m.w + 0.5);
      expect(m.panel.bottom, label).toBeLessThanOrEqual(m.h + 0.5);
      expect(m.sideways, `${label}: sideways scroll`).toBeLessThanOrEqual(1);
      expect(m.minW, `${label}: tile width`).toBeGreaterThanOrEqual(44);
      expect(m.minH, `${label}: tile height`).toBeGreaterThanOrEqual(44);
      await expect(picker.locator('[data-id="skins-preview"] .board')).toBeVisible();
    };
    const pickerAt = async () => {
      const menu = await openMenu(page);
      return openPicker(page, menu);
    };

    // iPhone SE (375 x 667): one column, the preview over the pickers.
    await page.setViewportSize({ width: 375, height: 667 });
    await openApp(page);
    let picker = await pickerAt();
    await expectTidy(picker, '375x667');
    let preview = (await picker.locator('[data-id="skins-preview"] .board').boundingBox())!;
    let grid = (await picker.locator('[data-id="board-themes"]').boundingBox())!;
    expect(grid.y).toBeGreaterThan(preview.y + preview.height - 1);
    // Landscape: the preview is a column beside the pickers.
    await page.setViewportSize({ width: 852, height: 393 });
    await expectTidy(picker, '852x393');
    preview = (await picker.locator('[data-id="skins-preview"] .board').boundingBox())!;
    grid = (await picker.locator('[data-id="board-themes"]').boundingBox())!;
    expect(grid.x).toBeGreaterThan(preview.x + preview.width - 1);
    expect(preview.y + preview.height).toBeLessThanOrEqual(393);

    // The iPhone Duo's inner display (CDP display feature, as in foldable.spec.ts): open like a book,
    // the sheet in the right-hand segment; half folded on a table, in the bottom half.
    const cdp = await page.context().newCDPSession(page);
    const fold = async (cdpSession: CDPSession, vp: { width: number; height: number; orientation: 'vertical' | 'horizontal'; posture?: 'folded' }) => {
      await cdpSession.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 3,
        mobile: true,
        screenWidth: vp.width,
        screenHeight: vp.height,
        displayFeature: { orientation: vp.orientation, offset: (vp.orientation === 'vertical' ? vp.width : vp.height) / 2, maskLength: 0 },
      });
      if (vp.posture) await cdpSession.send('Emulation.setDevicePostureOverride', { posture: { type: vp.posture } });
      else await cdpSession.send('Emulation.clearDevicePostureOverride');
    };
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await fold(cdp, { width: 890, height: 626, orientation: 'vertical' });
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'book');
    picker = await pickerAt();
    await expectTidy(picker, 'Duo book');
    await expect.poll(async () => {
      const b = (await picker.boundingBox())!;
      return b.x >= 445 && b.x + b.width <= 890;
    }).toBe(true);

    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await fold(cdp, { width: 626, height: 890, orientation: 'horizontal', posture: 'folded' });
    await expect(page.locator('html')).toHaveAttribute('data-fold', 'tabletop');
    picker = await pickerAt();
    await expectTidy(picker, 'Duo tabletop');
    await expect.poll(async () => (await picker.boundingBox())!.y).toBeGreaterThanOrEqual(445);
    preview = (await picker.locator('[data-id="skins-preview"] .board').boundingBox())!;
    grid = (await picker.locator('[data-id="board-themes"]').boundingBox())!;
    expect(grid.x).toBeGreaterThan(preview.x + preview.width - 1);
  });
});
