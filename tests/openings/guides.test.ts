import { Chess, type Color, type Square } from 'chess.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOpenings, openingAt, splitOpeningName } from '../../src/bot/book';
import { parseUci } from '../../src/chess/utils';
import { BEGINNER_FAMILIES } from '../../src/openings/catalog';
import {
  guideFor,
  guideMainLine,
  moveNoteFor,
  moveNoteKey,
  OPENING_GUIDES,
  type OpeningGuide,
} from '../../src/data/opening-guides';

/** Every dataset name (values of openings.json `names`). */
let datasetNames: Set<string>;
let datasetFamilies: Set<string>;

beforeAll(async () => {
  await loadOpenings();
  const m = (await import('../../src/data/openings.json')) as unknown as { default?: unknown };
  const data = (m.default ?? m) as { names: Record<string, [string, string]> };
  datasetNames = new Set(Object.values(data.names).map(([, name]) => name));
  datasetFamilies = new Set([...datasetNames].map((n) => splitOpeningName(n).family));
});

/** Replays UCI moves from the initial position; throws on an illegal move. */
function playUci(ucis: readonly string[]): { chess: Chess; sans: string[] } {
  const chess = new Chess();
  const sans: string[] = [];
  for (const u of ucis) {
    const { from, to, promotion } = parseUci(u);
    sans.push(chess.move({ from, to, promotion }).san);
  }
  return { chess, sans };
}

function playSan(sans: readonly string[]): Chess {
  const chess = new Chess();
  for (const s of sans) chess.move(s);
  return chess;
}

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Material balance (pawn units) from `side`'s point of view. */
function material(chess: Chess, side: 'white' | 'black'): number {
  let diff = 0;
  for (const row of chess.board()) {
    for (const sq of row) if (sq) diff += (sq.color === 'w' ? 1 : -1) * VALUE[sq.type];
  }
  return side === 'white' ? diff : -diff;
}

function kingSquare(chess: Chess, color: Color): Square | undefined {
  for (const row of chess.board()) {
    for (const sq of row) if (sq?.type === 'k' && sq.color === color) return sq.square;
  }
  return undefined;
}

const colorOf = (side: 'white' | 'black'): Color => (side === 'white' ? 'w' : 'b');

/**
 * What each trap line must actually lead to (keyed "Family / Title"); every trap needs an entry,
 * so a new trap cannot ship unchecked. The claims were also sanity-checked with Stockfish 19
 * (depth 16) when the guides were written.
 */
type Outcome = { mate: true } | { material: number } | { check: (chess: Chess) => boolean };
const TRAP_OUTCOMES: Record<string, Outcome> = {
  "King's Pawn Game / Scholar's Mate": { mate: true },
  'Italian Game / Fried Liver Attack': {
    // White is a knight down for a pawn, but Black's king has been dragged out to e6.
    check: (c) => kingSquare(c, 'b') === 'e6' && material(c, 'white') === -2,
  },
  'Italian Game / Blackburne Shilling Trap': { mate: true },
  "Ruy Lopez / Noah's Ark Trap": { material: 1 }, // a bishop for two pawns
  'Scotch Game / Sea-Cadet Mate': { mate: true },
  'Vienna Game / The wrong knight retreat': { mate: true },
  "King's Gambit / Greedy 3.fxe5": { material: 5 }, // the h1 rook
  "Petrov's Defense / Copycat 3...Nxe4": { material: 6 }, // the queen for a knight
  "Petrov's Defense / Stafford Gambit mate": { mate: true },
  "Philidor Defense / Légal's Mate": { mate: true },
  'Sicilian Defense / Magnus Smith Trap': { material: 5 }, // the queen for a bishop and a pawn
  'Sicilian Defense / Siberian Trap': { mate: true },
  'French Defense / Queen lost on d4': { material: 8 },
  'Caro-Kann Defense / Smothered mate on d6': { mate: true },
  "Queen's Gambit / Lasker Trap": { material: 9 },
  "Queen's Gambit Accepted / Holding the pawn with ...b5": { material: 2 }, // a knight for a pawn
  "Queen's Gambit Declined / Elephant Trap": { material: 2 }, // a piece for a pawn
  'Indian Defense / Budapest smothered mate': { mate: true },
  'Dutch Defense / Mate on the open diagonal': { mate: true },
  "Bird Opening / From's Gambit mate": { mate: true },
  'Englund Gambit / Englund Gambit trap': { mate: true },
};

/** Claims made in trap notes about side lines (move list, who benefits, outcome). */
const NOTE_CLAIMS: [string, string, 'white' | 'black', Outcome][] = [
  ["King's Gambit: 4.Ke2?? Qxe4 is mate", 'e4 e5 f4 Bc5 fxe5 Qh4+ Ke2 Qxe4#', 'black', { mate: true }],
  [
    'Scotch: 8...dxe5 9.Qxg4 leaves White a piece for a pawn ahead',
    'e4 e5 Nf3 Nc6 d4 exd4 c3 dxc3 Nxc3 d6 Bc4 Bg4 O-O Ne5 Nxe5 dxe5 Qxg4',
    'white',
    { material: 2 },
  ],
  [
    'Philidor: 5...dxe5 6.Qxg4 leaves White a pawn up',
    'e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6 Nxe5 dxe5 Qxg4',
    'white',
    { material: 1 },
  ],
  [
    'Siberian Trap: 10.hxg4 Nxe2+ costs White the queen',
    'e4 c5 d4 cxd4 c3 dxc3 Nxc3 Nc6 Nf3 e6 Bc4 Qc7 Qe2 Nf6 O-O Ng4 h3 Nd4 hxg4 Nxe2+ Bxe2',
    'black',
    { material: 4 },
  ],
  [
    'Blackburne Shilling: 4.Nxe5? Qg5 5.Nxf7?? leads to mate',
    'e4 e5 Nf3 Nc6 Bc4 Nd4 Nxe5 Qg5 Nxf7 Qxg2 Rf1 Qxe4+ Be2 Nf3#',
    'black',
    { mate: true },
  ],
  [
    "Budapest: don't take on b4 while e2 is pinned (8.Nxe5 Nxe5 9.axb4?? Nd3 is mate too)",
    'd4 Nf6 c4 e5 dxe5 Ng4 Bf4 Nc6 Nf3 Bb4+ Nbd2 Qe7 a3 Ngxe5 Nxe5 Nxe5 axb4 Nd3#',
    'black',
    { mate: true },
  ],
  [
    'Budapest: after 8.Nxe5 Nxe5 9.e3 the pin is gone and White keeps the material level',
    'd4 Nf6 c4 e5 dxe5 Ng4 Bf4 Nc6 Nf3 Bb4+ Nbd2 Qe7 a3 Ngxe5 Nxe5 Nxe5 e3',
    'white',
    { check: (c) => material(c, 'white') === 0 && !c.isCheck() && c.moves().length > 0 },
  ],
];

describe('OPENING_GUIDES: pins the trap notes rely on', () => {
  it('Caro-Kann: 6.Nd6 is mate only because the e2 queen pins the e7 pawn', () => {
    const mate = playSan('e4 c6 d4 d5 Nc3 dxe4 Nxe4 Nd7 Qe2 Ngf6 Nd6'.split(' '));
    expect(mate.isCheckmate()).toBe(true);
    const unpinned = new Chess(mate.fen().replace('PPP1QPPP', 'PPPQ1PPP')); // queen on d2 instead
    expect(unpinned.moves()).toContain('exd6');
  });

  it('Budapest: ...Nd3 is mate only because the e7 queen pins the e2 pawn', () => {
    const mate = playSan('d4 Nf6 c4 e5 dxe5 Ng4 Bf4 Nc6 Nf3 Bb4+ Nbd2 Qe7 a3 Ngxe5 axb4 Nd3'.split(' '));
    expect(mate.isCheckmate()).toBe(true);
    const unpinned = new Chess(mate.fen().replace('ppppqppp', 'pppp1ppp').replace('r1b1k2r', 'r1bqk2r'));
    expect(unpinned.moves()).toContain('exd3');
  });
});

function assertOutcome(chess: Chess, side: 'white' | 'black', outcome: Outcome): void {
  if ('mate' in outcome) {
    expect(chess.isCheckmate()).toBe(true);
    // The side to move is the one that got mated.
    expect(chess.turn()).not.toBe(colorOf(side));
  } else if ('material' in outcome) {
    expect(material(chess, side)).toBeGreaterThanOrEqual(outcome.material);
  } else {
    expect(outcome.check(chess)).toBe(true);
  }
}

const guideId = (g: OpeningGuide) => g.family;

describe('OPENING_GUIDES: shape', () => {
  it('has about three dozen guides with unique families', () => {
    expect(OPENING_GUIDES.length).toBeGreaterThanOrEqual(30);
    const families = OPENING_GUIDES.map((g) => g.family);
    expect(new Set(families).size).toBe(families.length);
  });

  it('covers the openings club players meet most', () => {
    const must = [
      "King's Pawn Game",
      'Italian Game',
      'Ruy Lopez',
      'Scotch Game',
      'Vienna Game',
      "King's Gambit",
      "Petrov's Defense",
      'Philidor Defense',
      'Sicilian Defense',
      'French Defense',
      'Caro-Kann Defense',
      'Scandinavian Defense',
      'Pirc Defense',
      'Alekhine Defense',
      "Queen's Gambit",
      "Queen's Gambit Accepted",
      "Queen's Gambit Declined",
      'Slav Defense',
      'London System',
      'Catalan Opening',
      "King's Indian Defense",
      'Nimzo-Indian Defense',
      "Queen's Indian Defense",
      'Grünfeld Defense',
      'Benoni Defense',
      'Dutch Defense',
      'English Opening',
      'Réti Opening',
      'Bird Opening',
    ];
    for (const f of must) expect(OPENING_GUIDES.some((g) => g.family === f), f).toBe(true);
  });

  it('uses exact dataset family names', () => {
    for (const g of OPENING_GUIDES) expect(datasetFamilies.has(g.family), g.family).toBe(true);
  });

  it('keeps every guide short enough for a phone screen', () => {
    for (const g of OPENING_GUIDES) {
      const id = guideId(g);
      expect(['white', 'black'], id).toContain(g.side);
      expect(['beginner', 'intermediate', 'advanced'], id).toContain(g.level);
      const sentences = g.summary.split(/(?<=[.!?])\s+/);
      expect(sentences.length, `${id}: summary sentences`).toBeGreaterThanOrEqual(2);
      expect(sentences.length, `${id}: summary sentences`).toBeLessThanOrEqual(3);
      expect(g.summary.length, `${id}: summary`).toBeLessThanOrEqual(320);
      for (const list of [g.ideasWhite, g.ideasBlack]) {
        expect(list.length, `${id}: ideas`).toBeGreaterThanOrEqual(2);
        expect(list.length, `${id}: ideas`).toBeLessThanOrEqual(4);
      }
      expect((g.typicalPlans ?? []).length, `${id}: plans`).toBeLessThanOrEqual(4);
      expect((g.keyVariations ?? []).length, `${id}: key variations`).toBeGreaterThanOrEqual(2);
      expect((g.keyVariations ?? []).length, `${id}: key variations`).toBeLessThanOrEqual(6);
      expect((g.traps ?? []).length, `${id}: traps`).toBeLessThanOrEqual(3);
      expect(Object.keys(g.moveNotes ?? {}).length, `${id}: move notes`).toBeGreaterThanOrEqual(4);
      const bullets = [...g.ideasWhite, ...g.ideasBlack, ...(g.typicalPlans ?? [])];
      for (const b of bullets) {
        expect(b.trim(), id).toBe(b);
        expect(b.length, `${id}: "${b}"`).toBeGreaterThan(0);
        expect(b.length, `${id}: "${b}"`).toBeLessThanOrEqual(140);
      }
      for (const v of g.keyVariations ?? []) expect(v.note.length, `${id}: ${v.name}`).toBeLessThanOrEqual(140);
      for (const t of g.traps ?? []) expect(t.note.length, `${id}: ${t.title}`).toBeLessThanOrEqual(220);
      for (const n of Object.values(g.moveNotes ?? {})) expect(n.length, `${id}: "${n}"`).toBeLessThanOrEqual(120);
    }
  });

  it('is written in American English without leftovers', () => {
    const text = JSON.stringify(OPENING_GUIDES);
    for (const bad of [/colour/i, /centre/i, /defence/i, /favour/i, /recognis/i, /organis/i, /analys(e|ing)\b/i, /TODO/, /\s{2,}/]) {
      expect(bad.test(text), String(bad)).toBe(false);
    }
  });
});

describe('OPENING_GUIDES: key variations', () => {
  it('replay legally and end on a position the dataset names exactly that', () => {
    for (const g of OPENING_GUIDES) {
      for (const v of g.keyVariations ?? []) {
        const label = `${g.family} / ${v.name}`;
        expect(datasetNames.has(v.name), label).toBe(true);
        expect(v.uci.length, label).toBeGreaterThan(0);
        const { chess } = playUci(v.uci);
        expect(openingAt(chess.fen())?.name, label).toBe(v.name);
      }
    }
  });

  it('has no duplicate lines within a guide', () => {
    for (const g of OPENING_GUIDES) {
      const lines = (g.keyVariations ?? []).map((v) => v.uci.join(' '));
      expect(new Set(lines).size, g.family).toBe(lines.length);
    }
  });
});

describe('OPENING_GUIDES: traps', () => {
  it('every trap has a checked outcome', () => {
    const keys = OPENING_GUIDES.flatMap((g) => (g.traps ?? []).map((t) => `${g.family} / ${t.title}`));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(Object.keys(TRAP_OUTCOMES).sort());
  });

  it('replay legally and lead to the claimed result for the side that benefits', () => {
    for (const g of OPENING_GUIDES) {
      for (const t of g.traps ?? []) {
        const label = `${g.family} / ${t.title}`;
        expect(['white', 'black'], label).toContain(t.side);
        const { chess, sans } = playUci(t.uci);
        expect(sans.length, label).toBeGreaterThanOrEqual(5);
        const outcome = TRAP_OUTCOMES[label];
        expect(outcome, label).toBeDefined();
        assertOutcome(chess, t.side, outcome);
        // Mates are written with '#', so a note can't claim mate for a line that is not one.
        if (/\bmate\b/i.test(t.title)) expect(chess.isCheckmate(), label).toBe(true);
      }
    }
  });

  it('back up the side-line claims made in the notes', () => {
    for (const [label, line, side, outcome] of NOTE_CLAIMS) {
      const chess = playSan(line.split(' '));
      expect(chess.history().length, label).toBe(line.split(' ').length);
      assertOutcome(chess, side, outcome);
    }
  });
});

describe('OPENING_GUIDES: move notes', () => {
  it('are keyed by canonical numbered SAN lines that replay legally', () => {
    for (const g of OPENING_GUIDES) {
      for (const [key, note] of Object.entries(g.moveNotes ?? {})) {
        const label = `${g.family} / ${key}`;
        expect(note.trim().length, label).toBeGreaterThan(0);
        const sans = key.split(' ').filter((t) => !/^\d+\.$/.test(t));
        const chess = playSan(sans);
        expect(chess.history(), label).toEqual(sans); // SAN exactly as chess.js writes it
        expect(moveNoteKey(sans), label).toBe(key);
        expect(moveNoteFor(g, sans), label).toBe(note);
      }
    }
  });

  it('guideMainLine: the longest annotated line, playable from the start', () => {
    for (const g of OPENING_GUIDES) {
      const line = guideMainLine(g);
      expect(line.length, g.family).toBeGreaterThanOrEqual(4);
      expect(playSan(line).history(), g.family).toEqual(line);
      expect(moveNoteFor(g, line), g.family).toBeDefined();
      const longest = Math.max(...Object.keys(g.moveNotes ?? {}).map((k) => k.split(' ').filter((t) => !/^\d+\.$/.test(t)).length));
      expect(line.length, g.family).toBe(longest);
    }
    // The London guide follows 1. d4 d5 2. Bf4, not the catalog's "London System" line (1. d4 Nf6 2. Nf3 g6 3. Bf4).
    expect(guideMainLine(guideFor('London System')!).slice(0, 3)).toEqual(['d4', 'd5', 'Bf4']);
    expect(guideMainLine({ ...guideFor('London System')!, moveNotes: {} })).toEqual([]);
  });

  it('has a guide for every starter family', () => {
    for (const color of ['w', 'b'] as const) {
      for (const f of BEGINNER_FAMILIES[color]) {
        const g = guideFor(f);
        expect(g, f).toBeDefined();
        expect(g?.side, f).toBe(color === 'w' ? 'white' : 'black');
      }
    }
  });

  it('moveNoteKey / moveNoteFor', () => {
    expect(moveNoteKey([])).toBe('');
    expect(moveNoteKey(['e4'])).toBe('1. e4');
    expect(moveNoteKey(['e4', 'e5', 'Nf3'])).toBe('1. e4 e5 2. Nf3');
    const sicilian = guideFor('Sicilian Defense')!;
    expect(moveNoteFor(sicilian, ['e4', 'c5'])).toMatch(/d4/);
    expect(moveNoteFor(sicilian, [])).toBeUndefined();
    expect(moveNoteFor(sicilian, ['a4'])).toBeUndefined();
  });
});

describe('guideFor', () => {
  it('finds every guide by its family and by each alias', () => {
    for (const g of OPENING_GUIDES) {
      expect(guideFor(g.family), g.family).toBe(g);
      expect(guideFor(g.family.toUpperCase()), g.family).toBe(g);
      for (const a of g.aka ?? []) expect(guideFor(a), `${g.family}: ${a}`).toBe(g);
    }
  });

  it('accepts full dataset names, accents and alternative names', () => {
    const family = (name: string) => guideFor(name)?.family;
    expect(family('Sicilian Defense: Najdorf Variation')).toBe('Sicilian Defense');
    expect(family('Sicilian Defense: Smith-Morra Gambit Accepted, Siberian Variation')).toBe('Sicilian Defense');
    expect(family('Grunfeld Defense: Exchange Variation')).toBe('Grünfeld Defense');
    expect(family('Reti Opening')).toBe('Réti Opening');
    expect(family('Russian Game')).toBe("Petrov's Defense");
    expect(family('Spanish Game')).toBe('Ruy Lopez');
    expect(family("King's Gambit Accepted: Fischer Defense")).toBe("King's Gambit");
    expect(family("Queen's Gambit Declined: Orthodox Defense")).toBe("Queen's Gambit Declined");
    expect(family("Queen's Gambit Declined: Albin Countergambit, Lasker Trap")).toBe("Queen's Gambit");
    expect(family("Queen's Pawn Game: London System, with e6")).toBe('London System');
    expect(family("Queen's Pawn Game: Colle System, Traditional Colle")).toBe("Queen's Pawn Game");
    expect(family('Indian Defense: London System')).toBe('London System');
    expect(family('Indian Defense: Budapest Gambit')).toBe('Indian Defense');
    expect(family('London System, with Be2')).toBe('London System');
    expect(family('Modern Defense: Standard Defense')).toBe('Pirc Defense');
    expect(family('Zukertort Opening: Sicilian Invitation')).toBe('Réti Opening');
    expect(family("Queen's Indian Defense, with e3")).toBe("Queen's Indian Defense");
    expect(family('  sicilian   defense  ')).toBe('Sicilian Defense');
  });

  it('returns undefined for unknown or empty names', () => {
    expect(guideFor('Bongcloud Attack')).toBeUndefined();
    expect(guideFor('')).toBeUndefined();
    expect(guideFor(null)).toBeUndefined();
    expect(guideFor(undefined)).toBeUndefined();
  });

  it('works on what openingAt() returns, for most named positions', () => {
    let covered = 0;
    for (const name of datasetNames) if (guideFor(name)) covered++;
    expect(covered / datasetNames.size).toBeGreaterThan(0.75);
    const najdorf = playSan('e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6'.split(' '));
    expect(guideFor(openingAt(najdorf.fen())?.name)?.family).toBe('Sicilian Defense');
  });
});
