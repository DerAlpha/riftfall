import { describe, expect, it } from 'vitest';
import { Group, Vector3 } from 'three';
import type { Interactable, LevelInstance } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { Rng } from '../../core/Rng';
import { LAB } from '../../defs/maps';
import { MYSTERY_BOX, PERK_MACHINES, ZONES, type BoxLocationDef } from '../../defs/interactables';
import { GENERATORS, MAP_EVENT_DEFS } from '../../defs/mapEvents';
import { QUESTS } from '../../defs/quests';
import { TRAP_SLOTS, type TrapSlotDef } from '../../defs/traps';
import { RIFT_FORGE_MACHINE, WORKBENCH } from '../../defs/workshop';
import { placeInteractables } from '../../interactables/placeInteractables';
import type { WorkshopWeapons } from '../../interactables/RiftForge';
import { FakeEconomy, FakeNav, FakePerks, FakePhysics, FakeWeapons } from '../../interactables/testFakes';
import type { MapLevelInstance } from '../types';
import {
  resolveBenchPlacement,
  resolveBossArena,
  resolveBoxLocations,
  resolveBoxStartIds,
  resolveEventDefs,
  resolveForgePlacement,
  resolveGenerators,
  resolveMusicTheme,
  resolvePerkSpots,
  resolveQuestDef,
  resolveStartZones,
  resolveTrapSlots,
} from './levelData';
import { PowerGrid } from './PowerGrid';
import { createZoneSystem } from './zones';

/** A wave-map level without geometry (logic-only placement). */
function fakeLevel(id: string, extra: Partial<MapLevelInstance> = {}): MapLevelInstance {
  return {
    id,
    atmosphere: LAB,
    root: new Group(),
    spawn: { position: new Vector3(), yaw: 0 },
    spawnPoints: [
      { id: 'a', position: new Vector3(10, 0, 0), yaw: 0, zone: 'hub', kind: 'rift' },
      { id: 'b', position: new Vector3(-10, 0, 0), yaw: 0, zone: 'hub', kind: 'rift' },
      { id: 'c', position: new Vector3(0, 0, 50), yaw: 0, zone: 'far', kind: 'rift' },
    ],
    zones: [
      { id: 'hub', name: 'Nabe' },
      { id: 'far', name: 'Fern' },
    ],
    doorSlots: [],
    wallBuySlots: [],
    hasVolumetricContent: false,
    zoneAt: () => 'hub',
    update() {},
    stats: { meshes: 0, lights: 0, colliders: 0, dynamicBodies: 0 },
    dispose() {},
    ...extra,
  };
}

const PERK_SPOTS = [
  { id: 'p1', position: [5, 0, 5] as const, facing: 'nz' as const, zone: 'hub' },
  { id: 'p2', position: [8, 0, 5] as const, facing: 'nz' as const, zone: 'hub' },
];
const BOXES: BoxLocationDef[] = [
  { id: 'b1', position: [0, 0, 10], facing: 'pz', zone: 'hub' },
  { id: 'b2', position: [0, 0, 20], facing: 'pz', zone: 'far' },
];
const FENCE: TrapSlotDef = {
  id: 'f',
  kind: 'fence',
  zone: 'hub',
  a: [0, 0, 0],
  b: [0, 0, 4],
  panel: { position: [1, 1.3, 0], facing: 'px' },
};

describe('level-provided placements (maps/kit/levelData)', () => {
  it('falls back to the per-map tables when the level brings nothing (lab unchanged)', () => {
    const lab = fakeLevel('lab');
    expect(resolveStartZones(lab)).toBe(ZONES.startZones.lab);
    expect(resolvePerkSpots(lab)).toBe(PERK_MACHINES.placements.lab);
    expect(resolveBoxLocations(lab)).toBe(MYSTERY_BOX.locations.lab);
    expect(resolveBoxStartIds(lab)).toBe(MYSTERY_BOX.start.lab);
    expect(resolveForgePlacement(lab)).toBe(RIFT_FORGE_MACHINE.placements.lab![0]);
    expect(resolveBenchPlacement(lab)).toBe(WORKBENCH.placements.lab![0]);
    expect(resolveTrapSlots(lab)).toBe(TRAP_SLOTS.lab);
    expect(resolveEventDefs(lab)).toBe(MAP_EVENT_DEFS.lab);
    expect(resolveGenerators(lab)).toBe(GENERATORS.lab);
    expect(resolveQuestDef(lab)).toBe(QUESTS.lab);
    expect(resolveMusicTheme(lab)).toBe('lab');
    expect(resolveBossArena(lab)?.zone).toBe('atrium');
  });

  it('prefers the level data over the tables, also on a map id that has tables', () => {
    const forge = { id: 'my_forge', position: [1, 0, 1] as const, facing: 'pz' as const, zone: 'hub' };
    const level = fakeLevel('lab', {
      startZones: ['hub'],
      perkSpots: PERK_SPOTS,
      boxLocations: BOXES,
      forgePlacement: forge,
      benchPlacement: null,
      trapSlots: [FENCE],
      eventDefs: [],
      generators: [],
      questDef: null,
      musicTheme: 'reactor',
      bossArena: { center: { x: 1, y: 0, z: 2 }, radius: 9, zone: 'hub' },
    });
    expect(resolveStartZones(level)).toEqual(['hub']);
    expect(resolvePerkSpots(level)).toBe(PERK_SPOTS);
    expect(resolveBoxLocations(level)).toBe(BOXES);
    // Level locations without start ids: any location (the table's ids name other boxes).
    expect(resolveBoxStartIds(level)).toEqual([]);
    expect(resolveForgePlacement(level)).toBe(forge);
    expect(resolveBenchPlacement(level)).toBeNull();
    expect(resolveTrapSlots(level)).toEqual([FENCE]);
    expect(resolveEventDefs(level)).toEqual([]);
    expect(resolveGenerators(level)).toEqual([]);
    expect(resolveQuestDef(level)).toBeNull();
    expect(resolveMusicTheme(level)).toBe('reactor');
    expect(resolveBossArena(level)?.radius).toBe(9);
  });

  it('knows nothing about an unknown map but derives a boss arena from its start zone rifts', () => {
    const level = fakeLevel('arctic', { startZones: ['hub'] });
    expect(resolvePerkSpots(level)).toEqual([]);
    expect(resolveBoxLocations(level)).toEqual([]);
    expect(resolveForgePlacement(level)).toBeNull();
    expect(resolveTrapSlots(level)).toEqual([]);
    expect(resolveQuestDef(level)).toBeNull();
    const arena = resolveBossArena(level)!;
    expect(arena.zone).toBe('hub');
    expect(arena.center.x).toBeCloseTo(0, 6);
    expect(arena.radius).toBeCloseTo(10, 6);
  });

  it('zone gating starts with the level’s start zones', () => {
    const zones = createZoneSystem(fakeLevel('arctic', { startZones: ['far'] }), new EventBus<GameEvents>());
    expect(zones.isActive('far')).toBe(true);
    expect(zones.isActive('hub')).toBe(false);
  });
});

const noWeapons: WorkshopWeapons = {
  currentWeaponId: 'rifle',
  state: 'idle',
  effectiveDef: () => null,
  modsOf: () => null,
  setWeaponMods: () => true,
};

function place(level: LevelInstance, power: PowerGrid | null) {
  const registered: Interactable[] = [];
  const handle = placeInteractables({
    level,
    events: new EventBus<GameEvents>(),
    economy: new FakeEconomy(100_000),
    weapons: new FakeWeapons(['pistol']),
    perks: new FakePerks(16),
    zones: null,
    interaction: { register: (i) => registered.push(i), unregister: () => {} },
    physics: new FakePhysics(),
    combat: { addStaticMesh: () => {} },
    nav: new FakeNav(),
    rng: new Rng('kit-test'),
    workshop: { weapons: noWeapons },
    power,
  });
  return { handle, registered };
}

describe('placeInteractables with level data', () => {
  it('places perk machines, the box and the workshop from the level instead of the tables', () => {
    const bench = { id: 'my_bench', position: [-5, 0, 0] as const, facing: 'px' as const, zone: 'hub' };
    const level = fakeLevel('lab', {
      perkSpots: PERK_SPOTS,
      boxLocations: BOXES,
      boxStartIds: ['b2'],
      forgePlacement: null,
      benchPlacement: bench,
    });
    const { handle } = place(level, null);
    expect(handle.perkMachines.length).toBe(2);
    const xs = handle.perkMachines.map((m) => m.position.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(5, 3);
    expect(xs[1]).toBeCloseTo(8, 3);
    expect(handle.box).not.toBeNull();
    expect(handle.box!.location.id).toBe('b2');
    expect(handle.forge).toBeNull();
    expect(handle.workbench).not.toBeNull();
    expect(handle.workbench!.position.x).toBeGreaterThan(-5);
    expect(handle.workbench!.position.x).toBeLessThan(-3);
  });

  it('keeps the lab tables when the level has no data', () => {
    const { handle } = place(fakeLevel('lab'), null);
    expect(handle.perkMachines.length).toBe(Math.min(16, PERK_MACHINES.placements.lab!.length));
    expect(handle.forge).not.toBeNull();
    expect(handle.workbench).not.toBeNull();
    expect(handle.box).not.toBeNull();
  });

  it('registers the powered machines through the power gate: purchases refused while unpowered', () => {
    const power = new PowerGrid({ events: null });
    const level = fakeLevel('lab', { perkSpots: PERK_SPOTS, boxLocations: BOXES });
    const { handle, registered } = place(level, power);
    const perk = registered.find((i) => i.id === handle.perkMachines[0]!.id)!;
    const bench = registered.find((i) => i.id === handle.workbench!.id)!;
    const box = registered.find((i) => i.id === handle.box!.id)!;
    // The bench is registered as itself (its menu compares the focus with itself).
    expect(bench).toBe(handle.workbench);
    expect(perk).not.toBe(handle.perkMachines[0]);
    expect(perk.canInteract()).toBe(true);
    expect(perk.cost()).toBeGreaterThan(0);
    power.setPowered(false);
    expect(perk.canInteract()).toBe(false);
    expect(perk.prompt()).toBe('Kein Strom');
    expect(perk.cost()).toBeNull();
    expect(box.canInteract()).toBe(false);
    perk.interact();
    expect(handle.perkMachines[0]!.availability).toBe('available');
    power.setPowered(true);
    expect(perk.canInteract()).toBe(true);
    expect(perk.prompt()).toBe(handle.perkMachines[0]!.prompt());
  });
});
