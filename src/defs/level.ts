/**
 * Level layout + level-kit/VFX tuning. The builders in src/world only turn these numbers into
 * geometry, colliders and lights – every dimension lives here (meters, degrees where noted).
 *
 * TEST_ROOM_LAYOUT ("Calibration Hall", ~60 x 60 m). Coordinate frame: Y up, spawn looks down -Z
 * ("north"). Zones: central arena with pillars, mezzanine ring (stairs south, ramp west, bridge
 * east), east sprint/slide corridor with a downhill ramp from the control-block deck, north
 * mantle course in front of the calibration wall, west double-jump platforms and dash-gap pit.
 */
import type { MaterialId } from './materials';
import type { TargetPlacementDef } from './targets';

export type Vec3Tuple = readonly [number, number, number];
export type Vec2Tuple = readonly [number, number];
/** Direction a wall face points to (interior side): +X, -X, +Z, -Z. */
export type Facing = 'px' | 'nx' | 'pz' | 'nz';

export interface RectDef {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface SpotLightDef {
  readonly position: Vec3Tuple;
  readonly target: Vec3Tuple;
  /** Linear RGB. */
  readonly color: Vec3Tuple;
  /** Candela. */
  readonly intensity: number;
  readonly distance: number;
  readonly angleDeg: number;
  readonly penumbra: number;
  /** Lower = more important for the local shadow budget; null = never casts shadows. */
  readonly shadowPriority: number | null;
  readonly volumetric: boolean;
  /** Multiplier on VOLUMETRIC_CONE.intensity. */
  readonly coneIntensity: number;
  readonly flicker: boolean;
  /** Housing hangs from the roof on a rod. */
  readonly hanging: boolean;
}

export interface PointLightDef {
  readonly position: Vec3Tuple;
  readonly color: Vec3Tuple;
  readonly intensity: number;
  readonly distance: number;
  readonly flicker: boolean;
}

export interface CrateDef {
  readonly position: Vec3Tuple;
  readonly size: number;
  readonly yawDeg: number;
  readonly dynamic: boolean;
}

export interface PipeRunDef {
  readonly from: Vec3Tuple;
  readonly to: Vec3Tuple;
  readonly radius: number;
  /** Distance between wall brackets (0 = none). */
  readonly supportSpacing: number;
  /** Which way the brackets reach the wall. */
  readonly wall: Facing | null;
  readonly flangeSpacing: number;
}

export interface DoorDef {
  /** Center of the door opening on the wall face (y = floor). */
  readonly position: Vec3Tuple;
  readonly facing: Facing;
  readonly width: number;
  readonly height: number;
  /** Big hazard-striped blast door instead of a service door. */
  readonly blast: boolean;
}

export interface ScreenDef {
  readonly position: Vec3Tuple;
  readonly facing: Facing;
  readonly width: number;
  readonly height: number;
}

export interface SkylightDef {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface DustRegionDef {
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
  /** Fraction of the particle budget. */
  readonly share: number;
}

/** Generic level-kit construction constants. */
export const LEVEL_KIT = {
  floorThickness: 0.5,
  /** Floor markings sit this high above the floor (thin boxes, no z-fighting). */
  markingThickness: 0.012,
  /** Flush decals on vertical faces (emissive strips, hazard ends): thickness and gap to the face. */
  decal: { thickness: 0.012, offset: 0.006 },
  railing: {
    height: 1.08,
    postSize: 0.07,
    postSpacing: 1.8,
    railSize: 0.06,
    midRailHeight: 0.55,
    /** Invisible collider thickness along the railing. */
    colliderThickness: 0.12,
    /** Railings along deck edges sit this far inside the edge. */
    edgeInset: 0.06,
    material: 'trim_metal' as MaterialId,
  },
  trim: {
    baseHeight: 0.16,
    baseDepth: 0.05,
    capHeight: 0.08,
    capOverhang: 0.04,
    stripHousingDepth: 0.08,
    stripHousingHeight: 0.14,
    stripHeight: 0.05,
    stripInset: 0.02,
  },
  pillar: {
    plinthHeight: 0.5,
    plinthExtra: 0.14,
    capHeight: 0.35,
    capExtra: 0.1,
    bandHeight: 0.14,
    bandInset: 0.02,
    edgeTrim: 0.07,
    /** Corner guards stand proud of the pillar faces by this much. */
    edgeTrimOut: 0.01,
  },
  stairs: {
    maxStepRise: 0.2,
    stepRun: 0.3,
    stringerWidth: 0.12,
    nosingHeight: 0.03,
    /** Stringer top runs this far above the nosing line. */
    stringerLift: 0.12,
  },
  fixture: {
    housingSize: [1.0, 0.24, 1.0] as Vec3Tuple,
    panelInset: 0.08,
    panelThickness: 0.03,
    rodSize: 0.06,
    /** Emissive panel hangs this far below the housing (avoids coplanar faces). */
    panelGap: 0.002,
    /** Point-light bulbs: small emissive box. */
    bulbSize: 0.22,
  },
  pipe: {
    radialSegments: 14,
    flangeRadiusScale: 1.35,
    flangeLength: 0.1,
    supportSize: 0.12,
    /** Bracket arm length from the pipe axis back into the wall (the hidden part sits inside it). */
    bracketReach: 0.9,
    clampLength: 0.07,
    clampRadiusScale: 1.12,
  },
  door: {
    frameWidth: 0.35,
    frameDepth: 0.45,
    doorInset: 0.25,
    hazardWidth: 0.12,
    statusLightSize: [0.5, 0.12, 0.08] as Vec3Tuple,
    leafThickness: 0.04,
    /** Accent decals on the door leaf (fractions of door height/width, meters for thickness/offset). */
    accentOffset: 0.05,
    accentThickness: 0.02,
    blastBand: { y: 0.2, height: 0.12 },
    blastSeam: { width: 0.04, height: 0.9 },
    serviceStrip: { y: 0.55, width: 0.6, height: 0.04 },
  },
  screen: {
    bezel: 0.08,
    depth: 0.12,
  },
  vent: {
    frameDepth: 0.08,
    glowInset: 0.12,
    glowThickness: 0.02,
  },
  /** Walkable top slab thickness of platforms / ledges and inset of their edge strips. */
  platformSlab: 0.1,
  platformStripMargin: 0.1,
  /** Max shadow-casting local lights come from QUALITY_LEVELS; shadow maps refresh every N frames (staggered). */
  shadowUpdateInterval: 2,
  localShadowBias: -0.0004,
  localShadowNormalBias: 0.02,
  /** Physics ray used to size light cones / shafts. */
  volumeRayMaxDistance: 60,
} as const;

/** Fake volumetric spot cones (render/vfx/VolumetricCone.ts). */
export const VOLUMETRIC_CONE = {
  radialSegments: 40,
  heightSegments: 6,
  /** Cone angle relative to the spot angle (the bright core is narrower than the falloff). */
  angleScale: 0.92,
  /** Radius at the apex (m) – avoids a degenerate tip. */
  apexRadius: 0.35,
  intensity: 0.35,
  /** |N·V|^edgePower: soft silhouettes. */
  edgePower: 1.8,
  /** (1 - t)^lengthPower along the cone. */
  lengthPower: 1.4,
  /** Fade-in near the source (fraction of the length). */
  apexFade: 0.06,
  /** Fade towards surfaces below (m above floorY). */
  floorFadeHeight: 1.2,
  noiseScale: 0.55,
  noiseSpeed: 0.18,
  noiseAmount: 0.6,
  /** Intensity multiplier while the camera is inside the cone, and the transition width (m). */
  insideFade: 0.25,
  insideMargin: 0.8,
  /** Fade when the camera is very close to the cone surface (m). */
  nearFadeStart: 0.4,
  nearFadeEnd: 3,
  backFaceWeight: 0.7,
} as const;

/** Skylight sun shafts (analytic parallelepiped volumes). */
export const VOLUMETRIC_SHAFT = {
  // Skylight shafts are the hall's hero light: clearly visible without washing out the arena.
  intensity: 0.16,
  /** Extinction for the soft saturation 1 - exp(-density * chord). */
  density: 0.22,
  /** Soft edge width as a fraction of the cross-section. */
  edgeSoftness: 0.22,
  noiseScale: 0.35,
  noiseSpeed: 0.06,
  noiseAmount: 0.55,
  /** Fade near the opening / towards the end (fraction of the length). */
  startFade: 0.04,
  endFade: 0.3,
  /** Skylights are split into segments this long so each can end on its own surface. */
  segmentLength: 3,
} as const;

/** GPU dust motes (render/vfx/DustParticles.ts). Count is multiplied by QUALITY_LEVELS.volumetrics[..].dust. */
export const DUST = {
  baseCount: 8000,
  /**
   * Fraction of the budget spawned inside the spot-cone bounds (weighted by cone volume): motes are
   * only visible where light hits them, so concentrating them there sells the beams at no extra cost.
   * The level's ambient regions share the rest.
   */
  coneShare: 0.45,
  /** Cone regions stop this far above the surface the cone lands on (m). */
  regionFloorLift: 0.1,
  /** World-space sprite size range (m). */
  sizeMin: 0.012,
  sizeMax: 0.035,
  minPixelSize: 1.2,
  maxPixelSize: 7,
  /** Brightness outside / inside registered light volumes (HDR, additive). */
  baseBrightness: 0.03,
  volumeBrightness: 2.4,
  driftSpeed: 0.12,
  fallSpeed: 0.035,
  swirlAmplitude: 0.35,
  swirlFrequency: 0.21,
  twinkleRate: 1.7,
  /** Beyond this camera distance the motes fade out (m). */
  fadeDistance: 28,
  maxCones: 8,
  maxBoxes: 16,
} as const;

/** Light flicker for faulty fixtures (noise-driven, deterministic). */
export const FLICKER = {
  rate: 9,
  /** Noise below this drops the light to `dropLevel`. */
  threshold: -0.35,
  dropLevel: 0.12,
  /** Subtle continuous hum. */
  humAmount: 0.06,
  humRate: 23,
  /** Occasional dead period: every `burstPeriod` s the light dies for `burstLength` s. */
  burstPeriod: 7.3,
  burstLength: 0.35,
  /**
   * Accessibility "reduce flashing": no dropouts, hum or blackouts – faulty lights only dim slowly
   * and shallowly (smooth noise), far below photosensitive flash thresholds.
   */
  reduced: {
    /** Noise frequency of the dimming (1/s). */
    rate: 0.4,
    /** Deepest dim as a fraction of full intensity (factor stays in [1 - depth, 1]). */
    depth: 0.25,
  },
} as const;

export const TEST_ROOM_LAYOUT = {
  hall: {
    minX: -30,
    maxX: 30,
    minZ: -30,
    maxZ: 30,
    wallThickness: 0.6,
    /** Roof underside height at maxZ (south) and minZ (north). */
    roofLowY: 11,
    roofHighY: 16,
    roofThickness: 0.4,
    /** Walls reach this high (above the roof everywhere). */
    wallTop: 16.6,
    /** Wall bands: dark wainscot, paneled middle, concrete above. */
    wainscotHeight: 1.2,
    panelTop: 6.5,
    lightStripY: 3.2,
    pilasterSpacing: 6,
    pilasterSize: [0.7, 0.35] as Vec2Tuple,
    pilasterBands: [2.2, 5.2] as readonly number[],
    /** Emissive band width relative to the pilaster width. */
    pilasterBandWidth: 0.6,
    /**
     * Pilasters keep this clearance from corners, vents, wall screens (beyond half the screen width),
     * vertical pipe drops and the foot of the corridor ramp; zones closer than wallProximity to a
     * wall block pilasters on that wall.
     */
    pilasterClearance: { corner: 3, vent: 4, screen: 0.8, pipe: 2, rampFoot: 1, wallProximity: 3.5 },
  },
  /** Loading progress fractions reported while building. */
  progress: { materials: 0.7, geometry: 0.72, lights: 0.85, volumetrics: 0.92 },
  materials: {
    floor: 'floor_concrete' as MaterialId,
    arenaFloor: 'floor_panel' as MaterialId,
    corridorFloor: 'rubber' as MaterialId,
    deck: 'floor_grate' as MaterialId,
    wall: 'wall_panel' as MaterialId,
    wallDark: 'wall_panel_dark' as MaterialId,
    wallUpper: 'concrete_wall' as MaterialId,
    trim: 'trim_metal' as MaterialId,
    hazard: 'painted_hazard' as MaterialId,
    pillar: 'pillar_metal' as MaterialId,
    roof: 'concrete_wall' as MaterialId,
    beam: 'pillar_metal' as MaterialId,
    blockTop: 'diamond_plate' as MaterialId,
    pit: 'concrete_wall' as MaterialId,
    glass: 'glass' as MaterialId,
    crate: 'crate' as MaterialId,
    pipe: 'pipe' as MaterialId,
    grid: 'calibration_grid' as MaterialId,
    screen: 'screen' as MaterialId,
    stripCyan: 'emissive_cyan' as MaterialId,
    stripOrange: 'emissive_orange' as MaterialId,
    stripRed: 'emissive_red' as MaterialId,
    lamp: 'emissive_white' as MaterialId,
    /** Bright "sky" seen through the skylight openings (never casts shadows). */
    sky: 'emissive_white' as MaterialId,
  },
  spawn: { position: [0, 0, 25] as Vec3Tuple, yawDeg: 0 },
  /**
   * Enemy spawn points for testing (M3): floor tears on open floor around the arena, outside the
   * mezzanine ring; enemies emerge facing the arena center. The hall is a single zone.
   */
  enemySpawns: {
    zone: 'hall',
    points: [
      { id: 'hall_east', position: [19.5, 0, -6] },
      { id: 'hall_southeast', position: [19.5, 0, 8] },
      { id: 'hall_west', position: [-20.5, 0, -2] },
      { id: 'hall_northwest', position: [-16, 0, -20] },
      { id: 'hall_northeast', position: [16, 0, -20] },
      { id: 'hall_southwest', position: [-18, 0, 22] },
      { id: 'hall_south', position: [18, 0, 22] },
    ] as readonly { id: string; position: Vec3Tuple }[],
  },
  arena: {
    rect: { minX: -12, maxX: 12, minZ: -12, maxZ: 12 } as RectDef,
    borderWidth: 0.3,
    pillars: [
      [-8, -8],
      [8, -8],
      [-8, 8],
      [8, 8],
    ] as readonly Vec2Tuple[],
    pillarSize: 1.4,
    pillarBands: [3, 7.5] as readonly number[],
    /** Pillars reach this far into the roof slab (hides the sloped contact). */
    pillarRoofOverlap: 0.05,
    /** Hazard paint on the cover-wall ends (fraction of the wall height). */
    coverHazardHeight: 0.9,
    /** Low cover walls: center x/z, size x/y/z. */
    cover: [
      { center: [-5, 0] as Vec2Tuple, size: [0.8, 1.1, 3.2] as Vec3Tuple },
      { center: [5, 0] as Vec2Tuple, size: [0.8, 1.1, 3.2] as Vec3Tuple },
      { center: [0, -6] as Vec2Tuple, size: [3.2, 1.1, 0.8] as Vec3Tuple },
      { center: [0, 6] as Vec2Tuple, size: [3.2, 1.1, 0.8] as Vec3Tuple },
    ],
  },
  mezzanine: {
    /** Outer / inner half extents of the square ring around the origin. */
    outer: 16,
    inner: 13,
    deckY: 4.5,
    deckThickness: 0.3,
    fasciaHeight: 0.45,
    fasciaDepth: 0.08,
    fasciaLift: 0.02,
    /** Orange strip under the inner deck edge. */
    underglow: { height: 0.04, rise: 0.08, margin: 0.2 },
    supportCap: { height: 0.2, extra: 0.1 },
    supportSize: 0.5,
    supportSpacing: 7.25,
    /** Gaps in the inner railing to drop into the arena: side ('n'|'s'|'e'|'w') + center + width. */
    innerGaps: [
      { side: 'n', center: 0, width: 3 },
      { side: 'w', center: 0, width: 3 },
    ] as readonly { side: 'n' | 's' | 'e' | 'w'; center: number; width: number }[],
  },
  stairs: {
    /** Footprint across (x) and the edge where the top step meets the deck (z). */
    minX: -11.5,
    maxX: -8.5,
    topZ: 16,
  },
  westRamp: {
    minX: -19,
    maxX: -16,
    bottomZ: 14,
    slopeDeg: 25,
    landingLength: 2,
  },
  bridge: { minX: 16, maxX: 23, minZ: 13, maxZ: 16 } as RectDef,
  corridor: {
    laneMinX: 23,
    laneMaxX: 30,
    /** Control block (solid, its roof is the deck) spans deckMinZ..hall.maxZ. */
    deckMinZ: 13,
    rampSlopeDeg: 18,
    partition: { minX: 22.4, maxX: 23, minZ: -26, maxZ: -2, height: 3.2 },
    partitionOpening: { minZ: -12.5, maxZ: -9.5 },
    windowBand: { bottom: 1.2, top: 2.4, mullionSpacing: 2.4, mullionWidth: 0.12 },
    laneLines: [24, 29] as readonly number[],
    lineWidth: 0.1,
    distanceMarkerSpacing: 5,
    /** Lane markings stop this far before the north wall. */
    trackEndMargin: 0.5,
    /** Deck railing stops this far before the hall wall. */
    deckRailEndMargin: 0.3,
    partitionDetail: {
      glassThickness: 0.04,
      mullionExtra: 0.02,
      /** Speed-line strips on both faces: orange below the window band, cyan near the floor. */
      upperStrip: { drop: 0.05, height: 0.04 },
      lowerStrip: { y: 0.12, height: 0.03 },
      stripMargin: 0.05,
    },
  },
  controlBlock: {
    screens: [
      { position: [23, 2.3, 15.5], facing: 'nx', width: 2.4, height: 1.4 },
      { position: [23, 2.3, 27.5], facing: 'nx', width: 2.4, height: 1.4 },
    ] as readonly ScreenDef[],
    /** Recessed bay in the west face: display wall at the back, light strip on its ceiling, glass in front. */
    window: {
      centerZ: 19.5,
      width: 3,
      bottom: 1.3,
      top: 2.9,
      recess: 0.6,
      /** Ceiling light strip: depth as a fraction of the recess, width as a fraction of the window. */
      glowDepth: 0.45,
      glowWidth: 0.85,
      glowThickness: 0.03,
      backDepth: 0.02,
      glassThickness: 0.03,
      frameSize: 0.12,
      frameDepth: 0.14,
      frameOffset: 0.05,
    },
  },
  mantle: {
    minZ: -30,
    maxZ: -26,
    ledges: [
      { minX: -11, maxX: -7, height: 0.6 },
      { minX: -5, maxX: -1, height: 1.0 },
      { minX: 1, maxX: 5, height: 1.4 },
      { minX: 7, maxX: 11, height: 1.7 },
    ] as readonly { minX: number; maxX: number; height: number }[],
    markerHeight: 0.06,
    /** Marker strip sits this far below the ledge top. */
    markerDrop: 0.03,
    /** Tick bars sit this far below the ledge top (at least tickLift above the floor). */
    tickDrop: 0.3,
    tickLift: 0.05,
    markingDepth: 0.3,
    tickWidth: 0.12,
    tickHeight: 0.18,
    tickGap: 0.1,
  },
  calibrationWall: {
    minX: -14,
    maxX: 14,
    bottom: 0,
    top: 9,
    thickness: 0.04,
    frameWidth: 0.12,
    frameDepth: 0.1,
  },
  doubleJump: {
    platforms: [
      { x: -24.5, z: 12.5, height: 2.3 },
      { x: -24.5, z: 7.5, height: 2.45 },
      { x: -24.5, z: 2.5, height: 2.6 },
    ] as readonly { x: number; z: number; height: number }[],
    size: 3,
    stripDrop: 0.135,
    stripHeight: 0.05,
    markingDepth: 0.3,
  },
  pit: {
    /** 8.5 m across Z: wider than a slide-jump (~7.9 m), within reach of jump + dash or a double jump. */
    rect: { minX: -30, maxX: -18, minZ: -14.5, maxZ: -6 } as RectDef,
    depth: 4,
    wallThickness: 0.5,
    /** Mantle blocks to climb out (inside the pit, against the east edge). */
    exitBlocks: [
      { minX: -21.6, maxX: -19.8, minZ: -11.5, maxZ: -8, top: -2.65 },
      { minX: -19.8, maxX: -18, minZ: -11.5, maxZ: -8, top: -1.3 },
    ] as readonly { minX: number; maxX: number; minZ: number; maxZ: number; top: number }[],
    glowStripY: 0.35,
    glowStripHeight: 0.05,
    exitStrip: { drop: 0.03, height: 0.04 },
    rimWidth: 0.35,
  },
  roof: {
    skylights: [
      { minX: 0, maxX: 12, minZ: 1.6, maxZ: 2.6 },
      { minX: 0, maxX: 12, minZ: 5.0, maxZ: 6.0 },
      { minX: 0, maxX: 12, minZ: 8.4, maxZ: 9.4 },
      { minX: -12.5, maxX: -3.5, minZ: -6, maxZ: -5 },
    ] as readonly SkylightDef[],
    /** Beams under the roof: along X every `beamSpacingZ`, girders along Z at `girderX`. */
    beamSpacingZ: 7.5,
    beamSize: [0.35, 0.7] as Vec2Tuple,
    girderX: [-13, 13] as readonly number[],
    girderSize: [0.6, 1.0] as Vec2Tuple,
    skylightFrame: 0.12,
    /** Emissive sky panel above each skylight: height above the roof top and margin around the opening. */
    skyGlowLift: 0.6,
    skyGlowMargin: 0.4,
  },
  vents: [
    { position: [0, 6.2, 30], facing: 'nz', width: 6, slits: 7, slitHeight: 0.14, spacing: 0.34 },
  ] as readonly {
    position: Vec3Tuple;
    facing: Facing;
    width: number;
    slits: number;
    slitHeight: number;
    spacing: number;
  }[],
  doors: [
    { position: [-20, 0, 30], facing: 'nz', width: 3, height: 3.5, blast: false },
    { position: [-30, 0, 20], facing: 'px', width: 3, height: 3.5, blast: false },
    { position: [18, 0, -30], facing: 'pz', width: 3, height: 3.5, blast: false },
    { position: [26.5, 0, -30], facing: 'pz', width: 5, height: 5, blast: true },
  ] as readonly DoorDef[],
  screens: [
    { position: [6, 2.1, 30], facing: 'nz', width: 2.8, height: 1.6 },
    { position: [-30, 2.1, -24], facing: 'px', width: 2.4, height: 1.4 },
  ] as readonly ScreenDef[],
  crates: [
    { position: [4, 0.6, 20], size: 1.2, yawDeg: 8, dynamic: true },
    { position: [5.5, 0.5, 20.4], size: 1.0, yawDeg: -6, dynamic: true },
    { position: [4.1, 1.7, 20.05], size: 1.0, yawDeg: 20, dynamic: true },
    { position: [7.5, 0.4, 22.2], size: 0.8, yawDeg: 0, dynamic: true },
    { position: [8.5, 0.4, 22.6], size: 0.8, yawDeg: 12, dynamic: true },
    { position: [8.0, 1.2, 22.4], size: 0.8, yawDeg: -15, dynamic: true },
    { position: [-3.5, 0.5, 8.5], size: 1.0, yawDeg: 30, dynamic: true },
    { position: [3.2, 0.6, -8.6], size: 1.2, yawDeg: -10, dynamic: true },
    // Static stacks for set dressing.
    { position: [-27.9, 0.75, 27.9], size: 1.5, yawDeg: 0, dynamic: false },
    { position: [-26.3, 0.75, 27.9], size: 1.5, yawDeg: 0, dynamic: false },
    { position: [-27.9, 2.25, 27.9], size: 1.5, yawDeg: 0, dynamic: false },
    { position: [-27.9, 0.75, 26.3], size: 1.5, yawDeg: 0, dynamic: false },
    { position: [17.9, 0.6, 28.6], size: 1.2, yawDeg: 0, dynamic: false },
    { position: [19.2, 0.6, 28.6], size: 1.2, yawDeg: 0, dynamic: false },
    { position: [-27.5, 0.6, -27.5], size: 1.2, yawDeg: 0, dynamic: false },
  ] as readonly CrateDef[],
  pipes: [
    {
      from: [-29.55, 7.5, -29.4],
      to: [-29.55, 7.5, 29.4],
      radius: 0.22,
      supportSpacing: 4,
      wall: 'px',
      flangeSpacing: 6,
    },
    {
      from: [-29.65, 8.2, -29.4],
      to: [-29.65, 8.2, 29.4],
      radius: 0.13,
      supportSpacing: 0,
      wall: null,
      flangeSpacing: 0,
    },
    {
      from: [29.5, 8, -29.4],
      to: [29.5, 8, 29.4],
      radius: 0.3,
      supportSpacing: 4,
      wall: 'nx',
      flangeSpacing: 6,
    },
    {
      from: [-29.4, 11.2, -29.55],
      to: [29.4, 11.2, -29.55],
      radius: 0.18,
      supportSpacing: 4,
      wall: 'pz',
      flangeSpacing: 8,
    },
    {
      from: [-29.55, 7.5, 16],
      to: [-29.55, 0.9, 16],
      radius: 0.16,
      supportSpacing: 0,
      wall: null,
      flangeSpacing: 0,
    },
    {
      from: [-29.55, 7.5, -20],
      to: [-29.55, 0.9, -20],
      radius: 0.16,
      supportSpacing: 0,
      wall: null,
      flangeSpacing: 0,
    },
  ] as readonly PipeRunDef[],
  /** Valve boxes at the bottom of vertical pipes. */
  valves: [
    { center: [-29.4, 0.45, 16], size: [0.6, 0.9, 0.9] },
    { center: [-29.4, 0.45, -20], size: [0.6, 0.9, 0.9] },
  ] as readonly { center: Vec3Tuple; size: Vec3Tuple }[],
  lights: {
    spots: [
      {
        position: [-6, 10, -6],
        target: [-4.5, 0, -4.5],
        color: [1, 0.9, 0.78],
        intensity: 420,
        distance: 26,
        angleDeg: 24,
        penumbra: 0.55,
        shadowPriority: 1,
        volumetric: true,
        coneIntensity: 1,
        flicker: false,
        hanging: true,
      },
      {
        position: [6, 10, -6],
        target: [4.5, 0, -4.5],
        color: [1, 0.9, 0.78],
        intensity: 420,
        distance: 26,
        angleDeg: 24,
        penumbra: 0.55,
        shadowPriority: 2,
        volumetric: true,
        coneIntensity: 1,
        flicker: true,
        hanging: true,
      },
      {
        position: [-6, 10, 6],
        target: [-4.5, 0, 4.5],
        color: [1, 0.9, 0.78],
        intensity: 420,
        distance: 26,
        angleDeg: 24,
        penumbra: 0.55,
        shadowPriority: 3,
        volumetric: true,
        coneIntensity: 1,
        flicker: false,
        hanging: true,
      },
      {
        position: [6, 10, 6],
        target: [4.5, 0, 4.5],
        color: [1, 0.9, 0.78],
        intensity: 420,
        distance: 26,
        angleDeg: 24,
        penumbra: 0.55,
        shadowPriority: 4,
        volumetric: true,
        coneIntensity: 1,
        flicker: false,
        hanging: true,
      },
      {
        position: [0, 10.5, -21],
        target: [0, 0.5, -27],
        color: [0.75, 0.88, 1],
        intensity: 520,
        distance: 30,
        angleDeg: 38,
        penumbra: 0.6,
        shadowPriority: 5,
        volumetric: true,
        coneIntensity: 0.6,
        flicker: false,
        hanging: true,
      },
      {
        position: [26.5, 9, -14],
        target: [26.5, 0, -17],
        color: [0.6, 0.9, 1],
        intensity: 360,
        distance: 24,
        angleDeg: 30,
        penumbra: 0.5,
        shadowPriority: 6,
        volumetric: true,
        coneIntensity: 0.9,
        flicker: false,
        hanging: true,
      },
    ] as readonly SpotLightDef[],
    points: [
      { position: [-24, -2.2, -10.25], color: [1, 0.12, 0.06], intensity: 30, distance: 12, flicker: false },
      { position: [26.5, 2.6, -24], color: [0.3, 0.85, 1], intensity: 22, distance: 12, flicker: true },
      { position: [0, 5, 26], color: [1, 0.78, 0.55], intensity: 45, distance: 16, flicker: false },
      { position: [20.5, 2.6, 21], color: [0.35, 0.85, 1], intensity: 18, distance: 9, flicker: false },
      { position: [0, 5.6, 28.6], color: [1, 0.45, 0.12], intensity: 26, distance: 10, flicker: false },
    ] as readonly PointLightDef[],
  },
  /**
   * Shooting range (M2): the arena's north hazard border is the firing line; dummies stand between
   * the mezzanine and the mantle course in front of the calibration wall (7–13 m), a few more in
   * the arena. Rails and distance dashes are level geometry (TestRoom); the dummies themselves are
   * world/TrainingTargets.
   */
  range: {
    /** Glowing distance dashes at both lane edges (x) at these z. */
    minX: -11.5,
    maxX: 11.5,
    distanceMarkers: [-19.5, -22, -24.8] as readonly number[],
    markerLength: 0.9,
    markerDepth: 0.06,
  },
  targets: [
    // Range lane.
    { type: 'dummy', position: [-5.5, 0, -19.5], yawDeg: 0 },
    { type: 'dummy', position: [5.5, 0, -19.5], yawDeg: 0 },
    {
      type: 'dummy',
      position: [-9.5, 0, -22],
      yawDeg: 0,
      rail: { to: [9.5, 0, -22], speed: 2.4, pause: 0.7 },
    },
    { type: 'dummy', position: [2.2, 0, -24.8], yawDeg: 0 },
    { type: 'armored', position: [-4.5, 0, -24.8], yawDeg: 0 },
    // In front of the tallest mantle ledge (1.7 m): blood splatters onto its face.
    { type: 'flesh', position: [9, 0, -24.8], yawDeg: 0 },
    // Arena.
    { type: 'dummy', position: [-3, 0, 2.6], yawDeg: 0 },
    { type: 'dummy', position: [3.2, 0, -2.4], yawDeg: 20 },
    {
      type: 'dummy',
      position: [10.2, 0, -4.5],
      yawDeg: -90,
      rail: { to: [10.2, 0, 4.5], speed: 1.8, pause: 1 },
    },
    { type: 'armored', position: [0, 0, -9.2], yawDeg: 0 },
    // In front of the north-west pillar: slime splatters onto it.
    { type: 'slime', position: [-8, 0, -6.2], yawDeg: 0 },
  ] as readonly TargetPlacementDef[],
  dust: [
    { min: [-13, 0.3, -13], max: [13, 11, 13], share: 0.55 },
    { min: [-12, 0.3, -30], max: [12, 9, -18], share: 0.15 },
    { min: [23, 0.3, -24], max: [30, 8, -8], share: 0.12 },
    { min: [-30, -3.8, -14.5], max: [-18, 3, -6], share: 0.08 },
    { min: [-29, 0.3, 14], max: [29, 9, 29], share: 0.1 },
  ] as readonly DustRegionDef[],
} as const;

export type TestRoomLayout = typeof TEST_ROOM_LAYOUT;

/** Roof underside height at z (the roof slopes up towards -Z). */
export function roofUndersideY(z: number, hall: TestRoomLayout['hall'] = TEST_ROOM_LAYOUT.hall): number {
  const t = (hall.maxZ - z) / (hall.maxZ - hall.minZ);
  return hall.roofLowY + (hall.roofHighY - hall.roofLowY) * t;
}
