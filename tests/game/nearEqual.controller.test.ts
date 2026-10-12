/**
 * Near-equal awareness in the app (analysis/nearEqual.ts): THE USER'S CASE played through the
 * controller with fixed engine lines (1.d4 d5 2.c4 Nf6 3.cxd5 Nxd5, where c6, c5 and g6 are within
 * 12 cp and Nxd5 28 cp behind the c6 line, 23 cp behind c6 scored the same way: the second
 * opinion): the coach's feedback, Show best (title, lines, arrows), the opponent's moves, Game
 * Review, the explorer, Retry (answer-free) and the Pro gating.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { fenKey } from '../../src/chess/utils';
import type { PvLine, Score } from '../../src/engine/types';
import { lockedTeaser } from '../../src/game/coach';
import { GameController, type BotLike } from '../../src/game/controller';
import { createEntitlements, type Entitlements } from '../../src/game/entitlements';
import { GAME_KEY, type SavedGame } from '../../src/game/persistence';
import { DEFAULT_SETTINGS, type GameSettings, type PromotionPiece } from '../../src/game/types';
import { MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet } from '../helpers/fakeEngine';
import { FakePurchases } from './fakePurchases';

const cp = (value: number): Score => ({ kind: 'cp', value });
const pv = (score: Score, moves: string): PvLine => ({ multipv: 1, depth: 14, score, pv: moves.split(' ') });
const fenOf = (sans: string) => {
  const c = new Chess();
  for (const s of sans.split(' ')) c.move(s);
  return c.fen();
};

/** 1.d4 d5 2.c4 Nf6 3.cxd5, Black to move (side-to-move scores: -57 is White better by 0.57). */
const USER = fenOf('d4 d5 c4 Nf6 cxd5');
const LINES: [string, PvLine[]][] = [
  [
    USER,
    [
      pv(cp(-57), 'c7c6 d5c6 b8c6 g1f3 e7e5 d4e5'),
      pv(cp(-67), 'c7c5 e2e4 f6e4 d4c5 d8a5 c1d2'),
      pv(cp(-69), 'g7g6 g1f3 f8g7 d1a4 c7c6 d5c6'),
    ],
  ],
  // After 3...Nxd5 the coach's search gives White +0.85.
  [fenOf('d4 d5 c4 Nf6 cxd5 Nxd5'), [pv(cp(85), 'e2e4 d5f6 b1c3 e7e5')]],
  // The second opinion: after 3...c6, searched the same way, White +0.62.
  [fenOf('d4 d5 c4 Nf6 cxd5 c6'), [pv(cp(62), 'd5c6 b8c6 g1f3 e7e5')]],
  // After 3...e5?, White +3.00: a mistake.
  [fenOf('d4 d5 c4 Nf6 cxd5 e5'), [pv(cp(300), 'd4e5 f6d5 e2e4 d5b4')]],
];

const controllers: GameController[] = [];
let lastEngines: ReturnType<typeof fakeEngineSet> | null = null;
const ents: Entitlements[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  for (const e of ents.splice(0)) e.dispose();
});

async function setup(o: { bot: BotLike; entitlements?: Entitlements; lines?: [string, PvLine[]][]; storage?: MemoryStorage }) {
  const engines = fakeEngineSet();
  lastEngines = engines;
  for (const [fen, lines] of [...LINES, ...(o.lines ?? [])]) engines.analysis.fixed.set(fenKey(fen), lines);
  let n = 0;
  const controller = new GameController({
    createEngines: async () => engines.set,
    onlineEvents: null,
    storage: o.storage ?? new MemoryStorage(),
    sound: new RecordingSound(),
    thinkDelay: false,
    createId: () => `game-${++n}`,
    rng: () => 0.3,
    createBot: () => o.bot,
    ...(o.entitlements ? { entitlements: o.entitlements } : {}),
  });
  controllers.push(controller);
  await controller.boot();
  return { controller, store: controller.store };
}

const settings = (over: Partial<GameSettings> = {}): GameSettings => ({
  ...DEFAULT_SETTINGS,
  playerColor: 'b',
  botId: 'pip',
  botElo: 100,
  ...over,
});

const move = (c: GameController, uci: string) =>
  c.playerMove(uci.slice(0, 2), uci.slice(2, 4), uci[4] as PromotionPiece | undefined);

/** You play Black: 1.d4 d5 2.c4 Nf6 3.cxd5 and then `last`. */
async function userGame(
  last: string,
  o: { entitlements?: Entitlements; over?: Partial<GameSettings>; lines?: [string, PvLine[]][]; storage?: MemoryStorage } = {},
) {
  const bot = new ScriptedBot(['d2d4', 'c2c4', 'c4d5', 'e2e4']);
  const t = await setup({ bot, entitlements: o.entitlements, lines: o.lines, storage: o.storage });
  t.controller.newGame(settings(o.over));
  await t.controller.idle();
  for (const uci of ['d7d5', 'g8f6', last]) {
    expect(move(t.controller, uci), uci).toBe(true);
    await t.controller.idle();
  }
  return t;
}

const FINE = 'Your Nxd5 was fine: c6, c5 and g6 were only slightly better.';

describe('THE USER’S CASE: 3...Nxd5 is about as good as c6, c5 and g6', () => {
  it('the feedback says Nxd5 was fine, not "Best was c6." (after a second opinion on c6)', async () => {
    const { store } = await userGame('f6d5');
    const ply = store.plies.value[5];
    expect(ply.san).toBe('Nxd5');
    expect(ply.classification).toMatchObject({ cls: 'good', nearBest: true, bestMoveSan: 'c6' });
    expect(ply.classification!.equalBest!.map((m) => m.san)).toEqual(['c6', 'c5', 'g6']);
    const coach = store.coach.value;
    expect(coach.title).toBe('3… Nxd5 is good');
    expect(coach.lines).toContain(FINE);
    for (const line of coach.lines) expect(line).not.toMatch(/Best was|was better|more accurate/);
    expect(coach.actions.map((a) => a.id)).toContain('showBest');
    // Nxd5 is 28 cp behind the c6 line: the coach searched the position after c6 too (like the
    // one after Nxd5), and compared the two.
    const searched = lastEngines!.analysis.searches.map((x) => fenKey(x.fen));
    expect(searched).toContain(fenKey(fenOf('d4 d5 c4 Nf6 cxd5 c6')));
  });

  it('Show best: "Top choices" with their evaluations, yours, the best move’s explanation and line', async () => {
    const { controller, store } = await userGame('f6d5');
    controller.runAction('showBest');
    const coach = store.coach.value;
    expect(coach.title).toBe('Top choices');
    expect(coach.cls).toBe('best');
    // The eval bar's convention (White's point of view): White is better after each of them.
    expect(coach.lines.slice(0, 2)).toEqual(['c6 +0.6 · c5 +0.7 · g6 +0.7', 'Your Nxd5: +0.9, close behind.']);
    expect(coach.lines[2]).toBe('c6 holds the position.');
    // Several moves were about as good: the variation is the engine's line, not "the best line".
    expect(coach.lines.at(-1)).toMatch(/^Engine line: 3\.\.\. c6 4\. dxc6 Nxc6/);
    // The list ranks the moves: the explanation does not ("about as good", "more precise than").
    for (const line of coach.lines) expect(line).not.toMatch(/about as good|more precise|only move|Anything else/);
    for (const line of coach.lines) expect(line).not.toMatch(/Best was|You played/);
    // Arrows: your move, the best one, and the moves about as good as it.
    expect(store.board.value.arrows).toEqual([
      { from: 'f6', to: 'd5', brush: 'played' },
      { from: 'c7', to: 'c6', brush: 'best' },
      { from: 'c7', to: 'c5', brush: 'alt' },
      { from: 'g7', to: 'g6', brush: 'alt' },
    ]);
  });

  it('after a restart: Show best shows the saved top choices at once, then the best move’s explanation', async () => {
    const storage = new MemoryStorage();
    const first = await userGame('f6d5', { storage });
    first.controller.dispose();
    const second = await setup({ bot: new ScriptedBot(), storage });
    const ply = second.store.plies.value[5];
    expect(ply.classification).toMatchObject({ nearBest: true });
    expect(ply.classification!.equalBest).toHaveLength(3);
    second.controller.runAction('showBest');
    const pending = second.store.coach.value;
    expect(pending).toMatchObject({ title: 'Top choices', busy: true });
    expect(pending.lines.slice(0, 2)).toEqual(['c6 +0.6 · c5 +0.7 · g6 +0.7', 'Your Nxd5: +0.9, close behind.']);
    expect(pending.lines.at(-1)).toMatch(/^Engine line: 3\.\.\. c6 4\. dxc6/);
    for (const line of pending.lines) expect(line).not.toMatch(/was fine|Best was|Best line/);
    await second.controller.idle();
    const filled = second.store.coach.value;
    expect(filled.busy).toBe(false);
    expect(filled.lines.slice(0, 3)).toEqual(['c6 +0.6 · c5 +0.7 · g6 +0.7', 'Your Nxd5: +0.9, close behind.', 'c6 holds the position.']);
  });

  it('a save from before near-equal awareness: the coach words the move as it did', async () => {
    const storage = new MemoryStorage();
    const first = await userGame('f6d5', { storage });
    first.controller.dispose();
    const raw = JSON.parse(storage.getItem(GAME_KEY)!) as SavedGame;
    const a = raw.annotations[5];
    delete a.classification!.equalBest;
    delete a.classification!.nearBest;
    a.explanation = { headline: 'Nxd5 wins back a pawn.', details: ['c6 was slightly more accurate.'] };
    storage.setItem(GAME_KEY, JSON.stringify(raw));
    const second = await setup({ bot: new ScriptedBot(), storage });
    second.controller.runAction('showBest');
    expect(second.store.coach.value.title).toBe('Best was c6');
    await second.controller.idle();
    expect(second.store.coach.value.title).toBe('Best was c6');
    expect(second.store.coach.value.lines).toContain('You played Nxd5. Nxd5 wins back a pawn.');
    expect(second.store.board.value.arrows?.map((x) => x.brush)).toEqual(['played', 'best']);
  });

  it('the opponent’s move: the same words, "Pip’s Nxd5" in Show best', async () => {
    const bot = new ScriptedBot(['d7d5', 'g8f6', 'f6d5']);
    const { controller, store } = await setup({ bot });
    controller.newGame(settings({ playerColor: 'w', rateOpponent: true }));
    for (const uci of ['d2d4', 'c2c4', 'c4d5']) {
      expect(move(controller, uci)).toBe(true);
      await controller.idle();
    }
    await controller.idle();
    const theirs = store.plies.value[5];
    expect(theirs.san).toBe('Nxd5');
    expect(theirs.classification).toMatchObject({ nearBest: true });
    controller.selectCoachFeedback('opponent');
    const coach = store.coach.value;
    expect(coach.title).toBe('Pip’s 3… Nxd5 is good');
    // In the third person.
    expect(coach.lines).toContain('Nxd5 was fine: c6, c5 and g6 were only slightly better.');
    controller.runAction('showBest');
    expect(store.coach.value.title).toBe('Top choices');
    expect(store.coach.value.lines.slice(0, 2)).toEqual(['c6 +0.6 · c5 +0.7 · g6 +0.7', 'Pip’s Nxd5: +0.9, close behind.']);
  });

  it('Game Review: the same feedback, and Show best the same way', async () => {
    const { controller, store } = await userGame('f6d5');
    controller.resign();
    await controller.startReview();
    controller.goTo(6);
    const coach = store.coach.value;
    expect(coach.title).toBe('3… Nxd5 is good');
    expect(coach.lines.filter((l) => l === FINE)).toHaveLength(1);
    for (const line of coach.lines) expect(line).not.toMatch(/Best was/);
    // The review's arrows are not a correction either: the engine's near-equal choices, as in Show best.
    expect(store.board.value.arrows).toEqual([
      { from: 'c7', to: 'c6', brush: 'best' },
      { from: 'c7', to: 'c5', brush: 'alt' },
      { from: 'g7', to: 'g6', brush: 'alt' },
    ]);
    controller.runAction('showBest');
    expect(store.coach.value.title).toBe('Top choices');
  });

  it('Game Review: an Excellent move the engine listed is "one of the engine’s top choices"', async () => {
    // Bf5 (not a book move here) as the engine's second line.
    const lines: [string, PvLine[]][] = [
      [
        USER,
        [
          pv(cp(-57), 'c7c6 d5c6 b8c6 g1f3 e7e5 d4e5'),
          pv(cp(-67), 'c8f5 b1c3 b8d7 e2e4 f5g6 f2f3'),
          pv(cp(-69), 'g7g6 g1f3 f8g7 d1a4 c7c6 d5c6'),
        ],
      ],
    ];
    const { controller, store } = await userGame('c8f5', { lines });
    const ply = store.plies.value[5];
    expect(ply.classification).toMatchObject({ cls: 'excellent', nearBest: true });
    // Live: an Excellent move gets no word about the best move (as before).
    for (const line of store.coach.value.lines) expect(line).not.toMatch(/\bc6\b/);
    controller.resign();
    await controller.startReview();
    controller.goTo(6);
    // The review used to add "Best was c6." here.
    expect(store.coach.value.lines).toContain('Bf5 is one of the engine’s top choices, with c6 and g6.');
    for (const line of store.coach.value.lines) expect(line).not.toMatch(/Best was/);
    controller.runAction('showBest');
    expect(store.coach.value.title).toBe('Top choices');
    expect(store.coach.value.lines.slice(0, 2)).toEqual(['c6 +0.6 · Bf5 +0.7 · g6 +0.7', 'Your Bf5 is one of them.']);
    // Bf5 is the played move's arrow, not an alternative's.
    expect(store.board.value.arrows).toEqual([
      { from: 'c8', to: 'f5', brush: 'played' },
      { from: 'c7', to: 'c6', brush: 'best' },
      { from: 'g7', to: 'g6', brush: 'alt' },
    ]);
  });

  it('the explorer’s rating (engine on) records the same data', async () => {
    const bot = new ScriptedBot(['d2d4', 'c2c4', 'c4d5']);
    const { controller, store } = await setup({ bot });
    controller.newGame(settings({ rateOpponent: true })); // unrated: the explorer's engine switches on at once
    await controller.idle();
    for (const uci of ['d7d5', 'g8f6']) {
      expect(move(controller, uci)).toBe(true);
      await controller.idle();
    }
    controller.requestExplore();
    expect(store.explorer.value).not.toBeNull();
    if (!store.explorerEngine.value) controller.runExplorerAction('engine');
    if (store.sheet.value === 'assist') controller.confirmAssist();
    expect(store.explorerEngine.value).toBe(true);
    expect(controller.explorerMove('f6', 'd5')).toBe(true);
    await controller.idle();
    const rating = store.explorer.value!.moves[0].rating!;
    expect(rating.classification).toMatchObject({ cls: 'good', nearBest: true });
    expect(rating.classification.equalBest!.map((m) => m.san)).toEqual(['c6', 'c5', 'g6']);
    expect([rating.explanation.headline, ...rating.explanation.details]).toContain(FINE);
    expect(store.explorerPanel.value!.verdict).toBe('Good');
  });
});

describe('a move clearly worse than the best', () => {
  it('names the moves about as good as the best, but never while Retry is offered', async () => {
    const { controller, store } = await userGame('e7e5', { over: { rateOpponent: true } });
    const ply = store.plies.value[5];
    expect(ply.classification).toMatchObject({ cls: 'mistake', nearBest: false });
    expect(ply.explanation!.details).toContain('Best was c6 (c5 and g6 were about as good).');
    // A Mistake needs no second opinion: the position after c6 was not searched.
    expect(lastEngines!.analysis.searches.map((x) => fenKey(x.fen))).not.toContain(fenKey(fenOf('d4 d5 c4 Nf6 cxd5 c6')));
    // Retry is on offer: no c6, c5 or g6 anywhere in the text.
    const coach = store.coach.value;
    expect(coach.actions.map((a) => a.id)).toContain('retry');
    for (const line of coach.lines) expect(line).not.toMatch(/\b(c6|c5|g6)\b/);
    // Show best names them: the title the best move, then the others.
    controller.runAction('showBest');
    const shown = store.coach.value;
    expect(shown.title).toBe('Best was c6');
    // The best move's explanation names them ("c5 and g6 are about as good."), else a line of its own.
    expect(shown.lines.some((l) => /\bc5\b.*\bg6\b.* about as good\.$/.test(l))).toBe(true);
    expect(shown.lines.some((l) => l.startsWith('You played e5.'))).toBe(true);
    expect(store.board.value.arrows?.map((a) => a.brush)).toEqual(['played', 'best', 'alt', 'alt']);
    // After the Retry the "Try again" prompt gives nothing away either.
    controller.runAction('backToGame');
    controller.runAction('retry');
    await controller.idle();
    expect(store.coach.value.title).toBe('Try again');
    for (const line of store.coach.value.lines) expect(line).not.toMatch(/\b(c6|c5|g6)\b/);
  });
});

describe('the second opinion and the edges of "about as good"', () => {
  const BF5 = fenOf('d4 d5 c4 Nf6 cxd5 Bf5');
  const NXD5 = fenOf('d4 d5 c4 Nf6 cxd5 Nxd5');

  it('THE USER’S CASE in the real-engine runs that were still corrected: 31 and 33 cp behind the Bf5 line', async () => {
    for (const [top, played, own] of [
      [-62, 93, 80],
      [-56, 89, 72],
    ]) {
      const lines: [string, PvLine[]][] = [
        [
          USER,
          [
            pv(cp(top), 'c8f5 b1c3 c7c6 d5c6'),
            pv(cp(top - 1), 'c7c6 d5c6 b8c6 g1f3'),
            pv(cp(top - 2), 'c7c5 e2e4 f6e4 d4c5'),
          ],
        ],
        [NXD5, [pv(cp(played), 'e2e4 d5f6 b1c3 e7e5')]],
        // Bf5 scored like Nxd5: 13 and 17 cp ahead of it.
        [BF5, [pv(cp(own), 'b1c3 c7c6 d5c6 b8c6')]],
      ];
      const { controller, store } = await userGame('f6d5', { lines });
      expect(store.plies.value[5].classification).toMatchObject({ cls: 'good', nearBest: true });
      const coach = store.coach.value;
      expect(coach.lines).toContain('Your Nxd5 was fine: Bf5, c6 and c5 were only slightly better.');
      for (const line of coach.lines) expect(line).not.toMatch(/Best was|was better|more accurate/);
      controller.runAction('showBest');
      expect(store.coach.value.title).toBe('Top choices');
      for (const line of store.coach.value.lines) expect(line).not.toMatch(/Best was|Best line|was better|more accurate/);
      controller.dispose();
    }
  });

  it('Show best when the lines call the best move the only good one: no "only move" next to "close behind"', async () => {
    const lines: [string, PvLine[]][] = [
      [USER, [pv(cp(-50), 'c7c6 d5c6 b8c6 g1f3'), pv(cp(-170), 'e7e6 d5e6 c8e6 g1f3'), pv(cp(-190), 'b8d7 e2e4 f6e4 d1a4')]],
      [NXD5, [pv(cp(75), 'e2e4 d5f6 b1c3 e7e5')]],
    ];
    const { controller, store } = await userGame('f6d5', { lines });
    expect(store.plies.value[5].classification).toMatchObject({ nearBest: true });
    controller.runAction('showBest');
    const shown = store.coach.value;
    expect(shown.title).toBe('Top choice');
    expect(shown.lines.slice(0, 2)).toEqual(['c6 +0.5', 'Your Nxd5: +0.8, close behind.']);
    for (const line of shown.lines) expect(line).not.toMatch(/only (good )?move|Anything else|more precise|about as good/);
  });

  it('a move its own search scores above the best line: "at least as good", no note on the best move and no arrow in review', async () => {
    const lines: [string, PvLine[]][] = [[NXD5, [pv(cp(40), 'e2e4 d5f6 b1c3 e7e5')]]];
    const { controller, store } = await userGame('f6d5', { lines });
    expect(store.plies.value[5].classification).toMatchObject({ cls: 'excellent', nearBest: true, aboveBest: true });
    controller.runAction('showBest');
    expect(store.coach.value.lines.slice(0, 2)).toEqual(['c6 +0.6 · c5 +0.7 · g6 +0.7', 'Your Nxd5: +0.4, at least as good.']);
    controller.runAction('backToGame');
    controller.resign();
    await controller.startReview();
    controller.goTo(6);
    for (const line of store.coach.value.lines) expect(line).not.toMatch(/\bc6\b|was fine|Best was/);
    expect(store.board.value.arrows).toEqual([]);
  });

  it('a Good move that was not about as good: "Slightly better: c6", and after a restart the moves about as good once', async () => {
    // c6 -30 and c5 -35 about as good; Bf5 -70 (40 cp behind c6, 35 behind c5; c6 scored like it: -30).
    const lines: [string, PvLine[]][] = [
      [USER, [pv(cp(-30), 'c7c6 d5c6 b8c6 g1f3'), pv(cp(-35), 'c7c5 e2e4 f6e4 d4c5'), pv(cp(-90), 'g7g6 g1f3 f8g7 d1a4')]],
      [BF5, [pv(cp(70), 'b1c3 c7c6 d5c6 b8c6')]],
      [fenOf('d4 d5 c4 Nf6 cxd5 c6'), [pv(cp(30), 'd5c6 b8c6 g1f3 e7e5')]],
    ];
    const storage = new MemoryStorage();
    const first = await userGame('c8f5', { lines, storage });
    const ply = first.store.plies.value[5];
    expect(ply.classification).toMatchObject({ cls: 'good', nearBest: false });
    expect(ply.classification!.equalBest!.map((m) => m.san)).toEqual(['c6', 'c5']);
    first.controller.runAction('showBest');
    expect(first.store.coach.value.title).toBe('Slightly better: c6');
    first.controller.dispose();
    const second = await setup({ bot: new ScriptedBot(), storage, lines });
    second.controller.runAction('showBest');
    const pending = second.store.coach.value;
    expect(pending).toMatchObject({ title: 'Slightly better: c6', busy: true });
    // The saved note on c6 is not repeated, and c5 is named once, after what was played.
    expect(pending.lines.filter((l) => /\bc5\b/.test(l))).toEqual(['c5 was about as good.']);
    expect(pending.lines.findIndex((l) => l.startsWith('You played Bf5.'))).toBeLessThan(pending.lines.indexOf('c5 was about as good.'));
    for (const line of pending.lines) expect(line).not.toMatch(/^c6 was (better|slightly more accurate)/);
    await second.controller.idle();
    const filled = second.store.coach.value;
    expect(filled.busy).toBe(false);
    expect(filled.lines.filter((l) => /about as good/.test(l))).toEqual(['c5 was about as good.']);
  });
});

describe('Pro locked', () => {
  async function locked() {
    const purchases = new FakePurchases();
    const storage = new MemoryStorage();
    const entitlements = createEntitlements({ enabled: true, purchases, storage });
    ents.push(entitlements);
    purchases.unlocked.resolve(false);
    purchases.product.resolve({ id: 'pro', title: 'Pro', description: '', displayPrice: '$9.99' });
    return entitlements;
  }

  it('the free coach row names no move, Show best opens the paywall and draws nothing', async () => {
    const entitlements = await locked();
    const { controller, store } = await userGame('f6d5', { entitlements });
    const ply = store.plies.value[5];
    expect(ply.classification).toMatchObject({ nearBest: true });
    const coach = store.coach.value;
    expect(coach.title).toBe('3… Nxd5 is good');
    expect(coach.lines).toEqual([lockedTeaser(ply)]);
    for (const line of coach.lines) expect(line).not.toMatch(/\b(c6|c5|g6)\b|engine/);
    expect(coach.actions.find((a) => a.id === 'showBest')).toMatchObject({ locked: true });
    controller.runAction('showBest');
    expect(entitlements.paywall.value).toEqual({ open: true, feature: 'showBest' });
    expect(store.coach.value.title).not.toMatch(/top choice|Best was|Slightly better/i);
    expect(store.board.value.arrows).toEqual([]);
  });
});
