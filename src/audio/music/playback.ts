/**
 * Music playback on a (real-time or offline) AudioContext: a preallocated voice pool, the theme
 * player (sequencer → sampler voices → layer gains → low-pass → drop → fader → game / menu route,
 * plus a tempo-synced ping-pong echo) and the sting player.
 *
 * Per note one AudioBufferSourceNode is created (Web Audio sources are single-use); the gain nodes
 * of the voice slots are reused. A slot is only reconnected once its voice has really ended, a
 * new note of a mono slot cuts the previous one, and when every slot is busy the note steals the
 * lowest-priority voice or is dropped (hats and textures never take the last reserve slots).
 */
import { MUSIC, MUSIC_LAYERS, type InstrumentSlot, type MusicLayer, type MusicRoute } from '../../defs/music';
import { HELD_SLOTS, MONO_SLOTS, NATURAL, type ComposedTheme, type NoteEvent } from './composer';
import { LayerMixer } from './intensity';
import { nearestSample, type Sample, type SampleSet, type ThemeSamples } from './MusicBank';
import { Sequencer, type BarInfo, type GridUnit, type SequencerSink } from './sequencer';
import type { ResolvedStingNote } from './stings';
import { midiHz } from './theory';

const V = MUSIC.voices;
const ENV = MUSIC.envelopes;
const MIX = MUSIC.mix;
const OPEN_FILTER = 20000;
/** Declick ramp of one-shot attacks (s). */
const ONE_SHOT_ATTACK = 0.002;

/** Voice priority per slot (higher survives voice stealing). */
const PRIORITY: Readonly<Record<InstrumentSlot, number>> = {
  kick: 5,
  snare: 5,
  bass: 5,
  sub: 5,
  drone: 4,
  pad: 4,
  lead: 4,
  strings: 3,
  choir: 3,
  arp: 3,
  stab: 3,
  dist: 3,
  crash: 3,
  riser: 2,
  swell: 2,
  tom: 2,
  openHat: 1,
  hat: 1,
  metal: 1,
  perc: 1,
  fx: 1,
  scrape: 1,
};

/** One-shot slots cut at the end of their note (tight bass / chugs, sequenced arps); the rest ring out. */
const GATED_ONE_SHOTS: ReadonlySet<InstrumentSlot> = new Set<InstrumentSlot>(['bass', 'dist', 'arp']);

export function slotPriority(slot: InstrumentSlot): number {
  return PRIORITY[slot] ?? 1;
}

export function slotEnvelope(slot: InstrumentSlot): { attack: number; release: number } {
  switch (slot) {
    case 'drone':
      return ENV.drone;
    case 'pad':
      return ENV.pad;
    case 'strings':
      return ENV.strings;
    case 'choir':
      return ENV.choir;
    case 'lead':
      return ENV.lead;
    case 'sub':
      return ENV.sub;
    case 'arp':
      return ENV.arp;
    default:
      return { attack: ONE_SHOT_ATTACK, release: ENV.cut };
  }
}

export interface VoiceRequest {
  sample: Sample;
  rate: number;
  time: number;
  /** Held length (s) of sustained voices / gate of cut one-shots; 0 = let the one-shot ring. */
  gate: number;
  gain: number;
  dest: AudioNode;
  attack: number;
  release: number;
  prio: number;
  mono: InstrumentSlot | null;
  /** Playback-rate multiplier reached after glideTime (s). */
  glide: number;
  glideTime: number;
}

interface VoiceSlot {
  src: AudioBufferSourceNode | null;
  gain: GainNode;
  dest: AudioNode | null;
  end: number;
  /** From here on the voice only rings out (release / decay tail): the first to be stolen. */
  tail: number;
  prio: number;
  mono: InstrumentSlot | null;
}

/** One-shots count as ringing out this long after their start (s). */
const ONE_SHOT_BODY = 0.25;
/** Stealing score offset of voices still in their body (tails go first). */
const BODY_SCORE = 100;

export class VoicePool {
  private readonly slots: VoiceSlot[] = [];
  /** Notes dropped for lack of voices (debug). */
  dropped = 0;

  constructor(
    private readonly ctx: BaseAudioContext,
    size: number,
  ) {
    for (let k = 0; k < size; k++) {
      this.slots.push({
        src: null,
        gain: ctx.createGain(),
        dest: null,
        end: 0,
        tail: 0,
        prio: 0,
        mono: null,
      });
    }
  }

  /** Voices sounding (or scheduled) after `now`. */
  active(now: number): number {
    let n = 0;
    for (const s of this.slots) if (s.end > now) n++;
    return n;
  }

  play(r: VoiceRequest): boolean {
    const now = this.ctx.currentTime;
    if (r.mono !== null) {
      for (const s of this.slots) {
        if (s.mono === r.mono && s.end > r.time) this.cut(s, r.time);
      }
    }
    let slot: VoiceSlot | null = null;
    let free = 0;
    for (const s of this.slots) {
      if (s.end <= now) {
        free++;
        slot ??= s;
      }
    }
    if (slot && r.prio <= 1 && free <= V.reserve) slot = null;
    if (!slot) {
      // Victim: a voice already ringing out (oldest first, any priority), else a lower-priority one.
      const at = Math.max(now, r.time);
      let victim: VoiceSlot | null = null;
      let best = Number.POSITIVE_INFINITY;
      for (const s of this.slots) {
        const score = (s.tail <= at ? 0 : BODY_SCORE) + s.prio + s.tail * 1e-6;
        if (score < best) {
          best = score;
          victim = s;
        }
      }
      if (victim && victim.tail > at && victim.prio >= r.prio) victim = null;
      if (!victim) {
        this.dropped++;
        return false;
      }
      this.cut(victim, Math.max(now, r.time));
      // The victim fades on its own gain node (released with its source); the slot continues with a fresh one.
      const oldGain = victim.gain;
      const oldSrc = victim.src;
      if (oldSrc) {
        oldSrc.onended = () => {
          oldSrc.disconnect();
          oldGain.disconnect();
        };
      } else {
        oldGain.disconnect();
      }
      victim.src = null;
      victim.gain = this.ctx.createGain();
      victim.dest = null;
      slot = victim;
    }
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = r.sample.buffer;
    src.loop = r.sample.loop;
    const t = Math.max(r.time, now);
    const rate = Math.max(0.05, r.rate);
    src.playbackRate.setValueAtTime(rate, t);
    if (r.glide !== 1 && r.glideTime > 0) {
      src.playbackRate.exponentialRampToValueAtTime(Math.max(0.05, rate * r.glide), t + r.glideTime);
    }
    const g = slot.gain;
    if (slot.dest !== r.dest) {
      g.disconnect();
      g.connect(r.dest);
      slot.dest = r.dest;
    }
    const p = g.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(0, t);
    let end: number;
    if (r.sample.loop) {
      const hold = Math.max(0.02, r.gate);
      const attack = Math.min(r.attack, hold * 0.6);
      p.linearRampToValueAtTime(r.gain, t + Math.max(ONE_SHOT_ATTACK, attack));
      p.setValueAtTime(r.gain, t + hold);
      p.setTargetAtTime(0, t + hold, Math.max(0.005, r.release / 4));
      end = t + hold + r.release * 1.6;
      slot.tail = t + hold;
    } else {
      p.linearRampToValueAtTime(r.gain, t + ONE_SHOT_ATTACK);
      const minRate = r.glide < 1 ? rate * r.glide : rate;
      const natural = t + r.sample.buffer.duration / minRate;
      if (r.gate > 0 && t + r.gate < natural) {
        p.setValueAtTime(r.gain, t + r.gate);
        p.setTargetAtTime(0, t + r.gate, Math.max(0.003, r.release / 3));
        end = Math.min(natural, t + r.gate + r.release * 2.5);
      } else {
        end = natural;
      }
      slot.tail = Math.min(end, t + (r.gate > 0 ? Math.min(r.gate, ONE_SHOT_BODY) : ONE_SHOT_BODY));
    }
    src.connect(g);
    src.start(t);
    src.stop(end);
    src.onended = () => {
      src.disconnect();
      if (slot.src === src) slot.src = null;
    };
    slot.src = src;
    slot.end = end;
    slot.prio = r.prio;
    slot.mono = r.mono;
    return true;
  }

  /** Fade every voice out from `at` over `fade` s. */
  stopAll(at: number, fade: number): void {
    for (const s of this.slots) if (s.end > at) this.cut(s, at, fade);
  }

  private cut(s: VoiceSlot, at: number, fade = 0.012): void {
    const src = s.src;
    s.gain.gain.cancelScheduledValues(at);
    s.gain.gain.setTargetAtTime(0, at, Math.max(0.002, fade / 4));
    const end = at + fade * 1.5 + 0.01;
    if (src) {
      try {
        src.stop(end);
      } catch {
        // already stopped
      }
    }
    s.end = Math.min(s.end, end);
    s.tail = Math.min(s.tail, at);
    s.mono = null;
  }
}

// ---------------------------------------------------------------------------
// Theme player
// ---------------------------------------------------------------------------

export interface PlayerOutputs {
  readonly game: AudioNode;
  readonly menu: AudioNode;
}

/** What a player asks at each bar line. */
export interface PlayerPolicy {
  /** Intensity 0..1 of the coming bar. */
  intensity(): number;
  /** Layers the state allows (bit mask, see layerMask). */
  allowed(): number;
}

let variantCounter = 0;

/** Playback rate and sample of an event (null: slot not in the palette). */
export function voiceFor(set: SampleSet, note: number): { sample: Sample; rate: number } | null {
  if (set.samples.length === 0) return null;
  if (set.pitched) {
    const s = nearestSample(set, note);
    if (!s || !(s.hz > 0)) return null;
    return { sample: s, rate: midiHz(note) / s.hz };
  }
  const s = set.samples[variantCounter++ % set.samples.length]!;
  return { sample: s, rate: Math.pow(2, (note - NATURAL) / 12) };
}

export class ThemePlayer implements SequencerSink {
  private readonly layers: GainNode[] = [];
  private readonly lastTarget = new Float64Array(MUSIC_LAYERS.length);
  private readonly filter: BiquadFilterNode;
  private readonly dropGain: GainNode;
  private readonly fader: GainNode;
  private readonly routeGame: GainNode;
  private readonly routeMenu: GainNode;
  private readonly echoIn: GainNode;
  private readonly delayA: DelayNode;
  private readonly delayB: DelayNode;
  readonly pool: VoicePool;
  readonly mixer = new LayerMixer();
  private seq: Sequencer | null = null;
  private _samples: ThemeSamples | null = null;
  private barIntensity = 0;
  private stopAt = Number.POSITIVE_INFINITY;
  private _route: 'game' | 'menu' = 'game';
  private cutoff = OPEN_FILTER;
  /** Re-strike the held notes at the next bar (after the sequencer skipped bars of a stalled timer). */
  private retrigger = false;
  private readonly req: VoiceRequest;
  private readonly mixOf: readonly number[];

  constructor(
    private readonly ctx: BaseAudioContext,
    outs: PlayerOutputs,
    private readonly policy: PlayerPolicy,
    voices: number = V.perPlayer,
  ) {
    this.pool = new VoicePool(ctx, voices);
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = OPEN_FILTER;
    this.filter.Q.value = 0.5;
    this.dropGain = ctx.createGain();
    this.fader = ctx.createGain();
    this.fader.gain.value = 0;
    this.routeGame = ctx.createGain();
    this.routeMenu = ctx.createGain();
    this.routeMenu.gain.value = 0;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = MIX.highpass;
    hp.Q.value = 0.6;
    this.filter.connect(hp).connect(this.dropGain).connect(this.fader);
    this.fader.connect(this.routeGame).connect(outs.game);
    this.fader.connect(this.routeMenu).connect(outs.menu);

    // Ping-pong echo: in → damp → A (left) → B (right) → A …
    const E = MIX.echo;
    this.echoIn = ctx.createGain();
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = E.damp;
    this.delayA = ctx.createDelay(2);
    this.delayB = ctx.createDelay(2);
    const fbAB = ctx.createGain();
    const fbBA = ctx.createGain();
    fbAB.gain.value = E.feedback;
    fbBA.gain.value = E.feedback;
    const wet = ctx.createGain();
    wet.gain.value = E.wet;
    this.echoIn.connect(damp).connect(this.delayA);
    this.delayA.connect(fbAB).connect(this.delayB);
    this.delayB.connect(fbBA).connect(this.delayA);
    const stereo = ctx.destination.channelCount > 1;
    if (stereo) {
      const panA = ctx.createStereoPanner();
      panA.pan.value = -0.6;
      const panB = ctx.createStereoPanner();
      panB.pan.value = 0.6;
      this.delayA.connect(panA).connect(wet);
      this.delayB.connect(panB).connect(wet);
    } else {
      this.delayA.connect(wet);
      this.delayB.connect(wet);
    }
    wet.connect(this.filter);

    this.mixOf = MUSIC_LAYERS.map((l) => MIX.layers[l]);
    for (const layer of MUSIC_LAYERS) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.filter);
      const send = E.send[layer];
      if (send > 0) {
        const s = ctx.createGain();
        s.gain.value = send;
        g.connect(s).connect(this.echoIn);
      }
      this.layers.push(g);
    }
    this.req = {
      sample: null as unknown as Sample,
      rate: 1,
      time: 0,
      gate: 0,
      gain: 0,
      dest: this.filter,
      attack: 0,
      release: 0,
      prio: 0,
      mono: null,
      glide: 1,
      glideTime: 0,
    };
  }

  get theme(): ComposedTheme | null {
    return this.seq?.theme ?? null;
  }

  get themeId(): string | null {
    return this.seq?.theme.def.id ?? null;
  }

  get samples(): ThemeSamples | null {
    return this._samples;
  }

  get route(): 'game' | 'menu' {
    return this._route;
  }

  /** Started and not yet faded out completely. */
  get active(): boolean {
    return this.seq !== null;
  }

  get stopping(): boolean {
    return this.seq !== null && Number.isFinite(this.stopAt);
  }

  get bars(): number {
    return this.seq?.bars ?? 0;
  }

  get intensity(): number {
    return this.barIntensity;
  }

  /** Start `theme` at bar 0 at `at` (fade-in `fadeIn` s) on `route`. */
  start(
    theme: ComposedTheme,
    samples: ThemeSamples,
    at: number,
    route: 'game' | 'menu',
    fadeIn: number,
  ): void {
    this.seq = new Sequencer(theme);
    this.seq.start(at);
    this._samples = samples;
    this.stopAt = Number.POSITIVE_INFINITY;
    this.mixer.reset();
    this.lastTarget.fill(0);
    for (const g of this.layers) {
      g.gain.cancelScheduledValues(at);
      g.gain.setValueAtTime(0, at);
    }
    const beat = 60 / theme.def.tempo;
    const delay = MIX.echo.beats * beat;
    this.delayA.delayTime.setValueAtTime(delay, at);
    this.delayB.delayTime.setValueAtTime(delay, at);
    const f = this.fader.gain;
    f.cancelScheduledValues(at);
    f.setValueAtTime(0, at);
    f.linearRampToValueAtTime(1, at + Math.max(0.01, fadeIn));
    this.setRoute(route, at, 0);
  }

  /** Fade out from `at` over `fade` s; the voices are cut and the sequencer stops at the end. */
  stop(at: number, fade: number): void {
    if (!this.seq || this.stopping) return;
    const f = this.fader.gain;
    f.cancelScheduledValues(at);
    f.setTargetAtTime(0, at, Math.max(0.005, fade / 4));
    this.stopAt = at + fade;
    this.pool.stopAll(this.stopAt, 0.05);
  }

  /** Stop at once (music switched off, disposal). */
  halt(at: number): void {
    this.fader.gain.cancelScheduledValues(at);
    this.fader.gain.setTargetAtTime(0, at, 0.02);
    this.pool.stopAll(at, 0.08);
    this.finish();
  }

  /** Once per scheduler tick: completes a finished fade-out. */
  update(now: number): void {
    if (this.seq && now >= this.stopAt) this.finish();
  }

  setRoute(route: 'game' | 'menu', at: number, fade: number): void {
    this._route = route;
    const tau = Math.max(0.002, fade / 3);
    this.routeGame.gain.cancelScheduledValues(at);
    this.routeMenu.gain.cancelScheduledValues(at);
    if (fade <= 0) {
      this.routeGame.gain.setValueAtTime(route === 'game' ? 1 : 0, at);
      this.routeMenu.gain.setValueAtTime(route === 'menu' ? 1 : 0, at);
    } else {
      this.routeGame.gain.setTargetAtTime(route === 'game' ? 1 : 0, at, tau);
      this.routeMenu.gain.setTargetAtTime(route === 'menu' ? 1 : 0, at, tau);
    }
  }

  /** Low-pass over the whole theme (game over darkness, low-health danger); 0 = open. */
  setLowpass(hz: number, at: number, time: number): void {
    const target = hz > 0 ? Math.min(OPEN_FILTER, hz) : OPEN_FILTER;
    if (Math.abs(target - this.cutoff) < 1) return;
    this.cutoff = target;
    const p = this.filter.frequency;
    p.cancelScheduledValues(at);
    p.setTargetAtTime(target, at, Math.max(0.01, time / 3));
  }

  /** Music drop: every layer dips to `gain` from `at` for `dur` s (nuke sting). */
  drop(at: number, dur: number, gain: number): void {
    const p = this.dropGain.gain;
    p.cancelScheduledValues(at);
    p.setValueAtTime(1, at);
    p.linearRampToValueAtTime(gain, at + 0.03);
    p.setValueAtTime(gain, at + dur);
    p.linearRampToValueAtTime(1, at + dur + 0.25);
  }

  pump(now: number, horizon: number): number {
    if (!this.seq) return 0;
    return this.seq.pump(now, Math.min(horizon, this.stopAt), this);
  }

  nextGrid(t: number, unit: GridUnit): number {
    return this.seq ? this.seq.nextGrid(t, unit) : t;
  }

  /** Quarter-note length (s) of the playing theme. */
  get beatSeconds(): number {
    return this.seq ? 60 / this.seq.theme.def.tempo : 0.5;
  }

  // -------------------------------------------------------------------------
  // SequencerSink
  // -------------------------------------------------------------------------

  onBar(info: BarInfo): void {
    if (info.afterSkip) this.retrigger = true;
    const intensity = this.policy.intensity();
    const changed = this.mixer.evaluate(intensity, info.index, this.policy.allowed());
    this.barIntensity = intensity;
    const theme = this.seq!.theme;
    const beatDur = theme.stepDur * theme.def.beatSteps;
    const themeMix = theme.def.mix;
    for (let k = 0; k < this.layers.length; k++) {
      const layer = MUSIC_LAYERS[k] as MusicLayer;
      const target = this.mixer.share(k, intensity) * this.mixOf[k]! * (themeMix?.[layer] ?? 1);
      const last = this.lastTarget[k]!;
      if (Math.abs(target - last) < 0.01) continue;
      const beats = target > last ? MUSIC.layers.fadeInBeats : MUSIC.layers.fadeOutBeats;
      this.layers[k]!.gain.setTargetAtTime(target, info.time, Math.max(0.01, (beats * beatDur) / 3));
      this.lastTarget[k] = target;
    }
    const holds = info.bar.holds;
    for (let h = 0; h < holds.length; h++) {
      const ref = holds[h]!;
      const k = ref.event.layer;
      if (!this.retrigger && ((changed >> k) & 1) === 0) continue;
      const left = (ref.event.dur - ref.elapsed) * theme.stepDur;
      if (left > theme.stepDur) this.voice(ref.event, info.time, left);
    }
    this.retrigger = false;
  }

  onEvent(e: NoteEvent, time: number, duration: number): void {
    if (time >= this.stopAt) return;
    this.voice(e, time, duration);
  }

  private voice(e: NoteEvent, time: number, duration: number): void {
    if (!this.mixer.on[e.layer] || e.tier > this.barIntensity + 1e-6) return;
    const set = this._samples?.slots[e.slot];
    if (!set) return;
    const v = voiceFor(set, e.note);
    if (!v) return;
    const H = MIX.humanize;
    const drum = !set.pitched;
    const r = this.req;
    const env = slotEnvelope(e.slot);
    r.sample = v.sample;
    r.rate = v.rate;
    r.time = drum ? time : time + (Math.random() * 2 - 1) * H.time;
    r.gate = HELD_SLOTS.has(e.slot) || set.loop || GATED_ONE_SHOTS.has(e.slot) ? duration : 0;
    r.gain = Math.pow(e.vel, MIX.velocityCurve) * set.gain * (1 + (Math.random() * 2 - 1) * H.velocity);
    r.dest = this.layers[e.layer]!;
    r.attack = env.attack;
    r.release = env.release;
    r.prio = slotPriority(e.slot);
    r.mono = MONO_SLOTS.has(e.slot) ? e.slot : null;
    r.glide = 1;
    r.glideTime = 0;
    this.pool.play(r);
  }

  private finish(): void {
    // Voices scheduled during the fade-out ring on under the closed fader: cut them before reuse.
    this.pool.stopAll(this.ctx.currentTime, 0.05);
    this.seq?.stop();
    this.seq = null;
    this._samples = null;
    this.stopAt = Number.POSITIVE_INFINITY;
    this.mixer.reset();
    this.lastTarget.fill(0);
    const now = this.ctx.currentTime;
    for (const g of this.layers) {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(0, now);
    }
  }
}

// ---------------------------------------------------------------------------
// Stings
// ---------------------------------------------------------------------------

export type StingOutputs = Readonly<Record<MusicRoute, AudioNode>>;

export class StingPlayer {
  readonly pool: VoicePool;
  private readonly buses: Record<MusicRoute, GainNode>;
  private readonly req: VoiceRequest;

  constructor(ctx: BaseAudioContext, outs: StingOutputs, voices: number = V.stings) {
    this.pool = new VoicePool(ctx, voices);
    const bus = (route: MusicRoute): GainNode => {
      const g = ctx.createGain();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = MIX.highpass;
      hp.Q.value = 0.6;
      g.connect(hp).connect(outs[route]);
      return g;
    };
    this.buses = { game: bus('game'), menu: bus('menu'), ui: bus('ui') };
    this.req = {
      sample: null as unknown as Sample,
      rate: 1,
      time: 0,
      gate: 0,
      gain: 0,
      dest: this.buses.game,
      attack: 0,
      release: 0,
      prio: 6,
      mono: null,
      glide: 1,
      glideTime: 0,
    };
  }

  /** Play resolved sting notes with `samples` on `route`; returns the end time of the last note. */
  play(notes: readonly ResolvedStingNote[], samples: ThemeSamples, route: MusicRoute, gain: number): number {
    let end = 0;
    const r = this.req;
    for (const n of notes) {
      const set = samples.slots[n.slot];
      if (!set) continue;
      const v = voiceFor(set, n.note);
      if (!v) continue;
      const env = slotEnvelope(n.slot);
      r.sample = v.sample;
      r.rate = v.rate;
      r.time = n.time;
      r.gate = set.loop ? n.dur : 0;
      r.gain = Math.pow(n.vel, MIX.velocityCurve) * set.gain * gain * MIX.stings;
      r.dest = this.buses[route];
      r.attack = Math.min(env.attack, 0.08);
      r.release = env.release;
      r.glide = n.glide;
      r.glideTime = n.glideTime;
      if (this.pool.play(r)) {
        const len = set.loop
          ? n.dur + env.release * 1.6
          : v.sample.buffer.duration / Math.max(0.05, v.rate * Math.min(1, n.glide));
        end = Math.max(end, n.time + len);
      }
    }
    return end;
  }

  stopAll(at: number, fade: number): void {
    this.pool.stopAll(at, fade);
  }
}
