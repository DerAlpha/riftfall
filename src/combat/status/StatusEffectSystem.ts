/**
 * Status effects (StatusEffectsApi + CombatStatusHook, M5 elements). Rules and tuning:
 * defs/elements.ts (build-up thresholds, statuses, combos, resistances).
 *
 * Data flow:
 * - CombatWorld.dealDamage asks `damageTakenMultiplier` before a hit (void mark) and reports the
 *   applied damage to `onDamaged` after it: elemental damage adds build-up (applied × the info's
 *   statusBuildup), hits on a frozen target accumulate towards a shatter. `applyElement` (weapon
 *   specials' elementProc, combos, arcs) adds build-up directly. Both only RECORD.
 * - fixedUpdate (after the enemies and the arsenal, before physics.step) resolves everything:
 *   thresholds → statuses (combat:status), implosions, shatters, combos (combat:combo), timers,
 *   damage over time, burn spread, shock arcs, deaths (poison clouds), and spawns the status
 *   particles (defs/vfx status.<id>) at a budgeted low rate.
 * - Enemies read speedMultiplier / incapacitated / rimFor / has every tick (EnemyManager).
 *
 * Per-damageable state lives in pooled slots (structure of arrays, ELEMENTS.capacity); a slot is
 * taken on the first build-up and returned when nothing is left or the target is gone (dead:
 * death effects first). Every damage the system deals goes through CombatWorld with non-discrete
 * kinds ('beam' ticks and arcs, 'explosion' areas): kills pay, ticks do not (PointsRules). Status
 * damage carries no build-up of its own, so nothing feeds back into itself.
 *
 * Nothing allocates per tick: reused payloads, DamageInfo, scratch lists and vectors. Cosmetic
 * randomness (particle points, rim phases) uses its own seeded Rng; gameplay has none.
 */
import { Vector3 } from 'three';
import type {
  CombatStatusHook,
  CombatWorldApi,
  DamageInfo,
  DamageResult,
  Damageable,
  ExplosionApi,
  FieldApi,
  StatusEffectsApi,
  VfxApi,
} from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type { DamageElement, GameEvents, ImpactKind, StatusId, Vec3Like } from '../../core/events';
import { Rng } from '../../core/Rng';
import {
  COMBOS,
  ELEMENTS,
  STATUS_ELEMENTS,
  STATUS_IDS,
  STATUS_RESIST,
  statusElementIndex,
  type ComboDef,
  type StatusResistDef,
} from '../../defs/elements';

type Source = DamageInfo['source'];

/** Status resistances and toughness of a target (Game: its enemy kind and health multiplier). */
export interface StatusTargetProfile {
  resist: StatusResistDef;
  /** Damage over time, shatters and combo damage scale with it (wave health multiplier, elites). */
  healthScale: number;
}

/** Short lightning flashes between two points (the arsenal's WeaponSpecials.flash). */
export interface StatusArcFlash {
  flash(points: readonly Vec3Like[], count: number): void;
}

export interface StatusEffectDeps {
  events: EventBus<GameEvents>;
  combat: Pick<CombatWorldApi, 'queryRadius' | 'dealDamage' | 'lineOfSight'>;
  /** Status particles and combo bursts (optional: headless). */
  vfx?: Pick<VfxApi, 'spawn'> | null;
  /** Void implosions (optional). */
  explosions?: ExplosionApi | null;
  /** Poison clouds (optional). */
  fields?: Pick<FieldApi, 'spawn'> | null;
  /** Shock / superconductor arc visuals (optional). */
  arcs?: StatusArcFlash | null;
  /** Resistances / toughness per target; false or absent = STATUS_RESIST.default, scale 1. */
  profile?: ((target: Damageable, out: StatusTargetProfile) => boolean) | null;
  capacity?: number;
  /** Cosmetic randomness seed. */
  seed?: string | number;
}

const NE = STATUS_ELEMENTS.length;
const NS = STATUS_IDS.length;
const FIRE = STATUS_ELEMENTS.indexOf('fire');
const ICE = STATUS_ELEMENTS.indexOf('ice');
const SHOCK = STATUS_ELEMENTS.indexOf('shock');
const POISON = STATUS_ELEMENTS.indexOf('poison');
const VOID = STATUS_ELEMENTS.indexOf('void');
const BURN = STATUS_IDS.indexOf('burn');
const CHILL = STATUS_IDS.indexOf('chill');
const FROZEN = STATUS_IDS.indexOf('frozen');
const SHOCKED = STATUS_IDS.indexOf('shocked');
const POISONED = STATUS_IDS.indexOf('poisoned');
const MARK = STATUS_IDS.indexOf('voidMark');
/** Status index → its element's index. */
const STATUS_EL = new Int8Array([FIRE, ICE, ICE, SHOCK, POISON, VOID]);
/** Triggers resolved per element and slot per tick (the rest waits), and the backlog in thresholds. */
const MAX_TRIGGERS = 3;
/** Nearest-target picks per query at most (arcs, spread), candidates considered per query. */
const MAX_PICKS = 8;
const MAX_CANDIDATES = 96;
const RIM_PRIORITY = ELEMENTS.rim.priority.map((id) => STATUS_IDS.indexOf(id));
const TAU = Math.PI * 2;
const UP: Vec3Like = { x: 0, y: 1, z: 0 };
const NO_DAMAGE: DamageResult = Object.freeze({ applied: 0, killed: false });

const _center = new Vector3();
const _dir = new Vector3();
const _point = new Vector3();

export class StatusEffectSystem implements StatusEffectsApi, CombatStatusHook {
  readonly capacity: number;
  readonly stats = {
    triggers: 0,
    combos: 0,
    shatters: 0,
    implosions: 0,
    clouds: 0,
    dotTicks: 0,
    arcs: 0,
    refused: 0,
  };

  private readonly events: EventBus<GameEvents>;
  private readonly combat: StatusEffectDeps['combat'];
  private vfx: Pick<VfxApi, 'spawn'> | null;
  private explosions: ExplosionApi | null;
  private fields: Pick<FieldApi, 'spawn'> | null;
  private arcs: StatusArcFlash | null;
  private readonly profile: StatusEffectDeps['profile'];
  private readonly rng: Rng;
  private now = 0;
  /** 1: rims pulse, 0: steady (reduce flashing). */
  private rimPulse = 1;

  // --- slots ---
  private readonly targets: (Damageable | null)[];
  private readonly ids: Int32Array;
  private readonly slotOf = new Map<number, number>();
  private readonly free: Int32Array;
  private freeTop = 0;
  private readonly list: Int32Array;
  private count = 0;
  private readonly resist: StatusResistDef[];
  private readonly toughness: Float32Array;
  private readonly phase: Float32Array;

  // --- build-up per element (slot × NE) ---
  private readonly buildup: Float32Array;
  private readonly buildAt: Float64Array;
  private readonly buildSource: Source[];
  private readonly buildWeapon: string[];

  // --- statuses (slot × NS): remaining time, stacks, attribution, particle timers ---
  private readonly time: Float32Array;
  private readonly stacks: Uint8Array;
  private readonly statusSource: Source[];
  private readonly statusWeapon: string[];
  private readonly vfxTimer: Float32Array;

  // --- per slot ---
  private readonly freezeImmune: Float32Array;
  private readonly stun: Float32Array;
  private readonly stunImmune: Float32Array;
  private readonly dotTimer: Float32Array;
  private readonly spreadTimer: Float32Array;
  private readonly arcTimer: Float32Array;
  private readonly voidCharge: Float32Array;
  private readonly ampTime: Float32Array;
  private readonly ampMult: Float32Array;
  private readonly comboCd: Float32Array;
  private readonly shatterHit: Float32Array;
  private readonly shatterHeavy: Uint8Array;
  private readonly shatterSource: Source[];
  private readonly shatterWeapon: string[];
  /** Attribution of the latest trigger (combos). */
  private readonly lastSource: Source[];
  private readonly lastWeapon: string[];

  // --- per tick ---
  private comboBudget = 0;
  /** Start times of the latest full-size combo bursts (ELEMENTS.combos.vfx). */
  private readonly burstTimes = new Float64Array(ELEMENTS.combos.vfx.fullBursts).fill(
    Number.NEGATIVE_INFINITY,
  );
  private burstCursor = 0;
  /** End times of the death clouds alive (ELEMENTS.poisoned.cloud.maxActive). */
  private readonly cloudEnds = new Float64Array(ELEMENTS.poisoned.cloud.maxActive);
  private vfxBudget = 0;
  private vfxCursor = 0;

  // --- scratch ---
  private readonly query: Damageable[] = [];
  /** Nearest-target picks (fixed length; `nearest` returns how many are valid). */
  private readonly picks: Damageable[] = new Array<Damageable>(MAX_PICKS).fill(STUB);
  private readonly pickDist = new Float64Array(MAX_CANDIDATES);
  private readonly arcPoints: Vector3[] = [new Vector3(), new Vector3()];
  private readonly profileOut: StatusTargetProfile = { resist: STATUS_RESIST.default, healthScale: 1 };
  private readonly info: DamageInfo = {
    amount: 0,
    zone: 'body',
    point: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 1, z: 0 },
    weaponId: '',
    element: 'physical',
    source: 'player',
    kind: 'beam',
    impulse: 0,
    statusBuildup: 0,
  };
  private readonly area: {
    weaponId: string;
    source: Source;
    statusBuildup: number;
    special: null;
    areaScale: number;
  } = { weaponId: '', source: 'player', statusBuildup: 0, special: null, areaScale: 1 };
  private readonly statusPayload: GameEvents['combat:status'] = {
    targetId: 0,
    status: 'burn',
    stacks: 0,
    position: { x: 0, y: 0, z: 0 },
  };
  private readonly comboPayload: GameEvents['combat:combo'] = {
    targetId: 0,
    combo: '',
    position: { x: 0, y: 0, z: 0 },
  };
  private readonly burstPayload: GameEvents['combat:explosion'] = {
    position: { x: 0, y: 0, z: 0 },
    radius: 0,
    element: 'ice',
    vfx: '',
    audio: '',
  };

  constructor(deps: StatusEffectDeps) {
    this.events = deps.events;
    this.combat = deps.combat;
    this.vfx = deps.vfx ?? null;
    this.explosions = deps.explosions ?? null;
    this.fields = deps.fields ?? null;
    this.arcs = deps.arcs ?? null;
    this.profile = deps.profile ?? null;
    this.rng = new Rng(deps.seed ?? 'status');
    const n = Math.max(1, Math.floor(deps.capacity ?? ELEMENTS.capacity));
    this.capacity = n;
    this.targets = new Array<Damageable | null>(n).fill(null);
    this.ids = new Int32Array(n);
    this.free = new Int32Array(n);
    for (let i = 0; i < n; i++) this.free[i] = n - 1 - i;
    this.freeTop = n;
    this.list = new Int32Array(n);
    this.resist = new Array<StatusResistDef>(n).fill(STATUS_RESIST.default);
    this.toughness = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.buildup = new Float32Array(n * NE);
    this.buildAt = new Float64Array(n * NE);
    this.buildSource = new Array<Source>(n * NE).fill('player');
    this.buildWeapon = new Array<string>(n * NE).fill('');
    this.time = new Float32Array(n * NS);
    this.stacks = new Uint8Array(n * NS);
    this.statusSource = new Array<Source>(n * NS).fill('player');
    this.statusWeapon = new Array<string>(n * NS).fill('');
    this.vfxTimer = new Float32Array(n * NS);
    this.freezeImmune = new Float32Array(n);
    this.stun = new Float32Array(n);
    this.stunImmune = new Float32Array(n);
    this.dotTimer = new Float32Array(n);
    this.spreadTimer = new Float32Array(n);
    this.arcTimer = new Float32Array(n);
    this.voidCharge = new Float32Array(n);
    this.ampTime = new Float32Array(n);
    this.ampMult = new Float32Array(n);
    this.comboCd = new Float32Array(n);
    this.shatterHit = new Float32Array(n);
    this.shatterHeavy = new Uint8Array(n);
    this.shatterSource = new Array<Source>(n).fill('player');
    this.shatterWeapon = new Array<string>(n).fill('');
    this.lastSource = new Array<Source>(n).fill('player');
    this.lastWeapon = new Array<string>(n).fill('');
  }

  /** Damageables with any build-up or status. */
  get slots(): number {
    return this.count;
  }

  /** Late wiring (the arsenal and VFX exist before, but tools may attach parts afterwards). */
  attach(parts: {
    vfx?: Pick<VfxApi, 'spawn'> | null;
    explosions?: ExplosionApi | null;
    fields?: Pick<FieldApi, 'spawn'> | null;
    arcs?: StatusArcFlash | null;
  }): void {
    if (parts.vfx !== undefined) this.vfx = parts.vfx;
    if (parts.explosions !== undefined) this.explosions = parts.explosions;
    if (parts.fields !== undefined) this.fields = parts.fields;
    if (parts.arcs !== undefined) this.arcs = parts.arcs;
  }

  // -------------------------------------------------------------------------
  // StatusEffectsApi / CombatStatusHook (record only)
  // -------------------------------------------------------------------------

  applyElement(
    target: Damageable,
    element: DamageElement,
    amount: number,
    source: Source,
    weaponId = '',
  ): void {
    const el = statusElementIndex(element);
    if (el < 0) return;
    this.addBuildup(target, el, amount, source, weaponId);
  }

  damageTakenMultiplier(targetId: number): number {
    const s = this.slotOf.get(targetId);
    if (s === undefined || !(this.time[s * NS + MARK]! > 0)) return 1;
    return ELEMENTS.voidMark.damageTaken;
  }

  onDamaged(target: Damageable, info: Readonly<DamageInfo>, applied: number, killed: boolean): void {
    if (killed || !(applied > 0) || !Number.isFinite(applied)) return;
    const s = this.slotOf.get(target.id);
    if (s !== undefined && this.targets[s] === target && this.time[s * NS + FROZEN]! > 0) {
      // A frozen body: this tick's hits add up towards a shatter (a shotgun volley, a blast).
      this.shatterHit[s] = this.shatterHit[s]! + applied;
      if ((ELEMENTS.frozen.shatter.heavyKinds as readonly ImpactKind[]).includes(info.kind)) {
        this.shatterHeavy[s] = 1;
      }
      this.shatterSource[s] = info.source;
      this.shatterWeapon[s] = info.weaponId;
    }
    const b = info.statusBuildup ?? 0;
    if (!(b > 0)) return;
    const el = statusElementIndex(info.element);
    if (el >= 0) this.addBuildup(target, el, applied * b, info.source, info.weaponId);
  }

  has(targetId: number, status: StatusId): boolean {
    const s = this.slotOf.get(targetId);
    if (s === undefined) return false;
    return this.isOn(s, STATUS_IDS.indexOf(status));
  }

  /** Stacks of `status` on the target (0 = none; single-stack statuses report 1). */
  stacksOf(targetId: number, status: StatusId): number {
    const s = this.slotOf.get(targetId);
    const st = STATUS_IDS.indexOf(status);
    if (s === undefined || !this.isOn(s, st)) return 0;
    return this.stacks[s * NS + st]!;
  }

  /** Current build-up of `element` on the target (debug / tests). */
  buildupOf(targetId: number, element: DamageElement): number {
    const s = this.slotOf.get(targetId);
    const el = statusElementIndex(element);
    return s === undefined || el < 0 ? 0 : this.buildup[s * NE + el]!;
  }

  speedMultiplier(targetId: number): number {
    const s = this.slotOf.get(targetId);
    if (s === undefined) return 1;
    if (this.time[s * NS + FROZEN]! > 0) return 0;
    const st = this.isOn(s, CHILL) ? this.stacks[s * NS + CHILL]! : 0;
    if (st === 0) return 1;
    return Math.max(0, 1 - st * ELEMENTS.chill.slowPerStack * this.resist[s]!.slow);
  }

  incapacitated(targetId: number): boolean {
    const s = this.slotOf.get(targetId);
    return s !== undefined && (this.time[s * NS + FROZEN]! > 0 || this.stun[s]! > 0);
  }

  /** accessibility.reduceFlashing: status rims hold a steady strength instead of pulsing. */
  setReducedFlashing(on: boolean): void {
    this.rimPulse = on ? 0 : 1;
  }

  rimFor(targetId: number, out: { color: number; strength: number }): boolean {
    const s = this.slotOf.get(targetId);
    if (s === undefined) return false;
    const R = ELEMENTS.rim;
    for (let p = 0; p < RIM_PRIORITY.length; p++) {
      const st = RIM_PRIORITY[p]!;
      if (!this.isOn(s, st)) continue;
      const def: { color: number; strength: number; pulse: number; rate: number; perStack?: number } =
        R[STATUS_IDS[st]!];
      const extra = (def.perStack ?? 0) * Math.max(0, this.stacks[s * NS + st]! - 1);
      // Reduce flashing: the rim holds its mean (the shocked rim would throb at ~5 Hz).
      const wave = this.rimPulse > 0 ? 0.5 + 0.5 * Math.sin(this.now * def.rate + this.phase[s]!) : 0.5;
      out.color = def.color;
      out.strength = Math.min(1, Math.max(0, (def.strength + extra) * (1 - def.pulse + def.pulse * wave)));
      return true;
    }
    return false;
  }

  clear(targetId: number): void {
    const s = this.slotOf.get(targetId);
    if (s === undefined) return;
    const k = this.list.indexOf(s);
    if (k >= 0 && k < this.count) this.release(k);
  }

  reset(): void {
    while (this.count > 0) this.release(this.count - 1);
    this.cloudEnds.fill(0);
    this.burstTimes.fill(Number.NEGATIVE_INFINITY);
    this.vfxCursor = 0;
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number): void {
    if (!(dt > 0)) return;
    this.now += dt;
    this.comboBudget = ELEMENTS.combos.perTick;
    // Backwards: releases swap the last slot in (already processed), slots taken during the pass
    // (neighbours hit by areas) are appended behind k and resolve next tick.
    for (let k = this.count - 1; k >= 0; k--) {
      const s = this.list[k]!;
      const t = this.targets[s]!;
      if (!t.alive || t.id !== this.ids[s]) {
        if (!t.alive && t.id === this.ids[s]) this.onDeath(s, t);
        this.release(k);
        continue;
      }
      this.resolveBuildup(s, dt);
      if (this.isOn(s, MARK) && this.voidCharge[s]! >= ELEMENTS.voidMark.implode.charge) this.implode(s, t);
      if (this.time[s * NS + FROZEN]! > 0) this.checkShatter(s, t);
      this.shatterHit[s] = 0;
      this.shatterHeavy[s] = 0;
      if (this.comboBudget > 0 && !(this.comboCd[s]! > 0)) this.resolveCombos(s, t);
      this.advance(s, dt);
      if (t.alive) this.damageOverTime(s, t, dt);
      if (t.alive) this.spreadAndArc(s, t, dt);
      if (this.idle(s)) this.release(k);
    }
    this.spawnParticles(dt);
  }

  // -------------------------------------------------------------------------
  // Build-up and triggers
  // -------------------------------------------------------------------------

  private addBuildup(target: Damageable, el: number, amount: number, source: Source, weaponId: string): void {
    if (!(amount > 0) || !Number.isFinite(amount) || !target.alive || target.team !== ELEMENTS.team) return;
    const s = this.slotFor(target);
    if (s < 0) return;
    const r = this.resist[s]!.buildup[STATUS_ELEMENTS[el]!] ?? 1;
    const add = amount * (Number.isFinite(r) ? Math.max(0, r) : 1);
    if (!(add > 0)) return;
    const i = s * NE + el;
    this.buildAt[i] = this.now;
    this.buildSource[i] = source;
    this.buildWeapon[i] = weaponId;
    if (el === VOID && this.isOn(s, MARK)) {
      // Marked: more void charges the implosion instead of re-marking.
      this.voidCharge[s] = this.voidCharge[s]! + add;
      return;
    }
    this.buildup[i] = this.buildup[i]! + add;
  }

  private resolveBuildup(s: number, dt: number): void {
    const B = ELEMENTS.buildup;
    for (let el = 0; el < NE; el++) {
      const i = s * NE + el;
      let v = this.buildup[i]!;
      if (!(v > 0)) continue;
      if (this.now - this.buildAt[i]! > B.decayDelay) v = Math.max(0, v - B.decayPerSecond * dt);
      const threshold = B.threshold[STATUS_ELEMENTS[el]!];
      let n = 0;
      while (v >= threshold && n < MAX_TRIGGERS) {
        v -= threshold;
        n++;
        this.trigger(s, el);
      }
      // A huge proc resolves over the next ticks (bounded backlog).
      this.buildup[i] = Math.min(v, threshold * MAX_TRIGGERS);
    }
  }

  private trigger(s: number, el: number): void {
    const src = this.buildSource[s * NE + el]!;
    const wpn = this.buildWeapon[s * NE + el]!;
    this.lastSource[s] = src;
    this.lastWeapon[s] = wpn;
    this.stats.triggers++;
    const resist = this.resist[s]!;
    switch (el) {
      case FIRE: {
        const fresh = !this.isOn(s, BURN);
        this.raise(s, BURN, 1, ELEMENTS.burn.duration, src, wpn);
        if (fresh) this.spreadTimer[s] = ELEMENTS.burn.spread.interval;
        return;
      }
      case ICE: {
        if (this.time[s * NS + FROZEN]! > 0) return;
        const C = ELEMENTS.chill;
        const st = this.isOn(s, CHILL) ? this.stacks[s * NS + CHILL]! : 0;
        if (st < C.maxStacks) {
          this.raise(s, CHILL, st + 1, C.duration, src, wpn);
        } else if (resist.freeze && !(this.freezeImmune[s]! > 0)) {
          this.setOff(s, CHILL);
          this.buildup[s * NE + ICE] = 0;
          this.raise(s, FROZEN, 1, this.control(s, ELEMENTS.frozen.duration), src, wpn);
        } else {
          this.raise(s, CHILL, st, C.duration, src, wpn);
        }
        return;
      }
      case SHOCK: {
        const fresh = !this.isOn(s, SHOCKED);
        this.raise(s, SHOCKED, 1, ELEMENTS.shocked.duration, src, wpn);
        if (fresh) this.arcTimer[s] = 0;
        if (!(this.stunImmune[s]! > 0)) {
          this.stun[s] = Math.max(this.stun[s]!, this.control(s, ELEMENTS.shocked.stun));
        }
        return;
      }
      case POISON: {
        const P = ELEMENTS.poisoned;
        const st = this.isOn(s, POISONED) ? this.stacks[s * NS + POISONED]! : 0;
        this.raise(s, POISONED, Math.min(P.maxStacks, st + 1), P.duration, src, wpn);
        return;
      }
      case VOID: {
        this.voidCharge[s] = 0;
        this.raise(s, MARK, 1, ELEMENTS.voidMark.duration, src, wpn);
        return;
      }
    }
  }

  /** Apply / refresh a status; combat:status when it is new or gains stacks. */
  private raise(s: number, st: number, stacks: number, duration: number, src: Source, wpn: string): void {
    const i = s * NS + st;
    const prev = this.isOn(s, st) ? this.stacks[i]! : 0;
    this.time[i] = Math.max(this.time[i]!, duration);
    this.stacks[i] = stacks;
    this.statusSource[i] = src;
    this.statusWeapon[i] = wpn;
    if (prev === 0) this.vfxTimer[i] = 0;
    if (stacks > prev) this.emitStatus(s, st);
  }

  private setOff(s: number, st: number): void {
    const i = s * NS + st;
    this.time[i] = 0;
    this.stacks[i] = 0;
  }

  private isOn(s: number, st: number): boolean {
    const i = s * NS + st;
    return this.time[i]! > 0 && this.stacks[i]! > 0;
  }

  /** A crowd-control duration after the target's resistance, capped. */
  private control(s: number, seconds: number): number {
    return Math.min(ELEMENTS.maxControl, seconds * Math.max(0, this.resist[s]!.control));
  }

  // -------------------------------------------------------------------------
  // Reactions
  // -------------------------------------------------------------------------

  private implode(s: number, t: Damageable): void {
    const src = this.statusSource[s * NS + MARK]!;
    const wpn = this.statusWeapon[s * NS + MARK]!;
    this.voidCharge[s] = 0;
    this.setOff(s, MARK);
    this.stats.implosions++;
    if (!this.explosions) return;
    const from = this.area;
    from.weaponId = wpn;
    from.source = src;
    from.statusBuildup = 0;
    from.areaScale = this.toughness[s]!;
    _center.copy(t.boundsCenter);
    this.explosions.explode(_center, ELEMENTS.voidMark.implode.explosion, from);
  }

  private checkShatter(s: number, t: Damageable): void {
    const S = ELEMENTS.frozen.shatter;
    const hit = this.shatterHit[s]!;
    if (!(hit > 0)) return;
    if (this.shatterHeavy[s] === 0 && hit < S.minHit * this.toughness[s]!) return;
    this.setOff(s, FROZEN);
    this.freezeImmune[s] = ELEMENTS.frozen.immunity;
    this.stats.shatters++;
    const p = this.burstPayload;
    copyVec(t.boundsCenter, p.position);
    p.radius = S.burstRadius;
    p.element = 'ice';
    p.vfx = S.vfx;
    p.audio = S.audio;
    this.events.emit('combat:explosion', p);
    const bonus = S.damage * this.toughness[s]! + S.hitFraction * hit;
    this.deal(t, bonus, 'ice', 'explosion', this.shatterSource[s]!, this.shatterWeapon[s]!);
  }

  private resolveCombos(s: number, t: Damageable): void {
    for (let c = 0; c < COMBOS.length; c++) {
      const combo = COMBOS[c]!;
      if (!this.reacts(s, combo)) continue;
      this.runCombo(s, t, combo);
      return;
    }
  }

  private reacts(s: number, combo: ComboDef): boolean {
    const a = STATUS_ELEMENTS.indexOf(combo.elements[0]);
    if (!this.elementOn(s, a)) return false;
    const b = combo.elements[1];
    if (b !== 'any') return this.elementOn(s, STATUS_ELEMENTS.indexOf(b));
    for (let st = 0; st < NS; st++) if (STATUS_EL[st] !== a && this.isOn(s, st)) return true;
    return false;
  }

  /** A status of element `el` is active (ice: chill or frozen). */
  private elementOn(s: number, el: number): boolean {
    for (let st = 0; st < NS; st++) if (STATUS_EL[st] === el && this.isOn(s, st)) return true;
    return false;
  }

  private runCombo(s: number, t: Damageable, combo: ComboDef): void {
    this.comboBudget--;
    this.comboCd[s] = ELEMENTS.combos.cooldown;
    this.stats.combos++;
    const tough = this.toughness[s]!;
    const src = this.lastSource[s]!;
    const wpn = this.lastWeapon[s]!;
    const wasFrozen = this.time[s * NS + FROZEN]! > 0;
    const poisonStacks = this.isOn(s, POISONED) ? this.stacks[s * NS + POISONED]! : 0;
    let others = 0;
    for (let st = 0; st < NS; st++) if (st !== MARK && this.isOn(s, st)) others++;

    let damage = combo.damage;
    if (wasFrozen && combo.frozenBonus) damage *= combo.frozenBonus;
    if (combo.perPoisonStack) damage += combo.perPoisonStack * poisonStacks;
    if (combo.perOtherStatus) damage *= 1 + combo.perOtherStatus * others;
    damage *= tough;

    for (let i = 0; i < combo.consume.length; i++) {
      const st = STATUS_IDS.indexOf(combo.consume[i]!);
      if (st === FROZEN && this.isOn(s, FROZEN)) this.freezeImmune[s] = ELEMENTS.frozen.immunity;
      this.setOff(s, st);
    }
    if (combo.amplify) this.amplify(s, combo.amplify.dot, combo.amplify.duration);
    if (combo.stun > 0) this.stun[s] = Math.max(this.stun[s]!, this.control(s, combo.stun));

    _center.copy(t.boundsCenter);
    const p = this.comboPayload;
    p.targetId = t.id;
    p.combo = combo.id;
    copyVec(_center, p.position);
    this.events.emit('combat:combo', p);
    this.vfx?.spawn(combo.vfx, _center, UP, combo.vfxScale * this.burstScale());

    this.deal(t, damage, combo.element, 'explosion', src, wpn);
    if (combo.area) {
      this.areaDamage(_center, combo.area.radius, combo.area.damage * tough, combo.element, src, wpn, t);
    }
    const spread = combo.spread;
    if (spread) {
      const n = this.nearest(_center, spread.radius, t, spread.maxTargets);
      const el = STATUS_ELEMENTS.indexOf(spread.element);
      for (let i = 0; i < n; i++) this.addBuildup(this.picks[i]!, el, spread.amount, src, wpn);
    }
    const arcs = combo.arcs;
    if (arcs) {
      const el = STATUS_ELEMENTS.indexOf(arcs.element);
      this.arcFrom(t, arcs.count, arcs.range, arcs.damage * tough, combo.element, el, arcs.buildup, src, wpn);
    }
    this.picks.fill(STUB);
  }

  /** Full size while few bursts played lately, else the crowded scale (a horde reacting at once). */
  private burstScale(): number {
    const V = ELEMENTS.combos.vfx;
    const n = this.burstTimes.length;
    if (n === 0 || this.now - this.burstTimes[this.burstCursor]! < V.window) return V.crowdedScale;
    this.burstTimes[this.burstCursor] = this.now;
    this.burstCursor = (this.burstCursor + 1) % n;
    return 1;
  }

  /** Voidrupture: the other statuses restart at full length and their damage over time is multiplied. */
  private amplify(s: number, dot: number, duration: number): void {
    for (let st = 0; st < NS; st++) {
      if (st === MARK || st === FROZEN || !this.isOn(s, st)) continue;
      this.time[s * NS + st] = Math.max(this.time[s * NS + st]!, baseDuration(st));
    }
    this.ampMult[s] = dot;
    this.ampTime[s] = duration;
  }

  // -------------------------------------------------------------------------
  // Timers, damage over time, spread, arcs
  // -------------------------------------------------------------------------

  private advance(s: number, dt: number): void {
    const o = s * NS;
    for (let st = 0; st < NS; st++) {
      const i = o + st;
      if (!(this.time[i]! > 0)) continue;
      this.time[i] = this.time[i]! - dt;
      if (this.time[i]! > 0) continue;
      this.time[i] = 0;
      if (st === CHILL && this.stacks[i]! > 1) {
        // Thaws one stack at a time.
        this.stacks[i] = this.stacks[i]! - 1;
        this.time[i] = ELEMENTS.chill.stackDecay;
      } else if (st === FROZEN) {
        this.stacks[i] = 0;
        this.freezeImmune[s] = ELEMENTS.frozen.immunity;
        const thaw = ELEMENTS.frozen.thawStacks;
        if (thaw > 0) {
          this.stacks[o + CHILL] = thaw;
          this.time[o + CHILL] = ELEMENTS.chill.stackDecay;
        }
      } else {
        this.stacks[i] = 0;
        if (st === MARK) this.voidCharge[s] = 0;
      }
    }
    const hadStun = this.stun[s]! > 0;
    this.stun[s] = Math.max(0, this.stun[s]! - dt);
    if (hadStun && this.stun[s] === 0) this.stunImmune[s] = ELEMENTS.shocked.stunImmunity;
    else this.stunImmune[s] = Math.max(0, this.stunImmune[s]! - dt);
    this.freezeImmune[s] = Math.max(0, this.freezeImmune[s]! - dt);
    this.comboCd[s] = Math.max(0, this.comboCd[s]! - dt);
    this.ampTime[s] = Math.max(0, this.ampTime[s]! - dt);
  }

  private damageOverTime(s: number, t: Damageable, dt: number): void {
    const burn = this.isOn(s, BURN);
    const poison = this.isOn(s, POISONED);
    if (!burn && !poison) {
      this.dotTimer[s] = 0;
      return;
    }
    const interval = ELEMENTS.dotInterval;
    this.dotTimer[s] = this.dotTimer[s]! + dt;
    if (this.dotTimer[s]! < interval) return;
    this.dotTimer[s] = this.dotTimer[s]! - interval;
    const scale = interval * this.toughness[s]! * (this.ampTime[s]! > 0 ? this.ampMult[s]! : 1);
    this.stats.dotTicks++;
    if (burn) {
      const i = s * NS + BURN;
      this.deal(t, ELEMENTS.burn.dps * scale, 'fire', 'beam', this.statusSource[i]!, this.statusWeapon[i]!);
    }
    if (poison && t.alive) {
      const i = s * NS + POISONED;
      const dps = ELEMENTS.poisoned.dpsPerStack * this.stacks[i]!;
      this.deal(t, dps * scale, 'poison', 'beam', this.statusSource[i]!, this.statusWeapon[i]!);
    }
  }

  private spreadAndArc(s: number, t: Damageable, dt: number): void {
    if (this.isOn(s, BURN)) {
      const S = ELEMENTS.burn.spread;
      this.spreadTimer[s] = this.spreadTimer[s]! - dt;
      if (this.spreadTimer[s]! <= 0) {
        this.spreadTimer[s] = this.spreadTimer[s]! + S.interval;
        const i = s * NS + BURN;
        const n = this.nearest(t.boundsCenter, S.radius, t, S.maxTargets);
        for (let k = 0; k < n; k++) {
          this.addBuildup(this.picks[k]!, FIRE, S.amount, this.statusSource[i]!, this.statusWeapon[i]!);
        }
        this.picks.fill(STUB);
      }
    }
    if (this.isOn(s, SHOCKED)) {
      const A = ELEMENTS.shocked.arcs;
      this.arcTimer[s] = this.arcTimer[s]! - dt;
      if (this.arcTimer[s]! <= 0) {
        this.arcTimer[s] = this.arcTimer[s]! + A.interval;
        const i = s * NS + SHOCKED;
        const src = this.statusSource[i]!;
        const wpn = this.statusWeapon[i]!;
        this.arcFrom(t, A.count, A.range, A.damage * this.toughness[s]!, 'shock', SHOCK, A.buildup, src, wpn);
        this.picks.fill(STUB);
      }
    }
  }

  /** Lightning from `t` to its nearest enemies: damage (kind 'beam') + build-up of element `el`. */
  private arcFrom(
    t: Damageable,
    count: number,
    range: number,
    damage: number,
    element: DamageElement,
    el: number,
    buildup: number,
    src: Source,
    wpn: string,
  ): void {
    const n = this.nearest(t.aimPoint, range, t, count);
    for (let i = 0; i < n; i++) {
      const v = this.picks[i]!;
      this.stats.arcs++;
      if (this.arcs) {
        this.arcPoints[0]!.copy(t.aimPoint);
        this.arcPoints[1]!.copy(v.aimPoint);
        this.arcs.flash(this.arcPoints, 2);
      }
      this.deal(v, damage, element, 'beam', src, wpn);
      this.addBuildup(v, el, buildup, src, wpn);
    }
  }

  private areaDamage(
    center: Vector3,
    radius: number,
    damage: number,
    element: DamageElement,
    src: Source,
    wpn: string,
    exclude: Damageable,
  ): void {
    const list = this.combat.queryRadius(center, radius, this.query);
    const minF = ELEMENTS.combos.minFalloff;
    for (let i = 0; i < list.length; i++) {
      const v = list[i]!;
      if (v === exclude || !v.alive || v.team !== ELEMENTS.team) continue;
      const d = Math.max(0, v.boundsCenter.distanceTo(center) - v.boundsRadius);
      if (d > radius || !this.combat.lineOfSight(center, v.boundsCenter)) continue;
      const f = 1 - (1 - minF) * Math.min(1, d / Math.max(1e-6, radius));
      this.deal(v, damage * f, element, 'explosion', src, wpn);
    }
    list.length = 0;
  }

  /**
   * Up to `max` living enemies nearest to `center` within `range` (bounds surface) with line of
   * sight, excluding `exclude`, into `this.picks` (nearest first). Returns the count.
   */
  private nearest(center: Vec3Like, range: number, exclude: Damageable, max: number): number {
    const picks = this.picks;
    let count = 0;
    const want = Math.min(max, MAX_PICKS);
    if (want <= 0) return 0;
    _point.set(center.x, center.y, center.z);
    const list = this.combat.queryRadius(_point, range, this.query);
    const dist = this.pickDist;
    const n = Math.min(list.length, dist.length);
    for (let i = 0; i < n; i++) {
      const v = list[i]!;
      dist[i] =
        v === exclude || !v.alive || v.team !== ELEMENTS.team
          ? Number.POSITIVE_INFINITY
          : Math.max(0, v.boundsCenter.distanceTo(_point) - v.boundsRadius);
    }
    while (count < want) {
      let best = -1;
      for (let i = 0; i < n; i++) {
        if (dist[i]! <= range && (best < 0 || dist[i]! < dist[best]!)) best = i;
      }
      if (best < 0) break;
      const v = list[best]!;
      dist[best] = Number.POSITIVE_INFINITY;
      if (this.combat.lineOfSight(_point, v.boundsCenter)) picks[count++] = v;
    }
    list.length = 0;
    return count;
  }

  private deal(
    t: Damageable,
    amount: number,
    element: DamageElement,
    kind: ImpactKind,
    source: Source,
    weaponId: string,
  ): DamageResult {
    if (!t.alive || !(amount > 0) || !Number.isFinite(amount)) return NO_DAMAGE;
    const info = this.info;
    info.amount = amount;
    info.zone = 'body';
    copyVec(t.boundsCenter, info.point);
    info.direction.x = 0;
    info.direction.y = 1;
    info.direction.z = 0;
    info.weaponId = weaponId;
    info.element = element;
    info.source = source;
    info.kind = kind;
    info.impulse = 0;
    info.statusBuildup = 0;
    return this.combat.dealDamage(t, info);
  }

  // -------------------------------------------------------------------------
  // Deaths, particles, slots
  // -------------------------------------------------------------------------

  private onDeath(s: number, t: Damageable): void {
    const C = ELEMENTS.poisoned.cloud;
    const i = s * NS + POISONED;
    if (!this.isOn(s, POISONED) || this.stacks[i]! < C.minStacks || !this.fields) return;
    let free = -1;
    for (let k = 0; k < this.cloudEnds.length; k++) if (this.cloudEnds[k]! <= this.now) free = k;
    if (free < 0) return;
    const from = this.area;
    from.weaponId = this.statusWeapon[i]!;
    from.source = this.statusSource[i]!;
    from.statusBuildup = C.statusBuildup;
    from.areaScale = this.toughness[s]!;
    _center.copy(t.boundsCenter);
    if (this.fields.spawn(_center, C.field, from) > 0) {
      this.cloudEnds[free] = this.now + C.field.duration;
      this.stats.clouds++;
    }
  }

  private spawnParticles(dt: number): void {
    const vfx = this.vfx;
    const n = this.count;
    if (n === 0) return;
    const V = ELEMENTS.vfx;
    this.vfxBudget = V.perTick;
    const start = this.vfxCursor % n;
    for (let j = 0; j < n; j++) {
      const s = this.list[(start + j) % n]!;
      const t = this.targets[s]!;
      if (!t.alive) continue;
      for (let st = 0; st < NS; st++) {
        if (!this.isOn(s, st)) continue;
        const i = s * NS + st;
        this.vfxTimer[i] = this.vfxTimer[i]! - dt;
        if (this.vfxTimer[i]! > 0 || this.vfxBudget <= 0) continue;
        this.vfxBudget--;
        const id = STATUS_IDS[st]!;
        this.vfxTimer[i] = V.interval[id] * this.rng.range(0.7, 1.3);
        if (vfx) {
          this.surfacePoint(t, _point, _dir);
          const scale = Math.min(V.scale[1], Math.max(V.scale[0], t.boundsRadius / V.referenceRadius));
          vfx.spawn(PARTICLES[st]!, _point, _dir, scale);
        }
      }
    }
    this.vfxCursor = (start + 1) % n;
  }

  /** A random point on the target's body (hitbox surfaces) and the outward direction there. */
  private surfacePoint(t: Damageable, out: Vector3, dir: Vector3): void {
    const r = this.rng;
    const z = r.range(-1, 1);
    const a = r.next() * TAU;
    const h = Math.sqrt(Math.max(0, 1 - z * z));
    dir.set(h * Math.cos(a), z, h * Math.sin(a));
    const boxes = t.hitboxes;
    if (boxes.length === 0) {
      out.copy(t.boundsCenter).addScaledVector(dir, t.boundsRadius * 0.5);
      return;
    }
    const hb = boxes[Math.min(boxes.length - 1, Math.floor(r.next() * boxes.length))]!;
    if (hb.shape === 'capsule') out.lerpVectors(hb.a, hb.b, r.next());
    else out.copy(hb.a);
    out.addScaledVector(dir, hb.radius * ELEMENTS.vfx.surface);
  }

  /** A slot for `target` (taken on its first build-up); -1 when the pool is full. */
  private slotFor(target: Damageable): number {
    const known = this.slotOf.get(target.id);
    let s: number;
    if (known !== undefined) {
      if (this.targets[known] === target) return known;
      // The id moved on to another record (pooled enemies): the slot starts over in place.
      s = known;
    } else {
      if (this.freeTop === 0) {
        this.stats.refused++;
        return -1;
      }
      s = this.free[--this.freeTop]!;
      this.list[this.count++] = s;
      this.slotOf.set(target.id, s);
    }
    this.targets[s] = target;
    this.ids[s] = target.id;
    this.buildup.fill(0, s * NE, s * NE + NE);
    this.buildAt.fill(0, s * NE, s * NE + NE);
    this.time.fill(0, s * NS, s * NS + NS);
    this.stacks.fill(0, s * NS, s * NS + NS);
    this.vfxTimer.fill(0, s * NS, s * NS + NS);
    this.freezeImmune[s] = 0;
    this.stun[s] = 0;
    this.stunImmune[s] = 0;
    this.dotTimer[s] = 0;
    this.spreadTimer[s] = 0;
    this.arcTimer[s] = 0;
    this.voidCharge[s] = 0;
    this.ampTime[s] = 0;
    this.ampMult[s] = 1;
    this.comboCd[s] = 0;
    this.shatterHit[s] = 0;
    this.shatterHeavy[s] = 0;
    this.phase[s] = this.rng.next() * TAU;
    const out = this.profileOut;
    out.resist = STATUS_RESIST.default;
    out.healthScale = 1;
    if (this.profile && !this.profile(target, out)) {
      out.resist = STATUS_RESIST.default;
      out.healthScale = 1;
    }
    this.resist[s] = out.resist;
    this.toughness[s] = Number.isFinite(out.healthScale) && out.healthScale > 0 ? out.healthScale : 1;
    return s;
  }

  /** Nothing left to track: no status, build-up, charge, stun or running timer. */
  private idle(s: number): boolean {
    for (let st = 0; st < NS; st++) if (this.time[s * NS + st]! > 0) return false;
    for (let el = 0; el < NE; el++) if (this.buildup[s * NE + el]! > 0) return false;
    return !(
      this.voidCharge[s]! > 0 ||
      this.stun[s]! > 0 ||
      this.stunImmune[s]! > 0 ||
      this.freezeImmune[s]! > 0 ||
      this.comboCd[s]! > 0
    );
  }

  /** Return the slot at list index k (swap-remove). */
  private release(k: number): void {
    const s = this.list[k]!;
    const t = this.targets[s];
    if (t && this.slotOf.get(this.ids[s]!) === s) this.slotOf.delete(this.ids[s]!);
    this.targets[s] = null;
    this.list[k] = this.list[--this.count]!;
    this.free[this.freeTop++] = s;
    this.time.fill(0, s * NS, s * NS + NS);
    this.stacks.fill(0, s * NS, s * NS + NS);
  }

  private emitStatus(s: number, st: number): void {
    const t = this.targets[s];
    if (!t) return;
    const p = this.statusPayload;
    p.targetId = t.id;
    p.status = STATUS_IDS[st]!;
    p.stacks = this.stacks[s * NS + st]!;
    copyVec(t.boundsCenter, p.position);
    this.events.emit('combat:status', p);
  }
}

/** Particle preset per status index (defs/vfx status.<id>). */
const PARTICLES: readonly string[] = STATUS_IDS.map((id) => `status.${id}`);

/** Full duration of a status (voidrupture refresh). */
function baseDuration(st: number): number {
  switch (st) {
    case BURN:
      return ELEMENTS.burn.duration;
    case CHILL:
      return ELEMENTS.chill.duration;
    case SHOCKED:
      return ELEMENTS.shocked.duration;
    case POISONED:
      return ELEMENTS.poisoned.duration;
    default:
      return 0;
  }
}

/** Inert placeholder for the preallocated pick list. */
const STUB = { alive: false } as Damageable;

function copyVec(from: Vec3Like, to: Vec3Like): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}
