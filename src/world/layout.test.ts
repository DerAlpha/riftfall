/**
 * Layout validation: the Calibration Hall must match the movement capabilities in
 * defs/movement.ts (mantle limits, jump heights, slide physics, slopes) and be self-consistent.
 */
import { describe, expect, it } from 'vitest';
import { LEVEL_KIT, TEST_ROOM_LAYOUT as L, roofUndersideY } from '../defs/level';
import { TEST_ROOM } from '../defs/maps';
import { MATERIALS, isMaterialId } from '../defs/materials';
import { MOVEMENT } from '../defs/movement';
import { jumpDistance, rectContainsPoint, rectsOverlap, slopeDeg, type Rect } from './kitMath';
import {
  corridorRampBottomZ,
  corridorRampRun,
  southStairs,
  testRoomMaterialIds,
  testRoomSolidFootprints,
  westRampRun,
} from './TestRoom';

const jumpPhysics = {
  gravity: MOVEMENT.air.gravity,
  fallGravityMultiplier: MOVEMENT.air.fallGravityMultiplier,
};
const hallRect: Rect = { minX: L.hall.minX, maxX: L.hall.maxX, minZ: L.hall.minZ, maxZ: L.hall.maxZ };

describe('mantle course', () => {
  it('has the four calibration heights, all mantleable from the ground', () => {
    const heights = L.mantle.ledges.map((l) => l.height);
    expect(heights).toEqual([0.6, 1.0, 1.4, 1.7]);
    for (const h of heights) {
      expect(h).toBeGreaterThanOrEqual(MOVEMENT.mantle.minHeight);
      expect(h).toBeLessThanOrEqual(MOVEMENT.mantle.maxHeight);
      // Every ledge is a real obstacle: the character controller cannot simply step onto it.
      expect(h).toBeGreaterThan(MOVEMENT.ground.stepHeight);
    }
  });

  it('ledges are deep enough to stand on after mantling', () => {
    const depth = L.mantle.maxZ - L.mantle.minZ;
    expect(depth).toBeGreaterThan(MOVEMENT.mantle.forwardOffset + MOVEMENT.collider.radius * 2);
    for (const l of L.mantle.ledges) expect(l.maxX - l.minX).toBeGreaterThan(MOVEMENT.collider.radius * 4);
  });
});

describe('double-jump platforms', () => {
  const single = MOVEMENT.jump.height;
  const double = MOVEMENT.jump.height + MOVEMENT.jump.doubleJumpHeight;

  it('sit at 2.3 - 2.6 m: above a single jump, reachable with the double jump (+ ledge catch)', () => {
    for (const p of L.doubleJump.platforms) {
      expect(p.height).toBeGreaterThanOrEqual(2.3);
      expect(p.height).toBeLessThanOrEqual(2.6);
      expect(p.height).toBeGreaterThan(single);
      expect(p.height).toBeLessThanOrEqual(double + MOVEMENT.mantle.maxHeight);
    }
    // At least one platform can be landed on cleanly at the double-jump apex.
    expect(L.doubleJump.platforms.some((p) => p.height <= double)).toBe(true);
  });
});

describe('dash gap', () => {
  const gap = L.pit.rect.maxZ - L.pit.rect.minZ;

  it('is wider than a sprint jump and a slide jump', () => {
    const sprint = jumpDistance(MOVEMENT.ground.sprintSpeed, MOVEMENT.jump.height, 0, jumpPhysics);
    const slide = jumpDistance(
      MOVEMENT.ground.sprintSpeed + MOVEMENT.slide.startBoost,
      MOVEMENT.jump.height,
      0,
      jumpPhysics,
    );
    expect(gap).toBeGreaterThan(sprint);
    expect(gap).toBeGreaterThan(slide);
  });

  it('can be crossed with a sprint jump plus one dash', () => {
    const sprint = jumpDistance(MOVEMENT.ground.sprintSpeed, MOVEMENT.jump.height, 0, jumpPhysics);
    const dash = MOVEMENT.dash.speed * MOVEMENT.dash.duration;
    expect(gap).toBeLessThan(sprint + dash);
  });

  it('pit exit blocks can be climbed with mantles only', () => {
    const tops = [-L.pit.depth, ...L.pit.exitBlocks.map((b) => b.top), 0];
    for (let i = 1; i < tops.length; i++) {
      const rise = tops[i]! - tops[i - 1]!;
      expect(rise).toBeGreaterThanOrEqual(MOVEMENT.mantle.minHeight);
      expect(rise).toBeLessThanOrEqual(MOVEMENT.mantle.maxHeight);
    }
    for (const b of L.pit.exitBlocks) {
      expect(rectContainsPoint(L.pit.rect, b.minX, b.minZ)).toBe(true);
      expect(rectContainsPoint(L.pit.rect, b.maxX, b.maxZ)).toBe(true);
    }
  });
});

describe('ramps and stairs', () => {
  it('slide ramp is steep enough that gravity beats slide deceleration (slide boost)', () => {
    const deg = L.corridor.rampSlopeDeg;
    const along =
      MOVEMENT.air.gravity * Math.sin((deg * Math.PI) / 180) * MOVEMENT.slide.slopeAccelMultiplier;
    expect(along).toBeGreaterThan(MOVEMENT.slide.deceleration);
    expect(deg).toBeGreaterThanOrEqual(MOVEMENT.slide.slopeExtendMinDeg);
    expect(deg).toBeLessThan(MOVEMENT.ground.maxSlopeDeg);
    expect(slopeDeg(L.mezzanine.deckY, corridorRampRun())).toBeCloseTo(deg, 6);
  });

  it('corridor leaves a long flat sprint track after the ramp', () => {
    const flat = corridorRampBottomZ() - L.hall.minZ;
    expect(flat).toBeGreaterThan(25);
  });

  it('west ramp and stairs are walkable', () => {
    expect(L.westRamp.slopeDeg).toBeLessThan(MOVEMENT.ground.maxSlopeDeg);
    expect(slopeDeg(L.mezzanine.deckY, westRampRun())).toBeCloseTo(L.westRamp.slopeDeg, 6);
    const s = southStairs();
    expect(s.stepRise).toBeLessThanOrEqual(MOVEMENT.ground.stepHeight);
    expect(s.slopeDeg).toBeLessThan(MOVEMENT.ground.maxSlopeDeg);
    expect(s.stepRise * s.steps).toBeCloseTo(L.mezzanine.deckY, 9);
    // Stairs end inside the hall.
    expect(L.stairs.topZ + s.totalRun).toBeLessThan(L.hall.maxZ);
  });
});

describe('clearances', () => {
  it('lets the player jump under the mezzanine and double jump above it', () => {
    const under = L.mezzanine.deckY - L.mezzanine.deckThickness;
    expect(under).toBeGreaterThan(MOVEMENT.collider.standHeight + MOVEMENT.jump.height);
    const lowestBeam = roofUndersideY(L.hall.maxZ) - L.roof.beamSize[1];
    const reach =
      L.mezzanine.deckY +
      MOVEMENT.collider.standHeight +
      MOVEMENT.jump.height +
      MOVEMENT.jump.doubleJumpHeight;
    expect(lowestBeam).toBeGreaterThan(reach);
  });

  it('keeps the spawn inside the hall, on open floor, facing the arena', () => {
    const [x, , z] = L.spawn.position;
    expect(rectContainsPoint(hallRect, x, z)).toBe(true);
    expect(rectContainsPoint(L.pit.rect, x, z)).toBe(false);
    const r = MOVEMENT.collider.radius;
    const probe: Rect = { minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r };
    for (const solid of testRoomSolidFootprints()) expect(rectsOverlap(probe, solid)).toBe(false);
    // Yaw 0 looks down -Z; the arena center lies in that direction.
    const arenaZ = (L.arena.rect.minZ + L.arena.rect.maxZ) / 2;
    expect(L.spawn.yawDeg).toBe(0);
    expect(arenaZ).toBeLessThan(z);
  });

  it('keeps dynamic crates out of solids and the pit', () => {
    for (const c of L.crates) {
      const h = c.size / 2;
      const r: Rect = {
        minX: c.position[0] - h,
        maxX: c.position[0] + h,
        minZ: c.position[2] - h,
        maxZ: c.position[2] + h,
      };
      expect(rectContainsPoint(hallRect, c.position[0], c.position[2])).toBe(true);
      if (!c.dynamic) continue;
      expect(rectsOverlap(r, L.pit.rect)).toBe(false);
      for (const solid of testRoomSolidFootprints()) expect(rectsOverlap(r, solid)).toBe(false);
    }
  });
});

describe('lighting layout', () => {
  it('skylight shafts land inside the hall (sun direction from the atmosphere)', () => {
    const [dx, dy, dz] = TEST_ROOM.sun.direction;
    expect(dy).toBeLessThan(0);
    for (const s of L.roof.skylights) {
      for (const [x, z] of [
        [s.minX, s.minZ],
        [s.maxX, s.maxZ],
      ] as const) {
        const y = roofUndersideY(z);
        const t = y / -dy;
        expect(rectContainsPoint(hallRect, x + dx * t, z + dz * t)).toBe(true);
      }
      expect(rectContainsPoint(hallRect, s.minX, s.minZ)).toBe(true);
      expect(rectContainsPoint(hallRect, s.maxX, s.maxZ)).toBe(true);
    }
  });

  it('places every light inside the hall below the roof', () => {
    const all = [...L.lights.spots.map((s) => s.position), ...L.lights.points.map((p) => p.position)];
    for (const [x, y, z] of all) {
      expect(rectContainsPoint(hallRect, x, z)).toBe(true);
      expect(y).toBeLessThan(roofUndersideY(z));
    }
    for (const s of L.lights.spots) {
      if (s.shadowPriority !== null) expect(s.shadowPriority).toBeGreaterThan(0);
      expect(s.angleDeg).toBeGreaterThan(0);
      expect(s.angleDeg).toBeLessThan(90);
    }
  });

  it('keeps wall screens below the light strip', () => {
    for (const s of L.screens) {
      const top = s.position[1] + s.height / 2 + LEVEL_KIT.screen.bezel;
      expect(top).toBeLessThan(L.hall.lightStripY - LEVEL_KIT.trim.stripHousingHeight / 2);
    }
  });

  it('does not overlap doors on the same wall', () => {
    const frame = LEVEL_KIT.door.frameWidth;
    for (let i = 0; i < L.doors.length; i++) {
      for (let j = i + 1; j < L.doors.length; j++) {
        const a = L.doors[i]!;
        const b = L.doors[j]!;
        if (a.facing !== b.facing) continue;
        const along = a.facing === 'px' || a.facing === 'nx' ? 2 : 0;
        const gap = Math.abs(a.position[along]! - b.position[along]!);
        expect(gap).toBeGreaterThan(a.width / 2 + b.width / 2 + frame * 2);
      }
    }
  });
});

describe('materials', () => {
  it('only references defined materials', () => {
    const ids = testRoomMaterialIds();
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(isMaterialId(id)).toBe(true);
    expect(Object.keys(MATERIALS)).toEqual(expect.arrayContaining(ids));
  });
});
