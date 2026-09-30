/**
 * The computer opponent: plays one move for a given Elo on its own ChessEngine.
 *
 * Per move: the only legal move is played at once ('forced'); otherwise a book move per this
 * game's book profile ('book'); otherwise a full-strength search limited by depth/nodes, weakened
 * in JS by `chooseMove` ('engine'). In a won simplified ending a second, deeper search is run so the
 * bot can convert it (`conversionSearchFor`). The game's move history is replayed to count
 * repeated positions, so the bot does not walk into a threefold repetition while winning.
 * A human-like think delay (total, including search time) is added unless `thinkDelay: false`.
 * Everything is abortable through the AbortSignal.
 */
import { Chess, type Move } from 'chess.js';
import type { AnalysisResult, ChessEngine, SearchOptions } from '../engine/types';
import { bookProfile, loadOpenings, pickBookMove, type BookProfile, type BookState } from './book';
import {
  chooseMove,
  clampElo,
  conversionSearchFor,
  legalMovesOf,
  planForElo,
  planMove,
  positionDifficulty,
  positionKey,
  searchOptionsFor,
  thinkTimeMs,
  type BotPlan,
} from './strength';
import type { BotMove } from './types';

export interface BotPlayerOptions {
  /** Random source in [0, 1); pass a seeded `mulberry32` for replayable games. Default Math.random. */
  rng?: () => number;
  /** Add a human-like think delay (total time including the search). Default true. */
  thinkDelay?: boolean;
}

const uciOf = (m: Move): string => m.from + m.to + (m.promotion ?? '');
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** The game history replayed for repetition counts, extended incrementally from move to move. */
interface Replay {
  startFen: string;
  moves: string[];
  chess: Chess;
  counts: Map<string, number>;
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class BotPlayer {
  private readonly rng: () => number;
  private readonly thinkDelay: boolean;
  private plan: BotPlan | null = null;
  private profile: BookProfile | null = null;
  private bookState: BookState = { left: false };
  private initPromise: Promise<void> | null = null;
  private replay: Replay | null = null;

  constructor(
    private readonly engine: ChessEngine,
    opts: BotPlayerOptions = {},
  ) {
    this.rng = opts.rng ?? Math.random;
    this.thinkDelay = opts.thinkDelay ?? true;
  }

  /** Call at game start: draws the per-game opening-book profile for this Elo and loads the book. */
  async newGame(elo: number): Promise<void> {
    this.resetGame(elo);
    // Clears the engine's hash; queued before the next search, so no need to wait for it.
    Promise.resolve()
      .then(() => this.engine.newGame())
      .catch(() => {});
    try {
      await loadOpenings();
    } catch (e) {
      console.warn('[bot] opening book unavailable', e);
    }
  }

  /**
   * Chooses the bot's move. `history` = UCI moves from `startFen` (default: the initial position)
   * to `fen`: its length drives the book and think time, and replaying it gives the repetition
   * counts. A history that does not lead to `fen` only disables the repetition guard.
   * Resolves null if aborted or when the position has no legal move. Never rejects for engine
   * failures: without engine lines the bot falls back to a heuristic move.
   */
  async move(
    fen: string,
    elo: number,
    history: string[],
    signal?: AbortSignal,
    startFen: string = START_FEN,
  ): Promise<BotMove | null> {
    if (signal?.aborted) return null;
    const started = now();
    const legal = legalMovesOf(fen);
    if (!legal.length) return null;
    let profile = this.profile;
    if (!profile) {
      // newGame() was not called: start a game now; the book becomes available for later moves.
      profile = this.resetGame(elo);
      loadOpenings().catch(() => {});
    }
    const ply = history.length;
    const rng = this.rng;

    if (legal.length === 1) {
      const target = thinkTimeMs({ elo, ply, source: 'forced', legalMoves: 1 }, rng);
      return this.finish(uciOf(legal[0]), 'forced', started, target, signal);
    }

    const book = pickBookMove(fen, ply, profile, this.bookState, rng);
    if (book && legal.some((m) => uciOf(m) === book)) {
      const target = thinkTimeMs({ elo, ply, source: 'book', legalMoves: legal.length }, rng);
      return this.finish(book, 'book', started, target, signal);
    }

    const mp = planMove(this.planFor(elo), rng);
    const result = await this.search(fen, searchOptionsFor(mp), signal);
    if (signal?.aborted) return null;
    const convert = conversionSearchFor(fen, result, mp);
    const deep = convert ? await this.search(fen, convert, signal) : undefined;
    if (signal?.aborted) return null;
    const choice = chooseMove(fen, result, mp, rng, {
      deep,
      positions: this.positionCounts(startFen, history, fen) ?? undefined,
    });
    if (!choice) return null;
    const diff = positionDifficulty(result);
    const target = thinkTimeMs(
      {
        elo,
        ply,
        source: choice.reason === 'forced' ? 'forced' : 'engine',
        legalMoves: legal.length,
        goodMoves: diff.goodMoves,
        obvious: diff.obvious || choice.reason === 'mate',
      },
      rng,
    );
    return this.finish(choice.uci, 'engine', started, target, signal);
  }

  private resetGame(elo: number): BookProfile {
    this.plan = planForElo(elo);
    this.profile = bookProfile(clampElo(elo), this.rng);
    this.bookState = { left: false };
    return this.profile;
  }

  private planFor(elo: number): BotPlan {
    const e = clampElo(elo);
    if (!this.plan || this.plan.elo !== e) this.plan = planForElo(e);
    return this.plan;
  }

  /**
   * Occurrences of each position (`positionKey`) in the game, the current one included, from
   * replaying `history`; null when the moves are illegal or do not lead to `fen`. Incremental while
   * the history only grows (the usual case); rebuilt after a takeback or a new game.
   */
  private positionCounts(startFen: string, history: readonly string[], fen: string): ReadonlyMap<string, number> | null {
    let r = this.replay;
    const reusable =
      r && r.startFen === startFen && r.moves.length <= history.length && r.moves.every((m, i) => m === history[i]);
    try {
      if (!r || !reusable) {
        const chess = new Chess(startFen);
        r = { startFen, moves: [], chess, counts: new Map([[positionKey(chess.fen()), 1]]) };
      }
      this.replay = r;
      for (let i = r.moves.length; i < history.length; i++) {
        const uci = history[i];
        r.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        r.moves.push(uci);
        const key = positionKey(r.chess.fen());
        r.counts.set(key, (r.counts.get(key) ?? 0) + 1);
      }
      return positionKey(r.chess.fen()) === positionKey(new Chess(fen).fen()) ? r.counts : null;
    } catch {
      this.replay = null;
      return null;
    }
  }

  /** Full-strength search with these limits; retries once if pre-empted by someone else. */
  private async search(fen: string, limits: SearchOptions, signal?: AbortSignal): Promise<AnalysisResult> {
    const empty: AnalysisResult = { fen, depth: 0, lines: [], bestMove: null, done: false, aborted: true };
    try {
      this.initPromise ??= this.engine.init();
      await this.initPromise;
      const opts = { ...limits, signal };
      let result = await this.engine.search(fen, opts);
      if (result.aborted && !signal?.aborted) result = await this.engine.search(fen, opts);
      return result;
    } catch (e) {
      this.initPromise = null;
      console.warn('[bot] engine search failed; playing a heuristic move', e);
      return empty;
    }
  }

  /** Waits for the rest of the think time (if enabled), then returns the move (null if aborted). */
  private async finish(
    uci: string,
    source: BotMove['source'],
    started: number,
    targetMs: number,
    signal?: AbortSignal,
  ): Promise<BotMove | null> {
    if (this.thinkDelay && !(await sleep(targetMs - (now() - started), signal))) return null;
    if (signal?.aborted) return null;
    return { uci, source, thinkMs: Math.round(now() - started) };
  }
}
