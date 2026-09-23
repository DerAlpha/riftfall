/**
 * Per-run statistics (event driven, counted only while active):
 * - kills / headshot kills / weakpoint kills: enemy:died credited to the player,
 * - shots fired / hit: every weapon:fired is one shot; the first player combat:damage after it
 *   marks the shot as a hit (a shotgun blast is one shot however many pellets land); melee blows
 *   (weapon:melee until the next shot) are not shots,
 * - damage dealt (player combat:damage) / taken (player:damaged), time survived (tick), highest
 *   wave started / completed,
 * - score (computeScore, defs/waves.ts RUN.score + the enemy defs' kill points).
 */
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { getEnemyDef } from '../defs/enemies';
import { RUN } from '../defs/waves';

export interface RunScoreDef {
  readonly defaultKill: number;
  readonly defaultHeadshotBonus: number;
  readonly defaultWeakpointBonus: number;
  readonly waveBonus: number;
  readonly perSecond: number;
  readonly accuracyPerKill: number;
}

/** Kill points of an enemy type (defs/enemies `points`). */
export interface KillPoints {
  readonly kill: number;
  readonly headshotBonus: number;
  readonly weakpointBonus: number;
}

export interface RunStatsSnapshot {
  kills: number;
  headshots: number;
  weakpointKills: number;
  shotsFired: number;
  shotsHit: number;
  /** 0..1 (0 without shots). */
  accuracy: number;
  damageDealt: number;
  damageTaken: number;
  timeSurvived: number;
  /** Highest wave started / completed. */
  wave: number;
  wavesCompleted: number;
  /** Kill points so far (enemy defs). */
  killPoints: number;
  score: number;
}

export interface ScoreInputs {
  readonly killPoints: number;
  readonly kills: number;
  readonly wavesCompleted: number;
  readonly timeSurvived: number;
  readonly accuracy: number;
}

/** Shots that hit / shots fired, 0..1 (0 without shots). */
export function accuracyOf(shotsFired: number, shotsHit: number): number {
  if (!(shotsFired > 0)) return 0;
  return Math.min(1, Math.max(0, shotsHit / shotsFired));
}

/**
 * Score: kill points + waveBonus per completed wave + perSecond per second survived + an
 * accuracy bonus (accuracyPerKill × kills × accuracy). Integer, never negative.
 */
export function computeScore(s: ScoreInputs, def: RunScoreDef = RUN.score): number {
  const kp = finite(s.killPoints);
  const waves = finite(s.wavesCompleted) * def.waveBonus;
  const time = Math.floor(finite(s.timeSurvived)) * def.perSecond;
  const acc = finite(s.kills) * def.accuracyPerKill * Math.min(1, finite(s.accuracy));
  return Math.max(0, Math.round(kp + waves + time + acc));
}

/** Kill points of one kill (zone bonus for head / weakpoint). */
export function killScore(points: KillPoints, zone: string | null): number {
  let p = points.kill;
  if (zone === 'head') p += points.headshotBonus;
  else if (zone === 'weakpoint') p += points.weakpointBonus;
  return p;
}

function finite(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export interface RunStatsOptions {
  score?: RunScoreDef;
  /** Kill points per enemy type (default: defs/enemies `points`, RUN.score defaults for unknown). */
  killPoints?: (type: string) => KillPoints | undefined;
}

export class RunStats {
  /** Counting on/off (RunFlow: on while the run is running). */
  active = false;

  private readonly scoreDef: RunScoreDef;
  private readonly killPointsOf: (type: string) => KillPoints | undefined;
  private readonly defaultPoints: KillPoints;
  private readonly offs: (() => void)[] = [];

  private _kills = 0;
  private _headshots = 0;
  private _weakpointKills = 0;
  private _shotsFired = 0;
  private _shotsHit = 0;
  private _damageDealt = 0;
  private _damageTaken = 0;
  private _time = 0;
  private _wave = 0;
  private _wavesCompleted = 0;
  private _killPoints = 0;
  /** A shot is open for hits until the next shot or a melee swing. */
  private shotOpen = false;
  private shotHit = false;

  constructor(events: EventBus<GameEvents>, opts: RunStatsOptions = {}) {
    this.scoreDef = opts.score ?? RUN.score;
    this.killPointsOf = opts.killPoints ?? ((type) => getEnemyDef(type)?.points);
    const S = this.scoreDef;
    this.defaultPoints = {
      kill: S.defaultKill,
      headshotBonus: S.defaultHeadshotBonus,
      weakpointBonus: S.defaultWeakpointBonus,
    };
    this.offs.push(
      events.on('weapon:fired', () => {
        if (!this.active) return;
        this._shotsFired++;
        this.shotOpen = true;
        this.shotHit = false;
      }),
      events.on('weapon:melee', () => {
        this.shotOpen = false;
      }),
      events.on('combat:damage', (e) => {
        if (!this.active || e.source !== 'player') return;
        if (Number.isFinite(e.amount) && e.amount > 0) this._damageDealt += e.amount;
        if (this.shotOpen && !this.shotHit) {
          this.shotHit = true;
          this._shotsHit++;
        }
      }),
      events.on('enemy:died', (e) => {
        if (!this.active || e.source !== 'player') return;
        this._kills++;
        if (e.zone === 'head') this._headshots++;
        else if (e.zone === 'weakpoint') this._weakpointKills++;
        this._killPoints += killScore(this.killPointsOf(e.type) ?? this.defaultPoints, e.zone);
      }),
      events.on('player:damaged', (e) => {
        if (this.active && Number.isFinite(e.amount) && e.amount > 0) this._damageTaken += e.amount;
      }),
      events.on('wave:start', (e) => {
        if (this.active) this._wave = Math.max(this._wave, e.wave);
      }),
      events.on('wave:complete', (e) => {
        if (this.active) this._wavesCompleted = Math.max(this._wavesCompleted, e.wave);
      }),
    );
  }

  get kills(): number {
    return this._kills;
  }
  get headshots(): number {
    return this._headshots;
  }
  get weakpointKills(): number {
    return this._weakpointKills;
  }
  get shotsFired(): number {
    return this._shotsFired;
  }
  get shotsHit(): number {
    return this._shotsHit;
  }
  get accuracy(): number {
    return accuracyOf(this._shotsFired, this._shotsHit);
  }
  get damageDealt(): number {
    return this._damageDealt;
  }
  get damageTaken(): number {
    return this._damageTaken;
  }
  get timeSurvived(): number {
    return this._time;
  }
  get wave(): number {
    return this._wave;
  }
  get wavesCompleted(): number {
    return this._wavesCompleted;
  }
  get score(): number {
    return computeScore(
      {
        killPoints: this._killPoints,
        kills: this._kills,
        wavesCompleted: this._wavesCompleted,
        timeSurvived: this._time,
        accuracy: this.accuracy,
      },
      this.scoreDef,
    );
  }

  /** Survival time (fixed tick while active). */
  tick(dt: number): void {
    if (this.active && dt > 0 && Number.isFinite(dt)) this._time += dt;
  }

  /** Current wave when the run starts on a later wave (setWave / start(n)). */
  noteWave(wave: number): void {
    if (Number.isFinite(wave)) this._wave = Math.max(this._wave, Math.floor(wave));
  }

  reset(): void {
    this._kills = 0;
    this._headshots = 0;
    this._weakpointKills = 0;
    this._shotsFired = 0;
    this._shotsHit = 0;
    this._damageDealt = 0;
    this._damageTaken = 0;
    this._time = 0;
    this._wave = 0;
    this._wavesCompleted = 0;
    this._killPoints = 0;
    this.shotOpen = false;
    this.shotHit = false;
  }

  /** Copy of the current values (into `out` when given). */
  snapshot(out?: RunStatsSnapshot): RunStatsSnapshot {
    const s =
      out ??
      ({
        kills: 0,
        headshots: 0,
        weakpointKills: 0,
        shotsFired: 0,
        shotsHit: 0,
        accuracy: 0,
        damageDealt: 0,
        damageTaken: 0,
        timeSurvived: 0,
        wave: 0,
        wavesCompleted: 0,
        killPoints: 0,
        score: 0,
      } satisfies RunStatsSnapshot);
    s.kills = this._kills;
    s.headshots = this._headshots;
    s.weakpointKills = this._weakpointKills;
    s.shotsFired = this._shotsFired;
    s.shotsHit = this._shotsHit;
    s.accuracy = this.accuracy;
    s.damageDealt = this._damageDealt;
    s.damageTaken = this._damageTaken;
    s.timeSurvived = this._time;
    s.wave = this._wave;
    s.wavesCompleted = this._wavesCompleted;
    s.killPoints = this._killPoints;
    s.score = this.score;
    return s;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
