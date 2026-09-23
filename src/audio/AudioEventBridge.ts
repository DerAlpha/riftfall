/**
 * Maps gameplay/UI events to sounds. Player sounds are 2D (the listener sits in the player's
 * head, HRTF would only smear them); world sounds (impacts, casing clinks) pass `position`.
 * PlayOptions objects are reused for every call – the engine reads them synchronously.
 *
 * Weapons (M2): gunshot layers come from WeaponDef.audio (data-driven) and share one random detune
 * per shot, plus a mechanical "last rounds" tick; handling sounds prefer the per-weapon id `weapon.<id>.<key>` when the engine
 * knows it and fall back to the def's (possibly shared) id. Impacts play positionally (HRTF) through
 * a token bucket (a shotgun blast is nine impacts). The player's own hits get dry UI-bus feedback
 * (hitmarker tick, headshot ding, kill punch). Casing clinks come from the VFX casing callback via
 * playCasing().
 */
import type { PlayOptions } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { FleshSurface, GameEvents, HitZone, SurfaceType, Vec3Like } from '../core/events';
import { AUDIO } from '../defs/audio';
import { MOVEMENT } from '../defs/movement';
import { getWeaponDef, type ReloadStep } from '../defs/weapons';
import { remapClamped } from './dsp';
import type { LoopOptions } from './AudioEngine';

/** The engine surface the bridge needs (AudioEngine implements it; tests use a fake). */
export interface AudioBridgeTarget {
  play(id: string, opts?: PlayOptions): void;
  startLoop(id: string, opts?: LoopOptions): number;
  stopLoop(handle: number, fadeSeconds?: number): void;
  /** True if `id` resolves to a sound (asset or procedural). Optional: without it def ids are used as given. */
  has?(id: string): boolean;
}

const M = AUDIO.movement;
const B = AUDIO.bridge;
const W = AUDIO.weapons;

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

/** Token bucket rate limiter (`now` in seconds). */
export class TokenBucket {
  private tokens: number;
  private last = Number.NaN;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  take(now: number): boolean {
    if (Number.isFinite(this.last) && now > this.last) {
      this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerSecond);
    }
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

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
        if (e.open) this.play('ui.click', B.uiGain, 0, 'ui');
        else if (!B.menuSilentClose.includes(e.menu)) this.play('ui.back', B.uiGain, 0, 'ui');
      }),
    );
    this.wireWeapons(events);
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

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.stopSlide();
  }

  // -------------------------------------------------------------------------
  // Weapons / combat
  // -------------------------------------------------------------------------

  private wireWeapons(events: EventBus<GameEvents>): void {
    const has = this.has;
    this.offs.push(
      events.on('weapon:fired', (e) => {
        const layers = fireSoundLayers(e.weaponId);
        // One pitch for all layers of a shot: independent per-layer detune smears the transient
        // (crack, body and mechanics drift apart) and reads as several guns (cosmetic randomness).
        const pitch = 1 + (this.random() * 2 - 1) * W.firePitchVariance;
        for (let i = 0; i < layers.length; i++) {
          this.play(layers[i]!, W.fireGain * fireLayerGain(i), 0, 'sfx', pitch);
        }
        const extra = W.extraFireLayers[e.weaponId];
        if (extra) {
          for (let i = 0; i < extra.length; i++) {
            this.play(extra[i]!, W.fireGain * W.extraLayerGain, W.handlingPitchVariance);
          }
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
      events.on('weapon:equipStart', (e) => {
        this.play(weaponSoundId(e.weaponId, 'equip', has), W.equipGain, W.handlingPitchVariance);
      }),
      events.on('weapon:holsterStart', (e) => {
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
        const kindGain = W.impactKindGain[e.kind] ?? 1;
        if (!(kindGain > 0) || !this.impactBucket.take(this.now())) return;
        this.playAt(impactSoundId(e.surface), e.point, W.impactGain * kindGain, W.impactPitchVariance);
        // The blow itself (2D): only melee impacts come from the player's own arm in M2.
        if (e.kind === 'melee') this.play(W.meleeHitId, W.meleeHitGain, W.handlingPitchVariance);
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
