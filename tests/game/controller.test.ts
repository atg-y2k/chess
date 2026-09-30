import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/analysis/classify', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/analysis/classify')>();
  return { ...mod, classifyMove: vi.fn(mod.classifyMove) };
});

import { Chess } from 'chess.js';
import { classifyMove } from '../../src/analysis/classify';
import { START_FEN } from '../../src/chess/utils';
import { AnalysisService } from '../../src/engine/AnalysisService';
import type { EngineSet } from '../../src/engine/createEngines';
import { RETRY_CLASSES } from '../../src/game/coach';
import { buildPgn, pgnEval } from '../../src/game/pgn';
import { summarizeGame } from '../../src/game/review';
import { ENGINE_ADVICE, GameController, type BotLike } from '../../src/game/controller';
import { GAME_KEY, loadGame } from '../../src/game/persistence';
import { DEFAULT_SETTINGS, type GameSettings, type Ply, type PromotionPiece } from '../../src/game/types';
import { defaultProfile, loadProfile, saveProfile } from '../../src/rating/rating';
import { MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet } from '../helpers/fakeEngine';

const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const controllers: GameController[] = [];

interface SetupOptions {
  bot?: BotLike;
  storage?: MemoryStorage;
  rng?: () => number;
  createEngines?: () => Promise<EngineSet>;
}

function setup(o: SetupOptions = {}) {
  const storage = o.storage ?? new MemoryStorage();
  const engines = fakeEngineSet();
  const sound = new RecordingSound();
  let n = 0;
  const controller = new GameController({
    createEngines: o.createEngines ?? (async () => engines.set),
    storage,
    sound,
    thinkDelay: false,
    now: () => NOW,
    createId: () => `game-${++n}-${Math.random().toString(36).slice(2, 6)}`,
    rng: o.rng ?? (() => 0.3),
    ...(o.bot ? { createBot: () => o.bot! } : {}),
  });
  controllers.push(controller);
  return { controller, store: controller.store, storage, engines, sound };
}

const settings = (over: Partial<GameSettings> = {}): GameSettings => ({
  ...DEFAULT_SETTINGS,
  playerColor: 'w',
  botId: 'pip',
  botElo: 100,
  ...over,
});

function play(c: GameController, uci: string): boolean {
  return c.playerMove(uci.slice(0, 2), uci.slice(2, 4), uci[4] as PromotionPiece | undefined);
}

/** Plays human moves, letting the bot answer (and the analysis settle) after each one. */
async function playAll(c: GameController, ucis: string[]): Promise<void> {
  for (const uci of ucis) {
    expect(play(c, uci), `move ${uci}`).toBe(true);
    await c.idle();
  }
}

const annotated = (p: Ply) => !!(p.classification && p.explanation && p.evalWhite);

beforeEach(() => {
  vi.mocked(classifyMove).mockClear();
});

afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  vi.restoreAllMocks();
});

describe('boot', () => {
  it('enters setup with the new-game sheet when no game is saved', async () => {
    const { controller, store } = setup();
    expect(store.phase.value).toBe('boot');
    expect(controller.canReloadNow()).toBe(false);
    await controller.boot();
    expect(store.phase.value).toBe('setup');
    expect(store.sheet.value).toBe('new');
    expect(store.engineMode.value).toBe('dual');
    expect(store.board.value.fen).toBe(START_FEN);
    expect(store.board.value.movableColor).toBeUndefined();
    expect(store.coach.value.actions.map((a) => a.id)).toEqual(['newGame']);
    expect(controller.canReloadNow()).toBe(true);
  });

  it('reports an engine failure with advice, and retry() recovers', async () => {
    let fail = true;
    const engines = fakeEngineSet();
    const { controller, store } = setup({
      createEngines: async () => {
        if (fail) throw new Error('no SIMD');
        return engines.set;
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await controller.boot();
    expect(store.phase.value).toBe('error');
    expect(store.error.value?.advice).toBe(ENGINE_ADVICE);
    expect(ENGINE_ADVICE).toContain('WebAssembly SIMD');
    expect(store.coach.value.actions[0].id).toBe('retryBoot');
    fail = false;
    await controller.retry();
    expect(store.phase.value).toBe('setup');
    expect(store.error.value).toBeNull();
  });
});

describe('playing', () => {
  it('plays as White: the board updates synchronously and the real BotPlayer replies', async () => {
    const { controller, store, sound, engines } = setup();
    await controller.boot();
    controller.newGame(settings());
    expect(store.phase.value).toBe('playing');
    expect(store.sheet.value).toBeNull();
    expect(sound.played).toContain('gameStart');
    expect(store.board.value.movableColor).toBe('white');
    expect(store.board.value.dests.get('e2')).toEqual(expect.arrayContaining(['e3', 'e4']));
    expect(controller.canReloadNow()).toBe(false);

    expect(play(controller, 'e2e5')).toBe(false);
    expect(sound.played.at(-1)).toBe('illegal');

    expect(play(controller, 'e2e4')).toBe(true);
    // Board contract: the fen changes synchronously inside onMove.
    expect(store.board.value.fen).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    expect(store.plies.value).toHaveLength(1);
    expect(store.board.value.movableColor).toBeUndefined();
    expect(store.botThinking.value).toBe(true);
    expect(store.topPlayer.value.thinking).toBe(true);
    expect(sound.played.at(-1)).toBe('move');

    await controller.idle();
    expect(store.plies.value).toHaveLength(2);
    expect(store.plies.value[1].color).toBe('b');
    expect(store.botThinking.value).toBe(false);
    expect(store.humanToMove.value).toBe(true);
    expect(store.board.value.movableColor).toBe('white');
    expect(engines.bot.newGames).toBe(1);
    const legal = new Chess(store.plies.value[0].fenAfter).moves({ verbose: true }).map((m) => m.lan);
    expect(legal).toContain(store.plies.value[1].uci);
  });

  it('plays as Black: the bot opens and the board is flipped', async () => {
    const bot = new ScriptedBot(['d2d4']);
    const { controller, store } = setup({ bot });
    await controller.boot();
    controller.newGame(settings({ playerColor: 'b' }));
    expect(store.board.value.orientation).toBe('black');
    expect(store.coach.value.title).toBe('Pip is thinking…');
    await controller.idle();
    expect(store.plies.value.map((p) => p.uci)).toEqual(['d2d4']);
    expect(store.board.value.movableColor).toBe('black');
    expect(store.bottomPlayer.value.name).toBe('You');
    expect(store.topPlayer.value.name).toBe('Pip');
    controller.flip();
    expect(store.board.value.orientation).toBe('white');
    expect(store.topPlayer.value.name).toBe('You');
  });

  it('resolves random colour, custom Elo and "match my rating"', async () => {
    const storage = new MemoryStorage();
    saveProfile({ ...defaultProfile(), rating: 1234 }, storage);
    const bot = new ScriptedBot();
    const { controller, store } = setup({ bot, storage, rng: () => 0.9 });
    await controller.boot();
    controller.newGame(settings({ playerColor: 'random', botId: 'custom', botElo: 1450 }));
    expect(store.game.value?.playerColor).toBe('b');
    expect(store.game.value?.bot.name).toBe('Robot 1450');
    expect(store.game.value?.botElo).toBe(1450);
    await controller.idle();
    expect(bot.newGames.at(-1)).toBe(1450);
    expect(bot.calls[0].elo).toBe(1450);

    controller.newGame(settings({ playerColor: 'w', botId: 'custom', botElo: 800, adaptive: true }));
    expect(store.game.value?.botElo).toBe(1250);
    expect(store.settings.value.adaptive).toBe(true);
  });
});

describe('stale results', () => {
  it('never applies a bot move that resolves after an undo', async () => {
    const bot = new ScriptedBot(['e7e5', 'd7d5']);
    bot.manual = true;
    bot.ignoreAbort = true; // the bot answers even though it was aborted
    const { controller, store } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    play(controller, 'e2e4');
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    expect(controller.undo()).toBe(true);
    expect(store.plies.value).toHaveLength(0);
    expect(store.botThinking.value).toBe(false);
    bot.release();
    await new Promise((r) => setTimeout(r, 10));
    expect(store.plies.value).toHaveLength(0);

    play(controller, 'd2d4');
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    bot.release();
    await vi.waitFor(() => expect(store.plies.value).toHaveLength(2));
    expect(store.plies.value.map((p) => p.uci)).toEqual(['d2d4', 'd7d5']);
  });

  it('never applies a bot move from a previous game', async () => {
    const bot = new ScriptedBot(['e7e5']);
    bot.manual = true;
    bot.ignoreAbort = true;
    const { controller, store } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    play(controller, 'e2e4');
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    controller.newGame(settings());
    bot.release();
    await new Promise((r) => setTimeout(r, 10));
    expect(store.plies.value).toHaveLength(0);
    expect(store.humanToMove.value).toBe(true);
  });
});

describe('takebacks', () => {
  it('undo takes back the human move and the bot reply, and marks the game assisted', async () => {
    const bot = new ScriptedBot(['e7e5', 'b8c6']);
    const { controller, store, storage } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    expect(store.toolbar.value.undo.disabled).toBe(true);
    await playAll(controller, ['e2e4', 'g1f3']);
    expect(store.plies.value).toHaveLength(4);
    expect(store.game.value?.assisted).toBe(false);
    expect(controller.undo()).toBe(true);
    expect(store.plies.value.map((p) => p.uci)).toEqual(['e2e4', 'e7e5']);
    expect(store.humanToMove.value).toBe(true);
    expect(store.game.value?.assisted).toBe(true);
    expect(loadGame(storage)?.moves).toEqual(['e2e4', 'e7e5']);
    expect(loadGame(storage)?.assisted).toBe(true);
    expect(controller.undo()).toBe(true);
    expect(store.plies.value).toHaveLength(0);
    expect(controller.undo()).toBe(false);
  });

  it('undo while the bot is thinking takes back only the human move', async () => {
    const bot = new ScriptedBot();
    bot.manual = true;
    const { controller, store } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    play(controller, 'e2e4');
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    expect(controller.undo()).toBe(true);
    expect(store.plies.value).toHaveLength(0);
    expect(store.board.value.movableColor).toBe('white');
  });

  it('refuses undo when takebacks are off', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings({ allowTakebacks: false }));
    await playAll(controller, ['e2e4']);
    expect(store.toolbar.value.undo.disabled).toBe(true);
    expect(controller.undo()).toBe(false);
    expect(store.plies.value).toHaveLength(2);
  });
});

describe('game end', () => {
  it("detects checkmate (Fool's mate), records a rated loss and clears the saved game", async () => {
    const bot = new ScriptedBot(['e7e5', 'd8h4']);
    const { controller, store, storage, sound } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['f2f3', 'g2g4']);
    expect(store.outcome.value).toEqual({ result: '0-1', winner: 'b', reason: 'Checkmate' });
    expect(store.phase.value).toBe('over');
    expect(store.sheet.value).toBe('gameOver');
    expect(sound.played.slice(-2)).toEqual(['check', 'gameEnd']);
    const rc = store.ratingChange.value!;
    expect(rc.rated).toBe(true);
    expect(rc.after).toBeLessThan(rc.before);
    const profile = loadProfile(storage);
    expect(profile.rating).toBe(rc.after);
    expect(profile.losses).toBe(1);
    expect(profile.history[0].reason).toBe('Checkmate');
    expect(profile.history[0].pgn).toContain('2. g4 Qh4# 0-1');
    expect(storage.getItem(GAME_KEY)).toBeNull();
    // The finished game is not saved: an update must not reload it away (game-over sheet, review).
    expect(controller.canReloadNow()).toBe(false);
    expect(store.board.value.movableColor).toBeUndefined();
    expect(store.board.value.check).toBe(true);
    expect(store.evalBar.value.label).toBe('0-1');
    expect(store.evalBar.value.whiteWinProb).toBe(0);
    expect(store.sheets.value.gameOver?.botName).toBe('Pip');
    expect(store.coach.value.actions.map((a) => a.id)).toEqual(['review', 'rematch', 'newGame']);
  });

  it('detects stalemate', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    // An illegal start position (the side not to move is in check) falls back to the initial one.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    controller.newGame(settings(), { startFen: 'k7/8/2Q5/8/8/8/8/7K w - - 0 1' });
    expect(store.game.value?.startFen).toBe(START_FEN);
    controller.newGame(settings(), { startFen: 'k7/8/8/2Q5/8/8/8/7K w - - 0 1' });
    expect(play(controller, 'c5b6')).toBe(true);
    expect(store.outcome.value).toEqual({ result: '1/2-1/2', winner: null, reason: 'Stalemate' });
  });

  it('detects threefold repetition', async () => {
    const bot = new ScriptedBot(['g8f6', 'f6g8', 'g8f6', 'f6g8']);
    const { controller, store } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['g1f3', 'f3g1', 'g1f3', 'f3g1']);
    expect(store.plies.value).toHaveLength(8);
    expect(store.outcome.value?.reason).toBe('Threefold repetition');
  });

  it('detects insufficient material and the 50-move rule', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    controller.newGame(settings(), { startFen: 'k7/8/8/8/8/8/1r6/K7 w - - 0 1' });
    play(controller, 'a1b2');
    expect(store.outcome.value?.reason).toBe('Insufficient material');
    controller.newGame(settings(), { startFen: 'k7/8/8/8/8/8/8/KR6 w - - 99 60' });
    play(controller, 'b1b2');
    expect(store.outcome.value?.reason).toBe('50-move rule');
    expect(store.outcome.value?.result).toBe('1/2-1/2');
  });

  it('resigning an assisted game (hint used) is unrated; rematch keeps the colour', async () => {
    const bot = new ScriptedBot(['e7e5']);
    const { controller, store, storage } = setup({ bot, rng: () => 0.9 });
    await controller.boot();
    controller.newGame(settings({ playerColor: 'random' }));
    expect(store.game.value?.playerColor).toBe('b');
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    await controller.hint();
    expect(store.game.value?.assisted).toBe(true);
    controller.resign();
    expect(store.outcome.value).toEqual({ result: '0-1', winner: 'b', reason: 'Resignation' });
    expect(store.ratingChange.value).toEqual({ before: 800, after: 800, rated: false });
    const profile = loadProfile(storage);
    expect(profile.gamesPlayed).toBe(0);
    expect(profile.losses).toBe(1);
    expect(profile.history[0].rated).toBe(false);
    controller.rematch();
    expect(store.phase.value).toBe('playing');
    expect(store.game.value?.playerColor).toBe('w');
    expect(store.game.value?.assisted).toBe(false);
  });
});

describe('annotations and coach', () => {
  it('annotates every ply in order (classification, explanation, eval, opening)', async () => {
    const bot = new ScriptedBot(['e7e5', 'b8c6', 'f8c5']);
    const { controller, store, storage } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4', 'g1f3', 'f1c4']);
    const plies = store.plies.value;
    expect(plies).toHaveLength(6);
    expect(plies.every(annotated)).toBe(true);
    const calls = vi.mocked(classifyMove).mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.moveUci)).toEqual(plies.map((p) => p.uci));
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].opponentPrevWinLoss).toBe(plies[i - 1].classification!.winLoss);
      expect(calls[i].prevMove).toEqual({ to: plies[i - 1].uci.slice(2, 4) });
      expect(calls[i].before.lines.length).toBeGreaterThan(1);
      expect(calls[i].after).toBeDefined();
    }
    expect(calls[0].playerRating).toBe(800);
    expect(calls[1].playerRating).toBe(100);
    expect(plies[0].isBook).toBe(true);
    expect(plies[0].classification?.cls).toBe('book');
    expect(plies.at(-1)?.opening?.name).toMatch(/Italian|Giuoco/);
    expect(store.startEval.value).not.toBeNull();
    expect(store.evalGraph.value.points.every((p) => p !== null)).toBe(true);
    expect(store.evalGraph.value.current).toBe(6);
    await vi.waitFor(() => expect(store.evalBar.value.label).not.toBe(''));
    expect(store.evalBar.value.visible).toBe(true);
    // Annotations are persisted with the game.
    expect(Object.keys(loadGame(storage)!.annotations)).toHaveLength(6);
  });

  it('coach feedback, Show best preview and Retry after a blunder', async () => {
    const bot = new ScriptedBot(['e7e5', 'b8c6', 'e8f7']);
    bot.manual = true;
    const { controller, store } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    const step = async (uci: string) => {
      expect(play(controller, uci)).toBe(true);
      await vi.waitFor(() => expect(bot.heldCount).toBe(1));
      bot.release();
      await vi.waitFor(() => expect(store.humanToMove.value).toBe(true));
    };
    expect(store.coach.value.title).toBe('Your move');
    await step('e2e4');
    await step('d1h5');
    expect(play(controller, 'h5f7')).toBe(true); // Qxf7+?? loses the queen to Kxf7
    expect(store.coach.value.busy).toBe(true);
    await vi.waitFor(() => expect(store.plies.value[4].classification).toBeDefined());
    const ply = store.plies.value[4];
    const coach = store.coach.value;
    expect(RETRY_CLASSES.has(ply.classification!.cls)).toBe(true);
    expect(coach.cls).toBe(ply.classification!.cls);
    expect(coach.title).toMatch(/Blunder|Mistake|Miss/);
    expect(coach.lines[0]).toBe(ply.explanation!.headline);
    expect(coach.actions.map((a) => a.id)).toEqual(['showBest', 'retry']);
    expect(store.board.value.badge).toEqual({ square: 'f7', cls: ply.classification!.cls });

    controller.runAction('showBest');
    expect(store.isLive.value).toBe(false);
    expect(store.board.value.fen).toBe(ply.fenBefore);
    expect(store.board.value.movableColor).toBeUndefined();
    const brushes = store.board.value.arrows!.map((a) => `${a.brush}:${a.from}${a.to}`);
    expect(brushes).toContain('played:h5f7');
    expect(brushes.some((b) => b.startsWith('best:'))).toBe(true);
    expect(store.coach.value.cls).toBe('best');
    expect(store.coach.value.actions[0]).toEqual({ id: 'backToGame', label: 'Back to game', primary: true });

    controller.runAction('backToGame');
    expect(store.isLive.value).toBe(true);

    controller.runAction('retry');
    expect(store.plies.value).toHaveLength(4);
    expect(store.game.value?.assisted).toBe(true);
    expect(store.coach.value.title).toBe('Try again');
    expect(store.humanToMove.value).toBe(true);
    bot.release();
  });

  it('hint explains the best move with an arrow and marks the game assisted', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    controller.newGame(settings());
    expect(store.toolbar.value.hint.disabled).toBe(false);
    const pending = controller.hint();
    expect(store.coach.value.kind).toBe('hint');
    expect(store.coach.value.busy).toBe(true);
    await pending;
    expect(store.coach.value.title).toBe('Hint');
    expect(store.coach.value.lines.length).toBeGreaterThan(0);
    expect(store.board.value.arrows?.some((a) => a.brush === 'best')).toBe(true);
    expect(store.game.value?.assisted).toBe(true);
    expect(store.toolbar.value.hint.active).toBe(true);
    await controller.hint(); // toggles it off
    expect(store.coach.value.kind).not.toBe('hint');
  });

  it('best-move arrows: switching them on mid-game marks it assisted and draws the live top lines', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    expect(store.board.value.arrows).toEqual([]);
    controller.setSettings({ showBestMoves: true });
    expect(store.game.value?.assisted).toBe(true);
    await vi.waitFor(() => expect(store.board.value.arrows!.length).toBe(3));
    expect(store.board.value.arrows!.map((a) => a.brush)).toEqual(['best', 'alt', 'alt']);

    controller.newGame(settings({ showBestMoves: true }));
    expect(store.game.value?.assisted).toBe(true);
  });

  it('coach off: a minimal panel; sound setting is applied', async () => {
    const { controller, store, sound } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings({ coach: false }));
    await playAll(controller, ['e2e4']);
    expect(store.coach.value.kind).toBe('minimal');
    expect(store.coach.value.collapsed).toBe(true);
    expect(store.coach.value.lines[0]).toBe('Pip played 1… e5.');
    expect(store.board.value.badge).toBeUndefined();
    controller.toggleCoachCollapsed();
    expect(store.coach.value.collapsed).toBe(false);
    controller.setSettings({ sound: false });
    expect(sound.enabled).toBe(false);
    controller.toggleCoach();
    expect(store.settings.value.coach).toBe(true);
  });
});

describe('history', () => {
  it('browsing is read-only and a new bot move does not move the view', async () => {
    const bot = new ScriptedBot(['e7e5', 'd7d5']);
    bot.manual = true;
    const { controller, store } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    play(controller, 'e2e4');
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    controller.goTo(0);
    expect(store.board.value.fen).toBe(START_FEN);
    bot.release();
    await vi.waitFor(() => expect(store.plies.value).toHaveLength(2));
    expect(store.current.value).toBe(0);
    expect(store.isLive.value).toBe(false);
    expect(store.board.value.movableColor).toBeUndefined();
    expect(play(controller, 'd2d4')).toBe(false);
    expect(store.coach.value.actions[0].id).toBe('backToGame');
    controller.stepForward();
    expect(store.current.value).toBe(1);
    expect(store.board.value.lastMove).toEqual(['e2', 'e4']);
    controller.stepForward();
    expect(store.isLive.value).toBe(true);
    controller.stepBack();
    expect(store.current.value).toBe(1);
    controller.backToLive();
    expect(store.isLive.value).toBe(true);
    expect(store.board.value.movableColor).toBe('white');
  });
});

describe('persistence', () => {
  it('restores a game mid-way and the bot moves when it is its turn', async () => {
    const storage = new MemoryStorage();
    const bot1 = new ScriptedBot();
    bot1.manual = true;
    const first = setup({ bot: bot1, storage });
    await first.controller.boot();
    first.controller.newGame(settings());
    play(first.controller, 'e2e4');
    await vi.waitFor(() => expect(first.store.plies.value[0].classification).toBeDefined());
    const saved = loadGame(storage)!;
    expect(saved.moves).toEqual(['e2e4']);
    expect(saved.annotations[0].classification).toBeDefined();
    first.controller.dispose();

    const bot2 = new ScriptedBot(['c7c5']);
    const second = setup({ bot: bot2, storage });
    await second.controller.boot();
    expect(second.store.phase.value).toBe('playing');
    expect(second.store.game.value?.id).toBe(saved.id);
    expect(second.store.plies.value[0].classification).toEqual(saved.annotations[0].classification);
    await second.controller.idle();
    expect(second.store.plies.value.map((p) => p.uci)).toEqual(['e2e4', 'c7c5']);
    expect(bot2.calls[0].history).toEqual(['e2e4']);
    expect(second.store.humanToMove.value).toBe(true);
  });

  it('does not restore a finished game', async () => {
    const storage = new MemoryStorage();
    const first = setup({ bot: new ScriptedBot(['e7e5']), storage });
    await first.controller.boot();
    first.controller.newGame(settings());
    await playAll(first.controller, ['e2e4']);
    first.controller.resign();
    first.controller.dispose();
    const second = setup({ storage });
    await second.controller.boot();
    expect(second.store.phase.value).toBe('setup');
    expect(second.store.profile.value.history).toHaveLength(1);
  });
});

describe('page lifecycle', () => {
  it('pauses analysis and the bot while hidden, then resumes', async () => {
    const bot = new ScriptedBot(['e7e5', 'e7e6']);
    bot.manual = true;
    const paused = vi.spyOn(AnalysisService.prototype, 'setPaused');
    const { controller, store } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    play(controller, 'e2e4');
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    expect(store.botThinking.value).toBe(true);

    controller.onVisibilityChange(true);
    expect(paused).toHaveBeenLastCalledWith(true);
    expect(store.botThinking.value).toBe(false);
    bot.release(); // the aborted request resolves null
    await new Promise((r) => setTimeout(r, 10));
    expect(store.plies.value).toHaveLength(1);

    controller.onVisibilityChange(false);
    expect(paused).toHaveBeenLastCalledWith(false);
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    bot.release();
    await vi.waitFor(() => expect(store.plies.value).toHaveLength(2));
    expect(store.plies.value[1].uci).toBe('e7e6');
  });
});

describe('review and PGN', () => {
  it('reviews a finished game: accuracy, counts, key moments and the saved record', async () => {
    const bot = new ScriptedBot(['e7e5', 'b8c6', 'e8f7']);
    const { controller, store, storage } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4', 'd1h5', 'h5f7']);
    controller.resign();
    expect(controller.canReloadNow()).toBe(false);
    const done = controller.startReview();
    expect(store.phase.value).toBe('review');
    expect(controller.canReloadNow()).toBe(false);
    expect(store.sheet.value).toBeNull();
    expect(store.review.value?.progress).not.toBeNull();
    await done;
    const review = store.review.value!;
    expect(review.progress).toBeNull();
    expect(review.accuracy.w).toEqual(expect.any(Number));
    expect(review.accuracy.b).toEqual(expect.any(Number));
    const total = (c: Record<string, number | undefined>) => Object.values(c).reduce<number>((a, b) => a + (b ?? 0), 0);
    expect(total(review.counts.w)).toBe(3);
    expect(total(review.counts.b)).toBe(3);
    expect(review.names).toEqual({ w: 'You', b: 'Pip' });
    const blunder = store.plies.value[4];
    const moment = review.keyMoments.find((k) => k.index === 4);
    expect(moment).toEqual({ index: 4, cls: blunder.classification!.cls, san: 'Qxf7+', text: blunder.explanation!.headline });
    const record = loadProfile(storage).history[0];
    expect(record.accuracy).toBe(Math.round(review.accuracy.w! * 10) / 10);

    controller.goTo(5);
    expect(store.coach.value.kind).toBe('review');
    expect(store.coach.value.title).toContain('3. Qxf7+');
    expect(store.board.value.badge?.square).toBe('f7');
    expect(store.board.value.arrows?.[0]?.brush).toBe('best');
    expect(store.moveList.value.iconSet).toBe('all');
    controller.exitReview();
    expect(store.phase.value).toBe('over');
    expect(store.review.value).toBeNull();
  });

  it('exports PGN with headers, moves and evals', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4', 'g1f3']);
    const pgn = controller.exportPgn();
    expect(pgn).toContain('[Event "Chess Coach"]');
    expect(pgn).toContain('[Date "2026.09.30"]');
    expect(pgn).toContain('[White "You"]');
    expect(pgn).toContain('[Black "Pip"]');
    expect(pgn).toContain('[WhiteElo "800"]');
    expect(pgn).toContain('[BlackElo "100"]');
    expect(pgn).toContain('[Result "*"]');
    expect(pgn).toMatch(/\[ECO "C\d\d"\]/);
    expect(pgn).toMatch(/\[Opening "[^"]+"\]/);
    expect(pgn).toMatch(/^1\. e4 \{ \[%eval -?\d+\.\d\d\] \} 1\.\.\. e5 /m);
    expect(pgn.trim().endsWith('*')).toBe(true);
    expect(store.toolbar.value.exportPgn.disabled).toBe(false);
  });
});

describe('helpers', () => {
  const plies = (fen: string, sans: string[]): Ply[] => {
    const chess = new Chess(fen);
    return sans.map((san, index) => {
      const fenBefore = chess.fen();
      const m = chess.move(san);
      return { index, color: m.color, san: m.san, uci: m.lan, fenBefore, fenAfter: chess.fen() };
    });
  };

  it('buildPgn: Black to move first, SetUp/FEN tags, NAGs, evals and tag escaping', () => {
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 3 2';
    const ps = plies(fen, ['Nf6', 'Nxe5', 'Nxe4']);
    ps[1].evalWhite = { kind: 'cp', value: 35 };
    ps[1].classification = {
      cls: 'blunder', winBefore: 0.5, winAfter: 0.1, winLoss: 0.4, accuracy: 10,
      bestMoveUci: null, bestMoveSan: null, playedMoveSan: 'Nxe5',
    };
    ps[2].evalWhite = { kind: 'mate', value: -3 };
    const pgn = buildPgn({
      startFen: fen,
      plies: ps,
      white: { name: 'You "the kid"', elo: 812 },
      black: { name: 'Pip', elo: 100 },
      date: new Date(2026, 0, 5),
      result: '*',
      annotations: true,
    });
    expect(pgn).toContain('[White "You \\"the kid\\""]');
    expect(pgn).toContain('[Date "2026.01.05"]');
    expect(pgn).toContain('[SetUp "1"]');
    expect(pgn).toContain(`[FEN "${fen}"]`);
    expect(pgn).toContain('[PlyCount "3"]');
    expect(pgn).toMatch(/\n\n2\.\.\. Nf6 3\. Nxe5 \$4 \{ \[%eval 0\.35\] \} 3\.\.\. Nxe4 \{ \[%eval #-3\] \} \*\n$/);
    expect(pgnEval({ kind: 'mate', value: 0 })).toBeNull();
    expect(pgnEval({ kind: 'cp', value: -120 })).toBe('-1.20');
  });

  it('summarizeGame: counts per colour, accuracy, and inaccuracies when there are few key moments', () => {
    const ps = plies(START_FEN, ['e4', 'e5', 'Nf3', 'Nc6']);
    const cls = ['book', 'inaccuracy', 'blunder', 'good'] as const;
    ps.forEach((p, i) => {
      p.evalWhite = { kind: 'cp', value: [20, 80, -300, -280][i] };
      p.classification = {
        cls: cls[i], winBefore: 0.5, winAfter: 0.4, winLoss: 0.1, accuracy: 50,
        bestMoveUci: null, bestMoveSan: null, playedMoveSan: p.san,
      };
      p.explanation = { headline: `headline ${i}`, details: [] };
    });
    const r = summarizeGame(START_FEN, null, ps);
    expect(r.counts).toEqual({ w: { book: 1, blunder: 1 }, b: { inaccuracy: 1, good: 1 } });
    expect(r.accuracy.w).toEqual(expect.any(Number));
    expect(r.accuracy.b).toEqual(expect.any(Number));
    expect(r.keyMoments).toEqual([
      { index: 1, cls: 'inaccuracy', san: 'e5', text: 'headline 1' },
      { index: 2, cls: 'blunder', san: 'Nf3', text: 'headline 2' },
    ]);
  });

  it('hides the eval bar and graph during play when switched off, and shows them after the game', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings({ showEvalBar: false }));
    await playAll(controller, ['e2e4']);
    expect(store.evalBar.value.visible).toBe(false);
    expect(store.evalGraph.value.visible).toBe(false);
    controller.setSettings({ showEvalBar: true });
    expect(store.evalBar.value.visible).toBe(true);
    controller.setSettings({ showEvalBar: false });
    controller.resign();
    expect(store.evalBar.value.visible).toBe(true);
    expect(store.evalGraph.value.visible).toBe(true);
  });
});
