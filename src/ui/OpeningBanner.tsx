import { IconChevronRight } from './icons';
import './OpeningBanner.css';

/** Where the game stands on its line: on it, done with it, or off it. */
export type OpeningBannerTone = 'on' | 'done' | 'off';

export interface OpeningBannerProps {
  /**
   * The opening's name ("Italian Game: Two Knights Defense", "London System"); it gives way first
   * when space is short, its variation part before the opening ("Italian Game"), which always shows.
   */
  name: string;
  /** "Move 3 of 5", "Line complete", "Left at 3. Nc3" (always shown whole). */
  status: string;
  tone?: OpeningBannerTone;
  /** Opens the line in the Openings section. */
  onOpen?: () => void;
}

/**
 * Opening practice's banner (CoachPanel puts it at the top of its bubble): "📖 Italian Game ·
 * Move 3 of 5 ›". A tap opens the line in the Openings section.
 */
export function OpeningBanner({ name, status, tone = 'on', onOpen }: OpeningBannerProps) {
  const short = shortStatus(status);
  // "Sicilian Defense · Najdorf Variation": the variation gives way (all of it if need be) before the opening.
  const colon = name.indexOf(': ');
  const family = colon > 0 ? name.slice(0, colon) : name;
  const variation = colon > 0 ? name.slice(colon + 2) : '';
  return (
    <button
      type="button"
      class="obanner"
      data-tone={tone}
      data-id="opening-banner"
      aria-label={`Opening practice: ${name}, ${status}. Open it in Openings`}
      onClick={onOpen}
      disabled={!onOpen}
    >
      <span class="obanner-in">
        <span class="obanner-icon" aria-hidden="true">
          📖
        </span>
        <span class="obanner-name" title={name}>
          <span class="obanner-family">{family}</span>
          {variation && <span class="obanner-variation">· {variation}</span>}
        </span>
        <span class="obanner-status">
          <span class="obanner-long">{status}</span>
          {short !== status && (
            <span class="obanner-short" aria-hidden="true">
              {short}
            </span>
          )}
        </span>
        <IconChevronRight size={16} class="obanner-chevron" />
      </span>
    </button>
  );
}

/** The status for a narrow banner (a landscape side column): "Move 3 of 5" -> "3 of 5", "Line complete" -> "Complete". */
export function shortStatus(status: string): string {
  const m = /^Move (\d+) of (\d+)$/.exec(status);
  if (m) return `${m[1]} of ${m[2]}`;
  if (status === 'Line complete') return 'Complete';
  return status;
}

/**
 * The banner of a coach action with id 'opening' (see store.ts `CoachActionId`): its label is the
 * name, the status and the tone separated by tabs. Null for a label without a status.
 */
export function openingBannerOf(label: string): Omit<OpeningBannerProps, 'onOpen'> | null {
  const [name, status, tone] = label.split('\t');
  if (!name || !status) return null;
  return { name, status, tone: tone === 'done' || tone === 'off' ? tone : 'on' };
}
