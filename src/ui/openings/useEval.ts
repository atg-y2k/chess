/**
 * The evaluation of an Openings board position, from the app's own AnalysisService (the one the
 * game uses), so the section needs no engine of its own. A light request (`ensure` to depth 12
 * within OPENINGS_NODES nodes, one line), asked only after the position has stayed put for a
 * moment and withdrawn as soon as it changes or the page closes: stepping through a line never
 * queues searches, and the game's own annotations (which share the FIFO) wait at most one short
 * search. A cached result of the game's (any depth from 10) answers at once.
 */
import { useEffect, useState } from 'preact/hooks';
import { formatScore, resultScore, whiteBarFraction } from '../../analysis/winprob';
import { sideToMove, toWhitePov } from '../../chess/utils';
import type { AnalysisService } from '../../engine/AnalysisService';
import type { AnalysisResult, Score } from '../../engine/types';

/** Depth asked for. */
export const OPENINGS_DEPTH = 12;
/** Node budget: about half a second on an iPhone (a quarter of a coach annotation's). */
export const OPENINGS_NODES = 250_000;
/** A cached result at least this deep is shown without a new search. */
const CACHED_DEPTH = 10;
/** Wait this long on a position before asking (ms): stepping quickly asks for nothing. */
const SETTLE_MS = 220;

export interface EvalView {
  /** 0..1 */
  whiteWinProb: number;
  /** "+0.3", "M2", or '' while unknown. */
  label: string;
  /** A search is running for this position. */
  thinking: boolean;
  /** White-POV score (null while unknown). */
  scoreWhite: Score | null;
  /** The position this is about. */
  fen: string | null;
}

const UNKNOWN: EvalView = { whiteWinProb: 0.5, label: '', thinking: false, scoreWhite: null, fen: null };

/** The bar for an analysis result, or null when it has no score. */
export function evalFromResult(r: AnalysisResult): EvalView | null {
  const s = resultScore(r);
  if (!s) return null;
  const white = toWhitePov(s, r.fen);
  const turn = sideToMove(r.fen);
  return { whiteWinProb: whiteBarFraction(white, turn), label: formatScore(white, turn), thinking: false, scoreWhite: white, fen: r.fen };
}

/** Same position (board, side to move, castling): the en-passant square and move counters aside. */
const samePosition = (a: string | null, b: string | null): boolean =>
  !!a && !!b && a.split(' ').slice(0, 3).join(' ') === b.split(' ').slice(0, 3).join(' ');

/**
 * The engine's verdict on `fen` (White's point of view) when `view` is about that very position
 * and finished, else null: words like "about equal" must never describe the previous position.
 */
export function verdictFor(view: EvalView, fen: string): Score | null {
  return !view.thinking && samePosition(view.fen, fen) ? view.scoreWhite : null;
}

/**
 * The evaluation of `fen` (null: none wanted). Keeps the last bar, pulsing and without a verdict,
 * while the new position is being analyzed; unknown without an engine (still starting, failed, or
 * hidden during a rated game).
 */
export function useEval(analysis: AnalysisService | null, fen: string | null): EvalView {
  const [view, setView] = useState<EvalView>(UNKNOWN);
  useEffect(() => {
    if (!fen) return;
    const cached = analysis?.get(fen);
    const known = cached ? evalFromResult(cached) : null;
    if (known && cached && (cached.depth >= CACHED_DEPTH || cached.terminal)) {
      setView(known);
      return;
    }
    if (!analysis) {
      setView(known ?? UNKNOWN);
      return;
    }
    // The bar keeps its last fill (pulsing) meanwhile; the verdict (`scoreWhite`) is only ever this position's.
    setView((v) => known ?? { ...v, scoreWhite: null, thinking: true, fen });
    const ctl = new AbortController();
    const timer = window.setTimeout(() => {
      analysis
        .ensure(fen, { minDepth: OPENINGS_DEPTH, multiPv: 1, maxNodes: OPENINGS_NODES, signal: ctl.signal })
        .then((r) => {
          if (ctl.signal.aborted) return;
          setView(evalFromResult(r) ?? { ...UNKNOWN, fen });
        })
        .catch(() => {
          if (!ctl.signal.aborted) setView({ ...UNKNOWN, fen });
        });
    }, SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [analysis, fen]);
  return view;
}
