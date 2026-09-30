/**
 * Post-game review summary: accuracy per colour, move-class counts and key moments, computed
 * from the per-ply annotations (see GameController.startReview).
 */
import { gameAccuracy } from '../analysis/accuracy';
import type { MoveClass } from '../analysis/types';
import { sideToMove } from '../chess/utils';
import type { Score } from '../engine/types';
import type { KeyMoment } from '../ui/ReviewPanel';
import { KEY_CLASSES, classLabel } from './coach';
import type { Color, Ply } from './types';

export interface ReviewSummary {
  accuracy: { w: number | null; b: number | null };
  counts: Record<Color, Partial<Record<MoveClass, number>>>;
  keyMoments: KeyMoment[];
}

/** Fewer key moments than this: inaccuracies are listed too. */
const MIN_KEY_MOMENTS = 3;
/** At most this many key moments are listed. */
const MAX_KEY_MOMENTS = 12;

/** Empty per-colour counts. */
export function emptyCounts(): Record<Color, Partial<Record<MoveClass, number>>> {
  return { w: {}, b: {} };
}

/**
 * Summarises an annotated game.
 * @param startEval White-POV eval of the start position (null = lichess's default +0.15).
 */
export function summarizeGame(startFen: string, startEval: Score | null, plies: readonly Ply[]): ReviewSummary {
  const accuracy = gameAccuracy([startEval, ...plies.map((p) => p.evalWhite ?? null)], {
    startColor: sideToMove(startFen),
  });
  const counts = emptyCounts();
  for (const p of plies) {
    const cls = p.classification?.cls;
    if (cls) counts[p.color][cls] = (counts[p.color][cls] ?? 0) + 1;
  }
  const moment = (p: Ply): KeyMoment => ({
    index: p.index,
    cls: p.classification!.cls,
    san: p.san,
    text: p.explanation?.headline ?? classLabel(p.classification!.cls),
  });
  let keyMoments = plies.filter((p) => p.classification && KEY_CLASSES.has(p.classification.cls)).map(moment);
  if (keyMoments.length < MIN_KEY_MOMENTS) {
    keyMoments = plies
      .filter((p) => p.classification && (KEY_CLASSES.has(p.classification.cls) || p.classification.cls === 'inaccuracy'))
      .map(moment);
  }
  if (keyMoments.length > MAX_KEY_MOMENTS) {
    // Keep the most important ones (blunders and brilliancies first), then restore game order.
    keyMoments = keyMoments
      .slice()
      .sort((a, b) => PRIORITY[a.cls] - PRIORITY[b.cls] || a.index - b.index)
      .slice(0, MAX_KEY_MOMENTS)
      .sort((a, b) => a.index - b.index);
  }
  return { accuracy, counts, keyMoments };
}

const PRIORITY: Record<MoveClass, number> = {
  blunder: 0,
  brilliant: 1,
  miss: 2,
  mistake: 3,
  great: 4,
  inaccuracy: 5,
  best: 6,
  excellent: 7,
  good: 8,
  book: 9,
  forced: 10,
};
