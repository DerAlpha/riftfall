/**
 * Stat → weapon conversion (pure; WeaponSystem consumes it). Def-changing stats become one
 * WeaponStatMods entry that resolveWeapon applies after the weapon's own tier/attachment mods, so
 * the effective def (rpm, reload durations AND markers, magazine, reserve, spread, recoil, damage)
 * stays the single source of truth for gameplay, HUD and viewmodel. Per-use stats (ADS rate,
 * precision and melee multipliers, bonus slots) are read by the weapon system directly.
 */
import type { StatsApi } from '../core/contracts';
import type { WeaponStatMods } from '../defs/weapons';

export interface WeaponStatFactors {
  // --- def-changing (resolveWeapon) ---
  fireRate: number;
  reloadSpeed: number;
  damage: number;
  spread: number;
  recoil: number;
  magazineSize: number;
  reserveAmmo: number;
  // --- per use ---
  adsSpeed: number;
  headshot: number;
  melee: number;
  /** Add-only inventory bonus (whole slots). */
  weaponSlots: number;
}

export function createWeaponStatFactors(): WeaponStatFactors {
  return {
    fireRate: 1,
    reloadSpeed: 1,
    damage: 1,
    spread: 1,
    recoil: 1,
    magazineSize: 1,
    reserveAmmo: 1,
    adsSpeed: 1,
    headshot: 1,
    melee: 1,
    weaponSlots: 0,
  };
}

function positive(v: number, fallback: number): number {
  return v > 0 && Number.isFinite(v) ? v : fallback;
}

function nonNegative(v: number, fallback: number): number {
  return v >= 0 && Number.isFinite(v) ? v : fallback;
}

/**
 * Read the weapon stats into `out` (null stats = base values). Returns true when a def-changing
 * factor changed (the carried weapons must be re-resolved).
 */
export function readWeaponStats(stats: Pick<StatsApi, 'value'> | null, out: WeaponStatFactors): boolean {
  const v = (id: string, base: number): number => (stats ? stats.value(id) : base);
  const fireRate = positive(v('fireRate', 1), 1);
  const reloadSpeed = positive(v('reloadSpeed', 1), 1);
  const damage = nonNegative(v('damage', 1), 1);
  const spread = nonNegative(v('spread', 1), 1);
  const recoil = nonNegative(v('recoil', 1), 1);
  const magazineSize = positive(v('magazineSize', 1), 1);
  const reserveAmmo = nonNegative(v('reserveAmmo', 1), 1);
  const changed =
    fireRate !== out.fireRate ||
    reloadSpeed !== out.reloadSpeed ||
    damage !== out.damage ||
    spread !== out.spread ||
    recoil !== out.recoil ||
    magazineSize !== out.magazineSize ||
    reserveAmmo !== out.reserveAmmo;
  out.fireRate = fireRate;
  out.reloadSpeed = reloadSpeed;
  out.damage = damage;
  out.spread = spread;
  out.recoil = recoil;
  out.magazineSize = magazineSize;
  out.reserveAmmo = reserveAmmo;
  out.adsSpeed = positive(v('adsSpeed', 1), 1);
  out.headshot = nonNegative(v('headshotMultiplier', 1), 1);
  out.melee = nonNegative(v('meleeDamage', 1), 1);
  out.weaponSlots = Math.max(0, Math.floor(nonNegative(v('weaponSlots', 0), 0)));
  return changed;
}

/**
 * The def-changing factors as resolveWeapon mods (reload TIME is the inverse of the reload rate);
 * null when every factor is neutral (weapons keep their base def: no allocation, identical play).
 * resolveWeapon ignores a factor of 0, so a zero spread/recoil/damage stat is floored to a tiny
 * positive value instead of silently doing nothing.
 */
export function weaponStatMods(f: Readonly<WeaponStatFactors>): WeaponStatMods | null {
  if (
    f.fireRate === 1 &&
    f.reloadSpeed === 1 &&
    f.damage === 1 &&
    f.spread === 1 &&
    f.recoil === 1 &&
    f.magazineSize === 1 &&
    f.reserveAmmo === 1
  ) {
    return null;
  }
  const tiny = 1e-6;
  return {
    rpm: f.fireRate,
    reloadTime: 1 / f.reloadSpeed,
    damage: Math.max(tiny, f.damage),
    spread: Math.max(tiny, f.spread),
    recoil: Math.max(tiny, f.recoil),
    magazine: f.magazineSize,
    reserve: Math.max(tiny, f.reserveAmmo),
  };
}

/** Head / weakpoint hits get the precision stat on top of the weapon's zone multiplier. */
export function precisionScale(zone: string, headshot: number): number {
  return zone === 'head' || zone === 'weakpoint' ? headshot : 1;
}
