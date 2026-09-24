/**
 * Stat consumption by the existing systems (WeaponSystem, PlayerController, PlayerHealth) with
 * their test fakes: identical behaviour without modifiers, the right scaling with them.
 */
import { describe, expect, it } from 'vitest';
import { CombatWorld } from '../combat/CombatWorld';
import { FakeTarget, buildTestLevel } from '../combat/testFakes';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { MOVEMENT } from '../defs/movement';
import { PLAYER, type PlayerHealthDef } from '../defs/player';
import { WEAPONS, type WeaponDef } from '../defs/weapons';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { PlayerController } from '../player/PlayerController';
import { PlayerHealth } from '../player/PlayerHealth';
import { FakeInput, fakeSettings } from '../player/testHelpers';
import { FakeCamera, FakePlayer, FakeWeaponInput, fakeRenderCamera } from '../weapons/testFakes';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { StatSystem } from './StatSystem';

const DT = 1 / 60;

/** Zero-spread variant (deterministic hits). */
function precise(def: WeaponDef): WeaponDef {
  return {
    ...def,
    spread: { ...def.spread, hip: 0, ads: 0, moveAdd: 0, airAdd: 0, perShotBloom: 0 },
    recoil: { ...def.recoil, randomYaw: 0, randomPitch: 0, pattern: [[0, 0]] },
  };
}

function weaponRig(opts: { loadout?: string[]; slots?: number; stats?: StatSystem | null } = {}) {
  const events = new EventBus<GameEvents>();
  const stats = opts.stats === undefined ? new StatSystem({ events }) : opts.stats;
  const input = new FakeWeaponInput();
  const player = new FakePlayer();
  const camera = new FakeCamera(player);
  const combat = new CombatWorld({ events, physics: null });
  combat.setLevel(
    buildTestLevel([
      { material: 'concrete_wall', center: { x: 0, y: 1.5, z: -40 }, size: { x: 20, y: 3, z: 0.5 } },
    ]),
  );
  const weapons = new WeaponSystem(
    {
      events,
      input,
      settings: fakeSettings(),
      player,
      camera,
      render: fakeRenderCamera({ x: 0, y: 1.6, z: 0 }),
      combat,
      getMuzzleWorld: (o) => o.set(0.2, 1.45, -0.5),
    },
    {
      loadout: opts.loadout ?? ['rifle', 'pistol'],
      slots: opts.slots ?? 2,
      seed: 'stats',
      defs: (id) => {
        const d = (WEAPONS as Record<string, WeaponDef>)[id];
        return d ? precise(d) : undefined;
      },
    },
  );
  if (stats) weapons.setStats(stats);
  const fired: number[] = [];
  const reloads: GameEvents['weapon:reloadStart'][] = [];
  const damage: GameEvents['combat:damage'][] = [];
  const inventory: GameEvents['weapon:inventoryChanged'][] = [];
  let tick = 0;
  events.on('weapon:fired', () => fired.push(tick));
  events.on('weapon:reloadStart', (e) => reloads.push({ ...e }));
  events.on('combat:damage', (e) => damage.push({ ...e, point: { ...e.point } }));
  events.on('weapon:inventoryChanged', (e) => inventory.push({ slots: [...e.slots], current: e.current }));
  const frame = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      weapons.fixedUpdate(DT);
      weapons.update(DT);
      input.endFrame();
      tick++;
    }
  };
  const until = (pred: () => boolean, limit = 600): number => {
    for (let i = 0; i < limit; i++) {
      if (pred()) return i;
      frame();
    }
    throw new Error('condition not reached');
  };
  until(() => weapons.state === 'idle');
  return { events, stats, input, player, combat, weapons, fired, reloads, damage, inventory, frame, until };
}

/** Shots fired while holding the trigger for `seconds`. */
function sprayCount(stats: StatSystem | null, seconds: number): number {
  const r = weaponRig({ stats });
  r.input.press('fire');
  r.frame(Math.round(seconds / DT));
  r.input.release('fire');
  return r.fired.length;
}

describe('WeaponSystem stat consumption', () => {
  it('without modifiers it fires exactly like before (no stats, neutral stats)', () => {
    expect(sprayCount(new StatSystem(), 1)).toBe(sprayCount(null, 1));
  });

  it('fireRate scales the fire interval', () => {
    const base = sprayCount(null, 1.5);
    const stats = new StatSystem();
    stats.addModifier({ source: 'perk:x', stat: 'fireRate', op: 'mul', value: 1.5 });
    const fast = sprayCount(stats, 1.5);
    // 650 rpm → 16.25 shots in 1.5 s; ×1.5 → 24.4 (shots land on tick boundaries).
    expect(base).toBeGreaterThanOrEqual(16);
    expect(fast / base).toBeGreaterThan(1.4);
    expect(fast / base).toBeLessThan(1.6);
  });

  it('reloadSpeed shortens reload durations and moves the commit point', () => {
    const r = weaponRig();
    r.input.tap('fire');
    r.frame(10);
    r.input.tap('reload');
    r.frame();
    expect(r.reloads[0]!.duration).toBeCloseTo(WEAPONS.rifle.reload.tactical);
    r.until(() => r.weapons.state === 'idle');
    r.stats!.addModifier({ source: 'perk:quickload', stat: 'reloadSpeed', op: 'mul', value: 1.5 });
    r.input.tap('fire');
    r.frame(10);
    r.input.tap('reload');
    r.frame();
    expect(r.reloads[1]!.duration).toBeCloseTo(WEAPONS.rifle.reload.tactical / 1.5);
    const magIn = WEAPONS.rifle.reload.tacticalSteps.find((m) => m.step === 'magIn')!.at / 1.5;
    const ticks = r.until(() => r.weapons.ammo!.mag === 33);
    expect((ticks + 1) * DT).toBeCloseTo(magIn, 1);
  });

  it('magazineSize / reserveAmmo apply on reload and refill without losing ammo', () => {
    const r = weaponRig();
    const rifle = WEAPONS.rifle;
    r.input.tap('fire');
    r.frame(10);
    expect(r.weapons.ammo).toEqual({ mag: rifle.magazine, reserve: rifle.reserve, magSize: rifle.magazine });
    r.stats!.batch(() => {
      r.stats!.addModifier({ source: 'perk:recycler', stat: 'magazineSize', op: 'mul', value: 1.3 });
      r.stats!.addModifier({ source: 'perk:recycler', stat: 'reserveAmmo', op: 'mul', value: 1.5 });
    });
    r.frame();
    const bigMag = Math.round(rifle.magazine * 1.3);
    // Nothing lost, nothing gained yet: the bigger magazine fills on the next reload.
    expect(r.weapons.ammo).toEqual({ mag: rifle.magazine, reserve: rifle.reserve, magSize: bigMag });
    r.input.tap('reload');
    r.until(() => r.weapons.state === 'reloading');
    r.until(() => r.weapons.state === 'idle');
    expect(r.weapons.ammo!.mag).toBe(bigMag + 1);
    r.weapons.refillAmmo();
    expect(r.weapons.ammo!.reserve).toBe(Math.round(rifle.reserve * 1.5));
    // Losing the perk: rounds above the old magazine go back to the (capped) reserve.
    r.stats!.removeSource('perk:recycler');
    r.frame();
    expect(r.weapons.ammo).toEqual({
      mag: rifle.magazine + 1,
      reserve: rifle.reserve,
      magSize: rifle.magazine,
    });
  });

  it('damage and headshotMultiplier scale hits; meleeDamage scales the bash', () => {
    const r = weaponRig({ loadout: ['pistol'] });
    const target = new FakeTarget({ x: 0, y: 0, z: -8 }, 100_000);
    r.combat.register(target);
    r.stats!.addModifier({ source: 'perk:doubleimpulse', stat: 'damage', op: 'mul', value: 1.25 });
    r.stats!.addModifier({ source: 'perk:precision', stat: 'headshotMultiplier', op: 'mul', value: 1.35 });
    r.player.pitch = Math.atan2(1.2 - 1.6, 8);
    r.input.tap('fire');
    r.frame(20);
    expect(r.damage.at(-1)!.zone).toBe('body');
    expect(r.damage.at(-1)!.amount).toBeCloseTo(WEAPONS.pistol.damage.base * 1.25);
    r.player.pitch = Math.atan2(0.02, 8);
    r.input.tap('fire');
    r.frame(20);
    expect(r.damage.at(-1)!.zone).toBe('head');
    expect(r.damage.at(-1)!.amount).toBeCloseTo(
      WEAPONS.pistol.damage.base * 1.25 * WEAPONS.pistol.damage.headMultiplier * 1.35,
    );
    // Melee: its own stat (the weapon damage stat does not apply to the bash).
    const close = new FakeTarget({ x: 0, y: 0, z: -1.3 }, 100_000);
    r.combat.register(close);
    r.stats!.addModifier({ source: 'perk:impactcore', stat: 'meleeDamage', op: 'mul', value: 2.5 });
    r.player.pitch = 0;
    r.input.tap('melee');
    r.frame(Math.ceil(WEAPONS.pistol.melee.hitTime / DT) + 2);
    expect(r.damage.at(-1)!.amount).toBeCloseTo(WEAPONS.pistol.melee.damage * 2.5);
  });

  it('adsSpeed shortens the ADS blend', () => {
    const framesToAim = (speed: number): number => {
      const r = weaponRig();
      if (speed !== 1) r.stats!.addModifier({ source: 'x', stat: 'adsSpeed', op: 'mul', value: speed });
      r.input.press('ads');
      return r.until(() => r.weapons.adsAmount >= 1);
    };
    const base = framesToAim(1);
    expect(base).toBe(Math.ceil(WEAPONS.rifle.ads.inTime / DT));
    expect(framesToAim(2)).toBe(Math.ceil(WEAPONS.rifle.ads.inTime / 2 / DT));
  });

  it('weaponSlots adds a slot on top of the loadout; losing it drops the third weapon', () => {
    const r = weaponRig({ loadout: ['rifle', 'pistol'], slots: 2 });
    expect(r.weapons.slotCount).toBe(2);
    r.stats!.addModifier({ source: 'perk:holster', stat: 'weaponSlots', op: 'add', value: 1 });
    r.frame();
    expect(r.weapons.slotCount).toBe(3);
    expect(r.inventory.at(-1)!.slots).toEqual(['rifle', 'pistol', null]);
    r.weapons.give('shotgun');
    r.until(() => r.weapons.currentWeaponId === 'shotgun' && r.weapons.state === 'idle');
    expect(r.weapons.slotIds).toEqual(['rifle', 'pistol', 'shotgun']);
    r.stats!.removeSource('perk:holster');
    r.frame();
    expect(r.weapons.slotIds).toEqual(['rifle', 'pistol']);
    expect(r.weapons.currentWeaponId).toBe('rifle');
    // The third weapon in hand is dropped: the first remaining one comes up.
    r.stats!.addModifier({ source: 'perk:holster', stat: 'weaponSlots', op: 'add', value: 1 });
    r.frame();
    r.weapons.setLoadout([], 2);
    r.weapons.give('pistol');
    r.weapons.give('shotgun');
    r.weapons.give('rifle');
    r.until(() => r.weapons.state === 'idle');
    expect(r.weapons.slotIds).toEqual(['pistol', 'shotgun', 'rifle']);
    expect(r.weapons.currentWeaponId).toBe('rifle');
    r.stats!.removeSource('perk:holster');
    r.frame();
    expect(r.weapons.slotIds).toEqual(['pistol', 'shotgun']);
    expect(r.weapons.currentWeaponId).toBe('pistol');
    expect(r.weapons.state).toBe('equipping');
  });
});

describe('WeaponSystem: losing the extra slot mid-reload', () => {
  it('ends the reload of the dropped weapon before raising the next one', () => {
    const r = weaponRig({ loadout: ['rifle', 'pistol'], slots: 2 });
    const ends: GameEvents['weapon:reloadEnd'][] = [];
    r.events.on('weapon:reloadEnd', (e) => ends.push({ ...e }));
    // Granted and given in the same tick: the new slot already counts.
    r.stats!.addModifier({ source: 'perk:holster', stat: 'weaponSlots', op: 'add', value: 1 });
    r.weapons.give('shotgun');
    expect(r.weapons.slotIds).toEqual(['rifle', 'pistol', 'shotgun']);
    r.until(() => r.weapons.currentWeaponId === 'shotgun' && r.weapons.state === 'idle');
    r.input.tap('fire');
    r.frame(60);
    r.input.tap('reload');
    r.until(() => r.weapons.state === 'reloading');
    r.stats!.removeSource('perk:holster');
    r.frame();
    expect(ends.at(-1)).toEqual({ weaponId: 'shotgun', completed: false });
    expect(r.weapons.currentWeaponId).toBe('rifle');
    expect(r.inventory.at(-1)).toEqual({ slots: ['rifle', 'pistol'], current: 0 });
  });
});

describe('PlayerController stat consumption', () => {
  async function rig(stats: StatSystem | null) {
    const physics = await PhysicsWorld.create();
    physics.addStaticBox({ x: 0, y: -0.5, z: 0 }, { x: 80, y: 0.5, z: 80 }, undefined, {
      kind: 'world',
      surface: 'concrete',
    });
    const input = new FakeInput();
    const events = new EventBus<GameEvents>();
    const player = new PlayerController(
      { physics, input, events, settings: fakeSettings() },
      { position: { x: 0, y: 0, z: 0 }, yaw: 0 },
    );
    if (stats) player.setStats(stats);
    const frame = (n = 1): void => {
      for (let i = 0; i < n; i++) {
        player.fixedUpdate(DT);
        physics.step(DT);
        player.update(DT, 1);
        input.endFrame();
      }
    };
    frame(10);
    return { physics, input, events, player, frame };
  }

  it('dashCharges / dashRecharge change capacity and refill time', async () => {
    const stats = new StatSystem();
    const r = await rig(stats);
    expect(r.player.maxDashCharges).toBe(MOVEMENT.dash.charges);
    stats.addModifier({ source: 'perk:riftwalker', stat: 'dashCharges', op: 'add', value: 1 });
    stats.addModifier({ source: 'perk:riftwalker', stat: 'dashRecharge', op: 'mul', value: 2 });
    r.frame();
    expect(r.player.maxDashCharges).toBe(MOVEMENT.dash.charges + 1);
    // The new charge slot refills first.
    r.frame(Math.ceil(MOVEMENT.dash.rechargeTime / 2 / DT) + 2);
    expect(r.player.dashCharges).toBe(MOVEMENT.dash.charges + 1);
    for (let i = 0; i < 3; i++) {
      r.input.tap('dash');
      r.frame(Math.ceil(MOVEMENT.dash.minInterval / DT) + 1);
    }
    expect(r.player.dashCharges).toBeLessThanOrEqual(1);
    const empty = r.player.dashCharges;
    r.frame(Math.ceil(MOVEMENT.dash.rechargeTime / 2 / DT) + 2);
    expect(r.player.dashCharges).toBe(empty + 1);
    stats.removeSource('perk:riftwalker');
    r.frame(Math.ceil((2 * MOVEMENT.dash.rechargeTime) / DT) + 4);
    expect(r.player.dashCharges).toBe(MOVEMENT.dash.charges);
    expect(r.player.maxDashCharges).toBe(MOVEMENT.dash.charges);
    expect(r.player.dashRecharge).toBe(1);
    r.physics.dispose();
  });

  it('moveSpeed scales the ground speed; no stats = identical movement', async () => {
    const runFor = async (stats: StatSystem | null): Promise<number> => {
      const r = await rig(stats);
      r.input.move.y = 1;
      r.frame(90);
      const v = Math.hypot(r.player.velocity.x, r.player.velocity.z);
      r.physics.dispose();
      return v;
    };
    const plain = await runFor(null);
    expect(await runFor(new StatSystem())).toBe(plain);
    const fast = new StatSystem();
    fast.addModifier({ source: 'perk:sprinter', stat: 'moveSpeed', op: 'mul', value: 1.2 });
    expect(await runFor(fast)).toBeCloseTo(plain * 1.2, 3);
  });
});

describe('PlayerHealth stat consumption', () => {
  const DEF: PlayerHealthDef = { ...PLAYER.health, startArmor: 0 };

  function setup(def: PlayerHealthDef = DEF) {
    const events = new EventBus<GameEvents>();
    const stats = new StatSystem({ events });
    const health = new PlayerHealth({ events }, def);
    health.setStats(stats);
    const changed: GameEvents['player:healthChanged'][] = [];
    const revived: GameEvents['player:revived'][] = [];
    const order: string[] = [];
    events.on('player:healthChanged', (e) => {
      changed.push({ ...e });
      order.push('changed');
    });
    events.on('player:damaged', () => order.push('damaged'));
    events.on('player:revived', (e) => {
      revived.push({ ...e });
      order.push('revived');
    });
    return { events, stats, health, changed, revived, order };
  }

  it('max health up grants the extra at once, down clamps; the HUD hears it next tick', () => {
    const t = setup();
    t.health.damage(40);
    t.stats.addModifier({ source: 'perk:titan', stat: 'maxHealth', op: 'mul', value: 1.8 });
    t.health.fixedUpdate(DT);
    expect(t.health.maxHealth).toBeCloseTo(180);
    expect(t.health.health).toBeCloseTo(140);
    expect(t.changed.at(-1)).toMatchObject({ maxHealth: 180 });
    t.stats.removeSource('perk:titan');
    t.health.fixedUpdate(DT);
    expect(t.health.maxHealth).toBe(100);
    expect(t.health.health).toBe(100);
    // A custom def scales by the same ratio.
    const c = setup({ ...DEF, maxHealth: 200, startHealth: 200 });
    c.stats.addModifier({ source: 'x', stat: 'maxHealth', op: 'mul', value: 1.5 });
    c.health.fixedUpdate(DT);
    expect(c.health.maxHealth).toBe(300);
  });

  it('regen delay and rate follow the stats', () => {
    const t = setup();
    t.stats.addModifier({ source: 'perk:phoenix', stat: 'regenDelay', op: 'mul', value: 0.5 });
    t.stats.addModifier({ source: 'perk:phoenix', stat: 'regenRate', op: 'mul', value: 2 });
    t.health.damage(50);
    let ticks = 0;
    while (t.health.health <= 50 && ticks < 1000) {
      t.health.fixedUpdate(DT);
      ticks++;
    }
    expect(ticks * DT).toBeCloseTo(DEF.regenDelay * 0.5, 1);
    const before = t.health.health;
    t.health.fixedUpdate(DT);
    expect(t.health.health - before).toBeCloseTo(DEF.regenRate * 2 * DT);
  });

  it('damage taken multipliers: general, explosion and fall', () => {
    const t = setup();
    t.stats.addModifier({ source: 'perk:bulwark', stat: 'damageTaken', op: 'mul', value: 0.5 });
    expect(t.health.damage(20)).toBeCloseTo(10);
    t.stats.addModifier({ source: 'perk:kinetic', stat: 'explosionDamageTaken', op: 'mul', value: 0 });
    t.stats.addModifier({ source: 'perk:kinetic', stat: 'fallDamageTaken', op: 'mul', value: 0 });
    expect(t.health.damage(50, undefined, 'explosion')).toBe(0);
    expect(t.health.damage(50, undefined, 'fall')).toBe(0);
    expect(t.health.damage(20, undefined, 'generic')).toBeCloseTo(10);
    t.stats.reset();
    expect(t.health.damage(20, undefined, 'explosion')).toBeCloseTo(20);
  });

  it('a revive charge turns lethal damage into a revive with invulnerability', () => {
    const t = setup();
    t.stats.addModifier({ source: 'card:revive', stat: 'reviveCharges', op: 'add', value: 1 });
    t.health.fixedUpdate(DT);
    expect(t.health.reviveCharges).toBe(1);
    expect(t.health.damage(500)).toBeCloseTo(100);
    expect(t.health.dead).toBe(false);
    expect(t.health.health).toBeCloseTo(DEF.maxHealth * PLAYER.revive.healthFraction);
    expect(t.revived).toEqual([
      {
        health: DEF.maxHealth * PLAYER.revive.healthFraction,
        chargesLeft: 0,
        invulnerability: PLAYER.revive.invulnerability,
      },
    ]);
    // The run never sees health 0: damaged → revived → healthChanged(revived health).
    expect(t.order.slice(-3)).toEqual(['damaged', 'revived', 'changed']);
    expect(t.changed.every((c) => c.health > 0)).toBe(true);
    // Invulnerable for a moment, then mortal (no charge left).
    expect(t.health.damage(500)).toBe(0);
    for (let i = 0; i < Math.ceil(PLAYER.revive.invulnerability / DT) + 1; i++) t.health.fixedUpdate(DT);
    expect(t.health.invulnerableTime).toBe(0);
    t.health.damage(500);
    expect(t.health.dead).toBe(true);
    // A new run restores the charge.
    t.health.reset();
    expect(t.health.reviveCharges).toBe(1);
  });

  it('two sources: the one lost on use hands its charge back, the other stays', () => {
    const t = setup();
    t.stats.addModifier({ source: 'card:revive', stat: 'reviveCharges', op: 'add', value: 1 });
    t.stats.addModifier({ source: 'perk:phoenix', stat: 'reviveCharges', op: 'add', value: 1 });
    // What PerkSystem does for lostOnRevive perks.
    t.events.on('player:revived', () => t.stats.removeSource('perk:phoenix'));
    t.health.fixedUpdate(DT);
    expect(t.health.reviveCharges).toBe(2);
    t.health.damage(500);
    expect(t.revived[0]!.chargesLeft).toBe(1);
    expect(t.health.reviveCharges).toBe(1);
    for (let i = 0; i < Math.ceil(PLAYER.revive.invulnerability / DT) + 1; i++) t.health.fixedUpdate(DT);
    t.health.damage(500);
    expect(t.health.dead).toBe(false);
    expect(t.health.reviveCharges).toBe(0);
  });

  it('kill() ignores revive charges and damage stats (dev `run kill`), god mode still refuses', () => {
    const t = setup();
    t.stats.addModifier({ source: 'card:revive', stat: 'reviveCharges', op: 'add', value: 1 });
    t.stats.addModifier({ source: 'x', stat: 'damageTaken', op: 'mul', value: 0 });
    t.health.godMode = true;
    expect(t.health.kill()).toBe(0);
    t.health.godMode = false;
    expect(t.health.kill()).toBe(100);
    expect(t.health.dead).toBe(true);
    expect(t.revived).toHaveLength(0);
    expect(t.changed.at(-1)!.health).toBe(0);
  });

  it('without stats the def applies unchanged', () => {
    const events = new EventBus<GameEvents>();
    const h = new PlayerHealth({ events }, DEF);
    h.setStats(null);
    expect(h.maxHealth).toBe(DEF.maxHealth);
    expect(h.reviveCharges).toBe(0);
    h.damage(1000);
    expect(h.dead).toBe(true);
  });
});
