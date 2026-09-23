/**
 * First-person viewmodel rig, parented to `render.viewmodelCamera` (drawn in the separate
 * viewmodel scene/pass, so it never clips into walls and is not fogged/blurred).
 *
 * Hierarchy: viewmodelCamera → lightRig (key + core light, fixed to the view)
 *                            → root (offset, sway, bob, poses) → slot → model
 * The model is the procedural placeholder until `setModel()` swaps it (M2 weapons).
 * Light count never changes with the model, so swapping models does not recompile shaders.
 */
import { DirectionalLight, Group, Object3D, PointLight } from 'three';
import type { RenderApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { DEG2RAD, clamp, damp, lerp, type SpringState } from '../core/math';
import { CAMERA, VIEWMODEL } from '../defs/camera';
import { ENGINE } from '../defs/engine';
import { MOVEMENT } from '../defs/movement';
import { springImpulseForPeak, stepSpringSubstepped } from './cameraMath';
import type { PlayerCamera } from './PlayerCamera';
import type { PlayerController } from './PlayerController';
import {
  PLACEHOLDER_CORE_POSITION,
  createPlaceholderDevice,
  type PlaceholderDevice,
} from './viewmodelPlaceholder';

export interface ViewmodelRigDeps {
  render: RenderApi;
  player: PlayerController;
  camera: PlayerCamera;
  events: EventBus<GameEvents>;
}

const SW = VIEWMODEL.sway;
const MAX_ROT = SW.maxRotationDeg * DEG2RAD;
const SWAY_OMEGA = Math.sqrt(SW.stiffness);
const KICK = VIEWMODEL.kickSpring;

function spring(): SpringState {
  return { value: 0, velocity: 0 };
}

/** Clamp a spring's value and drop velocity pushing further out (no sticky clamp). */
function clampSpring(s: SpringState, max: number): void {
  if (s.value > max) {
    s.value = max;
    if (s.velocity > 0) s.velocity = 0;
  } else if (s.value < -max) {
    s.value = -max;
    if (s.velocity < 0) s.velocity = 0;
  }
}

/** Enable the viewmodel layer (keeping layer 0) and disable shadows/culling on a subtree. */
function prepareViewmodelObject(obj: Object3D): void {
  obj.traverse((o) => {
    o.layers.enable(ENGINE.viewmodelLayer);
    o.castShadow = false;
    o.receiveShadow = false;
    o.frustumCulled = false;
  });
}

export class ViewmodelRig {
  /** Rig root: offset + procedural motion. */
  readonly root = new Group();
  private readonly slot = new Group();
  private readonly lightRig = new Group();
  private readonly keyLight: DirectionalLight;
  private readonly coreLight: PointLight;
  private readonly render: RenderApi;
  private readonly player: PlayerController;
  private readonly camera: PlayerCamera;
  private readonly placeholder: PlaceholderDevice;
  private model: Object3D;
  private readonly unsubscribers: (() => void)[] = [];

  private readonly swayX = spring();
  private readonly swayY = spring();
  private readonly swayYaw = spring();
  private readonly swayPitch = spring();
  private readonly swaySprings: readonly SpringState[] = [
    this.swayX,
    this.swayY,
    this.swayYaw,
    this.swayPitch,
  ];
  private readonly kickY = spring();
  private readonly kickZ = spring();
  private moveX = 0;
  private moveZ = 0;
  private moveRoll = 0;
  private lowerBlend = 0;
  private slideBlend = 0;
  private crouchBlend = 0;
  private time = 0;
  private flare = 0;
  private disposed = false;

  constructor(deps: ViewmodelRigDeps) {
    this.render = deps.render;
    this.player = deps.player;
    this.camera = deps.camera;

    const vmCam = this.render.viewmodelCamera;
    // Children of a camera are only rendered if the camera is part of the scene graph.
    if (!vmCam.parent) this.render.viewmodelScene.add(vmCam);

    this.root.name = 'viewmodel-root';
    this.root.position.set(VIEWMODEL.offset.x, VIEWMODEL.offset.y, VIEWMODEL.offset.z);
    this.root.add(this.slot);
    vmCam.add(this.root);

    const L = VIEWMODEL.lights;
    this.keyLight = new DirectionalLight(L.keyColor, L.keyIntensity);
    this.keyLight.position.set(L.keyPosition.x, L.keyPosition.y, L.keyPosition.z);
    const keyTarget = new Object3D();
    keyTarget.position.set(VIEWMODEL.offset.x, VIEWMODEL.offset.y, VIEWMODEL.offset.z);
    this.keyLight.target = keyTarget;
    this.coreLight = new PointLight(L.coreLightColor, L.coreLightIntensity, L.coreLightDistance);
    this.coreLight.position.set(
      VIEWMODEL.offset.x + PLACEHOLDER_CORE_POSITION.x,
      VIEWMODEL.offset.y + PLACEHOLDER_CORE_POSITION.y,
      VIEWMODEL.offset.z + PLACEHOLDER_CORE_POSITION.z,
    );
    this.lightRig.name = 'viewmodel-lights';
    this.lightRig.add(this.keyLight, keyTarget, this.coreLight);
    prepareViewmodelObject(this.lightRig);
    vmCam.add(this.lightRig);

    this.placeholder = createPlaceholderDevice();
    this.model = this.placeholder.root;
    prepareViewmodelObject(this.model);
    this.slot.add(this.model);

    this.unsubscribers.push(
      deps.events.on('player:land', (e) => {
        const kick = Math.min(e.impactSpeed * VIEWMODEL.landingKickPerSpeed, VIEWMODEL.maxLandingKick);
        this.kickY.velocity -= springImpulseForPeak(kick, KICK.stiffness);
      }),
      deps.events.on('player:jump', () => {
        this.kickY.velocity -= VIEWMODEL.jumpKick;
      }),
      deps.events.on('player:dash', () => {
        this.kickZ.velocity += VIEWMODEL.dashKick;
        this.flare = VIEWMODEL.glow.dashFlare;
      }),
    );
  }

  /** The currently displayed model (placeholder until replaced). */
  get currentModel(): Object3D {
    return this.model;
  }

  /**
   * Replace the displayed model (M2 weapons). The rig does not take ownership: the caller
   * disposes its own model. Pass null to restore the placeholder.
   */
  setModel(object: Object3D | null): void {
    const next = object ?? this.placeholder.root;
    if (next === this.model) return;
    this.slot.remove(this.model);
    prepareViewmodelObject(next);
    this.slot.add(next);
    this.model = next;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  update(dt: number): void {
    if (this.disposed || dt <= 0) return;
    this.time += dt;
    const player = this.player;
    const cam = this.camera;
    const ads = player.adsAmount;
    const motionScale = lerp(1, SW.adsScale, ads);
    const maxStep = CAMERA.maxSpringStep;

    // --- look sway: impulses proportional to the look delta (frame-rate independent). The device
    // lags behind the view: turning left shifts it right and points the muzzle right. ---
    const ld = cam.lookDelta;
    this.swayX.velocity += ld.yaw * SW.positionPerRad * SWAY_OMEGA;
    this.swayY.velocity -= ld.pitch * SW.positionPerRad * SWAY_OMEGA;
    this.swayYaw.velocity -= ld.yaw * SW.rotationPerRad * SWAY_OMEGA;
    this.swayPitch.velocity -= ld.pitch * SW.rotationPerRad * SWAY_OMEGA;
    for (const s of this.swaySprings) stepSpringSubstepped(s, 0, SW.stiffness, SW.damping, dt, maxStep);
    clampSpring(this.swayX, SW.maxPosition);
    clampSpring(this.swayY, SW.maxPosition);
    clampSpring(this.swayYaw, MAX_ROT);
    clampSpring(this.swayPitch, MAX_ROT);

    // --- movement inertia (view-space velocity) ---
    const MS = VIEWMODEL.moveSway;
    const v = player.actualVelocity;
    const cosY = Math.cos(player.yaw);
    const sinY = Math.sin(player.yaw);
    const side = v.x * cosY - v.z * sinY;
    const fwd = -v.x * sinY - v.z * cosY;
    this.moveX = damp(
      this.moveX,
      clamp(-side * MS.lateralPerSpeed, -MS.maxLateral, MS.maxLateral),
      MS.lambda,
      dt,
    );
    this.moveZ = damp(
      this.moveZ,
      clamp(fwd * MS.forwardPerSpeed, -MS.maxForward, MS.maxForward),
      MS.lambda,
      dt,
    );
    const maxMoveRoll = MS.maxRollDeg * DEG2RAD;
    this.moveRoll = damp(
      this.moveRoll,
      clamp(-side * MS.rollDegPerSpeed * DEG2RAD, -maxMoveRoll, maxMoveRoll),
      MS.lambda,
      dt,
    );

    // --- kicks (landing / jump / dash) ---
    stepSpringSubstepped(this.kickY, 0, KICK.stiffness, KICK.damping, dt, maxStep);
    stepSpringSubstepped(this.kickZ, 0, KICK.stiffness, KICK.damping, dt, maxStep);

    // --- poses ---
    const state = player.state;
    const lowerTarget =
      player.sprinting && player.grounded && player.horizontalSpeed > MOVEMENT.ground.runSpeed ? 1 : 0;
    this.lowerBlend = damp(this.lowerBlend, lowerTarget, VIEWMODEL.poseLambda, dt);
    this.slideBlend = damp(this.slideBlend, state === 'slide' ? 1 : 0, VIEWMODEL.poseLambda, dt);
    this.crouchBlend = damp(
      this.crouchBlend,
      player.crouched && state !== 'slide' ? 1 : 0,
      VIEWMODEL.poseLambda,
      dt,
    );
    const lower = Math.max(this.lowerBlend, this.slideBlend) * (1 - ads);

    // --- bob synced to the camera gait phase (figure-8) + idle breathing ---
    const phase = cam.bobPhase;
    const bob = cam.bobIntensity * motionScale;
    const bobX = Math.sin(phase) * VIEWMODEL.bob.horizontalAmplitude * bob;
    const bobY = Math.cos(2 * phase) * VIEWMODEL.bob.verticalAmplitude * bob;
    const bobRoll = Math.sin(phase) * VIEWMODEL.bob.rollDeg * DEG2RAD * bob;
    const br = VIEWMODEL.breathing;
    const breath = Math.sin(this.time * br.rate) * motionScale;

    // --- compose ---
    const O = VIEWMODEL.offset;
    const AO = VIEWMODEL.adsOffset;
    const sway = motionScale;
    const px = lerp(O.x, AO.x, ads) + (this.swayX.value + this.moveX) * sway + bobX;
    const py =
      lerp(O.y, AO.y, ads) +
      this.swayY.value * sway +
      bobY +
      breath * br.amplitude +
      this.kickY.value +
      VIEWMODEL.sprintLower.y * lower +
      VIEWMODEL.crouchOffset.y * this.crouchBlend;
    const pz = lerp(O.z, AO.z, ads) + this.kickZ.value + this.moveZ * sway;
    this.root.position.set(px, py, pz);

    const pitch =
      this.swayPitch.value * sway +
      breath * br.pitchDeg * DEG2RAD +
      this.kickY.value * KICK.pitchDegPerMeter * DEG2RAD +
      VIEWMODEL.sprintLower.pitchDeg * DEG2RAD * lower;
    const yaw =
      this.swayYaw.value * sway + VIEWMODEL.sprintLower.yawDeg * DEG2RAD * this.lowerBlend * (1 - ads);
    const roll =
      (-this.swayYaw.value * SW.rollPerYaw + this.moveRoll) * sway +
      bobRoll +
      VIEWMODEL.slideTiltDeg * DEG2RAD * this.slideBlend +
      VIEWMODEL.crouchOffset.rollDeg * DEG2RAD * this.crouchBlend;
    this.root.rotation.set(pitch, yaw, roll);

    // --- emissive life on the placeholder (uniform updates only, no recompiles) ---
    if (this.model === this.placeholder.root) {
      const g = VIEWMODEL.glow;
      this.flare = damp(this.flare, 0, g.flareDecay, dt);
      const pulse = 1 + g.pulseAmount * Math.sin(this.time * g.pulseRate);
      this.placeholder.coreMaterial.emissiveIntensity = g.coreIntensity * pulse + this.flare;
      this.placeholder.stripMaterial.emissiveIntensity = g.stripIntensity * (0.5 + 0.5 * pulse);
      this.placeholder.screenTexture.offset.x = (this.time * g.screenScroll) % 1;
      this.coreLight.intensity = VIEWMODEL.lights.coreLightIntensity * (pulse + this.flare / g.coreIntensity);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.root.removeFromParent();
    this.lightRig.removeFromParent();
    this.keyLight.dispose();
    this.coreLight.dispose();
    this.placeholder.dispose();
  }
}
