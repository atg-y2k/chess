/**
 * The Openings section's data and logic (the UI lives elsewhere):
 * - ./catalog  every named line, families, search, starter lists        (free)
 * - ./tree     the book-move explorer, stepping through a line, starting
 *              or steering a game into a line                           (free)
 * - ./drill    drilling a line move by move                              (Pro)
 * - ./progress saved drill progress and mastery                         (Pro)
 * Opening guides (plain-English explanations) are Pro as well.
 *
 * The data is lazy-loaded: `await loadExplorer()` (book + catalog) before using the synchronous
 * functions. Importing a module directly (e.g. './drill') instead of this index keeps a gated
 * feature out of the free code path.
 */
export * from './catalog';
export * from './tree';
export * from './drill';
export * from './progress';

/** The features of the Openings section. */
export type OpeningsFeature = 'browse' | 'search' | 'explore' | 'play' | 'guide' | 'drill' | 'progress';

/** Which features are free and which need Pro (the native app's one-time purchase). */
export const OPENINGS_FEATURE_TIERS: Readonly<Record<OpeningsFeature, 'free' | 'pro'>> = Object.freeze({
  browse: 'free',
  search: 'free',
  explore: 'free',
  play: 'free',
  guide: 'pro',
  drill: 'pro',
  progress: 'pro',
});

/** Whether a feature of the Openings section needs Pro. */
export function isProOpeningsFeature(feature: OpeningsFeature): boolean {
  return OPENINGS_FEATURE_TIERS[feature] === 'pro';
}
