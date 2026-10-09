/**
 * "Rate opponent's moves" (GameSettings.rateOpponent): the opponent's moves rated during play like
 * yours (board badge, move-list icon, graph marker, the coach's verdict in the third person, Show
 * best), the coach panel's two rows, the rated-game rules (unrated from the start, or after a
 * confirmation), and the Pro gating (labels free, explanations and Show best locked). The review
 * is unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { signal } from '@preact/signals';
import { Chess } from 'chess.js';
import type { Classification, MoveClass } from '../../src/analysis/types';
import { personaById } from '../../src/bot/personas';
import { START_FEN } from '../../src/chess/utils';
import { lockedTeaser, UNLOCK_LABEL } from '../../src/game/coach';
import { GameController, type BotLike } from '../../src/game/controller';
import { createEntitlements, type Entitlements, type ProFeature } from '../../src/game/entitlements';
import { SETTINGS_KEY } from '../../src/game/persistence';
import { annotationKey, createState, createStore, type CoachMode, type Phase } from '../../src/game/store';
import { DEFAULT_SETTINGS, type GameSettings, type Ply, type PromotionPiece } from '../../src/game/types';
import { defaultProfile } from '../../src/rating/rating';
import { MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet } from '../helpers/fakeEngine';
import { FakePurchases } from './fakePurchases';

// -------------------------------------------------------------------------------------------------
// The store's view models, from a fixed annotated game: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nd4 (you are White).

const SANS = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nd4'];
const CLASSES: MoveClass[] = ['book', 'book', 'best', 'good', 'inaccuracy', 'mistake'];
/** The engine's better move, where the played one was not it. */
const BEST: Record<number, [string, string]> = { 3: ['b8c6', 'Nc6'], 4: ['d2d4', 'd4'], 5: ['f8c5', 'Bc5'] };

function annotated(n = SANS.length, opts: { bare?: number[]; cls?: Record<number, MoveClass> } = {}): Ply[] {
  const chess = new Chess();
  return SANS.slice(0, n).map((san, index) => {
    const fenBefore = chess.fen();
    const mv = chess.move(san);
    const ply: Ply = { index, color: mv.color, san: mv.san, uci: mv.from + mv.to, fenBefore, fenAfter: chess.fen() };
    if (opts.bare?.includes(index)) return ply;
    const best = BEST[index] ?? [ply.uci, ply.san];
    const classification: Classification = {
      cls: opts.cls?.[index] ?? CLASSES[index],
      winBefore: 0.5,
      winAfter: 0.45,
      winLoss: 0.05,
      accuracy: 80,
      bestMoveUci: best[0],
      bestMoveSan: best[1],
      playedMoveSan: ply.san,
    };
    return {
      ...ply,
      evalWhite: { kind: 'cp', value: 20 },
      evalDepth: 14,
      classification,
      explanation: { headline: `${mv.san} explained.`, details: [`More about ${mv.san}.`] },
    };
  });
}

interface ViewOptions {
  coach?: boolean;
  rate?: boolean;
  /** Default: unrated whenever rateOpponent is on (as the controller makes it). */
  assisted?: boolean;
  plies?: Ply[];
  phase?: Phase;
  allowTakebacks?: boolean;
  mode?: CoachMode;
  viewIndex?: number | null;
  locked?: ProFeature[];
}

function view(o: ViewOptions = {}) {
  const rate = o.rate ?? true;
  const settings: GameSettings = {
    ...DEFAULT_SETTINGS,
    coach: o.coach ?? true,
    rateOpponent: rate,
    allowTakebacks: o.allowTakebacks ?? DEFAULT_SETTINGS.allowTakebacks,
  };
  const state = createState({ settings, profile: defaultProfile(), locked: signal(new Set(o.locked ?? [])) });
  const bot = personaById('pip')!;
  const plies = o.plies ?? annotated();
  const lastHuman = [...plies].reverse().find((p) => p.color === 'w');
  state.game.value = {
    id: 'g1',
    startFen: START_FEN,
    playerColor: 'w',
    bot,
    botElo: bot.elo,
    startedAt: new Date(0).toISOString(),
    assisted: o.assisted ?? rate,
    settings,
  };
  state.plies.value = plies;
  state.phase.value = o.phase ?? 'playing';
  state.viewIndex.value = o.viewIndex ?? null;
  state.coachMode.value = o.mode ?? (lastHuman ? { kind: 'feedback', index: lastHuman.index } : { kind: 'idle' });
  return { state, store: createStore(state) };
}

const classes = (plies: Ply[]) => plies.map((p) => p.classification?.cls ?? null);

describe('rate opponent: the view models during play', () => {
  it('coach and opponent ratings on: after a fine move of yours, the reply expanded and your move as the row above; both on the board, list and graph', () => {
    const { store } = view({ plies: annotated(6, { cls: { 4: 'good' } }) });
    const c = store.coach.value;
    expect(c).toMatchObject({
      kind: 'coach',
      title: 'Pip’s 3… Nd4 is a mistake',
      titleMove: 'Pip’s 3… Nd4',
      cls: 'mistake',
      lines: ['Nd4 explained.', 'More about Nd4.'],
      subject: 'opponent',
      who: 'Pip',
      verdict: 'Mistake',
      index: 5,
      paired: true,
      collapsed: false,
    });
    expect(c.actions).toEqual([{ id: 'showBest', label: 'Show best', primary: true }]);
    expect(c.other).toEqual({ subject: 'you', who: 'You', move: '3. Bc4', verdict: 'Good', cls: 'good', place: 'before' });
    // The reply has the badge (on the last move); yours stays on its square.
    expect(store.board.value.badge).toEqual({ square: 'd4', cls: 'mistake' });
    expect(store.board.value.extraBadges).toEqual([{ square: 'c4', cls: 'good' }]);
    expect(store.moveList.value.showClassIcons).toBe(true);
    expect(classes(store.moveList.value.plies)).toEqual(['book', 'book', 'best', 'good', 'good', 'mistake']);
    expect(store.evalGraph.value.markers).toEqual([{ index: 6, cls: 'mistake' }]);
  });

  it('your move stays expanded after the reply while it has something to fix (with Retry); the reply is the row below', () => {
    // 3. Bc4 is an inaccuracy: still the open one after 3… Nd4.
    const { store } = view();
    expect(store.coach.value).toMatchObject({ title: '3. Bc4 is an inaccuracy', subject: 'you', index: 4, paired: true });
    expect(store.coach.value.other).toEqual({ subject: 'opponent', who: 'Pip', move: '3… Nd4', verdict: 'Mistake', cls: 'mistake', place: 'after' });
    expect(store.board.value.badge).toEqual({ square: 'd4', cls: 'mistake' });
    expect(store.board.value.extraBadges).toEqual([{ square: 'c4', cls: 'inaccuracy' }]);
    // A mistake with takebacks on: its Retry stays at hand.
    const retry = view({ plies: annotated(6, { cls: { 4: 'mistake' } }), allowTakebacks: true }).store.coach.value;
    expect(retry).toMatchObject({ title: '3. Bc4 is a mistake', subject: 'you' });
    expect(retry.actions.map((a) => a.id)).toEqual(['showBest', 'retry']);
    // Every class that needs no fixing hands the panel to the reply.
    for (const cls of ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'forced'] as const) {
      expect(view({ plies: annotated(6, { cls: { 4: cls } }) }).store.coach.value.subject, cls).toBe('opponent');
    }
    for (const cls of ['inaccuracy', 'mistake', 'miss', 'blunder'] as const) {
      expect(view({ plies: annotated(6, { cls: { 4: cls } }) }).store.coach.value.subject, cls).toBe('you');
    }
  });

  it('coach on, opponent ratings off: only your move, as before', () => {
    const { store } = view({ rate: false });
    const c = store.coach.value;
    expect(c).toMatchObject({ title: '3. Bc4 is an inaccuracy', cls: 'inaccuracy', subject: 'you', paired: false });
    expect(c.other).toBeUndefined();
    expect(store.board.value.badge).toEqual({ square: 'c4', cls: 'inaccuracy' });
    expect(store.board.value.extraBadges).toBeUndefined();
    expect(classes(store.moveList.value.plies)).toEqual(['book', null, 'best', null, 'inaccuracy', null]);
    expect(store.evalGraph.value.markers).toEqual([]);
  });

  it('coach off, opponent ratings on: only the opponent’s move', () => {
    const { store } = view({ coach: false });
    const c = store.coach.value;
    expect(c).toMatchObject({ kind: 'coach', title: 'Pip’s 3… Nd4 is a mistake', subject: 'opponent', paired: false, collapsed: false });
    expect(c.other).toBeUndefined();
    expect(store.board.value.badge).toEqual({ square: 'd4', cls: 'mistake' });
    expect(store.board.value.extraBadges).toBeUndefined();
    expect(store.moveList.value.showClassIcons).toBe(true);
    expect(classes(store.moveList.value.plies)).toEqual([null, 'book', null, 'good', null, 'mistake']);
    // Your turn after your own move would show nothing of yours either.
    const mine = view({ coach: false, plies: annotated(5) }).store;
    expect(mine.coach.value.title).toBe('Pip’s 2… Nc6 is good');
    expect(mine.board.value.badge).toBeUndefined(); // its move is no longer the last one
  });

  it('both off: the minimal panel and no ratings, as before', () => {
    const { store } = view({ coach: false, rate: false });
    expect(store.coach.value.kind).toBe('minimal');
    expect(store.board.value.badge).toBeUndefined();
    expect(store.moveList.value.showClassIcons).toBe(false);
  });

  it('a rated game never shows them, even with the setting on', () => {
    const { store } = view({ assisted: false });
    expect(store.coach.value).toMatchObject({ title: '3. Bc4 is an inaccuracy', paired: false });
    expect(store.coach.value.other).toBeUndefined();
    expect(store.board.value.badge).toEqual({ square: 'c4', cls: 'inaccuracy' });
    expect(classes(store.moveList.value.plies)[5]).toBeNull();
    expect(store.evalGraph.value.markers).toEqual([]);
  });

  it('the rows never swap on a fine move: while it is checked and after the reply, the opponent’s stays expanded', () => {
    // Your 3. Bc4 is being checked (the bot is thinking): the bot's 2… Nc6 stays expanded, yours is
    // the row above, as before your move.
    const good = { 4: 'good' } as const;
    const { state, store } = view({ plies: annotated(5, { bare: [4] }) });
    expect(store.coach.value).toMatchObject({ title: 'Pip’s 2… Nc6 is good', subject: 'opponent', index: 3 });
    expect(store.coach.value.other).toEqual({ subject: 'you', who: 'You', move: '3. Bc4', verdict: 'Checking…', busy: true, place: 'before' });
    expect(store.board.value.badge).toBeUndefined(); // your move is not rated yet
    // Rated good: still the same layout.
    state.plies.value = annotated(5, { cls: good });
    expect(store.coach.value).toMatchObject({ subject: 'opponent', index: 3 });
    expect(store.coach.value.other).toMatchObject({ subject: 'you', verdict: 'Good', place: 'before' });
    expect(store.board.value.badge).toEqual({ square: 'c4', cls: 'good' });
    // The bot's reply: its move takes the open place, yours stays above.
    state.plies.value = annotated(6, { cls: good, bare: [5] });
    expect(store.coach.value).toMatchObject({ title: 'Checking Pip’s Nd4…', subject: 'opponent', index: 5 });
    expect(store.coach.value.other).toMatchObject({ subject: 'you', place: 'before' });
    state.plies.value = annotated(6, { cls: good });
    expect(store.coach.value).toMatchObject({ title: 'Pip’s 3… Nd4 is a mistake', subject: 'opponent' });
  });

  it('the player can pick the other move until the next move', () => {
    const { state, store } = view({ plies: annotated(5) });
    // Your 3. Bc4 is an inaccuracy: yours expanded, the bot's 2… Nc6 as the row below.
    expect(store.coach.value).toMatchObject({ title: '3. Bc4 is an inaccuracy', subject: 'you' });
    expect(store.coach.value.other).toEqual({ subject: 'opponent', who: 'Pip', move: '2… Nc6', verdict: 'Good', cls: 'good', place: 'after' });
    expect(store.board.value.badge).toEqual({ square: 'c4', cls: 'inaccuracy' });
    expect(store.board.value.extraBadges).toBeUndefined();
    state.coachFocus.value = { subject: 'opponent', at: 5 };
    expect(store.coach.value).toMatchObject({ title: 'Pip’s 2… Nc6 is good', subject: 'opponent', index: 3 });
    expect(store.coach.value.other).toMatchObject({ subject: 'you', move: '3. Bc4', place: 'before' });
    // The bot's reply: the panel picks again (your inaccuracy).
    state.plies.value = annotated(6);
    expect(store.coach.value).toMatchObject({ title: '3. Bc4 is an inaccuracy', subject: 'you', index: 4 });
    state.coachFocus.value = { subject: 'opponent', at: 6 };
    expect(store.coach.value).toMatchObject({ title: 'Pip’s 3… Nd4 is a mistake', subject: 'opponent', index: 5 });
    expect(store.coach.value.other).toMatchObject({ subject: 'you', move: '3. Bc4', verdict: 'Inaccuracy' });
  });

  it('the opponent’s move while it is checked, and when the check failed', () => {
    const plies = annotated(6, { bare: [5], cls: { 4: 'good' } });
    const { state, store } = view({ plies });
    expect(store.coach.value).toMatchObject({ title: 'Checking Pip’s Nd4…', busy: true, lines: [], subject: 'opponent' });
    expect(store.coach.value.other).toMatchObject({ subject: 'you', verdict: 'Good' });
    state.coachFocus.value = { subject: 'you', at: 6 };
    expect(store.coach.value.other).toEqual({ subject: 'opponent', who: 'Pip', move: '3… Nd4', verdict: 'Checking…', busy: true, place: 'after' });
    state.coachFocus.value = null;
    state.failedAnnotations.value = new Set([annotationKey('g1', plies[5])]);
    expect(store.coach.value).toMatchObject({ title: 'Couldn’t check Pip’s Nd4', busy: false });
    expect(store.coach.value.actions).toEqual([{ id: 'retryAnalysis', label: 'Try again', primary: true }]);
  });

  it('Pro locked: the verdict, icons and badges stay free; the explanation and Show best are locked', () => {
    const { store } = view({
      plies: annotated(6, { cls: { 4: 'good' } }),
      locked: ['coachExplanations', 'showBest', 'hint', 'bestMoveArrows', 'reviewDetails', 'explorerEngine'],
    });
    const c = store.coach.value;
    expect(c).toMatchObject({ title: 'Pip’s 3… Nd4 is a mistake', cls: 'mistake', lines: [lockedTeaser(annotated()[5])] });
    expect(c.actions).toEqual([
      { id: 'unlock', label: UNLOCK_LABEL, feature: 'coachExplanations', primary: true },
      { id: 'showBest', label: 'Show best', locked: true },
    ]);
    expect(c.other).toMatchObject({ verdict: 'Good', cls: 'good' });
    expect(store.board.value.badge).toEqual({ square: 'd4', cls: 'mistake' });
    expect(classes(store.moveList.value.plies)[5]).toBe('mistake');
  });

  it('browsing back to an opponent’s move shows its verdict; without the ratings, the paused board', () => {
    const on = view({ viewIndex: 4 }).store;
    expect(on.coach.value).toMatchObject({ kind: 'coach', title: 'Pip’s 2… Nc6 is good', cls: 'good', lines: ['Nc6 explained.', 'More about Nc6.'] });
    expect(on.coach.value.actions.map((a) => a.id)).toEqual(['backToGame']);
    expect(on.board.value.badge).toEqual({ square: 'c6', cls: 'good' });
    const off = view({ viewIndex: 4, rate: false }).store;
    expect(off.coach.value).toMatchObject({ kind: 'status', title: 'Viewing 2… Nc6' });
    expect(off.board.value.badge).toBeUndefined();
  });

  it('the finished game and the review look the same with or without the setting (nothing twice)', () => {
    for (const phase of ['over', 'review'] as const) {
      for (const viewIndex of [null, 6, 5, 4]) {
        const mode: CoachMode = { kind: 'idle' };
        const on = view({ phase, viewIndex, mode }).store;
        const off = view({ phase, viewIndex, mode, rate: false, assisted: true }).store;
        expect(on.coach.value, `${phase} ${viewIndex}`).toEqual(off.coach.value);
        expect(on.coach.value.other).toBeUndefined();
        expect(on.board.value).toEqual(off.board.value);
        expect(on.board.value.extraBadges).toBeUndefined();
        expect(on.moveList.value).toEqual(off.moveList.value);
        expect(on.evalGraph.value).toEqual(off.evalGraph.value);
      }
    }
  });
});

// -------------------------------------------------------------------------------------------------
// The controller: rated / unrated, the question, Show best on the opponent's move, the panel's focus.

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
  return { controller, store: controller.store, storage };
}

const settings = (over: Partial<GameSettings> = {}): GameSettings => ({
  ...DEFAULT_SETTINGS,
  playerColor: 'w',
  botId: 'pip',
  botElo: 100,
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

describe('rate opponent: rated games and the controller', () => {
  it('a game started with it on is unrated from the start, and the bot’s replies get the coach’s verdict', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5', 'd8h4']) });
    controller.newGame(settings({ rateOpponent: true }));
    expect(store.game.value!.assisted).toBe(true);
    expect(store.bottomPlayer.value.unrated).toBe(true);
    await play(controller, ['e2e4', 'g1f3']);
    // 2… Qh4 leaves the queen to Nxh4.
    expect(store.plies.value.map((p) => p.san)).toEqual(['e4', 'e5', 'Nf3', 'Qh4']);
    const c = store.coach.value;
    expect(c).toMatchObject({ subject: 'opponent', titleMove: 'Pip’s 2… Qh4', paired: true });
    expect(c.title).toMatch(/^Pip’s 2… Qh4 is (a blunder|a mistake)$/);
    expect(c.lines.length).toBeGreaterThan(0);
    expect(c.other).toMatchObject({ subject: 'you', move: '2. Nf3', place: 'before' });
    expect(store.board.value.badge).toMatchObject({ square: 'h4' });
    expect(store.moveList.value.plies[3].classification).toBeDefined();
    // A rematch keeps it: unrated again.
    controller.resign();
    controller.rematch();
    expect(store.game.value!.assisted).toBe(true);
  });

  it('switching it on in a rated game asks first: Cancel keeps the game rated, Turn on makes it unrated', async () => {
    const { controller, store, storage } = await setup({ bot: new ScriptedBot(['e7e5']) });
    controller.newGame(settings());
    await play(controller, ['e2e4']);
    expect(store.game.value!.assisted).toBe(false);

    controller.setSettings({ rateOpponent: true });
    expect(store.sheet.value).toBe('assist');
    expect(store.sheets.value.assist).toEqual({ kind: 'rateOpponent' });
    expect(store.settings.value.rateOpponent).toBe(false);
    controller.closeSheet();
    expect(store.settings.value.rateOpponent).toBe(false);
    expect(store.game.value!.assisted).toBe(false);
    expect(store.coach.value.other).toBeUndefined();

    controller.setSettings({ rateOpponent: true });
    controller.confirmAssist();
    expect(store.sheet.value).toBeNull();
    expect(store.settings.value.rateOpponent).toBe(true);
    expect(store.game.value!.assisted).toBe(true);
    expect(store.bottomPlayer.value.unrated).toBe(true);
    expect(JSON.parse(storage.getItem(SETTINGS_KEY)!).settings.rateOpponent).toBe(true);
    // The panel shows the bot's 1… e5 at once (your 1. e4 as the row above).
    expect(store.coach.value).toMatchObject({ subject: 'opponent', titleMove: 'Pip’s 1… e5' });
    expect(store.coach.value.other).toMatchObject({ subject: 'you', move: '1. e4' });

    // Off and on again: no question (the game is unrated now).
    controller.setSettings({ rateOpponent: false });
    expect(store.coach.value.other).toBeUndefined();
    controller.setSettings({ rateOpponent: true });
    expect(store.sheet.value).toBeNull();
    expect(store.settings.value.rateOpponent).toBe(true);
  });

  it('the bot keeps thinking while the question is open', async () => {
    const bot = new ScriptedBot(['e7e5']);
    bot.manual = true;
    const { controller, store } = await setup({ bot });
    controller.newGame(settings());
    expect(move(controller, 'e2e4')).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(bot.heldCount).toBe(1);
    controller.setSettings({ rateOpponent: true });
    expect(store.sheet.value).toBe('assist');
    bot.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.plies.value.map((p) => p.san)).toEqual(['e4', 'e5']);
    controller.confirmAssist();
    await controller.idle();
    expect(store.coach.value.titleMove).toBe('Pip’s 1… e5');
  });

  it('in an unrated game, after the game, or with other settings changed at the same time, no question', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    controller.newGame(settings({ allowTakebacks: true }));
    await play(controller, ['e2e4']);
    controller.setSettings({ rateOpponent: true, sound: false }); // asks for the one, applies the other
    expect(store.sheet.value).toBe('assist');
    expect(store.settings.value).toMatchObject({ rateOpponent: false, sound: false });
    controller.closeSheet();
    controller.undo(); // a takeback: unrated now
    expect(store.game.value!.assisted).toBe(true);
    controller.setSettings({ rateOpponent: true });
    expect(store.sheet.value).toBeNull();
    expect(store.settings.value.rateOpponent).toBe(true);

    // A finished rated game: switching it on changes nothing about the result.
    controller.setSettings({ rateOpponent: false });
    controller.newGame(settings());
    await play(controller, ['e2e4']);
    controller.resign();
    const rc = store.ratingChange.value;
    expect(rc?.rated).toBe(true);
    const profile = store.profile.value;
    controller.setSettings({ rateOpponent: true });
    expect(store.sheet.value).not.toBe('assist');
    expect(store.ratingChange.value).toEqual(rc);
    expect(store.profile.value).toBe(profile);
    expect(store.game.value!.assisted).toBe(false);
  });

  it('Show best on the opponent’s move shows what it should have played, on the position before its move', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5', 'd8h4']) });
    controller.newGame(settings({ rateOpponent: true }));
    await play(controller, ['e2e4', 'g1f3']);
    const ply = store.plies.value[3];
    expect(store.coach.value.actions.map((a) => a.id)).toContain('showBest');
    controller.runAction('showBest');
    await controller.idle();
    const m = store.coachMode.value;
    expect(m).toMatchObject({ kind: 'showBest', index: 3 });
    expect(store.viewIndex.value).toBe(3);
    expect(store.board.value.fen).toBe(ply.fenBefore);
    expect(store.board.value.arrows).toEqual(
      expect.arrayContaining([
        { from: 'd8', to: 'h4', brush: 'played' },
        expect.objectContaining({ brush: 'best' }),
      ]),
    );
    expect(store.coach.value.title).toBe(`Best was ${ply.classification!.bestMoveSan}`);
    expect(store.coach.value.lines.some((l) => l.startsWith('Pip played Qh4.'))).toBe(true);
    controller.runAction('backToGame');
    expect(store.viewIndex.value).toBeNull();
    expect(store.coach.value).toMatchObject({ subject: 'opponent', titleMove: 'Pip’s 2… Qh4' });
  });

  it('the other row: picking a move shows its feedback until the next move', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    controller.newGame(settings({ rateOpponent: true }));
    await play(controller, ['e2e4']);
    expect(store.coach.value.subject).toBe('opponent');
    controller.selectCoachFeedback('you');
    expect(store.coach.value).toMatchObject({ subject: 'you', titleMove: '1. e4' });
    expect(store.coach.value.other).toMatchObject({ subject: 'opponent', move: '1… e5', place: 'after' });
    await play(controller, ['g1f3']);
    expect(store.coach.value).toMatchObject({ subject: 'opponent', titleMove: 'Pip’s 2… Nc6' });
    // A new game forgets the choice.
    controller.selectCoachFeedback('you');
    controller.newGame(settings({ rateOpponent: true }));
    expect(store.coachFocus.value).toBeNull();
  });

  it('a takeback forgets the picked row (it would otherwise come back at the same ply count)', async () => {
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6', 'b8c6']) });
    controller.newGame(settings({ rateOpponent: true, allowTakebacks: true }));
    await play(controller, ['e2e4', 'g1f3']);
    const auto = store.coach.value.subject!;
    const picked = auto === 'you' ? 'opponent' : 'you';
    controller.selectCoachFeedback(picked);
    expect(store.coach.value.subject).toBe(picked);
    controller.requestUndo(); // already unrated: no question
    expect(store.plies.value).toHaveLength(2);
    expect(store.coachFocus.value).toBeNull();
    await play(controller, ['g1f3']);
    expect(store.plies.value).toHaveLength(4);
    expect(store.coach.value.subject).toBe(auto);
  });

  it('Pro locked: the setting is free, the opponent’s Show best opens the paywall', async () => {
    const storage = new MemoryStorage();
    const purchases = new FakePurchases();
    const entitlements = createEntitlements({ enabled: true, purchases, storage });
    ents.push(entitlements);
    purchases.unlocked.resolve(false);
    purchases.product.resolve({ id: 'pro', title: 'Pro', description: '', displayPrice: '$9.99' });
    const { controller, store } = await setup({ bot: new ScriptedBot(['e7e5', 'd8h4']), storage, entitlements });
    controller.newGame(settings({ rateOpponent: true }));
    expect(store.settings.value.rateOpponent).toBe(true);
    await play(controller, ['e2e4', 'g1f3']);
    const c = store.coach.value;
    expect(c).toMatchObject({ subject: 'opponent', titleMove: 'Pip’s 2… Qh4' });
    expect(c.cls).toBeDefined();
    expect(c.lines).toEqual([lockedTeaser(store.plies.value[3])]);
    expect(c.actions.find((a) => a.id === 'showBest')).toMatchObject({ locked: true });
    controller.runAction('showBest');
    expect(entitlements.paywall.value).toEqual({ open: true, feature: 'showBest' });
    expect(store.coachMode.value.kind).toBe('feedback');
    entitlements.closePaywall();
    controller.runAction('unlock');
    expect(entitlements.paywall.value).toEqual({ open: true, feature: 'coachExplanations' });
  });
});
