/**
 * Weapon progression (ProfileData.weaponProgress): weapon XP from kills and hits with the weapon
 * (the `weapon` tag of kill / shotHit signals), weapon level 1..PROGRESSION.weapon.maxLevel, the
 * per-weapon camo counters (WEAPON_COUNTERS) and camo unlocks (defs/cosmetics CAMOS):
 * weapon-scope camos per weapon (level, counters, mastery), global camos for N mastered weapons.
 * Only roster weapons (defs/weapons) are tracked; grenades, abilities and the nuke are not.
 */
import type { WeaponProgressData, WeaponProgressView } from '../core/contracts';
import { CAMOS, getCamoDef, type CamoDef } from '../defs/cosmetics';
import { PROGRESSION, PROGRESSION_LIMITS, WEAPON_COUNTERS, WEAPON_COUNTER_IDS } from '../defs/progression';
import { isWeaponId } from '../defs/weapons';
import { matchesFilter, type ProgressSignal } from './signals';
import { addLevelXp, xpToNext } from './xpCurve';

export interface WeaponProgressHooks {
  onLevelUp(weaponId: string, level: number): void;
  /** A camo unlocked (`weaponId` null: a global camo). */
  onCamo(weaponId: string | null, camo: CamoDef): void;
  /** The weapon reached the max weapon level. */
  onMastered(weaponId: string): void;
}

/** Global camos are unlocked through the cosmetics inventory (they apply to every weapon). */
export interface GlobalCamoSink {
  has(id: string): boolean;
  unlock(id: string): boolean;
  globalCamos(): string[];
}

const W = PROGRESSION.weapon;

export function createWeaponEntry(): WeaponProgressData {
  return { level: 1, xp: 0, counters: {}, camos: [], equippedCamo: null };
}

export class WeaponProgress {
  private data: Record<string, WeaponProgressData> = {};

  constructor(
    data: Record<string, WeaponProgressData>,
    private readonly hooks: WeaponProgressHooks,
    private readonly globals: GlobalCamoSink,
  ) {
    this.attach(data);
  }

  attach(data: Record<string, WeaponProgressData>): void {
    this.data = data;
  }

  /** Progress entry of a roster weapon (created on first use), null for anything else. */
  entry(weaponId: string): WeaponProgressData | null {
    let e = this.data[weaponId];
    if (e) return e;
    if (!isWeaponId(weaponId)) return null;
    e = createWeaponEntry();
    this.data[weaponId] = e;
    return e;
  }

  level(weaponId: string): number {
    return this.data[weaponId]?.level ?? 1;
  }

  /** Kill / shotHit signals of the player's weapons. Returns true when data changed. */
  signal(sig: ProgressSignal): boolean {
    const weaponId = sig.tags.weapon;
    if (weaponId === null) return false;
    if (sig.metric === 'shotHit') return this.addXp(weaponId, W.xpPerHit) >= 0;
    if (sig.metric !== 'kill') return false;
    const e = this.entry(weaponId);
    if (!e) return false;
    let countersChanged = false;
    for (const id of WEAPON_COUNTER_IDS) {
      const def = WEAPON_COUNTERS[id].condition;
      if (sig.metric !== def.metric || !matchesFilter('filter' in def ? def.filter : undefined, sig.tags))
        continue;
      e.counters[id] = Math.min(PROGRESSION_LIMITS.maxCounter, (e.counters[id] ?? 0) + sig.amount);
      countersChanged = true;
    }
    let xp = W.xpPerKill + (sig.tags.zone === 'head' ? W.headshotBonus : 0);
    if (sig.tags.elite) xp *= W.eliteMultiplier;
    this.addXp(weaponId, xp * sig.amount);
    if (countersChanged) this.evaluateCamos(weaponId);
    return true;
  }

  /** Add weapon XP; returns the levels gained (−1 = not a tracked weapon). */
  addXp(weaponId: string, amount: number): number {
    const e = this.entry(weaponId);
    if (!e) return -1;
    const before = e.level;
    const gained = addLevelXp(e, amount, W.curve, W.maxLevel);
    for (let l = before + 1; l <= e.level; l++) this.hooks.onLevelUp(weaponId, l);
    if (gained > 0) {
      if (e.level >= W.maxLevel) this.hooks.onMastered(weaponId);
      this.evaluateCamos(weaponId);
    }
    return gained;
  }

  /** Dev console: set a weapon's level (XP into it reset). */
  setLevel(weaponId: string, level: number): boolean {
    const e = this.entry(weaponId);
    if (!e) return false;
    const target = Math.min(W.maxLevel, Math.max(1, Math.floor(level)));
    const before = e.level;
    e.level = target;
    e.xp = 0;
    for (let l = before + 1; l <= target; l++) this.hooks.onLevelUp(weaponId, l);
    if (target >= W.maxLevel && before < W.maxLevel) this.hooks.onMastered(weaponId);
    this.evaluateCamos(weaponId);
    return true;
  }

  /** Unlock every camo whose condition the weapon meets (and global mastery camos). */
  evaluateCamos(weaponId: string): void {
    const e = this.data[weaponId];
    if (!e) return;
    let added = true;
    // Mastery camos depend on other camos of the same weapon: repeat until nothing new unlocks.
    while (added) {
      added = false;
      for (const camo of CAMOS) {
        if (camo.scope !== 'weapon' || e.camos.includes(camo.id)) continue;
        if (!weaponCamoMet(camo, e)) continue;
        e.camos.push(camo.id);
        added = true;
        this.hooks.onCamo(weaponId, camo);
      }
    }
    this.evaluateGlobalCamos();
  }

  evaluateGlobalCamos(): void {
    for (const camo of CAMOS) {
      const u = camo.unlock;
      if (camo.scope !== 'global' || u.kind !== 'weaponsMastered' || this.globals.has(camo.id)) continue;
      if (this.countWithCamo(u.camo) >= u.count && this.globals.unlock(camo.id))
        this.hooks.onCamo(null, camo);
    }
  }

  countWithCamo(camoId: string): number {
    let n = 0;
    for (const id of Object.keys(this.data)) if (this.data[id]!.camos.includes(camoId)) n++;
    return n;
  }

  /** Weapons at the max weapon level. */
  masteredCount(): number {
    let n = 0;
    for (const id of Object.keys(this.data)) if (this.data[id]!.level >= W.maxLevel) n++;
    return n;
  }

  /** Equip a camo usable on the weapon (null = factory finish). */
  equipCamo(weaponId: string, camoId: string | null): boolean {
    const e = this.entry(weaponId);
    if (!e) return false;
    if (camoId !== null && !this.usable(weaponId, camoId)) return false;
    e.equippedCamo = camoId;
    return true;
  }

  usable(weaponId: string, camoId: string): boolean {
    const def = getCamoDef(camoId);
    if (!def) return false;
    if (def.scope === 'global') return this.globals.has(camoId);
    return this.data[weaponId]?.camos.includes(camoId) === true;
  }

  view(weaponId: string): WeaponProgressView | null {
    if (!isWeaponId(weaponId)) return null;
    const e = this.data[weaponId] ?? createWeaponEntry();
    return {
      weaponId,
      level: e.level,
      xp: e.xp,
      xpToNext: xpToNext(W.curve, W.maxLevel, e.level),
      counters: { ...e.counters },
      camos: [...e.camos, ...this.globals.globalCamos()],
      equippedCamo: e.equippedCamo,
    };
  }
}

function weaponCamoMet(camo: CamoDef, e: WeaponProgressData): boolean {
  const u = camo.unlock;
  switch (u.kind) {
    case 'weaponLevel':
      return e.level >= u.level;
    case 'weaponCounter':
      return (e.counters[u.counter] ?? 0) >= u.target;
    case 'weaponMastery':
      return e.level >= u.level && u.requires.every((id) => e.camos.includes(id));
    default:
      return false;
  }
}
