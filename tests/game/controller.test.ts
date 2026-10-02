import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/analysis/classify', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/analysis/classify')>();
  return { ...mod, classifyMove: vi.fn(mod.classifyMove) };
});
vi.mock('../../src/analysis/explain', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/analysis/explain')>();
  return { ...mod, explainBestMove: vi.fn(mod.explainBestMove) };
});
vi.mock('../../src/bot/book', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/bot/book')>();
  return { ...mod, loadOpenings: vi.fn(mod.loadOpenings) };
});

import { Chess } from 'chess.js';
import { classifyMove } from '../../src/analysis/classify';
import { explainBestMove } from '../../src/analysis/explain';
import { loadOpenings } from '../../src/bot/book';
import { START_FEN, fenKey } from '../../src/chess/utils';
import { AnalysisService, LIVE_NODES } from '../../src/engine/AnalysisService';
import { RETRY_CLASSES, mentionsMove } from '../../src/game/coach';
import { buildPgn, pgnEval } from '../../src/game/pgn';
import { summarizeGame } from '../../src/game/review';
import type { EngineSet } from '../../src/engine/createEngines';
import { EngineLoadError } from '../../src/engine/errors';
import {
  ANNOTATE_DEPTH,
  ANNOTATE_NODES,
  ENGINE_ADVICE,
  ENGINE_DOWNLOAD_ADVICE,
  ENGINE_RETRY_ADVICE,
  ENGINE_STOPPED,
  GameController,
  type BotLike,
  type ControllerDeps,
  type OnlineEvents,
} from '../../src/game/controller';
import { loadGame } from '../../src/game/persistence';
import { DEFAULT_SETTINGS, type GameSettings, type Ply, type PromotionPiece } from '../../src/game/types';
import type { MoveClass } from '../../src/analysis/types';
import { defaultProfile, loadProfile, saveProfile } from '../../src/rating/rating';
import { MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet } from '../helpers/fakeEngine';

const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();
const controllers: GameController[] = [];

interface SetupOptions {
  bot?: BotLike;
  storage?: MemoryStorage;
  rng?: () => number;
  createEngines?: ControllerDeps['createEngines'];
  onlineEvents?: OnlineEvents | null;
}

function setup(o: SetupOptions = {}) {
  const storage = o.storage ?? new MemoryStorage();
  const engines = fakeEngineSet();
  const sound = new RecordingSound();
  let n = 0;
  const controller = new GameController({
    createEngines: o.createEngines ?? (async () => engines.set),
    onlineEvents: o.onlineEvents ?? null,
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
  vi.mocked(explainBestMove).mockClear();
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

  it('loads the opening book once the engines are up, not during their (maybe slow) download', async () => {
    const engines = fakeEngineSet();
    let ready!: (set: EngineSet) => void;
    const { controller, store } = setup({ createEngines: () => new Promise<EngineSet>((r) => (ready = r)) });
    vi.mocked(loadOpenings).mockClear();
    const booting = controller.boot();
    await new Promise((r) => setTimeout(r, 5));
    expect(store.phase.value).toBe('boot');
    expect(loadOpenings).not.toHaveBeenCalled();
    ready(engines.set);
    await booting;
    expect(loadOpenings).toHaveBeenCalled();
    expect(store.phase.value).toBe('setup');
  });

  it('reports an engine failure with advice, and retry() recovers', async () => {
    let fail = true;
    const engines = fakeEngineSet();
    const { controller, store } = setup({
      createEngines: async () => {
        if (fail) throw new EngineLoadError('Web Workers or WebAssembly SIMD are not available.', 'unsupported');
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

  it('picks the advice by failure kind: a timeout or crash says to try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const e of [new EngineLoadError('no answer', 'timeout'), new EngineLoadError('boom', 'crash'), new Error('?')]) {
      const { controller, store } = setup({ createEngines: async () => Promise.reject(e) });
      await controller.boot();
      expect(store.phase.value).toBe('error');
      expect(store.error.value?.advice).toBe(ENGINE_RETRY_ADVICE);
      expect(store.error.value?.detail).toBe(e.message);
    }
  });

  it('a failed download says to check the connection and retries once when back online', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const online = new EventTarget();
    let attempts = 0;
    let fail = true;
    const engines = fakeEngineSet();
    const { controller, store } = setup({
      onlineEvents: online as OnlineEvents,
      createEngines: async () => {
        attempts++;
        if (fail) throw new EngineLoadError('HTTP 503', 'download');
        return engines.set;
      },
    });
    await controller.boot();
    expect(store.phase.value).toBe('error');
    expect(store.error.value?.advice).toBe(ENGINE_DOWNLOAD_ADVICE);
    expect(ENGINE_DOWNLOAD_ADVICE).toMatch(/^Couldn’t download the chess engine\. Check your connection/);
    // Still offline: the retry fails the same way and waits for the next 'online' event.
    online.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(attempts).toBe(2));
    await vi.waitFor(() => expect(store.phase.value).toBe('error'));
    fail = false;
    online.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(store.phase.value).toBe('setup'));
    expect(attempts).toBe(3);
    // Once running, going online again does nothing.
    online.dispatchEvent(new Event('online'));
    await controller.idle();
    expect(attempts).toBe(3);
  });

  it('a manual Try again cancels the pending online retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const online = new EventTarget();
    let attempts = 0;
    const engines = fakeEngineSet();
    const { controller, store } = setup({
      onlineEvents: online as OnlineEvents,
      createEngines: async () => {
        if (++attempts === 1) throw new EngineLoadError('offline', 'download');
        return engines.set;
      },
    });
    await controller.boot();
    expect(store.phase.value).toBe('error');
    await controller.retry();
    expect(store.phase.value).toBe('setup');
    online.dispatchEvent(new Event('online'));
    await controller.idle();
    expect(attempts).toBe(2);
  });

  it('reports the analysis engine download progress while booting', async () => {
    const engines = fakeEngineSet();
    const seen: (number | null)[] = [];
    let release!: () => void;
    const { controller, store } = setup({
      createEngines: async ({ onProgress }) => {
        onProgress({ engine: 'analysis', loaded: 0, total: 0 });
        seen.push(store.engineDownload.value);
        onProgress({ engine: 'analysis', loaded: 500, total: 2000 });
        seen.push(store.engineDownload.value);
        onProgress({ engine: 'bot', loaded: 2000, total: 2000 });
        seen.push(store.engineDownload.value);
        onProgress({ engine: 'analysis', loaded: 1500, total: 2000 });
        seen.push(store.engineDownload.value);
        await new Promise<void>((r) => (release = r));
        return engines.set;
      },
    });
    const booting = controller.boot();
    await vi.waitFor(() => expect(seen).toHaveLength(4));
    expect(seen).toEqual([null, 0.25, 0.25, 0.75]);
    release();
    await booting;
    expect(store.engineDownload.value).toBeNull();
  });
});

describe('starting level', () => {
  it('a brand-new player can pick a level: saved, provisional, and "Match my rating" follows it', async () => {
    const { controller, store, storage } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    expect(store.sheets.value.newGame.newPlayer).toBe(true);
    expect(store.sheets.value.newGame.playerRating).toBe(800);
    controller.setStartingRating(1600);
    expect(store.profile.value.rating).toBe(1600);
    expect(store.profile.value.gamesPlayed).toBe(0);
    expect(loadProfile(storage).rating).toBe(1600);
    expect(store.sheets.value.newGame.playerRating).toBe(1600);
    expect(store.sheets.value.newGame.newPlayer).toBe(true);
    controller.newGame(settings({ adaptive: true }));
    expect(store.game.value?.botElo).toBe(1600);
    expect(store.bottomPlayer.value.rating).toBe(1600);
  });

  it('is not offered once a game is in the history; Set my level still works and keeps it', async () => {
    const storage = new MemoryStorage();
    const { controller, store } = setup({ storage });
    await controller.boot();
    controller.newGame(settings());
    controller.resign();
    expect(store.profile.value.history).toHaveLength(1);
    expect(store.sheets.value.newGame.newPlayer).toBe(false);
    controller.setStartingRating(2000);
    expect(store.profile.value.rating).toBe(2000);
    expect(store.profile.value.history).toHaveLength(1);
    expect(store.sheets.value.newGame.newPlayer).toBe(false);
    expect(loadProfile(storage).rating).toBe(2000);
    controller.setStartingRating(Number.NaN);
    expect(store.profile.value.rating).toBe(2000);
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
  it("detects checkmate (Fool's mate), records a rated loss and keeps the finished game saved", async () => {
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
    // The finished game stays saved with its result (an iOS restart brings back the game-over state).
    expect(loadGame(storage)?.over).toEqual({ outcome: store.outcome.value, ratingChange: rc });
    // An update still must not reload the game-over sheet or a review away.
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

  it("passes the game's start position to the bot with the move history", async () => {
    const bot = new ScriptedBot(['e8d7']);
    const { controller } = setup({ bot });
    await controller.boot();
    const startFen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
    controller.newGame(settings(), { startFen });
    await playAll(controller, ['e2e4', 'e1e2']);
    expect(bot.calls.map((c) => ({ history: c.history, startFen: c.startFen }))).toEqual([
      { history: ['e2e4'], startFen },
      { history: ['e2e4', 'e8d7', 'e1e2'], startFen },
    ]);
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    expect(bot.calls.at(-1)).toMatchObject({ history: ['e2e4'], startFen: START_FEN });
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
      expect(calls[i].prevFenBefore).toBe(plies[i - 1].fenBefore);
      expect(calls[i].before.lines.length).toBeGreaterThan(1);
      expect(calls[i].after).toBeDefined();
    }
    expect(calls[0].prevFenBefore).toBeUndefined();
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
    // The title names the move it rates.
    expect(coach.title).toMatch(/^3\. Qxf7\+ is a (blunder|mistake|miss)$/);
    expect(coach.lines[0]).toBe(ply.explanation!.headline);
    expect(coach.actions.map((a) => a.id)).toEqual(['showBest', 'retry']);
    // In a rated game the free "Show best" is the main action, not Retry (which unrates the game).
    expect(coach.actions.find((a) => a.primary)?.id).toBe('showBest');
    // Retry is on offer, so the text must not give the better move away.
    const best = ply.classification!.bestMoveSan!;
    expect(coach.lines.some((l) => mentionsMove(l, best))).toBe(false);
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

    // A rated game asks first: Retry makes it unrated.
    controller.runAction('retry');
    expect(store.sheet.value).toBe('assist');
    expect(store.sheets.value.assist).toEqual({ kind: 'retry' });
    expect(store.plies.value).toHaveLength(5);
    controller.closeSheet(); // cancel
    expect(store.game.value?.assisted).toBe(false);
    expect(store.pendingAssist.value).toBeNull();
    controller.runAction('retry');
    controller.confirmAssist();
    expect(store.sheet.value).toBeNull();
    expect(store.plies.value).toHaveLength(4);
    expect(store.game.value?.assisted).toBe(true);
    expect(store.bottomPlayer.value.unrated).toBe(true);
    expect(store.coach.value.title).toBe('Try again');
    expect(store.coach.value.lines.some((l) => mentionsMove(l, best))).toBe(false);
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

  it('hint passes all engine lines to explainBestMove, so it can compare the alternatives', async () => {
    const { controller, store, engines } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    await controller.hint();
    const fen = store.liveFen.value;
    const calls = vi.mocked(explainBestMove).mock.calls.filter((c) => c[0] === fen);
    expect(calls).toHaveLength(1);
    const [, line, opts] = calls[0];
    const search = engines.analysis.searches.findLast((q) => q.fen === fen);
    expect(search?.opts.multiPv).toBe(3);
    expect(opts?.lines).toHaveLength(3);
    expect(opts?.lines?.[0]).toEqual(line);
    expect(opts?.lines?.map((l) => l.multipv)).toEqual([1, 2, 3]);
    expect(opts?.perspective).toBe('you');
    expect(opts?.prevMove).toEqual({ to: 'e5' });
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

  it('a hint gives way to the history view while browsing, and comes back with the live position', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4', 'g1f3']);
    await controller.hint();
    const hint = store.coach.value;
    expect(hint.kind).toBe('hint');
    expect(store.toolbar.value.hint.active).toBe(true);
    controller.goTo(0);
    expect(store.coach.value.kind).not.toBe('hint');
    expect(store.coach.value.title).toBe('Viewing the start position');
    expect(store.coach.value.actions.map((a) => a.id)).toEqual(['backToGame']);
    expect(store.toolbar.value.hint).toEqual({ disabled: true, active: false });
    controller.goTo(1); // your 1. e4: its verdict, not the hint
    expect(store.coach.value.title).toMatch(/^1\. e4 is /);
    controller.goTo(null);
    expect(store.coach.value).toEqual(hint);
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

  it('restores a finished game in its game-over state; review works; the next game replaces it', async () => {
    const storage = new MemoryStorage();
    const first = setup({ bot: new ScriptedBot(['e7e5', 'b8c6']), storage });
    await first.controller.boot();
    first.controller.newGame(settings());
    await playAll(first.controller, ['e2e4', 'g1f3']);
    first.controller.resign();
    const outcome = first.store.outcome.value;
    const rc = first.store.ratingChange.value;
    await first.controller.startReview();
    first.controller.onVisibilityChange(true); // iOS: the app goes to the background...
    first.controller.dispose(); // ...and is killed.

    const bot = new ScriptedBot();
    const second = setup({ bot, storage });
    await second.controller.boot();
    const s = second.store;
    expect(s.phase.value).toBe('over');
    expect(s.outcome.value).toEqual(outcome);
    expect(s.ratingChange.value).toEqual(rc);
    expect(s.plies.value.map((p) => p.uci)).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
    expect(s.plies.value.every(annotated)).toBe(true);
    expect(s.coach.value.actions.map((a) => a.id)).toEqual(['review', 'rematch', 'newGame']);
    // Recorded once only.
    expect(s.profile.value.history).toHaveLength(1);
    expect(s.profile.value.losses).toBe(1);
    await second.controller.idle();
    expect(bot.calls).toHaveLength(0);
    await second.controller.startReview();
    expect(s.review.value?.accuracy.w).toEqual(expect.any(Number));

    second.controller.exitReview();
    second.controller.rematch();
    expect(loadGame(storage)?.over).toBeUndefined();
    expect(loadGame(storage)?.id).toBe(s.game.value?.id);
    expect(s.profile.value.history).toHaveLength(1);
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

describe('service-worker updates (canReloadNow)', () => {
  it('a finished game may reload: at once without a sheet open, in the background with one', async () => {
    const storage = new MemoryStorage();
    const first = setup({ bot: new ScriptedBot(['e7e5']), storage });
    await first.controller.boot();
    first.controller.newGame(settings());
    expect(first.controller.canReloadNow({ hidden: true })).toBe(false); // playing
    await playAll(first.controller, ['e2e4']);
    expect(first.controller.canReloadNow({ hidden: true })).toBe(false);
    first.controller.resign();
    expect(first.store.sheet.value).toBe('gameOver');
    expect(first.controller.canReloadNow()).toBe(false);
    expect(first.controller.canReloadNow({ hidden: true })).toBe(true);
    first.controller.closeSheet();
    expect(first.controller.canReloadNow()).toBe(true);
    const done = first.controller.startReview();
    expect(first.controller.canReloadNow({ hidden: true })).toBe(false); // review
    await done;
    expect(first.controller.canReloadNow({ hidden: true })).toBe(false);
    first.controller.exitReview();
    expect(first.controller.canReloadNow()).toBe(true);
    first.controller.dispose();

    // The finished game restored at launch: an update found now may reload onto the new build.
    const second = setup({ bot: new ScriptedBot(), storage });
    await second.controller.boot();
    expect(second.store.phase.value).toBe('over');
    expect(second.controller.canReloadNow()).toBe(true);
    second.controller.openSheet('menu');
    expect(second.controller.canReloadNow()).toBe(false);
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

  it('summarizeGame: a praised move that gives something away is a key moment, ranked with the inaccuracies', () => {
    const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O'];
    const annotate = (clsOf: (i: number) => MoveClass, concedes: Record<number, 'material' | 'mate'>) => {
      const ps = plies(START_FEN, sans);
      ps.forEach((p, i) => {
        p.classification = {
          cls: clsOf(i), winBefore: 0.1, winAfter: 0.09, winLoss: 0.01, accuracy: 90,
          bestMoveUci: null, bestMoveSan: null, playedMoveSan: p.san,
        };
        p.explanation = { headline: `headline ${i}`, details: [], ...(concedes[i] ? { concedes: concedes[i] } : {}) };
      });
      return ps;
    };
    // A few moments: the concession is listed with its headline, and inaccuracies fill up to three.
    let r = summarizeGame(START_FEN, null, annotate((i) => (i === 3 ? 'inaccuracy' : i === 6 ? 'blunder' : 'good'), { 5: 'material' }));
    expect(r.keyMoments).toEqual([
      { index: 3, cls: 'inaccuracy', san: 'Nc6', text: 'headline 3' },
      { index: 5, cls: 'good', san: 'a6', text: 'headline 5', concedes: 'material' },
      { index: 6, cls: 'blunder', san: 'Ba4', text: 'headline 6' },
    ]);
    expect(r.counts.b.good).toBe(7); // still counted as its class
    // A flag on a class that already says the move was weak adds nothing.
    r = summarizeGame(START_FEN, null, annotate((i) => (i === 6 ? 'blunder' : 'good'), { 6: 'material', 7: 'mate', 9: 'mate' }));
    expect(r.keyMoments.map((m) => [m.index, m.concedes])).toEqual([[6, undefined], [7, 'mate'], [9, 'mate']]);
    // Too many (one mistake, one concession and 13 inaccuracies): the concession ranks with the
    // inaccuracies (in game order), after the mistake.
    const many = (at: number) => annotate((i) => (i === 0 ? 'mistake' : i === at || i === 1 ? 'good' : 'inaccuracy'), { [at]: 'material' });
    r = summarizeGame(START_FEN, null, many(2));
    expect(r.keyMoments.map((m) => m.index)).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(r.keyMoments[1].concedes).toBe('material');
    r = summarizeGame(START_FEN, null, many(15));
    expect(r.keyMoments.map((m) => m.index)).toEqual([0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(r.keyMoments.some((m) => m.concedes)).toBe(false);
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

describe('rematch', () => {
  it('uses the current best-move-arrows setting (switched on after the game): unrated with arrows', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    controller.resign();
    controller.setSettings({ showBestMoves: true });
    controller.rematch();
    expect(store.game.value?.assisted).toBe(true);
    expect(store.game.value?.settings.showBestMoves).toBe(true);
    await vi.waitFor(() => expect(store.board.value.arrows!.length).toBeGreaterThan(0));
    await playAll(controller, ['d2d4']);
    controller.resign();
    expect(store.ratingChange.value?.rated).toBe(false);
  });

  it('arrows switched on mid-game: the rematch is unrated too', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    controller.setSettings({ showBestMoves: true });
    controller.resign();
    expect(store.ratingChange.value?.rated).toBe(false);
    controller.rematch();
    expect(store.game.value?.assisted).toBe(true);
  });

  it('arrows on at the start and switched off mid-game: the rematch is rated, with no arrows', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5', 'e7e5']) });
    await controller.boot();
    controller.newGame(settings({ showBestMoves: true, botId: 'custom', botElo: 1200 }));
    await playAll(controller, ['e2e4']);
    controller.setSettings({ showBestMoves: false });
    controller.resign();
    controller.rematch();
    expect(store.game.value?.assisted).toBe(false);
    expect(store.game.value?.botElo).toBe(1200); // same opponent
    await playAll(controller, ['e2e4']);
    expect(store.board.value.arrows).toEqual([]);
    controller.resign();
    expect(store.ratingChange.value?.rated).toBe(true);
  });
});

describe('live analysis', () => {
  it('a new game on the position already analysed shows its eval (and arrows) again', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    controller.newGame(settings({ showBestMoves: true }));
    await vi.waitFor(() => expect(store.evalBar.value.label).not.toBe(''));
    await vi.waitFor(() => expect(store.board.value.arrows!.length).toBeGreaterThan(0));
    controller.newGame(settings({ showBestMoves: true, botId: 'custom', botElo: 1500 }));
    await vi.waitFor(() => expect(store.live.value).not.toBeNull());
    expect(store.evalBar.value.label).not.toBe('');
    expect(store.evalGraph.value.points[0]).not.toBeNull();
    expect(store.board.value.arrows!.length).toBeGreaterThan(0);
    // Same after resigning at move 0 and a rematch.
    controller.resign();
    controller.rematch();
    await vi.waitFor(() => expect(store.live.value).not.toBeNull());
    expect(store.evalBar.value.label).not.toBe('');
  });

  it('keeps the last known eval number (pulsing) while the new position is analysed', async () => {
    const { controller, store, engines } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    await vi.waitFor(() => expect(store.evalBar.value.depth).toBeGreaterThan(0));
    const before = store.evalBar.value.label;
    engines.analysis.delayMs = 40;
    play(controller, 'g1f3');
    expect(store.evalBar.value.label).toBe(before);
    expect(store.evalBar.value.thinking).toBe(true);
    await controller.idle();
  });

  it('keeps the verdict badge on your move after the bot replies', async () => {
    const bot = new ScriptedBot(['e7e5']);
    bot.manual = true;
    const { controller, store } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    play(controller, 'e2e4');
    await vi.waitFor(() => expect(store.plies.value[0].classification).toBeDefined());
    const cls = store.plies.value[0].classification!.cls;
    expect(store.board.value.badge).toEqual({ square: 'e4', cls });
    bot.release();
    await vi.waitFor(() => expect(store.plies.value).toHaveLength(2));
    expect(store.board.value.lastMove).toEqual(['e7', 'e5']);
    expect(store.board.value.badge).toEqual({ square: 'e4', cls });
    expect(store.coach.value.title).toMatch(/^1\. e4 is /);
  });

  it('drops the verdict badge when the reply takes your pawn en passant', async () => {
    for (const [fen, human, reply, square] of [
      ['4k3/8/8/8/4p3/8/3P4/4K3 w - - 0 1', 'd2d4', 'e4d3', 'd4'],
      ['4k3/4p3/8/3P4/8/8/8/4K3 b - - 0 1', 'e7e5', 'd5e6', 'e5'],
    ] as const) {
      const bot = new ScriptedBot([reply]);
      bot.manual = true;
      const { controller, store } = setup({ bot });
      await controller.boot();
      controller.newGame(settings({ playerColor: fen.includes(' w ') ? 'w' : 'b' }), { startFen: fen });
      play(controller, human);
      await vi.waitFor(() => expect(store.plies.value[0].classification).toBeDefined());
      expect(store.board.value.badge?.square).toBe(square);
      bot.release();
      await vi.waitFor(() => expect(store.plies.value).toHaveLength(2));
      expect(store.plies.value[1].uci).toBe(reply);
      expect(store.coachMode.value).toEqual({ kind: 'feedback', index: 0 });
      expect(store.board.value.badge).toBeUndefined();
    }
  });
});

describe('abandoning and aborting', () => {
  it('a new game while a rated game is in progress records it as a loss by abandonment', async () => {
    const { controller, store, storage } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings({ botId: 'custom', botElo: 1500 }));
    expect(store.sheets.value.newGame.inProgress).toBeNull(); // no move yet
    await playAll(controller, ['e2e4']);
    expect(store.sheets.value.newGame.inProgress).toEqual({ rated: true });
    const id = store.game.value!.id;
    controller.openSheet('new');
    controller.newGame(settings());
    const profile = loadProfile(storage);
    expect(profile.losses).toBe(1);
    expect(profile.gamesPlayed).toBe(1);
    expect(profile.rating).toBeLessThan(800);
    expect(profile.history[0]).toMatchObject({ id, reason: 'Abandoned', playerScore: 0, rated: true });
    expect(store.profile.value).toEqual(profile);
    expect(store.phase.value).toBe('playing');
    expect(store.plies.value).toHaveLength(0);
  });

  it('"Resign & play" with Match my rating plays the opponent the sheet showed (the rating before the loss)', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings({ botId: 'custom', botElo: 800, adaptive: true }));
    expect(store.game.value?.botElo).toBe(800);
    await playAll(controller, ['e2e4']);
    controller.openSheet('new');
    const sheet = store.sheets.value.newGame;
    expect(sheet.inProgress).toEqual({ rated: true });
    expect(sheet.playerRating).toBe(800);
    controller.newGame(sheet.initial);
    expect(store.profile.value.rating).toBeLessThan(800); // the abandoned game was lost...
    expect(store.profile.value.history[0]).toMatchObject({ reason: 'Abandoned', rated: true });
    expect(store.game.value?.botElo).toBe(800); // ...but the new opponent is the one announced
    expect(store.game.value?.bot.name).toBe('Robot 800');
  });

  it('a new game before your first move, or from an unrated game, costs no rating', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings({ playerColor: 'b' })); // the bot moves first
    await controller.idle();
    expect(store.plies.value).toHaveLength(1);
    controller.newGame(settings());
    expect(store.profile.value.history).toHaveLength(0);

    await playAll(controller, ['e2e4']);
    await controller.hint();
    expect(store.sheets.value.newGame.inProgress).toEqual({ rated: false });
    controller.newGame(settings());
    expect(store.profile.value.history[0]).toMatchObject({ reason: 'Abandoned', rated: false });
    expect(store.profile.value.rating).toBe(800);
  });

  it('resigning before your first move is unrated; a rematch after a finished game records nothing more', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    controller.newGame(settings({ botId: 'custom', botElo: 3200 }));
    controller.resign();
    expect(store.ratingChange.value).toEqual({ before: 800, after: 800, rated: false });
    controller.rematch();
    expect(store.profile.value.history).toHaveLength(1);
  });
});

describe('unrated help', () => {
  it('the first hint of a rated game asks first; later ones do not; the strip shows "Unrated"', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    await controller.boot();
    controller.newGame(settings());
    expect(store.bottomPlayer.value.unrated).toBeUndefined();
    controller.requestHint();
    expect(store.sheet.value).toBe('assist');
    expect(store.sheets.value.assist).toEqual({ kind: 'hint' });
    expect(store.coach.value.kind).not.toBe('hint');
    controller.closeSheet();
    expect(store.game.value?.assisted).toBe(false);
    controller.requestHint();
    controller.confirmAssist();
    await vi.waitFor(() => expect(store.coach.value.busy).toBe(false));
    expect(store.coach.value.kind).toBe('hint');
    expect(store.game.value?.assisted).toBe(true);
    expect(store.bottomPlayer.value.unrated).toBe(true);
    controller.requestHint(); // dismisses
    expect(store.coach.value.kind).not.toBe('hint');
    await playAll(controller, ['e2e4']);
    controller.requestUndo(); // already unrated: no question
    expect(store.sheet.value).toBeNull();
    expect(store.plies.value).toHaveLength(0);
  });

  it('undo in a rated game asks first; nothing happens when there is nothing to take back', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings());
    controller.requestUndo();
    expect(store.sheet.value).toBeNull();
    await playAll(controller, ['e2e4']);
    controller.requestUndo();
    expect(store.sheets.value.assist).toEqual({ kind: 'undo' });
    controller.confirmAssist();
    expect(store.plies.value).toHaveLength(0);
    expect(store.game.value?.assisted).toBe(true);
  });

  /** Rated game, 1. f3 e5 2. g4?? with the bot's Qh4# held; resolves once 2. g4 is classified. */
  async function beforeFoolsMate() {
    const bot = new ScriptedBot(['e7e5', 'd8h4']);
    bot.manual = true;
    const t = setup({ bot });
    await t.controller.boot();
    t.controller.newGame(settings({ botId: 'custom', botElo: 1200 }));
    play(t.controller, 'f2f3');
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    bot.release();
    await vi.waitFor(() => expect(t.store.humanToMove.value).toBe(true));
    play(t.controller, 'g2g4');
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    await vi.waitFor(() => expect(t.store.plies.value[2].classification).toBeDefined());
    return { ...t, bot };
  }

  it('a takeback waiting for confirmation holds the bot reply, even one that would end the game', async () => {
    for (const ask of ['undo', 'retry'] as const) {
      const { controller, store, bot } = await beforeFoolsMate();
      if (ask === 'undo') controller.requestUndo();
      else controller.runAction('retry');
      expect(store.sheets.value.assist).toEqual({ kind: ask });
      expect(store.botThinking.value).toBe(false);
      bot.release(); // the reply (Qh4#) was cancelled: nothing lands while the question is open
      await new Promise((r) => setTimeout(r, 10));
      expect(store.phase.value).toBe('playing');
      expect(store.plies.value).toHaveLength(3);
      expect(bot.heldCount).toBe(0);
      controller.confirmAssist();
      expect(store.plies.value.map((p) => p.san)).toEqual(['f3', 'e5']);
      expect(store.game.value?.assisted).toBe(true);
      expect(store.profile.value.history).toHaveLength(0);
      expect(store.humanToMove.value).toBe(true);
    }
  });

  it('cancelling the takeback lets the bot reply', async () => {
    const { controller, store, bot } = await beforeFoolsMate();
    controller.runAction('retry');
    bot.release();
    await new Promise((r) => setTimeout(r, 10));
    expect(store.plies.value).toHaveLength(3);
    bot.moves.unshift('d8h4');
    controller.closeSheet();
    await vi.waitFor(() => expect(bot.heldCount).toBe(1));
    expect(store.botThinking.value).toBe(true);
    bot.release();
    await vi.waitFor(() => expect(store.phase.value).toBe('over'));
    expect(store.outcome.value?.reason).toBe('Checkmate');
    expect(store.profile.value.history[0]).toMatchObject({ reason: 'Checkmate', rated: true });
  });

  it('a hint that finds nothing leaves the game rated', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    controller.newGame(settings());
    vi.spyOn(AnalysisService.prototype, 'ensure').mockResolvedValueOnce({
      fen: START_FEN,
      depth: 0,
      lines: [],
      bestMove: null,
      done: false,
      aborted: true,
    });
    await controller.hint();
    expect(store.coach.value.lines).toEqual(['No hint is available for this position.']);
    expect(store.game.value?.assisted).toBe(false);
  });

  it("the bot's mistake is only pointed out in games that are unrated anyway", async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5', 'd8g5']) });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4', 'd2d4']);
    expect(store.plies.value[3].classification?.cls).toMatch(/mistake|blunder/);
    const punish = (l: string) => l.includes('Look for a way to punish it');
    expect(store.coach.value.lines.some(punish)).toBe(false);
    controller.setSettings({ showBestMoves: true }); // now unrated
    expect(store.coach.value.lines.some(punish)).toBe(true);
  });
});

describe('restore', () => {
  it('brings back the verdict (with Show best / Retry) on your last move', async () => {
    const storage = new MemoryStorage();
    const bot1 = new ScriptedBot(['e7e5', 'b8c6']);
    bot1.manual = true;
    const first = setup({ bot: bot1, storage });
    await first.controller.boot();
    first.controller.newGame(settings());
    for (const uci of ['e2e4', 'd1h5']) {
      play(first.controller, uci);
      await vi.waitFor(() => expect(bot1.heldCount).toBe(1));
      bot1.release();
      await vi.waitFor(() => expect(first.store.humanToMove.value).toBe(true));
    }
    play(first.controller, 'h5f7');
    await vi.waitFor(() => expect(first.store.plies.value[4].classification).toBeDefined());
    const cls = first.store.plies.value[4].classification!.cls;
    first.controller.dispose();

    const bot2 = new ScriptedBot(['e8f7']);
    bot2.manual = true;
    const second = setup({ bot: bot2, storage });
    await second.controller.boot();
    const s = second.store;
    expect(s.coach.value.cls).toBe(cls);
    expect(s.coach.value.actions.map((a) => a.id)).toEqual(['showBest', 'retry']);
    await vi.waitFor(() => expect(bot2.heldCount).toBe(1));
    bot2.release();
    await vi.waitFor(() => expect(s.plies.value).toHaveLength(6));
    // Still discussed after the bot's reply, as in live play.
    expect(s.coach.value.cls).toBe(cls);
    second.controller.runAction('retry');
    second.controller.confirmAssist();
    expect(s.plies.value).toHaveLength(4);
  });

  it('brings back the "Try again" prompt after a Retry (also under a hint)', async () => {
    for (const withHint of [false, true]) {
      const storage = new MemoryStorage();
      const first = setup({ bot: new ScriptedBot(['e7e5', 'b8c6', 'e8f7']), storage });
      await first.controller.boot();
      first.controller.newGame(settings({ showBestMoves: true })); // unrated: Retry needs no confirmation
      await playAll(first.controller, ['e2e4', 'd1h5', 'h5f7']);
      first.controller.runAction('retry');
      expect(first.store.plies.value).toHaveLength(4);
      const tryAgain = first.store.coach.value;
      expect(tryAgain.title).toBe('Try again');
      expect(tryAgain.lines[0]).toBe('Find a better move than Qxf7+.');
      if (withHint) {
        await first.controller.hint();
        expect(first.store.coach.value.kind).toBe('hint');
      }
      expect(loadGame(storage)?.retry).toMatchObject({ san: 'Qxf7+' });
      first.controller.dispose();

      const second = setup({ bot: new ScriptedBot(), storage });
      await second.controller.boot();
      const s = second.store;
      expect(s.plies.value.map((p) => p.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6']);
      expect(s.coach.value.title).toBe('Try again');
      expect(s.coach.value.lines).toEqual(tryAgain.lines);
      expect(s.coach.value.actions).toEqual([]);
      // The next move replaces it (and it is no longer saved).
      await playAll(second.controller, ['f1c4']);
      expect(s.coach.value.title).toMatch(/^3\. Bc4 /);
      expect(loadGame(storage)?.retry).toBeUndefined();
    }
  });
});

describe('engine failure', () => {
  it('an analysis engine that breaks mid-game shows the error screen; Try again restores the game', async () => {
    const storage = new MemoryStorage();
    const sets: ReturnType<typeof fakeEngineSet>[] = [];
    const { controller, store } = setup({
      bot: new ScriptedBot(['e7e5', 'b8c6']),
      storage,
      createEngines: async () => {
        const e = fakeEngineSet();
        sets.push(e);
        return e.set;
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    sets[0].analysis.failWith = new Error('worker crashed');
    play(controller, 'g1f3');
    await vi.waitFor(() => expect(store.phase.value).toBe('error'));
    expect(store.error.value?.message).toBe(ENGINE_STOPPED);
    expect(store.coach.value.actions.map((a) => a.id)).toEqual(['retryBoot']);
    expect(loadGame(storage)?.moves.slice(0, 3)).toEqual(['e2e4', 'e7e5', 'g1f3']);
    await controller.retry();
    expect(store.phase.value).toBe('playing');
    expect(sets).toHaveLength(2);
    await controller.idle();
    expect(store.plies.value.slice(0, 3).map((p) => p.uci)).toEqual(['e2e4', 'e7e5', 'g1f3']);
    expect(store.plies.value.every(annotated)).toBe(true);
  });

  it('a bot engine that breaks never lets the bot play a heuristic move in a rated game', async () => {
    const sets: ReturnType<typeof fakeEngineSet>[] = [];
    const { controller, store } = setup({
      createEngines: async () => {
        const e = fakeEngineSet();
        sets.push(e);
        return e.set;
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await controller.boot();
    // Out of the opening book, so the bot needs its engine.
    controller.newGame(settings({ botId: 'custom', botElo: 2800 }), { startFen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1' });
    sets[0].bot.failWith = new Error('worker crashed');
    play(controller, 'e2e4');
    await vi.waitFor(() => expect(store.phase.value).toBe('error'));
    await controller.idle();
    expect(store.plies.value).toHaveLength(1);
    expect(store.profile.value.history).toHaveLength(0);
    await controller.retry();
    await controller.idle();
    expect(store.phase.value).toBe('playing');
    expect(store.plies.value).toHaveLength(2);
  });

  it('a move whose analysis failed offers to try again instead of spinning forever', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings());
    const empty = { depth: 0, lines: [], bestMove: null, done: false, aborted: true };
    const ensure = vi
      .spyOn(AnalysisService.prototype, 'ensure')
      .mockImplementationOnce(async (fen: string) => ({ fen, ...empty }));
    await playAll(controller, ['e2e4']);
    expect(store.plies.value[0].classification).toBeUndefined();
    expect(store.coach.value.busy).toBe(false);
    expect(store.coach.value.title).toBe('Couldn’t check e4');
    expect(store.coach.value.actions.map((a) => a.id)).toEqual(['retryAnalysis']);
    ensure.mockRestore();
    controller.runAction('retryAnalysis');
    await controller.idle();
    expect(store.plies.value[0].classification).toBeDefined();
    expect(store.coach.value.title).toMatch(/^1\. e4 is /);
  });

  it('a search cut short below the annotation depth is retried, not taken as the verdict', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings());
    // Pre-empted at depth 6 with lines: a partial result, not an annotation.
    const ensure = vi.spyOn(AnalysisService.prototype, 'ensure');
    ensure.mockImplementationOnce(async (fen: string) => ({
      fen,
      depth: 6,
      lines: [{ multipv: 1, depth: 6, score: { kind: 'cp', value: 30 }, pv: ['e7e5'] }],
      bestMove: null,
      done: false,
      aborted: true,
    }));
    await playAll(controller, ['e2e4']);
    expect(store.plies.value[0].classification).toBeUndefined();
    expect(store.plies.value[0].evalDepth).toBeUndefined();
    expect(store.coach.value.actions.map((a) => a.id)).toEqual(['retryAnalysis']);
    ensure.mockRestore();
    controller.runAction('retryAnalysis');
    await controller.idle();
    expect(store.plies.value[0].classification).toBeDefined();
    expect(store.plies.value[0].evalDepth).toBeGreaterThanOrEqual(14);
  });

  it('a search that stops at its node budget below the annotation depth is the verdict, not a failure', async () => {
    const { controller, store, engines } = setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    engines.analysis.nodeCapDepth = 11; // every budgeted search runs out of nodes at depth 11
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4', 'g1f3']);
    await controller.idle();
    const ps = store.plies.value;
    expect(ps).toHaveLength(4);
    expect(ps.every(annotated)).toBe(true);
    expect(ps.every((p) => p.evalDepth === 11)).toBe(true);
    expect(store.failedAnnotations.value.size).toBe(0);
    expect(store.coach.value.title).toMatch(/^2\. Nf3 is /);
    // Every search has a node budget: the coach's (annotations, hints, Show best, review) and live analysis.
    const searches = engines.analysis.searches.filter((x) => !new Chess(x.fen).isGameOver());
    expect(searches.length).toBeGreaterThan(0);
    for (const x of searches) {
      expect(x.opts.nodes).toBe(x.opts.depth === ANNOTATE_DEPTH ? ANNOTATE_NODES : LIVE_NODES);
    }
    // A position is not searched again once a search spent the budget on it (the "after" of a
    // move is the "before" of the next one).
    const coach = searches.filter((x) => x.opts.depth === ANNOTATE_DEPTH).map((x) => fenKey(x.fen));
    expect(new Set(coach).size).toBe(coach.length);
    // The hint accepts such a result too.
    const before = engines.analysis.searches.length;
    await controller.hint();
    const m = store.coachMode.value;
    expect(m.kind === 'hint' && m.explanation?.headline).toMatch(/\S/);
    expect(m.kind === 'hint' && m.explanation?.headline).not.toBe('No hint is available for this position.');
    expect(engines.analysis.searches.slice(before).every((x) => x.opts.depth !== ANNOTATE_DEPTH)).toBe(true); // from the cache
  });

  it('an aborted result that already reached the annotation depth is used', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings());
    const real = AnalysisService.prototype.ensure;
    vi.spyOn(AnalysisService.prototype, 'ensure').mockImplementation(async function (this: AnalysisService, fen, opts) {
      const r = await real.call(this, fen, opts);
      return { ...r, aborted: true, done: false };
    });
    await playAll(controller, ['e2e4']);
    expect(store.plies.value[0].classification).toBeDefined();
    expect(store.coach.value.title).toMatch(/^1\. e4 is /);
  });
});

describe('draws the engine cannot see', () => {
  it('repeating the position a third time when winning is a bad move; the final eval is 0.0', async () => {
    const bot = new ScriptedBot(['e7e5', 'd8g5', 'b8c6', 'c6b8', 'b8c6', 'c6b8']);
    const { controller, store } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4', 'g1f3', 'f3g5', 'g5f3', 'f3g5', 'g5f3', 'f3g5']);
    expect(store.outcome.value?.reason).toBe('Threefold repetition');
    await controller.idle();
    const last = store.plies.value.at(-1)!;
    expect(last.san).toBe('Ng5');
    expect(last.classification?.cls).toMatch(/mistake|blunder/);
    expect(last.classification?.winAfter).toBe(0.5);
    expect(last.evalWhite).toEqual({ kind: 'cp', value: 0 });
    expect(last.explanation?.headline).toContain('repeats the position for the third time');
    expect(last.explanation?.details[0]).toContain('You were winning');
    expect(store.evalBar.value.label).toBe('0.0');
    expect(store.evalBar.value.whiteWinProb).toBe(0.5);
    expect(store.evalGraph.value.points.at(-1)).toBe(0.5);
    await controller.startReview();
    expect(store.review.value?.keyMoments.some((k) => k.index === last.index)).toBe(true);
  });
});

describe('Show best', () => {
  it('shows the variation once and keeps what was wrong with the played move', async () => {
    const bot = new ScriptedBot(['e7e5', 'b8c6']);
    bot.manual = true;
    const { controller, store } = setup({ bot });
    await controller.boot();
    controller.newGame(settings());
    for (const uci of ['e2e4', 'd1h5']) {
      play(controller, uci);
      await vi.waitFor(() => expect(bot.heldCount).toBe(1));
      bot.release();
      await vi.waitFor(() => expect(store.humanToMove.value).toBe(true));
    }
    play(controller, 'h5f7');
    await vi.waitFor(() => expect(store.plies.value[4].classification).toBeDefined());
    const ply = store.plies.value[4];
    controller.runAction('showBest');
    const lines = store.coach.value.lines;
    expect(lines).toContain(`You played Qxf7+. ${ply.explanation!.headline}`);
    const variations = lines.filter((l) => /^(Main line|Key line|The finish|Best line):/.test(l));
    expect(variations.length).toBeLessThanOrEqual(1);
    // Explained with all the engine lines of that position, like the hint.
    const call = vi.mocked(explainBestMove).mock.calls.findLast((c) => c[0] === ply.fenBefore);
    expect(call?.[2]?.lines?.length).toBeGreaterThan(1);
    expect(call?.[2]?.lines).toContainEqual(call?.[1]);
    bot.release();
  });

  /** Plays 1. e4 e5 2. Qh5 Nc6 3. Qxf7+?? (the bot holds Kxf7) and returns the Show best lines of the live game. */
  async function blunderGame(storage: MemoryStorage) {
    const bot = new ScriptedBot(['e7e5', 'b8c6']);
    bot.manual = true;
    const first = setup({ bot, storage });
    await first.controller.boot();
    first.controller.newGame(settings());
    for (const uci of ['e2e4', 'd1h5']) {
      play(first.controller, uci);
      await vi.waitFor(() => expect(bot.heldCount).toBe(1));
      bot.release();
      await vi.waitFor(() => expect(first.store.humanToMove.value).toBe(true));
    }
    play(first.controller, 'h5f7');
    await vi.waitFor(() => expect(first.store.plies.value[4].classification).toBeDefined());
    first.controller.runAction('showBest');
    const live = first.store.coach.value.lines;
    first.controller.runAction('backToGame');
    return { first, bot, live };
  }

  it('after a restart it analyses the position again and still explains the best move', async () => {
    const storage = new MemoryStorage();
    const { first, bot, live } = await blunderGame(storage);
    const ply = first.store.plies.value[4];
    expect(live[0]).not.toMatch(/^You played/);
    expect(live).toContain(`You played Qxf7+. ${ply.explanation!.headline}`);
    first.controller.dispose();
    bot.release();

    const bot2 = new ScriptedBot();
    bot2.manual = true;
    const second = setup({ bot: bot2, storage });
    await second.controller.boot();
    const s = second.store;
    second.controller.runAction('showBest');
    // At once: what the saved explanation says, while the engine looks at the position again.
    expect(s.coach.value.busy).toBe(true);
    expect(s.coach.value.title).toBe(`Best was ${ply.classification!.bestMoveSan}`);
    expect(s.coach.value.lines).toContain(`You played Qxf7+. ${ply.explanation!.headline}`);
    await vi.waitFor(() => expect(s.coach.value.busy).toBe(false));
    // Then the same explanation as before the restart.
    expect(s.coach.value.lines).toEqual(live);
    expect(vi.mocked(explainBestMove).mock.calls.some((c) => c[0] === ply.fenBefore)).toBe(true);
  });

  it('"Back" before the analysis is done: the late result is dropped', async () => {
    const storage = new MemoryStorage();
    const { first, bot } = await blunderGame(storage);
    first.controller.dispose();
    bot.release();
    const second = setup({ bot: new ScriptedBot(), storage });
    await second.controller.boot();
    const s = second.store;
    second.controller.runAction('showBest');
    expect(s.coach.value.busy).toBe(true);
    second.controller.runAction('backToGame');
    await second.controller.idle();
    expect(s.coachMode.value.kind).toBe('feedback');
    expect(s.coach.value.title).toMatch(/^3\. Qxf7\+ is a /);
    expect(s.isLive.value).toBe(true);
  });

  it('in the review of a restored finished game, too', async () => {
    const storage = new MemoryStorage();
    const { first, bot } = await blunderGame(storage);
    bot.release();
    await vi.waitFor(() => expect(first.store.plies.value).toHaveLength(6));
    first.controller.resign();
    await first.controller.startReview();
    first.controller.goTo(5);
    first.controller.runAction('showBest');
    const before = first.store.coach.value.lines;
    expect(before.length).toBeGreaterThan(1);
    first.controller.dispose();

    const second = setup({ bot: new ScriptedBot(), storage });
    await second.controller.boot();
    await second.controller.startReview();
    second.controller.goTo(5);
    second.controller.runAction('showBest');
    expect(second.store.coach.value.busy).toBe(true);
    await second.controller.idle();
    expect(second.store.coach.value.busy).toBe(false);
    expect(second.store.coach.value.lines).toEqual(before);
  });

  it('when the analysis finds no line for the best move, the saved explanation stays', async () => {
    const storage = new MemoryStorage();
    const { first, bot } = await blunderGame(storage);
    const ply = first.store.plies.value[4];
    first.controller.dispose();
    bot.release();
    const bot2 = new ScriptedBot();
    bot2.manual = true;
    const second = setup({ bot: bot2, storage });
    await second.controller.boot();
    vi.spyOn(AnalysisService.prototype, 'ensure').mockResolvedValueOnce({
      fen: ply.fenBefore,
      depth: 3,
      lines: [],
      bestMove: null,
      done: false,
      aborted: true,
    });
    second.controller.runAction('showBest');
    const shown = second.store.coach.value.lines;
    await vi.waitFor(() => expect(second.store.coach.value.busy).toBe(false));
    expect(second.store.coach.value.lines).toEqual(shown);
    expect(shown[0]).toBe(`You played Qxf7+. ${ply.explanation!.headline}`);
  });

  it('a missed tactic: the best move is explained once, not again after "You played"', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    controller.newGame(settings(), { startFen: '4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1' });
    expect(play(controller, 'e1f2')).toBe(true); // Kf2 misses Rxd5, winning a knight
    await controller.idle();
    const ply = store.plies.value[0];
    expect(ply.explanation?.motifs).toContain('missedTactic');
    expect(ply.explanation?.headline).toBe('You missed Rxd5, which wins a knight.');
    controller.runAction('showBest');
    const lines = store.coach.value.lines;
    expect(mentionsMove(lines[0], 'Rxd5')).toBe(true);
    expect(lines).toContain('You played Kf2.');
    expect(lines.some((l) => l.startsWith('You played Kf2. '))).toBe(false);
  });

  it('a missed mate: "You played X." without repeating the mate', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    controller.newGame(settings(), { startFen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1' });
    expect(play(controller, 'h2h3')).toBe(true); // misses Ra8#
    await controller.idle();
    expect(store.plies.value[0].explanation?.motifs).toContain('missedMate');
    controller.runAction('showBest');
    const lines = store.coach.value.lines;
    expect(mentionsMove(lines[0], 'Ra8#')).toBe(true);
    expect(lines.at(-1)).toBe('You played h3.');
  });
});
