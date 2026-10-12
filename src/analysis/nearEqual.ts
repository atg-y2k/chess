/**
 * "About as good": when the coach treats engine moves as equal, and how it says so.
 *
 * The coach compares moves with the engine lines of its own budget (depth 14, MultiPV 3, within
 * ANNOTATE_NODES: see GameController.annotate), and at that budget the order of moves a few
 * centipawns apart is noise. After 1.d4 d5 2.c4 Nf6 3.cxd5, for example, the coach's search puts
 * 3...c6 first while a depth-24 search prefers 3...g6, and 3...c5, 3...c6, 3...g6 and the played
 * 3...Nxd5 are all within 0.1 pawn of each other there. Calling one of them "Best was c5" presents
 * noise as a correction. So the coach lists the moves within this band of the best one
 * (`Classification.equalBest`), and when the played move is within it (`Classification.nearBest`)
 * it does not correct the move ("Your Nxd5 was fine: c6, c5 and g6 were only slightly better.").
 *
 * A played move is first compared with the best line (`NEAR_EQUAL_CP`). Just outside it, a second
 * opinion compares like with like: the position after the best move is searched as the one after
 * the played move was, and the two searches decide (`NEAR_EQUAL_SEARCH_CP`, classify.ts
 * `nearBestRecheck`). The top line is the best of several noisy estimates and tends to come out
 * high: in the user's position, over 80 real-engine runs with live analysis, the best line came out
 * between -0.40 and -0.77 and Nxd5's own search between -0.66 and -0.97; Nxd5 was corrected in 11
 * runs without the second opinion, in 4 with it.
 *
 * The bands were calibrated against the real engine: the coach's budget against a depth-20 search
 * (MultiPV 4, and each other candidate move searched on its own) in 105 opening and middlegame
 * positions. Of the 215 moves there that were truly about as good (under 0.02 expected score worse
 * at depth 20), the rule catches 180 (84%). Of the 262 moves it calls about as good, 32 were 0.03
 * or more worse at depth 20 (which "only slightly better" still describes) and 3 were 0.05 or more
 * (an inaccuracy there; the coach's own search misjudged them by more than any band, and its class
 * shares that error). One band of 35 cp for every comparison called 10 of those inaccuracies
 * about as good.
 *
 * This is the only definition: the feedback on a move, Show best, Game Review, the explorer's
 * ratings and the hint's "Nf3 and c4 are about as good" all use it. (explain.ts also uses it to
 * judge follow-up moves and replies, where any two mates for the same side count as equal.)
 */
import type { PvLine, Score } from '../engine/types';
import type { Classification, EqualMove } from './types';
import { scoreToWin } from './winprob';

/**
 * Two moves are about as good when their centipawn scores differ by at most this, compared with
 * the before-search's best line: a line of that same search (MultiPV), or a played move outside
 * those lines scored by its own search of the position after it (GameController.annotate's
 * "after" search)...
 */
export const NEAR_EQUAL_CP = 25;
/**
 * ...or, when that comparison fails by at most `NEAR_EQUAL_RECHECK_CP` (or a listed move's own
 * search puts it that far below its line), by a second opinion that compares like with like: the
 * best move scored the same way as the played move, by a search of the position after it. Two
 * separate searches disagree more than the lines of one, so their band is this. (The top line is
 * the best of several noisy estimates, so it tends to come out high; a move's own search scores it
 * 18 cp lower than its line on average, and 40 cp lower in a tenth of the cases.)
 */
export const NEAR_EQUAL_SEARCH_CP = 30;
/** How far behind the best line a played move gets the second opinion (`NEAR_EQUAL_SEARCH_CP`). */
export const NEAR_EQUAL_RECHECK_CP = 60;
/**
 * Also about equal when the mover's expected scores (0..1, the lichess win-probability scale of
 * `EP_THRESHOLDS`) differ by less than this, as long as the scores are at most
 * `NEAR_EQUAL_MAX_CP` apart.
 */
export const NEAR_EQUAL_WIN = 0.02;
/**
 * In a decided position the expected score barely moves (+25.5 and +21.4 are both a win), but four
 * pawns are never "about as good": the expected-score rule only covers gaps up to this.
 */
export const NEAR_EQUAL_MAX_CP = 50;
/** Most moves `Classification.equalBest` lists, the best one included (the coach's MultiPV). */
export const NEAR_EQUAL_MAX = 3;

/**
 * A total order of scores for the same side: a mate for that side beats any centipawn score (a
 * faster mate beats a slower one), being mated loses to any (later is better, `mate 0` = mated).
 */
export function scoreRank(s: Score): number {
  if (s.kind === 'cp') return s.value;
  return s.value > 0 ? 1e9 - s.value : -1e9 - s.value;
}

/**
 * Whether two scores of the same side are about equal: centipawn scores at most `bandCp` apart
 * (`NEAR_EQUAL_CP` against a search's best line, `NEAR_EQUAL_SEARCH_CP` between two moves each
 * scored by a search of its own), or whose expected scores differ by less than `NEAR_EQUAL_WIN` while at most
 * `NEAR_EQUAL_MAX_CP` apart. A mate score is about equal only to the same mate: never to a
 * centipawn score, and a faster mate is better than a slower one.
 */
export function aboutEqual(a: Score, b: Score, bandCp = NEAR_EQUAL_CP): boolean {
  if (a.kind !== 'cp' || b.kind !== 'cp') return a.kind === b.kind && a.value === b.value;
  const cp = Math.abs(a.value - b.value);
  return cp <= bandCp || (cp <= NEAR_EQUAL_MAX_CP && Math.abs(scoreToWin(a) - scoreToWin(b)) < NEAR_EQUAL_WIN);
}

/** `move` is about as good as `best` (same side's point of view; see `aboutEqual`), or better. */
export function aboutAsGood(move: Score, best: Score, bandCp = NEAR_EQUAL_CP): boolean {
  return scoreRank(move) >= scoreRank(best) || aboutEqual(move, best, bandCp);
}

/**
 * The engine lines about as good as the best one (`lines[0]`), best first, at most `max` (the best
 * included). Lines without a move are skipped. Empty when there are no lines.
 */
export function nearEqualLines(lines: readonly PvLine[], max = NEAR_EQUAL_MAX): PvLine[] {
  const usable = lines.filter((l) => l.pv.length > 0);
  const best = usable[0];
  if (!best) return [];
  return usable.filter((l, i) => i === 0 || aboutAsGood(l.score, best.score)).slice(0, max);
}

// ------------------------------------------------------------------ wording

/** Who the words are about: 'you' = the player's own move ("Your Nxd5"), 'neutral' = the opponent's. */
export type NearVoice = 'you' | 'neutral';

/** "a", "a and b", "a, b and c". */
function joinAnd(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/**
 * The moves about as good as the engine's best (`equalBest` without the best itself), best first,
 * as SAN; `exceptUci` (the played move) is left out too.
 */
export function equalAlternatives(
  cl: Pick<Classification, 'equalBest' | 'bestMoveUci'> | null | undefined,
  exceptUci?: string | null,
): EqualMove[] {
  return (cl?.equalBest ?? []).filter((m, i) => i > 0 && m.uci !== cl?.bestMoveUci && m.uci !== exceptUci);
}

/**
 * A bare sentence about the best move with its near-equal alternatives before the final period:
 * "Best was c5." becomes "Best was c5 (c6 was about as good)." or "Best was c5 (c6 and g6 were
 * about as good).". Unchanged without alternatives. Not for a sentence with a reason (see
 * `bestWasSentence`): the parenthesis would read as part of the reason.
 */
export function withAlternatives(sentence: string, alternatives: readonly string[]): string {
  if (!alternatives.length) return sentence;
  return `${sentence.replace(/\.$/, '')} (${alternativesClause(alternatives)}).`;
}

/** "c6 was about as good" / "c6 and g6 were about as good". */
function alternativesClause(alternatives: readonly string[]): string {
  return `${joinAnd(alternatives)} ${alternatives.length > 1 ? 'were' : 'was'} about as good`;
}

/** "c6 was about as good." / "c6 and g6 were about as good." (null without alternatives). */
export function alternativesSentence(alternatives: readonly string[]): string | null {
  return alternatives.length ? `${alternativesClause(alternatives)}.` : null;
}

/** A trailing " (c6 was about as good)" that `withAlternatives` added, for text that names the moves itself. */
export const ALTERNATIVES_SUFFIX = / \([^()]* about as good\)(?=\.$)/;

/**
 * THE "Best was X" sentence (every place that names the better move uses it): "Best was c5.",
 * "Best was c5 (c6 and g6 were about as good).", "Best was c5, which wins a knight." ("Best was
 * Be2: it prepares O-O, which …" when the reason has its own "which"). `reason` is a verb phrase
 * ("wins a knight"); `alternatives` the SANs of the moves about as good as the best, named only
 * without a reason (the reason is the lesson there, and "Show best" names them).
 */
export function bestWasSentence(
  bestSan: string,
  opts: { reason?: string | null; alternatives?: readonly string[] } = {},
): string {
  const r = opts.reason;
  if (!r) return withAlternatives(`Best was ${bestSan}.`, opts.alternatives ?? []);
  return /\bwhich\b/.test(r) ? `Best was ${bestSan}: it ${r}.` : `Best was ${bestSan}, which ${r}.`;
}

/**
 * Whether the coach should not correct the move: the played move was about as good as the
 * engine's best (`nearBest`) without being it.
 */
export function isNearBest(
  cl: Pick<Classification, 'nearBest' | 'bestMoveUci'> | null | undefined,
  playedUci: string,
): boolean {
  return !!cl?.nearBest && !!cl.bestMoveUci && cl.bestMoveUci !== playedUci;
}

/**
 * What the coach says instead of "Best was X." when the played move was about as good
 * (`isNearBest`): "c5 is one of the engine’s top choices, with c6 and g6." when the engine listed
 * it among its near-equal moves, else "Your Nxd5 was fine: c6, c5 and g6 were only slightly
 * better." ("Nxd5 was fine: …" for the opponent's move, `voice` 'neutral'), which also fits a Good
 * move's badge. Null for any other move, and when the played move scored at least as well as the
 * best (`aboveBest`: a mate or a draw the best line lacks, or a search that rates it higher), which
 * needs no note at all.
 */
export function nearBestSentence(
  cl: Pick<Classification, 'nearBest' | 'aboveBest' | 'bestMoveUci' | 'bestMoveSan' | 'equalBest' | 'playedMoveSan'>,
  playedUci: string,
  voice: NearVoice = 'you',
): string | null {
  if (!isNearBest(cl, playedUci) || !cl.bestMoveSan || cl.aboveBest) return null;
  const equal = cl.equalBest ?? [];
  if (equal.some((m) => m.uci === playedUci)) {
    const others = equal.filter((m) => m.uci !== playedUci).map((m) => m.san);
    const with_ = others.length ? `, with ${joinAnd(others)}` : '';
    return `${cl.playedMoveSan} is one of the engine’s top choices${with_}.`;
  }
  const better = [cl.bestMoveSan, ...equalAlternatives(cl, playedUci).map((m) => m.san)];
  const who = voice === 'you' ? `Your ${cl.playedMoveSan}` : cl.playedMoveSan;
  return `${who} was fine: ${joinAnd(better)} ${better.length > 1 ? 'were' : 'was'} only slightly better.`;
}

/**
 * What the coach adds about the better move after an explanation that does not name it yet:
 * `nearBestSentence` when the played move was about as good (nothing when it scored at least as
 * well), else "Best was c5." with the alternatives (`bestWasSentence`). Null when the played move
 * was the engine's best.
 */
export function bestMoveNote(
  cl: Pick<Classification, 'nearBest' | 'aboveBest' | 'bestMoveUci' | 'bestMoveSan' | 'equalBest' | 'playedMoveSan'>,
  playedUci: string,
  voice: NearVoice = 'you',
): string | null {
  if (!cl.bestMoveSan || !cl.bestMoveUci || cl.bestMoveUci === playedUci) return null;
  if (isNearBest(cl, playedUci)) return nearBestSentence(cl, playedUci, voice);
  return bestWasSentence(cl.bestMoveSan, { alternatives: equalAlternatives(cl, playedUci).map((m) => m.san) });
}
