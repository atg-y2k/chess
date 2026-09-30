import type { ComponentChild } from 'preact';
import { useEffect, useId, useState } from 'preact/hooks';
import type { BotPersona } from '../bot/types';
import type { GameSettings } from '../game/types';
import type { GameRecord, PlayerProfile } from '../rating/types';
import { IconChart, IconCoach, IconEye, IconFlag, IconFlip, IconPlus, IconShare, IconSound } from './icons';
import { Sheet } from './Sheet';
import { Toggle } from './Toggle';
import './MenuSheet.css';

export interface MenuSheetProps {
  open: boolean;
  settings: GameSettings;
  profile: PlayerProfile;
  /** False when there is no game in progress to resign (the Resign action is disabled). */
  canResign: boolean;
  /** One toggle changed: e.g. `{ coach: false }`. */
  onChange: (partial: Partial<GameSettings>) => void;
  /** Called after the inline "Resign this game?" confirmation. */
  onResign: () => void;
  onExportPgn: () => void;
  onFlip: () => void;
  onNewGame: () => void;
  onClose: () => void;
  /** Optional personas, to show avatars in the recent-games list (matched by `botName`). */
  bots?: BotPersona[];
}

/** How many games the "Recent games" list shows. */
export const RECENT_GAMES = 10;

/** "+12", "−8" (true minus sign) or "±0". */
export function formatRatingDelta(delta: number): string {
  const d = Math.round(delta);
  if (d > 0) return `+${d}`;
  if (d < 0) return `−${-d}`;
  return '±0';
}

/** Win / draw / loss from the player's point of view. */
export function recordOutcome(r: Pick<GameRecord, 'playerScore'>): 'win' | 'draw' | 'loss' {
  return r.playerScore === 1 ? 'win' : r.playerScore === 0.5 ? 'draw' : 'loss';
}

/**
 * Compact date for the games list: "Today", "Yesterday", a weekday within the last week,
 * otherwise "Sep 28" (plus the year when it is not the current one). Invalid input gives ''.
 */
export function formatGameDate(iso: string, now: Date = new Date(), locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toLocaleDateString(locale, { weekday: 'long' });
  return d.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/**
 * In-game menu: quick actions (flip, export PGN, new game, resign with an inline confirmation),
 * display toggles, the player's rating card and the last 10 games.
 */
export function MenuSheet({
  open,
  settings,
  profile,
  canResign,
  onChange,
  onResign,
  onExportPgn,
  onFlip,
  onNewGame,
  onClose,
  bots,
}: MenuSheetProps) {
  const [confirming, setConfirming] = useState(false);
  const confirmId = useId();

  // Never reopen in the confirm state; leave it if resigning becomes impossible.
  useEffect(() => {
    if (!open || !canResign) setConfirming(false);
  }, [open, canResign]);

  const recent = profile.history.slice(0, RECENT_GAMES);

  return (
    <Sheet open={open} onClose={onClose} title="Menu" class="menu">
      <section class="sheet-section">
        <div class="menu-actions">
          <ActionTile id="flip" label="Flip board" icon={<IconFlip />} onClick={onFlip} />
          <ActionTile id="export" label="Export PGN" icon={<IconShare />} onClick={onExportPgn} />
          <ActionTile id="new" label="New game" icon={<IconPlus />} onClick={onNewGame} />
          <ActionTile
            id="resign"
            label="Resign"
            icon={<IconFlag />}
            danger
            disabled={!canResign}
            pressed={confirming}
            onClick={() => setConfirming((c) => !c)}
          />
        </div>
        {confirming && (
          <div class="menu-confirm" role="group" aria-labelledby={confirmId}>
            <div class="menu-confirm-text" id={confirmId}>
              <strong>Resign this game?</strong>
              <span>It counts as a loss.</span>
            </div>
            <div class="menu-confirm-btns">
              <button type="button" class="btn" data-id="resign-cancel" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-danger"
                data-id="resign-confirm"
                onClick={() => {
                  setConfirming(false);
                  onResign();
                }}
              >
                Resign
              </button>
            </div>
          </div>
        )}
      </section>

      <section class="sheet-section">
        <h3 class="sheet-label">While playing</h3>
        <div class="sheet-group">
          <Toggle
            id="coach"
            label="Coach"
            description="Rates and explains each of your moves"
            checked={settings.coach}
            onChange={(v) => onChange({ coach: v })}
            icon={<IconCoach />}
            iconColor="var(--accent-strong)"
          />
          <Toggle
            id="showEvalBar"
            label="Evaluation bar"
            description="Who is better, and by how much"
            checked={settings.showEvalBar}
            onChange={(v) => onChange({ showEvalBar: v })}
            icon={<IconChart />}
            iconColor="var(--cls-great)"
          />
          <Toggle
            id="showBestMoves"
            label="Best-move arrows"
            description="Makes the game unrated"
            checked={settings.showBestMoves}
            onChange={(v) => onChange({ showBestMoves: v })}
            icon={<IconEye />}
            iconColor="var(--cls-brilliant)"
          />
          <Toggle
            id="sound"
            label="Sound"
            checked={settings.sound}
            onChange={(v) => onChange({ sound: v })}
            icon={<IconSound />}
            iconColor="var(--cls-miss)"
          />
        </div>
      </section>

      <section class="sheet-section">
        <h3 class="sheet-label">Your stats</h3>
        <ProfileCard profile={profile} />
      </section>

      <section class="sheet-section">
        <h3 class="sheet-label">Recent games</h3>
        {recent.length ? (
          <ul class="sheet-group menu-games">
            {recent.map((r) => (
              <GameRow key={r.id} record={r} bot={bots?.find((b) => b.name === r.botName)} />
            ))}
          </ul>
        ) : (
          <div class="sheet-group menu-empty">
            <span class="menu-empty-icon" aria-hidden="true">
              ♞
            </span>
            <span>No finished games yet. Your last {RECENT_GAMES} games will show up here.</span>
          </div>
        )}
      </section>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ pieces */

interface ActionTileProps {
  id: string;
  label: string;
  icon: ComponentChild;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Toggle-like state (Resign while its confirmation is shown). */
  pressed?: boolean;
}

function ActionTile({ id, label, icon, onClick, disabled, danger, pressed }: ActionTileProps) {
  return (
    <button
      type="button"
      class="menu-tile"
      data-id={id}
      data-danger={danger ? '' : undefined}
      aria-expanded={pressed === undefined ? undefined : pressed ? 'true' : 'false'}
      disabled={disabled}
      onClick={onClick}
    >
      <span class="menu-tile-icon" aria-hidden="true">
        {icon}
      </span>
      <span class="menu-tile-label">{label}</span>
    </button>
  );
}

function ProfileCard({ profile }: { profile: PlayerProfile }) {
  const total = profile.wins + profile.draws + profile.losses;
  const last = profile.history.find((r) => r.rated);
  const lastDelta = last ? last.ratingAfter - last.ratingBefore : null;
  return (
    <div class="sheet-group menu-profile">
      <div class="menu-profile-top">
        <div class="menu-profile-rating">
          <span class="menu-profile-num">{Math.round(profile.rating)}</span>
          {lastDelta !== null && (
            <span class="menu-delta" data-sign={Math.sign(lastDelta)} title="Last rated game">
              {formatRatingDelta(lastDelta)}
            </span>
          )}
        </div>
        <dl class="menu-profile-meta">
          <div>
            <dt>Peak</dt>
            <dd>{Math.round(profile.peak)}</dd>
          </div>
          <div>
            <dt>Games</dt>
            <dd>{total}</dd>
          </div>
        </dl>
      </div>
      <div
        class="menu-wdl-bar"
        role="img"
        aria-label={`${profile.wins} wins, ${profile.draws} draws, ${profile.losses} losses`}
      >
        {profile.wins > 0 && <i data-k="win" style={{ flexGrow: profile.wins }} />}
        {profile.draws > 0 && <i data-k="draw" style={{ flexGrow: profile.draws }} />}
        {profile.losses > 0 && <i data-k="loss" style={{ flexGrow: profile.losses }} />}
      </div>
      <div class="menu-wdl" aria-hidden="true">
        <span data-k="win">
          <b>{profile.wins}</b> won
        </span>
        <span data-k="draw">
          <b>{profile.draws}</b> drawn
        </span>
        <span data-k="loss">
          <b>{profile.losses}</b> lost
        </span>
      </div>
    </div>
  );
}

const RESULT_LETTER = { win: 'W', draw: 'D', loss: 'L' } as const;
const RESULT_WORD = { win: 'Won', draw: 'Draw', loss: 'Lost' } as const;

function GameRow({ record: r, bot }: { record: GameRecord; bot?: BotPersona }) {
  const outcome = recordOutcome(r);
  const delta = r.ratingAfter - r.ratingBefore;
  const date = formatGameDate(r.date);
  const colour = r.playerColor === 'w' ? 'White' : 'Black';
  const label =
    `${RESULT_WORD[outcome]} against ${r.botName} (${r.botElo}) as ${colour}, ${r.reason}, ${date}. ` +
    (r.rated ? `Rating ${formatRatingDelta(delta)} to ${r.ratingAfter}.` : 'Unrated.');
  return (
    <li class="menu-game" aria-label={label}>
      <span class="menu-result" data-k={outcome} aria-hidden="true">
        {RESULT_LETTER[outcome]}
      </span>
      <div class="menu-game-main" aria-hidden="true">
        <div class="menu-game-top">
          {bot && (
            <span class="menu-game-avatar" style={{ background: bot.color }}>
              {bot.emoji}
            </span>
          )}
          <span class="menu-game-name">{r.botName}</span>
          <span class="menu-game-elo">{r.botElo}</span>
        </div>
        <div class="menu-game-sub">
          <span class="menu-game-side" data-c={r.playerColor} title={`You played ${colour}`} />
          <span class="menu-game-reason">{r.reason}</span>
          {r.accuracy != null && <span class="menu-game-acc">{Math.round(r.accuracy)}%</span>}
          <span class="menu-game-date">{date}</span>
        </div>
      </div>
      <div class="menu-game-rating" aria-hidden="true">
        {r.rated ? (
          <>
            <span class="menu-delta" data-sign={Math.sign(delta)}>
              {formatRatingDelta(delta)}
            </span>
            <span class="menu-game-after">{r.ratingAfter}</span>
          </>
        ) : (
          <span class="menu-game-unrated">Unrated</span>
        )}
      </div>
    </li>
  );
}
