/**
 * Rift seals (M4, the barricade equivalent, src/seals): every spawn point of a wave map gets an
 * energy lattice ("Riss-Siegel") of `segments` glowing bars between two emitter pylons, standing
 * `offset` m in front of the spawn point across its emerge direction. Enemies emerging there are
 * held in the pen behind it and tear the bars down (per-type timing: defs/enemies.ts `breach`);
 * the player repairs one bar per hold of 'interact' (points: defs/economy.ts ECONOMY.repair, capped
 * per wave). The lattice never stops bullets (it is no `level:` mesh): shoot the breachers through it.
 *
 * Meters, seconds. Colors: linear RGB, multiplied by the HDR intensities (bars bloom).
 */
import type { SpawnPointDef } from '../core/contracts';
import type { Rgb } from './enemies';

export type SealKind = SpawnPointDef['kind'];

/** Gate placement relative to its spawn point. */
export interface SealGateDef {
  /** Seal plane distance in front of the spawn point, along the spawn yaw (m). */
  readonly offset: number;
  /** Full width between the emitter pylons before wall fitting (m). */
  readonly width: number;
  /** Lowest bar above the floor and the lattice top (m). */
  readonly bottom: number;
  readonly height: number;
}

export const SEALS = {
  /** Segments (bars) per seal. */
  segments: 5,
  /** Interactable id prefix (`seal:<spawnPointId>`); events carry the same id. */
  idPrefix: 'seal:',

  gates: {
    rift: { offset: 1.05, width: 3.2, bottom: 0.3, height: 2.55 },
    vent: { offset: 1.05, width: 3, bottom: 0.3, height: 2.35 },
    floor: { offset: 1.5, width: 3.4, bottom: 0.3, height: 2.55 },
  } satisfies Record<SealKind, SealGateDef>,

  /**
   * Fitting the gate into the room (static rays at build time, when a probe is wired): the pylons
   * stay `wallMargin` off side walls (never below `minHalfWidth`), the top `ceilingMargin` below a
   * ceiling (never below `minHeight`), the plane `frontMargin` before a wall ahead of the spawn point.
   */
  fit: {
    probeHeight: 1,
    wallMargin: 0.3,
    minHalfWidth: 0.8,
    ceilingMargin: 0.2,
    minHeight: 1.6,
    frontMargin: 0.4,
    minOffset: 0.6,
  },

  /**
   * The pen behind the seal where breaching enemies wait: at least `standOff` m (plus their radius)
   * behind the plane, at most `depth` m, `sideMargin` m inside the pylons.
   */
  pen: { standOff: 0.45, depth: 2.4, sideMargin: 0.1 },

  repair: {
    /** Hold 'interact' this long per restored bar (s). */
    holdTime: 0.55,
    /** Use range from the eye to the prompt anchor (m); the anchor sits this high on the plane. */
    range: 2.9,
    anchorHeight: 1.1,
  },

  /** HUD prompts (German). */
  prompts: {
    repair: 'Riss-Siegel reparieren',
    repairNoPoints: 'Riss-Siegel reparieren (Punktelimit erreicht)',
  },

  visual: {
    colors: {
      /** White-hot bar core, violet glow around it, faint hex lattice between the bars. */
      core: [0.42, 0.86, 1] as Rgb,
      glow: [0.46, 0.16, 1] as Rgb,
      lattice: [0.4, 0.24, 1] as Rgb,
      emitter: [0.3, 0.88, 1] as Rgb,
      /** Warning tint of a damaged seal (emitters, breaking bars). */
      damaged: [1, 0.14, 0.38] as Rgb,
    },
    intensity: { core: 3.4, glow: 2.2, lattice: 0.42, emitter: 3.4, floor: 0.4, flash: 2.6 },
    bar: {
      /** Ribbon quad width incl. the glow (m) and the hot core's share of it. */
      width: 0.3,
      core: 0.075,
      /** Energy flow along the bar: speed (m/s) and noise scale (1/m); idle wobble (m). */
      flowSpeed: 2.2,
      flowScale: 2.6,
      wobble: 0.012,
    },
    /** Hex lattice cell (m), line width (fraction of a cell) and vertical drift (m/s). */
    lattice: { cell: 0.2, line: 0.08, drift: 0.05 },
    emitter: { width: 0.13, scanSpeed: 0.8 },
    /** Floor glow strip in front of / behind the plane (m). */
    floor: { depth: 1.1 },
    /** Bar re-forming (grows from the pylons) and shattering durations (s). */
    formTime: 0.45,
    breakTime: 0.38,
    /** Hit flash and ripple decay (1/s). */
    flashDecay: 4.5,
    rippleDecay: 2.2,
    /** Damaged-seal warning pulse (Hz). */
    warnHz: 1.6,
    /** Reduced flashing: flashes / flicker scaled by this. */
    reducedFlash: 0.3,
    pylon: {
      size: 0.16,
      /** Pylon top above the lattice (m) and the base plate. */
      extra: 0.22,
      baseSize: 0.34,
      baseHeight: 0.07,
      /** Emitter strip offset from the pylon axis towards the gate (m). */
      stripInset: 0.09,
      color: 0x1b1f27,
      metalness: 0.85,
      roughness: 0.36,
    },
    /** Render order among the volumetric-layer draws. */
    renderOrder: 3,
  },

  /** VFX presets (defs/vfx.ts) × scale: a bar shattering, a swing flashing the seal, a bar repaired. */
  vfx: {
    break: 'impact.shield',
    breakScale: 2.6,
    hit: 'impact.shield',
    hitScale: 1.1,
    repair: 'impact.shield',
    repairScale: 1.6,
  },
} as const;

export function sealGateDef(kind: string): SealGateDef {
  const g = SEALS.gates as Readonly<Record<string, SealGateDef>>;
  return g[kind] ?? SEALS.gates.rift;
}
