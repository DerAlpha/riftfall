import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { DamageInfo } from '../core/contracts';
import { ENEMIES, ENEMY_AI } from '../defs/enemies';
import { enemyDamageAmount, type Enemy } from './Enemy';
import { RANGED_HIDE, RANGED_HOLD } from './ai/brains/ranged';
import { DT, FakePlayer, createEnemyHarness } from './testFakes';

function info(amount: number, zone: DamageInfo['zone'] = 'body', weaponId = 'rifle'): DamageInfo {
  return {
    amount,
    zone,
    point: { x: 0, y: 1, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    weaponId,
    element: 'physical',
    source: 'player',
    kind: 'bullet',
  };
}

function enemyById(h: ReturnType<typeof createEnemyHarness>, id: number): Enemy {
  const e = h.manager.enemies.find((x) => x.id === id);
  if (!e) throw new Error(`enemy ${id} not found`);
  return e;
}

const seconds = (s: number): number => Math.round(s / DT);

describe('enemyDamageAmount (zone multipliers on top of the weapon, armor, resistances)', () => {
  it('applies the per-type zone multipliers', () => {
    expect(enemyDamageAmount(ENEMIES.swarmer, 'head', 30, 'physical')).toBeCloseTo(60);
    expect(enemyDamageAmount(ENEMIES.swarmer, 'body', 30, 'physical')).toBeCloseTo(30);
    expect(enemyDamageAmount(ENEMIES.spitter, 'weakpoint', 40, 'physical')).toBeCloseTo(100);
    expect(enemyDamageAmount(ENEMIES.tank, 'weakpoint', 30, 'physical')).toBeCloseTo(90);
  });

  it('armored front: tank shield ×0.3, then flat armor, never below the min fraction', () => {
    // 28 × 0.3 = 8.4 → − 2 flat = 6.4 (above 50 % of 8.4).
    expect(enemyDamageAmount(ENEMIES.tank, 'shield', 28, 'physical')).toBeCloseTo(6.4);
    // A pellet: 3 × 0.3 = 0.9 → flat would leave 0 → clamped to 0.45.
    expect(enemyDamageAmount(ENEMIES.tank, 'shield', 3, 'physical')).toBeCloseTo(0.45);
    // Flat armor only on listed zones.
    expect(enemyDamageAmount(ENEMIES.tank, 'body', 28, 'physical')).toBeCloseTo(28);
  });

  it('impact surface per zone: the tank front sparks (armor), its flesh and back core bleed', () => {
    const h = createEnemyHarness();
    const e = enemyById(h, h.manager.spawn('tank', { x: 0, y: 0, z: -8 })!);
    h.tick(2);
    const seen = new Map<string, string>();
    const dir = new Vector3();
    const from = new Vector3();
    for (const hb of e.hitboxes) {
      // From 4 m outside the body, through the hitbox center.
      dir.set(hb.a.x - e.position.x, 0, hb.a.z - e.position.z);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      dir.normalize();
      from.copy(hb.a).addScaledVector(dir, 4);
      dir.negate();
      const hit = h.combat.raycast(from, dir, 8);
      if (hit?.target === e && hit.zone) seen.set(hit.zone, hit.surface);
    }
    expect(seen.get('shield')).toBe('armor');
    expect(seen.get('weakpoint')).toBe('flesh');
    expect(e.surface).toBe('armor'); // penetration still sees an armored body
  });

  it('element resistances and garbage input', () => {
    expect(enemyDamageAmount(ENEMIES.spitter, 'body', 40, 'poison')).toBeCloseTo(10);
    expect(enemyDamageAmount(ENEMIES.spitter, 'body', Number.NaN, 'physical')).toBe(0);
    expect(enemyDamageAmount(ENEMIES.spitter, 'body', -5, 'physical')).toBe(0);
  });
});

describe('EnemyManager lifecycle', () => {
  it('spawns, dies with credit info, dissolves and reuses the pooled record', () => {
    const h = createEnemyHarness();
    const id = h.manager.spawn('swarmer', { x: 0, y: 0, z: -10 });
    expect(id).not.toBeNull();
    expect(h.manager.alive).toBe(1);
    expect(h.manager.stats.byType.swarmer).toBe(1);
    expect(h.visuals.acquired).toBe(1);
    expect(h.nav.enemyAgents(h.manager.playerAgentId)).toBe(1);
    expect(h.byType('enemy:spawned')).toHaveLength(1);
    const e = enemyById(h, id!);
    expect(h.combat.targets).toContain(e);
    expect(e.hitboxes.length).toBeGreaterThan(3);
    expect(e.state).toBe('emerge');

    h.tick(seconds(ENEMIES.swarmer.emergeTime) + 2);
    expect(e.state).not.toBe('emerge');
    expect(e.pose.emerge).toBe(1);

    const res = h.combat.dealDamage(e, info(500, 'head', 'pistol'));
    expect(res.killed).toBe(true);
    expect(h.manager.alive).toBe(0);
    expect(h.combat.targets).toContain(e); // unregistered by the manager's tick
    h.tick(1);
    const died = h.byType('enemy:died') as { id: number; weaponId: string; zone: string; source: string }[];
    expect(died).toHaveLength(1);
    expect(died[0]).toMatchObject({ id, weaponId: 'pistol', zone: 'head', source: 'player' });
    expect(h.combat.targets).not.toContain(e);
    expect(h.nav.enemyAgents(h.manager.playerAgentId)).toBe(0);
    expect(e.state).toBe('dying');

    const D = ENEMIES.swarmer.death;
    h.tick(seconds(D.collapse + D.linger + D.dissolve) + 3);
    expect(e.state).toBe('free');
    expect(h.visuals.released).toBe(1);
    expect(h.manager.enemies).toHaveLength(0);

    const id2 = h.manager.spawn('swarmer', { x: 2, y: 0, z: -10 });
    expect(id2).not.toBeNull();
    expect(id2).not.toBe(id);
    expect(enemyById(h, id2!)).toBe(e); // same pooled record
    expect(e.health).toBe(ENEMIES.swarmer.health);
    expect(e.lastWeaponId).toBeNull();
  });

  it('refuses unknown types, respects capacity, clear() releases everything', () => {
    const h = createEnemyHarness({ manager: { capacity: 3 } });
    expect(h.manager.spawn('nope', { x: 0, y: 0, z: 0 })).toBeNull();
    for (let i = 0; i < 3; i++) expect(h.manager.spawn('swarmer', { x: i, y: 0, z: -8 })).not.toBeNull();
    expect(h.manager.spawn('swarmer', { x: 5, y: 0, z: -8 })).toBeNull();
    h.tick(5);
    h.manager.clear();
    expect(h.manager.alive).toBe(0);
    expect(h.visuals.released).toBe(3);
    expect(h.nav.enemyAgents(h.manager.playerAgentId)).toBe(0);
    expect(h.combat.targets).toHaveLength(0);
    expect(h.manager.spawn('tank', { x: 0, y: 0, z: -8 })).not.toBeNull();
  });

  it('killAll credits the player and suppresses acid bursts', () => {
    const h = createEnemyHarness();
    h.manager.spawn('spitter', { x: 1, y: 0, z: -2 });
    h.manager.spawn('swarmer', { x: -1, y: 0, z: -3 });
    h.tick(2);
    expect(h.manager.killAll(true)).toBe(2);
    const died = h.byType('enemy:died') as { source: string; weaponId: string }[];
    expect(died).toHaveLength(2);
    expect(died.every((d) => d.source === 'player' && d.weaponId === ENEMY_AI.nukeWeaponId)).toBe(true);
    expect(h.player.hits).toHaveLength(0);
  });

  it('a spitter sac burst splashes the player and chains into nearby enemies (credited)', () => {
    const h = createEnemyHarness();
    const sp = h.manager.spawn('spitter', { x: 0, y: 0, z: -2.5 })!;
    const sw = h.manager.spawn('swarmer', { x: 1.2, y: 0, z: -2.5 })!;
    h.tick(2);
    h.combat.dealDamage(enemyById(h, sp), info(1000, 'weakpoint'));
    h.tick(1);
    expect(h.player.totalDamage).toBeGreaterThan(0);
    const swarmer = enemyById(h, sw);
    expect(swarmer.health).toBeLessThan(ENEMIES.swarmer.health);
    expect(swarmer.lastSource).toBe('player');
    expect(h.manager.projectiles!.stats.puddles).toBe(1);
  });
});

describe('EnemyManager hit reactions', () => {
  it('staggers past the threshold (event, attack cancelled) and is immune right after', () => {
    const h = createEnemyHarness();
    const id = h.manager.spawn('spitter', { x: 0, y: 0, z: -12 })!;
    const e = enemyById(h, id);
    h.tick(seconds(ENEMIES.spitter.emergeTime) + 2);
    h.combat.dealDamage(e, info(ENEMIES.spitter.stagger.threshold + 5, 'body'));
    h.tick(1);
    expect(e.state).toBe('stagger');
    expect(h.byType('enemy:staggered')).toHaveLength(1);
    expect(e.pose.stagger).toBeGreaterThan(0);
    h.tick(seconds(ENEMIES.spitter.stagger.duration) + 1);
    expect(e.state).not.toBe('stagger');
    // Immune: a second big hit right away does not stagger again.
    h.combat.dealDamage(e, info(ENEMIES.spitter.stagger.threshold * 1.5, 'limb'));
    h.tick(1);
    expect(h.byType('enemy:staggered')).toHaveLength(1);
  });

  it('hit flash and knockback (resisted per type)', () => {
    const h = createEnemyHarness();
    const s = enemyById(h, h.manager.spawn('swarmer', { x: 0, y: 0, z: -10 })!);
    const t = enemyById(h, h.manager.spawn('tank', { x: 6, y: 0, z: -10 })!);
    h.tick(seconds(2));
    const s0 = s.position.clone();
    const t0 = t.position.clone();
    h.manager.aiEnabled = false;
    h.tick(2);
    s0.copy(s.position);
    t0.copy(t.position);
    const push = { ...info(5, 'limb'), impulse: 6, direction: { x: 0, y: 0, z: -1 } };
    h.combat.dealDamage(s, push);
    h.combat.dealDamage(t, push);
    expect(s.pose.hitFlash).toBe(1);
    h.tick(seconds(0.5));
    expect(s.pose.hitFlash).toBe(0);
    const sPushed = s0.z - s.position.z;
    const tPushed = t0.z - t.position.z;
    expect(sPushed).toBeGreaterThan(0.3);
    expect(tPushed).toBeLessThan(sPushed * 0.2);
    expect(s.override).toBe('none');
  });
});

describe('EnemyManager group behaviour', () => {
  it('limits simultaneous melee attackers and rotates them in', () => {
    const h = createEnemyHarness();
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      h.manager.spawn('swarmer', { x: Math.cos(a) * 6, y: 0, z: Math.sin(a) * 6 });
    }
    let maxSlotAttackers = 0;
    let maxTokens = 0;
    const attackers = new Set<number>();
    const starts: number[] = [];
    let now = 0;
    h.events.on('enemy:attack', (e) => {
      attackers.add(e.id);
      starts.push(now);
    });
    h.tick(seconds(12), (t) => {
      now = t;
      let busy = 0;
      for (const e of h.manager.enemies) {
        if (e.state === 'attack' && e.def.attacks[e.attackIndex]!.usesSlot) busy++;
      }
      maxSlotAttackers = Math.max(maxSlotAttackers, busy);
      maxTokens = Math.max(maxTokens, h.manager.coordinatorAt(0).inUse);
    });
    expect(maxTokens).toBeLessThanOrEqual(ENEMY_AI.slots.pools.light);
    expect(maxSlotAttackers).toBeLessThanOrEqual(ENEMY_AI.slots.pools.light);
    expect(attackers.size).toBeGreaterThan(ENEMY_AI.slots.pools.light);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(ENEMY_AI.slots.minAttackSpacing - 1e-9);
    }
    // Pressure, not burst: bounded damage per second.
    const dps = h.player.totalDamage / 12;
    expect(dps).toBeGreaterThan(0);
    expect(dps).toBeLessThan(40);
  });

  it('waiting swarmers spread around the player and prefer the back/sides', () => {
    const h = createEnemyHarness();
    h.player.yaw = 0; // looks down −Z
    for (let i = 0; i < 6; i++) h.manager.spawn('swarmer', { x: -3 + i * 1.2, y: 0, z: -14 });
    // Freeze the token pool so everybody waits on the ring.
    h.manager.coordinatorAt(0).maxTokens = 0;
    h.tick(seconds(6));
    const bearings = h.manager.enemies.map((e) => Math.atan2(e.position.z, e.position.x));
    const inFront = h.manager.enemies.filter((e) => e.position.z < -2 && Math.abs(e.position.x) < 2).length;
    expect(inFront).toBeLessThanOrEqual(1);
    // Spread: at least 4 distinct slots.
    const slots = new Set(h.manager.enemies.map((e) => e.slot));
    expect(slots.size).toBeGreaterThanOrEqual(4);
    for (const e of h.manager.enemies) {
      const d = Math.hypot(e.position.x, e.position.z);
      expect(d).toBeGreaterThan(ENEMIES.swarmer.swarm!.ringRadius - 1.5);
      expect(d).toBeLessThan(ENEMIES.swarmer.swarm!.ringRadius + 1.5);
    }
    expect(bearings.length).toBe(6);
  });
});

describe('Spitter positioning', () => {
  it('repositions to regain line of sight when a wall blocks it, then spits', () => {
    const wall = { center: { x: 0, y: 2, z: -6 }, size: { x: 7, y: 4, z: 0.6 } };
    const h = createEnemyHarness({ boxes: [wall] });
    const id = h.manager.spawn('spitter', { x: 0, y: 0, z: -13 })!;
    const e = enemyById(h, id);
    const mouth = new Vector3();
    const blocked = (): boolean => {
      h.visuals.computeSocket('spitter', e.handle, ENEMIES.spitter.perception.eyeSocket, mouth);
      return !h.combat.lineOfSight(mouth, h.player.eyePosition);
    };
    expect(blocked()).toBe(true);
    const spits: number[] = [];
    h.events.on('enemy:attack', (a) => {
      if (a.attack === 'spit') spits.push(a.id);
    });
    h.tick(seconds(8));
    expect(blocked()).toBe(false);
    expect(spits.length).toBeGreaterThan(0);
    expect(h.manager.projectiles!.stats.fired).toBeGreaterThan(0);
    const d = Math.hypot(e.position.x, e.position.z);
    const R = ENEMIES.spitter.ranged!;
    expect(d).toBeGreaterThan(R.bandMin - 2);
    expect(d).toBeLessThan(R.bandMax + 2);
  });

  it('peeks out of cover to spit, then ducks back behind it until the next shot', () => {
    // Pillar to the spitter's left (+1 side of its line of fire to the player at the origin).
    const pillar = { center: { x: -1.75, y: 2, z: -11.6 }, size: { x: 1.5, y: 4, z: 0.8 } };
    const h = createEnemyHarness({ boxes: [pillar] });
    const e = enemyById(h, h.manager.spawn('spitter', { x: 0, y: 0, z: -13 })!);
    h.tick(seconds(ENEMIES.spitter.emergeTime) + 1);
    const spitIdx = ENEMIES.spitter.attacks.findIndex((a) => a.kind === 'projectile');
    const reset = (): void => {
      e.mode = RANGED_HOLD;
      e.canSee = true;
      e.losTime = h.manager.time;
      e.lastSeenTime = h.manager.time;
      e.spot.copy(e.position);
      e.spotValid = true;
      e.coverSide = 1;
      e.attackReady[spitIdx] = 0;
    };
    reset();
    const spits: number[] = [];
    h.events.on('enemy:attack', (a) => {
      if (a.attack === 'spit') spits.push(h.manager.time);
    });
    const mouth = new Vector3();
    let hiddenWhileHiding = 0;
    h.tick(seconds(8), () => {
      if (e.mode !== RANGED_HIDE) return;
      h.visuals.computeSocket('spitter', e.handle, 'mouth', mouth);
      if (!h.combat.lineOfSight(mouth, h.player.eyePosition)) hiddenWhileHiding++;
    });
    expect(spits.length).toBeGreaterThanOrEqual(2);
    expect(hiddenWhileHiding).toBeGreaterThan(seconds(0.3));
    // It came back out: the spitter ends near its firing spot, not stuck behind the pillar.
    expect(spits[1]! - spits[0]!).toBeLessThan(ENEMIES.spitter.attacks[spitIdx]!.cooldown + 2);
  });

  it('spaces the volleys of many spitters', () => {
    const h = createEnemyHarness();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      h.manager.spawn('spitter', { x: Math.cos(a) * 13, y: 0, z: Math.sin(a) * 13 });
    }
    const starts: number[] = [];
    let now = 0;
    h.events.on('enemy:attack', (e) => {
      if (e.attack === 'spit') starts.push(now);
    });
    h.tick(seconds(10), (t) => (now = t));
    expect(starts.length).toBeGreaterThan(4);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(ENEMY_AI.attackSpacing.projectile - 1e-9);
    }
  });

  it('every spitter gets its turn: the spaced volley slots go to the longest waiter', () => {
    const h = createEnemyHarness();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      h.manager.spawn('spitter', { x: Math.cos(a) * 13, y: 0, z: Math.sin(a) * 13 });
    }
    const spits = new Map<number, number>();
    h.events.on('enemy:attack', (e) => {
      if (e.attack === 'spit') spits.set(e.id, (spits.get(e.id) ?? 0) + 1);
    });
    h.tick(seconds(30));
    // A fixed think order let the first four take every slot (the other six never spat).
    expect(spits.size).toBe(10);
    const counts = [...spits.values()];
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
  });

  it('never fires without line of sight', () => {
    // The spitter is boxed in: every candidate spot is behind the ring wall.
    const boxes = [
      { center: { x: 0, y: 2, z: -5 }, size: { x: 40, y: 4, z: 0.6 } },
      { center: { x: 0, y: 2, z: 5 }, size: { x: 40, y: 4, z: 0.6 } },
      { center: { x: -5, y: 2, z: 0 }, size: { x: 0.6, y: 4, z: 40 } },
      { center: { x: 5, y: 2, z: 0 }, size: { x: 0.6, y: 4, z: 40 } },
    ];
    const h = createEnemyHarness({ boxes });
    h.manager.spawn('spitter', { x: 0, y: 0, z: -13 });
    h.tick(seconds(6));
    const spits = (h.byType('enemy:attack') as { attack: string }[]).filter((a) => a.attack === 'spit');
    expect(spits).toHaveLength(0);
  });
});

describe('Tank charge', () => {
  function tankAt(z: number) {
    const h = createEnemyHarness();
    const id = h.manager.spawn('tank', { x: 0, y: 0, z })!;
    const e = enemyById(h, id);
    const charges: number[] = [];
    let now = 0;
    h.events.on('enemy:attack', (a) => {
      if (a.attack === 'charge') charges.push(now);
    });
    const run = (s: number, before?: (t: number) => void) =>
      h.tick(seconds(s), (t) => {
        now = t;
        before?.(t);
      });
    return { h, e, charges, run };
  }

  const chargeDef = ENEMIES.tank.attacks.find((a) => a.id === 'charge')!;

  it('telegraphs, dashes straight and hits the player', () => {
    const { h, e, charges, run } = tankAt(-12);
    run(ENEMIES.tank.emergeTime + 0.2);
    // Wait for the charge wind-up (cooldown jitter + LOS round robin).
    run(chargeDef.cooldown * ENEMY_AI.firstAttackJitter + 1.5);
    expect(charges.length).toBeGreaterThan(0);
    run(chargeDef.windup + chargeDef.strike + 0.2);
    expect(h.player.hits.some((x) => Math.abs(x.amount - chargeDef.damage) < 1e-6)).toBe(true);
    expect(h.byType('camera:shake').length).toBeGreaterThan(0);
    expect(Math.hypot(e.position.x, e.position.z)).toBeLessThan(4);
  });

  it('a stagger during the wind-up cancels the charge', () => {
    const { h, e, charges, run } = tankAt(-12);
    run(ENEMIES.tank.emergeTime + 0.2);
    let t = 0;
    while (charges.length === 0 && t < 10) {
      run(0.1);
      t += 0.1;
    }
    expect(charges.length).toBe(1);
    expect(e.state).toBe('attack');
    const z0 = e.position.z;
    h.combat.dealDamage(
      e,
      info(ENEMIES.tank.stagger.threshold / ENEMIES.tank.stagger.weakpointMultiplier + 1, 'weakpoint'),
    );
    run(DT * 2);
    expect(e.state).toBe('stagger');
    expect(e.override).toBe('none');
    run(ENEMIES.tank.stagger.duration * 0.5);
    expect(Math.abs(e.position.z - z0)).toBeLessThan(0.5);
    expect(h.player.hits).toHaveLength(0);
  });

  function waitForCharge(run: (s: number) => void, charges: number[]): void {
    let t = 0;
    while (charges.length === 0 && t < 10) {
      run(0.1);
      t += 0.1;
    }
  }

  it('fizzles when the lane is blocked at the strike', () => {
    const { h, e, charges, run } = tankAt(-12);
    run(ENEMIES.tank.emergeTime + 0.2);
    waitForCharge(run, charges);
    expect(charges.length).toBe(1);
    // Wall right in front of the tank: the dash cannot start.
    const z = e.position.z;
    h.nav.walls.push({ ax: -5, az: z + 0.8, bx: 5, bz: z + 0.8 });
    run(chargeDef.windup + 0.1);
    expect(e.override).toBe('none');
    expect(Math.abs(e.position.z - z)).toBeLessThan(0.3);
    expect(h.player.hits).toHaveLength(0);
  });

  it('staggers itself when it runs into a wall mid-dash', () => {
    const { h, e, charges, run } = tankAt(-12);
    run(ENEMIES.tank.emergeTime + 0.2);
    waitForCharge(run, charges);
    let t = 0;
    while (e.override !== 'charge' && t < 3) {
      run(DT);
      t += DT;
    }
    expect(e.override).toBe('charge');
    h.nav.walls.push({ ax: -5, az: e.position.z + 3, bx: 5, bz: e.position.z + 3 });
    run(0.6);
    expect(h.byType('enemy:staggered')).toHaveLength(1);
    expect(e.state).toBe('stagger');
    expect(e.override).toBe('none');
    expect(h.player.hits).toHaveLength(0);
    // Its nav agent follows it to where it stopped.
    run(DT * 2);
    const agent = h.nav.agents[e.agent]!;
    expect(agent.pos.distanceTo(e.position)).toBeLessThan(0.3);
  });
});

describe('Swarmer melee is dodgeable', () => {
  it('a bite misses when the player dashes out of reach during the wind-up', () => {
    const h = createEnemyHarness();
    const e = enemyById(h, h.manager.spawn('swarmer', { x: 0, y: 0, z: -1.5 })!);
    let dodged = false;
    h.events.on('enemy:attack', (a) => {
      if (a.attack === 'bite' && !dodged) {
        dodged = true;
        h.player.setPosition(0, 0, 4); // dash away
      }
    });
    const bite = ENEMIES.swarmer.attacks.find((a) => a.id === 'bite')!;
    let t = 0;
    while (!dodged && t < ENEMIES.swarmer.emergeTime + 2) {
      h.tick(1);
      t += DT;
    }
    h.tick(seconds(bite.windup + bite.strike) + 1);
    expect(dodged).toBe(true);
    expect(h.player.hits).toHaveLength(0);
    expect(e.alive).toBe(true);
  });
});

describe('Perception and aggro', () => {
  it('hears gunshots within its hearing radius (aware + alert + last known position)', () => {
    const h = createEnemyHarness({ player: { x: 0, y: 0, z: 0 } });
    const near = enemyById(h, h.manager.spawn('swarmer', { x: 0, y: 0, z: -20 })!);
    const far = enemyById(h, h.manager.spawn('swarmer', { x: 0, y: 0, z: 60 })!);
    h.tick(seconds(ENEMIES.swarmer.emergeTime) + 1);
    for (const e of [near, far]) {
      e.aware = false;
      e.alerted = false;
    }
    const shot = { x: 0, y: 1.6, z: 0 };
    h.events.emit('weapon:fired', {
      weaponId: 'rifle',
      origin: shot,
      direction: { x: 0, y: 0, z: -1 },
      muzzle: shot,
      shotIndex: 0,
      ammoInMag: 10,
      ads: false,
    });
    h.tick(1);
    expect(near.aware).toBe(true);
    expect(near.alerted).toBe(true);
    // Heard (shot origin) or seen right after (player feet): both put it where the player is.
    expect(Math.hypot(near.lastKnown.x - shot.x, near.lastKnown.z - shot.z)).toBeLessThan(1e-6);
    expect(far.aware).toBe(false);
    expect(h.byType('enemy:alert').length).toBeGreaterThan(0);
  });

  it('a decoy with a big threat bias pulls aggro; unregistering returns it to the player', () => {
    const h = createEnemyHarness();
    const e = enemyById(h, h.manager.spawn('swarmer', { x: 0, y: 0, z: -15 })!);
    const decoy = new FakePlayer(12, 0, -15);
    h.tick(seconds(ENEMIES.swarmer.emergeTime) + 1);
    const slot = h.manager.registerTarget(decoy, 100);
    expect(slot).toBeGreaterThan(0);
    h.tick(seconds(3));
    expect(e.targetSlot).toBe(slot);
    expect(Math.hypot(e.position.x - 12, e.position.z + 15)).toBeLessThan(6);
    expect(decoy.totalDamage).toBeGreaterThan(0);
    h.manager.unregisterTarget(decoy);
    h.tick(1);
    expect(e.targetSlot).toBe(0);
  });

  it('leashes enemies that stay too far away: they re-emerge at a spawn point near the player', () => {
    const h = createEnemyHarness();
    h.manager.setSpawnPoints([
      { id: 'far', position: new Vector3(0, 0, 80), yaw: 0, zone: 'a', kind: 'rift' },
      { id: 'near', position: new Vector3(0, 0, -20), yaw: 0, zone: 'a', kind: 'rift' },
      { id: 'tooClose', position: new Vector3(3, 0, 0), yaw: 0, zone: 'a', kind: 'rift' },
    ]);
    const e = enemyById(h, h.manager.spawn('tank', { x: 0, y: 0, z: 90 })!);
    h.manager.aiEnabled = false; // it would otherwise walk in
    h.tick(seconds(ENEMY_AI.leash.time + ENEMY_AI.leash.checkInterval * 2 + ENEMIES.tank.emergeTime));
    expect(e.position.distanceTo(new Vector3(0, 0, -20))).toBeLessThan(0.5);
    expect(h.nav.agents[e.agent]!.pos.distanceTo(e.position)).toBeLessThan(0.5);
  });

  it('never allocates records per tick: 30 enemies over 300 ticks keep the same records', () => {
    const h = createEnemyHarness();
    for (let i = 0; i < 30; i++)
      h.manager.spawn(i % 3 === 0 ? 'spitter' : 'swarmer', { x: i - 15, y: 0, z: -18 });
    const before = [...h.manager.enemies];
    h.tick(300);
    expect(h.manager.enemies.length).toBe(30);
    for (const e of h.manager.enemies) expect(before).toContain(e);
  });
});

describe('Knockback threshold', () => {
  it('single bullets only flinch; a shotgun-sized shove knocks back', () => {
    const h = createEnemyHarness();
    const e = enemyById(h, h.manager.spawn('swarmer', { x: 0, y: 0, z: -10 })!);
    h.tick(seconds(ENEMIES.swarmer.emergeTime) + 2);
    h.manager.aiEnabled = false;
    h.tick(2);
    const z0 = e.position.z;
    const K = ENEMY_AI.knockback;
    const resist = 1 - ENEMIES.swarmer.knockbackResistance;
    // A rifle bullet's impulse stays below the start threshold (after resistance).
    const bullet = { ...info(1, 'body'), impulse: (K.startSpeed * 0.8) / resist };
    for (let i = 0; i < 6; i++) {
      h.combat.dealDamage(e, bullet);
      h.tick(6);
    }
    expect(e.override).toBe('none');
    expect(Math.abs(e.position.z - z0)).toBeLessThan(0.05);
    expect(e.flinch + e.pose.hitFlash).toBeGreaterThan(0);
    // Several pellets in the same tick add up.
    const pellet = { ...info(1, 'body'), impulse: (K.startSpeed * 0.5) / resist };
    for (let i = 0; i < 3; i++) h.combat.dealDamage(e, pellet);
    h.tick(1);
    expect(e.override).toBe('knockback');
    h.tick(seconds(1));
    expect(e.override).toBe('none');
    expect(z0 - e.position.z).toBeGreaterThan(0.1);
  });
});

describe('Deaths mid-move', () => {
  it('a swarmer killed mid-pounce drops to the floor', () => {
    const h = createEnemyHarness();
    const e = enemyById(h, h.manager.spawn('swarmer', { x: 0, y: 0, z: -6 })!);
    let t = 0;
    while (!(e.override === 'leap' && e.position.y > 0.3) && t < 15) {
      h.tick(1);
      t += DT;
    }
    expect(e.override).toBe('leap');
    h.combat.dealDamage(e, info(500, 'body'));
    h.tick(1);
    expect(e.state).toBe('dying');
    expect(e.position.y).toBeCloseTo(0, 3);
  });

  it('one killed while emerging collapses half in the rift (no pop-out)', () => {
    const h = createEnemyHarness();
    const e = enemyById(h, h.manager.spawn('tank', { x: 0, y: 0, z: -10 })!);
    h.tick(seconds(ENEMIES.tank.emergeTime * 0.4));
    const emerge = e.pose.emerge;
    expect(emerge).toBeLessThan(1);
    h.combat.dealDamage(e, info(5000, 'weakpoint'));
    h.tick(1);
    expect(e.state).toBe('dying');
    expect(e.pose.emerge).toBeCloseTo(emerge, 6);
  });
});

describe('Knockback into walls', () => {
  it('stops at a wall even when the nav reports every line walkable (no navmesh yet)', () => {
    const wall = { center: { x: 0, y: 2, z: -12 }, size: { x: 8, y: 4, z: 0.4 } };
    const h = createEnemyHarness({ boxes: [wall] });
    const e = enemyById(h, h.manager.spawn('swarmer', { x: 0, y: 0, z: -10.8 })!);
    h.tick(seconds(ENEMIES.swarmer.emergeTime) + 2);
    h.manager.aiEnabled = false;
    h.tick(2);
    const shove = { ...info(1, 'body'), impulse: 40, direction: { x: 0, y: 0, z: -1 } };
    h.combat.dealDamage(e, shove);
    h.tick(seconds(1));
    // Wall face at z = −11.8; the body (nav radius) stays in front of it.
    expect(e.position.z).toBeGreaterThan(-11.8 + ENEMIES.swarmer.nav.radius * 0.5);
    expect(e.override).toBe('none');
  });
});

describe('Death processing', () => {
  it('a chain of sac bursts resolves in the same tick, whatever the list order', () => {
    const h = createEnemyHarness();
    // B is earlier in the active list than A: A's burst kills B after B was already visited.
    const b = enemyById(h, h.manager.spawn('spitter', { x: 1.5, y: 0, z: -8 })!);
    const a = enemyById(h, h.manager.spawn('spitter', { x: 0, y: 0, z: -8 })!);
    h.tick(seconds(ENEMIES.spitter.emergeTime) + 2);
    b.health = 1;
    h.combat.dealDamage(a, info(1000, 'body'));
    h.tick(1);
    const died = h.byType('enemy:died') as { id: number; source: string }[];
    expect(died.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
    expect(died.every((d) => d.source === 'player')).toBe(true);
    expect(b.state).toBe('dying');
  });
});

describe('Token pools and attack spacing', () => {
  it('one tank in melee at a time, the others hold at the wait ring; the swarm keeps biting', () => {
    const h = createEnemyHarness();
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      h.manager.spawn('tank', { x: Math.cos(a) * 12, y: 0, z: Math.sin(a) * 12 });
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      h.manager.spawn('swarmer', { x: Math.cos(a) * 9, y: 0, z: Math.sin(a) * 9 });
    }
    const heavy = h.manager.coordinatorAt(0, 1);
    const light = h.manager.coordinatorAt(0, 0);
    let maxHeavy = 0;
    let maxHeavyMelee = 0;
    let waitDist = 0;
    let waitSamples = 0;
    const attacks: Record<string, number> = {};
    const charges: number[] = [];
    let now = 0;
    h.events.on('enemy:attack', (e) => {
      attacks[`${e.type}.${e.attack}`] = (attacks[`${e.type}.${e.attack}`] ?? 0) + 1;
      if (e.attack === 'charge') charges.push(now);
    });
    h.tick(seconds(20), (t) => {
      now = t;
      maxHeavy = Math.max(maxHeavy, heavy.inUse);
      let melee = 0;
      for (const e of h.manager.enemies) {
        if (e.type === 'tank' && e.state === 'attack' && e.def.attacks[e.attackIndex]!.usesSlot) melee++;
      }
      maxHeavyMelee = Math.max(maxHeavyMelee, melee);
      expect(light.inUse).toBeLessThanOrEqual(ENEMY_AI.slots.pools.light);
      if (t < seconds(6) * DT) return;
      for (const e of h.manager.enemies) {
        if (e.type !== 'tank' || e.state !== 'active' || heavy.holds(e.id)) continue;
        waitDist += Math.hypot(e.position.x, e.position.z);
        waitSamples++;
      }
    });
    expect(maxHeavy).toBe(ENEMY_AI.slots.pools.heavy);
    expect(maxHeavyMelee).toBeLessThanOrEqual(ENEMY_AI.slots.pools.heavy);
    expect((attacks['tank.slam'] ?? 0) + (attacks['tank.swipe'] ?? 0)).toBeGreaterThan(0);
    expect(attacks['swarmer.bite'] ?? 0).toBeGreaterThan(0);
    // Charges of different tanks never start together.
    for (let i = 1; i < charges.length; i++) {
      expect(charges[i]! - charges[i - 1]!).toBeGreaterThanOrEqual(ENEMY_AI.attackSpacing.charge - 1e-9);
    }
    // Tanks without a token keep to the wait ring instead of walling the player in.
    expect(waitSamples).toBeGreaterThan(0);
    expect(waitDist / waitSamples).toBeGreaterThan(ENEMIES.tank.brute!.standoff + 2);
  });
});

describe('Stuck handling', () => {
  it('re-paths, then teleports a wedged enemy far from the player, but leaves the crowd near it alone', () => {
    const h = createEnemyHarness();
    const far = enemyById(h, h.manager.spawn('spitter', { x: 0, y: 0, z: -30 })!);
    const near = enemyById(h, h.manager.spawn('tank', { x: 4, y: 0, z: 0 })!);
    h.tick(seconds(ENEMIES.tank.emergeTime) + 2);
    h.nav.frozen.add(far.agent);
    h.nav.frozen.add(near.agent);
    const S = ENEMY_AI.stuck;
    h.tick(seconds(S.interval * (S.teleportAfter + 1)));
    expect(h.manager.stats.stuckRepaths).toBeGreaterThan(0);
    expect(h.manager.stats.stuckTeleports).toBe(1);
    expect(h.nav.frozen.has(far.agent)).toBe(false); // the teleport freed it
    expect(h.nav.frozen.has(near.agent)).toBe(true); // never touched
    expect(h.manager.stats.relocations).toBe(0);
  });
});

describe('No damage through walls', () => {
  // A 0.2 m wall between the player (origin) and the enemy; the enemy's agent is wedged in place
  // (FakeNav agents would walk through the wall).
  const thin = { center: { x: 0, y: 2, z: -1 }, size: { x: 8, y: 4, z: 0.2 } };

  for (const [type, z] of [
    ['swarmer', -1.6],
    ['spitter', -1.6],
    ['tank', -2.2],
  ] as const) {
    it(`a ${type} within reach behind a thin wall neither swings nor hits`, () => {
      const h = createEnemyHarness({ boxes: [thin] });
      const e = enemyById(h, h.manager.spawn(type, { x: 0, y: 0, z })!);
      const contact: string[] = [];
      h.events.on('enemy:attack', (a) => {
        const kind = ENEMIES[type].attacks.find((x) => x.id === a.attack)!.kind;
        if (kind === 'melee' || kind === 'slam') contact.push(a.attack);
      });
      h.tick(seconds(8), () => h.nav.frozen.add(e.agent));
      expect(Math.hypot(e.position.x, e.position.z)).toBeLessThan(ENEMIES[type].attacks[0]!.range);
      expect(contact).toEqual([]);
      expect(h.player.hits).toHaveLength(0);
    });
  }

  it('a sac burst does not splash through a wall', () => {
    const h = createEnemyHarness({ boxes: [thin] });
    const e = enemyById(h, h.manager.spawn('spitter', { x: 0, y: 0, z: -1.6 })!);
    h.tick(2);
    h.combat.dealDamage(e, info(1000, 'body'));
    h.tick(1);
    expect(h.byType('enemy:died')).toHaveLength(1);
    expect(h.player.hits).toHaveLength(0);
  });

  it('a spitter hugging a thin wall does not spit through it (its mouth pokes past the wall)', () => {
    const h = createEnemyHarness({ boxes: [thin], player: { x: 0, y: 0, z: 12 } });
    // Body axis 0.4 m (a nav radius) in front of the wall, facing it: the mouth socket sits
    // beyond the wall's far face.
    const e = enemyById(h, h.manager.spawn('spitter', { x: 0, y: 0, z: -1.5 })!);
    const mouth = new Vector3();
    h.tick(2);
    h.visuals.computeSocket('spitter', e.handle, 'mouth', mouth);
    expect(mouth.z).toBeGreaterThan(-0.9);
    h.tick(seconds(10), () => h.nav.frozen.add(e.agent));
    expect(h.manager.projectiles!.stats.fired).toBe(0);
    expect(h.player.hits).toHaveLength(0);
  });
});
