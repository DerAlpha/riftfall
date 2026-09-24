import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type {
  AreaDamageSource,
  ArsenalVfxApi,
  DamageInfo,
  DamageResult,
  DamageSource,
  Damageable,
  ExplosionApi,
  FieldApi,
  Hitbox,
} from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents, Vec3Like } from '../../core/events';
import { CombatWorld } from '../../combat/CombatWorld';
import { FakeTarget, buildTestLevel } from '../../combat/testFakes';
import { ARSENAL } from '../../defs/combat';
import type { ExplosionDef, FieldDef, WeaponProjectileDef } from '../../defs/weapons';
import { ProjectileSystem } from './ProjectileSystem';
import type { SpecialHit } from './types';

const DT = 1 / 60;

const BLAST: ExplosionDef = {
  radius: 4.5,
  damage: 260,
  minFalloffMultiplier: 0.25,
  element: 'physical',
  impulse: 9,
  propImpulse: 420,
  selfDamageScale: 0.35,
  shake: 0.6,
  vfx: 'explosion.frag',
  audio: 'explosion.physical',
};
const FIELD: FieldDef = {
  kind: 'slow',
  radius: 6,
  duration: 5,
  dps: 20,
  element: 'ice',
  strength: 0.35,
  collapse: null,
  vfx: 'field.slow.ice',
  audio: 'field.slow.ice',
};
const GRENADE: WeaponProjectileDef = {
  speed: 38,
  gravity: 9.8,
  radius: 0.07,
  lifetime: 6,
  bounces: 2,
  restitution: 0.45,
  fuse: 0,
  pierce: 0,
  homing: 0,
  explosion: BLAST,
  field: null,
  visual: 'projectile.grenade',
  trail: 'trail.smoke',
  flightAudio: 'projectile.grenade.flight',
};
const BOLT: WeaponProjectileDef = {
  ...GRENADE,
  speed: 60,
  gravity: 0,
  bounces: 0,
  explosion: null,
  visual: 'projectile.plasma',
  trail: null,
  flightAudio: null,
};
const SOURCE: DamageSource = {
  weaponId: 'test',
  source: 'player',
  damage: 50,
  element: 'shock',
  headMultiplier: 2,
  weakpointMultiplier: 3,
  statusBuildup: 1,
};

/** A body of the player's own team (never hit by player projectiles). */
class FriendlyTarget implements Damageable {
  readonly id = 99;
  readonly alive = true;
  readonly team = 'player' as const;
  readonly surface = 'flesh' as const;
  readonly boundsCenter: Vector3;
  readonly boundsRadius = 1;
  readonly aimPoint: Vector3;
  readonly hitboxes: Hitbox[];
  hits = 0;
  constructor(at: Vec3Like) {
    this.boundsCenter = new Vector3(at.x, at.y, at.z);
    this.aimPoint = this.boundsCenter.clone();
    this.hitboxes = [{ shape: 'sphere', zone: 'body', a: this.boundsCenter.clone(), b: new Vector3(), radius: 0.5 }];
  }
  applyDamage(_info: DamageInfo): DamageResult {
    this.hits++;
    return { applied: 0, killed: false };
  }
}

function setup(opts: { floor?: boolean; wallZ?: number; capacity?: number } = {}) {
  const events = new EventBus<GameEvents>();
  const combat = new CombatWorld({ events, physics: null });
  const boxes: Parameters<typeof buildTestLevel>[0] = [];
  if (opts.floor !== false) boxes.push({ material: 'concrete_wall', center: { x: 0, y: -0.5, z: 0 }, size: { x: 200, y: 1, z: 200 } });
  if (opts.wallZ !== undefined) boxes.push({ material: 'concrete_wall', center: { x: 0, y: 2, z: opts.wallZ }, size: { x: 20, y: 4, z: 0.4 } });
  combat.setLevel(buildTestLevel(boxes));
  const blasts: { at: Vec3Like; def: ExplosionDef; from: AreaDamageSource }[] = [];
  const explosions: ExplosionApi = {
    explode: (at, def, from) => {
      blasts.push({ at: { x: at.x, y: at.y, z: at.z }, def: { ...def }, from: { ...from } });
      return 0;
    },
  };
  const fieldsSpawned: { at: Vec3Like; def: FieldDef }[] = [];
  const fields: FieldApi = {
    spawn: (at, def) => {
      fieldsSpawned.push({ at: { x: at.x, y: at.y, z: at.z }, def });
      return 1;
    },
    pullAt: (_p, out) => {
      out.set(0, 0, 0);
      return false;
    },
    slowAt: () => 1,
    active: 0,
    fixedUpdate: () => {},
    update: () => {},
    clear: () => {},
  };
  const drawn: { handle: number; pos: Vec3Like }[] = [];
  const vfxLog: string[] = [];
  let handles = 0;
  const vfx: ArsenalVfxApi = {
    projectileStart: (visual, _trail, p) => {
      vfxLog.push(`start ${visual} ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}`);
      return ++handles;
    },
    projectileMove: (h, p) => void drawn.push({ handle: h, pos: { x: p.x, y: p.y, z: p.z } }),
    projectileEnd: (h) => void vfxLog.push(`end ${h}`),
    beam: () => {},
    fieldStart: () => 0,
    fieldEnd: () => {},
    charge: () => {},
    update: () => {},
    clear: () => {},
  };
  const specials: SpecialHit[] = [];
  const projectiles = new ProjectileSystem({
    events,
    combat,
    explosions,
    fields,
    vfx,
    specials: { onHit: (h) => void specials.push({ ...h, point: { ...h.point } }) },
    capacity: opts.capacity,
  });
  const ev: { spawned: number; ended: number[]; impacts: GameEvents['projectile:impact'][] } = {
    spawned: 0,
    ended: [],
    impacts: [],
  };
  events.on('projectile:spawned', () => void ev.spawned++);
  events.on('projectile:ended', (e) => void ev.ended.push(e.id));
  events.on('projectile:impact', (e) => void ev.impacts.push({ ...e, position: { ...e.position }, normal: { ...e.normal } }));
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) projectiles.fixedUpdate(DT);
  };
  const where = (): Vector3[] => {
    const out: Vector3[] = [];
    projectiles.forEachProjectile((_id, x, y, z) => out.push(new Vector3(x, y, z)));
    return out;
  };
  const velocity = (): Vector3 => {
    const v = new Vector3();
    projectiles.forEachProjectile((_id, _x, _y, _z, vx, vy, vz) => v.set(vx, vy, vz));
    return v;
  };
  return { events, combat, projectiles, blasts, fieldsSpawned, drawn, vfxLog, specials, ev, tick, where, velocity };
}

describe('ProjectileSystem', () => {
  it('integrates constant gravity exactly (lobbed arc)', () => {
    const t = setup({ floor: false });
    t.projectiles.spawn({ origin: { x: 0, y: 50, z: 0 }, direction: { x: 0, y: 0, z: -1 }, def: GRENADE, damage: SOURCE });
    t.tick(30);
    const [p] = t.where();
    const time = 30 * DT;
    expect(p!.z).toBeCloseTo(-38 * time, 9);
    expect(p!.y).toBeCloseTo(50 - 0.5 * 9.8 * time * time, 9);
    expect(t.velocity().y).toBeCloseTo(-9.8 * time, 9);
    // speedScale and the thrower's velocity add up.
    t.projectiles.clear();
    t.projectiles.spawn({
      origin: { x: 0, y: 50, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      def: GRENADE,
      damage: SOURCE,
      speedScale: 1.5,
      inherit: { x: 2, y: 0, z: 0 },
    });
    const v = t.velocity();
    expect(v.z).toBeCloseTo(-57, 9);
    expect(v.x).toBeCloseTo(2, 9);
  });

  it('bounces off the floor with its restitution, then detonates on the contact after the last bounce', () => {
    const t = setup();
    t.projectiles.spawn({ origin: { x: 0, y: 3, z: 0 }, direction: { x: 0, y: -1, z: 0 }, def: { ...GRENADE, speed: 10 }, damage: SOURCE });
    let before = 0;
    for (let i = 0; i < 60 && t.ev.impacts.length === 0; i++) {
      before = -t.velocity().y;
      t.tick();
    }
    expect(t.ev.impacts[0]).toMatchObject({ detonated: false });
    expect(t.ev.impacts[0]!.normal.y).toBeCloseTo(1, 6);
    // Up again at ~restitution of the impact speed (the impact tick's gravity aside).
    expect(t.velocity().y).toBeGreaterThan(0);
    expect(t.velocity().y / before).toBeGreaterThan(GRENADE.restitution * 0.85);
    expect(t.velocity().y / before).toBeLessThan(GRENADE.restitution * 1.15);
    t.tick(600);
    expect(t.ev.impacts.filter((e) => !e.detonated)).toHaveLength(2);
    expect(t.blasts).toHaveLength(1);
    // Detonated just above the floor (lifted off the surface).
    expect(t.blasts[0]!.at.y).toBeCloseTo(ARSENAL.projectiles.blastLift, 3);
    expect(t.projectiles.active).toBe(0);
    expect(t.ev.ended).toHaveLength(1);
  });

  it('a fuse detonates wherever it is; the lifetime ends a harmless bolt without a blast', () => {
    const t = setup({ floor: false });
    t.projectiles.spawn({ origin: { x: 0, y: 10, z: 0 }, direction: { x: 1, y: 0, z: 0 }, def: { ...GRENADE, gravity: 0, fuse: 0.5 }, damage: SOURCE });
    t.tick(29);
    expect(t.blasts).toHaveLength(0);
    t.tick(1);
    expect(t.blasts).toHaveLength(1);
    expect(t.blasts[0]!.at.x).toBeCloseTo(38 * 29 * DT, 6);
    t.projectiles.spawn({ origin: { x: 0, y: 10, z: 0 }, direction: { x: 1, y: 0, z: 0 }, def: { ...BOLT, lifetime: 0.25 }, damage: SOURCE });
    t.tick(20);
    expect(t.projectiles.active).toBe(0);
    expect(t.blasts).toHaveLength(1);
    expect(t.ev.ended).toHaveLength(2);
  });

  it('direct hits deal the source damage with its zone multipliers and detonate (blast scaled)', () => {
    const t = setup({ floor: false });
    const target = new FakeTarget({ x: 0, y: 0, z: -10 }, 1000);
    t.combat.register(target);
    // Head height.
    t.projectiles.spawn({
      origin: { x: 0, y: 1.62, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      def: { ...GRENADE, gravity: 0 },
      damage: { ...SOURCE, areaScale: 1.3, special: { kind: 'lifesteal', fraction: 0.1 } },
      blastScale: 1.2,
    });
    t.tick(30);
    expect(target.received).toHaveLength(1);
    expect(target.received[0]!.zone).toBe('head');
    expect(target.received[0]!.amount).toBeCloseTo(100, 6);
    expect(target.received[0]!.kind).toBe('projectile');
    expect(target.received[0]!.element).toBe('shock');
    expect(target.received[0]!.statusBuildup).toBe(1);
    expect(t.blasts).toHaveLength(1);
    expect(t.blasts[0]!.def.radius).toBeCloseTo(BLAST.radius * 1.2, 9);
    expect(t.blasts[0]!.from).toMatchObject({ weaponId: 'test', areaScale: 1.3, special: { kind: 'lifesteal' } });
    expect(t.specials).toHaveLength(1);
    expect(t.specials[0]).toMatchObject({ via: 'direct', primary: true, applied: 100 });
    expect(t.ev.impacts[0]!.detonated).toBe(true);
  });

  it('pierces `pierce` bodies (each once), passes its own team, stops on the next', () => {
    const t = setup({ floor: false });
    const targets = [-4, -6, -8, -10].map((z) => new FakeTarget({ x: 0, y: 0, z }, 1000));
    for (const f of targets) t.combat.register(f);
    const friend = new FriendlyTarget({ x: 0, y: 1.1, z: -2 });
    t.combat.register(friend);
    t.projectiles.spawn({ origin: { x: 0, y: 1.1, z: 0 }, direction: { x: 0, y: 0, z: -1 }, def: { ...BOLT, pierce: 2 }, damage: SOURCE });
    t.tick(40);
    expect(targets.map((f) => f.received.length)).toEqual([1, 1, 1, 0]);
    expect(friend.hits).toBe(0);
    expect(t.projectiles.active).toBe(0);
    // A non-exploding stop: impact, not a detonation.
    expect(t.ev.impacts.at(-1)!.detonated).toBe(false);
  });

  it('impact detonation leaves its field; a world impact of a bolt emits combat:impact', () => {
    const t = setup({ floor: false, wallZ: -12 });
    const impacts: GameEvents['combat:impact'][] = [];
    t.events.on('combat:impact', (e) => void impacts.push({ ...e }));
    t.projectiles.spawn({ origin: { x: 0, y: 1.5, z: 0 }, direction: { x: 0, y: 0, z: -1 }, def: { ...BOLT, explosion: BLAST, field: FIELD }, damage: SOURCE });
    t.tick(30);
    expect(t.blasts).toHaveLength(1);
    expect(t.fieldsSpawned).toHaveLength(1);
    expect(t.fieldsSpawned[0]!.def).toBe(FIELD);
    expect(t.fieldsSpawned[0]!.at.z).toBeCloseTo(-11.8 + ARSENAL.projectiles.blastLift, 3);
    expect(impacts).toHaveLength(0);
    t.projectiles.spawn({ origin: { x: 0, y: 1.5, z: 0 }, direction: { x: 0, y: 0, z: -1 }, def: BOLT, damage: SOURCE });
    t.tick(30);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]).toMatchObject({ kind: 'projectile', weaponId: 'test', decal: true, surface: 'concrete' });
  });

  it('homing turns towards the enemy nearest its flight line', () => {
    const t = setup({ floor: false });
    const target = new FakeTarget({ x: 4, y: 0, z: -14 }, 1000);
    t.combat.register(target);
    t.projectiles.spawn({ origin: { x: 0, y: 1.25, z: 0 }, direction: { x: 0, y: 0, z: -1 }, def: { ...BOLT, speed: 20, homing: 4 }, damage: SOURCE });
    t.tick(80);
    expect(target.received).toHaveLength(1);
    // Without homing it flies past.
    const u = setup({ floor: false });
    const miss = new FakeTarget({ x: 4, y: 0, z: -14 }, 1000);
    u.combat.register(miss);
    u.projectiles.spawn({ origin: { x: 0, y: 1.25, z: 0 }, direction: { x: 0, y: 0, z: -1 }, def: { ...BOLT, speed: 20 }, damage: SOURCE });
    u.tick(80);
    expect(miss.received).toHaveLength(0);
  });

  it('is drawn from the muzzle and converges onto the simulated path', () => {
    const t = setup({ floor: false });
    const id = t.projectiles.spawn({
      origin: { x: 0, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      def: { ...BOLT, speed: 10 },
      damage: SOURCE,
      visualFrom: { x: 0.2, y: 1.4, z: -0.5 },
    });
    expect(t.vfxLog[0]).toBe('start projectile.plasma 0.20 1.40 -0.50');
    t.tick();
    t.projectiles.update(DT, 1);
    const early = t.drawn.at(-1)!.pos;
    // Still mostly at the muzzle offset after one tick…
    expect(early.x).toBeGreaterThan(0.1);
    t.tick(Math.ceil(ARSENAL.projectiles.convergeTime / DT) + 1);
    t.projectiles.update(DT, 1);
    // … on the true path once converged.
    const late = t.drawn.at(-1)!.pos;
    const sim = t.where()[0]!;
    expect(late.x).toBeCloseTo(sim.x, 9);
    expect(late.y).toBeCloseTo(sim.y, 9);
    const out = new Vector3();
    expect(t.projectiles.positionOf(id, out)).toBe(true);
    expect(out.z).toBeCloseTo(late.z, 9);
    expect(t.projectiles.positionOf(12345, out)).toBe(false);
  });

  it('pooled: refuses beyond capacity, clear() ends every projectile (visuals, events)', () => {
    const t = setup({ floor: false, capacity: 2 });
    const spawn = (): number =>
      t.projectiles.spawn({ origin: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: 0, z: -1 }, def: BOLT, damage: SOURCE });
    expect(spawn()).toBeGreaterThan(0);
    expect(spawn()).toBeGreaterThan(0);
    expect(spawn()).toBe(0);
    expect(t.projectiles.stats.refused).toBe(1);
    t.projectiles.clear();
    expect(t.projectiles.active).toBe(0);
    expect(t.ev.ended).toHaveLength(2);
    expect(t.vfxLog.filter((l) => l.startsWith('end'))).toHaveLength(2);
    expect(t.blasts).toHaveLength(0);
    // Slots are reused.
    expect(spawn()).toBeGreaterThan(0);
    // Garbage in: refused, never thrown.
    expect(t.projectiles.spawn({ origin: { x: Number.NaN, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 }, def: BOLT, damage: SOURCE })).toBe(0);
    expect(t.projectiles.spawn({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 0 }, def: BOLT, damage: SOURCE })).toBe(0);
  });
});
