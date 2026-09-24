/**
 * Power-ups (M4, src/powerups/PowerUpSystem): rift-energy drops of killed enemies, collected by
 * walking into them. Every power-up is data: an effect kind with its parameters, a duration (0 =
 * instant; timed ones scale with the powerUpDuration stat and refresh when collected again), a
 * random-drop weight and a drop condition. Names and descriptions are player-facing (German).
 *
 * Drops (CoD-Zombies style): each player kill of an enemy rolls `drops.chance` × the dropChance
 * stat; at most `maxPerWave` per wave, never two within `minSpacing` s, never the same type twice
 * in a row; `pity` guarantees one after that many kills or seconds of wave time without a drop.
 * Nuke kills and flagged (dev) kills drop nothing.
 *
 * Glyphs: stroke-only SVG path data in a 24×24 box (like PERK_GLYPHS): the pickup hologram draws
 * them on a canvas, a HUD can use them in `<path d>`.
 */
import { ECONOMY } from './economy';
import type { Rgb } from './enemies';
import type { StatKey } from './stats';

export type PowerUpEffectDef =
  /** Kill every non-boss enemy with credit (EnemyManager.killAll(true)) and pay `points`. */
  | { readonly kind: 'nuke'; readonly points: number }
  /** Timed stat modifier (source `powerup:<id>`) – Double Points. */
  | { readonly kind: 'stat'; readonly stat: StatKey; readonly op: 'add' | 'mul'; readonly value: number }
  /** Timed: player damage is lethal (bosses excepted). */
  | { readonly kind: 'instakill' }
  /** Refill every carried weapon's reserve (and magazines when `fillMagazines`). */
  | { readonly kind: 'maxAmmo'; readonly fillMagazines: boolean }
  /** Restore every rift seal, refill armor (when `armor`) and pay `points`. */
  | { readonly kind: 'carpenter'; readonly points: number; readonly armor: boolean }
  /** Timed: enemies run at `scale` (player at normal speed); a screen tint while it lasts. */
  | { readonly kind: 'enemyTimeScale'; readonly scale: number }
  /** Small ammo scraps (Aasgeier perk): `reserveFraction` of every reserve. */
  | { readonly kind: 'ammoScrap'; readonly reserveFraction: number };

export type PowerUpEffectKind = PowerUpEffectDef['kind'];

/** Random drops only when … ('sealsDamaged': at least one seal bar is down). */
export type PowerUpCondition = 'none' | 'sealsDamaged';

export interface PowerUpDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly effect: PowerUpEffectDef;
  /** Seconds (× powerUpDuration stat); 0 = instant. */
  readonly duration: number;
  /** Random drop weight (0 = never dropped at random: forced drops / perk hooks only). */
  readonly weight: number;
  readonly condition: PowerUpCondition;
  /** Counts towards the per-wave cap and the pity counter (false: perk scraps). */
  readonly counted: boolean;
  /** Hologram color (linear RGB; × the visual intensities) and the HUD color (sRGB hex). */
  readonly color: Rgb;
  readonly hudColor: number;
  readonly glyph: PowerUpGlyphId;
  /** Pickup size multiplier and lifetime override (s, 0 = POWERUPS.pickup.lifetime). */
  readonly scale: number;
  readonly lifetime: number;
}

export const POWERUP_GLYPHS = {
  /** Radiation trefoil: the rift collapsing. */
  nuke:
    'M10.4 9.23 7.5 4.21A9 9 0 0 1 16.5 4.21L13.6 9.23A3.2 3.2 0 0 0 10.4 9.23Z ' +
    'M15.2 12 21 12A9 9 0 0 1 16.5 19.79L13.6 14.77A3.2 3.2 0 0 0 15.2 12Z ' +
    'M10.4 14.77 7.5 19.79A9 9 0 0 1 3 12L8.8 12A3.2 3.2 0 0 0 10.4 14.77Z ' +
    'M10.6 12A1.4 1.4 0 1 0 13.4 12 1.4 1.4 0 1 0 10.6 12',
  /** "x2". */
  double:
    'M3.5 8 10 15 M10 8 3.5 15 ' +
    'M13.5 9.2C13.9 7.2 15.4 6.5 16.9 6.5 18.8 6.5 20.3 7.8 20.3 9.6 20.3 12.4 13.8 14.2 13.5 17.5H20.5',
  /** Skull. */
  skull:
    'M5 11C5 6 8.5 3.5 12 3.5 15.5 3.5 19 6 19 11 19 13.5 17.8 15 16.5 15.8V19.5H7.5V15.8C6.2 15 5 13.5 5 11Z ' +
    'M8.5 10.8A1.7 1.7 0 1 0 11.9 10.8 1.7 1.7 0 1 0 8.5 10.8 M12.1 10.8A1.7 1.7 0 1 0 15.5 10.8 1.7 1.7 0 1 0 12.1 10.8 ' +
    'M10.5 19.5V17 M13.5 19.5V17 M11.3 14.8 12 13.6 12.7 14.8',
  /** Three rounds. */
  ammo:
    'M4.5 19.5V11C4.5 9 5.2 7.3 6 6.3 6.8 7.3 7.5 9 7.5 11V19.5Z ' +
    'M10.5 19.5V9C10.5 7 11.2 5.3 12 4.3 12.8 5.3 13.5 7 13.5 9V19.5Z ' +
    'M16.5 19.5V11C16.5 9 17.2 7.3 18 6.3 18.8 7.3 19.5 9 19.5 11V19.5Z M3 21.5H21',
  /** A shield barred like a seal. */
  lattice: 'M12 2.5 20 6V12.5C20 17 16.6 20.2 12 21.5 7.4 20.2 4 17 4 12.5V6Z M8 9.5H16 M8 13.5H16',
  /** Hourglass. */
  hourglass:
    'M6 3H18 M6 21H18 M7 3C7 8 10.5 10 12 12 13.5 10 17 8 17 3 M7 21C7 16 10.5 14 12 12 13.5 14 17 16 17 21 ' +
    'M9.5 19.2H14.5 M10.5 6.5H13.5',
  /** A single round. */
  round: 'M9.5 20.5V10C9.5 7.5 10.6 5.5 12 4.2 13.4 5.5 14.5 7.5 14.5 10V20.5Z M7.5 20.5H16.5 M9.5 13H14.5',
} as const;

export type PowerUpGlyphId = keyof typeof POWERUP_GLYPHS;

/** Glyph atlas order (cell index = position in this list). */
export const POWERUP_GLYPH_IDS = Object.keys(POWERUP_GLYPHS) as PowerUpGlyphId[];

const DEFS = {
  nuke: {
    id: 'nuke',
    name: 'Riss-Kollaps',
    description: 'Der Riss implodiert: alle Kreaturen in der Station vergehen.',
    effect: { kind: 'nuke', points: ECONOMY.powerUps.nukeBonus },
    duration: 0,
    weight: 1,
    condition: 'none',
    counted: true,
    color: [1, 0.46, 0.12],
    hudColor: 0xff8a2a,
    glyph: 'nuke',
    scale: 1,
    lifetime: 0,
  },
  doublePoints: {
    id: 'doublePoints',
    name: 'Doppelte Punkte',
    description: 'Alle Punkte zählen doppelt.',
    effect: { kind: 'stat', stat: 'pointsMultiplier', op: 'mul', value: 2 },
    duration: 30,
    weight: 1.2,
    condition: 'none',
    counted: true,
    color: [0.25, 1, 0.42],
    hudColor: 0x5cff7a,
    glyph: 'double',
    scale: 1,
    lifetime: 0,
  },
  instakill: {
    id: 'instakill',
    name: 'Todesstoß',
    description: 'Jeder Treffer tötet sofort.',
    effect: { kind: 'instakill' },
    duration: 30,
    weight: 1,
    condition: 'none',
    counted: true,
    color: [1, 0.14, 0.2],
    hudColor: 0xff3344,
    glyph: 'skull',
    scale: 1,
    lifetime: 0,
  },
  maxAmmo: {
    id: 'maxAmmo',
    name: 'Munitionsflut',
    description: 'Alle Waffen voll aufmunitioniert.',
    effect: { kind: 'maxAmmo', fillMagazines: true },
    duration: 0,
    weight: 1.3,
    condition: 'none',
    counted: true,
    color: [1, 0.82, 0.25],
    hudColor: 0xffd24a,
    glyph: 'ammo',
    scale: 1,
    lifetime: 0,
  },
  carpenter: {
    id: 'carpenter',
    name: 'Versiegelung',
    description: 'Alle Riss-Siegel wiederhergestellt, Panzerung aufgeladen.',
    effect: { kind: 'carpenter', points: ECONOMY.powerUps.carpenterBonus, armor: true },
    duration: 0,
    weight: 0.8,
    condition: 'sealsDamaged',
    counted: true,
    color: [0.35, 0.85, 1],
    hudColor: 0x5ad8ff,
    glyph: 'lattice',
    scale: 1,
    lifetime: 0,
  },
  slowmo: {
    id: 'slowmo',
    name: 'Zeitdehnung',
    description: 'Die Kreaturen bewegen sich wie durch Sirup.',
    effect: { kind: 'enemyTimeScale', scale: 0.4 },
    duration: 10,
    weight: 0.8,
    condition: 'none',
    counted: true,
    color: [0.62, 0.32, 1],
    hudColor: 0xa066ff,
    glyph: 'hourglass',
    scale: 1,
    lifetime: 0,
  },
  ammoScrap: {
    id: 'ammoScrap',
    name: 'Munitionsreste',
    description: 'Ein Viertel Reservemunition für alle Waffen.',
    effect: { kind: 'ammoScrap', reserveFraction: 0.25 },
    duration: 0,
    weight: 0,
    condition: 'none',
    counted: false,
    color: [1, 0.72, 0.3],
    hudColor: 0xffb84d,
    glyph: 'round',
    scale: 0.6,
    lifetime: 15,
  },
} as const satisfies Record<string, PowerUpDef>;

export const POWERUP_DEFS: Readonly<Record<string, PowerUpDef>> = DEFS;

export type PowerUpId = keyof typeof DEFS;

/** Every power-up id, table order (HUD, console, the timer table). */
export const POWERUP_IDS = Object.keys(DEFS) as PowerUpId[];

export function getPowerUpDef(id: string): PowerUpDef | undefined {
  return Object.prototype.hasOwnProperty.call(DEFS, id) ? POWERUP_DEFS[id] : undefined;
}

export const POWERUPS = {
  drops: {
    /** Per eligible kill, × the dropChance stat. */
    chance: 0.025,
    maxPerWave: 4,
    /** A kill drops for sure after this many kills or seconds of wave time without a drop. */
    pity: { kills: 40, seconds: 100 },
    /** No two random drops closer than this (s). */
    minSpacing: 5,
    /** Never the same type twice in a row. */
    noRepeat: true,
  },
  /** Pooled pickup slots (incl. ones playing their collect animation). */
  capacity: 8,
  pickup: {
    /** Seconds on the floor; blinks during the last `blinkTime` s, faster towards the end. */
    lifetime: 26,
    blinkTime: 6,
    blinkHz: [1.6, 7] as readonly [number, number],
    /** Share of a blink period the hologram stays lit. */
    blinkDuty: 0.62,
    /** Collected when the player's feet come within `radius` (XZ) and `height` (Y) of its floor spot. */
    radius: 1.15,
    height: 1.9,
    /** Glyph hover height above the floor, bob, wobble (the glyph turns towards the camera). */
    hover: 1.05,
    bobAmplitude: 0.09,
    bobHz: 0.5,
    wobbleDeg: 28,
    wobbleHz: 0.32,
    /** Materialize and collect (implode) animations (s). */
    spawnTime: 0.45,
    collectTime: 0.4,
    /** Drop positions snap to the floor below within this distance (m). */
    snapMaxDrop: 3,
  },
  visual: {
    /**
     * Glyph quad size (m), the sigil's share of it, its ring radius (fraction of the quad), light
     * shaft, floor ring (m).
     */
    glyphSize: 1,
    glyphFill: 0.8,
    ring: 0.47,
    shaftHeight: 3.2,
    shaftWidth: 1.1,
    floorRadius: 1.3,
    intensity: { glyph: 4.5, ring: 2.2, shaft: 1.4, floor: 0.9, flash: 5 },
    /** Canvas atlas: cell size (px), columns, stroke width (glyph units), glow blur (px). */
    atlas: { cell: 128, cols: 4, stroke: 1.9, glowBlur: 7 },
    renderOrder: 3,
  },
  effects: {
    /** Slow-motion screen tint easing (s). */
    tint: { fadeIn: 0.35, fadeOut: 0.8 },
    /** Nuke default FX (no callback wired): combat:explosion radius, camera trauma, hit pulse. */
    nuke: { radius: 12, shake: 0.85, pulse: 1 },
  },
  /** Collect / spawn VFX presets (defs/vfx.ts) × scale. */
  vfx: { spawn: 'impact.shield', spawnScale: 1.4, collect: 'rift.spawn', collectScale: 0.55 },
  /** Dev console: spawn distance in front of the player (m). */
  consoleDistance: 3,
} as const;
