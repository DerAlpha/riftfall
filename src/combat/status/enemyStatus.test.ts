/**
 * Status effects on real enemies (EnemyManager + CombatWorld + StatusEffectSystem wired like Game):
 * frozen / stunned enemies halt, chill and slow fields slow movement, pull fields drag bodies, the
 * pose rim shows the status, damage over time kills with credit.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { Vec3Like } from '../../core/events';
import { ELEMENTS, statusResistFor } from '../../defs/elements';
import { ENEMY_AI } from '../../defs/enemies';
import type { Enemy } from '../../enemies/Enemy';
import { DT, createEnemyHarness } from '../../enemies/testFakes';
import { StatusEffectSystem } from './StatusEffectSystem';

const T = ELEMENTS.buildup.threshold;
const seconds = (s: number): number => Math.round(s / DT);

class FakeFields {
  center: Vector3 | null = null;
  radius = 6;
  speed = 6;
  slow = 1;
  pullAt(p: Vec3Like, out: Vector3): boolean {
    out.set(0, 0, 0);
    const c = this.center;
    if (!c) return false;
    const dx = c.x - p.x;
    const dz = c.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > this.radius) return false;
    if (d > 1e-3) out.set((dx / d) * this.speed * Math.min(1, d), 0, (dz / d) * this.speed * Math.min(1, d));
    return true;
  }
  slowAt(): number {
    return this.slow;
  }
}

function setup(player: Vec3Like = { x: 0, y: 0, z: 0 }) {
  const h = createEnemyHarness({ player });
  const status = new StatusEffectSystem({
    events: h.events,
    combat: h.combat,
    profile: (t, out) => {
      const e = h.manager.getEnemy(t.id);
      if (!e) return false;
      out.resist = statusResistFor(e.type, e.def.boss);
      out.healthScale = e.maxHealth / e.def.health;
      return true;
    },
  });
  const fields = new FakeFields();
  h.combat.setStatus(status);
  h.manager.setStatus(status);
  h.manager.setFields(fields);
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      h.tick(1);
      status.fixedUpdate(DT);
    }
  };
  const spawn = (type: string, x: number, z: number): Enemy => {
    const id = h.manager.spawn(type, { x, y: 0, z })!;
    return h.manager.enemies.find((e) => e.id === id)!;
  };
  const freeze = (e: Enemy): void => {
    for (let i = 0; i <= ELEMENTS.chill.maxStacks; i++) {
      status.applyElement(e, 'ice', T.ice / (statusResistFor(e.type).buildup.ice ?? 1), 'player', 'rifle');
      tick();
    }
  };
  return { ...h, status, fields, tick, spawn, freeze };
}

describe('enemies under status effects', () => {
  it('a frozen enemy holds still and does not attack; it moves again after thawing', () => {
    const h = setup();
    const e = h.spawn('swarmer', 0, -1.4);
    h.tick(seconds(1.5));
    expect(e.state === 'active' || e.state === 'attack').toBe(true);
    h.freeze(e);
    expect(h.status.has(e.id, 'frozen')).toBe(true);
    const hitsBefore = h.player.hits.length;
    const at = e.position.clone();
    h.tick(seconds(ELEMENTS.frozen.duration * 0.9));
    expect(e.halted).toBe(true);
    expect(e.state).toBe('active');
    expect(e.position.distanceTo(at)).toBeLessThan(0.05);
    expect(h.player.hits.length).toBe(hitsBefore);
    h.tick(seconds(ELEMENTS.frozen.duration * 0.2) + 2);
    expect(e.halted).toBe(false);
    h.tick(seconds(3));
    expect(h.player.hits.length).toBeGreaterThan(hitsBefore);
  });

  it('chill stacks and slow fields scale the movement speed sent to the crowd', () => {
    const h = setup();
    const e = h.spawn('swarmer', 0, -25);
    h.tick(seconds(1.5));
    expect(e.hasMove).toBe(true);
    const base = e.moveSpeed;
    expect(base).toBeGreaterThan(0);
    h.status.applyElement(e, 'ice', T.ice * 2, 'player');
    h.tick(3);
    expect(h.status.stacksOf(e.id, 'chill')).toBe(2);
    expect(e.statusSpeed).toBeCloseTo(1 - 2 * ELEMENTS.chill.slowPerStack, 5);
    expect(e.moveSpeed / base).toBeCloseTo(e.statusSpeed, 2);
    h.fields.slow = 0.5;
    h.tick(2);
    expect(e.statusSpeed).toBeCloseTo((1 - 2 * ELEMENTS.chill.slowPerStack) * 0.5, 5);
  });

  it('a pull field drags a caught body towards its center; it walks on once released', () => {
    const h = setup({ x: 0, y: 0, z: 30 });
    const e = h.spawn('swarmer', 0, 0);
    h.tick(seconds(1.5));
    const start = e.position.clone();
    h.fields.center = new Vector3(start.x + 4, 1, start.z);
    h.tick(seconds(0.6));
    expect(e.override).toBe('knockback');
    expect(e.position.x - start.x).toBeGreaterThan(1.5);
    h.tick(seconds(1));
    expect(e.position.distanceTo(new Vector3(start.x + 4, e.position.y, start.z))).toBeLessThan(1);
    h.fields.center = null;
    h.tick(seconds(1.5));
    expect(e.override).toBe('none');
  });

  it('the rim shows the status tint, the elite rim returns afterwards; shocked bodies twitch', () => {
    const h = setup({ x: 0, y: 0, z: 30 });
    const id = h.manager.spawn('swarmer', { x: 0, y: 0, z: 0 }, { affixes: ['test'] })!;
    const e = h.manager.enemies.find((x) => x.id === id)!;
    h.tick(seconds(1.5));
    const E = ENEMY_AI.elite;
    expect(e.pose.rim).toBe(E.rim);
    h.status.applyElement(e, 'fire', T.fire, 'player');
    h.tick(2);
    const c = ELEMENTS.rim.burn.color;
    expect(e.pose.rimColor.r).toBeCloseTo(((c >> 16) & 255) / 255, 5);
    expect(e.pose.rim).toBeGreaterThan(0);
    h.tick(seconds(ELEMENTS.burn.duration) + 2);
    expect(e.pose.rim).toBe(E.rim);
    expect(e.pose.rimColor.r).toBeCloseTo(E.rimColor[0], 5);
    h.status.applyElement(e, 'shock', T.shock, 'player');
    let maxStagger = 0;
    for (let i = 0; i < 20; i++) {
      h.tick();
      maxStagger = Math.max(maxStagger, e.pose.stagger);
    }
    expect(maxStagger).toBeGreaterThan(ELEMENTS.twitch.amplitude * 0.5);
  });

  it('void mark: enemies take more damage; burn kills credit the weapon and free the slot', () => {
    const h = setup({ x: 0, y: 0, z: 30 });
    const e = h.spawn('swarmer', 0, 0);
    h.tick(seconds(1.5));
    h.status.applyElement(e, 'void', T.void, 'player', 'blackhole');
    h.tick();
    const hp = e.health;
    h.combat.dealDamage(e, {
      amount: 10,
      zone: 'body',
      point: e.boundsCenter,
      direction: { x: 0, y: 0, z: -1 },
      weaponId: 'rifle',
      element: 'physical',
      source: 'player',
      kind: 'bullet',
    });
    expect(hp - e.health).toBeCloseTo(10 * ELEMENTS.voidMark.damageTaken, 5);

    const f = h.spawn('swarmer', 3, 0);
    h.tick(seconds(1.5));
    f.health = 5;
    h.status.applyElement(f, 'fire', T.fire, 'player', 'flamethrower');
    h.tick(seconds(ELEMENTS.dotInterval) + 3);
    expect(f.alive).toBe(false);
    const died = h.byType('enemy:died') as { id: number; weaponId: string }[];
    expect(died.find((d) => d.id === f.id)?.weaponId).toBe('flamethrower');
    h.tick(2);
    expect(h.status.has(f.id, 'burn')).toBe(false);
  });
});
