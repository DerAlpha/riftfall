/**
 * Procedural creature geometry: every modular part (ellipsoid / plate, tapered capsule, spike,
 * lathe, tube) is a SWEEP – rings of vertices along a path with a radius profile, poles where the
 * radius reaches zero (no seams, no UVs: surfaces are textured triplanar in the shader). The parts
 * of one enemy type are merged into ONE indexed geometry with
 *   partId   – index into the compiled rig's part table (→ bone + material zone),
 *   partAxis – 0 at the part's base … 1 at its far end (tip darkening, gradients).
 * Built once per type at load; nothing here runs per frame.
 */
import { BufferAttribute, BufferGeometry, CatmullRomCurve3, Euler, Matrix4, Vector3 } from 'three';
import { ENEMY_RENDER, type EnemyPartDef, type Vec3 } from '../../defs/enemyVisuals';
import { hash2 } from '../../vfx/noise';
import type { CompiledPart } from './poseMath';

const G = ENEMY_RENDER.geometry;
const DEG = Math.PI / 180;

/** One part before merging: positions, normals, axis parameter, triangle indices. */
export interface PartMesh {
  positions: Float32Array;
  normals: Float32Array;
  axis: Float32Array;
  indices: Uint32Array;
}

interface Ring {
  x: number;
  y: number;
  z: number;
  r: number;
  /** 0..1 along the part. */
  t: number;
}

const _t = new Vector3();
const _n = new Vector3();
const _b = new Vector3();
const _ref = new Vector3();
const _prevN = new Vector3();

function radialFor(r: number): number {
  return r < G.smallRadius ? G.radialSmall : G.radial;
}

function ringsFor(length: number): number {
  return Math.min(G.maxRings, Math.max(G.minRings, Math.ceil(length * G.ringsPerMeter)));
}

/**
 * Sweep rings (poles where r ≈ 0) into a closed triangle mesh. Frames are parallel-transported
 * from the model X axis, `ellipse` scales the ring along N (≈ X) and B = T × N.
 */
export function sweep(
  rings: readonly Ring[],
  radial: number,
  ellipse: readonly [number, number] = [1, 1],
): PartMesh {
  const eps = 1e-6;
  const pos: number[] = [];
  const axis: number[] = [];
  const ringStart: number[] = [];
  const ringPole: boolean[] = [];
  for (let i = 0; i < rings.length; i++) {
    const c = rings[i]!;
    const prev = rings[Math.max(0, i - 1)]!;
    const next = rings[Math.min(rings.length - 1, i + 1)]!;
    _t.set(next.x - prev.x, next.y - prev.y, next.z - prev.z);
    if (_t.lengthSq() < eps) _t.set(0, 1, 0);
    _t.normalize();
    if (i === 0) {
      _ref.set(1, 0, 0);
      if (Math.abs(_ref.dot(_t)) > 0.95) _ref.set(0, 0, 1);
      _n.copy(_ref).addScaledVector(_t, -_ref.dot(_t)).normalize();
    } else {
      _n.copy(_prevN).addScaledVector(_t, -_prevN.dot(_t));
      if (_n.lengthSq() < eps) _n.set(1, 0, 0).addScaledVector(_t, -_t.x);
      _n.normalize();
    }
    _prevN.copy(_n);
    _b.crossVectors(_t, _n);
    ringStart.push(pos.length / 3);
    if (c.r <= eps) {
      ringPole.push(true);
      pos.push(c.x, c.y, c.z);
      axis.push(c.t);
      continue;
    }
    ringPole.push(false);
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      const u = Math.cos(th) * c.r * ellipse[0];
      const v = Math.sin(th) * c.r * ellipse[1];
      pos.push(c.x + _n.x * u + _b.x * v, c.y + _n.y * u + _b.y * v, c.z + _n.z * u + _b.z * v);
      axis.push(c.t);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i + 1 < rings.length; i++) {
    const pa = ringPole[i]!;
    const pb = ringPole[i + 1]!;
    if (pa && pb) continue;
    const sa = ringStart[i]!;
    const sb = ringStart[i + 1]!;
    for (let j = 0; j < radial; j++) {
      const j1 = (j + 1) % radial;
      const a0 = pa ? sa : sa + j;
      const a1 = pa ? sa : sa + j1;
      const b0 = pb ? sb : sb + j;
      const b1 = pb ? sb : sb + j1;
      if (!pa) idx.push(a0, a1, b0);
      if (!pb) idx.push(a1, b1, b0);
    }
  }
  const positions = new Float32Array(pos);
  const indices = new Uint32Array(idx);
  return { positions, normals: computeNormals(positions, indices), axis: new Float32Array(axis), indices };
}

/** Area-weighted smooth vertex normals. */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const n = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3;
    const b = indices[i + 1]! * 3;
    const c = indices[i + 2]! * 3;
    const e1x = positions[b]! - positions[a]!;
    const e1y = positions[b + 1]! - positions[a + 1]!;
    const e1z = positions[b + 2]! - positions[a + 2]!;
    const e2x = positions[c]! - positions[a]!;
    const e2y = positions[c + 1]! - positions[a + 1]!;
    const e2z = positions[c + 2]! - positions[a + 2]!;
    const fx = e1y * e2z - e1z * e2y;
    const fy = e1z * e2x - e1x * e2z;
    const fz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      n[v] = n[v]! + fx;
      n[v + 1] = n[v + 1]! + fy;
      n[v + 2] = n[v + 2]! + fz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!);
    if (l > 1e-12) {
      n[i] = n[i]! / l;
      n[i + 1] = n[i + 1]! / l;
      n[i + 2] = n[i + 2]! / l;
    } else {
      n[i + 1] = 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Shapes → rings
// ---------------------------------------------------------------------------

function hemisphereRings(
  out: Ring[],
  cx: number,
  cy: number,
  cz: number,
  dir: Vector3,
  r: number,
  sign: 1 | -1,
  t: number,
  includeEquator: boolean,
): void {
  const n = G.capRings;
  // sign -1: pole first (start cap); +1: equator first (end cap).
  for (let k = 0; k <= n; k++) {
    const phi = sign < 0 ? -Math.PI / 2 + (Math.PI / 2) * (k / n) : (Math.PI / 2) * (k / n);
    if (!includeEquator && ((sign < 0 && k === n) || (sign > 0 && k === 0))) continue;
    const along = r * Math.sin(phi);
    out.push({
      x: cx + dir.x * along,
      y: cy + dir.y * along,
      z: cz + dir.z * along,
      r: r * Math.cos(phi),
      t,
    });
  }
}

function capsuleRings(a: Vec3, b: Vec3, ra: number, rb: number): Ring[] {
  const dir = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = dir.length();
  if (len < 1e-6) dir.set(0, 1, 0);
  else dir.divideScalar(len);
  const rings: Ring[] = [];
  hemisphereRings(rings, a[0], a[1], a[2], dir, ra, -1, 0, true);
  const n = ringsFor(len);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    rings.push({
      x: a[0] + (b[0] - a[0]) * t,
      y: a[1] + (b[1] - a[1]) * t,
      z: a[2] + (b[2] - a[2]) * t,
      r: ra + (rb - ra) * t,
      t,
    });
  }
  hemisphereRings(rings, b[0], b[1], b[2], dir, rb, 1, 1, true);
  return rings;
}

function spikeRings(a: Vec3, b: Vec3, r: number, curve: Vec3 | undefined): Ring[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const mx = (a[0] + b[0]) / 2 + (curve?.[0] ?? 0);
  const my = (a[1] + b[1]) / 2 + (curve?.[1] ?? 0);
  const mz = (a[2] + b[2]) / 2 + (curve?.[2] ?? 0);
  const n = ringsFor(len);
  const rings: Ring[] = [];
  // Domed base slightly inside the parent surface.
  const dx = mx - a[0];
  const dy = my - a[1];
  const dz = mz - a[2];
  const dl = Math.hypot(dx, dy, dz) || 1;
  const inset = r * 0.35;
  rings.push({
    x: a[0] - (dx / dl) * inset,
    y: a[1] - (dy / dl) * inset,
    z: a[2] - (dz / dl) * inset,
    r: 0,
    t: 0,
  });
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u * u * a[0] + 2 * u * t * mx + t * t * b[0];
    const y = u * u * a[1] + 2 * u * t * my + t * t * b[1];
    const z = u * u * a[2] + 2 * u * t * mz + t * t * b[2];
    rings.push({ x, y, z, r: i === n ? 0 : r * Math.pow(u, 0.85), t });
  }
  return rings;
}

/** Catmull-Rom through the profile samples (clamped ends), resampled to `n + 1` rings. */
function latheRings(a: Vec3, b: Vec3, profile: readonly (readonly [number, number])[]): Ring[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.max(ringsFor(len), profile.length * 2);
  const rings: Ring[] = [];
  const p =
    profile.length > 1
      ? profile
      : ([
          [0, 0.1],
          [1, 0.1],
        ] as const);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let k = 0;
    while (k < p.length - 2 && t > p[k + 1]![0]) k++;
    const p0 = p[Math.max(0, k - 1)]!;
    const p1 = p[k]!;
    const p2 = p[k + 1]!;
    const p3 = p[Math.min(p.length - 1, k + 2)]!;
    const span = Math.max(1e-6, p2[0] - p1[0]);
    const s = Math.min(1, Math.max(0, (t - p1[0]) / span));
    const s2 = s * s;
    const s3 = s2 * s;
    let r =
      0.5 *
      (2 * p1[1] +
        (-p0[1] + p2[1]) * s +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * s2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * s3);
    r = Math.max(0, r);
    if ((i === 0 && p[0]![1] <= 0) || (i === n && p[p.length - 1]![1] <= 0)) r = 0;
    rings.push({
      x: a[0] + (b[0] - a[0]) * t,
      y: a[1] + (b[1] - a[1]) * t,
      z: a[2] + (b[2] - a[2]) * t,
      r,
      t,
    });
  }
  // Flat caps for open profile ends.
  if (rings[0]!.r > 0) rings.unshift({ ...rings[0]!, r: 0 });
  if (rings[rings.length - 1]!.r > 0) rings.push({ ...rings[rings.length - 1]!, r: 0 });
  return rings;
}

function tubeRings(points: readonly Vec3[], ra: number, rb: number): Ring[] {
  const pts = points.map((p) => new Vector3(p[0], p[1], p[2]));
  if (pts.length < 2) pts.push(pts[0]?.clone().add(new Vector3(0, 0.1, 0)) ?? new Vector3(0, 0.1, 0));
  const curve = new CatmullRomCurve3(pts, false, 'centripetal');
  const len = curve.getLength();
  const n = Math.max(ringsFor(len), pts.length * 3);
  const rings: Ring[] = [];
  const start = curve.getPointAt(0);
  const startDir = curve.getTangentAt(0).negate();
  const end = curve.getPointAt(1);
  const endDir = curve.getTangentAt(1);
  // Start cap (pole outward, along -tangent).
  const capStart: Ring[] = [];
  hemisphereRings(capStart, start.x, start.y, start.z, startDir, ra, 1, 0, false);
  capStart.reverse();
  rings.push(...capStart);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = curve.getPointAt(t);
    rings.push({ x: p.x, y: p.y, z: p.z, r: ra + (rb - ra) * t, t });
  }
  hemisphereRings(rings, end.x, end.y, end.z, endDir, rb, 1, 1, false);
  return rings;
}

const _m = new Matrix4();
const _e = new Euler();
const _v = new Vector3();

function ellipsoidMesh(def: Extract<EnemyPartDef, { shape: 'ellipsoid' }>): PartMesh {
  const [rx, ry, rz] = def.radii;
  const n = G.ellipsoidRings;
  const rings: Ring[] = [];
  for (let k = 0; k <= n; k++) {
    const phi = -Math.PI / 2 + Math.PI * (k / n);
    rings.push({ x: 0, y: Math.sin(phi) * ry, z: 0, r: k === 0 || k === n ? 0 : Math.cos(phi), t: k / n });
  }
  // Sweep along +Y: N = +X, B = Y × X = -Z → ellipse scales X by rx and Z by rz.
  const mesh = sweep(rings, radialFor(Math.min(rx, rz)), [rx, rz]);
  const bend = def.bend ?? 0;
  const r = def.rot ?? [0, 0, 0];
  _e.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'YXZ');
  _m.makeRotationFromEuler(_e);
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!;
    _v.set(x, p[i + 1]! + bend * (x / rx) * (x / rx), p[i + 2]!).applyMatrix4(_m);
    p[i] = _v.x + def.center[0];
    p[i + 1] = _v.y + def.center[1];
    p[i + 2] = _v.z + def.center[2];
  }
  mesh.normals = computeNormals(p, mesh.indices);
  return mesh;
}

/** 3D value noise in [-1, 1] for the lumps (deterministic). */
function lumpNoise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number, c: number): number => hash2(ix + a, iy + b + Math.imul(iz + c, 57), seed);
  const x00 = h(0, 0, 0) + (h(1, 0, 0) - h(0, 0, 0)) * ux;
  const x10 = h(0, 1, 0) + (h(1, 1, 0) - h(0, 1, 0)) * ux;
  const x01 = h(0, 0, 1) + (h(1, 0, 1) - h(0, 0, 1)) * ux;
  const x11 = h(0, 1, 1) + (h(1, 1, 1) - h(0, 1, 1)) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return (y0 + (y1 - y0) * uz) * 2 - 1;
}

function applyLumps(mesh: PartMesh, amount: number, seed: number): void {
  if (!(amount > 0)) return;
  const p = mesh.positions;
  const n = mesh.normals;
  const s = G.lumpScale;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!;
    const y = p[i + 1]!;
    const z = p[i + 2]!;
    const d =
      (lumpNoise(x * s, y * s, z * s, seed) * 0.7 +
        lumpNoise(x * s * 2.3, y * s * 2.3, z * s * 2.3, seed + 7) * 0.3) *
      amount;
    p[i] = x + n[i]! * d;
    p[i + 1] = y + n[i + 1]! * d;
    p[i + 2] = z + n[i + 2]! * d;
  }
  mesh.normals = computeNormals(p, mesh.indices);
}

/** Mesh of one part (model rest space). */
export function buildPartMesh(def: EnemyPartDef, seed: number = G.seed): PartMesh {
  let mesh: PartMesh;
  switch (def.shape) {
    case 'ellipsoid':
      mesh = ellipsoidMesh(def);
      break;
    case 'capsule': {
      const rb = def.radiusB ?? def.radius;
      mesh = sweep(capsuleRings(def.a, def.b, def.radius, rb), radialFor(Math.max(def.radius, rb)));
      break;
    }
    case 'spike':
      mesh = sweep(spikeRings(def.a, def.b, def.radius, def.curve), radialFor(def.radius));
      break;
    case 'lathe': {
      const maxR = def.profile.reduce((m, p) => Math.max(m, p[1]), 0);
      mesh = sweep(latheRings(def.a, def.b, def.profile), radialFor(maxR), def.ellipse ?? [1, 1]);
      break;
    }
    case 'tube': {
      const rb = def.radiusB ?? def.radius;
      mesh = sweep(tubeRings(def.points, def.radius, rb), radialFor(Math.max(def.radius, rb)));
      break;
    }
  }
  applyLumps(mesh, def.lumpy ?? 0, seed);
  return mesh;
}

/**
 * Merge all parts of a compiled rig into one geometry (position, normal, partId, partAxis, index).
 * The bounding sphere covers the rest pose (the renderer sets per-frame instance bounds itself).
 */
export function buildTypeGeometry(parts: readonly CompiledPart[]): BufferGeometry {
  const meshes = parts.map((p, i) => buildPartMesh(p.def, G.seed + i * 31));
  let vCount = 0;
  let iCount = 0;
  for (const m of meshes) {
    vCount += m.positions.length / 3;
    iCount += m.indices.length;
  }
  const position = new Float32Array(vCount * 3);
  const normal = new Float32Array(vCount * 3);
  const partId = new Float32Array(vCount);
  const partAxis = new Float32Array(vCount);
  const index = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0;
  let io = 0;
  meshes.forEach((m, pi) => {
    const n = m.positions.length / 3;
    position.set(m.positions, vo * 3);
    normal.set(m.normals, vo * 3);
    partAxis.set(m.axis, vo);
    partId.fill(pi, vo, vo + n);
    for (let k = 0; k < m.indices.length; k++) index[io + k] = m.indices[k]! + vo;
    vo += n;
    io += m.indices.length;
  });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(position, 3));
  geo.setAttribute('normal', new BufferAttribute(normal, 3));
  geo.setAttribute('partId', new BufferAttribute(partId, 1));
  geo.setAttribute('partAxis', new BufferAttribute(partAxis, 1));
  geo.setIndex(new BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}
