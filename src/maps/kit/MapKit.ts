/**
 * Map kit composition (M7): everything a map gets beyond its geometry, built from the level's own
 * data (maps/kit/levelData – the level's MapLevelInstance fields first, the per-map tables in
 * src/defs otherwise) –
 * - GravityZones (permanent zones + anomalies; Game hands it to the player and the projectiles),
 * - the PowerGrid (created BEFORE the interactables: placeInteractables registers the machines
 *   through its gate and hands it their visuals – createPowerGrid),
 * - TrapSystem, MapEventDirector, QuestSystem, their dev commands,
 * - the boss arena (M6) and the music theme.
 *
 * Game integration (composition root):
 *   construction – after the interactables / seals / power-ups (the systems it reads), BEFORE the
 *     shader warm-up (its props compile with the world); OR `hasVolumetricContent` into the
 *     volumetric content probe;
 *   fixed tick – fixedUpdate(dt) after the fields, before the status effects (traps hit this tick's
 *     hitboxes; their shock / burn build-up resolves in the same tick);
 *   frame – update(dt, listener) AFTER level.update and interactables.update: the power dimmer scales
 *     what those wrote this frame;
 *   run reset – reset(seed) after the interactables (power on, events ended, traps ready, quest back
 *     to step 1).
 */
import { Group, type Material, type Object3D } from 'three';
import type {
  ConsoleCommand,
  EconomyApi,
  EnemySpawnOptions,
  InteractionApi,
  LevelInstance,
  MaterialLibraryApi,
  PerkApi,
  ZoneApi,
} from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type { GameEvents, Vec3Like } from '../../core/events';
import { createLogger } from '../../core/log';
import { createEventCommands } from '../../mapEvents/eventCommands';
import { MapEventDirector } from '../../mapEvents/MapEventDirector';
import { createQuestCommands } from '../../quests/questCommands';
import { QuestSystem } from '../../quests/QuestSystem';
import { createTrapCommands } from '../../traps/trapCommands';
import { TrapSystem } from '../../traps/TrapSystem';
import { isMapLevel, type BossArenaDef, type MapLevelInstance } from '../types';
import { createGravityCommands } from './gravityCommands';
import { GravityZones } from './GravityZones';
import type { KitAudio, KitBanner, KitBlockers, KitCombat, KitPlayer, KitVfx, KitVisuals } from './kitTypes';
import {
  resolveBossArena,
  resolveEventDefs,
  resolveGenerators,
  resolveGravityZones,
  resolveMusicTheme,
  resolveQuestDef,
  resolveTrapSlots,
} from './levelData';
import { PowerGrid, collectLightGroups } from './PowerGrid';

const log = createLogger('mapkit');

/** The power grid of a level: its light groups (or collected ones) and powered props. */
export function createPowerGrid(
  level: LevelInstance,
  events: EventBus<GameEvents> | null,
  reduceFlashing: boolean,
): PowerGrid {
  const grid = new PowerGrid({ events, reduceFlashing });
  const k = level as Partial<MapLevelInstance>;
  grid.setLightGroups(k.lightGroups ?? collectLightGroups(level.root));
  if (k.poweredObjects && k.poweredObjects.length > 0) grid.addPoweredVisuals(k.poweredObjects);
  return grid;
}

export interface MapKitDeps {
  level: LevelInstance;
  mapId: string;
  events: EventBus<GameEvents>;
  power: PowerGrid;
  combat: KitCombat;
  economy: Pick<EconomyApi, 'spend' | 'earn'>;
  interaction: Pick<InteractionApi, 'register' | 'unregister' | 'focused' | 'holdProgress'>;
  zones: Pick<ZoneApi, 'isActive'>;
  enemies: { spawn(type: string, position: Vec3Like, opts?: EnemySpawnOptions): number | null };
  enemyType(id: number): string | null;
  isKnownEnemyType(type: string): boolean;
  waves: MapEventDirectorWaves;
  player: KitPlayer;
  weapons: { give(weaponId: string): void } | null;
  perks: Pick<PerkApi, 'has' | 'grant'> | null;
  audio?: KitAudio | null;
  vfx?: KitVfx | null;
  banner?: KitBanner | null;
  shockwave?: ((position: Vec3Like, radius: number, strength: number) => void) | null;
  /** Solid kit props (generators, the quest socket, fan housings); null = not solid. */
  blockers?: Omit<KitBlockers, 'parent'> | null;
  /** Null: logic only (tests / headless). */
  visuals?: {
    scene: Object3D;
    materials: MaterialLibraryApi;
    setupMaterial(m: Material): void;
    reduceFlashing: boolean;
  } | null;
  seed: string;
}

type MapEventDirectorWaves = ConstructorParameters<typeof MapEventDirector>[0]['waves'];

export class MapKit {
  readonly gravity: GravityZones;
  readonly power: PowerGrid;
  readonly traps: TrapSystem;
  readonly director: MapEventDirector;
  readonly quest: QuestSystem;
  /** M6: where boss fights happen on this map (null: unknown). */
  readonly bossArena: BossArenaDef | null;
  /** Music theme id of the map (defs/music mapThemes). */
  readonly musicTheme: string;
  private readonly root: Group | null;
  private readonly time = { value: 0 };
  private readonly visuals: KitVisuals | null;

  constructor(deps: MapKitDeps) {
    const { level, mapId } = deps;
    this.power = deps.power;
    this.gravity = new GravityZones(resolveGravityZones(level));
    this.bossArena = resolveBossArena(level, mapId);
    this.musicTheme = resolveMusicTheme(level, mapId);
    const v = deps.visuals ?? null;
    if (v) {
      const root = new Group();
      root.name = 'mapkit';
      v.scene.add(root);
      this.root = root;
      this.visuals = {
        root,
        materials: v.materials,
        setupMaterial: (m) => v.setupMaterial(m),
        time: this.time,
        reduceFlashing: v.reduceFlashing,
      };
    } else {
      this.root = null;
      this.visuals = null;
    }
    // Hidden bullet meshes of solid props hang under the kit root (or nowhere without visuals).
    const blockers: KitBlockers | null = deps.blockers ? { ...deps.blockers, parent: this.root } : null;
    const zoneNames = new Map<string, string>(isMapLevel(level) ? level.zones.map((z) => [z.id, z.name]) : []);
    this.traps = new TrapSystem({
      slots: resolveTrapSlots(level, mapId),
      events: deps.events,
      combat: deps.combat,
      economy: deps.economy,
      interaction: deps.interaction,
      power: this.power,
      player: deps.player,
      vfx: deps.vfx ?? null,
      audio: deps.audio ?? null,
      visuals: this.visuals,
      blockers,
      seed: deps.seed,
    });
    this.director = new MapEventDirector({
      defs: resolveEventDefs(level, mapId),
      generators: resolveGenerators(level, mapId),
      events: deps.events,
      power: this.power,
      gravity: this.gravity,
      enemies: deps.enemies,
      waves: deps.waves,
      spawnPoints: level.spawnPoints ?? [],
      isZoneActive: (z) => deps.zones.isActive(z),
      zoneName: (z) => zoneNames.get(z) ?? z,
      player: deps.player,
      interaction: deps.interaction,
      isKnownType: deps.isKnownEnemyType,
      audio: deps.audio ?? null,
      vfx: deps.vfx ?? null,
      banner: deps.banner ?? null,
      shockwave: deps.shockwave ?? null,
      visuals: this.visuals,
      blockers,
      seed: deps.seed,
    });
    const pulse = (level as { pulseRift?: (s: number) => void }).pulseRift;
    this.quest = new QuestSystem({
      def: resolveQuestDef(level, mapId),
      mapId,
      events: deps.events,
      combat: deps.combat,
      interaction: deps.interaction,
      player: deps.player,
      weapons: deps.weapons,
      perks: deps.perks,
      economy: deps.economy,
      enemyType: deps.enemyType,
      zoneAt: isMapLevel(level) ? (x, z) => level.zoneAt(x, z) : null,
      audio: deps.audio ?? null,
      vfx: deps.vfx ?? null,
      banner: deps.banner ?? null,
      shockwave: deps.shockwave ?? null,
      pulse: typeof pulse === 'function' ? (s) => pulse.call(level, s) : null,
      visuals: this.visuals,
      blockers,
    });
    this.root?.updateMatrixWorld(true);
    log.info(
      `Map kit (${mapId}): ${this.traps.list.length} traps, ${this.director.list.length} events, ` +
        `${this.director.generators.length} generators, ${this.gravity.size} gravity zones, ` +
        `quest ${this.quest.questId ?? '–'}`,
    );
  }

  /** Something of the kit draws on the volumetric layer (arcs, flames, beacons, rings, screens). */
  get hasVolumetricContent(): boolean {
    return this.traps.hasVolumetricContent || this.director.hasVolumetricContent || this.quest.hasVolumetricContent;
  }

  fixedUpdate(dt: number): void {
    this.traps.fixedUpdate(dt);
    this.director.fixedUpdate(dt);
    this.quest.fixedUpdate(dt);
  }

  /** Per frame, after level.update and interactables.update (the power dimmer runs last). */
  update(dt: number, listener: Vec3Like | null): void {
    if (dt > 0) this.time.value += dt;
    this.traps.update(dt, listener);
    this.director.update(dt, listener);
    this.quest.update(dt, listener);
    this.power.update(dt);
  }

  /** New run: events ended (power on), traps ready, quest back to its first step. */
  reset(seed?: string): void {
    this.director.reset(seed);
    this.traps.reset(seed);
    this.quest.reset();
  }

  setReducedFlashing(reduced: boolean): void {
    if (this.visuals) this.visuals.reduceFlashing = reduced;
    this.traps.setReducedFlashing(reduced);
    this.director.setReducedFlashing(reduced);
    this.quest.setReducedFlashing(reduced);
    this.power.setReducedFlashing(reduced);
  }

  commands(scene: Object3D, player: () => Vec3Like): ConsoleCommand[] {
    return [
      ...createTrapCommands({ traps: this.traps }),
      ...createEventCommands({ director: this.director }),
      ...createQuestCommands({ quest: this.quest }),
      ...createGravityCommands({ gravity: this.gravity, scene, player }),
    ];
  }

  dispose(): void {
    this.traps.dispose();
    this.director.dispose();
    this.quest.dispose();
    this.root?.removeFromParent();
  }
}
