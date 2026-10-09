/**
 * An opening family: who plays it, its first moves, the actions (Learn the main line, Drill it,
 * Play it vs computer), the guide (Pro: summary, plans for both sides, traps, key variations), its
 * variations and related openings. Also the "All openings" list.
 */
import { useMemo } from 'preact/hooks';
import { families, findLine, getFamily, linesOfFamily, relatedFamilies, type OpeningFamily } from '../../openings/catalog';
import { allProgress, familyProgress, MASTERY_LABELS } from '../../openings/progress';
import {
  linePage,
  updatePage,
  type FamiliesPage as FamiliesPageState,
  type FamilyPage as FamilyPageState,
} from '../../openings/session';
import { IconLock } from '../PaywallSheet';
import { colorName, familyFacts, mainStudyLineId, movesSummary, movesText, resolveLine, sideSentence, TRAP_PREFIX } from './model';
import { GLOSSARY, MasteryRing, RowChevron, Segmented, Teaser, Term, WarnGlyph, type PageContext } from './parts';

/** Variations listed before "Show all". */
export const VARIATIONS_SHOWN = 8;

export function FamiliesPage({ ctx, page }: { ctx: PageContext; page: FamiliesPageState }) {
  // In the page's entry, so Back from an opening returns to the same list (and scroll position).
  const filter = page.side ?? 'all';
  const setFilter = (v: 'all' | 'w' | 'b') => updatePage('families', (p) => ({ ...p, side: v === 'all' ? undefined : v }));
  const list = families().filter((f) => filter === 'all' || f.side === filter);
  return (
    <div class="op-families">
      <Segmented
        id="families-side"
        label="Show openings for"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'w', label: 'White' },
          { value: 'b', label: 'Black' },
        ]}
      />
      <p class="op-note">Most important first: the openings with the most theory (studied lines) come first.</p>
      <EcoNote />
      <ul class="op-group" data-id="families-list">
        {list.map((f) => (
          <li key={f.name}>
            <FamilyRow ctx={ctx} family={f} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function FamilyRow({ ctx, family: f }: { ctx: PageContext; family: OpeningFamily }) {
  return (
    <button type="button" class="op-row" data-family={f.name} onClick={() => ctx.go({ kind: 'family', family: f.name })}>
      <span class="op-row-text">
        <span class="op-row-title">{f.name}</span>
        <span class="op-row-sub">
          For {colorName(f.side)} · {f.lineCount} {f.lineCount === 1 ? 'line' : 'lines'}
        </span>
      </span>
      <span class="op-eco">{f.ecoRange.replace('-', '–')}</span>
      <RowChevron />
    </button>
  );
}

/** One line about the codes on the rows ("B20", "C50–C59"): what ECO codes are, with the ⓘ. */
export function EcoNote() {
  return (
    <p class="op-note op-eco-note" data-id="eco-note">
      Codes like C50 on the right are{' '}
      <Term explain={GLOSSARY.eco} id="eco-term">
        ECO codes
      </Term>
      , an opening catalog’s numbers.
    </p>
  );
}

export function FamilyPage({ ctx, page }: { ctx: PageContext; page: FamilyPageState }) {
  const family = getFamily(page.family);
  if (!family) {
    return <p class="op-empty">This opening is not in the list.</p>;
  }
  return <FamilyBody ctx={ctx} page={page} family={family} />;
}

function FamilyBody({ ctx, page, family: f }: { ctx: PageContext; page: FamilyPageState; family: OpeningFamily }) {
  const facts = useMemo(() => familyFacts(f), [f]);
  const guide = facts.guide;
  const lines = useMemo(() => linesOfFamily(f.name), [f]);
  const related = useMemo(() => relatedFamilies(f.name), [f]);
  const progress = useMemo(() => (ctx.drills ? allProgress() : {}), [ctx.drills, ctx.progressVersion]);
  const summary = useMemo(() => (ctx.drills ? familyProgress(f.name) : null), [ctx.drills, ctx.progressVersion, f]);
  const mainId = facts.mainId ?? mainStudyLineId(f.name);
  const main = mainId ? resolveLine(mainId) : null;
  // A game follows the line Learn and Drill teach (a guide's main line with its own moves).
  const playId = main?.playable ? main.id : f.mainLineId;
  const shown = page.showAll ? lines : lines.slice(0, VARIATIONS_SHOWN);
  const ownGuide = guide && guide.family === f.name;
  const yours = f.side;
  const ideas = guide ? (yours === 'w' ? [guide.ideasWhite, guide.ideasBlack] : [guide.ideasBlack, guide.ideasWhite]) : null;

  return (
    <div class="op-family" data-family={f.name}>
      <header class="op-hero">
        <p class="op-hero-side" data-side={f.side}>
          <span class="op-side-dot" data-side={f.side} aria-hidden="true" />
          {sideSentence(f.side, facts.mainSan)}
        </p>
        <p class="op-hero-moves" aria-label="First moves">
          {movesText(facts.mainSan, 10)}
        </p>
        <p class="op-hero-meta">
          {f.lineCount} {f.lineCount === 1 ? 'line' : 'lines'}
          <span aria-hidden="true"> · </span>
          <Term explain={GLOSSARY.eco} id="eco-term">
            ECO {f.ecoRange.replace('-', '–')}
          </Term>
        </p>
        {ctx.drills && main && summary && summary.practiced > 0 && (
          <p class="op-hero-progress" data-id="family-progress">
            <MasteryRing level={progress[main.id]?.mastery ?? 0} size={24} />
            <span>
              Main line: {MASTERY_LABELS[progress[main.id]?.mastery ?? 0]}
              {summary && summary.practiced > 0 && (
                <>
                  {' '}
                  · {summary.practiced} {summary.practiced === 1 ? 'line' : 'lines'} practiced
                  {summary.mastered > 0 && `, ${summary.mastered} mastered`}
                </>
              )}
            </span>
          </p>
        )}
        <div class="op-actions">
          {mainId && (
            <button type="button" class="btn btn-primary op-action" data-id="learn-main" onClick={() => ctx.go(linePage(mainId))}>
              Learn the main line
            </button>
          )}
          <div class="op-actions-row">
            {mainId && (
              <button type="button" class="btn op-action" data-id="drill-main" onClick={() => ctx.drill(mainId)}>
                {!ctx.drills && <IconLock size={15} class="op-action-lock" />}
                Drill it
              </button>
            )}
            {playId && (
              <button type="button" class="btn op-action" data-id="play-family" onClick={() => ctx.play(playId)}>
                Play it vs computer
              </button>
            )}
          </div>
        </div>
      </header>

      {guide &&
        (ctx.guides ? (
          <section class="op-section op-guide" data-id="guide" aria-label="Guide">
            <h2 class="op-label">About this opening</h2>
            {!ownGuide && <p class="op-note op-guide-from">From the guide to the {guide.family}.</p>}
            <p class="op-guide-summary">{guide.summary}</p>
            {ideas && (
              <div class="op-ideas">
                <div class="op-ideas-col">
                  <h3 class="op-label">Your plans ({colorName(yours)})</h3>
                  <ul class="op-bullets">
                    {ideas[0].map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </div>
                <div class="op-ideas-col">
                  <h3 class="op-label">Their plans ({colorName(yours === 'w' ? 'b' : 'w')})</h3>
                  <ul class="op-bullets">
                    {ideas[1].map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {guide.typicalPlans && guide.typicalPlans.length > 0 && (
              <>
                <h3 class="op-label">Typical plans</h3>
                <ul class="op-bullets">
                  {guide.typicalPlans.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </>
            )}
            {guide.traps && guide.traps.length > 0 && (
              <>
                <h3 class="op-label">Traps to know</h3>
                <ul class="op-group" data-id="traps">
                  {guide.traps.map((t, i) => (
                    <li key={t.title} class="op-trap">
                      <div class="op-trap-head">
                        <span class="op-trap-icon" aria-hidden="true">
                          <WarnGlyph size={15} />
                        </span>
                        <span class="op-trap-title">{t.title}</span>
                        <span class="op-trap-side">Good for {t.side === 'white' ? 'White' : 'Black'}</span>
                      </div>
                      <p class="op-trap-note">{t.note}</p>
                      <button
                        type="button"
                        class="op-link-btn"
                        data-id="trap-show"
                        onClick={() => ctx.go(linePage(`${TRAP_PREFIX}${guide.family}:${i}`))}
                      >
                        Show me
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {guide.keyVariations && guide.keyVariations.length > 0 && (
              <>
                <h3 class="op-label">Key variations</h3>
                <ul class="op-group" data-id="key-variations">
                  {guide.keyVariations.map((v) => {
                    const l = findLine(v.name);
                    return (
                      <li key={v.name}>
                        <button
                          type="button"
                          class="op-row op-row--tall"
                          disabled={!l}
                          onClick={() => l && ctx.go(linePage(l.id))}
                        >
                          <span class="op-row-text">
                            <span class="op-row-title">{v.name.includes(':') ? v.name.slice(v.name.indexOf(':') + 1).trim() : v.name}</span>
                            <span class="op-row-note">{v.note}</span>
                          </span>
                          {l && <RowChevron />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>
        ) : (
          <section class="op-section">
            <Teaser
              id="guide-teaser"
              title={`What’s the idea behind the ${f.name}?`}
              text="The plans for both sides, the traps to watch for, the key variations and why each move is played."
              onUnlock={() => ctx.unlock('openingGuides')}
            />
          </section>
        ))}

      <section class="op-section" aria-labelledby="op-variations-label">
        <h2 class="op-label" id="op-variations-label">
          <Term explain={GLOSSARY.mainLine} id="main-line-term">
            Variations
          </Term>
        </h2>
        <ul class="op-group" data-id="variations">
          {main && main.kind === 'guide' && (
            <li>
              <button type="button" class="op-row" data-line={main.id} onClick={() => ctx.go(linePage(main.id))}>
                {ctx.drills && <MasteryRing level={progress[main.id]?.mastery ?? 0} size={24} />}
                <span class="op-row-text">
                  <span class="op-row-title">
                    Main line <span class="op-badge-main">Guide</span>
                  </span>
                  <span class="op-row-moves">{movesSummary(main.san)}</span>
                </span>
                <RowChevron />
              </button>
            </li>
          )}
          {shown.map((l, i) => (
            <li key={l.id}>
              <button type="button" class="op-row" data-line={l.id} onClick={() => ctx.go(linePage(l.id))}>
                {ctx.drills && <MasteryRing level={progress[l.id]?.mastery ?? 0} size={24} />}
                <span class="op-row-text">
                  <span class="op-row-title">
                    {l.variation || 'Starting moves'}
                    {i === 0 && main?.kind !== 'guide' && <span class="op-badge-main">Main</span>}
                  </span>
                  <span class="op-row-moves">{movesSummary(l.san)}</span>
                </span>
                <span class="op-eco">{l.eco}</span>
                <RowChevron />
              </button>
            </li>
          ))}
        </ul>
        {lines.length > VARIATIONS_SHOWN && (
          <button
            type="button"
            class="op-more"
            data-id="show-all"
            aria-expanded={page.showAll ? 'true' : 'false'}
            onClick={() => updatePage('family', (p) => ({ ...p, showAll: !p.showAll }))}
          >
            {page.showAll ? 'Show fewer' : `Show all ${lines.length}`}
          </button>
        )}
      </section>

      {related.length > 0 && (
        <section class="op-section" aria-labelledby="op-related-label">
          <h2 class="op-label" id="op-related-label">
            Related openings
          </h2>
          <div class="op-chips">
            {related.map((r) => (
              <button
                type="button"
                key={r.name}
                class="op-chip"
                data-family={r.name}
                onClick={() => ctx.go({ kind: 'family', family: r.name })}
              >
                {r.name}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

