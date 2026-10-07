/**
 * Drill a line (Pro): pick a side and how strict to be, then the computer plays the other side's
 * moves (after a short pause, animated) and the player finds theirs on the board. Each move gets
 * a verdict: correct (with the guide's note), another book move (the line goes on with …), or
 * wrong (shown for a moment, then taken back: try again). Hints come in three steps (the piece,
 * its square, the move); "Show me" plays the move (it counts as missed). The end card shows the
 * score, the moves missed with their notes, and the mastery the run earned (saved progress).
 */
import { Chess } from 'chess.js';
import { useEffect, useMemo } from 'preact/hooks';
import type { Arrow, MoveClass } from '../../analysis/types';
import { parseUci, toUci } from '../../chess/utils';
import type { Color, PromotionPiece } from '../../game/types';
import {
  checkMove,
  createDrill,
  drillHint,
  drillResult,
  dubiousPlayerMoves,
  expectedMove,
  playerMoveCount,
  playOpponent,
  restartDrill,
  type DrillLine,
  type DrillState,
} from '../../openings/drill';
import { getProgress, MASTERED_DAYS, MASTERY_LABELS, recordDrill } from '../../openings/progress';
import { drillPage, updatePage, type DrillPage as DrillPageState } from '../../openings/session';
import { moveLabel } from '../../openings/tree';
import { colorName, drillFeedback, guideOf, moveNote, nb, nextLineId, resolveLine, type StudyLine } from './model';
import { OpeningBoard, squaresOf } from './OpeningBoard';
import { CheckGlyph, CrossGlyph, MasteryRing, Segmented, WarnGlyph, type PageContext } from './parts';

/** Pause before the computer plays its move (ms), so the player sees their own move land. */
export const OPPONENT_DELAY_MS = 650;
/** How long a wrong move stays on the board before it is taken back (ms). */
export const TRIED_MS = 900;

const otherColor = (c: Color): Color => (c === 'w' ? 'b' : 'w');
const boardColor = (c: Color) => (c === 'w' ? 'white' : 'black') as 'white' | 'black';

export function DrillPage({ ctx, page }: { ctx: PageContext; page: DrillPageState }) {
  const line = resolveLine(page.lineId);
  if (!line) return <p class="op-empty">This line is not available.</p>;
  if (!ctx.drills) {
    return (
      <p class="op-empty">
        Drills are part of Pro.{' '}
        <button type="button" class="op-link-btn" onClick={() => ctx.unlock('openingDrills')}>
          Unlock
        </button>
      </p>
    );
  }
  return page.state ? <DrillRun ctx={ctx} page={page} line={line} state={page.state} /> : <DrillSetup page={page} line={line} />;
}

const drillLineOf = (line: StudyLine): DrillLine => ({ id: line.id, uci: line.uci, name: line.name });

function DrillSetup({ page, line }: { page: DrillPageState; line: StudyLine }) {
  const dl = useMemo(() => drillLineOf(line), [line]);
  const color = line.trap ? line.trap.side : page.color;
  const toFind = playerMoveCount(dl, color);
  const dubious = useMemo(() => dubiousPlayerMoves(dl, color), [dl, color]);
  const start = () => {
    let state: DrillState;
    try {
      state = createDrill(dl, color, { acceptAlternatives: page.acceptAlternatives });
    } catch {
      return;
    }
    const before = getProgress(line.id).mastery;
    updatePage('drill', (p) => ({ ...p, state, feedback: null, hint: null, tried: null, recorded: null, before }));
  };
  return (
    <div class="op-learn op-drill">
      <div class="op-learn-board">
        <OpeningBoard fen={new Chess().fen()} orientation={boardColor(color)} session={`drill-setup:${page.key ?? 0}`} onMove={() => {}} />
      </div>
      <div class="op-learn-side">
        <div class="op-drill-setup" data-id="drill-setup">
          <p class="op-drill-name">{line.name}</p>
          <p class="op-note-text">
            The computer plays {colorName(otherColor(color))}’s moves. You find {colorName(color)}’s moves on the board:{' '}
            <strong>
              {toFind} {toFind === 1 ? 'move' : 'moves'}
            </strong>
            .
          </p>
          {line.trap ? (
            // A trap is drilled from the side that sets it: the computer plays the mistake.
            <p class="op-note" data-id="drill-trap-side">
              You play {colorName(line.trap.side)}, the side that sets the trap. The computer falls into it.
            </p>
          ) : (
            <>
              <h3 class="op-label">You play</h3>
              <Segmented
                id="drill-side"
                label="You play"
                value={color}
                onChange={(c) => updatePage('drill', (p) => ({ ...p, color: c }))}
                options={[
                  { value: 'w', label: `White${line.side === 'w' ? ' (this opening)' : ''}` },
                  { value: 'b', label: `Black${line.side === 'b' ? ' (this opening)' : ''}` },
                ]}
              />
              {color !== line.side && (
                <p class="op-note" data-id="drill-other-side">
                  Practice for the other side: mastery counts the drills as {colorName(line.side)}, the side that plays this opening.
                </p>
              )}
            </>
          )}
          <h3 class="op-label">Other book moves</h3>
          <Segmented
            id="drill-mode"
            label="Other book moves"
            value={page.acceptAlternatives ? 'allow' : 'strict'}
            onChange={(v) => updatePage('drill', (p) => ({ ...p, acceptAlternatives: v === 'allow' }))}
            options={[
              { value: 'strict', label: 'Strict: only this line' },
              { value: 'allow', label: 'Allow them' },
            ]}
          />
          <p class="op-note">
            {page.acceptAlternatives
              ? 'Another well-known move is not counted as a mistake, but you still play this line’s move to go on.'
              : 'Only this line’s moves count. Another well-known move counts as a mistake.'}
          </p>
          {dubious.length > 0 && (
            <p class="op-dubious" data-id="drill-dubious">
              <WarnGlyph size={15} /> In this line {colorName(color)} plays a known mistake (
              {dubious.map((i) => moveLabel(i, sanAt(line, i))).join(', ')}): it shows how the mistake gets punished. You can
              drill the other side instead.
            </p>
          )}
          {toFind === 0 ? (
            <p class="op-note" data-id="drill-nothing">
              {colorName(color)} has no moves to find in this line. Pick the other side.
            </p>
          ) : null}
          <button type="button" class="btn btn-primary op-action op-drill-start" data-id="drill-start" disabled={toFind === 0} onClick={start}>
            Start the drill
          </button>
        </div>
      </div>
    </div>
  );
}

const sanAt = (line: StudyLine, i: number): string => line.san[i] ?? '';

function DrillRun({ ctx, page, line, state: s }: { ctx: PageContext; page: DrillPageState; line: StudyLine; state: DrillState }) {
  const guide = useMemo(() => guideOf(line.name) ?? guideOf(line.family), [line]);
  const total = useMemo(() => playerMoveCount(drillLineOf(line), s.playerColor, s.fromPly), [line, s.playerColor, s.fromPly]);
  const result = s.status === 'complete' ? drillResult(s) : null;
  const tried = page.tried;

  // The computer's move, after a pause.
  useEffect(() => {
    if (s.status !== 'opponent') return;
    const t = window.setTimeout(
      () => updatePage('drill', (p) => (p.state && p.state.status === 'opponent' ? { ...p, state: playOpponent(p.state), hint: null } : p)),
      OPPONENT_DELAY_MS,
    );
    return () => window.clearTimeout(t);
  }, [s.status, s.ply, page.key]);

  // A wrong move goes back after a moment.
  useEffect(() => {
    if (!tried) return;
    const t = window.setTimeout(() => updatePage('drill', (p) => ({ ...p, tried: null })), TRIED_MS);
    return () => window.clearTimeout(t);
  }, [tried]);

  // Completed: save the run once.
  useEffect(() => {
    if (!result || page.recorded) return;
    const before = page.before ?? getProgress(line.id).mastery;
    // Mastery counts the drills of the opening's own side (the other side's are practice).
    const after = recordDrill(line.id, result, { family: line.family, side: line.side }).mastery;
    updatePage('drill', (p) => ({ ...p, recorded: { before, after } }));
    ctx.progressChanged();
  }, [!!result, page.recorded]);

  const onMove = (from: string, to: string, promotion?: PromotionPiece) => {
    if (s.status !== 'player' || tried) return;
    const uci = from + to + (promotion ?? '');
    let fenAfter: string;
    let norm: string;
    try {
      const chess = new Chess(s.fen);
      const mv = chess.move({ from, to, promotion: promotion ?? 'q' });
      norm = toUci(mv);
      fenAfter = chess.fen();
    } catch {
      return;
    }
    const check = checkMove(s, promotion ? uci : norm);
    const feedback = drillFeedback(check, line.san);
    if (!feedback) return;
    if (check.result === 'correct') {
      updatePage('drill', (p) => ({ ...p, state: check.state, feedback, hint: null, tried: null }));
    } else {
      updatePage('drill', (p) => ({ ...p, state: check.state, feedback, tried: { uci: norm, fen: fenAfter } }));
    }
  };

  const hint = () => {
    const h = drillHint(s);
    updatePage('drill', (p) => ({ ...p, state: h.state, hint: h.hint, feedback: null }));
  };
  const showMe = () => {
    const h = drillHint(s, 3);
    const mv = expectedMove(h.state);
    if (!mv) return;
    const c = checkMove(h.state, mv.uci);
    updatePage('drill', (p) => ({
      ...p,
      state: c.state,
      hint: null,
      tried: null,
      feedback: { kind: 'shown', text: `The move was ${mv.label}.`, sans: line.san.slice(0, s.ply + 1) },
    }));
  };
  const again = () =>
    updatePage('drill', (p) => ({
      ...p,
      state: restartDrill(s),
      feedback: null,
      hint: null,
      tried: null,
      recorded: null,
      before: getProgress(line.id).mastery,
    }));
  const next = nextLineId(line.id);

  // Board decorations: the hint (a circle on the piece, then the arrow), the verdict badge.
  const arrows: Arrow[] = [];
  const h = page.hint;
  if (h && s.status === 'player' && h.from) {
    const to = h.move ? parseUci(h.move.uci).to : h.from;
    arrows.push({ from: h.from, to, brush: 'best' });
  }
  let badge: { square: string; cls: MoveClass } | undefined;
  if (tried) badge = { square: tried.uci.slice(2, 4), cls: 'mistake' };
  else if (page.feedback && s.lastMove && s.lastMove.color === s.playerColor && page.feedback.kind !== 'wrong' && page.feedback.kind !== 'alternative') {
    badge = { square: parseUci(s.lastMove.uci).to, cls: page.feedback.kind === 'shown' ? 'book' : 'good' };
  }
  const done = movesDone(s, total);
  const fb = page.feedback;
  const note = fb?.sans && (fb.kind === 'correct' || fb.kind === 'shown') && ctx.guides ? moveNote(guide, fb.sans) : undefined;

  return (
    <div class="op-learn op-drill" data-id="drill-run" data-busy={tried || s.status === 'opponent' ? '' : undefined}>
      <div class="op-learn-board">
        <OpeningBoard
          fen={tried ? tried.fen : s.fen}
          orientation={boardColor(s.playerColor)}
          movable={s.status === 'player' && !tried ? boardColor(s.playerColor) : undefined}
          lastMove={squaresOf(tried ? tried.uci : s.lastMove?.uci)}
          arrows={arrows}
          badge={badge}
          session={`drill:${page.key ?? 0}:${s.ply === s.fromPly ? 'start' : 'run'}`}
          onMove={onMove}
        />
      </div>
      <div class="op-learn-side">
        {result ? (
          <DrillEnd
            ctx={ctx}
            page={page}
            line={line}
            state={s}
            score={result.score}
            found={result.found}
            total={result.playerMoves}
            clean={result.clean}
            onAgain={again}
            next={next}
          />
        ) : (
          <>
            <div class="op-drill-status" data-id="drill-status" role="status" aria-live="polite">
              <span class="op-drill-turn">
                {s.status === 'player'
                  ? `Your move: find ${colorName(s.playerColor)}’s move`
                  : `${colorName(otherColor(s.playerColor))} is playing…`}
              </span>
              <span class="op-drill-count" data-id="drill-count">
                {done} of {total}
              </span>
            </div>
            {s.lastMove && s.lastMove.color !== s.playerColor && s.status === 'player' && (
              <p class="op-drill-last" data-id="drill-last">
                {colorName(s.lastMove.color)} played {nb(s.lastMove.label)}
                {line.trap?.mistakes.includes(s.ply - 1) ? ': the mistake! Now punish it.' : '.'}
              </p>
            )}
            <ol class="op-dots" aria-label="Your moves so far">
              {Array.from({ length: total }, (_, i) => {
                const st = dotState(s, i);
                return <li key={i} class="op-dot" data-state={st} aria-label={`Move ${i + 1}: ${DOT_WORDS[st]}`} />;
              })}
            </ol>
            {fb && (
              <div class="op-feedback" data-id="drill-feedback" data-kind={fb.kind}>
                <span class="op-feedback-icon" aria-hidden="true">
                  {fb.kind === 'correct' ? <CheckGlyph size={16} /> : fb.kind === 'wrong' ? <CrossGlyph size={15} /> : <WarnGlyph size={15} />}
                </span>
                <span class="op-feedback-text">
                  <span>{fb.text}</span>
                  {note && <span class="op-feedback-note">{note}</span>}
                </span>
              </div>
            )}
            {h && s.status === 'player' && (
              <p class="op-hint" data-id="drill-hint" role="status">
                Hint: {h.text}
              </p>
            )}
            <div class="op-actions-row op-drill-tools">
              <button type="button" class="btn op-action" data-id="drill-hintbtn" disabled={s.status !== 'player' || (h?.level ?? 0) >= 3} onClick={hint}>
                {h ? 'More help' : 'Hint'}
              </button>
              <button type="button" class="btn op-action" data-id="drill-show" disabled={s.status !== 'player'} onClick={showMe}>
                Show me
              </button>
              <button type="button" class="btn op-action" data-id="drill-restart" onClick={again}>
                Restart
              </button>
            </div>
            <p class="op-note">
              {s.missed.length > 0
                ? `${s.missed.length} ${s.missed.length === 1 ? 'move' : 'moves'} missed so far. A hint or Show me counts as missed.`
                : 'A hint or Show me counts as a missed move.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** The player's moves already played (found or shown). */
function movesDone(s: DrillState, total: number): number {
  let n = 0;
  for (let i = s.fromPly; i < s.ply; i++) if (moverAt(s, i) === s.playerColor) n++;
  return Math.min(total, n);
}

const moverAt = (s: DrillState, ply: number): Color => {
  const first: Color = s.startFen.split(' ')[1] === 'b' ? 'b' : 'w';
  return ply % 2 === 0 ? first : otherColor(first);
};

/** The progress dots for screen readers. */
const DOT_WORDS = { found: 'found', missed: 'missed', current: 'to find now', todo: 'still to come' } as const;

/** 'found' / 'missed' / 'current' / 'todo' for the player's `i`-th move of the drill. */
export function dotState(s: DrillState, i: number): 'found' | 'missed' | 'current' | 'todo' {
  let k = -1;
  for (let ply = s.fromPly; ply < s.moves.length; ply++) {
    if (moverAt(s, ply) !== s.playerColor) continue;
    k++;
    if (k !== i) continue;
    if (ply < s.ply) return s.missed.includes(ply) ? 'missed' : 'found';
    return ply === s.ply ? 'current' : 'todo';
  }
  return 'todo';
}

function DrillEnd({
  ctx,
  page,
  line,
  state: s,
  score,
  found,
  total,
  clean,
  onAgain,
  next,
}: {
  ctx: PageContext;
  page: DrillPageState;
  line: StudyLine;
  state: DrillState;
  score: number;
  found: number;
  total: number;
  clean: boolean;
  onAgain: () => void;
  next: string | null;
}) {
  const guide = guideOf(line.name) ?? guideOf(line.family);
  const rec = page.recorded;
  const progress = rec ? getProgress(line.id) : null;
  const missed = s.missed.slice().sort((a, b) => a - b);
  const nextLine = next ? resolveLine(next) : null;
  return (
    <div class="op-drill-end" data-id="drill-end">
      <p class="op-drill-score">
        <span class="op-drill-score-num" data-id="drill-score">
          {score}%
        </span>
        <span class="op-drill-score-text">
          {found} of {total} {total === 1 ? 'move' : 'moves'} found first time
        </span>
      </p>
      {clean ? (
        <p class="op-feedback" data-kind="correct">
          <span class="op-feedback-icon" aria-hidden="true">
            <CheckGlyph size={16} />
          </span>
          <span class="op-feedback-text">Clean run: every move, no hints.</span>
        </p>
      ) : (
        <div class="op-missed" data-id="drill-missed">
          <h3 class="op-label">Moves to review</h3>
          <ul class="op-bullets">
            {missed.map((ply) => {
              const label = moveLabel(ply, s.sans[ply]);
              const note = ctx.guides ? moveNote(guide, line.san.slice(0, ply + 1)) : undefined;
              return (
                <li key={ply}>
                  <strong>{label}</strong>
                  {note && <span class="op-missed-note"> {note}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {rec && progress && (
        <p class="op-drill-mastery" data-id="drill-mastery">
          <MasteryRing level={rec.after} size={30} />
          <span>
            {rec.after > rec.before ? (
              <>
                <strong>
                  {MASTERY_LABELS[rec.before]} → {MASTERY_LABELS[rec.after]}
                </strong>
                {rec.after === 3 ? '. You know this line by heart.' : '.'}
              </>
            ) : (
              <strong>{MASTERY_LABELS[rec.after]}</strong>
            )}{' '}
            {s.playerColor !== line.side
              ? `This run was practice: mastery counts the drills as ${colorName(line.side)}, the side that plays this opening.`
              : rec.after < 3 &&
                `Mastered: clean runs on ${MASTERED_DAYS} different days (${Math.min(progress.cleanDays.length, MASTERED_DAYS)} so far).`}
          </span>
        </p>
      )}
      <div class="op-actions">
        <button type="button" class="btn btn-primary op-action" data-id="drill-again" onClick={onAgain}>
          Again
        </button>
        <div class="op-actions-row">
          {nextLine && (
            <button
              type="button"
              class="btn op-action"
              data-id="drill-next"
              onClick={() => ctx.replace(drillPage(nextLine.id, s.playerColor, s.acceptAlternatives))}
            >
              Next variation
            </button>
          )}
          {line.playable && (
            <button type="button" class="btn op-action" data-id="drill-play" onClick={() => ctx.play(line.id, 'skip', s.playerColor)}>
              Play a game from here
            </button>
          )}
        </div>
        {nextLine && <p class="op-note">Next: {nextLine.name}</p>}
      </div>
    </div>
  );
}
