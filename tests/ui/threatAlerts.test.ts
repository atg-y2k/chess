/** Threat alerts in the sheets: the switch's line, the question in a rated game, and the New game note. */
import { describe, expect, it } from 'vitest';
import { assistPrompt } from '../../src/ui/ConfirmSheet';
import {
  ASSIST_MENU_DESCRIPTION,
  RATE_OPPONENT_MENU_DESCRIPTION,
  THREAT_ALERTS_DESCRIPTION,
  THREAT_ALERTS_MENU_DESCRIPTION,
  unratedNote,
} from '../../src/ui/NewGameSheet';

describe('threat alerts: wording', () => {
  it('the switch says what it does (the New game note says the game is unrated); the Menu says it as for the other help', () => {
    expect(THREAT_ALERTS_DESCRIPTION).toBe('Warns you when your opponent threatens something');
    expect(THREAT_ALERTS_MENU_DESCRIPTION).toBe('Warns you of threats, and makes your games unrated while it’s on');
    expect(THREAT_ALERTS_MENU_DESCRIPTION.endsWith(ASSIST_MENU_DESCRIPTION.toLowerCase())).toBe(true);
    expect(RATE_OPPONENT_MENU_DESCRIPTION).toBe(ASSIST_MENU_DESCRIPTION);
  });

  it('asks before switching them on in a rated game (and says they stay on)', () => {
    expect(assistPrompt('threatAlerts')).toEqual({
      title: 'Turn on threat alerts?',
      message:
        'Being warned about your opponent’s threats is a big help, so it makes this game unrated: win or lose, your rating stays the same. It stays on for your next games until you switch it off.',
      confirmLabel: 'Turn on',
    });
  });

  it('the New game note names them among what makes a game unrated, or says this one will be', () => {
    const off = unratedNote({ arrows: false, rateOpponent: false, threatAlerts: false });
    expect(off.warn).toBe(false);
    expect(off.text).toContain('best-move arrows, threat alerts and rating your opponent’s moves make a game unrated');
    expect(unratedNote({ arrows: false, rateOpponent: false, threatAlerts: true })).toEqual({
      text: 'Threat alerts are on, so this game won’t count for your rating.',
      warn: true,
    });
    expect(unratedNote({ arrows: true, rateOpponent: true, threatAlerts: true }).text).toBe(
      'Best-move arrows, threat alerts and your opponent’s move ratings are on, so this game won’t count for your rating.',
    );
    expect(unratedNote({ arrows: false, rateOpponent: true, threatAlerts: true }).text).toBe(
      'Threat alerts and your opponent’s move ratings are on, so this game won’t count for your rating.',
    );
  });
});
