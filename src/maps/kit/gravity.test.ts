import { describe, expect, it } from 'vitest';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { GRAVITY } from '../../defs/mapEvents';
import { MOVEMENT } from '../../defs/movement';
import { PhysicsWorld } from '../../physics/PhysicsWorld';
import { PlayerController } from '../../player/PlayerController';
import { FakeInput, fakeSettings } from '../../player/testHelpers';
import { GravityZones, boxDepth, featherWeight, sphereDepth } from './GravityZones';

const DT = 1 / 60;

describe('gravity zone math', () => {
  it('feathers from the border inwards (smoothstep) and measures depth inside boxes / spheres', () => {
    expect(featherWeight(0, 1)).toBe(0);
    expect(featherWeight(-1, 1)).toBe(0);
    expect(featherWeight(0.5, 1)).toBeCloseTo(0.5, 6);
    expect(featherWeight(2, 1)).toBe(1);
    expect(featherWeight(0.01, 0)).toBe(1);
    expect(boxDepth(0, 1, 0, -2, 0, -2, 2, 4, 2)).toBeCloseTo(1, 6);
    expect(boxDepth(3, 1, 0, -2, 0, -2, 2, 4, 2)).toBeLessThan(0);
    expect(sphereDepth(0, 0, 0, 0, 0, 0, 5)).toBe(5);
    expect(sphereDepth(6, 0, 0, 0, 0, 0, 5)).toBe(-1);
  });
});

describe('GravityZones', () => {
  it('is 1 everywhere without zones', () => {
    const g = new GravityZones();
    expect(g.scaleAt(0, 0, 0)).toBe(1);
    expect(g.size).toBe(0);
  });

  it('samples boxes and spheres with a feathered border and multiplies overlaps (clamped)', () => {
    const g = new GravityZones([
      { id: 'deck', shape: 'box', min: [-10, 0, -10], max: [10, 20, 10], scale: 0.3, feather: 1 },
      { id: 'core', shape: 'sphere', center: [0, 5, 0], radius: 4, scale: 0.5, feather: 0 },
    ]);
    expect(g.scaleAt(0, 12, 8.5)).toBeCloseTo(0.3, 6);
    expect(g.scaleAt(0, 5, 0)).toBeCloseTo(0.15, 6);
    expect(g.scaleAt(30, 5, 0)).toBe(1);
    // Half-way through the feather: between 1 and 0.3.
    const edge = g.scaleAt(9.5, 12, 0);
    expect(edge).toBeGreaterThan(0.3);
    expect(edge).toBeLessThan(1);
    const heavy = new GravityZones([
      { id: 'a', shape: 'sphere', center: [0, 0, 0], radius: 5, scale: 0.01, feather: 0 },
    ]);
    expect(heavy.scaleAt(0, 0, 0)).toBe(GRAVITY.minScale);
  });

  it('adds, fades and removes temporary zones without touching the permanent ones', () => {
    const g = new GravityZones([
      { id: 'p', shape: 'box', min: [0, 0, 0], max: [1, 1, 1], scale: 0.5, feather: 0 },
    ]);
    const h = g.add(
      { id: 'anomaly', shape: 'sphere', center: [20, 0, 0], radius: 5, scale: 0.2, feather: 0 },
      0,
    );
    expect(h).toBeGreaterThan(0);
    expect(g.scaleAt(20, 0, 0)).toBe(1);
    g.setStrength(h, 0.5);
    expect(g.scaleAt(20, 0, 0)).toBeCloseTo(0.6, 6);
    g.setStrength(h, 1);
    expect(g.scaleAt(20, 0, 0)).toBeCloseTo(0.2, 6);
    expect(g.list().map((z) => [z.id, z.temporary])).toEqual([
      ['p', false],
      ['anomaly', true],
    ]);
    expect(g.remove(h)).toBe(true);
    expect(g.remove(h)).toBe(false);
    expect(g.scaleAt(20, 0, 0)).toBe(1);
    expect(g.scaleAt(0.5, 0.5, 0.5)).toBe(0.5);
    g.add({ id: 'x', shape: 'sphere', center: [0, 0, 0], radius: 1, scale: 0.5 });
    g.clearTemporary();
    expect(g.size).toBe(1);
  });

  it('grows past its planned capacity and rejects invalid zones', () => {
    const g = new GravityZones([], 1);
    const handles: number[] = [];
    for (let i = 0; i < 5; i++) {
      handles.push(
        g.add({ id: `z${i}`, shape: 'sphere', center: [i * 10, 0, 0], radius: 2, scale: 0.5, feather: 0 }),
      );
    }
    expect(g.size).toBe(5);
    expect(g.scaleAt(40, 0, 0)).toBe(0.5);
    expect(g.add({ id: 'bad', shape: 'sphere', center: [0, 0, 0], radius: 0, scale: 0.5 })).toBe(0);
    expect(g.add({ id: 'nan', shape: 'box', min: [0, 0, 0], max: [1, 1, 1], scale: Number.NaN })).toBe(0);
    g.remove(handles[1]!);
    expect(g.scaleAt(10, 0, 0)).toBe(1);
    expect(g.scaleAt(40, 0, 0)).toBe(0.5);
  });
});

describe('PlayerController in a low-gravity zone', () => {
  async function jumpHeight(scale: number | null): Promise<{ height: number; airTime: number }> {
    const physics = await PhysicsWorld.create();
    physics.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 40, y: 0.5, z: 40 }, undefined, {
      kind: 'world',
      surface: 'concrete',
    });
    const input = new FakeInput();
    const events = new EventBus<GameEvents>();
    const player = new PlayerController(
      { physics, input, events, settings: fakeSettings() },
      { position: { x: 0, y: 0, z: 0 }, yaw: 0 },
    );
    if (scale !== null) {
      player.setGravityField(
        new GravityZones([
          { id: 'lowg', shape: 'box', min: [-20, -1, -20], max: [20, 30, 20], scale, feather: 0 },
        ]),
      );
    }
    const frame = (): void => {
      player.fixedUpdate(DT);
      physics.step(DT);
      player.update(DT, 1);
      input.endFrame();
    };
    for (let i = 0; i < 20; i++) frame();
    const y0 = player.position.y;
    input.press('jump');
    let maxY = y0;
    let airTime = 0;
    let landed = false;
    for (let i = 0; i < 600 && !landed; i++) {
      frame();
      maxY = Math.max(maxY, player.position.y);
      if (i > 5 && player.grounded) landed = true;
      else airTime += DT;
    }
    physics.dispose();
    return { height: maxY - y0, airTime };
  }

  it('jumps much higher and stays in the air longer; enemies / normal zones are untouched', async () => {
    const normal = await jumpHeight(null);
    const low = await jumpHeight(0.3);
    expect(normal.height).toBeGreaterThan(MOVEMENT.jump.height * 0.9);
    expect(low.height).toBeGreaterThan(normal.height * 2.5);
    expect(low.airTime).toBeGreaterThan(normal.airTime * 2);
    const one = await jumpHeight(1);
    expect(one.height).toBeCloseTo(normal.height, 2);
  });
});

describe('ProjectileSystem in a low-gravity zone', () => {
  it('arsenal projectiles and grenades fall slower inside a zone (sampled per tick)', async () => {
    const { ProjectileSystem } = await import('../../weapons/fire/ProjectileSystem');
    const { Vector3 } = await import('three');
    const def = {
      speed: 10,
      gravity: 10,
      radius: 0.05,
      lifetime: 10,
      bounces: 0,
      restitution: 0,
      fuse: 0,
      pierce: 0,
      homing: 0,
      explosion: null,
      field: null,
      visual: 'projectile.grenade',
      trail: null,
      flightAudio: null,
    };
    const drop = (field: GravityZones | null): number => {
      const sys = new ProjectileSystem({
        events: new EventBus<GameEvents>(),
        combat: {
          raycast: () => null,
          dealDamage: () => ({ applied: 0, killed: false }),
          lineOfSight: () => true,
          targets: [],
        },
        explosions: { explode: () => 0 },
        fields: {
          spawn: () => 0,
          pullAt: () => false,
          slowAt: () => 1,
          active: 0,
          fixedUpdate() {},
          update() {},
          clear() {},
        },
      });
      sys.setGravityField(field);
      const id = sys.spawn({
        origin: { x: 0, y: 50, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
        def,
        damage: {
          weaponId: 't',
          source: 'player',
          damage: 0,
          element: 'physical',
          headMultiplier: 1,
          weakpointMultiplier: 1,
          statusBuildup: 0,
        },
      });
      for (let i = 0; i < 60; i++) sys.fixedUpdate(DT);
      sys.update(DT, 1);
      const out = new Vector3();
      expect(sys.positionOf(id, out)).toBe(true);
      return 50 - out.y;
    };
    const normal = drop(null);
    const low = drop(
      new GravityZones([
        { id: 'z', shape: 'box', min: [-100, 0, -100], max: [100, 100, 100], scale: 0.25, feather: 0 },
      ]),
    );
    expect(normal).toBeCloseTo(5, 0);
    expect(low).toBeCloseTo(normal * 0.25, 1);
  });
});
