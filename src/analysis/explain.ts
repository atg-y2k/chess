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
import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js';
import type { AnalysisResult, PvLine, Score } from '../engine/types';
import { PIECE_NAMES, pvToSan, sideToMove, uciToSan } from '../chess/utils';
import type { Arrow, ArrowBrush, Classification, Explanation, MoveClass } from './types';
import { detectSacrifice } from './sacrifice';
import { scoreToWin } from './winprob';
import {
  VALUE,
  between,
  effectiveAttackers,
  exchangeCounts,
  hangingPieces,
  other,
  pieces,
  scratch,
  see,
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
  passTurn,
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

/**
 * False when the line stops in the middle of an exchange and the pending recapture (see
 * `materialOutcome`) is worth more or less than the piece it takes back: `won` / `lost` then do not
 * add up to `net`, and naming them would be wrong.
 */
function nounsMatch(o: MaterialOutcome): boolean {
  if (o.settled) return true;
  const promo = (xs: readonly PieceSymbol[] | undefined) => (xs ?? []).reduce((n, t) => n + VALUE[t] - 1, 0);
  return Math.abs(worth(o.won) - worth(o.lost) + promo(o.promoted) - promo(o.theirPromoted) - o.net) < 0.5;
}

/** What the side of `o` gains, as a noun phrase ("a knight", "the exchange"), or null for nothing. */
export function materialNoun(o: MaterialOutcome): string | null {
  if (o.net < 1) return null;
  if (!nounsMatch(o)) return o.net === 1 ? 'a pawn' : 'material';
  return nounOf(o);
}

/** `materialNoun` from the piece lists (the caller has checked they are consistent). */
function nounOf(o: MaterialOutcome): string | null {
  if (o.net < 1) return null;
  const W = o.won;
  const L = o.lost;
  if (worth(W) === 0) return o.promoted?.length ? `a new ${NAME[o.promoted[0]]}` : null;
  if (worth(L) === 0) return nounList(W);
  if (isExchange(W, L)) return `the exchange${W.p ? ` and ${nounList({ p: W.p })}` : ''}`;
  return `${nounList(W)} for ${nounList(L)}`;
}

/** "promotes to a queen" / "promotes to a knight" for the promotions of one side, or ''. */
function promotesTo(xs: readonly PieceSymbol[] | undefined): string {
  if (!xs?.length) return '';
  return xs.length === 1 ? `promotes to a ${NAME[xs[0]]}` : `promotes ${NUM[Math.min(xs.length, 8)]} pawns`;
}

/**
 * The material result of a line as a verb phrase: "wins a knight", "wins the exchange",
 * "wins the queen for a rook", "promotes to a queen", "loses a pawn", "lets White make a new
 * queen"; null when about even. `opponent` names the other side ("White").
 */
export function describeMaterial(o: MaterialOutcome, opponent = 'the opponent'): string | null {
  if (!nounsMatch(o)) return o.net >= 1 ? `wins ${materialNoun(o)}` : o.net <= -1 ? 'loses material' : null;
  const promo = promotesTo(o.promoted);
  const they = o.theirPromoted ?? [];
  const theirs = they.length
    ? `lets ${opponent} ${they.length === 1 ? `make a new ${NAME[they[0]]}` : 'promote twice'}`
    : '';
  if (Math.abs(o.net) < 1 && !promo && !theirs) return null;
  if (o.net <= -1) {
    const W = o.won;
    const L = o.lost;
    if (worth(L) === 0) return theirs || 'loses material';
    const loss =
      worth(W) === 0
        ? `loses ${nounList(L)}`
        : `loses ${isExchange(L, W) ? 'the exchange' : `${nounList(L)} for ${nounList(W)}`}`;
    return theirs ? `${loss} and ${theirs}` : loss;
  }
  if (o.net < 1) return promo || null;
  const but = theirs ? `, but it ${theirs}` : '';
  if (worth(o.won) === 0) return promo ? `${promo}${but}` : null;
  const noun = nounOf({ ...o, promotions: 0, promoted: [] }) ?? nounList(o.won);
  return `wins ${noun}${promo ? ` and ${promo}` : ''}${but}`;
}

/**
 * The outcome of a recapture counted from before the opponent's capture: the piece they took
 * (`piece`) is added back to what was lost, so taking it back is not a gain.
 */
function countFromBeforeCapture(o: MaterialOutcome, piece: PieceSymbol): MaterialOutcome {
  const won: Partial<Counts> = { ...o.won };
  const lost: Partial<Counts> = { ...o.lost };
  const minor = piece === 'b' || piece === 'n';
  if (won[piece]) won[piece] = won[piece]! - 1;
  else if (minor && (won.b || won.n)) {
    if (won.b) won.b--;
    else won.n = (won.n ?? 1) - 1;
  } else lost[piece] = (lost[piece] ?? 0) + 1;
  for (const w of [won, lost]) for (const k of Object.keys(w) as PieceSymbol[]) if (!w[k]) delete w[k];
  return { ...o, won, lost, net: o.net - VALUE[piece] };
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
      if (m.exploit) return `attacks ${theOn(m.pinned, poss)} while it is pinned to the ${NAME[m.behind.type]}`;
      return `pins ${theOn(m.pinned, poss)} to the ${NAME[m.behind.type]}${m.frozen ? KING_PIN : ''}`;
    case 'skewer':
      return `skewers ${theOn(m.front, poss)}: once it moves, ${theOn(m.back, poss)} behind it falls`;
    case 'discovered':
      return m.target.type === 'k'
        ? `uncovers check from the ${on(m.by)}`
        : `uncovers an attack by the ${on(m.by)} on ${theOn(m.target, poss)}`;
    case 'freeCapture': {
      // Why nobody takes back: no defender, pinned defenders, too few defenders (x-rays counted),
      // a cheap piece taking a dear one, or defenders worth more than what they would win.
      const what = theOn(m.captured, poss);
      if (m.defenders === 0) {
        if (m.pinned) return `takes ${what} (${m.pinned > 1 ? 'its defenders are' : 'its defender is'} pinned)`;
        return `takes ${poss} undefended ${on(m.captured)}`;
      }
      if (m.attackers > m.defenders) {
        return `takes ${what} (attacked ${times(m.attackers)}, defended only ${times(m.defenders)})`;
      }
      if (VALUE[m.captured.type] > VALUE[m.by]) return `takes ${what} with ${withArticle(m.by)}`;
      return `takes ${what} (taking back would lose material)`;
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

/** "once", "twice", "3 times". */
const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/**
 * "<subject>, which <reason>", or "<subject>: it <reason>" when the reason has a "which" clause of
 * its own (no "Best was X, which prepares Y, which …" chains).
 */
function withWhich(subject: string, reason: string): string {
  return /\bwhich\b/.test(reason) ? `${subject}: it ${reason}` : `${subject}, which ${reason}`;
}

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
      return 'takes space in the center';
    case 'centreControl':
      return 'fights for the center';
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
      return 'pushes a passed pawn toward promotion';
    case 'rookSeventh':
      return 'puts the rook on the seventh rank';
    case 'openFile':
      return `puts the rook on the open ${p.to[0]}-file`;
    case 'opensLine':
      return p.freed?.type === 'b'
        ? `opens a diagonal for the bishop on ${p.freed.square}`
        : 'opens a line for the queen';
    case 'tradeAhead':
      return 'trades pieces while ahead, so the extra material counts for more';
    case 'trade':
      return p.captured === p.piece
        ? `trades ${NAME[p.piece]}s`
        : `trades ${withArticle(p.piece)} for ${withArticle(p.captured ?? 'p')}`;
    case 'bishopPair':
      return 'gives up the bishop pair';
    case 'kingActive':
      return 'brings the king toward the center';
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
  /** Squares of the opponent's pieces the reason is about (what it wins, attacks or trades). */
  targets: Square[];
  /** True when nothing specific was found ("improves the position"). */
  fallback: boolean;
}

/** Options of `explainLine`. */
interface LineOptions {
  /** This is the follow-up move of an outer line (no further look-ahead). */
  nested?: boolean;
  /** The MultiPV lines of `fen`, when known: can a follow-up move be played at once just as well? */
  lines?: readonly PvLine[];
}

/**
 * The mover's recapture on the square of the opponent's last capture along `pv`: at once (ply 0)
 * or after an in-between check (ply 2); null when there is none.
 */
function recaptureIn(
  fen: string,
  pv: readonly string[],
  prev: PrevMove | undefined,
): { ply: 0 | 2; move: Move } | null {
  if (!prev?.captured || VALUE[prev.captured as PieceSymbol] === undefined) return null;
  const ms = playLine(fen, pv, 3).moves;
  if (ms[0]?.to === prev.to && ms[0].captured) return { ply: 0, move: ms[0] };
  if (ms[0]?.san.includes('+') && ms[2]?.to === prev.to && ms[2].captured) return { ply: 2, move: ms[2] };
  return null;
}

/** `m` (a move from some line) played in `fen` by the same piece, or null when it is not legal there. */
function playAt(fen: string, m: Pick<Move, 'from' | 'to' | 'piece' | 'color' | 'promotion'>): Move | null {
  try {
    const c = new Chess(fen);
    const p = c.get(m.from);
    if (!p || p.type !== m.piece || p.color !== m.color) return null;
    return c.move({ from: m.from, to: m.to, promotion: m.promotion });
  } catch {
    return null;
  }
}

/**
 * Why the first move of `line` (an engine line for `fen`, mover's POV) is good. `prev`: the
 * opponent's last move (a recapture is not a gain).
 */
function explainLine(fen: string, line: Line, v: Voice, prev?: PrevMove, opts: LineOptions = {}): Reason | null {
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
    targets: [],
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
    return res('Forced mate', 'is the most stubborn defense', rest, { motifs: ['mated'] });
  }

  // Material won along the line, with the tactic that explains it. A recapture (at once, or after
  // an in-between check) is counted from before the opponent's capture: taking the piece back is
  // not a gain.
  const out = materialOutcome(fen, line.pv, me);
  const Opp = SIDE[other(me)];
  const recap = recaptureIn(fen, line.pv, prev);
  const recapture = recap?.ply === 0;
  const lateRecapture = recap?.ply === 2 && out.sans.length >= 3 ? recap.move : null;
  const prevPiece = recap && (recapture || lateRecapture) ? (prev!.captured as PieceSymbol) : null;
  const prevValue = prevPiece ? VALUE[prevPiece] : 0;
  const gained = prevPiece ? countFromBeforeCapture(out, prevPiece) : out;
  const mat = describeMaterial(gained, Opp);
  const balance = materialBalance(pre, me) + prevValue;
  const matAfter = balance + gained.net;
  // If the line "wins" a lot but the eval is far below the resulting material balance, the other
  // side is sacrificing for compensation: don't claim a win (Stockfish compresses big advantages).
  const evalPawns = line.score?.kind === 'cp' ? line.score.value / 100 : undefined;
  const compensated =
    evalPawns !== undefined &&
    gained.net >= 2 &&
    matAfter > 0 &&
    evalPawns < matAfter - 2.5 &&
    evalPawns < 0.6 * matAfter &&
    canWin(out.fen, me);
  const hot = [...out.captureSquares, ...(move.captured ? [move.to] : [])];
  // Only motifs that explain where the material actually comes from (not the piece taken back).
  const explains = (m: Motif) => {
    if (m.kind === 'freeCapture') return !recapture && VALUE[m.captured.type] >= gained.net - 1;
    if (m.kind === 'mateThreat' || m.kind === 'promotion' || m.kind === 'promotionThreat') return true;
    return motifSquares(m).some((q) => out.captureSquares.includes(q));
  };
  const relevant = rankMotifs(
    motifs.filter((m) => TACTICAL_KINDS.includes(m.kind)),
    hot,
  ).filter(explains);
  const tactic = relevant.find((m) => motifClause(m, v.victim));
  // A move does not "win" a pawn the opponent gives up for play (a gambit line) or wins back soon
  // after the line ends (1.e4 c6 2.c4 d5 3.cxd5 cxd5 4.exd5 Nf6, then ...Nxd5), unless a tactic
  // explains the gain or the evaluation backs it up. Winning back a pawn (ending no better than
  // even) is only doubted for a quiet move far below the evaluation.
  const gambit =
    evalPawns !== undefined &&
    !move.promotion &&
    !tactic &&
    gained.net < 2 &&
    evalPawns < 0.5 &&
    (matAfter > 0.5 ? evalPawns < matAfter - 0.5 : !move.captured && evalPawns < matAfter - 0.7);
  // Nor when another engine line that wins nothing scores about the same in a roughly level
  // position: the extra pawn does not show in the evaluation. (When clearly ahead, the other lines
  // often just win it a move later.)
  const cpScore = line.score?.kind === 'cp' ? line.score.value : null;
  const evenInLines =
    cpScore !== null &&
    cpScore < 150 &&
    !!opts.lines &&
    matAfter > 0.5 &&
    gained.net < 2 &&
    !tactic &&
    !move.promotion &&
    opts.lines.some(
      (l) =>
        l.pv.length > 0 &&
        l.pv[0] !== uci &&
        l.score.kind === 'cp' &&
        l.score.value >= cpScore - SAME_CP &&
        materialOutcome(fen, l.pv, me).net <= out.net - 1,
    );
  // Nor does it "let the pawn promote" when the pawn could safely promote right now.
  let promotesNow = false;
  if (!move.promotion && gained.promoted?.length && worth(gained.won) === 0) {
    const pm = playLine(fen, line.pv, out.sans.length).moves.find((m, i) => i % 2 === 0 && m.promotion);
    const now = pm ? playAt(fen, pm) : null;
    promotesNow = !!now && see(now.after, now.to, other(me)) <= 0;
  }
  if (gained.net >= 1 && mat && !compensated && !gambit && !evenInLines && !promotesNow) {
    if (tactic) arrows.push(...motifArrows(tactic, move.to));
    const back = balance < 0 && gained.net <= -balance + 0.5 && worth(gained.lost) === 0;
    let reason = back ? mat.replace(/^wins /, 'wins back ') : mat;
    if (!move.promotion && gained.promoted?.length) {
      // The promotion comes later in the line, not with this move.
      const promo = out.sans.find((x, i) => i % 2 === 0 && x.includes('='));
      reason =
        worth(gained.won) === 0
          ? `lets ${v.own} pawn promote${promo ? ` with ${promo}` : ''}`
          : reason.replace(/(and )?promotes to/, (_, and) => `${and ?? ''}then promotes to`);
    }
    const keyLine = out.sans.length > 1 ? `Key line: ${out.sans.slice(0, 6).join(' ')}.` : null;
    // "promotes to a queen" already says what the promotion motif would.
    const said = tactic?.kind === 'promotion' && /promotes/.test(reason);
    const detail = tactic && !said ? `It ${motifClause(tactic, v.victim)}.` : keyLine;
    const title = tactic ? (MOTIF_TITLE[tactic.kind] ?? 'Wins material') : 'Wins material';
    return res(title, reason, detail ? [detail] : [], {
      motifs: ['winsMaterial', ...(tactic ? [tactic.kind] : [])],
      targets: [...hot, ...(tactic ? motifSquares(tactic) : [])],
    });
  }
  const took = move.captured ? [move.to] : [];
  if (recapture) {
    return res('Recapture', `recaptures the ${NAME[move.captured!]}`, [], { motifs: ['recapture'], targets: took });
  }
  if (lateRecapture) {
    const what = `the ${NAME[lateRecapture.captured!]} with ${lateRecapture.san}`;
    return res('Recapture', `gives check first, then takes back ${what}`, [], { motifs: ['recapture'] });
  }
  if (pre.inCheck()) return res('Check', escapeText(move.captured, move.piece), [], { motifs: ['escapesCheck'] });
  if (pre.moves().length === 1) return res('Only move', 'is the only legal move', [], { motifs: ['onlyMove'] });

  const stopped = stoppedThreat(fen, uci);
  if (stopped) {
    arrows.push(...arrow(stopped.from + stopped.to, 'threat'));
    return res('Defense', stoppedText(stopped, v.own), [], { motifs: ['defence'] });
  }

  // Material given up along the line: a sacrifice (this move puts it en prise), or returning part
  // of a big lead while staying winning. A pawn given back is only mentioned when nothing else is.
  const keyLine = out.sans.length > 1 ? [`Key line: ${out.sans.slice(0, 6).join(' ')}.`] : [];
  const givenUp = givenUpReason(fen, uci, line, out, matAfter, Opp, v);
  if (givenUp && (givenUp.title === 'Promotion' || worth(out.lost) - worth(out.won) >= 2)) {
    return res(givenUp.title, givenUp.reason, keyLine, { motifs: givenUp.motifs, targets: took });
  }

  // Strong tactics first, then principles, then minor motifs (a simple threat or attack). When the
  // engine line shows the move wins nothing, a "winning" tactic (fork, double attack, skewer, trap)
  // is not real: the opponent has a defence.
  const lineWins = gained.net >= 1 || line.pv.length < 3;
  const top = rankMotifs(motifs).find(
    (m) => (lineWins || !WINNING_KINDS.includes(m.kind)) && motifClause(m, v.victim),
  );
  // For a capture, what was traded matters more than development or the center.
  const tradeFirst = (p: Principle) => (move.captured && (p.kind === 'trade' || p.kind === 'tradeAhead') ? 0 : 1);
  const good = principles(fen, uci)
    .filter((p) => p.good)
    .sort((a, b) => tradeFirst(a) - tradeFirst(b));
  const strong = !!top && !MINOR_KINDS.includes(top.kind);
  const parts: { text: string; tag: string; motif?: Motif }[] = good.map((p) => ({
    text: principleText(p),
    tag: p.kind,
  }));
  if (top) parts.splice(strong ? 0 : parts.length, 0, { text: motifClause(top, v.victim)!, tag: top.kind, motif: top });
  if (parts.length) {
    const first = parts[0];
    const second = parts[1];
    // A capture that wins material is the whole story ("takes the undefended knight on e5").
    const joinable =
      !!second && first.motif?.kind !== 'freeCapture' && !/[,:]| and /.test(first.text) && !/[,:]/.test(second.text);
    const used = joinable ? [first, second] : [first];
    const m = used.find((x) => x.motif)?.motif;
    if (m) arrows.push(...motifArrows(m, move.to));
    const title = first.motif
      ? (MOTIF_TITLE[first.motif.kind] ?? 'Tactic')
      : OPENING_PRINCIPLES.has(first.tag as Principle['kind'])
        ? 'Opening principle'
        : 'Positional';
    const targets = [...(m ? motifSquares(m) : []), ...took];
    return res(title, joinAnd(used.map((x) => x.text)), [], { motifs: used.map((x) => x.tag), targets });
  }

  // Nothing about the move itself: say what it prepares (the mover's next move in the line).
  const checks = motifs.some((m) => m.kind === 'check');
  if (!opts.nested && out.net > -1) {
    const next = followUp(fen, line, v, checks, opts.lines);
    if (next) {
      const reason = checks
        ? `gives check, and then ${next.san} ${next.reason}`
        : `prepares ${next.san}, which ${next.reason}`;
      // The follow-up's detail is about the follow-up: name it, and show its key line from here.
      const d = next.details[0];
      const detail = d?.startsWith('It ')
        ? `${next.san} ${d.slice(3)}`
        : d?.startsWith('Key line:')
          ? `Key line: ${playLine(fen, line.pv, 6).sans.join(' ')}.`
          : null;
      return res(next.title, reason, detail ? [detail] : [], {
        motifs: ['prepares', ...next.motifs],
        targets: next.targets,
      });
    }
  }
  if (givenUp) return res(givenUp.title, givenUp.reason, keyLine, { motifs: givenUp.motifs, targets: took });
  const main = playLine(fen, line.pv, 5).sans;
  const mainLine = main.length > 1 ? [`Main line: ${main.join(' ')}.`] : [];
  if (checks) return res('Check', 'gives check', mainLine, { fallback: true, motifs: ['check'] });
  return res('Positional', 'improves the position', mainLine, { fallback: true });
}

/**
 * The line gives material away: "sacrifices a knight for a pawn" (the move puts it en prise) or
 * "gives up the exchange and keeps a winning position" (returning part of a big lead); else null.
 */
function givenUpReason(
  fen: string,
  uci: string,
  line: Line,
  out: MaterialOutcome,
  matAfter: number,
  Opp: string,
  v: Voice,
): { title: string; reason: string; motifs: string[] } | null {
  if (out.net > -1 || !out.settled || !line.score || line.pv.length < 2) return null;
  const first = playLine(fen, line.pv, 2).moves;
  if (first[0]?.promotion && first[1]?.to === first[0].to) {
    const piece = NAME[first[0].promotion];
    return { title: 'Promotion', reason: `promotes, but the new ${piece} is taken at once`, motifs: ['promotion'] };
  }
  const loss = describeMaterial(out, Opp);
  const given = loss?.startsWith('loses ') ? loss.slice('loses '.length) : null;
  if (!given) return null;
  const winning = scoreToWin(line.score) >= WINNING;
  const givesBack = {
    title: 'Gives back material',
    reason: `gives up ${given} and keeps a winning position`,
    motifs: ['givesBack'],
  };
  if (winning && matAfter >= 3) return givesBack;
  // Giving material up in a lost position is not a sacrifice.
  const sac = scoreToWin(line.score) > 1 - WINNING ? detectSacrifice(fen, uci) : null;
  if (sac) {
    // Name the piece offered when the line wins part of it back ("sacrifices the knight on d6").
    const piece = sac.piece as PieceSymbol;
    const what = out.lost[piece] ? given : theOn({ square: sac.square, type: piece, color: sideToMove(fen) }, v.own);
    return { title: 'Sacrifice', reason: `sacrifices ${what}`, motifs: ['sacrifice'] };
  }
  return winning ? givesBack : null;
}

/** Tactics that claim to win material (not real when the engine line wins nothing). */
const WINNING_KINDS: readonly MotifKind[] = ['fork', 'doubleThreat', 'skewer', 'trapped'];

/** Reasons a follow-up move may give ("prepares Qh5, which threatens mate with Qh7#"). */
const FOLLOW_TITLES = new Set([
  'Checkmate',
  'Forced mate',
  'Wins material',
  'Fork',
  'Double attack',
  'Pin',
  'Skewer',
  'Discovered attack',
  'Trapped piece',
  'Mate threat',
  'Promotion',
  'Threat',
  'Sacrifice',
]);

/**
 * The reason for the mover's next move Y in `line` (two plies on), when it is a concrete one that
 * the first move X makes possible ("X prepares Y, which …"). Not when Y is about a piece the
 * opponent's reply puts there, when the reply is what makes Y legal, or when Y could be played at
 * once about as well (`lines`: the MultiPV set of `fen`). After a check (`checks`) the reply is
 * forced and the text only says "and then", so those tests are skipped.
 */
function followUp(fen: string, line: Line, v: Voice, checks: boolean, lines?: readonly PvLine[]): Reason | null {
  if (line.pv.length < 3) return null;
  const pl = playLine(fen, line.pv, 3);
  if (pl.moves.length < 3) return null;
  const [x, reply, y] = pl.moves;
  // Two plies later the same side is to move: a mate score is one move shorter.
  const score: Score | undefined =
    line.score?.kind === 'mate' && line.score.value > 1 ? { kind: 'mate', value: line.score.value - 1 } : line.score;
  const prev = reply.captured ? { to: reply.to, captured: reply.captured } : undefined;
  const r = explainLine(pl.fens[2], { pv: line.pv.slice(2), score }, v, prev, { nested: true });
  if (!r || r.fallback) return null;
  if (!FOLLOW_TITLES.has(r.title) && !r.motifs.some((k) => FOLLOW_PRINCIPLES.has(k))) return null;
  if (checks) return r;
  // About pieces that are on the board now, not ones the reply brings in ("prepares cxd5" after …d5).
  const root = scratch(fen);
  const then = scratch(pl.fens[2]);
  const arrived = r.targets.some((sq) => {
    const p = then.get(sq);
    const q = root.get(sq);
    return !!p && p.color !== x.color && (!q || q.color !== p.color || q.type !== p.type);
  });
  if (arrived) return null;
  // Y played at once: when Y moves the piece X just moved, that piece going there directly
  // (Rf5 then Rh5 is Rh5 at once).
  const now = playAt(fen, y.from === x.to ? { ...y, from: x.from } : y);
  // Illegal now: X must be what makes it legal (still legal if the opponent passed after X).
  if (!now) return playAt(passTurn(pl.fens[1]), y) ? r : null;
  return clearlyWorseNow(now, line, lines) ? r : null;
}

/**
 * Whether a follow-up move played at once (`now`, in the root position) is clearly worse than
 * preparing it with the line's first move: its own MultiPV line scores clearly lower (or it is not
 * among lines that already fall clearly short), or it would simply lose the moved piece now.
 */
function clearlyWorseNow(now: Move, line: Line, lines?: readonly PvLine[]): boolean {
  if (lines?.length && line.score) {
    const uci = now.from + now.to + (now.promotion ?? '');
    const alt = lines.find((l) => l.pv[0] === uci);
    if (alt) return !asGood(alt.score, line.score);
    const last = lines[lines.length - 1];
    if (lines.length >= 2 && !asGood(last.score, line.score)) return true;
  }
  return see(now.after, now.to, other(now.color)) > (now.captured ? VALUE[now.captured] : 0);
}

/** `alt` is about as good as `main` or better (same thresholds as "about as good" in `compareLines`). */
function asGood(alt: Score, main: Score): boolean {
  const a = scoreToWin(alt);
  const m = scoreToWin(main);
  return a >= m || (m - a < SAME_GAP && cpGap(alt, main) <= SAME_CP);
}

/** Principles worth preparing ("Be2 prepares O-O, which castles the king to safety …"). */
const FOLLOW_PRINCIPLES = new Set<string>(['castles', 'trade', 'tradeAhead', 'rookSeventh', 'passedPawn']);

/** Expected score at or above which the mover is winning (about +3). */
const WINNING = 0.75;

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
  if (t.kind === 'promotion') return `stops the pawn from promoting with ${t.san}`;
  return `saves ${own} ${t.target ? on(t.target) : 'piece'} from ${t.san}`;
}

// ------------------------------------------------------------------ public API

/** Options of `explainBestMove`. */
export interface ExplainBestMoveOptions {
  prevMove?: PrevMove;
  perspective?: Perspective;
  /**
   * All engine lines for `fen` (the MultiPV set, best first), when known. They let a quiet move
   * without a concrete reason be described by how it compares: "is the only move that keeps the
   * advantage", or "keeps the balance" with "Nf3 and c4 are about as good".
   */
  lines?: readonly PvLine[];
}

/**
 * Why is this (engine) move good? Used for hints ("Show hint"), for "Best was X, which …" and to
 * praise good moves. `line` is an engine line for `fen` (side-to-move POV); `line.pv[0]` is the
 * move explained. Pass the other MultiPV lines as `opts.lines` for better text on quiet moves
 * (the same lines `explainMove` gets as `before`, so a hint and the feedback on the move agree).
 * Never throws.
 */
export function explainBestMove(fen: string, line: PvLine, opts: ExplainBestMoveOptions = {}): Explanation {
  try {
    const v = voice(sideToMove(fen), opts.perspective);
    const r = explainLine(fen, { pv: line.pv, score: line.score }, v, opts.prevMove, { lines: opts.lines });
    if (!r) return { headline: 'There is no move to suggest here.', details: [] };
    let headline = `${r.san} ${r.reason}.`;
    let details = r.details;
    let motifs = r.motifs;
    const cmp = compareLines(fen, { pv: line.pv, score: line.score }, opts.lines, v);
    if (cmp && r.fallback) {
      // Nothing concrete about the move itself: say how it compares with the alternatives.
      headline = r.title === 'Check' ? `${r.san} gives check and ${cmp.reason}.` : `${r.san} ${cmp.reason}.`;
      details = cmp.detail ? [cmp.detail, ...r.details] : r.details;
      motifs = [...r.motifs, ...cmp.motifs];
    } else if (cmp?.only && (r.title === 'Positional' || r.title === 'Opening principle')) {
      details = [...r.details, 'It is the only good move here.'];
      motifs = [...r.motifs, ...cmp.motifs];
    }
    return {
      headline,
      details: details.slice(0, 3),
      bestLineSan: pvToSan(fen, line.pv, 6),
      arrows: dedupeArrows([...arrow(line.pv[0], 'best'), ...r.arrows]),
      title: r.title,
      motifs,
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
      bestReasonMemo =
        bestLine && !isBest ? explainLine(fenBefore, bestLine, v, p.prevMove, { lines: beforeLines }) : null;
    }
    return bestReasonMemo;
  };
  const bestSentence = (lead: string) => {
    const br = bestReason();
    return br && !br.fallback ? `${withWhich(`${lead} ${bestSan}`, br.reason)}.` : `${lead} ${bestSan}.`;
  };
  const arrows: Arrow[] = [];
  type Maybe = string | null | undefined | false;
  const done = (
    headline: string,
    details: Maybe[],
    title: string,
    motifs: string[],
    extra: Partial<Explanation> = {},
  ): Explanation => ({
    headline,
    details: details.filter((d): d is string => !!d).slice(0, 3),
    ...(bestLineSan?.length ? { bestLineSan } : {}),
    arrows: dedupeArrows(arrows),
    title,
    motifs,
    ...extra,
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
      return done(`${move.san} is the most stubborn defense.`, [`${mateIn}.`], 'Forced mate', ['mated']);
    }
    arrows.push(...arrow(bestUci, 'best'));
    const longer = bestSan && `${bestSan} would have lasted longer.`;
    // A class that praises the move (the expected score barely moves when mated anyway) would
    // contradict this text: flag it for the UI.
    const concedes = BAD.includes(cl.cls) ? {} : { concedes: 'mate' as const };
    return done(`This lets ${Opp} mate faster.`, [`${mateIn}.`, longer], 'Forced mate', ['mated'], concedes);
  }
  // Mate distances in moves from before this move, like `bestMate` (the reply's score counts from after it).
  const iHadMate = bestMate !== null && bestMate > 0 ? bestMate : 0;
  const iStillMate = replyMate !== null && replyMate <= 0 ? -replyMate + 1 : 0;
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

  // Material along the played line and the best line (mover's POV), computed on demand.
  let outs: { played: MaterialOutcome; best: MaterialOutcome | null } | undefined;
  const lineOutcomes = () =>
    (outs ??= {
      played: materialOutcome(fenBefore, playedLine.pv, me),
      best: bestLine ? materialOutcome(fenBefore, bestLine.pv, me) : null,
    });
  const replyMove = refutation.moves[0];
  const recapture = !!(p.prevMove?.captured && p.prevMove.to === move.to);
  const grab = move.captured && !recapture ? `${move.san} grabs ${withArticle(move.captured)}, but it` : null;
  /** `direct`: the reply simply takes a piece the move left hanging. */
  type Verdict = { headline: string; details: string[]; title: string; motifs: string[]; direct?: boolean };

  /** The move loses material to the reply that the best move would not have lost. */
  function materialLost(): Verdict | null {
    const { played, best } = lineOutcomes();
    if (!reply || !replyMove || played.net > -1 || played.net >= (best?.net ?? 0) - 0.5) return null;
    const oppOut = materialOutcome(fenAfter, reply.pv, opp);
    // After "Nxe5 grabs a pawn, but it …" name only what is lost, not the trade balance.
    const noun = (grab ? (worth(oppOut.won) > 0 ? nounList(oppOut.won) : null) : materialNoun(oppOut)) ?? 'material';
    const gains = describeMaterial(oppOut, SIDE[me]) ?? 'wins material';
    const replyMotifs = moveMotifs(fenAfter, reply.pv[0])?.motifs ?? [];
    // A trapped piece counts only when it is what the reply goes on to win.
    const relevant = (m: Motif) =>
      REPLY_KINDS.includes(m.kind) &&
      (m.kind === 'mateThreat' ||
        m.kind === 'promotionThreat' ||
        (m.kind === 'discovered' && VALUE[m.target.type] >= 3) ||
        motifSquares(m).some((q) => oppOut.captureSquares.includes(q)));
    let mf: Motif | undefined = rankMotifs(replyMotifs.filter(relevant), oppOut.captureSquares)[0];
    const hang = hangingPieces(fenAfter, me).find(
      (h) => h.piece.square === replyMove.to || oppOut.captureSquares.includes(h.piece.square),
    );
    // The reply simply takes a hanging piece and threatens mate (or promotion) on the way, without
    // winning more: the piece was lost because it hung, not to the threat.
    let alsoThreat: string | null = null;
    if (
      (mf?.kind === 'mateThreat' || mf?.kind === 'promotionThreat') &&
      hang?.piece.square === replyMove.to &&
      worth(oppOut.won) <= VALUE[hang.piece.type] + 1
    ) {
      alsoThreat = `${replyMove.san} also ${motifClause(mf, v.own)}.`;
      mf = undefined;
    }
    // Only a promotion: "This lets White make a new queen.", not "loses a new queen".
    const loses = noun.startsWith('a new ') ? `lets ${Opp} make ${noun}` : `loses ${noun}`;
    if (mf) {
      return {
        headline: loses.startsWith('lets ')
          ? `${grab ?? 'This'} ${loses}.`
          : `${grab ?? 'This'} ${loses} to ${motifNoun(mf)}.`,
        details: [`${withWhich(`${Opp} answers ${replyMove.san}`, motifClause(mf, v.own) ?? '')}.`],
        title: MOTIF_TITLE[mf.kind] ?? 'Loses material',
        motifs: [mf.kind],
      };
    }
    // A hanging piece explains the loss when the reply takes it, or when it is most of what is lost.
    if (hang && (hang.piece.square === replyMove.to || VALUE[hang.piece.type] >= worth(oppOut.won) - 1)) {
      const moved = hang.piece.square === move.to;
      const takes = hang.piece.square === replyMove.to;
      const lower = moved && takes && hang.defenders > 0 ? hang.lowerAttacker : undefined;
      const byLower = lower ? `Even though it is defended, ${withArticle(lower.type)} can take it: ` : '';
      // The reply takes it at once, or wins it later in the line.
      const how = takes
        ? `${byLower}${Opp} plays ${replyMove.san} and ${gains}.`
        : `After ${oppOut.sans.slice(0, 4).join(' ')}, ${Opp} ${gains}.`;
      return {
        headline: `${grab ?? 'This'} ${hangingVerb(hang, fenBefore, fenAfter, move.from, move.to, v)}.`,
        details: [how, ...(alsoThreat ? [alsoThreat] : [])],
        title: 'Hanging piece',
        motifs: ['hanging'],
        direct: hang.piece.square === replyMove.to && hang.piece.type !== 'p',
      };
    }
    return {
      headline: `${grab ?? 'This'} ${loses}.`,
      details: [`After ${oppOut.sans.slice(0, 4).join(' ')}, ${Opp} ${gains}.`],
      title: 'Loses material',
      motifs: ['losesMaterial'],
    };
  }

  // 3. Good moves: praise with the reason, plus the better move when there was one.
  if (!BAD.includes(cl.cls)) return praise();

  // 4. Bad moves.
  const { played: playedOut, best: bestOut } = lineOutcomes();
  const details: (string | null | false | undefined)[] = [];
  let headline: string;
  let title: string;
  let motifs: string[];
  const lost = materialLost();
  const under = move.promotion && move.promotion !== 'q' && bestUci === move.from + move.to + 'q';
  // Taking back the piece the opponent just captured is not material won: not doing so is its own
  // mistake, not a missed tactic (unless the best line wins more than the piece back).
  const prevPiece = p.prevMove?.captured as PieceSymbol | undefined;
  const bestRecap = !isBest && bestLine && prevPiece ? recaptureIn(fenBefore, bestLine.pv, p.prevMove) : null;
  const bestGain = bestOut ? (bestRecap ? countFromBeforeCapture(bestOut, prevPiece!).net : bestOut.net) : 0;
  const captor = bestRecap ? scratch(fenBefore).get(p.prevMove!.to as Square) : undefined;

  if (under) {
    // 4u. Underpromotion where a queen was best.
    headline = `${move.san} promotes to a ${NAME[move.promotion!]} instead of a queen.`;
    title = 'Promotion';
    motifs = ['underpromotion'];
  } else if (lost) {
    // 4a. Material lost to the reply.
    arrows.push(...arrow(reply?.pv[0], 'threat'));
    ({ headline, title, motifs } = lost);
    details.push(...lost.details);
  } else if (bestRecap && captor?.color === opp && bestGain < 1 && bestOut && bestOut.net - playedOut.net >= 1) {
    // 4r. Did not take back the piece the opponent just captured.
    headline = `${v.subject} didn't recapture the ${NAME[captor.type]} on ${p.prevMove!.to}.`;
    title = 'Missed recapture';
    motifs = ['missedRecapture'];
  } else if (bestOut && bestSan && bestLine && !isBest && bestGain >= 1 && bestOut.net - playedOut.net >= 1) {
    // 4b. Missed a tactic or free material.
    const br = bestReason();
    if (br && !br.fallback) {
      arrows.push(...arrow(bestUci, 'best'), ...br.arrows);
      return done(
        `${withWhich(`${v.subject} missed ${bestSan}`, br.reason)}.`,
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
    const rr = reply ? explainLine(fenAfter, reply, rv, took, { lines: p.after?.lines }) : null;
    if (neg) headline = `${move.san} ${principleText(neg)}.`;
    else if (cl.cls === 'miss') headline = `${v.subject} missed a chance to punish ${Opp}'s mistake.`;
    else headline = evalHeadline(cl.winBefore, cl.winAfter, v, Opp);
    // Only mention the reply when it does something concrete (a tactic, a threat, winning material).
    const useReply =
      !!rr && !rr.fallback && !['Recapture', 'Positional', 'Opening principle', 'Check'].includes(rr.title);
    if (useReply) {
      details.push(`${withWhich(`${Opp} can answer ${rr.san}`, rr.reason)}.`);
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
    // In a decided position a lost piece barely moves the expected score, so an Excellent or Good
    // move can still simply hang a piece: say so instead of praising it.
    const decided = cl.winBefore >= WINNING || cl.winBefore <= 1 - WINNING;
    const quietMove = !move.captured && !move.promotion && !iStillMate;
    if ((cl.cls === 'good' || cl.cls === 'excellent') && !isBest && decided && quietMove) {
      // Also a piece or more lost later in the line when already lost ("a reasonable try" would
      // hide it); when winning, giving material back can be fine ("gives up … and keeps …").
      const lost = materialLost();
      const alreadyLost = cl.winBefore <= 1 - WINNING;
      if (lost && (lost.direct || (alreadyLost && lineOutcomes().played.net <= -3))) {
        const still =
          cl.winAfter >= WINNING
            ? `${v.subject} ${v.you ? 'are' : 'is'} still winning.`
            : cl.winBefore <= 1 - WINNING
              ? 'The position was already lost.'
              : null;
        arrows.push(...arrow(reply?.pv[0], 'threat'), ...(bestSan ? arrow(bestUci, 'best') : []));
        const details = [...lost.details, still, bestSan && bestSentence('Best was')];
        // The class ("excellent") would contradict this text: flag it for the UI.
        return done(lost.headline, details, lost.title, lost.motifs, { concedes: 'material' });
      }
    }
    // The best move is explained with the same engine line (and lines) as the hint, so the two agree.
    const own = isBest && beforeLines[0]?.pv[0] === moveUci ? asLine(beforeLines[0]) : null;
    const r = explainLine(fenBefore, own ?? playedLine, v, p.prevMove, { lines: beforeLines });
    const cmp = own && r?.fallback ? compareLines(fenBefore, own, beforeLines, v) : null;
    const neg = isBest ? undefined : principles(fenBefore, moveUci).find((x) => !x.good);
    let headline = r ? `${r.san} ${r.reason}.` : `${move.san} is a reasonable move.`;
    const details: (string | null | false | undefined)[] = r && !r.fallback ? [r.details[0]] : [];
    const onlyMove = isBest && onlyGoodMove(beforeLines);
    const sac =
      cl.cls === 'brilliant' || cl.cls === 'great'
        ? sacrificeDetail(cl.cls, fenBefore, moveUci, fenAfter, reply, refutation.sans, me, v)
        : null;
    if (r?.fallback && r.title === 'Positional') headline = `${move.san} ${plainReason(r.reason)}.`;
    if (r?.fallback && r.title === 'Check' && cmp) headline = `${move.san} gives check and ${cmp.reason}.`;
    if (neg && (!r || r.fallback || r.title === 'Positional' || r.title === 'Opening principle')) {
      headline = `${move.san} is playable, but it ${principleText(neg)}.`;
      details.length = 0;
    }
    if (r) arrows.push(...r.arrows);
    if (sac && r?.title === 'Sacrifice') details.length = 0; // the sacrifice sentence shows the line
    if (iHadMate && iStillMate > iHadMate && bestSan) {
      details.push(`${bestSan} was even quicker: mate in ${iHadMate}.`);
      arrows.push(...arrow(bestUci, 'best'));
    } else if (!isBest && bestSan && (cl.cls === 'good' || neg)) {
      const br = bestReason();
      const same =
        !!br &&
        !!r &&
        (br.reason === r.reason ||
          r.details.includes(`It ${br.reason}.`) ||
          br.motifs.some((k) => TACTICAL_KINDS.includes(k as MotifKind) && r.motifs.includes(k)));
      const better = br && !br.fallback && !same;
      details.push(better ? `${bestSan} was better: it ${br.reason}.` : `${bestSan} was slightly more accurate.`);
      arrows.push(...arrow(bestUci, 'best'));
    }
    if (sac) details.push(sac);
    else if (cl.cls === 'great' && onlyMove && !headline.includes('the only move')) {
      details.push('It was the only good move here.');
    }
    if (r?.fallback && details.length === 0) details.push(cmp?.detail, ...r.details);
    return done(headline, details, r?.title ?? 'Good move', [...(r?.motifs ?? []), ...(cmp?.motifs ?? [])]);

    /** What kind of move it is when nothing specific was found, instead of "improves the position". */
    function plainReason(fallback: string): string {
      const sacked = cl.cls === 'brilliant' ? sacrificedPiece(fenBefore, moveUci, fenAfter, me, true) : null;
      if (sacked) return `sacrifices ${theOn(sacked, v.own)}`;
      if (onlyMove && bestLine?.score) return onlyMoveReason(bestLine.score);
      if (cl.cls === 'book') return 'is a known opening move';
      if (isBest) return cmp?.reason ?? fallback;
      if (cl.winAfter <= 1 - WINNING) return 'is a reasonable try in a difficult position';
      if (cl.winAfter >= WINNING) return `keeps ${v.own} winning position`;
      return cl.cls === 'good' ? 'is playable' : 'is a solid move';
    }
  }
}

/** "is the only move that keeps the advantage" (a Great only move without a concrete reason). */
function onlyMoveReason(best: Score): string {
  const w = scoreToWin(best);
  if (w >= 0.6) return 'is the only move that keeps the advantage';
  if (w >= 0.4) return 'is the only move that keeps the balance';
  return 'is the only move that keeps the game going';
}

/**
 * Why a piece of the mover is lost (verb phrase after "This"): it moved into the attack, lost its
 * defender, was exposed by the moved piece stepping off a line, was already lost before the move,
 * or is simply under-defended.
 */
function hangingVerb(h: Hanging, fenBefore: string, fenAfter: string, from: string, to: string, v: Voice): string {
  const piece = `${v.own} ${on(h.piece)}`;
  const sq = h.piece.square;
  if (sq === to) return `hangs ${piece}`;
  const me = h.piece.color;
  const opp = other(me);
  const after = scratch(fenAfter);
  // The moved piece defended it before, and no longer does from its new square (a queen sliding
  // along the same file still does).
  const defended = scratch(fenBefore).attackers(sq, me).includes(from as Square);
  if (defended && !effectiveAttackers(after, sq, me).includes(to as Square)) {
    return `leaves ${piece} without a defender`;
  }
  const exposer = after.attackers(sq, opp).find((a) => between(a, sq, from as Square));
  const exposerPiece = exposer ? after.get(exposer) : undefined;
  if (exposer && exposerPiece) return `exposes ${piece} to the ${NAME[exposerPiece.type]} on ${exposer}`;
  if (see(fenBefore, sq, opp) > 0) return `does nothing about the threat to ${piece}`;
  if (h.defenders === 0) return `leaves ${piece} undefended`;
  if (h.lowerAttacker) return `leaves ${piece} where ${withArticle(h.lowerAttacker.type)} can take it`;
  const ex = exchangeCounts(fenAfter, sq, opp);
  return ex.attackers > ex.defenders
    ? `leaves ${piece} attacked more times than it is defended`
    : `leaves ${piece} where it can be won`;
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

/** Headline for a weak move without a concrete tactical reason, from the expected scores before and after it. */
function evalHeadline(b: number, a: number, v: Voice, Opp: string): string {
  // Where the game ends up comes first: "back into the game" undersells a swing to the other side.
  if (a <= 0.2 && b > 0.3) return `This gives ${Opp} a winning position.`;
  if (a < 0.45 && b >= 0.45) return `This gives ${Opp} the better game.`;
  if (b >= 0.7 && a < 0.6) return `This throws away most of ${v.own} advantage.`;
  if (b > 0.55 && a <= 0.55) return `This lets ${Opp} back into the game.`;
  if (b > 0.55) return `This gives away part of ${v.own} advantage.`;
  return b - a < 0.1 ? `This makes ${v.own} position a little worse.` : `This makes ${v.own} position worse.`;
}

/** Expected-score gap from the best line at which another move is clearly worse. */
const ONLY_GAP = 0.1;

/** True when the top engine line is clearly better than the second one. */
function onlyGoodMove(lines: readonly PvLine[]): boolean {
  const [a, b] = lines;
  return !!a && !!b && scoreToWin(a.score) - scoreToWin(b.score) >= ONLY_GAP;
}

/** Moves this close in expected score (and within `SAME_CP`) are "about as good". */
const SAME_GAP = 0.02;
/** In a decided position expected scores barely move: also require the evaluations to be this close. */
const SAME_CP = 50;

/** How a move compares with the other engine lines (see `compareLines`). */
interface Comparison {
  /** Verb phrase: "is the only move that keeps the advantage", "keeps the balance". */
  reason: string;
  /** "Nf3 and c4 are about as good." / "It is more precise than Nf3." / "Anything else …". */
  detail: string | null;
  /** True when every other move is clearly worse. */
  only: boolean;
  motifs: string[];
}

/**
 * What the MultiPV lines say about the first move of `line` (the best line, mover's POV): the only
 * good move ("is the only move that keeps the advantage", "Anything else gives Black the better
 * game."), or what it keeps ("keeps the balance") and how close the alternatives are ("Nf3 and c4
 * are about as good.", "It is more precise than Nf3."). Null unless `lines` holds this move as the
 * best line plus at least one other move.
 */
function compareLines(fen: string, line: Line, lines: readonly PvLine[] | undefined, v: Voice): Comparison | null {
  const uci = line.pv[0];
  const score = line.score;
  if (!lines || !uci || !score || lines[0]?.pv[0] !== uci) return null;
  const others = lines.filter((l) => l.pv.length && l.pv[0] !== uci);
  if (!others.length) return null;
  const w = scoreToWin(score);
  const next = others[0];
  const Opp = SIDE[other(v.mover)];
  if (w - scoreToWin(next.score) >= ONLY_GAP) {
    const worse = evalHeadline(w, scoreToWin(next.score), v, Opp).replace(/^This /, 'Anything else ');
    return { reason: onlyMoveReason(score), detail: worse, only: true, motifs: ['onlyGoodMove'] };
  }
  const reason = keepsReason(score, v);
  const same = others
    .filter((l) => w - scoreToWin(l.score) < SAME_GAP && cpGap(score, l.score) <= SAME_CP)
    .map((l) => uciToSan(fen, l.pv[0]))
    .filter((x): x is string => !!x)
    .slice(0, 2);
  if (same.length) {
    return { reason, detail: `${joinAnd(same)} ${same.length > 1 ? 'are' : 'is'} about as good.`, only: false, motifs: [] };
  }
  const nextSan = uciToSan(fen, next.pv[0]);
  return { reason, detail: nextSan ? `It is more precise than ${nextSan}.` : null, only: false, motifs: [] };
}

/** Centipawn distance between two scores (mates count as far apart unless identical). */
function cpGap(a: Score, b: Score): number {
  if (a.kind === 'cp' && b.kind === 'cp') return Math.abs(a.value - b.value);
  return a.kind === b.kind && a.value === b.value ? 0 : Infinity;
}

/** What a quiet best move keeps, from its expected score: "keeps the balance", "keeps your advantage". */
function keepsReason(score: Score, v: Voice): string {
  const w = scoreToWin(score);
  if (w >= WINNING) return `keeps ${v.own} winning position`;
  if (w >= 0.6) return `keeps ${v.own} advantage`;
  if (w >= 0.53) return 'keeps a small edge';
  if (w > 0.47) return 'keeps the balance';
  if (w >= 0.4) return 'holds the position';
  if (w > 1 - WINNING) return 'is the best defense';
  return 'is the best try in a difficult position';
}

/**
 * For a sacrifice (brilliant / great): the piece left en prise and what happens if it is taken,
 * e.g. "If Black takes with Bxd1, Bxf7+ Ke7 Nd5# is checkmate."
 */
function sacrificeDetail(
  cls: MoveClass,
  fenBefore: string,
  moveUci: string,
  fenAfter: string,
  reply: Line | null,
  refutation: string[],
  me: Color,
  v: Voice,
): string | null {
  const h = sacrificedPiece(fenBefore, moveUci, fenAfter, me, cls === 'brilliant');
  if (!h) return null;
  const Opp = SIDE[other(me)];
  const name = NAME[h.type];
  const accepted = reply?.pv[0]?.slice(2, 4) === h.square;
  if (accepted) {
    return refutation.length >= 2
      ? `The ${name} sacrifice pays off: ${refutation.slice(0, 4).join(' ')}.`
      : `Giving up the ${name} pays off.`;
  }
  // Only a legal capture can "be a mistake" (not while the opponent is in check and cannot take).
  const board = new Chess(fenAfter);
  if (!board.moves({ verbose: true }).some((m) => m.to === h.square)) return null;
  const take = winningCaptures(fenAfter).find((w) => w.to === h.square);
  if (take) {
    const c = new Chess(fenAfter);
    c.move({ from: take.from, to: take.to, promotion: 'q' });
    const mate = forcedMateLine(c.fen(), 2);
    if (mate) return `If ${Opp} takes with ${take.san}, ${mate.join(' ')} is checkmate.`;
  }
  return `Taking ${v.own} ${on(h)} would be a mistake for ${Opp}.`;
}

/**
 * The piece a sacrifice leaves en prise: the one the move newly offers (see `detectSacrifice`), or
 * with `anyLoose` (a move classified Brilliant) any piece the opponent could win.
 */
function sacrificedPiece(
  fenBefore: string,
  moveUci: string,
  fenAfter: string,
  me: Color,
  anyLoose: boolean,
): PieceOn | null {
  const hanging = hangingPieces(fenAfter, me).filter((x) => x.see >= 2);
  const sq = detectSacrifice(fenBefore, moveUci)?.square;
  const offered = hanging.find((x) => x.piece.square === sq) ?? (anyLoose ? hanging[0] : undefined);
  return offered?.piece ?? null;
}

