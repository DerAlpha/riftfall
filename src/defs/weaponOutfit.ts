/**
 * How a carried weapon's Rift Forge tier and attachments show on the first-person viewmodel
 * (M5 package E2): the forge look application (FORGE_LOOKS palettes in defs/forge.ts on the
 * model's materials, the animated rift camo patch), the attachment part library's shared art
 * (reticles, lenses, lasers), where attachments go on a model, and the viewmodel's stow motion
 * (the weapon handed to the Rift Forge). Meters, seconds; colors sRGB hex unless marked linear.
 */

/** Material roles of the procedural weapon models (by material name, see weapons/viewmodels). */
export const OUTFIT_MATERIALS = {
  /** Body materials: tinted, glossier, and carry the camo (kit + per-model energy-weapon shells). */
  body: ['vm-gunmetal', 'vm-darkmetal', 'vm-polymer'] as readonly string[],
  bodyPrefixes: ['vm-ceramic-', 'vm-chitin-'] as readonly string[],
  /** Accent paint panels (recolored to the look's `paint`). */
  paint: ['vm-accentpaint'] as readonly string[],
  /** Per-model emissive materials: accent strips (look accent), heat vents (look heat). */
  accent: 'vm-accent',
  heat: 'vm-heat',
  /** Ammo readouts: lit segments take the look's readout color (shader patch, uniforms only). */
  readout: 'vm-readout',
  /** Unlit energy volumes (energyKit, uniforms uCore / uRim). */
  energyPrefix: 'vm-energy-',
  /** Never touched: the scope depth masks (sniper, marksman, magnified attachments). */
  skip: ['vm-scopemask'] as readonly string[],
} as const;

export const FORGE_VIEW = {
  /**
   * Energy glows move towards the look's accent by this much (0..1); the core is whitened by
   * `coreWhiten` so the hot interior still reads.
   */
  energyTint: 0.8,
  coreWhiten: 0.45,
  /** Camo: how far the base color replaces the body's own (0..1) under full coverage. */
  camoBaseMix: 0.82,
  /** Camo vein color shift speed (rad/s). */
  camoShiftRate: 0.7,
  /** The viewmodel accent light takes the look's accent color at this intensity factor. */
  accentLightScale: 1.6,
} as const;

/** Rig integration (ViewmodelRig). */
export const OUTFIT_RIG = {
  /**
   * The weapon handed to the Rift Forge: lowered along its holster pose (plus `drop`) over
   * `lowerTime`, raised again over `raiseTime` when the machine hands it back.
   */
  stow: { lowerTime: 0.32, raiseTime: 0.42, drop: 0.25 },
  /** The accent light follows the animator's driver boost (charge, beam, spin): intensity × (1 + boost × this). */
  accentLightBoost: 0.3,
  /** Viewmodel muzzle flash light × this with a suppressor fitted. */
  suppressedFlash: 0.3,
} as const;

/** Parts that are a weapon's magazine (first found wins) – magazine attachments ride on it. */
export const MAGAZINE_PARTS: readonly string[] = ['magazine', 'cell', 'drum', 'canister', 'tank'];

/** The attachment part library (weapons/viewmodels/attachments). */
export const ATTACHMENT_ART = {
  /** Reticle / emitter emissive intensity (blooms). */
  reticleIntensity: 7,
  laserLensIntensity: 9,
  /** Transparent lens tint (coated glass) and opacity; the thermal lens is amber. */
  lens: { color: 0x9fd6ff, opacity: 0.1, thermal: 0xffa040, thermalOpacity: 0.22 },
  /** Gyro stabilizer spin (rad/s). */
  gyroSpin: 9,
  /**
   * Magnified optics: eye relief at full ADS from the eye to the ocular (the sight point), so
   * the ocular frames the (zoomed) world like the sniper's scope.
   */
  eyeRelief: { acog: 0.07, scope4x: 0.045, thermal: 0.06 },
  /** Magazine add-ons: extension length as a fraction of the magazine's long side (clamped, m). */
  magazine: {
    extension: 0.32,
    minExtension: 0.018,
    maxExtension: 0.06,
    /** Drum radius from the magazine's long side (clamped, m), feed neck length (m). */
    drumRadius: 0.36,
    minDrum: 0.028,
    maxDrum: 0.062,
    drumNeck: 0.012,
    /** Coupled second magazine: gap beside the first (m). */
    coupleGap: 0.006,
    /** Ammo marker bands (fraction of the long side from the well). */
    bandAt: 0.35,
    bandWidth: 0.012,
  },
  /** Glowing bands of the magazine add-ons per attachment id (emissive, sRGB hex). */
  bands: {
    colors: {
      overpressure: 0xff5a1a,
      apround: 0x6ad8ff,
      capacitor: 0x40e0ff,
      heavyload: 0xffa020,
    } as Readonly<Record<string, number>>,
    fallback: 0x36e4ff,
    intensity: 3.5,
  },
  /** The library's own accent (swapped for the host weapon's accent material when fitted). */
  accentIntensity: 2.2,
} as const;

/** World-space laser sight (LaserSight): dot and beam of a fitted laser. */
export const LASER_SIGHT = {
  /** Max reach of the ray (m); beyond it no dot is drawn. */
  range: 60,
  /** Dot size: world radius per meter of distance (constant screen size), clamped (m). */
  dotPerMeter: 0.0045,
  minDot: 0.012,
  maxDot: 0.09,
  dotIntensity: 6,
  /** Visible beam (targetlaser): core width (m) and intensity; fades out over `fade` m. */
  beamWidth: 0.012,
  beamIntensity: 1.1,
  beamFade: 18,
  /** The dot sits this far in front of the hit surface (m). */
  surfaceOffset: 0.01,
} as const;
