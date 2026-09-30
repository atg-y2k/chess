/**
 * Dev page for the in-game panels: /gallery.html?g=panels
 *   &view=live    (default) the game screen with realistic mock data (40-ply game)
 *   &view=review  the review screen (ReviewPanel in place of the coach)
 *   &view=states  every panel in its edge-case states
 *   &sim=0|1      iPhone safe-area simulation (default: on for narrow viewports)
 *   &chrome=0     hide the view switcher (for screenshots)
 * Every callback is logged to `window.__panelEvents` (used by the headless checks).
 * The board, eval bar and eval graph here are stand-ins; the real ones live in Board/EvalBar/EvalGraph.
 */
import { Chessground } from '@lichess-org/chessground';
import type { Api as CgApi } from '@lichess-org/chessground/api';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import { Chess } from 'chess.js';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Classification, Explanation, MoveClass } from '../analysis/types';
import { capturedPieces, material, sideToMove, START_FEN } from '../chess/utils';
import type { Score } from '../engine/types';
import type { Color, Ply } from '../game/types';
import { CLASS_META, classBadgeSvg } from '../ui/ClassIcon';
import { CoachPanel, type CoachPanelProps } from '../ui/CoachPanel';
import { IconBulb, IconCoach, IconFlip, IconMenu, IconPlus, IconUndo } from '../ui/icons';
import { MoveList } from '../ui/MoveList';
import { PlayerStrip } from '../ui/PlayerStrip';
import { ReviewPanel, type KeyMoment, type ReviewPanelProps } from '../ui/ReviewPanel';
import { Toolbar, type ToolbarItem } from '../ui/Toolbar';

declare global {
  interface Window {
    __panelEvents?: { name: string; detail?: unknown }[];
  }
}

/* ------------------------------------------------------------------ mock game */

// Anderssen–Kieseritzky, London 1851 ("The Immortal Game"), first 40 plies: lots of captures.
const SANS = (
  'e4 e5 f4 exf4 Bc4 Qh4+ Kf1 b5 Bxb5 Nf6 Nf3 Qh6 d3 Nh5 Nh4 Qg5 Nf5 c6 g4 Nf6 ' +
  'Rg1 cxb5 h4 Qg6 h5 Qg5 Qf3 Ng8 Bxf4 Qf6 Nc3 Bc5 Nd5 Qxb2 Bd6 Bxg1 e5 Qxa1+ Ke2 Na6'
).split(' ');

// prettier-ignore
const CLASSES: MoveClass[] = [
  'book', 'book', 'book', 'book', 'book', 'book', 'good', 'inaccuracy', 'best', 'best',
  'excellent', 'good', 'best', 'inaccuracy', 'excellent', 'good', 'best', 'good', 'great', 'mistake',
  'brilliant', 'best', 'good', 'inaccuracy', 'excellent', 'good', 'best', 'mistake', 'best', 'good',
  'best', 'excellent', 'great', 'blunder', 'brilliant', 'miss', 'best', 'mistake', 'forced', 'blunder',
];

// White-POV evaluation after each ply (centipawns; numbers >= 10000 mean "mate in (n - 10000)").
// prettier-ignore
const EVALS = [
  30, 25, -10, -20, -15, -40, -45, 60, 70, 55, 40, 50, 45, 90, 80, 120, 110, 90, 150, 320,
  300, 280, 250, 330, 300, 290, 280, 560, 540, 520, 500, 480, 520, 1500, 10007, 10005, 10004, 10003, 10003, 10002,
];

const TEXT: Record<number, { title?: string; lines: string[] }> = {
  7: { lines: ['b5 gives a pawn back to lure the bishop away.', 'Nf6 first keeps more options open.'] },
  13: { lines: ['Nh5 threatens Ng3+, but the knight is offside on the rim.', 'Best was d6, supporting the center.'] },
  18: { lines: ['g4! gains space and kicks the knight before it can settle.', 'White offers the bishop to speed up the attack.'] },
  19: { lines: ['Nf6 walks back and loses time.', 'Best was cxb5, taking the free bishop.'] },
  20: {
    lines: [
      'Rg1!! leaves the bishop hanging to keep the rook ready for g-file play.',
      'Taking with cxb5 lets White trap the queen after h4.',
    ],
  },
  27: { lines: ['Ng8 undevelops the knight and blocks the kingside.', 'Best was Qg6, keeping an eye on f5.'] },
  32: { lines: ['Nd5! jumps into the hole on d5 and eyes c7 and e7.'] },
  33: {
    title: 'Hanging mate threat',
    lines: ['Qxb2 grabs a pawn but ignores the mating net around the black king.', 'Best was Bxg1, removing the rook first.'],
  },
  34: {
    lines: [
      'Bd6!! offers both rooks: the bishop cuts off the queen from e7 and f8.',
      'After Qxa1+ Ke2 White threatens Nxg7+ followed by Qf6+ and Be7#.',
    ],
  },
  35: { lines: ['Bxg1 misses the chance to defend with Qxa1+ first.', 'Best was Qxa1+, forcing Ke2 before taking.'] },
  36: {
    lines: [
      'e5 shuts the black queen out of the defense of g7.',
      'Nxg7+ followed by Qf6+ and Be7# is now unstoppable.',
      'Black has two extra rooks, but they are both out of play.',
    ],
  },
  37: { lines: ['Qxa1+ wins a second rook but does nothing about the mate.'] },
  39: { lines: ['Na6 allows Nxg7+ Kd8 Qf6+ Nxf6 Be7#.', 'Best was Ba6, giving the king an escape square.'] },
};

function scoreOf(v: number): Score {
  return v >= 10000 ? { kind: 'mate', value: v - 10000 } : { kind: 'cp', value: v };
}

function winProb(s: Score | undefined): number | null {
  if (!s) return null;
  if (s.kind === 'mate') return s.value > 0 ? 1 : s.value < 0 ? 0 : 0.5;
  return 1 / (1 + Math.exp(-0.00368208 * s.value));
}

function formatEval(s: Score | undefined): string {
  if (!s) return '0.0';
  if (s.kind === 'mate') return `${s.value < 0 ? '-' : ''}M${Math.abs(s.value)}`;
  const v = s.value / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}

function buildPlies(): Ply[] {
  const chess = new Chess();
  return SANS.map((san, index) => {
    const fenBefore = chess.fen();
    const m = chess.move(san);
    const cls = CLASSES[index];
    const text = TEXT[index];
    const classification: Classification = {
      cls,
      winBefore: 0.5,
      winAfter: 0.5,
      winLoss: 0,
      accuracy: 90,
      bestMoveUci: null,
      bestMoveSan: null,
      playedMoveSan: m.san,
    };
    const explanation: Explanation = {
      headline: text?.lines[0] ?? `${m.san} is ${CLASS_META[cls].label.toLowerCase()}.`,
      details: text?.lines.slice(1) ?? [],
      title: text?.title,
    };
    return {
      index,
      color: m.color,
      san: m.san,
      uci: m.lan,
      fenBefore,
      fenAfter: chess.fen(),
      ...(m.captured ? { captured: m.captured } : {}),
      evalWhite: scoreOf(EVALS[index]),
      evalDepth: 18,
      classification,
      explanation,
      isBook: cls === 'book',
    };
  });
}

const PLAYER = { name: 'Maximilian Featherstonehaugh', rating: 1432, emoji: '😎', color: '#3f6fb0' };
const BOT = { name: 'Countess Evangeline Kieseritzky-Blackwood', rating: 2150, emoji: '🦉', color: '#7a5aa8' };
const PLAYER_COLOR: Color = 'w';

function countsFor(plies: Ply[]): ReviewPanelProps['counts'] {
  const counts: ReviewPanelProps['counts'] = { w: {}, b: {} };
  for (const p of plies) {
    const cls = p.classification?.cls;
    if (cls) counts[p.color][cls] = (counts[p.color][cls] ?? 0) + 1;
  }
  return counts;
}

const KEY_CLASSES: MoveClass[] = ['brilliant', 'great', 'mistake', 'miss', 'blunder'];

function keyMomentsFor(plies: Ply[]): KeyMoment[] {
  return plies
    .filter((p) => p.classification && KEY_CLASSES.includes(p.classification.cls))
    .map((p) => ({ index: p.index, cls: p.classification!.cls, san: p.san, text: p.explanation?.headline ?? '' }));
}

/** Coach content for the position after `current` plies. */
function coachFor(plies: Ply[], current: number): Pick<CoachPanelProps, 'cls' | 'title' | 'lines'> {
  if (current === 0) return { title: 'Your move', lines: ['White to play. Take the center with a pawn.'] };
  const p = plies[current - 1];
  const cls = p.classification!.cls;
  const who = p.color === PLAYER_COLOR ? '' : `${BOT.name.split(' ')[0]}: `;
  return {
    cls,
    title: `${who}${p.explanation?.title ?? CLASS_META[cls].label}`,
    lines: [p.explanation!.headline, ...p.explanation!.details],
  };
}

/* ------------------------------------------------------------------ stand-ins */

function MockBoard({ fen, orientation, lastMove, badge }: {
  fen: string;
  orientation: 'white' | 'black';
  lastMove?: [string, string];
  badge?: { square: string; cls: MoveClass };
}) {
  const el = useRef<HTMLDivElement>(null);
  const api = useRef<CgApi | null>(null);
  useEffect(() => {
    api.current = Chessground(el.current!, { viewOnly: true, coordinates: false, animation: { duration: 180 } });
    return () => api.current?.destroy();
  }, []);
  useEffect(() => {
    api.current?.set({
      fen,
      orientation,
      lastMove: lastMove as never,
      drawable: {
        autoShapes: badge ? [{ orig: badge.square as never, customSvg: { html: classBadgeSvg(badge.cls) } }] : [],
      },
    });
  }, [fen, orientation, lastMove?.[0], lastMove?.[1], badge?.square, badge?.cls]);
  return (
    <div class="gal-board">
      <div ref={el} class="cg-wrap" />
    </div>
  );
}

function MockEvalBar({ win, label, orientation }: { win: number; label: string; orientation: 'white' | 'black' }) {
  const whiteAtBottom = orientation === 'white';
  return (
    <div class="gal-evalbar" data-flip={whiteAtBottom ? undefined : ''} aria-label={`Evaluation ${label}`}>
      <div class="gal-evalbar-fill" style={{ height: `${win * 100}%` }} />
      <span class="gal-evalbar-label" data-side={win >= 0.5 ? 'w' : 'b'}>
        {label.replace('+', '')}
      </span>
    </div>
  );
}

function MockEvalGraph({ points, current, onSelect }: {
  points: (number | null)[];
  current: number;
  onSelect: (i: number) => void;
}) {
  const w = 400;
  const h = 40;
  const n = Math.max(points.length - 1, 1);
  const xy = points.map((p, i) => [(i / n) * w, (1 - (p ?? 0.5)) * h] as const);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  const cx = (current / n) * w;
  return (
    <svg
      class="gal-graph"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      onClick={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        onSelect(Math.round(((e.clientX - r.left) / r.width) * n));
      }}
    >
      <rect width={w} height={h} class="gal-graph-bg" />
      <path d={area} class="gal-graph-area" />
      <line x1="0" x2={w} y1={h / 2} y2={h / 2} class="gal-graph-mid" />
      <line x1={cx} x2={cx} y1="0" y2={h} class="gal-graph-cur" />
    </svg>
  );
}

/* ------------------------------------------------------------------ screens */

function logEvent(name: string, detail?: unknown) {
  (window.__panelEvents ??= []).push({ name, detail });
  // eslint-disable-next-line no-console
  console.log('[panels]', name, detail ?? '');
}

function useToast(): [string | null, (msg: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>(0);
  const show = (m: string) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 1400);
  };
  return [msg, show];
}

type View = 'live' | 'review' | 'states';

function GameScreen({ view, setView }: { view: 'live' | 'review'; setView: (v: View) => void }) {
  const plies = useMemo(buildPlies, []);
  const [current, setCurrent] = useState(view === 'review' ? 34 : 37);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [collapsed, setCollapsed] = useState(false);
  const [coachOn, setCoachOn] = useState(true);
  const [hint, setHint] = useState(false);
  const [toast, showToast] = useToast();
  const [progress, setProgress] = useState<number | null>(view === 'review' ? 0.18 : null);

  const emit = (name: string, detail?: unknown) => {
    logEvent(name, detail);
    showToast(detail === undefined ? name : `${name} ${JSON.stringify(detail)}`);
  };

  // Review: fake an analysis pass that completes in ~2.5s.
  useEffect(() => {
    if (view !== 'review') return;
    const id = window.setInterval(() => {
      setProgress((p) => (p == null ? null : p >= 0.99 ? null : Math.min(1, p + 0.09)));
    }, 220);
    return () => clearInterval(id);
  }, [view]);

  const fen = current === 0 ? START_FEN : plies[current - 1].fenAfter;
  const last = current > 0 ? plies[current - 1] : undefined;
  const caps = capturedPieces(fen);
  const mat = material(fen);
  const turn = sideToMove(fen);
  const live = view === 'live' && current === plies.length - 3; // the "live" position in this mock
  const botColor: Color = PLAYER_COLOR === 'w' ? 'b' : 'w';
  const botThinking = view === 'live' && live && turn === botColor;
  const evalNow = last?.evalWhite;
  const points = [0.5, ...plies.map((p) => winProb(p.evalWhite))];
  const reviewedPlies = progress == null ? plies : plies.slice(0, Math.floor(progress * plies.length));

  const strip = (c: Color) => {
    const who = c === PLAYER_COLOR ? PLAYER : BOT;
    return (
      <PlayerStrip
        name={who.name}
        rating={who.rating}
        emoji={who.emoji}
        avatarColor={who.color}
        captured={caps[c]}
        capturedColor={c === 'w' ? 'b' : 'w'}
        materialDiff={c === 'w' ? mat.w - mat.b : mat.b - mat.w}
        active={turn === c}
        thinking={c === botColor && botThinking}
      />
    );
  };
  const topColor: Color = orientation === 'white' ? 'b' : 'w';

  const coach = hint
    ? {
        title: 'Hint',
        lines: ['Look at the long diagonal: can a bishop join the attack on the black king?'],
        actions: [
          { id: 'show-best', label: 'Show best move', primary: true, onClick: () => emit('coach:show-best') },
          { id: 'hide-hint', label: 'Hide', onClick: () => setHint(false) },
        ],
      }
    : {
        ...coachFor(plies, current),
        actions:
          last && last.classification && ['mistake', 'blunder', 'miss', 'inaccuracy'].includes(last.classification.cls)
            ? [
                { id: 'retry', label: 'Retry', primary: true, onClick: () => emit('coach:retry') },
                { id: 'best', label: 'Show best', onClick: () => emit('coach:best') },
              ]
            : [{ id: 'why', label: 'Why?', onClick: () => emit('coach:why') }],
      };

  const tools: ToolbarItem[] = [
    { id: 'new', label: 'New', icon: <IconPlus />, onClick: () => emit('toolbar:new') },
    {
      id: 'undo',
      label: 'Undo',
      icon: <IconUndo />,
      disabled: current < 2,
      onClick: () => {
        emit('toolbar:undo');
        setCurrent((c) => Math.max(0, c - 2));
      },
    },
    { id: 'hint', label: 'Hint', icon: <IconBulb />, active: hint, onClick: () => { emit('toolbar:hint'); setHint((h) => !h); } },
    {
      id: 'flip',
      label: 'Flip',
      icon: <IconFlip />,
      onClick: () => {
        emit('toolbar:flip');
        setOrientation((o) => (o === 'white' ? 'black' : 'white'));
      },
    },
    { id: 'coach', label: 'Coach', icon: <IconCoach />, active: coachOn, onClick: () => { emit('toolbar:coach'); setCoachOn((v) => !v); } },
    { id: 'menu', label: 'Menu', icon: <IconMenu />, onClick: () => { emit('toolbar:menu'); setView(view === 'live' ? 'review' : 'live'); } },
  ];

  return (
    <div class="gal-screen" data-view={view}>
      <div class="gal-boardcol">
        {strip(topColor)}
        <div class="gal-boardrow">
          <MockEvalBar win={winProb(evalNow) ?? 0.5} label={formatEval(evalNow)} orientation={orientation} />
          <MockBoard
            fen={fen}
            orientation={orientation}
            lastMove={last ? [last.uci.slice(0, 2), last.uci.slice(2, 4)] : undefined}
            badge={last?.classification ? { square: last.uci.slice(2, 4), cls: last.classification.cls } : undefined}
          />
        </div>
        {strip(topColor === 'w' ? 'b' : 'w')}
      </div>
      <div class="gal-sidecol">
        {view === 'review' ? (
          <ReviewPanel
            progress={progress}
            accuracy={progress == null ? { w: 86.4, b: 61.9 } : { w: null, b: null }}
            counts={countsFor(reviewedPlies)}
            playerColor={PLAYER_COLOR}
            names={{ w: PLAYER.name, b: BOT.name }}
            keyMoments={keyMomentsFor(reviewedPlies)}
            onSelectPly={(n) => {
              emit('review:select', n);
              setCurrent(n);
            }}
            onClose={() => {
              emit('review:close');
              setView('live');
            }}
          />
        ) : coachOn ? (
          <CoachPanel
            {...coach}
            collapsed={collapsed}
            onToggleCollapsed={() => {
              emit('coach:toggle');
              setCollapsed((c) => !c);
            }}
          />
        ) : (
          <div class="gal-spacer" />
        )}
        <MockEvalGraph
          points={points}
          current={current}
          onSelect={(i) => {
            emit('graph:select', i);
            setCurrent(i);
          }}
        />
        <MoveList
          plies={plies}
          current={current}
          showClassIcons={coachOn || view === 'review'}
          iconSet={view === 'review' ? 'all' : 'notable'}
          onSelect={(n) => {
            emit('movelist:select', n);
            setCurrent(n);
          }}
        />
        <Toolbar items={tools} />
      </div>
      {toast && <div class="gal-toast">{toast}</div>}
    </div>
  );
}

/** Edge cases for each panel, stacked. */
function StatesPage() {
  const plies = useMemo(buildPlies, []);
  const [collapsed, setCollapsed] = useState(true);
  const noop = (name: string) => () => logEvent(name);
  const blackFirst = useMemo(() => {
    const c = new Chess('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 3 3');
    return ['Nf6', 'Nc3', 'Bb4'].map((san, i) => {
      const fenBefore = c.fen();
      const m = c.move(san);
      return { index: i, color: m.color, san: m.san, uci: m.lan, fenBefore, fenAfter: c.fen() } satisfies Ply;
    });
  }, []);
  const section = (title: string, children: ComponentChildren) => (
    <section class="gal-sec">
      <h3 class="gal-sec-title">{title}</h3>
      {children}
    </section>
  );
  return (
    <div class="gal-states">
      {section(
        'PlayerStrip',
        <>
          <PlayerStrip name="Stockfish Jr." rating={3200} emoji="🤖" avatarColor="#2c6e63" captured={[]} capturedColor="w" materialDiff={0} active={false} />
          <PlayerStrip name={BOT.name} rating={BOT.rating} emoji={BOT.emoji} avatarColor={BOT.color} captured={['q', 'r', 'r', 'b', 'b', 'n', 'n', 'p', 'p', 'p', 'p', 'p', 'p', 'p', 'p']} capturedColor="w" materialDiff={39} active thinking />
          <PlayerStrip name={PLAYER.name} rating={PLAYER.rating} emoji={PLAYER.emoji} avatarColor={PLAYER.color} captured={['p', 'n', 'p', 'b']} capturedColor="b" materialDiff={3} active />
          <PlayerStrip name="Guest" emoji="🙂" captured={['q']} capturedColor="b" materialDiff={0} active={false} />
        </>,
      )}
      {section(
        'CoachPanel',
        <>
          <CoachPanel title="Analyzing your move…" lines={[]} busy />
          <CoachPanel title="Your move" lines={['Black threatens Qxa1+, winning your rook on a1.']} />
          <CoachPanel
            cls="mistake"
            title="Mistake"
            lines={[
              'Ng8 undevelops the knight and blocks your kingside.',
              'Best was Qg6, which keeps an eye on f5 and h5.',
              'White can now play Bxf4 with a big lead in development.',
            ]}
            actions={[
              { id: 'retry', label: 'Retry', primary: true, onClick: noop('states:retry') },
              { id: 'best', label: 'Show best', onClick: noop('states:best') },
            ]}
            onToggleCollapsed={noop('states:toggle')}
          />
          <CoachPanel cls="blunder" title="Blunder" lines={['This hangs your queen on d8.']} busy />
          <CoachPanel
            cls="great"
            title="Great move"
            lines={Array.from({ length: 8 }, (_, i) => `Long explanation sentence number ${i + 1} to check that the bubble scrolls internally instead of pushing the layout.`)}
          />
          <CoachPanel
            cls="brilliant"
            title="Brilliant"
            lines={['Bd6!! offers both rooks to cut the queen off from the defense.']}
            collapsed={collapsed}
            onToggleCollapsed={() => {
              logEvent('states:collapse');
              setCollapsed((c) => !c);
            }}
          />
          <CoachPanel cls="book" title="Book move" lines={["King's Gambit Accepted: Bishop's Gambit."]} collapsed onToggleCollapsed={noop('states:expand-book')} />
        </>,
      )}
      {section(
        'MoveList',
        <>
          <MoveList plies={[]} current={0} onSelect={noop('states:ml-empty')} showClassIcons />
          <MoveList plies={blackFirst} current={2} onSelect={(n) => logEvent('states:ml-black', n)} showClassIcons />
          <MoveList plies={plies} current={8} onSelect={(n) => logEvent('states:ml-all', n)} showClassIcons iconSet="all" />
          <MoveList plies={plies} current={40} onSelect={(n) => logEvent('states:ml-noicons', n)} showClassIcons={false} />
        </>,
      )}
      {section(
        'Toolbar',
        <Toolbar
          items={[
            { id: 'prev', label: 'Previous', icon: <IconUndo />, onClick: noop('states:tb-prev'), disabled: true },
            { id: 'hint', label: 'Hint', icon: <IconBulb />, onClick: noop('states:tb-hint'), active: true },
            { id: 'flip', label: 'Flip board', icon: <IconFlip />, onClick: noop('states:tb-flip') },
            { id: 'menu', label: 'Menu', icon: <IconMenu />, onClick: noop('states:tb-menu') },
          ]}
        />,
      )}
      {section(
        'ReviewPanel (analyzing, nothing yet)',
        <div class="gal-fixed">
          <ReviewPanel
            progress={0.03}
            accuracy={{ w: null, b: null }}
            counts={{ w: {}, b: {} }}
            playerColor="b"
            names={{ w: 'Magnus', b: 'You' }}
            keyMoments={[]}
            onSelectPly={noop('states:rv-select')}
            onClose={noop('states:rv-close')}
          />
        </div>,
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ page */

const CSS = `
.gal-root { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.gal-root[data-sim] { padding: 59px 0 34px; }
.gal-island { position: absolute; top: 11px; left: 50%; width: 126px; height: 37px; margin-left: -63px;
  border-radius: 20px; background: #000; z-index: 20; pointer-events: none; }
.gal-homebar { position: absolute; bottom: 8px; left: 50%; width: 134px; height: 5px; margin-left: -67px;
  border-radius: 3px; background: var(--text); opacity: 0.8; z-index: 20; pointer-events: none; }
.gal-switch { position: absolute; top: 14px; left: 10px; display: flex; gap: 2px; z-index: 21; }
.gal-switch a { padding: 6px 8px; border-radius: 8px; font-size: 12px; font-weight: 600; color: var(--text-faint);
  text-decoration: none; }
.gal-switch a[aria-current='page'] { color: var(--text); background: var(--surface-2); }
.gal-root:not([data-sim]) .gal-switch { position: static; padding: 6px 8px 0; }

.gal-screen { flex: 1; min-height: 0; display: flex; flex-direction: column; width: 100%; max-width: 520px;
  margin: 0 auto; }
.gal-boardcol, .gal-sidecol { display: flex; flex-direction: column; min-height: 0; }
.gal-sidecol { flex: 1 1 auto; }
.gal-sidecol > .coach, .gal-sidecol > .review, .gal-spacer { flex: 1 1 0; min-height: 92px; }
.gal-sidecol > .coach--collapsed { flex: 0 0 auto; min-height: 0; margin-bottom: auto; }
.gal-boardrow { display: flex; gap: 0; }
.gal-board { flex: 1; aspect-ratio: 1; position: relative; }
.gal-board .cg-wrap { position: absolute; inset: 0; width: 100%; height: 100%; }
.gal-board cg-board { background: repeating-conic-gradient(var(--board-dark) 0 25%, var(--board-light) 0 50%) 0 0 / 25% 25%; }
.gal-board cg-board square.last-move { background-color: rgba(240, 180, 60, 0.42); }
.gal-evalbar { position: relative; flex: none; width: 14px; background: var(--eval-black); overflow: hidden; }
.gal-evalbar-fill { position: absolute; left: 0; right: 0; bottom: 0; background: var(--eval-white);
  transition: height 0.4s ease; }
.gal-evalbar[data-flip] .gal-evalbar-fill { bottom: auto; top: 0; }
.gal-evalbar-label { position: absolute; left: 0; right: 0; bottom: 3px; text-align: center; font-size: 7px;
  font-weight: 800; color: var(--eval-black); writing-mode: horizontal-tb; letter-spacing: -0.04em; }
.gal-evalbar-label[data-side='b'] { bottom: auto; top: 3px; color: var(--eval-white); }
.gal-graph { display: block; flex: none; width: 100%; height: 40px; cursor: pointer; margin-top: 2px; }
.gal-graph-bg { fill: var(--eval-black); }
.gal-graph-area { fill: var(--eval-white); }
.gal-graph-mid { stroke: var(--text-faint); stroke-width: 1; vector-effect: non-scaling-stroke; opacity: 0.6; }
.gal-graph-cur { stroke: var(--accent); stroke-width: 2; vector-effect: non-scaling-stroke; }
.gal-toast { position: absolute; left: 50%; bottom: 100px; transform: translateX(-50%); z-index: 30;
  max-width: 90%; padding: 8px 14px; border-radius: 18px; background: var(--surface-3); color: var(--text);
  font-size: 13px; font-weight: 600; box-shadow: 0 6px 20px rgba(0,0,0,0.35); pointer-events: none;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.gal-states { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 8px 0 40px;
  width: 100%; max-width: 520px; margin: 0 auto; }
.gal-sec { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.gal-sec-title { margin: 0 12px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-faint); }
.gal-fixed { height: 300px; display: flex; flex-direction: column; }
.gal-fixed > .review { flex: 1; }

/* Landscape phone / desktop: board left, panels right. */
@media (orientation: landscape) and (min-width: 640px) {
  .gal-screen { flex-direction: row; max-width: none; gap: 12px; padding: 0 12px; }
  .gal-root[data-sim] { padding: 0 59px 21px; }
  .gal-island { top: 50%; left: 11px; width: 37px; height: 126px; margin: -63px 0 0; }
  .gal-switch { left: auto; right: 10px; }
  .gal-boardcol { flex: none; width: min(calc(100dvh - 21px - 88px + 14px), 620px); justify-content: center; }
  .gal-root:not([data-sim]) .gal-boardcol { width: min(calc(100dvh - 120px + 14px), 620px); }
  .gal-sidecol { flex: 1; min-width: 300px; max-width: 460px; padding-top: 6px; }
}
`;

export default function PanelsGallery() {
  const q = new URLSearchParams(location.search);
  const initial = (q.get('view') as View | null) ?? 'live';
  const [view, setViewState] = useState<View>(initial);
  const sim = q.get('sim') === '1' || (q.get('sim') !== '0' && window.innerWidth < 500);
  const chrome = q.get('chrome') !== '0';

  const setView = (v: View) => {
    setViewState(v);
    const next = new URLSearchParams(location.search);
    next.set('view', v);
    history.replaceState(null, '', `?${next.toString()}`);
  };

  return (
    <div class="gal-root" data-sim={sim ? '' : undefined}>
      <style>{CSS}</style>
      {sim && <div class="gal-island" />}
      {sim && <div class="gal-homebar" />}
      {chrome && (
        <nav class="gal-switch">
          {(['live', 'review', 'states'] as View[]).map((v) => (
            <a
              key={v}
              href={`?g=panels&view=${v}`}
              aria-current={v === view ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                setView(v);
              }}
            >
              {v}
            </a>
          ))}
        </nav>
      )}
      {view === 'states' ? <StatesPage /> : <GameScreen key={view} view={view} setView={setView} />}
    </div>
  );
}
