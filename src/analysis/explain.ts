/**
 * Plain-English coaching explanations, built from engine lines plus static board analysis.
 *
 * The engine decides WHAT happened (mate, material won or lost, how the evaluation moved); the
 * detectors in `./motifs` and `./see` supply the WHY (fork, pin, hanging piece, threat, opening
 * principle...). Sentences are short and beginner-friendly: SAN plus piece names and squares.
 *
 * Pure logic (no DOM). Engine scores are side-to-move POV (`Score`), as everywhere in the engine
 * layer. None of the entry points throws on legal game input.
 */
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import type { AnalysisResult, PvLine, Score } from '../engine/types';
import { PIECE_NAMES, pvToSan, sideToMove, uciToSan } from '../chess/utils';
import type { Arrow, ArrowBrush, Classification, Explanation, MoveClass } from './types';
import { scoreToWin } from './winprob';
import {
  VALUE,
  between,
  hangingPieces,
  other,
  pieces,
  scratch,
  winningCaptures,
  type Hanging,
  type PieceOn,
} from './see';
import {
  TACTICAL_KINDS,
  forcedMateLine,
  isBackRankMate,
  materialBalance,
  materialOutcome,
  motifSquares,
  moveMotifs,
  playLine,
  principles,
  rankMotifs,
  stoppedThreat,
  threatsAgainst,
  worth,
  type Counts,
  type MaterialOutcome,
  type Motif,
  type MotifKind,
  type Principle,
  type Threat,
} from './motifs';

/** Who the text addresses: 'you' = the mover is the user ("your knight"); 'neutral' = White/Black. */
export type Perspective = 'you' | 'neutral';

/** The opponent's previous move (lets a recapture be called a recapture). */
export interface PrevMove {
  to: string;
  captured?: string;
}

/** Input of `explainMove` (ARCHITECTURE.md Module API, plus `perspective`). */
export interface ExplainMoveInput {
  fenBefore: string;
  moveUci: string;
  classification: Classification;
  /** Analysis of `fenBefore` (lines[0] = best line). */
  before: AnalysisResult;
  /** Analysis of the position after the move (its best line starts with the reply). */
  after?: AnalysisResult;
  prevMove?: PrevMove;
  /** Default 'you'. Use 'neutral' when reviewing the opponent's (bot's) moves. */
  perspective?: Perspective;
}

// ------------------------------------------------------------------ wording helpers

const SIDE: Record<Color, string> = { w: 'White', b: 'Black' };
const NAME = PIECE_NAMES as Record<PieceSymbol, string>;
const BAD: readonly MoveClass[] = ['inaccuracy', 'mistake', 'miss', 'blunder'];
const NUM = ['', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

/** How pieces are named in a sentence: the mover's own pieces and the victim's. */
interface Voice {
  you: boolean;
  mover: Color;
  /** Possessive for the mover's pieces: "your" / "White's". */
  own: string;
  /** Possessive for the pieces a tactic hits: "the" (or "your" when the user is the victim). */
  victim: string;
  /** Subject for the mover: "You" / "White". */
  subject: string;
}

function voice(mover: Color, perspective: Perspective | undefined): Voice {
  const you = perspective !== 'neutral';
  return { you, mover, own: you ? 'your' : `${SIDE[mover]}'s`, victim: 'the', subject: you ? 'You' : SIDE[mover] };
}

/** The voice for explaining the OPPONENT's reply to a user's move (victims are the user's pieces). */
function replyVoice(v: Voice): Voice {
  const mover = other(v.mover);
  return { you: false, mover, own: `${SIDE[mover]}'s`, victim: v.own, subject: SIDE[mover] };
}

const on = (p: PieceOn) => `${NAME[p.type]} on ${p.square}`;
const theOn = (p: PieceOn, poss: string) => (p.type === 'k' ? `${poss} king` : `${poss} ${on(p)}`);
const withArticle = (t: PieceSymbol) => (t === 'q' || t === 'k' ? `the ${NAME[t]}` : `a ${NAME[t]}`);

function joinAnd(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function nounList(x: Partial<Counts>): string {
  const parts: string[] = [];
  const minors = (x.b ?? 0) + (x.n ?? 0);
  if (x.q) parts.push(x.q === 1 ? 'the queen' : `${NUM[Math.min(x.q, 8)]} queens`);
  if (x.r) parts.push(x.r === 1 ? 'a rook' : `${NUM[Math.min(x.r, 8)]} rooks`);
  if (minors >= 2) parts.push(`${NUM[Math.min(minors, 8)]} pieces`);
  else if (x.b) parts.push('a bishop');
  else if (x.n) parts.push('a knight');
  if (x.p) parts.push(x.p === 1 ? 'a pawn' : `${NUM[Math.min(x.p, 8)]} pawns`);
  return joinAnd(parts) || 'nothing';
}

const isExchange = (a: Partial<Counts>, b: Partial<Counts>) =>
  a.r === 1 && (b.b ?? 0) + (b.n ?? 0) === 1 && !a.q && !b.r && !b.q && !a.b && !a.n;

/** What the side of `o` gains, as a noun phrase ("a knight", "the exchange"), or null for nothing. */
export function materialNoun(o: MaterialOutcome): string | null {
  if (o.net < 1) return null;
  const W = o.won;
  const L = o.lost;
  if (worth(W) === 0) return o.promotions ? 'a new queen' : null;
  if (worth(L) === 0) return nounList(W);
  if (isExchange(W, L)) return `the exchange${W.p ? ` and ${nounList({ p: W.p })}` : ''}`;
  return `${nounList(W)} for ${nounList(L)}`;
}

/**
 * The material result of a line as a verb phrase: "wins a knight", "wins the exchange",
 * "wins the queen for a rook", "promotes to a queen", "loses a pawn"; null when about even.
 */
export function describeMaterial(o: MaterialOutcome): string | null {
  const promo = o.promotions ? 'promotes to a queen' : '';
  if (Math.abs(o.net) < 1 && !promo) return null;
  if (o.net <= -1) {
    const W = o.won;
    const L = o.lost;
    if (worth(W) === 0) return `loses ${nounList(L)}`;
    return `loses ${isExchange(L, W) ? 'the exchange' : `${nounList(L)} for ${nounList(W)}`}`;
  }
  if (worth(o.won) === 0) return promo || null;
  const noun = materialNoun({ ...o, promotions: 0 }) ?? nounList(o.won);
  return `wins ${noun}${promo ? ` and ${promo}` : ''}`;
}

/** A verb phrase for what a motif does, e.g. "attacks the king and the rook on a8 at once (a fork)". */
function motifClause(m: Motif, poss: string): string | null {
  switch (m.kind) {
    case 'checkmate':
      return 'is checkmate';
    case 'fork':
      return `attacks ${joinAnd(m.targets.map((t) => theOn(t, poss)))} at once (a fork)`;
    case 'doubleThreat':
      return `threatens both ${joinAnd(m.threats.map((t) => t.san))} (a double attack)`;
    case 'pin':
      if (m.exploit) return `attacks ${theOn(m.pinned, poss)}, which is pinned to the ${NAME[m.behind.type]}`;
      return `pins ${theOn(m.pinned, poss)} to the ${NAME[m.behind.type]}${m.behind.type === 'k' ? KING_PIN : ''}`;
    case 'skewer':
      return `skewers ${theOn(m.front, poss)}: once it moves, ${theOn(m.back, poss)} behind it falls`;
    case 'discovered':
      return m.target.type === 'k'
        ? `uncovers check from the ${on(m.by)}`
        : `uncovers an attack by the ${on(m.by)} on ${theOn(m.target, poss)}`;
    case 'freeCapture': {
      if (m.defenders === 0) return `takes ${theOn(m.captured, poss)}, which was undefended`;
      const attacked = m.attackers === 2 ? 'twice' : `${m.attackers} times`;
      const defended = m.defenders === 1 ? 'once' : `${m.defenders} times`;
      return `takes ${theOn(m.captured, poss)}, which was attacked ${attacked} but defended only ${defended}`;
    }
    case 'trapped':
      return `traps ${theOn(m.piece, poss)}: every square it can go to loses it`;
    case 'mateThreat':
      return `threatens mate with ${m.san}`;
    case 'promotionThreat':
      return `threatens to promote with ${m.san}`;
    case 'threat':
      return `threatens to win ${theOn(m.target, poss)} with ${m.san}`;
    case 'attacks':
      return `attacks ${theOn(m.target, poss)}`;
    case 'promotion':
      return `promotes the pawn to a ${NAME[m.to]}`;
    case 'check':
      return m.double ? 'is a double check, so the king must move' : m.discovered ? 'is a discovered check' : null;
    default:
      return null;
  }
}

const KING_PIN = " (it can't move)";

/** "loses a knight to <noun>" */
function motifNoun(m: Motif): string {
  switch (m.kind) {
    case 'fork':
      return 'a fork';
    case 'doubleThreat':
      return 'a double attack';
    case 'pin':
      return 'a pin';
    case 'skewer':
      return 'a skewer';
    case 'discovered':
      return m.target.type === 'k' ? 'a discovered check' : 'a discovered attack';
    case 'trapped':
      return 'a trap';
    case 'mateThreat':
      return 'a mating threat';
    case 'promotionThreat':
      return 'a promotion threat';
    default:
      return 'a tactic';
  }
}

const MOTIF_TITLE: Partial<Record<MotifKind, string>> = {
  checkmate: 'Checkmate',
  fork: 'Fork',
  doubleThreat: 'Double attack',
  pin: 'Pin',
  skewer: 'Skewer',
  discovered: 'Discovered attack',
  trapped: 'Trapped piece',
  freeCapture: 'Free material',
  mateThreat: 'Mate threat',
  promotionThreat: 'Promotion',
  promotion: 'Promotion',
  threat: 'Threat',
  attacks: 'Attack',
  check: 'Check',
};

/** A verb phrase for a principle, e.g. "develops the knight". */
function principleText(p: Principle): string {
  switch (p.kind) {
    case 'castles':
      return 'castles the king to safety and brings the rook into play';
    case 'kingWalk':
      return 'moves the king and gives up the right to castle';
    case 'develops':
      return `develops the ${NAME[p.piece]}`;
    case 'centrePawn':
      return 'takes space in the centre';
    case 'centreControl':
      return 'fights for the centre';
    case 'earlyQueen':
      return 'brings the queen out early, where enemy pieces can chase it';
    case 'edgePawn':
      return "is an edge-pawn move that doesn't help development";
    case 'fPawn':
      return "weakens the king's position";
    case 'knightRim':
      return 'puts the knight on the edge, where it controls fewer squares';
    case 'luft':
      return 'gives the king an escape square';
    case 'passedPawn':
      return 'pushes a passed pawn towards promotion';
    case 'rookSeventh':
      return 'puts the rook on the seventh rank';
    case 'openFile':
      return `puts the rook on the open ${p.to[0]}-file`;
    case 'opensLine':
      return p.freed?.type === 'b'
        ? `opens a diagonal for the bishop on ${p.freed.square}`
        : 'opens a line for the queen';
    case 'tradeAhead':
      return 'trades pieces while ahead, which makes the extra material count more';
    case 'trade':
      return p.captured === p.piece
        ? `trades ${NAME[p.piece]}s`
        : `trades ${withArticle(p.piece)} for ${withArticle(p.captured ?? 'p')}`;
    case 'bishopPair':
      return 'gives up the bishop pair';
    case 'kingActive':
      return 'brings the king towards the centre';
    case 'activates':
      return `brings the ${NAME[p.piece]} to a more active square`;
  }
}

const OPENING_PRINCIPLES = new Set<Principle['kind']>([
  'castles',
  'kingWalk',
  'develops',
  'centrePawn',
  'centreControl',
  'earlyQueen',
  'edgePawn',
  'fPawn',
  'knightRim',
]);

function arrow(uci: string | undefined | null, brush: ArrowBrush): Arrow[] {
  return uci && uci.length >= 4 ? [{ from: uci.slice(0, 2), to: uci.slice(2, 4), brush }] : [];
}

function dedupeArrows(arrows: Arrow[]): Arrow[] {
  const seen = new Set<string>();
  return arrows.filter((a) => {
    const k = `${a.from}${a.to}`;
    if (a.from === a.to || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ------------------------------------------------------------------ engine lines

/** An engine line from the side to move's point of view; `score` may be unknown. */
interface Line {
  pv: string[];
  score?: Score;
}

/** Child-position score (opponent to move) -> mover's POV, with mate distance from before the move. */
function toMover(child: Score): Score {
  if (child.kind === 'cp') return { kind: 'cp', value: -child.value };
  return { kind: 'mate', value: child.value <= 0 ? -child.value + 1 : -child.value };
}

/** Mover's score for a move -> the score of the child position (opponent to move). */
function toChild(mover: Score): Score {
  if (mover.kind === 'cp') return { kind: 'cp', value: -mover.value };
  return { kind: 'mate', value: mover.value > 0 ? -(mover.value - 1) : -mover.value };
}

const mateOf = (s: Score | undefined): number | null => (s?.kind === 'mate' ? s.value : null);

function asLine(l: PvLine | undefined): Line | null {
  return l && l.pv.length ? { pv: l.pv, score: l.score } : null;
}

// ------------------------------------------------------------------ why a move is good

/** The reason a move is good, as a verb phrase without the SAN ("wins a knight"). */
interface Reason {
  san: string;
  reason: string;
  details: string[];
  title: string;
  motifs: string[];
  arrows: Arrow[];
  /** True when nothing specific was found ("improves the position"). */
  fallback: boolean;
}

function explainLine(fen: string, line: Line, v: Voice, prev?: PrevMove): Reason | null {
  const uci = line.pv[0];
  if (!uci) return null;
  const mm = moveMotifs(fen, uci);
  if (!mm) return null;
  const { move, motifs } = mm;
  const san = move.san;
  const me = move.color;
  const pre = new Chess(fen);
  const arrows: Arrow[] = [];
  const res = (title: string, reason: string, details: string[] = [], extra: Partial<Reason> = {}): Reason => ({
    san,
    reason,
    details,
    title,
    motifs: [],
    arrows,
    fallback: false,
    ...extra,
  });
  const mate = mateOf(line.score) ?? 0;

  if (motifs.some((m) => m.kind === 'checkmate')) {
    return res('Checkmate', 'is checkmate', [], { motifs: ['checkmate'] });
  }
  if (mate > 0) {
    const sans = playLine(fen, line.pv, 2 * mate - 1).sans;
    if (mate <= 3 && sans.length === 2 * mate - 1) {
      return res('Forced mate', `starts a forced mate in ${mate}`, [`The finish: ${sans.join(' ')}.`], {
        motifs: ['forcedMate'],
      });
    }
    const top = rankMotifs(motifs).find((m) => motifClause(m, v.victim));
    return res('Forced mate', `leads to a forced mate in ${mate}`, top ? [`It ${motifClause(top, v.victim)}.`] : [], {
      motifs: ['forcedMate', ...(top ? [top.kind] : [])],
    });
  }
  if (line.score?.kind === 'mate' && mate <= 0) {
    // Getting mated anyway: material grabbed along the line does not matter.
    const opp = SIDE[other(me)];
    const rest =
      mate === -1 ? [`${opp} mates next move.`] : mate < 0 ? [`${opp} still has a forced mate in ${-mate}.`] : [];
    if (pre.moves().length === 1) return res('Only move', 'is the only legal move', rest, { motifs: ['onlyMove'] });
    if (pre.inCheck()) return res('Check', escapeText(move.captured, move.piece), rest, { motifs: ['escapesCheck'] });
    return res('Forced mate', 'is the most stubborn defence', rest, { motifs: ['mated'] });
  }

  // Material won along the line, with the tactic that explains it.
  const out = materialOutcome(fen, line.pv, me);
  const mat = describeMaterial(out);
  const recapture = !!(prev?.captured && prev.to === move.to && move.captured);
  const prevValue = recapture ? (VALUE[prev!.captured as PieceSymbol] ?? 0) : 0;
  const balance = materialBalance(pre, me);
  const matAfter = balance + out.net;
  // If the line "wins" a lot but the eval is far below the resulting material balance, the other
  // side is sacrificing for compensation: don't claim a win (Stockfish compresses big advantages).
  const evalPawns = line.score?.kind === 'cp' ? line.score.value / 100 : undefined;
  const compensated =
    evalPawns !== undefined &&
    out.net >= 2 &&
    matAfter > 0 &&
    evalPawns < matAfter - 2.5 &&
    evalPawns < 0.6 * matAfter &&
    canWin(out.fen, me);
  if (out.net - prevValue >= 1 && mat && !compensated) {
    const hot = [...out.captureSquares, ...(move.captured ? [move.to] : [])];
    // Only motifs that explain where the material actually comes from.
    const explains = (m: Motif) => {
      if (m.kind === 'freeCapture') return VALUE[m.captured.type] >= out.net - 1;
      if (m.kind === 'mateThreat' || m.kind === 'promotion' || m.kind === 'promotionThreat') return true;
      return motifSquares(m).some((q) => out.captureSquares.includes(q));
    };
    const relevant = rankMotifs(
      motifs.filter((m) => TACTICAL_KINDS.includes(m.kind)),
      hot,
    ).filter(explains);
    const top = relevant.find((m) => motifClause(m, v.victim));
    if (top) arrows.push(...motifArrows(top, move.to));
    const back = balance < 0 && out.net <= -balance + 0.5 && worth(out.lost) === 0;
    const reason = back ? mat.replace(/^wins /, 'wins back ') : mat;
    const keyLine = out.sans.length > 1 ? `Key line: ${out.sans.slice(0, 6).join(' ')}.` : null;
    const detail = top ? `It ${motifClause(top, v.victim)}.` : keyLine;
    return res(top ? (MOTIF_TITLE[top.kind] ?? 'Wins material') : 'Wins material', reason, detail ? [detail] : [], {
      motifs: ['winsMaterial', ...(top ? [top.kind] : [])],
    });
  }
  if (recapture) return res('Recapture', `recaptures the ${NAME[move.captured!]}`, [], { motifs: ['recapture'] });
  if (pre.inCheck()) return res('Check', escapeText(move.captured, move.piece), [], { motifs: ['escapesCheck'] });
  if (pre.moves().length === 1) return res('Only move', 'is the only legal move', [], { motifs: ['onlyMove'] });

  const stopped = stoppedThreat(fen, uci);
  if (stopped) {
    arrows.push(...arrow(stopped.from + stopped.to, 'threat'));
    return res('Defence', stoppedText(stopped, v.own), [], { motifs: ['defence'] });
  }

  // Strong tactics first, then principles, then minor motifs (a simple threat or attack).
  const top = rankMotifs(motifs).find((m) => motifClause(m, v.victim));
  const good = principles(fen, uci).filter((p) => p.good);
  const strong = !!top && !MINOR_KINDS.includes(top.kind);
  const parts: { text: string; tag: string; motif?: Motif }[] = good.map((p) => ({
    text: principleText(p),
    tag: p.kind,
  }));
  if (top) parts.splice(strong ? 0 : parts.length, 0, { text: motifClause(top, v.victim)!, tag: top.kind, motif: top });
  if (parts.length) {
    const first = parts[0];
    const second = parts[1];
    const joinable = !!second && !/[,:]| and /.test(first.text) && !/[,:]/.test(second.text);
    const used = joinable ? [first, second] : [first];
    const m = used.find((x) => x.motif)?.motif;
    if (m) arrows.push(...motifArrows(m, move.to));
    const title = first.motif
      ? (MOTIF_TITLE[first.motif.kind] ?? 'Tactic')
      : OPENING_PRINCIPLES.has(first.tag as Principle['kind'])
        ? 'Opening principle'
        : 'Positional';
    return res(title, joinAnd(used.map((x) => x.text)), [], { motifs: used.map((x) => x.tag) });
  }
  const main = playLine(fen, line.pv, 5).sans;
  const mainLine = main.length > 1 ? [`Main line: ${main.join(' ')}.`] : [];
  return res('Positional', 'improves the position', mainLine, { fallback: true });
}

/** Red arrows from the piece that makes a tactic to what it hits. */
function motifArrows(m: Motif, movedTo: string): Arrow[] {
  const from = m.kind === 'discovered' ? m.by.square : movedTo;
  return motifSquares(m).map((to) => ({ from, to, brush: 'threat' as const }));
}

/** Motif kinds that only add colour to a quiet move. */
const MINOR_KINDS: readonly MotifKind[] = ['threat', 'attacks', 'check'];

function escapeText(captured: PieceSymbol | undefined, piece: PieceSymbol): string {
  if (captured) return `gets out of check by taking the ${NAME[captured]}`;
  return piece === 'k' ? 'gets the king out of check' : 'blocks the check';
}

/** Whether `color` still has enough material at `fen` to win (else a low eval means a dead draw). */
function canWin(fen: string, color: Color): boolean {
  const own = pieces(scratch(fen), color).filter((p) => p.type !== 'k');
  return own.some((p) => p.type === 'p') || own.reduce((n, p) => n + VALUE[p.type], 0) >= 5;
}

function stoppedText(t: Threat, own: string): string {
  if (t.kind === 'mate') return `stops the threat of mate with ${t.san}`;
  if (t.kind === 'promotion') return `stops ${t.san}, which would make a new queen`;
  return `saves ${own} ${t.target ? on(t.target) : 'piece'} from ${t.san}`;
}

// ------------------------------------------------------------------ public API

/**
 * Why is this (engine) move good? Used for hints ("Show hint"), for "Best was X, which …" and to
 * praise good moves. `line` is an engine line for `fen` (side-to-move POV); `line.pv[0]` is the
 * move explained. Never throws.
 */
export function explainBestMove(
  fen: string,
  line: PvLine,
  opts: { prevMove?: PrevMove; perspective?: Perspective } = {},
): Explanation {
  try {
    const v = voice(sideToMove(fen), opts.perspective);
    const r = explainLine(fen, { pv: line.pv, score: line.score }, v, opts.prevMove);
    if (!r) return { headline: 'There is no move to suggest here.', details: [] };
    return {
      headline: `${r.san} ${r.reason}.`,
      details: r.details.slice(0, 3),
      bestLineSan: pvToSan(fen, line.pv, 6),
      arrows: dedupeArrows([...arrow(line.pv[0], 'best'), ...r.arrows]),
      title: r.title,
      motifs: r.motifs,
    };
  } catch {
    const san = line.pv[0] ? uciToSan(fen, line.pv[0]) : null;
    return { headline: san ? `${san} is the engine's choice.` : 'There is no move to suggest here.', details: [] };
  }
}

/**
 * What does the side NOT to move threaten (null-move probe)? E.g. "White threatens Qxf7#,
 * checkmate." Null when there is no clear threat, or when the side to move is in check.
 * `perspective` 'you' (default) calls the side to move's pieces "your". Never throws.
 */
export function describeThreat(fen: string, opts: { perspective?: Perspective } = {}): Explanation | null {
  try {
    const threats = threatsAgainst(fen);
    if (!threats.length) return null;
    const stm = sideToMove(fen);
    const opp = SIDE[other(stm)];
    const poss = opts.perspective === 'neutral' ? 'the' : 'your';
    const what = (t: Threat) =>
      t.kind === 'mate'
        ? `${t.san}, checkmate`
        : t.kind === 'promotion'
          ? `${t.san}, making a new queen`
          : `${t.san}, winning ${poss} ${t.target ? on(t.target) : 'piece'}`;
    const [first, second] = threats;
    const details = second && second.to !== first.to ? [`${opp} also threatens ${second.san}.`] : [];
    const kind = (t: Threat) =>
      t.kind === 'mate' ? 'mateThreat' : t.kind === 'promotion' ? 'promotionThreat' : 'threat';
    return {
      headline: `${opp} threatens ${what(first)}.`,
      details,
      arrows: dedupeArrows([first, ...(details.length ? [second] : [])].flatMap((t) => arrow(t.from + t.to, 'threat'))),
      title: first.kind === 'mate' ? 'Mate threat' : 'Threat',
      motifs: [kind(first)],
    };
  } catch {
    return null;
  }
}

/**
 * Why was this move good or bad? Combines the classification with the engine lines before and
 * after the move: mates first, then material won or lost (with the tactic behind it), missed
 * tactics, opening and positional principles, and finally what the best move was. The headline
 * says what happened (the UI shows the classification label separately). Never throws.
 */
export function explainMove(p: ExplainMoveInput): Explanation {
  try {
    return explainMoveUnsafe(p);
  } catch {
    return fallbackExplanation(p);
  }
}

function fallbackExplanation(p: ExplainMoveInput): Explanation {
  const cl = p.classification;
  const san = cl.playedMoveSan;
  const best = cl.bestMoveSan && cl.bestMoveSan !== san ? cl.bestMoveSan : null;
  const bad = BAD.includes(cl.cls);
  return {
    headline: bad ? `There was a better move than ${san}.` : `${san} is a reasonable move.`,
    details: best && bad ? [`Best was ${best}.`] : [],
    arrows: best && bad ? arrow(cl.bestMoveUci, 'best') : [],
  };
}

function explainMoveUnsafe(p: ExplainMoveInput): Explanation {
  const { fenBefore, moveUci, classification: cl } = p;
  const mm = moveMotifs(fenBefore, moveUci);
  if (!mm) return fallbackExplanation(p);
  const { move, after: fenAfter } = mm;
  const me = move.color;
  const opp = other(me);
  const Opp = SIDE[opp];
  const v = voice(me, p.perspective);

  // Engine lines: best line before the move, the opponent's best reply line after it (its POV),
  // and the played line (mover's POV).
  const beforeLines = p.before?.lines ?? [];
  const bestLine: Line | null = asLine(beforeLines[0]) ?? (cl.bestMoveUci ? { pv: [cl.bestMoveUci] } : null);
  const bestUci = bestLine?.pv[0] ?? null;
  const bestSan = bestUci ? uciToSan(fenBefore, bestUci) : null;
  const isBest = !bestUci || bestUci === moveUci;
  const playedInBefore = beforeLines.find((l) => l.pv[0] === moveUci);
  let reply: Line | null = asLine(p.after?.lines[0]);
  if (!reply && playedInBefore && playedInBefore.pv.length > 1) {
    reply = { pv: playedInBefore.pv.slice(1), score: toChild(playedInBefore.score) };
  }
  const playedLine: Line = reply
    ? { pv: [moveUci, ...reply.pv], score: reply.score ? toMover(reply.score) : undefined }
    : (asLine(playedInBefore) ?? { pv: [moveUci] });
  const refutation = playLine(fenAfter, reply?.pv ?? [], 12);
  const bestLineSan = bestLine ? pvToSan(fenBefore, bestLine.pv, 6) : undefined;

  let bestReasonMemo: Reason | null | undefined;
  const bestReason = () => {
    if (bestReasonMemo === undefined) {
      bestReasonMemo = bestLine && !isBest ? explainLine(fenBefore, bestLine, v, p.prevMove) : null;
    }
    return bestReasonMemo;
  };
  const bestSentence = (lead: string) => {
    const br = bestReason();
    return br && !br.fallback ? `${lead} ${bestSan}, which ${br.reason}.` : `${lead} ${bestSan}.`;
  };
  const arrows: Arrow[] = [];
  type Maybe = string | null | undefined | false;
  const done = (headline: string, details: Maybe[], title: string, motifs: string[]): Explanation => ({
    headline,
    details: details.filter((d): d is string => !!d).slice(0, 3),
    ...(bestLineSan?.length ? { bestLineSan } : {}),
    arrows: dedupeArrows(arrows),
    title,
    motifs,
  });

  // 1. The game ends.
  const board = new Chess(fenAfter);
  if (board.isCheckmate() || p.after?.terminal === 'checkmate') {
    const backRank = isBackRankMate(fenAfter);
    return done(
      v.you ? `${move.san} is checkmate — well played!` : `${move.san} is checkmate.`,
      [backRank && "It's a back-rank mate: the king has no escape square."],
      'Checkmate',
      ['checkmate', ...(backRank ? ['backRank'] : [])],
    );
  }
  if (board.isStalemate() || p.after?.terminal === 'stalemate') {
    if (cl.winBefore >= 0.6) {
      if (!isBest) arrows.push(...arrow(bestUci, 'best'));
      return done(
        'This is stalemate, so the game ends in a draw.',
        [`${Opp} has no legal moves but is not in check.`, !isBest && bestSan && bestSentence('Best was')],
        'Stalemate',
        ['stalemate'],
      );
    }
    return done(
      `This stalemates ${Opp}, so the game is a draw.`,
      [cl.winBefore <= 0.4 && 'A draw is a good result from a lost position.'],
      'Stalemate',
      ['stalemate'],
    );
  }

  // 2. Mates allowed, suffered or missed.
  const replyMate = mateOf(reply?.score);
  const bestMate = mateOf(bestLine?.score);
  const oppMates = replyMate !== null && replyMate > 0 ? replyMate : 0;
  const wasLosing = bestMate !== null && bestMate <= 0;
  if (oppMates && !wasLosing && !isBest) {
    const mates = refutation.sans.slice(0, 2 * oppMates - 1);
    const endFen = refutation.fens[Math.min(2 * oppMates - 1, refutation.fens.length - 1)];
    const grab =
      move.captured && VALUE[move.captured] >= 3
        ? `${move.san} wins ${withArticle(move.captured)}, but it allows`
        : 'This allows';
    const backRank = !!endFen && isBackRankMate(endFen);
    arrows.push(...arrow(reply?.pv[0], 'threat'), ...arrow(bestUci, 'best'));
    const br = bestReason();
    const needed = br && !br.fallback ? `${bestSan} was needed: it ${br.reason}.` : `${bestSan} was needed.`;
    return done(
      oppMates === 1 && mates[0] ? `${grab} ${mates[0]}, checkmate.` : `${grab} a forced mate in ${oppMates}.`,
      [
        oppMates > 1 && mateSentence(`${Opp} mates with`, mates, oppMates),
        backRank && `It's a back-rank mate: ${v.own} king has no escape square.`,
        bestSan && needed,
      ],
      'Allows mate',
      ['allowsMate', ...(backRank ? ['backRank'] : [])],
    );
  }
  if (oppMates) {
    // Getting mated anyway (or the move was fine and the mate was coming regardless).
    arrows.push(...arrow(reply?.pv[0], 'threat'));
    const mateIn = oppMates === 1 ? `${Opp} mates next move` : `${Opp} still has a forced mate in ${oppMates}`;
    if (new Chess(fenBefore).moves().length === 1) {
      return done(`${move.san} is forced: it's the only legal move.`, [`${mateIn}.`], 'Only move', ['onlyMove']);
    }
    if (isBest || (bestMate !== null && oppMates >= -bestMate)) {
      return done(`${move.san} is the most stubborn defence.`, [`${mateIn}.`], 'Forced mate', ['mated']);
    }
    arrows.push(...arrow(bestUci, 'best'));
    const longer = bestSan && `${bestSan} would have lasted longer.`;
    return done(`This lets ${Opp} mate faster.`, [`${mateIn}.`, longer], 'Forced mate', ['mated']);
  }
  const iHadMate = bestMate !== null && bestMate > 0 ? bestMate : 0;
  const iStillMate = replyMate !== null && replyMate <= 0 ? -replyMate : 0;
  if (iHadMate && !iStillMate && !isBest && bestSan && bestLine) {
    const line = playLine(fenBefore, bestLine.pv, 2 * iHadMate - 1).sans;
    arrows.push(...arrow(bestUci, 'best'));
    return done(
      iHadMate === 1
        ? `${v.subject} missed ${bestSan}, which was checkmate.`
        : `${v.subject} missed a forced mate in ${iHadMate}.`,
      [iHadMate > 1 && mateSentence('The mate:', line, iHadMate)],
      'Missed mate',
      ['missedMate'],
    );
  }

  // 3. Good moves: praise with the reason, plus the better move when there was one.
  if (!BAD.includes(cl.cls)) return praise();

  // 4. Bad moves.
  const playedOut = materialOutcome(fenBefore, playedLine.pv, me);
  const bestOut = bestLine ? materialOutcome(fenBefore, bestLine.pv, me) : null;
  const replyMove = refutation.moves[0];
  const recapture = !!(p.prevMove?.captured && p.prevMove.to === move.to);
  const grab = move.captured && !recapture ? `${move.san} grabs ${withArticle(move.captured)}, but it` : null;
  const details: (string | null | false | undefined)[] = [];
  let headline: string;
  let title: string;
  let motifs: string[];

  if (reply && replyMove && playedOut.net <= -1 && playedOut.net < (bestOut?.net ?? 0) - 0.5) {
    // 4a. Material lost to the reply.
    arrows.push(...arrow(reply.pv[0], 'threat'));
    const oppOut = materialOutcome(fenAfter, reply.pv, opp);
    // After "Nxe5 grabs a pawn, but it …" name only what is lost, not the trade balance.
    const noun = (grab ? (worth(oppOut.won) > 0 ? nounList(oppOut.won) : null) : materialNoun(oppOut)) ?? 'material';
    const gains = describeMaterial(oppOut) ?? 'wins material';
    const replyMotifs = moveMotifs(fenAfter, reply.pv[0])?.motifs ?? [];
    const relevant = (m: Motif) =>
      REPLY_KINDS.includes(m.kind) &&
      (m.kind === 'mateThreat' ||
        m.kind === 'promotionThreat' ||
        m.kind === 'trapped' ||
        (m.kind === 'discovered' && VALUE[m.target.type] >= 3) ||
        motifSquares(m).some((q) => oppOut.captureSquares.includes(q)));
    const mf = rankMotifs(replyMotifs.filter(relevant), oppOut.captureSquares)[0];
    const hang = hangingPieces(fenAfter, me).find(
      (h) => h.piece.square === replyMove.to || oppOut.captureSquares.includes(h.piece.square),
    );
    if (mf) {
      headline = `${grab ?? 'This'} loses ${noun} to ${motifNoun(mf)}.`;
      details.push(`${Opp} answers ${replyMove.san}, which ${motifClause(mf, v.own)}.`);
      title = MOTIF_TITLE[mf.kind] ?? 'Loses material';
      motifs = [mf.kind];
    } else if (hang) {
      const moved = hang.piece.square === move.to;
      headline = `${grab ?? 'This'} ${hangingVerb(hang, fenBefore, fenAfter, move.from, move.to, v)}.`;
      const lower = moved && hang.defenders > 0 ? hang.lowerAttacker : undefined;
      const byLower = lower ? `Even though it is defended, ${withArticle(lower.type)} can take it: ` : '';
      details.push(`${byLower}${Opp} plays ${replyMove.san} and ${gains}.`);
      title = 'Hanging piece';
      motifs = ['hanging'];
    } else {
      headline = `${grab ?? 'This'} loses ${noun}.`;
      details.push(`After ${oppOut.sans.slice(0, 4).join(' ')}, ${Opp} ${gains}.`);
      title = 'Loses material';
      motifs = ['losesMaterial'];
    }
  } else if (bestOut && bestSan && bestLine && !isBest && bestOut.net >= 1 && bestOut.net - playedOut.net >= 1) {
    // 4b. Missed a tactic or free material.
    const br = bestReason();
    if (br && !br.fallback) {
      arrows.push(...arrow(bestUci, 'best'), ...br.arrows);
      return done(
        `${v.subject} missed ${bestSan}, which ${br.reason}.`,
        [br.details[0]],
        cl.cls === 'miss' ? 'Missed win' : 'Missed tactic',
        ['missedTactic', ...br.motifs],
      );
    }
    headline = `${v.subject} missed a chance to win material.`;
    title = 'Missed tactic';
    motifs = ['missedTactic'];
  } else {
    // 4c. Positional: a broken principle, what the reply does, or how the evaluation moved.
    const neg = principles(fenBefore, moveUci).find((x) => !x.good);
    const rv = replyVoice(v);
    const took = move.captured ? { to: move.to, captured: move.captured } : undefined;
    const rr = reply ? explainLine(fenAfter, reply, rv, took) : null;
    if (neg) headline = `${move.san} ${principleText(neg)}.`;
    else if (cl.cls === 'miss') headline = `${v.subject} missed a chance to punish ${Opp}'s mistake.`;
    else headline = evalHeadline(cl, v, Opp);
    // Only mention the reply when it does something concrete (a tactic, a threat, winning material).
    const useReply = !!rr && !rr.fallback && !['Recapture', 'Positional', 'Opening principle'].includes(rr.title);
    if (useReply) {
      details.push(`${Opp} can answer ${rr.san}, which ${rr.reason}.`);
      arrows.push(...arrow(reply?.pv[0], 'threat'));
    }
    title = neg && OPENING_PRINCIPLES.has(neg.kind) ? 'Opening principle' : 'Positional';
    motifs = [...(neg ? [neg.kind] : []), ...(useReply ? rr.motifs : [])];
  }
  if (!isBest && bestSan) {
    details.push(bestSentence('Best was'));
    arrows.push(...arrow(bestUci, 'best'));
  }
  return done(headline, details, title, motifs);

  /** Explanation for a good move (best, excellent, good, great, brilliant, book, forced). */
  function praise(): Explanation {
    const r = explainLine(fenBefore, playedLine, v, p.prevMove);
    const neg = isBest ? undefined : principles(fenBefore, moveUci).find((x) => !x.good);
    let headline = r ? `${r.san} ${r.reason}.` : `${move.san} is a reasonable move.`;
    const details: (string | null | false | undefined)[] = r && !r.fallback ? [r.details[0]] : [];
    if (neg && (!r || r.fallback || r.title === 'Positional' || r.title === 'Opening principle')) {
      headline = `${move.san} is playable, but it ${principleText(neg)}.`;
      details.length = 0;
    }
    if (r) arrows.push(...r.arrows);
    if (iHadMate && iStillMate > iHadMate && bestSan) {
      details.push(`${bestSan} was even quicker: mate in ${iHadMate}.`);
      arrows.push(...arrow(bestUci, 'best'));
    } else if (!isBest && bestSan && (cl.cls === 'good' || neg)) {
      const br = bestReason();
      const better = br && !br.fallback && br.reason !== r?.reason;
      details.push(better ? `${bestSan} was better: it ${br.reason}.` : `${bestSan} was slightly more accurate.`);
      arrows.push(...arrow(bestUci, 'best'));
    }
    if (cl.cls === 'brilliant' || cl.cls === 'great') {
      const sac = sacrificeDetail(fenAfter, reply, refutation.sans, me, v);
      if (sac) details.push(sac);
      else if (cl.cls === 'great' && isBest && onlyGoodMove(beforeLines)) {
        details.push('It was the only good move here.');
      }
    }
    if (r?.fallback && details.length === 0) details.push(...r.details);
    return done(headline, details, r?.title ?? 'Good move', r?.motifs ?? []);
  }
}

/**
 * Why a piece of the mover is lost (verb phrase after "This"): it moved into the attack, lost its
 * defender, was exposed by the moved piece stepping off a line, or is simply under-defended.
 */
function hangingVerb(h: Hanging, fenBefore: string, fenAfter: string, from: string, to: string, v: Voice): string {
  const piece = `${v.own} ${on(h.piece)}`;
  if (h.piece.square === to) return `hangs ${piece}`;
  const me = h.piece.color;
  if (scratch(fenBefore).attackers(h.piece.square, me).includes(from as Square)) {
    return `leaves ${piece} without a defender`;
  }
  const after = scratch(fenAfter);
  const exposer = after.attackers(h.piece.square, other(me)).find((a) => between(a, h.piece.square, from as Square));
  const exposerPiece = exposer ? after.get(exposer) : undefined;
  if (exposer && exposerPiece) return `exposes ${piece} to the ${NAME[exposerPiece.type]} on ${exposer}`;
  return h.defenders === 0 ? `leaves ${piece} undefended` : `leaves ${piece} attacked more times than it is defended`;
}

/** Motif kinds that explain how the opponent's reply wins material. */
const REPLY_KINDS: readonly MotifKind[] = [
  'fork',
  'doubleThreat',
  'skewer',
  'pin',
  'discovered',
  'trapped',
  'mateThreat',
  'promotionThreat',
];

/** "<lead> Ra1+ Rb1 Rxb1#." for short mates, "It starts with Qxh7+ Kxh7 Nxf6+." for long ones. */
function mateSentence(lead: string, sans: readonly string[], mateIn: number): string | null {
  const plies = 2 * mateIn - 1;
  if (mateIn <= 3 && sans.length >= plies) return `${lead} ${sans.slice(0, plies).join(' ')}.`;
  return sans.length >= 3 ? `It starts with ${sans.slice(0, 3).join(' ')}.` : null;
}

/** Headline for a weak move without a concrete tactical reason, from the expected scores. */
function evalHeadline(cl: Classification, v: Voice, Opp: string): string {
  const b = cl.winBefore;
  const a = cl.winAfter;
  if (a <= 0.2 && b > 0.3) return `This gives ${Opp} a winning position.`;
  if (b >= 0.7 && a < 0.6) return `This throws away most of ${v.own} advantage.`;
  if (b > 0.55 && a <= 0.55) return `This lets ${Opp} back into the game.`;
  if (a < 0.45 && b >= 0.45) return `This gives ${Opp} the better game.`;
  if (b > 0.55) return `This gives away part of ${v.own} advantage.`;
  return b - a < 0.1 ? `This makes ${v.own} position a little worse.` : `This makes ${v.own} position worse.`;
}

/** True when the top engine line is clearly better than the second one. */
function onlyGoodMove(lines: readonly PvLine[]): boolean {
  const [a, b] = lines;
  return !!a && !!b && scoreToWin(a.score) - scoreToWin(b.score) >= 0.1;
}

/**
 * For a sacrifice (brilliant / great): the piece left en prise and what happens if it is taken,
 * e.g. "If Black takes with Bxd1, Bxf7+ Ke7 Nd5# is checkmate."
 */
function sacrificeDetail(
  fenAfter: string,
  reply: Line | null,
  refutation: string[],
  me: Color,
  v: Voice,
): string | null {
  const h = hangingPieces(fenAfter, me).find((x) => x.see >= 2);
  if (!h) return null;
  const Opp = SIDE[other(me)];
  const name = NAME[h.piece.type];
  const accepted = reply?.pv[0]?.slice(2, 4) === h.piece.square;
  if (accepted) {
    return refutation.length >= 2
      ? `The ${name} sacrifice pays off: ${refutation.slice(0, 4).join(' ')}.`
      : `Giving up the ${name} pays off.`;
  }
  const take = winningCaptures(fenAfter).find((w) => w.to === h.piece.square);
  if (take) {
    const c = new Chess(fenAfter);
    c.move({ from: take.from, to: take.to, promotion: 'q' });
    const mate = forcedMateLine(c.fen(), 2);
    if (mate) return `If ${Opp} takes with ${take.san}, ${mate.join(' ')} is checkmate.`;
  }
  return `Taking ${v.own} ${on(h.piece)} would be a mistake for ${Opp}.`;
}

