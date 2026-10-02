/**
 * Sharing in the App Store app: the iOS share sheet through @capacitor/share
 * (UIActivityViewController).
 *
 * The PGN export (sharePgn in src/App.tsx) uses the Web Share API, `navigator.share`, and falls
 * back to the clipboard. In the native app `installNativeShare()` provides `navigator.share` on top
 * of @capacitor/share, so that code works unchanged on both platforms: closing the sheet rejects
 * with an AbortError, like Safari's, and any other failure rejects with an Error (App.tsx then
 * copies the PGN instead). On the web nothing changes.
 */
import { isNative, nativePlugins } from './platform';

type ShareFn = (data?: ShareData) => Promise<void>;

/** Shares through the native share sheet; rejects like `navigator.share` does. */
export async function nativeShare(data: ShareData = {}): Promise<void> {
  const { Share } = await nativePlugins.share();
  const { title, text, url } = data;
  try {
    await Share.share({ title, text, url });
  } catch (e) {
    throw toShareError(e);
  }
}

/**
 * Maps a @capacitor/share rejection to what `navigator.share` would throw: "Share canceled" (the
 * user closed the sheet) becomes an AbortError.
 */
export function toShareError(e: unknown): Error {
  const message = (e as { message?: unknown } | null)?.message;
  const text = typeof message === 'string' ? message : String(e);
  if (/cancel/i.test(text)) {
    return typeof DOMException === 'function'
      ? new DOMException(text, 'AbortError')
      : Object.assign(new Error(text), { name: 'AbortError' });
  }
  return e instanceof Error ? e : new Error(text);
}

/** In the native app, makes `navigator.share` open the iOS share sheet (see the module comment). */
export function installNativeShare(nav: Navigator = navigator, share: ShareFn = nativeShare): void {
  if (!isNative) return;
  Object.defineProperty(nav, 'share', { value: share, configurable: true, writable: true });
}
