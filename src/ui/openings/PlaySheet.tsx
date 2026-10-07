/**
 * Play an opening against the computer: which side (play the opening yourself, or face it), where
 * the game starts (from move 1 with the computer following the line, or after the line's moves),
 * whether the game shows the line's next move, and the opponent. The game follows exactly the line
 * the page showed (a guide's main line too, see `openingStart`). Opening practice games are
 * unrated. Starting closes the Openings section and starts the game.
 */
import { useEffect, useId, useMemo, useState } from 'preact/hooks';
import type { BotPersona } from '../../bot/types';
import type { Color, GameSettings } from '../../game/types';
import { dubiousPlayerMoves } from '../../openings/drill';
import { moveLabel } from '../../openings/tree';
import { IconBook } from '../icons';
import {
  abandonNote,
  choiceFromSettings,
  CUSTOM_BOT_ID,
  EloSlider,
  resolveOpponent,
  strengthLabel,
  type OpponentChoice,
} from '../NewGameSheet';
import { Sheet } from '../Sheet';
import { Toggle } from '../Toggle';
import { colorName, endsGame, movesText, nb, openingStart, type OpeningStart, type StudyLine } from './model';
import { Segmented, WarnGlyph } from './parts';

/** What the Play sheet needs from the game: the current settings, the rating, the bots and a game in progress. */
export interface PlaySetup {
  settings: GameSettings;
  rating: number;
  bots: readonly BotPersona[];
  /** A game the player has moved in is still going: starting ends it (a loss unless unrated). */
  inProgress: { rated: boolean } | null;
}

export interface PlaySheetProps {
  open: boolean;
  /** The line to play, as the page showed it (null while closed). */
  line: StudyLine | null;
  /** The start preselected: 'steer' (from move 1) or 'skip' (after the line's moves). */
  mode: 'steer' | 'skip';
  /** The side preselected (default: the side that plays the opening), e.g. the side just drilled. */
  color?: Color;
  setup: PlaySetup;
  onStart: (settings: GameSettings, opening: OpeningStart) => void;
  onClose: () => void;
}

/** The game's settings for the sheet's choices. */
export function playSettings(
  setup: Pick<PlaySetup, 'settings' | 'rating' | 'bots'>,
  playerColor: Color,
  opponent: OpponentChoice,
): GameSettings {
  const { botId, botElo } = resolveOpponent(opponent, setup.bots, setup.rating);
  return { ...setup.settings, playerColor, botId, botElo, adaptive: opponent.adaptive };
}

export function PlaySheet({ open, line, mode: initialMode, color: initialColor, setup, onStart, onClose }: PlaySheetProps) {
  const side = line?.side ?? 'w';
  // A line that ends in mate is played up to the mate, never from after it.
  const mateLine = useMemo(() => !!line && endsGame(line), [line]);
  const firstMode = mateLine ? 'steer' : initialMode;
  const [color, setColor] = useState<Color>(initialColor ?? side);
  const [mode, setMode] = useState<'steer' | 'skip'>(firstMode);
  const [showMoves, setShowMoves] = useState(true);
  const [opponent, setOpponent] = useState<OpponentChoice>(() => choiceFromSettings(setup.settings, setup.bots));
  const [changing, setChanging] = useState(false);
  const sideId = useId();
  const startId = useId();

  // Fresh choices each time the sheet opens.
  useEffect(() => {
    if (!open) return;
    setColor(initialColor ?? line?.side ?? 'w');
    setMode(firstMode);
    setShowMoves(true);
    setOpponent(choiceFromSettings(setup.settings, setup.bots));
    setChanging(false);
  }, [open, line?.id]);

  const dubious = useMemo(() => (line ? dubiousPlayerMoves({ id: line.id, uci: line.uci }, color) : []), [line, color]);
  if (!line) return null;
  const family = line.family;
  const other: Color = side === 'w' ? 'b' : 'w';
  const rating = Math.round(setup.rating);
  const resolved = resolveOpponent(opponent, setup.bots, rating);
  const persona = opponent.adaptive ? undefined : setup.bots.find((b) => b.id === opponent.selectedId);
  const who = opponent.adaptive
    ? { emoji: '🎯', name: `Match my rating`, color: 'var(--accent-strong)' }
    : persona
      ? { emoji: persona.emoji, name: persona.name, color: persona.color }
      : { emoji: '🤖', name: 'Custom', color: '#6b7b8c' };
  const abandon = abandonNote(setup.inProgress);
  const lastLabel = line.san.length ? nb(moveLabel(line.san.length - 1, line.san[line.san.length - 1])) : '';
  const start = () => onStart(playSettings({ ...setup, rating }, color, opponent), openingStart(line, mode, showMoves));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Play the ${family}`}
      class="op-play"
      footer={
        <>
          {abandon && (
            <p class="op-play-abandon" data-id="play-abandon" role="note">
              {abandon}
            </p>
          )}
          <button type="button" class="btn btn-primary op-play-start" data-id="play-start" onClick={start}>
            {abandon ? 'Resign & play' : 'Play'}
          </button>
        </>
      }
    >
      <section class="sheet-section">
        <p class="op-play-line">
          <span class="op-play-line-icon" aria-hidden="true">
            <IconBook size={16} />
          </span>
          <span>
            <strong>{line.variation && line.kind === 'catalog' ? line.name : family}</strong>
            <span class="op-play-moves">{movesText(line.san, 12)}</span>
          </span>
        </p>
      </section>

      <section class="sheet-section">
        <h3 class="sheet-label" id={sideId}>
          Play as
        </h3>
        <Segmented
          id="play-side"
          label="Play as"
          value={color === side ? 'mine' : 'face'}
          onChange={(v) => setColor(v === 'mine' ? side : other)}
          options={[
            { value: 'mine', label: `${colorName(side)}: play it` },
            { value: 'face', label: `${colorName(other)}: face it` },
          ]}
        />
        <p class="sheet-note" data-id="play-side-note">
          {color === side
            ? `You play ${colorName(side)}’s moves of the ${family}; the computer answers.`
            : `The computer plays the ${family} as ${colorName(side)}; you play ${colorName(other)} against it.`}
        </p>
        {dubious.length > 0 && (
          <p class="sheet-note op-play-warn" data-id="play-dubious" role="note">
            <WarnGlyph size={14} /> In this line {colorName(color)} plays a known mistake (
            {dubious.map((i) => nb(moveLabel(i, line.san[i] ?? ''))).join(', ')}): it shows how the mistake gets punished. You
            can play the other side instead.
          </p>
        )}
      </section>

      <section class="sheet-section">
        <h3 class="sheet-label" id={startId}>
          Start
        </h3>
        {mateLine ? (
          <p class="sheet-note" data-id="play-mode-note">
            This line ends in checkmate, so the game starts from move 1: the computer plays the line’s moves for its side
            while you play yours.
          </p>
        ) : (
          <>
            <Segmented
              id="play-mode"
              label="Start"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'steer', label: 'From move 1' },
                { value: 'skip', label: 'After the line' },
              ]}
            />
            <p class="sheet-note" data-id="play-mode-note">
              {mode === 'steer'
                ? 'Recommended. The computer plays the line’s moves for its side while you play yours.'
                : `The line’s moves are played for you; the game starts after ${lastLabel}.`}
            </p>
          </>
        )}
        {mode === 'steer' && (
          <div class="sheet-group op-play-toggle">
            <Toggle
              id="showLineMoves"
              label="Show the line’s moves as I play"
              description="The game shows the next move of the line for you"
              checked={showMoves}
              onChange={setShowMoves}
              icon={<IconBook />}
              iconColor="var(--cls-book)"
            />
          </div>
        )}
      </section>

      <section class="sheet-section">
        <h3 class="sheet-label">Opponent</h3>
        <div class="sheet-group op-play-opp">
          <div class="op-play-opp-row">
            <span class="op-play-avatar" style={{ background: who.color }} aria-hidden="true">
              {who.emoji}
            </span>
            <span class="op-play-opp-text">
              <span class="op-play-opp-name">{who.name}</span>
              <span class="op-play-opp-elo">
                {resolved.botElo} Elo · {strengthLabel(resolved.botElo)}
              </span>
            </span>
            <button
              type="button"
              class="op-link-btn"
              data-id="play-change-opponent"
              aria-expanded={changing ? 'true' : 'false'}
              onClick={() => setChanging((c) => !c)}
            >
              {changing ? 'Done' : 'Change'}
            </button>
          </div>
          {changing && (
            <div class="op-play-opp-edit">
              <Toggle
                id="play-adaptive"
                label={`Match my rating (${rating})`}
                checked={opponent.adaptive}
                onChange={(on) =>
                  setOpponent((o) => ({ ...o, adaptive: on, selectedId: on ? o.selectedId : CUSTOM_BOT_ID, customElo: on ? o.customElo : resolved.botElo }))
                }
                icon={<span class="op-emoji-icon">🎯</span>}
                iconColor="var(--accent-strong)"
              />
              {!opponent.adaptive && (
                <div class="op-play-slider">
                  <EloSlider
                    value={resolved.botElo}
                    onChange={(v) => setOpponent((o) => ({ ...o, adaptive: false, selectedId: CUSTOM_BOT_ID, customElo: v }))}
                  />
                </div>
              )}
            </div>
          )}
        </div>
        <p class="sheet-note" data-id="play-unrated">
          Opening practice games are unrated: win or lose, your rating stays the same.
        </p>
      </section>
    </Sheet>
  );
}
