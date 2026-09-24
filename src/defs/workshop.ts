/**
 * Rift Forge machine and Werkbank (M5 package E2): interaction, the forge sequence, the bench menu,
 * sounds, the machines' looks and their per-map placements. Upgrade rules, tier prices and the
 * forged looks live in defs/forge.ts, attachments in defs/attachments.ts, element modules in
 * defs/elements.ts. Meters, seconds; colors are linear RGB triplets unless marked "sRGB hex".
 *
 * Placement convention (like PERK_MACHINES): `position` is the wall-face point at floor level
 * behind the machine (its back edge center) and `facing` the interior direction its front looks
 * to; `wallGap` keeps the back off the wall. Free-standing machines give the point where the
 * back would be.
 */
import type { Rgb } from './interactables';
import type { Facing, Vec3Tuple } from './level';

export interface WorkshopPlacementDef {
  readonly id: string;
  /** Wall-face point at floor level behind the machine. */
  readonly position: Vec3Tuple;
  readonly facing: Facing;
  readonly zone: string;
}

// ---------------------------------------------------------------------------
// Rift Forge (the machine)
// ---------------------------------------------------------------------------

export const RIFT_FORGE_MACHINE = {
  /** Use range from the eye to the prompt anchor (m). */
  range: 2.7,
  /** Footprint of the solid volume (collider, bullets, nav) – the whole machine. */
  size: { width: 3.2, height: 3.9, depth: 1.7 },
  wallGap: 0.05,
  /** Prompt anchor: height and distance in front of the anvil (m). */
  anchor: { y: 1.25, offset: 0.35 },
  /** Bullet surface of the machine (`level:<id>` blocker mesh). */
  blockerMaterial: 'pillar_metal',
  materials: {
    body: 'pillar_metal',
    panel: 'wall_panel_dark',
    trim: 'trim_metal',
    hazard: 'painted_hazard',
    deck: 'diamond_plate',
  },
  /**
   * The forge sequence (s after the purchase). The upgrade is applied at once (the forge.upgrade
   * sound – roar, three anvil strikes, rift choir – plays from forge:upgraded); the weapon is
   * handed to the machine (lowered out of view), the arms strike at `strikes`, the weapon returns
   * at `releaseAt` with its new look, and the machine cools down until `duration`.
   */
  sequence: {
    duration: 2.7,
    releaseAt: 2.2,
    /** The weapon hologram forms on the anvil (fade in) and bursts at the release. */
    holoIn: 0.3,
    holoFade: 0.25,
    strikes: [0.8, 1.25, 1.7] as readonly number[],
    /** Arm swing: down stroke, rebound (s). */
    strikeDown: 0.12,
    strikeUp: 0.3,
    /** Spark bursts per strike (VFX preset, scale) and the release burst. */
    sparkEffect: 'impact.metal',
    sparkScale: 1.6,
    releaseEffect: 'rift.spawn',
    releaseScale: 0.55,
    /** Screen shake per strike for a player within `shakeRange` (m); scaled by accessibility. */
    strikeShake: 0.14,
    shakeRange: 6,
  },
  /** Visual layout (local frame: origin floor center, +Z front). */
  layout: {
    plinth: { height: 0.16, inset: 0.02 },
    base: { width: 2.95, depth: 1.5, height: 0.56 },
    tower: { width: 1.9, depth: 0.8, back: -0.84, top: 3.55 },
    crown: { height: 0.3, overhang: 0.07 },
    pylon: { x: 1.3, width: 0.34, depth: 0.7, back: -0.55, top: 2.62 },
    /** Rift core window on the tower front. */
    core: { y: 2.4, radius: 0.62, ring: 0.095, segments: 48, recess: 0.1, corona: 1.9 },
    /** Coolant tanks behind the pylons with glowing rift-fluid windows. */
    tank: { x: 1.42, z: -0.62, radius: 0.17, height: 2.1, window: 0.05 },
    /** Exhaust stack on the crown. */
    stack: { radius: 0.2, height: 0.5, z: -0.45 },
    anvil: {
      z: 0.34,
      pedestal: [0.52, 0.34, 0.42] as Vec3Tuple,
      top: [0.98, 0.17, 0.4] as Vec3Tuple,
      horn: 0.26,
      /** The weapon hologram floats this far above the anvil top (m) at this length (m). */
      holoLift: 0.16,
      holoLength: 0.95,
    },
    /**
     * Hammer arms swinging in the front plane (about Z) from shoulders on the pylons: `pivot`
     * (x mirrored), the hammer head's center at the strike (x mirrored, y) and the lift of the
     * raised rest pose above the strike direction (deg).
     */
    arm: {
      pivot: [1.1, 2.3, 0.32] as Vec3Tuple,
      strikeAt: [0.27, 1.5] as readonly [number, number],
      liftDeg: 105,
      /** The arms rear back this much further while the weapon is fed in (deg). */
      cockDeg: 12,
      beam: 0.15,
      shoulder: 0.17,
      head: [0.36, 0.24, 0.34] as Vec3Tuple,
    },
    /** Front panel (tier prices) on the base: size, height of its center. */
    panel: { width: 2.2, height: 0.4, y: 0.4, canvas: [640, 116] as readonly [number, number] },
    strip: { width: 0.05, inset: 0.05 },
    vent: { width: 0.5, height: 0.9, y: 1.2, slats: 6 },
  },
  /** Molten amber accent strips and violet rift energy. */
  stripColor: [1.0, 0.36, 0.05] as Rgb,
  stripIntensity: 5,
  coreColor: [0.62, 0.2, 1.0] as Rgb,
  coreHotColor: [1.0, 0.55, 0.16] as Rgb,
  coreIntensity: 0.9,
  /** Soft additive corona around the core ring (fraction of the core intensity). */
  corona: { intensity: 0.55, forgingBoost: 2 },
  /** Heat vents on the tower flanks (dark when idle). */
  ventColor: [1.0, 0.3, 0.04] as Rgb,
  ventIntensity: 6,
  /** Swirl speed of the rift core (rad/s) idle / forging. */
  swirl: { idle: 0.35, forging: 2.6 },
  /** Forging multipliers: core, strips, pool (at the peak of the sequence). */
  forgingBoost: { core: 2.6, strips: 1.8, pool: 2.4 },
  /** Idle breathing (rad/s, depth) and its reduced-flashing depth. */
  pulse: { rate: 1.1, depth: 0.22, reducedDepth: 0.08 },
  /** Strike flash (added to the strips / core, decays 1/s). */
  strikeFlash: { peak: 1.6, decay: 6 },
  glowPool: { radius: 2.4, intensity: 0.5, forward: 1.05, color: [1.0, 0.42, 0.12] as Rgb },
  /** Hologram of the weapon on the anvil (additive). */
  hologram: { intensity: 1.8, spinRate: 0.9, bob: 0.015 },
  /** Panel (canvas) caption and color. */
  panelCaption: 'RIFT-SCHMIEDE',
  panelColor: [1.0, 0.55, 0.16] as Rgb,
  panelIntensity: 2,
  /** Prompts beyond defs/forge FORGE.prompts. */
  prompts: {
    /** The held weapon is being switched (no weapon to hand over yet). */
    busy: 'Waffe wird gewechselt',
  },
  placements: {
    // Ladedock (the last blast door): against the loading platform, west of the entrance arch.
    lab: [{ id: 'forge_dock', position: [-10.2, 0, -26.5], facing: 'pz', zone: 'dock' }],
    // Calibration hall: west of the spawn, facing east across the spawn area.
    testroom: [{ id: 'forge_test', position: [-14.2, 0, 25.2], facing: 'px', zone: 'hall' }],
  } as Readonly<Record<string, readonly WorkshopPlacementDef[]>>,
} as const;

// ---------------------------------------------------------------------------
// Werkbank (the bench and its menu)
// ---------------------------------------------------------------------------

export const WORKBENCH = {
  range: 2.4,
  size: { width: 2.0, height: 2.3, depth: 0.9 },
  wallGap: 0.04,
  anchor: { y: 1.15, offset: 0.3 },
  blockerMaterial: 'wall_panel_dark',
  materials: {
    body: 'wall_panel_dark',
    top: 'diamond_plate',
    trim: 'trim_metal',
    hazard: 'painted_hazard',
    board: 'pillar_metal',
  },
  layout: {
    top: { y: 0.92, thickness: 0.07 },
    leg: 0.08,
    shelf: 0.24,
    /** Drawer cabinet under the right half. */
    cabinet: { width: 0.62 },
    board: { height: 1.08, depth: 0.05, lift: 0.08 },
    lamp: { height: 0.05, depth: 0.28, drop: 0.06 },
    /** Weapon projector on the bench top: disc radius, hologram lift / length (m). */
    projector: { radius: 0.19, lift: 0.3, holoLength: 0.8 },
    /** Status screen on the board (right side): size and center height above the top. */
    screen: { width: 0.62, height: 0.36, y: 0.62, canvas: [320, 184] as readonly [number, number] },
  },
  lampColor: [0.55, 0.9, 1.0] as Rgb,
  lampIntensity: 4.5,
  accentColor: [0.2, 1.0, 0.65] as Rgb,
  accentIntensity: 3.5,
  hologram: { color: [0.3, 0.95, 0.85] as Rgb, intensity: 1.2, spinRate: 0.45, bob: 0.01 },
  /** Idle breathing of the accents, purchase flash (peak ×, decay 1/s). */
  pulse: { rate: 0.9, depth: 0.15 },
  flash: { peak: 2.4, decay: 3 },
  glowPool: { radius: 1.6, intensity: 0.4, forward: 0.7, color: [0.25, 0.95, 0.75] as Rgb },
  screenCaption: 'WERKBANK',
  screenLines: ['AUFSÄTZE', 'ELEMENT-MODULE'] as readonly string[],
  screenColor: [0.3, 1.0, 0.8] as Rgb,
  screenIntensity: 1.8,
  prompts: {
    open: 'Werkbank benutzen',
    noWeapon: 'Keine Waffe in der Hand',
    nothing: 'Keine Aufsätze für diese Waffe',
    /** `{name}` = attachment name / element short name. */
    buy: 'Kaufen: {name}',
    remove: 'Abnehmen: {name}',
    install: 'Einbauen: Element {name}',
    uninstall: 'Ausbauen: Element {name}',
  },
  /** Sound ids (package D synthesizes them): the menu opening / closing at the bench. */
  sounds: {
    open: { id: 'bench.open', gain: 0.5 },
    close: { id: 'bench.close', gain: 0.45 },
  },
  placements: {
    // Atrium (mid-map, behind the first door): on the east wall between two ring supports.
    lab: [{ id: 'bench_atrium', position: [14, 0, 6.3], facing: 'nx', zone: 'atrium' }],
    // Calibration hall: east of the spawn, facing west.
    testroom: [{ id: 'bench_test', position: [10.8, 0, 25.4], facing: 'nx', zone: 'hall' }],
  } as Readonly<Record<string, readonly WorkshopPlacementDef[]>>,
} as const;

/** The compact bench menu next to the crosshair (src/ui/hud/WorkbenchMenu.ts). */
export const WORKBENCH_MENU = {
  title: 'WERKBANK',
  elementGroup: 'Element-Modul',
  /** Rows visible at once (the list scrolls with the selection). */
  visibleRows: 8,
  /** Row states (German). */
  equipped: 'MONTIERT',
  installed: 'EINGEBAUT',
  /** Key hints under the list: navigate / use. */
  hints: { select: 'Auswahl', keysKbm: 'RAD', keysPad: '▲▼ / Y' },
  /** Stat line: mods with |factor − 1| below this are left out; at most this many chips. */
  statEpsilon: 0.005,
  maxStats: 4,
  /** Purchase flash of the selected row (s). */
  flashSeconds: 0.45,
  /** Gamepad buttons (W3C standard indices) that move the selection: D-pad down / up. */
  padNext: 13,
  padPrev: 12,
} as const;

/**
 * Stat chips of the bench menu: German labels per WeaponStatMods key and whether a factor > 1 is
 * good for the player (drives the chip color). Order = display priority.
 */
export const BENCH_STAT_LABELS: readonly {
  readonly key: string;
  readonly label: string;
  readonly higherIsBetter: boolean;
}[] = [
  { key: 'damage', label: 'Schaden', higherIsBetter: true },
  { key: 'magazine', label: 'Magazin', higherIsBetter: true },
  { key: 'reserve', label: 'Reserve', higherIsBetter: true },
  { key: 'recoil', label: 'Rückstoß', higherIsBetter: false },
  { key: 'spread', label: 'Streuung', higherIsBetter: false },
  { key: 'hipSpread', label: 'Hüftstreuung', higherIsBetter: false },
  { key: 'range', label: 'Reichweite', higherIsBetter: true },
  { key: 'penetration', label: 'Durchschlag', higherIsBetter: true },
  { key: 'reloadTime', label: 'Nachladezeit', higherIsBetter: false },
  { key: 'adsTime', label: 'Anschlagzeit', higherIsBetter: false },
  { key: 'equipTime', label: 'Ziehzeit', higherIsBetter: false },
  { key: 'moveSpeed', label: 'Tempo', higherIsBetter: true },
  { key: 'blastRadius', label: 'Explosionsradius', higherIsBetter: true },
  { key: 'projectileSpeed', label: 'Geschosstempo', higherIsBetter: true },
  { key: 'rpm', label: 'Feuerrate', higherIsBetter: true },
];
