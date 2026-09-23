// @vitest-environment jsdom
/**
 * HUD + real WeaponSystem: the weapon block (name, slot chip, ammo, prompt) always describes the
 * weapon in hand – a switch changes all of it together when the new weapon comes up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CombatWorld } from '../../combat/CombatWorld';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { HUD } from '../../defs/ui';
import { WEAPONS } from '../../defs/weapons';
import { fakeSettings } from '../../player/testHelpers';
import { FakeCamera, FakePlayer, FakeWeaponInput, fakeRenderCamera } from '../../weapons/testFakes';
import { WeaponSystem } from '../../weapons/WeaponSystem';
import { Hud } from './Hud';

const DT = 1 / 60;

function setup() {
  const events = new EventBus<GameEvents>();
  const settings = fakeSettings();
  const root = document.createElement('div');
  // Constructed first, like Game.ts: it sees the initial equip events.
  const hud = new Hud(root, events, settings);
  const input = new FakeWeaponInput();
  const player = new FakePlayer();
  const weapons = new WeaponSystem(
    {
      events,
      input,
      settings,
      player,
      camera: new FakeCamera(player),
      render: fakeRenderCamera({ x: 0, y: 1.6, z: 0 }),
      combat: new CombatWorld({ events, physics: null }),
      getMuzzleWorld: (o) => o.set(0.2, 1.45, -0.5),
    },
    { loadout: ['pistol', 'rifle', 'shotgun'], slots: 3, seed: 'hud' },
  );
  const frame = (): void => {
    weapons.fixedUpdate(DT);
    weapons.update(DT);
    hud.update(DT, 0);
    input.endFrame();
  };
  const until = (pred: () => boolean, limit = 1200): void => {
    for (let i = 0; i < limit && !pred(); i++) frame();
    if (!pred()) throw new Error('condition not reached');
  };
  const text = (sel: string): string => root.querySelector(sel)?.textContent ?? '';
  const prompt = (): string | null => {
    const el = root.querySelector('.hud-prompt') as HTMLElement;
    return el.hidden ? null : el.textContent;
  };
  const currentChip = (): number =>
    [...root.querySelectorAll('.hud-slot')].findIndex((c) => c.classList.contains('is-current'));
  return { hud, input, weapons, frame, until, text, prompt, currentChip };
}

describe('HUD during a weapon switch (real WeaponSystem)', () => {
  let dispose: (() => void) | null = null;
  afterEach(() => dispose?.());

  it('keeps name, slot, ammo and prompt of the outgoing weapon until the new one comes up', () => {
    const t = setup();
    dispose = () => {
      t.weapons.dispose();
      t.hud.dispose();
    };
    t.until(() => t.weapons.state === 'idle');
    // Empty the pistol: NACHLADEN.
    t.until(() => {
      if (t.weapons.state === 'idle') t.input.tap('fire');
      return t.weapons.ammo?.mag === 0;
    });
    t.frame();
    const pistolReserve = String(t.weapons.ammo!.reserve);
    expect(t.text('.hud-weapon__name')).toBe(WEAPONS.pistol.name);
    expect(t.text('.hud-ammo__mag')).toBe('0');
    expect(t.prompt()).toBe(HUD.ammo.prompts.reload);

    t.weapons.switchTo(2);
    t.frame();
    expect(t.weapons.state).toBe('holstering');
    // Holstering: everything still describes the pistol.
    expect(t.text('.hud-weapon__name')).toBe(WEAPONS.pistol.name);
    expect(t.currentChip()).toBe(0);
    expect(t.text('.hud-ammo__mag')).toBe('0');
    expect(t.text('.hud-ammo__reserve')).toBe(pistolReserve);
    expect(t.prompt()).toBe(HUD.ammo.prompts.reload);

    // The shotgun comes up: name, chip and its own ammo in the same frame.
    t.until(() => t.weapons.currentWeaponId === 'shotgun');
    const sg = t.weapons.ammo!;
    expect(t.text('.hud-weapon__name')).toBe(WEAPONS.shotgun.name);
    expect(t.currentChip()).toBe(2);
    expect(t.text('.hud-ammo__mag')).toBe(String(sg.mag));
    expect(t.text('.hud-ammo__reserve')).toBe(String(sg.reserve));
    expect(sg.mag).toBeGreaterThan(0);
    expect(t.prompt()).toBeNull();
  });
});
