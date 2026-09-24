/**
 * What the Werkbank offers for a weapon (pure data, built once per weapon def): its compatible
 * attachments in slot order (defs/attachments ATTACHMENT_SLOTS, only the weapon's own slots),
 * then the element modules it can take (defs/elements elementModsFor – none for wonder weapons,
 * never its own base element). Every entry carries its German texts, price, stat chips and the
 * cached prompts, so the bench never builds strings while it runs.
 */
import { DEG2RAD } from '../core/math';
import { ATTACHMENT_SLOTS, attachmentMods, attachmentsFor, type AttachmentDef } from '../defs/attachments';
import { STATUS_NAMES, elementModsFor, type ElementModDef, type StatusElement } from '../defs/elements';
import type { AttachmentSlot, WeaponDef, WeaponStatMods } from '../defs/weapons';
import { BENCH_STAT_LABELS, WORKBENCH, WORKBENCH_MENU } from '../defs/workshop';
import type { WeaponModState } from '../weapons/resolveWeapon';

export interface BenchStat {
  readonly label: string;
  /** e.g. "−18 %" or "2,5×". */
  readonly text: string;
  readonly good: boolean;
}

export interface BenchEntry {
  readonly kind: 'attachment' | 'element';
  /** Attachment id (defs/attachments) or element module id ('element.<el>'). */
  readonly id: string;
  readonly slot: AttachmentSlot | 'element';
  /** Group heading (German): the slot label or the element group. */
  readonly group: string;
  readonly name: string;
  readonly description: string;
  readonly cost: number;
  /** Element modules: the element, its UI color (sRGB CSS) and glyph path; null for attachments. */
  readonly element: StatusElement | null;
  readonly css: string | null;
  readonly glyph: string | null;
  readonly stats: readonly BenchStat[];
  /** Cached prompts: buy/install and remove/uninstall. */
  readonly promptBuy: string;
  readonly promptRemove: string;
}

/** Reference horizontal FOV (deg) the optics' absolute zoom is defined at (defs/attachments). */
const OPTIC_REFERENCE_FOV_DEG = 90;
const PERCENT = 100;

/** Magnification of an absolute ADS zoom (FOV multiplier at the reference FOV). */
export function opticMagnification(zoom: number): number {
  if (!(zoom > 0) || zoom >= 1) return 1;
  const half = (OPTIC_REFERENCE_FOV_DEG / 2) * DEG2RAD;
  return Math.tan(half) / Math.tan(half * zoom);
}

/** German typography: U+2212 minus, a narrow no-break space before the percent sign. */
const MINUS = String.fromCharCode(0x2212);
const NNBSP = String.fromCharCode(0x202f);

function formatFactor(f: number): string {
  const pct = Math.round((f - 1) * PERCENT);
  return `${pct > 0 ? '+' : pct < 0 ? MINUS : '±'}${Math.abs(pct)}${NNBSP}%`;
}

function formatMagnification(m: number): string {
  return `${m.toFixed(1).replace('.', ',')}×`;
}

/** Stat chips of a mod set (display order of BENCH_STAT_LABELS, at most WORKBENCH_MENU.maxStats). */
export function describeMods(mods: WeaponStatMods, opticZoom?: number | null): BenchStat[] {
  const out: BenchStat[] = [];
  if (opticZoom !== null && opticZoom !== undefined && opticZoom > 0 && opticZoom < 1) {
    out.push({ label: 'Zoom', text: formatMagnification(opticMagnification(opticZoom)), good: true });
  }
  const values = mods as Readonly<Record<string, number | undefined>>;
  for (const { key, label, higherIsBetter } of BENCH_STAT_LABELS) {
    if (out.length >= WORKBENCH_MENU.maxStats) break;
    const f = values[key];
    if (typeof f !== 'number' || !Number.isFinite(f) || Math.abs(f - 1) < WORKBENCH_MENU.statEpsilon)
      continue;
    out.push({ label, text: formatFactor(f), good: f > 1 === higherIsBetter });
  }
  return out;
}

function fill(template: string, name: string): string {
  return template.replace('{name}', name);
}

function attachmentEntry(a: AttachmentDef, weapon: WeaponDef, group: string): BenchEntry {
  const P = WORKBENCH.prompts;
  return {
    kind: 'attachment',
    id: a.id,
    slot: a.slot,
    group,
    name: a.name,
    description: a.description,
    cost: a.cost,
    element: null,
    css: null,
    glyph: null,
    stats: describeMods(attachmentMods(a, weapon), a.optic?.zoom),
    promptBuy: fill(P.buy, a.name),
    promptRemove: fill(P.remove, a.name),
  };
}

function elementEntry(m: ElementModDef): BenchEntry {
  const P = WORKBENCH.prompts;
  return {
    kind: 'element',
    id: m.id,
    slot: 'element',
    group: WORKBENCH_MENU.elementGroup,
    name: m.name,
    description: m.description,
    cost: m.cost,
    element: m.element,
    css: m.css,
    glyph: m.glyph,
    stats: [{ label: 'Status', text: STATUS_NAMES[m.status], good: true }],
    promptBuy: fill(P.install, m.short),
    promptRemove: fill(P.uninstall, m.short),
  };
}

/** Every bench entry for `weapon` (base def), in menu order. */
export function benchEntries(weapon: WeaponDef): BenchEntry[] {
  const out: BenchEntry[] = [];
  for (const { slot, name } of ATTACHMENT_SLOTS) {
    if (!weapon.attachmentSlots.includes(slot)) continue;
    for (const a of attachmentsFor(weapon, slot)) out.push(attachmentEntry(a, weapon, name));
  }
  for (const m of elementModsFor(weapon)) out.push(elementEntry(m));
  return out;
}

/** The entry is fitted to the weapon right now. */
export function entryEquipped(e: BenchEntry, mods: WeaponModState | null): boolean {
  if (!mods) return false;
  if (e.kind === 'element') return e.element !== null && mods.element === e.element;
  const list = mods.attachments;
  if (!list) return false;
  for (let i = 0; i < list.length; i++) if (list[i] === e.id) return true;
  return false;
}

/**
 * The mod state after using `e` on a weapon with `mods`: an equipped entry comes off; otherwise
 * it goes on (replacing whatever held its slot / the element). Tier and stat mods are kept.
 */
export function modsAfterUse(
  e: BenchEntry,
  mods: WeaponModState | null,
  slotOf: (id: string) => string | null,
): WeaponModState {
  const base: WeaponModState = mods ?? {};
  const equipped = entryEquipped(e, mods);
  if (e.kind === 'element') return { ...base, element: equipped ? null : e.element };
  const current = base.attachments ?? [];
  const kept = current.filter((id) => id !== e.id && slotOf(id) !== e.slot);
  return { ...base, attachments: equipped ? current.filter((id) => id !== e.id) : [...kept, e.id] };
}
