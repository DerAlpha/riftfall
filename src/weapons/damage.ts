/**
 * Pure damage math: zone multipliers, distance falloff, penetration keep and per-shot hit
 * aggregation (pellets hitting one zone of one target become one damage event; the HUD merges a
 * target's events into one number).
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
 * Collects the hits of one shot per (target, zone). Targets apply their own zone multipliers
 * (armor, weak spots) per damage event, so pellets that hit different zones of one target must
 * stay separate groups: one summed event would apply the best zone's multiplier to every pellet.
 * Groups of one target are contiguous, best zone first (hit feedback reads the first event;
 * the HUD merges a target's numbers). Arrays keep their capacity between shots, so after warm-up
 * adding hits does not allocate. The reported point is the first hit in the group.
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
    const rank = zoneRank(zone);
    let at = this.n;
    let seen = false;
    for (let i = 0; i < this.n; i++) {
      if (this.targets[i] !== target) {
        if (!seen) continue;
        at = i;
        break;
      }
      seen = true;
      if (this.zones[i] === zone) {
        this.amounts[i]! += amount;
        this.hits[i]! += 1;
        return;
      }
      if (zoneRank(this.zones[i]!) < rank) {
        at = i;
        break;
      }
    }
    for (let i = this.n; i > at; i--) {
      this.targets[i] = this.targets[i - 1]!;
      this.amounts[i] = this.amounts[i - 1]!;
      this.zones[i] = this.zones[i - 1]!;
      this.hits[i] = this.hits[i - 1]!;
      this.px[i] = this.px[i - 1]!;
      this.py[i] = this.py[i - 1]!;
      this.pz[i] = this.pz[i - 1]!;
    }
    this.n++;
    this.targets[at] = target;
    this.amounts[at] = amount;
    this.zones[at] = zone;
    this.hits[at] = 1;
    this.px[at] = x;
    this.py[at] = y;
    this.pz[at] = z;
  }
}
