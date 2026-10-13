/**
 * Post-game review summary: accuracy per colour, move-class counts and key moments, computed
 * from the per-ply annotations (see GameController.startReview).
 */
import { accuracyCp, gameAccuracy } from '../analysis/accuracy';
import type { MoveClass } from '../analysis/types';
import { CP_CEILING, negateScore } from '../analysis/winprob';
import { sideToMove } from '../chess/utils';
import type { Score } from '../engine/types';
import type { KeyMoment } from '../ui/ReviewPanel';
import { KEY_CLASSES, classLabel, concession } from './coach';
import type { Color, Ply } from './types';

export interface ReviewSummary {
  accuracy: { w: number | null; b: number | null };
  counts: Record<Color, Partial<Record<MoveClass, number>>>;
  /**
   * Of `counts`, the weak moves (inaccuracy or worse) that came when that side was already winning
   * (`weakInWonGame`), which do not lower its accuracy: what `alreadyWonNote` explains. Absent in a
   * summary still to be computed.
   */
  alreadyWon?: Record<Color, Partial<Record<MoveClass, number>>>;
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

/** "12." for White's move, "12…" for Black's, numbered from the position before it (any start position). */
export function moveNumberLabel(p: Pick<Ply, 'fenBefore' | 'color' | 'index'>): string {
  const n = Number(p.fenBefore.split(' ')[5]);
  const no = Number.isInteger(n) && n > 0 ? n : Math.floor(p.index / 2) + 1;
  return p.color === 'w' ? `${no}.` : `${no}…`;
}

/**
 * Summarises an annotated game.
 * @param startEval White-POV eval of the start position (null = lichess's default +0.15).
 * @param playerColor The player's side: with more key moments than fit, the player's own come first.
 */
export function summarizeGame(
  startFen: string,
  startEval: Score | null,
  plies: readonly Ply[],
  playerColor?: Color,
): ReviewSummary {
  const accuracy = gameAccuracy([startEval, ...plies.map((p) => p.evalWhite ?? null)], {
    startColor: sideToMove(startFen),
  });
  const counts = emptyCounts();
  const alreadyWon = emptyCounts();
  // The evaluation of the position before each move: the start position's, then each move's.
  let before: Score | null | undefined = startEval;
  for (const p of plies) {
    const cls = p.classification?.cls;
    if (cls) counts[p.color][cls] = (counts[p.color][cls] ?? 0) + 1;
    if (cls && weakInWonGame(p, before)) alreadyWon[p.color][cls] = (alreadyWon[p.color][cls] ?? 0) + 1;
    before = p.evalWhite;
  }
  const moment = (p: Ply): KeyMoment => {
    const m: KeyMoment = {
      index: p.index,
      cls: p.classification!.cls,
      san: p.san,
      label: moveNumberLabel(p),
      color: p.color,
      text: p.explanation?.headline ?? classLabel(p.classification!.cls),
    };
    const c = concession(p);
    if (c) m.concedes = c;
    return m;
  };
  // A move whose class praises it but whose text says what it gives away ("This hangs your queen
  // on b4." for an Excellent Kd8 in a lost position) is worth a look too.
  const key = (p: Ply) => !!p.classification && (KEY_CLASSES.has(p.classification.cls) || !!concession(p));
  let keyMoments = plies.filter(key).map(moment);
  if (keyMoments.length < MIN_KEY_MOMENTS) {
    keyMoments = plies.filter((p) => key(p) || p.classification?.cls === 'inaccuracy').map(moment);
  }
  if (keyMoments.length > MAX_KEY_MOMENTS) {
    // Keep the most important ones (blunders and brilliancies first): the player's own first (a
    // weak bot's many blunders never push out the player's moments), then restore game order.
    const mineFirst = (m: KeyMoment) => (playerColor && m.color !== playerColor ? 1 : 0);
    keyMoments = keyMoments
      .slice()
      .sort((a, b) => mineFirst(a) - mineFirst(b) || priority(a) - priority(b) || a.index - b.index)
      .slice(0, MAX_KEY_MOMENTS)
      .sort((a, b) => a.index - b.index);
  }
  return { accuracy, counts, alreadyWon, keyMoments };
}

/** Rank when there are too many key moments (lower first): a concession ranks with the inaccuracies. */
function priority(m: KeyMoment): number {
  return m.concedes ? PRIORITY.inaccuracy : PRIORITY[m.cls];
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

/** The labels that say a move was weak (inaccuracy or worse), in the order a note names them. */
const WEAK_ORDER: readonly MoveClass[] = ['inaccuracy', 'mistake', 'miss', 'blunder'];
const WEAK_CLASSES: ReadonlySet<MoveClass> = new Set<MoveClass>(WEAK_ORDER);
/** From this accuracy (0..100) on, `alreadyWonNote` says it is why the accuracy is still that high. */
export const ACCURACY_NOTE_MIN = 90;

/**
 * Whether a White-POV evaluation is decided for `mover` as accuracy counts it (lichess caps it at
 * ±10, a mate counting as 10, analysis/accuracy.ts): +10 or better for the mover, or a mate for
 * them. `after`: the evaluation of the position after the mover's move (a `mate 0` there means the
 * move checkmated; before it, that the mover is checkmated).
 */
function decidedFor(scoreWhite: Score | null | undefined, mover: Color, after: boolean): boolean {
  if (!scoreWhite) return false;
  if (scoreWhite.kind === 'mate' && scoreWhite.value === 0) return after;
  return accuracyCp(mover === 'w' ? scoreWhite : negateScore(scoreWhite)) >= CP_CEILING;
}

/**
 * A weak move (inaccuracy or worse) that came when the game was already won, so it did not lower
 * the mover's winning chances as accuracy counts them: the evaluations before (`beforeWhite`, the
 * previous ply's `evalWhite` or the start position's) and after it both +10 or better for the mover
 * (or a mate), where accuracy caps them. Exactly the evaluations accuracy is computed from, so a move
 * counted here never lowered it (a class only the mate-distance rules gave, `Classification
 * .wonAnyway`, counts when they agree, as they do unless its searches disagree).
 */
export function weakInWonGame(
  p: Pick<Ply, 'color' | 'classification' | 'evalWhite'>,
  beforeWhite: Score | null | undefined,
): boolean {
  const cl = p.classification;
  if (!cl || !WEAK_CLASSES.has(cl.cls)) return false;
  return decidedFor(beforeWhite, p.color, false) && decidedFor(p.evalWhite, p.color, true);
}

/** Singular and plural of a weak class, as a note counts them. */
const NOUNS: Partial<Record<MoveClass, [string, string]>> = {
  inaccuracy: ['inaccuracy', 'inaccuracies'],
  mistake: ['mistake', 'mistakes'],
  miss: ['miss', 'misses'],
  blunder: ['blunder', 'blunders'],
};

const joinAnd = (xs: readonly string[]): string =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

/**
 * Why a side's weak moves left its accuracy high ("99% accuracy with 9 inaccuracies"): the labels
 * stay, and this note under the accuracy says how many came when that side was already winning
 * (`ReviewSummary.alreadyWon`, see `weakInWonGame`), which accuracy does not count as lost chances:
 * "7 of your 9 inaccuracies came when you were already winning, so they didn’t lower your winning
 * chances — that’s why your accuracy is still 99.1%." The "that’s why" only when they are at least
 * half of the side's weak moves, and the accuracy as shown is ACCURACY_NOTE_MIN or more; with fewer
 * of them it ends "…, so it didn’t lower your winning chances.", and below ACCURACY_NOTE_MIN (or
 * unknown) "…, so they didn’t lower your winning chances or your accuracy." `who`: 'you' for the
 * player, else the opponent's name ("4 of Pip’s 6 inaccuracies came when Pip was already winning,
 * …"). `decimals`: the accuracy as the screen shows it (Game Review 99.1). Null when none of the
 * side's weak moves came in a won game. The game-over sheet has a shorter one
 * (`alreadyWonSheetNote`).
 */
export function alreadyWonNote(o: {
  /** The side's moves by class (`ReviewSummary.counts`). */
  counts: Partial<Record<MoveClass, number>>;
  /** Its weak moves in a won game by class (`ReviewSummary.alreadyWon`). */
  alreadyWon: Partial<Record<MoveClass, number>> | undefined;
  accuracy: number | null;
  who: 'you' | string;
  decimals: 0 | 1;
}): string | null {
  const won = o.alreadyWon ?? {};
  const you = o.who === 'you';
  const whose = you ? 'your' : `${o.who}’s`;
  const groups: string[] = [];
  let total = 0;
  for (const cls of WEAK_ORDER) {
    const k = won[cls] ?? 0;
    if (k <= 0) continue;
    total += k;
    const n = Math.max(k, o.counts[cls] ?? 0);
    const [one, many] = NOUNS[cls]!;
    groups.push(
      n === 1 ? `${whose} ${one}` : k < n ? `${k} of ${whose} ${n} ${many}` : n === 2 ? `both of ${whose} ${many}` : `all ${n} of ${whose} ${many}`,
    );
  }
  if (!total) return null;
  const subject = joinAnd(groups);
  const lead = `${subject.charAt(0).toUpperCase()}${subject.slice(1)} came when ${you ? 'you were' : `${o.who} was`} already winning`;
  const lowered = `so ${total === 1 ? 'it' : 'they'} didn’t lower ${whose} winning chances`;
  const a = o.accuracy;
  // The accuracy as the screen shows it (89.96 shows as 90.0).
  const shown = a == null || !Number.isFinite(a) ? null : o.decimals === 1 ? Math.round(a * 10) / 10 : Math.round(a);
  if (shown === null || shown < ACCURACY_NOTE_MIN) return `${lead}, ${lowered} or ${whose} accuracy.`;
  // The high accuracy is theirs to explain only when they are most of the side's weak moves.
  if (2 * total < weakCount(o.counts)) return `${lead}, ${lowered}.`;
  return `${lead}, ${lowered} — that’s why ${whose} accuracy is still ${o.decimals === 1 ? shown.toFixed(1) : shown}%.`;
}

/** A side's weak moves (inaccuracy or worse) from its counts. */
function weakCount(counts: Partial<Record<MoveClass, number>>): number {
  return WEAK_ORDER.reduce((n, cls) => n + Math.max(0, counts[cls] ?? 0), 0);
}

/**
 * The game-over sheet's short form of `alreadyWonNote`, for the player (under "You: 9
 * inaccuracies", so it says "them"): "7 of them came when you were already winning, so they didn’t
 * lower your accuracy." ("It came …", "Both came …", "All 4 came …" when they all did). Short, so
 * the sheet's buttons stay on a small phone's screen. Null when none did.
 */
export function alreadyWonSheetNote(o: {
  counts: Partial<Record<MoveClass, number>>;
  alreadyWon: Partial<Record<MoveClass, number>> | undefined;
}): string | null {
  const k = weakCount(o.alreadyWon ?? {});
  if (!k) return null;
  const n = Math.max(k, weakCount(o.counts));
  const subject = k < n ? `${k} of them` : n === 1 ? 'It' : n === 2 ? 'Both' : `All ${n}`;
  return `${subject} came when you were already winning, so ${k === 1 ? 'it' : 'they'} didn’t lower your accuracy.`;
}

/**
 * The notes under Game Review's accuracies (`alreadyWonNote`, accuracy as it shows there): the
 * player's first, then the opponent's (`botName`), each only when that side has weak moves that came
 * in a won game. Empty otherwise.
 */
export function reviewAccuracyNotes(
  sum: Pick<ReviewSummary, 'accuracy' | 'counts' | 'alreadyWon'>,
  playerColor: Color,
  botName: string,
): string[] {
  const bot: Color = playerColor === 'w' ? 'b' : 'w';
  const note = (c: Color, who: string) =>
    alreadyWonNote({ counts: sum.counts[c], alreadyWon: sum.alreadyWon?.[c], accuracy: sum.accuracy[c], who, decimals: 1 });
  return [note(playerColor, 'you'), note(bot, botName)].filter((n): n is string => !!n);
}
