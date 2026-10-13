/**
 * Threat alerts (GameSettings.threatAlerts) in the controller and the store: the setting (saved, and
 * older settings without it load with it off), the rated-game rules (unrated from the start, or after
 * a confirmation; a question asked from the Menu goes back to it), Pro, the probe after the bot's move
 * (the coach's warning and the threat arrow), its budget, a check position, the alert never shown for
 * another position (the player's move, a takeback that brings it back from memory), and none in the
 * explorer or the review.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { nullMoveFen } from '../../src/analysis/motifs';
import { THREAT_DEPTH, THREAT_NODES } from '../../src/analysis/threat';
import { fenKey } from '../../src/chess/utils';
import type { PvLine } from '../../src/engine/types';
import { GameController, type BotLike } from '../../src/game/controller';
import { PRO_CACHE_KEY, createEntitlements, type Entitlements } from '../../src/game/entitlements';
import { SETTINGS_KEY, loadSettings, saveSettings } from '../../src/game/persistence';
import { DEFAULT_SETTINGS, type GameSettings, type PromotionPiece } from '../../src/game/types';
import { MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet } from '../helpers/fakeEngine';
import { FakePurchases } from './fakePurchases';

const after = (sans: string[]): string => {
  const c = new Chess();
  for (const san of sans) c.move(san);
  return c.fen();
};

/** The Two Knights before 4.Ng5 (White, the bot, to move) and after it (you, Black, to move). */
const BEFORE_NG5 = after(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6']);
const AFTER_NG5 = after(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5']);
const NULL_NG5 = nullMoveFen(AFTER_NG5)!;
const FORK = 'Pip threatens Nxf7, forking your queen and rook.';
const line = (cp: number, pv: string[]): PvLine => ({ multipv: 1, depth: 14, score: { kind: 'cp', value: cp }, pv });

const controllers: GameController[] = [];
const ents: Entitlements[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  for (const e of ents.splice(0)) e.dispose();
});

async function setup(o: { bot?: BotLike; storage?: MemoryStorage; entitlements?: Entitlements } = {}) {
  const storage = o.storage ?? new MemoryStorage();
  const engines = fakeEngineSet();
  // The engine's view of 4.Ng5: quiet for Black to move, Nxf7 when White moves again.
  engines.analysis.fixed.set(fenKey(AFTER_NG5), [line(-40, ['d7d5', 'e4d5'])]);
  engines.analysis.fixed.set(fenKey(NULL_NG5), [line(320, ['g5f7', 'd8e7', 'f7h8'])]);
  let n = 0;
  const controller = new GameController({
    createEngines: async () => engines.set,
    onlineEvents: null,
    storage,
    sound: new RecordingSound(),
    thinkDelay: false,
    createId: () => `game-${++n}`,
    rng: () => 0.3,
    ...(o.bot ? { createBot: () => o.bot! } : {}),
    ...(o.entitlements ? { entitlements: o.entitlements } : {}),
  });
  controllers.push(controller);
  await controller.boot();
  return { controller, store: controller.store, storage, engines };
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

describe('threat alerts: the setting', () => {
  it('is off by default and saved; older settings without it load with it off', () => {
    expect(DEFAULT_SETTINGS.threatAlerts).toBe(false);
    const storage = new MemoryStorage();
    // An older save: every other setting, no threatAlerts.
    const { threatAlerts: _none, ...older } = { ...DEFAULT_SETTINGS, coach: false };
    storage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, settings: older }));
    expect(loadSettings(storage)).toEqual({ ...DEFAULT_SETTINGS, coach: false, threatAlerts: false });
    saveSettings({ ...DEFAULT_SETTINGS, threatAlerts: true }, storage);
    expect(loadSettings(storage).threatAlerts).toBe(true);
    storage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, settings: { ...DEFAULT_SETTINGS, threatAlerts: 'yes' } }));
    expect(loadSettings(storage).threatAlerts).toBe(false);
  });
});

describe('threat alerts: in a game', () => {
  it('after the bot’s move that threatens: the coach’s warning and the threat arrow, from two small searches', async () => {
    const bot = new ScriptedBot(['f3g5']);
    const { controller, store, engines } = await setup({ bot });
    controller.newGame(settings({ threatAlerts: true }), { startFen: BEFORE_NG5 });
    // A game with them on is unrated from the start.
    expect(store.game.value!.assisted).toBe(true);
    expect(store.bottomPlayer.value.unrated).toBe(true);
    await controller.idle();
    expect(store.plies.value.map((p) => p.san)).toEqual(['Ng5']);
    expect(store.threatAlert.value).toMatchObject({ fen: AFTER_NG5, text: FORK, kind: 'material' });
    expect(store.coach.value.alert).toBe(FORK);
    // Only the opponent's threat is named, never a defense (…d5 is the engine's move here).
    expect(store.coach.value.alert).not.toMatch(/d5/);
    expect(store.board.value.arrows).toEqual(expect.arrayContaining([{ from: 'g5', to: 'f7', brush: 'threat' }]));
    // The probe's searches: the position and its null move, one line each, within the budget.
    const probes = engines.analysis.searches.filter((x) => fenKey(x.fen) === fenKey(NULL_NG5));
    expect(probes.length).toBeGreaterThan(0);
    for (const x of probes) expect(x.opts).toMatchObject({ depth: THREAT_DEPTH, nodes: THREAT_NODES, multiPv: 1 });
    expect(
      engines.analysis.searches.some((x) => fenKey(x.fen) === fenKey(AFTER_NG5) && x.opts.nodes === THREAT_NODES && x.opts.multiPv === 1),
    ).toBe(true);
  });

  it('never stale: gone with your move, back from memory after a takeback (nothing searched again)', async () => {
    const bot = new ScriptedBot(['f3g5', 'e4d5']);
    const { controller, store, engines } = await setup({ bot });
    controller.newGame(settings({ threatAlerts: true, allowTakebacks: true }), { startFen: BEFORE_NG5 });
    await controller.idle();
    expect(store.coach.value.alert).toBe(FORK);
    expect(move(controller, 'd7d5')).toBe(true);
    // At once, before anything else is known.
    expect(store.threatAlert.value).toBeNull();
    expect(store.coach.value.alert).toBeUndefined();
    expect((store.board.value.arrows ?? []).some((a) => a.brush === 'threat')).toBe(false);
    await controller.idle();
    const searched = engines.analysis.searches.length;
    controller.undo();
    expect(fenKey(store.liveFen.value)).toBe(fenKey(AFTER_NG5));
    await controller.idle();
    expect(store.coach.value.alert).toBe(FORK);
    expect(engines.analysis.searches.slice(searched).some((x) => fenKey(x.fen) === fenKey(NULL_NG5))).toBe(false);
  });

  it('switched off: gone at once; on again in the same (unrated) game: no question, and back', async () => {
    const bot = new ScriptedBot(['f3g5']);
    const { controller, store } = await setup({ bot });
    controller.newGame(settings({ threatAlerts: true }), { startFen: BEFORE_NG5 });
    await controller.idle();
    controller.setSettings({ threatAlerts: false });
    expect(store.coach.value.alert).toBeUndefined();
    controller.setSettings({ threatAlerts: true });
    expect(store.sheet.value).toBeNull();
    await controller.idle();
    expect(store.coach.value.alert).toBe(FORK);
  });

  it('none in a check position (no null move there), in the explorer, or after the game', async () => {
    // 1.e4 f5 2.Qh5+: you (Black) are in check.
    const bot = new ScriptedBot(['d1h5']);
    const { controller, store, engines } = await setup({ bot });
    controller.newGame(settings({ threatAlerts: true }), { startFen: after(['e4', 'f5']) });
    await controller.idle();
    expect(store.position.value.check).toBe(true);
    expect(store.threat.value).toBeNull();
    expect(engines.analysis.searches.some((x) => x.opts.nodes === THREAT_NODES)).toBe(false);

    const bot2 = new ScriptedBot(['f3g5']);
    const second = await setup({ bot: bot2 });
    second.controller.newGame(settings({ threatAlerts: true }), { startFen: BEFORE_NG5 });
    await second.controller.idle();
    expect(second.store.coach.value.alert).toBe(FORK);
    second.controller.requestExplore();
    expect(second.store.explorer.value).not.toBeNull();
    expect(second.store.threatAlert.value).toBeNull();
    expect((second.store.board.value.arrows ?? []).some((a) => a.brush === 'threat')).toBe(false);
    second.controller.exitExplorer();
    expect(second.store.threatAlert.value?.text).toBe(FORK);
    // Browsing an earlier move: not the live position.
    second.controller.goTo(0);
    expect(second.store.coach.value.alert).toBeUndefined();
    second.controller.goTo(null);
    second.controller.resign();
    expect(second.store.coach.value.alert).toBeUndefined();
    await second.controller.startReview();
    expect(second.store.coach.value.alert).toBeUndefined();
    expect(second.store.threatAlert.value).toBeNull();
  });
});

describe('threat alerts: rated games', () => {
  it('switching them on in a rated game asks first: Cancel keeps it rated, Turn on makes it unrated (and is saved)', async () => {
    const bot = new ScriptedBot(['e7e5']);
    const { controller, store, storage } = await setup({ bot });
    controller.newGame(settings({ playerColor: 'w' }));
    await controller.idle();
    expect(move(controller, 'e2e4')).toBe(true);
    await controller.idle();
    expect(store.game.value!.assisted).toBe(false);
    controller.setSettings({ threatAlerts: true });
    expect(store.sheet.value).toBe('assist');
    expect(store.sheets.value.assist).toEqual({ kind: 'threatAlerts' });
    expect(store.settings.value.threatAlerts).toBe(false);
    controller.closeSheet();
    expect(store.settings.value.threatAlerts).toBe(false);
    expect(store.game.value!.assisted).toBe(false);
    // Asked from the Menu: either answer goes back to it.
    controller.openSheet('menu');
    controller.setSettings({ threatAlerts: true });
    expect(store.pendingAssist.value).toEqual({ kind: 'threatAlerts', returnTo: 'menu' });
    controller.confirmAssist();
    expect(store.sheet.value).toBe('menu');
    expect(store.settings.value.threatAlerts).toBe(true);
    expect(store.game.value!.assisted).toBe(true);
    expect(JSON.parse(storage.getItem(SETTINGS_KEY)!).settings.threatAlerts).toBe(true);
    // The next game (a rematch too) is unrated from the start.
    controller.resign();
    controller.rematch();
    expect(store.game.value!.assisted).toBe(true);
  });

  it('after the game, or before any game, they switch on at once', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.setSettings({ threatAlerts: true });
    expect(store.sheet.value).not.toBe('assist');
    expect(store.settings.value.threatAlerts).toBe(true);
    controller.setSettings({ threatAlerts: false });
    controller.newGame(settings({ playerColor: 'w' }));
    expect(move(controller, 'e2e4')).toBe(true);
    await controller.idle();
    controller.resign();
    controller.setSettings({ threatAlerts: true });
    expect(store.pendingAssist.value).toBeNull();
    expect(store.settings.value.threatAlerts).toBe(true);
  });

  it('a rated game never shows one, whatever the probe holds', async () => {
    const bot = new ScriptedBot(['f3g5']);
    const { controller, store } = await setup({ bot });
    controller.newGame(settings(), { startFen: BEFORE_NG5 });
    await controller.idle();
    expect(store.game.value!.assisted).toBe(false);
    expect(store.threat.value).toBeNull(); // not even probed
    (store.threat as unknown as { value: unknown }).value = { fen: AFTER_NG5, text: FORK, arrows: [], squares: [], uci: 'g5f7', san: 'Nxf7', kind: 'material' };
    (store.settings as unknown as { value: GameSettings }).value = { ...store.settings.value, threatAlerts: true };
    expect(store.threatAlert.value).toBeNull();
    expect(store.coach.value.alert).toBeUndefined();
  });
});

describe('threat alerts: Pro', () => {
  async function locked(cached = false) {
    const storage = new MemoryStorage();
    if (cached) storage.setItem(PRO_CACHE_KEY, '1');
    const purchases = new FakePurchases();
    const entitlements = createEntitlements({ enabled: true, purchases, storage });
    ents.push(entitlements);
    purchases.unlocked.resolve(cached);
    purchases.product.resolve({ id: 'pro', title: 'Pro', description: '', displayPrice: '$9.99' });
    const bot = new ScriptedBot(['f3g5', 'f3g5']);
    return { ...(await setup({ bot, storage, entitlements })), entitlements, purchases };
  }

  it('locked: switching them on opens the paywall (no question, the game stays rated); a new game starts without them', async () => {
    const { controller, store, entitlements } = await locked();
    expect(entitlements.isAllowed('threatAlerts')).toBe(false);
    controller.newGame(settings({ threatAlerts: true }), { startFen: BEFORE_NG5 });
    expect(store.settings.value.threatAlerts).toBe(false);
    expect(store.game.value!.assisted).toBe(false);
    await controller.idle();
    expect(store.threat.value).toBeNull();
    controller.setSettings({ threatAlerts: true });
    expect(entitlements.paywall.value).toEqual({ open: true, feature: 'threatAlerts' });
    expect(store.settings.value.threatAlerts).toBe(false);
    expect(store.sheet.value).not.toBe('assist');
    expect(store.game.value!.assisted).toBe(false);
  });

  it('a refund switches them off', async () => {
    const { controller, store, entitlements, purchases } = await locked(true);
    expect(entitlements.isAllowed('threatAlerts')).toBe(true);
    controller.newGame(settings({ threatAlerts: true }), { startFen: BEFORE_NG5 });
    await controller.idle();
    expect(store.coach.value.alert).toBe(FORK);
    purchases.emit(false);
    expect(store.settings.value.threatAlerts).toBe(false);
    expect(store.coach.value.alert).toBeUndefined();
    expect((store.board.value.arrows ?? []).some((a) => a.brush === 'threat')).toBe(false);
  });

  it('a refund while “Turn on threat alerts?” is open drops the question', async () => {
    const { controller, store, purchases } = await locked(true);
    controller.newGame(settings({ playerColor: 'w' }));
    expect(move(controller, 'e2e4')).toBe(true);
    await controller.idle();
    controller.setSettings({ threatAlerts: true });
    expect(store.pendingAssist.value).toEqual({ kind: 'threatAlerts' });
    purchases.emit(false);
    expect(store.sheet.value).toBeNull();
    expect(store.pendingAssist.value).toBeNull();
    controller.confirmAssist(); // a late tap: nothing asked any more
    expect(store.game.value!.assisted).toBe(false);
    expect(store.settings.value.threatAlerts).toBe(false);
  });
});
