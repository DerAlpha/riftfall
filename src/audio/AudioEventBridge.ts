/**
 * Maps gameplay/UI events to sounds. Player sounds are 2D (the listener sits in the player's
 * head, HRTF would only smear them); world sounds (impacts, casing clinks) pass `position`.
 * PlayOptions objects are reused for every call – the engine reads them synchronously.
 *
 * Weapons (M2): gunshot layers come from WeaponDef.audio (data-driven: `fire` shares one random
 * detune per shot, `extraFire` layers detune on their own), plus a mechanical "last rounds" tick;
 * handling sounds prefer the per-weapon id `weapon.<id>.<key>` when the engine knows it and fall
 * back to the def's (possibly shared) id. The equip rack follows weapon:raiseStart (the weapon
 * actually comes up); a raise that starts while nothing can sound (audio still locked behind the
 * start menu, game paused) racks on game:resumed instead, when its animation really plays.
 * Impacts play positionally (HRTF) through a token bucket (a shotgun blast is nine impacts). The
 * player's own hits get dry UI-bus feedback (hitmarker tick, headshot ding, kill punch). Casing
 * clinks come from the VFX casing callback via playCasing(). Explosions (combat:explosion) play one
 * positional blast scaled by their radius.
 *
 * Enemies (M3): enemy:spawned / alert / attack / staggered / died and hits on enemies
 * (combat:damage) play the ids of defs/enemies positionally (HRTF). Every request passes a voice
 * budget per enemy type (VoiceBudget, AUDIO.enemies): too far → dropped, all voices busy → it
 * replaces the lowest-priority / farthest one only if it outranks it, so 60 enemies never flood
 * the engine and the nearest are heard. An attack's blow (AUDIO.enemies.strikes) sounds when its
 * wind-up ends (cancelled by a stagger or death). Footsteps and idle vocals are polled per frame
 * from an EnemyAudioSource (setEnemySource) in update(dt, listener) – the listener position also
 * feeds the distance checks. Enemy projectile impacts with their own sound (acid splash) replace
 * the surface impact. Wave start / complete stings play on the music bus; the game over sting on
 * the ui bus (it plays on into the paused game over screen).
 *
 * Economy (M4, EconomyAudio in economyAudio.ts): purchases / denials / points ticks, doors, the
 * Rift-Kiste, perk machines (hums, jingles, perk stings), power-up pickups, stingers and expiry,
 * rift seals. World anchors (doors, machines, the box, the power-up clock) come from
 * setEconomySources; update() and resetRun() drive it too.
 *
 * Arsenal (M5, ArsenalAudio in arsenalAudio.ts): beam / charge / spin loops of the weapon in hand,
 * positional flight and field loops (nearest first, voice budgets; positions from
 * setArsenalSources), bounces, statuses, combos, grenades, abilities, forge and bench. Here: beam
 * ticks play no gunshot (the loop is their sound), gunshot tails follow the room (the engine's
 * reverb zone), the mechanical layer and the tail of one weapon thin out at very high rates,
 * energy weapons hit with their impact profile (impact.plasma …) instead of the surface sound,
 * explosions play their own `audio` id (else explosion.<element>) through a token bucket.
 */
import type { PlayOptions } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { FleshSurface, GameEvents, HitZone, SurfaceType, Vec3Like } from '../core/events';
import { AUDIO, type EnemyAudioBudgetDef, type EnemyAudioKind, type ReverbZone } from '../defs/audio';
import { getEnemyAttackDef, getEnemyDef } from '../defs/enemies';
import { MOVEMENT } from '../defs/movement';
import { getWeaponDef, type ReloadStep } from '../defs/weapons';
import { remapClamped } from './dsp';
import type { LoopOptions, LoopUpdate } from './AudioEngine';
import { ArsenalAudio, isBenchMenu, roomTail, type ArsenalAudioSources } from './arsenalAudio';
import { EconomyAudio, type EconomyAudioSources } from './economyAudio';
import { TokenBucket } from './tokenBucket';

/** The engine surface the bridge needs (AudioEngine implements it; tests use a fake). */
export interface AudioBridgeTarget {
  play(id: string, opts?: PlayOptions): void;
  startLoop(id: string, opts?: LoopOptions): number;
  stopLoop(handle: number, fadeSeconds?: number): void;
  /** True if `id` resolves to a sound (asset or procedural). Optional: without it def ids are used as given. */
  has?(id: string): boolean;
  /**
   * False while the engine cannot make any sound yet (no AudioContext before the first user
   * gesture). Optional: without it the bridge assumes it can play.
   */
  readonly unlocked?: boolean;
  /** Retune a running loop (M5: charge/spin pitch, flight positions); false when it is gone. Optional. */
  updateLoop?(handle: number, u: LoopUpdate): boolean;
  /** The room the reverb models (gunshot tails follow it). Optional. */
  readonly activeReverbZone?: ReverbZone | null;
}

const M = AUDIO.movement;
const B = AUDIO.bridge;
const W = AUDIO.weapons;
const E = AUDIO.enemies;
const ST = AUDIO.stings;
const AR = AUDIO.arsenal;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Sound id mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Weapon actions with one sound each (WeaponAudioDef fields). */
export type WeaponSoundKey = 'dry' | 'equip' | 'holster' | 'reloadStart' | 'melee' | 'inspect';

/** Per-weapon convention id: `weapon.<weaponId>.<key>`. */
export function weaponConventionId(weaponId: string, key: string): string {
  return `weapon.${weaponId}.${key}`;
}

/**
 * Sound for a weapon action: the per-weapon convention id when `has` knows it (specific beats
 * generic), else the weapon def's id, else the convention id (silent + one warning if unknown).
 */
export function weaponSoundId(weaponId: string, key: WeaponSoundKey, has?: (id: string) => boolean): string {
  const conv = weaponConventionId(weaponId, key);
  if (has?.(conv)) return conv;
  return getWeaponDef(weaponId)?.audio[key] ?? conv;
}

/** Reload keyframe sound (same preference as weaponSoundId). */
export function reloadStepSoundId(weaponId: string, step: ReloadStep, has?: (id: string) => boolean): string {
  const conv = weaponConventionId(weaponId, step);
  if (has?.(conv)) return conv;
  return getWeaponDef(weaponId)?.audio.steps[step] ?? conv;
}

const fallbackFire = new Map<string, readonly string[]>();

/** Gunshot layers of a weapon (WeaponAudioDef.fire); unknown weapons use `weapon.<id>.fire`. Never allocates after warm-up. */
export function fireSoundLayers(weaponId: string): readonly string[] {
  const def = getWeaponDef(weaponId);
  if (def && def.audio.fire.length > 0) return def.audio.fire;
  let f = fallbackFire.get(weaponId);
  if (!f) {
    f = [weaponConventionId(weaponId, 'fire')];
    fallbackFire.set(weaponId, f);
  }
  return f;
}

const NO_LAYERS: readonly string[] = [];

/** Extra per-shot layers of a weapon (WeaponAudioDef.extraFire), empty if it has none. */
export function extraFireSoundLayers(weaponId: string): readonly string[] {
  return getWeaponDef(weaponId)?.audio.extraFire ?? NO_LAYERS;
}

/** Gain of fire layer `index` (later layers reuse the last configured gain). */
export function fireLayerGain(index: number): number {
  const g = W.fireLayerGains;
  return g.length === 0 ? 1 : g[Math.min(index, g.length - 1)]!;
}

export function impactSoundId(surface: SurfaceType | FleshSurface): string {
  return W.impactSounds[surface] ?? W.impactSounds.default;
}

export function isCritZone(zone: HitZone): boolean {
  return W.critZones.includes(zone);
}

/** UI feedback sound for the player's hit: kill > crit (head/weakpoint) > hit. */
export function hitSoundId(zone: HitZone, killed: boolean): string {
  if (killed) return W.hitSounds.kill;
  return isCritZone(zone) ? W.hitSounds.crit : W.hitSounds.hit;
}

/** Rounds left in the magazine from which the "last rounds" tick plays (0 = never). */
export function lowAmmoThreshold(magSize: number): number {
  if (!(magSize > 1)) return 0;
  const L = W.lowAmmo;
  return Math.min(L.maxRounds, Math.ceil(magSize * L.fraction));
}

export { TokenBucket };

/**
 * Fixed voice budget with priority + distance preemption (pure; `now` in seconds). A request
 * takes a free voice, else replaces the busy voice of the lowest priority (farthest among equals)
 * when it has a higher priority or is at least `margin` m nearer at the same priority.
 */
export class VoiceBudget {
  private readonly ends: Float64Array;
  private readonly dist: Float32Array;
  private readonly prio: Int8Array;

  constructor(readonly voices: number) {
    const n = Math.max(1, Math.floor(voices));
    this.ends = new Float64Array(n).fill(Number.NEGATIVE_INFINITY);
    this.dist = new Float32Array(n);
    this.prio = new Int8Array(n);
  }

  /** May the sound play? When true it occupies a voice until now + hold. */
  admit(now: number, distance: number, priority: number, hold: number, margin = 0): boolean {
    const ends = this.ends;
    let slot = -1;
    let worst = -1;
    for (let i = 0; i < ends.length; i++) {
      if (ends[i]! <= now) {
        slot = i;
        break;
      }
      if (
        worst < 0 ||
        this.prio[i]! < this.prio[worst]! ||
        (this.prio[i] === this.prio[worst] && this.dist[i]! > this.dist[worst]!)
      ) {
        worst = i;
      }
    }
    if (slot < 0) {
      const p = this.prio[worst]!;
      if (!(priority > p || (priority === p && distance + margin < this.dist[worst]!))) return false;
      slot = worst;
    }
    ends[slot] = now + Math.max(0, hold);
    this.dist[slot] = distance;
    this.prio[slot] = priority;
    return true;
  }

  /** Voices busy at `now`. */
  busy(now: number): number {
    let n = 0;
    for (let i = 0; i < this.ends.length; i++) if (this.ends[i]! > now) n++;
    return n;
  }

  reset(): void {
    this.ends.fill(Number.NEGATIVE_INFINITY);
  }
}

/** What footstep / idle polling reads of an enemy (EnemyManager's Enemy fits structurally). */
export interface EnemyAudioView {
  readonly id: number;
  readonly type: string;
  /** False while dying / dissolving. */
  readonly alive: boolean;
  readonly position: Vec3Like;
  readonly pose: { readonly phase: number; readonly locomotion: number };
}

/** Living and dying enemies (EnemyManager.enemies fits structurally). */
export interface EnemyAudioSource {
  readonly enemies: readonly EnemyAudioView[];
}

/** Footstep index of a gait phase (radians, 2π per stride) with `steps` footfalls per cycle. */
export function gaitStepIndex(phase: number, steps: number): number {
  if (!Number.isFinite(phase) || !(steps > 0)) return 0;
  const p = ((phase % TAU) + TAU) % TAU;
  return Math.min(steps - 1, Math.floor((p / TAU) * steps));
}

interface TypeBudget {
  readonly def: EnemyAudioBudgetDef;
  readonly voice: VoiceBudget;
  readonly step: VoiceBudget;
}

interface EnemyVoiceState {
  step: number;
  nextIdle: number;
  seen: number;
}

const PROJECTILE_BUDGET = 'projectile';

const defaultClock = (): number =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

export class AudioEventBridge {
  private readonly offs: (() => void)[] = [];
  private readonly opts: PlayOptions = {};
  /** Positional plays (impacts, casings) – own object so 2D plays never inherit a position. */
  private readonly posOpts: PlayOptions & { position: Vec3Like } = { position: { x: 0, y: 0, z: 0 } };
  private readonly loopOpts: LoopOptions = {};
  private slideHandle = 0;
  private readonly impactBucket = new TokenBucket(W.impactBurst, W.impactRefillPerSecond);
  private readonly casingBucket = new TokenBucket(W.casingBurst, W.casingRefillPerSecond);
  private lastHitAt = Number.NEGATIVE_INFINITY;
  /** Live magazine sizes (weapon:ammoChanged) – upgrades change them; defs are the fallback. */
  private readonly magSizes = new Map<string, number>();
  private readonly has: ((id: string) => boolean) | undefined;
  /** Seen game:paused without a game:resumed since (nothing animates, sfx are muted). */
  private gamePaused = false;
  /** Weapon whose raise started while nothing could sound; it racks on game:resumed unless the raise ended first. */
  private pendingRaise: string | null = null;
  /** M10: the music system plays the wave / game over stings (in the theme's key, on its beat). */
  private stingsHandedOver = false;

  // --- enemies (M3) ---
  private enemySource: EnemyAudioSource | null = null;
  /** Listener position (update); without one every enemy sound counts as near. */
  private readonly listener = { x: 0, y: 0, z: 0 };
  private hasListener = false;
  /** Game time (sum of update dt): idle schedules and strikes follow the simulation, not the wall clock. */
  private gameTime = 0;
  private frame = 0;
  private readonly budgets = new Map<string, TypeBudget>();
  private readonly typeById = new Map<number, string>();
  private readonly voiceStates = new Map<number, EnemyVoiceState>();
  private readonly freeStates: EnemyVoiceState[] = [];
  /** Pending strikes (ring): enemy id, due game time (+∞ = free), position, sound, budget type. */
  private readonly strikeId = new Int32Array(E.maxPendingStrikes);
  private readonly strikeDue = new Float64Array(E.maxPendingStrikes).fill(Number.POSITIVE_INFINITY);
  private readonly strikePos = new Float32Array(E.maxPendingStrikes * 3);
  private readonly strikeSound: string[] = new Array<string>(E.maxPendingStrikes).fill('');
  private readonly strikeType: string[] = new Array<string>(E.maxPendingStrikes).fill('');
  private strikeNext = 0;
  private readonly strikeAt = { x: 0, y: 0, z: 0 };
  /** Recently hurt enemies (ring): id and wall-clock time of their last hit reaction. */
  private readonly hurtId = new Int32Array(E.hurtMerge.slots);
  private readonly hurtAt = new Float64Array(E.hurtMerge.slots).fill(Number.NEGATIVE_INFINITY);
  private hurtNext = 0;
  private readonly lastSpawn = { x: 0, y: 0, z: 0, time: Number.NEGATIVE_INFINITY, id: '' };
  /** M4 economy sounds (doors, box, perks, power-ups, seals, purchases). */
  readonly economy: EconomyAudio;
  /** M5 arsenal sounds (weapon loops, projectiles, fields, elements, grenades, abilities, forge). */
  readonly arsenal: ArsenalAudio;
  /** Gunshot layer spacing (AUDIO.arsenal.fireLayerMinInterval): last play per layer index, per weapon. */
  private readonly layerLastAt = new Float64Array(8).fill(Number.NEGATIVE_INFINITY);
  private layerWeapon = '';

  /**
   * Casing bounce hook with the VFX ClinkCallback signature (position, sound id, impact speed) –
   * pass it as `VfxDeps.onClink` directly.
   */
  readonly onCasingClink = (position: Vec3Like, soundId: string, impactSpeed: number): void => {
    this.playCasing(soundId, position, impactSpeed);
  };

  constructor(
    events: EventBus<GameEvents>,
    private readonly audio: AudioBridgeTarget,
    private readonly now: () => number = defaultClock,
    /** Cosmetic randomness (shared gunshot detune); tests inject a fixed source. */
    private readonly random: () => number = Math.random,
  ) {
    this.has = audio.has ? (id: string): boolean => audio.has!(id) : undefined;
    this.offs.push(
      events.on('player:footstep', (e) => {
        const gain = e.sprinting ? M.footstepSprintGain : e.crouched ? M.footstepCrouchGain : M.footstepGain;
        this.play(B.surfaceFootsteps[e.surface] ?? B.surfaceFootsteps.default, gain, B.footstepPitchVariance);
      }),
      events.on('player:jump', (e) => {
        this.play(e.double ? 'jump.double' : 'jump', M.jumpGain, B.jumpPitchVariance);
      }),
      events.on('player:land', (e) => {
        const L = MOVEMENT.landing;
        const gain =
          M.landGain *
          remapClamped(e.impactSpeed, L.minImpactSpeed, L.heavyImpactSpeed, B.landMinImpactGain, 1);
        this.play(e.heavy ? 'land.heavy' : 'land', gain, B.landPitchVariance);
        // Surface layer so a landing on grating sounds different from one on concrete.
        this.play(
          B.surfaceFootsteps[e.surface] ?? B.surfaceFootsteps.default,
          gain * B.landSurfaceLayerGain,
          B.footstepPitchVariance,
        );
      }),
      events.on('player:slideStart', (e) => this.startSlide(e.speed)),
      events.on('player:slideEnd', () => this.stopSlide()),
      events.on('player:stateChanged', (e) => {
        // Belt and braces: never leave the slide loop running after the slide state ends.
        if (e.from === 'slide' && e.to !== 'slide') this.stopSlide();
      }),
      events.on('player:teleported', () => this.stopSlide()),
      events.on('player:dash', () => this.play('dash', M.dashGain, B.dashPitchVariance)),
      events.on('player:mantle', () => this.play('mantle', M.mantleGain, B.mantlePitchVariance)),
      events.on('player:damaged', (e) => {
        const gain = B.hurtGain * remapClamped(e.amount, 0, B.hurtFullDamage, B.hurtMinGain, 1);
        this.play('hurt', gain, B.hurtPitchVariance);
      }),
      events.on('ui:console', (e) => this.play(e.open ? 'ui.click' : 'ui.back', B.uiGain, 0, 'ui')),
      // The ui bus keeps playing while the game is paused, so the pause menu clicks too.
      events.on('ui:menu', (e) => {
        // Bench menus sound through ArsenalAudio (drawer + chirp).
        if (isBenchMenu(e.menu)) return;
        if (e.open) {
          if (!B.menuSilentOpen.includes(e.menu)) this.play('ui.click', B.uiGain, 0, 'ui');
        } else if (!B.menuSilentClose.includes(e.menu)) this.play('ui.back', B.uiGain, 0, 'ui');
      }),
    );
    this.wireWeapons(events);
    this.wireEnemies(events);
    this.economy = new EconomyAudio(events, audio, now, random);
    this.arsenal = new ArsenalAudio(events, audio, now);
  }

  /** World sources of the M5 arsenal loops: drawn projectile positions, moving fields. */
  setArsenalSources(sources: ArsenalAudioSources): void {
    this.arsenal.setSources(sources);
  }

  /**
   * M10: the music system (audio/music) takes over the wave start / complete and game over stings;
   * without it (tools, tests) the bridge keeps playing its one-shots.
   */
  handOverStings(): void {
    this.stingsHandedOver = true;
  }

  /** World anchors of the economy sounds: doors, perk machines, the box, the power-up clock. */
  setEconomySources(sources: EconomyAudioSources): void {
    this.economy.setSources(sources);
  }

  /**
   * Casing clink (hook the VFX casing system's onClink here): positional, louder for faster
   * bounces, rate limited. `soundId` is CasingDef.clinkSound.
   */
  playCasing(soundId: string, position: Vec3Like, speed: number): void {
    if (!this.casingBucket.take(this.now())) return;
    const [lo, hi] = W.casingSpeedRange;
    const gain = W.casingGain * remapClamped(speed, lo, hi, W.casingMinGain, 1);
    this.playAt(soundId, position, gain, W.casingPitchVariance);
  }

  /**
   * Enemies whose footsteps and idle vocals update() polls (EnemyManager fits); null stops the
   * polling. Event-driven enemy sounds (spawn, alert, attacks, hits, deaths) work without it.
   */
  setEnemySource(source: EnemyAudioSource | null): void {
    this.enemySource = source;
  }

  /**
   * Per frame while the game runs (after the fixed ticks, with the frame's game dt): listener
   * position for the distance checks, due attack strikes, enemy footsteps and idle vocals.
   */
  update(dt: number, listener?: Vec3Like): void {
    if (listener) {
      this.listener.x = listener.x;
      this.listener.y = listener.y;
      this.listener.z = listener.z;
      this.hasListener = true;
    }
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this.gameTime += dt;
    this.frame++;
    this.updateStrikes();
    this.economy.update(dt, this.hasListener ? this.listener : null);
    this.arsenal.update(dt, this.hasListener ? this.listener : null);
    const list = this.enemySource?.enemies;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.alive) this.updateEnemy(e);
    }
    // Enemies removed without enemy:died (EnemyManager.clear): drop their state.
    if (this.voiceStates.size > list.length) this.sweepStates();
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.stopSlide();
    this.enemySource = null;
    this.economy.dispose();
    this.arsenal.dispose();
  }

  // -------------------------------------------------------------------------
  // Enemies / waves / run
  // -------------------------------------------------------------------------

  private wireEnemies(events: EventBus<GameEvents>): void {
    this.offs.push(
      events.on('enemy:spawned', (e) => {
        this.trackType(e.id, e.type);
        const def = getEnemyDef(e.type);
        if (!def) return;
        // One rift tear per burst: members emerge from the same rift a moment apart (the window
        // slides with them). A different tear (the tank's large one) always sounds.
        const now = this.now();
        const L = this.lastSpawn;
        const id = def.audio.spawn;
        const near =
          Math.hypot(e.position.x - L.x, e.position.y - L.y, e.position.z - L.z) < E.spawnMerge.distance;
        if (near && id === L.id && now - L.time < E.spawnMerge.seconds) {
          L.time = now;
          return;
        }
        if (this.playEnemy('spawn', e.type, id, e.position)) {
          L.x = e.position.x;
          L.y = e.position.y;
          L.z = e.position.z;
          L.time = now;
          L.id = id;
        }
      }),
      events.on('enemy:alert', (e) => {
        const def = getEnemyDef(e.type);
        if (def) this.playEnemy('alert', e.type, def.audio.alert, e.position);
      }),
      events.on('enemy:attack', (e) => {
        const a = getEnemyAttackDef(e.type, e.attack);
        if (a) this.playEnemy('attack', e.type, a.sound, e.position);
        const strike = E.strikes[e.type]?.[e.attack];
        if (strike !== undefined) this.scheduleStrike(e.id, e.type, strike, e.position, e.windup);
      }),
      events.on('enemy:staggered', (e) => {
        this.cancelStrikes(e.id);
        // The bigger reaction always sounds; hits right after it merge into it.
        this.noteHurt(e.id, this.now());
        const def = getEnemyDef(e.type);
        if (def) this.playEnemy('stagger', e.type, def.audio.hurt, e.position);
      }),
      events.on('enemy:died', (e) => {
        this.cancelStrikes(e.id);
        this.typeById.delete(e.id);
        this.releaseState(e.id);
        const def = getEnemyDef(e.type);
        if (def) this.playEnemy('death', e.type, def.audio.death, e.position);
      }),
      events.on('combat:damage', (e) => {
        if (e.killed || !(e.amount > 0)) return;
        const type = this.typeById.get(e.targetId) ?? this.lookupType(e.targetId);
        if (type === null) return;
        const def = getEnemyDef(type);
        if (!def || this.hurtMerged(e.targetId)) return;
        this.playEnemy('hurt', type, def.audio.hurt, e.point);
      }),
      events.on('wave:start', (e) => {
        if (this.stingsHandedOver) return;
        const s = ST.waveStart;
        const special = e.kind !== undefined && e.kind !== 'normal';
        this.play(s.id, s.gain, 0, s.bus, special ? s.specialPitch : 1);
      }),
      events.on('wave:complete', () => {
        if (this.stingsHandedOver) return;
        const s = ST.waveComplete;
        this.play(s.id, s.gain, 0, s.bus);
      }),
      events.on('player:died', () => {
        if (this.stingsHandedOver) return;
        const s = ST.gameOver;
        this.play(s.id, s.gain, 0, s.bus);
      }),
      events.on('run:restart', () => this.resetRun()),
    );
  }

  /**
   * Positional enemy sound through the budget of `budgetKey` (an enemy type or 'projectile').
   * Returns false when it was culled (too far) or lost the voice budget.
   */
  private playEnemy(
    kind: EnemyAudioKind,
    budgetKey: string,
    id: string,
    position: Vec3Like,
    gainScale = 1,
    maxDistance: number = E.kinds[kind].maxDistance,
  ): boolean {
    const K = E.kinds[kind];
    const d = this.hasListener
      ? Math.hypot(position.x - this.listener.x, position.y - this.listener.y, position.z - this.listener.z)
      : 0;
    if (!(d <= maxDistance)) return false;
    const b = this.budgetFor(budgetKey);
    const budget = kind === 'step' ? b.step : b.voice;
    if (!budget.admit(this.now(), d, K.priority, K.hold, E.preemptMargin)) return false;
    this.playAt(id, position, K.gain * gainScale, K.pitchVariance);
    return true;
  }

  private budgetFor(key: string): TypeBudget {
    let b = this.budgets.get(key);
    if (!b) {
      const def: EnemyAudioBudgetDef = Object.prototype.hasOwnProperty.call(E.budgets, key)
        ? E.budgets[key]!
        : E.defaultBudget;
      b = { def, voice: new VoiceBudget(def.voices), step: new VoiceBudget(def.stepVoices) };
      this.budgets.set(key, b);
    }
    return b;
  }

  /** Did enemy `id` just react to a hit (merge window)? Otherwise it is remembered now. */
  private hurtMerged(id: number): boolean {
    const now = this.now();
    for (let i = 0; i < this.hurtId.length; i++) {
      if (this.hurtId[i] === id && now - this.hurtAt[i]! < E.hurtMerge.seconds) return true;
    }
    this.noteHurt(id, now);
    return false;
  }

  private noteHurt(id: number, now: number): void {
    for (let i = 0; i < this.hurtId.length; i++) {
      if (this.hurtId[i] === id) {
        this.hurtAt[i] = now;
        return;
      }
    }
    const i = this.hurtNext;
    this.hurtNext = (i + 1) % this.hurtId.length;
    this.hurtId[i] = id;
    this.hurtAt[i] = now;
  }

  private trackType(id: number, type: string): void {
    // Enemies cleared without enemy:died leave entries behind: start over (lookupType refills).
    if (this.typeById.size >= E.maxTrackedIds) this.typeById.clear();
    this.typeById.set(id, type);
  }

  /** Type of a living enemy from the polled source (after the id table was rebuilt), else null. */
  private lookupType(id: number): string | null {
    const list = this.enemySource?.enemies;
    if (!list) return null;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.id === id && e.alive) {
        this.trackType(id, e.type);
        return e.type;
      }
    }
    return null;
  }

  private updateEnemy(e: EnemyAudioView): void {
    const st = this.stateOf(e);
    st.seen = this.frame;
    const b = this.budgetFor(e.type);
    const step = gaitStepIndex(e.pose.phase, b.def.stepsPerCycle);
    if (step !== st.step) {
      const first = st.step < 0;
      st.step = step;
      if (!first && e.pose.locomotion >= b.def.stepMinLocomotion) {
        const def = getEnemyDef(e.type);
        if (def)
          this.playEnemy('step', e.type, def.audio.step, e.position, b.def.stepGain, b.def.stepMaxDistance);
      }
    }
    if (this.gameTime >= st.nextIdle) {
      const def = getEnemyDef(e.type);
      if (!def) {
        st.nextIdle = Number.POSITIVE_INFINITY;
        return;
      }
      this.playEnemy('idle', e.type, def.audio.idle, e.position);
      const [lo, hi] = def.audio.idleInterval;
      st.nextIdle = this.gameTime + lo + (hi - lo) * this.random();
    }
  }

  private stateOf(e: EnemyAudioView): EnemyVoiceState {
    let st = this.voiceStates.get(e.id);
    if (!st) {
      st = this.freeStates.pop() ?? { step: -1, nextIdle: 0, seen: 0 };
      st.step = -1;
      // First idle somewhere within the interval: a fresh burst does not chitter in unison.
      const hi = getEnemyDef(e.type)?.audio.idleInterval[1] ?? 0;
      st.nextIdle = this.gameTime + hi * this.random();
      this.voiceStates.set(e.id, st);
    }
    return st;
  }

  private releaseState(id: number): void {
    const st = this.voiceStates.get(id);
    if (!st) return;
    this.voiceStates.delete(id);
    this.freeStates.push(st);
  }

  private sweepStates(): void {
    for (const [id, st] of this.voiceStates) {
      if (st.seen === this.frame) continue;
      this.voiceStates.delete(id);
      this.freeStates.push(st);
    }
  }

  private scheduleStrike(id: number, type: string, sound: string, position: Vec3Like, windup: number): void {
    // The oldest pending strike is overwritten when the ring is full.
    const i = this.strikeNext;
    this.strikeNext = (i + 1) % this.strikeDue.length;
    this.strikeId[i] = id;
    this.strikeDue[i] = this.gameTime + (Number.isFinite(windup) ? Math.max(0, windup) : 0);
    this.strikePos[i * 3] = position.x;
    this.strikePos[i * 3 + 1] = position.y;
    this.strikePos[i * 3 + 2] = position.z;
    this.strikeSound[i] = sound;
    this.strikeType[i] = type;
  }

  private cancelStrikes(id: number): void {
    for (let i = 0; i < this.strikeDue.length; i++) {
      if (this.strikeId[i] === id) this.strikeDue[i] = Number.POSITIVE_INFINITY;
    }
  }

  private updateStrikes(): void {
    for (let i = 0; i < this.strikeDue.length; i++) {
      if (this.strikeDue[i]! > this.gameTime) continue;
      this.strikeDue[i] = Number.POSITIVE_INFINITY;
      const p = this.strikeAt;
      if (!this.enemyPosition(this.strikeId[i]!, p)) {
        p.x = this.strikePos[i * 3]!;
        p.y = this.strikePos[i * 3 + 1]!;
        p.z = this.strikePos[i * 3 + 2]!;
      }
      this.playEnemy('strike', this.strikeType[i]!, this.strikeSound[i]!, p);
    }
  }

  /** Current position of a living enemy from the polled source (the blow lands where it is now). */
  private enemyPosition(id: number, out: { x: number; y: number; z: number }): boolean {
    const list = this.enemySource?.enemies;
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.id !== id || !e.alive) continue;
      out.x = e.position.x;
      out.y = e.position.y;
      out.z = e.position.z;
      return true;
    }
    return false;
  }

  /**
   * A new run starts (run:restart, or main menu → start, which emits none – the composition root
   * calls this): forget every enemy, pending strike and busy voice. Blows still winding up when
   * the death sequence froze the game would otherwise land in the new run.
   */
  resetRun(): void {
    this.typeById.clear();
    for (const [id] of this.voiceStates) this.releaseState(id);
    this.strikeDue.fill(Number.POSITIVE_INFINITY);
    this.hurtAt.fill(Number.NEGATIVE_INFINITY);
    for (const b of this.budgets.values()) {
      b.voice.reset();
      b.step.reset();
    }
    this.lastSpawn.time = Number.NEGATIVE_INFINITY;
    this.economy.resetRun();
    this.arsenal.resetRun();
  }

  // -------------------------------------------------------------------------
  // Weapons / combat
  // -------------------------------------------------------------------------

  private wireWeapons(events: EventBus<GameEvents>): void {
    const has = this.has;
    this.offs.push(
      events.on('weapon:fired', (e) => {
        // Beam damage ticks (10–12/s): the beam loop is their sound (ArsenalAudio).
        if (this.arsenal.absorbsFire(e.weaponId)) return;
        const layers = fireSoundLayers(e.weaponId);
        // One pitch for all layers of a shot: independent per-layer detune smears the transient
        // (crack, body and mechanics drift apart) and reads as several guns (cosmetic randomness).
        const pitch = 1 + (this.random() * 2 - 1) * W.firePitchVariance;
        const now = this.now();
        if (e.weaponId !== this.layerWeapon) {
          this.layerWeapon = e.weaponId;
          this.layerLastAt.fill(Number.NEGATIVE_INFINITY);
        }
        // Tails follow the room: shorter and quieter in small rooms, longer in halls.
        const room = roomTail(this.audio.activeReverbZone);
        for (let i = 0; i < layers.length; i++) {
          if (!this.layerDue(i, now)) continue;
          const id = layers[i]!;
          const tail = id.startsWith(AR.tailPrefix);
          const gain = W.fireGain * fireLayerGain(i) * (tail ? room.gain : 1);
          this.play(id, gain, 0, 'sfx', tail ? pitch * room.pitch : pitch);
        }
        const extra = extraFireSoundLayers(e.weaponId);
        for (let i = 0; i < extra.length; i++) {
          this.play(extra[i]!, W.fireGain * W.extraLayerGain, W.handlingPitchVariance);
        }
        const magSize = this.magSizes.get(e.weaponId) ?? getWeaponDef(e.weaponId)?.magazine ?? 0;
        const threshold = lowAmmoThreshold(magSize);
        if (threshold > 0 && e.ammoInMag >= 0 && e.ammoInMag <= threshold) {
          const L = W.lowAmmo;
          this.play(L.id, L.gain, 0, 'sfx', 1 + L.pitchRise * (1 - e.ammoInMag / threshold));
        }
      }),
      events.on('weapon:ammoChanged', (e) => {
        if (e.magSize > 0) this.magSizes.set(e.weaponId, e.magSize);
      }),
      events.on('weapon:dryFire', (e) => {
        this.play(weaponSoundId(e.weaponId, 'dry', has), W.dryGain, W.handlingPitchVariance);
      }),
      // The rack plays when the weapon actually comes up (weapon:equipStart of a switch comes at
      // the start of the holster). The boot loadout is raised behind the start menu, before the
      // gesture that unlocks audio: hold its rack until the game runs and the raise animates.
      events.on('weapon:raiseStart', (e) => {
        if (this.gamePaused || this.audio.unlocked === false) {
          this.pendingRaise = e.weaponId;
          return;
        }
        this.pendingRaise = null;
        this.playEquip(e.weaponId);
      }),
      // A raise that finished (e.g. `?autostart` never pauses) or was cut short racks no more.
      events.on('weapon:equipped', () => {
        this.pendingRaise = null;
      }),
      events.on('game:paused', () => {
        this.gamePaused = true;
      }),
      events.on('game:resumed', () => {
        this.gamePaused = false;
        const id = this.pendingRaise;
        this.pendingRaise = null;
        if (id !== null) this.playEquip(id);
      }),
      events.on('weapon:holsterStart', (e) => {
        this.pendingRaise = null;
        this.play(weaponSoundId(e.weaponId, 'holster', has), W.holsterGain, W.handlingPitchVariance);
      }),
      events.on('weapon:reloadStart', (e) => {
        this.play(weaponSoundId(e.weaponId, 'reloadStart', has), W.reloadStartGain, W.handlingPitchVariance);
      }),
      events.on('weapon:reloadStep', (e) => {
        this.play(reloadStepSoundId(e.weaponId, e.step, has), W.reloadStepGain, W.handlingPitchVariance);
      }),
      events.on('weapon:inspect', (e) => {
        this.play(weaponSoundId(e.weaponId, 'inspect', has), W.inspectGain, W.handlingPitchVariance);
      }),
      events.on('weapon:melee', (e) => {
        this.play(weaponSoundId(e.weaponId, 'melee', has), W.meleeGain, W.handlingPitchVariance);
      }),
      events.on('combat:impact', (e) => {
        // Enemy projectiles with their own impact (acid splash) replace the surface sound.
        const splash = e.kind === 'projectile' ? E.projectileImpacts[e.weaponId] : undefined;
        if (splash !== undefined) {
          this.playEnemy('splash', PROJECTILE_BUDGET, splash, e.point);
          return;
        }
        // A projectile that stops on a surface / body is no bounce (projectile:impact follows).
        if (e.kind === 'projectile') this.arsenal.noteProjectileImpact(e.weaponId);
        const kindGain = W.impactKindGain[e.kind] ?? 1;
        if (!(kindGain > 0)) return;
        if (e.kind === 'beam' && !this.arsenal.takeBeamImpact()) return;
        if (!this.impactBucket.take(this.now())) return;
        // Energy weapons hit with their own impact profile (impact.plasma, impact.shock …).
        const energy = this.arsenal.impactSoundFor(e.weaponId);
        if (energy !== null) {
          const gain = W.impactGain * kindGain * AR.impacts.energyGain;
          this.playAt(energy, e.point, gain, W.impactPitchVariance);
        } else {
          this.playAt(impactSoundId(e.surface), e.point, W.impactGain * kindGain, W.impactPitchVariance);
        }
        // The blow itself (2D): only melee impacts come from the player's own arm in M2.
        if (e.kind === 'melee') this.play(W.meleeHitId, W.meleeHitGain, W.handlingPitchVariance);
      }),
      events.on('combat:explosion', (e) => {
        // Chains of small blasts (explosive rounds, shatters) share a token bucket.
        if (!this.arsenal.takeExplosion()) return;
        const X = W.explosion;
        const size = e.radius / X.referenceRadius;
        const k = Number.isFinite(size) ? Math.min(X.radiusGain[1], Math.max(X.radiusGain[0], size)) : 1;
        this.playAt(this.arsenal.explosionSound(e.audio, e.element), e.position, X.gain * k, X.pitchVariance);
      }),
      events.on('combat:damage', (e) => {
        if (e.source !== 'player' || e.killed || !(e.amount > 0)) return;
        const now = this.now();
        if (now - this.lastHitAt < W.hitMinInterval) return;
        this.lastHitAt = now;
        if (e.zone === 'shield') {
          this.play(W.hitSounds.hit, W.shieldHitGain, 0, 'ui', W.shieldHitPitch);
        } else {
          const crit = isCritZone(e.zone);
          this.play(hitSoundId(e.zone, false), crit ? W.critGain : W.hitGain, 0, 'ui');
        }
      }),
      events.on('combat:kill', (e) => {
        if (e.source !== 'player') return;
        this.lastHitAt = this.now();
        this.play(W.hitSounds.kill, W.killGain, 0, 'ui');
        if (isCritZone(e.zone)) this.play(W.hitSounds.crit, W.critKillLayerGain, 0, 'ui');
      }),
    );
  }

  /** May fire layer `index` of the current weapon play now (AUDIO.arsenal.fireLayerMinInterval)? */
  private layerDue(index: number, now: number): boolean {
    const gaps = AR.fireLayerMinInterval;
    const gap = gaps.length === 0 ? 0 : gaps[Math.min(index, gaps.length - 1)]!;
    const slot = Math.min(index, this.layerLastAt.length - 1);
    if (now - this.layerLastAt[slot]! < gap) return false;
    this.layerLastAt[slot] = now;
    return true;
  }

  private playEquip(weaponId: string): void {
    this.play(weaponSoundId(weaponId, 'equip', this.has), W.equipGain, W.handlingPitchVariance);
  }

  private play(
    id: string,
    volume: number,
    pitchVariance: number,
    bus: PlayOptions['bus'] = 'sfx',
    pitch = 1,
  ): void {
    const o = this.opts;
    o.volume = volume;
    o.pitchVariance = pitchVariance;
    o.bus = bus;
    o.pitch = pitch;
    this.audio.play(id, o);
  }

  private playAt(id: string, position: Vec3Like, volume: number, pitchVariance: number): void {
    const o = this.posOpts;
    o.position.x = position.x;
    o.position.y = position.y;
    o.position.z = position.z;
    o.volume = volume;
    o.pitchVariance = pitchVariance;
    o.pitch = 1;
    o.bus = 'sfx';
    this.audio.play(id, o);
  }

  private startSlide(speed: number): void {
    this.stopSlide();
    const S = MOVEMENT.slide;
    const o = this.loopOpts;
    o.volume = M.slideGain * remapClamped(speed, S.minStartSpeed, S.maxSpeed, B.slideMinSpeedGain, 1);
    o.bus = 'sfx';
    o.fadeIn = B.slideFadeIn;
    o.maxDuration = B.slideMaxSeconds;
    this.slideHandle = this.audio.startLoop('slide', o);
  }

  private stopSlide(): void {
    if (this.slideHandle === 0) return;
    this.audio.stopLoop(this.slideHandle, B.slideFadeOut);
    this.slideHandle = 0;
  }
}
