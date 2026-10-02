/**
 * Synthesized game sounds (Web Audio, no audio files).
 *
 * iOS notes (research/pwa.md §1.7):
 * - An AudioContext stays suspended until it is resumed inside a user gesture, so call
 *   `unlockAudio()` from a touchend/click handler. It also plays a 1-sample silent buffer.
 * - The audio session is set to 'ambient' (Safari 16.4+): sounds respect the silent switch and mix
 *   with the user's music instead of stopping it.
 * - iOS suspends ("interrupts") the context in the background; it is resumed when the page is
 *   visible again.
 *
 * `playSound()` is a no-op when sound is disabled or Web Audio is unavailable, and never throws.
 */

export type SoundKind = 'move' | 'capture' | 'check' | 'castle' | 'promote' | 'gameStart' | 'gameEnd' | 'illegal' | 'notify';

/** Overall volume. Individual voices peak well below 1, so overlapping sounds do not clip. */
const MASTER_GAIN = 1;
/** The same sound requested again within this window is ignored (e.g. two handlers firing). */
const DEDUPE_MS = 40;
/** A sound that could only start after an async resume is dropped if it would be this late. */
const MAX_RESUME_DELAY_MS = 250;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let unavailable = false;
let enabled = true;
let visibilityHooked = false;
const lastPlayed = new Map<SoundKind, number>();
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

/**
 * The sound for a move, from its SAN: check (also mate) > promotion > capture > castling > move.
 * Game start / end sounds are played separately by the caller.
 */
export function soundForSan(san: string): SoundKind {
  if (/[+#]/.test(san)) return 'check';
  if (san.includes('=')) return 'promote';
  if (san.includes('x')) return 'capture';
  if (san.startsWith('O-O')) return 'castle';
  return 'move';
}

/** Turns sounds on or off. Turning them on also tries to unlock audio (call it from a tap). */
export function setSoundEnabled(on: boolean): void {
  enabled = on;
  if (on) unlockAudio();
}

export function isSoundEnabled(): boolean {
  return enabled;
}

/**
 * Creates (lazily) and resumes the AudioContext. Call it inside a user gesture (touchend/click);
 * iOS keeps audio muted until then. Does nothing while sound is disabled.
 */
export function unlockAudio(): void {
  if (!enabled) return;
  try {
    const c = getContext();
    if (!c) return;
    if (c.state !== 'running') resume(c);
    const silent = c.createBufferSource();
    silent.buffer = c.createBuffer(1, 1, c.sampleRate);
    silent.connect(c.destination);
    silent.start(0);
  } catch {
    /* audio is optional */
  }
}

/** Plays a sound now. No-op when disabled or unavailable; never throws. */
export function playSound(kind: SoundKind): void {
  if (!enabled) return;
  try {
    const now = Date.now();
    const last = lastPlayed.get(kind);
    if (last !== undefined && now - last < DEDUPE_MS) return;
    const c = getContext();
    const out = master;
    if (!c || !out) return;
    lastPlayed.set(kind, now);
    if (c.state === 'running') {
      scheduleSound(c, out, kind, c.currentTime + 0.005);
      return;
    }
    // Suspended (not unlocked yet, or interrupted): try to resume, and play only if that is quick,
    // so a backlog of stale sounds never bursts out later.
    resume(c, () => {
      if (enabled && Date.now() - now <= MAX_RESUME_DELAY_MS) scheduleSound(c, out, kind, c.currentTime + 0.005);
    });
  } catch {
    /* audio is optional */
  }
}

function getContext(): AudioContext | null {
  if (ctx || unavailable) return ctx;
  try {
    const g = globalThis as typeof globalThis & { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    if (!Ctor) {
      unavailable = true;
      return null;
    }
    setAmbientSession();
    const c = new Ctor({ latencyHint: 'interactive' });
    const gain = c.createGain();
    gain.gain.value = MASTER_GAIN;
    gain.connect(c.destination);
    ctx = c;
    master = gain;
    hookVisibility();
  } catch {
    unavailable = true;
    ctx = null;
    master = null;
  }
  return ctx;
}

function resume(c: AudioContext, then?: () => void): void {
  try {
    Promise.resolve(c.resume())
      .then(() => {
        if (then && c.state === 'running') then();
      })
      .catch(() => {});
  } catch {
    /* ignore */
  }
}

/** Safari 16.4+: respect the silent switch and mix with other audio. */
function setAmbientSession(): void {
  try {
    if (typeof navigator === 'undefined') return;
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = 'ambient';
  } catch {
    /* ignore */
  }
}

function hookVisibility(): void {
  if (visibilityHooked || typeof document === 'undefined') return;
  visibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && enabled && ctx && ctx.state !== 'running') resume(ctx);
  });
}

// ---------------------------------------------------------------------------------------------
// Synthesis. Everything below only schedules nodes on a (possibly offline) context.

/**
 * Schedules `kind` on any BaseAudioContext (an OfflineAudioContext works too, for tests and
 * previews) starting at time `t`, into `out`. Returns the sound's length in seconds.
 */
export function scheduleSound(c: BaseAudioContext, out: AudioNode, kind: SoundKind, t: number): number {
  switch (kind) {
    case 'move':
      return tick(c, out, t, 1, 1);
    case 'capture':
      tick(c, out, t, 1.25, 1.35);
      click(c, out, t, 0.1, 4500);
      return Math.max(tick(c, out, t + 0.024, 1.1, 0.55) + 0.024, 0.12);
    case 'castle':
      tick(c, out, t, 1, 0.9);
      return tick(c, out, t + 0.12, 0.92, 0.9) + 0.12;
    case 'check':
      tick(c, out, t, 1.1, 1);
      tone(c, out, t + 0.03, 1174.66, 0.05, 0.005, 0.32, 'sine');
      tone(c, out, t + 0.03, 1760, 0.022, 0.005, 0.22, 'sine');
      return 0.4;
    case 'promote':
      tick(c, out, t, 1, 0.9);
      [1046.5, 1318.51, 1567.98, 2093].forEach((f, i) => {
        tone(c, out, t + 0.05 + i * 0.065, f, 0.045, 0.006, 0.38, 'sine');
        tone(c, out, t + 0.05 + i * 0.065, f * 2, 0.008, 0.006, 0.2, 'sine');
      });
      return 0.05 + 3 * 0.065 + 0.4;
    case 'gameStart':
      chord(c, out, t, [523.25, 659.25, 783.99], 0.045, 0.9);
      return 0.05 + 0.9;
    case 'gameEnd':
      chord(c, out, t, [392, 493.88, 587.33], 0.04, 0.45);
      chord(c, out, t + 0.2, [261.63, 329.63, 392, 523.25], 0.04, 1.3);
      return 0.2 + 0.05 + 1.3;
    case 'illegal':
      buzz(c, out, t);
      return 0.16;
    case 'notify':
      tone(c, out, t, 1318.51, 0.1, 0.004, 0.35, 'sine');
      tone(c, out, t, 2637.02, 0.02, 0.004, 0.18, 'sine');
      return 0.36;
  }
}

/**
 * A woody tick: a short high click, a resonant band of noise (the "wood") and a low thump
 * with a quick pitch drop (the "body"). `pitch` scales every frequency, `level` the loudness.
 */
function tick(c: BaseAudioContext, out: AudioNode, t: number, pitch: number, level: number): number {
  click(c, out, t, 0.08 * level, 4000 * pitch);

  // A few milliseconds of noise excite a bank of resonant band-passes (the modes of a wood block).
  const exciter = c.createBufferSource();
  exciter.buffer = noiseBuffer(c);
  const burst = envelope(c, t, 1, 0.0005, 0.006);
  exciter.connect(burst);
  const mix = c.createGain();
  mix.gain.value = level;
  mix.connect(out);
  for (const [freq, q, gain] of WOOD_MODES) {
    const band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq * pitch;
    band.Q.value = q;
    const g = c.createGain();
    g.gain.value = gain;
    burst.connect(band).connect(g).connect(mix);
  }
  exciter.start(t, 0.1); // fixed slice of the (seeded) noise: consistent level from tick to tick
  exciter.stop(t + 0.02);

  // A little low "body" for warmth on headphones (phone speakers barely reproduce it).
  const body = c.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(420 * pitch, t);
  body.frequency.exponentialRampToValueAtTime(210 * pitch, t + 0.04);
  body.connect(envelope(c, t, 0.05 * level, 0.002, 0.045)).connect(out);
  body.start(t);
  body.stop(t + 0.06);
  return 0.08;
}

/** Wood-block resonances: [frequency Hz, Q, gain]. */
const WOOD_MODES: readonly (readonly [number, number, number])[] = [
  [560, 12, 3.2],
  [1080, 18, 9],
  [2350, 14, 3.6],
];

/** A very short band of noise around `freq` (the contact "click"), without top-end hiss. */
function click(c: BaseAudioContext, out: AudioNode, t: number, peak: number, freq: number): void {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = freq;
  band.Q.value = 0.9;
  src.connect(band).connect(envelope(c, t, peak, 0.0005, 0.01)).connect(out);
  src.start(t, 0.3);
  src.stop(t + 0.02);
}

function tone(
  c: BaseAudioContext,
  out: AudioNode,
  t: number,
  freq: number,
  peak: number,
  attack: number,
  decay: number,
  type: OscillatorType,
): void {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(envelope(c, t, peak, attack, decay)).connect(out);
  osc.start(t);
  osc.stop(t + attack + decay + 0.02);
}

/** A soft, slightly strummed chord through a gentle low-pass. */
function chord(c: BaseAudioContext, out: AudioNode, t: number, freqs: number[], peak: number, decay: number): void {
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2400;
  lp.connect(out);
  freqs.forEach((f, i) => {
    const start = t + i * 0.018;
    tone(c, lp, start, f, peak, 0.015, decay, 'triangle');
    tone(c, lp, start, f * 1.003, peak * 0.4, 0.02, decay * 0.8, 'sine');
  });
}

/** A low, muffled buzz: two detuned sawtooths through a low-pass. */
function buzz(c: BaseAudioContext, out: AudioNode, t: number): void {
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1000;
  lp.Q.value = 0.7;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.008);
  g.gain.setValueAtTime(0.09, t + 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  lp.connect(g).connect(out);
  for (const f of [155, 164]) {
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = f;
    osc.connect(lp);
    osc.start(t);
    osc.stop(t + 0.16);
  }
}

/** Gain node with an exponential attack/decay envelope starting at `t`. */
function envelope(c: BaseAudioContext, t: number, peak: number, attack: number, decay: number): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

/** 0.5 s of white noise (seeded, so every tick sounds the same), created once per context. */
function noiseBuffer(c: BaseAudioContext): AudioBuffer {
  let buf = noiseBuffers.get(c);
  if (!buf) {
    buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 0x9e3779b9;
    for (let i = 0; i < data.length; i++) {
      // xorshift32
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[i] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    }
    noiseBuffers.set(c, buf);
  }
  return buf;
}
