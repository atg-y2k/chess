/**
 * The explorer in the controller and the store: entering and leaving never changes the game,
 * the rated-game question and the assisted mark, Pro gating, "Play" committing the first move,
 * the bot moving in the game meanwhile, the engine's reply, and the ratings of explored moves
 * (with the fake engine).
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
import { GAME_KEY, loadGame } from '../../src/game/persistence';
import { DEFAULT_SETTINGS, type GameSettings, type PromotionPiece } from '../../src/game/types';
import { assistPrompt } from '../../src/ui/ConfirmSheet';
import { MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet, scoreMoves } from '../helpers/fakeEngine';
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

/** Enters the explorer in a rated game in progress (answering the question). */
function enterConfirmed(c: GameController): void {
  c.requestExplore();
  if (c.store.sheet.value === 'assist') c.confirmAssist();
  expect(c.store.explorer.value).not.toBeNull();
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

  it('a rated game in progress asks first; confirming makes it unrated, cancelling changes nothing', async () => {
    const { controller, store, storage } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    controller.requestExplore();
    expect(store.sheet.value).toBe('assist');
    expect(store.sheets.value.assist).toEqual({ kind: 'explore' });
    expect(assistPrompt('explore').message).toBe('Exploring uses the engine, so it makes this game unrated: win or lose, your rating stays the same.');
    expect(store.explorer.value).toBeNull();
    controller.closeSheet();
    expect(store.game.value?.assisted).toBe(false);
    expect(store.explorer.value).toBeNull();

    controller.requestExplore();
    controller.confirmAssist();
    expect(store.sheet.value).toBeNull();
    expect(store.explorer.value?.fromLive).toBe(true);
    expect(store.game.value?.assisted).toBe(true);
    expect(store.bottomPlayer.value.unrated).toBe(true);
    expect(loadGame(storage)?.assisted).toBe(true);
    controller.exitExplorer();
    controller.requestExplore(); // already unrated: no question
    expect(store.sheet.value).toBeNull();
    expect(store.explorer.value).not.toBeNull();
    controller.requestExplore(); // pressed again: closes
    expect(store.explorer.value).toBeNull();
  });

  it('after the game and in the review: no question and no effect on the rating', async () => {
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
    expect(controller.canReloadNow()).toBe(false); // the explorer is not saved
    explore(controller, ['f1c4', 'f8c5']);
    await controller.idle();
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

  it('asked on the bot’s turn, it opens on that position even when the bot moved before the answer', async () => {
    const bot = new ScriptedBot(['e7e5']);
    bot.manual = true;
    const { controller, store } = await setup({ bot });
    controller.newGame(settings());
    expect(controller.playerMove('e2', 'e4')).toBe(true);
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    const asked = store.displayedFen.value;
    controller.requestExplore();
    expect(store.sheet.value).toBe('assist');
    bot.release();
    await vi.waitFor(() => expect(store.plies.value).toHaveLength(2));
    expect(store.sheet.value).toBe('assist');
    controller.confirmAssist();
    expect(store.explorer.value).toMatchObject({ baseFen: asked, baseIndex: 1, fromLive: true, gamePlies: 1 });
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

  it('locked: Explore shows a lock and opens the paywall, with no question and no rating effect', async () => {
    const { controller, store, entitlements, purchases } = await locked();
    controller.newGame(settings());
    expect(store.toolbar.value.explore).toMatchObject({ disabled: false, locked: true });
    controller.requestExplore();
    expect(entitlements.paywall.value).toEqual({ open: true, feature: 'explorer' });
    expect(store.sheet.value).toBeNull();
    expect(store.explorer.value).toBeNull();
    expect(controller.explore()).toBe(false); // the direct call is gated too
    expect(store.game.value?.assisted).toBe(false);

    const bought = entitlements.buy();
    purchases.purchases[0].resolve('purchased');
    await bought;
    entitlements.closePaywall();
    expect(store.toolbar.value.explore.locked).toBeUndefined();
    controller.requestExplore();
    expect(store.sheet.value).toBe('assist');
  });

  it('a refund while exploring closes the explorer', async () => {
    const { controller, store, purchases } = await locked(true);
    controller.newGame(settings());
    enterConfirmed(controller);
    explore(controller, ['e2e4']);
    purchases.emit(false);
    expect(store.explorer.value).toBeNull();
    expect(store.board.value.fen).toBe(START_FEN);
  });
});

describe('explorer: playing an explored move in the game', () => {
  it('"Play" commits exactly the first explored move through the normal move path, then the bot replies', async () => {
    const bot = new ScriptedBot(['e7e5', 'b8c6']);
    const { controller, store, sound } = await setup({ bot });
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    enterConfirmed(controller);
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
    controller.requestExplore();
    expect(store.sheet.value).toBe('assist');
    expect(bot.heldCount).toBe(1); // the bot keeps thinking while the question is open
    controller.confirmAssist();
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

describe('explorer: engine', () => {
  it('watches the explored position (eval bar, arrows, Best here), and the game’s again after Exit', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.newGame(settings({ showBestMoves: true, showEvalBar: false }));
    await playAll(controller, ['e2e4']);
    controller.requestExplore();
    expect(store.evalBar.value.visible).toBe(true); // shown while exploring, even when off for the game
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

  it('a third repetition (counting the game’s positions) is a draw: 0.0, no more moves, no reply, no best move', async () => {
    // The game: 1. Nf3 Nf6 2. Ng1 Ng8, back to the start position (its second time).
    const bot = new ScriptedBot(['g8f6', 'f6g8', 'g8f6', 'f6g8']);
    const { controller, store } = await setup({ bot });
    controller.newGame(settings({ showBestMoves: true }));
    await playAll(controller, ['g1f3', 'f3g1']);
    controller.requestExplore();
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
    explore(controller, ['g1f3']);
    const first = controller.explorerReply();
    expect(store.explorerReplying.value).toBe(true);
    controller.exitExplorer();
    controller.requestExplore();
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
