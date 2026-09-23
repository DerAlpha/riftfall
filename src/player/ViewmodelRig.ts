/**
 * First-person viewmodel rig, parented to `render.viewmodelCamera` (drawn in the separate
 * viewmodel scene/pass, so it never clips into walls and is not fogged/blurred).
 *
 * Hierarchy: viewmodelCamera → lightRig (key light, fixed to the view)
 *                            → root (offset/ADS, sway, bob, landing, poses + weapon animation translation)
 *                              → pivot (weapon animation rotation around the weapon's balance point)
 *                                → slot (−pivot) → model (+ accent light)
 * The model is the procedural placeholder device while no weapon is equipped. Weapon models
 * (src/weapons/viewmodels) are built on demand, cached per id and driven by the
 * ViewmodelAnimator (weapon:* events). Persistent socket anchors (muzzle / ejectPort / sight)
 * follow whatever model is shown, so effects can attach to them once.
 * Light count never changes with the model, so swapping models does not recompile shaders.
 */
import {
  DirectionalLight,
  Group,
  LinearSRGBColorSpace,
  Object3D,
  PointLight,
  Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import type { RenderApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { createLogger } from '../core/log';
import { DEG2RAD, clamp, damp, lerp, type SpringState } from '../core/math';
import { CAMERA, VIEWMODEL } from '../defs/camera';
import { ENGINE } from '../defs/engine';
import { MOVEMENT } from '../defs/movement';
import { VIEWMODEL_ANIM, type WeaponViewmodelDef } from '../defs/viewmodels';
import { WEAPON_RULES, getWeaponDef } from '../defs/weapons';
import { ViewmodelAnimator } from '../weapons/ViewmodelAnimator';
import {
  WeaponMaterialKit,
  createWeaponViewmodel,
  viewmodelIds,
  type WeaponViewmodelModel,
} from '../weapons/viewmodels';
import { adsOffsetFromSight, mapViewPointBetweenProjections } from '../weapons/viewmodels/socketMath';
import { springImpulseForPeak, stepSpringSubstepped } from './cameraMath';
import type { PlayerCamera } from './PlayerCamera';
import type { PlayerController } from './PlayerController';
import {
  PLACEHOLDER_CORE_POSITION,
  createPlaceholderDevice,
  type PlaceholderDevice,
} from './viewmodelPlaceholder';

const log = createLogger('viewmodel');

export interface ViewmodelRigDeps {
  render: RenderApi;
  player: PlayerController;
  camera: PlayerCamera;
  events: EventBus<GameEvents>;
  /** ADS amount source (the weapon system); defaults to the player's input-driven ADS. */
  ads?: { readonly adsAmount: number };
}

export type ViewmodelSocket = 'muzzle' | 'ejectPort' | 'sight';
const SOCKETS: readonly ViewmodelSocket[] = ['muzzle', 'ejectPort', 'sight'];

const SW = VIEWMODEL.sway;
const MAX_ROT = SW.maxRotationDeg * DEG2RAD;
const SWAY_OMEGA = Math.sqrt(SW.stiffness);
const KICK = VIEWMODEL.kickSpring;
const ML = VIEWMODEL_ANIM.muzzleLight;
/** Below this envelope the muzzle light is switched off (intensity exactly 0). */
const FLASH_EPSILON = 1e-3;

const _v = new Vector3();

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

/** Per-weapon rest poses resolved when a weapon model is shown (radians, meters). */
interface WeaponPose {
  readonly hip: Vector3;
  readonly hipRot: Vector3;
  readonly ads: Vector3;
  readonly sprintPos: Vector3;
  readonly sprintRot: Vector3;
}

/** Model-space position of `obj` inside `root` (walks the local transforms). */
function modelSpacePosition(obj: Object3D, root: Object3D, out: Vector3): Vector3 {
  out.copy(obj.position);
  let p = obj.parent;
  while (p && p !== root) {
    p.updateMatrix();
    out.applyMatrix4(p.matrix);
    p = p.parent;
  }
  return out;
}

function resolveWeaponPose(model: WeaponViewmodelModel): WeaponPose {
  const def: WeaponViewmodelDef = model.def;
  const v = (x = 0, y = 0, z = 0): Vector3 => new Vector3(x, y, z);
  const sight = modelSpacePosition(model.sight, model.root, new Vector3()).multiplyScalar(def.scale ?? 1);
  const r = def.hip.rot;
  const sp = def.sprint.pos;
  const sr = def.sprint.rot;
  return {
    hip: v(def.hip.pos.x, def.hip.pos.y, def.hip.pos.z),
    hipRot: v((r?.x ?? 0) * DEG2RAD, (r?.y ?? 0) * DEG2RAD, (r?.z ?? 0) * DEG2RAD),
    ads: adsOffsetFromSight(sight, def.adsEyeDistance, new Vector3(), def.adsNudge),
    sprintPos: v(sp?.x, sp?.y, sp?.z),
    sprintRot: v((sr?.x ?? 0) * DEG2RAD, (sr?.y ?? 0) * DEG2RAD, (sr?.z ?? 0) * DEG2RAD),
  };
}

export class ViewmodelRig {
  /** Rig root: offset + procedural motion. */
  readonly root = new Group();
  /** Weapon animation rotation pivot (between root and slot). */
  private readonly pivot = new Group();
  private readonly slot = new Group();
  private readonly lightRig = new Group();
  private readonly keyLight: DirectionalLight;
  private readonly coreLight: PointLight;
  private readonly muzzleLight: PointLight;
  private readonly render: RenderApi;
  private readonly player: PlayerController;
  private readonly camera: PlayerCamera;
  private readonly placeholder: PlaceholderDevice;
  private readonly animator: ViewmodelAnimator;
  private adsSource: { readonly adsAmount: number };
  private model: Object3D;
  private weaponModel: WeaponViewmodelModel | null = null;
  /** Weapon id whose model is displayed (model ids may differ from weapon ids later). */
  private shownWeaponId: string | null = null;
  private weaponPose: WeaponPose | null = null;
  private kit: WeaponMaterialKit | null = null;
  private readonly weaponModels = new Map<string, WeaponViewmodelModel>();
  private readonly missingModels = new Set<string>();
  private readonly anchors: Record<ViewmodelSocket, Object3D>;
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
    this.adsSource = deps.ads ?? deps.player;

    const vmCam = this.render.viewmodelCamera;
    // Children of a camera are only rendered if the camera is part of the scene graph.
    if (!vmCam.parent) this.render.viewmodelScene.add(vmCam);

    this.root.name = 'viewmodel-root';
    this.root.position.set(VIEWMODEL.offset.x, VIEWMODEL.offset.y, VIEWMODEL.offset.z);
    this.pivot.name = 'viewmodel-pivot';
    this.slot.name = 'viewmodel-slot';
    this.pivot.add(this.slot);
    this.root.add(this.pivot);
    vmCam.add(this.root);

    const L = VIEWMODEL.lights;
    this.keyLight = new DirectionalLight(L.keyColor, L.keyIntensity);
    this.keyLight.position.set(L.keyPosition.x, L.keyPosition.y, L.keyPosition.z);
    const keyTarget = new Object3D();
    keyTarget.position.set(VIEWMODEL.offset.x, VIEWMODEL.offset.y, VIEWMODEL.offset.z);
    this.keyLight.target = keyTarget;
    this.lightRig.name = 'viewmodel-lights';
    this.lightRig.add(this.keyLight, keyTarget);
    prepareViewmodelObject(this.lightRig);
    vmCam.add(this.lightRig);

    // Accent/core light rides with the model (slot space): spill of the glowing parts.
    this.coreLight = new PointLight(L.coreLightColor, L.coreLightIntensity, L.coreLightDistance);
    this.coreLight.name = 'viewmodel-accent-light';
    this.slot.add(this.coreLight);

    // Persistent effect anchors, re-parented to the shown model's sockets.
    this.anchors = {
      muzzle: new Object3D(),
      ejectPort: new Object3D(),
      sight: new Object3D(),
    };
    for (const s of SOCKETS) this.anchors[s].name = `viewmodel-anchor-${s}`;
    // The muzzle flash light lights the weapon itself in the viewmodel scene.
    this.muzzleLight = new PointLight(0xffffff, 0, ML.distance);
    this.muzzleLight.name = 'viewmodel-muzzle-light';
    this.muzzleLight.position.set(ML.offset.x, ML.offset.y, ML.offset.z);
    this.anchors.muzzle.add(this.muzzleLight);

    this.placeholder = createPlaceholderDevice();
    this.model = this.placeholder.root;
    prepareViewmodelObject(this.model);
    this.slot.add(this.model);
    this.attachAnchors();
    this.applyLightsForModel();

    this.animator = new ViewmodelAnimator({
      events: deps.events,
      showModel: (id) => this.displayWeapon(id),
    });

    this.unsubscribers.push(
      deps.events.on('player:land', (e) => {
        const kick = Math.min(e.impactSpeed * VIEWMODEL.landingKickPerSpeed, VIEWMODEL.maxLandingKick);
        this.kickY.velocity -= springImpulseForPeak(kick, KICK.stiffness, KICK.damping);
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

  /** The shown weapon model, or null (placeholder / custom model). */
  get currentWeaponModel(): WeaponViewmodelModel | null {
    return this.weaponModel;
  }

  /** Weapon id the animation layer is driving (null = no weapon). */
  get currentWeaponId(): string | null {
    return this.animator.currentWeaponId;
  }

  /** Use another ADS source (the weapon system); null restores the player's input ADS. */
  setAdsSource(source: { readonly adsAmount: number } | null): void {
    this.adsSource = source ?? this.player;
  }

  /**
   * Show a weapon model immediately (no equip animation). Unknown ids / null show the
   * placeholder device. weapon:equipStart events animate the switch on their own.
   */
  showWeapon(weaponId: string | null): void {
    this.animator.snapTo(weaponId);
  }

  /**
   * Replace the displayed model with an arbitrary object (debug / custom content). The rig does
   * not take ownership. Weapon animation is detached; pass null to restore the placeholder.
   */
  setModel(object: Object3D | null): void {
    this.animator.bindModel(null, null);
    this.weaponModel = null;
    this.shownWeaponId = null;
    this.weaponPose = null;
    this.swapDisplayed(object ?? this.placeholder.root);
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /**
   * Viewmodel-space anchor of a socket (child of the shown model's socket; persists across model
   * swaps). Attach viewmodel-scene effects (muzzle flash sprite) here once.
   */
  getSocketObject(socket: ViewmodelSocket): Object3D {
    return this.anchors[socket];
  }

  /**
   * World-space point that projects to the same pixel in the WORLD camera as the socket does in
   * the viewmodel camera, at the socket's view depth (tracer origins, world muzzle lights,
   * casings). Valid at any time in the frame (matrices are refreshed).
   */
  getSocketWorldPosition(socket: 'muzzle' | 'ejectPort', out: Vector3): Vector3 {
    const vmCam = this.render.viewmodelCamera;
    const cam = this.render.camera;
    const anchor = this.anchors[socket];
    anchor.updateWorldMatrix(true, false);
    _v.setFromMatrixPosition(anchor.matrixWorld).applyMatrix4(vmCam.matrixWorldInverse);
    cam.updateWorldMatrix(true, false);
    mapViewPointBetweenProjections(_v, vmCam.projectionMatrix, cam.projectionMatrixInverse, out);
    return out.applyMatrix4(cam.matrixWorld);
  }

  /** World-space effect direction of a socket (its local −Z: barrel axis, ejection direction). */
  getSocketWorldDirection(socket: ViewmodelSocket, out: Vector3): Vector3 {
    const vmCam = this.render.viewmodelCamera;
    const cam = this.render.camera;
    const anchor = this.anchors[socket];
    anchor.updateWorldMatrix(true, false);
    cam.updateWorldMatrix(true, false);
    return out
      .set(0, 0, -1)
      .transformDirection(anchor.matrixWorld)
      .transformDirection(vmCam.matrixWorldInverse)
      .transformDirection(cam.matrixWorld);
  }

  /**
   * Build the given weapon models now and compile their shaders (loading screen, after the
   * atmosphere is applied: the scene environment is part of the programs), so the first equip
   * never hitches. Models stay cached. Replaces a plain compile of the viewmodel scene.
   */
  warmupWeapons(renderer: WebGLRenderer, ids: readonly string[] = viewmodelIds()): void {
    const temp: WeaponViewmodelModel[] = [];
    for (const id of ids) {
      const m = this.getWeaponModel(id);
      if (m && m.root.parent === null) temp.push(m);
    }
    for (const m of temp) this.slot.add(m.root);
    // The viewmodel is only ever drawn into the post chain's buffers: compile with a render
    // target bound so the programs match those draws (linear output), not the canvas variants.
    // (r186 compile() visits hidden meshes too, e.g. the loading shell; lights are unchanged.)
    const target = new WebGLRenderTarget(1, 1);
    const previous = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(target);
      renderer.compile(this.render.viewmodelScene, this.render.viewmodelCamera);
    } catch (err) {
      log.warn('viewmodel warm-up compile failed', err);
    } finally {
      renderer.setRenderTarget(previous);
      target.dispose();
      for (const m of temp) this.slot.remove(m.root);
    }
  }

  update(dt: number): void {
    if (this.disposed || dt <= 0) return;
    this.time += dt;
    const player = this.player;
    const cam = this.camera;
    const ads = this.adsSource.adsAmount;
    const motionScale = lerp(1, SW.adsScale, ads);
    // Accessibility "camera motion" scales movement-driven motion (bob, breathing, movement
    // inertia, roll/tilt, kicks) like the camera does; look sway follows the player's own input.
    const a11y = cam.cameraMotion;
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
    // The weapon system ends an inspect silently when the weapon lowers (sprint, mantle).
    if (player.sprinting || WEAPON_RULES.loweredMovementStates.includes(state)) this.animator.cancelInspect();

    // --- bob synced to the camera gait phase (figure-8) + idle breathing ---
    const phase = cam.bobPhase;
    const bob = cam.bobIntensity * motionScale * a11y;
    const bobX = Math.sin(phase) * VIEWMODEL.bob.horizontalAmplitude * bob;
    const bobY = Math.cos(2 * phase) * VIEWMODEL.bob.verticalAmplitude * bob;
    const bobRoll = Math.sin(phase) * VIEWMODEL.bob.rollDeg * DEG2RAD * bob;
    const br = VIEWMODEL.breathing;
    const breath = Math.sin(this.time * br.rate) * motionScale * a11y;

    // --- weapon animation layer (kick, cycling, reload, equip, inspect, melee, idle) ---
    this.animator.update(dt, ads, a11y);
    const anim = this.animator.pose;

    // --- compose: base offset (hip ↔ ADS), weapon or placeholder poses, rig layers ---
    const w = this.weaponPose;
    const hipX = w ? w.hip.x : VIEWMODEL.offset.x;
    const hipY = w ? w.hip.y : VIEWMODEL.offset.y;
    const hipZ = w ? w.hip.z : VIEWMODEL.offset.z;
    const adsX = w ? w.ads.x : VIEWMODEL.adsOffset.x;
    const adsY = w ? w.ads.y : VIEWMODEL.adsOffset.y;
    const adsZ = w ? w.ads.z : VIEWMODEL.adsOffset.z;
    const sway = motionScale;
    const kickY = this.kickY.value * a11y;
    const px =
      lerp(hipX, adsX, ads) +
      (this.swayX.value + this.moveX * a11y) * sway +
      bobX +
      (w ? w.sprintPos.x * lower : 0) +
      anim.px;
    const py =
      lerp(hipY, adsY, ads) +
      this.swayY.value * sway +
      bobY +
      breath * br.amplitude +
      kickY +
      (w ? w.sprintPos.y : VIEWMODEL.sprintLower.y) * lower +
      VIEWMODEL.crouchOffset.y * this.crouchBlend +
      anim.py;
    const pz =
      lerp(hipZ, adsZ, ads) +
      this.kickZ.value * a11y +
      this.moveZ * a11y * sway +
      (w ? w.sprintPos.z * lower : 0) +
      anim.pz;
    this.root.position.set(px, py, pz);

    const pitch =
      this.swayPitch.value * sway +
      breath * br.pitchDeg * DEG2RAD +
      kickY * KICK.pitchDegPerMeter * DEG2RAD +
      (w ? w.sprintRot.x : VIEWMODEL.sprintLower.pitchDeg * DEG2RAD) * lower +
      (w ? w.hipRot.x * (1 - ads) : 0);
    const yaw =
      this.swayYaw.value * sway +
      (w
        ? w.sprintRot.y * lower + w.hipRot.y * (1 - ads)
        : VIEWMODEL.sprintLower.yawDeg * DEG2RAD * this.lowerBlend * (1 - ads));
    const tiltDeg =
      VIEWMODEL.slideTiltDeg * this.slideBlend + VIEWMODEL.crouchOffset.rollDeg * this.crouchBlend;
    const roll =
      (-this.swayYaw.value * SW.rollPerYaw + this.moveRoll * a11y) * sway +
      bobRoll +
      tiltDeg * DEG2RAD * a11y +
      (w ? w.sprintRot.z * lower + w.hipRot.z * (1 - ads) : 0);
    this.root.rotation.set(pitch, yaw, roll);
    this.pivot.rotation.set(anim.rx, anim.ry, anim.rz);

    // --- muzzle flash light (viewmodel scene) ---
    const flash = this.animator.muzzleFlash;
    this.muzzleLight.intensity = flash > FLASH_EPSILON ? ML.intensity * flash : 0;

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
    this.animator.dispose();
    // Anchors (and the muzzle light) belong to the rig, not to the models they ride on.
    for (const s of SOCKETS) this.anchors[s].removeFromParent();
    this.root.removeFromParent();
    this.lightRig.removeFromParent();
    this.keyLight.dispose();
    this.coreLight.dispose();
    this.muzzleLight.dispose();
    for (const m of this.weaponModels.values()) m.dispose();
    this.weaponModels.clear();
    this.kit?.dispose();
    this.kit = null;
    this.placeholder.dispose();
  }

  // -------------------------------------------------------------------------
  // Model management
  // -------------------------------------------------------------------------

  /** Cached weapon model for an id (built on first use); null when there is none. */
  private getWeaponModel(weaponId: string): WeaponViewmodelModel | null {
    const modelId = getWeaponDef(weaponId)?.model ?? weaponId;
    const cached = this.weaponModels.get(modelId);
    if (cached) return cached;
    if (this.missingModels.has(modelId)) return null;
    this.kit ??= new WeaponMaterialKit();
    const model = createWeaponViewmodel(modelId, this.kit);
    if (!model) {
      this.missingModels.add(modelId);
      return null;
    }
    prepareViewmodelObject(model.root);
    this.weaponModels.set(modelId, model);
    return model;
  }

  /** Animator callback: display the weapon's model (or the placeholder) and return it. */
  private displayWeapon(weaponId: string | null): WeaponViewmodelModel | null {
    const model = weaponId ? this.getWeaponModel(weaponId) : null;
    this.weaponModel = model;
    this.shownWeaponId = model ? weaponId : null;
    this.weaponPose = model ? resolveWeaponPose(model) : null;
    this.swapDisplayed(model ? model.root : this.placeholder.root);
    return model;
  }

  private swapDisplayed(next: Object3D): void {
    if (next !== this.model) {
      this.slot.remove(this.model);
      prepareViewmodelObject(next);
      this.slot.add(next);
      this.model = next;
    }
    this.attachAnchors();
    this.applyLightsForModel();
  }

  /** Re-parent the persistent socket anchors to the shown model's sockets. */
  private attachAnchors(): void {
    const sockets: Record<ViewmodelSocket, Object3D> | null = this.weaponModel
      ? {
          muzzle: this.weaponModel.muzzle,
          ejectPort: this.weaponModel.ejectPort,
          sight: this.weaponModel.sight,
        }
      : this.model === this.placeholder.root
        ? this.placeholder.sockets
        : null;
    for (const s of SOCKETS) {
      const anchor = this.anchors[s];
      const parent = sockets ? sockets[s] : this.model;
      if (anchor.parent !== parent) parent.add(anchor);
      anchor.position.set(0, 0, 0);
      anchor.quaternion.identity();
      prepareViewmodelObject(anchor);
    }
  }

  /** Pivot, accent light and muzzle light color for the shown model. */
  private applyLightsForModel(): void {
    const wm = this.weaponModel;
    const L = VIEWMODEL.lights;
    if (wm) {
      const d = wm.def;
      const k = d.scale ?? 1;
      this.pivot.position.set(d.pivot.x * k, d.pivot.y * k, d.pivot.z * k);
      this.slot.position.set(-d.pivot.x * k, -d.pivot.y * k, -d.pivot.z * k);
      const a = d.accentLight;
      this.coreLight.position.set(a.pos.x * k, a.pos.y * k, a.pos.z * k);
      this.coreLight.color.set(a.color);
      this.coreLight.intensity = a.intensity;
      this.coreLight.distance = a.distance;
      const color = getWeaponDef(this.shownWeaponId ?? wm.weaponId)?.vfx.muzzleLightColor;
      // defs/weapons documents the muzzle light color as a linear hex.
      if (color !== undefined) this.muzzleLight.color.setHex(color, LinearSRGBColorSpace);
      else this.muzzleLight.color.set(L.coreLightColor);
    } else {
      this.pivot.position.set(0, 0, 0);
      this.slot.position.set(0, 0, 0);
      const c = PLACEHOLDER_CORE_POSITION;
      this.coreLight.position.set(c.x, c.y, c.z);
      this.coreLight.color.set(L.coreLightColor);
      this.coreLight.intensity = L.coreLightIntensity;
      this.coreLight.distance = L.coreLightDistance;
      this.muzzleLight.color.set(L.coreLightColor);
    }
  }
}
