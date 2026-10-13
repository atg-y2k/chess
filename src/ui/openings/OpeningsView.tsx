/**
 * The Openings section (lazy-loaded with its data when it first opens): a navigation bar (Back,
 * the page's title, Done) over the page on top of the stack in src/openings/session.ts, with an
 * iOS-style push / pop transition, the Play sheet, and (in the installed app and the App Store
 * app, which have no browser back gesture) a swipe from the left edge to go back.
 *
 * Pages: Home, All openings, a family, a line (Learn), Explore by moves, a drill. See their files.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AnalysisService } from '../../engine/AnalysisService';
import type { Entitlements } from '../../game/entitlements';
import type { Color, GameSettings } from '../../game/types';
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
  rememberScroll,
  replacePage,
  setOpeningsShown,
  takeNamedTarget,
  type OpeningsPage,
} from '../../openings/session';
import { IconChevronLeft } from '../icons';
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

function NavBar({ title, onBack, backLabel, onClose }: { title: string; onBack: (() => void) | null; backLabel?: string; onClose: () => void }) {
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
      <h1 class="op-nav-title" data-id="openings-title">
        {title}
      </h1>
      <div class="op-nav-side op-nav-side--end">
        {/* In Draw mode (Learn, Tree) it leaves Draw mode first, as Escape does: the Draw bar has its own Done. */}
        <button type="button" class="op-nav-done" data-id="openings-done" onClick={() => leaveSectionDraw() || onClose()}>
          Done
        </button>
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

function Section({ entitlements, analysis, evalHidden = false, setup, onStartGame, onBack, onClose, isTop }: OpeningsViewProps) {
  const pages = openingsPages.value;
  const page = currentPage.value;
  const dir = navDirection.value;
  const locked = entitlements.locked.value;
  const scroller = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [progressVersion, setProgressVersion] = useState(0);
  const [play, setPlay] = useState<{ lineId: string; mode: 'steer' | 'skip'; color?: Color; open: boolean; setup: PlaySetup } | null>(null);

  // Reopened (from a game) before this view went away: complete its target too.
  useEffect(() => resolveTargets(), [pages]);

  // A page pushed back on top comes back at its scroll position.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = page?.scroll ?? 0;
  }, [page?.key]);

  const remember = () => {
    if (scroller.current) rememberScroll(scroller.current.scrollTop);
  };
  const ctx: PageContext = {
    go: (p) => {
      remember();
      pushPage(p);
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
      pushPage(drillPage(lineId, line.side));
    },
    play: (lineId, mode = 'steer', color) => setPlay({ lineId, mode, ...(color ? { color } : {}), open: true, setup: setup() }),
    analysis: evalHidden ? null : analysis,
    evalHidden,
    progressVersion,
    progressChanged: () => setProgressVersion((v) => v + 1),
    isTop,
  };

  // Swipe right from the left edge: back (where there is no browser gesture for it).
  useEffect(() => {
    const el = pageRef.current?.parentElement;
    if (!el || !edgeSwipe()) return;
    let start: { x: number; y: number; t: number } | null = null;
    let dx = 0;
    const content = () => pageRef.current;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      start = e.touches.length === 1 && t.clientX < 24 && openingsPages.peek().length > 1 ? { x: t.clientX, y: t.clientY, t: performance.now() } : null;
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

  return (
    <div class="op-view" data-page={page.kind}>
      <NavBar title={pageTitle(page)} onBack={prev ? onBack : null} backLabel={prev ? pageTitle(prev) : undefined} onClose={onClose} />
      <div class="op-scroll" ref={scroller}>
        <div class="op-page" key={page.key} ref={pageRef} data-dir={dir} data-kind={page.kind} onAnimationEnd={(e) => e.target === e.currentTarget && boardsMoved()}>
          {page.kind === 'home' && <HomePage ctx={ctx} page={page} />}
          {page.kind === 'families' && <FamiliesPage ctx={ctx} page={page} />}
          {page.kind === 'family' && <FamilyPage ctx={ctx} page={page} />}
          {page.kind === 'line' && <LinePage ctx={ctx} page={page} />}
          {page.kind === 'tree' && <TreePage ctx={ctx} page={page} />}
          {page.kind === 'drill' && <DrillPage ctx={ctx} page={page} />}
        </div>
      </div>
      {play && (
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
      )}
    </div>
  );
}

export default OpeningsView;
