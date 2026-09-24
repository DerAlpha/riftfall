/**
 * Shared state of the arsenal renderers (projectiles, beams, fields): the per-frame draw batches,
 * particle / preset spawning, pooled lights and quality knobs, plus small helpers that turn def
 * data (glow layers, sustained lights) into draw calls. Allocation-free.
 */
import type { PhysicsApi, RaycastOptions } from '../../core/contracts';
import type { Vec3Like } from '../../core/events';
import { ARSENAL_VFX, type GlowLayerDef, type SustainLightDef } from '../../defs/arsenalVfx';
import { interactionGroups } from '../../defs/physics';
import { VFX, type LightFlashDef } from '../../defs/vfx';
import type { Rand } from '../emit';
import type { LightPool } from '../LightPool';
import type { ParticleSystem } from '../ParticleSystem';
import type { BodyMeshes } from './BodyMeshes';
import type { DiscBatch } from './DiscBatch';
import { glowShapeIndex, type GlowSprites } from './GlowSprites';
import type { StripBatch } from './StripBatch';

/** Spawns an effect preset (VfxSystem.spawn semantics: unknown ids are ignored). */
export type EffectSpawner = (effect: string, position: Vec3Like, normal: Vec3Like, scale: number) => void;

/**
 * Screen-space lens sink (RenderSystem.setLens): `slot` < ARSENAL_VFX.lenses; strength 0 turns a
 * slot off.
 */
export type LensSink = (slot: number, position: Vec3Like, radius: number, strength: number) => void;

export interface ArsenalContext {
  readonly glows: GlowSprites;
  readonly dark: GlowSprites;
  readonly strips: StripBatch;
  readonly discs: DiscBatch;
  readonly bodies: BodyMeshes;
  readonly particles: ParticleSystem | null;
  readonly spawn: EffectSpawner;
  readonly lights: LightPool | null;
  readonly physics: PhysicsApi | null;
  readonly rand: Rand;
  /** Particle quality budget multiplier (0 = particles off). */
  budget: number;
  /** Reduce-flashing multiplier for glows, beams and lights. */
  flashScale: number;
  /** Seconds since construction (animated patterns). */
  time: number;
  /** Lens requests of this frame (x, y, z, radius, strength per entry). */
  readonly lensQueue: Float32Array;
  lensCount: number;
}

export const LENS_STRIDE = 5;

export function createLensQueue(): Float32Array {
  return new Float32Array(ARSENAL_VFX.lenses * LENS_STRIDE);
}

/** Queue a screen lens for this frame (dropped when all slots are taken). */
export function requestLens(ctx: ArsenalContext, p: Vec3Like, radius: number, strength: number): void {
  if (ctx.lensCount >= ARSENAL_VFX.lenses || !(radius > 0) || !(strength > 0)) return;
  const o = ctx.lensCount++ * LENS_STRIDE;
  const q = ctx.lensQueue;
  q[o] = p.x;
  q[o + 1] = p.y;
  q[o + 2] = p.z;
  q[o + 3] = radius;
  q[o + 4] = strength;
}

/** Pulse factor of a glow layer at time t (s). */
export function pulseFactor(layer: GlowLayerDef, t: number): number {
  const p = layer.pulse;
  if (!p) return 1;
  if (p.square) {
    const phase = t * p.rate - Math.floor(t * p.rate);
    return phase < 0.5 ? 1 : 1 - p.depth;
  }
  return 1 - p.depth * (0.5 + 0.5 * Math.sin(t * p.rate * Math.PI * 2));
}

/**
 * Draw one glow layer at (x, y, z), `dir` the unit flight/beam direction (offsets, stretch),
 * `speed` m/s for velocity stretch, `age` for animation/pulse, `scale` on the size, `fade` on the
 * brightness / coverage.
 */
export function pushGlow(
  ctx: ArsenalContext,
  layer: GlowLayerDef,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  speed: number,
  age: number,
  seed: number,
  scale: number,
  fade: number,
): void {
  const off = (layer.offset ?? 0) * scale;
  const px = x + dx * off;
  const py = y + dy * off;
  const pz = z + dz * off;
  const size = layer.size * scale;
  const rot = seed * Math.PI * 2 + (layer.spin ?? 0) * age;
  const shape = glowShapeIndex(layer.shape);
  if (layer.blend === 'dark') {
    ctx.dark.push(px, py, pz, size, shape, 0, 0, 0, Math.min(1, fade), seed, age, rot);
    return;
  }
  const k = layer.intensity * pulseFactor(layer, age + seed) * fade * ctx.flashScale;
  if (!(k > 0)) return;
  const stretch = layer.stretch ? Math.min(layer.maxStretch ?? Infinity, speed * layer.stretch) * scale : 0;
  ctx.glows.push(
    px,
    py,
    pz,
    size,
    shape,
    layer.color[0] * k,
    layer.color[1] * k,
    layer.color[2] * k,
    1,
    seed,
    age + seed * 10,
    rot,
    dx,
    dy,
    dz,
    stretch,
  );
}

/** Light flash defs for sustained lights (built once per def, never per frame). */
const flashDefs = new WeakMap<SustainLightDef, LightFlashDef>();

export function flashDefOf(def: SustainLightDef, priority: 0 | 1 | 2): LightFlashDef {
  let f = flashDefs.get(def);
  if (!f) {
    f = {
      color: def.color,
      intensity: def.intensity,
      range: def.range,
      duration: def.interval * SUSTAIN_DECAY,
      priority,
      offset: def.offset ?? 0,
    };
    flashDefs.set(def, f);
  }
  return f;
}

/** A sustained light's flash decays over interval × this (overlapping re-flashes = soft flicker). */
export const SUSTAIN_DECAY = 1.6;

/** Timer + light handle of one lasting effect's light. */
export interface SustainState {
  timer: number;
  handle: number;
}

export function createSustainState(): SustainState {
  return { timer: 0, handle: 0 };
}

/** Advance a sustained light by dt and re-flash it when due. `scale` multiplies the intensity. */
export function sustainLight(
  ctx: ArsenalContext,
  state: SustainState,
  def: SustainLightDef | null,
  priority: 0 | 1 | 2,
  dt: number,
  position: Vec3Like,
  normal: Vec3Like | null,
  scale: number,
): void {
  if (!def || !ctx.lights || !(scale > 0)) return;
  state.timer -= dt;
  if (state.timer > 0) return;
  state.timer = def.interval;
  state.handle = ctx.lights.sustain(state.handle, flashDefOf(def, priority), position, normal, scale);
}

/** Physics probes of the arsenal (floor under fields): static world + props only. */
export const PROBE_OPTS: RaycastOptions = {
  groups: interactionGroups(VFX.probe.membership, VFX.probe.filter),
};
