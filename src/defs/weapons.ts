/**
 * Weapon tuning (data-driven: systems never branch on a weapon id; only viewmodel builders are
 * per weapon). Angles in DEGREES, times in seconds, distances in meters, speeds in rounds/minute.
 *
 * Feel targets (DOOM-Eternal punch, CoD-Zombies economy):
 * - VX-9 "Sentinel": precise, fast semi-auto sidearm, 45 dmg, a sharp single kick per shot.
 * - KR-7 "Wächter": 650 rpm full auto, 28 dmg, learnable pattern (straight up, then drift right,
 *   then back left) that a player can pull down against.
 * - SG-12 "Brecher": 9 × 14 dmg pump shotgun (~70 rpm) that deletes things up close.
 *
 * Extension points (M5): `upgrades` (Rift Forge tiers, multiplicative stat mods), `attachmentSlots`,
 * `damage.element` (elemental mods) and `kind` ('projectile' / 'beam' are reserved).
 */
import type { DamageElement, GameEvents } from '../core/events';
import type { Action } from './input';

export type WeaponCategory =
  'pistol' | 'smg' | 'rifle' | 'shotgun' | 'lmg' | 'marksman' | 'sniper' | 'launcher' | 'special';

/** semi: one shot per press · auto: fires while held · burst: `burst.count` shots per press · pump: fires on press or hold, one pump cycle per shot. */
export type FireMode = 'semi' | 'auto' | 'burst' | 'pump';

/** Only 'hitscan' is implemented in M2; 'projectile' and 'beam' are reserved for M5. */
export type WeaponKind = 'hitscan' | 'projectile' | 'beam';

/** Kinds the weapon system can fire; defs of any other kind are refused (never fired as hitscan). */
export const IMPLEMENTED_WEAPON_KINDS: readonly WeaponKind[] = ['hitscan'];

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
}

/** One Rift Forge upgrade tier (M5). */
export interface WeaponUpgradeTier {
  readonly tier: 1 | 2 | 3;
  /** Player-facing name (German). */
  readonly name: string;
  readonly cost: number;
  readonly mods: WeaponStatMods;
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
  readonly attachmentSlots: readonly AttachmentSlot[];
  readonly upgrades: readonly WeaponUpgradeTier[];
}

/** Shared melee swing (all M2 weapons bash with the same arm motion). */
const MELEE_BASH = {
  damage: 60,
  range: 2.0,
  coneDeg: 32,
  duration: 0.5,
  hitTime: 0.11,
  cooldown: 0.12,
  impulse: 6,
  propImpulse: 90,
  shake: 0.28,
} as const satisfies WeaponMeleeDef;

const NO_UPGRADES: readonly WeaponUpgradeTier[] = [];

export const WEAPONS = {
  pistol: {
    id: 'pistol',
    name: 'VX-9 „Sentinel“',
    shortName: 'VX-9',
    description: 'Präzise Halbautomatik. Schnell gezogen, tödlich auf den Kopf.',
    category: 'pistol',
    kind: 'hitscan',
    fireMode: 'semi',
    burst: null,
    damage: {
      base: 45,
      headMultiplier: 2,
      limbMultiplier: 0.75,
      weakpointMultiplier: 2.5,
      falloffStart: 18,
      falloffEnd: 45,
      minFalloffMultiplier: 0.6,
      element: 'physical',
      impulse: 1.6,
      propImpulse: 45,
    },
    pellets: 1,
    // Semi-auto rate cap: a fast trigger finger, not a spam button.
    rpm: 420,
    magazine: 12,
    reserve: 84,
    chambered: true,
    reload: {
      tactical: 1.3,
      empty: 1.6,
      tacticalSteps: [
        { step: 'magOut', at: 0.28 },
        { step: 'magIn', at: 0.82 },
      ],
      emptySteps: [
        { step: 'magOut', at: 0.26 },
        { step: 'magIn', at: 0.8 },
        { step: 'boltRelease', at: 1.22 },
      ],
      perShell: null,
    },
    spread: {
      hip: 0.9,
      ads: 0.12,
      moveAdd: 0.9,
      airAdd: 2.4,
      crouchMultiplier: 0.8,
      // Paced shots stay pin-point; spamming at the rate cap blooms to the max in ~6 shots.
      perShotBloom: 0.5,
      bloomMax: 2,
      recoveryPerSec: 8,
      recoveryDelay: 0.12,
    },
    recoil: {
      pattern: [
        [0, 1.55],
        [0.12, 1.5],
        [-0.12, 1.5],
      ],
      patternRepeatFrom: 0,
      randomYaw: 0.35,
      randomPitch: 0.25,
      recoveryPerSec: 10,
      recoveryDelay: 0.07,
      resetTime: 0.35,
      adsMultiplier: 0.7,
      crouchMultiplier: 0.85,
      kickTime: 0.05,
      viewPunch: { pitch: 1.8, yaw: 0.5, roll: 1.2 },
      visualKick: { back: 0.045, up: 0.012, side: 0.004, pitch: 9, yaw: 1.5, roll: 3 },
      shake: 0.2,
    },
    ads: {
      zoom: 0.86,
      inTime: 0.15,
      outTime: 0.12,
      moveSpeedMultiplier: 0.82,
      sensitivityMultiplier: 0.95,
    },
    // Through glass and grates, not through bodies.
    penetration: { power: 0.5, damageKeep: 0.6 },
    range: 140,
    equipTime: 0.32,
    holsterTime: 0.22,
    sprintToFireTime: 0.1,
    inspectTime: 2.2,
    melee: MELEE_BASH,
    tracer: { everyNth: 1, color: 0x9fe8ff, pellets: 1 },
    vfx: {
      muzzle: 'muzzle.pistol',
      impact: 'impact.bullet',
      casing: 'casing.pistol',
      muzzleLightColor: 0xffc27a,
    },
    audio: {
      fire: ['weapon.pistol.fire', 'weapon.pistol.mech', 'weapon.tail.small'],
      dry: 'weapon.dry',
      equip: 'weapon.pistol.equip',
      holster: 'weapon.holster',
      reloadStart: 'weapon.reload.start',
      steps: {
        magOut: 'weapon.pistol.magOut',
        magIn: 'weapon.pistol.magIn',
        boltRelease: 'weapon.pistol.slide',
      },
      melee: 'weapon.melee',
      inspect: 'weapon.inspect',
    },
    rumble: { strong: 0.25, weak: 0.55, ms: 70 },
    model: 'pistol',
    cost: 500,
    attachmentSlots: ['optic', 'muzzle', 'magazine', 'laser'],
    upgrades: NO_UPGRADES,
  },
  rifle: {
    id: 'rifle',
    name: 'KR-7 „Wächter“',
    shortName: 'KR-7',
    description: 'Vollautomatisches Sturmgewehr. Zieht erst hoch, dann nach rechts – halte dagegen.',
    category: 'rifle',
    kind: 'hitscan',
    fireMode: 'auto',
    burst: null,
    damage: {
      base: 28,
      headMultiplier: 1.8,
      limbMultiplier: 0.8,
      weakpointMultiplier: 2.2,
      falloffStart: 26,
      falloffEnd: 60,
      minFalloffMultiplier: 0.65,
      element: 'physical',
      impulse: 1.1,
      propImpulse: 35,
    },
    pellets: 1,
    rpm: 650,
    magazine: 32,
    reserve: 224,
    chambered: true,
    reload: {
      tactical: 1.85,
      empty: 2.35,
      tacticalSteps: [
        { step: 'magOut', at: 0.42 },
        { step: 'magIn', at: 1.22 },
      ],
      emptySteps: [
        { step: 'magOut', at: 0.4 },
        { step: 'magIn', at: 1.18 },
        { step: 'boltRelease', at: 1.86 },
      ],
      perShell: null,
    },
    spread: {
      hip: 1.7,
      ads: 0.2,
      moveAdd: 1.4,
      airAdd: 3,
      crouchMultiplier: 0.75,
      // Bursts of 3–5 stay tight; a full spray blooms to the cap after ~11 shots.
      perShotBloom: 0.18,
      bloomMax: 2,
      recoveryPerSec: 7,
      recoveryDelay: 0.14,
    },
    recoil: {
      // Shots 1–7 climb, 8–14 drift right, 15–22 swing back left; the tail loops a gentle weave.
      pattern: [
        [0, 0.62],
        [0.02, 0.66],
        [-0.03, 0.68],
        [0.03, 0.7],
        [0, 0.7],
        [0.05, 0.66],
        [0.08, 0.62],
        [0.16, 0.55],
        [0.22, 0.5],
        [0.26, 0.46],
        [0.28, 0.42],
        [0.26, 0.4],
        [0.2, 0.38],
        [0.12, 0.36],
        [0, 0.35],
        [-0.12, 0.34],
        [-0.22, 0.33],
        [-0.28, 0.32],
        [-0.3, 0.32],
        [-0.26, 0.31],
        [-0.18, 0.3],
        [-0.08, 0.3],
        [0.1, 0.3],
        [0.2, 0.3],
        [0.1, 0.3],
        [-0.1, 0.3],
        [-0.2, 0.3],
        [-0.1, 0.3],
      ],
      patternRepeatFrom: 22,
      randomYaw: 0.1,
      randomPitch: 0.07,
      recoveryPerSec: 8,
      recoveryDelay: 0.12,
      resetTime: 0.28,
      adsMultiplier: 0.62,
      crouchMultiplier: 0.85,
      kickTime: 0.045,
      viewPunch: { pitch: 0.75, yaw: 0.3, roll: 0.6 },
      visualKick: { back: 0.028, up: 0.006, side: 0.003, pitch: 3.5, yaw: 0.8, roll: 1.6 },
      // Above the per-interval trauma decay: a hip spray builds up a rumble, ADS stays steady.
      shake: 0.14,
    },
    ads: {
      zoom: 0.74,
      inTime: 0.22,
      outTime: 0.16,
      moveSpeedMultiplier: 0.7,
      sensitivityMultiplier: 0.9,
    },
    penetration: { power: 2, damageKeep: 0.7 },
    range: 220,
    equipTime: 0.5,
    holsterTime: 0.3,
    sprintToFireTime: 0.18,
    inspectTime: 2.8,
    melee: MELEE_BASH,
    tracer: { everyNth: 3, color: 0xffb35a, pellets: 1 },
    vfx: {
      muzzle: 'muzzle.rifle',
      impact: 'impact.bullet',
      casing: 'casing.rifle',
      muzzleLightColor: 0xffb060,
    },
    audio: {
      fire: ['weapon.rifle.fire', 'weapon.rifle.mech', 'weapon.tail.medium'],
      dry: 'weapon.dry',
      equip: 'weapon.rifle.equip',
      holster: 'weapon.holster',
      reloadStart: 'weapon.reload.start',
      steps: {
        magOut: 'weapon.rifle.magOut',
        magIn: 'weapon.rifle.magIn',
        boltRelease: 'weapon.rifle.bolt',
      },
      melee: 'weapon.melee',
      inspect: 'weapon.inspect',
    },
    rumble: { strong: 0.2, weak: 0.45, ms: 55 },
    model: 'rifle',
    cost: 1200,
    attachmentSlots: ['optic', 'muzzle', 'underbarrel', 'magazine', 'stock', 'laser'],
    upgrades: NO_UPGRADES,
  },
  shotgun: {
    id: 'shotgun',
    name: 'SG-12 „Brecher“',
    shortName: 'SG-12',
    description: 'Pump-Schrotflinte. Neun Kugeln, ein Urteil – aus nächster Nähe vernichtend.',
    category: 'shotgun',
    kind: 'hitscan',
    fireMode: 'pump',
    burst: null,
    damage: {
      base: 14,
      headMultiplier: 1.5,
      limbMultiplier: 0.8,
      weakpointMultiplier: 1.8,
      falloffStart: 7,
      falloffEnd: 22,
      minFalloffMultiplier: 0.25,
      element: 'physical',
      impulse: 0.9,
      propImpulse: 40,
    },
    pellets: 9,
    rpm: 72,
    magazine: 8,
    reserve: 40,
    chambered: false,
    reload: {
      tactical: 0,
      empty: 0,
      tacticalSteps: [],
      emptySteps: [],
      perShell: {
        start: 0.32,
        shell: 0.44,
        insertAt: 0.3,
        end: 0.26,
        emptyEnd: 0.62,
        pumpAt: 0.28,
      },
    },
    spread: {
      // Pellet cone: the whole ring lands on a torso inside ~4 m, half of it at ~8 m.
      hip: 4.5,
      ads: 3.1,
      moveAdd: 0.6,
      airAdd: 1.4,
      crouchMultiplier: 0.9,
      perShotBloom: 0.8,
      bloomMax: 1.6,
      recoveryPerSec: 5,
      recoveryDelay: 0.2,
    },
    recoil: {
      pattern: [[0, 5.2]],
      patternRepeatFrom: 0,
      randomYaw: 0.9,
      randomPitch: 0.6,
      recoveryPerSec: 16,
      recoveryDelay: 0.12,
      resetTime: 0.9,
      adsMultiplier: 0.75,
      crouchMultiplier: 0.85,
      kickTime: 0.07,
      viewPunch: { pitch: 4.2, yaw: 1.2, roll: 2.6 },
      visualKick: { back: 0.11, up: 0.03, side: 0.008, pitch: 16, yaw: 2.5, roll: 5 },
      shake: 0.48,
    },
    ads: {
      zoom: 0.88,
      inTime: 0.2,
      outTime: 0.15,
      moveSpeedMultiplier: 0.78,
      sensitivityMultiplier: 1,
    },
    // Pellets punch through glass and grates, not through crates or bodies.
    penetration: { power: 0.5, damageKeep: 0.55 },
    range: 70,
    equipTime: 0.55,
    holsterTime: 0.32,
    sprintToFireTime: 0.2,
    inspectTime: 2.6,
    melee: MELEE_BASH,
    tracer: { everyNth: 1, color: 0xffd08a, pellets: 3 },
    vfx: {
      muzzle: 'muzzle.shotgun',
      impact: 'impact.pellet',
      casing: 'casing.shell',
      muzzleLightColor: 0xffa850,
    },
    audio: {
      fire: ['weapon.shotgun.fire', 'weapon.shotgun.boom', 'weapon.tail.large'],
      extraFire: ['weapon.shotgun.pumpCycle'],
      dry: 'weapon.dry',
      equip: 'weapon.shotgun.equip',
      holster: 'weapon.holster',
      reloadStart: 'weapon.shotgun.open',
      steps: { shellIn: 'weapon.shotgun.shellIn', pump: 'weapon.shotgun.pump' },
      melee: 'weapon.melee',
      inspect: 'weapon.inspect',
    },
    rumble: { strong: 0.8, weak: 0.9, ms: 140 },
    model: 'shotgun',
    cost: 1500,
    attachmentSlots: ['optic', 'muzzle', 'underbarrel', 'stock', 'laser'],
    upgrades: NO_UPGRADES,
  },
} as const satisfies Record<string, WeaponDef>;

export type WeaponId = keyof typeof WEAPONS;

/** Every weapon M2 ships (fixed ids). */
export const WEAPON_IDS: readonly WeaponId[] = ['pistol', 'rifle', 'shotgun'];

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
    // M3 vertical slice: no wall buys yet (M4), so the lab starts with rifle + sidearm.
    lab: { slots: 2, weapons: ['rifle', 'pistol'] },
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
