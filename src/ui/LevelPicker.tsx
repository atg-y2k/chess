/**
 * "Your level": a five-way segmented control of starting ratings (400 … 2000) with a caption that
 * names the selected level. Used by the New Game sheet (brand-new players) and the Menu's
 * "Set my level". Presentational: the levels come in as props (rating/rating.ts STARTING_LEVELS).
 */
import { useRef } from 'preact/hooks';
import './LevelPicker.css';

export interface StartingLevel {
  id: string;
  label: string;
  rating: number;
}

export interface LevelPickerProps {
  levels: readonly StartingLevel[];
  /** The current rating: the level with exactly this rating is selected (none when no level matches). */
  value: number | null;
  onChange: (rating: number) => void;
  /** Id of the element that labels the group. */
  labelledBy?: string;
  /** `data-id` of the group (tests). */
  id?: string;
}

/** One-line description of each level, by `StartingLevel.id`. */
export const LEVEL_BLURB: Record<string, string> = {
  beginner: 'still learning how the pieces move',
  casual: 'knows the rules and plays for fun',
  intermediate: 'spots tactics, knows some openings',
  advanced: 'plays often, online or at a club',
  expert: 'a strong club player',
};

/** The level whose rating is exactly `rating`, if any. */
export function levelFor(rating: number | null, levels: readonly StartingLevel[]): StartingLevel | undefined {
  return rating === null ? undefined : levels.find((l) => l.rating === Math.round(rating));
}

export function LevelPicker({ levels, value, onChange, labelledBy, id }: LevelPickerProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = levelFor(value, levels);
  const index = selected ? levels.indexOf(selected) : -1;
  const onKeyDown = (e: KeyboardEvent) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step || !levels.length) return;
    e.preventDefault();
    const next = index < 0 ? 0 : (index + step + levels.length) % levels.length;
    onChange(levels[next].rating);
    refs.current[next]?.focus();
  };
  const blurb = selected ? LEVEL_BLURB[selected.id] : undefined;
  return (
    <div class="lvl">
      <div
        class="lvl-seg"
        role="radiogroup"
        aria-labelledby={labelledBy}
        data-id={id}
        style={{ '--lvl-n': levels.length }}
        onKeyDown={onKeyDown}
      >
        {index >= 0 && (
          <span class="lvl-thumb" style={{ transform: `translateX(${index * 100}%)` }} aria-hidden="true" />
        )}
        {levels.map((l, i) => (
          <button
            key={l.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            class="lvl-opt"
            aria-checked={i === index ? 'true' : 'false'}
            aria-label={`${l.label}, ${l.rating}`}
            tabIndex={i === index || (index < 0 && i === 0) ? 0 : -1}
            data-level={l.id}
            onClick={() => onChange(l.rating)}
          >
            {l.rating}
          </button>
        ))}
      </div>
      <p class="lvl-caption" aria-live="polite">
        {selected ? (
          <>
            <strong>{selected.label}</strong>
            {blurb && <span>: {blurb}</span>}
          </>
        ) : (
          'Pick the level closest to yours.'
        )}
      </p>
    </div>
  );
}
