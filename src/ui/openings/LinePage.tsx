/**
 * Learn a line: step through its moves on a board (buttons, tapping the left or right half of the
 * note card, swiping it, arrow keys, or automatic play), with the opening's name at each move, the
 * engine's evaluation, the guide's note on each move (Pro) and the other book moves at the
 * position, each a branch into its own line. A book move made on the board follows its line; any
 * other move shows that it leaves the book, with the engine's verdict and a way back.
 */
import { Chess } from 'chess.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { toUci } from '../../chess/utils';
import type { PromotionPiece } from '../../game/types';
import { children, moveLabel, type TreeMove } from '../../openings/tree';
import {
  goToPly,
  leaveBook,
  linePage,
  stepLine,
  updatePage,
  type LinePage as LinePageState,
} from '../../openings/session';
import { IconChevronLeft, IconChevronRight, IconFlip } from '../icons';
import { IconLock } from '../PaywallSheet';
import {
  branchTarget,
  colorName,
  commonWord,
  evalWords,
  guideOf,
  MISTAKE_NOTE,
  moveNote,
  resolveLine,
  studySteps,
  type StudyLine,
} from './model';
import { OpeningBoard, OpeningDrawControls, squaresOf } from './OpeningBoard';
import { EvalHiddenNote, GLOSSARY, MoveStrip, ShareBar, StarGlyph, Teaser, Term, WarnGlyph, type PageContext } from './parts';
import { useEval, verdictFor } from './useEval';

/** Automatic play: one move every this many ms. */
export const AUTOPLAY_MS = 1500;
/** Other book moves listed before "More". */
const OTHERS_SHOWN = 5;
/** A horizontal swipe on the note card of at least this many px steps. */
const SWIPE_PX = 40;

export function LinePage({ ctx, page }: { ctx: PageContext; page: LinePageState }) {
  const line = resolveLine(page.lineId);
  if (!line) return <p class="op-empty">This line is not available.</p>;
  return <LineBody ctx={ctx} page={page} line={line} />;
}

function LineBody({ ctx, page, line }: { ctx: PageContext; page: LinePageState; line: StudyLine }) {
  const steps = useMemo(() => studySteps(line), [line]);
  const last = steps.length - 1;
  const ply = Math.min(page.ply, last);
  const step = steps[ply];
  const off = page.offBook;
  const fen = off ? off.fen : step.fen;
  const guide = useMemo(() => guideOf(line.name) ?? guideOf(line.family), [line]);
  const evaluation = useEval(ctx.analysis, fen);
  // Words only for this very position, once the engine has finished it (never the previous one's).
  const verdict = verdictFor(evaluation, fen);
  const [auto, setAuto] = useState(false);
  const moreOthers = !!page.moreOthers;
  const orientation = (line.side === 'w') !== !!page.flipped ? 'white' : 'black';
  const sansHere = line.san.slice(0, ply);
  const next = off ? null : (steps[ply + 1] ?? null);
  const kids = useMemo(() => (off ? [] : children(step.fen)), [off, step.fen]);
  const others = kids.filter((k) => k.uci !== next?.uci);
  const note = ply > 0 && !off ? moveNote(guide, sansHere) : undefined;
  // A trap's own mistake (the one its story is about).
  const trapMistake = ply > 0 && !off && !!line.trap?.mistakes.includes(ply - 1);
  const mate = useMemo(() => new Chess(steps[last].fen).isCheckmate(), [steps, last]);
  const isTop = ctx.isTop;

  const go = (n: number) => updatePage('line', (p) => goToPly(p, n, last));
  const step1 = (d: number) => updatePage('line', (p) => stepLine(p, d, last));
  const manual = (f: () => void) => () => {
    setAuto(false);
    f();
  };

  // Automatic play: a move every AUTOPLAY_MS until the end (from the start when at the end).
  useEffect(() => {
    if (!auto) return;
    if (ply >= last || off) {
      setAuto(false);
      return;
    }
    const t = window.setTimeout(() => step1(1), AUTOPLAY_MS);
    return () => window.clearTimeout(t);
  }, [auto, ply, off, last]);

  // Desktop: ← → step, Home / End jump (not while typing, nor under another layer such as a sheet).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !isTop()) return;
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, select, [role="slider"], [contenteditable]')) return;
      if (e.key === 'ArrowLeft') step1(-1);
      else if (e.key === 'ArrowRight') step1(1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(last);
      else return;
      e.preventDefault();
      setAuto(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [last]);

  const branch = (k: Pick<TreeMove, 'san' | 'uci' | 'lineId'>) => {
    setAuto(false);
    const t = branchTarget(sansHere, k);
    if ('lineId' in t) {
      if (t.lineId === line.id) go(t.ply);
      else ctx.go(linePage(t.lineId, t.ply));
    } else {
      ctx.go({ kind: 'tree', path: t.tree });
    }
  };

  const onMove = (from: string, to: string, promotion?: PromotionPiece) => {
    setAuto(false);
    let uci: string;
    let san: string;
    let after: string;
    try {
      const chess = new Chess(fen);
      const mv = chess.move({ from, to, promotion: promotion ?? 'q' });
      uci = toUci(mv);
      san = mv.san;
      after = chess.fen();
    } catch {
      return; // the board snaps back
    }
    if (next?.uci === uci) {
      go(ply + 1);
      return;
    }
    const kid = kids.find((k) => k.uci === uci);
    if (kid) {
      branch(kid);
      return;
    }
    updatePage('line', (p) => leaveBook(p, { uci, san, fen: after }));
  };

  // Tap the left / right half of the note card, or swipe it, to step.
  const pad = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPadDown = (e: PointerEvent) => {
    pad.current = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  const onPadUp = (e: PointerEvent) => {
    const p = pad.current;
    pad.current = null;
    if (!p) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('button, a, input')) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
      setAuto(false);
      step1(dx < 0 ? 1 : -1);
      return;
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && performance.now() - p.t < 500) {
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setAuto(false);
      step1(e.clientX < box.left + box.width / 2 ? -1 : 1);
    }
  };

  const playedBy = step.color ? colorName(step.color) : null;
  const name = step.name;

  return (
    <div class="op-learn" data-line={line.id}>
      <div class="op-learn-board">
        <OpeningBoard
          fen={fen}
          orientation={orientation}
          movable={off ? undefined : fen.split(' ')[1] === 'b' ? 'black' : 'white'}
          lastMove={squaresOf(off ? off.uci : step.uci)}
          session={`line:${page.key ?? 0}`}
          evaluation={ctx.evalHidden ? null : evaluation}
          drawable
          onMove={onMove}
        />
      </div>

      <div class="op-learn-side">
        <div class="op-position-row">
          <div class="op-position" data-id="position-name" aria-live="polite">
            {off ? (
              <span class="op-position-name">
                <span class="op-position-family">Out of the book</span>
                <span class="op-position-var">after {step.label ?? 'the start'}</span>
              </span>
            ) : name ? (
              <span class="op-position-name">
                <span class="op-position-family">{name.family}</span>
                {name.variation && <span class="op-position-var">{name.variation}</span>}
              </span>
            ) : (
              <span class="op-position-name">
                <span class="op-position-family">Starting position</span>
              </span>
            )}
            {verdict && (
              <span class="op-position-eval" data-id="eval-words">
                {evalWords(verdict)}
              </span>
            )}
          </div>
          <OpeningDrawControls />
        </div>
        {ctx.evalHidden && <EvalHiddenNote />}

        <div class="op-controls" role="group" aria-label="Step through the line">
          <button type="button" class="op-ctl" data-id="first" aria-label="First position" disabled={ply === 0 && !off} onClick={manual(() => go(0))}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 5v14M18 18l-6-6 6-6" />
            </svg>
          </button>
          <button type="button" class="op-ctl" data-id="prev" aria-label="Previous move" disabled={ply === 0 && !off} onClick={manual(() => step1(-1))}>
            <IconChevronLeft size={24} />
          </button>
          <button
            type="button"
            class="op-ctl op-ctl--play"
            data-id="autoplay"
            aria-label={auto ? 'Pause' : 'Play the moves'}
            aria-pressed={auto ? 'true' : 'false'}
            disabled={!!off}
            onClick={() => {
              if (!auto && ply >= last) go(0);
              setAuto((a) => !a);
            }}
          >
            {auto ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="6" y="5" width="4" height="14" rx="1" />
                <rect x="14" y="5" width="4" height="14" rx="1" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l11.5-7.2a1 1 0 0 0 0-1.72L8.5 3.94A1 1 0 0 0 7 4.8Z" />
              </svg>
            )}
          </button>
          <button type="button" class="op-ctl" data-id="next" aria-label="Next move" disabled={ply >= last || !!off} onClick={manual(() => step1(1))}>
            <IconChevronRight size={24} />
          </button>
          <button type="button" class="op-ctl" data-id="last" aria-label="Last position" disabled={ply >= last && !off} onClick={manual(() => go(last))}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 5v14M6 18l6-6-6-6" />
            </svg>
          </button>
          <button
            type="button"
            class="op-ctl"
            data-id="flip"
            aria-label="Flip the board"
            onClick={() => updatePage('line', (p) => ({ ...p, flipped: !p.flipped }))}
          >
            <IconFlip size={21} />
          </button>
        </div>

        <MoveStrip
          label="Moves of the line"
          current={off ? -1 : ply}
          onSelect={(n) => {
            setAuto(false);
            go(n);
          }}
          moves={steps.slice(1).map((s) => ({ ply: s.ply, label: s.label ?? '', san: s.san ?? '', dubious: s.dubious }))}
        />

        <div
          class="op-note-card"
          data-id="note-card"
          onPointerDown={onPadDown}
          onPointerUp={onPadUp}
          onPointerCancel={() => (pad.current = null)}
        >
          {off ? (
            <div class="op-offbook" data-id="off-book" role="status">
              <p class="op-note-title">
                <WarnGlyph size={16} /> {moveLabel(ply, off.san)} leaves the opening book
                <Term explain={GLOSSARY.book} id="book-term">
                  {' '}
                </Term>
              </p>
              <p class="op-note-text">
                It is not one of the well-known moves here.{' '}
                {ctx.evalHidden
                  ? ''
                  : verdict
                    ? `The engine says: ${engineSays(verdict)} (${evaluation.label}).`
                    : evaluation.thinking
                      ? 'The engine is checking it…'
                      : ''}
              </p>
              <button type="button" class="btn btn-primary op-note-btn" data-id="back-to-line" onClick={() => step1(-1)}>
                Back to the line
              </button>
            </div>
          ) : ply === 0 ? (
            <LineIntro ctx={ctx} line={line} />
          ) : (
            <div class="op-move-note">
              <p class="op-note-title" data-id="move-title">
                {step.label}
                {playedBy && <span class="op-note-who"> · {playedBy}</span>}
              </p>
              {step.dubious && (
                <p class="op-dubious" data-id="dubious">
                  <WarnGlyph size={15} /> {trapMistake ? 'This is the mistake the trap is about.' : MISTAKE_NOTE}
                </p>
              )}
              {note ? (
                ctx.guides ? (
                  <p class="op-note-text" data-id="move-note">
                    {note}
                  </p>
                ) : (
                  <Teaser
                    compact
                    id="note-teaser"
                    title="Why is this move played?"
                    text="Unlock explanations for every move."
                    onUnlock={() => ctx.unlock('openingGuides')}
                  />
                )
              ) : (
                trapMistake &&
                line.trap &&
                (ctx.guides ? (
                  <p class="op-note-text" data-id="trap-note">
                    {line.trap.note}
                  </p>
                ) : (
                  <Teaser compact title="Why is it a mistake?" onUnlock={() => ctx.unlock('openingGuides')} />
                ))
              )}
              {ply === last && (
                <p class="op-note-text op-line-end" data-id="line-end">
                  {lineEnd(line, mate, others.length > 0)}
                </p>
              )}
            </div>
          )}
          <span class="op-pad-hint" aria-hidden="true">
            <IconChevronLeft size={14} />
            <IconChevronRight size={14} />
          </span>
        </div>

        <div class="op-actions-row op-line-actions">
          <button type="button" class="btn op-action" data-id="drill-line" onClick={() => ctx.drill(line.id)}>
            {!ctx.drills && <IconLock size={15} class="op-action-lock" />}
            Drill this line
          </button>
          {line.playable && (
            <button type="button" class="btn op-action" data-id="play-line" onClick={() => ctx.play(line.id)}>
              Play it vs computer
            </button>
          )}
        </div>

        {!off && others.length > 0 && (
          <section class="op-section op-others" aria-labelledby="op-others-label">
            <h2 class="op-label" id="op-others-label">
              {next ? 'Other moves here' : 'Book moves from here'}
              <Term explain={GLOSSARY.common} id="common-term">
                {' '}
              </Term>
            </h2>
            <ul class="op-group" data-id="other-moves">
              {(moreOthers || others.length <= OTHERS_SHOWN + 1 ? others : others.slice(0, OTHERS_SHOWN)).map((k) => (
                <OtherMove key={k.uci} k={k} ply={ply} max={others[0]?.share ?? 1} onPick={() => branch(k)} />
              ))}
            </ul>
            {others.length > OTHERS_SHOWN + 1 && (
              <button
                type="button"
                class="op-more"
                data-id="others-all"
                aria-expanded={moreOthers ? 'true' : 'false'}
                onClick={() => updatePage('line', (p) => ({ ...p, moreOthers: !p.moreOthers }))}
              >
                {moreOthers ? 'Show fewer' : `Show all ${others.length}`}
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/** The engine's verdict inside a sentence ("about equal", "White is better"). */
function engineSays(score: Parameters<typeof evalWords>[0]): string {
  const w = evalWords(score);
  return w.startsWith('About') ? w.toLowerCase() : w;
}

/**
 * What the last move of a line says: how a mate or a trap ends, else what to do next (drill it,
 * play it, or the other moves below when there are any).
 */
export function lineEnd(line: Pick<StudyLine, 'trap' | 'playable'>, mate: boolean, othersBelow: boolean): string {
  if (line.trap) {
    return mate
      ? 'Checkmate: that is how the trap ends.'
      : `That is how the trap ends: ${colorName(line.trap.side)} comes out ahead. Next, try Drill this line.`;
  }
  if (mate) return 'Checkmate: that is how this line ends.';
  const next = line.playable ? 'Drill this line or Play it vs computer' : 'Drill this line';
  return `That is the end of this line. Next, try ${next}${othersBelow ? ', or look at the other moves below' : ''}.`;
}

/** "5 moves: 3 by White, 2 by Black". */
export function movesCount(plies: number): string {
  const white = Math.ceil(plies / 2);
  const black = Math.floor(plies / 2);
  if (plies === 1) return '1 move, by White';
  return `${plies} moves: ${white} by White, ${black} by Black`;
}

/** What the line is, at its start position. */
function LineIntro({ ctx, line }: { ctx: PageContext; line: StudyLine }) {
  if (line.trap) {
    return (
      <div class="op-move-note" data-id="line-intro">
        <p class="op-note-title">
          <WarnGlyph size={16} /> Trap: {line.trap.title}
        </p>
        <p class="op-note-text">Good for {colorName(line.trap.side)}. Step through to see how it works.</p>
        {ctx.guides ? (
          <p class="op-note-text" data-id="trap-note">
            {line.trap.note}
          </p>
        ) : (
          <Teaser compact title="How to use it, and how to avoid it" onUnlock={() => ctx.unlock('openingGuides')} />
        )}
      </div>
    );
  }
  return (
    <div class="op-move-note" data-id="line-intro">
      <p class="op-note-title">{line.variation && line.kind !== 'guide' ? line.variation : line.family}</p>
      <p class="op-note-text">
        {movesCount(line.san.length)}. Tap ▶ to play them one by one, or tap a move. Tap the right side of this card to go
        forward, the left side to go back.
      </p>
    </div>
  );
}

function OtherMove({ k, ply, max, onPick }: { k: TreeMove; ply: number; max: number; onPick: () => void }) {
  const name = k.name ? k.name.name : null;
  const short = name ? (name.includes(':') ? name.slice(name.indexOf(':') + 1).trim() : name) : null;
  return (
    <li>
      <button
        type="button"
        class="op-row op-move-row"
        data-uci={k.uci}
        data-dubious={k.dubious ? '' : undefined}
        onClick={onPick}
      >
        <span class="op-move-san">{moveLabel(ply, k.san)}</span>
        <span class="op-row-text">
          <span class="op-row-title op-move-name">
            {k.isMain && (
              <span class="op-main-star" aria-label="Main line">
                <StarGlyph size={12} />
              </span>
            )}
            {k.dubious && (
              <span class="op-warn" aria-hidden="true">
                <WarnGlyph size={13} />
              </span>
            )}
            {short ?? (k.dubious ? 'A known mistake' : 'Book move')}
          </span>
          <span class="op-move-common">
            <ShareBar share={k.dubious ? 0 : k.share} max={max} />
            <span class="op-move-word">{commonWord(k)}</span>
          </span>
          {k.dubious && <span class="op-row-note">{MISTAKE_NOTE}</span>}
        </span>
      </button>
    </li>
  );
}
