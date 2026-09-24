import { describe, expect, it } from 'vitest';
import type { DamageInfo } from '../../core/contracts';
import { ENEMIES, ENEMY_AI } from '../../defs/enemies';
import { Enemy, type EnemyOwner } from '../Enemy';
import { DT, createEnemyHarness } from '../testFakes';

const seconds = (s: number): number => Math.round(s / DT);

function hit(amount: number, source: DamageInfo['source'] = 'player'): DamageInfo {
  return {
    amount,
    zone: 'limb',
    point: { x: 0, y: 1, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    weaponId: 'pistol',
    element: 'physical',
    source,
    kind: 'bullet',
  };
}

/** Distance a freshly emerged swarmer covers towards a far player in `time` s at `scale`. */
function runDistance(scale: number, time: number): number {
  const h = createEnemyHarness({ player: { x: 0, y: 0, z: 60 } });
  const id = h.manager.spawn('swarmer', { x: 0, y: 0, z: -60 })!;
  const e = h.manager.enemies.find((x) => x.id === id)!;
  h.tick(seconds(ENEMIES.swarmer.emergeTime) + seconds(0.5));
  h.manager.timeScale = scale;
  const z0 = e.position.z;
  h.tick(seconds(time));
  return e.position.z - z0;
}

describe('Slow Motion: enemy time scale', () => {
  it('enemies move at 0.4× while the player-side tick stays real time', () => {
    const normal = runDistance(1, 1);
    const slow = runDistance(0.4, 1);
    expect(normal).toBeGreaterThan(3);
    expect(slow / normal).toBeCloseTo(0.4, 2);
  });

  it('slows the AI clock, attack wind-ups and emergence; reports wind-ups in game seconds', () => {
    const h = createEnemyHarness();
    h.manager.timeScale = 0.4;
    const id = h.manager.spawn('swarmer', { x: 0, y: 0, z: -20 })!;
    const e = h.manager.enemies.find((x) => x.id === id)!;
    h.tick(seconds(ENEMIES.swarmer.emergeTime));
    // Only 40 % of the emergence has passed.
    expect(e.state).toBe('emerge');
    expect(e.pose.emerge).toBeCloseTo(0.4, 1);
    expect(h.manager.time).toBeCloseTo(ENEMIES.swarmer.emergeTime * 0.4, 2);
    // Close enough to bite: the wind-up in the event is in game seconds (strike sound timing).
    h.player.setPosition(0, 0, -18.8);
    h.tick(seconds(8));
    const attacks = h.byType('enemy:attack') as { attack: string; windup: number }[];
    const bite = attacks.find((a) => a.attack === 'bite');
    expect(bite).toBeDefined();
    expect(bite!.windup).toBeCloseTo(ENEMIES.swarmer.attacks[0]!.windup / 0.4, 5);
  });

  it('clamps and restores', () => {
    const h = createEnemyHarness();
    h.manager.timeScale = 0;
    expect(h.manager.timeScale).toBe(ENEMY_AI.timeScale.min);
    h.manager.timeScale = Number.NaN;
    expect(h.manager.timeScale).toBe(1);
    h.manager.timeScale = 99;
    expect(h.manager.timeScale).toBe(ENEMY_AI.timeScale.max);
  });
});

describe('Instakill', () => {
  it('player hits kill at once while it is on; enemy / trap damage does not', () => {
    const h = createEnemyHarness();
    const tankId = h.manager.spawn('tank', { x: 0, y: 0, z: -10 });
    const otherId = h.manager.spawn('tank', { x: 4, y: 0, z: -10 });
    const tank = h.manager.enemies.find((x) => x.id === tankId)!;
    const other = h.manager.enemies.find((x) => x.id === otherId)!;
    h.tick(2);
    expect(h.combat.dealDamage(tank, hit(1)).killed).toBe(false);
    h.manager.instakill = true;
    expect(h.combat.dealDamage(other, hit(5, 'trap')).killed).toBe(false);
    const r = h.combat.dealDamage(tank, hit(1));
    expect(r.killed).toBe(true);
    expect(r.applied).toBeCloseTo(ENEMIES.tank.health - (ENEMIES.tank.zoneMultipliers.limb ?? 1));
    h.tick(1);
    const died = h.byType('enemy:died') as { source: string; weaponId: string }[];
    expect(died).toHaveLength(1);
    expect(died[0]).toMatchObject({ source: 'player', weaponId: 'pistol' });
    h.manager.instakill = false;
    expect(h.combat.dealDamage(other, hit(1)).killed).toBe(false);
  });

  it('bosses are immune to instakill and skipped by the nuke', () => {
    const owner: EnemyOwner = { onEnemyDamaged: () => {}, instakill: true };
    const boss = new Enemy({ ...ENEMIES.tank, boss: true }, new Float32Array(4), owner);
    boss.alive = true;
    boss.state = 'active';
    boss.maxHealth = boss.health = 1000;
    const res = boss.applyDamage(hit(10));
    expect(res.killed).toBe(false);
    expect(boss.health).toBeGreaterThan(990);
    const grunt = new Enemy(ENEMIES.swarmer, new Float32Array(4), owner);
    grunt.alive = true;
    grunt.state = 'active';
    grunt.maxHealth = grunt.health = 60;
    expect(grunt.applyDamage(hit(1)).killed).toBe(true);
  });
});
