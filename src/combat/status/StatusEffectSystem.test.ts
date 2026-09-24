import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { AreaDamageSource, DamageInfo, DamageResult, Damageable, Hitbox } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { DamageElement, GameEvents, ImpactKind } from '../../core/events';
import { COMBOS, ELEMENTS, STATUS_RESIST, type StatusResistDef } from '../../defs/elements';
import type { ExplosionDef, FieldDef } from '../../defs/weapons';
import { CombatWorld } from '../CombatWorld';
import { StatusEffectSystem, type StatusTargetProfile } from './StatusEffectSystem';

const DT = 1 / 60;
const ticks = (s: number): number => Math.ceil(s / DT);
const T = ELEMENTS.buildup.threshold;

class Dummy implements Damageable {
  alive = true;
  readonly surface = 'flesh' as const;
  readonly boundsCenter: Vector3;
  readonly boundsRadius = 0.5;
  readonly hitboxes: Hitbox[];
  readonly aimPoint: Vector3;
  health: number;
  readonly taken: {
    amount: number;
    element: DamageElement;
    kind: ImpactKind;
    weaponId: string;
    source: string;
  }[] = [];

  constructor(
    readonly id: number,
    x = 0,
    z = 0,
    readonly team: 'enemy' | 'neutral' | 'player' = 'enemy',
    health = 1e6,
  ) {
    this.health = health;
    this.boundsCenter = new Vector3(x, 1, z);
    this.aimPoint = new Vector3(x, 1.3, z);
    this.hitboxes = [
      { shape: 'sphere', zone: 'body', a: new Vector3(x, 1, z), b: new Vector3(), radius: 0.4 },
    ];
  }

  applyDamage(info: DamageInfo): DamageResult {
    if (!this.alive) return { applied: 0, killed: false };
    const applied = Math.min(this.health, info.amount);
    this.health -= applied;
    const killed = this.health <= 0;
    if (killed) this.alive = false;
    this.taken.push({
      amount: applied,
      element: info.element,
      kind: info.kind,
      weaponId: info.weaponId,
      source: info.source,
    });
    return { applied, killed };
  }

  total(filter?: (h: Dummy['taken'][number]) => boolean): number {
    return this.taken.filter((h) => !filter || filter(h)).reduce((s, h) => s + h.amount, 0);
  }
}

function setup(
  opts: { resist?: Record<number, StatusResistDef>; toughness?: number; capacity?: number } = {},
) {
  const events = new EventBus<GameEvents>();
  const combat = new CombatWorld({ events });
  const vfx: string[] = [];
  const flashes: number[] = [];
  const blasts: { def: ExplosionDef; from: AreaDamageSource }[] = [];
  const clouds: { def: FieldDef; from: AreaDamageSource; x: number; z: number }[] = [];
  const status = new StatusEffectSystem({
    events,
    combat,
    vfx: { spawn: (id) => void vfx.push(id) },
    explosions: {
      explode: (_p, def, from) => {
        blasts.push({ def, from: { ...from } });
        return 0;
      },
    },
    fields: {
      spawn: (p, def, from) => {
        clouds.push({ def, from: { ...from }, x: p.x, z: p.z });
        return clouds.length;
      },
    },
    arcs: { flash: (_pts, n) => void flashes.push(n) },
    profile: (t: Damageable, out: StatusTargetProfile) => {
      const r = opts.resist?.[t.id];
      if (!r && opts.toughness === undefined) return false;
      out.resist = r ?? STATUS_RESIST.default;
      out.healthScale = opts.toughness ?? 1;
      return true;
    },
    capacity: opts.capacity,
    seed: 'test',
  });
  combat.setStatus(status);
  const statusEvents: GameEvents['combat:status'][] = [];
  const comboEvents: GameEvents['combat:combo'][] = [];
  const explosionEvents: GameEvents['combat:explosion'][] = [];
  events.on('combat:status', (e) => void statusEvents.push({ ...e, position: { ...e.position } }));
  events.on('combat:combo', (e) => void comboEvents.push({ ...e, position: { ...e.position } }));
  events.on('combat:explosion', (e) => void explosionEvents.push({ ...e, position: { ...e.position } }));
  const add = (...ds: Dummy[]): void => ds.forEach((d) => combat.register(d));
  const info: DamageInfo = {
    amount: 0,
    zone: 'body',
    point: { x: 0, y: 1, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    weaponId: 'rifle',
    element: 'physical',
    source: 'player',
    kind: 'bullet',
    statusBuildup: 0,
  };
  const hit = (
    t: Damageable,
    amount: number,
    element: DamageElement = 'physical',
    kind: ImpactKind = 'bullet',
    buildup = element === 'physical' ? 0 : 1,
  ): DamageResult => {
    info.amount = amount;
    info.element = element;
    info.kind = kind;
    info.statusBuildup = buildup;
    return combat.dealDamage(t, info);
  };
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) status.fixedUpdate(DT);
  };
  return {
    events,
    combat,
    status,
    vfx,
    flashes,
    blasts,
    clouds,
    statusEvents,
    comboEvents,
    explosionEvents,
    add,
    hit,
    tick,
  };
}

describe('StatusEffectSystem – build-up', () => {
  it('applied elemental damage × statusBuildup builds up; the threshold triggers the status', () => {
    const h = setup();
    const d = new Dummy(1);
    h.add(d);
    h.hit(d, T.fire - 1, 'fire');
    h.tick();
    expect(h.status.buildupOf(1, 'fire')).toBeCloseTo(T.fire - 1, 3);
    expect(h.status.has(1, 'burn')).toBe(false);
    h.hit(d, 1, 'fire');
    h.tick();
    expect(h.status.has(1, 'burn')).toBe(true);
    expect(h.status.buildupOf(1, 'fire')).toBeCloseTo(0, 3);
    expect(h.statusEvents).toHaveLength(1);
    expect(h.statusEvents[0]).toMatchObject({ targetId: 1, status: 'burn', stacks: 1 });
  });

  it('physical damage and damage without a build-up factor build nothing; the player team is never affected', () => {
    const h = setup();
    const d = new Dummy(1);
    const shield = new Dummy(2, 3, 0, 'neutral');
    const me = new Dummy(3, 6, 0, 'player');
    h.add(d, shield, me);
    h.hit(d, 500, 'physical', 'bullet', 1);
    h.hit(d, 500, 'fire', 'bullet', 0);
    h.hit(shield, 500, 'fire');
    h.hit(me, 500, 'fire');
    h.tick();
    expect(h.status.slots).toBe(0);
  });

  it('build-up decays after the delay without new build-up', () => {
    const h = setup();
    const d = new Dummy(1);
    h.add(d);
    h.hit(d, 50, 'ice');
    h.tick(ticks(ELEMENTS.buildup.decayDelay * 0.9));
    expect(h.status.buildupOf(1, 'ice')).toBeCloseTo(50, 3);
    h.tick(ticks(ELEMENTS.buildup.decayDelay * 0.1 + 0.5));
    expect(h.status.buildupOf(1, 'ice')).toBeLessThan(50 - ELEMENTS.buildup.decayPerSecond * 0.4);
    h.tick(ticks(3));
    expect(h.status.buildupOf(1, 'ice')).toBe(0);
    // Nothing left: the slot is returned.
    expect(h.status.slots).toBe(0);
  });

  it('resistances scale the build-up (0 = immune)', () => {
    const resist: StatusResistDef = { buildup: { fire: 0.5, poison: 0 }, control: 1, slow: 1, freeze: true };
    const h = setup({ resist: { 1: resist } });
    const d = new Dummy(1);
    h.add(d);
    h.hit(d, 60, 'fire');
    h.hit(d, 500, 'poison');
    h.tick();
    expect(h.status.buildupOf(1, 'fire')).toBeCloseTo(30, 3);
    expect(h.status.has(1, 'poisoned')).toBe(false);
  });

  it('applyElement (element procs) builds up directly and credits its weapon', () => {
    const h = setup();
    const d = new Dummy(1);
    h.add(d);
    h.status.applyElement(d, 'fire', T.fire, 'player', 'smg');
    h.tick(ticks(ELEMENTS.dotInterval) + 1);
    expect(h.status.has(1, 'burn')).toBe(true);
    const burn = d.taken.find((x) => x.element === 'fire');
    expect(burn).toMatchObject({ weaponId: 'smg', source: 'player', kind: 'beam' });
  });
});

describe('StatusEffectSystem – statuses', () => {
  it('burn: damage over time (non-discrete kind) for its duration, then it ends', () => {
    const h = setup({ toughness: 2 });
    const d = new Dummy(1);
    h.add(d);
    h.status.applyElement(d, 'fire', T.fire, 'player', 'flamethrower');
    h.tick(ticks(ELEMENTS.burn.duration + 0.5));
    const dot = d.total((x) => x.kind === 'beam' && x.element === 'fire');
    const expected = ELEMENTS.burn.dps * ELEMENTS.burn.duration * 2;
    expect(dot).toBeGreaterThan(expected * 0.85);
    expect(dot).toBeLessThan(expected * 1.15);
    expect(h.status.has(1, 'burn')).toBe(false);
  });

  it('burn spreads a little fire build-up to neighbours with line of sight', () => {
    const h = setup();
    const d = new Dummy(1);
    const near = new Dummy(2, 1.2, 0);
    const far = new Dummy(3, 9, 0);
    h.add(d, near, far);
    h.status.applyElement(d, 'fire', T.fire, 'player');
    h.tick(ticks(ELEMENTS.burn.spread.interval) + 2);
    expect(h.status.buildupOf(2, 'fire')).toBeGreaterThan(0);
    expect(h.status.buildupOf(3, 'fire')).toBe(0);
    // Standing in it long enough ignites the neighbour.
    h.tick(ticks(ELEMENTS.burn.duration));
    expect(h.statusEvents.some((e) => e.targetId === 2 && e.status === 'burn')).toBe(true);
  });

  it('chill stacks slow per stack; a trigger at max stacks freezes (speed 0, incapacitated)', () => {
    const h = setup();
    const d = new Dummy(1);
    h.add(d);
    const C = ELEMENTS.chill;
    for (let i = 1; i <= C.maxStacks; i++) {
      h.status.applyElement(d, 'ice', T.ice, 'player');
      h.tick();
      expect(h.status.stacksOf(1, 'chill')).toBe(i);
      expect(h.status.speedMultiplier(1)).toBeCloseTo(1 - i * C.slowPerStack, 5);
      expect(h.status.incapacitated(1)).toBe(false);
    }
    h.status.applyElement(d, 'ice', T.ice, 'player');
    h.tick();
    expect(h.status.has(1, 'frozen')).toBe(true);
    expect(h.status.has(1, 'chill')).toBe(false);
    expect(h.status.speedMultiplier(1)).toBe(0);
    expect(h.status.incapacitated(1)).toBe(true);
    // Thaws after its duration, keeps a little chill and cannot refreeze right away.
    h.tick(ticks(ELEMENTS.frozen.duration));
    expect(h.status.has(1, 'frozen')).toBe(false);
    expect(h.status.incapacitated(1)).toBe(false);
    expect(h.status.stacksOf(1, 'chill')).toBe(ELEMENTS.frozen.thawStacks);
    for (let i = 0; i < C.maxStacks + 2; i++) {
      h.status.applyElement(d, 'ice', T.ice, 'player');
      h.tick();
    }
    expect(h.status.has(1, 'frozen')).toBe(false);
    expect(h.status.stacksOf(1, 'chill')).toBe(C.maxStacks);
  });

  it('chill thaws one stack at a time after its duration', () => {
    const h = setup();
    const d = new Dummy(1);
    h.add(d);
    for (let i = 0; i < 3; i++) h.status.applyElement(d, 'ice', T.ice, 'player');
    h.tick();
    expect(h.status.stacksOf(1, 'chill')).toBe(3);
    h.tick(ticks(ELEMENTS.chill.duration) + 1);
    expect(h.status.stacksOf(1, 'chill')).toBe(2);
    h.tick(ticks(ELEMENTS.chill.stackDecay) + 1);
    expect(h.status.stacksOf(1, 'chill')).toBe(1);
  });

  it('frozen: a heavy hit shatters it for bonus damage and a burst; light hits do not', () => {
    const h = setup();
    const d = new Dummy(1);
    h.add(d);
    for (let i = 0; i <= ELEMENTS.chill.maxStacks; i++) {
      h.status.applyElement(d, 'ice', T.ice, 'player');
      h.tick();
    }
    expect(h.status.has(1, 'frozen')).toBe(true);
    h.hit(d, 10);
    h.tick();
    expect(h.status.has(1, 'frozen')).toBe(true);
    // A shotgun volley: pellets of one tick add up.
    const S = ELEMENTS.frozen.shatter;
    for (let i = 0; i < 4; i++) h.hit(d, S.minHit / 3, 'physical', 'pellet');
    h.tick();
    expect(h.status.has(1, 'frozen')).toBe(false);
    expect(h.explosionEvents).toHaveLength(1);
    expect(h.explosionEvents[0]).toMatchObject({ element: 'ice', vfx: S.vfx, audio: S.audio });
    const bonus = d.taken.find((x) => x.element === 'ice' && x.kind === 'explosion');
    expect(bonus?.amount).toBeCloseTo(S.damage + (S.hitFraction * (4 * S.minHit)) / 3, 3);
  });

  it('frozen: any blast or melee blow shatters, whatever its damage', () => {
    const h = setup();
    const d = new Dummy(1);
    h.add(d);
    for (let i = 0; i <= ELEMENTS.chill.maxStacks; i++) h.status.applyElement(d, 'ice', T.ice, 'player');
    for (let i = 0; i <= ELEMENTS.chill.maxStacks; i++) h.tick();
    expect(h.status.has(1, 'frozen')).toBe(true);
    h.hit(d, 1, 'physical', 'melee');
    h.tick();
    expect(h.status.has(1, 'frozen')).toBe(false);
    expect(h.status.stats.shatters).toBe(1);
  });

  it('shocked: a short stun, arcs to nearby enemies, stun immunity afterwards', () => {
    const h = setup();
    const d = new Dummy(1);
    const n1 = new Dummy(2, 2, 0);
    const n2 = new Dummy(3, -2, 0);
    const far = new Dummy(4, 20, 0);
    h.add(d, n1, n2, far);
    h.status.applyElement(d, 'shock', T.shock, 'player', 'chainlightning');
    h.tick();
    expect(h.status.has(1, 'shocked')).toBe(true);
    expect(h.status.incapacitated(1)).toBe(true);
    expect(n1.total((x) => x.kind === 'beam' && x.element === 'shock')).toBeGreaterThan(0);
    expect(n2.total((x) => x.kind === 'beam')).toBeGreaterThan(0);
    expect(far.taken).toHaveLength(0);
    expect(h.flashes.length).toBeGreaterThanOrEqual(2);
    expect(h.status.buildupOf(2, 'shock')).toBeGreaterThan(0);
    h.tick(ticks(ELEMENTS.shocked.stun) + 1);
    expect(h.status.incapacitated(1)).toBe(false);
    // Immune: a new shock arcs again but does not stun.
    h.status.applyElement(d, 'shock', T.shock, 'player');
    h.tick();
    expect(h.status.has(1, 'shocked')).toBe(true);
    expect(h.status.incapacitated(1)).toBe(false);
  });

  it('poisoned: stacks up to the max, damage scales with the stacks; a body dies into a cloud', () => {
    const h = setup();
    const d = new Dummy(1, 3, 4);
    h.add(d);
    const P = ELEMENTS.poisoned;
    for (let i = 0; i < P.maxStacks + 2; i++) {
      h.status.applyElement(d, 'poison', T.poison, 'player', 'smg');
      h.tick();
    }
    expect(h.status.stacksOf(1, 'poisoned')).toBe(P.maxStacks);
    const before = d.total();
    h.tick(ticks(1));
    const perSecond = d.total() - before;
    expect(perSecond).toBeGreaterThan(P.dpsPerStack * P.maxStacks * 0.9);
    expect(perSecond).toBeLessThan(P.dpsPerStack * P.maxStacks * 1.1 + 1e-6);
    d.alive = false;
    h.tick();
    expect(h.clouds).toHaveLength(1);
    expect(h.clouds[0]).toMatchObject({ x: 3, z: 4, def: P.cloud.field });
    expect(h.clouds[0]!.from).toMatchObject({
      weaponId: 'smg',
      source: 'player',
      statusBuildup: P.cloud.statusBuildup,
    });
    expect(h.status.slots).toBe(0);
  });

  it('a dying horde leaves at most maxActive clouds at once', () => {
    const h = setup();
    const ds: Dummy[] = [];
    for (let i = 0; i < ELEMENTS.poisoned.cloud.maxActive + 4; i++) ds.push(new Dummy(i + 1, i * 10, 0));
    h.add(...ds);
    for (const d of ds) h.status.applyElement(d, 'poison', T.poison * 3, 'player');
    h.tick(3);
    for (const d of ds) d.alive = false;
    h.tick();
    expect(h.clouds).toHaveLength(ELEMENTS.poisoned.cloud.maxActive);
  });

  it('no cloud below the minimum stacks', () => {
    const h = setup();
    const d = new Dummy(1);
    h.add(d);
    h.status.applyElement(d, 'poison', T.poison, 'player');
    h.tick();
    d.alive = false;
    h.tick();
    expect(h.clouds).toHaveLength(0);
  });

  it('void mark: damage taken up through CombatWorld; more void implodes it', () => {
    const h = setup({ toughness: 1.5 });
    const d = new Dummy(1);
    h.add(d);
    h.status.applyElement(d, 'void', T.void, 'player', 'blackhole');
    h.tick();
    expect(h.status.has(1, 'voidMark')).toBe(true);
    expect(h.status.damageTakenMultiplier(1)).toBe(ELEMENTS.voidMark.damageTaken);
    const r = h.hit(d, 100);
    expect(r.applied).toBeCloseTo(100 * ELEMENTS.voidMark.damageTaken, 5);
    h.status.applyElement(d, 'void', ELEMENTS.voidMark.implode.charge, 'player', 'blackhole');
    h.tick();
    expect(h.blasts).toHaveLength(1);
    expect(h.blasts[0]!.def).toBe(ELEMENTS.voidMark.implode.explosion);
    expect(h.blasts[0]!.from).toMatchObject({ weaponId: 'blackhole', areaScale: 1.5, statusBuildup: 0 });
    expect(h.status.has(1, 'voidMark')).toBe(false);
    expect(h.status.damageTakenMultiplier(1)).toBe(1);
  });

  it('bosses resist: no freeze, shorter stuns', () => {
    const h = setup({ resist: { 1: STATUS_RESIST.boss, 2: STATUS_RESIST.boss } });
    const d = new Dummy(1);
    h.add(d);
    for (let i = 0; i < 20; i++) {
      h.status.applyElement(d, 'ice', T.ice / (STATUS_RESIST.boss.buildup.ice ?? 1), 'player');
      h.tick();
    }
    expect(h.status.has(1, 'frozen')).toBe(false);
    expect(h.status.stacksOf(1, 'chill')).toBe(ELEMENTS.chill.maxStacks);
    expect(h.status.speedMultiplier(1)).toBeCloseTo(
      1 - ELEMENTS.chill.maxStacks * ELEMENTS.chill.slowPerStack * STATUS_RESIST.boss.slow,
      5,
    );
    // A second boss (no chill: no superconductor stun on top).
    const e = new Dummy(2, 20, 0);
    h.add(e);
    h.status.applyElement(e, 'shock', T.shock / (STATUS_RESIST.boss.buildup.shock ?? 1), 'player');
    h.tick();
    expect(h.status.incapacitated(2)).toBe(true);
    h.tick(ticks(ELEMENTS.shocked.stun * STATUS_RESIST.boss.control) + 1);
    expect(h.status.incapacitated(2)).toBe(false);
  });

  it('rim: the highest-priority status tints, pulsing within 0..1', () => {
    const h = setup();
    const d = new Dummy(1);
    h.add(d);
    const out = { color: 0, strength: 0 };
    expect(h.status.rimFor(1, out)).toBe(false);
    h.status.applyElement(d, 'poison', T.poison, 'player');
    h.tick();
    expect(h.status.rimFor(1, out)).toBe(true);
    expect(out.color).toBe(ELEMENTS.rim.poisoned.color);
    h.status.applyElement(d, 'void', T.void, 'player');
    h.tick();
    // void + poison react (voidrupture consumes the mark) – burn outranks poison without reacting.
    h.status.applyElement(d, 'fire', T.fire, 'player');
    h.tick();
    h.status.rimFor(1, out);
    expect([ELEMENTS.rim.burn.color, ELEMENTS.rim.poisoned.color]).toContain(out.color);
    for (let i = 0; i < 30; i++) {
      h.tick();
      if (h.status.rimFor(1, out)) {
        expect(out.strength).toBeGreaterThanOrEqual(0);
        expect(out.strength).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('StatusEffectSystem – combos', () => {
  const pairs: [string, DamageElement, DamageElement][] = [
    ['thermoshock', 'fire', 'ice'],
    ['neurotoxin', 'shock', 'poison'],
    ['toxicblaze', 'fire', 'poison'],
    ['superconductor', 'ice', 'shock'],
    ['voidrupture', 'void', 'fire'],
  ];

  for (const [combo, a, b] of pairs) {
    it(`${combo}: ${a} + ${b} react (combat:combo, VFX, damage)`, () => {
      const h = setup();
      const d = new Dummy(1);
      const n = new Dummy(2, 1.5, 0);
      h.add(d, n);
      h.status.applyElement(d, a, T[a as 'fire'], 'player', 'w');
      h.tick();
      expect(h.comboEvents).toHaveLength(0);
      const before = d.total();
      h.status.applyElement(d, b, T[b as 'fire'], 'player', 'w');
      h.tick();
      expect(h.comboEvents.map((e) => e.combo)).toEqual([combo]);
      expect(h.comboEvents[0]!.targetId).toBe(1);
      expect(h.vfx).toContain(`combo.${combo}`);
      expect(d.total() - before).toBeGreaterThan(0);
      const def = COMBOS.find((c) => c.id === combo)!;
      for (const st of def.consume) expect(h.status.has(1, st)).toBe(false);
    });
  }

  it('thermoshock on a frozen target hits harder than on a chilled one', () => {
    const run = (freeze: boolean): number => {
      const h = setup();
      const d = new Dummy(1);
      h.add(d);
      const n = freeze ? ELEMENTS.chill.maxStacks + 1 : 1;
      for (let i = 0; i < n; i++) {
        h.status.applyElement(d, 'ice', T.ice, 'player');
        h.tick();
      }
      expect(h.status.has(1, freeze ? 'frozen' : 'chill')).toBe(true);
      h.status.applyElement(d, 'fire', T.fire, 'player');
      h.tick();
      return d.total((x) => x.kind === 'explosion');
    };
    const def = COMBOS.find((c) => c.id === 'thermoshock')!;
    expect(run(true)).toBeCloseTo(run(false) * def.frozenBonus!, 3);
  });

  it('neurotoxin stuns and spreads poison; superconductor arcs chill to neighbours', () => {
    const h = setup();
    const d = new Dummy(1);
    const n = new Dummy(2, 2, 0);
    h.add(d, n);
    h.status.applyElement(d, 'poison', T.poison, 'player');
    h.tick();
    h.status.applyElement(d, 'shock', T.shock, 'player');
    h.tick();
    expect(h.comboEvents.map((e) => e.combo)).toEqual(['neurotoxin']);
    expect(h.status.incapacitated(1)).toBe(true);
    expect(h.status.buildupOf(2, 'poison')).toBeGreaterThan(0);
    h.tick(ticks(1.5));
    expect(h.status.incapacitated(1)).toBe(true);

    const g = setup();
    const e = new Dummy(1);
    const m = new Dummy(2, 4, 0);
    g.add(e, m);
    g.status.applyElement(e, 'ice', T.ice, 'player');
    g.tick();
    g.status.applyElement(e, 'shock', T.shock, 'player');
    g.tick();
    expect(g.comboEvents.map((x) => x.combo)).toEqual(['superconductor']);
    expect(g.status.buildupOf(2, 'ice') + g.status.stacksOf(2, 'chill')).toBeGreaterThan(0);
    expect(m.total((x) => x.kind === 'beam')).toBeGreaterThan(0);
  });

  it('voidrupture amplifies the other statuses (refreshed, stronger damage over time)', () => {
    const plain = setup();
    const a = new Dummy(1);
    plain.add(a);
    plain.status.applyElement(a, 'poison', T.poison, 'player');
    plain.tick(ticks(2));
    const amped = setup();
    const b = new Dummy(1);
    amped.add(b);
    amped.status.applyElement(b, 'poison', T.poison, 'player');
    amped.status.applyElement(b, 'void', T.void, 'player');
    amped.tick(ticks(2));
    expect(amped.comboEvents.map((x) => x.combo)).toEqual(['voidrupture']);
    const dotA = a.total((x) => x.kind === 'beam');
    const dotB = b.total((x) => x.kind === 'beam');
    expect(dotB).toBeGreaterThan(dotA * 1.5);
  });

  it('per-target cooldown and per-tick budget', () => {
    const h = setup();
    const ds: Dummy[] = [];
    for (let i = 0; i < ELEMENTS.combos.perTick + 3; i++) ds.push(new Dummy(i + 1, i * 30, 0));
    h.add(...ds);
    for (const d of ds) h.status.applyElement(d, 'poison', T.poison, 'player');
    h.tick();
    for (const d of ds) h.status.applyElement(d, 'fire', T.fire, 'player');
    h.tick();
    expect(h.comboEvents).toHaveLength(ELEMENTS.combos.perTick);
    h.tick();
    expect(h.comboEvents).toHaveLength(ds.length);
    // The same target cannot react again within the cooldown.
    const d = ds[0]!;
    h.status.applyElement(d, 'poison', T.poison, 'player');
    h.status.applyElement(d, 'fire', T.fire, 'player');
    h.tick();
    expect(h.comboEvents.filter((e) => e.targetId === d.id)).toHaveLength(1);
    h.tick(ticks(ELEMENTS.combos.cooldown));
    expect(h.comboEvents.filter((e) => e.targetId === d.id)).toHaveLength(2);
  });
});

describe('StatusEffectSystem – lifecycle', () => {
  it('status damage over time never builds up statuses itself; kills credit the applying weapon', () => {
    const h = setup();
    const d = new Dummy(1, 0, 0, 'enemy', 30);
    h.add(d);
    const kills: GameEvents['combat:kill'][] = [];
    h.events.on('combat:kill', (e) => void kills.push({ ...e, position: { ...e.position } }));
    h.status.applyElement(d, 'fire', T.fire, 'player', 'flamethrower');
    h.tick(ticks(ELEMENTS.burn.duration));
    expect(d.alive).toBe(false);
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({ targetId: 1, weaponId: 'flamethrower', source: 'player' });
    h.tick();
    expect(h.status.slots).toBe(0);
  });

  it('reset / clear drop everything without effects', () => {
    const h = setup();
    const a = new Dummy(1);
    const b = new Dummy(2, 5, 0);
    h.add(a, b);
    for (let i = 0; i < 3; i++) h.status.applyElement(a, 'poison', T.poison, 'player');
    h.status.applyElement(b, 'fire', T.fire, 'player');
    h.tick();
    expect(h.status.slots).toBe(2);
    h.status.clear(2);
    expect(h.status.has(2, 'burn')).toBe(false);
    expect(h.status.slots).toBe(1);
    h.status.reset();
    expect(h.status.slots).toBe(0);
    a.alive = false;
    h.tick();
    expect(h.clouds).toHaveLength(0);
    expect(h.status.speedMultiplier(1)).toBe(1);
    expect(h.status.incapacitated(1)).toBe(false);
    expect(h.status.damageTakenMultiplier(1)).toBe(1);
  });

  it('a pooled record reusing an id starts over; a full pool refuses quietly', () => {
    const h = setup({ capacity: 2 });
    const a = new Dummy(1);
    const b = new Dummy(2, 5, 0);
    const c = new Dummy(3, 10, 0);
    h.add(a, b, c);
    h.status.applyElement(a, 'fire', T.fire, 'player');
    h.status.applyElement(b, 'fire', T.fire, 'player');
    h.status.applyElement(c, 'fire', T.fire, 'player');
    expect(h.status.stats.refused).toBe(1);
    h.tick();
    expect(h.status.has(3, 'burn')).toBe(false);
    const again = new Dummy(1, 0, 0);
    h.status.applyElement(again, 'poison', 1, 'player');
    expect(h.status.has(1, 'burn')).toBe(false);
    expect(h.status.buildupOf(1, 'poison')).toBe(1);
  });

  it('does not allocate per tick: payloads, lists and slots are reused', () => {
    const h = setup();
    const ds: Dummy[] = [];
    for (let i = 0; i < 40; i++) ds.push(new Dummy(i + 1, (i % 8) * 1.2, Math.floor(i / 8) * 1.2));
    h.add(...ds);
    const payloads = new Set<object>();
    h.events.on('combat:status', (e) => void payloads.add(e));
    h.events.on('combat:combo', (e) => void payloads.add(e));
    const els: DamageElement[] = ['fire', 'ice', 'shock', 'poison', 'void'];
    for (let k = 0; k < 600; k++) {
      const d = ds[k % ds.length]!;
      h.status.applyElement(d, els[k % els.length]!, 40, 'player');
      h.tick();
    }
    // One reused object per event kind.
    expect(payloads.size).toBeLessThanOrEqual(2);
    expect(h.status.slots).toBeLessThanOrEqual(h.status.capacity);
    expect(h.status.stats.triggers).toBeGreaterThan(50);
    expect(h.status.stats.combos).toBeGreaterThan(5);
  });
});
