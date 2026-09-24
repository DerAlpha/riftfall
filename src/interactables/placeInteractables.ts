/**
 * Builds every interactable of a map from the level and defs/interactables.ts:
 * - doors at the level's DoorSlotDefs (wave maps),
 * - wall buys at the level's wall-buy slots (weapon from WALL_BUYS.offers, else the slot's hint)
 *   plus WALL_BUYS.placements[map],
 * - one perk machine per perk at PERK_MACHINES.placements[map] (pinned perks first, then the perk
 *   table order; extra perks without a spot are skipped with a warning),
 * - the Rift-Kiste wandering between MYSTERY_BOX.locations[map].
 * Everything is registered with the InteractionSystem; solid parts (closed doors, machines, the
 * box) get colliders, bullet blockers and navmesh areas (SolidBlocker). Without `visuals` only the
 * logic is built (tests, headless tools).
 *
 * INTEGRATION (Game.ts, by the lead):
 *   construction – after the level, physics, combat, nav (the nav areas are registered before or
 *     after nav.build: NavSystem splits them on activation / on the next update), vfx, player,
 *     weapons, economy, perks and zones; BEFORE the shader warm-up (compileForPostChain) so their
 *     programs are compiled with the world. Add `handle.hasVolumetricContent` to
 *     render.setVolumetricContentProbe (holograms, beam and glow pools live on that layer).
 *   fixed tick – interaction.fixedUpdate(dt) right after player.fixedUpdate (focus from this
 *     tick's eye, the press latched this frame), handle.fixedUpdate(dt) before physics.step (door
 *     colliders and the box collider change in the same step).
 *   frame – interaction.update(dt) after player.update; handle.update(dt, alpha) with the other
 *     world visuals (after vfx.update).
 *   run reset – handle.reset() and interaction.reset() in resetRunSystems (doors close, the box
 *     returns to a start location; zones.reset() separately).
 */
import { Group, Vector3, type Object3D } from 'three';
import type {
  EconomyApi,
  Interactable,
  InteractionApi,
  LevelInstance,
  MaterialLibraryApi,
  NavApi,
  PerkApi,
  PhysicsApi,
  RenderApi,
  VfxApi,
  ZoneApi,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import type { Rng } from '../core/Rng';
import { COLLISION_GROUP, interactionGroups } from '../defs/physics';
import {
  DOORS,
  MYSTERY_BOX,
  PERK_MACHINES,
  WALL_BUYS,
  type BoxLocationDef,
  type WallBuyPlacementDef,
} from '../defs/interactables';
import { getWeaponDef } from '../defs/weapons';
import { isMapLevel } from '../maps/types';
import { Door } from './Door';
import { MysteryBox, resolveBoxPool, type BoxLocation } from './MysteryBox';
import { PerkMachine } from './PerkMachine';
import {
  doorBulletBox,
  doorColliderBox,
  doorNavBox,
  facingNormal,
  facingYaw,
  propBox,
  propNavBox,
} from './shapes';
import { SolidBlocker, type SolidBlockerDeps } from './SolidBlocker';
import {
  createDefaultPrices,
  defaultPerkMachineInfos,
  type InteractablePrices,
  type InteractableWeapons,
  type PerkMachineInfo,
} from './types';
import { WallBuy } from './WallBuy';
import { BoxView } from './visuals/BoxView';
import type { VisualContext } from './visuals/context';
import { DoorView } from './visuals/DoorView';
import { setHoloReducedFlashing, type HoloMaterial, type TimeUniform } from './visuals/holo';
import { PerkMachineView } from './visuals/PerkMachineView';
import { WallBuyView } from './visuals/WallBuyView';
import { WeaponHologramLibrary } from './visuals/weaponHolograms';

const log = createLogger('interactables');

/** Upward ray for the box beam: static world only. */
const CEILING_GROUPS = interactionGroups(COLLISION_GROUP.WORLD, COLLISION_GROUP.WORLD);
const UP = { x: 0, y: 1, z: 0 };

export interface InteractableVisualDeps {
  /** Parent of the props (the world scene – not level.root). */
  scene: Object3D;
  materials: MaterialLibraryApi;
  render: Pick<RenderApi, 'setupMaterial'> | null;
  reduceFlashing: boolean;
}

export interface PlaceInteractablesDeps {
  level: LevelInstance;
  events: EventBus<GameEvents>;
  economy: Pick<EconomyApi, 'spend' | 'earn' | 'canAfford'>;
  weapons: InteractableWeapons;
  /** Null: no perk machines. */
  perks: Pick<PerkApi, 'has' | 'grant' | 'owned' | 'maxPerks'> | null;
  zones: Pick<ZoneApi, 'activate'> | null;
  interaction: Pick<InteractionApi, 'register' | 'unregister'>;
  physics:
    (Pick<PhysicsApi, 'addStaticBox' | 'removeCollider'> & Partial<Pick<PhysicsApi, 'raycast'>>) | null;
  combat: SolidBlockerDeps['combat'];
  nav: Pick<NavApi, 'setAreaBlocked'> | null;
  /** Seeded run randomness (box results, relocation). */
  rng: Rng;
  vfx?: Pick<VfxApi, 'spawn'> | null;
  /** Player feet + capsule radius (the box never materializes on the player). */
  player?: { readonly position: Vec3Like; readonly radius: number } | null;
  prices?: InteractablePrices;
  perkInfos?: readonly PerkMachineInfo[];
  /** Null: logic only (tests / headless). */
  visuals?: InteractableVisualDeps | null;
  /** Map id for the per-map placements (default: level.id). */
  mapId?: string;
}

export interface InteractablesHandle {
  readonly doors: readonly Door[];
  readonly wallBuys: readonly WallBuy[];
  readonly perkMachines: readonly PerkMachine[];
  readonly box: MysteryBox | null;
  /** Everything registered with the InteractionSystem. */
  readonly interactables: readonly Interactable[];
  /** Holograms, beam and glow pools draw on RENDER.volumetricLayer. */
  readonly hasVolumetricContent: boolean;
  fixedUpdate(dt: number): void;
  update(dt: number, alpha: number): void;
  /**
   * New run: doors closed, the box back at a start location. `seed` restarts the box's random
   * streams (per-run seed; the same seed replays the same box results).
   */
  reset(seed?: string | number): void;
  setReducedFlashing(reduced: boolean): void;
  dispose(): void;
}

export function placeInteractables(deps: PlaceInteractablesDeps): InteractablesHandle {
  const mapId = deps.mapId ?? deps.level.id;
  const prices = deps.prices ?? createDefaultPrices();
  const v = deps.visuals ?? null;

  // Visual context (shared time uniform, hologram geometry, holo material registry).
  const time: TimeUniform = { value: 0 };
  const holoMaterials: HoloMaterial[] = [];
  let root: Group | null = null;
  let ctx: VisualContext | null = null;
  const holograms = v ? new WeaponHologramLibrary() : null;
  if (v && holograms) {
    root = new Group();
    root.name = 'interactables';
    v.scene.add(root);
    const physics = deps.physics;
    ctx = {
      root,
      materials: v.materials,
      setupMaterial: (m) => v.render?.setupMaterial(m),
      time,
      holograms,
      reduceFlashing: v.reduceFlashing,
      ceilingAbove:
        physics?.raycast !== undefined
          ? (x, y, z) => {
              const hit = physics.raycast!(
                { x, y: y + MYSTERY_BOX.beam.ceilingMargin, z },
                UP,
                MYSTERY_BOX.beam.maxHeight,
                { groups: CEILING_GROUPS },
              );
              return hit ? y + MYSTERY_BOX.beam.ceilingMargin + hit.distance : null;
            }
          : undefined,
    };
  }
  const blockerDeps: SolidBlockerDeps = {
    physics: deps.physics,
    combat: deps.combat,
    nav: deps.nav,
    parent: root ?? deps.visuals?.scene ?? null,
  };

  const interactables: Interactable[] = [];
  const register = (i: Interactable): void => {
    interactables.push(i);
    deps.interaction.register(i);
  };

  // --- doors ---
  const doors: Door[] = [];
  if (isMapLevel(deps.level)) {
    const zoneNames = new Map(deps.level.zones.map((z) => [z.id, z.name] as const));
    const zoneName = (id: string): string | null => zoneNames.get(id) ?? null;
    for (const slot of deps.level.doorSlots) {
      const price = prices.door(slot.costHint, slot.blast);
      const blocker = new SolidBlocker(
        blockerDeps,
        {
          collider: doorColliderBox(slot),
          bullets: { box: doorBulletBox(slot), materialId: DOORS.blockerMaterial },
          nav: doorNavBox(slot),
        },
        true,
      );
      const view = ctx ? new DoorView(slot, price, ctx) : null;
      const door = new Door(slot, {
        events: deps.events,
        economy: deps.economy,
        zones: deps.zones,
        blocker,
        price,
        view,
        zoneName,
      });
      doors.push(door);
      for (const side of door.sides) register(side);
    }
  }

  // --- wall buys ---
  const wallBuys: WallBuy[] = [];
  for (const def of collectWallBuys(deps.level, mapId)) {
    const weapon = getWeaponDef(def.weapon);
    if (!weapon || weapon.boxOnly === true) {
      log.warn(`Wall buy "${def.id}": weapon "${def.weapon}" is unknown or box-only – skipped`);
      continue;
    }
    const n = facingNormal(def.facing);
    const anchor = new Vector3(
      def.position[0] + n.x * WALL_BUYS.anchorOffset,
      def.position[1],
      def.position[2] + n.z * WALL_BUYS.anchorOffset,
    );
    const weaponPrice = prices.weapon(def.weapon);
    const ammoPrice = prices.ammo(def.weapon);
    const view = ctx
      ? new WallBuyView(
          {
            id: def.id,
            weaponId: def.weapon,
            label: weapon.name.toUpperCase(),
            ammoLabel: `${WALL_BUYS.plateText.ammo} · ${weapon.shortName}`,
            weaponPrice,
            ammoPrice,
            position: def.position,
            facing: def.facing,
          },
          ctx,
        )
      : null;
    const wb = new WallBuy(
      { id: def.id, weaponId: def.weapon, name: weapon.name, shortName: weapon.shortName, position: anchor },
      { weapons: deps.weapons, economy: deps.economy, prices, view },
    );
    wallBuys.push(wb);
    register(wb);
  }

  // --- perk machines ---
  const perkMachines: PerkMachine[] = [];
  if (deps.perks) {
    const infos = deps.perkInfos ?? defaultPerkMachineInfos();
    const spots = PERK_MACHINES.placements[mapId] ?? [];
    for (const { spot, perk } of assignPerkSpots(spots, infos)) {
      const P = PERK_MACHINES;
      const { width, height, depth } = P.size;
      const n = facingNormal(spot.facing);
      const yaw = facingYaw(spot.facing);
      const off = P.wallGap + depth / 2;
      const center = {
        x: spot.position[0] + n.x * off,
        y: spot.position[1],
        z: spot.position[2] + n.z * off,
      };
      const box = propBox(center, yaw, width, height, depth);
      const blocker = new SolidBlocker(
        blockerDeps,
        { collider: box, bullets: { box, materialId: P.blockerMaterial }, nav: propNavBox(box) },
        true,
      );
      const price = prices.perk(perk.id);
      const view = ctx ? new PerkMachineView(perk, price, center, yaw, ctx) : null;
      const a = depth / 2 + P.anchor.offset;
      const anchor = new Vector3(center.x + n.x * a, center.y + P.anchor.y, center.z + n.z * a);
      const machine = new PerkMachine(perk, anchor, {
        perks: deps.perks,
        economy: deps.economy,
        price,
        view,
        blocker,
      });
      perkMachines.push(machine);
      register(machine);
    }
  }

  // --- the Rift-Kiste ---
  let box: MysteryBox | null = null;
  const locDefs = MYSTERY_BOX.locations[mapId] ?? [];
  if (locDefs.length > 0) {
    const locations = locDefs.map((d) => boxLocation(d, blockerDeps));
    const startIds = MYSTERY_BOX.start[mapId] ?? [];
    const startLocations = startIds.map((id) => locDefs.findIndex((l) => l.id === id)).filter((i) => i >= 0);
    const pool = resolveBoxPool();
    if (holograms) holograms.prewarm(pool.map((e) => e.weapon));
    const view = ctx ? new BoxView(ctx, MYSTERY_BOX.anomalyName) : null;
    box = new MysteryBox({
      events: deps.events,
      economy: deps.economy,
      weapons: deps.weapons,
      price: prices.box(),
      rng: deps.rng,
      locations,
      startLocations,
      pool,
      weaponName: (id) => getWeaponDef(id)?.name ?? id,
      player: deps.player ?? null,
      vfx: deps.vfx ?? null,
      view,
    });
    register(box);
  }

  if (ctx) collectHolo(root, holoMaterials);
  root?.updateMatrixWorld(true);
  log.info(
    `Interactables (${mapId}): ${doors.length} doors, ${wallBuys.length} wall buys, ` +
      `${perkMachines.length} perk machines, ${box ? MYSTERY_BOX.locations[mapId]!.length : 0} box locations`,
  );

  let disposed = false;
  return {
    doors,
    wallBuys,
    perkMachines,
    box,
    interactables,
    get hasVolumetricContent(): boolean {
      return !disposed && root !== null && root.visible;
    },
    fixedUpdate(dt: number): void {
      if (disposed) return;
      for (let i = 0; i < doors.length; i++) doors[i]!.fixedUpdate(dt);
      box?.fixedUpdate(dt);
    },
    update(dt: number, alpha: number): void {
      if (disposed) return;
      time.value += dt;
      const t = time.value;
      for (let i = 0; i < doors.length; i++) doors[i]!.update(dt, alpha, t);
      for (let i = 0; i < wallBuys.length; i++) wallBuys[i]!.update(dt, t);
      for (let i = 0; i < perkMachines.length; i++) perkMachines[i]!.update(dt, t);
      box?.update(dt, t);
    },
    reset(seed?: string | number): void {
      if (disposed) return;
      for (const d of doors) d.reset();
      for (const w of wallBuys) w.reset();
      box?.reset(seed);
    },
    setReducedFlashing(reduced: boolean): void {
      if (!ctx) return;
      ctx.reduceFlashing = reduced;
      for (const m of holoMaterials) setHoloReducedFlashing(m, reduced);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const i of interactables) deps.interaction.unregister(i);
      for (const d of doors) d.dispose();
      for (const w of wallBuys) w.dispose();
      for (const m of perkMachines) m.dispose();
      box?.dispose();
      holograms?.dispose();
      root?.removeFromParent();
    },
  };
}

/** Level wall-buy slots (with the per-slot weapon offer) + the map's extra placements. */
export function collectWallBuys(level: LevelInstance, mapId: string): WallBuyPlacementDef[] {
  const out: WallBuyPlacementDef[] = [];
  if (isMapLevel(level)) {
    for (const s of level.wallBuySlots) {
      out.push({
        id: s.id,
        weapon: WALL_BUYS.offers[s.id] ?? s.weaponHint,
        position: [s.position.x, s.position.y, s.position.z],
        facing: s.facing,
        zone: s.zone,
      });
    }
  }
  for (const p of WALL_BUYS.placements[mapId] ?? []) {
    if (!out.some((o) => o.id === p.id)) out.push(p);
  }
  return out;
}

/** Pinned perks take their spot; the rest fill the free spots in catalog order. */
export function assignPerkSpots<S extends { readonly id: string; readonly perk?: string }>(
  spots: readonly S[],
  perks: readonly PerkMachineInfo[],
): { spot: S; perk: PerkMachineInfo }[] {
  const out: { spot: S; perk: PerkMachineInfo }[] = [];
  const used = new Set<string>();
  const free: S[] = [];
  for (const s of spots) {
    const pinned = s.perk ? perks.find((p) => p.id === s.perk) : undefined;
    if (pinned && !used.has(pinned.id)) {
      out.push({ spot: s, perk: pinned });
      used.add(pinned.id);
    } else {
      free.push(s);
    }
  }
  for (const p of perks) {
    if (used.has(p.id)) continue;
    const s = free.shift();
    if (!s) {
      log.warn(`No perk machine spot left for "${p.id}"`);
      continue;
    }
    out.push({ spot: s, perk: p });
    used.add(p.id);
  }
  return out;
}

function boxLocation(d: BoxLocationDef, blockerDeps: SolidBlockerDeps): BoxLocation {
  const S = MYSTERY_BOX.size;
  const yaw = facingYaw(d.facing);
  const n = facingNormal(d.facing);
  const position = new Vector3(d.position[0], d.position[1], d.position[2]);
  const box = propBox(position, yaw, S.width, S.height + S.lidHeight, S.depth);
  const blocker = new SolidBlocker(
    blockerDeps,
    { collider: box, bullets: { box, materialId: MYSTERY_BOX.materials.body }, nav: propNavBox(box) },
    false,
  );
  const a = S.depth / 2 + MYSTERY_BOX.anchor.offset;
  return {
    id: d.id,
    zone: d.zone,
    position,
    yaw,
    anchor: new Vector3(position.x + n.x * a, position.y + MYSTERY_BOX.anchor.y, position.z + n.z * a),
    halfX: box.half.x,
    halfZ: box.half.z,
    blocker,
  };
}

function collectHolo(root: Object3D | null, out: HoloMaterial[]): void {
  root?.traverse((o) => {
    const m = (o as { material?: unknown }).material as HoloMaterial | undefined;
    if (m && (m.name === 'holo-panel' || m.name === 'holo-model') && !out.includes(m)) out.push(m);
  });
}
