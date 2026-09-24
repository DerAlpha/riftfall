import { describe, expect, it } from 'vitest';
import type { ExplosionApi } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { CombatWorld } from '../combat/CombatWorld';
import { FieldSystem } from '../combat/FieldSystem';
import { buildTestLevel } from '../combat/testFakes';
import { ABILITIES } from '../defs/abilities';

/** FieldApi.move / end (M5 abilities) on the real FieldSystem: the Chronofeld follows the player. */
function setup() {
  const events = new EventBus<GameEvents>();
  const combat = new CombatWorld({ events, physics: null });
  combat.setLevel(
    buildTestLevel([
      { material: 'concrete_wall', center: { x: 0, y: -0.5, z: 0 }, size: { x: 60, y: 1, z: 60 } },
    ]),
  );
  const explosions: ExplosionApi = { explode: () => 0 };
  const visuals: string[] = [];
  const fields = new FieldSystem({
    events,
    combat,
    explosions,
    vfx: {
      projectileStart: () => 0,
      projectileMove: () => {},
      projectileEnd: () => {},
      beam: () => {},
      fieldStart: (v) => {
        visuals.push(v);
        return visuals.length;
      },
      fieldEnd: () => {},
      charge: () => {},
      update: () => {},
      clear: () => {},
    },
  });
  const ended: number[] = [];
  events.on('field:ended', (e) => ended.push(e.id));
  return { fields, visuals, ended };
}

describe('FieldSystem.move / end (Chronofeld)', () => {
  const chrono = ABILITIES.chronofeld.field.field;
  const from = { weaponId: 'ability.chronofeld', source: 'player' as const, statusBuildup: 0 };

  it('a field without a vfx id draws no arsenal visual', () => {
    const t = setup();
    expect(t.fields.spawn({ x: 0, y: 0, z: 0 }, chrono, from)).toBeGreaterThan(0);
    expect(t.visuals).toEqual([]);
  });

  it('moves the slow area with the player (snapped to the floor) and ends it early on request', () => {
    const t = setup();
    const id = t.fields.spawn({ x: 0, y: 0, z: 0 }, chrono, from);
    const far = { x: 20, y: 0, z: 0 };
    expect(t.fields.slowAt({ x: 1, y: 0, z: 0 })).toBeCloseTo(chrono.strength, 6);
    expect(t.fields.slowAt(far)).toBe(1);
    // The player jumped: the field stays on the floor below.
    expect(t.fields.move(id, { x: 20, y: 1.5, z: 0 })).toBe(true);
    expect(t.fields.slowAt(far)).toBeCloseTo(chrono.strength, 6);
    expect(t.fields.slowAt({ x: 1, y: 0, z: 0 })).toBe(1);
    let y = NaN;
    t.fields.forEachField((_id, _def, _x, fy) => (y = fy));
    expect(y).toBeCloseTo(0, 6);
    expect(t.fields.end(id)).toBe(true);
    expect(t.ended).toEqual([id]);
    expect(t.fields.slowAt(far)).toBe(1);
    expect(t.fields.move(id, far)).toBe(false);
    expect(t.fields.end(id)).toBe(false);
    expect(t.fields.end(0)).toBe(false);
  });
});
