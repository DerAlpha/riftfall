import { describe, expect, it } from 'vitest';
import type { PlayOptions } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, HitZone } from '../core/events';
import { Rng } from '../core/Rng';
import { AUDIO } from '../defs/audio';
import { CASINGS } from '../defs/vfx';
import { WEAPONS, WEAPON_IDS } from '../defs/weapons';
import type { LoopOptions } from './AudioEngine';
import {
  AudioEventBridge,
  TokenBucket,
  fireLayerGain,
  fireSoundLayers,
  hitSoundId,
  impactSoundId,
  lowAmmoThreshold,
  reloadStepSoundId,
  weaponSoundId,
  type AudioBridgeTarget,
} from './AudioEventBridge';
import { SYNTH_DEFS, SYNTH_IDS, resolveSynthId, type SynthGraph } from './synth';
import { WEAPON_SYNTH_ALIASES, WEAPON_SYNTH_DEFS, weaponSynthAlias } from './weaponSynth';

const W = AUDIO.weapons;

// ---------------------------------------------------------------------------
// Id coverage
// ---------------------------------------------------------------------------

describe('weapon sound ids', () => {
  it('registers every sound the milestone needs', () => {
    const required: string[] = [
      'weapon.melee',
      'casing.brass',
      'casing.shell',
      'ui.hitmarker',
      'ui.headshot',
      'ui.kill',
    ];
    for (const s of ['metal', 'concrete', 'grate', 'glass', 'flesh', 'slime', 'shield'])
      required.push(`impact.${s}`);
    for (const w of ['pistol', 'rifle', 'shotgun']) {
      for (const k of ['fire', 'dry', 'magOut', 'magIn', 'boltRelease', 'shellIn', 'pump', 'equip'])
        required.push(`weapon.${w}.${k}`);
    }
    for (const id of required) expect(resolveSynthId(id), id).not.toBeNull();
    // The actions the weapons really have are dedicated recipes, not aliases.
    for (const id of ['weapon.pistol.boltRelease', 'weapon.rifle.magIn', 'weapon.shotgun.pump'])
      expect(Object.prototype.hasOwnProperty.call(WEAPON_SYNTH_DEFS, id), id).toBe(true);
  });

  it('resolves every id the weapon defs reference', () => {
    for (const id of WEAPON_IDS) {
      const a = WEAPONS[id].audio;
      const ids: string[] = [...a.fire, a.dry, a.equip, a.holster, a.reloadStart, a.melee, a.inspect];
      for (const s of Object.values(a.steps)) if (s) ids.push(s);
      for (const s of ids) expect(resolveSynthId(s), `${id}: ${s}`).not.toBeNull();
    }
  });

  it('resolves casing clinks, impact surfaces and bridge ids', () => {
    for (const c of Object.values(CASINGS)) expect(resolveSynthId(c.clinkSound), c.clinkSound).not.toBeNull();
    for (const s of Object.values(W.impactSounds)) expect(resolveSynthId(s), s).not.toBeNull();
    for (const s of Object.values(W.hitSounds)) expect(resolveSynthId(s), s).not.toBeNull();
    expect(resolveSynthId(W.lowAmmo.id)).not.toBeNull();
    expect(resolveSynthId(W.meleeHitId)).not.toBeNull();
    for (const layers of Object.values(W.extraFireLayers))
      for (const s of layers) expect(resolveSynthId(s)).not.toBeNull();
  });

  it('keeps aliases pointing at real defs without shadowing them', () => {
    for (const [alias, target] of Object.entries(WEAPON_SYNTH_ALIASES)) {
      expect(Object.prototype.hasOwnProperty.call(WEAPON_SYNTH_DEFS, alias)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(WEAPON_SYNTH_DEFS, target)).toBe(true);
      expect(resolveSynthId(alias)).toBe(target);
    }
    expect(weaponSynthAlias('weapon.nope')).toBeNull();
  });

  it('merges into the procedural bank after the movement sounds', () => {
    for (const id of Object.keys(WEAPON_SYNTH_DEFS)) expect(SYNTH_IDS).toContain(id);
    expect(SYNTH_IDS.indexOf('footstep.metal')).toBeLessThan(SYNTH_IDS.indexOf('weapon.pistol.fire'));
    expect(SYNTH_DEFS['weapon.rifle.fire'].variants).toBeGreaterThanOrEqual(4);
    // Gunshots are stereo (2D, wide); impacts are mono (HRTF panner input).
    expect(SYNTH_DEFS['weapon.shotgun.fire'].channels).toBe(2);
    expect(SYNTH_DEFS['impact.metal'].channels).toBe(1);
    expect(SYNTH_DEFS['casing.brass'].channels).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Recipes against a validating fake OfflineAudioContext
// ---------------------------------------------------------------------------

class FakeParam {
  value = 0;
  constructor(private readonly log: string[]) {}
  private check(v: number, t: number, what: string): void {
    if (!Number.isFinite(v) || !Number.isFinite(t) || t < 0) this.log.push(`${what}(${v}, ${t})`);
  }
  setValueAtTime(v: number, t: number): this {
    this.check(v, t, 'setValueAtTime');
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.check(v, t, 'linearRamp');
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    // Web Audio throws for non-positive targets.
    if (!(v > 0)) this.log.push(`exponentialRamp to ${v}`);
    this.check(v, t, 'exponentialRamp');
    return this;
  }
  setTargetAtTime(v: number, t: number, c: number): this {
    if (!(c > 0)) this.log.push(`setTargetAtTime constant ${c}`);
    this.check(v, t, 'setTarget');
    return this;
  }
}

class FakeNode {
  constructor(protected readonly log: string[]) {}
  connect<T>(n: T): T {
    if (!n) this.log.push('connect(undefined)');
    return n;
  }
}

class FakeSource extends FakeNode {
  starts: number[];
  constructor(log: string[], starts: number[]) {
    super(log);
    this.starts = starts;
  }
  start(t: number): void {
    if (!Number.isFinite(t) || t < 0) this.log.push(`start(${t})`);
    this.starts.push(t);
  }
  stop(t: number): void {
    if (!Number.isFinite(t)) this.log.push(`stop(${t})`);
  }
}

class FakeOfflineContext {
  readonly sampleRate = 48000;
  readonly errors: string[] = [];
  readonly starts: number[] = [];
  readonly destination = Object.assign(new FakeNode(this.errors), { channelCount: 2 });
  createGain() {
    return Object.assign(new FakeNode(this.errors), { gain: new FakeParam(this.errors) });
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(this.errors), {
      type: 'lowpass',
      frequency: new FakeParam(this.errors),
      Q: new FakeParam(this.errors),
    });
  }
  createOscillator() {
    return Object.assign(new FakeSource(this.errors, this.starts), {
      type: 'sine',
      frequency: new FakeParam(this.errors),
    });
  }
  createBufferSource() {
    return Object.assign(new FakeSource(this.errors, this.starts), {
      buffer: null as unknown,
      loop: false,
      playbackRate: new FakeParam(this.errors),
    });
  }
  createWaveShaper() {
    return Object.assign(new FakeNode(this.errors), { curve: null as unknown, oversample: 'none' });
  }
  createStereoPanner() {
    return Object.assign(new FakeNode(this.errors), { pan: new FakeParam(this.errors) });
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { length, duration: length / rate, copyToChannel: () => undefined };
  }
}

describe('weapon synth recipes', () => {
  it('schedule valid Web Audio graphs that start inside the rendered duration', () => {
    for (const [id, def] of Object.entries(WEAPON_SYNTH_DEFS)) {
      const ctx = new FakeOfflineContext();
      const graph = { ctx, rng: new Rng(`test:${id}`) } as unknown as SynthGraph;
      def.recipe(graph, 0);
      expect(ctx.errors, id).toEqual([]);
      expect(ctx.starts.length, id).toBeGreaterThan(0);
      for (const t of ctx.starts) expect(t, id).toBeLessThan(def.duration);
    }
  });
});

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

describe('weapon sound mapping', () => {
  it('uses the weapon def fire layers, a convention id for unknown weapons', () => {
    expect(fireSoundLayers('rifle')).toBe(WEAPONS.rifle.audio.fire);
    const f = fireSoundLayers('railgun');
    expect(f).toEqual(['weapon.railgun.fire']);
    expect(fireSoundLayers('railgun')).toBe(f); // cached, no allocation per shot
    expect(fireLayerGain(0)).toBe(W.fireLayerGains[0]);
    expect(fireLayerGain(99)).toBe(W.fireLayerGains[W.fireLayerGains.length - 1]);
  });

  it('prefers the per-weapon id when the engine knows it, else the def id', () => {
    const knows = (id: string): boolean => resolveSynthId(id) !== null;
    expect(weaponSoundId('pistol', 'dry', knows)).toBe('weapon.pistol.dry');
    expect(weaponSoundId('pistol', 'dry')).toBe(WEAPONS.pistol.audio.dry);
    expect(weaponSoundId('pistol', 'holster', knows)).toBe(WEAPONS.pistol.audio.holster);
    expect(weaponSoundId('railgun', 'equip')).toBe('weapon.railgun.equip');
    expect(reloadStepSoundId('pistol', 'boltRelease', knows)).toBe('weapon.pistol.boltRelease');
    expect(reloadStepSoundId('pistol', 'boltRelease')).toBe(WEAPONS.pistol.audio.steps.boltRelease);
    expect(reloadStepSoundId('shotgun', 'shellIn', knows)).toBe('weapon.shotgun.shellIn');
  });

  it('maps surfaces, zones and magazine sizes', () => {
    expect(impactSoundId('armor')).toBe('impact.metal');
    expect(impactSoundId('shield')).toBe('impact.shield');
    expect(impactSoundId('rubber')).toBe('impact.rubber');
    const z = (zone: HitZone, killed = false): string => hitSoundId(zone, killed);
    expect(z('body')).toBe('ui.hitmarker');
    expect(z('head')).toBe('ui.headshot');
    expect(z('weakpoint')).toBe('ui.headshot');
    expect(z('limb', true)).toBe('ui.kill');
    expect(lowAmmoThreshold(12)).toBe(3);
    expect(lowAmmoThreshold(32)).toBe(W.lowAmmo.maxRounds);
    expect(lowAmmoThreshold(8)).toBe(2);
    expect(lowAmmoThreshold(1)).toBe(0);
  });

  it('rate-limits with a token bucket', () => {
    const b = new TokenBucket(3, 10);
    expect([b.take(0), b.take(0), b.take(0), b.take(0)]).toEqual([true, true, true, false]);
    expect(b.take(0.05)).toBe(false);
    expect(b.take(0.11)).toBe(true);
    expect(b.take(10)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

class FakeAudio implements AudioBridgeTarget {
  readonly plays: { id: string; opts: PlayOptions }[] = [];
  play(id: string, opts?: PlayOptions): void {
    this.plays.push({ id, opts: { ...opts, position: opts?.position ? { ...opts.position } : undefined } });
  }
  startLoop(_id: string, _opts?: LoopOptions): number {
    return 1;
  }
  stopLoop(): void {}
  has(id: string): boolean {
    return resolveSynthId(id) !== null;
  }
  ids(): string[] {
    return this.plays.map((p) => p.id);
  }
}

function setup() {
  const events = new EventBus<GameEvents>();
  const audio = new FakeAudio();
  let now = 100;
  let rnd = 0.5;
  const bridge = new AudioEventBridge(
    events,
    audio,
    () => now,
    () => rnd,
  );
  return {
    events,
    audio,
    bridge,
    advance: (s: number) => {
      now += s;
    },
    setRandom: (r: number) => {
      rnd = r;
    },
  };
}

const O = { x: 0, y: 0, z: 0 };

function fired(events: EventBus<GameEvents>, weaponId: string, ammoInMag: number): void {
  events.emit('weapon:fired', {
    weaponId,
    origin: O,
    direction: { x: 0, y: 0, z: -1 },
    muzzle: O,
    shotIndex: 0,
    ammoInMag,
    ads: false,
  });
}

describe('AudioEventBridge – weapons', () => {
  it('plays the layered gunshot in 2D with one slight random detune shared by all layers', () => {
    const { events, audio, setRandom } = setup();
    setRandom(1);
    fired(events, 'rifle', 20);
    expect(audio.ids()).toEqual([...WEAPONS.rifle.audio.fire]);
    for (const p of audio.plays) {
      expect(p.opts.position).toBeUndefined();
      // The bridge detunes the whole shot; the engine must not detune each layer on its own.
      expect(p.opts.pitchVariance).toBe(0);
      expect(p.opts.pitch).toBeCloseTo(1 + W.firePitchVariance);
      expect(p.opts.bus).toBe('sfx');
    }
    expect(audio.plays[0]!.opts.volume).toBeCloseTo(W.fireGain * fireLayerGain(0));
    expect(audio.plays[2]!.opts.volume).toBeCloseTo(W.fireGain * fireLayerGain(2));
    audio.plays.length = 0;
    setRandom(0);
    fired(events, 'rifle', 19);
    for (const p of audio.plays) expect(p.opts.pitch).toBeCloseTo(1 - W.firePitchVariance);
  });

  it('adds the shotgun pump cycle and a rising last-rounds tick', () => {
    const { events, audio } = setup();
    fired(events, 'shotgun', 5);
    expect(audio.ids()).toContain('weapon.shotgun.pumpCycle');
    expect(audio.ids()).not.toContain(W.lowAmmo.id);
    audio.plays.length = 0;
    fired(events, 'pistol', 3);
    fired(events, 'pistol', 0);
    const ticks = audio.plays.filter((p) => p.id === W.lowAmmo.id);
    expect(ticks.length).toBe(2);
    expect(ticks[1]!.opts.pitch!).toBeGreaterThan(ticks[0]!.opts.pitch!);
    expect(ticks[1]!.opts.pitch).toBeCloseTo(1 + W.lowAmmo.pitchRise);
    // An upgraded magazine (weapon:ammoChanged) moves the threshold.
    audio.plays.length = 0;
    events.emit('weapon:ammoChanged', { weaponId: 'pistol', mag: 5, reserve: 50, magSize: 24 });
    fired(events, 'pistol', 5);
    expect(audio.ids()).toContain(W.lowAmmo.id);
  });

  it('plays reload steps, dry fire, equip, holster, inspect and melee sounds', () => {
    const { events, audio } = setup();
    events.emit('weapon:reloadStart', { weaponId: 'pistol', empty: true, duration: 1.6 });
    events.emit('weapon:reloadStep', { weaponId: 'pistol', step: 'magOut' });
    events.emit('weapon:reloadStep', { weaponId: 'pistol', step: 'boltRelease' });
    events.emit('weapon:reloadStep', { weaponId: 'shotgun', step: 'shellIn' });
    events.emit('weapon:dryFire', { weaponId: 'shotgun' });
    events.emit('weapon:equipStart', { weaponId: 'rifle', slot: 1, duration: 0.5, previous: null });
    events.emit('weapon:holsterStart', { weaponId: 'rifle', slot: 1, duration: 0.3, next: 'pistol' });
    events.emit('weapon:inspect', { weaponId: 'rifle', duration: 2 });
    events.emit('weapon:melee', { weaponId: 'rifle', duration: 0.5, hit: false });
    expect(audio.ids()).toEqual([
      WEAPONS.pistol.audio.reloadStart,
      'weapon.pistol.magOut',
      'weapon.pistol.boltRelease',
      'weapon.shotgun.shellIn',
      'weapon.shotgun.dry',
      'weapon.rifle.equip',
      WEAPONS.rifle.audio.holster,
      WEAPONS.rifle.audio.inspect,
      WEAPONS.rifle.audio.melee,
    ]);
    for (const p of audio.plays) expect(p.opts.position).toBeUndefined();
  });

  it('plays positional impacts per surface, quieter for pellets, rate limited', () => {
    const { events, audio, advance } = setup();
    const impact = (
      surface: 'metal' | 'flesh' | 'concrete',
      kind: 'bullet' | 'pellet' | 'melee' | 'explosion',
    ): void =>
      events.emit('combat:impact', {
        point: { x: 1, y: 2, z: 3 },
        normal: { x: 0, y: 1, z: 0 },
        surface,
        kind,
        weaponId: 'rifle',
        decal: true,
      });
    impact('metal', 'bullet');
    expect(audio.plays[0]!.id).toBe('impact.metal');
    expect(audio.plays[0]!.opts.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(audio.plays[0]!.opts.volume).toBeCloseTo(W.impactGain);
    impact('flesh', 'pellet');
    expect(audio.plays[1]!.opts.volume).toBeCloseTo(W.impactGain * W.impactKindGain.pellet);
    // Explosions have their own sounds.
    impact('concrete', 'explosion');
    expect(audio.plays.length).toBe(2);
    // A shotgun blast: only the bucket's burst plays.
    audio.plays.length = 0;
    advance(10);
    for (let i = 0; i < 9; i++) impact('concrete', 'pellet');
    expect(audio.plays.length).toBe(W.impactBurst);
    // Melee adds the 2D blow.
    advance(10);
    audio.plays.length = 0;
    impact('flesh', 'melee');
    expect(audio.ids()).toEqual(['impact.flesh', W.meleeHitId]);
    expect(audio.plays[1]!.opts.position).toBeUndefined();
  });

  it('gives the player dry UI-bus hit feedback: tick, ding, kill punch', () => {
    const { events, audio, advance } = setup();
    const dmg = (zone: HitZone, source: 'player' | 'enemy' = 'player', killed = false): void =>
      events.emit('combat:damage', {
        targetId: 1,
        amount: 20,
        zone,
        point: O,
        killed,
        weaponId: 'pistol',
        element: 'physical',
        source,
      });
    dmg('body', 'enemy');
    expect(audio.plays.length).toBe(0);
    dmg('body');
    advance(0.1);
    dmg('head');
    advance(0.1);
    dmg('shield');
    advance(0.1);
    dmg('limb', 'player', true); // the kill event plays the kill sound
    expect(audio.ids()).toEqual(['ui.hitmarker', 'ui.headshot', 'ui.hitmarker']);
    for (const p of audio.plays) expect(p.opts.bus).toBe('ui');
    expect(audio.plays[2]!.opts.pitch).toBe(W.shieldHitPitch);
    // Hits closer together than the minimum interval merge.
    audio.plays.length = 0;
    advance(0.1);
    dmg('body');
    dmg('body');
    expect(audio.plays.length).toBe(1);
    audio.plays.length = 0;
    events.emit('combat:kill', {
      targetId: 1,
      zone: 'head',
      weaponId: 'pistol',
      position: O,
      source: 'player',
    });
    events.emit('combat:kill', {
      targetId: 2,
      zone: 'body',
      weaponId: 'pistol',
      position: O,
      source: 'enemy',
    });
    expect(audio.ids()).toEqual(['ui.kill', 'ui.headshot']);
    expect(audio.plays[1]!.opts.volume).toBeCloseTo(W.critKillLayerGain);
  });

  it('plays casing clinks positionally, louder for faster bounces, rate limited', () => {
    const { audio, bridge, advance } = setup();
    // The VFX ClinkCallback shape (position, sound, speed) plugs in directly.
    bridge.onCasingClink({ x: 2, y: 0, z: 0 }, 'weapon.casing.shell', W.casingSpeedRange[1]);
    expect(audio.plays[0]!.id).toBe('weapon.casing.shell');
    expect(audio.plays[0]!.opts.position).toEqual({ x: 2, y: 0, z: 0 });
    advance(10);
    audio.plays.length = 0;
    bridge.playCasing('weapon.casing.brass', { x: 1, y: 0, z: 0 }, W.casingSpeedRange[0]);
    advance(1);
    bridge.playCasing('weapon.casing.brass', { x: 1, y: 0, z: 0 }, W.casingSpeedRange[1] * 2);
    expect(audio.plays[0]!.opts.volume).toBeCloseTo(W.casingGain * W.casingMinGain);
    expect(audio.plays[1]!.opts.volume).toBeCloseTo(W.casingGain);
    expect(audio.plays[1]!.opts.position).toEqual({ x: 1, y: 0, z: 0 });
    advance(10);
    audio.plays.length = 0;
    for (let i = 0; i < 20; i++) bridge.playCasing('weapon.casing.shell', O, 3);
    expect(audio.plays.length).toBe(W.casingBurst);
  });

  it('never leaks a position into 2D sounds', () => {
    const { events, audio } = setup();
    events.emit('combat:impact', {
      point: { x: 5, y: 5, z: 5 },
      normal: { x: 0, y: 1, z: 0 },
      surface: 'metal',
      kind: 'bullet',
      weaponId: 'rifle',
      decal: true,
    });
    fired(events, 'pistol', 10);
    expect(audio.plays[0]!.opts.position).toBeDefined();
    for (const p of audio.plays.slice(1)) expect(p.opts.position).toBeUndefined();
  });
});
