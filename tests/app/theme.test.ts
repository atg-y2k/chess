import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THEME, THEME_KEY, applyTheme, loadTheme, resolveTheme, saveTheme } from '../../src/theme';

/** Minimal stand-in for the bits of `document` that applyTheme touches. */
function fakeDocument() {
  const metas = [{ content: '' }, { content: '' }];
  const doc = {
    documentElement: { dataset: {} as Record<string, string> },
    querySelectorAll: () => metas,
  };
  return { doc: doc as unknown as Document, metas, dataset: doc.documentElement.dataset };
}

function memoryStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme', () => {
  it('defaults to dark, including when storage is missing or broken', () => {
    expect(DEFAULT_THEME).toBe('dark');
    vi.stubGlobal('localStorage', undefined);
    expect(loadTheme()).toBe('dark');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(loadTheme()).toBe('dark');
    vi.stubGlobal('localStorage', memoryStorage({ [THEME_KEY]: 'purple' }));
    expect(loadTheme()).toBe('dark');
  });

  it('round-trips the preference through localStorage', () => {
    const store = memoryStorage();
    vi.stubGlobal('localStorage', store);
    saveTheme('light');
    expect(store.data.get(THEME_KEY)).toBe('light');
    expect(loadTheme()).toBe('light');
    saveTheme('system');
    expect(loadTheme()).toBe('system');
  });

  it('resolves "system" from the OS setting and keeps explicit choices', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
  });

  it('applies the resolved theme to <html data-theme> and the theme-color metas', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('light') }));
    const { doc, metas, dataset } = fakeDocument();
    expect(applyTheme('system', doc)).toBe('light');
    expect(dataset.theme).toBe('light');
    expect(metas.map((m) => m.content)).toEqual(['#f4f1ec', '#f4f1ec']);
    expect(applyTheme('dark', doc)).toBe('dark');
    expect(dataset.theme).toBe('dark');
    expect(metas[0].content).toBe('#1d1c1a');
  });
});
