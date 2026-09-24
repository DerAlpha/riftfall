/**
 * Economy pacing guard (CoD Zombies feel on the research lab): a steady player with the starting
 * pistol (70 % body kills, 30 % head/weakpoint kills, every hit lands, no repairs) earns per the
 * real wave formula, enemy health curve, enemy point tables and weapon damage, and shops greedily
 * after every wave – the cheapest closed door, the box once (from wave 3), a first perk (from
 * wave 4). Waves 1–10 must allow about one door per wave, the box around wave 3–4 and the first
 * perk around wave 4–6. A price or reward change that breaks that rhythm fails here.
 */
import { describe, expect, it } from 'vitest';
import type { HitZone } from '../core/events';
import { ECONOMY, doorCost, waveBonus } from '../defs/economy';
import { getEnemyDef } from '../defs/enemies';
import { LAB_LAYOUT } from '../defs/labLayout';
import { PERKS } from '../defs/perks';
import { WAVES } from '../defs/waves';
import { WEAPONS } from '../defs/weapons';
import { enemyDamageAmount } from '../enemies/Enemy';
import { createWavePlan, planWave, waveMultiplier } from '../spawning/waveFormula';
import { killPoints } from './PointsRules';

const MODE = WAVES.classic;
const HEAD_KILL_SHARE = 0.3;
const WAVES_CHECKED = 10;

/** Points for killing one `type` on `wave` with the pistol, aiming at `zone` every shot. */
function pointsPerKill(type: string, wave: number, zone: HitZone): number {
  const def = getEnemyDef(type)!;
  const w = WEAPONS.pistol.damage;
  const weaponZone = zone === 'head' ? w.headMultiplier : zone === 'weakpoint' ? w.weakpointMultiplier : 1;
  const perShot = enemyDamageAmount(def, zone, w.base * weaponZone, 'physical');
  const hits = Math.max(1, Math.ceil((def.health * waveMultiplier(MODE.health, wave)) / perShot));
  return (hits - 1) * def.points.hit + killPoints(zone, false, def.points);
}

/** Points earned in `wave` (kills + wave bonus). */
function waveIncome(wave: number): number {
  const plan = planWave(MODE, wave, MODE.maxAlive.max, createWavePlan(MODE));
  let pts = 0;
  for (let i = 0; i < plan.typeIds.length; i++) {
    const n = plan.counts[i]!;
    if (n <= 0) continue;
    const type = plan.typeIds[i]!;
    // Tanks are shot in their weakpoint core, everything else in the head.
    const precise = type === 'tank' ? 'weakpoint' : 'head';
    pts +=
      n *
      ((1 - HEAD_KILL_SHARE) * pointsPerKill(type, wave, 'body') +
        HEAD_KILL_SHARE * pointsPerKill(type, wave, precise));
  }
  return Math.round(pts) + waveBonus(wave);
}

describe('economy pacing (research lab, waves 1–10)', () => {
  const doors = LAB_LAYOUT.doorways
    .filter((d) => d.slot)
    .map((d) => doorCost(d.costHint, d.blast === true))
    .sort((a, b) => a - b);
  const box = ECONOMY.costs.box;
  const perk = PERKS.titan.price;

  it('one door per wave, the box around wave 3–4, the first perk around wave 4–6', () => {
    let points: number = ECONOMY.startPoints;
    let opened = 0;
    let boxWave = 0;
    let perkWave = 0;
    const doorsByWave: number[] = [];
    for (let wave = 1; wave <= WAVES_CHECKED; wave++) {
      points += waveIncome(wave);
      if (opened < doors.length && points >= doors[opened]!) points -= doors[opened++]!;
      if (!boxWave && wave >= 3 && points >= box) {
        points -= box;
        boxWave = wave;
      }
      if (!perkWave && wave >= 4 && points >= perk) {
        points -= perk;
        perkWave = wave;
      }
      doorsByWave.push(opened);
    }
    // A door after every wave until the lab is open.
    for (let wave = 1; wave <= WAVES_CHECKED; wave++) {
      expect(doorsByWave[wave - 1], `doors after wave ${wave}`).toBe(Math.min(wave, doors.length));
    }
    expect(boxWave).toBeGreaterThanOrEqual(3);
    expect(boxWave).toBeLessThanOrEqual(4);
    expect(perkWave).toBeGreaterThanOrEqual(4);
    expect(perkWave).toBeLessThanOrEqual(6);
  });

  it('no early windfall: after wave 2 the first doors, box and a perk are out of reach', () => {
    const earned = ECONOMY.startPoints + waveIncome(1) + waveIncome(2);
    expect(earned).toBeLessThan(doors[0]! + doors[1]! + box + perk);
    // …but the start points plus wave 1 open the first door.
    expect(ECONOMY.startPoints + waveIncome(1)).toBeGreaterThanOrEqual(doors[0]!);
  });

  it('bigger enemies pay more per kill', () => {
    const wave = 5;
    const swarmer = pointsPerKill('swarmer', wave, 'body');
    const spitter = pointsPerKill('spitter', wave, 'body');
    const tank = pointsPerKill('tank', wave, 'body');
    expect(spitter).toBeGreaterThan(swarmer);
    expect(tank).toBeGreaterThan(spitter);
  });
});
