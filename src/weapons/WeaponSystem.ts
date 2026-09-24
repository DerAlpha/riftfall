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
 */
import { Vector3 } from 'three';
import type {
  CombatHit,
  DamageInfo,
  Damageable,
  InputApi,
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
import { COMBAT } from '../defs/combat';
import { MOVEMENT } from '../defs/movement';
import {
  IMPLEMENTED_WEAPON_KINDS,
  WEAPON_RULES,
  getWeaponDef,
  type ReloadMarker,
  type WeaponDef,
  type WeaponStatMods,
} from '../defs/weapons';
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
  /** Reserved for projectile weapons (M5). */
  physics?: PhysicsApi | null;
  /** World-space muzzle of the current viewmodel (tracer/flash origin). */
  getMuzzleWorld: (out: Vector3) => Vector3;
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
  };
  private readonly ammoOut = { mag: 0, reserve: 0, magSize: 0 };

  // --- reused hot-path payloads ---
  private readonly firedPayload: GameEvents['weapon:fired'] = {
    weaponId: '',
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    muzzle: { x: 0, y: 0, z: 0 },
    shotIndex: 0,
    ammoInMag: 0,
    ads: false,
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

  // --- AdsProvider (PlayerController) ---
  get adsMoveSpeedMultiplier(): number {
    return this.current?.def.ads.moveSpeedMultiplier ?? MOVEMENT.ground.adsSpeedMultiplier;
  }
  get blocksSprint(): boolean {
    const w = this.current;
    if (!w || this.disposed) return false;
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
    const n = this.slotTotal();
    if (this._state === 'reloading') this.finishReload(false);
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
   * Rift Forge tier / attachment mods / elemental mod of a carried weapon (M5 entry point); the
   * previous mod state is replaced. A running reload of it is cancelled (its timing changed); the
   * magazine is clamped to the new capacity. False if the weapon is not carried.
   */
  setWeaponMods(weaponId: string, mods: WeaponModState): boolean {
    this.syncStats();
    const slot = this.slots.findIndex((s) => s?.def.id === weaponId);
    const w = slot >= 0 ? this.slots[slot] : null;
    if (!w) return false;
    if (slot === this.currentSlot && this._state === 'reloading') this.finishReload(false);
    w.mods = mods;
    w.def = this.resolveDef(w.base, mods);
    w.mag = Math.min(w.mag, fullMag(w.def));
    w.reserve = Math.min(w.reserve, w.def.reserve);
    if (slot === this.currentSlot) this.emitAmmo();
    return true;
  }

  /** Gameplay stats (perks, cards; see the file header). null = def values. */
  /** M4: a reload press is ignored while `suppress()` is true (pad X buying at an interactable). */
  setReloadSuppressor(suppress: (() => boolean) | null): void {
    this.reloadSuppressed = suppress ?? (() => false);
  }

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
    if (current) this.tickFire(current, firePressed);

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
    // Never fire an unimplemented kind as hitscan (a launcher def would become an instant rifle).
    if (!IMPLEMENTED_WEAPON_KINDS.includes(def.kind)) {
      log.warn(`Weapon "${id}": kind '${def.kind}' is not implemented – ignored`);
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
    };
  }

  /** Base def + tier/attachment mods + the current stat mods. */
  private resolveDef(base: WeaponDef, mods: WeaponModState): WeaponDef {
    const sm = this.statMods;
    if (!sm) return resolveWeapon(base, mods);
    return resolveWeapon(base, {
      tier: mods.tier,
      element: mods.element,
      mods: mods.mods ? [...mods.mods, sm] : [sm],
    });
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
   * A stat change re-resolved `w`: rounds above a smaller magazine go back to the reserve (a
   * running reload keeps its timing), the reserve is capped by its new maximum.
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

  private tickFire(w: WeaponInstance, firePressed: boolean): void {
    const def = w.def;
    const state = this._state;
    const ready =
      (state === 'idle' || state === 'firing') && this.sprintRecovery <= 0 && !this.player.sprinting;
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
      if (def.fireMode === 'burst' && this.burstLeft <= 0) this.burstLeft = def.burst?.count ?? 1;
      this.fireShot(w);
      shots++;
      let interval = 60 / def.rpm;
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

    // Empty magazine: reload once the last shot's cycle finished.
    if (
      w.mag <= 0 &&
      w.reserve > 0 &&
      WEAPON_RULES.autoReloadOnEmpty &&
      this.fireCooldown <= 0 &&
      (this._state === 'idle' || this._state === 'firing')
    ) {
      this.tryReload();
    }
  }

  private fireShot(w: WeaponInstance): void {
    const def = w.def;
    const player = this.player;
    if (!this.infiniteAmmo) w.mag--;
    this.stats.shots++;
    this.eyePosition(_eye);
    aimBasis(player.yaw, this.aimPitch, _fwd, _right, _up);
    const spreadRad = this.currentSpreadDeg(def) * DEG2RAD;
    this.getMuzzleWorld(_muzzle);
    if (!Number.isFinite(_muzzle.x) || !Number.isFinite(_muzzle.y) || !Number.isFinite(_muzzle.z)) {
      _muzzle.copy(_eye);
    }

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
    this.events.emit('weapon:fired', fired);

    // --- bullets / pellets ---
    // Every Nth shot of a burst traces, starting with the first (a tap always shows one).
    if (shotIndex === 0) w.tracerCounter = 0;
    const tracerShot = def.tracer.everyNth > 0 && w.tracerCounter % def.tracer.everyNth === 0;
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
    this.stats.pellets += pellets;
    this.flushDamage(def, kind);

    // --- feel: bloom, recoil, punch, shake, rumble ---
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

  /** One bullet/pellet: nearest hit, penetration through thin surfaces/bodies while budget remains. */
  private traceBullet(
    w: WeaponInstance,
    origin: Vector3,
    dir: Vector3,
    kind: ImpactKind,
    tracer: boolean,
  ): void {
    const def = w.def;
    const combat = this.combat;
    let power = def.penetration.power;
    let keep = 1;
    let traveled = 0;
    let skipProp = false;
    _from.copy(origin);
    _end.copy(origin).addScaledVector(dir, def.range);
    this.ignoreList.length = 0;
    const opts = this.rayOpts;
    opts.ignoreMany = this.ignoreList;
    for (let pen = 0; pen <= COMBAT.maxPenetrations; pen++) {
      const remaining = def.range - traveled;
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
            distance,
            keep,
            this.damageScale * precisionScale(zone, this.statFactors.headshot),
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
        combat.pushProp(hit, dir, def.damage.propImpulse * keep);
        this.emitImpact(hit.point, hit.normal, surface, kind, def.id, decal);
        if (!penetrable) break;
        cost = COMBAT.penetrationCost[surface];
        skipProp = true;
      }
      if (!(power >= cost)) break;
      power -= cost;
      keep *= def.penetration.damageKeep;
      _from.copy(_end).addScaledVector(dir, COMBAT.penetrationStep);
      traveled = distance + COMBAT.penetrationStep;
    }
    this.ignoreList.length = 0;
    if (tracer) {
      const t = this.tracerPayload;
      copyVec(_muzzle, t.from);
      copyVec(_end, t.to);
      t.weaponId = def.id;
      this.events.emit('combat:tracer', t);
    }
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
      const res = this.combat.dealDamage(target, info);
      if (firstGroup) this.stats.hits++;
      if (res.killed) this.stats.kills++;
    }
    acc.reset();
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
    const intent = this.adsHeld && w !== null && ADS_STATES.has(this._state);
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

function markerTime(markers: readonly ReloadMarker[], step: ReloadMarker['step']): number {
  for (const m of markers) if (m.step === step) return m.at;
  return -1;
}

function copyVec(from: Vec3Like, to: Vec3Like): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}
