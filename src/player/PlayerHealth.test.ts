import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { PLAYER, type PlayerHealthDef } from '../defs/player';
import {
  PlayerHealth,
  applyDamage,
  regenerate,
  splitDamage,
  type DamageSplit,
  type HealthState,
} from './PlayerHealth';

const DEF: PlayerHealthDef = {
  maxHealth: 100,
  maxArmor: 100,
  startHealth: 100,
  startArmor: 50,
  regenDelay: 4,
  regenRate: 20,
  regenCapFraction: 1,
  armorAbsorb: 0.6,
};
const DT = 1 / 60;

describe('health pure logic', () => {
  it('armor absorbs its fraction while it lasts', () => {
    const out: DamageSplit = { toHealth: 0, toArmor: 0 };
    splitDamage({ health: 100, armor: 50, sinceDamage: 0 }, 20, DEF, out);
    expect(out.toArmor).toBeCloseTo(12);
    expect(out.toHealth).toBeCloseTo(8);
    // Armor runs out: the rest goes to health.
    splitDamage({ health: 100, armor: 5, sinceDamage: 0 }, 20, DEF, out);
    expect(out.toArmor).toBe(5);
    expect(out.toHealth).toBe(15);
    // Never below zero, never negative damage.
    splitDamage({ health: 10, armor: 0, sinceDamage: 0 }, 50, DEF, out);
    expect(out.toHealth).toBe(10);
    splitDamage({ health: 10, armor: 10, sinceDamage: 0 }, -5, DEF, out);
    expect(out).toEqual({ toHealth: 0, toArmor: 0 });
    splitDamage({ health: 10, armor: 10, sinceDamage: 0 }, Number.NaN, DEF, out);
    expect(out).toEqual({ toHealth: 0, toArmor: 0 });
  });

  it('applyDamage mutates state and resets the regen timer', () => {
    const s: HealthState = { health: 100, armor: 0, sinceDamage: 10 };
    applyDamage(s, 30, DEF, { toHealth: 0, toArmor: 0 });
    expect(s.health).toBe(70);
    expect(s.sinceDamage).toBe(0);
  });

  it('regenerates only after the delay, up to the cap, never when dead', () => {
    const s: HealthState = { health: 50, armor: 0, sinceDamage: 0 };
    let t = 0;
    while (t < DEF.regenDelay - 0.1) {
      expect(regenerate(s, DEF, DT)).toBe(0);
      t += DT;
    }
    for (let i = 0; i < 60; i++) regenerate(s, DEF, DT);
    expect(s.health).toBeGreaterThan(50);
    for (let i = 0; i < 600; i++) regenerate(s, DEF, DT);
    expect(s.health).toBe(DEF.maxHealth);
    const capped = { ...DEF, regenCapFraction: 0.5 };
    const c: HealthState = { health: 10, armor: 0, sinceDamage: 100 };
    for (let i = 0; i < 600; i++) regenerate(c, capped, DT);
    expect(c.health).toBe(50);
    const dead: HealthState = { health: 0, armor: 0, sinceDamage: 100 };
    expect(regenerate(dead, DEF, 1)).toBe(0);
    expect(dead.health).toBe(0);
  });
});

describe('PlayerHealth', () => {
  function setup(player?: { godMode: boolean }) {
    const events = new EventBus<GameEvents>();
    const damaged: GameEvents['player:damaged'][] = [];
    const changed: GameEvents['player:healthChanged'][] = [];
    events.on('player:damaged', (e) => damaged.push({ ...e }));
    events.on('player:healthChanged', (e) => changed.push({ ...e }));
    const h = new PlayerHealth({ events, player }, DEF);
    return { h, damaged, changed };
  }

  it('emits damaged + healthChanged', () => {
    const { h, damaged, changed } = setup();
    const dir = { x: 1, y: 0, z: 0 };
    expect(h.damage(20, dir)).toBeCloseTo(20);
    expect(damaged).toHaveLength(1);
    expect(damaged[0]!.amount).toBeCloseTo(20);
    expect(damaged[0]!.healthFraction).toBeCloseTo(0.92);
    expect(damaged[0]!.direction).toEqual(dir);
    expect(changed.at(-1)).toMatchObject({ health: 92, maxHealth: 100, maxArmor: 100 });
    expect(h.armor).toBeCloseTo(38);
  });

  it('respects god mode from the player and locally', () => {
    const player = { godMode: true };
    const { h, damaged } = setup(player);
    expect(h.damage(50)).toBe(0);
    expect(h.health).toBe(100);
    expect(damaged).toHaveLength(0);
    player.godMode = false;
    h.godMode = true;
    expect(h.damage(50)).toBe(0);
    h.godMode = false;
    expect(h.damage(50)).toBeGreaterThan(0);
  });

  it('dies at zero, ignores further damage and does not regenerate', () => {
    const { h } = setup();
    h.damage(1000);
    expect(h.dead).toBe(true);
    expect(h.health).toBe(0);
    expect(h.damage(10)).toBe(0);
    for (let i = 0; i < 600; i++) h.fixedUpdate(DT);
    expect(h.health).toBe(0);
    expect(h.heal(50)).toBe(0);
    h.reset();
    expect(h.health).toBe(DEF.startHealth);
    expect(h.armor).toBe(DEF.startArmor);
  });

  it('regen announces whole-point changes only', () => {
    const { h, changed } = setup();
    h.damage(100); // 60 armor absorbs 50 max -> health 50
    const before = changed.length;
    const ticks = Math.ceil((DEF.regenDelay + 60 / DEF.regenRate) / DT) + 5;
    for (let i = 0; i < ticks; i++) h.fixedUpdate(DT);
    expect(h.health).toBe(DEF.maxHealth);
    const regenEvents = changed.length - before;
    // ~50 points regenerated -> about 50 events, far fewer than the tick count.
    expect(regenEvents).toBeGreaterThan(40);
    expect(regenEvents).toBeLessThan(60);
    expect(changed.at(-1)!.health).toBe(DEF.maxHealth);
  });

  it('heal and armor pickups clamp to max', () => {
    const { h } = setup();
    h.damage(30);
    expect(h.heal(1000)).toBeGreaterThan(0);
    expect(h.health).toBe(100);
    expect(h.addArmor(1000)).toBeGreaterThan(0);
    expect(h.armor).toBe(100);
  });

  it('uses the shipped defaults and accepts the bare event bus', () => {
    const events = new EventBus<GameEvents>();
    const h = new PlayerHealth({ events });
    expect(h.maxHealth).toBe(PLAYER.health.maxHealth);
    expect(h.health).toBe(PLAYER.health.startHealth);
    const seen: number[] = [];
    events.on('player:healthChanged', (e) => seen.push(e.health));
    const bare = new PlayerHealth(events);
    bare.announce();
    expect(seen).toEqual([PLAYER.health.startHealth]);
    bare.damage(10);
    expect(bare.health).toBeLessThan(PLAYER.health.startHealth);
  });
});
