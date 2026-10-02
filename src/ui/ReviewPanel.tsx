import { MOVE_CLASS_ORDER, type MoveClass } from '../analysis/types';
import type { Color } from '../game/types';
import { CLASS_META, ClassIcon } from './ClassIcon';
import { IconChevronRight, IconClose } from './icons';
import './ReviewPanel.css';

export interface KeyMoment {
  /** 0-based ply index. */
  index: number;
  cls: MoveClass;
  san: string;
  text: string;
  /**
   * The class praises the move but `text` says what it gives away (`Explanation.concedes`): the
   * moment is shown with a neutral marker and label instead of the class.
   */
  concedes?: 'material' | 'mate';
}

export interface ReviewPanelProps {
  /** 0..1 while analysing the game, null when complete. */
  progress: number | null;
  accuracy: { w: number | null; b: number | null };
  counts: Record<Color, Partial<Record<MoveClass, number>>>;
  playerColor: Color;
  names: { w: string; b: string };
  keyMoments: KeyMoment[];
  /** Called with the number of plies to show (index + 1). */
  onSelectPly: (current: number) => void;
  onClose: () => void;
}

/** Rows always shown in the counts table, even when both sides have zero. */
export const CORE_REVIEW_CLASSES: ReadonlySet<MoveClass> = new Set<MoveClass>([
  'brilliant',
  'best',
  'inaccuracy',
  'mistake',
  'blunder',
]);

/** Classes for the counts table, in MOVE_CLASS_ORDER, dropping all-zero non-core rows. */
export function visibleReviewClasses(counts: ReviewPanelProps['counts']): MoveClass[] {
  return MOVE_CLASS_ORDER.filter(
    (cls) => CORE_REVIEW_CLASSES.has(cls) || (counts.w[cls] ?? 0) > 0 || (counts.b[cls] ?? 0) > 0,
  );
}

/** Accuracy for display: one decimal, or an en dash while unknown. */
export function formatAccuracy(a: number | null): string {
  return a == null || !Number.isFinite(a) ? '–' : (Math.round(a * 10) / 10).toFixed(1);
}

/** "12." for White's ply 22, "12…" for Black's ply 23 (assumes the game started from move 1 with White). */
function moveLabel(index: number): string {
  return `${Math.floor(index / 2) + 1}${index % 2 === 0 ? '.' : '…'}`;
}

const SIDES: Color[] = ['w', 'b'];

/** Row tone of a key moment that gives something away: the neutral grey of Forced. */
const CONCESSION_TONE = 'var(--cls-forced)';

/** Label of a key moment: its class ("Blunder"), or what a praised move gives away. */
export function momentLabel(m: Pick<KeyMoment, 'cls' | 'concedes'>): string {
  if (m.concedes === 'mate') return 'Faster mate';
  if (m.concedes === 'material') return 'Gives up material';
  return CLASS_META[m.cls].label;
}

/** Neutral marker for a key moment that gives something away (no class icon praising it). */
function ConcessionIcon({ label, size }: { label: string; size: number }) {
  return (
    <span
      class="class-icon review-moment-concedes"
      role="img"
      aria-label={label}
      title={label}
      style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.62)}px` }}
    >
      −
    </span>
  );
}

/**
 * Post-game review summary (replaces the coach panel in review mode): accuracy per side,
 * analysis progress, move-class counts and tappable key moments. Scrolls internally.
 */
export function ReviewPanel({
  progress,
  accuracy,
  counts,
  playerColor,
  names,
  keyMoments,
  onSelectPly,
  onClose,
}: ReviewPanelProps) {
  const analysing = progress != null;
  const pct = analysing ? Math.round(Math.max(0, Math.min(1, progress)) * 100) : 100;
  const rows = visibleReviewClasses(counts);

  return (
    <section class="review" aria-label="Game Review" data-analysing={analysing ? '' : undefined}>
      <header class="review-head">
        {SIDES.map((c) => (
          <div key={c} class="review-side" data-color={c} data-you={c === playerColor ? '' : undefined}>
            <span class="review-acc" title={c === playerColor ? 'You' : undefined}>
              {formatAccuracy(accuracy[c])}
            </span>
            <span class="review-who">
              <span class="review-name">{names[c]}</span>
              <span class="review-sub">Accuracy</span>
            </span>
          </div>
        ))}
        <button type="button" class="review-close" aria-label="Close review" onClick={onClose}>
          <IconClose size={20} />
        </button>
      </header>
      {analysing && (
        <div class="review-progress-row">
          <span class="review-status">Analyzing game… {pct}%</span>
          <div
            class="review-progress"
            role="progressbar"
            aria-label="Analysis progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div class="review-body">
        <table class="review-table">
          <thead>
            <tr>
              <th scope="col" class="review-th-label" colSpan={2}>
                Moves
              </th>
              <th scope="col" class="review-th-side">
                <span class="review-chip" data-color="w">
                  White
                </span>
              </th>
              <th scope="col" class="review-th-side">
                <span class="review-chip" data-color="b">
                  Black
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((cls) => {
              const w = counts.w[cls] ?? 0;
              const b = counts.b[cls] ?? 0;
              return (
                <tr key={cls} data-cls={cls} style={{ '--row-tone': CLASS_META[cls].color }}>
                  <td class="review-icon">
                    <ClassIcon cls={cls} size={20} />
                  </td>
                  <th scope="row" class="review-label">
                    {CLASS_META[cls].label}
                  </th>
                  <td class="review-count" data-zero={w === 0 ? '' : undefined}>
                    {w}
                  </td>
                  <td class="review-count" data-zero={b === 0 ? '' : undefined}>
                    {b}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div class="review-moments">
          <h3 class="review-subtitle">
            Key moments
            {keyMoments.length > 0 && <span class="review-badge">{keyMoments.length}</span>}
          </h3>
          {keyMoments.length === 0 ? (
            <p class="review-empty">{analysing ? 'Looking for turning points…' : 'No big swings — a clean game.'}</p>
          ) : (
            <ul class="review-list">
              {keyMoments.map((m) => (
                <li key={m.index}>
                  <button
                    type="button"
                    class="review-moment"
                    data-index={m.index}
                    data-concedes={m.concedes}
                    style={{ '--row-tone': m.concedes ? CONCESSION_TONE : CLASS_META[m.cls].color }}
                    onClick={() => onSelectPly(m.index + 1)}
                  >
                    {m.concedes ? <ConcessionIcon label={momentLabel(m)} size={24} /> : <ClassIcon cls={m.cls} size={24} />}
                    <span class="review-moment-main">
                      <span class="review-moment-head">
                        <span class="review-moment-no">{moveLabel(m.index)}</span>
                        <span class="review-moment-san">{m.san}</span>
                        <span class="review-moment-cls">{momentLabel(m)}</span>
                      </span>
                      <span class="review-moment-text">{m.text}</span>
                    </span>
                    <IconChevronRight size={18} class="review-moment-chevron" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
