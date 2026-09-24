/**
 * Music conductor (pure, no Web Audio): the music state machine driven by game events, the
 * intensity model's inputs, sting requests (rate limited) and the positional elite / boss hint
 * cues. The audio side (MusicSystem) implements ConductorSink and realizes what it asks for.
 *
 * States (MUSIC.states): menu (start screen) → intermission (a run starts: the first resume, a
 * wave intermission, run:restart) → wave (wave:start) → boss (a boss enemy spawns, or the M6 hook
 * setBossTheme) → back to wave / intermission when the last boss dies → gameover (player:died)
 * → intermission (restart) or menu (main menu). The dev console can force a state.
 */
import type { EventBus } from '../../core/EventBus';
import type { GameEvents, Vec3Like } from '../../core/events';
import { getEnemyDef } from '../../defs/enemies';
import {
  MUSIC,
  MUSIC_CUES,
  MUSIC_STINGS,
  type MusicIntensitySource,
  type MusicState,
  type MusicStatePolicy,
  type MusicStingId,
} from '../../defs/music';
import { TokenBucket } from '../tokenBucket';
import { bossThemeFor, getThemeDef, themeIdForMap } from './composer';
import { IntensityModel, clamp01, threatOf, type ThreatEnemy } from './intensity';

export interface ConductorSink {
  /** The state, its theme or its policy changed (idempotent on the audio side). */
  applyState(state: MusicState, prev: MusicState): void;
  /** Play a sting (already rate limited); `transpose` in semitones. */
  playSting(id: MusicStingId, transpose: number): void;
  /** A positional hint cue (already distance- and rate-limited). */
  playCue(id: string, position: Vec3Like, gain: number, pitchVariance: number): void;
}

export interface ConductorOptions {
  /** Map whose theme plays (unknown: MUSIC.fallbackTheme). */
  mapId: string;
  /** Wall clock (s) for sting / cue rate limits. */
  now?: () => number;
  /** Boss enemy types (default: defs/enemies `boss: true`). */
  isBoss?: (type: string) => boolean;
}

/** Per-id spacing + a global token bucket; `bypass` stings (game over, boss) skip the bucket. */
export class StingLimiter {
  private readonly last = new Map<string, number>();
  private readonly bucket = new TokenBucket(MUSIC.stingLimit.burst, MUSIC.stingLimit.refillPerSecond);

  allow(id: string, minInterval: number, now: number, bypass = false): boolean {
    const last = this.last.get(id);
    if (last !== undefined && now - last < minInterval) return false;
    if (!bypass && !this.bucket.take(now)) return false;
    this.last.set(id, now);
    return true;
  }

  reset(): void {
    this.last.clear();
  }
}

const defaultClock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
const defaultIsBoss = (type: string): boolean => getEnemyDef(type)?.boss === true;

/** Stings that always play (no global bucket). */
const PRIORITY_STINGS: ReadonlySet<MusicStingId> = new Set<MusicStingId>(['gameOver', 'bossAppear', 'pause']);

export class MusicConductor {
  readonly model = new IntensityModel();
  private readonly offs: (() => void)[] = [];
  private readonly limiter = new StingLimiter();
  private readonly now: () => number;
  private readonly isBoss: (type: string) => boolean;
  private _state: MusicState = 'off';
  private auto: MusicState = 'off';
  private forced: MusicState | null = null;
  private mapId: string;
  private bossOverride: string | null = null;
  private readonly bosses = new Map<number, string>();
  private readonly elites = new Set<number>();
  private waveActive = false;
  private _paused = false;
  /** Theme of the last state that named one ('current' keeps it). */
  private lastTheme: string;
  private pollTimer = 0;
  private readonly listener = { x: 0, y: 0, z: 0 };
  private hasListener = false;
  private enemies: { readonly enemies: readonly ThreatEnemy[] } | null = null;
  private readonly cueLast = new Map<string, number>();

  constructor(
    events: EventBus<GameEvents>,
    private readonly sink: ConductorSink,
    opts: ConductorOptions,
  ) {
    this.now = opts.now ?? defaultClock;
    this.isBoss = opts.isBoss ?? defaultIsBoss;
    this.mapId = opts.mapId;
    this.lastTheme = themeIdForMap(opts.mapId);
    this.offs.push(
      events.on('ui:menu', (e) => {
        if (!e.open) return;
        if (e.menu === 'start') this.go('menu');
        else if (e.menu === 'pause') this.sting('pause');
      }),
      events.on('game:paused', () => {
        this._paused = true;
      }),
      events.on('game:resumed', () => {
        this._paused = false;
        if (this.auto === 'off' || this.auto === 'menu') this.go('intermission');
      }),
      events.on('wave:intermission', () => {
        if (this.auto !== 'gameover' && this.auto !== 'boss') this.go('intermission');
      }),
      events.on('wave:start', (e) => {
        this.waveActive = true;
        this.model.waveStarted(e.wave);
        const special = e.kind !== undefined && e.kind !== 'normal';
        this.sting('waveStart', special ? MUSIC.specialWaveSemis : 0);
        if (this.auto !== 'gameover' && this.auto !== 'boss') this.go('wave');
      }),
      events.on('wave:complete', () => {
        this.waveActive = false;
        this.model.waveEnded();
        this.sting('waveComplete');
        if (this.auto === 'wave') this.go('intermission');
      }),
      events.on('enemy:spawned', (e) => {
        if (this.isBoss(e.type)) {
          this.bosses.set(e.id, e.type);
          const cue = MUSIC_CUES.bossCues[e.type] ?? MUSIC_CUES.boss.id;
          this.cue(cue, 'boss', e.position, MUSIC_CUES.boss.gain, 0, MUSIC_CUES.boss.maxDistance, MUSIC_CUES.boss.minInterval);
          if (this.auto !== 'gameover' && this.auto !== 'menu') {
            this.sting('bossAppear');
            this.go('boss');
          }
        } else if (e.elite) {
          if (this.elites.size >= MUSIC_CUES.elite.maxTracked) this.elites.clear();
          this.elites.add(e.id);
          const C = MUSIC_CUES.elite;
          this.cue(C.spawn.id, 'elite.spawn', e.position, C.spawn.gain, C.pitchVariance, C.spawn.maxDistance, C.spawn.minInterval);
        }
      }),
      events.on('enemy:alert', (e) => {
        if (!this.elites.has(e.id)) return;
        const C = MUSIC_CUES.elite;
        this.cue(C.alert.id, 'elite.alert', e.position, C.alert.gain, C.pitchVariance, C.alert.maxDistance, C.alert.minInterval);
      }),
      events.on('enemy:died', (e) => {
        this.elites.delete(e.id);
        if (!this.bosses.delete(e.id) || this.bosses.size > 0 || this.bossOverride !== null) return;
        if (this.auto === 'boss') {
          this.sting('bossDefeated');
          this.go(this.waveActive ? 'wave' : 'intermission');
        }
      }),
      events.on('combat:kill', (e) => {
        if (e.source === 'player') this.model.addKill();
      }),
      events.on('player:damaged', (e) => this.model.addDamage(e.amount)),
      events.on('player:healthChanged', (e) => {
        this.model.setHealth(e.maxHealth > 0 ? e.health / e.maxHealth : 1);
      }),
      events.on('player:died', () => {
        this.sting('gameOver');
        this.go('gameover');
      }),
      events.on('run:restart', () => {
        this.resetRun();
        this.go('intermission');
      }),
      events.on('powerup:collected', (e) => {
        if (e.type === 'nuke') this.sting('nuke');
        else if (e.type === 'instakill') this.sting('instakill');
      }),
      events.on('progression:levelUp', () => this.sting('levelUp')),
      events.on('achievement:unlocked', (e) => {
        this.sting('achievement', MUSIC.achievementTierSemis[e.tier] ?? 0);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  get state(): MusicState {
    return this._state;
  }

  /** The state the events lead to (differs from `state` while the dev console forces one). */
  get autoState(): MusicState {
    return this.auto;
  }

  get forcedState(): MusicState | null {
    return this.forced;
  }

  get paused(): boolean {
    return this._paused;
  }

  get policy(): MusicStatePolicy {
    return MUSIC.states[this._state];
  }

  get bossCount(): number {
    return this.bosses.size;
  }

  /** Theme the current state plays. */
  get themeId(): string {
    return this.themeFor(this._state);
  }

  themeFor(state: MusicState): string {
    const p = MUSIC.states[state];
    switch (p.theme) {
      case 'map':
        return themeIdForMap(this.mapId);
      case 'boss': {
        if (this.bossOverride !== null) return this.bossOverride;
        const first = this.bosses.values().next();
        return bossThemeFor(first.done ? null : first.value);
      }
      case 'menu':
        return MUSIC.menuTheme;
      case 'current':
      default:
        return this.lastTheme;
    }
  }

  /** Bar intensity of the current state: the model / override value inside the state's clamp. */
  get intensity(): number {
    const p = this.policy;
    let max: number = p.max;
    if (this._state === 'intermission') max = getThemeDef(this.themeId).calmMax ?? max;
    return Math.min(Math.max(p.min, this.model.value), Math.max(p.min, max));
  }

  get intensitySource(): MusicIntensitySource {
    return this.model.source;
  }

  /** Dev console: force a state (null: follow the game again). */
  force(state: MusicState | null): void {
    this.forced = state;
    this.apply();
  }

  /** Switch the map theme (dev console, M7 map loads). */
  setMap(mapId: string): void {
    this.mapId = mapId;
    if (MUSIC.states[this._state].theme === 'map') this.lastTheme = themeIdForMap(mapId);
    this.sink.applyState(this._state, this._state);
  }

  /**
   * M6 hook: a scripted boss fight names its theme (`boss` for the generic one); null ends it (the
   * music returns to the wave / intermission unless boss enemies are still alive).
   */
  setBossTheme(themeId: string | null): void {
    this.bossOverride = themeId;
    if (themeId !== null) {
      if (this.auto !== 'boss') this.sting('bossAppear');
      this.go('boss');
      this.sink.applyState(this._state, this._state);
    } else if (this.auto === 'boss' && this.bosses.size === 0) {
      this.go(this.waveActive ? 'wave' : 'intermission');
    }
  }

  /** Request a sting (rate limited per MUSIC_STINGS minInterval + a global bucket). */
  sting(id: MusicStingId, transpose = 0): boolean {
    const def = MUSIC_STINGS[id];
    if (!def) return false;
    if (!this.limiter.allow(id, def.minInterval, this.now(), PRIORITY_STINGS.has(id))) return false;
    this.sink.playSting(id, transpose);
    return true;
  }

  // -------------------------------------------------------------------------
  // Per frame (game time)
  // -------------------------------------------------------------------------

  /** Enemies the threat term reads (EnemyManager fits). */
  setEnemySource(source: { readonly enemies: readonly ThreatEnemy[] } | null): void {
    this.enemies = source;
  }

  setIntensity(value: number | null, source: MusicIntensitySource): void {
    this.model.setOverride(value, source);
  }

  /** While the game runs: listener position, threat polling (MUSIC.intensity.pollInterval), smoothing. */
  update(dt: number, listener?: Vec3Like): void {
    if (listener) {
      this.listener.x = listener.x;
      this.listener.y = listener.y;
      this.listener.z = listener.z;
      this.hasListener = true;
    }
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this.pollTimer -= dt;
    if (this.pollTimer <= 0) {
      this.pollTimer = MUSIC.intensity.pollInterval;
      const list = this.enemies?.enemies;
      this.model.setThreat(list && this.hasListener ? threatOf(list, this.listener) : 0);
    }
    this.model.update(dt);
  }

  /** Danger 0..1 (low health) for the mix. */
  get danger(): number {
    return this._state === 'gameover' ? 0 : clamp01(this.model.danger);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.enemies = null;
  }

  // -------------------------------------------------------------------------

  private resetRun(): void {
    this.bosses.clear();
    this.elites.clear();
    this.waveActive = false;
    this.model.reset();
    this.cueLast.clear();
  }

  private go(next: MusicState): void {
    this.auto = next;
    this.apply();
  }

  private apply(): void {
    const next = this.forced ?? this.auto;
    const prev = this._state;
    const p = MUSIC.states[next];
    if (p.theme !== 'current') this.lastTheme = this.themeFor(next);
    if (next === prev) return;
    this._state = next;
    this.sink.applyState(next, prev);
  }

  private cue(
    id: string,
    kind: string,
    position: Vec3Like,
    gain: number,
    pitchVariance: number,
    maxDistance: number,
    minInterval: number,
  ): void {
    if (this.hasListener) {
      const d = Math.hypot(
        position.x - this.listener.x,
        position.y - this.listener.y,
        position.z - this.listener.z,
      );
      if (!(d <= maxDistance)) return;
    }
    const now = this.now();
    const last = this.cueLast.get(kind);
    if (last !== undefined && now - last < minInterval) return;
    this.cueLast.set(kind, now);
    this.sink.playCue(id, position, gain, pitchVariance);
  }
}
