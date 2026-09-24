/** Werkbank: offers per weapon (compatibility), menu flow, purchases / removal through the real WeaponSystem. */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import type { Interactable } from '../core/contracts';
import { CombatWorld } from '../combat/CombatWorld';
import { ATTACHMENT_SLOTS, getAttachmentDef, isAttachmentCompatible } from '../defs/attachments';
import { ELEMENT_MODS, getElementMod } from '../defs/elements';
import type { Action } from '../defs/input';
import { WEAPON_IDS, getWeaponDef } from '../defs/weapons';
import { WORKBENCH, WORKBENCH_MENU } from '../defs/workshop';
import { fakeSettings } from '../player/testHelpers';
import { FakeCamera, FakePlayer, FakeWeaponInput, fakeRenderCamera } from '../weapons/testFakes';
import { WeaponSystem } from '../weapons/WeaponSystem';
import {
  benchEntries,
  describeMods,
  entryEquipped,
  opticMagnification,
  type BenchEntry,
} from './benchEntries';
import { FakeEconomy } from './testFakes';
import { Workbench, type WorkbenchMenuApi } from './Workbench';

const DT = 1 / 60;

class Menu implements WorkbenchMenuApi {
  opened: string | null = null;
  entries: readonly BenchEntry[] = [];
  selected = -1;
  equipped: readonly boolean[] = [];
  points = 0;
  flashes: number[] = [];
  closes = 0;
  open(name: string, entries: readonly BenchEntry[]): void {
    this.opened = name;
    this.entries = entries;
  }
  close(): void {
    this.opened = null;
    this.closes++;
  }
  setSelected(i: number): void {
    this.selected = i;
  }
  setStates(equipped: readonly boolean[], points: number): void {
    this.equipped = [...equipped];
    this.points = points;
  }
  flash(i: number): void {
    this.flashes.push(i);
  }
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
    { loadout, slots: 2, seed: 'bench' },
  );
  const economy = new FakeEconomy(points);
  const menu = new Menu();
  const sounds: string[] = [];
  const focus = { current: null as Interactable | null };
  const mods: GameEvents['weapon:modsChanged'][] = [];
  events.on('weapon:modsChanged', (e) => mods.push({ ...e, attachments: [...e.attachments] }));
  const bench = new Workbench('bench', new Vector3(0, 1.1, 0), {
    weapons,
    economy,
    focused: () => focus.current,
    menu,
    audio: { play: (id) => sounds.push(id) },
  });
  focus.current = bench;
  const tick = (seconds: number): void => {
    const n = Math.max(1, Math.round(seconds / DT));
    for (let i = 0; i < n; i++) {
      weapons.fixedUpdate(DT);
      bench.fixedUpdate(DT);
      weapons.update(DT);
      input.endFrame();
    }
  };
  tick(1);
  return { events, weapons, economy, bench, menu, sounds, focus, mods, input, tick };
}

const indexOf = (b: Workbench, id: string): number => b.menuEntries.findIndex((e) => e.id === id);

describe('bench entries', () => {
  it('list every compatible attachment by slot (the weapon’s own slots only), then element modules', () => {
    for (const id of WEAPON_IDS) {
      const def = getWeaponDef(id)!;
      const entries = benchEntries(def);
      let lastSlot = -1;
      let elements = false;
      for (const e of entries) {
        if (e.kind === 'element') {
          elements = true;
          expect(e.element).not.toBe(def.damage.element);
          continue;
        }
        expect(elements, `${id}: attachments come before the element modules`).toBe(false);
        const att = getAttachmentDef(e.id)!;
        expect(isAttachmentCompatible(att, def), `${id} ← ${e.id}`).toBe(true);
        expect(def.attachmentSlots).toContain(att.slot);
        const slot = ATTACHMENT_SLOTS.findIndex((s) => s.slot === att.slot);
        expect(slot).toBeGreaterThanOrEqual(lastSlot);
        lastSlot = slot;
        expect(e.group).toBe(ATTACHMENT_SLOTS[slot]!.name);
        expect(e.promptBuy).toBe(WORKBENCH.prompts.buy.replace('{name}', att.name));
      }
      if (def.category === 'wonder') expect(entries).toHaveLength(0);
      else
        expect(entries.filter((e) => e.kind === 'element').length).toBeGreaterThanOrEqual(
          ELEMENT_MODS.length - 1,
        );
    }
  });

  it('describe stat mods as signed percentages, colored by what helps the player', () => {
    const chips = describeMods({ recoil: 0.82, hipSpread: 1.08, damage: 1.15 });
    expect(chips.map((c) => [c.label, c.good])).toEqual([
      ['Schaden', true],
      ['Rückstoß', true],
      ['Hüftstreuung', false],
    ]);
    expect(chips[1]!.text).toBe('−18 %');
    expect(describeMods({ damage: 1.001 })).toHaveLength(0);
    expect(describeMods({}, 0.31)[0]!.text).toBe('4,0×');
    expect(opticMagnification(0.48)).toBeCloseTo(2.5, 1);
    expect(opticMagnification(1)).toBe(1);
  });
});

describe('Werkbank', () => {
  it('offers the bench, opens the menu for the weapon in hand, closes when the focus leaves', () => {
    const t = setup(0);
    expect(t.bench.prompt()).toBe(WORKBENCH.prompts.open);
    expect(t.bench.cost()).toBeNull();
    t.bench.interact();
    expect(t.bench.isOpen).toBe(true);
    expect(t.menu.opened).toBe(getWeaponDef('rifle')!.name);
    expect(t.menu.entries).toEqual(benchEntries(getWeaponDef('rifle')!));
    expect(t.sounds).toEqual([WORKBENCH.sounds.open.id]);
    const first = t.bench.menuEntries[0]!;
    expect(t.bench.prompt()).toBe(first.promptBuy);
    expect(t.bench.cost()).toBe(first.cost);
    t.focus.current = null;
    t.tick(DT);
    expect(t.bench.isOpen).toBe(false);
    expect(t.menu.opened).toBeNull();
    expect(t.sounds).toEqual([WORKBENCH.sounds.open.id, WORKBENCH.sounds.close.id]);
  });

  it('buys and fits an attachment, replaces it within the slot, takes it off for free', () => {
    const t = setup(5000);
    t.bench.interact();
    t.bench.select(indexOf(t.bench, 'reddot'));
    t.bench.interact();
    expect(t.economy.spent).toEqual([{ cost: 750, item: 'attachment:reddot', kind: 'other' }]);
    expect(t.weapons.modsOf('rifle')!.attachments).toEqual(['reddot']);
    expect(t.mods.at(-1)).toMatchObject({ weaponId: 'rifle', attachments: ['reddot'], tier: 0 });
    expect(t.menu.flashes).toEqual([indexOf(t.bench, 'reddot')]);
    expect(t.menu.equipped[indexOf(t.bench, 'reddot')]).toBe(true);
    expect(t.bench.prompt()).toBe(WORKBENCH.prompts.remove.replace('{name}', 'Rotpunktvisier'));
    expect(t.bench.cost()).toBeNull();
    // A second optic replaces the first; another slot adds up.
    t.bench.select(indexOf(t.bench, 'holo'));
    t.bench.interact();
    t.bench.select(indexOf(t.bench, 'vertgrip'));
    t.bench.interact();
    expect([...t.weapons.modsOf('rifle')!.attachments!].sort()).toEqual(['holo', 'vertgrip']);
    const effective = t.weapons.effectiveDef('rifle')!;
    expect(effective.recoil).not.toEqual(getWeaponDef('rifle')!.recoil);
    // Taking one off is free.
    const spent = t.economy.spent.length;
    t.bench.select(indexOf(t.bench, 'holo'));
    t.bench.interact();
    expect(t.economy.spent).toHaveLength(spent);
    expect(t.weapons.modsOf('rifle')!.attachments).toEqual(['vertgrip']);
  });

  it('installs an element module (one per weapon) and keeps the forge tier', () => {
    const t = setup(10_000);
    t.weapons.setWeaponMods('rifle', { tier: 2 });
    t.bench.interact();
    const fire = getElementMod('fire')!;
    t.bench.select(indexOf(t.bench, fire.id));
    expect(t.bench.prompt()).toBe(WORKBENCH.prompts.install.replace('{name}', fire.short));
    t.bench.interact();
    expect(t.economy.spent.at(-1)).toEqual({ cost: fire.cost, item: fire.id, kind: 'other' });
    expect(t.weapons.modsOf('rifle')).toMatchObject({ tier: 2, element: 'fire' });
    expect(t.weapons.effectiveDef('rifle')!.damage.element).toBe('fire');
    const ice = getElementMod('ice')!;
    t.bench.select(indexOf(t.bench, ice.id));
    t.bench.interact();
    expect(t.weapons.modsOf('rifle')!.element).toBe('ice');
    expect(entryEquipped(t.bench.menuEntries[indexOf(t.bench, fire.id)]!, t.weapons.modsOf('rifle'))).toBe(
      false,
    );
    expect(t.weapons.tierOf('rifle')).toBe(2);
  });

  it('refuses a purchase without enough points (nothing fitted)', () => {
    const t = setup(100);
    t.bench.interact();
    t.bench.select(indexOf(t.bench, 'scope4x'));
    t.bench.interact();
    expect(t.economy.refused).toHaveLength(1);
    expect(t.weapons.modsOf('rifle')!.attachments ?? []).toEqual([]);
    expect(t.menu.flashes).toHaveLength(0);
  });

  it('navigates with wheel / weaponNext and the D-pad, swallowing the presses', () => {
    const t = setup(0);
    t.bench.interact();
    const consumed: Action[] = [];
    const edges = new Set<Action>(['weaponNext']);
    const pad = new Set<number>();
    const input = {
      pressed: (a: Action) => edges.has(a),
      consume: (a: Action) => {
        consumed.push(a);
        edges.delete(a);
      },
      padButtonPressed: (b: number) => pad.has(b),
    };
    t.bench.navigate(input);
    expect(t.bench.selection).toBe(1);
    expect(t.menu.selected).toBe(1);
    expect(consumed).toEqual(['weaponNext']);
    edges.add('ability');
    pad.add(WORKBENCH_MENU.padPrev);
    t.bench.navigate(input);
    expect(t.bench.selection).toBe(0);
    expect(consumed).toEqual(['weaponNext', 'ability']);
    // Wraps around.
    pad.clear();
    edges.add('weaponPrev');
    t.bench.navigate(input);
    expect(t.bench.selection).toBe(t.bench.menuEntries.length - 1);
    // Closed: the presses stay with the weapons.
    t.bench.reset();
    edges.add('weaponNext');
    t.bench.navigate(input);
    expect(edges.has('weaponNext')).toBe(true);
  });

  it('follows a weapon switch while open; wonder weapons get nothing; a new run closes it', () => {
    const t = setup(0, ['rifle', 'riftripper']);
    t.bench.interact();
    t.weapons.switchTo(1);
    t.tick(1.5);
    if (t.weapons.currentWeaponId === 'riftripper') {
      expect(t.bench.isOpen).toBe(false);
      expect(t.bench.prompt()).toBe(WORKBENCH.prompts.nothing);
      expect(t.bench.canInteract()).toBe(false);
    }
    t.weapons.switchTo(0);
    t.tick(1.5);
    t.bench.interact();
    expect(t.bench.isOpen).toBe(true);
    t.bench.reset();
    expect(t.bench.isOpen).toBe(false);
    expect(t.bench.prompt()).toBe(WORKBENCH.prompts.open);
  });
});
