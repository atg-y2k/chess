import { DRAW_COLOR_NAMES, type DrawColor } from '../game/drawings';
import { IconPencil, IconTrash } from './icons';
import './DrawBar.css';

export interface DrawToggleProps {
  onClick: () => void;
}

/**
 * The Draw toggle: a pencil pill ("Draw") that turns Draw mode on, where the board takes arrows and
 * circles instead of moves. The page places it (on the player strip under the board).
 */
export function DrawToggle({ onClick }: DrawToggleProps) {
  return (
    <button type="button" class="draw-toggle" data-id="draw" aria-label="Draw on the board" onClick={onClick}>
      <IconPencil size={17} />
      <span class="draw-toggle-label" aria-hidden="true">
        Draw
      </span>
    </button>
  );
}

export interface DrawBarProps {
  /** The color being drawn in, and the ones offered (the swatches). */
  color: DrawColor;
  colors: readonly DrawColor[];
  /** The board's position has drawings (else Clear is disabled). */
  canClear: boolean;
  /**
   * A tip under the bar (above it in landscape), e.g. the first time. Taps go through it to what is
   * under it (it may cover a control, such as the explorer's Engine switch).
   */
  tip?: string | null;
  /**
   * It is the player's move in the game (the strip's turn dot is under the bar): the pencil gives way
   * to the same pulsing dot ("Your move" where the bar has room, and for screen readers), and Done,
   * which brings back moving pieces, pulses a few times.
   */
  yourMove?: boolean;
  onColor: (color: DrawColor) => void;
  onClear: () => void;
  /** Leaves Draw mode (the drawings stay). */
  onDone: () => void;
}

/**
 * Draw mode's bar, in the Draw toggle's place (it covers the player strip it sits on, so nothing
 * moves): the four colors, Clear (this position's drawings) and Done.
 */
export function DrawBar({ color, colors, canClear, tip, yourMove = false, onColor, onClear, onDone }: DrawBarProps) {
  return (
    <div class="drawbar" role="toolbar" aria-label="Draw" data-color={color} data-your-move={yourMove ? '' : undefined}>
      <span class="drawbar-mode" aria-hidden="true">
        {yourMove ? <span class="drawbar-turn" /> : <IconPencil size={16} />}
        <span class="drawbar-mode-label">{yourMove ? 'Your move' : 'Draw'}</span>
      </span>
      <span class="visually-hidden" role="status">
        {yourMove ? 'Your move. Tap Done to move a piece.' : ''}
      </span>
      <div class="drawbar-colors" role="radiogroup" aria-label="Color">
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            class="drawbar-swatch"
            data-color={c}
            aria-checked={c === color ? 'true' : 'false'}
            aria-label={DRAW_COLOR_NAMES[c]}
            onClick={() => onColor(c)}
          >
            <span class="drawbar-dot" />
          </button>
        ))}
      </div>
      <button
        type="button"
        class="drawbar-btn drawbar-clear"
        data-id="draw-clear"
        aria-label="Clear drawings"
        disabled={!canClear}
        onClick={onClear}
      >
        <IconTrash size={17} />
        <span class="drawbar-clear-label" aria-hidden="true">
          Clear
        </span>
      </button>
      <button type="button" class="drawbar-btn drawbar-done" data-id="draw-done" onClick={onDone}>
        Done
      </button>
      {tip && (
        <p class="drawbar-tip" role="status">
          {tip}
        </p>
      )}
    </div>
  );
}
