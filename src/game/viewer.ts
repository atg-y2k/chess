/**
 * The game viewer (README "Your games"): one of the player's earlier games from the history, opened
 * from the Menu's Recent games or a point of the rating chart. A full screen of its own over the
 * game: the header (opponent, date, result, rated or not, rating change, accuracy), the board with
 * the evaluation bar, the eval graph and the move list, step controls (and a swipe), Flip, Draw mode,
 * Export PGN, Review (Game Review of that game: analyzed on demand when its record has no analysis),
 * Try again on its key moments and Play from here.
 *
 * This module is the pure part: the viewer's state (`GameViewer`, kept by the controller in
 * `store.viewer`), its transitions, and its view model (`viewerView`, what ui/GameViewer.tsx
 * renders). The viewer never touches the game on the board or the rating: it reads a record of the
 * history (and writes back only its analysis and accuracy).
 */
import { formatScore, whiteBarFraction } from '../analysis/winprob';
import { isNearBest, equalAlternatives } from '../analysis/nearEqual';
import type { Arrow, MoveClass } from '../analysis/types';
import type { BotPersona } from '../bot/types';
import { START_FEN, capturedByMoves, capturedPieces, fenKey, material, otherColor, toWhitePov } from '../chess/utils';
import type { Score } from '../engine/types';
import { formatGameDate, recordOutcome } from '../rating/history';
import { formatRatingDelta } from '../rating/rating';
import type { GameRecord } from '../rating/types';
import type { EvalBarProps } from '../ui/EvalBar';
import type { PlayerStripProps } from '../ui/PlayerStrip';
import { CLASS_META } from '../ui/ClassIcon';
import { analysisComplete, type ArchivedGame } from './archive';
import {
  KEY_CLASSES,
  TOP_CLASSES,
  UNLOCK_LABEL,
  answerFreeLines,
  concession,
  lockedTeaser,
  moveLabel,
  namesMove,
  offersShowBest,
  verdictTitle,
} from './coach';
import { DRAW_COLORS, NO_DRAWINGS, NO_SHAPES, shapesAt, type DrawColor, type Drawings } from './drawings';
import type { ProFeature } from './entitlements';
import { practiceMoments, tryKey, type PracticeGame } from './practice';
import { summarizeGame } from './review';
import {
  explanationLines,
  positionInfo,
  uciArrow,
  winForWhite,
  type BoardView,
  type DrawView,
  type MoveListView,
  type ReviewView,
} from './store';
import type { Color, Ply } from './types';

/** One earlier game open in the viewer (see the module comment). */
export interface GameViewer {
  /** The record's id (`GameRecord.id`). */
  id: string;
  /** The record as it was when opened, with the analysis and accuracy the viewer saved since. */
  record: GameRecord;
  /** Its moves and analysis; null when the moves were not kept (the PGN was dropped to save space). */
  game: ArchivedGame | null;
  /** The opponent (archive.ts `recordBot`). */
  bot: BotPersona;
  /** Opening practice: the moves the game started with (never analyzed). */
  preplayed: number;
  /** Plies on the board (0: the start position). Opens on the final position. */
  cursor: number;
  flipped: boolean;
  /**
   * Game Review was asked for: the board shows the better move's arrow and the move list every icon;
   * `progress` (0..1) while the engine analyzes the moves the record had no verdict for, null once done;
   * `failed`, moves the engine could not check.
   */
  review: { progress: number | null; failed: number } | null;
  /** The panel shows the review's report (accuracy, counts, key moments) instead of the comment on the move. */
  report: boolean;
  /** Bumped for every game opened: the board's session, and late analyses of another one are dropped. */
  session: number;
  /** Opened from the Menu: closing the viewer goes back to it. */
  from: 'menu' | null;
  /** Draw mode on the viewer's board, its first-use tip, and the drawings (by position, forgotten on close). */
  draw: { on: boolean; tip: boolean };
  drawings: Drawings;
  /**
   * Moves whose comment is only what the history keeps of it (the verdict, and a key moment's
   * headline): when one is shown, the coach looks at it again for the whole comment
   * (GameController `kickViewerExplain`), and it leaves this set.
   */
  brief: ReadonlySet<number>;
  /** The move whose comment the coach is writing again (its searches are running), else null. */
  explaining: number | null;
}

/**
 * A viewer on `record` (at its final position, the report closed). `full`: the plies carry their
 * whole explanations (the game on the board), so no comment needs writing again.
 */
export function openViewer(o: {
  record: GameRecord;
  game: ArchivedGame | null;
  bot: BotPersona;
  session: number;
  from?: 'menu' | null;
  preplayed?: number;
  full?: boolean;
}): GameViewer {
  const plies = o.game?.plies.length ?? 0;
  const preplayed = Math.min(Math.max(0, o.preplayed ?? o.record.preplayed ?? 0), plies);
  const brief = new Set<number>();
  if (!o.full) for (const p of o.game?.plies ?? []) if (p.index >= preplayed && p.classification) brief.add(p.index);
  return {
    id: o.record.id,
    record: o.record,
    game: o.game,
    bot: o.bot,
    preplayed,
    cursor: plies,
    flipped: false,
    review: null,
    report: false,
    session: o.session,
    from: o.from ?? null,
    draw: { on: false, tip: false },
    drawings: NO_DRAWINGS,
    brief,
    explaining: null,
  };
}

/** The move whose comment is shown when it is only the record's brief one (see `GameViewer.brief`), else null. */
export function briefPlyShown(v: GameViewer): Ply | null {
  const ply = v.cursor > 0 ? (v.game?.plies[v.cursor - 1] ?? null) : null;
  const cls = ply?.classification?.cls;
  if (!ply || !cls || !v.brief.has(ply.index) || cls === 'book' || cls === 'forced') return null;
  return ply;
}

/** Ply `index` of the viewer's game with its verdict, explanation and evaluation (a fresh analysis): no longer brief. */
export function withAnalyzedPly(v: GameViewer, index: number, patch: Partial<Ply>): GameViewer {
  const g = v.game;
  if (!g || !g.plies[index]) return v;
  const brief = new Set(v.brief);
  brief.delete(index);
  return {
    ...v,
    game: { ...g, plies: g.plies.map((p, k) => (k === index ? { ...p, ...patch } : p)) },
    brief,
    explaining: v.explaining === index ? null : v.explaining,
  };
}

/** The position after `n` plies (clamped). */
export function viewerGoTo(v: GameViewer, n: number): GameViewer {
  const max = v.game?.plies.length ?? 0;
  const cursor = Math.max(0, Math.min(max, Math.floor(n)));
  return cursor === v.cursor ? v : { ...v, cursor };
}

/** The FEN on the board. */
export function viewerFen(v: GameViewer): string {
  const g = v.game;
  if (!g) return START_FEN;
  return v.cursor > 0 ? g.plies[v.cursor - 1].fenAfter : g.startFen;
}

/** Every move after the ones the game started with has a verdict and an evaluation. */
export function viewerAnalyzed(v: GameViewer): boolean {
  return !!v.game && analysisComplete(v.game.plies, v.preplayed);
}

/** The game as Try again takes it (an earlier game: back to the viewer's review afterwards). */
export function viewerPracticeGame(v: GameViewer): PracticeGame | null {
  const g = v.game;
  if (!g) return null;
  return {
    id: v.id,
    startFen: g.startFen,
    playerColor: v.record.playerColor,
    bot: v.bot,
    botElo: v.record.botElo,
    plies: g.plies,
    startEval: g.startEval,
    ...(v.preplayed ? { preplayed: v.preplayed } : {}),
    source: 'archive',
  };
}

/** The review's summary of the game (the moves it started with left out). */
export function viewerSummary(v: GameViewer): ReturnType<typeof summarizeGame> | null {
  const g = v.game;
  if (!g) return null;
  const pre = v.preplayed;
  if (!pre) return summarizeGame(g.startFen, g.startEval, g.plies, v.record.playerColor);
  const ps = g.plies;
  return summarizeGame(ps[pre - 1].fenAfter, ps[pre - 1].evalWhite ?? null, ps.slice(pre), v.record.playerColor);
}

/** The viewer's coach actions (its panel's buttons). */
export type ViewerActionId = 'review' | 'tryAgain' | 'showBest' | 'unlock' | 'retryAnalysis';

export interface ViewerAction {
  id: ViewerActionId;
  label: string;
  primary?: boolean;
  locked?: boolean;
}

/** What the viewer shows (ui/GameViewer.tsx). */
export interface ViewerView {
  /** "Lost to Pip (100)". */
  title: string;
  result: 'win' | 'draw' | 'loss';
  /** The header's second line: date, how it ended, accuracy, and what kind of game it was (practice). */
  facts: string[];
  /**
   * The header's rating badge (as Recent games show it): a rated game's change ("−12", in its color)
   * and the rating after it, else "Unrated".
   */
  rating: { rated: true; delta: string; sign: number; after: number } | { rated: false };
  /** The dialog's name for assistive technology. */
  label: string;
  /** The moves were not kept: only the header shows. */
  missing: boolean;
  board: BoardView;
  evalBar: EvalBarProps;
  graph: { points: (number | null)[]; current: number; markers: { index: number; cls: MoveClass }[] };
  moveList: MoveListView;
  top: PlayerStripProps;
  bottom: PlayerStripProps;
  /** The review's report while it is on show (else null). */
  report: ReviewView | null;
  /** The comment on the move on the board (or on the game). */
  coach: { title: string; titleMove?: string; cls?: MoveClass; lines: string[]; busy: boolean; actions: ViewerAction[] };
  toolbar: {
    prev: boolean;
    next: boolean;
    /** 'Review' before the review is asked for, else 'Report' (`active` while the report shows). */
    review: { label: 'Review' | 'Report'; active: boolean; disabled: boolean };
    playHere: boolean;
  };
  draw: DrawView;
  /** Hidden while a move of this game is tried again (the try is on the game screen). */
  cursor: number;
  plies: number;
}

/** What the view model needs besides the viewer. */
export interface ViewerContext {
  locked: ReadonlySet<ProFeature>;
  /** The Draw bar's color (the app's, kept for the session). */
  drawColor: DrawColor;
  /**
   * A rated game is in progress on the board: no help from the engine here either (an earlier game
   * can pass through its positions). The better moves, their arrows, new analysis and Try again wait
   * until it is over; the replay, the stored evaluations and verdicts, and the export stay.
   */
  ratedGame?: boolean;
  /** A game the player has moved in is in progress: Play here would abandon it. */
  gameInProgress?: boolean;
  /** The weak moves whose better move has been shown (`store.revealedTries`, practice.ts `tryKey`). */
  revealed?: ReadonlySet<string>;
}

/** The line saying what waits while a game is on the board (null when nothing does). */
export function viewerNotice(ctx: Pick<ViewerContext, 'ratedGame' | 'gameInProgress'>): string | null {
  if (ctx.ratedGame && ctx.gameInProgress) return 'Your rated game is still on: finish it to see the better moves here and to play from here.';
  if (ctx.ratedGame) return 'Your rated game is still on, so the better moves stay hidden here until it’s over.';
  if (ctx.gameInProgress) return 'Finish the game you’re playing to play from here.';
  return null;
}

/** The moves better than the one played that a line may name: the best one, and those about as good. */
function betterMoves(cl: NonNullable<Ply['classification']>): string[] {
  return [cl.bestMoveSan, ...(cl.equalBest ?? []).map((m) => m.san)].filter((san): san is string => !!san && san !== cl.playedMoveSan);
}

const NO_DESTS: Map<string, string[]> = new Map();
const NO_ARROWS: Arrow[] = [];
const HUMAN_EMOJI = '🙂';

function stripClass(p: Ply): Ply {
  if (!p.classification) return p;
  const { classification: _c, ...rest } = p;
  return rest;
}

/** The PGN's Event when it says what kind of game it was ("Opening practice: Italian Game", "Practice from move 12"). */
function gameKind(v: GameViewer): string | null {
  const e = v.game?.headers.Event;
  return e && e !== 'Chess Coach' ? e : null;
}

/** The view model of a viewer (see `ViewerView`). */
export function viewerView(v: GameViewer, ctx: ViewerContext): ViewerView {
  const r = v.record;
  const g = v.game;
  const plies = g?.plies ?? [];
  const human = r.playerColor;
  const result = recordOutcome(r);
  // The opponent's Elo is on its strip (a narrow header keeps the name whole).
  const opponent = v.bot.name;
  const title = result === 'win' ? `Won against ${opponent}` : result === 'loss' ? `Lost to ${opponent}` : `Draw with ${opponent}`;
  const summary = g && viewerAnalyzed(v) ? viewerSummary(v) : null;
  // Once every move is checked, the report's own figure (the record may hold an older one).
  const accuracy = summary?.accuracy[human] ?? r.accuracy ?? null;
  const facts = [
    formatGameDate(r.date),
    r.reason,
    accuracy != null ? `Accuracy ${Math.round(accuracy)}%` : '',
    gameKind(v) ?? '',
  ].filter(Boolean);
  const delta = r.ratingAfter - r.ratingBefore;
  const ratingText = r.rated ? `Rated: ${r.ratingBefore} → ${r.ratingAfter} (${formatRatingDelta(delta)})` : 'Unrated';
  const locked = (f: ProFeature) => ctx.locked.has(f);

  const fen = viewerFen(v);
  const pos = positionInfo(fen);
  const ply = v.cursor > 0 ? plies[v.cursor - 1] : null;
  const white = human === 'w';
  const orientation: 'white' | 'black' = white !== v.flipped ? 'white' : 'black';

  // --- the moves to try again (Pro: review details; never while a rated game is on)
  const tries =
    g && !locked('reviewDetails') && !ctx.ratedGame ? new Set(practiceMoments(viewerPracticeGame(v)!)) : new Set<number>();
  const revealed = (i: number) => !!ctx.revealed?.has(tryKey(v.id, i));

  // --- board: the move's badge, and with the review on the better move's arrow (Pro: review
  // details); a move to try again only once its answer was shown; none while a rated game is on
  let arrows = NO_ARROWS;
  const cl = ply?.classification;
  const arrowsShown = !!ply && (tries.has(ply.index) ? revealed(ply.index) : !!v.review);
  if (ply && cl && arrowsShown && !ctx.ratedGame && !locked('reviewDetails') && offersShowBest(cl, ply.uci)) {
    if (isNearBest(cl, ply.uci)) {
      arrows = cl.aboveBest
        ? NO_ARROWS
        : [...uciArrow(cl.bestMoveUci, 'best'), ...equalAlternatives(cl, ply.uci).flatMap((a) => uciArrow(a.uci, 'alt'))];
    } else arrows = uciArrow(cl.bestMoveUci, 'best');
  }
  const board: BoardView = { fen, orientation, dests: NO_DESTS, check: pos.check, arrows, session: `viewer:${v.session}` };
  if (ply) board.lastMove = [ply.uci.slice(0, 2), ply.uci.slice(2, 4)];
  if (ply && cl && !concession(ply)) board.badge = { square: ply.uci.slice(2, 4), cls: cl.cls };
  const shapes = shapesAt(v.drawings, fen);
  if (shapes !== NO_SHAPES) board.shapes = shapes;
  if (v.draw.on) board.drawColor = ctx.drawColor;

  // --- eval bar: what the analysis knows (never a live search)
  const known = (k: number): Score | null => (k > 0 ? (plies[k - 1]?.evalWhite ?? null) : (g?.startEval ?? null));
  const running = v.review?.progress != null;
  let evalBar: EvalBarProps;
  const drawnEnd = result === 'draw' && v.cursor === plies.length && plies.length > 0;
  if (pos.terminal || drawnEnd) {
    const s: Score = pos.terminal === 'checkmate' ? toWhitePov({ kind: 'mate', value: 0 }, fen) : { kind: 'cp', value: 0 };
    evalBar = { whiteWinProb: whiteBarFraction(s, pos.turn), label: formatScore(s, pos.turn), orientation };
  } else {
    const at = known(v.cursor);
    if (at) evalBar = { whiteWinProb: whiteBarFraction(at, pos.turn), label: formatScore(at, pos.turn), orientation };
    else {
      let earlier: Score | null = null;
      for (let k = v.cursor - 1; k >= 0 && !earlier; k--) earlier = known(k);
      evalBar = earlier
        ? { whiteWinProb: whiteBarFraction(earlier), label: formatScore(earlier), orientation, thinking: running }
        : { whiteWinProb: 0.5, label: '', orientation, ...(running ? { thinking: true } : { off: true, offLabel: 'Not analyzed' }) };
    }
  }

  // --- graph and move list
  const points: (number | null)[] = [g?.startEval ? winForWhite(g.startEval, g.startFen) : null];
  for (const p of plies) points.push(p.evalWhite ? winForWhite(p.evalWhite, p.fenAfter) : null);
  if (result === 'draw' && plies.length) points[points.length - 1] = 0.5;
  const markers = plies
    .filter((p) => p.classification && KEY_CLASSES.has(p.classification.cls) && !concession(p))
    .map((p) => ({ index: p.index + 1, cls: p.classification!.cls }));
  const moveList: MoveListView = {
    plies: plies.map((p) => (concession(p) ? stripClass(p) : p)),
    current: v.cursor,
    showClassIcons: true,
    iconSet: v.review ? 'all' : 'notable',
    emptyText: g ? 'No moves' : 'The moves weren’t kept',
  };

  // --- the players (their captures and material on the position shown)
  const moves = plies.slice(0, v.cursor);
  const captured = g && fenKey(g.startFen) === fenKey(START_FEN) ? capturedByMoves(moves) : capturedPieces(fen);
  const mat = material(fen);
  const strip = (c: Color, isHuman: boolean): PlayerStripProps => ({
    name: isHuman ? 'You' : v.bot.name,
    rating: isHuman ? r.ratingBefore : r.botElo,
    emoji: isHuman ? HUMAN_EMOJI : v.bot.emoji,
    ...(isHuman ? {} : { avatarColor: v.bot.color }),
    captured: captured[c],
    capturedColor: otherColor(c),
    materialDiff: Math.max(0, mat[c] - mat[otherColor(c)]),
    active: !!g && !pos.terminal && pos.turn === c && v.cursor < plies.length,
    ...(isHuman && !r.rated ? { unrated: true } : {}),
  });
  const you = strip(human, true);
  const them = strip(otherColor(human), false);

  // --- the review's report
  let report: ReviewView | null = null;
  if (v.report && g) {
    const sum = viewerSummary(v)!;
    const hide = locked('reviewDetails');
    const progress = v.review?.progress ?? null;
    report = {
      progress,
      // As in Game Review: the accuracy once every move is checked (the counts fill in as they are).
      accuracy: progress === null ? sum.accuracy : { w: null, b: null },
      counts: sum.counts,
      playerColor: human,
      names: human === 'w' ? { w: 'You', b: v.bot.name } : { w: v.bot.name, b: 'You' },
      keyMoments: hide ? [] : sum.keyMoments.map((m) => (tries.has(m.index) ? { ...m, tryAgain: true } : m)),
      ...(hide ? { lockedMoments: sum.keyMoments.length } : {}),
    };
  }

  return {
    title,
    result,
    facts,
    rating: r.rated ? { rated: true, delta: formatRatingDelta(delta), sign: Math.sign(delta), after: r.ratingAfter } : { rated: false },
    label: `${title} (${r.botElo}), ${[...facts, ratingText].join(', ')}`,
    missing: !g,
    board,
    evalBar,
    graph: { points, current: v.cursor, markers },
    moveList,
    top: v.flipped ? you : them,
    bottom: v.flipped ? them : you,
    report,
    coach: viewerCoach(v, ply, tries, revealed, ctx),
    toolbar: {
      prev: v.cursor > 0,
      next: !!g && v.cursor < plies.length,
      review: {
        label: v.review ? 'Report' : 'Review',
        active: v.report,
        // While a rated game is on, a game that would need the engine first waits.
        disabled: !g || plies.length === 0 || (!!ctx.ratedGame && !v.review && !viewerAnalyzed(v)),
      },
      // A game without moves has nothing to play on from; a game in progress would be abandoned.
      playHere: !!g && plies.length > 0 && !pos.terminal && !ctx.gameInProgress,
    },
    draw: {
      on: v.draw.on,
      color: ctx.drawColor,
      colors: DRAW_COLORS,
      canClear: shapes.length > 0,
      tip: v.draw.on && v.draw.tip,
      yourMove: false,
    },
    cursor: v.cursor,
    plies: plies.length,
  };
}

/**
 * The comment on the move on the board: its verdict, and (Pro) why and what was better. A move that
 * can be tried again keeps its better move hidden until it is shown (Show best, a try that ended),
 * and so does every move while a rated game is on (`viewerNotice` says why).
 */
function viewerCoach(
  v: GameViewer,
  ply: Ply | null,
  tries: ReadonlySet<number>,
  revealed: (index: number) => boolean,
  ctx: ViewerContext,
): ViewerView['coach'] {
  const g = v.game;
  const review: ViewerAction = { id: 'review', label: 'Game Review', primary: true };
  if (!g) {
    return {
      title: 'The moves of this game weren’t kept',
      lines: ['Your phone was running low on storage, so only the result was saved.'],
      busy: false,
      actions: [],
    };
  }
  const notice = viewerNotice(ctx);
  const noted = (lines: string[]): string[] => (notice ? [...lines, notice] : lines);
  const running = v.review?.progress != null;
  const analyzed = viewerAnalyzed(v);
  // A game the engine still has to check waits while a rated game is on.
  const canReview = !ctx.ratedGame || analyzed;
  if (!ply) {
    const lines = ['Step through the moves with ‹ ›, swipe across the board, or tap a move or the graph.'];
    if (!v.review && !analyzed && canReview) lines.push('Game Review has the coach check every move.');
    return { title: 'Start position', lines: noted(lines), busy: false, actions: v.review || !canReview ? [] : [review] };
  }
  const human = ply.color === v.record.playerColor;
  const label = moveLabel(ply);
  const head = human ? label : `${v.bot.name}’s ${label}`;
  if (ply.index < v.preplayed) {
    return { title: head, lines: noted(['This move was played for you before the game started (opening practice).']), busy: false, actions: [] };
  }
  const cl = ply.classification;
  if (!cl) {
    if (running) return { title: head, lines: ['Checking this move…'], busy: true, actions: [] };
    if (v.review && v.review.failed > 0 && canReview) {
      return {
        title: head,
        lines: ['This move could not be analyzed.'],
        busy: false,
        actions: [{ id: 'retryAnalysis', label: 'Check again', primary: true }],
      };
    }
    return { title: head, lines: noted(['The coach hasn’t checked this game yet.']), busy: false, actions: canReview ? [review] : [] };
  }
  const verdict = verdictTitle(ply);
  const titled = {
    title: human ? verdict.title : `${v.bot.name}’s ${verdict.title}`,
    titleMove: head,
    ...(verdict.cls ? { cls: verdict.cls } : {}),
  };
  if (ctx.locked.has('reviewDetails')) {
    // The verdict and its icon are free; why, and what was better, are Pro (as in Game Review).
    return { ...titled, lines: noted([lockedTeaser(ply)]), busy: false, actions: [{ id: 'unlock', label: UNLOCK_LABEL }] };
  }
  const tryable = tries.has(ply.index);
  const hidden = !!ctx.ratedGame || (tryable && !revealed(ply.index));
  const better = !TOP_CLASSES.has(cl.cls) ? cl.bestMoveSan : null;
  let lines: string[];
  if (hidden && human && better) lines = answerFreeLines(ply.explanation, cl);
  else {
    lines = explanationLines(ply.explanation, better, { cl, playedUci: ply.uci, voice: human ? 'you' : 'neutral' });
    if (hidden) {
      const names = betterMoves(cl);
      lines = lines.filter((l) => !names.some((san) => namesMove(l, san)));
    }
  }
  // A verdict kept without its explanation (the history keeps the key moments' only): what the class means.
  if (!lines.length && human) lines.push(CLASS_META[cl.cls].description);
  const actions: ViewerAction[] = [];
  if (tryable) {
    actions.push({ id: 'tryAgain', label: 'Try again', primary: true });
    if (hidden && offersShowBest(cl, ply.uci)) actions.push({ id: 'showBest', label: 'Show best' });
  }
  // The comment kept in the history is being written again in full.
  return { ...titled, lines: noted(lines), busy: v.explaining === ply.index, actions };
}
