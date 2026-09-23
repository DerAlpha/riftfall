/**
 * Pure hit-feedback logic for the HUD (no DOM): hitmarker state, pooled damage numbers with merging,
 * kill streaks, world → screen projection, ammo prompt state. Unit-tested in Node; CombatHud.ts
 * renders it.
 */
import type { HitZone } from '../../core/events';
import { clamp01 } from '../../core/math';
import { HUD } from '../../defs/ui';

// ---------------------------------------------------------------------------
// Hitmarker
// ---------------------------------------------------------------------------

export type HitmarkerVariant = 'shield' | 'hit' | 'crit' | 'kill';

const RANK: Readonly<Record<HitmarkerVariant, number>> = { shield: 0, hit: 1, crit: 2, kill: 3 };

export function isCritZone(zone: HitZone): boolean {
  return (HUD.critZones as readonly HitZone[]).includes(zone);
}

/** Hitmarker variant of a damage event: kill > crit (head/weakpoint) > hit; shield hits read as "blocked". */
export function hitmarkerVariant(zone: HitZone, killed: boolean): HitmarkerVariant {
  if (killed) return 'kill';
  if (zone === 'shield') return 'shield';
  return isCritZone(zone) ? 'crit' : 'hit';
}

export interface MarkerSample {
  scale: number;
  opacity: number;
}

/** Ease-out cubic. */
function easeOut(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

/**
 * One hitmarker (X). A trigger restarts the pop; a lower-ranked hit never interrupts a
 * higher-ranked marker (kill > crit > hit > shield) during that marker's `hold` time.
 */
export class HitmarkerState {
  variant: HitmarkerVariant = 'hit';
  age = Number.POSITIVE_INFINITY;

  get active(): boolean {
    return this.age < HUD.hitmarker.variants[this.variant].duration;
  }

  trigger(v: HitmarkerVariant): void {
    if (this.active && RANK[v] < RANK[this.variant] && this.age < HUD.hitmarker.variants[this.variant].hold)
      return;
    this.variant = v;
    this.age = 0;
  }

  step(dt: number): void {
    if (Number.isFinite(this.age) && dt > 0) this.age += dt;
  }

  /** Scale (incl. the variant size) and opacity now; opacity 0 when inactive. */
  sample(reduced: boolean, out: MarkerSample): MarkerSample {
    const H = HUD.hitmarker;
    const c = H.variants[this.variant];
    if (!this.active) {
      out.scale = c.size;
      out.opacity = 0;
      return out;
    }
    const pop = reduced ? Math.min(c.popScale, H.reducedPopScale) : c.popScale;
    const t = this.age;
    out.scale = c.size * (t < c.popTime ? pop + (1 - pop) * easeOut(t / c.popTime) : 1);
    const fadeStart = c.duration - c.fade;
    const alpha = t <= fadeStart ? 1 : 1 - (t - fadeStart) / c.fade;
    out.opacity = clamp01(alpha) * (reduced ? H.reducedOpacity : 1);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Damage numbers
// ---------------------------------------------------------------------------

export interface DamageNumber {
  active: boolean;
  targetId: number;
  amount: number;
  crit: boolean;
  kill: boolean;
  /** Only shield hits so far (a later body hit clears it). */
  shield: boolean;
  /** World anchor (first hit). */
  x: number;
  y: number;
  z: number;
  age: number;
  /** Seconds since the last merged hit (merge window, pop). */
  sinceAdd: number;
  /** -1..1 horizontal scatter so stacked numbers stay readable. */
  jitter: number;
  /** Bumped on every visible change (renderers compare it). */
  version: number;
}

function blankNumber(): DamageNumber {
  return {
    active: false,
    targetId: -1,
    amount: 0,
    crit: false,
    kill: false,
    shield: false,
    x: 0,
    y: 0,
    z: 0,
    age: 0,
    sinceAdd: 0,
    jitter: 0,
    version: 0,
  };
}

/**
 * Fixed pool of floating numbers. Hits on the same target within `mergeWindow` seconds add up
 * into one number (pellets, penetration, melee + shot); when the pool is full the oldest is reused.
 */
export class DamageNumberModel {
  readonly items: DamageNumber[] = [];

  constructor(
    capacity: number = HUD.damageNumbers.pool,
    private readonly mergeWindow: number = HUD.damageNumbers.mergeWindow,
    private readonly lifetime: number = HUD.damageNumbers.lifetime,
    private readonly random: () => number = Math.random,
  ) {
    for (let i = 0; i < Math.max(1, capacity); i++) this.items.push(blankNumber());
  }

  get activeCount(): number {
    let n = 0;
    for (const it of this.items) if (it.active) n++;
    return n;
  }

  add(
    targetId: number,
    amount: number,
    zone: HitZone,
    killed: boolean,
    x: number,
    y: number,
    z: number,
  ): DamageNumber | null {
    if (!(amount > 0) || !Number.isFinite(amount)) return null;
    const crit = isCritZone(zone);
    const shield = zone === 'shield';
    let oldest: DamageNumber | null = null;
    let free: DamageNumber | null = null;
    for (const it of this.items) {
      if (it.active && it.targetId === targetId && it.sinceAdd <= this.mergeWindow && !it.kill) {
        it.amount += amount;
        it.crit ||= crit;
        it.kill ||= killed;
        it.shield &&= shield;
        it.sinceAdd = 0;
        // Merged hits keep the number alive a little longer.
        it.age = Math.min(it.age, this.lifetime * HUD.damageNumbers.mergeAgeCap);
        it.version++;
        return it;
      }
      if (!it.active) free ??= it;
      else if (!oldest || it.age > oldest.age) oldest = it;
    }
    const it = free ?? oldest!;
    it.active = true;
    it.targetId = targetId;
    it.amount = amount;
    it.crit = crit;
    it.kill = killed;
    it.shield = shield;
    it.x = Number.isFinite(x) ? x : 0;
    it.y = Number.isFinite(y) ? y : 0;
    it.z = Number.isFinite(z) ? z : 0;
    it.age = 0;
    it.sinceAdd = 0;
    it.jitter = this.random() * 2 - 1;
    it.version++;
    return it;
  }

  step(dt: number): void {
    if (!(dt > 0)) return;
    for (const it of this.items) {
      if (!it.active) continue;
      it.age += dt;
      it.sinceAdd += dt;
      if (it.age >= this.lifetime) it.active = false;
    }
  }

  clear(): void {
    for (const it of this.items) it.active = false;
  }
}

/** Displayed text of a damage amount (whole numbers, never "0" for a real hit). */
export function formatDamage(amount: number): string {
  return String(Math.max(1, Math.round(amount)));
}

/** Pop scale / rise / opacity of a number at its age. */
export function damageNumberMotion(
  it: Readonly<DamageNumber>,
  out: { scale: number; rise: number; opacity: number },
): void {
  const D = HUD.damageNumbers;
  const base = it.kill ? D.killScale : it.crit ? D.critScale : 1;
  const pop = it.sinceAdd < D.popTime ? D.popScale + (1 - D.popScale) * easeOut(it.sinceAdd / D.popTime) : 1;
  out.scale = base * pop;
  out.rise = D.risePx * easeOut(it.age / D.lifetime);
  const fadeStart = D.lifetime - D.fadeTime;
  out.opacity = it.age <= fadeStart ? 1 : clamp01(1 - (it.age - fadeStart) / D.fadeTime);
}

// ---------------------------------------------------------------------------
// Kill streak
// ---------------------------------------------------------------------------

export class KillStreak {
  count = 0;
  sinceKill = Number.POSITIVE_INFINITY;

  constructor(private readonly window: number = HUD.killConfirm.streakWindow) {}

  /** Register a kill; returns the streak count including it. */
  onKill(): number {
    this.count = this.sinceKill <= this.window ? this.count + 1 : 1;
    this.sinceKill = 0;
    return this.count;
  }

  step(dt: number): void {
    if (dt > 0) this.sinceKill += dt;
    if (this.sinceKill > this.window) this.count = 0;
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export interface ScreenPoint {
  x: number;
  y: number;
  /** Clip w = view depth (m) for a perspective camera. */
  w: number;
}

/**
 * Project a world point with a column-major view-projection matrix (three.js Matrix4.elements)
 * into CSS pixels of a `width` × `height` viewport. False when behind the camera or far off-screen.
 */
export function projectToScreen(
  m: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  out: ScreenPoint,
): boolean {
  const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (!(cw > HUD.damageNumbers.minDepth)) return false;
  const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / cw;
  const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / cw;
  out.x = (nx * 0.5 + 0.5) * width;
  out.y = (0.5 - ny * 0.5) * height;
  out.w = cw;
  const lim = HUD.damageNumbers.offscreenNdc;
  return nx >= -lim && nx <= lim && ny >= -lim && ny <= lim;
}

/** Distance-based size of a world-anchored label (full size up close, `minScale` far away). */
export function distanceScale(depth: number): number {
  const D = HUD.damageNumbers;
  if (!(depth > 0)) return 1;
  return Math.max(D.minScale, Math.min(1, D.refDistance / depth));
}

// ---------------------------------------------------------------------------
// Ammo
// ---------------------------------------------------------------------------

export type AmmoPrompt = 'none' | 'reload' | 'empty';

/** Prompt under the crosshair: NACHLADEN when the magazine is empty, KEINE MUNITION when fully out. */
export function ammoPrompt(mag: number, reserve: number, reloading: boolean): AmmoPrompt {
  if (reloading || !(mag <= 0)) return 'none';
  return reserve > 0 ? 'reload' : 'empty';
}

/** Low-ammo warning: at most `lowFraction` of the magazine left (and at least one round). */
export function isLowAmmo(mag: number, magSize: number): boolean {
  return magSize > 1 && mag > 0 && mag <= Math.max(1, Math.ceil(magSize * HUD.ammo.lowFraction));
}
