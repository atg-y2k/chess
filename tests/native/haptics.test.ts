import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SoundKind } from '../../src/game/sound';
import { importAs, resetPlatform } from './helpers';

const plugin = vi.hoisted(() => ({
  impact: vi.fn(async (_options: { style: string }) => {}),
  notification: vi.fn(async (_options: { type: string }) => {}),
}));
vi.mock('@capacitor/haptics', () => ({ Haptics: plugin }));

const load = () => import('../../src/native/haptics');
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  resetPlatform();
  plugin.impact.mockClear();
  plugin.notification.mockClear();
});

describe('haptics', () => {
  it('maps every game sound to its haptic', async () => {
    const { hapticFor } = await load();
    const table: Record<SoundKind, ReturnType<typeof hapticFor>> = {
      move: { kind: 'impact', style: 'LIGHT' },
      capture: { kind: 'impact', style: 'MEDIUM' },
      castle: { kind: 'impact', style: 'MEDIUM' },
      promote: { kind: 'impact', style: 'MEDIUM' },
      check: { kind: 'notification', type: 'WARNING' },
      gameEnd: { kind: 'impact', style: 'HEAVY' },
      illegal: { kind: 'notification', type: 'ERROR' },
      gameStart: null,
      notify: null,
    };
    for (const [sound, expected] of Object.entries(table))
      expect(hapticFor(sound as SoundKind), sound).toEqual(expected);
  });

  it('the string values match @capacitor/haptics ImpactStyle / NotificationType', async () => {
    const real = await vi.importActual<typeof import('@capacitor/haptics')>('@capacitor/haptics');
    expect(Object.values(real.ImpactStyle).sort()).toEqual(['HEAVY', 'LIGHT', 'MEDIUM']);
    expect(Object.values(real.NotificationType).sort()).toEqual(['ERROR', 'SUCCESS', 'WARNING']);
  });

  it('plays them through the plugin in the iOS app', async () => {
    const { haptic } = await importAs(load, { native: true });
    haptic('capture');
    haptic('check');
    haptic('gameStart'); // none
    await flush();
    expect(plugin.impact.mock.calls).toEqual([[{ style: 'MEDIUM' }]]);
    expect(plugin.notification.mock.calls).toEqual([[{ type: 'WARNING' }]]);
  });

  it('does nothing on the web, or with the native build in a browser', async () => {
    for (const env of [{ native: false }, { native: true, runtime: false }]) {
      const { haptic } = await importAs(load, env);
      haptic('move');
      haptic('illegal');
    }
    await flush();
    expect(plugin.impact).not.toHaveBeenCalled();
    expect(plugin.notification).not.toHaveBeenCalled();
  });

  it('withHaptics: every sound also taps its haptic, only while sound is on', async () => {
    const { withHaptics } = await load();
    const port = { play: vi.fn(), setEnabled: vi.fn() };
    let on = true;
    const tapped: SoundKind[] = [];
    const wrapped = withHaptics(
      port,
      () => on,
      (k) => tapped.push(k),
    );
    wrapped.play('move');
    on = false;
    wrapped.play('capture');
    wrapped.setEnabled(false);
    expect(port.play.mock.calls).toEqual([['move'], ['capture']]);
    expect(port.setEnabled.mock.calls).toEqual([[false]]);
    expect(tapped).toEqual(['move']);
  });
});
