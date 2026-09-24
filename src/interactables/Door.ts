/**
 * Purchasable door at a map DoorSlotDef (logic; visuals: visuals/DoorView.ts).
 *
 * closed → (purchase / open()) → opening → open. Opening activates both zones and emits
 * door:opened at once (spawns in the new zone start with the hydraulics); the passage becomes
 * passable – collider, bullet blocker and navmesh area removed – at DOORS.passableAt of the
 * animation. Bullet decals on the leaves vanish when they unseal, and again when the passage opens
 * (shots that hit the still solid blocker meanwhile would float in the doorway). reset() closes it
 * again for a new run (collider, bullets and nav blocked again).
 *
 * The door is usable from both sides: two Interactables (anchors in front of each face) share it.
 */
import { Vector3 } from 'three';
import type { EconomyApi, Interactable, ZoneApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { clamp01 } from '../core/math';
import { BLOCKERS, DOORS, INTERACTION } from '../defs/interactables';
import type { DoorSlotDef } from '../maps/types';
import { doorBulletBox, grownBox } from './shapes';
import type { BoxShape } from './SolidBlocker';
import type { DecalFader } from './types';

export type DoorState = 'closed' | 'opening' | 'open';

export interface DoorViewApi {
  /** Animation progress 0 (closed) … 1 (open), interpolated by the caller. */
  setOpenAmount(t: number): void;
  setState(state: DoorState): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

export interface DoorDeps {
  events: EventBus<GameEvents>;
  economy: Pick<EconomyApi, 'spend'>;
  zones: Pick<ZoneApi, 'activate'> | null;
  /** Collider + bullets + nav of the closed passage (SolidBlocker). */
  blocker: { setBlocked(blocked: boolean): void; dispose?(): void } | null;
  price: number;
  view?: DoorViewApi | null;
  /** Player-facing zone names (prompts say where a door leads); absent = plain prompt. */
  zoneName?: (zoneId: string) => string | null;
  /** Bullet decals on the leaves (removed as the door opens). */
  decals?: DecalFader | null;
}

class DoorSide implements Interactable {
  readonly range = INTERACTION.range.door;

  constructor(
    private readonly door: Door,
    readonly position: Vector3,
    /** Prompt of this side (names the zone behind the door). */
    private readonly text: string,
  ) {}

  get id(): string {
    return this.door.id;
  }

  prompt(): string {
    return this.door.state === 'closed' ? this.text : '';
  }

  cost(): number | null {
    return this.door.state === 'closed' ? this.door.price : null;
  }

  canInteract(): boolean {
    return this.door.state === 'closed';
  }

  holdTime(): number {
    return 0;
  }

  interact(): void {
    this.door.purchase();
  }
}

export class Door {
  readonly id: string;
  readonly slot: DoorSlotDef;
  readonly price: number;
  readonly promptText: string;
  /** Seconds of the hydraulic opening. */
  readonly duration: number;
  /** Zone A side and zone B side. */
  readonly sides: readonly [Interactable, Interactable];

  private _state: DoorState = 'closed';
  private t = 0;
  private prevT = 0;
  private passable = false;
  private readonly openedPayload: GameEvents['door:opened'];
  /** Where bullet decals of the closed leaves sit. */
  private readonly decalBox: BoxShape;

  constructor(
    slot: DoorSlotDef,
    private readonly deps: DoorDeps,
  ) {
    this.id = slot.id;
    this.slot = slot;
    this.price = deps.price;
    this.promptText = slot.blast ? DOORS.prompt.blast : DOORS.prompt.service;
    this.duration = slot.blast ? DOORS.blastOpenDuration : DOORS.openDuration;
    this.openedPayload = { doorId: slot.id, zones: [slot.zoneA, slot.zoneB] };
    this.decalBox = grownBox(doorBulletBox(slot), BLOCKERS.decalMargin);
    const nx = Math.sin(slot.yaw);
    const nz = Math.cos(slot.yaw);
    const a = DOORS.anchor;
    const p = slot.position;
    // Standing on the zone A side, the door leads into zone B (and vice versa).
    const sideText = (behind: string): string => {
      const name = deps.zoneName?.(behind) ?? null;
      return name
        ? DOORS.prompt.withZone.replace('{action}', this.promptText).replace('{zone}', name)
        : this.promptText;
    };
    this.sides = [
      new DoorSide(
        this,
        new Vector3(p.x - nx * a.offset, p.y + a.y, p.z - nz * a.offset),
        sideText(slot.zoneB),
      ),
      new DoorSide(
        this,
        new Vector3(p.x + nx * a.offset, p.y + a.y, p.z + nz * a.offset),
        sideText(slot.zoneA),
      ),
    ];
    deps.blocker?.setBlocked(true);
    deps.view?.setState('closed');
    deps.view?.setOpenAmount(0);
  }

  get state(): DoorState {
    return this._state;
  }

  /** Current opening progress 0..1 (tick value). */
  get openAmount(): number {
    return this.t;
  }

  /** The player buys the door: spend the price, then open. */
  purchase(): boolean {
    if (this._state !== 'closed') return false;
    if (!this.deps.economy.spend(this.price, this.id, 'door')) return false;
    return this.open();
  }

  /** Open without paying (dev console, scripted events). False when not closed. */
  open(): boolean {
    if (this._state !== 'closed') return false;
    this._state = 'opening';
    this.t = 0;
    this.prevT = 0;
    const zones = this.deps.zones;
    if (zones) {
      zones.activate(this.slot.zoneA);
      zones.activate(this.slot.zoneB);
    }
    this.deps.view?.setState('opening');
    this.clearDecals();
    this.deps.events.emit('door:opened', this.openedPayload);
    return true;
  }

  fixedUpdate(dt: number): void {
    this.prevT = this.t;
    if (this._state !== 'opening' || !(dt > 0)) return;
    this.t = clamp01(this.t + dt / this.duration);
    if (!this.passable && (this.t >= DOORS.passableAt || this.t >= 1)) {
      this.passable = true;
      this.deps.blocker?.setBlocked(false);
      this.clearDecals();
    }
    if (this.t >= 1) {
      this._state = 'open';
      this.deps.view?.setState('open');
    }
  }

  /** Visuals (per frame): interpolate the opening between the last two ticks. */
  update(dt: number, alpha: number, time: number): void {
    const view = this.deps.view;
    if (!view) return;
    view.setOpenAmount(this.prevT + (this.t - this.prevT) * clamp01(alpha));
    view.update(dt, time);
  }

  /** New run: closed and solid again. */
  reset(): void {
    this._state = 'closed';
    this.t = 0;
    this.prevT = 0;
    this.passable = false;
    this.deps.blocker?.setBlocked(true);
    this.deps.view?.setState('closed');
    this.deps.view?.setOpenAmount(0);
  }

  dispose(): void {
    this.deps.blocker?.dispose?.();
    this.deps.view?.dispose();
  }

  private clearDecals(): void {
    this.deps.decals?.fadeInBox(this.decalBox.center, this.decalBox.half);
  }
}
