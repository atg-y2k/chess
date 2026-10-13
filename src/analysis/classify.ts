/**
 * chess.com-style move classification.
 *
 * Base classes use chess.com's published Expected-Points (EP) loss table; EP is the lichess
 * logistic of the mover's centipawn score (unclamped; mate = 1 / 0, draw = 0.5). The special classes
 * (Brilliant, Great, Miss, Book, Forced) follow chess.com's definitions with our own thresholds,
 * because chess.com does not publish them. All probabilities are 0..1.
 */
import { Chess } from 'chess.js';
import type { AnalysisResult, Score } from '../engine/types';
import { parseUci, uciToSan } from '../chess/utils';
import type { Color } from '../game/types';
import type { Classification, EqualMove, MoveClass, WonAnyway } from './types';
import { accuracyWin, moveAccuracy } from './accuracy';
import { aboutAsGood, NEAR_EQUAL_RECHECK_CP, NEAR_EQUAL_SEARCH_CP, nearEqualLines, scoreRank } from './nearEqual';
import { capturedFreeMaterial, detectSacrifice, isObviousEscape, MIN_SACRIFICE, type Sacrifice } from './sacrifice';
import { childToMover, CP_CEILING, cpToWin, negateScore, scoreToWin, type TerminalKind } from './winprob';

/** Upper bounds (exclusive) of EP loss per class, from chess.com's table. Loss >= mistake is a blunder. */
export const EP_THRESHOLDS = { excellent: 0.02, good: 0.05, inaccuracy: 0.1, mistake: 0.2 } as const;
/** Positions at or above this EP are "winning" for the mover (about +3.0). */
export const WINNING_EP = 0.75;
/** Positions at or below this EP are "losing" for the mover (about -3.0). */
export const LOSING_EP = 0.25;
/** Miss: the opponent's previous move must have lost at least this much EP. */
export const MISS_MIN_OPPONENT_LOSS = 0.1;
/** Miss: the mover may end at most this much EP below where they stood before the opponent's error. */
export const MISS_TOLERANCE = 0.1;
/** Great (outcome-changing): minimum EP gap to the second-best move when it also changes the state. */
export const GREAT_STATE_GAP = 0.05;
/** Great is not awarded when there are this few legal moves or fewer. */
export const GREAT_MIN_LEGAL_MOVES = 4;

/** Rating-dependent leniency for Brilliant and Great (chess.com: "more generous for lower-rated players"). */
export interface RatingTier {
  /** Max EP loss for a Brilliant sacrifice (0 = must be the top move). */
  brilliantMaxLoss: number;
  /** Min EP after a Brilliant move ("not in a bad position"). */
  brilliantMinAfter: number;
  /** When the best alternative already has this EP (or mates) the mover was "winning anyway". */
  winningAnyway: number;
  /** Min EP gap between the best and second-best move for a Great "only move". */
  greatGap: number;
  /** Min EP after a Great move. */
  greatMinAfter: number;
}

/** Thresholds for Brilliant / Great by player rating (unknown rating = club tier). */
export function ratingTier(rating?: number): RatingTier {
  // winningAnyway: EP 0.90 / 0.88 / 0.86 is about +6.0 / +5.4 / +4.9 pawns, so a queen up always
  // counts as "already winning".
  if (rating != null && rating < 1200) {
    return { brilliantMaxLoss: 0.03, brilliantMinAfter: 0.45, winningAnyway: 0.9, greatGap: 0.08, greatMinAfter: 0.4 };
  }
  if (rating != null && rating >= 2000) {
    return { brilliantMaxLoss: 0.01, brilliantMinAfter: 0.5, winningAnyway: 0.86, greatGap: 0.12, greatMinAfter: 0.45 };
  }
  return { brilliantMaxLoss: 0.02, brilliantMinAfter: 0.5, winningAnyway: 0.88, greatGap: 0.1, greatMinAfter: 0.45 };
}

/** Base class for an EP loss (0..1), from Excellent to Blunder. */
export function classifyByWinLoss(loss: number): MoveClass {
  if (loss < EP_THRESHOLDS.excellent) return 'excellent';
  if (loss < EP_THRESHOLDS.good) return 'good';
  if (loss < EP_THRESHOLDS.inaccuracy) return 'inaccuracy';
  if (loss < EP_THRESHOLDS.mistake) return 'mistake';
  return 'blunder';
}

/** Mover-POV evaluation: an engine score, or a finished game (1 = the mover won, 0.5 = draw, 0 = lost). */
export type MoverEval = Score | { kind: 'result'; value: 0 | 0.5 | 1 };

/** Expected points (0..1) of a mover-POV evaluation. */
export function evalToWin(e: MoverEval): number {
  return e.kind === 'result' ? e.value : scoreToWin(e);
}

/** Win probability (0..1) lichess uses for accuracy: cp clamped to ±1000, mate = ±1000 cp. */
function evalToAccuracyWin(e: MoverEval): number {
  if (e.kind !== 'result') return accuracyWin(e);
  return e.value === 0.5 ? 0.5 : cpToWin(e.value === 1 ? CP_CEILING : -CP_CEILING);
}

/** A mover-POV evaluation as an engine score: a finished game as a mate (won / lost) or 0.00 (draw). */
function evalScore(e: MoverEval): Score {
  if (e.kind !== 'result') return e;
  return e.value === 0.5 ? { kind: 'cp', value: 0 } : { kind: 'mate', value: e.value === 1 ? 1 : 0 };
}

const isMateFor = (e: MoverEval) => (e.kind === 'mate' && e.value > 0) || (e.kind === 'result' && e.value === 1);
const isMatedAgainst = (e: MoverEval) =>
  (e.kind === 'mate' && e.value <= 0) || (e.kind === 'result' && e.value === 0);
const stateRank = (ep: number) => (ep >= WINNING_EP ? 2 : ep > LOSING_EP ? 1 : 0);

const SEVERITY: MoveClass[] = ['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'];
const worst = (a: MoveClass, b: MoveClass) => (SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b);

/** Why a class was given (for coaching text and debugging). */
export type ClassReason =
  | 'book'
  | 'book_refused'
  | 'forced'
  | 'mate_delivered'
  | 'top_move'
  | 'tie'
  | 'only_move'
  | 'outcome_changing'
  | 'sacrifice'
  | 'missed_win'
  | 'allowed_mate'
  | 'lost_mate'
  | 'mate_slower'
  | 'mated_anyway'
  | 'hangs_material'
  | 'ep_loss'
  | 'estimated'
  | 'no_data';

/** Engine-level facts about one move, all in the mover's point of view. */
export interface ClassifyFacts {
  /** Engine lines of the position before the move, best first (MultiPV >= 2 recommended). */
  lines: { uci: string; score: MoverEval }[];
  playedUci: string;
  /**
   * Evaluation after the played move: the matching line's score when the move is in `lines` (same
   * search; a forced mate the child search finds replaces a centipawn score there), otherwise the
   * converted child search. null = unknown (the worst line is then used as an optimistic estimate
   * and the class is capped at Good).
   */
  played: MoverEval | null;
  legalMoveCount: number;
  inCheckBefore: boolean;
  isBook?: boolean;
  isPromotion?: boolean;
  /**
   * Net material the move newly leaves en prise (see `detectSacrifice`), or null. `ignoresThreat`:
   * the piece was attacked by the opponent's last move and the move leaves it (Brilliant only as
   * the top move, when it is also the only good one).
   */
  sacrifice?: { netValue: number; ignoresThreat?: boolean } | null;
  /** The move won material by static exchange or was a plain recapture (never Great). */
  capturedFreeMaterial?: boolean;
  /** The move only takes an attacked piece to its one safe square (never Great). */
  obviousEscape?: boolean;
  /** EP loss of the opponent's previous move (for Miss). */
  opponentPrevWinLoss?: number;
  rating?: number;
}

export interface ClassifyVerdict {
  cls: MoveClass;
  winBefore: number;
  winAfter: number;
  winLoss: number;
  accuracy: number;
  reasons: ClassReason[];
  /** See `Classification.wonAnyway` (and `wonAnywayOf`). */
  wonAnyway?: WonAnyway;
}

/**
 * Base class of a non-special move: Best for the top move or an exact tie, the mate-distance ladders
 * when both sides of the comparison are mates, otherwise the EP-loss table with lichess's mate floors.
 */
function baseClass(
  best: MoverEval,
  played: MoverEval,
  o: { isTop: boolean; tie: boolean; estimated: boolean; loss: number },
  reasons: ClassReason[],
): MoveClass {
  if (o.isTop) {
    reasons.push('top_move');
    return 'best';
  }
  if (best.kind === 'mate' && played.kind === 'mate' && best.value > 0 && played.value > 0) {
    const slower = played.value - best.value;
    reasons.push('mate_slower');
    return slower <= 0 ? 'best' : slower <= 2 ? 'excellent' : slower <= 6 ? 'good' : 'inaccuracy';
  }
  if (best.kind === 'mate' && played.kind === 'mate' && best.value < 0 && played.value < 0) {
    const sooner = played.value - best.value; // both negative: > 0 when mated sooner
    reasons.push('mated_anyway');
    return sooner <= 0 ? 'best' : sooner <= 2 ? 'excellent' : 'good';
  }
  let cls: MoveClass;
  if (o.tie) {
    reasons.push('tie');
    cls = 'best';
  } else {
    reasons.push(o.estimated ? 'estimated' : 'ep_loss');
    cls = classifyByWinLoss(o.loss);
  }
  // lichess floors (Advice.scala): allowing a forced mate, or throwing away your own, is a blunder,
  // only a mistake beyond ±7 and an inaccuracy beyond ±10 (when the game was decided anyway).
  if (!isMatedAgainst(best) && isMatedAgainst(played)) {
    const cp = best.kind === 'cp' ? best.value : 0;
    cls = worst(cls, cp < -999 ? 'inaccuracy' : cp < -700 ? 'mistake' : 'blunder');
    reasons.push('allowed_mate');
  }
  if (isMateFor(best) && !isMateFor(played)) {
    const cp = played.kind === 'cp' ? played.value : 0;
    cls = worst(cls, cp > 999 ? 'inaccuracy' : cp > 700 ? 'mistake' : 'blunder');
    reasons.push('lost_mate');
  }
  // An unsearched move is at most as good as the worst searched line: do not overpraise it.
  return o.estimated ? worst(cls, 'good') : cls;
}

/**
 * `Classification.wonAnyway`: a weak class that only the mate-distance rules gave, while the move
 * kept a won game. Either a checkmate more than six moves slower than the best one (the coach's own
 * `mate_slower` ladder), or a forced mate given up for a position still +10 or better (lichess's
 * `lost_mate` floor, when the loss in winning chances alone would not make the move weak). The best
 * line is a forced mate either way (`mateIn`). Only ever an inaccuracy (the ladder stops there, and
 * the floor gives one from +10 on). Null for any other move.
 */
function wonAnywayOf(
  cls: MoveClass,
  best: MoverEval,
  played: MoverEval,
  loss: number,
  reasons: readonly ClassReason[],
): WonAnyway | null {
  if (!WEAK.has(cls) || best.kind !== 'mate' || best.value <= 0) return null;
  if (reasons.includes('mate_slower') && isMateFor(played)) return { kind: 'slower', mateIn: best.value };
  const keepsWon = played.kind === 'cp' && played.value >= CP_CEILING;
  if (reasons.includes('lost_mate') && keepsWon && !WEAK.has(classifyByWinLoss(loss))) return { kind: 'lost', mateIn: best.value };
  return null;
}

/**
 * `Classification.wonAnyway` from the evaluations a game record keeps, for records kept before the
 * game history stored it (game/archive.ts `decodeAnalysis`): White's point of view of the position
 * before the move (best play) and after it, as `Ply.evalWhite` stores them. An inaccuracy (the only
 * class `wonAnywayOf` gives it) from a forced mate that still mates ('slower') or keeps +10 or better
 * ('lost'). Null when an evaluation is missing or the move does not fit.
 */
export function wonAnywayFromEvals(
  cls: MoveClass,
  beforeWhite: Score | null | undefined,
  afterWhite: Score | null | undefined,
  mover: Color,
): WonAnyway | null {
  if (cls !== 'inaccuracy' || !beforeWhite || !afterWhite) return null;
  const mine = (s: Score): Score => (mover === 'w' ? s : negateScore(s));
  const before = mine(beforeWhite);
  if (before.kind !== 'mate' || before.value <= 0) return null;
  // `mate 0` after the move: it checkmated, never a weak move.
  if (afterWhite.kind === 'mate' && afterWhite.value === 0) return null;
  const after = mine(afterWhite);
  if (after.kind === 'mate') return after.value > 0 ? { kind: 'slower', mateIn: before.value } : null;
  return after.value >= CP_CEILING ? { kind: 'lost', mateIn: before.value } : null;
}

/** Classifies a move from engine evaluations alone (no board access). */
export function classifyFromEvals(f: ClassifyFacts): ClassifyVerdict {
  const t = ratingTier(f.rating);
  const reasons: ClassReason[] = [];
  const best = f.lines[0];
  const inLines = f.lines.find((l) => l.uci === f.playedUci);
  const isTop = best != null && best.uci === f.playedUci;

  let played = f.played ?? inLines?.score ?? null;
  // The top move's value is the top line's value (same search), unless the game ended.
  if (isTop && played?.kind !== 'result') played = best.score;
  const estimated = played == null && best != null;
  if (estimated) played = f.lines[f.lines.length - 1].score;

  const epPlayed = played ? evalToWin(played) : 0.5;
  const epBest = best ? evalToWin(best.score) : epPlayed;
  const loss = Math.max(0, epBest - epPlayed);
  const accuracy = best && played ? moveAccuracy(evalToAccuracyWin(best.score), evalToAccuracyWin(played)) : 100;
  const verdict = (cls: MoveClass): ClassifyVerdict => {
    const won = best && played && !estimated ? wonAnywayOf(cls, best.score, played, loss, reasons) : null;
    return { cls, winBefore: epBest, winAfter: epPlayed, winLoss: loss, accuracy, reasons, ...(won ? { wonAnyway: won } : {}) };
  };

  let base: MoveClass = 'good';
  if (best && played) {
    const tie = loss === 0 && inLines != null && !estimated;
    base = baseClass(best.score, played, { isTop, tie, estimated, loss }, reasons);
  } else {
    reasons.push('no_data');
  }

  // 1. Book (unless the engine calls it a mistake), Forced, checkmate.
  if (f.isBook) {
    if (base !== 'mistake' && base !== 'blunder') {
      reasons.unshift('book');
      return verdict('book');
    }
    reasons.push('book_refused');
  }
  if (f.legalMoveCount === 1) {
    reasons.unshift('forced');
    return verdict('forced');
  }
  if (played?.kind === 'result' && played.value === 1) {
    reasons.unshift('mate_delivered');
    return verdict('best');
  }
  if (!best || !played || estimated) return verdict(base);

  // The best line that is not the played move, and whether the mover was winning anyway.
  const alt = f.lines.find((l) => l.uci !== f.playedUci);
  const epAlt = alt ? evalToWin(alt.score) : null;
  const winningAnyway = alt == null || epAlt == null || isMateFor(alt.score) || epAlt >= t.winningAnyway;

  // 2. Brilliant: a sound piece sacrifice, (near-)best, not bad afterwards, not winning anyway.
  //    Leaving a piece the opponent just attacked en prise must also be the only good move.
  const criticalTop = isTop && epAlt != null && epBest - epAlt >= t.greatGap;
  if (
    f.sacrifice &&
    f.sacrifice.netValue >= MIN_SACRIFICE &&
    (!f.sacrifice.ignoresThreat || criticalTop) &&
    loss <= t.brilliantMaxLoss &&
    (base === 'best' || base === 'excellent' || base === 'good') &&
    !f.isPromotion &&
    !f.inCheckBefore &&
    epPlayed >= t.brilliantMinAfter &&
    !winningAnyway
  ) {
    reasons.push('sacrifice');
    return verdict('brilliant');
  }

  // 3. Great: the top move, and it is critical (only good move, or it changes the outcome).
  //    Obvious moves are not Great: escaping check, promoting, winning or recapturing material,
  //    or moving an attacked piece to its only safe square.
  if (
    base === 'best' &&
    isTop &&
    epAlt != null &&
    !f.inCheckBefore &&
    !f.isPromotion &&
    f.legalMoveCount >= GREAT_MIN_LEGAL_MOVES &&
    !f.capturedFreeMaterial &&
    !f.obviousEscape &&
    epPlayed >= t.greatMinAfter &&
    !winningAnyway
  ) {
    const gap = epBest - epAlt;
    if (gap >= t.greatGap) {
      reasons.push('only_move');
      return verdict('great');
    }
    if (gap >= GREAT_STATE_GAP && stateRank(epBest) > stateRank(epAlt)) {
      reasons.push('outcome_changing');
      return verdict('great');
    }
  }

  // 4. Miss: the opponent erred, a winning position was available, and the mover let it go
  //    (ending near where they stood before the opponent's error, not clearly worse).
  const opp = f.opponentPrevWinLoss;
  if (
    (base === 'mistake' || base === 'blunder') &&
    opp != null &&
    opp >= MISS_MIN_OPPONENT_LOSS &&
    (epBest >= WINNING_EP || isMateFor(best.score)) &&
    epPlayed < WINNING_EP &&
    epPlayed >= epBest - opp - MISS_TOLERANCE
  ) {
    reasons.push('missed_win');
    return verdict('miss');
  }

  if (f.sacrifice && (base === 'inaccuracy' || base === 'mistake' || base === 'blunder')) {
    reasons.push('hangs_material');
  }
  return verdict(base);
}

/** Input of `classifyMove` (the Module API in ARCHITECTURE.md, plus optional `prevMove`). */
export interface ClassifyMoveInput {
  fenBefore: string;
  moveUci: string;
  /** Analysis of `fenBefore` (MultiPV >= 2 preferred; 3 recommended). */
  before: AnalysisResult;
  /** Analysis of the position after the move (needed when the move is not in `before.lines`). */
  after?: AnalysisResult & { terminal?: TerminalKind };
  /**
   * Analysis of the position after the engine's best move (`before.lines[0]`), the same kind of
   * search as `after`: the second opinion `nearBestRecheck` asks for, which settles whether the
   * played move was about as good as the best (analysis/nearEqual.ts).
   */
  bestAfter?: AnalysisResult;
  /** `winLoss` of the opponent's previous move (for "miss"). */
  opponentPrevWinLoss?: number;
  /** The resulting position is in the opening book (and every earlier ply was). */
  isBook?: boolean;
  /** Player rating, for the Brilliant / Great tiers. */
  playerRating?: number;
  /** The opponent's previous move; a recapture on its square is never "great". */
  prevMove?: { to: string };
  /**
   * The position before the opponent's previous move. Lets a move that ignores a threat the
   * opponent just made count as a sacrifice; without it, only material the move itself newly puts
   * en prise counts.
   */
  prevFenBefore?: string;
}

export interface ClassifyMoveDetail {
  classification: Classification;
  reasons: ClassReason[];
  /** The piece the move leaves en prise, if any (a Brilliant sacrifice, or hung material). */
  sacrifice: Sacrifice | null;
  /**
   * The position whose search would settle `nearBest` (see `nearBestRecheck`), when it is in doubt
   * and `bestAfter` was not given; null otherwise.
   */
  recheckFen: string | null;
  /**
   * That search can change the class itself, not only the near-equal verdict: a listed move whose
   * own search scores it far above its line is judged against the best move's own search (see
   * `secondOpinionNeed`).
   */
  recheckAffectsClass: boolean;
}

/** Classifies a move and also returns the reasons and any sacrificed / hung piece. Never throws. */
export function classifyMoveDetailed(p: ClassifyMoveInput): ClassifyMoveDetail {
  let legalMoveCount = 0;
  let inCheckBefore = false;
  let isPromotion = false;
  let playedSan: string | null = null;
  let result: 0.5 | 1 | null = null;
  try {
    const chess = new Chess(p.fenBefore);
    legalMoveCount = chess.moves().length;
    inCheckBefore = chess.inCheck();
    const mv = chess.move(parseUci(p.moveUci));
    playedSan = mv.san;
    isPromotion = !!mv.promotion;
    if (chess.isCheckmate()) result = 1;
    else if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.isDrawByFiftyMoves()) result = 0.5;
  } catch {
    // Invalid FEN or illegal move: classify from the engine data alone.
  }
  if (result == null && p.after?.terminal) result = p.after.terminal === 'checkmate' ? 1 : 0.5;

  const allLines = p.before.lines
    .filter((l) => l.pv.length > 0)
    .map((l) => ({ uci: l.pv[0], score: l.score }));
  const inLines = allLines.find((l) => l.uci === p.moveUci);
  const childBest = p.after?.lines[0];
  const child = childBest ? childToMover(childBest.score) : null;
  const bestChildLine = p.bestAfter?.lines[0];
  const bestChild = bestChildLine ? childToMover(bestChildLine.score) : null;
  // A listed move (not the first) whose own search, a ply deeper and only about it, scores it far
  // above its line in the list: a secondary MultiPV line can be badly under-searched at the
  // annotation budget (51…Qb1+: 2.1 in the list, 4.9 by its own search, 6.1 at depth 20). Its own
  // search judges it then, against the best move searched the same way when that is at hand
  // (`bestAfter`, which `nearBestRecheck` asks for), so the class agrees with the eval graph.
  const disputed =
    result == null &&
    !!inLines &&
    inLines !== allLines[0] &&
    child?.kind === 'cp' &&
    inLines.score.kind === 'cp' &&
    child.value - inLines.score.value > LISTED_DISPUTE_CP;
  const lines =
    disputed && bestChild?.kind === 'cp' && allLines[0]?.score.kind === 'cp'
      ? [{ ...allLines[0], score: bestChild }, ...allLines.slice(1)]
      : allLines;
  let played: MoverEval | null = null;
  if (result != null) played = { kind: 'result', value: result };
  else if (disputed) played = child;
  // The child search is one ply deeper on this move: a forced mate it finds (for either side) beats
  // the before-search's centipawn score, as the explanation already describes that mate.
  else if (inLines) played = child?.kind === 'mate' && inLines.score.kind !== 'mate' ? child : inLines.score;
  else if (child) played = child;

  const sacrifice = playedSan ? detectSacrifice(p.fenBefore, p.moveUci, p.prevFenBefore) : null;
  const v = classifyFromEvals({
    lines,
    playedUci: p.moveUci,
    played,
    legalMoveCount,
    inCheckBefore,
    isBook: p.isBook,
    isPromotion,
    sacrifice,
    capturedFreeMaterial: playedSan ? capturedFreeMaterial(p.fenBefore, p.moveUci, p.prevMove?.to) : false,
    obviousEscape: playedSan ? isObviousEscape(p.fenBefore, p.moveUci) : false,
    opponentPrevWinLoss: p.opponentPrevWinLoss,
    rating: p.playerRating,
  });

  const bestMoveUci = lines[0]?.uci ?? p.before.bestMove ?? null;
  // Near-equal awareness (analysis/nearEqual.ts): whether the played move was about as good as the
  // best, and the top moves about as good as the best one.
  const near = nearVerdict({
    lines: allLines,
    moveUci: p.moveUci,
    played,
    listed: !!inLines && played === inLines.score,
    child,
    bestChild,
    cls: v.cls,
  });
  const equalBest: EqualMove[] = [];
  for (const l of nearEqualLines(p.before.lines)) {
    const uci = l.pv[0];
    const san = uciToSan(p.fenBefore, uci);
    if (!san) continue;
    if (near.nearBest === false) {
      // Not about as good itself (its own evaluation fell outside the band, e.g. a mate the deeper
      // search found), and not when calling another move it matched "about as good" while
      // correcting it: only the moves clearly better than it are named with the best one.
      if (uci === p.moveUci) continue;
      if (uci !== lines[0]?.uci && near.judged && aboutAsGood(near.judged, l.score)) continue;
    }
    equalBest.push({ san, uci, score: l.score });
  }
  let recheckFen: string | null = null;
  if ((near.recheck || (disputed && !p.bestAfter)) && bestMoveUci) {
    try {
      const c = new Chess(p.fenBefore);
      c.move(parseUci(bestMoveUci));
      recheckFen = c.fen();
    } catch {
      recheckFen = null;
    }
  }
  return {
    classification: {
      cls: v.cls,
      winBefore: v.winBefore,
      winAfter: v.winAfter,
      winLoss: v.winLoss,
      accuracy: v.accuracy,
      bestMoveUci,
      bestMoveSan: bestMoveUci ? uciToSan(p.fenBefore, bestMoveUci) : null,
      playedMoveSan: playedSan ?? p.moveUci,
      ...(equalBest.length ? { equalBest } : {}),
      ...(near.nearBest !== undefined ? { nearBest: near.nearBest } : {}),
      ...(near.aboveBest ? { aboveBest: true } : {}),
      ...(v.wonAnyway ? { wonAnyway: v.wonAnyway } : {}),
    },
    reasons: v.reasons,
    sacrifice,
    recheckFen,
    recheckAffectsClass: recheckFen !== null && disputed && !p.bestAfter,
  };
}

/**
 * Whether classifying this move needs a second opinion on `nearBest` (analysis/nearEqual.ts), and
 * of which position: the position after the engine's best move, to search like the position after
 * the played move (`after`) and pass as `bestAfter`. Asked when the played move is a little outside
 * the band of the best line (at most `NEAR_EQUAL_RECHECK_CP` behind), or its own search puts a
 * listed move far below the best line; never for a weak class (an inaccuracy is never "about as
 * good"), a mate or a finished game.
 * Null when no second opinion is needed, or `bestAfter` is already given.
 */
export function nearBestRecheck(p: ClassifyMoveInput): string | null {
  return p.bestAfter ? null : classifyMoveDetailed(p).recheckFen;
}

/**
 * The second opinion this move needs (`nearBestRecheck`'s position), and whether it can change its
 * class (`affectsClass`): only for a listed move whose own search scores it more than
 * `LISTED_DISPUTE_CP` above its line, which is then judged against the best move's own search.
 * Otherwise it settles only the near-equal verdict (`nearBest`, `aboveBest`, `equalBest`) and so
 * the words, never the class, its win chances or accuracy, and a smaller search does (GameController
 * SECOND_OPINION). Either way it comes before the verdict, so its words never change once shown.
 * Null when none is needed.
 */
export function secondOpinionNeed(p: ClassifyMoveInput): { fen: string; affectsClass: boolean } | null {
  if (p.bestAfter) return null;
  const d = classifyMoveDetailed(p);
  return d.recheckFen ? { fen: d.recheckFen, affectsClass: d.recheckAffectsClass } : null;
}

/**
 * A listed move's own search above its line in the before-search's list by more than this (cp,
 * mover's view): the list's score is not trusted (see `classifyMoveDetailed`).
 */
export const LISTED_DISPUTE_CP = 100;

/** Classes that already say the move was weak: never "about as good" as the best. */
const WEAK: ReadonlySet<MoveClass> = new Set<MoveClass>(['inaccuracy', 'mistake', 'miss', 'blunder']);

/** How the played move compares with the engine's best (see `nearVerdict`). */
interface NearVerdict {
  /** About as good as the best, or the best (`Classification.nearBest`); undefined when unknown. */
  nearBest?: boolean;
  /** Its evaluation ranks at or above the best move's (`Classification.aboveBest`). */
  aboveBest?: boolean;
  /** The verdict needs the second opinion (`bestAfter`), which was not given: `nearBest` is false. */
  recheck: boolean;
  /** The played move's score as it was judged (mover's point of view). */
  judged?: Score;
}

/**
 * Whether the played move was about as good as the engine's best one (analysis/nearEqual.ts):
 * - first against the best line (`NEAR_EQUAL_CP`): the move's own line when the before-search
 *   listed it (one search), else its own search (`child`, the search after it);
 * - when that fails by at most `NEAR_EQUAL_RECHECK_CP`, the second opinion decides, like with
 *   like: the move's own search against the best move scored the same way (`bestChild`, a search
 *   of the position after it), at most `NEAR_EQUAL_SEARCH_CP` apart. The top line is the best of
 *   several noisy estimates, so it tends to come out high, and a search of its own scores a move
 *   lower than a line does on average. It also decides for a listed move that its own search puts
 *   more than `NEAR_EQUAL_RECHECK_CP` below the best line (the searches disagree);
 * - a mate or a finished game: only the same mate (or better) is about as good.
 * A weak class (inaccuracy or worse) is never about as good.
 */
function nearVerdict(o: {
  lines: readonly { uci: string; score: Score }[];
  moveUci: string;
  played: MoverEval | null;
  /** The played move was scored as one of the before-search's lines. */
  listed: boolean;
  child: Score | null;
  bestChild: Score | null;
  cls: MoveClass;
}): NearVerdict {
  const best = o.lines[0];
  if (!best || !o.played) return { recheck: false };
  if (best.uci === o.moveUci) return { nearBest: true, recheck: false };
  const score = evalScore(o.played);
  if (WEAK.has(o.cls)) return { nearBest: false, recheck: false, judged: score };
  const judge = (near: boolean, s: Score, ref: Score): NearVerdict => ({
    nearBest: near,
    ...(near && scoreRank(s) >= scoreRank(ref) ? { aboveBest: true } : {}),
    recheck: false,
    judged: s,
  });
  // A finished game (a repetition draw included, which no search sees) or a mate: compared as it is.
  if (o.played.kind === 'result' || score.kind !== 'cp' || best.score.kind !== 'cp') {
    return judge(aboutAsGood(score, best.score), score, best.score);
  }
  const child = o.child?.kind === 'cp' ? o.child : null;
  /** The second opinion: both moves scored by a search of their own. */
  const second = (): NearVerdict => {
    if (!child || !o.bestChild) return { nearBest: false, recheck: true, judged: score };
    const v = judge(aboutAsGood(child, o.bestChild, NEAR_EQUAL_SEARCH_CP), child, o.bestChild);
    return { ...v, judged: score };
  };
  if (aboutAsGood(score, best.score)) {
    // A listed move its own search puts far below the best line: the searches disagree.
    const contested = o.listed && !!child && best.score.value - child.value > NEAR_EQUAL_RECHECK_CP;
    return contested ? second() : judge(true, score, best.score);
  }
  return best.score.value - score.value <= NEAR_EQUAL_RECHECK_CP ? second() : judge(false, score, best.score);
}

/**
 * chess.com-style classification of `moveUci` played in `fenBefore`.
 *
 * The played move's value comes from `before.lines` when the move is among them (same search,
 * consistent depth; but a forced mate found by the deeper `after` search replaces a centipawn
 * score), otherwise from `after.lines[0]` converted to the mover's point of view; a checkmate /
 * stalemate on the board (or `after.terminal`) overrides both. Never throws on normal
 * game input; with missing analysis it returns a neutral "good" (or book / forced when those apply).
 */
export function classifyMove(p: ClassifyMoveInput): Classification {
  return classifyMoveDetailed(p).classification;
}
