/**
 * "Can you punish it?" (rateOpponent): after the opponent's mistake, miss or blunder the player is
 * asked to find the punishment. Until the player moves or taps "Show me", the opponent's row shows
 * only its verdict and the question (no explanation, Show best, best-move arrow or threat alert that
 * points at it); then its feedback comes back, and the player's own adds "You punished it!" or "The
 * punishment was Nxh4, which wins the queen." With Retry, Undo, the coach off, a hint, threat
 * alerts, Pro locked, and a restored game.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { effect } from '@preact/signals';
import { Chess } from 'chess.js';
import type { ThreatAlert } from '../../src/analysis/threat';
import { PUNISHED_LINE, punishPrompt, punishWithLine, punishmentOf, punishmentWasLine } from '../../src/game/coach';
import { GameController, type BotLike } from '../../src/game/controller';
import { createEntitlements, type Entitlements } from '../../src/game/entitlements';
import { GAME_KEY, loadGame, sanitizeSavedGame } from '../../src/game/persistence';
import { annotationKey } from '../../src/game/store';
import { DEFAULT_SETTINGS, type GameSettings, type PromotionPiece } from '../../src/game/types';
import { MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet, scoreMoves } from '../helpers/fakeEngine';
import { FakePurchases } from './fakePurchases';

const PROMPT = 'Pip blundered — can you punish it?';
const SHOWN = 'Punish it with Nxh4, which wins the queen.';
const WAS = 'The punishment was Nxh4, which wins the queen.';

const controllers: GameController[] = [];
const ents: Entitlements[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  for (const e of ents.splice(0)) e.dispose();
});

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
    ...(o.bot ? { createBot: () => o.bot! } : {}),
    ...(o.entitlements ? { entitlements: o.entitlements } : {}),
  });
  controllers.push(controller);
  await controller.boot();
  return { controller, store: controller.store, storage, engines };
}

const settings = (over: Partial<GameSettings> = {}): GameSettings => ({
  ...DEFAULT_SETTINGS,
  playerColor: 'w',
  botId: 'pip',
  botElo: 100,
  rateOpponent: true,
  ...over,
});

const move = (c: GameController, uci: string) =>
  c.playerMove(uci.slice(0, 2), uci.slice(2, 4), uci[4] as PromotionPiece | undefined);

async function play(c: GameController, ucis: string[]): Promise<void> {
  for (const uci of ucis) {
    expect(move(c, uci), uci).toBe(true);
    await c.idle();
  }
}

/** Waits (a few macrotasks at a time) until `ok()`; for a bot reply held on purpose, where `idle()` would wait for ever. */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(ok()).toBe(true);
}

/** 1.e4 e5 2.Nf3 Qh4?? (the bot's blunder): you are to move. `then` = the bot's later replies. */
async function blunder(over: Partial<GameSettings> = {}, then: string[] = ['b8c6'], o: { entitlements?: Entitlements; storage?: MemoryStorage } = {}) {
  const bot = new ScriptedBot(['e7e5', 'd8h4', ...then]);
  const s = await setup({ bot, ...o });
  s.controller.newGame(settings(over));
  await play(s.controller, ['e2e4', 'g1f3']);
  expect(s.store.plies.value.map((p) => p.san)).toEqual(['e4', 'e5', 'Nf3', 'Qh4']);
  expect(s.store.plies.value[3].classification?.cls).toBe('blunder');
  return { ...s, bot };
}

describe('the punishment: wording', () => {
  it('the question names no move; Show me and the answer after the move do', () => {
    expect(punishPrompt('Pip', 'blunder')).toBe(PROMPT);
    expect(punishPrompt('Pip', 'mistake')).toBe('Pip made a mistake — can you punish it?');
    expect(punishPrompt('Pip', 'miss')).toBe('Pip missed its chance — can you punish it?');
    expect(punishWithLine({ san: 'Nxh4', reason: 'wins the queen' })).toBe(SHOWN);
    expect(punishWithLine({ san: 'Nxh4', reason: null })).toBe('Punish it with Nxh4.');
    expect(punishmentWasLine('Nxh4', 'wins the queen')).toBe(WAS);
    expect(punishmentWasLine('Bb5', 'pins the knight, which can’t move')).toBe('The punishment was Bb5: it pins the knight, which can’t move.');
    // From the engine's lines of the position after the mistake.
    const fen = new Chess('rnb1kbnr/pppp1ppp/8/4p3/4P2q/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3').fen();
    const lines = scoreMoves(fen).slice(0, 3).map((x, i) => ({ multipv: i + 1, depth: 14, score: x.score, pv: x.pv }));
    expect(punishmentOf(fen, lines)).toEqual({ uci: 'f3h4', san: 'Nxh4', reason: 'wins the queen' });
    expect(punishmentOf(fen, [])).toBeNull();
  });
});

describe('the punishment: during play', () => {
  it('hidden until "Show me": only the verdict and the question, no best-move arrow; then the answer, its arrow and the feedback', async () => {
    const { controller, store } = await blunder({ showBestMoves: true });
    const c = store.coach.value;
    expect(c).toMatchObject({ title: 'Pip’s 2… Qh4 is a blunder', cls: 'blunder', subject: 'opponent', lines: [PROMPT] });
    expect(c.actions).toEqual([{ id: 'showPunishment', label: 'Show me' }]);
    expect(store.punishView.value).toMatchObject({ hidden: true, punishment: { uci: 'f3h4', san: 'Nxh4', reason: 'wins the queen' } });
    // The verdict, icon and badge are free; nothing on the board names Nxh4.
    expect(store.board.value.badge).toEqual({ square: 'h4', cls: 'blunder' });
    expect(store.board.value.arrows ?? []).toEqual([]);
    // Browsing back to it says no more.
    controller.goTo(4);
    expect(store.coach.value.lines).toEqual([PROMPT]);
    controller.goTo(null);

    controller.runAction('showPunishment');
    expect(store.punishView.value?.hidden).toBe(false);
    const shown = store.coach.value;
    expect(shown.lines[0]).toBe(SHOWN);
    expect(shown.lines.length).toBeGreaterThan(1);
    expect(shown.actions.map((a) => a.id)).toEqual(['showBest']);
    expect(store.board.value.arrows).toEqual(expect.arrayContaining([{ from: 'f3', to: 'h4', brush: 'best' }]));
  });

  it('no best-move arrow names the punishment while the opponent’s move is still being rated', async () => {
    const bot = new ScriptedBot(['e7e5', 'd8h4', 'b8c6']);
    const { controller, store, engines } = await setup({ bot });
    controller.newGame(settings({ showBestMoves: true }));
    await play(controller, ['e2e4']);
    engines.analysis.delayMs = 15; // the verdict on 2… Qh4 takes a while
    const seen: string[] = [];
    const stop = effect(() => {
      const b = store.board.value;
      const cls = store.plies.value[3]?.classification?.cls ?? '-';
      for (const a of b.arrows ?? []) if (a.brush === 'best') seen.push(`${a.from}${a.to}@${cls}`);
    });
    expect(move(controller, 'g1f3')).toBe(true);
    await controller.idle();
    stop();
    expect(store.plies.value[3].classification?.cls).toBe('blunder');
    expect(seen.filter((a) => a.startsWith('f3h4'))).toEqual([]);
    expect(store.punishView.value?.hidden).toBe(true);
  });

  it('a hint (the best move) reveals it too', async () => {
    const { controller, store } = await blunder();
    await controller.hint();
    expect(store.coachMode.value.kind).toBe('hint');
    expect(store.punishView.value?.hidden).toBe(false);
    controller.dismissHint();
    expect(store.coach.value.lines[0]).toBe(SHOWN);
  });

  it('your move punishes it: "You punished it!", with your move’s feedback kept open', async () => {
    const { controller, store } = await blunder();
    await play(controller, ['f3h4']);
    const c = store.coach.value;
    expect(c).toMatchObject({ subject: 'you', title: '3. Nxh4 is the best move' });
    expect(c.lines[0]).toBe(PUNISHED_LINE);
    expect(c.other).toMatchObject({ subject: 'opponent', move: '3… Nc6' });
  });

  it('your move misses it: "The punishment was Nxh4, which wins the queen.", said once', async () => {
    // (Pip then saves its queen: no new question.)
    const { controller, store } = await blunder({ allowTakebacks: false }, ['h4e7']);
    await play(controller, ['b1c3']);
    const c = store.coach.value;
    expect(c).toMatchObject({ subject: 'you', title: '3. Nc3 is a miss' });
    expect(c.lines[0]).toBe(WAS);
    expect(c.lines.filter((l) => l.includes('Nxh4'))).toEqual([WAS]);
  });

  it('your miss, then Pip’s new mistake: its question is the open one; your move’s feedback (picked) names no answer to it', async () => {
    // 3. Nc3 misses Nxh4; 3… Nc6 leaves the queen hanging again (a new question, the same answer).
    const { controller, store } = await blunder({ allowTakebacks: true });
    await play(controller, ['b1c3']);
    expect(store.plies.value.map((p) => p.san)).toEqual(['e4', 'e5', 'Nf3', 'Qh4', 'Nc3', 'Nc6']);
    expect(store.punishView.value).toMatchObject({ hidden: true, ply: { index: 5 }, punishment: { uci: 'f3h4' } });
    const ask = store.coach.value;
    expect(ask).toMatchObject({ subject: 'opponent', index: 5, verdict: 'Punish it?' });
    expect(ask.lines).toEqual([punishPrompt('Pip', store.plies.value[5].classification!.cls)]);
    expect(ask.actions.map((a) => a.id)).toEqual(['showPunishment']);
    expect(ask.other).toMatchObject({ subject: 'you', move: '3. Nc3' });
    // Your miss, picked: Retry is there; Show best (it would draw Nxh4) and every line naming it wait.
    controller.selectCoachFeedback('you');
    const mine = store.coach.value;
    expect(mine).toMatchObject({ subject: 'you', title: '3. Nc3 is a miss' });
    expect(mine.lines.join(' ')).not.toContain('Nxh4');
    expect(mine.lines.join(' ')).not.toContain('can you punish it');
    expect(mine.actions.map((a) => a.id)).toEqual(['retry']);
    expect(mine.other).toMatchObject({ subject: 'opponent', verdict: 'Punish it?' });
    expect(store.board.value.arrows ?? []).toEqual([]);
  });

  it('after Show me, the opponent’s move (with the answer) stays the open one over your own miss', async () => {
    const { controller, store } = await blunder({ allowTakebacks: true });
    await play(controller, ['b1c3']);
    expect(store.coach.value).toMatchObject({ subject: 'opponent', index: 5 });
    controller.runAction('showPunishment');
    const shown = store.coach.value;
    expect(shown).toMatchObject({ subject: 'opponent', index: 5, verdict: 'Blunder' });
    expect(shown.lines[0]).toBe(SHOWN);
    expect(shown.other).toMatchObject({ subject: 'you', move: '3. Nc3' });
  });

  it('while you see the opponent’s feedback before its reply (here held), it is whole; with the coach off, the answer is said there', async () => {
    const { controller, store, bot } = await blunder({ coach: false });
    expect(store.coach.value).toMatchObject({ subject: 'opponent', lines: [PROMPT] });
    bot.manual = true;
    expect(move(controller, 'f3h4')).toBe(true);
    await until(() => !!store.plies.value[4]?.classification);
    const c = store.coach.value;
    expect(c).toMatchObject({ subject: 'opponent', titleMove: 'Pip’s 2… Qh4' });
    expect(c.lines.at(-1)).toBe(PUNISHED_LINE);
    expect(c.lines.length).toBeGreaterThan(1);
  });

  it('with Retry offered: nothing names the punishment (yours, the opponent’s row, its Show best); Retry asks again', async () => {
    const { controller, store, bot } = await blunder({ allowTakebacks: true });
    bot.manual = true;
    expect(move(controller, 'b1c3')).toBe(true);
    await until(() => !!store.plies.value[4]?.classification);
    const mine = store.coach.value;
    expect(mine).toMatchObject({ subject: 'you', title: '3. Nc3 is a miss' });
    expect(mine.actions.map((a) => a.id)).toContain('retry');
    expect(mine.lines.join(' ')).not.toContain('Nxh4');
    expect(mine.lines[0]).toMatch(/^You missed/);
    // The opponent's blunder, opened: its text without Nxh4, and no Show best on it.
    controller.selectCoachFeedback('opponent');
    const theirs = store.coach.value;
    expect(theirs).toMatchObject({ subject: 'opponent', titleMove: 'Pip’s 2… Qh4' });
    expect(theirs.lines.join(' ')).not.toContain('Nxh4');
    expect(theirs.actions.map((a) => a.id)).not.toContain('showBest');
    // Retry: back before your move, and the question again (never shown).
    controller.runAction('retry');
    controller.confirmAssist();
    expect(store.plies.value).toHaveLength(4);
    expect(store.punishView.value?.hidden).toBe(true);
    expect(store.coach.value.lines[0]).toBe('Find a better move than Nc3.');
  });

  it('Undo brings the question back, hidden again unless "Show me" was used for it', async () => {
    const { controller, store } = await blunder({ allowTakebacks: true }, ['b8c6', 'b8c6']);
    await play(controller, ['f3h4']);
    controller.undo();
    expect(store.plies.value).toHaveLength(4);
    expect(store.coach.value.lines).toEqual([PROMPT]);
    controller.runAction('showPunishment');
    await play(controller, ['f3h4']);
    controller.undo();
    expect(store.punishView.value?.hidden).toBe(false);
    expect(store.coach.value.lines[0]).toBe(SHOWN);
  });

  it('a new game forgets what was shown; a restored game asks again, with its punishment kept', async () => {
    const storage = new MemoryStorage();
    const first = await blunder({}, ['b8c6'], { storage });
    first.controller.runAction('showPunishment');
    const saved = loadGame(storage)!;
    expect(saved.annotations[3].punishment).toEqual({ uci: 'f3h4', san: 'Nxh4', reason: 'wins the queen' });
    // A malformed one is dropped (older saves have none).
    const raw = JSON.parse(storage.getItem(GAME_KEY)!);
    raw.annotations[3].punishment = { uci: 'zz', san: 'Nxh4', reason: 3 };
    expect(sanitizeSavedGame(raw)!.annotations[3].punishment).toBeUndefined();
    const second = await setup({ bot: new ScriptedBot([]), storage });
    expect(second.store.plies.value).toHaveLength(4);
    expect(second.store.punishView.value).toMatchObject({ hidden: true, punishment: { san: 'Nxh4' } });
    expect(second.store.coach.value.lines).toEqual([PROMPT]);
    first.controller.newGame(settings());
    expect(first.store.punishReveal.value).toBeNull();
  });

  it('without the opponent’s ratings (or in a rated game) nothing is asked', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5', 'd8h4']) });
    controller.newGame(settings({ rateOpponent: false }));
    await play(controller, ['e2e4', 'g1f3']);
    expect(store.punishView.value).toBeNull();
    expect(store.coach.value.lines).not.toContain(PROMPT);
  });
});

describe('the punishment and threat alerts', () => {
  it('a threat alert that points at the punishment waits until it is found; one elsewhere shows', async () => {
    const { store, controller } = await blunder({ threatAlerts: true });
    const fen = store.liveFen.value;
    const alert = (squares: string[]): ThreatAlert => ({
      fen,
      uci: 'h4f2',
      san: 'Qxf2+',
      kind: 'material',
      text: 'Pip threatens Qxf2+, which wins a pawn.',
      arrows: [{ from: 'h4', to: 'f2', brush: 'threat' }],
      squares,
    });
    const threat = store.threat as unknown as { value: ThreatAlert | null };
    threat.value = alert(['h4', 'f2']); // h4: the square Nxh4 takes on
    expect(store.threatAlert.value).toBeNull();
    expect(store.coach.value.alert).toBeUndefined();
    expect((store.board.value.arrows ?? []).some((a) => a.brush === 'threat')).toBe(false);
    threat.value = alert(['a7', 'b8']);
    expect(store.threatAlert.value).not.toBeNull();
    expect(store.coach.value.alert).toBe('Pip threatens Qxf2+, which wins a pawn.');
    threat.value = alert(['h4', 'f2']);
    controller.runAction('showPunishment');
    expect(store.coach.value.alert).toBe('Pip threatens Qxf2+, which wins a pawn.');
  });

  it('with the opponent’s moves rated, an alert shows before the verdict on its move unless it touches the best reply', async () => {
    const bot = new ScriptedBot(['e7e5']);
    bot.manual = true;
    const { controller, store, engines } = await setup({ bot });
    engines.analysis.delayMs = 5;
    controller.newGame(settings({ threatAlerts: true }));
    expect(move(controller, 'e2e4')).toBe(true);
    await until(() => bot.heldCount === 1);
    bot.release();
    await until(() => store.plies.value.length === 2);
    const threat = store.threat as unknown as { value: ThreatAlert | null };
    const fake: ThreatAlert = { fen: store.liveFen.value, uci: 'd8h4', san: 'Qh4', kind: 'material', text: 'Pip threatens something.', arrows: [], squares: ['d8', 'h4'] };
    threat.value = fake;
    expect(store.plies.value[1].classification).toBeUndefined();
    // Without the probe's best reply, it waits for the verdict (it might point at a punishment)…
    expect(store.threatAlert.value).toBeNull();
    // …and with it, only when it touches it.
    threat.value = { ...fake, best: 'g1h3' };
    expect(store.threatAlert.value?.text).toBe('Pip threatens something.');
    threat.value = { ...fake, best: 'g2g3', squares: ['d8', 'h4', 'g3'] };
    expect(store.threatAlert.value).toBeNull();
    await until(() => !!store.plies.value[1].classification);
    await controller.idle();
    threat.value = fake; // (the real probe found nothing here)
    expect(store.threatAlert.value?.text).toBe('Pip threatens something.');
  });
});

describe('the punishment: Pro', () => {
  it('locked: the question is free, "Show me" opens the paywall; after your move, no move is named', async () => {
    const storage = new MemoryStorage();
    const purchases = new FakePurchases();
    const entitlements = createEntitlements({ enabled: true, purchases, storage });
    ents.push(entitlements);
    purchases.unlocked.resolve(false);
    purchases.product.resolve({ id: 'pro', title: 'Pro', description: '', displayPrice: '$9.99' });
    const { controller, store } = await blunder({ allowTakebacks: false }, ['h4e7'], { entitlements, storage });
    expect(store.coach.value.lines).toEqual([PROMPT]);
    expect(store.coach.value.actions).toEqual([{ id: 'showPunishment', label: 'Show me', locked: true }]);
    controller.runAction('showPunishment');
    expect(entitlements.paywall.value).toEqual({ open: true, feature: 'showBest' });
    expect(store.punishView.value?.hidden).toBe(true);
    entitlements.closePaywall();
    await play(controller, ['b1c3']);
    const c = store.coach.value;
    expect(c).toMatchObject({ subject: 'you' });
    expect(c.lines[0]).toBe('You missed the punishment.');
    expect(c.lines.join(' ')).not.toContain('Nxh4');
    // Punished: said, as a label is (free).
    const again = await blunder({}, ['b8c6'], { entitlements, storage: new MemoryStorage() });
    await play(again.controller, ['f3h4']);
    expect(again.store.coach.value.lines[0]).toBe(PUNISHED_LINE);
    expect(annotationKey('x', again.store.plies.value[3])).toContain('|3|');
  });
});
