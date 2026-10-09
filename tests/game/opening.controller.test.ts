/**
 * Opening practice in the controller and the store: `newGame(settings, { opening })` with a line of
 * the openings catalog, steered ('steer') or set up ('skip'); see src/game/opening.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { START_FEN } from '../../src/chess/utils';
import { GameController, type BotLike, type OpeningGameOptions } from '../../src/game/controller';
import { createEntitlements, type Entitlements } from '../../src/game/entitlements';
import { loadGame, loadSettings, saveGame, type SavedGame } from '../../src/game/persistence';
import { summarizeGame } from '../../src/game/review';
import { DEFAULT_SETTINGS, type GameSettings, type PromotionPiece } from '../../src/game/types';
import { getLine } from '../../src/openings/catalog';
import { openingsOpen, closeOpenings, currentPage, openOpenings } from '../../src/openings/session';
import { MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet } from '../helpers/fakeEngine';
import { FakePurchases } from './fakePurchases';

const NOW = new Date(2026, 9, 6, 12, 0, 0).getTime();
const controllers: GameController[] = [];

/** 1. e4 e5 2. Nf3 Nc6 3. Bc4 */
const ITALIAN = 'c50-italian-game';
/** 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 */
const TWO_KNIGHTS = 'c55-italian-game-two-knights-defense';
/** 1. f3 e5 2. g4 Qh4# (2. g4 is a known mistake). */
const FOOLS_MATE = 'a00-barnes-opening-fools-mate';
/** The London System guide's main line (not in the catalog): 1. d4 d5 2. Bf4 Nf6 3. e3 e6 4. Nf3 c5 ... 8. Bd3. */
const LONDON = {
  lineId: 'guide:London System',
  moves: ['d2d4', 'd7d5', 'c1f4', 'g8f6', 'e2e3', 'e7e6', 'g1f3', 'c7c5', 'c2c3', 'b8c6', 'b1d2', 'f8d6', 'f4g3', 'e8g8', 'f1d3'],
  name: 'London System',
  family: 'London System',
};

function setup(o: { bot?: BotLike; storage?: MemoryStorage; entitlements?: Entitlements } = {}) {
  const storage = o.storage ?? new MemoryStorage();
  const engines = fakeEngineSet();
  let n = 0;
  const controller = new GameController({
    createEngines: async () => engines.set,
    onlineEvents: null,
    storage,
    sound: new RecordingSound(),
    thinkDelay: false,
    now: () => NOW,
    createId: () => `game-${++n}-${Math.random().toString(36).slice(2, 6)}`,
    rng: () => 0.3,
    ...(o.bot ? { createBot: () => o.bot! } : {}),
    ...(o.entitlements ? { entitlements: o.entitlements } : {}),
  });
  controllers.push(controller);
  return { controller, store: controller.store, storage, engines };
}

const settings = (over: Partial<GameSettings> = {}): GameSettings => ({
  ...DEFAULT_SETTINGS,
  playerColor: 'w',
  botId: 'pip',
  botElo: 100,
  ...over,
});

const opening = (lineId: string, over: Partial<OpeningGameOptions> = {}): { opening: OpeningGameOptions } => ({
  opening: { lineId, mode: 'steer', showLineMoves: true, ...over },
});

function play(c: GameController, uci: string): boolean {
  return c.playerMove(uci.slice(0, 2), uci.slice(2, 4), uci[4] as PromotionPiece | undefined);
}

async function playAll(c: GameController, ucis: string[]): Promise<void> {
  for (const uci of ucis) {
    expect(play(c, uci), `move ${uci}`).toBe(true);
    await c.idle();
  }
}

const sans = (c: GameController) => c.store.plies.value.map((p) => p.san);
/** The coach's lines with plain spaces (move labels use no-break spaces: "2.\u00a0Nf3"). */
const coachLines = (c: GameController) => c.store.coach.value.lines.map((l) => l.replace(/\u00a0/g, ' '));

afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  closeOpenings();
  vi.restoreAllMocks();
});

describe('starting an opening game', () => {
  // First in this file: the catalog is not loaded yet, so the start waits for it.
  it('waits for the catalog when it is not loaded, and a newer game started meanwhile wins', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    const pending = controller.newGame(settings(), opening(ITALIAN));
    void controller.newGame(settings({ playerColor: 'b' }));
    expect(store.game.value?.opening).toBeUndefined();
    await pending;
    expect(store.game.value?.opening).toBeUndefined();
    expect(store.game.value?.playerColor).toBe('b');
    await controller.newGame(settings(), opening(ITALIAN));
    expect(store.game.value?.opening?.line.id).toBe(ITALIAN);
  });

  it('an unknown line starts a normal game, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    await controller.newGame(settings(), opening('no-such-line'));
    expect(store.phase.value).toBe('playing');
    expect(store.game.value?.opening).toBeUndefined();
    expect(store.game.value?.assisted).toBe(false);
    expect(store.openingPractice.value).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown opening line'), 'no-such-line');
  });

  it('is unrated from the start, with the Unrated pill', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    await controller.newGame(settings(), opening(ITALIAN));
    expect(store.game.value?.assisted).toBe(true);
    expect(store.bottomPlayer.value.unrated).toBe(true);
    expect(store.sheets.value.newGame.inProgress).toBeNull();
  });
});

describe('steer', () => {
  it('the bot plays the line, then its own moves once the line is complete', async () => {
    const bot = new ScriptedBot(['a7a6', 'h7h6', 'g8f6']);
    const { controller, store } = setup({ bot });
    await controller.boot();
    await controller.newGame(settings(), opening(ITALIAN));
    const v0 = store.openingPractice.value!;
    expect(v0).toMatchObject({ lineId: ITALIAN, name: 'Italian Game', family: 'Italian Game', status: 'on-line', moves: 3, move: 1 });
    expect(v0.nextMove).toMatchObject({ uci: 'e2e4', label: '1. e4', color: 'w' });
    expect(v0.statusText).toBe('Move 1 of 3');
    await playAll(controller, ['e2e4', 'g1f3']);
    // The bot's scripted moves (a6, h6) were not asked for: it played the line's e5 and Nc6.
    expect(sans(controller)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(bot.calls).toHaveLength(0);
    expect(store.openingPractice.value).toMatchObject({ status: 'on-line', move: 3, statusText: 'Move 3 of 3' });
    expect(store.openingPractice.value?.nextMove?.label).toBe('3. Bc4');
    await playAll(controller, ['f1c4']);
    expect(store.openingPractice.value).toMatchObject({ status: 'complete', completedAt: 4, statusText: 'Line complete' });
    // Line complete: the bot chooses (its scripted a6 is next).
    expect(bot.calls).toHaveLength(1);
    expect(bot.calls[0].history).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']);
    expect(sans(controller).at(-1)).toBe('a6');
  });

  it('the bot opens the line when you play Black', async () => {
    const bot = new ScriptedBot(['d2d4']);
    const { controller, store } = setup({ bot });
    await controller.boot();
    await controller.newGame(settings({ playerColor: 'b' }), opening(TWO_KNIGHTS));
    await controller.idle();
    expect(sans(controller)).toEqual(['e4']);
    expect(store.openingPractice.value?.nextMove?.label).toBe('1… e5');
    await playAll(controller, ['e7e5', 'b8c6']);
    expect(sans(controller)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    expect(bot.calls).toHaveLength(0);
  });

  it('plays the line through the real BotPlayer as book moves', async () => {
    const { controller, store } = setup();
    await controller.boot();
    await controller.newGame(settings({ playerColor: 'b' }), opening(ITALIAN));
    await controller.idle();
    expect(sans(controller)).toEqual(['e4']);
    await playAll(controller, ['e7e5', 'b8c6']);
    expect(sans(controller)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    expect(store.openingPractice.value?.status).toBe('complete');
  });

  it('stops steering when you leave the line, and says so once', async () => {
    const bot = new ScriptedBot(['g8f6', 'f8c5']);
    const { controller, store } = setup({ bot });
    await controller.boot();
    await controller.newGame(settings(), opening(ITALIAN));
    await playAll(controller, ['e2e4', 'b1c3']);
    expect(sans(controller)).toEqual(['e4', 'e5', 'Nc3', 'Nf6']);
    expect(bot.calls).toHaveLength(1);
    const v = store.openingPractice.value!;
    expect(v.status).toBe('left');
    expect(v.leftAt).toMatchObject({ index: 2, label: '2. Nc3', by: 'you' });
    expect(v.leftAt?.expected.label).toBe('2. Nf3');
    expect(v.statusText).toBe('Left at 2. Nc3');
    const note = 'You left the line at 2. Nc3 (the line continues 2. Nf3) — the game goes on normally.';
    expect(coachLines(controller)[0]).toBe(note);
    // Said once: gone after your next move.
    await playAll(controller, ['f1c4']);
    expect(coachLines(controller)).not.toContain(note);
    expect(store.openingPractice.value?.statusText).toBe('Left at 2. Nc3');
  });

  it('counts transpositions: back on the line by another move order, the bot follows it again', async () => {
    // 1. Nf3 Nc6 2. e4 e5 reaches the Two Knights line's position after 2... Nc6.
    const bot = new ScriptedBot(['b8c6', 'e7e5', 'a7a6']);
    const { controller, store } = setup({ bot });
    await controller.boot();
    await controller.newGame(settings(), opening(TWO_KNIGHTS));
    await playAll(controller, ['g1f3']);
    expect(store.openingPractice.value?.status).toBe('left');
    await playAll(controller, ['e2e4']);
    expect(sans(controller)).toEqual(['Nf3', 'Nc6', 'e4', 'e5']);
    expect(store.openingPractice.value).toMatchObject({ status: 'on-line', move: 3 });
    expect(store.openingPractice.value?.nextMove?.label).toBe('3. Bc4');
    await playAll(controller, ['f1c4']);
    // The line's 3... Nf6, not the bot's scripted a6.
    expect(sans(controller)).toEqual(['Nf3', 'Nc6', 'e4', 'e5', 'Bc4', 'Nf6']);
    expect(store.openingPractice.value?.status).toBe('complete');
  });

  it('an undo back onto the line resumes steering', async () => {
    const bot = new ScriptedBot(['g8f6']);
    const { controller, store } = setup({ bot });
    await controller.boot();
    await controller.newGame(settings(), opening(ITALIAN));
    await playAll(controller, ['e2e4', 'b1c3']);
    expect(store.openingPractice.value?.status).toBe('left');
    controller.requestUndo(); // unrated already: no question
    expect(store.sheet.value).toBeNull();
    expect(sans(controller)).toEqual(['e4', 'e5']);
    expect(store.openingPractice.value?.status).toBe('on-line');
    await playAll(controller, ['g1f3']);
    expect(sans(controller)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });

  it('a line move goes through the bot’s abort paths: hidden page, undo and new game', async () => {
    /** Holds each line move until `release()` (or its abort), like a book move's think time. */
    class LineBot extends ScriptedBot {
      readonly lineCalls: string[] = [];
      private waiting: { uci: string; done: (m: { uci: string; source: 'book'; thinkMs: number } | null) => void }[] = [];
      lineMove(_fen: string, _elo: number, uci: string, _history: string[], signal?: AbortSignal) {
        this.lineCalls.push(uci);
        return new Promise<{ uci: string; source: 'book'; thinkMs: number } | null>((resolve) => {
          this.waiting.push({ uci, done: resolve });
          signal?.addEventListener('abort', () => resolve(null), { once: true });
        });
      }
      releaseLine(): void {
        for (const w of this.waiting.splice(0)) w.done({ uci: w.uci, source: 'book', thinkMs: 0 });
      }
    }
    const bot = new LineBot();
    const { controller, store } = setup({ bot });
    await controller.boot();
    await controller.newGame(settings(), opening(ITALIAN));
    expect(play(controller, 'e2e4')).toBe(true);
    await vi.waitFor(() => expect(bot.lineCalls).toEqual(['e7e5']));
    expect(store.botThinking.value).toBe(true);

    // Hidden: the line move is aborted; visible again: asked again, then played.
    controller.onVisibilityChange(true);
    expect(store.botThinking.value).toBe(false);
    bot.releaseLine();
    await controller.idle();
    expect(sans(controller)).toEqual(['e4']);
    controller.onVisibilityChange(false);
    await vi.waitFor(() => expect(bot.lineCalls).toEqual(['e7e5', 'e7e5']));
    bot.releaseLine();
    await controller.idle();
    expect(sans(controller)).toEqual(['e4', 'e5']);

    // An undo while the bot is on its line move: nothing is played after it.
    expect(play(controller, 'g1f3')).toBe(true);
    await vi.waitFor(() => expect(bot.lineCalls).toHaveLength(3));
    controller.requestUndo();
    expect(sans(controller)).toEqual(['e4', 'e5']);
    bot.releaseLine();
    await controller.idle();
    expect(sans(controller)).toEqual(['e4', 'e5']);
    expect(store.humanToMove.value).toBe(true);

    // A new game (a normal one) while the bot is on its line move: the old game's move never lands.
    expect(play(controller, 'g1f3')).toBe(true);
    await vi.waitFor(() => expect(bot.lineCalls).toEqual(['e7e5', 'e7e5', 'b8c6', 'b8c6']));
    await controller.newGame(settings());
    bot.releaseLine();
    await controller.idle();
    expect(store.game.value?.opening).toBeUndefined();
    expect(store.openingPractice.value).toBeNull();
    expect(sans(controller)).toEqual([]);
  });

  it('shows the line move as a light arrow and a coach line on your turn only', async () => {
    const bot = new ScriptedBot();
    bot.manual = true;
    const { controller, store } = setup({ bot });
    await controller.boot();
    await controller.newGame(settings(), opening(ITALIAN));
    expect(store.board.value.arrows).toEqual([{ from: 'e2', to: 'e4', brush: 'line' }]);
    expect(coachLines(controller)[0]).toBe('Line move: 1. e4 — Italian Game');
    expect(store.coach.value.lines[1]).toContain('The arrow shows the line’s next move');
    expect(store.coach.value.title).toBe('Your move');
    play(controller, 'e2e4');
    // The bot's turn: no arrow, no line move.
    expect(store.board.value.arrows ?? []).toEqual([]);
    expect(store.coach.value.lines.join(' ')).not.toContain('Line move');
    await controller.idle();
    expect(store.board.value.arrows).toEqual([{ from: 'g1', to: 'f3', brush: 'line' }]);
    expect(coachLines(controller)[0]).toBe('Line move: 2. Nf3 — Italian Game');
    // Your first book move: what "book" means.
    expect(store.coach.value.lines.at(-1)).toBe('A “book” move is a well-known opening move that players have studied for years.');
    // Browsing earlier moves: no guide arrow.
    controller.goTo(0);
    expect(store.board.value.arrows ?? []).toEqual([]);
    controller.goTo(null);
    // Without showLineMoves: neither.
    await controller.newGame(settings(), opening(ITALIAN, { showLineMoves: false }));
    expect(store.board.value.arrows ?? []).toEqual([]);
    expect(store.coach.value.lines[0]).toBe('Pip follows the Italian Game line as long as you do.');
  });

  it('the banner is the coach panel’s "opening" action; it opens the line in Openings at the game’s move', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    await controller.newGame(settings(), opening(ITALIAN));
    const banner = store.coach.value.actions.find((a) => a.id === 'opening');
    expect(banner?.label).toBe('Italian Game\tMove 1 of 3\ton');
    expect(store.coach.value.paired).toBe(true);
    expect(openingsOpen.value).toBe(false);
    controller.runAction('opening');
    expect(openingsOpen.value).toBe(true);
    expect(currentPage.value).toMatchObject({ kind: 'line', lineId: ITALIAN, ply: 0 });
    expect(store.phase.value).toBe('playing');
    // On the line after 1. e4 e5: at that move.
    closeOpenings();
    await playAll(controller, ['e2e4']);
    controller.runAction('opening');
    expect(currentPage.value).toMatchObject({ kind: 'line', lineId: ITALIAN, ply: 2 });
    // Left at 2. Nc3: where the line went another way (before its 2. Nf3).
    closeOpenings();
    await playAll(controller, ['b1c3']);
    controller.runAction('opening');
    expect(currentPage.value).toMatchObject({ kind: 'line', lineId: ITALIAN, ply: 2 });
  });

  it('the game-over sheet and the PGN name the opening practice; rematch keeps it, a new game clears it', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    await controller.newGame(settings(), opening(ITALIAN));
    await playAll(controller, ['e2e4']);
    controller.resign();
    expect(store.sheets.value.gameOver?.practice).toBe('Italian Game');
    expect(store.ratingChange.value?.rated).toBe(false);
    expect(controller.exportPgn()).toContain('[Event "Opening practice: Italian Game"]');
    expect(store.coach.value.actions.map((a) => a.id)).toEqual(['opening', 'review', 'rematch', 'newGame']);
    controller.rematch();
    expect(store.game.value?.opening?.line.id).toBe(ITALIAN);
    expect(store.game.value?.opening?.showLineMoves).toBe(true);
    expect(store.game.value?.assisted).toBe(true);
    await controller.newGame(settings());
    expect(store.game.value?.opening).toBeUndefined();
    expect(store.openingPractice.value).toBeNull();
    expect(store.game.value?.assisted).toBe(false);
    expect(store.coach.value.actions.some((a) => a.id === 'opening')).toBe(false);
  });

  it('is saved with the game: a reload goes on steering; an older save loads as a normal game', async () => {
    const storage = new MemoryStorage();
    const bot1 = new ScriptedBot();
    bot1.manual = true;
    const first = setup({ bot: bot1, storage });
    await first.controller.boot();
    await first.controller.newGame(settings(), opening(ITALIAN));
    await playAll(first.controller, ['e2e4', 'g1f3']); // the line's e5 and Nc6 come at once
    play(first.controller, 'f1c4');
    const saved = loadGame(storage)!;
    expect(saved.opening).toEqual({ lineId: ITALIAN, mode: 'steer', showLineMoves: true });
    expect(saved.preplayed).toBeUndefined();
    first.controller.dispose();

    // Restored on the bot's turn after 1. e4 e5 2. Nf3: it goes on with the line.
    const storage2 = new MemoryStorage();
    saveGame({ ...saved, moves: ['e2e4', 'e7e5', 'g1f3'], annotations: {} }, storage2);
    const bot2 = new ScriptedBot(['a7a6']);
    const second = setup({ bot: bot2, storage: storage2 });
    await second.controller.boot();
    expect(second.store.game.value?.opening?.line.id).toBe(ITALIAN);
    await second.controller.idle();
    expect(sans(second.controller)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(bot2.calls).toHaveLength(0);
    expect(second.store.openingPractice.value?.status).toBe('on-line');

    // A save from before opening practice (no `opening`): a normal game.
    const { opening: _o, ...old } = saved;
    const storage3 = new MemoryStorage();
    saveGame({ ...old, moves: ['e2e4', 'e7e5', 'g1f3'], annotations: {} } as SavedGame, storage3);
    const bot3 = new ScriptedBot(['a7a6']);
    const third = setup({ bot: bot3, storage: storage3 });
    await third.controller.boot();
    await third.controller.idle();
    expect(third.store.game.value?.opening).toBeUndefined();
    expect(sans(third.controller)).toEqual(['e4', 'e5', 'Nf3', 'a6']);
  });
});

describe('a line from outside the catalog (an opening guide’s main line)', () => {
  const london = (over: Partial<OpeningGameOptions> = {}) =>
    opening(LONDON.lineId, { moves: LONDON.moves, name: LONDON.name, family: LONDON.family, ...over });

  it('follows exactly its moves under its opening’s name, is saved with them and restored without the catalog', async () => {
    const storage = new MemoryStorage();
    const bot1 = new ScriptedBot();
    const first = setup({ bot: bot1, storage });
    await first.controller.boot();
    await first.controller.newGame(settings(), london());
    const s = first.store;
    expect(s.openingPractice.value).toMatchObject({ lineId: LONDON.lineId, name: 'London System', family: 'London System', moves: 8, move: 1 });
    await playAll(first.controller, ['d2d4', 'c1f4', 'e2e3']);
    expect(sans(first.controller)).toEqual(['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6']);
    expect(bot1.calls).toHaveLength(0);
    expect(s.openingPractice.value?.statusText).toBe('Move 4 of 8');
    expect(coachLines(first.controller)[0]).toBe('Line move: 4. Nf3 — London System');
    expect(s.coach.value.actions.find((a) => a.id === 'opening')?.label).toBe('London System\tMove 4 of 8\ton');
    expect(first.controller.exportPgn()).toContain('[Event "Opening practice: London System"]');
    first.controller.runAction('opening');
    expect(currentPage.value).toMatchObject({ kind: 'line', lineId: LONDON.lineId, ply: 6 });
    play(first.controller, 'g1f3');
    const saved = loadGame(storage)!;
    expect(saved.opening).toEqual({ mode: 'steer', showLineMoves: true, ...LONDON });
    first.controller.dispose();

    // Restored on the bot's turn after 4. Nf3: it goes on with the line's 4... c5.
    const storage2 = new MemoryStorage();
    saveGame({ ...saved, moves: LONDON.moves.slice(0, 7), annotations: {} }, storage2);
    const bot2 = new ScriptedBot(['a7a6']);
    const second = setup({ bot: bot2, storage: storage2 });
    await second.controller.boot();
    await second.controller.idle();
    expect(second.store.game.value?.opening).toMatchObject({ custom: true, line: { id: LONDON.lineId, name: 'London System' } });
    expect(sans(second.controller).at(-1)).toBe('c5');
    expect(bot2.calls).toHaveLength(0);
  });

  it('starts after all its moves in "skip"; illegal moves start a normal game; a catalog id ignores the moves', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { controller, store } = setup({ bot: new ScriptedBot(['a7a6']) });
    await controller.boot();
    await controller.newGame(settings({ playerColor: 'b' }), london({ mode: 'skip' }));
    await controller.idle();
    expect(store.game.value?.preplayed).toBe(15);
    expect(sans(controller).slice(0, 15)).toEqual(['d4', 'd5', 'Bf4', 'Nf6', 'e3', 'e6', 'Nf3', 'c5', 'c3', 'Nc6', 'Nbd2', 'Bd6', 'Bg3', 'O-O', 'Bd3']);
    expect(store.openingPractice.value?.status).toBe('complete');
    await controller.newGame(settings(), london({ moves: ['d2d4', 'd2d4'] }));
    expect(store.game.value?.opening).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown opening line'), LONDON.lineId);
    await controller.newGame(settings(), opening(ITALIAN, { moves: LONDON.moves, name: 'London System' }));
    expect(store.game.value?.opening).toMatchObject({ line: { id: ITALIAN, name: 'Italian Game' } });
    expect(store.game.value?.opening?.custom).toBeUndefined();
  });
});

describe('the player’s defaults and lines that end the game', () => {
  it('keeps the player’s New game choices: an opening game’s side and opponent are not saved as defaults', async () => {
    const storage = new MemoryStorage();
    const { controller, store } = setup({ bot: new ScriptedBot(), storage });
    await controller.boot();
    await controller.newGame(settings({ playerColor: 'random', botId: 'custom', botElo: 800, adaptive: true }));
    await controller.newGame(
      settings({ playerColor: 'b', botId: 'custom', botElo: 1500, adaptive: false, sound: false }),
      opening('b90-sicilian-defense-najdorf-variation', { mode: 'skip' }),
    );
    expect(store.game.value).toMatchObject({ playerColor: 'b', botElo: 1500 });
    const defaults = { playerColor: 'random', botId: 'custom', botElo: 800, adaptive: true, sound: false };
    expect(store.settings.value).toMatchObject(defaults);
    expect(loadSettings(storage)).toMatchObject(defaults);
    expect(store.sheets.value.newGame.initial.playerColor).toBe('random');
    // A rematch is the same opening game (its side and opponent).
    controller.rematch();
    expect(store.game.value).toMatchObject({ playerColor: 'b', botElo: 1500 });
  });

  it('a line that ends in mate stops short in "skip", on your move: no game over before you move', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['a7a6']) });
    await controller.boot();
    const records = store.profile.value.history.length;
    // As White (1. f3 e5 2. g4 Qh4#): set up to 1. f3 e5, then you move.
    await controller.newGame(settings(), opening(FOOLS_MATE, { mode: 'skip' }));
    expect(sans(controller)).toEqual(['f3', 'e5']);
    expect(store.phase.value).toBe('playing');
    expect(store.humanToMove.value).toBe(true);
    // As Black: set up to 2. g4, and the mate is yours to find.
    await controller.newGame(settings({ playerColor: 'b' }), opening(FOOLS_MATE, { mode: 'skip' }));
    expect(sans(controller)).toEqual(['f3', 'e5', 'g4']);
    expect(store.humanToMove.value).toBe(true);
    expect(store.profile.value.history.length).toBe(records);
  });

  it('a line move that is a known mistake says so', async () => {
    const { controller } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    await controller.newGame(settings(), opening(FOOLS_MATE));
    await playAll(controller, ['f2f3']);
    expect(sans(controller)).toEqual(['f3', 'e5']);
    expect(coachLines(controller)[0]).toBe('Line move: 2. g4 — Barnes Opening (a known mistake: this line shows how it gets punished)');
  });
});

describe('the Openings section over a game', () => {
  it('a game the bot ends while the section is open shows its game-over sheet when the section closes', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5', 'd8h4']) });
    await controller.boot();
    await controller.newGame(settings());
    await playAll(controller, ['f2f3']);
    controller.openSheet('menu');
    openOpenings();
    await playAll(controller, ['g2g4']); // 2... Qh4#
    expect(store.phase.value).toBe('over');
    expect(store.outcome.value?.reason).toBe('Checkmate');
    // Not hidden under the section (where it would take the focus and Escape): it waits.
    expect(store.sheet.value).toBe('menu');
    expect(controller.canReloadNow({ hidden: true })).toBe(false);
    closeOpenings();
    expect(store.sheet.value).toBe('gameOver');
    expect(controller.canReloadNow({ hidden: true })).toBe(true);
  });

  it('a service-worker update never reloads the page under the open section', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    controller.closeSheet();
    expect(store.phase.value).toBe('setup');
    expect(controller.canReloadNow()).toBe(true);
    openOpenings();
    expect(controller.canReloadNow({ hidden: true })).toBe(false);
    closeOpenings();
    expect(controller.canReloadNow()).toBe(true);
  });
});

describe('with Pro locked (the App Store app before the purchase)', () => {
  it('playing an opening is free: the line, its arrow, the banner and the notes show; the coach’s "why" stays locked', async () => {
    const storage = new MemoryStorage();
    const entitlements = createEntitlements({ enabled: true, purchases: new FakePurchases(), storage });
    expect(entitlements.isAllowed('coachExplanations')).toBe(false);
    const { controller, store } = setup({ bot: new ScriptedBot(), storage, entitlements });
    await controller.boot();
    await controller.newGame(settings(), opening(ITALIAN));
    await playAll(controller, ['e2e4']);
    expect(sans(controller)).toEqual(['e4', 'e5']);
    expect(store.board.value.arrows).toEqual([{ from: 'g1', to: 'f3', brush: 'line' }]);
    expect(coachLines(controller)[0]).toBe('Line move: 2. Nf3 — Italian Game');
    expect(store.coach.value.actions.map((a) => a.id)).toEqual(['opening', 'unlock']);
    controller.runAction('opening');
    expect(openingsOpen.value).toBe(true);
    expect(entitlements.paywall.value.open).toBe(false);
  });
});

describe('skip', () => {
  it('starts with the line played as book moves; the bot replies when it is its turn', async () => {
    const bot = new ScriptedBot(['g8f6']);
    const { controller, store, engines } = setup({ bot });
    await controller.boot();
    await controller.newGame(settings(), opening(ITALIAN, { mode: 'skip' }));
    const g = store.game.value!;
    expect(g.startFen).toBe(START_FEN);
    expect(g.preplayed).toBe(5);
    expect(g.opening?.showLineMoves).toBe(false);
    expect(store.plies.value.slice(0, 5).every((p) => p.isBook && p.classification?.cls === 'book')).toBe(true);
    expect(store.plies.value[4].opening?.name).toBe('Italian Game');
    await controller.idle();
    // Black (the bot) was to move: it replied with its own move.
    expect(bot.calls).toHaveLength(1);
    expect(bot.calls[0].history).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']);
    expect(sans(controller)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6']);
    expect(store.openingPractice.value).toMatchObject({ status: 'complete', completedAt: 4, statusText: 'Line complete' });
    expect(store.coach.value.lines[0]).toBe('The moves of the Italian Game line are on the board. You’re on your own from here!');
    // The engine never analyzed the moves played before the game.
    const searched = new Set(engines.analysis.searches.map((x) => x.fen));
    for (const p of store.plies.value.slice(0, 4)) expect(searched.has(p.fenAfter)).toBe(false);
    expect(store.plies.value.slice(0, 5).every((p) => !p.explanation)).toBe(true);
    // The position after them got its eval when the bot's reply was annotated.
    expect(store.plies.value[4].evalWhite).toBeDefined();
    expect(store.plies.value[5].classification).toBeDefined();
  });

  it('you move first when the line ends on the bot’s move; nothing to undo, no abandoned loss', async () => {
    const bot = new ScriptedBot();
    const { controller, store } = setup({ bot });
    await controller.boot();
    await controller.newGame(settings({ playerColor: 'b' }), opening(ITALIAN, { mode: 'skip' }));
    await controller.idle();
    expect(bot.calls).toHaveLength(0);
    expect(store.humanToMove.value).toBe(true);
    expect(store.coach.value.title).toBe('Your move');
    expect(store.toolbar.value.undo.disabled).toBe(true);
    controller.requestUndo();
    expect(store.plies.value).toHaveLength(5);
    expect(store.sheets.value.newGame.inProgress).toBeNull();
    await controller.newGame(settings());
    expect(store.profile.value.history).toHaveLength(0);
  });

  it('a takeback stops at the moves the game started with', async () => {
    const bot = new ScriptedBot(['g8f6']);
    const { controller, store } = setup({ bot });
    await controller.boot();
    await controller.newGame(settings({ playerColor: 'b' }), opening(ITALIAN, { mode: 'skip' }));
    await playAll(controller, ['g8f6']);
    expect(store.plies.value).toHaveLength(7);
    controller.requestUndo();
    expect(store.plies.value).toHaveLength(5);
    expect(store.toolbar.value.undo.disabled).toBe(true);
  });

  it('PGN is a normal game from the initial position', async () => {
    const { controller } = setup({ bot: new ScriptedBot(['g8f6']) });
    await controller.boot();
    await controller.newGame(settings(), opening(ITALIAN, { mode: 'skip' }));
    await controller.idle();
    const pgn = controller.exportPgn();
    expect(pgn).not.toContain('[SetUp');
    expect(pgn).not.toContain('[FEN');
    expect(pgn).toContain('[Event "Opening practice: Italian Game"]');
    expect(pgn).toMatch(/^1\. e4 e5 2\. Nf3 Nc6 3\. Bc4 /m);
    expect(pgn).toContain('[PlyCount "6"]');
  });

  it('the review leaves the moves played before the game out of accuracy and counts', async () => {
    const bot = new ScriptedBot(['g8f6', 'f8c5']);
    const { controller, store } = setup({ bot });
    await controller.boot();
    await controller.newGame(settings(), opening(ITALIAN, { mode: 'skip' }));
    await controller.idle();
    await playAll(controller, ['d2d3']);
    controller.resign();
    await controller.startReview();
    const review = store.review.value!;
    const ps = store.plies.value;
    const expected = summarizeGame(ps[4].fenAfter, ps[4].evalWhite ?? null, ps.slice(5));
    expect(review.accuracy).toEqual(expected.accuracy);
    expect(review.counts).toEqual(expected.counts);
    const total = (c: Record<string, number | undefined>) => Object.values(c).reduce<number>((a, b) => a + (b ?? 0), 0);
    expect(total(review.counts.w)).toBe(1);
    expect(total(review.counts.b)).toBe(2);
    expect(review.keyMoments.every((k) => k.index >= 5)).toBe(true);
    // A move played before the game, in the review: what it is, no engine verdict.
    controller.goTo(5);
    expect(store.coach.value.title).toBe('3. Bc4 is a book move');
    expect(store.coach.value.lines[0]).toBe('This move was played for you before the game started: it is part of the Italian Game line.');
    expect(store.coach.value.cls).toBe('book');
  });

  it('is saved with its preplayed moves and restored as it was', async () => {
    const storage = new MemoryStorage();
    const bot1 = new ScriptedBot();
    bot1.manual = true;
    const first = setup({ bot: bot1, storage });
    await first.controller.boot();
    await first.controller.newGame(settings({ playerColor: 'b' }), opening(TWO_KNIGHTS, { mode: 'skip' }));
    const saved = loadGame(storage)!;
    expect(saved.preplayed).toBe(6);
    expect(saved.opening).toEqual({ lineId: TWO_KNIGHTS, mode: 'skip', showLineMoves: false });
    expect(saved.annotations[0]).toMatchObject({ isBook: true, classification: { cls: 'book' } });
    first.controller.dispose();

    const bot2 = new ScriptedBot(['d2d3']);
    const second = setup({ bot: bot2, storage });
    await second.controller.boot();
    await second.controller.idle();
    const s = second.store;
    expect(s.game.value?.preplayed).toBe(6);
    expect(s.game.value?.opening?.line.id).toBe(TWO_KNIGHTS);
    // White (the bot) to move after 3... Nf6: it replies.
    expect(sans(second.controller)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'd3']);
    // No verdict on a move played before the game.
    expect(s.coach.value.title).toBe('Your move');
    expect(s.coach.value.busy).toBe(false);
  });
});

describe('persistence of the target', () => {
  it('drops a malformed target and clamps preplayed', () => {
    const chess = new Chess();
    const moves = ['e2e4', 'e7e5'];
    for (const m of moves) chess.move({ from: m.slice(0, 2), to: m.slice(2, 4) });
    const base = {
      version: 1 as const,
      id: 'g',
      startFen: START_FEN,
      moves,
      playerColor: 'w' as const,
      botId: 'pip',
      botElo: 100,
      botName: 'Pip',
      assisted: true,
      startedAt: new Date(NOW).toISOString(),
      annotations: {},
    };
    const storage = new MemoryStorage();
    storage.setItem('chesscoach.game', JSON.stringify({ ...base, opening: { lineId: 7, mode: 'steer' }, preplayed: 9 }));
    const g = loadGame(storage)!;
    expect(g.opening).toBeUndefined();
    expect(g.preplayed).toBe(2);
    storage.setItem('chesscoach.game', JSON.stringify({ ...base, opening: { lineId: ITALIAN, mode: 'skip', showLineMoves: 'yes' }, preplayed: -1 }));
    const h = loadGame(storage)!;
    expect(h.opening).toEqual({ lineId: ITALIAN, mode: 'skip', showLineMoves: false });
    expect(h.preplayed).toBeUndefined();
    // A line saved with its moves keeps them only when they are UCI moves.
    const custom = { lineId: LONDON.lineId, mode: 'steer', showLineMoves: true, moves: ['d2d4', 'd7d5'], name: 'London System', family: 'London System' };
    storage.setItem('chesscoach.game', JSON.stringify({ ...base, opening: custom }));
    expect(loadGame(storage)!.opening).toEqual(custom);
    storage.setItem('chesscoach.game', JSON.stringify({ ...base, opening: { ...custom, moves: ['d4', 'd5'], name: 7 } }));
    expect(loadGame(storage)!.opening).toEqual({ lineId: LONDON.lineId, mode: 'steer', showLineMoves: true });
  });

  it('getLine resolves the test lines', () => {
    expect(getLine(ITALIAN)?.san).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    expect(getLine(TWO_KNIGHTS)?.san).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6']);
  });
});
