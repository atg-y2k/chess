import { PIECE_NAMES } from '../chess/utils';
import './PlayerStrip.css';

export interface PlayerStripProps {
  name: string;
  rating?: number;
  emoji: string;
  /** CSS colour behind the emoji (defaults to a neutral surface). */
  avatarColor?: string;
  /** Piece letters this player has captured (e.g. ['q','p','p']); order does not matter. */
  captured: string[];
  /** Colour of the captured pieces (to draw the right glyphs). */
  capturedColor: 'w' | 'b';
  /** Material lead in pawns; "+N" is shown when > 0. */
  materialDiff: number;
  /** Side to move. */
  active: boolean;
  /** Bot thinking indicator (animated dots). */
  thinking?: boolean;
}

export interface CapturedGroup {
  piece: string;
  count: number;
}

/** Display order of captured pieces: cheapest first, as on most chess sites. */
const CAPTURE_ORDER = ['p', 'n', 'b', 'r', 'q'];

/** Groups captured piece letters by type, pawns first: ['q','p','p'] -> [{p,2},{q,1}]. Unknown letters are ignored. */
export function groupCaptured(captured: string[]): CapturedGroup[] {
  const counts = new Map<string, number>();
  for (const raw of captured) {
    const p = raw.toLowerCase();
    if (CAPTURE_ORDER.includes(p)) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return CAPTURE_ORDER.filter((p) => counts.has(p)).map((piece) => ({ piece, count: counts.get(piece)! }));
}

function capturedLabel(groups: CapturedGroup[]): string {
  return groups
    .map(({ piece, count }) => `${count > 1 ? `${count} ` : ''}${PIECE_NAMES[piece]}${count > 1 ? 's' : ''}`)
    .join(', ');
}

/**
 * A ~44px row above/below the board: avatar, name + rating, captured pieces with the material
 * lead, and a turn indicator (animated dots while the bot is thinking).
 */
export function PlayerStrip({
  name,
  rating,
  emoji,
  avatarColor,
  captured,
  capturedColor,
  materialDiff,
  active,
  thinking = false,
}: PlayerStripProps) {
  const groups = groupCaptured(captured);
  const status = thinking ? 'thinking' : active ? 'to move' : '';
  const label = [name, rating != null ? `rating ${rating}` : '', status].filter(Boolean).join(', ');
  const capLabel = groups.length ? `Captured ${capturedLabel(groups)}` : '';
  const diff = Math.round(materialDiff);

  return (
    <div
      class="pstrip"
      role="group"
      aria-label={label}
      data-active={active ? '' : undefined}
      data-thinking={thinking ? '' : undefined}
    >
      <div class="pstrip-avatar" style={avatarColor ? { background: avatarColor } : undefined} aria-hidden="true">
        <span class="pstrip-emoji">{emoji}</span>
      </div>
      <div class="pstrip-main">
        <div class="pstrip-top">
          <span class="pstrip-name">{name}</span>
          {rating != null && <span class="pstrip-rating">({Math.round(rating)})</span>}
        </div>
        <div class="pstrip-caps" aria-label={capLabel || undefined} role={capLabel ? 'img' : undefined}>
          {groups.map(({ piece, count }) => (
            <span key={piece} class="pstrip-group" data-piece={piece} title={PIECE_NAMES[piece]}>
              {Array.from({ length: count }, (_, i) => (
                <i key={i} class="pstrip-piece" data-p={capturedColor + piece} />
              ))}
            </span>
          ))}
          {diff > 0 && (
            <span class="pstrip-diff" aria-label={`plus ${diff}`}>
              +{diff}
            </span>
          )}
        </div>
      </div>
      <div class="pstrip-status" aria-hidden="true">
        {thinking ? (
          <span class="pstrip-dots">
            <i />
            <i />
            <i />
          </span>
        ) : active ? (
          <span class="pstrip-turn" />
        ) : null}
      </div>
    </div>
  );
}

