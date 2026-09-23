import { describe, expect, it } from 'vitest';
import {
  ENEMIES,
  ENEMY_AI,
  PROJECTILES,
  getEnemyAttackDef,
  getEnemyDef,
  getProjectileDef,
  type EnemyTypeDef,
} from './enemies';
import { NAV } from './nav';
import { getEnemyVisualDef } from './enemyVisuals';
import { getBrain } from '../enemies/ai/brains';

const types = Object.values(ENEMIES) as EnemyTypeDef[];

describe('ENEMIES defs', () => {
  it('ids match their keys, lookups are safe', () => {
    for (const [key, def] of Object.entries(ENEMIES)) expect(def.id).toBe(key);
    expect(getEnemyDef('swarmer')).toBe(ENEMIES.swarmer);
    expect(getEnemyDef('toString')).toBeUndefined();
    expect(getProjectileDef('constructor')).toBeUndefined();
    expect(getEnemyAttackDef('tank', 'charge')?.kind).toBe('charge');
    expect(getEnemyAttackDef('tank', 'nope')).toBeUndefined();
    expect(getEnemyAttackDef('nope', 'bite')).toBeUndefined();
  });

  it('spec stats: swarmer 60 HP / 7 m/s, spitter 110 HP, tank 900 HP; zones', () => {
    expect(ENEMIES.swarmer.health).toBe(60);
    expect(ENEMIES.swarmer.movement.runSpeed).toBe(7);
    expect(ENEMIES.spitter.health).toBe(110);
    expect(ENEMIES.tank.health).toBe(900);
    expect(ENEMIES.swarmer.zoneMultipliers.head).toBe(2);
    expect(ENEMIES.spitter.zoneMultipliers.weakpoint).toBe(2.5);
    expect(ENEMIES.tank.zoneMultipliers.shield).toBe(0.3);
    expect(ENEMIES.tank.zoneMultipliers.weakpoint).toBe(3);
    expect(ENEMIES.spitter.death.burst).not.toBeNull();
  });

  it('every type has a brain, its behaviour block and a visual def with matching attack anims', () => {
    for (const def of types) {
      expect(getBrain(def.brain), def.id).toBeDefined();
      if (def.brain === 'swarm') expect(def.swarm, def.id).toBeDefined();
      if (def.brain === 'ranged') expect(def.ranged, def.id).toBeDefined();
      if (def.brain === 'brute') expect(def.brute, def.id).toBeDefined();
      const vis = getEnemyVisualDef(def.id);
      expect(vis, def.id).toBeDefined();
      const animIds = new Set(vis!.attacks.map((a) => a.id));
      for (const a of def.attacks) expect(animIds.has(a.id), `${def.id}.${a.id}`).toBe(true);
      expect(vis!.sockets[def.perception.eyeSocket], `${def.id} eye socket`).toBeDefined();
      if (def.death.burst) expect(vis!.sockets[def.death.burst.socket]).toBeDefined();
    }
  });

  it('attacks carry the parameters of their kind and sane timings', () => {
    for (const def of types) {
      const ids = new Set<string>();
      for (const a of def.attacks) {
        const tag = `${def.id}.${a.id}`;
        expect(ids.has(a.id), tag).toBe(false);
        ids.add(a.id);
        expect(a.windup, tag).toBeGreaterThan(0);
        expect(a.strike, tag).toBeGreaterThan(0);
        expect(a.recover, tag).toBeGreaterThanOrEqual(0);
        expect(a.range, tag).toBeGreaterThanOrEqual(a.minRange);
        expect(a.cooldown, tag).toBeGreaterThanOrEqual(a.windup);
        switch (a.kind) {
          case 'melee':
            expect(a.melee, tag).toBeDefined();
            // Starting range must be reachable at the strike (else it always whiffs).
            expect(a.melee!.reach + ENEMY_AI.player.radius, tag).toBeGreaterThanOrEqual(a.range);
            break;
          case 'leap':
            expect(a.leap, tag).toBeDefined();
            break;
          case 'charge':
            expect(a.charge, tag).toBeDefined();
            break;
          case 'slam':
            expect(a.slam, tag).toBeDefined();
            break;
          case 'projectile':
            expect(a.projectile, tag).toBeDefined();
            expect(getProjectileDef(a.projectile!.projectile), tag).toBeDefined();
            break;
        }
        const vis = getEnemyVisualDef(def.id)!;
        if (a.slam) expect(vis.sockets[a.slam.socket], tag).toBeDefined();
        if (a.projectile) expect(vis.sockets[a.projectile.socket], tag).toBeDefined();
      }
    }
  });

  it('nav agents fit the crowd, ranged bands are ordered, fairness knobs are bounded', () => {
    for (const def of types) {
      expect(def.nav.radius).toBeLessThanOrEqual(NAV.crowd.maxAgentRadius);
      expect(def.movement.walkSpeed).toBeLessThanOrEqual(def.movement.runSpeed);
      expect(def.knockbackResistance).toBeGreaterThanOrEqual(0);
      expect(def.knockbackResistance).toBeLessThanOrEqual(1);
      expect(def.slotCost).toBeLessThanOrEqual(ENEMY_AI.slots.maxTokens);
      if (def.ranged) {
        const R = def.ranged;
        expect(R.bandMin).toBeLessThan(R.bandPreferred);
        expect(R.bandPreferred).toBeLessThan(R.bandMax);
        const spit = def.attacks.find((a) => a.kind === 'projectile');
        if (spit) expect(spit.range).toBeGreaterThanOrEqual(R.bandMax);
      }
      if (def.death.burst?.puddle) expect(getProjectileDef(def.death.burst.puddle)?.puddle).toBeTruthy();
    }
    expect(ENEMY_AI.capacity).toBeLessThanOrEqual(NAV.crowd.maxAgents);
    for (const p of Object.values(PROJECTILES)) {
      expect(p.minFlightTime).toBeLessThanOrEqual(p.maxFlightTime);
      expect(p.splash.innerRadius).toBeLessThanOrEqual(p.splash.radius);
      // Blobs are HDR emissive (bloom threshold ~1).
      expect(Math.max(...p.visual.color) * p.visual.intensity).toBeGreaterThan(1.5);
    }
  });
});
