/**
 * Saves and restores the current game and the settings in localStorage.
 *
 * iOS often kills a backgrounded Home Screen app and restarts it from scratch, so the controller
 * saves the game after every move, and keeps a finished game (with its result) until the next one
 * starts, so its game-over screen and review survive too. Loaded data is treated as untrusted:
 * games are replayed with chess.js and settings are merged over DEFAULT_SETTINGS. No call here
 * ever throws.
 */
import { Chess } from 'chess.js';
import { MOVE_CLASS_ORDER } from '../analysis/types';
import type { Classification, Explanation, MoveClass } from '../analysis/types';
import { parseUci, toUci } from '../chess/utils';
import type { Score } from '../engine/types';
import { DEFAULT_SETTINGS } from './types';
import type { Color, GameOutcome, GameSettings, Ply } from './types';

/** localStorage key of the current (or just finished) game (a SavedGame). */
export const GAME_KEY = 'chesscoach.game';
/** localStorage key of the settings. The value is `{ version: 1, settings: GameSettings }`. */
export const SETTINGS_KEY = 'chesscoach.settings';
const SETTINGS_VERSION = 1;
/** localStorage key set once Draw mode's first-use tip has shown on this device. */
export const DRAW_TIP_KEY = 'chesscoach.draw-tip';

/** The subset of the Web Storage API used here (localStorage or an in-memory stand-in). */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Analysis results stored per ply so a restored game does not need re-analysing. */
export type PlyAnnotation = Pick<Ply, 'evalWhite' | 'evalDepth' | 'classification' | 'explanation' | 'isBook'>;

export interface SavedGame {
  version: 1;
  id: string;
  startFen: string;
  /** Moves from `startFen` in UCI (e.g. "e2e4", "e7e8q"). */
  moves: string[];
  playerColor: Color;
  botId: string;
  botElo: number;
  botName: string;
  /**
   * Takebacks, hints, Retry, the engine in the explorer, best-move arrows or the opponent's move
   * ratings were used (the game will not be rated). Only the flag is saved, not which help it was
   * (so games saved when opening the explorer itself made them unrated load as unrated, as they were).
   */
  assisted: boolean;
  /** ISO timestamp. */
  startedAt: string;
  /** Keyed by ply index (0-based, as `Ply.index`). */
  annotations: Record<number, PlyAnnotation>;
  /** Set once the game has ended: its result and the rating change it caused. */
  over?: SavedResult;
  /**
   * The coach's "Try again" prompt after a Retry, while the player is still looking for a better
   * move (the retried move itself is no longer in `moves`). Only in a game in progress.
   */
  retry?: SavedRetry;
  /** Opening practice: the line the game follows (absent in a normal game and in older saves). */
  opening?: SavedOpening;
  /**
   * The first `preplayed` moves were played before the game started (an opening line set up by
   * opening practice): book moves, not analyzed, not counted for accuracy. Absent = 0.
   */
  preplayed?: number;
}

/** Opening practice (see GameController `newGame(settings, { opening })`). */
export interface SavedOpening {
  /** The catalog line (`OpeningLine.id`), or the id of the line saved in `moves`. */
  lineId: string;
  mode: 'steer' | 'skip';
  showLineMoves: boolean;
  /** A line from outside the catalog (an opening guide's main line): its UCI moves from the initial position. */
  moves?: string[];
  /** With `moves`: the name the game shows and the family. */
  name?: string;
  family?: string;
}

/** The "Try again" prompt after a Retry (the coach's 'retry' mode). */
export interface SavedRetry {
  /** SAN of the move that was taken back. */
  san: string;
  cls: MoveClass;
  /** What was wrong with it, without giving the better move away (null when unknown). */
  headline: string | null;
}

/** How a saved game ended. */
export interface SavedResult {
  outcome: GameOutcome;
  ratingChange: { before: number; after: number; rated: boolean };
}

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(storage: KeyValueStorage | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function write(storage: KeyValueStorage | null, key: string, value: unknown): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(storage: KeyValueStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** A short unique id for a new game. */
export function createGameId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------------------------
// In-progress game

/**
 * Saves the in-progress game. If the quota is exceeded it retries without the (bulky)
 * explanations. Returns whether anything was stored.
 */
export function saveGame(g: SavedGame, storage: KeyValueStorage | null = defaultStorage()): boolean {
  if (write(storage, GAME_KEY, g)) return true;
  const annotations: Record<number, PlyAnnotation> = {};
  for (const [k, a] of Object.entries(g.annotations)) {
    const { explanation: _dropped, ...rest } = a;
    annotations[Number(k)] = rest;
  }
  return write(storage, GAME_KEY, { ...g, annotations });
}

/**
 * Loads the saved game, or null when there is none or it is unusable (the stored value is then
 * removed). Moves are replayed from `startFen` with chess.js: the game is cut at the first illegal
 * move (annotations past it are dropped), and SAN moves are normalised to UCI.
 */
export function loadGame(storage: KeyValueStorage | null = defaultStorage()): SavedGame | null {
  const raw = read(storage, GAME_KEY);
  if (raw === null) {
    remove(storage, GAME_KEY);
    return null;
  }
  const game = sanitizeSavedGame(raw);
  if (!game) remove(storage, GAME_KEY);
  return game;
}

/** Removes the saved game. */
export function clearGame(storage: KeyValueStorage | null = defaultStorage()): void {
  remove(storage, GAME_KEY);
}

/** Validates untrusted saved-game data; null when it cannot be used. Unknown extra fields are kept. */
export function sanitizeSavedGame(raw: unknown): SavedGame | null {
  if (!isObject(raw) || raw.version !== 1) return null;
  const { id, startFen, playerColor } = raw;
  if (typeof id !== 'string' || !id) return null;
  if (typeof startFen !== 'string' || (playerColor !== 'w' && playerColor !== 'b')) return null;
  if (!Array.isArray(raw.moves) || !isFiniteNumber(raw.botElo)) return null;

  let chess: Chess;
  try {
    chess = new Chess(startFen);
  } catch {
    return null;
  }
  const moves: string[] = [];
  for (const m of raw.moves) {
    const uci = typeof m === 'string' ? playMove(chess, m) : null;
    if (!uci) break;
    moves.push(uci);
  }

  const game: SavedGame = {
    ...raw,
    version: 1,
    id,
    startFen,
    moves,
    playerColor,
    botId: typeof raw.botId === 'string' && raw.botId ? raw.botId : 'custom',
    botElo: clampElo(raw.botElo),
    botName: typeof raw.botName === 'string' ? raw.botName : 'Bot',
    // Missing flag: assume assisted so a corrupt save can never produce an undeserved rated game.
    assisted: raw.assisted !== false,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : new Date().toISOString(),
    annotations: sanitizeAnnotations(raw.annotations, moves.length),
  };
  const over = sanitizeResult(raw.over);
  if (over) game.over = over;
  else delete game.over;
  const retry = over ? null : sanitizeRetry(raw.retry);
  if (retry) game.retry = retry;
  else delete game.retry;
  const opening = sanitizeOpening(raw.opening);
  if (opening) game.opening = opening;
  else delete game.opening;
  const preplayed = raw.preplayed;
  if (Number.isInteger(preplayed) && (preplayed as number) > 0) game.preplayed = Math.min(preplayed as number, moves.length);
  else delete game.preplayed;
  return game;
}

/** A saved opening-practice target, or null when it is missing or malformed. */
function sanitizeOpening(v: unknown): SavedOpening | null {
  if (!isObject(v)) return null;
  const { lineId, mode, showLineMoves, moves, name, family } = v;
  if (typeof lineId !== 'string' || !lineId || lineId.length > 200) return null;
  if (mode !== 'steer' && mode !== 'skip') return null;
  const out: SavedOpening = { lineId, mode, showLineMoves: showLineMoves === true };
  const text = (t: unknown): t is string => typeof t === 'string' && t.length > 0 && t.length <= 120;
  if (Array.isArray(moves) && moves.length > 0 && moves.length <= 60 && moves.every((m) => typeof m === 'string' && UCI_RE.test(m))) {
    out.moves = moves as string[];
    if (text(name)) out.name = name;
    if (text(family)) out.family = family;
  }
  return out;
}

/** A saved "Try again" prompt, or null when it is missing or malformed. */
function sanitizeRetry(v: unknown): SavedRetry | null {
  if (!isObject(v)) return null;
  const { san, cls, headline } = v;
  if (typeof san !== 'string' || !san || san.length > 12) return null;
  if (!MOVE_CLASS_ORDER.includes(cls as MoveClass)) return null;
  if (headline !== null && (typeof headline !== 'string' || headline.length > 400)) return null;
  return { san, cls: cls as MoveClass, headline };
}

/** A saved result, or null when it is missing or inconsistent. */
function sanitizeResult(v: unknown): SavedResult | null {
  if (!isObject(v) || !isObject(v.outcome) || !isObject(v.ratingChange)) return null;
  const { result, winner, reason } = v.outcome;
  const expected = result === '1-0' ? 'w' : result === '0-1' ? 'b' : result === '1/2-1/2' ? null : undefined;
  if (expected === undefined || winner !== expected || typeof reason !== 'string') return null;
  const { before, after, rated } = v.ratingChange;
  if (!isFiniteNumber(before) || !isFiniteNumber(after) || typeof rated !== 'boolean') return null;
  return { outcome: { result: result as GameOutcome['result'], winner: expected, reason }, ratingChange: { before, after, rated } };
}

/** Plays a UCI (or SAN) move; returns its UCI, or null when illegal. */
function playMove(chess: Chess, move: string): string | null {
  try {
    return toUci(UCI_RE.test(move) ? chess.move(parseUci(move)) : chess.move(move));
  } catch {
    return null;
  }
}

function sanitizeAnnotations(raw: unknown, plies: number): Record<number, PlyAnnotation> {
  const out: Record<number, PlyAnnotation> = {};
  if (!isObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= plies || !isObject(value)) continue;
    const a: PlyAnnotation = {};
    if (isScore(value.evalWhite)) a.evalWhite = value.evalWhite;
    if (isFiniteNumber(value.evalDepth) && value.evalDepth >= 0) a.evalDepth = value.evalDepth;
    if (isClassification(value.classification)) a.classification = value.classification;
    const explanation = sanitizeExplanation(value.explanation);
    if (explanation) a.explanation = explanation;
    if (typeof value.isBook === 'boolean') a.isBook = value.isBook;
    if (Object.keys(a).length > 0) out[index] = a;
  }
  return out;
}

function isScore(v: unknown): v is Score {
  return isObject(v) && (v.kind === 'cp' || v.kind === 'mate') && isFiniteNumber(v.value);
}

function isClassification(v: unknown): v is Classification {
  return (
    isObject(v) &&
    MOVE_CLASS_ORDER.includes(v.cls as Classification['cls']) &&
    isFiniteNumber(v.winBefore) &&
    isFiniteNumber(v.winAfter) &&
    isFiniteNumber(v.winLoss) &&
    isFiniteNumber(v.accuracy) &&
    (v.bestMoveUci === null || typeof v.bestMoveUci === 'string') &&
    (v.bestMoveSan === null || typeof v.bestMoveSan === 'string') &&
    typeof v.playedMoveSan === 'string'
  );
}

/** Keeps an explanation with a valid headline/details; drops malformed optional fields. */
function sanitizeExplanation(v: unknown): Explanation | null {
  if (!isObject(v) || typeof v.headline !== 'string' || !isStringArray(v.details)) return null;
  const e = { ...v } as Record<string, unknown>;
  for (const key of ['bestLineSan', 'motifs'] as const) {
    if (key in e && !isStringArray(e[key])) delete e[key];
  }
  if ('title' in e && typeof e.title !== 'string') delete e.title;
  if ('concedes' in e && e.concedes !== 'material' && e.concedes !== 'mate') delete e.concedes;
  if ('arrows' in e) {
    const isArrow = (a: unknown) =>
      isObject(a) && typeof a.from === 'string' && typeof a.to === 'string' && typeof a.brush === 'string';
    const ok = Array.isArray(e.arrows) && e.arrows.every(isArrow);
    if (!ok) delete e.arrows;
  }
  return e as unknown as Explanation;
}

// ---------------------------------------------------------------------------------------------
// Settings

/** Saves the settings (never throws). */
export function saveSettings(s: GameSettings, storage: KeyValueStorage | null = defaultStorage()): void {
  write(storage, SETTINGS_KEY, { version: SETTINGS_VERSION, settings: s });
}

/** Loads the settings merged over DEFAULT_SETTINGS; invalid fields fall back to their defaults. */
export function loadSettings(storage: KeyValueStorage | null = defaultStorage()): GameSettings {
  const raw = read(storage, SETTINGS_KEY);
  return sanitizeSettings(isObject(raw) && isObject(raw.settings) ? raw.settings : raw);
}

/** Draw mode's first-use tip has already shown on this device (never throws; no storage: not yet). */
export function loadDrawTipSeen(storage: KeyValueStorage | null = defaultStorage()): boolean {
  return read(storage, DRAW_TIP_KEY) === true;
}

/** Remembers that Draw mode's tip has shown (never throws; a failing storage only shows it again). */
export function saveDrawTipSeen(storage: KeyValueStorage | null = defaultStorage()): void {
  write(storage, DRAW_TIP_KEY, true);
}

/**
 * Merges untrusted settings over DEFAULT_SETTINGS. Known fields must have the default's type
 * (plus range checks); unknown primitive fields are kept, so optional settings added later survive.
 */
export function sanitizeSettings(raw: unknown): GameSettings {
  const out: GameSettings = { ...DEFAULT_SETTINGS };
  if (!isObject(raw)) return out;
  const target = out as unknown as Record<string, unknown>;
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      if (typeof value === typeof defaults[key]) target[key] = value;
    } else if (typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value)) {
      target[key] = value;
    }
  }
  if (out.playerColor !== 'w' && out.playerColor !== 'b' && out.playerColor !== 'random') {
    out.playerColor = DEFAULT_SETTINGS.playerColor;
  }
  out.botElo = isFiniteNumber(out.botElo) ? clampElo(out.botElo) : DEFAULT_SETTINGS.botElo;
  if (!out.botId) out.botId = DEFAULT_SETTINGS.botId;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Storage persistence

/**
 * Asks the browser to exempt this origin from storage eviction (navigator.storage.persist()).
 * Resolves true when storage is (now) persistent, false when unsupported or refused.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
    if (!storage || typeof storage.persist !== 'function') return false;
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    return (await storage.persist()) === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------

function clampElo(elo: number): number {
  return Math.min(3200, Math.max(100, Math.round(elo)));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
