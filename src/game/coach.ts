/**
 * Coach wording that does not need the engine: class labels and sentences, move labels
 * ("12. Nf3", "12… Nf6") and short, phase-aware playing tips.
 */
import { Chess, type Square } from 'chess.js';
import { bestWasSentence, equalAlternatives, isNearBest } from '../analysis/nearEqual';
import { see } from '../analysis/see';
import type { Classification, Explanation, MoveClass } from '../analysis/types';
import { formatScore } from '../analysis/winprob';
import { PIECE_VALUES, sideToMove, toWhitePov, whitePovTo } from '../chess/utils';
import type { Score } from '../engine/types';
import { CLASS_META } from '../ui/ClassIcon';
import type { Color, Ply } from './types';

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

/** Classes that already say the move was weak, so an explanation can never contradict them. */
const WEAK_CLASSES: ReadonlySet<MoveClass> = new Set<MoveClass>(['inaccuracy', 'mistake', 'miss', 'blunder']);

/** Expected score from which a side counts as winning (as in the explanations: "You are still winning."). */
const WINNING = 0.75;

/**
 * What a move gives away when its class would praise it (`Explanation.concedes`): in a decided
 * position an "Excellent" Kd8 can leave the queen en prise, because the expected score barely
 * moves. Such a move gets a neutral verdict (`verdictTitle`) and no praise icon anywhere. Null
 * for every other move.
 */
export function concession(ply: Pick<Ply, 'classification' | 'explanation'>): 'material' | 'mate' | null {
  const c = ply.explanation?.concedes;
  const cls = ply.classification?.cls;
  return (c === 'material' || c === 'mate') && cls && !WEAK_CLASSES.has(cls) ? c : null;
}

/**
 * The coach's verdict on a classified move, e.g. "12. Nf3 is a mistake" (`classSentence`), with
 * the class icon to show beside it. A move whose text says what it gives away (`concession`) gets
 * a neutral verdict and no icon instead: "10… Kd8 doesn't change the result" when the game was
 * already lost (also when it only lets the opponent mate faster), "25. Rd1 still wins, but gives
 * up material" when still winning, else "gives up material".
 */
export function verdictTitle(
  ply: Pick<Ply, 'fenBefore' | 'san' | 'color' | 'index' | 'classification' | 'explanation'>,
): { title: string; cls?: MoveClass } {
  const label = moveLabel(ply);
  const cl = ply.classification;
  if (!cl) return { title: label };
  const c = concession(ply);
  if (!c) return { title: classSentence(label, cl.cls), cls: cl.cls };
  if (c === 'mate' || cl.winBefore <= 1 - WINNING) return { title: `${label} doesn’t change the result` };
  if (cl.winAfter >= WINNING) return { title: `${label} still wins, but gives up material` };
  return { title: `${label} gives up material` };
}

/** The coach panel's action that opens the paywall when its explanation is locked (see `lockedTeaser`). */
export const UNLOCK_LABEL = 'Unlock to see why';

/**
 * The coach's line on a move while its explanation is part of Pro and locked (game/entitlements.ts):
 * what the coach would tell, never the answer (no move, square or piece). The verdict ("12. Nf3 is
 * a mistake") and the class icon stay free.
 */
export function lockedTeaser(ply: Pick<Ply, 'classification' | 'explanation'>): string {
  const cls = ply.classification?.cls;
  if (concession(ply)) return 'The coach can show you what this move gives away, and what was better.';
  if (!cls || WEAK_CLASSES.has(cls)) return 'The coach can show you what went wrong here, and what was better.';
  if (cls === 'book') return 'The coach can show you the idea behind this opening move.';
  if (cls === 'forced') return 'The coach can show you why there was nothing better.';
  return 'The coach can show you what makes this move work.';
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

/** Classes whose move lost little (under 5% expected score): the better move was only slightly better. */
const SLIGHT_CLASSES: ReadonlySet<MoveClass> = new Set<MoveClass>(['excellent', 'good']);

/**
 * Show best's title: "Top choices" ("Top choice" when the engine listed no other) when the played
 * move was about as good as the best (analysis/nearEqual.ts `isNearBest`); "Slightly better: c6"
 * for an Excellent or Good move that was not (unless its text says what it gives away, see
 * `concession`; older saves without the near-equal fields keep "Best was"); "Best was c5" for any
 * other; "Best move" when the best move is unknown.
 */
export function showBestTitle(
  ply: Pick<Ply, 'uci' | 'classification' | 'explanation'> | null | undefined,
  bestSan: string | null,
): string {
  const cl = ply?.classification;
  if (ply && cl && isNearBest(cl, ply.uci)) {
    const moves = new Set([cl.bestMoveUci, ...(cl.equalBest ?? []).map((m) => m.uci)]);
    return moves.size > 1 ? 'Top choices' : 'Top choice';
  }
  if (!bestSan) return 'Best move';
  if (ply && cl?.nearBest === false && SLIGHT_CLASSES.has(cl.cls) && !concession(ply)) return `Slightly better: ${bestSan}`;
  return `Best was ${bestSan}`;
}

/**
 * Show best's first lines when the played move was about as good as the best (`isNearBest`): the
 * engine's near-equal moves with their evaluations as the eval bar shows them ("c6 +0.5 · c5 +0.6
 * · g6 +0.6"), then the played move, said from the mover's side so the eval bar's signs cannot
 * mislead: "Your Nxd5: +0.8, close behind." ("…, at least as good." when it scored at least as
 * well, `aboveBest`), or "Your c5 is one of them." when it is listed. `owner` is "Your" or the
 * opponent's "Pip’s". Empty for any other move.
 */
export function nearBestShowLines(
  ply: Pick<Ply, 'fenBefore' | 'fenAfter' | 'uci' | 'san' | 'evalWhite' | 'classification'>,
  owner: string,
): string[] {
  const cl = ply.classification;
  if (!cl || !isNearBest(cl, ply.uci)) return [];
  const equal = cl.equalBest?.length ? cl.equalBest : cl.bestMoveSan ? [{ san: cl.bestMoveSan, uci: cl.bestMoveUci! }] : [];
  const stm = sideToMove(ply.fenBefore);
  const evals = equal
    .map((m) => ('score' in m && m.score ? `${m.san} ${formatScore(toWhitePov(m.score, ply.fenBefore), stm)}` : m.san))
    .join(' · ');
  const listed = equal.some((m) => m.uci === ply.uci);
  // "At least as good" only when the numbers shown say so too: the verdict may come from the
  // second opinion (two searches of their own), whose best-move score is not the one listed here.
  const first = equal[0];
  const bestShown = first && 'score' in first && first.score ? first.score : null;
  const playedShown = ply.evalWhite ? whitePovTo(ply.evalWhite, stm) : null;
  const behind = !!bestShown && !!playedShown && scoreKey(playedShown) < scoreKey(bestShown);
  const how = cl.aboveBest && !behind ? 'at least as good' : 'close behind';
  const played = listed
    ? `${owner} ${ply.san} is one of them.`
    : ply.evalWhite
      ? `${owner} ${ply.san}: ${formatScore(ply.evalWhite, sideToMove(ply.fenAfter))}, ${how}.`
      : `${owner} ${ply.san} is ${how}.`;
  return evals ? [evals, played] : [played];
}

/** Orders scores from one side's point of view (a mate for it first, the fastest first). */
function scoreKey(s: Score): number {
  if (s.kind === 'cp') return s.value;
  return s.value > 0 ? 1e6 - s.value : -1e6 - s.value;
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

const PIECE_NAMES: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' };

/**
 * The tip right after the opponent took one of your pieces, when you can take back on that square
 * without losing material (static exchange, `see` >= 0, with some legal capture there): "Rocco just
 * took your bishop on c1. Can you recapture?". Null when `last` was no capture by the opponent, or
 * no recapture holds its own.
 */
export function recaptureTip(
  fen: string,
  last: Pick<Ply, 'uci' | 'color' | 'captured'> | null | undefined,
  opponent: string,
): string | null {
  const piece = last?.captured ? PIECE_NAMES[last.captured] : undefined;
  if (!last || !piece) return null;
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  const me = chess.turn();
  if (me === last.color) return null;
  const to = last.uci.slice(2, 4) as Square;
  const holds = chess
    .moves({ verbose: true })
    .some((m) => m.to === to && !!m.captured && see(fen, to, me, m.from) >= 0);
  return holds ? `${opponent} just took your ${piece} on ${to}. Can you recapture?` : null;
}

/** Whether `text` names the move `san` as a whole word (check / mate signs ignored). */
export function mentionsMove(text: string, san: string): boolean {
  const core = san.replace(/[+#?!]+$/, '');
  if (!core) return false;
  const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${escaped}(?![A-Za-z0-9=-])`).test(text);
}

/** Words before a square name that make it a square, not a pawn move ("your knight on d4"). */
const SQUARE_CONTEXT = /\b(on|to|from|the|pawn|square|at)\s+$/i;

/**
 * `mentionsMove`, except that a pawn move written as a bare square ("d4") does not count where the
 * text names that square ("This hangs your knight on d4.", "the pawn to d4"): only where it names
 * the move ("Best was d4.", "You missed d4, which …").
 */
export function namesMove(text: string, san: string): boolean {
  const core = san.replace(/[+#?!]+$/, '');
  if (!/^[a-h][1-8]$/.test(core)) return mentionsMove(text, san);
  const re = new RegExp(`(^|[^A-Za-z0-9-])${core}(?![A-Za-z0-9=-])`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!SQUARE_CONTEXT.test(text.slice(0, m.index + m[1].length))) return true;
  }
  return false;
}

/** Opening sentence when the explanation's own headline would give the better move away. */
const ANSWER_FREE_LEAD: Partial<Record<MoveClass, string>> = {
  mistake: 'There was a clearly better move here.',
  miss: 'You missed a chance to punish your opponent’s mistake.',
  blunder: 'There was a much better move here.',
};

/**
 * The explanation of a move the player may still Retry, without giving the better move away: no
 * line that names it ("Best was Nf3, which …", "You missed Qxh5, which wins a knight.") or one of
 * the moves about as good as it (`Classification.equalBest`; a line that only names a pawn move's
 * square, "your knight on d4", stays: `namesMove`), no description of a missed tactic, and no
 * "promotes to a knight instead of a queen" (which says what to promote to). "Show best" reveals
 * the rest. Always at least one line.
 */
export function answerFreeLines(e: Explanation | undefined | null, cl: Classification): string[] {
  const all = e ? [e.headline, ...e.details] : [];
  const better = [cl.bestMoveSan, ...(cl.equalBest ?? []).map((m) => m.san)].filter(
    (san): san is string => !!san && san !== cl.playedMoveSan,
  );
  const motifs = e?.motifs ?? [];
  const missedTactic = motifs.includes('missedTactic');
  const underpromotion = motifs.includes('underpromotion');
  const lines = all.filter(
    (line, i) =>
      !better.some((san) => namesMove(line, san)) && !(missedTactic && i > 0) && !(underpromotion && i === 0),
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

/** Who the repetition text speaks about (see `repetitionExplanation`). */
export interface RepetitionVoice {
  /** The move is the player's. */
  human: boolean;
  /** The computer's name (its moves in the game). */
  botName: string;
  /**
   * A move the player tried in the explorer for the computer's side: said by its color ("Black
   * was winning…"), not as the computer's.
   */
  neutral?: boolean;
  /** The mover's color (for the neutral voice). */
  mover?: Color;
  /**
   * The move lets the opponent repeat the position for the third time (its only reply, or one it
   * would gladly take), rather than repeating it itself.
   */
  allows?: boolean;
}

/**
 * Explanation of a move that repeats the position for the third time (the game is drawn at once),
 * or that lets the opponent do so (`allows`). The engine only sees the position, not the game's
 * history, so its own explanation would praise or criticize the move as if play went on.
 */
export function repetitionExplanation(san: string, cl: Classification, opts: RepetitionVoice): Explanation {
  const side = (c: Color | undefined) => (c === 'b' ? 'Black' : 'White');
  const neutral = !opts.human && !!opts.neutral;
  const mover = opts.human ? 'You' : neutral ? side(opts.mover) : opts.botName;
  const opponent = opts.human ? opts.botName : neutral ? side(opts.mover === 'b' ? 'w' : 'b') : 'you';
  const details: string[] = [];
  if (cl.winBefore >= 0.6) {
    details.push(
      opts.human
        ? opts.allows
          ? 'You were winning: when you are ahead, don’t give your opponent the chance to repeat the position.'
          : 'You were winning: when you are ahead, avoid repeating the position.'
        : neutral
          ? `${mover} was winning, so this draw gives the win away.`
          : `${opts.botName} was winning, so the draw let you off the hook.`,
    );
    if (cl.bestMoveSan && cl.bestMoveSan !== san) {
      const alternatives = equalAlternatives(cl)
        .map((m) => m.san)
        .filter((alt) => alt !== san);
      details.push(bestWasSentence(cl.bestMoveSan, { alternatives }));
    }
  } else if (cl.winBefore <= 0.4) {
    details.push(
      opts.human
        ? 'A draw is a good result from a lost position.'
        : neutral
          ? `${mover} was losing, so a draw is a good result for ${mover}.`
          : `${opts.botName} was losing, so a draw is a good result for it.`,
    );
  }
  return {
    headline: opts.allows
      ? `${san} lets ${opponent} repeat the position for the third time, which ends the game in a draw.`
      : `${san} repeats the position for the third time, so the game is a draw.`,
    details,
    title: 'Repetition',
    motifs: [opts.allows ? 'allowsRepetition' : 'repetition'],
  };
}

/**
 * The result of a game ended by a draw rule, in plain words for a beginner (the coach after the
 * game and the game-over sheet say it); null for any other result (checkmate, a resignation).
 */
export function drawRuleText(reason: string): string | null {
  switch (reason) {
    case 'Stalemate':
      return 'Stalemate: the side to move has no legal move and is not in check, so the game is a draw.';
    case 'Threefold repetition':
      return 'Threefold repetition: the same position came up for the third time, so the game is a draw.';
    case 'Insufficient material':
      return 'Insufficient material: neither side has enough pieces left to checkmate, so the game is a draw.';
    case '50-move rule':
      return '50-move rule: 50 moves in a row by each side without a capture or a pawn move, so the game is a draw.';
    default:
      return null;
  }
}
