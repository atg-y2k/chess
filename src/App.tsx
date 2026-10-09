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
import type { GameController, OpeningGameOptions } from './game/controller';
import { PRO_NAME } from './game/entitlements';
import type { ReadonlyStore, ToolbarId } from './game/store';
import type { GameSettings, PromotionPiece } from './game/types';
import { closeOpenings, openingsOpen, openOpenings, popPage } from './openings/session';
import type { OfflineStatus } from './pwa';
import { STARTING_LEVELS } from './rating/rating';
import { applyTheme, loadTheme, saveTheme, watchSystemTheme, type ThemePref } from './theme';
import { Board } from './ui/Board';
import { CoachPanel } from './ui/CoachPanel';
import { ConfirmSheet, assistPrompt } from './ui/ConfirmSheet';
import { EvalBar } from './ui/EvalBar';
import { EvalGraph } from './ui/EvalGraph';
import { ExplorerPanel } from './ui/ExplorerPanel';
import { GameOverSheet } from './ui/GameOverSheet';
import {
  IconBook,
  IconBulb,
  IconChart,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconCoach,
  IconCpu,
  IconExplore,
  IconFlip,
  IconMenu,
  IconPlus,
  IconReset,
  IconUndo,
} from './ui/icons';
import { MenuSheet } from './ui/MenuSheet';
import { MoveList } from './ui/MoveList';
import { NewGameSheet } from './ui/NewGameSheet';
import { LockedIcon, PaywallSheet } from './ui/PaywallSheet';
import { PlayerStrip } from './ui/PlayerStrip';
import { ReviewPanel } from './ui/ReviewPanel';
import { trapTab, useEscapeLayer } from './ui/Sheet';
import { Toolbar, type ToolbarItem } from './ui/Toolbar';
import './App.css';

export interface AppProps {
  controller: GameController;
  /**
   * Whether the app is cached for offline use (reported by the service worker, see main.tsx): the
   * Menu then says "Available offline", and a toast says it once when that happened during this visit.
   */
  offline?: ReadonlySignal<OfflineStatus | null>;
}

/**
 * Below this height (CSS px) the coach slot cannot show the expanded panel with its title, two
 * lines of text and a row of actions (Show best, Retry, …): ≈ 61 + 43 + 39 px. It then collapses
 * to one row; tapping it floats the full bubble. (One threshold, even when there are no actions,
 * so the panel does not flip between the two forms from one move to the next.)
 */
export const COACH_TIGHT_PX = 144;
/**
 * The same when the game rates both your moves and the opponent's: the other move's compact row
 * (≈ 37 px, less some spacing) must fit as well, so the text keeps about two lines (with a
 * one-line title: see `PANEL_MIN_TEXT_PX` for the rest).
 */
export const COACH_TIGHT_PAIRED_PX = 164;
/**
 * The coach with both moves rated, and the explorer, have more fixed rows than the coach alone (the
 * other move, a title over two lines in a narrow column; the explored move, "Best here", news from
 * the game): when the expanded panel leaves its text less than this (CSS px, two lines) and the
 * text does not fit, it collapses to one row as on a short phone, until the slot changes size.
 */
export const PANEL_MIN_TEXT_PX = 38;
/** Below this slot height the review summary floats over the board instead of squeezing into the slot. */
export const REVIEW_FLOAT_PX = 300;
/** How long a toast stays up (ms). */
const TOAST_MS = 2400;
/** Eval graph height (CSS px). */
const GRAPH_HEIGHT = 32;
/** How long the paywall shows its thanks after a purchase or restore before it closes (ms). */
const PAYWALL_THANKS_MS = 1600;
/** During play the graph's x axis covers at least this many plies, so a short game is not stretched. */
const GRAPH_MIN_SPAN = 40;

type Notify = (text: string) => void;

/** Root component: the game screen, its sheets, the boot splash and the engine error screen. */
export function App({ controller: c, offline }: AppProps) {
  const s = c.store;
  const phase = s.phase.value;
  const evalVisible = useComputed(() => s.evalBar.value.visible).value;
  const graphVisible = useComputed(() => s.evalGraph.value.visible).value;
  const exploring = useComputed(() => !!s.explorer.value).value;
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
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // The first download finished during this visit: say once that the app now works offline (after
  // the splash, and without replacing another message; the Menu keeps saying it).
  const offlineAnnounced = useRef(false);
  useSignalEffect(() => {
    if (offlineAnnounced.current || offline?.value !== 'installed' || s.phase.value === 'boot') return;
    offlineAnnounced.current = true;
    if (!toastRef.current) notify('Available offline');
  });

  // Pro unlocked while the paywall is closed (an Ask to Buy approval, a restore from the Menu, a
  // purchase on another device): say so once. (The open paywall thanks the player itself.)
  const proBefore = useRef(c.entitlements.pro.peek());
  useSignalEffect(() => {
    const unlocked = c.entitlements.pro.value;
    const was = proBefore.current;
    proBefore.current = unlocked;
    if (unlocked && !was && c.entitlements.enabled && !c.entitlements.paywall.peek().open && s.phase.peek() !== 'boot') {
      notify(`${PRO_NAME} is unlocked`);
    }
  });

  const exportPgn = () => void sharePgn(c, notify);

  // Desktop / keyboard: ← → step through the moves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || s.sheet.value || openingsOpen.value) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, select, [role="slider"], [contenteditable]')) return;
      if (e.key === 'ArrowLeft') c.stepBack();
      else if (e.key === 'ArrowRight') c.stepForward();
      else if (e.key === 'Escape' && s.explorer.value) c.exitExplorer();
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
        data-exploring={exploring ? '' : undefined}
        aria-hidden={phase === 'boot' || phase === 'error' ? 'true' : undefined}
      >
        <Player store={s} which="top">
          {exploring && <ExploringTag onExit={() => c.exitExplorer()} />}
        </Player>
        <BoardArea c={c} />
        <Player store={s} which="bottom">
          <BackChip c={c} />
        </Player>
        <PanelArea c={c} summary={reviewSummary} />
        {graphVisible && <GraphArea c={c} />}
        <Moves c={c} />
        <Tools c={c} summary={reviewSummary} />
      </main>
      <Sheets
        c={c}
        theme={theme}
        onTheme={changeTheme}
        onExport={exportPgn}
        notify={notify}
        offlineReady={!!offline?.value}
      />
      <Openings c={c} />
      <Paywall c={c} />
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
  return (
    !s.isLive.value &&
    (phase === 'playing' || phase === 'over') &&
    s.coachMode.value.kind !== 'showBest' &&
    !s.explorer.value
  );
}

/**
 * "Exploring ✕" on the top player strip, with the frame around the board (App.css): not the real
 * game. Tapping it goes back to the game, like the toolbar's Exit.
 */
function ExploringTag({ onExit }: { onExit: () => void }) {
  return (
    <button type="button" class="app-explore-tag" data-id="exploring" aria-label="Exploring. Back to the game" onClick={onExit}>
      <IconExplore size={15} />
      Exploring
      <IconClose size={14} class="app-explore-tag-x" />
    </button>
  );
}

/** [eval bar | board]. */
function BoardArea({ c }: { c: GameController }) {
  const s = c.store;
  const board = s.board.value;
  const onMove = (from: string, to: string, promotion?: PromotionPiece) => {
    if (s.explorer.value) c.explorerMove(from, to, promotion);
    else c.playerMove(from, to, promotion);
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
  const [size, setSize] = useState({ width: 0, height: 0 });
  const height = size.height;
  const [peek, setPeek] = useState(false);
  /** The slot (kind and size) in which the expanded panel was too short for its text. */
  const [squeezed, setSqueezed] = useState<string | null>(null);
  const explorer = s.explorerPanel.value;
  const fen = s.explorerPosition.value?.fen ?? s.displayedFen.value;
  const review = summary.value && !explorer ? s.review.value : null;
  const paired = !explorer && s.coach.value.paired;
  const kind = explorer ? 'explorer' : paired ? 'paired' : 'coach';
  const slot = `${kind} ${size.width}x${height}`;
  const tight =
    height > 0 && (height < (paired ? COACH_TIGHT_PAIRED_PX : COACH_TIGHT_PX) || (kind !== 'coach' && squeezed === slot));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setSize((o) => (o.width === width && o.height === height ? o : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Too little room for the expanded panel's text (see PANEL_MIN_TEXT_PX): one row instead, for as
  // long as the slot keeps this size (so it does not switch back and forth from move to move).
  useLayoutEffect(() => {
    if (kind === 'coach' || tight || review || height === 0) return;
    const body = ref.current?.querySelector<HTMLElement>('.coach-body, .xpanel-body');
    if (body && body.clientHeight < PANEL_MIN_TEXT_PX && body.scrollHeight > body.clientHeight + 2) setSqueezed(slot);
  });

  // A floated coach bubble closes when the position changes (a move was made or browsed).
  useEffect(() => setPeek(false), [fen, tight]);

  let content: ComponentChild;
  if (explorer) {
    content = (
      <ExplorerPanel
        {...explorer}
        collapsed={tight && !peek}
        onToggleCollapsed={tight ? () => setPeek((p) => !p) : undefined}
        actions={explorer.actions.map((a) => ({
          ...a,
          onClick: () => {
            if (a.id !== 'arrows') setPeek(false);
            c.runExplorerAction(a.id);
          },
        }))}
      />
    );
  } else if (review) {
    const select = (i: number) => {
      summary.value = false;
      c.goTo(i);
    };
    content = (
      <ReviewPanel
        {...review}
        onSelectPly={select}
        onClose={() => c.exitReview()}
        onUnlock={() => c.entitlements.openPaywall('reviewDetails')}
      />
    );
  } else {
    const coach = s.coach.value;
    const collapsed = tight ? !peek : coach.collapsed;
    // The "Back to game" chip already offers this while browsing.
    const actions = backChipShown(s) ? coach.actions.filter((a) => a.id !== 'backToGame') : coach.actions;
    // Both moves rated: the other one's row expands it (and opens a collapsed panel).
    const other = coach.other;
    const selectOther = (): void => {
      if (!other) return;
      c.selectCoachFeedback(other.subject);
      if (tight) setPeek(true);
      else if (collapsed) c.toggleCoachCollapsed();
    };
    content = (
      <CoachPanel
        cls={coach.cls}
        title={coach.title}
        titleMove={coach.titleMove}
        lines={coach.lines}
        busy={coach.busy}
        collapsed={collapsed}
        onToggleCollapsed={tight ? () => setPeek((p) => !p) : () => c.toggleCoachCollapsed()}
        other={other ? { ...other, onSelect: selectOther } : undefined}
        who={coach.who}
        verdict={coach.verdict}
        actions={actions.map((a) => ({
          id: a.id,
          label: a.label,
          primary: a.primary,
          locked: a.locked,
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
  // The game's graph stays while exploring, dimmed and not tappable (the explorer has its own line).
  const exploring = !!s.explorer.value;
  return (
    <div class="app-graph" data-dim={exploring ? '' : undefined}>
      <EvalGraph
        points={g.points}
        current={g.current}
        markers={g.markers}
        onSelect={exploring ? undefined : (i) => c.goTo(i)}
        height={GRAPH_HEIGHT}
        minSpan={playing ? GRAPH_MIN_SPAN : 0}
      />
    </div>
  );
}

/**
 * The game's moves, or the explored line while exploring. While the game's position has an
 * opening name, a chip at the end ("📖 Italian Game") opens that opening in the Openings section
 * (an opening-practice game has the coach's banner for that instead).
 */
function Moves({ c }: { c: GameController }) {
  const s = c.store;
  const select = (i: number) => (s.explorer.value ? c.explorerGoTo(i) : c.goTo(i));
  const exploring = !!s.explorer.value;
  const opening = exploring || s.openingPractice.value ? null : (s.gameSummary.value?.opening ?? null);
  return (
    <div class="app-moves" data-exploring={exploring ? '' : undefined} data-opening={opening ? '' : undefined}>
      <MoveList {...s.moveList.value} onSelect={select} />
      {opening && (
        <button
          type="button"
          class="app-opening-chip"
          data-id="opening-chip"
          aria-label={`${opening.name}: learn this opening`}
          onClick={() => openOpenings({ name: opening.name, eco: opening.eco })}
        >
          <IconBook size={15} />
          <span class="app-opening-chip-name">{openingFamilyOf(opening.name)}</span>
        </button>
      )}
    </div>
  );
}

/** "Italian Game: Giuoco Piano" -> "Italian Game" (the family, as the chip shows it). */
function openingFamilyOf(name: string): string {
  return name.split(':')[0].split(', with ')[0].trim();
}

/**
 * Toolbar per phase. Playing: New, Undo, Hint, Explore, Flip, Coach, Menu. Finished: New, Flip, ‹,
 * ›, Explore, Menu, Review. Review: Report (the summary), Flip, ‹, ›, Explore, Menu, Close.
 * Exploring: Reset, Flip, Back, Forward, Engine reply, Exit.
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
  const exploreIcon = t.explore.locked ? <LockedIcon><IconExplore /></LockedIcon> : <IconExplore />;
  const explore = item('explore', 'Explore', exploreIcon, () => c.requestExplore());
  let items: ToolbarItem[];
  if (s.explorer.value) {
    items = [
      item('explorerReset', 'Reset', <IconReset />, () => c.explorerReset()),
      flip,
      { ...prev, label: 'Back' },
      { ...next, label: 'Forward' },
      item('explorerReply', 'Reply', <IconCpu />, () => void c.explorerReply()),
      item('explorerExit', 'Exit', <IconClose />, () => c.exitExplorer()),
    ];
  } else if (phase === 'review') {
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
      explore,
      menu,
      { ...item('review', 'Close', <IconClose />, () => c.exitReview()), active: undefined },
    ];
  } else if (phase === 'over') {
    const review = item('review', 'Review', <IconChart />, () => void c.startReview());
    items = [newGame, flip, prev, next, explore, menu, review];
  } else {
    items = [
      newGame,
      item('undo', 'Undo', <IconUndo />, () => c.requestUndo()),
      item('hint', 'Hint', t.hint.locked ? <LockedIcon><IconBulb /></LockedIcon> : <IconBulb />, () => c.requestHint()),
      explore,
      flip,
      item('coach', 'Coach', <IconCoach />, () => c.toggleCoach()),
      menu,
    ];
  }
  const label = s.explorer.value ? 'Explorer controls' : phase === 'review' ? 'Review controls' : 'Game controls';
  return (
    <div class="app-tools">
      <Toolbar items={items} label={label} />
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
  offlineReady,
}: {
  c: GameController;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
  onExport: () => void;
  notify: Notify;
  offlineReady: boolean;
}) {
  const sh = c.store.sheets.value;
  const engineMode = c.store.engineMode.value;
  const pro = c.entitlements;
  const arrowsLocked = pro.locked.value.has('bestMoveArrows');
  const proStatus = pro.status.value;
  const restoreFromMenu = async () => {
    const wasUnlocked = pro.pro.peek();
    const r = await pro.restore();
    // Newly 'restored': the "is unlocked" toast says so. 'cancelled': the player closed the sign-in.
    if (r === 'restored' && wasUnlocked) notify('Purchases restored');
    else if (r === 'none') notify('No earlier purchase of Pro was found');
    else if (r === 'failed') notify('Couldn’t reach the App Store');
  };
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
        onLearnOpenings={() => openOpenings()}
        arrowsLocked={arrowsLocked ? `Part of ${PRO_NAME}` : null}
        onUnlock={() => pro.openPaywall('bestMoveArrows')}
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
        onOpenings={() => openOpenings()}
        engine={{ mode: engineMode, singleUntil }}
        onRetryDualEngines={retryDualEngines}
        offlineReady={offlineReady}
        levels={STARTING_LEVELS}
        onSetLevel={(rating) => {
          c.setStartingRating(rating);
          notify(`Your rating is now ${Math.round(c.store.profile.value.rating)}`);
        }}
        onClose={close}
        pro={
          pro.enabled
            ? {
                name: PRO_NAME,
                unlocked: pro.pro.value,
                pending: proStatus === 'pending',
                restoring: proStatus === 'restoring',
                arrowsLocked,
              }
            : undefined
        }
        onUnlock={(feature) => pro.openPaywall(feature ?? null)}
        onRestore={() => void restoreFromMenu()}
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

// -------------------------------------------------------------------------------------------------
// Openings

type OpeningsModule = typeof import('./ui/openings/OpeningsView');
let openingsModule: Promise<OpeningsModule> | null = null;

/** The Openings section's code and styles (a lazy chunk, precached for offline use; a failed load can be retried). */
function loadOpeningsModule(): Promise<OpeningsModule> {
  openingsModule ??= import('./ui/openings/OpeningsView').catch((e: unknown) => {
    openingsModule = null;
    throw e;
  });
  return openingsModule;
}

/** Must match the closing animation of `.openings-shell` in App.css (plus a little slack). */
const OPENINGS_CLOSE_MS = 300;

/**
 * The Openings section (src/ui/openings, lazy-loaded): full screen over the game and its sheets,
 * under the paywall. It never touches the game: closing it shows the screen (and sheet) it was
 * opened from, as it was. Back, Escape and the browser's or Android's Back button go back a page
 * (and close it from its first page). Playing an opening starts the game and closes it.
 */
function Openings({ c }: { c: GameController }) {
  const open = openingsOpen.value;
  const [mounted, setMounted] = useState(open);
  const [mod, setMod] = useState<OpeningsModule | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), OPENINGS_CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open || mod) return;
    let live = true;
    setFailed(false);
    loadOpeningsModule().then(
      (m) => live && setMod(m),
      (e: unknown) => {
        console.warn('[openings] could not load the section', e);
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [open, mod, attempt]);

  const back = () => void popPage();
  const isTop = useEscapeLayer(open, back);
  useBackButton(open, back);

  // Focus moves into the section (screen readers and keyboards would stay on the Menu or sheet it
  // covers) and goes back where it was when it closes.
  const shellRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!open || !mounted || !shell) return;
    const before = document.activeElement instanceof HTMLElement && !shell.contains(document.activeElement) ? document.activeElement : null;
    if (!shell.contains(document.activeElement)) shell.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      if (before?.isConnected && (!now || now === document.body || shell.contains(now))) before.focus({ preventScroll: true });
    };
  }, [open, mounted]);

  if (!mounted) return null;
  const s = c.store;
  // The phase changes when the engine starts (or restarts), and the analysis service with it.
  const phase = s.phase.value;
  // During a rated game the section shows no engine evaluation (it would be live help on the
  // game's positions, which only an unrated game may have: see the explorer's rule).
  const g = s.game.value;
  const ratedGame = phase === 'playing' && !!g && !g.assisted;
  // Read when the Play sheet opens (so a game's every move does not re-render the section).
  const setup = () => ({
    settings: s.settings.peek(),
    rating: s.profile.peek().rating,
    bots: BOTS,
    inProgress: s.sheets.peek().newGame.inProgress,
  });
  const startGame = (settings: GameSettings, opening: OpeningGameOptions) => {
    void c.newGame(settings, { opening });
    closeOpenings();
  };
  return (
    <div
      class="openings-shell"
      ref={shellRef}
      data-state={open ? 'open' : 'closing'}
      role="dialog"
      aria-modal="true"
      aria-label="Openings"
      tabIndex={-1}
      // Tab stays in the section (a sheet over it, such as the Play sheet, keeps its own).
      onKeyDown={(e) => {
        if (!(document.activeElement instanceof Element && document.activeElement.closest('.sheet'))) trapTab(e, shellRef.current, '.sheet');
      }}
      // The section's boards measured themselves while it was sliding up (see `boardsMoved`).
      onAnimationEnd={(e) => {
        if (open && e.target === e.currentTarget) window.dispatchEvent(new Event('resize'));
      }}
    >
      {mod ? (
        <mod.OpeningsView
          entitlements={c.entitlements}
          // The game's own analysis service (the controller keeps it private; the section only
          // reads positions from it, see src/ui/openings/useEval.ts); none during a rated game.
          analysis={ratedGame ? null : c['analysis']}
          evalHidden={ratedGame}
          setup={setup}
          onStartGame={startGame}
          onBack={back}
          onClose={closeOpenings}
          isTop={isTop}
        />
      ) : (
        <div class="openings-shell-loading" role={failed ? 'alert' : 'status'}>
          <button type="button" class="openings-shell-done" onClick={closeOpenings}>
            Done
          </button>
          {failed ? (
            <>
              <p>Couldn’t load the openings. Check your connection and try again.</p>
              <button type="button" class="btn btn-primary" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </button>
            </>
          ) : (
            <>
              <span class="app-spinner" aria-hidden="true" />
              <p>Loading the openings…</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * While `open`, one browser history entry belongs to the section: the browser's (or Android's)
 * Back button, or Safari's swipe, goes back a page instead of leaving the app; the entry is taken
 * again while the section stays open, and given back when it closes some other way.
 */
function useBackButton(open: boolean, onBack: () => void): void {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    if (!open || typeof history === 'undefined') return;
    const marker = `openings-${Date.now()}`;
    const state = { chesscoach: marker };
    let ours = false;
    try {
      history.pushState(state, '');
      ours = true;
    } catch {
      return; // no history (sandboxed): Back buttons in the section still work
    }
    const onPop = () => {
      // The entry given back when the section last closed (reopened before its popstate came).
      if (givenBack > 0) {
        givenBack--;
        return;
      }
      ours = false;
      ref.current();
      if (openingsOpen.peek()) {
        history.pushState(state, '');
        ours = true;
      }
    };
    addEventListener('popstate', onPop);
    return () => {
      removeEventListener('popstate', onPop);
      if (ours && (history.state as { chesscoach?: string } | null)?.chesscoach === marker) {
        givenBack++;
        history.back();
        // Its popstate normally comes at once (to no listener): forget it then.
        window.setTimeout(() => (givenBack = Math.max(0, givenBack - 1)), 500);
      }
    };
  }, [open]);
}

/** History entries the Openings section gave back whose popstate may still be on its way. */
let givenBack = 0;

/**
 * The paywall (only where Pro is sold): the price comes from the store; after a purchase or
 * restore it thanks the player and closes by itself.
 */
function Paywall({ c }: { c: GameController }) {
  const pro = c.entitlements;
  const pw = pro.paywall.value;
  const status = pro.status.value;
  useEffect(() => {
    if (!pw.open || status !== 'success') return;
    const t = window.setTimeout(() => pro.closePaywall(), PAYWALL_THANKS_MS);
    return () => window.clearTimeout(t);
  }, [pw.open, status]);
  if (!pro.enabled) return null;
  return (
    <PaywallSheet
      open={pw.open}
      feature={pw.feature}
      price={pro.product.value?.displayPrice ?? null}
      unavailable={pro.productState.value === 'unavailable'}
      status={status}
      onBuy={() => void pro.buy()}
      onRestore={() => void pro.restore()}
      onClose={() => pro.closePaywall()}
    />
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
