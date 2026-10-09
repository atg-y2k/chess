/**
 * The Openings section's start page: search (openings by name first, then lines), a short "New to
 * openings?" card (once; a link brings it back), "Start here" (the starter openings for White or
 * Black, easiest first), "Explore by moves", "All openings", and, with drills (Pro), the lines due
 * for practice and recent results. The search text and "Show all" live in the page's entry, so
 * Back from a result returns to the results.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Color } from '../../game/types';
import { families, search, type OpeningFamily, type SearchResult } from '../../openings/catalog';
import { allProgress, isDue, MASTERY_LABELS, type LineProgress, type MasteryLevel } from '../../openings/progress';
import { drillPage, linePage, updatePage, type HomePage as HomePageState } from '../../openings/session';
import { IconBook, IconExplore } from '../icons';
import { EcoNote } from './FamilyPage';
import {
  colorName,
  difficultyLabel,
  dismissIntro,
  familyFacts,
  familyHits,
  firstSentence,
  introDismissed,
  movesSummary,
  movesText,
  resolveLine,
  saveSide,
  savedSide,
  starterFamilies,
} from './model';
import { MasteryRing, RowChevron, Segmented, type PageContext } from './parts';

/** Search results shown at most. */
export const SEARCH_LIMIT = 40;
/** Starter cards shown before "Show all". */
export const STARTERS_SHOWN = 6;
/** Plies of a result's moves shown. */
const RESULT_PLIES = 10;

export function HomePage({ ctx, page }: { ctx: PageContext; page: HomePageState }) {
  // Back from a result comes back to the same search, its results already there (for the scroll).
  const [query, setQueryState] = useState(page.query ?? '');
  const [debounced, setDebounced] = useState(page.query ?? '');
  const setQuery = (q: string) => {
    setQueryState(q);
    updatePage('home', (p) => ((p.query ?? '') === q ? p : { ...p, query: q }));
  };
  useEffect(() => {
    if (!query.trim()) {
      setDebounced('');
      return;
    }
    const t = window.setTimeout(() => setDebounced(query), 60);
    return () => window.clearTimeout(t);
  }, [query]);
  const results = useMemo(() => (debounced.trim() ? search(debounced, SEARCH_LIMIT) : []), [debounced]);
  const searching = !!query.trim();

  return (
    <div class="op-home">
      <div class="op-search" role="search">
        <svg class="op-search-icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m20 20-4.8-4.8" />
        </svg>
        <input
          class="op-search-input"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellcheck={false}
          placeholder="Name, ECO code (C50) or moves"
          aria-label="Search openings by name, ECO code or moves"
          data-id="openings-search"
          value={query}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
        />
        {query && (
          <button type="button" class="op-search-clear" aria-label="Clear the search" onClick={() => setQuery('')}>
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="10" fill="currentColor" />
              <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="var(--surface)" stroke-width="2.2" stroke-linecap="round" />
            </svg>
          </button>
        )}
      </div>
      {searching ? <SearchResults ctx={ctx} query={debounced} results={results} /> : <HomeSections ctx={ctx} page={page} />}
    </div>
  );
}

function SearchResults({ ctx, query, results }: { ctx: PageContext; query: string; results: SearchResult[] }) {
  if (!query.trim()) return <div class="op-results" aria-busy="true" />;
  if (!results.length) {
    return (
      <p class="op-empty" data-id="search-empty" role="status">
        No openings match “{query.trim()}”. Try a name like <strong>Sicilian</strong>, a code like <strong>C50</strong> or
        moves like <strong>1. e4 c5</strong>.
      </p>
    );
  }
  const named = familyHits(results);
  return (
    <section class="op-section" aria-label="Search results">
      {named.length > 0 && (
        <ul class="op-group op-results" data-id="search-openings">
          {named.map((f) => (
            <li key={f.name}>
              <FamilyHit ctx={ctx} family={f} />
            </li>
          ))}
        </ul>
      )}
      <ul class="op-group op-results" data-id="search-results">
        {results.map(({ line }) => (
          <li key={line.id}>
            <button type="button" class="op-row" data-line={line.id} onClick={() => ctx.go(linePage(line.id))}>
              <span class="op-row-text">
                <span class="op-row-title">
                  {line.family}
                  {line.variation && <span class="op-row-variation">{line.variation}</span>}
                </span>
                <span class="op-row-moves">{movesSummary(line.san, RESULT_PLIES)}</span>
              </span>
              <span class="op-eco" aria-label={`ECO code ${line.eco}`}>
                {line.eco}
              </span>
              <RowChevron />
            </button>
          </li>
        ))}
      </ul>
      {results.length >= SEARCH_LIMIT && <p class="op-note">Showing the first {SEARCH_LIMIT} matches. Type more to narrow it down.</p>}
      <EcoNote />
    </section>
  );
}

/** An opening a search names: its page (the guide, Learn the main line, Drill, Play). */
function FamilyHit({ ctx, family: f }: { ctx: PageContext; family: OpeningFamily }) {
  const facts = familyFacts(f);
  return (
    <button type="button" class="op-row op-row--opening" data-family={f.name} onClick={() => ctx.go({ kind: 'family', family: f.name })}>
      <span class="op-row-icon" style={{ background: 'var(--cls-book)' }} aria-hidden="true">
        <IconBook size={18} />
      </span>
      <span class="op-row-text">
        <span class="op-row-title">
          {f.name}
          <span class="op-badge-main">Opening</span>
        </span>
        <span class="op-row-moves">{movesText(facts.mainSan, 4)}</span>
        <span class="op-row-sub">
          For {colorName(f.side)} · {f.lineCount} {f.lineCount === 1 ? 'line' : 'lines'}
        </span>
      </span>
      <RowChevron />
    </button>
  );
}

function HomeSections({ ctx, page }: { ctx: PageContext; page: HomePageState }) {
  const [intro, setIntro] = useState(() => !introDismissed());
  const [side, setSide] = useState<Color>(savedSide);
  const pickSide = (c: Color) => {
    setSide(c);
    saveSide(c);
  };
  const allStarters = !!page.allStarters;
  const starters = useMemo(() => starterFamilies(side), [side]);
  const shownStarters = allStarters ? starters : starters.slice(0, STARTERS_SHOWN);
  const progress = useMemo(() => (ctx.drills ? allProgress() : {}), [ctx.drills, ctx.progressVersion]);
  const byFamily = useMemo(() => familyMastery(progress), [progress]);

  return (
    <>
      {intro && (
        <section class="op-intro" data-id="openings-intro" aria-labelledby="op-intro-title">
          <h2 class="op-intro-title" id="op-intro-title">
            New to openings?
          </h2>
          <p>
            An <strong>opening</strong> is the first moves of a game. Good openings bring your pieces out quickly, fight for the
            center and keep your king safe.
          </p>
          <ul class="op-intro-list">
            <li>
              <strong>Main line:</strong> the most studied way an opening goes. A <strong>variation</strong> is another branch of
              it.
            </li>
            <li>
              <strong>Book move:</strong> a well-known opening move, from the “book” of opening theory (moves masters have studied).
            </li>
            <li>
              <strong>How to start:</strong> pick an opening under Start here, tap <em>Learn the main line</em> and step through the
              moves. Then play it against the computer.
            </li>
          </ul>
          <button
            type="button"
            class="btn op-intro-btn"
            data-id="intro-dismiss"
            onClick={() => {
              dismissIntro();
              setIntro(false);
            }}
          >
            Got it
          </button>
        </section>
      )}

      {ctx.drills && <Practice ctx={ctx} progress={progress} />}

      <section class="op-section" aria-labelledby="op-start-label">
        <h2 class="op-label" id="op-start-label">
          Start here
        </h2>
        <Segmented
          id="start-side"
          label="Openings for"
          value={side}
          onChange={pickSide}
          options={[
            { value: 'w', label: 'I play White' },
            { value: 'b', label: 'I play Black' },
          ]}
        />
        <p class="op-note op-start-note">
          {side === 'w'
            ? 'Openings you choose with the white pieces, the easiest first.'
            : 'Answers to White’s first move, the easiest first.'}
        </p>
        <ul class="op-cards" data-id="starter-cards">
          {shownStarters.map((f) => {
            const facts = familyFacts(f);
            const g = facts.guide;
            const fp = byFamily.get(f.name);
            return (
              <li key={f.name}>
                <button
                  type="button"
                  class="op-card"
                  data-family={f.name}
                  onClick={() => ctx.go({ kind: 'family', family: f.name })}
                >
                  <span class="op-card-head">
                    <span class="op-card-name">{f.name}</span>
                    {ctx.guides && g && (
                      <span class="op-pill" data-level={g.level}>
                        {difficultyLabel(g.level)}
                      </span>
                    )}
                    {ctx.drills && fp && <MasteryRing level={fp.best} size={26} />}
                  </span>
                  <span class="op-card-moves">{movesText(facts.mainSan, 6)}</span>
                  {ctx.drills && fp && (
                    <span class="op-card-progress" data-id="card-progress">
                      {MASTERY_LABELS[fp.best]} · {fp.practiced} {fp.practiced === 1 ? 'line' : 'lines'} practiced
                    </span>
                  )}
                  {ctx.guides && g && <span class="op-card-pitch">{firstSentence(g.summary)}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {starters.length > STARTERS_SHOWN && (
          <button
            type="button"
            class="op-more"
            data-id="starters-all"
            aria-expanded={allStarters ? 'true' : 'false'}
            onClick={() => updatePage('home', (p) => ({ ...p, allStarters: !p.allStarters }))}
          >
            {allStarters ? 'Show fewer' : `Show all ${starters.length} openings for ${side === 'w' ? 'White' : 'Black'}`}
          </button>
        )}
      </section>

      <section class="op-section">
        <ul class="op-group">
          <li>
            <button type="button" class="op-row" data-id="explore-moves" onClick={() => ctx.go({ kind: 'tree', path: [] })}>
              <span class="op-row-icon" style={{ background: 'var(--cls-great)' }} aria-hidden="true">
                <IconExplore size={18} />
              </span>
              <span class="op-row-text">
                <span class="op-row-title">Explore by moves</span>
                <span class="op-row-sub">Play moves and see which openings they lead to</span>
              </span>
              <RowChevron />
            </button>
          </li>
          <li>
            <button type="button" class="op-row" data-id="all-openings" onClick={() => ctx.go({ kind: 'families' })}>
              <span class="op-row-icon" style={{ background: 'var(--cls-book)' }} aria-hidden="true">
                <IconBook size={18} />
              </span>
              <span class="op-row-text">
                <span class="op-row-title">All openings</span>
                <span class="op-row-sub">{families().length} openings, most important first</span>
              </span>
              <RowChevron />
            </button>
          </li>
        </ul>
      </section>

      {!intro && (
        <button type="button" class="op-link-btn op-words" data-id="intro-again" onClick={() => setIntro(true)}>
          What do “opening”, “main line” and “book move” mean?
        </button>
      )}
    </>
  );
}

/** Lines due for practice and the latest results (drills, Pro). */
function Practice({ ctx, progress }: { ctx: PageContext; progress: Record<string, LineProgress> }) {
  const entries = Object.values(progress)
    .map((p) => ({ p, line: resolveLine(p.lineId) }))
    .filter((e): e is { p: LineProgress; line: NonNullable<ReturnType<typeof resolveLine>> } => !!e.line);
  if (!entries.length) return null;
  const now = new Date();
  const due = entries.filter((e) => isDue(e.p, now)).slice(0, 5);
  const recent = entries
    .slice()
    .sort((a, b) => ((b.p.lastPracticed ?? '') < (a.p.lastPracticed ?? '') ? -1 : 1))
    .slice(0, 3);
  const row = (e: (typeof entries)[number], what: 'due' | 'recent') => (
    <li key={`${what}-${e.line.id}`}>
      <button
        type="button"
        class="op-row"
        data-line={e.line.id}
        onClick={() => ctx.go(what === 'due' ? drillPage(e.line.id, e.line.side) : linePage(e.line.id))}
      >
        <MasteryRing level={e.p.mastery} size={28} />
        <span class="op-row-text">
          <span class="op-row-title">
            {e.line.family}
            {e.line.variation && <span class="op-row-variation">{e.line.variation}</span>}
          </span>
          <span class="op-row-sub">
            {MASTERY_LABELS[e.p.mastery]}
            {what === 'recent' ? ` · last run ${e.p.lastClean ? 'clean' : 'with mistakes'} · best ${e.p.bestScore}%` : ` · ${dueReason(e.p)}`}
          </span>
        </span>
        <RowChevron />
      </button>
    </li>
  );
  return (
    <section class="op-section" aria-labelledby="op-practice-label" data-id="practice">
      <h2 class="op-label" id="op-practice-label">
        Practice
      </h2>
      {due.length > 0 && (
        <>
          <p class="op-note op-sub-label">Due for review</p>
          <ul class="op-group" data-id="due-lines">
            {due.map((e) => row(e, 'due'))}
          </ul>
        </>
      )}
      <p class="op-note op-sub-label">Recent drills</p>
      <ul class="op-group" data-id="recent-lines">
        {recent.map((e) => row(e, 'recent'))}
      </ul>
    </section>
  );
}

/** Per family: lines drilled and the best mastery among them (the starter cards' ring). */
export function familyMastery(progress: Record<string, LineProgress>): Map<string, { practiced: number; best: MasteryLevel }> {
  const out = new Map<string, { practiced: number; best: MasteryLevel }>();
  for (const p of Object.values(progress)) {
    const family = resolveLine(p.lineId)?.family;
    if (!family || !p.attempts) continue;
    const f = out.get(family) ?? { practiced: 0, best: 0 as MasteryLevel };
    f.practiced++;
    if (p.mastery > f.best) f.best = p.mastery;
    out.set(family, f);
  }
  return out;
}

function dueReason(p: LineProgress): string {
  if (!p.lastClean) return 'last run had mistakes';
  return p.mastery <= 1 ? 'keep practicing' : 'time for a refresher';
}

