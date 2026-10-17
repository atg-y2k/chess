# Chess Coach — architecture

An iPhone chess app: play against Stockfish at any Elo, with a live evaluation bar and a coach that
classifies and explains moves. Everything runs on the phone: no server and no account. One codebase
ships two ways: an installable web app (PWA) that works offline once installed, and a native App
Store app (Capacitor) with the files inside it and a one-time "Pro" in-app purchase (see
[Native iOS app](#native-ios-app-app-store)).

- **UI:** Preact + `@preact/signals`, TypeScript, Vite.
- **Rules:** `chess.js` (BSD-2).
- **Board:** `@lichess-org/chessground` (GPL-3).
- **Engine:** Stockfish 19 "lite single-threaded" WASM from `stockfish` (nmrugg/stockfish.js, GPL-3). It is vendored in `public/engine/`.
- **Hosting:** GitHub Pages (static). The app is installed with Safari → ⋯ → Share → *Add to Home Screen*.
- **App Store app:** Capacitor 8 (MIT) around the same build (`VITE_NATIVE=1`), Xcode project in `ios/`,
  StoreKit 2 through the app's own plugin.

## Module map (ownership boundaries)

```
src/
  main.tsx                 bootstrap: iOS guards, service worker (+ "Available offline" signal), visibility ->
                           controller; renders <App/> (or the engine self-test page with ?enginetest), calls boot()
  App.tsx / App.css        screen layout + wiring of store/controller to components (see "App shell")
  theme.ts                 color theme preference (dark default / light / system) -> <html data-theme>
  layout/fold.ts           foldable screens (the iPhone Duo): where the fold is (Viewport Segments API, Device Posture
                           API, else a heuristic from the screen's size), the "Foldable screen" setting, the layout it
                           gives (book / tabletop / none) -> <html data-fold> (see "Screen layout")
  clipboard.ts             copyText() with a legacy fallback (PGN export, self-test log)
  pwa.ts / ios.ts          service-worker registration (kept alive) with a deferred reload; iOS zoom guards + first-tap hook
  styles/app.css           global design tokens (colors, radii, safe areas) + .btn styles
  chess/utils.ts           small shared helpers (fenKey, sideToMove, toWhitePov, uciToSan, pvToSan, material, capturedPieces,
                           capturedByMoves, seenPositions / withPosition / repetitionReplies: a game's position counts)
  engine/
    types.ts               CONTRACT: Score, PvLine, AnalysisResult, SearchOptions, SearchHistory, EngineTransport, ChessEngine
    errors.ts              EngineLoadError + failure kinds (unsupported / download / timeout / crash)
    uci.ts                 pure UCI line parsing
    position.ts            the UCI `position` command, with the game's moves when they legally reach the FEN
    StockfishEngine.ts     ChessEngine implementation over an EngineTransport (search queue, stop/bestmove race
                           handling, load timeout, watchdog, respawn)
    workerTransport.ts     EngineTransport over a Web Worker running public/engine/stockfish-19-lite-single.js
                           (download progress, early detection of a failed .wasm download)
    EngineMux.ts           one worker shared by bot + analysis (single-engine fallback)
    createEngines.ts       creates the two engines (or the shared one); remembers "single" mode for 14 days
    AnalysisService.ts     cached, prioritized analysis on top of one ChessEngine (ensure / watch)
    selfTest.ts            diagnostics run by the ?enginetest page
  analysis/
    types.ts               CONTRACT: MoveClass, Classification, Arrow, Explanation
    winprob.ts             centipawns/mate -> win probability, score formatting
    classify.ts            chess.com-style move classification
    nearEqual.ts           "about as good": the near-equal rule (calibrated constants) and the words built on it
                           ("Best was X (Y and Z were about as good).", "Your Nxd5 was fine: X was only slightly better.")
    sacrifice.ts           sacrifice detection for Brilliant
    accuracy.ts            per-move and per-game accuracy (lichess formulas)
    see.ts                 attackers / static exchange evaluation helpers (see, exchangeCounts, hangingPieces)
    motifs.ts              tactic / threat detectors (fork, pin, hanging, trapped, mate threats, ...; passTurn)
    explain.ts             plain-English coaching explanations
    threat.ts              threat alerts: the engine's null-move probe and its verdict (what the opponent threatens)
  bot/
    types.ts               CONTRACT: BotPersona, OpeningInfo, BotMove
    strength.ts            planForElo(elo) + chooseMove(...) (Elo scaling 100..3200, mates, conversion, repetition guard)
    personas.ts            named bots (original names — no chess.com names/branding)
    book.ts                opening names + book moves (lazy-loads src/data/openings.json)
    BotPlayer.ts           plays a move for a given Elo using its own ChessEngine
  data/openings.json       generated by scripts/build-openings.mjs from lichess chess-openings (CC0)
  rating/
    types.ts               CONTRACT: GameRecord (+ its CompactAnalysis), PlayerProfile
    rating.ts              Elo with a Glicko-style K-factor, starting levels, profile persistence (localStorage, slimmed on quota errors)
    history.ts             the rating chart's data (rated games oldest first, levels set, peak, new-rating runs), its words
  game/
    types.ts               CONTRACT: Ply, GameSettings, GameOutcome, Color
    store.ts               app state as signals + computed view models (one per component)
    controller.ts          GameController: player move -> coach -> bot move; analysis orchestration, review
    coach.ts               coach wording and rules that need no engine (class sentences, move labels, tips,
                           the recapture tip, which actions a classification offers, answer-free text while
                           Retry is offered, neutral verdicts for praised moves that give something away)
    review.ts              game summary (accuracy, counts, key moments, weak moves made in a won game and their note)
    practice.ts            Try again: the moves of any game (the one on the board, or an earlier one) that can be tried
                           again, one try's pure state (attempt, verdict, hints, answer) and its wording
    archive.ts             earlier games: the compact analysis a GameRecord keeps (encode / decode), the moves from its PGN,
                           its opponent, its annotated export
    viewer.ts              the game viewer's pure state (an earlier game open full screen), transitions and view model
    explorer.ts            the explorer's pure state: base position, explored line, cursor, moves, ratings
    drawings.ts            Draw mode's drawings (arrows, circles) by position (placement + side to move): toggle, Clear
    opening.ts             opening practice: where a game stands on the line it follows (on it / left / complete)
    pgn.ts                 PGN export with [%eval] comments and NAGs
    persistence.ts         save/restore the current (or just finished) game + settings
    sound.ts               synthesized move sounds (Web Audio, unlocked on first tap)
  ui/                      presentational components; each has its own CSS file next to it
                           (SelfTestPage.tsx is the ?enginetest page; draw.ts: Draw mode's pure touch geometry,
                           DrawBar.tsx: its toggle and bar)
  dev/                     component gallery pages (dev only: /gallery.html?g=<board|panels|sheets|engine>)
  openings/                the Openings section's data and logic (no DOM; see "Openings section"):
    catalog.ts             every named line (lazy src/data/opening-lines.json), families, search, starter lists
    tree.ts                book moves from a position with names and shares, a line's positions, steering a game
    drill.ts               drilling a line move by move (pure state machine; Pro)
    progress.ts            saved drill progress and mastery (localStorage 'chesscoach.openings'; Pro)
    session.ts             the section's UI state: open or not, its page stack and each page's state (main bundle)
  data/opening-guides.ts   plain-English guides for 39 openings (summary, plans, traps with their mistakes, move notes,
                           the main line; lazy; Pro text)
  ui/openings/             the Openings section's screens (lazy chunk): OpeningsView (navigation, Play sheet),
                           Home, Family, Line (learn), Tree, Drill pages, PlaySheet, OpeningBoard, model.ts (view logic)
  game/entitlements.ts     Pro: FEATURE_TIERS (the free / Pro split), the entitlement state and the paywall's state
  native/                  the App Store app (see "Native iOS app"): platform.ts (build / runtime flags, the only
                           Capacitor imports), purchases.ts (StoreKit plugin / mock store / always unlocked),
                           storage.ts, haptics.ts, share.ts, statusbar.ts
  ui/PaywallSheet.tsx      the Pro paywall + lock glyphs; ui/LicenseSheet.tsx: in-app viewer for the license texts
  ui/RatingChart.tsx       the Menu's rating history chart (inline SVG); ui/GameViewer.tsx: the game viewer's screen
ios/                       Xcode project (Capacitor, Swift Package Manager): ios/README-native.md
public/privacy.html, terms.html, support.html   static pages the App Store listing and the paywall link to
scripts/appstore-screenshots.mjs                App Store screenshots (Playwright)
```

**Rules for all modules**
- Contracts live in `*/types.ts`. Do not change their exported shapes without updating every user.
- Pure logic (`engine/uci.ts`, `engine/position.ts`, `analysis/*`, `bot/strength.ts`, `rating/rating.ts`) has **no DOM access**. It is unit-tested with Vitest in node (`npm test`).
- UI components are **presentational**: they take props and emit callbacks, and never import the store or controller.
- Colors must come from the CSS variables in `src/styles/app.css`. Light-theme overrides are written
  as `:root[data-theme='light'] …` (never `prefers-color-scheme`), because the theme is a user choice.
- User-facing text is in American English.

## Engine design

- Two Stockfish workers. **Bot engine:** plays the opponent's moves (always full strength; the bot
  weakens its choice in JS). **Analysis engine:** full strength, `MultiPV 3`. It feeds the eval bar,
  best-move arrows and the coach. The A17 Pro has 6 cores, so the two single-threaded workers run
  in parallel.
- `StockfishEngine.search()` runs one search at a time. A new search pre-empts the old one: the old
  promise resolves `{ aborted: true }` with partial lines. After a `stop`, the stale `bestmove`
  belongs to the old search and must never resolve the new one.
- **Loading and failures.** The worker reports the `.wasm` download progress (`EngineTransport.onProgress`).
  The load timeout (15 s) measures silence, so a slow download is not a dead engine. When the
  worker is silent for 3 s, the `.wasm` is probed from the page (a GET aborted as soon as the headers
  arrive, so it never becomes a second download); an HTTP error, a network error or a non-wasm
  content type fails the start at once as a `download` error. A probe with no headers after
  `probeTimeoutMs` (10 s) is dropped without a verdict and tried later. `init()` rejects with an
  `EngineLoadError` whose `kind` says why. After a successful start, a watchdog (`isready` pings, a
  stop timeout) and `CRITICAL ERROR` output detect a dead engine, which is respawned (at most 3
  times a minute, then it is declared broken); the search in flight resolves `aborted: true`.
- **Position and history.** `SearchOptions.history` (`{ startFen, moves }`) lets the engine see
  repetitions. `engine/position.ts` replays the moves with chess.js first (an illegal move in a
  `position … moves` list kills the WASM engine) and, only when they legally reach the searched FEN,
  sends `position fen F moves …`, where F is the position right after the last capture, pawn move
  or castling-rights change (so the list holds only quiet piece moves). Otherwise the bare FEN is
  sent. The replay is extended incrementally while the history only grows.
- **Who sends history.** The bot's searches do (BotPlayer, when the history replays to the
  position), so Stockfish scores a threefold repetition as a draw. Analysis never does:
  `AnalysisService` results are cached by `fenKey` and shared by every move order that reaches a
  position, so they must depend on the position only. The controller detects the threefold itself.
- **Single-engine fallback.** `EngineMux` runs bot (high priority) and analysis (low priority) on
  one worker: a bot search pauses the analysis search, which restarts transparently afterwards
  (history included). A bot search that follows analysis first sends `ucinewgame`, so the bot never
  profits from the analysis hash table (its calibration assumes an engine of its own).
- `AnalysisService`:
  - `ensure(fen, {minDepth, multiPv, maxNodes, signal, priority})`: high priority, cached by `fenKey`. It
    pre-empts live analysis, then live analysis resumes. Requests run by `priority` (higher first, FIFO
    among equals; default 0), and one of a higher priority pre-empts a running `ensure` search of a lower
    one, which goes back to the head of its priority and is searched again on a warm hash; a request
    that joins a queued or running search lifts it to its own priority (a withdrawn one lowers it again).
    The controller's levels are `ANALYSIS_PRIORITY` (see "Coach flow"). A search cut short by an engine restart is
    retried (up to twice) before its waiters get the best result so far. A request whose `signal`
    aborts is withdrawn: it resolves at once with the best so far (`aborted: true`), a queued search
    nobody else waits for is dropped, and the running one goes on only as live analysis (replaced
    unless it is the watched position). The explorer withdraws its requests when it closes or its
    engine is switched off.
  - `watch(fen)`: live analysis of the current position (depth 18, MultiPV 3, at most `LIVE_NODES`
    = 5M nodes, about 10 s on an iPhone), with streaming updates to subscribers.
  - **Node budgets.** Every search is limited by depth and by nodes (`go depth D nodes N`), never
    by `movetime`. An `ensure()` without `maxNodes` gets `defaultEnsureNodes(multiPv)` = 300k ×
    (multiPv + 1): 1.2M for MultiPV 3, about 2.5 s on an iPhone (~0.5M nodes/s). With a warm hash,
    MultiPV 3 reaches depth 14 within 1.2M nodes in ~93% of game positions (median ~200k), and
    depth 18 within 5M in ~96% (median ~1M). The rest are positions where one iteration takes
    millions of nodes (e.g. after 9.Qa3+ in 1.d4 Nf6 2.c4 d5 3.cxd5 Nxd5 4.e4 Nd7 5.exd5 c6 6.dxc6
    Rg8 7.cxd7+ Kxd7 8.Qa4+ Kd6 9.Qa3+, where an unbudgeted depth-14 request took a minute in the
    browser and froze the coach and the eval bar): there the search stops at the budget with a
    finished, shallower result. The cache records the nodes behind each result, so a result that
    spent a budget answers every request with the same or a smaller one (the next move's "before"
    analysis is not searched again), and the deepest result of enough lines is returned once one is
    good enough. A request joins a running search only when that search's budget is not larger
    than its own (so it never waits past its budget); the live search has the larger budget, so a
    coach request for the watched position pre-empts it, streams its own partial results to the eval
    bar, and the live search resumes afterwards with a warm hash.
  - Analysis pauses when the page is hidden: the controller calls `setPaused()` from
    `onVisibilityChange` (AnalysisService does not listen to visibility itself).
- The controller wraps both engines (`monitorEngine`) to notice when one breaks for good: it saves
  the game, stops the bot and shows the error screen ("The chess engine stopped working"); *Try
  again* starts fresh engines and restores the game.

## Module APIs (the integration layer codes against these)

```ts
// engine/types.ts (excerpt)
export interface SearchHistory { startFen: string; moves: readonly string[] } // UCI moves from startFen to the searched FEN
export interface SearchOptions {
  depth?: number; movetime?: number; nodes?: number; multiPv?: number /*1*/;
  limitStrengthElo?: number; skillLevel?: number;   // engine-side limits (the app does not use them)
  history?: SearchHistory;                          // the game so far: lets the engine see repetitions (see position.ts)
  onInfo?: (partial: AnalysisResult) => void; signal?: AbortSignal;
}
export interface EngineTransport {
  post(command: string): void; onLine(cb: (line: string) => void): void;
  onError?(cb: (error: Error) => void): void;
  onProgress?(cb: (p: DownloadProgress /* { loaded, total } bytes */) => void): void; // .wasm download progress
  terminate(): void;
}

// engine/errors.ts
export type EngineFailureKind = 'unsupported' | 'download' | 'timeout' | 'crash';
export class EngineLoadError extends Error { readonly kind: EngineFailureKind }
export function engineFailureKind(e: unknown): EngineFailureKind | null;

// engine/position.ts
export class PositionCommands { command(fen: string, history?: SearchHistory): string } // keeps the last replay; never throws
export function positionCommand(fen: string, history?: SearchHistory): string;

// engine/workerTransport.ts
export function engineSupported(): boolean;                   // Web Workers + WebAssembly SIMD (iOS 16.4+)
export function engineScriptUrl(): string; export function engineWasmUrl(scriptUrl?: string): string;
export function createWorkerTransport(url?: string, opts?: { probeAfterMs?: number /*3000*/; probeTimeoutMs?: number /*10000*/ }): EngineTransport;

// engine/StockfishEngine.ts
export class StockfishEngine implements ChessEngine {
  constructor(createTransport: () => EngineTransport, opts?: {
    hashMb?: number /*16*/; showWdl?: boolean; loadTimeoutMs?: number /*15000, silence while loading*/;
    onProgress?: (p: DownloadProgress) => void; maxRespawnsPerMinute?: number /*3*/; name?: string; /* + test hooks */
  });
  readonly respawnCount: number; readonly isDead: boolean;
}
export function inspectPosition(fen: string): { fen: string; legalMoves: number; terminal?: 'checkmate' | 'stalemate' }; // throws for a FEN Stockfish would reject

// engine/createEngines.ts
export interface EngineSet { analysis: ChessEngine; bot: ChessEngine; mode: 'dual' | 'single'; terminate(): void }
export interface EngineLoadProgress extends DownloadProgress { engine: 'analysis' | 'bot' }
/** Creates the analysis engine first (Hash 32, WDL), then the bot engine (Hash 16). It falls back to
 *  ONE shared worker (EngineMux) when `?engines=1` or `forceSingle` is set, when the second worker
 *  fails to start (remembered unless it was a download failure), or when the previous dual start
 *  looks like it was killed (a boot flag kept only while the page is visible and cleared once the
 *  dual start has run 20 s in the foreground; WebKit OMG-compile memory bug). Single mode is then
 *  remembered for 14 days (`SINGLE_MODE_TTL_MS`); `?engines=2` or `resetEngineMode()` forgets it.
 *  Rejects only if the first engine cannot start (an `EngineLoadError` when the cause is known). */
export function createEngines(opts?: { forceSingle?: boolean; onProgress?: (p: EngineLoadProgress) => void; /* + test hooks */ }): Promise<EngineSet>;
export function rememberedEngineMode(): { mode: 'single'; since: number; until: number } | null;
export function resetEngineMode(): void;

// engine/AnalysisService.ts — position-only: never sends SearchOptions.history
export class AnalysisService {
  constructor(engine: ChessEngine, opts?: {
    liveDepth?: number /*18*/; liveMultiPv?: number /*3*/; liveNodes?: number /*LIVE_NODES = 5M*/;
    ensureNodes?: (multiPv: number) => number /*defaultEnsureNodes*/; throttleMs?: number /*120*/; cacheSize?: number /*3000*/;
  });
  /** High-priority analysis to minDepth within maxNodes (default defaultEnsureNodes(multiPv): 1.2M for MultiPV 3),
   *  cached by fenKey; pre-empts live analysis, which resumes afterwards. A result that ran out of nodes below
   *  minDepth is final (not aborted) and answers later requests with the same or a smaller budget. */
  ensure(fen: string, opts: { minDepth: number; multiPv?: number; maxNodes?: number /*Infinity = none*/; signal?: AbortSignal /*withdraws it*/;
    priority?: number /*higher first, pre-empts a running lower one; default 0*/ }): Promise<AnalysisResult>;
  /** Live analysis target (null = none). Streams updates to subscribers; stops at liveDepth or liveNodes. */
  watch(fen: string | null): void;
  subscribe(cb: (r: AnalysisResult) => void): () => void;
  /** Best cached result for this position (any depth), if any. */
  get(fen: string): AnalysisResult | undefined;
  /** Pause (page hidden) stops the engine and holds the queue; resume re-issues the work. */
  setPaused(paused: boolean): void;
  /** Drop queued `ensure` work (rejecting nothing — they resolve with best-so-far, aborted: true). */
  cancelAll(): void;
}

// engine/selfTest.ts — diagnostics page (?enginetest) for checking the engine on a real iPhone
export function runEngineSelfTest(log: (line: string) => void, opts?: { forceSingle?: boolean; concurrentMs?: number }): Promise<boolean>;

// bot/BotPlayer.ts
export class BotPlayer {
  constructor(engine: ChessEngine, opts?: { rng?: () => number; thinkDelay?: boolean /*true*/ });
  /** Call at game start: draws the per-game opening-book profile for this Elo. */
  newGame(elo: number): Promise<void>;
  /** Chooses the bot's move. `history` = UCI moves from `startFen` (default: the initial position) to
   *  `fen`: it drives the book and think time, and replaying it gives the repetition counts, which
   *  the engine searches also get (`SearchOptions.history`). A history that does not lead to `fen`
   *  only turns the repetition guard off. null if aborted or no legal move; never rejects for
   *  engine failures (heuristic fallback move). */
  move(fen: string, elo: number, history: string[], signal?: AbortSignal, startFen?: string): Promise<BotMove | null>;
  /** Plays the caller's move (opening practice: the line's next move) as a book move, with a book move's think
   *  time; its own `move` when `uci` is not legal in `fen`. null if aborted. */
  lineMove(fen: string, elo: number, uci: string, history: string[], signal?: AbortSignal, startFen?: string): Promise<BotMove | null>;
}
// bot/strength.ts (pure)
export function planForElo(elo: number): BotPlan;  // 100..1319 'custom', 1320..3199 'skill', 3200 'full'
export function chooseMove(fen: string, result: AnalysisResult, mp: MovePlan, rng: () => number,
  ctx?: { deep?: AnalysisResult /* conversion search */; positions?: ReadonlyMap<string, number> /* repetition counts */ }): ChosenMove | null;
export function conversionSearchFor(fen: string, result: AnalysisResult, mp: MovePlan): SearchOptions | null; // extra deep search in a won simple ending
//   Skill band: a forced mate among the lines is always played, shortest first. Conversion (a lone king, or
//   king + pawns / one minor piece, at least a rook's worth behind, score >= +200 damped by the 50-move
//   counter): the skill band plays the deep search's move; the custom band plays it with an Elo-dependent
//   probability, else stays human-ish among moves within 150 cp that neither stalemate nor hang a queen or
//   rook. Repetition guard: at >= +150, moves that complete a threefold (or let the opponent complete one
//   with a single reply) are dropped while a clearly better move remains.
// bot/personas.ts
export const BOTS: BotPersona[];            // ascending Elo, 16 original characters from 100 to 3200
export function personaById(id: string): BotPersona | undefined;
export function customPersona(elo: number): BotPersona;
// bot/book.ts (lazy-loads src/data/openings.json)
export function loadOpenings(): Promise<void>;
export function openingAt(fen: string): OpeningInfo | null;
export function currentOpening(fens: string[]): (OpeningInfo & { ply: number }) | null; // walks back to last named position
export function isBookMove(fenBefore: string, uci: string, fenAfter: string): boolean;

// analysis/winprob.ts  (all probabilities 0..1)
export function cpToWin(cp: number): number;              // lichess logistic, k = 0.00368208
export function scoreToWin(score: Score): number;         // POV of the side the score belongs to; mate -> 1 / 0
export function whiteBarFraction(scoreWhite: Score, sideToMove?: Color): number; // eval-bar fill for White
export function formatScore(scoreWhite: Score, sideToMove?: Color): string; // "+1.3", "-0.4", "0.0", "M3", "-M2", "1-0"/"0-1" when mated
                                                          // (pass sideToMove: a JSON round trip loses the sign of mate 0)
export function negateScore(s: Score): Score;
// analysis/accuracy.ts
export function moveAccuracy(winBefore: number, winAfter: number): number; // 0..100
export function gameAccuracy(evalsWhite: (Score | null)[], opts?: { startColor?: Color }): { w: number | null; b: number | null }; // index 0 = start position
// analysis/classify.ts
export function classifyMove(p: {
  fenBefore: string; moveUci: string;
  before: AnalysisResult;          // analysis of fenBefore (MultiPV >= 2 preferred)
  after?: AnalysisResult;          // analysis of the position after the move (needed if the move isn't in before.lines)
  opponentPrevWinLoss?: number;    // winLoss of the opponent's previous move (for "miss")
  isBook?: boolean;
  playerRating?: number;           // rating tiers for "brilliant" / "great"
  prevMove?: { to: string };       // the opponent's previous move (a recapture is never "great")
  prevFenBefore?: string;          // position before the opponent's previous move: ignoring a fresh threat can count as a sacrifice
  bestAfter?: AnalysisResult;      // the second opinion: analysis of the position after before.lines[0] (see nearBestRecheck)
}): Classification;
//   The played move's score comes from `before.lines` when the move is among them (same search), else from `after`. A listed
//   move (not the first) that its own search scores more than LISTED_DISPUTE_CP = 100 cp above its line is judged by its own
//   search instead (secondary MultiPV lines can be under-searched: 51…Qb1+ 2.1 listed, 4.9 by itself), against the best move's
//   own search when `bestAfter` is given (`nearBestRecheck` asks for it then), so the class agrees with the eval graph.
//   A forced mate that the deeper `after` search finds, for either side, replaces a centipawn score from `before`,
//   so the class agrees with the explanation, which describes that mate.
//   It also records near-equal awareness (analysis/nearEqual.ts): `equalBest`, the before-lines about as good as the
//   best one (best first, the best included, at most 3; for a move that was not about as good, without the moves it
//   matched), `nearBest`, whether the played move was (absent when its evaluation is unknown; never for a weak class),
//   and `aboveBest` (with nearBest: it scored at least as well as the best, e.g. a mate or a draw the best line lacks).
//   The played move is first compared with the best line: its own line when listed, else its `after` search. Just
//   outside the band (at most NEAR_EQUAL_RECHECK_CP behind), or for a listed move its `after` search puts that far
//   below the best line, the second opinion decides: its `after` search against `bestAfter` (like with like). The
//   class itself does not depend on any of this.
//   `wonAnyway` ({ kind: 'slower' | 'lost'; mateIn }): the class (always an inaccuracy) is weak only by the mate-distance
//   rules while the move kept the game won, a mate more than 6 moves slower than the best line's (reason `mate_slower`,
//   the coach's own ladder; lichess gives a slower mate no verdict), or a forced mate given up for +10 or more
//   (`lost_mate`, lichess's floor, when the winning chances lost alone would not make it weak); `mateIn` is the best
//   line's mate. The coach says it costs nothing (coach.ts `wonAnywayLine`).
export function nearBestRecheck(p): string | null; // the FEN to search for `bestAfter` when the verdict needs it, else null
/** `wonAnyway` for a move of a history record kept before the history stored it (archive.ts `decodeAnalysis`), from the
 *  White-POV evaluations kept before and after it: an inaccuracy (the only class classify gives it) from a forced mate
 *  (before) that still mates ('slower') or keeps +10 or more ('lost'); null otherwise or when one is missing. */
export function wonAnywayFromEvals(cls: MoveClass, beforeWhite: Score | null | undefined, afterWhite: Score | null | undefined, mover: Color): WonAnyway | null;
/** That FEN, and whether its search can change the class (`affectsClass`: a listed move its own search scores more than
 *  LISTED_DISPUTE_CP above its line, judged against the best move's own search); otherwise it settles only `nearBest`,
 *  `aboveBest` and `equalBest`, so the words and never the class, win chances or accuracy. Null when none is needed. */
export function secondOpinionNeed(p): { fen: string; affectsClass: boolean } | null;
// analysis/nearEqual.ts — THE definition of "about as good" (feedback, Show best, review, explorer ratings, hints)
export const NEAR_EQUAL_CP = 25;         // against the best line (a listed move's line, or a move's own search): 25 cp...
export const NEAR_EQUAL_SEARCH_CP = 30;  // ...the second opinion, two searches of their own (after each move): 30 cp...
export const NEAR_EQUAL_RECHECK_CP = 60; // ...asked when the first comparison fails by at most this...
export const NEAR_EQUAL_WIN = 0.02;      // ...or expected scores < 0.02 apart (EP_THRESHOLDS.excellent)...
export const NEAR_EQUAL_MAX_CP = 50;     // ...while at most 50 cp apart (four pawns are never "about as good")
export const NEAR_EQUAL_MAX = 3;
export function aboutEqual(a: Score, b: Score, bandCp?: number): boolean;   // mates: only the same mate
export function aboutAsGood(move: Score, best: Score, bandCp?: number): boolean; // or better (a faster mate)
export function nearEqualLines(lines: readonly PvLine[], max?: number): PvLine[];
export function isNearBest(cl, playedUci: string): boolean;                 // nearBest, and not the best move itself
/** THE "Best was X" sentence: "Best was c5.", "Best was c5 (c6 and g6 were about as good).", "Best was c5, which wins a
 *  knight." (the alternatives only without a reason: a parenthesis after it would read as part of it) */
export function bestWasSentence(bestSan: string, opts?: { reason?: string | null; alternatives?: readonly string[] }): string;
/** For a near-best move: "c5 is one of the engine’s top choices, with c6 and g6." (listed) or "Your Nxd5 was fine: c6, c5
 *  and g6 were only slightly better." ("Nxd5 was fine: …" with voice 'neutral'); null for `aboveBest` (nothing to add). */
export function nearBestSentence(cl, playedUci: string, voice?: 'you' | 'neutral'): string | null;
export function bestMoveNote(cl, playedUci: string, voice?: 'you' | 'neutral'): string | null; // near: nearBestSentence, else bestWasSentence
// analysis/types.ts (excerpt)
export interface Explanation {
  headline: string; details: string[];     // one short sentence + 0-3 more
  bestLineSan?: string[]; arrows?: Arrow[];
  title?: string;                          // e.g. "Fork", "Hanging piece", "Missed recapture"
  motifs?: string[];                       // e.g. ["fork"], ["allowsMate", "backRank"], ["missedRecapture"]
  /** Set on a Good / Excellent move (a decided position, where the expected score barely moves) whose text says
   *  what it gives away: 'material' ("This hangs your queen on b4.") or 'mate' ("This lets White mate faster.").
   *  The UI then shows a neutral verdict and no class icon (game/coach.ts `verdictTitle`), and the review lists
   *  the move as a key moment. */
  concedes?: 'material' | 'mate';
}
// analysis/see.ts, analysis/motifs.ts (excerpt)
export function see(fen: string, target: Square, side: Color, firstFrom?: Square): number; // static exchange gain, pawns
/** Pieces each side can bring to `target`: x-rays included (a rook behind a queen), absolutely pinned pieces left out. */
export function exchangeCounts(fen: string, target: Square, side: Color, firstFrom?: Square): { attackers: number; defenders: number };
/** The same position with the other side to move: the "before" baseline when a null move is illegal (in check). */
export function passTurn(fen: string): string;
//   The `freeCapture` motif carries { captured, attackers, defenders, pinned, by }, for "takes the pawn on d5 (attacked
//   twice, defended only once)", "(its defender is pinned)" or "(taking back would lose material)". A move that
//   leaves a piece the opponent just took unanswered is explained as "You didn't recapture the bishop on c6."
//   (title 'Missed recapture', motif `missedRecapture`), not as a missed tactic.
// analysis/explain.ts
export type Perspective = 'you' | 'neutral';              // "your knight" vs "White's knight"
export function explainMove(p: {
  fenBefore: string; moveUci: string; classification: Classification;
  before: AnalysisResult; after?: AnalysisResult;
  prevMove?: { to: string; captured?: string };
  perspective?: Perspective;       // default 'you'
  seen?: SeenPositions;            // the game's positions up to fenBefore: engine lines are cut at a third repetition
}): Explanation;
/** An engine line cut at the move that would repeat a position for the third time (counting `seen`, which includes `fen`):
 *  the moves up to that one, scored 0.00, `cut` set; unchanged when nothing repeats. No mate or line is described past a draw. */
export function cutAtRepetition(fen: string, line: PvLine, seen: SeenPositions): PvLine & { cut?: true };
export function explainBestMove(fen: string, line: PvLine, opts?: {
  prevMove?: { to: string; captured?: string };
  perspective?: Perspective;
  lines?: readonly PvLine[];       // all engine lines for fen (MultiPV, best first): lets a quiet move be described by
                                   // how it compares ("keeps a small edge. g3 and Bf4 are about as good.")
  compare?: boolean;               // default true; false: no ranking against the lines ("only move", "more precise
                                   // than", "about as good"), only what the move keeps (Show best for a near-best move)
  seen?: SeenPositions;            // the game's positions up to fen (hint, Show best): lines cut at a third repetition
}): Explanation;
//   The move that ends the game by the 50-move rule or with too little material says so ("Ra7 makes it 50 moves by each side
//   without a capture or a pawn move, so the game is a draw (the 50-move rule)."). A move out of check that captures nothing is
//   never credited with the material its line wins later: "Kf1 gets the king out of check, and then Qxb7 and Qxa8 win a rook and
//   a pawn." The best move is never told another was "even quicker" (its two searches may see a mate one move apart). A king
//   walking out in the opening is `kingExposed` (motifs.ts `principles`), and the king never "fights for the center".
//   "About as good" between lines is nearEqual.ts's rule (25 cp, or under 0.02 expected score up to 50 cp): the hint's
//   "g3 is about as good" now also covers 22-25 cp near equality, which was "more precise" before. Judging follow-ups
//   ("X prepares Y") and the opponent's replies, any two mates for the same side still count as equally good.
export function describeThreat(fen: string, opts?: { perspective?: Perspective }): Explanation | null; // what the side NOT to move threatens (null-move)
/** The opponent's threat in `fen` as the engine sees it (`line`: the engine's best line of `nullMoveFen(fen)`, the opponent
 *  to move again): "Pip threatens Nxf7, forking your queen and rook." — a mate ("…, checkmate", "a forced mate in 2, starting
 *  with Qh7+"), a fork, describeThreat's words when the static detection finds the same move and it wins a piece or promotes,
 *  the move's tactic, or the material the line wins. Only the opponent's move, never a defense; the arrow 'threat'. */
export function explainThreat(fen: string, line: PvLine, opts: { name: string }): Explanation | null;

// analysis/threat.ts (threat alerts; pure apart from the injected search)
export const THREAT_MIN_CP = 150, THREAT_MIN_MATERIAL = 1.5, THREAT_LINE_PLIES = 6, THREAT_DEPTH = 12, THREAT_NODES = 150_000;
export interface ThreatAlert { fen; uci; san; kind: 'mate' | 'material'; text: string; arrows: Arrow[]; squares: string[] /* the move's and its targets' */;
  best?: string /* the player's best reply as the probe found it (never shown): while the opponent's move is still being rated,
                   an alert that touches it waits (it may be the punishment of a mistake) */ }
export function threatProbeFen(fen: string): string | null;  // the null-move position; null in check or a finished game
/** Real when moving again gains the opponent a forced mate (the player not being mated anyway), or >= THREAT_MIN_CP with a line
 *  that wins >= THREAT_MIN_MATERIAL pawns of material (a piece that only escapes, a tempo or a pawn never is). */
export function judgeThreat(fen: string, now: AnalysisResult, probe: AnalysisResult, opts: { name: string }): ThreatAlert | null;
/** Both searches requested at once, right after the opponent's move and with its priority (ANALYSIS_PRIORITY.opponent),
 *  so ahead of its rating; the analysis engine runs them one after the other (THREAT_DEPTH within THREAT_NODES each,
 *  MultiPV 1: about 0.6 s on an iPhone; the alert is up that soon). Your move withdraws them, and your verdict's searches
 *  come first anyway. null = no threat, undefined = could not tell (withdrawn, failed, cut short early). Never rejects. */
export function probeThreat(fen: string, analyze: ThreatAnalyze, opts: { name: string; signal?: AbortSignal }): Promise<ThreatAlert | null | undefined>;

// rating/rating.ts
export const DEFAULT_RATING = 800; export const MIN_K = 16; export const HISTORY_LIMIT = 200;
export const STARTING_LEVELS: readonly { id: string; label: string; rating: number }[]; // Beginner 400, Casual 800, Intermediate 1200, Advanced 1600, Expert 2000
export function expectedScore(rating: number, opponent: number): number;  // 1 / (1 + 10^((opp - r) / 400))
/** Glicko-1 against a fixed-rated bot, every game weighted as an even one: RD starts at 350 and shrinks each game,
 *  K = q·RD² after the game: 350 for the first game, ~58 at game 10, ~22 at game 30, never below 16.
 *  One game moves the rating by at most K (so at most ~350 for a new rating, e.g. 800 -> 456 after losing to the 100 bot). */
export function kFactor(gamesPlayed: number): number;
/** gamesPlayed, lowered to 8 when the last 6 rated games beat or missed their expected score by >= 2.5 in total. */
export function effectiveGames(profile: PlayerProfile): number;
/** Sets the rating to a level and makes it provisional again (gamesPlayed = 0); keeps the record and history. Pure.
 *  The peak is the highest rating after a rated game: once there is one, a level never raises it (before, it is the level). */
export function setStartingRating(profile: PlayerProfile, rating: number): PlayerProfile;
export const PROVISIONAL_GAMES = 10;
export function isProvisional(profile: PlayerProfile): boolean;   // effectiveGames < PROVISIONAL_GAMES: the "New" tag, the sheet's note
/** What a rated result against `botElo` would do (the same maths as applyGameResult): the Resign and "Resign & play" previews. */
export function ratingAfterResult(profile: PlayerProfile, botElo: number, playerScore: 1 | 0.5 | 0): { before: number; after: number };
export function formatRatingDelta(delta: number): string;          // "+12", "−8", "±0" 
/** Rated: R += kFactor(effectiveGames(profile)) * (S - E), clamped to 100..3200. Resigned and Abandoned games are rated
 *  losses like any other. Unrated: rating unchanged, still in history and W/D/L. */
export function applyGameResult(profile: PlayerProfile, record: Omit<GameRecord, 'ratingBefore' | 'ratingAfter'>): { profile: PlayerProfile; record: GameRecord };
export function updateGameRecord(profile: PlayerProfile, id: string, patch: Partial<Pick<GameRecord, 'accuracy' | 'pgn' | 'reason' | 'analysis'>>): PlayerProfile;
export function loadProfile(): PlayerProfile;
/** Over the quota, the histories tried in turn (`slimmedHistories`): all; analyses kept for the 50, then the 20 newest games
 *  only (SLIM_ANALYSIS_GAMES); also PGNs for the 20 newest only (SLIM_PGN_GAMES); the 20 newest games; and those without
 *  their analyses. The moves outlive the analysis (a game without one can be analyzed again). */
export function saveProfile(p: PlayerProfile): boolean;
export function slimmedHistories(history: readonly GameRecord[]): (() => GameRecord[])[];
export function sanitizeAnalysis(v: unknown): CompactAnalysis | null; // a record's `analysis`, else null (an older record)
// GameRecord (rating/types.ts) also has, all optional (older records have none): botId (the opponent's persona id),
// preplayed (opening practice's book moves), provisional (a rated game while the rating was new, set by applyGameResult)
// and analysis: CompactAnalysis { v: 1; s: start eval; p: one token per ply; h?: the key moments' headlines by ply index;
// w?: 1, the tokens carry `wonAnyway` (absent in records kept before they did) }.
// rating/history.ts (pure; the Menu's rating chart)
export interface RatingPoint { kind: 'start' | 'level' | 'game'; rating: number; record?: GameRecord; game?: number; provisional?: boolean }
export interface RatingHistory { points: RatingPoint[]; peak: number; current: number; provisional: { from: number; to: number }[];
  min: number; max: number; games: number; complete: boolean /* the history holds every game (< HISTORY_LIMIT) */ }
/** Rated games oldest first from the rating before the first one; a level set between games (ratingBefore != the previous
 *  record's ratingAfter, unrated records included) is a 'level' point, and so is a level set after the last game; the peak
 *  is the highest game point (first reached); a game without `provisional` (older records) is new when among the first
 *  PROVISIONAL_GAMES rated games after the start of a complete history or after a level. Null before any rated game. */
export function ratingHistory(profile: PlayerProfile): RatingHistory | null;
export function pointText(h, i): string;       // "Oct 12 · Pip (100) · Won · +24", "Starting rating", "Level set to 1200"
export function historySummary(h): string;     // "Rating history: 15 rated games, from 800 to 1150, peak 1163 after game 13."
export function ratingTicks(min, max, maxTicks?): { ticks: number[]; lo: number; hi: number }; // steps of 25 … 1000
export function formatGameDate(iso, now?, locale?): string; export function recordOutcome(r): 'win' | 'draw' | 'loss'; // (also from MenuSheet)
export function resultWord(r): 'Won' | 'Lost' | 'Draw'; export function shortDate(iso, now?, locale?): string; // "Oct 12"
export function suggestedOpponentElo(profile: PlayerProfile): number; // rating rounded to 50

// game/persistence.ts
export interface SavedGame {
  version: 1; id: string; startFen: string; moves: string[]; playerColor: Color; botId: string; botElo: number; botName: string;
  assisted: boolean; startedAt: string; annotations: Record<number, Pick<Ply, 'evalWhite' | 'evalDepth' | 'classification' | 'explanation' | 'isBook' | 'punishment'>>;
  /** Set once the game has ended. A finished game stays saved (game-over state, review) until the next game starts. */
  over?: { outcome: GameOutcome; ratingChange: { before: number; after: number; rated: boolean } };
  /** The coach's "Try again" prompt after a Retry (game in progress only), also saved while a hint is open over it. */
  retry?: { san: string; cls: MoveClass; headline: string | null };
  /** Opening practice: the line the game follows (absent in a normal game and in older saves). */
  opening?: { lineId: string; mode: 'steer' | 'skip'; showLineMoves: boolean };
  /** The first `preplayed` moves were played before the game started ('skip'): book moves, never analyzed. */
  preplayed?: number;
  /** The game's "Match my rating" (a rematch after a restart re-matches only if it was); older saves: the New game default. */
  adaptive?: boolean;
  /** "Set my level" chosen during this rated game the player has moved in: applied when it ends (in progress only). */
  pendingLevel?: number;
  /** An open hint (its position): a restore shows it again on the same position (in progress only). */
  hint?: { fen: string };
  /** Play on from here (Try again): the earlier game's move it starts before ("12. Qxb2"); unrated, kept by a rematch.
   *  `after`: it starts after that move instead (the game viewer's Play here on a game's final position). */
  practice?: { from: string; after?: boolean };
}   // over.ratingChange may carry `provisional: true` (the rating was new); unknown extra fields survive sanitizing (the controller also stores `startEval`); an explanation's `concedes`
    // must be 'material' or 'mate', else it is dropped; a classification's `nearBest` must be a boolean, its
    // `aboveBest` a boolean with nearBest true, its `equalBest` a non-empty list of { san, uci, score? }, and its
    // `wonAnyway` { kind: 'slower' | 'lost', mateIn: a positive integer }, else they are dropped (older saves have
    // none); a `punishment` must be { uci, san, reason: string | null }, else it is dropped
export function saveGame(g: SavedGame): boolean; export function loadGame(): SavedGame | null; export function clearGame(): void;
export function saveSettings(s: GameSettings): void; export function loadSettings(): GameSettings;
export function requestPersistentStorage(): Promise<boolean>;
// game/coach.ts
export function offersShowBest(cl: Pick<Classification, 'cls' | 'bestMoveUci'>, playedUci: string): boolean; // not a top class, or a Brilliant that isn't the top move
export const RETRY_CLASSES: ReadonlySet<MoveClass>;  // mistake, miss, blunder
export function answerFreeLines(e: Explanation | undefined | null, cl: Classification): string[]; // text that does not give the better move (or one of
                                                     // `equalBest`) away (while Retry is offered)
/** The collapsed coach row's line for such a move (store and viewer `summary`, CoachPanel `summary`): "Still winning: a
 *  faster mate was available." ("Pip was still winning: …"; "…: the missed mate hardly matters." for a mate given up). */
export function wonAnywaySummary(won: WonAnyway | null | undefined, who: 'you' | string): string | null;
/** "A faster mate was available (Qh7+, mate in 3), but you were winning anyway." / "Pip had a faster mate (Qh2#), but was
 *  winning anyway." (the move only with `reveal`), or for a mate given up "You were winning anyway, so the missed mate
 *  hardly matters."; null without `won`. Added after the explanation (store `explanationLines`' `won`). */
export function wonAnywayLine(cl, won: WonAnyway | null | undefined, o: { who: 'you' | string; reveal: boolean }): string | null;
/** Show best's title: "Top choices" ("Top choice") when the played move was about as good (isNearBest), "Slightly
 *  better: c6" for an Excellent or Good move that was not (no `concedes`; not for older saves), else "Best was c6". */
export function showBestTitle(ply, bestSan: string | null): string;
/** Show best's first lines for a near-best move: "c6 +0.6 · c5 +0.7 · g6 +0.7" (equalBest, eval-bar convention) and the
 *  played move from its own side: "Your Nxd5: +0.9, close behind." ("…, at least as good." for aboveBest) / "Pip’s
 *  Nxd5: …" / "Your c5 is one of them."; [] otherwise. */
export function nearBestShowLines(ply, owner: string): string[];
/** mentionsMove, except that a pawn move written as a square ("d4") does not count after "on", "to", "the" … */
export function namesMove(text: string, san: string): boolean;
export function mentionsMove(text: string, san: string): boolean;
export function classSentence(san: string, cls: MoveClass): string; // "3. Qxf7+ is a blunder"
export function moveLabel(ply: Pick<Ply, 'fenBefore' | 'san' | 'color' | 'index'>): string; // "12. Nf3" / "12… Nf6"
export const KEY_CLASSES: ReadonlySet<MoveClass>;    // brilliant, great, mistake, miss, blunder (graph markers, key moments)
/** Explanation.concedes, unless the class already says the move was weak (inaccuracy and worse). */
export function concession(ply: Pick<Ply, 'classification' | 'explanation'>): 'material' | 'mate' | null;
/** The coach title and icon: "12. Nf3 is a mistake" + cls; for a concession a neutral title and no icon:
 *  "10… Kd8 doesn’t change the result" (already lost, or 'mate'), "… still wins, but gives up material", "… gives up material". */
export function verdictTitle(ply: Pick<Ply, 'fenBefore' | 'san' | 'color' | 'index' | 'classification' | 'explanation'>): { title: string; cls?: MoveClass };
/** The idle tip after the opponent's capture when a legal recapture on that square holds its own (analysis/see.ts
 *  `see` >= 0): "Rocco just took your bishop on c1. Can you recapture?"; else null (then `coachTip`; the in-check tip first). */
export function recaptureTip(fen: string, last: Pick<Ply, 'uci' | 'color' | 'captured'> | null | undefined, opponent: string): string | null;
/** A move that repeats the position for the third time, or (`allows`) lets the opponent do it: "4. Qd7+ lets Pip repeat the
 *  position for the third time, which ends the game in a draw." `neutral` (the explorer, a move tried for the computer's side):
 *  said by color ("Black was winning, so this draw gives the win away."), never as the computer's. */
export function repetitionExplanation(san: string, cl: Classification, opts: { human: boolean; botName: string; neutral?: boolean; mover?: Color; allows?: boolean }): Explanation;
/** A draw rule in plain words for the finished game ("Stalemate: the side to move has no legal move and is not in check, so the
 *  game is a draw."; threefold, insufficient material, 50-move rule), else null. */
export function drawRuleText(reason: string): string | null;
/** "Can you punish it?" (rateOpponent): the opponent's classes that ask (mistake, miss, blunder: RETRY_CLASSES), the question
 *  ("Pip blundered — can you punish it?", "… made a mistake …", "… missed its chance …"), "Show me"'s line ("Punish it with Nxh4,
 *  which wins the queen."), the answer after a move that was not it ("The punishment was Nxh4, which wins the queen."),
 *  PUNISHED_LINE "You punished it!" and PUNISH_MISSED_LINE "You missed the punishment." (Retry offered, or Show best locked). */
export const PUNISH_CLASSES: ReadonlySet<MoveClass>; export const PUNISHED_LINE: string; export const PUNISH_MISSED_LINE: string;
export function punishPrompt(name: string, cls: MoveClass): string;
export function punishWithLine(p: Pick<Punishment, 'san' | 'reason'>): string;
export function punishmentWasLine(san: string, reason: string | null): string;
/** `Ply.punishment` from the analysis of the position after the weak move: its best move and explainBestMove's words for it. */
export function punishmentOf(fen: string, lines: readonly PvLine[], opts?: { prevMove?; seen? }): Punishment | null;
// game/practice.ts (pure: no engine, DOM or signals; the controller keeps one in store.practice)
export const TRY_AGAIN_CLASSES: ReadonlySet<MoveClass>;  // inaccuracy, mistake, miss, blunder
export const SOLVED_CLASSES: ReadonlySet<MoveClass>;     // brilliant … forced: an attempt with one (giving nothing away) is better
export interface PracticeGame { id; startFen; playerColor; bot: BotPersona; botElo; plies: readonly Ply[]; startEval?; preplayed?;
  source: 'current' | 'archive' }                        // any game's annotated plies: the one on the board, or one from the history
export interface Practice { game; index /* the ply tried again */; status: 'waiting' | 'checking' | 'wrong' | 'solved' | 'revealed';
  attempt /* on the board */; tried /* the last one taken back */; tries; hint: 0 | 1 | 2; answer?: PracticeAnswer | null; failed; session }
/** The player's key moments (review.ts `summarizeGame`, preplayed moves left out) that were an inaccuracy or worse, in game order. */
export function practiceMoments(game): number[]; export function canTryAgain(game, index): boolean; export function nextMoment(game, index): number | null;
export function startPractice(game, index, session): Practice; export function practiceFen(p): string; export function awaitsMove(p): boolean;
/** A move on the board ('checking'); the game's own move is 'wrong' at once (`same`); null when illegal or none is awaited. */
export function playAttempt(p, from, to, promotion?): Practice | null;
/** Better: the engine's best move, `nearBest` (nearEqual.ts), or a SOLVED_CLASSES move without a concession; never the game's move. */
export function isSolution(rating, uci, playedUci): boolean;
export function judgeAttempt(p, rating): Practice;  // 'solved', or 'wrong' with the attempt taken back
export function attemptFailed(p): Practice; export function moreHint(p): Practice; export function revealAnswer(p): Practice;
export function answerMove(ply, lines): string | null;  // the engine's best move that is not the game's, else the saved best move
export function hintText(fen, uci, level: 1 | 2): string; // "Move a knight." / "Move your queen." -> "Move the knight on g1."
// wording: practiceTitle ("Find a better move than Qxb2"), playedLine ("In the game you played 12. Qxb2, a blunder."), triedLine
// ("Qd3 is a blunder.", SAME_MOVE_LINE), solvedLine (FOUND_BEST_LINE, FOUND_NEAR_LINE, "That’s better than Qxb2."), NOT_QUITE, lastMomentLine
// game/archive.ts (pure: earlier games from the history)
/** A ply's token in GameRecord.analysis.p: class letter (B G s e g k f i m x b; '-' not analyzed), the White-POV eval after
 *  it ("34", "-120", "#3", "#-2", "#0"), flags (n near-best, a above-best, c / d concedes material / mate), `wonAnyway`
 *  (w slower / l lost, with the best line's mate) and ":" with the engine's better move: "s34", "e-12:g1f3",
 *  "bn#-3:d1h5", "i#9w1:e1e8". Win chances, accuracy and the better move's SAN are derived; for a record without
 *  `CompactAnalysis.w` (kept before the tokens carried it), `wonAnyway` is derived from the evaluations kept. */
export function encodeAnalysis(plies, startEval, opts: { playerColor; preplayed? }): CompactAnalysis; // + the key moments' headlines
export function decodeAnalysis(plies, analysis): { plies: Ply[]; startEval: Score | null }; // a malformed token, or a count
                                                     // that does not match the moves, leaves the plies unanalyzed
export function analysisComplete(plies, preplayed?): boolean; export function sameAnalysis(a, b): boolean;
export function encodeScore(s): string; export function decodeScore(text): Score | null;
export function pgnPlies(pgn: string): { startFen; plies: Ply[]; headers } | null; // the moves ([FEN] start too); null without
export interface ArchivedGame { startFen: string; plies: Ply[]; startEval: Score | null; headers: Record<string, string> }
export function archivedGame(record: GameRecord): ArchivedGame | null;   // pgnPlies + decodeAnalysis
export function recordBot(record): BotPersona;       // by botId, else by name among BOTS, else customPersona(botElo)
export function archivePgn(record, game): string;    // its tags with [%eval] and marks when analyzed, else the stored PGN
// game/viewer.ts (pure: the game viewer; the controller keeps one in store.viewer, `controller.viewerView` renders it)
export interface GameViewer { id; record; game: ArchivedGame | null /* no moves kept */; bot; preplayed; cursor; flipped;
  review: { progress: number | null; failed: number } | null; report: boolean; session; from: 'menu' | null;
  draw: { on; tip }; drawings;
  brief: ReadonlySet<number> /* moves whose comment is only the record's (verdict, a key moment's headline) */;
  explaining: number | null /* the move whose comment is being written again */ }
export function openViewer(o): GameViewer;  // at the final position; `full` (the game on the board): nothing brief
export function briefPlyShown(v): Ply | null; export function withAnalyzedPly(v, index, patch): GameViewer;
export function viewerNotice(ctx): string | null; // what waits while a (rated) game is on the board
export function viewerGoTo(v, n): GameViewer; export function viewerFen(v): string; export function viewerAnalyzed(v): boolean;
export function viewerPracticeGame(v): PracticeGame | null; // source 'archive' (Try again's Back returns to the viewer)
export function viewerSummary(v): ReviewSummary | null;
export function viewerView(v, ctx: { locked; drawColor; ratedGame?; gameInProgress?; revealed? }): ViewerView;
  // header (title without the Elo, facts, rating; the accuracy the report's once complete), board, eval bar, graph, move
  // list, strips, report, coach (comment), toolbar, draw. `ratedGame`: no better moves, arrows, analysis or Try again;
  // `revealed` (store.revealedTries): a move to try again shows its better move only once shown.
// game/explorer.ts (pure: no engine, DOM or signals; the controller keeps one in store.explorer)
export interface ExplorerRating { classification; explanation; evalWhite: Score; evalDepth: number; isBook: boolean }
export interface ExplorerMove { uci; san; color; fenBefore; fenAfter; captured?; rating?: ExplorerRating; failed?: true }
export interface ExplorerBase { baseFen: string; baseIndex: number /* game plies on the board */; fromLive: boolean; gamePlies: number /* game length then */ }
export interface Explorer extends ExplorerBase {
  moves: readonly ExplorerMove[]; cursor: number /* explored moves on the board */;
  session?: number;  // one opening of the explorer (the board's `session`, see Board)
}
export function startExplorer(o: ExplorerBase & { session? }): Explorer;
/** 'Insufficient material' | 'Threefold repetition' (counting the game's positions up to the base) | '50-move rule'
 *  for the explorer's position, else null (checkmate and stalemate are `positionInfo`'s). */
export function drawReason(x, startFen, gamePlies): DrawReason | null;
export function explorerFen(x): string; export function currentMove(x): ExplorerMove | null;
/** Either side's move (a pawn on the last rank without `promotion` becomes a queen); null if illegal. The move that
 *  already follows in the line keeps the line (and its ratings); another one replaces the rest. */
export function playMove(x, from, to, promotion?): Explorer | null;
export function back(x): Explorer; export function forward(x): Explorer; export function goTo(x, n): Explorer;
export function reset(x): Explorer;           // back to the base position with the line cleared (Forward has nothing after it)
export function legalDests(fen): Map<string, string[]>;
export function movePath(x, index): string;   // the UCI line up to move `index`: a late rating must still match it
export function setRating(x, index, path, r: { rating } | { failed: true }): Explorer; export function clearFailed(x): Explorer;
// game/store.ts
export function explanationLines(e: Explanation | undefined | null, bestSan?: string | null, move?: { cl: Classification; playedUci: string; voice?: 'you' | 'neutral' }): string[];
// adds a note on X unless a line already names it: "Best was X." (with `move`: its alternatives, or for a near-best
// move "Your Nxd5 was fine: X was only slightly better.", nothing for `aboveBest`; nearEqual.ts `bestMoveNote`)
// game/sound.ts
export type SoundKind = 'move' | 'capture' | 'check' | 'castle' | 'promote' | 'gameStart' | 'gameEnd' | 'illegal' | 'notify';
export function unlockAudio(): void; export function setSoundEnabled(on: boolean): void; export function playSound(kind: SoundKind): void;
// pwa.ts / ios.ts
/** onOfflineReady: once per page load, when the app is known to be cached for offline use (at startup when it already
 *  was, else when the first install completes). A lazy chunk that fails to load (`vite:preloadError`) while an update
 *  waits reloads at once, even on a touched page, but only when canReloadNow() allows it. */
export function registerServiceWorker(opts: { canReloadNow: () => boolean; onOfflineReady?: () => void }): void;
/** How main.tsx reports offline readiness to App: 'cached' (the page was controlled at startup) or 'installed'
 *  (the first download finished during this visit: App shows an "Available offline" toast once). */
export type OfflineStatus = 'cached' | 'installed';
/** Registers again when the registration is missing (a failed first install deletes it), else looks for updates; retries a failed first install with a backoff. */
export function createRegistrationKeeper(opts: { scope: string; getRegistration: () => Promise<KeeperRegistration | undefined>; register: () => Promise<KeeperRegistration | undefined>; onReady?: () => void; online?: () => boolean }): { start(): Promise<void>; check(force?: boolean): Promise<void> };
/** Reloads onto a new build only when canReloadNow() and the page is hidden or untouched since it was loaded or shown. */
export function createReloadGate(canReloadNow: () => boolean, reload: () => void, opts?: { pollMs?: number; page?: ReloadGatePage }): ReloadGate;
/** gesturestart/double-tap zoom guards; onFirstGesture runs inside the first tap (unlockAudio). Returns an uninstaller. */
export function installIosGuards(opts?: { onFirstGesture?: () => void | boolean; persistStorage?: boolean | 'auto' }): () => void;
// theme.ts
export type ThemePref = 'dark' | 'light' | 'system';
export function loadTheme(): ThemePref; export function saveTheme(t: ThemePref): void;
export function applyTheme(t: ThemePref): 'dark' | 'light';          // sets <html data-theme>
export function watchSystemTheme(get: () => ThemePref): () => void;  // re-applies when iOS switches appearance
```

## Scores & probabilities

- Engine scores are **side-to-move POV**. Positions are stored in plies as **White POV** (`Ply.evalWhite`).
- Win probability (lichess): `win = 1 / (1 + exp(-0.00368208 * cp))` in 0..1 for the side to move.
  Mate scores map to 1 / 0.
- Eval bar: White's share = White-POV win probability.

## UI component contracts (props)

All are Preact function components in `src/ui/`, each with a co-located `.css` file.
`Key` means a square name like `"e4"`.

### Board.tsx
```ts
interface BoardProps {
  fen: string;
  orientation: 'white' | 'black';
  /** Color the user may move, or undefined when the board is read-only (bot thinking, game over, review). */
  movableColor?: 'white' | 'black';
  /** Legal destinations for the side to move (from chess.js). */
  dests: Map<string, string[]>;
  lastMove?: [string, string];
  /** Highlight the side-to-move king as in check. */
  check?: boolean;
  arrows?: Arrow[];                          // from analysis/types.ts
  badge?: { square: string; cls: MoveClass }; // classification icon at a square (like chess.com); none for a concession
  extraBadges?: { square: string; cls: MoveClass }[]; // more icons without the last-move tint (your move's, while the
                                             // opponent's rated reply has `badge`)
  session?: string;                          // 'game' or 'explorer:<n>': a change drops a selected piece, a drag or an
                                             // open promotion picker, even on the same position (never finishes in the other)
  shapes?: readonly UserShape[];             // the player's drawings on this position (game/drawings.ts), under the engine's arrows
  drawColor?: DrawColor | null;              // Draw mode in this color (null: off): touches draw instead of moving pieces
  onDraw?: (shape: UserShape) => void;       // a finished drawing (the parent toggles it in or out of `shapes`)
  /** A user move. Accept it by passing the new `fen` in the same task (e.g. synchronously from a store
   *  update); if `fen` is unchanged shortly afterwards, the board snaps back. Pawn moves to the last
   *  rank first show the promotion picker. */
  onMove: (from: string, to: string, promotion?: PromotionPiece) => void;
}
```
The component owns the chessground instance, updates it on prop changes (without re-creating it),
fills its container as a square, and includes the promotion picker overlay.

**Draw mode** (`drawColor` + `onDraw`). Chessground's own drawing needs a right mouse button or a
modifier key, so the Board draws by touch itself: a layer (`DrawLayer`, `.board-draw`, z-index over
the pieces, under the promotion picker) covers the board and takes every pointer, so chessground sees
no touch and moves nothing; its move settings are never changed, so leaving Draw mode restores moving
exactly (entering it drops a selected piece, a drag or an open promotion picker). The layer has
`touch-action: none` (no scrolling, no double-tap zoom) and an inner frame in the color drawn with.
`ui/draw.ts` (pure, tested) maps a pointer to a square for either orientation and any board size
(`squareAt`, from chessground's own bounds) and turns a gesture into a shape: down on a square starts it;
moving less than a quarter square (`dragThreshold`, at least 8 px) is still a tap, which draws a circle
on the square it went down on; a drag draws an arrow to the square under the finger, and nothing when it
ends on its start square or off the board (`gestureShape`, `endGesture`). The shape being drawn is
chessground's "current" drawing (`state.drawable.current`, lighter while dragging; an existing shape it
would take off is dimmed), so it renders with the user shapes and the engine's auto shapes. A second
finger cancels the gesture until every finger is up (each pointer is captured, so its end is always
seen); a new position, side or session cancels it too: the layer notes the board (orientation, session
and FEN) at pointerdown and draws nothing on a move or pointerup when it has changed (a layout effect
also drops the preview with the render that changed it), and `onDraw(shape, fen)` passes the FEN the
gesture was drawn on, which the controller checks against its board (`drawShape`). The user shapes go to
chessground as `drawable.shapes` with the brushes `green`, `red`, `blue`, `orange` (the `--draw-*`
colors, nearly opaque; brush keys `draw-<color>`), apart from the engine's (`best`, `alt`, `threat`,
`played`, `line`). Board.css dashes their arrows (`line[marker-end^='url(#arrowhead-draw-']`,
`stroke-dasharray` in square units), a look the engine's solid arrows never have, so a drawn idea
never passes for the engine's best move.

### ClassIcon.tsx
`ClassIcon({ cls, size?, title? })` renders a round badge with a symbol (`!!`, `!`, `★`, `👍`, `✓`, `📖`, `□`, `?!`, `?`, `✕`, `??`).
It also exports `CLASS_META: Record<MoveClass, { label; symbol; color /* css var */; hex; description }>`
(the descriptions are the legend / tooltip text) and `classBadgeSvg(cls): string`, an SVG string used by Board for on-square badges.

### EvalBar.tsx
```ts
interface EvalBarProps {
  whiteWinProb: number;        // 0..1
  label: string;               // e.g. "+1.3", "M3", "-M2", "0.0"
  orientation: 'white' | 'black'; // white at the bottom when 'white'
  thinking?: boolean;          // subtle pulse while the live analysis is shallow (depth < 12) and still running
  off?: boolean;               // the explorer with its engine off: a neutral bar reading "Engine off" (role img), no evaluation
  offLabel?: string;           // its words (default "Engine off"; the game viewer's unanalyzed game: "Not analyzed")
}
```
It is a vertical bar, 18 px wide, with the same height as the board, and animates smoothly on
change. The number (11 px; 9 px with three or more digits or letters, e.g. "M10") is drawn without its
sign at the end of the side that is ahead; values of 10 or more are rounded to whole numbers. The
store keeps the last number (pulsing) while a new position is analyzed.

### EvalGraph.tsx
```ts
interface EvalGraphProps {
  /** points[i] = White win probability after i plies (points[0] = start position); null = unknown yet. */
  points: (number | null)[];
  /** Index into points currently shown on the board. */
  current: number;
  markers?: { index: number; cls: MoveClass }[]; // colored dots for mistakes/blunders/brilliants
  onSelect?: (index: number) => void;           // tap/scrub to jump
  height?: number;                              // default 56 (the app uses 32)
  minSpan?: number;                             // the x axis spans at least this many plies (live game: 40)
}
```

### MoveList.tsx
```ts
interface MoveListProps {
  plies: Ply[];
  /** Number of plies currently applied on the board (plies.length when live). */
  current: number;
  onSelect: (current: number) => void;
  showClassIcons: boolean;
  iconSet?: 'notable' | 'all';  // default 'notable' (brilliant, great, inaccuracy, mistake, miss, blunder); 'all' in review
  lead?: string;                // a chip before the moves (the explorer's "From 15… Nf6"): current at 0, selects 0
  emptyText?: string;           // default "No moves yet"
}
```
A horizontally scrolling list of move numbers and SAN, with small class icons. It keeps the current move in view,
also when the set of moves with an icon changes (a review starting), and when the row's own width changes (a
`ResizeObserver`: rotating the phone, a resized window); a mere re-annotation does not move a row the user has
swiped. The store strips the class from the plies it passes where it must not show: during play your moves
with the coach off and the bot's moves unless they are rated (`rateOpponent`), and concessions (which get no
badge on the board either).

### CoachPanel.tsx
```ts
interface CoachPanelProps {
  cls?: MoveClass;            // shows ClassIcon + colored title when present (not for a concession)
  title: string;              // e.g. "3. Qxf7+ is a blunder" / "Your move" / "Hint"
  titleMove?: string;         // the move part of such a title ("3. Qxf7+"): a one-line row cuts it before the verdict
  lines: string[];            // explanation sentences
  busy?: boolean;             // analyzing spinner
  actions?: { id: string; label: string; onClick: () => void; primary?: boolean; locked?: boolean }[]; // locked: a Pro lock badge
                              // id 'opening' is opening practice's banner (OpeningBanner) at the top of the bubble, not a
                              // button: label "<name>\t<status>\t<tone>" ("Italian Game\tMove 3 of 5\ton"), tap = open the line
  collapsed?: boolean;        // one-row summary
  onToggleCollapsed?: () => void;
  /** Your move and the opponent's are both rated (`rateOpponent` + coach): the other one as a compact row
   *  ("You ★ 12. Nf3 Best") above ('before', yours) or below ('after', the opponent's) the expanded one, so the
   *  two keep their order; tapping it expands it. Collapsed, both show as one row of two halves ("You ★ Best |
   *  Pip ? Mistake"), each a button. */
  other?: { who: string; move: string; verdict: string; cls?: MoveClass; busy?: boolean; place: 'before' | 'after'; onSelect: () => void };
  who?: string; verdict?: string;  // with `other`: whose move the expanded one is and its short verdict (the halves)
  alert?: string;             // threat alerts: a warning at the top of the bubble (`.coach-alert`, role status, ⚠ in the
                              // danger color); collapsed, the one row leads with it (no title or badge) and the avatar becomes ⚠
}
```

### PlayerStrip.tsx
```ts
interface PlayerStripProps {
  name: string;
  rating?: number;
  emoji: string;
  avatarColor?: string;
  captured: string[];         // piece letters this player has captured (e.g. ['q','p','p'])
  capturedColor: 'w' | 'b';   // color of the captured pieces (to draw the right glyphs)
  materialDiff: number;       // show "+N" when > 0
  active: boolean;            // side to move
  thinking?: boolean;         // bot thinking indicator
  unrated?: boolean;          // "Unrated" pill: takebacks, hints, Retry, the explorer's engine, arrows or opponent ratings were used
}
```

### Toolbar.tsx + icons.tsx
`Toolbar({ items: { id, label, icon: preact.ComponentChild, onClick, disabled?, active? }[], label? })` is the bottom bar with 44px+ tap targets.
`icons.tsx` exports simple inline SVG icons: `IconPlus, IconUndo, IconBulb, IconFlip, IconCoach, IconMenu, IconChart, IconClose, IconChevronLeft, IconChevronRight, IconShare, IconFlag, IconEye, IconSound, IconCpu, IconGauge, IconCheckCircle, IconExplore` (a branching line), `IconReset`, `IconPencil` (Draw), `IconTrash` (the Draw bar's Clear).
`Toggle({ label, description?, checked, onChange, disabled?, icon?, iconColor?, id? })` is the switch row used by the sheets.

### Sheet.tsx (base) and sheets
`Sheet({ open, onClose, title, children, footer?, hideTitle?, class? })` is a bottom sheet with backdrop, safe-area padding, and swipe/tap-outside/Escape to close (with `hideTitle`, the X floats over the top of the body, above its content, as on the game-over sheet). Closing gives the focus back to where it was, unless another layer has taken it meanwhile (the game-over sheet a resignation from the Menu opens) (Escape closes only the sheet opened last, e.g. the paywall over the Menu, through a module-level stack of open sheets). `useEscapeLayer(active, onEscape)` puts any overlay on that stack (the Openings section uses it: Escape goes back a page, under a sheet or the paywall opened over it) and returns `isTop()`. `hasOpenLayer()` says whether any layer is open: the App's own ← → and Escape (Draw mode, the explorer) stand down meanwhile, so Escape with the paywall over the explorer closes the paywall, not the explorer under it.
- `NewGameSheet({ open, initial: GameSettings, playerRating: number, bots: BotPersona[], onStart(settings), onClose, inProgress?, newPlayer?, levels?, onSetLevel? })`:
  bot picker grid, custom Elo slider 100..3200 (step 50), color choice (white / random / black), toggles (coach, eval bar,
  best-move arrows, rate opponent's moves, takebacks, sound), and "Match my rating" (adaptive). The note under the
  options (`unratedNote`) lists what makes a game unrated, or says that this one will be (arrows or opponent ratings on).
  - `inProgress: { rated } | null`: a game the player has moved in is still going. The sheet warns that it ends as a loss
    (rated unless already unrated) and the button reads "Resign & play".
  - `newPlayer` with `levels` + `onSetLevel`: a "Your level" LevelPicker at the top sets the starting rating before the first game.
    Picking a level also switches the opponent to "Match my rating", unless the player already picked a bot, the slider or
    the toggle in the sheet.
  - `arrowsLocked?: string | null` + `onUnlock?`: best-move arrows are part of Pro and locked; the toggle shows the line and a
    lock, stays off, and calls `onUnlock` (the paywall). `threatsLocked?` + `onUnlockThreats?`: the same for threat alerts
    (their toggle, `THREAT_ALERTS_DESCRIPTION` "Warns you when your opponent threatens something", sits between best-move
    arrows and rate opponent's moves, here and in the Menu; `unratedNote` names them too and says the game is unrated. In the
    Menu the help that makes games unrated reads alike: `ASSIST_MENU_DESCRIPTION` "Makes your games unrated while it’s on"
    for best-move arrows and rate opponent's moves, `THREAT_ALERTS_MENU_DESCRIPTION` "Warns you of threats, and makes your
    games unrated while it’s on").
  - `onLearnOpenings?`: a "Learn openings" row under the color choice (opens the Openings section).
- `LevelPicker({ levels, value: number | null, onChange(rating), labelledBy?, id? })`: five-way segmented control over
  `STARTING_LEVELS` with a caption describing the selected level (`LEVEL_BLURB`).
- `MenuSheet({ open, settings, profile, canResign, onChange(partial), onResign, onExportPgn, onFlip, onNewGame, onClose, bots?, theme?, onThemeChange?, engine?, onRetryDualEngines?, selfTestHref?, offlineReady?, levels?, onSetLevel? })`:
  action tiles (flip, export, new game, resign with an inline confirmation), in-game toggles (coach, eval bar, best-move
  arrows, rate opponent's moves, sound), the Appearance picker
  (with `theme` + `onThemeChange`), profile stats with "Set my level" (LevelPicker + confirmation, with `levels` + `onSetLevel`),
  recent games, the Engine section and About. Its callbacks do not close the sheet; App does.
  - `onOpenings?`: an "Openings" row under the action tiles (the Openings section opens over the Menu, which stays open
    under it).
  - `levelAfterGame?`, `pendingLevel?`: during a rated game the player has moved in, Set my level's note says the game still
    counts at the current rating and the confirm button reads "1200 after this game"; a waiting level shows under the rating.
    `provisional?`: a "New" tag beside the rating and a line that new ratings move fast. `resign?: { rated; before?; after? }`:
    the Resign confirmation says what the loss does (`resignNote`: "It counts as a loss: your rating goes from 904 to 834 (−70).").
  - `pro?: { name; unlocked; pending?; restoring?; threatsLocked? }` + `onUnlock?(feature?)` + `onRestore?` + `arrowsLocked?`: where Pro is
    sold, a Pro section (Unlock, or "Unlocked ✓" / "Waiting for approval") with Restore Purchases; locked best-move
    arrows open the paywall.
  - `foldable?: { value: FoldSetting; onChange; postureReported }`: a "Foldable screen" section under Appearance (a radio
    group of rows with a check mark: Automatic, Keep the board off the fold, Use the whole screen; `foldNote()` under it,
    which says to pick Keep the board off the fold for a half-folded screen where the browser doesn't report the posture).
    App passes it where the setting can act, a fold reported or assumed (`FoldInfo.offered`), so a stored choice never
    acts where the Menu can't change it.
  - `onOpenGame?(id)`: the Recent games rows are buttons (`data-id="recent-game"`, a chevron) and the stats card ends with the
    rating chart (`RatingChart`), whose games open too: App passes `controller.openGame(id, { from: 'menu' })`.
  - `engine: { mode: 'dual' | 'single' | null; singleUntil?: number | null }`: a "Stockfish 19" row reading "2 workers" or
    "1 worker (compatibility mode, until Oct 14)"; in single mode a "Try two engines again" row (`onRetryDualEngines`) and a
    note; with `offlineReady` an "Available offline" row; always a "Run engine self-test" link (`selfTestHref`, default
    `?enginetest`).
- `GameOverSheet({ open, outcome: GameOutcome, playerColor, botName, ratingChange?: { before: number; after: number; rated: boolean }, onReview, onRematch, onNewGame, onClose, botEmoji?, botColor?, botElo?, practice?, practiceLabel?, play?, rule?, provisional? })`
  (`practice`: opening practice's line, "Opening practice: Italian Game"; `practiceLabel`: Play on from here's "Practice from
  move 12"; either replaces "Unrated game").
  `practice` (opening practice, the line's name) replaces "Unrated game" with "Opening practice: Italian Game". `play`
  (`{ accuracy: { you, bot }, counts: { blunder, mistake, miss, inaccuracy }, note? }`, or 'pending' while the last moves are
  checked: "Checking your moves…") shows "Accuracy: You 91% · Bao 76%" and "You: 2 mistakes, 1 blunder" (`weakMovesText`),
  and `note` (review.ts `alreadyWonSheetNote`, the short form: "7 of them came when you were already winning, so they
  didn’t lower your accuracy.") under them when some of the player's weak moves came when they were already winning;
  its Try again button counts `store.sheetTries` (`tryAgainMoments` without those moves, `weakInWonGame`; none: no
  button);
  `rule` (coach.ts `drawRuleText`) a draw rule in plain words under the reason; `provisional` a note under the rating change
  that new ratings move fast.
  White is on the left and Black on the right (each labeled with its color), with the result between them as chess
  players write it, from White's side: `gameOverScore(outcome)` gives "1–0" / "0–1" / "½–½" and "White won" /
  "Black won" / "Draw" (a per-player "You 0 – 1 Robot" read as a Black win after a win as Black).
- `ConfirmSheet({ open, title, message, confirmLabel, cancelLabel?, onConfirm, onClose })`: a small confirmation sheet.
  `assistPrompt(kind: 'hint' | 'undo' | 'retry' | 'exploreEngine' | 'rateOpponent' | 'threatAlerts')` gives its wording for "this makes
  the game unrated" ('exploreEngine', the explorer's Engine switch: "Turn on the engine?" / "The engine’s evaluation, best
  moves and move ratings will show while you explore. Turning it on makes this game unrated: win or lose, your rating
  stays the same. Switching it off again won’t undo that." with "Turn on" and `cancelLabel` "Keep off"; every kind
  uses the shared `UNRATED` wording; 'rateOpponent' and 'threatAlerts' ("Turn on threat alerts?") add that it stays on for the
  next games until switched off, as the setting is saved). Opening the explorer asks nothing: only its engine is help.
- `About()` (in the Menu): the GPL notice with the no-warranty line, the Source code link (`SOURCE_URL` =
  `VITE_SOURCE_URL` or `https://github.com/atg-y2k/chess`; the exact commit or build tag in the App Store app), where Pro
  is sold (`SHOW_LEGAL_LINKS`) the Privacy Policy, Terms of Use and Support links (`LEGAL_URLS`, so they stay reachable
  once Pro is unlocked), the app's name and version,
  credits with the BSD and MIT texts, and the GPL text, `THIRD-PARTY-LICENSES.txt` and `engine/README.md` (under
  `BASE_URL`). Those three keep real hrefs, but a tap opens them in `LicenseSheet({ doc, onClose })`, an in-app viewer
  rendered into `document.body` (a new-window link to the app's own files would do nothing in the App Store app).
  `LegalFooter()` is the one-line version on the self-test page.
- `PaywallSheet({ open, feature, price, unavailable?, status, onBuy, onRestore, onClose, features? })`: the Pro paywall
  (see "Entitlements and the paywall"). It also exports `IconLock` and `LockedIcon` (the toolbar's locked Hint).
- `SelfTestPage({ run?, copy? })`: the `?enginetest` page (live log, PASS / FAIL, Copy log, Run again).

### RatingChart.tsx
`RatingChart({ profile, onOpenGame? })`, in the Menu's stats card (rating/history.ts `ratingHistory`; dataviz rules: one
series, so no legend box; thin line, hairline gridlines, selective labels, text in text tokens). An inline SVG measured to its
width (ResizeObserver), 148 px tall: the rating axis (`ratingTicks`) with hairlines, the first and last game's dates, the
new-rating runs as a neutral band ("New rating" when it fits, and a key under the chart), the line in `--chart-line` (the
accent; `--link` in the light theme, >= 3:1 on the card), a level's jump as a thin faint step, a hollow start dot, the peak
("Peak 1163") and the current rating marked and labeled (the current one moves under its dot when the two labels would
meet). Tap or drag (touch-action pan-y; `data-sheet-nodrag`, so the Menu does not drag) picks the nearest point: a crosshair
(stopping short of the peak's or the current rating's label when it is on that point) and the readout above the plot (its rating and change, "Oct 12 · Pip (100) · Lost", **View game**); a second tap on the
picked point opens it. The plot is a `role="slider"` (← → Home End, Enter opens; `aria-valuetext` = the readout), the
figure has a hidden caption (`historySummary`), and **Show as a table** (a `<details>`) lists every rated game newest
first with a button per game (44 px tap targets, as its summary). No rated game: "Your rating chart starts after your first rated game."

### GameViewer.tsx
`GameViewer({ view: ViewerView, closing?, onBack, onExport, onFlip, onStep(delta), onGoTo(plies), onReview, onShowReport(on),
onPlayHere, onAction(id), onTryAgain(index), onUnlock, onToggleDraw, onExitDraw, onDrawShape(shape, fen), onClearDrawings,
onDrawColor })`: the game screen's grid (`.app.viewer-app`, App.css's areas plus `head`: on top in portrait, its height
counted among the rows that size the board; at the top of the side column in landscape). The header: ‹ (Back), the result
word in its color and the opponent ("Lost to Pip": the Elo is on its strip; two lines in a narrow header rather than a cut
name), the facts (date · how it ended · accuracy · "Practice from move
12"), the rating badge as Recent games show it ("−28" over "1109", or "Unrated") and Export (share). Then the strips, the
eval bar and the read-only board (a horizontal swipe of 36 px steps a move, not in Draw mode; a link-colored frame), Draw
mode on the strip under it (DrawToggle / DrawBar), the panel (CoachPanel with the comment, one row under 104 px with a tap
to float it; or ReviewPanel, floating over the board under 300 px), the eval graph and move list (tap to jump) and the
toolbar: Flip, Prev, Next, Review / Report (pressed while the report shows), Play here (off for a game without moves
and while a game the player has moved in is on).

### ExplorerPanel.tsx
```ts
interface ExplorerPanelProps {
  from: string | null;        // the game's move before the starting position ("15… Nf6"); null = the start position
  title: string;              // the explored move on the board ("16. Nf3"), or "White to move" at the start
  engine?: { on: boolean; locked?: boolean }; onEngine?: () => void; // the Engine switch in the header (role switch,
                              // aria-checked, a 44px target; locked: a lock, and its tap opens the paywall)
  verdict: string | null;     // "Excellent", "Checking…", "Couldn’t check this move"
  cls?: MoveClass; evalLabel: string | null /* "+0.4" */; busy?: boolean;
  lines: string[];            // the move's explanation (coach explanations: Pro), or an instruction
  best: string | null;        // "Best here: Bd3 (+0.6)" (always in view), or "Checkmate: White wins."
  notice: string | null;      // news from the real game ("Pip played 15… Nf6 in your game.")
  noticeShort?: string | null; noticeBusy?: boolean;     // its one-line form for the collapsed row; the bot still thinking
  actions: { id; label; onClick; primary?; pressed? }[];  // "Arrows on" / "Arrows off" (a toggle), Play 16. Nf3, Try again
  collapsed?: boolean; onToggleCollapsed?: () => void;    // one row (short phones), with the Engine switch and the primary action beside it
}
```
The coach panel's place while exploring, in the explorer's color (`--explore`), with an "Exploring" tag
and the Engine switch (the "from 15… Nf6" label gives way to it when the panel is narrow: the move list's
first chip says it too). With the engine off the store gives it the move, the "Engine off: …" line and a tip,
and only the rules' verdicts in `best` (checkmate, a draw). Collapsed (a short phone, or a panel squeezed
in landscape, e.g. once the engine's longer content no longer fits), the Engine switch is a pill of its own
beside the row (when the panel is narrower than 381 px and the primary action is there too, the row drops
its explorer icon so the switch keeps its word "Engine"; under 331 px the switch goes alone), so it is never more than one tap away and stays in sight after it is switched.
Nothing slides out of the row under the pill: in a panel under 421 px the row drops its explorer icon (the blue
frame and the "Exploring" tag say it), a row under 241 px (its own container, `xrow`) drops the eval (the bar
beside the board says it), and only then does the move's title shrink; PanelArea closes
a floated panel when it is used, so what it changed (the "Unrated" pill, the bar, the arrows) shows.
Collapsed, the news from the real game is a line under the row (`noticeShort`: "Pip played 2… Nc6 in your
game", "Pip is thinking in your game…" with a pulsing dot, "…: game over"), so a short phone shows it too.

### DrawBar.tsx
```ts
DrawToggle({ onClick })                  // the pencil pill "Draw" (aria-label "Draw on the board")
interface DrawBarProps {
  color: DrawColor; colors: readonly DrawColor[];  // the swatches (a radio group)
  canClear: boolean;                       // the position on the board has drawings
  tip?: string | null;                     // the first-use tip under the bar (above it in landscape); taps go through it
  yourMove?: boolean;                      // the player's move in the game: the turn dot, "Your move", Done pulses
  back?: { label; ariaLabel; onClick } | null; // browsing earlier moves: "Back" / "Final" in the pencil's place (the bar
                                           // covers the strip's "Back to game" chip)
  onColor(color); onClear(); onDone();
}
```
The bar is a size container: narrower than 377 px its pencil (or the turn dot) drops its word ("Draw",
"Your move"); narrower than 327 px (the landscape side column) the pencil goes, Clear shows a
wastebasket (its tap target still 44 px) and Done narrows. The swatches are 44 × 44 px. With
`yourMove` the pencil gives way to the strip's pulsing turn dot (the strip is under the bar), a hidden
status says "Your move. Tap Done to move a piece.", and Done pulses three times. The tip has
`pointer-events: none` (it can lie over the explorer's Engine switch or the coach's buttons).

### ReviewPanel.tsx
```ts
interface ReviewPanelProps {
  progress: number | null;    // 0..1 while analyzing the game, null when complete
  accuracy: { w: number | null; b: number | null };
  counts: Record<Color, Partial<Record<MoveClass, number>>>;
  playerColor: Color;
  names: { w: string; b: string };
  keyMoments: KeyMoment[];    // { index; cls; san; label ("12." / "12…", from the ply's position); color (whose move:
                              // the row says "You" or the opponent's name); text; concedes?: 'material' | 'mate';
                              // tryAgain?: true (your weak move: a "Try again" button beside the row) }
  lockedMoments?: number;     // Pro locked: how many key moments there are (keyMoments is then empty)
  onUnlock?: () => void;      // the locked card's button (the paywall)
  onSelectPly: (current: number) => void;
  onClose: () => void;
  onTryAgain?: (index: number) => void; // the "Try again" beside a moment with `tryAgain` (none without it)
  accuracyNotes?: readonly string[]; // review.ts `reviewAccuracyNotes`: under the accuracies (first in the body), the
                              // player's then the opponent's `alreadyWonNote`, each only when that side has weak moves
                              // made in a won game; once the analysis is done
}
```
A key moment with `concedes` shows a neutral grey marker and the label "Gives up material" / "Faster mate"
(`momentLabel`) instead of its (praising) class.

## App shell (App.tsx) and the controller

`main.tsx` creates one `GameController` (src/game/controller.ts), binds page visibility to it
(`bindPageLifecycle`), and (in the web app; the App Store app has none, see
[Native iOS app](#native-ios-app-app-store)) registers the service worker with
`canReloadNow: () => controller.canReloadNow({ hidden: document.visibilityState === 'hidden' })`:
- false while the game viewer is open (it is not saved);
- false while the Openings section shows its pages (`openingsShown`, session.ts: its code and data have loaded; its pages,
  such as a drill in progress, are not saved). While it shows only "Loading…" or "Couldn't load" it holds nothing, and the
  reload onto the new build is what fixes a chunk an update removed;
- true in the `setup` and `error` phases;
- in `over` (a finished game), true when no sheet is open; with a sheet open over it (such as the
  game-over sheet the player may be reading), only while the page is hidden. The finished game is
  saved with its result and restored as it was (phase `over`, same result, rating and history);
- false while playing or reviewing. The new service worker is active anyway, so the next launch
  runs the new version. (Playing while hidden stays false on purpose: a reload would lose the board
  flip, the viewed move and an open hint.)

Once the app has started (not in the App Store app), App loads the Openings section's chunk and its data chunks
(`prefetchOpeningsData`: the lines JSON and the guides, imported but not built) at idle, so they are in the page's module
map before an update can remove the old build's files: the section then opens in a page that keeps the old build through a
game. If a load still fails while online, the section says the app may have been updated and to close and reopen it.

`pwa.ts` also waits until the page is hidden, or has not been touched since it was opened or brought
back, so an update never reloads the New game sheet while the user is choosing (the one exception, a
lazy chunk that fails while an update waits, is described in `pwa.ts`). `main.tsx` also passes
`onOfflineReady`, which sets an `OfflineStatus` signal (`'cached'` when the page was controlled at
startup, else `'installed'`); `App` shows "Available offline" in the Menu's Engine section, and as a
toast once after the splash when it is `'installed'` (not over another toast). In the App Store app the
signal stays null, so neither shows (a web-ism there). `main.tsx` installs
the iOS guards with `onFirstGesture: unlockAudio`, renders `<App controller offline/>` and calls
`boot()`. `window.__chessCoach.controller` is exposed for debugging and the e2e tests.

The controller owns all state as signals (`controller.store`, see store.ts). Phases: `boot`, `error`,
`setup`, `playing`, `over`, `review`. The store also exposes ready-made **view models**, one per
component (`board`, `evalBar`, `evalGraph`, `moveList`, `coach`, `topPlayer`, `bottomPlayer`,
`toolbar`, `sheets`, `review`), so App.tsx is thin wiring:

| Component | Props from | Callbacks to |
|---|---|---|
| Board | `store.board` (the explorer's board while exploring) | `onMove = playerMove` (updates `plies` synchronously, as Board requires); `explorerMove` while exploring |
| EvalBar / EvalGraph | `store.evalBar` / `store.evalGraph` (`visible` hides them) | graph `onSelect = goTo` |
| MoveList | `store.moveList` (the explored line while exploring) | `onSelect = goTo` (`explorerGoTo` while exploring) |
| CoachPanel | `store.coach` (`other`, `paired`) | actions -> `runAction(id)`, `onToggleCollapsed = toggleCoachCollapsed`, `other.onSelect = selectCoachFeedback(subject)` |
| ExplorerPanel (instead of the coach while exploring) | `store.explorerPanel` | actions -> `runExplorerAction(id)` |
| ReviewPanel | `store.review` (null while trying a move again) | `onSelectPly = goTo`, `onClose = exitReview`, `onTryAgain = tryAgain` |
| PlayerStrip | `store.topPlayer` / `store.bottomPlayer` (incl. `unrated`) | — |
| DrawToggle / DrawBar (on the bottom strip) | `store.draw` (null without a game on the board) | `toggleDraw`, `setDrawColor`, `clearDrawings`, `exitDraw` (Done); Board `onDraw = drawShape(shape, fen)` |
| Toolbar | `store.toolbar` (disabled / active per button) | `openSheet`, `requestUndo`, `requestHint`, `requestExplore`, `flip`, `toggleCoach`, `stepBack`, `stepForward`, `startReview`, `exitReview`; exploring: `explorerReset`, `flip`, `stepBack`, `stepForward`, `explorerReply`, `exitExplorer` |
| NewGameSheet | `store.sheets.newGame` (`inProgress`, `newPlayer`) + `STARTING_LEVELS` | `newGame`, `setStartingRating`, `closeSheet` |
| ConfirmSheet | `store.sheets.assist` (`assistPrompt(kind)`) | `confirmAssist`, `closeSheet` (cancel) |
| MenuSheet | `store.sheets.menu`, `store.engineMode`, `rememberedEngineMode()` | `setSettings`, `resign`, `flip`, `openSheet('new')`, `setStartingRating`, `resetEngineMode()` + reload |
| GameOverSheet | `store.sheets.gameOver` | `startReview`, `rematch`, `openSheet('new')`, `closeSheet` |
| GameViewer (App's `Viewer`, full screen; hidden while one of its moves is tried again) | `controller.viewerView` | `closeGame`, `viewerExportPgn` (shared like the game's PGN), `viewerFlip`, `viewerStep`, `viewerGoTo`, `viewerReview`, `viewerShowReport`, `viewerPlayFromHere`, `runViewerAction`, `viewerTryAgain`, `viewerToggleDraw`, `viewerExitDraw`, `viewerDrawShape`, `viewerClearDrawings`, `setDrawColor` |
| Openings section (lazy, see "Openings section") | `openingsOpen` / pages (src/openings/session.ts), `store.settings` / `profile` / `sheets.newGame.inProgress`, the analysis service | `newGame(settings, { opening })`, `entitlements.requirePro` |

**Controller API** (besides the table): `boot()`, `retry()` (the error screen's *Try again*),
`dispose()`, `newGame(settings, { startFen?, opening? })` (a promise: an opening game may wait for its data; see
"Opening practice"), `rematch()`, `setStartingRating(rating)` (applies a
starting level and saves the profile), `playerMove(from, to, promotion?)`, `undo()`, `hint()`,
`resign()`, `goTo(index | null)`, `backToLive()`, `canReloadNow({ hidden? })`, `exportPgn()`,
`onVisibilityChange(hidden)`, `selectCoachFeedback(subject)` (the coach panel's other row) and `idle()` (tests); Try again's
`practiceGame()`, `tryAgain(index, game?)`, `practiceMove(from, to, promotion?)`, `practiceHint()`, `practiceShowAnswer()`,
`practiceNext()`, `practicePlayOn()` and `exitPractice()` (see "Try again" below); the game viewer's `openGame(id, { from? })`,
`closeGame()` and `viewer…` methods (see "Game viewer" below); the explorer's `requestExplore()`, `explore()`, `exitExplorer()`,
`explorerMove(from, to, promotion?)`, `explorerBack()`, `explorerForward()`, `explorerGoTo(n)`, `explorerReset()`,
`explorerReply()`, `explorerPlay()`, `toggleExplorerEngine()` and `runExplorerAction(id)` (see "Explorer" below);
Draw mode's `toggleDraw()`, `exitDraw()`, `setDrawColor(color)`, `drawShape(shape, fen?)` and `clearDrawings()`
(see "Draw mode" below). `engineStartAdvice(e)` picks the error screen's
advice by `engineFailureKind`. Dependencies are injectable (`ControllerDeps`): `createEngines(request:
{ onProgress })` (a zero-argument factory also type-checks), `onlineEvents` (where `online` comes
from, for the download retry), `storage`, `rng`, `sound`, `now`, `thinkDelay`, `createBot`,
`createId`, `analysisOptions`, `entitlements` (Pro; default `getEntitlements()`), `feedbackHoldMs` (the hold's cap, default
FEEDBACK_HOLD_MS), `feedbackLeadMs` (the verdict's lead before the held reply, default FEEDBACK_LEAD_MS, 0 with
`thinkDelay: false`; see "Feedback first"). `BotLike` is `{ newGame(elo); move(fen, elo, history, signal?, startFen?) }`;
the controller passes the game's `startFen`, so games from a custom position get the repetition
handling too.

**Rated vs unrated.** A hint, takeback or Retry makes a rated game unrated, so `requestHint()`,
`requestUndo()` and the coach's Retry action ask first in a rated game (so does the explorer's Engine
switch, `requestAssist({ kind: 'exploreEngine' })`, see "Explorer"; opening the explorer does not): they set
`store.pendingAssist` and open the `'assist'` sheet; `confirmAssist()` runs the help and
`closeSheet()` cancels. In an unrated game they run at once. While a takeback (Undo or Retry) waits
for confirmation in a rated game, the bot's reply is stopped and held: confirming takes the move back,
and cancelling (closing the sheet, or opening another one) lets the bot reply. Otherwise a reply that
ended the game would drop the takeback and record the rated loss the player was taking back.
Switching best-move arrows on marks the game unrated immediately (a game started with them on is
unrated from the start). A question asked from the Menu (Rate opponent's moves) records it (`PendingAssist.returnTo`), and
both `closeSheet()` and `confirmAssist()` go back to the Menu; one dropped by the game's end closes everything. Rating the opponent's moves (`GameSettings.rateOpponent`) reveals the
computer's mistakes, so a game started with it on is unrated from the start, and `setSettings({
rateOpponent: true })` in a rated game in progress asks first (`requestAssist({ kind: 'rateOpponent'
})`; the bot is not held); `confirmAssist()` marks the game assisted and switches it on. After the
game, or in a game that is already unrated, it switches on at once. The setting is saved, so it stays
on for the next games (a rematch too, unrated again): the question says so, and the Menu's switch reads
"Makes your games unrated while it’s on". The store shows the opponent's
ratings only while the game is assisted, so a rated game can never show them. Starting a new game after the player has moved records the old one as a
loss by "Abandoned" (rated unless already unrated); with Match my rating the new opponent is chosen
before that loss is recorded, so it is the Elo the sheet showed. Before the first move the old game is
discarded. Resigning is a rated loss (unless already unrated), except before the first move.

**Set my level during a game.** A rated game is scored with the rating (and K-factor) it was paired at: during a rated game
the player has moved in, `setStartingRating(rating)` returns 'afterGame' and only stores the level (`store.pendingLevel`,
saved as `SavedGame.pendingLevel`); `finish()` and a new game (after `abandonCurrent()` records the old one) apply it, and
a new "Match my rating" opponent is chosen at it (the sheet's `playerRating` is the waiting level). Before the first move,
or in an unrated game, it applies at once ('now').

**Undo** (`undo()`) puts the coach back as it was before the move taken back: the verdict on the player's previous move
(`restoredCoachMode`), so the two rows and the badge of a paired panel come back too.

**Opponent ratings (`rateOpponent`).** The bot's plies are annotated anyway (neutral explanations); the
setting only makes the view models show them during play (`ratesOpponent` = the setting and an assisted
game): the badge on the bot's move while it is the last ply (the board's `badge`, tinting it; your
feedback badge moves to `extraBadges`), its class in the move list (the same 'notable' icons), its key
moments on the graph, and the coach's verdict in the third person ("Pip’s 12… Nf6 is a mistake",
`titleMove` "Pip’s 12… Nf6") with the neutral explanation and *Show best* (the position before its move,
`runAction('showBest')` takes the ply from `store.coach.index`). Browsing back to a bot move shows its
verdict too. With the coach on as well, `store.coach` has both: one expanded (`subject` 'you' |
'opponent') and the other as `other` (a compact row, "You" always above). The panel follows the game
forward: your move is expanded while it is the latest ply (checked, then its verdict, which the bot's held
reply waits for: see "Feedback first"), then the opponent's reply once it is played, one swap per move and
never back. Your move stays expanded after the reply while it has something to fix (an inaccuracy or worse,
something given away, Retry, a failed check, whether it punished a mistake: the store's `needsAttention`). The player can pick the other with
`selectCoachFeedback`, which holds until the next ply or a takeback (`store.coachFocus`, keyed by the
ply count; `truncate()` clears it). `paired` (coach and opponent ratings on during play) gives the
panel a larger threshold before it collapses (`COACH_TIGHT_PAIRED_PX`, and `PANEL_MIN_TEXT_PX`, see
"Layout"). Its title keeps the verdict whole on two lines at most ("Professo… 4… Be7 / is the best
move": the name gives way first, then the move). With the coach off, only the bot's verdict shows. Pro: the verdicts,
icons and badges are free; the explanation (`coachExplanations`: `lockedTeaser`, "Unlock to see why") and
*Show best* (`showBest`) are locked as for your moves. The finished game and the review are unchanged.

**Can you punish it? (`rateOpponent`).** `annotate()` gives the opponent's mistake, miss or blunder its `Ply.punishment`
(coach.ts `punishmentOf`: the best move of its `after` search, the position it left, with `explainBestMove`'s words; saved
with the annotations). `store.punishView` is that move while it is the last ply of the game in progress (`ratesOpponent`),
with `hidden` until the player taps *Show me* (`runAction('showPunishment')`, Pro's `showBest`: the paywall while locked) or
a hint shows the best move (`revealPunishment()`, `store.punishReveal` = its `annotationKey`, so it stays revealed after a
takeback back to it; a new game or another game's restore forgets it). Hidden: the opponent's feedback is its verdict (free)
and `punishPrompt` ("Pip blundered — can you punish it?") with *Show me* (no explanation, no *Show best*); an open question
(and the punishment once shown, until the player's move) makes the opponent's move the expanded one by default (your move, even one with something to fix, is the row above; picked,
it ends with nothing that names the punishment: its Show best waits when its better move is the punishment, and a
"punishment was" line becomes `PUNISH_MISSED_LINE`); the compact verdicts (the row, the collapsed panel's halves) read
`PUNISH_IT_VERDICT` "Punish it?" and, for your move that punished it, `PUNISHED_VERDICT` "Punished!" (`rowVerdict`);
browsing back to the move shows only the question; best-move arrows are not drawn, also while the opponent's move is still
being rated (`punishPending`), and a threat alert that touches a square of the punishing move waits. Revealed: "Punish it
with Nxh4, which wins the queen." first (the explanation's lines that name it give way), the punishment's arrow ('best'),
and what the opponent should have played as a secondary "Pip’s best" (`opponentLines` says "Pip should have played Nc6, …"
for its "Best was" line, always). After the
player's move, `punishResult` adds one line to its feedback: `PUNISHED_LINE` when it was the best move or about as good
(`Classification.nearBest`, nearEqual.ts), else "The punishment was Nxh4, which wins the queen." (the lines naming it, and
a missed tactic's description, give way) or `PUNISH_MISSED_LINE` while Retry is offered or Show best / the explanations are
locked; that feedback stays the expanded one until the next move (`needsAttention`). With the coach off the line ends the
opponent's feedback instead. While the player's move after the opponent's may still be retried, the opponent's text drops
the lines that name that move's better moves (`opponentLines`) and offers no *Show best*. Retry and Undo bring the question
back (hidden unless shown for that move before). An older save without the punishment takes the live analysis's best move.

**Threat alerts (`threatAlerts`).** A setting (default off; older settings load with it off) that is help: a game started
with it is unrated (`startGame`), `setSettings({ threatAlerts: true })` in a rated game in progress asks first
(`requestAssist({ kind: 'threatAlerts' })`, from the Menu back to it), and it is Pro (`FEATURE_TIERS.threatAlerts`: while
locked the toggles show a lock and open the paywall, `newGame` drops it, a refund switches it off and drops its question).
`updateWatch()` calls `kickThreat()`: on the player's turn in the live game (threat alerts on, allowed, the game unrated),
the live position is probed once (analysis/threat.ts `probeThreat` through `AnalysisService.ensure`, two searches of
THREAT_NODES = 150k nodes each at depth 12, asked together right after the opponent's move at its priority
(`ANALYSIS_PRIORITY.opponent`), so ahead of its rating, and run one after the other: about 0.6 s on an iPhone, and the alert
is up that soon; the player's move withdraws them, and its verdict's searches come first; the bot has its own engine). Results are kept by position for the game (a takeback or Retry back to one
asks nothing new; a new game, a restore or new engines forget them); a probe for a position that is no longer the live
one on the player's turn is withdrawn (`signal`), and an unknown result (withdrawn, cut short) is asked again later. The
result lands in `store.threat`; `store.threatAlert` shows it only for the live position on the player's turn (never after
a move, while browsing, previewing Show best, exploring, after the game or in the review, nor in a rated game), and never
pointing at a punishment still to be found: while the opponent's rated move has no verdict yet, only an alert that touches
the probe's own best reply (`ThreatAlert.best`, the likely punishment) waits for it; once it asks for one, an alert that
touches the punishment waits. Collapsed, the alert takes the coach's row also when both moves are rated. The
coach view gets `alert` (its text) in every panel of the turn (the coach's, a hint, Retry's prompt, coach off), the idle
"Your move" panel drops its general tip under it, and the board adds the threat's arrow ('threat' brush). No probe in
check (a null move is illegal; the check is the threat).

**Feedback first** (README "The coach"). The bot's reply to the player's move used to land before the coach's
verdict on it whenever the bot thought faster than the analysis engine checked the move (a weak bot replies in
0.3-1 s; a check is an `after` search of up to 1.2M nodes, about 2.5 s on an iPhone, and a near-equal second
opinion was another one). Now, in this order of importance:
- *The reply waits for the verdict* (`holdForFeedback`). The bot still computes its reply at once, in parallel;
  `requestBotMove` then waits, still `botThinking` (the strip's dots), following `feedbackState(index)` (an
  `effect` over the signals): 'checking' until the player's move (the one replied to) has its verdict
  (classification and explanation), then 'shown'; 'off' (the reply goes at once) when its check failed
  (`failedAnnotations`), the coach is switched off, the explorer, Try again, the game viewer or the Openings
  section opens, or the game is no longer the one on the board. Once the verdict is shown, the reply waits until
  it has been up FEEDBACK_LEAD_MS (600 ms, `annotate` records when: `verdictShown`), so it is painted and readable
  on its own before the bot's piece moves (it used to land in the same task, so on the same frame); nothing is
  added when the verdict was up that long during the bot's own think time. It never waits longer than
  FEEDBACK_HOLD_MS (3.5 s, `ControllerDeps.feedbackHoldMs`) beyond the bot's own think time, lead included, and
  the bot's `AbortSignal` drops the reply as before (Undo, Retry or a takeback asked for, a new game, resigning,
  the game's end, the page hidden, an engine failure). No wait with the coach off or after a move the game ended
  with (there is no reply). `idle()` waits for a held reply too (it is part of the bot's task). With
  `rateOpponent` on, the dual coach keeps the player's move expanded until the reply lands (see "Opponent
  ratings").
- *The verdict is final when shown.* The near-equal second opinion comes before it (`annotate`): the one that only
  settles "about as good" with SECOND_OPINION (depth 14, MultiPV 1: only its score is compared, within 300k
  nodes, a quarter of an annotation's budget; a median of 45k nodes, about 0.1 s on an iPhone), the rare one that
  can change the class (`secondOpinionNeed`'s `affectsClass`) with the annotation request. So the words never
  change after the verdict is shown (no "c6 was slightly more accurate." turning into "Your Nxd5 was fine: …"),
  and "You punished it!" comes with the verdict.
- *Priorities* (`ANALYSIS_PRIORITY`, `EnsureOptions.priority`): `verdict` (40) for the player's moves while
  playing, so the verdict on the latest one never waits behind anything (`prefetchVerdict` asks for its positions
  before and after the moment the move is played, which lifts the end of the opponent's move's rating, the same
  search, and pre-empts a lower one running; the annotation then finds them in the cache); `user` (30) for a hint,
  Show best and Try again; `opponent` (20) for the opponent's moves' ratings and the threat probes (asked first,
  so the alert is up in a fraction of a second; the player's move withdraws them); 0 for the review, the
  explorer, the game viewer and the Openings section. The eval bar's live search yields to every `ensure`. The
  annotation queue goes in order (a verdict needs the previous move's), so an opponent's move that a later move
  of the player's waits for is searched at `verdict` too: `annotationPriority` is asked anew for each of its
  searches (its second opinion included), and `prefetchVerdict` asks the one in flight again at `verdict`
  (`annotationInFlight`), so it keeps running rather than being cut short by the player's searches. The queue
  picks up a ply played while it was finishing (`kickAnnotations`), since the verdict that ends it is what
  releases the reply; a throw inside `annotate` (a bug, not the engine) marks that move failed ("Couldn’t check
  …", Check again), so the queue moves on and a held reply goes.

**Coach flow.** Every ply is annotated in the background (`ensure` depth 14, MultiPV 3, within
`ANNOTATE_NODES` = 1.2M nodes, before and after the move; `classifyMove` gets `prevFenBefore` from
the previous ply). Hints, *Show best* and the review use the same request. A result that was
aborted, is not terminal and is shallower than depth 14 counts as failed, so the coach offers *Try
again* instead of a shallow verdict; a finished search that ran out of nodes below depth 14 is the
verdict (it only happens in positions where one more iteration would take millions of nodes). The feedback title names the move ("3. Qxf7+ is a blunder") and
the badge stays on it after the bot replies, as long as the player's piece is still on that square
(not after the reply took it, en passant included). *Show best* is offered when `offersShowBest` says so
(any move but a top one, including a Brilliant that isn't the engine's top move); in a rated game
it is the primary action and Retry is secondary. While Retry is offered, the text drops anything
that names the better move (`answerFreeLines`; an underpromotion headline is replaced too), and the
"Try again" prompt after a Retry is saved with the game (`SavedGame.retry`). *Hint* and *Show best*
pass all engine lines to `explainBestMove`, so they compare the move with the alternatives the same
way the feedback on that move does. When the position's engine lines are no longer cached (after a
restart or a restore), *Show best* shows the saved explanation at once with a spinner, analyzes the
position again (the `showBest` coach mode's `pending`; `idle()` waits for it) and then fills in the best move's
explanation and "Best line"; a late result is dropped if the player has moved on. "You played X."
leaves out the move's own explanation when it only repeats the best move's. **Near-equal moves**
(analysis/nearEqual.ts): at the coach's budget the order of moves a few centipawns apart is noise
(after 1.d4 d5 2.c4 Nf6 3.cxd5 it puts 3...c6 first where a depth-24 search prefers 3...g6), so a move
about as good as the best (`Classification.nearBest`, not the best itself) is not corrected: its
explanation says "Your Nxd5 was fine: c6, c5 and g6 were only slightly better." ("Nxd5 was fine: …" for
the opponent's move; "c5 is one of the engine’s top choices, with c6 and g6." when the engine listed it;
nothing when it scored at least as well, `aboveBest`), the review adds that instead of "Best was X." (and
draws the best move and the alternatives, no arrow for `aboveBest`), and *Show best* is titled "Top choices"
with the moves and their evaluations ("c6 +0.6 · c5 +0.7 · g6 +0.7", then the played move from its own side:
"Your Nxd5: +0.9, close behind." or "…, at least as good."), the best move's explanation without ranking
(`explainBestMove`'s `compare: false`: no "only move" or "more precise than", the list ranks them) and
"Engine line: …". Just outside the band, the position after the best move is searched too (`secondOpinion`,
classify.ts `secondOpinionNeed`; a failed or cut short one is skipped), before the verdict (see "Feedback
first"), in the game as in the explorer's ratings and Try again's checks. A clearly worse move keeps its correction and names the alternatives ("Best was c6
(c5 and g6 were about as good)."; one helper, `bestWasSentence`, words every "Best was"; not after a reason),
and *Show best* adds them ("c5 and g6 were about as good.") unless its explanation already does; its title is
"Slightly better: c6" for an Excellent or Good move (no `concedes`), else "Best was c6". Its arrows: the played
move, the best one ('best') and the alternatives ('alt'). While Retry is offered none of these moves is named
(`answerFreeLines`; a line that only names a pawn move's square, "your knight on d4", stays: `namesMove`);
with Show best locked (Pro) nothing names them. Browsing earlier moves
while a hint is open shows the history view; the hint comes back at the live position (the Hint
button is not highlighted meanwhile). A move whose explanation has `concedes` (a Good / Excellent
move that gives something away) gets `verdictTitle`'s neutral title and no class icon in the coach,
on the board or in the move list. A move that ends the game by threefold repetition is classified and
explained as a draw, and so is a move that lets the opponent repeat (`annotate`, `letsOpponentRepeat`: every legal reply
repeats, chess/utils `repetitionReplies` over the game's position counts, or one does and the opponent's own search puts it
worse off, so it would take the draw): classified against a draw (`after.terminal`), eval 0.00, `repetitionExplanation`
with `allows`. Every explanation gets the game's position counts (`seen`), so no line runs past a third repetition. The
finished game's coach (`overCoach`) leads with the result (a draw rule in plain words, `drawRuleText`), then the verdict on
the move that ended the game on the board (its explanation without the line that repeats the result; Show best when it
offers one, `index` set; Pro: `reviewDetails`), and "Review the game to see its key moments." for a draw. Once every move
is checked, `recordAccuracy()` saves the player's accuracy in the game's record (Recent games), without a review too, and
`sheets.gameOver.play` gives the sheet both sides' accuracy and the player's weak moves. During play the eval graph's dots
follow the board and the move list (`ratedDuringPlay`): none for your moves with the coach off. The coach-off view
('minimal') is expanded unless the player collapses it (a short phone shows one row anyway). A finished game's strips count
captures from the moves (`capturedByMoves`: a promotion is not a capture by the other side) when it began at the start.
`exportPgn()` during the game puts NAGs only on the moves the app rates then (`buildPgn`'s `nag` filter). An open hint is
saved (`SavedGame.hint`) and asked again on restore.

**Opening practice.** `newGame(settings, { opening: { lineId, mode: 'steer' | 'skip', showLineMoves?, moves?, name?,
family? } })` (the Openings section's *Play*) starts a game against the bot that follows a line: a line of the
openings catalog by its id, or any other line by its own moves (`moves`, UCI from the initial position, validated
with chess.js by `studyOpeningLine`; e.g. an opening guide's annotated main line, `lineId` "guide:London System",
shown under its opening's `name`), so a game plays exactly the line the section taught (`OpeningGameOptions`; it
first awaits `loadExplorer()` when the catalog or the book is not loaded, and a game started meanwhile wins; an
unknown line id without moves, or illegal moves, start a normal game with a warning). The game's side and opponent
are not saved as the New game defaults (the player's colour, opponent and Match my rating stay; the toggles are
saved). `GameInfo.opening` holds the resolved `OpeningLine`, the mode, `showLineMoves` and `custom` (a line with its
own moves, saved with them); `game/opening.ts` `lineProgress(line, startFen, plies)` says
where the game stands: 'on-line' (the position is one of the line's, whatever the move order, as `nextLineMove`
compares them: board, side to move, castling), 'complete' (the game reached the line's last position, sticky), or
'left' (with the latest ply that went off the line and the line's move there).
- 'steer': from the initial position. On the bot's turn on the line, `requestBotMove` asks `bot.lineMove(...)`
  for the line's next move (a book move with a book move's think time; a bot without it plays the move at once)
  instead of `bot.move`, through the same abort / epoch / visibility guards, so pause, undo and new game work as
  before. Off the line or once it is complete, the bot plays its own moves (its book may go on). A takeback that
  goes back onto the line resumes steering.
- 'skip': the line's moves are played into the game before it starts (`startFen` stays the initial position, so
  the move list, opening names and PGN are normal; a line that would end the game, such as the Fool's Mate, stops
  before that move, and one more if needed so the human moves first) as book plies (`isBook`, a 'book' classification with nothing
  lost) and counted in `GameInfo.preplayed`: the annotation queue skips them (`annotate` gives the position after
  them its eval when the first real ply is annotated), undo / Retry never reach them, they do not make a game
  "moved in" (abandon, resign, `inProgress`), the review's summary starts after them (accuracy and counts), and the
  coach describes them as played for you. The bot replies at once when it is its turn.
- Opening games are unrated from the start (`assisted`; the computer's first moves are scripted). The target is
  saved (`SavedGame.opening`, with `moves`, `name` and `family` for a line from outside the catalog, `preplayed`;
  older saves load as normal games); `boot()` loads the catalog before
  restoring such a game. `rematch()` keeps the opening; `newGame()` without one clears it. The PGN's Event tag is
  "Opening practice: <name>".
- `store.openingPractice` (`OpeningPracticeView`: line id, name, family, mode, status, `move` of `moves`, next move,
  `leftAt`, `completedAt`, `statusText` "Move 3 of 5" / "Line complete" / "Left at 3. Nc3", `summary`). The coach
  view gets the banner as an action with id 'opening' (playing and over; `runAction('opening')` calls
  `openOpenings({ lineId, ply })` from src/openings/session.ts, at the game's place on the line: the ply reached,
  where it left the line, or the end) and `paired`, for the extra row. The banner shows the opening's name whole;
  a long variation gives way first. During play the coach's
  live views start with what is new about the line, said once (until your next move): "Line move: 3. Bc4 — Italian
  Game" on your turn (`showLineMoves`; a move the book flags as a mistake, `LineMove.dubious`, adds "(a known
  mistake: this line shows how it gets punished)"), "You left the line at 3. Nc3 (the line continues 3. Bc4) — the game goes on
  normally.", that the line is complete or set up, and at the start ('steer') that the bot follows the line; your
  first "book" verdict says what "book" means. With `showLineMoves` the board shows the line's next move on your turn as
  an arrow with its own light brush ('line', under any engine arrow). `sheets.gameOver.practice` names the line.

**Explorer.** `requestExplore()` (toolbar *Explore*) opens it at once on the displayed position
(`explore()`): the live one (`fromLive`) or a browsed earlier one, while playing (either side to
move), after the game and in the review. It never asks and never changes the rating. The explorer is
free; its engine is Pro (`FEATURE_TIERS.explorer` 'free', `explorerEngine` 'pro'; were the explorer
itself made Pro, `requirePro('explorer')` would open the paywall). State: `store.explorer`
(game/explorer.ts, ephemeral: not saved, `canReloadNow()` is false while exploring), `explorerEngine`
(the Engine switch), `explorerArrows` (the panel's toggle, default on) and `explorerReplying`.
- **The engine is off during a game** (`store.explorerEngine` false when it opens in `playing` with no
  outcome), unless it was switched on in this game before (the controller's `explorerEngineGame`, the
  game's id; switching it off forgets it, and a reload may): then on. After the game and in the review it
  opens on, when allowed (locked in the paywall build: off, the switch showing a lock). Off, nothing is
  asked of the engine about the explored positions and nothing it knows about them shows: `updateWatch()`
  watches the game's position as if not exploring (the game's annotations and coach go on), there is no
  `kickExplorerRatings()`, no `ensure()` for explored FENs and no *Reply*; the store's `explorerEngineOn`
  gates `liveForExplorer` (so not even the game's own watch or the cache, holding the same position, can
  leak), the arrows, the board badge, the move list's icons (`showClassIcons` false), the panel (no
  verdict, eval, explanation, *Arrows* or *Best here*: the move, `EXPLORER_ENGINE_OFF` "Engine off: try
  moves for both sides." plus "Your game stays rated." in a rated game in progress or "This game is
  already unrated." in an unrated one, and `EXPLORER_ENGINE_OFF_TIP`), the toolbar (`explorerReply`
  disabled, in its place, so the toolbar never changes shape on the switch) and the
  eval bar (`off`: a neutral "Engine off" bar where the game's was, so the board keeps its size; none
  when the game's bar is off). The rules still speak: legal-move dots, last move, check, checkmate,
  stalemate and `explorerDraw` in `best`, captures on the strips, the line, *Play*, the game's news.
- **The Engine switch** (`toggleExplorerEngine()`, also `runExplorerAction('engine')`; the panel's
  `engine: { on, locked }`): on, in a rated game in progress, asks first (`requestAssist({ kind:
  'exploreEngine' })`, the 'assist' sheet; the bot is not held), and `confirmAssist()` marks the game
  assisted and switches it on (Keep off = `closeSheet()`: nothing changes). The question is dropped when
  the explorer closes (`exitExplorer`), the game ends (`finish()` closes the sheet when it defers the
  game-over sheet) or a new game starts. In an unrated game, after the game and in the review it switches
  on at once; while locked (Pro) it opens the paywall (`requirePro('explorerEngine')`), with no question.
  On (`setExplorerEngine(true)`): the watch follows the explorer and every explored move not rated yet is
  rated (`kickExplorerRatings`). Off: `explorerSession` is bumped and `explorerAbort` aborted (as on Exit),
  so the explorer's `ensure()` requests are withdrawn and their late results dropped, and the watch goes
  back to the game; the ratings kept are hidden, and a game the engine made unrated stays unrated. A
  refund (`onLocksChanged`, `explorerEngine` locked) switches it off and drops a "Turn on the engine?"
  still open (as a pending hint question when hints lock); the explorer stays. An answer that comes
  through anyway finds it locked in `runAssist` and opens the paywall instead (`requirePro`).
- The game is never modified: the board (`store.board`) shows the explorer's position with both colors
  movable, its last move and check, and a blue frame (`.app[data-exploring]`) plus an "Exploring ✕" tag
  on the top strip (tapping it exits); `playerMove` and `goTo` are refused; the toolbar's ‹ › (and ← →,
  Escape to exit) work on the explored line. The players' strips show the explored position's material
  and side to move. The board's `session` ('game', or `explorer:<n>` per opening) changes on the way in
  and out, so a piece selected or a promotion picker opened in one never finishes as a move in the
  other, even on the same position.
- A position the game would end in is final there too: checkmate and stalemate (`positionInfo`), and
  `store.explorerDraw` (`drawReason`: too little material, a third repetition counting the game's
  positions up to the base, the 50-move rule). Then no side moves, *Reply* is off, no arrows, the eval
  bar is exactly 0.0 and the panel says "Threefold repetition: a draw." in place of "Best here".
- With the engine on, `updateWatch()` watches the explorer's position, so the eval bar (shown even when
  off for the game), the arrows (`lineArrows`: best + alt) and "Best here" follow it; the game's graph
  stays, dimmed and not tappable (also with the engine off). `exitExplorer()` points the watch back at the game.
- With the engine on, each explored move is rated like a game ply (`rateExplored`: `ensure` before and after with the
  annotations' request, `classifyMove` with the previous move, explored or the game's, its `winLoss`,
  the book and the threefold over the game's positions plus the line, `explainMove` with perspective
  'you' for the human's color, else 'neutral'). The ratings run one at a time in line order
  (`kickExplorerRatings`, which starts only when a move needs a rating and, when its run ends, looks
  again, unless that run threw: then not in the same explorer). Each turn of `runExplorerRatings` first
  makes sure of the position on the board (an `ensure` with the annotations' request, answered by the
  cache once known): it is the watched position, so its search streams to the eval bar, the arrows and
  "Best here", which would otherwise wait for every earlier move's rating after a long line tried with the
  engine off. A rating that throws (`classifyMove`, `explainMove`…) marks its move failed (*Try again*)
  and the run goes on, so nothing retries without end. The explorer has at most one rating search in the `ensure` queue (plus a
  pending *Reply*) and the game's annotations keep their turn (the bot has its own engine); results are
  cached by position, so stepping through the line or replaying a move asks for nothing new. A result
  is dropped unless the move's path (`movePath`) and the explorer session still match; a failed rating
  offers *Try again*. The explorer's requests carry its session's `AbortSignal`: closing it (Exit,
  *Play*, a new game) or switching its engine off withdraws them, so the game's own analysis comes next
  at once.
- *Reply* (`explorerReply`) plays the engine's best move for the side to move: from the analysis at hand
  when it reached depth 12, else an `ensure` with the annotations' request (which the next rating
  reuses). A reply still pending from an explorer since closed never stands in for a new one.
- *Play 16. Nf3* (`explorerPlay`, offered by `store.explorerPlayable`): when the explorer started from the
  live position, nothing was played in the game since and it is the human's turn, it exits and plays the
  line's first move through `playerMove` (coach, annotation, bot reply).
- The bot goes on playing meanwhile (exploring from its turn): the panel says "Pip is thinking about its
  move in your game…", then "Pip played 15… Nf6 in your game." and drops *Play* (collapsed, on a short
  phone, as a line under its row). A game that ends meanwhile keeps its game-over sheet until the
  explorer closes.
- `exitExplorer()` restores the view it left (`viewIndex`, unless the game ended meanwhile, and the flip)
  with no sheet open. A new game, a restore, an engine failure or `resign()` close it (and a refund, were
  the explorer itself Pro).

**Draw mode.** The player's own arrows and circles (README "Drawing on the board"): free, and no
help (the game stays rated, nothing is saved). State: `store.drawMode`, `drawColor` (kept for the
session), `drawTip` and `drawings` (game/drawings.ts `Drawings`: shapes by `positionKey`, the FEN's
piece placement and side to move, so castling rights, the en passant square and the move counters do
not matter). `store.board` adds the drawings of the position it shows (`shapes`) and, while Draw mode is
on, `drawColor`; `store.draw` (`DrawView`: `on`, `color`, `colors`, `canClear`, `tip`, `yourMove`: on
over the live game on the human's turn, outside the explorer) is null unless a game is on the board
(playing, over, review). The game's board, the explorer's (the same Board) and the
review's share the drawings, so a drawing on the live position shows in an explorer opened there, and the
explorer's stay on their positions after it closes. `drawShape(shape, fen?)` toggles a shape on the board's
position (`drawOn`: the same squares and color take it off, another color recolors it), unless `fen`, the
position the gesture was drawn on, is no longer the board's (a move landed meanwhile); `clearDrawings()`
clears that position only. `startGame()` (new game, rematch, opening practice) clears them all, and so
does `restore()` of another game (the same game again after an engine failure keeps them). Draw mode
ends (`exitDraw()`) on Done and Escape (App, before the explorer's Escape), and on `openSheet()`, a
`requestAssist()` (hint, takeback, Retry, the explorer's engine, Rate opponent's moves), `undo()`, the
coach's actions except Back to game, dismissing a hint and Try again, `explore()`, `exitExplorer()`,
`explorerReply()`, `finish()` (unless the game-over sheet is deferred: a game that ends in the background
while exploring leaves the explorer's Draw mode on, and `exitExplorer()` ends it as the sheet appears),
`startReview()` / `exitReview()`, `startGame()`, `restore()`, an engine failure, the paywall opening
(`entitlements.paywall`) and the Openings section opening; Flip, browsing (‹ ›, the move list, Back to
game), the bot's move and the Coach toggle keep it (the bar then shows `yourMove`). First use:
`toggleDraw()` shows the tip (`drawTip`, `DRAW_TIP`: how to draw and erase, and that Done brings moves
back) while `chesscoach.draw-tip` is not set (persistence.ts `loadDrawTipSeen`); the first drawing sets
it (`saveDrawTipSeen`; a failing storage only shows it again) and hides the tip, and leaving Draw mode
hides it. The Openings section's Learn and Tree boards (`OpeningBoard drawable`, `OpeningDrawControls`
in the row under the board) have the same Draw mode with their own drawings (the two pages share them;
they are forgotten when the section closes; Escape, and the navigation bar's Done (`leaveSectionDraw`),
leave Draw mode before the page or the section).

**Boot, errors and the splash.** `boot()` starts the engines first and only then loads the opening
book (0.9 MB, only a game needs it), so the book never competes with the engine download. While
booting, the splash shows "Starting the engine…". When the
analysis engine's `.wasm` download is still running after 300 ms, it shows "Downloading engine
NN%…" with a thin progress bar (`store.engineDownload`, 0..1, analysis engine only, set only while
booting). The error screen shows *Try again* (`retry()`) and a link to `?enginetest`, with advice by
failure kind:
- `unsupported`: "Your browser may not support WebAssembly SIMD (iOS 16.4+ required)."
- `download`: "Couldn’t download the chess engine. Check your connection and tap Try again." The
  controller also retries once on the window's `online` event while that error is shown (cancelled by
  a manual retry, `dispose()` or a new boot).
- anything else: "Tap Try again. If it keeps happening, close and reopen the app."
- An engine that breaks mid-game shows "The chess engine stopped working." / "Tap Try again to
  restart it. Your game is saved."

**The history's analysis.** Once every move of a finished game is checked (or could not be), `recordAnalysis()` saves in
its record the player's accuracy (Recent games; replaced once every move has its verdict) and the compact analysis
(game/archive.ts `encodeAnalysis`: a token per ply and the key moments' headlines), again when it changes (the review
retries failed moves). A game that leaves the board before every move is checked (`startGame`: a new game, a rematch, Play
on; `restore` of another game) keeps what is known (`recordAnalysis({ partial: true })`: '-' for the rest, no accuracy).
Every save merges into the record's analysis (`mergeAnalysis`: a token that knows less, '-' or an evaluation only, never
replaces one that knows more), so a stale or partial copy never erases a verdict. `recordResult` adds the opponent's
`botId` and opening practice's `preplayed`, and `applyGameResult` the `provisional` flag (true or false on every rated
record; absent only on older ones, whose chart infers it). The chart (`ratingHistory`) counts a history as complete only
when it holds every game the win/draw/loss counts say were played (not when a full storage kept only the newest). Measured
(tests/game/archive.test.ts): a 60-move game with a verdict on every move and 12 key moments' headlines is ~1.8K characters of
analysis, ~1K of PGN, a ~3.1K record; 200 of them ~620K characters (JSON parse of the profile stays a few ms). Over the
quota, `saveProfile` drops the oldest games' analyses before any PGN (see rating.ts `slimmedHistories`).

**Game viewer** (README "Your games"; game/viewer.ts). `openGame(id, { from: 'menu' })` (the Menu's Recent games and the
rating chart) opens a record of the history: its moves from the PGN and its analysis decoded (archive.ts `archivedGame`; the
game on the board, once over, from its own plies with every explanation, kept in step with its annotations as they land,
`syncBoardViewer`), the opponent `recordBot(record)`, at the final position, over the game and the Menu (which stays open
under it). A move whose comment is only the record's (`GameViewer.brief`) is explained again when it is shown
(`kickViewerExplain`: `rateLineMove` on the annotations' request, one move at a time, withdrawn when the cursor moves on;
the comment is busy meanwhile). While a rated game is in progress (`ratedGameInProgress()`), the view model gets
`ratedGame`: no better move in any comment, no arrows, no Review analysis of an unanalyzed game, no Try again
(`tryAgain` refuses an archived game too), and `viewerNotice` says why; a game the player has moved in turns Play here
off (`gameInProgress`). A weak move that can be tried again keeps its better move (and arrow) for the viewer's *Show best*
(`runViewerAction('showBest')`) or a try that ended (`store.revealedTries`, as in Game Review). `store.viewer` holds it (not saved; `canReloadNow()` is
false), and `controller.viewerView` is its view model. A try at the game on the board's moves ends and the explorer
closes when it opens; a new game, a restore, new engines and an engine failure close it (`dropViewer`). It never changes the
game on the board or the rating: the bot goes on playing under it, and a game that ends meanwhile defers its game-over sheet
(`finish()`'s `deferred`, as for the explorer and the Openings section) until `closeGame()`, which otherwise shows the Menu
again when it was opened from it. **Review** (`viewerReview`) shows the report and the best-move arrows; when the record
lacks a verdict on some moves it first analyzes them (`runViewerAnalysis`: `rateLineMove` per ply in game order, one search
at a time with the annotations' request and the viewer's `AbortSignal`, so a game in progress keeps its annotations' turn;
the start position's eval; the failed moves once more), with `review.progress` for the report's bar, and saves what it found
in the record (`saveViewerAnalysis`: every 10 moves, at the end and on close; the accuracy too once complete). Try again
(`viewerTryAgain`, Pro's `reviewDetails` through `tryAgain(index, viewerPracticeGame(v))`) closes the Menu and runs on the
game screen while App hides the viewer; its Back returns to the viewer as it was. **Play here** (`viewerPlayFromHere`)
starts `startGame` from the position shown with the record's color and opponent and `GamePractice { from: the next move }`
(or `{ from: the last move, after: true }` on the final position: "after 3… Kxf7"), unrated, the New game defaults kept;
'inProgress' while a game the player has moved in is going on (its toolbar button is off then); 'none' for a game
without moves. Draw mode has its own drawings
(`viewerDrawShape`, forgotten on close; the color is the app's). Pro: replay, the move marks, accuracy and export are
free; the comments (`lockedTeaser` + Unlock), the key moments and Try again need `reviewDetails`.

**Persistence.** The game is saved after every move. `finish()` keeps the finished game (with
`SavedGame.over`) instead of clearing it, and the review saves again when it ends. On boot,
`restore()` reopens a finished game in the `over` phase (no bot move), recording the result if the
profile's history lacks it, or continues a game in progress with the coach's verdict on the last
human move (or the "Retry" prompt of a Retry, from `SavedGame.retry`). The next game overwrites
the save.

Each screen area is its own small component that reads only its signals, so a live-analysis update
re-renders the eval bar and graph but not the board. App-level extras: the boot splash, the engine
error screen, the "Back to game" chip (while browsing history), the PGN export (Web Share sheet,
else clipboard, with a toast), ← / → keys to step through moves, the theme picker in the menu, and
the Menu's Engine section: "Try two engines again" calls `resetEngineMode()` and reloads (dropping
an `?engines` parameter from the address instead, which would force one engine again).

**Review.** `summarizeGame` (review.ts) lists as key moments the plies in `KEY_CLASSES` plus the
concessions (`concession(ply)`), and adds the inaccuracies when that makes fewer than 3; over 12, it
keeps the most important (concessions rank with the inaccuracies). Counts and accuracy use the
classes as they are. The labels and the accuracy measure different things (a label compares the move
with the engine's best; accuracy follows the winning chances over the game, lichess's formula, which
caps the evaluation at ±10, a mate counting as 10), so a high accuracy can sit beside weak moves made
in a won game (classify.ts: a mate played 7+ moves slower is an inaccuracy by the coach's own ladder, giving up
a mate at +10 or more one too by lichess's floor, and neither moves the accuracy). The labels stay, and the
coach explains them:
- on the move, `Classification.wonAnyway` (the game history keeps it: archive.ts tokens 'w'/'l' with the mate,
  `CompactAnalysis.w`; for a record kept before it did, `decodeAnalysis` derives it from the evaluations kept,
  `wonAnywayFromEvals`) adds `wonAnywayLine` after the explanation, wherever the explanation shows
  (the coach on your move and the opponent's, browsing back, Game Review, the game viewer, the explorer):
  "A faster mate was available (Qh7+, mate in 3), but you were winning anyway." ("Pip had a faster mate
  (Qh2#), but was winning anyway."; `explain.ts` then says only how the move mates, "Qb1 still forces mate in
  9.", without "Best was …"), or "You were winning anyway, so the missed mate hardly matters." after "You
  missed a forced mate in 6.". The faster mate is named only when nothing keeps the better move hidden
  (`reveal`: not while Retry is on offer, a punishment is to be found or was just named, a key moment is to
  be tried again, or a rated game is on in the game viewer); nothing while the explanations are locked. A
  collapsed coach row (a short phone) leads with `wonAnywaySummary` (the view's `summary`) instead of the
  explanation's first line;
- under the accuracy, `summarizeGame`'s `alreadyWon` counts per side and class the weak moves made in a won
  game (`weakInWonGame`: the evaluations before and after it both +10 or a mate for the mover, exactly the ones
  accuracy is computed from, so a counted move never lowered it), and `alreadyWonNote` says it ("7 of your 9
  inaccuracies came when you were already winning, so they didn’t lower your winning chances — that’s why your
  accuracy is still 99.1%."; the "that’s why" only when they are at least half of the side's weak moves, else
  "…, so it didn’t lower your winning chances."; below ACCURACY_NOTE_MIN (90), compared with the accuracy as
  shown, "…, so they didn’t lower your winning chances or your accuracy."; "4 of Pip’s 6 inaccuracies came when
  Pip was already winning, …"), never at 0: the review's and the game viewer's report `accuracyNotes`
  (`reviewAccuracyNotes`: yours, then the opponent's; once the counts are final), and in short the game-over
  sheet's `play.note` (`alreadyWonSheetNote`, yours). The counts table stays as it is.

In phase `review` the panel slot shows the ReviewPanel summary first; stepping to another
move (toolbar ‹ ›, move list, graph, a key moment) swaps it for the coach's comment on that move
(`store.coach` in review mode, with *Show best*). The toolbar's *Report* button toggles back. When
the panel slot is under 300 px tall (phones), the summary floats over the board as a card.

**Try again** (README "Game Review"; game/practice.ts). `store.tryAgainMoments` (the finished game's plies that can be
tried again: `practiceMoments`, the player's key moments that were an inaccuracy or worse; empty while
`reviewDetails` is locked) puts `tryAgain` on those key moments (ReviewPanel's button) and a primary *Try again*
action (`'tryAgain'`) on the review coach's comment on one (also browsing after the game, phase `over`).
`tryAgain(index, game?)` (Pro: `requirePro('reviewDetails')`; never while exploring) starts a try on any game's
plies: `game` defaults to `practiceGame()`, the game on the board once it is over (`source: 'current'`); an
earlier game from the history is passed as a `PracticeGame` (`source: 'archive'`: its plies with their
classifications, `bot` its persona). `store.practice` holds the try (not saved; `canReloadNow()` is false). It
changes nothing in the game: `viewIndex`, the phase and the review stay as they were, so `exitPractice()` (Back,
the strip's "Try again ✕" tag, Escape) shows the review (or the game) as it was left; a new game, a restore, the
review starting or ending, an engine failure and a refund (`reviewDetails` locked) end it. While it is on, the view
models show the try instead of the game: the board (the position before the move, the player's side at the bottom
and movable while a move is awaited, session `practice:<n>`, the last move, the moved piece while it is checked
and with its badge once found, the move tried last as a 'played' arrow, the second hint's square as a 'best'
circle, the answer's 'best' arrow beside the game's 'played' one), the coach (kind 'practice', see below), the
move list (the game's moves up to it, then the attempt), the graph (the tried game's, at the move, dimmed and not
tappable in App), the strips (its opponent, no Unrated pill), the eval bar (known evals only: the game's before
the move, then the attempt's; nothing live: `updateWatch()` watches nothing, so no search can hint at the answer)
and the toolbar (Back, Flip, Hint, Answer, Next one, Menu: `practiceExit`, `practiceHint`, `practiceAnswer`,
`practiceNext`; once the try is over, Play on in place of Hint and Answer: `practicePlayOn`). Flip turns only the try's
board (`Practice.flipped`, started from the board it came from: the review's or the viewer's). Until a weak move's better
move has been shown (Show best on it, or a try that found it or showed the answer: `store.revealedTries`), the review's
comment on it is `answerFreeLines` with no arrow; the report lists the key moments first when one can be tried again,
and the game-over sheet offers "Try your mistake again". goTo, the game's moves, Explore, Hint and Undo wait; a game in progress (an earlier game tried
meanwhile) goes on, and a game-over it reaches waits for the try to end (`deferredGameOver`). `startTry` asks for the
answer at once (`findAnswer`: `ensure` of the position with the annotations' request, the cache answering what the
review analyzed; `answerMove` with `explainBestMove`'s words and the best line; without engine lines, the saved best
move and the explanation's lines on it). `practiceMove` plays the attempt (`playAttempt`): the game's own move is
"not quite" at once; any other is checked by `checkAttempt` through `rateLineMove`, the explorer's rating shared with
it (the annotations' searches, the second opinion, `classifyMove` with the previous move's winLoss and the
player's rating, `explainMove` for the player, repetitions counted from the game's start), then `judgeAttempt`:
better (`isSolution`) is 'solved' (a chime), anything else 'wrong' with the move taken back (a buzz); a failed
check takes it back with "Couldn’t check that move. Try it again." Coach wording: waiting, "Find a better move than
Qxb2" with `playedLine` and the game move's first answer-free line (`answerFreeLines`, minus any line naming the
answer); wrong, "Not quite — try again" with `triedLine` and its first answer-free line; a hint leads the lines
("Hint: move a knight." then "Hint: move the knight on g1.", what a one-row panel shows); checking, "Checking
Nf3…" (busy); solved, `solvedTitle` ("You found it: 3. Bc4", the news a one-row panel shows) with `solvedLine`, the
attempt's `verdictTitle` as a line (unless it only says "best") and its explanation (`explanationLines`);
revealed, "Best was Nf3" with the answer's lines and `playedLine`. Settled, the actions are *Next mistake* (the
next of `practiceMoments` in game order, primary; `practiceNext()` takes the game on the board as it is now),
*Play on from here* and *Back to review* ("Back to game" in phase `over`), with "That was your last (only) mistake
in this game." when there is no next. `practicePlayOn()` starts a game (`startGame(…, practice)`) against the same
opponent (`bot.id`, `botElo`) from the position before the move, the player's side to move, with the current
options and without touching the New game defaults; `GameInfo.practice` ({ from: "12. Qxb2" }, saved as
`SavedGame.practice`) makes it unrated from the start and a rematch keeps it; the coach's first line says where it
comes from (`practiceStartLine`), the game-over sheet and the PGN's Event call it "Practice from move 12"
(`practiceGameLabel`). Never while a game the player has moved in is in progress (it would count as an abandoned
loss): the action is not offered then ("Finish the game you’re playing to play on from here.").

## Openings section

A full-screen section for learning openings (README "Openings"), opened with `openOpenings(target?)` from
src/openings/session.ts: the Menu's **Openings** row (`MenuSheet` `onOpenings`), the New game sheet's **Learn
openings** (`NewGameSheet` `onLearnOpenings`), the move list's opening chip (App's `Moves`: the displayed
position's name, `store.gameSummary.opening`, as `{ name, eco, color }`, resolved to its line once the data has loaded:
the line opens at the game's named position, `ply` = the moves to it, with the board from the player's side, `flipped`)
and opening practice's coach banner (`runAction('opening')`, `{ lineId, ply }`: the line at the game's move).

- **State (session.ts, main bundle, no data).** `openingsOpen`, the page stack `openingsPages` (`home` { query,
  allStarters }, `families` { side }, `family` { showAll }, `line` { lineId, ply, offBook, moreOthers, flipped, entryPly }, `tree` { path }, `drill` { lineId, color, acceptAlternatives, the
  DrillState, feedback, hint, a wrong move on show, the mastery recorded }) with `pushPage` / `popPage` (closes at
  Home) / `replacePage` / `updatePage(kind, change)` (keeps the page's key) and `rememberScroll`, and the pure step
  reducers (`goToPly`, `stepLine`, `leaveBook`, `treeAdvance`, `treeTo`). A target replaces the stack ([home,
  family, line]); no target reopens it where it was left. Each page entry keeps its own state (the search text and
  every "Show all" too), so Back returns to a page as it was, scroll position included: the content the offset
  belongs to renders with the page's first frame. A Line page opened at a position (a branch, *Learn this line*)
  keeps `entryPly` and is titled after the opening there, not after the line's far end; a target (the practice
  banner, the chip) names its line, so its page keeps the line's own title at any move. `openingsShown`
  (`setOpeningsShown`, set by OpeningsView once its code and data have loaded) is what the reload gate reads;
  `openingsLoadFailedText(nativeBuild)` is the load error's wording (no "connection" in the App Store app, which has
  everything on the device).
- **App.tsx `Openings`** renders it between the sheets and the paywall (z-index 100, later in the DOM: over the
  Menu or the New game sheet it was opened from, which stay open under it, and under the paywall), loads
  src/ui/openings/OpeningsView with a dynamic import (a spinner meanwhile, Try again on failure), and slides it up.
  Escape (`useEscapeLayer`) and the browser's or Android's Back button (one history entry while open,
  `useBackButton`) go back a page; the App's own ← → and Escape handler stands down while it is open. Closing it
  shows what it covered: the game is never paused or changed by it (the bot moves on as under a sheet). A game
  the bot ends meanwhile keeps its game-over sheet until the section closes (`finish()` defers it as for the
  explorer; the controller follows `openingsOpen`), so the sheet never mounts unseen under the section, taking
  the focus and Escape. During a rated game in progress (`playing`, not `assisted`) App passes no analysis service
  and `evalHidden`: no evaluation bar or engine verdict in the section (`EvalHiddenNote` says why), since trying
  moves on the game's positions with the engine is live help that only an unrated game may have (as the
  explorer's engine); names, book moves and guides stay. *Play* calls `controller.newGame({ ...settings, playerColor, botId,
  botElo, adaptive }, { opening })` (`openingStart(line, mode, showLineMoves)`: a catalog line by its id, any
  other line with its moves, name and family) and closes it. With a game in progress the Play sheet says what
  starting one costs (`inProgress`, as the New game sheet) and offers **Back to my game** (`onBackToGame`: closes the
  section).
- **OpeningsView** (lazy) loads the book, the catalog and the guides (`loadOpeningsData`; the search index is
  built when idle), shows the navigation bar (Back with the previous page's title, Done), the top page with a push /
  pop slide, the Play sheet, and in the installed app and the App Store app (no browser gesture) a swipe from the
  left edge for Back. Chessground measures its board once (and again only on a scroll or resize), so after a slide
  the section dispatches a `resize` (`boardsMoved`), or a tap would land on the square that used to be there.
- **model.ts** (pure, tested in node): study lines (`resolveLine`): catalog lines, a guide's own annotated main line
  (`guide:<family>`, what "Learn the main line" opens, `guideMainLine`: the guide's `mainLine` when set, else its
  longest annotated line; a game plays it by its moves, `openingStart`) and a guide's traps (`trap:<family>:<i>`,
  not playable; their `mistakes` plies are flagged like the book's known mistakes); their positions and names
  (`studySteps`); "Next variation" (`nextLineId(id, side?)`: the next line of the family that is not just the start of the
  one studied, and from a drill one the drilled side has moves in); variation titles that tell lines apart
  (`distinctTitles`: a line that shares its family's or a sibling's name adds its moves); a search's traps
  (`trapHits`, shown with the openings, locked like the guides); "Start here" easiest first (`starterFamilies`: by the own guide's level, then the curated order);
  the openings a search names (`familyHits`, shown first as a way to their page);
  where a book move leads (`branchTarget`: the line that goes on the main way, `mainContinuation`, else the most
  popular line through it, else the tree); what the tree's *Learn this line* and *Play* open; the wording (moves
  with no-break spaces, `movesSummary` for long lines, theory shares in words, the engine's verdict in words); and
  two per-device preferences (`chesscoach.openings-intro`, `chesscoach.openings-side`). `drillFeedback` follows `DrillCheck.missed`: Allow mode's first other book move
  ("is a good book move too, but this line goes another way. Try again.") shows no answer and costs nothing.
- **Evaluation** (`useEval`): the app's own `AnalysisService` (App passes the controller's), `ensure(fen, { minDepth:
  12, multiPv: 1, maxNodes: 250k, signal })` after the position has stayed put for 220 ms, withdrawn when it changes
  or the page closes, so the section has at most one short search in the queue (at the default priority, after
  the game's annotations); a cached result of depth 10 or more is shown at once. No engine yet: no number. While a new
  position is searched the bar keeps its last fill (pulsing) but drops the verdict: words such as "about equal"
  only ever describe the position on the board (`verdictFor`).
- **Pages.** Home (search, the beginner card and a link that brings it back, Start here with `starterFamilies`,
  Explore by moves, All openings, Practice: due lines (`isDue`) and recent drills), Family (who plays it, first moves, the guide, variations with
  "Show all", related families, Learn / Drill / Play), Line (the board, step controls, tap or swipe on the note
  card, auto-play, arrow keys, the move strip, the position's name, the guide's note, Other moves here, a move off
  the book with the engine's verdict, the end of the line with what to do next, `lineEnd`), Tree (book moves with
  names, theory share, main move and dubious flags, the trail, kept scrolled to the position shown), Drill (setup;
  a trap from the side that sets it; the computer's moves after 650 ms, verdicts, a wrong move shown for 900 ms
  then taken back, three hint levels, Show me, the end card, `recordDrill` once with the line's family and side:
  the other side's drills are practice runs, kept apart in `practiceRuns` / `lastPracticeAt` / `practiceBest` and
  listed under Recent drills as practice, never in the line's mastery, last run or due date; Strict counts another
  book move as a mistake and shows the line's move, Allow lets the first one go without showing it), and the Play sheet (side, preselected from the drill; start, from move 1
  only for a line that ends in mate; the line's moves as a guide; the opponent with the New game sheet's
  `EloSlider`; a warning when the side played makes a known mistake in the line, `dubiousPlayerMoves`).
- **Search** (catalog.ts `search`): names, ECO codes and moves, typed as "e4 e5 Nf3", "1.e4 e5", "1. e4 e5"
  or "1…e5" (`queryMoves` drops move numbers and dots, never a move's own digit); a name typed as one word
  ("carokann", "kingsindian": 5 letters or more) matches too; Home lists a guide's traps the query names
  (`trapHits`) with the openings.
- **Pro** (`openingGuides`, `openingDrills` in `FEATURE_TIERS`): locked guide text shows a `Teaser` with Unlock
  (`requirePro`, the paywall opens on that feature), never the text; "Drill it" opens the paywall; progress and
  mastery show only with drills. Free: browsing, search, the tree, stepping through any line (guide lines' moves
  too: the guides load for everyone) and playing. (The guide module, about 25 KB compressed, holds the Pro text
  too; it is not split, because the App Store app, the only build that sells Pro, has it on the device anyway.)

## Screen layout

`#app` is a fixed full-screen flex column padded by the safe areas; `.app` inside it is a CSS grid
and a size container, so the board is sized from the space really available
(`--app-board = min(width - eval bar, height - the fixed rows, 820px)`).

**Portrait (iPhone 15 Pro: 393×852 pt, safe areas 59 / 34)**, top to bottom:
1. Opponent `PlayerStrip` (44 px).
2. Eval bar (18 px + a 4 px gap) + board: the board takes the full width minus the eval bar (≈363 px).
3. Player `PlayerStrip` (44 px). At its right end the **Draw** toggle (a pencil pill; on a strip narrower
   than 361 px a pencil alone), and left of it the "Back to game" chip while browsing (narrow: "Back",
   and "Unrated" moves to the strip's second row when the strip is under 441 px with both). In Draw mode
   the Draw bar covers the whole strip (the strip keeps its place, so nothing moves and the board is
   never covered); the first-use tip floats under it, over the panel (above it in landscape, over the
   move list), and lets taps through to what it covers.
4. `CoachPanel` (or `ReviewPanel`): takes all remaining height (≈170 px), fixed box, text scrolls
   inside, so nothing jumps when the text changes.
5. `EvalGraph` (a 38 px row with a 32 px graph, hidden with the eval bar).
6. `MoveList` (44 px).
7. `Toolbar` (57 px): New · Undo · Hint · Explore · Flip · Coach · Menu. After the game: New · Flip · ‹ ·
   › · Explore · Menu · Review. In review: Report · Flip · ‹ · › · Explore · Menu · Close. Exploring:
   Reset · Flip · Back · Forward · Reply · Exit (Reply disabled with the explorer's engine off). Seven buttons fit a 375 px phone; a toolbar narrower
   than 340 px (the landscape side column) drops New from them (the Menu has it, and after the game the
   game-over sheet and the coach), or Flip from the review's (the Menu has it), and uses 10 px labels.

**Short phones (e.g. 375×667):** the board stays full width; when the coach slot is under 144 px
(`COACH_TIGHT_PX`: title, two lines of text and a row of actions) the coach shows as one row (class
icon, title, first sentence). Tapping it floats the full bubble over the lower part of the board
until the next move. The one threshold applies with or without actions, so the panel does not flip
between the two forms from move to move. When the game rates both your moves and the opponent's
(`store.coach.paired`), the threshold is 164 px (`COACH_TIGHT_PAIRED_PX`: the other move's row too); the
one row then has a half for each move ("You ★ Best | Pip ? Mistake"; a long name gives way to the
verdict), and tapping a half floats that move's full bubble. That panel and the explorer's have more
fixed rows (a two-line title in a narrow column; the explored move, "Best here", news): when the
expanded form leaves its text under two lines (`PANEL_MIN_TEXT_PX` = 38 px) and the text does not
fit, `PanelArea` collapses it too, for as long as the slot keeps its size (e.g. landscape phones).

**Landscape and desktop (aspect ratio ≥ 5:4):** two columns. The eval bar and the board fill the
height on the left; the right column (280–420 px) holds the opponent strip, coach / review panel,
graph, move list, your strip and the toolbar.

**Other window shapes** (media queries on the window, so Split View and rotation simply resize):
- *Short, wide portrait* (aspect 5:8 to 5:4: the iPhone Duo's outer display, Split View halves): the
  board runs out of height with width to spare, so the eval graph moves beside the move list (a
  120 px column; the opening's chip keeps its whole name beside the moves) and the strips are exactly
  40 px (no padding around their two lines): outer display 315 → 363 px. Game Review's floating
  summary, in every portrait window, shows the nearest whole number of ranks of the board above it
  (about 3 on a phone, none on these short, wide windows, where the room left is a sliver): its
  `top` from the board as drawn, `round()`ed to ranks, the board's edge taken from the registered
  `--app-board-len` set on the panel, whose own `cqw` would measure the panel (a column beside the
  move list on a big portrait screen); under `@supports`, else the max-height of portrait. Never a
  band of pieces cut in half.
- *Big portrait* (aspect < 5:4, at least 560 × 780: the Duo's inner display upright, iPads): the coach
  panel and the move list side by side under the board (the coach row at least 176 px), the graph and
  the toolbar under them: on the Duo a 453 px board with the coach expanded, instead of 533 px with
  the coach folded to one row.
- *Squat landscape* (aspect 5:4 to 3:2, at most 520 px tall: the outer display on its side): the
  toolbar runs along the bottom under both columns, so the side column can be 236 px and the board
  grows from 235 to 288 px; in a panel under 250 px the coach drops its avatar; the game viewer's header
  is two lines (about 50 px) between Back and the share button: the title, then the facts (one line,
  cut with "…") and the rating.
- Where the move list has height (big portrait, a split screen) it wraps into rows and scrolls up and
  down (MoveList centers the current move vertically then), with the opening chip under it.

**Foldable screens** (`src/layout/fold.ts`, applied by App's `useFold` to `<html>`: `data-fold`,
`data-fold-board`, `--fold-start` / `--fold-end` in viewport px; every rule keeps `--fold-clear`, 8 px,
around the fold). The game screen's children sit in two wrappers, `.app-stage` (the strips and the
board) and `.app-side` (the rest), which are `display: contents` except on a split screen, so one tree
serves every layout and a fold or an unfold is only a resize (nothing re-mounts, nothing loses state):
- `book` (side-by-side segments): the grid's columns are the first segment, the fold and the second.
  The stage (a size container, so `--app-board` is measured in it) centers the board between its
  strips in the board's segment (the first, or the second when the system UI is on the left: the
  segment clear of it); the side is a column: coach / explorer / review panel (a steady box up to
  340 px; the report takes more), graph, the move list in rows, the toolbar, inside the safe area.
- `tabletop` (top and bottom segments): the stage in the top one with the strips beside the board; the
  side in the bottom one, the coach and the move list side by side, then the graph and the toolbar.
- The game viewer (GameViewer.css) has the same wrappers, its header heading the side; sheets
  (Sheet.css) open in the panel's segment inside its safe area, or in the bottom half (the game-over
  sheet and the paywall in their compact form there); the toast (inside the safe areas, as everywhere)
  and the error screen move to the panel's segment, the Openings section's loader too (tabletop: to
  the top half, sized from the fold rather than from `100dvh`, which iOS standalone mode reports
  short). The boot splash stays centered on the whole screen, where the launch screen before it shows
  the mark (the App Store app's fades out over it; the web app's launch images are centered too), so
  the mark never jumps sideways. In the light theme of the installed web app, a band in `#1d1c1a` runs
  down the side the status bar is on (`body::after`, src/styles/app.css), as the top band does on a
  phone.
- **The Openings section** (App passes `split`, the layout's kind, to OpeningsView): the text pages
  (Home, All openings, a family) show two at a time, one per segment, each a `.op-pane` with its own
  bar and scroll: the list (the page under the top one, or the top one alone with an empty "Choose an
  opening" pane beside it) and the page it opened. The list's choices replace the page beside it
  (session `pushPageOver(key, page)`), and its own state (search text, Show all, the side filter)
  updates by key (`updatePage(kind, change, key)`); Back, Escape and the browser's Back pop the top
  page as before, and the list's bar has Back only when the list is not Home. A page keeps its scroll
  offset as it moves between panes or through a fold (OpeningsView's `scrolls`, by page key). The
  board pages (learn, tree, drill) stay one page: book, the board in the board's segment (the second
  when the system UI is on the left, as on the game screen, with the title over the text's segment)
  and the rest a page margin from the fold; tabletop, the board sticky in the top half while the rest
  scrolls under it in the bottom half. One page alone is the same keyed `Pane` as a split screen's
  list, so a fold or an unfold keeps the page on top (and a search field, its focus and the keyboard)
  instead of re-creating it; where a re-created tree drops the focus (a page change gives the bar
  new buttons), the control with the same `data-id` takes it back.
- Narrower things: on a tabletop screen the player strips are a column beside the board, so
  "Unrated" goes to their second row, the explorer's and Try again's tag hangs under the top strip
  and the "Back to game" chip over the bottom one, clear of the names. The engine self-test page
  (`?enginetest`, which has no App around it) watches the fold itself and puts its log in the second
  segment. Text columns are capped at about 70 characters (Openings.css, the self-test page).
- Narrow windows (the outer display, Split View): a sheet stays clear of system UI along a side
  (`max-width` between the insets); Learn's step controls are six buttons of at least 44 px in a row,
  or two rows of three in a column under 284 px (beside the board on a squat landscape page, where the
  learn, drill and tree boards all keep half the width); on a short, wide portrait page the Learn
  board leaves room for the controls, the moves and the note;
  the game viewer's header in the squat landscape column puts the facts and the rating under the
  title; a floating review summary never grows over the opponent's strip in portrait, and in a
  landscape column, where it hangs from the top, the strip it covers is hidden (on phones too: its
  avatar used to peek past the summary's round corner).
- Detection order: the Viewport Segments API (two segments: split in any posture); else, on an iPhone
  (or the iPadOS-style Mac user agent with touch on a screen smaller than any iPad) whose screen's
  short side is ≥ 540 px and long/short ≤ 1.6, the heuristic fold across the middle of the long side:
  in landscape while the window is as wide as the screen and at least 75% as tall (the installed
  app, or a Safari tab under its toolbars), split; in portrait while the window covers the screen,
  only when the posture is 'folded'. The Device Posture API gives the posture
  (`navigator.devicePosture`, else the `(device-posture)` media feature); WebKit has neither, so in
  Safari and the App Store app half folded needs the setting. The "Foldable screen" setting
  (localStorage `chesscoach.fold`) forces the split (using the assumed fold when nothing reports one)
  or the whole screen; the assumed fold, and so the setting, exists only on a touch screen shaped like
  an inner display (iPads too: size can't tell them apart, nor an @2x Duo with the Mac user agent,
  which Automatic leaves whole), never on a phone or the outer display. The safe areas are re-read
  without a resize too (two hidden boxes as big as them, under a ResizeObserver: a turn by 180° moves
  the system UI to the other side at the same size). The estimates are `FOLD`; the window-shape
  thresholds above are the other place to recheck against the real point sizes.
- Resizing never re-creates the board: Board's ResizeObserver redraws it at the new size and ends a
  drag or a selection started on the old one; Draw mode drops a gesture in progress on a resize.

**Themes:** dark by default; Light and Automatic (follows iOS) in the menu. `theme.ts` and an inline
script in `index.html` set `<html data-theme>` before the first paint.

## Native iOS app (App Store)

The App Store app is the same web app in a [Capacitor 8](https://capacitorjs.com/) shell
(`@capacitor/ios` 8.5.2, MIT): a WKWebView that serves the built files from inside the app at
`capacitor://localhost/`. `ios/README-native.md` covers the Xcode side in detail.

### Build modes

| Build | How | Output | Service worker | Store (`getPurchases()`) | Pro |
|---|---|---|---|---|---|
| Web app (PWA) | `npm run build` | `dist/`, base `BASE_PATH` | yes (vite-plugin-pwa) | `AlwaysUnlocked` | everything unlocked; no paywall, lock or Pro row |
| Paywall test | `VITE_PAYWALL=1` on any web build (the second Playwright server, `scripts/appstore-screenshots.mjs`) | wherever it is built | as the build | `MockPurchases` | locked until a mock purchase |
| App Store app | `npm run build:native`, then `npm run cap:sync` | `dist-native/`, base `/`, copied to `ios/App/App/public/` | none | `NativePurchases` (the Store plugin) | locked until bought |

- `nativeBuild` (`import.meta.env.VITE_NATIVE === '1'`) is a build-time constant: no service worker
  (`virtual:pwa-register` is a stub), no "Available offline" (the `offline` signal stays null), no source maps, no Safari launch images,
  web-only files left out of `dist-native/`, and `THIRD-PARTY-LICENSES.txt` lists Capacitor's native
  code (MIT, with Apache-2.0 Cordova code) instead of Workbox. `vite.config.ts` also copies `APP_ID`
  and `APP_NAME` (`capacitor.config.ts`) and the `package.json` version into the Xcode project
  (`PRODUCT_BUNDLE_IDENTIFIER`, `CFBundleDisplayName`, `MARKETING_VERSION`), and injects
  `VITE_APP_NAME`, `VITE_APP_VERSION` and `VITE_SOURCE_URL` (in the native build the exact commit,
  `tree/<git HEAD>`, unless `VITE_SOURCE_URL` is set, e.g. to the release workflow's build tag). A native
  build from uncommitted changes warns, and fails with `RELEASE_BUILD=1` (`npm run build:native:release`).
- `isNative` is true only when the native runtime is there too (`Capacitor.isNativePlatform()` on the
  global the bridge injects), so `dist-native/` opened in a browser behaves like the web app.
- `paywallEnabled = isNative || VITE_PAYWALL === '1'`: whether Pro is sold (locked until bought).

### src/native/

```ts
// platform.ts — the only module that imports Capacitor: each import sits behind `nativeBuild` in this
// module, so the web build drops them (an import elsewhere behind an imported flag would still become a
// chunk and land in the PWA precache).
export const nativeBuild: boolean; export const isNative: boolean; export const paywallEnabled: boolean;
export const APP_NAME: string; export const APP_VERSION: string;
export const LEGAL_URLS: { privacy: string; terms: string; support: string }; // public/*.html on GitHub Pages
export const nativePlugins: { core(); haptics(); preferences(); share(); splashScreen(); statusBar() }; // reject on the web

// purchases.ts — the store contract (failures are results — 'failed' / 'cancelled' / null — except that
// isUnlocked() rejects when the store cannot be asked at all, so a paying player's cached Pro is kept)
export const PRO_PRODUCT_ID: string;                    // 'io.github.atgy2k.chesscoach.pro'
export interface ProProduct { id: string; title: string; description: string; displayPrice: string }
export type PurchaseResult = 'purchased' | 'cancelled' | 'pending' | 'failed';
export type RestoreResult = 'restored' | 'none' | 'cancelled' | 'failed'; // failed: the sync failed (offline), not "none"
export interface Purchases {
  getProduct(): Promise<ProProduct | null>;  // null: store unavailable
  isUnlocked(): Promise<boolean>;            // verified, unrevoked entitlement (Family Sharing included); offline;
                                             // rejects if the plugin is missing or the call fails (unknown ≠ locked)
  purchase(): Promise<PurchaseResult>;
  restore(): Promise<RestoreResult>;         // AppStore.sync(), then isUnlocked; never rejects
  onChange(cb: (unlocked: boolean) => void): () => void; // Transaction.updates: Ask to Buy, other devices, refunds
}
export function getPurchases(): Purchases;  // NativePurchases | MockPurchases (window.__mockStore) | AlwaysUnlocked
```

- `storage.ts`: iOS may purge a web view's localStorage when space runs low, so every `chesscoach.*`
  key is mirrored to `@capacitor/preferences` (UserDefaults). `prepareNativeStorage()` restores missing
  keys at startup (at most 1.5 s for the plugin and key list, then up to 5 s for the values, read in
  parallel; nothing is written after it gives up), then wraps `Storage.prototype` to write changes
  through. Backed-up keys it could not restore are held (never written through this session) and
  listed under `chesscoach-native-unrestored`, so the next launch restores them over the defaults the
  app started with. The plugin proxy is always passed boxed (`{ prefs }`), never as a promise's value.
- `haptics.ts`: `withHaptics(soundPort, isSoundEnabled)` plays a haptic with each game sound while
  Sound is on.
- `share.ts`: `installNativeShare()` backs `navigator.share` with the iOS share sheet, so App.tsx's
  PGN export is unchanged (closing the sheet rejects with an AbortError, like Safari).
- `statusbar.ts`: the status bar follows `<html data-theme>` (a MutationObserver); `hideSplash()`
  hides the launch screen after the first frame, or on an error.

`main.tsx` in the native app: theme, iOS guards, status bar, native share and error hooks for the
launch screen; then `prepareNativeStorage()` before the controller is created (the saved game, rating
and settings must be back first); the controller gets the haptics sound port; no service worker.

### StoreKit plugin (ios/App/App/StorePlugin.swift)

The app's own Capacitor plugin, `jsName` `"Store"`, registered by `MainViewController`
(a `CAPBridgeViewController` subclass that `SceneDelegate` creates) in `capacitorDidLoad()`. StoreKit 2,
no server: StoreKit verifies each transaction's signature on the device, and only verified ones count.

| Method / event | Does |
|---|---|
| `getProduct({productId})` | `Product.products(for:)` → `{id, title, description, displayPrice}`; rejects if unknown or offline |
| `isUnlocked({productId})` | a verified `Transaction.currentEntitlements` entry for the product without `revocationDate` (StoreKit's on-device cache) |
| `purchase({productId})` | `product.purchase()` (in the app's window scene on iOS 17+) → `purchased` (verified, then `finish()`), `cancelled`, `pending` (Ask to Buy), or `failed` with `error` |
| `restore({productId})` | `AppStore.sync()` (may show the sign-in), then the entitlement check even if the sync failed → `{unlocked, error?}` (`error` is `"cancelled"` for a closed sign-in); `NativePurchases` maps it to `restored` / `none` / `cancelled` / `failed` |
| event `entitlementChanged` `{productId, unlocked}` | for each `Transaction.updates` item (listened to from `load()`, i.e. launch): finish it if verified, check the entitlements again, notify on the bridge's queue |

`loadStorePlugin()` checks `Capacitor.isPluginAvailable('Store')` first and logs a `console.error` once if
the plugin was not registered (e.g. SceneDelegate creating a plain `CAPBridgeViewController`); every call
then fails as "unknown", so a cached Pro stays unlocked.
`ios/App/App/Products.storekit` is a local StoreKit configuration (Pro at $9.99, Family Sharing on) that
the shared `App` scheme uses when running from Xcode; it is not copied into the app.
`NativePurchases` (purchases.ts) wraps the plugin, passes `PRO_PRODUCT_ID` with every call, and reports
`onChange` only when an event changes the known state. `tests/native/purchases.test.ts` checks that
the JavaScript and Swift method and event names match.

### Entitlements and the paywall (src/game/entitlements.ts)

```ts
export type ProFeature = 'coachExplanations' | 'hint' | 'showBest' | 'bestMoveArrows' | 'threatAlerts' | 'reviewDetails'
  | 'explorer'                             // the explorer itself: 'free' (moves on the board, no engine)
  | 'explorerEngine'                       // the engine in the explorer (eval, arrows, Best here, ratings, Reply): 'pro'
  | 'openingGuides' | 'openingDrills';     // the Openings section's guide text, and its drills with saved progress
export const FEATURE_TIERS: Readonly<Record<ProFeature, 'free' | 'pro'>>; // THE free / Pro split
export const PRO_NAME: string;              // `${APP_NAME} Pro`
export const PRO_CACHE_KEY = 'chesscoach.pro';
export interface Entitlements {
  readonly enabled: boolean;                       // paywallEnabled
  readonly pro: ReadonlySignal<boolean>;            // always true when not enabled
  readonly locked: ReadonlySignal<ReadonlySet<ProFeature>>;
  readonly product; readonly productState; readonly status /* idle | buying | restoring | pending | success | failed | restoreNone | restoreFailed */;
  readonly paywall: ReadonlySignal<{ open: boolean; feature: ProFeature | null }>;
  isAllowed(f): boolean; requirePro(f): boolean /* else opens the paywall */; openPaywall(f?); closePaywall();
  loadProduct(); buy(): Promise<PurchaseResult>; restore(): Promise<RestoreResult>; dispose();
}
export function createEntitlements(opts: { enabled: boolean; purchases?; storage?; tiers? }): Entitlements;
export function getEntitlements(): Entitlements; // the app's one instance (the controller's default)
```

- A purchase that waits for a parent (`pending`, Ask to Buy) is remembered (`PRO_PENDING_KEY`,
  `chesscoach.pro-pending`, for `PENDING_TTL_MS`, 7 days): after a restart the status starts as `pending`, so the
  Menu still says "Waiting for approval"; Pro unlocking clears it, and a transient status (a failed restore, a
  cancelled purchase) falls back to `pending` while it lasts. `createEntitlements({ now })` takes a clock for tests.
- `pro` starts from the cached flag (`PRO_CACHE_KEY`, so the first frame is right), is confirmed by
  `isUnlocked()`, and follows `onChange`, purchases and restores; the store's answer always wins (a
  rejected `isUnlocked()` is no answer: the cached flag stays). Restore: `none` → `restoreNone`
  ("No earlier purchase…"), `failed` → `restoreFailed` ("Couldn't reach the App Store", Try again),
  `cancelled` → `idle` (nothing said).
- **Always free:** every bot at any Elo, the rating, the evaluation bar and graph, move classes and
  badges (also the opponent's, `rateOpponent`), accuracy, takebacks and Retry, the explorer with its
  engine off, Draw mode (no feature in `FEATURE_TIERS`: nothing gates it), PGN export. The engine still analyzes every move of the game either way;
  only what the view models show is gated.
- **Gating** (`GameController.entitlements`; the store gets `locked`): the coach panel keeps the
  verdict and the class icon (also on the opponent's moves) but replaces the explanation with `lockedTeaser()` (game/coach.ts: what
  the coach would explain, never the answer) and an "Unlock to see why" action; Show best shows a lock
  and opens the paywall (`runAction`); the toolbar's Hint shows a lock and `requestHint()` opens the
  paywall instead of the "unrated" question; no arrows are drawn from locked features; best-move arrows
  and threat alerts (Menu, New game sheet) open the paywall instead of switching on; *Show me* (the punishment of
  the opponent's mistake) opens it for Show best, while the question and "You punished it!" stay free; the review keeps accuracy and
  counts but shows a locked key-moments card (`ReviewPanel` `lockedMoments` + `onUnlock`), so Try again is not
  offered (`tryAgain()` opens the paywall for `reviewDetails`); Explore
  opens the explorer (free) with its engine off, and its Engine switch shows a lock and opens the
  paywall (`requirePro('explorerEngine')`: no "unrated" question, no rating effect; after the game too).
  When features become locked again (a refund), `onLocksChanged()` closes a hint or Show best, switches
  the explorer's engine off, turns arrows and threat alerts off and ends a Try again.
- **UI:** `PaywallSheet` (the store's localized price on the Buy button, Restore Purchases, the
  Privacy Policy and Terms of Use links, thanks then closes after a purchase); the Menu's Pro section
  (Unlock / "Unlocked ✓" / "Waiting for approval", Restore Purchases); a toast when Pro unlocks while the
  paywall is closed (Ask to Buy approval, a purchase on another device). While the paywall is open or a
  purchase runs, `canReloadNow()` is false.

### Xcode project and release

- `ios/App/App.xcodeproj` (scheme and target `App`), Swift Package Manager: `ios/App/CapApp-SPM/Package.swift`
  (rewritten by `cap sync`) pulls `capacitor-swift-pm` and the plugins from `node_modules/`, so
  `npm ci` comes before any Xcode build. iOS 16.4+ (WebAssembly SIMD), iPhone only; every
  orientation in `UISupportedInterfaceOrientations` (iOS has no per-model key; iPad-style multitasking
  wants all four), narrowed at run time by `MainViewController.supportedInterfaceOrientations` to
  portrait on a tall phone screen (long/short > 1.6: every iPhone but the Duo); one scene; see
  ios/README-native.md for the iPhone Duo, `ITSAppUsesNonExemptEncryption = NO`, `PrivacyInfo.xcprivacy` (UserDefaults, reason CA92.1).
- `.github/workflows/ios-build.yml`: on pushes and pull requests that touch the app, a `macos-26`
  runner with the latest stable Xcode runs `npm ci`, `build:native` and `cap:sync`, resolves the
  Swift packages, and builds Debug for the Simulator and Release for devices with
  `CODE_SIGNING_ALLOWED=NO`; compiler errors and warnings in `ios/` become annotations, and the logs are
  uploaded on failure.
- `.github/workflows/ios-release.yml`: on a tag `v<version>` (must equal `package.json`) or by hand.
  A `prepare` job (the only one that may write to the repository; it runs no npm packages) checks the
  secrets, the version and the legal pages (`scripts/check-legal-pages.mjs`, fatal on a tag), and tags
  the commit `ios-v<version>-b<build>`; then the `testflight` job runs the unit tests,
  `build:native:release` with that tag as `VITE_SOURCE_URL`, `cap:sync`, `MARKETING_VERSION` from `package.json` and
  `CURRENT_PROJECT_VERSION` = run number + `vars.IOS_BUILD_NUMBER_OFFSET`, then codemagic-cli-tools
  (App Store Connect API key + a distribution-certificate key from repository secrets) create or reuse
  the certificate and App Store profile, archive, export and upload to TestFlight.
- GPL: every App Store build links to its exact source (its `ios-v<version>-b<build>` tag, or the commit);
  the released version is also tagged `v<version>`.
  `docs/APP_STORE.md` is the owner's release checklist; `docs/EULA-draft.md` (= `public/terms.html`)
  is the custom license agreement, which defers to the GPL.
- `scripts/appstore-screenshots.mjs`: builds `VITE_NATIVE=1 VITE_PAYWALL=1` into
  `node_modules/.cache/chess-coach-screenshots`, serves it with `vite preview` on port 5640, seeds
  storage (profile, settings, a saved game from a fixed move list, the mock purchase), drives the app
  through `window.__chessCoach.controller` with the real engine, applies a 6.9-inch iPhone's safe areas
  (and draws a status bar), and saves 1320 × 2868 RGB PNGs to `appstore/screenshots/`: 01–04 for the
  product page (screens with a Pro feature get a "Pro · in-app purchase" tag, Guideline 2.3.2) and
  `iap-review/paywall.png`, the in-app purchase's review screenshot (it shows the price).

## Deployment

A GitHub Actions workflow (`deploy.yml`) runs the unit tests and the e2e tests against a
`BASE_PATH=/chess/` build, then builds with `BASE_PATH=/chess/` and deploys to GitHub Pages; `ci.yml`
runs the same checks on branches and pull requests, with the e2e tests at both `/` and `/chess/`.
Other static hosts (Cloudflare Pages, Netlify) work with `npm run build`, output `dist`, and
`BASE_PATH=/`. A public site must also offer the source: the repository is public, and the app links
to it (see README "Hosting" for hosting from a private fork: `npm run build:source` +
`VITE_SOURCE_URL`). The site also serves `privacy.html`, `terms.html` and `support.html` from
`public/` (static, self-contained pages) for the App Store app. The App Store app has its own workflows
(`ios-build.yml`, `ios-release.yml`, see [Native iOS app](#native-ios-app-app-store)).

Service worker (`vite.config.ts`, Workbox `generateSW`):
- It precaches the whole app, including the engine `.js` + `.wasm` and the license notices, so it
  works offline: 29 files, about 3.9 MB (the engine `.wasm` 1.8 MB, the opening book 0.9 MB, the Openings
  section's lazy chunks: its lines 0.4 MB, guides and screens; about 1.7 MB gzipped), the privacy, terms and
  support pages included. Hashed `assets/` and the engine files (versioned by name; `ENGINE_FILES` pins
  their SHA-256 and fails the build if they change) are precached without a revision, so the first
  visit can reuse the engine download from the HTTP cache instead of fetching it twice.
- The first install is all or nothing: if one download fails, the browser deletes the registration.
  `pwa.ts` then registers again (when the app comes back online or to the front, hourly, and on its
  own after 30 s, doubling up to an hour), so a dropped connection on the first visit does not
  leave the app without offline support until the next launch.
- The manifest `id` is the absolute base path (`/chess/`): unlike `start_url` and `scope` it is
  resolved against the origin, so `.` would make the app's identity the whole origin.
- Only the app's own URL (`<base>`, `<base>index.html`, any query) falls back to the cached
  `index.html`; other paths (`engine/COPYING-stockfish.txt`, `THIRD-PARTY-LICENSES.txt`, typos) get
  the real file or a 404.
- `build.license` writes `THIRD-PARTY-LICENSES.txt` (completed with the app's own license notice,
  its source URL `VITE_SOURCE_URL`, and the Workbox runtime), and license comments are kept in the
  minified code. The same `VITE_SOURCE_URL` feeds the About section's Source code link.

## Tests

- `npm test`: Vitest unit tests in node, about 1,380 tests in 75 files (the one test in
  `tests/bot/calibration.slow.test.ts` is skipped unless `CALIBRATE=1`, see `npm run calibrate`). They
  cover pure logic, the engine layer against scripted transports, the controller against a fake
  engine and a scripted bot (`tests/helpers/fakeEngine.ts`), the store's view models, UI helpers, the
  service-worker registration keeper and reload gate, and some real-engine checks that run the
  vendored Stockfish WASM in node (`tests/helpers/nodeTransport.ts`: engine searches, the position
  history, bot mates and conversions). `tests/layout/fold.test.ts` covers foldable screens: detection (the
  iPhone Duo's inner display in both orientations, from Safari's portrait-only screen size and a rotating
  one, in the App Store app and with the iPadOS-style desktop user agent; never the outer display, regular
  iPhones, iPads or desktops; Split View windows; the @2x size; the segments API's data, sorted, and its
  one segment; the posture; a Safari tab held like a book, not upright; the Mac user agent at @2x left
  whole), the layout each setting gives (Automatic's book and tabletop rules, a hinge mask, Keep the board
  off the fold with an assumed fold, and never on the outer display, phones or desktops, Use the whole
  screen, the board on the side away from the system UI, panes too small to split), `watchFold` re-reading
  the safe areas without a resize, and the setting's storage. `tests/native/` covers src/native (platform flags, haptics,
  the storage mirror, share, and the purchases contract against a fake Store plugin, including that
  the JavaScript and Swift names match); `tests/game/entitlements.test.ts` and `paywall.test.ts` cover
  Pro's state and the gating in the controller and the view models; `tests/game/explorer.test.ts` the
  explorer's state and `explorer.controller.test.ts` the explorer in the controller and the store (its
  engine off during a game: no `position`/`go` for an explored position, checked on a real
  StockfishEngine over a scripted UCI transport, `tests/helpers/uciTransport.ts`, and nothing shown even
  for positions the engine knows; the switch, its question and when it is dropped (a refund too), per-game
  memory, Pro; the position on the board analyzed before a backlog of ratings; a rating that throws failing once);
  `tests/game/feedback.controller.test.ts` feedback first with a fake engine whose results land when the test says
  (FakeEngine `manual`): the bot's reply held, still thinking, until the verdict on your move is shown, no extra wait
  when it is already there, the cap, no wait with the coach off or after a move that ended the game; the verdict's
  lead (the reply a lead after the verdict, not in the same task; nothing added when it was up during the bot's
  think, only what is left of it, within the cap, Undo and coach off during it); every path that lets the reply go or
  drops it (the check failing, a check that threw, the engine breaking, Undo, a takeback asked for in a rated game, a
  new game, resigning, the page hidden and shown, the coach switched off, the explorer, the Openings section, the game
  viewer); the near-equal second opinion before the verdict (SECOND_OPINION's request, the words never changing, "You
  punished it!" with the verdict and the panel staying on your move); your move's searches ahead of the threat probes
  and the opponent's rating, and an earlier move's search your verdict waits for asked at its priority (and kept
  running); the dual coach following the game forward; `tests/engine/AnalysisService.test.ts` also covers the
  priorities (the queue's order, a higher one pre-empting the running search, which comes back first among its own;
  joining lifts a search, withdrawing lowers it; the live search always yields; nothing pre-empted while paused);
  `tests/game/accuracyNote.test.ts` weak moves in a won game (`wonAnyway` from the mate-distance rules and never
  otherwise, a slower mate the reply's search misses, the history's tokens and the derivation for records kept
  before them for either color, only ever an inaccuracy; the coach's line for you and the opponent with Try again, a
  rated game in the viewer and Pro locked, none for a real mistake, the collapsed row's summary; `weakInWonGame` by
  the evaluations accuracy uses and the count, the user's "99% with 9 inaccuracies" game also as Black, every wording
  of the note ("that’s why" only for most of them, the threshold as shown), the game-over sheet's short form and its
  Try again count, Game Review's report and the game viewer's for records kept before and now);
  `tests/analysis/nearEqual.test.ts` and `tests/game/nearEqual.controller.test.ts` near-equal awareness (the rule
  and its constants, the second opinion, `equalBest` / `nearBest` / `aboveBest` from fixed engine lines, every
  wording, the Kieseritzky 5...Be7, a mate or repetition draw above the best line, and the user's 3...Nxd5 case,
  also at the edges of the band seen with the real engine, through the controller: feedback, Show best's title,
  lines and arrows, the opponent's move, Game Review, the explorer, Retry, Pro locked, a restored game and an older
  save; the fake engine's `fixed` lines), and `tests/analysis/nearEqual.engine.test.ts` the user's case with the real
  engine in three histories that put 3...Nxd5 outside the band of the best line (kept "about as good" by the second
  opinion, with the annotation request and with SECOND_OPINION);
  `tests/game/opponent.test.ts` the opponent's move ratings (the view models with the coach and the
  setting on or off, the two rows, rated games and the question, Show best, the Pro gating, the review
  unchanged); `tests/game/punish.test.ts` "can you punish it?" (the wording and `punishmentOf`; hidden until Show me
  or a hint, no best-move arrow, browsing back; "You punished it!" kept open, "The punishment was …" said once; the
  coach off; Retry naming nothing and asking again; Undo; persistence and a restore; threat alerts pointing at the
  punishment or not, and waiting for the opponent's verdict; Pro); `tests/analysis/threat.test.ts` the probe's verdict
  and words from fixed results (a fork, a mate threat, a piece won, small threats, an escaping piece, mated anyway, in
  check, the budget, withdrawn and failed searches), `tests/analysis/threat.engine.test.ts` the same with the real
  engine (the Two Knights' Nxf7, the Scholar's mate, quiet positions, a hanging queen), and
  `tests/game/practice.test.ts` Try again's pure part (the moves to try, as Black and with preplayed moves, a try's
  transitions, what counts as better, the answer's move, hints and wording) and `tests/game/practice.controller.test.ts`
  Try again in the controller and the store (the review's buttons and the coach's action, the position and views,
  nothing naming the answer, the game's own move, a move taken back, hints and their circle, a near-equal and the best
  move, Show answer, after the game outside the review, Play on from here (unrated, saved, restored, rematched, the
  history, rating and New game defaults untouched), an earlier game with Next mistake, never abandoning a game in
  progress, and Pro with a refund);
  `tests/game/archive.test.ts` the history's compact analysis (scores, the round trip with flags, better moves and the key
  moments' headlines, a checkmate, malformed or mismatched data, preplayed moves), the moves from a PGN (a [FEN] start, none),
  the opponent of a record, the annotated export, and the sizes (a 60-move game and 200 of them, and loading them);
  `tests/rating/history.test.ts` the rating chart's data (empty, rated games only from the start, the peak and a level above
  it, new-rating runs recorded and inferred, a full history, the words, the ticks) and the record's new fields (round trip,
  malformed ones dropped, the order a save over the quota slims the history in); `tests/game/viewer.controller.test.ts` the
  game viewer (a finished game's record keeping its analysis; an earlier game opened over a game in progress: header, final
  position, comments, stepping, flip, Draw, the game and the rating untouched, Back to the Menu; an older record analyzed by
  Review with its progress and kept; Try again and back; Play here, also from the final position and never over a game in
  progress; the export; a game that ends while it is open; Pro);
  `tests/game/threat.controller.test.ts` threat alerts in the controller (the setting and older settings, the alert
  and its arrow after the bot's move from two small searches, never stale, memory across a takeback, check, the
  explorer, browsing and the review, the question in a rated game and from the Menu, never in a rated game, Pro and a
  refund); `tests/ui/threatAlerts.test.ts` their wording in the sheets; `tests/game/opening.test.ts` and `opening.controller.test.ts` opening practice (`lineProgress` with
  transpositions; steering, the line move's abort paths (hidden page, undo, new game), leaving the line, undo
  back onto it, the arrow, notes and banner, 'skip' with its preplayed moves, PGN and review, unrated games,
  rematch, persistence and older saves, Pro locked; a guide's line played by its moves and restored from them; the
  New game defaults kept; a mate line stopping short in 'skip'; a known mistake's line move; the game-over sheet
  and the reload gate while the Openings section is open). `tests/openings/` covers the openings core (catalog,
  tree, drill, progress per side, guides with their trap mistakes and main lines, session) and `tests/ui/openings.test.ts`
  the section's view logic (study lines, what a game plays, Next variation, Start here's order, search's openings,
  the end of a line, verdicts only for the position shown). Draw mode: `tests/ui/draw.test.ts` (a pointer to its
  square for both orientations and two board sizes; a tap's circle, a sloppy tap, a drag's arrow and its preview,
  a drag back to its square or off the board, a fast drag) and `tests/game/drawings.test.ts` (the position key
  ignoring castling, en passant and the counters; the same shape again off, another color recolored, a
  zero-length arrow as a circle, Clear on one position); `tests/game/draw.controller.test.ts` the controller and
  the store (only with a game on the board, the board's view, drawings by position while moving and browsing,
  shared with the explorer, Game Review, a new game clearing them, what ends Draw mode and what keeps it (the
  game ending in the background while exploring keeps it), "your move", a drawing for a position the board has
  left dropped, the game staying rated and unsaved, free with Pro locked, the first-use tip remembered from the
  first drawing and a failing storage). `tests/game/playthrough.test.ts` and `tests/analysis/playthrough.test.ts`
  pin the fixes from a full playthrough: Set my level during a rated game (applied after it, the peak), Rematch's
  opponent after a restart, the Menu's question returning to it, Undo with both moves rated, a hint kept over a
  reload, PGN marks in a rated game, a threefold repetition the move allows, the explorer's repetition voice, the
  coach off (no graph dots), the finished game's coach (the deciding move, the draw rule), captured pieces after a
  promotion, Show best's "at least as good", a mate's "even quicker", the king walk in the opening (Ke3, Kf1 out of
  check), the moves that end a game by rule, an engine line cut at a repetition, a disputed MultiPV score, and key
  moments (numbering from any start, the player's first, whose move).
- `npm run e2e`: Playwright on the production build with the real engine, iPhone 15 Pro emulation,
  79 tests. `e2e/pwa.spec.ts` (7) checks the PWA shell (manifest and its `id` and `orientation: any`, iOS
  tags and the launch images in both orientations, engine MIME
  types, service worker and precache, offline, license notices served as files, full-screen layout);
  `e2e/game.spec.ts` (15) plays through the UI (moves by tapping squares, coach, hint, undo, flip,
  reload, resign, review, a game as Black, a mating promotion, the move list staying on the current
  move when a review starts or the phone is rotated, coach readability at six phone heights, a
  position that needs millions of nodes, landscape (the Unrated pill
  and the Back to game chip, the coach verdict, the floating review header), the starting level and
  Set my level, the Engine rows and compatibility mode, "Available offline", download progress on
  the splash, a failed download that recovers when back online, and `?enginetest`).
  `e2e/explorer.spec.ts` (4): the explorer during a rated game (no question, the engine off: no eval bar,
  arrows, badges or Reply; moves for both sides by tapping squares, Back, Play, still rated; then the
  Engine switch: the question, Keep off, Turn on and the Unrated pill, ratings and eval, arrows, Best here,
  Reset, Reply, off again, Exit; Reply disabled in its place, the toolbar not moving), a selection or promotion
  picker that never carries over between the game and the explorer, the game's news on a short phone and the
  collapsed panel with its Engine switch beside the row, the switch (still in sight after it is switched) and Flip
  and the "Exploring" tag in landscape, and in Game Review (the engine on).
  `e2e/opponent.spec.ts` (3): "Rate opponent's moves" switched on in the New game sheet (unrated, the bot's
  badge, rating and verdict, both rows of the coach panel and the halves on a short phone), in landscape
  with a long bot name (no squeezed text, whole verdicts) and in the Menu during a rated game (Cancel,
  then the question and the Unrated pill; either answer goes back to the Menu).
  `e2e/coach-tools.spec.ts` (3): a threat alert after the bot's only move (the warning, its role, the threat arrow, gone
  once you move); threat alerts switched on in the Menu during a rated game (Cancel keeps it rated, Turn on: Unrated);
  "can you punish it?" after the bot's 2…Qh4 (an opening line it follows; nothing names Nxh4, Show me offered, no arrow;
  "You punished it!" after Nxh4).
  `e2e/feedback.spec.ts` (1): against Pip with the analysis slowed through the debug hook (every result 0.8 s late),
  the coach's verdict on each of three moves is on the screen before the bot's reply appears in the move list, and the
  bot shows as thinking meanwhile.
  `e2e/practice.spec.ts` (1): Try again from Game Review after 3. Qxf7+?? (the key moment's button and its name, Back
  to the review and again, a move that is no better taken back with its arrow, a hint naming the piece and never the
  answer, the engine's move found, Play on from here: an unrated game from that position, the earlier game once in
  the history).
  `e2e/history.spec.ts` (2): a game resigned, then the Menu's rating chart (its point, the readout, View game), the game
  viewer (header, stepping, Export PGN with the analysis through the clipboard, Review's key moment, Try again on the game
  screen and back, Back to the Menu); an older record without analysis (seeded) opened from Recent games: "Not analyzed",
  Review's progress bar, the record keeping the analysis and accuracy.
  `e2e/opening-game.spec.ts` (3): opening practice started through the debug hook: the bot following the line, the
  line move's arrow and coach line, the banner, leaving the line said once, a tap on the banner opening the line in
  the Openings section (Done returns to the game as it was); 'skip' with a reload; the collapsed coach on a short
  phone and the banner in its floating panel.
  `e2e/openings.spec.ts` (4): the Openings section from the Menu (the beginner card, Start here, a family, Learn
  with notes and branches, Back, a move off the book, Explore by moves, search with the opening first and Back to
  the results, a drill as Black, progress, Play following the guide's line), from the New game sheet and a game's
  opening chip (no evaluation during a rated game), offline, and its speed on a slow small phone.
  `e2e/draw.spec.ts` (5): Draw mode during a rated game with real touch events through the DevTools protocol (the
  first-use tip, a touch drag's arrow, a tap's circle, taps that move no piece, the same circle again off, a mouse
  drag, recoloring, a drag back to its square or off the board and a two-finger touch drawing nothing, a flipped
  board, Clear, Done, pieces moving again, the drawing back when browsing to its position, no page scroll, still
  rated; the tip letting taps through, the turn cue; the player's arrows dashed), the explorer sharing the drawings
  with Escape leaving Draw mode then the explorer and a sheet ending it,
  Game Review (a gesture whose board changes before the finger lifts drawing nothing; the explorer's solid engine
  arrows beside the player's dashed ones), the bar on a short phone and in landscape (inside its strip, clear of the
  board), and the Openings section's Learn board (by position, Escape and the header's Done leaving Draw mode first,
  forgotten when the section closes).
  `e2e/paywall.spec.ts` (10) runs against a second build made with `VITE_PAYWALL=1` (playwright.config.ts
  serves it on port 4174) and steers the mock store through `window.__mockStore`: the locked coach,
  Hint and Show best, the paywall and a purchase, cancelled / failed / pending (Ask to Buy) purchases,
  Restore Purchases (also cancelled and offline) and a refund, the locked key moments of Game Review (no Try again
  until Pro is bought),
  the explorer free with its engine locked (the switch's lock and paywall, no question, still rated, Escape closing the
  paywall and not the explorer under it), Draw mode free
  (no lock or paywall, still rated), the opponent's move ratings (verdict free, explanation locked), About's privacy / terms / support links with Pro locked and unlocked, Escape over stacked sheets, and the Openings section (free browsing and playing, the guides and drills locked).
  `e2e/playthrough.spec.ts` (5): Draw mode while browsing (the bar's Back, and Final after the game, on top of
  everything; Report in Game Review ending Draw mode), resigning from the Menu (its cost, the focus in the game-over
  sheet, accuracy, the new rating's note, the X on top), the Menu's tiles at 320 points, the ⓘ on a move off the
  book (taps keep the move), the Learn strip in landscape, and a game's opening chip (the game's position from the
  player's side, Back to my game).
  `e2e/foldable.spec.ts` (15): foldable screens with the fold emulated through the DevTools protocol (a display
  feature in `Emulation.setDeviceMetricsOverride`, `Emulation.setDevicePostureOverride`; Playwright's own
  screenshot and viewport calls would reset it, so the spec sizes the page through the protocol) and the safe
  areas through `--safe-*`: the book layout (the board, its eval bar and strips clear of the fold, the panel,
  moves and toolbar in the other segment inside the safe area, tapped moves and the coach, the move list in
  rows), WebKit's case with the segments and posture APIs hidden (the heuristic book in the installed app and
  in a Safari tab, the Menu's note saying how to split half folded, the whole screen upright with the coach
  and moves side by side, none assumed in an upright tab, tabletop only with a posture), the API's stacked
  fold, the outer display both ways (a board of at least 360 px upright), the Split View widths and @2x (no
  sideways scroll, every toolbar button in sight, at least 44 px and uncut, the board overlapping nothing, a
  tapped move and the coach at each), folding and unfolding mid-game (the position, moves, coach, Draw mode,
  the explorer and an open sheet kept), every kind of sheet and the toast in the panel's segment (and a
  560 px card without the split), the Menu's Foldable screen setting (switching, stored, and with "Keep the
  board off the fold" stored, no split and no setting in Split View, on the outer display and on an iPhone),
  the system UI moved to the left without a resize (the board, then the Openings board, in the right
  segment), the light theme's status bar band (the standalone rules applied by hand: Chromium can't emulate
  the display mode), and the other screens: Openings open like a book and half folded, a search kept (its
  field, text and focus) through a fold and an unfold, the Draw bar's turn dot on a phone, Game Review (its
  floating summary leaving whole ranks or none above it on the outer display and in Split View), Try again
  and the game viewer, the self-test page and the centered boot splash, and the narrow windows (the learn,
  explore and drill boards at half the outer display's width in landscape, the step controls in two rows of
  three, Split View, the viewer's header).
  `E2E_REQUIRE_APP_SW=1` makes the PWA tests fail if the app does not register its service worker.
- The native shell itself (Swift, Xcode project) is only compiled on macOS: `ios-build.yml` in CI, or
  Xcode on a Mac. Runtime checks in WKWebView need a device (see `docs/APP_STORE.md`, "Device
  checklist").
