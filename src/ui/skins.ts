/**
 * Board and piece skins: the board's color theme and the piece set, picked separately (Menu → Board &
 * pieces, a sheet with a live preview: src/ui/SkinsSheet.tsx) and free everywhere, also in the App
 * Store app. The defaults are the look the app always had: the green board and the cburnett pieces.
 *
 * - Board themes are drawn by the app itself: CSS colors, plus an SVG texture written in the CSS for
 *   Wood and Marble (src/ui/skins.css). Each theme has the whole token set the board uses (its own
 *   values, or the green board's where they show well): squares, last move, selection, check, move
 *   dots, hover, coordinates on either square, and the opening line's arrow (tests/app/skins.test.ts
 *   checks the contrast of each against both squares).
 * - Piece sets are SVG files: the default is chessground's own cburnett art, inlined into the CSS
 *   (src/ui/pieces/cburnett/), the others are files in public/pieces/<id>/ (lila's copies at a pinned
 *   commit, which lila optimized from the artists' files, with no further changes; each with a README
 *   and, where its license needs them, a LICENSE.txt and the upstream copyright notice). The CSS
 *   maps each piece to a custom property (`--piece-wk` …) per set, so the browser downloads only the
 *   chosen set's 12 files, when a board first shows them. Every set is in the service worker's
 *   precache and in the App Store app's files, so all of them work offline.
 *
 * The choice is stored in localStorage (`chesscoach.board`, `chesscoach.pieces`, mirrored in the App
 * Store app like every `chesscoach.` key) and put on <html data-board data-pieces>, which the CSS
 * keys off. main.tsx applies it before the first render (`initSkins`), so a board never shows the
 * default set first. An unknown or removed id falls back to the default.
 *
 * No DOM access at import time: vite.config.ts imports the catalog for THIRD-PARTY-LICENSES.txt.
 */
import { signal } from '@preact/signals';

/**
 * The licenses a piece set may have (SPDX ids): commercial use allowed, and fit to ship inside the app
 * (GPL-3.0: its own code is GPL-3.0-or-later, Stockfish and chessground are GPL-3.0). GPL-3.0-only is
 * a set whose upstream names version 3 without "or any later version" (GPLv3 section 14).
 */
export type SkinLicense =
  | 'GPL-2.0-or-later'
  | 'GPL-3.0-only'
  | 'GPL-3.0-or-later'
  | 'MIT'
  | 'Apache-2.0'
  | 'CC0-1.0'
  | 'CC-BY-4.0'
  | 'CC-BY-SA-4.0';

/** Each allowed license, with its name and where its text is. */
export const SKIN_LICENSES: Record<SkinLicense, { name: string; url: string }> = {
  'GPL-2.0-or-later': { name: 'GPL-2.0-or-later', url: 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html' },
  'GPL-3.0-only': { name: 'GPL-3.0-only', url: 'https://www.gnu.org/licenses/gpl-3.0.html' },
  'GPL-3.0-or-later': { name: 'GPL-3.0-or-later', url: 'https://www.gnu.org/licenses/gpl-3.0.html' },
  MIT: { name: 'MIT', url: 'https://opensource.org/license/mit' },
  'Apache-2.0': { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
  'CC0-1.0': { name: 'CC0 1.0 (public domain)', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  'CC-BY-4.0': { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  'CC-BY-SA-4.0': { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
};

/** The lichess.org (lila) commit the piece sets in public/pieces/ were taken from. */
export const LILA_COMMIT = 'cd2656d2787a766ba743da8da1dd3b24975e6329';
const LILA_PIECES = `https://github.com/lichess-org/lila/tree/${LILA_COMMIT}/public/piece`;

/**
 * A board texture (`--board-texture`, painted over the squares) as the squares see it on average: its
 * mean color and coverage, measured on the drawn board (e2e/skins.spec.ts checks them against the
 * rendered squares). tests/app/skins.test.ts composites it over both squares before checking contrast.
 */
export interface TextureMean {
  color: string;
  alpha: number;
}

export const BOARD_THEMES = [
  { id: 'green', name: 'Green' },
  { id: 'brown', name: 'Brown' },
  { id: 'wood', name: 'Wood', texture: { color: '#896531', alpha: 0.158 } },
  { id: 'blue', name: 'Blue' },
  { id: 'ice', name: 'Ice' },
  { id: 'slate', name: 'Slate' },
  { id: 'marble', name: 'Marble', texture: { color: '#dbdcdf', alpha: 0.136 } },
  { id: 'purple', name: 'Purple' },
  { id: 'coral', name: 'Coral' },
  { id: 'olive', name: 'Olive' },
] as const satisfies readonly { id: string; name: string; texture?: TextureMean }[];

export type BoardThemeId = (typeof BOARD_THEMES)[number]['id'];
export type BoardTheme = (typeof BOARD_THEMES)[number];

export interface PieceSet {
  id: string;
  /** Shown in the Menu. */
  name: string;
  /** Who made the art (the copyright holder). */
  author: string;
  license: SkinLicense;
  /** Where the files come from (pinned). */
  source: string;
  /** The art's own home, where its license is stated (none: the source's license list is the record). */
  upstream?: string;
  /** The upstream commit at which its license (and copyright notice) was checked, for a git upstream. */
  upstreamCommit?: string;
  /** The work's copyright notice as upstream states it, kept with the license (Apache-2.0 section 4(c)). */
  copyright?: string;
  /** Upstream's copyright file, byte for byte, next to the SVGs (public/pieces/<id>/COPYRIGHT.txt). */
  copyrightFile?: true;
  /** Inlined into the app's CSS (the default set) rather than files in public/pieces/<id>/. */
  inline?: true;
  /** A license file next to the SVGs (public/pieces/<id>/LICENSE.txt), for licenses that need their text shipped. */
  licenseFile?: true;
  /**
   * Its black pieces are flat dark shapes with no light detail (their lightest color is under 2:1
   * against the dark theme's background; tests/app/skins.test.ts checks every set): off the board, on
   * the dark theme's surfaces (captured pieces, the king avatars), they sit on a light chip
   * (`--piece-chip`, src/ui/skins.css), as on a light square, instead of vanishing into the surface.
   */
  silhouette?: true;
}

export const PIECE_SETS = [
  {
    id: 'cburnett',
    name: 'Classic',
    author: 'Colin M.L. Burnett',
    license: 'GPL-2.0-or-later',
    // chessground's assets/chessground.cburnett.css (the version in package-lock.json), decoded into
    // src/ui/pieces/cburnett/.
    source: 'https://github.com/lichess-org/chessground',
    upstream: 'https://en.wikipedia.org/wiki/User:Cburnett',
    inline: true,
  },
  {
    id: 'mpchess',
    name: 'MPchess',
    author: 'Maxime Chupin',
    // Upstream: "GNU GENERAL PUBLIC LICENSE, Version 3", with no "or any later version" (lila's
    // COPYING.md says GPLv3+).
    license: 'GPL-3.0-only',
    source: `${LILA_PIECES}/mpchess`,
    upstream: 'https://github.com/chupinmaxime/mpchess-pieces',
    upstreamCommit: '720f6e050b4ee9b6e68f1ef5d89330a44850d54e',
  },
  {
    id: 'chessnut',
    name: 'Chessnut',
    author: 'Alexis Luengas',
    license: 'Apache-2.0',
    source: `${LILA_PIECES}/chessnut`,
    upstream: 'https://github.com/LexLuengas/chessnut-pieces',
    upstreamCommit: '2b8eaf14a31edad7e9deb53b1473e1d4857868a9',
    // Upstream's COPYRIGHT.txt: its LICENSE.txt is the bare Apache text, so this is the work's notice.
    copyright: 'Copyright 2015 Alexis Luengas',
    copyrightFile: true,
    licenseFile: true,
  },
  {
    id: 'celtic',
    name: 'Celtic',
    author: 'Maurizio Monge',
    license: 'MIT',
    source: `${LILA_PIECES}/celtic`,
    upstream: 'https://github.com/maurimo/chess-art',
    upstreamCommit: 'd8705d8bc9879fef44208de19e2a20c937409e1f',
    licenseFile: true,
  },
  {
    id: 'fantasy',
    name: 'Fantasy',
    author: 'Maurizio Monge',
    license: 'MIT',
    source: `${LILA_PIECES}/fantasy`,
    upstream: 'https://github.com/maurimo/chess-art',
    upstreamCommit: 'd8705d8bc9879fef44208de19e2a20c937409e1f',
    licenseFile: true,
  },
  {
    id: 'spatial',
    name: 'Spatial',
    author: 'Maurizio Monge',
    license: 'MIT',
    source: `${LILA_PIECES}/spatial`,
    upstream: 'https://github.com/maurimo/chess-art',
    upstreamCommit: 'd8705d8bc9879fef44208de19e2a20c937409e1f',
    licenseFile: true,
  },
  {
    id: 'rhosgfx',
    name: 'RhosGFX',
    author: 'RhosGFX',
    license: 'CC0-1.0',
    source: `${LILA_PIECES}/rhosgfx`,
    upstream: 'https://rhosgfx.itch.io/vector-chess-pieces',
  },
  {
    id: 'kiwen-suwi',
    name: 'Kiwen Suwi',
    author: 'neverRare',
    license: 'CC-BY-4.0',
    source: `${LILA_PIECES}/kiwen-suwi`,
    upstream: 'https://github.com/neverRare/kiwen-suwi',
    upstreamCommit: '7e8f3e473f43474baeebed01e76f054cb06c0100',
    silhouette: true,
  },
] as const satisfies readonly PieceSet[];

export type PieceSetId = (typeof PIECE_SETS)[number]['id'];

/** The 12 files of a set (public/pieces/<id>/<file>.svg), and the CSS custom property of each (`--piece-wk`). */
export const PIECE_FILES = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'] as const;
export type PieceFile = (typeof PIECE_FILES)[number];

export const DEFAULT_BOARD: BoardThemeId = 'green';
export const DEFAULT_PIECES: PieceSetId = 'cburnett';

/** localStorage keys (mirrored in the App Store app like every `chesscoach.` key). */
export const BOARD_KEY = 'chesscoach.board';
export const PIECES_KEY = 'chesscoach.pieces';

export const isBoardTheme = (v: unknown): v is BoardThemeId => BOARD_THEMES.some((t) => t.id === v);
export const isPieceSet = (v: unknown): v is PieceSetId => PIECE_SETS.some((s) => s.id === v);

/** The catalog entry of `id` (the default for an unknown id). */
export function boardThemeOf(id: string): BoardTheme {
  return BOARD_THEMES.find((t) => t.id === id) ?? BOARD_THEMES[0];
}
export function pieceSetOf(id: string): (typeof PIECE_SETS)[number] {
  return PIECE_SETS.find((s) => s.id === id) ?? PIECE_SETS[0];
}

/** A board theme's name as VoiceOver reads it, and the Menu writes it: "Brown board". */
export function boardThemeLabel(id: string): string {
  return `${boardThemeOf(id).name} board`;
}

/** A piece set's name as VoiceOver reads it, and the Menu writes it: "Chessnut pieces". */
export function pieceSetLabel(id: string): string {
  return `${pieceSetOf(id).name} pieces`;
}

/** The Menu's "Board & pieces" row under its label: "Brown board · Chessnut pieces". */
export function skinsSummary(board: string, pieces: string): string {
  return `${boardThemeLabel(board)} · ${pieceSetLabel(pieces)}`;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode, storage disabled, or no localStorage at all
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / storage disabled: the choice lasts for this session only.
  }
}

/** The stored board theme; the default when none is stored, or it is unknown (e.g. a removed theme). Never throws. */
export function loadBoardTheme(): BoardThemeId {
  const v = read(BOARD_KEY);
  return isBoardTheme(v) ? v : DEFAULT_BOARD;
}

/** The stored piece set; the default when none is stored, or it is unknown (e.g. a removed set). Never throws. */
export function loadPieceSet(): PieceSetId {
  const v = read(PIECES_KEY);
  return isPieceSet(v) ? v : DEFAULT_PIECES;
}

/** The skins in use (the Menu shows them; set them with chooseBoardTheme / choosePieceSet). */
export const boardTheme = signal<BoardThemeId>(DEFAULT_BOARD);
export const pieceSet = signal<PieceSetId>(DEFAULT_PIECES);

/** Puts the skins on <html data-board data-pieces>, which src/ui/skins.css keys off. */
export function applySkins(board: BoardThemeId, pieces: PieceSetId, root: HTMLElement = document.documentElement): void {
  root.dataset.board = board;
  root.dataset.pieces = pieces;
}

/** Reads the stored skins and applies them: at startup, before the first render (and again after the App Store app restores its storage). */
export function initSkins(root?: HTMLElement): void {
  boardTheme.value = loadBoardTheme();
  pieceSet.value = loadPieceSet();
  applySkins(boardTheme.value, pieceSet.value, root);
}

/** The Menu's choice of board theme: stored, applied and published. */
export function chooseBoardTheme(id: BoardThemeId, root?: HTMLElement): void {
  write(BOARD_KEY, id);
  applySkins(id, pieceSet.peek(), root);
  boardTheme.value = id;
}

/** The Menu's choice of piece set: stored, applied and published. */
export function choosePieceSet(id: PieceSetId, root?: HTMLElement): void {
  write(PIECES_KEY, id);
  applySkins(boardTheme.peek(), id, root);
  pieceSet.value = id;
}
