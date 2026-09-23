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
