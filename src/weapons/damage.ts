/**
 * Pure damage math: zone multipliers, distance falloff, penetration keep and per-shot hit
 * aggregation (pellets hitting one target become one damage event: one hit marker, one number).
 */
import type { HitZone } from '../core/events';
import { falloffMultiplier } from '../combat/hitMath';
import { COMBAT } from '../defs/combat';
import type { WeaponDamageDef } from '../defs/weapons';

export function zoneMultiplier(def: WeaponDamageDef, zone: HitZone): number {
  switch (zone) {
    case 'head':
      return def.headMultiplier;
    case 'limb':
      return def.limbMultiplier;
    case 'weakpoint':
      return def.weakpointMultiplier;
    case 'body':
    case 'shield':
      return 1;
  }
}

/**
 * Damage of one bullet/pellet at `distance` meters. `keep` is the product of the penetration
 * damage keeps of everything the bullet passed through (1 = direct hit), `scale` an external
 * multiplier (upgrades, perks).
 */
export function hitDamage(
  def: WeaponDamageDef,
  zone: HitZone,
  distance: number,
  keep = 1,
  scale = 1,
): number {
  const falloff = falloffMultiplier(distance, def.falloffStart, def.falloffEnd, def.minFalloffMultiplier);
  const dmg = def.base * zoneMultiplier(def, zone) * falloff * keep * scale;
  return dmg > 0 && Number.isFinite(dmg) ? dmg : 0;
}

/** Higher = more important (weakpoint > head > body > limb > shield). */
export function zoneRank(zone: HitZone): number {
  const order = COMBAT.zonePriority as readonly HitZone[];
  const i = order.indexOf(zone);
  return i < 0 ? 0 : order.length - i;
}

/**
 * Collects the hits of one shot per target. Arrays keep their capacity between shots, so after
 * warm-up adding hits does not allocate. The reported point is the first hit on the best zone.
 */
export class HitAccumulator<T> {
  readonly targets: T[] = [];
  readonly amounts: number[] = [];
  readonly zones: HitZone[] = [];
  readonly hits: number[] = [];
  readonly px: number[] = [];
  readonly py: number[] = [];
  readonly pz: number[] = [];
  private n = 0;

  get count(): number {
    return this.n;
  }

  reset(): void {
    for (let i = 0; i < this.n; i++) this.targets[i] = undefined as unknown as T;
    this.n = 0;
  }

  add(target: T, amount: number, zone: HitZone, x: number, y: number, z: number): void {
    for (let i = 0; i < this.n; i++) {
      if (this.targets[i] !== target) continue;
      this.amounts[i]! += amount;
      this.hits[i]! += 1;
      if (zoneRank(zone) > zoneRank(this.zones[i]!)) {
        this.zones[i] = zone;
        this.px[i] = x;
        this.py[i] = y;
        this.pz[i] = z;
      }
      return;
    }
    const i = this.n++;
    this.targets[i] = target;
    this.amounts[i] = amount;
    this.zones[i] = zone;
    this.hits[i] = 1;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
  }
}
