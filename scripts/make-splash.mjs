#!/usr/bin/env node
/**
 * iOS launch images for the web app (public/splash/, linked from index.html by SPLASH_SCREENS in
 * vite.config.ts: one per screen size, orientation and color scheme). Makes the missing ones from
 * the images already there: the same background and the same logo at the same size in device
 * pixels, centered on the logo, written as small RGB PNGs (filtered rows, zlib level 9).
 *
 * Run it from the repository root:
 *
 *   node scripts/make-splash.mjs [options]
 *     (no option)        the landscape image of every portrait one that has none
 *                        (apple-splash-<scheme>-<height>x<width>.png from <width>x<height>)
 *     --size=1878x2670   also a new screen size, in portrait device pixels (both schemes, both
 *                        orientations): the iPhone Duo's displays, once their sizes are known; add
 *                        them to SPLASH_SCREENS too (in CSS px, with the scale), or e2e/pwa.spec.ts
 *                        fails on a link without its image
 *     --scale=0.667      the logo's size against the source images (all @3x): 0.667 for a @2x screen
 *     --out=DIR          write there instead of public/splash/ (to look first)
 *     --force            also redo images that exist
 *
 * Chromium (to decode and draw the PNGs): PW_CHROMIUM_PATH, else /opt/pw-browsers/chromium when
 * present, else Playwright's own (`npx playwright install chromium`).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'public/splash');
const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const OUT = resolve(option('out') ?? DIR);
const FORCE = args.includes('--force');
const SCALE = Number(option('scale') ?? 1);
const FILE = /^apple-splash-(dark|light)-(\d+)x(\d+)\.png$/;

/** An 8-bit RGB PNG of `rgba` (width × height × 4 bytes). */
function png(width, height, rgba) {
  const stride = width * 3;
  const rows = Buffer.alloc((stride + 1) * height);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) cur[x * 3 + c] = rgba[(y * width + x) * 4 + c];
    // Filter 'up' (2): flat backgrounds and vertical gradients become runs of zeros.
    const o = y * (stride + 1);
    rows[o] = 2;
    for (let i = 0; i < stride; i++) rows[o + 1 + i] = (cur[i] - prev[i]) & 255;
    cur.copy(prev);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// What to make: [scheme, width, height] in device px.
const existing = readdirSync(DIR)
  .map((f) => f.match(FILE))
  .filter(Boolean)
  .map(([file, scheme, w, h]) => ({ file, scheme, w: Number(w), h: Number(h) }));
const portraits = existing.filter((e) => e.w < e.h);
const wanted = new Map();
for (const p of portraits) wanted.set(`${p.scheme}-${p.h}x${p.w}`, [p.scheme, p.h, p.w]);
for (const size of args.filter((a) => a.startsWith('--size=')).map((a) => a.slice(7))) {
  const m = size.match(/^(\d+)x(\d+)$/);
  if (!m) throw new Error(`--size=${size}: expected WIDTHxHEIGHT in device px`);
  const [w, h] = [Number(m[1]), Number(m[2])].sort((a, b) => a - b);
  for (const scheme of ['dark', 'light']) {
    wanted.set(`${scheme}-${w}x${h}`, [scheme, w, h]);
    wanted.set(`${scheme}-${h}x${w}`, [scheme, h, w]);
  }
}
const jobs = [...wanted.values()].filter(([scheme, w, h]) => FORCE || !existsSync(join(DIR, `apple-splash-${scheme}-${w}x${h}.png`)));
if (!jobs.length) {
  console.log('Nothing to make: every launch image is there (--force redoes them).');
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });

const LOCAL_CHROMIUM = '/opt/pw-browsers/chromium';
const executablePath = process.env.PW_CHROMIUM_PATH || (existsSync(LOCAL_CHROMIUM) ? LOCAL_CHROMIUM : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const page = await browser.newPage();
  for (const [scheme, W, H] of jobs) {
    // The portrait image of the same screen (for its landscape one), else the largest of the scheme.
    const source =
      portraits.find((p) => p.scheme === scheme && p.w === Math.min(W, H) && p.h === Math.max(W, H)) ??
      portraits.filter((p) => p.scheme === scheme).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (!source) throw new Error(`No portrait ${scheme} launch image to start from in ${DIR}`);
    const src = `data:image/png;base64,${readFileSync(join(DIR, source.file)).toString('base64')}`;
    const r = await page.evaluate(
      async ({ src, W, H, scale }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const a = document.createElement('canvas');
        a.width = img.width;
        a.height = img.height;
        const actx = a.getContext('2d');
        actx.drawImage(img, 0, 0);
        const px = actx.getImageData(0, 0, a.width, a.height).data;
        const bg = [px[0], px[1], px[2]];
        // The logo's box: pixels clearly off the background (the soft glow around it stays in the crop).
        let top = a.height;
        let bottom = 0;
        let left = a.width;
        let right = 0;
        for (let y = 0; y < a.height; y++) {
          for (let x = 0; x < a.width; x++) {
            const i = (y * a.width + x) * 4;
            if (Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) > 24) {
              top = Math.min(top, y);
              bottom = Math.max(bottom, y);
              left = Math.min(left, x);
              right = Math.max(right, x);
            }
          }
        }
        const cx = Math.round((left + right) / 2);
        const cy = Math.round((top + bottom) / 2);
        // A square around the logo, as big as both images allow, drawn centered (scaled for another DPR).
        const side = Math.min(a.width, a.height, Math.round(Math.min(W, H) / scale));
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const ctx = c.getContext('2d');
        ctx.fillStyle = `rgb(${bg.join(',')})`;
        ctx.fillRect(0, 0, W, H);
        const out = side * scale;
        ctx.drawImage(a, cx - side / 2, cy - side / 2, side, side, W / 2 - out / 2, H / 2 - out / 2, out, out);
        const data = ctx.getImageData(0, 0, W, H).data;
        let bin = '';
        for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
        return { raw: btoa(bin) };
      },
      { src, W, H, scale: SCALE },
    );
    const name = `apple-splash-${scheme}-${W}x${H}.png`;
    const buf = png(W, H, Buffer.from(r.raw, 'base64'));
    writeFileSync(join(OUT, name), buf);
    console.log(`${name} (from ${source.file}): ${buf.length} bytes`);
  }
} finally {
  await browser.close();
}
