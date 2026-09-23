import { describe, expect, it } from 'vitest';
import type { PlayOptions } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { Rng } from '../core/Rng';
import { AUDIO } from '../defs/audio';
import { MOVEMENT } from '../defs/movement';
import { createDefaultSettings } from '../save/settingsSchema';
import { AudioEngine, type LoopOptions } from './AudioEngine';
import { AudioEventBridge, type AudioBridgeTarget } from './AudioEventBridge';
import {
  audibleLength,
  fadeOutTail,
  fillBrown,
  fillPink,
  fillWhite,
  makeLoopable,
  normalizeChannels,
  normalizeRms,
  peakOf,
  pickStealIndex,
  pickVariant,
  remapClamped,
  rmsOf,
} from './dsp';
import { generateImpulseResponse, impulseLength } from './reverb';
import { SYNTH_DEFS, SYNTH_IDS, SynthBank, noiseCompensation, resolveSynthId } from './synth';

const ORIGIN = { x: 0, y: 0, z: 0 };

describe('dsp helpers', () => {
  it('generates bounded, zero-mean noise deterministically', () => {
    for (const fill of [fillWhite, fillPink, fillBrown]) {
      const a = fill(new Float32Array(20000), new Rng('n'));
      const b = fill(new Float32Array(20000), new Rng('n'));
      expect(a).toEqual(b);
      expect(peakOf(a)).toBeLessThanOrEqual(1.0001);
      let mean = 0;
      for (const v of a) mean += v;
      expect(Math.abs(mean / a.length)).toBeLessThan(0.2);
    }
  });

  it('normalizes peak and RMS', () => {
    const d = new Float32Array([0.1, -0.5, 0.25]);
    normalizeChannels([d], 0.8);
    expect(peakOf(d)).toBeCloseTo(0.8, 5);
    const n = normalizeRms(fillWhite(new Float32Array(1000), new Rng('r')), 0.3);
    expect(rmsOf(n)).toBeCloseTo(0.3, 5);
    expect(normalizeRms(new Float32Array(4), 1)).toEqual(new Float32Array(4));
  });

  it('finds the audible length and fades the tail', () => {
    const d = new Float32Array([0.5, 0.2, 0.01, 0.0001, 0]);
    expect(audibleLength([d], 0.001)).toBe(3);
    expect(audibleLength([new Float32Array(3)], 0.001)).toBe(1);
    const f = new Float32Array([1, 1, 1, 1]);
    fadeOutTail([f], 2);
    expect([...f]).toEqual([1, 1, 0.5, 0]);
  });

  it('makes seamless loops', () => {
    const src = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i * 0.05));
    const [loop] = makeLoopable([src], 200);
    expect(loop?.length).toBe(800);
    // The loop point continues the original signal: last sample → first sample ≈ one step.
    const step = Math.abs((src[801] as number) - (src[800] as number));
    expect(Math.abs((loop?.[0] ?? 0) - (loop?.[799] ?? 0))).toBeLessThan(step * 3 + 1e-3);
  });

  it('picks variants without immediate repeats', () => {
    expect(pickVariant(1, 0, 0.9)).toBe(0);
    for (let last = 0; last < 4; last++) {
      for (let r = 0; r < 1; r += 0.05) {
        const v = pickVariant(4, last, r);
        expect(v).not.toBe(last);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(4);
      }
    }
    expect(pickVariant(3, -1, 0.999)).toBe(2);
  });

  it('steals one-shots first, then the quietest, then the oldest', () => {
    expect(pickStealIndex([], 0.01)).toBe(-1);
    const voices = [
      { volume: 0.2, startTime: 5, loop: true },
      { volume: 0.5, startTime: 1, loop: false },
      { volume: 0.3, startTime: 3, loop: false },
      { volume: 0.305, startTime: 2, loop: false },
    ];
    expect(pickStealIndex(voices, 0.01)).toBe(3);
    expect(pickStealIndex([{ volume: 1, startTime: 0, loop: true }], 0.01)).toBe(0);
  });

  it('remaps with clamping', () => {
    expect(remapClamped(5, 0, 10, 0.5, 1)).toBeCloseTo(0.75);
    expect(remapClamped(-5, 0, 10, 0.5, 1)).toBe(0.5);
    expect(remapClamped(50, 0, 10, 0.5, 1)).toBe(1);
  });
});

describe('reverb impulse responses', () => {
  it('has pre-delay silence, an exponential tail and decorrelated channels', () => {
    const sr = 8000;
    const zone = AUDIO.reverbZones.large;
    const [l, r] = generateImpulseResponse(zone, sr, 'test');
    expect(l.length).toBe(impulseLength(zone, sr));
    const pre = Math.round(zone.preDelay * sr);
    for (let i = 0; i < pre; i++) expect(l[i]).toBe(0);
    const early = rmsOf(l.subarray(pre, pre + sr * 0.2));
    const late = rmsOf(l.subarray(l.length - sr * 0.2));
    expect(late).toBeLessThan(early * 0.05);
    let corr = 0;
    let el = 0;
    let er = 0;
    for (let i = 0; i < l.length; i++) {
      corr += (l[i] as number) * (r[i] as number);
      el += (l[i] as number) ** 2;
      er += (r[i] as number) ** 2;
    }
    expect(Math.abs(corr / Math.sqrt(el * er))).toBeLessThan(0.2);
  });

  it('is deterministic and scales with the zone size', () => {
    const a = generateImpulseResponse(AUDIO.reverbZones.small, 8000, 'z');
    const b = generateImpulseResponse(AUDIO.reverbZones.small, 8000, 'z');
    expect(a[0]).toEqual(b[0]);
    expect(impulseLength(AUDIO.reverbZones.hangar, 8000)).toBeGreaterThan(
      impulseLength(AUDIO.reverbZones.small, 8000),
    );
  });
});

describe('synth definitions', () => {
  const REQUIRED = [
    'footstep.metal',
    'footstep.concrete',
    'footstep.grate',
    'footstep.rubber',
    'footstep.default',
    'jump',
    'jump.double',
    'land',
    'land.heavy',
    'slide',
    'dash',
    'mantle',
    'ui.click',
    'ui.hover',
    'ui.back',
    'hurt',
  ];

  it('defines every required sound', () => {
    for (const id of REQUIRED) expect(SYNTH_IDS).toContain(id);
  });

  it('has sane parameters', () => {
    for (const id of SYNTH_IDS) {
      const d = SYNTH_DEFS[id];
      expect(d.variants).toBeGreaterThanOrEqual(1);
      expect(d.duration).toBeGreaterThan(0);
      expect(d.level).toBeGreaterThan(0);
      expect(d.level).toBeLessThanOrEqual(1);
      if (id.startsWith('footstep.')) {
        expect(d.variants).toBeGreaterThanOrEqual(3);
        expect(d.variants).toBeLessThanOrEqual(4);
      }
    }
    expect(SYNTH_DEFS.slide).toMatchObject({ loop: true });
  });

  it('covers every footstep sound the bridge can request', () => {
    for (const id of Object.values(AUDIO.bridge.surfaceFootsteps)) expect(resolveSynthId(id)).toBe(id);
  });

  it('resolves unknown surfaces to the default footstep', () => {
    expect(resolveSynthId('footstep.glass')).toBe('footstep.default');
    expect(resolveSynthId('jump')).toBe('jump');
    expect(resolveSynthId('laser')).toBeNull();
  });

  it('compensates filtered noise for the removed bandwidth', () => {
    const ny = 24000;
    const narrow = noiseCompensation('white', 'bandpass', 1000, 4, ny);
    const wide = noiseCompensation('white', 'bandpass', 1000, 0.5, ny);
    expect(narrow).toBeGreaterThan(wide);
    expect(noiseCompensation('white', 'allpass', 1000, 1, ny)).toBe(1);
    expect(noiseCompensation('brown', 'lowpass', 200, 1, ny)).toBe(1);
    for (const c of ['white', 'pink'] as const) {
      for (const f of ['lowpass', 'highpass', 'bandpass'] as const) {
        const k = noiseCompensation(c, f, 1500, 1, ny);
        expect(k).toBeGreaterThanOrEqual(1);
        expect(k).toBeLessThanOrEqual(6);
      }
    }
  });

  it('degrades gracefully without OfflineAudioContext (Node)', async () => {
    const bank = new SynthBank(48000);
    expect(bank.has('jump')).toBe(true);
    expect(bank.isLoop('slide')).toBe(true);
    expect(bank.get('jump')).toBeNull();
    expect(await bank.render('jump')).toBeNull();
    await expect(bank.renderAll()).resolves.toBeUndefined();
  });
});

class FakeAudio implements AudioBridgeTarget {
  readonly plays: { id: string; opts: PlayOptions }[] = [];
  readonly loops: { id: string; opts: LoopOptions; handle: number }[] = [];
  readonly stopped: { handle: number; fade: number | undefined }[] = [];
  private next = 1;
  play(id: string, opts?: PlayOptions): void {
    this.plays.push({ id, opts: { ...opts } });
  }
  startLoop(id: string, opts?: LoopOptions): number {
    const handle = this.next++;
    this.loops.push({ id, opts: { ...opts }, handle });
    return handle;
  }
  stopLoop(handle: number, fade?: number): void {
    this.stopped.push({ handle, fade });
  }
}

describe('AudioEventBridge', () => {
  function setup() {
    const events = new EventBus<GameEvents>();
    const audio = new FakeAudio();
    const bridge = new AudioEventBridge(events, audio);
    return { events, audio, bridge };
  }

  it('plays surface footsteps with gait-dependent gain', () => {
    const { events, audio } = setup();
    const base = { position: ORIGIN, speed: 6 };
    events.emit('player:footstep', { ...base, sprinting: false, crouched: false, surface: 'metal' });
    events.emit('player:footstep', { ...base, sprinting: true, crouched: false, surface: 'grate' });
    events.emit('player:footstep', { ...base, sprinting: false, crouched: true, surface: 'glass' });
    expect(audio.plays.map((p) => p.id)).toEqual(['footstep.metal', 'footstep.grate', 'footstep.default']);
    expect(audio.plays.map((p) => p.opts.volume)).toEqual([
      AUDIO.movement.footstepGain,
      AUDIO.movement.footstepSprintGain,
      AUDIO.movement.footstepCrouchGain,
    ]);
    expect(audio.plays.every((p) => p.opts.position === undefined && p.opts.bus === 'sfx')).toBe(true);
  });

  it('maps jumps, dashes, mantles and damage', () => {
    const { events, audio } = setup();
    events.emit('player:jump', { double: false, position: ORIGIN });
    events.emit('player:jump', { double: true, position: ORIGIN });
    events.emit('player:dash', { direction: ORIGIN, chargesLeft: 1, position: ORIGIN });
    events.emit('player:mantle', { height: 1, position: ORIGIN });
    events.emit('player:damaged', { amount: 1, healthFraction: 0.9 });
    events.emit('player:damaged', { amount: 500, healthFraction: 0 });
    expect(audio.plays.map((p) => p.id)).toEqual(['jump', 'jump.double', 'dash', 'mantle', 'hurt', 'hurt']);
    const hurts = audio.plays.filter((p) => p.id === 'hurt').map((p) => p.opts.volume ?? 0);
    expect(hurts[0]).toBeLessThan(hurts[1] as number);
    expect(hurts[1]).toBeCloseTo(AUDIO.bridge.hurtGain);
  });

  it('layers the surface under landings and scales with impact speed', () => {
    const { events, audio } = setup();
    events.emit('player:land', {
      impactSpeed: MOVEMENT.landing.minImpactSpeed,
      heavy: false,
      position: ORIGIN,
      surface: 'concrete',
    });
    events.emit('player:land', { impactSpeed: 40, heavy: true, position: ORIGIN, surface: 'metal' });
    expect(audio.plays.map((p) => p.id)).toEqual([
      'land',
      'footstep.concrete',
      'land.heavy',
      'footstep.metal',
    ]);
    expect(audio.plays[0]?.opts.volume).toBeCloseTo(AUDIO.movement.landGain * AUDIO.bridge.landMinImpactGain);
    expect(audio.plays[2]?.opts.volume).toBeCloseTo(AUDIO.movement.landGain);
  });

  it('starts and stops the slide loop exactly once', () => {
    const { events, audio, bridge } = setup();
    events.emit('player:slideStart', { speed: MOVEMENT.slide.maxSpeed, position: ORIGIN });
    expect(audio.loops).toHaveLength(1);
    expect(audio.loops[0]?.opts).toMatchObject({
      volume: AUDIO.movement.slideGain,
      maxDuration: AUDIO.bridge.slideMaxSeconds,
    });
    events.emit('player:slideEnd', {});
    events.emit('player:stateChanged', { from: 'slide', to: 'ground' });
    expect(audio.stopped).toEqual([{ handle: 1, fade: AUDIO.bridge.slideFadeOut }]);

    events.emit('player:slideStart', { speed: 8, position: ORIGIN });
    events.emit('player:slideStart', { speed: 8, position: ORIGIN });
    expect(audio.stopped.map((s) => s.handle)).toEqual([1, 2]);
    bridge.dispose();
    expect(audio.stopped.map((s) => s.handle)).toEqual([1, 2, 3]);
    events.emit('player:jump', { double: false, position: ORIGIN });
    expect(audio.plays).toHaveLength(0);
  });

  it('clicks when the console opens and closes', () => {
    const { events, audio } = setup();
    events.emit('ui:console', { open: true });
    events.emit('ui:console', { open: false });
    expect(audio.plays.map((p) => [p.id, p.opts.bus])).toEqual([
      ['ui.click', 'ui'],
      ['ui.back', 'ui'],
    ]);
  });

  it('clicks on menus, except when the start screen closes into gameplay', () => {
    const { events, audio } = setup();
    events.emit('ui:menu', { open: true, menu: 'start' });
    events.emit('ui:menu', { open: false, menu: 'start' });
    events.emit('ui:menu', { open: true, menu: 'pause' });
    events.emit('ui:menu', { open: false, menu: 'pause' });
    expect(audio.plays.map((p) => [p.id, p.opts.bus])).toEqual([
      ['ui.click', 'ui'],
      ['ui.click', 'ui'],
      ['ui.back', 'ui'],
    ]);
  });
});

describe('AudioEngine without Web Audio (Node)', () => {
  it('stays silent and never throws', async () => {
    const events = new EventBus<GameEvents>();
    const engine = new AudioEngine(events, createDefaultSettings().audio);
    expect(engine.ready).toBe(false);
    expect(engine.context).toBeNull();
    await expect(engine.unlock()).resolves.toBeUndefined();
    engine.play('jump');
    expect(engine.startLoop('slide')).toBe(0);
    engine.stopLoop(1);
    engine.setListener(ORIGIN, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
    engine.setReverbZone('hangar');
    engine.setPaused(true);
    engine.setPaused(false);
    engine.applySettings({ ...createDefaultSettings().audio, master: 0.2 });
    expect(engine.has('footstep.metal')).toBe(true);
    expect(engine.has('laser')).toBe(false);
    expect(engine.stats).toEqual({ activeVoices: 0, contextState: 'locked' });
    expect(events.listenerCount('settings:changed')).toBe(1);
    engine.dispose();
    expect(events.listenerCount('settings:changed')).toBe(0);
  });
});
