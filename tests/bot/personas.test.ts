import { describe, expect, it } from 'vitest';
import { BOTS, customPersona, personaById } from '../../src/bot/personas';

/** Names/branding of another site's bots that we must not reuse. */
const BANNED = [
  'martin', 'elani', 'aron', 'emir', 'sven', 'nelson', 'antonio', 'isabel', 'wally', 'jimmy', 'li', 'noam',
  'nora', 'mateo', 'wendy', 'hikaru', 'magnus', 'mittens', 'komodo', 'chess.com', 'juan', 'sofia', 'fabian',
];

describe('personas', () => {
  it('has ~16 original bots spread over 100..3200 in ascending Elo', () => {
    expect(BOTS.length).toBeGreaterThanOrEqual(14);
    expect(BOTS.length).toBeLessThanOrEqual(20);
    expect(BOTS[0].elo).toBe(100);
    expect(BOTS.at(-1)!.elo).toBe(3200);
    for (let i = 1; i < BOTS.length; i++) expect(BOTS[i].elo).toBeGreaterThan(BOTS[i - 1].elo);
    expect(new Set(BOTS.map((b) => b.id)).size).toBe(BOTS.length);
    expect(new Set(BOTS.map((b) => b.name)).size).toBe(BOTS.length);
    expect(new Set(BOTS.map((b) => b.emoji)).size).toBe(BOTS.length);
  });

  it('fills every field and uses no banned names', () => {
    for (const b of BOTS) {
      expect(b.id).toMatch(/^[a-z0-9-]+$/);
      expect(b.id).not.toBe('custom');
      for (const f of [b.name, b.emoji, b.color, b.tagline, b.greeting]) expect(f.length).toBeGreaterThan(0);
      expect(b.color).toMatch(/^#[0-9a-f]{6}$/i);
      const words = `${b.name} ${b.tagline} ${b.greeting}`.toLowerCase().split(/[^a-z.]+/);
      for (const banned of BANNED) expect(words).not.toContain(banned);
    }
  });

  it('looks bots up by id', () => {
    for (const b of BOTS) expect(personaById(b.id)).toBe(b);
    expect(personaById('custom')).toBeUndefined();
    expect(personaById('nope')).toBeUndefined();
  });

  it('builds a neutral custom persona that describes its level', () => {
    const c = customPersona(1450);
    expect(c).toMatchObject({ id: 'custom', elo: 1450, emoji: '🤖' });
    expect(c.tagline).toContain('1450');
    expect(c.name).toContain('1450');
    expect(customPersona(99999).elo).toBe(3200);
    expect(customPersona(12).elo).toBe(100);
    expect(customPersona(3200).tagline).toMatch(/engine/);
    expect(customPersona(300).tagline).toMatch(/beginner/);
  });
});
