import { describe, expect, it } from 'vitest';
import type { StatusId } from '../core/events';
import { Rng } from '../core/Rng';
import { AUDIO } from '../defs/audio';
import { COMBOS, ELEMENTS, ELEMENT_MODS } from '../defs/elements';
import { WEAPONS, WEAPON_IDS, getWeaponDef, type ReloadStep } from '../defs/weapons';
import { LOOP_DURATION, LOOP_HZ, loopHz } from './arsenalKit';
import { ARSENAL_SYNTH_DEFS, m5SynthAlias } from './arsenalSynth';
import { ELEMENT_SYNTH_ALIASES } from './elementSynth';
import { GEAR_SYNTH_ALIASES } from './gearSynth';
import { SYNTH_DEFS, SYNTH_IDS, resolveSynthId, type SynthDef, type SynthGraph } from './synth';
import { WEAPON_SYNTH_DEFS } from './weaponSynth';

const STEPS: readonly ReloadStep[] = ['magOut', 'magIn', 'boltRelease', 'shellIn', 'pump'];
const STATUS_IDS: readonly StatusId[] = ['burn', 'chill', 'frozen', 'shocked', 'poisoned', 'voidMark'];

/** Every string under a key naming an audio id (audio, flightAudio, loopAudio, chargeAudio …), deep. */
function audioIds(root: unknown, out: Set<string> = new Set(), key = ''): Set<string> {
  if (typeof root === 'string') {
    if (/audio/i.test(key) && root !== '') out.add(root);
    return out;
  }
  if (Array.isArray(root)) {
    // WeaponAudioDef.fire / extraFire lists.
    for (const v of root) audioIds(v, out, key === 'fire' || key === 'extraFire' ? 'audio' : key);
    return out;
  }
  if (root && typeof root === 'object') {
    for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
      audioIds(v, out, /audio/i.test(key) && typeof v !== 'object' ? key : k);
    }
  }
  return out;
}

describe('M5 arsenal sound ids', () => {
  it('resolves every convention id of every weapon (all reload steps, dry, loops)', () => {
    for (const id of WEAPON_IDS) {
      const d = getWeaponDef(id)!;
      const ids = [`weapon.${id}.fire`, `weapon.${id}.mech`, `weapon.${id}.equip`, `weapon.${id}.dry`];
      for (const step of STEPS) ids.push(`weapon.${id}.${step}`);
      if (d.beam) ids.push(d.beam.loopAudio);
      if (d.charge) ids.push(d.charge.chargeAudio);
      if (d.spinUp) ids.push(d.spinUp.loopAudio);
      if (d.projectile?.flightAudio) ids.push(d.projectile.flightAudio);
      for (const s of ids) expect(resolveSynthId(s), `${id}: ${s}`).not.toBeNull();
    }
  });

  it('gives the 22 new weapons dedicated fire / mech / equip recipes and loops of their own', () => {
    for (const id of WEAPON_IDS) {
      if (id === 'pistol' || id === 'rifle' || id === 'shotgun') continue;
      for (const key of ['fire', 'mech', 'equip']) {
        expect(Object.hasOwn(ARSENAL_SYNTH_DEFS, `weapon.${id}.${key}`), `${id}.${key}`).toBe(true);
      }
      const d = getWeaponDef(id)!;
      for (const loop of [d.beam?.loopAudio, d.charge?.chargeAudio, d.spinUp?.loopAudio]) {
        if (!loop) continue;
        const def = (SYNTH_DEFS as Record<string, SynthDef>)[loop];
        expect(def?.loop, loop).toBe(true);
        expect(def?.channels, loop).toBe(2);
      }
    }
  });

  it('resolves every audio id the weapon, element and module data names (explosions, fields, specials)', () => {
    const ids = audioIds(WEAPONS);
    audioIds(ELEMENTS, ids);
    audioIds(ELEMENT_MODS, ids);
    expect(ids.size).toBeGreaterThan(40);
    for (const s of ids) expect(resolveSynthId(s), s).not.toBeNull();
  });

  it('covers explosions, fields, statuses, combos, gear and forge by the naming convention', () => {
    const ids: string[] = [];
    for (const el of ['physical', 'fire', 'ice', 'shock', 'poison', 'void']) {
      ids.push(`explosion.${el}`, `explosion.${el}.small`);
      for (const kind of ['pull', 'damage', 'slow']) ids.push(`field.${kind}.${el}`);
    }
    for (const v of [
      'plasma',
      'grenade',
      'frag',
      'incendiary',
      'cryo',
      'singularity',
      'voidorb',
      'shockorb',
      'cryoorb',
    ])
      ids.push(`projectile.${v}.flight`);
    for (const s of STATUS_IDS) ids.push(`status.${s}`);
    for (const c of COMBOS) ids.push(`combo.${c.id}`);
    for (const i of ['plasma', 'shock', 'fire', 'ice', 'poison', 'void']) ids.push(`impact.${i}`);
    ids.push('grenade.throw', 'grenade.bounce', 'grenade.pin', 'ability.ready', 'ability.end');
    for (const a of ['schockwelle', 'phasenbarriere', 'ueberladung', 'chronofeld']) ids.push(`ability.${a}`);
    ids.push('forge.upgrade', 'forge.deny', 'bench.attach', 'bench.open', 'bench.close', 'element.install');
    ids.push(
      'weapon.tail.energy',
      'weapon.tail.explosive',
      AUDIO.arsenal.charge.full.id,
      AUDIO.arsenal.charge.fizzle.id,
    );
    for (const s of ids) expect(resolveSynthId(s), s).not.toBeNull();
    // Statuses, combos, gear and the forge are real recipes, not aliases.
    for (const s of STATUS_IDS) expect(Object.hasOwn(ARSENAL_SYNTH_DEFS, `status.${s}`)).toBe(true);
    for (const c of COMBOS) expect(Object.hasOwn(ARSENAL_SYNTH_DEFS, `combo.${c.id}`)).toBe(true);
    // Unknown abilities get the generic activation; unknown elements the physical blast.
    expect(resolveSynthId('ability.somethingnew')).toBe(AUDIO.arsenal.abilities.fallback);
    expect(resolveSynthId('explosion.plasma.small')).toBe('explosion.physical.small');
    expect(resolveSynthId('field.slow.chrono')).toBe('field.slow.void');
    // Ids outside every convention stay unknown (silent + one warning in the engine).
    expect(resolveSynthId('impact.bullet')).toBeNull();
    expect(resolveSynthId('impact.pellet')).toBeNull();
    expect(resolveSynthId('weapon.nope.fire')).toBeNull();
  });

  it('keeps aliases pointing at real recipes without shadowing M2 recipes or aliases', () => {
    for (const [from, to] of [
      ...Object.entries(ELEMENT_SYNTH_ALIASES),
      ...Object.entries(GEAR_SYNTH_ALIASES),
    ]) {
      expect(Object.hasOwn(SYNTH_DEFS, from), from).toBe(false);
      expect(Object.hasOwn(SYNTH_DEFS, to), to).toBe(true);
    }
    // M2 ids keep their own recipes and aliases.
    expect(resolveSynthId('weapon.pistol.slide')).toBe('weapon.pistol.boltRelease');
    expect(resolveSynthId('weapon.rifle.pump')).toBe('weapon.shotgun.pump');
    expect(resolveSynthId('explosion')).toBe('explosion');
    // A launcher's missing magazine steps fall back on its own shell / pump recipes.
    expect(resolveSynthId('weapon.grenadelauncher.magIn')).toBe('weapon.grenadelauncher.shellIn');
    expect(resolveSynthId('weapon.grenadelauncher.boltRelease')).toBe('weapon.grenadelauncher.pump');
    // Energy weapons click empty with the energy dry fire, pistols with the pistol's.
    expect(resolveSynthId('weapon.plasma.dry')).toBe('weapon.energy.dry');
    expect(resolveSynthId('weapon.revolver.dry')).toBe('weapon.pistol.dry');
    expect(m5SynthAlias('weapon.pistol.fire', () => true)).toBeNull();
  });

  it('merges into the bank after the M2-M4 sounds; positional sounds mono, player weapons stereo', () => {
    for (const id of Object.keys(ARSENAL_SYNTH_DEFS)) expect(SYNTH_IDS).toContain(id);
    expect(SYNTH_IDS.indexOf('weapon.pistol.fire')).toBeLessThan(SYNTH_IDS.indexOf('weapon.revolver.fire'));
    const defs = ARSENAL_SYNTH_DEFS as Record<string, SynthDef>;
    for (const [id, d] of Object.entries(defs)) {
      if (/^(explosion|field|projectile|status|combo|impact)\./.test(id) || id === 'grenade.bounce') {
        expect(d.channels, id).toBe(1);
      }
      if (/^weapon\.[a-z]+\.fire$/.test(id)) expect(d.channels, id).toBe(2);
      if (d.loop) expect(d.duration, id).toBeCloseTo(LOOP_DURATION);
    }
  });

  it('snaps loop frequencies to whole cycles per loop', () => {
    expect(loopHz(330.4) / LOOP_HZ).toBeCloseTo(Math.round(330.4 / LOOP_HZ));
    expect(loopHz(0.01)).toBe(LOOP_HZ);
  });

  it('keeps the new sounds inside a memory budget', () => {
    let channelSeconds = 0;
    for (const d of Object.values(ARSENAL_SYNTH_DEFS as Record<string, SynthDef>)) {
      channelSeconds += d.duration * d.variants * d.channels * (d.rate ?? 1);
    }
    // < ~44 MB of float32 at 48 kHz before trimming; the trimmed buffers are smaller.
    expect(channelSeconds).toBeLessThan(230);
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
  channelCount = 2;
  channelCountMode = 'max';
  constructor(protected readonly log: string[]) {}
  connect<T>(n: T): T {
    if (!n) this.log.push('connect(undefined)');
    return n;
  }
}

class FakeSource extends FakeNode {
  constructor(
    log: string[],
    private readonly starts: number[],
  ) {
    super(log);
  }
  start(t: number, offset = 0): void {
    if (!Number.isFinite(t) || t < 0 || !Number.isFinite(offset) || offset < 0)
      this.log.push(`start(${t}, ${offset})`);
    this.starts.push(t);
  }
  stop(t: number): void {
    if (!Number.isFinite(t)) this.log.push(`stop(${t})`);
  }
}

class FakeOfflineContext {
  readonly errors: string[] = [];
  readonly starts: number[] = [];
  readonly destination: FakeNode;
  constructor(
    readonly sampleRate: number,
    channels: number,
  ) {
    this.destination = Object.assign(new FakeNode(this.errors), { channelCount: channels });
  }
  private param(): FakeParam {
    return new FakeParam(this.errors);
  }
  createGain() {
    return Object.assign(new FakeNode(this.errors), { gain: this.param() });
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(this.errors), {
      type: 'lowpass',
      frequency: this.param(),
      Q: this.param(),
    });
  }
  createOscillator() {
    return Object.assign(new FakeSource(this.errors, this.starts), { type: 'sine', frequency: this.param() });
  }
  createBufferSource() {
    return Object.assign(new FakeSource(this.errors, this.starts), {
      buffer: null as unknown,
      loop: false,
      playbackRate: this.param(),
    });
  }
  createWaveShaper() {
    return Object.assign(new FakeNode(this.errors), { curve: null as unknown, oversample: 'none' });
  }
  createStereoPanner() {
    return Object.assign(new FakeNode(this.errors), { pan: this.param() });
  }
  createDelay(max: number) {
    if (!(max > 0)) this.errors.push(`createDelay(${max})`);
    return Object.assign(new FakeNode(this.errors), { delayTime: this.param() });
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { length, duration: length / rate, copyToChannel: () => undefined };
  }
}

describe('M5 arsenal recipes', () => {
  it('schedule valid Web Audio graphs that start inside the rendered duration', () => {
    for (const [id, def] of Object.entries(ARSENAL_SYNTH_DEFS as Record<string, SynthDef>)) {
      for (let v = 0; v < def.variants; v++) {
        const ctx = new FakeOfflineContext(48000, def.channels);
        const graph = { ctx, rng: new Rng(`test:${id}:${v}`) } as unknown as SynthGraph;
        const t0 = v * (def.duration + AUDIO.synth.variantGap);
        def.recipe(graph, t0);
        expect(ctx.errors, id).toEqual([]);
        expect(ctx.starts.length, id).toBeGreaterThan(0);
        for (const t of ctx.starts) {
          expect(t, id).toBeGreaterThanOrEqual(t0);
          expect(t, id).toBeLessThan(t0 + def.duration);
        }
      }
    }
  });

  it('still validates the M2 weapon recipes after the kit fixes (fixed bus channel counts)', () => {
    for (const [id, def] of Object.entries(WEAPON_SYNTH_DEFS as Record<string, SynthDef>)) {
      const ctx = new FakeOfflineContext(48000, def.channels);
      def.recipe({ ctx, rng: new Rng(`test:${id}`) } as unknown as SynthGraph, 0);
      expect(ctx.errors, id).toEqual([]);
    }
  });
});
