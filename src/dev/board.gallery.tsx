/**
 * Dev page for the board and evaluation visuals: /gallery.html?g=board
 *
 * A phone-style layout (eval bar + board + eval graph) over a real 40-ply sample game with
 * Stockfish evaluations. Scrub the graph to review, or move on the board (both colours) to branch
 * off; new moves get unknown (null) evaluations. The promotion scenario puts white pawns on the
 * 7th rank. Every callback is written to the event log at the bottom (also `window.__boardLog`).
 */
import { useMemo, useState } from 'preact/hooks';
import { Chess, type Move } from 'chess.js';
import type { Arrow, MoveClass } from '../analysis/types';
import { formatScore, whiteBarFraction } from '../analysis/winprob';
import type { PromotionPiece } from '../game/types';
import { Board } from '../ui/Board';
import { ClassIcon } from '../ui/ClassIcon';
import { EvalBar } from '../ui/EvalBar';
import { EvalGraph } from '../ui/EvalGraph';
import { IconFlip } from '../ui/icons';

/* Sample game: Stockfish 19 (depth 10) self-play with noise, evaluated at depth 14 (White POV). */
const SAMPLE_SANS = (
  'e4 e5 Nf3 Nc6 Bc4 Nf6 Qe2 Bd6 O-O O-O c3 Na5 d4 Re8 Bd3 Nc6 Bg5 exd4 Bh4 Bf4 ' +
  'cxd4 d6 d5 Ne5 Bb5 c6 Bd3 cxd5 Nc3 dxe4 Nxe5 Bxh2+ Kh1 exd3 Qe3 dxe5 Ne4 Bf4 Qe1 g5'
).split(' ');
const SAMPLE_CP = [
  23, 23, 27, 22, 33, 5, 14, -9, 19, 16, 16, 18, 26, 26, 66, 55, 63, 73, 76, -4, -44, -29, 61, 62,
  63, 14, -32, -281, -125, -125, -125, -489, -186, -530, -563, -609, -638, -695, -723, -787, -771,
];
/** Engine best move in the position after i plies. */
const SAMPLE_BEST = (
  'e2e4 e7e5 g1f3 b8c6 d2d4 g8f6 d2d3 f8c5 d2d4 e8g8 d2d4 c6a5 d2d4 a5c4 c4d3 a5c6 a2a3 h7h6 ' +
  'c3d4 d6f4 f3d4 d7d5 h2h3 c6b4 f3e5 c7c6 d5c6 c8g4 b1c3 d5e4 c3e4 e4d3 g1h2 e4d3 e2d3 h2e5 ' +
  'a1d1 h2f4 e4f6 d3d2 e4g5'
).split(' ');
/** Hand-picked "good" classes for the sample (the gallery has no classifier). */
const SAMPLE_GOOD: Record<number, MoveClass> = { 28: 'great', 30: 'brilliant', 36: 'best' };

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** White pawns on b7 (can also capture on a8/c8) and e7. */
const PROMO_FEN = 'r1r3k1/1P2P1p1/7p/8/8/7P/5PP1/6K1 w - - 0 1';

type Scenario = 'game' | 'promotion';
type ArrowMode = 'coach' | 'all' | 'none';

interface Line {
  baseFen: string;
  sans: string[];
  /** White-POV centipawns after i plies (null = not analysed). */
  cps: (number | null)[];
  best: (string | null)[];
}

const SAMPLE_LINE: Line = { baseFen: START_FEN, sans: SAMPLE_SANS, cps: SAMPLE_CP, best: SAMPLE_BEST };
const PROMO_LINE: Line = { baseFen: PROMO_FEN, sans: [], cps: [640], best: ['b7b8q'] };

const cpToWhiteWin = (cp: number) => whiteBarFraction({ kind: 'cp', value: cp });

/** Rough chess.com-style class from the mover's loss of win probability (gallery only). */
function sampleClass(line: Line, ply: number): MoveClass | null {
  const before = line.cps[ply - 1];
  const after = line.cps[ply];
  if (line.baseFen === START_FEN && ply <= 6) return 'book';
  if (SAMPLE_GOOD[ply] && line.baseFen === START_FEN && line.sans[ply - 1] === SAMPLE_SANS[ply - 1]) {
    return SAMPLE_GOOD[ply];
  }
  if (before == null || after == null) return null;
  const white = ply % 2 === 1;
  const loss = white ? cpToWhiteWin(before) - cpToWhiteWin(after) : cpToWhiteWin(after) - cpToWhiteWin(before);
  if (loss >= 0.2) return 'blunder';
  if (loss >= 0.1) return 'mistake';
  if (loss >= 0.05) return 'inaccuracy';
  if (loss >= 0.02) return 'good';
  if (loss >= 0.01) return 'excellent';
  return 'best';
}

const MARKED: MoveClass[] = ['brilliant', 'great', 'inaccuracy', 'mistake', 'miss', 'blunder'];
const BAD: MoveClass[] = ['inaccuracy', 'mistake', 'miss', 'blunder'];
const ALL_CLASSES: MoveClass[] = [
  'brilliant',
  'great',
  'best',
  'excellent',
  'good',
  'book',
  'forced',
  'inaccuracy',
  'mistake',
  'miss',
  'blunder',
];

function uciArrow(uci: string | null | undefined, brush: Arrow['brush']): Arrow[] {
  return uci ? [{ from: uci.slice(0, 2), to: uci.slice(2, 4), brush }] : [];
}

const CSS = `
.bg { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.bg-wrap { display: flex; flex-direction: column; gap: 14px; max-width: 560px; margin: 0 auto; padding-bottom: 16px; }
.bg-app { display: flex; flex-direction: column; gap: 6px; }
.bg-strip { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 12px; }
.bg-avatar { width: 32px; height: 32px; border-radius: var(--radius-sm); display: grid; place-items: center;
  font-size: 18px; background: var(--surface-3); flex: none; }
.bg-name { font-weight: 700; font-size: 15px; }
.bg-rating { color: var(--text-faint); font-weight: 500; margin-left: 4px; }
.bg-turn { margin-left: auto; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); opacity: 0; }
.bg-turn[data-on='true'] { opacity: 1; }
.bg-boardrow { display: flex; align-items: stretch; }
.bg-boardcell { flex: 1; min-width: 0; }
.bg-graph { padding: 2px 12px 0; }
.bg-graphinfo { display: flex; align-items: center; gap: 8px; min-height: 22px; padding: 6px 12px 0; font-size: 13px; color: var(--text-dim); }
.bg-graphinfo b { color: var(--text); font-weight: 700; }
.bg-dev { display: flex; flex-direction: column; gap: 10px; padding: 0 12px; }
.bg-h { margin: 6px 0 0; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-faint); }
.bg-seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; padding: 4px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.bg-seg button { appearance: none; border: 0; background: transparent; min-height: 40px; border-radius: var(--radius-sm);
  color: var(--text-dim); font-weight: 600; font-size: 14px; cursor: pointer; }
.bg-seg button[aria-pressed='true'] { background: var(--surface-3); color: var(--text); }
.bg-row { display: flex; flex-wrap: wrap; gap: 8px; }
.bg-row .btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 14px; white-space: nowrap; }
.bg-row .btn[aria-pressed='true'] { background: var(--accent); color: var(--accent-text); }
.bg-classes { display: flex; flex-wrap: wrap; gap: 2px; }
.bg-classes button { appearance: none; border: 0; background: transparent; width: 44px; height: 44px; border-radius: var(--radius-sm);
  display: grid; place-items: center; cursor: pointer; }
.bg-classes button[aria-pressed='true'] { background: var(--surface-3); }
.bg-log { margin: 0; min-height: 120px; max-height: 220px; overflow: auto; padding: 10px 12px; border-radius: var(--radius);
  background: var(--surface); border: 1px solid var(--border); font: 12px/1.5 var(--font-mono); color: var(--text-dim);
  white-space: pre-wrap; user-select: text; -webkit-user-select: text; }
@media (orientation: landscape) and (max-height: 540px) {
  .bg-wrap { flex-direction: row; max-width: none; align-items: flex-start; padding: 8px 12px; gap: 12px; }
  .bg-app { flex: none; }
  .bg-strip { display: none; }
  .bg-boardcell { flex: none; width: calc(100dvh - var(--safe-top) - var(--safe-bottom) - 16px); }
  .bg-side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  .bg-graph, .bg-graphinfo, .bg-dev { padding-left: 0; padding-right: 0; }
}
@media (min-width: 960px) {
  .bg-wrap { flex-direction: row; max-width: 1100px; align-items: flex-start; padding: 24px; gap: 24px; }
  .bg-app { flex: none; width: min(600px, calc(100dvh - 120px)); }
  .bg-side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  .bg-graph, .bg-graphinfo, .bg-dev { padding-left: 0; padding-right: 0; }
}
`;

export default function BoardGallery() {
  const [scenario, setScenario] = useState<Scenario>('game');
  const [line, setLine] = useState<Line>(SAMPLE_LINE);
  const [cursor, setCursor] = useState(31);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [reject, setReject] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [arrowMode, setArrowMode] = useState<ArrowMode>('coach');
  const [badgeOverride, setBadgeOverride] = useState<MoveClass | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const write = (msg: string) => {
    const t = new Date().toISOString().slice(11, 23);
    const entry = `${t}  ${msg}`;
    const w = window as unknown as { __boardLog?: string[] };
    (w.__boardLog ??= []).push(msg);
    setLog((l) => [entry, ...l].slice(0, 60));
  };

  /** Positions and verbose moves of the whole line. */
  const replay = useMemo(() => {
    const chess = new Chess(line.baseFen);
    const fens = [chess.fen()];
    const moves: Move[] = [];
    for (const san of line.sans) {
      moves.push(chess.move(san));
      fens.push(chess.fen());
    }
    return { fens, moves };
  }, [line]);

  const fen = replay.fens[cursor];
  const position = useMemo(() => new Chess(fen), [fen]);
  const dests = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const m of position.moves({ verbose: true })) map.set(m.from, [...(map.get(m.from) ?? []), m.to]);
    return map;
  }, [position]);
  const last = cursor > 0 ? replay.moves[cursor - 1] : undefined;
  const turn = position.turn() === 'w' ? 'white' : 'black';

  const points = line.cps.map((cp) => (cp == null ? null : cpToWhiteWin(cp)));
  const markers = useMemo(() => {
    const out: { index: number; cls: MoveClass }[] = [];
    for (let i = 1; i < line.cps.length; i++) {
      const cls = sampleClass(line, i);
      if (cls && MARKED.includes(cls)) out.push({ index: i, cls });
    }
    return out;
  }, [line]);

  const cls = cursor > 0 ? (badgeOverride ?? sampleClass(line, cursor)) : null;
  const badge = last && cls ? { square: last.to, cls } : undefined;

  const arrows = useMemo((): Arrow[] => {
    if (arrowMode === 'none') return [];
    const bestNow = line.best[cursor];
    if (arrowMode === 'all') {
      const other = position.moves({ verbose: true }).find((m) => bestNow && m.from !== bestNow.slice(0, 2));
      return [
        ...uciArrow(bestNow, 'best'),
        ...(other ? [{ from: other.from, to: other.to, brush: 'alt' as const }] : []),
        ...(last ? [{ from: last.from, to: last.to, brush: 'played' as const }] : []),
        ...uciArrow(cursor > 0 ? line.best[cursor - 1] : null, 'threat'),
      ];
    }
    if (cls && BAD.includes(cls)) {
      const shouldHave = line.best[cursor - 1];
      const played = last ? last.from + last.to : '';
      return [...(shouldHave && shouldHave.slice(0, 4) !== played ? uciArrow(shouldHave, 'best') : []), ...uciArrow(bestNow, 'threat')];
    }
    return uciArrow(bestNow, 'best');
  }, [arrowMode, line, cursor, position, last, cls]);

  // Eval bar: the value at the cursor, or the last known one while "analysing".
  let known = cursor;
  while (known > 0 && line.cps[known] == null) known--;
  const cp = line.cps[known];
  const score = { kind: 'cp' as const, value: cp ?? 0 };
  const barProb = cp == null ? 0.5 : whiteBarFraction(score);
  const barLabel = cp == null ? '0.0' : formatScore(score);
  const analysing = thinking || line.cps[cursor] == null;

  const onMove = (from: string, to: string, promotion?: PromotionPiece) => {
    write(`onMove ${from} ${to}${promotion ? ` ${promotion}` : ''}${reject ? '  (rejected)' : ''}`);
    if (reject) return;
    const chess = new Chess(fen);
    let move: Move;
    try {
      move = chess.move({ from, to, promotion });
    } catch {
      write(`  illegal: ${from}${to}`);
      return;
    }
    if (line.sans[cursor] === move.san) {
      setCursor(cursor + 1);
      return;
    }
    setLine({
      baseFen: line.baseFen,
      sans: [...line.sans.slice(0, cursor), move.san],
      cps: [...line.cps.slice(0, cursor + 1), null],
      best: [...line.best.slice(0, cursor + 1), null],
    });
    setCursor(cursor + 1);
  };

  const onSelect = (i: number) => {
    write(`onSelect ${i}`);
    setCursor(i);
  };

  const pickScenario = (s: Scenario) => {
    setScenario(s);
    setBadgeOverride(null);
    if (s === 'game') {
      setLine(SAMPLE_LINE);
      setCursor(31);
    } else {
      setLine(PROMO_LINE);
      setCursor(0);
    }
    write(`scenario ${s}`);
  };

  const moveLabel = last
    ? `${Math.ceil(cursor / 2)}${cursor % 2 === 1 ? '.' : '...'} ${last.san}`
    : 'Start position';
  const top = orientation === 'white' ? 'black' : 'white';
  const names = { white: { name: 'You', emoji: '🙂', rating: 1180 }, black: { name: 'Juniper', emoji: '🦊', rating: 1350 } };

  const strip = (side: 'white' | 'black') => (
    <div class="bg-strip">
      <div class="bg-avatar">{names[side].emoji}</div>
      <div class="bg-name">
        {names[side].name}
        <span class="bg-rating">({names[side].rating})</span>
      </div>
      <div class="bg-turn" data-on={String(turn === side)} />
    </div>
  );

  return (
    <div class="bg">
      <style>{CSS}</style>
      <div class="bg-wrap">
        <div class="bg-app">
          {strip(top)}
          <div class="bg-boardrow">
            <EvalBar whiteWinProb={barProb} label={barLabel} orientation={orientation} thinking={analysing} />
            <div class="bg-boardcell">
              <Board
                fen={fen}
                orientation={orientation}
                movableColor={position.isGameOver() ? undefined : turn}
                dests={dests}
                lastMove={last ? [last.from, last.to] : undefined}
                check={position.inCheck()}
                arrows={arrows}
                badge={badge}
                onMove={onMove}
              />
            </div>
          </div>
          {strip(orientation)}
        </div>
        <div class="bg-side">
          <div class="bg-graph">
            <EvalGraph points={points} current={cursor} markers={markers} onSelect={onSelect} minSpan={scenario === 'promotion' ? 12 : 0} />
          </div>
          <div class="bg-graphinfo">
            {cls && <ClassIcon cls={cls} size={18} />}
            <span>
              <b>{moveLabel}</b> · {line.cps[cursor] == null ? 'analysing…' : formatScore({ kind: 'cp', value: line.cps[cursor]! })}
            </span>
          </div>
          <div class="bg-dev">
            <h2 class="bg-h">Scenario</h2>
            <div class="bg-seg">
              <button aria-pressed={scenario === 'game'} onClick={() => pickScenario('game')}>
                Sample game
              </button>
              <button aria-pressed={scenario === 'promotion'} onClick={() => pickScenario('promotion')}>
                Promotion
              </button>
            </div>
            <div class="bg-row">
              <button class="btn" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')}>
                <IconFlip size={18} /> Flip
              </button>
              <button class="btn" aria-pressed={reject} onClick={() => setReject(!reject)}>
                Reject moves
              </button>
              <button class="btn" aria-pressed={thinking} onClick={() => setThinking(!thinking)}>
                Thinking
              </button>
            </div>
            <h2 class="bg-h">Arrows</h2>
            <div class="bg-seg">
              {(['coach', 'all', 'none'] as const).map((m) => (
                <button key={m} aria-pressed={arrowMode === m} onClick={() => setArrowMode(m)}>
                  {m === 'coach' ? 'Coach' : m === 'all' ? 'All brushes' : 'None'}
                </button>
              ))}
            </div>
            <h2 class="bg-h">Badge</h2>
            <div class="bg-classes">
              {ALL_CLASSES.map((c) => (
                <button
                  key={c}
                  aria-pressed={badgeOverride === c}
                  aria-label={c}
                  onClick={() => setBadgeOverride(badgeOverride === c ? null : c)}
                >
                  <ClassIcon cls={c} size={24} />
                </button>
              ))}
            </div>
            <h2 class="bg-h">Events</h2>
            <pre class="bg-log" id="board-log">
              {log.length ? log.join('\n') : 'Move a piece or scrub the graph…'}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
