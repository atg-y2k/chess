/**
 * Coach wording that does not need the engine: class labels and sentences, move labels
 * ("12. Nf3", "12… Nf6") and short, phase-aware playing tips.
 */
import type { Classification, Explanation, MoveClass } from '../analysis/types';
import { PIECE_VALUES } from '../chess/utils';
import { CLASS_META } from '../ui/ClassIcon';
import type { Ply } from './types';

/** Display label of a class, e.g. "Blunder" (from CLASS_META). */
export function classLabel(cls: MoveClass): string {
  return CLASS_META[cls].label;
}

const PHRASE: Record<MoveClass, string> = {
  brilliant: 'is brilliant',
  great: 'is a great move',
  best: 'is the best move',
  excellent: 'is excellent',
  good: 'is good',
  book: 'is a book move',
  forced: 'is forced',
  inaccuracy: 'is an inaccuracy',
  mistake: 'is a mistake',
  miss: 'is a miss',
  blunder: 'is a blunder',
};

/** chess.com-style verdict, e.g. "Qxd4 is a blunder" or "e4 is a book move". */
export function classSentence(san: string, cls: MoveClass): string {
  return `${san} ${PHRASE[cls]}`;
}

/** Classes that do not need a "Show best" (the move was already the best or the only option). */
export const TOP_CLASSES: ReadonlySet<MoveClass> = new Set<MoveClass>(['brilliant', 'great', 'best', 'book', 'forced']);

/**
 * Whether the coach offers "Show best" (and review draws the best-move arrow) for a move: it was
 * not the engine's top move, and its class does not already say it was the best or only option.
 * A Brilliant sacrifice can be nearly-best, so it offers the engine's choice too.
 */
export function offersShowBest(cl: Pick<Classification, 'cls' | 'bestMoveUci'>, playedUci: string): boolean {
  if (!cl.bestMoveUci || cl.bestMoveUci === playedUci) return false;
  return cl.cls === 'brilliant' || !TOP_CLASSES.has(cl.cls);
}

/** Classes that offer "Retry" in coach mode. */
export const RETRY_CLASSES: ReadonlySet<MoveClass> = new Set<MoveClass>(['mistake', 'miss', 'blunder']);

/** Classes drawn as markers on the eval graph and listed as key moments. */
export const KEY_CLASSES: ReadonlySet<MoveClass> = new Set<MoveClass>(['brilliant', 'great', 'mistake', 'miss', 'blunder']);

/** "12. Nf3" for White, "12… Nf6" for Black (move number from the FEN before the ply). */
export function moveLabel(ply: Pick<Ply, 'fenBefore' | 'san' | 'color' | 'index'>): string {
  const n = Number(ply.fenBefore.split(' ')[5]);
  const no = Number.isFinite(n) && n > 0 ? n : Math.floor(ply.index / 2) + 1;
  return ply.color === 'w' ? `${no}. ${ply.san}` : `${no}… ${ply.san}`;
}

const OPENING_TIPS = [
  'Fight for the center with your pawns and pieces.',
  'Develop your knights and bishops before moving the same piece twice.',
  'Castle early to tuck your king away safely.',
  'Keep your queen back for now: early queen moves can be chased around.',
  'Connect your rooks by developing all of your minor pieces.',
];

const MIDDLEGAME_TIPS = [
  'Before you move, look at every check, capture and threat, for both sides.',
  'Look for undefended pieces: yours and your opponent’s.',
  'Rooks love open files.',
  'Improve your worst-placed piece.',
  'Ask yourself what your opponent wants to do next.',
];

const ENDGAME_TIPS = [
  'In the endgame the king is a strong piece: bring it toward the center.',
  'Passed pawns must be pushed.',
  'Rooks belong behind passed pawns.',
  'When you are ahead, trade pieces rather than pawns.',
];

/** Non-pawn material of both sides together (queen 9, rook 5, minor 3). Start position: 62. */
function pieceMaterial(fen: string): number {
  let total = 0;
  for (const ch of fen.split(' ')[0]) {
    const p = ch.toLowerCase();
    if (p !== 'p' && p !== 'k' && p in PIECE_VALUES) total += PIECE_VALUES[p];
  }
  return total;
}

/**
 * A short playing tip for the side to move: opening principles early on, tactics in the
 * middlegame and endgame technique once most pieces are gone. Stable for a whole move (it only
 * changes every two plies), so the coach panel does not flicker.
 */
export function coachTip(fen: string, plyCount: number, inCheck = false): string {
  if (inCheck) return 'You are in check: move your king, block the check or capture the checking piece.';
  const endgame = pieceMaterial(fen) <= 26;
  const tips = endgame ? ENDGAME_TIPS : plyCount < 16 ? OPENING_TIPS : MIDDLEGAME_TIPS;
  return tips[Math.floor(plyCount / 2) % tips.length];
}

/** Whether `text` names the move `san` as a whole word (check / mate signs ignored). */
export function mentionsMove(text: string, san: string): boolean {
  const core = san.replace(/[+#?!]+$/, '');
  if (!core) return false;
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}(?![A-Za-z0-9=-])`).test(text);
}

/** Opening sentence when the explanation's own headline would give the better move away. */
const ANSWER_FREE_LEAD: Partial<Record<MoveClass, string>> = {
  mistake: 'There was a clearly better move here.',
  miss: 'You missed a chance to punish your opponent’s mistake.',
  blunder: 'There was a much better move here.',
};

/**
 * The explanation of a move the player may still Retry, without giving the better move away: no
 * line that names it ("Best was Nf3, which …", "You missed Qxh5, which wins a knight."), no
 * description of a missed tactic, and no "promotes to a knight instead of a queen" (which says
 * what to promote to). "Show best" reveals the rest. Always at least one line.
 */
export function answerFreeLines(e: Explanation | undefined | null, cl: Classification): string[] {
  const all = e ? [e.headline, ...e.details] : [];
  const best = cl.bestMoveSan;
  const motifs = e?.motifs ?? [];
  const missedTactic = motifs.includes('missedTactic');
  const underpromotion = motifs.includes('underpromotion');
  const lines = all.filter(
    (line, i) => !(best && mentionsMove(line, best)) && !(missedTactic && i > 0) && !(underpromotion && i === 0),
  );
  if (e && lines[0] !== e.headline) {
    const lead = motifs.includes('missedMate')
      ? 'You missed a checkmate.'
      : missedTactic
        ? 'You missed a chance to win material.'
        : (ANSWER_FREE_LEAD[cl.cls] ?? 'There was a better move here.');
    lines.unshift(lead);
  }
  return lines.length ? lines : [ANSWER_FREE_LEAD[cl.cls] ?? 'There was a better move here.'];
}

/**
 * Explanation of a move that repeats the position for the third time (the game is drawn at once).
 * The engine only sees the position, not the game's history, so its own explanation would praise
 * or criticize the move as if play went on.
 */
export function repetitionExplanation(
  san: string,
  cl: Classification,
  opts: { human: boolean; botName: string },
): Explanation {
  const details: string[] = [];
  if (cl.winBefore >= 0.6) {
    details.push(
      opts.human
        ? 'You were winning: when you are ahead, avoid repeating the position.'
        : `${opts.botName} was winning, so the draw let you off the hook.`,
    );
    if (cl.bestMoveSan && cl.bestMoveSan !== san) details.push(`Best was ${cl.bestMoveSan}.`);
  } else if (cl.winBefore <= 0.4) {
    details.push(opts.human ? 'A draw is a good result from a lost position.' : `${opts.botName} was losing, so a draw is a good result for it.`);
  }
  return {
    headline: `${san} repeats the position for the third time, so the game is a draw.`,
    details,
    title: 'Repetition',
    motifs: ['repetition'],
  };
}
