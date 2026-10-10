/**
 * Vertical evaluation bar. White's share grows from White's side of the board (the bottom when
 * `orientation` is 'white'); the score label sits at the winning side's end. It stretches to the
 * height of its flex row, so place it next to the board in a row with `align-items: stretch`.
 */
import './EvalBar.css';

export interface EvalBarProps {
  /** 0..1 */
  whiteWinProb: number;
  /** e.g. "+1.3", "M3", "-M2", "0.0" */
  label: string;
  /** White at the bottom when 'white'. */
  orientation: 'white' | 'black';
  /** Subtle pulse while analysis is shallow. */
  thinking?: boolean;
  /**
   * No engine here (the explorer with its engine off): a neutral bar that says "Engine off" instead
   * of an evaluation, so the board keeps its place and size.
   */
  off?: boolean;
}

/**
 * The label without its sign (the end of the bar it sits at already says who is better), and
 * whole pawns from 10 up ("12", not "12.3"), so it stays short enough for a legible size.
 */
export function evalBarText(label: string): string {
  const text = label.replace(/^[+\-−](?=[\dM#])/, '');
  return /^\d{2,}\.\d$/.test(text) ? String(Math.round(Number(text))) : text;
}

/** Labels with three or more characters besides "." and "-" (e.g. "M10") get a smaller size. */
export function isLongEvalText(text: string): boolean {
  return text.replace(/[.\-]/g, '').length >= 3;
}

export function EvalBar({ whiteWinProb, label, orientation, thinking, off = false }: EvalBarProps) {
  if (off) {
    return (
      <div class="evalbar evalbar-off" role="img" aria-label="Evaluation: engine off" title="Engine off">
        <span class="evalbar-off-text" aria-hidden="true">
          Engine off
        </span>
      </div>
    );
  }
  const p = Number.isFinite(whiteWinProb) ? Math.min(1, Math.max(0, whiteWinProb)) : 0.5;
  const whiteBottom = orientation === 'white';
  const whiteBetter = p >= 0.5;
  const labelAtBottom = whiteBetter === whiteBottom;
  const text = evalBarText(label);
  // The White fill is a full-height layer slid out of view, so its edge stays crisp while animating.
  const offset = (1 - p) * 100;
  const cls =
    'evalbar' +
    (whiteBottom ? '' : ' evalbar-flipped') +
    (thinking ? ' evalbar-thinking' : '');
  return (
    <div
      class={cls}
      role="meter"
      aria-label="Evaluation"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p * 100)}
      aria-valuetext={label}
      title={label}
    >
      <div class="evalbar-white" style={{ transform: `translateY(${whiteBottom ? offset : -offset}%)` }} />
      <div class="evalbar-mid" />
      <span
        class={
          'evalbar-label' +
          (labelAtBottom ? ' evalbar-label-bottom' : ' evalbar-label-top') +
          (whiteBetter ? ' evalbar-on-white' : ' evalbar-on-black') +
          (isLongEvalText(text) ? ' evalbar-label-long' : '')
        }
      >
        {text}
      </span>
    </div>
  );
}
