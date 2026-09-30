import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

// BASE_PATH is set to "/chess/" by the GitHub Pages workflow. Every URL in the app (engine,
// manifest, service worker) is relative to it, so the build also works under "/" or a custom domain.
const base = process.env.BASE_PATH ?? '/';

/**
 * Where users of the deployed app can get its source code (the GPL requires offering it; see
 * README "Hosting"). Override it with VITE_SOURCE_URL, e.g. for a source archive published next to
 * the app (`npm run build:source`).
 */
const SOURCE_URL = process.env.VITE_SOURCE_URL || 'https://github.com/atg-y2k/chess';

/** The licences of everything the build ships, written to dist/ (see thirdPartyLicenses()). */
const LICENSES_FILE = 'THIRD-PARTY-LICENSES.txt';

/**
 * The vendored engine files in public/engine/ and their SHA-256. The service worker precaches them
 * by URL alone, without a revision, so on the first visit it can take the copy the engine has just
 * downloaded from the HTTP cache instead of fetching the 1.8 MB again. That is only safe while a URL
 * always means the same bytes: a new engine version must come with new file names (it does:
 * `stockfish-<version>-…`). The build fails if a file here changes or a new one is not listed.
 */
const ENGINE_FILES: Record<string, string> = {
  'stockfish-19-lite-single.js': 'd3344124ab067fb0b90ee77873bb8e9fbf5fc01bc525fe714b0f942581e889e6',
  'stockfish-19-lite-single.wasm': '57ac2d72312aba346760e3f173f687a8c211208e97a87268436f7f0e10bb5387',
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Dark UI colour (matches --bg in src/styles/app.css): status bar, splash and task switcher. */
const THEME = '#1d1c1a';

/**
 * iOS launch images in public/splash/ (portrait, dark + light), as [CSS width, CSS height, DPR].
 * iOS only shows one whose media query matches the device exactly; others get a plain screen.
 */
const SPLASH_SCREENS: [number, number, number][] = [
  [375, 812, 3], // iPhone X, XS, 11 Pro, 12 mini, 13 mini
  [390, 844, 3], // iPhone 12, 13, 14, 16e
  [393, 852, 3], // iPhone 14 Pro, 15, 15 Pro, 16
  [402, 874, 3], // iPhone 16 Pro, 17, 17 Pro
  [428, 926, 3], // iPhone 12/13 Pro Max, 14 Plus
  [430, 932, 3], // iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  [440, 956, 3], // iPhone 16 Pro Max, 17 Pro Max
];

/** Adds the <link rel="apple-touch-startup-image"> tags for SPLASH_SCREENS to index.html. */
function appleSplashScreens(): Plugin {
  return {
    name: 'chess-coach:apple-splash-screens',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx): HtmlTagDescriptor[] {
        if (!/(^|[\\/])index\.html$/.test(ctx.filename)) return []; // not the dev gallery page
        return SPLASH_SCREENS.flatMap(([w, h, dpr]) =>
          (['dark', 'light'] as const).map((scheme) => ({
            tag: 'link',
            injectTo: 'head' as const,
            attrs: {
              rel: 'apple-touch-startup-image',
              href: `${base}splash/apple-splash-${scheme}-${w * dpr}x${h * dpr}.png`,
              media:
                `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) ` +
                `and (orientation: portrait) and (prefers-color-scheme: ${scheme})`,
            },
          })),
        );
      },
    },
  };
}

/**
 * Fails the build if an engine file in public/engine/ is not in ENGINE_FILES with the same content:
 * the service worker would keep serving the old bytes under an unchanged name.
 */
function immutableEngineFiles(): Plugin {
  return {
    name: 'chess-coach:immutable-engine-files',
    apply: 'build',
    buildStart() {
      const dir = fileURLToPath(new URL('./public/engine/', import.meta.url));
      const files = readdirSync(dir).filter((f) => /\.(js|wasm)$/.test(f));
      for (const name of new Set([...files, ...Object.keys(ENGINE_FILES)])) {
        const expected = ENGINE_FILES[name];
        if (!files.includes(name)) this.error(`public/engine/${name} is missing (listed in ENGINE_FILES in vite.config.ts).`);
        const actual = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex');
        if (actual !== expected) {
          this.error(
            `public/engine/${name} ${expected ? 'has changed' : 'is not listed in ENGINE_FILES'} (sha256 ${actual}). ` +
              'Installed apps cache engine files by name, so new engine files need new names; then list ' +
              'them in ENGINE_FILES in vite.config.ts and update src/engine/workerTransport.ts.',
          );
        }
      }
    },
  };
}

/**
 * Completes Vite's `build.license` file: a note on Chess Coach's own licence and source, the engine
 * (public/engine/ has its own README and licence text), and Workbox, whose service-worker runtime is
 * built outside the Vite bundle so Vite does not list it.
 */
function thirdPartyLicenses(): Plugin {
  const header = `Chess Coach: licences of the software it includes

Chess Coach is free software: you can redistribute it and/or modify it under the terms of the GNU
General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. It comes with ABSOLUTELY NO WARRANTY.
Source code: ${SOURCE_URL}

The chess engine in engine/ is Stockfish (Stockfish.js): GPL-3.0. engine/README.md says where
its source is, and engine/COPYING-stockfish.txt is the GPL-3.0 text (it applies to the app too).

The app's JavaScript includes the packages below. The service worker (sw.js, workbox-*.js) is
built from the Workbox packages listed last.
`;
  const workboxNotice = (): string => {
    // The service-worker runtime packages all carry workbox-core's licence and version.
    const dir = dirname(createRequire(import.meta.url).resolve('workbox-core/package.json'));
    const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string };
    const license = readFileSync(join(dir, 'LICENSE'), 'utf8').trim();
    return `\n## workbox-core, workbox-precaching, workbox-routing, workbox-strategies - ${version} (MIT)\n\n${license}\n`;
  };
  return {
    name: 'chess-coach:third-party-licenses',
    apply: 'build',
    generateBundle: {
      order: 'post', // after Vite's own license plugin has emitted the file
      handler(_options, bundle) {
        const file = bundle[LICENSES_FILE];
        if (file?.type !== 'asset') return;
        const text = typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source);
        // Replace Vite's generic heading with ours; keep its per-package sections.
        file.source = header + text.replace(/^# Licenses\s+The app bundles[^\n]*\n/, '') + workboxNotice();
      },
    },
  };
}

export default defineConfig({
  base,
  plugins: [
    preact(),
    appleSplashScreens(),
    immutableEngineFiles(),
    thirdPartyLicenses(),
    VitePWA({
      strategies: 'generateSW',
      // New builds activate straight away; src/pwa.ts decides when the page reloads onto them.
      registerType: 'autoUpdate',
      // Registered by registerServiceWorker() in src/pwa.ts (virtual:pwa-register), not a script tag.
      injectRegister: false,
      // public/ files are precached by globPatterns below; including the icons again would only
      // add duplicate precache entries.
      includeManifestIcons: false,
      manifest: {
        id: '.',
        name: 'Chess Coach',
        short_name: 'Chess Coach',
        description:
          'Play chess against Stockfish at any level, with a live evaluation bar and a coach that explains every move. Works offline.',
        lang: 'en',
        dir: 'ltr',
        categories: ['games', 'education'],
        // Relative to the manifest URL, i.e. the base path.
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: THEME,
        background_color: THEME,
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Everything the app needs offline, including the Stockfish worker script + .wasm in
        // public/engine/ (they keep their names, so the worker finds its .wasm next to itself), and
        // the licence and source notices (.txt, .md) so they open offline too.
        globPatterns: ['**/*.{js,css,html,wasm,png,svg,ico,json,txt,md}'],
        // icon-source.svg is only the master artwork for the PNG icons; iOS reads the launch images
        // when the app is added to the Home Screen, so they need not be cached offline.
        globIgnores: ['**/node_modules/**/*', 'icon-source.svg', 'splash/**'],
        // Workbox's default limit is 2 MiB; the engine .wasm is 1.7 MiB. Leave headroom.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // With injectRegister: false the plugin does not set these for autoUpdate; without them the
        // first visit stays uncontrolled until a reload and updates wait for every tab to close.
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
        // Hashed build assets (Vite's default here) and the engine files are versioned by their URL:
        // no revision, so the precache may reuse the HTTP cache (see ENGINE_FILES).
        dontCacheBustURLsMatching: new RegExp(
          `^(?:assets/|engine/(?:${Object.keys(ENGINE_FILES).map(escapeRegExp).join('|')})$)`,
        ),
        // The app has one page. Only its own URL (with any query, e.g. ?enginetest) gets the
        // cached app shell; any other navigation, such as engine/COPYING-stockfish.txt or a
        // mistyped path, goes to the precache or the network and gets the real file or a 404.
        navigateFallback: 'index.html',
        navigateFallbackAllowlist: [new RegExp(`^${escapeRegExp(base)}(?:index\\.html)?(?:\\?.*)?$`)],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    // The lazy-loaded opening book chunk (src/data/openings.json) is ~890 kB raw / ~140 kB gzipped.
    chunkSizeWarningLimit: 1024,
    // Writes the bundled packages' licences to dist/ (completed by thirdPartyLicenses()).
    license: { fileName: LICENSES_FILE },
    // Keep licence comments (/*! … */, @license) in the minified code.
    rolldownOptions: { output: { comments: { legal: true } } },
  },
});
