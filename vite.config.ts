import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { APP_ID, APP_NAME } from './capacitor.config.js';

/**
 * VITE_NATIVE=1 (`npm run build:native`, into dist-native/): the App Store app (Capacitor, see
 * ios/README-native.md). Its files ship inside the app and are served from capacitor://localhost/,
 * so base is '/', and there is no service worker, update logic or web app manifest (vite-plugin-pwa
 * is left out). The PWA build (without VITE_NATIVE) is unaffected.
 */
const native = process.env.VITE_NATIVE === '1';

// BASE_PATH is set to "/chess/" by the GitHub Pages workflow. Every URL in the app (engine,
// manifest, service worker) is relative to it, so the build also works under "/" or a custom domain.
const base = native ? '/' : (process.env.BASE_PATH ?? '/');

/** The app version (package.json): shown in About; the App Store version (MARKETING_VERSION). */
const VERSION = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** The repository. Every App Store build is tagged there (see ios/README-native.md, "Releasing"). */
const REPO_URL = 'https://github.com/atg-y2k/chess';

/** Runs git in this repository; null when git or the repository is not available (e.g. a source archive). */
function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Native build only: the commit the App Store app is built from (null outside a git checkout). */
const COMMIT = native ? git('rev-parse', 'HEAD') : null;

/** Native build only: the work tree differs from COMMIT (changed or new, not ignored, files). */
const DIRTY = COMMIT !== null && git('status', '--porcelain') !== '';

/**
 * Where users of the deployed app can get its source code (the GPL requires offering it; see
 * README "Hosting"): the repository for the web app, which is deployed from main, and for the App
 * Store app the exact commit it was built from (`tree/<sha>`; the release workflow also tags it
 * `ios-v<version>-b<build>` and passes that tag here, so it stays reachable). Override it with
 * VITE_SOURCE_URL, e.g. for a source archive published next to the app (`npm run build:source`).
 * The app reads it as import.meta.env.VITE_SOURCE_URL.
 */
const SOURCE_URL =
  process.env.VITE_SOURCE_URL || (native ? `${REPO_URL}/tree/${COMMIT ?? `v${VERSION}`}` : REPO_URL);

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
 * built outside the Vite bundle so Vite does not list it. The native build has no service worker;
 * instead it lists Capacitor's native iOS code, which is not part of the JavaScript bundle either.
 */
function thirdPartyLicenses(): Plugin {
  const header = `${APP_NAME}: licences of the software it includes

${APP_NAME} is free software: you can redistribute it and/or modify it under the terms of the GNU
General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. It comes with ABSOLUTELY NO WARRANTY.
Source code: ${SOURCE_URL}

The chess engine in engine/ is Stockfish (Stockfish.js): GPL-3.0. engine/README.md says where
its source is, and engine/COPYING-stockfish.txt is the GPL-3.0 text (it applies to the app too).

${
  native
    ? `The app's JavaScript includes the packages below. The iOS app around it is built with Capacitor:
its native code (@capacitor/ios and the native parts of the @capacitor plugins below) is listed last.`
    : `The app's JavaScript includes the packages below. The service worker (sw.js, workbox-*.js) is
built from the Workbox packages listed last.`
}
`;
  const packageDir = (name: string): string => dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
  const workboxNotice = (): string => {
    // The service-worker runtime packages all carry workbox-core's licence and version.
    const dir = packageDir('workbox-core');
    const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string };
    const license = readFileSync(join(dir, 'LICENSE'), 'utf8').trim();
    return `\n## workbox-core, workbox-precaching, workbox-routing, workbox-strategies - ${version} (MIT)\n\n${license}\n`;
  };
  const capacitorNotice = (): string => {
    const dir = packageDir('@capacitor/ios');
    const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string };
    const license = readFileSync(join(dir, 'LICENSE'), 'utf8').trim();
    // Capacitor's Cordova compatibility layer (CapacitorCordova, linked into the app) contains code
    // from Apache Cordova. TypeScript (needed to build) ships the same Apache-2.0 text.
    let apache = 'The full text is at https://www.apache.org/licenses/LICENSE-2.0';
    try {
      apache = readFileSync(join(packageDir('typescript'), 'LICENSE'), 'utf8').trim();
    } catch {
      // keep the link
    }
    return (
      `\n## @capacitor/ios (Capacitor and CapacitorCordova for iOS) - ${version} (MIT)\n\n${license}\n` +
      '\nCapacitorCordova includes code from Apache Cordova, Copyright The Apache Software Foundation,\n' +
      'licensed under the Apache License, Version 2.0. This product includes software developed at\n' +
      `The Apache Software Foundation (https://www.apache.org/).\n\n${apache}\n`
    );
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
        file.source =
          header + text.replace(/^# Licenses\s+The app bundles[^\n]*\n/, '') + (native ? capacitorNotice() : workboxNotice());
      },
    },
  };
}

/**
 * Native build only: the source link must match what is built (GPL-3.0 section 6, and Stockfish's
 * "the exact binary" condition). A build from uncommitted changes (whatever VITE_SOURCE_URL says), or
 * outside a git checkout without VITE_SOURCE_URL, gets a warning, and fails with RELEASE_BUILD=1
 * (`npm run build:native:release`, and the release workflow), which every build that is uploaded to
 * App Store Connect must use.
 */
function sourceMatchesBuild(): Plugin {
  return {
    name: 'chess-coach:source-matches-build',
    apply: 'build',
    buildStart() {
      // Outside a git checkout, an explicit VITE_SOURCE_URL (e.g. a source archive) is trusted.
      if (COMMIT === null ? !!process.env.VITE_SOURCE_URL : !DIRTY) return;
      const why = COMMIT === null ? 'this is not a git checkout' : 'the work tree has uncommitted changes';
      const message =
        `About links to the source at ${SOURCE_URL}, but ${why}, so that source would not match this build. ` +
        'Commit (and push) first.';
      if (process.env.RELEASE_BUILD === '1') this.error(`${message} (RELEASE_BUILD=1)`);
      this.warn(`${message} Fine for testing; never upload this build (uploads use npm run build:native:release).`);
    },
  };
}

/**
 * Native build only: copies the app's identity into the Xcode project, so each value has one home:
 * the bundle ID and the Home Screen name come from capacitor.config.ts (APP_ID, APP_NAME), the
 * version from package.json. Rewrites PRODUCT_BUNDLE_IDENTIFIER and MARKETING_VERSION in
 * ios/App/App.xcodeproj/project.pbxproj and CFBundleDisplayName in ios/App/App/Info.plist when they
 * differ (and says so), so a rename or a version bump is one edit plus `npm run build:native`.
 */
function nativeProjectSettings(): Plugin {
  /** The App target's build configurations (Debug, Release) in project.pbxproj. */
  const APP_TARGET_CONFIGS = ['504EC3171FED79650016851F', '504EC3181FED79650016851F'];
  const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const update = (file: string, edit: (text: string) => string): boolean => {
    const path = fileURLToPath(new URL(file, import.meta.url));
    if (!existsSync(path)) return false;
    const before = readFileSync(path, 'utf8');
    const after = edit(before);
    if (after === before) return false;
    writeFileSync(path, after);
    return true;
  };
  return {
    name: 'chess-coach:native-project-settings',
    apply: 'build',
    buildStart() {
      if (
        update('./ios/App/App.xcodeproj/project.pbxproj', (t) =>
          // Only in the App target's Debug and Release configurations (IDs from Capacitor's template),
          // so another target (tests, an extension) keeps its own bundle ID.
          APP_TARGET_CONFIGS.reduce((text, id) => {
            const start = text.indexOf(`\t\t${id} /* `);
            const end = start < 0 ? -1 : text.indexOf('\n\t\t};', start);
            if (end < 0) {
              this.warn(`Build configuration ${id} not found in project.pbxproj; bundle ID and version not updated.`);
              return text;
            }
            const block = text
              .slice(start, end)
              .replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/, `PRODUCT_BUNDLE_IDENTIFIER = ${APP_ID};`)
              .replace(/MARKETING_VERSION = [^;]+;/, `MARKETING_VERSION = ${VERSION};`);
            return text.slice(0, start) + block + text.slice(end);
          }, t),
        )
      ) {
        this.warn(`Updated ios/App/App.xcodeproj/project.pbxproj: bundle ID ${APP_ID}, version ${VERSION}.`);
      }
      if (
        update('./ios/App/App/Info.plist', (t) =>
          t.replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${xmlEscape(APP_NAME)}$2`),
        )
      ) {
        this.warn(`Updated ios/App/App/Info.plist: display name "${APP_NAME}".`);
      }
    },
  };
}

/** Files in public/ that only the web app uses (Home Screen icons, launch images, the icon master). */
const WEB_ONLY_FILES = /^(?:splash|pwa-[^/]*\.png|maskable-[^/]*\.png|icon-source\.svg)$/;

/**
 * Native build only: the virtual modules vite-plugin-pwa would provide (src/pwa.ts imports
 * virtual:pwa-register; main.tsx never calls it in this build), and removal of the web-only files
 * from the output, which Vite copies from public/ (the app has its own icon and launch screen).
 */
function nativeBuild(): Plugin {
  const PWA_REGISTER = 'virtual:pwa-register';
  let outDir = '';
  return {
    name: 'chess-coach:native-build',
    resolveId(id) {
      return id === PWA_REGISTER ? `\0${PWA_REGISTER}` : null;
    },
    load(id) {
      // The same signature as vite-plugin-pwa's registerSW(), doing nothing.
      return id === `\0${PWA_REGISTER}` ? 'export function registerSW() { return async () => {}; }' : null;
    },
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (!outDir || !existsSync(outDir)) return;
      for (const name of readdirSync(outDir)) {
        if (WEB_ONLY_FILES.test(name)) rmSync(join(outDir, name), { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig({
  base,
  plugins: [
    preact(),
    ...(native ? [] : [appleSplashScreens()]),
    immutableEngineFiles(),
    thirdPartyLicenses(),
    ...(native ? [sourceMatchesBuild(), nativeBuild(), nativeProjectSettings()] : []),
    // The service worker (offline + updates, see src/pwa.ts) and the web app manifest: web build only.
    native ? null : VitePWA({
      strategies: 'generateSW',
      // New builds activate straight away; src/pwa.ts decides when the page reloads onto them.
      registerType: 'autoUpdate',
      // Registered by registerServiceWorker() in src/pwa.ts (virtual:pwa-register), not a script tag.
      injectRegister: false,
      // public/ files are precached by globPatterns below; including the icons again would only
      // add duplicate precache entries.
      includeManifestIcons: false,
      manifest: {
        // The app's identity: the absolute base path, e.g. /chess/. Unlike start_url and scope, id
        // is resolved against the origin, not the manifest URL, so '.' or './' would mean the
        // origin root and clash with any other app there (e.g. a user site on atg-y2k.github.io).
        // Changing it later makes a different app for existing installs.
        id: base,
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
  // The app's name (capacitor.config.ts), version (package.json) and source link (SOURCE_URL), for
  // src/native/platform.ts and src/ui/About.tsx.
  define: {
    'import.meta.env.VITE_APP_NAME': JSON.stringify(APP_NAME),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(VERSION),
    'import.meta.env.VITE_SOURCE_URL': JSON.stringify(SOURCE_URL),
  },
  build: {
    target: 'es2022',
    outDir: native ? 'dist-native' : 'dist',
    // Source maps would add ~2.4 MB to the app bundle; the source is on GitHub (see SOURCE_URL).
    sourcemap: !native,
    // The lazy-loaded opening book chunk (src/data/openings.json) is ~890 kB raw / ~140 kB gzipped.
    chunkSizeWarningLimit: 1024,
    // Writes the bundled packages' licences to dist/ (completed by thirdPartyLicenses()).
    license: { fileName: LICENSES_FILE },
    // Keep licence comments (/*! … */, @license) in the minified code.
    rolldownOptions: { output: { comments: { legal: true } } },
  },
});
