/** Engine-level constants. Gameplay balancing lives in the other defs files. */
import { PAD } from './input';

export const ENGINE = {
  /** Simulation tick rate (physics, movement, AI) in Hz. Rendering is interpolated. */
  tickRate: 60,
  /** Max fixed ticks per frame before simulation time is dropped (spiral-of-death guard). */
  maxSubSteps: 5,
  /** Clamp for a single frame delta in seconds. */
  maxFrameDelta: 0.25,
  /** FPS limiter: a frame may arrive this fraction of the budget early (rAF jitter) and still count. */
  fpsLimiterTolerance: 0.96,
  /** Camera clip planes (meters). */
  cameraNear: 0.05,
  cameraFar: 400,
  viewmodelNear: 0.01,
  viewmodelFar: 10,
  /** Render layer used by the viewmodel scene objects. */
  viewmodelLayer: 1,
  /** Save format version, bump together with a migration in src/save/migrations.ts. */
  saveVersion: 1,
  /** IndexedDB database / store names. */
  saveDbName: 'riftfall',
  saveStoreName: 'saves',
  saveSlotKey: 'profile-main',
  localStorageKey: 'riftfall.save',
  /** SettingsStore coalesces bursts of changes (sliders) into one save after this quiet time. */
  settingsSaveDebounceMs: 400,
  /** Opening/probing a storage backend longer than this counts as a failure (blocked IndexedDB). */
  saveBackendTimeoutMs: 3000,
  /** IndexedDB open attempts (boot, and after a lost connection) before falling back; timeouts are not retried. */
  saveBackendOpenAttempts: 2,
} as const;

/** Loading-bar fractions for the boot steps (main.ts + Game.create). Level building reports its own sub-steps. */
export const BOOT_PROGRESS = {
  /** main.ts: engine chunks (three, postfx, Rapier) are downloading. */
  engine: 0.01,
  profile: 0.02,
  renderer: 0.08,
  physics: 0.15,
  /** Asset preload maps its own 0..1 progress onto start..start+span. */
  assets: { start: 0.2, span: 0.25 },
  level: { start: 0.45, span: 0.45 },
  environment: 0.92,
  /** Waiting for the navmesh worker (usually already done by then). */
  navigation: 0.96,
} as const;

/** Dev console command defaults and limits. */
export const DEV_COMMANDS = {
  /** `hurt` without an amount. */
  hurtDamage: 20,
  /** `shake` without a trauma value. */
  shakeTrauma: 0.6,
  timeScaleMin: 0.05,
  timeScaleMax: 4,
} as const;

/**
 * Fixed gamepad buttons for the menus (W3C standard mapping, not rebindable). Resume uses the
 * rebindable `pause` action (START by default).
 */
export const MENU_GAMEPAD = {
  up: PAD.UP,
  down: PAD.DOWN,
  left: PAD.LEFT,
  right: PAD.RIGHT,
  confirm: PAD.A,
  back: PAD.B,
  /** Holding a direction repeats it after this delay (s), then every `repeatInterval` seconds. */
  repeatDelay: 0.4,
  repeatInterval: 0.09,
} as const;
