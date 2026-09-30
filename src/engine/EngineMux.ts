/**
 * Two logical engines sharing one physical engine (single-worker fallback, e.g. when WebKit
 * cannot afford two Stockfish instances).
 *
 *  - `high` (the bot) always runs immediately. If a `low` search (analysis) is running, it is
 *    paused: the physical search is pre-empted, and the same low search (same fen/options) is
 *    transparently restarted once no high search is outstanding.
 *  - A `low` search's promise resolves only when it really finishes, or when its own caller
 *    aborts/stops it, or when another low search pre-empts it. Its `onInfo` keeps streaming
 *    across restarts (updates shallower than what was already reported are held back).
 *  - Each lane keeps the ChessEngine semantics: one search at a time, a new one pre-empts the
 *    previous one of the same lane.
 */
import type { AnalysisResult, ChessEngine, SearchOptions } from './types';
import { inspectPosition } from './StockfishEngine';

interface LowJob {
  fen: string;
  opts: SearchOptions;
  resolve: (r: AnalysisResult) => void;
  reject: (e: Error) => void;
  settled: boolean;
  /** A physical search for this job is in flight. */
  running: boolean;
  /** Its physical search was pre-empted by a high search and must be restarted. */
  paused: boolean;
  /** Deepest partial reported so far (across restarts). */
  best: AnalysisResult | null;
  detach?: () => void;
}

const abortedEmpty = (fen: string): AnalysisResult => ({ fen, depth: 0, lines: [], bestMove: null, done: false, aborted: true });

class Mux {
  private highActive = 0;
  private lowJob: LowJob | null = null;
  private highDead = false;
  private lowDead = false;

  readonly high: ChessEngine;
  readonly low: ChessEngine;

  constructor(private readonly engine: ChessEngine) {
    this.high = {
      init: () => this.engine.init(),
      search: (fen, opts) => this.searchHigh(fen, opts),
      stop: () => this.stopHigh(),
      newGame: () => this.engine.newGame(),
      terminate: () => {
        this.highDead = true;
        this.stopHigh();
        this.maybeTerminate();
      },
    };
    this.low = {
      init: () => this.engine.init(),
      search: (fen, opts) => this.searchLow(fen, opts),
      stop: () => {
        if (this.lowJob) this.abortLow(this.lowJob);
      },
      newGame: () => this.engine.newGame(),
      terminate: () => {
        this.lowDead = true;
        if (this.lowJob) this.abortLow(this.lowJob);
        this.maybeTerminate();
      },
    };
  }

  // --- high lane ---------------------------------------------------------------------------------

  private searchHigh(fen: string, opts: SearchOptions = {}): Promise<AnalysisResult> {
    if (this.highDead) return Promise.reject(new Error('Engine terminated'));
    let terminal: 'checkmate' | 'stalemate' | undefined;
    try {
      terminal = inspectPosition(fen).terminal;
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    if (opts.signal?.aborted) return Promise.resolve(abortedEmpty(fen));
    if (terminal) {
      // Answer without touching the physical engine (so analysis is not paused), but still
      // pre-empt this lane's previous search.
      this.stopHigh();
      return Promise.resolve({ fen, depth: 0, lines: [], bestMove: null, done: true, terminal });
    }
    const low = this.lowJob;
    if (low && low.running && !low.settled) low.paused = true;
    this.highActive++;
    const p = this.engine.search(fen, opts);
    const finished = () => {
      this.highActive--;
      if (this.highActive === 0) this.resumeLow();
    };
    p.then(finished, finished);
    return p;
  }

  private stopHigh(): void {
    // While a high search is outstanding the physical engine is working for the high lane
    // (the low search is paused), so a physical stop only affects high work.
    if (this.highActive > 0) this.engine.stop();
  }

  // --- low lane ----------------------------------------------------------------------------------

  private searchLow(fen: string, opts: SearchOptions = {}): Promise<AnalysisResult> {
    if (this.lowDead) return Promise.reject(new Error('Engine terminated'));
    let terminal: 'checkmate' | 'stalemate' | undefined;
    try {
      terminal = inspectPosition(fen).terminal;
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    if (opts.signal?.aborted) return Promise.resolve(abortedEmpty(fen));
    const prev = this.lowJob;
    if (prev && !prev.settled) this.abortLow(prev, /* stopPhysical */ terminal !== undefined);
    if (terminal) return Promise.resolve({ fen, depth: 0, lines: [], bestMove: null, done: true, terminal });
    return new Promise<AnalysisResult>((resolve, reject) => {
      const { signal, onInfo: userOnInfo } = opts;
      const job: LowJob = {
        fen,
        opts: { ...opts, signal: undefined },
        resolve,
        reject,
        settled: false,
        running: false,
        paused: false,
        best: null,
      };
      job.opts.onInfo = (p) => {
        if (job.settled || (job.best && p.depth < job.best.depth)) return; // restarted search still catching up
        job.best = p;
        userOnInfo?.(p);
      };
      if (signal) {
        const onAbort = () => this.abortLow(job);
        signal.addEventListener('abort', onAbort, { once: true });
        job.detach = () => signal.removeEventListener('abort', onAbort);
      }
      this.lowJob = job;
      if (this.highActive === 0) this.runLow(job);
    });
  }

  private runLow(job: LowJob): void {
    job.running = true;
    job.paused = false;
    this.engine.search(job.fen, job.opts).then(
      (r) => {
        job.running = false;
        if (job.settled) return;
        if (r.aborted && job.paused) {
          // Pre-empted by a high search: resume once the high lane is idle.
          if (this.highActive === 0) this.resumeLow();
          return;
        }
        this.settleLow(job, r);
      },
      (err: unknown) => {
        job.running = false;
        if (job.settled) return;
        job.settled = true;
        job.detach?.();
        job.reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  }

  private resumeLow(): void {
    const job = this.lowJob;
    if (!job || job.settled || job.running || this.highActive > 0) return;
    this.runLow(job);
  }

  /** Aborts a low job; stops the physical search if it is the one running. */
  private abortLow(job: LowJob, stopPhysical = true): void {
    if (job.settled) return;
    const runningNow = job.running && !job.paused && this.highActive === 0;
    this.settleLow(job, null);
    if (runningNow && stopPhysical) this.engine.stop();
  }

  private settleLow(job: LowJob, r: AnalysisResult | null): void {
    if (job.settled) return;
    job.settled = true;
    job.detach?.();
    if (r && !r.aborted) {
      job.resolve(r);
      return;
    }
    // Aborted: report the deepest partial seen across all runs.
    const best = job.best && (!r || job.best.depth > r.depth) ? job.best : r;
    job.resolve({
      fen: job.fen,
      depth: best?.depth ?? 0,
      lines: best?.lines ?? [],
      bestMove: null,
      done: false,
      aborted: true,
    });
  }

  private maybeTerminate(): void {
    if (this.highDead && this.lowDead) this.engine.terminate();
  }
}

/**
 * Shares one physical engine between a high-priority lane (bot) and a low-priority lane
 * (analysis). See the module comment for the exact semantics.
 */
export function createEngineMux(engine: ChessEngine): { high: ChessEngine; low: ChessEngine } {
  const mux = new Mux(engine);
  return { high: mux.high, low: mux.low };
}
