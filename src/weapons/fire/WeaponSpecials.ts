/**
 * Weapon specials interpreter (M5 WeaponSpecialDef, data only – no per-weapon code). The damage
 * dealers report every damage event of a special-carrying source here (SpecialsHook.onHit): the
 * weapon system's bullets and beam ticks, projectile hits, explosions and field ticks.
 *
 * Per-hit specials (the fire-time ones – splitShot, critBurst, ricochet – are applied by the weapon
 * system when it fires):
 * - explosiveRounds: a primary bullet/projectile/beam hit detonates `explosion` (chance) at the
 *   hit point; blasts never set off more (no feedback loop).
 * - chainArc: a primary hit (a blast: its first target) arcs lightning (`damage`, shock) to
 *   `count` enemies hop by hop within `range` with line of sight; arcs never arc again.
 * - elementProc: a primary hit builds `amount` of `element`'s status (StatusEffectsApi, package B;
 *   without it nothing happens).
 * - lifesteal: `fraction` of every damage point the player's source deals heals the player.
 * - fieldOnKill: a kill (any delivery) leaves `field` at the body (chance); kills inside that
 *   field may leave more (bounded by the field pool).
 *
 * Chain-arc visuals are short flashes drawn each frame through ArsenalVfxApi.beam (pooled).
 * Chance rolls use the seeded gameplay Rng.
 */
import { Vector3 } from 'three';
import type {
  ArsenalVfxApi,
  DamageInfo,
  Damageable,
  ExplosionApi,
  FieldApi,
  StatusEffectsApi,
  WeaponCombatApi,
} from '../../core/contracts';
import type { DamageElement, Vec3Like } from '../../core/events';
import { Rng } from '../../core/Rng';
import { ARSENAL } from '../../defs/combat';
import { NULL_ARSENAL_VFX } from './nullArsenalVfx';
import { createSpecialHit, type SpecialHit, type SpecialsHook } from './types';

export type SpecialsCombat = Pick<WeaponCombatApi, 'queryRadius' | 'dealDamage' | 'lineOfSight'>;

export interface WeaponSpecialsDeps {
  combat: SpecialsCombat;
  explosions?: ExplosionApi | null;
  fields?: FieldApi | null;
  vfx?: ArsenalVfxApi | null;
  /** Status effects (package B); elementProc does nothing without it. */
  status?: Pick<StatusEffectsApi, 'applyElement'> | null;
  /** Heals the player (lifesteal); returns the amount healed. */
  heal?: ((amount: number) => number | void) | null;
  seed?: string | number;
}

/** Status build-up per damage point of `element` (DamageInfo.statusBuildup). */
export function statusBuildupFor(element: DamageElement): number {
  return ARSENAL.statusBuildup[element] ?? 0;
}

interface ArcFlash {
  ttl: number;
  /** Chain points: hit point, then each hop's aim point. */
  readonly points: Vector3[];
  count: number;
}

const _prev = new Vector3();
const _point = new Vector3();
const _dir = new Vector3();

export class WeaponSpecials implements SpecialsHook {
  readonly stats = { procs: 0, arcs: 0, heals: 0, fields: 0, explosions: 0 };

  private readonly combat: SpecialsCombat;
  private explosions: ExplosionApi | null;
  private fields: FieldApi | null;
  private vfx: ArsenalVfxApi;
  private status: Pick<StatusEffectsApi, 'applyElement'> | null;
  private heal: ((amount: number) => number | void) | null;
  private readonly rng: Rng;

  private readonly chain: Damageable[] = [];
  private readonly query: Damageable[] = [];
  private readonly flashes: ArcFlash[] = [];
  private flashCursor = 0;
  private readonly pairs: Vector3[] = [];
  private readonly arcHit: SpecialHit = createSpecialHit();
  private readonly arcInfo: DamageInfo = {
    amount: 0,
    zone: 'body',
    point: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    weaponId: '',
    element: ARSENAL.specials.arcElement,
    source: 'player',
    kind: 'beam',
    impulse: 0,
    statusBuildup: 0,
  };
  private readonly areaFrom: {
    weaponId: string;
    source: DamageInfo['source'];
    statusBuildup: number;
    special: SpecialHit['special'];
    areaScale: number;
  } = { weaponId: '', source: 'player', statusBuildup: 0, special: null, areaScale: 1 };

  constructor(deps: WeaponSpecialsDeps) {
    this.combat = deps.combat;
    this.explosions = deps.explosions ?? null;
    this.fields = deps.fields ?? null;
    this.vfx = deps.vfx ?? NULL_ARSENAL_VFX;
    this.status = deps.status ?? null;
    this.heal = deps.heal ?? null;
    this.rng = new Rng(deps.seed ?? 'specials');
    const S = ARSENAL.specials;
    for (let i = 0; i < S.arcCapacity; i++) {
      const points: Vector3[] = [];
      for (let j = 0; j <= S.maxChain; j++) points.push(new Vector3());
      this.flashes.push({ ttl: 0, points, count: 0 });
    }
    for (let j = 0; j < S.maxChain * 2; j++) this.pairs.push(new Vector3());
  }

  attach(parts: { explosions?: ExplosionApi | null; fields?: FieldApi | null }): void {
    if (parts.explosions !== undefined) this.explosions = parts.explosions;
    if (parts.fields !== undefined) this.fields = parts.fields;
  }

  setVfx(vfx: ArsenalVfxApi | null): void {
    this.vfx = vfx ?? NULL_ARSENAL_VFX;
  }

  /** Package B: status effects for elementProc (null = no procs). */
  setStatus(status: Pick<StatusEffectsApi, 'applyElement'> | null): void {
    this.status = status;
  }

  setHeal(heal: ((amount: number) => number | void) | null): void {
    this.heal = heal;
  }

  onHit(hit: SpecialHit): void {
    const s = hit.special;
    if (!s) return;
    const via = hit.via;
    switch (s.kind) {
      case 'explosiveRounds': {
        if (!hit.primary || (via !== 'direct' && via !== 'tick') || !this.explosions) return;
        if (!this.roll(s.chance)) return;
        this.stats.procs++;
        this.stats.explosions++;
        const from = this.areaFrom;
        from.weaponId = hit.weaponId;
        from.source = hit.source;
        from.statusBuildup = statusBuildupFor(s.explosion.element);
        from.special = null;
        from.areaScale = 1;
        _point.set(hit.point.x, hit.point.y, hit.point.z);
        this.explosions.explode(_point, s.explosion, from);
        return;
      }
      case 'chainArc': {
        if (!hit.primary || via === 'arc' || !this.roll(s.chance)) return;
        this.stats.procs++;
        this.arc(hit, s.count, s.range, s.damage);
        return;
      }
      case 'elementProc': {
        if (!hit.primary || via === 'arc' || !this.status || !hit.target.alive) return;
        if (!this.roll(s.chance)) return;
        this.stats.procs++;
        this.status.applyElement(hit.target, s.element, s.amount, hit.source, hit.weaponId);
        return;
      }
      case 'lifesteal': {
        if (hit.source !== 'player' || !(hit.applied > 0) || !this.heal || !(s.fraction > 0)) return;
        this.heal(hit.applied * s.fraction);
        this.stats.heals++;
        return;
      }
      case 'fieldOnKill': {
        if (!hit.killed || !this.fields || !this.roll(s.chance)) return;
        const from = this.areaFrom;
        from.weaponId = hit.weaponId;
        from.source = hit.source;
        from.statusBuildup = statusBuildupFor(s.field.element);
        // Kills inside the new field may leave more (Urknall): the special travels with it.
        from.special = hit.special;
        from.areaScale = 1;
        _point.copy(hit.target.boundsCenter);
        if (this.fields.spawn(_point, s.field, from) > 0) this.stats.fields++;
        return;
      }
      case 'splitShot':
      case 'critBurst':
      case 'ricochet':
        // Fire-time specials: the weapon system applies them when the shot leaves the barrel.
        return;
    }
  }

  /**
   * Enemies a chain from `first` reaches: up to `count` hops, each the nearest living enemy within
   * `range` of the previous link's aim point with line of sight, never one already in the chain.
   * Fills and returns `out` (without `first`).
   */
  selectChain(first: Damageable, count: number, range: number, out: Damageable[]): Damageable[] {
    out.length = 0;
    const n = Math.min(Math.max(0, Math.floor(count)), ARSENAL.specials.maxChain);
    let prev: Damageable = first;
    for (let hop = 0; hop < n; hop++) {
      _prev.copy(prev.aimPoint);
      const list = this.combat.queryRadius(_prev, range, this.query);
      let best: Damageable | null = null;
      let bestD = range;
      for (let i = 0; i < list.length; i++) {
        const t = list[i]!;
        if (!t.alive || t.team !== 'enemy' || t === first || out.includes(t)) continue;
        const d = t.aimPoint.distanceTo(_prev);
        if (d > bestD || !this.combat.lineOfSight(_prev, t.aimPoint)) continue;
        best = t;
        bestD = d;
      }
      list.length = 0;
      if (!best) break;
      out.push(best);
      prev = best;
    }
    return out;
  }

  /** Draw a chain (hit point, then hop aim points) as a short arc flash. */
  flash(points: readonly Vec3Like[], count: number): void {
    const n = Math.min(count, ARSENAL.specials.maxChain + 1);
    if (n < 2) return;
    const f = this.flashes[this.flashCursor]!;
    this.flashCursor = (this.flashCursor + 1) % this.flashes.length;
    for (let i = 0; i < n; i++) f.points[i]!.set(points[i]!.x, points[i]!.y, points[i]!.z);
    f.count = n;
    f.ttl = ARSENAL.specials.arcDuration;
  }

  /** Per frame: age and draw the arc flashes. */
  update(dt: number): void {
    const visual = ARSENAL.specials.arcVisual;
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i]!;
      if (f.ttl <= 0) continue;
      f.ttl -= dt;
      if (f.ttl <= 0) continue;
      let arcs = 0;
      for (let j = 1; j + 1 < f.count; j++) {
        this.pairs[arcs * 2]!.copy(f.points[j]!);
        this.pairs[arcs * 2 + 1]!.copy(f.points[j + 1]!);
        arcs++;
      }
      this.vfx.beam(visual, f.points[0]!, f.points[1]!, this.pairs, arcs);
    }
  }

  clear(): void {
    for (const f of this.flashes) f.ttl = 0;
    this.chain.length = 0;
  }

  // -------------------------------------------------------------------------

  private roll(chance: number): boolean {
    if (!(chance > 0)) return false;
    return chance >= 1 || this.rng.next() < chance;
  }

  /** chainArc: lightning from the hit target hop by hop (damage per hop, via 'arc'). */
  private arc(hit: SpecialHit, count: number, range: number, damage: number): void {
    const first = hit.target;
    const weaponId = hit.weaponId;
    const source = hit.source;
    const special = hit.special;
    _point.set(hit.point.x, hit.point.y, hit.point.z);
    const chain = this.selectChain(first, count, range, this.chain);
    if (chain.length === 0) return;
    this.stats.arcs++;
    // Visual: from the hit point through every hop.
    const f = this.flashes[this.flashCursor]!;
    this.flashCursor = (this.flashCursor + 1) % this.flashes.length;
    f.points[0]!.copy(_point);
    f.count = 1;
    f.ttl = ARSENAL.specials.arcDuration;
    const info = this.arcInfo;
    const arcHit = this.arcHit;
    _prev.copy(first.aimPoint);
    const n = Math.min(chain.length, ARSENAL.specials.maxChain);
    for (let i = 0; i < n; i++) {
      const t = chain[i]!;
      f.points[f.count++]!.copy(t.aimPoint);
      if (!t.alive) continue;
      _dir.subVectors(t.aimPoint, _prev);
      const len = _dir.length();
      if (len > 1e-6) _dir.multiplyScalar(1 / len);
      else _dir.set(0, 0, -1);
      info.amount = damage;
      info.zone = 'body';
      copyVec(t.aimPoint, info.point);
      copyVec(_dir, info.direction);
      info.weaponId = weaponId;
      info.element = ARSENAL.specials.arcElement;
      info.source = source;
      info.kind = 'beam';
      info.impulse = 0;
      info.statusBuildup = statusBuildupFor(ARSENAL.specials.arcElement);
      _prev.copy(t.aimPoint);
      const res = this.combat.dealDamage(t, info);
      arcHit.special = special;
      arcHit.via = 'arc';
      arcHit.weaponId = weaponId;
      arcHit.source = source;
      arcHit.target = t;
      copyVec(t.aimPoint, arcHit.point);
      arcHit.applied = res.applied;
      arcHit.killed = res.killed;
      arcHit.primary = false;
      this.onHit(arcHit);
    }
    this.chain.length = 0;
  }
}

function copyVec(from: Vec3Like, to: Vec3Like): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}
