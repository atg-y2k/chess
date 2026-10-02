/**
 * ChessEngine implementation over a UCI EngineTransport (a Web Worker in the browser, a child
 * process in tests).
 *
 * Invariants (see research/engine.md §3):
 *  - At most ONE `go` is in flight. A new search marks the running one aborted, resolves its
 *    promise right away with its partial result, sends `stop`, and only sends its own
 *    `position`/`go` after the old search's `bestmove` arrived. Every info/bestmove line is
 *    therefore owned by `current`, so a stale bestmove can never resolve a newer search.
 *  - `setoption` / `ucinewgame` are only sent while idle (the worker queues `setoption` behind a
 *    running search but runs `position`/`isready` immediately, which would reorder them).
 *  - `readyok` is also answered during a search, so it never means "idle"; it resolves a FIFO.
 *  - Streaming uses only complete MultiPV batches (all lines exact and at one depth).
 *  - A load timeout, a heartbeat (`isready` ping when the engine goes quiet) and a stop timeout
 *    detect a dead engine; `CRITICAL ERROR` output or a transport error do too. The engine is
 *    then respawned and re-initialised; the in-flight search resolves `aborted: true`.
 *  - The load timeout measures silence, not total time: `.wasm` download progress (when the
 *    transport reports it) counts as a sign of life, so a slow connection is not a dead engine.
 *    A failed first start rejects `init()` with an `EngineLoadError` saying why.
 *  - With `SearchOptions.history` the position is sent as `position fen … moves …` when chess.js
 *    confirms the moves legally reach the searched FEN (see ./position), so the engine sees
 *    repetitions; otherwise, and without history, as the bare FEN.
 */
import { Chess, type Square } from 'chess.js';
import { EngineLoadError } from './errors';
import { PositionCommands } from './position';
import type { AnalysisResult, ChessEngine, DownloadProgress, EngineTransport, PvLine, SearchOptions } from './types';
import { MultiPvCollector, goCommand, parseUciLine, setOptionCommand, toPvLine, type OptionValue } from './uci';

export interface StockfishEngineOptions {
  /** Transposition table size in MB (analysis 32, bot 16). Default 16. */
  hashMb?: number;
  /** Report win/draw/loss (`UCI_ShowWDL`). Default false. */
  showWdl?: boolean;
  /**
   * Max silence while loading (the WASM may fail to load without any error event): from spawn,
   * or from the last download-progress event, to `uciok`; and from `uciok` to `readyok`.
   * Default 15000.
   */
  loadTimeoutMs?: number;
  /** `.wasm` download progress while the engine (re)loads, when the transport reports it. */
  onProgress?: (progress: DownloadProgress) => void;
  /** Heartbeat tuning (tests shorten these). */
  watchdog?: Partial<WatchdogOptions>;
  /** Max automatic respawns per minute before the engine is declared broken. Default 3. */
  maxRespawnsPerMinute?: number;
  /** Label used in console warnings. */
  name?: string;
  /** Debug tap for every line sent (`out`) and received (`in`). */
  onLine?: (line: string, direction: 'in' | 'out') => void;
}

export interface WatchdogOptions {
  /** Watchdog timer period. */
  tickMs: number;
  /** Silence (no output) while waiting on the engine before an `isready` ping is sent. */
  pingAfterMs: number;
  /** Unanswered ping + silence for this long = engine hung. */
  hangMs: number;
  /** No `bestmove` this long after `stop` = engine hung. */
  stopTimeoutMs: number;
}

const DEFAULT_WATCHDOG: WatchdogOptions = { tickMs: 1000, pingAfterMs: 2500, hangMs: 7000, stopTimeoutMs: 5000 };

/** Position facts needed before talking to the engine. */
export interface PositionInfo {
  /** Normalised 6-field FEN (as produced by chess.js). */
  fen: string;
  legalMoves: number;
  terminal?: 'checkmate' | 'stalemate';
}

/**
 * Validates a FEN with chess.js (plus the "side not to move is in check" rule, which Stockfish
 * rejects with a CRITICAL ERROR) and reports legal-move count / terminal state.
 * Throws an Error for invalid positions.
 */
export function inspectPosition(fen: string): PositionInfo {
  let chess: Chess;
  try {
    chess = new Chess(fen.trim());
  } catch (e) {
    throw new Error(`Invalid FEN "${fen}": ${e instanceof Error ? e.message : String(e)}`);
  }
  const us = chess.turn();
  const them = us === 'w' ? 'b' : 'w';
  const theirKing: Square | undefined = chess.findPiece({ type: 'k', color: them })[0];
  if (theirKing && chess.isAttacked(theirKing, us)) {
    throw new Error(`Invalid FEN "${fen}": the side not to move is in check`);
  }
  const legalMoves = chess.moves().length;
  const info: PositionInfo = { fen: chess.fen(), legalMoves };
  if (legalMoves === 0) info.terminal = chess.inCheck() ? 'checkmate' : 'stalemate';
  return info;
}

type Phase =
  | 'down' // not spawned yet
  | 'starting' // waiting for uciok
  | 'syncing' // waiting for readyok after the initial options
  | 'idle'
  | 'preparing' // options sent, waiting for readyok before position/go
  | 'searching' // go sent, waiting for bestmove
  | 'newgame' // ucinewgame sent, waiting for readyok
  | 'dead';

interface Job {
  fen: string;
  /** UCI `position` command for this search. */
  position: string;
  opts: SearchOptions;
  collector: MultiPvCollector;
  lines: PvLine[];
  depth: number;
  goSent: boolean;
  stopSent: boolean;
  settled: boolean;
  resolve: (r: AnalysisResult) => void;
  reject: (e: Error) => void;
  detach?: () => void;
}

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
}

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

export class StockfishEngine implements ChessEngine {
  private readonly hashMb: number;
  private readonly showWdl: boolean;
  private readonly loadTimeoutMs: number;
  private readonly wd: WatchdogOptions;
  private readonly maxRespawns: number;
  private readonly name: string;
  private readonly tap?: (line: string, direction: 'in' | 'out') => void;
  private readonly progressCb?: (progress: DownloadProgress) => void;

  private transport: EngineTransport | null = null;
  private gen = 0;
  private phase: Phase = 'down';
  private phaseSince = 0;
  /** Last download progress of the current spawn (null: none reported). */
  private download: DownloadProgress | null = null;
  private everReady = false;
  private terminated = false;
  private fatal: Error | null = null;
  private initPromise: Promise<void> | null = null;
  private initWaiters: Waiter[] = [];

  private current: Job | null = null;
  private next: Job | null = null;
  private applied = new Map<string, string>();
  private readyQueue: (() => void)[] = [];
  private newGamePending = false;
  private newGameWaiters: Waiter[] = [];
  private newGameInFlight: Waiter[] = [];

  /** Builds `position` commands (keeps the last history replay). */
  private readonly positions = new PositionCommands();

  private respawnTimes: number[] = [];
  private respawnTotal = 0;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private lastLineAt = 0;
  private pingSentAt = 0;
  private stopSentAt = 0;

  /**
   * @param createTransport factory for a fresh engine process (called again on respawn).
   */
  constructor(
    private readonly createTransport: () => EngineTransport,
    opts: StockfishEngineOptions = {},
  ) {
    this.hashMb = opts.hashMb ?? 16;
    this.showWdl = opts.showWdl ?? false;
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 15_000;
    this.wd = { ...DEFAULT_WATCHDOG, ...opts.watchdog };
    this.maxRespawns = opts.maxRespawnsPerMinute ?? 3;
    this.name = opts.name ?? 'engine';
    this.tap = opts.onLine;
    this.progressCb = opts.onProgress;
  }

  /** Number of automatic respawns so far (diagnostics). */
  get respawnCount(): number {
    return this.respawnTotal;
  }

  /** True once the engine is permanently unusable (crash loop, failed load, or terminated). */
  get isDead(): boolean {
    return this.phase === 'dead';
  }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = new Promise<void>((resolve, reject) => {
        if (this.phase === 'dead') reject(this.deadError());
        else if (this.everReady) resolve();
        else {
          this.initWaiters.push({ resolve, reject });
          this.start();
        }
      });
    }
    return this.initPromise;
  }

  search(fen: string, opts: SearchOptions = {}): Promise<AnalysisResult> {
    if (this.phase === 'dead') return Promise.reject(this.deadError());
    let pos: PositionInfo;
    try {
      pos = inspectPosition(fen);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    if (opts.signal?.aborted) {
      return Promise.resolve({ fen, depth: 0, lines: [], bestMove: null, done: false, aborted: true });
    }
    this.preemptAll();
    if (pos.terminal) {
      return Promise.resolve({ fen, depth: 0, lines: [], bestMove: null, done: true, terminal: pos.terminal });
    }
    return new Promise<AnalysisResult>((resolve, reject) => {
      const multiPv = clampInt(opts.multiPv ?? 1, 1, 256);
      const job: Job = {
        fen,
        position: this.positions.command(pos.fen, opts.history),
        opts,
        collector: new MultiPvCollector(Math.min(multiPv, pos.legalMoves)),
        lines: [],
        depth: 0,
        goSent: false,
        stopSent: false,
        settled: false,
        resolve,
        reject,
      };
      const signal = opts.signal;
      if (signal) {
        const onAbort = () => this.abortJob(job);
        signal.addEventListener('abort', onAbort, { once: true });
        job.detach = () => signal.removeEventListener('abort', onAbort);
      }
      this.next = job;
      this.start();
      this.pump();
    });
  }

  stop(): void {
    this.preemptAll();
  }

  newGame(): Promise<void> {
    if (this.phase === 'dead') return this.terminated ? Promise.resolve() : Promise.reject(this.deadError());
    return new Promise<void>((resolve, reject) => {
      this.newGameWaiters.push({ resolve, reject });
      this.newGamePending = true;
      this.start();
      this.pump();
    });
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    const err = new Error(`Engine "${this.name}" was terminated`);
    for (const w of this.initWaiters.splice(0)) w.reject(err);
    for (const w of [...this.newGameWaiters.splice(0), ...this.newGameInFlight.splice(0)]) w.resolve();
    this.newGamePending = false;
    const jobs = [this.current, this.next];
    this.current = this.next = null;
    for (const j of jobs) if (j) this.settle(j, true);
    try {
      this.transport?.post('quit');
    } catch {
      /* ignore */
    }
    this.killTransport();
    this.fatal = err;
    this.setPhase('dead');
    this.stopTicking();
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle

  private start(): void {
    if (this.phase === 'down') this.spawn();
    this.ensureTicking();
  }

  private spawn(): void {
    const gen = ++this.gen;
    this.applied.clear();
    this.readyQueue = [];
    this.pingSentAt = 0;
    this.stopSentAt = 0;
    this.download = null;
    this.lastLineAt = Date.now();
    this.setPhase('starting');
    let t: EngineTransport;
    try {
      t = this.createTransport();
    } catch (e) {
      this.handleCrash(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    this.transport = t;
    t.onLine((line) => {
      if (gen === this.gen) this.handleLine(line);
    });
    t.onError?.((err) => {
      if (gen === this.gen) this.handleCrash(err);
    });
    t.onProgress?.((p) => {
      if (gen === this.gen) this.onDownloadProgress(p);
    });
    this.send('uci');
    this.ensureTicking();
  }

  private killTransport(): void {
    const t = this.transport;
    this.transport = null;
    this.gen++; // ignore anything the old transport still emits
    try {
      t?.terminate();
    } catch {
      /* ignore */
    }
  }

  /** Engine crashed, hung or failed to load: respawn (bounded) or give up. */
  private handleCrash(err: Error): void {
    if (this.phase === 'dead') return;
    console.warn(`[${this.name}] ${err.message}`);
    this.killTransport();
    const job = this.current;
    this.current = null;
    if (job && !job.settled) {
      if (!job.goSent && !this.next) this.next = job; // never reached the engine: retry after respawn
      else this.settle(job, true);
    }
    if (this.newGameInFlight.length) {
      this.newGameWaiters.unshift(...this.newGameInFlight.splice(0));
      this.newGamePending = true;
    }
    if (!this.everReady) {
      this.fail(err instanceof EngineLoadError ? err : new EngineLoadError(err.message, 'crash'));
      return;
    }
    const now = Date.now();
    this.respawnTimes = this.respawnTimes.filter((t) => now - t < 60_000);
    if (this.respawnTimes.length >= this.maxRespawns) {
      this.fail(new Error(`Engine "${this.name}" keeps crashing (${err.message})`));
      return;
    }
    this.respawnTimes.push(now);
    this.respawnTotal++;
    this.spawn();
  }

  /** Permanent failure: reject everything that waits on the engine. */
  private fail(err: Error): void {
    this.fatal = err;
    this.killTransport();
    this.setPhase('dead');
    this.stopTicking();
    for (const w of this.initWaiters.splice(0)) w.reject(err);
    for (const w of [...this.newGameWaiters.splice(0), ...this.newGameInFlight.splice(0)]) w.reject(err);
    this.newGamePending = false;
    const cur = this.current;
    const next = this.next;
    this.current = this.next = null;
    if (cur) this.settle(cur, true);
    if (next && !next.settled) {
      next.settled = true;
      next.detach?.();
      next.reject(err);
    }
  }

  private deadError(): Error {
    return this.fatal ?? new Error(`Engine "${this.name}" is not available`);
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.phaseSince = Date.now();
  }

  // ---------------------------------------------------------------------------------------------
  // I/O

  private send(cmd: string): void {
    if (!this.transport) return;
    this.tap?.(cmd, 'out');
    try {
      this.transport.post(cmd);
    } catch (e) {
      this.handleCrash(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private isReady(cb: () => void): void {
    this.readyQueue.push(cb);
    this.send('isready');
  }

  private setOption(name: string, value: OptionValue): boolean {
    const v = String(value);
    if (this.applied.get(name) === v) return false;
    this.applied.set(name, v);
    this.send(setOptionCommand(name, v));
    return true;
  }

  private handleLine(line: string): void {
    this.lastLineAt = Date.now();
    this.tap?.(line, 'in');
    const msg = parseUciLine(line);
    switch (msg.type) {
      case 'uciok':
        if (this.phase === 'starting') this.onUciOk();
        return;
      case 'readyok':
        this.readyQueue.shift()?.();
        return;
      case 'error':
        this.handleCrash(new Error(`Stockfish: ${msg.message}`));
        return;
      case 'info': {
        const job = this.current;
        if (!job || !job.goSent || job.settled) return;
        const pv = toPvLine(msg.info);
        if (!pv) return;
        const batch = job.collector.push(pv);
        if (!batch) return;
        job.lines = batch;
        job.depth = batch[0].depth;
        if (job.opts.onInfo) {
          try {
            job.opts.onInfo({ fen: job.fen, depth: job.depth, lines: batch, bestMove: null, done: false });
          } catch (e) {
            console.error(`[${this.name}] onInfo callback failed`, e);
          }
        }
        return;
      }
      case 'bestmove':
        this.onBestMove(msg.move);
        return;
      default:
        return;
    }
  }

  /** Bytes are arriving: the engine is loading, not hung. Restarts the load timeout. */
  private onDownloadProgress(p: DownloadProgress): void {
    if (this.phase !== 'starting') return;
    this.download = p;
    this.phaseSince = this.lastLineAt = Date.now();
    try {
      this.progressCb?.(p);
    } catch (e) {
      console.error(`[${this.name}] onProgress callback failed`, e);
    }
  }

  private onUciOk(): void {
    this.setPhase('syncing');
    this.setOption('Hash', this.hashMb);
    this.setOption('UCI_ShowWDL', this.showWdl);
    this.setOption('MultiPV', 1);
    this.setOption('Skill Level', 20);
    this.setOption('UCI_LimitStrength', false);
    this.isReady(() => {
      this.setPhase('idle');
      if (!this.everReady) {
        this.everReady = true;
        for (const w of this.initWaiters.splice(0)) w.resolve();
      }
      this.pump();
    });
  }

  private onBestMove(move: string | null): void {
    const job = this.current;
    if (!job || !job.goSent || this.phase !== 'searching') return; // stray line, not ours
    this.current = null;
    this.stopSentAt = 0;
    this.settle(job, false, move);
    this.setPhase('idle');
    this.pump();
  }

  // ---------------------------------------------------------------------------------------------
  // Scheduling

  /** Starts the next piece of work if the engine is idle. */
  private pump(): void {
    if (this.phase !== 'idle') return;
    if (this.newGamePending) {
      this.newGamePending = false;
      this.newGameInFlight = this.newGameWaiters.splice(0);
      this.setPhase('newgame');
      this.send('ucinewgame');
      this.isReady(() => {
        for (const w of this.newGameInFlight.splice(0)) w.resolve();
        this.setPhase('idle');
        this.pump();
      });
      return;
    }
    const job = this.next;
    if (!job) return;
    this.next = null;
    this.current = job;
    if (this.applySearchOptions(job.opts)) {
      this.setPhase('preparing');
      this.isReady(() => this.startGo(job));
    } else {
      this.startGo(job);
    }
  }

  private startGo(job: Job): void {
    if (job.settled) {
      // Aborted while its options were being applied: nothing was sent for it.
      if (this.current === job) this.current = null;
      this.setPhase('idle');
      this.pump();
      return;
    }
    this.send(job.position);
    this.send(goCommand(job.opts));
    job.goSent = true;
    this.stopSentAt = 0;
    this.lastLineAt = Date.now();
    this.setPhase('searching');
  }

  /** Puts MultiPV / strength options into the requested state; true if anything was sent. */
  private applySearchOptions(opts: SearchOptions): boolean {
    let changed = this.setOption('MultiPV', clampInt(opts.multiPv ?? 1, 1, 256));
    if (opts.limitStrengthElo !== undefined) {
      changed = this.setOption('UCI_LimitStrength', true) || changed;
      changed = this.setOption('UCI_Elo', clampInt(opts.limitStrengthElo, 1320, 3190)) || changed;
    } else {
      changed = this.setOption('UCI_LimitStrength', false) || changed;
      changed = this.setOption('Skill Level', clampInt(opts.skillLevel ?? 20, 0, 20)) || changed;
    }
    return changed;
  }

  private preemptAll(): void {
    if (this.next) this.abortJob(this.next);
    if (this.current) this.abortJob(this.current);
  }

  private abortJob(job: Job): void {
    if (job.settled) return;
    if (this.next === job) this.next = null;
    this.settle(job, true);
    if (this.current === job && job.goSent && !job.stopSent) {
      job.stopSent = true;
      this.stopSentAt = Date.now();
      this.send('stop');
    }
  }

  private settle(job: Job, aborted: boolean, bestMove: string | null = null): void {
    if (job.settled) return;
    job.settled = true;
    job.detach?.();
    const r: AnalysisResult = {
      fen: job.fen,
      depth: job.depth,
      lines: job.lines,
      bestMove: aborted ? null : bestMove,
      done: !aborted,
    };
    if (aborted) r.aborted = true;
    job.resolve(r);
  }

  // ---------------------------------------------------------------------------------------------
  // Watchdog

  private ensureTicking(): void {
    if (this.timer || this.phase === 'dead') return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), this.wd.tickMs);
  }

  private stopTicking(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();
    const gap = now - this.lastTick;
    this.lastTick = now;
    if (gap > this.wd.tickMs * 3) {
      // The page was suspended (iOS background) or timers were throttled: restart the clocks
      // instead of blaming the engine for our own absence.
      this.phaseSince = now;
      this.lastLineAt = now;
      if (this.pingSentAt) this.pingSentAt = now;
      if (this.stopSentAt) this.stopSentAt = now;
      return;
    }
    switch (this.phase) {
      case 'starting':
      case 'syncing':
        if (now - this.phaseSince > this.loadTimeoutMs) {
          const d = this.download;
          this.handleCrash(
            this.phase === 'starting' && d && d.loaded < d.total
              ? new EngineLoadError(
                  `Engine "${this.name}" download stalled at ${Math.floor((100 * d.loaded) / d.total)}% ` +
                    `(no data for ${this.loadTimeoutMs} ms)`,
                  'download',
                )
              : new EngineLoadError(`Engine "${this.name}" did not start within ${this.loadTimeoutMs} ms`, 'timeout'),
          );
        }
        return;
      case 'preparing':
      case 'newgame':
      case 'searching': {
        if (this.stopSentAt && now - this.stopSentAt > this.wd.stopTimeoutMs) {
          this.handleCrash(new Error(`Engine "${this.name}" did not answer "stop"`));
          return;
        }
        const silent = now - this.lastLineAt;
        if (this.pingSentAt) {
          if (now - this.pingSentAt > this.wd.hangMs && silent > this.wd.hangMs) {
            this.handleCrash(new Error(`Engine "${this.name}" stopped responding`));
          }
        } else if (silent > this.wd.pingAfterMs) {
          this.pingSentAt = now;
          this.isReady(() => {
            this.pingSentAt = 0;
          });
        }
        return;
      }
      case 'idle':
        if (!this.next && !this.newGamePending && this.readyQueue.length === 0) this.stopTicking();
        return;
      default:
        this.stopTicking();
    }
  }
}
