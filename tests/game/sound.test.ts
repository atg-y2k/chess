import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoundKind } from '../../src/game/sound';

const KINDS: SoundKind[] = ['move', 'capture', 'check', 'castle', 'promote', 'gameStart', 'gameEnd', 'illegal', 'notify'];

/** Fresh module state for every test (the AudioContext is a lazy module singleton). */
async function loadSound() {
  vi.resetModules();
  return import('../../src/game/sound');
}

// --- A tiny fake of the Web Audio graph, enough to record what the synth schedules. ---

class FakeParam {
  value = 0;
  max = 0;
  private note(v: number) {
    this.max = Math.max(this.max, v);
  }
  setValueAtTime(v: number) {
    this.note(v);
    return this;
  }
  exponentialRampToValueAtTime(v: number) {
    if (!(v > 0)) throw new RangeError('exponential ramp target must be > 0');
    this.note(v);
    return this;
  }
  linearRampToValueAtTime(v: number) {
    this.note(v);
    return this;
  }
}

class FakeNode {
  connect<T>(n: T): T {
    return n;
  }
  disconnect() {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeSource extends FakeNode {
  frequency = new FakeParam();
  type = '';
  buffer: unknown = null;
  constructor(private log: { starts: number[]; stops: number[] }) {
    super();
  }
  start(t = 0) {
    this.log.starts.push(t);
  }
  stop(t = 0) {
    this.log.stops.push(t);
  }
}

class FakeContext {
  static instances: FakeContext[] = [];
  state: 'suspended' | 'running' = 'suspended';
  currentTime = 1;
  sampleRate = 48000;
  destination = new FakeNode();
  log = { starts: [] as number[], stops: [] as number[] };
  gains: FakeGain[] = [];
  resumes = 0;
  constructor() {
    FakeContext.instances.push(this);
  }
  resume() {
    this.resumes++;
    this.state = 'running';
    return Promise.resolve();
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createOscillator() {
    return new FakeSource(this.log);
  }
  createBufferSource() {
    return new FakeSource(this.log);
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: '', frequency: new FakeParam(), Q: new FakeParam() });
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeContext.instances = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('soundForSan', () => {
  it('picks one sound per move by priority', async () => {
    const { soundForSan } = await loadSound();
    expect(soundForSan('e4')).toBe('move');
    expect(soundForSan('Nxe5')).toBe('capture');
    expect(soundForSan('O-O')).toBe('castle');
    expect(soundForSan('O-O-O')).toBe('castle');
    expect(soundForSan('e8=Q')).toBe('promote');
    expect(soundForSan('dxe8=Q')).toBe('promote');
    expect(soundForSan('Qxf7+')).toBe('check');
    expect(soundForSan('O-O+')).toBe('check');
    expect(soundForSan('Qh4#')).toBe('check');
    expect(soundForSan('e8=Q+')).toBe('check');
  });
});

describe('sound without Web Audio', () => {
  it('playSound / unlockAudio are silent no-ops in node (no AudioContext)', async () => {
    const s = await loadSound();
    expect(typeof globalThis.AudioContext).toBe('undefined');
    expect(() => s.unlockAudio()).not.toThrow();
    for (const k of KINDS) expect(() => s.playSound(k)).not.toThrow();
    expect(() => s.setSoundEnabled(false)).not.toThrow();
    expect(() => s.setSoundEnabled(true)).not.toThrow();
  });

  it('never throws when the AudioContext constructor or its methods throw', async () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('NotAllowedError');
        }
      },
    );
    let s = await loadSound();
    expect(() => s.unlockAudio()).not.toThrow();
    for (const k of KINDS) expect(() => s.playSound(k)).not.toThrow();

    vi.stubGlobal(
      'AudioContext',
      class extends FakeContext {
        createOscillator(): never {
          throw new Error('InvalidStateError');
        }
      },
    );
    s = await loadSound();
    s.unlockAudio();
    await flush();
    for (const k of KINDS) expect(() => s.playSound(k)).not.toThrow();
  });
});

describe('sound with a (fake) AudioContext', () => {
  it('creates the context lazily and unlocks it', async () => {
    vi.stubGlobal('AudioContext', FakeContext);
    const s = await loadSound();
    expect(FakeContext.instances).toHaveLength(0);
    s.unlockAudio();
    expect(FakeContext.instances).toHaveLength(1);
    const ctx = FakeContext.instances[0];
    expect(ctx.resumes).toBe(1);
    expect(ctx.log.starts).toHaveLength(1); // the 1-sample silent buffer
    s.unlockAudio();
    expect(FakeContext.instances).toHaveLength(1);
  });

  it('schedules every sound kind with short, quiet envelopes', async () => {
    vi.stubGlobal('AudioContext', FakeContext);
    const s = await loadSound();
    s.unlockAudio();
    await flush();
    const ctx = FakeContext.instances[0];
    for (const kind of KINDS) {
      ctx.log.starts = [];
      ctx.log.stops = [];
      ctx.gains = [];
      s.playSound(kind);
      expect(ctx.log.starts.length, kind).toBeGreaterThan(0);
      expect(ctx.log.stops.length, kind).toBe(ctx.log.starts.length);
      const length = Math.max(...ctx.log.stops) - ctx.currentTime;
      expect(length, kind).toBeLessThan(1.7);
      // Envelope peaks (automation) stay <= 1; the rendered output peaks at about 0.1..0.3,
      // measured with an OfflineAudioContext in Chromium.
      for (const g of ctx.gains) expect(g.gain.max, kind).toBeLessThanOrEqual(1);
    }
  });

  it('does nothing while disabled, and ignores an immediate duplicate', async () => {
    vi.stubGlobal('AudioContext', FakeContext);
    const s = await loadSound();
    s.setSoundEnabled(false);
    s.unlockAudio();
    s.playSound('move');
    expect(FakeContext.instances).toHaveLength(0);
    expect(s.isSoundEnabled()).toBe(false);

    s.setSoundEnabled(true); // also unlocks
    await flush();
    const ctx = FakeContext.instances[0];
    ctx.log.starts = [];
    s.playSound('move');
    const once = ctx.log.starts.length;
    s.playSound('move');
    expect(ctx.log.starts.length).toBe(once);
  });

  it('plays after a quick resume when the context was still suspended', async () => {
    vi.stubGlobal('AudioContext', FakeContext);
    const s = await loadSound();
    s.playSound('notify'); // creates the context (suspended) and resumes it
    const ctx = FakeContext.instances[0];
    expect(ctx.log.starts).toHaveLength(0);
    await flush();
    expect(ctx.state).toBe('running');
    expect(ctx.log.starts.length).toBeGreaterThan(0);
  });
});
