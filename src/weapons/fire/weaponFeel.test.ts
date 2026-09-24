/**
 * Weapon feel & balance regressions (M5 review): trigger-rate exploits, forge tier self damage,
 * the suppressor's report and the forged muzzle light on weapon:fired, time-to-kill sanity per
 * wave through the real WeaponSystem + arsenal.
 */
import { describe, expect, it } from 'vitest';
import type { ArsenalVfxApi } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { CombatWorld } from '../../combat/CombatWorld';
import { FakeTarget, buildTestLevel } from '../../combat/testFakes';
import { WEAPONS, getWeaponDef, type WeaponDef } from '../../defs/weapons';
import { fakeSettings } from '../../player/testHelpers';
import { FakeCamera, FakePlayer, FakeWeaponInput, fakeRenderCamera } from '../testFakes';
import { WeaponSystem } from '../WeaponSystem';
import { resolveWeapon } from '../resolveWeapon';
import { Arsenal } from './Arsenal';

const DT = 1 / 60;
const EYE = { x: 0, y: 1.6, z: 0 };

/** Deterministic aim: no spread, no random recoil, no pattern climb. */
function precise(def: WeaponDef): WeaponDef {
  return {
    ...def,
    spread: { ...def.spread, hip: 0, ads: 0, moveAdd: 0, airAdd: 0, perShotBloom: 0 },
    recoil: { ...def.recoil, randomYaw: 0, randomPitch: 0, pattern: [[0, 0]], patternRepeatFrom: 0 },
  };
}

const NULL_VFX: ArsenalVfxApi = {
  projectileStart: () => 1,
  projectileMove: () => {},
  projectileEnd: () => {},
  beam: () => {},
  fieldStart: () => 1,
  fieldEnd: () => {},
  charge: () => {},
  update: () => {},
  clear: () => {},
};

function setup(defs: Record<string, WeaponDef>, loadout: string[]) {
  const events = new EventBus<GameEvents>();
  const input = new FakeWeaponInput();
  const player = new FakePlayer();
  const combat = new CombatWorld({ events, physics: null });
  combat.setLevel(
    buildTestLevel([
      { material: 'concrete_wall', center: { x: 0, y: 1.5, z: -40 }, size: { x: 40, y: 3, z: 0.5 } },
    ]),
  );
  const arsenal = new Arsenal({ events, combat, vfx: NULL_VFX, seed: 'feel' });
  const weapons = new WeaponSystem(
    {
      events,
      input,
      settings: fakeSettings(),
      player,
      camera: new FakeCamera(player),
      render: fakeRenderCamera(EYE),
      combat,
      arsenal,
      getMuzzleWorld: (o) => o.set(0.2, 1.45, -0.5),
    },
    { loadout, slots: loadout.length, seed: 'feel', defs: (id) => defs[id] ?? getWeaponDef(id) },
  );
  const fired: GameEvents['weapon:fired'][] = [];
  events.on('weapon:fired', (e) => fired.push({ ...e }));
  const frame = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      weapons.fixedUpdate(DT);
      arsenal.fixedUpdate(DT);
      weapons.update(DT);
      arsenal.update(DT, 1);
      weapons.updateVisuals(DT);
      input.endFrame();
    }
  };
  const equip = (): void => {
    for (let i = 0; i < 300 && weapons.state !== 'idle'; i++) frame();
  };
  return { events, input, player, combat, arsenal, weapons, fired, frame, equip };
}

describe('beam trigger rate', () => {
  for (const id of ['chainlightning', 'flamethrower'] as const) {
    it(`${id}: tapping the trigger never ticks faster than holding it`, () => {
      const def = precise(WEAPONS[id]);
      const t = setup({ [id]: def }, [id]);
      t.equip();
      t.combat.register(new FakeTarget({ x: 0, y: 0.35, z: -6 }, 1e9));
      const second = Math.round(1 / DT);
      // A macro / wheel-bound trigger: 2 ticks held, 1 released (20 presses/s) for one second.
      for (let i = 0; i < second; i++) {
        if (i % 3 === 2) t.input.release('fire');
        else if (i % 3 === 0) t.input.press('fire');
        t.frame();
      }
      t.input.release('fire');
      const ticks = t.fired.length;
      expect(ticks).toBeLessThanOrEqual(def.beam!.tickRate + 1);
    });
  }
});

describe('self damage of forged launchers', () => {
  it('a forge tier never raises the blast damage the shooter takes per trigger pull', () => {
    let checked = 0;
    for (const base of Object.values(WEAPONS) as WeaponDef[]) {
      const b = base.projectile?.explosion;
      if (!b || !(b.selfDamageScale > 0)) continue;
      const own = b.damage * b.selfDamageScale;
      for (const tier of [1, 2, 3]) {
        const d = resolveWeapon(base, { tier });
        const e = d.projectile!.explosion!;
        const split = d.special?.kind === 'splitShot' ? 1 + d.special.count : 1;
        expect(e.damage * e.selfDamageScale * split, `${base.id} t${tier}`).toBeLessThanOrEqual(own + 1e-6);
        // …while the blast itself hits enemies harder.
        expect(e.damage, `${base.id} t${tier}`).toBeGreaterThan(b.damage);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
