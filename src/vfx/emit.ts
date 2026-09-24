/**
 * Emitter sampling: turns an EffectPreset (defs/vfx.ts) into particle spawns. Pure (no three.js):
 * randomness comes from an injected `rand` (Math.random in the game – VFX are cosmetic – and a
 * seeded generator in tests).
 */
import { DEG2RAD, TAU } from '../core/math';
import { VFX, type EffectPreset, type EmitterDef, type Range, type Rgb } from '../defs/vfx';
import { spriteCell } from './atlas';
import { createParticleSpawn, type ParticleBuffer } from './ParticleBuffer';

export type Rand = () => number;

export interface Vec3Out {
  x: number;
  y: number;
  z: number;
}

/** Where and how an effect is emitted. Reuse one object per caller. */
export interface EmitContext {
  x: number;
  y: number;
  z: number;
  /** Unit effect normal (surface normal, aim direction, ...). */
  nx: number;
  ny: number;
  nz: number;
  /** Unit ricochet direction for 'reflect' emitters (the normal when the shot is unknown). */
  rx: number;
  ry: number;
  rz: number;
  /** Effect scale (size, speed, offsets; count ∝ clamp(scale)). */
  scale: number;
  /** Quality budget multiplier (0 = particles off). */
  budget: number;
  /** Collide with the plane through (x, y, z) with normal n (surface impacts). */
  surfacePlane: boolean;
  /** Floor height under the effect (−Infinity = none). */
  floorY: number;
  /** Element tint for `elemental` emitters (null = none). */
  tint: Rgb | null;
  tintStrength: number;
  /** Intensity multiplier of `flash` emitters (reduce-flashing accessibility option). */
  flashScale: number;
}

export function createEmitContext(): EmitContext {
  return {
    x: 0,
    y: 0,
    z: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    rx: 0,
    ry: 1,
    rz: 0,
    scale: 1,
    budget: 1,
    surfacePlane: false,
    floorY: Number.NEGATIVE_INFINITY,
    tint: null,
    tintStrength: 0,
    flashScale: 1,
  };
}

export function lerpRange(r: Range, t: number): number {
  return r[0] + (r[1] - r[0]) * t;
}

/**
 * Uniform random direction inside a cone of half-angle acos(cosMax) around the unit axis `a`
 * (cosMax = -1: full sphere). u1, u2 uniform in [0, 1).
 */
export function sampleCone(
  ax: number,
  ay: number,
  az: number,
  cosMax: number,
  u1: number,
  u2: number,
  out: Vec3Out,
): Vec3Out {
  const cosT = 1 - u1 * (1 - cosMax);
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = u2 * TAU;
  // Orthonormal basis around the axis (branchless Frisvad-style with a sign guard).
  const sign = az >= 0 ? 1 : -1;
  const a = -1 / (sign + az);
  const b = ax * ay * a;
  const t1x = 1 + sign * ax * ax * a;
  const t1y = sign * b;
  const t1z = -sign * ax;
  const t2x = b;
  const t2y = sign + ay * ay * a;
  const t2z = -ay;
  const cx = Math.cos(phi) * sinT;
  const cy = Math.sin(phi) * sinT;
  out.x = t1x * cx + t2x * cy + ax * cosT;
  out.y = t1y * cx + t2y * cy + ay * cosT;
  out.z = t1z * cx + t2z * cy + az * cosT;
  return out;
}

/** Tint toward luminance(color) · tint by `strength` (element explosions). Writes into out[0..2]. */
export function tintColor(
  r: number,
  g: number,
  b: number,
  tint: Rgb,
  strength: number,
  out: Float32Array | number[],
): void {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  out[0] = r + (lum * tint[0] - r) * strength;
  out[1] = g + (lum * tint[1] - g) * strength;
  out[2] = b + (lum * tint[2] - b) * strength;
}

/** Particles to spawn for an emitter: range × budget × clamped scale, at least `minCount` while on. */
export function emitterCount(def: EmitterDef, budget: number, scale: number, u: number): number {
  if (!(budget > 0)) return 0;
  const [lo, hi] = VFX.particles.countScale;
  const countScale = Math.min(hi, Math.max(lo, scale));
  const n = Math.round(lerpRange(def.count, u) * budget * countScale);
  return Math.max(n, def.minCount ?? 0);
}

const _dir: Vec3Out = { x: 0, y: 0, z: 0 };
const _jit: Vec3Out = { x: 0, y: 0, z: 0 };
const _c = [0, 0, 0];
const spawn = createParticleSpawn();

/**
 * Emit every emitter of `preset` into the additive / alpha buffers. Returns the number of
 * particles spawned (spawns beyond a full buffer are dropped).
 */
export function emitPreset(
  preset: EffectPreset,
  ctx: EmitContext,
  additive: ParticleBuffer,
  alpha: ParticleBuffer,
  rand: Rand,
): number {
  let spawned = 0;
  const scale = ctx.scale > 0 ? ctx.scale : 1;
  const planeD = ctx.x * ctx.nx + ctx.y * ctx.ny + ctx.z * ctx.nz;
  for (const def of preset.emitters) {
    const buffer = def.blend === 'add' ? additive : alpha;
    const n = emitterCount(def, ctx.budget, scale, rand());
    if (n <= 0) continue;
    let ax = ctx.nx;
    let ay = ctx.ny;
    let az = ctx.nz;
    if (def.axis === 'up') {
      ax = 0;
      ay = 1;
      az = 0;
    } else if (def.axis === 'reflect') {
      ax = ctx.rx;
      ay = ctx.ry;
      az = ctx.rz;
    } else if (def.axis === 'down') {
      ax = 0;
      ay = -1;
      az = 0;
    }
    const cosMax = Math.cos(Math.min(180, Math.max(0, def.spread)) * DEG2RAD);
    const offset = (def.offset ?? 0) * scale;
    const jitter = (def.jitter ?? 0) * scale;
    const shell = (def.shell ?? 0) * scale;
    const flashK = def.flash === true ? ctx.flashScale : 1;
    const intensity = (def.intensity ?? 1) * flashK;
    const intensityEnd = (def.intensityEnd ?? def.intensity ?? 1) * flashK;
    const colorEnd = def.colorEnd ?? def.color;
    const tinted = def.elemental === true && ctx.tint !== null && ctx.tintStrength > 0;
    const sizeEnd = def.sizeEnd ?? 1;
    const gravity = (def.gravity ?? 0) * VFX.particles.gravity;
    const cell = spriteCell(def.sprite);
    const bounce = def.bounce ?? -1;

    for (let k = 0; k < n; k++) {
      sampleCone(ax, ay, az, cosMax, rand(), rand(), _dir);
      const speed = lerpRange(def.speed, rand()) * scale;
      let jx = 0;
      let jy = 0;
      let jz = 0;
      if (jitter > 0) {
        sampleCone(0, 1, 0, -1, rand(), rand(), _jit);
        const r = jitter * Math.cbrt(rand());
        jx = _jit.x * r;
        jy = _jit.y * r;
        jz = _jit.z * r;
      }
      spawn.x = ctx.x + ax * offset + jx + _dir.x * shell;
      spawn.y = ctx.y + ay * offset + jy + _dir.y * shell;
      spawn.z = ctx.z + az * offset + jz + _dir.z * shell;
      spawn.vx = _dir.x * speed;
      spawn.vy = _dir.y * speed;
      spawn.vz = _dir.z * speed;
      spawn.life = lerpRange(def.life, rand());
      spawn.size0 = lerpRange(def.size, rand()) * scale;
      spawn.size1 = spawn.size0 * sizeEnd;
      if (tinted) {
        tintColor(def.color[0], def.color[1], def.color[2], ctx.tint!, ctx.tintStrength, _c);
        spawn.r0 = _c[0]! * intensity;
        spawn.g0 = _c[1]! * intensity;
        spawn.b0 = _c[2]! * intensity;
        tintColor(colorEnd[0], colorEnd[1], colorEnd[2], ctx.tint!, ctx.tintStrength, _c);
        spawn.r1 = _c[0]! * intensityEnd;
        spawn.g1 = _c[1]! * intensityEnd;
        spawn.b1 = _c[2]! * intensityEnd;
      } else {
        spawn.r0 = def.color[0] * intensity;
        spawn.g0 = def.color[1] * intensity;
        spawn.b0 = def.color[2] * intensity;
        spawn.r1 = colorEnd[0] * intensityEnd;
        spawn.g1 = colorEnd[1] * intensityEnd;
        spawn.b1 = colorEnd[2] * intensityEnd;
      }
      spawn.a0 = def.alpha ?? 1;
      spawn.a1 = def.alphaEnd ?? 0;
      spawn.fadeIn = def.fadeIn ?? 0;
      spawn.fadeOut = def.fadeOut ?? 0;
      spawn.gravity = gravity;
      spawn.drag = def.drag ?? 0;
      spawn.rotation = rand() * TAU;
      spawn.spin = def.spin ? lerpRange(def.spin, rand()) : 0;
      spawn.stretch = def.stretch ?? 0;
      spawn.cell = cell;
      spawn.bounce = bounce;
      if (ctx.surfacePlane && bounce >= 0) {
        spawn.planeNx = ctx.nx;
        spawn.planeNy = ctx.ny;
        spawn.planeNz = ctx.nz;
        spawn.planeD = planeD;
      } else {
        spawn.planeNx = spawn.planeNy = spawn.planeNz = spawn.planeD = 0;
      }
      spawn.floorY = ctx.floorY;
      if (buffer.spawn(spawn)) spawned++;
    }
  }
  return spawned;
}

/**
 * Ricochet direction of a shot travelling along `d` off a surface with unit normal `n`, written
 * into out: d mirrored at the surface. Falls back to n when d is degenerate or does not run into
 * the surface (exit points of penetrating shots).
 */
export function reflectDirection(
  dx: number,
  dy: number,
  dz: number,
  nx: number,
  ny: number,
  nz: number,
  out: Vec3Out,
): Vec3Out {
  const len = Math.hypot(dx, dy, dz);
  const dn = len > 1e-8 ? (dx * nx + dy * ny + dz * nz) / len : 0;
  if (!(dn < -1e-4)) {
    out.x = nx;
    out.y = ny;
    out.z = nz;
    return out;
  }
  out.x = dx / len - 2 * dn * nx;
  out.y = dy / len - 2 * dn * ny;
  out.z = dz / len - 2 * dn * nz;
  return out;
}

/** True when any emitter of the preset collides (the caller then probes for the floor). */
export function presetCollides(preset: EffectPreset): boolean {
  for (const e of preset.emitters) if ((e.bounce ?? -1) >= 0) return true;
  return false;
}
