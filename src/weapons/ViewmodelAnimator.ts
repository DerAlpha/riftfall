/**
 * Procedural first-person weapon animation. Listens to weapon:* events and drives the shown
 * weapon model: per-shot kick springs, slide/bolt/pump cycling, tactical/empty reload
 * choreography (pose keys over the reload duration + part motions on the reload markers),
 * equip raise / holster lower, inspect, melee bash, dry-fire twitch, sustained-fire drift,
 * heat glow and a slow idle drift. M5: state drivers (barrels spinning with weapon:spin, rails
 * spreading with weapon:charge, emitters opening while weapon:beam fires, vents with heat) and
 * off-hand gestures (grenade:thrown, ability:used). Everything is springs and curves – no
 * keyframe assets – and frame-rate independent (springs are sub-stepped, curves are time based).
 *
 * Output: `pose` – an additive offset the ViewmodelRig applies on top of its hip/ADS, sway,
 * bob and landing layers (position in viewmodel-camera space, rotation around the weapon's
 * pivot). The rig owns model instances; the animator asks it to swap models via `showModel`
 * at the right moment of an equip (after the holster lowered the previous weapon).
 *
 * Sync with gameplay/audio: authored reload and melee tracks are time-warped onto the weapon's
 * real markers (defs/weapons), and part motions with a `lead` are scheduled ahead of their
 * marker so they land on the marker's sound (magazine seating, shell click).
 *
 * Data-driven: all per-weapon behaviour comes from defs/viewmodels.ts (+ defs/weapons.ts for
 * timing and kick peaks). No code path depends on a weapon id.
 */
import { Euler, Quaternion, Vector3, type Object3D } from 'three';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { DEG2RAD, clamp01, damp, lerp } from '../core/math';
import { CAMERA } from '../defs/camera';
import {
  VIEWMODEL_ANIM,
  getViewmodelDef,
  type DelayedImpulseDef,
  type PartMotionDef,
  type PoseDef,
  type PoseKeyDef,
  type ViewmodelDriverDef,
  type WeaponViewmodelDef,
} from '../defs/viewmodels';
import { getWeaponDef, type ReloadStep, type WeaponDef } from '../defs/weapons';
import { springImpulseForPeak } from '../player/cameraMath';
import {
  addPoseImpulse,
  createPose,
  createPoseSpring,
  createTimeWarp,
  ease,
  poseAddDef,
  poseCopy,
  poseAddScaled,
  poseFromDef,
  poseZero,
  resetPoseSpring,
  samplePoseTrack,
  stepPoseSpring,
  timeWarpAdd,
  timeWarpApply,
  timeWarpReset,
  type Pose,
} from './viewmodels/animMath';
import {
  createPartMotionState,
  partOffset,
  resetPartMotion,
  startPartMotion,
  stepPartMotion,
  type PartMotionState,
} from './viewmodels/partMotion';
import type { ViewmodelFxState, WeaponViewmodelModel } from './viewmodels/WeaponModel';

const A = VIEWMODEL_ANIM;
const MAX_IMPULSES = 16;
/** Lead-scheduled part motions waiting for their start time (a reload never needs more). */
const MAX_PENDING = 8;
const MIN_DURATION = 1e-3;
/** Below this weight a cancelled track counts as gone. */
const WEIGHT_EPSILON = 1e-3;

/** One bit per reload step (which steps' lead motions already started this reload). */
const STEP_BIT: Readonly<Record<ReloadStep, number>> = {
  magOut: 1,
  magIn: 2,
  boltRelease: 4,
  shellIn: 8,
  pump: 16,
};

const TAU = Math.PI * 2;
const AXES = { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) } as const;

const _v = new Vector3();
const _q = new Quaternion();
const _qs = new Quaternion();
const _e = new Euler();
const _offset = createPose();
const _track = createPose();
const _bash = createPose();
const _gesture = createPose();

interface PartBinding {
  readonly name: string;
  readonly obj: Object3D;
  readonly restPos: Vector3;
  readonly restQuat: Quaternion;
  readonly state: PartMotionState;
  /** State drivers moving this part (M5). */
  readonly drivers: DriverBinding[];
}

/** Runtime state of one WeaponViewmodelDef.drivers entry. */
interface DriverBinding {
  readonly def: ViewmodelDriverDef;
  /** `def.pose` in radians, scaled by `value` onto the part's offset. */
  readonly pose: Pose;
  readonly axis: Vector3 | null;
  /** Spin rate at source 1 (rad/s). */
  readonly rate: number;
  /** Eased source value 0..1. */
  value: number;
  /** Accumulated spin (rad, wrapped). */
  angle: number;
}

/** An off-hand gesture track (grenade throw, ability) and the pose it restarted from. */
interface GestureState {
  active: boolean;
  t: number;
  readonly from: Pose;
}

interface GestureDef {
  readonly duration: number;
  readonly keys: readonly PoseKeyDef[];
}

interface ScheduledImpulse {
  active: boolean;
  delay: number;
  readonly pose: Pose;
}

/** A reload part motion scheduled `lead` seconds ahead of its marker (reload clock). */
interface PendingMotion {
  def: PartMotionDef | null;
  step: ReloadStep;
  at: number;
}

interface AmmoState {
  mag: number;
  reserve: number;
  magSize: number;
}

/** Runtime settle motions (reload end / cancel): back to rest, re-showing or re-hiding the part. */
const SETTLE_SHOW: PartMotionDef = {
  part: '',
  type: 'tween',
  pose: {},
  duration: A.partSettleTime,
  ease: 'inOut',
  show: true,
};
const SETTLE_HIDE: PartMotionDef = { ...SETTLE_SHOW, show: false, hideAtEnd: true };

export interface ViewmodelAnimatorDeps {
  events: EventBus<GameEvents>;
  /**
   * Show the model for `weaponId` (null = no weapon) and return it (null when the rig shows the
   * placeholder). Called when an equip swaps models.
   */
  showModel(weaponId: string | null): WeaponViewmodelModel | null;
  /**
   * Weapon def lookup (timing, kick peaks). Default: the static table; pass the weapon system's
   * effective defs (WeaponSystem.effectiveDef) once weapons carry upgrades/attachments.
   */
  defs?: (weaponId: string) => WeaponDef | null | undefined;
  /** Initial accessibility "reduce flashing" (live changes arrive via settings:changed). */
  reduceFlashing?: boolean;
}

export class ViewmodelAnimator {
  /** Additive pose for the rig: px/py/pz in camera space (m), rx/ry/rz around the pivot (rad). */
  readonly pose: Pose = createPose();
  /** 0..1 muzzle flash light envelope this frame (the rig drives its viewmodel flash light from it). */
  muzzleFlash = 0;

  private readonly events: EventBus<GameEvents>;
  private readonly showModelFn: (id: string | null) => WeaponViewmodelModel | null;
  private readonly lookupDef: (id: string) => WeaponDef | null | undefined;
  private readonly unsubscribers: (() => void)[] = [];
  /** Reduce-flashing multiplier for the per-shot accent flash and the muzzle light envelope. */
  private flashScale = 1;

  /** Weapon whose events drive the animation (the one being equipped / shown). */
  private weaponId: string | null = null;
  private model: WeaponViewmodelModel | null = null;
  private vdef: WeaponViewmodelDef | null = null;
  private wdef: WeaponDef | undefined = undefined;
  private readonly parts: PartBinding[] = [];
  private readonly partByName = new Map<string, PartBinding>();
  /** Parts a reload end / ammo refill may send home: lock parts + parts moved by reload steps. */
  private readonly settleNames = new Set<string>();
  private readonly ammo = new Map<string, AmmoState>();

  // Springs
  private readonly kick = createPoseSpring();
  private readonly kickOut = createPose();
  private readonly follow = createPoseSpring();
  private readonly followOut = createPose();
  private readonly followTarget = createPose();
  private posImpulse = 0;
  private rotImpulse = 0;
  private readonly impulses: ScheduledImpulse[] = [];
  private readonly _peak = createPose();

  // Accumulators (flash levels are sampled before they decay: the shot frame shows the peak)
  private sustained = 0;
  private heat = 0;
  private accentFlash = 0;
  private lightFlash = 0;
  private time = 0;
  private ads = 0;
  private readonly fx: ViewmodelFxState = { time: 0, heat: 0, flash: 0, flicker: 1 };

  // Equip / holster
  private lower = 0;
  private equipFrom = 0;
  private equipTo = 0;
  private equipT = 0;
  private equipDur = 0;
  private equipActive = false;
  /** Weapon to show when the running holster completes (undefined = no swap pending). */
  private holsterNext: string | null | undefined = undefined;
  private pendingRaise = 0;
  /** Holster pose of the bound weapon. */
  private readonly lowered = poseFromDef(createPose(), A.equip.lowered);

  // Reload
  private reloadActive = false;
  private reloadEmpty = false;
  private reloadT = 0;
  private reloadDur = 1;
  private reloadEnded = false;
  private reloadWeight = 0;
  private reloadOutroAt = -1;
  private reloadOutroTime = 0;
  /** Reload clock of the last reload step / ammo event (stuck-loop safety). */
  private reloadLastEventT = 0;
  private readonly reloadWarp = createTimeWarp();
  private readonly pending: PendingMotion[] = [];
  /** STEP_BIT mask: steps whose lead motions already started (the marker must not rerun them). */
  private leadStarted = 0;

  // Inspect / melee
  private inspectActive = false;
  private inspectT = 0;
  private inspectDur = 1;
  private inspectWeight = 0;
  private inspectCancelled = false;
  private meleeActive = false;
  private meleeT = 0;
  private meleeDur = 1;
  private readonly meleeWarp = createTimeWarp(1);

  // State drivers (M5): source values of the bound weapon, 0..1
  private readonly drivers: DriverBinding[] = [];
  private spinSource = 0;
  private chargeSource = 0;
  private beamSource = 0;
  private accentBoost = 0;

  // Off-hand gestures (M5)
  private readonly throwGesture: GestureState = { active: false, t: 0, from: createPose() };
  private readonly abilityGesture: GestureState = { active: false, t: 0, from: createPose() };

  constructor(deps: ViewmodelAnimatorDeps) {
    this.events = deps.events;
    this.showModelFn = deps.showModel;
    this.lookupDef = deps.defs ?? getWeaponDef;
    this.setReduceFlashing(deps.reduceFlashing ?? false);
    for (let i = 0; i < MAX_IMPULSES; i++)
      this.impulses.push({ active: false, delay: 0, pose: createPose() });
    for (let i = 0; i < MAX_PENDING; i++) this.pending.push({ def: null, step: 'magIn', at: 0 });
    const ev = this.events;
    this.unsubscribers.push(
      ev.on('weapon:holsterStart', (e) => this.onHolsterStart(e.weaponId, e.duration, e.next)),
      ev.on('weapon:equipStart', (e) => this.onEquipStart(e.weaponId, e.duration, e.previous)),
      ev.on('weapon:equipped', (e) => this.onEquipped(e.weaponId)),
      ev.on('weapon:fired', (e) => this.onFired(e.weaponId, e.ammoInMag)),
      ev.on('weapon:dryFire', (e) => this.onDryFire(e.weaponId)),
      ev.on('weapon:reloadStart', (e) => this.onReloadStart(e.weaponId, e.empty, e.duration)),
      ev.on('weapon:reloadStep', (e) => this.onReloadStep(e.weaponId, e.step)),
      ev.on('weapon:reloadEnd', (e) => this.onReloadEnd(e.weaponId, e.completed)),
      ev.on('weapon:ammoChanged', (e) => this.onAmmo(e.weaponId, e.mag, e.reserve, e.magSize)),
      ev.on('weapon:adsChanged', (e) => this.onAds(e.weaponId, e.aiming)),
      ev.on('weapon:inspect', (e) => this.onInspect(e.weaponId, e.duration)),
      ev.on('weapon:inspectEnd', (e) => {
        if (e.cancelled && e.weaponId === this.weaponId) this.cancelInspect();
      }),
      ev.on('weapon:melee', (e) => this.onMelee(e.weaponId, e.duration, e.hit)),
      ev.on('weapon:spin', (e) => {
        if (e.weaponId === this.weaponId) this.spinSource = clamp01(e.amount);
      }),
      ev.on('weapon:charge', (e) => {
        if (e.weaponId === this.weaponId) this.chargeSource = clamp01(e.amount);
      }),
      ev.on('weapon:beam', (e) => {
        if (e.weaponId === this.weaponId) this.beamSource = e.active ? 1 : 0;
      }),
      ev.on('grenade:thrown', () => this.onGrenadeThrown()),
      ev.on('ability:used', () => this.onAbilityUsed()),
      ev.on('settings:changed', ({ settings, sections }) => {
        if (sections.includes('accessibility')) this.setReduceFlashing(settings.accessibility.reduceFlashing);
      }),
    );
  }

  /** accessibility.reduceFlashing: tones down the per-shot flash and muzzle light, stops the heat shimmer. */
  setReduceFlashing(on: boolean): void {
    this.flashScale = on ? A.reducedFlashScale : 1;
    this.fx.flicker = on ? 0 : 1;
  }

  get currentWeaponId(): string | null {
    return this.weaponId;
  }

  get currentModel(): WeaponViewmodelModel | null {
    return this.model;
  }

  /** Current 0..1 heat (debug / HUD). */
  get heatLevel(): number {
    return this.heat;
  }

  /** 0..1 how far the weapon is lowered by a holster/raise (0 = up). */
  get lowering(): number {
    return this.lower;
  }

  /** Extra accent intensity the state drivers add this frame (debug / tests). */
  get driverAccentBoost(): number {
    return this.accentBoost;
  }

  /**
   * Show a weapon immediately without an equip animation (the rig's showWeapon / dev tools).
   * Resets every running animation.
   */
  snapTo(weaponId: string | null): void {
    this.holsterNext = undefined;
    this.equipActive = false;
    this.lower = 0;
    this.swapModel(weaponId);
  }

  /**
   * Blend a running inspect out (weapon:inspectEnd; the rig also calls it when sprinting or
   * mantling lowers the weapon).
   */
  cancelInspect(): void {
    if (this.inspectActive) this.inspectCancelled = true;
  }

  /** Bind a model instance (null = placeholder / no weapon). Restores the previous model's parts. */
  bindModel(weaponId: string | null, model: WeaponViewmodelModel | null): void {
    this.unbindParts();
    this.weaponId = weaponId;
    this.model = model;
    this.vdef = model ? model.def : weaponId ? (getViewmodelDef(weaponId) ?? null) : null;
    this.wdef = weaponId ? (this.lookupDef(weaponId) ?? undefined) : undefined;
    this.resetMotion();
    poseFromDef(this.lowered, this.vdef?.lowered ?? A.equip.lowered);
    const k = this.vdef ? this.vdef.kickSpring : A.poseFollow;
    this.posImpulse = springImpulseForPeak(1, k.posStiffness, k.posDamping);
    this.rotImpulse = springImpulseForPeak(1, k.rotStiffness, k.rotDamping);
    if (!model) return;
    for (const [name, obj] of Object.entries(model.parts)) {
      const binding: PartBinding = {
        name,
        obj,
        restPos: obj.position.clone(),
        restQuat: obj.quaternion.clone(),
        state: createPartMotionState(obj.visible),
        drivers: [],
      };
      this.parts.push(binding);
      this.partByName.set(name, binding);
    }
    for (const d of model.def.drivers ?? []) {
      const spin = d.spin;
      const idle = clamp01(d.idle ?? 0);
      const driver: DriverBinding = {
        def: d,
        pose: poseFromDef(createPose(), d.pose),
        axis: spin ? AXES[spin.axis] : null,
        rate: spin ? spin.degPerSec * DEG2RAD : 0,
        value: idle,
        angle: 0,
      };
      this.drivers.push(driver);
      // A driver on a missing part still boosts the accents.
      this.partByName.get(d.part)?.drivers.push(driver);
    }
    for (const name of model.def.lockParts) this.settleNames.add(name);
    for (const list of Object.values(model.def.reloadSteps)) {
      for (const m of list ?? []) this.settleNames.add(m.part);
    }
    const cached = weaponId ? this.ammo.get(weaponId) : undefined;
    if (cached) {
      model.setAmmo(cached.mag, cached.magSize);
      // An empty weapon comes back out with its slide/bolt still locked.
      if (cached.mag === 0) this.snapLockedParts();
    }
  }

  /**
   * @param ads 0..1 aim amount (scales kicks and the idle drift).
   * @param motion accessibility camera-motion scale for the idle drift (breathing-like motion).
   */
  update(dt: number, ads: number, motion = 1): void {
    if (dt <= 0) return;
    this.ads = ads;
    this.time += dt;
    const vdef = this.vdef;
    const maxStep = CAMERA.maxSpringStep;

    // --- equip / holster ---
    if (this.equipActive) this.stepEquip(dt);

    // --- scheduled impulses ---
    for (const imp of this.impulses) {
      if (!imp.active) continue;
      imp.delay -= dt;
      if (imp.delay <= 0) {
        imp.active = false;
        addPoseImpulse(this.kick, imp.pose, this.posImpulse, this.rotImpulse);
      }
    }

    // --- choreography tracks → follow spring ---
    const target = poseZero(this.followTarget);
    if (this.reloadActive && vdef) this.evalReload(dt, vdef, target);
    if (this.inspectActive) this.evalInspect(dt, vdef, target);
    stepPoseSpring(this.follow, target, A.poseFollow, dt, maxStep, this.followOut);
    // The bash is too fast for the follow spring (it would lag the blow): applied directly.
    const bash = poseZero(_bash);
    if (this.meleeActive) this.evalMelee(dt, bash);
    this.evalGesture(this.throwGesture, A.grenadeThrow, dt, bash);
    this.evalGesture(this.abilityGesture, A.ability, dt, bash);

    // --- kick springs ---
    stepPoseSpring(this.kick, null, vdef?.kickSpring ?? A.poseFollow, dt, maxStep, this.kickOut);

    // --- accumulators ---
    if (vdef) {
      this.sustained = Math.max(0, this.sustained - vdef.sustained.decay * dt);
      this.heat = Math.max(0, this.heat - vdef.heat.decay * dt);
    }
    this.stepDrivers(dt);
    const accentFlash = this.accentFlash * this.flashScale;
    this.muzzleFlash = this.lightFlash * this.flashScale;
    this.accentFlash *= Math.exp(-A.accentPulse.flashDecay * dt);
    this.lightFlash *= Math.exp(-A.muzzleLight.decay * dt);

    // --- compose the additive pose ---
    const out = this.pose;
    poseZero(out);
    poseAddScaled(out, this.kickOut, 1);
    poseAddScaled(out, this.followOut, 1);
    poseAddScaled(out, bash, 1);
    if (this.lower > 0) poseAddScaled(out, this.lowered, this.lower);
    if (vdef && this.sustained > 0) poseAddDef(out, vdef.sustained.pose, Math.min(1, this.sustained));
    const idle = A.idle;
    const idleScale = lerp(1, idle.adsScale, ads) * motion;
    const sx = Math.sin(this.time * idle.rateX);
    const sy = Math.sin(this.time * idle.rateY + idle.phaseY);
    out.px += sx * idle.position * idleScale;
    out.py += sy * idle.position * idleScale;
    out.rz += sx * idle.rotationDeg * DEG2RAD * idleScale;
    out.rx += sy * idle.rotationDeg * idle.pitchRatio * DEG2RAD * idleScale;

    // --- parts + emissive life ---
    this.applyParts(dt);
    if (this.model) {
      this.fx.time = this.time;
      this.fx.heat = clamp01(this.heat);
      this.fx.flash = accentFlash;
      this.fx.accentBoost = this.accentBoost;
      this.model.animate(this.fx);
    }
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.unbindParts();
    this.model = null;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** A switch begins: lower the shown weapon over the holster time (the raise follows). */
  private onHolsterStart(weaponId: string, duration: number, next: string | null): void {
    if (weaponId !== this.weaponId) return;
    this.endActions();
    this.holsterNext = next;
    // Refined by the weapon:equipStart that announces the switch in the same tick.
    this.pendingRaise = next !== null ? (this.lookupDef(next)?.equipTime ?? 0) : 0;
    this.startEquip(this.lower, 1, Math.max(0, duration));
  }

  private onEquipStart(weaponId: string, duration: number, previous: string | null): void {
    const dur = Math.max(0, duration);
    const shown = this.weaponId;
    this.endActions();
    // A holster of the shown weapon is running (announced by holsterStart, or a retarget while
    // lowering): swap to this weapon when it is down, the rest of the duration raises it.
    if (this.holsterNext !== undefined && this.equipActive && this.equipTo === 1 && shown !== weaponId) {
      this.holsterNext = weaponId;
      this.pendingRaise = Math.max(MIN_DURATION, dur - Math.max(0, this.equipDur - this.equipT));
      return;
    }
    this.holsterNext = undefined;
    // The shown weapon comes back up (changed mind mid-holster, re-equip): from where it is.
    if (shown === weaponId) {
      this.startEquip(this.lower, 0, dur);
      return;
    }
    // A switch announced without holsterStart: time beyond the new weapon's equip time lowers
    // the shown weapon first.
    const equipTime = this.lookupDef(weaponId)?.equipTime ?? dur;
    const holster = dur - Math.min(equipTime, dur);
    if (previous !== null && shown === previous && holster >= A.equip.holsterTolerance) {
      this.holsterNext = weaponId;
      this.pendingRaise = Math.max(MIN_DURATION, dur - holster);
      this.startEquip(this.lower, 1, holster * (1 - this.lower));
      return;
    }
    // Fresh equip or a direct replacement (full inventory): swap now and raise.
    this.swapModel(weaponId);
    this.startEquip(1, 0, dur);
  }

  private onEquipped(weaponId: string): void {
    if (this.holsterNext === weaponId) return;
    if (this.weaponId !== weaponId) this.snapTo(weaponId);
  }

  private onFired(weaponId: string, ammoInMag: number): void {
    if (weaponId !== this.weaponId) return;
    const vdef = this.vdef;
    const kick = this.wdef?.recoil.visualKick;
    this.cancelInspect();
    // Safety: shots only come after a reload ended (the weapon system sends reloadEnd first).
    if (this.reloadActive && !this.reloadEnded) this.endReload(false);
    this.lightFlash = 1;
    this.accentFlash = 1;
    const cached = this.ammo.get(weaponId);
    if (cached) cached.mag = ammoInMag;
    this.model?.setAmmo(ammoInMag, cached?.magSize ?? this.wdef?.magazine ?? ammoInMag);
    if (!vdef) return;
    if (kick) {
      const s = lerp(1, vdef.adsKickScale, this.ads);
      const p = this._peak;
      p.px = kick.side * sign() * s;
      p.py = kick.up * s;
      p.pz = kick.back * s;
      p.rx = kick.pitch * DEG2RAD * s;
      p.ry = kick.yaw * sign() * DEG2RAD * s;
      p.rz = kick.roll * sign() * DEG2RAD * s;
      addPoseImpulse(this.kick, p, this.posImpulse, this.rotImpulse);
    }
    this.sustained = Math.min(1, this.sustained + vdef.sustained.perShot);
    this.heat = Math.min(1, this.heat + vdef.heat.perShot);
    this.runMotions(ammoInMag <= 0 ? vdef.fireLast : vdef.fire);
    this.scheduleImpulses(vdef.fireImpulses, lerp(1, vdef.adsKickScale, this.ads));
  }

  private onDryFire(weaponId: string): void {
    if (weaponId !== this.weaponId) return;
    this.cancelInspect();
    if (!this.vdef) return;
    this.runMotions(this.vdef.dryFire);
    this.impulse(A.dryFireImpulse, 0, 1);
  }

  private onReloadStart(weaponId: string, empty: boolean, duration: number): void {
    if (weaponId !== this.weaponId) return;
    this.cancelInspect();
    this.clearPending();
    this.reloadActive = true;
    this.reloadEmpty = empty;
    this.reloadT = 0;
    this.reloadDur = Math.max(MIN_DURATION, duration);
    this.reloadEnded = false;
    this.reloadWeight = 1;
    this.reloadOutroAt = -1;
    this.reloadLastEventT = 0;
    timeWarpReset(this.reloadWarp);
    const vdef = this.vdef;
    const rl = this.wdef?.reload;
    this.reloadOutroTime = vdef?.reload.style === 'loop' ? vdef.reload.outroTime : 0;
    if (!vdef || !rl) return;
    const r = vdef.reload;
    if (r.style === 'timeline') {
      const track = empty ? r.empty : r.tactical;
      const steps = empty ? rl.emptySteps : rl.tacticalSteps;
      const defDuration = empty ? rl.empty : rl.tactical;
      if (defDuration <= 0) return;
      for (const m of steps) {
        const authored = track.markers[m.step];
        if (authored !== undefined) timeWarpAdd(this.reloadWarp, m.at / defDuration, authored);
      }
      // Marker times scale with this reload's duration (upgrades scale the whole reload).
      const scale = this.reloadDur / defDuration;
      for (const m of steps) this.scheduleLeads(m.step, m.at * scale);
    } else if (rl.perShell && this.shellRoom(weaponId, empty)) {
      this.scheduleLeads('shellIn', rl.perShell.start + rl.perShell.insertAt);
    }
  }

  private onReloadStep(weaponId: string, step: ReloadStep): void {
    if (weaponId !== this.weaponId || !this.vdef) return;
    const bit = STEP_BIT[step];
    const motions = this.vdef.reloadSteps[step];
    if (motions) {
      // Lead motions already started ahead of the marker; anything unscheduled starts now.
      const started = (this.leadStarted & bit) !== 0;
      for (const m of motions) if (!(started && (m.lead ?? 0) > 0)) this.runMotion(m);
    }
    this.leadStarted &= ~bit;
    this.clearPending(step);
    const imps = this.vdef.reloadImpulses[step];
    if (imps) this.scheduleImpulses(imps, 1);
    if (!this.reloadActive) return;
    this.reloadLastEventT = this.reloadT;
    const perShell = this.wdef?.reload.perShell;
    // The next shell follows one cycle later (cancelled by the ammo event if the tube is full).
    if (step === 'shellIn' && perShell && !this.reloadEnded) {
      this.scheduleLeads('shellIn', this.reloadT + perShell.shell);
    }
    // The chambering pump closes a shell-by-shell reload.
    if (step === 'pump' && this.reloadOutroAt < 0) this.startOutro(this.reloadT, this.reloadOutroTime);
  }

  private onReloadEnd(weaponId: string, completed: boolean): void {
    if (weaponId !== this.weaponId) return;
    this.endReload(completed);
  }

  private onAmmo(weaponId: string, mag: number, reserve: number, magSize: number): void {
    const cached = this.ammo.get(weaponId);
    if (cached) {
      cached.mag = mag;
      cached.reserve = reserve;
      cached.magSize = magSize;
    } else this.ammo.set(weaponId, { mag, reserve, magSize });
    if (weaponId !== this.weaponId) return;
    this.model?.setAmmo(mag, magSize);
    // Shell-by-shell: the tube is full (or the reserve dry) → close after the current shell cycle.
    const perShell = this.wdef?.reload.perShell;
    if (this.reloadActive && !this.reloadEnded && perShell) {
      this.reloadLastEventT = this.reloadT;
      if (this.reloadOutroAt < 0 && (mag >= magSize || reserve <= 0)) {
        this.clearPending('shellIn');
        this.startOutro(this.reloadT + Math.max(0, perShell.shell - perShell.insertAt), this.reloadOutroTime);
      }
    }
    // Ammo appeared outside a reload (refill, dev command): release locked slides/bolts.
    if (mag > 0 && !this.reloadActive && this.anyLockDisplaced()) this.settleParts(false);
  }

  private onAds(weaponId: string, aiming: boolean): void {
    if (weaponId !== this.weaponId) return;
    if (aiming) this.cancelInspect();
    this.impulse(aiming ? A.adsInImpulse : A.adsOutImpulse, 0, 1);
  }

  private onInspect(weaponId: string, duration: number): void {
    if (weaponId !== this.weaponId || this.reloadRunning) return;
    this.inspectActive = true;
    this.inspectCancelled = false;
    this.inspectT = 0;
    this.inspectDur = Math.max(MIN_DURATION, duration);
    this.inspectWeight = 1;
  }

  private onMelee(weaponId: string, duration: number, hit: boolean): void {
    if (weaponId !== this.weaponId) return;
    // A second event during the swing only reports the hit (emitters may send start + hit).
    if (!this.meleeActive || this.meleeT >= this.meleeDur) {
      this.cancelInspect();
      this.meleeActive = true;
      this.meleeT = 0;
      this.meleeDur = Math.max(MIN_DURATION, duration);
      // Land the track's blow key exactly on the weapon's hit time.
      timeWarpReset(this.meleeWarp);
      const hitTime = this.wdef?.melee.hitTime;
      if (hitTime !== undefined) timeWarpAdd(this.meleeWarp, hitTime / this.meleeDur, A.meleeStrike);
    }
    if (hit) {
      const hitTime = this.wdef?.melee.hitTime ?? this.meleeDur * A.meleeStrike;
      this.impulse(A.meleeHitImpulse, Math.max(0, hitTime - this.meleeT), 1);
    }
  }

  /** The off hand throws: the weapon dips out of the arm's way (whatever weapon is shown). */
  private onGrenadeThrown(): void {
    this.cancelInspect();
    const G = A.grenadeThrow;
    this.startGesture(this.throwGesture, G);
    this.impulse(G.settleImpulse, G.settleAt * G.duration, 1);
  }

  /** The off hand triggers an ability: a short cant and an accent surge. */
  private onAbilityUsed(): void {
    this.cancelInspect();
    this.startGesture(this.abilityGesture, A.ability);
    this.accentFlash = Math.max(this.accentFlash, A.ability.accentFlash);
  }

  /** A reload is visibly in progress (timeline reloads rest once their duration passed). */
  private get reloadRunning(): boolean {
    if (!this.reloadActive || this.reloadEnded) return false;
    return this.vdef?.reload.style === 'loop' || this.reloadT < this.reloadDur;
  }

  // -------------------------------------------------------------------------
  // Tracks
  // -------------------------------------------------------------------------

  private stepEquip(dt: number): void {
    this.equipT += dt;
    const u = this.equipDur > MIN_DURATION ? this.equipT / this.equipDur : 1;
    const raising = this.equipTo < this.equipFrom;
    const k = ease(raising ? A.equip.raiseEase : A.equip.holsterEase, u);
    this.lower = lerp(this.equipFrom, this.equipTo, k);
    if (u < 1) return;
    this.lower = this.equipTo;
    this.equipActive = false;
    if (this.equipTo === 1 && this.holsterNext !== undefined) {
      const next = this.holsterNext;
      this.holsterNext = undefined;
      this.swapModel(next);
      this.startEquip(1, 0, this.pendingRaise);
    } else if (raising) {
      this.impulse(A.equip.settleImpulse, 0, 1);
    }
  }

  private evalReload(dt: number, vdef: WeaponViewmodelDef, target: Pose): void {
    this.reloadT += dt;
    this.startDuePending();
    const r = vdef.reload;
    if (r.style === 'timeline') {
      if (this.reloadEnded) this.reloadWeight = damp(this.reloadWeight, 0, A.cancelLambda, dt);
      const t = Math.min(1, this.reloadT / this.reloadDur);
      samplePoseTrack(
        _track,
        this.reloadEmpty ? r.empty.keys : r.tactical.keys,
        timeWarpApply(this.reloadWarp, t),
      );
      poseAddScaled(target, _track, this.reloadWeight);
      // Robust against a missing weapon:reloadEnd: the track is at rest after its duration anyway.
      const expired = this.reloadT >= this.reloadDur + A.reloadEndGrace;
      if ((t >= 1 && (this.reloadEnded || expired)) || this.reloadWeight < WEIGHT_EPSILON) {
        this.reloadActive = false;
        this.clearPending();
      }
      return;
    }
    // Loop style: intro → hold → outro. Safety: a loop that went quiet long after its announced
    // duration (no reloadEnd) closes by itself.
    if (this.reloadOutroAt < 0) {
      const cycle = this.wdef?.reload.perShell?.shell ?? 0;
      const quiet = this.reloadT - this.reloadLastEventT;
      if (this.reloadT > this.reloadDur + A.reloadEndGrace && quiet > cycle + A.reloadEndGrace) {
        this.startOutro(this.reloadT, r.outroTime);
      }
    }
    const intro = ease('inOut', r.introTime > 0 ? this.reloadT / r.introTime : 1);
    let outro = 1;
    if (this.reloadOutroAt >= 0 && this.reloadT >= this.reloadOutroAt) {
      const u = this.reloadOutroTime > 0 ? (this.reloadT - this.reloadOutroAt) / this.reloadOutroTime : 1;
      outro = 1 - ease('inOut', u);
      if (u >= 1) {
        this.reloadActive = false;
        this.clearPending();
      }
    }
    this.reloadWeight = Math.min(intro, outro);
    poseAddDef(target, r.hold, this.reloadWeight);
  }

  private evalInspect(dt: number, vdef: WeaponViewmodelDef | null, target: Pose): void {
    this.inspectT += dt;
    if (this.inspectCancelled) this.inspectWeight = damp(this.inspectWeight, 0, A.cancelLambda, dt);
    const t = this.inspectT / this.inspectDur;
    samplePoseTrack(_track, vdef?.inspect ?? A.inspect, Math.min(1, t));
    poseAddScaled(target, _track, this.inspectWeight);
    if (t >= 1 || this.inspectWeight < WEIGHT_EPSILON) this.inspectActive = false;
  }

  private evalMelee(dt: number, target: Pose): void {
    this.meleeT += dt;
    const t = this.meleeT / this.meleeDur;
    samplePoseTrack(_track, A.melee, timeWarpApply(this.meleeWarp, Math.min(1, t)));
    poseAddScaled(target, _track, 1);
    if (t >= 1) this.meleeActive = false;
  }

  /** (Re)start a gesture; a running one hands its current pose over as a fading offset. */
  private startGesture(g: GestureState, def: GestureDef): void {
    if (g.active) poseCopy(g.from, this.sampleGesture(g, def, _gesture));
    else poseZero(g.from);
    g.t = 0;
    g.active = true;
  }

  private sampleGesture(g: GestureState, def: GestureDef, out: Pose): Pose {
    samplePoseTrack(out, def.keys, def.duration > 0 ? Math.min(1, g.t / def.duration) : 1);
    const fade = A.restartFade;
    const w = fade > 0 ? 1 - ease('inOut', g.t / fade) : 0;
    if (w > 0) poseAddScaled(out, g.from, w);
    return out;
  }

  private evalGesture(g: GestureState, def: GestureDef, dt: number, target: Pose): void {
    if (!g.active) return;
    g.t += dt;
    poseAddScaled(target, this.sampleGesture(g, def, _gesture), 1);
    if (g.t >= def.duration) g.active = false;
  }

  /** Ease every driver towards its source; spin angles and the accent boost follow. */
  private stepDrivers(dt: number): void {
    let boost = 0;
    for (const d of this.drivers) {
      const def = d.def;
      const target = Math.max(clamp01(def.idle ?? 0), this.driverSource(def.source));
      const r = def.response ?? 0;
      d.value = r > 0 ? damp(d.value, target, r, dt) : target;
      if (d.rate !== 0) d.angle = (d.angle + d.rate * d.value * dt) % TAU;
      if (def.accentBoost) boost += def.accentBoost * d.value;
    }
    this.accentBoost = boost;
  }

  private driverSource(source: ViewmodelDriverDef['source']): number {
    switch (source) {
      case 'spin':
        return this.spinSource;
      case 'charge':
        return this.chargeSource;
      case 'beam':
        return this.beamSource;
      case 'heat':
        return clamp01(this.heat);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private startEquip(from: number, to: number, duration: number): void {
    this.equipFrom = from;
    this.equipTo = to;
    this.equipT = 0;
    this.equipDur = Math.max(0, duration);
    this.equipActive = true;
    this.lower = from;
  }

  private swapModel(weaponId: string | null): void {
    const model = this.showModelFn(weaponId);
    this.bindModel(weaponId, model);
  }

  /** Stop reload/inspect/melee (weapon switch): tracks cut, the follow spring smooths the pose. */
  private endActions(): void {
    if (this.reloadActive && !this.reloadEnded) this.settleParts(true);
    this.reloadActive = false;
    this.inspectActive = false;
    this.meleeActive = false;
    this.clearPending();
  }

  /** Reload over (event, fire safety): blend out, send reload-moved parts home. */
  private endReload(completed: boolean): void {
    this.clearPending();
    this.leadStarted = 0;
    if (this.reloadActive && !this.reloadEnded) {
      this.reloadEnded = true;
      // A loop that did not start closing yet: the weapon is ready now, blend out fast.
      if (this.vdef?.reload.style === 'loop' && this.reloadOutroAt < 0) {
        this.startOutro(this.reloadT, A.cancelOutroTime);
      }
    }
    this.settleParts(!completed);
  }

  private startOutro(at: number, time: number): void {
    this.reloadOutroAt = at;
    this.reloadOutroTime = time;
  }

  /** The tube/magazine can take another round (unknown ammo counts as room). */
  private shellRoom(weaponId: string, empty: boolean): boolean {
    const a = this.ammo.get(weaponId);
    const w = this.wdef;
    if (!a || !w) return true;
    const capacity = w.magazine + (w.chambered && !empty ? 1 : 0);
    return a.mag < capacity && a.reserve > 0;
  }

  private resetMotion(): void {
    resetPoseSpring(this.kick);
    resetPoseSpring(this.follow);
    poseZero(this.kickOut);
    poseZero(this.followOut);
    for (const imp of this.impulses) imp.active = false;
    this.reloadActive = false;
    this.inspectActive = false;
    this.meleeActive = false;
    this.clearPending();
    this.leadStarted = 0;
    this.sustained = 0;
    this.heat = 0;
    this.accentFlash = 0;
    this.lightFlash = 0;
    this.muzzleFlash = 0;
    this.spinSource = 0;
    this.chargeSource = 0;
    this.beamSource = 0;
    this.accentBoost = 0;
  }

  private runMotions(list: readonly PartMotionDef[]): void {
    for (const m of list) this.runMotion(m);
  }

  private runMotion(m: PartMotionDef): void {
    const b = this.partByName.get(m.part);
    if (b) startPartMotion(b.state, m);
  }

  /** Queue the lead motions of `step` whose marker fires at `markerAt` (reload clock). */
  private scheduleLeads(step: ReloadStep, markerAt: number): void {
    const motions = this.vdef?.reloadSteps[step];
    if (!motions) return;
    for (const m of motions) {
      const lead = m.lead ?? 0;
      if (lead <= 0) continue;
      let slot: PendingMotion | null = null;
      for (const p of this.pending) {
        if (p.def === null) {
          slot = p;
          break;
        }
      }
      if (!slot) return;
      slot.def = m;
      slot.step = step;
      slot.at = Math.max(0, markerAt - lead);
    }
  }

  private startDuePending(): void {
    for (const p of this.pending) {
      const def = p.def;
      if (def === null || this.reloadT < p.at) continue;
      p.def = null;
      this.leadStarted |= STEP_BIT[p.step];
      this.runMotion(def);
    }
  }

  /** Drop scheduled lead motions (all, or those of one step). */
  private clearPending(step?: ReloadStep): void {
    for (const p of this.pending) if (step === undefined || p.step === step) p.def = null;
  }

  private impulse(def: PoseDef, delay: number, scale: number): void {
    let slot = this.impulses[0]!;
    for (const imp of this.impulses) {
      if (!imp.active) {
        slot = imp;
        break;
      }
    }
    poseFromDef(slot.pose, def, scale);
    slot.delay = delay;
    slot.active = true;
    if (delay <= 0) {
      slot.active = false;
      addPoseImpulse(this.kick, slot.pose, this.posImpulse, this.rotImpulse);
    }
  }

  private scheduleImpulses(list: readonly DelayedImpulseDef[], scale: number): void {
    for (const d of list) this.impulse(d.pose, d.delay, scale);
  }

  /**
   * Reload over / ammo back: parts off their rest pose tween home (locks stay while empty).
   * `force` (cancelled reload) also interrupts step motions still running (a magazine on its way
   * in, a shell being pushed); otherwise those finish on their own.
   */
  private settleParts(force: boolean): void {
    const mag = this.weaponId ? (this.ammo.get(this.weaponId)?.mag ?? 1) : 1;
    const locks = this.vdef?.lockParts ?? [];
    for (const b of this.parts) {
      if (!this.settleNames.has(b.name)) continue;
      const s = b.state;
      const running = s.baseDef !== null;
      const displaced = running || poseNonZero(s.base) || s.visible !== s.restVisible;
      if (!displaced || (running && !force)) continue;
      if (mag === 0 && locks.includes(b.name)) continue;
      startPartMotion(s, s.restVisible ? SETTLE_SHOW : SETTLE_HIDE);
    }
  }

  private anyLockDisplaced(): boolean {
    for (const name of this.vdef?.lockParts ?? []) {
      const b = this.partByName.get(name);
      if (b && (b.state.baseDef !== null || poseNonZero(b.state.base))) return true;
    }
    return false;
  }

  /** Latch the lock parts at their `fireLast` pose instantly (switching to an empty weapon). */
  private snapLockedParts(): void {
    const vdef = this.vdef;
    if (!vdef) return;
    for (const m of vdef.fireLast) {
      if (m.type !== 'tween' || !vdef.lockParts.includes(m.part)) continue;
      const b = this.partByName.get(m.part);
      if (!b) continue;
      poseFromDef(b.state.base, m.pose);
    }
  }

  private applyParts(dt: number): void {
    for (const b of this.parts) {
      stepPartMotion(b.state, dt);
      partOffset(b.state, _offset);
      for (const d of b.drivers) if (d.value !== 0) poseAddScaled(_offset, d.pose, d.value);
      const obj = b.obj;
      _v.set(_offset.px, _offset.py, _offset.pz).applyQuaternion(b.restQuat);
      obj.position.copy(b.restPos).add(_v);
      _q.setFromEuler(_e.set(_offset.rx, _offset.ry, _offset.rz));
      obj.quaternion.copy(b.restQuat).multiply(_q);
      // Spins turn the part about its own (offset) axis, after the pose offset.
      for (const d of b.drivers)
        if (d.axis && d.angle !== 0) obj.quaternion.multiply(_qs.setFromAxisAngle(d.axis, d.angle));
      obj.visible = b.state.visible;
    }
  }

  /** Put every part back to its rest transform (before the model is unbound/cached). */
  private unbindParts(): void {
    for (const b of this.parts) {
      b.obj.position.copy(b.restPos);
      b.obj.quaternion.copy(b.restQuat);
      b.obj.visible = b.state.restVisible;
      resetPartMotion(b.state);
    }
    this.parts.length = 0;
    this.partByName.clear();
    this.settleNames.clear();
    this.drivers.length = 0;
  }
}

function poseNonZero(p: Pose): boolean {
  return p.px !== 0 || p.py !== 0 || p.pz !== 0 || p.rx !== 0 || p.ry !== 0 || p.rz !== 0;
}

/** Cosmetic random sign (Math.random is fine for visual-only jitter). */
function sign(): number {
  return Math.random() < 0.5 ? -1 : 1;
}
