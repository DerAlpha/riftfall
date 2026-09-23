/**
 * First-person movement state machine on top of Rapier's KinematicCharacterController.
 *
 * Velocity based: we own `velocity`, integrate it with Source-style friction/acceleration
 * (see movementMath.ts), ask the character controller how far the capsule can actually
 * move (`computeColliderMovement(velocity·dt)`), then derive what really happened (clip
 * velocity against walls/ceilings, zero vertical speed on ground, landings, steps).
 *
 * Timing contract (see CLAUDE.md "Frame / tick flow"):
 * - `input.beginFrame()` runs before the ticks of a frame (GameLoop.beginFrame).
 * - `fixedUpdate(dt)` once per tick, BEFORE `physics.step(dt)`: samples input (held state +
 *   this frame's pressed() edges, each edge latched once per frame), then the controller queries
 *   the collider pose of the previous step and sets the next kinematic translation, which the
 *   following step applies (together with the impulses pushed into dynamic props).
 * - `update(dt, alpha)` once per frame after the ticks: latches edges of frames that had no tick,
 *   smooths ADS + eye height and computes the interpolated eye position.
 *
 * Collision response: velocity is clipped only against surfaces that actually stopped part of
 * the move (so PlayerApi.velocity is the real velocity; climbed steps are not "walls"). Ground is
 * walkable (≤ maxSlopeDeg) per an axis ray, else per the most upward contact normal, else per
 * two contacts wedging the capsule (V crevice); steeper surfaces count as air and a fall onto
 * them turns into a slide.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import type { InputApi, PlayerApi, RaycastOptions, SettingsStore } from '../core/contracts';
import type { Action } from '../defs/input';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, MovementState, SurfaceType, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { DEG2RAD, clamp, clamp01, damp, lerp } from '../core/math';
import { CAMERA } from '../defs/camera';
import { MOVEMENT } from '../defs/movement';
import { COLLISION_FILTER, COLLISION_GROUP, interactionGroups } from '../defs/physics';
import { PLAYER } from '../defs/player';
import { groupsForKind, type PhysicsWorld } from '../physics/PhysicsWorld';
import {
  accelerate,
  addUniqueNormal,
  advanceGait,
  airAccelerate,
  applyFriction,
  applyLinearFriction,
  canGroundJump,
  clampHorizontalSpeed,
  classifyLanding,
  clipVelocity,
  consumeDashCharge,
  doubleJumpRedirect,
  effectiveGravity,
  integrateVertical,
  jumpVelocity,
  ledgeHeightOk,
  mantleCurve,
  mantleDuration,
  pairSupportNormal,
  rechargeDash,
  slopeAcceleration,
  slopeAngle,
  steerTowards,
  tickDown,
  type DashChargeState,
  type GaitState,
  type LandingInfo,
  type MantleCurve,
  type VerticalStep,
} from './movementMath';

const log = createLogger('player');

const C = MOVEMENT.collider;
const G = MOVEMENT.ground;
const A = MOVEMENT.air;
const J = MOVEMENT.jump;
const S = MOVEMENT.slide;
const D = MOVEMENT.dash;
const M = MOVEMENT.mantle;
const F = MOVEMENT.footsteps;

const R = C.radius;
const STAND_HALF = (C.standHeight - 2 * R) / 2;
const CROUCH_HALF = (C.crouchHeight - 2 * R) / 2;
const WALKABLE_COS = Math.cos(G.maxSlopeDeg * DEG2RAD);
const SLIDE_EXTEND_MIN_RAD = S.slopeExtendMinDeg * DEG2RAD;
const MOVE_GROUPS = interactionGroups(COLLISION_GROUP.PLAYER, COLLISION_FILTER.playerMovement);
const PROBE_GROUPS = interactionGroups(COLLISION_GROUP.PLAYER, COLLISION_FILTER.playerProbe);
const PLAYER_SOLVER_GROUPS = interactionGroups(COLLISION_GROUP.PLAYER, COLLISION_FILTER.playerSolver);
/** Movement below this (m per tick) is float noise, not a real block. */
const MOVE_EPS = 1e-4;
/** Contact normals closer than this (dot product) are the same surface (Rapier repeats contacts). */
const SAME_NORMAL_DOT = 0.999;
/** Distinct contact normals kept per move for the two-contact support test. */
const MAX_CONTACT_NORMALS = 8;

const EMPTY_PAYLOAD: Record<string, never> = {};
const EDGE_JUMP = 1;
const EDGE_CROUCH = 2;
const EDGE_SPRINT = 4;
const EDGE_DASH = 8;

// Module-level scratch (no per-tick allocations).
const _desired = { x: 0, y: 0, z: 0 };
const _moved = { x: 0, y: 0, z: 0 };
const _vstep: VerticalStep = { dy: 0, vy: 0 };
const _slope = { x: 0, z: 0 };
const _curve: MantleCurve = { vertical: 0, horizontal: 0 };
const _landing: LandingInfo = { emit: false, heavy: false };
const _origin = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: 0, z: 0 };
const _shapePos = { x: 0, y: 0, z: 0 };
const _down = { x: 0, y: -1, z: 0 };
const _dashDirOut = { x: 0, y: 0, z: 0 };
const _wallN = { x: 0, y: 0, z: 0 };
const _support = { x: 0, y: 1, z: 0 };
const _pairSupport = { x: 0, y: 1, z: 0 };
const _contactNormals = new Float64Array(MAX_CONTACT_NORMALS * 3);

export interface PlayerUnlocks {
  doubleJump: boolean;
  dash: boolean;
}

export interface PlayerControllerDeps {
  physics: PhysicsWorld;
  input: InputApi;
  events: EventBus<GameEvents>;
  settings: SettingsStore;
  /** Optional movement unlocks (also accepted via `options`). Default: PLAYER.defaultUnlocks. */
  unlocks?: PlayerUnlocks;
}

export interface PlayerSpawn {
  position: Vec3Like;
  yaw: number;
}

export interface PlayerControllerOptions {
  unlocks?: PlayerUnlocks;
}

export class PlayerController implements PlayerApi {
  /** Feet position at the latest fixed tick. */
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly eyePosition = new Vector3();
  /** Displacement of the last tick / dt (what really happened after collisions). */
  readonly actualVelocity = new Vector3();
  yaw = 0;
  pitch = 0;
  unlocks: PlayerUnlocks;
  godMode = false;

  readonly physics: PhysicsWorld;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;

  private readonly input: InputApi;
  private readonly events: EventBus<GameEvents>;
  private readonly settings: SettingsStore;
  private readonly kcc: RAPIER.KinematicCharacterController;
  private readonly standTestShape: RAPIER.Capsule;
  private readonly collision: RAPIER.CharacterCollision;
  /** Reused ray options for ground/mantle probes (no per-tick allocation). */
  private readonly probeOpts: RaycastOptions;

  private readonly prevFeet = new Vector3();
  private _state: MovementState = 'air';
  private _grounded = false;
  private _crouched = false;
  private _sprinting = false;
  private _noclip = false;
  private _adsAmount = 0;
  private _stateTime = 0;
  private snapEnabled = true;
  private disposed = false;

  // --- input, sampled per tick and per frame (sampleInput) ---
  private readonly moveInput = { x: 0, y: 0 };
  private jumpHeld = false;
  private crouchHeld = false;
  private sprintHeld = false;
  private adsHeld = false;
  private jumpLatched = false;
  private crouchLatched = false;
  private sprintLatched = false;
  private dashLatched = false;
  private crouchToggled = false;
  private sprintToggled = false;
  private crouchWanted = false;
  /** Frame counter (advanced by update) so each frame's pressed() edges are latched only once. */
  private inputFrame = 0;
  private edgeFrame = -1;
  /** EDGE_* bits of the actions whose pressed() edge was already latched in `edgeFrame`. */
  private edgeMask = 0;

  // --- tick state ---
  private readonly wishDir = { x: 0, z: 0 };
  private wishMag = 0;
  private dy = 0;
  private jumpedThisTick = false;
  private timeSinceGrounded = Number.POSITIVE_INFINITY;
  private jumpBuffer = 0;
  private jumpCooldown = 0;
  private jumpedSinceGrounded = false;
  private jumpActive = false;
  /** Seconds since the last ground/double jump took off (gates the jump cut). */
  private jumpRiseTime = 0;
  private doubleJumpUsed = false;
  private slideTime = 0;
  private slideBoostCooldown = 0;
  private dashTime = 0;
  private dashInterval = 0;
  private readonly dashCharge: DashChargeState = { charges: D.charges, progress: 0 };
  private readonly dashDir = { x: 0, z: -1 };
  private mantleCooldown = 0;
  private mantleT = 0;
  private mantleDur: number = M.duration;
  private mantleExitSpeed: number = M.exitSpeed;
  private readonly mantleStart = new Vector3();
  private readonly mantleEnd = new Vector3();
  private readonly mantleDir = { x: 0, z: -1 };
  private readonly gait: GaitState = { phase: 0 };
  private prevGaitPhase = 0;
  private _gaitPhase = 0;
  private eyeHeight: number = C.standEyeHeight;
  private stepOffset = 0;
  private readonly groundNormal = { x: 0, y: 1, z: 0 };
  private groundSurface: SurfaceType = 'default';

  constructor(deps: PlayerControllerDeps, spawn: PlayerSpawn, options?: PlayerControllerOptions) {
    this.physics = deps.physics;
    this.input = deps.input;
    this.events = deps.events;
    this.settings = deps.settings;
    const u = options?.unlocks ?? deps.unlocks ?? PLAYER.defaultUnlocks;
    this.unlocks = { doubleJump: u.doubleJump, dash: u.dash };

    const world = this.physics.world;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        spawn.position.x,
        spawn.position.y,
        spawn.position.z,
      ),
    );
    const desc = RAPIER.ColliderDesc.capsule(STAND_HALF, R)
      .setTranslation(0, STAND_HALF + R, 0)
      .setCollisionGroups(groupsForKind('player'))
      .setSolverGroups(PLAYER_SOLVER_GROUPS);
    this.collider = this.physics.createCollider(desc, this.body, { kind: 'player', surface: 'default' });

    this.kcc = world.createCharacterController(C.skin);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.setSlideEnabled(true);
    this.kcc.enableAutostep(G.stepHeight, G.stepMinWidth, false);
    this.kcc.enableSnapToGround(G.snapToGround);
    this.kcc.setMaxSlopeClimbAngle(G.maxSlopeDeg * DEG2RAD);
    this.kcc.setMinSlopeSlideAngle(G.maxSlopeDeg * DEG2RAD);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(C.mass);

    this.standTestShape = new RAPIER.Capsule(STAND_HALF, R - C.skin);
    this.collision = new RAPIER.CharacterCollision();
    this.probeOpts = { groups: PROBE_GROUPS, excludeCollider: this.collider };

    this.place(spawn.position, spawn.yaw);
  }

  // -------------------------------------------------------------------------
  // PlayerApi getters
  // -------------------------------------------------------------------------

  get state(): MovementState {
    return this._state;
  }
  get grounded(): boolean {
    return this._grounded;
  }
  get crouched(): boolean {
    return this._crouched;
  }
  get sprinting(): boolean {
    return this._sprinting && (this._state === 'ground' || this._state === 'air');
  }
  get dashCharges(): number {
    return this.dashCharge.charges;
  }
  /** 0..1 progress of the next charge; 1 when all charges are full. */
  get dashRecharge(): number {
    return this.dashCharge.charges >= D.charges ? 1 : this.dashCharge.progress;
  }
  get adsAmount(): number {
    return this._adsAmount;
  }
  get noclip(): boolean {
    return this._noclip;
  }
  set noclip(v: boolean) {
    if (v === this._noclip) return;
    this._noclip = v;
    this.collider.setEnabled(!v);
    this.velocity.set(0, 0, 0);
    if (v) {
      if (this._state === 'slide') this.events.emit('player:slideEnd', EMPTY_PAYLOAD);
      this._grounded = false;
      this.setState('noclip');
    } else {
      this._grounded = false;
      this.timeSinceGrounded = Number.POSITIVE_INFINITY;
      this.setState('air');
    }
  }

  // --- extras for camera / viewmodel / HUD (not part of the contract) ---

  /** Interpolated gait phase in radians; a footstep happens at every multiple of PI. */
  get gaitPhase(): number {
    return this._gaitPhase;
  }
  /** Horizontal speed actually travelled during the last tick (m/s), after collisions. */
  get horizontalSpeed(): number {
    return Math.hypot(this.actualVelocity.x, this.actualVelocity.z);
  }
  /** Seconds spent in the current movement state. */
  get stateTime(): number {
    return this._stateTime;
  }
  /** Current (smoothed) eye height above the feet, without stair smoothing. */
  get currentEyeHeight(): number {
    return this.eyeHeight;
  }

  // -------------------------------------------------------------------------
  // Per frame
  // -------------------------------------------------------------------------

  update(dt: number, alpha: number): void {
    if (this.disposed) return;
    // Frames without a tick still latch their edges here; the next tick consumes them.
    this.sampleInput();
    this.inputFrame++;

    const adsTarget = this.adsHeld ? 1 : 0;
    const adsLambda = adsTarget > this._adsAmount ? PLAYER.ads.lambdaIn : PLAYER.ads.lambdaOut;
    this._adsAmount = damp(this._adsAmount, adsTarget, adsLambda, dt);

    const targetEye =
      this._state === 'slide' ? C.slideEyeHeight : this._crouched ? C.crouchEyeHeight : C.standEyeHeight;
    this.eyeHeight = damp(this.eyeHeight, targetEye, C.eyeHeightLambda, dt);
    this.stepOffset = damp(this.stepOffset, 0, C.stepSmoothLambda, dt);

    const a = clamp01(alpha);
    this.eyePosition.lerpVectors(this.prevFeet, this.position, a);
    this.eyePosition.y += this.eyeHeight + this.stepOffset;
    this._gaitPhase = lerp(this.prevGaitPhase, this.gait.phase, a);
  }

  /**
   * Read held state + latch pressed() edges. Called by the tick as well as by update(): the
   * loop runs the ticks of a frame between input.beginFrame and update, so sampling in the tick
   * removes a frame of input latency; update() still latches edges of frames without a tick.
   * Each action's edge is latched once per frame (several ticks per frame, or the tick plus
   * update, must not see the same press twice).
   */
  private sampleInput(): void {
    const input = this.input;
    input.getMove(this.moveInput);
    this.jumpHeld = input.isDown('jump');
    this.crouchHeld = input.isDown('crouch');
    this.sprintHeld = input.isDown('sprint');
    this.adsHeld = input.isDown('ads');
    if (this.edgeFrame !== this.inputFrame) {
      this.edgeFrame = this.inputFrame;
      this.edgeMask = 0;
    }
    if (this.latchEdge('jump', EDGE_JUMP)) this.jumpLatched = true;
    if (this.latchEdge('crouch', EDGE_CROUCH)) this.crouchLatched = true;
    if (this.latchEdge('sprint', EDGE_SPRINT)) this.sprintLatched = true;
    if (this.latchEdge('dash', EDGE_DASH)) this.dashLatched = true;
  }

  /** True the first time this frame an action's pressed() edge is seen (per action, order-proof). */
  private latchEdge(action: Action, bit: number): boolean {
    if ((this.edgeMask & bit) !== 0 || !this.input.pressed(action)) return false;
    this.edgeMask |= bit;
    return true;
  }

  // -------------------------------------------------------------------------
  // Per tick
  // -------------------------------------------------------------------------

  fixedUpdate(dt: number): void {
    if (this.disposed || this.physics.disposed || !(dt > 0)) return;
    this.sampleInput();
    this.physics.ensureQueries();
    this.prevFeet.copy(this.position);
    this.prevGaitPhase = this.gait.phase;
    this._stateTime += dt;
    this.jumpedThisTick = false;

    this.jumpBuffer = tickDown(this.jumpBuffer, dt);
    this.jumpCooldown = tickDown(this.jumpCooldown, dt);
    this.dashInterval = tickDown(this.dashInterval, dt);
    this.mantleCooldown = tickDown(this.mantleCooldown, dt);
    this.slideBoostCooldown = tickDown(this.slideBoostCooldown, dt);
    rechargeDash(this.dashCharge, D.charges, D.rechargeTime, dt);

    const jumpPressed = this.jumpLatched;
    const crouchPressed = this.crouchLatched;
    const sprintPressed = this.sprintLatched;
    const dashPressed = this.dashLatched;
    this.jumpLatched = this.crouchLatched = this.sprintLatched = this.dashLatched = false;
    if (jumpPressed) this.jumpBuffer = J.bufferTime;

    if (this._noclip) {
      this.tickNoclip(dt);
      return;
    }
    const controls = this.settings.current.controls;
    if (this._state === 'mantle') {
      // Presses during the vault are not lost: toggles apply now, a dash fires right after it.
      this.updateCrouchIntent(crouchPressed, controls.toggleCrouch);
      this.updateSprint(sprintPressed, controls.toggleSprint, controls.autoSprint);
      if (dashPressed) this.dashLatched = true;
      this.tickMantle(dt);
      return;
    }

    this.wishMag = this.computeWish();
    this.updateCrouchIntent(crouchPressed, controls.toggleCrouch);
    this.updateSprint(sprintPressed, controls.toggleSprint, controls.autoSprint);

    // --- actions (priority: dash > mantle > jump > slide) ---
    if (dashPressed) this.tryDash();
    // A buffered jump cancels the dash (keeps the exit momentum) so dash-jumps feel responsive –
    // but only if a jump can actually happen, otherwise a stray press would waste the dash.
    if (this._state === 'dash' && this.jumpBuffer > 0 && this.dashTime > 0 && this.jumpAvailable())
      this.finishDash();
    if (this._state !== 'dash') {
      if (this.jumpBuffer > 0) this.tryJumpOrMantle();
      else if (this.shouldAutoMantle()) this.tryMantle();
      // (re-read through a method: TS narrowed _state above, but the calls may have changed it)
      if (this.isMantling()) {
        this.tickMantle(dt);
        return;
      }
      if (crouchPressed && this._state === 'ground') this.tryStartSlide();
    }

    this.tickState(dt);
    this.moveAndCollide(dt);
    this.applyCrouchCollider();
    // The boost cooldown runs from the END of a slide: slide-hops can't re-earn the boost.
    if (this._state === 'slide') this.slideBoostCooldown = S.boostCooldown;
  }

  // -------------------------------------------------------------------------
  // Intents
  // -------------------------------------------------------------------------

  /** Horizontal wish direction from input + yaw; returns input magnitude 0..1. */
  private computeWish(): number {
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // forward = (-sin, 0, -cos), right = (cos, 0, -sin)
    const wx = -sin * this.moveInput.y + cos * this.moveInput.x;
    const wz = -cos * this.moveInput.y - sin * this.moveInput.x;
    const len = Math.hypot(wx, wz);
    if (len < 1e-4) {
      this.wishDir.x = 0;
      this.wishDir.z = 0;
      return 0;
    }
    this.wishDir.x = wx / len;
    this.wishDir.z = wz / len;
    return Math.min(1, len);
  }

  private updateCrouchIntent(crouchPressed: boolean, toggle: boolean): void {
    if (toggle) {
      if (crouchPressed) this.crouchToggled = !this.crouchToggled;
      this.crouchWanted = this.crouchToggled;
    } else {
      this.crouchToggled = false;
      this.crouchWanted = this.crouchHeld || crouchPressed;
    }
  }

  private updateSprint(sprintPressed: boolean, toggle: boolean, autoSprint: boolean): void {
    if (sprintPressed) {
      if (toggle) this.sprintToggled = !this.sprintToggled;
      // Sprinting out of a toggled crouch stands the player up.
      if (this.crouchToggled && this._state !== 'slide') {
        this.crouchToggled = false;
        this.crouchWanted = false;
      }
    }
    const forwardOk = this.moveInput.y >= G.sprintForwardThreshold;
    const adsOk = this._adsAmount < G.sprintAdsCancel;
    if (!forwardOk || !adsOk) this.sprintToggled = false;
    const wants = autoSprint || (toggle ? this.sprintToggled : this.sprintHeld);
    // Also not while held crouched by a low ceiling (the speed is crouch speed there anyway).
    this._sprinting = wants && forwardOk && adsOk && !this.crouchWanted && !this._crouched;
  }

  private groundWishSpeed(): number {
    let speed =
      this._crouched || this.crouchWanted ? G.crouchSpeed : this._sprinting ? G.sprintSpeed : G.runSpeed;
    if (this.moveInput.y < 0) speed *= G.backwardSpeedMultiplier;
    speed *= lerp(1, G.adsSpeedMultiplier, this._adsAmount);
    return speed * this.wishMag;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private tryDash(): void {
    if (!this.unlocks.dash || this.dashInterval > 0 || this._state === 'dash') return;
    if (!consumeDashCharge(this.dashCharge)) return;
    if (this.wishMag > 0) {
      this.dashDir.x = this.wishDir.x;
      this.dashDir.z = this.wishDir.z;
    } else {
      this.dashDir.x = -Math.sin(this.yaw);
      this.dashDir.z = -Math.cos(this.yaw);
    }
    if (this._state === 'slide') this.events.emit('player:slideEnd', EMPTY_PAYLOAD);
    this.dashTime = 0;
    this.dashInterval = D.minInterval;
    this.jumpActive = false;
    this.setState('dash');
    _dashDirOut.x = this.dashDir.x;
    _dashDirOut.y = 0;
    _dashDirOut.z = this.dashDir.z;
    this.events.emit('player:dash', {
      direction: _dashDirOut,
      chargesLeft: this.dashCharge.charges,
      position: this.position,
    });
    this.events.emit('camera:shake', { trauma: CAMERA.shake.traumaDash });
  }

  /** Would a jump press right now produce a ground jump or a double jump? */
  private jumpAvailable(): boolean {
    if (
      canGroundJump(
        this._grounded,
        this.timeSinceGrounded,
        J.coyoteTime,
        this.jumpedSinceGrounded,
        this.jumpCooldown,
      )
    ) {
      return true;
    }
    return this.unlocks.doubleJump && !this.doubleJumpUsed;
  }

  private tryJumpOrMantle(): void {
    if (this.moveInput.y >= M.jumpForwardInputMin && this.tryMantle()) return;
    if (
      canGroundJump(
        this._grounded,
        this.timeSinceGrounded,
        J.coyoteTime,
        this.jumpedSinceGrounded,
        this.jumpCooldown,
      )
    ) {
      this.groundJump();
      return;
    }
    if (this._state === 'air' && this.unlocks.doubleJump && !this.doubleJumpUsed) {
      // Touchdown is imminent: keep the press buffered for a full ground jump (double jump kept).
      if (this.velocity.y < 0 && this.groundWithin(-this.velocity.y * J.landPredictTime)) return;
      this.doubleJump();
    }
  }

  private groundJump(): void {
    if (this._state === 'slide') {
      this.velocity.x *= S.jumpMomentumKeep;
      this.velocity.z *= S.jumpMomentumKeep;
      this.events.emit('player:slideEnd', EMPTY_PAYLOAD);
    }
    this.velocity.y = jumpVelocity(J.height, A.gravity);
    this.jumpBuffer = 0;
    this.jumpCooldown = J.cooldown;
    this.jumpedSinceGrounded = true;
    this.jumpActive = true;
    this.jumpRiseTime = 0;
    this.jumpedThisTick = true;
    this._grounded = false;
    // Jumping out of a toggled crouch stands up (only when not slide-jumping).
    if (this._state !== 'slide' && this.crouchToggled) {
      this.crouchToggled = false;
      this.crouchWanted = false;
    }
    this.setState('air');
    this.events.emit('player:jump', { double: false, position: this.position });
  }

  private doubleJump(): void {
    this.velocity.y = jumpVelocity(J.doubleJumpHeight, A.gravity);
    doubleJumpRedirect(
      this.velocity,
      this.wishDir,
      this.wishMag > 0,
      J.doubleJumpDirectionalBoost,
      G.sprintSpeed,
    );
    this.doubleJumpUsed = true;
    this.jumpActive = true;
    this.jumpRiseTime = 0;
    this.jumpedThisTick = true;
    this.jumpBuffer = 0;
    this.events.emit('player:jump', { double: true, position: this.position });
  }

  private tryStartSlide(): boolean {
    if (!this._grounded) return false;
    // Also the real motion (3D, so slopes are not penalised): pushing a dynamic prop keeps
    // `velocity` at wish speed while the player barely moves.
    const a = this.actualVelocity;
    const moved = Math.hypot(a.x, a.y, a.z);
    if (Math.min(this.intendedSpeed(), moved) < S.minStartSpeed) return false;
    this.startSlide();
    return true;
  }

  private intendedSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  private startSlide(): void {
    const speed = this.intendedSpeed();
    if (this.slideBoostCooldown <= 0 && speed > 1e-3) {
      // Never boost past sprint + boost: repeated landing slides can't stack speed.
      const boosted = Math.min(speed + S.startBoost, G.sprintSpeed + S.startBoost);
      const s = Math.min(S.maxSpeed, Math.max(speed, boosted)) / speed;
      this.velocity.x *= s;
      this.velocity.z *= s;
      this.slideBoostCooldown = S.boostCooldown;
    }
    this.slideTime = 0;
    this._sprinting = false;
    this.setState('slide');
    this.events.emit('player:slideStart', { speed: this.intendedSpeed(), position: this.position });
  }

  private endSlide(next: MovementState): void {
    this.events.emit('player:slideEnd', EMPTY_PAYLOAD);
    this.setState(next);
  }

  private shouldAutoMantle(): boolean {
    return (
      this._state === 'air' &&
      this.mantleCooldown <= 0 &&
      this.moveInput.y >= M.forwardInputThreshold &&
      this.velocity.y <= M.autoMaxRiseSpeed
    );
  }

  /**
   * Walkable ledge top `ahead` meters in front of the capsule axis (down ray from above
   * maxHeight), or NaN. A hit at distance ~0 means the probe started inside geometry (a wall
   * taller than maxHeight).
   */
  private probeLedgeTop(fx: number, fz: number, ahead: number, top: number, minH: number): number {
    const p = this.position;
    _origin.x = p.x + fx * ahead;
    _origin.y = p.y + top;
    _origin.z = p.z + fz * ahead;
    const hit = this.physics.raycast(_origin, _down, top - minH, this.probeOpts);
    if (!hit || hit.distance < MOVE_EPS || hit.normal.y < WALKABLE_COS) return Number.NaN;
    return hit.point.y;
  }

  /** Distance from the capsule axis to a steep face ahead, `height` above the feet, or NaN. */
  private probeFace(fx: number, fz: number, height: number, reach: number): number {
    const p = this.position;
    _origin.x = p.x;
    _origin.y = p.y + height;
    _origin.z = p.z;
    _dir.x = fx;
    _dir.y = 0;
    _dir.z = fz;
    const hit = this.physics.raycast(_origin, _dir, reach, this.probeOpts);
    if (!hit || Math.abs(hit.normal.y) > M.maxWallNormalY) return Number.NaN;
    return hit.distance;
  }

  /** Walkable ground within `distance` below the feet? */
  private groundWithin(distance: number): boolean {
    _origin.x = this.position.x;
    _origin.y = this.position.y + C.skin * 2;
    _origin.z = this.position.z;
    const hit = this.physics.raycast(_origin, _down, distance + C.skin * 2, this.probeOpts);
    return hit !== null && hit.normal.y >= WALKABLE_COS;
  }

  /**
   * Probe for a mantleable ledge in the look direction and start the mantle if the standing
   * capsule can get onto it. Face first (a low forward ray, then the ledge top just behind the
   * face: finds thin walls and railings → vault); otherwise top first (down ray at full reach,
   * then the face below it: overhangs). Finally the standing capsule is swept from the top of
   * the vertical phase to the target (and, when crouched, up through the vertical phase), so a
   * mantle can never pass through a wall or ceiling.
   */
  private tryMantle(): boolean {
    if (this.mantleCooldown > 0) return false;
    const p = this.position;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const grounded = this._grounded;
    const minH = grounded ? M.minHeight : M.airMinHeight;
    const reach = R + M.reach;
    const top = M.maxHeight + M.probeUpMargin;

    let faceDist = this.probeFace(fx, fz, Math.min(M.faceProbeLow, minH * M.faceProbeHeightFraction), reach);
    let ledgeY = Number.isNaN(faceDist)
      ? Number.NaN
      : this.probeLedgeTop(fx, fz, faceDist + M.ledgeInset, top, minH);
    if (Number.isNaN(ledgeY)) {
      ledgeY = this.probeLedgeTop(fx, fz, reach, top, minH);
      if (Number.isNaN(ledgeY)) return false;
      const h = ledgeY - p.y;
      faceDist = this.probeFace(fx, fz, Math.max(h - M.faceProbeBelow, h * M.faceProbeHeightFraction), reach);
      if (Number.isNaN(faceDist)) return false;
    }
    const ledgeH = ledgeY - p.y;
    if (!ledgeHeightOk(ledgeH, grounded, M)) return false;
    // Airborne over stairs: a step-sized ledge with ground right below is a landing, not a mantle.
    if (!grounded && ledgeH < G.stepHeight && this.groundWithin(G.stepHeight)) return false;

    const forwardDist = faceDist + M.forwardOffset;
    const targetX = p.x + fx * forwardDist;
    const targetY = ledgeY + M.clearanceLift;
    const targetZ = p.z + fz * forwardDist;
    if (!this.standingFits(targetX, targetY, targetZ)) return false;
    // Horizontal phase: sweep the standing capsule from above the start point to the target
    // (also rejects a blocked top of the vertical phase: a cast starting in contact hits at 0).
    _shapePos.x = p.x;
    _shapePos.y = targetY + STAND_HALF + R;
    _shapePos.z = p.z;
    _dir.x = fx;
    _dir.y = 0;
    _dir.z = fz;
    const block = this.physics.castShape(
      this.standTestShape,
      _shapePos,
      null,
      _dir,
      forwardDist,
      PROBE_GROUPS,
      this.collider,
      this.body,
    );
    if (block >= 0) return false;
    // Vertical phase when crouched: the band between the crouched head and the target height
    // above the start is not covered by the current capsule, so sweep the standing one up
    // through it (a start pose without headroom hits at 0).
    if (this._crouched) {
      _shapePos.x = p.x;
      _shapePos.y = p.y + C.headroomTestLift + STAND_HALF + R;
      _shapePos.z = p.z;
      _dir.x = 0;
      _dir.y = 1;
      _dir.z = 0;
      const up = this.physics.castShape(
        this.standTestShape,
        _shapePos,
        null,
        _dir,
        Math.max(0, targetY - p.y - C.headroomTestLift),
        PROBE_GROUPS,
        this.collider,
        this.body,
      );
      if (up >= 0) return false;
    }

    this.mantleStart.copy(p);
    this.mantleEnd.set(targetX, targetY, targetZ);
    this.mantleDir.x = fx;
    this.mantleDir.z = fz;
    this.mantleDur = mantleDuration(ledgeH, M.maxHeight, M.duration, M.minDurationFraction);
    this.mantleT = 0;
    this.mantleExitSpeed = Math.max(
      M.exitSpeed,
      (this.velocity.x * fx + this.velocity.z * fz) * M.exitMomentumKeep,
    );
    if (this._state === 'slide') this.events.emit('player:slideEnd', EMPTY_PAYLOAD);
    // Clearance of the whole path was verified for the standing capsule; stand up without a headroom test.
    if (this._crouched) this.setCrouched(false);
    this.velocity.set(0, 0, 0);
    this.jumpBuffer = 0;
    this.jumpActive = false;
    this.setState('mantle');
    this.events.emit('player:mantle', { height: ledgeH, position: this.position });
    return true;
  }

  private standingFits(x: number, feetY: number, z: number): boolean {
    _shapePos.x = x;
    _shapePos.y = feetY + STAND_HALF + R;
    _shapePos.z = z;
    return (
      this.physics.intersectShape(
        this.standTestShape,
        _shapePos,
        null,
        PROBE_GROUPS,
        this.collider,
        this.body,
      ) === null
    );
  }

  // -------------------------------------------------------------------------
  // State physics
  // -------------------------------------------------------------------------

  private tickState(dt: number): void {
    switch (this._state) {
      case 'ground':
        this.tickGround(dt);
        break;
      case 'slide':
        this.tickSlide(dt);
        break;
      case 'dash':
        this.tickDash(dt);
        break;
      default:
        this.tickAir(dt);
        break;
    }
  }

  private tickGround(dt: number): void {
    applyFriction(this.velocity, G.friction, G.stopSpeed, dt);
    accelerate(this.velocity, this.wishDir, this.groundWishSpeed(), G.acceleration, dt);
    this.integrateGravity(dt, A.gravity);
  }

  private tickAir(dt: number): void {
    airAccelerate(
      this.velocity,
      this.wishDir,
      this.groundWishSpeed(),
      A.wishSpeedCap,
      A.acceleration,
      dt,
      A.maxAirStrafeSpeed,
    );
    if (this.wishMag > 0) steerTowards(this.velocity, this.wishDir, A.airControl * this.wishMag, dt);
    if (this.jumpActive && this.velocity.y <= 0) this.jumpActive = false;
    this.jumpRiseTime += dt;
    const cutAllowed = this.jumpActive && this.jumpRiseTime > J.minCutTime;
    this.integrateGravity(dt, effectiveGravity(this.velocity.y, cutAllowed, this.jumpHeld, A));
  }

  private tickSlide(dt: number): void {
    applyLinearFriction(this.velocity, S.deceleration, dt);
    slopeAcceleration(this.groundNormal, A.gravity * S.slopeAccelMultiplier, _slope);
    this.velocity.x += _slope.x * dt;
    this.velocity.z += _slope.z * dt;
    const downhill = _slope.x * this.velocity.x + _slope.z * this.velocity.z > 0;
    // Sliding down a real slope keeps the slide going (duration limit paused).
    if (!(downhill && slopeAngle(this.groundNormal) >= SLIDE_EXTEND_MIN_RAD)) this.slideTime += dt;
    if (this.wishMag > 0) steerTowards(this.velocity, this.wishDir, S.steer * this.wishMag, dt);
    clampHorizontalSpeed(this.velocity, S.maxSpeed);
    this.integrateGravity(dt, A.gravity);
  }

  private tickDash(dt: number): void {
    this.dashTime += dt;
    if (this.dashTime > D.duration) {
      this.finishDash();
      this.tickState(dt);
      return;
    }
    this.velocity.x = this.dashDir.x * D.speed;
    this.velocity.z = this.dashDir.z * D.speed;
    if (D.suspendGravity) {
      this.velocity.y = 0;
      this.dy = 0;
    } else {
      this.integrateGravity(dt, A.gravity);
    }
  }

  /** Leave the dash with the exit speed; slide straight into it if crouch is held on the ground. */
  private finishDash(): void {
    const exit = D.speed * D.exitSpeedFraction;
    this.velocity.x = this.dashDir.x * exit;
    this.velocity.z = this.dashDir.z * exit;
    if (!this._grounded) this.setState('air');
    else if (this.crouchWanted && exit >= S.minStartSpeed) this.startSlide();
    else this.setState('ground');
  }

  private integrateGravity(dt: number, gravity: number): void {
    integrateVertical(this.velocity.y, gravity, A.terminalVelocity, dt, _vstep);
    this.dy = _vstep.dy;
    this.velocity.y = _vstep.vy;
  }

  private tickMantle(dt: number): void {
    this.mantleT += dt / Math.max(this.mantleDur, 1e-3);
    const t = Math.min(1, this.mantleT);
    mantleCurve(t, M.upPortion, M.forwardStart, _curve);
    const s = this.mantleStart;
    const e = this.mantleEnd;
    const nx = lerp(s.x, e.x, _curve.horizontal);
    const ny = lerp(s.y, e.y, _curve.vertical);
    const nz = lerp(s.z, e.z, _curve.horizontal);
    const inv = 1 / dt;
    this.velocity.set(
      (nx - this.position.x) * inv,
      (ny - this.position.y) * inv,
      (nz - this.position.z) * inv,
    );
    this.actualVelocity.copy(this.velocity);
    this.position.set(nx, ny, nz);
    this.body.setNextKinematicTranslation(this.position);
    if (t >= 1) {
      this.velocity.set(this.mantleDir.x * this.mantleExitSpeed, 0, this.mantleDir.z * this.mantleExitSpeed);
      // The eased end of the curve is slow; the exit speed is the motion the next tick continues.
      this.actualVelocity.copy(this.velocity);
      this._grounded = true;
      this.timeSinceGrounded = 0;
      this.jumpedSinceGrounded = false;
      this.doubleJumpUsed = false;
      this.mantleCooldown = M.cooldown;
      this.setState('ground');
    }
  }

  private tickNoclip(dt: number): void {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const up = (this.jumpHeld ? 1 : 0) - (this.crouchHeld ? 1 : 0);
    let vx = -sy * cp * this.moveInput.y + cy * this.moveInput.x;
    let vy = sp * this.moveInput.y + up;
    let vz = -cy * cp * this.moveInput.y - sy * this.moveInput.x;
    const len = Math.hypot(vx, vy, vz);
    if (len > 1) {
      vx /= len;
      vy /= len;
      vz /= len;
    }
    const speed = MOVEMENT.noclip.speed * (this.sprintHeld ? MOVEMENT.noclip.fastMultiplier : 1);
    this.velocity.set(vx * speed, vy * speed, vz * speed);
    this.actualVelocity.copy(this.velocity);
    this.position.addScaledVector(this.velocity, dt);
    this.body.setNextKinematicTranslation(this.position);
  }

  // -------------------------------------------------------------------------
  // Collision resolution
  // -------------------------------------------------------------------------

  private moveAndCollide(dt: number): void {
    const vel = this.velocity;
    _desired.x = vel.x * dt;
    _desired.y = this.dy;
    _desired.z = vel.z * dt;

    const wantSnap = vel.y <= 0 && !this.jumpedThisTick;
    if (wantSnap !== this.snapEnabled) {
      if (wantSnap) this.kcc.enableSnapToGround(G.snapToGround);
      else this.kcc.disableSnapToGround();
      this.snapEnabled = wantSnap;
    }

    this.kcc.computeColliderMovement(
      this.collider,
      _desired,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      MOVE_GROUPS,
    );
    this.kcc.computedMovement(_moved);
    const mayGround = vel.y <= 0 && !this.jumpedThisTick;
    let groundedNow = mayGround && this.kcc.computedGrounded();
    // Something below stopped (part of) the fall this tick.
    const fallBlocked = _desired.y < 0 && _moved.y > _desired.y + MOVE_EPS;

    const impactSpeed = -vel.y;
    const wasGrounded = this._grounded;
    // Height change the previous ground plane predicts for this horizontal move (for stairs).
    const n = this.groundNormal;
    const expectedDy = n.y > 1e-3 ? -(n.x * _moved.x + n.z * _moved.z) / n.y : 0;

    // Remove velocity into obstacles that actually stopped part of this move, so momentum never
    // "sticks" or hides inside geometry and PlayerApi.velocity stays honest (slide checks, HUD, AI).
    // A step the controller climbed did not block the move (moved·n == desired·n) and is left
    // alone. Walls are clipped horizontally only – a 3D clip against a step edge would convert
    // forward speed into an upward launch – except that a fall onto a steep slope becomes a slide
    // along it. Dynamic props are pushed instead of clipped.
    let supportNy = -2;
    let normalCount = 0;
    const count = this.kcc.numComputedCollisions();
    for (let i = 0; i < count; i++) {
      const c = this.kcc.computedCollision(i, this.collision);
      if (!c || !c.collider) continue;
      const nrm = c.normal1;
      if (nrm.y > supportNy) {
        supportNy = nrm.y;
        _support.x = nrm.x;
        _support.y = nrm.y;
        _support.z = nrm.z;
      }
      normalCount = addUniqueNormal(_contactNormals, normalCount, nrm, SAME_NORMAL_DOT);
      const parent = c.collider.parent();
      if (parent && parent.isDynamic()) continue;
      if (nrm.y >= WALKABLE_COS) continue;
      if (nrm.y <= -WALKABLE_COS || (nrm.y > 0 && vel.y < 0)) {
        // Ceilings, and falls onto steep slopes: 3D clip if the surface stopped the move.
        const into = _desired.x * nrm.x + _desired.y * nrm.y + _desired.z * nrm.z;
        const got = _moved.x * nrm.x + _moved.y * nrm.y + _moved.z * nrm.z;
        const vn = vel.x * nrm.x + vel.y * nrm.y + vel.z * nrm.z;
        const blocked = into < -MOVE_EPS && got > into + MOVE_EPS;
        // A steep slope may turn a fall into a slide but must never launch upwards.
        if (blocked && (nrm.y < 0 || (vn < 0 && vel.y - nrm.y * vn <= 0))) {
          clipVelocity(vel, nrm);
          continue;
        }
        if (nrm.y < 0) continue;
      }
      // Walls: horizontal clip, only if the horizontal move into the wall was stopped (riding
      // up over a step nosing on the rounded capsule bottom keeps the full horizontal move).
      const hl = Math.hypot(nrm.x, nrm.z);
      if (hl < MOVE_EPS) continue;
      _wallN.x = nrm.x / hl;
      _wallN.z = nrm.z / hl;
      const intoH = _desired.x * _wallN.x + _desired.z * _wallN.z;
      if (intoH >= -MOVE_EPS) continue;
      if (_moved.x * _wallN.x + _moved.z * _wallN.z <= intoH + MOVE_EPS) continue;
      clipVelocity(vel, _wallN);
    }
    // Head bump: blocked while moving up.
    if (vel.y > 0 && _desired.y > 0 && _moved.y < _desired.y - MOVE_EPS) vel.y = Math.max(0, _moved.y / dt);

    this.position.x += _moved.x;
    this.position.y += _moved.y;
    this.position.z += _moved.z;
    this.body.setNextKinematicTranslation(this.position);
    const invDt = 1 / dt;
    this.actualVelocity.set(_moved.x * invDt, _moved.y * invDt, _moved.z * invDt);

    // Resting on an edge/ridge Rapier does not report as ground, with a walkable contact normal.
    if (!groundedNow && mayGround && fallBlocked && supportNy >= WALKABLE_COS) groundedNow = true;
    if (groundedNow) {
      // Rapier reports "grounded" on almost any slope; steeper than walkable counts as air so
      // gravity slides us down. The axis ray misses on steep slopes and ledge corners (the
      // capsule rests on its rounded side), then the most upward contact normal decides.
      if (this.probeGround()) {
        if (this.groundNormal.y < WALKABLE_COS) groundedNow = false;
      } else if (supportNy > -2) {
        if (supportNy < WALKABLE_COS) groundedNow = false;
        else {
          this.groundNormal.x = _support.x;
          this.groundNormal.y = _support.y;
          this.groundNormal.z = _support.z;
        }
      }
    }
    // Wedged between faces that are each too steep (V crevice, steep slope into a wall): two
    // contacts together can hold the capsule up like walkable ground.
    if (
      !groundedNow &&
      mayGround &&
      fallBlocked &&
      pairSupportNormal(_contactNormals, normalCount, _pairSupport) >= WALKABLE_COS
    ) {
      groundedNow = true;
      this.groundNormal.x = _pairSupport.x;
      this.groundNormal.y = _pairSupport.y;
      this.groundNormal.z = _pairSupport.z;
    }
    if (!groundedNow) {
      this.groundNormal.x = 0;
      this.groundNormal.y = 1;
      this.groundNormal.z = 0;
      // Airborne but held up (steep slope, edge): the fall speed must not keep building up to
      // terminal velocity and then land as a fake heavy impact.
      if (fallBlocked && vel.y < 0) vel.y = Math.min(0, Math.max(vel.y, _moved.y * invDt));
    }
    if (groundedNow && vel.y < 0) vel.y = 0;

    // Stair smoothing: absorb vertical pops the ground plane did not predict.
    if (wasGrounded && groundedNow && this._state !== 'air') {
      const surprise = _moved.y - expectedDy;
      if (Math.abs(surprise) > C.stepSmoothMinDelta) {
        const before = this.stepOffset;
        this.stepOffset = clamp(before - surprise, -C.stepSmoothMax, C.stepSmoothMax);
        // Keep the absorbed pop out of the render interpolation too, otherwise the lerped feet
        // show only part of it while the offset already cancels all of it (eye moves the wrong way).
        this.prevFeet.y += before - this.stepOffset;
      }
    }

    this._grounded = groundedNow;
    if (groundedNow) {
      this.timeSinceGrounded = 0;
      if (!wasGrounded) this.onLand(impactSpeed);
    } else {
      this.timeSinceGrounded += dt;
      if (this._state === 'ground') this.setState('air');
      else if (this._state === 'slide') this.endSlide('air');
    }

    if (this._state === 'slide') {
      if (this.intendedSpeed() < S.minSpeed || this.slideTime > S.maxDuration || !this.crouchWanted)
        this.endSlide('ground');
    }

    this.updateFootsteps(dt);
  }

  /**
   * Downward probe along the capsule axis: updates ground normal + surface. Returns true on hit.
   * Starts at the lower hemisphere center (never inside the ground, even on steep slopes where
   * the surface under the axis lies well below the feet).
   */
  private probeGround(): boolean {
    _origin.x = this.position.x;
    _origin.y = this.position.y + R;
    _origin.z = this.position.z;
    const hit = this.physics.raycast(_origin, _down, R + G.groundProbeDistance, this.probeOpts);
    if (!hit) {
      this.groundNormal.x = 0;
      this.groundNormal.y = 1;
      this.groundNormal.z = 0;
      return false;
    }
    this.groundNormal.x = hit.normal.x;
    this.groundNormal.y = hit.normal.y;
    this.groundNormal.z = hit.normal.z;
    this.groundSurface = hit.data?.surface ?? 'default';
    return true;
  }

  private onLand(impactSpeed: number): void {
    this.jumpedSinceGrounded = false;
    this.doubleJumpUsed = false;
    this.jumpActive = false;
    classifyLanding(
      impactSpeed,
      MOVEMENT.landing.minImpactSpeed,
      MOVEMENT.landing.heavyImpactSpeed,
      _landing,
    );
    if (_landing.emit) {
      this.events.emit('player:land', {
        impactSpeed,
        heavy: _landing.heavy,
        position: this.position,
        surface: this.groundSurface,
      });
      if (_landing.heavy) this.events.emit('camera:shake', { trauma: CAMERA.shake.traumaHeavyLanding });
    }
    if (this._state === 'air') {
      if (this.crouchWanted && this.intendedSpeed() >= S.minStartSpeed) this.startSlide();
      else this.setState('ground');
    }
  }

  private updateFootsteps(dt: number): void {
    if (this._state !== 'ground' || !this._grounded) return;
    const dist = Math.hypot(_moved.x, _moved.z);
    const speed = dist / dt;
    if (speed < F.minSpeed) return;
    const stride = this._crouched ? F.strideCrouch : this._sprinting ? F.strideSprint : F.strideRun;
    if (advanceGait(this.gait, dist, stride) > 0) {
      this.events.emit('player:footstep', {
        position: this.position,
        speed,
        sprinting: this._sprinting,
        crouched: this._crouched,
        surface: this.groundSurface,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Crouch collider
  // -------------------------------------------------------------------------

  private applyCrouchCollider(): void {
    const want = this.crouchWanted || this._state === 'slide';
    if (want && !this._crouched) this.setCrouched(true);
    else if (!want && this._crouched && this.hasHeadroom()) this.setCrouched(false);
  }

  private hasHeadroom(): boolean {
    return this.standingFits(this.position.x, this.position.y + C.headroomTestLift, this.position.z);
  }

  /** Resize the capsule keeping the feet planted (body origin = feet). */
  private setCrouched(crouched: boolean): void {
    const half = crouched ? CROUCH_HALF : STAND_HALF;
    this.collider.setHalfHeight(half);
    this.collider.setTranslationWrtParent({ x: 0, y: half + R, z: 0 });
    this.syncColliderPose();
    this._crouched = crouched;
    this.events.emit('player:crouch', { crouched });
  }

  /** Rapier only propagates body→collider poses during a step; sync now for same-tick queries. */
  private syncColliderPose(): void {
    const half = this.collider.halfHeight();
    _shapePos.x = this.position.x;
    _shapePos.y = this.position.y + half + R;
    _shapePos.z = this.position.z;
    this.collider.setTranslation(_shapePos);
  }

  // -------------------------------------------------------------------------
  // Misc
  // -------------------------------------------------------------------------

  private isMantling(): boolean {
    return this._state === 'mantle';
  }

  private setState(to: MovementState): void {
    if (to === this._state) return;
    const from = this._state;
    this._state = to;
    this._stateTime = 0;
    this.events.emit('player:stateChanged', { from, to });
  }

  private place(p: Vec3Like, yaw?: number): void {
    this.position.set(p.x, p.y + C.spawnLift, p.z);
    this.prevFeet.copy(this.position);
    this.body.setTranslation(this.position, true);
    this.body.setNextKinematicTranslation(this.position);
    this.syncColliderPose();
    this.velocity.set(0, 0, 0);
    this.actualVelocity.set(0, 0, 0);
    if (yaw !== undefined) this.yaw = yaw;
    this._grounded = false;
    this.timeSinceGrounded = Number.POSITIVE_INFINITY;
    this.jumpBuffer = 0;
    this.jumpActive = false;
    this.stepOffset = 0;
    if (this._state === 'slide') this.events.emit('player:slideEnd', EMPTY_PAYLOAD);
    this.setState(this._noclip ? 'noclip' : 'air');
    this.eyePosition.copy(this.position);
    this.eyePosition.y += this.eyeHeight;
  }

  teleport(position: Vec3Like, yaw?: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
      log.warn('teleport ignored: non-finite position');
      return;
    }
    this.place(position, yaw !== undefined && Number.isFinite(yaw) ? yaw : undefined);
    this.events.emit('player:teleported', { position: this.position });
    log.debug(`teleported to ${position.x.toFixed(2)} ${position.y.toFixed(2)} ${position.z.toFixed(2)}`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.physics.disposed) return;
    this.physics.world.removeCharacterController(this.kcc);
    this.physics.removeBody(this.body);
  }
}
