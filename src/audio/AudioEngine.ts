/**
 * Web Audio engine.
 *
 * Graph (built lazily in unlock(), which must run inside a user gesture):
 *
 *   voice: source → gain → [HRTF panner] → bus
 *   music bus → duck ─┐
 *   sfx / voice bus ──┼→ gameFader (pause) ─┐
 *   sfx bus → convolver A|B → wet A|B ─┘       ├→ master (volume) → outFader (background) → limiter → out
 *   ui bus ────────────────────────────────────┘
 *
 * Pause fades the game buses and then suspends the context (no audio CPU in menus). The ui bus
 * bypasses the pause fader, so menus still click: a UI sound requested while paused wakes the
 * context and it is suspended again once the sound has finished.
 *
 * Sounds resolve to registered asset buffers (registerBuffer) first, then procedural synth
 * buffers (SynthBank, pre-rendered while the game loads). One-shots are voice-limited with
 * stealing (quietest/oldest one-shot first); loops are started/stopped through handles. Volume
 * changes are smoothed with setTargetAtTime to avoid zipper noise.
 */
import type { AudioApi, AudioBus, PlayOptions } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { AUDIO, type ReverbZone } from '../defs/audio';
import { createSilentBuffer } from '../assets/placeholders';
import type { AudioSettings } from '../save/settingsSchema';
import { pickStealIndex, pickVariant } from './dsp';
import { generateImpulseResponse } from './reverb';
import { SynthBank, resolveSynthId } from './synth';

const log = createLogger('Audio');

export interface LoopOptions extends PlayOptions {
  /** Fade-in time (s). */
  fadeIn?: number;
  /** Safety stop after this many seconds (s). */
  maxDuration?: number;
}

interface Voice {
  handle: number;
  source: AudioBufferSourceNode | null;
  readonly gain: GainNode;
  panner: PannerNode | null;
  bus: AudioBus;
  volume: number;
  startTime: number;
  loop: boolean;
}

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  /** Pause fade of the game buses (music, sfx incl. reverb, voice). */
  gameFader: GainNode;
  /** Background mute of everything (muteInBackground) and the initial fade-in. */
  outFader: GainNode;
  limiter: DynamicsCompressorNode;
  buses: Record<AudioBus, GainNode>;
  duck: GainNode;
  reverb: [ReverbSlot, ReverbSlot];
}

interface ReverbSlot {
  convolver: ConvolverNode;
  wet: GainNode;
  connected: boolean;
  zone: ReverbZone | null;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof AudioContext !== 'undefined') return AudioContext;
  // Safari < 14.1.
  const w = globalThis as unknown as { webkitAudioContext?: AudioContextCtor };
  return w.webkitAudioContext ?? null;
}

/** setTargetAtTime reaches ~95% after three time constants. */
function smoothTo(param: AudioParam, value: number, seconds: number, now: number): void {
  param.setTargetAtTime(value, now, Math.max(1e-3, seconds / 3));
}

export class AudioEngine implements AudioApi {
  private graph: Graph | null = null;
  private settings: AudioSettings;
  private paused = false;
  private backgroundMuted = false;
  /** Pending ctx.resume() (sources scheduled meanwhile start once the context runs). */
  private resumePromise: Promise<void> | null = null;
  /** A ctx.suspend() is in flight (the state still reads 'running'). */
  private suspending = false;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private reverbTimer: ReturnType<typeof setTimeout> | null = null;
  private synth: SynthBank | null = null;
  private readonly registered = new Map<string, AudioBuffer[]>();
  private readonly lastVariant = new Map<string, number>();
  private readonly warned = new Set<string>();
  private readonly active: Voice[] = [];
  private readonly free: Voice[] = [];
  private nextHandle = 1;
  private voiceBusCount = 0;
  private activeReverb = 0;
  private reverbZone: ReverbZone | null = null;
  private readonly irCache = new Map<ReverbZone, AudioBuffer>();
  private readonly listenerState = new Float64Array(9).fill(Number.NaN);
  private readonly statsObj = { activeVoices: 0, contextState: 'locked' };
  private disposed = false;
  private readonly onVisibility = (): void => this.updateBackgroundMute();
  private readonly offSettings: () => void;

  constructor(events: EventBus<GameEvents>, settings: Readonly<AudioSettings>) {
    this.settings = { ...settings };
    // Self-subscribing keeps volumes in sync; an extra applySettings() call from outside is harmless.
    this.offSettings = events.on('settings:changed', (e) => {
      if (e.sections.includes('audio')) this.applySettings(e.settings.audio);
    });
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    // Offline rendering needs no user gesture: warm the procedural bank while the game loads, so the
    // first footsteps after unlock are not skipped.
    if (typeof OfflineAudioContext !== 'undefined') this.useSynthBank(AUDIO.synth.prewarmSampleRate);
  }

  /** The AudioContext once unlocked (asset decoding shares it). */
  get context(): AudioContext | null {
    return this.graph?.ctx ?? null;
  }

  get ready(): boolean {
    return this.graph !== null && this.graph.ctx.state === 'running';
  }

  get stats(): { activeVoices: number; contextState: string } {
    this.statsObj.activeVoices = this.active.length;
    this.statsObj.contextState = this.graph ? this.graph.ctx.state : 'locked';
    return this.statsObj;
  }

  unlock(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.graph) {
      const Ctor = audioContextCtor();
      if (!Ctor) {
        if (!this.warned.has('no-webaudio')) log.warn('Web Audio unavailable – running silent');
        this.warned.add('no-webaudio');
        return Promise.resolve();
      }
      try {
        this.graph = this.buildGraph(new Ctor({ latencyHint: AUDIO.context.latencyHint }));
      } catch (err) {
        log.error('Creating the AudioContext failed – running silent', err);
        return Promise.resolve();
      }
      const ctx = this.graph.ctx;
      // iOS only unlocks output when a buffer is started inside the gesture.
      try {
        const src = ctx.createBufferSource();
        src.buffer = createSilentBuffer(ctx);
        src.connect(ctx.destination);
        src.start();
      } catch {
        // Not required elsewhere.
      }
      this.useSynthBank(ctx.sampleRate);
      if (this.reverbZone) this.applyReverbZone(this.reverbZone, 0);
      this.applyGains(0);
      log.info(
        `AudioContext ${ctx.sampleRate} Hz, base latency ${((ctx.baseLatency ?? 0) * 1000).toFixed(1)} ms`,
      );
    }
    // Resume even while paused: some browsers (iOS Safari) only allow it inside the gesture. The
    // game fader keeps it silent and the context is suspended again shortly if still paused.
    const resumed = this.resumeContext();
    if (this.paused) this.scheduleSuspend();
    return resumed;
  }

  applySettings(a: AudioSettings): void {
    this.settings = { ...a };
    this.applyGains(AUDIO.gainSmoothing);
    this.updateBackgroundMute();
  }

  setListener(position: Vec3Like, forward: Vec3Like, up: Vec3Like): void {
    const g = this.graph;
    if (!g) return;
    const s = this.listenerState;
    const eps = AUDIO.listenerEpsilon;
    if (
      Math.abs(s[0]! - position.x) < eps &&
      Math.abs(s[1]! - position.y) < eps &&
      Math.abs(s[2]! - position.z) < eps &&
      Math.abs(s[3]! - forward.x) < eps &&
      Math.abs(s[4]! - forward.y) < eps &&
      Math.abs(s[5]! - forward.z) < eps &&
      Math.abs(s[6]! - up.x) < eps &&
      Math.abs(s[7]! - up.y) < eps &&
      Math.abs(s[8]! - up.z) < eps
    ) {
      return;
    }
    s[0] = position.x;
    s[1] = position.y;
    s[2] = position.z;
    s[3] = forward.x;
    s[4] = forward.y;
    s[5] = forward.z;
    s[6] = up.x;
    s[7] = up.y;
    s[8] = up.z;
    const l = g.ctx.listener;
    if (l.positionX) {
      const end = g.ctx.currentTime + AUDIO.listenerRamp;
      l.positionX.linearRampToValueAtTime(position.x, end);
      l.positionY.linearRampToValueAtTime(position.y, end);
      l.positionZ.linearRampToValueAtTime(position.z, end);
      l.forwardX.linearRampToValueAtTime(forward.x, end);
      l.forwardY.linearRampToValueAtTime(forward.y, end);
      l.forwardZ.linearRampToValueAtTime(forward.z, end);
      l.upX.linearRampToValueAtTime(up.x, end);
      l.upY.linearRampToValueAtTime(up.y, end);
      l.upZ.linearRampToValueAtTime(up.z, end);
    } else {
      // Firefox < 120 / old Safari: deprecated setters only.
      l.setPosition(position.x, position.y, position.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /** Register decoded asset buffers for an id (several = random variants). Overrides synth sounds. */
  registerBuffer(id: string, buffer: AudioBuffer | readonly AudioBuffer[]): void {
    const list = Array.isArray(buffer) ? [...(buffer as readonly AudioBuffer[])] : [buffer as AudioBuffer];
    if (list.length === 0) return;
    this.registered.set(id, list);
  }

  /** True if `id` resolves to an asset buffer or a procedural sound. */
  has(id: string): boolean {
    return this.registered.has(id) || resolveSynthId(id) !== null;
  }

  play(id: string, opts?: PlayOptions): void {
    this.startVoice(id, opts, false, 0, 0);
  }

  /** Start a looping sound; returns a handle for stopLoop (0 if it could not start). */
  startLoop(id: string, opts?: LoopOptions): number {
    const voice = this.startVoice(id, opts, true, opts?.fadeIn ?? AUDIO.loopFadeIn, opts?.maxDuration ?? 0);
    return voice ? voice.handle : 0;
  }

  stopLoop(handle: number, fadeSeconds: number = AUDIO.loopFadeOut): void {
    if (handle <= 0) return;
    const voice = this.active.find((v) => v.handle === handle);
    if (voice) this.fadeAndStop(voice, fadeSeconds);
  }

  setReverbZone(zone: ReverbZone): void {
    if (zone === this.reverbZone && this.graph?.reverb[this.activeReverb]?.zone === zone) return;
    this.reverbZone = zone;
    if (this.graph) this.applyReverbZone(zone, AUDIO.reverbCrossfade);
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    const g = this.graph;
    if (!g || g.ctx.state === 'closed') return;
    this.cancelSuspend();
    smoothTo(g.gameFader.gain, paused ? 0 : 1, AUDIO.pauseFade, g.ctx.currentTime);
    if (paused) this.scheduleSuspend();
    else void this.resumeContext();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offSettings();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.cancelSuspend();
    if (this.reverbTimer !== null) clearTimeout(this.reverbTimer);
    this.reverbTimer = null;
    for (const v of [...this.active]) {
      try {
        v.source?.stop();
      } catch {
        // already stopped
      }
      this.release(v);
    }
    this.free.length = 0;
    const g = this.graph;
    this.graph = null;
    if (g) void g.ctx.close().catch(() => undefined);
    this.registered.clear();
    this.irCache.clear();
    this.synth = null;
  }

  // -------------------------------------------------------------------------
  // Context state (suspend / resume)
  // -------------------------------------------------------------------------

  /**
   * Resume the context unless it runs already. A resume requested while a suspend is in flight is
   * issued by that suspend's completion handler (the state still reads 'running' until then).
   */
  private resumeContext(): Promise<void> {
    const g = this.graph;
    if (!g || this.disposed) return Promise.resolve();
    const ctx = g.ctx;
    if (ctx.state === 'closed' || this.suspending) return Promise.resolve();
    if (ctx.state === 'running' && !this.resumePromise) return Promise.resolve();
    this.resumePromise ??= ctx
      .resume()
      .catch((err: unknown) => log.warn('AudioContext resume failed (needs a user gesture)', err))
      .finally(() => {
        this.resumePromise = null;
        // Paused meanwhile (or resumed only for a menu click): suspend again once idle.
        if (this.paused && !this.disposed) this.scheduleSuspend();
      });
    return this.resumePromise;
  }

  private cancelSuspend(): void {
    if (this.suspendTimer === null) return;
    clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
  }

  /** Suspend after the pause fade has settled; re-checked when it fires. */
  private scheduleSuspend(): void {
    this.cancelSuspend();
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = null;
      this.trySuspend();
    }, AUDIO.pauseSuspendDelay * 1000);
  }

  private trySuspend(): void {
    const g = this.graph;
    if (!g || !this.paused || this.disposed || this.suspending || this.resumePromise) return;
    // A menu sound is still playing: its release schedules the suspend again.
    if (g.ctx.state !== 'running' || this.hasActiveUiVoice()) return;
    this.suspending = true;
    void g.ctx
      .suspend()
      .catch(() => undefined)
      .finally(() => {
        this.suspending = false;
        // Unpaused (or a menu sound queued) while the suspend was in flight.
        if (!this.disposed && (!this.paused || this.hasActiveUiVoice())) void this.resumeContext();
      });
  }

  private hasActiveUiVoice(): boolean {
    for (const v of this.active) if (v.bus === 'ui') return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // Graph
  // -------------------------------------------------------------------------

  private buildGraph(ctx: AudioContext): Graph {
    const L = AUDIO.limiter;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = L.threshold;
    limiter.knee.value = L.knee;
    limiter.ratio.value = L.ratio;
    limiter.attack.value = L.attack;
    limiter.release.value = L.release;
    limiter.connect(ctx.destination);

    const outFader = ctx.createGain();
    outFader.gain.value = 0;
    outFader.connect(limiter);
    const master = ctx.createGain();
    master.connect(outFader);
    const gameFader = ctx.createGain();
    gameFader.gain.value = 0;
    gameFader.connect(master);

    const buses = {} as Record<AudioBus, GainNode>;
    for (const name of AUDIO.buses) buses[name] = ctx.createGain();
    const duck = ctx.createGain();
    buses.music.connect(duck).connect(gameFader);
    buses.sfx.connect(gameFader);
    buses.voice.connect(gameFader);
    // Menus keep clicking while the game is paused.
    buses.ui.connect(master);

    const slot = (): ReverbSlot => {
      const convolver = ctx.createConvolver();
      const wet = ctx.createGain();
      wet.gain.value = 0;
      convolver.connect(wet).connect(gameFader);
      return { convolver, wet, connected: false, zone: null };
    };
    ctx.onstatechange = () => {
      this.statsObj.contextState = ctx.state;
    };
    return { ctx, master, gameFader, outFader, limiter, buses, duck, reverb: [slot(), slot()] };
  }

  /** Procedural bank at `sampleRate`; a bank at another rate keeps serving until the new one is rendered. */
  private useSynthBank(sampleRate: number): void {
    if (this.synth?.sampleRate === sampleRate) return;
    const bank = new SynthBank(sampleRate);
    if (!this.synth) this.synth = bank;
    void bank.renderAll().then(() => {
      if (!this.disposed) this.synth = bank;
    });
  }

  private applyGains(seconds: number): void {
    const g = this.graph;
    if (!g) return;
    const now = g.ctx.currentTime;
    const s = this.settings;
    smoothTo(g.master.gain, s.master, seconds, now);
    smoothTo(g.buses.music.gain, s.music, seconds, now);
    smoothTo(g.buses.sfx.gain, s.sfx, seconds, now);
    smoothTo(g.buses.voice.gain, s.voice, seconds, now);
    smoothTo(g.buses.ui.gain, s.ui, seconds, now);
    smoothTo(g.gameFader.gain, this.paused ? 0 : 1, seconds, now);
    smoothTo(g.outFader.gain, this.backgroundMuted ? 0 : 1, seconds, now);
  }

  private updateBackgroundMute(): void {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const muted = hidden && this.settings.muteInBackground;
    if (muted === this.backgroundMuted) return;
    this.backgroundMuted = muted;
    const g = this.graph;
    if (g) smoothTo(g.outFader.gain, muted ? 0 : 1, AUDIO.backgroundFade, g.ctx.currentTime);
  }

  private impulseFor(zone: ReverbZone): AudioBuffer | null {
    const g = this.graph;
    if (!g) return null;
    let buf = this.irCache.get(zone);
    if (!buf) {
      const channels = generateImpulseResponse(AUDIO.reverbZones[zone], g.ctx.sampleRate, `reverb:${zone}`);
      buf = g.ctx.createBuffer(2, channels[0].length, g.ctx.sampleRate);
      buf.copyToChannel(channels[0], 0);
      buf.copyToChannel(channels[1], 1);
      this.irCache.set(zone, buf);
    }
    return buf;
  }

  private applyReverbZone(zone: ReverbZone, crossfade: number): void {
    const g = this.graph;
    if (!g) return;
    const ir = this.impulseFor(zone);
    if (!ir) return;
    const now = g.ctx.currentTime;
    const fromIdx = this.activeReverb;
    const from = g.reverb[fromIdx];
    const current = from.zone === null ? null : from;
    const toIdx = current ? 1 - fromIdx : fromIdx;
    const to = g.reverb[toIdx];
    if (this.reverbTimer !== null) {
      clearTimeout(this.reverbTimer);
      this.reverbTimer = null;
    }
    // The incoming slot is silent (wet 0) or fading out at this point, so swapping its impulse is inaudible.
    to.convolver.buffer = ir;
    to.zone = zone;
    if (!to.connected) {
      g.buses.sfx.connect(to.convolver);
      to.connected = true;
    }
    smoothTo(to.wet.gain, AUDIO.reverbZones[zone].wet, crossfade, now);
    this.activeReverb = toIdx;
    if (current && current !== to) {
      smoothTo(current.wet.gain, 0, crossfade, now);
      // Disconnect the faded slot so only one convolver costs CPU.
      this.reverbTimer = setTimeout(
        () => {
          this.reverbTimer = null;
          if (current.connected && this.graph && g.reverb[this.activeReverb] !== current) {
            g.buses.sfx.disconnect(current.convolver);
            current.connected = false;
            current.zone = null;
          }
        },
        crossfade * 1000 + 100,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------

  private resolveBuffer(id: string): AudioBuffer | null {
    const list = this.registered.get(id) ?? this.synth?.get(id) ?? null;
    if (!list || list.length === 0) {
      if (!this.has(id) && !this.warned.has(id)) {
        this.warned.add(id);
        log.warn(`Unknown sound "${id}" – ignored`);
      }
      return null;
    }
    const idx = pickVariant(list.length, this.lastVariant.get(id) ?? -1, Math.random());
    this.lastVariant.set(id, idx);
    return list[idx] ?? null;
  }

  /** Whether a sound on `bus` may be scheduled now (wakes a paused context for UI sounds). */
  private canSchedule(g: Graph, bus: AudioBus): boolean {
    if (this.paused && bus !== 'ui') return false;
    const state = g.ctx.state;
    if (state === 'closed') return false;
    if (state === 'running' && !this.suspending) return true;
    if (this.paused) void this.resumeContext();
    // Sources scheduled on a suspended context start once it runs – allowed only while a resume is on
    // its way, otherwise they would pile up and burst out at the next unlock.
    return this.resumePromise !== null || this.suspending;
  }

  private startVoice(
    id: string,
    opts: PlayOptions | undefined,
    loop: boolean,
    fadeIn: number,
    maxDuration: number,
  ): Voice | null {
    const g = this.graph;
    if (!g || this.disposed) return null;
    const bus = opts?.bus ?? 'sfx';
    if (!this.canSchedule(g, bus)) return null;
    const buffer = this.resolveBuffer(id);
    if (!buffer) return null;

    if (!loop && this.countOneShots() >= AUDIO.maxVoices) {
      const idx = pickStealIndex(this.active, AUDIO.stealVolumeEpsilon);
      const victim = idx >= 0 ? this.active[idx] : undefined;
      if (victim) this.fadeAndStop(victim, AUDIO.stealFade, true);
    }

    const ctx = g.ctx;
    const now = ctx.currentTime;
    const voice = this.free.pop() ?? {
      handle: 0,
      source: null,
      gain: ctx.createGain(),
      panner: null,
      bus: 'sfx',
      volume: 1,
      startTime: 0,
      loop: false,
    };
    const volume = opts?.volume ?? 1;
    voice.handle = this.nextHandle++;
    voice.bus = bus;
    voice.volume = volume;
    voice.startTime = now;
    voice.loop = loop;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    const variance = opts?.pitchVariance ?? 0;
    src.playbackRate.value = Math.max(0.05, (opts?.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * variance));
    voice.source = src;

    voice.gain.gain.cancelScheduledValues(now);
    if (fadeIn > 0) {
      voice.gain.gain.setValueAtTime(0, now);
      smoothTo(voice.gain.gain, volume, fadeIn, now);
    } else {
      voice.gain.gain.setValueAtTime(volume, now);
    }
    voice.gain.disconnect();
    src.connect(voice.gain);
    const target = g.buses[bus];
    if (opts?.position) {
      const p = voice.panner ?? this.createPanner(ctx);
      voice.panner = p;
      const pos = opts.position;
      if (p.positionX) {
        p.positionX.value = pos.x;
        p.positionY.value = pos.y;
        p.positionZ.value = pos.z;
      } else {
        // Safari < 14.1: no AudioParams on PannerNode.
        p.setPosition(pos.x, pos.y, pos.z);
      }
      p.disconnect();
      voice.gain.connect(p);
      p.connect(target);
    } else {
      voice.gain.connect(target);
    }

    src.onended = () => {
      if (voice.source === src) this.release(voice);
    };
    src.start(now);
    if (maxDuration > 0) src.stop(now + maxDuration);

    this.active.push(voice);
    if (bus === 'voice') this.onVoiceBus(+1);
    return voice;
  }

  private createPanner(ctx: AudioContext): PannerNode {
    const P = AUDIO.panner;
    const p = ctx.createPanner();
    p.panningModel = P.model;
    p.distanceModel = P.distanceModel;
    p.refDistance = P.refDistance;
    p.maxDistance = P.maxDistance;
    p.rolloffFactor = P.rolloffFactor;
    return p;
  }

  private countOneShots(): number {
    let n = 0;
    for (const v of this.active) if (!v.loop) n++;
    return n;
  }

  /** Fade a voice out and stop it; it leaves the active list now, the nodes are recycled on `ended`. */
  private fadeAndStop(voice: Voice, seconds: number, stolen = false): void {
    const g = this.graph;
    const src = voice.source;
    if (!g || !src) return;
    const now = g.ctx.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(0, now, Math.max(1e-3, seconds / 4));
    try {
      src.stop(now + seconds);
    } catch {
      // already stopped
    }
    this.removeActive(voice);
    // Once only: in big fights stealing is routine and would flood the log history.
    if (stolen && !this.warned.has('voice-steal')) {
      this.warned.add('voice-steal');
      log.debug(`Voice limit (${AUDIO.maxVoices}) reached – stealing quietest/oldest one-shots`);
    }
    // `recycle` runs from onended; the voice is no longer counted meanwhile.
    src.onended = () => {
      if (voice.source === src) this.recycle(voice);
    };
  }

  private release(voice: Voice): void {
    this.removeActive(voice);
    this.recycle(voice);
  }

  private removeActive(voice: Voice): void {
    const idx = this.active.indexOf(voice);
    if (idx < 0) return;
    this.active.splice(idx, 1);
    if (voice.bus === 'voice') this.onVoiceBus(-1);
    // Last menu sound of a paused game finished: the context may be suspended again.
    if (voice.bus === 'ui' && this.paused && !this.disposed) this.scheduleSuspend();
  }

  private recycle(voice: Voice): void {
    const src = voice.source;
    voice.source = null;
    if (src) {
      src.onended = null;
      src.disconnect();
    }
    voice.gain.disconnect();
    voice.panner?.disconnect();
    voice.handle = 0;
    if (!this.disposed) this.free.push(voice);
  }

  /** Duck music while at least one voice-bus sound plays. */
  private onVoiceBus(delta: number): void {
    this.voiceBusCount = Math.max(0, this.voiceBusCount + delta);
    const g = this.graph;
    if (!g) return;
    const now = g.ctx.currentTime;
    if (this.voiceBusCount > 0) smoothTo(g.duck.gain, AUDIO.voiceDuckGain, AUDIO.duckAttack, now);
    else smoothTo(g.duck.gain, 1, AUDIO.duckRelease, now);
  }
}
