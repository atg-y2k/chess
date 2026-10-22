/**
 * Board and piece skins (src/ui/skins.ts, src/ui/skins.css): the catalogs against the files that
 * ship (12 safe SVGs per set, byte for byte lila's, with credits, the copyright notice where the
 * license asks for it and an allowed license; the sets excluded for their licenses), the CSS against the
 * catalogs, every board theme's contrast against both squares, and the stored choice (persistence,
 * fallback to the defaults for an unknown or removed id).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOVE_CLASS_ORDER } from '../../src/analysis/types';
import { ARROW_HEX, ARROW_STYLE, DRAW_HEX, DRAW_STYLE } from '../../src/ui/Board';
import {
  BOARD_KEY,
  BOARD_THEMES,
  DEFAULT_BOARD,
  DEFAULT_PIECES,
  LILA_COMMIT,
  PIECES_KEY,
  PIECE_FILES,
  PIECE_SETS,
  SKIN_LICENSES,
  applySkins,
  boardTheme,
  chooseBoardTheme,
  choosePieceSet,
  initSkins,
  isBoardTheme,
  isPieceSet,
  loadBoardTheme,
  loadPieceSet,
  pieceSet,
} from '../../src/ui/skins';

const ROOT = join(__dirname, '../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const SKINS_CSS = read('src/ui/skins.css');
const APP_CSS = read('src/styles/app.css');
const BOARD_CSS = read('src/ui/Board.css');

/** Where a set's files are: public/pieces/<id>/, or the inlined default's src/ui/pieces/<id>/. */
const setDir = (set: (typeof PIECE_SETS)[number]): string =>
  join(ROOT, 'inline' in set ? `src/ui/pieces/${set.id}` : `public/pieces/${set.id}`);

describe('piece set catalog', () => {
  it('has unique ids, the default first, and only allowed licenses', () => {
    const ids = PIECE_SETS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(DEFAULT_PIECES);
    expect(PIECE_SETS.filter((s) => 'inline' in s).map((s) => s.id)).toEqual([DEFAULT_PIECES]);
    // Commercial use allowed and compatible with GPL-3.0-or-later: never NC, ND, AGPL or unknown.
    expect(Object.keys(SKIN_LICENSES).sort()).toEqual(
      ['Apache-2.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0-1.0', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'MIT'].sort(),
    );
    for (const s of PIECE_SETS) {
      expect(SKIN_LICENSES[s.license], s.id).toBeDefined();
      expect(s.license).not.toMatch(/NC|ND|AGPL/);
      expect(s.name.trim()).not.toBe('');
      expect(s.author.trim()).not.toBe('');
      expect(s.source).toMatch(/^https:\/\//);
      if ('upstream' in s) expect(s.upstream).toMatch(/^https:\/\//);
      if ('upstreamCommit' in s) expect(s.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
      // Apache-2.0 4(c): the work's copyright notice is kept (upstream has it in COPYRIGHT.txt).
      if (s.license === 'Apache-2.0') expect('copyright' in s, s.id).toBe(true);
      if (!('inline' in s)) expect(s.source).toContain(LILA_COMMIT);
    }
  });

  it.each(PIECE_SETS.map((s) => [s.id, s] as const))('%s: 12 safe SVGs and nothing else, credited, as lila ships them', (id, set) => {
    const dir = setDir(set);
    const files = readdirSync(dir).sort();
    const svgs = PIECE_FILES.map((f) => `${f}.svg`);
    const extra = ['README.md', ...('licenseFile' in set ? ['LICENSE.txt'] : []), ...('copyrightFile' in set ? ['COPYRIGHT.txt'] : [])];
    expect(files).toEqual([...svgs, ...extra].sort());
    const readme = readFileSync(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain(set.author);
    expect(readme).toContain(set.license);
    if (!('inline' in set)) {
      expect(readme).toContain(LILA_COMMIT);
      expect(readme).toContain(`public/piece/${id}`);
      // lila's copies are optimized from the artists' files (CC BY 4.0 3(a)(1)(B), Apache-2.0 4(b)):
      // the README says so, and that the app changed nothing more. Never "unmodified".
      expect(readme).toContain('lila prepares the\n  artist\'s SVGs for the web');
      expect(readme).toContain('made no further changes');
      expect(readme).not.toMatch(/\bunmodified\b/);
    }
    if ('upstream' in set) expect(readme).toContain(set.upstream);
    if ('upstreamCommit' in set) expect(readme).toContain(set.upstreamCommit);
    if ('copyright' in set) expect(readme).toContain(set.copyright);
    // Upstream's copyright file, byte for byte.
    if ('copyrightFile' in set) expect(readFileSync(join(dir, 'COPYRIGHT.txt'), 'utf8')).toBe(set.copyright);
    // CC BY and CC BY-SA: the attribution, the license link, and a note of the changes.
    if (SKIN_LICENSES[set.license].name.startsWith('CC BY')) {
      expect(readme).toMatch(/Attribution: .+ by /);
      expect(readme).toContain('Changes: ');
      expect(readme).toContain(SKIN_LICENSES[set.license].url);
    }
    for (const f of svgs) {
      const bytes = readFileSync(join(dir, f));
      const svg = bytes.toString('utf8');
      expect(statSync(join(dir, f)).size, f).toBeLessThan(16 * 1024);
      expect(svg.trimStart().startsWith('<svg'), f).toBe(true);
      // No scripts, event handlers, embedded documents or images, or anything fetched from elsewhere.
      expect(svg, f).not.toMatch(/<script|<foreignObject|<image|<!ENTITY|<!DOCTYPE|@import|\son[a-z]+=/i);
      expect(svg.replace(/xmlns(:xlink)?="http:\/\/www\.w3\.org\/[^"]+"/g, ''), f).not.toMatch(/https?:|data:/);
      for (const href of svg.matchAll(/(?:xlink:)?href="([^"]*)"/g)) expect(href[1].startsWith('#'), f).toBe(true);
      // The README records each file's hash: the files are the ones at the source, byte for byte.
      expect(readme, f).toContain(`${createHash('sha256').update(bytes).digest('hex')}  ${f}`);
    }
    // Black pieces with no light detail (under 2:1 against the dark theme's background) are flagged:
    // off the board they get a light chip on dark surfaces (--piece-chip), or they would vanish.
    const lightest = Math.max(...PIECE_FILES.filter((f) => f[0] === 'b').map((f) => lightestColor(readFileSync(join(dir, `${f}.svg`), 'utf8'))));
    expect('silhouette' in set, `${id}: lightest black color ${lightest.toFixed(3)}`).toBe(ratioL(lightest, luminance(hex(appToken('--bg')))) < 2);
    if ('licenseFile' in set) {
      const text = readFileSync(join(dir, 'LICENSE.txt'), 'utf8');
      expect(text).toContain(set.license === 'MIT' ? 'MIT License' : 'Apache License');
      if (set.license === 'MIT') expect(text).toContain(`Copyright (c) ${set.author}`);
    }
  });

  // Out for their licenses (docs/APP_STORE.md section 15): merida (its artist distributes it as
  // freeware; lila's GPLv2+ row links no grant), totoy and papercut (lila's non-free exceptions),
  // letter, pirouetti and pixel (AGPL).
  const EXCLUDED = ['merida', 'totoy', 'papercut', 'letter', 'pirouetti', 'pixel'];

  it.each(EXCLUDED.map((id) => [id] as const))('never ships %s, and a stored choice of it falls back to Classic', (id) => {
    expect(isPieceSet(id)).toBe(false);
    expect(existsSync(join(ROOT, `public/pieces/${id}`))).toBe(false);
    expect(SKINS_CSS).not.toContain(`/pieces/${id}/`);
    expect(SKINS_CSS).not.toContain(`[data-pieces='${id}']`);
    vi.stubGlobal('localStorage', memoryStorage({ [PIECES_KEY]: id }));
    expect(loadPieceSet()).toBe(DEFAULT_PIECES);
  });

  it('puts a silhouette set\'s black pieces on a light chip, on dark surfaces only', () => {
    for (const set of PIECE_SETS) {
      const rule = `:root:not([data-theme='light'])[data-pieces='${set.id}'] {\n  --piece-chip: `;
      expect(SKINS_CSS.includes(rule), set.id).toBe('silhouette' in set);
    }
    expect(SKINS_CSS).toMatch(/:root \{\n  --piece-chip: transparent;\n\}/);
    expect(read('src/ui/PlayerStrip.css')).toMatch(/\.pstrip-group:has\(> \.pstrip-piece\[data-p\^='b'\]\) \{[^}]*background: var\(--piece-chip\);/);
    expect(read('src/ui/NewGameSheet.css')).toMatch(/\.king-glyph-piece\[data-p='bk'\] \{[^}]*background-color: var\(--piece-chip\);/);
  });

  it('ships no piece set that is not in the catalog', () => {
    expect(readdirSync(join(ROOT, 'public/pieces')).sort()).toEqual(
      PIECE_SETS.filter((s) => !('inline' in s))
        .map((s) => s.id)
        .sort(),
    );
  });
});

/** The rule blocks of skins.css whose selector names `attr='<id>'`, as id -> declarations (all its blocks'). */
function blocks(attr: 'data-board' | 'data-pieces'): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const m of SKINS_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const ids = [...m[1].matchAll(new RegExp(`\\[${attr}='([\\w-]+)'\\]`, 'g'))].map((x) => x[1]);
    if (!ids.length) continue;
    const decls = new Map<string, string>();
    for (const d of m[2].replace(/\/\*[\s\S]*?\*\//g, '').split(/;\s*\n/)) {
      const i = d.indexOf(':');
      if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim().replace(/;$/, ''));
    }
    for (const id of new Set(ids)) out.set(id, new Map([...(out.get(id) ?? []), ...decls]));
  }
  return out;
}

describe('skins.css', () => {
  it('maps the 12 pieces of every set, and of no other', () => {
    const sets = blocks('data-pieces');
    expect([...sets.keys()].sort()).toEqual(PIECE_SETS.map((s) => s.id).sort());
    for (const set of PIECE_SETS) {
      const decls = sets.get(set.id)!;
      const pieces = [...decls.keys()].filter((k) => /^--piece-[wb][kqrbnp]$/.test(k));
      expect(pieces.sort(), set.id).toEqual(PIECE_FILES.map((f) => `--piece-${f.toLowerCase()}`).sort());
      for (const f of PIECE_FILES) {
        const url = 'inline' in set ? `./pieces/${set.id}/${f}.svg` : `/pieces/${set.id}/${f}.svg`;
        expect(decls.get(`--piece-${f.toLowerCase()}`)).toBe(`url('${url}')`);
      }
    }
    // The default is also :root's.
    expect(SKINS_CSS).toMatch(new RegExp(`:root,\\s*\\[data-pieces='${DEFAULT_PIECES}'\\]`));
  });

  it('draws every piece from its variable, on the board and outside it', () => {
    const roles: Record<string, string> = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };
    for (const f of PIECE_FILES) {
      const v = `var(--piece-${f.toLowerCase()})`;
      const color = f[0] === 'w' ? 'white' : 'black';
      expect(SKINS_CSS).toContain(`.cg-wrap piece.${roles[f[1]]}.${color} {\n  background-image: ${v};`);
      expect(SKINS_CSS).toContain(`.piece-art[data-p='${f.toLowerCase()}'] {\n  background-image: ${v};`);
    }
  });

  it('has a block for every board theme (with its squares and texture), and no other', () => {
    const themes = blocks('data-board');
    expect([...themes.keys()].sort()).toEqual(BOARD_THEMES.map((t) => t.id).sort());
    for (const t of BOARD_THEMES) {
      const d = themes.get(t.id)!;
      for (const k of ['--board-light', '--board-dark', '--board-texture']) expect(d.has(k), `${t.id} ${k}`).toBe(true);
      // A texture's mean color and coverage are in the catalog (the contrast test composites them).
      expect(d.get('--board-texture') !== 'none', t.id).toBe('texture' in t);
    }
    expect(SKINS_CSS).toMatch(new RegExp(`:root,\\s*\\[data-board='${DEFAULT_BOARD}'\\]`));
  });

  it('keeps the default green board exactly as it was', () => {
    const green = blocks('data-board').get('green')!;
    expect(green.get('--board-light')).toBe('#eeeed2');
    expect(green.get('--board-dark')).toBe('#769656');
    expect(green.get('--board-last')).toBe('color-mix(in srgb, var(--warning) 52%, transparent)');
    expect(green.get('--board-selected')).toBe('color-mix(in srgb, var(--warning) 62%, transparent)');
    expect(green.get('--board-dot')).toBe('rgba(0, 0, 0, 0.17)');
    expect(green.get('--board-check')).toBe('var(--danger)');
    expect(green.get('--board-coord-on-light')).toBe('var(--board-dark)');
    expect(green.get('--board-coord-on-dark')).toBe('var(--board-light)');
    expect(green.get('--arrow-line')).toBe(ARROW_HEX.line);
  });
});

// ---------------------------------------------------------------- contrast

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (c: RGB): number => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
/** WCAG contrast ratio of two luminances. */
const ratioL = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/** The luminance of the lightest color an SVG paints (fill, stroke, gradient stops; unset fill is black). */
function lightestColor(svg: string): number {
  const named: Record<string, string> = { black: '#000000', white: '#ffffff' };
  const colors = [...svg.matchAll(/(?:fill|stroke|stop-color)(?:="|:\s*)([^";)}<\s]+)/g)].map((m) => m[1].trim()).filter((c) => c !== 'none' && !c.startsWith('url('));
  return Math.max(
    0,
    ...colors.map((c) => {
      const h = named[c] ?? c;
      // Only the color syntaxes the shipped sets use; anything else fails here rather than being skipped.
      if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h)) throw new Error(`unparsed color ${c}`);
      const six = h.length === 4 ? `#${[...h.slice(1)].map((x) => x + x).join('')}` : h;
      return luminance(hex(six));
    }),
  );
}
/** WCAG contrast ratio. */
function ratio(a: RGB, b: RGB): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** `top` at `alpha` over `bottom`, as color-mix(in srgb) and the browser composite it. */
const over = (top: RGB, alpha: number, bottom: RGB): RGB => top.map((c, i) => c * alpha + bottom[i] * (1 - alpha)) as RGB;
function lab(c: RGB): RGB {
  const [r, g, b] = c.map(lin);
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
/** CIEDE2000 color difference (about 2: just noticeable; 10 and more: plainly different). */
function deltaE(c1: RGB, c2: RGB): number {
  const [L1, a1, b1] = lab(c1);
  const [L2, a2, b2] = lab(c2);
  const rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const [a1p, a2p] = [a1 * (1 + G), a2 * (1 + G)];
  const [C1, C2] = [Math.hypot(a1p, b1), Math.hypot(a2p, b2)];
  const hue = (x: number, y: number): number => ((Math.atan2(y, x) / rad) % 360 + 360) % 360;
  const [h1, h2] = [hue(a1p, b1), hue(a2p, b2)];
  let dh = C1 * C2 === 0 ? 0 : h2 - h1;
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad);
  const Lb = (L1 + L2) / 2;
  const Cbp = (C1 + C2) / 2;
  let hb = h1 + h2;
  if (C1 * C2 !== 0) hb = Math.abs(h1 - h2) > 180 ? (h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2) : (h1 + h2) / 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * 30 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad) * Rc;
  return Math.sqrt(((L2 - L1) / Sl) ** 2 + ((C2 - C1) / Sc) ** 2 + (dH / Sh) ** 2 + Rt * ((C2 - C1) / Sc) * (dH / Sh));
}

/** A token of app.css's :root. */
const appToken = (name: string): string => APP_CSS.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))![1];

/** A theme's tokens (the defaults, then its own), each as a color and the alpha it is drawn with. */
function themeColors(id: string): (name: string) => { rgb: RGB; alpha: number } {
  const themes = blocks('data-board');
  const tokens = new Map([...themes.get(DEFAULT_BOARD)!, ...themes.get(id)!]);
  const resolve = (value: string): { rgb: RGB; alpha: number } => {
    let m: RegExpMatchArray | null;
    if ((m = value.match(/^#[0-9a-f]{6}$/i))) return { rgb: hex(value), alpha: 1 };
    if ((m = value.match(/^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/))) {
      return { rgb: [+m[1] / 255, +m[2] / 255, +m[3] / 255], alpha: +m[4] };
    }
    if ((m = value.match(/^color-mix\(in srgb, (.+) (\d+)%, transparent\)$/))) {
      const c = resolve(m[1]);
      return { rgb: c.rgb, alpha: (c.alpha * +m[2]) / 100 };
    }
    if ((m = value.match(/^var\((--[\w-]+)\)$/))) return tokens.has(m[1]) ? resolve(tokens.get(m[1])!) : resolve(appToken(m[1]));
    throw new Error(`${id}: can't resolve ${value}`);
  };
  return (name) => resolve(tokens.get(name)!);
}

describe('board theme contrast', () => {
  // The floors are the default green board's: its coordinates (2.84:1) and its best-move arrow
  // (CIEDE2000 9.2 from the dark square, the least visible thing it draws).
  const ARROWS = [
    ...(['best', 'alt', 'threat', 'played'] as const).map((k) => ({ name: k, color: appToken(`--arrow-${k}`), alpha: ARROW_STYLE[k].opacity })),
    ...(Object.keys(DRAW_HEX) as (keyof typeof DRAW_HEX)[]).map((k) => ({ name: `draw-${k}`, color: appToken(`--draw-${k}`), alpha: DRAW_STYLE.opacity })),
  ];

  it('uses the arrow colors app.css defines', () => {
    for (const k of ['best', 'alt', 'threat', 'played'] as const) expect(appToken(`--arrow-${k}`)).toBe(ARROW_HEX[k]);
    for (const k of Object.keys(DRAW_HEX) as (keyof typeof DRAW_HEX)[]) expect(appToken(`--draw-${k}`)).toBe(DRAW_HEX[k]);
  });

  it('tints a coached move in the board theme\'s color for its class, on green as before', () => {
    const green = blocks('data-board').get(DEFAULT_BOARD)!;
    for (const c of MOVE_CLASS_ORDER) {
      expect(BOARD_CSS).toContain(`.board cg-board square.cls-${c} { background-color: var(--board-cls-${c}); }`);
      expect(green.get(`--board-cls-${c}`)).toBe(`color-mix(in srgb, var(--cls-${c}) 55%, transparent)`);
    }
  });

  /** The squares as drawn: the tokens, with the theme's texture (its mean color and coverage) over them. */
  const squaresOf = (id: string): [RGB, RGB] => {
    const token = themeColors(id);
    const theme = BOARD_THEMES.find((t) => t.id === id)!;
    const tex = 'texture' in theme ? theme.texture : null;
    const drawn = (c: RGB): RGB => (tex ? over(hex(tex.color), tex.alpha, c) : c);
    return [drawn(token('--board-light').rgb), drawn(token('--board-dark').rgb)];
  };
  /** How far `name` (drawn over each square) stands out: from that square, and from the other one. */
  const standOut = (id: string, name: string): { same: number; cross: number } => {
    const c = themeColors(id)(name);
    const [light, dark] = squaresOf(id);
    const [onLight, onDark] = [over(c.rgb, c.alpha, light), over(c.rgb, c.alpha, dark)];
    return {
      same: Math.min(deltaE(onLight, light), deltaE(onDark, dark)),
      // A highlighted light square must not pass for a plain dark one, nor the other way round.
      cross: Math.min(deltaE(onLight, dark), deltaE(onDark, light)),
    };
  };

  /** The green board's coordinate contrast (2.84:1, the same on both squares). */
  const green = themeColors(DEFAULT_BOARD);
  const COORDS = ratio(green('--board-coord-on-light').rgb, green('--board-light').rgb) - 1e-9;
  /** The two squares apart: at least the palest designed board's (Ice, CIEDE2000 14.2). */
  const SEPARATION = 14;

  it.each(BOARD_THEMES.map((t) => [t.id] as const))('%s: squares, coordinates, dots, highlights, coach tints and arrows show as drawn', (id) => {
    const token = themeColors(id);
    const [light, dark] = squaresOf(id);
    // The checkerboard itself, texture included.
    expect(deltaE(light, dark), 'light vs dark').toBeGreaterThanOrEqual(SEPARATION);
    // Coordinates (small bold text) on their square.
    expect(COORDS).toBeCloseTo(2.84, 2);
    expect(ratio(token('--board-coord-on-light').rgb, light), 'coordinates on light').toBeGreaterThanOrEqual(COORDS);
    expect(ratio(token('--board-coord-on-dark').rgb, dark), 'coordinates on dark').toBeGreaterThanOrEqual(COORDS);
    // Move dots and capture rings, over the square.
    expect(standOut(id, '--board-dot').same, 'dots').toBeGreaterThanOrEqual(8.5);
    // The last move, the selected square and check stand out from the square (and the last move and
    // selection never pass for the other square).
    for (const name of ['--board-last', '--board-selected', '--board-check']) {
      expect(standOut(id, name).same, name).toBeGreaterThanOrEqual(12);
    }
    for (const name of ['--board-last', '--board-selected']) expect(standOut(id, name).cross, name).toBeGreaterThanOrEqual(12);
    // The coach's tint of a classified last move (it replaces --board-last): at least as visible as on
    // the green board, up to 12, and never passing for the other square.
    for (const c of MOVE_CLASS_ORDER) {
      const name = `--board-cls-${c}`;
      const floor = Math.min(standOut(DEFAULT_BOARD, name).same, 12) - 1e-9;
      expect(standOut(id, name).same, name).toBeGreaterThanOrEqual(floor);
      expect(standOut(id, name).cross, name).toBeGreaterThanOrEqual(12);
    }
    for (const sq of [light, dark]) {
      // The engine's arrows, the player's drawings and the opening line's guide.
      for (const a of ARROWS) {
        const min = a.name === 'threat' ? 12 : 9;
        expect(deltaE(over(hex(a.color), a.alpha, sq), sq), a.name).toBeGreaterThanOrEqual(min);
      }
      const line = token('--arrow-line');
      expect(deltaE(over(line.rgb, ARROW_STYLE.line.opacity, sq), sq), 'line').toBeGreaterThanOrEqual(9);
    }
  });

  it('composites the textures: Wood and Marble as drawn, not as their tokens', () => {
    // Regression: Wood's grain once covered its squares at about 55%, so the board drawn was far
    // darker than its tokens (coordinates 2:1 on the light squares) while this test passed.
    const wood = squaresOf('wood');
    expect(deltaE(wood[0], hex('#e5c99c'))).toBeLessThan(1.5);
    expect(deltaE(wood[1], hex('#ad7948'))).toBeLessThan(1.5);
    for (const t of BOARD_THEMES) if ('texture' in t) expect(t.texture.alpha, t.id).toBeLessThanOrEqual(0.2);
  });
});

// ---------------------------------------------------------------- the stored choice

function memoryStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}
const fakeRoot = () => ({ dataset: {} as Record<string, string> }) as unknown as HTMLElement;

afterEach(() => {
  vi.unstubAllGlobals();
  boardTheme.value = DEFAULT_BOARD;
  pieceSet.value = DEFAULT_PIECES;
});

describe('stored skins', () => {
  it('default to the green board and the Classic pieces, also without storage', () => {
    expect([DEFAULT_BOARD, DEFAULT_PIECES]).toEqual(['green', 'cburnett']);
    expect(BOARD_THEMES[0].id).toBe(DEFAULT_BOARD);
    vi.stubGlobal('localStorage', undefined);
    expect([loadBoardTheme(), loadPieceSet()]).toEqual(['green', 'cburnett']);
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect([loadBoardTheme(), loadPieceSet()]).toEqual(['green', 'cburnett']);
    const root = fakeRoot();
    chooseBoardTheme('wood', root); // storage throws: still applied for this session
    expect(root.dataset.board).toBe('wood');
    expect(boardTheme.value).toBe('wood');
  });

  it('fall back to the default for an unknown or removed id', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [BOARD_KEY]: 'plaid', [PIECES_KEY]: 'pixel' }));
    expect([loadBoardTheme(), loadPieceSet()]).toEqual(['green', 'cburnett']);
    const root = fakeRoot();
    initSkins(root);
    expect(root.dataset).toEqual({ board: 'green', pieces: 'cburnett' });
    expect(isBoardTheme('plaid') || isPieceSet('pixel') || isPieceSet('__proto__') || isBoardTheme(undefined)).toBe(false);
  });

  it('are stored, applied to <html data-board data-pieces> and published', () => {
    const store = memoryStorage();
    vi.stubGlobal('localStorage', store);
    const root = fakeRoot();
    chooseBoardTheme('marble', root);
    choosePieceSet('chessnut', root);
    expect(store.data.get(BOARD_KEY)).toBe('marble');
    expect(store.data.get(PIECES_KEY)).toBe('chessnut');
    expect(root.dataset).toEqual({ board: 'marble', pieces: 'chessnut' });
    expect([boardTheme.value, pieceSet.value]).toEqual(['marble', 'chessnut']);
    // The next start reads them back (main.tsx calls initSkins before the first render).
    boardTheme.value = DEFAULT_BOARD;
    pieceSet.value = DEFAULT_PIECES;
    const next = fakeRoot();
    initSkins(next);
    expect(next.dataset).toEqual({ board: 'marble', pieces: 'chessnut' });
    expect([loadBoardTheme(), loadPieceSet()]).toEqual(['marble', 'chessnut']);
    applySkins('ice', 'kiwen-suwi', next);
    expect(next.dataset).toEqual({ board: 'ice', pieces: 'kiwen-suwi' });
  });

  it('are applied before the app renders', () => {
    const main = read('src/main.tsx');
    expect(main.indexOf('initSkins();')).toBeGreaterThan(0);
    expect(main.indexOf('initSkins();')).toBeLessThan(main.indexOf('render('));
  });

  it('every non-default set is a file the PWA precaches and the native build copies', () => {
    // public/ is copied to dist/ and dist-native/; the service worker precaches **/*.svg there.
    const config = read('vite.config.ts');
    expect(config).toMatch(/globPatterns: \['\*\*\/\*\.\{[^}]*svg[^}]*\}'\]/);
    expect(config).not.toMatch(/globIgnores:[^\n]*pieces/);
    for (const s of PIECE_SETS) if (!('inline' in s)) expect(existsSync(join(ROOT, `public/pieces/${s.id}/wK.svg`))).toBe(true);
  });
});
