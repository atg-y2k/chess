/**
 * The game viewer (game/viewer.ts): one of the player's earlier games, full screen over the game,
 * laid out on the game screen's own grid (App.css `.app`, with a header row: on top in portrait, at
 * the top of the side column in landscape): the header (Back, the result and opponent, the date, how
 * it ended, the rating change or "Unrated", accuracy, Export PGN), the players, the
 * evaluation bar and the board (read-only; a swipe steps through the moves; Draw mode on the strip
 * under it), the comment on the move or Game Review's report, the eval graph, the move list and the
 * toolbar (Flip, ‹, ›, Review / Report, Play from here).
 *
 * Presentational: App passes `controller.viewerView` and the controller's viewer methods.
 */
import type { ComponentChild } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { DRAW_TIP, type DrawColor, type UserShape } from '../game/drawings';
import type { ViewerActionId, ViewerView } from '../game/viewer';
import { Board } from './Board';
import { CoachPanel } from './CoachPanel';
import { DrawBar, DrawToggle } from './DrawBar';
import { EvalBar } from './EvalBar';
import { EvalGraph } from './EvalGraph';
import { IconChart, IconChevronLeft, IconChevronRight, IconFlip, IconPlay, IconShare } from './icons';
import { MoveList } from './MoveList';
import { PlayerStrip } from './PlayerStrip';
import { ReviewPanel } from './ReviewPanel';
import { Toolbar } from './Toolbar';
import './GameViewer.css';

export interface GameViewerProps {
  view: ViewerView;
  /** Closing (its slide-down animation runs; the view is the last one shown). */
  closing?: boolean;
  onBack: () => void;
  onExport: () => void;
  onFlip: () => void;
  onStep: (delta: number) => void;
  onGoTo: (plies: number) => void;
  onReview: () => void;
  onShowReport: (on: boolean) => void;
  onPlayHere: () => void;
  onAction: (id: ViewerActionId) => void;
  onTryAgain: (index: number) => void;
  onUnlock: () => void;
  onToggleDraw: () => void;
  onExitDraw: () => void;
  onDrawShape: (shape: UserShape, fen: string) => void;
  onClearDrawings: () => void;
  onDrawColor: (color: DrawColor) => void;
}

/** Below this slot height (CSS px) the comment shows as one row (tap to float it), as the coach does. */
export const VIEWER_TIGHT_PX = 104;
/** Below this slot height the report floats over the board (as Game Review's does). */
const REPORT_FLOAT_PX = 300;
/** A horizontal swipe longer than this (px) on the board steps one move. */
const SWIPE_PX = 36;

export function GameViewer(p: GameViewerProps) {
  const v = p.view;
  const words = v.title.split(' ');
  const resultWord = words[0];
  const rest = words.slice(1).join(' ');
  return (
    <div class="app viewer-app" data-evalbar="" data-graph="" data-drawing={v.draw.on ? '' : undefined}>
      <header class="viewer-head">
        <button type="button" class="viewer-back" data-id="viewer-back" aria-label="Back" onClick={p.onBack}>
          <IconChevronLeft size={26} />
          <span class="viewer-back-label">Back</span>
        </button>
        <div class="viewer-title">
          <h1 class="viewer-title-main">
            <span class="viewer-result" data-k={v.result}>
              {resultWord}
            </span>{' '}
            <span class="viewer-opponent">{rest}</span>
          </h1>
          <p class="viewer-facts">
            {v.facts.map((f, i) => (
              <span key={i} class="viewer-fact">
                {f}
              </span>
            ))}
          </p>
        </div>
        <span class="viewer-rating" data-id="viewer-rating" data-rated={v.rating.rated ? '' : undefined}>
          {v.rating.rated ? (
            <>
              <span class="viewer-delta" data-sign={v.rating.sign}>
                {v.rating.delta}
              </span>
              <span class="viewer-after">{v.rating.after}</span>
            </>
          ) : (
            <span class="viewer-unrated">Unrated</span>
          )}
        </span>
        <button type="button" class="viewer-share" data-id="viewer-export" aria-label="Export PGN" disabled={v.missing} onClick={p.onExport}>
          <IconShare size={22} />
        </button>
      </header>
        <div class="app-player app-player--top">
          <PlayerStrip {...v.top} />
        </div>
        <BoardArea {...p} />
        <div class="app-player app-player--bottom">
          <PlayerStrip {...v.bottom} />
          {!v.missing && <DrawControls {...p} />}
        </div>
        <Panel {...p} />
        <div class="app-graph">
          <EvalGraph points={v.graph.points} current={v.graph.current} markers={v.graph.markers} onSelect={p.onGoTo} height={32} />
        </div>
        <div class="app-moves">
          <MoveList {...v.moveList} onSelect={p.onGoTo} />
        </div>
        <div class="app-tools">
          <Toolbar
            label="Game viewer controls"
            items={[
              { id: 'viewerFlip', label: 'Flip', icon: <IconFlip />, onClick: p.onFlip, disabled: v.missing },
              { id: 'viewerPrev', label: 'Prev', icon: <IconChevronLeft />, onClick: () => p.onStep(-1), disabled: !v.toolbar.prev },
              { id: 'viewerNext', label: 'Next', icon: <IconChevronRight />, onClick: () => p.onStep(1), disabled: !v.toolbar.next },
              {
                id: 'viewerReview',
                label: v.toolbar.review.label,
                icon: <IconChart />,
                onClick: p.onReview,
                disabled: v.toolbar.review.disabled,
                ...(v.toolbar.review.label === 'Report' ? { active: v.toolbar.review.active } : {}),
              },
              { id: 'viewerPlay', label: 'Play here', icon: <IconPlay />, onClick: p.onPlayHere, disabled: !v.toolbar.playHere },
            ]}
          />
        </div>
    </div>
  );
}

/** [eval bar | board]: read-only; a horizontal swipe steps a move back or forward (not in Draw mode). */
function BoardArea(p: GameViewerProps) {
  const v = p.view;
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  const onDown = (e: PointerEvent) => {
    start.current = v.draw.on || e.button > 0 ? null : { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) p.onStep(dx < 0 ? 1 : -1);
  };
  return (
    <div class="app-board">
      <EvalBar {...v.evalBar} />
      <div
        class="app-board-cell viewer-board"
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={() => (start.current = null)}
      >
        <Board {...v.board} onMove={() => undefined} onDraw={(shape, fen) => p.onDrawShape(shape, fen)} />
      </div>
    </div>
  );
}

/** Draw mode's toggle on the strip under the board, or its bar over the strip. */
function DrawControls(p: GameViewerProps) {
  const d = p.view.draw;
  if (!d.on) {
    return (
      <div class="app-draw">
        <DrawToggle onClick={p.onToggleDraw} />
      </div>
    );
  }
  return (
    <div class="app-drawbar">
      <DrawBar
        color={d.color}
        colors={d.colors}
        canClear={d.canClear}
        tip={d.tip ? DRAW_TIP : null}
        onColor={p.onDrawColor}
        onClear={p.onClearDrawings}
        onDone={p.onExitDraw}
      />
    </div>
  );
}

/**
 * The comment on the move (CoachPanel; one row on a short slot, tapping it floats the whole bubble
 * until the move changes) or Game Review's report (ReviewPanel; floating over the board when the slot
 * is short).
 */
function Panel(p: GameViewerProps) {
  const v = p.view;
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [peek, setPeek] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight((h) => (h === el.clientHeight ? h : el.clientHeight));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setPeek(false), [v.cursor, v.report]);
  const tight = height > 0 && height < VIEWER_TIGHT_PX;
  let content: ComponentChild;
  if (v.report) {
    content = (
      <ReviewPanel
        {...v.report}
        onSelectPly={(n) => p.onGoTo(n)}
        onClose={() => p.onShowReport(false)}
        onUnlock={p.onUnlock}
        onTryAgain={p.onTryAgain}
      />
    );
  } else {
    const c = v.coach;
    content = (
      <CoachPanel
        cls={c.cls}
        title={c.title}
        titleMove={c.titleMove}
        lines={c.lines}
        busy={c.busy}
        collapsed={tight && !peek}
        onToggleCollapsed={tight ? () => setPeek((x) => !x) : undefined}
        actions={c.actions.map((a) => ({
          id: a.id,
          label: a.label,
          primary: a.primary,
          locked: a.locked,
          onClick: () => {
            setPeek(false);
            p.onAction(a.id);
          },
        }))}
      />
    );
  }
  return (
    <div
      class="app-panel"
      ref={ref}
      data-tight={tight ? '' : undefined}
      data-peek={tight && peek && !v.report ? '' : undefined}
      data-review={v.report ? '' : undefined}
      data-float={v.report && height < REPORT_FLOAT_PX ? '' : undefined}
    >
      {content}
    </div>
  );
}
