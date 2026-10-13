/**
 * Try again from Game Review's key moments in the controller and the store: the position before your
 * weak move with you to move; the move made in the game, a move that is no better (taken back, "Not
 * quite — try again"), hints (the piece, then its square), a better move (the best, or about as good),
 * Show answer, Next mistake, Play on from here (an unrated game from that position, the earlier game
 * left as it was), Back, an earlier game from the history, and Pro.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { MoveClass } from '../../src/analysis/types';
import { personaById } from '../../src/bot/personas';
import { GameController, type BotLike } from '../../src/game/controller';
import { createEntitlements, type Entitlements } from '../../src/game/entitlements';
import { GAME_KEY, loadGame, loadSettings, sanitizeSavedGame } from '../../src/game/persistence';
import { FOUND_BEST_LINE, FOUND_NEAR_LINE, NOT_QUITE, SAME_MOVE_LINE, type PracticeGame } from '../../src/game/practice';
import { practiceGameLabel, practiceStartLine } from '../../src/game/store';
import { DEFAULT_SETTINGS, type GameSettings, type Ply, type PromotionPiece } from '../../src/game/types';
import { loadProfile } from '../../src/rating/rating';
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
  const sound = new RecordingSound();
  let n = 0;
  const controller = new GameController({
    createEngines: async () => engines.set,
    onlineEvents: null,
    storage,
    sound,
    thinkDelay: false,
    now: () => NOW,
    createId: () => `game-${++n}`,
    rng: () => 0.3,
    ...(o.bot ? { createBot: () => o.bot! } : {}),
    ...(o.entitlements ? { entitlements: o.entitlements } : {}),
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

const move = (c: GameController, uci: string) => c.practiceMove(uci.slice(0, 2), uci.slice(2, 4), uci[4] as PromotionPiece | undefined);

/**
 * 1. e4 e5 2. Qh5 Nc6 3. Qxf7+?? Kxf7, resigned and reviewed: your blunder (ply 4) is a key moment.
 * In the fake engine's eyes 3. c4 is the best move there (3. d3, Bc4 and Qf5 tie with it, 3. Nc3 is a
 * centipawn behind), and 3. Qxe5+ hangs the queen too.
 */
async function reviewed(o: { entitlements?: Entitlements; storage?: MemoryStorage; settings?: Partial<GameSettings> } = {}) {
  const bot = new ScriptedBot(['e7e5', 'b8c6', 'e8f7']);
  const s = setup({ bot, ...o });
  await s.controller.boot();
  s.controller.newGame(settings(o.settings));
  for (const uci of ['e2e4', 'd1h5', 'h5f7']) {
    expect(s.controller.playerMove(uci.slice(0, 2), uci.slice(2, 4)), uci).toBe(true);
    await s.controller.idle();
  }
  s.controller.resign();
  await s.controller.startReview();
  expect(s.store.plies.value[4]).toMatchObject({ san: 'Qxf7+', classification: { cls: 'blunder' } });
  return s;
}

const BLUNDER_FEN = () => new Chess('r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3').fen();

describe('Try again: in Game Review', () => {
  it('your weak key moments offer it (the opponent’s do not), also from the coach on the move', async () => {
    const { controller, store } = await reviewed();
    expect(store.tryAgainMoments.value).toEqual(new Set([4]));
    expect(store.review.value?.keyMoments).toEqual([expect.objectContaining({ index: 4, san: 'Qxf7+', tryAgain: true })]);
    controller.goTo(5);
    expect(store.coach.value.actions[0]).toEqual({ id: 'tryAgain', label: 'Try again', primary: true });
    expect(store.coach.value.actions.map((a) => a.id)).toEqual(['tryAgain', 'showBest']);
    controller.goTo(6);
    expect(store.coach.value.actions.map((a) => a.id)).not.toContain('tryAgain');
    // Not a key moment of yours: nothing happens.
    expect(controller.tryAgain(5)).toBe(false);
    expect(controller.tryAgain(0)).toBe(false);
    expect(store.practice.value).toBeNull();
    // From the coach's action on the move.
    controller.goTo(5);
    controller.runAction('tryAgain');
    expect(store.practice.value).toMatchObject({ index: 4, status: 'waiting' });
  });

  it('until the better move is shown (Show best, or a try that ended), the comment and the board do not give it away', async () => {
    const { controller, store } = await reviewed();
    controller.goTo(5);
    let c = store.coach.value;
    expect(c.title).toBe('3. Qxf7+ is a blunder');
    expect(c.lines[0]).toBe('Qxf7+ grabs a pawn, but it hangs your queen on f7.');
    expect(c.lines.join(' ')).not.toMatch(/Best was|\bc4\b/);
    expect(store.board.value.arrows ?? []).toEqual([]);
    // Show best: the answer, and from now on the comment names it, with its arrow.
    controller.runAction('showBest');
    expect(store.coachMode.value.kind).toBe('showBest');
    controller.goTo(4);
    controller.goTo(5);
    c = store.coach.value;
    expect(c.lines.join(' ')).toMatch(/Best was c4/);
    expect(store.board.value.arrows?.[0]).toEqual({ from: 'c2', to: 'c4', brush: 'best' });
    expect(c.actions.map((a) => a.id)).toEqual(['tryAgain', 'showBest']);
  });

  it('a try that ends (here with Show answer) shows the answer in the review afterwards; Flip turns the try’s board only', async () => {
    const { controller, store } = await reviewed();
    controller.tryAgain(4);
    controller.flip();
    expect(store.board.value.orientation).toBe('black');
    expect(store.flipped.value).toBe(false);
    controller.practiceShowAnswer();
    await controller.idle();
    controller.exitPractice();
    expect(store.board.value.orientation).toBe('white'); // the review's board as it was
    controller.goTo(5);
    expect(store.coach.value.lines.join(' ')).toMatch(/Best was c4/);
  });

  it('sets up the position before the move, you to move; nothing names the answer; the review comes back as it was', async () => {
    const { controller, store } = await reviewed();
    const view = store.viewIndex.value;
    expect(controller.tryAgain(4)).toBe(true);
    expect(store.review.value).toBeNull(); // the panel is the try's
    const b = store.board.value;
    expect(b.fen).toBe(BLUNDER_FEN());
    expect(b.movableColor).toBe('white');
    expect(b.orientation).toBe('white');
    expect(b.lastMove).toEqual(['b8', 'c6']);
    expect(b.arrows ?? []).toEqual([]);
    expect(b.session).toMatch(/^practice:/);
    const c = store.coach.value;
    expect(c).toMatchObject({ kind: 'practice', title: 'Find a better move than Qxf7+', busy: false });
    expect(c.lines).toEqual(['In the game you played 3. Qxf7+, a blunder.', 'Qxf7+ grabs a pawn, but it hangs your queen on f7.']);
    expect(c.actions.map((a) => a.id)).toEqual(['practiceHint', 'practiceAnswer']);
    await controller.idle();
    expect(store.practice.value?.answer).toMatchObject({ uci: 'c2c4', san: 'c4' });
    expect(store.coach.value.lines.join(' ')).not.toMatch(/\bc4\b/);
    // The rest of the screen: the game up to the move, its graph there, the players, the toolbar.
    expect(store.moveList.value.plies.map((p) => p.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6']);
    expect(store.evalGraph.value.current).toBe(4);
    expect(store.topPlayer.value).toMatchObject({ name: 'Pip', active: false });
    expect(store.bottomPlayer.value).toMatchObject({ name: 'You', active: true });
    expect(store.bottomPlayer.value.unrated).toBeUndefined();
    const t = store.toolbar.value;
    expect(t.practiceExit.disabled).toBe(false);
    expect(t.practiceHint.disabled).toBe(false);
    expect(t.practiceAnswer.disabled).toBe(false);
    expect(t.practiceNext.disabled).toBe(true); // the only one
    expect(t.explore.disabled).toBe(true);
    expect(t.prev.disabled).toBe(true);
    expect(controller.canReloadNow()).toBe(false);
    // The game's own moves and views wait: no browsing, exploring or game move meanwhile.
    controller.goTo(2);
    controller.stepBack();
    expect(store.viewIndex.value).toBe(view);
    controller.requestExplore();
    expect(store.explorer.value).toBeNull();

    controller.exitPractice();
    expect(store.practice.value).toBeNull();
    expect(store.viewIndex.value).toBe(view);
    expect(store.review.value?.keyMoments[0]?.tryAgain).toBe(true);
    expect(store.board.value.session).toBe('game');
  });

  it('the move made in the game: "not quite" at once, taken back, with its arrow', async () => {
    const { controller, store, sound } = await reviewed();
    controller.tryAgain(4);
    await controller.idle();
    expect(move(controller, 'h5f7')).toBe(true);
    expect(store.practice.value).toMatchObject({ status: 'wrong', tries: 1 });
    expect(store.coach.value).toMatchObject({ title: NOT_QUITE, lines: [SAME_MOVE_LINE] });
    expect(store.board.value.fen).toBe(BLUNDER_FEN());
    expect(store.board.value.arrows).toEqual([{ from: 'h5', to: 'f7', brush: 'played' }]);
    expect(sound.played.at(-1)).toBe('illegal');
    // An illegal move is refused.
    expect(move(controller, 'h5h1')).toBe(false);
  });

  it('a move that is no better: checked on the board, then taken back with its verdict and why (never the answer)', async () => {
    const { controller, store, sound } = await reviewed();
    controller.tryAgain(4);
    await controller.idle();
    expect(move(controller, 'h5e5')).toBe(true);
    // Checking: the move on the board, nothing movable, the panel busy.
    expect(store.practice.value?.status).toBe('checking');
    expect(store.board.value.fen).not.toBe(BLUNDER_FEN());
    expect(store.board.value.lastMove).toEqual(['h5', 'e5']);
    expect(store.board.value.movableColor).toBeUndefined();
    expect(store.coach.value).toMatchObject({ title: 'Checking Qxe5+…', busy: true, actions: [] });
    expect(store.toolbar.value.practiceHint.disabled).toBe(true);
    await controller.idle();
    expect(store.practice.value).toMatchObject({ status: 'wrong', tries: 1, tried: { uci: 'h5e5', rating: { classification: { cls: 'blunder' } } } });
    const c = store.coach.value;
    expect(c.title).toBe(NOT_QUITE);
    expect(c.lines).toEqual(['Qxe5+ is a blunder.', 'Qxe5+ grabs a pawn, but it hangs your queen on e5.']);
    expect(store.board.value.fen).toBe(BLUNDER_FEN());
    expect(store.board.value.movableColor).toBe('white');
    expect(store.board.value.arrows).toEqual([{ from: 'h5', to: 'e5', brush: 'played' }]);
    expect(sound.played.at(-1)).toBe('illegal');
  });

  it('hints: the piece, then its square with a circle on it; then a move about as good as the best', async () => {
    const { controller, store } = await reviewed();
    controller.tryAgain(4);
    await controller.idle();
    controller.practiceHint();
    expect(store.coach.value.lines[0]).toBe('Hint: move a pawn.');
    controller.runAction('practiceHint');
    // The latest hint replaces the first, and leads (a one-row panel shows it).
    expect(store.coach.value.lines).toEqual(['Hint: move the pawn on c2.', 'In the game you played 3. Qxf7+, a blunder.', 'Qxf7+ grabs a pawn, but it hangs your queen on f7.']);
    expect(store.board.value.arrows).toEqual([{ from: 'c2', to: 'c2', brush: 'best' }]);
    expect(store.coach.value.actions.map((a) => a.id)).toEqual(['practiceAnswer']);
    expect(store.toolbar.value.practiceHint.disabled).toBe(true);
    controller.practiceHint(); // no third
    expect(store.practice.value?.hint).toBe(2);

    // Nc3 is a centipawn behind c4: about as good.
    expect(move(controller, 'b1c3')).toBe(true);
    await controller.idle();
    expect(store.practice.value?.status).toBe('solved');
    const c = store.coach.value;
    expect(c.lines[0]).toBe(FOUND_NEAR_LINE);
    // The success is the title (a one-row panel shows it); the move's verdict is the next line.
    expect(c.title).toBe('You found it: 3. Nc3');
    expect(c.lines[1]).toMatch(/^3\. Nc3 is /);
    expect(store.board.value.badge?.square).toBe('c3');
  });

  it('the best move: praised with the coach’s explanation; then Play on from here or back', async () => {
    const { controller, store, sound } = await reviewed();
    controller.tryAgain(4);
    await controller.idle();
    expect(move(controller, 'c2c4')).toBe(true);
    await controller.idle();
    const c = store.coach.value;
    expect(c).toMatchObject({ kind: 'practice', title: 'You found it: 3. c4', cls: 'best' });
    expect(c.lines[0]).toBe(FOUND_BEST_LINE);
    expect(c.lines).not.toContain('3. c4 is the best move.'); // "best" twice says nothing new
    // Play on from here in the toolbar too, in place of the hint and the answer.
    expect(store.toolbar.value.practicePlayOn.disabled).toBe(false);
    expect(c.lines.at(-1)).toBe('That was your only mistake in this game.');
    expect(c.actions).toEqual([
      { id: 'practicePlayOn', label: 'Play on from here' },
      { id: 'practiceExit', label: 'Back to review', primary: true },
    ]);
    expect(store.board.value).toMatchObject({ lastMove: ['c2', 'c4'], badge: { square: 'c4', cls: 'best' } });
    expect(store.board.value.movableColor).toBeUndefined();
    expect(store.moveList.value.plies.map((p) => p.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'c4']);
    expect(sound.played.at(-1)).toBe('notify');
    // The game itself is as it was.
    expect(store.plies.value.map((p) => p.san)).toEqual(['e4', 'e5', 'Qh5', 'Nc6', 'Qxf7+', 'Kxf7']);
    controller.runAction('practiceExit');
    expect(store.practice.value).toBeNull();
    expect(store.phase.value).toBe('review');
  });

  it('Show answer: the best move and why, the move in the game, both arrows', async () => {
    const { controller, store } = await reviewed();
    controller.tryAgain(4);
    await controller.idle();
    controller.runAction('practiceAnswer');
    const c = store.coach.value;
    expect(c).toMatchObject({ kind: 'practice', title: 'Best was c4', cls: 'best' });
    expect(c.lines).toContain('In the game you played 3. Qxf7+, a blunder.');
    expect(c.lines[0]).toMatch(/c4/);
    expect(store.board.value.arrows).toEqual([
      { from: 'h5', to: 'f7', brush: 'played' },
      { from: 'c2', to: 'c4', brush: 'best' },
    ]);
    expect(store.board.value.movableColor).toBeUndefined();
    expect(move(controller, 'c2c4')).toBe(false);
    expect(store.toolbar.value.practiceAnswer.disabled).toBe(true);
  });

  it('after the game (not in the review) it goes back to the game; Escape-like exits from anywhere', async () => {
    const { controller, store } = await reviewed();
    controller.exitReview();
    expect(store.phase.value).toBe('over');
    controller.goTo(5);
    expect(store.coach.value.actions[0]?.id).toBe('tryAgain');
    controller.runAction('tryAgain');
    controller.practiceShowAnswer();
    await controller.idle();
    expect(store.coach.value.actions.at(-1)).toEqual({ id: 'practiceExit', label: 'Back to game', primary: true });
    controller.exitPractice();
    expect(store.viewIndex.value).toBe(5);
    // A new review, or leaving it, ends a try too.
    controller.tryAgain(4);
    await controller.startReview();
    expect(store.practice.value).toBeNull();
    controller.tryAgain(4);
    controller.exitReview();
    expect(store.practice.value).toBeNull();
  });
});

describe('Try again: Play on from here', () => {
  it('an unrated game against the same bot from the position before the move; the earlier game, the rating and your New game choices stay', async () => {
    const { controller, store, storage } = await reviewed({ settings: { botId: 'pip', botElo: 100, playerColor: 'random' } });
    const before = loadProfile(storage);
    const old = store.game.value!;
    const defaults = loadSettings(storage);
    controller.tryAgain(4);
    await controller.idle();
    move(controller, 'c2c4');
    await controller.idle();
    controller.runAction('practicePlayOn');
    await controller.idle();
    const g = store.game.value!;
    expect(g.id).not.toBe(old.id);
    expect(store.practice.value).toBeNull();
    expect(store.phase.value).toBe('playing');
    expect(g).toMatchObject({ startFen: BLUNDER_FEN(), playerColor: 'w', botElo: 100, assisted: true, practice: { from: '3. Qxf7+' } });
    expect(g.bot.id).toBe('pip');
    expect(store.plies.value).toEqual([]);
    expect(store.humanToMove.value).toBe(true);
    expect(store.bottomPlayer.value.unrated).toBe(true);
    expect(store.coach.value.lines[0]).toBe(practiceStartLine({ from: '3. Qxf7+' }));
    expect(practiceStartLine({ from: '3. Qxf7+' })).toBe('You’re playing on from your earlier game, before 3. Qxf7+. This game is unrated.');
    // Nothing else changed: the history, the rating, the New game defaults.
    expect(loadProfile(storage)).toEqual(before);
    expect(loadSettings(storage)).toEqual(defaults);
    // Saved as such: a restore and a rematch keep it (unrated, same position).
    expect(loadGame(storage)?.practice).toEqual({ from: '3. Qxf7+' });
    const raw = JSON.parse(storage.getItem(GAME_KEY)!) as Record<string, unknown>;
    expect(sanitizeSavedGame({ ...raw, practice: { from: 3 } })?.practice).toBeUndefined();
    expect(sanitizeSavedGame({ ...raw, practice: 'x' })?.practice).toBeUndefined();
    const again = setup({ bot: new ScriptedBot(), storage });
    await again.controller.boot();
    expect(again.store.game.value).toMatchObject({ id: g.id, assisted: true, practice: { from: '3. Qxf7+' } });
    again.controller.dispose();
    controller.resign();
    expect(store.ratingChange.value?.rated).toBe(false);
    expect(store.sheets.value.gameOver?.practiceLabel).toBe('Practice from move 3');
    expect(practiceGameLabel({ from: '12… Nf6' })).toBe('Practice from move 12');
    expect(controller.exportPgn()).toContain('[Event "Practice from move 3"]');
    controller.rematch();
    expect(store.game.value).toMatchObject({ startFen: BLUNDER_FEN(), assisted: true, practice: { from: '3. Qxf7+' } });
  });
});

/** An earlier game "from the history": plies with their classes (two weak moves of yours). */
function archived(): PracticeGame {
  const chess = new Chess();
  const moves = ['e4', 'e5', 'Qh5', 'Nc6', 'Qxf7+', 'Kxf7', 'd4', 'Nxd4'];
  const classes: MoveClass[] = ['book', 'book', 'inaccuracy', 'best', 'blunder', 'best', 'blunder', 'best'];
  const plies: Ply[] = moves.map((san, index) => {
    const mv = chess.move(san);
    return {
      index,
      color: mv.color,
      san: mv.san,
      uci: mv.from + mv.to,
      fenBefore: mv.before,
      fenAfter: mv.after,
      classification: {
        cls: classes[index],
        winBefore: 0.5,
        winAfter: 0.5,
        winLoss: 0,
        accuracy: 50,
        bestMoveUci: null,
        bestMoveSan: null,
        playedMoveSan: mv.san,
      },
      evalWhite: { kind: 'cp', value: 0 },
    };
  });
  return { id: 'old-1', startFen: new Chess().fen(), playerColor: 'w', bot: personaById('pip')!, botElo: 100, plies, source: 'archive' };
}

describe('Try again: any game’s moves', () => {
  it('an earlier game from the history, with Next mistake; the game on the board never changes', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot() });
    await controller.boot();
    expect(store.phase.value).toBe('setup');
    const game = archived();
    expect(controller.tryAgain(0, game)).toBe(false); // a book move
    expect(controller.tryAgain(4, game)).toBe(true);
    await controller.idle();
    expect(store.coach.value.title).toBe('Find a better move than Qxf7+');
    expect(store.coach.value.lines).toEqual(['In the game you played 3. Qxf7+, a blunder.']);
    expect(store.toolbar.value.practiceNext.disabled).toBe(false);
    controller.practiceShowAnswer();
    expect(store.coach.value.actions.map((a) => a.id)).toEqual(['practiceNext', 'practicePlayOn', 'practiceExit']);
    expect(store.coach.value.actions.at(-1)?.label).toBe('Back to review');
    controller.runAction('practiceNext');
    expect(store.practice.value).toMatchObject({ index: 6, status: 'waiting', hint: 0, tries: 0 });
    expect(store.coach.value.title).toBe('Find a better move than d4');
    expect(store.board.value.fen).toBe(game.plies[6].fenBefore);
    expect(controller.practiceNext()).toBe(false); // the last one
    await controller.idle();
    controller.practiceShowAnswer();
    expect(store.coach.value.lines.at(-1)).toBe('That was your last mistake in this game.');
    controller.exitPractice();
    expect(store.game.value).toBeNull();
    expect(store.phase.value).toBe('setup');
  });

  it('Play on from here never abandons a game you have moved in (it would count as a loss)', async () => {
    const { controller, store } = setup({ bot: new ScriptedBot(['e7e5']) });
    await controller.boot();
    controller.newGame(settings());
    expect(controller.playerMove('e2', 'e4')).toBe(true);
    await controller.idle();
    const id = store.game.value!.id;
    // While the game is rated, an earlier game's move cannot be tried (the engine's help waits).
    expect(controller.tryAgain(4, archived())).toBe(false);
    controller.setSettings({ showBestMoves: true }); // unrated now
    expect(store.game.value!.assisted).toBe(true);
    expect(controller.tryAgain(4, archived())).toBe(true);
    // The game's board is not the try's: no game move meanwhile.
    expect(controller.playerMove('d2', 'd4')).toBe(false);
    controller.practiceShowAnswer();
    await controller.idle();
    expect(store.coach.value.actions.map((a) => a.id)).not.toContain('practicePlayOn');
    expect(store.coach.value.lines).toContain('Finish the game you’re playing to play on from here.');
    expect(controller.practicePlayOn()).toBe(false);
    expect(store.toolbar.value.practicePlayOn.disabled).toBe(true);
    expect(store.game.value!.id).toBe(id);
    controller.exitPractice();
    expect(controller.playerMove('d2', 'd4')).toBe(true);
  });
});

describe('Try again: Pro', () => {
  it('locked: no Try again in the review (the key moments are locked); a refund ends a try', async () => {
    const storage = new MemoryStorage();
    const purchases = new FakePurchases();
    const entitlements = createEntitlements({ enabled: true, purchases, storage });
    ents.push(entitlements);
    purchases.unlocked.resolve(true);
    purchases.product.resolve({ id: 'pro', title: 'Pro', description: '', displayPrice: '$9.99' });
    await new Promise((r) => setTimeout(r, 0));
    expect(entitlements.isAllowed('reviewDetails')).toBe(true);
    const { controller, store } = await reviewed({ entitlements, storage });
    expect(controller.tryAgain(4)).toBe(true);
    // A refund: Game Review's details lock again, and the try ends.
    purchases.emit(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(entitlements.isAllowed('reviewDetails')).toBe(false);
    expect(store.practice.value).toBeNull();
    expect(store.tryAgainMoments.value.size).toBe(0);
    expect(store.review.value?.keyMoments).toEqual([]);
    controller.goTo(5);
    expect(store.coach.value.actions.map((a) => a.id)).not.toContain('tryAgain');
    // Asked anyway: the paywall, for Game Review's details.
    expect(controller.tryAgain(4)).toBe(false);
    expect(entitlements.paywall.value).toEqual({ open: true, feature: 'reviewDetails' });
    expect(store.practice.value).toBeNull();
  });
});
