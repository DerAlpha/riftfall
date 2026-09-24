/** Audio engine tuning. Volumes are linear gain 0..1, times in seconds. */
import type { FleshSurface, HitZone, ImpactKind, SurfaceType } from '../core/events';

export const AUDIO = {
  buses: ['music', 'sfx', 'voice', 'ui'] as const,
  /** Music is ducked by this amount (linear gain multiplier) while voice lines play. */
  voiceDuckGain: 0.35,
  duckAttack: 0.08,
  duckRelease: 0.6,
  /** Maximum simultaneous one-shot voices; the quietest/oldest is stolen beyond that. */
  maxVoices: 48,
  /** Positional audio (PannerNode) defaults. */
  panner: {
    model: 'HRTF' as PanningModelType,
    distanceModel: 'inverse' as DistanceModelType,
    refDistance: 2,
    maxDistance: 80,
    rolloffFactor: 1.2,
  },
  /** Algorithmic reverb impulse per zone: seconds of decay and wet level. */
  reverbZones: {
    small: { decay: 0.6, wet: 0.12, preDelay: 0.005 },
    medium: { decay: 1.2, wet: 0.18, preDelay: 0.01 },
    large: { decay: 2.2, wet: 0.24, preDelay: 0.02 },
    hangar: { decay: 3.2, wet: 0.28, preDelay: 0.03 },
  },
  /** Master limiter to avoid clipping when many sounds overlap. */
  limiter: { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.12 },
  /** Movement sound levels (procedural synthesis fallback). */
  movement: {
    footstepGain: 0.32,
    footstepSprintGain: 0.42,
    footstepCrouchGain: 0.14,
    jumpGain: 0.28,
    landGain: 0.45,
    slideGain: 0.35,
    dashGain: 0.5,
    mantleGain: 0.3,
  },

  // --- engine behaviour ------------------------------------------------------
  context: {
    latencyHint: 'interactive' as AudioContextLatencyCategory,
  },
  /** Volume changes (settings, ducking) approach their target within about this time. */
  gainSmoothing: 0.08,
  /** Fade of the game buses (music/sfx/voice) on pause and back in after resume. The ui bus keeps playing. */
  pauseFade: 0.06,
  /**
   * The context is suspended this long after pausing (no audio CPU in menus). Longer than pauseFade so
   * the fade has fully settled (no click); UI sounds still playing then postpone the suspend.
   */
  pauseSuspendDelay: 0.15,
  /** Fade when the tab goes to the background (muteInBackground). */
  backgroundFade: 0.15,
  /** Listener position/orientation ramp: about one frame, avoids HRTF zipper noise on fast turns. */
  listenerRamp: 1 / 60,
  /** Listener changes below this (m / unit-vector components) are not scheduled. */
  listenerEpsilon: 1e-4,
  /** Fade-out of a stolen voice before it stops (prevents clicks). */
  stealFade: 0.02,
  /** Voices with a requested volume this close count as equally loud when choosing one to steal. */
  stealVolumeEpsilon: 0.01,
  /** Default fades of looping sounds. */
  loopFadeIn: 0.08,
  loopFadeOut: 0.18,
  /** Crossfade between reverb zones (setReverbZone). */
  reverbCrossfade: 1.2,
  /** Impulse response shaping (see audio/reverb.ts). */
  reverbIr: {
    /** Discrete early reflections before the diffuse tail. */
    earlyReflections: 7,
    /** Early reflections arrive within this window after the pre-delay. */
    earlyWindow: 0.05,
    earlyGain: 0.55,
    /** Diffuse tail fade-in (avoids a hard onset edge). */
    tailFadeIn: 0.006,
    /** One-pole low-pass coefficient over the tail: bright at the start, dark at the end (air absorption). */
    brightnessStart: 0.85,
    brightnessEnd: 0.12,
  },

  /** Event → sound mapping (AudioEventBridge). */
  bridge: {
    /** Footstep sound per surface; unknown surfaces use `footstep.default`. */
    surfaceFootsteps: {
      metal: 'footstep.metal',
      concrete: 'footstep.concrete',
      grate: 'footstep.grate',
      rubber: 'footstep.rubber',
      glass: 'footstep.default',
      default: 'footstep.default',
    } satisfies Record<SurfaceType, string>,
    footstepPitchVariance: 0.07,
    jumpPitchVariance: 0.05,
    landPitchVariance: 0.06,
    /** Land gain multiplier at MOVEMENT.landing.minImpactSpeed (1 at heavyImpactSpeed). */
    landMinImpactGain: 0.55,
    /** A footstep of the landing surface is layered under the land thud at this relative gain. */
    landSurfaceLayerGain: 0.7,
    dashPitchVariance: 0.04,
    mantlePitchVariance: 0.05,
    /** Slide loop fades and a safety stop in case `player:slideEnd` never arrives. */
    slideFadeIn: 0.05,
    slideFadeOut: 0.22,
    slideMaxSeconds: 4,
    /** Slide loop volume at the slide start speed range (MOVEMENT.slide.minStartSpeed .. maxSpeed). */
    slideMinSpeedGain: 0.75,
    hurtGain: 0.55,
    /** Damage at which the hurt sound reaches full gain; minimum relative gain for tiny hits. */
    hurtFullDamage: 40,
    hurtMinGain: 0.45,
    hurtPitchVariance: 0.08,
    uiGain: 0.6,
    /**
     * Menus (ui:menu `menu` names) that close without the "back" sound – the start screen closes
     * into gameplay, the game over screen into a new run or the start screen.
     */
    menuSilentClose: ['start', 'gameover'] as readonly string[],
    /** Menus that open without the click – the game over screen opens under the game over sting. */
    menuSilentOpen: ['gameover'] as readonly string[],
  },

  /** Procedural synthesis (audio/synth.ts). */
  synth: {
    /** Seed prefix: every render is deterministic across sessions. */
    seed: 'riftfall-synth',
    footstepVariants: 4,
    /** Silence between variants rendered in one offline pass (s). */
    variantGap: 0.05,
    /** Peak level of rendered buffers before per-sound trims. */
    normalizePeak: 0.89,
    /** Trailing audio below this level is trimmed from one-shots. */
    trimThreshold: 0.001,
    /** Short fade at the end of one-shots against clicks (s). */
    endFade: 0.004,
    /** Seamless slide loop: rendered length and crossfade folded into the loop point. */
    slideLoopSeconds: 1.6,
    slideLoopCrossfade: 0.3,
    /** Length of the shared noise tables (s). */
    noiseSeconds: 2,
    /** Parallel offline renders while warming the bank after unlock. */
    renderConcurrency: 3,
    /**
     * OfflineAudioContext needs no user gesture, so the bank is pre-rendered at this rate while the game
     * loads (most devices run at 48 kHz). A context with another rate re-renders in the background and
     * plays the resampled pre-rendered sounds meanwhile.
     */
    prewarmSampleRate: 48000,
    /** Variants per gunshot id (full-auto needs more to avoid the machine-gun effect) and per impact. */
    weaponFireVariants: 5,
    impactVariants: 4,
  },

  /** Weapon / combat sound mapping and levels (AudioEventBridge, sounds in audio/weaponSynth.ts). */
  weapons: {
    /** Gunshot layers (WeaponAudioDef.fire order: body, mechanical, tail); later layers reuse the last gain. */
    fireGain: 0.9,
    fireLayerGains: [1, 0.62, 0.5] as readonly number[],
    firePitchVariance: 0.035,
    /** Gain of WeaponAudioDef.extraFire layers (e.g. the SG-12 pump cycle), relative to fireGain. */
    extraLayerGain: 0.7,
    /** Mechanical "last rounds" tick: from ceil(magazine × fraction) rounds (at most maxRounds) down. */
    lowAmmo: { id: 'weapon.lowAmmo', fraction: 0.25, maxRounds: 6, gain: 0.3, pitchRise: 0.35 },
    dryGain: 0.55,
    equipGain: 0.5,
    holsterGain: 0.4,
    reloadStartGain: 0.45,
    reloadStepGain: 0.62,
    inspectGain: 0.4,
    meleeGain: 0.55,
    meleeHitId: 'weapon.melee.hit',
    meleeHitGain: 0.8,
    handlingPitchVariance: 0.04,
    /** Positional impact sounds per surface (combat:impact). */
    impactSounds: {
      metal: 'impact.metal',
      concrete: 'impact.concrete',
      grate: 'impact.grate',
      rubber: 'impact.rubber',
      glass: 'impact.glass',
      default: 'impact.concrete',
      flesh: 'impact.flesh',
      slime: 'impact.slime',
      armor: 'impact.metal',
      shield: 'impact.shield',
    } satisfies Record<SurfaceType | FleshSurface, string>,
    impactGain: 0.62,
    /**
     * Per-kind gain multipliers (pellets: nine at once; melee: one heavy blow). Explosion impacts
     * are silent: the blast itself sounds once through combat:explosion (`explosion` below).
     */
    impactKindGain: {
      bullet: 1,
      pellet: 0.55,
      projectile: 1,
      melee: 1.2,
      explosion: 0,
      beam: 0.6,
    } satisfies Record<ImpactKind, number>,
    impactPitchVariance: 0.09,
    /**
     * Explosions (combat:explosion): positional; gain × radius / referenceRadius clamped to
     * radiusGain (bigger blasts are louder, the engine's distance model attenuates).
     */
    explosion: {
      id: 'explosion',
      gain: 0.85,
      referenceRadius: 4,
      radiusGain: [0.5, 1.4] as const,
      pitchVariance: 0.06,
    },
    /** Token bucket for impact sounds: burst capacity and refill per second (shotgun blasts, walls of lead). */
    impactBurst: 5,
    impactRefillPerSecond: 45,
    /** Casing clinks (VFX onClink callback → AudioEventBridge.playCasing). */
    casingGain: 0.32,
    /** Clink speed (m/s) mapped to [casingMinGain, 1]. */
    casingSpeedRange: [0.5, 4] as const,
    casingMinGain: 0.35,
    casingPitchVariance: 0.12,
    casingBurst: 4,
    casingRefillPerSecond: 16,
    /** Hit feedback (ui bus: dry and crisp). Only the player's own hits (source 'player') sound. */
    hitSounds: {
      hit: 'ui.hitmarker',
      crit: 'ui.headshot',
      kill: 'ui.kill',
    },
    hitGain: 0.42,
    critGain: 0.5,
    killGain: 0.62,
    /** Head/weakpoint kills layer the crit ding under the kill sound at this gain. */
    critKillLayerGain: 0.35,
    /** Shield hits: the hitmarker plays lower and quieter ("blocked"). */
    shieldHitPitch: 0.72,
    shieldHitGain: 0.3,
    /** Zones that count as critical hits (sound + HUD color). */
    critZones: ['head', 'weakpoint'] as readonly HitZone[],
    /** Hit sounds closer together than this are merged (s). */
    hitMinInterval: 0.03,
  },

  /**
   * Enemy sounds (M3, AudioEventBridge; recipes in audio/enemySynth.ts, ids in defs/enemies
   * `audio` / attack `sound`). Every enemy sound is positional (HRTF) and passes a voice budget
   * per enemy type: a request farther than its kind's `maxDistance` from the listener is dropped;
   * with every voice busy, it replaces the busy voice of the lowest priority / farthest from the
   * listener if it outranks it (higher priority, or the same priority and `preemptMargin` m
   * nearer), else it is dropped – 60 enemies never flood the engine, the nearest are heard.
   * `hold` is how long a request occupies its budget voice (s, about the audible length).
   */
  enemies: {
    kinds: {
      spawn: { gain: 0.7, pitchVariance: 0.06, maxDistance: 55, priority: 2, hold: 1 },
      alert: { gain: 0.85, pitchVariance: 0.08, maxDistance: 70, priority: 3, hold: 0.9 },
      /** Attack wind-up (enemy:attack, the attack def's `sound`). */
      attack: { gain: 0.75, pitchVariance: 0.07, maxDistance: 45, priority: 3, hold: 0.5 },
      /** The blow itself at the end of the wind-up (`strikes` below). */
      strike: { gain: 0.95, pitchVariance: 0.05, maxDistance: 60, priority: 4, hold: 0.35 },
      /** Enemy projectile impacts (`projectileImpacts` below). */
      splash: { gain: 0.8, pitchVariance: 0.08, maxDistance: 45, priority: 3, hold: 0.5 },
      /** Hit reactions (combat:damage on an enemy) and staggers (enemy:staggered). */
      hurt: { gain: 0.5, pitchVariance: 0.1, maxDistance: 35, priority: 1, hold: 0.25 },
      stagger: { gain: 0.7, pitchVariance: 0.08, maxDistance: 50, priority: 2, hold: 0.4 },
      death: { gain: 0.85, pitchVariance: 0.08, maxDistance: 60, priority: 4, hold: 0.6 },
      /** Idle vocals every defs/enemies `audio.idleInterval` seconds (game time) per enemy. */
      idle: { gain: 0.38, pitchVariance: 0.12, maxDistance: 24, priority: 0, hold: 1 },
      /** Footsteps: per-type budgets, gains and distances below. */
      step: { gain: 0.42, pitchVariance: 0.1, maxDistance: 22, priority: 0, hold: 0.15 },
    },
    /**
     * Voices for vocals/actions and, separately, for footsteps per enemy type (`defaultBudget` for
     * types without an entry and for enemy projectiles). Footsteps fall `stepsPerCycle` times per
     * gait cycle (EnemyPose.phase, 2π per stride) while pose.locomotion ≥ stepMinLocomotion.
     */
    defaultBudget: {
      voices: 4,
      stepVoices: 2,
      stepsPerCycle: 2,
      stepMinLocomotion: 0.35,
      stepGain: 1,
      stepMaxDistance: 22,
    } satisfies EnemyAudioBudgetDef,
    budgets: {
      swarmer: {
        voices: 6,
        stepVoices: 3,
        stepsPerCycle: 2,
        stepMinLocomotion: 0.35,
        stepGain: 0.8,
        stepMaxDistance: 18,
      },
      spitter: {
        voices: 4,
        stepVoices: 2,
        stepsPerCycle: 2,
        stepMinLocomotion: 0.35,
        stepGain: 0.9,
        stepMaxDistance: 20,
      },
      tank: {
        voices: 3,
        stepVoices: 2,
        stepsPerCycle: 2,
        stepMinLocomotion: 0.2,
        stepGain: 1.6,
        stepMaxDistance: 45,
      },
    } as Readonly<Record<string, EnemyAudioBudgetDef>>,
    /** A nearer request must be at least this much nearer (m) to replace a busy voice of equal priority. */
    preemptMargin: 2,
    /**
     * Hit reactions of ONE enemy merge within `seconds` (a shotgun blast is up to nine hits in the
     * same tick; a rifle burst would chain hurts). `slots`: recently hurt enemies remembered.
     */
    hurtMerge: { seconds: 0.16, slots: 8 },
    /**
     * Rift tears of one burst merge: a spawn with the same tear sound within this time (s, sliding
     * with each merged member) and distance (m) of the last one is silent.
     */
    spawnMerge: { seconds: 0.9, distance: 6 },
    /**
     * The blow of an attack, played when its wind-up ends (enemy:attack `windup`, game time) at the
     * attacker's then position; a stagger or death during the wind-up cancels it. type → attack → id.
     */
    strikes: {
      swarmer: { bite: 'enemy.swarmer.snap' },
      spitter: { spit: 'enemy.spitter.spit.launch', swipe: 'enemy.claw.swipe' },
      tank: { slam: 'enemy.tank.slam.impact', swipe: 'enemy.claw.swipe.heavy' },
    } as Readonly<Record<string, Readonly<Record<string, string>>>>,
    /** Pending strikes (preallocated ring; more overlapping wind-ups drop the oldest). */
    maxPendingStrikes: 24,
    /** Projectile impacts (combat:impact kind 'projectile', by weaponId) with their own sound instead of the surface impact. */
    projectileImpacts: { 'spitter.acid': 'enemy.acid.splash' } as Readonly<Record<string, string>>,
    /** Enemy ids remembered for hit sounds (enemy:spawned → type); beyond this the table is rebuilt. */
    maxTrackedIds: 512,
  },

  /**
   * Musical stings (wave / run flow). The game over sting starts at the player's death and rides
   * the ui bus: the game pauses under the game over screen and the music bus fades with it.
   * `specialPitch`: wave starts of special kinds (swarm / tank waves) play lower.
   */
  stings: {
    waveStart: { id: 'sting.wave.start', gain: 0.8, bus: 'music', specialPitch: 0.89 },
    waveComplete: { id: 'sting.wave.complete', gain: 0.65, bus: 'music' },
    gameOver: { id: 'sting.gameover', gain: 0.9, bus: 'ui' },
  },
} as const;

export interface EnemyAudioBudgetDef {
  /** Simultaneous vocal/action sounds of this type. */
  readonly voices: number;
  /** Simultaneous footsteps of this type. */
  readonly stepVoices: number;
  readonly stepsPerCycle: number;
  readonly stepMinLocomotion: number;
  /** Footstep gain multiplier (on AUDIO.enemies.kinds.step.gain) and audible distance (m). */
  readonly stepGain: number;
  readonly stepMaxDistance: number;
}

export type EnemyAudioKind = keyof typeof AUDIO.enemies.kinds;

export type ReverbZone = keyof typeof AUDIO.reverbZones;
