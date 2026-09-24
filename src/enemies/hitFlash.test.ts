import { describe, expect, it } from 'vitest';
import type { DamageInfo, ImpactKind } from '../core/contracts';
import { ENEMY_AI } from '../defs/enemies';
import type { Enemy } from './Enemy';
import { DT, createEnemyHarness } from './testFakes';

function info(kind: ImpactKind, amount = 0.5, sustained?: boolean): DamageInfo {
  return {
    ...(sustained === undefined ? {} : { sustained }),
    amount,
    zone: 'body',
    point: { x: 0, y: 1, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    weaponId: 'flamethrower',
    element: 'fire',
    source: 'player',
    kind,
  };
}

/** Hits `e` with `kind` at `rate` Hz for `seconds`; returns the mean and peak hit flash per tick. */
function sustained(kind: ImpactKind, rate: number, seconds: number, flag?: boolean) {
  const h = createEnemyHarness();
  const id = h.manager.spawn('tank', { x: 0, y: 0, z: -10 })!;
  const e = h.manager.enemies.find((x) => x.id === id) as Enemy;
  h.tick(Math.round(2 / DT));
  h.manager.aiEnabled = false;
  const ticks = Math.round(seconds / DT);
  const every = 1 / rate;
  let clock = every;
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < ticks; i++) {
    clock += DT;
    if (clock >= every - 1e-9) {
      clock -= every;
      h.combat.dealDamage(e, info(kind, 0.5, flag));
      peak = Math.max(peak, e.pose.hitFlash);
    }
    h.tick(1);
    sum += e.pose.hitFlash;
  }
  return { mean: sum / ticks, peak, alive: e.alive };
}

describe('enemy hit flash under sustained damage', () => {
  it('a 12 Hz beam (flamethrower) keeps the flash low and rate-limited instead of white-hot', () => {
    const beam = sustained('beam', 12, 2);
    expect(beam.alive).toBe(true);
    expect(beam.peak).toBeLessThanOrEqual(ENEMY_AI.pose.sustainedFlash.peak + 1e-6);
    // Before: the flash reset to 1 every 83 ms and averaged ~0.6 (a white body over the burn rim).
    expect(beam.mean).toBeLessThan(0.08);
    expect(beam.mean).toBeGreaterThan(0); // still readable feedback
  });

  it('4 Hz field ticks (fire pool, singularity) do not strobe white-hot', () => {
    const field = sustained('explosion', 4, 2, true);
    expect(field.peak).toBeLessThanOrEqual(ENEMY_AI.pose.sustainedFlash.peak + 1e-6);
    expect(field.mean).toBeLessThan(0.08);
    // A one-off blast (no `sustained`) still flashes fully.
    expect(sustained('explosion', 1, 0.5).peak).toBe(1);
  });

  it('bullets keep the full white-hot flash', () => {
    const bullets = sustained('bullet', 10, 1);
    expect(bullets.peak).toBe(1);
  });

  it('a discrete hit on top of a beam still flashes fully', () => {
    const h = createEnemyHarness();
    const id = h.manager.spawn('tank', { x: 0, y: 0, z: -10 })!;
    const e = h.manager.enemies.find((x) => x.id === id) as Enemy;
    h.tick(Math.round(2 / DT));
    h.combat.dealDamage(e, info('beam'));
    expect(e.pose.hitFlash).toBeCloseTo(ENEMY_AI.pose.sustainedFlash.peak);
    h.combat.dealDamage(e, info('bullet'));
    expect(e.pose.hitFlash).toBe(1);
    h.combat.dealDamage(e, info('beam'));
    expect(e.pose.hitFlash).toBe(1); // never lowers a stronger flash
  });
});
