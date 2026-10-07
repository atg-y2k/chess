import { Chess } from 'chess.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { START_FEN } from '../../src/chess/utils';
import { DEFAULT_SETTINGS } from '../../src/game/types';
import type { BotPersona } from '../../src/bot/types';
import { beginnerFamilies, families, mainLine, search } from '../../src/openings/catalog';
import { guideFor } from '../../src/data/opening-guides';
import { checkMove, createDrill, drillHint, playOpponent } from '../../src/openings/drill';
import { drillPage, linePage } from '../../src/openings/session';
import { dotState } from '../../src/ui/openings/DrillPage';
import {
  branchTarget,
  catalogLineWithMoves,
  commonWord,
  deepestCatalogPrefix,
  difficultyLabel,
  drillFeedback,
  endsGame,
  familyHits,
  evalWords,
  familyFacts,
  familyStudyIds,
  firstSentence,
  learnTarget,
  loadOpeningsData,
  mainContinuation,
  mainStudyLineId,
  movesSummary,
  movesText,
  nextLineId,
  openingStart,
  ownGuide,
  playTarget,
  plyOfLabel,
  resolveLine,
  sideSentence,
  starterFamilies,
  studySteps,
  treePosition,
  ucisOf,
} from '../../src/ui/openings/model';
import { lineEnd, movesCount } from '../../src/ui/openings/LinePage';
import { pageTitle } from '../../src/ui/openings/OpeningsView';
import { playSettings } from '../../src/ui/openings/PlaySheet';
import { evalFromResult, verdictFor } from '../../src/ui/openings/useEval';

const NB = ' ';
const ITALIAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'];

beforeAll(async () => {
  await loadOpeningsData();
});

describe('study lines', () => {
  it('resolves catalog lines with their side, played by their own id', () => {
    const l = resolveLine('b90-sicilian-defense-najdorf-variation');
    expect(l).toMatchObject({ kind: 'catalog', family: 'Sicilian Defense', variation: 'Najdorf Variation', eco: 'B90', side: 'b' });
    expect(l?.playable).toBe(true);
    expect(openingStart(l!, 'skip')).toEqual({ lineId: l?.id, mode: 'skip' });
    expect(l?.san.slice(0, 2)).toEqual(['e4', 'c5']);
    expect(resolveLine('no-such-line')).toBeNull();
  });

  it('learns a family from its own guide’s annotated main line, else from the catalog’s main line', () => {
    expect(mainStudyLineId('Italian Game')).toBe('guide:Italian Game');
    const g = resolveLine('guide:Italian Game');
    expect(g).toMatchObject({ kind: 'guide', name: 'Italian Game: Main line', family: 'Italian Game', side: 'w' });
    expect(g?.san.slice(0, 5)).toEqual(ITALIAN);
    expect(g?.uci.length).toBe(g?.san.length);
    // A game follows the guide's line itself (its own moves), named after the opening.
    expect(g?.playable).toBe(true);
    expect(openingStart(g!, 'steer', true)).toEqual({
      lineId: 'guide:Italian Game',
      mode: 'steer',
      showLineMoves: true,
      moves: g?.uci,
      name: 'Italian Game',
      family: 'Italian Game',
    });
    // A family without a guide of its own (Englund Gambit Declined is covered by the Englund guide)
    // learns the catalog's main line.
    expect(ownGuide('Englund Gambit Declined')).toBeUndefined();
    expect(mainStudyLineId('Englund Gambit Declined')).toBe(mainLine('Englund Gambit Declined')?.id);
    expect(resolveLine('guide:No Such Opening')).toBeNull();
  });

  it('steps through a trap, the mistake flagged', () => {
    const t = resolveLine('trap:Italian Game:0');
    expect(t?.kind).toBe('trap');
    expect(t?.trap?.title).toBe('Fried Liver Attack');
    expect(t?.trap?.side).toBe('w');
    expect(t?.playable).toBe(false);
    const steps = studySteps(t!);
    expect(steps.length).toBe(t!.san.length + 1);
    expect(steps.filter((s) => s.dubious).map((s) => s.label)).toEqual(['5... Nxd5']);
    expect(resolveLine('trap:Italian Game:99')).toBeNull();
  });

  it('flags a trap’s own mistakes, also where the opening book does not know them', () => {
    // Scholar's Mate: 3... Nf6?? is in no book line.
    const t = resolveLine('trap:King\'s Pawn Game:0')!;
    expect(t.trap?.mistakes).toEqual([5]);
    expect(studySteps(t).filter((s) => s.dubious).map((s) => s.label)).toEqual(['3... Nf6']);
    expect(lineEnd(t, true, false)).toBe('Checkmate: that is how the trap ends.');
  });

  it('says what to do at the end of a line, the other moves only when there are some', () => {
    const l = resolveLine('c50-italian-game')!;
    expect(lineEnd(l, false, true)).toBe(
      'That is the end of this line. Next, try Drill this line or Play it vs computer, or look at the other moves below.',
    );
    expect(lineEnd(l, false, false)).toBe('That is the end of this line. Next, try Drill this line or Play it vs computer.');
    expect(lineEnd(resolveLine('a00-barnes-opening-fools-mate')!, true, false)).toBe('Checkmate: that is how this line ends.');
    expect(endsGame(resolveLine('a00-barnes-opening-fools-mate')!)).toBe(true);
    expect(endsGame(l)).toBe(false);
  });

  it('names every position of a line from the start', () => {
    const steps = studySteps(resolveLine('guide:Italian Game')!);
    expect(steps[0]).toMatchObject({ ply: 0, fen: START_FEN, uci: null, label: null, name: null });
    expect(steps[1]).toMatchObject({ ply: 1, uci: 'e2e4', san: 'e4', color: 'w', label: '1. e4' });
    expect(steps[5].name?.family).toBe('Italian Game');
    expect(steps[6].name).toMatchObject({ family: 'Italian Game', variation: 'Giuoco Piano', exact: true });
  });

  it('shows a family’s main study line on its card without replaying it', () => {
    for (const f of [...beginnerFamilies('w'), ...beginnerFamilies('b'), ...families().slice(0, 40)]) {
      const facts = familyFacts(f);
      expect(facts.mainId, f.name).toBe(mainStudyLineId(f.name));
      expect(facts.mainSan, f.name).toEqual(resolveLine(facts.mainId!)?.san);
    }
  });

  it('lists a family’s lines with its study line first, for "Next variation"', () => {
    const ids = familyStudyIds('Italian Game');
    expect(ids[0]).toBe('guide:Italian Game');
    // Not the base line "Italian Game" (1. e4 e5 2. Nf3 Nc6 3. Bc4), which only starts the main line.
    const next = nextLineId(ids[0]);
    expect(next).not.toBe('c50-italian-game');
    const main = resolveLine(ids[0])!.san;
    const nextSan = resolveLine(next!)!.san;
    expect(nextSan.length > main.length || nextSan.some((m, k) => m !== main[k])).toBe(true);
    expect(nextLineId(ids[ids.length - 1])).toBeNull();
  });

  it('finds catalog lines by their exact moves and the deepest one along longer moves', () => {
    expect(catalogLineWithMoves(ITALIAN)?.id).toBe('c50-italian-game');
    expect(catalogLineWithMoves(['e4', 'h5', 'Qh5'])).toBeNull();
    expect(deepestCatalogPrefix([...ITALIAN, 'Bc5', 'a3', 'a6'])?.name).toBe('Italian Game: Giuoco Piano');
    expect(ucisOf(['e4', 'e5', 'Qh5', 'bad'])).toEqual(['e2e4', 'e7e5', 'd1h5']);
  });
});

describe('where moves lead', () => {
  it('branches into the line that goes on the main way after the move', () => {
    const t = branchTarget(ITALIAN, { san: 'Nf6', uci: 'g8f6' });
    expect('lineId' in t && t.ply).toBe(6);
    const line = 'lineId' in t ? resolveLine(t.lineId) : null;
    expect(line?.san.slice(0, 6)).toEqual([...ITALIAN, 'Nf6']);
    expect(line?.family).toBe('Italian Game');
  });

  it('follows the main moves for "Learn this line": 1. e4 e5 leads on into a long line', () => {
    const l = mainContinuation(['e4', 'e5']);
    expect(l && l.plies > 6).toBe(true);
    expect(l?.san.slice(0, 2)).toEqual(['e4', 'e5']);
    const pos = treePosition(['e2e4', 'e7e5']);
    expect(learnTarget(pos)).toEqual({ lineId: l?.id, ply: 2 });
    expect(learnTarget(treePosition([]))).toBeNull();
  });

  it('plays up to a mate, never from after it', () => {
    const mate = treePosition(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(playTarget(mate)).toEqual({ lineId: 'a00-barnes-opening-fools-mate', exact: false });
  });

  it('plays from a named position, or the line through it', () => {
    expect(playTarget(treePosition(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']))).toEqual({ lineId: 'c50-italian-game', exact: true });
    // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 is named (Classical Variation) by another line.
    expect(playTarget(treePosition(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3']))?.exact).toBe(true);
    expect(playTarget(treePosition([]))).toBeNull();
  });

  it('replays a tree path with labels, stopping at an illegal move', () => {
    const p = treePosition(['e2e4', 'c7c5', 'e1e3', 'g1f3']);
    expect(p.sans).toEqual(['e4', 'c5']);
    expect(p.labels).toEqual(['1. e4', '1... c5']);
    expect(p.uci).toEqual(['e2e4', 'c7c5']);
    expect(p.fens).toHaveLength(2);
    expect(p.fen).toBe(new Chess('rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2').fen());
  });
});

describe('home', () => {
  it('lists the starter openings easiest first, the recommended order within a level', () => {
    for (const side of ['w', 'b'] as const) {
      const order = { beginner: 0, intermediate: 1, advanced: 2 } as const;
      const levels = starterFamilies(side).map((f) => order[guideFor(f.name)!.level]);
      expect(levels).toEqual([...levels].sort((a, b) => a - b));
      expect(new Set(starterFamilies(side))).toEqual(new Set(beginnerFamilies(side)));
    }
    expect(starterFamilies('b')[0].name).not.toBe('Sicilian Defense');
    expect(starterFamilies('w')[0].name).toBe('Italian Game');
  });

  it('offers an opening’s page first when a search names it', () => {
    expect(familyHits(search('sicilian', 40)).map((f) => f.name)).toEqual(['Sicilian Defense']);
    expect(familyHits(search('london', 40)).map((f) => f.name)).toContain('London System');
    expect(familyHits(search('spanish', 40)).map((f) => f.name)).toEqual(['Ruy Lopez']);
    // Moves and codes name no opening by itself.
    expect(familyHits(search('1. e4 c5', 40))).toEqual([]);
    expect(familyHits(search('B90', 40))).toEqual([]);
  });
});

describe('wording', () => {
  it('writes move lists that never wrap inside a move', () => {
    expect(movesText(ITALIAN)).toBe(`1.${NB}e4 e5 2.${NB}Nf3 Nc6 3.${NB}Bc4`);
    expect(movesText(ITALIAN, 3)).toBe(`1.${NB}e4 e5 2.${NB}Nf3 …`);
    expect(movesText([])).toBe('');
    const najdorf = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'Bg5', 'e6', 'f4'];
    expect(movesSummary(najdorf, 12, 4)).toBe(`1.${NB}e4 c5 2.${NB}Nf3 d6 3.${NB}d4 cxd4 4.${NB}Nxd4 Nf6 … 5...${NB}a6 6.${NB}Bg5 e6 7.${NB}f4`);
    expect(movesSummary(ITALIAN)).toBe(movesText(ITALIAN));
  });

  it('says who plays an opening', () => {
    expect(sideSentence('w', ITALIAN)).toBe('An opening for White: you play it with the white pieces.');
    expect(sideSentence('b', ['e4', 'c5'])).toBe('An opening for Black: you choose it when White starts 1. e4.');
  });

  it('words how common a move is in theory, never as a share of games', () => {
    const word = (share: number, isMain = false, dubious = false) => commonWord({ share, isMain, dubious });
    expect(word(0.5, true)).toBe('Main line');
    expect(word(0.3)).toBe('Very common');
    expect(word(0.1)).toBe('Common');
    expect(word(0.03)).toBe('Less common');
    expect(word(0.001)).toBe('Rare');
    expect(word(0.4, false, true)).toBe('Known mistake');
  });

  it('puts engine scores in plain words', () => {
    expect(evalWords(null)).toBe('');
    expect(evalWords({ kind: 'cp', value: 20 })).toBe('About equal');
    expect(evalWords({ kind: 'cp', value: -60 })).toBe('Black is slightly better');
    expect(evalWords({ kind: 'cp', value: 180 })).toBe('White is better');
    expect(evalWords({ kind: 'cp', value: -900 })).toBe('Black is winning');
    expect(evalWords({ kind: 'mate', value: 3 })).toBe('White can force mate');
    expect(evalWords({ kind: 'mate', value: -2 })).toBe('Black can force mate');
  });

  it('keeps a one-line pitch and labels', () => {
    expect(firstSentence("After 1.e4 e5 2.Nf3 Nc6 3.Bc4, the bishop aims at f7, Black's weakest point. It is old.")).toBe(
      "After 1.e4 e5 2.Nf3 Nc6 3.Bc4, the bishop aims at f7, Black's weakest point.",
    );
    expect(difficultyLabel('beginner')).toBe('Beginner-friendly');
    expect(plyOfLabel('3. Bc4')).toBe(4);
    expect(plyOfLabel('3... Bc5')).toBe(5);
    expect(movesCount(5)).toBe('5 moves: 3 by White, 2 by Black');
    expect(movesCount(6)).toBe('6 moves: 3 by White, 3 by Black');
    expect(movesCount(1)).toBe('1 move, by White');
  });

  it('titles the pages', () => {
    expect(pageTitle({ kind: 'home' })).toBe('Openings');
    expect(pageTitle({ kind: 'families' })).toBe('All openings');
    expect(pageTitle({ kind: 'family', family: 'Ruy Lopez' })).toBe('Ruy Lopez');
    expect(pageTitle(linePage('b90-sicilian-defense-najdorf-variation'))).toBe('Najdorf Variation');
    expect(pageTitle(linePage('guide:Italian Game'))).toBe('Main line');
    expect(pageTitle({ kind: 'tree', path: [] })).toBe('Explore by moves');
    expect(pageTitle(drillPage('x', 'w'))).toBe('Drill');
  });
});

describe('drill feedback', () => {
  const line = { id: 'c50-italian-game', uci: ucisOf(ITALIAN), name: 'Italian Game' };

  it('says correct, another book move or wrong in plain words', () => {
    const s = createDrill(line, 'w');
    const correct = checkMove(s, 'e2e4');
    expect(drillFeedback(correct, ITALIAN)).toEqual({ kind: 'correct', text: 'Correct: 1. e4.', sans: ['e4'] });
    const s2 = playOpponent(correct.state);
    const alt = checkMove(s2, 'b1c3');
    expect(drillFeedback(alt, ITALIAN)).toEqual({
      kind: 'alternative',
      text: '2. Nc3 is also a book move, but this line continues with 2. Nf3. Play it to go on.',
    });
    const wrong = checkMove(s2, 'h2h4');
    expect(drillFeedback(wrong, ITALIAN)?.kind).toBe('wrong');
    expect(drillFeedback(wrong, ITALIAN)?.text).toMatch(/^2\. h4 is (not the move in this line|a known mistake here)\. Try again\.$/);
    expect(drillFeedback(checkMove(s2, 'e1e3'), ITALIAN)).toBeNull();
  });

  it('shows the player’s moves as found, missed, current or to do', () => {
    let s = createDrill(line, 'w');
    expect([0, 1, 2].map((i) => dotState(s, i))).toEqual(['current', 'todo', 'todo']);
    s = playOpponent(checkMove(s, 'e2e4').state);
    s = drillHint(s, 1).state;
    s = playOpponent(checkMove(s, 'g1f3').state);
    expect([0, 1, 2].map((i) => dotState(s, i))).toEqual(['found', 'missed', 'current']);
  });
});

describe('playing an opening', () => {
  const bots: BotPersona[] = [{ id: 'pip', name: 'Pip', elo: 100, emoji: 'x', color: '#000', tagline: '', greeting: '' }];

  it('starts from the current settings with the side and opponent picked', () => {
    const setup = { settings: { ...DEFAULT_SETTINGS, botId: 'pip', botElo: 100 }, rating: 1234, bots };
    expect(playSettings(setup, 'b', { selectedId: 'pip', customElo: 900, adaptive: false })).toMatchObject({
      playerColor: 'b',
      botId: 'pip',
      botElo: 100,
      adaptive: false,
    });
    expect(playSettings(setup, 'w', { selectedId: 'pip', customElo: 900, adaptive: true })).toMatchObject({
      playerColor: 'w',
      botId: 'custom',
      botElo: 1250,
      adaptive: true,
    });
    expect(playSettings(setup, 'w', { selectedId: 'custom', customElo: 1512, adaptive: false })).toMatchObject({ botId: 'custom', botElo: 1500 });
  });
});

describe('the evaluation bar', () => {
  it('reads an analysis result from White’s side', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const r = { fen, depth: 12, bestMove: 'c7c5', done: true, lines: [{ multipv: 1, depth: 12, score: { kind: 'cp' as const, value: -30 }, pv: ['c7c5'] }] };
    const v = evalFromResult(r);
    expect(v?.label).toBe('+0.3');
    expect(v?.scoreWhite).toEqual({ kind: 'cp', value: 30 });
    expect(v?.whiteWinProb).toBeGreaterThan(0.5);
    expect(evalFromResult({ ...r, lines: [] })).toBeNull();
    const mated = evalFromResult({ fen, depth: 0, bestMove: null, done: true, lines: [], terminal: 'checkmate' });
    expect(mated?.label).toBe('1-0');
  });

  it('gives a verdict only for the very position, once the engine has finished it', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const other = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    const v = { whiteWinProb: 0.55, label: '+0.3', thinking: false, scoreWhite: { kind: 'cp' as const, value: 30 }, fen };
    expect(verdictFor(v, fen)).toEqual({ kind: 'cp', value: 30 });
    expect(verdictFor(v, fen.replace(' 0 1', ' 3 7'))).toEqual({ kind: 'cp', value: 30 }); // move counters aside
    expect(verdictFor(v, other)).toBeNull();
    expect(verdictFor({ ...v, thinking: true }, fen)).toBeNull();
  });
});
