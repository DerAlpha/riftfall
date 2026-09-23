/**
 * Shell casing simulation (pure, struct-of-arrays, fixed pool). Casings fly with gravity and
 * tumble, bounce off up to two planes – the floor found at ejection and the last surface hit by a
 * sparse raycast along the velocity (done by CasingSystem every few frames) – then settle flat,
 * lie on the ground for a while and shrink out. When the pool is full the oldest casing is reused.
 *
 * Orientation is a quaternion per casing (x, y, z, w arrays) integrated from the angular velocity.
 */

export interface CasingBounce {
  /** Casing index. */
  index: number;
  /** Speed into the surface at the bounce (m/s). */
  impactSpeed: number;
}

export interface CasingSimParams {
  gravity: number;
  life: number;
  fadeTime: number;
  settleSpeed: number;
  settleTime: number;
  spinDamping: number;
  /** A casing still flying after this long (no floor found) is removed. */
  maxFlightTime: number;
}

export interface CasingSpawn {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Angular velocity (rad/s, world axes). */
  wx: number;
  wy: number;
  wz: number;
  /** Initial orientation. */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  bounce: number;
  friction: number;
  /** Floor plane height (−Infinity = none). */
  floorY: number;
  /** Casing radius: the center rests this far above a surface. */
  radius: number;
  /** Opaque tag (casing type index) for the renderer/audio. */
  type: number;
}

export function createCasingSpawn(): CasingSpawn {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    wx: 0,
    wy: 0,
    wz: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    bounce: 0.4,
    friction: 0.5,
    floorY: Number.NEGATIVE_INFINITY,
    radius: 0.005,
    type: 0,
  };
}

/** Integrate an orientation quaternion by angular velocity w over dt (first order, normalized). */
export function integrateQuat(
  q: Float32Array,
  i: number,
  wx: number,
  wy: number,
  wz: number,
  dt: number,
): void {
  const x = q[i * 4]!;
  const y = q[i * 4 + 1]!;
  const z = q[i * 4 + 2]!;
  const w = q[i * 4 + 3]!;
  const h = 0.5 * dt;
  // dq = 0.5 · (0, ω) ⊗ q
  let nx = x + h * (wx * w + wy * z - wz * y);
  let ny = y + h * (wy * w + wz * x - wx * z);
  let nz = z + h * (wz * w + wx * y - wy * x);
  let nw = w + h * (-wx * x - wy * y - wz * z);
  const len = Math.hypot(nx, ny, nz, nw) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  nw /= len;
  q[i * 4] = nx;
  q[i * 4 + 1] = ny;
  q[i * 4 + 2] = nz;
  q[i * 4 + 3] = nw;
}

/**
 * Resting orientation for a cylinder whose long axis is local +Y: the axis is laid flat along
 * its current horizontal heading (keeps the yaw it landed with). Writes a quaternion into out.
 */
export function flatRestQuat(q: Float32Array, i: number, out: Float32Array): void {
  const x = q[i * 4]!;
  const y = q[i * 4 + 1]!;
  const z = q[i * 4 + 2]!;
  const w = q[i * 4 + 3]!;
  // Local +Y in world space.
  let ax = 2 * (x * y - w * z);
  let az = 2 * (y * z + w * x);
  const len = Math.hypot(ax, az);
  if (len < 1e-5) {
    ax = 1;
    az = 0;
  } else {
    ax /= len;
    az /= len;
  }
  // Rotation taking +Y to (ax, 0, az): axis = Y × a = (az, 0, -ax), angle 90°.
  const s = Math.SQRT1_2;
  out[0] = az * s;
  out[1] = 0;
  out[2] = -ax * s;
  out[3] = s;
}

export class CasingSim {
  readonly capacity: number;
  private limit: number;
  readonly alive: Uint8Array;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly wx: Float32Array;
  readonly wy: Float32Array;
  readonly wz: Float32Array;
  /** Orientation quaternions (x, y, z, w). */
  readonly q: Float32Array;
  readonly age: Float32Array;
  /** Seconds since the casing came to rest (-1 = moving). */
  readonly rest: Float32Array;
  readonly bounce: Float32Array;
  readonly friction: Float32Array;
  readonly radius: Float32Array;
  readonly floorY: Float32Array;
  /** Wall plane from the last probe: n·p = d (n zero = none). */
  readonly wnx: Float32Array;
  readonly wny: Float32Array;
  readonly wnz: Float32Array;
  readonly wd: Float32Array;
  readonly type: Uint8Array;
  readonly clinks: Uint8Array;
  /** Spawn order stamp (oldest reuse). */
  private readonly stamp: Float64Array;
  private serial = 0;
  private _count = 0;
  private readonly restQuat = new Float32Array(4);
  private readonly bounceInfo: CasingBounce = { index: 0, impactSpeed: 0 };

  constructor(
    capacity: number,
    private readonly params: CasingSimParams,
  ) {
    const n = Math.max(0, Math.floor(capacity));
    this.capacity = n;
    this.limit = n;
    const f = (k = 1): Float32Array => new Float32Array(n * k);
    this.alive = new Uint8Array(n);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.wx = f();
    this.wy = f();
    this.wz = f();
    this.q = f(4);
    this.age = f();
    this.rest = f();
    this.bounce = f();
    this.friction = f();
    this.radius = f();
    this.floorY = f();
    this.wnx = f();
    this.wny = f();
    this.wnz = f();
    this.wd = f();
    this.type = new Uint8Array(n);
    this.clinks = new Uint8Array(n);
    this.stamp = new Float64Array(n);
  }

  get count(): number {
    return this._count;
  }

  get activeLimit(): number {
    return this.limit;
  }

  /** Limit the number of simultaneous casings (quality); extra casings are removed. */
  setLimit(n: number): void {
    this.limit = Math.max(0, Math.min(this.capacity, Math.floor(n)));
    for (let i = this.limit; i < this.capacity; i++) this.kill(i);
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.kill(i);
  }

  private kill(i: number): void {
    if (this.alive[i]) {
      this.alive[i] = 0;
      this._count--;
    }
  }

  /** Spawn a casing (reuses the oldest when full). Returns its index, or -1 with no capacity. */
  spawn(s: CasingSpawn): number {
    if (this.limit <= 0) return -1;
    let slot = -1;
    let oldest = -1;
    let oldestStamp = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.limit; i++) {
      if (!this.alive[i]) {
        slot = i;
        break;
      }
      if (this.stamp[i]! < oldestStamp) {
        oldestStamp = this.stamp[i]!;
        oldest = i;
      }
    }
    if (slot < 0) slot = oldest;
    if (!this.alive[slot]) this._count++;
    const i = slot;
    this.alive[i] = 1;
    this.stamp[i] = this.serial++;
    this.px[i] = s.x;
    this.py[i] = s.y;
    this.pz[i] = s.z;
    this.vx[i] = s.vx;
    this.vy[i] = s.vy;
    this.vz[i] = s.vz;
    this.wx[i] = s.wx;
    this.wy[i] = s.wy;
    this.wz[i] = s.wz;
    this.q[i * 4] = s.qx;
    this.q[i * 4 + 1] = s.qy;
    this.q[i * 4 + 2] = s.qz;
    this.q[i * 4 + 3] = s.qw;
    this.age[i] = 0;
    this.rest[i] = -1;
    this.bounce[i] = s.bounce;
    this.friction[i] = s.friction;
    this.radius[i] = s.radius;
    this.floorY[i] = s.floorY;
    this.wnx[i] = this.wny[i] = this.wnz[i] = this.wd[i] = 0;
    this.type[i] = s.type;
    this.clinks[i] = 0;
    return i;
  }

  /** Set the probe-hit wall plane of casing i (point + unit normal). */
  setWall(i: number, x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    this.wnx[i] = nx;
    this.wny[i] = ny;
    this.wnz[i] = nz;
    this.wd[i] = x * nx + y * ny + z * nz;
    // A floor-like hit also lowers/raises the floor plane.
    if (ny > 0.7) this.floorY[i] = y;
  }

  /** 0..1 visual scale (shrinks out at the end of its life). */
  scaleOf(i: number): number {
    const p = this.params;
    const r = this.rest[i]!;
    if (r < 0) return 1;
    const left = p.life - r;
    return left >= p.fadeTime ? 1 : Math.max(0, left / p.fadeTime);
  }

  /**
   * Advance all casings; reports bounces (for clink audio) through `onBounce` (reused object,
   * copy what you keep).
   */
  update(dt: number, onBounce?: (b: CasingBounce) => void): void {
    if (!(dt > 0)) return;
    const p = this.params;
    const bounceInfo = this.bounceInfo;
    for (let i = 0; i < this.limit; i++) {
      if (!this.alive[i]) continue;
      const age = this.age[i]! + dt;
      this.age[i] = age;
      const rest = this.rest[i]!;
      if (rest >= 0) {
        // Ease into the flat pose over settleTime (the last step lands exactly on it).
        if (rest < p.settleTime) {
          flatRestQuat(this.q, i, this.restQuat);
          slerpInto(this.q, i, this.restQuat, Math.min(1, dt / Math.max(dt, p.settleTime - rest)));
        }
        const r = rest + dt;
        this.rest[i] = r;
        if (r >= p.life) this.kill(i);
        continue;
      }
      if (age > p.maxFlightTime) {
        this.kill(i);
        continue;
      }
      let vx = this.vx[i]!;
      let vy = this.vy[i]! - p.gravity * dt;
      let vz = this.vz[i]!;
      let x = this.px[i]! + vx * dt;
      let y = this.py[i]! + vy * dt;
      let z = this.pz[i]! + vz * dt;
      const rad = this.radius[i]!;
      const e = this.bounce[i]!;
      const fr = this.friction[i]!;
      let hit = false;
      let impact = 0;
      // Wall plane from the last probe.
      const nx = this.wnx[i]!;
      const ny = this.wny[i]!;
      const nz = this.wnz[i]!;
      if (nx !== 0 || ny !== 0 || nz !== 0) {
        const dist = x * nx + y * ny + z * nz - this.wd[i]! - rad;
        if (dist < 0) {
          x -= dist * nx;
          y -= dist * ny;
          z -= dist * nz;
          const vn = vx * nx + vy * ny + vz * nz;
          if (vn < 0) {
            impact = Math.max(impact, -vn);
            const tx = (vx - vn * nx) * fr;
            const ty = (vy - vn * ny) * fr;
            const tz = (vz - vn * nz) * fr;
            vx = tx - vn * e * nx;
            vy = ty - vn * e * ny;
            vz = tz - vn * e * nz;
            hit = true;
          }
        }
      }
      // Floor.
      const floor = this.floorY[i]! + rad;
      if (y < floor) {
        y = floor;
        if (vy < 0) {
          impact = Math.max(impact, -vy);
          vy = -vy * e;
          vx *= fr;
          vz *= fr;
          hit = true;
        }
      }
      if (hit) {
        const k = p.spinDamping;
        this.wx[i] = this.wx[i]! * k;
        this.wy[i] = this.wy[i]! * k;
        this.wz[i] = this.wz[i]! * k;
        this.clinks[i] = Math.min(255, this.clinks[i]! + 1);
        if (onBounce) {
          bounceInfo.index = i;
          bounceInfo.impactSpeed = impact;
          onBounce(bounceInfo);
        }
        // On the floor and slow: settle.
        if (y <= floor + 1e-4 && Math.hypot(vx, vy, vz) < p.settleSpeed) {
          vx = vy = vz = 0;
          this.rest[i] = 0;
        }
      }
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      integrateQuat(this.q, i, this.wx[i]!, this.wy[i]!, this.wz[i]!, dt);
    }
  }
}

/** q[i] ← slerp(q[i], target, t) (nlerp with sign fix – plenty for the small settle rotation). */
function slerpInto(q: Float32Array, i: number, target: Float32Array, t: number): void {
  const o = i * 4;
  let tx = target[0]!;
  let ty = target[1]!;
  let tz = target[2]!;
  let tw = target[3]!;
  if (q[o]! * tx + q[o + 1]! * ty + q[o + 2]! * tz + q[o + 3]! * tw < 0) {
    tx = -tx;
    ty = -ty;
    tz = -tz;
    tw = -tw;
  }
  const x = q[o]! + (tx - q[o]!) * t;
  const y = q[o + 1]! + (ty - q[o + 1]!) * t;
  const z = q[o + 2]! + (tz - q[o + 2]!) * t;
  const w = q[o + 3]! + (tw - q[o + 3]!) * t;
  const len = Math.hypot(x, y, z, w) || 1;
  q[o] = x / len;
  q[o + 1] = y / len;
  q[o + 2] = z / len;
  q[o + 3] = w / len;
}
