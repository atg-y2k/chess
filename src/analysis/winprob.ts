/**
 * Win probability and score formatting.
 *
 * All probabilities are 0..1. Engine scores (`Score`) follow the UCI convention: they belong to the
 * side to move, and `mate 0` means the side to move is already checkmated. A score converted to
 * White's point of view with `toWhitePov()` keeps that `0` (as `-0` when Black was to move), so the
 * functions that take a White-POV score accept an optional `sideToMove` to resolve `mate 0`
 * unambiguously (a `-0` survives in memory but not through JSON).
 */
import type { AnalysisResult, Score } from '../engine/types';
import type { Color } from '../game/types';

/** lichess winning-chances slope (lila PR #11148, fitted on 2300+ rapid games). */
export const WIN_K = 0.00368208;

/** Centipawn ceiling lichess applies before converting to win percent (and for the eval bar). */
export const CP_CEILING = 1000;

/** Game-over marker the engine layer attaches to an analysis of a finished position. */
export type TerminalKind = 'checkmate' | 'stalemate';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Expected score (0..1) for the side a centipawn score belongs to: lichess logistic, unclamped. */
export function cpToWin(cp: number): number {
  return 1 / (1 + Math.exp(-WIN_K * cp));
}

/** Expected score (0..1) for the side the score belongs to. Mate for that side is 1, mated (or mate 0) is 0. */
export function scoreToWin(score: Score): number {
  if (score.kind === 'cp') return cpToWin(score.value);
  return score.value > 0 ? 1 : 0;
}

/**
 * The side that is checkmated when a White-POV score is `mate 0`. `sideToMove` wins when given;
 * otherwise the sign of zero left by `toWhitePov()` is used (`-0` = Black was to move and is mated).
 */
export function matedSide(scoreWhite: Score, sideToMove?: Color): Color {
  if (sideToMove) return sideToMove;
  return Object.is(scoreWhite.value, -0) ? 'b' : 'w';
}

/**
 * Eval-bar fill for White (0..1), following lichess's client: centipawns are clamped to ±1000 and a
 * mate in N counts as (21 - min(10, N)) * 100 cp, so a mate shows an almost (not entirely) full bar.
 * A finished checkmate (`mate 0`) fills or empties it completely.
 */
export function whiteBarFraction(scoreWhite: Score, sideToMove?: Color): number {
  if (scoreWhite.kind === 'cp') return cpToWin(clamp(scoreWhite.value, -CP_CEILING, CP_CEILING));
  const n = scoreWhite.value;
  if (n === 0) return matedSide(scoreWhite, sideToMove) === 'w' ? 0 : 1;
  return cpToWin((21 - Math.min(10, Math.abs(n))) * 100 * Math.sign(n));
}

/**
 * Short label for a White-POV score: "+1.3", "-0.4", "0.0", "M3" (White mates), "-M2" (Black mates),
 * and "1-0" / "0-1" for a finished checkmate (`mate 0`; pass `sideToMove` for an unambiguous result).
 */
export function formatScore(scoreWhite: Score, sideToMove?: Color): string {
  const v = scoreWhite.value;
  if (scoreWhite.kind === 'mate') {
    if (v === 0) return matedSide(scoreWhite, sideToMove) === 'w' ? '0-1' : '1-0';
    return v > 0 ? `M${v}` : `-M${-v}`;
  }
  const pawns = Math.round(Math.abs(v) / 10) / 10;
  if (pawns === 0) return '0.0';
  return `${v > 0 ? '+' : '-'}${pawns.toFixed(1)}`;
}

/** The same score from the other side's point of view. */
export function negateScore(s: Score): Score {
  if (s.kind === 'cp') return { kind: 'cp', value: s.value === 0 ? 0 : -s.value };
  // Mate keeps `-0` for mate 0 on purpose, mirroring `toWhitePov()`.
  return { kind: 'mate', value: -s.value };
}

/**
 * Converts the score of the position AFTER a move (opponent to move, UCI convention) into the
 * mover's point of view, keeping Stockfish's "mate in N moves" counted from the position BEFORE the
 * move: child `mate -m` (opponent mated in m) becomes `mate m+1`, child `mate +k` becomes `mate -k`,
 * and child `mate 0` (the move checkmated) becomes `mate 1`.
 */
export function childToMover(child: Score): Score {
  if (child.kind === 'cp') return negateScore(child);
  return child.value <= 0 ? { kind: 'mate', value: -child.value + 1 } : { kind: 'mate', value: -child.value };
}

/**
 * Side-to-move score of an analysis: its best line, `mate 0` for a checkmated position, `0.0` for a
 * stalemate, or null when nothing is known yet. Convert with `toWhitePov(score, result.fen)` to store it.
 */
export function resultScore(result: AnalysisResult & { terminal?: TerminalKind }): Score | null {
  if (result.terminal === 'checkmate') return { kind: 'mate', value: 0 };
  if (result.terminal === 'stalemate') return { kind: 'cp', value: 0 };
  return result.lines[0]?.score ?? null;
}
