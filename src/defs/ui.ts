/**
 * UI tuning: HUD behaviour, debug overlay, dev console, loading screen and menu ranges.
 * Visual styling lives in src/ui/styles.css; values here are the ones TS code needs.
 */
import { CAMERA } from './camera';

export const HUD = {
  /** Health fraction below which the health bar turns into a warning state. */
  lowHealthFraction: 0.35,
  crosshair: {
    /** Gap/radius growth in CSS px at setSpread(1). */
    spreadMinPx: 0,
    spreadMaxPx: 24,
    /** Spread changes below this (0..1) are not written to the DOM. */
    spreadQuantum: 0.01,
    defaultColor: '#e8f6ff',
  },
  damageIndicator: {
    /** Pooled indicator elements (simultaneous directions). */
    slots: 6,
    /** Seconds an indicator stays visible; it fades out over the last `fadeSeconds`. */
    durationSeconds: 1.6,
    fadeSeconds: 0.7,
    /** Damage amount that produces a fully opaque indicator. */
    fullAmount: 35,
    minOpacity: 0.35,
    /** A new hit within this angle (deg, world space) refreshes an existing indicator instead of adding one. */
    mergeAngleDeg: 25,
    /** Rotation/opacity changes smaller than these are not written to the DOM. */
    angleEpsilonDeg: 0.5,
    opacityEpsilon: 0.02,
  },
  hitFlash: {
    /** Vignette opacity added per point of damage, capped at `max` (or `reducedMax` with reduce flashing). */
    perDamage: 0.025,
    max: 0.85,
    reducedMax: 0.3,
    /** Fade speed (opacity per second); slower with reduce flashing so it never strobes. */
    decayPerSecond: 2.2,
    reducedDecayPerSecond: 0.9,
    epsilon: 0.01,
  },
  dash: {
    /** Recharge progress changes below this are not written to the DOM. */
    progressQuantum: 0.01,
    maxPips: 6,
  },
  movementReadout: {
    /** Readout refresh rate (Hz) – subtle, it does not need 60 updates per second. */
    refreshHz: 12,
    defaultVisible: true,
  },
  fps: {
    refreshHz: 4,
  },
} as const;

export const DEBUG_OVERLAY = {
  /** Text refresh rate (Hz). The frame-time graph updates every frame while visible. */
  textHz: 10,
  graph: {
    frames: 240,
    widthPx: 240,
    heightPx: 72,
    /** Backing-store resolution cap (device pixels per CSS pixel). */
    maxPixelRatio: 2,
    /** Vertical scale: frame times above this are clipped. */
    maxMs: 50,
    guidesMs: [1000 / 60, 1000 / 30],
    colors: {
      good: '#35f2a4',
      warn: '#ffc247',
      bad: '#ff4d5e',
      guide: 'rgba(255, 255, 255, 0.28)',
      background: 'rgba(0, 8, 14, 0.55)',
    },
  },
  /** Percentile reported as "p99" when the snapshot does not provide one. */
  percentile: 0.99,
  /** Missing assets listed before truncation. */
  maxMissingAssets: 8,
} as const;

export const DEV_CONSOLE = {
  maxLines: 500,
  historySize: 100,
  historyStorageKey: 'riftfall.console.history',
  /** Warnings/errors from the log history shown when the console is created. */
  recentWarnings: 12,
  /** PageUp/PageDown scroll the output by this fraction of its visible height. */
  pageScrollFraction: 0.9,
  prompt: '>',
} as const;

export const LOADING = {
  tipIntervalMs: 6500,
  fadeMs: 500,
  tips: [
    'Der Riss öffnete sich um 03:17 Uhr Stationszeit. Seitdem ist Halle 7 nie wieder still gewesen.',
    'Die Kalibrierungshalle wurde gebaut, um Waffen zu testen. Heute testet sie, wer überlebt.',
    'Tipp: Rutschen erhält deinen Schwung – spring aus dem Rutschen heraus für maximales Tempo.',
    'Tipp: Der Dash hat zwei Ladungen, die sich nacheinander wieder aufladen.',
    'Tipp: Niedrige Kanten erklimmst du automatisch, wenn du beim Springen vorwärts drückst.',
    'Protokoll 12: „Die Wände flüstern nur, wenn niemand hinsieht.“',
    'Rift-Energie reagiert auf Bewegung. Wer stillsteht, wird gefunden.',
    'Letzter Funkspruch aus Sektor C: „Sie kommen in Wellen. Jedes Mal mehr.“',
    'Tipp: Doppelsprung und Dash lassen sich kombinieren – bleib in der Luft, bleib am Leben.',
    'Tipp: Mit ^ öffnest du die Entwicklerkonsole, mit F3 die Leistungsanzeige.',
    'Die Notbeleuchtung flackert im Takt von etwas, das auf der anderen Seite atmet.',
    'Wartungslog: Rift-Anker 3 zeigt erneut Resonanz. Ursache unbekannt.',
  ],
} as const;

export interface RangeDef {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export const MENU = {
  /** How long the "binding swapped" notice stays visible (ms). */
  conflictNoticeMs: 4500,
  /** "Vibration testen" button. */
  rumbleTest: { strong: 0.7, weak: 0.4, durationMs: 260 },
  ranges: {
    renderScale: { min: 0.5, max: 1, step: 0.05 },
    maxPixelRatio: { min: 0.75, max: 2, step: 0.25 },
    exposure: { min: 0.5, max: 2, step: 0.05 },
    volume: { min: 0, max: 1, step: 0.01 },
    mouseSensitivity: { min: 0.1, max: 8, step: 0.05 },
    adsSensitivity: { min: 0.2, max: 1.5, step: 0.05 },
    fov: { min: CAMERA.minFov, max: CAMERA.maxFov, step: 1 },
    gamepadSensitivity: { min: 0.2, max: 3, step: 0.05 },
    gamepadDeadzone: { min: 0.02, max: 0.4, step: 0.01 },
    screenShake: { min: 0, max: 1, step: 0.05 },
    cameraMotion: { min: 0, max: 1, step: 0.05 },
    hudScale: { min: 0.75, max: 1.5, step: 0.05 },
  } satisfies Record<string, RangeDef>,
  fpsLimitOptions: [0, 30, 60, 90, 120, 144, 165, 240],
  targetFpsOptions: [30, 60, 90, 120, 144],
  anisotropyOptions: [1, 2, 4, 8, 16],
  crosshairColors: ['#e8f6ff', '#00e5ff', '#35f2a4', '#ffe14d', '#ff8a1f', '#ff4dd2'],
  /**
   * Settings that are saved but not read by any system yet: the menus show them disabled with the
   * milestone that brings their system (see CLAUDE.md milestone table). Remove an entry when the
   * system lands.
   */
  plannedMilestone: {
    particles: 2,
    hitmarkers: 2,
    damageNumbers: 2,
    aimAssist: 2,
    subtitles: 11,
  },
} as const;
