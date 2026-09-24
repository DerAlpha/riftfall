/**
 * "Forschungslabor" – the first wave map (M3 vertical slice). Pure data-to-geometry: every
 * dimension comes from LAB_LAYOUT (defs/labLayout.ts), materials from defs/materials.ts (+ the
 * tinted LAB_MATERIALS variants), atmosphere from LAB (defs/maps.ts).
 *
 * Budget (67 draws at 'high', LAB_LAYOUT.maxMeshes): static geometry merged per material variant
 * (~44 meshes) + flicker panels + static crates, 10 volumetric cones, 1 shaft mesh (16 skylight
 * panes), 1 dust system, 3 fog volumes, 1 instanced draw for all spawn tears, 3 draws for the rift
 * anomaly (vortex, tear cluster, particles). Lights: 10 spots (local shadows from the QUALITY_LEVELS
 * budget, staggered refresh) + 4 points + the rift light = 15 (LAB_LAYOUT.maxLights).
 *
 * Extras for the composition root (MapLevelInstance): zones, M4 door slots and wall-buy slots,
 * spawn points (with a rift tear each), hasVolumetricContent (the portals draw on the volumetric
 * layer even with volumetrics off), zoneAt().
 */
import * as THREE from 'three';
import type { LevelBuildContext, LevelBuilder, SpawnPointDef } from '../../core/contracts';
import { createLogger } from '../../core/log';
import { DEG2RAD, noise1D } from '../../core/math';
import { QUALITY_LEVELS } from '../../defs/graphics';
import {
  LAB_LAYOUT,
  RIFT_PORTAL,
  type LabMaterialId,
  type LabPointDef,
  type LabSpotDef,
} from '../../defs/labLayout';
import { DUST, FLICKER, LEVEL_KIT, VOLUMETRIC_CONE, VOLUMETRIC_SHAFT, type Facing } from '../../defs/level';
import { LAB, type MapAtmosphereDef } from '../../defs/maps';
import { NAV } from '../../defs/nav';
import { COMBAT } from '../../defs/combat';
import type { GraphicsSettings, QualityLevel } from '../../save/settingsSchema';
import { DustParticles, dustRegionsWithCones } from '../../render/vfx/DustParticles';
import { RiftPortal, RiftPortalField, type RiftTearPlacement } from '../../render/vfx/RiftPortal';
import {
  VolumetricCone,
  VolumetricShafts,
  type BoxVolume,
  type ConeVolume,
  type ShaftSegment,
  type TimeUniform,
} from '../../render/vfx/VolumetricCone';
import { LevelKit, WallFrame, type LightHandle } from '../../world/LevelKit';
import { flickerFactor, reducedFlickerFactor } from '../../world/kitMath';
import type { DoorSlotDef, LevelZoneDef, MapLevelInstance, WallBuySlotDef } from '../types';
import { FogVolume } from './fogVolumes';
import { LabMaterials, isNavIgnoredMaterial } from './labMaterials';
import {
  buildAtrium,
  buildCryo,
  buildDock,
  buildLabs,
  buildPipes,
  buildReception,
  buildServer,
} from './labRooms';
import { buildShell, themeOf } from './labShell';
import { doorwayFacing, facingNormal, findSpace, spaceAt, spawnWallPoint } from './labSpaces';

export { spawnWallPoint };

const log = createLogger('ResearchLab');

const L = LAB_LAYOUT;
const T = L.wallThickness;
const QUALITY_ORDER: readonly QualityLevel[] = ['off', 'low', 'medium', 'high', 'ultra'];

/** Every (variant) material id the lab uses (for preloading). */
export function labMaterialIds(): LabMaterialId[] {
  const ids = new Set<LabMaterialId>([
    'trim_metal',
    'painted_hazard',
    'diamond_plate',
    'pillar_metal',
    'floor_grate',
    'glass',
    'glass#tank',
    'glass#frost',
    'screen',
    'crate',
    'pipe',
    'rubber',
    'wall_panel',
    'wall_panel_dark',
    'wall_panel#white',
    'wall_panel_dark#clinical',
    'concrete_wall#roof',
    'emissive_cyan',
    'emissive_orange',
    'emissive_red',
    'emissive_red#violet',
    'emissive_white#cold',
    'emissive_white#sky',
    'emissive_cyan#fluid',
    'emissive_cyan#led',
    LEVEL_KIT.railing.material,
  ]);
  for (const t of Object.values(L.themes)) {
    ids.add(t.floor);
    ids.add(t.ceiling);
    ids.add(t.baseTrim);
    ids.add(t.doorFrame);
    for (const b of t.bands) ids.add(b.material);
    if (t.strip) {
      ids.add(t.strip.material);
      ids.add(t.strip.housing);
    }
    if (t.ceilingPanels) ids.add(t.ceilingPanels.material);
  }
  return [...ids];
}

function color3(c: readonly [number, number, number]): THREE.Color {
  return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
}

function atLeast(level: QualityLevel, min: QualityLevel): boolean {
  return QUALITY_ORDER.indexOf(level) >= QUALITY_ORDER.indexOf(min);
}

/** Enemy-convention yaw (local +Z = (sin yaw, cos yaw)) of a facing. */
function facingYaw(f: Facing): number {
  const n = facingNormal(f);
  return Math.atan2(n.x, n.z);
}

// ---------------------------------------------------------------------------
// Spawn points, door slots, zones (pure data → runtime records; exported for tests)
// ---------------------------------------------------------------------------

export function labSpawnPoints(): SpawnPointDef[] {
  return L.spawnPoints.map((p) => ({
    id: p.id,
    position: new THREE.Vector3(p.position[0], p.position[1], p.position[2]),
    yaw: p.wall ? facingYaw(p.wall) : (p.yawDeg ?? 0) * DEG2RAD,
    zone: p.zone,
    kind: p.kind,
  }));
}

/** Tear placement for every spawn point (same order as LAB_LAYOUT.spawnPoints). */
export function labSpawnTears(): RiftTearPlacement[] {
  const S = RIFT_PORTAL.small;
  const V = L.spawnTears.vent;
  return L.spawnPoints.map((p, i) => {
    const seed = i * 7.31 + 3;
    if (!p.wall) {
      const yaw = (p.yawDeg ?? 0) * DEG2RAD;
      return {
        position: { x: p.position[0], y: p.position[1] + S.floor.lift, z: p.position[2] },
        normal: { x: 0, y: 1, z: 0 },
        // The slit lies across the emerging direction.
        up: { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) },
        width: S.floor.width,
        height: S.floor.length,
        seed,
      };
    }
    const w = spawnWallPoint(p)!;
    const n = facingNormal(p.wall);
    const off = L.spawnTears.faceOffset + (p.tearOffset ?? 0);
    if (p.kind === 'vent') {
      // Horizontal slit glowing behind the vent louvers.
      return {
        position: { x: w.x + n.x * off, y: w.y + V.y, z: w.z + n.z * off },
        normal: { x: n.x, y: 0, z: n.z },
        up: { x: -n.z, y: 0, z: n.x },
        width: S.vent.height,
        height: S.vent.width,
        seed,
        brightness: S.ventBrightness,
      };
    }
    return {
      position: { x: w.x + n.x * off, y: w.y + S.wall.bottom + S.wall.height / 2, z: w.z + n.z * off },
      normal: { x: n.x, y: 0, z: n.z },
      width: S.wall.width,
      height: S.wall.height,
      seed,
    };
  });
}

export function labDoorSlots(): DoorSlotDef[] {
  const out: DoorSlotDef[] = [];
  for (const d of L.doorways) {
    if (!d.slot) continue;
    const a = findSpace(L.spaces, d.a);
    const b = findSpace(L.spaces, d.b);
    const facing = doorwayFacing(d, L.spaces, T);
    out.push({
      id: d.id,
      position: new THREE.Vector3(d.x, 0, d.z),
      facing,
      yaw: facingYaw(facing),
      width: d.width,
      height: d.height,
      depth: T * 2,
      zoneA: a?.zone ?? d.a,
      zoneB: b?.zone ?? d.b,
      costHint: d.costHint,
      blast: d.blast === true,
    });
  }
  return out;
}

export function labWallBuySlots(): WallBuySlotDef[] {
  const W = L.reception.wallBuy;
  return [
    {
      id: W.id,
      position: new THREE.Vector3(W.position[0], W.position[1], W.position[2]),
      facing: W.facing,
      zone: 'reception',
      weaponHint: W.weaponHint,
      costHint: W.costHint,
    },
  ];
}

// ---------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------

interface Flickering {
  handle: LightHandle;
  cone: VolumetricCone | null;
  seed: number;
}

interface Pulsing {
  handle: LightHandle;
  rate: number;
  depth: number;
  phase: number;
}

/** Optional MaterialLibrary extension (duck-typed: the contract only guarantees MaterialLibraryApi). */
interface GraphicsSettingsSink {
  applyGraphicsSettings?(g: GraphicsSettings): void;
}

interface LabParts {
  kit: LevelKit;
  materials: LabMaterials;
  cones: VolumetricCone[];
  shafts: VolumetricShafts | null;
  dust: DustParticles | null;
  fog: FogVolume[];
  tears: RiftPortalField;
  rift: RiftPortal;
  flickering: Flickering[];
  pulsing: Pulsing[];
  time: TimeUniform;
  navSources: THREE.Mesh[];
}

const _pulse = { x: 0, y: 0, z: 0 };

class ResearchLabInstance implements MapLevelInstance {
  readonly id = LAB.id;
  readonly atmosphere: MapAtmosphereDef = LAB;
  readonly root: THREE.Object3D;
  readonly spawn: { position: THREE.Vector3; yaw: number };
  readonly spawnPoints: readonly SpawnPointDef[];
  readonly navSources: readonly THREE.Mesh[];
  readonly zones: readonly LevelZoneDef[] = L.zones;
  readonly doorSlots: readonly DoorSlotDef[];
  readonly wallBuySlots: readonly WallBuySlotDef[];
  private readonly unsubscribe: (() => void)[] = [];
  private volumetricsLevel: QualityLevel | null = null;
  private reduceFlashing: boolean;
  private disposed = false;
  private readonly statsOut = { meshes: 0, lights: 0, colliders: 0, dynamicBodies: 0 };
  private readonly coneVolumes: ConeVolume[];
  private readonly boxVolumes: BoxVolume[];

  constructor(
    private readonly parts: LabParts,
    ctx: LevelBuildContext,
  ) {
    const { kit } = parts;
    this.root = kit.root;
    this.navSources = parts.navSources;
    this.coneVolumes = parts.cones.slice(0, DUST.maxCones).map((c) => c.volume);
    this.boxVolumes = parts.shafts ? parts.shafts.volumes.slice(0, DUST.maxBoxes) : [];
    const sp = L.spawn.position;
    this.spawn = { position: new THREE.Vector3(sp[0], sp[1], sp[2]), yaw: L.spawn.yawDeg * DEG2RAD };
    this.spawnPoints = labSpawnPoints();
    this.doorSlots = labDoorSlots();
    this.wallBuySlots = labWallBuySlots();
    this.reduceFlashing = ctx.settings.current.accessibility.reduceFlashing;
    this.applyReduceFlashing();
    const g = ctx.settings.current.graphics;
    kit.applyShadowQuality(g.shadows);
    this.applyVolumetrics(g.volumetrics);
    const materials = ctx.materials as GraphicsSettingsSink;
    const events = ctx.events;
    this.unsubscribe.push(
      events.on('settings:changed', ({ settings, sections }) => {
        if (sections.includes('accessibility')) {
          this.reduceFlashing = settings.accessibility.reduceFlashing;
          this.applyReduceFlashing();
        }
        if (!sections.includes('graphics')) return;
        if (settings.graphics.shadows !== kit.shadowQuality)
          kit.applyShadowQuality(settings.graphics.shadows);
        this.applyVolumetrics(settings.graphics.volumetrics);
        if (typeof materials.applyGraphicsSettings === 'function')
          materials.applyGraphicsSettings(settings.graphics);
      }),
      // Spawn bursts flare the tear they come out of; a wave start flares every rift.
      events.on('enemy:spawned', ({ position }) => {
        _pulse.x = position.x;
        _pulse.y = position.y;
        _pulse.z = position.z;
        const i = this.parts.tears.nearest(_pulse, RIFT_PORTAL.small.pulseRadius);
        if (i >= 0) this.parts.tears.pulse(i, RIFT_PORTAL.small.spawnPulse);
      }),
      events.on('wave:start', () => {
        this.parts.rift.pulse(RIFT_PORTAL.large.wavePulse);
        this.parts.tears.pulseAll(RIFT_PORTAL.small.wavePulse);
      }),
    );
  }

  /** The rift portals draw on the volumetric layer at every quality. */
  get hasVolumetricContent(): boolean {
    return !this.disposed;
  }

  zoneAt(x: number, z: number): string | null {
    return spaceAt(L.spaces, x, z)?.zone ?? null;
  }

  /** Flare the rift anomaly (wave events, scripted moments). */
  pulseRift(strength: number): void {
    this.parts.rift.pulse(strength);
  }

  /** Flare the spawn tear of a spawn point (index into spawnPoints). */
  pulseSpawnPoint(index: number, strength: number): void {
    this.parts.tears.pulse(index, strength);
  }

  get stats(): MapLevelInstance['stats'] {
    const p = this.parts;
    const k = p.kit;
    const out = this.statsOut;
    out.meshes =
      k.meshes.length +
      p.cones.length +
      (p.shafts ? 1 : 0) +
      (p.dust ? 1 : 0) +
      p.fog.length +
      1 + // spawn tears
      3; // rift: vortex, tear cluster, particles
    out.lights = k.lights.length + (p.rift.light ? 1 : 0);
    out.colliders = k.colliders.length + k.bodies.length;
    out.dynamicBodies = k.bodies.length;
    return out;
  }

  update(dt: number, time: number): void {
    if (this.disposed) return;
    const p = this.parts;
    p.time.value = time;
    p.materials.update(time);
    for (let i = 0; i < p.flickering.length; i++) {
      const f = p.flickering[i]!;
      const k = this.reduceFlashing
        ? reducedFlickerFactor(time, f.seed, FLICKER.reduced, noise1D)
        : flickerFactor(time, f.seed, FLICKER, noise1D);
      f.handle.light.intensity = f.handle.baseIntensity * k;
      const panel = f.handle.panel;
      if (panel)
        (panel.material as THREE.MeshStandardMaterial).emissiveIntensity = f.handle.panelBaseIntensity * k;
      f.cone?.setIntensityScale(k);
    }
    const rp = L.lights.reducedPulse;
    for (let i = 0; i < p.pulsing.length; i++) {
      const a = p.pulsing[i]!;
      const rate = this.reduceFlashing ? rp.rate : a.rate;
      const depth = this.reduceFlashing ? rp.depth : a.depth;
      const k = 1 - depth * (0.5 + 0.5 * Math.sin((time * rate + a.phase) * Math.PI * 2));
      a.handle.light.intensity = a.handle.baseIntensity * k;
      const panel = a.handle.panel;
      if (panel)
        (panel.material as THREE.MeshStandardMaterial).emissiveIntensity = a.handle.panelBaseIntensity * k;
    }
    if (p.flickering.length > 0 && p.dust && p.dust.points.visible) this.syncDustVolumes();
    p.tears.update(dt);
    p.rift.update(dt);
    p.kit.updateShadows();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    const p = this.parts;
    for (const c of p.cones) c.dispose();
    p.shafts?.dispose();
    p.dust?.dispose();
    for (const f of p.fog) f.dispose();
    p.tears.dispose();
    p.rift.dispose();
    p.kit.dispose();
    p.materials.dispose();
  }

  private applyReduceFlashing(): void {
    this.parts.materials.setReducedFlashing(this.reduceFlashing);
    this.parts.rift.setReducedFlashing(this.reduceFlashing);
    this.parts.tears.setReducedFlashing(this.reduceFlashing);
  }

  private applyVolumetrics(level: QualityLevel): void {
    if (level === this.volumetricsLevel) return;
    this.volumetricsLevel = level;
    const p = this.parts;
    const params = QUALITY_LEVELS.volumetrics[level];
    const on = params !== null && params.cones;
    for (const c of p.cones) c.mesh.visible = on;
    if (p.shafts) p.shafts.mesh.visible = on;
    for (const f of p.fog) f.mesh.visible = params !== null && atLeast(level, f.def.minQuality);
    if (p.dust) {
      p.dust.setCount(params ? DUST.baseCount * params.dust : 0);
      this.syncDustVolumes();
    }
    // The anomaly's particles stay (gameplay landmark), thinned out on low settings.
    p.rift.setParticleFraction(params ? Math.min(1, params.dust) : RIFT_PORTAL.large.particles.offFraction);
  }

  private syncDustVolumes(): void {
    this.parts.dust?.setVolumes(this.coneVolumes, this.boxVolumes);
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export const buildResearchLab: LevelBuilder = async (ctx) => {
  const t0 = performance.now();
  const render = ctx.render as Partial<LevelBuildContext['render']> | undefined;
  const setupMaterial =
    typeof render?.setupMaterial === 'function'
      ? (m: THREE.Material) => ctx.render.setupMaterial(m)
      : undefined;
  const materials = new LabMaterials(ctx.materials, setupMaterial);

  ctx.onProgress('Generiere Materialien…', 0);
  await materials.preload(labMaterialIds(), (done, total) =>
    ctx.onProgress(
      'Generiere Materialien…',
      total > 0 ? (L.progress.materials * done) / total : L.progress.materials,
    ),
  );

  ctx.onProgress('Baue Forschungslabor…', L.progress.geometry);
  await nextTick();
  const kit = new LevelKit({ physics: ctx.physics, materials, name: 'ResearchLab', setupMaterial });
  buildShell(kit);
  buildReception(kit);
  buildAtrium(kit);
  buildLabs(kit);
  buildServer(kit);
  buildCryo(kit);
  buildDock(kit);
  buildPipes(kit);
  buildVents(kit);

  ctx.onProgress('Richte Beleuchtung ein…', L.progress.lights);
  await nextTick();
  const lights = buildLights(kit);
  kit.build();
  const navSources = flagNavSources(kit);

  ctx.onProgress('Volumetrisches Licht…', L.progress.volumetrics);
  const time: TimeUniform = { value: 0 };
  const cones = buildCones(kit, lights.spots, time);
  const shafts = buildShafts(kit, time);
  for (const c of cones) kit.root.add(c.cone.mesh);
  if (shafts) kit.root.add(shafts.mesh);
  const coneList = cones.map((c) => c.cone);
  const maxDust = Math.ceil(DUST.baseCount * maxDustMultiplier());
  const dustRegions = dustRegionsWithCones(
    L.dust,
    coneList.slice(0, DUST.maxCones).map((c) => c.volume),
    DUST.coneShare,
    DUST.regionFloorLift,
  );
  const dust = maxDust > 0 ? new DustParticles({ regions: dustRegions, maxCount: maxDust, time }) : null;
  if (dust) kit.root.add(dust.points);
  const fog = L.fogVolumes.map((def) => new FogVolume(def, time));
  for (const f of fog) kit.root.add(f.mesh);
  const tears = new RiftPortalField(labSpawnTears(), { time, name: 'SpawnRifts' });
  kit.root.add(tears.mesh);
  const r = L.atrium.rift.position;
  const rift = new RiftPortal({ position: { x: r[0], y: r[1], z: r[2] }, time, light: true });
  kit.root.add(rift.root);

  const flickering: Flickering[] = [];
  const pulsing: Pulsing[] = [];
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
    if (p.def.pulse)
      pulsing.push({
        handle: p.handle,
        rate: p.def.pulse.rate,
        depth: p.def.pulse.depth,
        phase: i * L.lights.pulsePhaseStep,
      });
  });

  const instance = new ResearchLabInstance(
    {
      kit,
      materials,
      cones: coneList,
      shafts,
      dust,
      fog,
      tears,
      rift,
      flickering,
      pulsing,
      time,
      navSources,
    },
    ctx,
  );
  kit.root.updateMatrixWorld(true);
  const s = instance.stats;
  log.info(
    `Research lab built in ${(performance.now() - t0).toFixed(0)} ms: ${s.meshes} meshes, ` +
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

/** Mark ceilings / roofs navIgnore; returns the navmesh sources (bullet-stopping static meshes). */
function flagNavSources(kit: LevelKit): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const m of kit.meshes) {
    const id = m.userData.kitMaterialId as string | undefined;
    if (id && isNavIgnoredMaterial(id)) m.userData[NAV.sources.ignoreFlag] = true;
    if (m.userData[NAV.sources.ignoreFlag] === true) continue;
    if (!m.name.startsWith(COMBAT.staticMeshPrefixes[0])) continue;
    out.push(m);
  }
  return out;
}

/** Vent grates of the vent spawn points (their tears glow behind the louvers). */
function buildVents(kit: LevelKit): void {
  const V = L.spawnTears.vent;
  for (const p of L.spawnPoints) {
    if (p.kind !== 'vent' || !p.wall) continue;
    const w = spawnWallPoint(p)!;
    kit.ventSlits({
      position: { x: w.x, y: w.y + V.y, z: w.z },
      facing: p.wall,
      width: V.width,
      slits: V.slits,
      slitHeight: V.slitHeight,
      spacing: V.spacing,
      frame: 'trim_metal',
      glow: 'emissive_red#violet',
    });
  }
  // Scorched frame plates around the wall tears.
  for (const p of L.spawnPoints) {
    if (p.kind !== 'rift' || !p.wall) continue;
    const w = spawnWallPoint(p)!;
    const f = new WallFrame(w, p.wall);
    const S = RIFT_PORTAL.small.wall;
    kit.box(
      'emissive_red#violet',
      f.point(0, S.bottom / 2, LEVEL_KIT.decal.offset),
      f.size(S.width * 0.8, LEVEL_KIT.decal.thickness * 2, LEVEL_KIT.decal.thickness),
      { collider: false, castShadow: false },
    );
  }
}

interface SpotEntry {
  def: LabSpotDef;
  handle: LightHandle;
}
interface PointEntry {
  def: LabPointDef;
  handle: LightHandle;
}

function buildLights(kit: LevelKit): { spots: SpotEntry[]; points: PointEntry[] } {
  const spots: SpotEntry[] = L.lights.spots.map((def) => {
    const [x, y, z] = def.position;
    const space = spaceAt(L.spaces, x, z);
    const panel = space
      ? (themeOf(space).ceilingPanels?.material ?? 'emissive_white#cold')
      : 'emissive_white#cold';
    const handle = kit.spotFixture({
      position: { x, y, z },
      target: { x: def.target[0], y: def.target[1], z: def.target[2] },
      color: color3(def.color),
      intensity: def.intensity,
      distance: def.distance,
      angle: def.angleDeg * DEG2RAD,
      penumbra: def.penumbra,
      shadowPriority: def.shadowPriority,
      housing: 'trim_metal',
      panel: panel === 'emissive_red#dim' ? 'emissive_white#cold' : panel,
      rodTop: def.hanging && space ? space.ceiling : null,
      flicker: def.flicker,
    });
    if (!def.hanging && space) wallBracket(kit, x, y, z, space.id);
    return { def, handle };
  });
  const points: PointEntry[] = L.lights.points.map((def) => {
    const handle = kit.pointLight({
      position: { x: def.position[0], y: def.position[1], z: def.position[2] },
      color: color3(def.color),
      intensity: def.intensity,
      distance: def.distance,
      bulb: def.pulse ? 'emissive_red' : null,
      // Pulsing emergency lights need their own bulb material instance.
      flicker: def.flicker || def.pulse !== undefined,
    });
    return { def, handle };
  });
  return { spots, points };
}

/** Wall-mounted fixtures (near a wall, not hanging): an arm from the housing back to the wall. */
function wallBracket(kit: LevelKit, x: number, y: number, z: number, spaceId: string): void {
  const space = findSpace(L.spaces, spaceId);
  if (!space) return;
  const reach = L.lights.bracket.maxReach;
  let best: { axis: 'x' | 'z'; wall: number; d: number } | null = null;
  for (const r of space.rects) {
    for (const [axis, wall, d] of [
      ['x', r.minX, x - r.minX],
      ['x', r.maxX, r.maxX - x],
      ['z', r.minZ, z - r.minZ],
      ['z', r.maxZ, r.maxZ - z],
    ] as const) {
      if (d > 0 && d < reach && (!best || d < best.d)) best = { axis, wall, d };
    }
  }
  if (!best) return;
  const s = L.lights.bracket.size;
  const hy = y + LEVEL_KIT.fixture.housingSize[1] / 2;
  if (best.axis === 'x') {
    kit.box(
      'trim_metal',
      { x: (x + best.wall) / 2, y: hy, z },
      { x: best.d, y: s, z: s },
      { collider: false },
    );
  } else {
    kit.box(
      'trim_metal',
      { x, y: hy, z: (z + best.wall) / 2 },
      { x: s, y: s, z: best.d },
      { collider: false },
    );
  }
}

const _dir = new THREE.Vector3();
const _color = new THREE.Color();

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

/** Sun shafts through the skylight panes (one segment per pane, ending where the sun lands). */
function buildShafts(kit: LevelKit, time: TimeUniform): VolumetricShafts | null {
  const sun = LAB.sun.direction;
  _dir.set(sun[0], sun[1], sun[2]);
  if (_dir.lengthSq() < 1e-8 || _dir.y >= 0) {
    log.warn('Sun does not shine downwards – no skylight shafts');
    return null;
  }
  _dir.normalize();
  const S = L.atrium.skylight;
  const y = findSpace(L.spaces, 'atrium')!.ceiling;
  const pw = (S.maxX - S.minX) / S.panes[0];
  const pd = (S.maxZ - S.minZ) / S.panes[1];
  const m = S.mullion / 2;
  const segments: ShaftSegment[] = [];
  for (let i = 0; i < S.panes[0]; i++) {
    for (let k = 0; k < S.panes[1]; k++) {
      const x0 = S.minX + i * pw + m;
      const z0 = S.minZ + k * pd + m;
      const w = pw - m * 2;
      const d = pd - m * 2;
      const hit = kit.physics.raycast(
        { x: x0 + w / 2, y: y - 0.05, z: z0 + d / 2 },
        _dir,
        LEVEL_KIT.volumeRayMaxDistance,
      );
      const len = hit ? hit.distance : y / -_dir.y;
      segments.push({
        origin: { x: x0, y, z: z0 },
        edgeA: { x: w, y: 0, z: 0 },
        edgeB: { x: 0, y: 0, z: d },
        extrude: { x: _dir.x * len, y: _dir.y * len, z: _dir.z * len },
        fadeU0: true,
        fadeU1: true,
      });
    }
  }
  if (segments.length === 0) return null;
  const c = LAB.sun.color;
  return new VolumetricShafts(
    segments,
    color3(c),
    VOLUMETRIC_SHAFT.intensity * LAB.sun.intensity * S.shaftIntensity,
    time,
  );
}
