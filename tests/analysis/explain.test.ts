/**
 * Coaching explanations against real Stockfish 19 lines (depth 16, MultiPV 3) captured once into
 * tests/fixtures/explain-*.json, so this suite is deterministic and engine-free.
 */
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { AnalysisResult, Score } from '../../src/engine/types';
import type { Classification, Explanation, MoveClass } from '../../src/analysis/types';
import { describeMaterial, describeThreat, explainBestMove, explainMove, type ExplainMoveInput } from '../../src/analysis/explain';
import { materialOutcome, moveMotifs, principles, stoppedThreat } from '../../src/analysis/motifs';
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
    // American spelling for an American user.
    expect(s).not.toMatch(/centre|towards|defence/i);
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
    [S.start, 'e4 takes space in the center and opens a diagonal for the bishop on f1.', []],
    [S.trapped, 'Bb7 wins back a knight.', ['It traps the knight on a8: every square it can go to loses it.']],
    [S.backRank, 'f3 gives the king an escape square.', []],
    [fenOf('e4 e5 Qh5 Nc6'), 'Bc4 threatens mate with Qxf7# and develops the bishop.', []],
    [S.queenFork, 'Qe3+ wins a knight.', ['It attacks the king and the knight on f4 at once (a fork).']],
    [S.pawnEnding, 'Ke3 brings the king toward the center.', []],
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
      'Best was Nf3, which develops the knight and fights for the center.',
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
      'Best was Nf3, which develops the knight and fights for the center.',
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
      'e4 takes space in the center and opens a diagonal for the bishop on f1.',
    ]);
    expect(text(explain(S.castle, 'O-O'))).toEqual(['O-O castles the king to safety and brings the rook into play.']);
    expect(text(explain(S.scholar, 'g6'))).toEqual(['g6 stops the threat of mate with Qxf7#.']);
    expect(text(explain(S.legal, 'Nxe5'))).toEqual([
      'Nxe5 wins a pawn.',
      'It uncovers an attack by the queen on d1 on the bishop on h5.',
    ]);
    expect(text(explain(S.pawnEnding, 'd6'))).toEqual(['d6 pushes a passed pawn toward promotion.']);
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
    expect(e.headline).toBe('d4 takes space in the center and opens a diagonal for the bishop on c1.');
  });

  it('works with no engine lines at all', () => {
    const fen = S.qg4;
    const { uci } = play(fen, 'Qg4');
    const cl: Classification = { ...classify(fen, uci, analysis(fen)), cls: 'blunder', bestMoveUci: 'g1f3' };
    const empty: AnalysisResult = { fen, depth: 0, lines: [], bestMove: null, done: false };
    const e = explainMove({ fenBefore: fen, moveUci: uci, classification: cl, before: empty });
    expectWellFormed(e);
    expect(e.details.at(-1)).toBe('Best was Nf3, which develops the knight and fights for the center.');
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

// ------------------------------------------------------------------ regression cases (hand-made PVs)

const cp = (value: number): Score => ({ kind: 'cp', value });
const pvLine = (score: Score, pv: string[], multipv = 1) => ({ multipv, depth: 16, score, pv });
const result = (fen: string, lines: ReturnType<typeof pvLine>[]): AnalysisResult => ({
  fen,
  depth: 16,
  lines,
  bestMove: lines[0]?.pv[0] ?? null,
  done: true,
});
const hintOf = (fen: string, score: Score, pv: string[], opts?: Parameters<typeof explainBestMove>[2]) =>
  explainBestMove(fen, pvLine(score, pv), opts);
/** explainMove with hand-made engine lines and a given class and expected scores. */
function explainWith(
  fen: string,
  uci: string,
  cls: MoveClass,
  before: ReturnType<typeof pvLine>[],
  after: ReturnType<typeof pvLine>[],
  win: [number, number],
  extra: Partial<ExplainMoveInput> = {},
): Explanation {
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
  const e = explainMove({
    fenBefore: fen,
    moveUci: uci,
    classification,
    before: result(fen, before),
    after: result(c.fen(), after),
    ...extra,
  });
  expectWellFormed(e);
  return e;
}

const FRIED_LIVER = 'r1bqkb1r/ppp2ppp/2n5/3np1N1/2B5/8/PPPP1PPP/RNBQK2R w KQkq - 0 6';

describe('"saves" is only said for a real defence', () => {
  it('a sacrifice is not a save (Fried Liver Nxf7)', () => {
    const e = hintOf(FRIED_LIVER, cp(136), ['g5f7', 'e8f7', 'd1f3', 'f7e6', 'b1c3']);
    expect(e.headline).toBe('Nxf7 sacrifices a knight for a pawn.');
    const brilliant = explainWith(
      FRIED_LIVER,
      'g5f7',
      'brilliant',
      [pvLine(cp(136), ['g5f7', 'e8f7', 'd1f3', 'f7e6', 'b1c3']), pvLine(cp(67), ['d2d4', 'c6d4'], 2)],
      [pvLine(cp(-136), ['e8f7', 'd1f3', 'f7e6', 'b1c3'])],
      [0.62, 0.62],
    );
    expect(text(brilliant)).toEqual([
      'Nxf7 sacrifices a knight for a pawn.',
      'The knight sacrifice pays off: Kxf7 Qf3+ Ke6 Nc3.',
    ]);
  });

  it('a pawn move that brings a defender still saves the piece', () => {
    expect(hintOf(FRIED_LIVER, cp(67), ['d2d4', 'c6d4', 'c2c3']).headline).toBe('d4 saves your knight on g5 from Qxg5.');
  });

  it('a trade is a trade, and a piece moved into a capture is not saved', () => {
    const rooks = hintOf('8/8/3r1ppk/4p2p/2K1P3/3R4/8/8 b - - 0 1', cp(707), ['d6d3', 'c4d3', 'h5h4', 'd3c4']);
    expect(rooks.headline).toMatch(/^Rxd3 trades /);
    expect(stoppedThreat('3k4/8/6p1/2R3b1/P3P1K1/6PN/P6P/7R b - - 0 1', 'g5h4')).toBeNull();
    expect(stoppedThreat('3k4/8/6p1/2R3b1/P3P1K1/6PN/P6P/7R b - - 0 1', 'g5h6')?.san).toBe('Rxg5');
    const nxc6 = 'rnbqkb1r/2pn1pp1/1pBp4/p2Pp3/4P2p/2N1B3/PPP2PPP/R1Q1K1NR b KQkq - 0 1';
    expect(stoppedThreat(nxc6, 'b8c6')).toBeNull();
  });

  it('does not claim a save while a bigger threat is left (Blackburne Shilling)', () => {
    const fen = 'r1b1kbnr/pppp1Npp/8/8/2BnP3/8/PPPP1PqP/RNBQK2R w KQkq - 0 1';
    expect(stoppedThreat(fen, 'd2d3')).toBeNull();
    expect(hintOf(fen, cp(-586), ['d2d3', 'd7d5', 'c4b5', 'e8f7', 'd1h5']).headline).not.toMatch(/saves/);
  });
});

describe('promotions in material lines', () => {
  it("counts the opponent's new queen, not a pawn won", () => {
    const fen = '4r3/1P1k4/8/8/8/8/8/K7 b - - 0 1';
    const out = materialOutcome(fen, ['d7c6', 'b7b8q'], 'b');
    expect(out).toMatchObject({ net: -8, won: {}, lost: {}, theirPromoted: ['q'] });
    expect(describeMaterial(out, 'White')).toBe('lets White make a new queen');
    expect(hintOf(fen, cp(-517), ['d7c6', 'b7b8q']).headline).not.toMatch(/wins/);
    expect(hintOf('8/1P6/8/8/8/8/6k1/K7 b - - 0 1', cp(-598), ['g2f3', 'b7b8q', 'f3e4']).headline).not.toMatch(/wins/);
  });

  it('counts an underpromotion as the piece it makes', () => {
    const fen = '8/5P1k/8/8/8/8/8/5K2 w - - 0 1';
    const say = (u: string) => {
      const o = materialOutcome(fen, [u, 'h7g7', 'f1g2'], 'w');
      return `${o.net} ${describeMaterial(o)}`;
    };
    expect([say('f7f8q'), say('f7f8r'), say('f7f8n'), say('f7f8b')]).toEqual([
      '8 promotes to a queen',
      '4 promotes to a rook',
      '2 promotes to a knight',
      '2 promotes to a bishop',
    ]);
    const fork = materialOutcome('8/2k1P1q1/8/8/8/7K/8/8 w - - 0 1', ['e7e8n', 'c7d7', 'e8g7'], 'w');
    expect(describeMaterial(fork)).toBe('wins the queen and promotes to a knight');
    // A new queen taken at once is a pawn lost, not a queen.
    const taken = (pov: 'w' | 'b') => describeMaterial(materialOutcome('r3k3/1P6/8/8/8/8/8/4K3 w - - 0 1', ['b7b8q', 'a8b8', 'e1e2'], pov));
    expect([taken('w'), taken('b')]).toEqual(['loses a pawn', 'wins a pawn']);
  });

  it('explains an underpromotion that throws away the win', () => {
    const fen = '8/5P1k/8/8/8/8/8/5K2 w - - 0 1';
    const e = explainWith(
      fen,
      'f7f8n',
      'blunder',
      [pvLine(cp(844), ['f7f8q', 'h7g6']), pvLine(cp(479), ['f7f8r', 'h7g7'], 2), pvLine(cp(13), ['f7f8n', 'h7g7'], 3)],
      [pvLine(cp(-13), ['h7g7', 'f8e6', 'g7f7'])],
      [0.96, 0.51],
    );
    expect(e.headline).toBe('f8=N+ promotes to a knight instead of a queen.');
    expect(text(e).join(' ')).not.toMatch(/loses material/);
  });

  it('says when a new queen is taken at once, or when the promotion comes later in the line', () => {
    const taken = hintOf('4r2k/1P4pp/8/8/8/7P/5PP1/6K1 w - - 0 1', cp(-679), ['b7b8q', 'e8b8', 'f2f4']);
    expect(taken.headline).toBe('b8=Q promotes, but the new queen is taken at once.');
    const later = hintOf('7k/8/1P6/8/8/8/8/K7 w - - 0 1', cp(900), ['b6b7', 'h8g7', 'b7b8q', 'g7f7']);
    expect(later.headline).toBe('b7 lets your pawn promote with b8=Q.');
  });

  it('does not call a pawn on the last rank a passed pawn', () => {
    expect(principles('4r2k/1P4pp/8/8/8/7P/5PP1/6K1 w - - 0 1', 'b7b8q').map((p) => p.kind)).not.toContain('passedPawn');
  });
});

describe('gambit lines', () => {
  it('a quiet move does not "win" the pawn the opponent gives up for play', () => {
    const twoKnights = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    expect(hintOf(twoKnights, cp(4), ['f3g5', 'd7d5', 'e4d5', 'c6a5', 'c4b5', 'c7c6']).headline).not.toMatch(/wins/);
    const petrov = 'rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    expect(hintOf(petrov, cp(-53), ['d1e2', 'f8c5', 'f3e5', 'e8g8']).headline).not.toMatch(/wins/);
    const qf6 = 'rnb1kbnr/pppp1ppp/8/4p3/4P2q/3P1N2/PPP2PPP/RNBQKB1R b KQkq - 0 3';
    expect(hintOf(qf6, cp(-112), ['h4f6', 'd3d4', 'e5d4', 'c2c3', 'd4c3', 'b1c3']).headline).toBe(
      'Qf6 saves your queen on h4 from Nxh4.',
    );
  });
});

describe('tactics that are not real', () => {
  const kinds = (fen: string, uci: string) => moveMotifs(fen, uci)!.motifs.map((m) => m.kind);

  it('no pin when the pinned piece (or anything) simply takes the pinner', () => {
    expect(kinds('2k1rb1r/pp6/3p2p1/4n1N1/2PN1Rn1/2K1P1P1/PP1B2q1/8 w - - 1 29', 'f4f8')).not.toContain('pin');
    expect(kinds('rnbqk2r/ppppb1pp/4pn2/5pB1/3P4/2N2N2/PPP1PPPP/R2QKB1R w KQkq - 4 5', 'g5f6')).not.toContain('pin');
    expect(kinds('r2q1rk1/ppp2ppp/2n5/1B6/4Pbb1/2N2N2/PPP2PPP/R2Q1RK1 b - - 1 12', 'd8d1')).not.toContain('pin');
  });

  it("says (it can't move) only when the pinned piece really cannot", () => {
    expect(hintOf('4k3/4n3/8/8/8/8/8/R4K2 w - - 0 1', cp(50), ['a1e1']).headline).toMatch(/pins the knight on e7 to the king \(it can't move\)/);
    const rook = hintOf('4k3/4r3/8/8/8/8/8/R4K2 w - - 0 1', cp(0), ['a1e1']).headline;
    expect(rook).toMatch(/pins the rook on e7 to the king/);
    expect(rook).not.toMatch(/can't move/);
  });

  it('keeps a pin when the pinned piece cannot take the pinner because of check', () => {
    // Nf3+: White must answer the check, so Bxa5 is not possible and the bishop on d2 stays pinned.
    const fen = 'r3kb1r/pp2pppp/3p1n2/qN2n3/4P3/N5P1/PPPB1P1P/R3KB1R b KQkq - 2 10';
    expect(moveMotifs(fen, 'e5f3')!.motifs).toContainEqual(expect.objectContaining({ kind: 'pin', exploit: true }));
  });

  it('no fork when a block or king move saves everything', () => {
    expect(kinds('r4r2/2k4P/1p2p3/p5bP/3p1p2/8/P7/1n2RK2 w - - 20 55', 'e1c1')).not.toContain('fork');
    expect(kinds('r2qk2r/pbpp1pp1/np5p/7Q/2PPP3/N3B3/PP3PPP/R3KB1R w KQkq - 1 12', 'h5e5')).not.toContain('fork');
    // Real checking forks stay.
    expect(kinds('r3k3/ppp2ppp/8/1N6/8/8/PPP2PPP/4K3 w - - 0 1', 'b5c7')).toContain('fork');
    expect(kinds('4k3/8/8/8/5n2/8/3Q4/6K1 w - - 0 1', 'd2e3')).toContain('fork');
  });

  it('no double attack by a piece that is simply lost, but a trade with tempo keeps it', () => {
    expect(kinds('r2q1rk1/pbpp1pp1/np5p/5Q2/2PPP3/N3B3/PP2BPPP/R3K2R b KQ - 4 13', 'b7e4')).not.toContain('doubleThreat');
    expect(kinds(fenOf('e4 e5 Nf3 d6 d4 Bg4 dxe5'), 'g4f3')).toContain('doubleThreat');
  });

  it('only reports pieces the move traps', () => {
    expect(kinds('r2qk2r/1b3ppp/p3pn2/1p6/1bP4P/3PPNP1/1B1RBP2/1N1QK2R b Kkq - 1 18', 'e8g8')).not.toContain('trapped');
  });
});

describe('fewer vague "improves the position" texts', () => {
  it('a check that sets up a threat says what follows (Greek gift Ng5+)', () => {
    const fen = 'rnbq1r2/pppn1ppk/4p3/3pP3/1b1P4/2N2N2/PPP2PPP/R1BQK2R w KQ - 0 8';
    const e = hintOf(fen, cp(550), ['f3g5', 'h7g8', 'd1h5', 'd8g5', 'c1g5', 'f7f6']);
    expect(text(e)).toEqual([
      'Ng5+ gives check, and then Qh5 wins the queen for a knight.',
      'It threatens mate with Qh7#.',
    ]);
  });

  it('giving material back while winning, and a quiet preparing move', () => {
    const qxf8 = hintOf('1r3rk1/p1ppQpp1/n6p/1p6/2PP4/N3B3/PP2BPPP/R2K3R w - - 1 17', cp(2459), ['e7f8', 'g8f8', 'c4b5', 'a6b4', 'e3d2']);
    expect(qxf8.headline).toBe('Qxf8+ gives up the queen for a rook and a pawn and keeps a winning position.');
    const be2 = hintOf('r2qk2r/1b3ppp/p3pn2/1p6/1bP4P/3PPNP1/1B1R1P2/1N1QKB1R w Kkq - 0 18', cp(439), ['f1e2', 'e8g8', 'e1g1', 'b4d2', 'b1d2']);
    expect(be2.headline).toBe('Be2 prepares O-O, which castles the king to safety and brings the rook into play.');
  });

  it('a hanging piece is named even when the position was already decided', () => {
    const fen = 'rnbqkb1r/pppppppp/8/8/4P1n1/8/PPPP1PPP/RNB1KBNR w KQkq - 0 3';
    const e = explainWith(
      fen,
      'f1a6',
      'good',
      [pvLine(cp(-836), ['g1f3', 'g4f6', 'b1c3']), pvLine(cp(-844), ['f1e2'], 2)],
      [pvLine(cp(1237), ['b8a6', 'g1f3', 'd7d5'])],
      [0.044, 0.011],
    );
    expect(text(e)).toEqual([
      'This hangs your bishop on a6.',
      'Black plays Nxa6 and wins a bishop.',
      'The position was already lost.',
      'Best was Nf3, which develops the knight and fights for the center.',
    ]);
  });
});

describe('hints that compare the engine lines (MultiPV)', () => {
  /** The MultiPV set, numbered in order. */
  const set = (...lines: ReturnType<typeof pvLine>[]) => lines.map((l, i) => ({ ...l, multipv: i + 1 }));
  const hintWith = (fen: string, lines: ReturnType<typeof pvLine>[], opts: Parameters<typeof explainBestMove>[2] = {}) => {
    const e = explainBestMove(fen, lines[0], { ...opts, lines });
    expectWellFormed(e);
    return e;
  };
  const LASKER4 = 'rnbqkbnr/pppp2pp/4p3/5p2/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq - 0 3';
  const c4 = pvLine(cp(54), ['c2c4', 'g8f6', 'g2g3', 'f8e7', 'f1g2', 'f6e4']);
  const g3 = (score: number) => pvLine(cp(score), ['g2g3', 'g8f6', 'f1g2', 'd7d5', 'c2c4', 'f8e7']);
  const bf4 = (score: number) => pvLine(cp(score), ['c1f4', 'g8f6', 'e2e3', 'f8e7', 'c2c4', 'f6h5']);

  it('a quiet move with alternatives about as good: what it keeps, and which moves are as good', () => {
    expect(text(hintOf(LASKER4, c4.score, c4.pv))).toEqual(['c4 improves the position.', 'Main line: c4 Nf6 g3 Be7 Bg2.']);
    expect(text(hintWith(LASKER4, set(c4, g3(53), bf4(44))))).toEqual([
      'c4 keeps a small edge.',
      'g3 and Bf4 are about as good.',
      'Main line: c4 Nf6 g3 Be7 Bg2.',
    ]);
  });

  it('a quiet move that is a little better than the next one, or the only good one', () => {
    expect(text(hintWith(LASKER4, set(c4, g3(20), bf4(10))))).toEqual([
      'c4 keeps a small edge.',
      'It is more precise than g3.',
      'Main line: c4 Nf6 g3 Be7 Bg2.',
    ]);
    const only = hintWith(LASKER4, set(c4, g3(-150), bf4(-160)));
    expect(text(only)).toEqual([
      'c4 is the only move that keeps the balance.',
      'Anything else gives Black the better game.',
      'Main line: c4 Nf6 g3 Be7 Bg2.',
    ]);
    expect(only.motifs).toContain('onlyGoodMove');
    const neutral = hintWith(LASKER4, set(pvLine(cp(250), c4.pv), g3(20)), { perspective: 'neutral' });
    expect(neutral.headline).toBe('c4 is the only move that keeps the advantage.');
    expect(neutral.details[0]).toBe("Anything else throws away most of White's advantage.");
  });

  it('says what the move keeps in won and lost positions', () => {
    const won = '2k1r2r/6bp/1p2p3/p2p1pPP/n7/4R3/P7/4K3 b - - 1 39';
    expect(
      text(
        hintWith(
          won,
          set(
            pvLine(cp(1643), ['c8c7', 'e1d1', 'a4c5', 'e3b3', 'c7c6', 'd1e2']),
            pvLine(cp(1628), ['c8d7', 'e3g3', 'e8c8', 'g5g6', 'd7d6', 'e1d2']),
            pvLine(cp(1618), ['a4c5', 'h5h6', 'g7d4', 'e3h3', 'c8d7', 'e1d1']),
          ),
        ),
      ).slice(0, 2),
    ).toEqual(['Kc7 keeps your winning position.', 'Kd7 and Nc5 are about as good.']);
    // Expected scores barely differ when winning big: four pawns apart is not "about as good".
    const ng5 = '8/4k3/8/8/P3P1Kp/7N/P4R1P/7R w - - 0 49';
    const e = hintWith(
      ng5,
      set(
        pvLine(cp(2553), ['h3g5', 'e7d6', 'f2c2', 'd6e7', 'h1f1', 'e7d6']),
        pvLine(cp(2140), ['f2c2', 'e7d7', 'h3g5', 'd7d6', 'c2d2', 'd6c5']),
        pvLine(cp(1756), ['a4a5', 'e7d6', 'h3g5', 'd6c6', 'h1f1', 'c6b5']),
      ),
    );
    expect(text(e).slice(0, 2)).toEqual(['Ng5 keeps your winning position.', 'It is more precise than Rc2.']);
    const lost = '8/8/8/5kp1/3Kp2p/8/8/8 w - - 0 51';
    const kd5 = hintWith(
      lost,
      set(
        pvLine(cp(-1675), ['d4d5', 'h4h3', 'd5c4', 'e4e3', 'c4d3', 'h3h2']),
        pvLine(cp(-1675), ['d4e3', 'h4h3', 'e3d4', 'e4e3', 'd4e3', 'h3h2']),
        pvLine(cp(-1695), ['d4c5', 'e4e3', 'c5d6', 'e3e2', 'd6d7', 'h4h3']),
      ),
    );
    expect(text(kd5).slice(0, 2)).toEqual(['Kd5 is the best try in a difficult position.', 'Ke3 and Kc5 are about as good.']);
  });

  it('a plain check says what it keeps too', () => {
    const fen = 'r2qkbnr/3b1ppp/p1Qp4/1pp5/4P3/1B6/PPP2PPP/RNB1K2R w KQkq - 4 11';
    const e = hintWith(
      fen,
      set(
        pvLine(cp(-401), ['b3f7', 'e8f7', 'c6d5', 'f7e8', 'c1g5', 'd8c8']),
        pvLine(cp(-409), ['c6b7', 'c5c4', 'b3c4', 'b5c4', 'c1f4', 'd8c8']),
        pvLine(cp(-415), ['c6d5', 'c5c4', 'b3c4', 'b5c4', 'd5c4', 'g8f6']),
      ),
    );
    expect(text(e).slice(0, 2)).toEqual([
      'Bxf7+ gives check and is the best try in a difficult position.',
      'Qb7 and Qd5 are about as good.',
    ]);
  });

  it('adds "the only good move" to a positional reason, and leaves tactics alone', () => {
    const fen = '4k2r/5p2/p3p2P/1br4N/7Q/2qPP1P1/5P2/3R2K1 w - - 5 36';
    const lines = set(
      pvLine(cp(469), ['h5f6', 'e8f8', 'f6e4', 'c5h5', 'h4h5', 'c3c2']),
      pvLine(cp(-357), ['h6h7', 'e8d7', 'h5f6', 'd7c8', 'f6e4', 'c3c2']),
    );
    expect(text(hintWith(fen, lines))).toEqual([
      'Nf6+ brings the knight to a more active square.',
      'It is the only good move here.',
    ]);
    const fork = hintWith(S.royalFork, set(pvLine(cp(900), analysis(S.royalFork).lines[0].pv), pvLine(cp(0), ['b5d6'])));
    expect(text(fork)).toEqual(text(hint(S.royalFork)));
  });

  it('ignores lines that do not fit: one line only, or another move on top', () => {
    const plain = text(hintOf(LASKER4, c4.score, c4.pv));
    expect(text(hintWith(LASKER4, set(c4)))).toEqual(plain);
    expect(text(explainBestMove(LASKER4, c4, { lines: set(g3(60), c4) }))).toEqual(plain);
    expect(text(explainBestMove(LASKER4, c4, { lines: [] }))).toEqual(plain);
  });

  it('the feedback on the best move says what the hint says', () => {
    const lines = set(c4, g3(53), bf4(44));
    const e = explainWith(LASKER4, 'c2c4', 'best', lines, [pvLine(cp(-54), c4.pv.slice(1))], [0.55, 0.55]);
    expect(text(e)).toEqual(text(hintWith(LASKER4, lines)));
    const only = set(c4, g3(-150));
    const great = explainWith(LASKER4, 'c2c4', 'great', only, [pvLine(cp(-54), c4.pv.slice(1))], [0.55, 0.55]);
    expect(great.headline).toBe(hintWith(LASKER4, only).headline);
    expect(great.details).toContain('Anything else gives Black the better game.');
  });
});

describe('recaptures and consistency', () => {
  it('a recapture is not counted as material won', () => {
    const qxf4 = hintOf('3qkb1r/r1p2pp1/1pPp1n2/p5B1/4Ppbp/2N1Q3/PPP3PP/R3K1NR w KQk - 0 14', cp(336), ['e3f4', 'g4h5', 'f4h4', 'f8e7'], {
      prevMove: { to: 'f4', captured: 'p' },
    });
    expect(text(qxf4)).toEqual(['Qxf4 wins a pawn.', 'Key line: Qxf4 Bh5 Qxh4 Be7.']);
    const rxf8 = hintOf('1r3Qk1/p1pp1pp1/n6p/1p6/2PP4/N3B3/PP2BPPP/R2K3R b - - 0 17', cp(-1884), ['b8f8', 'c4b5', 'a6b4'], {
      prevMove: { to: 'f8', captured: 'r' },
    });
    expect(rxf8.headline).toBe('Rxf8 wins the queen for a rook and a pawn.');
  });

  it('explains the best move with the same line as the hint', () => {
    const moves = (GAMES.games ?? []).find((g) => g.name === 'Opera game')!.moves.split(' ');
    const c = new Chess();
    let prevMove: { to: string; captured?: string } | undefined;
    let compared = 0;
    for (const san of moves) {
      const fen = c.fen();
      const m = c.move(san);
      const uci = m.from + m.to + (m.promotion ?? '');
      const before = analysis(fen, GAMES);
      const after = analysis(c.fen(), GAMES);
      if (before.lines[0]?.pv[0] === uci && !c.isGameOver() && before.lines[0].score.kind === 'cp') {
        const classification = classify(fen, uci, before, after);
        const e = explainMove({ fenBefore: fen, moveUci: uci, classification, before, after, prevMove });
        expect(e.headline).toBe(explainBestMove(fen, before.lines[0], { prevMove, lines: before.lines }).headline);
        compared++;
      }
      prevMove = { to: m.to, captured: m.captured };
    }
    expect(compared).toBeGreaterThan(5);
  });
});

describe('no contradictions', () => {
  it('no "would be a mistake" when the opponent cannot take (in check)', () => {
    const fen = fenOf('d4 e6 Nf3 f5 Nc3 Nf6 Bg5 Be7 Bxf6 Bxf6 e4 fxe4 Nxe4 b6 Ne5 O-O Bd3 Bb7 Qh5 Qe7 Qxh7+ Kxh7 Nxf6+ Kh6');
    const e = explainWith(
      fen,
      'e5g4',
      'great',
      [pvLine({ kind: 'mate', value: 7 }, ['e5g4', 'h6g5', 'h2h4', 'g5f4']), pvLine(cp(76), ['f6g4'], 2)],
      [pvLine({ kind: 'mate', value: -6 }, ['h6g5', 'h2h4', 'g5f4'])],
      [1, 1],
    );
    expect(text(e).join(' ')).not.toMatch(/would be a mistake/);
  });

  it('a swing to the other side reads "the better game", not "back into the game"', () => {
    const fen = 'r1bqkb1r/pppp1ppp/5n2/4p3/2BnP3/5N2/PPPPQPPP/RNB1K2R w KQkq - 6 5';
    const e = explainWith(
      fen,
      'e2d3',
      'blunder',
      [pvLine(cp(195), ['f3d4', 'e5d4', 'e4e5']), pvLine(cp(-69), ['e2d1'], 2)],
      [pvLine(cp(236), ['d7d5', 'c4d5', 'f6d5'])],
      [0.673, 0.295],
    );
    expect(e.headline).toBe('This gives Black the better game.');
  });

  it('does not repeat the same tactic as "X was better"', () => {
    for (const d of explain(S.tradeAhead, 'Qxd8+').details) expect(d).not.toMatch(/was better: it trades/);
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
          // "X was better: it <reason>" never repeats the played move's own reason.
          for (const d of e.details) {
            const better = /was better: it (.*)\.$/.exec(d)?.[1];
            if (better) expect([e.headline, ...e.details].some((x) => x !== d && x.endsWith(`${better}.`))).toBe(false);
          }
          if (perspective === 'neutral') expect(text(e).join(' ')).not.toMatch(/\b[Yy]our?\b/);
        }
        if (!c.isGameOver()) {
          expectWellFormed(explainBestMove(c.fen(), after.lines[0]));
          const withLines = explainBestMove(c.fen(), after.lines[0], { lines: after.lines, perspective: 'neutral' });
          expectWellFormed(withLines);
          expect(text(withLines).join(' ')).not.toMatch(/\b[Yy]our?\b/);
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
      'O-O-O wins a knight and two pawns.',
      'It attacks the knight on d7, which is pinned to the king.',
    ]);
    expect(out['14.Rd1']).toEqual([
      'Rd1 wins a rook and a pawn.',
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
