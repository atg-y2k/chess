/**
 * Threat alerts (GameSettings.threatAlerts): on the player's turn, what the opponent threatens,
 * verified by the engine.
 *
 * The probe is a null move. The position with the opponent to move again (`nullMoveFen`) is
 * searched as the opponent, and so is the position itself as the player (both with a small node
 * budget, THREAT_NODES each); the difference is what moving again would gain the opponent. A
 * threat is real when that is:
 *  - a forced mate for the opponent (while the player is not being mated anyway), or
 *  - at least THREAT_MIN_CP, and the engine's line wins at least THREAT_MIN_MATERIAL pawns of
 *    material (so a piece that merely escapes, or a tempo, is never a "threat").
 * Small threats (a pawn) say nothing: no warning noise. A position where the player is in check
 * has no probe (a null move would be illegal there; the check is the threat).
 *
 * The words (explain.ts `explainThreat`) come from the engine's move; the static detection of
 * `describeThreat` (motifs.ts `threatsAgainst`) words it only when it finds the same move. They name
 * the opponent's threat only, never the player's defense.
 *
 * Pure logic apart from the injected `analyze` (the app's AnalysisService `ensure`); no DOM.
 */
import { Chess } from 'chess.js';
import { sideToMove } from '../chess/utils';
import type { AnalysisResult, PvLine, Score } from '../engine/types';
import { explainThreat } from './explain';
import { materialOutcome, motifSquares, moveMotifs, nullMoveFen } from './motifs';
import type { Arrow } from './types';

/** What moving again must gain the opponent (engine centipawns, its point of view) for a material threat. */
export const THREAT_MIN_CP = 150;
/** ...and the material the engine's line must win (pawns): about a pawn and a half, so never a lone pawn. */
export const THREAT_MIN_MATERIAL = 1.5;
/** Plies of the engine's line the material is counted over (the threat and the exchange after it). */
export const THREAT_LINE_PLIES = 6;
/** Depth of the two probe searches (threats are short tactics), within THREAT_NODES. */
export const THREAT_DEPTH = 12;
/**
 * Node budget of each probe search: 150k nodes, about 0.3 s on an iPhone. The two searches of a
 * position are asked together right after the opponent's move, with its priority (GameController
 * ANALYSIS_PRIORITY.opponent), so ahead of its rating, and run one after the other on the analysis
 * engine (about 0.6 s): the alert shows that soon, also while the opponent's move is still being
 * rated (unless it could hint at the punishment of a mistake, see `ThreatAlert.best`). The player's
 * move withdraws them, and the searches of its verdict come first. The bot has its own engine (or
 * priority on a shared one).
 */
export const THREAT_NODES = 150_000;
/** A probe search cut short below this depth tells nothing (no alert). */
const MIN_USABLE_DEPTH = 8;

/** A real threat against the player, ready to show (the coach panel's warning and its arrow). */
export interface ThreatAlert {
  /** The position it is about (the player to move). */
  fen: string;
  /** The opponent's threat move, as played in the null-move position. */
  uci: string;
  san: string;
  kind: 'mate' | 'material';
  /** "Pip threatens Nxf7, forking your queen and rook." */
  text: string;
  /** The threat's arrow ('threat' brush). */
  arrows: Arrow[];
  /**
   * The squares it points at (the move's and those of the pieces it attacks): a move the alert
   * must not hint at (the punishment of the opponent's mistake, still to be found) never touches one.
   */
  squares: string[];
  /**
   * The player's best move here as the probe's own search found it (never shown): until the verdict
   * on the opponent's move says whether there is a punishment to find, an alert that touches it waits.
   */
  best?: string;
}

/** The search the probe asks for (the app passes `AnalysisService.ensure`). */
export type ThreatAnalyze = (
  fen: string,
  opts: { minDepth: number; multiPv: number; maxNodes: number; signal?: AbortSignal },
) => Promise<AnalysisResult>;

/**
 * The position to probe (the opponent to move again), or null when there is none: the player is
 * in check (a null move would be illegal), the game is over, or the FEN is unusable.
 */
export function threatProbeFen(fen: string): string | null {
  try {
    const c = new Chess(fen);
    if (c.inCheck() || c.isGameOver()) return null;
    return nullMoveFen(fen);
  } catch {
    return null;
  }
}

/** A score as a number on one scale (mates beyond any centipawn score, faster ones further). */
function rank(s: Score): number {
  if (s.kind === 'cp') return s.value;
  return s.value > 0 ? 100_000 - s.value : -100_000 - s.value;
}

/** A search worth judging: it has a line and was not cut short early. */
function usable(r: AnalysisResult): boolean {
  return r.lines.length > 0 && !(r.aborted && r.depth < MIN_USABLE_DEPTH);
}

/**
 * The alert for `fen` (the player to move) from the two searches: `now`, the position itself (the
 * player's point of view), and `probe`, the null-move position (`threatProbeFen(fen)`, the
 * opponent's). Null when there is no real threat (see the module comment). `name` is the opponent's.
 */
export function judgeThreat(
  fen: string,
  now: AnalysisResult,
  probe: AnalysisResult,
  opts: { name: string },
): ThreatAlert | null {
  const nf = threatProbeFen(fen);
  if (!nf || !usable(now) || !usable(probe)) return null;
  const mine = now.lines[0].score;
  const line: PvLine | undefined = probe.lines.find((l) => l.pv.length > 0);
  if (!line) return null;
  const theirs = line.score;
  let kind: ThreatAlert['kind'];
  if (theirs.kind === 'mate' && theirs.value > 0) {
    // Being mated anyway: a warning changes nothing.
    if (mine.kind === 'mate' && mine.value <= 0) return null;
    kind = 'mate';
  } else {
    // What moving again gains the opponent, against the position as it is (its point of view).
    const gain = rank(theirs) + rank(mine);
    if (gain < THREAT_MIN_CP) return null;
    if (materialOutcome(nf, line.pv, sideToMove(nf), THREAT_LINE_PLIES).net < THREAT_MIN_MATERIAL) return null;
    kind = 'material';
  }
  const e = explainThreat(fen, line, { name: opts.name });
  const mm = moveMotifs(nf, line.pv[0]);
  if (!e || !mm) return null;
  const uci = line.pv[0];
  const squares = new Set<string>([uci.slice(0, 2), uci.slice(2, 4)]);
  for (const m of mm.motifs) for (const sq of motifSquares(m)) squares.add(sq);
  const best = now.lines[0].pv[0];
  return { fen, uci, san: mm.move.san, kind, text: e.headline, arrows: e.arrows ?? [], squares: [...squares], ...(best ? { best } : {}) };
}

/**
 * Probes `fen` (the player to move): searches it and its null-move position (both requested at
 * once; the analysis engine runs them one after the other, each at THREAT_DEPTH within
 * THREAT_NODES) and judges the threat (`judgeThreat`). Null when there is none
 * (also when there is no probe: the player is in check); undefined when it could not tell (`signal`
 * aborted, a search failed or was cut short early): worth asking again later. Never rejects.
 */
export async function probeThreat(
  fen: string,
  analyze: ThreatAnalyze,
  opts: { name: string; signal?: AbortSignal },
): Promise<ThreatAlert | null | undefined> {
  const nf = threatProbeFen(fen);
  if (!nf) return null;
  const req = { minDepth: THREAT_DEPTH, multiPv: 1, maxNodes: THREAT_NODES, ...(opts.signal ? { signal: opts.signal } : {}) };
  try {
    const [now, probe] = await Promise.all([analyze(fen, req), analyze(nf, req)]);
    if (opts.signal?.aborted || !usable(now) || !usable(probe)) return undefined;
    return judgeThreat(fen, now, probe, { name: opts.name });
  } catch {
    return undefined;
  }
}
