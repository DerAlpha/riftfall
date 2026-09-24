/**
 * Pooled enemy record (Damageable). One record per living/dying enemy; records are pooled per type
 * (hitbox arrays, cooldown arrays and the optional Rapier body keep their shape) and reset on spawn.
 *
 * applyDamage is called from inside CombatWorld.dealDamage (weapon tick): it only does the damage
 * math (zone multipliers on top of the weapon's, flat armor, element resistance) and records state –
 * health, hit flash, flinch, stagger accumulation, knockback velocity, aggro, the last damage info.
 * Everything with side effects (events, VFX, death burst, nav/combat unregistration) happens in
 * EnemyManager's tick right after (same tick: enemies tick after the weapons).
 */
import { Color, Vector3 } from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { DamageInfo, DamageResult, Damageable, Hitbox } from '../core/contracts';
import type { DamageElement, FleshSurface, HitZone } from '../core/events';
import { ENEMY_AI, type EnemyTypeDef, type SlotPoolId } from '../defs/enemies';
import type { StuckState } from './ai/StuckMonitor';
import { createEnemyPose, type EnemyInstanceHandle, type EnemyPose } from './types';

/** 'breach': tearing down the rift seal of its spawn point before entering (ai/breach.ts). */
export type EnemyState =
  'free' | 'emerge' | 'breach' | 'active' | 'attack' | 'stagger' | 'dying' | 'dissolve';

/** Attack phases (numeric: index into the phase durations). */
export const PHASE_WINDUP = 0;
export const PHASE_STRIKE = 1;
export const PHASE_RECOVER = 2;
export type AttackPhase = typeof PHASE_WINDUP | typeof PHASE_STRIKE | typeof PHASE_RECOVER;

/**
 * Who moves the enemy: the nav crowd, or the AI directly (the agent is parked meanwhile). 'hold':
 * nobody – the enemy keeps its spot (tearing a rift seal) and ignores knockback.
 */
export type MoveOverride = 'none' | 'leap' | 'charge' | 'knockback' | 'hold';

/** Callbacks into the manager (no import cycle). */
export interface EnemyOwner {
  /** Damage was applied (inside CombatWorld.dealDamage – record only, no side effects). */
  onEnemyDamaged(e: Enemy, info: Readonly<DamageInfo>, applied: number, killed: boolean): void;
  /** Instakill power-up: player damage is lethal (bosses excepted). Optional (default off). */
  readonly instakill?: boolean;
}

/** Melee token pools in index order (ENEMY_AI.slots.pools). */
export const SLOT_POOLS = Object.keys(ENEMY_AI.slots.pools) as SlotPoolId[];

const NO_DAMAGE: DamageResult = Object.freeze({ applied: 0, killed: false });
/**
 * Results come from a small ring instead of a fresh object per hit: callers read them right away,
 * and a nested dealDamage from a combat:damage handler (emitted before CombatWorld reads `killed`
 * for combat:kill) gets its own entry.
 */
const RESULTS: DamageResult[] = Array.from({ length: ENEMY_AI.damageResultRing }, () => ({
  applied: 0,
  killed: false,
}));
let resultCursor = 0;

/**
 * Damage after the enemy's zone multiplier (on top of the weapon's), flat armor on armored zones
 * (never below `armor.minFraction` of the hit) and element resistance. Pure.
 */
export function enemyDamageAmount(
  def: Pick<EnemyTypeDef, 'zoneMultipliers' | 'armor' | 'resist'>,
  zone: HitZone,
  amount: number,
  element: DamageElement,
): number {
  if (!(amount > 0) || !Number.isFinite(amount)) return 0;
  const zm = def.zoneMultipliers[zone];
  let dmg = amount * (zm !== undefined && Number.isFinite(zm) ? Math.max(0, zm) : 1);
  const armor = def.armor;
  if (armor.flat > 0 && armor.zones.includes(zone)) {
    dmg = Math.max(dmg * armor.minFraction, dmg - armor.flat);
  }
  const res = def.resist[element];
  if (res !== undefined && Number.isFinite(res)) dmg *= Math.max(0, res);
  return dmg;
}

export class Enemy implements Damageable {
  // --- Damageable ---
  id = 0;
  alive = false;
  readonly team = 'enemy' as const;
  readonly surface: FleshSurface;
  readonly boundsCenter = new Vector3();
  boundsRadius = 0;
  /** Exactly the hitboxes of the latest tick (view into hitboxStore). */
  readonly hitboxes: Hitbox[] = [];
  readonly hitboxStore: Hitbox[] = [];
  readonly aimPoint = new Vector3();

  // --- identity / setup ---
  readonly type: string;
  readonly def: EnemyTypeDef;
  /** Index of def.slotPool in SLOT_POOLS (melee token pool). */
  readonly poolIndex: number;
  handle: EnemyInstanceHandle = -1;
  agent = -1;
  elite = false;
  health = 0;
  maxHealth = 0;
  damageMult = 1;
  speedMult = 1;
  /** Spawn order (stable round-robin order, staggering). */
  serial = 0;

  // --- state ---
  state: EnemyState = 'free';
  stateTime = 0;
  /** Feet position / velocity at the latest tick. */
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  yaw = 0;
  readonly pose: EnemyPose;

  // --- perception / aggro ---
  aware = false;
  alerted = false;
  canSee = false;
  /** Time of the last LOS check (−∞ = never). */
  losTime = Number.NEGATIVE_INFINITY;
  lastSeenTime = Number.NEGATIVE_INFINITY;
  readonly lastKnown = new Vector3();
  lastKnownTime = Number.NEGATIVE_INFINITY;
  /** Noise time already processed (hearing). */
  heardTime = Number.NEGATIVE_INFINITY;
  nextSenseTime = 0;
  targetSlot = 0;
  threat: Float32Array;
  damagedSinceAlert = false;

  // --- movement request ---
  readonly moveTarget = new Vector3();
  hasMove = false;
  moveSpeed = 0;
  readonly sentTarget = new Vector3();
  sentValid = false;
  sentSpeed = -1;
  agentStopped = true;
  override: MoveOverride = 'none';
  overrideTime = 0;
  overrideDist = 0;
  readonly overrideFrom = new Vector3();
  readonly overrideTo = new Vector3();
  readonly overrideDir = new Vector3();
  readonly knock = new Vector3();
  /** Visible position differs from the parked agent: teleport it when control returns. */
  agentDirty = false;
  /** Brain request for this tick: face the target even while moving (strafing). */
  faceTarget = false;

  // --- attack ---
  attackIndex = -1;
  phase: AttackPhase = PHASE_WINDUP;
  phaseTime = 0;
  attackHit = false;
  /** Earliest start time per attack (def.attacks index). */
  readonly attackReady: Float64Array;
  /** Attack-spacing queue: kind index waited for (-1 = none), since when, last ask. */
  spacingKind = -1;
  spacingSince = 0;
  spacingAskedAt = Number.NEGATIVE_INFINITY;

  // --- stagger / hit reaction ---
  staggerAccum = 0;
  staggerImmuneUntil = 0;
  staggerDuration = 0;
  flinch = 0;
  /** Sustained-damage flash (beam ticks, arcs, burn / poison ticks) re-arms after this (s). */
  sustainedFlashCooldown = 0;

  // --- brain scratch (meaning per brain) ---
  mode = 0;
  modeTime = 0;
  slot = -1;
  slotEvalAt = 0;
  orbitPhase = 0;
  readonly spot = new Vector3();
  spotValid = false;
  spotBest = Number.NEGATIVE_INFINITY;
  readonly spotCandidate = new Vector3();
  searchIndex = 0;
  /** Ranged: the side (+1 left / −1 right of the line of fire) a step hides the spot, 0 = none. */
  coverSide = 0;
  /** Ranged: duck into cover after the current shot; where to. */
  hideAfterShot = false;
  readonly hidePoint = new Vector3();
  strafeSign = 1;
  nextActionTime = 0;
  laneClear = false;
  laneCheckAt = 0;
  /** Last goal checked by goalOnTargetFloor and its result. */
  readonly goalCheck = new Vector3();
  goalChecked = false;
  goalOk = true;

  // --- rift seal breach (ai/breach.ts) ---
  /** Spawn point id whose seal the enemy must tear down before entering (null = none). */
  breachPoint: string | null = null;
  /** Yaw facing the seal. */
  breachYaw = 0;
  /** Time into the current tearing swing (s), its strike landed, strikes towards the next segment. */
  breachSwing = 0;
  breachStruck = false;
  breachHits = 0;

  // --- stuck / leash ---
  readonly stuck: StuckState = { ax: 0, az: 0, next: 0, fails: 0 };
  /** Stuck teleports without progress in between (escalates to a relocation). */
  stuckTeleports = 0;
  leashTime = 0;
  leashCheckAt = 0;

  // --- M5 statuses / fields (EnemyManager.readStatus, statusPose) ---
  /** Movement and attack speed factor of this tick (chill stacks, slow fields); 1 = normal. */
  statusSpeed = 1;
  /** Frozen or stunned this tick: no AI, no attack, the body holds still. */
  halted = false;
  /** The pose rim shows a status tint (the elite rim comes back after it). */
  statusRim = false;

  // --- death bookkeeping ---
  deathPending = false;
  lastWeaponId: string | null = null;
  lastZone: HitZone | null = null;
  lastSource: DamageInfo['source'] = 'environment';
  lastElement: DamageElement = 'physical';

  // --- physics (kinematic blocker, optional) ---
  body: RAPIER.RigidBody | null = null;
  collider: RAPIER.Collider | null = null;
  colliderOn = false;

  constructor(
    def: EnemyTypeDef,
    threatRow: Float32Array,
    private readonly owner: EnemyOwner,
  ) {
    this.type = def.id;
    this.def = def;
    this.poolIndex = Math.max(0, SLOT_POOLS.indexOf(def.slotPool));
    this.surface = def.surface;
    this.threat = threatRow;
    this.attackReady = new Float64Array(def.attacks.length);
    const E = ENEMY_AI.elite;
    this.pose = createEnemyPose(new Color(E.rimColor[0], E.rimColor[1], E.rimColor[2]));
  }

  surfaceAt(zone: HitZone): FleshSurface {
    return this.def.zoneSurfaces[zone] ?? this.surface;
  }

  get attacking(): boolean {
    return this.state === 'attack';
  }

  get healthFraction(): number {
    return this.maxHealth > 0 ? this.health / this.maxHealth : 0;
  }

  applyDamage(info: DamageInfo): DamageResult {
    if (!this.alive || this.state === 'free') return NO_DAMAGE;
    let dmg = enemyDamageAmount(this.def, info.zone, info.amount, info.element);
    // Instakill power-up: any player hit that would hurt at all is lethal (not for bosses).
    if (info.source === 'player' && info.amount > 0 && this.owner.instakill === true && !this.def.boss) {
      dmg = Math.max(dmg, this.health);
    }
    if (!(dmg > 0)) return NO_DAMAGE;
    const applied = Math.min(this.health, dmg);
    this.health -= applied;
    const killed = this.health <= 1e-6;
    this.lastWeaponId = info.weaponId;
    this.lastZone = info.zone;
    this.lastSource = info.source;
    this.lastElement = info.element;

    // Hit reaction (recorded; the manager turns it into pose/state next).
    const P = ENEMY_AI.pose;
    if (info.kind === 'beam' || info.sustained === true) {
      // Sustained damage ticks at up to 12 Hz (beams, field ticks, damage over time): a full flash
      // per tick would hold the body white-hot over its burn / shock rim, or strobe it. A dim
      // pulse at a capped rate instead; it never lowers a stronger flash.
      if (this.sustainedFlashCooldown <= 0) {
        this.pose.hitFlash = Math.max(this.pose.hitFlash, P.sustainedFlash.peak);
        this.sustainedFlashCooldown = P.sustainedFlash.interval;
      }
    } else {
      this.pose.hitFlash = 1;
    }
    this.flinch = Math.min(
      P.flinchMax,
      this.flinch + (applied / Math.max(1, this.maxHealth)) * P.flinchPerHealth,
    );
    const S = this.def.stagger;
    this.staggerAccum += applied * (info.zone === 'weakpoint' ? S.weakpointMultiplier : 1);
    const impulse = info.impulse ?? 0;
    if (impulse > 0 && Number.isFinite(impulse)) {
      const k = impulse * (1 - Math.min(1, Math.max(0, this.def.knockbackResistance)));
      const dx = info.direction.x;
      const dz = info.direction.z;
      const len = Math.hypot(dx, dz);
      if (k > 0 && len > 1e-6) {
        this.knock.x += (dx / len) * k;
        this.knock.z += (dz / len) * k;
        const max = ENEMY_AI.knockback.maxSpeed;
        const s = Math.hypot(this.knock.x, this.knock.z);
        if (s > max) this.knock.multiplyScalar(max / s);
      }
    }

    if (killed) {
      this.health = 0;
      this.alive = false;
      this.deathPending = true;
    }
    this.owner.onEnemyDamaged(this, info, applied, killed);
    const res = RESULTS[resultCursor]!;
    resultCursor = (resultCursor + 1) % RESULTS.length;
    res.applied = applied;
    res.killed = killed;
    return res;
  }
}
