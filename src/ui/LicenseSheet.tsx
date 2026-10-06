/**
 * License viewer: a sheet that shows a license or notice text shipped with the app (e.g.
 * THIRD-PARTY-LICENSES.txt, engine/README.md, the GPL) in a scrollable monospace view. The About
 * section opens it instead of navigating to the file, because the App Store app cannot open its
 * own bundled files in a new window (Capacitor hands every new-window link to iOS, and only http(s)
 * links have an app to open them). The same viewer is used on the web.
 *
 * It renders into document.body: the Menu sheet that opens it is a transformed panel, which would
 * otherwise contain this `position: fixed` sheet.
 */
import { createPortal } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import { Sheet } from './Sheet';
import './LicenseSheet.css';

/** A text to show: its sheet title and how to load it (cached once loaded). */
export interface LicenseDoc {
  /** Stable key for the cache (e.g. the file's URL). */
  id: string;
  title: string;
  load: () => Promise<string>;
}

/** A text file shipped with the app, fetched on demand (same origin, so it also works offline). */
export function fileDoc(id: string, title: string, url: string): LicenseDoc {
  return {
    id,
    title,
    load: async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.text();
    },
  };
}

const cache = new Map<string, string>();

type Text = { status: 'loading' } | { status: 'ok'; text: string } | { status: 'error' };

/** Shows `doc` while it is non-null; `onClose` should set it back to null. */
export function LicenseSheet({ doc, onClose }: { doc: LicenseDoc | null; onClose: () => void }) {
  // Keep showing the last document while the sheet slides away.
  const [shown, setShown] = useState<LicenseDoc | null>(doc);
  const [text, setText] = useState<Text>({ status: 'loading' });
  useEffect(() => {
    if (doc) setShown(doc);
  }, [doc]);

  useEffect(() => {
    if (!doc) return;
    const cached = cache.get(doc.id);
    if (cached !== undefined) {
      setText({ status: 'ok', text: cached });
      return;
    }
    let live = true;
    setText({ status: 'loading' });
    doc.load().then(
      (t) => {
        cache.set(doc.id, t);
        if (live) setText({ status: 'ok', text: t });
      },
      () => live && setText({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [doc]);

  // Escape closes this sheet only, not the Menu under it (Sheet's own handler would close the
  // first sheet that registered): handled first, in the capture phase.
  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [doc, onClose]);

  if (!shown || typeof document === 'undefined') return null;
  return createPortal(
    <Sheet open={doc !== null} onClose={onClose} title={shown.title} class="license-sheet">
      <pre class="license-text" data-id="license-text" aria-busy={text.status === 'loading' ? 'true' : undefined}>
        {text.status === 'ok' ? text.text : text.status === 'loading' ? 'Loading…' : `Couldn’t load ${shown.title}.`}
      </pre>
    </Sheet>,
    document.body,
  );
}
