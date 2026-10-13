/**
 * The game viewer in the controller (game/viewer.ts, GameController `openGame` …): a finished game's
 * record keeps its compact analysis; an earlier game opens at its final position with its header,
 * steps, flips and draws, and never touches the game on the board or the rating; an older record
 * without analysis is analyzed by Review (with its progress) and keeps the result; Try again on its
 * key moments and back; Play from here (unrated, never abandoning a game in progress); the export;
 * a game that ends while the viewer is open; Pro.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { GameController, type BotLike } from '../../src/game/controller';
import { createEntitlements, type Entitlements } from '../../src/game/entitlements';
import { GAME_KEY } from '../../src/game/persistence';
import { practiceStartLine, type Store } from '../../src/game/store';
import { DEFAULT_SETTINGS, type GameSettings } from '../../src/game/types';
import { PROFILE_KEY, loadProfile } from '../../src/rating/rating';
import { MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet } from '../helpers/fakeEngine';
import { FakePurchases } from './fakePurchases';

const NOW = new Date(2026, 9, 13, 12, 0, 0).getTime();
const controllers: GameController[] = [];
const ents: Entitlements[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  for (const e of ents.splice(0)) e.dispose();
});

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

/** 1. e4 e5 2. Qh5 Nc6 3. Qxf7+?? Kxf7, resigned: a rated loss, every move checked. */
async function finished(o: { storage?: MemoryStorage; entitlements?: Entitlements; bot?: ScriptedBot } = {}) {
  const bot = o.bot ?? new ScriptedBot(['e7e5', 'b8c6', 'e8f7']);
  const s = setup({ bot, ...o });
  await s.controller.boot();
  s.controller.newGame(settings());
  for (const uci of ['e2e4', 'd1h5', 'h5f7']) {
    expect(s.controller.playerMove(uci.slice(0, 2), uci.slice(2, 4)), uci).toBe(true);
    await s.controller.idle();
  }
  s.controller.resign();
  await s.controller.idle();
  const id = s.store.game.value!.id;
  return { ...s, id, bot };
}

const FINAL = () => new Chess('r1bq1bnr/pppp1kpp/2n5/4p3/4P3/8/PPPP1PPP/RNB1KBNR w KQ - 0 4').fen();
const BEFORE_BLUNDER = () => new Chess('r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3').fen();

describe('the history keeps a finished game’s analysis', () => {
  it('compact, once every move is checked, with the opponent; saved with the profile', async () => {
    const { store, storage, id } = await finished();
    const r = store.profile.value.history.find((x) => x.id === id)!;
    expect(r).toMatchObject({ botId: 'pip', rated: true, reason: 'Resignation' });
    expect(r.analysis?.p.split(' ')).toHaveLength(6);
    expect(r.analysis?.p.split(' ')[4]).toMatch(/^b-?\d+:/); // the blunder, with its better move
    expect(r.analysis?.h?.['4']).toBe(store.plies.value[4].explanation?.headline);
    expect(r.accuracy).toBeTypeOf('number');
    expect(loadProfile(storage).history[0].analysis).toEqual(r.analysis);
  });
});

describe('the game viewer', () => {
  it('opens an earlier game at its final position; steps, flips and draws; the game on the board and the rating never change', async () => {
    const { controller, store, id } = await finished();
    // A new game, moved in: the viewer opens over it.
    controller.newGame(settings({ botId: 'rocco', botElo: 400 }));
    expect(controller.playerMove('d2', 'd4')).toBe(true);
    await controller.idle();
    const game = store.game.value;
    const plies = store.plies.value;
    const profile = store.profile.value;
    controller.openSheet('menu');
    expect(controller.openGame(id, { from: 'menu' })).toBe(true);
    let v = controller.viewerView.value!;
    expect(v.title).toBe('Lost to Pip'); // the Elo is on the opponent's strip
    expect(v.label).toMatch(/^Lost to Pip \(100\), /);
    expect(v.result).toBe('loss');
    expect(v.facts).toEqual(['Today', 'Resignation', expect.stringMatching(/^Accuracy \d+%$/)]);
    expect(v.rating).toMatchObject({ rated: true, sign: -1 });
    expect(v.missing).toBe(false);
    expect(v.board.fen).toBe(FINAL());
    expect(v.board.orientation).toBe('white');
    expect(v.board.dests.size).toBe(0);
    expect(v.board.movableColor).toBeUndefined();
    expect(v.board.session).toMatch(/^viewer:/);
    expect(v.moveList.plies.map((p) => p.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Qxf7+', 'Kxf7']);
    expect(v.moveList.current).toBe(6);
    expect(v.graph.points).toHaveLength(7);
    expect(v.graph.markers.map((m) => m.index)).toContain(5);
    expect(v.top).toMatchObject({ name: 'Pip', rating: 100 });
    expect(v.bottom).toMatchObject({ name: 'You', rating: 800 });
    // Play here would abandon the game in progress (moved in).
    expect(v.toolbar).toMatchObject({ prev: true, next: false, playHere: false, review: { label: 'Review', active: false } });
    // The comment on the last move, and on the blunder: while the rated game is on, its headline
    // without the better move, and a line that says why.
    expect(v.coach.title).toBe('Pip’s 3… Kxf7 is forced');
    controller.viewerGoTo(5);
    v = controller.viewerView.value!;
    const afterBlunder = new Chess(BEFORE_BLUNDER());
    afterBlunder.move('Qxf7+');
    expect(v.board.fen).toBe(afterBlunder.fen());
    expect(v.coach).toMatchObject({ title: '3. Qxf7+ is a blunder', cls: 'blunder' });
    expect(v.coach.lines[0]).toBe('Qxf7+ grabs a pawn, but it hangs your queen on f7.');
    expect(v.coach.lines.join(' ')).not.toMatch(/Best was|c4/);
    expect(v.coach.lines.at(-1)).toBe('Your rated game is still on: finish it to see the better moves here and to play from here.');
    expect(v.coach.actions).toEqual([]); // no Try again (nor Show best) while it is on
    expect(v.board.badge).toEqual({ square: 'f7', cls: 'blunder' });
    expect(v.board.arrows ?? []).toEqual([]);
    controller.viewerStep(-1);
    expect(controller.viewerView.value!.board.fen).toBe(BEFORE_BLUNDER());
    controller.viewerStep(-10);
    expect(controller.viewerView.value!.cursor).toBe(0);
    expect(controller.viewerView.value!.coach.title).toBe('Start position');
    controller.viewerFlip();
    expect(controller.viewerView.value!.board.orientation).toBe('black');
    expect(controller.viewerView.value!.top.name).toBe('You');
    // Draw mode on its own board, forgotten when it closes.
    controller.viewerToggleDraw();
    controller.viewerDrawShape({ orig: 'e2', dest: 'e4', brush: 'green' }, controller.viewerView.value!.board.fen);
    expect(controller.viewerView.value!.board.shapes).toHaveLength(1);
    expect(controller.viewerView.value!.draw).toMatchObject({ on: true, canClear: true });
    expect(store.drawings.value.size).toBe(0);
    // Nothing of the game on the board moved, nor the rating.
    expect(store.game.value).toBe(game);
    expect(store.plies.value).toBe(plies);
    expect(store.phase.value).toBe('playing');
    expect(store.profile.value.rating).toBe(profile.rating);
    expect(controller.canReloadNow()).toBe(false);
    // Back: the Menu it was opened from (still open under it).
    controller.closeGame();
    expect(store.viewer.value).toBeNull();
    expect(controller.viewerView.value).toBeNull();
    expect(store.sheet.value).toBe('menu');
    expect(controller.openGame('nope')).toBe(false);
  });

  it('an older record without analysis: Review analyzes it, with its progress, and the record keeps the result', async () => {
    const storage = new MemoryStorage();
    const first = await finished({ storage });
    first.controller.dispose();
    // As an older version saved it: no analysis, no accuracy, no opponent id; and no saved game.
    const saved = JSON.parse(storage.getItem(PROFILE_KEY)!);
    for (const r of saved.profile.history) {
      delete r.analysis;
      delete r.accuracy;
      delete r.botId;
    }
    storage.setItem(PROFILE_KEY, JSON.stringify(saved));
    storage.removeItem(GAME_KEY);
    const { controller, store } = setup({ storage });
    await controller.boot();
    expect(store.phase.value).toBe('setup');
    expect(controller.openGame(first.id)).toBe(true);
    let v = controller.viewerView.value!;
    expect(v.title).toBe('Lost to Pip');
    expect(v.facts).toEqual(['Today', 'Resignation']);
    expect(v.moveList.plies.every((p) => !p.classification)).toBe(true);
    expect(v.evalBar).toMatchObject({ off: true, offLabel: 'Not analyzed' });
    expect(v.coach.actions.map((a) => a.id)).toEqual(['review']);
    controller.viewerReview();
    v = controller.viewerView.value!;
    expect(v.report?.progress).toBe(0);
    expect(v.report?.accuracy).toEqual({ w: null, b: null });
    expect(v.toolbar.review).toMatchObject({ label: 'Report', active: true });
    await controller.idle();
    v = controller.viewerView.value!;
    expect(v.report?.progress).toBeNull();
    expect(v.report?.accuracy.w).toBeTypeOf('number');
    expect(v.moveList.plies[4].classification?.cls).toBe('blunder');
    expect(v.report?.keyMoments).toEqual([expect.objectContaining({ index: 4, tryAgain: true })]);
    expect(v.facts[2]).toMatch(/^Accuracy \d+%$/);
    const r = store.profile.value.history.find((x) => x.id === first.id)!;
    expect(r.analysis?.p.split(' ')).toHaveLength(6);
    expect(r.accuracy).toBeTypeOf('number');
    expect(loadProfile(storage).history[0].analysis).toEqual(r.analysis);
    // The rating and the screen behind it are as they were.
    expect(store.profile.value.rating).toBe(saved.profile.rating);
    expect(store.phase.value).toBe('setup');
    expect(store.game.value).toBeNull();
    // Review again: the report and the comment in turn. The blunder can be tried again: its better
    // move (and arrow) waits for Show best.
    controller.viewerReview();
    expect(controller.viewerView.value!.report).toBeNull();
    controller.viewerGoTo(5);
    expect(controller.viewerView.value!.board.arrows).toEqual([]);
    expect(controller.viewerView.value!.coach.actions.map((a) => a.id)).toEqual(['tryAgain', 'showBest']);
    controller.runViewerAction('showBest');
    expect(controller.viewerView.value!.board.arrows).toEqual([{ from: 'c2', to: 'c4', brush: 'best' }]);
    expect(controller.viewerView.value!.coach.lines.join(' ')).toMatch(/Best was c4/);
    expect(controller.viewerView.value!.coach.actions.map((a) => a.id)).toEqual(['tryAgain']);
  });

  it('Try again on a key moment: the try on the game screen, then back to the viewer as it was', async () => {
    const { controller, store, id } = await finished();
    controller.openSheet('menu');
    controller.openGame(id, { from: 'menu' });
    controller.viewerReview(); // already analyzed: no analysis to run
    expect(controller.viewerView.value!.report?.progress).toBeNull();
    controller.viewerGoTo(5);
    // Before the try, nothing names the better move (nor draws it).
    expect(controller.viewerView.value!.coach.actions.map((a) => a.id)).toEqual(['tryAgain', 'showBest']);
    expect(controller.viewerView.value!.coach.lines.join(' ')).not.toMatch(/Best was|c4/);
    expect(controller.viewerView.value!.board.arrows).toEqual([]);
    controller.runViewerAction('tryAgain');
    const p = store.practice.value!;
    expect(p).toMatchObject({ index: 4, status: 'waiting' });
    expect(p.game).toMatchObject({ id, source: 'archive' });
    expect(store.sheet.value).toBeNull(); // the Menu goes: the try is on the game screen
    expect(store.board.value.fen).toBe(BEFORE_BLUNDER());
    await controller.idle();
    controller.practiceShowAnswer();
    expect(store.coach.value.actions.find((a) => a.id === 'practiceExit')?.label).toBe('Back to review');
    controller.exitPractice();
    expect(store.practice.value).toBeNull();
    const v = controller.viewerView.value!;
    expect(v.cursor).toBe(5);
    // The answer was shown in the try: now the comment names it, with its arrow.
    expect(v.coach.lines.join(' ')).toMatch(/Best was c4/);
    expect(v.board.arrows).toEqual([{ from: 'c2', to: 'c4', brush: 'best' }]);
    // Back from the viewer: the Menu again.
    controller.closeGame();
    expect(store.sheet.value).toBe('menu');
  });

  it('Play from here: an unrated game from the position shown, the same opponent; never over a game in progress', async () => {
    const { controller, store, id } = await finished();
    const history = store.profile.value.history.map((r) => r.id);
    const defaults = store.settings.value;
    controller.openGame(id);
    controller.viewerGoTo(4);
    expect(controller.viewerPlayFromHere()).toBe('started');
    expect(store.viewer.value).toBeNull();
    expect(store.game.value).toMatchObject({ startFen: BEFORE_BLUNDER(), assisted: true, practice: { from: '3. Qxf7+' } });
    expect(store.game.value!.bot.id).toBe('pip');
    expect(store.settings.value).toEqual(defaults);
    expect(store.profile.value.history.map((r) => r.id)).toEqual(history);
    // A game moved in: Play from here would abandon it.
    expect(controller.playerMove('d2', 'd3')).toBe(true);
    await controller.idle();
    controller.openGame(id);
    expect(controller.viewerPlayFromHere()).toBe('inProgress');
    expect(store.viewer.value).not.toBeNull();
    controller.closeGame();
    // From the final position (no move follows): after the game's last move.
    controller.resign();
    await controller.idle();
    controller.openGame(id);
    expect(controller.viewerPlayFromHere()).toBe('started');
    expect(store.game.value).toMatchObject({ startFen: FINAL(), practice: { from: '3… Kxf7', after: true } });
    expect(practiceStartLine(store.game.value!.practice!)).toBe(
      'You’re playing on from your earlier game, after 3… Kxf7. This game is unrated.',
    );
  });

  it('exports the game’s PGN with the analysis', async () => {
    const { controller, id } = await finished();
    controller.openGame(id);
    const pgn = controller.viewerExportPgn();
    expect(pgn).toContain('[White "You"]');
    expect(pgn).toContain('[Black "Pip"]');
    expect(pgn).toContain('3. Qxf7+ $4 { [%eval');
    expect(pgn).toContain('0-1');
  });

  it('a game that ends while the viewer is open shows its game-over sheet once it closes', async () => {
    const storage = new MemoryStorage();
    const first = await finished({ storage, bot: new ScriptedBot(['e7e5', 'b8c6', 'e8f7', 'd8h4']) });
    const { controller, store } = first;
    // 1. f3 e5: the player's 2. g4 lets the bot mate (2… Qh4#).
    controller.newGame(settings(), { startFen: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2' });
    await controller.idle();
    expect(controller.playerMove('g2', 'g4')).toBe(true);
    controller.openGame(first.id);
    await controller.idle();
    expect(store.outcome.value?.reason).toBe('Checkmate');
    expect(store.sheet.value).toBeNull();
    expect(store.viewer.value).not.toBeNull();
    controller.closeGame();
    expect(store.sheet.value).toBe('gameOver');
  });
});

describe('the game viewer: Pro', () => {
  it('locked: the verdicts and the report’s numbers are free; the comments, key moments and Try again are not', async () => {
    const storage = new MemoryStorage();
    const purchases = new FakePurchases();
    const entitlements = createEntitlements({ enabled: true, purchases, storage });
    ents.push(entitlements);
    purchases.unlocked.resolve(false);
    purchases.product.resolve({ id: 'pro', title: 'Pro', description: '', displayPrice: '$9.99' });
    await new Promise((r) => setTimeout(r, 0));
    expect(entitlements.isAllowed('reviewDetails')).toBe(false);
    const { controller, id } = await finished({ entitlements, storage });
    controller.openGame(id);
    controller.viewerGoTo(5);
    let v = controller.viewerView.value!;
    expect(v.coach).toMatchObject({ title: '3. Qxf7+ is a blunder', cls: 'blunder' });
    expect(v.coach.lines).toEqual(['The coach can show you what went wrong here, and what was better.']);
    expect(v.coach.actions.map((a) => a.id)).toEqual(['unlock']);
    expect(v.moveList.plies[4].classification?.cls).toBe('blunder');
    controller.viewerReview();
    v = controller.viewerView.value!;
    expect(v.report?.keyMoments).toEqual([]);
    expect(v.report?.lockedMoments).toBeGreaterThan(0);
    expect(v.report?.accuracy.w).toBeTypeOf('number');
    expect(v.board.arrows ?? []).toEqual([]);
    expect(controller.viewerTryAgain(4)).toBe(false);
    expect(entitlements.paywall.value).toEqual({ open: true, feature: 'reviewDetails' });
    // Replay and export stay free.
    expect(controller.viewerExportPgn()).toContain('Qxf7+');
  });
});

/** The controller's own store, to set up a profile as an older or slimmed save would have it. */
const writable = (c: GameController): Store => (c as unknown as { s: Store }).s;

describe('the game viewer: fixes', () => {
  /** 1. e4 e5 2. Qh5 Nc6 3. Qxf7+ Kxf7, resigned at once while the last moves are still being checked. */
  async function resignedEarly(o: { storage?: MemoryStorage } = {}) {
    const bot = new ScriptedBot(['e7e5', 'b8c6', 'e8f7', 'e7e5']);
    const s = setup({ bot, ...o });
    await s.controller.boot();
    s.controller.newGame(settings());
    for (const uci of ['e2e4', 'd1h5']) {
      expect(s.controller.playerMove(uci.slice(0, 2), uci.slice(2, 4))).toBe(true);
      await s.controller.idle();
    }
    s.engines.analysis.delayMs = 30; // the annotations lag behind
    expect(s.controller.playerMove('h5', 'f7')).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    s.controller.resign();
    const id = s.store.game.value!.id;
    const checked = s.store.plies.value.filter((p) => p.classification).length;
    return { ...s, id, checked };
  }

  it('the game that just ended: the viewer follows its late verdicts, and closing it never erases them', async () => {
    const { controller, store, storage, id, checked } = await resignedEarly();
    expect(checked).toBeLessThan(6);
    controller.openSheet('menu');
    expect(controller.openGame(id, { from: 'menu' })).toBe(true);
    await controller.idle();
    const full = store.profile.value.history.find((r) => r.id === id)!.analysis!;
    expect(full.p.split(' ').every((t) => !t.startsWith('-'))).toBe(true);
    // The viewer shows them too (its last move is no longer "not checked").
    const v = controller.viewerView.value!;
    expect(v.moveList.plies.every((p) => !!p.classification || p.index === 5)).toBe(true);
    expect(v.coach.lines).not.toContain('The coach hasn’t checked this game yet.');
    controller.closeGame();
    expect(store.profile.value.history.find((r) => r.id === id)!.analysis).toEqual(full);
    expect(loadProfile(storage).history[0].analysis).toEqual(full);
  });

  it('a Rematch before every move is checked keeps the verdicts the game has so far', async () => {
    const { controller, store, storage, id, checked } = await resignedEarly();
    expect(checked).toBeGreaterThan(0);
    controller.rematch();
    const r = store.profile.value.history.find((x) => x.id === id)!;
    const tokens = r.analysis!.p.split(' ');
    expect(tokens).toHaveLength(6);
    expect(tokens.filter((t) => !t.startsWith('-'))).toHaveLength(checked);
    expect(tokens.at(-1)).toMatch(/^-/);
    expect(r.accuracy).toBeUndefined(); // the accuracy waits for every move
    expect(loadProfile(storage).history.find((x) => x.id === id)!.analysis).toEqual(r.analysis);
    // The viewer's Review fills in the rest.
    await controller.idle();
    controller.resign(); // (nothing moved yet: dropped)
    controller.openGame(id);
    controller.viewerReview();
    await controller.idle();
    const after = store.profile.value.history.find((x) => x.id === id)!;
    expect(after.analysis!.p.split(' ').every((t) => !t.startsWith('-'))).toBe(true);
    expect(after.accuracy).toBeTypeOf('number');
  });

  it('the header’s accuracy is the report’s once every move is checked (and the record follows)', async () => {
    const { controller, store, id } = await finished();
    // An older figure in the record (e.g. from before some moves could be checked).
    const profile = store.profile.value;
    writable(controller).profile.value = { ...profile, history: profile.history.map((r) => (r.id === id ? { ...r, accuracy: 12.3 } : r)) };
    controller.openGame(id);
    const v = controller.viewerView.value!;
    expect(v.facts).not.toContain('Accuracy 12%');
    controller.viewerReview();
    const shown = controller.viewerView.value!.report!.accuracy.w!;
    expect(controller.viewerView.value!.facts).toContain(`Accuracy ${Math.round(shown)}%`);
    controller.closeGame();
    expect(store.profile.value.history.find((r) => r.id === id)!.accuracy).toBe(Math.round(shown * 10) / 10);
  });

  it('a game with no moves (resigned before the first): nothing to play from', async () => {
    const { controller, store } = setup();
    await controller.boot();
    controller.newGame(settings());
    controller.resign();
    await controller.idle();
    const id = store.profile.value.history[0].id;
    expect(controller.openGame(id)).toBe(true);
    const v = controller.viewerView.value!;
    expect(v.plies).toBe(0);
    expect(v.toolbar.playHere).toBe(false);
    expect(controller.viewerPlayFromHere()).toBe('none');
    expect(store.viewer.value).not.toBeNull();
  });

  it('a game kept with only its verdicts: the coach writes the comment on a move again when it is shown', async () => {
    const storage = new MemoryStorage();
    const first = await finished({ storage });
    const original = first.store.plies.value[4].explanation!; // the whole comment, as the game had it
    first.controller.dispose();
    storage.removeItem(GAME_KEY); // a later session: the game is only in the history
    const { controller, store } = setup({ storage });
    await controller.boot();
    expect(store.phase.value).toBe('setup');
    controller.openGame(first.id);
    expect(store.viewer.value!.game!.plies[4].explanation).toEqual({ headline: original.headline, details: [] });
    controller.viewerGoTo(5); // 3. Qxf7+, a key moment: only its headline was kept
    expect(controller.viewerView.value!.coach.busy).toBe(true);
    await controller.idle();
    const v = controller.viewerView.value!;
    expect(v.coach.busy).toBe(false);
    expect(store.viewer.value!.brief.has(4)).toBe(false);
    // The same comment as in the session the game was played in.
    expect(store.viewer.value!.game!.plies[4].explanation).toEqual(original);
    expect(v.coach.lines[0]).toBe(original.headline);
    // Not again for a move already written (nor for a book move).
    controller.viewerGoTo(4);
    controller.viewerGoTo(5);
    expect(controller.viewerView.value!.coach.busy).toBe(false);
  });

  it('while a rated game is on: no new analysis, no Try again, no better moves', async () => {
    const storage = new MemoryStorage();
    const first = await finished({ storage });
    const { controller, store, id } = first;
    controller.newGame(settings({ botId: 'rocco', botElo: 400 }));
    await controller.idle();
    expect(store.game.value!.assisted).toBe(false);
    // Its analysis dropped (as a full storage would): Review would need the engine.
    const profile = store.profile.value;
    writable(controller).profile.value = {
      ...profile,
      history: profile.history.map((r) => {
        if (r.id !== id) return r;
        const { analysis: _a, ...rest } = r;
        return rest;
      }),
    };
    controller.openGame(id);
    let v = controller.viewerView.value!;
    expect(v.toolbar.review.disabled).toBe(true);
    expect(v.coach.actions).toEqual([]);
    controller.viewerReview();
    expect(store.viewer.value!.review).toBeNull();
    expect(controller.viewerTryAgain(4)).toBe(false);
    expect(store.practice.value).toBeNull();
    expect(store.game.value!.assisted).toBe(false);
    // Before the player's first move, Play here is still offered (the game would simply be dropped).
    expect(v.toolbar.playHere).toBe(true);
    expect(v.coach.lines.at(-1)).toBe('Your rated game is still on, so the better moves stay hidden here until it’s over.');
    controller.closeGame();
  });
});

describe('Try again: its own board', () => {
  it('Flip turns the try’s board only; a try from the viewer starts as the viewer’s board', async () => {
    const { controller, store, id } = await finished();
    controller.newGame(settings({ showBestMoves: true })); // unrated: an earlier game’s moves can be tried
    expect(controller.playerMove('e2', 'e4')).toBe(true);
    await controller.idle();
    controller.openSheet('menu');
    controller.openGame(id, { from: 'menu' });
    controller.viewerFlip();
    expect(controller.viewerTryAgain(4)).toBe(true);
    expect(store.board.value.orientation).toBe('black');
    expect(store.topPlayer.value.name).toBe('You');
    controller.flip();
    expect(store.board.value.orientation).toBe('white');
    expect(store.flipped.value).toBe(false); // the game's own board did not turn
    controller.exitPractice();
    controller.closeGame();
    expect(store.flipped.value).toBe(false);
    expect(store.board.value.orientation).toBe('white');
  });
});
