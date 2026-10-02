import { afterEach, describe, expect, it } from 'vitest';
import { importAs, resetPlatform } from './helpers';

const load = () => import('../../src/native/platform');

afterEach(resetPlatform);

describe('platform', () => {
  it('the web build is the web app, even inside a Capacitor web view', async () => {
    for (const runtime of [false, true]) {
      const p = await importAs(load, { native: false, runtime });
      expect(p.nativeBuild).toBe(false);
      expect(p.isNative).toBe(false);
      expect(p.paywallEnabled).toBe(false);
    }
  });

  it('the native build is native only in the iOS app (not when opened in a browser)', async () => {
    const app = await importAs(load, { native: true });
    expect(app.nativeBuild).toBe(true);
    expect(app.isNative).toBe(true);
    expect(app.paywallEnabled).toBe(true);

    const browser = await importAs(load, { native: true, runtime: false });
    expect(browser.nativeBuild).toBe(true);
    expect(browser.isNative).toBe(false);
    expect(browser.paywallEnabled).toBe(false);
  });

  it('VITE_PAYWALL=1 turns the paywall on in the web app (for testing it)', async () => {
    const p = await importAs(load, { native: false, paywall: true });
    expect(p.isNative).toBe(false);
    expect(p.paywallEnabled).toBe(true);
  });

  it('reads Capacitor.isNativePlatform() from the native bridge global, defensively', async () => {
    const { isNativeRuntime } = await load();
    expect(isNativeRuntime({})).toBe(false);
    expect(isNativeRuntime({ Capacitor: {} })).toBe(false);
    expect(isNativeRuntime({ Capacitor: { isNativePlatform: () => false } })).toBe(false);
    expect(isNativeRuntime({ Capacitor: { isNativePlatform: () => true } })).toBe(true);
    const throwing = {
      Capacitor: {
        isNativePlatform: () => {
          throw new Error('bridge gone');
        },
      },
    };
    expect(isNativeRuntime(throwing)).toBe(false);
  });

  it('Capacitor plugins load only in the native build', async () => {
    const web = await importAs(load, { native: false });
    await expect(web.nativePlugins.haptics()).rejects.toThrow(/native build/);
    await expect(web.nativePlugins.core()).rejects.toThrow(/native build/);
    const app = await importAs(load, { native: true });
    const core = await app.nativePlugins.core();
    expect(typeof core.registerPlugin).toBe('function');
    const { Haptics } = await app.nativePlugins.haptics();
    expect(typeof Haptics.impact).toBe('function');
  });

  it('the privacy policy, terms and support pages are published with the web app', async () => {
    const { LEGAL_URLS } = await load();
    expect(LEGAL_URLS).toEqual({
      privacy: 'https://atg-y2k.github.io/chess/privacy.html',
      terms: 'https://atg-y2k.github.io/chess/terms.html',
      support: 'https://atg-y2k.github.io/chess/support.html',
    });
  });

  it('About links them wherever Pro is sold (App Review: a privacy link that is always reachable)', async () => {
    const about = () => import('../../src/ui/About');
    expect((await importAs(about, { native: true })).SHOW_LEGAL_LINKS).toBe(true);
    expect((await importAs(about, { native: false, paywall: true })).SHOW_LEGAL_LINKS).toBe(true);
    expect((await importAs(about, { native: false })).SHOW_LEGAL_LINKS).toBe(false);
  });

  it('names and versions the app (from vite.config.ts; defaults in tests)', async () => {
    const p = await importAs(load, { native: false });
    expect(p.APP_NAME).toBe('Chess Coach');
    expect(p.APP_VERSION).toBe('');
  });
});
