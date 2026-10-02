import { afterEach, describe, expect, it, vi } from 'vitest';
import { importAs, resetPlatform } from './helpers';

const share = vi.hoisted(() => ({ share: vi.fn(async (_options: object) => ({ activityType: '' })) }));
vi.mock('@capacitor/share', () => ({ Share: share }));
const splash = vi.hoisted(() => ({ hide: vi.fn(async (_options?: object) => {}) }));
vi.mock('@capacitor/splash-screen', () => ({ SplashScreen: splash }));

const loadShare = () => import('../../src/native/share');

afterEach(() => {
  resetPlatform();
  share.share.mockReset();
  splash.hide.mockClear();
});

describe('native share', () => {
  it('backs navigator.share with the iOS share sheet in the app only', async () => {
    const web = await importAs(loadShare, { native: false });
    const nav = {} as Navigator & { share?: (d: ShareData) => Promise<void> };
    web.installNativeShare(nav);
    expect(nav.share).toBeUndefined();

    const app = await importAs(loadShare, { native: true });
    app.installNativeShare(nav);
    expect(typeof nav.share).toBe('function');
    await nav.share!({ title: 'Chess Coach game', text: '1. e4 e5 *' });
    expect(share.share).toHaveBeenCalledWith({ title: 'Chess Coach game', text: '1. e4 e5 *', url: undefined });
  });

  it('rejects like the Web Share API: AbortError when the sheet is closed, Error otherwise', async () => {
    const { nativeShare, toShareError } = await importAs(loadShare, { native: true });
    share.share.mockRejectedValueOnce(new Error('Share canceled'));
    await expect(nativeShare({ text: 'x' })).rejects.toMatchObject({ name: 'AbortError' });
    share.share.mockRejectedValueOnce(new Error("Can't share while sharing is in progress"));
    const err = await nativeShare({ text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe('AbortError');
    expect(toShareError('Share canceled').name).toBe('AbortError');
    expect(toShareError(42).message).toBe('42');
  });
});

describe('launch screen', () => {
  it('is hidden once, and only in the app', async () => {
    const web = await importAs(() => import('../../src/native/statusbar'), { native: false });
    web.hideSplash();
    const app = await importAs(() => import('../../src/native/statusbar'), { native: true });
    app.hideSplash();
    app.hideSplash();
    await new Promise((r) => setTimeout(r, 0));
    expect(splash.hide).toHaveBeenCalledTimes(1);
  });
});
