/**
 * The board theme and piece set pickers of the "Board & pieces" sheet (src/ui/SkinsSheet.tsx), for
 * the skins of src/ui/skins.ts, and the Menu row's thumbnail. Each picker is a radio group of tiles
 * drawn in the skin itself: a board theme as two of its squares (with its texture, at the board's
 * scale), a piece set as its white knight and black king on the chosen board's squares. VoiceOver
 * reads a tile by its full name ("Brown board", "Chessnut pieces"); the arrow keys move the choice
 * (wrapping; Home and End go to the first and last), as in the Menu's other pickers. Nothing here
 * is ever locked: every skin is free.
 */
import { BOARD_THEMES, PIECE_SETS, boardThemeLabel, pieceSetLabel, type BoardThemeId, type PieceSetId } from './skins';
import './skins.css';
import './SkinPickers.css';

interface PickerProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  /** The id of the heading that names the group. */
  labelledBy: string;
}

/**
 * The option a key moves the choice to: the next one for → and ↓, the previous one for ← and ↑
 * (wrapping), the first for Home and the last for End; null for any other key. An unknown `value`
 * counts as the first option.
 */
export function stepChoice<T>(ids: readonly T[], value: T, key: string): T | null {
  if (!ids.length) return null;
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (!step) return null;
  const index = Math.max(0, ids.indexOf(value));
  return ids[(index + step + ids.length) % ids.length];
}

/** The group's keys: the option `stepChoice` gives, chosen and focused. */
function onGroupKey<T extends string>(ids: readonly T[], value: T, onChange: (v: T) => void, attr: string) {
  return (e: KeyboardEvent) => {
    const next = stepChoice(ids, value, e.key);
    if (next === null) return;
    e.preventDefault();
    if (next !== value) onChange(next);
    const group = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => group.querySelector<HTMLElement>(`[${attr}="${next}"]`)?.focus());
  };
}

/** The board themes, as two squares each (light, dark) with the name under them. */
export function BoardThemePicker({ value, onChange, labelledBy }: PickerProps<BoardThemeId>) {
  const ids = BOARD_THEMES.map((t) => t.id);
  return (
    <div
      class="sheet-group skin-grid skin-grid--boards"
      role="radiogroup"
      aria-labelledby={labelledBy}
      data-id="board-themes"
      onKeyDown={onGroupKey(ids, value, onChange, 'data-skin-board')}
    >
      {BOARD_THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          class="skin-opt"
          data-skin-board={t.id}
          aria-checked={t.id === value ? 'true' : 'false'}
          aria-label={boardThemeLabel(t.id)}
          tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)}
        >
          <span class="skin-swatch" data-board={t.id} aria-hidden="true" />
          <span class="skin-name" aria-hidden="true">
            {t.name}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The piece sets, as the set's white knight on the chosen board's light square and its black king on
 * the dark one (each on its own color, where a set and a board can blend), with the name under them.
 */
export function PieceSetPicker({ value, onChange, labelledBy }: PickerProps<PieceSetId>) {
  const ids = PIECE_SETS.map((s) => s.id);
  return (
    <div
      class="sheet-group skin-grid skin-grid--pieces"
      role="radiogroup"
      aria-labelledby={labelledBy}
      data-id="piece-sets"
      onKeyDown={onGroupKey(ids, value, onChange, 'data-skin-pieces')}
    >
      {PIECE_SETS.map((s) => (
        <button
          key={s.id}
          type="button"
          role="radio"
          class="skin-opt"
          data-skin-pieces={s.id}
          aria-checked={s.id === value ? 'true' : 'false'}
          aria-label={pieceSetLabel(s.id)}
          tabIndex={s.id === value ? 0 : -1}
          onClick={() => onChange(s.id)}
        >
          {/* White on light, black on dark: where a set blends into this board, the tile shows it. */}
          <span class="skin-pair" data-pieces={s.id} aria-hidden="true">
            <span class="skin-sq skin-sq--light">
              <i class="piece-art" data-p="wn" />
            </span>
            <span class="skin-sq skin-sq--dark">
              <i class="piece-art" data-p="bk" />
            </span>
          </span>
          <span class="skin-name" aria-hidden="true">
            {s.name}
          </span>
        </button>
      ))}
    </div>
  );
}

/** The Menu row's icon: a 2x2 board in the chosen theme with the chosen set's white knight. */
export function SkinThumb() {
  return (
    <span class="skin-thumb" aria-hidden="true">
      <i class="piece-art" data-p="wn" />
    </span>
  );
}
