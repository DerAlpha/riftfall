/**
 * CPU particle simulation over compact struct-of-arrays typed arrays (no per-particle objects,
 * no allocation after construction). Alive particles are always packed in [0, count): a dying
 * particle is replaced by the last one (swap-remove), so iteration and GPU upload are linear.
 *
 * Integration per step: gravity → drag (exact exponential) → position → collision against
 * (a) the plane of the surface the particle was spawned from and (b) a floor height found by
 * one probe ray per effect. Both are cheap and keep sparks/debris from falling through the
 * geometry they come from; resting particles stop and keep fading.
 *
 * Spawn frame: particles spawned since the last endFrame() can be held (update(dt, true)), so an
 * effect is first drawn in its spawn state – a 50 ms impact flash would otherwise lose a third
 * (60 Hz) to two thirds (30 Hz) of its brightness before it is ever seen.
 *
 * No three.js import: the GPU side (ParticleSystem) reads the arrays via writeInstances().
 */

const SORT_EMPTY = 0xffffffff;

/** Spawn parameters; reuse one object for all spawns (spawn() copies the values). */
export interface ParticleSpawn {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size0: number;
  size1: number;
  /** HDR start / end color (intensity already applied). */
  r0: number;
  g0: number;
  b0: number;
  r1: number;
  g1: number;
  b1: number;
  a0: number;
  a1: number;
  /** Fraction of life spent fading in / out (0 = none). */
  fadeIn: number;
  fadeOut: number;
  /** Gravity acceleration (m/s², positive pulls down). */
  gravity: number;
  drag: number;
  rotation: number;
  spin: number;
  /** Velocity stretch (s), 0 = rotated billboard. */
  stretch: number;
  /** Atlas cell index. */
  cell: number;
  /** Restitution; negative = no collision. */
  bounce: number;
  /** Collision plane n·p = d (n zero = none). */
  planeNx: number;
  planeNy: number;
  planeNz: number;
  planeD: number;
  /** Floor height (−Infinity = none). */
  floorY: number;
}

export function createParticleSpawn(): ParticleSpawn {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    life: 1,
    size0: 0.1,
    size1: 0.1,
    r0: 1,
    g0: 1,
    b0: 1,
    r1: 1,
    g1: 1,
    b1: 1,
    a0: 1,
    a1: 0,
    fadeIn: 0,
    fadeOut: 0,
    gravity: 0,
    drag: 0,
    rotation: 0,
    spin: 0,
    stretch: 0,
    cell: 0,
    bounce: -1,
    planeNx: 0,
    planeNy: 0,
    planeNz: 0,
    planeD: 0,
    floorY: Number.NEGATIVE_INFINITY,
  };
}

/** Per-instance output arrays (GPU attribute backing stores). */
export interface ParticleInstanceArrays {
  /** xyz = position, w = size. */
  pos: Float32Array;
  /** rgb = HDR color, a = opacity. */
  color: Float32Array;
  /** x = rotation, y = atlas cell, z = stretch (s). */
  misc: Float32Array;
  /** xyz = velocity (for stretched particles). */
  vel: Float32Array;
}

export interface ParticleSimParams {
  /** Tangential velocity kept per bounce. */
  bounceFriction: number;
  /** Below this speed (m/s) after a bounce a particle comes to rest. */
  restSpeed: number;
}

/** Ease-out used for size growth (smoke expands fast, then slows). */
export function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/**
 * Opacity over normalized life: linear a0 → a1, ramped in over the first `fadeIn` and out over
 * the last `fadeOut` fraction of life (smoke holds its density, then dissolves).
 */
export function particleAlpha(t: number, a0: number, a1: number, fadeIn: number, fadeOut = 0): number {
  let a = a0 + (a1 - a0) * t;
  if (fadeIn > 0 && t < fadeIn) a *= t / fadeIn;
  if (fadeOut > 0 && t > 1 - fadeOut) a *= Math.max(0, (1 - t) / fadeOut);
  return a;
}

export class ParticleBuffer {
  readonly maxCapacity: number;
  /** Active limit (quality budget), ≤ maxCapacity. */
  private limit: number;
  private _count = 0;

  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly size0: Float32Array;
  readonly size1: Float32Array;
  readonly r0: Float32Array;
  readonly g0: Float32Array;
  readonly b0: Float32Array;
  readonly r1: Float32Array;
  readonly g1: Float32Array;
  readonly b1: Float32Array;
  readonly a0: Float32Array;
  readonly a1: Float32Array;
  readonly fadeIn: Float32Array;
  readonly fadeOut: Float32Array;
  readonly gravity: Float32Array;
  readonly drag: Float32Array;
  readonly rot: Float32Array;
  readonly spin: Float32Array;
  readonly stretch: Float32Array;
  readonly cell: Float32Array;
  readonly bounce: Float32Array;
  readonly pnx: Float32Array;
  readonly pny: Float32Array;
  readonly pnz: Float32Array;
  readonly pd: Float32Array;
  readonly floorY: Float32Array;
  /** 1 = spawned since the last endFrame(). */
  readonly fresh: Float32Array;
  private readonly fields: Float32Array[];

  /** Sort scratch (depth key << 16 | index) for back-to-front output; unused slots hold SORT_EMPTY. */
  private readonly sortKeys: Uint32Array;
  /** Entries of sortKeys holding real keys since the last sort. */
  private sortedCount = 0;

  constructor(
    maxCapacity: number,
    private readonly params: ParticleSimParams,
  ) {
    // Sort keys pack the particle index into 16 bits.
    this.maxCapacity = Math.max(0, Math.min(0xffff, Math.floor(maxCapacity)));
    this.limit = this.maxCapacity;
    const n = this.maxCapacity;
    const f = (): Float32Array => new Float32Array(n);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.age = f();
    this.life = f();
    this.size0 = f();
    this.size1 = f();
    this.r0 = f();
    this.g0 = f();
    this.b0 = f();
    this.r1 = f();
    this.g1 = f();
    this.b1 = f();
    this.a0 = f();
    this.a1 = f();
    this.fadeIn = f();
    this.fadeOut = f();
    this.gravity = f();
    this.drag = f();
    this.rot = f();
    this.spin = f();
    this.stretch = f();
    this.cell = f();
    this.bounce = f();
    this.pnx = f();
    this.pny = f();
    this.pnz = f();
    this.pd = f();
    this.floorY = f();
    this.fresh = f();
    this.fields = [
      this.px,
      this.py,
      this.pz,
      this.vx,
      this.vy,
      this.vz,
      this.age,
      this.life,
      this.size0,
      this.size1,
      this.r0,
      this.g0,
      this.b0,
      this.r1,
      this.g1,
      this.b1,
      this.a0,
      this.a1,
      this.fadeIn,
      this.fadeOut,
      this.gravity,
      this.drag,
      this.rot,
      this.spin,
      this.stretch,
      this.cell,
      this.bounce,
      this.pnx,
      this.pny,
      this.pnz,
      this.pd,
      this.floorY,
      this.fresh,
    ];
    this.sortKeys = new Uint32Array(n).fill(SORT_EMPTY);
  }

  get count(): number {
    return this._count;
  }

  get capacity(): number {
    return this.limit;
  }

  /** Change the active limit (quality). Particles beyond a lower limit are dropped. */
  setCapacity(n: number): void {
    this.limit = Math.max(0, Math.min(this.maxCapacity, Math.floor(n)));
    if (this._count > this.limit) this._count = this.limit;
  }

  clear(): void {
    this._count = 0;
  }

  /** Add one particle. Returns false when the buffer is full (the spawn is dropped). */
  spawn(s: ParticleSpawn): boolean {
    if (this._count >= this.limit || !(s.life > 0)) return false;
    const i = this._count++;
    this.px[i] = s.x;
    this.py[i] = s.y;
    this.pz[i] = s.z;
    this.vx[i] = s.vx;
    this.vy[i] = s.vy;
    this.vz[i] = s.vz;
    this.age[i] = 0;
    this.life[i] = s.life;
    this.size0[i] = s.size0;
    this.size1[i] = s.size1;
    this.r0[i] = s.r0;
    this.g0[i] = s.g0;
    this.b0[i] = s.b0;
    this.r1[i] = s.r1;
    this.g1[i] = s.g1;
    this.b1[i] = s.b1;
    this.a0[i] = s.a0;
    this.a1[i] = s.a1;
    this.fadeIn[i] = s.fadeIn;
    this.fadeOut[i] = s.fadeOut;
    this.gravity[i] = s.gravity;
    this.drag[i] = s.drag;
    this.rot[i] = s.rotation;
    this.spin[i] = s.spin;
    this.stretch[i] = s.stretch;
    this.cell[i] = s.cell;
    this.bounce[i] = s.bounce;
    this.pnx[i] = s.planeNx;
    this.pny[i] = s.planeNy;
    this.pnz[i] = s.planeNz;
    this.pd[i] = s.planeD;
    this.floorY[i] = s.floorY;
    this.fresh[i] = 1;
    return true;
  }

  /** Remove particle i (swap with the last alive one). */
  private kill(i: number): void {
    const last = --this._count;
    if (i === last) return;
    const fields = this.fields;
    for (let f = 0; f < fields.length; f++) {
      const a = fields[f]!;
      a[i] = a[last]!;
    }
  }

  /**
   * Advance every particle by dt seconds. `holdFresh`: particles spawned since the last
   * endFrame() are not simulated (they are drawn once in their spawn state).
   */
  update(dt: number, holdFresh = false): void {
    if (!(dt > 0)) return;
    const fresh = this.fresh;
    const { bounceFriction, restSpeed } = this.params;
    const px = this.px;
    const py = this.py;
    const pz = this.pz;
    const vx = this.vx;
    const vy = this.vy;
    const vz = this.vz;
    let i = 0;
    while (i < this._count) {
      if (holdFresh && fresh[i]) {
        i++;
        continue;
      }
      const age = this.age[i]! + dt;
      if (age >= this.life[i]!) {
        this.kill(i);
        continue; // the swapped-in particle is processed at the same index
      }
      this.age[i] = age;
      let x = vx[i]!;
      let y = vy[i]! - this.gravity[i]! * dt;
      let z = vz[i]!;
      const drag = this.drag[i]!;
      if (drag > 0) {
        const k = Math.exp(-drag * dt);
        x *= k;
        y *= k;
        z *= k;
      }
      let nx = px[i]! + x * dt;
      let ny = py[i]! + y * dt;
      let nz = pz[i]! + z * dt;
      const e = this.bounce[i]!;
      if (e >= 0) {
        // Surface plane of the spawn point.
        const pnx = this.pnx[i]!;
        const pny = this.pny[i]!;
        const pnz = this.pnz[i]!;
        if (pnx !== 0 || pny !== 0 || pnz !== 0) {
          const dist = nx * pnx + ny * pny + nz * pnz - this.pd[i]!;
          if (dist < 0) {
            nx -= dist * pnx;
            ny -= dist * pny;
            nz -= dist * pnz;
            const vn = x * pnx + y * pny + z * pnz;
            if (vn < 0) {
              // Reflect the normal part with restitution, keep a share of the tangential part.
              const tx = (x - vn * pnx) * bounceFriction;
              const ty = (y - vn * pny) * bounceFriction;
              const tz = (z - vn * pnz) * bounceFriction;
              x = tx - vn * e * pnx;
              y = ty - vn * e * pny;
              z = tz - vn * e * pnz;
              if (x * x + y * y + z * z < restSpeed * restSpeed) x = y = z = 0;
            }
          }
        }
        // Floor under the effect.
        const floor = this.floorY[i]!;
        if (ny < floor) {
          ny = floor;
          if (y < 0) {
            y = -y * e;
            x *= bounceFriction;
            z *= bounceFriction;
            if (y < restSpeed) {
              // Resting on the floor: stop falling (gravity would re-trigger the bounce every frame).
              y = 0;
              if (x * x + z * z < restSpeed * restSpeed) x = z = 0;
              this.gravity[i] = 0;
            }
          }
        }
      }
      vx[i] = x;
      vy[i] = y;
      vz[i] = z;
      px[i] = nx;
      py[i] = ny;
      pz[i] = nz;
      this.rot[i] = this.rot[i]! + this.spin[i]! * dt;
      i++;
    }
  }

  /** Every particle spawned so far has been drawn: simulate them from the next update on. */
  endFrame(): void {
    this.fresh.fill(0, 0, this._count);
  }

  /**
   * Write GPU instance data for all alive particles. With `sortFrom` (camera position + forward),
   * particles are written back to front (alpha blending); otherwise in storage order.
   * Returns the number of instances written.
   */
  writeInstances(
    out: ParticleInstanceArrays,
    sortFrom?: { x: number; y: number; z: number; fx: number; fy: number; fz: number; range: number },
  ): number {
    const n = this._count;
    if (n === 0) return 0;
    const keys = this.sortKeys;
    if (sortFrom) {
      const range = Math.max(1e-3, sortFrom.range);
      for (let i = 0; i < n; i++) {
        const depth =
          (this.px[i]! - sortFrom.x) * sortFrom.fx +
          (this.py[i]! - sortFrom.y) * sortFrom.fy +
          (this.pz[i]! - sortFrom.z) * sortFrom.fz;
        const q = Math.min(0xffff, Math.max(0, Math.floor((depth / range) * 0xffff)));
        // Far first: invert the quantized depth so an ascending numeric sort is back to front.
        keys[i] = (((0xffff - q) << 16) | i) >>> 0;
      }
      // Sort the whole array in place (a subarray view would allocate): stale keys of particles
      // that died since the last sort are reset so they sort behind the live ones.
      for (let i = n; i < this.sortedCount; i++) keys[i] = SORT_EMPTY;
      this.sortedCount = n;
      keys.sort();
    }
    for (let k = 0; k < n; k++) {
      const i = sortFrom ? keys[k]! & 0xffff : k;
      const life = this.life[i]!;
      const t = life > 0 ? Math.min(1, this.age[i]! / life) : 1;
      const o = k * 4;
      out.pos[o] = this.px[i]!;
      out.pos[o + 1] = this.py[i]!;
      out.pos[o + 2] = this.pz[i]!;
      out.pos[o + 3] = this.size0[i]! + (this.size1[i]! - this.size0[i]!) * easeOutQuad(t);
      out.color[o] = this.r0[i]! + (this.r1[i]! - this.r0[i]!) * t;
      out.color[o + 1] = this.g0[i]! + (this.g1[i]! - this.g0[i]!) * t;
      out.color[o + 2] = this.b0[i]! + (this.b1[i]! - this.b0[i]!) * t;
      out.color[o + 3] = particleAlpha(t, this.a0[i]!, this.a1[i]!, this.fadeIn[i]!, this.fadeOut[i]!);
      out.misc[o] = this.rot[i]!;
      out.misc[o + 1] = this.cell[i]!;
      out.misc[o + 2] = this.stretch[i]!;
      out.misc[o + 3] = 0;
      const v = k * 3;
      out.vel[v] = this.vx[i]!;
      out.vel[v + 1] = this.vy[i]!;
      out.vel[v + 2] = this.vz[i]!;
    }
    return n;
  }
}
