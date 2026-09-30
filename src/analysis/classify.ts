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
import type { Classification, MoveClass } from './types';
import { accuracyWin, moveAccuracy } from './accuracy';
import { capturedFreeMaterial, detectSacrifice, MIN_SACRIFICE, type Sacrifice } from './sacrifice';
import { childToMover, CP_CEILING, cpToWin, scoreToWin, type TerminalKind } from './winprob';

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
  if (rating != null && rating < 1200) {
    return { brilliantMaxLoss: 0.03, brilliantMinAfter: 0.45, winningAnyway: 0.95, greatGap: 0.08, greatMinAfter: 0.4 };
  }
  if (rating != null && rating >= 2000) {
    return { brilliantMaxLoss: 0.01, brilliantMinAfter: 0.5, winningAnyway: 0.9, greatGap: 0.12, greatMinAfter: 0.45 };
  }
  return { brilliantMaxLoss: 0.02, brilliantMinAfter: 0.5, winningAnyway: 0.93, greatGap: 0.1, greatMinAfter: 0.45 };
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
   * search), otherwise the converted child search. null = unknown (the worst line is then used as an
   * optimistic estimate and the class is capped at Good).
   */
  played: MoverEval | null;
  legalMoveCount: number;
  inCheckBefore: boolean;
  isBook?: boolean;
  isPromotion?: boolean;
  /** Net material the move leaves en prise (see `detectSacrifice`), or null. */
  sacrifice?: { netValue: number } | null;
  /** The move won material by static exchange or was a plain recapture (never Great). */
  capturedFreeMaterial?: boolean;
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
  const verdict = (cls: MoveClass): ClassifyVerdict => ({
    cls,
    winBefore: epBest,
    winAfter: epPlayed,
    winLoss: loss,
    accuracy,
    reasons,
  });

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
  if (
    f.sacrifice &&
    f.sacrifice.netValue >= MIN_SACRIFICE &&
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
  if (
    base === 'best' &&
    isTop &&
    epAlt != null &&
    !f.inCheckBefore &&
    f.legalMoveCount >= GREAT_MIN_LEGAL_MOVES &&
    !f.capturedFreeMaterial &&
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
  /** `winLoss` of the opponent's previous move (for "miss"). */
  opponentPrevWinLoss?: number;
  /** The resulting position is in the opening book (and every earlier ply was). */
  isBook?: boolean;
  /** Player rating, for the Brilliant / Great tiers. */
  playerRating?: number;
  /** The opponent's previous move; a recapture on its square is never "great". */
  prevMove?: { to: string };
}

export interface ClassifyMoveDetail {
  classification: Classification;
  reasons: ClassReason[];
  /** The piece the move leaves en prise, if any (a Brilliant sacrifice, or hung material). */
  sacrifice: Sacrifice | null;
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

  const lines = p.before.lines
    .filter((l) => l.pv.length > 0)
    .map((l) => ({ uci: l.pv[0], score: l.score }));
  const inLines = lines.find((l) => l.uci === p.moveUci);
  const childBest = p.after?.lines[0];
  let played: MoverEval | null = null;
  if (result != null) played = { kind: 'result', value: result };
  else if (inLines) played = inLines.score;
  else if (childBest) played = childToMover(childBest.score);

  const sacrifice = playedSan ? detectSacrifice(p.fenBefore, p.moveUci) : null;
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
    opponentPrevWinLoss: p.opponentPrevWinLoss,
    rating: p.playerRating,
  });

  const bestMoveUci = lines[0]?.uci ?? p.before.bestMove ?? null;
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
    },
    reasons: v.reasons,
    sacrifice,
  };
}

/**
 * chess.com-style classification of `moveUci` played in `fenBefore`.
 *
 * The played move's value comes from `before.lines` when the move is among them (same search,
 * consistent depth), otherwise from `after.lines[0]` converted to the mover's point of view; a
 * checkmate / stalemate on the board (or `after.terminal`) overrides both. Never throws on normal
 * game input; with missing analysis it returns a neutral "good" (or book / forced when those apply).
 */
export function classifyMove(p: ClassifyMoveInput): Classification {
  return classifyMoveDetailed(p).classification;
}
