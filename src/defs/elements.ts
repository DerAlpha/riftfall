/**
 * Elements & status effects (M5 "Elementar-Mods"): element → status build-up, status tuning,
 * elemental combos, per-enemy status resistances and the five purchasable element modules.
 *
 * How it plays (combat/status/StatusEffectSystem):
 * - Elemental damage builds up its element's status on the target: applied damage × the source's
 *   DamageInfo.statusBuildup (ARSENAL.statusBuildup: 1 per point for every element), plus the
 *   `elementProc` specials. Build-up decays after `buildup.decayDelay` without new build-up; each
 *   `threshold` reached triggers the status (again) and spends the threshold.
 * - burn (fire): damage over time, spreads a little fire build-up to neighbours.
 * - chill (ice): stacks, each slows movement AND attacks; a trigger at max stacks freezes.
 *   frozen: immobile, no AI; a heavy hit shatters it for bonus damage. Freeze immunity after.
 * - shocked (shock): a short stun (stun immunity after) and arcs to nearby enemies.
 * - poisoned (poison): stacking damage over time; a body dying with enough stacks leaves a cloud.
 * - voidMark (void): damage taken up; more void while marked charges an implosion.
 * - combos: a status landing while its partner is active reacts (COMBOS, first match wins, the
 *   pairs before voidrupture). Per-target cooldown and a per-tick budget keep hordes readable.
 * - DoT / combo / arc damage is dealt through CombatWorld with non-discrete kinds ('beam' ticks,
 *   'explosion' areas): it pays kill points only (PointsRules), never per-tick hit points.
 * - Damage over time and combo damage scale with the target's toughness (wave health multiplier,
 *   elites) so elements stay relevant late; crowd control scales with STATUS_RESIST.
 *
 * Colors: `rim` / `color` are LINEAR hex (enemy rim light, VFX); `css` is the sRGB UI color.
 * Glyphs are stroke-only SVG path data in a 24×24 box (like defs/perks PERK_GLYPHS).
 * Times in seconds, distances in meters.
 */
import type { DamageElement, StatusId } from '../core/events';
import { explosion, field } from './weaponData/common';
import type { WeaponDef } from './weapons';

/** Elements that build up a status ('physical' builds nothing). */
export type StatusElement = Exclude<DamageElement, 'physical'>;

/** Index order of the per-element build-up arrays. */
export const STATUS_ELEMENTS: readonly StatusElement[] = ['fire', 'ice', 'shock', 'poison', 'void'];

export const STATUS_IDS: readonly StatusId[] = ['burn', 'chill', 'frozen', 'shocked', 'poisoned', 'voidMark'];

/** The status an element builds (ice builds chill; frozen comes from chill). */
export const ELEMENT_STATUS: Readonly<Record<StatusElement, StatusId>> = {
  fire: 'burn',
  ice: 'chill',
  shock: 'shocked',
  poison: 'poisoned',
  void: 'voidMark',
};

/** The element behind a status (combos pair elements: chill and frozen are both ice). */
export const STATUS_ELEMENT: Readonly<Record<StatusId, StatusElement>> = {
  burn: 'fire',
  chill: 'ice',
  frozen: 'ice',
  shocked: 'shock',
  poisoned: 'poison',
  voidMark: 'void',
};

/** German status names (HUD / tooltips). */
export const STATUS_NAMES: Readonly<Record<StatusId, string>> = {
  burn: 'Brennend',
  chill: 'Unterkühlt',
  frozen: 'Eingefroren',
  shocked: 'Geschockt',
  poisoned: 'Vergiftet',
  voidMark: 'Void-Mal',
};

export const ELEMENTS = {
  /** Status slots (damageables with any build-up or status); spawns beyond it are ignored. */
  capacity: 128,
  /** Statuses land on damageables of this team only (enemies, training dummies – not shields). */
  team: 'enemy',
  buildup: {
    /** Build-up per status trigger (spent on each trigger). */
    threshold: { fire: 100, ice: 85, shock: 110, poison: 70, void: 140 } satisfies Record<StatusElement, number>,
    /** Seconds without new build-up of an element before it decays, and the decay (points/s). */
    decayDelay: 1.2,
    decayPerSecond: 55,
  },
  /** Damage-over-time ticks (burn, poison): dps × interval per tick. */
  dotInterval: 0.5,
  burn: {
    duration: 4,
    /** × the target's toughness (healthScale). */
    dps: 12,
    /**
     * Fire build-up handed to up to `maxTargets` neighbours within `radius` every `interval`: a
     * neighbour pressed against a body for its whole burn catches fire.
     */
    spread: { interval: 0.8, radius: 2.2, amount: 26, maxTargets: 3 },
  },
  chill: {
    /** Stacks 1..maxStacks slow; a trigger at maxStacks freezes. */
    maxStacks: 3,
    /** Movement and attack speed lost per stack (× STATUS_RESIST slow). */
    slowPerStack: 0.15,
    /** A trigger refreshes the stacks for `duration`; then one stack thaws every `stackDecay`. */
    duration: 4,
    stackDecay: 1.5,
  },
  frozen: {
    /** × STATUS_RESIST control. */
    duration: 2.6,
    /** No new freeze for this long after thawing (chill still stacks and slows). */
    immunity: 3,
    /** Chill stacks left after thawing. */
    thawStacks: 1,
    shatter: {
      /** A hit of at least this much applied damage (× healthScale) – or any blast/melee blow – shatters. */
      minHit: 35,
      heavyKinds: ['melee', 'explosion'] as const,
      /** Bonus damage: flat × healthScale + this fraction of the shattering hit. */
      damage: 60,
      hitFraction: 0.5,
      /** Burst drawn/sounded through combat:explosion (no damage by itself). */
      burstRadius: 1.4,
      vfx: 'explosion.ice',
      audio: 'explosion.ice.small',
    },
  },
  shocked: {
    /** Stun (no AI) × STATUS_RESIST control, then no new stun for `stunImmunity`. */
    stun: 0.6,
    stunImmunity: 1.6,
    /** Visible shock (sparks, twitch, arc pulses). */
    duration: 1.2,
    /** An arc pulse on the trigger and every `interval` while shocked. */
    arcs: { interval: 0.4, count: 2, range: 5, damage: 14, buildup: 28 },
  },
  poisoned: {
    maxStacks: 5,
    /** A new stack refreshes all of them. */
    duration: 6,
    /** Per stack, × healthScale. */
    dpsPerStack: 5,
    /** A body dying with at least `minStacks` leaves a poison cloud (FieldApi). */
    cloud: {
      minStacks: 2,
      field: field('damage', 'poison', 2.6, 4, 14, 0),
      /** Poison build-up per cloud damage point (spreads the poison). */
      statusBuildup: 3,
    },
  },
  voidMark: {
    duration: 6,
    /** Damage taken while marked (every source, before armor and resistances). */
    damageTaken: 1.25,
    /** Void build-up landing while marked charges the implosion; at `charge` it implodes. */
    implode: {
      charge: 160,
      /** Area damage × healthScale (AreaDamageSource.areaScale). */
      explosion: explosion('void', 3.2, 90, { small: true, minFalloff: 0.45, shake: 0.18 }),
    },
  },
  /** Crowd control never keeps a target down longer than this in one go (combo stuns included). */
  maxControl: 4,
  combos: {
    /** Per-target cooldown after a combo, and combos resolved per tick at most (the rest wait). */
    cooldown: 1.2,
    perTick: 4,
    /** Area damage falls off to this fraction at the radius. */
    minFalloff: 0.5,
  },
  /** Enemy rim light per status (priority: first active wins) – linear hex, strength 0..1. */
  rim: {
    priority: ['frozen', 'shocked', 'burn', 'voidMark', 'poisoned', 'chill'] as const satisfies readonly StatusId[],
    frozen: { color: 0x9fd8ff, strength: 1, pulse: 0.08, rate: 2 },
    shocked: { color: 0x7cc4ff, strength: 0.95, pulse: 0.55, rate: 31 },
    burn: { color: 0xff5010, strength: 0.9, pulse: 0.25, rate: 13 },
    voidMark: { color: 0x9040ff, strength: 0.85, pulse: 0.3, rate: 4.5 },
    poisoned: { color: 0x58ff28, strength: 0.45, pulse: 0.15, rate: 3, perStack: 0.08 },
    chill: { color: 0x68b4ff, strength: 0.3, pulse: 0.05, rate: 2, perStack: 0.14 },
  },
  /** Shocked enemies twitch: pose.stagger ≥ amplitude × |sin(rate · t)|. */
  twitch: { amplitude: 0.55, rate: 38 },
  /** Status particles (defs/vfx status.<id>) spawned on the body at a low rate. */
  vfx: {
    /** Seconds between spawns per target and status. */
    interval: {
      burn: 0.14,
      chill: 0.45,
      frozen: 0.35,
      shocked: 0.12,
      poisoned: 0.3,
      voidMark: 0.24,
    } satisfies Record<StatusId, number>,
    /** Spawns per tick over all targets (the rest wait for the next tick). */
    perTick: 4,
    /** Effect scale = bounds radius / this (clamped). */
    referenceRadius: 0.8,
    scale: [0.7, 1.8] as const,
    /** Points on the hitbox surface: this fraction of the hitbox radius out from its axis. */
    surface: 0.85,
  },
  /** Singularity pull on enemies (FieldApi.pullAt): knockback resistance counts this much. */
  pull: { resistanceWeight: 0.5 },
} as const;

// ---------------------------------------------------------------------------
// Combos
// ---------------------------------------------------------------------------

export type ComboId = 'thermoshock' | 'neurotoxin' | 'toxicblaze' | 'superconductor' | 'voidrupture';

export interface ComboDef {
  readonly id: ComboId;
  /** German name (HUD / stats). */
  readonly name: string;
  /**
   * The two reacting elements; 'any' = any other status (void amplifies everything). A status of
   * the first landing while one of the second is active reacts, and vice versa.
   */
  readonly elements: readonly [StatusElement, StatusElement | 'any'];
  /** Statuses removed by the reaction. */
  readonly consume: readonly StatusId[];
  /** Instant damage to the target (× healthScale) of `element`. */
  readonly damage: number;
  readonly element: DamageElement;
  /** Extra target damage per poison stack consumed (toxicblaze). */
  readonly perPoisonStack?: number;
  /** Target damage × this when it was frozen (thermoshock). */
  readonly frozenBonus?: number;
  /** Target damage × (1 + this × other active statuses) (voidrupture). */
  readonly perOtherStatus?: number;
  /** Area damage around the target (× healthScale, linear falloff, line of sight). */
  readonly area: { readonly radius: number; readonly damage: number } | null;
  /** Target stunned (× STATUS_RESIST control). */
  readonly stun: number;
  /** Build-up handed to neighbours. */
  readonly spread: {
    readonly element: StatusElement;
    readonly amount: number;
    readonly radius: number;
    readonly maxTargets: number;
  } | null;
  /** Arcs to the nearest enemies: damage (× healthScale) and build-up of `element` each. */
  readonly arcs: {
    readonly count: number;
    readonly range: number;
    readonly damage: number;
    readonly element: StatusElement;
    readonly buildup: number;
  } | null;
  /** The other statuses are refreshed and their damage over time multiplied for `duration`. */
  readonly amplify: { readonly dot: number; readonly duration: number } | null;
  /** VFX preset (combo.<id>), its scale, and the audio id (combo.<id>, played from combat:combo). */
  readonly vfx: string;
  readonly vfxScale: number;
}

/** Evaluation order: the element pairs first, voidrupture (void + any) last. */
export const COMBOS: readonly ComboDef[] = [
  {
    id: 'thermoshock',
    name: 'Thermoschock',
    elements: ['fire', 'ice'],
    consume: ['burn', 'chill', 'frozen'],
    damage: 70,
    element: 'fire',
    frozenBonus: 1.8,
    area: { radius: 2.6, damage: 35 },
    stun: 0,
    spread: null,
    arcs: null,
    amplify: null,
    vfx: 'combo.thermoshock',
    vfxScale: 1,
  },
  {
    id: 'neurotoxin',
    name: 'Nervengift',
    elements: ['shock', 'poison'],
    consume: ['shocked'],
    damage: 30,
    element: 'poison',
    area: null,
    stun: 2.2,
    spread: { element: 'poison', amount: 75, radius: 3.5, maxTargets: 4 },
    arcs: null,
    amplify: null,
    vfx: 'combo.neurotoxin',
    vfxScale: 1,
  },
  {
    id: 'toxicblaze',
    name: 'Giftbrand',
    elements: ['fire', 'poison'],
    consume: ['poisoned'],
    damage: 40,
    element: 'fire',
    perPoisonStack: 16,
    area: { radius: 3.4, damage: 45 },
    stun: 0,
    spread: { element: 'fire', amount: 60, radius: 3.4, maxTargets: 4 },
    arcs: null,
    amplify: null,
    vfx: 'combo.toxicblaze',
    vfxScale: 1.1,
  },
  {
    id: 'superconductor',
    name: 'Supraleiter',
    elements: ['ice', 'shock'],
    consume: ['shocked', 'chill'],
    damage: 50,
    element: 'shock',
    area: null,
    stun: 1,
    spread: null,
    arcs: { count: 4, range: 8, damage: 40, element: 'ice', buildup: 45 },
    amplify: null,
    vfx: 'combo.superconductor',
    vfxScale: 1,
  },
  {
    id: 'voidrupture',
    name: 'Void-Riss',
    elements: ['void', 'any'],
    consume: ['voidMark'],
    damage: 45,
    element: 'void',
    perOtherStatus: 0.6,
    area: { radius: 2.4, damage: 30 },
    stun: 0,
    spread: null,
    arcs: null,
    amplify: { dot: 1.75, duration: 5 },
    vfx: 'combo.voidrupture',
    vfxScale: 1,
  },
];

export function getComboDef(id: string): ComboDef | undefined {
  return COMBOS.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// Status resistances per enemy kind
// ---------------------------------------------------------------------------

export interface StatusResistDef {
  /** Build-up multiplier per element (absent = 1, 0 = immune). */
  readonly buildup: Readonly<Partial<Record<StatusElement, number>>>;
  /** Freeze / stun durations multiplier. */
  readonly control: number;
  /** Chill slow multiplier. */
  readonly slow: number;
  /** Can be frozen (false: chill stops at max stacks). */
  readonly freeze: boolean;
}

export const STATUS_RESIST = {
  default: { buildup: {}, control: 1, slow: 1, freeze: true } as StatusResistDef,
  /** Every boss (M6 EnemyTypeDef.boss) – heavy resistance, never frozen solid. */
  boss: {
    buildup: { fire: 0.4, ice: 0.3, shock: 0.3, poison: 0.4, void: 0.5 },
    control: 0.25,
    slow: 0.4,
    freeze: false,
  } as StatusResistDef,
  /** Per enemy type id (defs/enemies). */
  byType: {
    // The acid spitter shrugs off toxins.
    spitter: { buildup: { poison: 0.4 }, control: 1, slow: 1, freeze: true },
    // Heavy armor: slow to chill and shock, shorter freezes and stuns.
    tank: { buildup: { ice: 0.6, shock: 0.6 }, control: 0.5, slow: 0.6, freeze: true },
  } as Readonly<Record<string, StatusResistDef>>,
} as const;

/** Status resistances of an enemy kind (bosses share one profile). */
export function statusResistFor(type: string | null | undefined, boss = false): StatusResistDef {
  if (boss) return STATUS_RESIST.boss;
  if (type && Object.hasOwn(STATUS_RESIST.byType, type)) return STATUS_RESIST.byType[type]!;
  return STATUS_RESIST.default;
}

// ---------------------------------------------------------------------------
// Element modules (sold at the Werkbank, package E2)
// ---------------------------------------------------------------------------

export interface ElementModDef {
  /** Item id ('element.<element>'). */
  readonly id: string;
  readonly element: StatusElement;
  /** The status it builds. */
  readonly status: StatusId;
  /** Player-facing (German). */
  readonly name: string;
  readonly short: string;
  readonly description: string;
  readonly cost: number;
  /** Linear hex (3D accents, VFX) and sRGB CSS color (UI). */
  readonly color: number;
  readonly css: string;
  /** Stroke-only SVG path data (24×24). */
  readonly glyph: string;
  /** Audio id of the install (convention). */
  readonly audio: string;
}

export const ELEMENT_MODS: readonly ElementModDef[] = [
  {
    id: 'element.fire',
    element: 'fire',
    status: 'burn',
    name: 'Element-Modul: Feuer',
    short: 'Feuer',
    description:
      'Treffer setzen Gegner in Brand: Schaden über Zeit, der auf Nachbarn übergreift. Mit Eis: Thermoschock, mit Gift: Giftbrand.',
    cost: 2500,
    color: 0xff5a14,
    css: '#ff7a2e',
    glyph:
      'M12 21.5C8.4 21.5 6 19 6 15.6 6 12.5 8 10.5 9.5 8.5 10 10.5 11 11.5 12.5 12 11.5 9 12.5 5.5 15.5 2.5 15 6 16.5 8.5 17.5 10.5 18.5 12.5 18 14 18 15.6 18 19 15.6 21.5 12 21.5Z',
    audio: 'element.install',
  },
  {
    id: 'element.ice',
    element: 'ice',
    status: 'chill',
    name: 'Element-Modul: Eis',
    short: 'Eis',
    description:
      'Treffer unterkühlen und verlangsamen Gegner – genug Kälte friert sie ein, schwere Treffer zerschmettern sie. Mit Elektro: Supraleiter.',
    cost: 2500,
    color: 0x7cc8ff,
    css: '#8fd4ff',
    glyph: 'M12 2.5V21.5 M3.8 7.25 20.2 16.75 M3.8 16.75 20.2 7.25 M9.5 3.5 12 6 14.5 3.5 M9.5 20.5 12 18 14.5 20.5',
    audio: 'element.install',
  },
  {
    id: 'element.shock',
    element: 'shock',
    status: 'shocked',
    name: 'Element-Modul: Elektro',
    short: 'Elektro',
    description:
      'Treffer schocken Gegner: kurze Lähmung, Blitzbögen springen auf Gegner in der Nähe über. Mit Gift: Nervengift.',
    cost: 2500,
    color: 0x80c0ff,
    css: '#9cc8ff',
    glyph: 'M13.5 2.5 5.5 13.5H11.5L10.5 21.5 18.5 10.5H12.5Z',
    audio: 'element.install',
  },
  {
    id: 'element.poison',
    element: 'poison',
    status: 'poisoned',
    name: 'Element-Modul: Gift',
    short: 'Gift',
    description:
      'Treffer vergiften Gegner (bis zu 5 Stapel). Stark Vergiftete hinterlassen beim Tod eine Giftwolke.',
    cost: 2500,
    color: 0x58ff28,
    css: '#7dff4a',
    glyph: 'M12 3C12 3 5.5 10.5 5.5 14.5A6.5 6.5 0 0 0 18.5 14.5C18.5 10.5 12 3 12 3Z M9.2 15A2.8 2.8 0 0 0 12 17.8',
    audio: 'element.install',
  },
  {
    id: 'element.void',
    element: 'void',
    status: 'voidMark',
    name: 'Element-Modul: Void',
    short: 'Void',
    description:
      'Treffer zeichnen Gegner mit dem Void-Mal: Sie erleiden mehr Schaden und implodieren unter weiterer Void-Energie. Reißt jeden anderen Status auf (Void-Riss).',
    cost: 3500,
    color: 0x9040ff,
    css: '#b07bff',
    glyph: 'M12 3.5A8.5 8.5 0 1 1 3.5 12 M12 7.5A4.5 4.5 0 1 0 16.5 12 M12 11V13',
    audio: 'element.install',
  },
];

export function getElementMod(idOrElement: string): ElementModDef | undefined {
  return ELEMENT_MODS.find((m) => m.id === idOrElement || m.element === idOrElement);
}

/** Element modules a weapon can take: none for wonder weapons, never its own base element. */
export function elementModsFor(def: Pick<WeaponDef, 'category' | 'damage'>): readonly ElementModDef[] {
  if (def.category === 'wonder') return [];
  return ELEMENT_MODS.filter((m) => m.element !== def.damage.element);
}

/** Build-up array index of an element (-1 for 'physical'). */
export function statusElementIndex(element: DamageElement): number {
  return element === 'physical' ? -1 : STATUS_ELEMENTS.indexOf(element);
}
