/**
 * Mystery box – the "Rift-Kiste" (logic; visuals: visuals/BoxView.ts). One box wanders between
 * the map's locations (defs MYSTERY_BOX.locations):
 *
 *   idle ──buy──▶ rolling (weapons cycle, accelerating then slowing, ~4 s)
 *                   ├─▶ offering (take it within ~8 s, else it sinks back) ──▶ closing ──▶ idle
 *                   └─▶ anomaly ("Riss-Anomalie": price refunded) ──▶ leaving ──▶ arriving ──▶ idle
 *                                                                 (another location)
 *
 * The result is decided when the roll starts (seeded Rng – daily-challenge determinism): a
 * weighted pick from the pool (box-only weapons included, carried weapons excluded), or – once
 * the uses at this location reached a threshold rolled in [min, max] – the anomaly with
 * MYSTERY_BOX.anomalyChance. The cycling display uses its own (forked) stream.
 *
 * Each location owns a SolidBlocker (collider, bullets, nav area) that is solid only while the box
 * stands there; a box arriving on top of the player waits until the player stepped off. Bullet
 * decals on the lid go when it swings open, those on the chest when it leaves. The anomaly refunds what its roll cost (a free
 * console roll refunds nothing).
 */
import type { Vector3 } from 'three';
import type { EconomyApi, Interactable, VfxApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { clamp01, lerp, smoothstep } from '../core/math';
import { Rng } from '../core/Rng';
import { BLOCKERS, INTERACTION, MYSTERY_BOX, type BoxPoolEntry } from '../defs/interactables';
import { IMPLEMENTED_WEAPON_KINDS, WEAPONS, getWeaponDef, type WeaponDef } from '../defs/weapons';
import { formatPrompt, type DecalFader, type InteractableWeapons } from './types';

export type BoxState = 'idle' | 'rolling' | 'offering' | 'closing' | 'anomaly' | 'leaving' | 'arriving';

export const MYSTERY_BOX_ID = 'rift_box';

export interface BoxLocation {
  readonly id: string;
  readonly zone: string;
  /** Floor center of the box. */
  readonly position: Vector3;
  /** Yaw of the front (object convention: local +Z faces the player's side). */
  readonly yaw: number;
  /** Prompt anchor above the front edge. */
  readonly anchor: Vector3;
  /** Footprint half extents on world X / Z. */
  readonly halfX: number;
  readonly halfZ: number;
  /** Collider + bullets + nav while the box stands here. */
  readonly blocker: { setBlocked(blocked: boolean): void; dispose?(): void } | null;
}

/** What the view reads every frame. */
export interface MysteryBoxReadout {
  readonly state: BoxState;
  /** 0..1 through the current state (1 for idle). */
  readonly stateProgress: number;
  readonly stateTime: number;
  /** Weapon in the hologram (cycling / result); null = nothing or the anomaly. */
  readonly displayWeapon: string | null;
  readonly anomaly: boolean;
  readonly location: BoxLocation;
}

export interface MysteryBoxViewApi {
  /** The box stands at `location` now (teleport). */
  placeAt(location: BoxLocation): void;
  setState(state: BoxState): void;
  update(dt: number, time: number, box: MysteryBoxReadout): void;
  dispose(): void;
}

export interface MysteryBoxDeps {
  events: EventBus<GameEvents>;
  economy: Pick<EconomyApi, 'spend' | 'earn'>;
  weapons: InteractableWeapons;
  price: number;
  rng: Rng;
  locations: readonly BoxLocation[];
  /** Indices into `locations` a run may start at (empty / absent = any). */
  startLocations?: readonly number[];
  /** Weighted pool (resolveBoxPool). */
  pool: readonly BoxPoolEntry[];
  /** Player-facing weapon name for the take prompt. */
  weaponName(weaponId: string): string;
  /** Player feet (the collider waits until the player left the footprint) and capsule radius. */
  player?: { readonly position: Vec3Like; readonly radius: number } | null;
  vfx?: Pick<VfxApi, 'spawn'> | null;
  /** Bullet decals on the chest (removed when it leaves a location). */
  decals?: DecalFader | null;
  view?: MysteryBoxViewApi | null;
}

/** Display steps per second at roll progress u (0..1): start → peak → end (smoothstep blends). */
export function rollRate(u: number, r: typeof MYSTERY_BOX.roll = MYSTERY_BOX.roll): number {
  const t = clamp01(u);
  if (t <= r.peakAt) return lerp(r.startRate, r.peakRate, smoothstep(0, r.peakAt, t));
  return lerp(r.peakRate, r.endRate, smoothstep(r.peakAt, 1, t));
}

/**
 * Valid pool entries: known weapons of an implemented kind with a positive weight, plus every
 * box-only weapon (WeaponDef.boxOnly) not listed, at `boxOnlyWeight`.
 */
export function resolveBoxPool(
  entries: readonly BoxPoolEntry[] = MYSTERY_BOX.pool,
  lookup: (id: string) => WeaponDef | undefined = getWeaponDef,
  allIds: readonly string[] = Object.keys(WEAPONS),
  boxOnlyWeight: number = MYSTERY_BOX.boxOnlyWeight,
): BoxPoolEntry[] {
  const usable = (id: string): boolean => {
    const def = lookup(id);
    return def !== undefined && IMPLEMENTED_WEAPON_KINDS.includes(def.kind);
  };
  const out: BoxPoolEntry[] = [];
  for (const e of entries) {
    if (e.weight > 0 && usable(e.weapon) && !out.some((o) => o.weapon === e.weapon)) out.push(e);
  }
  for (const id of allIds) {
    if (
      lookup(id)?.boxOnly === true &&
      usable(id) &&
      !out.some((o) => o.weapon === id) &&
      boxOnlyWeight > 0
    ) {
      out.push({ weapon: id, weight: boxOnlyWeight });
    }
  }
  return out;
}

const weightOf = (e: BoxPoolEntry): number => e.weight;

const B = MYSTERY_BOX;

export class MysteryBox implements Interactable, MysteryBoxReadout {
  readonly id = MYSTERY_BOX_ID;
  readonly range = INTERACTION.range.box;
  readonly price: number;

  private loc = 0;
  private _state: BoxState = 'idle';
  private time = 0;
  private uses = 0;
  private threshold = 0;
  private result: string | null = null;
  /** Points the current roll cost (refunded by the anomaly; 0 for a free console roll). */
  private paid = 0;
  private _anomaly = false;
  private display: string | null = null;
  private phase = 0;
  private blockPending = false;
  private rng: Rng;
  private displayRng: Rng;
  private readonly candidates: BoxPoolEntry[] = [];
  private readonly takePrompts = new Map<string, string>();
  private readonly openedPayload: GameEvents['box:opened'] = {
    boxId: MYSTERY_BOX_ID,
    position: { x: 0, y: 0, z: 0 },
  };
  private readonly resolvedPayload: GameEvents['box:resolved'] = { boxId: MYSTERY_BOX_ID, weaponId: null };
  private readonly movedPayload: GameEvents['box:moved'] = { boxId: MYSTERY_BOX_ID, from: '', to: '' };
  private readonly decalCenter = { x: 0, y: 0, z: 0 };
  private readonly decalHalf = { x: 0, y: 0, z: 0 };

  constructor(private readonly deps: MysteryBoxDeps) {
    this.price = deps.price;
    this.rng = deps.rng;
    this.displayRng = this.rng.fork('box-display');
    if (deps.locations.length === 0) throw new Error('MysteryBox needs at least one location');
    this.reset();
  }

  // --- readout -----------------------------------------------------------

  get state(): BoxState {
    return this._state;
  }

  get stateTime(): number {
    return this.time;
  }

  get stateProgress(): number {
    const d = stateDuration(this._state);
    return d > 0 ? clamp01(this.time / d) : 1;
  }

  get displayWeapon(): string | null {
    return this.display;
  }

  get anomaly(): boolean {
    return this._anomaly;
  }

  get location(): BoxLocation {
    return this.deps.locations[this.loc]!;
  }

  get locationIndex(): number {
    return this.loc;
  }

  /** Rolls bought at the current location. */
  get usesHere(): number {
    return this.uses;
  }

  /** Uses at this location after which the anomaly may appear. */
  get moveThreshold(): number {
    return this.threshold;
  }

  /** The weapon waiting to be taken (offering), else null. */
  get offeredWeapon(): string | null {
    return this._state === 'offering' ? this.result : null;
  }

  // --- Interactable ------------------------------------------------------

  get position(): Vector3 {
    return this.location.anchor;
  }

  prompt(): string {
    if (this._state === 'idle') return B.prompts.open;
    if (this._state === 'offering' && this.result) return this.takePrompt(this.result);
    return '';
  }

  cost(): number | null {
    return this._state === 'idle' ? this.price : null;
  }

  canInteract(): boolean {
    return this._state === 'idle' || (this._state === 'offering' && this.result !== null);
  }

  holdTime(): number {
    return 0;
  }

  interact(): void {
    if (this._state === 'idle') this.purchase();
    else if (this._state === 'offering') this.take();
  }

  // --- actions -----------------------------------------------------------

  purchase(): boolean {
    if (this._state !== 'idle') return false;
    if (!this.deps.economy.spend(this.price, MYSTERY_BOX_ID, 'box')) return false;
    this.startRoll(false, this.price);
    return true;
  }

  /** Free roll (dev console); `forceAnomaly` makes it reveal the anomaly (needs ≥ 2 locations). */
  roll(forceAnomaly = false): boolean {
    if (this._state !== 'idle') return false;
    this.startRoll(forceAnomaly, 0);
    return true;
  }

  take(): boolean {
    if (this._state !== 'offering' || !this.result) return false;
    this.deps.weapons.give(this.result);
    this.display = this.result;
    this.setState('closing');
    return true;
  }

  /** Relocate now (dev console): an idle box lifts off without an anomaly roll. */
  move(): boolean {
    if (this._state !== 'idle' || this.deps.locations.length < 2) return false;
    this._anomaly = false;
    this.leave();
    return true;
  }

  fixedUpdate(dt: number): void {
    if (!(dt > 0)) return;
    this.time += dt;
    if (this.blockPending) this.tryBlock();
    switch (this._state) {
      case 'rolling': {
        this.phase += rollRate(this.time / B.rollDuration) * dt;
        while (this.phase >= 1) {
          this.phase -= 1;
          this.display = this.nextDisplay();
        }
        if (this.time >= B.rollDuration) this.resolveRoll();
        break;
      }
      case 'offering':
        if (this.time >= B.offerDuration) {
          this.display = null;
          this.setState('closing');
        }
        break;
      case 'closing':
        if (this.time >= B.closeDuration) this.setState('idle');
        break;
      case 'anomaly':
        if (this.time >= B.anomalyDuration) this.leave();
        break;
      case 'leaving':
        if (this.time >= B.leaveDuration) this.relocate();
        break;
      case 'arriving':
        if (this.time >= B.arriveDuration) this.setState('idle');
        break;
      case 'idle':
        break;
    }
  }

  update(dt: number, time: number): void {
    this.deps.view?.update(dt, time, this);
  }

  /**
   * New run: a start location, closed and idle, use counter cleared. `seed` restarts the random
   * streams (per-run / daily-challenge seeds); without it the current stream continues.
   */
  reset(seed?: string | number): void {
    if (seed !== undefined) {
      this.rng = new Rng(seed);
      this.displayRng = this.rng.fork('box-display');
    }
    const locs = this.deps.locations;
    locs[this.loc]?.blocker?.setBlocked(false);
    this.loc = this.pickStart();
    this.uses = 0;
    this.threshold = this.rollThreshold();
    this.result = null;
    this.paid = 0;
    this._anomaly = false;
    this.display = null;
    this.phase = 0;
    this.deps.view?.placeAt(this.location);
    this.blockPending = true;
    this.tryBlock();
    this.setState('idle');
  }

  dispose(): void {
    for (const l of this.deps.locations) l.blocker?.dispose?.();
    this.deps.view?.dispose();
  }

  // -------------------------------------------------------------------------

  private startRoll(forceAnomaly: boolean, paid: number): void {
    this.uses++;
    this.paid = paid;
    const canMove = this.deps.locations.length > 1;
    this._anomaly =
      canMove && (forceAnomaly || (this.uses >= this.threshold && this.rng.chance(B.anomalyChance)));
    this.result = this._anomaly ? null : this.pickWeapon();
    this.phase = 0;
    this.display = this.nextDisplay();
    this.clearDecals(this.location, true);
    this.setState('rolling');
    const p = this.location.position;
    const o = this.openedPayload.position;
    o.x = p.x;
    o.y = p.y;
    o.z = p.z;
    this.deps.events.emit('box:opened', this.openedPayload);
  }

  private resolveRoll(): void {
    if (this._anomaly || this.result === null) {
      this._anomaly = true;
      this.display = null;
      if (this.paid > 0) this.deps.economy.earn(this.paid, 'refund');
      this.paid = 0;
      this.resolvedPayload.weaponId = null;
      this.deps.events.emit('box:resolved', this.resolvedPayload);
      this.setState('anomaly');
      return;
    }
    this.paid = 0;
    this.display = this.result;
    this.resolvedPayload.weaponId = this.result;
    this.deps.events.emit('box:resolved', this.resolvedPayload);
    this.setState('offering');
  }

  private leave(): void {
    this.display = null;
    this.spawnBurst(this.location.position);
    this.clearDecals(this.location);
    this.setState('leaving');
  }

  /**
   * Bullet holes on the chest (its solid volume grown by BLOCKERS.decalMargin); `lidOnly`: the
   * lid slab (it swings open for a roll).
   */
  private clearDecals(l: BoxLocation, lidOnly = false): void {
    const decals = this.deps.decals;
    if (!decals) return;
    const m = BLOCKERS.decalMargin;
    const top = B.size.height + B.size.lidHeight;
    const bottom = lidOnly ? B.size.height : 0;
    const c = this.decalCenter;
    c.x = l.position.x;
    c.y = l.position.y + (top + bottom) / 2;
    c.z = l.position.z;
    const half = this.decalHalf;
    half.x = l.halfX + m;
    half.y = (top - bottom) / 2 + m;
    half.z = l.halfZ + m;
    decals.fadeInBox(c, half);
  }

  private relocate(): void {
    const locs = this.deps.locations;
    const from = this.loc;
    let to = from;
    if (locs.length > 1) {
      // Uniform among the others.
      to = this.rng.int(0, locs.length - 2);
      if (to >= from) to++;
    }
    locs[from]!.blocker?.setBlocked(false);
    this.loc = to;
    this.uses = 0;
    this.threshold = this.rollThreshold();
    this._anomaly = false;
    this.result = null;
    this.deps.view?.placeAt(this.location);
    this.blockPending = true;
    this.tryBlock();
    this.movedPayload.from = locs[from]!.id;
    this.movedPayload.to = locs[to]!.id;
    this.deps.events.emit('box:moved', this.movedPayload);
    this.spawnBurst(this.location.position);
    this.setState('arriving');
  }

  private setState(s: BoxState): void {
    this._state = s;
    this.time = 0;
    this.deps.view?.setState(s);
  }

  private pickStart(): number {
    const n = this.deps.locations.length;
    const starts = this.deps.startLocations?.filter((i) => i >= 0 && i < n) ?? [];
    return starts.length > 0 ? this.rng.pick(starts) : this.rng.int(0, n - 1);
  }

  private rollThreshold(): number {
    const m = B.moveAfterUses;
    return this.rng.int(m.min, m.max);
  }

  private pickWeapon(): string | null {
    const pool = this.deps.pool;
    if (pool.length === 0) return null;
    const c = this.candidates;
    c.length = 0;
    if (B.excludeOwned) {
      for (const e of pool) if (!this.deps.weapons.owns(e.weapon)) c.push(e);
    }
    const from = c.length > 0 ? c : pool;
    return this.rng.weighted(from, weightOf).weapon;
  }

  /** Cosmetic cycling: any pool weapon but the one shown now. */
  private nextDisplay(): string | null {
    const pool = this.deps.pool;
    if (pool.length === 0) return null;
    if (pool.length === 1) return pool[0]!.weapon;
    let i = Math.floor(this.displayRng.next() * (pool.length - 1));
    let current = -1;
    for (let k = 0; k < pool.length; k++) if (pool[k]!.weapon === this.display) current = k;
    if (current >= 0 && i >= current) i++;
    return pool[Math.min(i, pool.length - 1)]!.weapon;
  }

  private takePrompt(weaponId: string): string {
    let s = this.takePrompts.get(weaponId);
    if (s === undefined) {
      s = formatPrompt(B.prompts.take, this.deps.weaponName(weaponId));
      this.takePrompts.set(weaponId, s);
    }
    return s;
  }

  /** Make the current location solid unless the player stands in its footprint. */
  private tryBlock(): void {
    const l = this.location;
    const p = this.deps.player;
    if (p) {
      const r = p.radius;
      const inside =
        Math.abs(p.position.x - l.position.x) < l.halfX + r &&
        Math.abs(p.position.z - l.position.z) < l.halfZ + r;
      if (inside) return;
    }
    l.blocker?.setBlocked(true);
    this.blockPending = false;
  }

  private spawnBurst(p: Vec3Like): void {
    this.deps.vfx?.spawn(B.moveEffect, p);
  }
}

function stateDuration(s: BoxState): number {
  switch (s) {
    case 'rolling':
      return B.rollDuration;
    case 'offering':
      return B.offerDuration;
    case 'closing':
      return B.closeDuration;
    case 'anomaly':
      return B.anomalyDuration;
    case 'leaving':
      return B.leaveDuration;
    case 'arriving':
      return B.arriveDuration;
    default:
      return 0;
  }
}
