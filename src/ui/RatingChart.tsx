/**
 * The rating history chart in the Menu's stats card: the rating after each rated game, oldest first,
 * from the rating the games started at (rating/history.ts `ratingHistory`). One line in the accent
 * color, the peak and the current rating marked and labeled, the games played while the rating was
 * new shaded, recessive hairline gridlines.
 *
 * Tap or drag along the line to pick a game: the readout above the chart says its date, opponent,
 * result and rating change, and "View game" (or a second tap on the same point) opens it in the game
 * viewer. Keyboards and screen readers use the plot as a slider (← → Home End pick, Enter opens), and
 * a table under the chart lists every rated game with the same numbers.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatRatingDelta } from '../rating/rating';
import {
  historySummary,
  pointText,
  ratingHistory,
  ratingTicks,
  resultWord,
  shortDate,
  type RatingHistory,
} from '../rating/history';
import type { PlayerProfile } from '../rating/types';
import { IconChevronRight } from './icons';
import './RatingChart.css';

export interface RatingChartProps {
  profile: PlayerProfile;
  /** Opens a game (its record id) in the game viewer; without it the games cannot be opened. */
  onOpenGame?: (id: string) => void;
}

/** The SVG's height: the plot plus the room for the labels above it and the dates under it. */
export const CHART_HEIGHT = 148;
const PAD = { top: 22, right: 10, bottom: 20, left: 36 };
/** A touch that moves less than this (px) is a tap. */
const TAP_SLOP = 8;
/** Approximate width of a character of the 11px labels (for keeping two labels apart). */
const CHAR_W = 6.4;

interface Geometry {
  w: number;
  x: (i: number) => number;
  y: (r: number) => number;
  ticks: number[];
}

function geometry(h: RatingHistory, width: number): Geometry {
  const { ticks, lo, hi } = ratingTicks(h.min, h.max);
  const plotW = Math.max(40, width - PAD.left - PAD.right);
  const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const n = h.points.length;
  return {
    w: width,
    x: (i) => PAD.left + (n <= 1 ? plotW : (i * plotW) / (n - 1)),
    y: (r) => PAD.top + ((hi - r) / (hi - lo || 1)) * plotH,
    ticks,
  };
}

/** The line as SVG paths: the games' segments, and the jumps a level made (no game behind them). */
function linePaths(h: RatingHistory, g: Geometry): { games: string; jumps: string } {
  let games = '';
  let jumps = '';
  h.points.forEach((p, i) => {
    const at = `${g.x(i).toFixed(1)},${g.y(p.rating).toFixed(1)}`;
    if (i === 0) {
      games += `M${at}`;
      return;
    }
    if (p.kind === 'level') {
      const from = `${g.x(i - 1).toFixed(1)},${g.y(h.points[i - 1].rating).toFixed(1)}`;
      jumps += `M${from}L${at}`;
      games += `M${at}`;
    } else games += `L${at}`;
  });
  return { games, jumps };
}

export function RatingChart({ profile, onOpenGame }: RatingChartProps) {
  const h = useMemo(() => ratingHistory(profile), [profile]);
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const gesture = useRef<{ id: number; x: number; y: number; was: number | null; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setWidth((w) => (w === el.clientWidth ? w : el.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!h]);

  // A new game (or a level set) changes the line: a pick past its end goes.
  useEffect(() => {
    if (picked !== null && (!h || picked >= h.points.length)) setPicked(null);
  }, [h, picked]);

  if (!h) {
    return (
      <div class="rchart-empty" data-id="rating-chart-empty">
        <svg class="rchart-empty-art" viewBox="0 0 80 32" aria-hidden="true">
          <path d="M2 26 L18 20 L30 23 L46 12 L60 15 L78 5" />
        </svg>
        <span>Your rating chart starts after your first rated game.</span>
      </div>
    );
  }

  const g = width > 0 ? geometry(h, width) : null;
  const sel = picked !== null && picked < h.points.length ? picked : null;
  const open = (i: number | null) => {
    const r = i !== null ? h.points[i]?.record : undefined;
    if (r && onOpenGame) onOpenGame(r.id);
  };

  const nearest = (clientX: number): number => {
    const svg = hostRef.current?.querySelector('svg');
    if (!svg || !g) return 0;
    const box = svg.getBoundingClientRect();
    const x = clientX - box.left;
    const n = h.points.length;
    if (n <= 1) return 0;
    const step = (g.w - PAD.left - PAD.right) / (n - 1);
    return Math.max(0, Math.min(n - 1, Math.round((x - PAD.left) / step)));
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button > 0) return;
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, was: sel, moved: false };
    setPicked(nearest(e.clientX));
  };
  const onPointerMove = (e: PointerEvent) => {
    const t = gesture.current;
    if (!t || t.id !== e.pointerId) return;
    if (!t.moved && Math.hypot(e.clientX - t.x, e.clientY - t.y) > TAP_SLOP) {
      t.moved = true;
      // A horizontal drag scrubs along the line (the sheet keeps its vertical scroll: touch-action pan-y).
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    }
    if (t.moved) setPicked(nearest(e.clientX));
  };
  const onPointerUp = (e: PointerEvent) => {
    const t = gesture.current;
    gesture.current = null;
    if (!t || t.id !== e.pointerId || t.moved) return;
    // A second tap on the point already picked opens its game.
    const i = nearest(e.clientX);
    if (t.was === i) open(i);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const n = h.points.length;
    const at = sel ?? h.current;
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, (sel ?? n) - 1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(n - 1, (sel ?? -1) + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      open(at);
      e.preventDefault();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setPicked(next);
  };

  const shown = sel ?? h.current;
  const valueText = `${h.points[shown].rating}, ${pointText(h, shown)}`;

  return (
    <figure class="rchart" data-id="rating-chart">
      <figcaption class="visually-hidden">{historySummary(h)}</figcaption>
      <Readout h={h} index={sel} onOpen={onOpenGame ? () => open(sel) : undefined} />
      <div
        class="rchart-plot"
        ref={hostRef}
        role="slider"
        tabIndex={0}
        // A pull-down here never drags the Menu sheet closed (a drag scrubs the line).
        data-sheet-nodrag=""
        aria-label="Rating history: pick a game"
        aria-valuemin={1}
        aria-valuemax={h.points.length}
        aria-valuenow={shown + 1}
        aria-valuetext={valueText}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (gesture.current = null)}
      >
        {g ? <Plot h={h} g={g} sel={sel} /> : <div style={{ height: `${CHART_HEIGHT}px` }} />}
      </div>
      {h.provisional.length > 0 && (
        <p class="rchart-key">
          <i class="rchart-key-band" aria-hidden="true" />
          Shaded: while your rating was new (it moves fast)
        </p>
      )}
      <HistoryTable h={h} onOpen={onOpenGame} />
    </figure>
  );
}

/** The SVG: gridlines and the rating axis, the new-rating band, the line, the peak, now, the pick. */
function Plot({ h, g, sel }: { h: RatingHistory; g: Geometry; sel: number | null }) {
  const { games, jumps } = linePaths(h, g);
  const top = PAD.top;
  const bottom = CHART_HEIGHT - PAD.bottom;
  const peak = h.points[h.peak];
  const now = h.points[h.current];
  const xNow = g.x(h.current);
  const yNow = g.y(now.rating);
  const xPeak = g.x(h.peak);
  const yPeak = g.y(peak.rating);
  const samePoint = h.peak === h.current;
  // Labels: "Peak 1080" above its dot, the current rating above the line's end (right-aligned);
  // when the two would overlap, the current rating goes under its dot.
  const peakLabel = `Peak ${peak.rating}`;
  const nowLabel = String(now.rating);
  const peakW = peakLabel.length * CHAR_W;
  const nowW = nowLabel.length * CHAR_W + 4;
  const peakX = Math.min(Math.max(xPeak, PAD.left + peakW / 2), g.w - PAD.right - peakW / 2);
  const nowBelow =
    !samePoint && Math.abs(peakX - (xNow - nowW / 2)) < (peakW + nowW) / 2 + 4 && Math.abs(yPeak - yNow) < 18;
  const nowY = nowBelow ? Math.min(yNow + 18, bottom + 2) : yNow - 9;
  // The pick's crosshair gives way where it would cross a label (the peak's, the current rating's),
  // so it never runs through a number.
  const peakY = Math.max(11, yPeak - 9);
  const nowTextY = Math.max(11, nowY);
  const nowRight = Math.min(xNow + 4, g.w);
  const labels = [
    { x0: peakX - peakW / 2, x1: peakX + peakW / 2, y0: peakY - 11, y1: peakY + 3 },
    ...(samePoint ? [] : [{ x0: nowRight - nowW, x1: nowRight, y0: nowTextY - 11, y1: nowTextY + 3 }]),
  ];
  const crossPath = (x: number): string => {
    let spans: [number, number][] = [[top - 6, bottom]];
    for (const b of labels) {
      if (x < b.x0 - 2 || x > b.x1 + 2) continue;
      spans = spans.flatMap(([a, z]): [number, number][] =>
        z <= b.y0 || a >= b.y1 ? [[a, z]] : ([[a, b.y0], [b.y1, z]] as [number, number][]).filter(([p, q]) => q - p > 2),
      );
    }
    return spans.map(([a, z]) => `M${x.toFixed(1)},${a.toFixed(1)}V${z.toFixed(1)}`).join('');
  };
  const first = h.points.find((p) => p.kind === 'game')!.record!;
  const last = now.kind === 'game' ? now.record! : [...h.points].reverse().find((p) => p.kind === 'game')!.record!;
  const d0 = shortDate(first.date);
  const d1 = shortDate(last.date);
  const sameDay = d0 === d1;
  return (
    <svg class="rchart-svg" width={g.w} height={CHART_HEIGHT} viewBox={`0 0 ${g.w} ${CHART_HEIGHT}`} aria-hidden="true">
      {h.provisional.map((r) => {
        const x0 = g.x(Math.max(0, r.from - 1));
        const x1 = g.x(r.to);
        return (
          <g key={r.from} class="rchart-band">
            <rect x={x0} y={top - 6} width={Math.max(2, x1 - x0)} height={bottom - top + 6} rx={3} />
            {x1 - x0 >= 64 && (
              <text x={x0 + 5} y={top + 5} class="rchart-band-label">
                New rating
              </text>
            )}
          </g>
        );
      })}
      {g.ticks.map((t) => (
        <g key={t} class="rchart-grid">
          <line x1={PAD.left} x2={g.w - PAD.right} y1={g.y(t)} y2={g.y(t)} />
          <text x={PAD.left - 6} y={g.y(t) + 3.5} text-anchor="end">
            {t}
          </text>
        </g>
      ))}
      <text class="rchart-axis" x={PAD.left} y={CHART_HEIGHT - 4} text-anchor="start">
        {sameDay ? 'Start' : d0}
      </text>
      <text class="rchart-axis" x={g.w - PAD.right} y={CHART_HEIGHT - 4} text-anchor="end">
        {sameDay ? `Game ${h.games}` : d1}
      </text>
      {jumps && <path class="rchart-jump" d={jumps} />}
      <path class="rchart-line" d={games} />
      {sel !== null && <path class="rchart-cross" d={crossPath(g.x(sel))} />}
      <circle class="rchart-start" cx={g.x(0)} cy={g.y(h.points[0].rating)} r={3} />
      {!samePoint && <circle class="rchart-peak" cx={xPeak} cy={yPeak} r={4} data-id="rating-peak" />}
      <circle class="rchart-now" cx={xNow} cy={yNow} r={5} data-id="rating-now" />
      {sel !== null && <circle class="rchart-pick" cx={g.x(sel)} cy={g.y(h.points[sel].rating)} r={6} />}
      <text class="rchart-label rchart-label--peak" x={peakX} y={peakY} text-anchor="middle">
        {peakLabel}
      </text>
      {!samePoint && (
        <text class="rchart-label rchart-label--now" x={nowRight} y={nowTextY} text-anchor="end">
          {nowLabel}
        </text>
      )}
    </svg>
  );
}

/** The picked point in words (its rating and change, then date · opponent · result), with "View game" for a game. */
function Readout({ h, index, onOpen }: { h: RatingHistory; index: number | null; onOpen?: () => void }) {
  if (index === null) {
    return (
      <div class="rchart-readout" data-id="rating-readout">
        <span class="rchart-hint">Tap or drag along the line to see a game.</span>
      </div>
    );
  }
  const p = h.points[index];
  const r = p.record;
  const delta = r ? r.ratingAfter - r.ratingBefore : null;
  const words = r ? [shortDate(r.date), `${r.botName} (${r.botElo})`, resultWord(r)].filter(Boolean).join(' · ') : pointText(h, index);
  return (
    <div class="rchart-readout" data-id="rating-readout" data-kind={p.kind}>
      <span class="rchart-main">
        <span class="rchart-top">
          <strong class="rchart-value">{p.rating}</strong>
          {delta !== null && (
            <span class="rchart-delta" data-sign={Math.sign(delta)}>
              {formatRatingDelta(delta)}
            </span>
          )}
        </span>
        <span class="rchart-text">{words}</span>
      </span>
      {r && onOpen && (
        <button type="button" class="rchart-open" data-id="rating-open" onClick={onOpen} aria-label={`View the game: ${pointText(h, index)}`}>
          View game
          <IconChevronRight size={15} />
        </button>
      )}
    </div>
  );
}

/** Every rated game in a table (the chart's twin for assistive technology and exact numbers), newest first. */
function HistoryTable({ h, onOpen }: { h: RatingHistory; onOpen?: (id: string) => void }) {
  const rows = h.points.filter((p) => p.kind === 'game').reverse();
  return (
    <details class="rchart-table">
      <summary>Show as a table</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">Game</th>
            <th scope="col">Opponent</th>
            <th scope="col">Result</th>
            <th scope="col">Rating</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const r = p.record!;
            const delta = r.ratingAfter - r.ratingBefore;
            return (
              <tr key={r.id} data-provisional={p.provisional ? '' : undefined}>
                <td>
                  {p.game}
                  <span class="rchart-table-date">{shortDate(r.date)}</span>
                </td>
                <td>
                  {onOpen ? (
                    <button type="button" class="rchart-table-open" onClick={() => onOpen(r.id)}>
                      {r.botName} ({r.botElo})
                    </button>
                  ) : (
                    `${r.botName} (${r.botElo})`
                  )}
                </td>
                <td>{resultWord(r)}</td>
                <td>
                  {r.ratingAfter} <span class="rchart-table-delta">{formatRatingDelta(delta)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </details>
  );
}
