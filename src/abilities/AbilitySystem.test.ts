import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { AreaDamageSource } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { ABILITIES, ABILITY_IDS, ABILITY_RULES } from '../defs/abilities';
import type { ExplosionDef, FieldDef } from '../defs/weapons';
import type { Action } from '../defs/input';
import { StatSystem } from '../stats/StatSystem';
import { resetRunSystems, type RunResetSystems } from '../game/runReset';
import { AbilitySystem, type AbilitySystemDeps } from './AbilitySystem';

const DT = 1 / 60;

function setup(over: Partial<AbilitySystemDeps> = {}) {
  const events = new EventBus<GameEvents>();
  const presses = new Set<Action>();
  const stats = new StatSystem({ events });
  const log: string[] = [];
  const blasts: { at: Vec3Like; def: ExplosionDef; from: AreaDamageSource }[] = [];
  const fields = new Map<number, { def: FieldDef; at: Vec3Like; from: string }>();
  const moves: Vec3Like[] = [];
  const ended: number[] = [];
  const looks: string[] = [];
  let fieldSeq = 0;
  events.on('ability:used', (e) => log.push(`used:${e.abilityId}:${e.cooldown}:${e.duration}`));
  events.on('ability:ready', (e) => log.push(`ready:${e.abilityId}`));
  events.on('ability:ended', (e) => log.push(`ended:${e.abilityId}`));
  const player = { position: new Vector3(1, 0, 2) };
  const deps: AbilitySystemDeps = {
    events,
    input: { pressed: (a) => presses.has(a) },
    stats,
    explosions: {
      explode: (at, def, from) => {
        blasts.push({ at: { x: at.x, y: at.y, z: at.z }, def, from: { ...from } });
        return 0;
      },
    },
    fields: {
      spawn: (at, def, from) => {
        fields.set(++fieldSeq, { def, at: { x: at.x, y: at.y, z: at.z }, from: from.weaponId });
        return fieldSeq;
      },
      move: (id, at) => {
        moves.push({ x: at.x, y: at.y, z: at.z });
        return fields.has(id);
      },
      end: (id) => {
        ended.push(id);
        return fields.delete(id);
      },
    },
    player,
    visuals: {
      start: (fx, _p, radius, duration) => void looks.push(`start:${fx}:${radius}:${duration}`),
      stop: (fx) => void looks.push(`stop:${fx}`),
      clear: () => void looks.push('clear'),
    },
    ...over,
  };
  const a = new AbilitySystem(deps);
  const frame = (ticks = 1): void => {
    for (let i = 0; i < ticks; i++) a.fixedUpdate(DT);
    a.update(DT);
    presses.clear();
  };
  const seconds = (s: number): void => {
    for (let i = 0; i < Math.round(s / DT); i++) frame();
  };
  return { events, presses, stats, log, blasts, fields, moves, ended, looks, player, a, frame, seconds };
}

describe('AbilitySystem', () => {
  it('equips the default ability, ready at once', () => {
    const t = setup();
    expect(t.a.equipped).toBe(ABILITY_RULES.defaultAbility);
    expect(t.a.cooldownLeft).toBe(0);
    expect(t.a.cooldown).toBe(ABILITIES.schockwelle.cooldown);
    expect(t.a.active).toBe(false);
    const none = setup({ ability: null });
    expect(none.a.equipped).toBeNull();
    expect(none.a.use()).toBe(false);
  });

  it('Schockwelle: the action blasts around the feet, then the cooldown runs out into ability:ready', () => {
    const t = setup();
    t.presses.add('ability');
    t.frame();
    expect(t.blasts).toHaveLength(1);
    const b = t.blasts[0]!;
    expect(b.def).toBe(ABILITIES.schockwelle.blast.explosion);
    expect(b.at).toEqual({ x: 1, y: ABILITIES.schockwelle.blast.centerHeight, z: 2 });
    expect(b.from.source).toBe('player');
    expect(b.from.weaponId).toBe('ability.schockwelle');
    expect(b.from.statusBuildup).toBeGreaterThan(0); // shock builds up
    expect(t.looks).toEqual([`start:shockRing:${ABILITIES.schockwelle.blast.explosion.radius}:0`]);
    expect(t.log).toEqual([`used:schockwelle:${ABILITIES.schockwelle.cooldown}:0`]);
    // Instant: no running effect, no ended event.
    expect(t.a.active).toBe(false);
    expect(t.a.cooldownLeft).toBeCloseTo(ABILITIES.schockwelle.cooldown - DT, 6);

    // A press while cooling down is denied.
    t.presses.add('ability');
    t.frame();
    expect(t.blasts).toHaveLength(1);
    expect(t.a.stats.denied).toBe(1);

    t.seconds(ABILITIES.schockwelle.cooldown);
    expect(t.a.cooldownLeft).toBe(0);
    expect(t.log.filter((l) => l.startsWith('ready'))).toEqual(['ready:schockwelle']);
    expect(t.a.use()).toBe(true);
  });

  it('Phasenbarriere / Überladung: stat modifiers for the duration, removed when the effect ends', () => {
    for (const id of ['phasenbarriere', 'ueberladung'] as const) {
      const t = setup({ ability: id });
      const def = ABILITIES[id];
      expect(t.a.use()).toBe(true);
      expect(t.a.active).toBe(true);
      for (const m of def.modifiers) expect(t.stats.value(m.stat)).toBeCloseTo(m.value, 6);
      expect(t.stats.hasSource(`ability:${id}`)).toBe(true);
      t.seconds(def.duration - 0.5);
      expect(t.a.active).toBe(true);
      expect(t.a.activeTimeLeft).toBeCloseTo(0.5, 1);
      t.seconds(0.6);
      expect(t.a.active).toBe(false);
      expect(t.stats.hasSource(`ability:${id}`)).toBe(false);
      for (const m of def.modifiers) expect(t.stats.value(m.stat)).toBe(1);
      expect(t.log).toEqual([`used:${id}:${def.cooldown}:${def.duration}`, `ended:${id}`]);
      // Still cooling down after the effect.
      expect(t.a.cooldownLeft).toBeGreaterThan(0);
    }
  });

  it('Chronofeld: a slow field that follows the player every tick and ends with the effect', () => {
    const t = setup({ ability: 'chronofeld' });
    const def = ABILITIES.chronofeld;
    t.a.use();
    expect(t.fields.size).toBe(1);
    const f = [...t.fields.values()][0]!;
    expect(f.def).toBe(def.field.field);
    expect(f.def.kind).toBe('slow');
    expect(f.from).toBe('ability.chronofeld');
    expect(t.looks).toEqual([`start:chronoDome:${def.field.field.radius}:${def.duration}`]);
    t.player.position.set(5, 0, -3);
    t.frame();
    expect(t.moves.at(-1)).toEqual({ x: 5, y: 0, z: -3 });
    t.seconds(def.duration + 0.1);
    expect(t.ended).toEqual([1]);
    expect(t.looks.at(-1)).toBe('stop:chronoDome');
    expect(t.a.active).toBe(false);
  });

  it('equip() ends a running effect (modifiers removed) and the new ability is ready', () => {
    const t = setup({ ability: 'ueberladung' });
    t.a.use();
    t.a.equip('phasenbarriere');
    expect(t.stats.hasSource('ability:ueberladung')).toBe(false);
    expect(t.log.at(-1)).toBe('ended:ueberladung');
    expect(t.a.equipped).toBe('phasenbarriere');
    expect(t.a.cooldownLeft).toBe(0);
    t.a.equip('bogus');
    expect(t.a.equipped).toBeNull();
  });

  it('does nothing while disabled', () => {
    let enabled = false;
    const t = setup({ enabled: () => enabled });
    t.presses.add('ability');
    t.frame();
    expect(t.blasts).toHaveLength(0);
    enabled = true;
    t.presses.add('ability');
    t.frame(0); // a frame without a tick latches the press
    expect(t.blasts).toHaveLength(0);
    t.frame();
    expect(t.blasts).toHaveLength(1);
  });

  it('a run reset ends the effect before the stat table resets, clears the cooldown and re-equips', () => {
    const t = setup({ ability: 'phasenbarriere' });
    t.a.use();
    t.a.setStartAbility('chronofeld');
    const order: string[] = [];
    const step = (name: string) => ({
      reset: () => void order.push(name),
      clear: () => void order.push(name),
    });
    const sys: RunResetSystems = {
      enemies: { clear: () => void order.push('enemies'), timeScale: 1, instakill: false },
      waves: { reset: () => void order.push('waves'), start: () => void order.push('waves.start') },
      vfx: step('vfx'),
      arsenal: step('arsenal'),
      abilities: {
        reset: () => {
          order.push(`abilities:${t.stats.hasSource('ability:phasenbarriere')}`);
          t.a.reset();
        },
      },
      grenades: step('grenades'),
      powerUps: { clear: () => void order.push('powerUps'), reseed: () => {} },
      perks: step('perks'),
      stats: { reset: () => void order.push(`stats:${t.stats.hasSource('ability:phasenbarriere')}`) },
      economy: step('economy'),
      pointsRules: step('pointsRules'),
      health: step('health'),
      player: { teleport: () => {}, pitch: 0 },
      level: { id: 'x', spawn: { position: { x: 0, y: 0, z: 0 }, yaw: 0 } },
      map: { waves: false },
      nav: { setRandomSeed: () => {} },
      zones: step('zones'),
      interactables: step('interactables'),
      interaction: step('interaction'),
      seals: null,
      weapons: { setLoadout: () => {}, refillAmmo: () => void order.push('refill') },
      viewmodel: { setVisible: () => {} },
      hud: { resetRun: () => {} },
      audioBridge: { resetRun: () => {} },
      loop: { timeScale: 1 },
    };
    resetRunSystems(sys, { seed: 's', startWaves: false });
    expect(order.indexOf('arsenal')).toBeLessThan(order.indexOf('abilities:true'));
    expect(order.indexOf('abilities:true')).toBeLessThan(order.indexOf('stats:false'));
    expect(order.indexOf('refill')).toBeLessThan(order.indexOf('grenades'));
    expect(t.log.at(-1)).toBe('ended:phasenbarriere');
    expect(t.a.equipped).toBe('chronofeld');
    expect(t.a.cooldownLeft).toBe(0);
    expect(t.a.active).toBe(false);
  });
});

describe('ability defs', () => {
  it('have cooldowns longer than their effects and blast / field / modifier data', () => {
    for (const id of ABILITY_IDS) {
      const d = ABILITIES[id];
      expect(d.id).toBe(id);
      expect(d.cooldown).toBeGreaterThan(d.duration);
      expect(d.blast !== null || d.modifiers.length > 0 || d.field !== null).toBe(true);
      if (d.field) expect(d.field.field.duration).toBeCloseTo(d.duration, 6);
    }
  });
});
