/**
 * Cosmetics (M9 data; the visuals arrive with the M11 screens / a viewmodel camo package):
 * weapon camos (incl. ANIMATED endgame camos with shader parameters), charms, crosshair styles,
 * kill effects and emblems, each with an unlock source.
 *
 * Camos:
 * - scope 'weapon': unlocked per weapon (weapon level, weapon counters like "50 Kopfschuss-Kills",
 *   mastery = other camos of the same weapon). scope 'global': unlocked once for every weapon
 *   (mastered weapons, prestige, achievements).
 * - `shader` is the contract for the viewmodel camo shader (later package): a procedural
 *   `pattern` in weapon-UV space × `scale`, three sRGB palette colours (base, mid, accent),
 *   PBR roughness/metalness, optional emissive accent (linear intensity) and an `animation`
 *   (kind, speed in cycles/s, intensity 0..1). 'none' camos are static.
 * Other cosmetics: unlock kinds 'default' (always owned), 'level', 'prestige', 'achievement',
 * 'challenge' (weekly challenge reward pool), 'shop' (Rift-Splitter price).
 * Kill effects name VFX presets (defs/vfx VFX_EFFECTS ids, tests check them).
 * German names.
 */
import type { UnlockKind } from '../core/events';
import type { WeaponCounterId } from './progression';

export type CosmeticRarity = 'common' | 'rare' | 'epic' | 'legendary' | 'mythic';

export type CamoPattern =
  | 'solid'
  | 'urban'
  | 'digital'
  | 'tiger'
  | 'hex'
  | 'carbon'
  | 'circuit'
  | 'marble'
  | 'metal'
  | 'flow'
  | 'nebula'
  | 'rift';

export type CamoAnimationKind = 'none' | 'scroll' | 'pulse' | 'shimmer' | 'flow' | 'rift';

export interface CamoShaderDef {
  readonly pattern: CamoPattern;
  /** sRGB hex: base, mid, accent. */
  readonly colors: readonly [number, number, number];
  /** Pattern repeats per weapon-UV unit. */
  readonly scale: number;
  readonly roughness: number;
  readonly metalness: number;
  /** Emissive accent (linear intensity); absent = none. */
  readonly emissive?: { readonly color: number; readonly intensity: number };
  readonly animation: {
    readonly kind: CamoAnimationKind;
    readonly speed: number;
    readonly intensity: number;
  };
}

export type CamoUnlock =
  /** Weapon reaches this weapon level. */
  | { readonly kind: 'weaponLevel'; readonly level: number }
  /** A weapon counter (kills, headshots, …) reaches `target` with that weapon. */
  | { readonly kind: 'weaponCounter'; readonly counter: WeaponCounterId; readonly target: number }
  /** Every listed camo unlocked on the same weapon (and the weapon at `level`). */
  | { readonly kind: 'weaponMastery'; readonly requires: readonly string[]; readonly level: number }
  /** Global: `count` weapons have camo `camo`. */
  | { readonly kind: 'weaponsMastered'; readonly camo: string; readonly count: number }
  | { readonly kind: 'prestige'; readonly rank: number }
  | { readonly kind: 'achievement'; readonly id: string };

export interface CamoDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly rarity: CosmeticRarity;
  readonly scope: 'weapon' | 'global';
  readonly unlock: CamoUnlock;
  readonly shader: CamoShaderDef;
}

const STATIC = { kind: 'none', speed: 0, intensity: 0 } as const;

export const CAMOS: readonly CamoDef[] = [
  // --- weapon level camos ---
  {
    id: 'camo.urban',
    name: 'Stadtgrau',
    description: 'Waffenstufe 4.',
    rarity: 'common',
    scope: 'weapon',
    unlock: { kind: 'weaponLevel', level: 4 },
    shader: {
      pattern: 'urban',
      colors: [0x3a3d42, 0x6b7078, 0xa9aeb5],
      scale: 3,
      roughness: 0.7,
      metalness: 0.2,
      animation: STATIC,
    },
  },
  {
    id: 'camo.digital',
    name: 'Digitalmuster',
    description: 'Waffenstufe 8.',
    rarity: 'common',
    scope: 'weapon',
    unlock: { kind: 'weaponLevel', level: 8 },
    shader: {
      pattern: 'digital',
      colors: [0x2b3226, 0x4d5a3c, 0x8a9468],
      scale: 6,
      roughness: 0.65,
      metalness: 0.2,
      animation: STATIC,
    },
  },
  {
    id: 'camo.tiger',
    name: 'Tigerstreifen',
    description: 'Waffenstufe 12.',
    rarity: 'rare',
    scope: 'weapon',
    unlock: { kind: 'weaponLevel', level: 12 },
    shader: {
      pattern: 'tiger',
      colors: [0x1c1a17, 0x9c5a1e, 0xd8a24a],
      scale: 2.5,
      roughness: 0.6,
      metalness: 0.15,
      animation: STATIC,
    },
  },
  {
    id: 'camo.hex',
    name: 'Wabenpanzer',
    description: 'Waffenstufe 16.',
    rarity: 'rare',
    scope: 'weapon',
    unlock: { kind: 'weaponLevel', level: 16 },
    shader: {
      pattern: 'hex',
      colors: [0x14181f, 0x2d3a4a, 0x5fa8d8],
      scale: 8,
      roughness: 0.45,
      metalness: 0.6,
      animation: STATIC,
    },
  },
  {
    id: 'camo.carbon',
    name: 'Kohlefaser',
    description: 'Waffenstufe 20.',
    rarity: 'rare',
    scope: 'weapon',
    unlock: { kind: 'weaponLevel', level: 20 },
    shader: {
      pattern: 'carbon',
      colors: [0x0d0e10, 0x24272c, 0x3c4048],
      scale: 14,
      roughness: 0.35,
      metalness: 0.3,
      animation: STATIC,
    },
  },
  {
    id: 'camo.circuit',
    name: 'Schaltkreis',
    description: 'Waffenstufe 25.',
    rarity: 'epic',
    scope: 'weapon',
    unlock: { kind: 'weaponLevel', level: 25 },
    shader: {
      pattern: 'circuit',
      colors: [0x0b1418, 0x163038, 0x3ff2ff],
      scale: 5,
      roughness: 0.4,
      metalness: 0.5,
      emissive: { color: 0x3ff2ff, intensity: 1.2 },
      animation: { kind: 'pulse', speed: 0.4, intensity: 0.35 },
    },
  },
  // --- weapon challenge camos ---
  {
    id: 'camo.bronze',
    name: 'Bronze',
    description: '150 Kills mit dieser Waffe.',
    rarity: 'rare',
    scope: 'weapon',
    unlock: { kind: 'weaponCounter', counter: 'kills', target: 150 },
    shader: {
      pattern: 'metal',
      colors: [0x5a3a1c, 0x9c6b3a, 0xd9a066],
      scale: 1,
      roughness: 0.3,
      metalness: 1,
      animation: STATIC,
    },
  },
  {
    id: 'camo.gold',
    name: 'Gold',
    description: '50 Kopfschuss-Kills mit dieser Waffe.',
    rarity: 'epic',
    scope: 'weapon',
    unlock: { kind: 'weaponCounter', counter: 'headshots', target: 50 },
    shader: {
      pattern: 'metal',
      colors: [0x7a5a12, 0xd4a82c, 0xffe28a],
      scale: 1,
      roughness: 0.2,
      metalness: 1,
      animation: STATIC,
    },
  },
  {
    id: 'camo.platinum',
    name: 'Platin',
    description: '500 Kills mit dieser Waffe.',
    rarity: 'epic',
    scope: 'weapon',
    unlock: { kind: 'weaponCounter', counter: 'kills', target: 500 },
    shader: {
      pattern: 'metal',
      colors: [0x6c7078, 0xc9ced6, 0xf4f7fb],
      scale: 1,
      roughness: 0.15,
      metalness: 1,
      animation: STATIC,
    },
  },
  {
    id: 'camo.obsidian',
    name: 'Obsidian',
    description: '50 Schwachstellen-Kills mit dieser Waffe.',
    rarity: 'epic',
    scope: 'weapon',
    unlock: { kind: 'weaponCounter', counter: 'weakpoints', target: 50 },
    shader: {
      pattern: 'marble',
      colors: [0x050507, 0x1a1420, 0x6a3cff],
      scale: 2,
      roughness: 0.1,
      metalness: 0.4,
      animation: STATIC,
    },
  },
  {
    id: 'camo.diamond',
    name: 'Diamant',
    description: '150 Kopfschuss-Kills mit dieser Waffe.',
    rarity: 'legendary',
    scope: 'weapon',
    unlock: { kind: 'weaponCounter', counter: 'headshots', target: 150 },
    shader: {
      pattern: 'hex',
      colors: [0xbfe9ff, 0xe8f7ff, 0xffffff],
      scale: 10,
      roughness: 0.05,
      metalness: 0.2,
      emissive: { color: 0xbfe9ff, intensity: 0.4 },
      animation: { kind: 'shimmer', speed: 0.6, intensity: 0.6 },
    },
  },
  // --- endgame: animated ---
  {
    id: 'camo.riftflow',
    name: 'Riftstrom',
    description: 'Meistere die Waffe: Stufe 30, Gold, Platin, Obsidian und Diamant.',
    rarity: 'legendary',
    scope: 'weapon',
    unlock: {
      kind: 'weaponMastery',
      requires: ['camo.gold', 'camo.platinum', 'camo.obsidian', 'camo.diamond'],
      level: 30,
    },
    shader: {
      pattern: 'flow',
      colors: [0x12061f, 0x5a1bd8, 0xff3df2],
      scale: 3,
      roughness: 0.25,
      metalness: 0.5,
      emissive: { color: 0xb14dff, intensity: 2.2 },
      animation: { kind: 'flow', speed: 0.35, intensity: 0.8 },
    },
  },
  {
    id: 'camo.nebula',
    name: 'Nebula',
    description: 'Riftstrom auf 10 Waffen – gilt für jede Waffe.',
    rarity: 'mythic',
    scope: 'global',
    unlock: { kind: 'weaponsMastered', camo: 'camo.riftflow', count: 10 },
    shader: {
      pattern: 'nebula',
      colors: [0x05030d, 0x2a1466, 0x4de0ff],
      scale: 2,
      roughness: 0.2,
      metalness: 0.3,
      emissive: { color: 0x7fd8ff, intensity: 2.6 },
      animation: { kind: 'scroll', speed: 0.08, intensity: 1 },
    },
  },
  {
    id: 'camo.singularity',
    name: 'Ereignishorizont',
    description: 'Riftstrom auf jeder Waffe – gilt für jede Waffe.',
    rarity: 'mythic',
    scope: 'global',
    unlock: { kind: 'weaponsMastered', camo: 'camo.riftflow', count: 25 },
    shader: {
      pattern: 'rift',
      colors: [0x000000, 0x1b0b2e, 0xff8a1f],
      scale: 1.5,
      roughness: 0.1,
      metalness: 0.2,
      emissive: { color: 0xff8a1f, intensity: 3 },
      animation: { kind: 'rift', speed: 0.25, intensity: 1 },
    },
  },
  {
    id: 'camo.aurora',
    name: 'Polarlicht',
    description: 'Prestige 5 – gilt für jede Waffe.',
    rarity: 'legendary',
    scope: 'global',
    unlock: { kind: 'prestige', rank: 5 },
    shader: {
      pattern: 'flow',
      colors: [0x041a14, 0x14b88a, 0x9dff5a],
      scale: 2.5,
      roughness: 0.3,
      metalness: 0.4,
      emissive: { color: 0x5affc8, intensity: 1.8 },
      animation: { kind: 'shimmer', speed: 0.2, intensity: 0.7 },
    },
  },
  {
    id: 'camo.bloodmoon',
    name: 'Blutmond',
    description: 'Erfolg „Rift-Direktor“ – gilt für jede Waffe.',
    rarity: 'legendary',
    scope: 'global',
    unlock: { kind: 'achievement', id: 'lab_wave_30' },
    shader: {
      pattern: 'marble',
      colors: [0x120204, 0x6a0a0f, 0xff2d3a],
      scale: 2,
      roughness: 0.3,
      metalness: 0.3,
      emissive: { color: 0xff2d3a, intensity: 1.4 },
      animation: { kind: 'pulse', speed: 0.5, intensity: 0.5 },
    },
  },
];

// ---------------------------------------------------------------------------
// Charms, crosshairs, kill effects, emblems
// ---------------------------------------------------------------------------

export type CosmeticUnlock =
  | { readonly kind: 'default' }
  | { readonly kind: 'level'; readonly level: number }
  | { readonly kind: 'prestige'; readonly rank: number }
  | { readonly kind: 'achievement'; readonly id: string }
  /** Weekly challenge reward pool. */
  | { readonly kind: 'challenge' }
  | { readonly kind: 'shop'; readonly price: number };

export type CharmShape = 'skull' | 'die' | 'tag' | 'crystal' | 'fang' | 'eye' | 'coin' | 'rift';

export interface CharmDef {
  readonly kind: 'charm';
  readonly id: string;
  readonly name: string;
  readonly rarity: CosmeticRarity;
  readonly unlock: CosmeticUnlock;
  /** Small hanging model (built procedurally later) and its colours (sRGB). */
  readonly shape: CharmShape;
  readonly color: number;
  readonly glow?: number;
}

export interface CrosshairDef {
  readonly kind: 'crosshair';
  readonly id: string;
  readonly name: string;
  readonly rarity: CosmeticRarity;
  readonly unlock: CosmeticUnlock;
  /** Base style (settings gameplay.crosshair styles + new ones for the M11 HUD). */
  readonly style: 'dot' | 'cross' | 'circle' | 'chevron' | 'delta' | 'bracket' | 'rift';
  /** Default colour (the settings colour overrides it); null = the settings colour. */
  readonly color: string | null;
}

export interface KillEffectDef {
  readonly kind: 'killEffect';
  readonly id: string;
  readonly name: string;
  readonly rarity: CosmeticRarity;
  readonly unlock: CosmeticUnlock;
  /** VFX preset id spawned at the dying enemy (defs/vfx VFX_EFFECTS). */
  readonly vfx: string;
  readonly scale: number;
}

export interface EmblemDef {
  readonly kind: 'emblem';
  readonly id: string;
  readonly name: string;
  readonly rarity: CosmeticRarity;
  readonly unlock: CosmeticUnlock;
  /** PROGRESSION_GLYPHS id and colours (sRGB). */
  readonly glyph: string;
  readonly color: number;
  readonly frame: 'plain' | 'bronze' | 'silver' | 'gold' | 'rift';
}

export type CosmeticDef = CharmDef | CrosshairDef | KillEffectDef | EmblemDef;

const CHARMS: readonly CharmDef[] = [
  {
    kind: 'charm',
    id: 'charm.tag',
    name: 'Hundemarke',
    rarity: 'common',
    unlock: { kind: 'level', level: 5 },
    shape: 'tag',
    color: 0xb8bcc4,
  },
  {
    kind: 'charm',
    id: 'charm.die',
    name: 'Glückswürfel',
    rarity: 'common',
    unlock: { kind: 'level', level: 15 },
    shape: 'die',
    color: 0xe8e2d4,
  },
  {
    kind: 'charm',
    id: 'charm.skull',
    name: 'Totenkopf',
    rarity: 'rare',
    unlock: { kind: 'achievement', id: 'kills_1000' },
    shape: 'skull',
    color: 0xd9d2c0,
  },
  {
    kind: 'charm',
    id: 'charm.fang',
    name: 'Schwärmerzahn',
    rarity: 'rare',
    unlock: { kind: 'achievement', id: 'swarmers_1000' },
    shape: 'fang',
    color: 0xf0e6c8,
  },
  {
    kind: 'charm',
    id: 'charm.crystal',
    name: 'Rift-Kristall',
    rarity: 'epic',
    unlock: { kind: 'challenge' },
    shape: 'crystal',
    color: 0x7a4dff,
    glow: 0xb48cff,
  },
  {
    kind: 'charm',
    id: 'charm.eye',
    name: 'Spuckerauge',
    rarity: 'epic',
    unlock: { kind: 'challenge' },
    shape: 'eye',
    color: 0x9dff3a,
    glow: 0x9dff3a,
  },
  {
    kind: 'charm',
    id: 'charm.coin',
    name: 'Letzte Münze',
    rarity: 'rare',
    unlock: { kind: 'shop', price: 300 },
    shape: 'coin',
    color: 0xd4a82c,
  },
  {
    kind: 'charm',
    id: 'charm.rift',
    name: 'Riss im Glas',
    rarity: 'legendary',
    unlock: { kind: 'prestige', rank: 3 },
    shape: 'rift',
    color: 0x1b0b2e,
    glow: 0xff3df2,
  },
];

const CROSSHAIRS: readonly CrosshairDef[] = [
  {
    kind: 'crosshair',
    id: 'crosshair.dot',
    name: 'Punkt',
    rarity: 'common',
    unlock: { kind: 'default' },
    style: 'dot',
    color: null,
  },
  {
    kind: 'crosshair',
    id: 'crosshair.cross',
    name: 'Kreuz',
    rarity: 'common',
    unlock: { kind: 'default' },
    style: 'cross',
    color: null,
  },
  {
    kind: 'crosshair',
    id: 'crosshair.circle',
    name: 'Kreis',
    rarity: 'common',
    unlock: { kind: 'default' },
    style: 'circle',
    color: null,
  },
  {
    kind: 'crosshair',
    id: 'crosshair.chevron',
    name: 'Winkel',
    rarity: 'common',
    unlock: { kind: 'default' },
    style: 'chevron',
    color: null,
  },
  {
    kind: 'crosshair',
    id: 'crosshair.delta',
    name: 'Delta',
    rarity: 'rare',
    unlock: { kind: 'level', level: 20 },
    style: 'delta',
    color: '#ffb000',
  },
  {
    kind: 'crosshair',
    id: 'crosshair.bracket',
    name: 'Klammer',
    rarity: 'rare',
    unlock: { kind: 'challenge' },
    style: 'bracket',
    color: '#00e5ff',
  },
  {
    kind: 'crosshair',
    id: 'crosshair.rift',
    name: 'Riss',
    rarity: 'epic',
    unlock: { kind: 'achievement', id: 'headshot_streak_25' },
    style: 'rift',
    color: '#ff3df2',
  },
];

const KILL_EFFECTS: readonly KillEffectDef[] = [
  {
    kind: 'killEffect',
    id: 'killfx.default',
    name: 'Standard',
    rarity: 'common',
    unlock: { kind: 'default' },
    vfx: 'enemy.death',
    scale: 1,
  },
  {
    kind: 'killEffect',
    id: 'killfx.ember',
    name: 'Glut',
    rarity: 'rare',
    unlock: { kind: 'achievement', id: 'fire_kills' },
    vfx: 'impact.fire',
    scale: 1.4,
  },
  {
    kind: 'killEffect',
    id: 'killfx.frost',
    name: 'Frostbruch',
    rarity: 'rare',
    unlock: { kind: 'achievement', id: 'ice_kills' },
    vfx: 'impact.ice',
    scale: 1.4,
  },
  {
    kind: 'killEffect',
    id: 'killfx.arc',
    name: 'Lichtbogen',
    rarity: 'rare',
    unlock: { kind: 'achievement', id: 'shock_kills' },
    vfx: 'impact.shock',
    scale: 1.4,
  },
  {
    kind: 'killEffect',
    id: 'killfx.toxic',
    name: 'Giftwolke',
    rarity: 'rare',
    unlock: { kind: 'achievement', id: 'poison_kills' },
    vfx: 'impact.poison',
    scale: 1.4,
  },
  {
    kind: 'killEffect',
    id: 'killfx.void',
    name: 'Leerenriss',
    rarity: 'epic',
    unlock: { kind: 'achievement', id: 'void_kills' },
    vfx: 'impact.void',
    scale: 1.4,
  },
  {
    kind: 'killEffect',
    id: 'killfx.plasma',
    name: 'Plasmaschmelze',
    rarity: 'epic',
    unlock: { kind: 'challenge' },
    vfx: 'impact.plasma',
    scale: 1.3,
  },
  {
    kind: 'killEffect',
    id: 'killfx.nova',
    name: 'Nova',
    rarity: 'epic',
    unlock: { kind: 'shop', price: 500 },
    vfx: 'perk.nova.arc',
    scale: 0.8,
  },
  {
    kind: 'killEffect',
    id: 'killfx.rift',
    name: 'Riftsog',
    rarity: 'legendary',
    unlock: { kind: 'prestige', rank: 1 },
    vfx: 'rift.spawn',
    scale: 0.6,
  },
  {
    kind: 'killEffect',
    id: 'killfx.phoenix',
    name: 'Phönixfeuer',
    rarity: 'legendary',
    unlock: { kind: 'prestige', rank: 7 },
    vfx: 'perk.phoenix.flare',
    scale: 0.7,
  },
];

const PRESTIGE_FRAMES: readonly EmblemDef['frame'][] = [
  'bronze',
  'bronze',
  'bronze',
  'silver',
  'silver',
  'silver',
  'gold',
  'gold',
  'gold',
  'rift',
];
const PRESTIGE_COLORS: readonly number[] = [
  0xc07a3a, 0xd08a44, 0xe09a4e, 0xb9c3cf, 0xc9d3df, 0xd9e3ef, 0xe0b84a, 0xeac45a, 0xf4d06a, 0xff3df2,
];

const EMBLEMS: readonly EmblemDef[] = [
  {
    kind: 'emblem',
    id: 'emblem.recruit',
    name: 'Rekrut',
    rarity: 'common',
    unlock: { kind: 'default' },
    glyph: 'rune',
    color: 0x9aa3ad,
    frame: 'plain',
  },
  {
    kind: 'emblem',
    id: 'emblem.level25',
    name: 'Bewährt',
    rarity: 'common',
    unlock: { kind: 'level', level: 25 },
    glyph: 'medal',
    color: 0xc07a3a,
    frame: 'bronze',
  },
  {
    kind: 'emblem',
    id: 'emblem.level50',
    name: 'Veteran',
    rarity: 'rare',
    unlock: { kind: 'level', level: 50 },
    glyph: 'medal',
    color: 0xc9d3df,
    frame: 'silver',
  },
  {
    kind: 'emblem',
    id: 'emblem.level100',
    name: 'Legende',
    rarity: 'epic',
    unlock: { kind: 'level', level: 100 },
    glyph: 'crown',
    color: 0xe0b84a,
    frame: 'gold',
  },
  {
    kind: 'emblem',
    id: 'emblem.trophy',
    name: 'Trophäenjäger',
    rarity: 'epic',
    unlock: { kind: 'achievement', id: 'achievements_30' },
    glyph: 'trophy',
    color: 0xe0b84a,
    frame: 'gold',
  },
  ...PRESTIGE_COLORS.map((color, i): EmblemDef => ({
    kind: 'emblem',
    id: `emblem.prestige${i + 1}`,
    name: `Prestige ${i + 1}`,
    rarity: i >= 9 ? 'mythic' : i >= 6 ? 'legendary' : i >= 3 ? 'epic' : 'rare',
    unlock: { kind: 'prestige', rank: i + 1 },
    glyph: 'crown',
    color,
    frame: PRESTIGE_FRAMES[i] ?? 'rift',
  })),
];

export const COSMETICS: readonly CosmeticDef[] = [...CHARMS, ...CROSSHAIRS, ...KILL_EFFECTS, ...EMBLEMS];

/** Equipped by a fresh profile (and whenever an equipped id stops being valid). */
export const DEFAULT_COSMETICS = {
  crosshair: 'crosshair.dot',
  killEffect: 'killfx.default',
  charm: null,
  emblem: 'emblem.recruit',
} as const;

const COSMETIC_INDEX: ReadonlyMap<string, CosmeticDef> = new Map(COSMETICS.map((c) => [c.id, c]));
const CAMO_INDEX: ReadonlyMap<string, CamoDef> = new Map(CAMOS.map((c) => [c.id, c]));

export function getCosmeticDef(id: string): CosmeticDef | undefined {
  return COSMETIC_INDEX.get(id);
}

export function getCamoDef(id: string): CamoDef | undefined {
  return CAMO_INDEX.get(id);
}

/** Unlock kind of any cosmetic id (camos included), for events and toasts. */
export function unlockKindOf(id: string): UnlockKind | null {
  if (CAMO_INDEX.has(id)) return 'camo';
  return COSMETIC_INDEX.get(id)?.kind ?? null;
}

export function isAnimatedCamo(def: CamoDef): boolean {
  return def.shader.animation.kind !== 'none';
}
