/**
 * Perk icon row (bottom left, above dash + vitals): one neon glyph per owned perk in its colour
 * (defs/perks.ts PERK_GLYPHS / perkCssColor), in acquisition order. perk:acquired pops the icon in
 * with a glow; perk:lost plays a short removal before the row closes up. Icon elements are pooled
 * (ECONOMY_HUD.perks.maxSlots); a slot is rewritten only when the perk it shows changes.
 */
import { PERK_GLYPHS, getPerkDef, perkCssColor } from '../../defs/perks';
import { ECONOMY_HUD } from '../../defs/ui';
import { glyphIcon, h, restartAnim } from './dom';

const PK = ECONOMY_HUD.perks;

interface SlotView {
  el: HTMLDivElement;
  path: SVGPathElement;
  /** Perk shown (null = hidden). */
  perk: string | null;
  phase: boolean;
}

interface Owned {
  id: string;
  /** Seconds left of the removal animation (<0: not leaving). */
  leaving: number;
}

export class PerkRow {
  readonly el: HTMLDivElement;
  private readonly slots: SlotView[] = [];
  private readonly owned: Owned[] = [];
  private dirty = false;

  constructor(corner: HTMLElement) {
    this.el = h('div', 'hud-perks');
    for (let i = 0; i < PK.maxSlots; i++) {
      const el = h('div', 'hud-perk', this.el);
      const path = glyphIcon('hud-perk__glyph', el);
      el.hidden = true;
      this.slots.push({ el, path, perk: null, phase: false });
    }
    this.el.hidden = true;
    corner.prepend(this.el);
  }

  /** Perks shown, in order (leaving ones included until their animation ended). */
  get shown(): readonly string[] {
    return this.owned.map((o) => o.id);
  }

  add(perkId: string): void {
    const def = getPerkDef(perkId);
    if (!def) return;
    const existing = this.owned.find((o) => o.id === perkId);
    if (existing) {
      existing.leaving = -1;
      this.dirty = true;
      return;
    }
    if (this.owned.length >= this.slots.length) return;
    this.owned.push({ id: perkId, leaving: -1 });
    this.render();
    const slot = this.slots[this.owned.length - 1]!;
    slot.el.classList.remove('is-leaving');
    slot.phase = restartAnim(slot.el, 'is-new', slot.phase);
  }

  remove(perkId: string): void {
    const o = this.owned.find((x) => x.id === perkId);
    if (!o || o.leaving >= 0) return;
    o.leaving = PK.removeSeconds;
    this.dirty = true;
  }

  update(dt: number): void {
    let closed = false;
    for (let i = this.owned.length - 1; i >= 0; i--) {
      const o = this.owned[i]!;
      if (o.leaving < 0) continue;
      o.leaving -= dt;
      if (o.leaving <= 0) {
        this.owned.splice(i, 1);
        closed = true;
      }
    }
    if (closed || this.dirty) this.render();
  }

  clear(): void {
    this.owned.length = 0;
    this.render();
  }

  private render(): void {
    this.dirty = false;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      const o = this.owned[i];
      const id = o ? o.id : null;
      if (id !== s.perk) {
        s.perk = id;
        s.el.hidden = id === null;
        // A slot that now shows another perk (the row closed up) must not replay the pop.
        s.el.classList.remove('is-new-a', 'is-new-b');
        if (id !== null) {
          const def = getPerkDef(id)!;
          s.path.setAttribute('d', PERK_GLYPHS[def.icon] ?? '');
          s.el.style.setProperty('--perk', perkCssColor(def));
          s.el.dataset.perk = id;
        }
      }
      s.el.classList.toggle('is-leaving', !!o && o.leaving >= 0);
    }
    this.el.hidden = this.owned.length === 0;
  }
}
