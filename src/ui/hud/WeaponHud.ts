/**
 * Weapon widgets (DOM): weapon name + inventory slot chips, ammo counter (magazine / reserve with a
 * magazine bar, low-ammo and empty states, dry-fire flash) and the prompt under the crosshair
 * (NACHLADEN / KEINE MUNITION). Everything is event driven; update() only runs the short dry-fire
 * and switch flashes. DOM writes happen only on change.
 */
import { clamp01 } from '../../core/math';
import { getWeaponDef } from '../../defs/weapons';
import { HUD } from '../../defs/ui';
import { ammoPrompt, isLowAmmo, type AmmoPrompt } from './hitFeedback';

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  parent?.appendChild(el);
  return el;
}

interface SlotChip {
  el: HTMLDivElement;
  key: HTMLSpanElement;
  name: HTMLSpanElement;
  /** undefined until the first inventory update labels the chip. */
  weaponId: string | null | undefined;
}

export class WeaponHud {
  readonly ammoEl: HTMLDivElement;
  private readonly weaponEl: HTMLDivElement;
  private readonly nameEl: HTMLSpanElement;
  private readonly slotsEl: HTMLDivElement;
  private readonly chips: SlotChip[] = [];
  private readonly magEl: HTMLSpanElement;
  private readonly reserveEl: HTMLSpanElement;
  private readonly barFill: HTMLDivElement;
  private readonly promptEl: HTMLDivElement;

  private weaponId: string | null = null;
  private currentSlot = -1;
  private mag: number | null = null;
  private reserve: number | null = null;
  private magSize = 0;
  private reloading = false;
  private prompt: AmmoPrompt = 'none';
  private low = false;
  private empty = false;
  private shownBar = -1;
  private dryTimer = 0;
  private dryPhase = false;
  private switchTimer = 0;

  /** `corner`: bottom-right HUD corner (weapon block + ammo); `center`: crosshair layer (prompt). */
  constructor(corner: HTMLElement, center: HTMLElement) {
    this.weaponEl = h('div', 'hud-weapon', corner);
    this.nameEl = h('span', 'hud-weapon__name', this.weaponEl);
    this.slotsEl = h('div', 'hud-weapon__slots', this.weaponEl);
    this.weaponEl.hidden = true;

    this.ammoEl = h('div', 'hud-ammo hud-placeholder', corner);
    this.magEl = h('span', 'hud-ammo__mag', this.ammoEl);
    this.magEl.textContent = '—';
    h('span', 'hud-ammo__sep', this.ammoEl).textContent = '/';
    this.reserveEl = h('span', 'hud-ammo__reserve', this.ammoEl);
    this.reserveEl.textContent = '—';
    const bar = h('div', 'hud-ammo__bar', this.ammoEl);
    this.barFill = h('div', 'hud-ammo__fill', bar);
    this.barFill.style.transform = 'scaleX(0)';

    this.promptEl = h('div', 'hud-prompt', center);
    this.promptEl.hidden = true;
  }

  get currentWeaponId(): string | null {
    return this.weaponId;
  }

  /** Magazine / reserve; null shows the placeholder. `magSize` drives the bar and low-ammo state. */
  setAmmo(mag: number | null, reserve: number | null, magSize?: number): void {
    if (magSize !== undefined && Number.isFinite(magSize)) this.magSize = Math.max(0, magSize);
    const m = mag === null || !Number.isFinite(mag) ? null : Math.max(0, Math.floor(mag));
    const r = reserve === null || !Number.isFinite(reserve) ? null : Math.max(0, Math.floor(reserve));
    if (m !== this.mag) {
      this.mag = m;
      setText(this.magEl, m === null ? '—' : String(m));
    }
    if (r !== this.reserve) {
      this.reserve = r;
      setText(this.reserveEl, r === null ? '—' : String(r));
    }
    this.ammoEl.classList.toggle('hud-placeholder', m === null);
    const low = m !== null && isLowAmmo(m, this.magSize);
    const empty = m !== null && m <= 0;
    if (low !== this.low) {
      this.low = low;
      this.ammoEl.classList.toggle('is-low', low);
    }
    if (empty !== this.empty) {
      this.empty = empty;
      this.ammoEl.classList.toggle('is-empty', empty);
    }
    const fill = m === null || this.magSize <= 0 ? 0 : clamp01(m / this.magSize);
    if (Math.abs(fill - this.shownBar) > 1e-3) {
      this.shownBar = fill;
      this.barFill.style.transform = `scaleX(${fill.toFixed(3)})`;
    }
    this.refreshPrompt();
  }

  /** Inventory (weapon:inventoryChanged): slot weapon ids and the current slot. */
  setInventory(slots: readonly (string | null)[], current: number): void {
    if (this.chips.length < slots.length) this.currentSlot = -1; // new chips need the current flag
    while (this.chips.length < slots.length) {
      const el = h('div', 'hud-slot', this.slotsEl);
      const key = h('span', 'hud-slot__key', el);
      key.textContent = String(this.chips.length + 1);
      const name = h('span', 'hud-slot__name', el);
      this.chips.push({ el, key, name, weaponId: undefined });
    }
    for (let i = 0; i < this.chips.length; i++) {
      const chip = this.chips[i]!;
      const id = i < slots.length ? (slots[i] ?? null) : null;
      chip.el.hidden = i >= slots.length;
      if (chip.weaponId !== id) {
        chip.weaponId = id;
        setText(chip.name, id ? (getWeaponDef(id)?.shortName ?? id) : HUD.weapon.emptySlot);
        chip.el.classList.toggle('is-empty', id === null);
      }
    }
    this.setCurrentSlot(current);
    this.weaponEl.hidden = slots.every((s) => s === null);
  }

  /** Weapon being raised (weapon:raiseStart / weapon:equipped). */
  setWeapon(weaponId: string | null, slot: number): void {
    this.setCurrentSlot(slot);
    if (weaponId === this.weaponId) return;
    this.weaponId = weaponId;
    const def = weaponId ? getWeaponDef(weaponId) : undefined;
    setText(this.nameEl, weaponId ? (def?.name ?? weaponId) : '');
    this.weaponEl.hidden = weaponId === null && this.chips.every((c) => !c.weaponId);
    if (weaponId) {
      this.switchTimer = HUD.weapon.switchFlashSeconds;
      this.weaponEl.classList.add('is-switching');
    }
  }

  setReloading(reloading: boolean): void {
    if (reloading === this.reloading) return;
    this.reloading = reloading;
    this.ammoEl.classList.toggle('is-reloading', reloading);
    this.refreshPrompt();
  }

  onDryFire(): void {
    this.dryTimer = HUD.ammo.dryFlashSeconds;
    // Two identical shake animations under different names: switching restarts the shake on every
    // click (re-adding the same class would not) without a forced style/layout flush.
    this.dryPhase = !this.dryPhase;
    this.ammoEl.classList.add('is-dry');
    this.ammoEl.classList.toggle('is-dry-a', this.dryPhase);
    this.ammoEl.classList.toggle('is-dry-b', !this.dryPhase);
  }

  update(dt: number): void {
    if (this.dryTimer > 0) {
      this.dryTimer -= dt;
      if (this.dryTimer <= 0) this.ammoEl.classList.remove('is-dry', 'is-dry-a', 'is-dry-b');
    }
    if (this.switchTimer > 0) {
      this.switchTimer -= dt;
      if (this.switchTimer <= 0) this.weaponEl.classList.remove('is-switching');
    }
  }

  private setCurrentSlot(slot: number): void {
    if (slot === this.currentSlot) return;
    this.currentSlot = slot;
    for (let i = 0; i < this.chips.length; i++) this.chips[i]!.el.classList.toggle('is-current', i === slot);
  }

  private refreshPrompt(): void {
    const p = this.mag === null ? 'none' : ammoPrompt(this.mag, this.reserve ?? 0, this.reloading);
    if (p === this.prompt) return;
    this.prompt = p;
    this.promptEl.hidden = p === 'none';
    this.promptEl.classList.toggle('is-empty', p === 'empty');
    if (p !== 'none')
      setText(this.promptEl, p === 'empty' ? HUD.ammo.prompts.empty : HUD.ammo.prompts.reload);
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
