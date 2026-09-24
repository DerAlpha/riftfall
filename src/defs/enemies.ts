/**
 * Enemy balancing and AI tuning (M3: swarmer, spitter, tank). Every enemy type is data: stats,
 * damage zones, attacks, perception and the behaviour ("brain") it runs. M6 adds types by adding
 * entries here (and a visual in defs/enemyVisuals.ts whose attack animation ids match the attack
 * ids below) – EnemyManager, the brains and the attack executors never branch on a type id.
 *
 * Units: meters, seconds, m/s; angles in DEGREES (converted where used); damage in HP.
 *
 * Damage zones: `zoneMultipliers` apply ON TOP of the weapon's own zone multipliers (weapons
 * already scale head/limb/weakpoint hits – same convention as TargetTypeDef.zoneMultipliers), then
 * flat `armor` (zones listed there only), then element resistance.
 *
 * Also here: enemy projectiles (PROJECTILES, used by combat/Projectiles.ts; M5 may move them to
 * their own defs file when player launchers reuse the system).
 */
import type { DamageElement, FleshSurface, HitZone, SurfaceType } from '../core/events';

export type Rgb = readonly [number, number, number];

export type EnemyAttackKind = 'melee' | 'leap' | 'projectile' | 'charge' | 'slam';

/** Melee token pools per target (ENEMY_AI.slots.pools). */
export type SlotPoolId = 'light' | 'heavy';

/** Behaviour archetypes (ai/brains): M6 types reuse them with other stats. */
export type EnemyBrainId = 'swarm' | 'ranged' | 'brute';

/** Close-range swing/bite: hits at the start of the strike if the target is in reach and in front. */
export interface MeleeParams {
  /** Reach from the enemy's feet center to the target's capsule surface (m, horizontal). */
  readonly reach: number;
  /** Full cone angle in front of the enemy (DEGREES). */
  readonly coneDeg: number;
  /** Max height difference between the enemy's and the target's feet (m). */
  readonly height: number;
}

/** Pounce: ballistic hop onto the (partly predicted) target position during the strike. */
export interface LeapParams {
  readonly maxDistance: number;
  /** Apex height of the arc (m). */
  readonly arcHeight: number;
  /** Lands this far in front of the target (m). */
  readonly stopShort: number;
  /** 0..1 how much of the target's velocity is predicted (1 = full lead). */
  readonly leadFactor: number;
  /** Body center height above the feet and hit radius against the target capsule (m). */
  readonly bodyHeight: number;
  readonly hitRadius: number;
}

/** Straight dash with nav steering override; ends on a hit, a wall (self-stagger) or max distance. */
export interface ChargeParams {
  readonly speed: number;
  readonly maxDistance: number;
  /** Homing while dashing (DEGREES/s) – small, so a sidestep dodges it. */
  readonly turnRateDeg: number;
  /** 0..1 lead on the target velocity when the dash direction is locked. */
  readonly leadFactor: number;
  /** Hit when the target capsule comes within this distance of the enemy's center line (m). */
  readonly hitRadius: number;
  /** Look-ahead beyond the step for walls (m; covers the body radius beyond the nav radius). */
  readonly wallProbe: number;
  /** The first meters of the lane must be walkable when the dash starts, else it fizzles (m). */
  readonly startClearance: number;
  /** Height above the feet of the static-wall ray that backs up the nav lane check (m). */
  readonly probeHeight: number;
  /** Self-stagger duration after running into a wall (s). */
  readonly wallStagger: number;
  /** Stop when the target is behind and farther than this (overshoot, m). */
  readonly overshoot: number;
  /** VFX preset + scale on a wall impact (defs/vfx). */
  readonly wallEffect: string;
  readonly wallEffectScale: number;
  /** Camera trauma at the wall impact, full within `shakeRadius` of the player, 0 beyond 2×. */
  readonly wallShake: number;
  readonly shakeRadius: number;
}

/** Ground slam: radial AoE at the strike around `socket` (fallback: `forward` m in front). */
export interface SlamParams {
  readonly radius: number;
  /** Full damage within this distance, linear to `minFactor` at `radius`. */
  readonly innerRadius: number;
  readonly minFactor: number;
  /** Targets higher than this above the impact are missed (jump over the shockwave). */
  readonly height: number;
  readonly socket: string;
  readonly forward: number;
  readonly effect: string;
  readonly effectScale: number;
  /** Near-miss camera trauma (scaled by proximity within shakeRadius). */
  readonly nearShake: number;
  readonly shakeRadius: number;
}

/** Lobbed / fired projectile (PROJECTILES id) from a socket. */
export interface ProjectileAttackParams {
  readonly projectile: string;
  readonly socket: string;
  /** Aim point below the target's eye (m): chest height. */
  readonly aimDrop: number;
  /** 0..1 velocity lead (fairness: < 1 lets strafing players dodge). */
  readonly leadFactor: number;
  /** Random aim scatter: the aim point lands within this radius around the predicted one (m, XZ). */
  readonly aimError: number;
}

export interface EnemyAttackDef {
  /** Attack id (events, audio, animation: must match the visual def's attack anim id). */
  readonly id: string;
  readonly kind: EnemyAttackKind;
  /** Start when the target's feet are between minRange and range (m, horizontal). */
  readonly minRange: number;
  readonly range: number;
  /** Phase durations (s): telegraph, active, recovery. Leap/charge: `strike` = max flight/dash. */
  readonly windup: number;
  readonly strike: number;
  readonly recover: number;
  /** Earliest restart after this attack STARTED (s). */
  readonly cooldown: number;
  /** HP on hit (before spawn/elite damage multipliers). */
  readonly damage: number;
  /** Several possible → highest priority first. */
  readonly priority: number;
  /** Needs a melee token of the AttackSlotCoordinator (limits simultaneous attackers). */
  readonly usesSlot: boolean;
  /** Needs a fresh line of sight to start. */
  readonly requiresLos: boolean;
  /** Target tracking while winding up (DEGREES/s); 0 = direction locked at the start. */
  readonly trackTurnRateDeg: number;
  /** Camera trauma when it hits the player. */
  readonly shake: number;
  /** Audio id played at the wind-up (positional, via enemy:attack). */
  readonly sound: string;
  readonly melee?: MeleeParams;
  readonly leap?: LeapParams;
  readonly charge?: ChargeParams;
  readonly slam?: SlamParams;
  readonly projectile?: ProjectileAttackParams;
}

export interface SwarmBehaviourDef {
  /** Waiting ring (m from the target) for swarmers without an attack token. */
  readonly ringRadius: number;
  /** Token holders close in to this distance (m) before biting. */
  readonly standoff: number;
  /** Ask for a token within this distance of the target (m). */
  readonly engageDistance: number;
  /** Waiting swarmers pace left/right around their slot: amplitude (DEGREES) and rate (Hz). */
  readonly orbitAmplitudeDeg: number;
  readonly orbitHz: number;
  /** Surround slot re-evaluation period (s, staggered per enemy). */
  readonly slotInterval: number;
}

export interface RangedBehaviourDef {
  /** Preferred distance band to the target (m). */
  readonly bandMin: number;
  readonly bandPreferred: number;
  readonly bandMax: number;
  /** Reposition when the target has been out of sight this long (s). */
  readonly losLostTime: number;
  /** Candidate firing spots per search (sampled around the target at bandPreferred). */
  readonly searchCandidates: number;
  /** Candidates are spread over ±this around the current bearing (DEGREES) ... */
  readonly searchArcDeg: number;
  /** ... and jittered by nav.randomPointAround within this radius (m). */
  readonly searchJitter: number;
  /**
   * Cover = a sideways step of this length from the spot breaks the line of sight (m): the
   * spitter peeks out, spits and ducks back behind it until its next shot is almost ready.
   */
  readonly coverProbe: number;
  /** Leave cover this long before the projectile attack is ready again (s); hide at most this long (s). */
  readonly peekLead: number;
  readonly hideTimeout: number;
  readonly weights: {
    readonly los: number;
    readonly cover: number;
    /** Per meter of travel. */
    readonly travel: number;
    /** Per meter away from bandPreferred. */
    readonly band: number;
    /** Per ally spot within crowdRadius. */
    readonly crowd: number;
  };
  readonly crowdRadius: number;
  /** Give up on a spot after this long (s) / on a strafe step after this long (s). */
  readonly repositionTimeout: number;
  readonly strafeTimeout: number;
  /** Run to spots farther than this (m), walk to closer ones. */
  readonly runDistance: number;
  /** Strafe between shots: sideways distance (m) and the pause range between strafes (s). */
  readonly strafeDistance: number;
  readonly strafeInterval: readonly [number, number];
  /** Arrived at a spot within this distance (m). */
  readonly arriveDistance: number;
}

export interface BruteBehaviourDef {
  /** Run instead of walk when the target is farther than this (m). */
  readonly runDistance: number;
  /** Token holders close in to this distance (m) to swipe / slam. */
  readonly standoff: number;
  /** Ask for a melee token within this distance of the target (m). */
  readonly engageDistance: number;
  /**
   * Without a token the brute keeps this distance (m, inside the charge range) instead of walling
   * the player in – closer ones (after a charge) back off; ± waitSlack is close enough (m).
   */
  readonly waitRadius: number;
  readonly waitSlack: number;
  /** Re-check the straight charge lane every N seconds (nav.walkable). */
  readonly laneCheckInterval: number;
}

/**
 * M4 rift seals: how a type tears a sealed spawn point open ('breach' state). The tearing swings
 * play the animation of attack `attack` (an id of this type's attacks), fitted so that a segment
 * falls every `segmentTime` seconds; `segmentsPerTear` segments fall per finished tear.
 */
export interface EnemyBreachDef {
  readonly attack: string;
  readonly segmentTime: number;
  readonly segmentsPerTear: number;
}

/** Acid sac rupture on death (spitter): AoE + puddle. */
export interface DeathBurstDef {
  readonly radius: number;
  readonly innerRadius: number;
  readonly minFactor: number;
  readonly playerDamage: number;
  /** Damage to other enemies in the radius (credited to the killer). */
  readonly enemyDamage: number;
  readonly element: DamageElement;
  readonly socket: string;
  /** PROJECTILES id whose puddle is left behind (null = none). */
  readonly puddle: string | null;
  readonly shake: number;
}

export interface EnemyTypeDef {
  readonly id: string;
  /** Player-facing name (German). */
  readonly name: string;
  readonly brain: EnemyBrainId;
  readonly health: number;
  /** Impact VFX/SFX and penetration surface of the whole body ... */
  readonly surface: FleshSurface;
  /** ... except these zones (a tank's armored front sparks, its flesh bleeds). */
  readonly zoneSurfaces: Readonly<Partial<Record<HitZone, FleshSurface>>>;
  readonly movement: {
    readonly walkSpeed: number;
    readonly runSpeed: number;
    readonly acceleration: number;
    readonly turnRateDeg: number;
    /** Meters per gait cycle (pose phase advances 2π per stride). */
    readonly stride: number;
  };
  /** Crowd agent: radius/height (m), separation weight 0..1. */
  readonly nav: { readonly radius: number; readonly height: number; readonly separation: number };
  /** Kinematic capsule that blocks the player (null = the player can push through, e.g. swarms). */
  readonly collider: { readonly radius: number; readonly height: number } | null;
  readonly zoneMultipliers: Readonly<Partial<Record<HitZone, number>>>;
  /** Flat reduction per hit on `zones`, never below `minFraction` of the hit. */
  readonly armor: { readonly flat: number; readonly minFraction: number; readonly zones: readonly HitZone[] };
  /** Element damage multipliers (missing = 1). */
  readonly resist: Readonly<Partial<Record<DamageElement, number>>>;
  readonly stagger: {
    /** Damage within the decay window that staggers. */
    readonly threshold: number;
    /** Accumulated stagger damage lost per second. */
    readonly decayPerSecond: number;
    readonly duration: number;
    /** No new stagger for this long after one ends (s): no stun-lock. */
    readonly immunity: number;
    /** Weakpoint hits count this much more. */
    readonly weakpointMultiplier: number;
  };
  /** 0..1: fraction of hit impulses ignored. */
  readonly knockbackResistance: number;
  readonly attacks: readonly EnemyAttackDef[];
  readonly perception: {
    readonly sightRange: number;
    readonly fovDeg: number;
    /** Hears gunshots within this distance (m). */
    readonly hearingRadius: number;
    /** Forget the last known position after this long without news (s). */
    readonly memory: number;
    /**
     * Socket whose height the line of sight starts at, on the body axis (spitter: its mouth – what
     * it fires from; the socket itself may stick out through a thin wall).
     */
    readonly eyeSocket: string;
    /** Fallback eye height when the socket is unknown (m). */
    readonly eyeHeight: number;
  };
  readonly swarm?: SwarmBehaviourDef;
  readonly ranged?: RangedBehaviourDef;
  readonly brute?: BruteBehaviourDef;
  /** Rift emergence (s): pose.emerge 0 → 1, no movement / attacks meanwhile. */
  readonly emergeTime: number;
  readonly death: {
    /** Collapse animation (pose.death), corpse linger, dissolve (s). */
    readonly collapse: number;
    readonly linger: number;
    readonly dissolve: number;
    readonly burst: DeathBurstDef | null;
  };
  /**
   * Melee token pool (ENEMY_AI.slots.pools) and the units one holder takes. Pools are separate
   * budgets per target: the swarm's bites and a tank's slams do not queue behind each other.
   */
  readonly slotPool: SlotPoolId;
  readonly slotCost: number;
  /** M4 rift seals: tearing a sealed spawn point open (missing: ENEMY_AI.breach.fallback). */
  readonly breach?: EnemyBreachDef;
  /** M6 bosses: immune to the instakill power-up and skipped by the nuke (killAll). */
  readonly boss?: boolean;
  /** M4 economy hooks (points). */
  readonly points: {
    readonly hit: number;
    readonly kill: number;
    readonly headshotBonus: number;
    readonly weakpointBonus: number;
  };
  /** Audio ids (positional, played by the audio bridge from enemy:* events). */
  readonly audio: {
    readonly spawn: string;
    readonly alert: string;
    readonly hurt: string;
    readonly death: string;
    readonly step: string;
    readonly idle: string;
    /** Idle vocal interval range (s). */
    readonly idleInterval: readonly [number, number];
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const NO_ARMOR = { flat: 0, minFraction: 1, zones: [] as readonly HitZone[] } as const;

/**
 * Schwärmer: fast insectoid swarm melee. Weak alone, dangerous in numbers: surrounds the player
 * (flanks to the sides/back), only a few bite at once, the rest pace on a ring and rotate in.
 */
const SWARMER: EnemyTypeDef = {
  id: 'swarmer',
  name: 'Schwärmer',
  brain: 'swarm',
  health: 60,
  surface: 'flesh',
  zoneSurfaces: {},
  movement: { walkSpeed: 3.2, runSpeed: 7, acceleration: 28, turnRateDeg: 540, stride: 0.9 },
  nav: { radius: 0.35, height: 0.8, separation: 0.5 },
  collider: null,
  zoneMultipliers: { head: 2, limb: 0.75 },
  armor: NO_ARMOR,
  resist: {},
  stagger: { threshold: 30, decayPerSecond: 40, duration: 0.45, immunity: 0.8, weakpointMultiplier: 1.5 },
  knockbackResistance: 0.2,
  attacks: [
    {
      id: 'bite',
      kind: 'melee',
      minRange: 0,
      range: 1.7,
      windup: 0.35,
      strike: 0.12,
      recover: 0.45,
      cooldown: 0.8,
      damage: 7,
      priority: 1,
      usesSlot: true,
      requiresLos: true,
      trackTurnRateDeg: 360,
      shake: 0.12,
      sound: 'enemy.swarmer.bite',
      melee: { reach: 1.5, coneDeg: 120, height: 1.2 },
    },
    {
      id: 'leap',
      kind: 'leap',
      minRange: 3.5,
      range: 7.5,
      windup: 0.45,
      strike: 0.55,
      recover: 0.5,
      cooldown: 9,
      damage: 10,
      priority: 2,
      usesSlot: true,
      requiresLos: true,
      trackTurnRateDeg: 300,
      shake: 0.3,
      sound: 'enemy.swarmer.leap',
      leap: {
        maxDistance: 7,
        arcHeight: 1.1,
        stopShort: 1,
        leadFactor: 0.5,
        bodyHeight: 0.5,
        hitRadius: 0.75,
      },
    },
  ],
  perception: {
    sightRange: 30,
    fovDeg: 140,
    hearingRadius: 28,
    memory: 6,
    eyeSocket: 'head',
    eyeHeight: 0.5,
  },
  swarm: {
    ringRadius: 4.5,
    standoff: 1.2,
    engageDistance: 7.5,
    orbitAmplitudeDeg: 22,
    orbitHz: 0.22,
    slotInterval: 1.2,
  },
  emergeTime: 0.9,
  death: { collapse: 0.45, linger: 0.5, dissolve: 0.9, burst: null },
  breach: { attack: 'bite', segmentTime: 1.5, segmentsPerTear: 1 },
  slotPool: 'light',
  slotCost: 1,
  points: { hit: 10, kill: 60, headshotBonus: 40, weakpointBonus: 40 },
  audio: {
    spawn: 'enemy.swarmer.spawn',
    alert: 'enemy.swarmer.alert',
    hurt: 'enemy.swarmer.hurt',
    death: 'enemy.swarmer.death',
    step: 'enemy.swarmer.step',
    idle: 'enemy.swarmer.idle',
    idleInterval: [2.5, 6],
  },
};

/**
 * Spucker: ranged support. Keeps a distance band, needs line of sight to spit (lobbed acid glob with
 * splash + puddle), repositions to spots with sight and nearby cover, strafes between shots. The
 * glowing acid sac under the throat is the weakpoint and ruptures on death (AoE, chain reactions).
 */
const SPITTER: EnemyTypeDef = {
  id: 'spitter',
  name: 'Spucker',
  brain: 'ranged',
  health: 110,
  surface: 'slime',
  zoneSurfaces: {},
  movement: { walkSpeed: 2.2, runSpeed: 4.2, acceleration: 14, turnRateDeg: 300, stride: 1.3 },
  nav: { radius: 0.4, height: 1.6, separation: 0.8 },
  collider: { radius: 0.35, height: 1.5 },
  zoneMultipliers: { weakpoint: 2.5, head: 1.25, limb: 0.8 },
  armor: NO_ARMOR,
  resist: { poison: 0.25 },
  stagger: { threshold: 55, decayPerSecond: 35, duration: 0.7, immunity: 1.5, weakpointMultiplier: 2 },
  knockbackResistance: 0.5,
  attacks: [
    {
      id: 'spit',
      kind: 'projectile',
      minRange: 4,
      range: 24,
      windup: 0.65,
      strike: 0.15,
      recover: 0.7,
      cooldown: 3.2,
      damage: 0,
      priority: 1,
      usesSlot: false,
      requiresLos: true,
      trackTurnRateDeg: 240,
      shake: 0,
      sound: 'enemy.spitter.spit',
      projectile: { projectile: 'acid.glob', socket: 'mouth', aimDrop: 0.45, leadFactor: 0.7, aimError: 0.5 },
    },
    {
      id: 'swipe',
      kind: 'melee',
      minRange: 0,
      range: 1.8,
      windup: 0.4,
      strike: 0.15,
      recover: 0.55,
      cooldown: 1.6,
      damage: 12,
      priority: 2,
      usesSlot: false,
      requiresLos: true,
      trackTurnRateDeg: 300,
      shake: 0.2,
      sound: 'enemy.spitter.swipe',
      melee: { reach: 1.7, coneDeg: 110, height: 1.4 },
    },
  ],
  perception: {
    sightRange: 40,
    fovDeg: 120,
    hearingRadius: 35,
    memory: 8,
    eyeSocket: 'mouth',
    eyeHeight: 1.45,
  },
  ranged: {
    bandMin: 8,
    bandPreferred: 13,
    bandMax: 21,
    losLostTime: 1.2,
    searchCandidates: 6,
    searchArcDeg: 110,
    searchJitter: 2.5,
    coverProbe: 1.6,
    peekLead: 0.6,
    hideTimeout: 3.5,
    weights: { los: 10, cover: 2.5, travel: 0.25, band: 0.35, crowd: 1.5 },
    crowdRadius: 4,
    repositionTimeout: 7,
    strafeTimeout: 3,
    runDistance: 5,
    strafeDistance: 2.6,
    strafeInterval: [1.2, 2.6],
    arriveDistance: 0.4,
  },
  emergeTime: 1.1,
  death: {
    collapse: 0.8,
    linger: 0.5,
    dissolve: 1.1,
    burst: {
      radius: 3.2,
      innerRadius: 1,
      minFactor: 0.3,
      playerDamage: 20,
      enemyDamage: 80,
      element: 'poison',
      socket: 'sac',
      puddle: 'acid.glob',
      shake: 0.25,
    },
  },
  breach: { attack: 'swipe', segmentTime: 2, segmentsPerTear: 1 },
  slotPool: 'light',
  slotCost: 1,
  points: { hit: 10, kill: 90, headshotBonus: 40, weakpointBonus: 60 },
  audio: {
    spawn: 'enemy.spitter.spawn',
    alert: 'enemy.spitter.alert',
    hurt: 'enemy.spitter.hurt',
    death: 'enemy.spitter.death',
    step: 'enemy.spitter.step',
    idle: 'enemy.spitter.idle',
    idleInterval: [3, 7],
  },
};

/**
 * Tank: hulking armored brute. Slow approach, telegraphed charge (straight dash, staggers itself on
 * walls), ground slam when close (one tank at a time: heavy token pool; the others hold at the wait
 * ring and charge). Armored front ('shield' zones ×0.3 + flat armor), glowing
 * weakpoint core in the back (×3): flank it.
 */
const TANK: EnemyTypeDef = {
  id: 'tank',
  name: 'Koloss',
  brain: 'brute',
  health: 900,
  // Armored as a whole (bullets do not pass through it), but only the front plates ('shield')
  // spark and shrug hits off; the biomechanical flesh around them and the glowing back core
  // bleed – readable feedback for "flank it".
  surface: 'armor',
  zoneSurfaces: { body: 'flesh', limb: 'flesh', head: 'flesh', weakpoint: 'flesh' },
  movement: { walkSpeed: 2.4, runSpeed: 3.6, acceleration: 10, turnRateDeg: 150, stride: 2.1 },
  nav: { radius: 0.9, height: 2.4, separation: 1 },
  collider: { radius: 0.8, height: 2.3 },
  zoneMultipliers: { shield: 0.3, weakpoint: 3, head: 1.25, limb: 0.7 },
  armor: { flat: 2, minFraction: 0.5, zones: ['shield'] },
  resist: {},
  stagger: { threshold: 260, decayPerSecond: 60, duration: 1.1, immunity: 4, weakpointMultiplier: 2 },
  knockbackResistance: 0.95,
  attacks: [
    {
      id: 'slam',
      kind: 'slam',
      minRange: 0,
      range: 3.2,
      windup: 1,
      strike: 0.2,
      recover: 1.1,
      cooldown: 4.5,
      damage: 32,
      priority: 3,
      usesSlot: true,
      requiresLos: true,
      trackTurnRateDeg: 90,
      shake: 0.7,
      sound: 'enemy.tank.slam',
      slam: {
        radius: 4.2,
        innerRadius: 1.6,
        minFactor: 0.35,
        height: 1.1,
        socket: 'fists',
        forward: 1.4,
        effect: 'land.heavy',
        effectScale: 2.2,
        nearShake: 0.45,
        shakeRadius: 9,
      },
    },
    {
      id: 'swipe',
      kind: 'melee',
      minRange: 0,
      range: 2.6,
      windup: 0.55,
      strike: 0.15,
      recover: 0.6,
      cooldown: 2.2,
      damage: 22,
      priority: 2,
      usesSlot: true,
      requiresLos: true,
      trackTurnRateDeg: 150,
      shake: 0.45,
      sound: 'enemy.tank.swipe',
      melee: { reach: 2.3, coneDeg: 130, height: 1.8 },
    },
    {
      id: 'charge',
      kind: 'charge',
      minRange: 6,
      range: 18,
      windup: 0.9,
      strike: 1.4,
      recover: 1,
      cooldown: 8,
      damage: 38,
      priority: 1,
      usesSlot: false,
      requiresLos: true,
      trackTurnRateDeg: 180,
      shake: 0.85,
      sound: 'enemy.tank.charge',
      charge: {
        speed: 13,
        maxDistance: 18,
        turnRateDeg: 25,
        leadFactor: 0.25,
        hitRadius: 1.35,
        wallProbe: 0.6,
        startClearance: 1.5,
        probeHeight: 0.8,
        wallStagger: 1.6,
        overshoot: 3,
        wallEffect: 'land.heavy',
        wallEffectScale: 1.6,
        wallShake: 0.5,
        shakeRadius: 8,
      },
    },
  ],
  perception: {
    sightRange: 30,
    fovDeg: 110,
    hearingRadius: 25,
    memory: 8,
    eyeSocket: 'head',
    eyeHeight: 1.9,
  },
  brute: {
    runDistance: 14,
    standoff: 2,
    engageDistance: 9,
    waitRadius: 7.5,
    waitSlack: 1,
    laneCheckInterval: 0.4,
  },
  emergeTime: 1.6,
  death: { collapse: 1.2, linger: 1.2, dissolve: 1.6, burst: null },
  // Slams through the lattice: slower per tear, but two segments at once.
  breach: { attack: 'slam', segmentTime: 2.4, segmentsPerTear: 2 },
  slotPool: 'heavy',
  slotCost: 1,
  points: { hit: 10, kill: 250, headshotBonus: 50, weakpointBonus: 100 },
  audio: {
    spawn: 'enemy.tank.spawn',
    alert: 'enemy.tank.alert',
    hurt: 'enemy.tank.hurt',
    death: 'enemy.tank.death',
    step: 'enemy.tank.step',
    idle: 'enemy.tank.idle',
    idleInterval: [4, 9],
  },
};

export const ENEMIES = {
  swarmer: SWARMER,
  spitter: SPITTER,
  tank: TANK,
} as const satisfies Record<string, EnemyTypeDef>;

export type EnemyDefId = keyof typeof ENEMIES;

export function getEnemyDef(type: string): EnemyTypeDef | undefined {
  return Object.prototype.hasOwnProperty.call(ENEMIES, type)
    ? (ENEMIES as Record<string, EnemyTypeDef>)[type]
    : undefined;
}

export function enemyTypeIds(): string[] {
  return Object.keys(ENEMIES);
}

/** Attack def by type + attack id (enemy:attack → sound / VFX lookups), undefined if unknown. */
export function getEnemyAttackDef(type: string, attackId: string): EnemyAttackDef | undefined {
  const attacks = getEnemyDef(type)?.attacks;
  if (!attacks) return undefined;
  for (let i = 0; i < attacks.length; i++) if (attacks[i]!.id === attackId) return attacks[i];
  return undefined;
}

// ---------------------------------------------------------------------------
// Shared AI tuning
// ---------------------------------------------------------------------------

export const ENEMY_AI = {
  /** Max living enemies (dying ones keep their record until dissolved). */
  capacity: 64,
  /** Damageable ids start here (training targets use 1_000_000+) and wrap before `maxId`. */
  firstId: 1,
  maxId: 999_999,
  /**
   * Per-tick budgets of the expensive queries (round-robin / first come first served), so 60
   * enemies stay inside ~2.5 ms/tick: LOS rays for perception, extra "urgent" LOS rays right
   * before a ranged attack, nav path queries (surround slot cost), static rays for spot search.
   */
  budget: { losPerTick: 8, urgentLosPerTick: 4, pathsPerTick: 3, spotRaysPerTick: 12 },
  perception: {
    /** A line of sight result older than this is re-checked before ranged attacks (s). */
    losMaxAge: 0.3,
    /** Wave enemies know roughly where the player is (horde sense) – refreshed this often (s). */
    awareOnSpawn: true,
    hordeSenseInterval: 2.5,
    /** Alert event (roar) at most this often across all enemies (s) – audio spam guard. */
    alertSpacing: 0.35,
    /** Aware enemies within this distance of the target alert even without sight (m). */
    alertDistance: 12,
  },
  aggro: {
    /** Aggro targets tracked per enemy (player now; decoys/turrets later). */
    maxTargets: 4,
    /** Threat per HP of damage from a target's side, and the decay (1/s, exponential). */
    damageThreat: 1,
    decay: 0.25,
    /** Selection: threat + bias − distance × this. */
    distanceWeight: 0.5,
    playerBias: 10,
    /** Flank reference without a target yaw: the last shot's aim (for this long, s), else movement. */
    facingShotMemory: 1,
    facingMinSpeed: 0.5,
  },
  slots: {
    /**
     * Melee token units per target and pool: up to 3 swarm-class biters plus one heavy (tank) at a
     * time – pressure without unfair burst, and a tank never waits behind a swarm (or starves it).
     */
    pools: { light: 3, heavy: 1 } satisfies Record<SlotPoolId, number>,
    /** A token is returned after this long (s) even mid-fight: others rotate in. */
    holdTime: 4,
    /** ... or after this many attacks with it. */
    attacksPerToken: 2,
    /** A holder that falls behind this distance gives its token back (m). */
    releaseDistance: 10,
    /** No new melee attack starts within this long of the previous one (s, burst guard). */
    minAttackSpacing: 0.3,
    /** Waiting requests expire when not renewed for this long (s). */
    requestTimeout: 0.5,
    /** A released enemy waits this long before asking again (s). */
    rerequestDelay: 1.2,
    /**
     * Only ask for a token when the feet are within this height of the target's (m): an enemy on
     * the floor below the player's deck would hold a token it cannot use.
     */
    engageHeight: 2,
  },
  /**
   * Per attack kind: attacks of that kind at one target start at least this far apart (s, 0 =
   * free). No synchronized acid volleys, no two tanks charging at once; melee spacing comes from
   * the slot coordinator (slots.minAttackSpacing).
   */
  attackSpacing: { melee: 0, leap: 0, projectile: 0.9, charge: 2.5, slam: 0 } satisfies Record<
    EnemyAttackKind,
    number
  >,
  /**
   * Ready attackers queue for the next spacing slot (longest waiter first); one that has not asked
   * for this long (s) leaves the queue (lost sight, staggered, dead).
   */
  spacingQueueTimeout: 0.1,
  surround: {
    /** Angular slots around the target. */
    slotCount: 10,
    /** Cost weights: being in front of the target's view (0..1 → ×), per other occupant, per meter. */
    frontPenalty: 6,
    occupancyPenalty: 4,
    distanceWeight: 0.35,
    /** Nav path length is compared for the best `pathCandidates` slots (budget permitting). */
    pathCandidates: 2,
    pathWeight: 0.35,
    /** Bonus for keeping the current slot (no jitter). */
    hysteresis: 1.5,
    /** Path cost (m) of an unreachable slot. */
    unreachableCost: 18,
    /** ± fraction of random jitter on the re-evaluation period (staggers the pack). */
    intervalJitter: 0.25,
    /** Waiting enemies walk instead of run within this distance beyond the ring (m). */
    ringWalkMargin: 2.4,
  },
  stuck: {
    /** Progress check period (s), minimal progress (m), actions after N failed checks. */
    interval: 1,
    minProgress: 0.35,
    repathAfter: 2,
    teleportAfter: 4,
    /** Teleport to a random nav point within this radius when the snap point does not help (m). */
    teleportRadius: 2.5,
    /** Snapped position farther than this from the agent → it was off the mesh (m). */
    offMeshDistance: 0.3,
    /** Only when the (navmesh-snapped) move goal is farther than this (m). */
    goalSlack: 1,
    /**
     * No stuck handling within this distance of the aggro target (m): the crowd around the player
     * jams by design (detour resolves it); teleporting there would pop enemies in plain view.
     */
    nearTarget: 8,
    /** After this many stuck teleports without progress the enemy re-emerges near its target. */
    relocateAfter: 2,
  },
  leash: {
    /** Relocate enemies farther than this from their target (m) for `time` seconds. */
    maxDistance: 55,
    checkInterval: 2,
    time: 6,
    /** Relocation spawn point at least this far from the target (m). */
    minRelocateDistance: 14,
    /** Without spawn points: a random nav point within this radius of the target (m) ... */
    fallbackRadius: 22,
    /** ... at least this fraction of minRelocateDistance away. */
    fallbackMinFraction: 0.5,
  },
  knockback: {
    /** Exponential decay of knockback velocity (1/s) and the stop threshold (m/s). */
    friction: 9,
    minSpeed: 0.35,
    maxSpeed: 12,
    /**
     * A tick's accumulated hits must push at least this hard (m/s, after resistance) to start a
     * knockback: shotgun blasts and melee bashes shove, single bullets only flinch (a rifle stream
     * would otherwise stun-lock swarmers in place).
     */
    startSpeed: 2.5,
    /** Wall probe height as a fraction of the nav agent height. */
    probeHeight: 0.5,
  },
  movement: {
    /** Skip nav retargets closer than this to the last one sent (m). */
    retargetDistance: 0.25,
    /** Face the movement direction above this speed, else the target (m/s). */
    faceMoveSpeed: 0.6,
    /** Face the target when closer than this (m). */
    faceTargetDistance: 5,
    /** Keep this gap to the player's capsule (m) – visible positions are pushed out. */
    playerGap: 0.05,
    /**
     * Ring / stand-off goals are checked to lie on the target's floor (ai/floorGoal: off a deck edge
     * they snap to the hall below); the check is repeated once the goal moved this far (m).
     */
    goalRecheckDistance: 1,
  },
  /** Pose: hit flash decay (1/s), flinch per HP fraction and its decay, stagger ramp-in share. */
  pose: {
    hitFlashDecay: 9,
    /**
     * Sustained damage (kind 'beam': beam ticks, arcs, burn / poison ticks): flash peak (of the
     * white-hot 1) and the shortest time between two such pulses (s).
     */
    sustainedFlash: { peak: 0.3, interval: 0.25 },
    flinchPerHealth: 3,
    flinchMax: 0.35,
    flinchDecay: 6,
    staggerRampIn: 0.2,
  },
  /** Player capsule for enemy hit tests (m). */
  player: { radius: 0.38, hitRadius: 0.42 },
  /**
   * The player as a parked crowd agent (enemies steer around it): radius / height (m), teleported
   * after moving more than moveEpsilon (m); creation is retried this often while it fails (s).
   */
  playerAgent: { enabled: true, radius: 0.4, height: 1.8, moveEpsilon: 0.02, retryInterval: 1 },
  elite: {
    scale: 1.12,
    rim: 1,
    rimColor: [1, 0.45, 0.12] as Rgb,
    healthMultiplier: 1.6,
    damageMultiplier: 1.25,
  },
  /** DamageResult objects recycled by Enemy.applyDamage (≥ the deepest nested dealDamage chain). */
  damageResultRing: 16,
  /** First attack of a fresh enemy is ready after a random part (0..this) of its cooldown. */
  firstAttackJitter: 0.5,
  /** weaponId in enemy:died / combat events for killAll (nuke power-up, M4). */
  nukeWeaponId: 'nuke',
  /**
   * M4 rift seals ('breach' state): tearing enemies turn towards the seal at `turnRateDeg`; a
   * target (the player) standing on their side of the seal within `breakoutDistance` (m) frees
   * them at once. `fallback` applies to types without a `breach` def.
   */
  breach: {
    turnRateDeg: 360,
    breakoutDistance: 2.2,
    /** Overlapping enemies at the same seal ease apart at this speed (m/s). */
    separationSpeed: 1.5,
    fallback: { attack: '', segmentTime: 2, segmentsPerTear: 1 } satisfies EnemyBreachDef,
  },
  /** Enemy time scale (Slow Motion power-up): EnemyManager.timeScale is clamped to this range. */
  timeScale: { min: 0.05, max: 2 },
  /** Exponential moving average factor of `stats.aiMsAvg` (per tick). */
  statsSmoothing: 0.1,
} as const;

// ---------------------------------------------------------------------------
// Projectiles (combat/Projectiles.ts)
// ---------------------------------------------------------------------------

export interface ProjectilePuddleDef {
  readonly radius: number;
  /** Max feet height above the puddle that still burns (m). */
  readonly height: number;
  readonly duration: number;
  readonly dps: number;
  /** Damage is applied in ticks (s) – fewer damage events than per-frame DoT. */
  readonly tickInterval: number;
  /** Only on floors: impact normal.y at least this; walls drop a puddle below. */
  readonly minNormalY: number;
  readonly dropDistance: number;
  /** Shrinks away over the last `fadeTime` seconds. */
  readonly fadeTime: number;
  /** Ground decal (defs/vfx DECALS kind, size multiplier) spawned with the puddle (null = none). */
  readonly decal: { readonly kind: string; readonly size: number } | null;
}

export interface ProjectileDef {
  readonly id: string;
  /** weaponId in combat events. */
  readonly weaponId: string;
  /** Lobbed shots: horizontal speed → flight time = distance / lobSpeed (clamped). */
  readonly lobSpeed: number;
  readonly minFlightTime: number;
  readonly maxFlightTime: number;
  /**
   * Under a low ceiling the arc flattens (shorter flight), but the horizontal speed never exceeds
   * this (m/s): it stays a dodgeable glob, not a bullet.
   */
  readonly maxLaunchSpeed: number;
  /** Upward ceiling probes before a lob reach this far (m, 0 = none); the apex keeps this gap (m). */
  readonly ceilingProbe: number;
  readonly ceilingMargin: number;
  /** Downward acceleration (m/s²). */
  readonly gravity: number;
  readonly radius: number;
  readonly lifetime: number;
  /** Direct hit damage. */
  readonly damage: number;
  readonly splash: {
    readonly radius: number;
    readonly innerRadius: number;
    readonly minFactor: number;
    readonly damage: number;
  };
  readonly element: DamageElement;
  /** combat:impact surface (drives impact VFX 'impact.slime' + splatter decal + sound). */
  readonly impactSurface: SurfaceType | FleshSurface;
  /** Collides with / damages the player (enemy shots) and/or damageables (player shots, M5). */
  readonly hitsPlayer: boolean;
  readonly hitsDamageables: boolean;
  /** Max travel per collision substep (m). */
  readonly substep: number;
  readonly directShake: number;
  readonly trail: { readonly effect: string; readonly interval: number; readonly scale: number } | null;
  /**
   * Extra burst at the impact (defs/vfx preset × scale) on top of the surface impact that
   * combat:impact triggers: sells the splash radius (null = none).
   */
  readonly impactEffect: { readonly effect: string; readonly scale: number } | null;
  readonly puddle: ProjectilePuddleDef | null;
  readonly visual: {
    /** Linear RGB × intensity (HDR, blooms). */
    readonly color: Rgb;
    readonly intensity: number;
    readonly size: number;
    /** Length along the velocity relative to the width. */
    readonly stretch: number;
    readonly pulseHz: number;
    readonly pulseAmount: number;
    readonly puddleColor: Rgb;
    readonly puddleIntensity: number;
    /** Puddles spread out over this long (s) and shimmer (Hz, ± fraction of the intensity). */
    readonly puddleGrowTime: number;
    readonly puddlePulseHz: number;
    readonly puddlePulseAmount: number;
    /** Flattened blob height (m) and lift above the floor (m). */
    readonly puddleThickness: number;
    readonly puddleLift: number;
  };
}

export const PROJECTILES = {
  'acid.glob': {
    id: 'acid.glob',
    weaponId: 'spitter.acid',
    lobSpeed: 15,
    minFlightTime: 0.4,
    maxFlightTime: 1.5,
    maxLaunchSpeed: 24,
    ceilingProbe: 12,
    ceilingMargin: 0.25,
    gravity: 16,
    radius: 0.14,
    lifetime: 4,
    damage: 14,
    splash: { radius: 2, innerRadius: 0.6, minFactor: 0.35, damage: 8 },
    element: 'poison',
    impactSurface: 'slime',
    hitsPlayer: true,
    hitsDamageables: false,
    substep: 0.5,
    directShake: 0.2,
    trail: { effect: 'acid.trail', interval: 0.06, scale: 1 },
    impactEffect: { effect: 'impact.slime', scale: 2.6 },
    puddle: {
      radius: 1.1,
      height: 0.8,
      duration: 4,
      dps: 6,
      tickInterval: 0.25,
      minNormalY: 0.6,
      dropDistance: 4,
      fadeTime: 0.8,
      decal: { kind: 'slime', size: 2 },
    },
    visual: {
      color: [0.35, 1, 0.12],
      intensity: 6,
      size: 0.16,
      stretch: 1.6,
      pulseHz: 5,
      pulseAmount: 0.12,
      puddleColor: [0.22, 1, 0.08],
      puddleIntensity: 1.8,
      puddleGrowTime: 0.18,
      puddlePulseHz: 1.3,
      puddlePulseAmount: 0.18,
      puddleThickness: 0.035,
      puddleLift: 0.02,
    },
  },
} as const satisfies Record<string, ProjectileDef>;

export function getProjectileDef(id: string): ProjectileDef | undefined {
  return Object.prototype.hasOwnProperty.call(PROJECTILES, id)
    ? (PROJECTILES as Record<string, ProjectileDef>)[id]
    : undefined;
}

/** Projectile system capacities (preallocated; one InstancedMesh draws both). */
export const PROJECTILE_POOL = {
  projectiles: 48,
  puddles: 16,
  /** Blob mesh tessellation. */
  widthSegments: 10,
  heightSegments: 8,
  /** Line-of-flight iterations of the lead solver. */
  leadIterations: 3,
  /** Ceiling probes along a lob (fractions of origin → aim; the arc peaks around the middle). */
  ceilingSamples: [0.25, 0.5, 0.75],
  /** Re-cast a ray without a damageable the projectile ignores at most this often. */
  maxPassThrough: 4,
  /**
   * Splash reaches what the impact sees from this far off the hit surface (m, along its normal) –
   * never through the wall it hit.
   */
  splashLosOffset: 0.15,
  /** Puddles only burn feet their surface can see at this height (m): not through a wall beside them. */
  puddleLosLift: 0.3,
  /** Puddles burn feet down to this far below their surface (m, slopes / steps) ... */
  puddleDepthTolerance: 0.2,
  /** ... and this fraction of the player radius beyond their rim. */
  puddleFootFraction: 0.5,
} as const;
