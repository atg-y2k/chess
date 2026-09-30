/**
 * Test doubles for the game controller: a deterministic ChessEngine (2-ply material search with
 * MultiPV lines), a scripted bot, in-memory storage and a recording sound port.
 */
import { Chess, type Move } from 'chess.js';
import { fenKey } from '../../src/chess/utils';
import type { EngineSet } from '../../src/engine/createEngines';
import type { AnalysisResult, ChessEngine, PvLine, Score, SearchOptions } from '../../src/engine/types';
import type { BotLike, SoundPort } from '../../src/game/controller';
import type { KeyValueStorage } from '../../src/game/persistence';
import type { SoundKind } from '../../src/game/sound';

const VALUE: Record<string, number> = { p: 100, n: 300, b: 310, r: 500, q: 900, k: 0 };
const MATE = 100_000;

interface Scored {
  uci: string;
  score: Score;
  pv: string[];
  /** Sort key (higher is better for the side to move). */
  key: number;
}

const uciOf = (m: Pick<Move, 'from' | 'to' | 'promotion'>) => m.from + m.to + (m.promotion ?? '');

/** Material balance (cp) of a FEN from `color`'s point of view. */
function balance(fen: string, color: 'w' | 'b'): number {
  let v = 0;
  for (const ch of fen.split(' ')[0]) {
    const p = ch.toLowerCase();
    if (!(p in VALUE)) continue;
    v += (ch === p ? -1 : 1) * VALUE[p] * (color === 'w' ? 1 : -1);
  }
  return v;
}

const gain = (m: Move) => (m.captured ? VALUE[m.captured] : 0) + (m.promotion ? VALUE[m.promotion] - VALUE.p : 0);

/** Small deterministic preference for central destination squares (0..6 cp). */
function centrality(sq: string): number {
  const f = sq.charCodeAt(0) - 97;
  const r = sq.charCodeAt(1) - 49;
  return Math.round(6 - Math.abs(f - 3.5) - Math.abs(r - 3.5));
}

const cache = new Map<string, Scored[]>();

/**
 * Every legal move scored by material after the move minus the opponent's best capture (an
 * undefended piece, or a defended one attacked by something cheaper), with mates in one detected
 * from SAN and stalemates scored 0; sorted best first. Cached by position.
 */
export function scoreMoves(fen: string): Scored[] {
  const key = fenKey(fen);
  const hit = cache.get(key);
  if (hit) return hit;
  const chess = new Chess(fen);
  const me = chess.turn();
  const opp = me === 'w' ? 'b' : 'w';
  const base = balance(fen, me);
  const out: Scored[] = [];
  for (const m of chess.moves({ verbose: true })) {
    const uci = uciOf(m);
    if (m.san.endsWith('#')) {
      out.push({ uci, score: { kind: 'mate', value: 1 }, pv: [uci], key: MATE });
      continue;
    }
    chess.move(m);
    if (chess.isStalemate()) {
      chess.undo();
      out.push({ uci, score: { kind: 'cp', value: 0 }, pv: [uci], key: 0 });
      continue;
    }
    let threat = 0;
    let reply: string | null = null;
    for (const row of chess.board()) {
      for (const sq of row) {
        if (!sq || sq.color !== me || sq.type === 'k') continue;
        const attackers = chess.attackers(sq.square, opp);
        if (!attackers.length) continue;
        const defended = chess.isAttacked(sq.square, me);
        let cheapest: string | null = null;
        let cheapestValue = Number.POSITIVE_INFINITY;
        for (const a of attackers) {
          const piece = chess.get(a);
          if (!piece || (piece.type === 'k' && defended)) continue;
          const v = piece.type === 'k' ? 0 : VALUE[piece.type];
          if (v < cheapestValue) {
            cheapestValue = v;
            cheapest = a;
          }
        }
        if (!cheapest) continue;
        const g = defended ? VALUE[sq.type] - cheapestValue : VALUE[sq.type];
        if (g > threat) {
          threat = g;
          reply = cheapest + sq.square;
        }
      }
    }
    chess.undo();
    const cp = base + gain(m) - threat + centrality(m.to);
    out.push({ uci, score: { kind: 'cp', value: cp }, pv: reply ? [uci, reply] : [uci], key: cp });
  }
  out.sort((a, b) => b.key - a.key || (a.uci < b.uci ? -1 : 1));
  cache.set(key, out);
  return out;
}

interface Pending {
  finish: (aborted: boolean) => void;
}

/**
 * Deterministic fake ChessEngine. Searches resolve after `delayMs` (a macrotask), honour
 * AbortSignal and pre-emption (the previous search resolves `aborted: true`), and answer terminal
 * positions at once like StockfishEngine.
 */
export class FakeEngine implements ChessEngine {
  readonly searches: { fen: string; opts: SearchOptions }[] = [];
  newGames = 0;
  terminated = false;
  delayMs = 0;
  /** Scripted best moves: while the next scripted move is legal in a searched position, it is ranked first (and consumed). */
  script: string[] = [];
  /** Makes every search reject (engine broken). */
  failWith: Error | null = null;
  private pending: Pending | null = null;

  constructor(readonly name = 'fake') {}

  init(): Promise<void> {
    return this.terminated ? Promise.reject(new Error('terminated')) : Promise.resolve();
  }

  search(fen: string, opts: SearchOptions = {}): Promise<AnalysisResult> {
    this.searches.push({ fen, opts });
    if (this.terminated) return Promise.reject(new Error('terminated'));
    if (this.failWith) return Promise.reject(this.failWith);
    this.pending?.finish(true);
    const chess = new Chess(fen);
    if (chess.isGameOver() && chess.moves().length === 0) {
      return Promise.resolve({
        fen,
        depth: 0,
        lines: [],
        bestMove: null,
        done: true,
        terminal: chess.isCheckmate() ? 'checkmate' : 'stalemate',
      });
    }
    return new Promise<AnalysisResult>((resolve) => {
      let settled = false;
      const finish = (aborted: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (this.pending === entry) this.pending = null;
        resolve(
          aborted
            ? { fen, depth: 0, lines: [], bestMove: null, done: false, aborted: true }
            : this.evaluate(fen, opts),
        );
      };
      const onAbort = () => finish(true);
      const entry: Pending = { finish };
      this.pending = entry;
      const timer = setTimeout(() => finish(false), this.delayMs);
      if (opts.signal?.aborted) finish(true);
      else opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  stop(): void {
    this.pending?.finish(true);
  }

  newGame(): Promise<void> {
    this.newGames++;
    return Promise.resolve();
  }

  terminate(): void {
    this.terminated = true;
    this.stop();
  }

  private evaluate(fen: string, opts: SearchOptions): AnalysisResult {
    let scored = scoreMoves(fen);
    const next = this.script[0];
    if (next && scored.some((s) => s.uci === next)) {
      this.script.shift();
      const top = scored.find((s) => s.uci === next)!;
      scored = [{ ...top, score: { kind: 'cp', value: Math.max(scored[0].key, 0) + 50 } }, ...scored.filter((s) => s !== top)];
    }
    const depth = opts.depth ?? 10;
    const lines: PvLine[] = scored
      .slice(0, Math.max(1, opts.multiPv ?? 1))
      .map((s, i) => ({ multipv: i + 1, depth, score: s.score, pv: s.pv }));
    return { fen, depth, lines, bestMove: lines[0]?.pv[0] ?? null, done: true };
  }
}

/** Two fake engines as an EngineSet ('dual' mode). */
export function fakeEngineSet(): { analysis: FakeEngine; bot: FakeEngine; set: EngineSet } {
  const analysis = new FakeEngine('analysis');
  const bot = new FakeEngine('bot');
  return {
    analysis,
    bot,
    set: {
      analysis,
      bot,
      mode: 'dual',
      terminate() {
        analysis.terminate();
        bot.terminate();
      },
    },
  };
}

/**
 * A bot that plays a scripted list of UCI moves (then the first legal move). With `manual`, moves
 * are held until `release()`; with `ignoreAbort`, a held move still resolves after an abort (a
 * racing bot), so the controller's stale-move guards can be tested.
 */
export class ScriptedBot implements BotLike {
  readonly calls: { fen: string; elo: number; history: string[]; startFen?: string }[] = [];
  readonly newGames: number[] = [];
  manual = false;
  ignoreAbort = false;
  private held: (() => void)[] = [];

  constructor(public moves: string[] = []) {}

  newGame(elo: number): Promise<void> {
    this.newGames.push(elo);
    return Promise.resolve();
  }

  move(fen: string, elo: number, history: string[], signal?: AbortSignal, startFen?: string) {
    this.calls.push({ fen, elo, history: [...history], startFen });
    const legal = new Chess(fen).moves({ verbose: true }).map(uciOf);
    const scripted = this.moves[0];
    const uci = scripted && legal.includes(scripted) ? this.moves.shift()! : legal[0];
    const result = uci ? { uci, source: 'engine' as const, thinkMs: 0 } : null;
    return new Promise<typeof result>((resolve) => {
      const done = () => resolve(signal?.aborted && !this.ignoreAbort ? null : result);
      if (this.manual) {
        this.held.push(done);
        if (!this.ignoreAbort) signal?.addEventListener('abort', () => resolve(null), { once: true });
      } else {
        setTimeout(done, 0);
      }
    });
  }

  /** Number of moves waiting for `release()`. */
  get heldCount(): number {
    return this.held.length;
  }

  /** Resolves every held move. */
  release(): void {
    for (const f of this.held.splice(0)) f();
  }
}

/** In-memory KeyValueStorage. */
export class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** Sound port that records what was played. */
export class RecordingSound implements SoundPort {
  readonly played: SoundKind[] = [];
  enabled = true;
  play(kind: SoundKind): void {
    this.played.push(kind);
  }
  setEnabled(on: boolean): void {
    this.enabled = on;
  }
}
