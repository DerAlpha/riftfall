/**
 * Active abilities with cooldown (M5 "Fähigkeiten mit Cooldown"): data for
 * src/abilities/AbilitySystem. One ability is equipped (the map loadout's LoadoutDef.ability, else
 * ABILITY_RULES.defaultAbility; later meta progression) and used with the 'ability' action.
 *
 * An ability is composed from optional parts – the system applies whatever a def carries and never
 * branches on an id:
 * - `blast`: a radial explosion around the player (ExplosionApi: falloff, line of sight, knockback,
 *   element build-up, prop pushes) – Schockwelle;
 * - `modifiers`: stat modifiers (source `ability:<id>`) for `duration` s – Phasenbarriere
 *   (damageTaken), Überladung (fireRate, reloadSpeed);
 * - `field`: a lingering FieldApi field, `follow` = it moves with the player – Chronofeld;
 * - looks: `weaponGlow` (viewmodel accent boost while active), `screen` (HUD overlay while
 *   active: ArsenalHud), `world` (in-world visual: AbilityVisuals).
 * The cooldown starts when the ability is used (it is longer than the effect).
 *
 * Damage ids: `ability.<id>`. Glyphs are stroke-only SVG path data in a 24×24 box (like defs/perks
 * PERK_GLYPHS), colours sRGB (HUD) or linear RGB (`world` visuals). Units: m, s.
 */
import { explosion } from './weaponData/common';
import type { StatKey } from './stats';
import type { ExplosionDef, FieldDef } from './weapons';
import type { Rgb } from './vfx';

export const ABILITY_GLYPHS = {
  /** Schockwelle: a bolt between widening wave fronts. */
  shockwave:
    'M12.8 7.5 10.2 12.3H13.8L11.2 17 M7.6 7.2A6.8 6.8 0 0 0 7.6 16.8 M16.4 7.2A6.8 6.8 0 0 1 16.4 16.8 M4.2 4.6A10.6 10.6 0 0 0 4.2 19.4 M19.8 4.6A10.6 10.6 0 0 1 19.8 19.4',
  /** Phasenbarriere: nested hexagonal shield cells. */
  barrier:
    'M12 2.5 20.2 7.25V16.75L12 21.5 3.8 16.75V7.25Z M12 7 15.9 9.25V13.75L12 16 8.1 13.75V9.25Z M12 2.5V7 M20.2 16.75 15.9 13.75 M3.8 16.75 8.1 13.75',
  /** Überladung: a lightning bolt with rising chevrons. */
  overcharge:
    'M13.5 2.5 6.5 13H11.2L10.2 21.5 17.5 10.5H12.8Z M18.5 17.5 20.5 15.5 22.5 17.5 M1.5 8.5 3.5 6.5 5.5 8.5',
  /** Chronofeld: a clock face in a field ring. */
  chrono:
    'M12 5A7 7 0 1 0 12 19 7 7 0 1 0 12 5 M12 8.2V12L14.8 13.6 M3.2 9.2A9.3 9.3 0 0 0 3.2 14.8 M20.8 9.2A9.3 9.3 0 0 1 20.8 14.8 M12 2.2V3.4 M12 20.6V21.8',
} as const satisfies Record<string, string>;

export type AbilityGlyphId = keyof typeof ABILITY_GLYPHS;

export interface AbilityStatModDef {
  readonly stat: StatKey;
  readonly op: 'add' | 'mul';
  readonly value: number;
}

export interface AbilityBlastDef {
  readonly explosion: ExplosionDef;
  /** Blast center above the player's feet (m): low, so the burst spreads over the floor in view. */
  readonly centerHeight: number;
}

export interface AbilityFieldDef {
  readonly field: FieldDef;
  /** Moves with the player every tick (FieldApi.move) instead of staying where it was cast. */
  readonly follow: boolean;
}

/** HUD overlays while an ability runs (ArsenalHud, hud-arsenal.css). */
export type AbilityScreenFx = 'shield' | 'overcharge' | 'chrono';
/** In-world visuals (AbilityVisuals): a shock ring racing over the floor, a time dome around the player. */
export type AbilityWorldFx = 'shockRing' | 'chronoDome';

export interface AbilityDef {
  readonly id: string;
  /** Player-facing (German). */
  readonly name: string;
  /** HUD label (German, upper case). */
  readonly shortName: string;
  readonly description: string;
  readonly icon: AbilityGlyphId;
  /** HUD colour (sRGB hex). */
  readonly color: number;
  /** Seconds from use until it is ready again. */
  readonly cooldown: number;
  /** Seconds the effect lasts (0 = instant: no ability:ended). */
  readonly duration: number;
  readonly blast: AbilityBlastDef | null;
  readonly modifiers: readonly AbilityStatModDef[];
  readonly field: AbilityFieldDef | null;
  /** Extra viewmodel accent emissive intensity while active (0 = none). */
  readonly weaponGlow: number;
  readonly screen: AbilityScreenFx | null;
  readonly world: AbilityWorldFx | null;
}

export const ABILITIES = {
  schockwelle: {
    id: 'schockwelle',
    name: 'Schockwelle',
    shortName: 'SCHOCKWELLE',
    description: 'Entlädt eine Schockfront um dich: schleudert Gegner zurück und lähmt sie.',
    icon: 'shockwave',
    color: 0x5cc8ff,
    cooldown: 18,
    duration: 0,
    blast: {
      explosion: explosion('shock', 7, 140, {
        minFalloff: 0.45,
        impulse: 12,
        propImpulse: 520,
        selfDamage: 0,
        shake: 0.45,
        // The Nova blast is built to burst around the player at floor level (no fireball on the camera).
        vfx: 'perk.nova',
      }),
      centerHeight: 0.6,
    },
    modifiers: [],
    field: null,
    weaponGlow: 0,
    screen: null,
    world: 'shockRing',
  },
  phasenbarriere: {
    id: 'phasenbarriere',
    name: 'Phasenbarriere',
    shortName: 'BARRIERE',
    description: 'Ein Phasenschild schluckt 65 % des erlittenen Schadens.',
    icon: 'barrier',
    color: 0x6affd8,
    cooldown: 30,
    duration: 7,
    blast: null,
    modifiers: [{ stat: 'damageTaken', op: 'mul', value: 0.35 }],
    field: null,
    weaponGlow: 0,
    screen: 'shield',
    world: null,
  },
  ueberladung: {
    id: 'ueberladung',
    name: 'Überladung',
    shortName: 'ÜBERLADUNG',
    description: 'Überlädt deine Waffe: schnelleres Feuer und blitzschnelles Nachladen.',
    icon: 'overcharge',
    color: 0xff9f3a,
    cooldown: 32,
    duration: 8,
    blast: null,
    modifiers: [
      { stat: 'fireRate', op: 'mul', value: 1.35 },
      { stat: 'reloadSpeed', op: 'mul', value: 1.6 },
    ],
    field: null,
    weaponGlow: 5,
    screen: 'overcharge',
    world: null,
  },
  chronofeld: {
    id: 'chronofeld',
    name: 'Chronofeld',
    shortName: 'CHRONOFELD',
    description: 'Ein Zeitfeld um dich verlangsamt jeden Gegner darin drastisch.',
    icon: 'chrono',
    color: 0xb9a4ff,
    cooldown: 36,
    duration: 7,
    blast: null,
    modifiers: [],
    field: {
      // No arsenal visual (vfx ''): AbilityVisuals draws the dome that moves with the player.
      field: {
        kind: 'slow',
        radius: 8,
        duration: 7,
        dps: 0,
        element: 'physical',
        strength: 0.3,
        collapse: null,
        vfx: '',
        audio: 'field.slow.chrono',
      },
      follow: true,
    },
    weaponGlow: 0,
    screen: 'chrono',
    world: 'chronoDome',
  },
} as const satisfies Record<string, AbilityDef>;

export type AbilityId = keyof typeof ABILITIES;

/** Every ability, in display order. */
export const ABILITY_IDS: readonly AbilityId[] = [
  'schockwelle',
  'phasenbarriere',
  'ueberladung',
  'chronofeld',
];

export function getAbilityDef(id: string): AbilityDef | undefined {
  return Object.prototype.hasOwnProperty.call(ABILITIES, id)
    ? (ABILITIES as Record<string, AbilityDef>)[id]
    : undefined;
}

export const ABILITY_RULES = {
  /** Equipped when the loadout names none (meta progression picks it later). */
  defaultAbility: 'schockwelle',
  /** Viewmodel weapon glow eases in/out at this rate (1/s) and throbs (rad/s, depth of the glow). */
  glowLambda: 8,
  glowPulse: { rate: 9, depth: 0.35 },
} as const;

/** In-world ability visuals (AbilityVisuals): additive, on RENDER.volumetricLayer, self-fogged. */
export const ABILITY_VISUALS = {
  /** Schockwelle: a ring racing out over the floor to the blast radius, with a low light wall. */
  shockRing: {
    duration: 0.55,
    /** Ring band width as a fraction of the current radius, and the wall's height (m). */
    width: 0.18,
    wallHeight: 0.9,
    color: [0.25, 0.6, 1] as Rgb,
    /** Ring (floor) and light wall brightness: the wall stays faint – it faces the camera all round. */
    intensity: 6,
    wallIntensity: 0.7,
    /** Screen-space shockwave (render.addShockwave): radius × blast radius, strength. */
    shockwaveRadius: 1.3,
    shockwave: 0.55,
  },
  /** Chronofeld: a time dome around the player – floor rings, a rim curtain, clock ticks. */
  chronoDome: {
    /** Grow in / fade out (s). */
    fadeIn: 0.35,
    fadeOut: 0.6,
    /** Rim curtain height (m) and floor ripple speed (rings per second, inwards: slowed time). */
    wallHeight: 2.4,
    rippleRate: 0.35,
    ticks: 24,
    color: [0.55, 0.45, 1] as Rgb,
    rimColor: [0.8, 0.72, 1] as Rgb,
    /** Floor rings and the curtain (fainter: it stands in the line of sight all round). */
    intensity: 3,
    wallIntensity: 1.4,
    /** Floor probe below the player for the dome's base (m). */
    floorProbe: 4,
    /** Screen-space shockwave when it opens. */
    shockwave: 0.3,
  },
  /** Ring/disc mesh resolution. */
  segments: 96,
  renderOrder: 14,
  /** Brightness with the reduce-flashing option. */
  reducedFlashingScale: 0.6,
} as const;

/** CSS colour (sRGB) of an ability's HUD glyph. */
export function abilityCssColor(def: Pick<AbilityDef, 'color'>): string {
  return `#${def.color.toString(16).padStart(6, '0')}`;
}
