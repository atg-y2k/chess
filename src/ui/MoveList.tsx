import { useEffect, useRef } from 'preact/hooks';
import type { MoveClass } from '../analysis/types';
import type { Ply } from '../game/types';
import { CLASS_META, ClassIcon } from './ClassIcon';
import './MoveList.css';

export interface MoveListProps {
  plies: Ply[];
  /** Number of plies currently applied on the board (plies.length when live). */
  current: number;
  /** Called with the number of plies to show (ply index + 1) when a move is tapped. */
  onSelect: (current: number) => void;
  showClassIcons: boolean;
  /**
   * Which classifications get an icon when `showClassIcons` is on (default 'notable').
   * - 'notable': brilliant, great, inaccuracy, mistake, miss, blunder — the moves worth a
   *   second look. Routine best/excellent/good/book/forced moves stay clean so the single
   *   row remains readable in live play.
   * - 'all': every classified move (e.g. a full review).
   */
  iconSet?: 'notable' | 'all';
}

/** Classes that get an icon in the move list with the default `iconSet: 'notable'`. */
export const NOTABLE_CLASSES: ReadonlySet<MoveClass> = new Set<MoveClass>([
  'brilliant',
  'great',
  'inaccuracy',
  'mistake',
  'miss',
  'blunder',
]);

export interface MovePair {
  /** Full-move number. */
  no: number;
  white?: Ply;
  black?: Ply;
}

/** Full-move number of the position before `ply` (FEN field 6), falling back to the ply index. */
function moveNumber(ply: Ply): number {
  const n = Number(ply.fenBefore.split(' ')[5]);
  return Number.isFinite(n) && n > 0 ? n : Math.floor(ply.index / 2) + 1;
}

/** Groups plies into numbered White/Black pairs. A game starting with Black gets a pair with no White move. */
export function pairMoves(plies: Ply[]): MovePair[] {
  const pairs: MovePair[] = [];
  for (const ply of plies) {
    const last = pairs[pairs.length - 1];
    if (ply.color === 'b' && last && !last.black && last.white) {
      last.black = ply;
    } else if (ply.color === 'w') {
      pairs.push({ no: moveNumber(ply), white: ply });
    } else {
      pairs.push({ no: moveNumber(ply), black: ply });
    }
  }
  return pairs;
}

/** Horizontally scrolling row of numbered moves; keeps the current move centred in view. */
export function MoveList({ plies, current, onSelect, showClassIcons, iconSet = 'notable' }: MoveListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const el = box.querySelector<HTMLElement>('[aria-current="true"]');
    const max = box.scrollWidth - box.clientWidth;
    const target = el ? el.offsetLeft + el.offsetWidth / 2 - box.clientWidth / 2 : current === 0 ? 0 : max;
    const left = Math.max(0, Math.min(max, target));
    const delta = Math.abs(box.scrollLeft - left);
    if (delta > 1) {
      // Animate short hops only; long jumps (e.g. back to the start) snap.
      box.scrollTo({ left, behavior: mounted.current && delta < box.clientWidth * 1.5 ? 'smooth' : 'auto' });
    }
    mounted.current = true;
  }, [current, plies.length]);

  // Desktop: let a vertical mouse wheel scroll the row sideways.
  const onWheel = (e: WheelEvent) => {
    const box = scrollRef.current;
    if (!box || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    box.scrollLeft += e.deltaY;
    e.preventDefault();
  };

  const icon = (ply: Ply) => {
    const cls = ply.classification?.cls;
    if (!showClassIcons || !cls || (iconSet === 'notable' && !NOTABLE_CLASSES.has(cls))) return null;
    return <ClassIcon cls={cls} size={15} />;
  };

  const move = (ply: Ply) => {
    const isCurrent = ply.index + 1 === current;
    const cls = ply.classification?.cls;
    const label = `${ply.color === 'w' ? 'White' : 'Black'} ${ply.san}${cls ? `, ${CLASS_META[cls].label}` : ''}`;
    return (
      <button
        type="button"
        class="mlist-move"
        data-ply={ply.index}
        aria-current={isCurrent ? 'true' : undefined}
        aria-label={label}
        onClick={() => onSelect(ply.index + 1)}
      >
        <span class="mlist-pill">
          {icon(ply)}
          <span class="mlist-san">{ply.san}</span>
        </span>
      </button>
    );
  };

  const pairs = pairMoves(plies);

  return (
    <div class="mlist" ref={scrollRef} onWheel={onWheel} role={pairs.length ? 'list' : undefined} aria-label="Moves">
      {pairs.length === 0 ? (
        <span class="mlist-empty">No moves yet</span>
      ) : (
        pairs.map((p) => (
          <div class="mlist-pair" role="listitem" key={`${p.no}-${p.white?.index ?? p.black?.index}`}>
            <span class="mlist-no" aria-hidden="true">
              {p.no}
              {p.white ? '.' : '…'}
            </span>
            {p.white && move(p.white)}
            {p.black && move(p.black)}
          </div>
        ))
      )}
    </div>
  );
}
