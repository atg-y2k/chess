/**
 * Haptic feedback in the App Store app (@capacitor/haptics: UIImpactFeedbackGenerator and
 * UINotificationFeedbackGenerator). Safari has no vibration API, so on the web this is a no-op.
 *
 * Haptics follow the game's sounds: main.tsx wraps the controller's sound port with
 * `withHaptics()`, so every sound the game plays also taps the matching haptic, and the Sound
 * setting switches both. iOS's own "System Haptics" setting (Settings > Sounds & Haptics) turns
 * them off system-wide.
 */
import type { ImpactStyle, NotificationType } from '@capacitor/haptics';
import type { SoundPort } from '../game/controller';
import type { SoundKind } from '../game/sound';
import { isNative, nativePlugins } from './platform';

/** A haptic, in @capacitor/haptics terms (the string values of its ImpactStyle / NotificationType). */
export type Haptic =
  | { kind: 'impact'; style: 'LIGHT' | 'MEDIUM' | 'HEAVY' }
  | { kind: 'notification'; type: 'SUCCESS' | 'WARNING' | 'ERROR' };

/**
 * The haptic for each sound, or null for none. The game-end sound plays for wins, losses and draws
 * alike, so it gets a firm but neutral heavy impact rather than the "success" pattern.
 */
const HAPTICS: Record<SoundKind, Haptic | null> = {
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

/** The haptic that goes with a sound (null: none). */
export function hapticFor(sound: SoundKind): Haptic | null {
  return HAPTICS[sound];
}

let plugin: Promise<typeof import('@capacitor/haptics')> | null = null;

/** Plays the haptic for `sound` in the native app; does nothing on the web. Never throws. */
export function haptic(sound: SoundKind): void {
  const h = hapticFor(sound);
  if (!isNative || !h) return;
  plugin ??= nativePlugins.haptics();
  void plugin
    .then(({ Haptics }) =>
      h.kind === 'impact'
        ? Haptics.impact({ style: h.style as ImpactStyle })
        : Haptics.notification({ type: h.type as NotificationType }),
    )
    .catch(() => {
      // Haptics are optional (e.g. the plugin is missing from an old build).
    });
}

/**
 * A sound port that also plays the matching haptic (`play`, default `haptic`) for every sound,
 * while sound is on (`isEnabled`, normally game/sound.ts's isSoundEnabled).
 */
export function withHaptics(
  port: SoundPort,
  isEnabled: () => boolean,
  play: (sound: SoundKind) => void = haptic,
): SoundPort {
  return {
    play(kind) {
      port.play(kind);
      if (isEnabled()) play(kind);
    },
    setEnabled(on) {
      port.setEnabled(on);
    },
  };
}
