/**
 * Public contracts between systems. Concrete classes `implements` these interfaces and
 * cross-system consumers depend on them where possible. The composition root
 * (src/game/Game.ts) wires the concrete classes and may use members beyond these contracts
 * (e.g. RenderSystem.sunDirection, SettingsStore.flush); some player-side rigs (PlayerCamera,
 * ViewmodelRig) still take the concrete PlayerController for its gait/velocity internals.
 * Keeping contracts in one file makes the architecture reviewable at a glance and lets
 * systems be developed/tested in isolation.
 */
import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Action, Binding } from '../defs/input';
import type { MapAtmosphereDef } from '../defs/maps';
import type {
  AudioSettings,
  GraphicsSettings,
  QualityPreset,
  Settings,
  SettingsSection,
} from '../save/settingsSchema';
import type { EventBus } from './EventBus';
import type { GameEvents, MovementState, SurfaceType, Vec3Like } from './events';

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
  /** Thin materials can be penetrated by bullets (M5+). */
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
  /** 0..1 aim-down-sights amount (driven by input in M1, weapons later). */
  readonly adsAmount: number;
  teleport(position: Vec3Like, yaw?: number): void;
  /** Sample input intents (per frame; edges are latched until the next tick consumes them). */
  update(dt: number, alpha: number): void;
  fixedUpdate(dt: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// World / levels
// ---------------------------------------------------------------------------

export interface LevelInstance {
  readonly id: string;
  readonly atmosphere: MapAtmosphereDef;
  readonly root: THREE.Object3D;
  readonly spawn: { position: THREE.Vector3; yaw: number };
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
