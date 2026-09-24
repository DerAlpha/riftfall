import { beforeAll, describe, expect, it } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld, groupsForKind, validateTrimesh } from './PhysicsWorld';
import { COLLISION_GROUP, PHYSICS, interactionGroups } from '../defs/physics';

const DT = 1 / 60;

describe('PhysicsWorld', () => {
  let physics: PhysicsWorld;

  beforeAll(async () => {
    physics = await PhysicsWorld.create();
  });

  it('raycasts against static boxes before the first step and returns collider data', async () => {
    const p = await PhysicsWorld.create();
    p.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 10, y: 0.5, z: 10 }, undefined, {
      kind: 'world',
      surface: 'concrete',
    });
    const hit = p.raycast({ x: 1, y: 5, z: 2 }, { x: 0, y: -3, z: 0 }, 100);
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(5, 4);
    expect(hit!.point.y).toBeCloseTo(0, 4);
    expect(hit!.point.x).toBeCloseTo(1, 4);
    expect(hit!.normal.y).toBeCloseTo(1, 4);
    expect(hit!.data?.surface).toBe('concrete');
    expect(p.raycast({ x: 1, y: 5, z: 2 }, { x: 0, y: 1, z: 0 }, 100)).toBeNull();
    expect(p.raycast({ x: 1, y: 5, z: 2 }, { x: 0, y: -1, z: 0 }, 4)).toBeNull();
    p.dispose();
  });

  it('honours group filters and exclusions', async () => {
    const p = await PhysicsWorld.create();
    const floor = p.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 10, y: 0.5, z: 10 });
    const prop = p.addStaticBox({ x: 0, y: 1, z: 0 }, { x: 0.5, y: 0.5, z: 0.5 }, undefined, {
      kind: 'prop',
      surface: 'metal',
    });
    const origin = { x: 0, y: 5, z: 0 };
    const down = { x: 0, y: -1, z: 0 };
    expect(p.raycast(origin, down, 100)!.collider.handle).toBe(prop.handle);
    const worldOnly = interactionGroups(COLLISION_GROUP.PLAYER, COLLISION_GROUP.WORLD);
    expect(p.raycast(origin, down, 100, { groups: worldOnly })!.collider.handle).toBe(floor.handle);
    expect(p.raycast(origin, down, 100, { excludeCollider: prop })!.collider.handle).toBe(floor.handle);
    p.dispose();
  });

  it('ignores trigger sensors in queries but detects the kinematic player inside them', async () => {
    const p = await PhysicsWorld.create();
    p.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 10, y: 0.5, z: 10 });
    const trigger = p.addStaticBox({ x: 0, y: 2, z: 0 }, { x: 1, y: 1, z: 1 }, undefined, {
      kind: 'trigger',
      surface: 'default',
    });
    expect(p.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 100)!.distance).toBeCloseTo(5, 4);
    const body = p.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 2, 0),
    );
    const player = p.createCollider(
      RAPIER.ColliderDesc.ball(0.4).setCollisionGroups(groupsForKind('player')),
      body,
      { kind: 'player', surface: 'default' },
    );
    p.step(DT);
    expect(p.world.intersectionPair(trigger, player)).toBe(true);
    p.dispose();
  });

  it('simulates dynamic boxes and interpolates their visuals', () => {
    physics.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 20, y: 0.5, z: 20 });
    const obj = new Object3D();
    const body = physics.addDynamicBox({ x: 3, y: 4, z: 0 }, { x: 0.5, y: 0.5, z: 0.5 }, obj);
    expect(physics.stats.dynamicBodies).toBe(1);
    expect(obj.position.y).toBeCloseTo(4);
    physics.step(DT);
    physics.step(DT);
    const y1 = body.translation().y;
    physics.step(DT);
    const y2 = body.translation().y;
    expect(y2).toBeLessThan(y1);
    physics.syncVisuals(0.5);
    expect(obj.position.y).toBeCloseTo((y1 + y2) / 2, 5);
    physics.syncVisuals(1);
    expect(obj.position.y).toBeCloseTo(y2, 5);
    for (let i = 0; i < 240; i++) physics.step(DT);
    physics.syncVisuals(0.3);
    // Resting on the floor (half extent 0.5).
    expect(obj.position.y).toBeCloseTo(0.5, 1);
    expect(physics.stats.stepMs).toBeGreaterThanOrEqual(0);
    physics.removeBody(body);
    expect(physics.stats.dynamicBodies).toBe(0);
  });

  it('resets bodies that fall below the kill plane to their spawn transform', async () => {
    const p = await PhysicsWorld.create();
    const rot = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.5);
    const obj = new Object3D();
    const body = p.addDynamicBox({ x: 0, y: 2, z: 0 }, { x: 0.25, y: 0.25, z: 0.25 }, obj, { rotation: rot });
    // No floor: free fall. Teleport close to the kill plane to keep the test short.
    body.setTranslation({ x: 0, y: PHYSICS.killPlaneY + 0.01, z: 0 }, true);
    body.setLinvel({ x: 0, y: -10, z: 0 }, true);
    p.step(DT);
    expect(body.translation().y).toBeCloseTo(2, 4);
    expect(body.linvel().y).toBeCloseTo(0, 4);
    p.syncVisuals(0);
    expect(obj.position.y).toBeCloseTo(2, 4);
    expect(obj.quaternion.angleTo(rot)).toBeLessThan(1e-3);
    p.dispose();
  });

  it('resetDynamicBodies puts pushed props back at their spawn pose (new run), visuals too', async () => {
    const p = await PhysicsWorld.create();
    p.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 20, y: 0.5, z: 20 });
    const rot = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4);
    const obj = new Object3D();
    const body = p.addDynamicBox({ x: 2, y: 0.5, z: 1 }, { x: 0.5, y: 0.5, z: 0.5 }, obj, { rotation: rot });
    // A shot / blast shoves it across the floor; let it come to rest (the visual is then skipped).
    body.applyImpulse({ x: body.mass() * 6, y: body.mass() * 3, z: 0 }, true);
    for (let i = 0; i < 600 && !body.isSleeping(); i++) p.step(DT);
    for (let i = 0; i < 3; i++) p.syncVisuals(1);
    expect(body.translation().x).toBeGreaterThan(3);
    expect(obj.position.x).toBeCloseTo(body.translation().x, 4);

    // Behind the menus: no step runs, the frame still syncs the visuals.
    p.resetDynamicBodies();
    p.syncVisuals(0.5);
    expect(body.translation()).toMatchObject({ x: 2, y: 0.5, z: 1 });
    expect(body.linvel().x).toBeCloseTo(0, 6);
    expect(obj.position.x).toBeCloseTo(2, 5);
    expect(obj.position.y).toBeCloseTo(0.5, 5);
    expect(obj.quaternion.angleTo(rot)).toBeLessThan(1e-3);
    p.step(DT);
    p.syncVisuals(1);
    expect(obj.position.x).toBeCloseTo(2, 3);
    p.dispose();
  });

  it('flushes queries with zero-length steps without moving kinematic bodies', async () => {
    const p = await PhysicsWorld.create();
    const body = p.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0),
    );
    p.createCollider(RAPIER.ColliderDesc.ball(0.5), body, { kind: 'player', surface: 'default' });
    p.step(DT);
    body.setNextKinematicTranslation({ x: 1, y: 1, z: 0 });
    p.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 5, y: 0.5, z: 5 });
    p.ensureQueries();
    const t = body.translation();
    expect(Number.isFinite(t.x)).toBe(true);
    expect(p.raycast({ x: 3, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 100)!.distance).toBeCloseTo(5, 4);
    p.step(DT);
    expect(body.translation().x).toBeCloseTo(1, 4);
    p.dispose();
  });

  it('survives invalid shape input and NaN rays (placeholder collider + warning, no WASM panic)', async () => {
    const p = await PhysicsWorld.create();
    p.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 10, y: 0.5, z: 10 });
    expect(
      validateTrimesh(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), new Uint32Array([0, 1, 2])),
    ).toBeNull();
    // Out-of-range index would be an unrecoverable Rust panic, an empty mesh a thrown error.
    const bad = p.addStaticTrimesh(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), new Uint32Array([0, 1, 5]));
    const empty = p.addStaticTrimesh(new Float32Array(0), new Uint32Array(0));
    const nanBox = p.addStaticBox({ x: Number.NaN, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    expect(p.getColliderData(bad)?.kind).toBe('world');
    expect(p.world.colliders.contains(empty.handle)).toBe(true);
    expect(p.world.colliders.contains(nanBox.handle)).toBe(true);
    p.step(DT);
    // Inert placeholders never show up in queries.
    expect(p.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 100)!.distance).toBeCloseTo(5, 4);
    expect(p.raycast({ x: Number.NaN, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 100)).toBeNull();
    expect(p.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: Number.NaN, z: 0 }, 100)).toBeNull();
    p.removeCollider(bad);
    p.dispose();
  });

  it('shape queries detect overlaps and sweeps', async () => {
    const p = await PhysicsWorld.create();
    const floor = p.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 5, y: 0.5, z: 5 });
    const ball = new RAPIER.Ball(0.5);
    expect(p.intersectShape(ball, { x: 0, y: 0.4, z: 0 }, null)?.handle).toBe(floor.handle);
    expect(p.intersectShape(ball, { x: 0, y: 0.6, z: 0 }, null)).toBeNull();
    expect(p.castShape(ball, { x: 0, y: 3, z: 0 }, null, { x: 0, y: -1, z: 0 }, 10)).toBeCloseTo(2.5, 3);
    expect(p.castShape(ball, { x: 0, y: 3, z: 0 }, null, { x: 0, y: 1, z: 0 }, 10)).toBe(-1);
    p.removeCollider(floor);
    expect(p.getColliderData(floor)).toBeUndefined();
    expect(p.intersectShape(ball, { x: 0, y: 0.4, z: 0 }, null)).toBeNull();
    p.dispose();
    expect(p.raycast({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }, 10)).toBeNull();
  });
});
