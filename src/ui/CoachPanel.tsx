import { useLayoutEffect, useRef } from 'preact/hooks';
import type { MoveClass } from '../analysis/types';
import { CLASS_META, ClassIcon } from './ClassIcon';
import { IconChevronRight } from './icons';
import './CoachPanel.css';

export interface CoachAction {
  id: string;
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface CoachPanelProps {
  /** Shows ClassIcon + coloured title when present. */
  cls?: MoveClass;
  /** e.g. "12. Nf3 is a mistake" / "Your move" / "Hint". */
  title: string;
  /**
   * When the title is "<move> <verdict>" (e.g. "4. Bxf7+ is a blunder"), the move part: on one
   * line that runs out of room, it is cut before the verdict is.
   */
  titleMove?: string;
  /** Explanation sentences; the first one is emphasised. */
  lines: string[];
  /** Analysing spinner (and a text skeleton while `lines` is empty). */
  busy?: boolean;
  actions?: CoachAction[];
  /** Single-line summary mode (~44px). */
  collapsed?: boolean;
  /** Shows a collapse chevron and makes the collapsed row tappable. */
  onToggleCollapsed?: () => void;
}

/** Emoji used for the coach's avatar. */
export const COACH_EMOJI = '🎓';

/**
 * The coach's speech bubble under the board. Expanded it keeps a stable minimum height (92px)
 * so the layout does not jump between messages, and scrolls internally when the text is long
 * (give it `flex: 1 1 0` inside a flex column to let it absorb spare height; the cap is
 * `--coach-max-height`, default 196px).
 */
export function CoachPanel({
  cls,
  title,
  titleMove,
  lines,
  busy = false,
  actions,
  collapsed = false,
  onToggleCollapsed,
}: CoachPanelProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const text = lines.join('\n');
  const split = !!titleMove && title.length > titleMove.length && title.startsWith(titleMove);
  const titleText = split ? (
    <>
      <span class="coach-title-move">{titleMove}</span>{' '}
      <span class="coach-title-verdict">{title.slice(titleMove.length).trimStart()}</span>
    </>
  ) : (
    title
  );
  const titleClass = split ? 'coach-title coach-title--split' : 'coach-title';

  // Fade the bottom edge while more text is hidden below (updates on scroll and resize).
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = 0;
    const update = () => {
      const more = body.scrollHeight - body.clientHeight - body.scrollTop > 2;
      body.toggleAttribute('data-more', more);
    };
    update();
    body.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(body);
    return () => {
      body.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [text, collapsed, busy]);

  const meta = cls ? CLASS_META[cls] : undefined;
  const tone = meta ? { '--coach-tone': meta.color } : undefined;
  const badge = busy ? (
    <span class="coach-spin" role="img" aria-label="Analyzing" />
  ) : cls ? (
    <ClassIcon cls={cls} size={collapsed ? 18 : 20} />
  ) : null;

  if (collapsed) {
    return (
      <section class="coach coach--collapsed" data-cls={cls} style={tone} aria-label="Coach">
        <button
          type="button"
          class="coach-row"
          aria-expanded="false"
          title="Show the coach"
          onClick={onToggleCollapsed}
          disabled={!onToggleCollapsed}
        >
          <span class="coach-avatar" aria-hidden="true">
            {COACH_EMOJI}
          </span>
          {badge}
          <span class={titleClass}>{titleText}</span>
          {lines[0] && <span class="coach-summary">{lines[0]}</span>}
          {onToggleCollapsed && <IconChevronRight size={18} class="coach-chevron coach-chevron--up" />}
        </button>
      </section>
    );
  }

  return (
    <section class="coach" data-cls={cls} style={tone} aria-label="Coach">
      <div class="coach-avatar" aria-hidden="true">
        {COACH_EMOJI}
      </div>
      <div class="coach-bubble">
        <div class="coach-head">
          {badge}
          <h2 class={titleClass}>{titleText}</h2>
          {onToggleCollapsed && (
            <button type="button" class="coach-toggle" aria-label="Collapse coach" aria-expanded="true" onClick={onToggleCollapsed}>
              <IconChevronRight size={18} class="coach-chevron" />
            </button>
          )}
        </div>
        <div class="coach-body" ref={bodyRef} aria-live="polite">
          {lines.length > 0 ? (
            lines.map((line, i) => (
              <p key={i} class={i === 0 ? 'coach-line coach-line--lead' : 'coach-line'}>
                {line}
              </p>
            ))
          ) : busy ? (
            <div class="coach-skeleton" aria-hidden="true">
              <i />
              <i />
            </div>
          ) : null}
        </div>
        {actions && actions.length > 0 && (
          <div class="coach-actions">
            {actions.map((a) => (
              <button
                key={a.id}
                type="button"
                class={a.primary ? 'btn btn-primary coach-action' : 'btn coach-action'}
                data-action={a.id}
                onClick={a.onClick}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
