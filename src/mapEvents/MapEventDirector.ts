/**
 * Map event director (MapEventApi, M7): starts the map's data-driven events (defs/mapEvents.ts;
 * the level's `eventDefs` first) – by wave number (forced waves), by chance per wave start (seeded
 * run rng), or when a quest step begins – and runs them:
 *
 * - POWER OUTAGE: PowerGrid.setPowered(false) (lights to emergency red, machines dark, purchases
 *   refused) until the player restarts a generator in an open zone (hold interact). Not started when
 *   no generator is reachable (every generator behind closed doors).
 * - ENEMY INVASION: `count` extra enemies over `spread` s from every open rift (round robin, the
 *   wave's health / speed / damage multipliers, seals breached like any spawn), alarm + banner.
 *   They count towards the wave (it waits for them).
 * - GRAVITY ANOMALY: a temporary low-g sphere in GravityZones (fades in / out) at an open zone's
 *   point (else around the player), floating debris, a hum at the center.
 *
 * Rolled events never overlap (EVENT_DIRECTOR.maxConcurrent) and wait EVENT_DIRECTOR.minGap after
 * the previous one; quest-step events start regardless. Everything ends / resets on reset() (run
 * restart): power back on at once, anomalies gone, pending starts dropped, rng reseeded.
 */
import { Vector3 } from 'three';
import type {
  EnemySpawnOptions,
  InteractionApi,
  MapEventApi,
  SpawnPointDef,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { Rng } from '../core/Rng';
import {
  EVENT_DIRECTOR,
  GRAVITY,
  INVASION,
  POWER,
  type GeneratorSpotDef,
  type GravityAnomalyEventDef,
  type InvasionEventDef,
  type MapEventDef,
  type PowerOutageEventDef,
} from '../defs/mapEvents';
import type { GravityZones } from '../maps/kit/GravityZones';
import { PositionalLoop, type KitAudio, type KitBanner, type KitPlayer, type KitVfx, type KitVisuals } from '../maps/kit/kitTypes';
import type { PowerGrid } from '../maps/kit/PowerGrid';
import { PropBuilder } from '../maps/kit/PropBuilder';
import { AnomalyView } from './AnomalyView';
import { GeneratorPanel } from './GeneratorPanel';

const log = createLogger('mapEvents');

export interface MapEventDirectorDeps {
  defs: readonly MapEventDef[];
  generators: readonly GeneratorSpotDef[];
  events: EventBus<GameEvents>;
  power: PowerGrid;
  gravity: GravityZones;
  enemies: {
    spawn(type: string, position: Vec3Like, opts?: EnemySpawnOptions): number | null;
  };
  /** The wave director: current wave, state, the wave's multipliers. */
  waves: {
    readonly wave: number;
    readonly state: string;
    readonly plan?: { readonly health: number; readonly speed: number; readonly damage: number };
  };
  spawnPoints: readonly SpawnPointDef[];
  isZoneActive(zone: string): boolean;
  zoneName(zone: string): string;
  player: KitPlayer | null;
  interaction: Pick<InteractionApi, 'register' | 'unregister'> & { readonly focused?: unknown; readonly holdProgress?: number };
  /** Known enemy type (defs/enemies)? */
  isKnownType(type: string): boolean;
  audio?: KitAudio | null;
  vfx?: KitVfx | null;
  banner?: KitBanner | null;
  /** Screen-space shockwave (RenderApi.addShockwave). */
  shockwave?: ((position: Vec3Like, radius: number, strength: number) => void) | null;
  visuals?: KitVisuals | null;
  seed?: string | number;
}

interface Runner {
  readonly def: MapEventDef;
  /** Seconds since the start. */
  time: number;
  done: boolean;
}

interface OutageRunner extends Runner {
  readonly def: PowerOutageEventDef;
  generator: GeneratorPanel;
}

interface InvasionRunner extends Runner {
  readonly def: InvasionEventDef;
  total: number;
  spawned: number;
  failures: number;
  pointCursor: number;
  nextAt: number;
  alarms: number;
  nextAlarm: number;
}

interface AnomalyRunner extends Runner {
  readonly def: GravityAnomalyEventDef;
  handle: number;
  center: Vector3;
  ending: boolean;
}

type AnyRunner = OutageRunner | InvasionRunner | AnomalyRunner;

const _pos = new Vector3();
const UP = { x: 0, y: 1, z: 0 };

export class MapEventDirector implements MapEventApi {
  readonly generators: readonly GeneratorPanel[];
  private readonly defs: readonly MapEventDef[];
  private rng: Rng;
  private readonly runners: AnyRunner[] = [];
  private readonly activeIds: string[] = [];
  /** Wave number before which a def may not roll again (by def index). */
  private readonly cooldownUntil: Int32Array;
  private pending: { def: MapEventDef; left: number } | null = null;
  /** Seconds since the last rolled event ended (gap rule). */
  private sinceEnd = Number.POSITIVE_INFINITY;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly anomaly: AnomalyView | null;
  private readonly anomalyLoop: PositionalLoop | null;
  private readonly anomalyCenter = new Vector3();
  private readonly alarmLoops: PositionalLoop[] = [];
  private readonly startPayload: GameEvents['mapEvent:started'] = {
    eventId: '',
    kind: '',
    position: null,
    duration: 0,
  };
  private readonly endPayload: GameEvents['mapEvent:ended'] = { eventId: '', kind: '' };
  private readonly spawnOpts: EnemySpawnOptions = {};
  private readonly points: SpawnPointDef[] = [];
  private time = 0;

  constructor(private readonly deps: MapEventDirectorDeps) {
    this.rng = new Rng(`mapEvents:${deps.seed ?? 'default'}`);
    this.defs = deps.defs.filter((d) => this.validate(d));
    this.cooldownUntil = new Int32Array(this.defs.length);
    const v = deps.visuals ?? null;
    const props = v ? new PropBuilder() : null;
    this.generators = deps.generators.map((g) => new GeneratorPanel(g, v, props, deps.audio ?? null));
    for (const g of this.generators) {
      deps.interaction.register(g);
      this.alarmLoops.push(
        new PositionalLoop(deps.audio ?? null, POWER.audio.alarm, POWER.audio.alarmGain, g.position, POWER.audio.alarmDistance),
      );
    }
    if (props && v) {
      props.meshes((k) => v.materials.get(k), v.root, true);
      props.dispose();
    }
    this.anomaly = v && this.defs.some((d) => d.kind === 'gravityAnomaly') ? new AnomalyView(v) : null;
    const G = GRAVITY.anomaly;
    this.anomalyLoop = deps.audio
      ? new PositionalLoop(deps.audio, G.audio.loop, G.loopGain, this.anomalyCenter, G.loopDistance)
      : null;
    const ev = deps.events;
    this.unsubscribe.push(
      ev.on('wave:start', (e) => this.onWaveStart(e.wave)),
      ev.on('quest:step', (e) => this.onQuestStep(e.stepId)),
    );
    if (this.defs.length > 0) log.info(`Map events: ${this.defs.map((d) => `${d.id} (${d.kind})`).join(', ')}`);
  }

  get active(): readonly string[] {
    return this.activeIds;
  }

  get list(): readonly MapEventDef[] {
    return this.defs;
  }

  /** Scheduled rolled event (id, seconds left) – dev console. */
  get pendingInfo(): { id: string; left: number } | null {
    return this.pending ? { id: this.pending.def.id, left: this.pending.left } : null;
  }

  get hasVolumetricContent(): boolean {
    return this.generators.length > 0 || (this.anomaly?.visible ?? false);
  }

  trigger(id: string): boolean {
    const def = this.defs.find((d) => d.id === id);
    if (!def) return false;
    return this.start(def, true);
  }

  stop(): void {
    for (const r of [...this.runners]) this.finish(r, true);
    this.pending = null;
  }

  fixedUpdate(dt: number): void {
    if (!(dt > 0)) return;
    this.time += dt;
    if (this.runners.length === 0) this.sinceEnd += dt;
    const p = this.pending;
    if (p) {
      p.left -= dt;
      if (p.left <= 0) {
        this.pending = null;
        const waveOk = !EVENT_DIRECTOR.wavesOnly || this.deps.waves.state === 'active';
        if (waveOk && (this.deps.player?.alive ?? true)) this.start(p.def, false);
      }
    }
    for (let i = this.runners.length - 1; i >= 0; i--) {
      const r = this.runners[i]!;
      r.time += dt;
      if (r.def.kind === 'invasion') this.tickInvasion(r as InvasionRunner);
      else if (r.def.kind === 'gravityAnomaly') this.tickAnomaly(r as AnomalyRunner);
      if (r.done) this.finish(r, false);
    }
  }

  /** Per frame: generator looks, anomaly visuals, loops. `listener`: the camera. */
  update(dt: number, listener: Vec3Like | null = null): void {
    const focused = this.deps.interaction.focused;
    const holdProgress = this.deps.interaction.holdProgress ?? 0;
    const reduced = this.deps.visuals?.reduceFlashing ?? false;
    for (let i = 0; i < this.generators.length; i++) {
      const g = this.generators[i]!;
      g.update(dt, this.time, focused === g && holdProgress > 0, reduced);
      this.alarmLoops[i]!.update(g.alarm, listener);
    }
    const a = this.runners.find((r) => r.def.kind === 'gravityAnomaly') as AnomalyRunner | undefined;
    if (this.anomaly) {
      const strength = a ? this.anomalyStrength(a) : 0;
      this.anomaly.update(dt, strength);
    }
    this.anomalyLoop?.update(a !== undefined && !a.ending, listener);
  }

  reset(seed?: string | number): void {
    for (const r of [...this.runners]) this.finish(r, true);
    this.runners.length = 0;
    this.activeIds.length = 0;
    this.pending = null;
    this.sinceEnd = Number.POSITIVE_INFINITY;
    this.cooldownUntil.fill(0);
    if (seed !== undefined) this.rng = new Rng(`mapEvents:${seed}`);
    for (const g of this.generators) g.alarm = false;
    for (const l of this.alarmLoops) l.stop(0);
    this.anomalyLoop?.stop(0);
    this.anomaly?.clear();
    this.deps.gravity.clearTemporary();
    this.deps.power.reset();
  }

  setReducedFlashing(reduced: boolean): void {
    if (this.deps.visuals) this.deps.visuals.reduceFlashing = reduced;
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    for (const g of this.generators) {
      this.deps.interaction.unregister(g);
      g.dispose();
    }
    for (const l of this.alarmLoops) l.stop(0);
    this.anomalyLoop?.stop(0);
    this.anomaly?.dispose();
  }

  // -------------------------------------------------------------------------
  // Triggers
  // -------------------------------------------------------------------------

  private onWaveStart(wave: number): void {
    const n = this.defs.length;
    if (n === 0 || this.pending) return;
    const rolled = this.runners.some((r) => !this.isQuestOnly(r.def));
    if (rolled && this.runners.length >= EVENT_DIRECTOR.maxConcurrent) return;
    if (this.sinceEnd < EVENT_DIRECTOR.minGap) return;
    // Forced waves first, then one chance roll per def (rotating start: no order bias).
    let pick = -1;
    for (let i = 0; i < n && pick < 0; i++) {
      const t = this.defs[i]!.trigger;
      if (t.waves?.includes(wave) && this.eligible(i, wave, true)) pick = i;
    }
    if (pick < 0) {
      const offset = this.rng.int(0, n - 1);
      for (let k = 0; k < n && pick < 0; k++) {
        const i = (k + offset) % n;
        const t = this.defs[i]!.trigger;
        if (!(t.chance > 0) || !this.eligible(i, wave, false)) continue;
        if (this.rng.next() < t.chance) pick = i;
      }
    }
    if (pick < 0) return;
    const def = this.defs[pick]!;
    const [a, b] = def.trigger.delay;
    this.pending = { def, left: a + this.rng.next() * Math.max(0, b - a) };
    this.cooldownUntil[pick] = wave + 1 + def.trigger.cooldownWaves;
  }

  private eligible(i: number, wave: number, forced: boolean): boolean {
    const def = this.defs[i]!;
    const t = def.trigger;
    if (this.activeIds.includes(def.id)) return false;
    if (!forced) {
      if (wave < t.minWave || (t.maxWave !== undefined && wave > t.maxWave)) return false;
      if (wave < this.cooldownUntil[i]!) return false;
    }
    return this.canStart(def);
  }

  private onQuestStep(stepId: string): void {
    for (const def of this.defs) {
      if (def.trigger.questStep === stepId) this.start(def, true);
    }
  }

  private isQuestOnly(def: MapEventDef): boolean {
    return def.trigger.chance <= 0 && !def.trigger.waves && def.trigger.questStep !== undefined;
  }

  /** Requirements beyond the trigger: a reachable generator, open rifts. */
  private canStart(def: MapEventDef): boolean {
    if (this.activeIds.includes(def.id)) return false;
    switch (def.kind) {
      case 'powerOutage':
        return this.deps.power.powered && this.pickGenerator(def) !== null;
      case 'invasion':
        return this.collectPoints() > 0;
      case 'gravityAnomaly':
        return !this.runners.some((r) => r.def.kind === 'gravityAnomaly');
    }
  }

  // -------------------------------------------------------------------------
  // Runners
  // -------------------------------------------------------------------------

  private start(def: MapEventDef, forced: boolean): boolean {
    if (!this.canStart(def)) {
      if (forced) log.info(`Map event "${def.id}" cannot start now`);
      return false;
    }
    let runner: AnyRunner | null = null;
    let position: Vec3Like | null = null;
    let duration = 0;
    switch (def.kind) {
      case 'powerOutage': {
        const gen = this.pickGenerator(def)!;
        runner = { def, time: 0, done: false, generator: gen };
        gen.alarm = true;
        gen.onRestore(() => {
          runner!.done = true;
        });
        this.deps.power.setPowered(false);
        this.deps.audio?.play(POWER.audio.down, { volume: POWER.audio.downGain, bus: 'sfx' });
        const B = POWER.banners.outage;
        this.deps.banner?.(B.kicker, B.title, B.sub.replace('{zone}', this.deps.zoneName(gen.spot.zone)), POWER.banners.color, POWER.banners.seconds);
        position = gen.position;
        break;
      }
      case 'invasion': {
        const wave = Math.max(1, this.deps.waves.wave);
        const total = Math.min(def.count.max, Math.round(def.count.base + def.count.perWave * wave));
        const r: InvasionRunner = {
          def,
          time: 0,
          done: false,
          total,
          spawned: 0,
          failures: 0,
          pointCursor: this.rng.int(0, Math.max(0, this.points.length - 1)),
          nextAt: 0,
          alarms: 0,
          nextAlarm: 0,
        };
        runner = r;
        const B = INVASION.banner;
        this.deps.banner?.(B.kicker, B.title, B.sub, B.color, INVASION.bannerSeconds);
        this.deps.events.emit('camera:shake', { trauma: INVASION.shake });
        duration = def.spread;
        break;
      }
      case 'gravityAnomaly': {
        const center = this.pickAnomalyCenter(def);
        const handle = this.deps.gravity.add(
          { id: def.id, shape: 'sphere', center: [center.x, center.y, center.z], radius: def.radius, scale: def.scale },
          0,
        );
        if (handle === 0) return false;
        runner = { def, time: 0, done: false, handle, center: center.clone(), ending: false };
        const G = GRAVITY.anomaly;
        this.anomalyCenter.copy(center).setY(center.y + G.soundLift);
        this.anomaly?.begin(center, def.radius);
        this.deps.vfx?.spawn(G.startEffect, this.anomalyCenter, UP, G.startEffectScale);
        this.deps.audio?.play(G.audio.start, { position: this.anomalyCenter, volume: G.startGain, bus: 'sfx' });
        this.deps.shockwave?.(center, def.radius, G.shockwave);
        this.deps.events.emit('camera:shake', { trauma: G.shake });
        this.deps.banner?.(G.banner.kicker, G.banner.title, G.banner.sub, G.banner.color, G.bannerSeconds);
        position = center;
        duration = def.duration;
        break;
      }
    }
    if (!runner) return false;
    this.runners.push(runner);
    this.activeIds.push(def.id);
    const p = this.startPayload;
    p.eventId = def.id;
    p.kind = def.kind;
    p.position = position;
    p.duration = duration;
    this.deps.events.emit('mapEvent:started', p);
    log.info(`Map event started: ${def.id} (${def.kind})`);
    return true;
  }

  private finish(r: AnyRunner, silent: boolean): void {
    const i = this.runners.indexOf(r);
    if (i < 0) return;
    this.runners.splice(i, 1);
    const k = this.activeIds.indexOf(r.def.id);
    if (k >= 0) this.activeIds.splice(k, 1);
    switch (r.def.kind) {
      case 'powerOutage': {
        const o = r as OutageRunner;
        o.generator.alarm = false;
        o.generator.onRestore(null);
        if (!silent) {
          this.deps.power.setPowered(true);
          this.deps.audio?.play(POWER.audio.up, { volume: POWER.audio.upGain, bus: 'sfx' });
          const B = POWER.banners.restored;
          this.deps.banner?.(B.kicker, B.title, B.sub, POWER.banners.restoredColor, POWER.banners.seconds);
        }
        break;
      }
      case 'gravityAnomaly': {
        const a = r as AnomalyRunner;
        this.deps.gravity.remove(a.handle);
        this.anomaly?.end();
        if (!silent) this.deps.audio?.play(GRAVITY.anomaly.audio.end, { position: this.anomalyCenter, bus: 'sfx' });
        break;
      }
      case 'invasion':
        break;
    }
    if (!this.isQuestOnly(r.def)) this.sinceEnd = 0;
    const p = this.endPayload;
    p.eventId = r.def.id;
    p.kind = r.def.kind;
    this.deps.events.emit('mapEvent:ended', p);
  }

  private tickInvasion(r: InvasionRunner): void {
    const I = INVASION;
    if (r.alarms < I.alarm.repeats && r.time >= r.nextAlarm) {
      r.alarms++;
      r.nextAlarm += I.alarm.interval;
      this.deps.audio?.play(I.alarm.id, { volume: I.alarm.gain, bus: 'sfx' });
    }
    if (r.spawned >= r.total) {
      r.done = true;
      return;
    }
    const count = this.collectPoints();
    if (count === 0) {
      r.done = true;
      return;
    }
    const interval = r.total > 1 ? r.def.spread / r.total : 0;
    while (r.spawned < r.total && r.time >= r.nextAt) {
      const point = this.points[r.pointCursor % count]!;
      const type = this.pickType(r.def);
      _pos.copy(point.position);
      const a = this.rng.next() * Math.PI * 2;
      const j = this.rng.next() * I.jitter;
      _pos.x += Math.cos(a) * j;
      _pos.z += Math.sin(a) * j;
      const o = this.spawnOpts;
      const plan = this.deps.waves.plan;
      o.healthMultiplier = plan?.health ?? 1;
      o.speedMultiplier = plan?.speed ?? 1;
      o.damageMultiplier = plan?.damage ?? 1;
      o.spawnPoint = point;
      const id = type ? this.deps.enemies.spawn(type, _pos, o) : null;
      if (id === null) {
        // Pool full: retry a little later, give up after a few tries.
        r.failures++;
        if (r.failures > I.maxRetries) {
          r.spawned++;
          r.failures = 0;
        }
        r.nextAt = r.time + I.retryDelay;
        return;
      }
      r.failures = 0;
      r.spawned++;
      r.pointCursor++;
      r.nextAt += interval;
    }
  }

  private tickAnomaly(r: AnomalyRunner): void {
    const fade = GRAVITY.anomaly.fade;
    if (!r.ending && r.time >= r.def.duration) r.ending = true;
    this.deps.gravity.setStrength(r.handle, this.anomalyStrength(r));
    if (r.time >= r.def.duration + fade) r.done = true;
  }

  private anomalyStrength(r: AnomalyRunner): number {
    const fade = GRAVITY.anomaly.fade;
    const inK = fade > 0 ? Math.min(1, r.time / fade) : 1;
    const outK = fade > 0 ? Math.min(1, Math.max(0, (r.def.duration + fade - r.time) / fade)) : r.time < r.def.duration ? 1 : 0;
    return Math.min(inK, outK);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private pickGenerator(def: PowerOutageEventDef): GeneratorPanel | null {
    const allowed = def.generators;
    const open = this.generators.filter(
      (g) => (!allowed || allowed.includes(g.spot.id)) && this.deps.isZoneActive(g.spot.zone),
    );
    if (open.length === 0) return null;
    return open[this.rng.int(0, open.length - 1)]!;
  }

  /** Open spawn points into `points` (their order shuffled per call is not needed: round robin). */
  private collectPoints(): number {
    const out = this.points;
    out.length = 0;
    for (const p of this.deps.spawnPoints) if (this.deps.isZoneActive(p.zone)) out.push(p);
    return out.length;
  }

  private pickType(def: InvasionEventDef): string | null {
    const wave = this.deps.waves.wave;
    let total = 0;
    for (const t of def.types) if ((t.minWave ?? 0) <= wave && this.deps.isKnownType(t.type)) total += t.weight;
    if (!(total > 0)) return null;
    let x = this.rng.next() * total;
    for (const t of def.types) {
      if ((t.minWave ?? 0) > wave || !this.deps.isKnownType(t.type)) continue;
      x -= t.weight;
      if (x <= 0) return t.type;
    }
    return def.types[def.types.length - 1]!.type;
  }

  private pickAnomalyCenter(def: GravityAnomalyEventDef): Vector3 {
    const open = def.points.filter((p) => this.deps.isZoneActive(p.zone));
    if (open.length > 0) {
      const p = open[this.rng.int(0, open.length - 1)]!;
      return new Vector3(p.position[0], p.position[1], p.position[2]);
    }
    const pl = this.deps.player?.position;
    return pl ? new Vector3(pl.x, pl.y, pl.z) : new Vector3();
  }

  private validate(def: MapEventDef): boolean {
    const t = def.trigger;
    if (!t || !(t.cooldownWaves >= 0) || !Array.isArray(t.delay) || t.delay.length !== 2) {
      log.warn(`Map event "${def.id}": invalid trigger – skipped`);
      return false;
    }
    if (def.kind === 'gravityAnomaly' && !(def.radius > 0 && def.duration > 0)) {
      log.warn(`Map event "${def.id}": radius / duration must be > 0 – skipped`);
      return false;
    }
    if (def.kind === 'invasion' && def.types.length === 0) {
      log.warn(`Map event "${def.id}": no enemy types – skipped`);
      return false;
    }
    return true;
  }
}
