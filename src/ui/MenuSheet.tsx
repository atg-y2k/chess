import type { ComponentChild } from 'preact';
import { useEffect, useId, useState } from 'preact/hooks';
import type { BotPersona } from '../bot/types';
import type { ProFeature } from '../game/entitlements';
import type { GameSettings } from '../game/types';
import { FOLD_SETTINGS, type FoldSetting } from '../layout/fold';
import { formatGameDate, recordOutcome } from '../rating/history';
import { PROVISIONAL_GAMES, formatRatingDelta } from '../rating/rating';
import type { GameRecord, PlayerProfile } from '../rating/types';
import type { ThemePref } from '../theme';
import { About } from './About';
import {
  IconBook,
  IconBotRated,
  IconChart,
  IconCheck,
  IconCheckCircle,
  IconChevronRight,
  IconCoach,
  IconCpu,
  IconEye,
  IconFlag,
  IconFlip,
  IconGauge,
  IconPlus,
  IconShare,
  IconSound,
  IconThreat,
} from './icons';
import { LevelPicker, levelFor, type StartingLevel } from './LevelPicker';
import { ASSIST_MENU_DESCRIPTION, RATE_OPPONENT_MENU_DESCRIPTION, THREAT_ALERTS_MENU_DESCRIPTION } from './NewGameSheet';
import { IconLock } from './PaywallSheet';
import { RatingChart } from './RatingChart';
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
  /** Opens the Openings section (omitted: no row). */
  onOpenings?: () => void;
  /** Optional personas, to show avatars in the recent-games list (matched by `botName`). */
  bots?: BotPersona[];
  /** Colour theme preference; with `onThemeChange` an "Appearance" picker is shown. */
  theme?: ThemePref;
  onThemeChange?: (theme: ThemePref) => void;
  /**
   * The "Foldable screen" setting (src/layout/fold.ts), under Appearance: offered where a fold is
   * reported or can be assumed, so the setting can act (omitted: no section). `postureReported`: the
   * browser says when the screen is half folded (else the note says how to split it then).
   */
  foldable?: { value: FoldSetting; onChange: (value: FoldSetting) => void; postureReported: boolean };
  /** The engine setup, for the "Engine" section (omitted: no section). */
  engine?: EngineInfo;
  /** "Try two engines again" (offered in single mode): forget the compatibility decision and reload. */
  onRetryDualEngines?: () => void;
  /** Link to the engine self-test page. Default `?enginetest`. */
  selfTestHref?: string;
  /** The app and the engine are cached for offline use: the Engine section says so. */
  offlineReady?: boolean;
  /** Starting levels for "Set my level" in the stats card (with `onSetLevel`). */
  levels?: readonly StartingLevel[];
  /** Called after the "Set my level" confirmation with the chosen rating. */
  onSetLevel?: (rating: number) => void;
  /**
   * A rated game the player has moved in is going on: a level chosen now applies when it ends (the
   * game still counts at the current rating), and the note says so.
   */
  levelAfterGame?: boolean;
  /** A level chosen during the game in progress, waiting for it to end. */
  pendingLevel?: number | null;
  /** The rating is still new and moves fast (rating/rating.ts `isProvisional`): a "New" tag beside it. */
  provisional?: boolean;
  /** What resigning does to the rating (see `resignNote`); omitted: "It counts as a loss." */
  resign?: ResignInfo | null;
  /** Pro, where it is sold: its row (Unlock, or Unlocked) and Restore Purchases. Omitted: no section. */
  pro?: ProMenuInfo;
  /** Opens the paywall (for `feature` when a locked feature was tapped). */
  onUnlock?: (feature?: ProFeature) => void;
  /** Restore Purchases. */
  onRestore?: () => void;
  /**
   * Opens a game of the history (its record id) in the game viewer: the Recent games rows and the
   * rating chart's games (omitted: neither opens anything).
   */
  onOpenGame?: (id: string) => void;
}

/** The Menu's Pro section. */
export interface ProMenuInfo {
  /** e.g. "Chess Coach Pro". */
  name: string;
  unlocked: boolean;
  /** A purchase waits for approval (Ask to Buy). */
  pending?: boolean;
  /** Restore Purchases is running. */
  restoring?: boolean;
  /** Best-move arrows are locked: their toggle shows a lock and opens the paywall instead. */
  arrowsLocked?: boolean;
  /** Threat alerts are locked: the same for their toggle. */
  threatsLocked?: boolean;
}

/** The Pro row's second line. */
export function proStatusLabel(pro: Pick<ProMenuInfo, 'unlocked' | 'pending'>): string {
  if (pro.unlocked) return 'Unlocked ✓';
  if (pro.pending) return 'Waiting for approval';
  return 'Explanations, hints and full reviews';
}

/** How the engines run: two workers, or one shared worker (compatibility mode). */
export interface EngineInfo {
  /** Null before the engines have started. */
  mode: 'dual' | 'single' | null;
  /** Single mode was remembered after a start that looked killed: two engines are tried again after this time (ms). */
  singleUntil?: number | null;
}

/** "2 workers", "1 worker (compatibility mode, until Oct 14)" or "1 worker (compatibility mode)". */
export function engineModeLabel(info: EngineInfo, now: Date = new Date(), locale?: string): string {
  if (info.mode === 'dual') return '2 workers';
  if (info.mode === null) return 'Not running';
  const until = info.singleUntil;
  if (until == null || !Number.isFinite(until)) return '1 worker (compatibility mode)';
  const d = new Date(until);
  const date = d.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
  return `1 worker (compatibility mode, until ${date})`;
}

/** How many games the "Recent games" list shows. */
export const RECENT_GAMES = 10;

/** What resigning the game in progress does to the rating. */
export interface ResignInfo {
  /** False for an unrated game, or before the player's first move. */
  rated: boolean;
  /** Rated: the rating now and after the loss. */
  before?: number;
  after?: number;
}

/** "It counts as a loss: your rating goes from 904 to 834 (−70)." / "…, but your rating stays the same." */
export function resignNote(r: ResignInfo | null | undefined): string {
  if (!r) return 'It counts as a loss.';
  if (!r.rated) return 'It counts as a loss, but your rating stays the same.';
  if (r.before === undefined || r.after === undefined) return 'It counts as a loss.';
  return `It counts as a loss: your rating goes from ${r.before} to ${r.after} (${formatRatingDelta(r.after - r.before)}).`;
}

export { formatRatingDelta };

export { formatGameDate, recordOutcome };

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
  onOpenings,
  bots,
  theme,
  onThemeChange,
  foldable,
  engine,
  onRetryDualEngines,
  selfTestHref = '?enginetest',
  offlineReady = false,
  levels,
  onSetLevel,
  levelAfterGame = false,
  pendingLevel = null,
  provisional = false,
  resign,
  pro,
  onUnlock,
  onRestore,
  onOpenGame,
}: MenuSheetProps) {
  const [confirming, setConfirming] = useState(false);
  const confirmId = useId();
  const themeLabelId = useId();
  const foldLabelId = useId();

  // Never reopen in the confirm state; leave it if resigning becomes impossible.
  useEffect(() => {
    if (!open || !canResign) setConfirming(false);
  }, [open, canResign]);

  const recent = profile.history.slice(0, RECENT_GAMES);
  const arrowsLocked = !!pro?.arrowsLocked;
  const threatsLocked = !!pro?.threatsLocked;

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
              <span data-id="resign-note">{resignNote(resign)}</span>
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

      {onOpenings && (
        <section class="sheet-section">
          <div class="sheet-group">
            <button type="button" class="menu-row menu-row--link" data-id="openings" onClick={onOpenings}>
              <span class="menu-row-icon" style={{ background: 'var(--cls-book)' }} aria-hidden="true">
                <IconBook />
              </span>
              <span class="menu-row-text">
                <span class="menu-row-label">Openings</span>
                <span class="menu-row-desc">Learn, explore and practice chess openings</span>
              </span>
              <IconChevronRight size={18} class="menu-row-chevron" />
            </button>
          </div>
        </section>
      )}

      {pro && (
        <section class="sheet-section">
          <div class="sheet-group menu-pro" data-unlocked={pro.unlocked ? '' : undefined}>
            <div class="menu-row" data-id="pro-status">
              <span class="menu-row-icon menu-pro-icon" aria-hidden="true">
                <ProStar />
              </span>
              <span class="menu-row-text">
                <span class="menu-row-label">{pro.name}</span>
                <span class="menu-row-desc menu-pro-desc">{proStatusLabel(pro)}</span>
              </span>
              {!pro.unlocked && (
                <button type="button" class="btn btn-primary menu-pro-btn" data-id="pro-unlock" onClick={() => onUnlock?.()}>
                  Unlock
                </button>
              )}
            </div>
            <button
              type="button"
              class="menu-row menu-row--action"
              data-id="pro-restore"
              disabled={pro.restoring}
              aria-busy={pro.restoring ? 'true' : undefined}
              onClick={onRestore}
            >
              <span class="menu-row-label">{pro.restoring ? 'Restoring…' : 'Restore Purchases'}</span>
            </button>
          </div>
        </section>
      )}

      <section class="sheet-section">
        <h3 class="sheet-label">While playing</h3>
        <div
          class="sheet-group"
          data-arrows-locked={arrowsLocked ? '' : undefined}
          data-threats-locked={threatsLocked ? '' : undefined}
        >
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
            description={arrowsLocked ? `Part of ${pro?.name ?? 'Pro'}` : ASSIST_MENU_DESCRIPTION}
            checked={settings.showBestMoves && !arrowsLocked}
            onChange={arrowsLocked ? () => onUnlock?.('bestMoveArrows') : (v) => onChange({ showBestMoves: v })}
            icon={arrowsLocked ? <IconLock /> : <IconEye />}
            iconColor={arrowsLocked ? 'var(--warning)' : 'var(--cls-brilliant)'}
          />
          <Toggle
            id="threatAlerts"
            label="Threat alerts"
            description={threatsLocked ? `Part of ${pro?.name ?? 'Pro'}` : THREAT_ALERTS_MENU_DESCRIPTION}
            checked={settings.threatAlerts && !threatsLocked}
            onChange={threatsLocked ? () => onUnlock?.('threatAlerts') : (v) => onChange({ threatAlerts: v })}
            icon={threatsLocked ? <IconLock /> : <IconThreat />}
            iconColor={threatsLocked ? 'var(--warning)' : 'var(--danger)'}
          />
          <Toggle
            id="rateOpponent"
            label="Rate opponent’s moves"
            description={RATE_OPPONENT_MENU_DESCRIPTION}
            checked={settings.rateOpponent}
            onChange={(v) => onChange({ rateOpponent: v })}
            icon={<IconBotRated />}
            iconColor="var(--cls-inaccuracy)"
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

      {theme && onThemeChange && (
        <section class="sheet-section">
          <h3 class="sheet-label" id={themeLabelId}>
            Appearance
          </h3>
          <ThemePicker labelledBy={themeLabelId} value={theme} onChange={onThemeChange} />
        </section>
      )}

      {foldable && (
        <section class="sheet-section" data-id="foldable">
          <h3 class="sheet-label" id={foldLabelId}>
            Foldable screen
          </h3>
          <FoldPicker labelledBy={foldLabelId} value={foldable.value} onChange={foldable.onChange} />
          <p class="sheet-note">{foldNote(foldable.postureReported)}</p>
        </section>
      )}

      <section class="sheet-section">
        <h3 class="sheet-label">Your stats</h3>
        <ProfileCard
          profile={profile}
          open={open}
          levels={levels}
          onSetLevel={onSetLevel}
          levelAfterGame={levelAfterGame}
          pendingLevel={pendingLevel}
          provisional={provisional}
          onOpenGame={onOpenGame}
        />
      </section>

      <section class="sheet-section">
        <h3 class="sheet-label">Recent games</h3>
        {recent.length ? (
          <ul class="sheet-group menu-games">
            {recent.map((r) => (
              <GameRow
                key={r.id}
                record={r}
                bot={bots?.find((b) => (r.botId && r.botId !== 'custom' ? b.id === r.botId : b.name === r.botName))}
                onOpen={onOpenGame}
              />
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

      {engine && (
        <section class="sheet-section">
          <h3 class="sheet-label">Engine</h3>
          <div class="sheet-group menu-engine">
            <div class="menu-row" data-id="engine-mode">
              <span class="menu-row-icon" style={{ background: 'var(--cls-great)' }} aria-hidden="true">
                <IconCpu />
              </span>
              <span class="menu-row-text">
                <span class="menu-row-label">Stockfish 19</span>
                <span class="menu-row-desc">{engineModeLabel(engine)}</span>
              </span>
            </div>
            {engine.mode === 'single' && onRetryDualEngines && (
              <button type="button" class="menu-row menu-row--action" data-id="engine-retry-dual" onClick={onRetryDualEngines}>
                <span class="menu-row-label">Try two engines again</span>
              </button>
            )}
            {offlineReady && (
              <div class="menu-row" data-id="offline-ready">
                <span class="menu-row-icon" style={{ background: 'var(--cls-best)' }} aria-hidden="true">
                  <IconCheckCircle />
                </span>
                <span class="menu-row-text">
                  <span class="menu-row-label">Available offline</span>
                  <span class="menu-row-desc">Saved on this device, engine included</span>
                </span>
              </div>
            )}
            <a class="menu-row menu-row--link" href={selfTestHref} data-id="engine-selftest">
              <span class="menu-row-icon" style={{ background: 'var(--cls-forced)' }} aria-hidden="true">
                <IconGauge />
              </span>
              <span class="menu-row-text">
                <span class="menu-row-label">Run engine self-test</span>
              </span>
              <IconChevronRight size={18} class="menu-row-chevron" />
            </a>
          </div>
          {engine.mode === 'single' && (
            <p class="sheet-note">
              In compatibility mode your opponent and the coach share one engine, so analysis pauses while the
              opponent thinks.
            </p>
          )}
        </section>
      )}

      <section class="sheet-section">
        <h3 class="sheet-label">About</h3>
        <About />
      </section>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ pieces */

/** The Pro row's star. */
function ProStar() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.8l2.75 5.8 6.35.75-4.7 4.35 1.25 6.3L12 16.85 6.35 20l1.25-6.3L2.9 9.35l6.35-.75z" />
    </svg>
  );
}

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

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'Automatic' },
];

/** Three-way segmented control (radio group) for the color theme. */
function ThemePicker({
  value,
  onChange,
  labelledBy,
}: {
  value: ThemePref;
  onChange: (t: ThemePref) => void;
  labelledBy: string;
}) {
  const index = Math.max(0, THEMES.findIndex((t) => t.value === value));
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    onChange(THEMES[(index + step + THEMES.length) % THEMES.length].value);
  };
  return (
    <div class="menu-theme" role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      <span class="menu-theme-thumb" style={{ transform: `translateX(${index * 100}%)` }} aria-hidden="true" />
      {THEMES.map((t) => (
        <button
          key={t.value}
          type="button"
          role="radio"
          class="menu-theme-opt"
          data-theme-opt={t.value}
          aria-checked={t.value === value ? 'true' : 'false'}
          tabIndex={t.value === value ? 0 : -1}
          onClick={() => onChange(t.value)}
        >
          <span class="menu-theme-swatch" data-swatch={t.value} aria-hidden="true" />
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Under the "Foldable screen" choices: what Automatic does. Half folded is automatic only where the
 * browser reports the fold or the posture (Chromium); Safari and the App Store app report neither
 * (WebKit, as of mid-2026), so there it is the other choice.
 */
export function foldNote(postureReported: boolean): string {
  const book = 'Automatic puts the board on one side of the fold and the coach on the other when the screen is open like a book';
  return postureReported
    ? `${book}, or half folded on a table.`
    : `${book}. Upright, it uses the whole screen; to keep the board in the top half when the phone stands half folded on a table, choose “Keep the board off the fold.”`;
}

/** The "Foldable screen" choices: a radio group of rows with a check mark (iOS Settings style). */
function FoldPicker({ value, onChange, labelledBy }: { value: FoldSetting; onChange: (v: FoldSetting) => void; labelledBy: string }) {
  const index = Math.max(0, FOLD_SETTINGS.findIndex((f) => f.value === value));
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = FOLD_SETTINGS[(index + step + FOLD_SETTINGS.length) % FOLD_SETTINGS.length].value;
    onChange(next);
    const group = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => group.querySelector<HTMLElement>(`[data-fold-opt="${next}"]`)?.focus());
  };
  return (
    <div class="sheet-group menu-fold" role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      {FOLD_SETTINGS.map((f) => (
        <button
          key={f.value}
          type="button"
          role="radio"
          class="menu-row menu-row--link menu-fold-opt"
          data-fold-opt={f.value}
          aria-checked={f.value === value ? 'true' : 'false'}
          tabIndex={f.value === value ? 0 : -1}
          onClick={() => onChange(f.value)}
        >
          <span class="menu-row-label">{f.label}</span>
          {f.value === value && <IconCheck size={20} class="menu-fold-check" />}
        </button>
      ))}
    </div>
  );
}

interface ProfileCardProps {
  profile: PlayerProfile;
  /** The sheet is open (the level chooser closes with it). */
  open: boolean;
  levels?: readonly StartingLevel[];
  onSetLevel?: (rating: number) => void;
  levelAfterGame?: boolean;
  pendingLevel?: number | null;
  provisional?: boolean;
  onOpenGame?: (id: string) => void;
}

function ProfileCard({ profile, open, levels, onSetLevel, levelAfterGame, pendingLevel, provisional, onOpenGame }: ProfileCardProps) {
  const total = profile.wins + profile.draws + profile.losses;
  const last = profile.history.find((r) => r.rated);
  const lastDelta = last ? last.ratingAfter - last.ratingBefore : null;
  return (
    <div class="sheet-group menu-profile">
      <div class="menu-profile-top">
        <div class="menu-profile-rating">
          <span class="menu-profile-num">{Math.round(profile.rating)}</span>
          {provisional && (
            <span class="menu-new" data-id="rating-new" title="New ratings move fast at first">
              New
            </span>
          )}
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
      {provisional && (
        <p class="menu-profile-note" data-id="rating-new-note">
          New ratings move fast at first. They settle after about {PROVISIONAL_GAMES} rated games.
        </p>
      )}
      {pendingLevel != null && (
        <p class="menu-profile-note" data-id="pending-level">
          Your new level, {pendingLevel}, starts when this game ends.
        </p>
      )}
      {levels?.length && onSetLevel ? (
        <SetLevel
          rating={Math.round(pendingLevel ?? profile.rating)}
          open={open}
          levels={levels}
          onSetLevel={onSetLevel}
          afterGame={!!levelAfterGame}
        />
      ) : null}
      <RatingChart profile={profile} onOpenGame={onOpenGame} />
    </div>
  );
}

/**
 * Sentence under the level chooser: what setting the level does. During a rated game the player
 * has moved in (`afterGame`), the game still counts at the current rating and the level waits for its end.
 */
export function setLevelNote(rating: number, afterGame = false): string {
  if (afterGame) {
    return `This game still counts at your current rating. When it ends, your rating becomes ${rating} and moves quickly over your next games while it settles. Your game history stays.`;
  }
  return `Your rating becomes ${rating} and moves quickly over your next games while it settles. Your game history stays.`;
}

/** "Set my level" in the stats card: pick a starting level, then confirm. */
function SetLevel({
  rating,
  open,
  levels,
  onSetLevel,
  afterGame,
}: {
  rating: number;
  open: boolean;
  levels: readonly StartingLevel[];
  onSetLevel: (rating: number) => void;
  afterGame: boolean;
}) {
  const [choice, setChoice] = useState<number | null>(null);
  const labelId = useId();
  useEffect(() => {
    if (!open) setChoice(null);
  }, [open]);
  if (choice === null) {
    return (
      <button
        type="button"
        class="menu-level-open"
        data-id="set-level"
        onClick={() => setChoice(levelFor(rating, levels)?.rating ?? levels[Math.floor(levels.length / 2)].rating)}
      >
        Set my level
        <IconChevronRight size={16} />
      </button>
    );
  }
  return (
    <div class="menu-level" role="group" aria-labelledby={labelId}>
      <div class="menu-level-title" id={labelId}>
        Set my level
      </div>
      <LevelPicker levels={levels} value={choice} onChange={setChoice} labelledBy={labelId} id="menu-level" />
      <p class="menu-level-note">{setLevelNote(choice, afterGame)}</p>
      <div class="menu-level-btns">
        <button type="button" class="btn" data-id="set-level-cancel" onClick={() => setChoice(null)}>
          Cancel
        </button>
        <button
          type="button"
          class="btn btn-primary"
          data-id="set-level-confirm"
          onClick={() => {
            setChoice(null);
            onSetLevel(choice);
          }}
        >
          {afterGame ? `${choice} after this game` : `Set to ${choice}`}
        </button>
      </div>
    </div>
  );
}

const RESULT_LETTER = { win: 'W', draw: 'D', loss: 'L' } as const;
const RESULT_WORD = { win: 'Won', draw: 'Draw', loss: 'Lost' } as const;

function GameRow({ record: r, bot, onOpen }: { record: GameRecord; bot?: BotPersona; onOpen?: (id: string) => void }) {
  const outcome = recordOutcome(r);
  const delta = r.ratingAfter - r.ratingBefore;
  const date = formatGameDate(r.date);
  const colour = r.playerColor === 'w' ? 'White' : 'Black';
  const label =
    `${RESULT_WORD[outcome]} against ${r.botName} (${r.botElo}) as ${colour}, ${r.reason}, ${date}. ` +
    (r.rated ? `Rating ${formatRatingDelta(delta)} to ${r.ratingAfter}.` : 'Unrated.');
  const content = (
    <>
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
    </>
  );
  // A row opens the game in the game viewer (replay, review, export).
  if (!onOpen) {
    return (
      <li class="menu-game-item">
        <div class="menu-game" aria-label={label} role="group">
          {content}
        </div>
      </li>
    );
  }
  return (
    <li class="menu-game-item">
      <button type="button" class="menu-game menu-game--open" data-id="recent-game" data-game={r.id} aria-label={`${label} Open the game.`} onClick={() => onOpen(r.id)}>
        {content}
        <IconChevronRight size={16} class="menu-game-chevron" />
      </button>
    </li>
  );
}
