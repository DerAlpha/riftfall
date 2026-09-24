/**
 * M6 support package behaviour: heal tether, charged laser, summons (EnemyManager harness with the
 * real brains / executors), plus the pure positioning math and the beam registry.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { DamageInfo } from '../../core/contracts';
import type { Vec3Like } from '../../core/events';
import { ENEMY_AI, getEnemyDef } from '../../defs/enemies';
import type { Enemy } from '../Enemy';
import { EnemyBeams, type EnemyBeamSink } from '../EnemyBeams';
import { DT, createEnemyHarness } from '../testFakes';
import { healTargetOf } from './attackKinds/beam';
import { minionsOf, summonType } from './attackKinds/summon';
import { SUPPORT_FLEE } from './brains/support';
import { fleeDirection, nearestRift, packCentroid, spotBehind } from './supportMath';

const seconds = (s: number): number => Math.round(s / DT);

function info(amount: number, zone: DamageInfo['zone'] = 'body'): DamageInfo {
  return {
    amount,
    zone,
    point: { x: 0, y: 1, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    weaponId: 'rifle',
    element: 'physical',
    source: 'player',
    kind: 'bullet',
  };
}

type Harness = ReturnType<typeof createEnemyHarness>;

function spawn(h: Harness, type: string, x: number, z: number): Enemy {
  const id = h.manager.spawn(type, { x, y: 0, z });
  if (id === null) throw new Error(`spawn ${type} failed`);
  return h.manager.enemies.find((e) => e.id === id)!;
}

/** Tick until `pred` holds (at most `max` s); returns the ticks taken or -1. */
function tickUntil(h: Harness, max: number, pred: () => boolean): number {
  for (let i = 0; i < seconds(max); i++) {
    h.tick();
    if (pred()) return i + 1;
  }
  return -1;
}

describe('Heiler: healing tether', () => {
  it('tethers the most injured ally in reach, heals it, and the beam ends when the healer dies', () => {
    const h = createEnemyHarness();
    const spitter = spawn(h, 'spitter', 0, -12);
    const swarmer = spawn(h, 'swarmer', 3, -12);
    const healer = spawn(h, 'healer', 1, -20);
    h.tick(seconds(1.6));
    spitter.health = spitter.maxHealth * 0.3;
    swarmer.health = swarmer.maxHealth * 0.8;
    const before = spitter.health;
    let tethered = false;
    const ok = tickUntil(h, 6, () => {
      if (h.manager.beams.isOpen(healer) && healTargetOf(healer) === spitter) tethered = true;
      return tethered && spitter.health > before + 20;
    });
    expect(ok).toBeGreaterThan(0);
    expect(h.manager.beams.visualOf(healer)).toBe('enemy.heal');
    // The tether ends at the ally's aim point.
    const from = new Vector3();
    const to = new Vector3();
    h.tick();
    if (h.manager.beams.endpoints(healer, from, to))
      expect(to.distanceTo(spitter.aimPoint)).toBeLessThan(0.01);
    // Killing the healer snaps the tether.
    h.combat.dealDamage(healer, info(10_000));
    h.tick();
    expect(h.manager.beams.isOpen(healer)).toBe(false);
    const after = spitter.health;
    h.tick(seconds(1));
    expect(spitter.health).toBeLessThanOrEqual(after);
  });

  it('never heals healthy allies and never itself', () => {
    const h = createEnemyHarness();
    spawn(h, 'spitter', 0, -12);
    const healer = spawn(h, 'healer', 1, -20);
    h.tick(seconds(1.4));
    healer.health = healer.maxHealth * 0.3;
    h.tick(seconds(3));
    expect(h.manager.beams.isOpen(healer)).toBe(false);
    expect(healer.health).toBeCloseTo(healer.maxHealth * 0.3, 5);
  });

  it('hurting it during the channel snaps the tether and staggers it', () => {
    const h = createEnemyHarness();
    const spitter = spawn(h, 'spitter', 0, -12);
    const healer = spawn(h, 'healer', 1, -20);
    h.tick(seconds(1.6));
    spitter.health = spitter.maxHealth * 0.2;
    expect(tickUntil(h, 6, () => h.manager.beams.isOpen(healer))).toBeGreaterThan(0);
    const heal = getEnemyDef('healer')!.attacks.find((a) => a.beam?.heal)!.beam!.heal!;
    h.combat.dealDamage(healer, info(heal.interruptDamage + 1));
    h.tick(2);
    expect(h.manager.beams.isOpen(healer)).toBe(false);
    expect(healer.state).toBe('stagger');
  });

  it('flees when the player closes in', () => {
    const h = createEnemyHarness();
    const healer = spawn(h, 'healer', 0, -4);
    h.tick(seconds(1.3));
    const d0 = Math.hypot(healer.position.x, healer.position.z);
    h.tick(seconds(1.5));
    expect(healer.mode === SUPPORT_FLEE || Math.hypot(healer.position.x, healer.position.z) > d0 + 2).toBe(
      true,
    );
    expect(Math.hypot(healer.position.x, healer.position.z)).toBeGreaterThan(d0 + 2);
  });
});

describe('Beschwörer: summons', () => {
  it('channels, then minions emerge near it; they count as living enemies and pay reduced points', () => {
    const h = createEnemyHarness();
    const summoner = spawn(h, 'summoner', 0, -16);
    const a = getEnemyDef('summoner')!.attacks.find((x) => x.kind === 'summon')!;
    const type = summonType(a)!;
    expect(type).toBeTruthy();
    const ok = tickUntil(h, 14, () => minionsOf(summoner, h.manager) > 0);
    expect(ok).toBeGreaterThan(0);
    const minions = h.manager.enemies.filter((e) => e.parentId === summoner.id);
    const S = a.summon!;
    expect(minions.length).toBeLessThanOrEqual(S.maxAlive);
    expect(minions.length).toBe(type === S.type ? S.count : S.fallbackCount);
    for (const m of minions) {
      expect(m.type).toBe(type);
      expect(Math.hypot(m.position.x - summoner.position.x, m.position.z - summoner.position.z)).toBeLessThan(
        S.forward + S.radius + 1,
      );
      const pts = h.manager.rewardOf(m.id)!;
      expect(pts.kill).toBe(Math.round(m.def.points.kill * ENEMY_AI.minions.pointsScale));
    }
    expect(h.manager.rewardOf(summoner.id)).toBe(summoner.def.points);
    expect(h.manager.alive).toBe(1 + minions.length);
  });

  it('damage during the channel breaks it: the summoner staggers and nothing emerges', () => {
    const h = createEnemyHarness();
    const summoner = spawn(h, 'summoner', 0, -16);
    const a = getEnemyDef('summoner')!.attacks.find((x) => x.kind === 'summon')!;
    const started = tickUntil(h, 10, () => summoner.state === 'attack' && summoner.attackIndex === 0);
    expect(started).toBeGreaterThan(0);
    h.tick(seconds(0.5));
    expect(h.manager.beams.isOpen(summoner)).toBe(true);
    h.combat.dealDamage(summoner, info(a.summon!.interruptDamage + 1));
    h.tick(2);
    expect(summoner.state).toBe('stagger');
    expect(h.manager.beams.isOpen(summoner)).toBe(false);
    h.tick(seconds(a.windup + a.strike));
    expect(minionsOf(summoner, h.manager)).toBe(0);
  });

  it('respects the per-summoner and global minion caps', () => {
    const h = createEnemyHarness();
    const summoner = spawn(h, 'summoner', 0, -16);
    h.tick(seconds(1.6));
    const M = ENEMY_AI.minions;
    const near = new Vector3(0, 0, -12);
    let n = 0;
    for (let i = 0; i < M.maxAlive + 4; i++)
      if (h.manager.spawnMinion('swarmer', near, 2, summoner) !== null) n++;
    expect(n).toBe(M.maxAlive);
  });
});

describe('Späher: charged laser', () => {
  it('hits a player who stands still with one heavy shot after the telegraph', () => {
    const h = createEnemyHarness();
    const sniper = spawn(h, 'sniper', 0, -24);
    const laser = getEnemyDef('sniper')!.attacks.find((a) => a.beam?.laser)!;
    let aimed = false;
    const ok = tickUntil(h, 12, () => {
      if (sniper.state === 'attack' && h.manager.beams.isOpen(sniper)) aimed = true;
      return h.player.hits.length > 0;
    });
    expect(ok).toBeGreaterThan(0);
    expect(aimed).toBe(true);
    expect(h.player.hits[0]!.amount).toBeCloseTo(laser.damage * sniper.damageMult, 3);
    expect(h.byType('enemy:attack').some((p) => (p as { attack: string }).attack === 'snipe')).toBe(true);
  });

  it('a strafe after the lock dodges the shot', () => {
    const h = createEnemyHarness();
    const sniper = spawn(h, 'sniper', 0, -24);
    const laser = getEnemyDef('sniper')!.attacks.find((a) => a.beam?.laser)!;
    const L = laser.beam!.laser!;
    let moved = false;
    let shots = 0;
    tickUntil(h, 12, () => {
      if (
        !moved &&
        sniper.state === 'attack' &&
        sniper.phase === 0 &&
        sniper.phaseTime >= laser.windup - L.lockTime + DT
      ) {
        h.player.setPosition(2.5, 0, 0);
        moved = true;
      }
      if (moved && sniper.phase === 2) shots++;
      return shots > 0;
    });
    expect(moved).toBe(true);
    expect(h.player.hits.length).toBe(0);
  });

  it('a wall between the locked aim and the player stops the ray', () => {
    // Cover right in front of the player's new spot: the locked line runs into it.
    const h = createEnemyHarness({
      boxes: [{ center: { x: 0, y: 1, z: -2 }, size: { x: 1.6, y: 2, z: 0.4 } }],
    });
    h.player.setPosition(3, 0, 0);
    const sniper = spawn(h, 'sniper', 3, -24);
    const laser = getEnemyDef('sniper')!.attacks.find((a) => a.beam?.laser)!;
    const L = laser.beam!.laser!;
    let ducked = false;
    let done = false;
    tickUntil(h, 12, () => {
      if (
        !ducked &&
        sniper.state === 'attack' &&
        sniper.phase === 0 &&
        sniper.phaseTime >= laser.windup - L.lockTime + DT
      ) {
        // Behind the cover, exactly on the locked line's old bearing (a strafe alone would dodge).
        h.player.setPosition(0, 0, 0);
        ducked = true;
      }
      if (ducked && sniper.phase === 2) done = true;
      return done;
    });
    expect(ducked).toBe(true);
    expect(h.player.hits.length).toBe(0);
  });
});

describe('support positioning math', () => {
  const member = (x: number, z: number, brain = 'swarm', alive = true, state = 'active') => ({
    position: { x, y: 0, z },
    alive,
    state,
    def: { brain },
  });

  it('pack centroid: living active allies near the target, no self, no support types', () => {
    const self = member(0, -20, 'support');
    const list = [
      self,
      member(0, -8),
      member(4, -8),
      member(0, -40),
      member(1, -9, 'support'),
      member(2, -9, 'swarm', false),
      member(3, -9, 'swarm', true, 'emerge'),
    ];
    const out = { x: 0, y: 0, z: 0 };
    expect(packCentroid(self, list, { x: 0, y: 0, z: 0 }, 16, 'support', out)).toBe(2);
    expect(out.x).toBeCloseTo(2);
    expect(out.z).toBeCloseTo(-8);
  });

  it('spot behind the pack, clamped to the distance band', () => {
    const out = { x: 0, y: 0, z: 0 };
    const t = { x: 0, y: 0, z: 0 };
    spotBehind({ x: 0, y: 0, z: -8 }, t, 5, 9, 22, { x: 0, y: 0, z: -1 }, out);
    expect(out.z).toBeCloseTo(-13);
    spotBehind({ x: 0, y: 0, z: -2 }, t, 2, 9, 22, { x: 0, y: 0, z: -1 }, out);
    expect(out.z).toBeCloseTo(-9);
    spotBehind({ x: 30, y: 0, z: 0 }, t, 5, 9, 22, { x: 0, y: 0, z: -1 }, out);
    expect(out.x).toBeCloseTo(22);
    // Anchor on the target: the fallback gives the direction.
    spotBehind(t, t, 5, 9, 22, { x: 0, y: 0, z: 3 }, out);
    expect(out.z).toBeCloseTo(9);
  });

  it('flee directions: straight away first, then fanning out alternately', () => {
    const out = { x: 0, y: 0, z: 0 };
    fleeDirection(0, 1, 0, Math.PI / 4, out);
    expect(out.z).toBeCloseTo(1);
    fleeDirection(0, 1, 1, Math.PI / 4, out);
    const a1 = Math.atan2(out.x, out.z);
    fleeDirection(0, 1, 2, Math.PI / 4, out);
    const a2 = Math.atan2(out.x, out.z);
    expect(Math.abs(a1)).toBeCloseTo(Math.PI / 4);
    expect(a2).toBeCloseTo(-a1);
    fleeDirection(0, 1, 3, Math.PI / 4, out);
    expect(Math.abs(Math.atan2(out.x, out.z))).toBeCloseTo(Math.PI / 2);
  });

  it('nearest rift within reach and not next to the target', () => {
    const rifts = [
      { position: { x: 0, y: 0, z: -3 } },
      { position: { x: 8, y: 0, z: -20 } },
      { position: { x: 0, y: 0, z: -40 } },
    ];
    const self = { x: 2, y: 0, z: -18 };
    expect(nearestRift(self, { x: 0, y: 0, z: 0 }, rifts, 22, 10)).toBe(1);
    // Rift 1 is next to the target; rift 0 is the nearest remaining one.
    expect(nearestRift(self, { x: 8, y: 0, z: -24 }, rifts, 22, 10)).toBe(0);
    expect(nearestRift(self, { x: 0, y: 0, z: 0 }, rifts, 3, 10)).toBe(-1);
  });
});

describe('EnemyBeams', () => {
  function fakeEnemy(id: number, x: number): Enemy {
    return {
      id,
      state: 'active',
      alive: true,
      position: new Vector3(x, 0, 0),
      aimPoint: new Vector3(x, 1, 0),
      pose: { scale: 1 },
      def: { perception: { eyeHeight: 1.5 } },
    } as unknown as Enemy;
  }
  const sockets = { socket: (e: Enemy, _n: string, out: Vector3) => (out.set(e.position.x, 2, 0), true) };
  const calls: { visual: string; from: Vec3Like; to: Vec3Like }[] = [];
  const sink: EnemyBeamSink = {
    beam: (visual, from, to) => calls.push({ visual, from: { ...from }, to: { ...to } }),
    shot: (visual, to, from) => calls.push({ visual: `shot:${visual}`, from: { ...from }, to: { ...to } }),
  };

  it('samples per tick, interpolates per frame, follows allies, closes freed records', () => {
    const beams = new EnemyBeams(2, 2);
    const a = fakeEnemy(1, 0);
    const b = fakeEnemy(2, 10);
    expect(beams.open(a, 'v', 's')).toBe(true);
    beams.toEnemy(a, b);
    calls.length = 0;
    beams.draw(0.5, sink);
    expect(calls.length).toBe(0); // not sampled yet
    beams.sample(sockets);
    b.aimPoint.set(20, 1, 0);
    beams.sample(sockets);
    beams.draw(0.5, sink);
    expect(calls[0]!.to.x).toBeCloseTo(15);
    // Capacity 2: a third beam is refused.
    const c = fakeEnemy(3, 5);
    expect(beams.open(c, 'v', 's')).toBe(true);
    expect(beams.open(fakeEnemy(4, 5), 'v', 's')).toBe(false);
    // The record was reused by another enemy: the beam closes at the next sample.
    (a as { id: number }).id = 99;
    beams.sample(sockets);
    expect(beams.openCount).toBe(1);
    beams.shot('x', { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    calls.length = 0;
    beams.draw(1, sink);
    expect(calls.map((c) => c.visual)).toEqual(['v', 'shot:x']);
    calls.length = 0;
    beams.draw(1, sink);
    expect(calls.map((c) => c.visual)).toEqual(['v']);
    beams.clear();
    expect(beams.openCount).toBe(0);
  });
});
