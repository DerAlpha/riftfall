import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { DamageElement, StatusId, Vec3Like } from '../../core/events';
import {
  ARSENAL_VFX,
  BEAM_STYLES,
  CHARGE_STYLES,
  FIELD_VISUALS,
  GLOW_SHAPES,
  PROJECTILE_VISUALS,
  TRAIL_STYLES,
  getBeamStyle,
  getFieldVisual,
  getProjectileVisual,
  getTrailStyle,
  type GlowLayerDef,
} from '../../defs/arsenalVfx';
import { RENDER } from '../../defs/graphics';
import { POSTFX } from '../../defs/postfx';
import {
  DECAL_CELLS,
  EXPLOSION_PRESET,
  VFX,
  getEffectPreset,
  getImpactProfile,
  type LightFlashDef,
} from '../../defs/vfx';
import { WEAPON_IDS, getWeaponDef, type ExplosionDef, type FieldDef } from '../../defs/weapons';
import { LightPool } from '../LightPool';
import { ParticleSystem } from '../ParticleSystem';
import { ShockwaveEffect } from '../ShockwaveEffect';
import { createSpriteAtlas } from '../spriteAtlas';
import { FakePhysics, FakeSockets, fakeRender, seeded } from '../testFakes';
import { buildBolt } from './ArsenalBeams';
import { ArsenalVfx } from './ArsenalVfx';
import { createArsenalCommands } from './arsenalCommands';
import { StripBatch } from './StripBatch';

// Naming conventions of the M5 packages (defs/weaponData/common.ts, package prompts).
const MUZZLES = [
  'pistol',
  'rifle',
  'shotgun',
  'smg',
  'lmg',
  'sniper',
  'plasma',
  'energy',
  'flame',
  'launcher',
  'void',
  'shock',
  'ice',
];
const IMPACTS = ['plasma', 'shock', 'fire', 'ice', 'poison', 'void'];
const PROJECTILES = [
  'plasma',
  'grenade',
  'frag',
  'incendiary',
  'cryo',
  'singularity',
  'voidorb',
  'shockorb',
  'cryoorb',
];
const TRAILS = ['plasma', 'smoke', 'void', 'frost', 'shock', 'fire'];
const BEAMS = ['lightning', 'flame', 'void'];
const FIELDS = ['pull.void', 'damage.fire', 'damage.poison', 'slow.ice'];
const STATUSES: StatusId[] = ['burn', 'chill', 'frozen', 'shocked', 'poisoned', 'voidMark'];
const COMBOS = ['thermoshock', 'neurotoxin', 'toxicblaze', 'superconductor', 'voidrupture'];
const ELEMENTS: DamageElement[] = ['physical', 'fire', 'ice', 'shock', 'poison', 'void'];

const atlas = createSpriteAtlas();
const ZERO = { x: 0, y: 0, z: 0 };

interface Rig {
  arsenal: ArsenalVfx;
  render: ReturnType<typeof fakeRender>;
  spawned: string[];
  lenses: [number, number][];
  hazes: [number, number][];
  sockets: FakeSockets;
  particles: ParticleSystem;
  lights: LightPool;
}

function rig(): Rig {
  const render = fakeRender();
  const spawned: string[] = [];
  const lenses: [number, number][] = [];
  const hazes: [number, number][] = [];
  const sockets = new FakeSockets(render.viewmodelScene);
  const particles = new ParticleSystem(atlas, seeded(3));
  const lights = new LightPool(render.scene, seeded(4));
  const arsenal = new ArsenalVfx({
    render,
    particles,
    lights,
    spawn: (effect) => spawned.push(effect),
    physics: new FakePhysics().asApi(),
    sockets: () => sockets,
    lens: (slot, _p, _r, strength) => lenses.push([slot, strength]),
    haze: (slot, _a, _b, _r0, _r1, strength) => hazes.push([slot, strength]),
    random: seeded(7),
  });
  render.scene.add(arsenal.object);
  return { arsenal, render, spawned, lenses, hazes, sockets, particles, lights };
}

function explosionsOf(def: ReturnType<typeof getWeaponDef>): ExplosionDef[] {
  const out: ExplosionDef[] = [];
  const p = def?.projectile;
  if (p?.explosion) out.push(p.explosion);
  if (p?.field?.collapse) out.push(p.field.collapse);
  for (const t of def?.upgrades ?? []) {
    const s = t.special;
    if (s?.kind === 'explosiveRounds') out.push(s.explosion);
    if (s?.kind === 'fieldOnKill' && s.field.collapse) out.push(s.field.collapse);
  }
  return out;
}

function fieldsOf(def: ReturnType<typeof getWeaponDef>): FieldDef[] {
  const out: FieldDef[] = [];
  if (def?.projectile?.field) out.push(def.projectile.field);
  for (const t of def?.upgrades ?? []) if (t.special?.kind === 'fieldOnKill') out.push(t.special.field);
  return out;
}

describe('arsenal preset coverage (naming conventions)', () => {
  it('every convention id resolves to a preset / style', () => {
    for (const m of MUZZLES) {
      const p = getEffectPreset(`muzzle.${m}`);
      expect(p, m).toBeDefined();
      expect(p!.flash, m).toBeDefined();
      expect(p!.light?.viewmodel, m).toBe(false);
    }
    for (const i of IMPACTS) {
      expect(getImpactProfile(`impact.${i}`), i).toBeDefined();
      expect(getEffectPreset(`impact.${i}`), i).toBeDefined();
    }
    for (const id of PROJECTILES) expect(getProjectileVisual(`projectile.${id}`), id).toBeDefined();
    for (const id of TRAILS) expect(getTrailStyle(`trail.${id}`), id).toBeDefined();
    for (const id of BEAMS) expect(getBeamStyle(`beam.${id}`), id).toBeDefined();
    expect(CHARGE_STYLES['charge.rail']).toBeDefined();
    for (const id of FIELDS) expect(getFieldVisual(`field.${id}`), id).toBeDefined();
    for (const s of STATUSES) expect(getEffectPreset(`status.${s}`), s).toBeDefined();
    for (const c of COMBOS) expect(getEffectPreset(`combo.${c}`), c).toBeDefined();
    for (const el of ELEMENTS) {
      const p = getEffectPreset(EXPLOSION_PRESET[el]);
      expect(p, el).toBeDefined();
      if (el !== 'physical') expect(EXPLOSION_PRESET[el]).toBe(`explosion.${el}`);
      expect(DECAL_CELLS, el).toContain(p!.groundDecal!.kind);
    }
  });

  it('every visual the weapon data references resolves', () => {
    for (const id of WEAPON_IDS) {
      const def = getWeaponDef(id)!;
      const muzzle = getEffectPreset(def.vfx.muzzle);
      expect(muzzle, `${id} muzzle`).toBeDefined();
      if (muzzle?.tracer) expect(getBeamStyle(muzzle.tracer)?.kind, `${id} tracer`).toBe('ray');
      const prof = getImpactProfile(def.vfx.impact);
      expect(prof, `${id} impact`).toBeDefined();
      if (prof?.effect) expect(getEffectPreset(prof.effect), `${id} impact effect`).toBeDefined();
      if (def.projectile) {
        expect(getProjectileVisual(def.projectile.visual), `${id} projectile`).toBeDefined();
        if (def.projectile.trail) expect(getTrailStyle(def.projectile.trail), `${id} trail`).toBeDefined();
      }
      if (def.beam) expect(getBeamStyle(def.beam.visual), `${id} beam`).toBeDefined();
      if (def.charge)
        expect(CHARGE_STYLES[def.charge.visual as keyof typeof CHARGE_STYLES], id).toBeDefined();
      for (const f of fieldsOf(def)) expect(getFieldVisual(f.vfx), `${id} ${f.vfx}`).toBeDefined();
      for (const e of explosionsOf(def)) expect(getEffectPreset(e.vfx), `${id} ${e.vfx}`).toBeDefined();
    }
  });

  it('effects the arsenal styles spawn exist and never bounce (no floor probe per puff)', () => {
    const ids: string[] = [];
    for (const t of Object.values(TRAIL_STYLES)) if (t.puffs) ids.push(t.puffs.effect);
    for (const b of Object.values(BEAM_STYLES)) {
      if (b.kind === 'ray' && b.along) ids.push(b.along.effect);
      else if (b.kind !== 'ray') ids.push(b.hitEffect);
    }
    for (const f of Object.values(FIELD_VISUALS)) for (const a of f.ambient) ids.push(a.effect);
    for (const s of STATUSES) ids.push(`status.${s}`);
    for (const id of ids) {
      const p = getEffectPreset(id);
      expect(p, id).toBeDefined();
      // Status effects are spawned on dozens of enemies: no per-particle floor probes.
      if (id.startsWith('status.') || id.startsWith('trail.') || id.startsWith('field.')) {
        for (const e of p!.emitters) expect(e.bounce, `${id}:${e.sprite}`).toBeUndefined();
      }
    }
  });

  it('glow layers use known shapes and stay readable (HDR, sane sizes)', () => {
    const layers: [string, GlowLayerDef][] = [];
    for (const [id, v] of Object.entries(PROJECTILE_VISUALS)) for (const g of v.glows) layers.push([id, g]);
    for (const [id, f] of Object.entries(FIELD_VISUALS)) for (const g of f.glows) layers.push([id, g]);
    for (const [id, b] of Object.entries(BEAM_STYLES)) {
      if (b.kind === 'lightning') layers.push([id, b.muzzleGlow], [id, b.hitGlow]);
      else if (b.kind === 'flame') layers.push([id, b.nozzleGlow]);
      else layers.push([id, b.startGlow], [id, b.endGlow]);
    }
    for (const [id, g] of layers) {
      expect(GLOW_SHAPES, id).toContain(g.shape);
      expect(g.size, id).toBeGreaterThan(0);
      if (g.blend !== 'dark') expect(g.intensity, id).toBeGreaterThan(0);
    }
    // Muzzle-anchored glows sit half a meter from the eye: they must stay small.
    for (const b of Object.values(BEAM_STYLES)) {
      const g = b.kind === 'lightning' ? b.muzzleGlow : b.kind === 'flame' ? b.nozzleGlow : b.startGlow;
      expect(g.size).toBeLessThanOrEqual(0.2);
    }
  });
});

describe('ArsenalVfx pools and handles', () => {
  it('draws on the volumetric layer; dark discs composite first and write depth', () => {
    const { arsenal } = rig();
    const meshes: THREE.Mesh[] = [];
    arsenal.object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh)
        meshes.push(o as THREE.Mesh);
    });
    expect(meshes.length).toBe(4);
    for (const m of meshes) {
      expect(m.layers.isEnabled(RENDER.volumetricLayer), m.name).toBe(true);
      expect(m.layers.test(new THREE.PerspectiveCamera().layers), m.name).toBe(false);
    }
    const dark = meshes.find((m) => m.name === 'ArsenalGlowDark')!;
    const glow = meshes.find((m) => m.name === 'ArsenalGlow')!;
    expect((dark.material as THREE.ShaderMaterial).depthWrite).toBe(true);
    expect((glow.material as THREE.ShaderMaterial).depthWrite).toBe(false);
    expect(dark.renderOrder).toBeLessThan(glow.renderOrder);
    expect(dark.renderOrder).toBeGreaterThan(VFX.particles.renderOrder.alpha);
    arsenal.dispose();
  });

  it('refuses projectiles beyond capacity and reuses slots with fresh handles', () => {
    const { arsenal } = rig();
    const cap = ARSENAL_VFX.projectiles.capacity;
    const handles: number[] = [];
    for (let i = 0; i < cap; i++)
      handles.push(arsenal.projectileStart('projectile.plasma', null, ZERO, { x: 0, y: 0, z: -80 }));
    expect(handles.every((h) => h > 0)).toBe(true);
    expect(new Set(handles).size).toBe(cap);
    expect(arsenal.projectileStart('projectile.plasma', null, ZERO, ZERO)).toBe(0);
    arsenal.projectileEnd(handles[5]!);
    const again = arsenal.projectileStart('projectile.plasma', null, ZERO, ZERO);
    expect(again).toBeGreaterThan(0);
    expect(again).not.toBe(handles[5]);
    // The stale handle no longer moves or ends the new projectile.
    arsenal.projectileEnd(handles[5]!);
    arsenal.projectileMove(handles[5]!, { x: 99, y: 0, z: 0 }, ZERO);
    expect(arsenal.stats.projectiles).toBe(cap);
    arsenal.update(1 / 60);
    expect(arsenal.stats.glows).toBeGreaterThan(0);
    arsenal.dispose();
  });

  it('clear() invalidates every handle; unknown and bad input never crash', () => {
    const { arsenal } = rig();
    const p = arsenal.projectileStart('projectile.nope', 'trail.nope', ZERO, { x: 1, y: 0, z: 0 });
    expect(p).toBeGreaterThan(0);
    const f = arsenal.fieldStart('field.nope', ZERO, 3, 2);
    expect(f).toBeGreaterThan(0);
    expect(arsenal.projectileStart('projectile.plasma', null, { x: NaN, y: 0, z: 0 }, ZERO)).toBe(0);
    expect(arsenal.fieldStart('field.pull.void', ZERO, 0, 2)).toBe(0);
    arsenal.beam('beam.nope', ZERO, { x: 0, y: 0, z: -5 }, [], 0);
    arsenal.charge('charge.nope', 0.5);
    arsenal.update(1 / 60);
    arsenal.clear();
    expect(arsenal.stats.projectiles).toBe(0);
    expect(arsenal.stats.fields).toBe(0);
    arsenal.projectileMove(p, ZERO, ZERO);
    arsenal.projectileEnd(p);
    arsenal.fieldEnd(f);
    arsenal.update(1 / 60);
    expect(arsenal.hasVolumetricContent).toBe(false);
    arsenal.dispose();
    expect(arsenal.projectileStart('projectile.plasma', null, ZERO, ZERO)).toBe(0);
  });

  it('a trail outlives its projectile, fades out and frees its slot', () => {
    const { arsenal, spawned } = rig();
    const h = arsenal.projectileStart('projectile.grenade', 'trail.smoke', ZERO, { x: 0, y: 0, z: -20 });
    for (let i = 1; i <= 30; i++) {
      arsenal.projectileMove(h, { x: 0, y: 0, z: -i * 0.33 }, { x: 0, y: 0, z: -20 });
      arsenal.update(1 / 60);
    }
    expect(arsenal.stats.trails).toBe(1);
    expect(arsenal.stats.segments).toBeGreaterThan(0);
    expect(spawned.filter((s) => s === 'trail.smoke.puff').length).toBeGreaterThan(10);
    arsenal.projectileEnd(h);
    expect(arsenal.stats.projectiles).toBe(0);
    arsenal.update(1 / 60);
    expect(arsenal.stats.trails).toBe(1);
    for (let i = 0; i < 60; i++) arsenal.update(1 / 60);
    expect(arsenal.stats.trails).toBe(0);
    expect(arsenal.hasVolumetricContent).toBe(false);
    arsenal.dispose();
  });

  it('beams and charges last only while refreshed each frame', () => {
    const { arsenal, sockets } = rig();
    const arcs = [ZERO, { x: 2, y: 0, z: -5 }, { x: 2, y: 0, z: -5 }, { x: 4, y: 1, z: -6 }];
    arsenal.beam('beam.lightning', { x: 0, y: 1.4, z: -0.5 }, { x: 0, y: 1, z: -8 }, arcs, 2);
    arsenal.charge('charge.rail', 0.6);
    arsenal.update(1 / 60);
    expect(arsenal.stats.beams).toBe(1);
    const lightningSegments = arsenal.stats.segments;
    expect(lightningSegments).toBeGreaterThan(20);
    const glow = sockets.anchors.muzzle.children.find((c) => c.name === 'ArsenalChargeGlow')!;
    expect(glow.visible).toBe(true);
    // No refresh: dark next frame.
    arsenal.update(1 / 60);
    expect(arsenal.stats.beams).toBe(0);
    expect(arsenal.stats.segments).toBe(0);
    expect(glow.visible).toBe(false);
    arsenal.dispose();
  });

  it('flame particles are budget scaled and particles off still draw the core', () => {
    const { arsenal, particles, hazes } = rig();
    const fire = (): void => {
      for (let i = 0; i < 20; i++) {
        arsenal.beam('beam.flame', { x: 0, y: 1.4, z: -0.5 }, { x: 0, y: 1.2, z: -9 }, [], 0);
        arsenal.update(1 / 60);
        particles.update(1 / 60, new THREE.PerspectiveCamera());
      }
    };
    fire();
    expect(particles.additiveBuffer.count).toBeGreaterThan(10);
    particles.clear();
    arsenal.setBudget(0);
    fire();
    expect(particles.additiveBuffer.count).toBe(0);
    arsenal.beam('beam.flame', { x: 0, y: 1.4, z: -0.5 }, { x: 0, y: 1.2, z: -9 }, [], 0);
    arsenal.update(1 / 60);
    expect(arsenal.stats.segments).toBeGreaterThan(0);
    // The stream shimmers the background while it burns; the haze slot is cleared after.
    expect(hazes.at(-1)![1]).toBeGreaterThan(0);
    arsenal.update(1 / 60);
    expect(hazes.at(-1)).toEqual([0, 0]);
    arsenal.dispose();
  });

  it('fields grow in, end with a fade-out and free themselves; pull fields lens', () => {
    const { arsenal, lenses } = rig();
    const def = FIELD_VISUALS['field.pull.void'];
    const h = arsenal.fieldStart('field.pull.void', { x: 0, y: 0.2, z: -6 }, 5, 0);
    arsenal.update(0.5);
    expect(arsenal.stats.fields).toBe(1);
    expect(lenses.at(-1)![1]).toBeGreaterThan(0);
    arsenal.fieldEnd(h);
    arsenal.update(def.fadeOut / 2);
    expect(arsenal.stats.fields).toBe(1);
    arsenal.update(def.fadeOut);
    arsenal.update(1 / 60);
    expect(arsenal.stats.fields).toBe(0);
    // The lens slot is switched off once unused.
    expect(lenses.at(-1)).toEqual([0, 0]);
    // A timed field acts at full strength for its duration, then fades out by itself.
    arsenal.fieldStart('field.slow.ice', ZERO, 3, 1);
    for (let i = 0; i < 55; i++) arsenal.update(1 / 60);
    expect(arsenal.stats.fields).toBe(1);
    for (let i = 0; i < 70; i++) arsenal.update(1 / 60);
    expect(arsenal.stats.fields).toBe(0);
    arsenal.dispose();
  });

  it('one-shot rays start at the displayed muzzle and fade out', () => {
    const { arsenal, sockets } = rig();
    sockets.world.muzzle.set(0.3, 1.3, -0.5);
    arsenal.shot('beam.rail', { x: 0, y: 1, z: -20 }, { x: 9, y: 9, z: 9 });
    arsenal.update(1 / 60);
    expect(arsenal.stats.beams).toBe(1);
    expect(arsenal.stats.segments).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) arsenal.update(1 / 60);
    expect(arsenal.stats.beams).toBe(0);
    arsenal.dispose();
  });

  it('reduce flashing steadies the lightning flicker and softens blinking LEDs', () => {
    const coreBrightness = (a: ArsenalVfx): number => {
      const mesh = a.object.getObjectByName('ArsenalStrips') as THREE.Mesh | undefined;
      const geo = mesh!.geometry as THREE.InstancedBufferGeometry;
      const col = geo.getAttribute('iColA').array as Float32Array;
      let sum = 0;
      for (let i = 0; i < geo.instanceCount; i++) sum += col[i * 4]! + col[i * 4 + 1]! + col[i * 4 + 2]!;
      return sum;
    };
    const glowBrightness = (a: ArsenalVfx): number => {
      const mesh = a.object.getObjectByName('ArsenalGlow') as THREE.Mesh;
      const geo = mesh.geometry as THREE.InstancedBufferGeometry;
      const col = geo.getAttribute('iColor').array as Float32Array;
      let sum = 0;
      for (let i = 0; i < geo.instanceCount; i++) sum += col[i * 4]! + col[i * 4 + 1]! + col[i * 4 + 2]!;
      return sum;
    };
    const run = (scale: number) => {
      const { arsenal } = rig();
      arsenal.setFlashScale(scale);
      const beam: number[] = [];
      for (let i = 0; i < 40; i++) {
        arsenal.beam('beam.lightning', { x: 0, y: 1.4, z: -0.5 }, { x: 0, y: 1, z: -8 }, [], 0);
        arsenal.update(1 / 60);
        beam.push(coreBrightness(arsenal));
      }
      arsenal.clear();
      // A grenade LED blinking at 6 Hz: the largest frame-to-frame brightness jump.
      const h = arsenal.projectileStart('projectile.grenade', null, { x: 0, y: 1, z: -6 }, ZERO);
      let prev = -1;
      let jump = 0;
      let peak = 0;
      for (let i = 0; i < 60; i++) {
        arsenal.projectileMove(h, { x: 0, y: 1, z: -6 }, ZERO);
        arsenal.update(1 / 120);
        const g = glowBrightness(arsenal);
        if (prev >= 0) jump = Math.max(jump, Math.abs(g - prev));
        peak = Math.max(peak, g);
        prev = g;
      }
      arsenal.dispose();
      return { beamSpread: (Math.max(...beam) - Math.min(...beam)) / Math.max(...beam), jump: jump / peak };
    };
    const normal = run(1);
    const reduced = run(ARSENAL_VFX.reducedFlashingScale);
    expect(normal.beamSpread).toBeGreaterThan(0.05);
    expect(reduced.beamSpread).toBeLessThan(1e-3);
    // Hard on/off blink normally; a soft pulse (no frame-to-frame jump near the full swing).
    expect(normal.jump).toBeGreaterThan(0.6);
    expect(reduced.jump).toBeLessThan(0.25);
  });

  it('warm-up draws one invisible instance per batch', () => {
    const { arsenal } = rig();
    arsenal.setWarmup(true);
    let visible = 0;
    arsenal.object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.visible) visible++;
    });
    // 4 batches + 2 meshes per grenade body shape.
    expect(visible).toBe(4 + 6);
    expect(arsenal.hasVolumetricContent).toBe(true);
    arsenal.setWarmup(false);
    let after = 0;
    arsenal.object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.visible) after++;
    });
    expect(after).toBe(0);
    arsenal.dispose();
  });
});

describe('arsenal building blocks', () => {
  it('bolts keep both ends and stay within their jitter amplitude', () => {
    const rnd = new Float32Array(256).map((_, i) => ((i * 7919) % 256) / 256);
    const out = new Float32Array(41 * 3);
    const n = buildBolt(0, 0, 0, 0, 0, -10, 20, 0.5, rnd, 3, false, out);
    expect(n).toBe(20);
    expect([out[0], out[1], out[2]]).toEqual([0, 0, 0]);
    expect(out[n * 3 + 2]).toBeCloseTo(-10, 5);
    expect(Math.abs(out[n * 3]!)).toBeLessThan(1e-5);
    for (let i = 0; i <= n; i++) {
      const off = Math.hypot(out[i * 3]!, out[i * 3 + 1]!);
      expect(off).toBeLessThanOrEqual(0.5 * Math.SQRT2 + 1e-6);
    }
    // Branches (free tip) start at their root.
    const b = buildBolt(1, 2, 3, 1, 2, 5, 4, 0.3, rnd, 9, true, out);
    expect([out[0], out[1], out[2]]).toEqual([1, 2, 3]);
    expect(b).toBe(4);
  });

  it('strips share their edge vertices between segments (miter from neighbours)', () => {
    const strips = new StripBatch(16, { value: 0 });
    strips.begin();
    strips.beginStrip(0, 0);
    for (let i = 0; i < 4; i++) strips.point(i, i * i * 0.1, 0, 0.1, 1, 1, 1, 1);
    expect(strips.endStrip()).toBe(3);
    strips.end();
    const g = strips.mesh.geometry as THREE.InstancedBufferGeometry;
    const p0 = g.getAttribute('iP0').array as Float32Array;
    const p3 = g.getAttribute('iP3').array as Float32Array;
    // Segment 1 (points 1 → 2): neighbours are points 0 and 3.
    expect([p0[4], p0[5]]).toEqual([0, 0]);
    expect(p3[4]).toBe(3);
    // Ends clamp to themselves.
    expect(p0[0]).toBe(0);
    expect(p3[8]).toBe(3);
    expect(g.instanceCount).toBe(3);
    strips.dispose();
  });

  it('sustained lights keep their own slot instead of hopping', () => {
    const pool = new LightPool(new THREE.Scene(), seeded(2));
    const def: LightFlashDef = { color: [1, 1, 1], intensity: 10, range: 5, duration: 0.1, priority: 1 };
    let h = pool.sustain(0, def, ZERO, null);
    expect(h).toBeGreaterThan(0);
    const slot = pool.slots.slotOf(h);
    for (let i = 0; i < 5; i++) {
      pool.update(0.03);
      pool.endFrame();
      h = pool.sustain(h, def, { x: i, y: 0, z: 0 }, null);
      expect(pool.slots.slotOf(h)).toBe(slot);
    }
    expect(pool.active).toBe(1);
    // A stale handle (flash finished) takes a new slot.
    pool.endFrame();
    for (let i = 0; i < 10; i++) pool.update(0.05);
    expect(pool.slots.slotOf(h)).toBe(-1);
    expect(pool.sustain(h, def, ZERO, null)).toBeGreaterThan(0);
    pool.dispose();
  });

  it('shockwave lenses keep the pass enabled until cleared', () => {
    const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
    cam.updateMatrixWorld();
    const fx = new ShockwaveEffect(cam);
    expect(fx.active).toBe(false);
    fx.setLens(0, { x: 0, y: 0, z: -6 }, 2, 1);
    expect(fx.active).toBe(true);
    fx.advance(0);
    expect((fx.uniforms.get('lensCount') as THREE.Uniform<number>).value).toBe(1);
    const l = (fx.uniforms.get('lenses') as THREE.Uniform<THREE.Vector4[]>).value[0]!;
    expect(l.x).toBeCloseTo(0.5, 5);
    expect(l.w).toBeCloseTo(l.z * POSTFX.shockwave.lensEinstein, 6);
    fx.setLens(0, { x: 0, y: 0, z: -6 }, 2, 0);
    expect(fx.active).toBe(false);
    fx.setLens(9, ZERO, 1, 1);
    fx.setLens(1, { x: NaN, y: 0, z: 0 }, 1, 1);
    expect(fx.active).toBe(false);
    // Heat haze: projected when both ends are in front of the camera.
    fx.setHaze(0, { x: 0, y: -0.2, z: -1 }, { x: 0, y: 0, z: -8 }, 0.05, 1, 0.006);
    expect(fx.active).toBe(true);
    fx.advance(1 / 60);
    expect((fx.uniforms.get('hazeCount') as THREE.Uniform<number>).value).toBe(1);
    fx.setHaze(0, { x: 0, y: 0, z: 2 }, { x: 0, y: 0, z: -8 }, 0.05, 1, 0.006);
    fx.advance(1 / 60);
    expect((fx.uniforms.get('hazeCount') as THREE.Uniform<number>).value).toBe(0);
    fx.clear();
    expect(fx.active).toBe(false);
  });
});

describe('fx console command', () => {
  it('previews every kind and completes ids', async () => {
    const { arsenal, render, sockets } = rig();
    const spawned: string[] = [];
    const cmds = createArsenalCommands({
      arsenal,
      vfx: {
        spawn: (id: string) => void spawned.push(id),
        explosion: (_p: Vec3Like, r: number, el?: DamageElement) => void spawned.push(`boom ${r} ${el}`),
      },
      physics: new FakePhysics().asApi(),
      camera: render.camera,
      sockets: () => sockets,
    });
    const fx = cmds[0]!;
    const run = (...args: string[]): unknown => fx.run(args);
    expect(await run('projectile', 'plasma')).toContain('projectile.plasma');
    expect(await run('beam', 'lightning', '1')).toContain('beam.lightning');
    expect(await run('field', 'pull.void', '4', '2')).toContain('field.pull.void');
    expect(await run('charge')).toContain('charge.rail');
    expect(await run('shot', 'void')).toContain('beam.void');
    expect(() => run('beam')).toThrow();
    expect(() => run('nope')).toThrow();
    for (let i = 0; i < 120; i++) arsenal.update(1 / 30);
    // The camera looks down −Z over the fake floor: the plasma bolt eventually expires.
    expect(fx.complete!(['fi'])).toEqual(['field']);
    expect(fx.complete!(['field', 'pull'])).toEqual(['pull.void']);
    expect(await run('clear')).toContain('entfernt');
    expect(arsenal.stats.fields).toBe(0);
    arsenal.dispose();
  });
});
