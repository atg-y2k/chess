/**
 * Test helper: a scripted UCI engine behind an EngineTransport, for a real StockfishEngine. It
 * answers `uci`, `isready` and every `go` at once (on the next macrotask) with one finished line per
 * MultiPV slot (the legal moves in order, at the depth asked for), and records every command it
 * gets in `sent`, so a test can check which positions were sent and searched (`positionFens`,
 * `searchedFens`).
 */
import { Chess } from 'chess.js';
import { START_FEN, fenKey } from '../../src/chess/utils';
import type { EngineTransport } from '../../src/engine/types';

export class ScriptedUciTransport implements EngineTransport {
  /** Every command posted to the engine, in order. */
  readonly sent: string[] = [];
  private listeners: ((line: string) => void)[] = [];
  private fen = START_FEN;
  private multiPv = 1;
  private terminated = false;

  post(command: string): void {
    if (this.terminated) return;
    this.sent.push(command);
    const words = command.trim().split(/\s+/);
    switch (words[0]) {
      case 'uci':
        this.reply(['id name scripted', 'uciok']);
        return;
      case 'isready':
        this.reply(['readyok']);
        return;
      case 'setoption': {
        const m = /^setoption name MultiPV value (\d+)$/.exec(command.trim());
        if (m) this.multiPv = Number(m[1]);
        return;
      }
      case 'position':
        this.fen = positionFen(command);
        return;
      case 'go':
        this.search(words);
        return;
      default:
        return; // ucinewgame, stop (every search has already answered), quit
    }
  }

  onLine(callback: (line: string) => void): void {
    this.listeners.push(callback);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The positions of every `position` command (from command `from` on), as fenKeys. */
  positionFens(from = 0): string[] {
    return this.sent.slice(from).filter((c) => c.startsWith('position ')).map((c) => fenKey(positionFen(c)));
  }

  /** The positions of the `position` commands that a `go` followed (from command `from` on), as fenKeys. */
  searchedFens(from = 0): string[] {
    const out: string[] = [];
    let last: string | null = null;
    for (const cmd of this.sent.slice(from)) {
      if (cmd.startsWith('position ')) last = fenKey(positionFen(cmd));
      else if (cmd.startsWith('go') && last) out.push(last);
    }
    return out;
  }

  private search(words: string[]): void {
    const at = words.indexOf('depth');
    const depth = at >= 0 ? Number(words[at + 1]) : 10;
    const moves = new Chess(this.fen).moves({ verbose: true });
    const n = Math.min(this.multiPv, moves.length);
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      const m = moves[i];
      const uci = m.from + m.to + (m.promotion ?? '');
      lines.push(`info depth ${depth} seldepth ${depth} multipv ${i + 1} score cp ${20 - i * 15} nodes 1000 nps 100000 time 10 pv ${uci}`);
    }
    const best = moves[0];
    lines.push(`bestmove ${best ? best.from + best.to + (best.promotion ?? '') : '(none)'}`);
    this.reply(lines);
  }

  private reply(lines: string[]): void {
    setTimeout(() => {
      if (this.terminated) return;
      for (const line of lines) for (const l of this.listeners) l(line);
    }, 0);
  }
}

/** The position a UCI `position` command sets up (`startpos` / `fen …`, then its `moves`). */
function positionFen(command: string): string {
  const m = /^position (startpos|fen (.+?))(?: moves (.+))?$/.exec(command.trim());
  if (!m) return START_FEN;
  const chess = new Chess(m[1] === 'startpos' ? START_FEN : m[2]);
  for (const uci of m[3]?.split(/\s+/) ?? []) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return chess.fen();
}
