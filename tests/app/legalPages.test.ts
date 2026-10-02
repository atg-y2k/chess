import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEGAL_URLS } from '../../src/native/platform';

interface CheckScript {
  LEGAL_PAGES: string[];
  findPlaceholders(html: string): { line: number; text: string }[];
}

/** scripts/check-legal-pages.mjs (a plain Node script, loaded by URL). */
const loadCheck = (): Promise<CheckScript> =>
  import(/* @vite-ignore */ new URL('../../scripts/check-legal-pages.mjs', import.meta.url).href) as Promise<CheckScript>;

describe('legal pages', () => {
  it('every page the app links to is in public/ and checked before a release', async () => {
    const { LEGAL_PAGES } = await loadCheck();
    for (const url of Object.values(LEGAL_URLS)) {
      const page = `public/${url.slice(url.lastIndexOf('/') + 1)}`;
      expect(LEGAL_PAGES).toContain(page);
      expect(existsSync(new URL(`../../${page}`, import.meta.url)), page).toBe(true);
    }
  });

  it('check-legal-pages finds placeholders and the Draft notice, but not in comments', async () => {
    const { findPlaceholders } = await loadCheck();
    const html = [
      '<!-- OWNER: replace [YOUR LEGAL NAME] and',
      '  someone@example.com -->',
      '<p class="draft-notice">Draft.</p>',
      '<p>Made by [YOUR LEGAL NAME].</p>',
      '<p>Governed by [GOVERNING LAW].</p>',
      '<a href="mailto:help@example.com">help</a>',
      '<p>Made by Jane Doe, jane@janedoe.dev.</p>',
    ].join('\n');
    expect(findPlaceholders(html).map((f) => f.line)).toEqual([3, 4, 5, 6]);
    expect(findPlaceholders('<p>All done.</p>')).toEqual([]);
  });
});
