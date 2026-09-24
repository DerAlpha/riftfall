/**
 * Base of every trap kind: the activation timer (TrapTimer), the purchase through the panel, the
 * shared damage path (CombatWorld, source 'trap', weapon id `trap:<kind>`: no points; kills are
 * counted per trap and for the run), state events and the positional loop. Kinds implement the
 * active tick (damage) and their visuals.
 */
import { Vector3 } from 'three';
import type {
  DamageInfo,
  DamageResult,
  Damageable,
  EconomyApi,
  TrapReadout,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { DamageElement, GameEvents, HitZone, ImpactKind, Vec3Like } from '../core/events';
import type { Rng } from '../core/Rng';
import { TRAPS, trapTiming, type TrapKind, type TrapSlotDef, type TrapState } from '../defs/traps';
import {
  PositionalLoop,
  type KitAudio,
  type KitBlockers,
  type KitCombat,
  type KitPlayer,
  type KitVfx,
  type KitVisuals,
} from '../maps/kit/kitTypes';
import type { PropBuilder } from '../maps/kit/PropBuilder';
import { TrapPanel, type TrapPanelOwner } from './TrapPanel';
import { TrapTimer } from './trapMath';

/** Shared by every trap of a map (TrapSystem builds it). */
export interface TrapContext {
  readonly events: EventBus<GameEvents>;
  readonly combat: KitCombat;
  readonly player: KitPlayer | null;
  readonly vfx: KitVfx | null;
  readonly audio: KitAudio | null;
  /** Seeded gameplay randomness (turret spread). */
  /** Replaced on a run reset (TrapSystem.reset(seed)). */
  rng: Rng;
  readonly power: { readonly powered: boolean };
  readonly economy: Pick<EconomyApi, 'spend'>;
  readonly visuals: KitVisuals | null;
  /** Static bodies of every trap, merged per material (null without visuals). */
  readonly props: PropBuilder | null;
  /** Solid trap bodies (fan housings); null = nothing solid. */
  readonly blockers: KitBlockers | null;
  /** A trap killed something (run stats). */
  onKill(trap: Trap, target: Damageable): void;
}

const _info: DamageInfo = {
  amount: 0,
  zone: 'body',
  point: { x: 0, y: 0, z: 0 },
  direction: { x: 0, y: 0, z: 1 },
  weaponId: '',
  element: 'physical',
  source: 'trap',
  kind: 'bullet',
  impulse: 0,
  statusBuildup: 0,
};

/** Shared enemy query buffer (fixed tick only; never kept across calls). */
export const TRAP_QUERY: Damageable[] = [];

export abstract class Trap implements TrapPanelOwner, TrapReadout {
  readonly id: string;
  readonly kind: TrapKind;
  readonly name: string;
  readonly price: number;
  readonly weaponId: string;
  readonly timer: TrapTimer;
  readonly panel: TrapPanel;
  /** Sound / event anchor. */
  readonly center = new Vector3();
  kills = 0;
  /** Seconds since the activation (active phase). */
  protected activeTime = 0;
  protected readonly loop: PositionalLoop;
  private readonly statePayload: GameEvents['trap:state'];

  constructor(
    readonly slot: TrapSlotDef,
    protected readonly ctx: TrapContext,
    center: Vec3Like,
  ) {
    this.id = slot.id;
    this.kind = slot.kind;
    this.name = TRAPS[slot.kind].name;
    const timing = trapTiming(slot);
    this.price = timing.price;
    this.timer = new TrapTimer(timing.duration, timing.cooldown);
    this.weaponId = `${TRAPS.weaponPrefix}${slot.kind}`;
    this.center.set(center.x, center.y, center.z);
    this.panel = new TrapPanel(this, slot, ctx.visuals, ctx.props);
    const A = TRAPS[slot.kind].audio;
    this.loop = new PositionalLoop(ctx.audio, A.loop, A.loopGain, this.center, TRAPS.loopDistance);
    this.statePayload = { trapId: this.id, kind: this.kind, state: 'ready', position: this.center };
  }

  get state(): TrapState {
    return this.timer.state;
  }

  get remaining(): number {
    return this.timer.remaining;
  }

  get progress(): number {
    return this.timer.progress;
  }

  get powered(): boolean {
    return this.ctx.power.powered;
  }

  /** Panel purchase: pay, then start (the power must be on). */
  purchase(): boolean {
    if (this.state !== 'ready' || !this.powered) return false;
    if (!this.ctx.economy.spend(this.price, this.weaponId, 'other')) return false;
    return this.activate();
  }

  /** Start without paying (dev console, quests); false unless ready. */
  activate(): boolean {
    if (!this.timer.start()) return false;
    this.activeTime = 0;
    this.onActivate();
    this.ctx.audio?.play(TRAPS[this.kind].audio.activate, { position: this.center, bus: 'sfx' });
    this.emitState();
    return true;
  }

  fixedUpdate(dt: number): void {
    if (this.state === 'active') {
      this.activeTime += dt;
      this.tickActive(dt);
    }
    const changed = this.timer.tick(dt);
    if (changed === null) return;
    if (changed === 'cooldown' || (changed === 'ready' && this.activeTime > 0)) this.onDeactivate();
    if (changed === 'ready') this.activeTime = 0;
    this.emitState();
  }

  update(dt: number, time: number, listener: Vec3Like | null, reduceFlashing: boolean): void {
    this.panel.update(dt, time, reduceFlashing);
    this.updateVisual(dt, time, reduceFlashing);
    this.loop.update(this.state === 'active', listener);
  }

  /** New run: ready, no kills, effects off. */
  reset(): void {
    const wasActive = this.state === 'active';
    this.timer.reset();
    this.kills = 0;
    this.activeTime = 0;
    if (wasActive) this.onDeactivate();
    this.onReset();
    this.loop.stop(0);
  }

  dispose(): void {
    this.loop.stop(0);
    this.panel.dispose();
    this.disposeVisuals();
  }

  /** Enemies (team 'enemy', alive) whose bounds meet the sphere – into TRAP_QUERY. */
  protected queryEnemies(center: Vec3Like, radius: number): Damageable[] {
    const out = this.ctx.combat.queryRadius(center, radius, TRAP_QUERY);
    let n = 0;
    for (let i = 0; i < out.length; i++) {
      const t = out[i]!;
      if (t.alive && t.team === 'enemy') out[n++] = t;
    }
    out.length = n;
    return out;
  }

  /** Damage through CombatWorld (source 'trap'); counts kills. `dir` is the push direction. */
  protected hurt(
    target: Damageable,
    amount: number,
    element: DamageElement,
    kind: ImpactKind,
    point: Vec3Like,
    dirX: number,
    dirY: number,
    dirZ: number,
    impulse = 0,
    buildup = 0,
    zone: HitZone = 'body',
  ): DamageResult {
    const i = _info;
    i.amount = amount;
    i.zone = zone;
    i.point.x = point.x;
    i.point.y = point.y;
    i.point.z = point.z;
    const len = Math.hypot(dirX, dirY, dirZ);
    i.direction.x = len > 1e-6 ? dirX / len : 0;
    i.direction.y = len > 1e-6 ? dirY / len : 0;
    i.direction.z = len > 1e-6 ? dirZ / len : 1;
    i.weaponId = this.weaponId;
    i.element = element;
    i.kind = kind;
    i.impulse = impulse;
    i.statusBuildup = buildup;
    const res = this.ctx.combat.dealDamage(target, i);
    if (res.killed) {
      this.kills++;
      this.ctx.onKill(this, target);
    }
    return res;
  }

  protected shake(trauma: number): void {
    this.ctx.events.emit('camera:shake', { trauma });
  }

  private emitState(): void {
    this.statePayload.state = this.state;
    this.ctx.events.emit('trap:state', this.statePayload);
  }

  /** Active tick: damage (fixed tick, after the enemies moved). */
  protected abstract tickActive(dt: number): void;
  protected abstract onActivate(): void;
  protected abstract onDeactivate(): void;
  protected onReset(): void {}
  protected abstract updateVisual(dt: number, time: number, reduceFlashing: boolean): void;
  protected abstract disposeVisuals(): void;
}
