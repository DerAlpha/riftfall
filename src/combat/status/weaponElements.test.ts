/**
 * Element mods end to end: the real WeaponSystem (setWeaponMods element, elementProc specials) →
 * CombatWorld (DamageInfo.statusBuildup) → StatusEffectSystem.
 */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { CombatWorld } from '../CombatWorld';
import { FakeTarget } from '../testFakes';
import { ELEMENTS } from '../../defs/elements';
import { WEAPONS, getWeaponDef, type WeaponDef } from '../../defs/weapons';
import { fakeSettings } from '../../player/testHelpers';
import { FakeCamera, FakePlayer, FakeWeaponInput, fakeRenderCamera } from '../../weapons/testFakes';
import { WeaponSystem } from '../../weapons/WeaponSystem';
import { Arsenal } from '../../weapons/fire/Arsenal';
import { StatusEffectSystem } from './StatusEffectSystem';

const DT = 1 / 60;
const EYE = { x: 0, y: 1.6, z: 0 };

function precise(def: WeaponDef): WeaponDef {
  return {
    ...def,
    spread: { ...def.spread, hip: 0, ads: 0, moveAdd: 0, airAdd: 0, perShotBloom: 0 },
    recoil: { ...def.recoil, randomYaw: 0, randomPitch: 0, pattern: [[0, 0]], patternRepeatFrom: 0 },
  };
}

function setup(weaponId: string) {
  const events = new EventBus<GameEvents>();
  const input = new FakeWeaponInput();
  const player = new FakePlayer();
  const combat = new CombatWorld({ events, physics: null });
  const arsenal = new Arsenal({ events, combat, seed: 'test' });
  const status = new StatusEffectSystem({ events, combat, seed: 'test' });
  combat.setStatus(status);
  arsenal.setStatus(status);
  const def = precise(WEAPONS[weaponId as keyof typeof WEAPONS]);
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
    { loadout: [weaponId], slots: 1, seed: 'el', defs: (id) => (id === weaponId ? def : getWeaponDef(id)) },
  );
  const frame = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      weapons.fixedUpdate(DT);
      arsenal.fixedUpdate(DT);
      status.fixedUpdate(DT);
      weapons.update(DT);
      input.endFrame();
    }
  };
  for (let i = 0; i < 300 && weapons.state !== 'idle'; i++) frame();
  return { events, input, combat, status, weapons, frame };
}

describe('element mods through the weapon system', () => {
  it('an ice-modded rifle chills, then freezes a tough target', () => {
    const t = setup('rifle');
    expect(t.weapons.setWeaponMods('rifle', { element: 'ice' })).toBe(true);
    const target = new FakeTarget({ x: 0, y: 0.35, z: -8 }, 1e6);
    t.combat.register(target);
    t.input.press('fire');
    let chilled = false;
    let frozen = false;
    for (let i = 0; i < 600 && !frozen; i++) {
      t.frame();
      chilled ||= t.status.has(target.id, 'chill');
      frozen = t.status.has(target.id, 'frozen');
    }
    expect(chilled).toBe(true);
    expect(frozen).toBe(true);
    expect(target.received.some((d) => d.element === 'ice' && (d.statusBuildup ?? 0) > 0)).toBe(true);
  });

  it('without an element mod the same rifle builds nothing', () => {
    const t = setup('rifle');
    const target = new FakeTarget({ x: 0, y: 0.35, z: -8 }, 1e6);
    t.combat.register(target);
    t.input.press('fire');
    t.frame(120);
    expect(target.received.length).toBeGreaterThan(3);
    expect(t.status.slots).toBe(0);
  });

  it('the flamethrower ignites what it hits', () => {
    const t = setup('flamethrower');
    const target = new FakeTarget({ x: 0, y: 0.35, z: -5 }, 1e6);
    t.combat.register(target);
    t.input.press('fire');
    let burning = false;
    for (let i = 0; i < 240 && !burning; i++) {
      t.frame();
      burning = t.status.has(target.id, 'burn');
    }
    expect(burning).toBe(true);
    expect(ELEMENTS.burn.duration).toBeGreaterThan(0);
  });
});
