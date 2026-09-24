/**
 * Lingering area effects (FieldApi, M5): singularity pull, fire pool, poison cloud, frost field.
 *
 * - Pooled (ARSENAL.fields.capacity, structure of arrays); spawns beyond the pool are refused.
 * - Floor fields ('damage', 'slow') snap to the floor below the spawn point and cover a cylinder
 *   (radius × ARSENAL.fields.height); 'pull' fields float where they burst and cover a sphere.
 * - `dps` ticks every ARSENAL.fields.tickInterval to every damageable inside with line of sight
 *   from the center (the source's team is spared), scaled by the source's `areaScale`; weapon
 *   specials see each tick (via 'tick') – kills inside a field can leave more fields.
 * - Queries for the enemy side (package B wires them into movement): `pullAt` (horizontal pull
 *   velocity towards pull-field centers, eased in the core so bodies gather instead of
 *   oscillating) and `slowAt` (the strongest slow at a point – fields never stack).
 * - At the end of its duration a field with a `collapse` explodes (ExplosionApi) at its center.
 * - Visuals through ArsenalVfxApi.fieldStart/fieldEnd; field:spawned / field:ended events (reused
 *   payload) for audio loops.
 */
import { Vector3 } from 'three';
import type {
  AreaDamageSource,
  ArsenalVfxApi,
  CombatRaycastOptions,
  DamageInfo,
  Damageable,
  ExplosionApi,
  FieldApi,
  WeaponCombatApi,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { smoothstep } from '../core/math';
import { ARSENAL } from '../defs/combat';
import type { FieldDef, WeaponSpecialDef } from '../defs/weapons';
import { TIME_EPS } from '../weapons/fire/fireMath';
import { NULL_ARSENAL_VFX } from '../weapons/fire/nullArsenalVfx';
import { createSpecialHit, type SpecialsHook } from '../weapons/fire/types';

export interface FieldSystemDeps {
  events: EventBus<GameEvents>;
  combat: Pick<WeaponCombatApi, 'queryRadius' | 'dealDamage' | 'lineOfSight' | 'raycast'>;
  explosions: ExplosionApi;
  vfx?: ArsenalVfxApi | null;
  specials?: SpecialsHook | null;
  capacity?: number;
}

type Source = DamageInfo['source'];

const DOWN = { x: 0, y: -1, z: 0 };
const _center = new Vector3();
const _from = new Vector3();
const _probe = new Vector3();

export class FieldSystem implements FieldApi {
  readonly capacity: number;
  readonly stats = { spawned: 0, refused: 0, ticks: 0 };

  private readonly events: EventBus<GameEvents>;
  private readonly combat: FieldSystemDeps['combat'];
  private readonly explosions: ExplosionApi;
  private vfx: ArsenalVfxApi;
  private specials: SpecialsHook | null;

  // Pool (structure of arrays).
  private readonly pos: Float64Array;
  private readonly age: Float64Array;
  private readonly tick: Float64Array;
  private readonly areaScale: Float64Array;
  private readonly buildup: Float64Array;
  private readonly handle: Int32Array;
  private readonly ids: Int32Array;
  private readonly defs: (FieldDef | null)[];
  private readonly weaponIds: string[];
  private readonly sources: Source[];
  private readonly specialDefs: (WeaponSpecialDef | null)[];
  private readonly free: Int32Array;
  private freeTop = 0;
  private readonly activeList: Int32Array;
  private activeCount = 0;
  private seq = 0;

  private readonly list: Damageable[] = [];
  private readonly ignore: Damageable[] = [];
  private readonly rayOpts: CombatRaycastOptions = { ignoreMany: this.ignore, props: true };
  private readonly info: DamageInfo = {
    amount: 0,
    zone: 'body',
    point: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 1, z: 0 },
    weaponId: '',
    element: 'physical',
    source: 'player',
    kind: 'explosion',
    impulse: 0,
    statusBuildup: 0,
  };
  private readonly hit = createSpecialHit();
  private readonly from: {
    weaponId: string;
    source: Source;
    statusBuildup: number;
    special: WeaponSpecialDef | null;
    areaScale: number;
  } = { weaponId: '', source: 'player', statusBuildup: 0, special: null, areaScale: 1 };
  private readonly spawnedPayload: GameEvents['field:spawned'] = {
    id: 0,
    kind: '',
    element: 'physical',
    position: { x: 0, y: 0, z: 0 },
    radius: 0,
    duration: 0,
  };
  private readonly endedPayload: GameEvents['field:ended'] = { id: 0 };

  constructor(deps: FieldSystemDeps) {
    this.events = deps.events;
    this.combat = deps.combat;
    this.explosions = deps.explosions;
    this.vfx = deps.vfx ?? NULL_ARSENAL_VFX;
    this.specials = deps.specials ?? null;
    const n = Math.max(1, Math.floor(deps.capacity ?? ARSENAL.fields.capacity));
    this.capacity = n;
    this.pos = new Float64Array(n * 3);
    this.age = new Float64Array(n);
    this.tick = new Float64Array(n);
    this.areaScale = new Float64Array(n);
    this.buildup = new Float64Array(n);
    this.handle = new Int32Array(n);
    this.ids = new Int32Array(n);
    this.defs = new Array<FieldDef | null>(n).fill(null);
    this.weaponIds = new Array<string>(n).fill('');
    this.sources = new Array<Source>(n).fill('player');
    this.specialDefs = new Array<WeaponSpecialDef | null>(n).fill(null);
    this.free = new Int32Array(n);
    this.activeList = new Int32Array(n);
    for (let i = 0; i < n; i++) this.free[i] = n - 1 - i;
    this.freeTop = n;
  }

  get active(): number {
    return this.activeCount;
  }

  setVfx(vfx: ArsenalVfxApi | null): void {
    this.vfx = vfx ?? NULL_ARSENAL_VFX;
  }

  setSpecials(specials: SpecialsHook | null): void {
    this.specials = specials;
  }

  spawn(position: Vec3Like, def: FieldDef, from: AreaDamageSource): number {
    if (!finite(position) || !(def.radius > 0) || !(def.duration > 0)) return 0;
    if (this.freeTop === 0) {
      this.stats.refused++;
      return 0;
    }
    const i = this.free[--this.freeTop]!;
    this.activeList[this.activeCount++] = i;
    const center = _center.set(position.x, position.y, position.z);
    if (def.kind !== 'pull') this.snapToFloor(center);
    const o = i * 3;
    this.pos[o] = center.x;
    this.pos[o + 1] = center.y;
    this.pos[o + 2] = center.z;
    this.age[i] = 0;
    this.tick[i] = 0;
    this.areaScale[i] = from.areaScale !== undefined && from.areaScale >= 0 ? from.areaScale : 1;
    this.buildup[i] = from.statusBuildup;
    this.defs[i] = def;
    this.weaponIds[i] = from.weaponId;
    this.sources[i] = from.source;
    this.specialDefs[i] = from.special ?? null;
    const id = ++this.seq;
    this.ids[i] = id;
    this.handle[i] = this.vfx.fieldStart(def.vfx, center, def.radius, def.duration);
    this.stats.spawned++;
    const e = this.spawnedPayload;
    e.id = id;
    e.kind = def.kind;
    e.element = def.element;
    copyVec(center, e.position);
    e.radius = def.radius;
    e.duration = def.duration;
    this.events.emit('field:spawned', e);
    return id;
  }

  pullAt(position: Vec3Like, out: Vector3): boolean {
    out.set(0, 0, 0);
    const P = ARSENAL.fields.pull;
    let any = false;
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.activeList[k]!;
      const def = this.defs[i]!;
      if (def.kind !== 'pull' || !(def.strength > 0)) continue;
      const o = i * 3;
      const dx = this.pos[o]! - position.x;
      const dy = this.pos[o + 1]! - position.y;
      const dz = this.pos[o + 2]! - position.z;
      if (dx * dx + dy * dy + dz * dz > def.radius * def.radius) continue;
      const h = Math.hypot(dx, dz);
      if (!(h > 1e-4)) {
        any = true;
        continue;
      }
      // Eased in the core (no jitter at the center), never faster than arriving in arrivalTime.
      const speed = Math.min(
        def.strength * P.responseTime * smoothstep(0, P.coreRadius, h),
        h / P.arrivalTime,
        P.maxSpeed,
      );
      out.x += (dx / h) * speed;
      out.z += (dz / h) * speed;
      any = true;
    }
    const s = Math.hypot(out.x, out.z);
    if (s > P.maxSpeed) out.multiplyScalar(P.maxSpeed / s);
    return any;
  }

  slowAt(position: Vec3Like): number {
    let m = 1;
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.activeList[k]!;
      const def = this.defs[i]!;
      if (def.kind !== 'slow') continue;
      if (!this.insideFloorField(i, def, position.x, position.y, position.z, 0)) continue;
      const s = Math.max(0, Math.min(1, def.strength));
      if (s < m) m = s;
    }
    return m;
  }

  fixedUpdate(dt: number): void {
    if (!(dt > 0)) return;
    const interval = ARSENAL.fields.tickInterval;
    for (let k = this.activeCount - 1; k >= 0; k--) {
      const i = this.activeList[k]!;
      const def = this.defs[i]!;
      this.age[i] = this.age[i]! + dt;
      if (def.dps > 0 && interval > 0) {
        this.tick[i] = this.tick[i]! + dt;
        while (this.tick[i]! >= interval - TIME_EPS) {
          this.tick[i] = this.tick[i]! - interval;
          this.damageTick(i, def, interval);
        }
      }
      if (this.age[i]! >= def.duration - TIME_EPS) this.end(k, true);
    }
  }

  update(_dt: number): void {
    // Field visuals animate on their own (ArsenalVfxApi); nothing to interpolate.
  }

  /** Remove every field (run reset): visuals and field:ended, no collapse. */
  clear(): void {
    while (this.activeCount > 0) this.end(this.activeCount - 1, false);
  }

  /** Active fields (debug / tests). */
  forEachField(fn: (id: number, def: FieldDef, x: number, y: number, z: number, age: number) => void): void {
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.activeList[k]!;
      fn(
        this.ids[i]!,
        this.defs[i]!,
        this.pos[i * 3]!,
        this.pos[i * 3 + 1]!,
        this.pos[i * 3 + 2]!,
        this.age[i]!,
      );
    }
  }

  dispose(): void {
    this.clear();
    this.specials = null;
  }

  // -------------------------------------------------------------------------

  private damageTick(i: number, def: FieldDef, interval: number): void {
    const o = i * 3;
    const cx = this.pos[o]!;
    const cy = this.pos[o + 1]!;
    const cz = this.pos[o + 2]!;
    const source = this.sources[i]!;
    const spare = source === 'player' ? 'player' : source === 'enemy' ? 'enemy' : null;
    const list = this.combat.queryRadius(
      _center.set(cx, cy, cz),
      def.radius + ARSENAL.fields.height,
      this.list,
    );
    const amount = def.dps * interval * this.areaScale[i]!;
    const lift = ARSENAL.fields.losLift;
    this.stats.ticks++;
    for (let k = 0; k < list.length; k++) {
      const t = list[k]!;
      if (!t.alive || t.team === spare) continue;
      const b = t.boundsCenter;
      if (def.kind === 'pull') {
        const r = def.radius + t.boundsRadius * ARSENAL.fields.boundsFactor;
        if ((b.x - cx) ** 2 + (b.y - cy) ** 2 + (b.z - cz) ** 2 > r * r) continue;
      } else if (!this.insideFloorField(i, def, b.x, b.y, b.z, t.boundsRadius)) continue;
      _from.set(cx, cy + lift, cz);
      if (!this.combat.lineOfSight(_from, b)) continue;
      const info = this.info;
      info.amount = amount;
      info.zone = 'body';
      copyVec(b, info.point);
      const dx = b.x - cx;
      const dz = b.z - cz;
      const h = Math.hypot(dx, dz);
      info.direction.x = h > 1e-6 ? dx / h : 0;
      info.direction.y = h > 1e-6 ? 0 : 1;
      info.direction.z = h > 1e-6 ? dz / h : 0;
      info.weaponId = this.weaponIds[i]!;
      info.element = def.element;
      info.source = source;
      info.kind = 'explosion';
      info.impulse = 0;
      info.statusBuildup = this.buildup[i]!;
      const res = this.combat.dealDamage(t, info);
      const applied = res.applied;
      const killed = res.killed;
      const special = this.specialDefs[i] ?? null;
      if (special && this.specials) {
        const hit = this.hit;
        hit.special = special;
        hit.via = 'tick';
        hit.weaponId = this.weaponIds[i]!;
        hit.source = source;
        hit.target = t;
        copyVec(b, hit.point);
        hit.applied = applied;
        hit.killed = killed;
        hit.primary = true;
        this.specials.onHit(hit);
      }
    }
    list.length = 0;
  }

  /** Inside field i's floor cylinder (a body of `radius` counts with part of its bounds)? */
  private insideFloorField(
    i: number,
    def: FieldDef,
    x: number,
    y: number,
    z: number,
    radius: number,
  ): boolean {
    const o = i * 3;
    const dy = y - this.pos[o + 1]!;
    if (dy < -radius - ARSENAL.fields.depthTolerance || dy > ARSENAL.fields.height + radius) return false;
    const r = def.radius + radius * ARSENAL.fields.boundsFactor;
    const dx = x - this.pos[o]!;
    const dz = z - this.pos[o + 2]!;
    return dx * dx + dz * dz <= r * r;
  }

  /** End the field at active index k (collapse explosion when due), release its slot. */
  private end(k: number, collapse: boolean): void {
    const i = this.activeList[k]!;
    const def = this.defs[i]!;
    const id = this.ids[i]!;
    const handle = this.handle[i]!;
    // Release first: a collapse kill may spawn new fields into the pool.
    this.activeList[k] = this.activeList[--this.activeCount]!;
    this.free[this.freeTop++] = i;
    this.defs[i] = null;
    this.handle[i] = 0;
    const special = this.specialDefs[i] ?? null;
    this.specialDefs[i] = null;
    if (handle !== 0) this.vfx.fieldEnd(handle);
    this.endedPayload.id = id;
    this.events.emit('field:ended', this.endedPayload);
    if (collapse && def?.collapse) {
      const o = i * 3;
      _center.set(this.pos[o]!, this.pos[o + 1]!, this.pos[o + 2]!);
      const from = this.from;
      from.weaponId = this.weaponIds[i]!;
      from.source = this.sources[i]!;
      from.statusBuildup = this.buildup[i]!;
      from.special = special;
      from.areaScale = this.areaScale[i]!;
      this.explosions.explode(_center, def.collapse, from);
    }
  }

  /** Move `p` down onto the floor below (within ARSENAL.fields.floorProbe); damageables are passed. */
  private snapToFloor(p: Vector3): void {
    const ignore = this.ignore;
    ignore.length = 0;
    _probe.set(p.x, p.y + ARSENAL.fields.floorLift, p.z);
    const reach = ARSENAL.fields.floorProbe + ARSENAL.fields.floorLift;
    for (let pass = 0; pass < ARSENAL.fields.floorPasses; pass++) {
      const hit = this.combat.raycast(_probe, DOWN, reach, this.rayOpts);
      if (!hit) break;
      if (hit.target) {
        ignore.push(hit.target);
        continue;
      }
      p.copy(hit.point);
      break;
    }
    ignore.length = 0;
  }
}

function finite(v: Vec3Like): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function copyVec(from: Vec3Like, to: Vec3Like): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}
