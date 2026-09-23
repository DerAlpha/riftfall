import { describe, expect, it } from 'vitest';
import { Mesh } from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import type { DamageInfo } from '../core/contracts';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { CombatWorld, staticMaterialId } from './CombatWorld';
import { FakeTarget, buildTestLevel } from './testFakes';

const FWD = { x: 0, y: 0, z: -1 };

function makeWorld(physics: PhysicsWorld | null = null) {
  const events = new EventBus<GameEvents>();
  const combat = new CombatWorld({ events, physics });
  // A concrete wall at z = -10 (front face z = -9.75) and a glass pane at z = -5.
  const root = buildTestLevel([
    { material: 'concrete_wall', center: { x: 0, y: 1.5, z: -10 }, size: { x: 10, y: 3, z: 0.5 } },
    { material: 'glass', center: { x: 0, y: 1.5, z: -5 }, size: { x: 2, y: 3, z: 0.04 }, noshadow: true },
    { material: 'floor_concrete', center: { x: 0, y: -0.25, z: -5 }, size: { x: 20, y: 0.5, z: 30 } },
  ]);
  combat.setLevel(root);
  return { events, combat, root };
}

describe('staticMaterialId', () => {
  it('parses level and panel mesh names', () => {
    expect(staticMaterialId('level:floor_concrete')).toBe('floor_concrete');
    expect(staticMaterialId('level:glass:noshadow')).toBe('glass');
    expect(staticMaterialId('panel:emissive_cyan')).toBe('emissive_cyan');
    expect(staticMaterialId('crate:crate')).toBeNull();
    expect(staticMaterialId('level:')).toBeNull();
  });
});

describe('CombatWorld static geometry (BVH)', () => {
  it('collects level meshes and returns the nearest surface with material surface/penetrable', () => {
    const { combat } = makeWorld();
    expect(combat.stats.staticMeshes).toBe(3);
    const glass = combat.raycast({ x: 0, y: 1.5, z: 0 }, FWD, 100);
    expect(glass).not.toBeNull();
    expect(glass!.distance).toBeCloseTo(4.98, 3);
    expect(glass!.surface).toBe('glass');
    expect(glass!.penetrable).toBe(true);
    expect(glass!.target).toBeNull();
    expect(glass!.normal.z).toBeCloseTo(1, 6);
    // Continue behind the pane: the wall.
    const wall = combat.raycast({ x: 0, y: 1.5, z: -5.1 }, FWD, 100);
    expect(wall!.surface).toBe('concrete');
    expect(wall!.penetrable).toBe(false);
    expect(wall!.point.z).toBeCloseTo(-9.75, 4);
    // Beside the glass: straight to the wall; max distance respected.
    expect(combat.raycast({ x: 3, y: 1.5, z: 0 }, FWD, 100)!.distance).toBeCloseTo(9.75, 4);
    expect(combat.raycast({ x: 3, y: 1.5, z: 0 }, FWD, 9)).toBeNull();
    // Floor below.
    const floor = combat.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: -2, z: 0 }, 10);
    expect(floor!.normal.y).toBeCloseTo(1, 6);
    expect(floor!.distance).toBeCloseTo(1, 6);
  });

  it('rejects degenerate rays and supports clearing the level', () => {
    const { combat } = makeWorld();
    expect(combat.raycast({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 0, z: 0 }, 100)).toBeNull();
    expect(combat.raycast({ x: Number.NaN, y: 1.5, z: 0 }, FWD, 100)).toBeNull();
    expect(combat.raycast({ x: 0, y: 1.5, z: 0 }, FWD, 0)).toBeNull();
    combat.setLevel(null);
    expect(combat.raycast({ x: 0, y: 1.5, z: 0 }, FWD, 100)).toBeNull();
  });

  it('line of sight is blocked by static geometry only', () => {
    const { combat } = makeWorld();
    const target = new FakeTarget({ x: 3, y: 0, z: -3 });
    combat.register(target);
    expect(combat.lineOfSight({ x: 3, y: 1.5, z: 0 }, { x: 3, y: 1.5, z: -8 })).toBe(true);
    expect(combat.lineOfSight({ x: 3, y: 1.5, z: 0 }, { x: 3, y: 1.5, z: -12 })).toBe(false);
    expect(combat.lineOfSight({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 1.5, z: -6 })).toBe(false);
  });

  it('meshes without a BVH (panels) are hit through the fallback raycast', () => {
    const { combat } = makeWorld();
    const panel = new Mesh(
      (combat as unknown as { statics: { mesh: Mesh }[] }).statics[0]!.mesh.geometry.clone(),
    );
    panel.geometry.boundsTree = undefined;
    panel.name = 'panel:emissive_cyan';
    panel.position.set(0, 0, 6);
    panel.updateMatrixWorld(true);
    combat.addStaticMesh(panel, 'emissive_cyan');
    const hit = combat.raycast({ x: 0, y: 1.5, z: 0 }, FWD, 100);
    // The panel (wall copy shifted +6 m) is now nearer than the glass.
    expect(hit!.point.z).toBeCloseTo(-3.75, 4);
    expect(hit!.surface).toBe('glass');
  });
});

describe('CombatWorld damageables', () => {
  it('hits head/body/limb hitboxes and prefers the nearest of world and targets', () => {
    const { combat } = makeWorld();
    const t = new FakeTarget({ x: 3, y: 0, z: -4 });
    combat.register(t);
    combat.register(t); // duplicate registration is ignored
    expect(combat.targets.length).toBe(1);
    const head = combat.raycast({ x: 3, y: 1.62, z: 0 }, FWD, 100);
    expect(head!.target).toBe(t);
    expect(head!.zone).toBe('head');
    expect(head!.surface).toBe('flesh');
    expect(head!.distance).toBeCloseTo(4 - 0.14, 6);
    expect(head!.normal.z).toBeCloseTo(1, 6);
    expect(combat.raycast({ x: 3, y: 1.1, z: 0 }, FWD, 100)!.zone).toBe('body');
    expect(combat.raycast({ x: 3, y: 0.4, z: 0 }, FWD, 100)!.zone).toBe('limb');
    // A target behind the wall is never hit.
    const hidden = new FakeTarget({ x: 3, y: 0, z: -12 });
    combat.register(hidden);
    expect(combat.raycast({ x: 3.8, y: 1.1, z: -6 }, FWD, 100)!.target).toBeNull();
    // Ignore options.
    expect(combat.raycast({ x: 3, y: 1.1, z: 0 }, FWD, 100, { ignore: t })!.target).toBeNull();
    expect(combat.raycast({ x: 3, y: 1.1, z: 0 }, FWD, 100, { ignoreMany: [t] })!.target).toBeNull();
    // Dead targets are skipped.
    t.health = 0;
    expect(combat.raycast({ x: 3, y: 1.1, z: 0 }, FWD, 100)!.target).toBeNull();
    combat.unregister(t);
    combat.unregister(hidden);
    expect(combat.targets.length).toBe(0);
  });

  it('queryRadius returns live targets whose bounds overlap', () => {
    const { combat } = makeWorld();
    const a = new FakeTarget({ x: 0, y: 0, z: 0 });
    const b = new FakeTarget({ x: 6, y: 0, z: 0 });
    combat.register(a);
    combat.register(b);
    const out = [b, b, b];
    expect(combat.queryRadius({ x: 1, y: 1, z: 0 }, 1, out)).toEqual([a]);
    expect(combat.queryRadius({ x: 3, y: 1, z: 0 }, 2, out)).toHaveLength(2);
    a.health = 0;
    expect(combat.queryRadius({ x: 3, y: 1, z: 0 }, 2, out)).toEqual([b]);
  });

  it('dealDamage applies damage and emits combat:damage / combat:kill', () => {
    const { combat, events } = makeWorld();
    const t = new FakeTarget({ x: 0, y: 0, z: -3 }, 50);
    combat.register(t);
    const damage: GameEvents['combat:damage'][] = [];
    const kills: GameEvents['combat:kill'][] = [];
    events.on('combat:damage', (e) => damage.push({ ...e, point: { ...e.point } }));
    events.on('combat:kill', (e) => kills.push({ ...e, position: { ...e.position } }));
    const info: DamageInfo = {
      amount: 30,
      zone: 'head',
      point: { x: 0, y: 1.6, z: -3 },
      direction: FWD,
      weaponId: 'pistol',
      element: 'physical',
      source: 'player',
      kind: 'bullet',
    };
    expect(combat.dealDamage(t, info)).toEqual({ applied: 30, killed: false });
    expect(combat.dealDamage(t, info)).toEqual({ applied: 20, killed: true });
    expect(combat.dealDamage(t, info)).toEqual({ applied: 0, killed: false });
    expect(damage).toHaveLength(2);
    expect(damage[0]).toMatchObject({ targetId: t.id, amount: 30, zone: 'head', killed: false });
    expect(damage[0]!.point).toEqual({ x: 0, y: 1.6, z: -3 });
    expect(damage[1]!.killed).toBe(true);
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({ targetId: t.id, zone: 'head', weaponId: 'pistol', source: 'player' });
    expect(t.received).toHaveLength(2);
  });
});

describe('CombatWorld dynamic props (Rapier)', () => {
  it('props stop bullets, can be skipped for penetration, and get pushed', async () => {
    const physics = await PhysicsWorld.create();
    const { combat } = makeWorld(physics);
    const body = physics.addDynamicBox({ x: -3, y: 0.5, z: -3 }, { x: 0.5, y: 0.5, z: 0.5 }, null, {
      data: { kind: 'prop', surface: 'metal', penetrable: true },
    });
    const hit = combat.raycast({ x: -3, y: 0.5, z: 0 }, FWD, 100);
    expect(hit).not.toBeNull();
    expect(hit!.target).toBeNull();
    expect(hit!.surface).toBe('metal');
    expect(hit!.penetrable).toBe(true);
    expect(hit!.distance).toBeCloseTo(2.5, 4);
    // A moving prop gets no world-space decal.
    expect(combat.hitsDynamicProp(hit!)).toBe(true);
    expect(combat.pushProp(hit!, FWD, 50)).toBe(true);
    physics.step(1 / 60);
    expect(body.linvel().z).toBeLessThan(-0.05);
    // A stale hit object (after another raycast) cannot push anything.
    const again = combat.raycast({ x: -3, y: 0.5, z: 0 }, FWD, 100)!;
    // Continue from inside the prop, skipping it: the wall behind.
    const through = combat.raycast({ x: -3, y: 0.5, z: -2.45 }, FWD, 100, { skipLastProp: true });
    expect(through!.surface).toBe('concrete');
    expect(combat.hitsDynamicProp(through!)).toBe(false);
    expect(combat.pushProp(again, FWD, 50)).toBe(false);
    // A ray starting inside the prop hits it at once with a usable normal (facing the shooter).
    const inside = combat.raycast({ x: -3, y: 0.5, z: -2.8 }, FWD, 100)!;
    expect(inside.distance).toBe(0);
    expect(inside.normal.z).toBeCloseTo(1, 6);
    // Props can be excluded entirely.
    expect(combat.raycast({ x: -3, y: 0.5, z: 0 }, FWD, 100, { props: false })!.surface).toBe('concrete');
    physics.dispose();
  });
});
