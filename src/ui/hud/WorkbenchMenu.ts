/**
 * Werkbank menu (M5): a compact, non-pausing list left of the crosshair while the bench menu is
 * open (driven by interactables/Workbench.ts through WorkbenchMenuApi). Shows the weapon in hand,
 * its compatible attachments grouped by slot and the element modules – price or fitted state per
 * row, the selected row's stat chips and description, and the selection hint for the active
 * device (the interact prompt below the crosshair names the action and its price).
 *
 * Rows are built once per open (a weapon has at most ~30 entries); selection, fitted flags,
 * affordability and flashes only toggle classes; the list scrolls by a transform so the selected
 * row stays in the visible window (WORKBENCH_MENU.visibleRows). Lives inside the HUD layer, so it
 * hides with the HUD behind pause menus.
 */
import type { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { WORKBENCH_MENU } from '../../defs/workshop';
import type { BenchEntry } from '../../interactables/benchEntries';
import type { WorkbenchMenuApi } from '../../interactables/Workbench';
import { glyphIcon, h, restartAnim, setText } from './dom';
import { formatPoints } from './economyModel';
import './hud-workbench.css';

const WM = WORKBENCH_MENU;
/** Row heights (px, must match hud-workbench.css): item rows and group headings. */
const ROW_PX = 26;
const HEAD_PX = 20;

interface RowView {
  el: HTMLDivElement;
  price: HTMLSpanElement;
  /** Top offset of the row inside the list (px). */
  top: number;
  phase: boolean;
}

export class WorkbenchMenu implements WorkbenchMenuApi {
  readonly el: HTMLDivElement;
  private readonly weaponEl: HTMLSpanElement;
  private readonly viewport: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly statsEl: HTMLDivElement;
  private readonly descEl: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private rows: RowView[] = [];
  private entries: readonly BenchEntry[] = [];
  private selected = -1;
  private scroll = 0;
  private listHeight = 0;
  private visible = false;
  private inPhase = false;
  private device: 'kbm' | 'gamepad' = 'kbm';
  private readonly offs: (() => void)[] = [];

  constructor(layer: HTMLElement, events?: EventBus<GameEvents> | null) {
    this.el = h('div', 'hud-bench', layer);
    this.el.hidden = true;
    const head = h('div', 'hud-bench__head', this.el);
    h('span', 'hud-bench__title', head).textContent = WM.title;
    this.weaponEl = h('span', 'hud-bench__weapon', head);
    this.viewport = h('div', 'hud-bench__viewport', this.el);
    this.viewport.style.height = `${WM.visibleRows * ROW_PX}px`;
    this.list = h('div', 'hud-bench__list', this.viewport);
    const detail = h('div', 'hud-bench__detail', this.el);
    this.statsEl = h('div', 'hud-bench__stats', detail);
    this.descEl = h('div', 'hud-bench__desc', detail);
    this.hintEl = h('div', 'hud-bench__hint', this.el);
    this.writeHint();
    if (events) {
      this.offs.push(events.on('input:deviceChanged', (e) => this.setInputDevice(e.device)));
    }
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Index of the highlighted row's entry (-1 = none). */
  get selectedIndex(): number {
    return this.selected;
  }

  setInputDevice(device: 'kbm' | 'gamepad'): void {
    if (device === this.device) return;
    this.device = device;
    this.writeHint();
  }

  open(weaponName: string, entries: readonly BenchEntry[]): void {
    this.entries = entries;
    setText(this.weaponEl, weaponName);
    this.buildRows(entries);
    this.selected = -1;
    this.scroll = -1;
    if (!this.visible) {
      this.visible = true;
      this.el.hidden = false;
      this.inPhase = restartAnim(this.el, 'is-in', this.inPhase);
    }
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.hidden = true;
  }

  setSelected(index: number): void {
    if (index === this.selected) return;
    this.rows[this.selected]?.el.classList.remove('is-selected');
    this.selected = index;
    const row = this.rows[index];
    if (!row) return;
    row.el.classList.add('is-selected');
    this.writeDetail(this.entries[index]!);
    this.scrollTo(row);
  }

  setStates(equipped: readonly boolean[], points: number): void {
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]!;
      const e = this.entries[i]!;
      const on = equipped[i] === true;
      row.el.classList.toggle('is-equipped', on);
      row.el.classList.toggle('is-short', !on && e.cost > points);
      setText(row.price, on ? (e.kind === 'element' ? WM.installed : WM.equipped) : formatPoints(e.cost));
    }
  }

  flash(index: number): void {
    const row = this.rows[index];
    if (row) row.phase = restartAnim(row.el, 'is-flash', row.phase);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.el.remove();
  }

  // -------------------------------------------------------------------------

  private buildRows(entries: readonly BenchEntry[]): void {
    this.list.replaceChildren();
    this.rows = [];
    let group = '';
    let top = 0;
    for (const e of entries) {
      if (e.group !== group) {
        group = e.group;
        const head = h('div', 'hud-bench__group', this.list);
        head.textContent = group;
        top += HEAD_PX;
      }
      const el = h('div', `hud-bench__row${e.kind === 'element' ? ' is-element' : ''}`, this.list);
      if (e.kind === 'element' && e.css) {
        el.style.setProperty('--bench-el', e.css);
        glyphIcon('hud-bench__glyph', el, e.glyph ?? '');
      } else {
        h('span', 'hud-bench__pip', el);
      }
      h('span', 'hud-bench__name', el).textContent = e.name;
      const price = h('span', 'hud-bench__price', el);
      price.textContent = formatPoints(e.cost);
      this.rows.push({ el, price, top, phase: false });
      top += ROW_PX;
    }
    this.listHeight = top;
    this.list.style.transform = 'translateY(0px)';
  }

  /** Keep the selected row (and its group heading) inside the visible window. */
  private scrollTo(row: RowView): void {
    const windowPx = WM.visibleRows * ROW_PX;
    const maxScroll = Math.max(0, this.listHeight - windowPx);
    let s = this.scroll < 0 ? 0 : this.scroll;
    const top = row.top - HEAD_PX;
    if (top < s) s = Math.max(0, top);
    else if (row.top + ROW_PX > s + windowPx) s = row.top + ROW_PX - windowPx;
    s = Math.min(maxScroll, Math.max(0, s));
    if (s === this.scroll) return;
    this.scroll = s;
    this.list.style.transform = `translateY(${-s}px)`;
    this.viewport.classList.toggle('has-above', s > 0);
    this.viewport.classList.toggle('has-below', s < maxScroll);
  }

  private writeDetail(e: BenchEntry): void {
    this.statsEl.replaceChildren();
    for (const s of e.stats) {
      const chip = h('span', `hud-bench__stat${s.good ? ' is-good' : ' is-bad'}`, this.statsEl);
      h('span', 'hud-bench__stat-label', chip).textContent = s.label;
      h('span', 'hud-bench__stat-value', chip).textContent = s.text;
    }
    setText(this.descEl, e.description);
  }

  private writeHint(): void {
    const key = this.device === 'gamepad' ? WM.hints.keysPad : WM.hints.keysKbm;
    this.hintEl.replaceChildren();
    h('span', 'hud-bench__key', this.hintEl).textContent = key;
    h('span', 'hud-bench__hint-text', this.hintEl).textContent = WM.hints.select;
  }
}
