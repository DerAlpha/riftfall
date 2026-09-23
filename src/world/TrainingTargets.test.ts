import { afterEach, describe, expect, it } from 'vitest';
import { Group, Mesh, Vector3, type Material } from 'three';
import type { CombatWorldApi, DamageInfo, Damageable, Hitbox } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, HitZone } from '../core/events';
import { CombatWorld } from '../combat/CombatWorld';
import { TEST_ROOM_LAYOUT } from '../defs/level';
import { TARGETS, TARGET_TYPES, type TargetPlacementDef } from '../defs/targets';
import { COLLISION_GROUP } from '../defs/physics';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { rectContainsPoint } from './kitMath';
import { testRoomSolidFootprints } from './TestRoom';
import {
  ShieldState,
  TARGET_ID_BASE,
  TrainingTargets,
  advanceRail,
  railFraction,
  shieldCapsules,
  wobbleKick,
  type RailState,
} from './TrainingTargets';

const DT = 1 / 60;

class FakeCombat implements CombatWorldApi {
  readonly list: Damageable[] = [];
  get targets(): readonly Damageable[] {
    return this.list;
  }
  register(t: Damageable): void {
    this.list.push(t);
  }
  unregister(t: Damageable): void {
    const i = this.list.indexOf(t);
    if (i >= 0) this.list.splice(i, 1);
  }
  raycast(): null {
    return null;
  }
  queryRadius(_c: unknown, _r: number, out: Damageable[]): Damageable[] {
    return out;
  }
  dealDamage(t: Damageable, info: DamageInfo): { applied: number; killed: boolean } {
    return t.applyDamage(info);
  }
  lineOfSight(): boolean {
    return true;
  }
}

function hit(amount: number, zone: HitZone, direction = { x: 0, y: 0, z: -1 }): DamageInfo {
  return {
    amount,
    zone,
    point: { x: 0, y: 1, z: 0 },
    direction,
    weaponId: 'pistol',
    element: 'physical',
    source: 'player',
    kind: 'bullet',
    impulse: 1,
  };
}

function box(d: Damageable, zone: HitZone): Hitbox {
  const b = d.hitboxes.find((h) => h.zone === zone);
  if (!b) throw new Error(`no ${zone} hitbox`);
  return b;
}

const created: TrainingTargets[] = [];

function make(placements: readonly TargetPlacementDef[], physics: PhysicsWorld | null = null) {
  const scene = new Group();
  const combat = new FakeCombat();
  const events = new EventBus<GameEvents>();
  const setup: Material[] = [];
  const targets = new TrainingTargets({
    scene,
    combat,
    events,
    physics,
    render: { setupMaterial: (m) => void setup.push(m) },
    placements,
  });
  created.push(targets);
  return { scene, combat, events, targets, setup };
}

afterEach(() => {
  for (const t of created) t.dispose();
  created.length = 0;
});

// ---------------------------------------------------------------------------

describe('rail motion', () => {
  it('ping-pongs at the average speed and pauses at both ends', () => {
    const s: RailState = { s: 0, dir: 1, pause: 0 };
    // 10 m at 2 m/s = 5 s per pass.
    for (let i = 0; i < 305; i++) advanceRail(s, DT, 10, 2, 0.5);
    expect(s.s).toBe(1);
    expect(s.dir).toBe(-1);
    expect(s.pause).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) advanceRail(s, DT, 10, 2, 0.5);
    expect(s.s).toBe(1); // still pausing
    for (let i = 0; i < 60; i++) advanceRail(s, DT, 10, 2, 0.5);
    expect(s.s).toBeLessThan(1);
    expect(s.s).toBeGreaterThan(0.8);
  });

  it('eases in and out (smoothstep) and ignores bad input', () => {
    expect(railFraction({ s: 0, dir: 1, pause: 0 })).toBe(0);
    expect(railFraction({ s: 0.5, dir: 1, pause: 0 })).toBeCloseTo(0.5, 6);
    expect(railFraction({ s: 0.1, dir: 1, pause: 0 })).toBeLessThan(0.1);
    const s: RailState = { s: 0.3, dir: 1, pause: 0 };
    advanceRail(s, Number.NaN, 10, 2, 0);
    advanceRail(s, DT, 0, 2, 0);
    expect(s.s).toBe(0.3);
  });
});

describe('shield', () => {
  const def = { health: 100, regenDelay: 2, regenPerSecond: 50 };

  it('absorbs damage up to its strength, breaks, and comes back at full after the delay', () => {
    const sh = new ShieldState(def);
    expect(sh.absorb(60)).toBe(60);
    expect(sh.up).toBe(true);
    expect(sh.absorb(60)).toBe(40);
    expect(sh.up).toBe(false);
    expect(sh.absorb(10)).toBe(0);
    for (let i = 0; i < 60; i++) sh.tick(DT);
    expect(sh.up).toBe(false);
    let raised = false;
    for (let i = 0; i < 70; i++) raised = sh.tick(DT) || raised;
    expect(raised).toBe(true);
    expect(sh.up).toBe(true);
    expect(sh.hp).toBe(100);
  });

  it('regenerates a damaged barrier gradually', () => {
    const sh = new ShieldState(def);
    sh.absorb(80);
    for (let i = 0; i < 120; i++) sh.tick(DT); // exactly the delay
    const before = sh.hp;
    sh.tick(0.5);
    expect(sh.hp).toBeCloseTo(before + 25, 5);
  });

  it('lays its capsules along the arc in front of the dummy', () => {
    const d = TARGET_TYPES.armored.shield;
    const caps = shieldCapsules(d);
    expect(caps.length).toBe(d.capsules);
    for (const c of caps) {
      expect(Math.hypot(c.x, c.z)).toBeCloseTo(d.arcRadius, 5);
      expect(c.z).toBeGreaterThan(0);
    }
    // Neighbouring capsules overlap: no gaps a bullet could slip through.
    const gap = Math.hypot(caps[1]!.x - caps[0]!.x, caps[1]!.z - caps[0]!.z);
    expect(gap).toBeLessThan(d.capsuleRadius * 2);
  });
});

describe('wobble', () => {
  it('kicks harder for bigger hits and caps the kick', () => {
    expect(wobbleKick(10, 0)).toBeLessThan(wobbleKick(40, 0));
    expect(wobbleKick(1e6, 1e6)).toBe(TARGETS.wobble.maxKick);
    expect(wobbleKick(-5, Number.NaN)).toBe(0);
  });
});

describe('TrainingTargets', () => {
  it('builds every placement of the test room and registers them with the combat world', () => {
    const { targets, combat, scene, setup } = make(TEST_ROOM_LAYOUT.targets);
    expect(targets.dummies.length).toBe(TEST_ROOM_LAYOUT.targets.length);
    // Every dummy plus the barrier of every armored one.
    const shields = TEST_ROOM_LAYOUT.targets.filter((t) => TARGET_TYPES[t.type].shield !== null).length;
    expect(shields).toBeGreaterThan(0);
    expect(combat.list.length).toBe(TEST_ROOM_LAYOUT.targets.length + shields);
    expect(scene.children).toContain(targets.root);
    // Body + glow materials go through the shadow setup.
    expect(setup.length).toBe(targets.dummies.length * 2);
    // Ids are unique and far away from enemy ids.
    const ids = new Set(combat.list.map((d) => d.id));
    expect(ids.size).toBe(combat.list.length);
    for (const id of ids) expect(id).toBeGreaterThanOrEqual(TARGET_ID_BASE);
    // Shared geometry per type: few geometries, many meshes.
    const geos = new Set<unknown>();
    targets.root.traverse((o) => {
      if (o instanceof Mesh) geos.add(o.geometry);
    });
    expect(geos.size).toBeLessThanOrEqual(5);
  });

  it('places hitboxes per zone in world space, following position and yaw', () => {
    const { targets } = make([
      { type: 'dummy', position: [2, 0, -3], yawDeg: 0 },
      { type: 'dummy', position: [0, 0, 0], yawDeg: 180 },
    ]);
    const [a, b] = targets.dummies;
    const head = box(a!, 'head');
    expect(head.a.x).toBeCloseTo(2, 5);
    expect(head.a.y).toBeCloseTo(TARGETS.body.head.center[1], 5);
    expect(head.a.z).toBeCloseTo(-3, 5);
    // The weakpoint core sits in front (+Z at yaw 0) …
    expect(box(a!, 'weakpoint').a.z).toBeGreaterThan(-3);
    // … and behind the axis once turned around.
    expect(box(b!, 'weakpoint').a.z).toBeLessThan(0);
    const zones = new Set(a!.hitboxes.map((h) => h.zone));
    expect([...zones].sort()).toEqual(['body', 'head', 'limb', 'weakpoint']);
    // Bounds enclose every hitbox.
    for (const h of a!.hitboxes) {
      expect(h.a.distanceTo(a!.boundsCenter) + h.radius).toBeLessThanOrEqual(a!.boundsRadius);
      if (h.shape === 'capsule')
        expect(h.b.distanceTo(a!.boundsCenter) + h.radius).toBeLessThanOrEqual(a!.boundsRadius);
    }
  });

  it('moves rail dummies and their hitboxes every tick, interpolating the visuals', () => {
    const { targets } = make([
      { type: 'dummy', position: [-4, 0, 0], yawDeg: 0, rail: { to: [4, 0, 0], speed: 2, pause: 0 } },
    ]);
    const d = targets.dummies[0]!;
    const x0 = box(d, 'body').a.x;
    for (let i = 0; i < 60; i++) targets.fixedUpdate(DT);
    const x1 = box(d, 'body').a.x;
    expect(x1).toBeGreaterThan(x0 + 0.5);
    expect(d.position.y).toBeCloseTo(TARGETS.rail.height, 6);
    targets.fixedUpdate(DT);
    targets.update(DT, 0);
    const behind = d.root.position.x;
    targets.update(0, 1);
    expect(d.root.position.x).toBeGreaterThan(behind);
    expect(d.root.position.x).toBeCloseTo(d.position.x, 6);
  });

  it('wobbles away from the shot and settles again', () => {
    const { targets } = make([{ type: 'dummy', position: [0, 0, 0], yawDeg: 0 }]);
    const d = targets.dummies[0]!;
    const headZ0 = box(d, 'head').a.z;
    // Shot travelling -Z (from the front): the head tips backwards (-Z).
    d.applyDamage(hit(40, 'body', { x: 0, y: 0, z: -1 }));
    for (let i = 0; i < 6; i++) targets.fixedUpdate(DT);
    expect(box(d, 'head').a.z).toBeLessThan(headZ0 - 0.02);
    for (let i = 0; i < 600; i++) targets.fixedUpdate(DT);
    expect(box(d, 'head').a.z).toBeCloseTo(headZ0, 3);
  });

  it('dies, dissolves, respawns (materializes) and heals', () => {
    const { targets } = make([{ type: 'dummy', position: [0, 0, 0], yawDeg: 0 }]);
    const d = targets.dummies[0]!;
    const hp = TARGET_TYPES.dummy.health;
    const r1 = d.applyDamage(hit(hp - 10, 'body'));
    expect(r1).toEqual({ applied: hp - 10, killed: false });
    const r2 = d.applyDamage(hit(50, 'head'));
    expect(r2.killed).toBe(true);
    expect(r2.applied).toBeCloseTo(10, 6);
    expect(d.alive).toBe(false);
    expect(d.applyDamage(hit(50, 'head'))).toEqual({ applied: 0, killed: false });
    targets.fixedUpdate(DT);
    targets.update(DT, 1);
    expect(d.dissolve.uDissolve.value).toBeGreaterThan(0);
    expect(targets.stats.alive).toBe(0);
    const D = TARGETS.dissolve;
    const ticks = Math.ceil((D.outTime + TARGETS.respawnDelay) / DT) + 2;
    for (let i = 0; i < ticks; i++) targets.fixedUpdate(DT);
    targets.update(DT, 1);
    expect(d.state).toBe('spawning');
    expect(d.dissolve.uDissolve.value).toBeGreaterThan(0.5);
    for (let i = 0; i < Math.ceil(D.inTime / DT) + 1; i++) targets.fixedUpdate(DT);
    targets.update(DT, 1);
    expect(d.alive).toBe(true);
    expect(d.health).toBe(hp);
    expect(d.dissolve.uDissolve.value).toBe(0);
    expect(d.root.visible).toBe(true);
  });

  it('regenerates health after a quiet period', () => {
    const { targets } = make([{ type: 'dummy', position: [0, 0, 0], yawDeg: 0 }]);
    const d = targets.dummies[0]!;
    d.applyDamage(hit(60, 'body'));
    expect(d.health).toBe(TARGET_TYPES.dummy.health - 60);
    for (let i = 0; i < Math.ceil(TARGET_TYPES.dummy.healthRegenDelay / DT) + 1; i++) targets.fixedUpdate(DT);
    expect(d.health).toBe(TARGET_TYPES.dummy.health);
  });

  it('armored dummies: the barrier target absorbs until it breaks, armor halves body hits', () => {
    const { targets } = make([{ type: 'armored', position: [0, 0, 0], yawDeg: 0 }]);
    const d = targets.dummies[0]!;
    const s = d.shieldTarget!;
    const T = TARGET_TYPES.armored;
    // The barrier is its own damageable: shield surface and zone, neutral (aim assist ignores it).
    expect(s).not.toBeNull();
    expect(s.surface).toBe('shield');
    expect(s.team).toBe('neutral');
    expect(s.alive).toBe(true);
    expect(s.hitboxes.length).toBe(T.shield.capsules);
    expect(s.hitboxes.every((h) => h.zone === 'shield')).toBe(true);
    expect(s.boundsCenter).toBe(d.boundsCenter);
    expect(s.aimPoint).toBe(d.aimPoint);
    // The body keeps its armor surface and body zones whatever the barrier does.
    expect(d.surface).toBe(T.surface);
    expect(d.hitboxes.some((h) => h.zone === 'shield')).toBe(false);
    const r = s.applyDamage(hit(100, 'shield'));
    expect(r).toEqual({ applied: 100, killed: false });
    expect(d.health).toBe(T.health);
    // Direct 'shield' zone damage on the dummy routes into the barrier too.
    expect(d.applyDamage(hit(20, 'shield'))).toEqual({ applied: 20, killed: false });
    const over = s.applyDamage(hit(500, 'shield'));
    expect(over.applied).toBe(T.shield.health - 120);
    expect(d.health).toBe(T.health);
    // Broken: the barrier target is gone until it regenerates.
    expect(s.alive).toBe(false);
    expect(s.applyDamage(hit(10, 'shield'))).toEqual({ applied: 0, killed: false });
    expect(d.applyDamage(hit(40, 'body')).applied).toBe(20);
    expect(d.applyDamage(hit(40, 'weakpoint')).applied).toBe(40);
    // The barrier returns after the regen delay.
    for (let i = 0; i < Math.ceil(T.shield.regenDelay / DT) + 2; i++) targets.fixedUpdate(DT);
    expect(s.alive).toBe(true);
    // A dead dummy has no barrier.
    d.applyDamage(hit(10_000, 'head'));
    expect(s.alive).toBe(false);
  });

  it('the shield covers the front: a frontal ray hits a shield capsule before the body', () => {
    const events = new EventBus<GameEvents>();
    const world = new CombatWorld({ events });
    const scene = new Group();
    const targets = new TrainingTargets({
      scene,
      combat: world,
      events,
      physics: null,
      render: { setupMaterial: () => undefined },
      placements: [{ type: 'armored', position: [0, 0, -6], yawDeg: 0 }],
    });
    created.push(targets);
    targets.fixedUpdate(DT);
    const d = targets.dummies[0]!;
    const eye = new Vector3(0, 1.3, 0);
    const front = world.raycast(eye, { x: 0, y: 0, z: -1 }, 50);
    expect(front?.zone).toBe('shield');
    expect(front?.surface).toBe('shield');
    expect(front?.target).toBe(d.shieldTarget);
    // From behind the body is exposed – and reports its armor, not the barrier.
    const back = world.raycast({ x: 0, y: 1.2, z: -12 }, { x: 0, y: 0, z: 1 }, 50);
    expect(back?.zone).toBe('body');
    expect(back?.surface).toBe(TARGET_TYPES.armored.surface);
    expect(back?.target).toBe(d);
    // A pellet under the barrier's lower edge hits the leg: a different damageable than the
    // barrier, so weapons aggregate the two separately (the barrier cannot be bypassed by one pellet).
    const leg = world.raycast({ x: TARGETS.body.leg.x, y: 0.18, z: 0 }, { x: 0, y: 0, z: -1 }, 50);
    expect(leg?.zone).toBe('limb');
    expect(leg?.target).toBe(d);
    // Broken barrier: the frontal ray reaches the body.
    world.dealDamage(d.shieldTarget!, hit(10_000, 'shield'));
    const open = world.raycast(eye, { x: 0, y: 0, z: -1 }, 50);
    expect(open?.target).toBe(d);
    expect(open?.surface).toBe(TARGET_TYPES.armored.surface);
  });

  it('resolves real combat raycasts to head / weakpoint / limb zones and emits kills', () => {
    const events = new EventBus<GameEvents>();
    const world = new CombatWorld({ events });
    const kills: GameEvents['combat:kill'][] = [];
    events.on('combat:kill', (e) => kills.push({ ...e }));
    const targets = new TrainingTargets({
      scene: new Group(),
      combat: world,
      events,
      physics: null,
      render: { setupMaterial: () => undefined },
      placements: [{ type: 'dummy', position: [0, 0, -8], yawDeg: 0 }],
    });
    created.push(targets);
    targets.fixedUpdate(DT);
    const B = TARGETS.body;
    const at = (y: number, x = 0) => world.raycast({ x, y, z: 0 }, { x: 0, y: 0, z: -1 }, 50);
    expect(at(B.head.center[1])?.zone).toBe('head');
    expect(at(B.core.center[1])?.zone).toBe('weakpoint');
    expect(at(1.1, 0.12)?.zone).toBe('body');
    expect(at(0.5, B.leg.x)?.zone).toBe('limb');
    expect(at(2.2)).toBeNull();
    const d = targets.dummies[0]!;
    world.dealDamage(d, hit(1000, 'head'));
    expect(kills.length).toBe(1);
    expect(kills[0]!.targetId).toBe(d.id);
    // Dead dummies are not hit.
    expect(at(B.head.center[1])).toBeNull();
  });

  it('blocks the player with a kinematic capsule that is disabled while dead', async () => {
    const physics = await PhysicsWorld.create();
    try {
      const { targets } = make([{ type: 'dummy', position: [0, 0, 0], yawDeg: 0 }], physics);
      const d = targets.dummies[0]!;
      expect(d.collider).not.toBeNull();
      expect(physics.getColliderData(d.collider!)?.kind).toBe('enemy');
      physics.step(DT);
      const probe = (): boolean => {
        const hitRay = physics.raycast({ x: 0, y: 1, z: 3 }, { x: 0, y: 0, z: -1 }, 10, {
          groups: (COLLISION_GROUP.PLAYER << 16) | COLLISION_GROUP.ENEMY,
        });
        return hitRay !== null;
      };
      expect(probe()).toBe(true);
      d.applyDamage(hit(10_000, 'body'));
      physics.step(DT);
      expect(probe()).toBe(false);
      targets.dispose();
      expect(physics.stats.bodies).toBe(0);
    } finally {
      physics.dispose();
    }
  });

  it('keeps respawning dummies away while the player stands inside them', async () => {
    const physics = await PhysicsWorld.create();
    try {
      const { targets } = make([{ type: 'dummy', position: [0, 0, 0], yawDeg: 0 }], physics);
      const d = targets.dummies[0]!;
      // A player capsule standing on the dummy's spot.
      const R = physics.rapier;
      const body = physics.world.createRigidBody(
        R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 0.9, 0),
      );
      physics.createCollider(R.ColliderDesc.capsule(0.5, 0.35), body, { kind: 'player', surface: 'default' });
      d.applyDamage(hit(10_000, 'body'));
      const ticks = Math.ceil((TARGETS.dissolve.outTime + TARGETS.respawnDelay) / DT) + 5;
      for (let i = 0; i < ticks; i++) {
        targets.fixedUpdate(DT);
        physics.step(DT);
      }
      expect(d.state).toBe('dead');
      physics.removeBody(body);
      physics.step(DT);
      targets.fixedUpdate(DT);
      expect(d.state).toBe('spawning');
    } finally {
      physics.dispose();
    }
  });

  it('keeps every test-room target (and its rail path) inside the hall and out of solids', () => {
    const H = TEST_ROOM_LAYOUT.hall;
    const solids = testRoomSolidFootprints();
    const r = TARGETS.collider.radius;
    const pit = TEST_ROOM_LAYOUT.pit.rect;
    for (const t of TEST_ROOM_LAYOUT.targets) {
      const ends = [t.position, t.rail?.to ?? t.position];
      for (let k = 0; k <= 10; k++) {
        const f = k / 10;
        const x = ends[0]![0] + (ends[1]![0] - ends[0]![0]) * f;
        const z = ends[0]![2] + (ends[1]![2] - ends[0]![2]) * f;
        expect(x - r).toBeGreaterThan(H.minX);
        expect(x + r).toBeLessThan(H.maxX);
        expect(z - r).toBeGreaterThan(H.minZ);
        expect(z + r).toBeLessThan(H.maxZ);
        for (const s of [...solids, pit]) {
          const grown = { minX: s.minX - r, maxX: s.maxX + r, minZ: s.minZ - r, maxZ: s.maxZ + r };
          expect(rectContainsPoint(grown, x, z), `${t.type} at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBe(false);
        }
      }
    }
  });

  it('skips unknown target types and cleans up on dispose', () => {
    const { targets, combat, scene } = make([
      { type: 'nope' as 'dummy', position: [0, 0, 0], yawDeg: 0 },
      { type: 'dummy', position: [1, 0, 0], yawDeg: 0 },
      { type: 'armored', position: [-1, 0, 0], yawDeg: 0 },
    ]);
    expect(targets.dummies.length).toBe(2);
    expect(combat.list.length).toBe(3);
    targets.dispose();
    expect(combat.list.length).toBe(0);
    expect(scene.children.length).toBe(0);
    // Safe to call twice and to tick afterwards.
    targets.dispose();
    targets.fixedUpdate(DT);
    targets.update(DT, 1);
  });
});
