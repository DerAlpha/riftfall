/**
 * Run flow (game over loop): running → dying → over → (restart) running.
 *
 * - begin(mapId, mode): a run starts; RunStats counts from now on.
 * - Death: player:healthChanged reaching 0 while running (PlayerHealth never emits a death event,
 *   so THIS is the emission point of `player:died`); a `player:died` emitted elsewhere (dev
 *   console, kill plane) starts the same sequence without a second emission.
 * - Death sequence: the time scale drops to RUN.death.slowScale and eases to endScale over
 *   easeSeconds (update(realDt) per frame; without it the slow scale simply holds), the camera
 *   callback starts the drop (or the root applies modes/deathCamera.ts with `deathTime` per
 *   frame), and after gameOverDelay REAL seconds (scheduled, so slow motion does not stretch it)
 *   `run:over` is emitted and the game over screen is shown.
 * - restart(): time scale back to 1, stats reset, `run:restart` (the composition root resets the
 *   player, enemies, waves, weapons in response), running again on the same map/mode.
 * - abandon(): back to idle (main menu), time scale back to 1.
 */
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { lerp, smoothstep } from '../core/math';
import { RUN } from '../defs/waves';
import { RunStats, type RunStatsSnapshot } from './RunStats';

export type RunState = 'idle' | 'running' | 'dying' | 'over';

/** run:over payload plus the extras the game over screen shows. */
export interface RunSummary extends Readonly<GameEvents['run:over']> {
  readonly weakpointKills: number;
  readonly accuracy: number;
  readonly damageDealt: number;
  readonly damageTaken: number;
  readonly wavesCompleted: number;
}

export interface RunDeathDef {
  readonly slowScale: number;
  readonly endScale: number;
  readonly easeSeconds: number;
  readonly scaleEpsilon: number;
  readonly cameraDropSeconds: number;
  readonly gameOverDelay: number;
}

/** Death camera curve (modes/deathCamera.ts). */
export interface DeathCameraDef {
  readonly drop: number;
  readonly rollDeg: number;
  readonly pitchDeg: number;
  readonly fallFraction: number;
  readonly bounce: number;
}

export interface RunScheduler {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

export interface RunFlowDeps {
  events: EventBus<GameEvents>;
  /** GameLoop time scale (`loop.timeScale = s`). */
  setTimeScale(scale: number): void;
  /** Death camera drop (PlayerCamera), called once when the sequence starts. */
  onDeathCamera?(duration: number): void;
  /** Run over: show the game over screen (MenuController.showGameOver) – pause the game there. */
  showGameOver?(summary: RunSummary): void;
  /** Player feet for the player:died payload. */
  getPlayerPosition?(): Vec3Like;
  /**
   * `kill()` (dev console `run kill`): drive the player's health to 0 so everything that watches
   * it (wave director freeze, enemy aggro) sees the death too. Without it only the run dies.
   */
  killPlayer?(): void;
  /** Shared stats (default: the flow creates and owns one). */
  stats?: RunStats;
  /** Real-time scheduler (default setTimeout); tests use fake timers. */
  scheduler?: RunScheduler;
  death?: RunDeathDef;
}

const defaultScheduler: RunScheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class RunFlow {
  readonly stats: RunStats;

  private readonly events: EventBus<GameEvents>;
  private readonly deps: RunFlowDeps;
  private readonly ownsStats: boolean;
  private readonly scheduler: RunScheduler;
  private readonly death: RunDeathDef;
  private readonly offs: (() => void)[] = [];
  private _state: RunState = 'idle';
  private _mapId = '';
  private _mode: string = RUN.defaultMode;
  private dyingTime = 0;
  private shownScale = 1;
  private gameOverTimer: unknown = null;
  /** Emitting player:died ourselves: ignore the echo. */
  private emittingDeath = false;
  private _summary: RunSummary | null = null;
  private readonly snap: RunStatsSnapshot;
  private readonly diedPayload: GameEvents['player:died'] = { position: { x: 0, y: 0, z: 0 } };

  constructor(deps: RunFlowDeps) {
    this.deps = deps;
    this.events = deps.events;
    this.ownsStats = !deps.stats;
    this.stats = deps.stats ?? new RunStats(deps.events);
    this.scheduler = deps.scheduler ?? defaultScheduler;
    this.death = deps.death ?? RUN.death;
    this.snap = this.stats.snapshot();
    this.offs.push(
      this.events.on('player:healthChanged', (e) => {
        if (this._state === 'running' && !(e.health > 0)) this.die(true);
      }),
      this.events.on('player:died', () => {
        if (!this.emittingDeath && this._state === 'running') this.die(false);
      }),
    );
  }

  get state(): RunState {
    return this._state;
  }
  get mapId(): string {
    return this._mapId;
  }
  get mode(): string {
    return this._mode;
  }
  /** Real seconds since the death (0 outside the death sequence; frozen once the game is over). */
  get deathTime(): number {
    return this._state === 'dying' || this._state === 'over' ? this.dyingTime : 0;
  }
  /** Summary of the last finished run (null before the first game over). */
  get summary(): RunSummary | null {
    return this._summary;
  }

  /** A run starts on `mapId` (stats reset, counting on). */
  begin(mapId: string, mode: string = RUN.defaultMode): void {
    this.cancelTimer();
    this._mapId = mapId;
    this._mode = mode;
    this.stats.reset();
    this.stats.active = true;
    this.dyingTime = 0;
    this.applyScale(1, true);
    this._state = 'running';
  }

  /** Kill the run now (dev console `run kill`): same sequence as a real death. */
  kill(): void {
    if (this._state !== 'running') return;
    // Health reaching 0 starts the sequence through player:healthChanged (god mode may refuse).
    this.deps.killPlayer?.();
    if (this._state === 'running') this.die(true);
  }

  /** Game over "Neu starten": `run:restart`, then running again on the same map and mode. */
  restart(): void {
    this.begin(this._mapId, this._mode);
    this.events.emit('run:restart', {});
  }

  /** Game over "Hauptmenü": back to idle. */
  abandon(): void {
    this.cancelTimer();
    this.stats.active = false;
    this.applyScale(1, true);
    this._state = 'idle';
  }

  /** Fixed tick: survival time. */
  fixedUpdate(dt: number): void {
    if (this._state === 'running') this.stats.tick(dt);
  }

  /** Per frame with the REAL (unscaled) frame time: eases the death slow motion. */
  update(realDt: number): void {
    if (this._state !== 'dying' || !(realDt > 0)) return;
    const D = this.death;
    this.dyingTime += realDt;
    this.applyScale(lerp(D.slowScale, D.endScale, smoothstep(0, D.easeSeconds, this.dyingTime)), false);
  }

  dispose(): void {
    this.cancelTimer();
    for (const off of this.offs) off();
    this.offs.length = 0;
    if (this._state === 'dying') this.applyScale(1, true);
    if (this.ownsStats) this.stats.dispose();
  }

  // -------------------------------------------------------------------------

  private die(emit: boolean): void {
    this._state = 'dying';
    this.stats.active = false;
    this.dyingTime = 0;
    const D = this.death;
    this.applyScale(D.slowScale, true);
    if (emit) {
      const p = this.diedPayload.position;
      const pos = this.deps.getPlayerPosition?.();
      p.x = pos?.x ?? 0;
      p.y = pos?.y ?? 0;
      p.z = pos?.z ?? 0;
      this.emittingDeath = true;
      try {
        this.events.emit('player:died', this.diedPayload);
      } finally {
        this.emittingDeath = false;
      }
    }
    this.deps.onDeathCamera?.(D.cameraDropSeconds);
    this.cancelTimer();
    this.gameOverTimer = this.scheduler.schedule(() => {
      this.gameOverTimer = null;
      this.gameOver();
    }, D.gameOverDelay * 1000);
  }

  private gameOver(): void {
    if (this._state !== 'dying') return;
    this._state = 'over';
    const s = this.stats.snapshot(this.snap);
    const summary: RunSummary = {
      mapId: this._mapId,
      mode: this._mode,
      wave: s.wave,
      kills: s.kills,
      headshots: s.headshots,
      shotsFired: s.shotsFired,
      shotsHit: s.shotsHit,
      timeSurvived: s.timeSurvived,
      score: s.score,
      weakpointKills: s.weakpointKills,
      accuracy: s.accuracy,
      damageDealt: s.damageDealt,
      damageTaken: s.damageTaken,
      wavesCompleted: s.wavesCompleted,
    };
    this._summary = summary;
    this.events.emit('run:over', {
      mapId: summary.mapId,
      mode: summary.mode,
      wave: summary.wave,
      kills: summary.kills,
      headshots: summary.headshots,
      shotsFired: summary.shotsFired,
      shotsHit: summary.shotsHit,
      timeSurvived: summary.timeSurvived,
      score: summary.score,
    });
    this.deps.showGameOver?.(summary);
  }

  private applyScale(scale: number, force: boolean): void {
    if (!force && Math.abs(scale - this.shownScale) < this.death.scaleEpsilon) return;
    this.shownScale = scale;
    this.deps.setTimeScale(scale);
  }

  private cancelTimer(): void {
    if (this.gameOverTimer === null) return;
    this.scheduler.cancel(this.gameOverTimer);
    this.gameOverTimer = null;
  }
}
