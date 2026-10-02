/**
 * Regenerates the iOS app icon and launch image (ios/App/App/Assets.xcassets) from the artwork in
 * public/. sharp is not a dependency of the app; run it ad hoc:
 *
 *   npm install --no-save sharp && node ios/tools/make-assets.mjs
 *
 * - AppIcon-1024.png: public/icon-source.svg at 1024 x 1024, opaque (the App Store rejects icons
 *   with an alpha channel). iOS rounds the corners itself.
 * - Splash (LaunchScreen.storyboard shows it "aspect fill", so it always spans the screen height):
 *   public/favicon.svg on #1d1c1a, at the size and height of the logo on the app's own start screen
 *   (88 pt, centered at 45.7% of the height of an iPhone 15 Pro), so the hand-over looks steady.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_MODULE || 'sharp');

const BG = '#1d1c1a';
const path = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const assets = (p) => path(`ios/App/App/Assets.xcassets/${p}`);
/** Flattens onto the background and drops the alpha channel. */
const opaque = (input) =>
  sharp(input).flatten({ background: BG }).removeAlpha().png({ compressionLevel: 9 }).toBuffer();

const icon = await sharp(path('public/icon-source.svg'), { density: 144 }).resize(1024, 1024).png().toBuffer();
writeFileSync(assets('AppIcon.appiconset/AppIcon-1024.png'), await opaque(icon));

const SIZE = 2732;
const MARK = Math.round((SIZE * 88) / 852);
const CENTER_Y = Math.round(SIZE * 0.457);
const mark = await sharp(path('public/favicon.svg'), { density: (72 * MARK) / 512 })
  .resize(MARK, MARK)
  .png()
  .toBuffer();
const splash = await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: BG } })
  .composite([{ input: mark, left: Math.round((SIZE - MARK) / 2), top: Math.round(CENTER_Y - MARK / 2) }])
  .png()
  .toBuffer();
const splashPng = await opaque(splash);
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  writeFileSync(assets(`Splash.imageset/${name}`), splashPng);
}
console.log('Wrote AppIcon-1024.png and the Splash images.');
