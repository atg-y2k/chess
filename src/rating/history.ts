/**
 * The rating history the Menu's chart draws (ui/RatingChart.tsx): the rating after each rated game,
 * oldest first, from the rating the games started at, with the levels set in between ("Set my
 * level"), the peak, and the games played while the rating was still new. Pure (no DOM).
 */
import { PROVISIONAL_GAMES, formatRatingDelta } from './rating';
import type { GameRecord, PlayerProfile } from './types';

/**
 * A point of the line: the rating the history starts from ('start'), a level the player set
 * ('level': the rating jumped without a game), or the rating after a rated game ('game').
 */
export interface RatingPoint {
  kind: 'start' | 'level' | 'game';
  rating: number;
  /** The game ('game' only). */
  record?: GameRecord;
  /** The game's number among the rated games shown, from 1 ('game' only). */
  game?: number;
  /** A game played while the rating was new: it moved the rating fast ('game' only). */
  provisional?: boolean;
}

export interface RatingHistory {
  points: RatingPoint[];
  /** The point of the peak: the highest rating after a game in the history (the first time it was reached). */
  peak: number;
  /** The point of the current rating (the last one). */
  current: number;
  /** Runs of games played while the rating was new, as point indexes (inclusive). */
  provisional: { from: number; to: number }[];
  min: number;
  max: number;
  /** Rated games shown. */
  games: number;
  /**
   * The first point is the rating the player started at (the history holds every game). Otherwise
   * the oldest games are gone (more than HISTORY_LIMIT, or a full storage kept only the newest) and
   * it is the rating before the oldest one kept.
   */
  complete: boolean;
}

/**
 * The chart's data from the profile, or null before the first rated game. Unrated games are left
 * out (they do not move the rating) but still reveal a level set before them. A game recorded
 * without `provisional` (older records; newer ones say it either way) counts as new when it is
 * among the first PROVISIONAL_GAMES rated games after the start of a complete history or after a
 * level was set.
 */
export function ratingHistory(profile: PlayerProfile): RatingHistory | null {
  const records = [...profile.history].reverse(); // oldest first
  // Every game played is still there (the win, draw and loss counts outlive the history: more than
  // HISTORY_LIMIT games, or a full storage that kept only the newest ones, leave fewer records).
  const complete = profile.history.length >= profile.wins + profile.draws + profile.losses;
  const points: RatingPoint[] = [];
  let prev: number | null = null;
  // Rated games since the rating was (re)set, when that moment is known.
  let since: number | null = complete ? 0 : null;
  let games = 0;
  for (const r of records) {
    if (prev !== null && r.ratingBefore !== prev) {
      // The rating moved without a game: a level was set ("Set my level").
      if (points.length) points.push({ kind: 'level', rating: r.ratingBefore });
      since = 0;
    }
    prev = r.ratingAfter;
    if (!r.rated) continue;
    if (!points.length) points.push({ kind: 'start', rating: r.ratingBefore });
    games++;
    const provisional = r.provisional ?? (since !== null && since < PROVISIONAL_GAMES);
    points.push({ kind: 'game', rating: r.ratingAfter, record: r, game: games, ...(provisional ? { provisional: true } : {}) });
    if (since !== null) since++;
  }
  if (!games) return null;
  // A level set after the last game: the line ends at the rating the player has now.
  if (Math.round(profile.rating) !== prev) points.push({ kind: 'level', rating: Math.round(profile.rating) });

  let peak = -1;
  points.forEach((p, i) => {
    if (p.kind === 'game' && (peak < 0 || p.rating > points[peak].rating)) peak = i;
  });
  const provisional: { from: number; to: number }[] = [];
  points.forEach((p, i) => {
    if (!p.provisional) return;
    const last = provisional.at(-1);
    if (last && last.to === i - 1) last.to = i;
    else provisional.push({ from: i, to: i });
  });
  const ratings = points.map((p) => p.rating);
  return {
    points,
    peak,
    current: points.length - 1,
    provisional,
    min: Math.min(...ratings),
    max: Math.max(...ratings),
    games,
    complete,
  };
}

/** Win / draw / loss from the player's point of view. */
export function recordOutcome(r: Pick<GameRecord, 'playerScore'>): 'win' | 'draw' | 'loss' {
  return r.playerScore === 1 ? 'win' : r.playerScore === 0.5 ? 'draw' : 'loss';
}

/**
 * Compact date for the games list: "Today", "Yesterday", a weekday within the last week,
 * otherwise "Sep 28" (plus the year when it is not the current one). Invalid input gives ''.
 */
export function formatGameDate(iso: string, now: Date = new Date(), locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toLocaleDateString(locale, { weekday: 'long' });
  return d.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/** Won / Lost / Draw from the player's point of view. */
export function resultWord(r: Pick<GameRecord, 'playerScore'>): 'Won' | 'Lost' | 'Draw' {
  return r.playerScore === 1 ? 'Won' : r.playerScore === 0 ? 'Lost' : 'Draw';
}

/** "Oct 12" (with the year when it is not this year's); '' for a malformed date. */
export function shortDate(iso: string, now: Date = new Date(), locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/**
 * What a point says when it is picked (the chart's readout and its value for assistive technology):
 * "Oct 12 · Pip (100) · Won · +24" for a game, "Starting rating" / "Rating before the oldest game
 * kept", or "Level set to 1200".
 */
export function pointText(h: RatingHistory, i: number, now?: Date, locale?: string): string {
  const p = h.points[i];
  if (!p) return '';
  if (p.kind === 'start') return h.complete ? 'Starting rating' : 'Rating before the oldest game kept';
  if (p.kind === 'level') return `Level set to ${p.rating}`;
  const r = p.record!;
  const date = shortDate(r.date, now, locale);
  const parts = [date, `${r.botName} (${r.botElo})`, resultWord(r), formatRatingDelta(r.ratingAfter - r.ratingBefore)];
  return parts.filter(Boolean).join(' · ');
}

/** The chart in one sentence, for assistive technology. */
export function historySummary(h: RatingHistory): string {
  const first = h.points[0].rating;
  const now = h.points[h.current].rating;
  const games = h.games === 1 ? '1 rated game' : `${h.games} rated games`;
  const peak = h.points[h.peak];
  const atPeak = peak && peak.game ? `, peak ${peak.rating} after game ${peak.game}` : '';
  return `Rating history: ${games}, from ${first} to ${now}${atPeak}.`;
}

/**
 * Round tick values for the rating axis covering `min`..`max`: 2 to 5 steps of 25, 50, 100, 200 or 500
 * (a flat line still gets a band around it).
 */
export function ratingTicks(min: number, max: number, maxTicks = 4): { ticks: number[]; lo: number; hi: number } {
  const span = Math.max(max - min, 40);
  const steps = [25, 50, 100, 200, 250, 500, 1000];
  const step = steps.find((s) => Math.ceil(span / s) <= maxTicks - 1) ?? 1000;
  const lo = Math.max(0, Math.floor(min / step) * step);
  let hi = Math.ceil(max / step) * step;
  if (hi - lo < step) hi = lo + step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + 1e-9; t += step) ticks.push(t);
  return { ticks, lo, hi };
}
