/**
 * "Try again" from Game Review's key moments (README "Game Review"): one of the player's weak moves
 * (an inaccuracy, mistake, miss or blunder listed as a key moment) is set up again, the position
 * before it with the player to move, for the player to find a better move. A wrong move is taken
 * back, with hints that name the piece and then its square, and "Show answer" names the engine's
 * best move.
 *
 * This module is the pure part: which moves can be tried again, the state of one try and its
 * transitions, the hints and the wording. The controller checks each attempt with the engine
 * (GameController `tryAgain`, `practiceMove`) and the store renders it (`store.practice`). It works
 * on any game's plies (`PracticeGame`): the game on the board once it is over, or an earlier game
 * from the history.
 */
import { Chess, type Square } from 'chess.js';
import type { Classification, Explanation, MoveClass } from '../analysis/types';
import type { BotPersona } from '../bot/types';
import { PIECE_NAMES, toUci } from '../chess/utils';
import type { Score } from '../engine/types';
import { classLabel, concession, moveLabel } from './coach';
import { summarizeGame } from './review';
import type { Color, Ply, PromotionPiece } from './types';

/** The player's key moments that can be tried again: an inaccuracy or worse. */
export const TRY_AGAIN_CLASSES: ReadonlySet<MoveClass> = new Set<MoveClass>(['inaccuracy', 'mistake', 'miss', 'blunder']);

/**
 * An attempt with one of these classes finds a better move (as does the engine's best move, and a
 * move about as good as it, analysis/nearEqual.ts), unless its text says what it gives away
 * (coach.ts `concession`).
 */
export const SOLVED_CLASSES: ReadonlySet<MoveClass> = new Set<MoveClass>([
  'brilliant',
  'great',
  'best',
  'excellent',
  'good',
  'book',
  'forced',
]);

/** The title of the panel after a move that does not find a better one. */
export const NOT_QUITE = 'Not quite — try again';
/** The move the player made in the game, played again. */
export const SAME_MOVE_LINE = 'That’s the move you played in the game.';
/** The best move, or a move the engine ranks with it. */
export const FOUND_BEST_LINE = 'You found the best move!';
/** A move about as good as the best (analysis/nearEqual.ts). */
export const FOUND_NEAR_LINE = 'That’s about as good as the best move!';

/** A game to try moves of again: the game on the board, or an earlier one from the history. */
export interface PracticeGame {
  /** The game's id (`GameInfo.id`, `GameRecord.id`). */
  id: string;
  startFen: string;
  playerColor: Color;
  /** The opponent (Play on from here plays it again): a persona of src/bot/personas.ts, or `customPersona(elo)`. */
  bot: BotPersona;
  botElo: number;
  /**
   * The game's plies with their annotations: the moves to try again need their classification; the
   * explanation is optional (it says why the move was weak, without the answer).
   */
  plies: readonly Ply[];
  /** White-POV eval of the start position, when known (the eval bar before the first move). */
  startEval?: Score | null;
  /** Opening practice: the moves the game started with (never tried again). */
  preplayed?: number;
  /**
   * Where it comes from: the game on the board after it ended ('current', back to its review or its
   * final position), or the history ('archive', back to the game's viewer).
   */
  source: 'current' | 'archive';
}

/**
 * Where a try stands: waiting for the player's move, checking it with the engine, a move that was
 * not better (taken back; the player tries again), a better move found, or the answer shown.
 */
export type PracticeStatus = 'waiting' | 'checking' | 'wrong' | 'solved' | 'revealed';

/** The engine's verdict on an attempt, as the annotations give it for a game's move. */
export interface PracticeRating {
  classification: Classification;
  explanation: Explanation;
  /** Evaluation of the position after the attempt, White's point of view. */
  evalWhite: Score;
  evalDepth: number;
}

/** A move the player tried. */
export interface PracticeAttempt {
  uci: string;
  san: string;
  color: Color;
  fenBefore: string;
  fenAfter: string;
  captured?: string;
  /** The engine's verdict, once checked. */
  rating?: PracticeRating;
  /** The move the player made in the game: never the answer (judged without the engine). */
  same?: true;
}

/** The engine's best move in the position (what the hints point at and Show answer names). */
export interface PracticeAnswer {
  uci: string;
  san: string;
  /** What the coach says about it (the best move's explanation and line); empty when nothing is known. */
  lines: string[];
}

/** One try at a better move (see the module comment). */
export interface Practice {
  game: PracticeGame;
  /** The ply tried again (`game.plies[index]`, the player's move). */
  index: number;
  status: PracticeStatus;
  /** The attempt on the board ('checking', 'solved'). */
  attempt: PracticeAttempt | null;
  /** The last attempt that was not better ('wrong'): taken back, it is what the panel talks about. */
  tried: PracticeAttempt | null;
  /** Attempts that were not better. */
  tries: number;
  /** Hints shown: 1 names the piece to move, 2 its square. */
  hint: 0 | 1 | 2;
  /**
   * The engine's best move here, once the position has been analyzed (undefined until then; null
   * when it could not be found: no engine line and no saved best move).
   */
  answer?: PracticeAnswer | null;
  /** The last check did not finish (the engine): the move was taken back, to be tried again. */
  failed: boolean;
  /** Bumped for every try (a new moment, Next mistake): late analyses of another one are dropped. */
  session: number;
  /**
   * The try's own board orientation: the player's side at the bottom unless flipped. Flip during a
   * try turns only the try's board (never the game's, nor the viewer's).
   */
  flipped: boolean;
}

/** The key of a game's ply among the tries whose answer was shown (`store.revealedTries`). */
export function tryKey(gameId: string, index: number): string {
  return `${gameId}:${index}`;
}

/** The plies that count (opening practice's preplayed moves never do). */
function ownPlies(game: PracticeGame): readonly Ply[] {
  const pre = Math.min(Math.max(0, game.preplayed ?? 0), game.plies.length);
  return pre ? game.plies.slice(pre) : game.plies;
}

/**
 * The plies of `game` that can be tried again, in game order: the player's key moments (as Game
 * Review lists them, review.ts `summarizeGame`) that were an inaccuracy, mistake, miss or blunder.
 */
export function practiceMoments(game: PracticeGame): number[] {
  const own = ownPlies(game);
  if (!own.length) return [];
  const startFen = own[0].fenBefore;
  return summarizeGame(startFen, null, own, game.playerColor)
    .keyMoments.filter((m) => m.color === game.playerColor && TRY_AGAIN_CLASSES.has(m.cls) && !m.concedes)
    .map((m) => m.index)
    .filter((i) => game.plies[i]?.color === game.playerColor)
    .sort((a, b) => a - b);
}

/** Ply `index` of `game` can be tried again (see `practiceMoments`). */
export function canTryAgain(game: PracticeGame, index: number): boolean {
  return practiceMoments(game).includes(index);
}

/** The next move to try again after `index` (game order), or null when it was the last one. */
export function nextMoment(game: PracticeGame, index: number): number | null {
  return practiceMoments(game).find((i) => i > index) ?? null;
}

/** A new try at ply `index` (no checks: see `canTryAgain`), its board flipped or not. */
export function startPractice(game: PracticeGame, index: number, session: number, flipped = false): Practice {
  return { game, index, status: 'waiting', attempt: null, tried: null, tries: 0, hint: 0, failed: false, session, flipped };
}

/** The ply tried again. */
export function practicePly(p: Pick<Practice, 'game' | 'index'>): Ply {
  return p.game.plies[p.index];
}

/** The position on the board: the attempt being checked or found, else the position before the move. */
export function practiceFen(p: Practice): string {
  return p.attempt?.fenAfter ?? practicePly(p).fenBefore;
}

/** The player may make a move now (waiting, or after a move that was not better). */
export function awaitsMove(p: Practice): boolean {
  return p.status === 'waiting' || p.status === 'wrong';
}

/** The try is over: a better move was found, or the answer shown. */
export function isSettled(p: Practice): boolean {
  return p.status === 'solved' || p.status === 'revealed';
}

/**
 * The player's move `from`-`to` on the board (a pawn reaching the last rank without `promotion`
 * becomes a queen), or null when no move is awaited or it is illegal. The move made in the game
 * is not better by definition: it is 'wrong' at once (`same`), with no engine check; any other
 * move is on the board, 'checking'.
 */
export function playAttempt(p: Practice, from: string, to: string, promotion?: PromotionPiece): Practice | null {
  if (!awaitsMove(p)) return null;
  const ply = practicePly(p);
  const chess = new Chess(ply.fenBefore);
  let mv;
  try {
    mv = chess.move({ from, to, ...(promotion ? { promotion } : {}) });
  } catch {
    if (promotion) return null;
    try {
      mv = chess.move({ from, to, promotion: 'q' });
    } catch {
      return null;
    }
  }
  const attempt: PracticeAttempt = {
    uci: toUci(mv),
    san: mv.san,
    color: mv.color,
    fenBefore: mv.before,
    fenAfter: mv.after,
    ...(mv.captured ? { captured: mv.captured } : {}),
  };
  if (attempt.uci === ply.uci) {
    return { ...p, status: 'wrong', attempt: null, tried: { ...attempt, same: true }, tries: p.tries + 1, failed: false };
  }
  return { ...p, status: 'checking', attempt, failed: false };
}

/**
 * The attempt finds a better move: the engine's best move, a move about as good as it, or one of
 * `SOLVED_CLASSES` that gives nothing away; never the move made in the game.
 */
export function isSolution(r: Pick<PracticeRating, 'classification' | 'explanation'>, uci: string, playedUci: string): boolean {
  if (uci === playedUci) return false;
  const cl = r.classification;
  if (cl.bestMoveUci === uci || cl.nearBest === true) return true;
  return SOLVED_CLASSES.has(cl.cls) && !concession(r);
}

/** The engine's verdict on the attempt being checked: 'solved', or 'wrong' with the attempt taken back. */
export function judgeAttempt(p: Practice, rating: PracticeRating): Practice {
  const a = p.attempt;
  if (p.status !== 'checking' || !a) return p;
  const judged: PracticeAttempt = { ...a, rating };
  if (isSolution(rating, a.uci, practicePly(p).uci)) return { ...p, status: 'solved', attempt: judged };
  return { ...p, status: 'wrong', attempt: null, tried: judged, tries: p.tries + 1 };
}

/** The check of the attempt did not finish: the move goes back, to be tried again (`failed`). */
export function attemptFailed(p: Practice): Practice {
  if (p.status !== 'checking') return p;
  return { ...p, status: 'waiting', attempt: null, tried: null, failed: true };
}

/** One more hint (the piece, then its square), while a move is awaited. */
export function moreHint(p: Practice): Practice {
  if (!awaitsMove(p) || p.hint >= 2) return p;
  return { ...p, hint: (p.hint + 1) as 1 | 2 };
}

/** "Show answer": the try ends with the engine's best move named (an attempt being checked is dropped). */
export function revealAnswer(p: Practice): Practice {
  if (isSettled(p)) return p;
  return { ...p, status: 'revealed', attempt: null, failed: false };
}

/** The engine's best move, once the search is done (null: none could be found). */
export function withAnswer(p: Practice, answer: PracticeAnswer | null): Practice {
  return { ...p, answer };
}

/**
 * The answer's move among the engine's lines of the position before the ply: the best move that is
 * not the one made in the game (a re-analysis can rank it first), else the saved classification's
 * best move; null when neither is known.
 */
export function answerMove(
  ply: Pick<Ply, 'uci' | 'classification'>,
  lines: readonly { pv: readonly string[] }[] | undefined,
): string | null {
  const line = lines?.find((l) => !!l.pv[0] && l.pv[0] !== ply.uci);
  if (line) return line.pv[0];
  const best = ply.classification?.bestMoveUci;
  return best && best !== ply.uci ? best : null;
}

/**
 * A hint for the answer `uci` in `fen` (as the openings drill words them): level 1 the piece ("Move
 * your knight.", "Move a knight." when there are several), level 2 its square ("Move the knight on
 * f3."). Castling is a king move.
 */
export function hintText(fen: string, uci: string, level: 1 | 2): string {
  let piece = 'p';
  let count = 1;
  try {
    const chess = new Chess(fen);
    const p = chess.get(uci.slice(0, 2) as Square);
    if (p) {
      piece = p.type;
      count = chess
        .board()
        .flat()
        .filter((sq) => sq && sq.color === p.color && sq.type === p.type).length;
    }
  } catch {
    // A malformed FEN: the generic words below.
  }
  const name = PIECE_NAMES[piece] ?? 'piece';
  if (level === 1) return `Move ${count === 1 ? 'your' : 'a'} ${name}.`;
  return `Move the ${name} on ${uci.slice(0, 2)}.`;
}

/** The prompt: "Find a better move than Qxb2". */
export function practiceTitle(ply: Pick<Ply, 'san'>): string {
  return `Find a better move than ${ply.san}`;
}

/** What the move in the game was: "In the game you played 12. Qxb2, a blunder." */
export function playedLine(ply: Pick<Ply, 'fenBefore' | 'san' | 'color' | 'index' | 'classification'>): string {
  const cls = ply.classification?.cls;
  const label = moveLabel(ply);
  if (!cls) return `In the game you played ${label}.`;
  const name = classLabel(cls).toLowerCase();
  return `In the game you played ${label}, ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}.`;
}

/**
 * The first line about an attempt that was not better: the move made in the game again, or its
 * verdict ("Qd3 is a blunder.", "Qd3 gives up material.", "Qd3 is good, but no better."). The
 * reason follows from its explanation (without the answer).
 */
export function triedLine(a: PracticeAttempt): string {
  if (a.same) return SAME_MOVE_LINE;
  const r = a.rating;
  if (!r) return `${a.san} is no better.`;
  if (concession(r)) return `${a.san} gives up material.`;
  const cls = r.classification.cls;
  if (TRY_AGAIN_CLASSES.has(cls)) {
    const name = classLabel(cls).toLowerCase();
    return `${a.san} is ${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}.`;
  }
  return `${a.san} is no better.`;
}

/** The panel's title after a better move: the news first ("You found it: 3. Bc4"); its verdict follows. */
export function solvedTitle(a: Pick<PracticeAttempt, 'san' | 'color' | 'fenBefore'> & { index: number }): string {
  return `You found it: ${moveLabel(a)}`;
}

/**
 * The first line after a better move: "You found the best move!", "That’s about as good as the
 * best move!", or "That’s better than Qxb2." (a good move that the engine ranks lower).
 */
export function solvedLine(a: PracticeAttempt, playedSan: string): string {
  const cl = a.rating?.classification;
  if (cl && (cl.bestMoveUci === a.uci || cl.cls === 'brilliant' || cl.cls === 'great' || cl.cls === 'best')) return FOUND_BEST_LINE;
  if (cl?.nearBest === true) return FOUND_NEAR_LINE;
  return `That’s better than ${playedSan}.`;
}

/** After the try: there is no next move to try again. */
export function lastMomentLine(game: PracticeGame): string {
  return practiceMoments(game).length === 1 ? 'That was your only mistake in this game.' : 'That was your last mistake in this game.';
}
