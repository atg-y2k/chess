/** Shared bot contracts. */

export interface BotPersona {
  id: string;
  name: string;
  /** Target playing strength on our Elo scale (100..3200). */
  elo: number;
  /** Single emoji used as the avatar. */
  emoji: string;
  /** Avatar background colour (CSS colour). */
  color: string;
  /** One-line personality blurb shown in the picker. */
  tagline: string;
  /** Short line the bot "says" at the start of a game. */
  greeting: string;
}

export interface OpeningInfo {
  eco: string;
  name: string;
}

export interface BotMove {
  uci: string;
  /** Where the move came from. */
  source: 'book' | 'engine' | 'forced';
  /** How long the bot "thought" including artificial delay (ms). */
  thinkMs: number;
}
