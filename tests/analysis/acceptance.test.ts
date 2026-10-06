/**
 * Coaching texts the acceptance test found misleading, checked against the engine lines the app
 * works with: Stockfish 19 lite at depth 14, MultiPV 3, before and after each move (the way
 * GameController.annotate analyzes a ply), captured once into tests/fixtures/explain-acceptance.json
 * so this suite is engine-free. The hand-made cases at the end use lines from the same engine too.
 */
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult, PvLine, Score } from '../../src/engine/types';
import type { Classification, Explanation, MoveClass } from '../../src/analysis/types';
import { classifyMove } from '../../src/analysis/classify';
import { explainBestMove, explainMove, type Perspective } from '../../src/analysis/explain';
import { materialOutcome } from '../../src/analysis/motifs';
import { parseUci } from '../../src/chess/utils';

interface Fixture {
  games: Record<string, string>;
  analyses: Record<string, AnalysisResult>;
}
const FX = JSON.parse(
  readFileSync(new URL('../fixtures/explain-acceptance.json', import.meta.url), 'utf8'),
) as Fixture;

const key = (fen: string) => fen.split(' ').slice(0, 4).join(' ');
function analysis(fen: string): AnalysisResult {
  const a = FX.analyses[key(fen)];
  if (!a) throw new Error(`no fixture analysis for ${fen}`);
  return a;
}
/** Headline and details, checked for the basic style rules (see explain.test.ts `expectWellFormed`). */
function text(e: Explanation): string[] {
  const all = [e.headline, ...e.details];
  expect(e.details.length).toBeLessThanOrEqual(3);
  for (const s of all) {
    expect(s).toMatch(/[.!]$/);
    expect(s).toMatch(/^([A-Z]|[a-h][1-8x])/);
    expect(s).not.toMatch(/undefined|null|NaN|\s{2}|centre|defence/);
  }
  return all;
}

/** A copy of `r` whose engine lines stop after `plies` moves (a PV cut short, as the app saw 45.g7). */
const cut = (r: AnalysisResult, plies: number): AnalysisResult => ({
  ...r,
  lines: r.lines.map((l) => ({ ...l, pv: l.pv.slice(0, plies) })),
});

/**
 * Ply `index` (0-based) of acceptance game `game`, classified and explained the way the controller
 * does it (previous move, previous position, perspective), plus the hint for that position.
 */
function annotate(
  game: string,
  index: number,
  perspective: Perspective,
  lines: { before?: AnalysisResult; after?: AnalysisResult } = {},
) {
  const sans = FX.games[game].split(' ');
  const c = new Chess();
  let prev: { to: string; captured?: string; fenBefore: string } | undefined;
  for (let i = 0; i < index; i++) {
    const fenBefore = c.fen();
    const m = c.move(sans[i]);
    prev = { to: m.to, ...(m.captured ? { captured: m.captured } : {}), fenBefore };
  }
  const fenBefore = c.fen();
  const m = c.move(sans[index]);
  const uci = m.from + m.to + (m.promotion ?? '');
  const before = lines.before ?? analysis(fenBefore);
  const after = lines.after ?? analysis(c.fen());
  const prevMove = prev ? { to: prev.to, ...(prev.captured ? { captured: prev.captured } : {}) } : undefined;
  const classification = classifyMove({
    fenBefore,
    moveUci: uci,
    before,
    after,
    isBook: false,
    playerRating: 1200,
    prevMove: prev ? { to: prev.to } : undefined,
    prevFenBefore: prev?.fenBefore,
  });
  const explanation = explainMove({ fenBefore, moveUci: uci, classification, before, after, prevMove, perspective });
  const hint = explainBestMove(fenBefore, before.lines[0], { prevMove, perspective, lines: before.lines });
  return { classification, explanation, hint, fenBefore, uci, before, after };
}

describe('acceptance games: what the coach says (depth 14, MultiPV 3)', () => {
  it('12...Kd6 (game A): the queen falls to the skewer whatever the king does; the rook on a8 still defends it', () => {
    const { classification, explanation: e } = annotate('A', 23, 'neutral');
    expect(classification.cls).toBe('excellent'); // already lost: the eval barely moves
    expect(text(e).join(' ')).not.toMatch(/without a defender/);
    expect(text(e)).toEqual([
      'Kd6 gets the king out of check.',
      "Black’s queen on d8 is lost to the skewer whichever way the king moves.",
    ]);
    // Not a concession (so not a review key moment): Kxd7, the best move, loses the queen too.
    expect(e.concedes).toBeUndefined();
    expect(annotate('A', 23, 'you').explanation.details).toContain(
      'Your queen on d8 is lost to the skewer whichever way the king moves.',
    );
  });

  it('13...b6 (game B): leads with the missed bishop (bxa6), the pawn lost to the fork comes second', () => {
    const { classification, explanation: e } = annotate('B', 25, 'you');
    expect(classification.cls).toBe('blunder');
    expect(e.headline).toBe('You missed bxa6, which wins back a bishop.');
    expect(e.details).toEqual([
      'It takes the undefended bishop on a6.',
      'b6 also loses a pawn to a fork.',
      'White answers Bb7, which attacks your rook on a8 and your pawn on c6 at once (a fork).',
    ]);
    expect(e.title).toBe('Missed tactic');
    expect(e.motifs?.[0]).toBe('missedTactic');
  });

  it('15.Qh6 (game C): no queen "won" from a reply the engine only chose among equal ones', () => {
    const { classification, explanation: e, after } = annotate('C', 28, 'you');
    // Where "Qh6 wins the queen for a bishop and a pawn. Key line: Qh6 Qxe2 Nxe2 …" came from: at
    // depth 14 the engine's top reply is 15...Qxe2, but 15...O-O-O and 15...Nxd5 score the same
    // (Black is lost either way), and neither gives the queen away.
    expect(after.lines.map((l) => l.pv[0])).toEqual(['e7e2', 'e8c8', 'b6d5']);
    expect(after.lines.map((l) => l.score)).toEqual([
      { kind: 'cp', value: -699 },
      { kind: 'cp', value: -700 },
      { kind: 'cp', value: -716 },
    ]);
    expect(classification.cls).toBe('excellent');
    expect(text(e).join(' ')).not.toMatch(/wins|queen|Qxe2/);
    expect(e.headline).toBe('Qh6 keeps your winning position.');
  });

  it('45.g7 (game C): a line that stops before ...Nxg7 does not "win a rook"', () => {
    // As the app saw it: the PV stopped at g7 Rxg7 Rxg7 Nf5+ Kg4, with the rook on g7 hanging.
    const fen = '8/5R2/1k4P1/8/7K/p3np1P/P5r1/3b4 w - - 3 45';
    const short = cut(analysis(fen), 5);
    expect(materialOutcome(fen, short.lines[0].pv, 'w')).toMatchObject({ net: -1, won: {}, lost: { p: 1 }, settled: false });
    const g7 = annotate('C', 88, 'you', { before: short });
    expect(g7.classification.cls).toBe('best');
    for (const e of [g7.explanation, g7.hint]) {
      expect(text(e).join(' ')).not.toMatch(/wins/);
      expect(e.headline).toBe('g7 pushes a passed pawn toward promotion.');
    }
    // The full line (…f2+ Kxf5 f1=Q+) says the same.
    const full = annotate('C', 88, 'you');
    expect(full.explanation.headline).toBe('g7 pushes a passed pawn toward promotion.');
  });

  it('11...Bxd2+ and 12...dxe3 (game B): taking back the knight lost on a6 "wins back" a bishop', () => {
    const bxd2 = annotate('B', 21, 'you');
    const dxe3 = annotate('B', 23, 'you');
    expect(bxd2.explanation.headline).toBe('Bxd2+ wins back a bishop.');
    expect(bxd2.hint.headline).toBe('Bxd2+ wins back a bishop.');
    expect(dxe3.explanation.headline).toBe('dxe3 wins back a bishop.');
    expect(dxe3.hint.headline).toBe('dxe3 wins back a bishop.');
  });
});

// ------------------------------------------------------------------ hand-made cases (engine lines)

const cp = (value: number): Score => ({ kind: 'cp', value });
const pvLine = (score: Score, pv: string[], multipv = 1): PvLine => ({ multipv, depth: 14, score, pv });
const result = (fen: string, lines: PvLine[]): AnalysisResult => ({
  fen,
  depth: 14,
  lines,
  bestMove: lines[0]?.pv[0] ?? null,
  done: true,
});
function explainWith(fen: string, uci: string, cls: MoveClass, before: PvLine[], after: PvLine[], win: [number, number]) {
  const c = new Chess(fen);
  const m = c.move(parseUci(uci));
  const best = before[0].pv[0];
  const classification: Classification = {
    cls,
    winBefore: win[0],
    winAfter: win[1],
    winLoss: Math.max(0, win[0] - win[1]),
    accuracy: 90,
    bestMoveUci: best,
    bestMoveSan: new Chess(fen).move(parseUci(best)).san,
    playedMoveSan: m.san,
  };
  return explainMove({ fenBefore: fen, moveUci: uci, classification, before: result(fen, before), after: result(c.fen(), after) });
}

describe('guards behind those fixes', () => {
  it('"without a defender" only when no defender is left (b2 still guards c3)', () => {
    const fen = 'r3k2r/pp3pp1/5p1p/q2p1b2/1bpP3P/2N1PN2/PP1QBPP1/R3K2R w Qkq - 0 16';
    const e = explainWith(
      fen,
      'd2d1',
      'blunder',
      [pvLine(cp(443), ['e2d1', 'f5d3', 'f3g1', 'e8g8']), pvLine(cp(442), ['a2a3', 'e8g8', 'f3g1'], 2)],
      [pvLine(cp(-87), ['b4c3', 'b2c3', 'a5c3', 'f3d2', 'e8g8', 'd1c1', 'c3a5'])],
      [0.83, 0.42],
    );
    expect(e.headline).toBe('This takes a defender away from your knight on c3.');
  });

  it('a loss that is not small next to the missed win still leads (Rxe2 hangs the rook, h2 won one)', () => {
    const fen = '1R6/8/3k4/P4p2/1p1P1P2/4PK1p/4B3/4r3 b - - 1 67';
    const e = explainWith(
      fen,
      'e1e2',
      'blunder',
      [pvLine(cp(69), ['h3h2', 'b8b6', 'd6c7', 'b6h6', 'h2h1q', 'h6h1', 'e1h1']), pvLine(cp(-210), ['b4b3', 'f3g3'], 2)],
      [pvLine(cp(846), ['f3e2', 'h3h2', 'b8b6', 'd6c7', 'b6h6', 'c7b7', 'h6h2'])],
      [0.56, 0.04],
    );
    expect(e.headline).toBe('Rxe2 grabs a bishop, but it hangs your rook on e2.');
  });

  it('a capture keeps its gain when the other replies are clearly worse for the opponent (Bxg2)', () => {
    const fen = '3B2nr/n4k1p/3P2p1/1p1b1p2/p7/P1pB2P1/P1P1KPRP/R2Q4 b - - 1 23';
    const e = explainWith(
      fen,
      'd5g2',
      'excellent',
      [pvLine(cp(-973), ['g8h6', 'd8g5', 'h6g4']), pvLine(cp(-1034), ['d5g2', 'f2f3', 'g8f6', 'd8f6'], 2)],
      [
        pvLine(cp(1022), ['f2f3', 'g8f6', 'd8f6', 'f7f6', 'e2f2', 'f6e6', 'd6d7', 'h8d8']),
        pvLine(cp(939), ['d3c4', 'b5c4', 'd1d4', 'a7c6', 'd4h8', 'h7h5'], 2),
        pvLine(cp(842), ['d6d7', 'g8f6', 'd8f6', 'f7f6', 'd3b5', 'a7b5'], 3),
      ],
      [0.99, 0.99],
    );
    expect(e.headline).toBe('Bxg2 wins back a rook.');
  });

  it('a line that goes on is not settled early: its next move is not a capture', () => {
    // Re8+ Be7 gxf5 Qd4 Nc6 Qf6+ Kg8 f3 b4 then Qg5+, not Qxf5: the bishop won stays a bishop.
    const fen = '7r/n4k1p/3P1Bp1/1p3B2/p7/P1p3P1/P1P1KPbP/R2Q4 b - - 0 25';
    const pv = ['h8e8', 'f6e7', 'g6f5', 'd1d4', 'a7c6', 'd4f6', 'f7g8', 'f2f3', 'b5b4', 'f6g5', 'g8f7'];
    expect(materialOutcome(fen, pv, 'b')).toMatchObject({ net: 3, won: { b: 1 }, lost: {}, settled: true });
  });
});
