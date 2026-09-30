/**
 * The computer opponent: plays one move for a given Elo on its own ChessEngine.
 *
 * Per move: the only legal move is played at once ('forced'); otherwise a book move per this
 * game's book profile ('book'); otherwise a full-strength search limited by depth/nodes, weakened
 * in JS by `chooseMove` ('engine'). A human-like think delay (total, including search time) is
 * added unless `thinkDelay: false`. Everything is abortable through the AbortSignal.
 */
import type { Move } from 'chess.js';
import type { AnalysisResult, ChessEngine } from '../engine/types';
import { bookProfile, loadOpenings, pickBookMove, type BookProfile, type BookState } from './book';
import {
  chooseMove,
  clampElo,
  legalMovesOf,
  planForElo,
  planMove,
  positionDifficulty,
  searchOptionsFor,
  thinkTimeMs,
  type BotPlan,
  type MovePlan,
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
   * Chooses the bot's move. `history` = UCI moves from the start position (for the book).
   * Resolves null if aborted or when the position has no legal move. Never rejects for engine
   * failures: without engine lines the bot falls back to a heuristic move.
   */
  async move(fen: string, elo: number, history: string[], signal?: AbortSignal): Promise<BotMove | null> {
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
    const result = await this.search(fen, mp, signal);
    if (signal?.aborted) return null;
    const choice = chooseMove(fen, result, mp, rng);
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

  /** Full-strength search for this move plan; retries once if pre-empted by someone else. */
  private async search(fen: string, mp: MovePlan, signal?: AbortSignal): Promise<AnalysisResult> {
    const empty: AnalysisResult = { fen, depth: 0, lines: [], bestMove: null, done: false, aborted: true };
    try {
      this.initPromise ??= this.engine.init();
      await this.initPromise;
      const opts = { ...searchOptionsFor(mp), signal };
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
