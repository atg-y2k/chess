/**
 * Earlier games (game/archive.ts): the compact analysis the history keeps (round trip, malformed
 * data, key moments' headlines), the moves from the stored PGN (a custom start, none at all), the
 * opponent of a record, the annotated export, and what a game costs in storage (a 60-move game and
 * 200 of them, measured).
 */
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { Classification, MoveClass } from '../../src/analysis/types';
import { mulberry32 } from '../../src/bot/strength';
import { START_FEN } from '../../src/chess/utils';
import type { Score } from '../../src/engine/types';
import {
  analysisComplete,
  archivePgn,
  archivedGame,
  decodeAnalysis,
  decodeScore,
  encodeAnalysis,
  encodeScore,
  mergeAnalysis,
  pgnPlies,
  recordBot,
  sameAnalysis,
} from '../../src/game/archive';
import { buildPgn } from '../../src/game/pgn';
import type { Ply } from '../../src/game/types';
import { HISTORY_LIMIT, PROFILE_KEY, applyGameResult, defaultProfile, loadProfile, saveProfile } from '../../src/rating/rating';
import type { GameRecord, PlayerProfile } from '../../src/rating/types';
import { MemoryStorage } from '../helpers/fakeEngine';

/** Plies of a game from UCI moves (no analysis). */
function pliesOf(moves: readonly string[], startFen = START_FEN): Ply[] {
  const chess = new Chess(startFen);
  return moves.map((uci, index) => {
    const mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    const p: Ply = { index, color: mv.color, san: mv.san, uci, fenBefore: mv.before, fenAfter: mv.after };
    if (mv.captured) p.captured = mv.captured;
    return p;
  });
}

const cl = (cls: MoveClass, over: Partial<Classification> = {}): Classification => ({
  cls,
  winBefore: 0.5,
  winAfter: 0.5,
  winLoss: 0,
  accuracy: 100,
  bestMoveUci: null,
  bestMoveSan: null,
  playedMoveSan: '',
  ...over,
});

const cp = (value: number): Score => ({ kind: 'cp', value });

/** 1. e4 e5 2. Qh5 Nc6 3. Qxf7+?? Kxf7: annotated as the coach would. */
function annotatedBlunder(): Ply[] {
  const ps = pliesOf(['e2e4', 'e7e5', 'd1h5', 'b8c6', 'h5f7', 'e8f7']);
  const notes: [MoveClass, Score, Partial<Classification>, string?, 'material'?][] = [
    ['book', cp(30), {}],
    ['book', cp(35), {}],
    ['inaccuracy', cp(-10), { bestMoveUci: 'g1f3', nearBest: false }, 'Qh5 brings the queen out early.'],
    ['good', cp(20), { bestMoveUci: 'g8f6', nearBest: true }],
    ['blunder', cp(-650), { bestMoveUci: 'g1f3' }, 'Qxf7+ grabs a pawn, but it hangs your queen on f7.'],
    ['best', { kind: 'mate', value: -12 }, {}],
  ];
  return ps.map((p, i) => {
    const [cls, evalWhite, over, headline, concedes] = notes[i];
    const q: Ply = { ...p, classification: cl(cls, { ...over, playedMoveSan: p.san }), evalWhite, evalDepth: 14 };
    if (headline) q.explanation = { headline, details: ['A detail the history does not keep.'], ...(concedes ? { concedes } : {}) };
    return q;
  });
}

describe('compact analysis', () => {
  it('writes scores as short tokens and reads them back', () => {
    expect(encodeScore(cp(34))).toBe('34');
    expect(encodeScore(cp(-120.4))).toBe('-120');
    expect(encodeScore(cp(-0))).toBe('0');
    expect(encodeScore({ kind: 'mate', value: 3 })).toBe('#3');
    expect(encodeScore({ kind: 'mate', value: -2 })).toBe('#-2');
    expect(encodeScore({ kind: 'mate', value: -0 })).toBe('#0');
    expect(encodeScore(null)).toBe('');
    expect(decodeScore('34')).toEqual(cp(34));
    expect(decodeScore('#-2')).toEqual({ kind: 'mate', value: -2 });
    expect(decodeScore('')).toBeNull();
    expect(decodeScore('3.5')).toBeNull();
    expect(decodeScore('#x')).toBeNull();
  });

  it('round trip: class, evaluation, the better move, near-equal flags and the key moments’ headlines', () => {
    const plies = annotatedBlunder();
    const a = encodeAnalysis(plies, cp(18), { playerColor: 'w' });
    expect(a).toEqual({
      v: 1,
      s: '18',
      p: 'k30 k35 i-10:g1f3 g20n:g8f6 b-650:g1f3 s#-12',
      h: { '2': 'Qh5 brings the queen out early.', '4': 'Qxf7+ grabs a pawn, but it hangs your queen on f7.' },
      // The tokens say which weak moves a won game made all but free (none here).
      w: 1,
    });
    const back = decodeAnalysis(pliesOf(plies.map((p) => p.uci)), a);
    expect(back.startEval).toEqual(cp(18));
    expect(back.plies.map((p) => p.classification?.cls)).toEqual(['book', 'book', 'inaccuracy', 'good', 'blunder', 'best']);
    expect(back.plies.map((p) => p.evalWhite)).toEqual(plies.map((p) => p.evalWhite));
    expect(back.plies[0].isBook).toBe(true);
    expect(back.plies[4].classification).toMatchObject({ bestMoveUci: 'g1f3', bestMoveSan: 'Nf3', playedMoveSan: 'Qxf7+' });
    expect(back.plies[3].classification).toMatchObject({ nearBest: true, bestMoveSan: 'Nf6' });
    expect(back.plies[3].classification?.aboveBest).toBeUndefined();
    // The best move itself: its own move as the best one.
    expect(back.plies[5].classification).toMatchObject({ bestMoveUci: 'e8f7', bestMoveSan: 'Kxf7' });
    // Win chances from the evaluations: the blunder lost almost everything White had.
    const b = back.plies[4].classification!;
    expect(b.winBefore).toBeGreaterThan(0.5);
    expect(b.winAfter).toBeLessThan(0.1);
    expect(b.winLoss).toBeCloseTo(b.winBefore - b.winAfter, 10);
    expect(b.accuracy).toBeLessThan(20);
    // Headlines only (the details are not kept); no explanation for a move that is not a key moment.
    expect(back.plies[4].explanation).toEqual({ headline: 'Qxf7+ grabs a pawn, but it hangs your queen on f7.', details: [] });
    expect(back.plies[3].explanation).toBeUndefined();
    expect(analysisComplete(back.plies)).toBe(true);
    // Encoding the decoded plies again gives the same analysis (nothing drifts across saves).
    expect(sameAnalysis(encodeAnalysis(back.plies, back.startEval, { playerColor: 'w' }), a)).toBe(true);
  });

  it('keeps what a move gives away, at least as good, and a checkmate', () => {
    const ps = pliesOf(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    ps[0] = { ...ps[0], classification: cl('good', { bestMoveUci: 'e2e4', nearBest: true, aboveBest: true }), evalWhite: cp(0) };
    ps[1] = { ...ps[1], classification: cl('excellent'), evalWhite: cp(-20), explanation: { headline: 'e5 gives up a pawn.', details: [], concedes: 'material' } };
    ps[2] = { ...ps[2], classification: cl('blunder', { bestMoveUci: 'e2e4' }), evalWhite: { kind: 'mate', value: -1 }, explanation: { headline: 'g4 allows mate.', details: [] } };
    ps[3] = { ...ps[3], classification: cl('best'), evalWhite: { kind: 'mate', value: -0 } };
    const a = encodeAnalysis(ps, null, { playerColor: 'b' });
    expect(a.p).toBe('g0a:e2e4 e-20c b#-1:e2e4 s#0');
    expect(a.s).toBe('');
    const back = decodeAnalysis(pliesOf(ps.map((p) => p.uci)), a).plies;
    expect(back[0].classification).toMatchObject({ nearBest: true, aboveBest: true });
    expect(back[1].explanation).toEqual({ headline: 'e5 gives up a pawn.', details: [], concedes: 'material' });
    // Mate delivered: the mover won (the checkmated side is to move).
    expect(back[3].classification).toMatchObject({ winAfter: 1, winLoss: 0 });
    expect(back[3].evalWhite).toEqual({ kind: 'mate', value: 0 });
  });

  it('leaves a move without a verdict as it is, and ignores malformed or mismatched data', () => {
    const ps = pliesOf(['e2e4', 'e7e5', 'g1f3']);
    const partial = encodeAnalysis([{ ...ps[0], classification: cl('book'), evalWhite: cp(30) }, ps[1], ps[2]], null, { playerColor: 'w' });
    expect(partial.p).toBe('k30 - -');
    const back = decodeAnalysis(ps, partial).plies;
    expect(back[0].classification?.cls).toBe('book');
    expect(back[1].classification).toBeUndefined();
    expect(analysisComplete(back)).toBe(false);
    // A token that does not parse, a class code that does not exist, an illegal better move.
    const odd = decodeAnalysis(ps, { v: 1, s: 'x', p: 'k30 zz q12 ' }).plies;
    expect(odd.map((p) => p.classification)).toEqual([undefined, undefined, undefined]);
    const wrongBest = decodeAnalysis(ps, { v: 1, s: '', p: 'k30 b-200:e2e4 s10' }).plies;
    expect(wrongBest[1].classification).toMatchObject({ cls: 'blunder', bestMoveUci: 'e7e5', bestMoveSan: 'e5' });
    const decoded = decodeAnalysis(ps, { v: 1, s: '15', p: 'k30 k30' });
    expect(decoded.plies.some((p) => p.classification)).toBe(false); // two tokens for three moves
    expect(decoded.startEval).toBeNull();
    expect(decodeAnalysis(ps, undefined).plies).toEqual(ps);
  });

  it('leaves the moves played before the game out of the key moments and of completeness', () => {
    const ps = annotatedBlunder();
    const pre = [ps[0], ps[1], ...ps.slice(2)].map((p, i) => (i < 2 ? { ...p, classification: cl('book'), evalWhite: undefined } : p));
    expect(analysisComplete(pre)).toBe(false);
    expect(analysisComplete(pre, 2)).toBe(true);
    expect(Object.keys(encodeAnalysis(pre, null, { playerColor: 'w', preplayed: 2 }).h ?? {})).toEqual(['2', '4']);
  });
});

describe('merging a compact analysis into the record’s', () => {
  it('never replaces a verdict (or an evaluation) with an unknown one, and keeps its headline', () => {
    const kept = { v: 1 as const, s: '20', p: 'k20 k15 b-650:g1f3 f-640', h: { '2': 'This hangs your queen.' } };
    // A stale copy: the last two moves not checked yet.
    const stale = { v: 1 as const, s: '', p: 'k20 k15 - -' };
    const merged = mergeAnalysis(kept, stale);
    expect(merged).toEqual(kept);
    expect(sameAnalysis(kept, merged)).toBe(true);
    // An evaluation without a verdict still beats nothing, and loses to a verdict.
    expect(mergeAnalysis({ v: 1, s: '', p: '-30 -' }, { v: 1, s: '', p: '- k10' }).p).toBe('-30 k10');
  });

  it('takes what the newer analysis knows, with its headlines', () => {
    const kept = { v: 1 as const, s: '20', p: 'k20 - -' };
    const next = { v: 1 as const, s: '20', p: 'k20 m-90:g1f3 f-80', h: { '1': 'This loses a pawn.' } };
    expect(mergeAnalysis(kept, next)).toEqual(next);
    // A verdict checked again wins, with its own headline (the old one goes with the old verdict).
    const again = mergeAnalysis({ v: 1, s: '', p: 'b-650:g1f3', h: { '0': 'Old.' } }, { v: 1, s: '', p: 'm-200:g1f3' });
    expect(again).toEqual({ v: 1, s: '', p: 'm-200:g1f3' });
    // The same verdict: a headline the record had stays.
    expect(mergeAnalysis({ v: 1, s: '', p: 'b-650', h: { '0': 'Kept.' } }, { v: 1, s: '', p: 'b-650' }).h).toEqual({ '0': 'Kept.' });
    // Another game's length (never mixed) or nothing kept: the newer one as it is.
    expect(mergeAnalysis({ v: 1, s: '', p: 'k1 k2' }, next)).toEqual(next);
    expect(mergeAnalysis(undefined, next)).toBe(next);
  });
});

describe('recorded games', () => {
  const record = (over: Partial<GameRecord> = {}): GameRecord => ({
    id: 'g1',
    date: '2026-10-12T10:00:00.000Z',
    playerColor: 'w',
    botName: 'Pip',
    botElo: 100,
    result: '0-1',
    playerScore: 0,
    rated: true,
    ratingBefore: 800,
    ratingAfter: 780,
    reason: 'Resignation',
    pgn: '',
    ...over,
  });

  it('replays the moves of the stored PGN, from a custom start too', () => {
    const plies = annotatedBlunder();
    const pgn = buildPgn({
      startFen: START_FEN,
      plies,
      white: { name: 'You', elo: 800 },
      black: { name: 'Pip', elo: 100 },
      date: new Date(2026, 9, 12),
      result: '0-1',
      termination: 'Resignation',
    });
    const moves = pgnPlies(pgn)!;
    expect(moves.startFen).toBe(START_FEN);
    expect(moves.plies.map((p) => p.uci)).toEqual(plies.map((p) => p.uci));
    expect(moves.plies.map(({ index, color, san, uci, fenBefore, fenAfter }) => ({ index, color, san, uci, fenBefore, fenAfter }))).toEqual(
      plies.map(({ index, color, san, uci, fenBefore, fenAfter }) => ({ index, color, san, uci, fenBefore, fenAfter })),
    );
    expect(moves.plies[5].captured).toBe('q');
    expect(moves.headers).toMatchObject({ White: 'You', Black: 'Pip', Termination: 'Resignation' });

    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3';
    const custom = pliesOf(['h5f7', 'e8f7'], fen);
    const fromFen = pgnPlies(
      buildPgn({ startFen: fen, plies: custom, white: { name: 'You' }, black: { name: 'Pip' }, date: new Date(), result: '0-1' }),
    )!;
    expect(fromFen.startFen).toBe(fen);
    expect(fromFen.plies.map((p) => p.san)).toEqual(['Qxf7+', 'Kxf7']);
    expect(fromFen.plies[0].index).toBe(0);
  });

  it('a record without moves (dropped to save space) or with an unreadable PGN has none', () => {
    expect(pgnPlies('')).toBeNull();
    expect(pgnPlies('1. e4 e5 2. Ke9')).toBeNull();
    expect(archivedGame(record({ pgn: '' }))).toBeNull();
  });

  it('applies the record’s analysis, and exports the annotated PGN (else the stored one)', () => {
    const plies = annotatedBlunder();
    const pgn = buildPgn({
      startFen: START_FEN,
      plies,
      white: { name: 'You', elo: 800 },
      black: { name: 'Pip', elo: 100 },
      date: new Date(2026, 9, 12),
      result: '0-1',
      termination: 'Resignation',
      event: 'Chess Coach',
    });
    const r = record({ pgn, analysis: encodeAnalysis(plies, cp(18), { playerColor: 'w' }) });
    const g = archivedGame(r)!;
    expect(g.startEval).toEqual(cp(18));
    expect(g.plies[4].classification?.cls).toBe('blunder');
    const out = archivePgn(r, g);
    expect(out).toContain('[White "You"]');
    expect(out).toContain('[WhiteElo "800"]');
    expect(out).toContain('[Date "2026.10.12"]');
    expect(out).toContain('[Termination "Resignation"]');
    expect(out).toContain('3. Qxf7+ $4 { [%eval -6.50] }');
    expect(out).toContain('2. Qh5 $6');
    // Not analyzed: the stored PGN as it is.
    const plain = record({ pgn });
    expect(archivePgn(plain, archivedGame(plain))).toBe(pgn);
  });

  it('finds the opponent by its id, else by its name, else a custom one at its Elo', () => {
    expect(recordBot({ botId: 'rocco', botName: 'Whoever', botElo: 400 }).id).toBe('rocco');
    expect(recordBot({ botName: 'Pip', botElo: 100 }).id).toBe('pip');
    expect(recordBot({ botId: 'custom', botName: 'Robot 850', botElo: 850 })).toMatchObject({ id: 'custom', name: 'Robot 850', elo: 850 });
    expect(recordBot({ botName: 'Robot 1250', botElo: 1250 })).toMatchObject({ id: 'custom', elo: 1250 });
  });
});

describe('storage size', () => {
  /** A 60-move game (120 plies) with a verdict on every move and a headline on each key moment. */
  function longGame(): { plies: Ply[]; pgn: string } {
    for (let seed = 1; ; seed++) {
      const rng = mulberry32(seed);
      const chess = new Chess();
      const moves: string[] = [];
      while (moves.length < 120 && !chess.isGameOver()) {
        const legal = chess.moves({ verbose: true });
        const mv = legal[Math.floor(rng() * legal.length)];
        chess.move(mv);
        moves.push(mv.from + mv.to + (mv.promotion ?? ''));
      }
      if (moves.length < 120) continue;
      const classes: MoveClass[] = ['best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder', 'great', 'best', 'excellent', 'good'];
      const plies = pliesOf(moves).map((p, i): Ply => {
        const cls = i < 6 ? 'book' : classes[Math.floor(rng() * classes.length)];
        const alt = new Chess(p.fenBefore).moves({ verbose: true }).find((m) => m.from + m.to !== p.uci.slice(0, 4));
        const best = cls === 'best' || cls === 'book' || !alt ? null : alt.from + alt.to + (alt.promotion ?? '');
        return {
          ...p,
          evalWhite: cp(Math.round((rng() - 0.5) * 900)),
          evalDepth: 14,
          classification: cl(cls, { bestMoveUci: best, nearBest: cls === 'excellent' }),
          explanation: {
            headline: `${p.san} ${cls === 'blunder' ? 'hangs your knight on f6, and the bishop on c4 falls next.' : 'keeps the balance in the center.'}`,
            details: ['Engine line: a long variation the history never keeps.'],
          },
        };
      });
      const pgn = buildPgn({
        startFen: START_FEN,
        plies,
        white: { name: 'You', elo: 1234 },
        black: { name: 'Professor Hoot', elo: 1450 },
        date: new Date(2026, 9, 12),
        result: '1-0',
        termination: 'Checkmate',
        opening: { eco: 'C50', name: 'Italian Game: Giuoco Piano' },
      });
      return { plies, pgn };
    }
  }

  function profileWith(games: number, game: { plies: Ply[]; pgn: string }): PlayerProfile {
    let p = defaultProfile();
    const analysis = encodeAnalysis(game.plies, cp(18), { playerColor: 'w' });
    for (let i = 0; i < games; i++) {
      const { profile } = applyGameResult(p, {
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        date: new Date(2026, 9, 12, 10, i).toISOString(),
        playerColor: 'w',
        botName: 'Professor Hoot',
        botElo: 1450,
        botId: 'professor-hoot',
        result: '1-0',
        playerScore: 1,
        rated: true,
        reason: 'Checkmate',
        pgn: game.pgn,
        accuracy: 87.4,
        analysis,
      });
      p = profile;
    }
    return p;
  }

  it('a 60-move analyzed game takes under 5 KB, and 200 of them under 1 MB', () => {
    const game = longGame();
    const analysis = encodeAnalysis(game.plies, cp(18), { playerColor: 'w' });
    const one = profileWith(1, game).history[0];
    const sizes = {
      analysis: JSON.stringify(analysis).length,
      pgn: game.pgn.length,
      record: JSON.stringify(one).length,
    };
    expect(sizes.analysis).toBeLessThan(2_600);
    expect(sizes.record).toBeLessThan(5_000);
    const storage = new MemoryStorage();
    const full = profileWith(HISTORY_LIMIT, game);
    expect(saveProfile(full, storage)).toBe(true);
    const stored = storage.getItem(PROFILE_KEY)!.length;
    expect(stored).toBeLessThan(1_000_000);
    // Loading 200 games is quick: the analyses stay strings until a game is opened.
    const t0 = performance.now();
    const back = loadProfile(storage);
    expect(performance.now() - t0).toBeLessThan(250);
    expect(back.history).toHaveLength(HISTORY_LIMIT);
    expect(back.history[199].analysis?.p).toBe(analysis.p);
    // Measured (ARCHITECTURE "Persistence"): analysis ~1.8K chars, PGN ~1K, record ~3.1K; 200 games ~620K.
    expect(sizes.pgn).toBeLessThan(1_500);
  });
});
