/**
 * Beam visuals: continuous beams refreshed every frame (lightning with chain arcs, flamethrower
 * cone, void ray) and one-shot rays that linger and fade (railgun slug, void shots).
 *
 * Continuous beams have no handle: every beam() call of a frame takes a channel (the same visual
 * keeps its channel from frame to frame, so its flicker timers and emission accumulators carry
 * over); channels not refreshed in a frame go dark. Lightning shapes are re-rolled at the style's
 * rerollRate from a per-channel random table, so a bolt holds its shape between rolls while its
 * endpoints follow the muzzle and the target. Flames are particles launched so that they die at
 * the beam's end (linear drag solved per particle), over an always-drawn hot core strip.
 */
import type { Vec3Like } from '../../core/events';
import {
  ARSENAL_VFX,
  DEFAULT_BEAM_STYLE,
  DEFAULT_RAY_STYLE,
  getBeamStyle,
  type BeamStyleDef,
  type BoltDef,
  type FlameBeamDef,
  type LightningBeamDef,
  type RayBeamDef,
  type SustainLightDef,
} from '../../defs/arsenalVfx';
import { VFX } from '../../defs/vfx';
import { spriteCell } from '../atlas';
import { lerpRange, sampleCone, type Vec3Out } from '../emit';
import { createParticleSpawn } from '../ParticleBuffer';
import {
  createSustainState,
  pushGlow,
  requestHaze,
  sustainLight,
  type ArsenalContext,
  type SustainState,
} from './context';
import { stripStyleIndex } from './StripBatch';

/** Random numbers per channel re-rolled with the flicker (bolt shapes, branches, arcs). */
const RND = 256;
const RND_BRANCH = 160;
const RND_ARC = 200;
const MAX_ARC_SEGMENTS = 24;

const _p = { x: 0, y: 0, z: 0 };
const _n = { x: 0, y: 0, z: 0 };
const _fwd = { x: 0, y: 0, z: 0 };
const _dir: Vec3Out = { x: 0, y: 0, z: 0 };
const _u = { x: 0, y: 0, z: 0 };
const _w = { x: 0, y: 0, z: 0 };
const spawn = createParticleSpawn();
const FLAME_CELL = spriteCell('flame');
/** Scratch polylines (x, y, z per vertex): the main bolt, and forks / arcs built off it. */
const bolt = new Float32Array((ARSENAL_VFX.beams.maxSegments + 1) * 3);
const fork = new Float32Array((ARSENAL_VFX.beams.maxSegments + 1) * 3);

/**
 * Jagged bolt from a to b with `segs` segments into `out` (xyz per vertex, segs + 1 vertices):
 * per-vertex jitter mixed with two low-frequency bends from `rnd` (starting at `r0`), enveloped
 * so both ends stay put. `tipFree`: the far end is free (branches), the envelope grows instead.
 * Pure (unit-tested).
 */
export function buildBolt(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  segs: number,
  amplitude: number,
  rnd: Float32Array,
  r0: number,
  tipFree: boolean,
  out: Float32Array,
): number {
  const n = Math.max(1, Math.min(segs, Math.floor(out.length / 3) - 1));
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  basis(dx, dy, dz, len, _u, _w);
  const m = rnd.length;
  const ph0 = rnd[r0 % m]! * Math.PI * 2;
  const ph1 = rnd[(r0 + 1) % m]! * Math.PI * 2;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const env = tipFree ? Math.sin((t * Math.PI) / 2) : Math.pow(Math.sin(t * Math.PI), 0.75);
    const j = (r0 + 2 + i * 2) % m;
    const du = (rnd[j]! * 2 - 1) * 0.6 + Math.sin(t * Math.PI * 2 + ph0) * 0.4;
    const dv = (rnd[(j + 1) % m]! * 2 - 1) * 0.6 + Math.sin(t * Math.PI * 3 + ph1) * 0.4;
    const k = amplitude * env;
    const o = i * 3;
    out[o] = ax + dx * t + (_u.x * du + _w.x * dv) * k;
    out[o + 1] = ay + dy * t + (_u.y * du + _w.y * dv) * k;
    out[o + 2] = az + dz * t + (_u.z * du + _w.z * dv) * k;
  }
  return n;
}

/** Orthonormal u, w perpendicular to the direction (dx, dy, dz) of length len. */
function basis(
  dx: number,
  dy: number,
  dz: number,
  len: number,
  u: { x: number; y: number; z: number },
  w: { x: number; y: number; z: number },
): void {
  const il = len > 1e-6 ? 1 / len : 0;
  const fx = dx * il;
  const fy = len > 1e-6 ? dy * il : 1;
  const fz = dz * il;
  // u = f × up (or f × x for vertical beams)
  let ux = Math.abs(fy) < 0.95 ? -fz : 0;
  let uy = Math.abs(fy) < 0.95 ? 0 : fz;
  let uz = Math.abs(fy) < 0.95 ? fx : -fy;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  u.x = ux;
  u.y = uy;
  u.z = uz;
  w.x = fy * uz - fz * uy;
  w.y = fz * ux - fx * uz;
  w.z = fx * uy - fy * ux;
}

/** Stamp of a channel that has not been drawn for ages (free). */
const NEVER = -1e9;

class BeamChannel {
  visual = '';
  style: BeamStyleDef = DEFAULT_BEAM_STYLE;
  /** Epoch of the last beam() call (drawn while it equals the current epoch). */
  stamp = NEVER;
  /** Epoch in which this channel was taken (one call per channel and frame). */
  used = NEVER;
  readonly from = { x: 0, y: 0, z: 0 };
  readonly to = { x: 0, y: 0, z: 0 };
  readonly arcs = new Float32Array(ARSENAL_VFX.beams.maxArcs * 6);
  arcCount = 0;
  readonly rnd = new Float32Array(RND);
  rerollTimer = 0;
  hitAcc = 0;
  arcAcc = 0;
  emitAcc = 0;
  muzzleAcc = 0;
  age = 0;
  seed = 0;
  readonly light: SustainState = createSustainState();
}

class ShotSlot {
  active = false;
  style: RayBeamDef = DEFAULT_RAY_STYLE;
  readonly from = { x: 0, y: 0, z: 0 };
  readonly to = { x: 0, y: 0, z: 0 };
  age = 0;
  seed = 0;
}

export class ArsenalBeams {
  private readonly channels: BeamChannel[] = [];
  private readonly shots: ShotSlot[] = [];
  private epoch = 0;
  private _live = 0;
  /** Beams that took a light this frame (ARSENAL_VFX.beams.lights). */
  private lit = 0;

  constructor(private readonly ctx: ArsenalContext) {
    for (let i = 0; i < ARSENAL_VFX.beams.channels; i++) this.channels.push(new BeamChannel());
    for (let i = 0; i < ARSENAL_VFX.beams.shots; i++) this.shots.push(new ShotSlot());
  }

  /** Beams drawn last frame + fading shots. */
  get live(): number {
    return this._live;
  }

  beam(visual: string, from: Vec3Like, to: Vec3Like, arcs: readonly Vec3Like[], arcCount: number): void {
    if (!finite(from) || !finite(to)) return;
    const ch = this.channelFor(visual);
    if (!ch) return;
    ch.stamp = this.epoch;
    ch.used = this.epoch;
    copy(from, ch.from);
    copy(to, ch.to);
    const n = Math.max(
      0,
      Math.min(ARSENAL_VFX.beams.maxArcs, Math.floor(arcCount), Math.floor(arcs.length / 2)),
    );
    let k = 0;
    for (let i = 0; i < n; i++) {
      const a = arcs[i * 2]!;
      const b = arcs[i * 2 + 1]!;
      if (!finite(a) || !finite(b)) continue;
      const o = k * 6;
      ch.arcs[o] = a.x;
      ch.arcs[o + 1] = a.y;
      ch.arcs[o + 2] = a.z;
      ch.arcs[o + 3] = b.x;
      ch.arcs[o + 4] = b.y;
      ch.arcs[o + 5] = b.z;
      k++;
    }
    ch.arcCount = k;
  }

  /** One-shot ray from → to (railgun slug, void shot): lingers and fades over its style's `fade`. */
  shot(visual: string, from: Vec3Like, to: Vec3Like): void {
    if (!finite(from) || !finite(to)) return;
    const found = getBeamStyle(visual);
    const style = found && found.kind === 'ray' ? found : DEFAULT_RAY_STYLE;
    let slot: ShotSlot | null = null;
    let oldest: ShotSlot | null = null;
    for (const s of this.shots) {
      if (!s.active) {
        slot = s;
        break;
      }
      if (!oldest || s.age > oldest.age) oldest = s;
    }
    slot ??= oldest!;
    slot.active = true;
    slot.style = style;
    copy(from, slot.from);
    copy(to, slot.to);
    slot.age = 0;
    slot.seed = this.ctx.rand();
    // Sparks / motes along the whole ray, once.
    const along = style.along;
    if (along && this.ctx.budget > 0) {
      const len = dist(from, to);
      const count = Math.min(ARSENAL_VFX.beams.maxSegments, Math.floor(len / along.spacing));
      _n.x = 0;
      _n.y = 1;
      _n.z = 0;
      for (let i = 1; i <= count; i++) {
        const t = (i - this.ctx.rand() * 0.5) / (count + 1);
        lerp(from, to, t, _p);
        this.ctx.spawn(along.effect, _p, _n, 1);
      }
    }
  }

  update(dt: number): void {
    const cur = this.epoch;
    let live = 0;
    this.lit = 0;
    for (const ch of this.channels) {
      if (ch.stamp !== cur) {
        ch.light.handle = 0;
        continue;
      }
      ch.age += dt;
      live++;
      const style = ch.style;
      if (style.kind === 'lightning') this.drawLightning(ch, style, dt);
      else if (style.kind === 'flame') this.drawFlame(ch, style, dt);
      else this.drawRay(ch, style, dt);
    }
    for (const s of this.shots) {
      if (!s.active) continue;
      s.age += dt;
      if (s.age >= s.style.fade) {
        s.active = false;
        continue;
      }
      live++;
      this.drawShot(s);
    }
    this._live = live;
    this.epoch++;
  }

  clear(): void {
    for (const ch of this.channels) {
      ch.stamp = NEVER;
      ch.used = NEVER;
      ch.visual = '';
      ch.light.handle = 0;
    }
    for (const s of this.shots) s.active = false;
    this._live = 0;
  }

  // -------------------------------------------------------------------------

  private channelFor(visual: string): BeamChannel | null {
    const cur = this.epoch;
    let free: BeamChannel | null = null;
    for (const ch of this.channels) {
      if (ch.used === cur) continue;
      // Continuity: the same visual drawn last frame keeps its channel (and its timers).
      if (ch.visual === visual && ch.stamp >= cur - 1) return ch;
      if (!free && ch.stamp < cur - 1) free = ch;
    }
    if (!free) return null;
    free.visual = visual;
    free.style = getBeamStyle(visual) ?? DEFAULT_BEAM_STYLE;
    free.rerollTimer = 0;
    free.hitAcc = 0;
    free.arcAcc = 0;
    free.emitAcc = 0;
    free.muzzleAcc = 0;
    free.age = 0;
    free.seed = this.ctx.rand();
    free.light.timer = 0;
    free.light.handle = 0;
    return free;
  }

  private reroll(ch: BeamChannel, rate: number, dt: number): void {
    ch.rerollTimer -= dt;
    if (ch.rerollTimer > 0) return;
    ch.rerollTimer = rate > 0 ? 1 / rate : Number.POSITIVE_INFINITY;
    const r = this.ctx.rand;
    for (let i = 0; i < RND; i++) ch.rnd[i] = r();
  }

  private drawLightning(ch: BeamChannel, s: LightningBeamDef, dt: number): void {
    const ctx = this.ctx;
    this.reroll(ch, s.rerollRate, dt);
    const f = ch.from;
    const t = ch.to;
    const len = dist(f, t);
    if (len < 1e-3) return;
    const flicker = 0.8 + 0.4 * ch.rnd[RND - 1]!;
    const b = s.bolt;
    const segs = clampSegs(len / b.segmentLength, b.minSegments, ARSENAL_VFX.beams.maxSegments);
    const n = buildBolt(
      f.x,
      f.y,
      f.z,
      t.x,
      t.y,
      t.z,
      segs,
      Math.max(b.jitterMin, len * b.jitter),
      ch.rnd,
      0,
      false,
      bolt,
    );
    this.emitBolt(bolt, n, b, s.haloColor, flicker, 1, 1, ch.seed);
    // Forks off the main bolt.
    const br = s.branches;
    if (len > 1.5) {
      const dx = (t.x - f.x) / len;
      const dy = (t.y - f.y) / len;
      const dz = (t.z - f.z) / len;
      basis(dx, dy, dz, 1, _u, _w);
      for (let k = 0; k < br.count; k++) {
        const r = RND_BRANCH + k * 5;
        const root = 1 + Math.floor(ch.rnd[r]! * (n - 2));
        const phi = ch.rnd[r + 1]! * Math.PI * 2;
        const tilt = 0.35 + ch.rnd[r + 2]! * 0.55;
        const bl = len * lerpRange(br.length, ch.rnd[r + 3]!);
        const o = root * 3;
        const rx = bolt[o]!;
        const ry = bolt[o + 1]!;
        const rz = bolt[o + 2]!;
        const c = Math.cos(tilt);
        const sn = Math.sin(tilt);
        const ex = rx + (dx * c + (_u.x * Math.cos(phi) + _w.x * Math.sin(phi)) * sn) * bl;
        const ey = ry + (dy * c + (_u.y * Math.cos(phi) + _w.y * Math.sin(phi)) * sn) * bl;
        const ez = rz + (dz * c + (_u.z * Math.cos(phi) + _w.z * Math.sin(phi)) * sn) * bl;
        const bn = buildBolt(rx, ry, rz, ex, ey, ez, br.segments, bl * 0.3, ch.rnd, r + 4, true, fork);
        this.emitBolt(fork, bn, b, s.haloColor, flicker * 0.75, 0.55, 0, ch.seed + k);
      }
    }
    _n.x = f.x - t.x;
    _n.y = f.y - t.y;
    _n.z = f.z - t.z;
    const inv = 1 / len;
    _n.x *= inv;
    _n.y *= inv;
    _n.z *= inv;
    pushGlow(ctx, s.muzzleGlow, f.x, f.y, f.z, -_n.x, -_n.y, -_n.z, 0, ch.age, ch.seed, 1, flicker);
    _fwd.x = -_n.x;
    _fwd.y = -_n.y;
    _fwd.z = -_n.z;
    this.muzzleSparks(ch, s.muzzleEffect, s.muzzleRate, f, _fwd, dt);
    pushGlow(ctx, s.hitGlow, t.x, t.y, t.z, _n.x, _n.y, _n.z, 0, ch.age, ch.seed, 1, flicker);
    // Chain arcs.
    const a = s.arc;
    for (let i = 0; i < ch.arcCount; i++) {
      const o = i * 6;
      const ax = ch.arcs[o]!;
      const ay = ch.arcs[o + 1]!;
      const az = ch.arcs[o + 2]!;
      const bx = ch.arcs[o + 3]!;
      const by = ch.arcs[o + 4]!;
      const bz = ch.arcs[o + 5]!;
      const al = Math.hypot(bx - ax, by - ay, bz - az);
      if (al < 1e-3) continue;
      const as = clampSegs(al / a.segmentLength, a.minSegments, MAX_ARC_SEGMENTS);
      const an = buildBolt(
        ax,
        ay,
        az,
        bx,
        by,
        bz,
        as,
        Math.max(a.jitterMin, al * a.jitter),
        ch.rnd,
        RND_ARC + i * 7,
        false,
        fork,
      );
      this.emitBolt(fork, an, a, s.haloColor, flicker, 1, 1, ch.seed + 7 + i);
      pushGlow(ctx, s.hitGlow, bx, by, bz, 0, 1, 0, 0, ch.age, ch.seed + i, 0.7, flicker);
    }
    // Sparks where it bites, a flickering light on the target.
    ch.hitAcc += dt * s.hitRate;
    while (ch.hitAcc >= 1) {
      ch.hitAcc -= 1;
      ctx.spawn(s.hitEffect, t, _n, 1);
    }
    if (ch.arcCount > 0) {
      ch.arcAcc += dt * s.arcRate * ch.arcCount;
      while (ch.arcAcc >= 1) {
        ch.arcAcc -= 1;
        const i = Math.floor(ctx.rand() * ch.arcCount) * 6;
        _p.x = ch.arcs[i + 3]!;
        _p.y = ch.arcs[i + 4]!;
        _p.z = ch.arcs[i + 5]!;
        ctx.spawn(s.hitEffect, _p, _n, 0.7);
      }
    }
    this.light(ch, s.light, dt, t, _n);
  }

  /** Continuous muzzle emission along the beam direction `dir` at `rate` spawns per second. */
  private muzzleSparks(
    ch: BeamChannel,
    effect: string,
    rate: number,
    at: Vec3Like,
    dir: Vec3Like,
    dt: number,
  ): void {
    if (!(rate > 0) || !(this.ctx.budget > 0)) return;
    ch.muzzleAcc += dt * rate;
    let n = 0;
    while (ch.muzzleAcc >= 1 && n++ < 3) {
      ch.muzzleAcc -= 1;
      this.ctx.spawn(effect, at, dir, 1);
    }
    if (ch.muzzleAcc > 1) ch.muzzleAcc = 1;
  }

  /** Halo + core strips over a bolt polyline (n segments). `tipAlpha`: opacity at the far end. */
  private emitBolt(
    pts: Float32Array,
    n: number,
    b: BoltDef,
    halo: readonly [number, number, number],
    flicker: number,
    widthScale: number,
    tipAlpha: number,
    seed: number,
  ): void {
    const strips = this.ctx.strips;
    const k = this.ctx.flashScale * flicker;
    const hk = b.haloIntensity * k;
    strips.beginStrip(stripStyleIndex('glow'), seed);
    for (let i = 0; i <= n; i++) {
      const o = i * 3;
      const a = 1 + (tipAlpha - 1) * (i / n);
      strips.point(
        pts[o]!,
        pts[o + 1]!,
        pts[o + 2]!,
        b.width * b.haloWidth * widthScale,
        halo[0] * hk,
        halo[1] * hk,
        halo[2] * hk,
        a,
      );
    }
    strips.endStrip();
    const ck = b.intensity * k;
    strips.beginStrip(stripStyleIndex('electric'), seed);
    for (let i = 0; i <= n; i++) {
      const o = i * 3;
      const a = 1 + (tipAlpha - 1) * (i / n);
      strips.point(
        pts[o]!,
        pts[o + 1]!,
        pts[o + 2]!,
        b.width * widthScale,
        b.color[0] * ck,
        b.color[1] * ck,
        b.color[2] * ck,
        a,
      );
    }
    strips.endStrip();
  }

  private drawFlame(ch: BeamChannel, s: FlameBeamDef, dt: number): void {
    const ctx = this.ctx;
    const f = ch.from;
    const t = ch.to;
    const len = dist(f, t);
    if (len < 1e-3) return;
    const dx = (t.x - f.x) / len;
    const dy = (t.y - f.y) / len;
    const dz = (t.z - f.z) / len;
    const k = ctx.flashScale;
    // Particles: launched so linear drag brings them to rest at the beam end as they die.
    const buf = ctx.particles?.additiveBuffer;
    if (buf && ctx.budget > 0) {
      ch.emitAcc += dt * s.rate * ctx.budget;
      const cosMax = Math.cos((s.spreadDeg * Math.PI) / 180);
      let guard = 0;
      while (ch.emitAcc >= 1 && guard++ < ARSENAL_VFX.beams.maxFlameSpawnsPerFrame) {
        ch.emitAcc -= 1;
        const r = ctx.rand;
        sampleCone(dx, dy, dz, cosMax, r(), r(), _dir);
        const life = lerpRange(s.life, r());
        const reach = len * lerpRange(s.reach, r());
        const drag = s.drag;
        const speed = (reach * drag) / (1 - Math.exp(-drag * life));
        const lead = r() * 0.15;
        spawn.x = f.x + dx * lead;
        spawn.y = f.y + dy * lead;
        spawn.z = f.z + dz * lead;
        spawn.vx = _dir.x * speed;
        spawn.vy = _dir.y * speed;
        spawn.vz = _dir.z * speed;
        spawn.life = life;
        spawn.size0 = lerpRange(s.size, r());
        spawn.size1 = spawn.size0 * s.sizeEnd;
        const i0 = s.intensity * k;
        const i1 = s.intensityEnd * k;
        spawn.r0 = s.color[0] * i0;
        spawn.g0 = s.color[1] * i0;
        spawn.b0 = s.color[2] * i0;
        spawn.r1 = s.colorEnd[0] * i1;
        spawn.g1 = s.colorEnd[1] * i1;
        spawn.b1 = s.colorEnd[2] * i1;
        // Opaque to the end of its life (the colour cools down), dissolving over the last third.
        spawn.a0 = 1;
        spawn.a1 = 1;
        spawn.fadeIn = 0.06;
        spawn.fadeOut = 0.35;
        spawn.gravity = s.gravity * VFX.particles.gravity;
        spawn.drag = drag;
        spawn.rotation = r() * Math.PI * 2;
        spawn.spin = (r() * 2 - 1) * 3;
        spawn.stretch = s.stretch;
        spawn.cell = FLAME_CELL;
        spawn.bounce = -1;
        spawn.planeNx = spawn.planeNy = spawn.planeNz = spawn.planeD = 0;
        spawn.floorY = Number.NEGATIVE_INFINITY;
        buf.spawn(spawn);
      }
      if (ch.emitAcc > 1) ch.emitAcc = 1;
    }
    // Hot core from the nozzle (drawn with particles off, too).
    const c = s.core;
    const coreLen = Math.min(c.length, len);
    const strips = ctx.strips;
    strips.beginStrip(stripStyleIndex('fire'), ch.seed, ch.age * 6, -1);
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const w = c.width + (c.widthEnd - c.width) * u;
      const a = (1 - u) * (1 - u);
      const ck = c.intensity * k;
      strips.point(
        f.x + dx * coreLen * u,
        f.y + dy * coreLen * u,
        f.z + dz * coreLen * u,
        w,
        c.color[0] * ck,
        c.color[1] * ck,
        c.color[2] * ck,
        a,
      );
    }
    strips.endStrip();
    pushGlow(ctx, s.nozzleGlow, f.x, f.y, f.z, -dx, -dy, -dz, 10, ch.age, ch.seed, 1, 1);
    _fwd.x = dx;
    _fwd.y = dy;
    _fwd.z = dz;
    this.muzzleSparks(ch, s.muzzleEffect, s.muzzleRate, f, _fwd, dt);
    _n.x = -dx;
    _n.y = -dy;
    _n.z = -dz;
    ch.hitAcc += dt * s.hitRate;
    while (ch.hitAcc >= 1) {
      ch.hitAcc -= 1;
      ctx.spawn(s.hitEffect, t, _n, 1);
    }
    if (s.haze) requestHaze(ctx, f, t, s.haze.radiusFrom, s.haze.radiusTo, s.haze.strength);
    _p.x = f.x + dx * len * s.lightAlong;
    _p.y = f.y + dy * len * s.lightAlong;
    _p.z = f.z + dz * len * s.lightAlong;
    this.light(ch, s.light, dt, _p, null);
  }

  private drawRay(ch: BeamChannel, s: RayBeamDef, dt: number): void {
    const ctx = this.ctx;
    const f = ch.from;
    const t = ch.to;
    const len = dist(f, t);
    if (len < 1e-3) return;
    this.rayStrips(s, f, t, 1, 1, ch.seed, ch.age);
    const inv = 1 / len;
    _n.x = (f.x - t.x) * inv;
    _n.y = (f.y - t.y) * inv;
    _n.z = (f.z - t.z) * inv;
    pushGlow(ctx, s.startGlow, f.x, f.y, f.z, -_n.x, -_n.y, -_n.z, 0, ch.age, ch.seed, 1, 1);
    pushGlow(ctx, s.endGlow, t.x, t.y, t.z, _n.x, _n.y, _n.z, 0, ch.age, ch.seed, 1, 1);
    const along = s.along;
    if (along && along.rate > 0 && ctx.budget > 0) {
      ch.emitAcc += dt * along.rate;
      while (ch.emitAcc >= 1) {
        ch.emitAcc -= 1;
        lerp(f, t, ctx.rand(), _p);
        ctx.spawn(along.effect, _p, _n, 1);
      }
    }
    this.light(ch, s.light, dt, t, _n);
  }

  /** A beam's sustained light, for the first ARSENAL_VFX.beams.lights beams of the frame. */
  private light(
    ch: BeamChannel,
    def: SustainLightDef | null,
    dt: number,
    at: Vec3Like,
    normal: Vec3Like | null,
  ): void {
    if (!def || this.lit >= ARSENAL_VFX.beams.lights) return;
    this.lit++;
    sustainLight(this.ctx, ch.light, def, 1, dt, at, normal, this.ctx.flashScale);
  }

  private drawShot(s: ShotSlot): void {
    const style = s.style;
    const k = s.age / style.fade;
    const fade = (1 - k) * (1 - k);
    const widen = 1 + (style.fadeWidth - 1) * Math.sqrt(k);
    this.rayStrips(style, s.from, s.to, fade, widen, s.seed, s.age);
    const len = dist(s.from, s.to);
    if (len < 1e-3) return;
    const inv = 1 / len;
    _n.x = (s.from.x - s.to.x) * inv;
    _n.y = (s.from.y - s.to.y) * inv;
    _n.z = (s.from.z - s.to.z) * inv;
    const early = Math.max(0, 1 - k * 3);
    if (early > 0) {
      pushGlow(
        this.ctx,
        style.startGlow,
        s.from.x,
        s.from.y,
        s.from.z,
        -_n.x,
        -_n.y,
        -_n.z,
        0,
        s.age,
        s.seed,
        1,
        early,
      );
    }
    pushGlow(
      this.ctx,
      style.endGlow,
      s.to.x,
      s.to.y,
      s.to.z,
      _n.x,
      _n.y,
      _n.z,
      0,
      s.age,
      s.seed,
      widen,
      fade,
    );
  }

  /** Halo + core strips of a ray (a few points so the fog term follows the ray). */
  private rayStrips(
    s: RayBeamDef,
    f: Vec3Like,
    t: Vec3Like,
    fade: number,
    widen: number,
    seed: number,
    age: number,
  ): void {
    const strips = this.ctx.strips;
    const k = this.ctx.flashScale * fade;
    const len = dist(f, t);
    const steps = Math.max(2, Math.min(12, Math.ceil(len / 4)));
    const hk = s.haloIntensity * k;
    strips.beginStrip(stripStyleIndex('glow'), seed);
    for (let i = 0; i <= steps; i++) {
      lerp(f, t, i / steps, _p);
      strips.point(
        _p.x,
        _p.y,
        _p.z,
        s.haloWidth * widen,
        s.haloColor[0] * hk,
        s.haloColor[1] * hk,
        s.haloColor[2] * hk,
        1,
      );
    }
    strips.endStrip();
    const ck = s.intensity * k;
    strips.beginStrip(stripStyleIndex(s.style), seed, age * 2);
    for (let i = 0; i <= steps; i++) {
      lerp(f, t, i / steps, _p);
      strips.point(_p.x, _p.y, _p.z, s.width * widen, s.color[0] * ck, s.color[1] * ck, s.color[2] * ck, 1);
    }
    strips.endStrip();
  }
}

function clampSegs(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(n) ? n : min)));
}

function dist(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function lerp(a: Vec3Like, b: Vec3Like, t: number, out: { x: number; y: number; z: number }): void {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
}

function copy(a: Vec3Like, out: { x: number; y: number; z: number }): void {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
}

function finite(v: Vec3Like): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
