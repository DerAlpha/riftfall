/**
 * Werkbank (logic; visuals: visuals/WorkbenchView.ts, menu: ui/hud/WorkbenchMenu.ts): attachments
 * and element modules for the HELD weapon.
 *
 * Flow: focusing the bench offers "Werkbank benutzen"; interact opens a compact, non-pausing menu
 * next to the crosshair listing the weapon's compatible attachments (by slot) and element modules
 * with prices and what is fitted. The selection moves with the mouse wheel / weaponNext-weaponPrev /
 * D-pad (navigate(), once per frame before the ticks: those presses are consumed so the weapon does
 * not switch and D-pad up fires no ability). Interact then buys + fits the selected entry (replacing
 * whatever held its slot), or takes a fitted one off for free. Purchases go through the economy
 * ('other' kind, items `attachment:<id>` / `element.<el>`), then WeaponSystem.setWeaponMods (which
 * emits weapon:modsChanged: viewmodel, HUD and bench sounds follow). The menu closes when the bench
 * loses the interaction focus (walking away, turning away, death) and on a new run.
 *
 * The interact prompt names the selected action ("Kaufen: Rotpunktvisier" + price, "Abnehmen: …");
 * prompts are cached per entry (no allocation per tick).
 */
import type { Vector3 } from 'three';
import type { AudioApi, EconomyApi, Interactable } from '../core/contracts';
import { getAttachmentDef } from '../defs/attachments';
import type { Action } from '../defs/input';
import { getWeaponDef, type WeaponDef } from '../defs/weapons';
import { WORKBENCH, WORKBENCH_MENU } from '../defs/workshop';
import { benchEntries, entryEquipped, modsAfterUse, type BenchEntry } from './benchEntries';
import type { WorkshopWeapons } from './RiftForge';

/** The bench menu (DOM, src/ui/hud/WorkbenchMenu.ts); every call is a state change. */
export interface WorkbenchMenuApi {
  open(weaponName: string, entries: readonly BenchEntry[]): void;
  close(): void;
  setSelected(index: number): void;
  /** Fitted flags (by entry index) and the player's points (affordability). */
  setStates(equipped: readonly boolean[], points: number): void;
  /** A purchase / change went through on entry `index`. */
  flash(index: number): void;
}

export interface WorkbenchViewApi {
  /** Weapon the hologram shows (null = none) and whether the menu is open. */
  setWeapon(weaponId: string | null): void;
  setOpen(open: boolean): void;
  flash(): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

/** Input as the menu reads it (InputSystem satisfies it; consume/pad are optional). */
export interface BenchInput {
  pressed(action: Action): boolean;
  /** Swallow this frame's press of `action` (the menu used it). */
  consume?(action: Action): void;
  padButtonPressed?(button: number): boolean;
}

export interface WorkbenchDeps {
  weapons: WorkshopWeapons;
  economy: Pick<EconomyApi, 'spend' | 'earn' | 'points'>;
  /** The interactable the player focuses (the menu closes when it is not this bench). */
  focused?: (() => Interactable | null) | null;
  menu?: WorkbenchMenuApi | null;
  view?: WorkbenchViewApi | null;
  audio?: Pick<AudioApi, 'play'> | null;
  /** Base defs; default: the static weapon table. */
  defs?: (weaponId: string) => WeaponDef | undefined;
  blocker?: { dispose(): void } | null;
}

const NO_ENTRIES: readonly BenchEntry[] = [];

function slotOf(id: string): string | null {
  return getAttachmentDef(id)?.slot ?? null;
}

export class Workbench implements Interactable {
  readonly id: string;
  readonly range = WORKBENCH.range;
  private readonly lookupDef: (id: string) => WeaponDef | undefined;
  /** Entries per base weapon id (static data: built once). */
  private readonly entryCache = new Map<string, readonly BenchEntry[]>();
  private menuOpen = false;
  private entries: readonly BenchEntry[] = NO_ENTRIES;
  private menuWeapon: string | null = null;
  private selected = 0;
  private readonly equipped: boolean[] = [];
  /** Mods object / points last shown in the menu (identity compare: setWeaponMods replaces it). */
  private shownMods: object | null = null;
  private shownPoints = -1;
  private shownWeapon: string | null | undefined = undefined;
  private disposed = false;

  constructor(
    id: string,
    readonly position: Vector3,
    private readonly deps: WorkbenchDeps,
  ) {
    this.id = id;
    this.lookupDef = deps.defs ?? getWeaponDef;
  }

  get isOpen(): boolean {
    return this.menuOpen;
  }

  /** Index of the selected entry (tests / debug). */
  get selection(): number {
    return this.selected;
  }

  /** Entries of the open menu (empty when closed). */
  get menuEntries(): readonly BenchEntry[] {
    return this.entries;
  }

  /** Entries the bench offers for a weapon id (cached). */
  entriesFor(weaponId: string | null): readonly BenchEntry[] {
    if (!weaponId) return NO_ENTRIES;
    const hit = this.entryCache.get(weaponId);
    if (hit) return hit;
    const def = this.lookupDef(weaponId);
    const list = def ? benchEntries(def) : NO_ENTRIES;
    this.entryCache.set(weaponId, list);
    return list;
  }

  prompt(): string {
    const P = WORKBENCH.prompts;
    const id = this.deps.weapons.currentWeaponId;
    if (!id) return P.noWeapon;
    if (!this.menuOpen || id !== this.menuWeapon) {
      return this.entriesFor(id).length > 0 ? P.open : P.nothing;
    }
    const e = this.entries[this.selected];
    if (!e) return P.nothing;
    return this.isFitted(e) ? e.promptRemove : e.promptBuy;
  }

  cost(): number | null {
    if (!this.menuOpen) return null;
    const e = this.entries[this.selected];
    if (!e || this.isFitted(e)) return null;
    return e.cost;
  }

  canInteract(): boolean {
    if (this.disposed) return false;
    const id = this.deps.weapons.currentWeaponId;
    return id !== null && this.entriesFor(id).length > 0;
  }

  holdTime(): number {
    return 0;
  }

  interact(): void {
    if (!this.canInteract()) return;
    const id = this.deps.weapons.currentWeaponId!;
    if (!this.menuOpen || id !== this.menuWeapon) {
      this.openMenu(id);
      return;
    }
    this.use(this.selected);
  }

  /**
   * Per frame, before the ticks (Game.beginFrame): move the selection with this frame's
   * weaponNext / weaponPrev (wheel, pad Y) and D-pad presses while the menu is open, and consume
   * them (no weapon switch, no ability).
   */
  navigate(input: BenchInput): void {
    if (!this.menuOpen || this.entries.length === 0) return;
    let step = 0;
    if (input.pressed('weaponNext')) {
      step++;
      input.consume?.('weaponNext');
    }
    if (input.pressed('weaponPrev')) {
      step--;
      input.consume?.('weaponPrev');
    }
    if (input.padButtonPressed?.(WORKBENCH_MENU.padNext)) step++;
    if (input.padButtonPressed?.(WORKBENCH_MENU.padPrev)) {
      step--;
      // D-pad up is also the ability binding by default.
      if (input.pressed('ability')) input.consume?.('ability');
    }
    if (step !== 0) this.select(this.selected + step);
  }

  /** Select entry `index` (wraps around). */
  select(index: number): void {
    const n = this.entries.length;
    if (n === 0) return;
    const i = ((index % n) + n) % n;
    if (i === this.selected) return;
    this.selected = i;
    this.deps.menu?.setSelected(i);
  }

  fixedUpdate(_dt: number): void {
    if (!this.menuOpen) return;
    const id = this.deps.weapons.currentWeaponId;
    const focus = this.deps.focused ? this.deps.focused() : this;
    if (focus !== this || !id) {
      this.closeMenu(true);
      return;
    }
    // The weapon in hand changed (switch, box, wall buy): show its options.
    if (id !== this.menuWeapon) {
      if (this.entriesFor(id).length === 0) this.closeMenu(true);
      else this.openMenu(id, false);
      return;
    }
    this.syncStates();
  }

  update(dt: number, time: number): void {
    const view = this.deps.view;
    if (!view) return;
    const id = this.menuOpen ? this.menuWeapon : null;
    if (id !== this.shownWeapon) {
      this.shownWeapon = id;
      view.setWeapon(id);
      view.setOpen(id !== null);
    }
    view.update(dt, time);
  }

  /** New run: menu closed. */
  reset(): void {
    this.closeMenu(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.closeMenu(false);
    this.disposed = true;
    this.deps.blocker?.dispose();
    this.deps.view?.dispose();
  }

  // -------------------------------------------------------------------------

  private isFitted(e: BenchEntry): boolean {
    const id = this.menuWeapon;
    return id !== null && entryEquipped(e, this.deps.weapons.modsOf(id));
  }

  private openMenu(weaponId: string, sound = true): void {
    const entries = this.entriesFor(weaponId);
    if (entries.length === 0) return;
    const wasOpen = this.menuOpen;
    this.menuOpen = true;
    this.menuWeapon = weaponId;
    this.entries = entries;
    this.selected = 0;
    this.equipped.length = entries.length;
    this.shownMods = null;
    this.shownPoints = -1;
    const name = this.deps.weapons.effectiveDef(weaponId)?.name ?? this.lookupDef(weaponId)?.name ?? weaponId;
    this.deps.menu?.open(name, entries);
    this.deps.menu?.setSelected(0);
    this.syncStates();
    if (sound && !wasOpen) this.playSound(WORKBENCH.sounds.open);
  }

  private closeMenu(sound: boolean): void {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    this.menuWeapon = null;
    this.entries = NO_ENTRIES;
    this.selected = 0;
    this.shownMods = null;
    this.deps.menu?.close();
    if (sound) this.playSound(WORKBENCH.sounds.close);
  }

  /** Fitted flags + points to the menu when either changed. */
  private syncStates(): void {
    const id = this.menuWeapon;
    if (!id) return;
    const mods = this.deps.weapons.modsOf(id);
    const points = this.deps.economy.points;
    if (mods === this.shownMods && points === this.shownPoints) return;
    this.shownMods = mods;
    this.shownPoints = points;
    for (let i = 0; i < this.entries.length; i++) this.equipped[i] = entryEquipped(this.entries[i]!, mods);
    this.deps.menu?.setStates(this.equipped, points);
  }

  /** Buy + fit entry `index`, or take it off when it is fitted. */
  private use(index: number): void {
    const e = this.entries[index];
    const id = this.menuWeapon;
    if (!e || !id) return;
    const { weapons, economy } = this.deps;
    const mods = weapons.modsOf(id);
    const fitted = entryEquipped(e, mods);
    const price = fitted ? 0 : e.cost;
    if (price > 0) {
      const item = e.kind === 'element' ? e.id : `attachment:${e.id}`;
      if (!economy.spend(price, item, 'other')) return;
    }
    if (!weapons.setWeaponMods(id, modsAfterUse(e, mods, slotOf))) {
      if (price > 0) economy.earn(price, 'refund');
      return;
    }
    this.deps.menu?.flash(index);
    this.deps.view?.flash();
    this.syncStates();
  }

  private playSound(s: { readonly id: string; readonly gain: number }): void {
    this.deps.audio?.play(s.id, { position: this.position, volume: s.gain });
  }
}
