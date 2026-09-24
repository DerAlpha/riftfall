/**
 * "Forschungslabor" (research lab) – the first wave map (M3). Every dimension of the map lives
 * here; src/maps/lab only turns these numbers into geometry, colliders, lights and VFX.
 *
 * Coordinate frame: Y up, meters, the player spawns in the reception (south) looking down -Z
 * ("north"). The map spans x ∈ [-35, 35], z ∈ [-30, 30]:
 *
 *   z=-30 ┌──────────────┬──────────── DOCK ────────────┬──────────────┐
 *         │  LABS        │ loading platform, shutter    │  CRYO        │
 *         │  glass       ├───────── hallS ──────────────┤  pods        │
 *         │  cubicles,   │                              ├── corrCS ────┤
 *         │  specimen    │   ATRIUM (two levels, ring   │  SERVER      │
 *         │  tanks       │   catwalk, rift anomaly,     │  racks       │
 *         │              │   glass skylight)            │              │
 *         ├── corrW ─────┴───────── hallN ──────────────┴─── corrE ────┤
 *   z=30  └────────────────────── RECEPTION (spawn) ──────────────────────┘
 *
 * Walkable space is a set of "spaces" (unions of axis-aligned rects, floor at y = 0). Every space
 * is enclosed by its own walls (thickness `wallThickness` behind the interior faces), so two
 * neighbouring spaces are 2 × wallThickness apart; doorways cut both walls. Doorways with
 * `slot: true` are the purchasable doors of M4 (open in M3), the others are permanent archways.
 * Zones (M4 door gating, spawn point zones) are groups of spaces.
 */
import type { MaterialId } from './materials';
import type {
  DustRegionDef,
  Facing,
  PointLightDef,
  RectDef,
  SpotLightDef,
  Vec2Tuple,
  Vec3Tuple,
} from './level';

// ---------------------------------------------------------------------------
// Material variants (tinted clones of MATERIALS; src/maps/lab/labMaterials.ts)
// ---------------------------------------------------------------------------

/**
 * Tinted / re-tuned clone of a base material. Variant ids are `<baseId>#<name>`: the level kit
 * buckets them separately, surfaces / shadows / bullet penetration come from the base def and
 * the clone shares the base's (procedural) textures.
 */
export interface LabMaterialVariantDef {
  /** Albedo multiplier per channel (linear). */
  readonly tint?: Vec3Tuple;
  /** Multiplier on the base roughness / metalness (with or without maps). */
  readonly roughness?: number;
  readonly metalness?: number;
  readonly envMapIntensity?: number;
  /** Absolute emissive color (linear) and intensity. */
  readonly emissive?: Vec3Tuple;
  readonly emissiveIntensity?: number;
  /** Absolute opacity (< 1 = alpha blended). */
  readonly opacity?: number;
  /** Animated emissive shader patch (LAB_EFFECTS). */
  readonly effect?: 'led' | 'fluid';
  /** Meshes of this variant stay out of the navmesh (ceilings and roof tops are islands otherwise). */
  readonly navIgnore?: boolean;
}

export const LAB_MATERIALS = {
  /** Clinical white wall panels (the base panel is a dark grey). */
  'wall_panel#white': { tint: [1.95, 1.98, 2.02], roughness: 0.8 },
  'wall_panel#frost': { tint: [1.7, 1.95, 2.25], roughness: 0.7 },
  'wall_panel#ceiling': { tint: [1.5, 1.52, 1.56], roughness: 0.9, navIgnore: true },
  'wall_panel_dark#clinical': { tint: [1.5, 1.55, 1.65], roughness: 0.85 },
  'wall_panel_dark#ceiling': { tint: [0.9, 0.92, 0.95], navIgnore: true },
  /** Glossy lab floor: light grey plates, low roughness (the map keeps the variation), dielectric. */
  'floor_panel#gloss': { tint: [3.4, 3.55, 3.75], roughness: 0.42, metalness: 0.3, envMapIntensity: 2.2 },
  'floor_panel#frost': { tint: [3.2, 3.6, 4.2], roughness: 0.38, metalness: 0.25, envMapIntensity: 2.2 },
  'floor_panel#server': { tint: [1.25, 1.3, 1.45], roughness: 0.75 },
  'concrete_wall#atrium': { tint: [1.45, 1.5, 1.62] },
  'concrete_wall#ceiling': { navIgnore: true },
  'concrete_wall#roof': { tint: [0.8, 0.8, 0.82], navIgnore: true },
  'glass#frost': { tint: [1.35, 1.35, 1.35], opacity: 0.4, roughness: 9 },
  'glass#tank': { tint: [0.85, 1.25, 0.95], opacity: 0.2 },
  /** Atrium lantern glazing: its flat top would be a navmesh island above the roof. */
  'glass#lantern': { navIgnore: true },
  'emissive_white#cold': { emissive: [0.72, 0.86, 1.0], emissiveIntensity: 4.5 },
  /** Moonlit night sky seen through the atrium lantern (below the bloom threshold). */
  'emissive_white#sky': { emissive: [0.3, 0.4, 0.58], emissiveIntensity: 1.1, navIgnore: true },
  /** Specimen fluid: large glowing surfaces, kept just above the bloom threshold (no white-out up close). */
  'emissive_cyan#fluid': { emissive: [0.22, 1.0, 0.42], emissiveIntensity: 1.8, effect: 'fluid' },
  'emissive_cyan#led': { emissive: [1, 1, 1], emissiveIntensity: 6, effect: 'led' },
  'emissive_red#violet': { emissive: [0.62, 0.16, 1.0], emissiveIntensity: 7 },
  'emissive_red#dim': { emissiveIntensity: 3 },
} as const satisfies Record<`${MaterialId}#${string}`, LabMaterialVariantDef>;

export type LabVariantId = keyof typeof LAB_MATERIALS;
export type LabMaterialId = MaterialId | LabVariantId;

/** Animated emissive patches of the variant materials (onBeforeCompile, one draw call each). */
export const LAB_EFFECTS = {
  /** Server-rack status LEDs: a dot grid in the (meter) UVs, every dot blinks on its own. */
  led: {
    /** Dots per meter (u = along the strip, v = across). */
    density: [9, 4] as Vec2Tuple,
    /** Dot radius as a fraction of the cell. */
    dotRadius: 0.28,
    /** Blink rate range (Hz) and on-fraction of a blink period. */
    rateMin: 0.25,
    rateMax: 3.5,
    duty: 0.62,
    /** Brightness of an "off" dot and of the strip background. */
    offLevel: 0.06,
    background: 0.02,
    /** Linear RGB palette (weights by order: mostly cyan/green, a few amber/red). */
    palette: [
      [0.25, 0.85, 1.0],
      [0.25, 1.0, 0.45],
      [0.3, 0.9, 1.0],
      [1.0, 0.55, 0.1],
      [1.0, 0.1, 0.08],
    ] as readonly Vec3Tuple[],
    /** Reduce flashing: dots fade smoothly at this rate (Hz) instead of blinking. */
    reducedRate: 0.15,
  },
  /** Specimen-tank fluid: slow brightness waves and rising bubbles (UV v = height in meters). */
  fluid: {
    waveScale: 1.3,
    waveSpeed: 0.35,
    waveAmount: 0.35,
    bubbleCells: [6, 3] as Vec2Tuple,
    bubbleSpeed: 0.45,
    bubbleRadius: 0.16,
    bubbleBoost: 1.8,
  },
} as const;

// ---------------------------------------------------------------------------
// Layout types
// ---------------------------------------------------------------------------

export type LabZoneId = 'reception' | 'atrium' | 'labs' | 'server' | 'cryo' | 'dock';
export type LabThemeId = 'clinical' | 'corridor' | 'atrium' | 'server' | 'cryo' | 'industrial';

export interface LabZoneDef {
  readonly id: LabZoneId;
  /** Player-facing (German). */
  readonly name: string;
}

export interface LabSpaceDef {
  readonly id: string;
  readonly zone: LabZoneId;
  readonly theme: LabThemeId;
  /** Ceiling underside height (m); walls reach it, the ceiling slab sits on top. */
  readonly ceiling: number;
  /** Union of floor rects (overlapping / touching rects are openly connected). */
  readonly rects: readonly RectDef[];
  /** The ceiling is built by the space's own module (atrium roof with the skylight). */
  readonly customCeiling?: boolean;
}

export interface LabDoorwayDef {
  readonly id: string;
  /** Space ids on both sides. */
  readonly a: string;
  readonly b: string;
  /** Passage center on the gap midline between the two walls (floor level). */
  readonly x: number;
  readonly z: number;
  /** Walking direction through the passage: 'x' = along X (the walls run along Z). */
  readonly axis: 'x' | 'z';
  readonly width: number;
  readonly height: number;
  /** M4 purchasable door (open in M3) or a permanent archway. */
  readonly slot: boolean;
  /** Suggested M4 price (points); 0 for archways. */
  readonly costHint: number;
  /** Heavy blast-door frame (hazard stripes) instead of a service door frame. */
  readonly blast?: boolean;
}

export interface LabThemeDef {
  readonly floor: LabMaterialId;
  readonly ceiling: LabMaterialId;
  /** Wall bands from the floor up (`top` is capped at the ceiling). */
  readonly bands: readonly { readonly material: LabMaterialId; readonly top: number }[];
  readonly baseTrim: LabMaterialId;
  /** Emissive strip along the walls (housing + glowing inset). */
  readonly strip: {
    readonly material: LabMaterialId;
    readonly housing: LabMaterialId;
    readonly y: number;
  } | null;
  /** Flush emissive panels on the ceiling in a grid (fake light fixtures, bloom). */
  readonly ceilingPanels: {
    readonly material: LabMaterialId;
    readonly size: Vec2Tuple;
    readonly spacing: Vec2Tuple;
    /** Keep this far from the walls (m). */
    readonly margin: number;
    /** Fraction of dead panels (dark housings; deterministic per position). */
    readonly dead: number;
  } | null;
  readonly doorFrame: LabMaterialId;
}

export type LabSpawnKind = 'rift' | 'vent' | 'floor';

export interface LabSpawnPointDef {
  readonly id: string;
  readonly zone: LabZoneId;
  readonly kind: LabSpawnKind;
  /** Where enemies emerge (feet, on walkable floor). */
  readonly position: Vec3Tuple;
  /**
   * Wall tears / vents: interior facing of the wall they sit on; the wall face is
   * LAB_LAYOUT.spawnTears.wallDistance behind `position`. Floor tears: null.
   */
  readonly wall: Facing | null;
  /**
   * Floor tears: direction enemies face when emerging, into the room (degrees, enemy yaw:
   * 0 = +Z, 90 = +X). Wall tears / vents face along their wall's interior normal.
   */
  readonly yawDeg?: number;
  /** Extra distance of the tear in front of the wall face (m), e.g. in front of the dock shutter. */
  readonly tearOffset?: number;
}

export interface LabTankDef {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly height: number;
}

export interface LabCubicleDef extends RectDef {
  /** Side of the glass front (towards the aisle). */
  readonly front: 'px' | 'nx';
  /** Opening center along Z and its width. */
  readonly opening: number;
  readonly openingWidth: number;
}

export interface LabBoxDef extends RectDef {
  readonly height: number;
}

export interface LabSpotDef extends SpotLightDef {
  /** Order matters: the dust shader registers the first DUST.maxCones cones. */
  readonly id: string;
}

export interface LabPointDef extends PointLightDef {
  readonly id: string;
  /** Slow alarm pulse (emergency lights): rate (Hz) and depth (0..1). */
  readonly pulse?: { readonly rate: number; readonly depth: number };
}

export interface LabFogVolumeDef {
  readonly id: string;
  readonly shape: 'box' | 'ellipsoid';
  /** Box: min / max corners. Ellipsoid: center ± radii. */
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
  /** Extinction (1/m) at the densest point. */
  readonly density: number;
  /** Box: density falls off exp(-heightFalloff · (y - minY)). Ellipsoid: radial exponent. */
  readonly falloff: number;
  /** In-scattered light (linear HDR): what the fog glows like. */
  readonly color: Vec3Tuple;
  /** Fraction of the fog opacity that dims the scene behind (0 = pure glow, 1 = opaque mist). */
  readonly absorption: number;
  /** Soft border (fraction of the extent) against visible box edges. */
  readonly edgeSoftness: number;
  readonly noiseScale: number;
  readonly noiseSpeed: number;
  readonly noiseAmount: number;
  /** QUALITY_LEVELS.volumetrics level required ('low' = everywhere volumetrics are on). */
  readonly minQuality: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// Rift portal VFX (render/vfx/RiftPortal.ts) – shared by maps that show rifts
// ---------------------------------------------------------------------------

export const RIFT_PORTAL = {
  /** Linear HDR colors (multiplied by the intensities below). */
  colors: {
    /** Deep violet body of the tear. */
    core: [0.5, 0.1, 1.0] as Vec3Tuple,
    /** Hot cyan filaments inside the tear. */
    hot: [0.35, 0.95, 1.0] as Vec3Tuple,
    /** Torn rim (cyan-white). */
    rim: [0.75, 0.95, 1.0] as Vec3Tuple,
    /** Outer glow. */
    halo: [0.42, 0.08, 0.9] as Vec3Tuple,
    /** Chromatic fringe outside / inside the rim. */
    fringeOuter: [1.0, 0.12, 0.45] as Vec3Tuple,
    fringeInner: [0.2, 0.45, 1.0] as Vec3Tuple,
  },
  tear: {
    /** Quad extent around the tear (multiples of the tear's half width / half height) for the halo. */
    haloScale: [2.4, 1.3] as Vec2Tuple,
    /** Half width of the open slit at its widest (fraction of the tear half width). */
    open: 0.5,
    /** Lens profile exponent (higher = pointier ends). */
    profile: 0.7,
    /** Domain warp strength and noise scale (in tear half-heights). */
    warp: 0.22,
    noiseScale: 2.4,
    /** Jagged edge amount (fraction of the slit width). */
    jag: 0.45,
    flowSpeed: 0.35,
    /** Idle breathing of the opening. */
    breathe: 0.1,
    breatheRate: 0.55,
    coreIntensity: 0.9,
    hotIntensity: 1.5,
    rimIntensity: 2.4,
    rimSharpness: 10,
    fringeWidth: 0.14,
    fringeIntensity: 1.1,
    haloIntensity: 0.22,
    haloFalloff: 2.6,
    /** A pulse of strength 1 widens the slit by this fraction and scales the brightness by 1 + x. */
    pulseOpen: 0.7,
    pulseIntensity: 2.2,
  },
  /**
   * Pulses decay exponentially (1/s); strengths are clamped to `max`. Reduce flashing: the visible
   * flare (brightness, opening) of every tear, the vortex and the particles is scaled by
   * `reducedScale` (the anomaly's light has its own `large.light.reducedPulseBoost`).
   */
  pulse: { decay: 1.8, max: 2, reducedScale: 0.3 },
  /** Spawn tears (small). */
  small: {
    wall: { width: 1.3, height: 2.6, bottom: 0.12 },
    floor: { width: 1.1, length: 2.4, lift: 0.025 },
    vent: { width: 1.0, height: 0.6 },
    /** Idle brightness (spawn bursts pulse above it); vent slits glow brighter behind the louvers. */
    intensity: 1,
    ventBrightness: 1.2,
    /** Pulse of the tear nearest to a spawned enemy (within `pulseRadius` m); every tear on a wave start. */
    spawnPulse: 1,
    pulseRadius: 5,
    wavePulse: 0.5,
  },
  /** The atrium anomaly (large). */
  large: {
    /** Camera-facing vortex core (radius, m). */
    coreRadius: 3,
    /** Soft halo billboard (radius, m). */
    haloRadius: 7,
    haloIntensity: 0.11,
    /** Tear shards orbiting the core (size m, count, orbit radius m). */
    tearSize: [1.5, 5.5] as Vec2Tuple,
    tearCount: 5,
    tearOrbit: 3.4,
    tearIntensity: 0.7,
    /**
     * Cluster layout jitter (seeded): orbit angle (rad), long-axis tilt (rad), plane twist (rad),
     * relative orbit radius / size spread, vertical spread (m).
     */
    cluster: {
      angleJitter: 0.6,
      tilt: 1.2,
      twist: 0.8,
      orbitSpread: 0.4,
      sizeSpread: 0.45,
      heightSpread: 1.5,
    },
    /** Rotation of the tear cluster (rad/s) and wobble of the planes. */
    rotationSpeed: 0.1,
    wobble: 0.12,
    wobbleRate: 0.23,
    vortex: {
      intensity: 0.55,
      /** Spiral twist (rad per unit log radius) and angular speed (rad/s). */
      twist: 2.6,
      spin: 0.45,
      /** Dark event horizon radius (fraction of the core) and the bright ring width. */
      horizon: 0.26,
      ringWidth: 0.09,
      ringIntensity: 1.5,
      /**
       * Torn ring: radius wobble (fraction of the core), noise scale and drift (1/s); share of the
       * cyan-white rim color in the (otherwise hot cyan) ring.
       */
      ringJag: 0.16,
      ringJagScale: 2.2,
      ringJagSpeed: 0.18,
      ringRimShare: 0.25,
      arms: 3,
    },
    particles: {
      count: 900,
      radiusMin: 1.2,
      radiusMax: 8,
      /** Spiral inflow: seconds per trip from the outer radius to the core. */
      period: 7,
      /** Vertical spread (fraction of the radius) and orbit speed (rad/s at the outer radius). */
      height: 0.35,
      orbitSpeed: 0.9,
      sizeMin: 0.025,
      sizeMax: 0.07,
      minPixelSize: 1.5,
      maxPixelSize: 9,
      intensity: 2.2,
      /** Visible fraction with volumetrics off (a gameplay landmark, only thinned out). */
      offFraction: 0.35,
    },
    light: {
      color: [0.62, 0.22, 1.0] as Vec3Tuple,
      intensity: 70,
      distance: 34,
      decay: 2,
      /** Slow breathing (fraction, Hz) and the extra brightness of a strength-1 pulse. */
      breathe: 0.18,
      breatheRate: 0.37,
      pulseBoost: 1.6,
      /** Reduce flashing: pulses brighten the light only this fraction as much. */
      reducedPulseBoost: 0.35,
    },
    /** Pulse applied by a wave start. */
    wavePulse: 1.5,
  },
} as const;

/** Local fog volumes (src/maps/lab/fogVolumes.ts). */
export const FOG_VOLUME = {
  /** Samples along the view ray through a volume. */
  steps: 6,
  /** Max opacity of one volume (keeps the scene readable through dense fog). */
  maxAlpha: 0.85,
  /**
   * The proxy box is this much smaller than the volume on every side (m): volumes that end at a
   * floor, wall or platform top would otherwise z-fight with it (the density integral still uses
   * the full extent).
   */
  faceInset: 0.03,
  /**
   * Min. vertical distance (m) between a volume's horizontal faces and the standing eye on the
   * floors inside it: the camera must not cross a face through head bob (see LAB_LAYOUT.fogVolumes).
   */
  eyeClearance: 0.25,
} as const;

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

export const LAB_LAYOUT = {
  bounds: { minX: -35, maxX: 35, minZ: -30, maxZ: 30 } as RectDef,
  wallThickness: 0.3,
  ceilingThickness: 0.4,
  /** Loading progress fractions reported while building. */
  progress: { materials: 0.6, geometry: 0.64, lights: 0.84, volumetrics: 0.92 },
  /** Level light budget (spots + points + the rift light); VFX adds VFX.lights.count. */
  maxLights: 16,
  /** Draw-call budget of the level at 'high' (checked by tests, meshes only). */
  maxMeshes: 120,

  zones: [
    { id: 'reception', name: 'Empfang' },
    { id: 'atrium', name: 'Atrium' },
    { id: 'labs', name: 'Laborflügel' },
    { id: 'server', name: 'Serverraum' },
    { id: 'cryo', name: 'Kryolager' },
    { id: 'dock', name: 'Ladedock' },
  ] as readonly LabZoneDef[],

  spaces: [
    {
      id: 'reception',
      zone: 'reception',
      theme: 'clinical',
      ceiling: 5.2,
      rects: [{ minX: -10, maxX: 10, minZ: 19, maxZ: 30 }],
    },
    {
      id: 'hallN',
      zone: 'atrium',
      theme: 'clinical',
      ceiling: 5.0,
      rects: [{ minX: -3, maxX: 3, minZ: 12.6, maxZ: 18.4 }],
    },
    {
      id: 'atrium',
      zone: 'atrium',
      theme: 'atrium',
      ceiling: 15,
      customCeiling: true,
      rects: [{ minX: -14, maxX: 14, minZ: -14, maxZ: 12 }],
    },
    {
      id: 'corrW',
      zone: 'labs',
      theme: 'corridor',
      ceiling: 4.2,
      rects: [
        { minX: -29.4, maxX: -10.6, minZ: 20.8, maxZ: 25.2 },
        { minX: -29.4, maxX: -25, minZ: 10.6, maxZ: 25.2 },
      ],
    },
    {
      id: 'labs',
      zone: 'labs',
      theme: 'clinical',
      ceiling: 4.8,
      rects: [{ minX: -35, maxX: -19, minZ: -26, maxZ: 10 }],
    },
    {
      id: 'corrAL',
      zone: 'labs',
      theme: 'corridor',
      ceiling: 4.2,
      rects: [{ minX: -18.4, maxX: -14.6, minZ: -3.4, maxZ: 1.4 }],
    },
    {
      id: 'corrE',
      zone: 'server',
      theme: 'corridor',
      ceiling: 4.2,
      rects: [
        { minX: 10.6, maxX: 29.4, minZ: 20.8, maxZ: 25.2 },
        { minX: 25, maxX: 29.4, minZ: 12.6, maxZ: 25.2 },
      ],
    },
    {
      id: 'server',
      zone: 'server',
      theme: 'server',
      ceiling: 4.8,
      rects: [{ minX: 19, maxX: 35, minZ: -6, maxZ: 12 }],
    },
    {
      id: 'corrAS',
      zone: 'server',
      theme: 'corridor',
      ceiling: 4.2,
      rects: [{ minX: 14.6, maxX: 18.4, minZ: -3.4, maxZ: 1.4 }],
    },
    {
      id: 'cryo',
      zone: 'cryo',
      theme: 'cryo',
      ceiling: 5.5,
      rects: [{ minX: 19, maxX: 35, minZ: -28, maxZ: -10.6 }],
    },
    {
      id: 'corrCS',
      zone: 'cryo',
      theme: 'corridor',
      ceiling: 4.2,
      rects: [{ minX: 25, maxX: 29.4, minZ: -10, maxZ: -6.6 }],
    },
    {
      id: 'hallS',
      zone: 'dock',
      theme: 'corridor',
      ceiling: 5.4,
      rects: [{ minX: -4, maxX: 4, minZ: -18, maxZ: -14.6 }],
    },
    {
      id: 'dock',
      zone: 'dock',
      theme: 'industrial',
      ceiling: 9,
      rects: [{ minX: -15, maxX: 15, minZ: -30, maxZ: -18.6 }],
    },
    {
      id: 'corrDL',
      zone: 'dock',
      theme: 'corridor',
      ceiling: 4.2,
      rects: [{ minX: -18.4, maxX: -15.6, minZ: -24.4, maxZ: -19.6 }],
    },
    {
      id: 'corrDC',
      zone: 'dock',
      theme: 'corridor',
      ceiling: 4.2,
      rects: [{ minX: 15.6, maxX: 18.4, minZ: -24.4, maxZ: -19.6 }],
    },
  ] as readonly LabSpaceDef[],

  doorways: [
    {
      id: 'door_reception_atrium',
      a: 'reception',
      b: 'hallN',
      x: 0,
      z: 18.7,
      axis: 'z',
      width: 3.6,
      height: 4.0,
      slot: true,
      costHint: 750,
    },
    {
      id: 'arch_hall_atrium',
      a: 'hallN',
      b: 'atrium',
      x: 0,
      z: 12.3,
      axis: 'z',
      width: 5.0,
      height: 4.2,
      slot: false,
      costHint: 0,
    },
    {
      id: 'door_reception_labs',
      a: 'reception',
      b: 'corrW',
      x: -10.3,
      z: 23,
      axis: 'x',
      width: 3.0,
      height: 3.4,
      slot: true,
      costHint: 750,
    },
    {
      id: 'arch_corrw_labs',
      a: 'corrW',
      b: 'labs',
      x: -27.2,
      z: 10.3,
      axis: 'z',
      width: 3.4,
      height: 3.4,
      slot: false,
      costHint: 0,
    },
    {
      id: 'door_reception_server',
      a: 'reception',
      b: 'corrE',
      x: 10.3,
      z: 23,
      axis: 'x',
      width: 3.0,
      height: 3.4,
      slot: true,
      costHint: 750,
    },
    {
      id: 'arch_corre_server',
      a: 'corrE',
      b: 'server',
      x: 27.2,
      z: 12.3,
      axis: 'z',
      width: 3.4,
      height: 3.4,
      slot: false,
      costHint: 0,
    },
    {
      id: 'door_atrium_labs',
      a: 'atrium',
      b: 'corrAL',
      x: -14.3,
      z: -1,
      axis: 'x',
      width: 3.2,
      height: 3.4,
      slot: true,
      costHint: 1000,
    },
    {
      id: 'arch_corral_labs',
      a: 'corrAL',
      b: 'labs',
      x: -18.7,
      z: -1,
      axis: 'x',
      width: 3.2,
      height: 3.4,
      slot: false,
      costHint: 0,
    },
    {
      id: 'door_atrium_server',
      a: 'atrium',
      b: 'corrAS',
      x: 14.3,
      z: -1,
      axis: 'x',
      width: 3.2,
      height: 3.4,
      slot: true,
      costHint: 1000,
    },
    {
      id: 'arch_corras_server',
      a: 'corrAS',
      b: 'server',
      x: 18.7,
      z: -1,
      axis: 'x',
      width: 3.2,
      height: 3.4,
      slot: false,
      costHint: 0,
    },
    {
      id: 'door_atrium_dock',
      a: 'atrium',
      b: 'hallS',
      x: 0,
      z: -14.3,
      axis: 'z',
      width: 4.4,
      height: 4.0,
      slot: true,
      costHint: 1250,
      blast: true,
    },
    {
      id: 'arch_halls_dock',
      a: 'hallS',
      b: 'dock',
      x: 0,
      z: -18.3,
      axis: 'z',
      width: 5.6,
      height: 4.8,
      slot: false,
      costHint: 0,
    },
    {
      id: 'door_dock_labs',
      a: 'corrDL',
      b: 'labs',
      x: -18.7,
      z: -22,
      axis: 'x',
      width: 3.0,
      height: 3.4,
      slot: true,
      costHint: 1000,
    },
    {
      id: 'arch_dock_corrdl',
      a: 'dock',
      b: 'corrDL',
      x: -15.3,
      z: -22,
      axis: 'x',
      width: 3.0,
      height: 3.4,
      slot: false,
      costHint: 0,
    },
    {
      id: 'door_dock_cryo',
      a: 'corrDC',
      b: 'cryo',
      x: 18.7,
      z: -22,
      axis: 'x',
      width: 3.0,
      height: 3.4,
      slot: true,
      costHint: 1250,
    },
    {
      id: 'arch_dock_corrdc',
      a: 'dock',
      b: 'corrDC',
      x: 15.3,
      z: -22,
      axis: 'x',
      width: 3.0,
      height: 3.4,
      slot: false,
      costHint: 0,
    },
    {
      id: 'arch_cryo_corrcs',
      a: 'cryo',
      b: 'corrCS',
      x: 27.2,
      z: -10.3,
      axis: 'z',
      width: 3.4,
      height: 3.4,
      slot: false,
      costHint: 0,
    },
    {
      id: 'door_cryo_server',
      a: 'corrCS',
      b: 'server',
      x: 27.2,
      z: -6.3,
      axis: 'z',
      width: 3.2,
      height: 3.4,
      slot: true,
      costHint: 1000,
    },
  ] as readonly LabDoorwayDef[],

  /** Doorway frames (both sides of every passage). */
  doorFrame: {
    postWidth: 0.3,
    /** Protrusion from the wall face (m). */
    depth: 0.22,
    lintelHeight: 0.3,
    hazardWidth: 0.1,
    /** Status light above M4 door slots (size x/y/z). */
    statusLight: [0.6, 0.1, 0.06] as Vec3Tuple,
    statusGap: 0.08,
    /** Threshold plate in the passage (hazard stripes on blast doors). */
    thresholdInset: 0.05,
  },

  themes: {
    clinical: {
      floor: 'floor_panel#gloss',
      ceiling: 'wall_panel#ceiling',
      bands: [
        { material: 'wall_panel_dark#clinical', top: 0.9 },
        { material: 'wall_panel#white', top: 99 },
      ],
      baseTrim: 'trim_metal',
      strip: { material: 'emissive_cyan', housing: 'trim_metal', y: 2.9 },
      ceilingPanels: {
        material: 'emissive_white#cold',
        size: [1.8, 0.3],
        spacing: [3.4, 3.2],
        margin: 1.2,
        dead: 0.55,
      },
      doorFrame: 'trim_metal',
    },
    corridor: {
      floor: 'rubber',
      ceiling: 'wall_panel_dark#ceiling',
      bands: [
        { material: 'wall_panel_dark', top: 1.1 },
        { material: 'wall_panel', top: 99 },
      ],
      baseTrim: 'trim_metal',
      // Low red emergency strip: the corridors are running on emergency power.
      strip: { material: 'emissive_red', housing: 'trim_metal', y: 0.32 },
      ceilingPanels: {
        material: 'emissive_red#dim',
        size: [0.9, 0.16],
        spacing: [5, 99],
        margin: 1.4,
        dead: 0.2,
      },
      doorFrame: 'trim_metal',
    },
    atrium: {
      floor: 'floor_panel#gloss',
      ceiling: 'concrete_wall#roof',
      bands: [
        { material: 'wall_panel_dark#clinical', top: 0.9 },
        { material: 'wall_panel#white', top: 5.3 },
        { material: 'concrete_wall#atrium', top: 99 },
      ],
      baseTrim: 'trim_metal',
      strip: { material: 'emissive_cyan', housing: 'trim_metal', y: 3.9 },
      ceilingPanels: null,
      doorFrame: 'trim_metal',
    },
    server: {
      floor: 'floor_panel#server',
      ceiling: 'wall_panel_dark#ceiling',
      bands: [{ material: 'wall_panel_dark', top: 99 }],
      baseTrim: 'trim_metal',
      strip: { material: 'emissive_cyan', housing: 'trim_metal', y: 0.26 },
      ceilingPanels: {
        material: 'emissive_white#cold',
        size: [0.2, 3.2],
        spacing: [8.2, 4.6],
        margin: 2.2,
        dead: 0.35,
      },
      doorFrame: 'trim_metal',
    },
    cryo: {
      floor: 'floor_panel#frost',
      ceiling: 'wall_panel#ceiling',
      bands: [
        { material: 'wall_panel_dark#clinical', top: 0.9 },
        { material: 'wall_panel#frost', top: 99 },
      ],
      baseTrim: 'trim_metal',
      strip: { material: 'emissive_cyan', housing: 'trim_metal', y: 3.4 },
      ceilingPanels: {
        material: 'emissive_white#cold',
        size: [0.3, 2.2],
        spacing: [3, 5],
        margin: 1.6,
        dead: 0.3,
      },
      doorFrame: 'trim_metal',
    },
    industrial: {
      floor: 'floor_concrete',
      ceiling: 'concrete_wall#ceiling',
      bands: [
        { material: 'wall_panel_dark', top: 1.2 },
        { material: 'concrete_wall', top: 99 },
      ],
      baseTrim: 'trim_metal',
      strip: { material: 'emissive_orange', housing: 'trim_metal', y: 3.1 },
      ceilingPanels: null,
      doorFrame: 'painted_hazard',
    },
  } as Readonly<Record<LabThemeId, LabThemeDef>>,

  /**
   * Player spawn: south of the reception center, facing the atrium door (the anomaly glows at the
   * end of the hall). Every reception spawn point lies beyond SPAWN_POINTS.minDistance from here:
   * with the M4 doors closed the reception is the only active zone.
   */
  spawn: { position: [0, 0, 24] as Vec3Tuple, yawDeg: 0 },

  // --- reception ------------------------------------------------------------------------------
  reception: {
    /** Reception counter (mantle-able cover) with a glowing edge, screens on the wall behind. */
    desk: { minX: -8.2, maxX: -3.4, minZ: 25.4, maxZ: 26.4, height: 1.1 } as LabBoxDef,
    deskGlow: { height: 0.04, drop: 0.08 },
    planters: [
      { minX: 3.6, maxX: 6.4, minZ: 21.2, maxZ: 22.4, height: 0.9 },
      { minX: 5.8, maxX: 7.2, minZ: 27.6, maxZ: 29.0, height: 0.9 },
    ] as readonly LabBoxDef[],
    /** Planters: soil bed inset from the rim, green grow-light bed (inset, height) on the soil. */
    foliageInset: 0.12,
    growLight: { inset: 0.24, height: 0.04 },
    screens: [
      { position: [4.6, 2.3, 19], facing: 'pz', width: 2.4, height: 1.3 },
      { position: [-5.8, 2.2, 30], facing: 'nz', width: 3.2, height: 1.6 },
      { position: [-10, 2.4, 27.4], facing: 'px', width: 2.2, height: 1.2 },
    ] as readonly { position: Vec3Tuple; facing: Facing; width: number; height: number }[],
    pillars: [
      [-5.5, 22.6],
      [5.5, 25.4],
    ] as readonly Vec2Tuple[],
    pillarSize: 0.7,
    pillarBands: [1.2, 3.8] as readonly number[],
    /** M4 wall-buy placeholder: framed board with a glowing weapon outline. */
    wallBuy: {
      id: 'wallbuy_reception_rifle',
      position: [-6, 1.55, 19] as Vec3Tuple,
      facing: 'pz' as Facing,
      width: 2.2,
      height: 0.95,
      weaponHint: 'rifle',
      costHint: 1000,
      frame: 0.06,
      plateDepth: 0.05,
      /** Outline strip thickness (m) and the rifle silhouette in board units (-0.5..0.5). */
      line: 0.035,
      silhouette: [
        // [centerX, centerY, width, height] of glowing bars
        [-0.02, 0.05, 0.56, 0.16],
        [0.38, 0.09, 0.26, 0.05],
        [-0.38, 0.0, 0.22, 0.2],
        [-0.02, -0.18, 0.08, 0.26],
        [0.12, -0.12, 0.06, 0.16],
        [0.05, 0.22, 0.2, 0.06],
      ] as readonly (readonly [number, number, number, number])[],
      pricePlate: { width: 0.5, height: 0.12, offsetY: -0.62 },
    },
  },

  // --- atrium ---------------------------------------------------------------------------------
  atrium: {
    center: [0, -1] as Vec2Tuple,
    roofThickness: 0.5,
    ring: {
      deckY: 5,
      thickness: 0.3,
      width: 3,
      fasciaHeight: 0.42,
      fasciaDepth: 0.08,
      /** Emissive strip under the inner deck edge. */
      underglow: { height: 0.05, margin: 0.3 },
      supports: [
        [-11, -11],
        [-5, -11],
        [5, -11],
        [11, -11],
        [-11, 9],
        [-5, 9],
        [5, 9],
        [11, 9],
        [-11, -5.5],
        [-11, 3.5],
        [11, -5.5],
        [11, 3.5],
      ] as readonly Vec2Tuple[],
      supportSize: 0.5,
      supportCap: { height: 0.18, extra: 0.08 },
    },
    /** Stairs from the floor up to the ring (rise = ring.deckY; `dir` = direction they rise to). */
    stairs: [
      { minX: -9.6, maxX: -7.2, topZ: 9, dir: 1 },
      { minX: 7.2, maxX: 9.6, topZ: -11, dir: -1 },
    ] as readonly { minX: number; maxX: number; topZ: number; dir: 1 | -1 }[],
    /** Ramp rising towards -X up to the west ring edge. */
    ramp: { minZ: -10.4, maxZ: -8, topX: -11, slopeDeg: 30 },
    /** Central containment dais (walkable step) with emitter pylons under the anomaly. */
    dais: {
      minX: -4,
      maxX: 4,
      minZ: -5,
      maxZ: 3,
      height: 0.3,
      /** Glowing containment ring on the dais (inset from its edge, width). */
      ringInset: 0.6,
      ringWidth: 0.12,
      hazardWidth: 0.25,
    },
    pylons: {
      positions: [
        [-3.2, -4.2],
        [3.2, -4.2],
        [-3.2, 2.2],
        [3.2, 2.2],
      ] as readonly Vec2Tuple[],
      size: 0.9,
      height: 3.6,
      /** Emitter head leaning towards the anomaly. */
      headSize: [0.55, 1.6, 0.55] as Vec3Tuple,
      headTiltDeg: 32,
      bands: [0.9, 2.4] as readonly number[],
      /** Base cap / glow band overhang (m), glowing emitter tip (height m, fraction of the head). */
      capExtra: 0.12,
      bandExtra: 0.02,
      tipHeight: 0.18,
      tipScale: 0.6,
    },
    /** Roof opening with a raised glass lantern and a steel mullion grid (sun shafts per pane). */
    skylight: {
      minX: -6,
      maxX: 6,
      minZ: -7,
      maxZ: 5,
      panes: [4, 4] as Vec2Tuple,
      mullion: 0.28,
      mullionDepth: 0.45,
      /** Roof ribs over the lantern glass (fraction of the mullion size). */
      ribScale: 0.6,
      lanternHeight: 2.2,
      glassThickness: 0.04,
      /** Shaft brightness relative to VOLUMETRIC_SHAFT.intensity × sun (the opening is large). */
      shaftIntensity: 0.3,
      /** Emissive "sky" above the lantern (night cloud glow). */
      skyLift: 1.4,
      skyMargin: 1.5,
    },
    rift: { position: [0, 7.5, -1] as Vec3Tuple },
    planters: [
      { minX: 5.6, maxX: 8.6, minZ: 6, maxZ: 7.2, height: 1.0 },
      { minX: 9.4, maxX: 10.6, minZ: 1.6, maxZ: 4.6, height: 1.0 },
      { minX: -8.6, maxX: -5.6, minZ: -5.6, maxZ: -4.4, height: 1.0 },
    ] as readonly LabBoxDef[],
    /** Vertical emissive lines on the upper walls (y range, spacing along the wall, width). */
    wallLines: { y0: 5.8, y1: 14.2, spacing: 7, width: 0.14, margin: 3 },
    screens: [
      { position: [-7, 7.2, -14], facing: 'pz', width: 4, height: 2.2 },
      { position: [7, 7.2, 12], facing: 'nz', width: 4, height: 2.2 },
    ] as readonly { position: Vec3Tuple; facing: Facing; width: number; height: number }[],
  },

  // --- labs -----------------------------------------------------------------------------------
  labs: {
    cubicles: [
      { minX: -35, maxX: -29.6, minZ: -20, maxZ: -10, front: 'px', opening: -15, openingWidth: 2.2 },
      { minX: -35, maxX: -29.6, minZ: -7, maxZ: 3, front: 'px', opening: -2, openingWidth: 2.2 },
      { minX: -24.8, maxX: -19, minZ: -17, maxZ: -6, front: 'nx', opening: -11.5, openingWidth: 2.2 },
      { minX: -24.8, maxX: -19, minZ: 3.6, maxZ: 10, front: 'nx', opening: 6.8, openingWidth: 2.2 },
    ] as readonly LabCubicleDef[],
    partition: {
      thickness: 0.15,
      glassBottom: 0.9,
      glassTop: 3.0,
      mullionSpacing: 1.6,
      mullionWidth: 0.07,
      glassThickness: 0.03,
      /** Mullions / header trim stand proud of the partition, the sill a little more (m). */
      mullionExtra: 0.02,
      sillExtra: 0.04,
      /** Cyan status strip above the opening: lift above the glass top, height. */
      statusLift: 0.25,
      statusHeight: 0.06,
    },
    /** Glowing guide line down the aisle: half width, distance from the south / north wall. */
    aisleLine: { halfWidth: 0.04, startMargin: 1.5, endMargin: 0.4 },
    tanks: [
      { x: -33.6, z: -17.8, radius: 0.55, height: 2.7 },
      { x: -33.6, z: -12.2, radius: 0.55, height: 2.7 },
      { x: -33.6, z: -4.8, radius: 0.55, height: 2.7 },
      { x: -33.6, z: 0.8, radius: 0.55, height: 2.7 },
      { x: -20.4, z: -15, radius: 0.55, height: 2.7 },
      { x: -20.4, z: -8, radius: 0.55, height: 2.7 },
      { x: -20.4, z: 5.4, radius: 0.55, height: 2.7 },
      { x: -20.4, z: 8.6, radius: 0.55, height: 2.7 },
      // Specimen hall at the north end: big tanks.
      { x: -33.2, z: -23.8, radius: 0.8, height: 3.6 },
      { x: -30.6, z: -23.8, radius: 0.8, height: 3.6 },
    ] as readonly LabTankDef[],
    tank: {
      baseHeight: 0.35,
      capHeight: 0.3,
      rimExtra: 0.09,
      fluidInset: 0.05,
      fluidTopGap: 0.25,
      /** Fluid starts this far above the base (no z-fighting with the base cap). */
      fluidLift: 0.02,
      /** Dark specimen silhouette inside (fraction of the radius / fluid height). */
      specimenRadius: 0.38,
      specimenHeight: 0.55,
      pipeRadius: 0.07,
    },
    benches: [
      { minX: -35, maxX: -34.2, minZ: -16.2, maxZ: -13.8, height: 0.95 },
      { minX: -35, maxX: -34.2, minZ: -3.2, maxZ: -0.8, height: 0.95 },
      { minX: -19.8, maxX: -19, minZ: -12.7, maxZ: -10.3, height: 0.95 },
      { minX: -24.2, maxX: -21.8, minZ: -25.6, maxZ: -24.8, height: 0.95 },
    ] as readonly LabBoxDef[],
    benchScreen: { width: 0.9, height: 0.5, lift: 0.3, depth: 0.04 },
  },

  // --- server ---------------------------------------------------------------------------------
  server: {
    rows: [-4, 1.8, 6.4] as readonly number[],
    /** Rack blocks along X; the aisles beside them (walls included) stay enemy-walkable (≥ 1.2 m). */
    blocks: [
      [20.5, 25.2],
      [29.2, 33.5],
    ] as readonly Vec2Tuple[],
    rackDepth: 0.8,
    rackHeight: 2.3,
    cabinetWidth: 0.6,
    /** LED strips on both rack faces: count per cabinet, strip size (m). */
    ledStrips: [0.7, 1.15, 1.6] as readonly number[],
    ledHeight: 0.07,
    /** LED strips stop this far before the rack ends; cabinet dividers; top cap overhang (m). */
    ledMargin: 0.05,
    dividerWidth: 0.04,
    capOverhang: 0.03,
    /** Cable-tray hangers: inset from the rack ends, bar size (m). */
    hangerInset: 0.3,
    hangerSize: 0.04,
    /** Cable trays over the rows. */
    trayY: 3.4,
    trayWidth: 0.5,
    trayHeight: 0.08,
  },

  // --- cryo -----------------------------------------------------------------------------------
  cryo: {
    podX: [22.5, 25.5, 28.5, 31.5] as readonly number[],
    podZ: [-24.5, -14.5] as readonly number[],
    pod: {
      radius: 0.62,
      height: 2.5,
      baseHeight: 0.3,
      capHeight: 0.25,
      rimExtra: 0.08,
      glowHeight: 0.05,
      /** Glow ring radius beyond the pod glass (m). */
      glowExtra: 0.05,
      /** Frozen occupant silhouette. */
      bodyRadius: 0.26,
      bodyHeight: 1.75,
      pipeRadius: 0.06,
    },
  },

  // --- dock -----------------------------------------------------------------------------------
  dock: {
    /** Raised loading platform along the north wall (mantle-able), with a ramp for enemies. */
    platform: { minX: -12, maxX: 12, minZ: -30, maxZ: -26.5, height: 1.2, hazardDepth: 0.3 },
    ramp: { minX: 9, maxX: 12, slopeDeg: 20 },
    shutter: {
      minX: -5,
      maxX: 5,
      top: 7.2,
      slat: 0.26,
      gap: 0.04,
      depth: 0.1,
      frame: 0.35,
      /** Red warning light over the frame: size, gap above the frame, depth from the wall. */
      alarm: { size: [1.2, 0.12, 0.1] as Vec3Tuple, lift: 0.15, offset: 0.08 },
    },
    crates: [
      { position: [-8.5, 0.75, -21.4], size: 1.5, yawDeg: 0, dynamic: false },
      { position: [-7.0, 0.75, -21.4], size: 1.5, yawDeg: 0, dynamic: false },
      { position: [-8.5, 2.25, -21.4], size: 1.5, yawDeg: 0, dynamic: false },
      { position: [6.2, 0.6, -24.6], size: 1.2, yawDeg: 0, dynamic: false },
      { position: [7.4, 0.6, -24.6], size: 1.2, yawDeg: 0, dynamic: false },
      { position: [-9.6, 1.8, -28.6], size: 1.2, yawDeg: 0, dynamic: false },
      { position: [-10.9, 1.8, -28.4], size: 1.2, yawDeg: 8, dynamic: false },
      // Dynamic crates (shots push them) stay off the enemy routes: the navmesh does not know
      // where they end up, so enemies would walk through them.
      { position: [-12.9, 0.5, -19.5], size: 1.0, yawDeg: 18, dynamic: true },
      { position: [12.9, 0.4, -19.4], size: 0.8, yawDeg: -12, dynamic: true },
      { position: [-7.9, 1.6, -29.2], size: 0.8, yawDeg: 25, dynamic: true },
      { position: [6.8, 1.7, -24.6], size: 1.0, yawDeg: -8, dynamic: true },
    ] as readonly { position: Vec3Tuple; size: number; yawDeg: number; dynamic: boolean }[],
    /** Overhead crane girders (visual silhouettes). */
    crane: { y: 7.6, beams: [-26, -21.5] as readonly number[], size: [0.5, 0.7] as Vec2Tuple },
    bollards: [
      [-12.6, -26.2],
      [12.6, -26.2],
    ] as readonly Vec2Tuple[],
    bollard: { height: 1, radius: 0.18 },
  },

  /** Wall-mounted pipes (per space side) for silhouettes. */
  pipes: [
    { from: [-34.7, 4.2, -25.7], to: [-34.7, 4.2, 9.7], radius: 0.14, wall: 'px' },
    { from: [34.7, 4.3, -5.7], to: [34.7, 4.3, 11.7], radius: 0.18, wall: 'nx' },
    { from: [34.7, 4.9, -27.7], to: [34.7, 4.9, -10.9], radius: 0.2, wall: 'nx' },
    { from: [-14.7, 8.2, -29.7], to: [14.7, 8.2, -29.7], radius: 0.24, wall: 'pz' },
    { from: [-13.7, 14.2, -13.7], to: [13.7, 14.2, -13.7], radius: 0.22, wall: 'pz' },
  ] as readonly { from: Vec3Tuple; to: Vec3Tuple; radius: number; wall: Facing }[],
  pipeSupportSpacing: 4,
  pipeFlangeSpacing: 6,

  spawnPoints: [
    { id: 'rift_reception_east', zone: 'reception', kind: 'rift', position: [8.8, 0, 27.5], wall: 'nx' },
    { id: 'vent_reception_south', zone: 'reception', kind: 'vent', position: [-8.4, 0, 28.8], wall: 'nz' },
    { id: 'rift_atrium_west', zone: 'atrium', kind: 'rift', position: [-12.8, 0, 6.5], wall: 'px' },
    { id: 'rift_atrium_east', zone: 'atrium', kind: 'rift', position: [12.8, 0, -6.5], wall: 'nx' },
    { id: 'vent_atrium_north', zone: 'atrium', kind: 'vent', position: [-8, 0, -12.8], wall: 'pz' },
    {
      id: 'floor_atrium_ne',
      zone: 'atrium',
      kind: 'floor',
      position: [5.2, 0, -9.4],
      wall: null,
      // Facing the dais (atrium center).
      yawDeg: -32,
    },
    { id: 'rift_labs_north', zone: 'labs', kind: 'rift', position: [-27.2, 0, -24.8], wall: 'pz' },
    { id: 'rift_labs_west', zone: 'labs', kind: 'rift', position: [-33.8, 0, 6.5], wall: 'px' },
    {
      id: 'floor_labs_east',
      zone: 'labs',
      kind: 'floor',
      position: [-21.6, 0, -20.2],
      wall: null,
      // Facing down the cubicle aisle.
      yawDeg: -35,
    },
    { id: 'vent_corridor_west', zone: 'labs', kind: 'vent', position: [-19, 0, 24], wall: 'nz' },
    { id: 'rift_server_east', zone: 'server', kind: 'rift', position: [33.8, 0, 9.4], wall: 'nx' },
    { id: 'vent_server_west', zone: 'server', kind: 'vent', position: [20.2, 0, 4.1], wall: 'px' },
    { id: 'vent_corridor_east', zone: 'server', kind: 'vent', position: [19, 0, 22], wall: 'pz' },
    { id: 'rift_cryo_east', zone: 'cryo', kind: 'rift', position: [33.8, 0, -19.5], wall: 'nx' },
    { id: 'vent_cryo_north', zone: 'cryo', kind: 'vent', position: [33, 0, -26.8], wall: 'pz' },
    {
      id: 'rift_dock_shutter',
      zone: 'dock',
      kind: 'rift',
      position: [0, 1.2, -28.8],
      wall: 'pz',
      tearOffset: 0.14,
    },
    { id: 'vent_dock_west', zone: 'dock', kind: 'vent', position: [-13.8, 0, -27.5], wall: 'px' },
    // Facing across the dock floor.
    { id: 'floor_dock_east', zone: 'dock', kind: 'floor', position: [9, 0, -21], wall: null, yawDeg: -90 },
  ] as readonly LabSpawnPointDef[],

  /** Spawn tear placement relative to the spawn point. */
  spawnTears: {
    /** Wall tears / vents sit this far behind the spawn point (on the wall face). */
    wallDistance: 1.2,
    /** Tear quad in front of the wall face (m). */
    faceOffset: 0.035,
    /** Wall trims and light strips stop this far beside a tear / vent / the dock shutter (m). */
    trimGap: 0.25,
    /** Vent grate: center height, width, slit layout. */
    vent: { y: 0.55, width: 1.3, slits: 4, slitHeight: 0.1, spacing: 0.2 },
  },

  lights: {
    spots: [
      {
        id: 'atrium_nw',
        position: [-13.2, 13.2, 10.6],
        target: [-6, 0, 3.5],
        color: [0.78, 0.9, 1],
        intensity: 650,
        distance: 32,
        angleDeg: 19,
        penumbra: 0.55,
        shadowPriority: 1,
        volumetric: true,
        coneIntensity: 0.75,
        flicker: false,
        hanging: false,
      },
      {
        id: 'atrium_se',
        position: [13.2, 13.2, -12.6],
        target: [6.5, 0, -5.5],
        color: [0.78, 0.9, 1],
        intensity: 650,
        distance: 32,
        angleDeg: 19,
        penumbra: 0.55,
        shadowPriority: 2,
        volumetric: true,
        coneIntensity: 0.75,
        flicker: false,
        hanging: false,
      },
      {
        id: 'dock_west',
        position: [-6, 8.6, -23],
        target: [-7, 0, -24.5],
        color: [1, 0.64, 0.32],
        intensity: 720,
        distance: 22,
        angleDeg: 32,
        penumbra: 0.5,
        shadowPriority: 4,
        volumetric: true,
        coneIntensity: 0.8,
        flicker: false,
        hanging: true,
      },
      {
        id: 'dock_east',
        position: [6, 8.6, -25],
        target: [5, 1.2, -27.5],
        color: [1, 0.64, 0.32],
        intensity: 620,
        distance: 22,
        angleDeg: 32,
        penumbra: 0.5,
        shadowPriority: null,
        volumetric: true,
        coneIntensity: 0.8,
        flicker: true,
        hanging: true,
      },
      {
        id: 'reception_desk',
        position: [-2.4, 4.95, 24.2],
        target: [-4.6, 0, 24.8],
        color: [1, 0.95, 0.88],
        intensity: 200,
        distance: 14,
        angleDeg: 34,
        penumbra: 0.6,
        shadowPriority: 3,
        volumetric: true,
        coneIntensity: 0.5,
        flicker: false,
        hanging: false,
      },
      {
        id: 'labs_north',
        position: [-27.2, 4.55, -18.5],
        target: [-27.2, 0, -19.5],
        color: [0.85, 0.95, 1],
        intensity: 190,
        distance: 12,
        angleDeg: 40,
        penumbra: 0.6,
        shadowPriority: 5,
        volumetric: true,
        coneIntensity: 0.5,
        flicker: false,
        hanging: false,
      },
      {
        id: 'cryo_center',
        position: [27, 5.25, -19.5],
        target: [27, 0, -19.5],
        color: [0.55, 0.8, 1],
        intensity: 260,
        distance: 13,
        angleDeg: 44,
        penumbra: 0.6,
        shadowPriority: 6,
        volumetric: true,
        coneIntensity: 0.55,
        flicker: false,
        hanging: false,
      },
      {
        id: 'labs_south',
        position: [-27.2, 4.55, -1],
        target: [-27.2, 0, -1],
        color: [0.85, 0.95, 1],
        intensity: 170,
        distance: 12,
        angleDeg: 40,
        penumbra: 0.6,
        shadowPriority: null,
        volumetric: true,
        coneIntensity: 0.45,
        flicker: true,
        hanging: false,
      },
      {
        id: 'reception_wallbuy',
        position: [-6, 4.95, 21.2],
        target: [-6, 1.4, 19.2],
        color: [0.75, 0.9, 1],
        intensity: 140,
        distance: 9,
        angleDeg: 26,
        penumbra: 0.5,
        shadowPriority: null,
        volumetric: true,
        coneIntensity: 0.4,
        flicker: false,
        hanging: false,
      },
      {
        id: 'server_aisle',
        position: [27.2, 4.55, 4.1],
        target: [27.2, 0, 4.1],
        color: [0.6, 0.8, 1],
        intensity: 240,
        distance: 11,
        angleDeg: 48,
        penumbra: 0.6,
        shadowPriority: null,
        volumetric: true,
        coneIntensity: 0.35,
        flicker: false,
        hanging: false,
      },
    ] as readonly LabSpotDef[],
    points: [
      {
        id: 'server_glow',
        position: [22, 3, 4.1],
        color: [0.3, 0.8, 1],
        intensity: 22,
        distance: 10,
        flicker: false,
      },
      {
        id: 'cryo_glow',
        position: [31, 3.4, -12.6],
        color: [0.4, 0.9, 1],
        intensity: 20,
        distance: 10,
        flicker: false,
      },
      {
        id: 'corridor_west_alarm',
        position: [-20, 3.7, 23],
        color: [1, 0.08, 0.04],
        intensity: 18,
        distance: 11,
        flicker: false,
        pulse: { rate: 0.45, depth: 0.7 },
      },
      {
        id: 'corridor_east_alarm',
        position: [20, 3.7, 23],
        color: [1, 0.08, 0.04],
        intensity: 18,
        distance: 11,
        flicker: false,
        pulse: { rate: 0.45, depth: 0.7 },
      },
    ] as readonly LabPointDef[],
    /** Reduce flashing: alarm pulses only dim this much, this slowly. */
    reducedPulse: { rate: 0.12, depth: 0.2 },
    /** Phase offset between consecutive pulsing lights (cycles): alarms do not blink in sync. */
    pulsePhaseStep: 0.37,
    /** Arm from a wall-mounted fixture back to the nearest wall (fixtures closer than maxReach). */
    bracket: { maxReach: 1.6, size: 0.12 },
  },

  dust: [
    { min: [-13.5, 0.3, -13.5], max: [13.5, 14.5, 11.5], share: 0.4 },
    { min: [-9.5, 0.3, 19.5], max: [9.5, 5, 29.5], share: 0.1 },
    { min: [-34.5, 0.3, -25.5], max: [-19.5, 4.6, 9.5], share: 0.14 },
    { min: [-14.5, 0.3, -29.5], max: [14.5, 8.6, -19], share: 0.22 },
    { min: [19.5, 0.3, -27.5], max: [34.5, 5.2, -11], share: 0.14 },
  ] as readonly DustRegionDef[],

  /**
   * Local fog volumes. Their horizontal faces stay clear of the standing eye height on the floor,
   * the dais and the dock platform (FOG_VOLUME.eyeClearance): the shader shades a volume from
   * inside and from outside differently, so head bob must never flip the camera across a face.
   * Without scene depth an object inside a volume is hazed by the whole chord behind it (seen from
   * outside): volumes enemies walk through stay thin, or their legs turn ghostly.
   */
  fogVolumes: [
    {
      id: 'cryo_mist',
      shape: 'box',
      min: [19, 0, -28],
      max: [35, 1.2, -10.6],
      density: 0.4,
      falloff: 3,
      color: [0.14, 0.23, 0.32],
      absorption: 0.4,
      edgeSoftness: 0.12,
      noiseScale: 0.45,
      noiseSpeed: 0.12,
      noiseAmount: 0.65,
      minQuality: 'low',
    },
    {
      id: 'rift_haze',
      shape: 'ellipsoid',
      min: [-9, 2.3, -10],
      max: [9, 14, 8],
      density: 0.055,
      falloff: 1.6,
      color: [0.28, 0.07, 0.6],
      absorption: 0.12,
      edgeSoftness: 0.2,
      noiseScale: 0.28,
      noiseSpeed: 0.2,
      noiseAmount: 0.55,
      minQuality: 'low',
    },
    {
      id: 'dock_haze',
      shape: 'box',
      min: [-15, 0, -30],
      max: [15, 1.2, -18.6],
      density: 0.13,
      falloff: 2.4,
      color: [0.22, 0.16, 0.11],
      absorption: 0.35,
      edgeSoftness: 0.1,
      noiseScale: 0.35,
      noiseSpeed: 0.1,
      noiseAmount: 0.6,
      minQuality: 'medium',
    },
  ] as readonly LabFogVolumeDef[],
} as const;

export type LabLayout = typeof LAB_LAYOUT;
