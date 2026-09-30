/**
 * PGN export: the Seven Tag Roster plus Elo, opening and set-up tags, and optional
 * `[%eval]` comments and move-quality NAGs from the coach's annotations.
 */
import type { MoveClass } from '../analysis/types';
import { START_FEN, sideToMove } from '../chess/utils';
import type { Score } from '../engine/types';
import type { GameResult, Ply } from './types';

export interface PgnPlayer {
  name: string;
  elo?: number;
}

export interface PgnOptions {
  startFen: string;
  plies: readonly Ply[];
  white: PgnPlayer;
  black: PgnPlayer;
  /** When the game was played (local date). */
  date: Date;
  /** '*' while the game is still in progress. */
  result: GameResult | '*';
  /** Outcome reason, e.g. "Checkmate" (written as a Termination tag). */
  termination?: string;
  opening?: { eco: string; name: string } | null;
  /** Add `{ [%eval …] }` comments and NAGs ($1 … $6) from the annotations. Default false. */
  annotations?: boolean;
  /** Default "Chess Coach". */
  event?: string;
}

const NAG: Partial<Record<MoveClass, string>> = {
  brilliant: '$3',
  great: '$1',
  inaccuracy: '$6',
  mistake: '$2',
  miss: '$2',
  blunder: '$4',
};

/** PGN date "YYYY.MM.DD" (local time). */
export function pgnDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

/**
 * The `[%eval]` value for a White-POV score: "0.17", "-1.05", "#3" (White mates), "#-2"
 * (Black mates). Null for a finished checkmate (`mate 0`), which needs no eval.
 */
export function pgnEval(scoreWhite: Score): string | null {
  if (scoreWhite.kind === 'mate') {
    if (scoreWhite.value === 0) return null;
    return `#${scoreWhite.value}`;
  }
  return (scoreWhite.value / 100).toFixed(2);
}

function tag(name: string, value: string | number): string {
  return `[${name} "${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

/** Joins tokens into lines of at most `width` characters (PGN export format). */
function wrap(tokens: string[], width = 80): string {
  const lines: string[] = [];
  let line = '';
  for (const t of tokens) {
    if (line && line.length + 1 + t.length > width) {
      lines.push(line);
      line = t;
    } else {
      line = line ? `${line} ${t}` : t;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/** Builds the PGN text of a game (tags, a blank line, the movetext and the result). */
export function buildPgn(o: PgnOptions): string {
  const tags = [
    tag('Event', o.event ?? 'Chess Coach'),
    tag('Site', 'Chess Coach'),
    tag('Date', pgnDate(o.date)),
    tag('Round', '-'),
    tag('White', o.white.name),
    tag('Black', o.black.name),
    tag('Result', o.result),
  ];
  if (o.white.elo !== undefined) tags.push(tag('WhiteElo', Math.round(o.white.elo)));
  if (o.black.elo !== undefined) tags.push(tag('BlackElo', Math.round(o.black.elo)));
  if (o.opening) {
    tags.push(tag('ECO', o.opening.eco));
    tags.push(tag('Opening', o.opening.name));
  }
  if (o.startFen !== START_FEN) {
    tags.push(tag('SetUp', '1'));
    tags.push(tag('FEN', o.startFen));
  }
  if (o.termination) tags.push(tag('Termination', o.termination));
  tags.push(tag('PlyCount', o.plies.length));

  const tokens: string[] = [];
  let moveNo = Number(o.startFen.split(' ')[5]) || 1;
  let needNumber = true;
  let color = sideToMove(o.startFen);
  for (const ply of o.plies) {
    if (color === 'w') tokens.push(`${moveNo}.`);
    else if (needNumber) tokens.push(`${moveNo}...`);
    tokens.push(ply.san);
    needNumber = false;
    if (o.annotations) {
      const nag = ply.classification ? NAG[ply.classification.cls] : undefined;
      if (nag) tokens.push(nag);
      const ev = ply.evalWhite ? pgnEval(ply.evalWhite) : null;
      if (ev !== null) {
        tokens.push(`{ [%eval ${ev}] }`);
        needNumber = true;
      }
    }
    if (color === 'b') moveNo++;
    color = color === 'w' ? 'b' : 'w';
  }
  tokens.push(o.result);
  return `${tags.join('\n')}\n\n${wrap(tokens)}\n`;
}
