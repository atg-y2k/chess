/**
 * Compact evaluation graph: White's winning chances as a white area over a dark background
 * (50% midline), coloured markers for classified moves, a current-position cursor, and
 * tap / drag / arrow-key selection of a ply.
 */
import { useRef } from 'preact/hooks';
import type { MoveClass } from '../analysis/types';
import { CLASS_META } from './ClassIcon';
import './EvalGraph.css';

export interface EvalGraphProps {
  /** points[i] = White win probability after i plies (points[0] = start position); null = unknown yet. */
  points: (number | null)[];
  /** Index into points currently shown on the board. */
  current: number;
  /** Coloured dots for mistakes/blunders/brilliants. */
  markers?: { index: number; cls: MoveClass }[];
  /** Tap/scrub to jump. */
  onSelect?: (index: number) => void;
  /** CSS px (default 56). */
  height?: number;
  /** The x axis spans at least this many plies (default: fit the points), so a short live game does not look stretched. */
  minSpan?: number;
}

/** Width of the SVG coordinate space; the SVG is stretched to the element with preserveAspectRatio="none". */
const VIEW_W = 1000;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Number of ply steps the x axis covers. */
export function graphSpan(count: number, minSpan = 0): number {
  return Math.max(count - 1, minSpan, 1);
}

/** Value at `index`, linearly interpolated across nulls; null outside the known range. */
export function valueAt(points: (number | null)[], index: number): number | null {
  const v = points[index];
  if (v != null && Number.isFinite(v)) return clamp01(v);
  let lo = index - 1;
  while (lo >= 0 && points[lo] == null) lo--;
  let hi = index + 1;
  while (hi < points.length && points[hi] == null) hi++;
  if (lo < 0 || hi >= points.length) return null;
  const a = clamp01(points[lo]!);
  const b = clamp01(points[hi]!);
  return a + ((b - a) * (index - lo)) / (hi - lo);
}

/** First and last indices with a known value, or null when nothing is known. */
export function knownRange(points: (number | null)[]): [number, number] | null {
  let first = -1;
  let last = -1;
  points.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return;
    if (first < 0) first = i;
    last = i;
  });
  return first < 0 ? null : [first, last];
}

/** SVG path (viewBox 0 0 VIEW_W 100) of the White area over the known range; interior nulls are bridged. */
export function whiteAreaPath(points: (number | null)[], span: number): string {
  const range = knownRange(points);
  if (!range) return '';
  const x = (i: number) => ((i / span) * VIEW_W).toFixed(1);
  const y = (v: number) => ((1 - clamp01(v)) * 100).toFixed(2);
  const parts = [`M${x(range[0])} 100`];
  for (let i = range[0]; i <= range[1]; i++) {
    const v = points[i];
    if (v != null && Number.isFinite(v)) parts.push(`L${x(i)} ${y(v)}`);
  }
  parts.push(`L${x(range[1])} 100Z`);
  return parts.join('');
}

export function EvalGraph({ points, current, markers, onSelect, height = 56, minSpan }: EvalGraphProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const lastSentRef = useRef(-1);
  const count = points.length;
  const span = graphSpan(count, minSpan);
  const maxIndex = Math.max(0, count - 1);
  const pct = (i: number) => (i / span) * 100;
  const range = knownRange(points);
  const cur = Math.min(Math.max(0, current), maxIndex);
  const curValue = valueAt(points, cur);

  const indexAt = (clientX: number): number => {
    const rect = rootRef.current!.getBoundingClientRect();
    const f = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return Math.min(maxIndex, Math.max(0, Math.round(f * span)));
  };

  const select = (index: number, force = false) => {
    if (!onSelect || count === 0) return;
    if (!force && index === lastSentRef.current) return;
    lastSentRef.current = index;
    if (index !== current || force) onSelect(index);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!onSelect || count === 0 || (e.pointerType === 'mouse' && e.button !== 0)) return;
    draggingRef.current = true;
    lastSentRef.current = current;
    rootRef.current!.setPointerCapture(e.pointerId);
    select(indexAt(e.clientX));
  };
  const onPointerMove = (e: PointerEvent) => {
    if (draggingRef.current) select(indexAt(e.clientX));
  };
  const endDrag = (e: PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    rootRef.current?.releasePointerCapture?.(e.pointerId);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!onSelect || count === 0) return;
    const next: Record<string, number> = {
      ArrowLeft: cur - 1,
      ArrowDown: cur - 1,
      ArrowRight: cur + 1,
      ArrowUp: cur + 1,
      Home: 0,
      End: maxIndex,
    };
    if (!(e.key in next)) return;
    e.preventDefault();
    const index = Math.min(maxIndex, Math.max(0, next[e.key]));
    if (index !== current) onSelect(index);
  };

  const interactive = !!onSelect && count > 0;
  return (
    <div
      ref={rootRef}
      class={'evalgraph' + (interactive ? ' evalgraph-interactive' : '')}
      style={{ height: `${height}px` }}
      role={interactive ? 'slider' : 'img'}
      aria-label="Evaluation graph"
      aria-valuemin={interactive ? 0 : undefined}
      aria-valuemax={interactive ? maxIndex : undefined}
      aria-valuenow={interactive ? cur : undefined}
      tabIndex={interactive ? 0 : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      <svg class="evalgraph-svg" viewBox={`0 0 ${VIEW_W} 100`} preserveAspectRatio="none" aria-hidden="true">
        {range && (
          <rect
            class="evalgraph-black"
            x={(pct(range[0]) / 100) * VIEW_W}
            y={0}
            width={((range[1] - range[0]) / span) * VIEW_W}
            height={100}
          />
        )}
        {range && <path class="evalgraph-white" d={whiteAreaPath(points, span)} />}
        <line class="evalgraph-mid" x1={0} x2={VIEW_W} y1={50} y2={50} />
      </svg>
      {count > 0 && (
        <div class="evalgraph-cursor" style={{ left: `clamp(1px, ${pct(cur)}%, calc(100% - 1px))` }}>
          {curValue != null && <span class="evalgraph-knob" style={{ top: `${(1 - curValue) * 100}%` }} />}
        </div>
      )}
      {(markers ?? [])
        .filter((m) => m.index >= 0 && m.index < count)
        .map((m) => {
          const v = valueAt(points, m.index) ?? 0.5;
          return (
            <span
              key={`${m.index}-${m.cls}`}
              class={'evalgraph-marker' + (m.index === cur ? ' evalgraph-marker-current' : '')}
              style={{ left: `${pct(m.index)}%`, top: `${(1 - v) * 100}%`, background: CLASS_META[m.cls].hex }}
              title={`${CLASS_META[m.cls].label} (ply ${m.index})`}
            />
          );
        })}
    </div>
  );
}
