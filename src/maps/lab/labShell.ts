/**
 * The research lab's shell: floors, walls (bands, trims, light strips), ceilings with emissive
 * panels, doorway frames and thresholds for every space of LAB_LAYOUT. Pure data-to-geometry via
 * the LevelKit (merged per material, colliders created immediately).
 */
import { LAB_LAYOUT, type LabDoorwayDef, type LabSpaceDef, type LabThemeDef } from '../../defs/labLayout';
import { LEVEL_KIT, type Facing } from '../../defs/level';
import { LevelKit, WallFrame } from '../../world/LevelKit';
import {
  ceilingPieces,
  doorwayInterval,
  edgeOpenings,
  facingNormal,
  floorPieces,
  spaceWallEdges,
  wallBodySegments,
  wallFaceSegments,
  type WallEdge,
} from './labSpaces';

const L = LAB_LAYOUT;
const T = L.wallThickness;
const DECAL = LEVEL_KIT.decal;
const TRIM = LEVEL_KIT.trim;

/** Deterministic 0..1 hash of a position (dead ceiling panels). */
export function hash2(x: number, z: number): number {
  const v = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

export function themeOf(space: LabSpaceDef): LabThemeDef {
  return L.themes[space.theme];
}

/** Material of the topmost wall band (lintels, upper fillers). */
function bandsFrom(theme: LabThemeDef, y0: number): { material: string; top: number }[] {
  return theme.bands.map((b) => ({ material: b.material, top: b.top - y0 }));
}

/** Point on the wall line of an edge at `along` (face plane, floor level). */
function edgePoint(e: WallEdge, along: number): { x: number; y: number; z: number } {
  return e.along === 'x' ? { x: along, y: 0, z: e.coord } : { x: e.coord, y: 0, z: along };
}

function segmentEnds(e: WallEdge, s0: number, s1: number): [readonly [number, number], readonly [number, number]] {
  return e.along === 'x'
    ? [
        [s0, e.coord],
        [s1, e.coord],
      ]
    : [
        [e.coord, s0],
        [e.coord, s1],
      ];
}

export function buildShell(kit: LevelKit): void {
  for (const space of L.spaces) {
    buildFloors(kit, space);
    buildWalls(kit, space);
    if (!space.customCeiling) buildCeiling(kit, space);
  }
  for (const d of L.doorways) buildDoorway(kit, d);
}

function buildFloors(kit: LevelKit, space: LabSpaceDef): void {
  const theme = themeOf(space);
  for (const r of floorPieces(space)) kit.floor(theme.floor, r.minX, r.minZ, r.maxX, r.maxZ, 0);
}

function buildWalls(kit: LevelKit, space: LabSpaceDef): void {
  const theme = themeOf(space);
  const h = space.ceiling;
  const frameMargin = L.doorFrame.postWidth;
  for (const e of spaceWallEdges(space, T)) {
    const openings = edgeOpenings(e, L.doorways, T);
    const intervals = openings.map((o) => o.interval);
    for (const [s0, s1] of wallBodySegments(e, intervals)) {
      const [a, b] = segmentEnds(e, s0, s1);
      kit.wall({ a, b, facing: e.facing, y0: 0, height: h, thickness: T, bands: theme.bands });
    }
    // Lintels over the openings (up to the ceiling).
    for (const { doorway, interval } of openings) {
      if (doorway.height >= h) continue;
      const [a, b] = segmentEnds(e, interval.from, interval.to);
      kit.wall({
        a,
        b,
        facing: e.facing,
        y0: doorway.height,
        height: h - doorway.height,
        thickness: T,
        bands: bandsFrom(theme, doorway.height),
      });
    }
    // Face trims and the light strip, interrupted by the door frames.
    for (const [s0, s1] of wallFaceSegments(e, intervals, frameMargin)) {
      const len = s1 - s0;
      if (len < TRIM.stripInset * 4) continue;
      const mid = (s0 + s1) / 2;
      const f = new WallFrame(edgePoint(e, mid), e.facing);
      kit.box(theme.baseTrim, f.point(0, TRIM.baseHeight / 2, TRIM.baseDepth / 2), f.size(len, TRIM.baseHeight, TRIM.baseDepth), {
        collider: false,
      });
      const s = theme.strip;
      if (s && s.y < h - TRIM.stripHousingHeight) {
        kit.box(
          s.housing,
          f.point(0, s.y, TRIM.stripHousingDepth / 2),
          f.size(len, TRIM.stripHousingHeight, TRIM.stripHousingDepth),
          { collider: false },
        );
        kit.box(
          s.material,
          f.point(0, s.y, TRIM.stripHousingDepth + TRIM.stripInset / 2),
          f.size(len - TRIM.stripInset * 4, TRIM.stripHeight, TRIM.stripInset),
          { collider: false, castShadow: false },
        );
      }
      // Band seam above the wainscot.
      const seam = theme.bands[0];
      if (seam && seam.top < h) {
        kit.box(theme.baseTrim, f.point(0, seam.top, TRIM.capHeight / 2), f.size(len, TRIM.capHeight, TRIM.capHeight), {
          collider: false,
        });
      }
    }
  }
}

function buildCeiling(kit: LevelKit, space: LabSpaceDef): void {
  const theme = themeOf(space);
  const ct = L.ceilingThickness;
  const h = space.ceiling;
  for (const r of ceilingPieces(space, T)) {
    kit.boxMinMax(theme.ceiling, { x: r.minX, y: h, z: r.minZ }, { x: r.maxX, y: h + ct, z: r.maxZ });
  }
  const p = theme.ceilingPanels;
  if (!p) return;
  const th = DECAL.thickness * 2;
  for (const r of floorPieces(space)) {
    const w = r.maxX - r.minX - p.margin * 2;
    const d = r.maxZ - r.minZ - p.margin * 2;
    if (w <= 0 || d <= 0) continue;
    // Center the grid in the rect (at least one panel per axis).
    const nx = Math.max(1, Math.floor(w / p.spacing[0]) + 1);
    const nz = Math.max(1, Math.floor(d / p.spacing[1]) + 1);
    const x0 = (r.minX + r.maxX) / 2 - ((nx - 1) * p.spacing[0]) / 2;
    const z0 = (r.minZ + r.maxZ) / 2 - ((nz - 1) * p.spacing[1]) / 2;
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        const sx = Math.min(p.size[0], w);
        const sz = Math.min(p.size[1], d);
        const x = x0 + i * p.spacing[0];
        const z = z0 + k * p.spacing[1];
        // Dead panels: the station runs on emergency power.
        const dead = hash2(x, z) < p.dead;
        kit.box(
          dead ? theme.baseTrim : p.material,
          { x, y: h - th / 2, z },
          { x: sx, y: th, z: sz },
          { collider: false, castShadow: false },
        );
      }
    }
  }
}

/** Interior faces of a doorway (both sides of the passage) and their facings. */
export function doorwayFaces(d: LabDoorwayDef): { origin: { x: number; y: number; z: number }; facing: Facing }[] {
  if (d.axis === 'x') {
    return [
      { origin: { x: d.x - T, y: 0, z: d.z }, facing: 'nx' },
      { origin: { x: d.x + T, y: 0, z: d.z }, facing: 'px' },
    ];
  }
  return [
    { origin: { x: d.x, y: 0, z: d.z - T }, facing: 'nz' },
    { origin: { x: d.x, y: 0, z: d.z + T }, facing: 'pz' },
  ];
}

function buildDoorway(kit: LevelKit, d: LabDoorwayDef): void {
  const F = L.doorFrame;
  const iv = doorwayInterval(d);
  // Threshold plate through the wall gap.
  const plate = d.blast ? 'painted_hazard' : 'diamond_plate';
  if (d.axis === 'x') kit.floor(plate, d.x - T, iv.from, d.x + T, iv.to, 0);
  else kit.floor(plate, iv.from, d.z - T, iv.to, d.z + T, 0);

  const w = d.width;
  const h = d.height;
  const pw = F.postWidth;
  for (const face of doorwayFaces(d)) {
    const f = new WallFrame(face.origin, face.facing);
    const frameMat = d.blast ? 'painted_hazard' : 'trim_metal';
    for (const side of [-1, 1]) {
      kit.box(frameMat, f.point(side * (w / 2 + pw / 2), (h + F.lintelHeight) / 2, F.depth / 2), f.size(pw, h + F.lintelHeight, F.depth), {
        collider: true,
      });
      kit.box(
        'painted_hazard',
        f.point(side * (w / 2 + F.hazardWidth / 2), h / 2, F.depth + DECAL.offset),
        f.size(F.hazardWidth, h, DECAL.thickness),
        { collider: false, castShadow: false },
      );
    }
    kit.box(frameMat, f.point(0, h + F.lintelHeight / 2, F.depth / 2), f.size(w + pw * 2, F.lintelHeight, F.depth), {
      collider: true,
    });
    if (d.slot) {
      // M4 door slot marker: amber status light over the frame.
      const s = F.statusLight;
      kit.box('emissive_orange', f.point(0, h + F.lintelHeight + F.statusGap + s[1] / 2, s[2] / 2), f.size(s[0], s[1], s[2]), {
        collider: false,
        castShadow: false,
      });
    }
  }
}

/** Interior normal helper re-exported for the room builders. */
export { facingNormal };
