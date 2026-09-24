/**
 * M7 traps (src/traps): purchasable activation panels, active time + cooldown, and four kinds –
 * electric fence ("Elektrozaun"), ceiling / floor sentry turret ("Geschützturm"), ventilation
 * rotor ("Ventilator") and flame vent ("Flammenschlot"). Damage goes through CombatWorld with
 * source 'trap' (no points; kills are counted as trap kills). Traps never block the navmesh:
 * enemies walk into them.
 *
 * Placement (TrapSlotDef) comes from the level (MapLevelInstance.trapSlots) or, for maps without
 * level data, from TRAP_SLOTS[mapId]. Meters, seconds, degrees where noted; colors linear RGB.
 *
 * Panel convention (like wall buys): `panel.position` is the center of the panel ON the wall face,
 * `panel.facing` the interior direction the face looks to.
 */
import type { Rgb } from './interactables';
import type { Facing, Vec3Tuple } from './level';
import type { LightFlashDef } from './vfx';

export type TrapKind = 'fence' | 'turret' | 'fan' | 'flame';

export const TRAP_KINDS: readonly TrapKind[] = ['fence', 'turret', 'fan', 'flame'];

interface TrapSlotBase {
  readonly id: string;
  /** Zone the trap belongs to (documentation, dev console; panels work wherever they are reached). */
  readonly zone: string;
  /** Activation panel on a wall face. */
  readonly panel: { readonly position: Vec3Tuple; readonly facing: Facing };
  /** Price override (default TRAPS[kind].price). */
  readonly price?: number;
  /** Active time / cooldown overrides (s). */
  readonly duration?: number;
  readonly cooldown?: number;
}

/** Arc barrier between two emitter posts standing on the floor (a corridor's width). */
export interface FenceSlotDef extends TrapSlotBase {
  readonly kind: 'fence';
  /** Floor points of the two posts (the arcs span the segment between them). */
  readonly a: Vec3Tuple;
  readonly b: Vec3Tuple;
  /** Arc height (default TRAPS.fence.height). */
  readonly height?: number;
}

/** Sentry on a ceiling (hangs down) or on the floor (stands up). */
export interface TurretSlotDef extends TrapSlotBase {
  readonly kind: 'turret';
  /** Mount point: the ceiling underside (ceiling) or the floor (floor). */
  readonly position: Vec3Tuple;
  readonly mount: 'ceiling' | 'floor';
  /** Rest / sweep center yaw (deg; 0 looks down −Z, positive turns left). */
  readonly yawDeg: number;
  /** Target range override (m). */
  readonly range?: number;
}

/** Ventilation rotor in a wall or floor shaft: pulls enemies in front of it and shreds them. */
export interface FanSlotDef extends TrapSlotBase {
  readonly kind: 'fan';
  /** Rotor hub center (in the wall face / floor plane). */
  readonly position: Vec3Tuple;
  /** Direction the intake faces (into the room); 'up' = a floor shaft. */
  readonly facing: Facing | 'up';
  /** Rotor radius / pull reach overrides (m). */
  readonly radius?: number;
  readonly reach?: number;
}

/** Floor vent that jets fire upwards in pulses. */
export interface FlameSlotDef extends TrapSlotBase {
  readonly kind: 'flame';
  /** Floor center of the grate. */
  readonly position: Vec3Tuple;
  /** Column height / radius overrides (m). */
  readonly height?: number;
  readonly radius?: number;
}

export type TrapSlotDef = FenceSlotDef | TurretSlotDef | FanSlotDef | FlameSlotDef;

/** Panel / trap state shown to the player. */
export type TrapState = 'ready' | 'active' | 'cooldown';

interface TrapAudioDef {
  readonly activate: string;
  readonly loop: string;
  readonly hit: string;
  /** Loop gain and the distance (m) beyond which it is not started. */
  readonly loopGain: number;
  readonly hitGain: number;
}

export const TRAPS = {
  /** Damageable weapon id prefix of trap damage (`trap:<kind>`; kill feeds, stats). */
  weaponPrefix: 'trap:',
  /** Interact range of the panel (eye → anchor). */
  range: 2.3,
  /** Power outage: panels refuse (prompt) and running traps keep going until their time is up. */
  prompts: {
    activate: '{name} aktivieren',
    active: '{name} aktiv',
    cooldown: '{name} lädt auf',
    unpowered: 'Kein Strom',
  },
  /** Wall panel (the activation box): body, holo screen, big button, status light. */
  panel: {
    width: 0.52,
    height: 0.72,
    depth: 0.12,
    /** Holo screen on the panel face (fractions of the panel) and its canvas. */
    screen: { width: 0.84, height: 0.52, y: 0.14, canvas: [256, 176] as readonly [number, number] },
    button: { radius: 0.075, y: -0.2, depth: 0.03 },
    /** Prompt anchor distance in front of the panel face (m). */
    anchorOffset: 0.25,
    /** Canvas redraws per second at most while a countdown bar moves. */
    redrawRate: 4,
    materials: { body: 'wall_panel_dark', trim: 'trim_metal', hazard: 'painted_hazard' },
    /** Screen / button colors per state and their intensity. */
    colors: {
      ready: [0.2, 1.0, 0.45] as Rgb,
      active: [1.0, 0.42, 0.08] as Rgb,
      cooldown: [0.25, 0.6, 1.0] as Rgb,
      unpowered: [0.6, 0.06, 0.04] as Rgb,
    },
    screenIntensity: 1.8,
    buttonIntensity: 5,
    /** Ready buttons breathe (rate Hz, depth); reduced flashing: depth × reducedScale. */
    breathe: { rate: 0.8, depth: 0.35, reducedScale: 0.4 },
    captions: { ready: 'BEREIT', active: 'AKTIV', cooldown: 'LÄDT AUF', unpowered: 'KEIN STROM' },
  },
  /** Floor glow (fake light spill; real lights never change at runtime). */
  glowPool: { radius: 1.8, intensity: 0.6 },

  fence: {
    name: 'Elektrozaun',
    price: 1000,
    duration: 25,
    cooldown: 45,
    height: 2.1,
    /** Arc strands between the posts, bottom .. top (fractions of the height). */
    strands: [0.12, 0.32, 0.52, 0.72, 0.92] as readonly number[],
    /** Damage slab: half thickness around the post line (m) + this share of a body's radius. */
    halfThickness: 0.35,
    radiusShare: 0.4,
    /** Enemy query reach beyond the half length (m). */
    queryMargin: 1.5,
    /** Sparks / strikes / sounds per zap at most (the damage hits everyone). */
    effectsPerZap: 3,
    playerEffectScale: 0.8,
    /** Arc energy ramp rates (1/s) on / off. */
    ramp: { on: 6, off: 3 },
    /** Every `zapInterval` s everything inside takes `zapDamage` shock damage (stuns via build-up). */
    zapInterval: 0.25,
    zapDamage: 55,
    /** Shock status build-up per damage point (shocked = stun + arcs). */
    statusBuildup: 0.9,
    /** Knockback away from the fence line (m/s) – a jolt, the stun keeps them in. */
    impulse: 1.2,
    /** The player: damage per contact and the minimum time between contacts. */
    playerDamage: 18,
    playerInterval: 0.45,
    playerShake: 0.35,
    /** Zap flash strands (visual): count at once and their lifetime (s). */
    strikes: 6,
    strikeLife: 0.16,
    /** Posts (m): footprint, height, emitter coil segments. */
    post: { width: 0.26, depth: 0.2, height: 2.35, coils: 5, coilHeight: 0.08, coilRadius: 0.13 },
    /** Arc look: core width, glow width (m), jitter amplitude (m) and rate (Hz), colors. */
    arc: {
      core: 0.022,
      glow: 0.16,
      jitter: 0.09,
      jitterRate: 9,
      segments: 28,
      coreColor: [0.75, 0.95, 1.0] as Rgb,
      glowColor: [0.18, 0.55, 1.0] as Rgb,
      intensity: 7,
      /** Idle (ready) posts show only a faint standby spark on the top coils. */
      standby: 0.0,
    },
    coilColor: [0.3, 0.8, 1.0] as Rgb,
    coilIntensity: { ready: 1.2, active: 7, cooldown: 0.6 },
    audio: {
      activate: 'trap.fence.activate',
      loop: 'trap.fence.loop',
      hit: 'trap.fence.hit',
      loopGain: 0.55,
      hitGain: 0.8,
    } as TrapAudioDef,
    /** Hit sounds at most this often (s). */
    hitSoundInterval: 0.12,
    zapEffect: 'impact.shock',
  },

  turret: {
    name: 'Geschützturm',
    price: 1500,
    duration: 30,
    cooldown: 60,
    range: 24,
    /** Aim slew rates (deg/s) and the aim error (deg) within which it fires. */
    yawRateDeg: 220,
    pitchRateDeg: 160,
    aimToleranceDeg: 5,
    /** Pitch limits (deg, + = up). Ceiling mounts aim down, floor mounts up. */
    pitchMinDeg: -75,
    pitchMaxDeg: 20,
    /** Target search (s) and line-of-sight checks per search. */
    retargetInterval: 0.3,
    losChecks: 4,
    /** Bursts: shots per burst, fire rate (rounds/min), pause between bursts (s). */
    burst: { shots: 6, rpm: 720, pause: 0.35 },
    damage: 42,
    headMultiplier: 1.6,
    spreadDeg: 1.4,
    impulse: 0.4,
    tracerColor: 0xffb04a,
    /** Idle sweep (deg amplitude, rad/s) while active without a target. */
    sweep: { amplitudeDeg: 40, rate: 0.7 },
    /** Boot (s): the head unfolds before it may fire. */
    bootTime: 0.8,
    /** Model (m): mount plate, drop rod, yaw ring, head, barrels. */
    model: {
      plate: [0.62, 0.06, 0.62] as Vec3Tuple,
      rod: { radius: 0.07, length: 0.42 },
      ring: { radius: 0.22, height: 0.12 },
      yoke: [0.5, 0.36, 0.16] as Vec3Tuple,
      head: [0.34, 0.3, 0.58] as Vec3Tuple,
      barrel: { radius: 0.035, length: 0.5, spacing: 0.1 },
      eye: { radius: 0.05 },
      /** Barrel kick per shot (m) and its return rate (1/s). */
      recoil: 0.06,
      recoilReturn: 18,
    },
    eyeColor: [1.0, 0.1, 0.05] as Rgb,
    eyeIntensity: { ready: 1.5, active: 9, cooldown: 0.8 },
    laser: { color: [1.0, 0.08, 0.04] as Rgb, intensity: 2.6, width: 0.012, length: 18 },
    flash: {
      color: [1.0, 0.6, 0.25],
      intensity: 6,
      range: 7,
      duration: 0.06,
      priority: 1,
      viewmodel: false,
    } as LightFlashDef,
    muzzleEffect: 'muzzle.rifle',
    audio: {
      activate: 'trap.turret.activate',
      loop: 'trap.turret.loop',
      hit: 'trap.turret.hit',
      loopGain: 0.35,
      hitGain: 0.75,
    } as TrapAudioDef,
    fireSound: 'trap.turret.fire',
    fireGain: 0.7,
  },

  fan: {
    name: 'Ventilator',
    price: 1250,
    duration: 20,
    cooldown: 45,
    radius: 1.15,
    /** Pull reach in front of the intake (m) and the extra radius of the pull cylinder. */
    reach: 7,
    pullMargin: 1.2,
    /** Pull: a knockback shove towards the rotor every `pullInterval` s (m/s at the intake). */
    pullInterval: 0.2,
    pullImpulse: 5.5,
    pullDamage: 3,
    /** Closer than this to the rotor plane: shredded. */
    shredRange: 1.1,
    shredDamage: 90,
    /** Rotor spin-up / spin-down (s) and top speed (rev/s). */
    spinUp: 1.4,
    spinDown: 2.5,
    rps: 7,
    blades: 6,
    /** Frame and grille (m). */
    frame: 0.16,
    depth: 0.5,
    grilleBars: 7,
    /** Wind streaks (visual): count, speed (m/s), length (m). */
    streaks: 48,
    streakSpeed: 9,
    streakLength: 0.7,
    streakColor: [0.55, 0.75, 0.9] as Rgb,
    streakIntensity: 0.9,
    warnColor: [1.0, 0.18, 0.05] as Rgb,
    warnIntensity: 6,
    gore: 'impact.flesh',
    audio: {
      activate: 'trap.fan.activate',
      loop: 'trap.fan.loop',
      hit: 'trap.fan.hit',
      loopGain: 0.7,
      hitGain: 0.9,
    } as TrapAudioDef,
    hitSoundInterval: 0.18,
  },

  flame: {
    name: 'Flammenschlot',
    price: 750,
    duration: 20,
    cooldown: 35,
    height: 3.2,
    radius: 0.85,
    /** Burst cycle while active: fire (s), pause (s); the grate glows `warn` s before a burst. */
    burnTime: 1.6,
    pauseTime: 0.9,
    warnTime: 0.45,
    tickInterval: 0.2,
    damagePerTick: 22,
    statusBuildup: 1.2,
    playerDamagePerTick: 6,
    /** Grate (m). */
    grate: { size: 1.3, frame: 0.1, slats: 6, depth: 0.08 },
    flameColor: [1.0, 0.45, 0.08] as Rgb,
    coreColor: [1.0, 0.85, 0.5] as Rgb,
    flameIntensity: 3.2,
    emberEffect: 'trail.fire.embers',
    audio: {
      activate: 'trap.flame.activate',
      loop: 'trap.flame.loop',
      hit: 'trap.flame.hit',
      loopGain: 0.75,
      hitGain: 0.6,
    } as TrapAudioDef,
    hitSoundInterval: 0.3,
  },

  /** Loops start / stop within this distance of the listener (m). */
  loopDistance: 30,
} as const;

/**
 * Trap slots of maps without level data (the level's `trapSlots` win). The lab proves the kit: a
 * fence across the west corridor (reception → labs) and a sentry under the atrium's south ring.
 * The calibration hall shows every kind for tests and art passes.
 */
export const TRAP_SLOTS: Readonly<Record<string, readonly TrapSlotDef[]>> = {
  lab: [
    {
      id: 'trap_corrw_fence',
      kind: 'fence',
      zone: 'labs',
      a: [-22.5, 0, 20.95],
      b: [-22.5, 0, 25.05],
      panel: { position: [-20.6, 1.35, 20.8], facing: 'pz' },
    },
    {
      id: 'trap_atrium_turret',
      kind: 'turret',
      zone: 'atrium',
      position: [3.2, 4.7, 9.7],
      mount: 'ceiling',
      yawDeg: 0,
      panel: { position: [4.0, 1.35, 12], facing: 'nz' },
    },
  ],
  testroom: [
    {
      id: 'trap_test_fence',
      kind: 'fence',
      zone: 'hall',
      a: [-26, 0, 6],
      b: [-26, 0, 10.5],
      panel: { position: [-30, 1.35, 12.2], facing: 'px' },
    },
    {
      id: 'trap_test_turret',
      kind: 'turret',
      zone: 'hall',
      position: [-22, 0, 3],
      mount: 'floor',
      yawDeg: 90,
      panel: { position: [-30, 1.35, 3.6], facing: 'px' },
    },
    {
      id: 'trap_test_fan',
      kind: 'fan',
      zone: 'hall',
      position: [-30, 1.5, -6],
      facing: 'px',
      panel: { position: [-30, 1.35, -9], facing: 'px' },
    },
    {
      id: 'trap_test_flame',
      kind: 'flame',
      zone: 'hall',
      position: [-24, 0, -13],
      panel: { position: [-30, 1.35, -13], facing: 'px' },
    },
  ],
};

/** Price / timing of a slot (overrides or the kind's defaults). */
export function trapTiming(slot: TrapSlotDef): { price: number; duration: number; cooldown: number } {
  const k = TRAPS[slot.kind];
  return {
    price: slot.price ?? k.price,
    duration: slot.duration ?? k.duration,
    cooldown: slot.cooldown ?? k.cooldown,
  };
}

/** Display name (German) of a trap kind. */
export function trapName(kind: TrapKind): string {
  return TRAPS[kind].name;
}
