/**
 * Shared engine contracts. Everything that talks to Stockfish goes through these types.
 *
 * Score convention: UCI reports scores from the point of view of the SIDE TO MOVE.
 * We keep that convention inside the engine layer; convert with `toWhitePov()` from
 * `src/chess/utils.ts` before storing a score for display.
 */

/** Centipawns or mate-in-N. */
export type Score =
  | { kind: 'cp'; value: number }
  /**
   * Mate distance in moves (not plies). Positive: the side to move mates in N.
   * Negative: the side to move gets mated in N. 0: the side to move is already checkmated.
   */
  | { kind: 'mate'; value: number };

export interface PvLine {
  /** 1-based rank from MultiPV (1 = best). */
  multipv: number;
  depth: number;
  seldepth?: number;
  /** Side-to-move point of view. */
  score: Score;
  /** Set when the engine reported a lowerbound/upperbound (fail-high/low) score. */
  bound?: 'lower' | 'upper';
  /** Win/draw/loss per mille, side-to-move POV (only when UCI_ShowWDL is on). */
  wdl?: [number, number, number];
  nodes?: number;
  nps?: number;
  timeMs?: number;
  /** Principal variation as UCI moves, e.g. ["e2e4", "e7e5"]. Never empty for a reported line. */
  pv: string[];
}

export interface AnalysisResult {
  /** The FEN that was searched (exactly as passed in). */
  fen: string;
  /** Deepest depth for which `lines[0]` is available. 0 if nothing arrived yet. */
  depth: number;
  /** Sorted by `multipv` ascending; lines[0] is the engine's best line. May be empty (mate/stalemate). */
  lines: PvLine[];
  /** UCI best move, or null when the position has no legal moves or the search did not finish. */
  bestMove: string | null;
  /** True once the engine sent `bestmove` for this search. */
  done: boolean;
  /** True when the search was pre-empted by another search, stopped via AbortSignal, or the engine was terminated. */
  aborted?: boolean;
  /**
   * Set when the searched position has no legal moves (answered without the engine):
   * `lines` is then empty, `bestMove` null, `depth` 0 and `done` true.
   */
  terminal?: 'checkmate' | 'stalemate';
}

export interface SearchOptions {
  depth?: number;
  movetime?: number;
  nodes?: number;
  /** Number of principal variations (UCI MultiPV). Default 1. */
  multiPv?: number;
  /** Engine-side strength limit: sets UCI_LimitStrength=true and UCI_Elo (clamped to 1320..3190). Omit for full strength. */
  limitStrengthElo?: number;
  /** UCI "Skill Level" 0..20. Omit for 20 (full strength). Ignored when limitStrengthElo is set. */
  skillLevel?: number;
  /** Streaming updates while searching (throttling is the caller's concern). */
  onInfo?: (partial: AnalysisResult) => void;
  /** Aborting sends `stop`; the promise then resolves with the partial result and `aborted: true`. */
  signal?: AbortSignal;
}

/** Download progress of the engine's `.wasm` (bytes). */
export interface DownloadProgress {
  loaded: number;
  total: number;
}

/** Abstracts how UCI text reaches the engine (Web Worker in the browser, child process in tests). */
export interface EngineTransport {
  post(command: string): void;
  onLine(callback: (line: string) => void): void;
  /** Optional: reports a crashed/unloadable engine (worker `error` event, child process exit). */
  onError?(callback: (error: Error) => void): void;
  /** Optional: `.wasm` download progress while the engine loads (`loaded === total` when complete). */
  onProgress?(callback: (progress: DownloadProgress) => void): void;
  terminate(): void;
}

export interface ChessEngine {
  /** Sends `uci`/`isready` and applies default options. Idempotent. */
  init(): Promise<void>;
  /**
   * Runs one search. Only one search runs at a time: starting a new one pre-empts the
   * current one, whose promise resolves with `aborted: true`. Never rejects for
   * pre-emption or abort; rejects only if the engine is broken or terminated before init.
   */
  search(fen: string, opts?: SearchOptions): Promise<AnalysisResult>;
  /** Stops the current search (if any). Its promise resolves with `aborted: true`. */
  stop(): void;
  /** Sends `ucinewgame` (+ `isready`) once idle. */
  newGame(): Promise<void>;
  terminate(): void;
}
