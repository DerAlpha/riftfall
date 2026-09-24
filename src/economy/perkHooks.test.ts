import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FakeTarget } from '../combat/testFakes';
import type { DamageInfo, DamageResult, Damageable } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { DamageElement, GameEvents, Vec3Like } from '../core/events';
import { PERK_TUNING } from '../defs/perks';
import { PlayerHealth } from '../player/PlayerHealth';
import { StatSystem } from '../stats/StatSystem';
import { blastFalloff, blastSize, missingFraction } from './perkHooks';
import { PerkSystem } from './PerkSystem';

const DT = 1 / 60;

/** Minimal combat world: a target list, sphere broadphase, a wall predicate for line of sight. */
class FakeCombat {
  readonly targets: Damageable[] = [];
  readonly dealt: { id: number; info: DamageInfo }[] = [];
  blocked = (_from: Vec3Like, _to: Vec3Like): boolean => false;
  queryRadius(center: Vec3Like, radius: number, out: Damageable[]): Damageable[] {
    out.length = 0;
    for (const t of this.targets) {
      const d = Math.hypot(
        t.boundsCenter.x - center.x,
        t.boundsCenter.y - center.y,
        t.boundsCenter.z - center.z,
      );
      if (t.alive && d <= radius + t.boundsRadius) out.push(t);
    }
    return out;
  }
  dealDamage(target: Damageable, info: DamageInfo): DamageResult {
    this.dealt.push({
      id: target.id,
      info: { ...info, point: { ...info.point }, direction: { ...info.direction } },
    });
    return target.applyDamage(info);
  }
  lineOfSight(from: Vec3Like, to: Vec3Like): boolean {
    return !this.blocked(from, to);
  }
}

function setup() {
  const events = new EventBus<GameEvents>();
  const stats = new StatSystem({ events });
  const combat = new FakeCombat();
  const player = { position: new Vector3(0, 0, 0) };
  const blasts: { radius: number; element: DamageElement; hook: string; y: number }[] = [];
  const drops: Vec3Like[] = [];
  const perks = new PerkSystem({
    events,
    stats,
    combat,
    player,
    seed: 'hooks',
    blastFx: (p, radius, element, hook) => blasts.push({ radius, element, hook, y: p.y }),
    dropAmmo: (p) => drops.push({ ...p }),
  });
  const tick = (seconds: number): void => {
    for (let t = 0; t < seconds; t += DT) perks.fixedUpdate(DT);
  };
  return { events, stats, combat, player, perks, blasts, drops, tick };
}

function ammo(events: EventBus<GameEvents>, mag: number, magSize = 30): void {
  events.emit('weapon:ammoChanged', { weaponId: 'rifle', mag, reserve: 100, magSize });
}

function reload(events: EventBus<GameEvents>, empty = false): void {
  events.emit('weapon:reloadStart', { weaponId: 'rifle', empty, duration: 1.5 });
}

function kill(events: EventBus<GameEvents>, source: 'player' | 'enemy' = 'player'): void {
  events.emit('combat:kill', {
    targetId: 1,
    zone: 'body',
    weaponId: 'rifle',
    position: { x: 0, y: 0, z: 0 },
    source,
  });
}

describe('perk blast math', () => {
  it('size scales with strength, falloff is full inside the inner radius', () => {
    const def = PERK_TUNING.nova;
    const out = { radius: 0, damage: 0 };
    blastSize(def, 0, out);
    expect(out).toEqual({ radius: def.radius.min, damage: def.damage.min });
    blastSize(def, 1, out);
    expect(out).toEqual({ radius: def.radius.max, damage: def.damage.max });
    blastSize(def, 7, out);
    expect(out.radius).toBe(def.radius.max);
    expect(blastFalloff(def, 0, 4)).toBe(1);
    expect(blastFalloff(def, 4 * def.innerFraction, 4)).toBe(1);
    expect(blastFalloff(def, 4, 4)).toBeCloseTo(def.minFalloff);
    expect(blastFalloff(def, 4.01, 4)).toBe(0);
    expect(missingFraction(0, 30)).toBe(1);
    expect(missingFraction(15, 30)).toBe(0.5);
    expect(missingFraction(31, 30)).toBe(0);
    expect(missingFraction(0, 0)).toBe(1);
  });
});

describe('Nova-Schock', () => {
  it('a reload shocks nearby enemies, stronger the emptier the magazine, with a cooldown', () => {
    const t = setup();
    const near = new FakeTarget({ x: 1.5, y: 0, z: 0 }, 10_000);
    const far = new FakeTarget({ x: 0, y: 0, z: 20 }, 10_000);
    const friend = new FakeTarget({ x: -1, y: 0, z: 0 }, 10_000);
    Object.defineProperty(friend, 'team', { value: 'player' });
    t.combat.targets.push(near, far, friend);
    t.perks.grant('nova');
    ammo(t.events, 27);
    reload(t.events);
    expect(t.combat.dealt).toHaveLength(1);
    const weak = t.combat.dealt[0]!.info;
    expect(weak).toMatchObject({
      source: 'player',
      element: 'shock',
      kind: 'explosion',
      weaponId: 'perk.nova',
    });
    expect(t.blasts[0]).toMatchObject({ hook: 'nova', element: 'shock' });
    expect(t.blasts[0]!.y).toBeCloseTo(PERK_TUNING.nova.fxHeight);
    // Cooldown: an immediate second reload does nothing.
    reload(t.events, true);
    expect(t.combat.dealt).toHaveLength(1);
    t.tick(PERK_TUNING.nova.cooldown + 0.1);
    reload(t.events, true);
    expect(t.combat.dealt).toHaveLength(2);
    const strong = t.combat.dealt[1]!.info;
    expect(strong.amount).toBeGreaterThan(weak.amount * 2);
    expect(t.blasts[1]!.radius).toBeCloseTo(PERK_TUNING.nova.radius.max);
    // Walls block the shock.
    t.combat.blocked = () => true;
    t.tick(PERK_TUNING.nova.cooldown + 0.1);
    reload(t.events, true);
    expect(t.combat.dealt).toHaveLength(2);
    // Revoked: reloads are plain reloads again.
    t.combat.blocked = () => false;
    t.perks.revoke('nova');
    t.tick(PERK_TUNING.nova.cooldown + 0.1);
    reload(t.events, true);
    expect(t.combat.dealt).toHaveLength(2);
  });
});

describe('Kinetikpanzer', () => {
  function land(events: EventBus<GameEvents>, impactSpeed: number): void {
    events.emit('player:land', {
      impactSpeed,
      heavy: impactSpeed >= 12,
      position: { x: 0, y: 0, z: 0 },
      surface: 'metal',
    });
  }

  it('immune to explosion and fall damage; hard landings release a shock wave', () => {
    const t = setup();
    t.perks.grant('kinetic');
    expect(t.stats.value('explosionDamageTaken')).toBe(0);
    expect(t.stats.value('fallDamageTaken')).toBe(0);
    const target = new FakeTarget({ x: 2, y: 0, z: 0 }, 10_000);
    t.combat.targets.push(target);
    land(t.events, PERK_TUNING.kinetic.minImpactSpeed - 1);
    expect(t.combat.dealt).toHaveLength(0);
    land(t.events, PERK_TUNING.kinetic.fullImpactSpeed);
    expect(t.combat.dealt).toHaveLength(1);
    expect(t.combat.dealt[0]!.info.amount).toBeCloseTo(PERK_TUNING.kinetic.damage.max);
    expect(t.blasts[0]!.radius).toBeCloseTo(PERK_TUNING.kinetic.radius.max);
    land(t.events, PERK_TUNING.kinetic.fullImpactSpeed);
    expect(t.combat.dealt).toHaveLength(1);
  });
});

describe('Aasgeier', () => {
  function died(events: EventBus<GameEvents>, source: 'player' | 'enemy' = 'player'): void {
    events.emit('enemy:died', {
      id: 3,
      type: 'swarmer',
      position: { x: 4, y: 0, z: 2 },
      weaponId: 'rifle',
      zone: 'body',
      elite: false,
      source,
    });
  }

  it('player kills sometimes call the ammo drop hook (seeded, cooldown between drops)', () => {
    const t = setup();
    t.perks.grant('scavenger');
    const kills = 400;
    for (let i = 0; i < kills; i++) {
      died(t.events);
      t.tick(0.1);
    }
    const chance = PERK_TUNING.scavenger.chance * t.stats.value('dropChance');
    expect(t.drops.length).toBeGreaterThan(0);
    // The cooldown swallows some rolls: fewer than chance × kills, but in that ballpark.
    expect(t.drops.length).toBeLessThanOrEqual(kills * chance * 1.5);
    expect(t.drops[0]).toEqual({ x: 4, y: 0, z: 2 });
    const n = t.drops.length;
    for (let i = 0; i < 100; i++) died(t.events, 'enemy');
    expect(t.drops.length).toBe(n);
  });

  it('without a drop handler it only raises the drop chance', () => {
    const events = new EventBus<GameEvents>();
    const stats = new StatSystem({ events });
    const perks = new PerkSystem({ events, stats });
    perks.grant('scavenger');
    expect(stats.value('dropChance')).toBeCloseTo(1.15);
    for (let i = 0; i < 50; i++) died(events);
    const drops: Vec3Like[] = [];
    perks.setAmmoDropHandler((p) => drops.push({ ...p }));
    for (let i = 0; i < 200; i++) {
      died(events);
      for (let k = 0; k < 120; k++) perks.fixedUpdate(DT);
    }
    expect(drops.length).toBeGreaterThan(0);
  });
});

describe('Adrenalinschub', () => {
  it('kills stack move speed up to the cap; stacks decay one by one', () => {
    const t = setup();
    const a = PERK_TUNING.adrenaline;
    t.perks.grant('adrenaline');
    kill(t.events);
    expect(t.stats.value('moveSpeed')).toBeCloseTo(1 + a.perStack);
    kill(t.events, 'enemy');
    expect(t.stats.value('moveSpeed')).toBeCloseTo(1 + a.perStack);
    for (let i = 0; i < a.maxStacks + 3; i++) kill(t.events);
    expect(t.stats.value('moveSpeed')).toBeCloseTo(1 + a.perStack * a.maxStacks);
    t.tick(a.duration - 0.1);
    expect(t.stats.value('moveSpeed')).toBeCloseTo(1 + a.perStack * a.maxStacks);
    t.tick(0.2);
    expect(t.stats.value('moveSpeed')).toBeCloseTo(1 + a.perStack * (a.maxStacks - 1));
    t.tick(a.decayInterval * a.maxStacks + 0.1);
    expect(t.stats.value('moveSpeed')).toBe(1);
    expect(t.stats.hasSource('perk:adrenaline:buff')).toBe(false);
  });

  it('works on top of other move speed modifiers and leaves them intact', () => {
    const t = setup();
    t.perks.grant('sprinter');
    t.perks.grant('adrenaline');
    kill(t.events);
    expect(t.stats.value('moveSpeed')).toBeCloseTo(1.08 * (1 + PERK_TUNING.adrenaline.perStack));
    t.perks.revoke('adrenaline');
    expect(t.stats.value('moveSpeed')).toBeCloseTo(1.08);
  });
});

describe('Phoenix-Protokoll', () => {
  it('the revive it pays for bursts out: nearby enemies are burnt and thrown back', () => {
    const t = setup();
    const health = new PlayerHealth({ events: t.events });
    health.setStats(t.stats);
    const near = new FakeTarget({ x: 1.2, y: 0, z: 0 }, 10_000);
    const far = new FakeTarget({ x: 0, y: 0, z: 30 }, 10_000);
    t.combat.targets.push(near, far);
    t.perks.grant('phoenix');
    health.damage(10_000);
    expect(health.dead).toBe(false);
    expect(t.perks.has('phoenix')).toBe(false);
    // Not inside the enemy attack that caused the revive: on the next perk tick.
    expect(t.combat.dealt).toHaveLength(0);
    t.perks.fixedUpdate(DT);
    expect(t.combat.dealt.map((d) => d.id)).toEqual([near.id]);
    const info = t.combat.dealt[0]!.info;
    expect(info).toMatchObject({ source: 'player', element: 'fire', kind: 'explosion', weaponId: 'perk.phoenix' });
    expect(info.amount).toBeGreaterThan(0);
    expect(info.impulse).toBeGreaterThan(0);
    // Pushed away from the player.
    expect(info.direction.x).toBeGreaterThan(0);
    expect(t.blasts).toEqual([expect.objectContaining({ hook: 'phoenix', element: 'fire' })]);
    // Once: the perk is gone.
    t.tick(1);
    expect(t.blasts).toHaveLength(1);
  });

  it('a new run drops a burst that has not gone off yet', () => {
    const t = setup();
    const health = new PlayerHealth({ events: t.events });
    health.setStats(t.stats);
    t.combat.targets.push(new FakeTarget({ x: 1, y: 0, z: 0 }, 10_000));
    t.perks.grant('phoenix');
    health.damage(10_000);
    t.perks.clear();
    t.perks.fixedUpdate(DT);
    expect(t.combat.dealt).toHaveLength(0);
  });

  it('a revive charge from elsewhere (no Phoenix owned) bursts nothing', () => {
    const t = setup();
    const health = new PlayerHealth({ events: t.events });
    health.setStats(t.stats);
    t.stats.addModifier({ source: 'skill:secondWind', stat: 'reviveCharges', op: 'add', value: 1 });
    t.combat.targets.push(new FakeTarget({ x: 1, y: 0, z: 0 }, 10_000));
    health.damage(10_000);
    expect(health.dead).toBe(false);
    t.tick(0.5);
    expect(t.combat.dealt).toHaveLength(0);
    expect(t.blasts).toHaveLength(0);
  });
});
