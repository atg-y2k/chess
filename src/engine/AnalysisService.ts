/**
 * Cached, prioritized analysis on top of one ChessEngine (full strength).
 *
 *  - `ensure()` requests run FIFO and take priority over live analysis (they pre-empt it; it
 *    resumes afterwards). Identical/overlapping requests are deduplicated, and a request is
 *    answered straight from the cache when a good enough result is already known.
 *  - Every search has a node budget as well as a depth: `ensure()` stops at `minDepth` or after
 *    `maxNodes` nodes (default `defaultEnsureNodes(multiPv)`, about 2-3 s on an iPhone), whichever
 *    comes first. Depth 14 usually takes a few hundred thousand nodes, but in some positions one
 *    iteration takes millions (after 1.d4 Nf6 2.c4 d5 3.cxd5 Nxd5 4.e4 Nd7 5.exd5 c6 6.dxc6 Rg8
 *    7.cxd7+ Kxd7 8.Qa4+ Kd6 9.Qa3+, MultiPV 3 reaches depth 11 within a few thousand nodes and
 *    often needs millions for depth 12): without a budget one annotation held the queue, the
 *    coach and the eval bar for minutes.
 *    A result that spent the budget is as good as the request gets, so it answers any request
 *    with the same or a smaller budget (the cache remembers the nodes behind each result), and a
 *    request never joins a search with a larger budget (it would wait past its own).
 *  - `watch()` live-analyses one position (depth `liveDepth`, `liveMultiPv` lines, at most
 *    `liveNodes` nodes) and streams throttled updates to subscribers. Updates for a position never
 *    get shallower.
 *  - Every complete result (final or partial) of either kind feeds the cache, keyed by `fenKey`.
 *    Per position the cache keeps the non-dominated results by (depth, MultiPV width, nodes).
 *  - Searches are limited by depth and nodes, never by `movetime` (which misbehaves across iOS
 *    suspension): a request asks for the same work on a fast or a slow phone.
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

/** Nodes per MultiPV line (plus one) of an `ensure()` budget, see `defaultEnsureNodes`. */
const ENSURE_NODES_UNIT = 300_000;

/**
 * Default node budget of an `ensure()` search with `multiPv` lines: 600k nodes for one line, 1.2M
 * for three (the annotations', hints' and review's MultiPV 3). An iPhone searches about 0.5M
 * nodes per second, so that is 1-3 s. With a warm hash, MultiPV 3 reaches depth 14 within 1.2M
 * nodes in about 93% of game positions; the rest stop at depth 10-13.
 */
export function defaultEnsureNodes(multiPv: number): number {
  return ENSURE_NODES_UNIT * (Math.max(1, Math.round(multiPv)) + 1);
}

/**
 * Default node budget of the live analysis of one position, about 10 s on an iPhone. Depth 18 with
 * MultiPV 3 takes about 1M nodes in a typical game position and under 4M in 96% of them; in the
 * rest the eval bar settles at depth 12-13 instead of searching on for minutes.
 */
export const LIVE_NODES = 5_000_000;

export interface AnalysisServiceOptions {
  /** Depth at which live analysis stops. Default 18. */
  liveDepth?: number;
  /** MultiPV of live analysis. Default 3. */
  liveMultiPv?: number;
  /**
   * Node budget of the live analysis of one position: it stops there even below `liveDepth`
   * (and streams updates until then). Default `LIVE_NODES`; `Infinity` for none.
   */
  liveNodes?: number;
  /** Node budget of an `ensure()` that does not name one, by MultiPV. Default `defaultEnsureNodes`. */
  ensureNodes?: (multiPv: number) => number;
  /** Minimum interval between subscriber updates (ms). Default 120. */
  throttleMs?: number;
  /** Max number of cached positions (LRU). Default 3000. */
  cacheSize?: number;
}

/** What `ensure()` asks for. */
export interface EnsureOptions {
  /** Depth to search to. */
  minDepth: number;
  /** Lines wanted (UCI MultiPV; fewer when the position has fewer legal moves). Default 1. */
  multiPv?: number;
  /**
   * Node budget: the search stops at `minDepth` or after this many nodes, whichever comes first,
   * and a result that spent it is good enough (it may then be shallower than `minDepth`; it is
   * not `aborted`). Default `defaultEnsureNodes(multiPv)` (or the service's `ensureNodes`);
   * `Infinity` for none.
   */
  maxNodes?: number;
}

interface CacheEntry {
  result: AnalysisResult;
  /** MultiPV requested for the search that produced it (lines = min(width, legal moves)). */
  width: number;
  /**
   * Search effort behind the result: the nodes searched when it was reported, or the whole budget
   * of a search that stopped at its node budget (Infinity for a terminal position).
   */
  nodes: number;
}

interface Waiter {
  fen: string;
  minDepth: number;
  multiPv: number;
  maxNodes: number;
  resolve: (r: AnalysisResult) => void;
}

interface Job {
  key: string;
  fen: string;
  depth: number;
  multiPv: number;
  /** Node budget (Infinity = none). */
  maxNodes: number;
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
  private readonly liveNodes: number;
  private readonly ensureNodes: (multiPv: number) => number;
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
    this.liveNodes = nodeBudget(opts.liveNodes ?? LIVE_NODES);
    this.ensureNodes = opts.ensureNodes ?? defaultEnsureNodes;
    this.throttleMs = opts.throttleMs ?? 120;
    this.cacheSize = opts.cacheSize ?? 3000;
  }

  /**
   * High-priority analysis to `minDepth` with at least `multiPv` lines (or all legal moves), within
   * a node budget (`maxNodes`, see `EnsureOptions`), cached by fenKey. Pre-empts live analysis,
   * which resumes afterwards. Resolves from the cache immediately when a result is already deep
   * enough, or spent at least the budget. The result is shallower than `minDepth` only when its
   * search ran out of nodes or was cut short (`aborted: true`). `done` may be false when the
   * result was reported by a search still running (or later pre-empted). A search cut short by an
   * engine restart is retried (up to twice). Resolves `aborted: true` (best so far) after
   * cancelAll(), if the engine breaks, or if it keeps crashing on this position. Rejects only for
   * an invalid FEN.
   */
  ensure(fen: string, opts: EnsureOptions): Promise<AnalysisResult> {
    const key = fenKey(fen);
    const minDepth = Math.max(1, Math.round(opts.minDepth));
    const multiPv = Math.max(1, Math.round(opts.multiPv ?? 1));
    const maxNodes = nodeBudget(opts.maxNodes ?? this.ensureNodes(multiPv));
    const hit = this.lookup(key, minDepth, multiPv, maxNodes);
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
      const waiter: Waiter = { fen, minDepth, multiPv, maxNodes, resolve };
      const r = this.running;
      if (r && !r.superseded && !r.ended && r.key === key && covers(r, minDepth, multiPv, maxNodes)) {
        // Already searching this position deeply enough (typically the live search): join it.
        r.waiters.push(waiter);
        r.kind = 'ensure';
        return;
      }
      const queued = this.queue.find((j) => j.key === key);
      if (queued) {
        queued.depth = Math.max(queued.depth, minDepth);
        queued.multiPv = Math.max(queued.multiPv, multiPv);
        queued.maxNodes = Math.max(queued.maxNodes, maxNodes);
        queued.waiters.push(waiter);
        return;
      }
      this.queue.push(this.newJob(key, fen, minDepth, multiPv, maxNodes, 'ensure', [waiter]));
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

  private newJob(
    key: string,
    fen: string,
    depth: number,
    multiPv: number,
    maxNodes: number,
    kind: Job['kind'],
    waiters: Waiter[],
  ): Job {
    return {
      key,
      fen,
      depth,
      multiPv,
      maxNodes,
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
      if (r && !r.superseded && r.key === job.key && covers(r, job.depth, job.multiPv, job.maxNodes)) {
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
    if (this.lookup(t.key, this.liveDepth, this.liveMultiPv, this.liveNodes)) {
      if (r) this.supersede(r);
      return;
    }
    this.start(this.newJob(t.key, t.fen, this.liveDepth, this.liveMultiPv, this.liveNodes, 'live', []));
  }

  private start(job: Job): void {
    const prev = this.running;
    if (prev && !prev.ended) prev.superseded = true; // the engine pre-empts it
    this.running = job;
    // No `history`: results must depend on the position alone to be cached by fenKey (see header).
    this.engine
      .search(job.fen, {
        depth: job.depth,
        ...(Number.isFinite(job.maxNodes) ? { nodes: job.maxNodes } : {}),
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
    const nodes = p.lines[0]?.nodes ?? 0;
    this.store(job.key, p, job.multiPv, nodes);
    // Serve shallower requests early; at the job's own depth wait for the final result (done: true).
    if (p.depth < job.depth) this.resolveWaiters(job, p, nodes, false);
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
    const reported = res.lines[0]?.nodes ?? 0;
    // A finished search that stopped short of its depth ran out of nodes: it spent its budget.
    const spent = !res.aborted && res.depth < job.depth && Number.isFinite(job.maxNodes);
    const nodes = spent ? Math.max(reported, job.maxNodes) : reported;
    this.store(job.key, res, job.multiPv, nodes);
    if (!res.aborted) {
      this.resolveWaiters(job, res, nodes, true);
      // Left: requests that joined a search with a smaller budget, which ran out below their depth.
      if (job.waiters.length) this.queue.unshift(this.jobFor(job));
      this.accept(res, true, job.key);
    } else if (job.requeue) {
      job.requeue = false;
      this.resolveFromCache(job);
      if (job.waiters.length) {
        this.queue.unshift(this.newJob(job.key, job.fen, job.depth, job.multiPv, job.maxNodes, 'ensure', job.waiters));
      }
    } else if (!job.superseded) {
      // Unexpected abort: the engine restarted after a crash or hang. It is usable again, so
      // search once more rather than hand out a shallow partial result. A live search needs
      // nothing here: pump() restarts it.
      this.resolveFromCache(job);
      if (job.waiters.length && job.retries < RESTART_RETRIES) {
        // Sized for the waiters, not the old job: a deep live search that an ensure() joined
        // comes back as that ensure() only.
        const retry = this.jobFor(job);
        retry.retries = job.retries + 1;
        this.queue.unshift(retry);
      } else {
        this.abortWaiters(job);
      }
    }
    this.pump();
  }

  /** A new `ensure` job for the waiters of `job`, sized for them (not for `job`). */
  private jobFor(job: Job): Job {
    const ws = job.waiters;
    return this.newJob(
      job.key,
      job.fen,
      Math.max(...ws.map((w) => w.minDepth)),
      Math.max(...ws.map((w) => w.multiPv)),
      Math.max(...ws.map((w) => w.maxNodes)),
      'ensure',
      ws,
    );
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

  /**
   * Resolves the waiters that `r` (a result of `job` after `nodes` nodes) satisfies. The final
   * result of a search that asked for at least as much as a waiter (depth, lines and nodes)
   * resolves it whatever it holds. Other waiters stay: they joined a search with a smaller node
   * budget that ran out below their depth (see onEnd).
   */
  private resolveWaiters(job: Job, r: AnalysisResult, nodes: number, final: boolean): void {
    if (!job.waiters.length) return;
    const found: CacheEntry = { result: r, width: job.multiPv, nodes };
    const keep: Waiter[] = [];
    for (const w of job.waiters) {
      const asked = job.depth >= w.minDepth && job.multiPv >= w.multiPv && job.maxNodes >= w.maxNodes;
      const ok = satisfies(found, w.minDepth, w.multiPv, w.maxNodes) || (final && asked);
      if (ok) w.resolve(this.view(r, w.fen));
      else keep.push(w);
    }
    job.waiters = keep;
  }

  private resolveFromCache(job: Job): void {
    job.waiters = job.waiters.filter((w) => {
      const hit = this.lookup(job.key, w.minDepth, w.multiPv, w.maxNodes);
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

  private store(key: string, r: AnalysisResult, width: number, nodes: number): void {
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
      nodes: r.terminal ? Number.POSITIVE_INFINITY : nodes,
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

  /**
   * The answer to a request from the cache, if a cached result is good enough (`satisfies`): then
   * the deepest (then widest) result with enough lines, which may have taken fewer nodes than a
   * shallower one that ran out of nodes (a later search on a warm hash).
   */
  private lookup(key: string, minDepth: number, multiPv: number, maxNodes: number): CacheEntry | undefined {
    const front = this.cache.get(key);
    if (!front?.some((e) => satisfies(e, minDepth, multiPv, maxNodes))) return undefined;
    let hit: CacheEntry | undefined;
    for (const e of front) {
      if (!satisfies(e, 1, multiPv, maxNodes)) continue; // enough lines (any depth)
      if (!hit || e.result.depth > hit.result.depth || (e.result.depth === hit.result.depth && e.width > hit.width)) hit = e;
    }
    return hit;
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
  return a.result.depth >= b.result.depth && a.width >= b.width && a.nodes >= b.nodes;
}

/**
 * Whether a result answers a request: a terminal position, or enough lines that are either deep
 * enough or took at least the request's node budget (a search with that budget would not have
 * got further).
 */
function satisfies(e: CacheEntry, minDepth: number, multiPv: number, maxNodes: number): boolean {
  if (e.result.terminal) return true;
  return e.width >= multiPv && e.result.lines.length > 0 && (e.result.depth >= minDepth || e.nodes >= maxNodes);
}

/**
 * Whether a search's own limits cover a request: at least as deep and as wide, and a node budget
 * no larger than the request's, so it never runs past what the request is willing to wait for. A
 * smaller budget may stop it short: the request is then searched again with its own (onEnd).
 */
function covers(job: Pick<Job, 'depth' | 'multiPv' | 'maxNodes'>, minDepth: number, multiPv: number, maxNodes: number): boolean {
  return job.depth >= minDepth && job.multiPv >= multiPv && job.maxNodes <= maxNodes;
}

/** A node budget: a positive whole number, or Infinity for none (also for 0, negative or NaN). */
function nodeBudget(n: number): number {
  return n > 0 && Number.isFinite(n) ? Math.max(1, Math.round(n)) : Number.POSITIVE_INFINITY;
}
