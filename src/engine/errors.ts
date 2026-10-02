/**
 * Why an engine could not start, so the app can give the right advice: a download problem
 * ("check your connection") is not an unsupported browser ("needs iOS 16.4+").
 */

export type EngineFailureKind =
  /** The browser lacks Web Workers or WebAssembly SIMD. */
  | 'unsupported'
  /** The engine files could not be downloaded (HTTP error, offline, stalled download, wrong type). */
  | 'download'
  /** The engine loaded but never answered (the load timeout ran out). */
  | 'timeout'
  /** The engine process crashed or reported a fatal error. */
  | 'crash';

export class EngineLoadError extends Error {
  readonly kind: EngineFailureKind;

  constructor(message: string, kind: EngineFailureKind) {
    super(message);
    this.name = 'EngineLoadError';
    this.kind = kind;
  }
}

/** The failure kind of an error thrown by `createEngines()` / `ChessEngine.init()`, or null if unknown. */
export function engineFailureKind(e: unknown): EngineFailureKind | null {
  return e instanceof EngineLoadError ? e.kind : null;
}
