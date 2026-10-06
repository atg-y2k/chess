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
import { engineModeLabel, formatGameDate, formatRatingDelta, recordOutcome, setLevelNote } from '../../src/ui/MenuSheet';
import { LEVEL_BLURB, levelFor } from '../../src/ui/LevelPicker';
import { STARTING_LEVELS } from '../../src/rating/rating';
import { gameOverHeadline, gameOverReason, gameOverScore } from '../../src/ui/GameOverSheet';

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
      { selectedId: 'b', customElo: 0, adaptive: false, playerColor: 'random', showBestMoves: true, rateOpponent: true, sound: false },
      BOTS,
      900,
    );
    expect(out).toEqual({
      ...DEFAULT_SETTINGS,
      playerColor: 'random',
      botId: 'b',
      botElo: 700,
      showBestMoves: true,
      rateOpponent: true,
      sound: false,
    });
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

describe('About', () => {
  it('links the source (overridable at build time) and the shipped license notices', async () => {
    const { SOURCE_URL, THIRD_PARTY_URL, ENGINE_NOTES_URL } = await import('../../src/ui/About');
    expect(SOURCE_URL).toBe(import.meta.env.VITE_SOURCE_URL || 'https://github.com/atg-y2k/chess');
    expect(THIRD_PARTY_URL).toBe(`${import.meta.env.BASE_URL}THIRD-PARTY-LICENSES.txt`);
    expect(ENGINE_NOTES_URL).toBe(`${import.meta.env.BASE_URL}engine/README.md`);
  });
});

describe('Engine row', () => {
  const now = new Date(2026, 8, 30, 12, 0);
  it('two workers, one worker (with the date two engines are tried again), or not running', () => {
    expect(engineModeLabel({ mode: 'dual' }, now, 'en-US')).toBe('2 workers');
    expect(engineModeLabel({ mode: 'single', singleUntil: new Date(2026, 9, 14, 9, 0).getTime() }, now, 'en-US')).toBe(
      '1 worker (compatibility mode, until Oct 14)',
    );
    expect(engineModeLabel({ mode: 'single', singleUntil: new Date(2027, 0, 3).getTime() }, now, 'en-US')).toBe(
      '1 worker (compatibility mode, until Jan 3, 2027)',
    );
    expect(engineModeLabel({ mode: 'single', singleUntil: null }, now, 'en-US')).toBe('1 worker (compatibility mode)');
    expect(engineModeLabel({ mode: 'single' }, now, 'en-US')).toBe('1 worker (compatibility mode)');
    expect(engineModeLabel({ mode: null }, now, 'en-US')).toBe('Not running');
  });
});

describe('Starting level', () => {
  it('finds the level of a rating and describes every level', () => {
    expect(levelFor(800, STARTING_LEVELS)?.rating).toBe(800);
    expect(levelFor(1199.6, STARTING_LEVELS)?.rating).toBe(1200);
    expect(levelFor(1234, STARTING_LEVELS)).toBeUndefined();
    expect(levelFor(null, STARTING_LEVELS)).toBeUndefined();
    for (const l of STARTING_LEVELS) expect(LEVEL_BLURB[l.id], l.id).toBeTruthy();
  });
  it('says what setting a level does', () => {
    expect(setLevelNote(1600)).toMatch(/^Your rating becomes 1600 /);
    expect(setLevelNote(1600)).toMatch(/history stays/);
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
  it('the score is the result from White’s side, with who won (not "You 0 – 1 Bao" after a win as Black)', () => {
    expect(gameOverScore(o('1-0', 'w', 'Checkmate'))).toEqual({ text: '1–0', note: 'White won' });
    expect(gameOverScore(o('0-1', 'b', 'Resignation'))).toEqual({ text: '0–1', note: 'Black won' });
    expect(gameOverScore(o('1/2-1/2', null, 'Stalemate'))).toEqual({ text: '½–½', note: 'Draw' });
  });
});

describe('NewGameSheet / ConfirmSheet wording', () => {
  it('warns that starting a new game ends the one in progress', async () => {
    const { abandonNote } = await import('../../src/ui/NewGameSheet');
    expect(abandonNote(null)).toBeNull();
    expect(abandonNote({ rated: true })).toMatch(/count as a loss/);
    expect(abandonNote({ rated: false })).toMatch(/rating stays the same/);
  });
  it('asks before help that makes a game unrated', async () => {
    const { assistPrompt } = await import('../../src/ui/ConfirmSheet');
    for (const kind of ['hint', 'undo', 'retry'] as const) {
      expect(assistPrompt(kind).message).toMatch(/unrated/);
    }
    expect(assistPrompt('hint').confirmLabel).toBe('Show hint');
    expect(assistPrompt('explore')).toEqual({
      title: 'Explore this position?',
      message: 'Exploring uses the engine, so it makes this game unrated: win or lose, your rating stays the same.',
      confirmLabel: 'Explore',
    });
    expect(assistPrompt('rateOpponent')).toEqual({
      title: 'Rate your opponent’s moves?',
      message:
        'Seeing when your opponent goes wrong is a big help, so it makes this game unrated: win or lose, your rating stays the same. It stays on for your next games until you switch it off.',
      confirmLabel: 'Turn on',
    });
  });
  it('the opponent ratings switch promises no Pro explanations, and the Menu says it keeps games unrated', async () => {
    const { RATE_OPPONENT_DESCRIPTION, RATE_OPPONENT_MENU_DESCRIPTION } = await import('../../src/ui/NewGameSheet');
    expect(RATE_OPPONENT_DESCRIPTION).toBe('See whether the computer found the best move, rated like your moves');
    expect(RATE_OPPONENT_DESCRIPTION).not.toMatch(/explain/);
    expect(RATE_OPPONENT_MENU_DESCRIPTION).toBe('Makes your games unrated while it’s on');
  });
  it('the options note names everything that makes a game unrated, or says this one will be', async () => {
    const { unratedNote } = await import('../../src/ui/NewGameSheet');
    const off = unratedNote({ arrows: false, rateOpponent: false });
    expect(off.warn).toBe(false);
    for (const help of ['takebacks', 'hints', 'Retry', 'the explorer', 'best-move arrows', 'rating your opponent’s moves']) {
      expect(off.text).toContain(help);
    }
    expect(unratedNote({ arrows: true, rateOpponent: false })).toEqual({
      text: 'Best-move arrows are on, so this game won’t count for your rating.',
      warn: true,
    });
    expect(unratedNote({ arrows: false, rateOpponent: true })).toEqual({
      text: 'Your opponent’s moves are rated, so this game won’t count for your rating.',
      warn: true,
    });
    expect(unratedNote({ arrows: true, rateOpponent: true }).text).toMatch(/^Best-move arrows and your opponent’s move ratings are on/);
  });
});
