/**
 * The UCI `position` command for a search, with the game's moves when they are known.
 *
 * Stockfish detects repetitions only among positions it was given as moves: from a bare FEN it
 * cannot know that a move repeats a position for the third time (a draw). So when a search has a
 * `history`, the moves are replayed with chess.js first. Only if every move is legal and they lead
 * to the searched position is `position fen F moves m1 … mk` sent, where F is the position right
 * after the last irreversible move (a capture, a pawn move, or a change of castling rights). No
 * position before F can occur again, so nothing is lost, and the list stays short: it holds only
 * quiet piece moves, at most about 100 of them under the 50-move rule.
 *
 * Anything else (an illegal or malformed move, a history that leads elsewhere, an invalid start
 * position) falls back to the bare FEN. An illegal move in the list is a CRITICAL ERROR that kills
 * the WASM engine, so a list is only ever sent after chess.js has replayed it.
 *
 * `PositionCommands` keeps the last replay and extends it while the history only grows (one move
 * per bot turn), so a long game is not replayed from the start for every search.
 */
import { Chess, type Move } from 'chess.js';
import type { SearchHistory } from './types';

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** Board, side to move, castling, en passant and halfmove clock (the full-move number does not matter). */
const fields5 = (fen: string): string => fen.split(' ').slice(0, 5).join(' ');

interface Replay {
  startFen: string;
  /** Moves replayed so far, exactly as given (to recognise a longer version of the same history). */
  moves: string[];
  chess: Chess;
  /** FEN right after the last irreversible move (or the start position). */
  base: string;
  /** Canonical UCI moves played since `base` (quiet piece moves only). */
  tail: string[];
  /** Castling field of the current position. */
  castling: string;
}

/** A replay of `startFen`, or null when the position is not one Stockfish accepts. */
function startReplay(startFen: string): Replay | null {
  let chess: Chess;
  try {
    chess = new Chess(startFen.trim());
  } catch {
    return null;
  }
  // Stockfish rejects a position where the side NOT to move is in check.
  const us = chess.turn();
  const theirKing = chess.findPiece({ type: 'k', color: us === 'w' ? 'b' : 'w' })[0];
  if (theirKing && chess.isAttacked(theirKing, us)) return null;
  const base = chess.fen();
  return { startFen, moves: [], chess, base, tail: [], castling: base.split(' ')[2] };
}

/** Plays `raw` on the replay. False when the move is malformed or illegal (the replay is then unusable). */
function playOn(r: Replay, raw: string): boolean {
  if (!UCI_MOVE.test(raw)) return false;
  let move: Move;
  try {
    move = r.chess.move({ from: raw.slice(0, 2), to: raw.slice(2, 4), promotion: raw[4] });
  } catch {
    return false;
  }
  const fen = r.chess.fen();
  const castling = fen.split(' ')[2];
  r.moves.push(raw);
  if (move.captured || move.piece === 'p' || castling !== r.castling) {
    r.base = fen;
    r.tail = [];
    r.castling = castling;
  } else {
    r.tail.push(move.from + move.to + (move.promotion ?? ''));
  }
  return true;
}

/** Builds `position` commands, reusing the previous replay while the history only grows. */
export class PositionCommands {
  private replay: Replay | null = null;

  /**
   * The `position` command for a search of `fen` (sent as given when the history is not used, so
   * pass a valid, normalised FEN such as `inspectPosition(fen).fen`), with `history`'s moves when
   * they legally lead to `fen`. Never throws.
   */
  command(fen: string, history?: SearchHistory): string {
    const bare = `position fen ${fen}`;
    if (!history) return bare;
    try {
      const target = fields5(new Chess(fen).fen());
      const r = this.replayOf(history);
      if (!r || fields5(r.chess.fen()) !== target) return bare;
      return r.tail.length ? `position fen ${r.base} moves ${r.tail.join(' ')}` : bare;
    } catch {
      this.replay = null;
      return bare;
    }
  }

  private replayOf(h: SearchHistory): Replay | null {
    let r = this.replay;
    const reusable =
      !!r && r.startFen === h.startFen && r.moves.length <= h.moves.length && r.moves.every((m, i) => m === h.moves[i]);
    if (!r || !reusable) {
      r = startReplay(h.startFen);
      this.replay = r;
      if (!r) return null;
    }
    for (let i = r.moves.length; i < h.moves.length; i++) {
      if (!playOn(r, h.moves[i])) {
        this.replay = null;
        return null;
      }
    }
    return r;
  }
}

/** One-off `position` command (see `PositionCommands.command`). */
export function positionCommand(fen: string, history?: SearchHistory): string {
  return new PositionCommands().command(fen, history);
}
