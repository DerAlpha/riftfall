/** Engine-level constants. Gameplay balancing lives in the other defs files. */
export const ENGINE = {
  /** Simulation tick rate (physics, movement, AI) in Hz. Rendering is interpolated. */
  tickRate: 60,
  /** Max fixed ticks per frame before simulation time is dropped (spiral-of-death guard). */
  maxSubSteps: 5,
  /** Clamp for a single frame delta in seconds. */
  maxFrameDelta: 0.25,
  /** World units are meters. Gravity is defined per movement profile. */
  unitsPerMeter: 1,
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
} as const;
