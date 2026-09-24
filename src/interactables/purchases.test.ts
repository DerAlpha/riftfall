/** Perk machine and wall-buy purchase paths (logic only, fakes). */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ammoCost, weaponCost } from '../defs/economy';
import { PERK_MACHINES, WALL_BUYS } from '../defs/interactables';
import { WEAPONS } from '../defs/weapons';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { CombatWorld } from '../combat/CombatWorld';
import { fakeSettings } from '../player/testHelpers';
import { FakeCamera, FakePlayer, FakeWeaponInput, fakeRenderCamera } from '../weapons/testFakes';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { PerkMachine, type PerkAvailability, type PerkMachineViewApi } from './PerkMachine';
import { FakeEconomy, FakePerks, FakeWeapons } from './testFakes';
import {
  createDefaultPrices,
  createWeaponAdapter,
  defaultPerkMachineInfos,
  formatPrompt,
  type PerkMachineInfo,
} from './types';
import { WallBuy } from './WallBuy';

const PERK: PerkMachineInfo = { id: 'titan', name: 'Titanplatte', tagline: '', color: 0xff0000, glyph: '' };

class PerkView implements PerkMachineViewApi {
  states: PerkAvailability[] = [];
  flashes = 0;
  setAvailability(a: PerkAvailability): void {
    this.states.push(a);
  }
  flash(): void {
    this.flashes++;
  }
  update(): void {}
  dispose(): void {}
}

function machine(points: number, perks = new FakePerks(), price = 2500) {
  const economy = new FakeEconomy(points);
  const view = new PerkView();
  const m = new PerkMachine(PERK, new Vector3(), { perks, economy, price, view });
  return { m, economy, perks, view };
}

describe('PerkMachine', () => {
  it('buys the perk when affordable', () => {
    const t = machine(3000);
    expect(t.m.prompt()).toBe(formatPrompt(PERK_MACHINES.prompts.buy, 'Titanplatte'));
    expect(t.m.cost()).toBe(2500);
    t.m.interact();
    expect(t.economy.spent).toEqual([{ cost: 2500, item: 'perk:titan', kind: 'perk' }]);
    expect(t.perks.owned).toEqual(['titan']);
    expect(t.view.flashes).toBe(1);
    expect(t.economy.points).toBe(500);
  });

  it('refuses without enough points (no grant)', () => {
    const t = machine(2000);
    t.m.interact();
    expect(t.perks.owned).toEqual([]);
    expect(t.economy.refused).toHaveLength(1);
    expect(t.view.flashes).toBe(0);
  });

  it('shows "Bereits aktiv" for an owned perk and does not charge', () => {
    const perks = new FakePerks();
    perks.owned.push('titan');
    const t = machine(9000, perks);
    expect(t.m.availability).toBe('owned');
    expect(t.m.prompt()).toBe(PERK_MACHINES.prompts.owned);
    expect(t.m.cost()).toBeNull();
    expect(t.m.canInteract()).toBe(false);
    t.m.interact();
    expect(t.economy.spent).toHaveLength(0);
  });

  it('shows "Perk-Limit erreicht" at the limit and does not charge', () => {
    const perks = new FakePerks(2);
    perks.owned.push('a', 'b');
    const t = machine(9000, perks);
    expect(t.m.availability).toBe('limit');
    expect(t.m.prompt()).toBe(PERK_MACHINES.prompts.limit);
    expect(t.m.cost()).toBeNull();
    t.m.interact();
    expect(t.economy.spent).toHaveLength(0);
  });

  it('refunds when the grant fails after paying', () => {
    const perks = new FakePerks();
    perks.grantResult = false;
    const t = machine(3000, perks);
    t.m.interact();
    expect(t.economy.spent).toHaveLength(1);
    expect(t.economy.earned).toEqual([{ amount: 2500, reason: 'refund' }]);
    expect(t.economy.points).toBe(3000);
    expect(t.view.flashes).toBe(0);
  });

  it('becomes buyable again when the perk is lost; the view follows the state', () => {
    const t = machine(9000);
    t.m.update(0, 0);
    t.m.interact();
    t.m.update(0, 0);
    t.perks.owned.length = 0;
    t.m.update(0, 0);
    expect(t.view.states).toEqual(['available', 'owned', 'available']);
    expect(t.m.canInteract()).toBe(true);
  });

  it('every perk of the table gets machine info with a glyph', () => {
    const infos = defaultPerkMachineInfos();
    expect(infos.length).toBeGreaterThanOrEqual(12);
    for (const p of infos) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.glyph.length).toBeGreaterThan(0);
      expect(createDefaultPrices().perk(p.id)).toBeGreaterThan(0);
    }
  });
});

function wallBuy(points: number, weapons = new FakeWeapons(['pistol']), weaponId = 'rifle') {
  const economy = new FakeEconomy(points);
  const flashes = { n: 0, owned: [] as boolean[] };
  const def = WEAPONS[weaponId as keyof typeof WEAPONS];
  const wb = new WallBuy(
    { id: 'wb', weaponId, name: def.name, shortName: def.shortName, position: new Vector3() },
    {
      weapons,
      economy,
      prices: createDefaultPrices(),
      view: {
        setOwned: (o) => flashes.owned.push(o),
        flash: () => flashes.n++,
        update: () => {},
        dispose: () => {},
      },
    },
  );
  return { wb, economy, weapons, flashes };
}

describe('WallBuy', () => {
  it('prices the weapon from the economy and the ammo at the ammo price', () => {
    const t = wallBuy(0);
    expect(t.wb.weaponPrice).toBe(weaponCost('rifle'));
    expect(t.wb.ammoPrice).toBe(ammoCost(weaponCost('rifle')));
    expect(t.wb.ammoPrice).toBeLessThan(t.wb.weaponPrice);
  });

  it('buys the weapon when not carried', () => {
    const t = wallBuy(2000);
    expect(t.wb.prompt()).toBe(formatPrompt(WALL_BUYS.prompts.buy, WEAPONS.rifle.name));
    expect(t.wb.cost()).toBe(t.wb.weaponPrice);
    t.wb.interact();
    expect(t.economy.spent).toEqual([{ cost: t.wb.weaponPrice, item: 'rifle', kind: 'weapon' }]);
    expect(t.weapons.given).toEqual(['rifle']);
    expect(t.flashes.n).toBe(1);
  });

  it('sells ammo for a carried weapon at the ammo price', () => {
    const t = wallBuy(2000, new FakeWeapons(['pistol', 'rifle']));
    expect(t.wb.prompt()).toBe(
      formatPrompt(WALL_BUYS.prompts.ammo, WEAPONS.rifle.name, WEAPONS.rifle.shortName),
    );
    expect(t.wb.cost()).toBe(t.wb.ammoPrice);
    t.wb.interact();
    expect(t.economy.spent).toEqual([{ cost: t.wb.ammoPrice, item: 'ammo:rifle', kind: 'ammo' }]);
    // WeaponSystem.give refills a carried weapon.
    expect(t.weapons.given).toEqual(['rifle']);
  });

  it('refuses a refill when the ammo is full, and a purchase without points', () => {
    const w = new FakeWeapons(['rifle']);
    w.full = true;
    const t = wallBuy(2000, w);
    expect(t.wb.prompt()).toBe(WALL_BUYS.prompts.ammoFull);
    expect(t.wb.cost()).toBeNull();
    expect(t.wb.canInteract()).toBe(false);
    t.wb.interact();
    expect(t.economy.spent).toHaveLength(0);

    const poor = wallBuy(100);
    poor.wb.interact();
    expect(poor.weapons.given).toHaveLength(0);
    expect(poor.economy.refused).toHaveLength(1);
    expect(poor.flashes.n).toBe(0);
  });

  it('the board switches to the ammo offer once the weapon is carried', () => {
    const t = wallBuy(5000);
    t.wb.update(0, 0);
    t.wb.interact();
    t.wb.update(0, 0);
    t.wb.update(0, 0);
    expect(t.flashes.owned).toEqual([false, true]);
    t.wb.reset();
    t.wb.update(0, 0);
    expect(t.flashes.owned).toEqual([false, true, true]);
  });

  it('knows the ammo of every carried weapon, not only the one in hand (real WeaponSystem)', () => {
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
      { loadout: ['pistol', 'rifle'], slots: 2, seed: 'wallbuy' },
    );
    const frames = (n: number): void => {
      for (let i = 0; i < n; i++) {
        weapons.fixedUpdate(1 / 60);
        weapons.update(1 / 60);
        input.endFrame();
      }
    };
    const economy = new FakeEconomy(5000);
    const board = (weaponId: string): WallBuy =>
      new WallBuy(
        { id: `wb_${weaponId}`, weaponId, name: weaponId, shortName: weaponId, position: new Vector3() },
        { weapons: createWeaponAdapter(weapons), economy, prices: createDefaultPrices() },
      );
    frames(120);
    expect(weapons.currentWeaponId).toBe('pistol');
    // The rifle is holstered with full ammo: nothing to sell, nothing charged, no switch.
    const rifle = board('rifle');
    expect(rifle.prompt()).toBe(WALL_BUYS.prompts.ammoFull);
    expect(rifle.canInteract()).toBe(false);
    rifle.interact();
    expect(economy.spent).toHaveLength(0);
    // Spend pistol rounds, then raise the rifle: the holstered pistol is buyable again.
    for (let shot = 0; shot < 3; shot++) {
      input.tap('fire');
      frames(30);
    }
    expect(weapons.ammo!.mag).toBeLessThan(weapons.ammo!.magSize);
    weapons.switchTo(1);
    frames(120);
    expect(weapons.currentWeaponId).toBe('rifle');
    const pistol = board('pistol');
    expect(pistol.canInteract()).toBe(true);
    expect(pistol.cost()).toBe(pistol.ammoPrice);
    weapons.dispose();
  });
});
