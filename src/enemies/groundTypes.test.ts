/**
 * M6 ground package behaviour on the enemy harness (fake nav, real combat rays): the exploder rushes,
 * fuses and self-destructs (no credit) or bursts when shot (credit, chain reactions); the berserker
 * chains its cleave combo, enrages (roar, speed, glow, no stagger); the leaper pounces – over low
 * cover – and slashes after landing; mites die to anything; telegraph lights fire at the wind-up.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DamageInfo, VfxApi } from '../core/contracts';
import type { GameEvents } from '../core/events';
import { getEnemyDef } from '../defs/enemies';
import type { Enemy } from './Enemy';
import { DT, createEnemyHarness } from './testFakes';

type Harness = ReturnType<typeof createEnemyHarness>;

function info(amount: number, zone: DamageInfo['zone'] = 'body', kind: DamageInfo['kind'] = 'bullet'): DamageInfo {
  return {
    amount,
    zone,
    point: { x: 0, y: 1, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    weaponId: 'rifle',
    element: 'physical',
    source: 'player',
    kind,
  };
}

function enemyById(h: Harness, id: number): Enemy {
  const e = h.manager.enemies.find((x) => x.id === id);
  if (!e) throw new Error(`enemy ${id} not found`);
  return e;
}

const seconds = (s: number): number => Math.round(s / DT);

function spawn(h: Harness, type: string, x: number, z: number): Enemy {
  const id = h.manager.spawn(type, { x, y: 0, z });
  expect(id, type).not.toBeNull();
  return enemyById(h, id!);
}

/** Tick until `pred` holds (max `limit` s); returns whether it did. */
function tickUntil(h: Harness, pred: () => boolean, limit: number): boolean {
  for (let i = 0; i < seconds(limit); i++) {
    if (pred()) return true;
    h.tick(1);
  }
  return pred();
}

function attacks(h: Harness, id?: number): string[] {
  return (h.byType('enemy:attack') as GameEvents['enemy:attack'][])
    .filter((a) => id === undefined || a.id === id)
    .map((a) => a.attack);
}

function died(h: Harness): GameEvents['enemy:died'][] {
  return h.byType('enemy:died') as GameEvents['enemy:died'][];
}

function explosions(h: Harness): GameEvents['combat:explosion'][] {
  const out: GameEvents['combat:explosion'][] = [];
  h.events.on('combat:explosion', (e) => out.push({ ...e, position: { ...e.position } }));
  return out;
}

describe('Explodierer', () => {
  it('rushes the player, fuses and self-destructs: a real blast that hurts, credited to nobody', () => {
    const h = createEnemyHarness();
    const booms = explosions(h);
    const e = spawn(h, 'exploder', 0, -12);
    expect(tickUntil(h, () => died(h).length > 0, 12)).toBe(true);
    expect(attacks(h, e.id)).toEqual(['fuse']);
    expect(died(h)[0]).toMatchObject({ id: e.id, type: 'exploder', source: 'enemy', weaponId: 'exploder' });
    expect(h.byType('combat:kill')).toHaveLength(0);
    expect(booms).toHaveLength(1);
    expect(booms[0]!.element).toBe('fire');
    expect(booms[0]!.radius).toBeCloseTo(getEnemyDef('exploder')!.death.burst!.radius);
    expect(h.player.totalDamage).toBeGreaterThan(0);
    expect(h.manager.alive).toBe(0);
  });

  it('the proximity warning blinks faster and brighter only when the target is close', () => {
    const h = createEnemyHarness();
    h.manager.aiEnabled = false;
    const e = spawn(h, 'exploder', 0, -30);
    h.tick(seconds(1.5));
    let peakFar = 0;
    for (let i = 0; i < 60; i++) {
      h.tick(1);
      peakFar = Math.max(peakFar, e.pose.glow);
    }
    expect(peakFar).toBe(0);
    h.player.setPosition(0, 0, -26);
    let peakNear = 0;
    let dark = false;
    for (let i = 0; i < 90; i++) {
      h.tick(1);
      peakNear = Math.max(peakNear, e.pose.glow);
      if (e.pose.glow < 0.05) dark = true;
    }
    expect(peakNear).toBeGreaterThan(0.5);
    expect(dark).toBe(true); // it blinks, not just glows
  });

  it('a shot in the sac bursts it early – credited, and the burst chains through the pack', () => {
    const h = createEnemyHarness();
    h.manager.aiEnabled = false;
    const booms = explosions(h);
    const a = spawn(h, 'exploder', 0, -14);
    const b = spawn(h, 'exploder', 1.8, -14);
    const s = spawn(h, 'swarmer', -1.8, -14);
    const mite = spawn(h, 'mite', 0, -16);
    h.tick(seconds(1.5));
    // One rifle bullet in the sac (weapon ×2.5 weakpoint already in the amount).
    expect(h.combat.dealDamage(a, info(28 * 2.5, 'weakpoint')).killed).toBe(true);
    h.tick(2);
    const ids = new Set(died(h).map((d) => d.id));
    for (const e of [a, b, s, mite]) expect(ids.has(e.id), e.type).toBe(true);
    for (const d of died(h)) expect(d.source, d.type).toBe('player');
    expect(booms).toHaveLength(2);
    // Too far away to be hurt.
    expect(h.player.totalDamage).toBe(0);
  });

  it('the nuke kills it without a blast', () => {
    const h = createEnemyHarness();
    const booms = explosions(h);
    spawn(h, 'exploder', 0, -3);
    h.tick(2);
    expect(h.manager.killAll(true)).toBe(1);
    h.tick(2);
    expect(booms).toHaveLength(0);
    expect(h.player.totalDamage).toBe(0);
  });
});

describe('Berserker', () => {
  it('chains cleave → backhand → crush while the player stays in reach', () => {
    const h = createEnemyHarness();
    const e = spawn(h, 'berserker', 0, -2.2);
    expect(tickUntil(h, () => attacks(h, e.id).length >= 3, 10)).toBe(true);
    expect(attacks(h, e.id).slice(0, 3)).toEqual(['cleave', 'backhand', 'crush']);
    h.tick(seconds(0.8));
    expect(h.player.hits.length).toBeGreaterThanOrEqual(3);
  });

  it('the combo breaks when the player leaves the reach', () => {
    const h = createEnemyHarness();
    const e = spawn(h, 'berserker', 0, -2.2);
    expect(tickUntil(h, () => attacks(h, e.id).includes('cleave'), 10)).toBe(true);
    h.player.setPosition(0, 0, 9);
    h.tick(seconds(1.5));
    expect(attacks(h, e.id)).not.toContain('backhand');
  });

  it('enrages below half health: roar, faster, glowing, never staggered', () => {
    const h = createEnemyHarness();
    const d = getEnemyDef('berserker')!;
    const e = spawn(h, 'berserker', 0, -25);
    const calm = spawn(h, 'berserker', 6, -25);
    h.tick(seconds(d.emergeTime) + 2);
    // Before the enrage a heavy volley staggers.
    h.combat.dealDamage(calm, info(d.stagger.threshold + 10));
    h.tick(1);
    expect(calm.state).toBe('stagger');
    expect(calm.enraged).toBe(false);

    const speed = e.speedMult;
    h.combat.dealDamage(e, info(e.maxHealth * 0.55));
    h.tick(1);
    expect(e.enraged).toBe(true);
    expect(e.state).toBe('attack');
    expect(attacks(h, e.id)).toContain('roar');
    expect(e.speedMult).toBeCloseTo(speed * d.enrage!.speedMultiplier);
    expect(e.attackRate).toBeCloseTo(d.enrage!.attackRate);
    expect(e.pose.glow).toBeCloseTo(d.enrage!.glow);
    h.combat.dealDamage(e, info(d.stagger.threshold * 1.5));
    h.tick(2);
    expect(e.state).not.toBe('stagger');
    expect(h.byType('enemy:staggered').filter((s) => (s as { id: number }).id === e.id)).toHaveLength(0);
  });
});

describe('Springer', () => {
  it('pounces from far and slashes right after landing', () => {
    const h = createEnemyHarness();
    const e = spawn(h, 'leaper', 0, -10);
    expect(tickUntil(h, () => attacks(h, e.id).includes('pounce'), 12)).toBe(true);
    expect(tickUntil(h, () => attacks(h, e.id).length >= 2, 3)).toBe(true);
    expect(attacks(h, e.id).slice(0, 2)).toEqual(['pounce', 'slash']);
    h.tick(seconds(0.6));
    expect(h.player.totalDamage).toBeGreaterThan(0);
  });

  it('clears low cover between it and the player (arc lane)', () => {
    // A 1.2 m crate wall: above the body-height lane ray, well below the arc.
    const h = createEnemyHarness({ boxes: [{ center: { x: 0, y: 0.6, z: -5 }, size: { x: 6, y: 1.2, z: 0.5 } }] });
    const e = spawn(h, 'leaper', 0, -10);
    h.manager.aiEnabled = false;
    h.tick(seconds(1.2));
    h.manager.aiEnabled = true;
    // The fake nav walks through walls: hold the leaper behind the crates until it pounces.
    let pounced = false;
    for (let i = 0; i < seconds(10) && !pounced; i++) {
      if (e.override !== 'leap') {
        e.position.set(0, 0, -10);
        e.agentDirty = true;
      }
      h.tick(1);
      pounced = e.override === 'leap';
    }
    expect(pounced).toBe(true);
    expect(tickUntil(h, () => e.override !== 'leap', 2)).toBe(true);
    expect(e.position.z).toBeGreaterThan(-5);
  });
});

describe('Milbe', () => {
  it('dies to a single pellet anywhere', () => {
    const h = createEnemyHarness();
    const e = spawn(h, 'mite', 0, -8);
    h.tick(seconds(1));
    expect(h.combat.dealDamage(e, info(11 * 0.75, 'limb', 'pellet')).killed).toBe(true);
  });
});

describe('telegraph VFX', () => {
  it('spawn at the wind-up start (fuse light at the sac)', () => {
    const spawnFx = vi.fn();
    const vfx = { spawn: spawnFx } as unknown as VfxApi;
    const h = createEnemyHarness({ manager: { vfx } });
    const e = spawn(h, 'exploder', 0, -6);
    expect(tickUntil(h, () => attacks(h, e.id).includes('fuse'), 8)).toBe(true);
    const ids = spawnFx.mock.calls.map((c) => c[0] as string);
    expect(ids).toContain('enemy.telegraph.fuse');
  });
});
