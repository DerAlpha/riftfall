/**
 * PointsRules against the real EnemyManager + CombatWorld (enemies/testFakes harness): kill credit
 * per enemy kind (the Game wiring `rewardOf: id → enemies.getEnemy(id)?.def.points`) and console
 * spawns that pay nothing (enemyCommands `onSpawned` → flagNoReward).
 */
import { describe, expect, it } from 'vitest';
import type { DamageInfo, Damageable } from '../core/contracts';
import type { PointsReason } from '../core/events';
import { getEnemyDef } from '../defs/enemies';
import { createEnemyCommands } from '../enemies/enemyCommands';
import { createEnemyHarness } from '../enemies/testFakes';
import { StatSystem } from '../stats/StatSystem';
import { EconomySystem } from './EconomySystem';
import { PointsRules } from './PointsRules';

function rig() {
  const h = createEnemyHarness();
  const stats = new StatSystem({ events: h.events });
  const economy = new EconomySystem({ events: h.events, stats }, 0);
  const rules = new PointsRules({
    events: h.events,
    economy,
    rewardOf: (id) => h.manager.getEnemy(id)?.def.points ?? null,
  });
  const log: string[] = [];
  h.events.on('economy:points', (e) => log.push(`${e.reason}:${e.delta}`));
  const info = (amount: number, zone: DamageInfo['zone'] = 'body'): DamageInfo => ({
    amount,
    zone,
    point: { x: 0, y: 1, z: -5 },
    direction: { x: 0, y: 0, z: -1 },
    weaponId: 'rifle',
    element: 'physical',
    source: 'player',
    kind: 'bullet',
  });
  const enemy = (id: number): Damageable => h.manager.getEnemy(id)!;
  return { ...h, economy, rules, log, info, enemy };
}

describe('PointsRules with the enemy manager', () => {
  it('a tank pays its own kill value (not the swarmer default); hits pay per kind', () => {
    const r = rig();
    const tank = r.manager.spawn('tank', { x: 0, y: 0, z: -8 })!;
    const swarmer = r.manager.spawn('swarmer', { x: 3, y: 0, z: -8 })!;
    r.tick(2);
    r.combat.dealDamage(r.enemy(tank), r.info(10));
    r.combat.dealDamage(r.enemy(tank), r.info(1e6));
    r.combat.dealDamage(r.enemy(swarmer), r.info(1e6, 'head'));
    const tp = getEnemyDef('tank')!.points;
    const sp = getEnemyDef('swarmer')!.points;
    expect(r.log).toEqual([`hit:${tp.hit}`, `kill:${tp.kill}`, `headshot:${sp.kill + sp.headshotBonus}`]);
    // enemy:died (next enemy tick) pays nothing extra for non-elites.
    r.tick(1);
    expect(r.economy.points).toBe(tp.hit + tp.kill + sp.kill + sp.headshotBonus);
  });

  it('console spawns pay nothing (onSpawned flags them); wave spawns keep paying', async () => {
    const r = rig();
    const [cmd] = createEnemyCommands({
      manager: r.manager,
      player: () => ({ position: r.player.position, yaw: 0 }),
      onSpawned: (id) => r.rules.flagNoReward(id),
    });
    await cmd!.run(['spawn', 'swarmer', '2']);
    await cmd!.run(['elite', 'spitter']);
    r.tick(2);
    for (const e of [...r.manager.enemies]) {
      if (!e.alive) continue;
      r.combat.dealDamage(e, r.info(1));
      r.combat.dealDamage(e, r.info(1e6));
    }
    r.tick(2);
    expect(r.economy.points).toBe(0);
    const wave = r.manager.spawn('swarmer', { x: 0, y: 0, z: -6 })!;
    r.tick(2);
    r.combat.dealDamage(r.enemy(wave), r.info(1e6));
    expect(r.log.map((l) => l.split(':')[0] as PointsReason)).toEqual(['kill']);
  });
});
