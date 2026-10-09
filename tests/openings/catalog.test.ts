import { describe, expect, it } from 'vitest';
import {
  catalogLoaded,
  FAMILY_ALIASES,
  families,
  findLine,
  getFamily,
  getLine,
  isMainLine,
  linesNamed,
  linesOfFamily,
  loadCatalog,
  mainLine,
  normalizeText,
  relatedFamilies,
  search,
  searchFamilies,
  splitLineName,
  type SearchMatch,
} from '../../src/openings/catalog';

const names = (q: string, limit?: number) => search(q, limit).map((r) => r.line.name);

describe('before loadCatalog()', () => {
  it('answers nothing instead of throwing', () => {
    expect(catalogLoaded()).toBe(false);
    expect(search('sicilian')).toEqual([]);
    expect(searchFamilies('sicilian')).toEqual([]);
    expect(families()).toEqual([]);
    expect(getLine('c60-ruy-lopez')).toBeNull();
    expect(linesOfFamily('Ruy Lopez')).toEqual([]);
    expect(mainLine('Ruy Lopez')).toBeNull();
  });

  it('loads once (concurrent calls share the load)', async () => {
    await Promise.all([loadCatalog(), loadCatalog()]);
    expect(catalogLoaded()).toBe(true);
  });
});

describe('text helpers', () => {
  it('normalizes case, accents, apostrophes and punctuation', () => {
    expect(normalizeText("Queen's Gambit")).toBe('queens gambit');
    expect(normalizeText('Queen’s  Gambit')).toBe('queens gambit');
    expect(normalizeText('Grünfeld Defense')).toBe('grunfeld defense');
    expect(normalizeText('Caro-Kann Defense: Panov Attack')).toBe('caro kann defense panov attack');
  });

  it('splits names into family and variation', () => {
    expect(splitLineName('Sicilian Defense')).toEqual({ family: 'Sicilian Defense', variation: '' });
    expect(splitLineName('Sicilian Defense: Najdorf Variation, English Attack')).toEqual({
      family: 'Sicilian Defense',
      variation: 'Najdorf Variation, English Attack',
    });
    expect(splitLineName('London System, with Bd3')).toEqual({ family: 'London System', variation: 'with Bd3' });
    expect(splitLineName('Vienna Gambit, with Max Lange Defense: Steinitz Gambit')).toEqual({
      family: 'Vienna Gambit',
      variation: 'with Max Lange Defense, Steinitz Gambit',
    });
  });
});

describe('search', () => {
  it('finds a variation by one word: "najdorf"', async () => {
    await loadCatalog();
    const r = search('najdorf');
    expect(r[0].line.name).toBe('Sicilian Defense: Najdorf Variation');
    expect(r[0].match).toBe('variation');
    expect(r.every((x) => x.line.name.includes('Najdorf'))).toBe(true);
    expect(names('Najdorf')).toEqual(names('najdorf'));
    expect(names('sicilian najdorf')[0]).toBe('Sicilian Defense: Najdorf Variation');
  });

  it('puts an exact family first: "ruy lopez"', async () => {
    await loadCatalog();
    const r = search('ruy lopez', 10);
    expect(r[0].line.name).toBe('Ruy Lopez');
    expect(r[0].line.id).toBe(getFamily('Ruy Lopez')?.mainLineId);
    expect(r.every((x) => x.line.family === 'Ruy Lopez' && x.match === 'family')).toBe(true);
    expect(names('ruy')[0]).toBe('Ruy Lopez');
    // more popular lines first within a rank
    const pops = r.slice(1).map((x) => x.line.popularity);
    expect(pops).toEqual([...pops].sort((a, b) => b - a));
  });

  it('matches "queens gambit" to Queen\'s Gambit, then its related families', async () => {
    await loadCatalog();
    for (const q of ['queens gambit', "Queen's Gambit", 'Queen’s Gambit', 'QUEENS GAMBIT', 'queen gambit']) {
      const n = names(q, 10);
      expect(n[0], q).toBe("Queen's Gambit");
      expect(n.slice(1, 3).sort(), q).toEqual(["Queen's Gambit Accepted", "Queen's Gambit Declined"]);
    }
    expect(searchFamilies('queens gambit').slice(0, 3).map((f) => f.name)).toEqual([
      "Queen's Gambit",
      "Queen's Gambit Declined",
      "Queen's Gambit Accepted",
    ]);
  });

  it('finds lines by ECO code: "B90"', async () => {
    await loadCatalog();
    const r = search('B90', 100);
    expect(r.length).toBeGreaterThan(3);
    expect(r.every((x) => x.line.eco === 'B90' && x.match === 'eco')).toBe(true);
    expect(r[0].line.name).toBe('Sicilian Defense: Najdorf Variation');
    expect(names('b90', 100)).toEqual(r.map((x) => x.line.name));
  });

  it('matches a family prefix: "caro"', async () => {
    await loadCatalog();
    const r = search('caro');
    expect(r[0].line.name).toBe('Caro-Kann Defense');
    expect(r[0].match).toBe('family-prefix');
    expect(names('caro kann')[0]).toBe('Caro-Kann Defense');
    expect(names('caro-kann')[0]).toBe('Caro-Kann Defense');
  });

  it('ignores accents: "grunfeld", "reti"', async () => {
    await loadCatalog();
    expect(names('grunfeld')[0]).toBe('Grünfeld Defense');
    expect(names('reti')[0]).toBe('Réti Opening');
  });

  it('finds lines by their moves', async () => {
    await loadCatalog();
    expect(search('e4 c5')[0]).toMatchObject({ match: 'moves', line: { name: 'Sicilian Defense' } });
    expect(names('1. e4 e5 2. Nf3 Nc6 3. Bb5')[0]).toBe('Ruy Lopez');
    expect(names('1.d4 d5 2.c4')[0]).toBe("Queen's Gambit");
    expect(names('e4 e6')[0]).toBe('French Defense');
    expect(search('e4 c5 nf3').every((r) => r.line.san.slice(0, 3).join(' ') === 'e4 c5 Nf3')).toBe(true);
  });

  it('ranks move matches: the exact line first, then by popularity (no boost for obscure families)', async () => {
    await loadCatalog();
    for (const [q, eco, name] of [
      ['e4 e5', 'C20', "King's Pawn Game"],
      ['d4 d5', 'D00', "Queen's Pawn Game"],
      ['c4', 'A10', 'English Opening'],
      ['Nf3', 'A04', 'Zukertort Opening'],
    ]) {
      const r = search(q, 30);
      expect(r[0].line, q).toMatchObject({ eco, name });
      const pops = r.slice(1).map((x) => x.line.popularity);
      expect(pops, q).toEqual([...pops].sort((a, b) => b - a));
    }
    // fringe openings no longer outrank popular variations
    const e4e5 = names('e4 e5', 30);
    expect(e4e5.slice(0, 5)).toEqual(expect.arrayContaining(["King's Knight Opening", 'Ruy Lopez']));
    expect(e4e5.slice(0, 10)).not.toContain('Bongcloud Attack');
    expect(names('c4', 3)).toContain('English Opening: Anglo-Indian Defense');
  });

  it('finds common other names and abbreviations', async () => {
    await loadCatalog();
    const top = (q: string) => search(q, 5)[0]?.line.family;
    expect(top('spanish game')).toBe('Ruy Lopez');
    expect(top('Spanish')).toBe('Ruy Lopez');
    expect(top('russian game')).toBe("Petrov's Defense");
    expect(top('petroff')).toBe("Petrov's Defense");
    expect(top('center counter')).toBe('Scandinavian Defense');
    expect(top('QGD')).toBe("Queen's Gambit Declined");
    expect(top('qga')).toBe("Queen's Gambit Accepted");
    expect(top('KID')).toBe("King's Indian Defense");
    expect(top('kia')).toBe("King's Indian Attack");
    expect(top('qid')).toBe("Queen's Indian Defense");
    expect(top('nid')).toBe('Nimzo-Indian Defense');
    expect(top('gruenfeld')).toBe('Grünfeld Defense');
    expect(search('spanish game')[0].match).toBe('family');
    expect(search('russ')[0]).toMatchObject({ match: 'family-prefix', line: { family: "Petrov's Defense" } });
    // British spellings
    expect(names('sicilian defence')[0]).toBe('Sicilian Defense');
    expect(searchFamilies('spanish')[0].name).toBe('Ruy Lopez');
    // every alias names an existing family
    for (const [alias, list] of Object.entries(FAMILY_ALIASES)) {
      expect(alias, alias).toBe(normalizeText(alias));
      for (const f of list) expect(getFamily(f)?.name, alias).toBe(f);
    }
  });

  it('ranks by match kind, lists each ECO code + name once and honors the limit', async () => {
    await loadCatalog();
    const rank: Record<SearchMatch, number> = { eco: 0, moves: 0, family: 1, 'family-prefix': 2, variation: 3, words: 4, substring: 5 };
    for (const q of ['queens gambit', 'kings', 'attack', 'dragon', 'english', 'gambit']) {
      const r = search(q, 50);
      const ranks = r.map((x) => rank[x.match]);
      expect(ranks, q).toEqual([...ranks].sort((a, b) => a - b));
      expect(new Set(r.map((x) => `${x.line.eco} ${x.line.name}`)).size, q).toBe(r.length);
    }
    expect(search('defense', 7)).toHaveLength(7);
    expect(search('defense', 0)).toEqual([]);
    expect(search('defense', -1)).toEqual([]);
    expect(search('defense', Number.NaN)).toEqual([]);
    expect(searchFamilies('defense', 0)).toEqual([]);
    expect(search('')).toEqual([]);
    expect(search('   ')).toEqual([]);
    expect(search('zzzz')).toEqual([]);
  });

  it('keeps a name that the dataset gives to different ECO codes findable', async () => {
    await loadCatalog();
    const kpg = search("king's pawn game", 100).filter((r) => r.line.name === "King's Pawn Game");
    expect(kpg.map((r) => `${r.line.eco} ${r.line.san.join(' ')}`)).toEqual(['B00 e4', 'C20 e4 e5']);
    // the same ECO code + name with another move order appears once
    expect(search('gedult gambit', 100).filter((r) => r.line.name === 'Barnes Opening: Gedult Gambit')).toHaveLength(1);
  });

  it('finds families: "najdorf" -> Sicilian Defense', async () => {
    await loadCatalog();
    expect(searchFamilies('najdorf').map((f) => f.name)).toEqual(['Sicilian Defense']);
    expect(searchFamilies('caro')[0].name).toBe('Caro-Kann Defense');
    expect(searchFamilies('kings indian').map((f) => f.name).slice(0, 2)).toEqual(["King's Indian Defense", "King's Indian Attack"]);
  });

  it('ranks families within a match kind by their best matching line, not by family size', async () => {
    await loadCatalog();
    const fams = (q: string, n = 3) => searchFamilies(q, n).map((f) => f.name);
    expect(fams('e4 e5')[0]).toBe("King's Pawn Game");
    expect(fams('e4 e5', 4)).not.toContain('English Opening'); // only "The Whale" (1. e4 e5 2. c4)
    expect(fams('two knights')[0]).toBe('Italian Game');
    expect(fams('alapin')[0]).toBe('Sicilian Defense');
  });
});

describe('families', () => {
  it('sorts families by popularity', async () => {
    await loadCatalog();
    const order = families().map((f) => f.name);
    const at = (n: string) => order.indexOf(n);
    expect(at('Sicilian Defense')).toBeGreaterThanOrEqual(0);
    expect(at('Sicilian Defense')).toBeLessThan(at('Ruy Lopez'));
    expect(at('Ruy Lopez')).toBeLessThan(at('Scotch Game'));
    expect(at('French Defense')).toBeLessThan(at('Alekhine Defense'));
    expect(at("Queen's Gambit Declined")).toBeLessThan(at('Grob Opening'));
    expect(Object.isFrozen(families())).toBe(true);
  });

  it('looks families up by name, tolerantly', async () => {
    await loadCatalog();
    expect(getFamily('Sicilian Defense')?.lineCount).toBe(391);
    expect(getFamily('queens gambit declined')?.name).toBe("Queen's Gambit Declined");
    expect(getFamily('Grunfeld Defense')?.name).toBe('Grünfeld Defense');
    expect(getFamily('No Such Opening')).toBeNull();
  });

  it('lists a family main line first, then by popularity (or by ECO / name)', async () => {
    await loadCatalog();
    const lines = linesOfFamily('Sicilian Defense');
    expect(lines).toHaveLength(391);
    expect(lines[0].name).toBe('Sicilian Defense');
    expect(isMainLine(lines[0])).toBe(true);
    expect(isMainLine(lines[1].id)).toBe(false);
    const pops = lines.slice(1).map((l) => l.popularity);
    expect(pops).toEqual([...pops].sort((a, b) => b - a));
    const ecos = linesOfFamily('Sicilian Defense', 'eco').map((l) => l.eco);
    expect(ecos).toEqual([...ecos].sort());
    const byName = linesOfFamily('Sicilian Defense', 'name').map((l) => l.name);
    expect(byName).toEqual([...byName].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(mainLine('Italian Game')?.san).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    expect(mainLine('Benoni Defense')?.name).toBe('Benoni Defense'); // the base line, not the shorter Old Benoni
    expect(search('benoni')[0].line.name).toBe('Benoni Defense');
    expect(linesOfFamily('No Such Opening')).toEqual([]);
  });

  it('returns copies (callers cannot reorder the catalog)', async () => {
    await loadCatalog();
    linesOfFamily('Ruy Lopez').reverse();
    expect(linesOfFamily('Ruy Lopez')[0].name).toBe('Ruy Lopez');
  });

  it('relates gambits to their accepted and declined forms', async () => {
    await loadCatalog();
    expect(relatedFamilies("Queen's Gambit").map((f) => f.name)).toEqual(["Queen's Gambit Declined", "Queen's Gambit Accepted"]);
    expect(relatedFamilies("King's Gambit Accepted").map((f) => f.name).sort()).toEqual(["King's Gambit", "King's Gambit Declined"]);
    expect(relatedFamilies('Sicilian Defense')).toEqual([]);
  });

  it('finds lines by exact name', async () => {
    await loadCatalog();
    expect(findLine('Sicilian Defense: Najdorf Variation')?.id).toBe('b90-sicilian-defense-najdorf-variation');
    expect(findLine('Queen\'s Pawn Game', 'D00')?.eco).toBe('D00');
    expect(findLine('Nope')).toBeNull();
    const dup = linesNamed('Barnes Opening: Gedult Gambit');
    expect(dup.map((l) => l.id)).toEqual(['a00-barnes-opening-gedult-gambit', 'a00-barnes-opening-gedult-gambit-1dmuenk']);
  });
});
