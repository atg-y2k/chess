import type { MoveClass } from '../analysis/types';
import './ClassIcon.css';

export interface ClassMeta {
  label: string;
  /** Short glyph drawn inside the badge. */
  symbol: string;
  /** CSS colour (var) for UI text/badges. */
  color: string;
  /** Literal hex of the same colour (for SVG injected into the board). */
  hex: string;
  /** One-line description used in legends/tooltips. */
  description: string;
}

export const CLASS_META: Record<MoveClass, ClassMeta> = {
  brilliant: { label: 'Brilliant', symbol: '!!', color: 'var(--cls-brilliant)', hex: '#1fbfa2', description: 'A strong sacrifice that is also (nearly) the best move.' },
  great: { label: 'Great', symbol: '!', color: 'var(--cls-great)', hex: '#5a8fc4', description: 'The only good move, or one that changes the course of the game.' },
  best: { label: 'Best', symbol: '★', color: 'var(--cls-best)', hex: '#6fb04b', description: 'The engine’s top choice.' },
  excellent: { label: 'Excellent', symbol: '👍', color: 'var(--cls-excellent)', hex: '#8fbf4a', description: 'Almost as good as the best move.' },
  good: { label: 'Good', symbol: '✓', color: 'var(--cls-good)', hex: '#93ad8b', description: 'A decent move that keeps most of your advantage.' },
  book: { label: 'Book', symbol: '📖', color: 'var(--cls-book)', hex: '#a98763', description: 'A known opening move.' },
  forced: { label: 'Forced', symbol: '□', color: 'var(--cls-forced)', hex: '#95a1a6', description: 'The only legal move.' },
  inaccuracy: { label: 'Inaccuracy', symbol: '?!', color: 'var(--cls-inaccuracy)', hex: '#efc04e', description: 'A slightly weaker move than the best.' },
  mistake: { label: 'Mistake', symbol: '?', color: 'var(--cls-mistake)', hex: '#e88a2a', description: 'A move that gives away a good part of your advantage.' },
  miss: { label: 'Miss', symbol: '✕', color: 'var(--cls-miss)', hex: '#ee6b55', description: 'You missed a chance to punish your opponent’s mistake.' },
  blunder: { label: 'Blunder', symbol: '??', color: 'var(--cls-blunder)', hex: '#d23a33', description: 'A serious mistake that loses material or the game.' },
};

/**
 * SVG markup for a classification badge, drawn in chessground's per-square 0..100 coordinate
 * box (use as `customSvg: { html }` on a shape with `orig` = the square). The badge overhangs the
 * square's top-right corner like chess.com's move icons.
 */
export function classBadgeSvg(cls: MoveClass): string {
  const { hex, symbol } = CLASS_META[cls];
  const isEmoji = /\p{Extended_Pictographic}/u.test(symbol);
  const fs = isEmoji ? 20 : symbol.length > 1 ? 24 : 30;
  return (
    `<g transform="translate(66 -6)">` +
    `<circle cx="17" cy="17" r="17" fill="#000" opacity=".28" transform="translate(1.5 2.5)"/>` +
    `<circle cx="17" cy="17" r="17" fill="${hex}" stroke="#fff" stroke-width="2.5"/>` +
    `<text x="17" y="17" dy=".36em" text-anchor="middle" font-size="${fs}" font-weight="800" ` +
    `font-family="-apple-system,system-ui,sans-serif" fill="#fff">${symbol}</text></g>`
  );
}

export interface ClassIconProps {
  cls: MoveClass;
  /** Diameter in CSS px (default 18). */
  size?: number;
  /** Accessible label (defaults to the class label). */
  title?: string;
}

export function ClassIcon({ cls, size = 18, title }: ClassIconProps) {
  const meta = CLASS_META[cls];
  const isEmoji = /\p{Extended_Pictographic}/u.test(meta.symbol);
  return (
    <span
      class="class-icon"
      role="img"
      aria-label={title ?? meta.label}
      title={title ?? meta.label}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        background: meta.color,
        fontSize: `${Math.round(size * (isEmoji ? 0.55 : meta.symbol.length > 1 ? 0.5 : 0.62))}px`,
      }}
    >
      {meta.symbol}
    </span>
  );
}
