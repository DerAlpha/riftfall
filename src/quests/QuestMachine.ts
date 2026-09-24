/**
 * The quest step machine (pure logic, no three.js): the current step of a QuestDef and its
 * progress. The QuestSystem feeds it what happened (a target shot, an item collected, an object
 * used, a kill, a trap activation, the player's position for defend steps); the machine advances
 * and reports step changes / completion to its listener. Progress resets with reset() (new run).
 */
import type { DamageElement, Vec3Like } from '../core/events';
import type { QuestDef, QuestStepDef, QuestVolumeDef } from '../defs/quests';

export interface QuestKill {
  /** Kill position (hit point / body). */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Map zone at the position (null: unknown). */
  readonly zone: string | null;
  readonly element: DamageElement | null;
  readonly weapon: string | null;
  readonly enemy: string | null;
}

export interface QuestListener {
  /** Step `index` began (not called for the first step at start / reset). */
  onStep?(index: number, step: QuestStepDef): void;
  onComplete?(): void;
  /** A counted action inside a step (a target, an item, an object, a kill) – cues. */
  onProgress?(index: number, step: QuestStepDef): void;
}

export function inVolume(v: QuestVolumeDef, x: number, y: number, z: number): boolean {
  if ('radius' in v) return Math.hypot(x - v.center[0], y - v.center[1], z - v.center[2]) <= v.radius;
  return x >= v.min[0] && x <= v.max[0] && y >= v.min[1] && y <= v.max[1] && z >= v.min[2] && z <= v.max[2];
}

export class QuestMachine {
  private _step = 0;
  /** Per element of the current step: done (targets, items, objects). */
  private done: Uint8Array = new Uint8Array(0);
  private orderCursor = 0;
  private count = 0;
  private defendTime = 0;
  private outside = 0;
  private _carrying: string | null = null;

  constructor(
    readonly def: QuestDef,
    private readonly listener: QuestListener = {},
  ) {
    this.enter(0);
  }

  get step(): number {
    return this._step;
  }

  get steps(): number {
    return this.def.steps.length;
  }

  get completed(): boolean {
    return this._step >= this.def.steps.length;
  }

  get current(): QuestStepDef | null {
    return this.def.steps[this._step] ?? null;
  }

  /** Item the player carries (collect → interact). */
  get carrying(): string | null {
    return this._carrying;
  }

  /** 0..1 progress of the current step. */
  get progress(): number {
    const s = this.current;
    if (!s) return 1;
    switch (s.kind) {
      case 'shoot':
      case 'collect':
      case 'interact':
        return this.done.length > 0 ? this.countDone() / this.done.length : 1;
      case 'kill':
      case 'trap':
        return s.count > 0 ? Math.min(1, this.count / s.count) : 1;
      case 'defend':
        return s.duration > 0 ? Math.min(1, this.defendTime / s.duration) : 1;
    }
  }

  /** Is element `i` of the current step still open (targets / items / objects)? */
  isOpen(i: number): boolean {
    return i >= 0 && i < this.done.length && this.done[i] === 0;
  }

  /** A hidden target of the current shoot step was hit; true when it counted. */
  targetHit(targetId: string): boolean {
    const s = this.current;
    if (!s || s.kind !== 'shoot') return false;
    const i = s.targets.findIndex((t) => t.id === targetId);
    if (i < 0 || this.done[i] === 1) return false;
    if (s.ordered && i !== this.orderCursor) {
      // Out of order: the order starts over (the hits stay).
      this.orderCursor = 0;
      return false;
    }
    this.done[i] = 1;
    if (s.ordered) this.orderCursor = i + 1;
    this.progressed();
    if (this.countDone() >= s.targets.length) this.next();
    return true;
  }

  itemCollected(itemId: string): boolean {
    const s = this.current;
    if (!s || s.kind !== 'collect') return false;
    const i = s.items.findIndex((t) => t.id === itemId);
    if (i < 0 || this.done[i] === 1) return false;
    this.done[i] = 1;
    this.progressed();
    if (this.countDone() >= s.items.length) {
      this._carrying = s.carry;
      this.next();
    }
    return true;
  }

  /** Does the current step want this object used now (prompt shown)? */
  wantsObject(objectId: string): boolean {
    const s = this.current;
    if (!s || s.kind !== 'interact') return false;
    const i = s.objects.findIndex((o) => o.id === objectId);
    if (i < 0 || this.done[i] === 1) return false;
    if (s.requires && this._carrying !== s.requires) return false;
    return !s.ordered || i === this.orderCursor;
  }

  objectUsed(objectId: string): boolean {
    if (!this.wantsObject(objectId)) return false;
    const s = this.current as Extract<QuestStepDef, { kind: 'interact' }>;
    const i = s.objects.findIndex((o) => o.id === objectId);
    this.done[i] = 1;
    this.orderCursor = i + 1;
    this.progressed();
    if (this.countDone() >= s.objects.length) {
      if (s.requires && this._carrying === s.requires) this._carrying = null;
      this.next();
    }
    return true;
  }

  onKill(k: QuestKill): void {
    const s = this.current;
    if (!s || s.kind !== 'kill') return;
    if (s.zone !== undefined && k.zone !== s.zone) return;
    if (s.element !== undefined && k.element !== s.element) return;
    if (s.weapon !== undefined && k.weapon !== s.weapon) return;
    if (s.enemy !== undefined && k.enemy !== s.enemy) return;
    if (s.volume && !inVolume(s.volume, k.x, k.y, k.z)) return;
    this.count++;
    this.progressed();
    if (this.count >= s.count) this.next();
  }

  onTrapActivated(trapId: string): void {
    const s = this.current;
    if (!s || s.kind !== 'trap') return;
    if (s.traps && !s.traps.includes(trapId)) return;
    this.count++;
    this.progressed();
    if (this.count >= s.count) this.next();
  }

  /** Fixed tick: defend steps hold / drain with the player's feet position. */
  tick(dt: number, player: Vec3Like | null): void {
    const s = this.current;
    if (!s || s.kind !== 'defend' || !(dt > 0)) return;
    const inside =
      player !== null && Math.hypot(player.x - s.point[0], player.z - s.point[2]) <= s.radius;
    if (inside) {
      this.outside = 0;
      this.defendTime += dt;
    } else {
      this.outside += dt;
      if (this.outside > s.grace) this.defendTime = Math.max(0, this.defendTime - s.decay * dt);
    }
    if (this.defendTime >= s.duration) this.next();
  }

  /** The player is inside the defend radius (visual cue). */
  defending(player: Vec3Like | null): boolean {
    const s = this.current;
    return (
      s !== null &&
      s.kind === 'defend' &&
      player !== null &&
      Math.hypot(player.x - s.point[0], player.z - s.point[2]) <= s.radius
    );
  }

  /** Dev console: finish the current step (a collect step hands its item over). */
  advance(): boolean {
    const s = this.current;
    if (!s) return false;
    if (s.kind === 'collect') this._carrying = s.carry;
    if (s.kind === 'interact' && s.requires && this._carrying === s.requires) this._carrying = null;
    this.next();
    return true;
  }

  /** Dev console: finish every remaining step. */
  complete(): void {
    let guard = this.def.steps.length + 1;
    while (!this.completed && guard-- > 0) this.advance();
  }

  reset(): void {
    this._carrying = null;
    this.enter(0);
  }

  private next(): void {
    const index = this._step + 1;
    this.enter(index);
    if (index >= this.def.steps.length) {
      this.listener.onComplete?.();
      return;
    }
    this.listener.onStep?.(index, this.def.steps[index]!);
  }

  private enter(index: number): void {
    this._step = Math.min(index, this.def.steps.length);
    const s = this.def.steps[this._step];
    const n = !s ? 0 : s.kind === 'shoot' ? s.targets.length : s.kind === 'collect' ? s.items.length : s.kind === 'interact' ? s.objects.length : 0;
    this.done = new Uint8Array(n);
    this.orderCursor = 0;
    this.count = 0;
    this.defendTime = 0;
    this.outside = 0;
  }

  private progressed(): void {
    const s = this.current;
    if (s) this.listener.onProgress?.(this._step, s);
  }

  private countDone(): number {
    let n = 0;
    for (let i = 0; i < this.done.length; i++) n += this.done[i]!;
    return n;
  }
}
