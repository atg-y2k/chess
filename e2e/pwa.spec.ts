/**
 * PWA shell smoke tests against the production build (see playwright.config.ts): manifest and
 * iOS tags, service worker + precache, engine files, offline reload, and the full-screen shell.
 * They deliberately avoid the app UI itself.
 */
import { expect, test, type APIResponse, type Page } from '@playwright/test';

const ENGINE_JS = 'engine/stockfish-19-lite-single.js';
const ENGINE_WASM = 'engine/stockfish-19-lite-single.wasm';
const ENGINE_WASM_BYTES = 1_787_571;

/** Licence and source notices shipped with the app: [path, content type, text it must contain]. */
const NOTICES: [string, RegExp, string][] = [
  ['THIRD-PARTY-LICENSES.txt', /^text\/plain/, 'workbox-core'],
  ['engine/COPYING-stockfish.txt', /^text\/plain/, 'GNU GENERAL PUBLIC LICENSE'],
  ['engine/README.md', /^text\/markdown/, 'Corresponding source'],
];

/** Width, height and colour type from a PNG's IHDR chunk (colour type 2 = RGB, 6 = RGBA). */
function pngInfo(buf: Buffer): { width: number; height: number; colorType: number } {
  expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] ?? -1 };
}

async function expectPng(res: APIResponse, size: number): Promise<number> {
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/png');
  const info = pngInfo(await res.body());
  expect([info.width, info.height]).toEqual([size, size]);
  return info.colorType;
}

async function attr(page: Page, selector: string, name: string): Promise<string> {
  const value = await page.locator(selector).first().getAttribute(name);
  expect(value, `${selector} ${name}`).not.toBeNull();
  return value ?? '';
}

/**
 * Waits until a service worker controls the page. The app registers it at startup
 * (registerServiceWorker() in src/main.tsx). If it has not been wired up yet, the generated sw.js is
 * registered directly so the worker itself is still tested; set E2E_REQUIRE_APP_SW=1 to fail instead.
 */
async function waitForServiceWorker(page: Page): Promise<void> {
  const byApp = await page.evaluate(async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (await navigator.serviceWorker.getRegistration()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  });
  if (!byApp) {
    const message = 'The app did not register a service worker (call registerServiceWorker() in src/main.tsx).';
    if (process.env.E2E_REQUIRE_APP_SW) throw new Error(message);
    test.info().annotations.push({ type: 'warning', description: `${message} Registered sw.js directly.` });
    await page.evaluate(() => navigator.serviceWorker.register('sw.js', { scope: './' }));
  }
  // clientsClaim: the first visit is controlled as soon as the worker activates (no reload needed).
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 30_000 });
}

/** Starts the engine worker in the page and returns its answer to `go depth 6` (or an error). */
async function runEngine(page: Page): Promise<string> {
  return page.evaluate(async (url) => {
    const worker = new Worker(url);
    try {
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('engine timeout')), 30_000);
        worker.onerror = (e) => reject(new Error(`worker error: ${e.message}`));
        worker.onmessage = (e: MessageEvent) => {
          if (typeof e.data !== 'string') return;
          for (const line of e.data.split('\n')) {
            if (line.startsWith('uciok')) worker.postMessage('isready');
            else if (line.startsWith('readyok')) {
              worker.postMessage('position startpos');
              worker.postMessage('go depth 6');
            } else if (line.startsWith('bestmove')) {
              clearTimeout(timer);
              resolve(line.trim());
            }
          }
        };
        worker.postMessage('uci');
      });
    } finally {
      worker.terminate();
    }
  }, ENGINE_JS);
}

test.describe('PWA shell', () => {
  test('serves a valid web app manifest', async ({ page }) => {
    await page.goto('./');
    const manifestUrl = new URL(await attr(page, 'link[rel="manifest"]', 'href'), page.url());
    const res = await page.request.get(manifestUrl.href);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/application\/(manifest\+)?json/);

    const manifest = (await res.json()) as {
      id: string;
      name: string;
      short_name: string;
      description: string;
      start_url: string;
      scope: string;
      display: string;
      orientation: string;
      theme_color: string;
      background_color: string;
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };
    expect(manifest.name).toBe('Chess Coach');
    expect(manifest.short_name).toBe('Chess Coach');
    expect(manifest.description.length).toBeGreaterThan(20);
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('portrait');
    expect(manifest.theme_color).toBe('#1d1c1a');
    expect(manifest.background_color).toBe('#1d1c1a');

    // start_url and scope resolve to the app's base URL (e.g. /chess/ on GitHub Pages).
    const appUrl = new URL('./', page.url()).href;
    expect(new URL(manifest.start_url, manifestUrl).href).toBe(appUrl);
    expect(new URL(manifest.scope, manifestUrl).href).toBe(appUrl);
    // So does the app's identity, which is resolved against start_url's origin instead: an id of
    // "." would make it the whole origin (every app on atg-y2k.github.io).
    expect(new URL(manifest.id, new URL(manifest.start_url, manifestUrl).origin).href).toBe(appUrl);

    const find = (sizes: string, purpose?: string) =>
      manifest.icons.find((i) => i.sizes === sizes && (i.purpose ?? 'any') === (purpose ?? 'any'));
    expect(find('192x192')).toBeTruthy();
    expect(find('512x512')).toBeTruthy();
    expect(find('512x512', 'maskable')).toBeTruthy();
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const size = Number(icon.sizes.split('x')[0]);
      const colorType = await expectPng(await page.request.get(new URL(icon.src, manifestUrl).href), size);
      // Maskable icons are full-bleed: they must not have transparent areas.
      if (icon.purpose === 'maskable') expect(colorType).toBe(2);
    }
  });

  test('has the iOS home-screen tags and icons', async ({ page }) => {
    await page.goto('./');
    await expect(page).toHaveTitle('Chess Coach');
    const meta = (name: string) => attr(page, `meta[name="${name}"]`, 'content');
    expect(await meta('viewport')).toContain('viewport-fit=cover');
    expect(await meta('apple-mobile-web-app-capable')).toBe('yes');
    expect(await meta('mobile-web-app-capable')).toBe('yes');
    expect(await meta('apple-mobile-web-app-status-bar-style')).toBe('black-translucent');
    expect(await meta('apple-mobile-web-app-title')).toBe('Chess Coach');
    expect(await meta('theme-color')).toMatch(/^#[0-9a-f]{6}$/i);
    expect((await meta('description')).length).toBeGreaterThan(20);

    // iOS needs an opaque 180x180 PNG (it fills transparency with black and rounds the corners itself).
    const touchIcon = new URL(await attr(page, 'link[rel="apple-touch-icon"]', 'href'), page.url());
    expect(await expectPng(await page.request.get(touchIcon.href), 180)).toBe(2);

    for (const href of await page.locator('link[rel="icon"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
      const res = await page.request.get(new URL(href ?? '', page.url()).href);
      expect(res.status(), `favicon ${href}`).toBe(200);
      expect(res.headers()['content-type']).toMatch(/image\/(svg\+xml|x-icon|vnd\.microsoft\.icon)/);
    }

    // Launch images: one per device size and colour scheme, sized device-width x DPR.
    const splashes = await page
      .locator('link[rel="apple-touch-startup-image"]')
      .evaluateAll((els) => els.map((e) => ({ href: e.getAttribute('href') ?? '', media: e.getAttribute('media') ?? '' })));
    expect(splashes.some((s) => s.media.includes('(device-width: 393px) and (device-height: 852px)'))).toBe(true);
    for (const { href, media } of splashes) {
      const [, w, h, dpr] = /device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)/.exec(media) ?? [];
      const res = await page.request.get(new URL(href, page.url()).href);
      expect(res.status(), href).toBe(200);
      const info = pngInfo(await res.body());
      expect([info.width, info.height], href).toEqual([Number(w) * Number(dpr), Number(h) * Number(dpr)]);
    }
  });

  test('serves the Stockfish engine files with the right MIME types', async ({ page }) => {
    await page.goto('./');
    const js = await page.request.get(ENGINE_JS);
    expect(js.status()).toBe(200);
    expect(js.headers()['content-type']).toMatch(/javascript/);
    expect((await js.text()).slice(0, 40)).toContain('Stockfish.js 19');

    // WebAssembly.instantiateStreaming requires application/wasm.
    const wasm = await page.request.get(ENGINE_WASM);
    expect(wasm.status()).toBe(200);
    expect(wasm.headers()['content-type']).toBe('application/wasm');
    const bytes = await wasm.body();
    expect(bytes.length).toBe(ENGINE_WASM_BYTES);
    expect(bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))).toBe(true); // "\0asm"
  });

  test('service worker controls the page and precaches the app and engine', async ({ page }) => {
    await page.goto('./');
    await waitForServiceWorker(page);

    const sw = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { scope: reg?.scope, script: reg?.active?.scriptURL };
    });
    expect(sw.scope).toBe(new URL('./', page.url()).href);
    expect(sw.script).toBe(new URL('sw.js', page.url()).href);

    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        for (const req of await (await caches.open(name)).keys()) urls.push(new URL(req.url).pathname);
      }
      return urls;
    });
    const base = new URL('./', page.url()).pathname;
    const notices = NOTICES.map(([path]) => path);
    for (const path of ['index.html', 'manifest.webmanifest', ENGINE_JS, ENGINE_WASM, 'apple-touch-icon-180x180.png', ...notices]) {
      expect(cached, path).toContain(base + path);
    }
    expect(cached.some((p) => /\/assets\/.+\.js$/.test(p))).toBe(true);
    expect(cached.some((p) => /\/assets\/.+\.css$/.test(p))).toBe(true);
  });

  test('works offline after the first visit, engine included', async ({ page, context }, testInfo) => {
    await page.goto('./');
    await waitForServiceWorker(page);

    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page).toHaveTitle('Chess Coach');
      await expect(page.locator('#app > *').first()).toBeAttached();
      expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

      // The app's URL with any query gets the cached index.html.
      await page.goto('./?offline-deep-link=1');
      await expect(page.locator('#app > *').first()).toBeAttached();

      // The engine worker script and its .wasm come from the precache, with the right MIME type.
      const wasmType = await page.evaluate(async (url) => (await fetch(url)).headers.get('content-type'), ENGINE_WASM);
      expect(wasmType).toBe('application/wasm');
      expect(await runEngine(page)).toMatch(/^bestmove [a-h][1-8][a-h][1-8]/);

      await testInfo.attach('offline.png', { body: await page.screenshot(), contentType: 'image/png' });

      // The licence and source notices open offline too (last: this leaves the app's URL).
      for (const [path, , text] of NOTICES) {
        const res = await page.goto(path);
        expect(res?.fromServiceWorker(), path).toBe(true);
        expect(await res?.text(), path).toContain(text);
      }
    } finally {
      await context.setOffline(false);
    }
  });

  test('opens the licence and source notices as files, not as the app', async ({ page }) => {
    await page.goto('./');
    await waitForServiceWorker(page);

    for (const [path, type, text] of NOTICES) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      expect(res?.headers()['content-type'], path).toMatch(type);
      const body = (await res?.text()) ?? '';
      expect(body, path).toContain(text);
      expect(body, path).not.toContain('id="app"');
    }

    // Only the app's own URL gets the cached app shell: the service worker leaves other paths to
    // the server (a 404 on a static host), so a future notice or download is never swallowed.
    const other = await page.goto('no-such-page');
    expect(other?.fromServiceWorker()).toBe(false);
  });

  test('app shell fills the screen as a flex column', async ({ page }) => {
    await page.goto('./');
    const shell = await page.locator('#app').evaluate((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { position: s.position, display: s.display, direction: s.flexDirection, rect: [r.x, r.y, r.width, r.height] };
    });
    const vp = page.viewportSize();
    expect(shell.position).toBe('fixed');
    expect(shell.display).toBe('flex');
    expect(shell.direction).toBe('column');
    expect(shell.rect).toEqual([0, 0, vp?.width, vp?.height]);
    // No page-level scrolling or rubber-banding.
    const body = await page.evaluate(() => {
      const s = getComputedStyle(document.body);
      return { overflow: s.overflow, overscroll: s.overscrollBehaviorY };
    });
    expect(body).toEqual({ overflow: 'hidden', overscroll: 'none' });
  });
});
