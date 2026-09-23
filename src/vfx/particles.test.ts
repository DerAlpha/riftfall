import { describe, expect, it } from 'vitest';
import { VFX, VFX_EFFECTS, type EffectPreset, type EmitterDef } from '../defs/vfx';
import { spriteCell } from './atlas';
import {
  createEmitContext,
  emitPreset,
  emitterCount,
  presetCollides,
  reflectDirection,
  sampleCone,
  tintColor,
} from './emit';
import { mulberry32 } from './noise';
import {
  ParticleBuffer,
  createParticleSpawn,
  easeOutQuad,
  particleAlpha,
  type ParticleInstanceArrays,
} from './ParticleBuffer';

const PARAMS = { bounceFriction: 0.5, restSpeed: 0.3 };

function arrays(n: number): ParticleInstanceArrays {
  return {
    pos: new Float32Array(n * 4),
    color: new Float32Array(n * 4),
    misc: new Float32Array(n * 4),
    vel: new Float32Array(n * 3),
  };
}

describe('ParticleBuffer', () => {
  it('spawns up to the active capacity and drops the rest', () => {
    const b = new ParticleBuffer(8, PARAMS);
    const s = createParticleSpawn();
    b.setCapacity(3);
    expect([b.spawn(s), b.spawn(s), b.spawn(s), b.spawn(s)]).toEqual([true, true, true, false]);
    expect(b.count).toBe(3);
    b.setCapacity(2);
    expect(b.count).toBe(2);
    b.setCapacity(100);
    expect(b.capacity).toBe(8);
  });

  it('rejects particles without life', () => {
    const b = new ParticleBuffer(4, PARAMS);
    const s = createParticleSpawn();
    s.life = 0;
    expect(b.spawn(s)).toBe(false);
    s.life = Number.NaN;
    expect(b.spawn(s)).toBe(false);
  });

  it('integrates gravity and exact exponential drag', () => {
    const b = new ParticleBuffer(4, PARAMS);
    const s = createParticleSpawn();
    s.life = 10;
    s.vx = 2;
    s.gravity = 10;
    s.drag = 0;
    b.spawn(s);
    b.update(0.1);
    expect(b.vy[0]).toBeCloseTo(-1, 5);
    expect(b.py[0]).toBeCloseTo(-0.1, 5);
    expect(b.px[0]).toBeCloseTo(0.2, 5);

    const d = new ParticleBuffer(4, PARAMS);
    s.gravity = 0;
    s.drag = 3;
    s.vx = 4;
    d.spawn(s);
    d.update(0.5);
    expect(d.vx[0]).toBeCloseTo(4 * Math.exp(-1.5), 5);
  });

  it('kills expired particles and keeps the survivors packed', () => {
    const b = new ParticleBuffer(8, PARAMS);
    const s = createParticleSpawn();
    for (let i = 0; i < 5; i++) {
      s.life = i % 2 === 0 ? 0.05 : 1;
      s.x = i;
      b.spawn(s);
    }
    b.update(0.1);
    expect(b.count).toBe(2);
    const xs = [b.px[0], b.px[1]].sort();
    expect(xs).toEqual([1, 3]);
  });

  it('bounces off the floor and comes to rest', () => {
    const b = new ParticleBuffer(2, PARAMS);
    const s = createParticleSpawn();
    s.life = 10;
    s.y = 1;
    s.gravity = 10;
    s.bounce = 0.5;
    s.floorY = 0;
    b.spawn(s);
    let minY = Infinity;
    let bounced = false;
    for (let i = 0; i < 400; i++) {
      b.update(1 / 60);
      minY = Math.min(minY, b.py[0]!);
      if (b.vy[0]! > 0) bounced = true;
    }
    expect(minY).toBeGreaterThanOrEqual(0);
    expect(bounced).toBe(true);
    expect(b.py[0]).toBeCloseTo(0, 5);
    expect(b.vy[0]).toBe(0);
    expect(b.gravity[0]).toBe(0);
  });

  it('never passes through the plane of the surface it came from', () => {
    const b = new ParticleBuffer(2, PARAMS);
    const s = createParticleSpawn();
    s.life = 10;
    s.x = 0.1;
    s.vx = -8; // flying into a wall at x = 0 with normal +X
    s.bounce = 0.4;
    s.planeNx = 1;
    s.planeD = 0;
    b.spawn(s);
    b.update(1 / 30);
    expect(b.px[0]).toBeGreaterThanOrEqual(0);
    expect(b.vx[0]).toBeGreaterThan(0);
    expect(b.vx[0]).toBeCloseTo(8 * 0.4, 5);
  });

  it('holds particles spawned this frame in their spawn state until endFrame()', () => {
    const b = new ParticleBuffer(4, PARAMS);
    const s = createParticleSpawn();
    s.life = 0.05;
    s.vx = 10;
    b.spawn(s);
    // A whole 30 Hz frame is longer than a 50 ms flash lives in two steps: still drawn once.
    b.update(1 / 30, true);
    b.update(1 / 30, true);
    expect(b.count).toBe(1);
    expect(b.px[0]).toBe(0);
    expect(b.age[0]).toBe(0);
    b.endFrame();
    b.update(1 / 60, true);
    expect(b.px[0]).toBeCloseTo(10 / 60, 5);
    b.update(1 / 30, true);
    expect(b.count).toBe(0);
    // Without holding, the spawn frame simulates like any other.
    b.spawn(s);
    b.update(1 / 60);
    expect(b.px[0]).toBeCloseTo(10 / 60, 5);
  });

  it('ignores collisions when bounce is negative', () => {
    const b = new ParticleBuffer(2, PARAMS);
    const s = createParticleSpawn();
    s.life = 10;
    s.vy = -5;
    s.floorY = 0;
    s.bounce = -1;
    b.spawn(s);
    b.update(0.1);
    expect(b.py[0]).toBeLessThan(0);
  });

  it('writes size / color / alpha curves over life', () => {
    const b = new ParticleBuffer(2, PARAMS);
    const s = createParticleSpawn();
    s.life = 1;
    s.size0 = 1;
    s.size1 = 3;
    s.r0 = 10;
    s.r1 = 0;
    s.a0 = 1;
    s.a1 = 0;
    s.cell = 5;
    s.stretch = 0.02;
    b.spawn(s);
    b.update(0.5);
    const out = arrays(2);
    expect(b.writeInstances(out)).toBe(1);
    expect(out.pos[3]).toBeCloseTo(1 + 2 * easeOutQuad(0.5), 5);
    expect(out.color[0]).toBeCloseTo(5, 5);
    expect(out.color[3]).toBeCloseTo(0.5, 5);
    expect(out.misc[1]).toBe(5);
    expect(out.misc[2]).toBeCloseTo(0.02, 6);
  });

  it('fades in over the fade-in fraction', () => {
    expect(particleAlpha(0, 1, 0, 0.2)).toBe(0);
    expect(particleAlpha(0.1, 1, 0, 0.2)).toBeCloseTo(0.45, 5);
    expect(particleAlpha(0.5, 1, 0, 0.2)).toBeCloseTo(0.5, 5);
    expect(particleAlpha(0.5, 1, 1, 0)).toBe(1);
  });

  it('holds and then fades out over the fade-out fraction', () => {
    expect(particleAlpha(0.3, 0.8, 0.8, 0, 0.5)).toBeCloseTo(0.8, 6);
    expect(particleAlpha(0.75, 0.8, 0.8, 0, 0.5)).toBeCloseTo(0.4, 6);
    expect(particleAlpha(1, 0.8, 0.8, 0, 0.5)).toBe(0);
  });

  it('sorts back to front for alpha blending', () => {
    const b = new ParticleBuffer(8, PARAMS);
    const s = createParticleSpawn();
    s.life = 10;
    for (const z of [-2, -9, -5, -1]) {
      s.z = z;
      b.spawn(s);
    }
    const out = arrays(8);
    const cam = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, range: 100 };
    expect(b.writeInstances(out, cam)).toBe(4);
    const zs = [out.pos[2], out.pos[6], out.pos[10], out.pos[14]];
    expect(zs).toEqual([-9, -5, -2, -1]);
    // Fewer particles next frame: stale sort keys must not leak in.
    b.setCapacity(2);
    expect(b.writeInstances(out, cam)).toBe(2);
    expect([out.pos[2], out.pos[6]]).toEqual([-9, -2]);
  });
});

describe('emitter sampling', () => {
  it('samples unit directions inside the cone', () => {
    const rand = mulberry32(3);
    const out = { x: 0, y: 0, z: 0 };
    const axes = [
      [0, 1, 0],
      [0, 0, -1],
      [1, 0, 0],
      [0.6, -0.8, 0],
    ] as const;
    for (const [ax, ay, az] of axes) {
      const cosMax = Math.cos((30 * Math.PI) / 180);
      for (let i = 0; i < 200; i++) {
        sampleCone(ax, ay, az, cosMax, rand(), rand(), out);
        expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 5);
        expect(out.x * ax + out.y * ay + out.z * az).toBeGreaterThanOrEqual(cosMax - 1e-6);
      }
    }
    // Full sphere reaches the opposite hemisphere.
    let min = 1;
    for (let i = 0; i < 400; i++) {
      sampleCone(0, 1, 0, -1, rand(), rand(), out);
      min = Math.min(min, out.y);
    }
    expect(min).toBeLessThan(-0.9);
  });

  it('scales counts with budget and effect scale, keeping minCount while on', () => {
    const def: EmitterDef = {
      blend: 'add',
      sprite: 'spark',
      count: [10, 10],
      minCount: 3,
      life: [1, 1],
      speed: [1, 1],
      spread: 10,
      size: [0.1, 0.1],
      color: [1, 1, 1],
    };
    expect(emitterCount(def, 1, 1, 0.5)).toBe(10);
    expect(emitterCount(def, 0.4, 1, 0.5)).toBe(4);
    expect(emitterCount(def, 0.1, 1, 0.5)).toBe(3);
    expect(emitterCount(def, 0, 1, 0.5)).toBe(0);
    expect(emitterCount(def, 1, 10, 0.5)).toBe(10 * VFX.particles.countScale[1]);
    expect(emitterCount(def, 1, 0.01, 0.5)).toBe(10 * VFX.particles.countScale[0]);
  });

  it('tints toward the element color by luminance', () => {
    const out = [0, 0, 0];
    tintColor(1, 1, 1, [0.5, 1, 2], 1, out);
    expect(out).toEqual([0.5, 1, 2].map((v) => v * 1));
    tintColor(1, 0.5, 0, [0, 0, 1], 0, out);
    expect(out).toEqual([1, 0.5, 0]);
  });

  it('emits presets into the right buffers with HDR colors and collision planes', () => {
    const add = new ParticleBuffer(512, PARAMS);
    const alpha = new ParticleBuffer(512, PARAMS);
    const ctx = createEmitContext();
    ctx.x = 1;
    ctx.y = 2;
    ctx.z = 3;
    ctx.nx = 0;
    ctx.ny = 0;
    ctx.nz = 1;
    ctx.surfacePlane = true;
    ctx.floorY = 0;
    const preset: EffectPreset = VFX_EFFECTS['impact.metal'];
    const n = emitPreset(preset, ctx, add, alpha, mulberry32(9));
    expect(n).toBe(add.count + alpha.count);
    expect(add.count).toBeGreaterThan(0);
    // Every spark carries the impact plane and the floor.
    let sparks = 0;
    for (let i = 0; i < add.count; i++) {
      if (add.cell[i] !== spriteCell('streak')) continue;
      sparks++;
      expect(add.pnz[i]).toBe(1);
      expect(add.pd[i]).toBeCloseTo(3, 5);
      expect(add.floorY[i]).toBe(0);
      expect(add.r0[i]).toBeGreaterThan(1); // HDR
    }
    expect(sparks).toBeGreaterThanOrEqual(4);
    expect(presetCollides(preset)).toBe(true);
    expect(presetCollides(VFX_EFFECTS['land.heavy'])).toBe(false);
  });

  it('mirrors the shot at the surface for ricochets, falling back to the normal', () => {
    const out = { x: 0, y: 0, z: 0 };
    // 45° onto a floor: skims on at 45° upwards.
    reflectDirection(1, -1, 0, 0, 1, 0, out);
    expect(out.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(out.y).toBeCloseTo(Math.SQRT1_2, 6);
    // Head-on: straight back out; unknown / exiting shots: the normal.
    reflectDirection(0, 0, -3, 0, 0, 1, out);
    expect(out.z).toBeCloseTo(1, 6);
    reflectDirection(0, 0, 0, 0, 0, 1, out);
    expect(out).toEqual({ x: 0, y: 0, z: 1 });
    reflectDirection(0, 0, 1, 0, 0, 1, out);
    expect(out).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("emits 'reflect' emitters along the ricochet, others along the normal", () => {
    const add = new ParticleBuffer(512, PARAMS);
    const alpha = new ParticleBuffer(512, PARAMS);
    const ctx = createEmitContext();
    ctx.nx = 0;
    ctx.ny = 0;
    ctx.nz = 1;
    // Grazing shot along -X onto a wall facing +Z: ricochet runs along -X.
    const r = reflectDirection(-1, 0, -0.2, 0, 0, 1, { x: 0, y: 0, z: 0 });
    expect(r.x).toBeLessThan(-0.9);
    ctx.rx = r.x;
    ctx.ry = r.y;
    ctx.rz = r.z;
    emitPreset(VFX_EFFECTS['impact.metal'], ctx, add, alpha, mulberry32(5));
    let sparks = 0;
    let along = 0;
    for (let i = 0; i < add.count; i++) {
      if (add.cell[i] !== spriteCell('streak')) continue;
      sparks++;
      const v = Math.hypot(add.vx[i]!, add.vy[i]!, add.vz[i]!);
      if (add.vx[i]! / v < -0.3) along++;
    }
    expect(sparks).toBeGreaterThan(0);
    expect(along / sparks).toBeGreaterThan(0.8);
    // Dust keeps to the normal.
    for (let i = 0; i < alpha.count; i++) {
      if (alpha.cell[i] === spriteCell('smoke')) expect(alpha.vz[i]).toBeGreaterThan(0);
    }
  });

  it('tints only elemental emitters', () => {
    const add = new ParticleBuffer(1024, PARAMS);
    const alpha = new ParticleBuffer(1024, PARAMS);
    const ctx = createEmitContext();
    ctx.tint = [0, 0, 1];
    ctx.tintStrength = 1;
    emitPreset(VFX_EFFECTS['explosion.frag'], ctx, add, alpha, mulberry32(4));
    for (let i = 0; i < add.count; i++) {
      if (add.cell[i] === spriteCell('flame')) {
        expect(add.r0[i]).toBe(0);
        expect(add.b0[i]).toBeGreaterThan(0);
      }
    }
    // Smoke is not elemental: stays grey.
    for (let i = 0; i < alpha.count; i++) {
      if (alpha.cell[i] === spriteCell('smoke')) expect(alpha.r0[i]).toBeGreaterThan(0);
    }
  });

  it('emits nothing with particles off', () => {
    const add = new ParticleBuffer(64, PARAMS);
    const alpha = new ParticleBuffer(64, PARAMS);
    const ctx = createEmitContext();
    ctx.budget = 0;
    expect(emitPreset(VFX_EFFECTS['explosion.frag'], ctx, add, alpha, mulberry32(1))).toBe(0);
  });
});
