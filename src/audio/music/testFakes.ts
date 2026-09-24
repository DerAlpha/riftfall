/**
 * Minimal fake Web Audio for the music tests (Node has none): parameters record their automation,
 * nodes their connections, sources their start / stop; resume() / suspend() settle on demand.
 * Test-only (imported by *.test.ts files).
 */
export class FakeParam {
  value = 0;
  readonly events: { type: string; value: number; time: number }[] = [];
  private log(type: string, value: number, time: number): this {
    this.events.push({ type, value, time });
    this.value = value;
    return this;
  }
  setValueAtTime(v: number, t: number): this {
    return this.log('set', v, t);
  }
  linearRampToValueAtTime(v: number, t: number): this {
    return this.log('linear', v, t);
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    return this.log('exp', v, t);
  }
  setTargetAtTime(v: number, t: number): this {
    return this.log('target', v, t);
  }
  cancelScheduledValues(): this {
    return this;
  }
}

export class FakeNode {
  readonly outputs = new Set<FakeNode | FakeParam>();
  channelCount = 2;
  channelCountMode = 'max';
  connect<T extends FakeNode | FakeParam>(node: T): T {
    this.outputs.add(node);
    return node;
  }
  disconnect(node?: FakeNode): void {
    if (node) this.outputs.delete(node);
    else this.outputs.clear();
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
  constructor() {
    super();
    this.gain.value = 1;
  }
}

export class FakeFilter extends FakeNode {
  type = 'lowpass';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
}

export class FakeDelay extends FakeNode {
  readonly delayTime = new FakeParam();
}

export class FakePanner extends FakeNode {
  readonly pan = new FakeParam();
  panningModel = '';
  distanceModel = '';
  refDistance = 1;
  maxDistance = 1;
  rolloffFactor = 1;
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
}

export class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
}

export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
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
}

export interface FakeBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  copyToChannel(): void;
  getChannelData(): Float32Array;
}

export function fakeBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    copyToChannel: () => undefined,
    getChannelData: () => new Float32Array(length),
  };
}

export class FakeAudioContext {
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
  private readonly listeners = new Set<() => void>();

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
  addEventListener(_type: string, fn: () => void): void {
    this.listeners.add(fn);
  }
  removeEventListener(_type: string, fn: () => void): void {
    this.listeners.delete(fn);
  }
  setState(state: 'suspended' | 'running'): void {
    this.state = state;
    this.onstatechange?.();
    for (const fn of this.listeners) fn();
  }

  createGain(): FakeGain {
    return new FakeGain();
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter();
  }
  createDelay(): FakeDelay {
    return new FakeDelay();
  }
  createStereoPanner(): FakePanner {
    return new FakePanner();
  }
  createPanner(): FakePanner {
    return new FakePanner();
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor();
  }
  createConvolver(): FakeNode & { buffer: unknown } {
    return Object.assign(new FakeNode(), { buffer: null as unknown });
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return fakeBuffer(channels, length, sampleRate);
  }

  private defer(state: 'running' | 'suspended'): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending.push(() => {
        if (this.state !== 'closed') this.setState(state);
        resolve();
      });
    });
  }
}
