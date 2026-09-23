/**
 * "Calibration Hall" – the M1 movement sandbox. Pure data-to-geometry: every dimension comes from
 * TEST_ROOM_LAYOUT (defs/level.ts), materials from defs/materials.ts, atmosphere from TEST_ROOM.
 *
 * Draw-call budget: static geometry is merged per material (≈25 meshes), + dynamic crates,
 * 6 volumetric cones, 1 shaft mesh, 1 dust system. Lights: 6 spots (shadow budget from
 * QUALITY_LEVELS.shadows) + 5 points, staggered shadow refresh.
 */
import * as THREE from 'three';
import type { LevelBuildContext, LevelBuilder, LevelInstance } from '../core/contracts';
import { createLogger } from '../core/log';
import { DEG2RAD, noise1D } from '../core/math';
import { QUALITY_LEVELS } from '../defs/graphics';
import {
  DUST,
  FLICKER,
  LEVEL_KIT,
  TEST_ROOM_LAYOUT,
  VOLUMETRIC_CONE,
  VOLUMETRIC_SHAFT,
  roofUndersideY,
  type Facing,
} from '../defs/level';
import { TEST_ROOM, type MapAtmosphereDef } from '../defs/maps';
import { getMaterialDef, type MaterialId } from '../defs/materials';
import type { GraphicsSettings, QualityLevel } from '../save/settingsSchema';
import { DustParticles, dustRegionsWithCones } from '../render/vfx/DustParticles';
import {
  VolumetricCone,
  VolumetricShafts,
  type BoxVolume,
  type ConeVolume,
  type ShaftSegment,
  type TimeUniform,
} from '../render/vfx/VolumetricCone';
import { LevelKit, WallFrame, facingBasis, type LightHandle } from './LevelKit';
import {
  flickerFactor,
  reducedFlickerFactor,
  runForSlope,
  stairsLayout,
  subtractIntervals,
  subtractRects,
  type Rect,
} from './kitMath';

const log = createLogger('TestRoom');

const L = TEST_ROOM_LAYOUT;
const M = L.materials;
const H = L.hall;
const PC = H.pilasterClearance;
const DECAL = LEVEL_KIT.decal;

/** Ramp run of the corridor slide ramp (from the deck down to the corridor floor). */
export function corridorRampRun(): number {
  return runForSlope(L.mezzanine.deckY, L.corridor.rampSlopeDeg);
}

export function corridorRampBottomZ(): number {
  return L.corridor.deckMinZ - corridorRampRun();
}

export function westRampRun(): number {
  return runForSlope(L.mezzanine.deckY, L.westRamp.slopeDeg);
}

export function southStairs(): ReturnType<typeof stairsLayout> {
  return stairsLayout(L.mezzanine.deckY, LEVEL_KIT.stairs.maxStepRise, LEVEL_KIT.stairs.stepRun);
}

/** Every material id the test room uses (for preloading). */
export function testRoomMaterialIds(): MaterialId[] {
  const ids = new Set<MaterialId>(Object.values(M));
  ids.add(LEVEL_KIT.railing.material);
  return [...ids];
}

/** Solid footprints at floor level (used by layout validation tests). */
export function testRoomSolidFootprints(): Rect[] {
  const out: Rect[] = [];
  const c = L.corridor;
  out.push({ minX: c.laneMinX, maxX: c.laneMaxX, minZ: c.deckMinZ, maxZ: H.maxZ });
  for (const l of L.mantle.ledges)
    out.push({ minX: l.minX, maxX: l.maxX, minZ: L.mantle.minZ, maxZ: L.mantle.maxZ });
  const s = L.doubleJump.size / 2;
  for (const p of L.doubleJump.platforms)
    out.push({ minX: p.x - s, maxX: p.x + s, minZ: p.z - s, maxZ: p.z + s });
  for (const cv of L.arena.cover) {
    out.push({
      minX: cv.center[0] - cv.size[0] / 2,
      maxX: cv.center[0] + cv.size[0] / 2,
      minZ: cv.center[1] - cv.size[2] / 2,
      maxZ: cv.center[1] + cv.size[2] / 2,
    });
  }
  const ps = L.arena.pillarSize / 2;
  for (const [x, z] of L.arena.pillars) out.push({ minX: x - ps, maxX: x + ps, minZ: z - ps, maxZ: z + ps });
  return out;
}

const _dir = new THREE.Vector3();
const _color = new THREE.Color();

function color3(c: readonly [number, number, number]): THREE.Color {
  return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
}

// ---------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------

interface Flickering {
  handle: LightHandle;
  cone: VolumetricCone | null;
  seed: number;
}

/** Optional MaterialLibrary extension (duck-typed: the contract only guarantees MaterialLibraryApi). */
interface GraphicsSettingsSink {
  applyGraphicsSettings?(g: GraphicsSettings): void;
}

class TestRoomInstance implements LevelInstance {
  readonly id = TEST_ROOM.id;
  readonly atmosphere: MapAtmosphereDef = TEST_ROOM;
  readonly root: THREE.Object3D;
  readonly spawn: { position: THREE.Vector3; yaw: number };
  private readonly unsubscribe: (() => void)[] = [];
  private volumetricsLevel: QualityLevel | null = null;
  /** Accessibility "reduce flashing": faulty lights only dim gently instead of strobing. */
  private reduceFlashing: boolean;
  private disposed = false;
  /** Reused by the stats getter (the debug overlay polls it every frame). */
  private readonly statsOut = { meshes: 0, lights: 0, colliders: 0, dynamicBodies: 0 };
  /** Stable arrays handed to the dust system (no per-frame allocation). */
  private readonly coneVolumes: ConeVolume[];
  private readonly boxVolumes: BoxVolume[];

  constructor(
    private readonly kit: LevelKit,
    private readonly cones: VolumetricCone[],
    private readonly shafts: VolumetricShafts | null,
    private readonly dust: DustParticles | null,
    private readonly flickering: Flickering[],
    private readonly time: TimeUniform,
    ctx: LevelBuildContext,
  ) {
    this.root = kit.root;
    this.coneVolumes = cones.map((c) => c.volume);
    this.boxVolumes = shafts ? shafts.volumes : [];
    const sp = L.spawn.position;
    this.spawn = { position: new THREE.Vector3(sp[0], sp[1], sp[2]), yaw: L.spawn.yawDeg * DEG2RAD };
    this.reduceFlashing = ctx.settings.current.accessibility.reduceFlashing;
    const g = ctx.settings.current.graphics;
    kit.applyShadowQuality(g.shadows);
    this.applyVolumetrics(g.volumetrics);
    // The composition root may construct the MaterialLibrary without the event bus (the contract
    // constructor has no events): forward graphics changes so anisotropy / texture quality still
    // apply. applyGraphicsSettings is idempotent, so a library that listens itself is unaffected.
    const materials = ctx.materials as GraphicsSettingsSink;
    this.unsubscribe.push(
      ctx.events.on('settings:changed', ({ settings, sections }) => {
        if (sections.includes('accessibility')) this.reduceFlashing = settings.accessibility.reduceFlashing;
        if (!sections.includes('graphics')) return;
        if (settings.graphics.shadows !== kit.shadowQuality)
          kit.applyShadowQuality(settings.graphics.shadows);
        this.applyVolumetrics(settings.graphics.volumetrics);
        if (typeof materials.applyGraphicsSettings === 'function') {
          materials.applyGraphicsSettings(settings.graphics);
        }
      }),
    );
  }

  get stats(): LevelInstance['stats'] {
    const k = this.kit;
    const out = this.statsOut;
    out.meshes = k.meshes.length + this.cones.length + (this.shafts ? 1 : 0) + (this.dust ? 1 : 0);
    out.lights = k.lights.length;
    out.colliders = k.colliders.length + k.bodies.length;
    out.dynamicBodies = k.bodies.length;
    return out;
  }

  update(_dt: number, time: number): void {
    if (this.disposed) return;
    this.time.value = time;
    if (this.flickering.length > 0) {
      for (let i = 0; i < this.flickering.length; i++) {
        const f = this.flickering[i]!;
        const k = this.reduceFlashing
          ? reducedFlickerFactor(time, f.seed, FLICKER.reduced, noise1D)
          : flickerFactor(time, f.seed, FLICKER, noise1D);
        f.handle.light.intensity = f.handle.baseIntensity * k;
        const panel = f.handle.panel;
        if (panel)
          (panel.material as THREE.MeshStandardMaterial).emissiveIntensity = f.handle.panelBaseIntensity * k;
        f.cone?.setIntensityScale(k);
      }
      if (this.dust && this.dust.points.visible) this.syncDustVolumes();
    }
    this.kit.updateShadows();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    for (const c of this.cones) c.dispose();
    this.shafts?.dispose();
    this.dust?.dispose();
    this.kit.dispose();
  }

  private applyVolumetrics(level: QualityLevel): void {
    if (level === this.volumetricsLevel) return;
    this.volumetricsLevel = level;
    const params = QUALITY_LEVELS.volumetrics[level];
    const cones = params !== null && params.cones;
    for (const c of this.cones) c.mesh.visible = cones;
    if (this.shafts) this.shafts.mesh.visible = cones;
    if (this.dust) {
      this.dust.setCount(params ? DUST.baseCount * params.dust : 0);
      this.syncDustVolumes();
    }
  }

  private syncDustVolumes(): void {
    this.dust?.setVolumes(this.coneVolumes, this.boxVolumes);
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export const buildTestRoom: LevelBuilder = async (ctx) => {
  const t0 = performance.now();
  ctx.onProgress('Generiere Materialien…', 0);
  await ctx.materials.preload(testRoomMaterialIds(), (done, total) =>
    ctx.onProgress(
      'Generiere Materialien…',
      total > 0 ? (L.progress.materials * done) / total : L.progress.materials,
    ),
  );

  ctx.onProgress('Baue Kalibrierhalle…', L.progress.geometry);
  await nextTick();
  const render = ctx.render as Partial<LevelBuildContext['render']> | undefined;
  const kit = new LevelKit({
    physics: ctx.physics,
    materials: ctx.materials,
    name: 'CalibrationHall',
    setupMaterial:
      typeof render?.setupMaterial === 'function' ? (m) => ctx.render.setupMaterial(m) : undefined,
  });

  buildFloors(kit);
  buildWalls(kit);
  buildRoof(kit);
  buildArena(kit);
  buildMezzanine(kit);
  buildCorridor(kit);
  buildMantleCourse(kit);
  buildDoubleJump(kit);
  buildPit(kit);
  buildDressing(kit);

  ctx.onProgress('Richte Beleuchtung ein…', L.progress.lights);
  await nextTick();
  const lights = buildLights(kit);
  kit.build();

  ctx.onProgress('Volumetrisches Licht…', L.progress.volumetrics);
  const time: TimeUniform = { value: 0 };
  const cones = buildCones(kit, lights.spots, time);
  const shafts = buildShafts(kit, time);
  for (const c of cones) kit.root.add(c.cone.mesh);
  if (shafts) kit.root.add(shafts.mesh);
  const maxDust = Math.ceil(DUST.baseCount * maxDustMultiplier());
  const dustRegions = dustRegionsWithCones(
    L.dust,
    cones.map((c) => c.cone.volume),
    DUST.coneShare,
    DUST.regionFloorLift,
  );
  const dust = maxDust > 0 ? new DustParticles({ regions: dustRegions, maxCount: maxDust, time }) : null;
  if (dust) kit.root.add(dust.points);

  const flickering: Flickering[] = [];
  lights.spots.forEach((s, i) => {
    if (s.def.flicker)
      flickering.push({
        handle: s.handle,
        cone: cones.find((c) => c.source === i)?.cone ?? null,
        seed: i + 1,
      });
  });
  lights.points.forEach((p, i) => {
    if (p.def.flicker) flickering.push({ handle: p.handle, cone: null, seed: 101 + i });
  });

  const instance = new TestRoomInstance(
    kit,
    cones.map((c) => c.cone),
    shafts,
    dust,
    flickering,
    time,
    ctx,
  );
  kit.root.updateMatrixWorld(true);
  const s = instance.stats;
  log.info(
    `Calibration Hall built in ${(performance.now() - t0).toFixed(0)} ms: ${s.meshes} meshes, ` +
      `${kit.stats.triangles} tris, ${s.lights} lights, ${s.colliders} colliders`,
  );
  ctx.onProgress('Bereit', 1);
  return instance;
};

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function maxDustMultiplier(): number {
  let m = 0;
  for (const v of Object.values(QUALITY_LEVELS.volumetrics)) if (v) m = Math.max(m, v.dust);
  return m;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function buildFloors(kit: LevelKit): void {
  const hall: Rect = { minX: H.minX, maxX: H.maxX, minZ: H.minZ, maxZ: H.maxZ };
  const arena = L.arena.rect;
  const c = L.corridor;
  const lane: Rect = { minX: c.laneMinX, maxX: c.laneMaxX, minZ: H.minZ, maxZ: H.maxZ };
  for (const r of subtractRects(hall, [arena, lane, L.pit.rect])) {
    kit.floor(M.floor, r.minX, r.minZ, r.maxX, r.maxZ, 0);
  }
  kit.floor(M.arenaFloor, arena.minX, arena.minZ, arena.maxX, arena.maxZ, 0);
  kit.floor(M.corridorFloor, lane.minX, lane.minZ, lane.maxX, corridorRampBottomZ(), 0);

  // Hazard border around the arena plates.
  const b = L.arena.borderWidth;
  kit.marking(M.hazard, arena.minX, arena.minZ, arena.maxX, arena.minZ + b, 0);
  kit.marking(M.hazard, arena.minX, arena.maxZ - b, arena.maxX, arena.maxZ, 0);
  kit.marking(M.hazard, arena.minX, arena.minZ + b, arena.minX + b, arena.maxZ - b, 0);
  kit.marking(M.hazard, arena.maxX - b, arena.minZ + b, arena.maxX, arena.maxZ - b, 0);
}

interface WallSpec {
  a: readonly [number, number];
  b: readonly [number, number];
  facing: Facing;
}

function hallWalls(): WallSpec[] {
  const t = H.wallThickness;
  return [
    { a: [H.minX - t, H.minZ], b: [H.maxX + t, H.minZ], facing: 'pz' },
    { a: [H.maxX + t, H.maxZ], b: [H.minX - t, H.maxZ], facing: 'nz' },
    { a: [H.minX, H.maxZ], b: [H.minX, H.minZ], facing: 'px' },
    { a: [H.maxX, H.minZ], b: [H.maxX, H.maxZ], facing: 'nx' },
  ];
}

/** Face-local r coordinate of a world point on a wall (distance along `right` from the wall middle). */
function wallLocalR(w: WallSpec, x: number, z: number): number {
  const mx = (w.a[0] + w.b[0]) / 2;
  const mz = (w.a[1] + w.b[1]) / 2;
  const r = facingBasis(w.facing).right;
  return (x - mx) * r.x + (z - mz) * r.z;
}

function buildWalls(kit: LevelKit): void {
  const d = LEVEL_KIT.door;
  for (const w of hallWalls()) {
    const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const openings: [number, number][] = [];
    for (const door of L.doors) {
      if (door.facing !== w.facing) continue;
      const r = wallLocalR(w, door.position[0], door.position[2]);
      const half = door.width / 2 + d.frameWidth;
      openings.push([r - half, r + half]);
    }
    const mid = { x: (w.a[0] + w.b[0]) / 2, y: 0, z: (w.a[1] + w.b[1]) / 2 };
    const f = new WallFrame(mid, w.facing);
    // Trims and the light strip stop at the calibration grid (it stands on the north wall, facing +Z).
    const trimGaps: [number, number][] = [...openings];
    if (w.facing === 'pz') {
      const cw = L.calibrationWall;
      trimGaps.push([
        wallLocalR(w, cw.minX - cw.frameWidth, H.minZ),
        wallLocalR(w, cw.maxX + cw.frameWidth, H.minZ),
      ]);
    }
    kit.wall({
      a: w.a,
      b: w.b,
      facing: w.facing,
      y0: 0,
      height: H.wallTop,
      thickness: H.wallThickness,
      bands: [
        { material: M.wallDark, top: H.wainscotHeight },
        { material: M.wall, top: H.panelTop },
        { material: M.wallUpper, top: H.wallTop },
      ],
    });
    // Trim + light strip in segments around the door openings.
    const trim = LEVEL_KIT.trim;
    for (const [r0, r1] of subtractIntervals(-len / 2, len / 2, trimGaps)) {
      const rl = r1 - r0;
      const rc = (r0 + r1) / 2;
      kit.box(
        M.trim,
        f.point(rc, trim.baseHeight / 2, trim.baseDepth / 2),
        f.size(rl, trim.baseHeight, trim.baseDepth),
        {
          collider: false,
        },
      );
      kit.box(
        M.trim,
        f.point(rc, H.lightStripY, trim.stripHousingDepth / 2),
        f.size(rl, trim.stripHousingHeight, trim.stripHousingDepth),
        { collider: false },
      );
      kit.box(
        M.stripCyan,
        f.point(rc, H.lightStripY, trim.stripHousingDepth + trim.stripInset / 2),
        f.size(Math.max(trim.stripInset, rl - trim.stripInset * 4), trim.stripHeight, trim.stripInset),
        { collider: false, castShadow: false },
      );
      // Band seam between paneled and concrete wall.
      kit.box(
        M.trim,
        f.point(rc, H.panelTop, trim.capHeight / 2),
        f.size(rl, trim.capHeight * 2, trim.capHeight),
        {
          collider: false,
        },
      );
    }
    // Pilasters, skipping openings and busy zones.
    const [pw, pd] = H.pilasterSize;
    const blocked: [number, number][] = openings.map(([o0, o1]) => [o0 - pw, o1 + pw]);
    for (const [x0, z0, x1, z1] of pilasterExclusions()) {
      const ra = wallLocalR(w, x0, z0);
      const rb = wallLocalR(w, x1, z1);
      // Only zones touching this wall line matter.
      if (touchesWall(w, x0, z0, x1, z1)) blocked.push([Math.min(ra, rb) - pw, Math.max(ra, rb) + pw]);
    }
    for (let r = -len / 2 + H.pilasterSpacing / 2; r < len / 2; r += H.pilasterSpacing) {
      if (blocked.some(([b0, b1]) => r > b0 && r < b1)) continue;
      if (Math.abs(r) > len / 2 - H.wallThickness - pw) continue;
      const top = H.panelTop;
      kit.box(M.pillar, f.point(r, top / 2, pd / 2), f.size(pw, top, pd), { collider: true });
      kit.box(
        M.trim,
        f.point(r, top + trim.capHeight, pd / 2 + trim.capOverhang / 2),
        f.size(pw + trim.capOverhang * 2, trim.capHeight * 2, pd + trim.capOverhang),
        {
          collider: false,
        },
      );
      for (const by of H.pilasterBands) {
        kit.box(
          M.stripCyan,
          f.point(r, by, pd + DECAL.offset),
          f.size(pw * H.pilasterBandWidth, LEVEL_KIT.pillar.bandHeight, DECAL.thickness),
          {
            collider: false,
            castShadow: false,
          },
        );
      }
    }
  }
}

/** Rectangles (x0, z0, x1, z1) along the hall walls where pilasters would collide with modules. */
function pilasterExclusions(): [number, number, number, number][] {
  const c = L.corridor;
  const p = L.pit.rect;
  const cw = L.calibrationWall;
  const out: [number, number, number, number][] = [
    [c.laneMaxX, corridorRampBottomZ() - PC.rampFoot, c.laneMaxX, H.maxZ],
    [H.minX, p.minZ, H.minX, p.maxZ],
    [cw.minX, H.minZ, cw.maxX, H.minZ],
    [c.laneMinX, H.minZ, c.laneMaxX, H.minZ],
    [H.minX, H.maxZ - PC.corner, H.minX + PC.corner, H.maxZ],
  ];
  for (const s of L.screens) {
    const r = facingBasis(s.facing).right;
    const half = s.width / 2 + PC.screen;
    out.push([
      s.position[0] - r.x * half,
      s.position[2] - r.z * half,
      s.position[0] + r.x * half,
      s.position[2] + r.z * half,
    ]);
  }
  for (const v of L.vents) {
    const r = facingBasis(v.facing).right;
    out.push([
      v.position[0] - r.x * PC.vent,
      v.position[2] - r.z * PC.vent,
      v.position[0] + r.x * PC.vent,
      v.position[2] + r.z * PC.vent,
    ]);
  }
  // Vertical pipe drops along the walls.
  for (const pipe of L.pipes) {
    if (pipe.from[0] !== pipe.to[0] || pipe.from[2] !== pipe.to[2]) continue;
    const [x, , z] = pipe.from;
    out.push([x - PC.pipe, z - PC.pipe, x + PC.pipe, z + PC.pipe]);
  }
  return out;
}

function touchesWall(w: WallSpec, x0: number, z0: number, x1: number, z1: number): boolean {
  const eps = PC.wallProximity;
  switch (w.facing) {
    case 'pz':
      return Math.min(z0, z1) <= H.minZ + eps;
    case 'nz':
      return Math.max(z0, z1) >= H.maxZ - eps;
    case 'px':
      return Math.min(x0, x1) <= H.minX + eps;
    case 'nx':
      return Math.max(x0, x1) >= H.maxX - eps;
  }
}

function roofRotation(): { angle: number; q: THREE.Quaternion } {
  const angle = Math.atan2(H.roofHighY - H.roofLowY, H.maxZ - H.minZ);
  return { angle, q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle) };
}

/** Box hanging on the roof plane: its top face lies `drop` below the roof underside. */
function roofBox(
  kit: LevelKit,
  material: MaterialId,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  thickness: number,
  drop: number,
  castShadow = true,
): void {
  const { angle, q } = roofRotation();
  const zm = (minZ + maxZ) / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Underside plane at zm is roofUndersideY(zm); offset the center along the slab normal (0, cos, sin).
  const off = thickness / 2 - drop;
  const center = { x: (minX + maxX) / 2, y: roofUndersideY(zm) + off * cos, z: zm + off * sin };
  kit.box(
    material,
    center,
    { x: maxX - minX, y: thickness, z: (maxZ - minZ) / cos },
    // Roof slabs collide (grenades, sun-occlusion probe); the sky glow panels above openings don't.
    { rotation: q, collider: castShadow, castShadow },
  );
}

function buildRoof(kit: LevelKit): void {
  const r = L.roof;
  const t = H.wallThickness;
  const outer: Rect = { minX: H.minX - t, maxX: H.maxX + t, minZ: H.minZ - t, maxZ: H.maxZ + t };
  for (const rect of subtractRects(outer, r.skylights)) {
    roofBox(kit, M.roof, rect.minX, rect.maxX, rect.minZ, rect.maxZ, H.roofThickness, 0);
  }
  // Skylight frames (a lip below the opening edges).
  const fw = r.skylightFrame;
  for (const s of r.skylights) {
    roofBox(kit, M.trim, s.minX - fw, s.maxX + fw, s.minZ - fw, s.minZ, H.roofThickness + fw, fw);
    roofBox(kit, M.trim, s.minX - fw, s.maxX + fw, s.maxZ, s.maxZ + fw, H.roofThickness + fw, fw);
    roofBox(kit, M.trim, s.minX - fw, s.minX, s.minZ, s.maxZ, H.roofThickness + fw, fw);
    roofBox(kit, M.trim, s.maxX, s.maxX + fw, s.minZ, s.maxZ, H.roofThickness + fw, fw);
  }
  // Glowing sky above each opening (seen when looking up the shafts).
  const gm = r.skyGlowMargin;
  for (const s of r.skylights) {
    roofBox(
      kit,
      M.sky,
      s.minX - gm,
      s.maxX + gm,
      s.minZ - gm,
      s.maxZ + gm,
      fw,
      -(H.roofThickness + r.skyGlowLift),
      // The glow panel sits above the opening: casting shadows would block the sun shafts.
      false,
    );
  }
  // Cross beams (horizontal, along X) and sloped girders (along Z).
  const [bw, bh] = r.beamSize;
  for (let z = H.minZ + r.beamSpacingZ / 2; z < H.maxZ; z += r.beamSpacingZ) {
    const y = roofUndersideY(z + bw / 2) - bh / 2;
    kit.box(M.beam, { x: 0, y, z }, { x: H.maxX - H.minX, y: bh, z: bw }, { collider: false });
  }
  const [gw, gh] = r.girderSize;
  for (const gx of r.girderX) {
    roofBox(kit, M.beam, gx - gw / 2, gx + gw / 2, H.minZ, H.maxZ, gh, gh);
  }
}

function buildArena(kit: LevelKit): void {
  const a = L.arena;
  const size = a.pillarSize;
  for (const [x, z] of a.pillars) {
    const top = roofUndersideY(z - size / 2) + a.pillarRoofOverlap;
    kit.pillar({
      x,
      z,
      y0: 0,
      height: top,
      size,
      material: M.pillar,
      trim: M.trim,
      band: M.stripCyan,
      bands: a.pillarBands,
    });
  }
  const trim = LEVEL_KIT.trim;
  for (const cv of a.cover) {
    const [cx, cz] = cv.center;
    const [sx, sy, sz] = cv.size;
    kit.box(M.wallDark, { x: cx, y: sy / 2, z: cz }, { x: sx, y: sy, z: sz });
    kit.box(
      M.trim,
      { x: cx, y: sy + trim.capHeight / 2, z: cz },
      { x: sx + trim.capOverhang * 2, y: trim.capHeight, z: sz + trim.capOverhang * 2 },
    );
    // Hazard ends.
    const alongX = sx > sz;
    for (const side of [-1, 1]) {
      const ex = alongX ? cx + side * (sx / 2 + DECAL.offset) : cx;
      const ez = alongX ? cz : cz + side * (sz / 2 + DECAL.offset);
      const dt = DECAL.thickness;
      kit.box(
        M.hazard,
        { x: ex, y: sy / 2, z: ez },
        { x: alongX ? dt : sx, y: sy * a.coverHazardHeight, z: alongX ? sz : dt },
        {
          collider: false,
          castShadow: false,
        },
      );
    }
  }
}

function buildMezzanine(kit: LevelKit): void {
  const m = L.mezzanine;
  const O = m.outer;
  const I = m.inner;
  const top = m.deckY;
  const bottom = top - m.deckThickness;
  const decks: Rect[] = [
    { minX: -O, maxX: O, minZ: -O, maxZ: -I },
    { minX: -O, maxX: O, minZ: I, maxZ: O },
    { minX: -O, maxX: -I, minZ: -I, maxZ: I },
    { minX: I, maxX: O, minZ: -I, maxZ: I },
  ];
  for (const d of decks)
    kit.boxMinMax(M.deck, { x: d.minX, y: bottom, z: d.minZ }, { x: d.maxX, y: top, z: d.maxZ });

  // Fascia + glowing underside strip on the inner edge, fascia on the outer edge.
  const fh = m.fasciaHeight;
  const fd = m.fasciaDepth;
  const ug = m.underglow;
  const edges: { facing: Facing; pos: [number, number]; len: number; inner: boolean }[] = [
    { facing: 'pz', pos: [0, -I], len: 2 * I, inner: true },
    { facing: 'nz', pos: [0, I], len: 2 * I, inner: true },
    { facing: 'px', pos: [-I, 0], len: 2 * I, inner: true },
    { facing: 'nx', pos: [I, 0], len: 2 * I, inner: true },
    { facing: 'nz', pos: [0, -O], len: 2 * O, inner: false },
    { facing: 'pz', pos: [0, O], len: 2 * O, inner: false },
    { facing: 'nx', pos: [-O, 0], len: 2 * O, inner: false },
    { facing: 'px', pos: [O, 0], len: 2 * O, inner: false },
  ];
  for (const e of edges) {
    const f = new WallFrame({ x: e.pos[0], y: top, z: e.pos[1] }, e.facing);
    kit.box(M.trim, f.point(0, -fh / 2 + m.fasciaLift, fd / 2), f.size(e.len + fd * 2, fh, fd), {
      collider: false,
    });
    if (e.inner) {
      kit.box(
        M.stripOrange,
        f.point(0, -fh + ug.rise, fd + DECAL.offset),
        f.size(e.len - ug.margin * 2, ug.height, DECAL.thickness),
        {
          collider: false,
          castShadow: false,
        },
      );
    }
  }

  // Supports along the ring centerline.
  const c = (O + I) / 2;
  const seen = new Set<string>();
  for (let t = -c; t <= c + 1e-6; t += m.supportSpacing) {
    for (const [x, z] of [
      [t, -c],
      [t, c],
      [-c, t],
      [c, t],
    ] as const) {
      const key = `${x.toFixed(2)},${z.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kit.box(M.pillar, { x, y: bottom / 2, z }, { x: m.supportSize, y: bottom, z: m.supportSize });
      const cap = m.supportCap;
      const cs = m.supportSize + cap.extra * 2;
      kit.box(
        M.trim,
        { x, y: bottom - cap.height / 2, z },
        { x: cs, y: cap.height, z: cs },
        { collider: false },
      );
    }
  }

  // Railings (inset slightly so posts stand on the deck).
  const inset = LEVEL_KIT.railing.edgeInset;
  const st = L.stairs;
  const wr = L.westRamp;
  const rampTopZ = wr.bottomZ - westRampRun();
  const br = L.bridge;
  const outerGaps: Record<'n' | 's' | 'w' | 'e', [number, number][]> = {
    n: [],
    s: [[st.minX, st.maxX]],
    w: [[rampTopZ - wr.landingLength, rampTopZ]],
    e: [[br.minZ, br.maxZ]],
  };
  const innerGaps: Record<'n' | 's' | 'w' | 'e', [number, number][]> = { n: [], s: [], w: [], e: [] };
  for (const g of m.innerGaps) innerGaps[g.side].push([g.center - g.width / 2, g.center + g.width / 2]);

  const railSide = (
    side: 'n' | 's' | 'w' | 'e',
    half: number,
    gaps: [number, number][],
    sign: number,
  ): void => {
    const edge = half - inset * sign;
    for (const [s0, s1] of subtractIntervals(-half, half, gaps)) {
      switch (side) {
        case 'n':
          kit.railing({ x: s0, y: top, z: -edge }, { x: s1, y: top, z: -edge });
          break;
        case 's':
          kit.railing({ x: s0, y: top, z: edge }, { x: s1, y: top, z: edge });
          break;
        case 'w':
          kit.railing({ x: -edge, y: top, z: s0 }, { x: -edge, y: top, z: s1 });
          break;
        case 'e':
          kit.railing({ x: edge, y: top, z: s0 }, { x: edge, y: top, z: s1 });
          break;
      }
    }
  };
  for (const side of ['n', 's', 'w', 'e'] as const) {
    railSide(side, O, outerGaps[side], 1);
    railSide(side, I, innerGaps[side], -1);
  }

  // South stairs.
  const layout = southStairs();
  const sx = (st.minX + st.maxX) / 2;
  const width = st.maxX - st.minX;
  const bottomZ = st.topZ + layout.totalRun;
  kit.stairs({
    material: M.blockTop,
    stringer: M.trim,
    bottomCenter: { x: sx, y: 0, z: bottomZ },
    width,
    steps: layout.steps,
    stepRise: layout.stepRise,
    stepRun: layout.stepRun,
    yaw: 0,
  });
  const sw = LEVEL_KIT.stairs.stringerWidth;
  for (const x of [st.minX - sw / 2, st.maxX + sw / 2]) {
    kit.railing({ x, y: 0, z: bottomZ }, { x, y: top, z: st.topZ + layout.stepRun });
  }

  // West ramp + landing tower.
  const run = westRampRun();
  const rw = wr.maxX - wr.minX;
  const rx = (wr.minX + wr.maxX) / 2;
  kit.ramp({
    material: M.blockTop,
    center: { x: rx, y: 0, z: wr.bottomZ - run / 2 },
    width: rw,
    run,
    rise: top,
    yaw: 0,
    edgeTrim: M.hazard,
  });
  const landMinZ = rampTopZ - wr.landingLength;
  kit.platform({
    minX: wr.minX,
    maxX: wr.maxX,
    minZ: landMinZ,
    maxZ: rampTopZ,
    top,
    side: M.wallDark,
    topMaterial: M.blockTop,
  });
  kit.railing({ x: wr.minX + inset, y: 0, z: wr.bottomZ }, { x: wr.minX + inset, y: top, z: rampTopZ });
  kit.railing(
    { x: wr.minX + inset, y: top, z: rampTopZ },
    { x: wr.minX + inset, y: top, z: landMinZ + inset },
  );
  kit.railing(
    { x: wr.minX + inset, y: top, z: landMinZ + inset },
    { x: wr.maxX, y: top, z: landMinZ + inset },
  );

  // Bridge (catwalk) to the control-block deck.
  const bx = (br.minX + br.maxX) / 2;
  const bz = (br.minZ + br.maxZ) / 2;
  kit.catwalk({
    from: [br.minX, bz],
    to: [br.maxX, bz],
    width: br.maxZ - br.minZ,
    deckY: top,
    thickness: m.deckThickness,
    material: M.deck,
  });
  kit.box(M.pillar, { x: bx, y: bottom / 2, z: bz }, { x: m.supportSize, y: bottom, z: m.supportSize });
}

function buildCorridor(kit: LevelKit): void {
  const c = L.corridor;
  const top = L.mezzanine.deckY;
  const run = corridorRampRun();
  const bottomZ = corridorRampBottomZ();
  const laneW = c.laneMaxX - c.laneMinX;
  const lx = (c.laneMinX + c.laneMaxX) / 2;

  // Control block: solid body whose roof is the deck, with a recessed window bay in the west face.
  const win = L.controlBlock.window;
  const face = c.laneMinX;
  const back = face + win.recess;
  const bodyTop = top - L.mezzanine.deckThickness;
  const wz0 = win.centerZ - win.width / 2;
  const wz1 = win.centerZ + win.width / 2;
  kit.boxMinMax(M.blockTop, { x: face, y: bodyTop, z: c.deckMinZ }, { x: c.laneMaxX, y: top, z: H.maxZ });
  kit.boxMinMax(M.wallDark, { x: back, y: 0, z: c.deckMinZ }, { x: c.laneMaxX, y: bodyTop, z: H.maxZ });
  // Facade layer (recess deep) around the bay: its inner faces form the bay's walls, sill and lintel.
  kit.boxMinMax(M.wallDark, { x: face, y: 0, z: c.deckMinZ }, { x: back, y: bodyTop, z: wz0 });
  kit.boxMinMax(M.wallDark, { x: face, y: 0, z: wz1 }, { x: back, y: bodyTop, z: H.maxZ });
  kit.boxMinMax(M.wallDark, { x: face, y: 0, z: wz0 }, { x: back, y: win.bottom, z: wz1 });
  kit.boxMinMax(M.wallDark, { x: face, y: win.top, z: wz0 }, { x: back, y: bodyTop, z: wz1 });
  const br = L.bridge;
  const ri = LEVEL_KIT.railing.edgeInset;
  kit.railing(
    { x: c.laneMinX + ri, y: top, z: br.maxZ },
    { x: c.laneMinX + ri, y: top, z: H.maxZ - c.deckRailEndMargin },
  );
  for (const s of L.controlBlock.screens) {
    kit.screen({
      position: { x: s.position[0], y: s.position[1], z: s.position[2] },
      facing: s.facing,
      width: s.width,
      height: s.height,
      screen: M.screen,
      bezel: M.trim,
    });
  }
  // Bay interior: display wall at the back, light strip on the ceiling, glass pane in front.
  const wz = win.centerZ;
  const wh = win.top - win.bottom;
  const wy = (win.top + win.bottom) / 2;
  const bd = win.backDepth;
  kit.box(
    M.screen,
    { x: back - bd / 2, y: wy, z: wz },
    { x: bd, y: wh, z: win.width },
    { collider: false, uv: 'face' },
  );
  const gt = win.glowThickness;
  kit.box(
    M.stripCyan,
    { x: face + win.recess / 2, y: win.top - gt / 2, z: wz },
    { x: win.recess * win.glowDepth, y: gt, z: win.width * win.glowWidth },
    { collider: false, castShadow: false },
  );
  kit.box(
    M.glass,
    { x: face - win.glassThickness, y: wy, z: wz },
    { x: win.glassThickness, y: wh, z: win.width },
    { collider: false },
  );
  // The pane is solid for the player and hitscan (the bay itself has no collider).
  kit.staticBox(
    { x: face - win.glassThickness, y: wy, z: wz },
    { x: win.glassThickness, y: wh, z: win.width },
    undefined,
    getMaterialDef(M.glass)?.surface ?? 'glass',
  );
  const fs = win.frameSize;
  for (const side of [-1, 1]) {
    kit.box(
      M.trim,
      { x: c.laneMinX - win.frameOffset, y: wy, z: wz + side * (win.width / 2 + fs / 2) },
      { x: win.frameDepth, y: wh + fs * 2, z: fs },
      { collider: false },
    );
    kit.box(
      M.trim,
      { x: c.laneMinX - win.frameOffset, y: wy + side * (wh / 2 + fs / 2), z: wz },
      { x: win.frameDepth, y: fs, z: win.width },
      { collider: false },
    );
  }

  // Slide ramp from the deck (south) down to the corridor floor (north).
  kit.ramp({
    material: M.blockTop,
    center: { x: lx, y: 0, z: c.deckMinZ - run / 2 },
    width: laneW,
    run,
    rise: top,
    yaw: Math.PI,
    edgeTrim: M.hazard,
  });
  kit.railing(
    { x: c.laneMinX + LEVEL_KIT.railing.edgeInset, y: 0, z: bottomZ },
    { x: c.laneMinX + LEVEL_KIT.railing.edgeInset, y: top, z: c.deckMinZ },
  );

  // Partition wall with a glass window band and an opening.
  const p = c.partition;
  const pd = c.partitionDetail;
  const wb = c.windowBand;
  const px = (p.minX + p.maxX) / 2;
  const pt = p.maxX - p.minX;
  for (const [z0, z1] of subtractIntervals(p.minZ, p.maxZ, [
    [c.partitionOpening.minZ, c.partitionOpening.maxZ],
  ])) {
    const zl = z1 - z0;
    const zc = (z0 + z1) / 2;
    kit.box(
      M.wallDark,
      { x: px, y: wb.bottom / 2, z: zc },
      { x: pt, y: wb.bottom, z: zl },
      { collider: false },
    );
    kit.box(
      M.wall,
      { x: px, y: (wb.top + p.height) / 2, z: zc },
      { x: pt, y: p.height - wb.top, z: zl },
      { collider: false },
    );
    kit.box(
      M.glass,
      { x: px, y: (wb.bottom + wb.top) / 2, z: zc },
      { x: pd.glassThickness, y: wb.top - wb.bottom, z: zl },
      { collider: false },
    );
    kit.staticBox({ x: px, y: p.height / 2, z: zc }, { x: pt, y: p.height, z: zl }, undefined, 'metal');
    const n = Math.max(1, Math.round(zl / wb.mullionSpacing));
    for (let i = 0; i <= n; i++) {
      const z = z0 + (zl * i) / n;
      kit.box(
        M.trim,
        { x: px, y: (wb.bottom + wb.top) / 2, z },
        { x: pt + pd.mullionExtra, y: wb.top - wb.bottom, z: wb.mullionWidth },
        { collider: false },
      );
    }
    const trim = LEVEL_KIT.trim;
    kit.box(
      M.trim,
      { x: px, y: p.height + trim.capHeight / 2, z: zc },
      { x: pt + trim.capOverhang * 2, y: trim.capHeight, z: zl },
      { collider: false },
    );
    // Speed-line strips on both faces.
    for (const side of [-1, 1]) {
      const sx = px + side * (pt / 2 + DECAL.offset);
      const sl = zl - pd.stripMargin * 2;
      kit.box(
        M.stripOrange,
        { x: sx, y: wb.bottom - pd.upperStrip.drop, z: zc },
        { x: DECAL.thickness, y: pd.upperStrip.height, z: sl },
        { collider: false, castShadow: false },
      );
      kit.box(
        M.stripCyan,
        { x: sx, y: pd.lowerStrip.y, z: zc },
        { x: DECAL.thickness, y: pd.lowerStrip.height, z: sl },
        { collider: false, castShadow: false },
      );
    }
  }

  // Lane lines + distance markers on the sprint track.
  const lw = c.lineWidth;
  const trackMinZ = H.minZ + c.trackEndMargin;
  for (const x of c.laneLines) kit.marking(M.hazard, x - lw / 2, trackMinZ, x + lw / 2, bottomZ, 0);
  for (let z = bottomZ - c.distanceMarkerSpacing; z > trackMinZ; z -= c.distanceMarkerSpacing) {
    kit.marking(M.hazard, c.laneLines[0]!, z - lw / 2, c.laneLines[c.laneLines.length - 1]!, z + lw / 2, 0);
  }
}

function buildMantleCourse(kit: LevelKit): void {
  const m = L.mantle;
  const face = m.maxZ;
  m.ledges.forEach((l, i) => {
    const h = l.height;
    const cx = (l.minX + l.maxX) / 2;
    // Glowing height marker along the top front edge + tick bars (count = course step).
    kit.platform({
      minX: l.minX,
      maxX: l.maxX,
      minZ: m.minZ,
      maxZ: m.maxZ,
      top: h,
      side: M.wallDark,
      topMaterial: M.blockTop,
      edgeStrip: { material: M.stripCyan, faces: ['pz'], drop: m.markerDrop, height: m.markerHeight },
    });
    const ticks = i + 1;
    const span = ticks * m.tickWidth + (ticks - 1) * m.tickGap;
    for (let k = 0; k < ticks; k++) {
      const tx = cx - span / 2 + m.tickWidth / 2 + k * (m.tickWidth + m.tickGap);
      const ty = Math.max(m.tickHeight / 2 + m.tickLift, h - m.tickDrop - m.tickHeight / 2);
      kit.box(
        M.stripCyan,
        { x: tx, y: ty, z: face + DECAL.offset },
        { x: m.tickWidth, y: m.tickHeight, z: DECAL.thickness },
        {
          collider: false,
          castShadow: false,
        },
      );
    }
    kit.marking(M.hazard, l.minX, face, l.maxX, face + m.markingDepth, 0);
  });

  // Calibration grid wall behind the course, framed.
  const g = L.calibrationWall;
  const z = H.minZ + g.thickness / 2;
  kit.box(
    M.grid,
    { x: (g.minX + g.maxX) / 2, y: (g.bottom + g.top) / 2, z },
    { x: g.maxX - g.minX, y: g.top - g.bottom, z: g.thickness },
    { collider: false },
  );
  const fw = g.frameWidth;
  const fd = g.frameDepth;
  kit.box(
    M.trim,
    { x: (g.minX + g.maxX) / 2, y: g.top + fw / 2, z: H.minZ + fd / 2 },
    { x: g.maxX - g.minX + fw * 2, y: fw, z: fd },
    { collider: false },
  );
  for (const x of [g.minX - fw / 2, g.maxX + fw / 2]) {
    kit.box(
      M.trim,
      { x, y: (g.bottom + g.top) / 2, z: H.minZ + fd / 2 },
      { x: fw, y: g.top - g.bottom, z: fd },
      { collider: false },
    );
  }
}

function buildDoubleJump(kit: LevelKit): void {
  const d = L.doubleJump;
  const s = d.size / 2;
  for (const p of d.platforms) {
    kit.platform({
      minX: p.x - s,
      maxX: p.x + s,
      minZ: p.z - s,
      maxZ: p.z + s,
      top: p.height,
      side: M.wallDark,
      topMaterial: M.blockTop,
      edgeStrip: {
        material: M.stripOrange,
        faces: ['px', 'nx', 'pz', 'nz'],
        drop: d.stripDrop,
        height: d.stripHeight,
      },
    });
    kit.marking(M.hazard, p.x - s, p.z + s, p.x + s, p.z + s + d.markingDepth, 0);
  }
}

function buildPit(kit: LevelKit): void {
  const p = L.pit;
  const r = p.rect;
  const depth = p.depth;
  const wt = p.wallThickness;
  const slabBottom = -LEVEL_KIT.floorThickness;
  // Pit floor.
  kit.floor(M.pit, r.minX, r.minZ, r.maxX, r.maxZ, -depth, { castShadow: false });
  // Walls below the floor slabs (east, north, south) and the hall wall extension (west).
  kit.boxMinMax(
    M.pit,
    { x: r.maxX, y: -depth, z: r.minZ - wt },
    { x: r.maxX + wt, y: slabBottom, z: r.maxZ + wt },
  );
  kit.boxMinMax(M.pit, { x: r.minX, y: -depth, z: r.minZ - wt }, { x: r.maxX, y: slabBottom, z: r.minZ });
  kit.boxMinMax(M.pit, { x: r.minX, y: -depth, z: r.maxZ }, { x: r.maxX, y: slabBottom, z: r.maxZ + wt });
  kit.boxMinMax(M.pit, { x: r.minX - H.wallThickness, y: -depth, z: r.minZ }, { x: r.minX, y: 0, z: r.maxZ });
  // Exit blocks (mantle steps).
  for (const b of p.exitBlocks) {
    kit.platform({
      minX: b.minX,
      maxX: b.maxX,
      minZ: b.minZ,
      maxZ: b.maxZ,
      y0: -depth,
      top: b.top,
      side: M.pit,
      topMaterial: M.blockTop,
      edgeStrip: {
        material: M.stripRed,
        faces: ['pz', 'nz', 'nx'],
        drop: p.exitStrip.drop,
        height: p.exitStrip.height,
      },
    });
  }
  // Red glow strips low on the pit walls.
  const gy = -depth + p.glowStripY;
  const t = DECAL.thickness;
  const gh = p.glowStripHeight;
  kit.box(
    M.stripRed,
    { x: (r.minX + r.maxX) / 2, y: gy, z: r.minZ + t / 2 },
    { x: r.maxX - r.minX, y: gh, z: t },
    { collider: false, castShadow: false },
  );
  kit.box(
    M.stripRed,
    { x: (r.minX + r.maxX) / 2, y: gy, z: r.maxZ - t / 2 },
    { x: r.maxX - r.minX, y: gh, z: t },
    { collider: false, castShadow: false },
  );
  kit.box(
    M.stripRed,
    { x: r.minX + t / 2, y: gy, z: (r.minZ + r.maxZ) / 2 },
    { x: t, y: gh, z: r.maxZ - r.minZ },
    { collider: false, castShadow: false },
  );
  // Hazard rims.
  const rw = p.rimWidth;
  kit.marking(M.hazard, r.minX, r.maxZ, r.maxX, r.maxZ + rw, 0);
  kit.marking(M.hazard, r.minX, r.minZ - rw, r.maxX, r.minZ, 0);
  kit.marking(M.hazard, r.maxX, r.minZ - rw, r.maxX + rw, r.maxZ + rw, 0);
}

function buildDressing(kit: LevelKit): void {
  for (const door of L.doors) {
    kit.door({
      position: { x: door.position[0], y: door.position[1], z: door.position[2] },
      facing: door.facing,
      width: door.width,
      height: door.height,
      frame: M.trim,
      panel: M.wallDark,
      hazard: M.hazard,
      light: door.blast ? M.stripRed : M.stripOrange,
      accent: door.blast ? M.stripOrange : M.stripCyan,
      blast: door.blast,
    });
  }
  for (const s of L.screens) {
    kit.screen({
      position: { x: s.position[0], y: s.position[1], z: s.position[2] },
      facing: s.facing,
      width: s.width,
      height: s.height,
      screen: M.screen,
      bezel: M.trim,
    });
  }
  for (const v of L.vents) {
    kit.ventSlits({
      position: { x: v.position[0], y: v.position[1], z: v.position[2] },
      facing: v.facing,
      width: v.width,
      slits: v.slits,
      slitHeight: v.slitHeight,
      spacing: v.spacing,
      frame: M.trim,
      glow: M.stripOrange,
    });
  }
  for (const pipe of L.pipes) {
    kit.pipe({
      from: { x: pipe.from[0], y: pipe.from[1], z: pipe.from[2] },
      to: { x: pipe.to[0], y: pipe.to[1], z: pipe.to[2] },
      radius: pipe.radius,
      material: M.pipe,
      bracket: M.trim,
      supportSpacing: pipe.supportSpacing,
      wall: pipe.wall,
      flangeSpacing: pipe.flangeSpacing,
    });
  }
  for (const v of L.valves) {
    kit.box(
      M.pillar,
      { x: v.center[0], y: v.center[1], z: v.center[2] },
      { x: v.size[0], y: v.size[1], z: v.size[2] },
    );
  }
  for (const c of L.crates) {
    kit.crate({
      material: M.crate,
      center: { x: c.position[0], y: c.position[1], z: c.position[2] },
      size: c.size,
      yaw: c.yawDeg * DEG2RAD,
      dynamic: c.dynamic,
    });
  }
}

interface SpotEntry {
  def: (typeof L.lights.spots)[number];
  handle: LightHandle;
}
interface PointEntry {
  def: (typeof L.lights.points)[number];
  handle: LightHandle;
}

function buildLights(kit: LevelKit): { spots: SpotEntry[]; points: PointEntry[] } {
  const spots: SpotEntry[] = L.lights.spots.map((def) => {
    const [x, y, z] = def.position;
    const handle = kit.spotFixture({
      position: { x, y, z },
      target: { x: def.target[0], y: def.target[1], z: def.target[2] },
      color: color3(def.color),
      intensity: def.intensity,
      distance: def.distance,
      angle: def.angleDeg * DEG2RAD,
      penumbra: def.penumbra,
      shadowPriority: def.shadowPriority,
      housing: M.trim,
      panel: M.lamp,
      rodTop: def.hanging ? roofUndersideY(z) : null,
      flicker: def.flicker,
    });
    return { def, handle };
  });
  const points: PointEntry[] = L.lights.points.map((def) => {
    const handle = kit.pointLight({
      position: { x: def.position[0], y: def.position[1], z: def.position[2] },
      color: color3(def.color),
      intensity: def.intensity,
      distance: def.distance,
      bulb: null,
      flicker: def.flicker,
    });
    return { def, handle };
  });
  return { spots, points };
}

function buildCones(
  kit: LevelKit,
  spots: SpotEntry[],
  time: TimeUniform,
): { cone: VolumetricCone; source: number }[] {
  const out: { cone: VolumetricCone; source: number }[] = [];
  spots.forEach((s, i) => {
    if (!s.def.volumetric) return;
    const light = s.handle.light as THREE.SpotLight;
    const apex = light.position;
    _dir.copy(light.target.position).sub(apex);
    if (_dir.lengthSq() < 1e-8) return;
    _dir.normalize();
    const hit = kit.physics.raycast(apex, _dir, LEVEL_KIT.volumeRayMaxDistance);
    const length = hit ? hit.distance : Math.min(s.def.distance, apex.y / Math.max(1e-3, -_dir.y));
    const floorY = hit ? hit.point.y : 0;
    const cone = new VolumetricCone({
      apex,
      direction: _dir,
      angle: s.def.angleDeg * DEG2RAD * VOLUMETRIC_CONE.angleScale,
      length,
      color: _color.setRGB(s.def.color[0], s.def.color[1], s.def.color[2], THREE.LinearSRGBColorSpace),
      intensity: VOLUMETRIC_CONE.intensity * s.def.coneIntensity,
      floorY,
      time,
    });
    out.push({ cone, source: i });
  });
  return out;
}

function buildShafts(kit: LevelKit, time: TimeUniform): VolumetricShafts | null {
  const sun = TEST_ROOM.sun.direction;
  _dir.set(sun[0], sun[1], sun[2]);
  if (_dir.lengthSq() < 1e-8 || _dir.y >= 0) {
    log.warn('Sun does not shine downwards – no skylight shafts');
    return null;
  }
  _dir.normalize();
  const segments: ShaftSegment[] = [];
  const origin = new THREE.Vector3();
  for (const s of L.roof.skylights) {
    const n = Math.max(1, Math.ceil((s.maxX - s.minX) / VOLUMETRIC_SHAFT.segmentLength - 1e-6));
    const w = (s.maxX - s.minX) / n;
    const y0 = roofUndersideY(s.minZ);
    const y1 = roofUndersideY(s.maxZ);
    for (let i = 0; i < n; i++) {
      origin.set(s.minX + i * w, y0, s.minZ);
      // Probe from the opening center along the sun direction.
      const cx = origin.x + w / 2;
      const cy = (y0 + y1) / 2;
      const cz = (s.minZ + s.maxZ) / 2;
      const hit = kit.physics.raycast({ x: cx, y: cy, z: cz }, _dir, LEVEL_KIT.volumeRayMaxDistance);
      const len = hit ? hit.distance : cy / -_dir.y;
      segments.push({
        origin: { x: origin.x, y: origin.y, z: origin.z },
        edgeA: { x: w, y: 0, z: 0 },
        edgeB: { x: 0, y: y1 - y0, z: s.maxZ - s.minZ },
        extrude: { x: _dir.x * len, y: _dir.y * len, z: _dir.z * len },
        fadeU0: i === 0,
        fadeU1: i === n - 1,
      });
    }
  }
  if (segments.length === 0) return null;
  const c = TEST_ROOM.sun.color;
  const color = new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  return new VolumetricShafts(segments, color, VOLUMETRIC_SHAFT.intensity * TEST_ROOM.sun.intensity, time);
}
