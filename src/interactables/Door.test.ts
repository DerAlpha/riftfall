import { describe, expect, it } from 'vitest';
import { Group, Vector3 } from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { BLOCKERS, DOORS } from '../defs/interactables';
import { NAV } from '../defs/nav';
import type { DoorSlotDef } from '../maps/types';
import { CombatWorld } from '../combat/CombatWorld';
import { createDecalAtlas } from '../vfx/decalAtlas';
import { DecalSystem } from '../vfx/DecalSystem';
import { fakeRender } from '../vfx/testFakes';
import { Door, type DoorState, type DoorViewApi } from './Door';
import { doorBulletBox, doorColliderBox, doorNavBox } from './shapes';
import { SolidBlocker } from './SolidBlocker';
import { FakeCombat, FakeEconomy, FakeNav, FakePhysics } from './testFakes';

const DT = 1 / 60;

function slot(overrides: Partial<DoorSlotDef> = {}): DoorSlotDef {
  return {
    id: 'door_a_b',
    position: new Vector3(4, 0, 10),
    facing: 'nz',
    yaw: Math.PI,
    width: 3.2,
    height: 3.4,
    depth: 0.6,
    zoneA: 'a',
    zoneB: 'b',
    costHint: 750,
    blast: false,
    ...overrides,
  };
}

class RecordingView implements DoorViewApi {
  amounts: number[] = [];
  states: DoorState[] = [];
  disposed = false;
  setOpenAmount(t: number): void {
    this.amounts.push(t);
  }
  setState(s: DoorState): void {
    this.states.push(s);
  }
  update(): void {}
  dispose(): void {
    this.disposed = true;
  }
}

function setup(points = 1000, s = slot()) {
  const events = new EventBus<GameEvents>();
  const opened: GameEvents['door:opened'][] = [];
  events.on('door:opened', (p) => opened.push({ doorId: p.doorId, zones: [...p.zones] }));
  const economy = new FakeEconomy(points);
  const activated: string[] = [];
  const zones = { activate: (z: string) => activated.push(z) };
  const physics = new FakePhysics();
  const nav = new FakeNav();
  const combat = new FakeCombat();
  const parent = new Group();
  const blocker = new SolidBlocker(
    { physics, combat, nav, parent },
    {
      collider: doorColliderBox(s),
      bullets: { box: doorBulletBox(s), materialId: DOORS.blockerMaterial },
      nav: doorNavBox(s),
    },
    true,
  );
  const view = new RecordingView();
  const names: Record<string, string> = { b: 'Atrium' };
  const door = new Door(s, {
    events,
    economy,
    zones,
    blocker,
    price: 750,
    view,
    zoneName: (z) => names[z] ?? null,
  });
  return { door, economy, activated, opened, physics, nav, combat, view, s };
}

function runOpen(door: Door, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) door.fixedUpdate(DT);
}

describe('Door', () => {
  it('starts closed: collider, bullet blocker and nav area in place', () => {
    const t = setup();
    expect(t.door.state).toBe('closed');
    expect(t.physics.live).toBe(1);
    expect(t.combat.meshes).toHaveLength(1);
    expect(t.combat.meshes[0]!.name).toBe(`level:${DOORS.blockerMaterial}`);
    expect(t.nav.state(doorNavBox(t.s).center)).toBe(true);
    // The collider fills the passage (yaw 180°: width along X, depth along Z).
    const c = t.physics.colliders[0]!;
    expect(c.half.x).toBeCloseTo(t.s.width / 2);
    expect(c.half.z).toBeCloseTo(t.s.depth / 2);
    expect(c.center.y).toBeCloseTo(t.s.height / 2);
    // Prompts on both sides, in front of each face.
    const [a, b] = t.door.sides;
    // Zone A side: the door leads into zone B (named); zone B side: zone A has no name here.
    expect(a.prompt()).toBe(`${DOORS.prompt.service}: Atrium`);
    expect(b.prompt()).toBe(DOORS.prompt.service);
    expect(a.cost()).toBe(750);
    expect(Math.abs(a.position.z - b.position.z)).toBeCloseTo(DOORS.anchor.offset * 2);
  });

  it('refuses a purchase without enough points', () => {
    const t = setup(500);
    t.door.sides[0].interact();
    expect(t.door.state).toBe('closed');
    expect(t.economy.refused).toHaveLength(1);
    expect(t.opened).toHaveLength(0);
    expect(t.physics.live).toBe(1);
  });

  it('opens on purchase: zones and event at once, passable at passableAt, open at the end', () => {
    const t = setup(1000);
    t.door.sides[1].interact();
    expect(t.economy.spent).toEqual([{ cost: 750, item: 'door_a_b', kind: 'door' }]);
    expect(t.door.state).toBe('opening');
    expect(t.activated).toEqual(['a', 'b']);
    expect(t.opened).toEqual([{ doorId: 'door_a_b', zones: ['a', 'b'] }]);
    expect(t.door.sides[0].prompt()).toBe('');
    expect(t.door.sides[0].canInteract()).toBe(false);
    // Just before passableAt: still solid.
    runOpen(t.door, DOORS.openDuration * DOORS.passableAt - 2 * DT);
    expect(t.physics.live).toBe(1);
    runOpen(t.door, 3 * DT);
    expect(t.physics.live).toBe(0);
    expect(t.nav.state(doorNavBox(t.s).center)).toBe(false);
    expect(t.combat.meshes[0]!.mesh.position.y).toBeLessThan(BLOCKERS.parkOffsetY / 2);
    runOpen(t.door, DOORS.openDuration);
    expect(t.door.state).toBe('open');
    expect(t.view.states).toEqual(['closed', 'opening', 'open']);
    // A second purchase does nothing.
    t.door.sides[0].interact();
    expect(t.economy.spent).toHaveLength(1);
  });

  it('interpolates the view between ticks', () => {
    const t = setup();
    t.door.open();
    t.door.fixedUpdate(DT);
    t.door.fixedUpdate(DT);
    t.door.update(DT, 0.5, 0);
    const last = t.view.amounts.at(-1)!;
    expect(last).toBeCloseTo((1.5 * DT) / DOORS.openDuration, 5);
  });

  it('reset closes it again: collider back, nav blocked, bullets stopped', () => {
    const t = setup();
    t.door.open();
    runOpen(t.door, DOORS.openDuration + 0.1);
    expect(t.door.state).toBe('open');
    t.door.reset();
    expect(t.door.state).toBe('closed');
    expect(t.physics.live).toBe(1);
    expect(t.nav.state(doorNavBox(t.s).center)).toBe(true);
    expect(t.combat.meshes[0]!.mesh.position.y).toBeCloseTo(t.s.height / 2);
    expect(t.view.amounts.at(-1)).toBe(0);
    expect(t.door.sides[0].canInteract()).toBe(true);
    // Resetting a closed door is harmless (no second collider).
    t.door.reset();
    expect(t.physics.live).toBe(1);
  });

  it('blast doors take longer and use the blast prompt', () => {
    const t = setup(2000, slot({ blast: true, width: 4.4, height: 4 }));
    expect(t.door.sides[1].prompt()).toBe(DOORS.prompt.blast);
    t.door.open();
    runOpen(t.door, DOORS.openDuration + 0.05);
    expect(t.door.state).toBe('opening');
    runOpen(t.door, DOORS.blastOpenDuration);
    expect(t.door.state).toBe('open');
  });

  it('extends the nav area through the doorway by the agent radius', () => {
    const s = slot({ yaw: Math.PI / 2, facing: 'px' });
    const nb = doorNavBox(s);
    // Walking axis X: through-half = depth / 2 + agent radius + extra.
    expect(nb.half.x).toBeCloseTo(s.depth / 2 + NAV.build.agentRadius + DOORS.navExtra);
    expect(nb.half.z).toBeCloseTo(s.width / 2 + NAV.build.agentRadius);
    expect(nb.center.y - nb.half.y).toBeLessThan(0);
  });

  it('dispose removes the collider and unblocks the nav area', () => {
    const t = setup();
    t.door.dispose();
    expect(t.physics.live).toBe(0);
    expect(t.nav.state(doorNavBox(t.s).center)).toBe(false);
    expect(t.view.disposed).toBe(true);
  });

  it('stops bullets and line of sight while closed, lets them through once open (real CombatWorld)', () => {
    const s = slot();
    const combat = new CombatWorld({ events: new EventBus<GameEvents>() });
    const parent = new Group();
    const blocker = new SolidBlocker(
      { physics: null, combat, nav: null, parent },
      { collider: null, bullets: { box: doorBulletBox(s), materialId: DOORS.blockerMaterial }, nav: null },
      true,
    );
    const from = { x: s.position.x, y: 1.5, z: s.position.z - 3 };
    const to = { x: s.position.x, y: 1.5, z: s.position.z + 3 };
    const dir = { x: 0, y: 0, z: 1 };
    const hit = combat.raycast(from, dir, 10);
    expect(hit).not.toBeNull();
    expect(hit!.surface).toBe('metal');
    expect(hit!.point.z).toBeCloseTo(s.position.z - doorBulletBox(s).half.z, 3);
    expect(combat.lineOfSight(from, to)).toBe(false);
    blocker.setBlocked(false);
    expect(combat.raycast(from, dir, 10)).toBeNull();
    expect(combat.lineOfSight(from, to)).toBe(true);
    // Nothing is hit where the mesh is parked either (the broadphase box stayed at the door).
    const below = {
      x: s.position.x,
      y: s.position.y + BLOCKERS.parkOffsetY + s.height / 2,
      z: s.position.z - 3,
    };
    expect(combat.raycast(below, dir, 10)).toBeNull();
    blocker.setBlocked(true);
    expect(combat.raycast(from, dir, 10)).not.toBeNull();
    blocker.dispose();
    expect(combat.raycast(from, dir, 10)).toBeNull();
  });

  it('bullet holes on the leaves vanish when the door opens (real DecalSystem)', () => {
    const s = slot();
    const time = { value: 12 };
    const decals = new DecalSystem(createDecalAtlas(), fakeRender(), 32, 32, time);
    const face = doorBulletBox(s);
    const n = { x: 0, y: 0, z: -1 };
    // Two holes on the zone A face of the leaves, one on the wall beside the door frame.
    decals.add('bullet.metal', { x: 4.3, y: 1.2, z: face.center.z - face.half.z }, n, 1, 0, 0);
    decals.add('bullet.metal', { x: 3.1, y: 2.6, z: face.center.z - face.half.z }, n, 1, 0, 0);
    decals.add(
      'bullet.concrete',
      { x: 4 + s.width / 2 + 0.6, y: 1.5, z: s.position.z - s.depth / 2 },
      n,
      1,
      0,
      0,
    );
    const events = new EventBus<GameEvents>();
    const door = new Door(s, {
      events,
      economy: new FakeEconomy(0),
      zones: null,
      blocker: null,
      price: 0,
      decals,
    });
    const die = (i: number): number =>
      (decals.mesh.geometry.getAttribute('aDecal').array as Float32Array)[i * 4 + 2]!;
    expect(die(0)).toBeGreaterThan(1e8);
    door.open();
    expect(die(0)).toBeLessThanOrEqual(time.value);
    expect(die(1)).toBeLessThanOrEqual(time.value);
    // The wall keeps its hole.
    expect(die(2)).toBeGreaterThan(1e8);
    // Shots that land on the leaves while they unseal go when the passage opens.
    time.value = 12.2;
    decals.add('bullet.metal', { x: 4.1, y: 1.4, z: face.center.z - face.half.z }, n, 1, 0, 0);
    runOpen(door, door.duration);
    expect(die(3)).toBeLessThanOrEqual(time.value);
    decals.dispose();
  });
});
