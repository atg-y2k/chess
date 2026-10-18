import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { BotPersona } from '../bot/types';
import type { Color, GameSettings } from '../game/types';
import { formatRatingDelta } from '../rating/rating';
import { IconBook, IconBotRated, IconChart, IconChevronRight, IconCoach, IconEye, IconSound, IconThreat, IconUndo } from './icons';
import { LevelPicker, type StartingLevel } from './LevelPicker';
import { IconLock } from './PaywallSheet';
import { Sheet } from './Sheet';
import { Toggle } from './Toggle';
import './skins.css';
import './NewGameSheet.css';

export interface NewGameSheetProps {
  open: boolean;
  /** Settings to start from (usually the last game's). Re-read every time the sheet opens. */
  initial: GameSettings;
  /** The player's current rating (for "Match my rating"). */
  playerRating: number;
  /** Built-in opponents, ascending Elo. A "Custom" slider option is added after them. */
  bots: BotPersona[];
  /** Receives complete settings: `botId` is a persona id with its Elo, or 'custom' with the chosen Elo. */
  onStart: (settings: GameSettings) => void;
  onClose: () => void;
  /**
   * A game is still going (the player has moved): starting a new one ends it as a loss (rated
   * unless it is already unrated). The sheet says so and the button reads "Resign & play".
   */
  inProgress?: { rated: boolean; before?: number; after?: number } | null;
  /**
   * A brand-new player (no games yet): with `levels` and `onSetLevel`, a compact "Your level"
   * picker at the top sets the starting rating before the first game, and switches the opponent
   * to "Match my rating" (unless an opponent was already picked in this sheet), so the first game
   * is against a bot of that level.
   */
  newPlayer?: boolean;
  /** Starting levels for the picker (rating/rating.ts STARTING_LEVELS). */
  levels?: readonly StartingLevel[];
  /** A level was picked: set the player's rating to it (the new rating comes back as `playerRating`). */
  onSetLevel?: (rating: number) => void;
  /**
   * Best-move arrows are part of Pro and locked: their toggle shows this line (e.g. "Part of Chess
   * Coach Pro") and a lock, stays off, and calls `onUnlock` (the paywall) instead.
   */
  arrowsLocked?: string | null;
  /** Threat alerts are part of Pro and locked: like `arrowsLocked`, with `onUnlockThreats` (the paywall). */
  threatsLocked?: string | null;
  onUnlock?: () => void;
  onUnlockThreats?: () => void;
  /** Opens the Openings section (a "Learn openings" row; omitted: none). */
  onLearnOpenings?: () => void;
}

/**
 * The New game sheet's line on rating the opponent's moves (its note says the game will be
 * unrated). It promises no explanations: those are Pro where Pro is sold.
 */
export const RATE_OPPONENT_DESCRIPTION = 'See whether the computer found the best move, rated like your moves';
/**
 * The Menu's line on the help that makes a game unrated (best-move arrows, rating the opponent's
 * moves): what it does to the rating, the next games too (they are settings). One phrasing for all.
 */
export const ASSIST_MENU_DESCRIPTION = 'Makes your games unrated while it’s on';
/** The Menu's line on rating the opponent's moves. */
export const RATE_OPPONENT_MENU_DESCRIPTION = ASSIST_MENU_DESCRIPTION;
/** The New game sheet's line on threat alerts: what they do (its note says the game will be unrated). */
export const THREAT_ALERTS_DESCRIPTION = 'Warns you when your opponent threatens something';
/** The Menu's line on them: what they do, and (as for the other help) what they do to the rating. */
export const THREAT_ALERTS_MENU_DESCRIPTION = 'Warns you of threats, and makes your games unrated while it’s on';

/**
 * The note under the options: what makes a game unrated, or that this one will be (best-move
 * arrows, threat alerts or the opponent's move ratings are on).
 */
export function unratedNote(o: { arrows: boolean; rateOpponent: boolean; threatAlerts?: boolean }): { text: string; warn: boolean } {
  const unrated = ', so this game won’t count for your rating.';
  if (o.rateOpponent && !o.arrows && !o.threatAlerts) return { text: `Your opponent’s moves are rated${unrated}`, warn: true };
  const on = [
    ...(o.arrows ? ['best-move arrows'] : []),
    ...(o.threatAlerts ? ['threat alerts'] : []),
    ...(o.rateOpponent ? ['your opponent’s move ratings'] : []),
  ];
  if (on.length) {
    const list = on.length === 1 ? on[0] : `${on.slice(0, -1).join(', ')} and ${on[on.length - 1]}`;
    return { text: `${list[0].toUpperCase()}${list.slice(1)} are on${unrated}`, warn: true };
  }
  return {
    text:
      'The coach, the evaluation bar and the explorer without its engine are fine in rated games; takebacks, hints, Retry, the explorer’s engine, best-move arrows, threat alerts and rating your opponent’s moves make a game unrated.',
    warn: false,
  };
}

/**
 * What starting a new game does to the game in progress (null when there is none), with what the
 * loss does to the rating when it is rated ("…: your rating goes from 904 to 834 (−70).").
 */
export function abandonNote(inProgress: { rated: boolean; before?: number; after?: number } | null | undefined): string | null {
  if (!inProgress) return null;
  if (!inProgress.rated) return 'Your current game will end as a loss. It is unrated, so your rating stays the same.';
  const { before, after } = inProgress;
  if (before === undefined || after === undefined) return 'Your current game will end and count as a loss.';
  return `Your current game will end and count as a loss: your rating goes from ${before} to ${after} (${formatRatingDelta(after - before)}).`;
}

/** The name a custom or rating-matched opponent has in the game ("Robot 800", bot/personas.ts `customPersona`). */
export function customOpponentName(elo: number): string {
  return `Robot ${snapElo(elo)}`;
}

export const ELO_MIN = 100;
export const ELO_MAX = 3200;
export const ELO_STEP = 50;
/** `botId` of the slider-chosen opponent (also used for "Match my rating"). */
export const CUSTOM_BOT_ID = 'custom';

/** Clamps to 100..3200 and rounds to the slider step (50). Non-finite input gives 800. */
export function snapElo(elo: number): number {
  if (!Number.isFinite(elo)) return 800;
  const snapped = Math.round(elo / ELO_STEP) * ELO_STEP;
  return Math.min(ELO_MAX, Math.max(ELO_MIN, snapped));
}

/**
 * Human strength descriptor for an Elo on our 100..3200 scale: the starting levels' names
 * (rating/rating.ts STARTING_LEVELS: Beginner 400, Casual 800, Intermediate 1200, Advanced 1600,
 * Expert 2000) for the bands around them, so one level has one name everywhere.
 */
export function strengthLabel(elo: number): string {
  if (elo < 550) return 'Beginner';
  if (elo < 1000) return 'Casual';
  if (elo < 1400) return 'Intermediate';
  if (elo < 1800) return 'Advanced';
  if (elo < 2200) return 'Expert';
  if (elo < 2500) return 'Master';
  if (elo < 3000) return 'Grandmaster';
  return 'Engine';
}

/** The opponent part of the picker state. */
export interface OpponentChoice {
  /** A persona id, or CUSTOM_BOT_ID for the slider. */
  selectedId: string;
  customElo: number;
  adaptive: boolean;
}

/**
 * Resolves the picker state to a consistent `{ botId, botElo }`: "Match my rating" gives a custom
 * opponent at the player's rating (snapped to 50), a persona gives its own Elo, and custom (or an
 * unknown id) gives the slider value.
 */
export function resolveOpponent(
  choice: OpponentChoice,
  bots: readonly BotPersona[],
  playerRating: number,
): { botId: string; botElo: number } {
  if (choice.adaptive) return { botId: CUSTOM_BOT_ID, botElo: snapElo(playerRating) };
  const bot = bots.find((b) => b.id === choice.selectedId);
  if (bot) return { botId: bot.id, botElo: bot.elo };
  return { botId: CUSTOM_BOT_ID, botElo: snapElo(choice.customElo) };
}

/** Picker state for some initial settings (unknown persona ids fall back to custom at that Elo). */
export function choiceFromSettings(s: GameSettings, bots: readonly BotPersona[]): OpponentChoice {
  const known = bots.some((b) => b.id === s.botId);
  return { selectedId: known ? s.botId : CUSTOM_BOT_ID, customElo: snapElo(s.botElo), adaptive: s.adaptive };
}

type Draft = OpponentChoice & Omit<GameSettings, 'botId' | 'botElo' | 'adaptive'>;

function draftFrom(s: GameSettings, bots: readonly BotPersona[]): Draft {
  return { ...s, ...choiceFromSettings(s, bots) };
}

/** Builds the complete settings passed to `onStart`. */
export function settingsFromDraft(
  initial: GameSettings,
  d: OpponentChoice & Partial<GameSettings>,
  bots: readonly BotPersona[],
  playerRating: number,
): GameSettings {
  const { botId, botElo } = resolveOpponent(d, bots, playerRating);
  return {
    ...initial,
    playerColor: d.playerColor ?? initial.playerColor,
    botId,
    botElo,
    adaptive: d.adaptive,
    coach: d.coach ?? initial.coach,
    showEvalBar: d.showEvalBar ?? initial.showEvalBar,
    showBestMoves: d.showBestMoves ?? initial.showBestMoves,
    rateOpponent: d.rateOpponent ?? initial.rateOpponent,
    threatAlerts: d.threatAlerts ?? initial.threatAlerts,
    sound: d.sound ?? initial.sound,
    allowTakebacks: d.allowTakebacks ?? initial.allowTakebacks,
  };
}

const CUSTOM_EMOJI = '🤖';
const CUSTOM_COLOR = '#6b7b8c';
const MATCH_EMOJI = '🎯';

/**
 * "New game" sheet: opponent picker (persona cards + custom Elo slider + "Match my rating"),
 * colour choice, assistance toggles and a big Play button.
 */
export function NewGameSheet({
  open,
  initial,
  playerRating,
  bots,
  onStart,
  onClose,
  inProgress,
  newPlayer,
  levels,
  onSetLevel,
  arrowsLocked,
  threatsLocked,
  onUnlock,
  onUnlockThreats,
  onLearnOpenings,
}: NewGameSheetProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial, bots));
  /** The player chose an opponent (card, slider or "Match my rating") since the sheet opened. */
  const opponentPicked = useRef(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const colorLabelId = useId();
  const levelLabelId = useId();
  const openingsLabelId = useId();
  const openingsDescId = useId();
  const rating = Math.round(playerRating);

  // Start from `initial` every time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setDraft(draftFrom(initial, bots));
    opponentPicked.current = false;
  }, [open]);

  // Bring the selected card into view when the sheet opens (no animation); with "Match my rating"
  // (no card selected) the carousel starts at its beginning, Custom and the weakest bots.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const card = scroller.querySelector<HTMLElement>('[aria-checked="true"]');
      scroller.scrollLeft = card ? card.offsetLeft - (scroller.clientWidth - card.offsetWidth) / 2 : 0;
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const opponent = resolveOpponent(draft, bots, rating);
  const persona = draft.adaptive ? undefined : bots.find((b) => b.id === draft.selectedId);
  const isCustom = !draft.adaptive && !persona;
  // Custom (any Elo, also "Match my rating") first: when it is the opponent, the carousel opens on it
  // and the weakest bots beside it, not on the 2200–3200 bots at the far end.
  const cardIds = [CUSTOM_BOT_ID, ...bots.map((b) => b.id)];

  const pickOpponent = (patch: Partial<Draft>) => {
    opponentPicked.current = true;
    set(patch);
  };
  const selectCard = (id: string) => pickOpponent({ selectedId: id, adaptive: false });
  // A new player's level also picks a bot of that level ("Match my rating" follows the new rating).
  const pickLevel = (r: number) => {
    onSetLevel?.(r);
    if (!opponentPicked.current) set({ adaptive: true });
  };

  const onCardsKeyDown = (e: KeyboardEvent) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const cur = cardIds.indexOf(draft.adaptive ? CUSTOM_BOT_ID : draft.selectedId);
    const next = cardIds[(cur + step + cardIds.length) % cardIds.length];
    selectCard(next);
    requestAnimationFrame(() => {
      const el = scrollerRef.current?.querySelector<HTMLElement>(`[data-bot="${next}"]`);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    });
  };

  /** Best-move arrows and threat alerts as they will be: never on while they are locked. */
  const arrowsOn = draft.showBestMoves && !arrowsLocked;
  const threatsOn = draft.threatAlerts && !threatsLocked;
  const start = () =>
    onStart(settingsFromDraft(initial, { ...draft, showBestMoves: arrowsOn, threatAlerts: threatsOn }, bots, rating));
  const abandon = abandonNote(inProgress);
  const note = unratedNote({ arrows: arrowsOn, rateOpponent: draft.rateOpponent, threatAlerts: threatsOn });

  // The opponent by the name the game gives it ("Robot 800"); the cards say how it is chosen.
  const hero = draft.adaptive
    ? {
        emoji: MATCH_EMOJI,
        color: 'var(--accent-strong)',
        name: customOpponentName(opponent.botElo),
        tagline: 'Match my rating: always plays at your current rating.',
      }
    : persona
      ? { emoji: persona.emoji, color: persona.color, name: persona.name, tagline: persona.tagline }
      : { emoji: CUSTOM_EMOJI, color: CUSTOM_COLOR, name: customOpponentName(opponent.botElo), tagline: 'Custom: pick any strength from 100 to 3200.' };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New game"
      class="ngs"
      footer={
        <>
          {abandon && (
            <p class="ngs-abandon" data-id="abandon-note" role="note">
              <InfoGlyph />
              <span>{abandon}</span>
            </p>
          )}
          <button type="button" class="btn btn-primary ngs-play" data-id="play" onClick={start}>
            {abandon ? 'Resign & play' : 'Play'}
          </button>
        </>
      }
    >
      {newPlayer && levels?.length && onSetLevel ? (
        <section class="sheet-section ngs-level">
          <div class="ngs-level-head">
            <h3 class="sheet-label" id={levelLabelId}>
              Your level
            </h3>
            <span class="ngs-level-hint">Sets your starting rating</span>
          </div>
          <LevelPicker levels={levels} value={rating} onChange={pickLevel} labelledBy={levelLabelId} id="level" />
        </section>
      ) : null}

      <section class="sheet-section" aria-label="Opponent">
        <div
          class="ngs-hero"
          data-mode={draft.adaptive ? 'adaptive' : isCustom ? 'custom' : 'bot'}
          style={{ '--ngs-tint': hero.color }}
        >
          <div class="ngs-hero-top">
            <div class="ngs-hero-avatar" style={{ background: hero.color }} aria-hidden="true">
              <span>{hero.emoji}</span>
            </div>
            <div class="ngs-hero-main">
              <div class="ngs-hero-name">{hero.name}</div>
              <div class="ngs-hero-level">{strengthLabel(opponent.botElo)}</div>
            </div>
            <div class="ngs-hero-elo" aria-label={`Elo ${opponent.botElo}`}>
              <span class="ngs-hero-elo-num">{opponent.botElo}</span>
              <span class="ngs-hero-elo-unit" aria-hidden="true">
                Elo
              </span>
            </div>
          </div>
          <p class="ngs-hero-tagline">{hero.tagline}</p>
          {isCustom && <EloSlider value={draft.customElo} onChange={(v) => pickOpponent({ customElo: v })} />}
        </div>

        <div class="ngs-bots" ref={scrollerRef} role="radiogroup" aria-label="Opponent" onKeyDown={onCardsKeyDown}>
          <BotCard
            id={CUSTOM_BOT_ID}
            emoji={CUSTOM_EMOJI}
            color={CUSTOM_COLOR}
            name="Custom"
            sub={isCustom ? String(opponent.botElo) : 'Any Elo'}
            selected={isCustom}
            focusable={isCustom || draft.adaptive}
            onSelect={selectCard}
          />
          {bots.map((b) => (
            <BotCard
              key={b.id}
              id={b.id}
              emoji={b.emoji}
              color={b.color}
              name={b.name}
              sub={String(b.elo)}
              selected={!draft.adaptive && draft.selectedId === b.id}
              focusable={draft.adaptive ? false : draft.selectedId === b.id}
              onSelect={selectCard}
            />
          ))}
        </div>

        <div class="sheet-group ngs-adaptive">
          <Toggle
            id="adaptive"
            label={`Match my rating (${rating})`}
            description="Opponent strength follows your rating"
            checked={draft.adaptive}
            onChange={(on) => pickOpponent({ adaptive: on })}
            icon={<span class="ngs-emoji-icon">🎯</span>}
            iconColor="var(--accent-strong)"
          />
        </div>
      </section>

      <section class="sheet-section">
        <h3 class="sheet-label" id={colorLabelId}>
          Play as
        </h3>
        <ColorPicker labelledBy={colorLabelId} value={draft.playerColor} onChange={(c) => set({ playerColor: c })} />
        {onLearnOpenings && (
          <button
            type="button"
            class="ngs-openings"
            data-id="learn-openings"
            aria-labelledby={openingsLabelId}
            aria-describedby={openingsDescId}
            onClick={onLearnOpenings}
          >
            <span class="ngs-openings-icon" aria-hidden="true">
              <IconBook size={18} />
            </span>
            <span class="ngs-openings-text">
              <span class="ngs-openings-label" id={openingsLabelId}>
                Learn openings
              </span>
              <span class="ngs-openings-desc" id={openingsDescId}>
                Good first moves, step by step. Then play them here.
              </span>
            </span>
            <IconChevronRight size={18} />
          </button>
        )}
      </section>

      <section class="sheet-section">
        <h3 class="sheet-label">Options</h3>
        <div
          class="sheet-group"
          data-arrows-locked={arrowsLocked ? '' : undefined}
          data-threats-locked={threatsLocked ? '' : undefined}
        >
          <Toggle
            id="coach"
            label="Coach"
            description="Rates and explains each of your moves"
            checked={draft.coach}
            onChange={(v) => set({ coach: v })}
            icon={<IconCoach />}
            iconColor="var(--accent-strong)"
          />
          <Toggle
            id="showEvalBar"
            label="Evaluation bar"
            description="Who is better, and by how much"
            checked={draft.showEvalBar}
            onChange={(v) => set({ showEvalBar: v })}
            icon={<IconChart />}
            iconColor="var(--cls-great)"
          />
          <Toggle
            id="showBestMoves"
            label="Best-move arrows"
            description={arrowsLocked || 'Shows the engine’s top moves'}
            checked={arrowsOn}
            onChange={arrowsLocked ? () => onUnlock?.() : (v) => set({ showBestMoves: v })}
            icon={arrowsLocked ? <IconLock /> : <IconEye />}
            iconColor={arrowsLocked ? 'var(--warning)' : 'var(--cls-brilliant)'}
          />
          <Toggle
            id="threatAlerts"
            label="Threat alerts"
            description={threatsLocked || THREAT_ALERTS_DESCRIPTION}
            checked={threatsOn}
            onChange={threatsLocked ? () => onUnlockThreats?.() : (v) => set({ threatAlerts: v })}
            icon={threatsLocked ? <IconLock /> : <IconThreat />}
            iconColor={threatsLocked ? 'var(--warning)' : 'var(--danger)'}
          />
          <Toggle
            id="rateOpponent"
            label="Rate opponent’s moves"
            description={RATE_OPPONENT_DESCRIPTION}
            checked={draft.rateOpponent}
            onChange={(v) => set({ rateOpponent: v })}
            icon={<IconBotRated />}
            iconColor="var(--cls-inaccuracy)"
          />
          <Toggle
            id="allowTakebacks"
            label="Takebacks"
            description="Undo a move you regret"
            checked={draft.allowTakebacks}
            onChange={(v) => set({ allowTakebacks: v })}
            icon={<IconUndo />}
            iconColor="var(--cls-mistake)"
          />
          <Toggle
            id="sound"
            label="Sound"
            checked={draft.sound}
            onChange={(v) => set({ sound: v })}
            icon={<IconSound />}
            iconColor="var(--cls-miss)"
          />
        </div>
        <p class="sheet-note" data-id="unrated-note" data-warn={note.warn ? '' : undefined}>
          <InfoGlyph />
          <span>{note.text}</span>
        </p>
      </section>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ pieces */

interface BotCardProps {
  id: string;
  emoji: string;
  color: string;
  name: string;
  sub: string;
  selected: boolean;
  /** Roving tabindex: exactly one card of the group is tabbable. */
  focusable: boolean;
  onSelect: (id: string) => void;
}

function BotCard({ id, emoji, color, name, sub, selected, focusable, onSelect }: BotCardProps) {
  return (
    <button
      type="button"
      role="radio"
      class="ngs-bot"
      aria-checked={selected ? 'true' : 'false'}
      aria-label={`${name}, ${sub}`}
      tabIndex={focusable ? 0 : -1}
      data-bot={id}
      onClick={() => onSelect(id)}
    >
      <span class="ngs-bot-avatar" style={{ background: color }} aria-hidden="true">
        <span class="ngs-bot-emoji">{emoji}</span>
        {selected && (
          <span class="ngs-bot-check">
            <svg viewBox="0 0 16 16" width="10" height="10">
              <path
                d="M3.5 8.5l3 3 6-7"
                fill="none"
                stroke="currentColor"
                stroke-width="2.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </span>
        )}
      </span>
      <span class="ngs-bot-name">{name}</span>
      <span class="ngs-bot-elo">{sub}</span>
    </button>
  );
}

export interface EloSliderProps {
  value: number;
  onChange: (elo: number) => void;
}

/**
 * Elo slider 100..3200 (step 50) with −/+ steppers. Custom-drawn so a tap on the track jumps
 * there (iOS range inputs only move by dragging the thumb) and vertical swipes still scroll the sheet.
 */
export function EloSlider({ value, onChange }: EloSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number; dragging: boolean } | null>(null);
  const v = snapElo(value);
  const pct = ((v - ELO_MIN) / (ELO_MAX - ELO_MIN)) * 100;

  const fromX = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return v;
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return snapElo(ELO_MIN + t * (ELO_MAX - ELO_MIN));
  };
  const emit = (next: number) => {
    const s = snapElo(next);
    if (s !== v) onChange(s);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const r = trackRef.current?.getBoundingClientRect();
    const thumbX = r ? r.left + (pct / 100) * r.width : 0;
    // Grabbing the thumb (or using a mouse) drags at once; elsewhere wait to see if it is a tap or a scroll.
    const onThumb = Math.abs(e.clientX - thumbX) <= 24;
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dragging: onThumb || e.pointerType === 'mouse' };
    el.setPointerCapture(e.pointerId);
    if (gesture.current.dragging && !onThumb) emit(fromX(e.clientX));
  };
  const onPointerMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    if (!g.dragging) {
      if (Math.abs(e.clientX - g.x) < 4) return;
      g.dragging = true;
    }
    emit(fromX(e.clientX));
  };
  const onPointerUp = (e: PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.id !== e.pointerId) return;
    if (!g.dragging && Math.abs(e.clientY - g.y) < 10) emit(fromX(e.clientX));
  };
  const onPointerCancel = () => {
    gesture.current = null;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const delta: Record<string, number> = {
      ArrowRight: ELO_STEP,
      ArrowUp: ELO_STEP,
      ArrowLeft: -ELO_STEP,
      ArrowDown: -ELO_STEP,
      PageUp: 4 * ELO_STEP,
      PageDown: -4 * ELO_STEP,
      Home: ELO_MIN - v,
      End: ELO_MAX - v,
    };
    if (!(e.key in delta)) return;
    e.preventDefault();
    emit(v + delta[e.key]);
  };

  return (
    <div class="ngs-slider-row">
      <button
        type="button"
        class="ngs-step"
        aria-label="Lower Elo by 50"
        disabled={v <= ELO_MIN}
        onClick={() => emit(v - ELO_STEP)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M6 12h12" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" />
        </svg>
      </button>
      <div
        class="ngs-slider"
        role="slider"
        tabIndex={0}
        aria-label="Opponent Elo"
        aria-valuemin={ELO_MIN}
        aria-valuemax={ELO_MAX}
        aria-valuenow={v}
        aria-valuetext={`${v}, ${strengthLabel(v)}`}
        data-sheet-nodrag=""
        data-id="elo-slider"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onKeyDown={onKeyDown}
      >
        <div class="ngs-slider-track" ref={trackRef}>
          <div class="ngs-slider-fill" style={{ width: `${pct}%` }} />
          <div class="ngs-slider-thumb" style={{ left: `${pct}%` }} />
        </div>
        <div class="ngs-slider-scale" aria-hidden="true">
          <span>{ELO_MIN}</span>
          <span>{ELO_MAX}</span>
        </div>
      </div>
      <button
        type="button"
        class="ngs-step"
        aria-label="Raise Elo by 50"
        disabled={v >= ELO_MAX}
        onClick={() => emit(v + ELO_STEP)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M6 12h12M12 6v12" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  );
}

type ColorChoice = Color | 'random';
const COLOR_OPTIONS: { value: ColorChoice; label: string }[] = [
  { value: 'w', label: 'White' },
  { value: 'random', label: 'Random' },
  { value: 'b', label: 'Black' },
];

function ColorPicker({
  labelledBy,
  value,
  onChange,
}: {
  labelledBy: string;
  value: ColorChoice;
  onChange: (c: ColorChoice) => void;
}) {
  const index = Math.max(
    0,
    COLOR_OPTIONS.findIndex((o) => o.value === value),
  );
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + COLOR_OPTIONS.length) % COLOR_OPTIONS.length;
    onChange(COLOR_OPTIONS[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div class="ngs-colors" role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      <span class="ngs-colors-thumb" style={{ transform: `translateX(${index * 100}%)` }} aria-hidden="true" />
      {COLOR_OPTIONS.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          class="ngs-color"
          aria-checked={i === index ? 'true' : 'false'}
          tabIndex={i === index ? 0 : -1}
          data-color={o.value}
          onClick={() => onChange(o.value)}
        >
          <KingGlyph color={o.value} size={30} />
          <span class="ngs-color-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export interface KingGlyphProps {
  /** 'random' draws half white, half black. */
  color: Color | 'random';
  size?: number;
}

/** A king piece (the chosen piece set's art, as on the board) for colour choices and player avatars. */
export function KingGlyph({ color, size = 28 }: KingGlyphProps) {
  if (color === 'random') {
    return (
      <span class="king-glyph king-glyph--split" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
        <i class="king-glyph-piece piece-art" data-p="wk" />
        <i class="king-glyph-piece piece-art" data-p="bk" />
      </span>
    );
  }
  return (
    <span class="king-glyph" data-c={color} style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      <i class="king-glyph-piece piece-art" data-p={`${color}k`} />
    </span>
  );
}

function InfoGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 11v6M12 7.5v.01" />
    </svg>
  );
}
