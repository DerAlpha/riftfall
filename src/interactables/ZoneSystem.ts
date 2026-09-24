/**
 * ZoneApi: which zones of a wave map are open. A run starts with the map's start zones
 * (ZONES.startZones); doors activate the zones they connect (zone:activated once per zone). The
 * WaveDirector spawns only in active zones (its `isZoneActive` dep).
 *
 * Maps without zone data (the calibration hall) are not gated: every zone counts as active.
 */
import type { LevelInstance, ZoneApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { createLogger } from '../core/log';
import { ZONES } from '../defs/interactables';
import { isMapLevel } from '../maps/types';

const log = createLogger('zones');

export interface ZoneSystemDeps {
  events: EventBus<GameEvents>;
  /** Zone ids of the map; null = not gated (everything active). */
  zones: readonly string[] | null;
  /** Active at the start of a run (unknown ids are ignored). */
  startZones: readonly string[];
}

export class ZoneSystem implements ZoneApi {
  private readonly events: EventBus<GameEvents>;
  private readonly known: ReadonlySet<string> | null;
  private readonly start: readonly string[];
  private readonly activeSet = new Set<string>();
  /** Cached list (rebuilt on change only). */
  private activeList: string[] = [];
  private readonly payload: GameEvents['zone:activated'] = { zone: '' };

  constructor(deps: ZoneSystemDeps) {
    this.events = deps.events;
    this.known = deps.zones ? new Set(deps.zones) : null;
    const start: string[] = [];
    for (const z of deps.startZones) {
      if (this.known && !this.known.has(z)) {
        log.warn(`Start zone "${z}" is not a zone of this map – ignored`);
        continue;
      }
      if (!start.includes(z)) start.push(z);
    }
    if (this.known && this.known.size > 0 && start.length === 0) {
      // A gated map without a valid start zone would never spawn: open everything instead.
      log.warn('No valid start zone – every zone starts active');
      start.push(...this.known);
    }
    this.start = start;
    this.reset();
  }

  /** Zone gating for a level: its zones and ZONES.startZones[level.id]; ungated without zones. */
  static forLevel(level: LevelInstance, events: EventBus<GameEvents>): ZoneSystem {
    if (!isMapLevel(level) || level.zones.length === 0) {
      return new ZoneSystem({ events, zones: null, startZones: [] });
    }
    return new ZoneSystem({
      events,
      zones: level.zones.map((z) => z.id),
      startZones: ZONES.startZones[level.id] ?? [],
    });
  }

  /** False on maps without zones (everything is active). */
  get gated(): boolean {
    return this.known !== null;
  }

  get active(): readonly string[] {
    return this.activeList;
  }

  isActive(zone: string): boolean {
    return this.known === null || this.activeSet.has(zone);
  }

  activate(zone: string): void {
    if (this.known === null || this.activeSet.has(zone)) return;
    if (!this.known.has(zone)) {
      log.warn(`Unknown zone "${zone}" – not activated`);
      return;
    }
    this.activeSet.add(zone);
    this.activeList = [...this.activeSet];
    this.payload.zone = zone;
    this.events.emit('zone:activated', this.payload);
  }

  /** New run: back to the start zones (no events). */
  reset(): void {
    this.activeSet.clear();
    for (const z of this.start) this.activeSet.add(z);
    this.activeList = [...this.activeSet];
  }
}
