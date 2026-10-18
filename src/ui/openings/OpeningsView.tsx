/**
 * The Openings section (lazy-loaded with its data when it first opens): a navigation bar (Back,
 * the page's title, Done) over the page on top of the stack in src/openings/session.ts, with an
 * iOS-style push / pop transition, the Play sheet, and (in the installed app and the App Store
 * app, which have no browser back gesture) a swipe from the left edge to go back.
 *
 * Pages: Home, All openings, a family, a line (Learn), Explore by moves, a drill. See their files.
 *
 * On a screen split along a foldable's fold (the iPhone Duo's inner display, src/layout/fold.ts),
 * the text pages show two at a time, one per segment: the list (Home, All openings) and the page it
 * opened beside it, each in a pane with its own bar and scroll; a choice in the list replaces the
 * page beside it. The board pages keep one page, with the board in the first segment (Openings.css).
 */
import type { JSX, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AnalysisService } from '../../engine/AnalysisService';
import type { Entitlements } from '../../game/entitlements';
import type { Color, GameSettings } from '../../game/types';
import type { FoldLayoutKind } from '../../layout/fold';
import { isNative } from '../../native/platform';
import { findLine, getFamily, search } from '../../openings/catalog';
import {
  currentPage,
  drillPage,
  insertFamilyBelow,
  lineOpenedAlone,
  navDirection,
  openingsPages,
  openingsLoadFailedText,
  openOpenings,
  pushPage,
  pushPageOver,
  rememberScroll,
  replacePage,
  type NavDirection,
  setOpeningsShown,
  takeNamedTarget,
  type OpeningsPage,
} from '../../openings/session';
import { IconBook, IconChevronLeft } from '../icons';
import { DrillPage } from './DrillPage';
import { FamiliesPage, FamilyPage } from './FamilyPage';
import { HomePage } from './HomePage';
import { LinePage } from './LinePage';
import { leaveSectionDraw } from './OpeningBoard';
import { loadOpeningsData, resolveLine, studySteps, type OpeningStart } from './model';
import type { PageContext } from './parts';
import { PlaySheet, type PlaySetup } from './PlaySheet';
import { TreePage } from './TreePage';
import './Openings.css';

export interface OpeningsViewProps {
  entitlements: Pick<Entitlements, 'locked' | 'requirePro'>;
  /** The app's analysis service (null while the engine is not running, or while `evalHidden`). */
  analysis: AnalysisService | null;
  /** A rated game is in progress: no engine evaluation in the section (the pages say why). */
  evalHidden?: boolean;
  /** For the Play sheet (read when it opens): the current settings, rating, bots, and a game in progress. */
  setup: () => PlaySetup;
  /** Starts the game (the section closes). */
  onStartGame: (settings: GameSettings, opening: OpeningStart) => void;
  /** Back from the top page (closes the section from Home). */
  onBack: () => void;
  /** Done: closes the section. */
  onClose: () => void;
  /** The section is the topmost layer (for keys). */
  isTop: () => boolean;
  /**
   * How the screen is split along a foldable's fold (src/layout/fold.ts): 'book' (side by side) or
   * 'tabletop' (top and bottom) shows the text pages two at a time, one per segment. Default 'none'.
   */
  split?: FoldLayoutKind;
}

/** The page's title in the navigation bar. */
export function pageTitle(p: OpeningsPage): string {
  switch (p.kind) {
    case 'home':
      return 'Openings';
    case 'families':
      return 'All openings';
    case 'family':
      return p.family;
    case 'tree':
      return 'Explore by moves';
    case 'drill':
      return 'Drill';
    case 'line': {
      const l = resolveLine(p.lineId);
      if (!l) return 'Line';
      // Opened at a position (a branch, "Learn this line"): the opening there, as the player picked
      // it ("Two Knights Defense"), not the deep variation the line goes on to.
      const at = p.entryPly ? studySteps(l)[p.entryPly]?.name : null;
      if (at) return at.variation ? at.variation.split(',')[0].trim() : at.family;
      return l.variation || l.family;
    }
  }
}

type Load = 'loading' | 'ready' | 'failed';

export function OpeningsView(props: OpeningsViewProps) {
  const [load, setLoad] = useState<Load>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoad('loading');
    loadOpeningsData()
      // The first page renders in a task of its own: with the data's set-up it would be one long stall.
      .then(() => new Promise<void>((resolve) => window.setTimeout(resolve, 0)))
      .then(
        () => {
          if (!live) return;
          resolveTargets();
          setLoad('ready');
          // Build the search index while the user looks around, not on the first key press.
          const warm = () => void search('e4', 1);
          if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(warm, { timeout: 2000 });
          else window.setTimeout(warm, 500);
        },
        (e: unknown) => {
          console.warn('[openings] could not load the data', e);
          if (live) setLoad('failed');
        },
      );
    return () => {
      live = false;
    };
  }, [attempt]);

  // Pages with state of their own show only once the data is in (see `openingsShown`).
  useEffect(() => {
    setOpeningsShown(load === 'ready');
    return () => setOpeningsShown(false);
  }, [load]);

  if (load !== 'ready') {
    return (
      <div class="op-view">
        <NavBar title="Openings" onBack={null} onClose={props.onClose} />
        <OpeningsLoading failed={load === 'failed'} onRetry={() => setAttempt((a) => a + 1)} />
      </div>
    );
  }
  return <Section {...props} />;
}

/**
 * Loads the section's lazy data chunks into the page's module map without setting anything up (the
 * catalog and guides are built when the section opens): once they are in, an app update that
 * removes the old build's files can no longer break the section in a page that keeps running the
 * old build (a game in progress is never reloaded). Called at idle after the app starts.
 */
export function prefetchOpeningsData(): Promise<void> {
  return Promise.all([import('../../data/opening-lines.json'), import('../../data/opening-guides')]).then(() => undefined);
}

/**
 * Completes a target that needed the data: an opening asked for by name (a game's position) opens
 * its line with its family under it, and a line opened alone gets its family's page under it.
 */
function resolveTargets(): void {
  const asked = takeNamedTarget();
  if (asked) {
    const found = findLine(asked.name, asked.eco) ?? findLine(asked.name);
    const family = asked.name.split(':')[0];
    // At the named position, the game's (the line's end), with the board from the player's side.
    const side = found ? resolveLine(found.id)?.side : undefined;
    if (found) {
      openOpenings({
        lineId: found.id,
        family: found.family,
        ply: found.san.length,
        ...(asked.color && side && asked.color !== side ? { flipped: true } : {}),
      });
    }
    else if (getFamily(family)) openOpenings({ family });
  }
  if (!lineOpenedAlone()) return;
  const top = openingsPages.peek().at(-1);
  const line = top?.kind === 'line' ? resolveLine(top.lineId) : null;
  if (line) insertFamilyBelow(line.family);
}

/** The spinner (or the error with Try again) while the section's data loads. */
export function OpeningsLoading({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return failed ? (
    <div class="op-loading" role="alert">
      <p>{openingsLoadFailedText()}</p>
      <button type="button" class="btn btn-primary" onClick={onRetry}>
        Try again
      </button>
    </div>
  ) : (
    <div class="op-loading" role="status" aria-label="Loading the openings">
      <span class="op-spinner" aria-hidden="true" />
      <p>Loading the openings…</p>
    </div>
  );
}

/**
 * The bar over a page: Back (with the previous page's title), the title, Done. On a split screen each
 * pane has one (the list's: Back and its title; the page beside it: its title and Done, or Done on
 * the list's bar when the panes are stacked); `main` marks the title of the page on top.
 */
function NavBar({
  title,
  main = true,
  onBack,
  backLabel,
  onClose,
}: {
  title: string | null;
  main?: boolean;
  onBack: (() => void) | null;
  backLabel?: string;
  onClose: (() => void) | null;
}) {
  return (
    <header class="op-nav">
      <div class="op-nav-side">
        {onBack && (
          <button type="button" class="op-nav-back" data-id="openings-back" aria-label={`Back${backLabel ? ` to ${backLabel}` : ''}`} onClick={onBack}>
            <IconChevronLeft size={24} />
            <span class="op-nav-back-text">{backLabel ?? 'Back'}</span>
          </button>
        )}
      </div>
      {title === null ? (
        <div class="op-nav-title" />
      ) : main ? (
        <h1 class="op-nav-title" data-id="openings-title">
          {title}
        </h1>
      ) : (
        <h2 class="op-nav-title">{title}</h2>
      )}
      <div class="op-nav-side op-nav-side--end">
        {/* In Draw mode (Learn, Tree) it leaves Draw mode first, as Escape does: the Draw bar has its own Done. */}
        {onClose && (
          <button type="button" class="op-nav-done" data-id="openings-done" onClick={() => leaveSectionDraw() || onClose()}>
            Done
          </button>
        )}
      </div>
    </header>
  );
}

/**
 * Tells the boards that they have moved: chessground measures its board once and only measures
 * again on a scroll or a resize, so after a slide (a page transition, the section sliding up, a
 * back swipe) a tap would land on the square that used to be there.
 */
export function boardsMoved(): void {
  window.dispatchEvent(new Event('resize'));
}

/** The installed web app and the App Store app have no browser back gesture: the section adds one. */
const edgeSwipe = (): boolean => isNative || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** The text pages: on a split screen the list and the page it opened show side by side. */
const isTextPage = (p: OpeningsPage): boolean => p.kind === 'home' || p.kind === 'families' || p.kind === 'family';

/**
 * The panes of a split screen, as indexes into the page stack: the list (the page under the top one
 * when both are text pages, else the top one itself) and the page beside it (null: nothing chosen
 * yet). Null when one page shows: no split, or a board page on top.
 */
export function panesFor(pages: readonly OpeningsPage[], split: FoldLayoutKind): { list: number; detail: number | null } | null {
  const top = pages.length - 1;
  if (split === 'none' || top < 0 || !isTextPage(pages[top])) return null;
  return top > 0 && isTextPage(pages[top - 1]) ? { list: top - 1, detail: top } : { list: top, detail: null };
}

/**
 * Each page's scroll offset as last seen, by its key: a page that moves to the other pane of a split
 * screen, or shows again after a fold or an unfold, keeps its place.
 */
const scrolls = new Map<number, number>();
const scrollOf = (p: OpeningsPage): number => scrolls.get(p.key ?? -1) ?? p.scroll ?? 0;

function Section({ entitlements, analysis, evalHidden = false, setup, onStartGame, onBack, onClose, isTop, split = 'none' }: OpeningsViewProps) {
  const pages = openingsPages.value;
  const page = currentPage.value;
  const dir = navDirection.value;
  const locked = entitlements.locked.value;
  const view = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [progressVersion, setProgressVersion] = useState(0);
  const [play, setPlay] = useState<{ lineId: string; mode: 'steer' | 'skip'; color?: Color; open: boolean; setup: PlaySetup } | null>(null);

  // On a split screen, the text pages two at a time: the list (the page under the top one, or the
  // top one itself with nothing opened from it yet) and the page beside it.
  const panes = panesFor(pages, split);
  const two = !!panes;
  const listAt = panes?.list ?? -1;
  const list = panes ? pages[panes.list] : null;
  const detail = panes ? (panes.detail === null ? null : pages[panes.detail]) : page;
  const twoRef = useRef(two);
  twoRef.current = two;

  // The control in use keeps the focus when the tree around it is re-created (a page change gives
  // the bar new buttons; a fold or an unfold moves a page in or out of a pane): the one with the
  // same data-id in the new tree takes it. (The page on top keeps its own elements through a fold:
  // see the single-page Pane below, so a search being typed keeps its field and its keyboard.)
  const focusId = useRef<string | null>(null);
  const active = document.activeElement;
  focusId.current = active instanceof HTMLElement && view.current?.contains(active) ? (active.dataset.id ?? null) : null;
  useLayoutEffect(() => {
    const id = focusId.current;
    const el = view.current;
    if (!id || !el || el.contains(document.activeElement)) return;
    el.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  });

  // Reopened (from a game) before this view went away: complete its target too.
  useEffect(() => resolveTargets(), [pages]);

  // Forget the offsets of pages that have left the stack.
  useEffect(() => {
    const keys = new Set(pages.map((p) => p.key));
    for (const k of scrolls.keys()) if (!keys.has(k)) scrolls.delete(k);
  }, [pages]);

  // A page pushed back on top comes back at its scroll position (also after a fold or an unfold).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && page) el.scrollTop = scrollOf(page);
  }, [page?.key, two]);

  const remember = () => {
    if (scroller.current) rememberScroll(scroller.current.scrollTop);
  };
  /** The context of a page whose choices open pages over it with `open`. */
  const context = (open: (p: OpeningsPage) => void): PageContext => ({
    go: (p) => {
      remember();
      open(p);
    },
    replace: (p) => replacePage(p),
    back: onBack,
    guides: !locked.has('openingGuides'),
    drills: !locked.has('openingDrills'),
    unlock: (f) => void entitlements.requirePro(f),
    drill: (lineId) => {
      if (!entitlements.requirePro('openingDrills')) return;
      const line = resolveLine(lineId);
      if (!line) return;
      remember();
      open(drillPage(lineId, line.side));
    },
    play: (lineId, mode = 'steer', color) => setPlay({ lineId, mode, ...(color ? { color } : {}), open: true, setup: setup() }),
    analysis: evalHidden ? null : analysis,
    evalHidden,
    progressVersion,
    progressChanged: () => setProgressVersion((v) => v + 1),
    isTop,
  });
  const ctx = context(pushPage);
  // The list's choices replace the page beside it (Back still leads back to the list).
  const listKey = list?.key ?? -1;
  const listCtx = list && list !== page ? context((p) => pushPageOver(listKey, p)) : ctx;

  // Swipe right from the left edge: back (where there is no browser gesture for it). Not on a split
  // screen's list, whose own pane is what the edge is.
  useEffect(() => {
    const el = view.current;
    if (!el || !edgeSwipe()) return;
    let start: { x: number; y: number; t: number } | null = null;
    let dx = 0;
    const content = () => (twoRef.current ? null : (scroller.current?.firstElementChild as HTMLElement | null));
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      start =
        e.touches.length === 1 && t.clientX < 24 && openingsPages.peek().length > 1 && !twoRef.current && !!scroller.current?.contains(e.target as Node)
          ? { x: t.clientX, y: t.clientY, t: performance.now() }
          : null;
      dx = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      dx = t.clientX - start.x;
      if (Math.abs(t.clientY - start.y) > Math.max(30, dx)) {
        start = null;
        const c = content();
        if (c) c.style.transform = '';
        return;
      }
      if (e.cancelable) e.preventDefault();
      const c = content();
      if (c) c.style.transform = `translate3d(${Math.max(0, dx)}px, 0, 0)`;
    };
    const onEnd = () => {
      if (!start) return;
      const fast = dx / Math.max(1, performance.now() - start.t) > 0.5;
      start = null;
      const c = content();
      if (c) c.style.transform = '';
      if (dx > 90 || (fast && dx > 30)) onBack();
      else if (dx > 0) boardsMoved();
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  if (!page) return null;
  const prev = pages.length > 1 ? pages[pages.length - 2] : null;
  const playLine = play ? resolveLine(play.lineId) : null;
  const sheet = play && (
    <PlaySheet
      open={play.open}
      line={playLine?.playable ? playLine : null}
      mode={play.mode}
      {...(play.color ? { color: play.color } : {})}
      setup={play.setup}
      onStart={(settings, opening) => {
        setPlay((p) => (p ? { ...p, open: false } : p));
        onStartGame(settings, opening);
      }}
      onClose={() => setPlay((p) => (p ? { ...p, open: false } : p))}
      onBackToGame={() => {
        setPlay((p) => (p ? { ...p, open: false } : p));
        onClose();
      }}
    />
  );

  if (list) {
    // Done on the bar at the top: the second pane's (side by side), or the list's (stacked).
    const doneOnList = split === 'tabletop';
    const back = listAt > 0 ? pages[listAt - 1] : null;
    return (
      <div class="op-view" ref={view} data-page={page.kind} data-panes={split}>
        <Pane
          key={list.key}
          slot="list"
          page={list}
          ctx={listCtx}
          dir={dir}
          nav={
            <NavBar
              title={pageTitle(list)}
              main={!detail}
              onBack={back ? onBack : null}
              {...(back ? { backLabel: pageTitle(back) } : {})}
              onClose={doneOnList ? onClose : null}
            />
          }
        />
        {detail ? (
          <Pane
            key={detail.key}
            slot="detail"
            page={detail}
            ctx={ctx}
            dir={dir}
            nav={<NavBar title={pageTitle(detail)} onBack={null} onClose={doneOnList ? null : onClose} />}
          />
        ) : (
          <section class="op-pane op-pane--empty" aria-label="Nothing chosen yet">
            {/* Side by side, the bars meet as one across the fold (Done at its end); stacked, none. */}
            {!doneOnList && <NavBar title={null} onBack={null} onClose={onClose} />}
            <div class="op-pane-empty" data-id="openings-empty">
              <IconBook size={30} />
              <p class="op-pane-empty-title">Choose an opening</p>
              <p class="op-note">Pick one from the list to see its moves and its variations here.</p>
            </div>
          </section>
        )}
        {sheet}
      </div>
    );
  }

  // One page: in the same keyed Pane as the list of a split screen, so a fold or an unfold keeps the
  // page on top (and the field being typed in) instead of re-creating it.
  return (
    <div class="op-view" ref={view} data-page={page.kind}>
      <Pane
        key={page.key}
        slot="list"
        single
        page={page}
        ctx={ctx}
        dir={dir}
        scrollRef={scroller}
        nav={<NavBar title={pageTitle(page)} onBack={prev ? onBack : null} backLabel={prev ? pageTitle(prev) : undefined} onClose={onClose} />}
      />
      {sheet}
    </div>
  );
}

/**
 * A page with its bar and its own scroll: on a split screen, one of the two panes, kept as the page
 * moves from one to the other (the list's page becomes the list when it opens another text page);
 * else (`single`) the whole view, the same element, so a fold or an unfold doesn't re-create it.
 */
function Pane({
  page,
  ctx,
  dir,
  nav,
  slot,
  single = false,
  scrollRef,
}: {
  page: OpeningsPage;
  ctx: PageContext;
  dir: NavDirection;
  nav: JSX.Element;
  slot: 'list' | 'detail';
  single?: boolean;
  /** The single page's scroller, for the view's own scroll restore and edge swipe. */
  scrollRef?: RefObject<HTMLDivElement>;
}) {
  const own = useRef<HTMLDivElement>(null);
  const ref = scrollRef ?? own;
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = scrollOf(page);
  }, [slot, single]);
  return (
    <section class="op-pane" data-slot={single ? undefined : slot} aria-label={single ? undefined : pageTitle(page)}>
      {nav}
      <div class="op-scroll" ref={ref} onScroll={(e) => scrolls.set(page.key ?? -1, e.currentTarget.scrollTop)}>
        <PageBody page={page} ctx={ctx} dir={dir} />
      </div>
    </section>
  );
}

/** One page, sliding in the way the navigation went (when it first shows). */
function PageBody({ page, ctx, dir }: { page: OpeningsPage; ctx: PageContext; dir: NavDirection }) {
  const [enter] = useState(dir);
  return (
    <div class="op-page" data-dir={enter} data-kind={page.kind} onAnimationEnd={(e) => e.target === e.currentTarget && boardsMoved()}>
      {page.kind === 'home' && <HomePage ctx={ctx} page={page} />}
      {page.kind === 'families' && <FamiliesPage ctx={ctx} page={page} />}
      {page.kind === 'family' && <FamilyPage ctx={ctx} page={page} />}
      {page.kind === 'line' && <LinePage ctx={ctx} page={page} />}
      {page.kind === 'tree' && <TreePage ctx={ctx} page={page} />}
      {page.kind === 'drill' && <DrillPage ctx={ctx} page={page} />}
    </div>
  );
}

export default OpeningsView;
