/**
 * Coaching explanations against real Stockfish 19 lines (depth 16, MultiPV 3) captured once into
 * tests/fixtures/explain-*.json, so this suite is deterministic and engine-free.
 */
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult, Score } from '../../src/engine/types';
import type { Classification, Explanation, MoveClass } from '../../src/analysis/types';
import { describeThreat, explainBestMove, explainMove, type ExplainMoveInput } from '../../src/analysis/explain';
import { parseUci } from '../../src/chess/utils';

interface Fixture {
  analyses: Record<string, AnalysisResult>;
  games?: { name: string; moves: string }[];
}
const load = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as Fixture;
const SCEN = load('explain-scenarios.json');
const GAMES = load('explain-games.json');

const key = (fen: string) => new Chess(fen).fen().split(' ').slice(0, 4).join(' ');
function analysis(fen: string, fx: Fixture = SCEN): AnalysisResult {
  const a = fx.analyses[key(fen)];
  if (!a) throw new Error(`no fixture analysis for ${fen}`);
  return a;
}
const fenOf = (sans: string) => {
  const c = new Chess();
  for (const s of sans.split(' ').filter(Boolean)) c.move(s);
  return c.fen();
};
function play(fen: string, san: string) {
  const c = new Chess(fen);
  const m = c.move(san);
  return { uci: m.from + m.to + (m.promotion ?? ''), after: c.fen(), move: m };
}

// Test-harness classification (chess.com expected-points thresholds). The real one lives in
// analysis/classify.ts; a local copy keeps these expectations independent of its tuning.
const win = (s: Score) => (s.kind === 'cp' ? 1 / (1 + Math.exp(-0.00368208 * s.value)) : s.value > 0 ? 1 : 0);
const toMover = (s: Score): Score =>
  s.kind === 'cp' ? { kind: 'cp', value: -s.value } : { kind: 'mate', value: s.value <= 0 ? -s.value + 1 : -s.value };
function classify(
  fen: string,
  uci: string,
  before: AnalysisResult,
  after?: AnalysisResult,
  cls?: MoveClass,
): Classification {
  const best = before.lines[0];
  const wb = best ? win(best.score) : 0.5;
  let wa = wb;
  if (after?.terminal === 'checkmate') wa = 1;
  else if (after?.terminal === 'stalemate') wa = 0.5;
  else if (after?.lines[0] && best?.pv[0] !== uci) wa = win(toMover(after.lines[0].score));
  const loss = Math.max(0, wb - wa);
  const byLoss: MoveClass =
    loss < 0.02 ? 'excellent' : loss < 0.05 ? 'good' : loss < 0.1 ? 'inaccuracy' : loss < 0.2 ? 'mistake' : 'blunder';
  const base: MoveClass = best?.pv[0] === uci ? 'best' : byLoss;
  const played = new Chess(fen).move(parseUci(uci)).san;
  const bestSan = best ? new Chess(fen).move(parseUci(best.pv[0])).san : null;
  return {
    cls: cls ?? base,
    winBefore: wb,
    winAfter: wa,
    winLoss: loss,
    accuracy: 100,
    bestMoveUci: best?.pv[0] ?? null,
    bestMoveSan: bestSan,
    playedMoveSan: played,
  };
}

/** explainMove for `san` played in `fen`, with fixture analyses before and after. */
function explain(fen: string, san: string, extra: Partial<ExplainMoveInput> & { cls?: MoveClass } = {}): Explanation {
  const { uci, after } = play(fen, san);
  const before = analysis(fen);
  const afterA = analysis(after);
  const { cls, ...rest } = extra;
  const classification = classify(fen, uci, before, afterA, cls);
  return explainMove({ fenBefore: fen, moveUci: uci, classification, before, after: afterA, ...rest });
}
const hint = (fen: string, opts?: Parameters<typeof explainBestMove>[2]) =>
  explainBestMove(fen, analysis(fen).lines[0], opts);
const text = (e: Explanation) => [e.headline, ...e.details];

const LABELS = ['Brilliant', 'Great', 'Best', 'Excellent', 'Good', 'Book', 'Forced'];
LABELS.push('Inaccuracy', 'Mistake', 'Miss', 'Blunder');
/** Style rules every explanation must follow. */
function expectWellFormed(e: Explanation) {
  expect(e.headline.length).toBeGreaterThan(5);
  expect(e.details.length).toBeLessThanOrEqual(3);
  for (const s of text(e)) {
    expect(s).toMatch(/[.!]$/);
    expect(s).not.toMatch(/undefined|null|NaN|\[object|\s{2}/);
    // Starts with a capital letter, or with a move in SAN (pawn moves are lower case).
    expect(s).toMatch(/^([A-Z]|[a-h][1-8x])/);
  }
  // The UI shows the class label separately: the headline must not just repeat it.
  const repeats = (l: string) => e.headline === `${l}.` || new RegExp(`^${l}[: —-]`).test(e.headline);
  expect(LABELS.some(repeats)).toBe(false);
  for (const a of e.arrows ?? []) {
    expect(a.from).toMatch(/^[a-h][1-8]$/);
    expect(a.to).toMatch(/^[a-h][1-8]$/);
    expect(a.from).not.toBe(a.to);
    expect(['best', 'alt', 'threat', 'played']).toContain(a.brush);
  }
}

const S = {
  qxf7: 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4',
  scholar: fenOf('e4 e5 Qh5 Nc6 Bc4'),
  qg4: fenOf('e4 e5 Nc3 Nf6'),
  blackburne: fenOf('e4 e5 Nf3 Nc6 Bc4 Nd4'),
  royalFork: 'r3k3/ppp2ppp/8/1N6/8/8/PPP2PPP/4K3 w - - 0 1',
  pin: '4k3/pp4pp/3p4/4n3/8/5P2/PP4PP/4RK2 w - - 0 1',
  skewer: '8/8/2k3q1/8/8/8/8/R3K3 w - - 0 1',
  discovered: '3q4/8/7k/8/3N4/8/8/3RK3 w - - 0 1',
  backRank: 'r5k1/5ppp/8/8/8/1R6/5PPP/6K1 w - - 0 1',
  legal: fenOf('e4 e5 Nf3 d6 Bc4 Bg4 Nc3 Nc6 h3 Bh5'),
  legalBxd1: fenOf('e4 e5 Nf3 d6 Bc4 Bg4 Nc3 Nc6 h3 Bh5 Nxe5'),
  elephant: fenOf('d4 d5 c4 e6 Nc3 Nf6 Bg5 Nbd7 cxd5 exd5'),
  morphy: fenOf('e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6'),
  promotion: '8/P7/8/8/8/8/1k6/6K1 w - - 0 1',
  start: new Chess().fen(),
  castle: fenOf('e4 e5 Nf3 Nc6 Bc4 Bc5'),
  tradeAhead: '3qk3/8/8/8/8/8/5PPP/R2QK3 w - - 0 1',
  trapped: 'N1bk1bnr/p1p1pppp/1p6/7q/8/8/PPPPPPPP/R1BQKBNR b KQ - 0 1',
  stalemate: 'k7/8/1K6/8/8/8/8/2Q5 w - - 0 1',
  freeKnight: '4k3/8/8/3n4/8/8/3R4/4K3 w - - 0 1',
  lasker: fenOf('d4 e6 Nf3 f5 Nc3 Nf6 Bg5 Be7 Bxf6 Bxf6 e4 fxe4 Nxe4 b6 Ne5 O-O Bd3 Bb7 Qh5 Qe7'),
  queenFork: '4k3/8/8/8/5n2/8/3Q4/6K1 w - - 0 1',
  skewered: 'r3k3/8/8/8/3K4/8/8/2Q5 w - - 0 1',
  rook7: '2r3k1/pp3pp1/7p/8/8/8/PP3PPP/3R2K1 w - - 0 1',
  pawnEnding: '8/5k2/8/3P4/8/8/5K2/8 w - - 0 1',
};

describe('explainBestMove (hints)', () => {
  it.each([
    [S.qxf7, 'Qxf7# is checkmate.', []],
    [S.scholar, 'g6 stops the threat of mate with Qxf7#.', []],
    [S.royalFork, 'Nxc7+ wins a rook and a pawn.', ['It attacks the king and the rook on a8 at once (a fork).']],
    [S.pin, 'f4 wins a knight.', ['It attacks the knight on e5, which is pinned to the king.']],
    [S.skewer, 'Ra6+ wins the queen.', ['It skewers the king: once it moves, the queen on g6 behind it falls.']],
    [S.discovered, 'Nf5+ wins the queen.', ['It uncovers an attack by the rook on d1 on the queen on d8.']],
    [S.legal, 'Nxe5 wins a pawn.', ['It uncovers an attack by the queen on d1 on the bishop on h5.']],
    [S.legalBxd1, 'dxe5 takes the knight on e5, which was undefended.', []],
    [S.blackburne, 'Nxd4 trades knights.', []],
    [S.morphy, 'Qb3 wins a pawn.', ['It threatens both Qxb7 and Bxf7+ (a double attack).']],
    [S.promotion, 'a8=Q leads to a forced mate in 9.', ['It promotes the pawn to a queen.']],
    [S.start, 'e4 takes space in the centre and opens a diagonal for the bishop on f1.', []],
    [S.trapped, 'Bb7 wins back a knight.', ['It traps the knight on a8: every square it can go to loses it.']],
    [S.backRank, 'f3 gives the king an escape square.', []],
    [fenOf('e4 e5 Qh5 Nc6'), 'Bc4 threatens mate with Qxf7# and develops the bishop.', []],
    [S.queenFork, 'Qe3+ wins a knight.', ['It attacks the king and the knight on f4 at once (a fork).']],
    [S.pawnEnding, 'Ke3 brings the king towards the centre.', []],
  ] as [string, string, string[]][])('%s', (fen, headline, details) => {
    const e = hint(fen);
    expect(e.headline).toBe(headline);
    expect(e.details).toEqual(details);
    expectWellFormed(e);
  });

  it('draws the move and the tactic as arrows, and gives the line in SAN', () => {
    const e = hint(S.royalFork);
    expect(e.arrows).toEqual([
      { from: 'b5', to: 'c7', brush: 'best' },
      { from: 'c7', to: 'e8', brush: 'threat' },
      { from: 'c7', to: 'a8', brush: 'threat' },
    ]);
    expect(e.bestLineSan?.slice(0, 2)).toEqual(['Nxc7+', 'Kd8']);
    expect(e.title).toBe('Fork');
    expect(e.motifs).toEqual(['winsMaterial', 'fork']);
  });

  it('explains a forced mate with its finish, and the defence against one', () => {
    const e = hint(fenOf('e4 e5 Nf3 d6 Bc4 Bg4 Nc3 Nc6 h3 Bh5 Nxe5 Bxd1'));
    expect(text(e)).toEqual(['Bxf7+ starts a forced mate in 2.', 'The finish: Bxf7+ Ke7 Nd5#.']);
    const only = hint(fenOf('e4 e5 Nf3 d6 Bc4 Bg4 Nc3 Nc6 h3 Bh5 Nxe5 Bxd1 Bxf7+'));
    expect(text(only)).toEqual(['Ke7 is the only legal move.', 'White mates next move.']);
  });

  it('says "saves" for a defensive move, in both perspectives', () => {
    const fen = fenOf('e4 e5 Qh5');
    expect(hint(fen).headline).toBe('d6 saves your pawn on e5 from Qxe5+.');
    expect(hint(fen, { perspective: 'neutral' }).headline).toBe("d6 saves Black's pawn on e5 from Qxe5+.");
  });

  it('calls a capture on the previous move square a recapture', () => {
    const fen = S.legalBxd1;
    expect(hint(fen, { prevMove: { to: 'e5', captured: 'p' } }).headline).toBe('dxe5 recaptures the knight.');
  });

  it('never throws on an empty or illegal line', () => {
    expect(explainBestMove(S.start, { multipv: 1, depth: 0, score: { kind: 'cp', value: 0 }, pv: [] }).headline).toBe(
      'There is no move to suggest here.',
    );
    const line = (pv: string[]) => ({ multipv: 1, depth: 1, score: { kind: 'cp', value: 0 } as const, pv });
    expect(explainBestMove(S.start, line(['e2e5'])).details).toEqual([]);
    expect(() => explainBestMove('not a fen', line(['e2e4']))).not.toThrow();
  });
});

describe('describeThreat', () => {
  it('names mate threats', () => {
    const e = describeThreat(S.scholar)!;
    expect(e.headline).toBe('White threatens Qxf7#, checkmate.');
    expect(e.arrows).toEqual([{ from: 'h5', to: 'f7', brush: 'threat' }]);
    expect(e.title).toBe('Mate threat');
  });

  it('names material threats, with a second one as a detail', () => {
    const fen = fenOf('e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5');
    const e = describeThreat(fen)!;
    expect(e.headline).toBe('Black threatens Qxe5, winning your knight on e5.');
    expect(e.details).toEqual(['Black also threatens Qxg2.']);
    const neutral = describeThreat(fen, { perspective: 'neutral' })!;
    expect(neutral.headline).toBe('Black threatens Qxe5, winning the knight on e5.');
  });

  it('names a plain promotion push', () => {
    const e = describeThreat('8/8/8/8/8/8/p7/4K2k w - - 0 1')!;
    expect(e.headline).toBe('Black threatens a1=Q+, making a new queen.');
  });

  it('returns null when there is nothing (or when in check)', () => {
    expect(describeThreat(S.start)).toBeNull();
    expect(describeThreat('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3')).toBeNull();
    expect(describeThreat('garbage')).toBeNull();
  });
});

describe('explainMove: mistakes and blunders', () => {
  it('missed mate', () => {
    const e = explain(S.qxf7, 'd3');
    expect(text(e)).toEqual(['You missed Qxf7#, which was checkmate.']);
    expect(e.arrows).toEqual([{ from: 'h5', to: 'f7', brush: 'best' }]);
    expect(e.title).toBe('Missed mate');
  });

  it('allowed mate in one', () => {
    const e = explain(S.scholar, 'Nf6');
    expect(text(e)).toEqual([
      'This allows Qxf7#, checkmate.',
      'g6 was needed: it stops the threat of mate with Qxf7#.',
    ]);
    expect(e.arrows).toEqual([
      { from: 'h5', to: 'f7', brush: 'threat' },
      { from: 'g7', to: 'g6', brush: 'best' },
    ]);
  });

  it('allowed back-rank mate', () => {
    expect(text(explain(S.backRank, 'Rb7'))).toEqual([
      'This allows a forced mate in 2.',
      'Black mates with Ra1+ Rb1 Rxb1#.',
      "It's a back-rank mate: your king has no escape square.",
      'f3 was needed: it gives the king an escape square.',
    ]);
    expect(explain(S.backRank, 'Rb7').motifs).toEqual(['allowsMate', 'backRank']);
  });

  it('greedy capture that allows mate (Legal trap)', () => {
    expect(text(explain(S.legalBxd1, 'Bxd1'))).toEqual([
      'Bxd1 wins the queen, but it allows a forced mate in 2.',
      'White mates with Bxf7+ Ke7 Nd5#.',
      'dxe5 was needed: it takes the knight on e5, which was undefended.',
    ]);
  });

  it('hanging queen', () => {
    const e = explain(S.qg4, 'Qg4');
    expect(text(e)).toEqual([
      'This hangs your queen on g4.',
      'Black plays Nxg4 and wins the queen.',
      'Best was Nf3, which develops the knight and fights for the centre.',
    ]);
    expect(e.arrows).toEqual([
      { from: 'f6', to: 'g4', brush: 'threat' },
      { from: 'g1', to: 'f3', brush: 'best' },
    ]);
    expect(e.title).toBe('Hanging piece');
  });

  it('capture that walks into a fork (Blackburne Shilling)', () => {
    expect(text(explain(S.blackburne, 'Nxe5'))).toEqual([
      'Nxe5 grabs a pawn, but it loses a knight to a fork.',
      'Black answers Qg5, which attacks your knight on e5 and your pawn on g2 at once (a fork).',
      'Best was Nxd4, which trades knights.',
    ]);
  });

  it('capture that walks into a discovered attack (Elephant trap)', () => {
    expect(text(explain(S.elephant, 'Nxd5'))).toEqual([
      'Nxd5 grabs a pawn, but it loses a knight to a discovered attack.',
      'Black answers Nxd5, which uncovers an attack by the queen on d8 on your bishop on g5.',
      'Best was e3, which opens a diagonal for the bishop on f1.',
    ]);
  });

  it('walking into a fork and a skewer', () => {
    expect(text(explain(S.queenFork, 'Qc3'))).toEqual([
      'This loses the queen to a fork.',
      'Black answers Ne2+, which attacks your king and your queen on c3 at once (a fork).',
      'Best was Qe3+, which wins a knight.',
    ]);
    expect(text(explain(S.skewered, 'Kc4'))).toEqual([
      'This loses the queen to a skewer.',
      'Black answers Rc8+, which skewers your king: once it moves, your queen on c1 behind it falls.',
      'Best was Qc6+, which wins a rook.',
    ]);
  });

  it('missed tactics', () => {
    expect(text(explain(S.royalFork, 'Kd2'))).toEqual([
      'You missed Nxc7+, which wins a rook and a pawn.',
      'It attacks the king and the rook on a8 at once (a fork).',
    ]);
    const morphy = explain(S.morphy, 'O-O');
    expect(text(morphy)).toEqual([
      'You missed Qb3, which wins a pawn.',
      'It threatens both Qxb7 and Bxf7+ (a double attack).',
    ]);
    expect(morphy.arrows?.[0]).toEqual({ from: 'f3', to: 'b3', brush: 'best' });
    const miss = explain(S.freeKnight, 'Ke2', { cls: 'miss' });
    expect(text(miss)).toEqual([
      'You missed Rxd5, which wins a knight.',
      'It takes the knight on d5, which was undefended.',
    ]);
    expect(miss.title).toBe('Missed win');
  });

  it('opening principles broken', () => {
    expect(explain(S.start, 'f3').headline).toBe("f3 weakens the king's position.");
    expect(explain(S.start, 'h4').headline).toBe("h4 is an edge-pawn move that doesn't help development.");
    expect(explain(S.start, 'Na3').headline).toBe('Na3 puts the knight on the edge, where it controls fewer squares.');
    expect(text(explain(fenOf('e4 e5'), 'Qh5'))).toEqual([
      'Qh5 brings the queen out early, where enemy pieces can chase it.',
      "Black can answer d6, which saves Black's pawn on e5 from Qxe5+.",
      'Best was Nf3, which develops the knight and fights for the centre.',
    ]);
    expect(explain(fenOf('f3 e5'), 'g4').headline).toBe('This allows Qh4#, checkmate.');
  });

  it('stalemate when winning', () => {
    const e = explain(S.stalemate, 'Qc7');
    expect(text(e)).toEqual([
      'This is stalemate, so the game ends in a draw.',
      'Black has no legal moves but is not in check.',
      'Best was Qc8#, which is checkmate.',
    ]);
    expect(e.title).toBe('Stalemate');
  });

  it('neutral perspective (reviewing the opponent)', () => {
    const e = explain(S.qg4, 'Qg4', { perspective: 'neutral' });
    expect(e.headline).toBe("This hangs White's queen on g4.");
    expect(explain(S.qxf7, 'd3', { perspective: 'neutral' }).headline).toBe('White missed Qxf7#, which was checkmate.');
    expect(explain(S.blackburne, 'Nxe5', { perspective: 'neutral' }).details[0]).toBe(
      "Black answers Qg5, which attacks White's knight on e5 and White's pawn on g2 at once (a fork).",
    );
  });
});

describe('explainMove: good moves', () => {
  it('praises with the reason', () => {
    expect(text(explain(S.start, 'e4'))).toEqual([
      'e4 takes space in the centre and opens a diagonal for the bishop on f1.',
    ]);
    expect(text(explain(S.castle, 'O-O'))).toEqual(['O-O castles the king to safety and brings the rook into play.']);
    expect(text(explain(S.scholar, 'g6'))).toEqual(['g6 stops the threat of mate with Qxf7#.']);
    expect(text(explain(S.legal, 'Nxe5'))).toEqual([
      'Nxe5 wins a pawn.',
      'It uncovers an attack by the queen on d1 on the bishop on h5.',
    ]);
    expect(text(explain(S.pawnEnding, 'd6'))).toEqual(['d6 pushes a passed pawn towards promotion.']);
    expect(text(explain(S.backRank, 'h3'))).toEqual(['h3 gives the king an escape square.']);
  });

  it('mentions the better move for a merely good one', () => {
    expect(text(explain(S.tradeAhead, 'Qxd8+'))).toEqual([
      'Qxd8+ trades pieces while ahead, which makes the extra material count more.',
      'Qh5+ was slightly more accurate.',
    ]);
  });

  it('checkmate, from the board or from after.terminal', () => {
    const { uci } = play(S.stalemate, 'Qc8#');
    const before = analysis(S.stalemate);
    const after: AnalysisResult = { fen: 'x', depth: 0, lines: [], bestMove: null, done: true, terminal: 'checkmate' };
    const classification = classify(S.stalemate, uci, before, after);
    const e = explainMove({ fenBefore: S.stalemate, moveUci: uci, classification, before, after });
    expect(text(e)).toEqual([
      "Qc8# is checkmate — well played!",
      "It's a back-rank mate: the king has no escape square.",
    ]);
    const n = explainMove({ fenBefore: S.stalemate, moveUci: uci, classification, before, perspective: 'neutral' });
    expect(n.headline).toBe('Qc8# is checkmate.');
  });

  it('only moves and hopeless defences', () => {
    const fen = fenOf('e4 e5 Nf3 d6 Bc4 Bg4 Nc3 Nc6 h3 Bh5 Nxe5 Bxd1 Bxf7+');
    expect(text(explain(fen, 'Ke7', { cls: 'forced' }))).toEqual([
      "Ke7 is forced: it's the only legal move.",
      'White mates next move.',
    ]);
  });

  it('explains a brilliant sacrifice that is accepted', () => {
    const e = explain(S.lasker, 'Qxh7+', { cls: 'brilliant' });
    expect(text(e)).toEqual([
      'Qxh7+ leads to a forced mate in 7.',
      'The queen sacrifice pays off: Kxh7 Nxf6+ Kh6 Neg4+.',
    ]);
  });

  it('explains a sacrifice that cannot be taken (Legal trap)', () => {
    const e = explain(S.legal, 'Nxe5', { cls: 'brilliant' });
    expect(e.details).toContain('If Black takes with Bxd1, Bxf7+ Ke7 Nd5# is checkmate.');
  });

  it('notes when a great move was the only good one', () => {
    const e = explain(S.royalFork, 'Nxc7+', { cls: 'great' });
    expect(e.details).toContain('It was the only good move here.');
  });
});

describe('explainMove: robustness', () => {
  it('works without the after-analysis (uses the matching MultiPV line)', () => {
    const fen = S.start;
    const before = analysis(fen);
    const uci = before.lines[1].pv[0]; // d2d4
    const classification = classify(fen, uci, before, undefined, 'excellent');
    const e = explainMove({ fenBefore: fen, moveUci: uci, classification, before });
    expect(e.headline).toBe('d4 takes space in the centre and opens a diagonal for the bishop on c1.');
  });

  it('works with no engine lines at all', () => {
    const fen = S.qg4;
    const { uci } = play(fen, 'Qg4');
    const cl: Classification = { ...classify(fen, uci, analysis(fen)), cls: 'blunder', bestMoveUci: 'g1f3' };
    const empty: AnalysisResult = { fen, depth: 0, lines: [], bestMove: null, done: false };
    const e = explainMove({ fenBefore: fen, moveUci: uci, classification: cl, before: empty });
    expectWellFormed(e);
    expect(e.details.at(-1)).toBe('Best was Nf3, which develops the knight and fights for the centre.');
  });

  it('falls back instead of throwing on bad input', () => {
    const cl: Classification = {
      cls: 'mistake',
      winBefore: 0.5,
      winAfter: 0.3,
      winLoss: 0.2,
      accuracy: 50,
      bestMoveUci: 'e2e4',
      bestMoveSan: 'e4',
      playedMoveSan: 'a3',
    };
    const empty: AnalysisResult = { fen: '', depth: 0, lines: [], bestMove: null, done: true };
    const illegal = explainMove({ fenBefore: S.start, moveUci: 'e2e5', classification: cl, before: empty });
    expect(text(illegal)).toEqual(['There was a better move than a3.', 'Best was e4.']);
    const garbage = () => explainMove({ fenBefore: 'garbage', moveUci: 'e2e4', classification: cl, before: empty });
    expect(garbage).not.toThrow();
  });
});

describe('whole games (engine lines at depth 16)', () => {
  const games = GAMES.games ?? [];

  it('explains every move without throwing, in well-formed text, quickly', () => {
    let n = 0;
    let total = 0;
    let slowest = 0;
    for (const g of games) {
      const c = new Chess();
      let prevMove: { to: string; captured?: string } | undefined;
      for (const san of g.moves.split(' ')) {
        const fen = c.fen();
        const m = c.move(san);
        const uci = m.from + m.to + (m.promotion ?? '');
        const before = analysis(fen, GAMES);
        const after = analysis(c.fen(), GAMES);
        const classification = classify(fen, uci, before, after);
        for (const perspective of ['you', 'neutral'] as const) {
          const t0 = performance.now();
          const e = explainMove({ fenBefore: fen, moveUci: uci, classification, before, after, prevMove, perspective });
          const dt = performance.now() - t0;
          total += dt;
          slowest = Math.max(slowest, dt);
          n++;
          expectWellFormed(e);
          if (perspective === 'neutral') expect(text(e).join(' ')).not.toMatch(/\b[Yy]our?\b/);
        }
        if (!c.isGameOver()) {
          expectWellFormed(explainBestMove(c.fen(), after.lines[0]));
          const t = describeThreat(c.fen());
          if (t) expectWellFormed(t);
        }
        prevMove = { to: m.to, captured: m.captured };
      }
    }
    expect(n).toBeGreaterThan(250);
    expect(total / n).toBeLessThan(30);
    expect(slowest).toBeLessThan(250);
  });

  it('tells the story of the Opera game', () => {
    const moves = games.find((g) => g.name === 'Opera game')!.moves.split(' ');
    const c = new Chess();
    const out: Record<string, string[]> = {};
    let prevMove: { to: string; captured?: string } | undefined;
    for (const [i, san] of moves.entries()) {
      const fen = c.fen();
      const m = c.move(san);
      const uci = m.from + m.to + (m.promotion ?? '');
      const before = analysis(fen, GAMES);
      const after = analysis(c.fen(), GAMES);
      const classification = classify(fen, uci, before, after);
      out[`${Math.floor(i / 2) + 1}${i % 2 ? '...' : '.'}${san}`] = text(
        explainMove({ fenBefore: fen, moveUci: uci, classification, before, after, prevMove }),
      );
      prevMove = { to: m.to, captured: m.captured };
    }
    expect(out['5.Qxf3']).toEqual(['Qxf3 recaptures the bishop.']);
    expect(out['6.Bc4']).toEqual(['Bc4 threatens mate with Qxf7# and develops the bishop.']);
    expect(out['7.Qb3']).toEqual(['Qb3 wins a pawn.', 'It threatens both Qxb7 and Bxf7+ (a double attack).']);
    expect(out['9.Bg5']).toEqual(['Bg5 pins the knight on f6 to the queen and develops the bishop.']);
    expect(out['11...Nbd7']).toEqual(['Nbd7 blocks the check.']);
    expect(out['12.O-O-O']).toEqual([
      'O-O-O wins a knight.',
      'It attacks the knight on d7, which is pinned to the king.',
    ]);
    expect(out['14.Rd1']).toEqual([
      'Rd1 wins the queen for a bishop.',
      'It attacks the rook on d7, which is pinned to the king.',
    ]);
    expect(out['16.Qb8+']).toEqual(['Qb8+ starts a forced mate in 2.', 'The finish: Qb8+ Nxb8 Rd8#.']);
    expect(out['16...Nxb8']).toEqual(["Nxb8 is forced: it's the only legal move.", 'White mates next move.']);
    expect(out['17.Rd8#']).toEqual([
      'Rd8# is checkmate — well played!',
      "It's a back-rank mate: the king has no escape square.",
    ]);
  });
});
