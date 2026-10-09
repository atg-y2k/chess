import { afterEach, describe, expect, it } from 'vitest';
import {
  closeOpenings,
  currentPage,
  drillPage,
  goToPly,
  insertFamilyBelow,
  leaveBook,
  lineOpenedAlone,
  linePage,
  navDirection,
  openingsOpen,
  openingsPages,
  openOpenings,
  popPage,
  popToRoot,
  pushPage,
  rememberScroll,
  replacePage,
  resetOpenings,
  stepLine,
  takeNamedTarget,
  targetPages,
  treeAdvance,
  treeTo,
  updatePage,
  type LinePage,
  type TreePage,
} from '../../src/openings/session';

afterEach(() => resetOpenings());

const kinds = () => openingsPages.value.map((p) => p.kind);

describe('opening and closing', () => {
  it('opens on Home the first time and keeps its pages for the next time', () => {
    expect(openingsOpen.value).toBe(false);
    expect(currentPage.value).toBeNull();
    openOpenings();
    expect(openingsOpen.value).toBe(true);
    expect(kinds()).toEqual(['home']);
    pushPage({ kind: 'family', family: 'Italian Game' });
    closeOpenings();
    expect(openingsOpen.value).toBe(false);
    // Reopened without a target: where it was left.
    openOpenings();
    expect(kinds()).toEqual(['home', 'family']);
    expect(navDirection.value).toBe('none');
  });

  it('opens on a target: Home, its family, its line', () => {
    openOpenings({ family: 'Sicilian Defense', lineId: 'b90-sicilian-defense-najdorf-variation' });
    expect(kinds()).toEqual(['home', 'family', 'line']);
    const line = currentPage.value as LinePage;
    expect(line.lineId).toBe('b90-sicilian-defense-najdorf-variation');
    expect(line.ply).toBe(0);
    expect(line.offBook).toBeNull();
    expect(targetPages({ family: 'French Defense' }).map((p) => p.kind)).toEqual(['home', 'family']);
    expect(targetPages().map((p) => p.kind)).toEqual(['home']);
    // At a move of the line (a game's banner opens it where the game is).
    openOpenings({ lineId: 'c50-italian-game', ply: 3 });
    expect(currentPage.value).toMatchObject({ kind: 'line', lineId: 'c50-italian-game', ply: 3 });
  });

  it('a target replaces the pages that were open', () => {
    openOpenings();
    pushPage({ kind: 'tree', path: ['e2e4'] });
    openOpenings({ family: 'French Defense' });
    expect(kinds()).toEqual(['home', 'family']);
  });

  it('a line opened alone gets its family page under it once it is known', () => {
    openOpenings({ lineId: 'c50-italian-game' });
    expect(kinds()).toEqual(['home', 'line']);
    const key = currentPage.value?.key;
    expect(lineOpenedAlone()).toBe(true);
    insertFamilyBelow('Italian Game');
    expect(kinds()).toEqual(['home', 'family', 'line']);
    expect(currentPage.value?.key).toBe(key);
    expect(lineOpenedAlone()).toBe(false);
    // Once only.
    insertFamilyBelow('Ruy Lopez');
    expect(kinds()).toEqual(['home', 'family', 'line']);
  });

  it('a line reached from Home by the user keeps Home under it', () => {
    openOpenings();
    pushPage(linePage('c50-italian-game'));
    expect(lineOpenedAlone()).toBe(false);
    insertFamilyBelow('Italian Game');
    expect(kinds()).toEqual(['home', 'line']);
  });

  it('an opening asked for by name waits for the data, once', () => {
    openOpenings({ name: 'Italian Game: Two Knights Defense', eco: 'C55' });
    expect(kinds()).toEqual(['home']);
    expect(takeNamedTarget()).toEqual({ name: 'Italian Game: Two Knights Defense', eco: 'C55' });
    expect(takeNamedTarget()).toBeNull();
    openOpenings({ lineId: 'x' });
    expect(takeNamedTarget()).toBeNull();
  });
});

describe('navigation', () => {
  it('pushes and pops pages, and Back from Home closes the section', () => {
    openOpenings();
    pushPage({ kind: 'families' });
    expect(navDirection.value).toBe('forward');
    pushPage({ kind: 'family', family: 'Ruy Lopez' });
    expect(kinds()).toEqual(['home', 'families', 'family']);
    expect(popPage()).toBe(true);
    expect(navDirection.value).toBe('back');
    expect(kinds()).toEqual(['home', 'families']);
    expect(popPage()).toBe(true);
    expect(popPage()).toBe(false);
    expect(openingsOpen.value).toBe(false);
    expect(kinds()).toEqual(['home']);
  });

  it('gives every pushed page its own key; an update keeps it, a replace changes it', () => {
    openOpenings();
    pushPage(linePage('a'));
    pushPage(linePage('a'));
    const [, a, b] = openingsPages.value;
    expect(a.key).toBeDefined();
    expect(a.key).not.toBe(b.key);
    updatePage('line', (p) => ({ ...p, ply: 3 }));
    expect(currentPage.value?.key).toBe(b.key);
    expect((currentPage.value as LinePage).ply).toBe(3);
    replacePage(drillPage('a', 'b'));
    expect(currentPage.value?.kind).toBe('drill');
    expect(currentPage.value?.key).not.toBe(b.key);
    popToRoot();
    expect(kinds()).toEqual(['home']);
  });

  it('updates only a top page of the kind asked for', () => {
    openOpenings();
    pushPage({ kind: 'family', family: 'Ruy Lopez' });
    updatePage('line', (p) => ({ ...p, ply: 9 }));
    expect(currentPage.value).toMatchObject({ kind: 'family', family: 'Ruy Lopez' });
    updatePage('family', (p) => ({ ...p, showAll: true }));
    expect(currentPage.value).toMatchObject({ kind: 'family', showAll: true });
  });

  it('remembers the scroll offset of the page under a new one', () => {
    openOpenings();
    rememberScroll(420);
    pushPage({ kind: 'families' });
    expect(openingsPages.value[0].scroll).toBe(420);
    expect(currentPage.value?.scroll).toBeUndefined();
    popPage();
    expect(currentPage.value?.scroll).toBe(420);
  });

  it('keeps a page’s search, its "Show all" and its filter when another page goes over it and comes back', () => {
    openOpenings();
    updatePage('home', (p) => ({ ...p, query: 'sicilian', allStarters: true }));
    rememberScroll(510);
    pushPage(linePage('b20-sicilian-defense'));
    updatePage('line', (p) => ({ ...p, moreOthers: true }));
    pushPage({ kind: 'families' });
    updatePage('families', (p) => ({ ...p, side: 'b' }));
    pushPage({ kind: 'family', family: 'Sicilian Defense' });
    popPage();
    expect(currentPage.value).toMatchObject({ kind: 'families', side: 'b' });
    popPage();
    expect(currentPage.value).toMatchObject({ kind: 'line', moreOthers: true });
    popPage();
    expect(currentPage.value).toMatchObject({ kind: 'home', query: 'sicilian', allStarters: true, scroll: 510 });
  });
});

describe('step state', () => {
  const page = (ply: number): LinePage => ({ ...linePage('x', ply), key: 1 });

  it('clamps plies to the line and leaves the page unchanged when nothing moves', () => {
    expect(goToPly(page(2), 5, 10).ply).toBe(5);
    expect(goToPly(page(2), 50, 10).ply).toBe(10);
    expect(goToPly(page(2), -3, 10).ply).toBe(0);
    expect(goToPly(page(2), Number.NaN, 10).ply).toBe(0);
    const p = page(4);
    expect(goToPly(p, 4, 10)).toBe(p);
    expect(linePage('x', 2.7).ply).toBe(2);
  });

  it('steps forward and back along the line', () => {
    expect(stepLine(page(0), 1, 10).ply).toBe(1);
    expect(stepLine(page(10), 1, 10).ply).toBe(10);
    expect(stepLine(page(0), -1, 10).ply).toBe(0);
    expect(stepLine(page(4), -1, 10).ply).toBe(3);
  });

  it('a move off the book stays on its ply; Back undoes it, Forward continues the line', () => {
    const off = leaveBook(page(4), { uci: 'h2h4', san: 'h4', fen: 'fen' });
    expect(off.offBook?.san).toBe('h4');
    expect(off.ply).toBe(4);
    const back = stepLine(off, -1, 10);
    expect(back.offBook).toBeNull();
    expect(back.ply).toBe(4);
    const fwd = stepLine(off, 1, 10);
    expect(fwd.offBook).toBeNull();
    expect(fwd.ply).toBe(5);
    expect(goToPly(off, 4, 10).offBook).toBeNull();
  });

  it('moves through the tree and back along its trail', () => {
    const t: TreePage = { kind: 'tree', path: [] };
    const a = treeAdvance(treeAdvance(t, 'e2e4'), 'c7c5');
    expect(a.path).toEqual(['e2e4', 'c7c5']);
    expect(treeTo(a, 1).path).toEqual(['e2e4']);
    expect(treeTo(a, 0).path).toEqual([]);
    expect(treeTo(a, 9)).toBe(a);
    expect(treeTo(a, -2).path).toEqual([]);
  });

  it('a drill page starts on its setup', () => {
    expect(drillPage('l', 'w')).toEqual({
      kind: 'drill',
      lineId: 'l',
      color: 'w',
      acceptAlternatives: false,
      state: null,
      feedback: null,
      hint: null,
      tried: null,
      recorded: null,
    });
    expect(drillPage('l', 'b', true).acceptAlternatives).toBe(true);
  });
});
