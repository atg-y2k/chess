/**
 * Explore by moves: the book's moves from a position, with the opening each one leads to, how
 * common it is in theory, the main move and known mistakes. Tap a move (or play it on the board)
 * to go deeper; the trail of moves leads back. "Learn this line" and "Play" take the position
 * elsewhere.
 */
import { Chess } from 'chess.js';
import { useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { toUci } from '../../chess/utils';
import type { PromotionPiece } from '../../game/types';
import { children, moveLabel, nameAt, type TreeMove } from '../../openings/tree';
import { linePage, treeAdvance, treeTo, updatePage, type TreePage as TreePageState } from '../../openings/session';
import { IconChevronLeft, IconFlip } from '../icons';
import { commonWord, evalWords, learnTarget, MISTAKE_NOTE, playTarget, resolveLine, treePosition } from './model';
import { OpeningBoard, squaresOf } from './OpeningBoard';
import { EvalHiddenNote, GLOSSARY, ShareBar, StarGlyph, Term, WarnGlyph, type PageContext } from './parts';
import { useEval, verdictFor } from './useEval';

export function TreePage({ ctx, page }: { ctx: PageContext; page: TreePageState }) {
  const pos = useMemo(() => treePosition(page.path), [page.path]);
  const kids = useMemo(() => children(pos.fen), [pos.fen]);
  const name = nameAt(pos.fen, pos.fens);
  const evaluation = useEval(ctx.analysis, pos.fen);
  const verdict = verdictFor(evaluation, pos.fen);
  const learn = useMemo(() => learnTarget(pos), [pos]);
  const play = useMemo(() => playTarget(pos), [pos]);
  const playLine = play ? resolveLine(play.lineId) : null;
  const depth = pos.sans.length;
  const orientation = page.flipped ? 'black' : 'white';
  const max = kids.find((k) => !k.dubious)?.share ?? 1;

  // The trail keeps the position shown in view (it scrolls sideways on a phone).
  const trail = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const box = trail.current;
    const el = box?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!box || !el) return;
    box.scrollTo({ left: Math.max(0, el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2), behavior: 'smooth' });
  }, [depth, page.path]);

  const advance = (uci: string) => updatePage('tree', (p) => treeAdvance(treeTo(p, depth), uci));
  const onMove = (from: string, to: string, promotion?: PromotionPiece) => {
    try {
      const chess = new Chess(pos.fen);
      advance(toUci(chess.move({ from, to, promotion: promotion ?? 'q' })));
    } catch {
      /* not legal: the board snaps back */
    }
  };

  return (
    <div class="op-learn op-tree" data-depth={depth}>
      <div class="op-learn-board">
        <OpeningBoard
          fen={pos.fen}
          orientation={orientation}
          movable={pos.fen.split(' ')[1] === 'b' ? 'black' : 'white'}
          lastMove={squaresOf(pos.uci.at(-1))}
          session={`tree:${page.key ?? 0}`}
          evaluation={ctx.evalHidden ? null : evaluation}
          onMove={onMove}
        />
      </div>
      <div class="op-learn-side">
        <div class="op-position" data-id="position-name" aria-live="polite">
          <span class="op-position-name">
            <span class="op-position-family">{name ? name.family : depth ? 'Unnamed position' : 'Starting position'}</span>
            {name?.variation && <span class="op-position-var">{name.variation}</span>}
          </span>
          {verdict && (
            <span class="op-position-eval" data-id="eval-words">
              {evalWords(verdict)}
            </span>
          )}
        </div>
        {ctx.evalHidden && <EvalHiddenNote />}

        <div class="op-trail-row">
          <button
            type="button"
            class="op-ctl"
            data-id="tree-back"
            aria-label="Take back the last move"
            disabled={!depth}
            onClick={() => updatePage('tree', (p) => treeTo(p, depth - 1))}
          >
            <IconChevronLeft size={24} />
          </button>
          <nav class="op-trail" ref={trail} aria-label="Moves so far" data-sheet-nodrag="">
            <button type="button" class="op-trail-step" aria-current={depth === 0 ? 'true' : undefined} onClick={() => updatePage('tree', (p) => treeTo(p, 0))}>
              Start
            </button>
            {pos.labels.map((l, i) => (
              <button
                type="button"
                key={i}
                class="op-trail-step"
                aria-current={i === depth - 1 ? 'true' : undefined}
                onClick={() => updatePage('tree', (p) => treeTo(p, i + 1))}
              >
                {l}
              </button>
            ))}
          </nav>
          <button
            type="button"
            class="op-ctl"
            data-id="flip"
            aria-label="Flip the board"
            onClick={() => updatePage('tree', (p) => ({ ...p, flipped: !p.flipped }))}
          >
            <IconFlip size={21} />
          </button>
        </div>

        {(learn || playLine) && (
          <div class="op-actions-row">
            {learn && (
              <button type="button" class="btn btn-primary op-action" data-id="tree-learn" onClick={() => ctx.go(linePage(learn.lineId, learn.ply))}>
                Learn this line
              </button>
            )}
            {play && playLine && (
              <button type="button" class="btn op-action" data-id="tree-play" onClick={() => ctx.play(play.lineId, play.exact ? 'skip' : 'steer')}>
                {play.exact ? 'Play from here' : 'Play this line'}
              </button>
            )}
          </div>
        )}

        <section class="op-section" aria-labelledby="op-tree-label">
          <h2 class="op-label" id="op-tree-label">
            {depth === 0 ? 'First moves' : 'Book moves here'}
            <Term explain={GLOSSARY.common} id="common-term">
              {' '}
            </Term>
          </h2>
          {kids.length ? (
            <ul class="op-group" data-id="tree-moves">
              {kids.map((k) => (
                <TreeRow key={k.uci} k={k} ply={depth} max={max} onPick={() => advance(k.uci)} />
              ))}
            </ul>
          ) : (
            <p class="op-empty" data-id="tree-empty">
              No book moves here: this position has left the opening book (the well-known moves). Step back to explore
              another move.
              <Term explain={GLOSSARY.book} id="book-term">
                {' '}
              </Term>
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function TreeRow({ k, ply, max, onPick }: { k: TreeMove; ply: number; max: number; onPick: () => void }) {
  return (
    <li>
      <button type="button" class="op-row op-move-row" data-uci={k.uci} data-dubious={k.dubious ? '' : undefined} onClick={onPick}>
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
            {k.name ? k.name.name : k.dubious ? 'A known mistake' : 'Book move'}
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

