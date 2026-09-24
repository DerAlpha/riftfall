/**
 * The roster driven through the real WeaponSystem (hitscan kinds; the other kinds are refused
 * until the fire-kinds engine lands): fire cadence per fire mode, magazines, reload choreography
 * and timing come out of the data as designed.
 */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { CombatWorld } from '../../combat/CombatWorld';
import { fakeSettings } from '../../player/testHelpers';
import { FakeCamera, FakePlayer, FakeWeaponInput, fakeRenderCamera } from '../../weapons/testFakes';
import { WeaponSystem } from '../../weapons/WeaponSystem';
import { IMPLEMENTED_WEAPON_KINDS, WEAPONS, WEAPON_IDS, type WeaponDef } from '../weapons';

const DT = 1 / 60;

function setup(id: string) {
  const events = new EventBus<GameEvents>();
  const input = new FakeWeaponInput();
  const player = new FakePlayer();
  const counts = { fired: 0, steps: [] as string[], reloadStart: -1, reloadEnd: -1, equipped: 0 };
  let tick = 0;
  events.on('weapon:fired', () => counts.fired++);
  events.on('weapon:reloadStep', (e) => counts.steps.push(e.step));
  events.on('weapon:reloadStart', () => (counts.reloadStart = tick));
  events.on('weapon:reloadEnd', () => (counts.reloadEnd = tick));
  events.on('weapon:equipped', () => counts.equipped++);
  const weapons = new WeaponSystem(
    {
      events,
      input,
      settings: fakeSettings(),
      player,
      camera: new FakeCamera(player),
      render: fakeRenderCamera({ x: 0, y: 1.6, z: 0 }),
      combat: new CombatWorld({ events, physics: null }),
      getMuzzleWorld: (o) => o.set(0.2, 1.45, -0.5),
    },
    { loadout: [id], slots: 1, seed: 'roster' },
  );
  const frame = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      weapons.fixedUpdate(DT);
      weapons.update(DT);
      input.endFrame();
      tick++;
    }
  };
  const until = (pred: () => boolean, limit = 1200): void => {
    for (let i = 0; i < limit && !pred(); i++) frame();
    expect(pred(), `${id}: condition not reached`).toBe(true);
  };
  return {
    weapons,
    input,
    counts,
    frame,
    until,
    get tick() {
      return tick;
    },
  };
}

const hitscan: WeaponDef[] = WEAPON_IDS.map((id) => WEAPONS[id] as WeaponDef).filter((d) =>
  IMPLEMENTED_WEAPON_KINDS.includes(d.kind),
);

describe('roster through the weapon system', () => {
  it('covers every hitscan weapon of the roster', () => {
    expect(hitscan.length).toBeGreaterThanOrEqual(17);
  });

  for (const def of hitscan) {
    it(`${def.id}: equips, fires at its rate, reloads along its markers`, () => {
      const t = setup(def.id);
      t.until(() => t.weapons.state === 'idle' && t.counts.equipped > 0);
      const full = def.magazine + (def.chambered ? 1 : 0);
      expect(t.weapons.ammo!.mag).toBe(full);

      // One trigger pull: one shot (semi/pump), a whole burst (burst).
      t.input.tap('fire');
      t.frame(Math.ceil(60 / (def.burst?.rpm ?? def.rpm) / DT) * (def.burst?.count ?? 1) + 2);
      expect(t.counts.fired, 'one pull').toBe(def.fireMode === 'burst' ? def.burst!.count : 1);

      // Held for a second (after the pull's cycle): auto/pump keep firing at the rpm.
      t.frame(Math.ceil(60 / def.rpm / DT) + 1);
      const before = t.counts.fired;
      const window = 1;
      t.input.press('fire');
      t.frame(Math.round(window / DT));
      t.input.release('fire');
      const held = t.counts.fired - before;
      const expected = Math.min((def.rpm / 60) * window, full - before);
      if (def.fireMode === 'auto' || def.fireMode === 'pump') {
        expect(held, 'held for 1 s').toBeGreaterThanOrEqual(Math.floor(expected) - 1);
        expect(held, 'held for 1 s').toBeLessThanOrEqual(Math.ceil(expected) + 1);
      } else {
        expect(held, 'semi/burst: holding fires no more than the pull').toBeLessThanOrEqual(
          def.burst?.count ?? 1,
        );
      }

      // Empty it: the reload starts on its own and walks the empty markers in order (a small
      // magazine may already be reloading from the held trigger – let that one finish first).
      t.until(() => t.weapons.state !== 'reloading', 1200);
      t.counts.steps.length = 0;
      const held2 = def.fireMode === 'auto' || def.fireMode === 'pump';
      const cycle = Math.ceil(60 / def.rpm / DT) + 1;
      for (let i = 0; i < 6000 && t.weapons.state !== 'reloading'; i++) {
        if (held2) t.input.press('fire');
        else if (i % cycle === 0) t.input.tap('fire');
        t.frame();
      }
      t.input.release('fire');
      expect(t.weapons.state).toBe('reloading');
      t.until(() => t.weapons.state !== 'reloading', 1200);
      if (def.reload.perShell) {
        expect(t.counts.steps.filter((s) => s === 'shellIn').length).toBe(def.magazine);
        expect(t.counts.steps.at(-1)).toBe('pump');
      } else {
        expect(t.counts.steps).toEqual(def.reload.emptySteps.map((s) => s.step));
        const took = (t.counts.reloadEnd - t.counts.reloadStart) * DT;
        expect(took).toBeCloseTo(def.reload.empty, 1);
      }
      expect(t.weapons.ammo!.mag).toBe(def.magazine);
    });
  }
});
