import { useLayoutEffect, useRef } from 'preact/hooks';
import type { MoveClass } from '../analysis/types';
import { CLASS_META, ClassIcon } from './ClassIcon';
import { IconChevronRight, IconExplore } from './icons';
import { IconLock } from './PaywallSheet';
import './ExplorerPanel.css';

export interface ExplorerPanelAction {
  id: string;
  label: string;
  onClick: () => void;
  primary?: boolean;
  /** A toggle's state (shown pressed, `aria-pressed`). */
  pressed?: boolean;
}

export interface ExplorerPanelProps {
  /** The game's move before the starting position ("15… Nf6"); null = the start position. */
  from: string | null;
  /** The explored move on the board ("16. Nf3"), or "White to move" at the starting position. */
  title: string;
  /**
   * The Engine switch in the header (with `onEngine`): on or off, and locked (Pro: it shows a lock
   * and its tap opens the paywall). Without it, no switch.
   */
  engine?: { on: boolean; locked?: boolean };
  onEngine?: () => void;
  /** The move's verdict ("Excellent", "Checking…"). */
  verdict: string | null;
  /** Its class icon and color. */
  cls?: MoveClass;
  /** The evaluation after the move ("+0.4"). */
  evalLabel: string | null;
  /** Analyzing spinner in place of the class icon. */
  busy?: boolean;
  /** Explanation sentences (the first one emphasized). */
  lines: string[];
  /** "Best here: Bd3 (+0.6)", or how the game ended there. */
  best: string | null;
  /** News from the real game ("Pip played 15… Nf6 in your game."). */
  notice: string | null;
  /** The same, short, for the collapsed row (else `notice` is cut to one line there). */
  noticeShort?: string | null;
  /** The notice is that the bot is still thinking (a pulsing dot). */
  noticeBusy?: boolean;
  actions: ExplorerPanelAction[];
  /** One-row summary (short phones); tapping it calls `onToggleCollapsed`. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

/**
 * The explorer's panel, in the coach's place while the player tries moves: an "Exploring" header
 * (with where the line starts and the Engine switch, which the one-row form keeps beside its row),
 * the explored move on the board with its
 * verdict and eval, its explanation, the engine's best move in the position, news from the real
 * game, and buttons. With the engine off it shows only the move and what the rules say (checkmate,
 * a draw). Its blue tint matches the frame around the explorer's board, so it never passes for the
 * game.
 */
export function ExplorerPanel({
  from,
  title,
  engine,
  onEngine,
  verdict,
  cls,
  evalLabel,
  busy = false,
  lines,
  best,
  notice,
  noticeShort,
  noticeBusy = false,
  actions,
  collapsed = false,
  onToggleCollapsed,
}: ExplorerPanelProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const text = lines.join('\n');

  // Fade the bottom edge while more text is hidden below (as in the coach panel).
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = 0;
    const update = () => body.toggleAttribute('data-more', body.scrollHeight - body.clientHeight - body.scrollTop > 2);
    update();
    body.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(body);
    return () => {
      body.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [text, collapsed]);

  const tone = cls ? { '--xpanel-tone': CLASS_META[cls].color } : undefined;
  const badge = busy ? (
    <span class="xpanel-spin" role="img" aria-label="Analyzing" />
  ) : cls ? (
    <ClassIcon cls={cls} size={collapsed ? 18 : 20} />
  ) : null;
  const fromText = from ? `from ${from}` : 'from the start';
  const noticeLine = notice ? (
    <p class={collapsed ? 'xpanel-notice xpanel-notice--row' : 'xpanel-notice'} role="status">
      {noticeBusy && <span class="xpanel-notice-dot" aria-hidden="true" />}
      <span class="xpanel-notice-text">{collapsed ? (noticeShort ?? notice) : notice}</span>
    </p>
  ) : null;

  if (collapsed) {
    // One row, and under it what happened in the real game meanwhile (its moves still sound).
    const primary = actions.find((a) => a.primary);
    return (
      <section class="xpanel xpanel--collapsed" data-cls={cls} style={tone} aria-label="Explorer">
        <button
          type="button"
          class="xpanel-row"
          aria-expanded="false"
          title="Show the explorer"
          onClick={onToggleCollapsed}
          disabled={!onToggleCollapsed}
        >
          <span class="xpanel-tag xpanel-tag--icon" aria-label="Exploring">
            <IconExplore size={16} />
          </span>
          {badge}
          <span class="xpanel-title">{title}</span>
          {verdict && <span class="xpanel-verdict">{verdict}</span>}
          {evalLabel && <span class="xpanel-eval">{evalLabel}</span>}
          {engine && !engine.on && !onEngine && <span class="xpanel-off">Engine off</span>}
          {onToggleCollapsed && <IconChevronRight size={18} class="xpanel-chevron xpanel-chevron--up" />}
        </button>
        {/* The Engine switch stays one tap away (and in sight once switched) in the one-row panel too. */}
        {engine && onEngine && <EngineSwitch on={engine.on} locked={!!engine.locked} onClick={onEngine} />}
        {primary && (
          <button
            type="button"
            class="btn btn-primary xpanel-action xpanel-row-action"
            data-action={primary.id}
            onClick={primary.onClick}
          >
            {primary.label}
          </button>
        )}
        {noticeLine}
      </section>
    );
  }

  return (
    <section class="xpanel" data-cls={cls} style={tone} aria-label="Explorer">
      <div class="xpanel-head">
        <span class="xpanel-tag">
          <IconExplore size={14} />
          Exploring
        </span>
        <span class="xpanel-from">{fromText}</span>
        {engine && onEngine && <EngineSwitch on={engine.on} locked={!!engine.locked} onClick={onEngine} />}
        {onToggleCollapsed && (
          <button
            type="button"
            class="xpanel-toggle"
            aria-label="Collapse explorer"
            aria-expanded="true"
            onClick={onToggleCollapsed}
          >
            <IconChevronRight size={18} class="xpanel-chevron" />
          </button>
        )}
      </div>
      <div class="xpanel-move">
        {badge}
        <h2 class="xpanel-title">{title}</h2>
        {verdict && <span class="xpanel-verdict">{verdict}</span>}
        {evalLabel && <span class="xpanel-eval">{evalLabel}</span>}
      </div>
      <div class="xpanel-body" ref={bodyRef} aria-live="polite">
        {lines.map((line, i) => (
          <p key={i} class={i === 0 ? 'xpanel-line xpanel-line--lead' : 'xpanel-line'}>
            {line}
          </p>
        ))}
      </div>
      {best && <p class="xpanel-best">{best}</p>}
      {noticeLine}
      {actions.length > 0 && (
        <div class="xpanel-actions">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              class={a.primary ? 'btn btn-primary xpanel-action' : 'btn xpanel-action'}
              data-action={a.id}
              data-pressed={a.pressed ? '' : undefined}
              aria-pressed={a.pressed === undefined ? undefined : a.pressed}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The explorer's Engine switch: a labeled switch (`role="switch"`, a 44px target). Locked (Pro), it
 * shows a lock, stays off, and its tap opens the paywall.
 */
function EngineSwitch({ on, locked, onClick }: { on: boolean; locked: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      class="xpanel-engine"
      data-id="explorer-engine"
      data-locked={locked ? '' : undefined}
      aria-checked={on ? 'true' : 'false'}
      aria-label={locked ? 'Engine (part of Pro)' : 'Engine'}
      onClick={onClick}
    >
      <span class="xpanel-engine-label" aria-hidden="true">
        {locked && <IconLock size={13} class="xpanel-engine-lock" />}
        <span class="xpanel-engine-word">Engine</span>
      </span>
      <span class="xpanel-switch" aria-hidden="true">
        <span class="xpanel-switch-thumb" />
      </span>
    </button>
  );
}
