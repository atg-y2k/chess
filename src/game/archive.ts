/**
 * Earlier games (the profile's history, `GameRecord`): their moves from the stored PGN, the coach's
 * analysis in the compact form the history keeps (`CompactAnalysis`), and their export.
 *
 * The PGN is the source of truth for the moves. The analysis is a few characters per move: the class
 * letter, the White-POV evaluation after the move, flags (about as good as the best, at least as
 * good, what it gives away), a weak class a won game made all but free ('w' a slower mate, 'l' a mate
 * given up, with the best line's mate) and the engine's better move, e.g. "s34", "e-12:g1f3",
 * "bn#-3:d1h5", "i#9w1:e1e8"; the
 * explanation headlines of the key moments ride along (`h`), for Game Review's list and Try again's
 * reason. Everything else (win chances, accuracy per move, the better move's SAN) is derived again.
 * A 60-move game takes about 3 KB with its PGN (measured in tests/game/archive.test.ts), so 200 games
 * stay well inside the phone's storage.
 *
 * Pure: no engine, DOM or signals (the controller and the store use it).
 */
import { Chess, type Move } from 'chess.js';
import type { Classification, Explanation, MoveClass, WonAnyway } from '../analysis/types';
import { moveAccuracy } from '../analysis/accuracy';
import { wonAnywayFromEvals } from '../analysis/classify';
import { negateScore, scoreToWin } from '../analysis/winprob';
import { BOTS, customPersona, personaById } from '../bot/personas';
import type { BotPersona } from '../bot/types';
import { START_FEN, uciToSan } from '../chess/utils';
import type { Score } from '../engine/types';
import type { CompactAnalysis, GameRecord } from '../rating/types';
import { buildPgn, type PgnPlayer } from './pgn';
import { summarizeGame } from './review';
import type { Color, GameResult, Ply } from './types';

/** One letter per class in the compact analysis ('-': not analyzed). */
const CLASS_CODE: Record<MoveClass, string> = {
  brilliant: 'B',
  great: 'G',
  best: 's',
  excellent: 'e',
  good: 'g',
  book: 'k',
  forced: 'f',
  inaccuracy: 'i',
  mistake: 'm',
  miss: 'x',
  blunder: 'b',
};
const CODE_CLASS: Record<string, MoveClass> = Object.fromEntries(
  Object.entries(CLASS_CODE).map(([cls, code]) => [code, cls as MoveClass]),
);
/**
 * class, eval (centipawns, or "#" and moves to mate), flags (n a c d), `wonAnyway` (w or l and the
 * best line's mate in moves), ":" and the better move.
 */
const TOKEN = /^([BGsegkfimxb-])(#-?\d{1,3}|-?\d{1,5})?([nacd]*)(?:([wl])(\d{1,3}))?(?::([a-h][1-8][a-h][1-8][qrbn]?))?$/;
/** The longest explanation headline kept for a key moment. */
const MAX_HEADLINE = 200;

/** A White-POV evaluation as the compact analysis writes it: "34", "-120", "#3", "#-2", "#0". */
export function encodeScore(s: Score | null | undefined): string {
  if (!s || !Number.isFinite(s.value)) return '';
  return s.kind === 'mate' ? `#${Math.round(s.value) || 0}` : String(Math.round(s.value) || 0);
}

/** The inverse of `encodeScore` (null for '' or anything malformed). */
export function decodeScore(text: string | undefined): Score | null {
  if (!text) return null;
  const m = /^(#?)(-?\d{1,5})$/.exec(text);
  if (!m) return null;
  const value = Number(m[2]);
  return m[1] ? { kind: 'mate', value } : { kind: 'cp', value };
}

/** Plies the game started with (opening practice): never analyzed, never counted. */
function ownStart(plies: readonly Ply[], preplayed: number | undefined): number {
  return Math.min(Math.max(0, preplayed ?? 0), plies.length);
}

/**
 * The game's key moments as Game Review lists them (review.ts `summarizeGame`, preplayed moves left
 * out), whose explanation headlines the compact analysis keeps.
 */
function keyMomentIndexes(plies: readonly Ply[], playerColor: Color, preplayed?: number): number[] {
  const own = plies.slice(ownStart(plies, preplayed));
  if (!own.length) return [];
  return summarizeGame(own[0].fenBefore, null, own, playerColor).keyMoments.map((m) => m.index);
}

/**
 * The compact analysis of annotated plies (`Ply.classification`, `evalWhite`, `explanation`):
 * one token per ply, '-' for a ply without a verdict, and the key moments' headlines.
 */
export function encodeAnalysis(
  plies: readonly Ply[],
  startEval: Score | null | undefined,
  opts: { playerColor: Color; preplayed?: number },
): CompactAnalysis {
  const tokens = plies.map((p) => {
    const cl = p.classification;
    let t = cl ? CLASS_CODE[cl.cls] : '-';
    t += encodeScore(p.evalWhite);
    if (cl?.nearBest) t += cl.aboveBest ? 'a' : 'n';
    const concedes = p.explanation?.concedes;
    if (concedes === 'material') t += 'c';
    else if (concedes === 'mate') t += 'd';
    const won = cl?.wonAnyway;
    if (won && Number.isInteger(won.mateIn) && won.mateIn > 0 && won.mateIn < 1000) t += `${won.kind === 'slower' ? 'w' : 'l'}${won.mateIn}`;
    const best = cl?.bestMoveUci;
    if (cl && best && best !== p.uci && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(best)) t += `:${best}`;
    return t;
  });
  const out: CompactAnalysis = { v: 1, s: encodeScore(startEval), p: tokens.join(' '), w: 1 };
  const h: Record<string, string> = {};
  for (const i of keyMomentIndexes(plies, opts.playerColor, opts.preplayed)) {
    const headline = plies[i]?.explanation?.headline;
    if (headline) h[String(i)] = headline.length > MAX_HEADLINE ? `${headline.slice(0, MAX_HEADLINE - 1)}…` : headline;
  }
  if (Object.keys(h).length) out.h = h;
  return out;
}

/** How much a token knows: 2 a verdict, 1 an evaluation only, 0 nothing (or malformed). */
function tokenWeight(token: string | undefined): number {
  const m = token ? TOKEN.exec(token) : null;
  if (!m) return 0;
  return m[1] !== '-' ? 2 : m[2] ? 1 : 0;
}

/**
 * `next` written over `kept` (the record's analysis) without forgetting anything: a ply that `next`
 * knows less about (no verdict, or not even an evaluation) keeps the token, and its headline, the
 * record had. A stale or partial copy of a game's analysis (the game viewer's, a game left before
 * every move was checked) therefore never erases verdicts saved meanwhile. Analyses of a different
 * number of plies do not mix: `next` as it is.
 */
export function mergeAnalysis(kept: CompactAnalysis | null | undefined, next: CompactAnalysis): CompactAnalysis {
  if (!kept) return next;
  const a = kept.p ? kept.p.split(' ') : [];
  const b = next.p ? next.p.split(' ') : [];
  if (a.length !== b.length) return next;
  const h: Record<string, string> = { ...(next.h ?? {}) };
  const tokens = b.map((t, i) => {
    const k = String(i);
    if (tokenWeight(a[i]) > tokenWeight(t)) {
      // The record's token stands, and its headline with it.
      if (kept.h?.[k]) h[k] = kept.h[k];
      else delete h[k];
      return a[i];
    }
    // The same verdict as before: a headline the record had for it is still true.
    if (a[i] === t && !h[k] && kept.h?.[k]) h[k] = kept.h[k];
    return t;
  });
  const out: CompactAnalysis = { v: 1, s: next.s || kept.s, p: tokens.join(' '), ...(next.w ? { w: 1 as const } : {}) };
  if (Object.keys(h).length) out.h = h;
  return out;
}

/** Two compact analyses say the same (nothing to save). */
export function sameAnalysis(a: CompactAnalysis | null | undefined, b: CompactAnalysis | null | undefined): boolean {
  if (!a || !b) return a === b;
  const ha = a.h ?? {};
  const hb = b.h ?? {};
  const ka = Object.keys(ha);
  return a.s === b.s && a.p === b.p && !!a.w === !!b.w && ka.length === Object.keys(hb).length && ka.every((k) => ha[k] === hb[k]);
}

/** The mover's expected score from a White-POV evaluation of the position after a move (0..1). */
function moverWin(scoreWhite: Score | null, mover: Color, mateZeroWins: boolean): number | null {
  if (!scoreWhite) return null;
  // `mate 0`: the side to move is checkmated, so the mover of the move that led here has won.
  if (scoreWhite.kind === 'mate' && scoreWhite.value === 0) return mateZeroWins ? 1 : 0;
  return scoreToWin(mover === 'w' ? scoreWhite : negateScore(scoreWhite));
}

/**
 * The plies with their compact analysis applied (classification, evaluation, the key moments'
 * headlines; a book verdict marks `isBook`), and the start position's evaluation. A malformed
 * token leaves its ply unanalyzed; an analysis for a different number of plies is ignored.
 */
export function decodeAnalysis(
  plies: readonly Ply[],
  analysis: CompactAnalysis | null | undefined,
): { plies: Ply[]; startEval: Score | null } {
  const out = plies.map((p) => ({ ...p }));
  if (!analysis) return { plies: out, startEval: null };
  const tokens = analysis.p ? analysis.p.split(' ') : [];
  if (tokens.length !== plies.length) return { plies: out, startEval: null };
  const startEval = decodeScore(analysis.s);
  // Kept before the history stored `wonAnyway`: it is judged from the evaluations kept.
  const legacy = analysis.w !== 1;
  let prevEval: Score | null = startEval;
  out.forEach((p, i) => {
    const m = TOKEN.exec(tokens[i]);
    const evalWhite = m ? decodeScore(m[2]) : null;
    const before = prevEval;
    prevEval = evalWhite;
    if (!m) return;
    if (evalWhite) p.evalWhite = evalWhite;
    const cls = CODE_CLASS[m[1]];
    if (!cls) return;
    // The mover's chances before (best play from the previous position) and after the move.
    const winBefore = moverWin(before, p.color, false) ?? 0.5;
    const winAfter = moverWin(evalWhite, p.color, true) ?? winBefore;
    const best = m[6] ?? null;
    const flags = m[3];
    const cl: Classification = {
      cls,
      winBefore,
      winAfter,
      winLoss: Math.max(0, winBefore - winAfter),
      accuracy: moveAccuracy(winBefore, winAfter),
      bestMoveUci: best ?? p.uci,
      bestMoveSan: best ? uciToSan(p.fenBefore, best) : p.san,
      playedMoveSan: p.san,
    };
    if (flags.includes('n') || flags.includes('a')) cl.nearBest = true;
    if (flags.includes('a')) cl.aboveBest = true;
    if (best && !cl.bestMoveSan) {
      // A better move that is not legal here: damaged data, the verdict stands without it.
      cl.bestMoveUci = p.uci;
      cl.bestMoveSan = p.san;
      delete cl.nearBest;
      delete cl.aboveBest;
    }
    const won: WonAnyway | null = m[4]
      ? { kind: m[4] === 'w' ? 'slower' : 'lost', mateIn: Number(m[5]) }
      : legacy
        ? wonAnywayFromEvals(cls, before, evalWhite, p.color)
        : null;
    if (won && won.mateIn > 0) cl.wonAnyway = won;
    p.classification = cl;
    if (cls === 'book') p.isBook = true;
    const headline = analysis.h?.[String(i)];
    if (headline) {
      const e: Explanation = { headline, details: [] };
      if (flags.includes('c')) e.concedes = 'material';
      else if (flags.includes('d')) e.concedes = 'mate';
      p.explanation = e;
    }
  });
  return { plies: out, startEval };
}

/** Every move after the ones the game started with has its verdict and evaluation (nothing to analyze). */
export function analysisComplete(plies: readonly Ply[], preplayed?: number): boolean {
  return plies.slice(ownStart(plies, preplayed)).every((p) => !!p.classification && !!p.evalWhite);
}

/** An earlier game ready to replay: its moves from the PGN, with the analysis kept in its record. */
export interface ArchivedGame {
  startFen: string;
  plies: Ply[];
  /** White-POV evaluation of the start position, when known. */
  startEval: Score | null;
  /** The PGN's tags (Event, Date, Opening…). */
  headers: Record<string, string>;
}

/**
 * The moves of a recorded game, replayed from its PGN (a [FEN] tag sets the start position), as
 * plies (no analysis). Null when there are none: the PGN was dropped to save space, or it is
 * unreadable.
 */
export function pgnPlies(pgn: string): { startFen: string; plies: Ply[]; headers: Record<string, string> } | null {
  if (!pgn.trim()) return null;
  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch {
    return null;
  }
  const headers = chess.getHeaders();
  const history = chess.history({ verbose: true }) as Move[];
  const startFen = history[0]?.before ?? headers.FEN ?? START_FEN;
  const plies: Ply[] = history.map((mv, index) => {
    const p: Ply = {
      index,
      color: mv.color,
      san: mv.san,
      uci: mv.from + mv.to + (mv.promotion ?? ''),
      fenBefore: mv.before,
      fenAfter: mv.after,
    };
    if (mv.captured) p.captured = mv.captured;
    return p;
  });
  return { startFen, plies, headers };
}

/** A recorded game with its analysis applied (see `pgnPlies`, `decodeAnalysis`); null without moves. */
export function archivedGame(record: GameRecord): ArchivedGame | null {
  const moves = pgnPlies(record.pgn);
  if (!moves) return null;
  const { plies, startEval } = decodeAnalysis(moves.plies, record.analysis);
  return { startFen: moves.startFen, plies, startEval, headers: moves.headers };
}

/** The opponent of a recorded game: its persona (by id, else by name), else a custom one at its Elo. */
export function recordBot(record: Pick<GameRecord, 'botId' | 'botName' | 'botElo'>): BotPersona {
  if (record.botId && record.botId !== 'custom') {
    const p = personaById(record.botId);
    if (p) return p;
  }
  const named = BOTS.find((b) => b.name === record.botName);
  if (named && (!record.botId || record.botId !== 'custom')) return named;
  return customPersona(record.botElo);
}

/** The PGN date "YYYY.MM.DD" as a local date (null when malformed). */
function pgnDateOf(text: string | undefined): Date | null {
  const m = text ? /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(text) : null;
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The PGN to export for a recorded game: its own tags with the moves annotated as the app exports
 * a game (`[%eval]` comments and move marks) when it has been analyzed, else the stored PGN as it is.
 */
export function archivePgn(record: GameRecord, game: ArchivedGame | null): string {
  if (!game || !game.plies.some((p) => p.classification || p.evalWhite)) return record.pgn;
  const h = game.headers;
  const elo = (v: string | undefined): number | undefined => (v && /^\d{1,4}$/.test(v) ? Number(v) : undefined);
  const player = (name: string | undefined, rating: string | undefined, fallback: string): PgnPlayer => {
    const e = elo(rating);
    return { name: name || fallback, ...(e !== undefined ? { elo: e } : {}) };
  };
  const result: GameResult | '*' = h.Result === '1-0' || h.Result === '0-1' || h.Result === '1/2-1/2' ? h.Result : record.result;
  return buildPgn({
    ...(h.Event ? { event: h.Event } : {}),
    startFen: game.startFen,
    plies: game.plies,
    white: player(h.White, h.WhiteElo, record.playerColor === 'w' ? 'You' : record.botName),
    black: player(h.Black, h.BlackElo, record.playerColor === 'b' ? 'You' : record.botName),
    date: pgnDateOf(h.Date) ?? new Date(record.date),
    result,
    termination: h.Termination || record.reason,
    opening: h.ECO && h.Opening ? { eco: h.ECO, name: h.Opening } : null,
    annotations: true,
  });
}
