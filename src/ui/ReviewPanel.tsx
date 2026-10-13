import { MOVE_CLASS_ORDER, type MoveClass } from '../analysis/types';
import type { Color } from '../game/types';
import { CLASS_META, ClassIcon } from './ClassIcon';
import { IconChevronRight, IconClose, IconReset } from './icons';
import { IconLock } from './PaywallSheet';
import './ReviewPanel.css';

export interface KeyMoment {
  /** 0-based ply index. */
  index: number;
  cls: MoveClass;
  san: string;
  /** The move number as the move list writes it: "12." (White) or "12…" (Black). */
  label?: string;
  /** Whose move it is (the row says "You" or the opponent's name). */
  color?: Color;
  text: string;
  /**
   * The class praises the move but `text` says what it gives away (`Explanation.concedes`): the
   * moment is shown with a neutral marker and label instead of the class.
   */
  concedes?: 'material' | 'mate';
  /** One of the player's weak moves that can be tried again (game/practice.ts): a "Try again" button beside it. */
  tryAgain?: boolean;
}

export interface ReviewPanelProps {
  /** 0..1 while analysing the game, null when complete. */
  progress: number | null;
  accuracy: { w: number | null; b: number | null };
  counts: Record<Color, Partial<Record<MoveClass, number>>>;
  playerColor: Color;
  names: { w: string; b: string };
  keyMoments: KeyMoment[];
  /**
   * The key moments are part of Pro and locked: how many there are (`keyMoments` is then empty).
   * An unlock card takes the list's place; its button calls `onUnlock`.
   */
  lockedMoments?: number;
  onUnlock?: () => void;
  /** Called with the number of plies to show (index + 1). */
  onSelectPly: (current: number) => void;
  onClose: () => void;
  /**
   * "Try again" beside the key moments that have `tryAgain` (game/practice.ts): called with the
   * moment's ply index. Without it no such button shows.
   */
  onTryAgain?: (index: number) => void;
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

/** The moment's move number ("12." / "12…"); from the ply index for a moment without its label (a game from move 1). */
function moveLabel(m: Pick<KeyMoment, 'index' | 'label'>): string {
  return m.label ?? `${Math.floor(m.index / 2) + 1}${m.index % 2 === 0 ? '.' : '…'}`;
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

/** The locked key moments card's title: how many turning points Pro would show. */
export function lockedTitle(count: number, analysing: boolean): string {
  if (analysing && count === 0) return 'Looking for turning points…';
  if (count === 0) return 'No big swings: Pro explains every move.';
  return count === 1 ? '1 key moment found' : `${count} key moments found`;
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
  lockedMoments,
  onUnlock,
  onSelectPly,
  onClose,
  onTryAgain,
}: ReviewPanelProps) {
  const analysing = progress != null;
  const pct = analysing ? Math.round(Math.max(0, Math.min(1, progress)) * 100) : 100;
  const rows = visibleReviewClasses(counts);
  const locked = lockedMoments !== undefined;
  const momentCount = locked ? lockedMoments : keyMoments.length;

  // Your mistakes to try again come first (the counts follow): on a phone the report opens on them.
  const tryFirst = !locked && !!onTryAgain && keyMoments.some((m) => m.tryAgain);
  const table = (
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
  );
  const moments = (
    <div class="review-moments">
      <h3 class="review-subtitle">
        Key moments
        {momentCount > 0 && <span class="review-badge">{momentCount}</span>}
      </h3>
      {locked ? (
        <div class="review-locked" data-id="review-locked">
          <span class="review-locked-icon" aria-hidden="true">
            <IconLock size={18} />
          </span>
          <div class="review-locked-text">
            <strong>{lockedTitle(lockedMoments, analysing)}</strong>
            <span>See where the game was won and lost, with coaching on every move.</span>
          </div>
          {onUnlock && (
            <button type="button" class="btn btn-primary review-locked-btn" data-id="review-unlock" onClick={onUnlock}>
              Unlock
            </button>
          )}
        </div>
      ) : keyMoments.length === 0 ? (
        <p class="review-empty">{analysing ? 'Looking for turning points…' : 'No big swings — a clean game.'}</p>
      ) : (
        <ul class="review-list">
          {keyMoments.map((m) => {
            const tone = { '--row-tone': m.concedes ? CONCESSION_TONE : CLASS_META[m.cls].color };
            // One of your weak moves: "Try again" beside it (the row itself still shows the move).
            const tryIt = !!m.tryAgain && !!onTryAgain;
            return (
              <li key={m.index} data-try={tryIt ? '' : undefined} style={tryIt ? tone : undefined}>
                <button
                  type="button"
                  class="review-moment"
                  data-index={m.index}
                  data-concedes={m.concedes}
                  style={tone}
                  onClick={() => onSelectPly(m.index + 1)}
                >
                  {m.concedes ? <ConcessionIcon label={momentLabel(m)} size={24} /> : <ClassIcon cls={m.cls} size={24} />}
                  <span class="review-moment-main">
                    <span class="review-moment-head">
                      {m.color && (
                        <span class="review-moment-who" data-you={m.color === playerColor ? '' : undefined}>
                          {m.color === playerColor ? 'You' : names[m.color]}
                        </span>
                      )}
                      <span class="review-moment-no">{moveLabel(m)}</span>
                      <span class="review-moment-san">{m.san}</span>
                      <span class="review-moment-cls">{momentLabel(m)}</span>
                    </span>
                    <span class="review-moment-text">{m.text}</span>
                  </span>
                  {!tryIt && <IconChevronRight size={18} class="review-moment-chevron" />}
                </button>
                {tryIt && (
                  <button
                    type="button"
                    class="review-try"
                    data-id="try-again"
                    data-index={m.index}
                    aria-label={`Try again: find a better move than ${m.san}`}
                    onClick={() => onTryAgain!(m.index)}
                  >
                    <IconReset size={16} />
                    <span>Try again</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

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

      <div class="review-body" data-moments-first={tryFirst ? '' : undefined}>
        {tryFirst ? (
          <>
            {moments}
            {table}
          </>
        ) : (
          <>
            {table}
            {moments}
          </>
        )}
      </div>
    </section>
  );
}
