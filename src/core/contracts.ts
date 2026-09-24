/**
 * Public contracts between systems. Concrete classes `implements` these interfaces and
 * cross-system consumers depend on them where possible. The composition root
 * (src/game/Game.ts) wires the concrete classes and may use members beyond these contracts
 * (e.g. RenderSystem.sunDirection, SettingsStore.flush); some player-side rigs (PlayerCamera,
 * ViewmodelRig) still take the concrete PlayerController for its gait/velocity internals, and
 * WeaponSystem reads Picks of PlayerController/PlayerCamera (WeaponPlayer, WeaponCamera).
 * Keeping contracts in one file makes the architecture reviewable at a glance and lets
 * systems be developed/tested in isolation.
 */
import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Action, Binding } from '../defs/input';
import type { MapAtmosphereDef } from '../defs/maps';
import type { ExplosionDef, FieldDef, WeaponProjectileDef } from '../defs/weapons';
import type {
  AccessibilitySettings,
  AudioSettings,
  GraphicsSettings,
  QualityPreset,
  Settings,
  SettingsSection,
} from '../save/settingsSchema';
import type { EventBus } from './EventBus';
import type {
  DamageElement,
  FleshSurface,
  GameEvents,
  HitZone,
  ImpactKind,
  MovementState,
  PointsReason,
  PurchaseKind,
  StatusId,
  SurfaceType,
  Vec3Like,
} from './events';

// ---------------------------------------------------------------------------
// Settings & save
// ---------------------------------------------------------------------------

export interface SettingsStore {
  readonly current: Readonly<Settings>;
  /** Shallow-merge a patch into one section, emit `settings:changed`, schedule a (debounced) save. */
  update<S extends SettingsSection>(section: S, patch: Partial<Settings[S]>): void;
  /** Replace everything (e.g. after load). Emits `settings:changed` for all sections. */
  replace(settings: Settings): void;
  resetSection(section: SettingsSection): void;
}

export interface ProfileData {
  createdAt: number;
  lastPlayedAt: number;
  /** Movement unlocks (meta progression later). */
  unlocks: { doubleJump: boolean; dash: boolean };
  /** True once hardware auto-detection chose a graphics preset. */
  qualityAutoDetected: boolean;
  /** True once the runtime benchmark ran (it may downgrade the preset once). */
  qualityBenchmarked: boolean;
}

export interface SaveData {
  version: number;
  settings: Settings;
  profile: ProfileData;
}

export interface SaveBackend {
  readonly name: 'indexeddb' | 'localStorage' | 'memory';
  read(key: string): Promise<unknown | undefined>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SaveSystemApi {
  readonly backendName: SaveBackend['name'];
  /** Never throws. Returns migrated data, or defaults if nothing is stored / data is corrupt. */
  load(): Promise<SaveData>;
  save(data: SaveData): Promise<void>;
  /** Wipe the save (dev console `resetsave`). */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface Vec2Out {
  x: number;
  y: number;
}

export interface LookOut {
  /** Radians, positive = turn right. */
  yaw: number;
  /** Radians, positive = look up. */
  pitch: number;
}

export interface InputApi {
  readonly device: 'kbm' | 'gamepad';
  readonly pointerLocked: boolean;
  /** When false, all gameplay actions read as released and look/move are zero (console/menus open). */
  enabled: boolean;
  /** Poll gamepads and compute per-frame edges. Call once at the start of every frame. */
  beginFrame(dt: number): void;
  /** Clear per-frame state (mouse delta, wheel, edges). Call once at the end of every frame. */
  endFrame(): void;
  isDown(action: Action): boolean;
  /** True only in the frame the action went down. */
  pressed(action: Action): boolean;
  released(action: Action): boolean;
  /** Analog value 0..1 (triggers); digital bindings report 0 or 1. */
  value(action: Action): number;
  /** Movement: x = strafe right, y = forward. Length is clamped to 1. Keyboard and left stick combined. */
  getMove(out: Vec2Out): Vec2Out;
  /** Accumulated look delta this frame in radians, base sensitivity + invert applied (ADS scaling is up to the consumer). */
  getLook(out: LookOut): LookOut;
  requestPointerLock(): void;
  exitPointerLock(): void;
  /** Resolve with the next pressed key/button/axis for rebinding, or null when cancelled (Escape) or timed out. */
  captureBinding(timeoutMs?: number): Promise<Binding | null>;
  rumble(strong: number, weak: number, durationMs: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------

export interface ColliderData {
  kind: 'world' | 'prop' | 'player' | 'enemy' | 'trigger';
  surface: SurfaceType;
  /**
   * Thin prop bullets can pass through (M2 penetration, COMBAT.penetrationCost[surface]). Static
   * level meshes take it from their material def (MaterialDef.penetrable) instead.
   */
  penetrable?: boolean;
  entityId?: number;
}

export interface RaycastHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  collider: RAPIER.Collider;
  data: ColliderData | undefined;
}

export interface RaycastOptions {
  /** Interaction groups (see defs/physics interactionGroups). Default: everything. */
  groups?: number;
  excludeCollider?: RAPIER.Collider;
  excludeRigidBody?: RAPIER.RigidBody;
  /** Treat colliders the ray starts inside as hits (default true). */
  solid?: boolean;
}

export interface PhysicsApi {
  readonly rapier: typeof RAPIER;
  readonly world: RAPIER.World;
  /** Fixed step. dt must equal the loop fixed dt. */
  step(dt: number): void;
  addStaticBox(
    center: Vec3Like,
    halfExtents: Vec3Like,
    rotation?: THREE.Quaternion,
    data?: ColliderData,
  ): RAPIER.Collider;
  /** World-space triangle mesh (for ramps/irregular static geometry). */
  addStaticTrimesh(vertices: Float32Array, indices: Uint32Array, data?: ColliderData): RAPIER.Collider;
  /** Dynamic box whose visual `object` is interpolated in syncVisuals(). */
  addDynamicBox(
    center: Vec3Like,
    halfExtents: Vec3Like,
    object: THREE.Object3D | null,
    opts?: { rotation?: THREE.Quaternion; density?: number; data?: ColliderData },
  ): RAPIER.RigidBody;
  removeBody(body: RAPIER.RigidBody): void;
  removeCollider(collider: RAPIER.Collider): void;
  /** Interpolate registered dynamic body visuals between the last two fixed steps. */
  syncVisuals(alpha: number): void;
  /**
   * Closest hit along a ray. The returned hit (including its `point`/`normal` vectors) is SHARED
   * and only valid until the next `raycast()` call – copy what you need to keep.
   */
  raycast(
    origin: Vec3Like,
    direction: Vec3Like,
    maxDistance: number,
    opts?: RaycastOptions,
  ): RaycastHit | null;
  getColliderData(collider: RAPIER.Collider): ColliderData | undefined;
  readonly stats: { bodies: number; colliders: number; dynamicBodies: number; stepMs: number };
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
  programs: number;
  width: number;
  height: number;
  pixelRatio: number;
  resolutionScale: number;
  /** GPU frame time in ms if EXT_disjoint_timer_query_webgl2 is available, else -1. */
  gpuMs: number;
}

export interface QualityApi {
  readonly resolutionScale: number;
  readonly gpuName: string;
  /** Heuristic preset from GPU string / hardware. */
  detectPreset(): QualityPreset;
  /**
   * Called once per simulated (unpaused) frame with the unscaled frame time (s) to drive dynamic
   * resolution + benchmark. Menu frames are not fed in: they measure the menu, not the game.
   */
  onFrame(realDt: number): void;
  /** Resolves with a recommended preset after the first-run benchmark (or null if no change). */
  runBenchmark(current: QualityPreset): Promise<QualityPreset | null>;
}

export interface RenderApi {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Separate scene/camera for the first-person viewmodel (own FOV, drawn over the world, never clipped). */
  readonly viewmodelScene: THREE.Scene;
  readonly viewmodelCamera: THREE.PerspectiveCamera;
  readonly quality: QualityApi;
  readonly stats: Readonly<RenderStats>;
  /** Make a lit material receive cascaded sun shadows. Call for every MeshStandard/Physical material in the world scene. */
  setupMaterial(material: THREE.Material): void;
  /** Apply map atmosphere: environment (HDRI texture or procedural fallback), sun, hemi light, fog, color grading. */
  applyAtmosphere(def: MapAtmosphereDef, hdri: THREE.Texture | null): void;
  applyGraphicsSettings(g: GraphicsSettings): void;
  /** Main camera vertical FOV in degrees (horizontal-FOV setting is converted by the caller). */
  setFov(fovDeg: number): void;
  /** 0..1 aim-down-sights blend (drives depth of field). */
  setAdsAmount(t: number): void;
  /** Distance in meters to keep in focus while aiming. */
  setFocusDistance(meters: number): void;
  /** Adds a chromatic aberration / flash pulse (0..1). */
  addHitPulse(strength: number): void;
  /** 1 = healthy, 0 = dead; below POSTFX.lowHealth.threshold the low-HP effect kicks in. */
  setHealthFraction(f: number): void;
  /** Render one frame (world + viewmodel + post). `realDt` in seconds, unscaled. */
  render(realDt: number): void;
  resize(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export type AssetType = 'hdri' | 'texture' | 'textureSet' | 'gltf' | 'audio' | 'lut';

export interface TextureSet {
  map: THREE.Texture | null;
  normalMap: THREE.Texture | null;
  /** Packed occlusion (R) / roughness (G) / metalness (B) – glTF convention. May be null. */
  ormMap: THREE.Texture | null;
  aoMap: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  metalnessMap: THREE.Texture | null;
  emissiveMap: THREE.Texture | null;
}

export interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  /** True if this is the placeholder because loading failed. */
  placeholder: boolean;
}

export interface AssetsApi {
  /** Loads all given ids (skipping cached), reporting progress. Never rejects. */
  preload(
    ids: readonly string[],
    onProgress?: (loaded: number, total: number, label: string) => void,
  ): Promise<void>;
  /** Equirectangular HDR environment (linear, HalfFloat). null if unavailable (caller uses procedural env). */
  loadHDRI(id: string): Promise<THREE.Texture | null>;
  /** Single texture; returns a clearly visible placeholder texture on failure. */
  loadTexture(id: string, opts?: { srgb?: boolean }): Promise<THREE.Texture>;
  /** PBR texture set; null if not available (caller falls back to procedural textures). */
  loadTextureSet(id: string): Promise<TextureSet | null>;
  /** glTF/GLB with Draco/Meshopt/KTX2 support; returns a placeholder model on failure. */
  loadModel(id: string): Promise<LoadedModel>;
  loadAudio(id: string): Promise<AudioBuffer | null>;
  has(id: string): boolean;
  /** Ids that failed to load and were replaced by placeholders (shown in debug overlay). */
  readonly missing: readonly string[];
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export type AudioBus = 'music' | 'sfx' | 'voice' | 'ui';

export interface PlayOptions {
  /** World position for positional (HRTF) playback; omit for 2D. */
  position?: Vec3Like;
  volume?: number;
  /** Playback-rate multiplier (1 = original). */
  pitch?: number;
  /** Random pitch variation +-. */
  pitchVariance?: number;
  bus?: AudioBus;
}

export interface AudioApi {
  readonly ready: boolean;
  /** Create/resume the AudioContext – must be called from a user gesture. */
  unlock(): Promise<void>;
  applySettings(a: AudioSettings): void;
  /** Update listener from the camera each frame. */
  setListener(position: Vec3Like, forward: Vec3Like, up: Vec3Like): void;
  /** Play a registered sound id (asset or procedural synth fallback). Unknown ids are ignored with a warning. */
  play(id: string, opts?: PlayOptions): void;
  setReverbZone(zone: MapAtmosphereDef['reverb']): void;
  /** Pause/resume everything (game pause, tab hidden). */
  setPaused(paused: boolean): void;
  readonly stats: { activeVoices: number; contextState: string };
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export interface PlayerApi {
  /** Feet position at the latest fixed tick. */
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  /** Interpolated eye position used by the camera this frame. */
  readonly eyePosition: THREE.Vector3;
  readonly state: MovementState;
  readonly grounded: boolean;
  readonly crouched: boolean;
  readonly sprinting: boolean;
  /** Radians. Yaw 0 looks down -Z; positive yaw turns left (three.js convention, rotation.y). */
  yaw: number;
  pitch: number;
  readonly dashCharges: number;
  /** 0..1 progress of the next dash charge. */
  readonly dashRecharge: number;
  unlocks: { doubleJump: boolean; dash: boolean };
  noclip: boolean;
  godMode: boolean;
  /** 0..1 aim-down-sights amount (raw `ads` input, or the AdsProvider while one is set). */
  readonly adsAmount: number;
  teleport(position: Vec3Like, yaw?: number): void;
  /** Sample input intents (per frame; edges are latched until the next tick consumes them). */
  update(dt: number, alpha: number): void;
  fixedUpdate(dt: number): void;
  dispose(): void;
}

/**
 * External aim-down-sights source (the weapon system, `PlayerController.adsProvider`). While set,
 * it replaces the raw `ads` input: its adsAmount is the player's, its move speed multiplier
 * replaces MOVEMENT.ground.adsSpeedMultiplier, and `blocksSprint` stops sprinting (firing,
 * reloading).
 */
export interface AdsProvider {
  /** 0..1 blend this frame. */
  readonly adsAmount: number;
  /** Ground speed multiplier at full ADS. */
  readonly adsMoveSpeedMultiplier: number;
  readonly blocksSprint: boolean;
}

/**
 * External look hook (the weapon system, `PlayerCamera.lookModifier`). When set it replaces the
 * default ADS handling: it scales and may bend this frame's look delta (weapon ADS sensitivity,
 * gamepad aim assist), and its FOV multiplier replaces CAMERA.fov.adsZoom.
 */
export interface LookModifier {
  /** Adjust the look delta in place (radians, InputApi.getLook convention: yaw + = right, pitch + = up). */
  modifyLook(look: LookOut): void;
  /** Horizontal FOV multiplier (ADS zoom), 1 = unzoomed. */
  readonly fovMultiplier: number;
}

// ---------------------------------------------------------------------------
// World / levels
// ---------------------------------------------------------------------------

export interface LevelInstance {
  readonly id: string;
  readonly atmosphere: MapAtmosphereDef;
  readonly root: THREE.Object3D;
  readonly spawn: { position: THREE.Vector3; yaw: number };
  /** Enemy spawn points (wave maps; the calibration hall has a few for testing). */
  readonly spawnPoints?: readonly SpawnPointDef[];
  /** Meshes the navmesh is built from (default: every static level mesh). */
  readonly navSources?: readonly THREE.Mesh[];
  update(dt: number, time: number): void;
  fixedUpdate?(dt: number): void;
  readonly stats: { meshes: number; lights: number; colliders: number; dynamicBodies: number };
  dispose(): void;
}

export interface MaterialLibraryApi {
  /** Get (lazily create) a shared material by id from defs/materials. Unknown ids return a loud placeholder material. */
  get(id: string): THREE.MeshStandardMaterial;
  /** Pre-generate / load textures for the given material ids. */
  preload(ids: readonly string[], onProgress?: (done: number, total: number) => void): Promise<void>;
  dispose(): void;
}

export interface LevelBuildContext {
  render: RenderApi;
  physics: PhysicsApi;
  assets: AssetsApi;
  materials: MaterialLibraryApi;
  settings: SettingsStore;
  events: EventBus<GameEvents>;
  onProgress(label: string, fraction: number): void;
}

export type LevelBuilder = (ctx: LevelBuildContext) => Promise<LevelInstance>;

// ---------------------------------------------------------------------------
// Dev console
// ---------------------------------------------------------------------------

export interface ConsoleCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  /** Return value (if any) is printed. Throwing prints an error. */
  run(args: string[]): string | void | Promise<string | void>;
  /** Optional argument completion. */
  complete?(args: string[]): string[];
}

export interface DevConsoleApi {
  readonly open: boolean;
  register(cmd: ConsoleCommand): void;
  print(text: string, kind?: 'info' | 'warn' | 'error' | 'input'): void;
  execute(line: string): Promise<void>;
  toggle(force?: boolean): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Combat (M2+)
// ---------------------------------------------------------------------------

/** World-space hit volume of a damageable, refreshed by its owner every tick. */
export interface Hitbox {
  shape: 'sphere' | 'capsule';
  zone: HitZone;
  /** Sphere center or capsule segment start (world space, meters). */
  a: THREE.Vector3;
  /** Capsule segment end (ignored for spheres). */
  b: THREE.Vector3;
  radius: number;
}

export interface DamageInfo {
  amount: number;
  zone: HitZone;
  point: Vec3Like;
  /** Normalized direction the damage travels (shot direction / blast outward). */
  direction: Vec3Like;
  weaponId: string;
  element: DamageElement;
  source: 'player' | 'enemy' | 'trap' | 'environment';
  kind: ImpactKind;
  /** Knockback impulse magnitude (m/s applied to the target), optional. */
  impulse?: number;
}

export interface DamageResult {
  /** Damage actually applied after armor/resistances (0 if immune/dead). */
  applied: number;
  killed: boolean;
}

export interface Damageable {
  readonly id: number;
  readonly alive: boolean;
  readonly team: 'player' | 'enemy' | 'neutral';
  readonly surface: FleshSurface;
  /** Broadphase sphere (world space). */
  readonly boundsCenter: THREE.Vector3;
  readonly boundsRadius: number;
  readonly hitboxes: readonly Hitbox[];
  /** Point aim assist pulls towards (usually upper chest). */
  readonly aimPoint: THREE.Vector3;
  /** Optional per-zone impact surface (armor plates vs. flesh); `surface` when absent. */
  surfaceAt?(zone: HitZone): FleshSurface;
  applyDamage(info: DamageInfo): DamageResult;
}

export interface CombatHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  /** Damageable hit, or null for world geometry. */
  target: Damageable | null;
  zone: HitZone | null;
  surface: SurfaceType | FleshSurface;
  /** Surface is thin enough to shoot through (glass, grates, crates...); false for damageables. */
  penetrable: boolean;
}

export interface CombatWorldApi {
  register(target: Damageable): void;
  unregister(target: Damageable): void;
  readonly targets: readonly Damageable[];
  /**
   * Nearest hit along the ray against static world geometry (three-mesh-bvh on level meshes named
   * `level:<materialId>` / `panel:<materialId>` – COMBAT.staticMeshPrefixes; other meshes do not stop
   * bullets), registered damageables' hitboxes and dynamic props (Rapier colliders: `target` null,
   * surface/penetrable from their ColliderData). The returned object is reused – copy what you keep.
   */
  raycast(
    origin: Vec3Like,
    direction: Vec3Like,
    maxDistance: number,
    opts?: { ignore?: Damageable | null },
  ): CombatHit | null;
  /** Damageables whose bounds intersect the sphere (explosions, melee). Fills and returns `out`. */
  queryRadius(center: Vec3Like, radius: number, out: Damageable[]): Damageable[];
  /** Apply damage and emit combat:damage / combat:kill. */
  dealDamage(target: Damageable, info: DamageInfo): DamageResult;
  /** Static-world line of sight check (no damageables). */
  lineOfSight(from: Vec3Like, to: Vec3Like): boolean;
}

export interface CombatRaycastOptions {
  /** Skip this damageable (the shooter, a target the bullet already passed). */
  ignore?: Damageable | null;
  /** Skip several damageables (penetration through bodies). */
  ignoreMany?: readonly Damageable[];
  /**
   * Skip the dynamic prop hit by the previous raycast (penetration continuation: the new ray
   * starts inside that prop).
   */
  skipLastProp?: boolean;
  /** Test dynamic props (default true). */
  props?: boolean;
}

/** CombatWorldApi extensions the weapon system uses: penetration-aware raycasts, prop impulses. */
export interface WeaponCombatApi extends CombatWorldApi {
  raycast(
    origin: Vec3Like,
    direction: Vec3Like,
    maxDistance: number,
    opts?: CombatRaycastOptions,
  ): CombatHit | null;
  /**
   * Push the dynamic prop behind `hit` (must be the hit returned by the latest raycast) along
   * `direction` with `impulse` N·s at the hit point. No-op for anything else.
   */
  pushProp(hit: CombatHit, direction: Vec3Like, impulse: number): boolean;
  /**
   * Is `hit` (the latest raycast result) on a dynamic prop? Such hits get no world-space decal:
   * the prop moves away from it.
   */
  hitsDynamicProp(hit: CombatHit): boolean;
}

// ---------------------------------------------------------------------------
// Weapons (M2+)
// ---------------------------------------------------------------------------

/** A procedurally built (or glTF) first-person weapon model with animation sockets. */
export interface WeaponViewmodel {
  readonly weaponId: string;
  readonly root: THREE.Object3D;
  /** Barrel tip (muzzle flash, tracer origin). */
  readonly muzzle: THREE.Object3D;
  /** Shell ejection port (casings). */
  readonly ejectPort: THREE.Object3D;
  /** Point that must sit on the view axis while aiming down sights. */
  readonly sight: THREE.Object3D;
  /** Named moving parts for procedural animation (slide, magazine, bolt, pump, trigger, ...). */
  readonly parts: Readonly<Record<string, THREE.Object3D>>;
  dispose(): void;
}

export interface WeaponSystemApi {
  readonly currentWeaponId: string | null;
  /** 0..1 aim-down-sights blend of the current weapon (drives FOV zoom, DoF, sensitivity, move speed). */
  readonly adsAmount: number;
  /** 0..1 normalized current spread (debug readouts). */
  readonly spread: number;
  /** Current cone half-angle (degrees): the HUD crosshair projects it with this frame's FOV. */
  readonly spreadDegrees: number;
  readonly ammo: { mag: number; reserve: number; magSize: number } | null;
  /** Add a weapon (replaces the current slot when full, CoD style) and equip it. */
  give(weaponId: string): void;
  /** Refill reserve (and optionally magazines) of all carried weapons. */
  refillAmmo(fillMagazines?: boolean): void;
  fixedUpdate(dt: number): void;
  update(dt: number): void;
  dispose(): void;
}

export interface VfxApi {
  /** Spawn a named effect preset (see defs/vfx.ts) at a world position oriented along `normal`. */
  spawn(effect: string, position: Vec3Like, normal?: Vec3Like, scale?: number): void;
  tracer(from: Vec3Like, to: Vec3Like, color?: number): void;
  explosion(position: Vec3Like, radius: number, element?: DamageElement): void;
  decal(kind: string, position: Vec3Like, normal: Vec3Like, size?: number): void;
  update(dt: number): void;
  readonly stats: { particles: number; decals: number; lights: number };
  dispose(): void;
}

export type VfxSocket = 'muzzle' | 'ejectPort';

/** Viewmodel socket access for VFX (ViewmodelRig satisfies it). */
export interface VfxSocketSource {
  /** Viewmodel-space anchor that follows the shown weapon's socket (muzzle flash parent). */
  getSocketObject(socket: VfxSocket): THREE.Object3D;
  /** World point that projects where the socket appears on screen. */
  getSocketWorldPosition(socket: VfxSocket, out: THREE.Vector3): THREE.Vector3;
  /** World direction of the socket's local −Z (barrel axis / ejection direction). */
  getSocketWorldDirection?(socket: VfxSocket, out: THREE.Vector3): THREE.Vector3;
}

/**
 * The weapon side of the VFX system, driven from events by VfxBridge (muzzle flashes, impacts,
 * player tracers, settings). Weapon specifics arrive as def data (preset / profile ids, colors).
 */
export interface VfxWeaponApi extends VfxApi {
  /**
   * A shot was fired: viewmodel flash, world flash light, muzzle smoke and casing, resolved at this
   * frame's sockets. `muzzle` / `direction`: world muzzle and aim at fire time (no sockets).
   * `lightColor`: linear hex, 0 = preset color.
   */
  muzzle(
    preset: string,
    lightColor: number,
    casing: string | null,
    ads: boolean,
    muzzle: Vec3Like,
    direction: Vec3Like,
  ): void;
  /**
   * A shot hit a surface. `profile`: weapon impact profile id, null = by impact kind. `decal` false
   * suppresses the surface decal. `direction`: the shot's travel direction when known.
   */
  impact(
    surface: SurfaceType | FleshSurface,
    profile: string | null,
    kind: ImpactKind,
    point: Vec3Like,
    normal: Vec3Like,
    decal: boolean,
    direction?: Vec3Like | null,
  ): void;
  /** Player tracer to `to`, starting at the displayed muzzle socket (`from`: fallback). */
  muzzleTracer(to: Vec3Like, color: number, from: Vec3Like): void;
  /** Attach / replace / detach the viewmodel sockets (the rig is created after the VFX). */
  setSockets(sockets: VfxSocketSource | null): void;
  /** Hide the viewmodel flash (weapon switch). */
  hideMuzzleFlash(): void;
  applyGraphics(g: Readonly<GraphicsSettings>): void;
  applyAccessibility(a: Readonly<AccessibilitySettings>): void;
}

// ---------------------------------------------------------------------------
// Navigation, enemies, waves (M3+)
// ---------------------------------------------------------------------------

export interface NavAgentParams {
  radius: number;
  height: number;
  maxSpeed: number;
  maxAcceleration: number;
  /** 0..1 how strongly the agent keeps distance to others (crowd separation). */
  separationWeight?: number;
}

/** Navmesh + crowd simulation (recast-navigation). Agent ids are opaque numbers (-1 = failed). */
export interface NavApi {
  readonly ready: boolean;
  /** Build the navmesh from static level geometry (in a worker when possible). Never rejects. */
  build(sources: readonly THREE.Mesh[]): Promise<boolean>;
  /** Snap a point to the navmesh; false if nothing within the search extents. */
  closestPoint(p: Vec3Like, out: THREE.Vector3): boolean;
  /** Random reachable navmesh point within `radius` of `center`. */
  randomPointAround(center: Vec3Like, radius: number, out: THREE.Vector3): boolean;
  /** Straight-path corners from -> to, written into `out` (reused vectors); returns the count (0 = no path). */
  findPath(from: Vec3Like, to: Vec3Like, out: THREE.Vector3[]): number;
  /** Walkable straight line on the navmesh (no wall/ledge in between). */
  walkable(from: Vec3Like, to: Vec3Like): boolean;
  addAgent(position: Vec3Like, params: NavAgentParams): number;
  removeAgent(id: number): void;
  setAgentTarget(id: number, target: Vec3Like): void;
  /** Stop steering (agent brakes and holds position). */
  stopAgent(id: number): void;
  setAgentMaxSpeed(id: number, speed: number): void;
  teleportAgent(id: number, position: Vec3Like): void;
  getAgentPosition(id: number, out: THREE.Vector3): THREE.Vector3;
  getAgentVelocity(id: number, out: THREE.Vector3): THREE.Vector3;
  /** Advance the crowd (fixed tick). */
  update(dt: number): void;
  /** Optional debug visualization (dev console `nav`). */
  setDebugVisible(visible: boolean, scene: THREE.Object3D): void;
  /**
   * M4 door gating: while `blocked`, the navmesh inside the axis-aligned box (center ± halfExtents)
   * is excluded from every query and from crowd paths. The first call with a box registers it;
   * later calls with the same box toggle it. Areas persist across rebuilds. Optional (fakes).
   */
  setAreaBlocked?(center: Vec3Like, halfExtents: Vec3Like, blocked: boolean): void;
  readonly stats: { agents: number; polys: number; buildMs: number };
  dispose(): void;
}

/** Enemy spawn location authored by the map ("rift tear"); `zone` gates it behind doors (M4). */
export interface SpawnPointDef {
  id: string;
  position: THREE.Vector3;
  /** Direction enemies face / move when emerging. */
  yaw: number;
  zone: string;
  kind: 'rift' | 'vent' | 'floor';
}

/** What enemies need from the player. */
export interface EnemyTargetApi {
  readonly position: THREE.Vector3;
  readonly eyePosition: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly alive: boolean;
  /**
   * Look yaw (radians, PlayerApi convention: 0 looks down −Z). Optional: flanking enemies avoid the
   * view direction; without it they use the aim of the last shot / the movement direction.
   */
  readonly yaw?: number;
  damage(amount: number, direction?: Vec3Like): number;
}

export interface EnemySpawnOptions {
  /** Elite affix ids (M6). */
  affixes?: readonly string[];
  healthMultiplier?: number;
  speedMultiplier?: number;
  damageMultiplier?: number;
  /** Spawn point used (for emerge VFX orientation). */
  spawnPoint?: SpawnPointDef | null;
}

export interface EnemyManagerApi {
  readonly alive: number;
  readonly capacity: number;
  /** Spawn an enemy; returns its id or null when the pool is exhausted / the type is unknown. */
  spawn(type: string, position: Vec3Like, opts?: EnemySpawnOptions): number | null;
  /** Remove every enemy (restart, nuke power-up in M4 kills with credit instead). */
  clear(): void;
  /** Kill all with death effects (nuke). `credit` gives kill points to the player. */
  killAll(credit: boolean): number;
  fixedUpdate(dt: number): void;
  update(dt: number, alpha: number): void;
  readonly stats: { alive: number; byType: Readonly<Record<string, number>>; aiMs: number };
  dispose(): void;
}

export interface WaveDirectorApi {
  readonly wave: number;
  readonly state: 'idle' | 'intermission' | 'active' | 'over';
  readonly remaining: number;
  /** Begin the run at `wave` (default 1) after the first intermission. */
  start(wave?: number): void;
  /** Dev console `wave <n>`: jump to wave n (clears current enemies). */
  setWave(wave: number): void;
  skipIntermission(): void;
  stop(): void;
  fixedUpdate(dt: number): void;
}

// ---------------------------------------------------------------------------
// Economy, stats, interactables, perks, power-ups (M4+)
// ---------------------------------------------------------------------------

/**
 * Named gameplay stat (see defs/stats.ts STAT_DEFS for ids, bases and clamps). Perks (M4), Rift Forge
 * (M5), roguelite cards (M8) and the skill tree (M9) all change gameplay through stat modifiers –
 * systems read `stats.value(id)` instead of hard-coding bonuses.
 */
export type StatId = string;

export interface StatModifier {
  /** Owner id (e.g. 'perk:quickfire'); removeSource() drops every modifier of it. */
  source: string;
  stat: StatId;
  /** 'add' is summed onto the base, 'mul' multiplies the sum: value = (base + Σadd) × Πmul, then clamped. */
  op: 'add' | 'mul';
  value: number;
}

export interface StatsApi {
  /** Increments on every change: consumers cache and compare instead of re-reading every tick. */
  readonly version: number;
  value(stat: StatId): number;
  base(stat: StatId): number;
  addModifier(mod: StatModifier): void;
  removeSource(source: string): void;
  hasSource(source: string): boolean;
  /** Drop every modifier (new run). */
  reset(): void;
}

export interface EconomyApi {
  readonly points: number;
  /** Earn points (scaled by the points multiplier stat / double points); returns the amount credited. */
  earn(amount: number, reason: PointsReason, position?: Vec3Like): number;
  /** Atomic purchase: returns false (and emits economy:purchase ok=false) when unaffordable. */
  spend(cost: number, item: string, kind: PurchaseKind): boolean;
  canAfford(cost: number): boolean;
  /** New run: set points to the mode's start value. */
  reset(startPoints?: number): void;
}

/** Something the player can use with the 'interact' action (wall buy, door, box, perk machine, seal). */
export interface Interactable {
  readonly id: string;
  /** World position used for range and view-cone checks (usually the prompt anchor). */
  readonly position: THREE.Vector3;
  /** Max use distance (m). */
  readonly range: number;
  /** German prompt shown in the HUD, e.g. "KR-7 kaufen". */
  prompt(): string;
  /** Cost shown next to the prompt (null = free / not a purchase). */
  cost(): number | null;
  /** Usable right now (e.g. the box is not already rolling, the door is still closed). */
  canInteract(): boolean;
  /** Seconds the button must be held (0 = press). Repairs hold, purchases press. */
  holdTime(): number;
  interact(): void;
}

export interface InteractionApi {
  register(i: Interactable): void;
  unregister(i: Interactable): void;
  readonly focused: Interactable | null;
  /** 0..1 hold progress of the focused interactable (HUD ring). */
  readonly holdProgress: number;
  fixedUpdate(dt: number): void;
}

export interface PerkApi {
  readonly owned: readonly string[];
  readonly maxPerks: number;
  has(perkId: string): boolean;
  /** Grant a perk (applies its stat modifiers / hooks); false when owned or at the limit. */
  grant(perkId: string): boolean;
  revoke(perkId: string): void;
  /** Lose all perks (death with a self-revive, new run). */
  clear(): void;
}

export interface PowerUpApi {
  /** Chance-based drop on an enemy death (respects per-wave caps); `type` forces a specific drop. */
  rollDrop(position: Vec3Like, type?: string): void;
  isActive(type: string): boolean;
  /** Seconds left of a timed power-up (0 when inactive). */
  remaining(type: string): number;
  fixedUpdate(dt: number): void;
  update(dt: number): void;
  clear(): void;
}

/** Zone gating for doors/spawns (M4): the WaveDirector's isZoneActive and the navmesh door flags. */
export interface ZoneApi {
  isActive(zone: string): boolean;
  activate(zone: string): void;
  readonly active: readonly string[];
  reset(): void;
}

// ---------------------------------------------------------------------------
// Arsenal (M5): projectiles, explosions, status effects, grenades, abilities
// ---------------------------------------------------------------------------

/** What a projectile/explosion/field deals (copied at spawn; the def objects are shared data). */
export interface DamageSource {
  weaponId: string;
  source: DamageInfo['source'];
  /** Damage of a direct projectile hit (0 = none) and its element. */
  damage: number;
  element: DamageElement;
  headMultiplier: number;
  weakpointMultiplier: number;
  /** Status build-up per damage point for this source's element (elemental mods), 0 = none. */
  statusBuildup: number;
}

/** Area damage (explosions) – projectiles, grenades, forge specials, perks, enemies. */
export interface ExplosionApi {
  /**
   * Damage every damageable (and the player, scaled by `selfDamageScale` for player sources)
   * inside `def.radius` with line of sight, push props, emit combat:explosion. Returns the
   * number of damageables hit.
   */
  explode(
    position: Vec3Like,
    def: ExplosionDef,
    from: Pick<DamageSource, 'weaponId' | 'source' | 'statusBuildup'>,
  ): number;
}

export interface ProjectileSpawnOptions {
  origin: Vec3Like;
  /** Normalized launch direction. */
  direction: Vec3Like;
  def: WeaponProjectileDef;
  damage: DamageSource;
  /** Initial velocity added to the launch (the thrower's movement), optional. */
  inherit?: Vec3Like;
  /** Speed/blast factors (attachments, stats); default 1. */
  speedScale?: number;
  blastScale?: number;
}

/** Pooled simulated projectiles (fixed tick) with interpolated visuals (per frame). */
export interface ProjectileApi {
  /** Returns the projectile id (0 when the pool refused it). */
  spawn(opts: ProjectileSpawnOptions): number;
  readonly active: number;
  fixedUpdate(dt: number): void;
  update(dt: number, alpha: number): void;
  clear(): void;
}

/** Lingering area effects (FieldDef). */
export interface FieldApi {
  spawn(
    position: Vec3Like,
    def: FieldDef,
    from: Pick<DamageSource, 'weaponId' | 'source' | 'statusBuildup'>,
  ): number;
  /** Pull velocity (m/s, written into `out`) a field applies to a point this tick; false = none. */
  pullAt(position: Vec3Like, out: THREE.Vector3): boolean;
  /** Speed multiplier from slow fields at a point (1 = none). */
  slowAt(position: Vec3Like): number;
  readonly active: number;
  fixedUpdate(dt: number): void;
  update(dt: number): void;
  clear(): void;
}

/**
 * Status effects on damageables (M5 elements): burn (DoT), chill → frozen (slow, then immobile;
 * shatter bonus), shocked (stun + arcs), poisoned (stacking DoT), voidMark (damage taken up,
 * implodes). Combos when two react (defs/elements.ts). Enemies read the queries every tick.
 */
export interface StatusEffectsApi {
  /** Build up `element`'s status on `target` by `amount` (damage × build-up factor). */
  applyElement(
    target: Damageable,
    element: DamageElement,
    amount: number,
    source: DamageInfo['source'],
  ): void;
  has(targetId: number, status: StatusId): boolean;
  /** Movement/attack speed multiplier (chill, frozen = 0), 1 = unaffected. */
  speedMultiplier(targetId: number): number;
  /** No AI actions (stunned, frozen). */
  incapacitated(targetId: number): boolean;
  /** Damage-taken multiplier (void mark), 1 = none. */
  damageTakenMultiplier(targetId: number): number;
  /** Tint for the enemy renderer's rim (linear RGB hex) and strength 0..1; false = none. */
  rimFor(targetId: number, out: { color: number; strength: number }): boolean;
  clear(targetId: number): void;
  reset(): void;
  fixedUpdate(dt: number): void;
}

/** Grenades (M5): one selected type, counts per type, thrown with the 'grenade' action. */
export interface GrenadeApi {
  readonly selected: string;
  count(grenadeId: string): number;
  max(grenadeId: string): number;
  /** Add grenades (max ammo power-up refills the selected type). */
  add(grenadeId: string, n: number): number;
  refill(): void;
  select(grenadeId: string): void;
  fixedUpdate(dt: number): void;
  reset(): void;
}

/** Active ability with cooldown (M5), used with the 'ability' action. */
export interface AbilityApi {
  readonly equipped: string | null;
  /** Seconds until ready (0 = ready) and the full cooldown (HUD ring). */
  readonly cooldownLeft: number;
  readonly cooldown: number;
  /** An effect with a duration is running. */
  readonly active: boolean;
  equip(abilityId: string | null): void;
  use(): boolean;
  fixedUpdate(dt: number): void;
  reset(): void;
}
