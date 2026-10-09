/**
 * Draw mode in the controller and the store: the toggle and the board's view, drawings kept per
 * position (the game, browsing back, the explorer and the review share them), Clear, the first-use
 * tip remembered on the device, what ends Draw mode (a sheet, the explorer, the game's end, a new
 * game, the paywall, the Openings section, moves made for the player), and that drawing is free
 * and never makes a game unrated.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameController, type BotLike } from '../../src/game/controller';
import { NO_DRAWINGS, positionKey } from '../../src/game/drawings';
import { createEntitlements, type Entitlements } from '../../src/game/entitlements';
import { DRAW_TIP_KEY, GAME_KEY } from '../../src/game/persistence';
import { DEFAULT_SETTINGS, type GameSettings } from '../../src/game/types';
import { closeOpenings, openOpenings } from '../../src/openings/session';
import { MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet } from '../helpers/fakeEngine';
import { FakePurchases } from './fakePurchases';

const controllers: GameController[] = [];
const ents: Entitlements[] = [];

async function setup(o: { bot?: BotLike; storage?: MemoryStorage; entitlements?: Entitlements } = {}) {
  const storage = o.storage ?? new MemoryStorage();
  const engines = fakeEngineSet();
  let n = 0;
  const controller = new GameController({
    createEngines: async () => engines.set,
    onlineEvents: null,
    storage,
    sound: new RecordingSound(),
    thinkDelay: false,
    createId: () => `game-${++n}`,
    rng: () => 0.3,
    createBot: () => o.bot ?? new ScriptedBot(['e7e5', 'b8c6', 'g8f6', 'f8c5']),
    ...(o.entitlements ? { entitlements: o.entitlements } : {}),
  });
  controllers.push(controller);
  await controller.boot();
  return { controller, store: controller.store, storage };
}

const settings = (over: Partial<GameSettings> = {}): GameSettings => ({
  ...DEFAULT_SETTINGS,
  playerColor: 'w',
  botId: 'pip',
  botElo: 100,
  ...over,
});

async function play(c: GameController, uci: string): Promise<void> {
  expect(c.playerMove(uci.slice(0, 2), uci.slice(2, 4)), uci).toBe(true);
  await c.idle();
}

/** A rated game after 1. e4 e5, the human to move. */
async function ratedGame(o: Parameters<typeof setup>[0] = {}) {
  const s = await setup(o);
  s.controller.newGame(settings());
  await play(s.controller, 'e2e4');
  expect(s.store.plies.value).toHaveLength(2);
  expect(s.store.game.value?.assisted).toBe(false);
  return s;
}

afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  for (const e of ents.splice(0)) e.dispose();
  closeOpenings();
  vi.restoreAllMocks();
});

describe('Draw mode: the toggle and the board', () => {
  it('is offered only with a game on the board, and turns the board into a drawing surface', async () => {
    const { controller, store } = await setup();
    expect(store.phase.value).toBe('setup');
    expect(store.draw.value).toBeNull();
    controller.toggleDraw(); // no game: nothing
    expect(store.drawMode.value).toBe(false);

    controller.newGame(settings());
    await play(controller, 'e2e4');
    expect(store.draw.value).toMatchObject({ on: false, color: 'green', canClear: false });
    expect(store.board.value.drawColor).toBeUndefined();
    controller.toggleDraw();
    expect(store.draw.value).toMatchObject({ on: true, color: 'green', colors: ['green', 'red', 'blue', 'orange'] });
    expect(store.board.value.drawColor).toBe('green');
    // Still the game's board: its moves are offered as before (the Board's draw layer takes the touches).
    expect(store.board.value.movableColor).toBe('white');
    controller.setDrawColor('blue');
    expect(store.board.value.drawColor).toBe('blue');
    controller.toggleDraw();
    expect(store.draw.value?.on).toBe(false);
    expect(store.board.value.drawColor).toBeUndefined();
    expect(store.draw.value?.color).toBe('blue'); // the color stays for the next time
  });

  it('draws arrows and circles on the position on the board; the same again takes one off; the game stays rated', async () => {
    const { controller, store, storage } = await ratedGame();
    const saved = storage.getItem(GAME_KEY);
    controller.toggleDraw();
    controller.drawShape({ orig: 'g1', dest: 'f3', brush: 'green' });
    controller.drawShape({ orig: 'f7', brush: 'red' });
    expect(store.board.value.shapes).toEqual([
      { orig: 'g1', dest: 'f3', brush: 'green' },
      { orig: 'f7', brush: 'red' },
    ]);
    expect(store.draw.value?.canClear).toBe(true);
    controller.drawShape({ orig: 'g1', dest: 'f3', brush: 'blue' }); // another color: recolored
    expect(store.board.value.shapes).toEqual([
      { orig: 'f7', brush: 'red' },
      { orig: 'g1', dest: 'f3', brush: 'blue' },
    ]);
    controller.drawShape({ orig: 'f7', brush: 'red' }); // the same again: off
    expect(store.board.value.shapes).toEqual([{ orig: 'g1', dest: 'f3', brush: 'blue' }]);

    // Free help that is no help: no question, no sheet, still rated, and nothing saved with the game.
    expect(store.sheet.value).toBeNull();
    expect(store.game.value?.assisted).toBe(false);
    expect(storage.getItem(GAME_KEY)).toBe(saved);
    expect(store.topPlayer.value.unrated).toBeFalsy();
    expect(store.bottomPlayer.value.unrated).toBeFalsy();
  });

  it('ignores drawings outside Draw mode', async () => {
    const { controller, store } = await ratedGame();
    controller.drawShape({ orig: 'e2', dest: 'e4', brush: 'green' });
    expect(store.drawings.value).toBe(NO_DRAWINGS);
    expect(store.board.value.shapes).toBeUndefined();
  });

  it('Clear takes off this position’s drawings only; Done leaves them on the board', async () => {
    const { controller, store } = await ratedGame();
    controller.toggleDraw();
    controller.drawShape({ orig: 'g1', dest: 'f3', brush: 'green' });
    controller.goTo(1);
    controller.drawShape({ orig: 'e7', dest: 'e5', brush: 'red' });
    controller.drawShape({ orig: 'd4', brush: 'orange' });
    controller.clearDrawings();
    expect(store.board.value.shapes).toBeUndefined();
    expect(store.draw.value?.canClear).toBe(false);
    controller.goTo(null);
    expect(store.board.value.shapes).toEqual([{ orig: 'g1', dest: 'f3', brush: 'green' }]);
    controller.exitDraw(); // Done
    expect(store.drawMode.value).toBe(false);
    expect(store.board.value.shapes).toEqual([{ orig: 'g1', dest: 'f3', brush: 'green' }]);
  });
});

describe('Draw mode: drawings by position', () => {
  it('a move shows the new position’s drawings; browsing back shows the earlier ones again', async () => {
    const { controller, store } = await ratedGame();
    const before = store.liveFen.value;
    controller.toggleDraw();
    controller.drawShape({ orig: 'g1', dest: 'f3', brush: 'green' });
    controller.exitDraw();
    await play(controller, 'g1f3'); // the bot answers 2… Nc6
    expect(store.plies.value).toHaveLength(4);
    expect(store.board.value.shapes).toBeUndefined(); // a new position: none
    controller.goTo(2);
    expect(store.board.value.fen).toBe(before);
    expect(store.board.value.shapes).toEqual([{ orig: 'g1', dest: 'f3', brush: 'green' }]);
    controller.goTo(3);
    expect(store.board.value.shapes).toBeUndefined();
  });

  it('the explorer and the game share them, and they stay where they were drawn after the explorer', async () => {
    const { controller, store } = await ratedGame();
    const live = store.liveFen.value;
    controller.toggleDraw();
    controller.drawShape({ orig: 'f1', dest: 'c4', brush: 'orange' });

    controller.requestExplore();
    expect(store.explorer.value).not.toBeNull();
    expect(store.drawMode.value).toBe(false); // opening the explorer ends Draw mode
    expect(store.board.value.fen).toBe(live);
    expect(store.board.value.shapes).toEqual([{ orig: 'f1', dest: 'c4', brush: 'orange' }]);

    // Draw in the explorer, on an explored position and on the starting one.
    controller.toggleDraw();
    expect(store.board.value.drawColor).toBe('green');
    expect(controller.explorerMove('g1', 'f3')).toBe(true);
    const explored = store.board.value.fen;
    expect(store.board.value.shapes).toBeUndefined();
    controller.drawShape({ orig: 'b8', dest: 'c6', brush: 'red' });
    controller.explorerBack();
    controller.drawShape({ orig: 'd2', dest: 'd4', brush: 'green' });
    expect(store.game.value?.assisted).toBe(false);

    controller.exitExplorer();
    expect(store.drawMode.value).toBe(false);
    expect(store.board.value.fen).toBe(live);
    expect(store.board.value.shapes).toEqual([
      { orig: 'f1', dest: 'c4', brush: 'orange' },
      { orig: 'd2', dest: 'd4', brush: 'green' },
    ]);
    expect(store.drawings.value.get(positionKey(explored))).toEqual([{ orig: 'b8', dest: 'c6', brush: 'red' }]);
    // The same position reached again in a new explorer shows its drawing.
    controller.requestExplore();
    controller.explorerMove('g1', 'f3');
    expect(store.board.value.shapes).toEqual([{ orig: 'b8', dest: 'c6', brush: 'red' }]);
  });

  it('works in Game Review, and a new game clears them all', async () => {
    const { controller, store } = await ratedGame();
    controller.toggleDraw();
    controller.drawShape({ orig: 'g1', dest: 'f3', brush: 'green' });
    controller.resign();
    expect(store.phase.value).toBe('over');
    expect(store.drawMode.value).toBe(false); // the game's end ends Draw mode
    controller.closeSheet();
    expect(store.board.value.shapes).toEqual([{ orig: 'g1', dest: 'f3', brush: 'green' }]);
    controller.toggleDraw();
    expect(store.draw.value?.on).toBe(true);

    void controller.startReview();
    expect(store.phase.value).toBe('review');
    expect(store.drawMode.value).toBe(false); // so does the review starting
    controller.toggleDraw();
    controller.goTo(1);
    controller.drawShape({ orig: 'e7', dest: 'e5', brush: 'blue' });
    expect(store.board.value.shapes).toEqual([{ orig: 'e7', dest: 'e5', brush: 'blue' }]);
    controller.exitReview();
    expect(store.drawMode.value).toBe(false);
    await controller.idle();

    controller.newGame(settings());
    expect(store.drawings.value).toBe(NO_DRAWINGS);
    expect(store.board.value.shapes).toBeUndefined();
    expect(store.draw.value).toMatchObject({ on: false, canClear: false });
  });
});

describe('Draw mode: what ends it', () => {
  it('a sheet, a hint or takeback, Show best or Retry, but not Flip, browsing or the coach toggle', async () => {
    const { controller, store } = await ratedGame();
    const on = () => {
      controller.exitDraw();
      controller.toggleDraw();
      expect(store.drawMode.value).toBe(true);
    };
    on();
    controller.flip();
    controller.goTo(1);
    controller.stepForward();
    controller.toggleCoach();
    controller.toggleCoach();
    controller.setDrawColor('red');
    expect(store.drawMode.value).toBe(true);

    controller.openSheet('menu');
    expect(store.drawMode.value).toBe(false);
    controller.closeSheet();

    on();
    controller.requestHint(); // a rated game: it asks first
    expect(store.sheet.value).toBe('assist');
    expect(store.drawMode.value).toBe(false);
    controller.closeSheet();

    on();
    controller.requestUndo();
    expect(store.drawMode.value).toBe(false);
    controller.closeSheet();
    await controller.idle();

    on();
    controller.runAction('backToGame'); // browsing keeps it
    expect(store.drawMode.value).toBe(true);
    controller.runAction('showBest');
    expect(store.drawMode.value).toBe(false);
  });

  it('the paywall or the Openings section opening', async () => {
    const storage = new MemoryStorage();
    const purchases = new FakePurchases();
    const entitlements = createEntitlements({ enabled: true, purchases, storage });
    ents.push(entitlements);
    purchases.unlocked.resolve(false);
    const { controller, store } = await ratedGame({ storage, entitlements });

    // Locked Pro changes nothing for drawing: it is free.
    expect(entitlements.isAllowed('explorerEngine')).toBe(false);
    controller.toggleDraw();
    controller.drawShape({ orig: 'g1', dest: 'f3', brush: 'green' });
    expect(store.board.value.shapes).toHaveLength(1);
    expect(entitlements.paywall.value.open).toBe(false);

    controller.requestHint(); // locked: the paywall opens
    expect(entitlements.paywall.value.open).toBe(true);
    expect(store.drawMode.value).toBe(false);
    entitlements.closePaywall();

    controller.toggleDraw();
    openOpenings();
    expect(store.drawMode.value).toBe(false);
  });

  it('the game ending on the bot’s move, and the Engine reply in the explorer', async () => {
    // 1. f3 e5 2. g4 Qh4#: the bot mates while the player draws.
    const bot = new ScriptedBot(['e7e5', 'd8h4']);
    const { controller, store } = await setup({ bot });
    controller.newGame(settings());
    await play(controller, 'f2f3');
    controller.toggleDraw();
    expect(store.drawMode.value).toBe(true);
    await play(controller, 'g2g4');
    expect(store.outcome.value?.reason).toBe('Checkmate');
    expect(store.drawMode.value).toBe(false);

    controller.closeSheet();
    controller.requestExplore();
    controller.toggleDraw();
    expect(store.drawMode.value).toBe(true);
    void controller.explorerReply();
    expect(store.drawMode.value).toBe(false);
  });

  it('not the game ending in the background while exploring (its game-over sheet waits): Exit ends it', async () => {
    // 1. f3 e5 2. g4, then the bot's Qh4# lands while the player draws in the explorer.
    const bot = new ScriptedBot(['e7e5', 'd8h4']);
    const { controller, store } = await setup({ bot });
    controller.newGame(settings());
    await play(controller, 'f2f3');
    bot.manual = true;
    expect(controller.playerMove('g2', 'g4')).toBe(true);
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    controller.requestExplore();
    expect(controller.explorerMove('b8', 'c6')).toBe(true);
    controller.toggleDraw();
    controller.drawShape({ orig: 'e2', dest: 'e4', brush: 'green' });
    bot.release();
    await vi.waitFor(() => expect(store.outcome.value?.reason).toBe('Checkmate'));
    expect(store.explorer.value).not.toBeNull();
    expect(store.sheet.value).toBeNull();
    expect(store.drawMode.value).toBe(true);
    controller.drawShape({ orig: 'd2', brush: 'red' });
    expect(store.board.value.shapes).toHaveLength(2);
    controller.exitExplorer();
    expect(store.drawMode.value).toBe(false);
    expect(store.sheet.value).toBe('gameOver');
  });
});

describe('Draw mode: your move', () => {
  it('the bar shows the turn when the bot’s move gives it back (the strip under it is covered), not in the explorer', async () => {
    const bot = new ScriptedBot(['e7e5', 'b8c6']);
    const { controller, store } = await setup({ bot });
    controller.newGame(settings());
    await controller.idle();
    controller.toggleDraw();
    expect(store.draw.value?.yourMove).toBe(true);
    bot.manual = true;
    controller.exitDraw();
    expect(controller.playerMove('e2', 'e4')).toBe(true);
    controller.toggleDraw();
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    expect(store.draw.value).toMatchObject({ on: true, yourMove: false }); // the bot thinks
    bot.release();
    await vi.waitFor(() => expect(store.plies.value).toHaveLength(2));
    expect(store.draw.value).toMatchObject({ on: true, yourMove: true });
    controller.stepBack(); // browsing: the board would not take a move
    expect(store.draw.value?.yourMove).toBe(false);
    controller.backToLive();
    controller.requestExplore();
    controller.toggleDraw();
    expect(store.draw.value).toMatchObject({ on: true, yourMove: false });
  });

  it('a drawing made on a position the board has since left is dropped', async () => {
    const { controller, store } = await ratedGame();
    const before = store.board.value.fen;
    controller.toggleDraw();
    controller.stepBack();
    controller.drawShape({ orig: 'g1', dest: 'f3', brush: 'green' }, before);
    expect(store.board.value.shapes).toBeUndefined();
    controller.drawShape({ orig: 'g1', dest: 'f3', brush: 'green' }, store.board.value.fen);
    expect(store.board.value.shapes).toEqual([{ orig: 'g1', dest: 'f3', brush: 'green' }]);
    controller.backToLive();
    expect(store.board.value.fen).toBe(before);
    expect(store.board.value.shapes).toBeUndefined();
  });
});

describe('Draw mode: the first-use tip', () => {
  it('shows each time until the first drawing on the device, which is remembered', async () => {
    const storage = new MemoryStorage();
    const { controller, store } = await ratedGame({ storage });
    expect(storage.getItem(DRAW_TIP_KEY)).toBeNull();
    controller.toggleDraw();
    expect(store.draw.value?.tip).toBe(true);
    // Done without drawing: not learned yet, so it shows again next time.
    controller.exitDraw();
    expect(storage.getItem(DRAW_TIP_KEY)).toBeNull();
    controller.toggleDraw();
    expect(store.draw.value?.tip).toBe(true);
    controller.drawShape({ orig: 'd4', brush: 'green' });
    expect(store.draw.value?.tip).toBe(false);
    expect(storage.getItem(DRAW_TIP_KEY)).toBe('true');
    controller.toggleDraw();
    controller.toggleDraw();
    expect(store.draw.value?.tip).toBe(false);

    // Another session on the same device: no tip.
    const again = await ratedGame({ storage });
    again.controller.toggleDraw();
    expect(again.store.draw.value?.tip).toBe(false);
  });

  it('leaving Draw mode hides it; a storage that fails only shows it again', async () => {
    const broken = new MemoryStorage();
    vi.spyOn(broken, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(broken, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const b = await ratedGame({ storage: broken });
    b.controller.toggleDraw();
    expect(b.store.draw.value).toMatchObject({ on: true, tip: true });
    b.controller.exitDraw();
    expect(b.store.drawTip.value).toBe(false);
  });
});
