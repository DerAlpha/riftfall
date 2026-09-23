/**
 * AudioEngine context/voice logic against a minimal fake Web Audio implementation (Node has none).
 * The fake records resume/suspend calls and settles them only on demand, so the pause/resume races
 * the engine must survive can be reproduced deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { AUDIO } from '../defs/audio';
import { createDefaultSettings } from '../save/settingsSchema';
import { AudioEngine } from './AudioEngine';

class FakeParam {
  value = 0;
  setValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number): this {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number): this {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}

class FakeNode {
  readonly outputs = new Set<FakeNode>();
  connect<T extends FakeNode>(node: T): T {
    this.outputs.add(node);
    return node;
  }
  disconnect(node?: FakeNode): void {
    if (node) this.outputs.delete(node);
    else this.outputs.clear();
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  readonly playbackRate = new FakeParam();
  onended: (() => void) | null = null;
  startedAt = -1;
  stoppedAt = -1;
  start(t = 0): void {
    this.startedAt = t;
  }
  stop(t = 0): void {
    this.stoppedAt = t;
  }
  /** Simulate the source reaching its end. */
  end(): void {
    this.onended?.();
  }
}

class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
}

class FakeConvolver extends FakeNode {
  buffer: unknown = null;
}

class FakePanner extends FakeNode {
  panningModel = '';
  distanceModel = '';
  refDistance = 1;
  maxDistance = 1;
  rolloffFactor = 1;
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
}

function fakeBuffer(channels: number, length: number, sampleRate: number) {
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    copyToChannel: (): void => undefined,
    getChannelData: (): Float32Array => new Float32Array(length),
  };
}

class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = [];
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 0;
  readonly sampleRate = 48000;
  readonly baseLatency = 0.01;
  readonly destination = new FakeNode();
  readonly listener = {
    positionX: new FakeParam(),
    positionY: new FakeParam(),
    positionZ: new FakeParam(),
    forwardX: new FakeParam(),
    forwardY: new FakeParam(),
    forwardZ: new FakeParam(),
    upX: new FakeParam(),
    upY: new FakeParam(),
    upZ: new FakeParam(),
  };
  onstatechange: (() => void) | null = null;
  readonly sources: FakeSource[] = [];
  resumeCalls = 0;
  suspendCalls = 0;
  private readonly pending: (() => void)[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  resume(): Promise<void> {
    this.resumeCalls++;
    return this.defer('running');
  }
  suspend(): Promise<void> {
    this.suspendCalls++;
    return this.defer('suspended');
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
  /** Complete every pending resume()/suspend() in call order. */
  settle(): void {
    for (const op of this.pending.splice(0)) op();
  }

  createGain(): FakeGain {
    return new FakeGain();
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor();
  }
  createConvolver(): FakeConvolver {
    return new FakeConvolver();
  }
  createPanner(): FakePanner {
    return new FakePanner();
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return fakeBuffer(channels, length, sampleRate);
  }

  private defer(state: 'running' | 'suspended'): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending.push(() => {
        if (this.state !== 'closed') this.state = state;
        resolve();
      });
    });
  }
}

const BUFFER = fakeBuffer(1, 4800, 48000) as unknown as AudioBuffer;
const SUSPEND_MS = AUDIO.pauseSuspendDelay * 1000;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('AudioEngine (fake Web Audio)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    FakeAudioContext.instances.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function setup(paused: boolean) {
    const events = new EventBus<GameEvents>();
    const engine = new AudioEngine(events, createDefaultSettings().audio);
    engine.registerBuffer('jump', BUFFER);
    engine.registerBuffer('ui.click', BUFFER);
    engine.setPaused(paused);
    const unlocked = engine.unlock();
    const ctx = FakeAudioContext.instances[0]!;
    ctx.settle();
    await unlocked;
    await flush();
    // The silent iOS unlock buffer is not a voice.
    const baseSources = ctx.sources.length;
    return { engine, ctx, baseSources };
  }

  it('suspends the context again after unlocking inside a paused menu', async () => {
    const { ctx, engine } = await setup(true);
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe('running');
    await vi.advanceTimersByTimeAsync(SUSPEND_MS);
    expect(ctx.suspendCalls).toBe(1);
    ctx.settle();
    await flush();
    expect(ctx.state).toBe('suspended');
    expect(engine.ready).toBe(false);
  });

  it('keeps menus audible while paused and suspends once the UI sound ended', async () => {
    const { ctx, engine, baseSources } = await setup(true);
    await vi.advanceTimersByTimeAsync(SUSPEND_MS);
    ctx.settle();
    await flush();
    expect(ctx.state).toBe('suspended');

    engine.play('jump');
    expect(ctx.sources.length).toBe(baseSources);

    engine.play('ui.click', { bus: 'ui' });
    expect(ctx.sources.length).toBe(baseSources + 1);
    expect(ctx.resumeCalls).toBe(2);
    ctx.settle();
    await flush();
    expect(ctx.state).toBe('running');

    // Still playing: the suspend is postponed.
    await vi.advanceTimersByTimeAsync(SUSPEND_MS);
    expect(ctx.suspendCalls).toBe(1);

    ctx.sources[baseSources]!.end();
    await vi.advanceTimersByTimeAsync(SUSPEND_MS);
    expect(ctx.suspendCalls).toBe(2);
    ctx.settle();
    await flush();
    expect(ctx.state).toBe('suspended');
    expect(engine.stats.activeVoices).toBe(0);
  });

  it('never stays suspended after a quick pause/resume while suspend() is in flight', async () => {
    const { ctx, engine } = await setup(false);
    expect(ctx.state).toBe('running');
    engine.setPaused(true);
    await vi.advanceTimersByTimeAsync(SUSPEND_MS);
    expect(ctx.suspendCalls).toBe(1);
    engine.setPaused(false);
    ctx.settle(); // the suspend completes after the unpause
    await flush();
    expect(ctx.resumeCalls).toBe(2);
    ctx.settle();
    await flush();
    expect(ctx.state).toBe('running');
  });

  it('schedules sounds requested while a resume is pending instead of dropping them', async () => {
    const { ctx, engine, baseSources } = await setup(true);
    await vi.advanceTimersByTimeAsync(SUSPEND_MS);
    ctx.settle();
    await flush();
    engine.setPaused(false);
    expect(ctx.state).toBe('suspended');
    engine.play('jump');
    expect(ctx.sources.length).toBe(baseSources + 1);
    ctx.settle();
    await flush();
    expect(ctx.state).toBe('running');
  });

  it('steals the quietest one-shot at the voice limit and leaves loops alone', async () => {
    const { ctx, engine, baseSources } = await setup(false);
    const loop = engine.startLoop('jump', { volume: 0.01 });
    expect(loop).toBeGreaterThan(0);
    for (let i = 0; i < AUDIO.maxVoices; i++) engine.play('jump', { volume: i === 7 ? 0.1 : 1 });
    expect(engine.stats.activeVoices).toBe(AUDIO.maxVoices + 1);
    engine.play('jump');
    expect(engine.stats.activeVoices).toBe(AUDIO.maxVoices + 1);
    const sources = ctx.sources.slice(baseSources);
    expect(sources[0]!.stoppedAt).toBe(-1); // loop untouched
    expect(sources[1 + 7]!.stoppedAt).toBeGreaterThanOrEqual(0); // the quiet one-shot
    expect(sources.filter((s) => s.stoppedAt >= 0)).toHaveLength(1);

    engine.stopLoop(loop);
    expect(sources[0]!.stoppedAt).toBeGreaterThanOrEqual(0);
    expect(engine.stats.activeVoices).toBe(AUDIO.maxVoices);
  });

  it('ignores game sounds while paused and closes the context on dispose', async () => {
    const { ctx, engine, baseSources } = await setup(false);
    engine.setPaused(true);
    engine.play('jump');
    expect(engine.startLoop('jump')).toBe(0);
    expect(ctx.sources.length).toBe(baseSources);
    engine.dispose();
    expect(ctx.state).toBe('closed');
    engine.play('ui.click', { bus: 'ui' });
    expect(ctx.sources.length).toBe(baseSources);
  });
});
