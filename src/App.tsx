/**
 * The game screen: lays out the presentational components from src/ui and wires them to the
 * GameController (its store holds ready-made view models, see src/game/store.ts).
 *
 * Portrait (phones): opponent strip, [eval bar | board], your strip, coach (or review) panel,
 * eval graph, move list, toolbar. Landscape and desktop: the board on the left, everything else in
 * a column on the right. The board is as large as the space allows; the coach panel absorbs (or,
 * on short phones, gives up) the remaining height, so nothing scrolls and nothing jumps.
 *
 * Each area is its own component reading only the signals it needs, so a live-analysis update
 * re-renders the eval bar and graph, not the board.
 */
import { useComputed, useSignal, useSignalEffect, type ReadonlySignal, type Signal } from '@preact/signals';
import type { ComponentChild } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BOTS } from './bot/personas';
import { copyText } from './clipboard';
import { rememberedEngineMode, resetEngineMode } from './engine/createEngines';
import type { GameController } from './game/controller';
import type { ReadonlyStore, ToolbarId } from './game/store';
import type { PromotionPiece } from './game/types';
import { STARTING_LEVELS } from './rating/rating';
import { applyTheme, loadTheme, saveTheme, watchSystemTheme, type ThemePref } from './theme';
import { Board } from './ui/Board';
import { CoachPanel } from './ui/CoachPanel';
import { ConfirmSheet, assistPrompt } from './ui/ConfirmSheet';
import { EvalBar } from './ui/EvalBar';
import { EvalGraph } from './ui/EvalGraph';
import { GameOverSheet } from './ui/GameOverSheet';
import {
  IconBulb,
  IconChart,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconCoach,
  IconFlip,
  IconMenu,
  IconPlus,
  IconUndo,
} from './ui/icons';
import { MenuSheet } from './ui/MenuSheet';
import { MoveList } from './ui/MoveList';
import { NewGameSheet } from './ui/NewGameSheet';
import { PlayerStrip } from './ui/PlayerStrip';
import { ReviewPanel } from './ui/ReviewPanel';
import { Toolbar, type ToolbarItem } from './ui/Toolbar';
import './App.css';

export interface AppProps {
  controller: GameController;
}

/**
 * Below this height (CSS px) the coach slot cannot show the expanded panel with its title, two
 * lines of text and a row of actions (Show best, Retry, …): ≈ 61 + 43 + 39 px. It then collapses
 * to one row; tapping it floats the full bubble. (One threshold, even when there are no actions,
 * so the panel does not flip between the two forms from one move to the next.)
 */
export const COACH_TIGHT_PX = 144;
/** Below this slot height the review summary floats over the board instead of squeezing into the slot. */
export const REVIEW_FLOAT_PX = 300;
/** How long a toast stays up (ms). */
const TOAST_MS = 2400;
/** Eval graph height (CSS px). */
const GRAPH_HEIGHT = 32;
/** During play the graph's x axis covers at least this many plies, so a short game is not stretched. */
const GRAPH_MIN_SPAN = 40;

type Notify = (text: string) => void;

/** Root component: the game screen, its sheets, the boot splash and the engine error screen. */
export function App({ controller: c }: AppProps) {
  const s = c.store;
  const phase = s.phase.value;
  const evalVisible = useComputed(() => s.evalBar.value.visible).value;
  const graphVisible = useComputed(() => s.evalGraph.value.visible).value;
  const [theme, setTheme] = useState<ThemePref>(loadTheme);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  /** In review: the summary (accuracy, key moments) rather than the coach on the current move. */
  const reviewSummary = useSignal(true);
  const seen = useRef<{ phase: string; current: number }>({ phase: '', current: -1 });

  useEffect(() => watchSystemTheme(() => themeRef.current), []);

  // A review opens on the summary; stepping to another move shows the coach for that move.
  useSignalEffect(() => {
    const ph = s.phase.value;
    const cur = s.current.value;
    const last = seen.current;
    if (ph === 'review') {
      if (last.phase !== 'review') reviewSummary.value = true;
      else if (cur !== last.current) reviewSummary.value = false;
    }
    seen.current = { phase: ph, current: cur };
  });

  const changeTheme = (t: ThemePref) => {
    setTheme(t);
    saveTheme(t);
    applyTheme(t);
  };

  const notify: Notify = (text) => setToast({ id: Date.now(), text });
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

  const exportPgn = () => void sharePgn(c, notify);

  // Desktop / keyboard: ← → step through the moves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || s.sheet.value) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, select, [role="slider"], [contenteditable]')) return;
      if (e.key === 'ArrowLeft') c.stepBack();
      else if (e.key === 'ArrowRight') c.stepForward();
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [c]);

  return (
    <>
      <main
        class="app"
        data-phase={phase}
        data-evalbar={evalVisible ? '' : undefined}
        data-graph={graphVisible ? '' : undefined}
        aria-hidden={phase === 'boot' || phase === 'error' ? 'true' : undefined}
      >
        <Player store={s} which="top" />
        <BoardArea c={c} />
        <Player store={s} which="bottom">
          <BackChip c={c} />
        </Player>
        <PanelArea c={c} summary={reviewSummary} />
        {graphVisible && <GraphArea c={c} />}
        <Moves c={c} />
        <Tools c={c} summary={reviewSummary} />
      </main>
      <Sheets c={c} theme={theme} onTheme={changeTheme} onExport={exportPgn} notify={notify} />
      <Splash phase={phase} download={s.engineDownload} />
      {phase === 'error' && <ErrorScreen c={c} />}
      <div class="app-toast-host" role="status" aria-live="polite">
        {toast && (
          <div class="app-toast" key={toast.id}>
            {toast.text}
          </div>
        )}
      </div>
    </>
  );
}

// -------------------------------------------------------------------------------------------------
// Areas

function Player({ store, which, children }: { store: ReadonlyStore; which: 'top' | 'bottom'; children?: ComponentChild }) {
  const p = which === 'top' ? store.topPlayer.value : store.bottomPlayer.value;
  return (
    <div class={`app-player app-player--${which}`}>
      <PlayerStrip {...p} />
      {children}
    </div>
  );
}

/**
 * "Back to game" while browsing earlier moves (it sits on the bottom player strip, clear of the
 * board). Not shown while the coach previews the best move: its panel has its own "Back" button.
 */
function BackChip({ c }: { c: GameController }) {
  const s = c.store;
  const phase = s.phase.value;
  if (!backChipShown(s)) return null;
  return (
    <button type="button" class="app-chip" data-id="back-to-game" onClick={() => c.backToLive()}>
      {phase === 'playing' ? 'Back to game' : 'Final position'}
      <IconChevronRight size={16} />
    </button>
  );
}

/** Browsing earlier moves of a game in progress (or finished, outside the review). */
function backChipShown(s: ReadonlyStore): boolean {
  const phase = s.phase.value;
  return !s.isLive.value && (phase === 'playing' || phase === 'over') && s.coachMode.value.kind !== 'showBest';
}

/** [eval bar | board]. */
function BoardArea({ c }: { c: GameController }) {
  const s = c.store;
  const board = s.board.value;
  const onMove = (from: string, to: string, promotion?: PromotionPiece) => {
    c.playerMove(from, to, promotion);
  };
  return (
    <div class="app-board">
      <EvalBarSlot store={s} />
      <div class="app-board-cell">
        <Board {...board} onMove={onMove} />
      </div>
    </div>
  );
}

function EvalBarSlot({ store }: { store: ReadonlyStore }) {
  const ev = store.evalBar.value;
  if (!ev.visible) return null;
  return <EvalBar whiteWinProb={ev.whiteWinProb} label={ev.label} orientation={ev.orientation} thinking={ev.thinking} />;
}

/**
 * The coach panel (or the review summary). When the slot is too short for the expanded coach
 * (small phones), the coach shows as a one-line row; tapping it floats the full bubble over the
 * board until the next move. The review summary floats over the board unless the slot is roomy
 * (desktop); stepping to a move puts it away.
 */
function PanelArea({ c, summary }: { c: GameController; summary: Signal<boolean> }) {
  const s = c.store;
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [peek, setPeek] = useState(false);
  const fen = s.displayedFen.value;
  const review = summary.value ? s.review.value : null;
  const tight = height > 0 && height < COACH_TIGHT_PX;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A floated coach bubble closes when the position changes (a move was made or browsed).
  useEffect(() => setPeek(false), [fen, tight]);

  let content: ComponentChild;
  if (review) {
    const select = (i: number) => {
      summary.value = false;
      c.goTo(i);
    };
    content = <ReviewPanel {...review} onSelectPly={select} onClose={() => c.exitReview()} />;
  } else {
    const coach = s.coach.value;
    const collapsed = tight ? !peek : coach.collapsed;
    // The "Back to game" chip already offers this while browsing.
    const actions = backChipShown(s) ? coach.actions.filter((a) => a.id !== 'backToGame') : coach.actions;
    content = (
      <CoachPanel
        cls={coach.cls}
        title={coach.title}
        lines={coach.lines}
        busy={coach.busy}
        collapsed={collapsed}
        onToggleCollapsed={tight ? () => setPeek((p) => !p) : () => c.toggleCoachCollapsed()}
        actions={actions.map((a) => ({
          id: a.id,
          label: a.label,
          primary: a.primary,
          onClick: () => {
            setPeek(false);
            c.runAction(a.id);
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
      data-peek={tight && peek && !review ? '' : undefined}
      data-review={review ? '' : undefined}
      data-float={review && height < REVIEW_FLOAT_PX ? '' : undefined}
    >
      {content}
    </div>
  );
}

function GraphArea({ c }: { c: GameController }) {
  const s = c.store;
  const g = s.evalGraph.value;
  const playing = s.phase.value === 'playing';
  return (
    <div class="app-graph">
      <EvalGraph
        points={g.points}
        current={g.current}
        markers={g.markers}
        onSelect={(i) => c.goTo(i)}
        height={GRAPH_HEIGHT}
        minSpan={playing ? GRAPH_MIN_SPAN : 0}
      />
    </div>
  );
}

function Moves({ c }: { c: GameController }) {
  return (
    <div class="app-moves">
      <MoveList {...c.store.moveList.value} onSelect={(i) => c.goTo(i)} />
    </div>
  );
}

/**
 * Toolbar per phase. Playing: New, Undo, Hint, Flip, Coach, Menu. Finished: New, Flip, ‹, ›, Menu,
 * Review. Review: Report (the summary), Flip, ‹, ›, Menu, Close.
 */
function Tools({ c, summary }: { c: GameController; summary: Signal<boolean> }) {
  const s = c.store;
  const t = s.toolbar.value;
  const phase = s.phase.value;
  const item = (id: ToolbarId, label: string, icon: ComponentChild, onClick: () => void): ToolbarItem => ({
    id,
    label,
    icon,
    onClick,
    disabled: t[id].disabled,
    active: t[id].active,
  });
  const newGame = item('newGame', 'New', <IconPlus />, () => c.openSheet('new'));
  const flip = item('flip', 'Flip', <IconFlip />, () => c.flip());
  const menu = item('menu', 'Menu', <IconMenu />, () => c.openSheet('menu'));
  const prev = item('prev', 'Prev', <IconChevronLeft />, () => c.stepBack());
  const next = item('next', 'Next', <IconChevronRight />, () => c.stepForward());
  let items: ToolbarItem[];
  if (phase === 'review') {
    const shown = summary.value;
    items = [
      {
        id: 'summary',
        label: 'Report',
        icon: <IconChart />,
        onClick: () => (summary.value = !shown),
        active: shown,
      },
      flip,
      prev,
      next,
      menu,
      { ...item('review', 'Close', <IconClose />, () => c.exitReview()), active: undefined },
    ];
  } else if (phase === 'over') {
    items = [newGame, flip, prev, next, menu, item('review', 'Review', <IconChart />, () => void c.startReview())];
  } else {
    items = [
      newGame,
      item('undo', 'Undo', <IconUndo />, () => c.requestUndo()),
      item('hint', 'Hint', <IconBulb />, () => c.requestHint()),
      flip,
      item('coach', 'Coach', <IconCoach />, () => c.toggleCoach()),
      menu,
    ];
  }
  return (
    <div class="app-tools">
      <Toolbar items={items} label={phase === 'review' ? 'Review controls' : 'Game controls'} />
    </div>
  );
}

/** The bottom sheets (rendered at the app root: they are position: fixed). */
function Sheets({
  c,
  theme,
  onTheme,
  onExport,
  notify,
}: {
  c: GameController;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
  onExport: () => void;
  notify: Notify;
}) {
  const sh = c.store.sheets.value;
  const engineMode = c.store.engineMode.value;
  // When remembered single mode ends and two engines are tried again (localStorage; re-read when the menu opens).
  const menuOpen = sh.open === 'menu';
  const singleUntil = useMemo(
    () => (engineMode === 'single' ? (rememberedEngineMode()?.until ?? null) : null),
    [menuOpen, engineMode],
  );
  // Keep the last result so the game-over sheet can animate closed after a rematch clears it.
  const lastOver = useRef<typeof sh.gameOver>(null);
  if (sh.gameOver) lastOver.current = sh.gameOver;
  const over = lastOver.current;
  // Same for the unrated-help question while it animates closed.
  const lastAssist = useRef<typeof sh.assist>(null);
  if (sh.assist) lastAssist.current = sh.assist;
  const assist = lastAssist.current;
  const close = () => c.closeSheet();
  return (
    <>
      <NewGameSheet
        open={sh.open === 'new'}
        initial={sh.newGame.initial}
        playerRating={sh.newGame.playerRating}
        bots={sh.newGame.bots}
        inProgress={sh.newGame.inProgress}
        newPlayer={sh.newGame.newPlayer}
        levels={STARTING_LEVELS}
        onSetLevel={(rating) => c.setStartingRating(rating)}
        onStart={(settings) => c.newGame(settings)}
        onClose={close}
      />
      {assist && (
        <ConfirmSheet
          {...assistPrompt(assist.kind)}
          open={sh.open === 'assist' && !!sh.assist}
          onConfirm={() => c.confirmAssist()}
          onClose={close}
        />
      )}
      <MenuSheet
        open={sh.open === 'menu'}
        settings={sh.menu.settings}
        profile={sh.menu.profile}
        canResign={sh.menu.canResign}
        bots={BOTS}
        theme={theme}
        onThemeChange={onTheme}
        onChange={(partial) => c.setSettings(partial)}
        onResign={() => c.resign()}
        onExportPgn={() => {
          close();
          onExport();
        }}
        onFlip={() => {
          c.flip();
          close();
        }}
        onNewGame={() => c.openSheet('new')}
        engine={{ mode: engineMode, singleUntil }}
        onRetryDualEngines={retryDualEngines}
        levels={STARTING_LEVELS}
        onSetLevel={(rating) => {
          c.setStartingRating(rating);
          notify(`Your rating is now ${Math.round(c.store.profile.value.rating)}`);
        }}
        onClose={close}
      />
      {over && (
        <GameOverSheet
          {...over}
          open={sh.open === 'gameOver' && !!sh.gameOver}
          onReview={() => void c.startReview()}
          onRematch={() => c.rematch()}
          onNewGame={() => c.openSheet('new')}
          onClose={close}
        />
      )}
    </>
  );
}

/**
 * The Menu's "Try two engines again": forgets the remembered compatibility (single-engine) mode
 * and reloads (the game is saved). A `?engines=1` in the address is dropped too, or it would
 * force one engine again.
 */
function retryDualEngines(): void {
  resetEngineMode();
  const url = new URL(location.href);
  if (url.searchParams.has('engines')) {
    url.searchParams.delete('engines');
    location.replace(url.href);
  } else {
    location.reload();
  }
}

// -------------------------------------------------------------------------------------------------
// Boot splash, engine error

/**
 * A download shorter than this (ms from the splash appearing) is not worth a progress readout:
 * a cached engine "downloads" in a few frames, and the text would only flicker.
 */
const SPLASH_PROGRESS_DELAY_MS = 300;

/**
 * Full-screen splash while the engines start; fades out once they are ready. While the engine's
 * `.wasm` is still downloading (first visit, slow connection) it shows the percentage and a bar.
 */
function Splash({ phase, download }: { phase: string; download: ReadonlySignal<number | null> }) {
  const booting = phase === 'boot';
  const [shown, setShown] = useState(booting);
  const [patient, setPatient] = useState(false);
  useEffect(() => {
    if (booting) {
      setShown(true);
      const t = window.setTimeout(() => setPatient(true), SPLASH_PROGRESS_DELAY_MS);
      return () => window.clearTimeout(t);
    }
    setPatient(false);
    const t = window.setTimeout(() => setShown(false), 420);
    return () => window.clearTimeout(t);
  }, [booting]);
  if (!shown) return null;
  const p = download.value;
  const downloading = booting && patient && p !== null && p < 1;
  const pct = downloading ? Math.floor(p * 100) : 0;
  return (
    <div class="app-splash" data-leaving={booting ? undefined : ''} role="status" aria-label="Starting the chess engine">
      <img class="app-splash-logo" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={88} height={88} />
      <div class="app-splash-name">Chess Coach</div>
      <div class="app-splash-status">
        <span class="app-spinner" aria-hidden="true" />
        {downloading ? <span class="app-splash-pct">Downloading engine {pct}%…</span> : 'Starting the engine…'}
      </div>
      <div
        class="app-splash-bar"
        data-shown={downloading ? '' : undefined}
        role={downloading ? 'progressbar' : undefined}
        aria-label={downloading ? 'Engine download' : undefined}
        aria-valuemin={downloading ? 0 : undefined}
        aria-valuemax={downloading ? 100 : undefined}
        aria-valuenow={downloading ? pct : undefined}
        aria-hidden={downloading ? undefined : 'true'}
      >
        <span style={{ transform: `scaleX(${downloading ? p : 0})` }} />
      </div>
    </div>
  );
}

function ErrorScreen({ c }: { c: GameController }) {
  const e = c.store.error.value;
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void c.retry().finally(() => setRetrying(false));
  };
  return (
    <div class="app-error" role="alertdialog" aria-labelledby="app-error-title" aria-describedby="app-error-text">
      <div class="app-error-card">
        <div class="app-error-icon" aria-hidden="true">
          ♞
        </div>
        <h1 id="app-error-title" class="app-error-title">
          {e?.message ?? 'The chess engine could not start.'}
        </h1>
        <p id="app-error-text" class="app-error-text">
          {e?.advice ?? 'Please try again.'}
        </p>
        {e?.detail && (
          <details class="app-error-detail">
            <summary>Details</summary>
            <code>{e.detail}</code>
          </details>
        )}
        <button type="button" class="btn btn-primary app-error-retry" onClick={retry} disabled={retrying}>
          {retrying ? 'Starting…' : 'Try again'}
        </button>
        <a class="app-error-link" href="?enginetest">
          Run the engine self-test
        </a>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------
// PGN export

/** Shares the PGN (iOS share sheet) when the browser can, else copies it; reports via a toast. */
async function sharePgn(c: GameController, notify: Notify): Promise<void> {
  const pgn = c.exportPgn();
  if (!pgn) {
    notify('No game to export yet');
    return;
  }
  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title: 'Chess Coach game', text: pgn });
      return;
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') return; // the user closed the share sheet
    }
  }
  notify((await copyText(pgn)) ? 'PGN copied to the clipboard' : 'Could not copy the PGN');
}
