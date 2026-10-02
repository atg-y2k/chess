import type { ComponentChildren } from 'preact';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { IconClose } from './icons';
import './Sheet.css';

export interface SheetProps {
  open: boolean;
  /** Backdrop tap, close button, Escape or a swipe down. The parent decides by setting `open`. */
  onClose: () => void;
  /** Shown in the header; always the dialog's accessible name. */
  title: string;
  children: ComponentChildren;
  /** Pinned below the scrolling content (e.g. the primary action). It gets the bottom safe-area padding. */
  footer?: ComponentChildren;
  /** Hide the title text visually (it still names the dialog). The handle and close button stay. */
  hideTitle?: boolean;
  /** Extra class on the panel, for per-sheet styling. */
  class?: string;
}

type Phase = 'closed' | 'entering' | 'open' | 'closing';

/** The open sheets, oldest first: Escape closes only the last (e.g. the paywall over the Menu). */
const openSheets: symbol[] = [];

/** Must match the closing transition in Sheet.css (plus a little slack). */
const CLOSE_MS = 300;
/** Pull distance (px) that dismisses on release, capped by a third of the panel height. */
const DISMISS_PX = 140;
/** Downward release speed (px/ms) that dismisses even for a short pull. */
const DISMISS_VELOCITY = 0.5;

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DragState {
  startY: number;
  lastY: number;
  lastT: number;
  /** Smoothed velocity in px/ms (positive = downwards). */
  v: number;
  dy: number;
  height: number;
}

/**
 * Bottom sheet: dimmed backdrop (tap to close), slide-up panel with a drag handle (swipe down to
 * close, also by pulling down on the content when it is scrolled to the top), rounded top corners,
 * max ~90% of the viewport with internal scrolling, safe-area padding, Escape to close and a
 * simple focus trap. It is `position: fixed`, so render it outside transformed ancestors.
 *
 * Shared content helpers from Sheet.css: `.sheet-section`, `.sheet-label`, `.sheet-group`
 * (inset grouped list), `.sheet-note`.
 */
export function Sheet({ open, onClose, title, children, footer, hideTitle = false, class: cls }: SheetProps) {
  const [phase, setPhase] = useState<Phase>(open ? 'entering' : 'closed');
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState | null>(null);
  const backdropPressed = useRef(false);
  const prevFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const mounted = phase !== 'closed';

  // open -> entering -> (reflow) -> open;  !open -> closing -> (transition) -> closed
  useEffect(() => {
    if (open) setPhase((p) => (p === 'closing' ? 'open' : p === 'closed' ? 'entering' : p));
    else setPhase((p) => (p === 'closed' ? p : 'closing'));
  }, [open]);

  useLayoutEffect(() => {
    if (phase === 'entering') {
      prevFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Commit the off-screen start position so the change to "open" transitions.
      panelRef.current?.getBoundingClientRect();
      setPhase('open');
    } else if (phase === 'open') {
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    } else if (phase === 'closing') {
      const t = setTimeout(() => setPhase('closed'), CLOSE_MS);
      return () => clearTimeout(t);
    } else if (phase === 'closed' && prevFocus.current) {
      const el = prevFocus.current;
      prevFocus.current = null;
      if (el.isConnected) el.focus({ preventScroll: true });
    }
    return undefined;
  }, [phase]);

  // Escape closes the topmost open sheet (the one opened last), not the ones under it.
  useEffect(() => {
    if (!open) return;
    const token = Symbol('sheet');
    openSheets.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || openSheets[openSheets.length - 1] !== token) return;
      e.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const i = openSheets.indexOf(token);
      if (i >= 0) openSheets.splice(i, 1);
    };
  }, [open]);

  function dragStart(y: number) {
    const panel = panelRef.current;
    if (!panel) return;
    drag.current = { startY: y, lastY: y, lastT: performance.now(), v: 0, dy: 0, height: panel.offsetHeight };
    rootRef.current?.setAttribute('data-dragging', '');
  }

  function dragMove(y: number) {
    const d = drag.current;
    const panel = panelRef.current;
    if (!d || !panel) return;
    const now = performance.now();
    const raw = y - d.startY;
    // Rubber-band a little when pulled up past the resting position.
    const dy = raw < 0 ? -Math.min(24, Math.sqrt(-raw) * 2) : raw;
    const dt = now - d.lastT;
    if (dt > 0) d.v = 0.7 * ((y - d.lastY) / dt) + 0.3 * d.v;
    d.lastY = y;
    d.lastT = now;
    d.dy = dy;
    panel.style.transform = `translate3d(0, ${dy}px, 0)`;
    const backdrop = backdropRef.current;
    if (backdrop) backdrop.style.opacity = String(Math.max(0, 1 - Math.max(0, dy) / d.height));
  }

  function dragEnd() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    rootRef.current?.removeAttribute('data-dragging');
    if (panelRef.current) panelRef.current.style.transform = '';
    if (backdropRef.current) backdropRef.current.style.opacity = '';
    // Stale velocity (finger held still before release) should not fling.
    const v = performance.now() - d.lastT > 80 ? 0 : d.v;
    if (d.dy > Math.min(DISMISS_PX, d.height / 3) || (v > DISMISS_VELOCITY && d.dy > 12)) onCloseRef.current();
  }

  // Pull-down on the scrolling content (only when it is at the top) drags the whole sheet.
  // Touch events, not pointer events: the browser owns scrolling there, so we must be able to
  // preventDefault the first touchmove.
  useEffect(() => {
    const body = bodyRef.current;
    if (!mounted || !body) return;
    let mode: 'idle' | 'pending' | 'drag' | 'scroll' = 'idle';
    let sx = 0;
    let sy = 0;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        if (mode === 'drag') dragEnd();
        mode = 'idle';
        return;
      }
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      const target = e.target instanceof Element ? e.target : null;
      mode = target?.closest('input[type="range"], [data-sheet-nodrag]') ? 'scroll' : 'pending';
    };
    const onMove = (e: TouchEvent) => {
      if (mode === 'idle' || mode === 'scroll') return;
      const t = e.touches[0];
      if (mode === 'pending') {
        const dx = t.clientX - sx;
        const dy = t.clientY - sy;
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        if (dy > 0 && Math.abs(dy) > Math.abs(dx) && body.scrollTop <= 0) {
          mode = 'drag';
          dragStart(t.clientY);
        } else {
          mode = 'scroll';
          return;
        }
      }
      if (e.cancelable) e.preventDefault();
      dragMove(t.clientY);
    };
    const onEnd = () => {
      if (mode === 'drag') dragEnd();
      mode = 'idle';
    };
    body.addEventListener('touchstart', onStart, { passive: true });
    body.addEventListener('touchmove', onMove, { passive: false });
    body.addEventListener('touchend', onEnd);
    body.addEventListener('touchcancel', onEnd);
    return () => {
      body.removeEventListener('touchstart', onStart);
      body.removeEventListener('touchmove', onMove);
      body.removeEventListener('touchend', onEnd);
      body.removeEventListener('touchcancel', onEnd);
    };
  }, [mounted]);

  if (!mounted) return null;

  const onHeadPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !open) return;
    // Let buttons in the header receive their click (pointer capture would retarget it).
    if (e.target instanceof Element && e.target.closest('button, a, input')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStart(e.clientY);
  };
  const onHeadPointerMove = (e: PointerEvent) => {
    if (drag.current) dragMove(e.clientY);
  };

  const onPanelKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Hairline under the header once content scrolls beneath it (set directly: no re-render per scroll).
  const onBodyScroll = (e: Event) => {
    const scrolled = (e.currentTarget as HTMLElement).scrollTop > 2;
    const panel = panelRef.current;
    if (panel && panel.hasAttribute('data-scrolled') !== scrolled) panel.toggleAttribute('data-scrolled', scrolled);
  };

  // Only a tap that also started on the backdrop closes the sheet. A tap that opened the sheet
  // (e.g. the promotion that mates, handled on pointerdown) ends with a click on the new backdrop.
  const onBackdropClick = () => {
    const pressed = backdropPressed.current;
    backdropPressed.current = false;
    if (pressed) onCloseRef.current();
  };

  const state = phase === 'open' ? 'open' : phase === 'closing' ? 'closing' : 'closed';

  return (
    <div class="sheet" ref={rootRef} data-state={state}>
      <div
        class="sheet-backdrop"
        ref={backdropRef}
        aria-hidden="true"
        onPointerDown={() => (backdropPressed.current = true)}
        onClick={onBackdropClick}
      />
      <div
        class={cls ? `sheet-panel ${cls}` : 'sheet-panel'}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-has-foot={footer ? '' : undefined}
        onKeyDown={onPanelKeyDown}
      >
        <div
          class="sheet-head"
          data-hide-title={hideTitle ? '' : undefined}
          onPointerDown={onHeadPointerDown}
          onPointerMove={onHeadPointerMove}
          onPointerUp={dragEnd}
          onPointerCancel={dragEnd}
        >
          <div class="sheet-handle" aria-hidden="true" />
          <div class="sheet-titlebar">
            <h2 id={titleId} class={hideTitle ? 'sheet-title visually-hidden' : 'sheet-title'}>
              {title}
            </h2>
            <button type="button" class="sheet-close" aria-label="Close" onClick={() => onCloseRef.current()}>
              <span class="sheet-close-icon">
                <IconClose size={16} />
              </span>
            </button>
          </div>
        </div>
        <div class="sheet-body" ref={bodyRef} onScroll={onBodyScroll}>
          {children}
        </div>
        {footer && <div class="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}
