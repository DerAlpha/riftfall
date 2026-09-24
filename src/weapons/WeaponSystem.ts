/**
 * Weapon system (WeaponSystemApi): inventory, per-weapon state machine, hitscan firing, reloads,
 * ADS, switching, melee, inspect, recoil/spread and gamepad aim assist. Data-driven by
 * defs/weapons.ts – no per-weapon code paths.
 *
 * Timing (see CLAUDE.md "Frame / tick flow"):
 * - fixedUpdate(dt) runs on the 60 Hz tick (after player.fixedUpdate): samples input (edges
 *   latched once per frame, like PlayerController), advances the state machine and fires. Fire
 *   timing uses a cooldown accumulator that carries the remainder, so any rpm is exact on
 *   average (shots land on tick boundaries).
 * - update(dt) per frame: latches edges of frames without a tick, blends ADS (per-weapon in/out
 *   times) and feeds the player's counter-pull into the recoil state.
 * - The camera calls modifyLook() in applyLook() (per frame, before the ticks): ADS sensitivity
 *   and – gamepad only – aim assist. fovMultiplier drives the ADS zoom.
 *
 * Hooks: the constructor installs itself as `player.adsProvider` (ADS amount, ADS move speed,
 * sprint blocking) and `camera.lookModifier`; dispose() removes both.
 *
 * States: idle · firing · reloading · equipping · holstering · sprinting (lowered: sprint or
 * mantle; `sprintToFireTime` after it) · meleeing · inspecting. Rules in WEAPON_RULES (ADS/sprint)
 * and WeaponReloadDef (commit point, fire interrupts).
 *
 * Every carried weapon fires with its effective def (resolveWeapon: Rift Forge tier, attachments,
 * element; `effectiveDef` / `setWeaponMods`) and keeps its own fire cycle deadline (`readyAt`), so
 * switching away and back never skips a pump or bolt cycle.
 *
 * Hot-path event payloads (fired, impact, tracer, ammo, shake) are reused objects: handlers must
 * copy what they keep (EventBus contract).
 *
 * Stats (M4, optional `setStats`): def-changing stats (fireRate, reloadSpeed, damage, spread, recoil,
 * magazineSize, reserveAmmo) are one more resolveWeapon mod on every carried weapon (re-resolved
 * when they change; a running reload keeps its timing, ammo above a smaller capacity moves back to
 * the reserve); adsSpeed, headshotMultiplier and meleeDamage apply per use; weaponSlots adds slots
 * to the loadout's count (losing the bonus drops the weapons that no longer fit). Without stats
 * every weapon plays exactly as its def.
 *
 * Fire kinds (M5, by def data – `kind`, never the weapon id; the engine is weapons/fire, an Arsenal):
 * - hitscan: rays as above; projectile: the same shot, but bolts/grenades/orbs through
 *   ProjectileApi (simulated from the rendered camera, drawn from the muzzle);
 * - beam: while fire is held the beam ticks at `beam.tickRate` (each tick is a shot: weapon:fired,
 *   feel, damage; a ray with chain arcs or a cone hitting everything inside) and drains
 *   `ammoPerSecond`; weapon:beam on start/stop; drawn per frame from the muzzle (updateVisuals);
 * - charge: hold fire to charge (`charge.time`), release fires one hitscan shot scaled by the
 *   charge (below `minCharge` it fizzles, ammo kept), auto-release `autoReleaseAfter` after full;
 *   weapon:charge per tick; a new charge needs a new press after an auto-release;
 * - spin-up (`spinUp`, any automatic weapon): holding fire spins the barrels up, shots start at
 *   `startFraction` and the rate follows the spin; weapon:spin per tick while it changes.
 * Specials (WeaponDef.special of the effective def): splitShot (extra rays/projectiles fanned in
 * the view plane), critBurst (every Nth shot, distinct tracer) and ricochet (rays bounce off the
 * world towards the nearest enemy) apply here at fire time; every damage event goes to the
 * arsenal's WeaponSpecials (explosive rounds, chain arcs, element procs, lifesteal, fields on kill).
 * Rift Forge / attachments / element: setWeaponMods (weapon:modsChanged, forge:upgraded + refill).
 */
import { Vector3 } from 'three';
import type {
  CombatHit,
  DamageInfo,
  DamageSource,
  Damageable,
  InputApi,
  ProjectileSpawnOptions,
  LookOut,
  PhysicsApi,
  RenderApi,
  SettingsStore,
  StatsApi,
  WeaponSystemApi,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { FleshSurface, GameEvents, ImpactKind, SurfaceType, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { DEG2RAD, RAD2DEG, clamp01, lerp } from '../core/math';
import { Rng } from '../core/Rng';
import type { Action } from '../defs/input';
import { GAMEPAD } from '../defs/input';
import { ARSENAL, COMBAT } from '../defs/combat';
import { FORGE } from '../defs/forge';
import { getAttachmentDef, isAttachmentCompatible } from '../defs/attachments';
import { MOVEMENT } from '../defs/movement';
import {
  IMPLEMENTED_WEAPON_KINDS,
  WEAPON_RULES,
  getWeaponDef,
  type AttachmentSlot,
  type ReloadMarker,
  type WeaponDef,
  type WeaponStatMods,
} from '../defs/weapons';
import { Arsenal } from './fire/Arsenal';
import {
  TIME_EPS,
  beamAmmoStep,
  chargeDamageFactor,
  chargeStep,
  coneReach,
  splitYawOffset,
  spinRateFactor,
  spinStep,
  yawAround,
} from './fire/fireMath';
import { createSpecialHit, type HitVia } from './fire/types';
import { statusBuildupFor } from './fire/WeaponSpecials';
import type { WeaponCombatApi, CombatRaycastOptions } from '../combat/types';
import type { LookModifier, PlayerCamera } from '../player/PlayerCamera';
import type { AdsProvider, PlayerController } from '../player/PlayerController';
import { aimError, applyAimAssist, inAssistWindow, type AimError } from './aimAssist';
import { HitAccumulator, hitDamage } from './damage';
import {
  burstShotIndex,
  compensateRecoil,
  createRecoilState,
  recoilKick,
  recoilMultiplier,
  recoverRecoil,
  type RecoilKick,
} from './recoil';
import { resolveWeapon, type WeaponModState } from './resolveWeapon';
import {
  createWeaponStatFactors,
  precisionScale,
  readWeaponStats,
  weaponStatMods,
} from '../stats/weaponStats';
import {
  addBloom,
  aimBasis,
  coneDirection,
  coneRadiusPx,
  crosshairSpread,
  diskSample,
  pelletOffset,
  recoverBloom,
  spreadDeg,
  type SpreadContext,
  type Vec2,
} from './spread';

const log = createLogger('weapons');

export type WeaponState =
  'idle' | 'firing' | 'reloading' | 'equipping' | 'holstering' | 'sprinting' | 'meleeing' | 'inspecting';

/** What the weapon system reads from the player (PlayerController satisfies it). */
export type WeaponPlayer = Pick<
  PlayerController,
  | 'position'
  | 'yaw'
  | 'pitch'
  | 'state'
  | 'sprinting'
  | 'crouched'
  | 'grounded'
  | 'horizontalSpeed'
  | 'currentEyeHeight'
  | 'adsProvider'
>;

/**
 * What the weapon system uses of the camera rig (PlayerCamera satisfies it). `aimPitchOffset` is
 * the movement-driven view pitch (landing dip, mantle) the rendered camera – and so the
 * crosshair and the sights – shows on top of the player's pitch: shots follow it (WYSIWYG).
 */
export type WeaponCamera = Pick<
  PlayerCamera,
  'lookDelta' | 'lookModifier' | 'addRecoil' | 'addViewPunch' | 'takeRecoilPitchLoss' | 'aimPitchOffset'
>;

export interface WeaponSystemDeps {
  events: EventBus<GameEvents>;
  input: InputApi;
  settings: SettingsStore;
  player: WeaponPlayer;
  camera: WeaponCamera;
  /** Shots start at the rendered camera position (WYSIWYG). */
  render: Pick<RenderApi, 'camera'>;
  combat: WeaponCombatApi;
  /** Dynamic props for the arsenal the system builds itself when none is given (explosion pushes). */
  physics?: PhysicsApi | null;
  /** World-space muzzle of the current viewmodel (tracer/flash origin). */
  getMuzzleWorld: (out: Vector3) => Vector3;
  /**
   * M5 fire-kinds engine (projectiles, explosions, fields, specials, arsenal visuals). Game shares
   * one with grenades/abilities; without it the system builds its own (tests, tools).
   */
  arsenal?: Arsenal | null;
}

export interface WeaponSystemOptions {
  /** Inventory size (default WEAPON_RULES.inventory.defaultSlots). */
  slots?: number;
  /** Starting weapons (first is equipped). */
  loadout?: readonly string[];
  /** Seed of the gameplay Rng (spread, pellets, recoil randomness). */
  seed?: string | number;
  /** Weapon table lookup override (tests, mods). Default: defs/weapons getWeaponDef. */
  defs?: (id: string) => WeaponDef | undefined;
}

interface WeaponInstance {
  /** Effective def (base + Rift Forge tier + attachments + element, see resolveWeapon). */
  def: WeaponDef;
  readonly base: WeaponDef;
  /** Tier / attachment / element state (setWeaponMods); stat mods are applied on top. */
  mods: WeaponModState;
  mag: number;
  reserve: number;
  tracerCounter: number;
  /** Sim time its fire cycle (pump, bolt, rpm cap) ends: survives switching away and back. */
  readyAt: number;
  /**
   * Rounds fired from the magazine in hand (critBurst: every Nth). A reload that feeds it (magIn,
   * the first shell) and a forge refill start the count again, and each burst starts on a
   * multiple of its length: positional crits (the sixth chamber, the second barrel, the third
   * round of a burst) stay on their round whatever the reloads and cut-short bursts before.
   */
  shotCount: number;
  /** Beam weapons: fraction of a round drained but not yet taken from the magazine. */
  readonly drain: { acc: number };
}

type ShellPhase = 'start' | 'insert' | 'end';

const EDGE_FIRE = 1;
const EDGE_RELOAD = 2;
const EDGE_MELEE = 4;
const EDGE_INSPECT = 8;
const EDGE_NEXT = 16;
const EDGE_PREV = 32;
const EDGE_SPRINT = 64;
/** Slot selection edges: EDGE_SLOT0 << slot index (WEAPON_RULES.inventory.slotActions). */
const EDGE_SLOT0 = 128;
const SLOT_ACTIONS: readonly Action[] = WEAPON_RULES.inventory.slotActions;

const EDGES: readonly (readonly [Action, number])[] = [
  ['fire', EDGE_FIRE],
  ['reload', EDGE_RELOAD],
  ['melee', EDGE_MELEE],
  ['inspect', EDGE_INSPECT],
  ['weaponNext', EDGE_NEXT],
  ['weaponPrev', EDGE_PREV],
  ['sprint', EDGE_SPRINT],
  ...SLOT_ACTIONS.map((a, i) => [a, EDGE_SLOT0 << i] as const),
];

const NO_MARKERS: readonly ReloadMarker[] = [];
const NO_MODS: WeaponModState = {};

/** States the weapon can aim from (inspect is cancelled by aiming). */
const ADS_STATES: ReadonlySet<WeaponState> = new Set(['idle', 'firing', 'inspecting', 'sprinting']);

// Module-level scratch (no per-shot allocations).
const _eye = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _dir = new Vector3();
const _from = new Vector3();
const _end = new Vector3();
const _muzzle = new Vector3();
const _off: Vec2 = { x: 0, y: 0 };
const _kick: RecoilKick = { yaw: 0, pitch: 0 };
const _recover: RecoilKick = { yaw: 0, pitch: 0 };
const _err: AimError = { yaw: 0, pitch: 0, angle: 0, distance: 0 };
const _bestErr: AimError = { yaw: 0, pitch: 0, angle: 0, distance: 0 };
const _spreadCtx: SpreadContext = { ads: 0, speedFactor: 0, airborne: false, crouched: false };
// M5 fire kinds.
const _aim = new Vector3();
const _hitPoint = new Vector3();
const _hitNormal = new Vector3();
const _rico = new Vector3();
const _camFwd = new Vector3();
const _beamFrom = new Vector3();
const _beamTo = new Vector3();
const _segFrom = new Vector3();
const _segDir = new Vector3();

export class WeaponSystem implements WeaponSystemApi, AdsProvider, LookModifier {
  /** Dev: shots never consume ammo. */
  infiniteAmmo = false;
  /** External damage multiplier on top of the weapon's (perks, power-ups; hitDamage `scale`). */
  damageScale = 1;
  readonly stats = { shots: 0, pellets: 0, hits: 0, kills: 0 };

  private readonly events: EventBus<GameEvents>;
  private readonly input: InputApi;
  private readonly settings: SettingsStore;
  private readonly player: WeaponPlayer;
  private readonly camera: WeaponCamera;
  private readonly render: Pick<RenderApi, 'camera'>;
  private readonly combat: WeaponCombatApi;
  private readonly getMuzzleWorld: (out: Vector3) => Vector3;
  private readonly lookupDef: (id: string) => WeaponDef | undefined;
  private readonly rng: Rng;

  private slots: (WeaponInstance | null)[] = [];
  private currentSlot = -1;
  private _state: WeaponState = 'idle';
  private stateTime = 0;
  private stateDuration = 0;
  private disposed = false;

  // --- input (sampled per tick and per frame) ---
  private fireHeld = false;
  private adsHeld = false;
  private latched = 0;
  /** Pad X is shared by reload and interact: true while a press means "interact" (setReloadSuppressor). */
  private reloadSuppressed: () => boolean = () => false;
  /** M5 Rift Forge: the weapon in hand is held by a machine (setStowed). */
  private stowed = false;
  private edgeMask = 0;
  private edgeFrame = -1;
  private inputFrame = 0;

  /** Seconds of simulation (fixed ticks) – fire cycles are stored as sim-time deadlines. */
  private simTime = 0;

  // --- firing ---
  private fireCooldown = 0;
  private pressBuffer = 0;
  /** A shot requested by interrupting a shell reload fires as soon as the weapon is ready. */
  private fireQueued = false;
  private burstLeft = 0;
  private dryFireTimer = 0;
  private sprintRecovery = 0;
  private wasLowered = false;
  private bloom = 0;
  /** Seconds since the last shot (bloom recovery delay). */
  private bloomSince = Number.POSITIVE_INFINITY;
  private readonly recoil = createRecoilState();

  // --- ADS ---
  private adsProgress = 0;
  private _adsAmount = 0;
  private aiming = false;

  // --- reload ---
  private reloadEmpty = false;
  private reloadCommitted = false;
  /** A sprint press during a committed magazine reload: the reload finishes while sprinting. */
  private reloadSprintOk = false;
  private reloadMarker = 0;
  private reloadMarkers: readonly ReloadMarker[] = NO_MARKERS;
  private shellPhase: ShellPhase = 'start';
  private shellTimer = 0;
  private shellInserted = false;
  private shellEndDuration = 0;
  private pumpDone = false;
  private shellInterrupted = false;

  // --- switching ---
  private pendingSlot = -1;
  /** Slots granted by the loadout (setLoadout); the weaponSlots stat adds to it. */
  private baseSlots: number = WEAPON_RULES.inventory.defaultSlots;

  // --- stats (setStats; null = def values) ---
  private statSource: StatsApi | null = null;
  private statVersion = -1;
  private readonly statFactors = createWeaponStatFactors();
  /** resolveWeapon mod from the def-changing stats; null = neutral. */
  private statMods: WeaponStatMods | null = null;

  // --- melee ---
  private meleeCooldown = 0;
  private meleeTarget: Damageable | null = null;
  private meleeHitDone = false;
  private readonly meleeCandidates: Damageable[] = [];

  // --- fire kinds (M5) ---
  private readonly arsenal: Arsenal;
  /** Beam: firing, tick clock, last trace (distance along the aim, chain) for the per-frame visual. */
  private beamActive = false;
  private beamWeapon = '';
  private beamTickTimer = 0;
  /** Sim time of the last beam damage tick (a re-press waits out the rest of its interval). */
  private beamLastTickAt = Number.NEGATIVE_INFINITY;
  private beamDistance = 0;
  private beamPrimary: Damageable | null = null;
  private readonly beamHitPoint = new Vector3();
  private readonly beamChain: Damageable[] = [];
  private readonly beamArcs: Vector3[] = [];
  private beamImpacts = 0;
  /** Charge: 0..1 while charging; time held at full; a new charge needs a new press after an auto-release. */
  private chargeAmount = 0;
  private charging = false;
  private chargeFullTime = 0;
  private chargeNeedsRelease = false;
  private chargeWeapon = '';
  /** Spin-up of the weapon in hand (0..1) and the value last announced. */
  private spin = 0;
  private spinSent = 0;
  private spinWeapon = '';
  /** Damage factor of the shot being fired (charge level × crit). */
  private shotDamageScale = 1;
  /** Tracer color override of the shot being fired (crit), -1 = the def's. */
  private shotTracerColor = -1;
  private readonly chargePayload: GameEvents['weapon:charge'] = { weaponId: '', amount: 0 };
  private readonly spinPayload: GameEvents['weapon:spin'] = { weaponId: '', amount: 0 };
  private readonly damageSource: DamageSource = {
    weaponId: '',
    source: 'player',
    damage: 0,
    element: 'physical',
    headMultiplier: 1,
    weakpointMultiplier: 1,
    statusBuildup: 0,
    special: null,
    areaScale: 1,
  };
  private readonly specialHit = createSpecialHit();
  /** Charge glow shown last frame (hide it once). */
  private chargeShown = false;
  // Bullet segment state (ricochets) and query scratch.
  private segWorldHit = false;
  private segKeep = 1;
  private readonly ricochetCandidates: Damageable[] = [];
  private readonly coneCandidates: Damageable[] = [];
  /** Reused spawn options (created with the first projectile shot). */
  private spawnOpts: ProjectileSpawnOptions | null = null;

  // --- shot scratch ---
  private readonly acc = new HitAccumulator<Damageable>();
  private readonly ignoreList: Damageable[] = [];
  private readonly rayOpts: CombatRaycastOptions = { ignoreMany: [], skipLastProp: false };
  private readonly damageInfo: DamageInfo = {
    amount: 0,
    zone: 'body',
    point: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    weaponId: '',
    element: 'physical',
    source: 'player',
    kind: 'bullet',
    impulse: 0,
    statusBuildup: 0,
  };
  private readonly ammoOut = { mag: 0, reserve: 0, magSize: 0 };
  private readonly ammoOfOut = { mag: 0, reserve: 0, magSize: 0, maxReserve: 0 };

  // --- reused hot-path payloads ---
  private readonly firedPayload: GameEvents['weapon:fired'] = {
    weaponId: '',
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    muzzle: { x: 0, y: 0, z: 0 },
    shotIndex: 0,
    ammoInMag: 0,
    ads: false,
    muzzleLightColor: 0,
    suppressed: false,
  };
  private readonly impactPayload: GameEvents['combat:impact'] = {
    point: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    surface: 'default',
    kind: 'bullet',
    weaponId: '',
    decal: true,
  };
  private readonly tracerPayload: GameEvents['combat:tracer'] = {
    from: { x: 0, y: 0, z: 0 },
    to: { x: 0, y: 0, z: 0 },
    weaponId: '',
    color: 0,
    segment: false,
  };
  private readonly ammoPayload: GameEvents['weapon:ammoChanged'] = {
    weaponId: '',
    mag: 0,
    reserve: 0,
    magSize: 0,
  };
  private readonly shakePayload: GameEvents['camera:shake'] = { trauma: 0 };

  constructor(deps: WeaponSystemDeps, options: WeaponSystemOptions = {}) {
    this.events = deps.events;
    this.input = deps.input;
    this.settings = deps.settings;
    this.player = deps.player;
    this.camera = deps.camera;
    this.render = deps.render;
    this.combat = deps.combat;
    this.getMuzzleWorld = deps.getMuzzleWorld;
    this.lookupDef = options.defs ?? getWeaponDef;
    this.rng = new Rng(options.seed ?? 'weapons');
    this.arsenal =
      deps.arsenal ??
      new Arsenal({ events: deps.events, combat: deps.combat, physics: deps.physics ?? null });
    for (let i = 0; i < ARSENAL.specials.maxChain * 2; i++) this.beamArcs.push(new Vector3());
    this.player.adsProvider = this;
    this.camera.lookModifier = this;
    this.setLoadout(options.loadout ?? [], options.slots);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get state(): WeaponState {
    return this._state;
  }
  get currentWeaponId(): string | null {
    return this.current?.def.id ?? null;
  }
  get currentDef(): WeaponDef | null {
    return this.current?.def ?? null;
  }
  get slotIndex(): number {
    return this.currentSlot;
  }
  get slotCount(): number {
    return this.slots.length;
  }
  /** Weapon ids per slot (null = empty). */
  get slotIds(): (string | null)[] {
    return this.slots.map((s) => s?.def.id ?? null);
  }
  get adsAmount(): number {
    return this._adsAmount;
  }
  /** Current cone half-angle (deg). */
  get spreadDegrees(): number {
    const w = this.current;
    return w ? this.currentSpreadDeg(w.def) : 0;
  }
  /** Normalized spread 0..1 (debug readouts; the crosshair uses crosshairRadiusPx). */
  get spread(): number {
    return crosshairSpread(this.spreadDegrees, WEAPON_RULES.crosshairMaxSpreadDeg);
  }
  /** On-screen radius (px) of the current cone for a viewport `viewportHeight` px tall (render camera FOV). */
  crosshairRadiusPx(viewportHeight: number): number {
    return coneRadiusPx(this.spreadDegrees, this.render.camera.fov, viewportHeight);
  }
  /** Unrecovered recoil (deg, pitch up) – debug overlay. */
  get recoilOffsetPitch(): number {
    return this.recoil.pitch;
  }
  /** Seconds of the current state / its planned duration (animation sync, HUD reload bar). */
  get stateProgress(): number {
    return this.stateDuration > 0 ? clamp01(this.stateTime / this.stateDuration) : 0;
  }
  /** Reused object – copy what you keep. */
  get ammo(): { mag: number; reserve: number; magSize: number } | null {
    const w = this.current;
    if (!w) return null;
    this.ammoOut.mag = w.mag;
    this.ammoOut.reserve = w.reserve;
    this.ammoOut.magSize = w.def.magazine;
    return this.ammoOut;
  }
  /** Ammo of a carried weapon, in hand or holstered (M4 wall buys); null if not carried. Reused object. */
  ammoOf(weaponId: string): { mag: number; reserve: number; magSize: number; maxReserve: number } | null {
    for (const w of this.slots) {
      if (w?.def.id !== weaponId) continue;
      const o = this.ammoOfOut;
      o.mag = w.mag;
      o.reserve = w.reserve;
      o.magSize = w.def.magazine;
      o.maxReserve = w.def.reserve;
      return o;
    }
    return null;
  }

  // --- M5 fire kinds (debug readouts, HUD) ---
  /** The fire-kinds engine this system fires through. */
  get fireKinds(): Arsenal {
    return this.arsenal;
  }
  /** 0..1 charge of the weapon in hand (charge kind). */
  get chargeLevel(): number {
    return this.chargeAmount;
  }
  /** 0..1 barrel spin of the weapon in hand (spin-up). */
  get spinLevel(): number {
    return this.spin;
  }
  /** A beam is firing. */
  get beamFiring(): boolean {
    return this.beamActive;
  }

  // --- AdsProvider (PlayerController) ---
  get adsMoveSpeedMultiplier(): number {
    return this.current?.def.ads.moveSpeedMultiplier ?? MOVEMENT.ground.adsSpeedMultiplier;
  }
  /** Heavy weapons slow the carrier (WeaponDef.carrySpeedMultiplier, moveSpeed mods on top). */
  get carrySpeedMultiplier(): number {
    const m = this.current?.def.carrySpeedMultiplier;
    return m !== undefined && m > 0 && Number.isFinite(m) ? m : 1;
  }
  get blocksSprint(): boolean {
    const w = this.current;
    if (!w || this.disposed || this.stowed) return false;
    const s = this._state;
    // A sprint press is honoured at once (the player ticks first): it cancels an uncommitted
    // reload in this tick, or lets a committed one finish while sprinting (toggle sprint must
    // not lose the press).
    if (s === 'reloading') {
      return !(this.reloadSprintOk || this.input.pressed('sprint') || (this.latched & EDGE_SPRINT) !== 0);
    }
    const ready = s === 'idle' || s === 'firing' || s === 'sprinting' || s === 'inspecting';
    if (!ready) return false;
    // A press still waiting for its shot counts like a held trigger: a tap out of a sprint must
    // not let hold/auto sprint resume (and lower the weapon again) before the raise is done.
    const fireWanted =
      this.input.isDown('fire') ||
      this.input.pressed('fire') ||
      (this.latched & EDGE_FIRE) !== 0 ||
      this.pressBuffer > 0;
    if (fireWanted && (w.mag > 0 || w.reserve > 0)) return true;
    return this.input.isDown('ads');
  }

  // --- LookModifier (PlayerCamera) ---
  get fovMultiplier(): number {
    const w = this.current;
    return w ? lerp(1, w.def.ads.zoom, this._adsAmount) : 1;
  }

  modifyLook(look: LookOut): void {
    const w = this.current;
    const controls = this.settings.current.controls;
    const adsSens = controls.adsSensitivityMultiplier * (w ? w.def.ads.sensitivityMultiplier : 1);
    const sens = lerp(1, adsSens, this._adsAmount);
    look.yaw *= sens;
    look.pitch *= sens;
    // Aim assist is a gamepad-only feature: never touches mouse input.
    if (this.input.device !== 'gamepad' || !controls.aimAssist || !w) return;
    if (this._state === 'holstering' || this._state === 'equipping') return;
    this.aimAssist(look);
  }

  /** Replace the inventory (slot count, weapons; the first is equipped at once). */
  setLoadout(ids: readonly string[], slots?: number): void {
    // Current stats, without resizing the inventory that is about to be replaced.
    if (this.statsStale) this.readStats();
    this.baseSlots = slots ?? WEAPON_RULES.inventory.defaultSlots;
    this.stowed = false;
    const n = this.slotTotal();
    if (this._state === 'reloading') this.finishReload(false);
    this.endFireKinds();
    this.slots = [];
    for (let i = 0; i < n; i++) this.slots.push(null);
    this.currentSlot = -1;
    this.pendingSlot = -1;
    this._state = 'idle';
    let first = -1;
    for (const id of ids) {
      const inst = this.createInstance(id);
      if (!inst) continue;
      const free = this.slots.indexOf(null);
      if (free < 0) {
        log.warn(`Loadout: no free slot for "${id}"`);
        break;
      }
      this.slots[free] = inst;
      if (first < 0) first = free;
    }
    if (first >= 0) this.equipSlot(first, null);
    else this.emitInventory();
  }

  give(weaponId: string): void {
    this.syncStats();
    const existing = this.slots.findIndex((s) => s?.def.id === weaponId);
    if (existing >= 0) {
      this.refillInstance(this.slots[existing]!, true);
      if (existing === this.currentSlot) this.emitAmmo();
      else this.requestSwitch(existing);
      return;
    }
    const inst = this.createInstance(weaponId);
    if (!inst) return;
    const free = this.slots.indexOf(null);
    if (free >= 0) {
      this.slots[free] = inst;
      this.emitInventory();
      if (this.currentSlot < 0) this.equipSlot(free, null);
      else this.requestSwitch(free);
      return;
    }
    // Inventory full (CoD rule): the new weapon replaces the one in hand and is raised directly.
    const slot = Math.max(0, this.currentSlot);
    const previous = this.slots[slot]?.def.id ?? null;
    if (this._state === 'reloading') this.finishReload(false);
    this.slots[slot] = inst;
    this.equipSlot(slot, previous);
  }

  refillAmmo(fillMagazines = false): void {
    this.syncStats();
    for (const s of this.slots) if (s) this.refillInstance(s, fillMagazines);
    this.emitAmmo();
  }

  /** Add `fraction` of every carried weapon's full reserve (ammo scraps, Aasgeier perk). */
  addReserveFraction(fraction: number): void {
    if (!(fraction > 0)) return;
    this.syncStats();
    for (const s of this.slots) {
      if (s) s.reserve = Math.min(s.def.reserve, s.reserve + Math.ceil(s.def.reserve * fraction));
    }
    this.emitAmmo();
  }

  /** Switch to a slot (holster → equip). Ignored for empty/invalid slots. */
  switchTo(slot: number): void {
    this.requestSwitch(slot);
  }

  /** Effective def (tier, attachments, element applied) of a carried weapon; null if not carried. */
  effectiveDef(weaponId: string): WeaponDef | null {
    for (const s of this.slots) if (s?.def.id === weaponId) return s.def;
    return null;
  }

  /**
   * Rift Forge tier / attachments / elemental mod of a carried weapon (M5 entry point: the forge
   * and the workbench); the previous mod state is replaced. Attachments are validated (known,
   * compatible with the weapon, one per slot – later ones in the list win). A running reload of it
   * is cancelled (its timing changed); rounds above a smaller capacity go back to the reserve
   * (capped by its new maximum). A higher tier
   * refills the weapon (FORGE.refillOnUpgrade) and emits forge:upgraded; every call emits
   * weapon:modsChanged. False if the weapon is not carried.
   */
  setWeaponMods(weaponId: string, mods: WeaponModState): boolean {
    this.syncStats();
    const slot = this.slots.findIndex((s) => s?.def.id === weaponId);
    const w = slot >= 0 ? this.slots[slot] : null;
    if (!w) return false;
    if (slot === this.currentSlot && this._state === 'reloading') this.finishReload(false);
    const previousTier = w.mods.tier ?? 0;
    const maxTier = w.base.upgrades.reduce((m, u) => Math.max(m, u.tier), 0);
    const tier = Math.max(0, Math.min(maxTier, Math.floor(mods.tier ?? 0)));
    const attachments = validAttachments(w.base, mods.attachments ?? []);
    const next: WeaponModState = {
      tier,
      attachments,
      element: mods.element ?? null,
      ...(mods.mods ? { mods: mods.mods } : {}),
    };
    if (slot === this.currentSlot) this.endFireKinds();
    w.mods = next;
    // A smaller magazine (extended one taken off) hands its extra rounds back to the reserve.
    this.applyEffectiveDef(w, this.resolveDef(w.base, next));
    const upgraded = tier > previousTier;
    if (upgraded && FORGE.refillOnUpgrade) {
      w.mag = Math.max(w.mag, fullMag(w.def));
      w.reserve = w.def.reserve;
      w.shotCount = 0;
    }
    if (slot === this.currentSlot) this.emitAmmo();
    this.events.emit('weapon:modsChanged', {
      weaponId,
      tier,
      attachments,
      element: next.element ?? null,
    });
    if (upgraded) this.events.emit('forge:upgraded', { weaponId, tier, name: w.def.name });
    return true;
  }

  /** Mod state (tier, attachments, element) of a carried weapon; null if not carried. */
  modsOf(weaponId: string): WeaponModState | null {
    for (const s of this.slots) if (s?.def.id === weaponId) return s.mods;
    return null;
  }

  /** Rift Forge tier of a carried weapon (0 = base, -1 = not carried). */
  tierOf(weaponId: string): number {
    const m = this.modsOf(weaponId);
    return m ? (m.tier ?? 0) : -1;
  }

  /** The weapon in hand is held by the Rift Forge (setStowed). */
  get isStowed(): boolean {
    return this.stowed;
  }

  /**
   * M5 Rift Forge: hand the weapon in hand to a machine (true) – a running reload is cancelled,
   * beam / charge / spin end, nothing fires, aims, reloads, switches, bashes or inspects – and
   * take it back (false): it is raised again (weapon:equipStart + raiseStart as a re-raise). The
   * viewmodel lowers it out of view on its own (ViewmodelRig.setStowed); a new loadout clears it.
   */
  setStowed(stowed: boolean): void {
    if (stowed === this.stowed || this.disposed) return;
    this.stowed = stowed;
    if (stowed) {
      if (this._state === 'reloading') this.finishReload(false);
      this.endFireKinds();
      this.fireQueued = false;
      this.burstLeft = 0;
      this.pressBuffer = 0;
      this.latched = 0;
      return;
    }
    if (this.current) this.equipSlot(this.currentSlot, null, undefined, true, true);
  }

  /** M4: a reload press is ignored while `suppress()` is true (pad X buying at an interactable). */
  setReloadSuppressor(suppress: (() => boolean) | null): void {
    this.reloadSuppressed = suppress ?? (() => false);
  }

  /** Gameplay stats (perks, cards; see the file header). null = def values. */
  setStats(stats: StatsApi | null): void {
    this.statSource = stats;
    this.statVersion = -1;
    this.syncStats(true);
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number): void {
    if (this.disposed || !(dt > 0)) return;
    this.syncStats();
    this.simTime += dt;
    this.sampleInput();
    const edges = this.latched;
    this.latched = 0;
    const firePressed = (edges & EDGE_FIRE) !== 0;
    this.pressBuffer = Math.max(0, this.pressBuffer - dt);
    this.dryFireTimer = Math.max(0, this.dryFireTimer - dt);
    this.meleeCooldown = Math.max(0, this.meleeCooldown - dt);
    // The fire cycle runs on in every state (equipSlot restores a weapon's own remaining cycle).
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    // Held by the Rift Forge: no fire, reload, switch, melee or inspect until it is handed back.
    if (this.stowed) return;

    const w = this.current;
    if (!w) {
      if (firePressed) this.pressBuffer = WEAPON_RULES.pressBuffer;
      const slot = this.switchRequest(edges);
      if (slot >= 0) this.equipSlot(slot, null);
      return;
    }
    const def = w.def;

    // --- lowered weapon: sprint / mantle ---
    const lowered = this.player.sprinting || WEAPON_RULES.loweredMovementStates.includes(this.player.state);
    // The first tick after the sprint is time 0 of the raise (same convention as the fire cooldown).
    if (lowered) this.sprintRecovery = def.sprintToFireTime;
    else if (!this.wasLowered) this.sprintRecovery = Math.max(0, this.sprintRecovery - dt);
    this.wasLowered = lowered;
    if (lowered) {
      // A lowered weapon forgets queued shots and the rest of a burst: nothing may fire on its
      // own once the sprint/mantle is over.
      this.fireQueued = false;
      this.burstLeft = 0;
    }
    // A press lives through the raise after a sprint (sprintToFireTime can exceed the buffer):
    // a tap out of a sprint always fires once the weapon is up.
    if (firePressed) {
      this.pressBuffer = WEAPON_RULES.pressBuffer + (lowered ? def.sprintToFireTime : this.sprintRecovery);
    }

    // --- requests (priority: switch > melee > reload > inspect) ---
    const slot = this.switchRequest(edges);
    if (slot >= 0) this.requestSwitch(slot);
    if ((edges & EDGE_SPRINT) !== 0 && this._state === 'reloading') {
      // A deliberate sprint press cancels an uncommitted magazine reload (the old magazine stays)
      // and ends a shell reload (inserted shells stay; a shot queued by interrupting it is
      // dropped); a committed magazine swap finishes.
      if (def.reload.perShell || !this.reloadCommitted) {
        this.finishReload(false);
        this.fireQueued = false;
      } else this.reloadSprintOk = true;
    }
    if ((edges & EDGE_MELEE) !== 0) this.tryMelee();
    if ((edges & EDGE_RELOAD) !== 0 && !this.reloadSuppressed()) this.tryReload();
    if ((edges & EDGE_INSPECT) !== 0) this.tryInspect();

    // --- state machine ---
    this.stateTime += dt;
    switch (this._state) {
      case 'holstering':
        // The switch was announced (equipStart) when the holster began.
        if (this.stateTime >= this.stateDuration) this.equipSlot(this.pendingSlot, def.id, undefined, false);
        break;
      case 'equipping':
        if (this.stateTime >= this.stateDuration) {
          this._state = 'idle';
          this.events.emit('weapon:equipped', { weaponId: def.id, slot: this.currentSlot });
        }
        break;
      case 'reloading':
        if (def.reload.perShell) this.tickShellReload(w, firePressed, dt);
        else this.tickMagReload(w, firePressed);
        break;
      case 'meleeing':
        this.tickMelee(w);
        break;
      case 'inspecting': {
        const done = this.stateTime >= this.stateDuration;
        if (firePressed || this.fireHeld || this.adsHeld || lowered || done) {
          this.setState('idle', 0);
          // The viewmodel blends its inspect out on this (a dry trigger pull fires no shot).
          this.events.emit('weapon:inspectEnd', { weaponId: def.id, cancelled: !done });
        }
        break;
      }
      case 'idle':
      case 'firing':
        if (lowered) this.setState('sprinting', 0);
        break;
      case 'sprinting':
        if (!lowered) this.setState('idle', 0);
        break;
    }

    // --- firing ---
    const current = this.current;
    if (current) this.tickFire(current, firePressed, dt);

    // --- spread + recoil recovery ---
    if (current) {
      this.bloomSince += dt;
      this.bloom = recoverBloom(this.bloom, current.def.spread, dt, this.bloomSince);
      recoverRecoil(current.def.recoil, this.recoil, dt, _recover);
      if (_recover.pitch !== 0 || _recover.yaw !== 0) {
        // Eased over the tick: high-refresh frames between ticks each get their share (no 60 Hz steps).
        this.camera.addRecoil(_recover.pitch * DEG2RAD, -_recover.yaw * DEG2RAD, dt);
      }
    }
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.syncStats();
    this.sampleInput();
    this.inputFrame++;
    // Counter-pull against the recoil (recoil space: yaw + = right; lookDelta.yaw + = left). Kick
    // the pitch limit swallowed never moved the aim, so it must not be recovered either.
    const ld = this.camera.lookDelta;
    const lost = this.camera.takeRecoilPitchLoss();
    compensateRecoil(this.recoil, -ld.yaw * RAD2DEG, (ld.pitch - lost) * RAD2DEG);
    this.updateAds(dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.endFireKinds();
    this.disposed = true;
    if (this.player.adsProvider === this) this.player.adsProvider = null;
    if (this.camera.lookModifier === this) this.camera.lookModifier = null;
    this.slots = [];
    this.currentSlot = -1;
    this.meleeTarget = null;
    this.acc.reset();
    this.ignoreList.length = 0;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /** Held state + pressed() edges, each edge latched once per frame (tick and update both call it). */
  private sampleInput(): void {
    const input = this.input;
    this.fireHeld = input.isDown('fire');
    this.adsHeld = input.isDown('ads');
    if (this.edgeFrame !== this.inputFrame) {
      this.edgeFrame = this.inputFrame;
      this.edgeMask = 0;
    }
    for (let i = 0; i < EDGES.length; i++) {
      const edge = EDGES[i]!;
      const bit = edge[1];
      if ((this.edgeMask & bit) !== 0 || !input.pressed(edge[0])) continue;
      this.edgeMask |= bit;
      this.latched |= bit;
    }
  }

  private switchRequest(edges: number): number {
    const n = this.slots.length;
    for (let i = 0; i < n && i < SLOT_ACTIONS.length; i++) {
      if ((edges & (EDGE_SLOT0 << i)) !== 0 && this.slots[i]) return i;
    }
    const step = (edges & EDGE_NEXT) !== 0 ? 1 : (edges & EDGE_PREV) !== 0 ? -1 : 0;
    if (step === 0 || n === 0) return -1;
    // Cycle from the weapon being switched to (repeated wheel steps during a switch keep going).
    const from = this._state === 'holstering' && this.pendingSlot >= 0 ? this.pendingSlot : this.currentSlot;
    for (let k = 1; k <= n; k++) {
      const i = (((from + step * k) % n) + n) % n;
      if (this.slots[i] && i !== from) return i;
    }
    return -1;
  }

  // -------------------------------------------------------------------------
  // Inventory / switching
  // -------------------------------------------------------------------------

  private get current(): WeaponInstance | null {
    return this.currentSlot >= 0 ? (this.slots[this.currentSlot] ?? null) : null;
  }

  private createInstance(id: string): WeaponInstance | null {
    const def = this.lookupDef(id);
    if (!def) {
      log.warn(`Unknown weapon "${id}" – ignored`);
      return null;
    }
    // Never fire an unimplemented kind as hitscan (a launcher def would become an instant rifle),
    // nor a kind without its kind data.
    if (!IMPLEMENTED_WEAPON_KINDS.includes(def.kind) || !hasKindData(def)) {
      log.warn(`Weapon "${id}": kind '${def.kind}' is not implemented or lacks its data – ignored`);
      return null;
    }
    const effective = this.resolveDef(def, NO_MODS);
    return {
      def: effective,
      base: def,
      mods: NO_MODS,
      mag: fullMag(effective),
      reserve: effective.reserve,
      tracerCounter: 0,
      readyAt: Number.NEGATIVE_INFINITY,
      shotCount: 0,
      drain: { acc: 0 },
    };
  }

  /** Base def + tier/attachment mods + the current stat mods. */
  private resolveDef(base: WeaponDef, mods: WeaponModState): WeaponDef {
    const sm = this.statMods;
    if (!sm) return resolveWeapon(base, mods);
    return resolveWeapon(base, { ...mods, mods: mods.mods ? [...mods.mods, sm] : [sm] });
  }

  /** Loadout slots + the weaponSlots stat bonus. */
  private slotTotal(): number {
    const n = Math.floor(this.baseSlots + this.statFactors.weaponSlots);
    return Math.max(1, Math.min(WEAPON_RULES.inventory.maxSlots, n));
  }

  /** The stats changed since the last read. */
  private get statsStale(): boolean {
    const stats = this.statSource;
    return stats !== null && stats.version !== this.statVersion;
  }

  /**
   * Re-read the stats when their version moved (cheap compare per tick/frame, and before every
   * inventory change: a perk granted this tick must count for a weapon given this tick).
   */
  private syncStats(force = false): void {
    if (!force && !this.statsStale) return;
    if (this.readStats()) this.emitAmmo();
    if (this.slotTotal() !== this.slots.length) this.resizeSlots(this.slotTotal());
  }

  /** Update the stat factors; true when the def factors changed (carried weapons re-resolved). */
  private readStats(): boolean {
    const stats = this.statSource;
    this.statVersion = stats ? stats.version : -1;
    if (!readWeaponStats(stats, this.statFactors)) return false;
    this.statMods = weaponStatMods(this.statFactors);
    for (const w of this.slots) if (w) this.applyEffectiveDef(w, this.resolveDef(w.base, w.mods));
    return true;
  }

  /**
   * A stat or mod change re-resolved `w`: rounds above a smaller magazine go back to the reserve
   * (a running reload keeps its timing), the reserve is capped by its new maximum.
   */
  private applyEffectiveDef(w: WeaponInstance, def: WeaponDef): void {
    w.def = def;
    const full = fullMag(def);
    if (w.mag > full) {
      w.reserve += w.mag - full;
      w.mag = full;
    }
    w.reserve = Math.min(w.reserve, def.reserve);
  }

  /**
   * Inventory size changed (weaponSlots stat). Growing adds empty slots; shrinking moves weapons of
   * the removed slots into free ones and drops what does not fit (CoD: losing the extra-slot perk
   * loses the third weapon). A dropped weapon in hand is replaced by the switch target, else the
   * first remaining weapon; a dropped switch target re-raises the weapon in hand.
   */
  private resizeSlots(n: number): void {
    const slots = this.slots;
    if (n >= slots.length) {
      while (slots.length < n) slots.push(null);
      this.emitInventory();
      return;
    }
    let dropped: string | null = null;
    for (let i = slots.length - 1; i >= n; i--) {
      const w = slots[i];
      if (!w) continue;
      const free = slots.indexOf(null);
      if (free >= 0 && free < n) {
        slots[free] = w;
        slots[i] = null;
        if (this.currentSlot === i) this.currentSlot = free;
        if (this.pendingSlot === i) this.pendingSlot = free;
        continue;
      }
      if (this.currentSlot === i) {
        dropped = w.def.id;
        // Still in hand: its reload ends (reloadEnd) before it leaves the inventory.
        if (this._state === 'reloading') this.finishReload(false);
      }
      if (this.pendingSlot === i) this.pendingSlot = -1;
    }
    slots.length = n;
    if (dropped === null) {
      if (this._state === 'holstering' && this.pendingSlot < 0) this.equipSlot(this.currentSlot, null);
      else this.emitInventory();
      return;
    }
    this.currentSlot = -1;
    const next = this.pendingSlot >= 0 ? this.pendingSlot : slots.findIndex((s) => s !== null);
    if (next >= 0) this.equipSlot(next, dropped);
    else {
      this._state = 'idle';
      this.emitInventory();
    }
  }

  private refillInstance(w: WeaponInstance, fillMagazine: boolean): void {
    w.reserve = w.def.reserve;
    if (fillMagazine) w.mag = Math.max(w.mag, fullMag(w.def));
  }

  private requestSwitch(slot: number): void {
    if (slot < 0 || slot >= this.slots.length || !this.slots[slot]) return;
    const w = this.current;
    if (!w) {
      this.equipSlot(slot, null);
      return;
    }
    const state = this._state;
    if (state === 'holstering') {
      if (slot === this.currentSlot) {
        // Changed our mind: raise the same weapon again from where the holster got to (its
        // recoil pattern and bloom carry on: a wheel flick must not reset them).
        const back = w.def.equipTime * this.stateProgress;
        this.equipSlot(slot, w.def.id, back, true, true);
      } else if (slot !== this.pendingSlot) {
        this.pendingSlot = slot;
        const rest = Math.max(0, this.stateDuration - this.stateTime);
        this.announceSwitch(w, slot, rest);
      }
      return;
    }
    if (slot === this.currentSlot) return;
    if (state === 'meleeing') {
      this.pendingSlot = slot;
      return;
    }
    if (state === 'reloading') this.finishReload(false);
    this.stopBeam();
    this.cancelCharge();
    let duration = w.def.holsterTime;
    if (state === 'equipping') duration *= this.stateProgress * WEAPON_RULES.holsterDuringEquipScale;
    this.pendingSlot = slot;
    this.fireQueued = false;
    this.burstLeft = 0;
    this.setState('holstering', duration);
    this.events.emit('weapon:holsterStart', {
      weaponId: w.def.id,
      slot: this.currentSlot,
      duration,
      next: this.slots[slot]?.def.id ?? null,
    });
    this.announceSwitch(w, slot, duration);
  }

  /**
   * weapon:equipStart for a switch is emitted when the holster BEGINS: `duration` covers the
   * remaining holster plus the new weapon's equip time and `previous` is the weapon going down
   * (the viewmodel animator plays holster + raise from it; WEAPONS[previous].holsterTime).
   * Equip sound and HUD follow weapon:raiseStart, sent when the new weapon actually comes up.
   */
  private announceSwitch(from: WeaponInstance, slot: number, holsterLeft: number): void {
    const next = this.slots[slot];
    if (!next) return;
    this.events.emit('weapon:equipStart', {
      weaponId: next.def.id,
      slot,
      duration: holsterLeft + next.def.equipTime,
      previous: from.def.id,
    });
  }

  /**
   * Raise the weapon in `slot`; `announce` = emit weapon:equipStart (switches announced it
   * already); `reraise` = the weapon in hand comes back up (a cancelled holster).
   */
  private equipSlot(
    slot: number,
    previous: string | null,
    duration?: number,
    announce = true,
    reraise = false,
  ): void {
    const w = this.slots[slot];
    if (!w) {
      this._state = 'idle';
      return;
    }
    // Beam, charge and spin belong to the weapon going down.
    this.endFireKinds();
    this.currentSlot = slot;
    this.pendingSlot = -1;
    const d = duration ?? w.def.equipTime;
    this.setState('equipping', d);
    // The weapon's own fire cycle continues (switching away and back never skips a pump/bolt).
    this.fireCooldown = Math.max(0, w.readyAt - this.simTime);
    this.burstLeft = 0;
    this.fireQueued = false;
    this.meleeTarget = null;
    if (!reraise) {
      this.bloom = 0;
      this.bloomSince = Number.POSITIVE_INFINITY;
      // A new pattern starts, but the unrecovered kick moved the real aim: it keeps drifting
      // back (at the new weapon's recovery rate, without a delay).
      this.recoil.shotIndex = 0;
      this.recoil.sinceShot = Number.POSITIVE_INFINITY;
    }
    if (announce) this.events.emit('weapon:equipStart', { weaponId: w.def.id, slot, duration: d, previous });
    this.events.emit('weapon:raiseStart', { weaponId: w.def.id, slot, duration: d });
    this.emitInventory();
    this.emitAmmo();
    if (!(d > 0)) {
      this._state = 'idle';
      this.events.emit('weapon:equipped', { weaponId: w.def.id, slot });
    }
  }

  private setState(state: WeaponState, duration: number): void {
    this._state = state;
    this.stateTime = 0;
    this.stateDuration = duration;
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------

  private tickFire(w: WeaponInstance, firePressed: boolean, dt: number): void {
    const def = w.def;
    const state = this._state;
    const ready =
      (state === 'idle' || state === 'firing') && this.sprintRecovery <= 0 && !this.player.sprinting;
    if (def.kind === 'beam') {
      this.tickBeam(w, ready, firePressed, dt);
      return;
    }
    if (def.kind === 'charge') {
      this.tickCharge(w, ready, firePressed, dt);
      return;
    }
    const spinDef = def.spinUp ?? null;
    if (spinDef) {
      this.spinWeapon = def.id;
      this.spin = spinStep(this.spin, ready && this.fireHeld, dt, spinDef);
      this.announceSpin();
    }
    const pressWanted = this.pressBuffer > 0 || this.fireQueued;
    let wants: boolean;
    switch (def.fireMode) {
      case 'auto':
      case 'pump':
        wants = this.fireHeld || pressWanted;
        break;
      case 'semi':
        wants = pressWanted;
        break;
      case 'burst':
        wants = this.burstLeft > 0 || pressWanted;
        break;
    }
    if (!ready) {
      if (this.fireCooldown < 0) this.fireCooldown = 0;
      return;
    }

    let shots = 0;
    while (wants && this.fireCooldown <= 0 && shots < WEAPON_RULES.maxShotsPerTick) {
      if (w.mag <= 0) {
        if (firePressed && this.dryFireTimer <= 0) {
          this.dryFireTimer = WEAPON_RULES.dryFireInterval;
          this.events.emit('weapon:dryFire', { weaponId: def.id });
        }
        this.pressBuffer = 0;
        this.fireQueued = false;
        this.burstLeft = 0;
        break;
      }
      // Spin-up: no shot until the barrels turn fast enough, then the rate follows the spin.
      const rate = spinDef ? spinRateFactor(this.spin, spinDef) : 1;
      if (!(rate > 0)) {
        this.fireCooldown = 0;
        break;
      }
      if (def.fireMode === 'burst' && this.burstLeft <= 0) {
        const count = Math.max(1, Math.floor(def.burst?.count ?? 1));
        this.burstLeft = count;
        w.shotCount = Math.ceil(w.shotCount / count) * count;
      }
      this.fireShot(w);
      shots++;
      let interval = 60 / (def.rpm * rate);
      if (def.fireMode === 'burst') {
        this.burstLeft--;
        if (this.burstLeft > 0 && def.burst) interval = 60 / def.burst.rpm;
      }
      this.fireCooldown += interval;
      this.pressBuffer = 0;
      this.fireQueued = false;
      wants = def.fireMode === 'semi' ? false : def.fireMode === 'burst' ? this.burstLeft > 0 : this.fireHeld;
    }
    if (!wants && this.fireCooldown < 0) this.fireCooldown = 0;
    if (shots > 0) {
      this._state = 'firing';
      w.readyAt = this.simTime + Math.max(0, this.fireCooldown);
    } else if (this._state === 'firing' && this.fireCooldown <= 0 && !wants) this._state = 'idle';
    this.autoReload(w);
  }

  /** Empty magazine: reload once the last shot's cycle finished. */
  private autoReload(w: WeaponInstance): void {
    if (
      w.mag <= 0 &&
      w.reserve > 0 &&
      WEAPON_RULES.autoReloadOnEmpty &&
      this.fireCooldown <= 0 &&
      !this.beamActive &&
      !this.charging &&
      (this._state === 'idle' || this._state === 'firing')
    ) {
      this.tryReload();
    }
  }

  /**
   * One trigger pull that leaves the barrel: ammo, critBurst, weapon:fired, the rays or
   * projectiles (+ splitShot extras), feel. `chargeFactor` scales the damage (charge kind).
   */
  private fireShot(w: WeaponInstance, chargeFactor = 1): void {
    const def = w.def;
    if (!this.infiniteAmmo) w.mag--;
    this.stats.shots++;
    w.shotCount++;
    const special = def.special ?? null;
    const crit =
      special !== null &&
      special.kind === 'critBurst' &&
      special.everyNth > 0 &&
      w.shotCount % Math.floor(special.everyNth) === 0;
    this.shotDamageScale = chargeFactor * (crit && special.kind === 'critBurst' ? special.multiplier : 1);
    this.shotTracerColor = crit ? ARSENAL.specials.critTracerColor : -1;
    this.eyePosition(_eye);
    aimBasis(this.player.yaw, this.aimPitch, _fwd, _right, _up);
    const spreadRad = this.currentSpreadDeg(def) * DEG2RAD;
    this.readMuzzle();
    const shotIndex = this.emitFired(w);

    if (def.kind === 'projectile' && def.projectile) this.launchProjectiles(w, spreadRad);
    else this.fireRays(w, spreadRad, shotIndex, crit);
    this.shotFeel(w);
    this.shotDamageScale = 1;
    this.shotTracerColor = -1;
  }

  /** The world muzzle as shown (tracer / projectile visual start) into _muzzle; the eye if unknown. */
  private readMuzzle(): void {
    this.getMuzzleWorld(_muzzle);
    if (!Number.isFinite(_muzzle.x) || !Number.isFinite(_muzzle.y) || !Number.isFinite(_muzzle.z)) {
      _muzzle.copy(_eye);
    }
  }

  /** weapon:fired from _eye / _fwd / _muzzle; returns the shot's index within the current burst. */
  private emitFired(w: WeaponInstance): number {
    const def = w.def;
    const fired = this.firedPayload;
    fired.weaponId = def.id;
    copyVec(_eye, fired.origin);
    copyVec(_fwd, fired.direction);
    copyVec(_muzzle, fired.muzzle);
    // Index within the current burst (the recoil pattern restarts after a pause).
    const shotIndex = burstShotIndex(def.recoil, this.recoil);
    fired.shotIndex = shotIndex;
    fired.ammoInMag = w.mag;
    fired.ads = this._adsAmount >= WEAPON_RULES.adsFiredThreshold;
    fired.muzzleLightColor = def.vfx.muzzleLightColor;
    fired.suppressed = def.suppressed === true;
    this.events.emit('weapon:fired', fired);
    return shotIndex;
  }

  /** Hitscan bullets / pellets (+ splitShot rays) from _eye around _fwd. */
  private fireRays(w: WeaponInstance, spreadRad: number, shotIndex: number, crit: boolean): void {
    const def = w.def;
    // Every Nth shot of a burst traces, starting with the first (a tap always shows one).
    if (shotIndex === 0) w.tracerCounter = 0;
    const tracerShot = crit || (def.tracer.everyNth > 0 && w.tracerCounter % def.tracer.everyNth === 0);
    w.tracerCounter++;
    const pellets = Math.max(1, Math.floor(def.pellets));
    const kind: ImpactKind = pellets > 1 ? 'pellet' : 'bullet';
    const rotation = this.rng.next() * 2 * Math.PI;
    this.acc.reset();
    for (let i = 0; i < pellets; i++) {
      if (pellets > 1) {
        pelletOffset(
          i,
          pellets,
          rotation,
          this.rng.range(-1, 1),
          this.rng.range(-1, 1),
          WEAPON_RULES.pellets,
          _off,
        );
      } else {
        diskSample(this.rng.next(), this.rng.next(), _off);
      }
      coneDirection(_fwd, _right, _up, _off.x, _off.y, spreadRad, _dir);
      this.traceBullet(w, _eye, _dir, kind, tracerShot && i < def.tracer.pellets);
    }
    let extra = 0;
    const special = def.special ?? null;
    if (special && special.kind === 'splitShot') {
      extra = Math.max(0, Math.floor(special.count));
      for (let k = 1; k <= extra; k++) {
        yawAround(_fwd, _up, splitYawOffset(k, special.angleDeg * DEG2RAD), _aim);
        diskSample(this.rng.next(), this.rng.next(), _off);
        coneDirection(_aim, _right, _up, _off.x, _off.y, spreadRad, _dir);
        this.traceBullet(w, _eye, _dir, kind, tracerShot);
      }
    }
    this.stats.pellets += pellets + extra;
    this.flushDamage(def, kind);
  }

  /** Projectiles (+ splitShot extras): simulated from the eye, drawn from the muzzle. */
  private launchProjectiles(w: WeaponInstance, spreadRad: number): void {
    const def = w.def;
    const p = def.projectile!;
    const src = this.damageSource;
    const scale = this.damageScale * this.shotDamageScale;
    src.weaponId = def.id;
    src.source = 'player';
    src.damage = def.damage.base * scale;
    src.element = def.damage.element;
    src.headMultiplier = def.damage.headMultiplier * this.statFactors.headshot;
    src.weakpointMultiplier = def.damage.weakpointMultiplier * this.statFactors.headshot;
    src.statusBuildup = statusBuildupFor(def.damage.element);
    src.special = def.special ?? null;
    src.areaScale = scale;
    const opts = (this.spawnOpts ??= {
      origin: _eye,
      direction: _dir,
      visualFrom: _muzzle,
      def: p,
      damage: src,
    });
    opts.def = p;
    opts.damage = src;
    const pellets = Math.max(1, Math.floor(def.pellets));
    for (let i = 0; i < pellets; i++) {
      diskSample(this.rng.next(), this.rng.next(), _off);
      coneDirection(_fwd, _right, _up, _off.x, _off.y, spreadRad, _dir);
      this.arsenal.projectiles.spawn(opts);
    }
    const special = def.special ?? null;
    let extra = 0;
    if (special && special.kind === 'splitShot') {
      extra = Math.max(0, Math.floor(special.count));
      for (let k = 1; k <= extra; k++) {
        yawAround(_fwd, _up, splitYawOffset(k, special.angleDeg * DEG2RAD), _aim);
        diskSample(this.rng.next(), this.rng.next(), _off);
        coneDirection(_aim, _right, _up, _off.x, _off.y, spreadRad, _dir);
        this.arsenal.projectiles.spawn(opts);
      }
    }
    this.stats.pellets += pellets + extra;
  }

  /** Feel of a shot: bloom, recoil, view punch, shake, rumble, ammo event. */
  private shotFeel(w: WeaponInstance): void {
    const def = w.def;
    const player = this.player;
    const ads = this._adsAmount;
    this.bloom = addBloom(this.bloom, def.spread);
    this.bloomSince = 0;
    const r = def.recoil;
    recoilKick(r, this.recoil, this.rng, recoilMultiplier(r, ads, player.crouched), _kick);
    this.camera.addRecoil(_kick.pitch * DEG2RAD, -_kick.yaw * DEG2RAD, r.kickTime);
    const punchScale = lerp(1, r.adsMultiplier, ads) * lerp(1, WEAPON_RULES.adsViewPunchMultiplier, ads);
    // Punch direction is cosmetic jitter (never affects the aim).
    this.camera.addViewPunch(
      r.viewPunch.pitch * DEG2RAD * punchScale,
      (Math.random() * 2 - 1) * r.viewPunch.yaw * DEG2RAD * punchScale,
      (Math.random() * 2 - 1) * r.viewPunch.roll * DEG2RAD * punchScale,
    );
    this.shakePayload.trauma = r.shake * lerp(1, WEAPON_RULES.adsShakeMultiplier, ads);
    this.events.emit('camera:shake', this.shakePayload);
    if (this.input.device === 'gamepad' && this.settings.current.controls.vibration) {
      this.input.rumble(def.rumble.strong, def.rumble.weak, def.rumble.ms);
    }
    this.emitAmmo();
  }

  /**
   * One bullet/pellet: nearest hit, penetration through thin surfaces/bodies while budget remains;
   * ricochet specials bounce it off the world towards the nearest enemy (world-space tracer
   * segments). The first segment's tracer starts at the muzzle as shown.
   */
  private traceBullet(
    w: WeaponInstance,
    origin: Vector3,
    dir: Vector3,
    kind: ImpactKind,
    tracer: boolean,
  ): void {
    const def = w.def;
    const special = def.special ?? null;
    const ric = special && special.kind === 'ricochet' ? special : null;
    let bounces = ric ? Math.max(0, Math.floor(ric.bounces)) : 0;
    let keep = 1;
    let traveled = 0;
    let reach = def.range;
    _segFrom.copy(origin);
    _segDir.copy(dir);
    this.ignoreList.length = 0;
    for (let segment = 0; ; segment++) {
      traveled += this.traceSegment(w, _segFrom, _segDir, reach, kind, keep, traveled);
      keep = this.segKeep;
      if (segment === 0) {
        if (tracer) this.emitTracer(def, _muzzle, _end, false);
      } else {
        this.emitTracer(def, _segFrom, _end, true);
      }
      if (!ric || !this.segWorldHit || bounces <= 0) break;
      bounces--;
      keep *= ric.damageKeep;
      _segFrom.copy(_end).addScaledVector(_hitNormal, COMBAT.penetrationStep);
      this.ricochetDirection(_segFrom, _hitNormal, _segDir);
      reach = ARSENAL.specials.ricochetRange;
    }
    this.ignoreList.length = 0;
  }

  /**
   * One straight part of a bullet from `origin` along `dir` over `reach` (penetrating while the
   * budget lasts). Leaves the end point in _end, whether it stopped on the world (segWorldHit,
   * normal in _hitNormal) and the damage keep (segKeep); returns the distance covered.
   */
  private traceSegment(
    w: WeaponInstance,
    origin: Vector3,
    dir: Vector3,
    reach: number,
    kind: ImpactKind,
    keep0: number,
    traveled0: number,
  ): number {
    const def = w.def;
    const combat = this.combat;
    let power = def.penetration.power;
    let keep = keep0;
    let traveled = 0;
    let skipProp = false;
    this.segWorldHit = false;
    _from.copy(origin);
    _end.copy(origin).addScaledVector(dir, reach);
    const opts = this.rayOpts;
    opts.ignoreMany = this.ignoreList;
    const scale = this.damageScale * this.shotDamageScale;
    for (let pen = 0; pen <= COMBAT.maxPenetrations; pen++) {
      const remaining = reach - traveled;
      if (remaining <= 0) break;
      opts.skipLastProp = skipProp;
      const hit = combat.raycast(_from, dir, remaining, opts);
      if (!hit) {
        _end.copy(_from).addScaledVector(dir, remaining);
        break;
      }
      const distance = traveled + hit.distance;
      _end.copy(hit.point);
      let cost: number;
      const target = hit.target;
      if (target) {
        const zone = hit.zone ?? 'body';
        this.acc.add(
          target,
          hitDamage(
            def.damage,
            zone,
            traveled0 + distance,
            keep,
            scale * precisionScale(zone, this.statFactors.headshot),
          ),
          zone,
          hit.point.x,
          hit.point.y,
          hit.point.z,
        );
        this.emitImpact(hit.point, hit.normal, hit.surface, kind, def.id, false);
        cost = COMBAT.penetrationCost[target.surface];
        this.ignoreList.push(target);
        skipProp = false;
      } else {
        // Read everything before emitting: handlers may raycast, which rewrites the shared hit.
        // World-space decals would float next to a prop that moves away.
        const decal = !combat.hitsDynamicProp(hit);
        const penetrable = hit.penetrable;
        const surface = hit.surface;
        _hitNormal.copy(hit.normal);
        combat.pushProp(hit, dir, def.damage.propImpulse * keep);
        this.emitImpact(_end, _hitNormal, surface, kind, def.id, decal);
        if (!penetrable) {
          this.segWorldHit = true;
          break;
        }
        cost = COMBAT.penetrationCost[surface];
        skipProp = true;
      }
      if (!(power >= cost)) {
        if (!target) this.segWorldHit = true;
        break;
      }
      power -= cost;
      keep *= def.penetration.damageKeep;
      _from.copy(_end).addScaledVector(dir, COMBAT.penetrationStep);
      traveled = distance + COMBAT.penetrationStep;
    }
    this.segKeep = keep;
    return _end.distanceTo(origin);
  }

  /**
   * Ricochet: towards the nearest living enemy in front of the surface (normal hemisphere) within
   * ARSENAL.specials.ricochetRange with line of sight – never one this bullet already hit – else
   * the mirror direction. `dir` holds the incoming direction and receives the new one.
   */
  private ricochetDirection(from: Vector3, normal: Vector3, dir: Vector3): void {
    const range: number = ARSENAL.specials.ricochetRange;
    const list = this.combat.queryRadius(from, range, this.ricochetCandidates);
    let best: Damageable | null = null;
    let bestD = range;
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      if (!t.alive || t.team !== 'enemy' || this.ignoreList.includes(t)) continue;
      _rico.subVectors(t.aimPoint, from);
      const d = _rico.length();
      if (!(d > 1e-6) || d >= bestD || _rico.dot(normal) <= 0) continue;
      if (!this.combat.lineOfSight(from, t.aimPoint)) continue;
      best = t;
      bestD = d;
    }
    list.length = 0;
    if (best) {
      dir.subVectors(best.aimPoint, from).normalize();
      return;
    }
    const dn = dir.dot(normal);
    dir.addScaledVector(normal, -2 * dn).normalize();
  }

  private emitTracer(def: WeaponDef, from: Vec3Like, to: Vec3Like, segment: boolean): void {
    const t = this.tracerPayload;
    copyVec(from, t.from);
    copyVec(to, t.to);
    t.weaponId = def.id;
    t.color = this.shotTracerColor >= 0 ? this.shotTracerColor : def.tracer.color;
    t.segment = segment;
    this.events.emit('combat:tracer', t);
  }

  /**
   * One damage event per zone hit per target (pellets aggregated per zone, best zone first): the
   * target applies its own zone multipliers (armor) to exactly the pellets that hit that zone.
   */
  private flushDamage(def: WeaponDef, kind: ImpactKind): void {
    const acc = this.acc;
    const info = this.damageInfo;
    let previous: Damageable | null = null;
    for (let i = 0; i < acc.count; i++) {
      const target = acc.targets[i]!;
      const firstGroup = target !== previous;
      previous = target;
      if (!target.alive) continue;
      info.amount = acc.amounts[i]!;
      info.zone = acc.zones[i]!;
      const p = info.point;
      p.x = acc.px[i]!;
      p.y = acc.py[i]!;
      p.z = acc.pz[i]!;
      copyVec(_fwd, info.direction);
      info.weaponId = def.id;
      info.element = def.damage.element;
      info.source = 'player';
      info.kind = kind;
      info.impulse = def.damage.impulse * acc.hits[i]!;
      info.statusBuildup = statusBuildupFor(def.damage.element);
      const res = this.combat.dealDamage(target, info);
      const applied = res.applied;
      const killed = res.killed;
      if (firstGroup) this.stats.hits++;
      if (killed) this.stats.kills++;
      this.reportSpecial(def, 'direct', target, p, applied, killed, firstGroup);
    }
    acc.reset();
  }

  /** Hand a damage event of the weapon's special to the arsenal's specials interpreter. */
  private reportSpecial(
    def: WeaponDef,
    via: HitVia,
    target: Damageable,
    point: Vec3Like,
    applied: number,
    killed: boolean,
    primary: boolean,
  ): void {
    const special = def.special ?? null;
    if (!special) return;
    const h = this.specialHit;
    h.special = special;
    h.via = via;
    h.weaponId = def.id;
    h.source = 'player';
    h.target = target;
    copyVec(point, h.point);
    h.applied = applied;
    h.killed = killed;
    h.primary = primary;
    this.arsenal.specials.onHit(h);
  }

  // -------------------------------------------------------------------------
  // Beams (M5)
  // -------------------------------------------------------------------------

  /** Beam kind: fires while held and loaded; ticks at the beam's rate, drains per second. */
  private tickBeam(w: WeaponInstance, ready: boolean, firePressed: boolean, dt: number): void {
    const def = w.def;
    const b = def.beam!;
    if (!ready || !this.fireHeld || w.mag <= 0) {
      if (this.beamActive) this.stopBeam();
      if (ready && firePressed && w.mag <= 0 && this.dryFireTimer <= 0) {
        this.dryFireTimer = WEAPON_RULES.dryFireInterval;
        this.events.emit('weapon:dryFire', { weaponId: def.id });
      }
      this.pressBuffer = 0;
      if (this.fireCooldown < 0) this.fireCooldown = 0;
      if (this._state === 'firing') this._state = 'idle';
      this.autoReload(w);
      return;
    }
    const interval = 1 / b.tickRate;
    if (!this.beamActive) {
      this.beamActive = true;
      this.beamWeapon = def.id;
      // The first tick lands at once – the beam answers the trigger – unless the last tick was
      // less than an interval ago: tapping the trigger must not out-tick holding it.
      this.beamTickTimer = Math.min(interval, this.simTime - this.beamLastTickAt) - dt;
      this.events.emit('weapon:beam', { weaponId: def.id, active: true });
    }
    this._state = 'firing';
    this.pressBuffer = 0;
    let drained = false;
    if (!this.infiniteAmmo) {
      const take = beamAmmoStep(w.drain, b.ammoPerSecond, dt);
      if (take > 0) {
        w.mag = Math.max(0, w.mag - take);
        drained = true;
      }
    }
    this.beamTickTimer += dt;
    let ticks = 0;
    while (this.beamTickTimer >= interval - TIME_EPS && ticks < ARSENAL.beam.maxTicksPerStep) {
      this.beamTickTimer -= interval;
      // The tick's exact time (the remainder carries into the next one).
      this.beamLastTickAt = this.simTime - Math.max(0, this.beamTickTimer);
      this.beamTick(w);
      ticks++;
    }
    if (this.beamTickTimer > interval) this.beamTickTimer = interval;
    w.readyAt = this.simTime;
    if (drained && ticks === 0) this.emitAmmo();
    if (w.mag <= 0) this.stopBeam();
  }

  /** One beam tick: a shot (weapon:fired, feel) whose damage is a ray + chain or a cone. */
  private beamTick(w: WeaponInstance): void {
    const def = w.def;
    const b = def.beam!;
    this.stats.shots++;
    w.shotCount++;
    this.beamImpacts = 0;
    this.eyePosition(_eye);
    aimBasis(this.player.yaw, this.aimPitch, _fwd, _right, _up);
    this.readMuzzle();
    const spreadRad = this.currentSpreadDeg(def) * DEG2RAD;
    diskSample(this.rng.next(), this.rng.next(), _off);
    coneDirection(_fwd, _right, _up, _off.x, _off.y, spreadRad, _dir);
    this.emitFired(w);
    if (b.coneDeg > 0) this.coneTick(w, _dir);
    else this.rayTick(w, _dir);
    this.shotFeel(w);
  }

  /** Ray beam: the first thing along the aim; a body hit chains to `beam.chain.count` more. */
  private rayTick(w: WeaponInstance, dir: Vector3): void {
    const def = w.def;
    const b = def.beam!;
    this.beamPrimary = null;
    this.beamChain.length = 0;
    this.ignoreList.length = 0;
    const opts = this.rayOpts;
    opts.ignoreMany = this.ignoreList;
    opts.skipLastProp = false;
    const hit = this.combat.raycast(_eye, dir, b.range, opts);
    if (!hit) {
      this.beamDistance = b.range;
      return;
    }
    const distance = hit.distance;
    this.beamDistance = distance;
    _hitPoint.copy(hit.point);
    _hitNormal.copy(hit.normal);
    this.beamHitPoint.copy(_hitPoint);
    const target = hit.target;
    const surface = hit.surface;
    if (!target) {
      // No decals: a beam would paint a scorch mark per tick.
      this.combat.pushProp(hit, dir, def.damage.propImpulse);
      this.beamImpact(_hitPoint, _hitNormal, surface, def.id, false);
      return;
    }
    const zone = hit.zone ?? 'body';
    this.beamImpact(_hitPoint, _hitNormal, surface, def.id, false);
    if (!target.alive || target.team === 'player') return;
    const scale = this.damageScale * precisionScale(zone, this.statFactors.headshot);
    const amount = hitDamage(def.damage, zone, distance, 1, scale);
    this.dealBeam(def, target, amount, zone, _hitPoint, dir, def.damage.impulse, true);
    this.beamPrimary = target;
    const chain = b.chain;
    if (!chain || !(chain.count > 0)) return;
    const links = this.arsenal.specials.selectChain(target, chain.count, chain.range, this.beamChain);
    let keep = 1;
    _rico.copy(target.aimPoint);
    for (let i = 0; i < links.length; i++) {
      const t = links[i]!;
      keep *= chain.damageKeep;
      if (!t.alive) continue;
      _dir.subVectors(t.aimPoint, _rico);
      const len = _dir.length();
      if (len > 1e-6) _dir.multiplyScalar(1 / len);
      _rico.copy(t.aimPoint);
      this.dealBeam(def, t, def.damage.base * keep * this.damageScale, 'body', t.aimPoint, _dir, 0, true);
    }
  }

  /** Cone beam: everything inside the cone up to the wall ahead (line of sight each). */
  private coneTick(w: WeaponInstance, dir: Vector3): void {
    const def = w.def;
    const b = def.beam!;
    this.beamPrimary = null;
    this.beamChain.length = 0;
    // The wall ahead ends the stream (bodies do not: the flames roll around them).
    this.ignoreList.length = 0;
    const opts = this.rayOpts;
    opts.ignoreMany = this.ignoreList;
    opts.skipLastProp = false;
    let reach = b.range;
    for (let pass = 0; pass <= ARSENAL.beam.maxConeTargets; pass++) {
      const hit = this.combat.raycast(_eye, dir, b.range, opts);
      if (!hit) break;
      if (hit.target) {
        this.ignoreList.push(hit.target);
        continue;
      }
      reach = hit.distance;
      _hitPoint.copy(hit.point);
      _hitNormal.copy(hit.normal);
      const surface = hit.surface;
      this.beamImpact(_hitPoint, _hitNormal, surface, def.id, false);
      break;
    }
    this.ignoreList.length = 0;
    this.beamDistance = reach;
    const tanHalf = Math.tan(b.coneDeg * DEG2RAD);
    const list = this.combat.queryRadius(_eye, reach, this.coneCandidates);
    let hits = 0;
    for (let i = 0; i < list.length && hits < ARSENAL.beam.maxConeTargets; i++) {
      const t = list[i]!;
      if (!t.alive || t.team === 'player') continue;
      const along = coneReach(
        _eye,
        dir,
        tanHalf,
        reach,
        t.boundsCenter,
        t.boundsRadius,
        ARSENAL.beam.coneBoundsFactor,
      );
      if (along < 0) continue;
      if (!this.combat.lineOfSight(_eye, t.aimPoint) && !this.combat.lineOfSight(_eye, t.boundsCenter))
        continue;
      const amount = hitDamage(def.damage, 'body', along, 1, this.damageScale);
      _aim.subVectors(t.boundsCenter, _eye).normalize();
      this.dealBeam(def, t, amount, 'body', t.aimPoint, _aim, def.damage.impulse, true);
      hits++;
    }
    list.length = 0;
  }

  private dealBeam(
    def: WeaponDef,
    target: Damageable,
    amount: number,
    zone: DamageInfo['zone'],
    point: Vec3Like,
    dir: Vec3Like,
    impulse: number,
    primary: boolean,
  ): void {
    if (!(amount > 0) || !target.alive) return;
    const info = this.damageInfo;
    info.amount = amount;
    info.zone = zone;
    copyVec(point, info.point);
    copyVec(dir, info.direction);
    info.weaponId = def.id;
    info.element = def.damage.element;
    info.source = 'player';
    info.kind = 'beam';
    info.impulse = impulse;
    info.statusBuildup = statusBuildupFor(def.damage.element);
    // Copy the point first: the specials read it after dealDamage's handlers ran.
    _beamTo.set(point.x, point.y, point.z);
    const res = this.combat.dealDamage(target, info);
    const applied = res.applied;
    const killed = res.killed;
    this.stats.hits++;
    if (killed) this.stats.kills++;
    this.reportSpecial(def, 'tick', target, _beamTo, applied, killed, primary);
  }

  /** combat:impact of a beam tick, capped per tick (ARSENAL.beam.maxImpactsPerTick). */
  private beamImpact(
    point: Vec3Like,
    normal: Vec3Like,
    surface: SurfaceType | FleshSurface,
    weaponId: string,
    decal: boolean,
  ): void {
    if (this.beamImpacts >= ARSENAL.beam.maxImpactsPerTick) return;
    this.beamImpacts++;
    this.emitImpact(point, normal, surface, 'beam', weaponId, decal);
  }

  private stopBeam(): void {
    if (!this.beamActive) return;
    this.beamActive = false;
    this.beamPrimary = null;
    this.beamChain.length = 0;
    this.events.emit('weapon:beam', { weaponId: this.beamWeapon, active: false });
  }

  // -------------------------------------------------------------------------
  // Charge (M5)
  // -------------------------------------------------------------------------

  /** Charge kind: hold to charge, release (or auto-release) fires; below minCharge it fizzles. */
  private tickCharge(w: WeaponInstance, ready: boolean, firePressed: boolean, dt: number): void {
    const def = w.def;
    const c = def.charge!;
    this.chargeWeapon = def.id;
    if (this.chargeNeedsRelease && !this.fireHeld) this.chargeNeedsRelease = false;
    this.pressBuffer = 0;
    if (this.charging) {
      if (!ready || w.mag <= 0) {
        this.cancelCharge();
        return;
      }
      if (this.fireHeld) {
        this.chargeAmount = chargeStep(this.chargeAmount, dt, c.time);
        this._state = 'firing';
        if (this.chargeAmount >= 1) {
          this.chargeFullTime += dt;
          if (c.autoReleaseAfter > 0 && this.chargeFullTime >= c.autoReleaseAfter) {
            this.releaseCharge(w);
            this.chargeNeedsRelease = true;
            return;
          }
        }
        this.emitCharge(this.chargeAmount);
        return;
      }
      this.releaseCharge(w);
      return;
    }
    if (ready && this.fireHeld && !this.chargeNeedsRelease && this.fireCooldown <= 0) {
      if (w.mag > 0) {
        this.charging = true;
        this.chargeFullTime = 0;
        this.chargeAmount = chargeStep(0, dt, c.time);
        this._state = 'firing';
        this.emitCharge(this.chargeAmount);
        return;
      }
      if (firePressed && this.dryFireTimer <= 0) {
        this.dryFireTimer = WEAPON_RULES.dryFireInterval;
        this.events.emit('weapon:dryFire', { weaponId: def.id });
      }
    }
    if (this.fireCooldown < 0) this.fireCooldown = 0;
    if (this._state === 'firing' && this.fireCooldown <= 0) this._state = 'idle';
    this.autoReload(w);
  }

  /** Fire at the current charge (or fizzle below minCharge: no shot, no ammo). */
  private releaseCharge(w: WeaponInstance): void {
    const def = w.def;
    const factor = chargeDamageFactor(this.chargeAmount, def.charge!);
    this.charging = false;
    this.chargeAmount = 0;
    this.chargeFullTime = 0;
    if (factor > 0) {
      this.fireShot(w, factor);
      this.fireCooldown += 60 / def.rpm;
      w.readyAt = this.simTime + Math.max(0, this.fireCooldown);
      this._state = 'firing';
    }
    this.emitCharge(0);
  }

  private cancelCharge(): void {
    if (!this.charging && this.chargeAmount === 0) return;
    this.charging = false;
    this.chargeAmount = 0;
    this.chargeFullTime = 0;
    this.emitCharge(0);
  }

  private emitCharge(amount: number): void {
    const p = this.chargePayload;
    p.weaponId = this.chargeWeapon;
    p.amount = amount;
    this.events.emit('weapon:charge', p);
  }

  // -------------------------------------------------------------------------
  // Spin-up (M5)
  // -------------------------------------------------------------------------

  /** weapon:spin while the spin changes (every tick of a ramp, once when it settles). */
  private announceSpin(): void {
    if (this.spin === this.spinSent) return;
    this.spinSent = this.spin;
    const p = this.spinPayload;
    p.weaponId = this.spinWeapon;
    p.amount = this.spin;
    this.events.emit('weapon:spin', p);
  }

  private resetSpin(): void {
    this.spin = 0;
    this.announceSpin();
  }

  /** Stop beam, charge and spin of the weapon in hand (switch, loadout, dispose). */
  private endFireKinds(): void {
    this.stopBeam();
    this.cancelCharge();
    this.resetSpin();
  }

  // -------------------------------------------------------------------------
  // Fire-kind visuals (per frame, after the viewmodel and VFX)
  // -------------------------------------------------------------------------

  /**
   * Beam and charge visuals at this frame's muzzle socket (ArsenalVfxApi): the beam runs from the
   * muzzle as shown to the last tick's reach along this frame's aim, with its chain arcs.
   */
  updateVisuals(_dt: number): void {
    if (this.disposed) return;
    const vfx = this.arsenal.vfx;
    const w = this.current;
    const beam = w?.def.beam;
    if (this.beamActive && w && beam) {
      this.getMuzzleWorld(_beamFrom);
      const cam = this.render.camera;
      if (!Number.isFinite(_beamFrom.x) || !Number.isFinite(_beamFrom.y) || !Number.isFinite(_beamFrom.z)) {
        _beamFrom.copy(cam.position);
      }
      cam.getWorldDirection(_camFwd);
      _beamTo.copy(cam.position).addScaledVector(_camFwd, this.beamDistance);
      let arcs = 0;
      if (this.beamPrimary) {
        _rico.copy(_beamTo);
        for (let i = 0; i < this.beamChain.length && arcs < ARSENAL.specials.maxChain; i++) {
          const t = this.beamChain[i]!;
          this.beamArcs[arcs * 2]!.copy(_rico);
          this.beamArcs[arcs * 2 + 1]!.copy(t.aimPoint);
          _rico.copy(t.aimPoint);
          arcs++;
        }
      }
      vfx.beam(beam.visual, _beamFrom, _beamTo, this.beamArcs, arcs);
    }
    const charge = w?.def.charge;
    if (charge) {
      if (this.chargeAmount > 0) {
        vfx.charge(charge.visual, this.chargeAmount);
        this.chargeShown = true;
      } else if (this.chargeShown) {
        vfx.charge(charge.visual, 0);
        this.chargeShown = false;
      }
    } else if (this.chargeShown) {
      vfx.charge('', 0);
      this.chargeShown = false;
    }
  }

  private emitImpact(
    point: Vec3Like,
    normal: Vec3Like,
    surface: SurfaceType | FleshSurface,
    kind: ImpactKind,
    weaponId: string,
    decal: boolean,
  ): void {
    const e = this.impactPayload;
    copyVec(point, e.point);
    copyVec(normal, e.normal);
    e.surface = surface;
    e.kind = kind;
    e.weaponId = weaponId;
    e.decal = decal;
    this.events.emit('combat:impact', e);
  }

  private currentSpreadDeg(def: WeaponDef): number {
    const p = this.player;
    _spreadCtx.ads = this._adsAmount;
    _spreadCtx.speedFactor = p.horizontalSpeed / MOVEMENT.ground.runSpeed;
    _spreadCtx.airborne = !p.grounded;
    _spreadCtx.crouched = p.crouched;
    return spreadDeg(def.spread, _spreadCtx, this.bloom);
  }

  /** Aim pitch as rendered: the player's pitch plus the camera's movement pitch (landing dip, mantle). */
  private get aimPitch(): number {
    const offset = this.camera.aimPitchOffset;
    return this.player.pitch + (Number.isFinite(offset) ? offset : 0);
  }

  /** Shots start at the rendered camera (what the player sees); falls back to the player's eye. */
  private eyePosition(out: Vector3): Vector3 {
    const c = this.render.camera.position;
    if (Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z)) return out.copy(c);
    const p = this.player.position;
    return out.set(p.x, p.y + this.player.currentEyeHeight, p.z);
  }

  // -------------------------------------------------------------------------
  // Reload
  // -------------------------------------------------------------------------

  private tryReload(): boolean {
    const w = this.current;
    if (!w) return false;
    const s = this._state;
    if (s === 'reloading' || s === 'holstering' || s === 'equipping' || s === 'meleeing') return false;
    const empty = w.mag <= 0;
    if (w.mag >= capacity(w.def, empty) || w.reserve <= 0) return false;
    this.startReload(w, empty);
    return true;
  }

  private startReload(w: WeaponInstance, empty: boolean): void {
    const def = w.def;
    this.stopBeam();
    this.cancelCharge();
    const ps = def.reload.perShell;
    this.reloadEmpty = empty;
    this.reloadCommitted = false;
    this.reloadSprintOk = false;
    this.reloadMarker = 0;
    this.burstLeft = 0;
    let duration: number;
    if (ps) {
      const need = Math.min(capacity(def, empty) - w.mag, w.reserve);
      duration = ps.start + need * ps.shell + (empty ? ps.emptyEnd : ps.end);
      this.shellPhase = 'start';
      this.shellTimer = 0;
      this.shellInserted = false;
      this.pumpDone = false;
      this.shellInterrupted = false;
      this.shellEndDuration = empty ? ps.emptyEnd : ps.end;
      this.reloadMarkers = NO_MARKERS;
    } else {
      duration = empty ? def.reload.empty : def.reload.tactical;
      this.reloadMarkers = empty ? def.reload.emptySteps : def.reload.tacticalSteps;
    }
    this.setState('reloading', duration);
    this.events.emit('weapon:reloadStart', { weaponId: def.id, empty, duration });
  }

  private tickMagReload(w: WeaponInstance, firePressed: boolean): void {
    const def = w.def;
    // Fire interrupts a tactical reload while the magazine is still seated.
    if ((firePressed || this.pressBuffer > 0) && !this.reloadEmpty && w.mag > 0 && !this.reloadCommitted) {
      const magOut = markerTime(this.reloadMarkers, 'magOut');
      if (magOut < 0 || this.stateTime < magOut) {
        this.finishReload(false);
        return;
      }
    }
    const markers = this.reloadMarkers;
    while (this.reloadMarker < markers.length && markers[this.reloadMarker]!.at <= this.stateTime) {
      const m = markers[this.reloadMarker++]!;
      if (m.step === 'magIn') this.commitReload(w);
      this.events.emit('weapon:reloadStep', { weaponId: def.id, step: m.step });
    }
    if (this.stateTime >= this.stateDuration) {
      if (!this.reloadCommitted) this.commitReload(w);
      this.finishReload(true);
    }
  }

  private commitReload(w: WeaponInstance): void {
    if (this.reloadCommitted) return;
    this.reloadCommitted = true;
    const take = Math.max(0, Math.min(capacity(w.def, this.reloadEmpty) - w.mag, w.reserve));
    w.mag += take;
    w.shotCount = 0;
    if (!this.infiniteAmmo) w.reserve -= take;
    this.emitAmmo();
  }

  private tickShellReload(w: WeaponInstance, firePressed: boolean, dt: number): void {
    const def = w.def;
    const ps = def.reload.perShell!;
    const cap = capacity(def, this.reloadEmpty);
    // Fire interrupts between shells once there is something to shoot; a press during the
    // closing motion fires as soon as it is done.
    const fireWanted = (firePressed || this.pressBuffer > 0) && w.mag > 0;
    if (fireWanted) this.fireQueued = true;
    if (fireWanted && this.shellPhase !== 'end') {
      this.shellInterrupted = true;
      this.shellPhase = 'end';
      this.shellTimer = 0;
      // A shell not yet in the tube is dropped; a reload that started empty still pumps.
      this.shellEndDuration = this.reloadEmpty ? ps.emptyEnd : ps.end;
      this.stateTime = 0;
      this.stateDuration = this.shellEndDuration;
    }
    this.shellTimer += dt;
    // Several phase changes may fall into one tick.
    for (let guard = 0; guard < 4; guard++) {
      if (this.shellPhase === 'start') {
        if (this.shellTimer < ps.start) return;
        this.shellTimer -= ps.start;
        this.shellPhase = 'insert';
        this.shellInserted = false;
      } else if (this.shellPhase === 'insert') {
        if (!this.shellInserted && this.shellTimer >= ps.insertAt) {
          this.shellInserted = true;
          if (w.reserve > 0 && w.mag < cap) {
            if (!this.reloadCommitted) w.shotCount = 0;
            w.mag++;
            if (!this.infiniteAmmo) w.reserve--;
            this.reloadCommitted = true;
            this.events.emit('weapon:reloadStep', { weaponId: def.id, step: 'shellIn' });
            this.emitAmmo();
          }
        }
        if (this.shellTimer < ps.shell) return;
        this.shellTimer -= ps.shell;
        this.shellInserted = false;
        if (w.mag >= cap || w.reserve <= 0) this.shellPhase = 'end';
      } else {
        if (this.reloadEmpty && !this.pumpDone && this.shellTimer >= ps.pumpAt) {
          this.pumpDone = true;
          this.events.emit('weapon:reloadStep', { weaponId: def.id, step: 'pump' });
        }
        if (this.shellTimer < this.shellEndDuration) return;
        this.finishReload(!this.shellInterrupted);
        return;
      }
    }
  }

  private finishReload(completed: boolean): void {
    const w = this.current;
    this.setState('idle', 0);
    this.reloadMarkers = NO_MARKERS;
    this.reloadSprintOk = false;
    if (w) this.events.emit('weapon:reloadEnd', { weaponId: w.def.id, completed });
  }

  // -------------------------------------------------------------------------
  // Melee / inspect
  // -------------------------------------------------------------------------

  private tryMelee(): void {
    const w = this.current;
    if (!w || this.meleeCooldown > 0) return;
    const s = this._state;
    if (s === 'holstering' || s === 'equipping' || s === 'meleeing') return;
    if (s === 'reloading') this.finishReload(false);
    this.stopBeam();
    this.cancelCharge();
    const m = w.def.melee;
    this.burstLeft = 0;
    this.fireQueued = false;
    this.setState('meleeing', m.duration);
    this.meleeHitDone = false;
    this.meleeTarget = this.findMeleeTarget(w.def);
    this.events.emit('weapon:melee', {
      weaponId: w.def.id,
      duration: m.duration,
      hit: this.meleeTarget !== null,
    });
  }

  /**
   * Best live target in the melee cone within reach (nearest, then most centered). Reach is
   * measured to the body surface along the line to its aim point, and that line must be clear;
   * the bounds sphere only gathers candidates (big enemies must not extend the reach).
   */
  private findMeleeTarget(def: WeaponDef): Damageable | null {
    const m = def.melee;
    this.eyePosition(_eye);
    aimBasis(this.player.yaw, this.aimPitch, _fwd, _right, _up);
    const cosCone = Math.cos(m.coneDeg * DEG2RAD);
    const list = this.combat.queryRadius(_eye, m.range, this.meleeCandidates);
    let best: Damageable | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      if (t.team === 'player') continue;
      _dir.copy(t.aimPoint).sub(_eye);
      const dist = _dir.length();
      if (!(dist > 1e-6)) continue;
      _dir.multiplyScalar(1 / dist);
      const cos = _dir.dot(_fwd);
      if (cos < cosCone) continue;
      const score = dist * (2 - cos);
      if (score >= bestScore) continue;
      const hit = this.combat.raycast(_eye, _dir, m.range);
      if (!hit || hit.target !== t) continue;
      best = t;
      bestScore = score;
    }
    list.length = 0;
    return best;
  }

  /**
   * The melee ray from the eye towards `target`'s aim point, if its first hit within `range` is
   * that target (leaves the direction in _dir). The result is CombatWorld's shared hit.
   */
  private meleeReach(target: Damageable, range: number): CombatHit | null {
    if (!target.alive) return null;
    this.eyePosition(_eye);
    _dir.copy(target.aimPoint).sub(_eye);
    const dist = _dir.length();
    if (!(dist > 1e-6)) return null;
    _dir.multiplyScalar(1 / dist);
    const hit = this.combat.raycast(_eye, _dir, range);
    return hit && hit.target === target ? hit : null;
  }

  private tickMelee(w: WeaponInstance): void {
    const m = w.def.melee;
    if (!this.meleeHitDone && this.stateTime >= m.hitTime) {
      this.meleeHitDone = true;
      this.resolveMeleeHit(w.def);
    }
    if (this.stateTime >= this.stateDuration) {
      this.meleeCooldown = m.cooldown;
      this.meleeTarget = null;
      if (this.pendingSlot >= 0 && this.pendingSlot !== this.currentSlot) {
        const slot = this.pendingSlot;
        this.setState('idle', 0);
        this.requestSwitch(slot);
      } else {
        this.pendingSlot = -1;
        this.setState('idle', 0);
      }
    }
  }

  private resolveMeleeHit(def: WeaponDef): void {
    const m = def.melee;
    let target = this.meleeTarget;
    let hit = target ? this.meleeReach(target, m.range) : null;
    if (!hit) {
      // The locked target left the reach or died during the windup (or there was none): the
      // blow lands on whatever is in the cone now.
      target = this.findMeleeTarget(def);
      hit = target ? this.meleeReach(target, m.range) : null;
    }
    this.meleeTarget = hit ? target : null;
    if (hit && target) {
      this.meleeStrike(def, target, hit, _dir);
      return;
    }
    // Nothing in the cone: bash whatever is straight ahead (a body whose aim point is outside the
    // cone, or sound/impact feedback and a push for the world and props).
    this.eyePosition(_eye);
    aimBasis(this.player.yaw, this.aimPitch, _fwd, _right, _up);
    const front = this.combat.raycast(_eye, _fwd, m.range);
    if (!front) return;
    const body = front.target;
    if (body) {
      if (body.alive && body.team !== 'player') this.meleeStrike(def, body, front, _fwd);
      return;
    }
    this.combat.pushProp(front, _fwd, m.propImpulse);
    this.emitImpact(front.point, front.normal, front.surface, 'melee', def.id, false);
    this.shakePayload.trauma = m.shake * WEAPON_RULES.meleeWorldShakeScale;
    this.events.emit('camera:shake', this.shakePayload);
  }

  /** The blow connects with `target` at `hit` (CombatWorld's shared hit: read before emitting). */
  private meleeStrike(def: WeaponDef, target: Damageable, hit: CombatHit, dir: Vec3Like): void {
    const m = def.melee;
    const info = this.damageInfo;
    info.amount = m.damage * this.statFactors.melee;
    info.zone = hit.zone ?? 'body';
    copyVec(hit.point, info.point);
    copyVec(dir, info.direction);
    info.weaponId = def.id;
    info.element = 'physical';
    info.source = 'player';
    info.kind = 'melee';
    info.impulse = m.impulse;
    this.emitImpact(hit.point, hit.normal, hit.surface, 'melee', def.id, false);
    const res = this.combat.dealDamage(target, info);
    this.stats.hits++;
    if (res.killed) this.stats.kills++;
    this.shakePayload.trauma = m.shake;
    this.events.emit('camera:shake', this.shakePayload);
  }

  private tryInspect(): void {
    const w = this.current;
    if (!w || this._state !== 'idle' || this.adsHeld || this.fireHeld || this.player.sprinting) return;
    this.setState('inspecting', w.def.inspectTime);
    this.events.emit('weapon:inspect', { weaponId: w.def.id, duration: w.def.inspectTime });
  }

  // -------------------------------------------------------------------------
  // ADS / aim assist
  // -------------------------------------------------------------------------

  private updateAds(dt: number): void {
    const w = this.current;
    const intent = this.adsHeld && w !== null && !this.stowed && ADS_STATES.has(this._state);
    const aiming = intent && !this.player.sprinting && this.sprintRecovery <= 0;
    if (w) {
      const a = w.def.ads;
      const step = dt * this.statFactors.adsSpeed;
      if (aiming) this.adsProgress = a.inTime > 0 ? Math.min(1, this.adsProgress + step / a.inTime) : 1;
      else this.adsProgress = a.outTime > 0 ? Math.max(0, this.adsProgress - step / a.outTime) : 0;
    } else {
      this.adsProgress = 0;
    }
    const t = this.adsProgress;
    this._adsAmount = t * t * (3 - 2 * t);
    if (aiming !== this.aiming) {
      this.aiming = aiming;
      this.events.emit('weapon:adsChanged', { aiming, weaponId: w?.def.id ?? '' });
    }
  }

  private aimAssist(look: LookOut): void {
    const rules = GAMEPAD.aimAssist;
    const targets = this.combat.targets;
    this.eyePosition(_eye);
    const yaw = this.player.yaw;
    const pitch = this.aimPitch;
    let best: Damageable | null = null;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      if (!t.alive || t.team !== 'enemy') continue;
      if (!aimError(_eye, yaw, pitch, t.aimPoint, _err) || !inAssistWindow(_err, rules)) continue;
      if (best && _err.angle >= _bestErr.angle) continue;
      best = t;
      _bestErr.yaw = _err.yaw;
      _bestErr.pitch = _err.pitch;
      _bestErr.angle = _err.angle;
      _bestErr.distance = _err.distance;
    }
    // One line-of-sight ray per frame, for the chosen target only.
    if (best && this.combat.lineOfSight(_eye, best.aimPoint)) applyAimAssist(look, _bestErr, rules);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private emitAmmo(): void {
    const w = this.current;
    if (!w) return;
    const p = this.ammoPayload;
    p.weaponId = w.def.id;
    p.mag = w.mag;
    p.reserve = w.reserve;
    p.magSize = w.def.magazine;
    this.events.emit('weapon:ammoChanged', p);
  }

  private emitInventory(): void {
    this.events.emit('weapon:inventoryChanged', { slots: this.slotIds, current: this.currentSlot });
  }
}

/** Full magazine of a fresh weapon (closed bolt: +1 chambered). */
function fullMag(def: WeaponDef): number {
  return def.magazine + (def.chambered ? 1 : 0);
}

/** Rounds a reload fills up to: a round left in the chamber of a closed bolt adds one. */
function capacity(def: WeaponDef, empty: boolean): number {
  return def.magazine + (def.chambered && !empty ? 1 : 0);
}

/** The def carries the data its kind needs (projectile / beam / charge). */
function hasKindData(def: WeaponDef): boolean {
  switch (def.kind) {
    case 'hitscan':
      return true;
    case 'projectile':
      return !!def.projectile;
    case 'beam':
      return !!def.beam && def.beam.tickRate > 0;
    case 'charge':
      return !!def.charge;
  }
}

/**
 * Known attachments of `ids` that fit `def`, one per slot (a later id replaces an earlier one of
 * its slot), in slot order of first appearance.
 */
function validAttachments(def: WeaponDef, ids: readonly string[]): readonly string[] {
  const bySlot = new Map<AttachmentSlot, string>();
  for (const id of ids) {
    const att = getAttachmentDef(id);
    if (!att || !isAttachmentCompatible(att, def)) {
      log.warn(`Attachment "${id}" does not fit ${def.id} – ignored`);
      continue;
    }
    bySlot.set(att.slot, att.id);
  }
  return [...bySlot.values()];
}

function markerTime(markers: readonly ReloadMarker[], step: ReloadMarker['step']): number {
  for (const m of markers) if (m.step === step) return m.at;
  return -1;
}

function copyVec(from: Vec3Like, to: Vec3Like): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}
