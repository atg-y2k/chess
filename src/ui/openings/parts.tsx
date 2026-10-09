/**
 * Small pieces the Openings pages share: the page context, segmented controls, the mastery ring,
 * the locked-content teaser, an inline glossary term, the move strip of a line and glyphs.
 */
import type { ComponentChildren } from 'preact';
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AnalysisService } from '../../engine/AnalysisService';
import type { Color } from '../../game/types';
import { MASTERY_LABELS, type MasteryLevel } from '../../openings/progress';
import type { OpeningsPage } from '../../openings/session';
import { IconLock } from '../PaywallSheet';

/** What every page gets from the section. */
export interface PageContext {
  /** Opens a page over this one (Back returns here, at the same scroll position). */
  go: (page: OpeningsPage) => void;
  /** Replaces this page (e.g. the next variation's drill). */
  replace: (page: OpeningsPage) => void;
  back: () => void;
  /** Guide text may be shown (Pro, or no paywall). */
  guides: boolean;
  /** Drills and saved progress may be used (Pro, or no paywall). */
  drills: boolean;
  /** Opens the paywall for a locked feature. */
  unlock: (feature: 'openingGuides' | 'openingDrills') => void;
  /** Drills a line (the paywall instead while drills are locked). */
  drill: (lineId: string) => void;
  /**
   * The Play sheet for a study line (any id `resolveLine` knows but a trap's): 'skip' preselects
   * starting after its moves, `color` the side (default: the side that plays the opening).
   */
  play: (lineId: string, mode?: 'steer' | 'skip', color?: Color) => void;
  /** The app's analysis (null while the engine is not running, or while `evalHidden`). */
  analysis: AnalysisService | null;
  /** A rated game is in progress: no evaluation bar or engine verdicts (`EvalHiddenNote` says why). */
  evalHidden: boolean;
  /** Bumped when saved drill progress changes, so lists re-read it. */
  progressVersion: number;
  /** Saved drill progress changed (a drill completed). */
  progressChanged: () => void;
  /** The section is the topmost layer (no sheet over it): keys are for it. */
  isTop: () => boolean;
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ComponentChildren;
  /** Accessible name when the label is not plain text. */
  name?: string;
}

/** An iOS-style segmented control (a radio group). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  id,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  id?: string;
}) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div
      class="op-seg"
      role="radiogroup"
      aria-label={label}
      data-id={id}
      style={{ '--op-seg-n': options.length }}
      onKeyDown={onKeyDown}
    >
      <span class="op-seg-thumb" style={{ transform: `translateX(${index * 100}%)` }} aria-hidden="true" />
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          class="op-seg-opt"
          aria-checked={i === index ? 'true' : 'false'}
          aria-label={o.name}
          tabIndex={i === index ? 0 : -1}
          data-value={o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Mastery as a ring of three arcs (New: empty), with its label for screen readers. */
export function MasteryRing({ level, size = 30 }: { level: MasteryLevel; size?: number }) {
  const r = 11;
  const c = 2 * Math.PI * r;
  const seg = c / 3;
  return (
    <span class="op-ring" data-level={level} title={MASTERY_LABELS[level]} role="img" aria-label={`Mastery: ${MASTERY_LABELS[level]}`}>
      <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="14" cy="14" r={r} class="op-ring-track" />
        {[0, 1, 2].map((i) => (
          <circle
            key={i}
            cx="14"
            cy="14"
            r={r}
            class={i < level ? 'op-ring-arc op-ring-arc--on' : 'op-ring-arc'}
            stroke-dasharray={`${seg - 3} ${c - seg + 3}`}
            stroke-dashoffset={-i * seg}
            transform="rotate(-90 14 14)"
          />
        ))}
      </svg>
    </span>
  );
}

/** A locked Pro section: what it holds (never the answer) and Unlock. */
export function Teaser({
  title,
  text,
  onUnlock,
  id,
  compact,
}: {
  title: string;
  text?: string;
  onUnlock: () => void;
  id?: string;
  compact?: boolean;
}) {
  return (
    <div class="op-teaser" data-id={id} data-compact={compact ? '' : undefined}>
      <span class="op-teaser-icon" aria-hidden="true">
        <IconLock size={18} />
      </span>
      <span class="op-teaser-text">
        <span class="op-teaser-title">{title}</span>
        {text && <span class="op-teaser-detail">{text}</span>}
      </span>
      <button type="button" class="btn btn-primary op-teaser-btn" data-id="unlock" onClick={onUnlock}>
        Unlock
      </button>
    </div>
  );
}

/** A word with a tappable ⓘ that shows its meaning on the line below (no hover on a phone). */
export function Term({ children, explain, id }: { children: ComponentChildren; explain: string; id?: string }) {
  const [open, setOpen] = useState(false);
  const uid = useId();
  return (
    <span class="op-term" data-id={id}>
      <span class="op-term-word">{children}</span>
      <button
        type="button"
        class="op-term-btn"
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={uid}
        aria-label="What does this mean?"
        onClick={() => setOpen((o) => !o)}
      >
        <InfoGlyph />
      </button>
      {open && (
        <span class="op-term-explain" id={uid} role="note">
          {explain}
        </span>
      )}
    </span>
  );
}

/** Why the board has no evaluation bar: a rated game is in progress. */
export function EvalHiddenNote() {
  return (
    <p class="op-note op-eval-hidden" data-id="eval-hidden">
      The engine’s evaluation is hidden while your rated game is in progress.
    </p>
  );
}

/** The glossary the section uses (short, plain words). */
export const GLOSSARY = {
  eco: 'ECO codes (A00 to E99) are a standard catalog of openings that books and websites use. Similar openings have nearby codes.',
  book: 'The opening book is the list of well-known opening moves, the ones studied in opening theory.',
  common:
    'Book moves are the well-known opening moves, the ones opening theory (the analysis in books and databases) studies. The bar shows how much of that theory follows each move, not how often people play it.',
  mainLine: 'The main line is the most studied way an opening goes. The other branches are its variations.',
} as const;

/** One move of a line's strip. */
export interface StripMove {
  ply: number;
  label: string;
  san: string;
  dubious?: boolean;
}

/**
 * The moves of a line in a horizontal strip with move numbers; the current one is highlighted and
 * kept in view. A "Start" chip first goes back to the initial position.
 */
export function MoveStrip({
  moves,
  current,
  onSelect,
  label,
}: {
  moves: StripMove[];
  current: number;
  onSelect: (ply: number) => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-current="true"]');
    const box = ref.current;
    if (!el || !box) return;
    const left = el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2;
    box.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }, [current, moves.length]);
  return (
    <div class="op-strip" ref={ref} role="list" aria-label={label} data-sheet-nodrag="">
      <button
        type="button"
        class="op-strip-move op-strip-start"
        role="listitem"
        aria-current={current === 0 ? 'true' : undefined}
        onClick={() => onSelect(0)}
      >
        Start
      </button>
      {moves.map((m) => {
        const white = m.ply % 2 === 1;
        return (
          <span key={m.ply} class="op-strip-pair" role="listitem">
            {white && <span class="op-strip-no">{(m.ply + 1) / 2}.</span>}
            <button
              type="button"
              class="op-strip-move"
              data-ply={m.ply}
              data-dubious={m.dubious ? '' : undefined}
              aria-current={current === m.ply ? 'true' : undefined}
              aria-label={m.label}
              onClick={() => onSelect(m.ply)}
            >
              {m.san}
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** A theory-share bar (0..1), drawn relative to the most common move here. */
export function ShareBar({ share, max }: { share: number; max: number }) {
  const w = max > 0 ? Math.max(4, Math.round((share / max) * 100)) : 0;
  return (
    <span class="op-share" aria-hidden="true">
      <span class="op-share-fill" style={{ width: `${w}%` }} />
    </span>
  );
}

export function InfoGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 11v6M12 7.5v.01" />
    </svg>
  );
}

export function StarGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.8l2.75 5.8 6.35.75-4.7 4.35 1.25 6.3L12 16.85 6.35 20l1.25-6.3L2.9 9.35l6.35-.75z" />
    </svg>
  );
}

export function WarnGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3.5 2.5 20h19L12 3.5Z" />
      <path d="M12 10v4.5M12 17.2v.01" />
    </svg>
  );
}

export function CheckGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M5 12.5 10 17.5 19 7" />
    </svg>
  );
}

export function CrossGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/** A chevron for list rows. */
export function RowChevron() {
  return (
    <svg class="op-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
