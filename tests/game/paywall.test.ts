/**
 * Pro gating: the store's view models never show a locked feature (no explanation, best move or
 * arrow), and the controller opens the paywall instead of running a locked action.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@preact/signals';
import { Chess } from 'chess.js';
import type { Classification, Explanation } from '../../src/analysis/types';
import { customPersona } from '../../src/bot/personas';
import { fenKey } from '../../src/chess/utils';
import { UNLOCK_LABEL, lockedTeaser, mentionsMove } from '../../src/game/coach';
import { GameController } from '../../src/game/controller';
import { PRO_CACHE_KEY, createEntitlements, proFeatures, type Entitlements, type ProFeature } from '../../src/game/entitlements';
import { createState, createStore } from '../../src/game/store';
import { DEFAULT_SETTINGS, type GameSettings, type Ply, type PromotionPiece } from '../../src/game/types';
import { defaultProfile } from '../../src/rating/rating';
import { MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet } from '../helpers/fakeEngine';
import { FakePurchases } from './fakePurchases';

const ALL_LOCKED: ReadonlySet<ProFeature> = new Set(proFeatures());
const NONE: ReadonlySet<ProFeature> = new Set();

const cl = (over: Partial<Classification> = {}): Classification => ({
  cls: 'mistake',
  winBefore: 0.6,
  winAfter: 0.4,
  winLoss: 0.2,
  accuracy: 40,
  bestMoveUci: 'g1f3',
  bestMoveSan: 'Nf3',
  playedMoveSan: 'h3',
  ...over,
});

const EXPLANATION: Explanation = {
  headline: 'h3 does nothing for your development.',
  details: ['Best was Nf3, which develops a piece and controls e5.'],
};

/** A store after 1. h3 (a mistake; Nf3 was best) by the human, with `locked` features. */
function storeAfterH3(locked: ReadonlySet<ProFeature>, phase: 'playing' | 'review' = 'playing') {
  const chess = new Chess();
  const before = chess.fen();
  chess.move('h3');
  const ply: Ply = {
    index: 0,
    color: 'w',
    san: 'h3',
    uci: 'h2h3',
    fenBefore: before,
    fenAfter: chess.fen(),
    evalWhite: { kind: 'cp', value: -20 },
    evalDepth: 14,
    classification: cl(),
    explanation: EXPLANATION,
  };
  const bot = customPersona(1200);
  const lockedSig = signal(locked);
  const state = createState({ settings: { ...DEFAULT_SETTINGS, playerColor: 'w' }, profile: defaultProfile(), locked: lockedSig });
  state.game.value = {
    id: 'g1',
    startFen: before,
    playerColor: 'w',
    bot,
    botElo: bot.elo,
    startedAt: new Date(0).toISOString(),
    assisted: true, // unrated: Retry is offered without a question
    settings: { ...DEFAULT_SETTINGS, playerColor: 'w' },
  };
  state.plies.value = [ply];
  state.phase.value = phase;
  if (phase === 'playing') state.coachMode.value = { kind: 'feedback', index: 0 };
  else {
    state.viewIndex.value = 1;
    state.reviewState.value = {
      progress: null,
      accuracy: { w: 61.2, b: 88 },
      counts: { w: { mistake: 1 }, b: {} },
      keyMoments: [{ index: 0, cls: 'mistake', san: 'h3', text: EXPLANATION.headline }],
    };
  }
  return { store: createStore(state), state, ply, locked: lockedSig };
}

/** The position after Black answers 1… e5. */
function afterE5(fen: string): string {
  const c = new Chess(fen);
  c.move('e5');
  return c.fen();
}

/** Every string a view model would put on screen. */
const texts = (o: unknown): string => JSON.stringify(o);

describe('store gating (locked Pro features)', () => {
  it('coach feedback keeps the verdict and icon, and replaces the why with a teaser', () => {
    const { store, ply } = storeAfterH3(ALL_LOCKED);
    const coach = store.coach.value;
    expect(coach.title).toBe('1. h3 is a mistake');
    expect(coach.cls).toBe('mistake');
    expect(store.board.value.badge).toEqual({ square: 'h3', cls: 'mistake' });
    expect(coach.lines).toEqual([lockedTeaser(ply)]);
    expect(coach.actions).toEqual([
      { id: 'unlock', label: UNLOCK_LABEL, feature: 'coachExplanations', primary: true },
      { id: 'showBest', label: 'Show best', locked: true },
      { id: 'retry', label: 'Retry' }, // takebacks stay free
    ]);
    // Nothing on screen gives the answer away.
    expect(texts(coach)).not.toContain('Nf3');
    expect(texts(coach)).not.toContain(EXPLANATION.headline);
  });

  it('unlocked: the explanation and an unlocked Show best', () => {
    const { store, locked } = storeAfterH3(ALL_LOCKED);
    locked.value = NONE;
    const coach = store.coach.value;
    expect(coach.lines[0]).toBe(EXPLANATION.headline);
    expect(coach.actions.map((a) => a.id)).toEqual(['showBest', 'retry']);
    expect(coach.actions.some((a) => a.locked)).toBe(false);
  });

  it('the teaser never names a move, a square or a piece', () => {
    for (const cls of ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'forced', 'inaccuracy', 'mistake', 'miss', 'blunder'] as const) {
      const t = lockedTeaser({ classification: cl({ cls }) });
      expect(t).not.toMatch(/\b[a-h][1-8]\b|knight|bishop|rook|queen|king|pawn/i);
    }
    expect(lockedTeaser({ classification: cl({ cls: 'excellent' }), explanation: { headline: 'x', details: [], concedes: 'material' } })).toMatch(
      /gives away/,
    );
  });

  it('best-move arrows draw nothing while locked, even with the setting on', () => {
    const { store, state, locked } = storeAfterH3(ALL_LOCKED);
    state.coachMode.value = { kind: 'idle' };
    state.plies.value = state.plies.value.concat({
      index: 1,
      color: 'b',
      san: 'e5',
      uci: 'e7e5',
      fenBefore: state.plies.value[0].fenAfter,
      fenAfter: afterE5(state.plies.value[0].fenAfter),
    });
    state.settings.value = { ...state.settings.value, showBestMoves: true };
    const fen = state.plies.value[1].fenAfter;
    state.live.value = {
      key: fenKey(fen),
      result: {
        fen,
        depth: 16,
        done: true,
        bestMove: 'g1f3',
        lines: [{ multipv: 1, depth: 16, score: { kind: 'cp', value: 30 }, pv: ['g1f3'] }],
      },
    };
    expect(store.humanToMove.value).toBe(true);
    expect(store.board.value.arrows).toEqual([]);
    locked.value = NONE;
    expect(store.board.value.arrows).toEqual([{ from: 'g1', to: 'f3', brush: 'best' }]);
  });

  it('a hint or Show best that is somehow open shows neither the move nor its arrows', () => {
    const { store, state } = storeAfterH3(ALL_LOCKED);
    state.coachMode.value = {
      kind: 'hint',
      fen: state.plies.value[0].fenAfter,
      explanation: { headline: 'e5 grabs the center.', details: [], arrows: [{ from: 'e7', to: 'e5', brush: 'best' }] },
      prev: { kind: 'idle' },
    };
    expect(store.board.value.arrows).toEqual([]);
    expect(texts(store.coach.value)).not.toContain('e5');
    state.coachMode.value = {
      kind: 'showBest',
      index: 0,
      bestUci: 'g1f3',
      bestSan: 'Nf3',
      lines: ['Nf3 develops a piece.'],
      returnTo: null,
      prev: { kind: 'feedback', index: 0 },
    };
    expect(store.board.value.arrows).toEqual([]);
    expect(texts(store.coach.value)).not.toContain('Nf3');
  });

  it('the Retry prompt keeps "Find a better move" but drops the coach’s reason', () => {
    const { store, state, locked } = storeAfterH3(ALL_LOCKED);
    state.coachMode.value = { kind: 'retry', san: 'h3', cls: 'mistake', headline: EXPLANATION.headline };
    expect(store.coach.value.lines).toEqual(['Find a better move than h3.']);
    locked.value = NONE;
    expect(store.coach.value.lines).toEqual(['Find a better move than h3.', EXPLANATION.headline]);
  });

  it('browsing back to the move during the game shows the teaser too', () => {
    const { store, state } = storeAfterH3(ALL_LOCKED);
    state.plies.value = state.plies.value.concat({
      index: 1,
      color: 'b',
      san: 'e5',
      uci: 'e7e5',
      fenBefore: state.plies.value[0].fenAfter,
      fenAfter: afterE5(state.plies.value[0].fenAfter),
    });
    state.viewIndex.value = 1;
    const coach = store.coach.value;
    expect(coach.title).toBe('1. h3 is a mistake');
    expect(coach.lines).toEqual([lockedTeaser(state.plies.value[0])]);
    expect(coach.actions.map((a) => a.id)).toEqual(['backToGame', 'unlock']);
  });

  it('the toolbar marks Hint as locked', () => {
    const { store, locked } = storeAfterH3(ALL_LOCKED);
    expect(store.toolbar.value.hint.locked).toBe(true);
    locked.value = NONE;
    expect(store.toolbar.value.hint.locked).toBeUndefined();
  });

  it('Game Review: accuracy and counts are free; key moments, comments and arrows are locked', () => {
    const { store, locked, ply } = storeAfterH3(ALL_LOCKED, 'review');
    const review = store.review.value!;
    expect(review.accuracy).toEqual({ w: 61.2, b: 88 });
    expect(review.counts.w.mistake).toBe(1);
    expect(review.keyMoments).toEqual([]);
    expect(review.lockedMoments).toBe(1);
    const coach = store.coach.value;
    expect(coach.title).toBe('1. h3 is a mistake');
    expect(coach.lines).toEqual([lockedTeaser(ply)]);
    expect(coach.actions).toEqual([
      { id: 'unlock', label: UNLOCK_LABEL, feature: 'reviewDetails', primary: true },
      { id: 'showBest', label: 'Show best', locked: true },
    ]);
    expect(store.board.value.arrows).toEqual([]);
    expect(texts(review)).not.toContain(EXPLANATION.headline);
    expect(texts(coach)).not.toContain('Nf3');

    locked.value = NONE;
    expect(store.review.value!.keyMoments).toHaveLength(1);
    expect(store.review.value!.lockedMoments).toBeUndefined();
    expect(store.coach.value.lines.some((l) => mentionsMove(l, 'Nf3'))).toBe(true);
    expect(store.board.value.arrows).toEqual([{ from: 'g1', to: 'f3', brush: 'best' }]);
  });

  it('a config with only some features locked gates only those', () => {
    const { store } = storeAfterH3(new Set<ProFeature>(['showBest']));
    const coach = store.coach.value;
    expect(coach.lines[0]).toBe(EXPLANATION.headline);
    expect(coach.actions[0]).toEqual({ id: 'showBest', label: 'Show best', locked: true });
  });
});

// -------------------------------------------------------------------------------------------------
// Controller

const controllers: GameController[] = [];
const ents: Entitlements[] = [];

afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  for (const e of ents.splice(0)) e.dispose();
  vi.restoreAllMocks();
});

async function setup(opts: { bot?: ScriptedBot; storage?: MemoryStorage } = {}) {
  const storage = opts.storage ?? new MemoryStorage();
  const purchases = new FakePurchases();
  const entitlements = createEntitlements({ enabled: true, purchases, storage });
  ents.push(entitlements);
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
    entitlements,
    ...(opts.bot ? { createBot: () => opts.bot! } : {}),
  });
  controllers.push(controller);
  purchases.unlocked.resolve(false);
  purchases.product.resolve({ id: 'pro', title: 'Pro', description: '', displayPrice: '$9.99' });
  await controller.boot();
  return { controller, store: controller.store, entitlements, purchases, storage };
}

const settings = (over: Partial<GameSettings> = {}): GameSettings => ({
  ...DEFAULT_SETTINGS,
  playerColor: 'w',
  botId: 'pip',
  botElo: 100,
  ...over,
});

const play = (c: GameController, uci: string) => c.playerMove(uci.slice(0, 2), uci.slice(2, 4), uci[4] as PromotionPiece | undefined);

describe('controller gating', () => {
  it('Hint opens the paywall instead of asking about the rating; after buying Pro it works', async () => {
    const { controller, store, entitlements, purchases } = await setup();
    controller.newGame(settings());
    expect(store.toolbar.value.hint).toMatchObject({ disabled: false, locked: true });
    controller.requestHint();
    expect(entitlements.paywall.value).toEqual({ open: true, feature: 'hint' });
    expect(store.sheet.value).toBeNull();
    expect(store.coachMode.value.kind).toBe('idle');
    await controller.hint(); // the direct call is gated too
    expect(store.coachMode.value.kind).toBe('idle');
    expect(store.game.value?.assisted).toBe(false);

    const bought = entitlements.buy();
    purchases.purchases[0].resolve('purchased');
    await bought;
    expect(entitlements.status.value).toBe('success');
    entitlements.closePaywall();
    controller.requestHint();
    expect(store.sheet.value).toBe('assist'); // the usual "this makes the game unrated" question
  });

  it('Show best and "Unlock to see why" open the paywall; the coach shows the teaser', async () => {
    const bot = new ScriptedBot(['e7e5', 'b8c6', 'e8f7']);
    const { controller, store, entitlements } = await setup({ bot });
    controller.newGame(settings());
    for (const uci of ['e2e4', 'd1h5']) {
      expect(play(controller, uci)).toBe(true);
      await controller.idle();
    }
    expect(play(controller, 'h5f7')).toBe(true); // Qxf7+?? loses the queen
    await vi.waitFor(() => expect(store.plies.value[4]?.classification).toBeDefined());
    await vi.waitFor(() => expect(store.coach.value.busy).toBe(false));
    const ply = store.plies.value[4];
    const coach = store.coach.value;
    expect(coach.cls).toBe(ply.classification!.cls);
    expect(coach.lines).toEqual([lockedTeaser(ply)]);
    expect(texts(coach)).not.toContain(ply.classification!.bestMoveSan!);
    expect(coach.actions.map((a) => [a.id, !!a.locked])).toEqual([
      ['unlock', false],
      ['showBest', true],
      ['retry', false],
    ]);

    controller.runAction('showBest');
    expect(entitlements.paywall.value).toEqual({ open: true, feature: 'showBest' });
    expect(store.coachMode.value.kind).toBe('feedback');
    expect(store.isLive.value).toBe(true);
    entitlements.closePaywall();

    controller.runAction('unlock');
    expect(entitlements.paywall.value).toEqual({ open: true, feature: 'coachExplanations' });
    entitlements.closePaywall();

    // Retry stays free.
    controller.runAction('retry');
    expect(store.sheet.value).toBe('assist');
  });

  it('best-move arrows: switching them on opens the paywall and changes nothing', async () => {
    const { controller, store, entitlements } = await setup();
    controller.newGame(settings());
    controller.setSettings({ showBestMoves: true });
    expect(entitlements.paywall.value).toEqual({ open: true, feature: 'bestMoveArrows' });
    expect(store.settings.value.showBestMoves).toBe(false);
    expect(store.game.value?.assisted).toBe(false);
    // Other settings in the same change still apply.
    controller.setSettings({ showBestMoves: true, sound: false });
    expect(store.settings.value).toMatchObject({ showBestMoves: false, sound: false });
    // A new game asked for with arrows on starts without them (and rated).
    controller.newGame(settings({ showBestMoves: true }));
    expect(store.settings.value.showBestMoves).toBe(false);
    expect(store.game.value?.assisted).toBe(false);
  });

  it('a refund closes an open hint and switches the arrows off', async () => {
    const storage = new MemoryStorage();
    storage.setItem(PRO_CACHE_KEY, '1');
    const purchases = new FakePurchases();
    const entitlements = createEntitlements({ enabled: true, purchases, storage });
    ents.push(entitlements);
    const engines = fakeEngineSet();
    const controller = new GameController({
      createEngines: async () => engines.set,
      onlineEvents: null,
      storage,
      sound: new RecordingSound(),
      thinkDelay: false,
      createId: () => 'g',
      rng: () => 0.3,
      entitlements,
    });
    controllers.push(controller);
    purchases.unlocked.resolve(true);
    await controller.boot();
    const store = controller.store;
    controller.newGame(settings({ showBestMoves: true }));
    expect(store.game.value?.assisted).toBe(true);
    await controller.idle();
    await controller.hint();
    expect(store.coachMode.value.kind).toBe('hint');
    purchases.emit(false); // refunded
    expect(store.coachMode.value.kind).toBe('idle');
    expect(store.settings.value.showBestMoves).toBe(false);
    expect(store.board.value.arrows).toEqual([]);
  });

  it('no service-worker reload while the paywall is open', async () => {
    const { controller, entitlements } = await setup();
    expect(controller.canReloadNow()).toBe(true); // setup phase
    entitlements.openPaywall();
    expect(controller.canReloadNow()).toBe(false);
    entitlements.closePaywall();
    expect(controller.canReloadNow()).toBe(true);
  });
});
