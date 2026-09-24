import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { SpawnPointDef } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { ECONOMY } from '../defs/economy';
import { ENEMY_AI } from '../defs/enemies';
import { POWERUP_DEFS, POWERUPS } from '../defs/powerups';
import { EconomySystem } from '../economy/EconomySystem';
import { createEnemyHarness } from '../enemies/testFakes';
import { SealSystem } from '../seals/SealSystem';
import { StatSystem } from '../stats/StatSystem';
import type { DropRuleDef } from './dropRules';
import { blinkVisibility } from './pickupAnim';
import { PowerUpSystem, sourceOf, type PowerUpDeps } from './PowerUpSystem';

const DT = 1 / 60;
/** Every eligible kill drops (no cap, no spacing). */
const ALWAYS: DropRuleDef = {
  chance: 1,
  maxPerWave: 1e9,
  pity: { kills: 1e9, seconds: 1e9 },
  minSpacing: 0,
  noRepeat: true,
};

function setup(over: Partial<PowerUpDeps> = {}, events = new EventBus<GameEvents>()) {
  const stats = new StatSystem({ events });
  const economy = new EconomySystem({ events, stats }, 0);
  const player = { position: new Vector3() };
  const enemies = { killAll: (_credit: boolean) => 0, timeScale: 1, instakill: false, killAllCalls: 0 };
  enemies.killAll = (credit: boolean) => {
    enemies.killAllCalls++;
    return credit ? 3 : 0;
  };
  const refills: boolean[] = [];
  const scraps: number[] = [];
  const weapons = {
    refillAmmo: (fill?: boolean) => void refills.push(fill ?? false),
    addReserveFraction: (f: number) => void scraps.push(f),
  };
  const armor = { maxArmor: 100, added: 0, addArmor: (n: number) => (armor.added += n) };
  const tints: number[] = [];
  const log: { type: keyof GameEvents; payload: unknown }[] = [];
  for (const type of ['powerup:spawned', 'powerup:collected', 'powerup:expired'] as const) {
    events.on(type, (p) => log.push({ type, payload: JSON.parse(JSON.stringify(p)) }));
  }
  const sys = new PowerUpSystem({
    events,
    player,
    stats,
    economy,
    enemies,
    weapons,
    armor,
    fx: { timeTint: (t) => void tints.push(t) },
    seed: 'test',
    ...over,
  });
  const byType = (type: keyof GameEvents) => log.filter((l) => l.type === type).map((l) => l.payload);
  const died = (id: number, source: GameEvents['enemy:died']['source'] = 'player', weaponId = 'rifle') =>
    events.emit('enemy:died', {
      id,
      type: 'swarmer',
      position: { x: id, y: 0, z: 0 },
      weaponId,
      zone: 'body',
      elite: false,
      source,
    });
  const run = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      sys.fixedUpdate(DT);
      sys.update(DT);
    }
  };
  return {
    events,
    stats,
    economy,
    player,
    enemies,
    weapons,
    refills,
    scraps,
    armor,
    tints,
    sys,
    byType,
    died,
    run,
  };
}

describe('PowerUpSystem drops', () => {
  it('only player kills drop – not nuke kills, other sources or flagged (dev) enemies', () => {
    const t = setup({ rules: ALWAYS });
    t.died(1, 'environment');
    t.died(2, 'player', ENEMY_AI.nukeWeaponId);
    t.sys.flagNoDrop(3);
    t.died(3);
    expect(t.byType('powerup:spawned')).toHaveLength(0);
    t.died(4);
    const spawned = t.byType('powerup:spawned') as { type: string; position: { x: number } }[];
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.position.x).toBe(4);
    // The flag was consumed by the death: a later enemy with a recycled id drops again.
    t.died(3);
    expect(t.byType('powerup:spawned')).toHaveLength(2);
  });

  it('default rules: at most maxPerWave per wave, pity guarantees drops, deterministic per seed', () => {
    const drops = (seed: string): string[] => {
      const t = setup({ seed });
      t.events.emit('wave:start', { wave: 1, total: 300 });
      const types: string[] = [];
      t.events.on('powerup:spawned', (e) => void types.push(e.type));
      for (let i = 0; i < 300; i++) {
        t.died(i + 1);
        t.sys.fixedUpdate(1);
      }
      return types;
    };
    const a = drops('seed-a');
    // 300 kills over 300 s: pity alone gives far more than the cap.
    expect(a).toHaveLength(POWERUPS.drops.maxPerWave);
    for (let i = 1; i < a.length; i++) expect(a[i]).not.toBe(a[i - 1]);
    expect(drops('seed-a')).toEqual(a);

    const t = setup({ rules: { ...ALWAYS, chance: 0, pity: { kills: 12, seconds: 1e9 } } });
    const at: number[] = [];
    t.events.on('powerup:spawned', () => void at.push(t.sys.drops.dropsThisWave));
    for (let i = 1; i <= 36; i++) t.died(i);
    expect(at).toHaveLength(3);
    // Time-based pity (wave time only).
    const u = setup({ rules: { ...ALWAYS, chance: 0, pity: { kills: 1e9, seconds: 20 } } });
    u.sys.fixedUpdate(25);
    u.died(1);
    expect(u.byType('powerup:spawned')).toHaveLength(0);
    u.events.emit('wave:start', { wave: 1, total: 10 });
    u.sys.fixedUpdate(21);
    u.died(2);
    expect(u.byType('powerup:spawned')).toHaveLength(1);
  });

  it('carpenter only drops while a seal is damaged', () => {
    const events = new EventBus<GameEvents>();
    const seals = new SealSystem({
      events,
      spawnPoints: [{ id: 'r', position: new Vector3(), yaw: 0, zone: 'z', kind: 'rift' }],
    });
    const t = setup({ rules: ALWAYS, seals }, events);
    const types = new Set<string>();
    t.events.on('powerup:spawned', (e) => void types.add(e.type));
    for (let i = 1; i <= 300; i++) t.died(i);
    expect(types.has('carpenter')).toBe(false);
    seals.breakSeal('r', 1);
    for (let i = 301; i <= 600; i++) t.died(i);
    expect(types.has('carpenter')).toBe(true);
  });
});

describe('PowerUpSystem pickups', () => {
  it('are collected by walking into them and despawn after their lifetime', () => {
    const t = setup();
    t.sys.rollDrop({ x: 6, y: 0, z: 0 }, 'maxAmmo');
    expect(t.sys.pickupCount).toBe(1);
    t.run(0.5);
    expect(t.refills).toHaveLength(0);
    // Not while the player cannot collect (dead / dying).
    let can = false;
    const u = setup({ canCollect: () => can });
    u.sys.rollDrop({ x: 0, y: 0, z: 0 }, 'maxAmmo');
    u.run(0.2);
    expect(u.refills).toHaveLength(0);
    can = true;
    u.run(0.1);
    expect(u.refills).toEqual([true]);

    t.player.position.set(6 - POWERUPS.pickup.radius * 0.8, 0, 0.2);
    t.run(DT);
    expect(t.refills).toEqual([POWERUP_DEFS.maxAmmo!.effect.kind === 'maxAmmo']);
    expect(t.byType('powerup:collected')).toEqual([
      { type: 'maxAmmo', position: { x: 6, y: 0, z: 0 }, duration: 0 },
    ]);
    // The collect animation plays out, then the slot is free.
    expect(t.sys.pickupCount).toBe(0);
    t.run(POWERUPS.pickup.collectTime + 0.1);
    expect(t.sys.view).toBeNull();

    t.sys.rollDrop({ x: -8, y: 0, z: 0 }, 'nuke');
    t.run(POWERUPS.pickup.lifetime - 0.5);
    expect(t.sys.pickupCount).toBe(1);
    t.run(1);
    expect(t.sys.pickupCount).toBe(0);
    expect(t.sys.stats.despawned).toBe(1);
    expect(t.enemies.killAllCalls).toBe(0);
  });

  it('blink before despawning speeds up; reduced flashing pulses softly', () => {
    const L = POWERUPS.pickup.lifetime;
    const B = POWERUPS.pickup.blinkTime;
    expect(blinkVisibility(L - B - 0.1, L)).toBe(1);
    const flips = (from: number, to: number): number => {
      let n = 0;
      let last = blinkVisibility(from, L);
      for (let a = from; a < to; a += 0.005) {
        const v = blinkVisibility(a, L);
        if (v !== last) n++;
        last = v;
      }
      return n;
    };
    expect(flips(L - B, L - B + 1)).toBeLessThan(flips(L - 1, L));
    for (let a = L - B; a < L; a += 0.1) {
      const v = blinkVisibility(a, L, true);
      expect(v).toBeGreaterThan(0.05);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('snap to the floor below a drop point and pool the oldest when full', () => {
    const t = setup({
      capacity: 2,
      snapToFloor: (p, out) => {
        out.set(p.x, 0, p.z);
        return true;
      },
    });
    t.player.position.set(-50, 0, 0);
    t.sys.rollDrop({ x: 10, y: 1.4, z: 0 }, 'maxAmmo');
    const spawned = t.byType('powerup:spawned') as { position: { y: number } }[];
    expect(spawned[0]!.position.y).toBe(0);
    t.run(1);
    t.sys.rollDrop({ x: 20, y: 0, z: 0 }, 'nuke');
    t.sys.rollDrop({ x: 30, y: 0, z: 0 }, 'slowmo');
    expect(t.sys.pickupCount).toBe(2);
    // The oldest (maxAmmo at x=10) was replaced: walking there collects nothing.
    t.player.position.set(10, 0, 0);
    t.run(DT);
    expect(t.refills).toHaveLength(0);
    t.player.position.set(30, 0, 0);
    t.run(DT);
    expect(t.sys.isActive('slowmo')).toBe(true);
  });
});

describe('PowerUpSystem effects', () => {
  it('Double Points: ×2 on top of other modifiers, refresh resets the timer, expiry restores exactly', () => {
    const t = setup();
    t.stats.addModifier({ source: 'perk:test', stat: 'pointsMultiplier', op: 'mul', value: 1.5 });
    const before = t.stats.value('pointsMultiplier');
    expect(before).toBeCloseTo(1.5);
    const D = POWERUP_DEFS.doublePoints!.duration;
    t.sys.activate('doublePoints');
    expect(t.sys.isActive('doublePoints')).toBe(true);
    expect(t.stats.value('pointsMultiplier')).toBeCloseTo(3);
    expect(t.economy.earn(10, 'kill')).toBe(30);
    t.run(D * 0.5);
    expect(t.sys.remaining('doublePoints')).toBeCloseTo(D * 0.5, 1);
    t.sys.activate('doublePoints');
    // Refreshed to the full duration, not added.
    expect(t.sys.remaining('doublePoints')).toBeCloseTo(D, 5);
    expect(
      t.stats.modifiers('pointsMultiplier').filter((m) => m.source === sourceOf('doublePoints')),
    ).toHaveLength(1);
    t.run(D + 0.1);
    expect(t.sys.isActive('doublePoints')).toBe(false);
    expect(t.stats.value('pointsMultiplier')).toBe(before);
    expect(t.byType('powerup:expired')).toEqual([{ type: 'doublePoints' }]);
  });

  it('durations scale with the powerUpDuration stat', () => {
    const t = setup();
    t.stats.addModifier({ source: 'perk:x', stat: 'powerUpDuration', op: 'mul', value: 1.5 });
    t.sys.activate('instakill');
    const D = POWERUP_DEFS.instakill!.duration * 1.5;
    expect(t.sys.duration('instakill')).toBeCloseTo(D);
    const c = t.byType('powerup:collected') as { duration: number }[];
    expect(c[0]!.duration).toBeCloseTo(D);
  });

  it('Instakill and Slow Motion drive the enemy hooks and the screen tint', () => {
    const t = setup();
    t.sys.activate('instakill');
    expect(t.enemies.instakill).toBe(true);
    t.sys.activate('slowmo');
    expect(t.enemies.timeScale).toBe(0.4);
    expect(t.sys.activeTimed).toEqual(['instakill', 'slowmo']);
    t.run(POWERUPS.effects.tint.fadeIn + 0.1);
    expect(t.tints.at(-1)).toBe(1);
    t.run(POWERUP_DEFS.slowmo!.duration);
    expect(t.enemies.timeScale).toBe(1);
    expect(t.sys.isActive('slowmo')).toBe(false);
    t.run(POWERUPS.effects.tint.fadeOut + 0.1);
    expect(t.tints.at(-1)).toBe(0);
    t.run(POWERUP_DEFS.instakill!.duration);
    expect(t.enemies.instakill).toBe(false);
  });

  it('Nuke kills every enemy with credit, pays its bonus, and those kills drop nothing', () => {
    const h = createEnemyHarness();
    for (let i = 0; i < 4; i++) h.manager.spawn(i === 3 ? 'tank' : 'swarmer', { x: i * 2, y: 0, z: -10 });
    h.tick(3);
    const t = setup({ enemies: h.manager, rules: ALWAYS }, h.events);
    t.sys.rollDrop({ x: 0, y: 0, z: 0 }, 'nuke');
    t.run(DT);
    expect(h.manager.alive).toBe(0);
    const died = h.byType('enemy:died') as { source: string; weaponId: string }[];
    expect(died).toHaveLength(4);
    for (const d of died) expect(d).toMatchObject({ source: 'player', weaponId: ENEMY_AI.nukeWeaponId });
    expect(t.economy.points).toBe(ECONOMY.powerUps.nukeBonus);
    // Only the forced nuke pickup itself was ever spawned.
    expect(t.byType('powerup:spawned')).toHaveLength(1);
  });

  it('Carpenter restores every seal, refills armor and pays; Max Ammo refills', () => {
    const events = new EventBus<GameEvents>();
    const points: SpawnPointDef[] = [
      { id: 'a', position: new Vector3(0, 0, -10), yaw: 0, zone: 'z', kind: 'rift' },
      { id: 'b', position: new Vector3(10, 0, 0), yaw: 1, zone: 'z', kind: 'floor' },
    ];
    const seals = new SealSystem({ events, spawnPoints: points });
    const t = setup({ seals }, events);
    seals.breakSeal('a', 4);
    seals.breakSeal('b');
    expect(seals.brokenSegments).toBeGreaterThan(0);
    t.sys.activate('carpenter');
    expect(seals.brokenSegments).toBe(0);
    expect(t.armor.added).toBe(100);
    expect(t.economy.points).toBe(ECONOMY.powerUps.carpenterBonus);
    t.sys.activate('maxAmmo');
    expect(t.refills).toEqual([true]);
  });

  it('ammo scraps (Aasgeier hook) add a reserve fraction and do not count as drops', () => {
    const t = setup({ rules: ALWAYS });
    t.sys.dropAmmo({ x: 0, y: 0, z: 0 });
    expect(t.sys.stats.dropped).toBe(0);
    t.run(DT);
    expect(t.scraps).toEqual([POWERUP_DEFS.ammoScrap!.effect.kind === 'ammoScrap' ? 0.25 : -1]);
    // Weapons without a fractional refill: no scraps at all (never a full reserve refill).
    const u2: boolean[] = [];
    const u = setup({ weapons: { refillAmmo: (fill) => void u2.push(fill ?? false) } });
    u.sys.dropAmmo({ x: 0, y: 0, z: 0 });
    expect(u.sys.pickupCount).toBe(0);
    u.sys.activate('ammoScrap');
    expect(u2).toEqual([]);
  });

  it('a full pool: real drops replace scraps first, scraps never replace a real drop', () => {
    const t = setup({ capacity: 2 });
    t.player.position.set(-50, 0, 0);
    t.sys.rollDrop({ x: 10, y: 0, z: 0 }, 'nuke');
    t.sys.dropAmmo({ x: 20, y: 0, z: 0 });
    t.run(1);
    // Full: the scrap goes although the nuke is older.
    expect(t.sys.rollDrop({ x: 30, y: 0, z: 0 }, 'instakill')).toBeUndefined();
    const spawned = () => (t.byType('powerup:spawned') as { type: string }[]).map((e) => e.type);
    expect(spawned()).toEqual(['nuke', 'ammoScrap', 'instakill']);
    t.player.position.set(20, 0, 0);
    t.run(DT);
    expect(t.scraps).toEqual([]);
    t.player.position.set(10, 0, 0);
    t.run(DT);
    expect(t.enemies.killAllCalls).toBe(1);
    // The collected nuke's slot (implode animation) goes first, then only real drops remain:
    // a scrap finds no slot it may take.
    t.player.position.set(-50, 0, 0);
    t.sys.rollDrop({ x: 40, y: 0, z: 0 }, 'maxAmmo');
    expect(t.sys.pickupCount).toBe(2);
    expect(t.sys.spawn('ammoScrap', { x: 0, y: 0, z: 0 })).toBe(-1);
    expect(t.sys.pickupCount).toBe(2);
  });

  it('a nuke collected with the Aasgeier hook firing on its kills reports the pickup spot', () => {
    const h = createEnemyHarness();
    for (let i = 0; i < 3; i++) h.manager.spawn('swarmer', { x: i * 2, y: 0, z: -10 });
    h.tick(3);
    const t = setup({ enemies: h.manager, vfx: { spawn: () => 0 } }, h.events);
    // The perk hook spawns a scrap at every nuke kill (spawn() reuses its scratch position).
    h.events.on('enemy:died', (e) => t.sys.dropAmmo({ x: e.position.x, y: 0, z: e.position.z }));
    const points: { x: number; z: number }[] = [];
    h.events.on('economy:points', (e) => void points.push({ x: e.position!.x, z: e.position!.z }));
    t.player.position.set(-50, 0, 0);
    t.sys.rollDrop({ x: 7, y: 0, z: 3 }, 'nuke');
    t.player.position.set(7, 0, 3);
    t.run(DT);
    expect(h.manager.alive).toBe(0);
    expect(points).toEqual([{ x: 7, z: 3 }]);
    const collected = t.byType('powerup:collected') as { position: { x: number; z: number } }[];
    expect(collected[0]!.position).toMatchObject({ x: 7, z: 3 });
  });

  it('clear() ends every timed effect, removes pickups and resets the drop state', () => {
    const t = setup();
    const base = t.stats.value('pointsMultiplier');
    t.sys.activate('doublePoints');
    t.sys.activate('instakill');
    t.sys.activate('slowmo');
    t.sys.rollDrop({ x: 9, y: 0, z: 9 }, 'nuke');
    t.run(0.5);
    t.sys.clear();
    expect(t.stats.value('pointsMultiplier')).toBe(base);
    expect(t.stats.hasSource(sourceOf('doublePoints'))).toBe(false);
    expect(t.enemies.instakill).toBe(false);
    expect(t.enemies.timeScale).toBe(1);
    expect(t.tints.at(-1)).toBe(0);
    expect(t.sys.pickupCount).toBe(0);
    expect(t.sys.activeTimed).toEqual([]);
    expect(t.byType('powerup:expired')).toHaveLength(3);
    expect(t.sys.activate('bogus')).toBe(false);
    expect(t.sys.spawn('bogus', { x: 0, y: 0, z: 0 })).toBe(-1);
    t.sys.dispose();
    t.died(5);
    expect(t.sys.pickupCount).toBe(0);
  });
});
