/**
 * The named computer opponents: original characters spread over Elo 100..3200.
 * (Deliberately no names or branding from other chess sites.)
 */
import { clampElo } from './strength';
import type { BotPersona } from './types';

/** Built-in bots in ascending Elo. */
export const BOTS: BotPersona[] = [
  {
    id: 'pip',
    name: 'Pip',
    elo: 100,
    emoji: '🐣',
    color: '#f2c94c',
    tagline: 'Just hatched. Every piece looks like a snack.',
    greeting: 'Peep! Which one is the horsey again?',
  },
  {
    id: 'biscuit',
    name: 'Biscuit',
    elo: 250,
    emoji: '🐶',
    color: '#d9a066',
    tagline: 'An eager puppy who chases anything you leave lying around.',
    greeting: "Woof! Let's play! Can I chew on your rook?",
  },
  {
    id: 'rocco',
    name: 'Rocco',
    elo: 400,
    emoji: '🦝',
    color: '#8e9aa6',
    tagline: 'Grabs shiny material first, asks questions later.',
    greeting: 'Ooh, pawns. I collect those.',
  },
  {
    id: 'nana-dot',
    name: 'Nana Dot',
    elo: 550,
    emoji: '👵',
    color: '#c39bd3',
    tagline: 'Plays every Sunday after tea. Loves a good fork (both kinds).',
    greeting: "Sit down, dear. I'll go easy on you... probably.",
  },
  {
    id: 'juniper',
    name: 'Juniper',
    elo: 700,
    emoji: '🦊',
    color: '#e67e22',
    tagline: 'A curious fox cub learning her first tricks.',
    greeting: 'I just learned what a pin is. Want to see?',
  },
  {
    id: 'bao',
    name: 'Bao',
    elo: 850,
    emoji: '🐼',
    color: '#9aa5a0',
    tagline: 'Never in a hurry, except when he spots a check.',
    greeting: 'Bamboo break is over. Your move... I mean, mine!',
  },
  {
    id: 'priya',
    name: 'Priya',
    elo: 1000,
    emoji: '🎒',
    color: '#4aa3df',
    tagline: 'School chess club captain who always explains her plan.',
    greeting: "Good luck! I'm going to castle early, just so you know.",
  },
  {
    id: 'otis',
    name: 'Otis',
    elo: 1200,
    emoji: '🦦',
    color: '#8d6e63',
    tagline: 'Loves open files and splashy sacrifices.',
    greeting: "The water's fine. Let's dive into some tactics!",
  },
  {
    id: 'amara',
    name: 'Amara',
    elo: 1400,
    emoji: '📚',
    color: '#27ae60',
    tagline: 'Studies openings on the bus. Knows her theory.',
    greeting: "I've prepared something special for today.",
  },
  {
    id: 'professor-hoot',
    name: 'Professor Hoot',
    elo: 1600,
    emoji: '🦉',
    color: '#7f8c8d',
    tagline: 'Wise, patient and quietly positional.',
    greeting: 'Hoo-hoo. Remember: every pawn move is forever.',
  },
  {
    id: 'ingrid',
    name: 'Ingrid',
    elo: 1800,
    emoji: '❄️',
    color: '#5dade2',
    tagline: 'Solid as a glacier. Punishes loose pieces.',
    greeting: "Let's keep this calm and precise.",
  },
  {
    id: 'tomasz',
    name: 'Tomasz',
    elo: 2000,
    emoji: '⚡',
    color: '#f39c12',
    tagline: 'Club champion with a taste for sharp gambits.',
    greeting: 'Hope you like complications. I brought plenty.',
  },
  {
    id: 'kestrel',
    name: 'Kestrel',
    elo: 2200,
    emoji: '🦅',
    color: '#a04000',
    tagline: 'A master who hovers, waits, then strikes.',
    greeting: 'I see the whole board from up here.',
  },
  {
    id: 'soraya',
    name: 'Soraya',
    elo: 2500,
    emoji: '🌙',
    color: '#34495e',
    tagline: 'Calm, precise and utterly relentless.',
    greeting: 'Take your time. I have all night.',
  },
  {
    id: 'ember',
    name: 'Ember',
    elo: 2800,
    emoji: '🐉',
    color: '#c0392b',
    tagline: 'An ancient dragon who has read every chess book ever written.',
    greeting: 'Few have lasted twenty moves against me. Shall we begin?',
  },
  {
    id: 'quasar',
    name: 'Quasar',
    elo: 3200,
    emoji: '🌌',
    color: '#2c3e8f',
    tagline: 'Full-strength Stockfish. Pure calculation, no mercy.',
    greeting: 'Calculating... Your best hope is a draw.',
  },
];

const byId = new Map(BOTS.map((b) => [b.id, b] as const));

/** A built-in bot by id ('custom' is not stored; use `customPersona`). */
export function personaById(id: string): BotPersona | undefined {
  return byId.get(id);
}

/** Rough human description of a level on our (engine-anchored) Elo scale. */
function levelLabel(elo: number): string {
  if (elo < 500) return 'a total beginner';
  if (elo < 900) return 'a beginner';
  if (elo < 1300) return 'a casual player';
  if (elo < 1700) return 'a club player';
  if (elo < 2000) return 'a strong club player';
  if (elo < 2300) return 'an expert';
  if (elo < 2700) return 'a master';
  if (elo < 3200) return 'a grandmaster';
  return 'a full-strength engine';
}

/** The slider-chosen opponent: id 'custom', a neutral robot avatar, tagline describing the level. */
export function customPersona(eloIn: number): BotPersona {
  const elo = clampElo(eloIn);
  return {
    id: 'custom',
    name: `Robot ${elo}`,
    elo,
    emoji: '🤖',
    color: '#6b7b8c',
    tagline: `Custom opponent rated ${elo}: plays like ${levelLabel(elo)}.`,
    greeting: `Custom mode engaged: level ${elo}. Good luck!`,
  };
}
