/**
 * Chessboard (chessground) with coach arrows, a classification badge and a promotion picker.
 *
 * The chessground instance is created once and updated with `cg.set()` when props change. The
 * board is width-driven: it fills its parent's width as a square (rounded down to whole device
 * pixels per square, so at most ~3px narrower), so bound its size from the parent, e.g.
 * `width: min(100cqw - 16px, 100cqh - 300px)`. It works as a flex item next to <EvalBar/> too.
 */
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Config } from '@lichess-org/chessground/config';
import type { DrawBrush, DrawBrushes, DrawShape } from '@lichess-org/chessground/draw';
import type { Dests, Key } from '@lichess-org/chessground/types';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import type { Arrow, ArrowBrush, MoveClass } from '../analysis/types';
import type { PromotionPiece } from '../game/types';
import { classBadgeSvg } from './ClassIcon';
import { IconClose } from './icons';
import './Board.css';

export type BoardColor = 'white' | 'black';

export interface BoardProps {
  fen: string;
  orientation: BoardColor;
  /** Colour the user may move, or undefined when the board is read-only (bot thinking, game over, review). */
  movableColor?: BoardColor;
  /** Legal destinations for the side to move (from chess.js). */
  dests: Map<string, string[]>;
  lastMove?: [string, string];
  /** Highlight the side-to-move king as in check. */
  check?: boolean;
  arrows?: Arrow[];
  /** Classification icon at a square (like chess.com). */
  badge?: { square: string; cls: MoveClass };
  /**
   * A user move. Accept it by passing the new `fen` (in the same task, e.g. synchronously from a
   * store update); if `fen` is still unchanged shortly afterwards, the board snaps back to it.
   * Pawn moves to the last rank first show the promotion picker.
   */
  onMove: (from: string, to: string, promotion?: PromotionPiece) => void;
}

/** Hex fallbacks for the `--arrow-*` tokens in app.css (the live token values are read at mount). */
const ARROW_HEX: Record<ArrowBrush, string> = {
  best: '#3fa45b',
  alt: '#3f86c4',
  threat: '#d9534f',
  played: '#f0b43c',
};

/** Stroke width in 1/64ths of a square, and opacity, per arrow kind. */
const ARROW_STYLE: Record<ArrowBrush, { lineWidth: number; opacity: number }> = {
  best: { lineWidth: 13, opacity: 0.88 },
  alt: { lineWidth: 10, opacity: 0.62 },
  threat: { lineWidth: 11, opacity: 0.8 },
  played: { lineWidth: 11, opacity: 0.8 },
};

/** Draw order: the most important arrow last, so it ends up on top. */
const ARROW_ORDER: Record<ArrowBrush, number> = { alt: 0, played: 1, threat: 2, best: 3 };

/** How long a user move may stay unanswered (fen prop unchanged) before the board snaps back. */
const RESYNC_DELAY_MS = 40;

const PROMO_CHOICES: { piece: PromotionPiece; role: string; name: string }[] = [
  { piece: 'q', role: 'queen', name: 'Queen' },
  { piece: 'n', role: 'knight', name: 'Knight' },
  { piece: 'r', role: 'rook', name: 'Rook' },
  { piece: 'b', role: 'bishop', name: 'Bishop' },
];

interface PendingPromotion {
  from: string;
  to: string;
  color: BoardColor;
}

/** FEN piece letter on `square` (e.g. 'P', 'n'), or null. */
export function pieceOnSquare(fen: string, square: string): string | null {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]);
  const rows = fen.split(' ')[0].split('/');
  const row = rows[8 - rank];
  if (row === undefined || file < 0 || file > 7) return null;
  let col = 0;
  for (const ch of row) {
    if (ch >= '1' && ch <= '8') col += Number(ch);
    else if (col++ === file) return ch;
    if (col > file) return null;
  }
  return null;
}

/** The colour promoting when `from`→`to` is a pawn reaching its last rank in `fen`, else null. */
export function promotionColor(fen: string, from: string, to: string): BoardColor | null {
  const piece = pieceOnSquare(fen, from);
  if (piece === 'P' && to[1] === '8') return 'white';
  if (piece === 'p' && to[1] === '1') return 'black';
  return null;
}

/** Largest size <= `available` CSS px whose squares are a whole number of device pixels. */
export function snapBoardSize(available: number, dpr = window.devicePixelRatio || 1): number {
  return Math.max(8, Math.floor((available * dpr) / 8) * 8) / dpr;
}

function turnOf(fen: string): BoardColor {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

function readToken(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** Chessground brushes for our arrow kinds; the default brush names map onto the same colours. */
function makeBrushes(el: Element): DrawBrushes {
  const brush = (kind: ArrowBrush, key: string = kind): DrawBrush => ({
    key,
    color: readToken(el, `--arrow-${kind}`, ARROW_HEX[kind]),
    ...ARROW_STYLE[kind],
  });
  return {
    green: brush('best', 'green'),
    red: brush('threat', 'red'),
    blue: brush('alt', 'blue'),
    yellow: brush('played', 'yellow'),
    best: brush('best'),
    alt: brush('alt'),
    threat: brush('threat'),
    played: brush('played'),
  };
}

function buildShapes(arrows: Arrow[] | undefined, badge: BoardProps['badge']): DrawShape[] {
  const shapes: DrawShape[] = (arrows ?? [])
    .slice()
    .sort((a, b) => ARROW_ORDER[a.brush] - ARROW_ORDER[b.brush])
    .map((a) => ({
      orig: a.from as Key,
      dest: a.from === a.to ? undefined : (a.to as Key),
      brush: a.brush,
    }));
  if (badge) shapes.push({ orig: badge.square as Key, customSvg: { html: classBadgeSvg(badge.cls) } });
  return shapes;
}

/** Tints the last move's squares in the badge colour when the badge sits on the move's destination. */
function badgeHighlight(p: BoardProps): Map<Key, string> | undefined {
  if (!p.badge || !p.lastMove || p.lastMove[1] !== p.badge.square) return undefined;
  const cls = `cls-${p.badge.cls}`;
  return new Map([
    [p.lastMove[0] as Key, cls],
    [p.lastMove[1] as Key, cls],
  ]);
}

/** Position/interaction part of the config (everything that must match `fen`). */
function positionConfig(p: BoardProps, withFen = true): Config {
  return {
    ...(withFen ? { fen: p.fen } : {}),
    turnColor: turnOf(p.fen),
    lastMove: p.lastMove as Key[] | undefined,
    check: !!p.check,
    movable: { color: p.movableColor, dests: p.dests as Dests },
  };
}

/** Decoration part of the config (safe to apply at any time). */
function decorationConfig(p: BoardProps): Config {
  return {
    orientation: p.orientation,
    highlight: { custom: badgeHighlight(p) },
    drawable: { autoShapes: buildShapes(p.arrows, p.badge) },
  };
}

export function Board(props: BoardProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const cgElRef = useRef<HTMLDivElement>(null);
  const cgRef = useRef<Api | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  /** The fen chessground was last synced to. */
  const syncedFenRef = useRef(props.fen);
  /** fen at the time of a user move that the parent has not answered yet. */
  const pendingFenRef = useRef<string | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const [promo, setPromo] = useState<PendingPromotion | null>(null);
  const promoRef = useRef(promo);
  promoRef.current = promo;

  /** Puts chessground back on the props (after a rejected or cancelled move). */
  const resync = () => {
    const cg = cgRef.current;
    if (!cg) return;
    const p = propsRef.current;
    pendingFenRef.current = null;
    syncedFenRef.current = p.fen;
    cg.set({ ...positionConfig(p), ...decorationConfig(p) });
  };

  const submit = (from: string, to: string, promotion?: PromotionPiece) => {
    const fenAtMove = propsRef.current.fen;
    pendingFenRef.current = fenAtMove;
    propsRef.current.onMove(from, to, promotion);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (pendingFenRef.current === fenAtMove && propsRef.current.fen === fenAtMove && !promoRef.current) resync();
    }, RESYNC_DELAY_MS);
  };

  const onUserMove = (orig: Key, dest: Key) => {
    if (!cgRef.current) return; // unmounted before chessground's deferred callback ran
    const color = promotionColor(propsRef.current.fen, orig, dest);
    if (color) {
      pendingFenRef.current = propsRef.current.fen;
      setPromo({ from: orig, to: dest, color });
    } else {
      submit(orig, dest);
    }
  };

  // Create chessground once.
  useLayoutEffect(() => {
    const el = cgElRef.current!;
    const p = propsRef.current;
    const initial = hostRef.current!.getBoundingClientRect().width;
    if (initial > 0) rootRef.current!.style.width = `${snapBoardSize(initial)}px`;
    const cg = Chessground(el, {
      ...positionConfig(p),
      ...decorationConfig(p),
      coordinates: true,
      ranksPosition: 'left',
      autoCastle: true,
      blockTouchScroll: true,
      touchIgnoreRadius: 1,
      jsHover: true,
      disableContextMenu: true,
      animation: { enabled: true, duration: 200 },
      highlight: { lastMove: true, check: true, custom: badgeHighlight(p) },
      movable: {
        free: false,
        color: p.movableColor,
        dests: p.dests as Dests,
        showDests: true,
        rookCastle: true,
        events: { after: (orig, dest) => onUserMove(orig, dest) },
      },
      premovable: { enabled: false },
      predroppable: { enabled: false },
      draggable: { enabled: true, distance: 3, autoDistance: true, showGhost: true, deleteOnDropOff: false },
      selectable: { enabled: true },
      drawable: {
        enabled: false,
        visible: true,
        brushes: makeBrushes(el),
        autoShapes: buildShapes(p.arrows, p.badge),
      },
    });
    cgRef.current = cg;
    syncedFenRef.current = p.fen;

    // The board is sized to a whole number of device pixels per square (chessground snaps its
    // container the same way), so squares stay crisp and the box matches what is drawn. On a size
    // change chessground re-measures by itself; a full redraw also refreshes coordinates and shapes.
    const host = hostRef.current!;
    const boardEl = rootRef.current!;
    let lastSize = 0;
    let frame = 0;
    const fit = (available: number) => {
      if (available <= 0) return;
      const size = snapBoardSize(available);
      if (size === lastSize) return;
      const first = lastSize === 0;
      lastSize = size;
      boardEl.style.width = `${size}px`;
      if (first) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => cg.redrawAll());
    };
    const ro = new ResizeObserver((entries) => fit(entries[0]?.contentRect.width ?? 0));
    ro.observe(host);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(timerRef.current);
      cg.destroy();
      cgRef.current = null;
    };
  }, []);

  // Push prop changes into chessground.
  const lastMoveKey = props.lastMove?.join('') ?? '';
  useLayoutEffect(() => {
    const cg = cgRef.current;
    if (!cg) return;
    const fenChanged = props.fen !== syncedFenRef.current;
    if (fenChanged) {
      pendingFenRef.current = null;
      syncedFenRef.current = props.fen;
      if (promoRef.current) setPromo(null);
      cg.set({ ...positionConfig(props), ...decorationConfig(props) });
    } else if (pendingFenRef.current !== null) {
      // A user move is waiting for the parent: keep chessground's post-move state, update decorations only.
      cg.set(decorationConfig(props));
    } else {
      cg.set({ ...positionConfig(props, false), ...decorationConfig(props) });
    }
    // Read-only now: drop a selection or drag the user had started.
    if (!props.movableColor && (cg.state.selected || cg.state.draggable.current)) cg.cancelMove();
  }, [
    props.fen,
    props.orientation,
    props.movableColor,
    props.dests,
    lastMoveKey,
    props.check,
    props.arrows,
    props.badge?.square,
    props.badge?.cls,
  ]);

  const choosePromotion = (piece: PromotionPiece) => {
    const p = promoRef.current;
    if (!p) return;
    setPromo(null);
    submit(p.from, p.to, piece);
  };

  const cancelPromotion = () => {
    setPromo(null);
    resync();
  };

  return (
    <div class="board-host" ref={hostRef}>
      <div class="board" ref={rootRef}>
        <div class="board-cg cg-wrap" ref={cgElRef} />
        {promo && (
          <PromotionPicker
            promo={promo}
            orientation={props.orientation}
            onPick={choosePromotion}
            onCancel={cancelPromotion}
          />
        )}
      </div>
    </div>
  );
}

interface PromotionPickerProps {
  promo: PendingPromotion;
  orientation: BoardColor;
  onPick: (piece: PromotionPiece) => void;
  onCancel: () => void;
}

/** Column of promotion choices over the promotion square, growing from the promoting side's edge. */
function PromotionPicker({ promo, orientation, onPick, onCancel }: PromotionPickerProps) {
  const firstRef = useRef<HTMLButtonElement>(null);
  const file = promo.to.charCodeAt(0) - 97;
  const column = orientation === 'white' ? file : 7 - file;
  const fromTop = promo.color === orientation;

  useEffect(() => {
    firstRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Pointer-down reacts immediately and, being cancelled, suppresses the touch-compat mouse events
  // that would otherwise reach the board underneath. onClick only handles keyboard activation.
  const press = (action: () => void) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    action();
  };
  const keyboardOnly = (action: () => void) => (e: MouseEvent) => {
    if (e.detail === 0) action();
  };

  return (
    <div
      class="board-promo cg-wrap"
      role="dialog"
      aria-label="Promote pawn"
      onPointerDown={press(onCancel)}
    >
      <div
        class={`board-promo-col ${fromTop ? 'from-top' : 'from-bottom'}`}
        style={{ left: `${column * 12.5}%` }}
      >
        {PROMO_CHOICES.map((c, i) => (
          <button
            key={c.piece}
            ref={i === 0 ? firstRef : undefined}
            type="button"
            class="board-promo-opt"
            aria-label={`Promote to ${c.name.toLowerCase()}`}
            data-piece={c.piece}
            onPointerDown={press(() => onPick(c.piece))}
            onClick={keyboardOnly(() => onPick(c.piece))}
          >
            {h('piece', { class: `${c.role} ${promo.color}` })}
          </button>
        ))}
        <button
          type="button"
          class="board-promo-cancel"
          aria-label="Cancel promotion"
          onPointerDown={press(onCancel)}
          onClick={keyboardOnly(onCancel)}
        >
          <IconClose size={16} />
        </button>
      </div>
    </div>
  );
}
