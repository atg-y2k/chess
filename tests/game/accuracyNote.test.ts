/**
 * "99% accuracy with 9 inaccuracies": the labels stay, and the coach explains them (the user's
 * choice). A checkmate more than six moves slower than the best one (the coach's own rule), or, like
 * lichess, a forced mate given up for a position still +10 or better, is an inaccuracy; accuracy,
 * which caps the evaluation at ±10 (a mate counting as 10), does not move.
 * - The move's explanation adds why (`Classification.wonAnyway`, coach.ts `wonAnywayLine`): "A
 *   faster mate was available (Qh7#), but you were winning anyway.", the move hidden while it is
 *   still to be found (Retry, Try again, a rated game in the game viewer), nothing while the
 *   explanations are locked.
 * - Game Review's report and the game viewer's say how many of a side's weak moves came when it
 *   was already winning (review.ts `alreadyWonNote`): "7 of your 9 inaccuracies came when you were
 *   already winning, so they didn’t lower your winning chances — that’s why your accuracy is still
 *   99.4%."; the game-over sheet in short (`alreadyWonSheetNote`), and its Try again leaves them out.
 * The game history keeps `wonAnyway` (game/archive.ts); records kept before it did are judged by the
 * evaluations they keep.
 */
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { classifyFromEvals, classifyMoveDetailed, wonAnywayFromEvals } from '../../src/analysis/classify';
import { explainMove } from '../../src/analysis/explain';
import type { Classification, MoveClass, WonAnyway } from '../../src/analysis/types';
import { personaById } from '../../src/bot/personas';
import { START_FEN } from '../../src/chess/utils';
import type { AnalysisResult, Score } from '../../src/engine/types';
import { archivedGame, decodeAnalysis, encodeAnalysis } from '../../src/game/archive';
import { wonAnywayLine, wonAnywaySummary } from '../../src/game/coach';
import type { ProFeature } from '../../src/game/entitlements';
import { tryKey } from '../../src/game/practice';
import {
  ACCURACY_NOTE_MIN,
  alreadyWonNote,
  alreadyWonSheetNote,
  reviewAccuracyNotes,
  summarizeGame,
  weakInWonGame,
} from '../../src/game/review';
import { createState, createStore, explanationLines, type AppState } from '../../src/game/store';
import { DEFAULT_SETTINGS, type Color, type GameSettings, type Ply } from '../../src/game/types';
import { openViewer, viewerView, type ViewerContext } from '../../src/game/viewer';
import { defaultProfile } from '../../src/rating/rating';
import type { GameRecord } from '../../src/rating/types';
import { signal } from '@preact/signals';

const cp = (value: number): Score => ({ kind: 'cp', value });
/** An accuracy as Game Review shows it ("99.4"). */
const tenths = (a: number): string => (Math.round(a * 10) / 10).toFixed(1);
const mate = (value: number): Score => ({ kind: 'mate', value });

/** An analysis of `fen` with these lines (side to move's point of view), best first. */
function analysis(fen: string, lines: { score: Score; pv: string[] }[]): AnalysisResult {
  return {
    fen,
    depth: 16,
    lines: lines.map((l, i) => ({ multipv: i + 1, depth: 16, score: l.score, pv: l.pv })),
    bestMove: lines[0]?.pv[0] ?? null,
    done: true,
  };
}

function rate(fen: string, uci: string, before: { score: Score; pv: string[] }[], after: { score: Score; pv: string[] }[]) {
  const c = new Chess(fen);
  c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4) });
  const b = analysis(fen, before);
  const a = analysis(c.fen(), after);
  const d = classifyMoveDetailed({ fenBefore: fen, moveUci: uci, before: b, after: a });
  const e = (perspective: 'you' | 'neutral' = 'you') =>
    explainMove({ fenBefore: fen, moveUci: uci, classification: d.classification, before: b, after: a, perspective });
  return { ...d, explain: e };
}

/** White K+Q+R against a bare king: Qh7# and Ra8# mate at once. */
const MATE_IN_ONE = '7k/8/6K1/8/8/8/8/R6Q w - - 0 1';
const MATES_NOW = [
  { score: mate(1), pv: ['h1h7'] },
  { score: mate(1), pv: ['a1a8'] },
  { score: mate(2), pv: ['h1h2', 'h8g8', 'a1a8'] },
];
/** A back-rank mate: Qd8# (and Re8#). */
const BACK_RANK = '6k1/5ppp/8/8/8/8/5PPP/3QR1K1 w - - 0 1';
const BACK_RANK_MATES = [
  { score: mate(1), pv: ['d1d8'] },
  { score: mate(1), pv: ['e1e8'] },
];

describe('classify: the class comes from the mate-distance rules while the game stays won', () => {
  it('a mate more than six moves slower: an inaccuracy that costs nothing (wonAnyway "slower")', () => {
    // Qb1: mate in 9 instead of 1.
    const d = rate(MATE_IN_ONE, 'h1b1', MATES_NOW, [{ score: mate(-8), pv: ['h8g8', 'b1b8'] }]);
    expect(d.reasons).toContain('mate_slower');
    expect(d.classification).toMatchObject({ cls: 'inaccuracy', winLoss: 0, accuracy: 100, bestMoveSan: 'Qh7#' });
    expect(d.classification.wonAnyway).toEqual({ kind: 'slower', mateIn: 1 });
    // Six moves slower is Good: nothing to explain.
    const six = rate(MATE_IN_ONE, 'h1b1', MATES_NOW, [{ score: mate(-6), pv: ['h8g8', 'b1b8'] }]);
    expect(six.classification.cls).toBe('good');
    expect(six.classification.wonAnyway).toBeUndefined();
    // The best move itself: none.
    expect(rate(MATE_IN_ONE, 'h1h7', MATES_NOW, []).classification.wonAnyway).toBeUndefined();
  });

  it('a forced mate given up for +10 or better: an inaccuracy (wonAnyway "lost"); for less it is a real mistake', () => {
    const won = rate(BACK_RANK, 'd1d3', BACK_RANK_MATES, [{ score: cp(-1200), pv: ['h7h6', 'd3d8'] }]);
    expect(won.reasons).toContain('lost_mate');
    expect(won.classification.cls).toBe('inaccuracy');
    expect(won.classification.wonAnyway).toEqual({ kind: 'lost', mateIn: 1 });
    expect(won.explain().headline).toBe('You missed Qd8#, which was checkmate.');
    // +8: a mistake by the same floor, and the game is no longer decided.
    const mistake = rate(BACK_RANK, 'd1d3', BACK_RANK_MATES, [{ score: cp(-800), pv: ['h7h6'] }]);
    expect(mistake.classification.cls).toBe('mistake');
    expect(mistake.classification.wonAnyway).toBeUndefined();
    const blunder = rate(BACK_RANK, 'd1d3', BACK_RANK_MATES, [{ score: cp(-300), pv: ['h7h6'] }]);
    expect(blunder.classification.cls).toBe('blunder');
    expect(blunder.classification.wonAnyway).toBeUndefined();
    // Listed at +9.5, its own search +10.2 (not disputed): judged by the list, a real mistake.
    const listed = rate(BACK_RANK, 'd1d3', [...BACK_RANK_MATES, { score: cp(950), pv: ['d1d3', 'h7h6'] }], [{ score: cp(-1020), pv: ['h7h6'] }]);
    expect(listed.classification.cls).toBe('mistake');
    expect(listed.classification.wonAnyway).toBeUndefined();
  });

  it('a slower mate the reply’s search does not see: still "how it mates", never "you missed the mate" beside the line', () => {
    // Qb1 listed as mate in 9; the search after it finds no mate (-9.00 from Black’s side).
    const d = rate(MATE_IN_ONE, 'h1b1', [...MATES_NOW, { score: mate(9), pv: ['h1b1', 'h8g8'] }], [{ score: cp(-900), pv: ['h8g8'] }]);
    expect(d.classification).toMatchObject({ cls: 'inaccuracy', wonAnyway: { kind: 'slower', mateIn: 1 } });
    expect(d.explain().headline).toBe('Qb1 still forces mate in 9.');
  });

  it('never for the losing side, an unknown move, or a weak class the loss of winning chances gives', () => {
    // Allowing a mate at -12: an inaccuracy by lichess's floor, but the mover was lost, not winning.
    const allows = classifyFromEvals({
      lines: [
        { uci: 'a1a2', score: cp(-1200) },
        { uci: 'a1a3', score: cp(-1250) },
      ],
      playedUci: 'a1a4',
      played: mate(-3),
      legalMoveCount: 20,
      inCheckBefore: false,
    });
    expect(allows).toMatchObject({ cls: 'inaccuracy' });
    expect(allows.wonAnyway).toBeUndefined();
    // Not searched (estimated from the worst line): no verdict on how it mates.
    const estimated = classifyFromEvals({
      lines: [
        { uci: 'd1h5', score: mate(2) },
        { uci: 'd1d8', score: mate(9) },
      ],
      playedUci: 'a2a3',
      played: null,
      legalMoveCount: 30,
      inCheckBefore: false,
    });
    expect(estimated.wonAnyway).toBeUndefined();
    // From +1.0 to -0.5: weak by the winning chances it costs.
    const plain = classifyFromEvals({
      lines: [
        { uci: 'd1h5', score: cp(100) },
        { uci: 'd1d8', score: cp(-50) },
      ],
      playedUci: 'd1d8',
      played: cp(-50),
      legalMoveCount: 30,
      inCheckBefore: false,
    });
    expect(plain.cls).toBe('mistake');
    expect(plain.wonAnyway).toBeUndefined();
  });

  it('records kept before the history stored it: derived from the evaluations kept (White’s view), either color', () => {
    expect(wonAnywayFromEvals('inaccuracy', mate(2), mate(8), 'w')).toEqual({ kind: 'slower', mateIn: 2 });
    expect(wonAnywayFromEvals('inaccuracy', mate(2), cp(1200), 'w')).toEqual({ kind: 'lost', mateIn: 2 });
    expect(wonAnywayFromEvals('inaccuracy', mate(2), cp(999), 'w')).toBeNull();
    expect(wonAnywayFromEvals('inaccuracy', cp(1500), cp(1200), 'w')).toBeNull();
    expect(wonAnywayFromEvals('inaccuracy', mate(2), mate(-3), 'w')).toBeNull();
    expect(wonAnywayFromEvals('inaccuracy', mate(2), mate(0), 'w')).toBeNull();
    expect(wonAnywayFromEvals('inaccuracy', null, mate(8), 'w')).toBeNull();
    expect(wonAnywayFromEvals('inaccuracy', mate(2), undefined, 'w')).toBeNull();
    expect(wonAnywayFromEvals('good', mate(2), mate(5), 'w')).toBeNull();
    // Only ever an inaccuracy, as classify gives it: a mistake or worse is a real one.
    expect(wonAnywayFromEvals('mistake', mate(1), cp(1020), 'w')).toBeNull();
    expect(wonAnywayFromEvals('blunder', mate(2), mate(9), 'w')).toBeNull();
    // Black: its mates are negative from White's side.
    expect(wonAnywayFromEvals('inaccuracy', mate(-3), mate(-10), 'b')).toEqual({ kind: 'slower', mateIn: 3 });
    expect(wonAnywayFromEvals('inaccuracy', mate(-3), cp(-1100), 'b')).toEqual({ kind: 'lost', mateIn: 3 });
    expect(wonAnywayFromEvals('inaccuracy', mate(3), mate(10), 'b')).toBeNull();
  });
});

describe('the coach’s line', () => {
  const slower1: WonAnyway = { kind: 'slower', mateIn: 1 };
  const slower3: WonAnyway = { kind: 'slower', mateIn: 3 };
  const lost: WonAnyway = { kind: 'lost', mateIn: 2 };

  it('names the faster mate and its distance, for you or the opponent; never while it is to be found', () => {
    expect(wonAnywayLine({ bestMoveSan: 'Qh7#' }, slower1, { who: 'you', reveal: true })).toBe(
      'A faster mate was available (Qh7#), but you were winning anyway.',
    );
    expect(wonAnywayLine({ bestMoveSan: 'Qh7+' }, slower3, { who: 'you', reveal: true })).toBe(
      'A faster mate was available (Qh7+, mate in 3), but you were winning anyway.',
    );
    expect(wonAnywayLine({ bestMoveSan: null }, slower3, { who: 'you', reveal: true })).toBe(
      'A faster mate was available (mate in 3), but you were winning anyway.',
    );
    expect(wonAnywayLine({ bestMoveSan: 'Qh7+' }, slower3, { who: 'you', reveal: false })).toBe(
      'A faster mate was available, but you were winning anyway.',
    );
    expect(wonAnywayLine({ bestMoveSan: 'Qh2#' }, slower1, { who: 'Pip', reveal: true })).toBe(
      'Pip had a faster mate (Qh2#), but was winning anyway.',
    );
    expect(wonAnywayLine({ bestMoveSan: 'Qh2#' }, slower1, { who: 'Pip', reveal: false })).toBe('Pip had a faster mate, but was winning anyway.');
    // A forced mate given up: the explanation names it ("You missed a forced mate in 2.").
    expect(wonAnywayLine({ bestMoveSan: 'Qd8+' }, lost, { who: 'you', reveal: true })).toBe(
      'You were winning anyway, so the missed mate hardly matters.',
    );
    expect(wonAnywayLine({ bestMoveSan: 'Qd8+' }, lost, { who: 'Pip', reveal: false })).toBe('Pip was winning anyway, so the missed mate hardly matters.');
    expect(wonAnywayLine({ bestMoveSan: 'Qh7#' }, null, { who: 'you', reveal: true })).toBeNull();
  });

  it('a slower mate’s explanation says how the move mates; the line names the faster one (no "Best was" twice)', () => {
    const d = rate(MATE_IN_ONE, 'h1b1', MATES_NOW, [{ score: mate(-8), pv: ['h8g8', 'b1b8'] }]);
    const e = d.explain();
    expect(e).toMatchObject({ headline: 'Qb1 still forces mate in 9.', details: [], title: 'Slower mate' });
    expect(d.explain('neutral').headline).toBe('Qb1 still forces mate in 9.');
    const cl = d.classification;
    const won = wonAnywayLine(cl, cl.wonAnyway, { who: 'you', reveal: true });
    expect(explanationLines(e, cl.bestMoveSan, { cl, playedUci: 'h1b1' }, won)).toEqual([
      'Qb1 still forces mate in 9.',
      'A faster mate was available (Qh7#), but you were winning anyway.',
    ]);
    // Without the line (an older caller): the better move as before.
    expect(explanationLines(e, cl.bestMoveSan, { cl, playedUci: 'h1b1' })).toEqual(['Qb1 still forces mate in 9.', 'Best was Qh7# (Ra8# was about as good).']);
  });

  it('the collapsed row leads with why (the line cut to fit there)', () => {
    expect(wonAnywaySummary(slower1, 'you')).toBe('Still winning: a faster mate was available.');
    expect(wonAnywaySummary(lost, 'you')).toBe('Still winning: the missed mate hardly matters.');
    expect(wonAnywaySummary(lost, 'Pip')).toBe('Pip was still winning: the missed mate hardly matters.');
    expect(wonAnywaySummary(null, 'you')).toBeNull();
  });

  it('the game history keeps it (\'w\' and \'l\' with the mate), and judges records kept before it did from their evaluations', () => {
    const c = new Chess();
    const plies: Ply[] = ['e4', 'e5', 'Qh5', 'Nc6'].map((san, index) => {
      const fenBefore = c.fen();
      const m = c.move(san);
      return { index, color: m.color, san: m.san, uci: m.from + m.to, fenBefore, fenAfter: c.fen(), evalWhite: mate(index < 2 ? 3 : 9) };
    });
    const cl = (cls: MoveClass, wonAnyway?: WonAnyway): Classification => verdict(cls, { bestMoveUci: 'd2d4', bestMoveSan: 'd4', ...(wonAnyway ? { wonAnyway } : {}) });
    plies[0].classification = cl('best');
    plies[1].classification = cl('best');
    plies[2].classification = cl('inaccuracy', { kind: 'slower', mateIn: 3 });
    plies[3].classification = cl('inaccuracy');
    const kept = encodeAnalysis(plies, mate(3), { playerColor: 'w' });
    expect(kept.w).toBe(1);
    expect(kept.p.split(' ')[2]).toBe('i#9w3:d2d4');
    const now = decodeAnalysis(plies, kept).plies;
    expect(now[2].classification?.wonAnyway).toEqual({ kind: 'slower', mateIn: 3 });
    expect(now[3].classification?.wonAnyway).toBeUndefined(); // the coach said no: no guess
    const lostToken = encodeAnalysis([{ ...plies[0], classification: cl('inaccuracy', { kind: 'lost', mateIn: 2 }) }], null, { playerColor: 'w' });
    expect(lostToken.p).toBe('i#3l2:d2d4');
    // Kept before the history stored it: from the evaluations, an inaccuracy only.
    const { w: _w, ...older } = kept;
    const before = decodeAnalysis(plies, { ...older, p: older.p.replace('w3', '') }).plies;
    expect(before[2].classification?.wonAnyway).toEqual({ kind: 'slower', mateIn: 3 });
    const mistakes = decodeAnalysis(plies, { ...older, p: older.p.replace('w3', '').replace(/^(\S+ \S+ )i/, '$1m') }).plies;
    expect(mistakes[2].classification?.cls).toBe('mistake');
    expect(mistakes[2].classification?.wonAnyway).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// The game: the coach, Game Review, the game-over sheet

const PIP = personaById('pip')!;
const SANS = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5', 'Nxd5'];

function verdict(cls: MoveClass, over: Partial<Classification> = {}): Classification {
  return { cls, winBefore: 1, winAfter: 1, winLoss: 0, accuracy: 100, bestMoveUci: null, bestMoveSan: null, playedMoveSan: '', ...over };
}

/**
 * 1.e4 … 5.exd5 Nxd5 with made-up verdicts and evaluations: White mates in 3 from move 4 on.
 * 5.exd5 (ply 8, `exd5`) is a slower mate (Qh5 would mate in 3), 4.Ng5 (ply 6) an older save's
 * slower mate (no `wonAnyway`: from the evaluations). `blackWins`: the colors swapped in the
 * evaluations, so Pip (Black) is the one mating, with its slower mate at 5…Nxd5 (ply 9).
 */
function gamePlies(o: { exd5?: Partial<Classification>; blackWins?: boolean } = {}): Ply[] {
  const c = new Chess();
  const sign = o.blackWins ? -1 : 1;
  return SANS.map((san, index) => {
    const fenBefore = c.fen();
    const m = c.move(san);
    const uci = m.from + m.to;
    let classification = verdict('best', { bestMoveUci: uci, bestMoveSan: m.san, playedMoveSan: m.san });
    if (!o.blackWins && index === 6) {
      classification = verdict('inaccuracy', { bestMoveUci: 'd2d4', bestMoveSan: 'd4', playedMoveSan: m.san });
    }
    if (!o.blackWins && index === 8) {
      classification = verdict('inaccuracy', {
        bestMoveUci: 'd1h5',
        bestMoveSan: 'Qh5',
        playedMoveSan: m.san,
        wonAnyway: { kind: 'slower', mateIn: 3 },
        ...o.exd5,
      });
    }
    if (o.blackWins && index === 9) {
      classification = verdict('inaccuracy', {
        bestMoveUci: 'd8d5',
        bestMoveSan: 'Qxd5',
        playedMoveSan: m.san,
        wonAnyway: { kind: 'slower', mateIn: 2 },
      });
    }
    const evalWhite: Score = index < 5 ? cp(sign * 30) : mate(sign * (index >= 8 ? 9 : 3));
    return {
      index,
      color: m.color,
      san: m.san,
      uci,
      fenBefore,
      fenAfter: c.fen(),
      evalWhite,
      evalDepth: 16,
      classification,
      explanation: { headline: index === 8 ? 'exd5 still forces mate in 9.' : `${m.san} is fine.`, details: [] },
      ...(m.captured ? { captured: m.captured } : {}),
    };
  });
}

function storeFor(o: {
  plies: Ply[];
  phase: 'playing' | 'over' | 'review';
  playerColor?: Color;
  settings?: Partial<GameSettings>;
  locked?: ProFeature[];
}): { state: AppState; store: ReturnType<typeof createStore> } {
  const playerColor = o.playerColor ?? 'w';
  const settings: GameSettings = { ...DEFAULT_SETTINGS, playerColor, botId: 'pip', botElo: PIP.elo, ...o.settings };
  const state = createState({ settings, profile: defaultProfile(), locked: signal(new Set(o.locked ?? [])) });
  state.game.value = {
    id: 'g1',
    startFen: START_FEN,
    playerColor,
    bot: PIP,
    botElo: PIP.elo,
    startedAt: new Date(0).toISOString(),
    assisted: true,
    settings,
  };
  state.plies.value = o.plies;
  state.startEval.value = cp(30);
  state.phase.value = o.phase;
  if (o.phase !== 'playing') {
    state.outcome.value = { result: '1-0', winner: 'w', reason: 'Checkmate' };
    state.ratingChange.value = { before: 800, after: 800, rated: false };
  }
  if (o.phase === 'review') {
    state.reviewState.value = { ...summarizeGame(START_FEN, state.startEval.value, o.plies, playerColor), progress: null };
  }
  if (o.phase === 'over') state.sheet.value = 'gameOver';
  return { state, store: createStore(state) };
}

const FASTER = 'A faster mate was available (Qh5, mate in 3), but you were winning anyway.';
const FASTER_HIDDEN = 'A faster mate was available, but you were winning anyway.';

describe('the coach during the game', () => {
  it('your move: the line after the explanation, the faster mate named', () => {
    const { state, store } = storeFor({ plies: gamePlies().slice(0, 9), phase: 'playing' });
    state.coachMode.value = { kind: 'feedback', index: 8 };
    expect(store.coach.value).toMatchObject({ title: '5. exd5 is an inaccuracy', cls: 'inaccuracy' });
    expect(store.coach.value.lines).toEqual(['exd5 still forces mate in 9.', FASTER]);
  });

  it('explanations locked (Pro): only the teaser, no line', () => {
    const { state, store } = storeFor({ plies: gamePlies().slice(0, 9), phase: 'playing', locked: ['coachExplanations'] });
    state.coachMode.value = { kind: 'feedback', index: 8 };
    expect(store.coach.value.lines.join(' ')).not.toMatch(/faster mate|winning anyway/);
    expect(store.coach.value.lines).toHaveLength(1);
  });

  it('a real mistake from a forced mate (no wonAnyway): no "hardly matters", whatever the evaluations kept; Retry stays', () => {
    // Listed +9.5 in its line (a mistake by lichess's floor); its own search kept +10.2.
    const plies = gamePlies({ exd5: { cls: 'mistake', wonAnyway: undefined } }).slice(0, 9);
    plies[8] = { ...plies[8], evalWhite: cp(1020), explanation: { headline: 'You missed a forced mate in 3.', details: [] } };
    const { state, store } = storeFor({ plies, phase: 'playing', settings: { allowTakebacks: true } });
    state.coachMode.value = { kind: 'feedback', index: 8 };
    const c = store.coach.value;
    expect(c.actions.map((a) => a.id)).toContain('retry');
    expect(c.lines.join(' ')).not.toMatch(/winning anyway|hardly matters/);
    expect(c.summary).toBeUndefined();
  });

  it('on a short phone the collapsed row leads with why', () => {
    const { state, store } = storeFor({ plies: gamePlies().slice(0, 9), phase: 'playing' });
    state.coachMode.value = { kind: 'feedback', index: 8 };
    expect(store.coach.value.summary).toBe('Still winning: a faster mate was available.');
  });

  it('the opponent’s move (Rate opponent’s moves): in the third person, with its name', () => {
    const { state, store } = storeFor({ plies: gamePlies({ blackWins: true }), phase: 'playing', playerColor: 'w', settings: { rateOpponent: true, coach: false } });
    state.coachMode.value = { kind: 'idle' };
    const c = store.coach.value;
    expect(c).toMatchObject({ title: 'Pip’s 5… Nxd5 is an inaccuracy', subject: 'opponent' });
    expect(c.lines).toEqual(['Nxd5 is fine.', 'Pip had a faster mate (Qxd5, mate in 2), but was winning anyway.']);
  });
});

describe('Game Review', () => {
  it('a key moment to try again: the line without the move until the answer is shown', () => {
    const { state, store } = storeFor({ plies: gamePlies(), phase: 'review' });
    expect(store.tryAgainMoments.value.has(8)).toBe(true);
    state.viewIndex.value = 9;
    expect(store.coach.value.lines).toContain(FASTER_HIDDEN);
    expect(store.coach.value.lines.join(' ')).not.toMatch(/Qh5/);
    state.revealedTries.value = new Set([tryKey('g1', 8)]);
    expect(store.coach.value.lines).toEqual(['exd5 still forces mate in 9.', FASTER]);
  });

  it('Game Review’s comments locked (Pro): no line', () => {
    const { state, store } = storeFor({ plies: gamePlies(), phase: 'review', locked: ['reviewDetails'] });
    state.viewIndex.value = 9;
    expect(store.coach.value.lines.join(' ')).not.toMatch(/faster mate|winning anyway/);
    // The note under the accuracy is about the accuracy and the counts, which are free.
    expect(store.review.value!.accuracyNotes).toHaveLength(1);
  });

  it('a move the coach did not call won anyway gets no line, whatever the evaluations kept say', () => {
    const { state, store } = storeFor({ plies: gamePlies(), phase: 'review' });
    state.viewIndex.value = 7;
    state.revealedTries.value = new Set([tryKey('g1', 6)]);
    // 4.Ng5: mate in 3 before and after, but its verdict has no wonAnyway (only older records are guessed).
    expect(store.coach.value.lines.join(' ')).not.toMatch(/winning anyway/);
  });

  it('the report: the note under the accuracies, both counted (by the evaluations accuracy uses)', () => {
    const { store } = storeFor({ plies: gamePlies(), phase: 'review' });
    const r = store.review.value!;
    expect(r.counts.w.inaccuracy).toBe(2);
    expect(r.accuracyNotes).toEqual([
      `Both of your inaccuracies came when you were already winning, so they didn’t lower your winning chances — that’s why your accuracy is still ${tenths(r.accuracy.w!)}%.`,
    ]);
    expect(r.accuracy.w).toBeGreaterThanOrEqual(ACCURACY_NOTE_MIN);
  });

  it('the opponent’s column: "…Pip’s…" when its weak moves came in a game it was winning', () => {
    const { store } = storeFor({ plies: gamePlies({ blackWins: true }), phase: 'review' });
    const r = store.review.value!;
    expect(r.counts.b.inaccuracy).toBe(1);
    expect(r.accuracyNotes).toHaveLength(1);
    expect(r.accuracyNotes![0]).toMatch(/^Pip’s inaccuracy came when Pip was already winning, so it didn’t lower Pip’s winning chances/);
  });

  it('the game-over sheet: your note in short, and no "Try your mistakes again" for moves that cost nothing', () => {
    const { store } = storeFor({ plies: gamePlies(), phase: 'over' });
    const play = store.sheets.value.gameOver!.play;
    if (!play || play === 'pending') throw new Error('no play');
    expect(play.counts.inaccuracy).toBe(2);
    expect(play.note).toBe('Both came when you were already winning, so they didn’t lower your accuracy.');
    // Game Review still offers them; the sheet's button does not.
    expect([...store.tryAgainMoments.value].sort()).toEqual([6, 8]);
    expect(store.sheetTries.value).toEqual([]);
    // A weak move in a close game still counts for the button.
    const close = gamePlies().map((p) => (p.index === 2 ? { ...p, classification: verdict('mistake', { bestMoveUci: 'd2d4', bestMoveSan: 'd4', playedMoveSan: 'Nf3' }) } : p));
    expect(storeFor({ plies: close, phase: 'over' }).store.sheetTries.value).toEqual([2]);
  });

  it('no weak move in a won game: no note anywhere', () => {
    const plies = gamePlies().map((p) => (p.index === 6 || p.index === 8 ? { ...p, evalWhite: cp(80), classification: verdict('inaccuracy') } : { ...p, evalWhite: cp(80) }));
    expect(storeFor({ plies, phase: 'review' }).store.review.value!.accuracyNotes).toBeUndefined();
    const over = storeFor({ plies, phase: 'over' }).store.sheets.value.gameOver!.play;
    if (!over || over === 'pending') throw new Error('no play');
    expect(over.note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Counting

/** A ply for counting (the board does not matter here). */
function counted(index: number, color: Color, evalWhite: Score | undefined, cls: MoveClass, wonAnyway?: WonAnyway): Ply {
  return {
    index,
    color,
    san: 'Qd1',
    uci: 'd1d2',
    fenBefore: START_FEN,
    fenAfter: START_FEN,
    ...(evalWhite ? { evalWhite } : {}),
    classification: verdict(cls, wonAnyway ? { wonAnyway } : {}),
  };
}

/**
 * The user's report: 40 moves each, White (you) wins; 9 inaccuracies, 2 early ones in a close game,
 * then 7 in the won ending: 4 slower mates and 2 mates given up for +12 (`wonAnyway`), and one an
 * older save left without a reason (+15 to +11, both capped). Pip (Black) loses with 2 inaccuracies
 * in its lost position, which are not counted. Mirrored (`asBlack`): you are Black.
 */
function reportGame(asBlack = false): { plies: Ply[]; you: Color } {
  const you: Color = asBlack ? 'b' : 'w';
  const pip: Color = asBlack ? 'w' : 'b';
  const pov = (s: Score): Score => (asBlack ? { ...s, value: -s.value } : s);
  const plies: Ply[] = [];
  // Your moves are the even plies when you are White; as Black the game starts with Pip's move.
  for (let i = 0; i < 80; i++) {
    const mine = asBlack ? i % 2 === 1 : i % 2 === 0;
    const color = mine ? you : pip;
    const n = Math.floor(i / 2);
    // Your evaluation (your point of view) after the ply.
    let ev: Score = n < 10 ? cp(60) : n < 20 ? cp(400 + n * 30) : n < 30 ? cp(1500) : mate(Math.max(1, 40 - n));
    let cls: MoveClass = 'best';
    let won: WonAnyway | undefined;
    if (mine) {
      if (n === 3 || n === 7) {
        cls = 'inaccuracy';
        ev = cp(20); // +0.6 to +0.2
      }
      if (n === 25) {
        cls = 'inaccuracy';
        ev = cp(1100); // +15 to +11: an older save, no reason kept
      }
      if (n === 30 || n === 32 || n === 34 || n === 36) {
        cls = 'inaccuracy';
        won = { kind: 'slower', mateIn: 2 };
      }
      if (n === 31 || n === 33) {
        cls = 'inaccuracy';
        won = { kind: 'lost', mateIn: 3 };
        ev = cp(1200);
      }
    } else if (n === 35 || n === 37) {
      cls = 'inaccuracy'; // Pip, getting mated: not counted for it
    }
    plies.push(counted(i, color, pov(ev), cls, won));
  }
  return { plies, you };
}

describe('the count: weak moves made when that side was already winning', () => {
  it('weakInWonGame: both evaluations +10 or a mate for the mover', () => {
    const w = (ev: Score | undefined, cls: MoveClass = 'inaccuracy', won?: WonAnyway) => counted(0, 'w', ev, cls, won);
    expect(weakInWonGame(w(cp(1100)), cp(1500))).toBe(true);
    expect(weakInWonGame(w(mate(9)), mate(2))).toBe(true);
    expect(weakInWonGame(w(cp(1000)), mate(2))).toBe(true);
    expect(weakInWonGame(w(cp(999)), mate(2))).toBe(false);
    expect(weakInWonGame(w(cp(1100)), cp(900))).toBe(false);
    expect(weakInWonGame(w(cp(1100)), null)).toBe(false);
    expect(weakInWonGame(w(undefined), cp(1500))).toBe(false);
    // Only by the evaluations accuracy uses: a class from the mate rules whose kept evaluations are
    // not both decided did lower the accuracy.
    expect(weakInWonGame(w(cp(700), 'inaccuracy', { kind: 'slower', mateIn: 1 }), cp(800))).toBe(false);
    expect(weakInWonGame(w(cp(900), 'inaccuracy', { kind: 'slower', mateIn: 1 }), mate(1))).toBe(false);
    // Not weak, or the losing side.
    expect(weakInWonGame(w(cp(1100), 'good'), cp(1500))).toBe(false);
    expect(weakInWonGame(w(cp(1100), 'blunder'), cp(1500))).toBe(true);
    expect(weakInWonGame(counted(1, 'b', mate(3), 'inaccuracy'), cp(1500))).toBe(false);
    expect(weakInWonGame(counted(1, 'b', mate(-3), 'inaccuracy'), cp(-1500))).toBe(true);
    // mate 0 before the move: the mover is mated.
    expect(weakInWonGame(w(cp(1100)), mate(0))).toBe(false);
  });

  it('the user’s game: 99% accuracy, 9 inaccuracies, 7 of them when already winning', () => {
    const { plies } = reportGame();
    const sum = summarizeGame(START_FEN, cp(15), plies, 'w');
    expect(sum.counts.w.inaccuracy).toBe(9);
    expect(sum.alreadyWon?.w).toEqual({ inaccuracy: 7 });
    expect(sum.counts.b.inaccuracy).toBe(2);
    expect(sum.alreadyWon?.b).toEqual({});
    const acc = sum.accuracy.w!;
    expect(acc).toBeGreaterThanOrEqual(99);
    expect(reviewAccuracyNotes(sum, 'w', 'Pip')).toEqual([
      `7 of your 9 inaccuracies came when you were already winning, so they didn’t lower your winning chances — that’s why your accuracy is still ${tenths(acc)}%.`,
    ]);
  });

  it('as Black: the same count from the mirrored evaluations', () => {
    const { plies } = reportGame(true);
    const sum = summarizeGame(START_FEN, cp(15), plies, 'b');
    expect(sum.counts.b.inaccuracy).toBe(9);
    expect(sum.alreadyWon?.b).toEqual({ inaccuracy: 7 });
    expect(sum.alreadyWon?.w).toEqual({});
    expect(reviewAccuracyNotes(sum, 'b', 'Pip')[0]).toMatch(/^7 of your 9 inaccuracies came when you were already winning/);
  });

  it('the wording: one, both, all, some of several classes; the opponent; a lower or unknown accuracy', () => {
    const note = (counts: Partial<Record<MoveClass, number>>, alreadyWon: Partial<Record<MoveClass, number>>, accuracy: number | null, who = 'you') =>
      alreadyWonNote({ counts, alreadyWon, accuracy, who, decimals: 1 });
    expect(note({ inaccuracy: 1 }, { inaccuracy: 1 }, 98.96)).toBe(
      'Your inaccuracy came when you were already winning, so it didn’t lower your winning chances — that’s why your accuracy is still 99.0%.',
    );
    expect(note({ inaccuracy: 2 }, { inaccuracy: 2 }, 97)).toMatch(/^Both of your inaccuracies came when/);
    expect(note({ inaccuracy: 9 }, { inaccuracy: 9 }, 99.1)).toMatch(/^All 9 of your inaccuracies came when you were already winning, so they/);
    // Fewer than half of them: no "that’s why" (the accuracy is not theirs to explain).
    expect(note({ inaccuracy: 9 }, { inaccuracy: 1 }, 92.3)).toBe(
      '1 of your 9 inaccuracies came when you were already winning, so it didn’t lower your winning chances.',
    );
    expect(note({ inaccuracy: 6, mistake: 2 }, { inaccuracy: 3 }, 95)).toMatch(/so they didn’t lower your winning chances\.$/);
    expect(note({ inaccuracy: 6 }, { inaccuracy: 3 }, 95)).toMatch(/that’s why your accuracy is still 95\.0%\.$/);
    expect(note({ inaccuracy: 9, mistake: 1 }, { inaccuracy: 7, mistake: 1 }, 95)).toMatch(
      /^7 of your 9 inaccuracies and your mistake came when you were already winning, so they didn’t/,
    );
    expect(note({ inaccuracy: 6 }, { inaccuracy: 4 }, 95.04, 'Pip')).toBe(
      '4 of Pip’s 6 inaccuracies came when Pip was already winning, so they didn’t lower Pip’s winning chances — that’s why Pip’s accuracy is still 95.0%.',
    );
    // Below 90 (or unknown): it did not lower the accuracy, without "that’s why".
    expect(note({ inaccuracy: 5 }, { inaccuracy: 2 }, 72.4)).toBe(
      '2 of your 5 inaccuracies came when you were already winning, so they didn’t lower your winning chances or your accuracy.',
    );
    expect(note({ inaccuracy: 5 }, { inaccuracy: 2 }, null)).toMatch(/or your accuracy\.$/);
    // Whole numbers, and the threshold on the accuracy as shown (89.96 shows as 90.0).
    expect(alreadyWonNote({ counts: { inaccuracy: 9 }, alreadyWon: { inaccuracy: 7 }, accuracy: 99.4, who: 'you', decimals: 0 })).toMatch(
      /still 99%\.$/,
    );
    expect(note({ inaccuracy: 3 }, { inaccuracy: 3 }, 89.96)).toMatch(/that’s why your accuracy is still 90\.0%\.$/);
    expect(note({ inaccuracy: 3 }, { inaccuracy: 3 }, 89.94)).toMatch(/or your accuracy\.$/);
    // Never when none came in a won game.
    expect(note({ inaccuracy: 5 }, {}, 99)).toBeNull();
    expect(note({ inaccuracy: 5 }, { inaccuracy: 0 }, 99)).toBeNull();
    expect(alreadyWonNote({ counts: { inaccuracy: 5 }, alreadyWon: undefined, accuracy: 99, who: 'you', decimals: 1 })).toBeNull();
    expect(reviewAccuracyNotes({ accuracy: { w: 99, b: 40 }, counts: { w: { inaccuracy: 3 }, b: {} } }, 'w', 'Pip')).toEqual([]);
  });

  it('the game-over sheet’s short form (under "You: 9 inaccuracies")', () => {
    const sheet = (counts: Partial<Record<MoveClass, number>>, alreadyWon: Partial<Record<MoveClass, number>>) => alreadyWonSheetNote({ counts, alreadyWon });
    expect(sheet({ inaccuracy: 9 }, { inaccuracy: 7 })).toBe('7 of them came when you were already winning, so they didn’t lower your accuracy.');
    expect(sheet({ inaccuracy: 9, mistake: 1 }, { inaccuracy: 1 })).toBe('1 of them came when you were already winning, so it didn’t lower your accuracy.');
    expect(sheet({ inaccuracy: 1 }, { inaccuracy: 1 })).toBe('It came when you were already winning, so it didn’t lower your accuracy.');
    expect(sheet({ inaccuracy: 2 }, { inaccuracy: 2 })).toMatch(/^Both came when/);
    expect(sheet({ inaccuracy: 3, blunder: 1 }, { inaccuracy: 3, blunder: 1 })).toMatch(/^All 4 came when/);
    expect(sheet({ inaccuracy: 3 }, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The game viewer (an older record)

/** A history record of `plies`; `older`: kept before the history stored `wonAnyway`. */
function recordOf(plies: Ply[], startEval: Score | null, older = false): GameRecord {
  const c = new Chess();
  for (const p of plies) c.move(p.san);
  return {
    id: 'r1',
    date: new Date(0).toISOString(),
    playerColor: 'w',
    botName: PIP.name,
    botId: 'pip',
    botElo: PIP.elo,
    result: '1-0',
    playerScore: 1,
    rated: true,
    ratingBefore: 800,
    ratingAfter: 810,
    reason: 'Checkmate',
    pgn: c.pgn(),
    analysis: (({ w: _w, ...a }) => (older ? a : { ...a, w: 1 as const }))(encodeAnalysis(plies, startEval, { playerColor: 'w' })),
  };
}

describe('the game viewer: a record kept before the history stored the reasons', () => {
  const ctx: ViewerContext = { locked: new Set(), drawColor: 'green' };
  // An older record: no wonAnyway (the history did not keep it then), its evaluations only.
  const plies = gamePlies().map((p) => {
    const { wonAnyway: _w, ...cl } = p.classification!;
    return { ...p, classification: cl };
  });

  it('the line and the note from the evaluations kept', () => {
    const record = recordOf(plies, cp(30), true);
    const game = archivedGame(record)!;
    // Judged from the evaluations kept (mate in 3 before, still mating after).
    expect(game.plies[8].classification?.wonAnyway).toEqual({ kind: 'slower', mateIn: 3 });
    const v = { ...openViewer({ record, game, bot: PIP, session: 1 }), cursor: 9 };
    // A key moment to try again: the better move hidden until it is shown.
    expect(viewerView(v, ctx).coach.lines).toContain(FASTER_HIDDEN);
    const shown = { ...ctx, revealed: new Set([tryKey('r1', 8)]) };
    expect(viewerView(v, shown).coach.lines).toContain(FASTER);
    // A rated game on the board: hidden too.
    expect(viewerView(v, { ...shown, ratedGame: true }).coach.lines).toContain(FASTER_HIDDEN);
    const report = viewerView({ ...v, report: true, review: { progress: null, failed: 0 } }, ctx).report!;
    expect(report.accuracyNotes).toHaveLength(1);
    expect(report.accuracyNotes![0]).toMatch(/^Both of your inaccuracies came when you were already winning/);
  });

  it('no evaluation before the move: no reason, no note', () => {
    // The first move an inaccuracy, the start position never evaluated.
    const first = plies.map((p, i) =>
      i === 0 ? { ...p, evalWhite: mate(9), classification: verdict('inaccuracy', { bestMoveUci: 'd2d4', bestMoveSan: 'd4', playedMoveSan: 'e4' }) } : p,
    );
    const others = first.map((p) => (p.index === 6 || p.index === 8 ? { ...p, classification: verdict('best') } : p));
    const record = recordOf(others, null, true);
    const game = archivedGame(record)!;
    const v = { ...openViewer({ record, game, bot: PIP, session: 1 }), cursor: 1 };
    expect(viewerView(v, ctx).coach.lines.join(' ')).not.toMatch(/winning anyway/);
    expect(viewerView({ ...v, report: true, review: { progress: null, failed: 0 } }, ctx).report!.accuracyNotes).toBeUndefined();
  });
});

describe('the game viewer: a record kept now', () => {
  const ctx: ViewerContext = { locked: new Set(), drawColor: 'green' };

  it('the coach’s own verdict: the line where it said so, none where it did not', () => {
    const record = recordOf(gamePlies(), cp(30));
    const game = archivedGame(record)!;
    expect(game.plies[8].classification?.wonAnyway).toEqual({ kind: 'slower', mateIn: 3 });
    // 4.Ng5: the coach did not call it won anyway (no guess from the evaluations).
    expect(game.plies[6].classification?.wonAnyway).toBeUndefined();
    const shown = { ...ctx, revealed: new Set([tryKey('r1', 8), tryKey('r1', 6)]) };
    const v = openViewer({ record, game, bot: PIP, session: 1 });
    expect(viewerView({ ...v, cursor: 9 }, shown).coach).toMatchObject({ summary: 'Still winning: a faster mate was available.' });
    expect(viewerView({ ...v, cursor: 9 }, shown).coach.lines).toContain(FASTER);
    expect(viewerView({ ...v, cursor: 7 }, shown).coach.lines.join(' ')).not.toMatch(/winning anyway/);
  });
});
