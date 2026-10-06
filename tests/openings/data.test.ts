import { Chess } from 'chess.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { bookMoves, isBookPosition, loadOpenings, openingAt } from '../../src/bot/book';
import { fenKey, parseUci } from '../../src/chess/utils';
import {
  allLines,
  BEGINNER_FAMILIES,
  beginnerFamilies,
  catalogMeta,
  families,
  getLine,
  linesOfFamily,
  loadCatalog,
  splitLineName,
} from '../../src/openings/catalog';

beforeAll(async () => {
  await Promise.all([loadCatalog(), loadOpenings()]);
});

describe('opening-lines.json', () => {
  it('has every line of the pinned dataset', () => {
    const meta = catalogMeta()!;
    expect(meta.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(meta.license).toBe('CC0-1.0');
    expect(meta.lines).toBe(3815);
    expect(allLines()).toHaveLength(meta.lines);
    expect(families()).toHaveLength(meta.families);
  });

  it('every line replays legally from the start position, through book moves, to its epd', () => {
    const problems: string[] = [];
    for (const line of allLines()) {
      if (line.uci.length !== line.plies || line.san.length !== line.plies) problems.push(`${line.id}: length`);
      const chess = new Chess();
      let product = 1;
      line.uci.forEach((u, i) => {
        const before = chess.fen();
        const list = bookMoves(before);
        const known = list.find((m) => m.uci === u);
        if (!known) problems.push(`${line.id}: ply ${i + 1} ${u} is not a book move`);
        product *= (known?.weight ?? 0) / list.reduce((s, m) => s + m.weight, 0);
        try {
          const mv = chess.move(parseUci(u));
          if (mv.san !== line.san[i]) problems.push(`${line.id}: ply ${i + 1} SAN ${mv.san} != ${line.san[i]}`);
        } catch {
          problems.push(`${line.id}: ply ${i + 1} ${u} is illegal`);
        }
        if (!isBookPosition(chess.fen())) problems.push(`${line.id}: ply ${i + 1} leaves book`);
      });
      if (fenKey(chess.fen()) !== line.epd) problems.push(`${line.id}: ends at ${fenKey(chess.fen())}, not ${line.epd}`);
      const named = openingAt(chess.fen());
      if (named?.eco !== line.eco || named.name !== line.name) problems.push(`${line.id}: named ${JSON.stringify(named)}`);
      // popularity = product of the moves' shares among their siblings (3 significant digits)
      if (Math.abs(product - line.popularity) > product * 0.006) problems.push(`${line.id}: popularity ${line.popularity} vs ${product}`);
    }
    expect(problems).toEqual([]);
  }, 120_000); // ~37k chess.js moves, twice (the catalog derives uci/epd by replaying the SAN)

  it('gives every line a unique, stable id', () => {
    const ids = allLines().map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-e]\d\d(-[a-z0-9]+)+$/);
    expect(getLine('b90-sicilian-defense-najdorf-variation')?.name).toBe('Sicilian Defense: Najdorf Variation');
    expect(getLine('d06-queens-gambit')?.san).toEqual(['d4', 'd5', 'c4']);
    expect(getLine('d70-neo-grunfeld-defense-goglidze-attack')?.name).toBe('Neo-Grünfeld Defense: Goglidze Attack');
    // A name the dataset repeats: the shortest line keeps the plain slug, the other one gets a move hash.
    expect(getLine('a00-barnes-opening-gedult-gambit')?.san.join(' ')).toBe('f3 f5 e4 fxe4 Nc3');
    expect(getLine('a00-barnes-opening-gedult-gambit-1dmuenk')?.san.join(' ')).toBe('f3 d5 e4 g6 d4 dxe4 c3');
  });

  it('splits names into family and variation consistently with the families index', () => {
    const total = families().reduce((s, f) => s + f.lineCount, 0);
    expect(total).toBe(allLines().length);
    const names = new Set(families().map((f) => f.name));
    for (const line of allLines()) {
      expect(splitLineName(line.name)).toEqual({ family: line.family, variation: line.variation });
      expect(names.has(line.family)).toBe(true);
    }
    expect(names.has('London System, with Bd3')).toBe(false); // folded into "London System"
  });

  it('keeps the families index consistent with the lines', () => {
    const problems: string[] = [];
    for (const f of families()) {
      const lines = linesOfFamily(f.name);
      if (lines.length !== f.lineCount) problems.push(`${f.name}: ${lines.length} lines, index says ${f.lineCount}`);
      if (lines.some((l) => l.family !== f.name)) problems.push(`${f.name}: foreign line`);
      const main = getLine(f.mainLineId);
      // The main line: the family's base line (the most popular if repeated), else its shortest line.
      const bases = lines.filter((l) => l.variation === '');
      if (main?.family !== f.name) problems.push(`${f.name}: main line ${f.mainLineId} not in the family`);
      else if (bases.length && (main.variation !== '' || bases.some((l) => l.popularity > main.popularity))) {
        problems.push(`${f.name}: main line is not its most popular base line`);
      } else if (!bases.length && lines.some((l) => l.plies < main.plies)) problems.push(`${f.name}: main line is not the shortest`);
      if (lines[0]?.id !== f.mainLineId) problems.push(`${f.name}: linesOfFamily does not start with the main line`);
      const ecos = lines.map((l) => l.eco).sort();
      const range = ecos[0] === ecos.at(-1) ? ecos[0] : `${ecos[0]}-${ecos.at(-1)}`;
      if (range !== f.ecoRange) problems.push(`${f.name}: ECO range ${f.ecoRange}, lines span ${range}`);
      if (main && Math.abs(main.popularity - f.popularity) > 1e-12) problems.push(`${f.name}: popularity`);
      // weight = book weight of the main line's last move
      if (main) {
        const chess = new Chess();
        for (const u of main.uci.slice(0, -1)) chess.move(parseUci(u));
        const w = bookMoves(chess.fen()).find((m) => m.uci === main.uci.at(-1))?.weight;
        if (w !== f.weight) problems.push(`${f.name}: weight ${f.weight}, book says ${w}`);
      }
    }
    expect(problems).toEqual([]);
    const weights = families().map((f) => f.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  it('knows which side chooses an opening', () => {
    const side = (n: string) => families().find((f) => f.name === n)?.side;
    expect(side('Sicilian Defense')).toBe('b');
    expect(side("King's Indian Defense")).toBe('b');
    expect(side('Ruy Lopez')).toBe('w');
    expect(side("Queen's Gambit")).toBe('w');
    expect(side("King's Gambit Accepted")).toBe('b');
    expect(side('Benko Gambit')).toBe('b');
    expect(side('Benko Gambit Accepted')).toBe('w');
    expect(side('Creepy Crawly Formation')).toBe('w'); // SIDE_OVERRIDES: 1. h3 and 2. a3 are White's
    expect(side('Lasker Simul Special')).toBe('b'); // 1. g3 h5: Black's idea
  });

  it("picks the line named after the family as its main line, even when a variation is shorter", () => {
    const main = (n: string) => getLine(families().find((f) => f.name === n)!.mainLineId)!;
    expect(main('Benoni Defense')).toMatchObject({ name: 'Benoni Defense', san: ['d4', 'Nf6', 'c4', 'c5'] }); // not the Old Benoni (1. d4 c5)
    expect(main('Semi-Slav Defense').name).toBe('Semi-Slav Defense');
    expect(main('Lion Defense').name).toBe('Lion Defense');
    expect(main("King's Pawn Game").san).toEqual(['e4']); // the most popular of its two base lines
    expect(main("King's Gambit Declined").name).toBe("King's Gambit Declined: Falkbeer Countergambit"); // no base line: the shortest
  });

  it('lists starter families that exist exactly, for the side that plays them', () => {
    for (const color of ['w', 'b'] as const) {
      const list = BEGINNER_FAMILIES[color];
      expect(list.length).toBeGreaterThanOrEqual(14);
      expect(new Set(list).size).toBe(list.length);
      const resolved = beginnerFamilies(color);
      expect(resolved.map((f) => f.name)).toEqual(list);
      for (const f of resolved) expect(f.side, f.name).toBe(color);
    }
    expect(BEGINNER_FAMILIES.w).toEqual(expect.arrayContaining(['Italian Game', 'Ruy Lopez', "Queen's Gambit", 'London System']));
    expect(BEGINNER_FAMILIES.b).toEqual(expect.arrayContaining(['Sicilian Defense', 'French Defense', 'Caro-Kann Defense']));
  });

  it('exposes lines as frozen data whose computed fields serialize', () => {
    const line = getLine('c60-ruy-lopez')!;
    expect(Object.isFrozen(line)).toBe(true);
    expect(Object.isFrozen(line.san)).toBe(true);
    const json = JSON.parse(JSON.stringify(line)) as Record<string, unknown>;
    expect(json.uci).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5']);
    expect(json.epd).toBe('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq -');
    expect({ ...line }.uci).toBe(line.uci);
  });
});
