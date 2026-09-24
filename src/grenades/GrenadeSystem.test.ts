import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { Damageable, ProjectileSpawnOptions } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { DamageElement, GameEvents } from '../core/events';
import type { Action } from '../defs/input';
import { GRENADE_RULES, GRENADES } from '../defs/grenades';
import { GrenadeSystem, type GrenadeSystemDeps } from './GrenadeSystem';

const DT = 1 / 60;

class FakeInput {
  down = new Set<Action>();
  presses = new Set<Action>();
  isDown(a: Action): boolean {
    return this.down.has(a);
  }
  pressed(a: Action): boolean {
    return this.presses.has(a);
  }
}

interface Spawned {
  weaponId: string;
  speedScale: number;
  dir: { x: number; y: number; z: number };
  inherit: { x: number; y: number; z: number };
  visual: string;
}

function setup(over: Partial<GrenadeSystemDeps> = {}) {
  const events = new EventBus<GameEvents>();
  const input = new FakeInput();
  const spawned: Spawned[] = [];
  let refuse = false;
  const log: string[] = [];
  events.on('grenade:thrown', (e) => log.push(`thrown:${e.grenadeId}`));
  events.on('grenade:changed', (e) => log.push(`changed:${e.grenadeId}:${e.count}/${e.max}`));
  const player = { yaw: 0, pitch: 0, velocity: new Vector3() };
  const deps: GrenadeSystemDeps = {
    events,
    input,
    projectiles: {
      spawn(o: ProjectileSpawnOptions): number {
        if (refuse) return 0;
        spawned.push({
          weaponId: o.damage.weaponId,
          speedScale: o.speedScale ?? 1,
          dir: { ...o.direction },
          inherit: { ...(o.inherit ?? { x: 0, y: 0, z: 0 }) },
          visual: o.def.visual,
        });
        return spawned.length;
      },
    },
    player,
    eye: () => ({ x: 0, y: 1.6, z: 0 }),
    ...over,
  };
  const g = new GrenadeSystem(deps);
  /** One frame: presses of this frame, `ticks` fixed ticks, then the frame update. */
  const frame = (ticks = 1): void => {
    for (let i = 0; i < ticks; i++) g.fixedUpdate(DT);
    g.update(DT);
    input.presses.clear();
  };
  return {
    events,
    input,
    spawned,
    log,
    g,
    player,
    frame,
    refuse: (on: boolean) => (refuse = on),
  };
}

function press(t: ReturnType<typeof setup>): void {
  t.input.down.add('grenade');
  t.input.presses.add('grenade');
}

describe('GrenadeSystem counts', () => {
  it('starts with 2 frag grenades (max 4) and announces them', () => {
    const t = setup();
    expect(t.g.selected).toBe('frag');
    expect(t.g.count('frag')).toBe(2);
    expect(t.g.max('frag')).toBe(GRENADES.frag.max);
    expect(t.g.max('frag')).toBe(4);
    expect(t.g.count('kryo')).toBe(0);
    expect(t.g.count('nope')).toBe(0);
    expect(t.g.max('nope')).toBe(0);
    expect(t.log).toEqual(['changed:frag:2/4']);
  });

  it('add() caps at the max, ignores unknown ids, and hands the new type over when empty', () => {
    const t = setup({ start: { id: 'frag', count: 0 } });
    expect(t.g.add('frag', 9)).toBe(4);
    expect(t.g.count('frag')).toBe(4);
    expect(t.g.add('frag', 1)).toBe(0);
    expect(t.g.add('bogus', 3)).toBe(0);
    // frag still has grenades: adding kryo keeps frag selected.
    expect(t.g.add('kryo', 2)).toBe(2);
    expect(t.g.selected).toBe('frag');
    expect(t.g.carriedTypes).toEqual(['frag', 'kryo']);
  });

  it('refill() tops up every carried type (Max Munition via powerup:collected)', () => {
    const t = setup();
    t.g.add('singularity', 1);
    t.events.emit('powerup:collected', { type: 'maxAmmo', position: { x: 0, y: 0, z: 0 }, duration: 0 });
    expect(t.g.count('frag')).toBe(4);
    expect(t.g.count('singularity')).toBe(GRENADES.singularity.max);
    // Not carried: untouched.
    expect(t.g.count('brand')).toBe(0);
    // Other power-ups do nothing.
    t.g.throwNow();
    t.events.emit('powerup:collected', {
      type: 'doublePoints',
      position: { x: 0, y: 0, z: 0 },
      duration: 30,
    });
    expect(t.g.count('frag')).toBe(3);
  });

  it('reset() restores the start loadout (setStart: map loadout)', () => {
    const t = setup();
    t.g.add('kryo', 3);
    t.g.select('kryo');
    t.g.throwNow();
    t.g.setStart({ id: 'brand', count: 2 });
    t.g.reset();
    expect(t.g.selected).toBe('brand');
    expect(t.g.count('brand')).toBe(2);
    expect(t.g.count('kryo')).toBe(0);
    expect(t.g.count('frag')).toBe(0);
    t.g.setStart({ id: 'unknown', count: 5 });
    t.g.reset();
    expect(t.g.selected).toBe(GRENADE_RULES.start.id);
    expect(t.g.count(GRENADE_RULES.start.id)).toBe(GRENADE_RULES.start.count);
  });
});

describe('GrenadeSystem throwing', () => {
  it('a tap lobs, a held press throws at full strength on release', () => {
    const t = setup();
    press(t);
    t.input.down.delete('grenade'); // released within the frame: a tap
    t.frame();
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0]!.speedScale).toBeCloseTo(GRENADE_RULES.lobSpeedScale, 6);
    expect(t.spawned[0]!.weaponId).toBe('grenade.frag');
    expect(t.spawned[0]!.visual).toBe(GRENADES.frag.projectile.visual);
    expect(t.log).toContain('thrown:frag');
    expect(t.g.count('frag')).toBe(1);

    // Past the throw interval, hold for the windup, then release.
    for (let i = 0; i < Math.ceil(GRENADE_RULES.interval / DT) + 1; i++) t.frame();
    press(t);
    t.frame();
    const holdFrames = Math.ceil(GRENADE_RULES.windup / DT) + 2;
    for (let i = 0; i < holdFrames; i++) t.frame();
    expect(t.spawned).toHaveLength(1);
    expect(t.g.isPrimed).toBe(true);
    expect(t.g.primeAmount).toBe(1);
    t.input.down.delete('grenade');
    t.frame();
    expect(t.spawned).toHaveLength(2);
    expect(t.spawned[1]!.speedScale).toBe(1);
    expect(t.g.isPrimed).toBe(false);
    expect(t.g.count('frag')).toBe(0);
  });

  it('a press in a frame without a tick is latched for the next tick, once', () => {
    const t = setup();
    press(t);
    t.input.down.delete('grenade');
    t.frame(0);
    expect(t.spawned).toHaveLength(0);
    t.frame(2);
    expect(t.spawned).toHaveLength(1);
    for (let i = 0; i < 60; i++) t.frame();
    expect(t.spawned).toHaveLength(1);
  });

  it('keeps throws `interval` apart: a press during it throws once it ran out', () => {
    const t = setup({ start: { id: 'frag', count: 4 } });
    press(t);
    t.input.down.delete('grenade');
    t.frame();
    press(t);
    t.input.down.delete('grenade');
    t.frame();
    expect(t.spawned).toHaveLength(1);
    for (let i = 0; i < Math.ceil(GRENADE_RULES.interval / DT) + 1; i++) t.frame();
    expect(t.spawned).toHaveLength(2);
    // The waiting throw kept the strength of its tap.
    expect(t.spawned[1]!.speedScale).toBeCloseTo(GRENADE_RULES.lobSpeedScale, 6);
  });

  it('a pause while primed puts the grenade back', () => {
    const t = setup();
    press(t);
    t.frame();
    expect(t.g.isPrimed).toBe(true);
    t.events.emit('game:paused', { reason: 'menu' });
    t.input.down.delete('grenade');
    t.frame();
    expect(t.spawned).toHaveLength(0);
    expect(t.g.count('frag')).toBe(2);
  });

  it('a primed grenade is thrown by itself after maxHold', () => {
    const t = setup();
    press(t);
    t.frame();
    for (let i = 0; i < Math.ceil(GRENADE_RULES.maxHold / DT) + 2; i++) t.frame();
    expect(t.spawned).toHaveLength(1);
  });

  it("inherits the thrower's velocity and throws along the look", () => {
    const t = setup();
    t.player.velocity.set(3, 0, -5);
    t.player.yaw = Math.PI; // looks down +Z
    t.g.throwNow(1);
    const s = t.spawned[0]!;
    expect(s.inherit).toEqual({
      x: 3 * GRENADE_RULES.inheritVelocity,
      y: 0,
      z: -5 * GRENADE_RULES.inheritVelocity,
    });
    expect(s.dir.z).toBeGreaterThan(0.9);
    expect(s.dir.y).toBeGreaterThan(0);
  });

  it('denies an empty press, and throws nothing while disabled', () => {
    let denied = 0;
    let enabled = false;
    const t = setup({ start: { id: 'frag', count: 0 }, onDeny: () => denied++, enabled: () => enabled });
    press(t);
    t.frame();
    expect(denied).toBe(0);
    enabled = true;
    t.input.down.delete('grenade');
    press(t);
    t.frame();
    expect(denied).toBe(1);
    expect(t.spawned).toHaveLength(0);
    t.g.add('frag', 1);
    press(t);
    enabled = false;
    t.frame();
    enabled = true;
    t.input.down.delete('grenade');
    t.frame();
    expect(t.spawned).toHaveLength(0);
  });

  it('selects the next carried type when the selected one runs dry', () => {
    const t = setup({ start: { id: 'frag', count: 1 } });
    t.g.add('kryo', 1);
    t.g.throwNow();
    expect(t.g.selected).toBe('kryo');
    t.g.throwNow();
    expect(t.g.selected).toBe('kryo');
    expect(t.g.throwNow()).toBe(false);
    expect(t.spawned.map((s) => s.weaponId)).toEqual(['grenade.frag', 'grenade.kryo']);
  });

  it('keeps the grenade when the projectile pool refuses it', () => {
    const t = setup();
    t.refuse(true);
    expect(t.g.throwNow()).toBe(false);
    expect(t.g.count('frag')).toBe(2);
  });
});

describe('GrenadeSystem detonation status', () => {
  function enemy(id: number, x: number, alive = true): Damageable {
    const c = new Vector3(x, 1, 0);
    return {
      id,
      alive,
      team: 'enemy',
      surface: 'flesh',
      boundsCenter: c,
      boundsRadius: 0.5,
      hitboxes: [],
      aimPoint: c,
      applyDamage: () => ({ applied: 0, killed: false }),
    };
  }

  it('a kryo detonation builds its status on every enemy in reach with line of sight, next tick', () => {
    const near = enemy(1, 2);
    const far = enemy(2, 30);
    const blocked = enemy(3, 3);
    const dead = enemy(4, 1, false);
    const applied: [number, DamageElement, number, string | undefined][] = [];
    const t = setup({
      combat: {
        queryRadius: (_c, _r, out: Damageable[]) => {
          out.push(near, far, blocked, dead);
          return out;
        },
        lineOfSight: (_a, b) => b !== blocked.aimPoint,
      },
      status: {
        applyElement: (target, element, amount, _src, weaponId) =>
          void applied.push([target.id, element, amount, weaponId]),
      },
    });
    const ds = GRENADES.kryo.detonationStatus!;
    const at = { x: 0, y: 0.1, z: 0 };
    t.events.emit('projectile:impact', {
      weaponId: 'grenade.kryo',
      position: at,
      normal: at,
      detonated: true,
    });
    // Bounces and other weapons do nothing.
    t.events.emit('projectile:impact', {
      weaponId: 'grenade.kryo',
      position: at,
      normal: at,
      detonated: false,
    });
    t.events.emit('projectile:impact', {
      weaponId: 'grenade.frag',
      position: at,
      normal: at,
      detonated: true,
    });
    expect(applied).toHaveLength(0);
    t.frame();
    expect(applied).toEqual([[1, ds.element, ds.amount, 'grenade.kryo']]);
    t.frame();
    expect(applied).toHaveLength(1);
  });
});
