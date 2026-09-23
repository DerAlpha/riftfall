/**
 * UI tuning: HUD behaviour, debug overlay, dev console, loading screen and menu ranges.
 * Visual styling lives in src/ui/styles.css; values here are the ones TS code needs.
 */
import type { HitZone } from '../core/events';
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
    /** Crosshair fades out between these ADS amounts (0..1); opacity changes below the epsilon are skipped. */
    adsFadeStart: 0.2,
    adsFadeEnd: 0.75,
    opacityEpsilon: 0.02,
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
  /** Zones that count as critical hits (yellow-orange hitmarker and damage numbers). */
  critZones: ['head', 'weakpoint'] as readonly HitZone[],
  /**
   * Hitmarker (X at the crosshair). Per variant: size (scale multiplier), visible time, fade-out at
   * its end, pop (start scale easing to 1 over popTime) and `hold` – a lower-ranked hit cannot
   * replace the marker for this long (kill > crit > hit > shield).
   */
  hitmarker: {
    variants: {
      shield: { size: 0.85, duration: 0.2, fade: 0.1, popScale: 1.2, popTime: 0.05, hold: 0.04 },
      hit: { size: 1, duration: 0.26, fade: 0.14, popScale: 1.5, popTime: 0.06, hold: 0.05 },
      crit: { size: 1.18, duration: 0.34, fade: 0.16, popScale: 1.65, popTime: 0.07, hold: 0.1 },
      kill: { size: 1.6, duration: 0.55, fade: 0.25, popScale: 1.9, popTime: 0.09, hold: 0.22 },
    },
    /** Reduce flashing: gentler pop and a dimmer marker. */
    reducedPopScale: 1.12,
    reducedOpacity: 0.75,
    /** Scale/opacity changes below this are not written to the DOM. */
    epsilon: 0.01,
  },
  /** Floating damage numbers projected from the hit point. */
  damageNumbers: {
    pool: 24,
    /** Hits on one target within this window add up into one number (s). */
    mergeWindow: 0.08,
    lifetime: 0.95,
    fadeTime: 0.35,
    /** A merge rewinds the age to at most this fraction of the lifetime. */
    mergeAgeCap: 0.3,
    risePx: 48,
    jitterPx: 18,
    popScale: 1.45,
    popTime: 0.09,
    critScale: 1.22,
    killScale: 1.35,
    /** Full size up to refDistance (m), then shrinking with distance down to minScale. */
    refDistance: 7,
    minScale: 0.62,
    /** Points closer than this in front of the camera (m) or beyond this NDC range are hidden. */
    minDepth: 0.05,
    offscreenNdc: 1.1,
    /** Screen position changes below this (px) are not written. */
    pxEpsilon: 0.4,
  },
  /** Kill confirmation under the crosshair with a streak counter. */
  killConfirm: {
    duration: 2.1,
    fade: 0.45,
    popScale: 1.35,
    popTime: 0.12,
    /** Kills within this many seconds of each other count as a streak. */
    streakWindow: 4,
    labels: { kill: 'ELIMINIERT', head: 'KOPFSCHUSS', weakpoint: 'KERNTREFFER' },
  },
  ammo: {
    /** Low-ammo warning at or below this fraction of the magazine. */
    lowFraction: 0.25,
    /** Dry fire flashes the counter for this long (s). */
    dryFlashSeconds: 0.28,
    prompts: { reload: 'NACHLADEN', empty: 'KEINE MUNITION' },
  },
  weapon: {
    /** The weapon name flares for this long after a switch (s). */
    switchFlashSeconds: 0.6,
    /** Label of an empty inventory slot. */
    emptySlot: '—',
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
    subtitles: 11,
  },
} as const;
