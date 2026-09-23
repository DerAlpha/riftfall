/**
 * Effective weapon stats: base def + Rift Forge tier + attachment/perk mods + elemental mod
 * (defs/weapons WeaponStatMods). Pure; the weapon system stores the result per carried weapon
 * (WeaponSystem.effectiveDef) so every stat – and every reload marker – comes from one place.
 *
 * Reload times scale as a whole: durations AND marker times (`magIn` commit point, shell insert,
 * pump), so gameplay commits and the viewmodel's marker-synced animation stay aligned.
 */
import type { DamageElement } from '../core/events';
import type { ReloadMarker, WeaponDef, WeaponReloadDef, WeaponStatMods } from '../defs/weapons';

export interface WeaponModState {
  /** Rift Forge tier (0 = base). Tiers are cumulative: tier 2 applies the tier 1 and 2 mods. */
  readonly tier?: number;
  /** Attachment / perk modifiers, applied after the tiers. */
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
  };
  const tier = state.tier ?? 0;
  for (const u of base.upgrades) if (u.tier <= tier) applyMods(f, u.mods);
  for (const m of state.mods ?? []) applyMods(f, m);
  if (state.element) f.element = state.element;
  const element = f.element ?? base.damage.element;
  const unchanged =
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
    element === base.damage.element;
  if (unchanged) return base;

  const s = base.spread;
  const r = base.recoil;
  const k = f.recoil;
  return {
    ...base,
    damage: { ...base.damage, base: base.damage.base * f.damage, element },
    pellets: Math.max(1, Math.round(base.pellets + f.extraPellets)),
    rpm: base.rpm * f.rpm,
    burst: base.burst ? { count: base.burst.count, rpm: base.burst.rpm * f.rpm } : null,
    magazine: Math.max(1, Math.round(base.magazine * f.magazine)),
    reserve: Math.max(0, Math.round(base.reserve * f.reserve)),
    reload: scaleReload(base.reload, f.reloadTime),
    spread: {
      ...s,
      hip: s.hip * f.spread,
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
    range: base.range * f.range,
    penetration: { ...base.penetration, power: base.penetration.power * f.penetration },
  };
}
