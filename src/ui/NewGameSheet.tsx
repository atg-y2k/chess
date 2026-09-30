import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { BotPersona } from '../bot/types';
import type { Color, GameSettings } from '../game/types';
import { IconChart, IconCoach, IconEye, IconSound, IconUndo } from './icons';
import { LevelPicker, type StartingLevel } from './LevelPicker';
import { Sheet } from './Sheet';
import { Toggle } from './Toggle';
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
  inProgress?: { rated: boolean } | null;
  /**
   * A brand-new player (no games yet): with `levels` and `onSetLevel`, a compact "Your level"
   * picker at the top sets the starting rating (and so "Match my rating") before the first game.
   */
  newPlayer?: boolean;
  /** Starting levels for the picker (rating/rating.ts STARTING_LEVELS). */
  levels?: readonly StartingLevel[];
  /** A level was picked: set the player's rating to it (the new rating comes back as `playerRating`). */
  onSetLevel?: (rating: number) => void;
}

/** What starting a new game does to the game in progress (null when there is none). */
export function abandonNote(inProgress: { rated: boolean } | null | undefined): string | null {
  if (!inProgress) return null;
  return inProgress.rated
    ? 'Your current game will end and count as a loss.'
    : 'Your current game will end as a loss. It is unrated, so your rating stays the same.';
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

/** Human strength descriptor for an Elo on our 100..3200 scale. */
export function strengthLabel(elo: number): string {
  if (elo < 550) return 'Beginner';
  if (elo < 1000) return 'Novice';
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
}: NewGameSheetProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial, bots));
  const scrollerRef = useRef<HTMLDivElement>(null);
  const colorLabelId = useId();
  const levelLabelId = useId();
  const rating = Math.round(playerRating);

  // Start from `initial` every time the sheet opens.
  useEffect(() => {
    if (open) setDraft(draftFrom(initial, bots));
  }, [open]);

  // Bring the selected card into view when the sheet opens (no animation).
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      const card = scroller?.querySelector<HTMLElement>('[aria-checked="true"]');
      if (!scroller || !card) return;
      scroller.scrollLeft = card.offsetLeft - (scroller.clientWidth - card.offsetWidth) / 2;
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const opponent = resolveOpponent(draft, bots, rating);
  const persona = draft.adaptive ? undefined : bots.find((b) => b.id === draft.selectedId);
  const isCustom = !draft.adaptive && !persona;
  const cardIds = [...bots.map((b) => b.id), CUSTOM_BOT_ID];

  const selectCard = (id: string) => set({ selectedId: id, adaptive: false });

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

  const start = () => onStart(settingsFromDraft(initial, draft, bots, rating));
  const abandon = abandonNote(inProgress);

  const hero = draft.adaptive
    ? {
        emoji: MATCH_EMOJI,
        color: 'var(--accent-strong)',
        name: 'Rating match',
        tagline: 'Always plays at your current rating.',
      }
    : persona
      ? { emoji: persona.emoji, color: persona.color, name: persona.name, tagline: persona.tagline }
      : { emoji: CUSTOM_EMOJI, color: CUSTOM_COLOR, name: 'Custom', tagline: 'Pick any strength from 100 to 3200.' };

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
          <LevelPicker levels={levels} value={rating} onChange={onSetLevel} labelledBy={levelLabelId} id="level" />
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
          {isCustom && <EloSlider value={draft.customElo} onChange={(v) => set({ customElo: v })} />}
        </div>

        <div class="ngs-bots" ref={scrollerRef} role="radiogroup" aria-label="Opponent" onKeyDown={onCardsKeyDown}>
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
        </div>

        <div class="sheet-group ngs-adaptive">
          <Toggle
            id="adaptive"
            label={`Match my rating (${rating})`}
            description="Opponent strength follows your rating"
            checked={draft.adaptive}
            onChange={(on) => set({ adaptive: on })}
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
      </section>

      <section class="sheet-section">
        <h3 class="sheet-label">Options</h3>
        <div class="sheet-group">
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
            description="Shows the engine's top moves"
            checked={draft.showBestMoves}
            onChange={(v) => set({ showBestMoves: v })}
            icon={<IconEye />}
            iconColor="var(--cls-brilliant)"
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
        <p class="sheet-note" data-warn={draft.showBestMoves ? '' : undefined}>
          <InfoGlyph />
          <span>
            {draft.showBestMoves
              ? 'Best-move arrows are on, so this game won’t count for your rating.'
              : 'The coach and evaluation bar are fine in rated games; takebacks, hints, Retry and best-move arrows make a game unrated.'}
          </span>
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

/** A king piece (cburnett art, as on the board) for colour choices and player avatars. */
export function KingGlyph({ color, size = 28 }: KingGlyphProps) {
  if (color === 'random') {
    return (
      <span class="king-glyph king-glyph--split" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
        <KingSvg color="w" />
        <KingSvg color="b" />
      </span>
    );
  }
  return (
    <span class="king-glyph" data-c={color} style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      <KingSvg color={color} />
    </span>
  );
}

function KingSvg({ color }: { color: Color }) {
  const white = color === 'w';
  return (
    <svg viewBox="0 0 45 45" data-c={color}>
      <g
        fill="none"
        fill-rule="evenodd"
        stroke="#000"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M22.5 11.63V6M20 8h5" stroke-linejoin="miter" />
        <path
          d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5"
          fill={white ? '#fff' : '#000'}
          stroke-linecap="butt"
          stroke-linejoin="miter"
        />
        <path
          d="M12.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-2.5-7.5-12-10.5-16-4-3 6 6 10.5 6 10.5v7"
          fill={white ? '#fff' : '#000'}
        />
        {white ? (
          <path d="M12.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0" />
        ) : (
          <path
            d="M32 29.5s8.5-4 6.03-9.65C34.15 14 25 18 22.5 24.5l.01 2.1-.01-2.1C20 18 9.906 14 6.997 19.85c-2.497 5.65 4.853 9 4.853 9M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0"
            stroke="#ececec"
          />
        )}
      </g>
    </svg>
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
