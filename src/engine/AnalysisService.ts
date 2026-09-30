/**
 * Cached, prioritised analysis on top of one ChessEngine (full strength).
 *
 *  - `ensure()` requests run FIFO and take priority over live analysis (they pre-empt it; it
 *    resumes afterwards). Identical/overlapping requests are deduplicated, and a request is
 *    answered straight from the cache when a deep enough result is already known.
 *  - `watch()` live-analyses one position (depth `liveDepth`, `liveMultiPv` lines) and streams
 *    throttled updates to subscribers. Updates for a position never get shallower.
 *  - Every complete result (final or partial) of either kind feeds the cache, keyed by `fenKey`.
 *    Per position the cache keeps the non-dominated results by (depth, MultiPV width).
 *  - Searches are depth-limited (never `movetime`, which misbehaves across iOS suspension).
 *  - A search cut short by an engine restart (crash, hang) is retried on the fresh engine a few
 *    times before its waiters get the best result so far, so a crash never leaves a shallow
 *    result where a deep one was asked for.
 *  - Analysis is by position only: searches never pass `SearchOptions.history`, and `ensure` /
 *    `watch` take no game moves. A result is cached by `fenKey` and shared by every road to that
 *    position (the other move order, the review, a hint, a takeback and replay). With the game's
 *    moves, a move that repeats a position would score 0.00 in one game and not in another, and
 *    the cache would hand that draw score to positions where it is wrong. The repetition draws
 *    that analysis cannot see are the controller's business (it detects the threefold itself);
 *    the bot's searches do get the history (see BotPlayer).
 */
import { fenKey } from '../chess/utils';
import { inspectPosition } from './StockfishEngine';
import type { AnalysisResult, ChessEngine } from './types';

export interface AnalysisServiceOptions {
  /** Depth at which live analysis stops. Default 18. */
  liveDepth?: number;
  /** MultiPV of live analysis. Default 3. */
  liveMultiPv?: number;
  /** Minimum interval between subscriber updates (ms). Default 120. */
  throttleMs?: number;
  /** Max number of cached positions (LRU). Default 3000. */
  cacheSize?: number;
}

interface CacheEntry {
  result: AnalysisResult;
  /** MultiPV requested for the search that produced it (lines = min(width, legal moves)). */
  width: number;
}

interface Waiter {
  fen: string;
  minDepth: number;
  multiPv: number;
  resolve: (r: AnalysisResult) => void;
}

interface Job {
  key: string;
  fen: string;
  depth: number;
  multiPv: number;
  /** 'ensure' jobs have waiters and block the queue; 'live' jobs serve the watched position. */
  kind: 'ensure' | 'live';
  waiters: Waiter[];
  ctl: AbortController;
  /** Intentionally pre-empted (new live target, pause, cancel): its abort is expected. */
  superseded: boolean;
  /** Put back at the head of the queue when its search ends (pause). */
  requeue: boolean;
  ended: boolean;
  /** How many times this request was re-issued after an engine restart. */
  retries: number;
}

const EMPTY_WIDTH = 0;
/** Re-issues of an `ensure` search whose engine restarted (crash, hang) before it resolves best-so-far. */
const RESTART_RETRIES = 2;

export class AnalysisService {
  private readonly liveDepth: number;
  private readonly liveMultiPv: number;
  private readonly throttleMs: number;
  private readonly cacheSize: number;

  private readonly cache = new Map<string, CacheEntry[]>();
  private queue: Job[] = [];
  private running: Job | null = null;
  private target: { fen: string; key: string } | null = null;
  private paused = false;
  private broken = false;

  private readonly subscribers = new Set<(r: AnalysisResult) => void>();
  /** Last result accepted for the watched position (emitted or pending). */
  private shown: AnalysisResult | null = null;
  private pendingEmit: AnalysisResult | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmitAt = 0;

  constructor(
    private readonly engine: ChessEngine,
    opts: AnalysisServiceOptions = {},
  ) {
    this.liveDepth = opts.liveDepth ?? 18;
    this.liveMultiPv = opts.liveMultiPv ?? 3;
    this.throttleMs = opts.throttleMs ?? 120;
    this.cacheSize = opts.cacheSize ?? 3000;
  }

  /**
   * High-priority analysis to at least `minDepth` with at least `multiPv` lines (or all legal
   * moves), cached by fenKey. Pre-empts live analysis, which resumes afterwards. Resolves from
   * the cache immediately when possible. `done` may be false when the depth was reached by a
   * search that was later pre-empted. A search cut short by an engine restart is retried (up to
   * twice). Resolves `aborted: true` (best so far) after cancelAll(), if the engine breaks, or
   * if it keeps crashing on this position. Rejects only for an invalid FEN.
   */
  ensure(fen: string, opts: { minDepth: number; multiPv?: number }): Promise<AnalysisResult> {
    const key = fenKey(fen);
    const minDepth = Math.max(1, Math.round(opts.minDepth));
    const multiPv = Math.max(1, Math.round(opts.multiPv ?? 1));
    const hit = this.lookup(key, minDepth, multiPv);
    if (hit) {
      this.touch(key);
      return Promise.resolve(this.view(hit.result, fen));
    }
    try {
      inspectPosition(fen);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    if (this.broken) return Promise.resolve(this.bestSoFar(key, fen));
    return new Promise<AnalysisResult>((resolve) => {
      const waiter: Waiter = { fen, minDepth, multiPv, resolve };
      const r = this.running;
      if (r && !r.superseded && !r.ended && r.key === key && r.depth >= minDepth && r.multiPv >= multiPv) {
        // Already searching this position deeply enough (typically the live search): join it.
        r.waiters.push(waiter);
        r.kind = 'ensure';
        return;
      }
      const queued = this.queue.find((j) => j.key === key);
      if (queued) {
        queued.depth = Math.max(queued.depth, minDepth);
        queued.multiPv = Math.max(queued.multiPv, multiPv);
        queued.waiters.push(waiter);
        return;
      }
      this.queue.push(this.newJob(key, fen, minDepth, multiPv, 'ensure', [waiter]));
      this.pump();
    });
  }

  /** Live analysis target (null = none). Streams updates to subscribers; stops at liveDepth. */
  watch(fen: string | null): void {
    if (fen !== null) {
      try {
        inspectPosition(fen);
      } catch (e) {
        console.warn('[analysis] watch() ignored an invalid FEN', e);
        fen = null;
      }
    }
    if (fen === null) {
      this.target = null;
      this.resetEmitState();
      const r = this.running;
      if (r && r.kind === 'live') this.supersede(r);
      return;
    }
    const key = fenKey(fen);
    if (this.target?.key === key) {
      this.target.fen = fen;
      return;
    }
    this.target = { fen, key };
    this.resetEmitState();
    const cached = this.best(key, this.liveMultiPv);
    if (cached) this.accept(cached.result, true);
    this.pump();
  }

  subscribe(cb: (r: AnalysisResult) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Best cached result for this position (deepest, then widest), if any. */
  get(fen: string): AnalysisResult | undefined {
    const key = fenKey(fen);
    const e = this.best(key);
    if (!e) return undefined;
    this.touch(key);
    return this.view(e.result, fen);
  }

  /** Pause (page hidden) stops the engine and holds the queue; resume re-issues the work. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      const r = this.running;
      if (r && !r.ended) {
        if (r.kind === 'ensure' && r.waiters.length) r.requeue = true;
        this.supersede(r);
      }
    } else {
      this.pump();
    }
  }

  /** Drops queued `ensure` work: pending requests resolve with the best so far and `aborted: true`. */
  cancelAll(): void {
    for (const job of this.queue.splice(0)) this.abortWaiters(job);
    const r = this.running;
    if (r && r.kind === 'ensure' && !r.ended) {
      this.abortWaiters(r);
      r.requeue = false;
      if (r.key === this.target?.key && !r.superseded) r.kind = 'live';
      else this.supersede(r);
    }
    this.pump();
  }

  // ---------------------------------------------------------------------------------------------
  // Scheduling

  private newJob(key: string, fen: string, depth: number, multiPv: number, kind: Job['kind'], waiters: Waiter[]): Job {
    return {
      key,
      fen,
      depth,
      multiPv,
      kind,
      waiters,
      ctl: new AbortController(),
      superseded: false,
      requeue: false,
      ended: false,
      retries: 0,
    };
  }

  private pump(): void {
    if (this.paused || this.broken) return;
    const r = this.running;
    if (r && r.kind === 'ensure' && !r.superseded) return; // FIFO: wait for it
    if (r && r.superseded && r.requeue) return; // its end handler re-queues and pumps
    while (this.queue.length) {
      const job = this.queue.shift()!;
      this.resolveFromCache(job);
      if (job.waiters.length === 0) continue;
      if (r && !r.superseded && r.key === job.key && r.depth >= job.depth && r.multiPv >= job.multiPv) {
        // The live search already covers it: promote instead of restarting.
        r.waiters.push(...job.waiters);
        r.kind = 'ensure';
        return;
      }
      this.start(job);
      return;
    }
    this.startLive();
  }

  private startLive(): void {
    const t = this.target;
    const r = this.running && !this.running.superseded ? this.running : null;
    if (!t) {
      if (r && r.kind === 'live') this.supersede(r);
      return;
    }
    if (r && (r.kind === 'ensure' || r.key === t.key)) return;
    if (this.lookup(t.key, this.liveDepth, this.liveMultiPv)) {
      if (r) this.supersede(r);
      return;
    }
    this.start(this.newJob(t.key, t.fen, this.liveDepth, this.liveMultiPv, 'live', []));
  }

  private start(job: Job): void {
    const prev = this.running;
    if (prev && !prev.ended) prev.superseded = true; // the engine pre-empts it
    this.running = job;
    // No `history`: results must depend on the position alone to be cached by fenKey (see header).
    this.engine
      .search(job.fen, {
        depth: job.depth,
        multiPv: job.multiPv,
        signal: job.ctl.signal,
        onInfo: (p) => this.onPartial(job, p),
      })
      .then(
        (res) => this.onEnd(job, res),
        (err: unknown) => this.onFailure(job, err),
      );
  }

  private supersede(job: Job): void {
    job.superseded = true;
    job.ctl.abort();
  }

  private onPartial(job: Job, p: AnalysisResult): void {
    if (job.ended) return;
    this.store(job.key, p, job.multiPv);
    // Serve shallower requests early; at the job's own depth wait for the final result (done: true).
    if (p.depth < job.depth) this.resolveWaiters(job, p, false);
    this.accept(p, false, job.key);
    if (job.kind === 'ensure' && job.waiters.length === 0 && !job.superseded) {
      // Everyone who asked is served: keep going only as live analysis of the watched position.
      if (job.key === this.target?.key) {
        job.kind = 'live';
        if (this.queue.length) this.pump();
      } else {
        this.supersede(job); // onEnd() pumps the queue
      }
    }
  }

  private onEnd(job: Job, res: AnalysisResult): void {
    job.ended = true;
    if (this.running === job) this.running = null;
    this.store(job.key, res, job.multiPv);
    if (!res.aborted) {
      this.resolveWaiters(job, res, true);
      this.accept(res, true, job.key);
    } else if (job.requeue) {
      job.requeue = false;
      this.resolveFromCache(job);
      if (job.waiters.length) this.queue.unshift(this.newJob(job.key, job.fen, job.depth, job.multiPv, 'ensure', job.waiters));
    } else if (!job.superseded) {
      // Unexpected abort: the engine restarted after a crash or hang. It is usable again, so
      // search once more rather than hand out a shallow partial result. A live search needs
      // nothing here: pump() restarts it.
      this.resolveFromCache(job);
      if (job.waiters.length && job.retries < RESTART_RETRIES) {
        // Sized for the waiters, not the old job: a deep live search that an ensure() joined
        // comes back as that ensure() only.
        const retry = this.newJob(
          job.key,
          job.fen,
          Math.max(...job.waiters.map((w) => w.minDepth)),
          Math.max(...job.waiters.map((w) => w.multiPv)),
          'ensure',
          job.waiters,
        );
        retry.retries = job.retries + 1;
        this.queue.unshift(retry);
      } else {
        this.abortWaiters(job);
      }
    }
    this.pump();
  }

  private onFailure(job: Job, err: unknown): void {
    job.ended = true;
    if (this.running === job) this.running = null;
    console.error('[analysis] engine failed', err);
    this.broken = true;
    this.abortWaiters(job);
    for (const j of this.queue.splice(0)) this.abortWaiters(j);
  }

  // ---------------------------------------------------------------------------------------------
  // Waiters

  private resolveWaiters(job: Job, r: AnalysisResult, final: boolean): void {
    if (!job.waiters.length) return;
    const keep: Waiter[] = [];
    for (const w of job.waiters) {
      const ok = final || r.terminal || (r.depth >= w.minDepth && job.multiPv >= w.multiPv && r.lines.length > 0);
      if (ok) w.resolve(this.view(r, w.fen));
      else keep.push(w);
    }
    job.waiters = keep;
  }

  private resolveFromCache(job: Job): void {
    job.waiters = job.waiters.filter((w) => {
      const hit = this.lookup(job.key, w.minDepth, w.multiPv);
      if (hit) w.resolve(this.view(hit.result, w.fen));
      return !hit;
    });
  }

  private abortWaiters(job: Job): void {
    for (const w of job.waiters.splice(0)) w.resolve(this.bestSoFar(job.key, w.fen));
  }

  private bestSoFar(key: string, fen: string): AnalysisResult {
    const e = this.best(key);
    const r = e ? this.view(e.result, fen) : { fen, depth: 0, lines: [], bestMove: null, done: false };
    return { ...r, aborted: true };
  }

  // ---------------------------------------------------------------------------------------------
  // Cache

  private store(key: string, r: AnalysisResult, width: number): void {
    if (!r.terminal && r.lines.length === 0) return;
    const entry: CacheEntry = {
      result: {
        fen: r.fen,
        depth: r.depth,
        lines: r.lines,
        bestMove: r.bestMove ?? r.lines[0]?.pv[0] ?? null,
        done: r.done,
        ...(r.terminal ? { terminal: r.terminal } : {}),
      },
      width: r.terminal ? Number.POSITIVE_INFINITY : width,
    };
    const front = this.cache.get(key) ?? [];
    if (front.some((e) => dominates(e, entry))) {
      this.touch(key);
      return;
    }
    const next = front.filter((e) => !dominates(entry, e));
    next.push(entry);
    this.cache.delete(key);
    this.cache.set(key, next);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }

  private lookup(key: string, minDepth: number, multiPv: number): CacheEntry | undefined {
    const front = this.cache.get(key);
    if (!front) return undefined;
    return front.find((e) => e.result.terminal || (e.result.depth >= minDepth && e.width >= multiPv));
  }

  /** Deepest entry, preferring those at least `minWidth` wide; ties go to the wider one. */
  private best(key: string, minWidth = EMPTY_WIDTH): CacheEntry | undefined {
    const front = this.cache.get(key);
    if (!front?.length) return undefined;
    const wide = front.filter((e) => e.width >= minWidth);
    const pool = wide.length ? wide : front;
    return pool.reduce((a, b) => (b.result.depth > a.result.depth || (b.result.depth === a.result.depth && b.width > a.width) ? b : a));
  }

  private touch(key: string): void {
    const v = this.cache.get(key);
    if (!v) return;
    this.cache.delete(key);
    this.cache.set(key, v);
  }

  /** A copy of a result labelled with the caller's FEN (same fenKey, maybe other move counters). */
  private view(r: AnalysisResult, fen: string): AnalysisResult {
    const out: AnalysisResult = {
      fen,
      depth: r.depth,
      lines: r.lines,
      bestMove: r.bestMove ?? r.lines[0]?.pv[0] ?? null,
      done: r.done,
    };
    if (r.terminal) out.terminal = r.terminal;
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Subscriber updates

  /** Offers a result for the watched position; emits it (throttled) unless it is shallower. */
  private accept(r: AnalysisResult, immediate: boolean, key = this.target?.key): void {
    const t = this.target;
    if (!t || key !== t.key) return;
    if (!r.terminal && r.lines.length === 0) return;
    const s = this.shown;
    if (s && !r.terminal && (r.depth < s.depth || (r.depth === s.depth && r.lines.length < s.lines.length))) return;
    const v = this.view(r, t.fen);
    this.shown = v;
    this.pendingEmit = v;
    const wait = this.lastEmitAt + this.throttleMs - Date.now();
    if (immediate || wait <= 0) this.flush();
    else if (!this.emitTimer) this.emitTimer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    const r = this.pendingEmit;
    this.pendingEmit = null;
    if (!r) return;
    this.lastEmitAt = Date.now();
    for (const cb of this.subscribers) {
      try {
        cb(r);
      } catch (e) {
        console.error('[analysis] subscriber failed', e);
      }
    }
  }

  private resetEmitState(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.pendingEmit = null;
    this.shown = null;
    this.lastEmitAt = 0;
  }
}

function dominates(a: CacheEntry, b: CacheEntry): boolean {
  return a.result.depth >= b.result.depth && a.width >= b.width;
}
