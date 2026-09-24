/** Rift Forge: offer / prices / max tier, the forge sequence with the real WeaponSystem, death and reset. */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { CombatWorld } from '../combat/CombatWorld';
import { FORGE } from '../defs/forge';
import { WEAPONS, getWeaponDef } from '../defs/weapons';
import { RIFT_FORGE_MACHINE } from '../defs/workshop';
import { fakeSettings } from '../player/testHelpers';
import { FakeCamera, FakePlayer, FakeWeaponInput, fakeRenderCamera } from '../weapons/testFakes';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { RiftForge, forgePrice, forgePrompt, type RiftForgeReadout, type RiftForgeViewApi } from './RiftForge';
import { FakeEconomy } from './testFakes';

const SEQ = RIFT_FORGE_MACHINE.sequence;
const DT = 1 / 60;

class ForgeView implements RiftForgeViewApi {
  readonly begun: { weaponId: string; tier: number }[] = [];
  readonly strikes: number[] = [];
  releases = 0;
  last: RiftForgeReadout | null = null;
  begin(weaponId: string, tier: number): void {
    this.begun.push({ weaponId, tier });
  }
  strike(i: number): void {
    this.strikes.push(i);
  }
  release(): void {
    this.releases++;
  }
  update(_dt: number, _t: number, r: RiftForgeReadout): void {
    this.last = { ...r };
  }
  dispose(): void {}
}

function setup(points: number, loadout = ['rifle', 'pistol']) {
  const events = new EventBus<GameEvents>();
  const player = new FakePlayer();
  const input = new FakeWeaponInput();
  const weapons = new WeaponSystem(
    {
      events,
      input,
      settings: fakeSettings(),
      player,
      camera: new FakeCamera(player),
      render: fakeRenderCamera({ x: 0, y: 1.6, z: 0 }),
      combat: new CombatWorld({ events, physics: null }),
      getMuzzleWorld: (o) => o.set(0, 1.5, -0.5),
    },
    { loadout, slots: 2, seed: 'forge' },
  );
  const economy = new FakeEconomy(points);
  const view = new ForgeView();
  const hands = { stows: 0, releases: 0 };
  const log = { upgraded: [] as GameEvents['forge:upgraded'][], raises: 0, shakes: 0 };
  events.on('forge:upgraded', (e) => log.upgraded.push({ ...e }));
  events.on('weapon:raiseStart', () => log.raises++);
  events.on('camera:shake', () => log.shakes++);
  const forge = new RiftForge('forge', new Vector3(0, 1.2, 0), {
    weapons,
    economy,
    hands: {
      stow: () => {
        hands.stows++;
        weapons.setStowed(true);
      },
      release: () => {
        hands.releases++;
        weapons.setStowed(false);
      },
    },
    view,
    events,
    player: { position: new Vector3(0, 0, 1.5) },
  });
  const tick = (seconds: number): void => {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      weapons.fixedUpdate(DT);
      forge.fixedUpdate(DT);
      weapons.update(DT);
      forge.update(DT, 0);
      input.endFrame();
    }
  };
  tick(1);
  return { events, weapons, economy, forge, view, hands, log, input, tick };
}

describe('Rift Forge', () => {
  it('offers the next tier of the weapon in hand at the def price', () => {
    const t = setup(0);
    const rifle = getWeaponDef('rifle')!;
    expect(t.forge.prompt()).toBe(forgePrompt(rifle.name, 1));
    expect(t.forge.prompt()).toContain(FORGE.tierLabels[0]!);
    expect(t.forge.cost()).toBe(rifle.upgrades.find((u) => u.tier === 1)!.cost);
    expect(t.forge.cost()).toBe(FORGE.tierCosts[0]);
    expect(t.forge.canInteract()).toBe(true);
  });

  it('refuses without enough points: nothing paid, no tier, the weapon stays in hand', () => {
    const t = setup(4999);
    t.forge.interact();
    expect(t.economy.refused).toHaveLength(1);
    expect(t.weapons.tierOf('rifle')).toBe(0);
    expect(t.hands.stows).toBe(0);
    expect(t.forge.busy).toBe(false);
  });

  it('forges: pays (kind forge), upgrades + refills at once, holds the weapon, hands it back', () => {
    const t = setup(50_000);
    // Spend some rounds first: the upgrade refills.
    for (let i = 0; i < 4; i++) {
      t.input.tap('fire');
      t.tick(0.2);
    }
    expect(t.weapons.ammo!.mag).toBeLessThan(t.weapons.ammo!.magSize);
    t.forge.interact();
    expect(t.economy.spent).toEqual([{ cost: FORGE.tierCosts[0], item: 'forge:rifle', kind: 'forge' }]);
    expect(t.weapons.tierOf('rifle')).toBe(1);
    expect(t.log.upgraded).toEqual([{ weaponId: 'rifle', tier: 1, name: WEAPONS.rifle.upgrades[0].name }]);
    // Refilled (a chambered round may sit on top of the magazine).
    expect(t.weapons.ammo!.mag).toBeGreaterThanOrEqual(t.weapons.ammo!.magSize);
    const full = t.weapons.ammo!.mag;
    expect(t.hands.stows).toBe(1);
    expect(t.weapons.isStowed).toBe(true);
    expect(t.view.begun).toEqual([{ weaponId: 'rifle', tier: 1 }]);
    // Busy: not focusable, no second purchase.
    expect(t.forge.prompt()).toBe('');
    expect(t.forge.canInteract()).toBe(false);
    t.forge.interact();
    expect(t.economy.spent).toHaveLength(1);
    // The held weapon does nothing while the machine has it.
    const mag = t.weapons.ammo!.mag;
    t.input.tap('fire');
    t.input.tap('weaponNext');
    t.tick(0.3);
    expect(t.weapons.ammo!.mag).toBe(mag);
    expect(t.weapons.currentWeaponId).toBe('rifle');
    // Strikes, release, cool-down.
    const raises = t.log.raises;
    const shakes = t.log.shakes;
    t.tick(SEQ.releaseAt - 0.3 + 0.05);
    expect(t.view.strikes).toEqual(SEQ.strikes.map((_, i) => i));
    expect(t.log.shakes - shakes).toBe(SEQ.strikes.length);
    expect(t.hands.releases).toBe(1);
    expect(t.weapons.isStowed).toBe(false);
    expect(t.log.raises).toBe(raises + 1);
    expect(t.view.last?.released).toBe(true);
    t.tick(SEQ.duration - SEQ.releaseAt + 0.05);
    expect(t.forge.busy).toBe(false);
    expect(t.view.last?.forging).toBe(false);
    // The raised weapon fires again.
    t.tick(1);
    t.input.tap('fire');
    t.tick(0.2);
    expect(t.weapons.ammo!.mag).toBe(full - 1);
  });

  it('climbs the tiers at their prices, then shows "Maximale Stufe"', () => {
    const t = setup(100_000);
    let paid = 0;
    for (const tier of [1, 2, 3]) {
      expect(t.forge.cost()).toBe(FORGE.tierCosts[tier - 1]);
      t.forge.interact();
      paid += FORGE.tierCosts[tier - 1]!;
      expect(t.weapons.tierOf('rifle')).toBe(tier);
      t.tick(SEQ.duration + 0.6);
    }
    expect(t.economy.points).toBe(100_000 - paid);
    expect(t.forge.prompt()).toBe(FORGE.prompts.maxTier);
    expect(t.forge.cost()).toBeNull();
    expect(t.forge.canInteract()).toBe(false);
    t.forge.interact();
    expect(t.economy.spent).toHaveLength(3);
    // The offer follows the weapon in hand: the pistol is still at tier 0.
    t.weapons.switchTo(1);
    t.tick(1.5);
    expect(t.weapons.currentWeaponId).toBe('pistol');
    expect(t.forge.prompt()).toBe(forgePrompt(WEAPONS.pistol.name, 1));
  });

  it('names the weapon by its forged name in the next offer', () => {
    const t = setup(50_000);
    t.forge.interact();
    t.tick(SEQ.duration + 0.6);
    expect(t.forge.prompt()).toBe(forgePrompt(WEAPONS.rifle.upgrades[0].name, 2));
  });

  it('a death during the sequence hands the weapon back at once', () => {
    const t = setup(50_000);
    t.forge.interact();
    t.tick(0.5);
    t.events.emit('player:died', { position: { x: 0, y: 0, z: 0 } });
    expect(t.hands.releases).toBe(1);
    expect(t.weapons.isStowed).toBe(false);
    expect(t.forge.busy).toBe(false);
    // The upgrade was paid and applied at the start: it stays.
    expect(t.weapons.tierOf('rifle')).toBe(1);
    t.tick(SEQ.duration);
    expect(t.hands.releases).toBe(1);
  });

  it('a new run ends the sequence; a new loadout never stays stowed', () => {
    const t = setup(50_000);
    t.forge.interact();
    t.tick(0.3);
    t.forge.reset();
    expect(t.forge.busy).toBe(false);
    expect(t.weapons.isStowed).toBe(false);
    t.weapons.setStowed(true);
    t.weapons.setLoadout(['pistol']);
    expect(t.weapons.isStowed).toBe(false);
    // While the new weapon comes up the forge waits for it.
    expect(t.forge.prompt()).toBe(RIFT_FORGE_MACHINE.prompts.busy);
    expect(t.forge.canInteract()).toBe(false);
    t.tick(1.5);
    expect(t.forge.prompt()).toBe(forgePrompt(WEAPONS.pistol.name, 1));
  });

  it('prices fall back to the FORGE table; no weapon → no offer', () => {
    expect(forgePrice(0, 2)).toBe(FORGE.tierCosts[1]);
    expect(forgePrice(7777, 2)).toBe(7777);
    const t = setup(0, []);
    expect(t.forge.prompt()).toBe(FORGE.prompts.noWeapon);
    expect(t.forge.canInteract()).toBe(false);
  });
});
