/**
 * M4 interactables: the interaction focus (range, view cone, prompts), zone gating, purchasable
 * doors, wall buys, the mystery box ("Rift-Kiste") and perk machines – timing, visuals and the
 * per-map placements. Prices come from the economy (defs/economy.ts) and the perk table
 * (defs/perks.ts) through `InteractablePrices` (src/interactables/types.ts). Meters, seconds,
 * degrees where noted. Colors: linear RGB triplets unless marked "sRGB hex".
 *
 * Placement conventions (maps are axis-aligned):
 * - wall-mounted things (wall buys, perk machines) give the point ON the wall face (`position`,
 *   perk machines at floor level) and `facing` = the interior direction the face looks to,
 * - free-standing box locations give the floor center of the box and the facing of its front.
 */
import type { Facing, Vec3Tuple } from './level';

export type Rgb = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Interaction focus
// ---------------------------------------------------------------------------

export const INTERACTION = {
  /** View cone half-angle (deg) from the look direction to the interactable's anchor. */
  coneHalfAngleDeg: 36,
  /** Standing this close to an anchor, a wider cone applies (price plate at the feet, box below). */
  closeRange: 1.3,
  closeConeHalfAngleDeg: 68,
  /** Score = angle / cone + distanceWeight × distance / range; the lowest score wins. */
  distanceWeight: 0.55,
  /** Line-of-sight rays per tick at most (best candidates first). */
  maxLosChecks: 3,
  /** A new focus must beat the current one by this score margin (no flicker between neighbours). */
  stickiness: 0.12,
  /** Default use ranges from the eye to the anchor (m). */
  range: { wallBuy: 2.3, door: 2.7, box: 2.5, perk: 2.4 },
} as const;

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export const ZONES = {
  /**
   * Zones that are active when a run starts, per map id. Maps without zone data (the calibration
   * hall) are not gated: every zone counts as active there.
   */
  startZones: {
    lab: ['reception'],
  } as Readonly<Record<string, readonly string[]>>,
} as const;

// ---------------------------------------------------------------------------
// Shared visuals
// ---------------------------------------------------------------------------

/** Additive hologram look (holo panels, weapon holograms, the anomaly). */
export const HOLOGRAM = {
  /** Scanline density (lines per meter) and scroll speed (m/s). */
  scanDensity: 38,
  scanSpeed: 0.35,
  /** 0..1 how deep the scanlines cut the brightness. */
  scanDepth: 0.35,
  /** Fresnel rim exponent and strength (weapon models read as glowing outlines). */
  rimPower: 2.2,
  rimStrength: 1.35,
  /** Faint body fill relative to the rim. */
  fill: 0.14,
  /** Random brightness flicker: rate (Hz) and depth (0..1); reduced flashing uses reducedDepth. */
  flickerRate: 13,
  flickerDepth: 0.12,
  reducedFlickerDepth: 0.03,
  /** Brief glitch band sweeping over holograms every few seconds (0 = off). */
  glitchInterval: 3.7,
  glitchStrength: 0.35,
  /** Text/icon panels: brightness of the lit texels, the frame and the background tint. */
  panel: { text: 1.6, frame: 1.1, background: 0.1 },
  /** Canvas text font stacks (the HUD's display / mono families). */
  fontDisplay:
    "'Bahnschrift', 'DIN Alternate', 'Barlow Condensed', 'Roboto Condensed', 'Arial Narrow', sans-serif",
  fontMono: "'JetBrains Mono', 'Cascadia Mono', 'Consolas', 'Liberation Mono', monospace",
} as const;

/** Solid volumes of interactables (SolidBlocker). */
export const BLOCKERS = {
  /** An unblocked bullet blocker is parked this far below its spot (CombatWorld keeps its meshes). */
  parkOffsetY: -500,
  /**
   * Nav areas span navLift ± navHalfHeight above the floor (recast marks spans by their floor
   * height: floor-level only, decks above stay untouched).
   */
  navLift: 0.5,
  navHalfHeight: 1,
  /**
   * Bullet decals within the bullet volume grown by this (m) vanish when the surface goes away (a
   * door opens, the box leaves): decals sit a few mm in front of the surface they hit.
   */
  decalMargin: 0.05,
} as const;

/** Additive floor glow in front of emissive fixtures (fake light spill; real lights stay constant). */
export const LIGHT_POOL = {
  /** Height above the floor (m) – just clear of the floor decals. */
  lift: 0.015,
  /** Radial falloff exponent. */
  falloff: 2.4,
} as const;

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

export interface DoorLeafStyle {
  readonly thickness: number;
  /** Body material id (defs/materials). */
  readonly body: string;
}

export const DOORS = {
  /** Hydraulic opening (s): unseal (bolts retract, leaves pop back) then slide into the wall pockets. */
  openDuration: 0.8,
  blastOpenDuration: 1.25,
  /** Fraction of the opening spent unsealing before the leaves slide. */
  unsealFraction: 0.2,
  /** Leaves back off this far during the unseal (m). */
  unsealPop: 0.018,
  /** The passage becomes passable (collider, bullets, nav) at this opening fraction. */
  passableAt: 0.45,
  /** Leaves slide this far past half the opening width into the pocket (m). */
  slideExtra: 0.1,
  /** Leaves overlap at the seam when closed (m). */
  leafOverlap: 0.015,
  service: { thickness: 0.12, body: 'wall_panel_dark' } as DoorLeafStyle,
  blast: { thickness: 0.26, body: 'pillar_metal' } as DoorLeafStyle,
  trimMaterial: 'trim_metal',
  hazardMaterial: 'painted_hazard',
  /** Leaf detailing (m): edge trims, hazard strip at the seam, horizontal ribs (fractions of h). */
  trimWidth: 0.07,
  trimProud: 0.012,
  hazardWidth: 0.11,
  ribs: [0.33, 0.68] as readonly number[],
  ribHeight: 0.045,
  /** Glowing status bar across each leaf (y m, height m, width as a fraction of the leaf). */
  statusBar: { y: 1.3, height: 0.05, width: 0.62 },
  /** Vertical seam glow at the meeting edges (width m, height as a fraction of the door). */
  seam: { width: 0.022, height: 0.82 },
  /** Blast doors: hazard band (y and height as fractions of h) and the locking bolts across the seam. */
  blastBand: { y: 0.17, height: 0.12 },
  bolts: { y: [0.42, 0.58] as readonly number[], width: 0.72, height: 0.16, proud: 0.05, travel: 0.42 },
  /** Emissive status colors (linear) and intensity; the locked glow breathes slowly. */
  lockedColor: [1.0, 0.32, 0.05] as Rgb,
  unlockedColor: [0.18, 1.0, 0.42] as Rgb,
  emissiveIntensity: 5.5,
  breatheRate: 0.6,
  breatheDepth: 0.25,
  /** Reduced flashing: the breathing depth × this. Unlock: a flash decaying at this rate (1/s). */
  reducedBreatheScale: 0.4,
  unlockFlashDecay: 4,
  /** Holographic price panel in front of each face. */
  panel: {
    width: 1.34,
    height: 0.64,
    y: 1.7,
    /** In front of the wall face (m) – inside the frame's protrusion. */
    offset: 0.13,
    color: [1.0, 0.52, 0.12] as Rgb,
    intensity: 2.1,
    canvas: [384, 192] as readonly [number, number],
    /** Fade-out over this fraction of the opening (0..1) once the door starts to open. */
    fadeOut: 0.3,
  },
  /** `withZone`: the prompt when the zone behind the door has a name. */
  prompt: { service: 'Tür öffnen', blast: 'Schott öffnen', withZone: '{action}: {zone}' },
  /** Panel caption (canvas). */
  caption: { service: 'TÜR ENTRIEGELN', blast: 'SCHOTT ENTRIEGELN' },
  /** Prompt anchor in front of each face: height and distance from the passage center plane (m). */
  anchor: { y: 1.45, offset: 0.62 },
  /** Bullet surface of the closed door (the hidden blocker mesh is named `level:<id>`). */
  blockerMaterial: 'trim_metal',
  /** Blocked nav area: through-axis half depth grows by this beyond the agent radius (m). */
  navExtra: 0.05,
} as const;

// ---------------------------------------------------------------------------
// Wall buys
// ---------------------------------------------------------------------------

export interface WallBuyPlacementDef {
  readonly id: string;
  readonly weapon: string;
  /** Board center on the wall face. */
  readonly position: Vec3Tuple;
  readonly facing: Facing;
  readonly zone: string;
}

export const WALL_BUYS = {
  board: {
    width: 2.2,
    height: 0.95,
    depth: 0.05,
    frame: 0.06,
    body: 'wall_panel_dark',
    trim: 'trim_metal',
  },
  /**
   * Weapon hologram: real model length × scale, clamped to [minLength, maxLength] (m); distance
   * out of the wall, hover bob.
   */
  hologram: {
    scale: 1.9,
    minLength: 0.95,
    maxLength: 1.75,
    offset: 0.16,
    y: 0.1,
    color: [0.3, 0.85, 1.0] as Rgb,
    intensity: 1.35,
    bobAmplitude: 0.012,
    bobRate: 0.45,
    /** Owned weapons dim to this (the ammo offer). */
    ownedIntensity: 0.75,
    /** Purchase flash decay (1/s). */
    flashDecay: 2.5,
  },
  /** Faint scanline field behind the hologram (fraction of the inner board). */
  screen: { inset: 0.08, color: [0.12, 0.5, 0.75] as Rgb, intensity: 0.35 },
  /** Price plate under the board: size (m), gap below the board, canvas pixels. */
  plate: {
    width: 1.3,
    height: 0.27,
    gap: 0.05,
    color: [1.0, 0.62, 0.18] as Rgb,
    intensity: 2,
    canvas: [512, 106] as readonly [number, number],
  },
  prompts: { buy: '{name} kaufen', ammo: 'Munition: {short}', ammoFull: 'Munition voll' },
  plateText: { ammo: 'MUNITION' },
  /** Prompt anchor in front of the board (m). */
  anchorOffset: 0.25,
  /** Weapon per level wall-buy slot id (overrides the slot's weaponHint). */
  offers: {
    wallbuy_reception_rifle: 'rifle',
  } as Readonly<Record<string, string>>,
  /** Wall buys beyond the level's own slots, per map id. */
  placements: {
    lab: [
      {
        id: 'wallbuy_reception_pistol',
        weapon: 'machinepistol',
        position: [7.6, 1.55, 19],
        facing: 'pz',
        zone: 'reception',
      },
      {
        id: 'wallbuy_hall_shotgun',
        weapon: 'doublebarrel',
        position: [-3, 1.55, 15.5],
        facing: 'px',
        zone: 'atrium',
      },
    ],
    // Calibration hall: three M5 wall guns on the south wall (behind the spawn), between the
    // pilasters – the loadout already carries the M2 three for comparison.
    testroom: [
      {
        id: 'wallbuy_test_pistol',
        weapon: 'revolver',
        position: [-16.45, 1.55, 30],
        facing: 'nz',
        zone: 'hall',
      },
      {
        id: 'wallbuy_test_rifle',
        weapon: 'battlerifle',
        position: [-12.8, 1.55, 30],
        facing: 'nz',
        zone: 'hall',
      },
      {
        id: 'wallbuy_test_shotgun',
        weapon: 'autoshotgun',
        position: [-10, 1.55, 30],
        facing: 'nz',
        zone: 'hall',
      },
    ],
  } as Readonly<Record<string, readonly WallBuyPlacementDef[]>>,
} as const;

// ---------------------------------------------------------------------------
// Mystery box ("Rift-Kiste")
// ---------------------------------------------------------------------------

export interface BoxLocationDef {
  readonly id: string;
  /** Floor center of the box. */
  readonly position: Vec3Tuple;
  /** Direction the front (the player's side) faces. */
  readonly facing: Facing;
  readonly zone: string;
}

export interface BoxPoolEntry {
  readonly weapon: string;
  readonly weight: number;
}

export const MYSTERY_BOX = {
  /** Price fallback (the economy's box price wins). */
  cost: 950,
  /** Weapons cycle in the hologram (s): accelerating, then slowing onto the result. */
  rollDuration: 4.2,
  /** The resolved weapon waits this long to be taken, then sinks back (s). */
  offerDuration: 8,
  /** Lid closing after a take / timeout (s). */
  closeDuration: 0.7,
  /** The anomaly shows, then the box lifts off and reappears elsewhere (s). */
  anomalyDuration: 2.6,
  leaveDuration: 2.2,
  arriveDuration: 1.6,
  /** Uses at one location before the anomaly may appear: rolled uniformly in [min, max]. */
  moveAfterUses: { min: 4, max: 8 },
  /** Chance per roll once the threshold is reached. */
  anomalyChance: 0.5,
  /** Display steps per second: start → peak (at `peakAt` of the roll) → end. */
  roll: { startRate: 7, peakRate: 17, endRate: 1.8, peakAt: 0.3 },
  /**
   * Weighted pool (defs/weapons ids). Box-only weapons (WeaponDef.boxOnly) join automatically at
   * `boxOnlyWeight` unless listed; weapons of kinds the weapon system cannot fire yet are skipped.
   * M5: wall guns 3 (the sidearm 1), heavies/energy 2, the black hole 1.5, the three wonder
   * weapons 1 each (≈5 % together in the full pool of 58.5).
   */
  pool: [
    { weapon: 'pistol', weight: 1 },
    { weapon: 'revolver', weight: 3 },
    { weapon: 'machinepistol', weight: 3 },
    { weapon: 'smg', weight: 3 },
    { weapon: 'pdw', weight: 3 },
    { weapon: 'vector', weight: 3 },
    { weapon: 'rifle', weight: 3 },
    { weapon: 'burstrifle', weight: 3 },
    { weapon: 'battlerifle', weight: 3 },
    { weapon: 'shotgun', weight: 3 },
    { weapon: 'autoshotgun', weight: 3 },
    { weapon: 'doublebarrel', weight: 3 },
    { weapon: 'lmg', weight: 3 },
    { weapon: 'marksman', weight: 3 },
    { weapon: 'sniper', weight: 2 },
    { weapon: 'minigun', weight: 2 },
    { weapon: 'plasma', weight: 2 },
    { weapon: 'chainlightning', weight: 2 },
    { weapon: 'railgun', weight: 2 },
    { weapon: 'flamethrower', weight: 2 },
    { weapon: 'grenadelauncher', weight: 2 },
    { weapon: 'blackhole', weight: 1.5 },
    { weapon: 'riftripper', weight: 1 },
    { weapon: 'aetherharp', weight: 1 },
    { weapon: 'cryonova', weight: 1 },
  ] as readonly BoxPoolEntry[],
  boxOnlyWeight: 2,
  /** Never offer a weapon the player carries (falls back to the full pool if that empties it). */
  excludeOwned: true,
  size: { width: 1.5, height: 0.6, depth: 0.78, lidHeight: 0.14, baseHeight: 0.08 },
  /** Hinged at the back: beyond ~80° the lid would swing into the wall behind a box. */
  lidOpenDeg: 78,
  /** Lid opening / closing speed (fraction per second). */
  lidSpeed: 3.2,
  materials: { body: 'pillar_metal', trim: 'trim_metal', hazard: 'painted_hazard' },
  /** Rift energy leaking out of the seams (linear) and its pulse. */
  riftColor: [0.62, 0.22, 1.0] as Rgb,
  riftIntensity: 6,
  riftPulseRate: 0.8,
  riftPulseDepth: 0.35,
  /** While busy (not idle): pulse rate and brightness × these; reduced flashing: depth × scale. */
  riftActive: { rateScale: 3, intensityScale: 1.4 },
  reducedPulseScale: 0.4,
  /** Glow inside the open chest (additive, linear intensity). */
  interiorGlow: 0.9,
  /** Weapon hologram over the open box. */
  hologram: {
    /** Real model length × scale, clamped (m). */
    scale: 1.2,
    minLength: 0.6,
    maxLength: 1.1,
    /** Rise above the box top (m) while shown; sinks back below the rim when the offer lapses. */
    rise: 0.45,
    color: [0.72, 0.42, 1.0] as Rgb,
    resultColor: [0.35, 0.95, 1.0] as Rgb,
    intensity: 1.5,
    spinRate: 0.55,
    bobAmplitude: 0.03,
    bobRate: 0.9,
    /** The offer's last seconds: the hologram sinks and flickers (this flicker depth, 0..1). */
    sinkWarning: 2.2,
    warningFlicker: 0.6,
  },
  /** The "Riss-Anomalie" hologram (a torn eye) instead of a weapon; `glitch` band strength. */
  anomaly: { color: [1.0, 0.18, 0.32] as Rgb, intensity: 2.2, size: 0.62, glitch: 1 },
  /** Light beam over the active location (additive, volumetric layer). */
  beam: {
    radius: 0.34,
    maxHeight: 16,
    /** The ceiling probe starts above the box and the beam ends this far below the hit (m). */
    ceilingMargin: 0.2,
    color: [0.55, 0.3, 1.0] as Rgb,
    intensity: 0.9,
    /** Relocation flare. */
    flare: 3,
  },
  /** Soft glow pool on the floor around the box. */
  glowPool: { radius: 1.7, color: [0.45, 0.2, 1.0] as Rgb, intensity: 0.55 },
  /** Emblem on the front (canvas). */
  emblem: { size: 0.34, canvas: 256 },
  prompts: { open: 'Rift-Kiste öffnen', take: '{name} nehmen' },
  /** Prompt anchor: height above the box floor, distance in front of its front face (m). */
  anchor: { y: 1.0, offset: 0.3 },
  anomalyName: 'Riss-Anomalie',
  /** VFX preset for the relocation burst (defs/vfx). */
  moveEffect: 'rift.spawn',
  locations: {
    lab: [
      { id: 'box_reception', position: [-1.8, 0, 29.45], facing: 'nz', zone: 'reception' },
      { id: 'box_atrium', position: [-7, 0, -1.5], facing: 'px', zone: 'atrium' },
      { id: 'box_labs', position: [-27.2, 0, -8.5], facing: 'pz', zone: 'labs' },
      { id: 'box_server', position: [28, 0, 3.5], facing: 'nx', zone: 'server' },
      { id: 'box_cryo', position: [27, 0, -19.5], facing: 'pz', zone: 'cryo' },
      { id: 'box_dock', position: [-3, 0, -23.5], facing: 'pz', zone: 'dock' },
    ],
    testroom: [
      { id: 'box_test_west', position: [-3.5, 0, 19], facing: 'pz', zone: 'hall' },
      { id: 'box_test_east', position: [3.5, 0, 19], facing: 'pz', zone: 'hall' },
    ],
  } as Readonly<Record<string, readonly BoxLocationDef[]>>,
  /** Start location candidates per map (random per run); empty = any location. */
  start: {
    lab: ['box_reception', 'box_atrium'],
    testroom: ['box_test_west'],
  } as Readonly<Record<string, readonly string[]>>,
} as const;

// ---------------------------------------------------------------------------
// Perk machines
// ---------------------------------------------------------------------------

export interface PerkMachinePlacementDef {
  readonly id: string;
  /** Wall face point at floor level (the machine's back edge center). */
  readonly position: Vec3Tuple;
  readonly facing: Facing;
  readonly zone: string;
  /** Pin a perk to this spot; otherwise spots are filled in catalog order. */
  readonly perk?: string;
}

/** `count` machines along X from `start` (wall face points), `step` meters apart. */
function perkRow(
  prefix: string,
  start: Vec3Tuple,
  step: number,
  count: number,
  facing: Facing,
  zone: string,
): PerkMachinePlacementDef[] {
  const out: PerkMachinePlacementDef[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ id: `${prefix}_${i + 1}`, position: [start[0] + step * i, start[1], start[2]], facing, zone });
  }
  return out;
}

export const PERK_MACHINES = {
  size: { width: 1.05, height: 2.4, depth: 0.76 },
  /** Cabinet bodies cast shadows (off: cheaper – they stand against walls). */
  castShadow: true,
  /** Gap between the wall face and the cabinet back (m). */
  wallGap: 0.03,
  materials: { body: 'wall_panel_dark', trim: 'trim_metal', hazard: 'painted_hazard' },
  /** Logo panel on the front (fractions of the cabinet) and its canvas. */
  logo: {
    width: 0.78,
    height: 0.98,
    y: 1.48,
    canvas: [320, 400] as readonly [number, number],
    intensity: 2.4,
  },
  /** Neon tubes along the front edges / crown and their glow. */
  neon: { radius: 0.022, intensity: 7, crownHeight: 0.14 },
  /** Dispenser slot: y (m) and size (fractions of the width / m). */
  dispenser: { y: 0.62, width: 0.62, height: 0.3, depth: 0.06 },
  /** Hum flicker of the neon (value noise): rate (Hz), depth, and the reduced-flashing depth. */
  flicker: { rate: 3.1, depth: 0.22, dropoutChance: 0.035, reducedDepth: 0.05 },
  /** Owned / unavailable machines: neon at this fraction (steady). */
  ownedIntensity: 0.45,
  /** Purchase flash decay (1/s) and peak multiplier. */
  flashDecay: 1.6,
  flashPeak: 2.2,
  /** Floor glow in front of the machine (m, linear intensity). */
  glowPool: { radius: 1.6, intensity: 0.45, forward: 0.55 },
  prompts: { buy: '{name} kaufen', owned: 'Bereits aktiv', limit: 'Perk-Limit erreicht' },
  logoText: { owned: 'AKTIV' },
  /** Prompt anchor: height and distance in front of the cabinet face (m). */
  anchor: { y: 1.3, offset: 0.3 },
  /** Bullet surface of the cabinet (`level:<id>` blocker mesh). */
  blockerMaterial: 'wall_panel_dark',
  placements: {
    lab: [
      { id: 'perk_reception_south', position: [1.4, 0, 30], facing: 'nz', zone: 'reception' },
      { id: 'perk_reception_east', position: [10, 0, 20.4], facing: 'nx', zone: 'reception' },
      { id: 'perk_atrium_sw', position: [-5.6, 0, 12], facing: 'nz', zone: 'atrium' },
      { id: 'perk_atrium_se', position: [5.6, 0, 12], facing: 'nz', zone: 'atrium' },
      { id: 'perk_atrium_west', position: [-14, 0, 4], facing: 'px', zone: 'atrium' },
      { id: 'perk_labs_east', position: [-19, 0, -4.5], facing: 'nx', zone: 'labs' },
      { id: 'perk_labs_west', position: [-35, 0, -8.5], facing: 'px', zone: 'labs' },
      { id: 'perk_server_sw', position: [22, 0, 12], facing: 'nz', zone: 'server' },
      { id: 'perk_server_se', position: [32.5, 0, 12], facing: 'nz', zone: 'server' },
      { id: 'perk_cryo_east', position: [35, 0, -14], facing: 'nx', zone: 'cryo' },
      { id: 'perk_cryo_north', position: [24, 0, -28], facing: 'pz', zone: 'cryo' },
      { id: 'perk_dock_sw', position: [-5.5, 0, -18.6], facing: 'nz', zone: 'dock' },
      { id: 'perk_dock_se', position: [5.5, 0, -18.6], facing: 'nz', zone: 'dock' },
      { id: 'perk_hall_east', position: [3, 0, 15.5], facing: 'nx', zone: 'atrium' },
      { id: 'perk_corridor_west', position: [-15, 0, 20.8], facing: 'pz', zone: 'labs' },
      { id: 'perk_corridor_east', position: [14.5, 0, 20.8], facing: 'pz', zone: 'server' },
    ],
    // Calibration hall: rows along the south wall (behind the player spawn) between the pilasters.
    testroom: [
      ...perkRow('perk_test_a', [-6.55, 0, 30], 1.3, 12, 'nz', 'hall'),
      ...perkRow('perk_test_b', [10.65, 0, 30], 1.3, 4, 'nz', 'hall'),
    ],
  } as Readonly<Record<string, readonly PerkMachinePlacementDef[]>>,
} as const;
