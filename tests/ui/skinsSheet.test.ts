/**
 * The "Board & pieces" sheet (src/ui/SkinsSheet.tsx) and its pickers (src/ui/SkinPickers.tsx): the
 * arrow keys' choice, the names VoiceOver reads and the Menu row writes, the credit, the preview's
 * position, and that nothing about the skins is ever sold (no lock, no paywall entry).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chess, type Square } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { FEATURE_INFO, FEATURE_TIERS } from '../../src/game/entitlements';
import { stepChoice } from '../../src/ui/SkinPickers';
import { PREVIEW, SKINS_TITLE, pieceCredit, previewLabel } from '../../src/ui/SkinsSheet';
import { BOARD_THEMES, PIECE_SETS, boardThemeLabel, pieceSetLabel, skinsSummary } from '../../src/ui/skins';

const ROOT = join(__dirname, '../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

describe('stepChoice (the pickers’ keys)', () => {
  const ids = ['green', 'brown', 'wood'] as const;

  it('moves to the next option with → and ↓, the previous one with ← and ↑, wrapping', () => {
    expect(stepChoice(ids, 'green', 'ArrowRight')).toBe('brown');
    expect(stepChoice(ids, 'green', 'ArrowDown')).toBe('brown');
    expect(stepChoice(ids, 'brown', 'ArrowLeft')).toBe('green');
    expect(stepChoice(ids, 'brown', 'ArrowUp')).toBe('green');
    expect(stepChoice(ids, 'wood', 'ArrowRight')).toBe('green');
    expect(stepChoice(ids, 'green', 'ArrowLeft')).toBe('wood');
  });

  it('goes to the first and last option with Home and End', () => {
    expect(stepChoice(ids, 'brown', 'Home')).toBe('green');
    expect(stepChoice(ids, 'brown', 'End')).toBe('wood');
  });

  it('leaves every other key alone, and steps from the first option for an unknown value', () => {
    for (const key of ['Enter', ' ', 'Tab', 'a', 'Escape']) expect(stepChoice(ids, 'brown', key)).toBeNull();
    expect(stepChoice(ids, 'plaid' as never, 'ArrowRight')).toBe('brown');
    expect(stepChoice([], 'x', 'ArrowRight')).toBeNull();
  });
});

describe('names', () => {
  it('reads each tile by its full name, as VoiceOver says it', () => {
    expect(boardThemeLabel('brown')).toBe('Brown board');
    expect(pieceSetLabel('chessnut')).toBe('Chessnut pieces');
    expect(pieceSetLabel('kiwen-suwi')).toBe('Kiwen Suwi pieces');
    expect(pieceSetLabel('cburnett')).toBe('Classic pieces');
    // An unknown or removed id reads as the default, which is what the app then shows.
    expect(boardThemeLabel('plaid')).toBe('Green board');
    expect(pieceSetLabel('pixel')).toBe('Classic pieces');
    for (const t of BOARD_THEMES) expect(boardThemeLabel(t.id)).toBe(`${t.name} board`);
    for (const s of PIECE_SETS) expect(pieceSetLabel(s.id)).toBe(`${s.name} pieces`);
  });

  it('gives the Menu row its title and summary, and the preview its name', () => {
    expect(SKINS_TITLE).toBe('Board & pieces');
    expect(skinsSummary('green', 'cburnett')).toBe('Green board · Classic pieces');
    expect(skinsSummary('wood', 'chessnut')).toBe('Wood board · Chessnut pieces');
    expect(previewLabel('ice', 'celtic')).toBe('Preview of the Ice board with the Celtic pieces');
  });

  it('credits the chosen set’s artist and license', () => {
    expect(pieceCredit('chessnut')).toEqual({ by: 'Pieces by Alexis Luengas', license: 'Apache-2.0' });
    expect(pieceCredit('kiwen-suwi')).toEqual({ by: 'Pieces by neverRare', license: 'CC BY 4.0' });
    expect(pieceCredit('cburnett')).toEqual({ by: 'Pieces by Colin M.L. Burnett', license: 'GPL-2.0-or-later' });
  });

  it('writes the names in American English with curly apostrophes', () => {
    for (const file of ['src/ui/SkinsSheet.tsx', 'src/ui/SkinPickers.tsx']) {
      // JSX text only: no straight apostrophe between letters.
      const text = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(text.match(/>[^<{]*[A-Za-z]'[A-Za-z][^<{]*</g), file).toBeNull();
      expect(text).not.toMatch(/colour/i);
    }
  });
});

describe('About’s piece credits', () => {
  it('credits every set that ships, with its license, and Chessnut by its copyright notice', async () => {
    const { PIECE_CREDITS } = await import('../../src/ui/About');
    expect(PIECE_CREDITS.map((c) => c.name)).toEqual(PIECE_SETS.map((s) => s.name));
    expect(PIECE_CREDITS.find((c) => c.name === 'Chessnut')).toMatchObject({ by: 'Copyright 2015 Alexis Luengas', license: { name: 'Apache-2.0' } });
    expect(PIECE_CREDITS.find((c) => c.name === 'MPchess')).toMatchObject({ by: 'Maxime Chupin', license: { name: 'GPL-3.0-only' } });
    expect(PIECE_CREDITS.map((c) => c.name)).not.toContain('Merida');
    for (const c of PIECE_CREDITS) expect(c.url).toMatch(/^https:\/\//);
  });
});

describe('the preview’s position', () => {
  const chess = new Chess();
  for (const san of PREVIEW.moves.split(' ')) chess.move(san);
  const last = chess.history({ verbose: true }).at(-1)!;

  it('is the real game line it names, ending in its last move, with no check', () => {
    expect(chess.fen()).toBe(PREVIEW.fen);
    expect([last.from, last.to]).toEqual(PREVIEW.lastMove);
    expect(chess.inCheck()).toBe(false);
    expect(chess.isGameOver()).toBe(false);
  });

  it('shows every kind of piece for both sides, and the last move on a light and a dark square', () => {
    const kinds = new Set(chess.board().flat().filter((p) => p !== null).map((p) => p!.color + p!.type));
    for (const color of ['w', 'b']) for (const type of ['k', 'q', 'r', 'b', 'n', 'p']) expect(kinds.has(color + type)).toBe(true);
    const colors = PREVIEW.lastMove.map((sq) => chess.squareColor(sq as Square));
    expect(new Set(colors)).toEqual(new Set(['light', 'dark']));
  });
});

describe('the skins are free', () => {
  it('are no Pro feature, and the paywall’s list of what Pro unlocks never mentions them', () => {
    for (const f of Object.keys(FEATURE_TIERS)) expect(f).not.toMatch(/skin|board|piece|theme|style/i);
    for (const info of Object.values(FEATURE_INFO)) expect(`${info.title} ${info.detail}`).not.toMatch(/skin|board|piece|theme|style/i);
  });

  it('show no lock and never open the paywall', () => {
    for (const file of ['src/ui/SkinsSheet.tsx', 'src/ui/SkinPickers.tsx']) {
      const code = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/PaywallSheet|IconLock|LockedIcon|entitlements|locked/);
    }
  });
});
