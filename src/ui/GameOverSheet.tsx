import type { Color, GameOutcome } from '../game/types';
import { IconChart, IconPlus } from './icons';
import { formatRatingDelta } from './MenuSheet';
import { KingGlyph } from './NewGameSheet';
import { Sheet } from './Sheet';
import './GameOverSheet.css';

export interface GameOverSheetProps {
  open: boolean;
  outcome: GameOutcome;
  playerColor: Color;
  botName: string;
  /** Omitted (or `rated: false`) shows "Unrated game". */
  ratingChange?: { before: number; after: number; rated: boolean };
  onReview: () => void;
  onRematch: () => void;
  onNewGame: () => void;
  /** Dismiss to look at the final position. */
  onClose: () => void;
  /** Bot avatar emoji (default 🤖). */
  botEmoji?: string;
  /** Bot avatar background colour. */
  botColor?: string;
  botElo?: number;
  /** Opening practice: the line's name ("Opening practice: Italian Game" in place of "Unrated game"). */
  practice?: string;
}

export type GameOverKind = 'win' | 'loss' | 'draw';

/** Result from the player's point of view, with its headline. */
export function gameOverHeadline(outcome: GameOutcome, playerColor: Color): { kind: GameOverKind; headline: string } {
  if (outcome.winner === null || outcome.result === '1/2-1/2') return { kind: 'draw', headline: 'Draw' };
  return outcome.winner === playerColor
    ? { kind: 'win', headline: 'You won!' }
    : { kind: 'loss', headline: 'You lost' };
}

const REASON_PHRASES: Record<string, string> = {
  checkmate: 'by checkmate',
  stalemate: 'by stalemate',
  'threefold repetition': 'by threefold repetition',
  repetition: 'by repetition',
  'insufficient material': 'by insufficient material',
  '50-move rule': 'by the 50-move rule',
  'fifty-move rule': 'by the 50-move rule',
  agreement: 'by agreement',
  timeout: 'on time',
  abandoned: 'by abandonment',
};

/** Subtitle for the result, e.g. "by checkmate", "You resigned", "Juniper resigned". */
export function gameOverReason(outcome: GameOutcome, playerColor: Color, botName: string): string {
  const raw = outcome.reason.trim();
  const key = raw.toLowerCase();
  if (!raw) return '';
  if (key === 'resignation' || key === 'resigned') {
    if (outcome.winner === null) return 'by resignation';
    return outcome.winner === playerColor ? `${botName} resigned` : 'You resigned';
  }
  if (REASON_PHRASES[key]) return REASON_PHRASES[key];
  return /^(by|on)\s/i.test(raw) ? raw : `by ${key}`;
}

/**
 * The result as chess players write it, from White's side ("1–0", "0–1", "½–½"), with who won in
 * words. (A score from the player's side, "You 0 – 1 Robot" after a win as Black, reads as a
 * Black win to anyone who knows the notation.)
 */
export function gameOverScore(outcome: GameOutcome): { text: string; note: string } {
  if (outcome.winner === null || outcome.result === '1/2-1/2') return { text: '½–½', note: 'Draw' };
  return outcome.winner === 'w' ? { text: '1–0', note: 'White won' } : { text: '0–1', note: 'Black won' };
}

/** One player on the sheet. */
interface Side {
  human: boolean;
  color: Color;
  label: string;
}

/**
 * Game-over sheet: headline + reason, both players (White on the left, Black on the right) with
 * the result between them, the rating change (or "Unrated game") and the next steps: Game Review
 * (primary), Rematch, New game.
 */
export function GameOverSheet({
  open,
  outcome,
  playerColor,
  botName,
  ratingChange,
  onReview,
  onRematch,
  onNewGame,
  onClose,
  botEmoji = '🤖',
  botColor: botAvatarColor,
  botElo,
  practice,
}: GameOverSheetProps) {
  const { kind, headline } = gameOverHeadline(outcome, playerColor);
  const reason = gameOverReason(outcome, playerColor, botName);
  const score = gameOverScore(outcome);
  const rated = ratingChange?.rated === true;
  const delta = ratingChange ? ratingChange.after - ratingChange.before : 0;
  const botColor = playerColor === 'w' ? 'b' : 'w';
  const colorName = (c: Color) => (c === 'w' ? 'White' : 'Black');
  const winner = outcome.result === '1/2-1/2' ? null : outcome.winner;
  const you: Side = { human: true, color: playerColor, label: 'You' };
  const bot: Side = { human: false, color: botColor, label: botName };
  const sides = playerColor === 'w' ? { w: you, b: bot } : { w: bot, b: you };

  const player = (p: Side) => (
    <div
      class="gos-player"
      data-color={p.color}
      data-winner={winner === p.color ? '' : undefined}
      data-loser={winner !== null && winner !== p.color ? '' : undefined}
    >
      {p.human ? (
        <span class="gos-avatar gos-avatar--you" data-c={p.color}>
          <KingGlyph color={p.color} size={40} />
          {winner === p.color && <span class="gos-crown">👑</span>}
        </span>
      ) : (
        <span class="gos-avatar" style={botAvatarColor ? { background: botAvatarColor } : undefined}>
          <span class="gos-emoji">{botEmoji}</span>
          {winner === p.color && <span class="gos-crown">👑</span>}
        </span>
      )}
      <span class="gos-name">{p.label}</span>
      <span class="gos-sub">{p.human || botElo == null ? colorName(p.color) : `${colorName(p.color)} · ${botElo}`}</span>
    </div>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`${headline}${reason ? ` ${reason}` : ''}`}
      hideTitle
      class={`gos gos--${kind}`}
    >
      <div class="gos-wrap" data-kind={kind}>
        <div class="gos-summary">
          <p class="gos-headline" aria-hidden="true">
            {headline}
          </p>
          {reason && (
            <p class="gos-reason" aria-hidden="true">
              {reason}
            </p>
          )}

          <div
            class="gos-players"
            role="img"
            aria-label={`${sides.w.label} (White) ${score.text.replace('–', ' to ')} ${sides.b.label} (Black): ${score.note}`}
          >
            {player(sides.w)}
            <div class="gos-score">
              <span class="gos-result">{score.text}</span>
              <span class="gos-result-note">{score.note}</span>
            </div>
            {player(sides.b)}
          </div>
        </div>

        <div class="gos-next">
          {rated && ratingChange ? (
            <div
              class="gos-rating"
              data-sign={Math.sign(delta)}
              role="img"
              aria-label={`Rating ${formatRatingDelta(delta)}: ${ratingChange.before} to ${ratingChange.after}`}
            >
              <span class="gos-rating-label">Rating</span>
              <span class="gos-rating-change">
                <span class="gos-rating-before">{ratingChange.before}</span>
                <svg class="gos-rating-arrow" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    d="M5 12h14M13 6l6 6-6 6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span class="gos-rating-after">{ratingChange.after}</span>
              </span>
              <span class="gos-delta">{formatRatingDelta(delta)}</span>
            </div>
          ) : (
            <div class="gos-rating gos-rating--unrated" data-practice={practice ? '' : undefined}>
              <span class="gos-rating-label">{practice ? `Opening practice: ${practice}` : 'Unrated game'}</span>
              <span class="gos-rating-note">
                {practice ? 'Unrated game: ' : ''}
                {ratingChange
                  ? `${practice ? 'your' : 'Your'} rating stays at ${ratingChange.before}`
                  : `${practice ? 'your' : 'Your'} rating is unchanged`}
              </span>
            </div>
          )}

          <div class="gos-actions">
            <button type="button" class="btn btn-primary gos-review" data-id="review" onClick={onReview}>
              <IconChart size={20} />
              Game Review
            </button>
            <div class="gos-actions-row">
              <button type="button" class="btn gos-secondary" data-id="rematch" onClick={onRematch}>
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" />
                  <path d="M4 3v5h5" />
                  <path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" />
                  <path d="M20 21v-5h-5" />
                </svg>
                Rematch
              </button>
              <button type="button" class="btn gos-secondary" data-id="new" onClick={onNewGame}>
                <IconPlus size={18} />
                New game
              </button>
            </div>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
