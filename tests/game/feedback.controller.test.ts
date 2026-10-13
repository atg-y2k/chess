/**
 * Feedback first (GameController `holdForFeedback`, FEEDBACK_HOLD_MS, FEEDBACK_LEAD_MS): with the
 * coach on, the bot's reply to your move waits until the coach's verdict on it has been on the
 * screen for a moment, with the analysis engine's results landing when the test says so (FakeEngine
 * `manual`). The cap, the lead, every path that lets the reply go (or drops it), no wait with the
 * coach off or when the verdict is already there; the near-equal second opinion before the verdict
 * (its words never change once shown); the order of the analysis engine's searches
 * (ANALYSIS_PRIORITY); and the dual coach following the game forward.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { nullMoveFen } from '../../src/analysis/motifs';
import { fenKey } from '../../src/chess/utils';
import type { PvLine, Score } from '../../src/engine/types';
import type { EnsureOptions } from '../../src/engine/AnalysisService';
import { PUNISHED_LINE } from '../../src/game/coach';
import {
  ANALYSIS_PRIORITY,
  FEEDBACK_HOLD_MS,
  FEEDBACK_LEAD_MS,
  GameController,
  SECOND_OPINION,
  type BotLike,
} from '../../src/game/controller';
import type { Classification } from '../../src/analysis/types';
import { customPersona } from '../../src/bot/personas';
import { annotationKey, createState, createStore } from '../../src/game/store';
import type { Ply } from '../../src/game/types';
import { defaultProfile } from '../../src/rating/rating';
import { closeOpenings, openOpenings, openingsOpen } from '../../src/openings/session';
import { DEFAULT_SETTINGS, type GameSettings, type PromotionPiece } from '../../src/game/types';
import { MemoryStorage, RecordingSound, ScriptedBot, fakeEngineSet } from '../helpers/fakeEngine';

/** explainMove throws for this move (a bug in the coach, not the engine), when set. */
const explainThrows = vi.hoisted(() => ({ uci: null as string | null }));
vi.mock('../../src/analysis/explain', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/analysis/explain')>();
  return {
    ...mod,
    explainMove: (input: Parameters<typeof mod.explainMove>[0]) => {
      if (explainThrows.uci && input.moveUci === explainThrows.uci) throw new Error('explain failed');
      return mod.explainMove(input);
    },
  };
});

const controllers: GameController[] = [];
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  if (openingsOpen.peek()) closeOpenings();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits (in real time, at most 3 s) until `cond()`. */
const waitFor = async (cond: () => boolean) => {
  for (const start = Date.now(); !cond() && Date.now() - start < 3000; ) await sleep(5);
  expect(cond()).toBe(true);
};
const cp = (value: number): Score => ({ kind: 'cp', value });
const pv = (score: Score, moves: string): PvLine => ({ multipv: 1, depth: 14, score, pv: moves.split(' ') });
const fenOf = (sans: string) => {
  const c = new Chess();
  for (const s of sans.split(' ').filter(Boolean)) c.move(s);
  return c.fen();
};

const settings = (over: Partial<GameSettings> = {}): GameSettings => ({
  ...DEFAULT_SETTINGS,
  playerColor: 'w',
  botId: 'pip',
  botElo: 100,
  ...over,
});

interface Setup {
  bot?: BotLike;
  holdMs?: number;
  /** The verdict's lead before the held reply (default 0, as with `thinkDelay: false`). */
  leadMs?: number;
  lines?: [string, PvLine[]][];
  storage?: MemoryStorage;
}

async function setup(o: Setup = {}) {
  const engines = fakeEngineSet();
  for (const [fen, lines] of o.lines ?? []) engines.analysis.fixed.set(fenKey(fen), lines);
  const bot = o.bot ?? new ScriptedBot(['e7e5', 'b8c6', 'g8f6', 'f8c5']);
  let n = 0;
  const controller = new GameController({
    createEngines: async () => engines.set,
    onlineEvents: null,
    storage: o.storage ?? new MemoryStorage(),
    sound: new RecordingSound(),
    thinkDelay: false,
    createId: () => `game-${++n}`,
    rng: () => 0.3,
    createBot: () => bot,
    feedbackHoldMs: o.holdMs ?? 60_000,
    ...(o.leadMs !== undefined ? { feedbackLeadMs: o.leadMs } : {}),
  });
  controllers.push(controller);
  await controller.boot();
  const store = controller.store;
  const analysis = engines.analysis;
  /** Lets the analysis engine finish its searches one by one until `cond()` (at most `max` of them). */
  const finishUntil = async (cond: () => boolean, max = 200) => {
    for (let i = 0; i < max && !cond(); i++) {
      if (!analysis.finishSearch()) await tick();
      await tick();
    }
    expect(cond()).toBe(true);
  };
  /** The verdict on ply `i` (class and explanation) is in. */
  const verdict = (i: number) => () => !!store.plies.value[i]?.classification && !!store.plies.value[i]?.explanation;
  const move = (uci: string) => controller.playerMove(uci.slice(0, 2), uci.slice(2, 4), uci[4] as PromotionPiece | undefined);
  return { controller, store, engines, analysis, bot, finishUntil, verdict, move };
}

/** A game where the analysis results land by hand: you (White) have played 1. e4, the bot's reply is held. */
async function heldReply(o: Setup & { over?: Partial<GameSettings> } = {}) {
  const t = await setup(o);
  t.analysis.manual = true;
  t.controller.newGame(settings(o.over));
  await tick();
  expect(t.move('e2e4')).toBe(true);
  for (let i = 0; i < 5; i++) await tick();
  return t;
}

describe('feedback first: the bot’s reply waits for the coach’s verdict', () => {
  it('holds the reply, still "thinking", until the verdict on your move is shown', async () => {
    const t = await heldReply();
    const { store } = t;
    // The bot has chosen its move, but it is not played: the coach is still checking yours.
    expect((t.bot as ScriptedBot).calls).toHaveLength(1);
    expect(store.plies.value).toHaveLength(1);
    expect(store.botThinking.value).toBe(true);
    expect(store.coach.value).toMatchObject({ title: 'Checking e4…', busy: true });
    expect(store.topPlayer.value.thinking).toBe(true);
    // The verdict lands first, then the reply (never the other way round).
    const seen: string[] = [];
    const stop = store.plies.subscribe((ps) => seen.push(`${ps.length}:${ps[0]?.classification ? 'verdict' : 'checking'}`));
    await t.finishUntil(() => store.plies.value.length === 2);
    stop();
    expect(seen.indexOf('1:verdict')).toBeGreaterThan(-1);
    expect(seen.indexOf('1:verdict')).toBeLessThan(seen.findIndex((x) => x.startsWith('2:')));
    expect(store.plies.value[1].san).toBe('e5');
    expect(store.botThinking.value).toBe(false);
  });

  it('no extra wait when the verdict is already there (the bot keeps its own think time)', async () => {
    const bot = new ScriptedBot(['e7e5']);
    bot.manual = true;
    const t = await heldReply({ bot });
    // The verdict comes in while the bot is still thinking...
    await t.finishUntil(t.verdict(0));
    expect(t.store.plies.value).toHaveLength(1);
    // ...so its move is played as soon as it has chosen it.
    bot.release();
    await tick();
    await tick();
    expect(t.store.plies.value).toHaveLength(2);
  });

  it('never waits longer than the cap: the reply comes, the verdict follows', async () => {
    expect(FEEDBACK_HOLD_MS).toBeGreaterThanOrEqual(2000);
    const t = await heldReply({ holdMs: 40 });
    expect(t.store.plies.value).toHaveLength(1);
    await sleep(80);
    expect(t.store.plies.value).toHaveLength(2);
    expect(t.store.plies.value[0].classification).toBeUndefined();
    await t.finishUntil(t.verdict(0));
  });

  it('does not wait with the coach off', async () => {
    const t = await heldReply({ over: { coach: false } });
    expect(t.store.plies.value).toHaveLength(2);
    expect(t.store.plies.value[0].classification).toBeUndefined();
  });

  it('does not wait after a move that ended the game (there is no reply), nor for the opponent’s rating', async () => {
    // 1. f3 e5 2. g4?? Qh4#: the bot's mate is played; its own move is never held for anything.
    const bot = new ScriptedBot(['e7e5', 'd8h4']);
    const t = await setup({ bot });
    t.controller.newGame(settings({ rateOpponent: true }));
    t.move('f2f3');
    await t.controller.idle();
    t.analysis.manual = true;
    t.move('g2g4');
    await t.finishUntil(() => t.store.plies.value.length === 4);
    expect(t.store.outcome.value?.reason).toBe('Checkmate');
    // The mate came once your move had its verdict; the opponent's verdict follows.
    expect(t.verdict(2)()).toBe(true);
  });
});

describe('feedback first: what lets the held reply go, or drops it', () => {
  it('the check failing ("Couldn’t check e4"): the reply comes', async () => {
    const t = await heldReply();
    for (let i = 0; i < 40 && !t.store.failedAnnotations.value.size; i++) {
      t.analysis.stop(); // the search cut short, retried, cut short again…
      await tick();
      await tick();
    }
    const g = t.store.game.value!;
    expect(t.store.failedAnnotations.value.has(annotationKey(g.id, t.store.plies.value[0]))).toBe(true);
    await tick();
    expect(t.store.plies.value).toHaveLength(2);
    t.controller.selectCoachFeedback('you');
    expect(t.store.coach.value.title).toBe('Couldn’t check e4');
  });

  it('the analysis engine breaking: the error screen, and no reply', async () => {
    const t = await heldReply();
    t.analysis.failWith = new Error('dead');
    t.analysis.stop();
    for (let i = 0; i < 10; i++) await tick();
    expect(t.store.phase.value).toBe('error');
    expect(t.store.plies.value).toHaveLength(1);
    expect(t.store.botThinking.value).toBe(false);
  });

  it('Undo: the reply is dropped with your move', async () => {
    const t = await heldReply();
    expect(t.controller.undo()).toBe(true);
    expect(t.store.plies.value).toHaveLength(0);
    expect(t.store.botThinking.value).toBe(false);
    t.analysis.manual = false;
    t.analysis.finishSearch();
    await t.controller.idle();
    expect(t.store.plies.value).toHaveLength(0);
    expect(t.store.humanToMove.value).toBe(true);
  });

  it('a takeback asked for in a rated game: the reply waits for the answer, then for the verdict', async () => {
    const t = await heldReply();
    t.controller.requestUndo();
    expect(t.store.sheet.value).toBe('assist');
    expect(t.store.botThinking.value).toBe(false);
    t.controller.closeSheet(); // Cancel: the bot answers after all, once the verdict is in
    await tick();
    expect(t.store.plies.value).toHaveLength(1);
    await t.finishUntil(() => t.store.plies.value.length === 2);
    expect(t.verdict(0)()).toBe(true);
    expect((t.bot as ScriptedBot).calls).toHaveLength(2);
  });

  it('a new game: the held reply never lands in it', async () => {
    const t = await heldReply();
    t.controller.newGame(settings());
    t.analysis.manual = false;
    t.analysis.finishSearch();
    await t.controller.idle();
    expect(t.store.plies.value).toHaveLength(0);
    expect(t.store.humanToMove.value).toBe(true);
  });

  it('resigning: the game ends, and no reply', async () => {
    const t = await heldReply();
    t.controller.resign();
    t.analysis.manual = false;
    t.analysis.finishSearch();
    await t.controller.idle();
    expect(t.store.phase.value).toBe('over');
    expect(t.store.plies.value).toHaveLength(1);
  });

  it('the page hidden: the reply is dropped; visible again, the bot answers once the verdict is in', async () => {
    const t = await heldReply();
    t.controller.onVisibilityChange(true);
    expect(t.store.botThinking.value).toBe(false);
    await tick();
    expect(t.store.plies.value).toHaveLength(1);
    t.controller.onVisibilityChange(false);
    await tick();
    expect((t.bot as ScriptedBot).calls).toHaveLength(2);
    expect(t.store.plies.value).toHaveLength(1);
    await t.finishUntil(() => t.store.plies.value.length === 2);
    expect(t.verdict(0)()).toBe(true);
  });

  it('switching the coach off: the reply comes at once', async () => {
    const t = await heldReply();
    t.controller.toggleCoach();
    await tick();
    expect(t.store.plies.value).toHaveLength(2);
  });

  it('opening the explorer: the bot plays on in your game', async () => {
    const t = await heldReply();
    t.controller.requestExplore();
    expect(t.store.explorer.value).not.toBeNull();
    await tick();
    expect(t.store.plies.value).toHaveLength(2);
    expect(t.store.plies.value[0].classification).toBeUndefined();
  });

  it('opening the Openings section: the bot plays on under it', async () => {
    const t = await heldReply();
    openOpenings();
    await tick();
    expect(t.store.plies.value).toHaveLength(2);
    closeOpenings();
  });

  it('opening an earlier game in the game viewer (or trying its moves again): the bot plays on under it', async () => {
    const bot = new ScriptedBot(['e7e5', 'b8c6', 'e8f7']);
    const t = await setup({ bot });
    // An earlier game, resigned after 3. Qxf7+?? Kxf7.
    t.controller.newGame(settings());
    for (const uci of ['e2e4', 'd1h5', 'h5f7']) {
      t.move(uci);
      await t.controller.idle();
    }
    t.controller.resign();
    await t.controller.idle();
    const earlier = t.store.game.value!.id;
    // Another first move: the positions of the earlier game are known to the analysis already.
    bot.moves = ['d7d5'];
    t.analysis.manual = true;
    t.controller.newGame(settings({ rateOpponent: true }));
    await tick();
    t.move('d2d4');
    for (let i = 0; i < 5; i++) await tick();
    expect(t.store.plies.value).toHaveLength(1);
    t.controller.openGame(earlier, { from: 'menu' });
    expect(t.store.viewer.value).not.toBeNull();
    await tick();
    expect(t.store.plies.value).toHaveLength(2);
  });
});

/** 1.d4 d5 2.c4 Nf6 3.cxd5, Black to move (the user's case of tests/game/nearEqual.controller.test.ts). */
const USER = fenOf('d4 d5 c4 Nf6 cxd5');
const AFTER_C6 = fenOf('d4 d5 c4 Nf6 cxd5 c6');
const USER_LINES: [string, PvLine[]][] = [
  [
    USER,
    [
      pv(cp(-57), 'c7c6 d5c6 b8c6 g1f3 e7e5 d4e5'),
      pv(cp(-67), 'c7c5 e2e4 f6e4 d4c5 d8a5 c1d2'),
      pv(cp(-69), 'g7g6 g1f3 f8g7 d1a4 c7c6 d5c6'),
    ],
  ],
  [fenOf('d4 d5 c4 Nf6 cxd5 Nxd5'), [pv(cp(85), 'e2e4 d5f6 b1c3 e7e5')]],
  [AFTER_C6, [pv(cp(62), 'd5c6 b8c6 g1f3 e7e5')]],
];
/** 3. cxd5 rated a mistake: the position before it, where White keeps +3 with Nc3, Nf3 or e3. */
const BEFORE_CXD5: [string, PvLine[]] = [
  fenOf('d4 d5 c4 Nf6'),
  [
    { ...pv(cp(300), 'b1c3 e7e6 c1g5 f8e7'), multipv: 1 },
    { ...pv(cp(280), 'g1f3 e7e6 b1c3 f8e7'), multipv: 2 },
    { ...pv(cp(260), 'e2e3 e7e6 b1c3 f8e7'), multipv: 3 },
  ],
];
const FINE = 'Your Nxd5 was fine: c6, c5 and g6 were only slightly better.';

describe('the near-equal second opinion comes before the verdict, so its words never change', () => {
  async function userCase(over: Partial<GameSettings> = {}, lines = USER_LINES) {
    const bot = new ScriptedBot(['d2d4', 'c2c4', 'c4d5', 'e2e4']);
    const t = await setup({ bot, lines });
    t.controller.newGame(settings({ playerColor: 'b', ...over }));
    await t.controller.idle();
    for (const uci of ['d7d5', 'g8f6']) {
      t.move(uci);
      await t.controller.idle();
    }
    t.analysis.manual = true;
    // Every verdict on 3… Nxd5 the store ever held, and the coach's subject from the verdict on.
    const verdicts: string[] = [];
    const subjects: string[] = [];
    const stop = t.store.plies.subscribe((ps) => {
      const cl = ps[5]?.classification;
      const v = cl ? `${cl.cls}${cl.nearBest ? ' near' : ''}` : '';
      if (v && verdicts.at(-1) !== v) verdicts.push(v);
    });
    const stopCoach = t.store.coach.subscribe((c) => {
      if (t.store.plies.peek()[5]?.classification && subjects.at(-1) !== c.subject) subjects.push(c.subject ?? '');
    });
    expect(t.move('f6d5')).toBe(true);
    return {
      ...t,
      verdicts,
      subjects,
      stop: () => {
        stop();
        stopCoach();
      },
    };
  }

  it('the verdict says "Your Nxd5 was fine" at once, with the small search asked first, and the reply follows', async () => {
    const t = await userCase();
    const mark = t.analysis.searches.length;
    await t.finishUntil(t.verdict(5));
    // The second opinion was searched before the verdict, with its own, smaller budget.
    const asked = t.analysis.searches.slice(mark).find((x) => fenKey(x.fen) === fenKey(AFTER_C6))!;
    expect(asked.opts).toMatchObject({ multiPv: SECOND_OPINION.multiPv, nodes: SECOND_OPINION.maxNodes });
    expect(t.store.plies.value[5].classification).toMatchObject({ cls: 'good', nearBest: true });
    expect(t.store.coach.value.title).toBe('3… Nxd5 is good');
    expect(t.store.coach.value.lines).toContain(FINE);
    await t.finishUntil(() => t.store.plies.value.length === 7);
    await t.finishUntil(t.verdict(6));
    t.stop();
    // Never "c6 was slightly more accurate" first: one verdict, never worded again.
    expect(t.verdicts).toEqual(['good near']);
  });

  it('rate opponent on: "You punished it!" comes with the verdict, and the panel stays on your move until the reply', async () => {
    const t = await userCase({ rateOpponent: true }, [...USER_LINES, BEFORE_CXD5]);
    expect(t.store.plies.value[4].classification?.cls).toMatch(/^(mistake|blunder|miss)$/);
    await t.finishUntil(t.verdict(5));
    expect(t.store.coach.value).toMatchObject({ subject: 'you', title: '3… Nxd5 is good' });
    expect(t.store.coach.value.lines[0]).toBe(PUNISHED_LINE);
    await t.finishUntil(() => t.store.plies.value.length === 7);
    await t.finishUntil(t.verdict(6));
    t.stop();
    // Your move (it punished the mistake) stays expanded: never the opponent's, then yours again.
    expect(t.subjects).toEqual(['you']);
    expect(t.verdicts).toEqual(['good near']);
  });
});

describe('the analysis engine’s order (ANALYSIS_PRIORITY)', () => {
  it('your move’s searches come first: ahead of the threat probes and the opponent’s rating', async () => {
    const after = (sans: string) => fenOf(sans);
    const t = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6']) });
    t.controller.newGame(settings({ threatAlerts: true }));
    t.move('e2e4');
    await t.controller.idle();
    t.analysis.manual = true;
    t.move('g1f3');
    await t.finishUntil(() => t.store.plies.value.length === 4);
    // 2... Nc6: the threat probes (two small searches) and the rating of Nc6 are asked for...
    const nc6 = after('e4 e5 Nf3 Nc6');
    const probe = nullMoveFen(nc6)!;
    await tick();
    expect(t.analysis.searching && fenKey(t.analysis.searching)).toBe(fenKey(nc6));
    // ...and you move at once (3. Bc4): your move's searches pre-empt them.
    const mark = t.analysis.searches.length;
    t.move('f1c4');
    await t.finishUntil(t.verdict(4));
    const next = t.analysis.searches.slice(mark).map((x) => ({ fen: fenKey(x.fen), depth: x.opts.depth, multiPv: x.opts.multiPv }));
    // The position before your move (the end of Nc6's rating) and after it, nothing else first.
    expect(next[0]).toMatchObject({ fen: fenKey(nc6), depth: 14, multiPv: 3 });
    expect(next[1]).toMatchObject({ fen: fenKey(after('e4 e5 Nf3 Nc6 Bc4')), depth: 14, multiPv: 3 });
    // The probes of a position that is no longer on the board were withdrawn.
    expect(next.some((x) => x.fen === fenKey(probe))).toBe(false);
  });

  it('the priorities: your verdict, what you wait for on screen, the opponent', () => {
    expect(ANALYSIS_PRIORITY.verdict).toBeGreaterThan(ANALYSIS_PRIORITY.user);
    expect(ANALYSIS_PRIORITY.user).toBeGreaterThan(ANALYSIS_PRIORITY.opponent);
    // The review, the explorer, the game viewer and the Openings section ask with the default, 0.
    expect(ANALYSIS_PRIORITY.opponent).toBeGreaterThan(0);
  });

  /**
   * 1. e4 e5: e5 is listed third at -1.50 (Black's view) but its own search says -0.20, so whether it
   * is a mistake takes the class-changing second opinion (the position after the best move, 1… c5).
   */
  const DISPUTED: [string, PvLine[]][] = [
    [
      fenOf('e4'),
      [
        { ...pv(cp(-20), 'c7c5 g1f3'), multipv: 1 },
        { ...pv(cp(-60), 'd7d5 e4d5'), multipv: 2 },
        { ...pv(cp(-150), 'e7e5 g1f3'), multipv: 3 },
      ],
    ],
    [fenOf('e4 e5'), [pv(cp(20), 'g1f3 b8c6')]],
    [fenOf('e4 c5'), [pv(cp(20), 'g1f3 d7d6')]],
  ];
  const AFTER_C5 = fenKey(fenOf('e4 c5'));

  /** You (White) play 1. e4; the bot's 1… e5 lands with its rating's searches left to the test. */
  async function disputed() {
    const t = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6']), lines: DISPUTED });
    t.controller.newGame(settings({ rateOpponent: true }));
    await t.controller.idle();
    const svc = (t.controller as unknown as { analysis: { ensure: (fen: string, o: EnsureOptions) => Promise<unknown> } }).analysis;
    const asked: { fen: string; priority: number }[] = [];
    const ensure = svc.ensure.bind(svc);
    svc.ensure = (fen, o) => {
      asked.push({ fen: fenKey(fen), priority: o.priority ?? 0 });
      return ensure(fen, o);
    };
    t.analysis.manual = true;
    t.move('e2e4');
    await t.finishUntil(() => t.store.plies.value.length === 2);
    return { ...t, asked };
  }

  it('an earlier move’s search that your verdict waits for is asked with your verdict’s priority', async () => {
    const t = await disputed();
    // You answer at once (2. Nf3), while e5's own rating is still searching.
    t.move('g1f3');
    await t.finishUntil(t.verdict(2));
    // e5's second opinion is asked with your verdict's priority (its verdict comes first: the queue
    // goes in order), not the opponent's.
    const second = t.asked.filter((x) => x.fen === AFTER_C5);
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((x) => x.priority === ANALYSIS_PRIORITY.verdict)).toBe(true);
  });

  it('…and one already running when you move keeps running, rather than being cut short by your move’s searches', async () => {
    const t = await disputed();
    // e5's rating reaches its second opinion before you move: asked with the opponent's priority.
    await t.finishUntil(() => !!t.analysis.searching && fenKey(t.analysis.searching) === AFTER_C5);
    expect(t.asked.filter((x) => x.fen === AFTER_C5).map((x) => x.priority)).toEqual([ANALYSIS_PRIORITY.opponent]);
    const runs = () => t.analysis.searches.filter((x) => fenKey(x.fen) === AFTER_C5).length;
    expect(runs()).toBe(1);
    t.move('g1f3');
    await tick();
    // Asked again with your verdict's priority: the search goes on.
    expect(fenKey(t.analysis.searching!)).toBe(AFTER_C5);
    await t.finishUntil(t.verdict(2));
    expect(runs()).toBe(1);
    expect(t.verdict(1)()).toBe(true);
  });
});

describe('the verdict on the screen before the reply (FEEDBACK_LEAD_MS)', () => {
  it('the bot ready first: the reply comes a lead after the verdict, not in the same moment', async () => {
    expect(FEEDBACK_LEAD_MS).toBeGreaterThanOrEqual(400);
    expect(FEEDBACK_LEAD_MS).toBeLessThan(FEEDBACK_HOLD_MS);
    const t = await heldReply({ leadMs: 120 });
    await t.finishUntil(t.verdict(0));
    const shown = Date.now();
    // The verdict is up on its own: the bot still "thinking".
    await sleep(40);
    expect(t.store.plies.value).toHaveLength(1);
    expect(t.store.botThinking.value).toBe(true);
    expect(t.store.coach.value.title).toBe('1. e4 is a book move');
    await waitFor(() => t.store.plies.value.length === 2);
    expect(Date.now() - shown).toBeGreaterThanOrEqual(110);
  });

  it('no lead added when the verdict has been up that long during the bot’s own think time', async () => {
    const bot = new ScriptedBot(['e7e5']);
    bot.manual = true;
    const t = await heldReply({ bot, leadMs: 60 });
    await t.finishUntil(t.verdict(0));
    await sleep(80);
    bot.release();
    await tick();
    await tick();
    expect(t.store.plies.value).toHaveLength(2);
  });

  it('the bot ready a moment after the verdict: only what is left of the lead', async () => {
    const bot = new ScriptedBot(['e7e5']);
    bot.manual = true;
    const t = await heldReply({ bot, leadMs: 150 });
    await t.finishUntil(t.verdict(0));
    const shown = Date.now();
    await sleep(60);
    bot.release();
    await waitFor(() => t.store.plies.value.length === 2);
    const at = Date.now() - shown;
    expect(at).toBeGreaterThanOrEqual(140);
    expect(at).toBeLessThan(400);
  });

  it('within the cap: a verdict that came late does not add a whole lead beyond it', async () => {
    const t = await heldReply({ holdMs: 150, leadMs: 10_000 });
    const start = Date.now();
    await t.finishUntil(t.verdict(0));
    await waitFor(() => t.store.plies.value.length === 2);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('during the lead: Undo drops the reply; switching the coach off lets it come at once', async () => {
    const t = await heldReply({ leadMs: 10_000 });
    await t.finishUntil(t.verdict(0));
    expect(t.controller.undo()).toBe(true);
    await sleep(20);
    expect(t.store.plies.value).toHaveLength(0);
    expect(t.store.botThinking.value).toBe(false);

    const u = await heldReply({ leadMs: 10_000 });
    await u.finishUntil(u.verdict(0));
    await sleep(20);
    expect(u.store.plies.value).toHaveLength(1);
    u.controller.toggleCoach();
    await tick();
    expect(u.store.plies.value).toHaveLength(2);
  });

  it('a move whose check threw: marked as not checked, and the replies that follow are not held for good', async () => {
    const t = await setup({ bot: new ScriptedBot(['e7e5', 'b8c6', 'g8f6']), holdMs: 60_000 });
    t.controller.newGame(settings());
    t.move('e2e4');
    await t.controller.idle();
    explainThrows.uci = 'g1f3';
    try {
      t.move('g1f3');
      await waitFor(() => t.store.plies.value.length === 4);
      const g = t.store.game.value!;
      expect(t.store.failedAnnotations.value.has(annotationKey(g.id, t.store.plies.value[2]))).toBe(true);
      t.controller.selectCoachFeedback('you');
      expect(t.store.coach.value.title).toBe('Couldn’t check Nf3');
      // The queue moved on: the next move gets its verdict, and its reply is not held to the cap.
      t.move('f1c4');
      await waitFor(() => t.store.plies.value.length === 6);
      expect(t.verdict(4)()).toBe(true);
    } finally {
      explainThrows.uci = null;
    }
  });
});

describe('with rate opponent on, the panel follows the game forward (dual coach)', () => {
  /** 1. e4 e5 2. Nf3, rated; `reply`: the bot's 2… Nc6 played (and rated) too. */
  function dual(reply: boolean, over: Partial<Classification> = {}) {
    const c = new Chess();
    const cl = (cls: Classification['cls'], san: string): Classification => ({
      cls,
      winBefore: 0.5,
      winAfter: 0.5,
      winLoss: 0,
      accuracy: 100,
      bestMoveUci: null,
      bestMoveSan: null,
      playedMoveSan: san,
    });
    const sans = reply ? ['e4', 'e5', 'Nf3', 'Nc6'] : ['e4', 'e5', 'Nf3'];
    const plies: Ply[] = sans.map((san, index) => {
      const fenBefore = c.fen();
      const m = c.move(san);
      return {
        index,
        color: m.color,
        san: m.san,
        uci: m.from + m.to,
        fenBefore,
        fenAfter: c.fen(),
        evalWhite: cp(20),
        evalDepth: 14,
        classification: { ...cl('good', m.san), ...(index === 2 ? over : {}) },
        explanation: { headline: `${m.san} is a fine move.`, details: [] },
      };
    });
    const state = createState({ settings: { ...DEFAULT_SETTINGS, rateOpponent: true }, profile: defaultProfile() });
    const bot = customPersona(400);
    state.game.value = {
      id: 'g1',
      startFen: plies[0].fenBefore,
      playerColor: 'w',
      bot,
      botElo: bot.elo,
      startedAt: new Date(0).toISOString(),
      assisted: true,
      settings: { ...DEFAULT_SETTINGS, playerColor: 'w', rateOpponent: true },
    };
    state.plies.value = plies;
    state.phase.value = 'playing';
    state.coachMode.value = { kind: 'feedback', index: 2 };
    return createStore(state);
  }

  it('your move while it is the latest (its verdict expanded, the reply still to come)', () => {
    const v = dual(false).coach.value;
    expect(v).toMatchObject({ subject: 'you', title: '2. Nf3 is good' });
    expect(v.other).toMatchObject({ subject: 'opponent' });
  });

  it('the opponent’s reply once it is played, unless your move has something to fix', () => {
    expect(dual(true).coach.value).toMatchObject({ subject: 'opponent' });
    expect(dual(true, { cls: 'mistake', winLoss: 0.15 }).coach.value).toMatchObject({ subject: 'you' });
  });
});
