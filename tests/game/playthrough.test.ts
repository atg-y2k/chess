/**
 * Regression tests for the issues found in the play-through review (October 2026): rating
 * bookkeeping around "Set my level", rematches after a restart, the Menu's questions, takebacks
 * with the opponent's moves rated, an open hint across a restart, and the mid-game PGN.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameController, type BotLike, type ControllerDeps } from '../../src/game/controller';
import { loadGame } from '../../src/game/persistence';
import { DEFAULT_SETTINGS, type GameSettings, type PromotionPiece } from '../../src/game/types';
import { kFactor, loadProfile, saveProfile, defaultProfile, applyGameResult } from '../../src/rating/rating';
import type { PlayerProfile } from '../../src/rating/types';
import { MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet } from '../helpers/fakeEngine';

const NOW = new Date(2026, 9, 13, 12, 0, 0).getTime();
const controllers: GameController[] = [];

function setup(o: { bot?: BotLike; storage?: MemoryStorage; deps?: Partial<ControllerDeps> } = {}) {
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
    ...o.deps,
  });
  controllers.push(controller);
  return { controller, store: controller.store, storage };
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

async function playAll(c: GameController, ucis: string[]): Promise<void> {
  for (const uci of ucis) {
    expect(play(c, uci), `move ${uci}`).toBe(true);
    await c.idle();
  }
}

/** A profile at 834 after 4 rated games (as in the play-through), saved to `storage`. */
function seasonedProfile(storage: MemoryStorage): PlayerProfile {
  let p = defaultProfile();
  const results: (0 | 1)[] = [1, 0, 1, 0];
  results.forEach((score, i) => {
    p = applyGameResult(p, {
      id: `old-${i}`,
      date: '2026-10-01T10:00:00.000Z',
      playerColor: 'w',
      botName: 'Robot 800',
      botElo: 800,
      result: score ? '1-0' : '0-1',
      playerScore: score,
      rated: true,
      reason: score ? 'Checkmate' : 'Resignation',
      pgn: '',
    }).profile;
  });
  saveProfile(p, storage);
  return p;
}

afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  vi.restoreAllMocks();
});

describe('Set my level during a rated game', () => {
  it('the game still counts at the rating it was paired at; the level applies when it ends', async () => {
    const storage = new MemoryStorage();
    const before = seasonedProfile(storage);
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']), storage });
    await controller.boot();
    controller.newGame(settings({ botId: 'custom', botElo: 800, adaptive: true }));
    const botElo = store.game.value!.botElo;
    await playAll(controller, ['c2c4']);
    expect(store.sheets.value.menu.levelAfterGame).toBe(true);

    expect(controller.setStartingRating(1200)).toBe('afterGame');
    // Nothing changes until the game ends; the Menu says what is waiting.
    expect(store.profile.value.rating).toBe(before.rating);
    expect(store.profile.value.gamesPlayed).toBe(before.gamesPlayed);
    expect(store.sheets.value.menu.pendingLevel).toBe(1200);
    expect(loadGame(storage)?.pendingLevel).toBe(1200);

    controller.resign();
    const rc = store.ratingChange.value!;
    const k = kFactor(before.gamesPlayed);
    expect(rc.before).toBe(before.rating);
    expect(rc.before - rc.after).toBeLessThanOrEqual(Math.ceil(k));
    expect(rc.before - rc.after).toBeLessThan(100); // not −309
    expect(store.profile.value.history[0]).toMatchObject({ ratingBefore: before.rating, botElo, rated: true });
    // ...and then the chosen level, provisional again, with the peak left as it was earned.
    expect(store.profile.value.rating).toBe(1200);
    expect(store.profile.value.gamesPlayed).toBe(0);
    expect(store.profile.value.peak).toBe(before.peak);
    expect(store.pendingLevel.value).toBeNull();
    expect(loadProfile(storage).rating).toBe(1200);
  });

  it('a level chosen mid-game survives a restart, and "Resign & play" pairs the new game at it', async () => {
    const storage = new MemoryStorage();
    const before = seasonedProfile(storage);
    const first = setup({ bot: new ScriptedBot(['e7e5']), storage });
    await first.controller.boot();
    first.controller.newGame(settings({ botId: 'custom', botElo: 800, adaptive: true }));
    await playAll(first.controller, ['e2e4']);
    first.controller.setStartingRating(2000);
    first.controller.dispose();

    const second = setup({ bot: new ScriptedBot(['e7e5']), storage });
    await second.controller.boot();
    const s = second.store;
    expect(s.pendingLevel.value).toBe(2000);
    expect(s.sheets.value.newGame.playerRating).toBe(2000); // "Match my rating (2000)"
    const id = s.game.value!.id;
    second.controller.newGame(s.sheets.value.newGame.initial);
    const record = s.profile.value.history.find((r) => r.id === id)!;
    expect(record).toMatchObject({ reason: 'Abandoned', rated: true, ratingBefore: before.rating });
    expect(record.ratingBefore - record.ratingAfter).toBeLessThan(100);
    expect(s.profile.value.rating).toBe(2000);
    expect(s.game.value!.botElo).toBe(2000);
  });

  it('before the first move (or in an unrated game) the level applies at once', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings());
    expect(controller.setStartingRating(1600)).toBe('now');
    expect(store.profile.value.rating).toBe(1600);
    await playAll(controller, ['e2e4']);
    await controller.hint(); // unrated now
    expect(controller.setStartingRating(400)).toBe('now');
    expect(store.profile.value.rating).toBe(400);
  });
});

describe('Rematch after a restart', () => {
  it('keeps the opponent an opening game was started against (not the New game default)', async () => {
    const storage = new MemoryStorage();
    const first = setup({ bot: new ScriptedBot(['e7e5']), storage });
    await first.controller.boot();
    // The New game default is Match my rating...
    first.controller.newGame(settings({ botId: 'custom', botElo: 800, adaptive: true }));
    first.controller.resign();
    // ...and this game was against a custom 600, not rating-matched.
    await first.controller.newGame(settings({ botId: 'custom', botElo: 600, adaptive: false }), {
      opening: { lineId: 'guide:test', mode: 'steer', moves: ['e2e4', 'e7e5'], name: 'Test Opening', family: 'Test Opening' },
    });
    expect(first.store.game.value?.opening).toBeDefined();
    expect(first.store.settings.value.adaptive).toBe(true); // the defaults stay
    expect(first.store.game.value?.botElo).toBe(600);
    await playAll(first.controller, ['e2e4']);
    first.controller.resign();
    first.controller.dispose();

    const second = setup({ bot: new ScriptedBot(['e7e5']), storage });
    await second.controller.boot();
    expect(second.store.phase.value).toBe('over');
    expect(second.store.game.value?.settings.adaptive).toBe(false);
    second.controller.rematch();
    expect(second.store.game.value?.botElo).toBe(600);
  });
});

describe("the Menu's Rate opponent's moves question", () => {
  it('Cancel and Turn on both go back to the Menu', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    controller.openSheet('menu');
    controller.setSettings({ rateOpponent: true });
    expect(store.sheet.value).toBe('assist');
    controller.closeSheet();
    expect(store.sheet.value).toBe('menu');
    expect(store.settings.value.rateOpponent).toBe(false);
    expect(store.game.value?.assisted).toBe(false);

    controller.setSettings({ rateOpponent: true });
    controller.confirmAssist();
    expect(store.sheet.value).toBe('menu');
    expect(store.settings.value.rateOpponent).toBe(true);
    expect(store.game.value?.assisted).toBe(true);
  });

  it('a question asked from the board still closes to the board', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    controller.requestUndo();
    expect(store.sheet.value).toBe('assist');
    controller.closeSheet();
    expect(store.sheet.value).toBeNull();
  });
});

describe('Undo with the opponent rated', () => {
  it('shows both rows and your badge again, as before the move taken back', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['g7g6', 'h7h6', 'e7e6', 'b8c6']) });
    await controller.boot();
    controller.newGame(settings({ rateOpponent: true }));
    await playAll(controller, ['e2e4', 'g1f3', 'f1c4']);
    const coach = store.coach.value;
    const board = store.board.value;
    expect(coach.other).toBeDefined();
    await playAll(controller, ['c4b5']);
    controller.requestUndo(); // unrated already: no question
    expect(store.plies.value).toHaveLength(6);
    expect(store.coach.value.other).toEqual(coach.other);
    expect(store.coach.value.title).toBe(coach.title);
    expect(store.board.value.extraBadges).toEqual(board.extraBadges);
    expect(store.board.value.badge).toEqual(board.badge);
  });
});

describe('An open hint across a restart', () => {
  it('comes back on the same position', async () => {
    const storage = new MemoryStorage();
    const first = setup({ bot: new ScriptedBot(['e7e5']), storage });
    await first.controller.boot();
    first.controller.newGame(settings());
    await playAll(first.controller, ['e2e4']);
    first.controller.requestHint();
    first.controller.confirmAssist();
    await vi.waitFor(() => expect(first.store.coach.value.busy).toBe(false));
    expect(first.store.coach.value.kind).toBe('hint');
    const hint = first.store.coach.value.lines;
    expect(loadGame(storage)?.hint).toBeDefined();
    first.controller.dispose();

    const second = setup({ bot: new ScriptedBot(), storage });
    await second.controller.boot();
    await vi.waitFor(() => expect(second.store.coach.value.kind).toBe('hint'));
    await vi.waitFor(() => expect(second.store.coach.value.busy).toBe(false));
    expect(second.store.coach.value.lines).toEqual(hint);
    expect(second.store.sheet.value).toBeNull(); // nothing asked again
    // Dismissed, it is no longer saved.
    second.controller.requestHint();
    expect(loadGame(storage)?.hint).toBeUndefined();
  });
});

describe('PGN export during a rated game', () => {
  it("leaves out the computer's move marks until the game ends", async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5', 'd8h4']) });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4', 'g1f3']);
    const qh4 = store.plies.value[3];
    expect(qh4.san).toBe('Qh4');
    expect(['mistake', 'blunder']).toContain(qh4.classification?.cls);
    expect(store.game.value?.assisted).toBe(false);
    const during = controller.exportPgn();
    expect(during).toMatch(/2\.\.\.\s+Qh4\s+\{/);
    expect(during).not.toMatch(/Qh4 \$[24]/);
    controller.resign();
    expect(controller.exportPgn()).toMatch(/Qh4 \$[24]/);
  });
});

describe('threefold repetition the opponent completes', () => {
  it('the move that lets the opponent repeat is judged as the draw it is (not "best, mate in 2")', async () => {
    const start = 'rb3k2/p1pQ2pp/P1P3PP/6K1/8/8/8/8 w - - 0 1';
    const { controller, store } = setup({ bot: new ScriptedBot(['f8e7', 'e7f8', 'f8e7', 'e7f8']) });
    await controller.boot();
    await controller.newGame(settings(), { startFen: start });
    await playAll(controller, ['d7c8', 'c8d7', 'd7c8', 'c8d7']);
    expect(store.outcome.value?.reason).toBe('Threefold repetition');
    await controller.idle();
    const qd7 = store.plies.value[6];
    expect(qd7.san).toBe('Qd7+');
    expect(qd7.explanation?.headline).toBe('Qd7+ lets Pip repeat the position for the third time, which ends the game in a draw.');
    expect(qd7.evalWhite).toEqual({ kind: 'cp', value: 0 });
    expect(qd7.classification?.cls).not.toBe('best');
    expect(qd7.classification?.winAfter).toBe(0.5);
    // The forced reply that completes it is not to blame.
    expect(store.plies.value[7].explanation?.headline).toMatch(/repeats the position for the third time/);
    // No explanation runs an engine line through the third repetition.
    for (const p of store.plies.value) {
      expect([p.explanation?.headline, ...(p.explanation?.details ?? [])].join(' ')).not.toMatch(/Kf8 Qf7#/);
    }
  });
});

describe('the explorer: a repetition played for the computer’s side', () => {
  it('is said by color, not credited to the computer', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    // Rate opponent's moves on: unrated, so the explorer's engine turns on at once.
    await controller.newGame(settings({ rateOpponent: true }), { startFen: 'r3k1n1/8/8/8/8/8/8/4K1N1 w - - 0 1' });
    controller.requestExplore();
    if (!store.explorerEngine.value) controller.runExplorerAction('engine');
    expect(store.explorerEngine.value).toBe(true);
    for (const uci of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']) {
      expect(controller.explorerMove(uci.slice(0, 2), uci.slice(2, 4)), uci).toBe(true);
    }
    await controller.idle();
    expect(store.explorerDraw.value).toBe('Threefold repetition');
    const panel = store.explorerPanel.value!;
    expect(panel.lines[0]).toBe('Ng8 repeats the position for the third time, so the game is a draw.');
    expect(panel.lines.join(' ')).not.toMatch(/Pip|off the hook/);
    expect(panel.lines[1]).toBe('Black was winning, so this draw gives the win away.');
  });
});

describe('the coach off during play', () => {
  it('puts no rating dot on the graph for your moves (as on the board and the move list)', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5', 'g8f6', 'e8f7']) });
    await controller.boot();
    controller.newGame(settings({ coach: false }));
    await playAll(controller, ['e2e4', 'd1h5', 'h5f7']);
    expect(store.plies.value[4].classification?.cls).toBeDefined();
    expect(store.evalGraph.value.markers).toEqual([]);
    expect(store.coach.value.kind).toBe('minimal');
    // Not folded into one row by itself: the opening's whole name and the last move fit.
    expect(store.coach.value.collapsed).toBe(false);
    controller.resign();
    expect(store.evalGraph.value.markers?.length).toBeGreaterThan(0);
  });
});

describe('the finished game’s coach', () => {
  it('shows the deciding move’s verdict and the draw rule in plain words', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    await controller.newGame(settings(), { startFen: '8/k1P5/2K5/8/8/8/8/8 w - - 0 1' });
    expect(play(controller, 'c7c8q')).toBe(true);
    await controller.idle();
    expect(store.outcome.value?.reason).toBe('Stalemate');
    controller.closeSheet();
    const coach = store.coach.value;
    expect(coach.title).toBe('Draw');
    expect(coach.lines[0]).toBe('Stalemate: the side to move has no legal move and is not in check, so the game is a draw.');
    expect(coach.lines[1]).toMatch(/^1\. c8=Q /);
    expect(coach.lines.at(-1)).toBe('Review the game to see its key moments.');
    expect(coach.lines.join(' ')).not.toMatch(/won and lost/);
    expect(coach.index).toBe(0);
  });

  it('a resignation has no deciding move', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['e2e4']);
    controller.resign();
    expect(store.coach.value.lines).toEqual(['Resignation.', 'Review the game to see where it was won and lost.']);
  });
});

describe('the player strips after a promotion', () => {
  it('show no capture the opponent never made', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['g7g5', 'g8h6', 'f8g7', 'h8f8']) });
    await controller.boot();
    controller.newGame(settings());
    await playAll(controller, ['h2h4', 'h4g5', 'g5h6', 'h6g7', 'g7f8q']);
    // The bot (Black) took the new queen (Kxf8): a queen, not "a pawn" as the board alone would say.
    expect(store.plies.value[9].captured).toBe('q');
    expect(store.topPlayer.value.captured).toEqual(['q']);
    expect(store.bottomPlayer.value.captured).toEqual(['r', 'b', 'n', 'p']);
    // Before that reply, Black had captured nothing.
    controller.goTo(9);
    expect(store.topPlayer.value.captured).toEqual([]);
  });
});
