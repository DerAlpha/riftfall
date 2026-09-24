/**
 * Pure validation of the research lab layout (defs/labLayout.ts): bounds, space separation,
 * doorway geometry and widths, zone connectivity and kiting loops, spawn point placement, ramp
 * slopes and stair rises. The physics / navmesh checks of the built level live in
 * ResearchLab.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { FOG_VOLUME, LAB_LAYOUT as L, type LabDoorwayDef } from '../../defs/labLayout';
import { MOVEMENT } from '../../defs/movement';
import { LEVEL_KIT } from '../../defs/level';
import { NAV } from '../../defs/nav';
import { SPAWN_POINTS } from '../../defs/waves';
import { labDoorSlots, labSpawnPoints, spawnWallPoint } from './ResearchLab';
import { atriumRampRun, atriumStairs, atriumStairsRect, dockRampRun } from './labRooms';
import {
  cycleCount,
  doorwayCutsEdge,
  doorwayInterval,
  facingNormal,
  findSpace,
  reachable,
  spaceAt,
  spaceWallEdges,
  wallFeatureGaps,
  zoneLinks,
} from './labSpaces';

const T = L.wallThickness;
/** Narrowest passage on intended paths (m). */
const MIN_PASSAGE = 1.2;
/** Steepest walkable ramp (deg) and highest stair step (m) of the spec. */
const MAX_RAMP_DEG = 35;
const MAX_STEP_RISE = 0.2;
/** Door leaves (M4) must let a tank (2.4 m) through with room to spare. */
const MIN_DOOR_HEIGHT = 3;
const EPS = 1e-6;

function rectsOverlap(
  a: { minX: number; maxX: number; minZ: number; maxZ: number },
  b: { minX: number; maxX: number; minZ: number; maxZ: number },
  margin: number,
): boolean {
  return (
    a.minX < b.maxX + margin - EPS &&
    b.minX < a.maxX + margin - EPS &&
    a.minZ < b.maxZ + margin - EPS &&
    b.minZ < a.maxZ + margin - EPS
  );
}

describe('research lab layout', () => {
  it('spans about 70 × 60 m and keeps every space inside the bounds', () => {
    const b = L.bounds;
    expect(b.maxX - b.minX).toBeCloseTo(70, 6);
    expect(b.maxZ - b.minZ).toBeCloseTo(60, 6);
    for (const s of L.spaces) {
      for (const r of s.rects) {
        expect(r.minX, s.id).toBeGreaterThanOrEqual(b.minX);
        expect(r.maxX, s.id).toBeLessThanOrEqual(b.maxX);
        expect(r.minZ, s.id).toBeGreaterThanOrEqual(b.minZ);
        expect(r.maxZ, s.id).toBeLessThanOrEqual(b.maxZ);
        expect(r.maxX - r.minX, s.id).toBeGreaterThanOrEqual(MIN_PASSAGE);
        expect(r.maxZ - r.minZ, s.id).toBeGreaterThanOrEqual(MIN_PASSAGE);
      }
    }
  });

  it('has unique ids and known zones / themes', () => {
    const ids = L.spaces.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const zones = new Set(L.zones.map((z) => z.id));
    for (const s of L.spaces) {
      expect(zones.has(s.zone), s.id).toBe(true);
      expect(L.themes[s.theme], s.id).toBeDefined();
      expect(s.ceiling, s.id).toBeGreaterThan(MIN_DOOR_HEIGHT);
    }
    const doorIds = L.doorways.map((d) => d.id);
    expect(new Set(doorIds).size).toBe(doorIds.length);
  });

  it('leaves room for two walls between neighbouring spaces (walls never cut into another space)', () => {
    for (let i = 0; i < L.spaces.length; i++) {
      for (let j = i + 1; j < L.spaces.length; j++) {
        const a = L.spaces[i]!;
        const b = L.spaces[j]!;
        for (const ra of a.rects) {
          for (const rb of b.rects) {
            expect(rectsOverlap(ra, rb, 2 * T), `${a.id} / ${b.id}`).toBe(false);
          }
        }
      }
    }
  });

  it('cuts every doorway through exactly one wall of each side, wide and high enough, with room for the frame', () => {
    for (const d of L.doorways) {
      expect(d.a).not.toBe(d.b);
      const a = findSpace(L.spaces, d.a);
      const b = findSpace(L.spaces, d.b);
      expect(a, d.id).toBeDefined();
      expect(b, d.id).toBeDefined();
      expect(d.width, d.id).toBeGreaterThanOrEqual(MIN_PASSAGE);
      expect(d.height, d.id).toBeGreaterThanOrEqual(MIN_DOOR_HEIGHT);
      expect(d.height, d.id).toBeLessThan(Math.min(a!.ceiling, b!.ceiling));
      const iv = doorwayInterval(d);
      for (const s of [a!, b!]) {
        const cut = spaceWallEdges(s, T).filter((e) => doorwayCutsEdge(d, e, T));
        expect(cut.length, `${d.id} → ${s.id}`).toBe(1);
        const e = cut[0]!;
        // The opening and both frame posts lie on this wall face.
        expect(iv.from - L.doorFrame.postWidth, `${d.id} → ${s.id}`).toBeGreaterThanOrEqual(e.from - EPS);
        expect(iv.to + L.doorFrame.postWidth, `${d.id} → ${s.id}`).toBeLessThanOrEqual(e.to + EPS);
      }
      // Stepping through the passage leads from one space into the other.
      const n = d.axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
      const probe = T + 0.5;
      const before = spaceAt(L.spaces, d.x - n.x * probe, d.z - n.z * probe)?.id;
      const after = spaceAt(L.spaces, d.x + n.x * probe, d.z + n.z * probe)?.id;
      expect([before, after].sort(), d.id).toEqual([d.a, d.b].sort());
    }
  });

  it('connects every space and zone, with several loops to kite enemies', () => {
    const spaceIds = L.spaces.map((s) => s.id);
    const links = L.doorways.map((d) => [d.a, d.b] as [string, string]);
    expect(reachable(L.spaces[0]!.id, spaceIds, links).size).toBe(spaceIds.length);
    // Kiting loops: independent cycles through the space graph (atrium ring routes around).
    expect(cycleCount(spaceIds, links)).toBeGreaterThanOrEqual(3);

    const zoneIds = L.zones.map((z) => z.id);
    const zl = zoneLinks(L.spaces, L.doorways);
    expect(reachable('reception', zoneIds, zl).size).toBe(zoneIds.length);
    // Zones only meet at M4 door slots (a zone is bought open door by door).
    for (const d of L.doorways) {
      const za = findSpace(L.spaces, d.a)!.zone;
      const zb = findSpace(L.spaces, d.b)!.zone;
      expect(d.slot, d.id).toBe(za !== zb);
      expect(d.costHint > 0, d.id).toBe(d.slot);
    }
    // Every zone except the start has at least two entrances (no dead-end zone).
    for (const z of zoneIds) {
      if (z === 'reception') continue;
      expect(zl.filter(([a, b]) => a === z || b === z).length, z).toBeGreaterThanOrEqual(2);
    }
  });

  it('exposes door slots that face from zone A into zone B', () => {
    const slots = labDoorSlots();
    expect(slots.length).toBe(L.doorways.filter((d) => d.slot).length);
    for (const s of slots) {
      const n = facingNormal(s.facing);
      expect(Math.sin(s.yaw), s.id).toBeCloseTo(n.x, 6);
      expect(Math.cos(s.yaw), s.id).toBeCloseTo(n.z, 6);
      const probe = T + 0.5;
      expect(spaceAt(L.spaces, s.position.x + n.x * probe, s.position.z + n.z * probe)?.zone, s.id).toBe(
        s.zoneB,
      );
      expect(spaceAt(L.spaces, s.position.x - n.x * probe, s.position.z - n.z * probe)?.zone, s.id).toBe(
        s.zoneA,
      );
      expect(s.depth).toBeCloseTo(2 * T, 6);
    }
  });

  it('places 12–18 spawn points in every zone, on floor inside their zone, facing into the room', () => {
    const points = labSpawnPoints();
    expect(points.length).toBeGreaterThanOrEqual(12);
    expect(points.length).toBeLessThanOrEqual(18);
    expect(new Set(points.map((p) => p.id)).size).toBe(points.length);
    for (const z of L.zones)
      expect(
        points.some((p) => p.zone === z.id),
        z.id,
      ).toBe(true);
    const b = L.bounds;
    for (const p of points) {
      const { x, y, z } = p.position;
      expect(x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ, p.id).toBe(true);
      expect(spaceAt(L.spaces, x, z)?.zone, p.id).toBe(p.zone);
      expect(Number.isFinite(p.yaw), p.id).toBe(true);
      // Floor level, or the dock platform for the shutter rift.
      expect([0, L.dock.platform.height], p.id).toContain(y);
    }
    for (const def of L.spawnPoints) {
      if (!def.wall) continue;
      // The tear / vent sits on a wall face of the point's space with the same interior facing.
      const w = spawnWallPoint(def)!;
      const space = spaceAt(L.spaces, def.position[0], def.position[2])!;
      const onWall = spaceWallEdges(space, T).some((e) => {
        if (e.facing !== def.wall) return false;
        const coord = e.along === 'x' ? w.z : w.x;
        const along = e.along === 'x' ? w.x : w.z;
        return Math.abs(coord - e.coord) < 1e-6 && along > e.from && along < e.to;
      });
      // The dock shutter tear stands in front of the shutter on the platform's back wall.
      if (def.tearOffset === undefined) expect(onWall, def.id).toBe(true);
    }
  });

  it('lets enemies emerge facing into the room', () => {
    for (const p of labSpawnPoints()) {
      const space = spaceAt(L.spaces, p.position.x, p.position.z)!;
      const def = L.spawnPoints.find((d) => d.id === p.id)!;
      // Wall tears / vents face along the interior normal; floor tears face open floor.
      const reach = def.wall ? 1.5 : 5;
      const x = p.position.x + Math.sin(p.yaw) * reach;
      const z = p.position.z + Math.cos(p.yaw) * reach;
      expect(spaceAt(L.spaces, x, z)?.id, p.id).toBe(space.id);
      if (def.wall) {
        const n = facingNormal(def.wall);
        expect(Math.sin(p.yaw), p.id).toBeCloseTo(n.x, 6);
        expect(Math.cos(p.yaw), p.id).toBeCloseTo(n.z, 6);
      }
    }
  });

  it('interrupts wall trims and light strips at every wall tear, vent and the dock shutter', () => {
    const gaps = L.spaces.flatMap((s) => spaceWallEdges(s, T).flatMap((e) => wallFeatureGaps(e)));
    const wallSpawns = L.spawnPoints.filter((p) => p.wall !== null).length;
    // One gap per wall tear / vent (each sits on exactly one wall face) + the shutter.
    expect(gaps.length).toBe(wallSpawns + 1);
    const S = L.dock.shutter;
    expect(gaps.some((g) => g.from < S.minX && g.to > S.maxX)).toBe(true);
    for (const g of gaps) expect(g.to - g.from).toBeGreaterThan(2 * L.spawnTears.trimGap);
  });

  it('keeps the reception spawn points out of the spawn selection minimum distance of the player spawn', () => {
    const s = L.spawn.position;
    expect(spaceAt(L.spaces, s[0], s[2])?.zone).toBe('reception');
    for (const p of L.spawnPoints) {
      if (p.zone !== 'reception') continue;
      const d = Math.hypot(p.position[0] - s[0], p.position[1] - s[1], p.position[2] - s[2]);
      expect(d, p.id).toBeGreaterThanOrEqual(SPAWN_POINTS.minDistance);
    }
  });

  it('keeps fog volume faces away from the standing eye height (no inside / outside flicker)', () => {
    const eye = MOVEMENT.collider.standEyeHeight;
    const D = L.atrium.dais;
    const P = L.dock.platform;
    // Floors a player stands on for longer: [minX, maxX, minZ, maxZ, floor height].
    const floors: [number, number, number, number, number][] = [
      ...L.spaces.flatMap((s) =>
        s.rects.map((r) => [r.minX, r.maxX, r.minZ, r.maxZ, 0] as [number, number, number, number, number]),
      ),
      [D.minX, D.maxX, D.minZ, D.maxZ, D.height],
      [P.minX, P.maxX, P.minZ, P.maxZ, P.height],
      ...L.atrium.planters.map(
        (p) => [p.minX, p.maxX, p.minZ, p.maxZ, p.height] as [number, number, number, number, number],
      ),
    ];
    for (const v of L.fogVolumes) {
      for (const [x0, x1, z0, z1, y] of floors) {
        const overlaps = x0 < v.max[0] && x1 > v.min[0] && z0 < v.max[2] && z1 > v.min[2];
        if (!overlaps) continue;
        for (const face of [v.min[1], v.max[1]]) {
          expect(Math.abs(y + eye - face), `${v.id} @ floor ${y}`).toBeGreaterThanOrEqual(
            FOG_VOLUME.eyeClearance,
          );
        }
      }
    }
  });

  it('keeps ramps walkable and stair steps low', () => {
    for (const deg of [L.atrium.ramp.slopeDeg, L.dock.ramp.slopeDeg]) {
      expect(deg).toBeGreaterThan(0);
      expect(deg).toBeLessThanOrEqual(Math.min(MAX_RAMP_DEG, NAV.build.walkableSlopeDeg));
    }
    expect(atriumRampRun()).toBeCloseTo(
      L.atrium.ring.deckY / Math.tan((L.atrium.ramp.slopeDeg * Math.PI) / 180),
      6,
    );
    expect(dockRampRun()).toBeGreaterThan(L.dock.platform.height);
    const s = atriumStairs();
    expect(s.stepRise).toBeLessThanOrEqual(MAX_STEP_RISE + EPS);
    expect(LEVEL_KIT.stairs.maxStepRise).toBeLessThanOrEqual(MAX_STEP_RISE);
    expect(s.steps * s.stepRise).toBeCloseTo(L.atrium.ring.deckY, 6);
    // The dais is a single step enemies climb.
    expect(L.atrium.dais.height).toBeLessThanOrEqual(NAV.build.agentClimb);
  });

  it('fits the stairs, the ramp and the dais inside the atrium, clear of the ring supports', () => {
    const atrium = findSpace(L.spaces, 'atrium')!.rects[0]!;
    const ringInner = L.atrium.ring.width;
    const rects = [
      ...L.atrium.stairs.map(atriumStairsRect),
      {
        minX: L.atrium.ramp.topX,
        maxX: L.atrium.ramp.topX + atriumRampRun(),
        minZ: L.atrium.ramp.minZ,
        maxZ: L.atrium.ramp.maxZ,
      },
      L.atrium.dais,
    ];
    for (const r of rects) {
      expect(r.minX).toBeGreaterThanOrEqual(atrium.minX);
      expect(r.maxX).toBeLessThanOrEqual(atrium.maxX);
      expect(r.minZ).toBeGreaterThanOrEqual(atrium.minZ);
      expect(r.maxZ).toBeLessThanOrEqual(atrium.maxZ);
      expect(Math.min(r.maxX - r.minX, r.maxZ - r.minZ)).toBeGreaterThanOrEqual(MIN_PASSAGE);
      const hs = L.atrium.ring.supportSize / 2;
      for (const [x, z] of L.atrium.ring.supports) {
        expect(rectsOverlap(r, { minX: x - hs, maxX: x + hs, minZ: z - hs, maxZ: z + hs }, 0)).toBe(false);
      }
    }
    // Stairs arrive at the ring deck edge (top step meets the inner ring edge).
    for (const st of L.atrium.stairs) {
      const edge = st.dir > 0 ? atrium.maxZ - ringInner : atrium.minZ + ringInner;
      expect(st.topZ).toBeCloseTo(edge, 6);
    }
    expect(L.atrium.ramp.topX).toBeCloseTo(atrium.minX + ringInner, 6);
  });

  it('keeps passages between furniture at least 1.2 m wide', () => {
    // Lab aisle between the cubicle rows, cubicle openings.
    const west = Math.max(...L.labs.cubicles.filter((c) => c.front === 'px').map((c) => c.maxX));
    const east = Math.min(...L.labs.cubicles.filter((c) => c.front === 'nx').map((c) => c.minX));
    expect(east - west).toBeGreaterThanOrEqual(MIN_PASSAGE);
    for (const c of L.labs.cubicles) {
      expect(c.openingWidth).toBeGreaterThanOrEqual(MIN_PASSAGE);
      expect(c.opening - c.openingWidth / 2).toBeGreaterThan(c.minZ);
      expect(c.opening + c.openingWidth / 2).toBeLessThan(c.maxZ);
    }
    // Server aisles between the rack rows and between the rack blocks.
    const rows = [...L.server.rows].sort((a, b) => a - b);
    for (let i = 1; i < rows.length; i++)
      expect(rows[i]! - rows[i - 1]! - L.server.rackDepth).toBeGreaterThanOrEqual(MIN_PASSAGE);
    const blocks = [...L.server.blocks].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < blocks.length; i++)
      expect(blocks[i]![0] - blocks[i - 1]![1]).toBeGreaterThanOrEqual(MIN_PASSAGE);
    // No player-only slot between the racks and the walls (a hiding spot enemies cannot enter).
    const server = findSpace(L.spaces, 'server')!.rects[0]!;
    expect(blocks[0]![0] - server.minX).toBeGreaterThanOrEqual(MIN_PASSAGE);
    expect(server.maxX - blocks[blocks.length - 1]![1]).toBeGreaterThanOrEqual(MIN_PASSAGE);
    expect(rows[0]! - L.server.rackDepth / 2 - server.minZ).toBeGreaterThanOrEqual(MIN_PASSAGE);
    // Cryo pods.
    const P = L.cryo.pod;
    const podD = 2 * (P.radius + P.rimExtra);
    const xs = [...L.cryo.podX].sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++)
      expect(xs[i]! - xs[i - 1]! - podD).toBeGreaterThanOrEqual(MIN_PASSAGE);
    // Nothing blocks a doorway approach: furniture keeps clear of every passage by MIN_PASSAGE.
    const furniture = [
      L.reception.desk,
      ...L.reception.planters,
      ...L.atrium.planters,
      ...L.labs.benches,
      L.atrium.dais,
    ];
    for (const d of L.doorways) {
      const approach = doorApproach(d, MIN_PASSAGE);
      for (const f of furniture) expect(rectsOverlap(approach, f, 0), d.id).toBe(false);
    }
  });
});

/** Rect in front of and behind a doorway, `depth` deep on both sides beyond the wall gap. */
function doorApproach(
  d: LabDoorwayDef,
  depth: number,
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const half = d.width / 2;
  const reach = T + depth;
  return d.axis === 'x'
    ? { minX: d.x - reach, maxX: d.x + reach, minZ: d.z - half, maxZ: d.z + half }
    : { minX: d.x - half, maxX: d.x + half, minZ: d.z - reach, maxZ: d.z + reach };
}
