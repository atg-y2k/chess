/**
 * The explorer in the controller and the store: entering and leaving never changes the game nor
 * its rating, the engine off during a game (nothing asked of the engine, nothing shown) and its
 * switch (the rated-game question and the assisted mark, per-game memory), Pro gating, "Play"
 * committing the first move, the bot moving in the game meanwhile, the engine's reply, and the
 * ratings of explored moves (with the fake engine, and a scripted UCI engine for the searches).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/analysis/classify', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/analysis/classify')>();
  return { ...mod, classifyMove: vi.fn(mod.classifyMove) };
});
vi.mock('../../src/analysis/explain', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/analysis/explain')>();
  return { ...mod, explainMove: vi.fn(mod.explainMove) };
});

import { Chess } from 'chess.js';
import { classifyMove } from '../../src/analysis/classify';
import { explainMove } from '../../src/analysis/explain';
import { START_FEN, fenKey } from '../../src/chess/utils';
import { ANNOTATE_DEPTH, GameController, type BotLike } from '../../src/game/controller';
import { PRO_CACHE_KEY, createEntitlements, type Entitlements } from '../../src/game/entitlements';
import { explorerFen } from '../../src/game/explorer';
import { GAME_KEY, loadGame, saveGame, type SavedGame } from '../../src/game/persistence';
import { EXPLORER_ENGINE_OFF, EXPLORER_ENGINE_OFF_TIP } from '../../src/game/store';
import { DEFAULT_SETTINGS, type GameSettings, type PromotionPiece } from '../../src/game/types';
import { assistPrompt } from '../../src/ui/ConfirmSheet';
import { StockfishEngine } from '../../src/engine/StockfishEngine';
import { FakeEngine, MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet, scoreMoves } from '../helpers/fakeEngine';
import { ScriptedUciTransport } from '../helpers/uciTransport';
import { FakePurchases } from './fakePurchases';

const controllers: GameController[] = [];
const ents: Entitlements[] = [];

interface SetupOptions {
  bot?: BotLike;
  storage?: MemoryStorage;
  entitlements?: Entitlements;
}

async function setup(o: SetupOptions = {}) {
  const storage = o.storage ?? new MemoryStorage();
  const engines = fakeEngineSet();
  const sound = new RecordingSound();
  let n = 0;
  const controller = new GameController({
    createEngines: async () => engines.set,
    onlineEvents: null,
    storage,
    sound,
    thinkDelay: false,
    createId: () => `game-${++n}`,
    rng: () => 0.3,
    ...(o.bot ? { createBot: () => o.bot! } : {}),
    ...(o.entitlements ? { entitlements: o.entitlements } : {}),
  });
  controllers.push(controller);
  await controller.boot();
  return { controller, store: controller.store, storage, engines, sound };
}

const settings = (over: Partial<GameSettings> = {}): GameSettings => ({
  ...DEFAULT_SETTINGS,
  playerColor: 'w',
  botId: 'pip',
  botElo: 100,
  ...over,
});

const uciArgs = (uci: string): [string, string, PromotionPiece | undefined] => [
  uci.slice(0, 2),
  uci.slice(2, 4),
  uci[4] as PromotionPiece | undefined,
];

async function playAll(c: GameController, ucis: string[]): Promise<void> {
  for (const uci of ucis) {
    expect(c.playerMove(...uciArgs(uci)), `move ${uci}`).toBe(true);
    await c.idle();
  }
}

function explore(c: GameController, ucis: string[]): void {
  for (const uci of ucis) expect(c.explorerMove(...uciArgs(uci)), `explored ${uci}`).toBe(true);
}

/** Opens the explorer (it never asks). */
function enter(c: GameController): void {
  c.requestExplore();
  expect(c.store.sheet.value).toBeNull();
  expect(c.store.explorer.value).not.toBeNull();
}

/** Switches the explorer's engine on, unless it is (answering the question in a rated game). */
function engineOn(c: GameController): void {
  if (!c.store.explorerEngine.value) c.runExplorerAction('engine');
  if (c.store.sheet.value === 'assist') c.confirmAssist();
  expect(c.store.explorerEngine.value).toBe(true);
}

/** A controller whose analysis engine is a real StockfishEngine on a scripted UCI transport. */
async function setupUci(bot: BotLike) {
  const transport = new ScriptedUciTransport();
  const analysis = new StockfishEngine(() => transport, { name: 'analysis' });
  const botEngine = new FakeEngine('bot');
  let n = 0;
  const controller = new GameController({
    createEngines: async () => {
      await analysis.init();
      return {
        analysis,
        bot: botEngine,
        mode: 'dual',
        terminate() {
          analysis.terminate();
          botEngine.terminate();
        },
      };
    },
    onlineEvents: null,
    storage: new MemoryStorage(),
    sound: new RecordingSound(),
    thinkDelay: false,
    createId: () => `game-${++n}`,
    rng: () => 0.3,
    createBot: () => bot,
  });
  controllers.push(controller);
  await controller.boot();
  return { controller, store: controller.store, transport };
}

/** Nothing of the engine's shows in the explorer: eval, arrows, Best here, ratings, Reply. */
function expectNoEngine(store: GameController['store']): void {
  expect(store.explorerEngine.value).toBe(false);
  expect(store.evalBar.value).toMatchObject({ off: true, label: '', whiteWinProb: 0.5 });
  expect(store.board.value.arrows).toEqual([]);
  expect(store.board.value.badge).toBeUndefined();
  expect(store.moveList.value.showClassIcons).toBe(false);
  expect(store.moveList.value.plies.every((p) => !p.classification)).toBe(true);
  const panel = store.explorerPanel.value!;
  expect(panel).toMatchObject({ verdict: null, evalLabel: null, busy: false, engine: { on: false } });
  expect(panel.cls).toBeUndefined();
  expect(panel.best ?? '').not.toMatch(/^Best here/);
  expect(panel.actions.map((a) => a.id)).not.toContain('arrows');
  expect(panel.actions.map((a) => a.id)).not.toContain('retryRating');
  expect(store.toolbar.value.explorerReply).toEqual({ disabled: true }); // in its place, off
}

beforeEach(() => {
  vi.mocked(classifyMove).mockClear();
  vi.mocked(explainMove).mockClear();
});

afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  for (const e of ents.splice(0)) e.dispose();
  vi.restoreAllMocks();
});

describe('explorer: entering and leaving', () => {
  it('never changes the game, and Exit brings back the view it left (viewed move, flip, no sheet)', async () => {
    const { controller, store, storage } = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6', 'g8f6']) });
    controller.newGame(settings({ showBestMoves: true })); // unrated from the start: no question
    await playAll(controller, ['e2e4', 'g1f3', 'f1c4']);
    const plies = store.plies.value;
    const saved = storage.getItem(GAME_KEY);
    controller.goTo(2);
    controller.flip();
    const shown = store.displayedFen.value;

    controller.requestExplore();
    expect(store.sheet.value).toBeNull();
    const x = store.explorer.value!;
    expect(x).toMatchObject({ baseFen: shown, baseIndex: 2, fromLive: false, gamePlies: 6, cursor: 0 });
    expect(store.board.value.fen).toBe(shown);
    expect(store.toolbar.value.explore.active).toBe(true);
    expect(store.moveList.value).toMatchObject({ plies: [], current: 0, lead: 'From 1… e5' });

    // Both sides move on the explorer's board.
    explore(controller, ['b1c3', 'g8f6', 'd2d4']);
    expect(store.board.value.movableColor).toBe('black');
    expect(store.board.value.lastMove).toEqual(['d2', 'd4']);
    expect(store.moveList.value.plies.map((p) => p.san)).toEqual(['Nc3', 'Nf6', 'd4']);
    controller.stepBack(); // the toolbar's ‹ (and the ← key) step through the explored line
    expect(store.explorer.value!.cursor).toBe(2);
    controller.explorerGoTo(0);
    expect(store.board.value.fen).toBe(shown);
    controller.stepForward();
    expect(store.explorer.value!.cursor).toBe(1);
    controller.explorerReset();
    expect(store.explorer.value!.moves).toEqual([]);
    explore(controller, ['d2d4']);
    await controller.idle();

    // The game is untouched: plies, view, saved game; and the board's game moves are refused.
    expect(store.plies.value).toBe(plies);
    expect(storage.getItem(GAME_KEY)).toBe(saved);
    expect(controller.playerMove('d2', 'd3')).toBe(false);
    controller.goTo(null); // the game's history is not browsed while exploring
    expect(store.viewIndex.value).toBe(2);

    controller.flip(); // flipping inside the explorer…
    controller.exitExplorer();
    expect(store.explorer.value).toBeNull();
    expect(store.viewIndex.value).toBe(2);
    expect(store.flipped.value).toBe(true); // …is undone on exit
    expect(store.sheet.value).toBeNull();
    expect(store.board.value.fen).toBe(shown);
    expect(store.plies.value).toBe(plies);
  });

  it('a rated game: Explore opens at once and keeps it rated; the Engine switch asks, Keep off changes nothing, Turn on makes it unrated', async () => {
    const { controller, store, storage } = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    controller.requestExplore();
    expect(store.sheet.value).toBeNull(); // no question
    expect(store.explorer.value?.fromLive).toBe(true);
    expect(store.explorerEngine.value).toBe(false);
    expect(store.game.value?.assisted).toBe(false);
    expect(store.bottomPlayer.value.unrated).toBeUndefined();
    expect(store.explorerPanel.value).toMatchObject({
      title: 'White to move',
      engine: { on: false, locked: false },
      lines: [`${EXPLORER_ENGINE_OFF} Your game stays rated.`, EXPLORER_ENGINE_OFF_TIP],
      best: null,
      actions: [],
    });
    explore(controller, ['g1f3', 'b8c6']);
    await controller.idle();
    expect(store.game.value?.assisted).toBe(false);
    expect(loadGame(storage)?.assisted).toBe(false);

    // The switch asks first.
    controller.runExplorerAction('engine');
    expect(store.sheet.value).toBe('assist');
    expect(store.sheets.value.assist).toEqual({ kind: 'exploreEngine' });
    expect(assistPrompt('exploreEngine')).toEqual({
      title: 'Turn on the engine?',
      message:
        'The engine’s evaluation, best moves and move ratings will show while you explore. Turning it on makes this game unrated: win or lose, your rating stays the same. Switching it off again won’t undo that.',
      confirmLabel: 'Turn on',
      cancelLabel: 'Keep off',
    });
    controller.closeSheet(); // Keep off
    expect(store.explorerEngine.value).toBe(false);
    expect(store.game.value?.assisted).toBe(false);
    expect(store.explorer.value?.moves).toHaveLength(2); // still exploring, line kept

    controller.runExplorerAction('engine');
    controller.confirmAssist(); // Turn on
    expect(store.sheet.value).toBeNull();
    expect(store.explorerEngine.value).toBe(true);
    expect(store.game.value?.assisted).toBe(true);
    expect(store.bottomPlayer.value.unrated).toBe(true);
    expect(loadGame(storage)?.assisted).toBe(true);
    expect(store.explorerPanel.value?.engine).toEqual({ on: true, locked: false });
    // Off again: the game stays unrated; on again, at once (no question now).
    controller.runExplorerAction('engine');
    expect(store.explorerEngine.value).toBe(false);
    expect(store.game.value?.assisted).toBe(true);
    expect(store.explorerPanel.value?.lines).toEqual([`${EXPLORER_ENGINE_OFF} This game is already unrated.`, EXPLORER_ENGINE_OFF_TIP]);
    controller.runExplorerAction('engine');
    expect(store.sheet.value).toBeNull();
    expect(store.explorerEngine.value).toBe(true);
    controller.requestExplore(); // pressed again: closes
    expect(store.explorer.value).toBeNull();
  });

  it('the engine question is dropped when the explorer closes, the game ends or a new game starts', async () => {
    const bot = new ScriptedBot(['d8h4']);
    const { controller, store } = await setup({ bot });
    controller.newGame(settings(), { startFen: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2' });
    await controller.idle();
    enter(controller);
    controller.runExplorerAction('engine');
    expect(store.sheet.value).toBe('assist');
    controller.exitExplorer();
    expect(store.sheet.value).toBeNull();
    expect(store.pendingAssist.value).toBeNull();
    controller.confirmAssist(); // a late tap does nothing
    expect(store.game.value?.assisted).toBe(false);

    // The game ends (the bot mates) while the question is open.
    bot.manual = true;
    expect(controller.playerMove('g2', 'g4')).toBe(true);
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    enter(controller);
    controller.runExplorerAction('engine');
    expect(store.sheet.value).toBe('assist');
    bot.release();
    await vi.waitFor(() => expect(store.phase.value).toBe('over'));
    expect(store.sheet.value).toBeNull();
    expect(store.pendingAssist.value).toBeNull();
    expect(store.ratingChange.value?.rated).toBe(true);
    expect(store.explorerEngine.value).toBe(false);
    controller.runExplorerAction('engine'); // the game is over: at once, no rating effect
    expect(store.sheet.value).toBeNull();
    expect(store.explorerEngine.value).toBe(true);
    controller.exitExplorer();
    expect(store.sheet.value).toBe('gameOver');

    // A new game started from the question's place.
    controller.newGame(settings());
    await controller.idle();
    enter(controller);
    controller.runExplorerAction('engine');
    expect(store.sheet.value).toBe('assist');
    controller.newGame(settings());
    expect(store.pendingAssist.value).toBeNull();
    expect(store.sheet.value).toBeNull();
    expect(store.explorer.value).toBeNull();
    expect(store.game.value?.assisted).toBe(false);
  });

  it('after the game and in the review: the engine is on, no question and no effect on the rating', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    controller.newGame(settings());
    await playAll(controller, ['e2e4', 'g1f3']);
    controller.resign();
    const rating = store.ratingChange.value;
    const profile = store.profile.value;
    expect(rating?.rated).toBe(true);
    controller.closeSheet();
    expect(store.toolbar.value.explore.disabled).toBe(false);
    controller.requestExplore();
    expect(store.sheet.value).toBeNull();
    expect(store.explorer.value).toMatchObject({ fromLive: true, baseIndex: 4 });
    expect(store.explorerEngine.value).toBe(true);
    expect(store.explorerPanel.value?.engine).toEqual({ on: true, locked: false });
    expect(controller.canReloadNow()).toBe(false); // the explorer is not saved
    explore(controller, ['f1c4', 'f8c5']);
    await controller.idle();
    expect(store.explorer.value!.moves.every((m) => m.rating)).toBe(true);
    // Off after the game: just the moves (and no word about the rating).
    controller.runExplorerAction('engine');
    expect(store.explorerPanel.value).toMatchObject({ lines: [EXPLORER_ENGINE_OFF, EXPLORER_ENGINE_OFF_TIP], verdict: null, evalLabel: null });
    controller.exitExplorer();
    expect(controller.canReloadNow()).toBe(true);
    expect(store.game.value?.assisted).toBe(false);
    expect(store.ratingChange.value).toEqual(rating);
    expect(store.profile.value).toBe(profile);

    await controller.startReview();
    controller.goTo(1);
    controller.requestExplore();
    expect(store.sheet.value).toBeNull();
    expect(store.explorer.value).toMatchObject({ baseIndex: 1, fromLive: false });
    expect(store.explorerEngine.value).toBe(true);
    expect(store.explorerPanel.value?.from).toBe('1. e4');
    expect(store.review.value).not.toBeNull(); // the review is still there underneath
    explore(controller, ['c7c5']);
    controller.exitExplorer();
    expect(store.phase.value).toBe('review');
    expect(store.viewIndex.value).toBe(1);
    expect(store.game.value?.assisted).toBe(false);
  });

  it('is not saved: a reload brings back the game without the explorer', async () => {
    const storage = new MemoryStorage();
    const first = await setup({ bot: new ScriptedBot(['e7e5']), storage });
    first.controller.newGame(settings({ showBestMoves: true }));
    await playAll(first.controller, ['e2e4']);
    first.controller.requestExplore();
    explore(first.controller, ['g1f3']);
    await first.controller.idle();
    first.controller.dispose();
    const second = await setup({ bot: new ScriptedBot(), storage });
    expect(second.store.phase.value).toBe('playing');
    expect(second.store.explorer.value).toBeNull();
    expect(second.store.plies.value.map((p) => p.san)).toEqual(['e4', 'e5']);
  });

  it('the board tells the game from each opening of the explorer (a started move never carries over)', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.newGame(settings({ showBestMoves: true }));
    await playAll(controller, ['e2e4']);
    expect(store.board.value.session).toBe('game');
    controller.requestExplore();
    const first = store.board.value.session;
    expect(first).toMatch(/^explorer:/);
    // Same position, same side to move: only the session differs.
    expect(store.board.value.fen).toBe(store.liveFen.value);
    expect(store.board.value.movableColor).toBe('white');
    controller.exitExplorer();
    expect(store.board.value.session).toBe('game');
    controller.requestExplore();
    expect(store.board.value.session).toMatch(/^explorer:/);
    expect(store.board.value.session).not.toBe(first);
  });

  it('on the bot’s turn: it opens at once there, and the engine question does not hold the bot', async () => {
    const bot = new ScriptedBot(['e7e5']);
    bot.manual = true;
    const { controller, store } = await setup({ bot });
    controller.newGame(settings());
    expect(controller.playerMove('e2', 'e4')).toBe(true);
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    const asked = store.displayedFen.value;
    enter(controller);
    expect(store.explorer.value).toMatchObject({ baseFen: asked, baseIndex: 1, fromLive: true, gamePlies: 1 });
    controller.runExplorerAction('engine');
    expect(store.sheet.value).toBe('assist');
    bot.release();
    await vi.waitFor(() => expect(store.plies.value).toHaveLength(2));
    expect(store.sheet.value).toBe('assist');
    controller.confirmAssist();
    expect(store.explorerEngine.value).toBe(true);
    expect(store.game.value?.assisted).toBe(true);
    expect(store.board.value.fen).toBe(asked);
    expect(store.explorerPanel.value?.notice).toBe('Pip played 1… e5 in your game.');
    explore(controller, ['c7c5']);
    expect(store.explorerPlayable.value).toBeNull();
    controller.exitExplorer();
    expect(store.board.value.fen).toBe(store.liveFen.value);
  });

  it('a new game closes the explorer', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.newGame(settings({ showBestMoves: true }));
    await playAll(controller, ['e2e4']);
    controller.requestExplore();
    explore(controller, ['g1f3']);
    controller.newGame(settings());
    expect(store.explorer.value).toBeNull();
    expect(store.board.value.fen).toBe(START_FEN);
  });
});

describe('explorer: Pro', () => {
  async function locked(cached = false) {
    const storage = new MemoryStorage();
    if (cached) storage.setItem(PRO_CACHE_KEY, '1');
    const purchases = new FakePurchases();
    const entitlements = createEntitlements({ enabled: true, purchases, storage });
    ents.push(entitlements);
    purchases.unlocked.resolve(cached);
    purchases.product.resolve({ id: 'pro', title: 'Pro', description: '', displayPrice: '$9.99' });
    const s = await setup({ bot: new ScriptedBot(['e7e5']), storage, entitlements });
    return { ...s, entitlements, purchases };
  }

  it('locked: the explorer is free (engine off); its Engine switch shows a lock and opens the paywall, with no question', async () => {
    const { controller, store, entitlements, purchases, engines } = await locked();
    controller.newGame(settings());
    expect(controller.playerMove('e2', 'e4')).toBe(true);
    await controller.idle();
    expect(store.toolbar.value.explore).toEqual({ disabled: false });
    controller.requestExplore();
    expect(entitlements.paywall.value.open).toBe(false);
    expect(store.explorer.value).not.toBeNull();
    expect(store.explorerPanel.value?.engine).toEqual({ on: false, locked: true });
    const from = engines.analysis.searches.length;
    explore(controller, ['g1f3', 'b8c6']);
    await controller.idle();
    expect(store.board.value.dests.size).toBeGreaterThan(0);

    controller.runExplorerAction('engine');
    expect(entitlements.paywall.value).toEqual({ open: true, feature: 'explorerEngine' });
    expect(store.sheet.value).toBeNull();
    expect(store.explorerEngine.value).toBe(false);
    expect(store.game.value?.assisted).toBe(false);
    await controller.idle();
    const explored = new Set(store.explorer.value!.moves.map((m) => fenKey(m.fenAfter)));
    expect(engines.analysis.searches.slice(from).filter((x) => explored.has(fenKey(x.fen)))).toEqual([]);
    expect(store.explorer.value!.moves.every((m) => !m.rating)).toBe(true);
    entitlements.closePaywall();

    // Bought: the switch asks about the rating like any help in a rated game.
    const bought = entitlements.buy();
    purchases.purchases[0].resolve('purchased');
    await bought;
    entitlements.closePaywall();
    expect(store.explorerPanel.value?.engine).toEqual({ on: false, locked: false });
    controller.runExplorerAction('engine');
    expect(store.sheet.value).toBe('assist');
    controller.confirmAssist();
    expect(store.explorerEngine.value).toBe(true);
    await controller.idle();
    expect(store.explorer.value!.moves.every((m) => m.rating)).toBe(true);
  });

  it('after the game with the engine locked: the explorer opens with it off', async () => {
    const { controller, store } = await locked();
    controller.newGame(settings());
    expect(controller.playerMove('e2', 'e4')).toBe(true);
    await controller.idle();
    controller.resign();
    controller.closeSheet();
    enter(controller);
    expect(store.explorerEngine.value).toBe(false);
    expect(store.explorerPanel.value?.engine).toEqual({ on: false, locked: true });
    expect(store.evalBar.value).toMatchObject({ visible: true, off: true, label: '' });
  });

  it('a refund while exploring switches the engine off (the explorer stays)', async () => {
    const { controller, store, purchases } = await locked(true);
    controller.newGame(settings({ showBestMoves: true }));
    enter(controller);
    engineOn(controller);
    explore(controller, ['e2e4']);
    purchases.emit(false);
    expect(store.explorer.value).not.toBeNull();
    expect(store.explorerEngine.value).toBe(false);
    expect(store.explorerPanel.value?.engine).toEqual({ on: false, locked: true });
    expect(store.board.value.arrows).toEqual([]);
    expect(store.board.value.fen).toBe(explorerFen(store.explorer.value!));
  });

  it('a refund while “Turn on the engine?” is open drops the question; a late Turn on opens the paywall', async () => {
    const { controller, store, entitlements, purchases } = await locked(true);
    controller.newGame(settings());
    enter(controller);
    controller.runExplorerAction('engine');
    expect(store.sheet.value).toBe('assist');
    expect(store.pendingAssist.value).toEqual({ kind: 'exploreEngine' });
    purchases.emit(false);
    expect(store.sheet.value).toBeNull();
    expect(store.pendingAssist.value).toBeNull();
    expect(store.explorer.value).not.toBeNull();
    expect(store.explorerPanel.value?.engine).toEqual({ on: false, locked: true });
    controller.confirmAssist(); // a late tap: nothing asked any more
    expect(store.game.value?.assisted).toBe(false);
    expect(store.explorerEngine.value).toBe(false);
    expect(entitlements.paywall.value.open).toBe(false);
    // Its switch now opens the paywall, with no question.
    controller.runExplorerAction('engine');
    expect(store.sheet.value).toBeNull();
    expect(entitlements.paywall.value).toMatchObject({ open: true, feature: 'explorerEngine' });
  });
});

describe('explorer: playing an explored move in the game', () => {
  it('"Play" commits exactly the first explored move through the normal move path, then the bot replies (the game stays rated)', async () => {
    const bot = new ScriptedBot(['e7e5', 'b8c6']);
    const { controller, store, sound } = await setup({ bot });
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    enter(controller);
    expect(store.explorerPlayable.value).toBeNull(); // nothing explored yet
    explore(controller, ['g1f3', 'b8c6', 'f1b5']);
    controller.explorerGoTo(1);
    expect(store.explorerPlayable.value?.san).toBe('Nf3');
    const play = store.explorerPanel.value!.actions.find((a) => a.id === 'play');
    expect(play).toEqual({ id: 'play', label: 'Play 2. Nf3', primary: true });
    const calls = bot.calls.length;
    sound.played.length = 0;

    controller.runExplorerAction('play');
    expect(store.explorer.value).toBeNull();
    expect(store.plies.value.map((p) => p.san)).toEqual(['e4', 'e5', 'Nf3']);
    expect(store.coachMode.value).toEqual({ kind: 'feedback', index: 2 });
    expect(sound.played).toContain('move');
    await controller.idle();
    expect(bot.calls.length).toBe(calls + 1);
    expect(store.plies.value.map((p) => p.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(store.game.value?.assisted).toBe(false);
  });

  it('not from an earlier position, nor on the bot’s turn', async () => {
    const bot = new ScriptedBot(['e7e5']);
    const { controller, store } = await setup({ bot });
    controller.newGame(settings({ showBestMoves: true }));
    await playAll(controller, ['e2e4']);
    controller.goTo(1);
    controller.requestExplore();
    explore(controller, ['e7e6']);
    expect(store.explorerPlayable.value).toBeNull();
    expect(controller.explorerPlay()).toBe(false);
    controller.exitExplorer();
    controller.goTo(null);
    bot.manual = true;
    expect(controller.playerMove('g1', 'f3')).toBe(true);
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    controller.requestExplore(); // on the bot's turn
    explore(controller, ['b8c6', 'f1b5']);
    expect(store.explorerPlayable.value).toBeNull();
    expect(store.explorerPanel.value!.actions.map((a) => a.id)).not.toContain('play');
    bot.release();
  });
});

describe('explorer: the game goes on meanwhile', () => {
  it('the bot’s move lands in the game, the explorer stays and says so, and "Play" is gone', async () => {
    const bot = new ScriptedBot(['e7e5', 'b8c6']);
    bot.manual = true;
    const { controller, store } = await setup({ bot });
    controller.newGame(settings());
    expect(controller.playerMove('e2', 'e4')).toBe(true);
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    enter(controller);
    expect(bot.heldCount).toBe(1); // the bot keeps thinking
    const x = store.explorer.value!;
    expect(x.fromLive).toBe(true);
    expect(store.explorerPanel.value?.notice).toBe('Pip is thinking about its move in your game…');
    // The collapsed panel's one line (short phones), with the pulsing dot while the bot thinks.
    expect(store.explorerPanel.value).toMatchObject({ noticeShort: 'Pip is thinking in your game…', noticeBusy: true });
    explore(controller, ['c7c5']);
    const board = store.board.value.fen;

    bot.release();
    await vi.waitFor(() => expect(store.plies.value).toHaveLength(2));
    expect(store.explorer.value?.moves.map((m) => m.san)).toEqual(['c5']);
    expect(store.board.value.fen).toBe(board);
    expect(store.explorerPanel.value?.notice).toBe('Pip played 1… e5 in your game.');
    expect(store.explorerPanel.value).toMatchObject({ noticeShort: 'Pip played 1… e5 in your game', noticeBusy: false });
    expect(store.explorerPanel.value?.actions.map((a) => a.id)).not.toContain('play');
    // It is the human's turn in the game now, but the explorer started before the bot's move.
    explore(controller, ['g1f3']);
    expect(store.explorerPlayable.value).toBeNull();
    controller.exitExplorer();
    expect(store.isLive.value).toBe(true);
    expect(store.board.value.fen).toBe(store.liveFen.value);
    expect(store.humanToMove.value).toBe(true);
  });

  it('a game that ends meanwhile: the explorer says so, and the game-over sheet waits for Exit', async () => {
    // After 1. f3 e5: White plays 2. g4??, and Black mates with Qh4#.
    const start = 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2';
    const bot = new ScriptedBot(['d8h4']);
    bot.manual = true;
    const { controller, store } = await setup({ bot });
    controller.newGame(settings({ showBestMoves: true }), { startFen: start });
    expect(controller.playerMove('g2', 'g4')).toBe(true);
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    controller.requestExplore();
    explore(controller, ['b8c6']);
    bot.release();
    await vi.waitFor(() => expect(store.phase.value).toBe('over'));
    expect(store.sheet.value).toBeNull();
    expect(store.explorer.value).not.toBeNull();
    expect(store.explorerPanel.value?.notice).toBe('Pip played 2… Qh4# in your game. The game is over.');
    expect(store.explorerPanel.value?.noticeShort).toBe('Pip played 2… Qh4#: game over');
    controller.exitExplorer();
    expect(store.sheet.value).toBe('gameOver');
    expect(store.outcome.value?.reason).toBe('Checkmate');
  });
});

describe('explorer: engine off (the default during a game)', () => {
  it('asks the engine nothing about the explored positions (no position/go for them) and shows nothing of it', async () => {
    const { controller, store, transport } = await setupUci(new ScriptedBot(['e7e5', 'b8c6']));
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    await controller.idle();
    const from = transport.sent.length;
    enter(controller);
    explore(controller, ['g1f3', 'b8c6', 'f1b5', 'a7a6']);
    const explored = new Set(store.explorer.value!.moves.map((m) => fenKey(m.fenAfter)));
    controller.stepBack();
    controller.explorerGoTo(1);
    controller.stepForward();
    controller.explorerReset();
    explore(controller, ['d2d4', 'd7d5', 'c2c4']);
    for (const m of store.explorer.value!.moves) explored.add(fenKey(m.fenAfter));
    await controller.explorerReply(); // no engine: plays nothing
    expect(store.explorer.value!.moves).toHaveLength(3);
    await controller.idle();
    await new Promise((r) => setTimeout(r, 50)); // the live watch's turn
    expectNoEngine(store);
    expect(store.explorer.value!.moves.every((m) => !m.rating && !m.failed)).toBe(true);
    // The engine searched the game's positions (its annotations and watch), but no explored one.
    expect(transport.searchedFens().length).toBeGreaterThan(0);
    const searched = transport.searchedFens(from);
    expect(searched.filter((k) => explored.has(k))).toEqual([]);
    expect(transport.positionFens(from).filter((k) => explored.has(k))).toEqual([]);
    expect(searched.every((k) => k === fenKey(store.liveFen.value))).toBe(true);
    expect(store.game.value?.assisted).toBe(false);

    // Switched on: the explored position is searched now.
    engineOn(controller);
    await controller.idle();
    await vi.waitFor(() => expect(transport.searchedFens(from).filter((k) => explored.has(k)).length).toBeGreaterThan(0));
  });

  it('shows nothing even for positions the engine already knows (the game’s watch, the analysis cache)', async () => {
    const { controller, store, engines } = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    controller.newGame(settings({ showBestMoves: true })); // arrows on in the game: none in the explorer
    await playAll(controller, ['e2e4', 'g1f3']);
    await controller.idle();
    // The game's live position: the watch analyzed it, and the explorer starts there.
    await vi.waitFor(() => expect(store.live.value?.key).toBe(fenKey(store.liveFen.value)));
    expect(store.board.value.arrows?.length).toBeGreaterThan(0);
    enter(controller);
    expect(store.board.value.fen).toBe(store.liveFen.value);
    expectNoEngine(store);
    expect(store.explorerPanel.value?.best).toBeNull();
    // A position the cache holds (the game's after 1… e5, annotated): explored again, still nothing.
    controller.exitExplorer();
    controller.goTo(1);
    const searches = engines.analysis.searches.length;
    enter(controller);
    explore(controller, ['e7e5', 'g1f3']);
    await controller.idle();
    expect(store.explorer.value!.moves.map((m) => m.fenAfter)).toEqual([store.plies.value[1].fenAfter, store.plies.value[2].fenAfter]);
    expectNoEngine(store);
    expect(store.explorer.value!.moves.every((m) => !m.rating)).toBe(true);
    const explored = new Set(store.explorer.value!.moves.map((m) => fenKey(m.fenAfter)));
    expect(engines.analysis.searches.slice(searches).filter((x) => explored.has(fenKey(x.fen)))).toEqual([]);
    controller.exitExplorer();
  });

  it('a checkmate, stalemate or draw still shows (the rules, not the engine), with captures on the strips', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.newGame(settings({ playerColor: 'b' }), {
      startFen: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2',
    });
    await controller.idle();
    enter(controller);
    explore(controller, ['d8h4']);
    expectNoEngine(store);
    expect(store.explorerPanel.value).toMatchObject({ title: '2… Qh4#', best: 'Checkmate: Black wins.' });
    expect(store.board.value).toMatchObject({ check: true, lastMove: ['d8', 'h4'] });
    expect(store.board.value.movableColor).toBeUndefined();
    controller.stepBack();
    explore(controller, ['b8c6', 'g4g5', 'c6d4', 'e2e3', 'd4f3']); // Nxf3: a capture
    expect(store.topPlayer.value.captured.length + store.bottomPlayer.value.captured.length).toBe(1);
    expect(store.explorerDraw.value).toBeNull();
    expect(store.board.value.dests.size).toBeGreaterThan(0); // legal-move dots
  });

  it('switching it on rates every explored move so far; off withdraws the explorer’s searches at once', async () => {
    const { controller, store, engines } = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    await controller.idle();
    enter(controller);
    explore(controller, ['g1f3', 'b8c6', 'f1b5']);
    await controller.idle();
    expect(store.explorer.value!.moves.every((m) => !m.rating)).toBe(true);
    engineOn(controller);
    expect(store.game.value?.assisted).toBe(true);
    await controller.idle();
    expect(store.explorer.value!.moves.every((m) => m.rating)).toBe(true);
    const fen = explorerFen(store.explorer.value!);
    await vi.waitFor(() => expect(store.live.value?.key).toBe(fenKey(fen)));
    expect(store.board.value.arrows?.length).toBeGreaterThan(0);
    expect(store.board.value.badge?.square).toBe('b5');
    expect(store.explorerPanel.value?.best).toMatch(/^Best here: /);
    expect(store.moveList.value.showClassIcons).toBe(true);
    expect(store.toolbar.value.explorerReply.disabled).toBe(false);

    // Off: everything hides at once, the ratings stay (for when it is on again).
    controller.runExplorerAction('engine');
    expectNoEngine(store);
    expect(store.explorer.value!.moves.every((m) => m.rating)).toBe(true);
    expect(store.game.value?.assisted).toBe(true); // stays unrated

    // A slow search of an explored position is withdrawn when the engine goes off.
    engineOn(controller);
    const c = new Chess(explorerFen(store.explorer.value!));
    const slow = new Set([fenKey(c.move('a6').after), fenKey(c.move('Ba4').after)]);
    const search = engines.analysis.search.bind(engines.analysis);
    vi.spyOn(engines.analysis, 'search').mockImplementation((f, opts) => {
      engines.analysis.delayMs = slow.has(fenKey(f)) ? 5_000 : 0;
      return search(f, opts);
    });
    explore(controller, ['a7a6', 'b5a4']);
    void controller.explorerReply();
    expect(store.explorerReplying.value).toBe(true);
    controller.runExplorerAction('engine');
    expect(store.explorerReplying.value).toBe(false);
    const from = engines.analysis.searches.length;
    controller.exitExplorer();
    expect(controller.playerMove('g1', 'f3')).toBe(true);
    // The game's move is rated at once: the explorer's searches gave way.
    await vi.waitFor(() => expect(store.plies.value[2]?.classification).toBeDefined(), { timeout: 2_000 });
    expect(engines.analysis.searches.slice(from).filter((x) => slow.has(fenKey(x.fen)))).toEqual([]);
    vi.mocked(engines.analysis.search).mockRestore();
    engines.analysis.delayMs = 0;
    await controller.idle();
  });

  it('remembers in this game that it was switched on (or off again); a new game starts with it off', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6', 'g8f6']) });
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    enter(controller);
    engineOn(controller); // asks, then on
    controller.exitExplorer();
    enter(controller);
    expect(store.explorerEngine.value).toBe(true); // at once, no question
    expect(store.sheet.value).toBeNull();
    controller.runExplorerAction('engine'); // off
    controller.exitExplorer();
    enter(controller);
    expect(store.explorerEngine.value).toBe(false);
    controller.runExplorerAction('engine'); // the game is unrated already: on at once
    expect(store.sheet.value).toBeNull();
    expect(store.explorerEngine.value).toBe(true);
    controller.exitExplorer();
    controller.rematch();
    await controller.idle();
    enter(controller);
    expect(store.explorerEngine.value).toBe(false);
    expect(store.game.value?.assisted).toBe(false);
  });

  it('an older save made unrated by the explorer loads unrated, and the explorer opens with its engine off', async () => {
    const storage = new MemoryStorage();
    const old: SavedGame = {
      version: 1,
      id: 'old-1',
      startFen: START_FEN,
      moves: ['e2e4', 'e7e5'],
      playerColor: 'w',
      botId: 'pip',
      botElo: 100,
      botName: 'Pip',
      assisted: true, // as when opening the explorer made a game unrated
      startedAt: '2026-09-01T10:00:00.000Z',
      annotations: {},
    };
    expect(saveGame(old, storage)).toBe(true);
    const { controller, store } = await setup({ bot: new ScriptedBot(['b8c6']), storage });
    expect(store.phase.value).toBe('playing');
    expect(store.game.value).toMatchObject({ id: 'old-1', assisted: true });
    expect(store.bottomPlayer.value.unrated).toBe(true);
    enter(controller);
    expect(store.explorerEngine.value).toBe(false);
    expect(store.explorerPanel.value?.lines?.[0]).toBe(`${EXPLORER_ENGINE_OFF} This game is already unrated.`);
    controller.runExplorerAction('engine'); // unrated already: no question
    expect(store.sheet.value).toBeNull();
    expect(store.explorerEngine.value).toBe(true);
  });
});

describe('explorer: engine', () => {
  it('watches the explored position (eval bar, arrows, Best here), and the game’s again after Exit', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.newGame(settings({ showBestMoves: true, showEvalBar: false }));
    await playAll(controller, ['e2e4']);
    controller.requestExplore();
    expect(store.evalBar.value).toMatchObject({ visible: false, off: true }); // as the game's, while the engine is off
    engineOn(controller);
    expect(store.evalBar.value.visible).toBe(true); // shown with the explorer's engine, even when off for the game
    expect(store.evalBar.value.off).toBeUndefined();
    explore(controller, ['g1f3']);
    const fen = explorerFen(store.explorer.value!);
    await vi.waitFor(() => expect(store.live.value?.key).toBe(fenKey(fen)));
    const best = scoreMoves(fen)[0].uci;
    expect(store.board.value.arrows?.[0]).toMatchObject({ from: best.slice(0, 2), to: best.slice(2, 4), brush: 'best' });
    expect(store.board.value.arrows?.slice(1).every((a) => a.brush === 'alt')).toBe(true);
    expect(store.explorerPanel.value?.best).toMatch(/^Best here: \S+ \([+-]?\d+\.\d\)$/);
    controller.runExplorerAction('arrows');
    expect(store.board.value.arrows).toEqual([]);
    expect(store.explorerPanel.value?.actions[0]).toEqual({ id: 'arrows', label: 'Arrows off', pressed: false });
    controller.runExplorerAction('arrows');
    expect(store.board.value.arrows?.length).toBeGreaterThan(0);

    controller.exitExplorer();
    expect(store.evalBar.value.visible).toBe(false);
    await vi.waitFor(() => expect(store.live.value?.key).toBe(fenKey(store.liveFen.value)));
  });

  it('Engine reply plays the engine’s best move for the side to move', async () => {
    const { controller, store, engines } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.newGame(settings({ showBestMoves: true }));
    await playAll(controller, ['e2e4']);
    controller.requestExplore();
    engineOn(controller);
    explore(controller, ['g1f3']);
    engines.analysis.script = ['g8f6'];
    // A fresh position: not analyzed deeply yet, so it asks for an annotation search.
    await controller.explorerReply();
    expect(store.explorerReplying.value).toBe(false);
    expect(store.explorer.value?.moves.map((m) => m.uci)).toEqual(['g1f3', 'g8f6']);
    await controller.idle();
    // Now from the analysis at hand (the live search reached depth 18 with the fake engine).
    const fen = explorerFen(store.explorer.value!);
    await vi.waitFor(() => expect(store.live.value?.key).toBe(fenKey(fen)));
    const expected = store.live.value!.result.lines[0].pv[0];
    await controller.explorerReply();
    expect(store.explorer.value?.moves.at(-1)?.uci).toBe(expected);
    expect(store.plies.value).toHaveLength(2); // the game did not move
  });

  it('rates each explored move like a game ply: badge, list icon, verdict, eval and explanation', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    controller.newGame(settings({ showBestMoves: true }));
    await playAll(controller, ['e2e4', 'g1f3']);
    await controller.idle();
    vi.mocked(classifyMove).mockClear();
    vi.mocked(explainMove).mockClear();
    controller.requestExplore();
    engineOn(controller);
    explore(controller, ['f1c4']);
    expect(store.explorerPanel.value).toMatchObject({ title: '3. Bc4', verdict: 'Checking…', busy: true });
    explore(controller, ['g8f6']); // Black's move: neutral wording
    await controller.idle();
    const [white, black] = store.explorer.value!.moves;
    expect(white.rating && black.rating).toBeTruthy();

    // The first move uses the game's previous move; the second, the first explored one.
    const calls = vi.mocked(classifyMove).mock.calls.map((c) => c[0]);
    const game = store.plies.value;
    const c1 = calls.find((c) => c.moveUci === 'f1c4')!;
    expect(c1.prevFenBefore).toBe(game[3].fenBefore);
    expect(c1.prevMove).toEqual({ to: game[3].uci.slice(2, 4) });
    expect(c1.opponentPrevWinLoss).toBe(game[3].classification?.winLoss);
    expect(c1.playerRating).toBe(store.profile.value.rating);
    const c2 = calls.find((c) => c.moveUci === 'g8f6')!;
    expect(c2.prevFenBefore).toBe(white.fenBefore);
    expect(c2.opponentPrevWinLoss).toBe(white.rating!.classification.winLoss);
    expect(c2.playerRating).toBe(store.game.value!.botElo);
    const persp = vi.mocked(explainMove).mock.calls.map((c) => [c[0].moveUci, c[0].perspective]);
    expect(persp).toEqual([
      ['f1c4', 'you'],
      ['g8f6', 'neutral'],
    ]);

    // The board, the move list and the panel show the verdict on the move on the board.
    const r = black.rating!;
    expect(store.moveList.value.plies[1].classification?.cls).toBe(r.classification.cls);
    expect(store.board.value.badge).toEqual({ square: 'f6', cls: r.classification.cls });
    const panel = store.explorerPanel.value!;
    expect(panel.title).toBe('3… Nf6');
    expect(panel.busy).toBe(false);
    expect(panel.verdict).toBeTruthy();
    expect(panel.evalLabel).toMatch(/^[+-]?\d+\.\d$|^-?M\d+$|^0\.0$/);
    expect(panel.lines[0]).toBe(r.explanation.headline);
    // The eval bar follows the explorer, not the game.
    expect(store.evalBar.value.label).not.toBe('');

    // Stepping back shows the earlier move's verdict; the ratings stay.
    controller.stepBack();
    expect(store.explorerPanel.value?.title).toBe('3. Bc4');
    expect(store.board.value.badge?.square).toBe('c4');
    // Each position is analyzed once: replaying the line asks for nothing new.
    vi.mocked(classifyMove).mockClear();
    controller.stepForward();
    await controller.idle();
    expect(classifyMove).not.toHaveBeenCalled();
  });

  it('the explorer never stalls the game’s own annotations', async () => {
    const bot = new ScriptedBot(['e7e5', 'b8c6']);
    const { controller, store } = await setup({ bot });
    controller.newGame(settings({ showBestMoves: true }));
    expect(controller.playerMove('e2', 'e4')).toBe(true);
    controller.requestExplore(); // at once, while the game's first ply is being analyzed
    engineOn(controller);
    explore(controller, ['e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6']);
    await controller.idle();
    expect(store.explorer.value!.moves.every((m) => m.rating)).toBe(true);
    expect(store.plies.value.length).toBeGreaterThanOrEqual(2);
    expect(store.plies.value.every((p) => p.classification && p.explanation)).toBe(true);
    expect(store.failedAnnotations.value.size).toBe(0);
    controller.exitExplorer();
    await controller.idle();
    expect(store.plies.value.every((p) => p.classification)).toBe(true);
  });

  it('a failed rating offers Try again', async () => {
    const { controller, store, engines } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.newGame(settings({ showBestMoves: true }));
    await playAll(controller, ['e2e4']);
    await controller.idle();
    controller.requestExplore();
    engineOn(controller);
    // Cut the rating's searches short below the annotation depth (aborted, not at a node budget).
    const search = engines.analysis.search.bind(engines.analysis);
    vi.spyOn(engines.analysis, 'search').mockImplementation(async (fen, opts) => {
      const r = await search(fen, opts);
      return opts?.depth === ANNOTATE_DEPTH ? { ...r, depth: 3, aborted: true } : r;
    });
    explore(controller, ['h2h3']);
    await controller.idle();
    expect(store.explorer.value!.moves[0].failed).toBe(true);
    expect(store.explorerPanel.value).toMatchObject({ verdict: 'Couldn’t check this move', busy: false });
    expect(store.explorerPanel.value!.actions.map((a) => a.id)).toContain('retryRating');
    vi.mocked(engines.analysis.search).mockRestore();
    controller.runExplorerAction('retryRating');
    await controller.idle();
    expect(store.explorer.value!.moves[0].rating).toBeDefined();
  });

  it('a rating that throws fails once (Try again) and is not retried without end', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    await controller.idle();
    enter(controller);
    engineOn(controller);
    await controller.idle();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(classifyMove).mockImplementationOnce(() => {
      throw new Error('odd position');
    });
    const calls = vi.mocked(classifyMove).mock.calls.length;
    explore(controller, ['g1f3']);
    await controller.idle();
    expect(vi.mocked(classifyMove).mock.calls.length - calls).toBe(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(store.explorer.value!.moves[0]).toMatchObject({ failed: true });
    expect(store.explorerPanel.value!.actions.map((a) => a.id)).toContain('retryRating');
    errors.mockRestore();
    // Try again: rated this time, and the next move too.
    controller.runExplorerAction('retryRating');
    explore(controller, ['b8c6']);
    await controller.idle();
    expect(store.explorer.value!.moves.every((m) => m.rating)).toBe(true);
  });

  it('switched on after a long line: the position on the board is analyzed first, before the backlog of ratings', async () => {
    const { controller, store, engines } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    await controller.idle();
    enter(controller);
    const line = ['g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1', 'b7b5', 'a4b3', 'd7d6'];
    explore(controller, line);
    const fen = explorerFen(store.explorer.value!);
    engines.analysis.delayMs = 15;
    const from = engines.analysis.searches.length;
    engineOn(controller);
    await vi.waitFor(() => expect(store.explorerPanel.value?.best).toMatch(/^Best here: /), { timeout: 5_000, interval: 2 });
    // Only the position on the board was searched (the live watch, which its ensure joined).
    const rated = store.explorer.value!.moves.filter((m) => m.rating).length;
    expect(rated).toBeLessThan(2);
    expect(engines.analysis.searches.slice(from).map((x) => fenKey(x.fen))).toContain(fenKey(fen));
    expect(store.evalBar.value.thinking).toBeFalsy();
    await controller.idle();
    engines.analysis.delayMs = 0;
    expect(store.explorer.value!.moves.every((m) => m.rating)).toBe(true);
  });

  it('a third repetition (counting the game’s positions) is a draw: 0.0, no more moves, no reply, no best move', async () => {
    // The game: 1. Nf3 Nf6 2. Ng1 Ng8, back to the start position (its second time).
    const bot = new ScriptedBot(['g8f6', 'f6g8', 'g8f6', 'f6g8']);
    const { controller, store } = await setup({ bot });
    controller.newGame(settings({ showBestMoves: true }));
    await playAll(controller, ['g1f3', 'f3g1']);
    controller.requestExplore();
    engineOn(controller);
    explore(controller, ['g1f3', 'g8f6', 'f3g1']);
    expect(store.explorerDraw.value).toBeNull();
    expect(store.board.value.movableColor).toBe('black');
    explore(controller, ['f6g8']); // the start position for the third time
    await controller.idle();
    expect(store.explorerDraw.value).toBe('Threefold repetition');
    expect(store.evalBar.value).toMatchObject({ label: '0.0', thinking: false });
    expect(store.explorerPanel.value).toMatchObject({ best: 'Threefold repetition: a draw.', evalLabel: '0.0' });
    expect(store.explorerPanel.value!.lines[0]).toMatch(/repeats the position for the third time/);
    expect(store.board.value.movableColor).toBeUndefined();
    expect(store.board.value.dests.size).toBe(0);
    expect(store.board.value.arrows).toEqual([]);
    expect(store.toolbar.value.explorerReply.disabled).toBe(true);
    expect(controller.explorerMove('g1', 'f3')).toBe(false);
    await controller.explorerReply();
    expect(store.explorer.value!.moves).toHaveLength(4);
    // One step back: play on.
    controller.stepBack();
    expect(store.explorerDraw.value).toBeNull();
    expect(store.board.value.movableColor).toBe('black');
    controller.exitExplorer();

    // The game drawn by repetition: exploring its final position says so too.
    await playAll(controller, ['g1f3', 'f3g1']);
    expect(store.outcome.value?.reason).toBe('Threefold repetition');
    controller.closeSheet();
    expect(store.evalBar.value.label).toBe('0.0');
    controller.requestExplore();
    engineOn(controller);
    expect(store.explorerDraw.value).toBe('Threefold repetition');
    expect(store.evalBar.value.label).toBe('0.0');
    expect(store.explorerPanel.value?.best).toBe('Threefold repetition: a draw.');
    expect(store.board.value.movableColor).toBeUndefined();
  });

  it('too little material, or the 50-move rule: a draw there too', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot() });
    controller.newGame(settings({ showBestMoves: true }), { startFen: '4k3/8/8/8/8/8/3n4/4K2R w - - 99 80' });
    await controller.idle();
    controller.requestExplore();
    engineOn(controller);
    explore(controller, ['h1h2']); // the 100th half-move without a capture or a pawn move
    expect(store.explorerDraw.value).toBe('50-move rule');
    expect(store.explorerPanel.value?.best).toBe('50-move rule: a draw.');
    controller.stepBack();
    explore(controller, ['e1d2']); // Kxd2: a capture starts the count again, and a rook can mate
    expect(store.explorerDraw.value).toBeNull();
    controller.exitExplorer();
    controller.newGame(settings({ showBestMoves: true }), { startFen: '4k3/8/8/8/8/8/3r4/4K3 w - - 0 1' });
    await controller.idle();
    controller.requestExplore();
    engineOn(controller);
    explore(controller, ['e1d2']);
    expect(store.explorerDraw.value).toBe('Insufficient material');
    expect(store.board.value.movableColor).toBeUndefined();
  });

  it('leaving the explorer withdraws its searches: the game’s own analysis comes next', async () => {
    const { controller, store, engines } = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    controller.newGame(settings({ showBestMoves: true }));
    await playAll(controller, ['e2e4']);
    await controller.idle();
    // The explorer's positions take ages to search (until aborted); the game's are quick.
    const explored = new Set<string>();
    const c = new Chess(store.liveFen.value);
    for (const san of ['Nf3', 'Nc6', 'Bb5']) explored.add(fenKey(c.move(san).after));
    const search = engines.analysis.search.bind(engines.analysis);
    vi.spyOn(engines.analysis, 'search').mockImplementation((fen, opts) => {
      engines.analysis.delayMs = explored.has(fenKey(fen)) ? 5_000 : 0;
      return search(fen, opts);
    });
    controller.requestExplore();
    engineOn(controller);
    explore(controller, ['g1f3', 'b8c6', 'f1b5']);
    void controller.explorerReply(); // an annotation search of the explored position
    expect(store.explorerReplying.value).toBe(true);
    controller.exitExplorer();
    const from = engines.analysis.searches.length;
    expect(controller.playerMove('b1', 'c3')).toBe(true);
    // The game's move is rated at once: the explorer's search gave way.
    await vi.waitFor(() => expect(store.plies.value[2]?.classification).toBeDefined(), { timeout: 2_000 });
    // And nothing of the explorer's was searched since it closed.
    const since = engines.analysis.searches.slice(from).map((x) => fenKey(x.fen));
    expect(since.filter((k) => explored.has(k))).toEqual([]);
    vi.mocked(engines.analysis.search).mockRestore();
    engines.analysis.delayMs = 0;
    await controller.idle();
  });

  it('a reply asked for in an explorer since closed does not stand in for the next one’s', async () => {
    const { controller, store, engines } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.newGame(settings({ showBestMoves: true }));
    await playAll(controller, ['e2e4']);
    await controller.idle();
    engines.analysis.delayMs = 20;
    controller.requestExplore();
    engineOn(controller);
    explore(controller, ['g1f3']);
    const first = controller.explorerReply();
    expect(store.explorerReplying.value).toBe(true);
    controller.exitExplorer();
    controller.requestExplore();
    engineOn(controller);
    explore(controller, ['d2d4']);
    expect(store.toolbar.value.explorerReply.disabled).toBe(false);
    const second = controller.explorerReply();
    expect(second).not.toBe(first);
    await second;
    expect(store.explorer.value!.moves.map((m) => m.color)).toEqual(['w', 'b']);
    expect(store.explorer.value!.moves[0].san).toBe('d4');
    await first;
    expect(store.explorer.value!.moves).toHaveLength(2); // the stale one played nothing
    await controller.idle();
  });

  it('checkmate on the explorer’s board: no moves, no reply, and the panel says who won', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.newGame(settings({ showBestMoves: true, playerColor: 'b' }), {
      startFen: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2',
    });
    await controller.idle();
    controller.requestExplore();
    engineOn(controller);
    explore(controller, ['d8h4']);
    expect(store.board.value.movableColor).toBeUndefined();
    expect(store.board.value.check).toBe(true);
    expect(store.toolbar.value.explorerReply.disabled).toBe(true);
    expect(store.explorerPanel.value?.best).toBe('Checkmate: Black wins.');
    await controller.explorerReply();
    expect(store.explorer.value!.moves).toHaveLength(1);
    const c = new Chess(explorerFen(store.explorer.value!));
    expect(c.isCheckmate()).toBe(true);
  });
});
