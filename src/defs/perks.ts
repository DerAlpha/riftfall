/**
 * Perks (M4): the station's "Rift implants", bought at perk machines. Each perk is data – price,
 * neon colour, glyph, stat modifiers (defs/stats.ts ids) – plus an optional special hook
 * (src/economy/perkHooks.ts) tuned in PERK_TUNING. PerkSystem applies the modifiers under the
 * source `perk:<id>` and removes them exactly on revoke. The number of perks is limited by the
 * perkSlots stat (4).
 *
 * Revive rule: a perk with `lostOnRevive` (Phoenix-Protokoll) is consumed when its revive charge
 * saves the player; every other perk is kept (CoD solo Quick Revive keeps the rest of the build).
 *
 * Colours are sRGB hex (CSS `#rrggbb`; three.js: `color.setHex(hex, SRGBColorSpace)` then multiply
 * for HDR emissive). Glyphs (PERK_GLYPHS) are stroke-only SVG path data in a 24×24 box – neon tubes:
 * draw with `stroke-width` ≈ 2, round caps and joins, no fill (DOM `<path d>` or canvas `Path2D`).
 */
import type { DamageElement } from '../core/events';
import type { StatKey } from './stats';

export type PerkHookId = 'nova' | 'scavenger' | 'kinetic' | 'adrenaline' | 'phoenix';

export interface PerkStatModDef {
  readonly stat: StatKey;
  readonly op: 'add' | 'mul';
  readonly value: number;
}

export interface PerkDef {
  readonly id: string;
  /** Player-facing name (German). */
  readonly name: string;
  /** Machine slogan / HUD subtitle (German). */
  readonly tagline: string;
  /** Effect description (German). */
  readonly description: string;
  readonly price: number;
  /** Neon colour, sRGB hex. */
  readonly color: number;
  /** PERK_GLYPHS id. */
  readonly icon: PerkGlyphId;
  readonly modifiers: readonly PerkStatModDef[];
  /** Special behaviour beyond stats (perkHooks.ts), null = stats only. */
  readonly hook: PerkHookId | null;
  /** Consumed when its revive charge saves the player. */
  readonly lostOnRevive: boolean;
}

export const PERK_GLYPHS = {
  shield: 'M12 2.5 20 5.5V11.5C20 16.5 16.6 20 12 21.5 7.4 20 4 16.5 4 11.5V5.5Z M12 7V17 M8 11H16',
  reload: 'M18.5 12A6.5 6.5 0 1 1 16.6 7.4 M17 3.5V7.9H12.6 M12.5 9 10.5 12.5H13.5L11.5 16',
  double: 'M4 6.5 9.5 12 4 17.5 M11 6.5 16.5 12 11 17.5 M18.5 6V18',
  phoenix:
    'M12 21.5C8 21.5 5.5 18.5 5.5 15 5.5 12 7.5 10 9 8 9.5 10 10.5 11 12 11.5 11 8.5 12 5 15 3 14.5 6 16 8 17.5 10 19 12 19.5 13.5 19.5 15 19.5 18.5 16.5 21.5 12 21.5Z M12 21.5C10.5 20 10.5 17.5 12 15.5 13.5 17.5 13.5 20 12 21.5',
  runner: 'M2.5 8H8 M1.5 12H9 M2.5 16H8 M12 5.5 18.5 12 12 18.5 M16 5.5 22.5 12 16 18.5',
  crosshair: 'M12 2.5V8 M12 16V21.5 M2.5 12H8 M16 12H21.5 M8 12A4 4 0 1 0 16 12 4 4 0 1 0 8 12 M12 11.5V12.5',
  dash: 'M2.5 12H13 M9.5 8 13.5 12 9.5 16 M17 3.5C19.5 7 19.5 17 17 20.5 M20.5 6C21.8 9 21.8 15 20.5 18',
  holster: 'M3 7H16.5L20.5 9.5 M3 12H16.5L20.5 14.5 M3 17H16.5L20.5 19.5 M6 7V9 M6 12V14 M6 17V19',
  nova: 'M13 2.5 7 13H11.5L10.5 21.5 17 10.5H12.5Z M3.5 12A8.5 8.5 0 0 1 6.5 5.5 M20.5 12A8.5 8.5 0 0 1 17.5 18.5',
  vulture: 'M2 6.5 8 10.5 12 7.5 16 10.5 22 6.5 M8 10.5 12 19 16 10.5 M12 7.5V12',
  impact: 'M12 2.5V12 M8 8.5 12 12.5 16 8.5 M3 17C6.5 15 17.5 15 21 17 M6 20.5C8.5 19.5 15.5 19.5 18 20.5',
  heartbeat: 'M2 12.5H6.5L8.5 7 12.5 18 15.5 9.5 17.5 12.5H22',
  ammo: 'M6.5 20V10.5C6.5 8 7.5 6 8.5 5 9.5 6 10.5 8 10.5 10.5V20Z M13.5 20V10.5C13.5 8 14.5 6 15.5 5 16.5 6 17.5 8 17.5 10.5V20Z M4 20H20 M6.5 13H10.5 M13.5 13H17.5',
  hex: 'M12 2 20.7 7V17L12 22 3.3 17V7Z M12 7 16.3 9.5V14.5L12 17 7.7 14.5V9.5Z',
  orbit:
    'M9.5 12A2.5 2.5 0 1 0 14.5 12 2.5 2.5 0 1 0 9.5 12 M2.5 12A9.5 4 0 1 0 21.5 12 9.5 4 0 1 0 2.5 12 M18.5 5.5 19.5 4.5',
  burst: 'M12 2.5 14 9 20.5 7 16.5 12 20.5 17 14 15 12 21.5 10 15 3.5 17 7.5 12 3.5 7 10 9Z',
} as const satisfies Record<string, string>;

export type PerkGlyphId = keyof typeof PERK_GLYPHS;

export const PERKS = {
  titan: {
    id: 'titan',
    name: 'Titanplatte',
    tagline: 'Panzerung unter der Haut.',
    description: '+80 % maximale Gesundheit.',
    price: 2500,
    color: 0xff2d3a,
    icon: 'shield',
    modifiers: [{ stat: 'maxHealth', op: 'mul', value: 1.8 }],
    hook: null,
    lostOnRevive: false,
  },
  quickload: {
    id: 'quickload',
    name: 'Schnellladung',
    tagline: 'Magazinwechsel im Takt des Rifts.',
    description: 'Nachladen 50 % schneller.',
    price: 3000,
    color: 0x2eff7a,
    icon: 'reload',
    modifiers: [{ stat: 'reloadSpeed', op: 'mul', value: 1.5 }],
    hook: null,
    lostOnRevive: false,
  },
  doubleimpulse: {
    id: 'doubleimpulse',
    name: 'Doppelimpuls',
    tagline: 'Jeder Abzug zählt doppelt.',
    description: '+33 % Feuerrate und +25 % Waffenschaden.',
    price: 2000,
    color: 0xffd81f,
    icon: 'double',
    modifiers: [
      { stat: 'fireRate', op: 'mul', value: 1.33 },
      { stat: 'damage', op: 'mul', value: 1.25 },
    ],
    hook: null,
    lostOnRevive: false,
  },
  phoenix: {
    id: 'phoenix',
    name: 'Phoenix-Protokoll',
    tagline: 'Aus der Asche. Einmal.',
    description:
      'Tödlicher Schaden belebt dich einmal wieder – mit einer Feuerwelle, die Gegner zurückwirft (Implantat wird verbraucht). Regeneration setzt früher ein und ist 50 % schneller.',
    price: 1500,
    color: 0xff6a1f,
    icon: 'phoenix',
    modifiers: [
      { stat: 'reviveCharges', op: 'add', value: 1 },
      { stat: 'regenDelay', op: 'mul', value: 0.6 },
      { stat: 'regenRate', op: 'mul', value: 1.5 },
    ],
    hook: 'phoenix',
    lostOnRevive: true,
  },
  sprinter: {
    id: 'sprinter',
    name: 'Sprinterkern',
    tagline: 'Die Station ist groß. Du bist schneller.',
    description: '+8 % Laufgeschwindigkeit, +15 % Sprintgeschwindigkeit.',
    price: 2000,
    color: 0xe8ff2e,
    icon: 'runner',
    modifiers: [
      { stat: 'moveSpeed', op: 'mul', value: 1.08 },
      { stat: 'sprintSpeed', op: 'mul', value: 1.15 },
    ],
    hook: null,
    lostOnRevive: false,
  },
  precision: {
    id: 'precision',
    name: 'Präzisionsmodul',
    tagline: 'Zielerfassung direkt im Sehnerv.',
    description: '+35 % Kopf- und Schwachpunktschaden, −35 % Streuung, −30 % Rückstoß, schnelleres Zielen.',
    price: 1500,
    color: 0xa65cff,
    icon: 'crosshair',
    modifiers: [
      { stat: 'headshotMultiplier', op: 'mul', value: 1.35 },
      { stat: 'spread', op: 'mul', value: 0.65 },
      { stat: 'recoil', op: 'mul', value: 0.7 },
      { stat: 'adsSpeed', op: 'mul', value: 1.2 },
    ],
    hook: null,
    lostOnRevive: false,
  },
  riftwalker: {
    id: 'riftwalker',
    name: 'Riftläufer',
    tagline: 'Zwischen den Rissen gibt es Abkürzungen.',
    description: '+1 Dash-Ladung, Dashes laden 50 % schneller auf.',
    price: 2500,
    color: 0x6a4dff,
    icon: 'dash',
    modifiers: [
      { stat: 'dashCharges', op: 'add', value: 1 },
      { stat: 'dashRecharge', op: 'mul', value: 1.5 },
    ],
    hook: null,
    lostOnRevive: false,
  },
  holster: {
    id: 'holster',
    name: 'Dreifachhalfter',
    tagline: 'Zwei Waffen sind eine zu wenig.',
    description: '+1 Waffenplatz. Geht das Implantat verloren, auch die dritte Waffe.',
    price: 4000,
    color: 0x21ffc4,
    icon: 'holster',
    modifiers: [{ stat: 'weaponSlots', op: 'add', value: 1 }],
    hook: null,
    lostOnRevive: false,
  },
  nova: {
    id: 'nova',
    name: 'Nova-Schock',
    tagline: 'Leeres Magazin, volle Ladung.',
    description: 'Nachladen entlädt einen Schockimpuls um dich – je leerer das Magazin, desto stärker.',
    price: 2000,
    color: 0x3d8bff,
    icon: 'nova',
    modifiers: [],
    hook: 'nova',
    lostOnRevive: false,
  },
  scavenger: {
    id: 'scavenger',
    name: 'Aasgeier',
    tagline: 'Was sie fallen lassen, gehört dir.',
    description: 'Getötete Gegner hinterlassen manchmal Munition. +15 % Drop-Chance.',
    price: 3000,
    color: 0x8cff2e,
    icon: 'vulture',
    modifiers: [{ stat: 'dropChance', op: 'mul', value: 1.15 }],
    hook: 'scavenger',
    lostOnRevive: false,
  },
  kinetic: {
    id: 'kinetic',
    name: 'Kinetikpanzer',
    tagline: 'Die Schwerkraft arbeitet für dich.',
    description:
      'Immun gegen Explosions- und Fallschaden. Harte Landungen aus der Höhe lösen eine Schockwelle aus.',
    price: 2000,
    color: 0xffa21a,
    icon: 'impact',
    modifiers: [
      { stat: 'explosionDamageTaken', op: 'mul', value: 0 },
      { stat: 'fallDamageTaken', op: 'mul', value: 0 },
    ],
    hook: 'kinetic',
    lostOnRevive: false,
  },
  adrenaline: {
    id: 'adrenaline',
    name: 'Adrenalinschub',
    tagline: 'Jeder Kill treibt dich an.',
    description: 'Kills geben kurz +6 % Laufgeschwindigkeit, bis zu fünffach stapelbar.',
    price: 2500,
    color: 0xff3fa4,
    icon: 'heartbeat',
    modifiers: [],
    hook: 'adrenaline',
    lostOnRevive: false,
  },
  recycler: {
    id: 'recycler',
    name: 'Munitionsrecycler',
    tagline: 'Hülsen rein, Patronen raus.',
    description: '+30 % Magazingröße, +50 % Reservemunition.',
    price: 2500,
    color: 0xe04dff,
    icon: 'ammo',
    modifiers: [
      { stat: 'magazineSize', op: 'mul', value: 1.3 },
      { stat: 'reserveAmmo', op: 'mul', value: 1.5 },
    ],
    hook: null,
    lostOnRevive: false,
  },
  bulwark: {
    id: 'bulwark',
    name: 'Bollwerk-Matrix',
    tagline: 'Ein Kraftfeld, eng wie eine zweite Haut.',
    description: '−15 % erlittener Schaden, +50 % maximale Panzerung.',
    price: 3000,
    color: 0x8fa8d6,
    icon: 'hex',
    modifiers: [
      { stat: 'damageTaken', op: 'mul', value: 0.85 },
      { stat: 'maxArmor', op: 'mul', value: 1.5 },
    ],
    hook: null,
    lostOnRevive: false,
  },
  resonance: {
    id: 'resonance',
    name: 'Resonanzfeld',
    tagline: 'Der Rift schuldet dir etwas.',
    description: 'Power-ups halten 50 % länger, +25 % Drop-Chance.',
    price: 2000,
    color: 0x2ee6ff,
    icon: 'orbit',
    modifiers: [
      { stat: 'powerUpDuration', op: 'mul', value: 1.5 },
      { stat: 'dropChance', op: 'mul', value: 1.25 },
    ],
    hook: null,
    lostOnRevive: false,
  },
  impactcore: {
    id: 'impactcore',
    name: 'Schlagkern',
    tagline: 'Wenn die Munition ausgeht, bleibt die Faust.',
    description: 'Nahkampfangriffe verursachen 150 % mehr Schaden.',
    price: 1500,
    color: 0xf2f4ff,
    icon: 'burst',
    modifiers: [{ stat: 'meleeDamage', op: 'mul', value: 2.5 }],
    hook: null,
    lostOnRevive: false,
  },
} as const satisfies Record<string, PerkDef>;

export type PerkId = keyof typeof PERKS;

/** Perk ids in table order (machines, dev console `perk list`). */
export const PERK_IDS = Object.keys(PERKS) as PerkId[];

/** Stat modifier source of a perk (StatsApi.removeSource drops exactly its modifiers). */
export function perkSource(perkId: string): string {
  return `perk:${perkId}`;
}

export function getPerkDef(id: string): PerkDef | undefined {
  return Object.prototype.hasOwnProperty.call(PERKS, id) ? (PERKS as Record<string, PerkDef>)[id] : undefined;
}

export function isPerkId(id: string): id is PerkId {
  return getPerkDef(id) !== undefined;
}

/** CSS colour of a perk (`#rrggbb`). */
export function perkCssColor(def: Pick<PerkDef, 'color'>): string {
  return `#${def.color.toString(16).padStart(6, '0')}`;
}

export interface RangeDef {
  readonly min: number;
  readonly max: number;
}

/**
 * Look and sound of a perk blast (perkHooks createPerkBlastFx, wired by Game): its own VFX presets
 * instead of the frag explosion, whose smoke, scorch, large billboards and full-strength shake would
 * bury the first-person camera at the player's feet on every reload. The center effect (flash
 * light, shake, sparks hopping along the floor) sits straight below the camera, out of view, so the
 * visible part is a ring of small bursts around the player; plus an optional screen shockwave and
 * a positional sound.
 */
export interface PerkBlastFxDef {
  /** Center VFX preset id (defs/vfx.ts VFX_EFFECTS); effect scale = blast radius ÷ referenceRadius. */
  readonly effect: string;
  readonly referenceRadius: number;
  /** Burst preset spawned `ringCount` times on a circle of `ringRadius` × blast radius (null = none). */
  readonly ring: string | null;
  readonly ringCount: number;
  readonly ringRadius: number;
  /** Screen-space shockwave strength (0 = none); world radius = blast radius × shockwaveRadius. */
  readonly shockwave: number;
  readonly shockwaveRadius: number;
  /** Positional sound id (null = silent), its volume and playback rate. */
  readonly sound: string | null;
  readonly volume: number;
  readonly pitch: number;
  readonly pitchVariance: number;
}

/** Area damage of a perk hook: full damage within innerFraction × radius, linear to minFalloff at the edge. */
export interface PerkBlastDef {
  /** DamageInfo.weaponId of the blast (combat:damage consumers; not a weapon def). */
  readonly weaponId: string;
  readonly element: DamageElement;
  /** Element of the fallback VFX (combat:explosion tint when no blast FX is wired: tests, tools). */
  readonly fxElement: DamageElement;
  readonly fx: PerkBlastFxDef;
  readonly radius: RangeDef;
  readonly damage: RangeDef;
  readonly innerFraction: number;
  readonly minFalloff: number;
  /** Knockback (m/s) at full strength. */
  readonly impulse: number;
  /** Damage center height above the player's feet (m). */
  readonly centerHeight: number;
  /**
   * VFX anchor height above the feet (m): low, so the shock ring and flash spread over the floor in
   * view instead of engulfing the first-person camera.
   */
  readonly fxHeight: number;
  readonly cooldown: number;
}

/** Special-hook tuning (perkHooks.ts). */
export const PERK_TUNING = {
  /** Nova-Schock: reload → shock blast; strength by the magazine's missing fraction (0..1). */
  nova: {
    weaponId: 'perk.nova',
    element: 'shock',
    fxElement: 'shock',
    radius: { min: 2.5, max: 5.5 },
    damage: { min: 25, max: 150 },
    innerFraction: 0.35,
    minFalloff: 0.45,
    impulse: 5,
    centerHeight: 1,
    fxHeight: 0.15,
    cooldown: 1.5,
    fx: {
      effect: 'perk.nova',
      referenceRadius: 4,
      ring: 'perk.nova.arc',
      ringCount: 10,
      ringRadius: 0.5,
      shockwave: 0.35,
      shockwaveRadius: 1.2,
      sound: 'explosion',
      volume: 0.4,
      pitch: 1.7,
      pitchVariance: 0.08,
    },
  } satisfies PerkBlastDef,
  /** Kinetikpanzer: landing shock wave; strength by impact speed between the two thresholds. */
  kinetic: {
    weaponId: 'perk.kinetic',
    element: 'physical',
    fxElement: 'physical',
    radius: { min: 3, max: 6 },
    damage: { min: 80, max: 250 },
    innerFraction: 0.3,
    minFalloff: 0.35,
    impulse: 9,
    centerHeight: 0.4,
    fxHeight: 0.1,
    cooldown: 1,
    fx: {
      effect: 'perk.kinetic',
      referenceRadius: 4.5,
      ring: 'perk.kinetic.dust',
      ringCount: 8,
      ringRadius: 0.45,
      shockwave: 0.6,
      shockwaveRadius: 1.3,
      sound: 'enemy.tank.slam',
      volume: 0.9,
      pitch: 1.1,
      pitchVariance: 0.06,
    },
    /** m/s downward: MOVEMENT.landing.heavyImpactSpeed (a double-jump landing) and full strength. */
    minImpactSpeed: 12,
    fullImpactSpeed: 24,
  } satisfies PerkBlastDef & { readonly minImpactSpeed: number; readonly fullImpactSpeed: number },
  /**
   * Phoenix-Protokoll: the revive it pays for bursts out of the player (full strength, fire): the
   * swarm around the body is burnt and thrown back, so the 3 s of invulnerability buy room instead
   * of dying again inside the same crowd. Fired on the perk tick after the revive.
   */
  phoenix: {
    weaponId: 'perk.phoenix',
    element: 'fire',
    fxElement: 'fire',
    radius: { min: 4.5, max: 4.5 },
    damage: { min: 90, max: 90 },
    innerFraction: 0.4,
    minFalloff: 0.35,
    impulse: 12,
    centerHeight: 1,
    fxHeight: 0.15,
    cooldown: 0,
    fx: {
      effect: 'perk.phoenix',
      referenceRadius: 4.5,
      ring: 'perk.phoenix.flare',
      ringCount: 10,
      ringRadius: 0.5,
      shockwave: 0.7,
      shockwaveRadius: 1.3,
      sound: 'explosion',
      volume: 0.75,
      pitch: 0.85,
      pitchVariance: 0.05,
    },
  } satisfies PerkBlastDef,
  /** Aasgeier: chance per player kill (× dropChance stat) to drop a small ammo pickup. */
  scavenger: {
    chance: 0.1,
    cooldown: 1.5,
  },
  /** Adrenalinschub: moveSpeed × (1 + perStack × stacks); stacks fall off one per `decayInterval` after `duration`. */
  adrenaline: {
    perStack: 0.06,
    maxStacks: 5,
    duration: 4,
    decayInterval: 0.6,
  },
} as const;
