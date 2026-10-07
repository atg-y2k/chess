import { useLayoutEffect, useRef } from 'preact/hooks';
import type { MoveClass } from '../analysis/types';
import { CLASS_META, ClassIcon } from './ClassIcon';
import { IconChevronRight } from './icons';
import { OpeningBanner, openingBannerOf } from './OpeningBanner';
import { IconLock } from './PaywallSheet';
import './CoachPanel.css';

/**
 * A button of the panel. The action with id 'opening' is opening practice's banner instead: drawn
 * at the top of the bubble (OpeningBanner), its label being the line's name, the status and the
 * tone separated by tabs (`openingBannerOf`); `onClick` opens the line.
 */
export interface CoachAction {
  id: string;
  label: string;
  onClick: () => void;
  primary?: boolean;
  /** Part of Pro and locked: a small lock badge on the button (the click opens the paywall). */
  locked?: boolean;
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
  /**
   * Your move and the opponent's are both rated: the other one as a compact row ("You ★ 12. Nf3
   * Best") that expands it when tapped. Collapsed, the panel shows both as one row of two halves.
   */
  other?: CoachOther;
  /** With `other`: whose move this feedback is about ("You", "Pip"), for the collapsed row. */
  who?: string;
  /** With `other`: the short verdict ("Mistake"), for the collapsed row. */
  verdict?: string;
}

/** The other rated move's feedback, as one compact row of the coach panel. */
export interface CoachOther {
  /** "You" or the opponent's name. */
  who: string;
  /** "12… Nf6". */
  move: string;
  /** Short verdict: "Mistake", "Gives up material", "Checking…". */
  verdict: string;
  /** Its class icon (none for a move that gives something away, or while it is checked). */
  cls?: MoveClass;
  /** Still being checked (a small spinner instead of the icon). */
  busy?: boolean;
  /** Above the expanded feedback or below it, so the two rows keep their order ("You" first). */
  place: 'before' | 'after';
  /** Expands this move's feedback instead. */
  onSelect: () => void;
}

/** `--coach-tone` for a class colour (the bubble, a row, a half of the collapsed row). */
function toneOf(cls: MoveClass | undefined): Record<string, string> | undefined {
  return cls ? { '--coach-tone': CLASS_META[cls].color } : undefined;
}

/** The other move's feedback: a compact, tappable row inside the bubble. */
function OtherRow({ other }: { other: CoachOther }) {
  return (
    <button
      type="button"
      class="coach-other"
      data-place={other.place}
      data-cls={other.cls}
      style={toneOf(other.cls)}
      aria-expanded="false"
      aria-label={`${other.who}: ${other.move}, ${other.verdict}. Show this move`}
      onClick={other.onSelect}
    >
      <span class="coach-other-who">{other.who}</span>
      {other.busy ? (
        <span class="coach-spin coach-spin--sm" aria-hidden="true" />
      ) : other.cls ? (
        <ClassIcon cls={other.cls} size={16} />
      ) : null}
      <span class="coach-other-move">{other.move}</span>
      <span class="coach-other-verdict">{other.verdict}</span>
      <IconChevronRight size={16} class="coach-other-chevron" />
    </button>
  );
}

interface Half {
  who: string;
  verdict: string;
  cls?: MoveClass;
  busy?: boolean;
  current?: boolean;
  onClick?: () => void;
}

/** One half of the collapsed row when both moves are rated: "You ★ Best". */
function HalfButton({ half }: { half: Half }) {
  return (
    <button
      type="button"
      class="coach-half"
      data-cls={half.cls}
      data-current={half.current ? '' : undefined}
      style={toneOf(half.cls)}
      aria-label={`${half.who}: ${half.verdict}`}
      onClick={half.onClick}
      disabled={!half.onClick}
    >
      {half.busy ? (
        <span class="coach-spin coach-spin--sm" aria-hidden="true" />
      ) : half.cls ? (
        <ClassIcon cls={half.cls} size={18} />
      ) : null}
      <span class="coach-half-who">{half.who}</span>
      <span class="coach-half-verdict">{half.verdict}</span>
    </button>
  );
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
  other,
  who,
  verdict,
}: CoachPanelProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const text = lines.join('\n');
  const split = !!titleMove && title.length > titleMove.length && title.startsWith(titleMove);
  // The opponent's "Pip’s 12… Nf6": the name can give way before the move does (see CoachPanel.css).
  const owner = who && titleMove?.startsWith(`${who}’s `) ? `${who}’s` : null;
  const moveText =
    owner && titleMove ? (
      <>
        <span class="coach-title-who">{owner}</span> <span class="coach-title-san">{titleMove.slice(owner.length + 1)}</span>
      </>
    ) : (
      titleMove
    );
  const titleText = split ? (
    <>
      <span class="coach-title-move">{moveText}</span>{' '}
      <span class="coach-title-verdict">{title.slice(titleMove!.length).trimStart()}</span>
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

  const tone = toneOf(cls);
  // Opening practice: one action is the banner at the top of the bubble, not a button of the row.
  const bannerAction = actions?.find((a) => a.id === 'opening');
  const banner = bannerAction ? openingBannerOf(bannerAction.label) : null;
  const buttons = actions?.filter((a) => a.id !== 'opening');
  const badge = busy ? (
    <span class="coach-spin" role="img" aria-label="Analyzing" />
  ) : cls ? (
    <ClassIcon cls={cls} size={collapsed ? 18 : 20} />
  ) : null;

  if (collapsed && other) {
    // Both moves rated: one row of two halves in their order ("You" first); a tap opens that one.
    const mine: Half = { who: who ?? '', verdict: verdict ?? title, cls, busy, current: true, onClick: onToggleCollapsed };
    const theirs: Half = { who: other.who, verdict: other.verdict, cls: other.cls, busy: other.busy, onClick: other.onSelect };
    const halves = other.place === 'before' ? [theirs, mine] : [mine, theirs];
    return (
      <section class="coach coach--collapsed coach--dual" data-cls={cls} style={tone} aria-label="Coach">
        <div class="coach-row coach-row--dual">
          <span class="coach-avatar" aria-hidden="true">
            {COACH_EMOJI}
          </span>
          {halves.map((h, i) => (
            <HalfButton key={i} half={h} />
          ))}
          {onToggleCollapsed && <IconChevronRight size={18} class="coach-chevron coach-chevron--up" />}
        </div>
      </section>
    );
  }

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
    <section
      class={other || banner ? 'coach coach--dual' : 'coach'}
      data-cls={cls}
      data-banner={banner ? '' : undefined}
      style={tone}
      aria-label="Coach"
    >
      <div class="coach-avatar" aria-hidden="true">
        {COACH_EMOJI}
      </div>
      <div class="coach-bubble">
        {banner && <OpeningBanner {...banner} onOpen={bannerAction?.onClick} />}
        {other?.place === 'before' && <OtherRow other={other} />}
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
        {buttons && buttons.length > 0 && (
          <div class="coach-actions">
            {buttons.map((a) => (
              <button
                key={a.id}
                type="button"
                class={a.primary ? 'btn btn-primary coach-action' : 'btn coach-action'}
                data-action={a.id}
                data-locked={a.locked ? '' : undefined}
                aria-label={a.locked ? `${a.label} (Pro)` : undefined}
                onClick={a.onClick}
              >
                {a.label}
                {a.locked && (
                  <span class="coach-action-lock" aria-hidden="true">
                    <IconLock size={9} />
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {other?.place === 'after' && <OtherRow other={other} />}
      </div>
    </section>
  );
}
