import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

// BASE_PATH is set to "/chess/" by the GitHub Pages workflow. Every URL in the app (engine,
// manifest, service worker) is relative to it, so the build also works under "/" or a custom domain.
const base = process.env.BASE_PATH ?? '/';

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

export default defineConfig({
  base,
  plugins: [
    preact(),
    appleSplashScreens(),
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
        // public/engine/ (they keep their names, so the worker finds its .wasm next to itself).
        globPatterns: ['**/*.{js,css,html,wasm,png,svg,ico,json}'],
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
        navigateFallback: 'index.html',
      },
      devOptions: { enabled: false },
    }),
  ],
  // The lazy-loaded opening book chunk (src/data/openings.json) is ~890 kB raw / ~140 kB gzipped.
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1024 },
});
