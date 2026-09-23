/**
 * First-person camera rig.
 * - applyLook() (per frame, BEFORE the fixed ticks): applies mouse/gamepad look (ADS-scaled) and
 *   writes `player.yaw/pitch`, so the ticks move along the yaw the camera shows this frame.
 * Per frame in update() (after `player.update`):
 * - places `render.camera` at the interpolated eye position plus feel effects
 *   (head bob, strafe roll, slide tilt, mantle pull-up dip, landing dip spring, trauma shake),
 * - drives FOV (settings FOV is HORIZONTAL at 16:9 → converted to vertical) with kicks,
 * - drives ADS depth of field (ads amount + focus distance from a center ray; the render
 *   system smooths both). The render system itself mirrors the camera rotation onto the
 *   viewmodel camera.
 *
 * Bob/roll/tilt/FOV kicks are scaled by `accessibility.cameraMotion`, shake by `accessibility.screenShake`.
 */
import type { InputApi, LookOut, RaycastOptions, RenderApi, SettingsStore } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { DEG2RAD, clamp, damp, lerp, noise1D, wrapAngle, type SpringState } from '../core/math';
import { CAMERA } from '../defs/camera';
import { MOVEMENT } from '../defs/movement';
import { COLLISION_FILTER, COLLISION_GROUP, interactionGroups } from '../defs/physics';
import { POSTFX } from '../defs/postfx';
import {
  addTrauma,
  decayTrauma,
  horizontalToVerticalFov,
  springImpulseForPeak,
  stepSpringSubstepped,
} from './cameraMath';
import type { PlayerController } from './PlayerController';

const PITCH_LIMIT = CAMERA.pitchLimitDeg * DEG2RAD;
const FOCUS_GROUPS = interactionGroups(COLLISION_GROUP.PLAYER, COLLISION_FILTER.cameraProbe);
/** Distinct noise channels for the shake (arbitrary seeds). */
const SEED_YAW = 11;
const SEED_PITCH = 23;
const SEED_ROLL = 37;
const SEED_X = 51;
const SEED_Y = 67;

const _look: LookOut = { yaw: 0, pitch: 0 };
const _dir = { x: 0, y: 0, z: 0 };

export interface PlayerCameraDeps {
  player: PlayerController;
  input: InputApi;
  render: RenderApi;
  events: EventBus<GameEvents>;
  settings: SettingsStore;
}

export class PlayerCamera {
  /** Look rotation applied this frame (radians). yaw > 0 = turned left (three.js convention), pitch > 0 = up. */
  readonly lookDelta = { yaw: 0, pitch: 0 };

  private readonly player: PlayerController;
  private readonly input: InputApi;
  private readonly render: RenderApi;
  private readonly settings: SettingsStore;
  private readonly focusOpts: RaycastOptions;
  private readonly unsubscribers: (() => void)[] = [];

  private _bobIntensity = 0;
  private strafeRoll = 0;
  private slideTilt = 0;
  private mantleBlend = 0;
  private readonly landSpring: SpringState = { value: 0, velocity: 0 };
  private trauma = 0;
  private time = 0;
  private fovH: number;
  private lastVerticalFov = -1;
  /** applyLook() already ran this frame (update() must not apply the look a second time). */
  private lookApplied = false;
  private focusDistance: number = POSTFX.depthOfField.defaultFocusDistance;
  private _roll = 0;

  constructor(deps: PlayerCameraDeps) {
    this.player = deps.player;
    this.input = deps.input;
    this.render = deps.render;
    this.settings = deps.settings;
    this.focusOpts = { groups: FOCUS_GROUPS, excludeCollider: this.player.collider };
    this.render.camera.rotation.order = 'YXZ';
    this.fovH = this.baseFov();
    this.unsubscribers.push(
      deps.events.on('player:land', (e) => {
        const dip = Math.min(e.impactSpeed * CAMERA.landing.dipPerSpeed, CAMERA.landing.maxDip);
        this.landSpring.velocity -= springImpulseForPeak(
          dip,
          CAMERA.landing.stiffness,
          CAMERA.landing.damping,
        );
      }),
      deps.events.on('camera:shake', (e) => {
        this.trauma = addTrauma(this.trauma, e.trauma);
      }),
    );
  }

  /** Gait phase (radians) the bob is driven by; footsteps land at multiples of PI. */
  get bobPhase(): number {
    return this.player.gaitPhase;
  }
  /** Smoothed bob intensity (0 = still, ~1 = running, higher when sprinting), before accessibility scaling. */
  get bobIntensity(): number {
    return this._bobIntensity;
  }
  /** Accessibility "camera motion" scale (0..1) for bob/roll/tilt/kicks; the viewmodel uses it too. */
  get cameraMotion(): number {
    return this.settings.current.accessibility.cameraMotion;
  }
  /** Current landing dip in meters (negative = down), accessibility-scaled. */
  get landingOffset(): number {
    return this.landSpring.value * this.settings.current.accessibility.cameraMotion;
  }
  /** Total camera roll applied this frame (radians). */
  get roll(): number {
    return this._roll;
  }
  get currentTrauma(): number {
    return this.trauma;
  }
  /** Last ADS focus distance sent to the renderer (m). */
  get currentFocusDistance(): number {
    return this.focusDistance;
  }

  update(dt: number): void {
    const settings = this.settings.current;
    const player = this.player;
    const cam = this.render.camera;
    this.time += dt;
    const motion = settings.accessibility.cameraMotion;
    const ads = player.adsAmount;

    // --- look: normally applied by applyLook() before this frame's ticks ---
    if (!this.lookApplied) this.applyLook();
    this.lookApplied = false;
    if (!Number.isFinite(this.fovH)) this.fovH = this.baseFov();

    // --- head bob (driven by the controller's gait phase) ---
    const state = player.state;
    const speed = player.horizontalSpeed;
    let bobTarget = 0;
    if (state === 'ground' && player.grounded) {
      bobTarget = Math.min(speed / MOVEMENT.ground.runSpeed, CAMERA.bob.maxIntensity);
      if (player.sprinting) bobTarget *= CAMERA.bob.sprintMultiplier;
      else if (player.crouched) bobTarget *= CAMERA.bob.crouchMultiplier;
    }
    bobTarget *= 1 - CAMERA.bob.adsReduction * ads;
    this._bobIntensity = damp(this._bobIntensity, bobTarget, CAMERA.bob.lambda, dt);
    const phase = player.gaitPhase;
    const bob = this._bobIntensity * motion;
    // Lowest point at each footstep (phase = k·PI), sideways sway alternates per step.
    const bobY = -Math.cos(2 * phase) * CAMERA.bob.verticalAmplitude * bob;
    const bobX = Math.sin(phase) * CAMERA.bob.horizontalAmplitude * bob;
    const bobRoll = Math.sin(phase) * CAMERA.bob.rollDeg * DEG2RAD * bob;

    // --- strafe roll + slide tilt ---
    const cosY = Math.cos(player.yaw);
    const sinY = Math.sin(player.yaw);
    const v = player.actualVelocity;
    const side = v.x * cosY - v.z * sinY;
    const rollTarget = -clamp(side / MOVEMENT.ground.runSpeed, -1, 1) * CAMERA.strafeRollDeg * DEG2RAD;
    this.strafeRoll = damp(this.strafeRoll, rollTarget, CAMERA.strafeRollLambda, dt);
    const tiltTarget = state === 'slide' ? CAMERA.slideTiltDeg * DEG2RAD : 0;
    this.slideTilt = damp(this.slideTilt, tiltTarget, CAMERA.slideTiltLambda, dt);
    this.mantleBlend = damp(this.mantleBlend, state === 'mantle' ? 1 : 0, CAMERA.mantle.lambda, dt);

    // --- landing dip spring ---
    stepSpringSubstepped(
      this.landSpring,
      0,
      CAMERA.landing.stiffness,
      CAMERA.landing.damping,
      dt,
      CAMERA.maxSpringStep,
    );
    const dip = this.landSpring.value * motion;

    // --- trauma shake ---
    this.trauma = decayTrauma(this.trauma, CAMERA.shake.decayPerSecond, dt);
    const shake = Math.pow(this.trauma, CAMERA.shake.exponent) * settings.accessibility.screenShake;
    let shakeYaw = 0;
    let shakePitch = 0;
    let shakeRoll = 0;
    let shakeX = 0;
    let shakeY = 0;
    if (shake > 0) {
      const t = this.time * CAMERA.shake.frequency;
      shakeYaw = CAMERA.shake.maxYawDeg * DEG2RAD * shake * noise1D(t, SEED_YAW);
      shakePitch = CAMERA.shake.maxPitchDeg * DEG2RAD * shake * noise1D(t, SEED_PITCH);
      shakeRoll = CAMERA.shake.maxRollDeg * DEG2RAD * shake * noise1D(t, SEED_ROLL);
      shakeX = CAMERA.shake.maxOffset * shake * noise1D(t, SEED_X);
      shakeY = CAMERA.shake.maxOffset * shake * noise1D(t, SEED_Y);
    }

    // --- compose transform ---
    const eye = player.eyePosition;
    const lateral = bobX + shakeX;
    // Right vector for yaw: (cos, 0, -sin).
    cam.position.set(eye.x + cosY * lateral, eye.y + bobY + dip + shakeY, eye.z - sinY * lateral);
    const mantle = this.mantleBlend * motion * DEG2RAD;
    this._roll =
      (bobRoll + this.strafeRoll + this.slideTilt) * motion + mantle * CAMERA.mantle.rollDeg + shakeRoll;
    const pitch =
      player.pitch +
      shakePitch +
      dip * CAMERA.landing.pitchDegPerMeter * DEG2RAD +
      mantle * CAMERA.mantle.pitchDeg;
    cam.rotation.set(pitch, player.yaw + shakeYaw, this._roll);

    // --- FOV (horizontal setting → vertical) ---
    let kick = 0;
    if (state === 'dash') kick = CAMERA.fov.dashKick;
    else if (state === 'slide') kick = CAMERA.fov.slideKick;
    else if (player.sprinting && speed > MOVEMENT.ground.runSpeed) kick = CAMERA.fov.sprintKick;
    const fovTarget = this.baseFov() + kick * motion + CAMERA.fov.adsZoom * ads;
    this.fovH = damp(this.fovH, fovTarget, CAMERA.fov.lambda, dt);
    const vFov = horizontalToVerticalFov(this.fovH, CAMERA.fovReferenceAspect);
    if (Math.abs(vFov - this.lastVerticalFov) > CAMERA.fov.epsilon) {
      this.render.setFov(vFov);
      this.lastVerticalFov = vFov;
    }

    // --- ADS depth of field ---
    this.render.setAdsAmount(ads);
    if (ads > CAMERA.focus.minAds) {
      const cp = Math.cos(player.pitch);
      _dir.x = -sinY * cp;
      _dir.y = Math.sin(player.pitch);
      _dir.z = -cosY * cp;
      const hit = player.physics.raycast(cam.position, _dir, CAMERA.focus.maxDistance, this.focusOpts);
      this.focusDistance = hit ? hit.distance : CAMERA.focus.maxDistance;
      this.render.setFocusDistance(this.focusDistance);
    }
  }

  /**
   * Apply this frame's mouse/gamepad look (ADS-scaled) to `player.yaw/pitch`. Call once per frame
   * right after `input.beginFrame` and before the fixed ticks, so wish/dash/mantle directions use
   * the yaw the camera shows this frame. update() applies it itself when this was not called.
   */
  applyLook(): void {
    const player = this.player;
    // Yaw/pitch accumulate: one NaN (e.g. from a console command) would never recover.
    if (!Number.isFinite(player.yaw)) player.yaw = 0;
    if (!Number.isFinite(player.pitch)) player.pitch = 0;
    this.input.getLook(_look);
    const sens = lerp(1, this.settings.current.controls.adsSensitivityMultiplier, player.adsAmount);
    const prevPitch = player.pitch;
    const dYaw = -_look.yaw * sens;
    player.yaw = wrapAngle(player.yaw + dYaw);
    player.pitch = clamp(player.pitch + _look.pitch * sens, -PITCH_LIMIT, PITCH_LIMIT);
    this.lookDelta.yaw = dYaw;
    this.lookDelta.pitch = player.pitch - prevPitch;
    this.lookApplied = true;
  }

  /**
   * Jump to the FOV setting without damping or movement kicks (settings preview while paused,
   * when update() does not run). The next update() continues from here without a second zoom.
   */
  snapFov(): void {
    this.fovH = this.baseFov() + CAMERA.fov.adsZoom * this.player.adsAmount;
    const vFov = horizontalToVerticalFov(this.fovH, CAMERA.fovReferenceAspect);
    this.render.setFov(vFov);
    this.lastVerticalFov = vFov;
  }

  private baseFov(): number {
    const fov = this.settings.current.controls.fov;
    return Number.isFinite(fov) ? clamp(fov, CAMERA.minFov, CAMERA.maxFov) : CAMERA.defaultFov;
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
  }
}
