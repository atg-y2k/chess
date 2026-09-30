/**
 * Dev page for the bottom sheets: /gallery.html?g=sheets
 *   &open=new|menu|over|none   sheet shown on load (default new)
 *   &over=win|loss|draw|unrated|resign   GameOverSheet variant (default win)
 *   &bot=<id>|custom &elo=N &adaptive=1   initial NewGameSheet settings (default bot=fennec)
 *   &empty=1      profile without games (MenuSheet empty state)
 *   &canResign=0  MenuSheet with Resign disabled
 *   &sim=0|1      iPhone safe-area simulation (default: on for narrow viewports)
 *   &chrome=0     hide the launcher buttons (for screenshots)
 * Every callback is logged to `window.__sheetEvents` (used by the headless checks).
 * The personas here are a local mock; the real list lives in src/bot/personas.ts.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { BotPersona } from '../bot/types';
import { DEFAULT_SETTINGS, type Color, type GameOutcome, type GameSettings } from '../game/types';
import type { GameRecord, PlayerProfile } from '../rating/types';
import { GameOverSheet, type GameOverSheetProps } from '../ui/GameOverSheet';
import { MenuSheet } from '../ui/MenuSheet';
import { NewGameSheet } from '../ui/NewGameSheet';

declare global {
  interface Window {
    __sheetEvents?: { name: string; detail?: unknown }[];
  }
}

/* ------------------------------------------------------------------ mock data */

const MOCK_BOTS: BotPersona[] = [
  {
    id: 'sprout',
    name: 'Sprout',
    elo: 100,
    emoji: '🌱',
    color: '#8bc34a',
    tagline: 'Has just learned how the knight moves. Mostly.',
    greeting: 'Hi!',
  },
  {
    id: 'pebble',
    name: 'Pebble',
    elo: 250,
    emoji: '🐹',
    color: '#e0a96d',
    tagline: 'Stuffs pawns in its cheeks and forgets about the king.',
    greeting: 'Squeak!',
  },
  {
    id: 'milo',
    name: 'Milo',
    elo: 400,
    emoji: '🐱',
    color: '#f5a65b',
    tagline: 'Chases anything that moves, including your bishops.',
    greeting: 'Mrrp.',
  },
  {
    id: 'granny-june',
    name: 'Granny June',
    elo: 550,
    emoji: '👵',
    color: '#c39bd3',
    tagline: 'Sunday afternoons, tea and the occasional fork.',
    greeting: 'Sit down, dear.',
  },
  {
    id: 'fennec',
    name: 'Fennec',
    elo: 700,
    emoji: '🦊',
    color: '#e67e22',
    tagline: 'A curious fox learning her first tactics.',
    greeting: 'Want to see a pin?',
  },
  {
    id: 'bamboo',
    name: 'Bamboo',
    elo: 850,
    emoji: '🐼',
    color: '#9aa5a0',
    tagline: 'Never in a hurry, except when there is a check.',
    greeting: 'Your move.',
  },
  {
    id: 'captain',
    name: 'Captain Ada',
    elo: 1000,
    emoji: '🎒',
    color: '#4aa3df',
    tagline: 'School club captain who always explains her plan.',
    greeting: 'I will castle early.',
  },
  {
    id: 'otter',
    name: 'Otter',
    elo: 1200,
    emoji: '🦦',
    color: '#8d6e63',
    tagline: 'Playful, slippery, loves a tactic.',
    greeting: 'Dive in!',
  },
  {
    id: 'scholar',
    name: 'Scholar',
    elo: 1400,
    emoji: '📚',
    color: '#27ae60',
    tagline: 'Studies openings on the bus and knows the theory.',
    greeting: 'I prepared.',
  },
  {
    id: 'hoot',
    name: 'Prof. Hoot',
    elo: 1600,
    emoji: '🦉',
    color: '#7f8c8d',
    tagline: 'Wise, patient and quietly positional.',
    greeting: 'Hoo.',
  },
  {
    id: 'glacier',
    name: 'Glacier',
    elo: 1800,
    emoji: '❄️',
    color: '#5dade2',
    tagline: 'Solid as ice. Punishes loose pieces.',
    greeting: 'Calm and precise.',
  },
  {
    id: 'volt',
    name: 'Volt',
    elo: 2000,
    emoji: '⚡',
    color: '#f39c12',
    tagline: 'Club champion with a taste for sharp gambits.',
    greeting: 'Complications!',
  },
  {
    id: 'falcon',
    name: 'Falcon',
    elo: 2200,
    emoji: '🦅',
    color: '#a04000',
    tagline: 'A master who hovers, waits, then strikes.',
    greeting: 'I see everything.',
  },
  {
    id: 'nocturne',
    name: 'Nocturne',
    elo: 2500,
    emoji: '🌙',
    color: '#34495e',
    tagline: 'Calm, precise and utterly relentless.',
    greeting: 'Take your time.',
  },
  {
    id: 'wyrm',
    name: 'Wyrm',
    elo: 2800,
    emoji: '🐉',
    color: '#c0392b',
    tagline: 'An ancient dragon who has read every chess book.',
    greeting: 'Shall we?',
  },
  {
    id: 'singularity',
    name: 'Singularity',
    elo: 3200,
    emoji: '🌌',
    color: '#2c3e8f',
    tagline: 'Full-strength engine. Pure calculation, no mercy.',
    greeting: 'Calculating.',
  },
];

function daysAgo(days: number, hour = 18): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 12, 0, 0);
  return d.toISOString();
}

function record(
  i: number,
  days: number,
  botId: string,
  playerColor: Color,
  score: 1 | 0.5 | 0,
  reason: string,
  before: number,
  delta: number,
  extra: Partial<GameRecord> = {},
): GameRecord {
  const bot = MOCK_BOTS.find((b) => b.id === botId)!;
  const rated = extra.rated ?? true;
  const whiteWon = (score === 1) === (playerColor === 'w');
  return {
    id: `g${i}`,
    date: daysAgo(days),
    playerColor,
    botName: bot.name,
    botElo: bot.elo,
    result: score === 0.5 ? '1/2-1/2' : whiteWon ? '1-0' : '0-1',
    playerScore: score,
    rated,
    ratingBefore: before,
    ratingAfter: rated ? before + delta : before,
    reason,
    pgn: '',
    ...extra,
  };
}

// Newest first.
const HISTORY: GameRecord[] = [
  record(14, 0, 'otter', 'w', 1, 'Checkmate', 1034, 12, { accuracy: 86.4 }),
  record(13, 0, 'scholar', 'b', 0, 'Resignation', 1049, -15),
  record(12, 1, 'captain', 'w', 0.5, 'Threefold repetition', 1047, 2, { accuracy: 78.1 }),
  record(11, 1, 'hoot', 'b', 0, 'Checkmate', 1047, 0, { rated: false }),
  record(10, 3, 'otter', 'b', 1, 'Checkmate', 1029, 18),
  record(9, 4, 'bamboo', 'w', 1, 'Checkmate', 1021, 8, { accuracy: 91.2 }),
  record(8, 9, 'otter', 'w', 0, 'Checkmate', 1040, -19),
  record(7, 12, 'captain', 'b', 1, 'Resignation', 1024, 16),
  record(6, 20, 'fennec', 'w', 0.5, 'Stalemate', 1030, -6),
  record(5, 33, 'captain', 'w', 1, 'Checkmate', 1002, 28),
  record(4, 40, 'fennec', 'b', 1, 'Checkmate', 980, 22),
  record(3, 41, 'bamboo', 'w', 0, 'Insufficient material', 990, -10),
];

const PROFILE: PlayerProfile = {
  rating: 1046,
  gamesPlayed: 11,
  peak: 1061,
  wins: 6,
  draws: 2,
  losses: 4,
  history: HISTORY,
};

const EMPTY_PROFILE: PlayerProfile = {
  rating: 800,
  gamesPlayed: 0,
  peak: 800,
  wins: 0,
  draws: 0,
  losses: 0,
  history: [],
};

type SheetName = 'new' | 'menu' | 'over' | 'none';
type OverVariant = 'win' | 'loss' | 'draw' | 'unrated' | 'resign';

const OVER: Record<
  OverVariant,
  Pick<GameOverSheetProps, 'outcome' | 'playerColor' | 'ratingChange'> & { botId: string }
> = {
  win: {
    outcome: { result: '1-0', winner: 'w', reason: 'Checkmate' },
    playerColor: 'w',
    ratingChange: { before: 1034, after: 1046, rated: true },
    botId: 'otter',
  },
  loss: {
    outcome: { result: '1-0', winner: 'w', reason: 'Checkmate' },
    playerColor: 'b',
    ratingChange: { before: 1046, after: 1038, rated: true },
    botId: 'scholar',
  },
  draw: {
    outcome: { result: '1/2-1/2', winner: null, reason: 'Threefold repetition' },
    playerColor: 'w',
    ratingChange: { before: 1046, after: 1049, rated: true },
    botId: 'hoot',
  },
  unrated: {
    outcome: { result: '0-1', winner: 'b', reason: 'Checkmate' },
    playerColor: 'b',
    ratingChange: { before: 1046, after: 1046, rated: false },
    botId: 'volt',
  },
  resign: {
    outcome: { result: '0-1', winner: 'b', reason: 'Resignation' },
    playerColor: 'w',
    ratingChange: { before: 1046, after: 1031, rated: true },
    botId: 'glacier',
  },
};

/* ------------------------------------------------------------------ page */

function log(name: string, detail?: unknown) {
  (window.__sheetEvents ??= []).push({ name, detail });
  // eslint-disable-next-line no-console
  console.info('[sheets]', name, detail ?? '');
}

const CSS = `
.gs-root { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.gs-island { position: fixed; top: 11px; left: 50%; width: 126px; height: 37px; margin-left: -63px;
  border-radius: 20px; background: #000; z-index: 200; pointer-events: none; }
.gs-homebar { position: fixed; bottom: 8px; left: 50%; width: 134px; height: 5px; margin-left: -67px;
  border-radius: 3px; background: var(--text); opacity: 0.85; z-index: 200; pointer-events: none; }
.gs-screen { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; width: 100%; max-width: 520px;
  margin: 0 auto; padding: 6px 0; }
.gs-strip { display: flex; align-items: center; gap: 10px; padding: 0 10px; height: 40px; }
.gs-strip i { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; font-style: normal;
  font-size: 20px; }
.gs-strip b { font-size: 15px; } .gs-strip span { color: var(--text-faint); font-size: 13px; }
.gs-board { width: 100%; aspect-ratio: 1; background: repeating-conic-gradient(var(--board-dark) 0 25%, var(--board-light) 0 50%) 0 0 / 25% 25%; }
.gs-launch { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; }
.gs-launch .btn { flex: 1 1 auto; min-height: 40px; padding: 8px 10px; font-size: 13px; }
.gs-toast { position: fixed; left: 50%; top: calc(var(--safe-top) + 8px); transform: translateX(-50%); z-index: 300;
  max-width: 92%; padding: 7px 12px; border-radius: 16px; background: var(--surface-3); color: var(--text);
  font: 600 12px var(--font-mono); box-shadow: 0 6px 20px rgba(0,0,0,.35); pointer-events: none;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (orientation: landscape) and (min-width: 640px) {
  .gs-island { top: 50%; left: 11px; width: 37px; height: 126px; margin: -63px 0 0; }
  .gs-screen { flex-direction: row; flex-wrap: wrap; max-width: none; align-items: flex-start; padding: 6px 12px; }
  .gs-board { width: auto; height: calc(100% - 20px); max-height: calc(100dvh - 40px); }
}
`;

export default function SheetsGallery() {
  const q = new URLSearchParams(location.search);
  const sim = q.get('sim') === '1' || (q.get('sim') !== '0' && window.innerWidth < 500);
  const chrome = q.get('chrome') !== '0';
  const [open, setOpen] = useState<SheetName>((q.get('open') as SheetName | null) ?? 'new');
  const [over, setOver] = useState<OverVariant>((q.get('over') as OverVariant | null) ?? 'win');
  const [settings, setSettings] = useState<GameSettings>(() => {
    const botId = q.get('bot') ?? 'fennec';
    const botElo = Number(q.get('elo') ?? MOCK_BOTS.find((b) => b.id === botId)?.elo ?? 800);
    return { ...DEFAULT_SETTINGS, botId, botElo, adaptive: q.get('adaptive') === '1' };
  });
  const [toast, setToast] = useState('');
  const profile = q.get('empty') === '1' ? EMPTY_PROFILE : PROFILE;
  const canResign = q.get('canResign') !== '0';

  // Simulated iPhone 15 Pro safe areas (the CSS env() insets are 0 in a desktop browser).
  useEffect(() => {
    if (!sim) return;
    const root = document.documentElement.style;
    const apply = () => {
      const landscape = window.innerWidth > window.innerHeight;
      root.setProperty('--safe-top', landscape ? '0px' : '59px');
      root.setProperty('--safe-bottom', landscape ? '21px' : '34px');
      root.setProperty('--safe-left', landscape ? '59px' : '0px');
      root.setProperty('--safe-right', landscape ? '59px' : '0px');
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [sim]);

  const emit = (name: string, detail?: unknown) => {
    log(name, detail);
    setToast(detail === undefined ? name : `${name} ${JSON.stringify(detail)}`);
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const overData = OVER[over];
  const overBot = MOCK_BOTS.find((b) => b.id === overData.botId)!;
  const outcome: GameOutcome = overData.outcome;
  const opponent = useMemo(
    () =>
      MOCK_BOTS.find((b) => b.id === settings.botId) ?? {
        name: `Robot ${settings.botElo}`,
        emoji: '🤖',
        color: '#6b7b8c',
        elo: settings.botElo,
      },
    [settings.botId, settings.botElo],
  );

  const show = (name: SheetName, variant?: OverVariant) => {
    if (variant) setOver(variant);
    setOpen(name);
  };

  return (
    <div class="gs-root" data-sim={sim ? '' : undefined}>
      <style>{CSS}</style>
      {sim && <div class="gs-island" />}
      {sim && <div class="gs-homebar" />}

      <div class="gs-screen">
        <div class="gs-strip">
          <i style={{ background: opponent.color }}>{opponent.emoji}</i>
          <b>{opponent.name}</b>
          <span>({opponent.elo})</span>
        </div>
        <div class="gs-board" />
        <div class="gs-strip">
          <i style={{ background: 'var(--surface-3)' }}>🙂</i>
          <b>You</b>
          <span>({profile.rating})</span>
        </div>
        {chrome && (
          <div class="gs-launch">
            <button type="button" class="btn" data-open="new" onClick={() => show('new')}>
              New game
            </button>
            <button type="button" class="btn" data-open="menu" onClick={() => show('menu')}>
              Menu
            </button>
            {(['win', 'loss', 'draw', 'unrated', 'resign'] as OverVariant[]).map((v) => (
              <button key={v} type="button" class="btn" data-open={`over-${v}`} onClick={() => show('over', v)}>
                Over: {v}
              </button>
            ))}
          </div>
        )}
      </div>

      <NewGameSheet
        open={open === 'new'}
        initial={settings}
        playerRating={profile.rating}
        bots={MOCK_BOTS}
        onStart={(s) => {
          emit('new:start', s);
          setSettings(s);
          setOpen('none');
        }}
        onClose={() => {
          emit('new:close');
          setOpen('none');
        }}
      />

      <MenuSheet
        open={open === 'menu'}
        settings={settings}
        profile={profile}
        canResign={canResign}
        bots={MOCK_BOTS}
        onChange={(partial) => {
          emit('menu:change', partial);
          setSettings((s) => ({ ...s, ...partial }));
        }}
        onResign={() => {
          emit('menu:resign');
          show('over', 'resign');
        }}
        onExportPgn={() => emit('menu:export')}
        onFlip={() => emit('menu:flip')}
        onNewGame={() => {
          emit('menu:new');
          setOpen('new');
        }}
        onClose={() => {
          emit('menu:close');
          setOpen('none');
        }}
      />

      <GameOverSheet
        open={open === 'over'}
        outcome={outcome}
        playerColor={overData.playerColor}
        botName={overBot.name}
        botEmoji={overBot.emoji}
        botColor={overBot.color}
        botElo={overBot.elo}
        ratingChange={overData.ratingChange}
        onReview={() => {
          emit('over:review');
          setOpen('none');
        }}
        onRematch={() => {
          emit('over:rematch');
          setOpen('none');
        }}
        onNewGame={() => {
          emit('over:new');
          setOpen('new');
        }}
        onClose={() => {
          emit('over:close');
          setOpen('none');
        }}
      />
      {toast ? <div class="gs-toast">{toast}</div> : null}
    </div>
  );
}
