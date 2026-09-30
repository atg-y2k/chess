import { describe, expect, it } from 'vitest';
import type { BotPersona } from '../../src/bot/types';
import { DEFAULT_SETTINGS, type GameOutcome } from '../../src/game/types';
import {
  choiceFromSettings,
  resolveOpponent,
  settingsFromDraft,
  snapElo,
  strengthLabel,
} from '../../src/ui/NewGameSheet';
import { formatGameDate, formatRatingDelta, recordOutcome } from '../../src/ui/MenuSheet';
import { gameOverHeadline, gameOverReason } from '../../src/ui/GameOverSheet';

const bot = (id: string, elo: number): BotPersona => ({ id, name: id, elo, emoji: 'x', color: '#000', tagline: '', greeting: '' });
const BOTS = [bot('a', 100), bot('b', 700), bot('c', 3200)];

describe('snapElo / strengthLabel', () => {
  it('clamps and rounds to 50', () => {
    expect(snapElo(0)).toBe(100);
    expect(snapElo(99999)).toBe(3200);
    expect(snapElo(1024)).toBe(1000);
    expect(snapElo(1025)).toBe(1050);
    expect(snapElo(NaN)).toBe(800);
  });
  it('labels every tier', () => {
    expect([100, 549, 550, 999, 1000, 1399, 1400, 1799, 1800, 2199, 2200, 2499, 2500, 2999, 3000, 3200].map(strengthLabel)).toEqual([
      'Beginner', 'Beginner', 'Novice', 'Novice', 'Intermediate', 'Intermediate', 'Advanced', 'Advanced',
      'Expert', 'Expert', 'Master', 'Master', 'Grandmaster', 'Grandmaster', 'Engine', 'Engine',
    ]);
  });
});

describe('resolveOpponent', () => {
  it('persona -> its own Elo', () => {
    expect(resolveOpponent({ selectedId: 'b', customElo: 1500, adaptive: false }, BOTS, 1234)).toEqual({ botId: 'b', botElo: 700 });
  });
  it('custom -> snapped slider value', () => {
    expect(resolveOpponent({ selectedId: 'custom', customElo: 1512, adaptive: false }, BOTS, 1234)).toEqual({ botId: 'custom', botElo: 1500 });
  });
  it('unknown id -> custom', () => {
    expect(resolveOpponent({ selectedId: 'zzz', customElo: 900, adaptive: false }, BOTS, 1234)).toEqual({ botId: 'custom', botElo: 900 });
  });
  it('adaptive -> custom at the player rating (snapped, clamped)', () => {
    expect(resolveOpponent({ selectedId: 'b', customElo: 900, adaptive: true }, BOTS, 1234)).toEqual({ botId: 'custom', botElo: 1250 });
    expect(resolveOpponent({ selectedId: 'b', customElo: 900, adaptive: true }, BOTS, 40)).toEqual({ botId: 'custom', botElo: 100 });
  });
});

describe('choiceFromSettings / settingsFromDraft', () => {
  it('round-trips a persona', () => {
    const s = { ...DEFAULT_SETTINGS, botId: 'c', botElo: 3200 };
    const c = choiceFromSettings(s, BOTS);
    expect(c).toEqual({ selectedId: 'c', customElo: 3200, adaptive: false });
    expect(settingsFromDraft(s, c, BOTS, 800)).toEqual(s);
  });
  it('unknown persona id falls back to custom at that Elo', () => {
    expect(choiceFromSettings({ ...DEFAULT_SETTINGS, botId: 'gone', botElo: 1333 }, BOTS)).toEqual({
      selectedId: 'custom',
      customElo: 1350,
      adaptive: false,
    });
  });
  it('produces complete, consistent settings', () => {
    const out = settingsFromDraft(
      DEFAULT_SETTINGS,
      { selectedId: 'b', customElo: 0, adaptive: false, playerColor: 'random', showBestMoves: true, sound: false },
      BOTS,
      900,
    );
    expect(out).toEqual({ ...DEFAULT_SETTINGS, playerColor: 'random', botId: 'b', botElo: 700, showBestMoves: true, sound: false });
    expect(Object.keys(out).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
});

describe('MenuSheet helpers', () => {
  it('formatRatingDelta', () => {
    expect(formatRatingDelta(12)).toBe('+12');
    expect(formatRatingDelta(-8)).toBe('−8');
    expect(formatRatingDelta(0)).toBe('±0');
    expect(formatRatingDelta(0.4)).toBe('±0');
  });
  it('recordOutcome', () => {
    expect(recordOutcome({ playerScore: 1 })).toBe('win');
    expect(recordOutcome({ playerScore: 0.5 })).toBe('draw');
    expect(recordOutcome({ playerScore: 0 })).toBe('loss');
  });
  it('formatGameDate', () => {
    const now = new Date(2026, 8, 30, 20, 0); // Wed 30 Sep 2026
    expect(formatGameDate(new Date(2026, 8, 30, 1, 0).toISOString(), now, 'en-US')).toBe('Today');
    expect(formatGameDate(new Date(2026, 8, 29, 23, 0).toISOString(), now, 'en-US')).toBe('Yesterday');
    expect(formatGameDate(new Date(2026, 8, 27, 12, 0).toISOString(), now, 'en-US')).toBe('Sunday');
    expect(formatGameDate(new Date(2026, 8, 12, 12, 0).toISOString(), now, 'en-US')).toBe('Sep 12');
    expect(formatGameDate(new Date(2025, 11, 31, 12, 0).toISOString(), now, 'en-US')).toBe('Dec 31, 2025');
    expect(formatGameDate('nope', now)).toBe('');
  });
});

describe('GameOverSheet helpers', () => {
  const o = (result: GameOutcome['result'], winner: GameOutcome['winner'], reason: string): GameOutcome => ({ result, winner, reason });
  it('headline from the player POV', () => {
    expect(gameOverHeadline(o('1-0', 'w', 'Checkmate'), 'w')).toEqual({ kind: 'win', headline: 'You won!' });
    expect(gameOverHeadline(o('1-0', 'w', 'Checkmate'), 'b')).toEqual({ kind: 'loss', headline: 'You lost' });
    expect(gameOverHeadline(o('1/2-1/2', null, 'Stalemate'), 'b')).toEqual({ kind: 'draw', headline: 'Draw' });
  });
  it('reason phrases', () => {
    expect(gameOverReason(o('1-0', 'w', 'Checkmate'), 'w', 'Bao')).toBe('by checkmate');
    expect(gameOverReason(o('0-1', 'b', 'Resignation'), 'w', 'Bao')).toBe('You resigned');
    expect(gameOverReason(o('0-1', 'b', 'Resignation'), 'b', 'Bao')).toBe('Bao resigned');
    expect(gameOverReason(o('1/2-1/2', null, '50-move rule'), 'w', 'Bao')).toBe('by the 50-move rule');
    expect(gameOverReason(o('1/2-1/2', null, 'Insufficient material'), 'w', 'Bao')).toBe('by insufficient material');
    expect(gameOverReason(o('1/2-1/2', null, 'Threefold repetition'), 'w', 'Bao')).toBe('by threefold repetition');
    expect(gameOverReason(o('1-0', 'w', 'Something odd'), 'w', 'Bao')).toBe('by something odd');
    expect(gameOverReason(o('1-0', 'w', ''), 'w', 'Bao')).toBe('');
  });
});
