/**
 * Pure layout geometry of the research lab (no three.js scene objects): wall outlines of the
 * spaces (unions of rects), doorway openings, trim gaps at wall features (tears, vents, shutter),
 * floor / ceiling pieces, the zone graph and the M4 door slots. Used by the builder and by the
 * layout validation tests.
 *
 * Walls: every boundary edge of a space gets a wall body of thickness T behind its interior face.
 * At convex corners the walls along X are extended by T (they fill the corner square), at reflex
 * corners the walls along Z are shortened by T, so bodies never overlap or leave holes.
 */
import type { Facing, RectDef } from '../../defs/level';
import {
  LAB_LAYOUT,
  RIFT_PORTAL,
  type LabDoorwayDef,
  type LabSpaceDef,
  type LabSpawnPointDef,
  type LabZoneId,
} from '../../defs/labLayout';
import { subtractIntervals, subtractRects, type Rect } from '../../world/kitMath';

const EPS = 1e-4;
/** Probe offset for corner classification (well below any layout dimension). */
const PROBE = 1e-3;

export interface WallEdge {
  readonly space: string;
  /** 'x': the wall runs along X at z = coord; 'z': along Z at x = coord. */
  readonly along: 'x' | 'z';
  readonly coord: number;
  /** Face interval along the line (from < to). */
  readonly from: number;
  readonly to: number;
  /** Interior direction of the face. */
  readonly facing: Facing;
  /** Wall body extension beyond the face interval at each end (+T, 0 or -T). */
  readonly extendFrom: number;
  readonly extendTo: number;
}

export interface Interval {
  from: number;
  to: number;
}

/** Strictly inside any rect of the space (open rects, EPS margin). */
export function insideSpace(rects: readonly RectDef[], x: number, z: number): boolean {
  for (const r of rects) {
    if (x > r.minX + EPS && x < r.maxX - EPS && z > r.minZ + EPS && z < r.maxZ - EPS) return true;
  }
  return false;
}

/** Interior normal of a facing (x/z components). */
export function facingNormal(f: Facing): { x: number; z: number } {
  switch (f) {
    case 'px':
      return { x: 1, z: 0 };
    case 'nx':
      return { x: -1, z: 0 };
    case 'pz':
      return { x: 0, z: 1 };
    case 'nz':
      return { x: 0, z: -1 };
  }
}

interface RawSide {
  along: 'x' | 'z';
  coord: number;
  from: number;
  to: number;
  facing: Facing;
  /** Outward direction sign along the normal axis. */
  out: number;
}

function rectSides(r: RectDef): RawSide[] {
  return [
    { along: 'x', coord: r.minZ, from: r.minX, to: r.maxX, facing: 'pz', out: -1 },
    { along: 'x', coord: r.maxZ, from: r.minX, to: r.maxX, facing: 'nz', out: 1 },
    { along: 'z', coord: r.minX, from: r.minZ, to: r.maxZ, facing: 'px', out: -1 },
    { along: 'z', coord: r.maxX, from: r.minZ, to: r.maxZ, facing: 'nx', out: 1 },
  ];
}

/** Union of intervals (sorted, touching intervals merged). */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.from <= last.to + EPS) last.to = Math.max(last.to, iv.to);
    else out.push({ from: iv.from, to: iv.to });
  }
  return out;
}

/** Boundary wall edges of a space (outline of the union of its rects) with corner extensions. */
export function spaceWallEdges(space: LabSpaceDef, thickness: number): WallEdge[] {
  const rects = space.rects;
  const groups = new Map<string, { side: RawSide; intervals: Interval[] }>();
  rects.forEach((r, i) => {
    for (const side of rectSides(r)) {
      const holes: [number, number][] = [];
      const probe = side.coord + side.out * PROBE;
      rects.forEach((o, j) => {
        if (j === i) return;
        if (side.along === 'x') {
          if (probe > o.minZ && probe < o.maxZ) holes.push([o.minX, o.maxX]);
        } else if (probe > o.minX && probe < o.maxX) {
          holes.push([o.minZ, o.maxZ]);
        }
      });
      const key = `${side.along}|${side.coord.toFixed(4)}|${side.facing}`;
      let g = groups.get(key);
      if (!g) {
        g = { side, intervals: [] };
        groups.set(key, g);
      }
      for (const [a, b] of subtractIntervals(side.from, side.to, holes)) g.intervals.push({ from: a, to: b });
    }
  });

  const edges: WallEdge[] = [];
  for (const { side, intervals } of groups.values()) {
    const n = facingNormal(side.facing);
    for (const iv of mergeIntervals(intervals)) {
      const ext = (end: number, dir: number): number => {
        // Just beyond the end, on the interior side: inside = reflex corner, outside = convex.
        const x = side.along === 'x' ? end + dir * PROBE : side.coord + n.x * PROBE;
        const z = side.along === 'x' ? side.coord + n.z * PROBE : end + dir * PROBE;
        const reflex = insideSpace(rects, x, z);
        if (side.along === 'x') return reflex ? 0 : thickness;
        return reflex ? -thickness : 0;
      };
      edges.push({
        space: space.id,
        along: side.along,
        coord: side.coord,
        from: iv.from,
        to: iv.to,
        facing: side.facing,
        extendFrom: ext(iv.from, -1),
        extendTo: ext(iv.to, 1),
      });
    }
  }
  return edges;
}

/** Opening interval of a doorway along its wall line. */
export function doorwayInterval(d: LabDoorwayDef): Interval {
  const c = d.axis === 'x' ? d.z : d.x;
  return { from: c - d.width / 2, to: c + d.width / 2 };
}

/** Does the doorway cut this wall edge (perpendicular passage, one wall thickness from the midline)? */
export function doorwayCutsEdge(d: LabDoorwayDef, e: WallEdge, thickness: number): boolean {
  if (d.a !== e.space && d.b !== e.space) return false;
  const wallAlong = d.axis === 'x' ? 'z' : 'x';
  if (e.along !== wallAlong) return false;
  const mid = d.axis === 'x' ? d.x : d.z;
  if (Math.abs(Math.abs(mid - e.coord) - thickness) > 0.01) return false;
  const iv = doorwayInterval(d);
  return iv.to > e.from + EPS && iv.from < e.to - EPS;
}

export function edgeOpenings(
  e: WallEdge,
  doorways: readonly LabDoorwayDef[],
  thickness: number,
): { doorway: LabDoorwayDef; interval: Interval }[] {
  const out: { doorway: LabDoorwayDef; interval: Interval }[] = [];
  for (const d of doorways)
    if (doorwayCutsEdge(d, e, thickness)) out.push({ doorway: d, interval: doorwayInterval(d) });
  return out;
}

/** Wall body intervals of an edge (extended / shortened ends, minus openings). */
export function wallBodySegments(e: WallEdge, openings: readonly Interval[]): [number, number][] {
  return subtractIntervals(
    e.from - e.extendFrom,
    e.to + e.extendTo,
    openings.map((o) => [o.from, o.to] as [number, number]),
  );
}

/** Face intervals (trims, strips) minus openings widened by `margin` (door frames). */
export function wallFaceSegments(
  e: WallEdge,
  openings: readonly Interval[],
  margin: number,
): [number, number][] {
  return subtractIntervals(
    e.from,
    e.to,
    openings.map((o) => [o.from - margin, o.to + margin] as [number, number]),
  );
}

/** Non-overlapping floor pieces of a space. */
export function floorPieces(space: LabSpaceDef): Rect[] {
  const out: Rect[] = [];
  space.rects.forEach((r, i) => {
    out.push(...subtractRects(r, space.rects.slice(0, i)));
  });
  return out;
}

export function expandRect(r: RectDef, d: number): Rect {
  return { minX: r.minX - d, maxX: r.maxX + d, minZ: r.minZ - d, maxZ: r.maxZ + d };
}

/** Non-overlapping ceiling pieces (rects expanded by the wall thickness: they cap the walls). */
export function ceilingPieces(space: LabSpaceDef, thickness: number): Rect[] {
  const grown = space.rects.map((r) => expandRect(r, thickness));
  const out: Rect[] = [];
  grown.forEach((r, i) => out.push(...subtractRects(r, grown.slice(0, i))));
  return out;
}

export function rectCenter(r: RectDef): { x: number; z: number } {
  return { x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 };
}

export function findSpace(spaces: readonly LabSpaceDef[], id: string): LabSpaceDef | undefined {
  return spaces.find((s) => s.id === id);
}

/** Space whose rects contain the point (strictly), or undefined. */
export function spaceAt(spaces: readonly LabSpaceDef[], x: number, z: number): LabSpaceDef | undefined {
  return spaces.find((s) => insideSpace(s.rects, x, z));
}

/** Direction of walking from space `a` into space `b` through the doorway. */
export function doorwayFacing(d: LabDoorwayDef, spaces: readonly LabSpaceDef[], thickness: number): Facing {
  const a = findSpace(spaces, d.a);
  const probe = thickness + 0.1;
  if (d.axis === 'x') {
    const aIsWest = a ? insideSpace(a.rects, d.x - probe, d.z) : true;
    return aIsWest ? 'px' : 'nx';
  }
  const aIsNorth = a ? insideSpace(a.rects, d.x, d.z - probe) : true;
  return aIsNorth ? 'pz' : 'nz';
}

/** Wall face point of a wall-mounted spawn (tear / vent), floor level; null for floor tears. */
export function spawnWallPoint(p: LabSpawnPointDef): { x: number; y: number; z: number } | null {
  if (!p.wall) return null;
  const n = facingNormal(p.wall);
  const d = LAB_LAYOUT.spawnTears.wallDistance;
  return { x: p.position[0] - n.x * d, y: p.position[1], z: p.position[2] - n.z * d };
}

/**
 * Intervals along a wall edge where face trims and light strips stop: wall tears and vents of the
 * spawn points on this face and the dock shutter (a strip must not run across them).
 */
export function wallFeatureGaps(e: WallEdge): Interval[] {
  const L = LAB_LAYOUT;
  const margin = L.spawnTears.trimGap;
  const out: Interval[] = [];
  const onEdge = (coord: number, along: number): boolean =>
    Math.abs(coord - e.coord) < EPS && along > e.from - EPS && along < e.to + EPS;
  for (const p of L.spawnPoints) {
    if (p.wall !== e.facing) continue;
    const w = spawnWallPoint(p)!;
    const coord = e.along === 'x' ? w.z : w.x;
    const along = e.along === 'x' ? w.x : w.z;
    if (!onEdge(coord, along)) continue;
    const half = (p.kind === 'vent' ? L.spawnTears.vent.width : RIFT_PORTAL.small.wall.width) / 2 + margin;
    out.push({ from: along - half, to: along + half });
  }
  const S = L.dock.shutter;
  if (e.space === 'dock' && e.facing === 'pz' && onEdge(L.dock.platform.minZ, (S.minX + S.maxX) / 2)) {
    out.push({ from: S.minX - S.frame - margin, to: S.maxX + S.frame + margin });
  }
  return out;
}

/** Undirected adjacency of nodes (spaces or zones) through doorways. */
export function reachable(
  start: string,
  nodes: readonly string[],
  links: readonly [string, string][],
): Set<string> {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const [a, b] of links) {
    adj.get(a)?.push(b);
    adj.get(b)?.push(a);
  }
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const n = queue.shift()!;
    for (const m of adj.get(n) ?? []) {
      if (!seen.has(m)) {
        seen.add(m);
        queue.push(m);
      }
    }
  }
  return seen;
}

/** Zone pairs linked by M4 door slots. */
export function zoneLinks(
  spaces: readonly LabSpaceDef[],
  doorways: readonly LabDoorwayDef[],
): [LabZoneId, LabZoneId][] {
  const out: [LabZoneId, LabZoneId][] = [];
  for (const d of doorways) {
    const za = findSpace(spaces, d.a)?.zone;
    const zb = findSpace(spaces, d.b)?.zone;
    if (za && zb && za !== zb) out.push([za, zb]);
  }
  return out;
}

/** Number of independent loops of the space graph (edges - nodes + components): kiting routes. */
export function cycleCount(nodes: readonly string[], links: readonly [string, string][]): number {
  let components = 0;
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n)) continue;
    components++;
    for (const m of reachable(n, nodes, links)) seen.add(m);
  }
  return links.length - nodes.length + components;
}
