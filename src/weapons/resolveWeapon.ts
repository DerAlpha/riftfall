/**
 * Effective weapon stats: base def + Rift Forge tier + attachments + attachment/perk mods +
 * elemental mod (defs/weapons WeaponStatMods). Pure; the weapon system stores the result per
 * carried weapon (WeaponSystem.effectiveDef) so every stat – and every reload marker – comes from
 * one place.
 *
 * Order: tiers 1..tier (cumulative) → attachments (defs/attachments attachmentMods: an optic's
 * absolute zoom becomes the adsZoom factor) → `mods` (perks, stats) → the element mod.
 *
 * - Reload times scale as a whole: durations AND marker times (`magIn` commit point, shell insert,
 *   pump), so gameplay commits and the viewmodel's marker-synced animation stay aligned.
 * - A Rift Forge tier renames the weapon (the HUD shows `name`), may bring a special (kept by
 *   higher tiers unless they define their own; `null` removes it) and recolors the tracer (the
 *   tier's `tracerColor`, else its forge look's tracer).
 * - Kind data follows the stats: damage scales projectile blasts, field dps/collapses and nothing
 *   else absolute (special damages are tier data); rpm scales a beam's tick and drain rates;
 *   projectileSpeed / blastRadius / chargeTime scale their kind data; an element mod turns a
 *   projectile's blast of the weapon's own element into that element (convention VFX/audio ids).
 * - Handling: adsTime (in/out), adsZoom, equipTime, moveSpeed (ADS speed and carry speed),
 *   hipSpread (hip cone only).
 */
import type { DamageElement } from '../core/events';
import { getAttachmentDef, attachmentMods } from '../defs/attachments';
import { getForgeLook, forgePaletteId } from '../defs/forge';
import type {
  ExplosionDef,
  FieldDef,
  ReloadMarker,
  WeaponDef,
  WeaponProjectileDef,
  WeaponReloadDef,
  WeaponSpecialDef,
  WeaponStatMods,
  WeaponUpgradeTier,
} from '../defs/weapons';

export interface WeaponModState {
  /** Rift Forge tier (0 = base). Tiers are cumulative: tier 2 applies the tier 1 and 2 mods. */
  readonly tier?: number;
  /** Attachment ids (defs/attachments.ts), applied after the tiers; unknown ids are ignored. */
  readonly attachments?: readonly string[];
  /** Perk / stat modifiers, applied after the attachments. */
  readonly mods?: readonly WeaponStatMods[];
  /** Elemental mod: replaces the damage element (wins over tier/attachment elements). */
  readonly element?: DamageElement | null;
}

interface Factors {
  damage: number;
  rpm: number;
  magazine: number;
  reserve: number;
  reloadTime: number;
  spread: number;
  recoil: number;
  range: number;
  penetration: number;
  extraPellets: number;
  element: DamageElement | null;
  adsTime: number;
  adsZoom: number;
  equipTime: number;
  moveSpeed: number;
  hipSpread: number;
  projectileSpeed: number;
  blastRadius: number;
  chargeTime: number;
}

function factor(v: number | undefined): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : 1;
}

function applyMods(f: Factors, m: WeaponStatMods): void {
  f.damage *= factor(m.damage);
  f.rpm *= factor(m.rpm);
  f.magazine *= factor(m.magazine);
  f.reserve *= factor(m.reserve);
  f.reloadTime *= factor(m.reloadTime);
  f.spread *= factor(m.spread);
  f.recoil *= factor(m.recoil);
  f.range *= factor(m.range);
  f.penetration *= factor(m.penetration);
  if (m.extraPellets !== undefined && Number.isFinite(m.extraPellets)) f.extraPellets += m.extraPellets;
  if (m.element) f.element = m.element;
  f.adsTime *= factor(m.adsTime);
  f.adsZoom *= factor(m.adsZoom);
  f.equipTime *= factor(m.equipTime);
  f.moveSpeed *= factor(m.moveSpeed);
  f.hipSpread *= factor(m.hipSpread);
  f.projectileSpeed *= factor(m.projectileSpeed);
  f.blastRadius *= factor(m.blastRadius);
  f.chargeTime *= factor(m.chargeTime);
}

function neutral(f: Factors): boolean {
  return (
    f.damage === 1 &&
    f.rpm === 1 &&
    f.magazine === 1 &&
    f.reserve === 1 &&
    f.reloadTime === 1 &&
    f.spread === 1 &&
    f.recoil === 1 &&
    f.range === 1 &&
    f.penetration === 1 &&
    f.extraPellets === 0 &&
    f.adsTime === 1 &&
    f.adsZoom === 1 &&
    f.equipTime === 1 &&
    f.moveSpeed === 1 &&
    f.hipSpread === 1 &&
    f.projectileSpeed === 1 &&
    f.blastRadius === 1 &&
    f.chargeTime === 1
  );
}

function scaleMarkers(list: readonly ReloadMarker[], k: number): readonly ReloadMarker[] {
  return list.map((m) => ({ step: m.step, at: m.at * k }));
}

function scaleReload(r: WeaponReloadDef, k: number): WeaponReloadDef {
  if (k === 1) return r;
  const ps = r.perShell;
  return {
    tactical: r.tactical * k,
    empty: r.empty * k,
    tacticalSteps: scaleMarkers(r.tacticalSteps, k),
    emptySteps: scaleMarkers(r.emptySteps, k),
    perShell: ps
      ? {
          start: ps.start * k,
          shell: ps.shell * k,
          insertAt: ps.insertAt * k,
          end: ps.end * k,
          emptyEnd: ps.emptyEnd * k,
          pumpAt: ps.pumpAt * k,
        }
      : null,
  };
}

/** Convention ids of an explosion switched to `to` (only ids that follow the `from` element's convention). */
function retargetId(id: string, from: DamageElement, to: DamageElement): string {
  const own = from === 'physical' ? ['explosion.frag', 'explosion.physical'] : [`explosion.${from}`];
  for (const prefix of own) {
    if (id === prefix || id.startsWith(`${prefix}.`)) {
      const rest = id.slice(prefix.length);
      const head = to === 'physical' ? (prefix === 'explosion.frag' ? 'explosion.frag' : 'explosion.physical') : `explosion.${to}`;
      return head + rest;
    }
  }
  return id;
}

function scaleExplosion(
  e: ExplosionDef | null,
  damage: number,
  radius: number,
  baseElement: DamageElement,
  element: DamageElement,
): ExplosionDef | null {
  if (!e) return null;
  const swap = element !== baseElement && e.element === baseElement;
  if (damage === 1 && radius === 1 && !swap) return e;
  return {
    ...e,
    damage: e.damage * damage,
    radius: e.radius * radius,
    element: swap ? element : e.element,
    vfx: swap ? retargetId(e.vfx, e.element, element) : e.vfx,
    audio: swap ? retargetId(e.audio, e.element, element) : e.audio,
  };
}

function scaleField(f: FieldDef | null, damage: number): FieldDef | null {
  if (!f || damage === 1) return f;
  return {
    ...f,
    dps: f.dps * damage,
    collapse: f.collapse ? { ...f.collapse, damage: f.collapse.damage * damage } : null,
  };
}

function scaleProjectile(
  p: WeaponProjectileDef | null | undefined,
  f: Factors,
  baseElement: DamageElement,
  element: DamageElement,
): WeaponProjectileDef | null | undefined {
  if (!p) return p;
  return {
    ...p,
    speed: p.speed * f.projectileSpeed,
    explosion: scaleExplosion(p.explosion, f.damage, f.blastRadius, baseElement, element),
    field: scaleField(p.field, f.damage),
  };
}

/** The newest tier ≤ `tier` (null at tier 0 or without upgrades). */
function currentTier(base: WeaponDef, tier: number): WeaponUpgradeTier | null {
  let best: WeaponUpgradeTier | null = null;
  for (const u of base.upgrades) if (u.tier <= tier && (!best || u.tier > best.tier)) best = u;
  return best;
}

/** Special at `tier`: the base special, replaced by every tier ≤ `tier` that defines one (in order). */
export function specialAt(base: WeaponDef, tier: number): WeaponSpecialDef | null {
  let special: WeaponSpecialDef | null = base.special ?? null;
  const tiers = [...base.upgrades].sort((a, b) => a.tier - b.tier);
  for (const u of tiers) if (u.tier <= tier && u.special !== undefined) special = u.special;
  return special;
}

/**
 * The def a weapon fires with. Returns `base` itself when nothing changes (no allocation for
 * unmodded weapons); otherwise a new def – call on upgrade/attach, never per frame.
 */
export function resolveWeapon(base: WeaponDef, state: WeaponModState = {}): WeaponDef {
  const f: Factors = {
    damage: 1,
    rpm: 1,
    magazine: 1,
    reserve: 1,
    reloadTime: 1,
    spread: 1,
    recoil: 1,
    range: 1,
    penetration: 1,
    extraPellets: 0,
    element: null,
    adsTime: 1,
    adsZoom: 1,
    equipTime: 1,
    moveSpeed: 1,
    hipSpread: 1,
    projectileSpeed: 1,
    blastRadius: 1,
    chargeTime: 1,
  };
  const tier = Math.max(0, Math.floor(state.tier ?? 0));
  for (const u of base.upgrades) if (u.tier <= tier) applyMods(f, u.mods);
  for (const id of state.attachments ?? []) {
    const att = getAttachmentDef(id);
    if (att) applyMods(f, attachmentMods(att, base));
  }
  for (const m of state.mods ?? []) applyMods(f, m);
  if (state.element) f.element = state.element;
  const baseElement = base.damage.element;
  const element = f.element ?? baseElement;
  const upgrade = currentTier(base, tier);
  if (neutral(f) && element === baseElement && !upgrade) return base;

  const s = base.spread;
  const r = base.recoil;
  const k = f.recoil;
  const special = upgrade ? specialAt(base, tier) : (base.special ?? null);
  const look = upgrade ? getForgeLook(forgePaletteId(base, tier)) : undefined;
  const tracerColor = upgrade ? (upgrade.tracerColor ?? look?.tracer ?? base.tracer.color) : base.tracer.color;
  const carry = (base.carrySpeedMultiplier ?? 1) * f.moveSpeed;
  const out: WeaponDef = {
    ...base,
    name: upgrade ? upgrade.name : base.name,
    damage: { ...base.damage, base: base.damage.base * f.damage, element },
    pellets: Math.max(1, Math.round(base.pellets + f.extraPellets)),
    rpm: base.rpm * f.rpm,
    burst: base.burst ? { count: base.burst.count, rpm: base.burst.rpm * f.rpm } : null,
    magazine: Math.max(1, Math.round(base.magazine * f.magazine)),
    reserve: Math.max(0, Math.round(base.reserve * f.reserve)),
    reload: scaleReload(base.reload, f.reloadTime),
    spread: {
      ...s,
      hip: s.hip * f.spread * f.hipSpread,
      ads: s.ads * f.spread,
      moveAdd: s.moveAdd * f.spread,
      airAdd: s.airAdd * f.spread,
      perShotBloom: s.perShotBloom * f.spread,
      bloomMax: s.bloomMax * f.spread,
    },
    recoil:
      k === 1
        ? r
        : {
            ...r,
            pattern: r.pattern.map(([yaw, pitch]) => [yaw * k, pitch * k] as const),
            randomYaw: r.randomYaw * k,
            randomPitch: r.randomPitch * k,
            viewPunch: { pitch: r.viewPunch.pitch * k, yaw: r.viewPunch.yaw * k, roll: r.viewPunch.roll * k },
          },
    ads: {
      ...base.ads,
      zoom: base.ads.zoom * f.adsZoom,
      inTime: base.ads.inTime * f.adsTime,
      outTime: base.ads.outTime * f.adsTime,
      moveSpeedMultiplier: base.ads.moveSpeedMultiplier * f.moveSpeed,
    },
    range: base.range * f.range,
    penetration: { ...base.penetration, power: base.penetration.power * f.penetration },
    equipTime: base.equipTime * f.equipTime,
    tracer: tracerColor === base.tracer.color ? base.tracer : { ...base.tracer, color: tracerColor },
    special,
    projectile: scaleProjectile(base.projectile, f, baseElement, element),
    beam: base.beam
      ? {
          ...base.beam,
          range: base.beam.range * f.range,
          tickRate: base.beam.tickRate * f.rpm,
          ammoPerSecond: base.beam.ammoPerSecond * f.rpm,
        }
      : base.beam,
    charge: base.charge ? { ...base.charge, time: base.charge.time * f.chargeTime } : base.charge,
  };
  if (base.carrySpeedMultiplier !== undefined || carry !== 1) {
    return { ...out, carrySpeedMultiplier: carry };
  }
  return out;
}
