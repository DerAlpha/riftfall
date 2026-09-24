import { describe, expect, it } from 'vitest';
import { POSTFX } from './postfx';
import { ENEMY_AI } from './enemies';
import { ENEMY_RENDER, ENEMY_VISUALS, attackAnimIndex, getEnemyVisualDef } from './enemyVisuals';
import { getEffectPreset } from './vfx';
import { WAVES } from './waves';

const luminance = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
const bloom = POSTFX.bloom.luminanceThreshold + POSTFX.bloom.luminanceSmoothing;

describe('enemy visual defs', () => {
  it('instance pools hold the living enemies a wave allows plus the ones still dying', () => {
    // A dying enemy keeps its instance slot until it has dissolved: a pool sized to the alive cap
    // blocks every refill of a full wave (the director waits) for a death + dissolve duration.
    const headroom = (n: number): number => n + Math.max(4, Math.ceil(n * 0.2));
    const alive = ENEMY_AI.capacity;
    for (const mode of Object.values(WAVES)) {
      const fillers = mode.types;
      const maxWeight = (id: string): number => fillers.find((t) => t.id === id)?.weight.max ?? 0;
      const weightSum = fillers.reduce((sum, t) => sum + t.weight.max, 0);
      for (const t of fillers) {
        // Swarm waves spawn their types only: every living enemy may be one of them.
        const swarm: readonly string[] = mode.swarm?.types ?? [];
        const share = swarm.includes(t.id) ? 1 : maxWeight(t.id) / weightSum;
        const def = getEnemyVisualDef(t.id)!;
        expect(def.capacity, `${mode.id}: ${t.id}`).toBeGreaterThanOrEqual(
          headroom(Math.ceil(alive * share)),
        );
      }
      for (const sp of mode.specials) {
        const def = getEnemyVisualDef(sp.id)!;
        expect(def.capacity, `${mode.id}: ${sp.id}`).toBeGreaterThanOrEqual(headroom(sp.count.max));
      }
    }
  });

  it('attack sockets and aim sockets exist', () => {
    expect(ENEMY_VISUALS.swarmer.sockets.jaws).toBeDefined();
    expect(ENEMY_VISUALS.spitter.sockets.mouth).toBeDefined();
    expect(ENEMY_VISUALS.tank.sockets.fists?.length).toBe(2);
    for (const [id, def] of Object.entries(ENEMY_VISUALS)) {
      expect(def.sockets[def.aimSocket], id).toBeDefined();
      expect(def.sockets[def.effects.deathSocket], id).toBeDefined();
    }
  });

  it('hit zones: swarmer head, spitter sac weakpoint, tank back core weakpoint + front armor shields', () => {
    const zones = (id: keyof typeof ENEMY_VISUALS): string[] => ENEMY_VISUALS[id].hitboxes.map((h) => h.zone);
    expect(zones('swarmer')).toContain('head');
    const sac = ENEMY_VISUALS.spitter.hitboxes.find((h) => h.zone === 'weakpoint')!;
    expect(sac.bone).toBe('sac');
    const tank = ENEMY_VISUALS.tank.hitboxes;
    const core = tank.find((h) => h.zone === 'weakpoint')!;
    expect(core.a[2]).toBeLessThan(-0.3);
    const shields = tank.filter((h) => h.zone === 'shield');
    expect(shields.length).toBeGreaterThanOrEqual(3);
    for (const s of shields) expect(Math.min(s.a[2], s.b?.[2] ?? s.a[2])).toBeGreaterThan(0.2);
    for (const id of Object.keys(ENEMY_VISUALS) as (keyof typeof ENEMY_VISUALS)[]) {
      expect(zones(id), id).toContain('body');
    }
  });

  it('glowing organs and eyes are HDR enough to bloom; veins can bloom when pulsing', () => {
    for (const [id, def] of Object.entries(ENEMY_VISUALS)) {
      for (const [name, z] of Object.entries(def.zones)) {
        if (z.glow > 0.5)
          expect(luminance(z.emissive) * z.emissiveIntensity * z.glow, `${id}:${name}`).toBeGreaterThan(
            bloom,
          );
        if (z.veins > 0.4)
          expect(luminance(z.emissive) * z.emissiveIntensity * z.veins, `${id}:${name}`).toBeGreaterThan(
            bloom * 0.5,
          );
      }
      expect(luminance(def.rift.color) * def.rift.intensity, id).toBeGreaterThan(bloom);
      expect(luminance(def.dissolve.edgeColor) * def.dissolve.edgeIntensity, id).toBeGreaterThan(bloom);
    }
  });

  it('effects reference existing VFX presets; attack animation ids are unique', () => {
    for (const [id, def] of Object.entries(ENEMY_VISUALS)) {
      expect(getEffectPreset(def.effects.spawn), id).toBeDefined();
      expect(getEffectPreset(def.effects.death), id).toBeDefined();
      const ids = def.attacks.map((a) => a.id);
      expect(new Set(ids).size, id).toBe(ids.length);
      ids.forEach((a, i) => expect(attackAnimIndex(id, a)).toBe(i));
    }
    expect(attackAnimIndex('swarmer', 'unknown')).toBe(-1);
    expect(attackAnimIndex('unknown', 'bite')).toBe(-1);
    expect(getEnemyVisualDef('toString')).toBeUndefined();
  });

  it('oscillators complete whole cycles per animation clock wrap (no pop when the clock wraps)', () => {
    for (const [id, def] of Object.entries(ENEMY_VISUALS)) {
      for (const b of def.bones) {
        for (const m of b.motions ?? []) {
          if (m.drive === 'gait' || !m.freq) continue;
          const cycles = m.freq * ENEMY_RENDER.timeWrap;
          expect(Math.abs(cycles - Math.round(cycles)), `${id}:${b.name}:${m.ch}`).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('spec attacks exist: swarmer leap/bite, spitter spit, tank charge/slam', () => {
    expect(attackAnimIndex('swarmer', 'leap')).toBeGreaterThanOrEqual(0);
    expect(attackAnimIndex('swarmer', 'bite')).toBeGreaterThanOrEqual(0);
    expect(attackAnimIndex('spitter', 'spit')).toBeGreaterThanOrEqual(0);
    expect(attackAnimIndex('tank', 'charge')).toBeGreaterThanOrEqual(0);
    expect(attackAnimIndex('tank', 'slam')).toBeGreaterThanOrEqual(0);
  });
});
