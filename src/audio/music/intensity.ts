/**
 * Music intensity (pure): the built-in model (threat of nearby enemies, recent damage, kill rate,
 * low health, the wave clock), the external overrides (M6 spawn director, dev console) and the
 * layer mixer that turns a bar's intensity into layers with hysteresis.
 *
 * Priority of the sources: dev console > spawn director (while it keeps sending, see
 * MUSIC.intensity.directorTimeout) > model. The value is smoothed (fast rise, slow fall) in game
 * time; the state clamp (MUSIC.states) is applied by the caller.
 */
import type { Vec3Like } from '../../core/events';
import {
  MUSIC,
  MUSIC_LAYERS,
  type LayerThreshold,
  type MusicIntensitySource,
  type MusicLayer,
} from '../../defs/music';

const I = MUSIC.intensity;
const LN2 = Math.LN2;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0;
}

/** What the model reads of an enemy (EnemyManager's Enemy fits structurally). */
export interface ThreatEnemy {
  readonly alive: boolean;
  readonly type: string;
  readonly elite?: boolean;
  readonly position: Vec3Like;
}

/**
 * Threat around `at`: Σ type weight × elite factor × distance falloff (1 within `near`, 0 at
 * `radius`). Pure – exported for tests.
 */
export function threatOf(enemies: readonly ThreatEnemy[], at: Vec3Like): number {
  let sum = 0;
  const span = Math.max(1e-3, I.radius - I.near);
  for (let k = 0; k < enemies.length; k++) {
    const e = enemies[k]!;
    if (!e.alive) continue;
    const dx = e.position.x - at.x;
    const dy = e.position.y - at.y;
    const dz = e.position.z - at.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(d < I.radius)) continue;
    const falloff = d <= I.near ? 1 : 1 - (d - I.near) / span;
    const w = Object.prototype.hasOwnProperty.call(I.typeWeight, e.type) ? I.typeWeight[e.type]! : 1;
    sum += w * (e.elite ? I.eliteWeight : 1) * falloff;
  }
  return sum;
}

export class IntensityModel {
  private threat = 0;
  private damage = 0;
  private killRate = 0;
  private health = 1;
  private waveActive = false;
  private waveNumber = 0;
  private waveTime = 0;
  private raw = 0;
  private smoothed = 0;
  private director: number | null = null;
  private directorAge = Number.POSITIVE_INFINITY;
  private dev: number | null = null;

  /** Smoothed intensity 0..1 (before the state clamp). */
  get value(): number {
    return this.smoothed;
  }

  /** The model's own unsmoothed estimate (debug). */
  get modelValue(): number {
    return this.raw;
  }

  get source(): MusicIntensitySource {
    if (this.dev !== null) return 'dev';
    if (this.director !== null && this.directorAge <= I.directorTimeout) return 'director';
    return 'model';
  }

  /** Low-health danger 0..1 (darkens the mix). */
  get danger(): number {
    return this.health < I.lowHealth ? clamp01(1 - this.health / I.lowHealth) : 0;
  }

  setThreat(threat: number): void {
    this.threat = Number.isFinite(threat) && threat > 0 ? threat : 0;
  }

  addDamage(amount: number): void {
    if (Number.isFinite(amount) && amount > 0) this.damage += amount;
  }

  addKill(): void {
    // EMA of kills per second: each kill adds 1/τ, decaying with τ.
    this.killRate += 1 / I.killTau;
  }

  setHealth(fraction: number): void {
    if (Number.isFinite(fraction)) this.health = clamp01(fraction);
  }

  waveStarted(wave: number): void {
    this.waveActive = true;
    this.waveNumber = Math.max(1, Math.floor(wave));
    this.waveTime = 0;
  }

  waveEnded(): void {
    this.waveActive = false;
  }

  /** External intensity (null releases it). Director values expire after MUSIC.intensity.directorTimeout. */
  setOverride(value: number | null, source: MusicIntensitySource): void {
    const v = value === null || !Number.isFinite(value) ? null : clamp01(value);
    if (source === 'dev') this.dev = v;
    else if (source === 'director') {
      this.director = v;
      this.directorAge = 0;
    }
  }

  /** Forget the run (restart): no threat, damage, kills; full health; no wave; overrides kept. */
  reset(): void {
    this.threat = 0;
    this.damage = 0;
    this.killRate = 0;
    this.health = 1;
    this.waveActive = false;
    this.waveNumber = 0;
    this.waveTime = 0;
    this.raw = 0;
    this.smoothed = 0;
  }

  /** Advance by `dt` s of game time; returns the smoothed value. */
  update(dt: number): number {
    if (!(dt > 0) || !Number.isFinite(dt)) return this.smoothed;
    this.damage *= Math.exp((-LN2 * dt) / I.damageHalfLife);
    this.killRate *= Math.exp(-dt / I.killTau);
    this.directorAge += dt;
    if (this.waveActive) this.waveTime += dt;
    const W = I.weights;
    const wave = this.waveActive
      ? I.wave.start * Math.max(0, 1 - this.waveTime / I.wave.startSeconds) +
        Math.min(I.wave.perWaveMax, I.wave.perWave * (this.waveNumber - 1))
      : 0;
    this.raw = clamp01(
      wave +
        W.threat * (1 - Math.exp(-this.threat / I.threatScale)) +
        W.damage * Math.min(1, this.damage / I.fullDamage) +
        W.kills * Math.min(1, this.killRate / I.fullKillRate) +
        W.health * this.danger,
    );
    const source = this.source;
    const target = source === 'dev' ? this.dev! : source === 'director' ? this.director! : this.raw;
    if (source === 'dev') {
      this.smoothed = target;
    } else {
      const tau = source === 'director' ? I.directorTau : target > this.smoothed ? I.riseTau : I.fallTau;
      this.smoothed += (target - this.smoothed) * (1 - Math.exp(-dt / tau));
    }
    this.smoothed = clamp01(this.smoothed);
    return this.smoothed;
  }
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const L = MUSIC.layers;
const THRESHOLDS: readonly LayerThreshold[] = MUSIC_LAYERS.map((l) => L.thresholds[l]);

/** Bit of a layer in a layer mask. */
export function layerBit(layer: MusicLayer): number {
  return 1 << MUSIC_LAYERS.indexOf(layer);
}

export function layerMask(layers: readonly MusicLayer[]): number {
  let m = 0;
  for (const l of layers) m |= layerBit(l);
  return m;
}

/**
 * Intensity → layers, evaluated once per bar: a layer switches on at its `on` threshold and off
 * only below `off` (hysteresis), and stays at least MUSIC.layers.minBars after a change – except
 * when the state no longer allows it (off at once).
 */
export class LayerMixer {
  readonly on: boolean[] = MUSIC_LAYERS.map(() => false);
  private readonly changedAt = new Float64Array(MUSIC_LAYERS.length).fill(Number.NEGATIVE_INFINITY);

  /** Returns a mask of the layers that changed at this bar. */
  evaluate(intensity: number, bar: number, allowed: number): number {
    let changed = 0;
    for (let k = 0; k < THRESHOLDS.length; k++) {
      const th = THRESHOLDS[k]!;
      const ok = (allowed & (1 << k)) !== 0;
      const dwell = bar - this.changedAt[k]! >= L.minBars;
      let next = this.on[k]!;
      if (!ok) next = false;
      else if (!next && intensity >= th.on && dwell) next = true;
      else if (next && intensity < th.off && dwell) next = false;
      if (next !== this.on[k]) {
        this.on[k] = next;
        this.changedAt[k] = bar;
        changed |= 1 << k;
      }
    }
    return changed;
  }

  /** Gain share 0..1 of layer `k` at `intensity` (partial just above its threshold, full `span` above). */
  share(k: number, intensity: number): number {
    if (!this.on[k]) return 0;
    const th = THRESHOLDS[k]!;
    return L.partialGain + (1 - L.partialGain) * clamp01((intensity - Math.max(0, th.on)) / L.span);
  }

  reset(): void {
    this.on.fill(false);
    this.changedAt.fill(Number.NEGATIVE_INFINITY);
  }
}
