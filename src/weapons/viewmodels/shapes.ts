/**
 * Primitive factories for the procedural weapon models. All return geometry in its own local
 * frame (the builder places it); "along Z" shapes run along −Z (the barrel direction).
 * Some factories attach a per-vertex `wear` attribute (0 = flat face, 1 = edge/bevel) that the
 * builder turns into edge-wear vertex colors.
 */
import {
  BufferAttribute,
  CylinderGeometry,
  ExtrudeGeometry,
  LatheGeometry,
  Shape,
  Vector2,
  type BufferGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const HALF_PI = Math.PI / 2;
/** Normals tilted 45° off every face axis count as fully worn. */
const WEAR_FULL = 1 - Math.SQRT1_2;

/** A point of a 2D profile: [forward (−Z), up (+Y)] in meters. */
export type ProfilePoint = readonly [number, number];

function setWear(geo: BufferGeometry, wearOf: (nx: number, ny: number, nz: number) => number): void {
  const n = geo.getAttribute('normal');
  if (!n) return;
  const wear = new Float32Array(n.count);
  for (let i = 0; i < n.count; i++)
    wear[i] = Math.min(1, Math.max(0, wearOf(n.getX(i), n.getY(i), n.getZ(i))));
  geo.setAttribute('wear', new BufferAttribute(wear, 1));
}

/** Axis-aligned faces are paint, rounded edges/corners are worn metal. */
function boxWear(nx: number, ny: number, nz: number): number {
  return (1 - Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz))) / WEAR_FULL;
}

/** Rounded box (width X, height Y, depth Z) with worn edges; 1 segment = a crisp chamfer. */
export function roundedBox(w: number, h: number, d: number, radius: number, segments = 1): BufferGeometry {
  const geo = new RoundedBoxGeometry(w, h, d, segments, radius);
  setWear(geo, boxWear);
  return geo;
}

/** Cylinder along −Z (length `len`, centered). */
export function cylinderZ(rFront: number, rBack: number, len: number, segments = 16): BufferGeometry {
  // CylinderGeometry's top (+Y) becomes −Z after rotating −90° about X... rotateX(-π/2) maps +Y → −Z.
  const geo = new CylinderGeometry(rFront, rBack, len, segments, 1, false);
  geo.rotateX(-HALF_PI);
  return geo;
}

/** Cylinder along X (pins, rollers). */
export function cylinderX(r: number, len: number, segments = 12): BufferGeometry {
  const geo = new CylinderGeometry(r, r, len, segments, 1, false);
  geo.rotateZ(HALF_PI);
  return geo;
}

/**
 * Lathe around the Z axis from [radius, forward] points (forward = distance along −Z).
 * Used for muzzle devices, barrels with steps, shell bases.
 */
export function latheZ(points: readonly ProfilePoint[], segments = 20): BufferGeometry {
  const pts = points.map(([r, f]) => new Vector2(Math.max(0, r), f));
  const geo = new LatheGeometry(pts, segments);
  // Lathe revolves around +Y with profile y = forward: rotate so +Y → −Z.
  geo.rotateX(-HALF_PI);
  return geo;
}

export interface ProfileOptions {
  /** Bevel size (m); 0 disables bevels. */
  bevel?: number;
  bevelSegments?: number;
  curveSegments?: number;
  /** Inner cut-outs (trigger guard openings, lightening cuts) as profiles. */
  holes?: readonly (readonly ProfilePoint[])[];
}

function shapeFrom(points: readonly ProfilePoint[]): Shape {
  const s = new Shape();
  points.forEach(([f, u], i) => (i === 0 ? s.moveTo(f, u) : s.lineTo(f, u)));
  s.closePath();
  return s;
}

/**
 * Side-profile extrusion: `points` outline the part seen from the right side as
 * [forward, up] pairs; the outline is extruded symmetrically across X to `width` (bevels
 * included). Walls/caps are paint, bevels are worn.
 */
export function profileX(
  points: readonly ProfilePoint[],
  width: number,
  opts: ProfileOptions = {},
): BufferGeometry {
  const bevel = Math.min(opts.bevel ?? 0, width * 0.45);
  const shape = shapeFrom(points);
  for (const h of opts.holes ?? []) shape.holes.push(shapeFrom(h));
  const geo = new ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, width - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: bevel > 0 ? (opts.bevelSegments ?? 2) : 0,
    curveSegments: opts.curveSegments ?? 6,
    steps: 1,
  });
  // Shape x = forward, y = up, extrusion along +Z. Ry(+90°) maps x → −z and z → +x.
  geo.rotateY(HALF_PI);
  geo.translate(-(width - 2 * bevel) / 2, 0, 0);
  geo.computeVertexNormals();
  setWear(geo, (nx, ny, nz) => (1 - Math.max(Math.abs(nx), Math.hypot(ny, nz))) / WEAR_FULL);
  return geo;
}

/**
 * Front-profile extrusion: `points` outline the cross-section seen from behind as [right, up]
 * pairs, extruded along −Z over `length` (bevels included). For receivers, shrouds and rails.
 */
export function profileZ(
  points: readonly ProfilePoint[],
  length: number,
  opts: ProfileOptions = {},
): BufferGeometry {
  const bevel = Math.min(opts.bevel ?? 0, length * 0.45);
  const shape = shapeFrom(points);
  for (const h of opts.holes ?? []) shape.holes.push(shapeFrom(h));
  const geo = new ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, length - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: bevel > 0 ? (opts.bevelSegments ?? 2) : 0,
    curveSegments: opts.curveSegments ?? 6,
    steps: 1,
  });
  // Extruded along +Z from 0: center it on the origin, running along the Z axis.
  geo.translate(0, 0, -(length - 2 * bevel) / 2);
  geo.computeVertexNormals();
  setWear(geo, (nx, ny, nz) => (1 - Math.max(Math.abs(nz), Math.hypot(nx, ny))) / WEAR_FULL);
  return geo;
}

/** Chamfered-rectangle outline [x, y] (angular sci-fi cross-sections). */
export function chamferRectProfile(w: number, h: number, cTop: number, cBottom = cTop): ProfilePoint[] {
  const x = w / 2;
  const y = h / 2;
  return [
    [x, -y + cBottom],
    [x, y - cTop],
    [x - cTop, y],
    [-x + cTop, y],
    [-x, y - cTop],
    [-x, -y + cBottom],
    [-x + cBottom, -y],
    [x - cBottom, -y],
  ];
}

/**
 * Hard-edged lathe around the Z axis from [radius, forward] points (like `latheZ`), but every
 * profile segment becomes its own band: normals stay crisp at the corners (scope tubes, drums,
 * barrels, muzzle devices) while the revolution stays smooth. Traverse the profile so the outside
 * is on the right (outer walls forward, bores backward). Short bands (< `bevelLength`) and bands
 * off the axial/radial directions count as worn edges.
 */
export function latheZHard(
  points: readonly ProfilePoint[],
  segments = 20,
  bevelLength = 0.003,
): BufferGeometry {
  const bands: BufferGeometry[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [r0, f0] = points[i]!;
    const [r1, f1] = points[i + 1]!;
    const dr = r1 - r0;
    const df = f1 - f0;
    const len = Math.hypot(dr, df);
    if (len < 1e-7 || (r0 <= 0 && r1 <= 0)) continue;
    const band = new LatheGeometry(
      [new Vector2(Math.max(0, r0), f0), new Vector2(Math.max(0, r1), f1)],
      segments,
    );
    band.rotateX(-HALF_PI);
    const straight = Math.max(Math.abs(dr), Math.abs(df)) / len;
    const w = len < bevelLength ? 1 : Math.min(1, Math.max(0, (1 - straight) / WEAR_FULL));
    const count = band.getAttribute('position').count;
    band.setAttribute('wear', new BufferAttribute(new Float32Array(count).fill(w), 1));
    bands.push(band);
  }
  const merged = bands.length === 1 ? bands[0]! : mergeGeometries(bands);
  if (bands.length > 1) for (const b of bands) b.dispose();
  return merged ?? new CylinderGeometry(0, 0, 0, 3);
}

/** Hollow tube along −Z (length `len` from the origin forward), crisp rims: scope tubes, shrouds, sleeves. */
export function tubeZ(rOuter: number, rInner: number, len: number, segments = 24): BufferGeometry {
  return latheZHard(
    [
      [rInner, 0],
      [rOuter, 0],
      [rOuter, len],
      [rInner, len],
      [rInner, 0],
    ],
    segments,
  );
}

/** Regular polygon outline [x, y] (hex shrouds, octagonal housings); `rotDeg` turns the first corner. */
export function regularPolygonProfile(radius: number, sides: number, rotDeg = 0): ProfilePoint[] {
  const pts: ProfilePoint[] = [];
  const n = Math.max(3, Math.round(sides));
  for (let i = 0; i < n; i++) {
    const a = ((rotDeg + (360 * i) / n) * Math.PI) / 180;
    pts.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return pts;
}

/** Annulus-sector outline [x, y] (heat shields, feed trays, arched covers) between two angles. */
export function arcBandProfile(
  rOuter: number,
  rInner: number,
  fromDeg: number,
  toDeg: number,
  steps: number,
): ProfilePoint[] {
  const pts: ProfilePoint[] = [];
  const n = Math.max(1, Math.round(steps));
  for (let i = 0; i <= n; i++) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / n) * Math.PI) / 180;
    pts.push([Math.cos(a) * rOuter, Math.sin(a) * rOuter]);
  }
  for (let i = n; i >= 0; i--) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / n) * Math.PI) / 180;
    pts.push([Math.cos(a) * rInner, Math.sin(a) * rInner]);
  }
  return pts;
}

/**
 * Point `s` meters down a grip axis that starts at [0, topY, topZ] and leans back by `tiltDeg`
 * (negative = bottom towards the stock, like every pistol grip).
 */
export function tiltedAxisPoint(
  tiltDeg: number,
  topY: number,
  topZ: number,
  s: number,
): [number, number, number] {
  const a = (tiltDeg * Math.PI) / 180;
  return [0, topY - Math.cos(a) * s, topZ - Math.sin(a) * s];
}
