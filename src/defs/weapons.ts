/**
 * Weapon tuning (data-driven: systems never branch on a weapon id; only viewmodel builders are
 * per weapon). Angles in DEGREES, times in seconds, distances in meters, speeds in rounds/minute.
 *
 * This file holds the SCHEMA, the registry and the rules; the roster itself lives in
 * defs/weaponData/<category>.ts (feel targets per weapon in each file's header), attachments in
 * defs/attachments.ts, Rift Forge rules and looks in defs/forge.ts.
 *
 * Balance frame (DOOM-Eternal punch, CoD-Zombies economy; enemies in defs/enemies.ts: Schwärmer
 * 60 HP, Spucker 110, Koloss 900, ×1.9 by wave 10 and up to ×5 late):
 * - wall guns 500–1500 by usefulness, ~300 body DPS for the automatics, one-to-two-tap precision
 *   for the semis; the Rift-Kiste adds the box-only heavies (minigun), energy/experimental
 *   weapons and the three wonder weapons (rare, strong, own base specials);
 * - Rift Forge tiers stack ×1.6–1.8 / ×1.35 / ×1.25–1.3 damage (≈3× at tier 3) plus magazine,
 *   handling and one special per tier – tier 3 changes how the weapon plays.
 */
import type { DamageElement, GameEvents } from '../core/events';
import type { Action } from './input';
import { ENERGY } from './weaponData/energy';
import { LMGS } from './weaponData/lmgs';
import { PISTOLS } from './weaponData/pistols';
import { RIFLES } from './weaponData/rifles';
import { SHOTGUNS } from './weaponData/shotguns';
import { SMGS } from './weaponData/smgs';
import { SNIPERS } from './weaponData/snipers';
import { WONDER } from './weaponData/wonder';

export type WeaponCategory =
  | 'pistol'
  | 'smg'
  | 'rifle'
  | 'shotgun'
  | 'lmg'
  | 'marksman'
  | 'sniper'
  | 'launcher'
  /** Energy / experimental weapons (M5). */
  | 'energy'
  /** Box-only wonder weapons (M5). */
  | 'wonder'
  | 'special';

/** semi: one shot per press · auto: fires while held · burst: `burst.count` shots per press · pump: fires on press or hold, one pump cycle per shot. */
export type FireMode = 'semi' | 'auto' | 'burst' | 'pump';

/**
 * hitscan: instant rays (M2) · projectile: simulated bolts/grenades/orbs (`projectile`) · beam: a
 * continuous ray/cone while fire is held (`beam`) · charge: hold to charge, release fires a hitscan
 * shot scaled by the charge (`charge`). Kinds are M5 except hitscan.
 */
export type WeaponKind = 'hitscan' | 'projectile' | 'beam' | 'charge';

/**
 * Kinds the weapon system can fire; defs of any other kind are refused (never fired as hitscan).
 * M5: all four (weapons/fire – projectiles, beams, charge).
 */
export const IMPLEMENTED_WEAPON_KINDS: readonly WeaponKind[] = ['hitscan', 'projectile', 'beam', 'charge'];

/** Attachment slots (M5). */
export type AttachmentSlot = 'optic' | 'muzzle' | 'underbarrel' | 'magazine' | 'stock' | 'laser';

export type ReloadStep = GameEvents['weapon:reloadStep']['step'];

/** A reload keyframe (animation/audio sync), `at` seconds after the reload started. */
export interface ReloadMarker {
  readonly step: ReloadStep;
  readonly at: number;
}

export interface WeaponDamageDef {
  /** Damage per bullet / pellet before multipliers. */
  readonly base: number;
  readonly headMultiplier: number;
  readonly limbMultiplier: number;
  readonly weakpointMultiplier: number;
  /** Full damage up to `falloffStart`, linear down to `minFalloffMultiplier` at `falloffEnd`. */
  readonly falloffStart: number;
  readonly falloffEnd: number;
  readonly minFalloffMultiplier: number;
  readonly element: DamageElement;
  /** Knockback (m/s) handed to targets via DamageInfo.impulse, per bullet/pellet. */
  readonly impulse: number;
  /** Impulse (N·s) applied to dynamic props per bullet/pellet. */
  readonly propImpulse: number;
}

/** Shell-by-shell reload (tube-fed shotguns). Interruptible by fire between shells. */
export interface PerShellReloadDef {
  /** Lift/open time before the first shell. */
  readonly start: number;
  /** Duration of one shell cycle; the shell counts (`shellIn`) `insertAt` seconds into it. */
  readonly shell: number;
  readonly insertAt: number;
  /** Close time after the last shell (also after an interrupt). */
  readonly end: number;
  /** Close time when the reload started empty: includes a pump that chambers a round ... */
  readonly emptyEnd: number;
  /** ... which happens `pumpAt` seconds into `emptyEnd`. */
  readonly pumpAt: number;
}

export interface WeaponReloadDef {
  /** Magazine swap with rounds left. */
  readonly tactical: number;
  /** Magazine swap from empty (slide/bolt release included). */
  readonly empty: number;
  /**
   * Keyframes. `magIn` is also the COMMIT point: ammo transfers there, and cancelling (sprint
   * press, switch, melee) before it keeps the old magazine; after it the reload counts.
   * Fire interrupts a tactical reload only before `magOut` (the magazine is still seated).
   */
  readonly tacticalSteps: readonly ReloadMarker[];
  readonly emptySteps: readonly ReloadMarker[];
  /** Non-null: tube reload, shell by shell (tactical/empty/steps are then unused). */
  readonly perShell: PerShellReloadDef | null;
}

/**
 * Degrees. Current spread = (hip↔ads by ADS amount) × crouch + moveAdd·speed + airAdd
 * + bloom × (1↔WEAPON_RULES.adsBloomMultiplier by ADS amount).
 */
export interface WeaponSpreadDef {
  /** Cone half-angle while hip firing / fully aimed. */
  readonly hip: number;
  readonly ads: number;
  /** Added at run speed (scaled by horizontal speed / run speed, capped at 1.5×). */
  readonly moveAdd: number;
  /** Added while airborne. */
  readonly airAdd: number;
  readonly crouchMultiplier: number;
  /** Bloom added per shot, its cap, and its linear recovery (deg/s). */
  readonly perShotBloom: number;
  readonly bloomMax: number;
  readonly recoveryPerSec: number;
  /**
   * Bloom only recovers this long after the last shot (s). Longer than the fire interval, so
   * sustained fire accumulates bloom (spraying gets inaccurate) while paced shots stay precise.
   */
  readonly recoveryDelay: number;
}

/** Viewmodel impulses for the animator (meters / degrees), applied per shot. */
export interface WeaponVisualKickDef {
  readonly back: number;
  readonly up: number;
  /** Random ± sideways (m). */
  readonly side: number;
  readonly pitch: number;
  /** Random ± (deg). */
  readonly yaw: number;
  readonly roll: number;
}

export interface WeaponRecoilDef {
  /**
   * Learnable aim-kick pattern per shot index: [yawDeg (+ = right), pitchDeg (+ = up)]. Shots
   * beyond the end continue from `patternRepeatFrom`.
   */
  readonly pattern: readonly (readonly [number, number])[];
  readonly patternRepeatFrom: number;
  /** Uniform random ± added per shot (deg, seeded Rng). */
  readonly randomYaw: number;
  readonly randomPitch: number;
  /** Recovery of the UNRECOVERED kick back towards the origin (deg/s) after `recoveryDelay`. */
  readonly recoveryPerSec: number;
  readonly recoveryDelay: number;
  /** The pattern restarts at shot 0 after this pause without firing. */
  readonly resetTime: number;
  readonly adsMultiplier: number;
  readonly crouchMultiplier: number;
  /** Each aim kick is eased onto the camera over this time (never a snap). */
  readonly kickTime: number;
  /** Visual-only camera punch (deg, springs back, never moves the aim). yaw/roll are random ±. */
  readonly viewPunch: { readonly pitch: number; readonly yaw: number; readonly roll: number };
  readonly visualKick: WeaponVisualKickDef;
  /** camera:shake trauma per shot (hip; aiming scales it by WEAPON_RULES.adsShakeMultiplier). */
  readonly shake: number;
}

export interface WeaponAdsDef {
  /** Horizontal FOV multiplier at full ADS. */
  readonly zoom: number;
  readonly inTime: number;
  readonly outTime: number;
  /** Player move speed multiplier at full ADS. */
  readonly moveSpeedMultiplier: number;
  /** Multiplies the player's ADS sensitivity setting. */
  readonly sensitivityMultiplier: number;
}

export interface WeaponPenetrationDef {
  /** Budget spent per penetrated surface / body (costs: COMBAT.penetrationCost). 0 = never penetrates. */
  readonly power: number;
  /** Damage multiplier kept after each penetration. */
  readonly damageKeep: number;
}

export interface WeaponMeleeDef {
  readonly damage: number;
  /**
   * Reach from the eye to the target's body surface (m; whatever the target's size) and
   * half-angle of the cone (deg).
   */
  readonly range: number;
  readonly coneDeg: number;
  readonly duration: number;
  /** The blow lands this long after the swing starts. */
  readonly hitTime: number;
  /** Extra lockout after the swing ended. */
  readonly cooldown: number;
  /** Knockback (m/s) / prop impulse (N·s). */
  readonly impulse: number;
  readonly propImpulse: number;
  /** camera:shake trauma when the blow connects. */
  readonly shake: number;
}

export interface WeaponTracerDef {
  /** Every Nth shot draws a tracer (0 = never). */
  readonly everyNth: number;
  /** Linear RGB hex for the VFX system. */
  readonly color: number;
  /** Multi-pellet weapons: how many pellets of a tracer shot draw one. */
  readonly pellets: number;
}

/** Effect preset ids (defs/vfx.ts); unknown ids are ignored by the VFX system. */
export interface WeaponVfxDef {
  readonly muzzle: string;
  readonly impact: string;
  /** Ejected casing preset, null = none (e.g. energy weapons). */
  readonly casing: string | null;
  /** Muzzle flash light color (linear hex). */
  readonly muzzleLightColor: number;
}

/** Sound ids (registered buffers or procedural fallbacks); missing ids are silent. */
export interface WeaponAudioDef {
  /** Layers played together per shot: punch/body, mechanical, tail. */
  readonly fire: readonly string[];
  /**
   * Extra per-shot layers with their own detune and gain (AUDIO.weapons.extraLayerGain), e.g. a
   * pump-cycle sound whose lead-in lines up with the viewmodel's pump stroke.
   */
  readonly extraFire?: readonly string[];
  readonly dry: string;
  readonly equip: string;
  readonly holster: string;
  readonly reloadStart: string;
  readonly steps: Readonly<Partial<Record<ReloadStep, string>>>;
  readonly melee: string;
  readonly inspect: string;
}

/** Gamepad vibration per shot (0..1, ms); skipped when the vibration setting is off. */
export interface WeaponRumbleDef {
  readonly strong: number;
  readonly weak: number;
  readonly ms: number;
}

/**
 * Area damage (M5): projectile detonations, grenades, forge specials. Damage falls off linearly
 * from `damage` at the center to `damage × minFalloffMultiplier` at `radius`; line of sight to
 * the static world is required.
 */
export interface ExplosionDef {
  readonly radius: number;
  readonly damage: number;
  readonly minFalloffMultiplier: number;
  readonly element: DamageElement;
  /** Knockback (m/s) at the center, scaled like the damage. */
  readonly impulse: number;
  /** Impulse (N·s) on dynamic props at the center. */
  readonly propImpulse: number;
  /** Fraction of the damage the player takes from their own blast (0 = none). */
  readonly selfDamageScale: number;
  /** camera:shake trauma at the player's position (fades out over 3 × radius). */
  readonly shake: number;
  /** VFX preset (defs/vfx) and sound id. */
  readonly vfx: string;
  readonly audio: string;
}

/**
 * Lingering area effect (M5): singularity pull, fire pool, poison cloud, frost field. Ticks
 * `dps` of `element` damage to enemies inside; `pull` accelerates them towards the center,
 * `slow` multiplies their speed by `strength`. An optional collapse explosion ends it.
 */
export interface FieldDef {
  readonly kind: 'pull' | 'damage' | 'slow';
  readonly radius: number;
  readonly duration: number;
  readonly dps: number;
  readonly element: DamageElement;
  /** pull: acceleration towards the center (m/s²) · slow: speed multiplier · damage: unused. */
  readonly strength: number;
  readonly collapse: ExplosionDef | null;
  readonly vfx: string;
  readonly audio: string;
}

/** Simulated projectile (M5 kind 'projectile', grenades). */
export interface WeaponProjectileDef {
  /** Launch speed (m/s). */
  readonly speed: number;
  /** Downward acceleration (m/s², 0 = straight line). */
  readonly gravity: number;
  /** Collision radius against the world and hitboxes (m). */
  readonly radius: number;
  /** Removed (or detonated, with an explosion) after this long (s). */
  readonly lifetime: number;
  /** World bounces before it stops/detonates (0 = impact). */
  readonly bounces: number;
  /** Velocity kept per bounce (0..1). */
  readonly restitution: number;
  /** Detonates after this time whatever it hit (s, 0 = on impact only). */
  readonly fuse: number;
  /** Damageables it passes through before stopping. */
  readonly pierce: number;
  /** Homing turn rate towards the enemy nearest the flight line (rad/s, 0 = none). */
  readonly homing: number;
  /** Direct hit damage uses the weapon's `damage`; the detonation this (null = none). */
  readonly explosion: ExplosionDef | null;
  /** Area left behind on detonation (null = none). */
  readonly field: FieldDef | null;
  /** Projectile visual preset (defs/vfx) and trail preset (null = none). */
  readonly visual: string;
  readonly trail: string | null;
  /** Positional flight loop (null = silent). */
  readonly flightAudio: string | null;
}

/**
 * Continuous beam while fire is held (M5 kind 'beam'): Kettenblitz, flamethrower. Damage
 * `damage.base` per tick; ammo drains per second from the magazine.
 */
export interface WeaponBeamDef {
  readonly range: number;
  /** Damage ticks per second. */
  readonly tickRate: number;
  /** 0 = a ray; > 0 = a cone of this half-angle (deg) hitting everything inside (flamethrower). */
  readonly coneDeg: number;
  /** Arcs jumping from the primary target to nearby enemies (null = none). */
  readonly chain: { readonly count: number; readonly range: number; readonly damageKeep: number } | null;
  readonly ammoPerSecond: number;
  /** Beam visual preset (defs/vfx) and positional loop while firing. */
  readonly visual: string;
  readonly loopAudio: string;
}

/** Hold fire to charge, release to fire one hitscan shot (M5 kind 'charge'): railgun. */
export interface WeaponChargeDef {
  /** Seconds to full charge. */
  readonly time: number;
  /** Releasing below this charge (0..1) fizzles without a shot (ammo kept). */
  readonly minCharge: number;
  /** Damage multiplier at `minCharge` (1 at full charge, linear in between). */
  readonly damageAtMin: number;
  /** Fires by itself this long after reaching full charge (s, 0 = hold as long as you like). */
  readonly autoReleaseAfter: number;
  readonly chargeAudio: string;
  /** Charge glow preset on the viewmodel/muzzle (defs/vfx). */
  readonly visual: string;
}

/** Barrel spin-up (M5, minigun): the rate ramps up while fire is held. */
export interface WeaponSpinUpDef {
  /** Seconds from standstill to full rpm. */
  readonly time: number;
  /** Rate fraction at which it starts firing (0..1). */
  readonly startFraction: number;
  /** Seconds from full rpm to standstill after fire is released. */
  readonly spinDown: number;
  readonly loopAudio: string;
}

/**
 * Special effect of a Rift Forge tier or wonder weapon (M5), interpreted by the weapon system per
 * hit/shot/kill; data only, no per-weapon code.
 */
export type WeaponSpecialDef =
  /** A hit detonates a small explosion (chance per hit). */
  | { readonly kind: 'explosiveRounds'; readonly chance: number; readonly explosion: ExplosionDef }
  /** Rays bounce off world surfaces towards the nearest enemy. */
  | { readonly kind: 'ricochet'; readonly bounces: number; readonly damageKeep: number }
  /** A hit arcs lightning to nearby enemies. */
  | {
      readonly kind: 'chainArc';
      readonly chance: number;
      readonly count: number;
      readonly range: number;
      readonly damage: number;
    }
  /** Hits build up an element's status (without changing the damage element). */
  | {
      readonly kind: 'elementProc';
      readonly element: DamageElement;
      readonly chance: number;
      readonly amount: number;
    }
  /** A fraction of the damage dealt heals the player. */
  | { readonly kind: 'lifesteal'; readonly fraction: number }
  /** Every shot splits into extra rays/projectiles fanned out by `angleDeg`. */
  | { readonly kind: 'splitShot'; readonly count: number; readonly angleDeg: number }
  /** Every Nth shot deals `multiplier` × damage (with a distinct tracer). */
  | { readonly kind: 'critBurst'; readonly everyNth: number; readonly multiplier: number }
  /** A kill leaves a field (singularity, fire pool …) at the corpse. */
  | { readonly kind: 'fieldOnKill'; readonly chance: number; readonly field: FieldDef };

/** Multiplicative stat modifiers (1 = unchanged) – Rift Forge tiers, attachments, perks (M5). */
export interface WeaponStatMods {
  readonly damage?: number;
  readonly rpm?: number;
  readonly magazine?: number;
  readonly reserve?: number;
  readonly reloadTime?: number;
  readonly spread?: number;
  readonly recoil?: number;
  readonly range?: number;
  readonly penetration?: number;
  /** Additive extra pellets. */
  readonly extraPellets?: number;
  /** Replaces the damage element (elemental mods). */
  readonly element?: DamageElement;
  /** Handling (M5 attachments): ADS in/out time, ADS zoom (FOV multiplier factor), equip time. */
  readonly adsTime?: number;
  readonly adsZoom?: number;
  readonly equipTime?: number;
  /** Player move speed while carrying/aiming (ads.moveSpeedMultiplier factor). */
  readonly moveSpeed?: number;
  /** Hip-fire spread only (spread above applies to hip and ADS). */
  readonly hipSpread?: number;
  /** Projectile speed / explosion radius factors (projectile weapons). */
  readonly projectileSpeed?: number;
  readonly blastRadius?: number;
  /** Charge weapons: time to full charge factor (< 1 = faster). */
  readonly chargeTime?: number;
  /**
   * Blast damage the shooter takes from the weapon's own explosions (factor on the BASE def's
   * self damage: damage mods – forge tiers, perks – never raise it; a tier firing several
   * projectiles per pull splits it).
   */
  readonly selfDamage?: number;
}

/**
 * One Rift Forge upgrade tier (M5). Tiers are cumulative (tier 3 has the mods of 1–3); the look
 * (viewmodel palette/camo, defs/forge.ts) comes from the tier unless `palette` overrides it.
 */
export interface WeaponUpgradeTier {
  readonly tier: 1 | 2 | 3;
  /** Player-facing name (German), replaces the weapon name at this tier. */
  readonly name: string;
  readonly cost: number;
  readonly mods: WeaponStatMods;
  /** Special effect gained at this tier (kept by higher tiers unless they define their own). */
  readonly special?: WeaponSpecialDef | null;
  /** Tracer color override at this tier (linear hex). */
  readonly tracerColor?: number;
  /** Palette override (defs/forge.ts FORGE_LOOKS id). */
  readonly palette?: string;
}

export interface WeaponDef {
  readonly id: string;
  /** Player-facing (German). */
  readonly name: string;
  readonly shortName: string;
  readonly description: string;
  readonly category: WeaponCategory;
  readonly kind: WeaponKind;
  readonly fireMode: FireMode;
  /** burst only: shots per press and their rate (rpm between bursts = `rpm`). */
  readonly burst: { readonly count: number; readonly rpm: number } | null;
  readonly damage: WeaponDamageDef;
  /** Bullets per shot (> 1: shotgun pellets, aggregated to one damage event per target). */
  readonly pellets: number;
  readonly rpm: number;
  readonly magazine: number;
  /** Maximum reserve ammo (refills restore this). */
  readonly reserve: number;
  /** Closed bolt: a tactical reload holds magazine + 1. */
  readonly chambered: boolean;
  readonly reload: WeaponReloadDef;
  readonly spread: WeaponSpreadDef;
  readonly recoil: WeaponRecoilDef;
  readonly ads: WeaponAdsDef;
  readonly penetration: WeaponPenetrationDef;
  /** Hitscan reach (m). */
  readonly range: number;
  readonly equipTime: number;
  readonly holsterTime: number;
  /** Sprint → weapon raised: no shots (or ADS) for this long after a sprint ends. */
  readonly sprintToFireTime: number;
  readonly inspectTime: number;
  readonly melee: WeaponMeleeDef;
  readonly tracer: WeaponTracerDef;
  readonly vfx: WeaponVfxDef;
  readonly audio: WeaponAudioDef;
  readonly rumble: WeaponRumbleDef;
  /** Viewmodel model id (procedural builder or glTF), equals the weapon id for M2. */
  readonly model: string;
  /** Purchase price (M4 wall buys / mystery box). */
  readonly cost: number;
  /**
   * Only obtainable from the Rift-Kiste (M5 wonder weapons): never sold at a wall buy, joins the
   * box pool automatically (defs/interactables MYSTERY_BOX.boxOnlyWeight).
   */
  readonly boxOnly?: boolean;
  readonly attachmentSlots: readonly AttachmentSlot[];
  readonly upgrades: readonly WeaponUpgradeTier[];
  /** Kind-specific data (M5): required for their kind, ignored otherwise. */
  readonly projectile?: WeaponProjectileDef | null;
  readonly beam?: WeaponBeamDef | null;
  readonly charge?: WeaponChargeDef | null;
  /** Optional barrel spin-up on any automatic weapon (minigun). */
  readonly spinUp?: WeaponSpinUpDef | null;
  /** Base special effect (wonder weapons); Rift Forge tiers may add or replace it. */
  readonly special?: WeaponSpecialDef | null;
  /**
   * Player move speed factor while this weapon is held (heavy weapons < 1; default 1). The ADS
   * speed (`ads.moveSpeedMultiplier`) applies on top; the `moveSpeed` stat mod scales both.
   */
  readonly carrySpeedMultiplier?: number;
}

/**
 * The roster (M5: 25 weapons), one file per category under defs/weaponData (feel targets in their
 * headers). Keys equal the weapon ids and the viewmodel model ids.
 */
export const WEAPONS = {
  ...PISTOLS,
  ...SMGS,
  ...RIFLES,
  ...SHOTGUNS,
  ...LMGS,
  ...SNIPERS,
  ...ENERGY,
  ...WONDER,
} as const satisfies Record<string, WeaponDef>;

export type WeaponId = keyof typeof WEAPONS;

/** Every weapon of the roster (fixed ids), in display order: by category, then by power. */
export const WEAPON_IDS: readonly WeaponId[] = [
  'pistol',
  'revolver',
  'machinepistol',
  'smg',
  'pdw',
  'vector',
  'rifle',
  'burstrifle',
  'battlerifle',
  'shotgun',
  'autoshotgun',
  'doublebarrel',
  'lmg',
  'minigun',
  'sniper',
  'marksman',
  'plasma',
  'chainlightning',
  'railgun',
  'flamethrower',
  'grenadelauncher',
  'blackhole',
  'riftripper',
  'aetherharp',
  'cryonova',
];

export function getWeaponDef(id: string): WeaponDef | undefined {
  return Object.prototype.hasOwnProperty.call(WEAPONS, id)
    ? (WEAPONS as Record<string, WeaponDef>)[id]
    : undefined;
}

export function isWeaponId(id: string): id is WeaponId {
  return getWeaponDef(id) !== undefined;
}

/** Inventory configuration per map (slots, starting weapons). */
export interface LoadoutDef {
  readonly slots: number;
  readonly weapons: readonly string[];
  /** M5: starting grenades (type id, count); absent = GRENADE_RULES.start (defs/grenades). */
  readonly grenade?: { readonly id: string; readonly count: number };
  /** M5: equipped ability id (null = none); absent = ABILITY_RULES.defaultAbility (defs/abilities). */
  readonly ability?: string | null;
}

/**
 * Rules shared by every weapon. ADS rules: ADS is refused while reloading, equipping, holstering
 * and meleeing (a held ADS resumes afterwards); holding ADS during a sprint ends the sprint
 * (the weapon blocks sprinting) and the ADS starts after `sprintToFireTime`; ADS cancels inspect.
 * Sprint rules: holding fire, aiming and reloading block sprinting (so auto-sprint never locks
 * the trigger). A deliberate sprint PRESS during a reload starts the sprint at once: before the
 * magazine's commit point (`magIn`) it cancels the reload (old magazine kept), after it the swap
 * finishes while sprinting; a shell-by-shell reload ends (inserted shells stay).
 */
export const WEAPON_RULES = {
  /** A semi-auto/pump/burst press this early is kept and fires as soon as the weapon is ready (s). */
  pressBuffer: 0.16,
  /** Empty magazine + reserve left: reload automatically once the last shot's cycle finished. */
  autoReloadOnEmpty: true,
  /** Dry-fire clicks at most this often (s). */
  dryFireInterval: 0.25,
  /** Crosshair spread 1.0 equals this cone half-angle (deg). */
  crosshairMaxSpreadDeg: 8,
  /** Bloom counts this much while fully aimed (applied when reading the spread). */
  adsBloomMultiplier: 0.35,
  /** Spread from movement/air is scaled by this while fully aimed. */
  adsStateSpreadMultiplier: 0.6,
  /** Move spread saturates at this multiple of run speed. */
  maxMoveSpreadFactor: 1.5,
  /** Per-shot camera shake while fully aimed. */
  adsShakeMultiplier: 0.6,
  /**
   * Visual view punch while fully aimed (on top of the recoil's adsMultiplier): the punch moves
   * the sights off the real aim for a moment, so aimed it stays below the ADS cone.
   */
  adsViewPunchMultiplier: 0.4,
  /** Pellet pattern: center pellet + rings; jitter (fraction of the cone) keeps it organic. */
  pellets: {
    ringRadius: 0.72,
    innerRingRadius: 0.36,
    /** Pellets beyond the first ring go to the inner ring once the outer ring holds this many. */
    outerRingMax: 8,
    jitter: 0.2,
  },
  /** Quick back-switch: holstering a weapon mid-equip takes this fraction per equip progress. */
  holsterDuringEquipScale: 1,
  /** Guard against runaway loops (a def with an absurd rpm): shots per fixed tick at most. */
  maxShotsPerTick: 8,
  /** weapon:fired reports `ads: true` from this ADS amount on. */
  adsFiredThreshold: 0.5,
  /** Melee that only hits the world shakes this much of the weapon's melee shake. */
  meleeWorldShakeScale: 0.5,
  /** Movement states that lower the weapon like a sprint (no firing, sprint-to-fire delay after). */
  loweredMovementStates: ['mantle'] as readonly string[],
  inventory: {
    defaultSlots: 2,
    maxSlots: 4,
    /** Direct slot selection, one action per slot (at least `maxSlots` entries). */
    slotActions: ['weapon1', 'weapon2', 'weapon3', 'weapon4'] as const satisfies readonly Action[],
  },
  /** Loadouts by map id; `default` for maps without an entry. */
  loadouts: {
    default: { slots: 2, weapons: ['pistol'] },
    // The calibration hall lets the player compare all three M2 weapons.
    testroom: { slots: 3, weapons: ['pistol', 'rifle', 'shotgun'] },
    // M4: the lab starts with the sidearm; rifle and shotgun are wall buys / Rift-Kiste rolls.
    lab: { slots: 2, weapons: ['pistol'] },
  } as Readonly<Record<string, LoadoutDef>>,
} as const;

/** Camera side of weapon feel (PlayerCamera recoil/punch hooks). */
export const WEAPON_CAMERA = {
  /** Concurrent eased aim kicks; beyond this the oldest is applied at once. */
  maxRecoilImpulses: 16,
  /** Visual view-punch springs (unit mass; underdamped: peaks ~50 ms after the shot, settles in ~0.2 s). */
  viewPunch: { stiffness: 520, damping: 31 },
  /** View punch magnitudes are clamped to this (deg) whatever the stacking. */
  maxViewPunchDeg: 12,
} as const;

export function getLoadout(mapId: string): LoadoutDef {
  const l = WEAPON_RULES.loadouts;
  return Object.prototype.hasOwnProperty.call(l, mapId) ? l[mapId]! : l.default!;
}
