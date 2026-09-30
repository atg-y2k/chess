/**
 * Coach wording that does not need the engine: class labels and sentences, move labels
 * ("12. Nf3", "12… Nf6") and short, phase-aware playing tips.
 */
import type { MoveClass } from '../analysis/types';
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
  'Fight for the centre with your pawns and pieces.',
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
  'In the endgame the king is a strong piece: bring it towards the centre.',
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
