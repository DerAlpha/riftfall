/**
 * Rift Forge (M5, "Pack-a-Punch" equivalent): upgrade rules and the forged looks.
 *
 * Rules: the forge upgrades the HELD weapon one tier at a time (tier 0 → 1 → 2 → 3). The price of a
 * tier is the weapon def's `upgrades[i].cost` (every roster weapon takes it from `FORGE.tierCosts`,
 * so this table is the one place to rebalance); an upgrade refills the weapon's magazine and
 * reserve. Tiers are cumulative (defs/weapons WeaponUpgradeTier): tier 3 carries the stat mods of
 * tiers 1–3 and the newest special.
 *
 * Economy target (CoD-Zombies pacing, see defs/economy.ts and defs/waves.ts): a run earns roughly
 * 25–30k points by wave 10, ~65k by wave 15 and ~130k by wave 20 (≈100 points per enemy + wave
 * bonuses) while doors, perks and box rolls compete for them. Tier 1 is affordable around wave
 * 6–9 (the classic 5000), tier 2 around 12–15, tier 3 around 18–22 – one fully forged weapon per
 * run for an average player, two for a strong one.
 *
 * Looks (FORGE_LOOKS, consumed by the viewmodel look / forge machine): tier 1 'forge1' molten amber,
 * tier 2 'forge2' violet rift energy with faint crackling veins, tier 3 'forge3' animated white-hot
 * rift camo. A tier may name its own palette (WeaponUpgradeTier.palette), e.g. wonder weapons.
 * Colors: sRGB hex like VIEWMODEL_ART (three.js material setup) unless marked "linear".
 */
import type { WeaponDef, WeaponUpgradeTier } from './weapons';

export type ForgeTier = 1 | 2 | 3;

export const FORGE = {
  /** Price of tier 1, 2, 3 (index = tier − 1). */
  tierCosts: [5000, 12000, 25000] as readonly number[],
  maxTier: 3 as ForgeTier,
  /** An upgrade refills the upgraded weapon (magazine + reserve). */
  refillOnUpgrade: true,
  /** Palette per tier when the tier names none (index = tier − 1). */
  tierPalettes: ['forge1', 'forge2', 'forge3'] as readonly string[],
  /** Player-facing tier labels (German, HUD / forge panel). */
  tierLabels: ['Stufe I', 'Stufe II', 'Stufe III'] as readonly string[],
  /** Forge prompt texts; `{name}` = the weapon's current name, `{tier}` = the next tier label. */
  prompts: {
    upgrade: '{name} schmieden ({tier})',
    maxTier: 'Maximale Stufe',
    noWeapon: 'Keine Waffe in der Hand',
  },
} as const;

/** Price of forging tier `tier` when a weapon def names none (0 for invalid tiers). */
export function forgeTierCost(tier: number): number {
  return tier >= 1 && tier <= FORGE.tierCosts.length ? FORGE.tierCosts[tier - 1]! : 0;
}

/** The upgrade that takes `def` from `currentTier` to the next tier, or null at the max tier. */
export function nextForgeTier(def: WeaponDef, currentTier: number): WeaponUpgradeTier | null {
  for (const u of def.upgrades) if (u.tier === currentTier + 1) return u;
  return null;
}

/** Palette id of `def` at `tier` (0 = none): the newest tier ≤ `tier` that names one, else the tier default. */
export function forgePaletteId(def: WeaponDef, tier: number): string | null {
  if (!(tier >= 1)) return null;
  let best: WeaponUpgradeTier | null = null;
  for (const u of def.upgrades) if (u.tier <= tier && (!best || u.tier > best.tier)) best = u;
  if (!best) return null;
  return best.palette ?? FORGE.tierPalettes[Math.min(best.tier, FORGE.tierPalettes.length) - 1] ?? null;
}

/**
 * Animated camo on the weapon's body materials (a cheap noise patch in the body shader): flowing
 * domain-warped noise, thresholded into glowing veins over a darkened base.
 */
export interface ForgeCamoDef {
  /** Noise frequency (cells per meter, model space). */
  readonly scale: number;
  /** Flow speed (noise units per second) and domain-warp strength. */
  readonly speed: number;
  readonly warp: number;
  /** Fraction of the body surface the camo covers (0..1, noise-masked). */
  readonly coverage: number;
  /** Base color under the veins (sRGB hex). */
  readonly base: number;
  /** Vein color (sRGB hex) and its emissive intensity (blooms above ~1). */
  readonly vein: number;
  readonly veinIntensity: number;
  /** Secondary vein color the veins shift towards over time (sRGB hex). */
  readonly veinShift: number;
  /** Vein band width (0..1 of the noise range) and edge sharpness (higher = crisper). */
  readonly veinWidth: number;
  readonly sharpness: number;
  /** Brightness pulse (rad/s) and depth (0..1). */
  readonly pulseRate: number;
  readonly pulseDepth: number;
}

export interface ForgeLookDef {
  readonly id: string;
  /** Player-facing name of the finish (German). */
  readonly name: string;
  /** Emissive accent strips/readout glow (sRGB hex), replaces VIEWMODEL_ART.emissive.accent. */
  readonly accent: number;
  /** Accent emissive intensity factor (1 = the weapon's own). */
  readonly accentIntensity: number;
  /** Accent paint panels (VIEWMODEL_ART.materials.accentPaint) recolor (sRGB hex). */
  readonly paint: number;
  /** Body materials (gunmetal, darkMetal, polymer) multiply tint (sRGB hex, 0xffffff = unchanged). */
  readonly bodyTint: number;
  /** Body roughness factor and metalness offset (forged metal reads glossier). */
  readonly roughnessScale: number;
  readonly metalnessOffset: number;
  /** Lit readout segments [r, g, b] 0..255 (replaces VIEWMODEL_ART.emissive.readoutOn). */
  readonly readout: readonly [number, number, number];
  /** Tracer color for tiers without their own `tracerColor` (linear hex). */
  readonly tracer: number;
  /** Muzzle flash light tint (linear hex). */
  readonly muzzleLight: number;
  /** Heat glow color of hot parts (sRGB hex), replaces VIEWMODEL_ART.emissive.heat. */
  readonly heat: number;
  /** Animated camo on the body (null = plain). */
  readonly camo: ForgeCamoDef | null;
}

export const FORGE_LOOKS: Readonly<Record<string, ForgeLookDef>> = {
  /** Tier 1: molten amber – glowing forge-orange accents, warm bronzed metal. */
  forge1: {
    id: 'forge1',
    name: 'Geschmolzener Bernstein',
    accent: 0xff8a1a,
    accentIntensity: 1.35,
    paint: 0xd26a12,
    bodyTint: 0xe8d6c2,
    roughnessScale: 0.85,
    metalnessOffset: 0.05,
    readout: [255, 168, 52],
    tracer: 0xff9a2e,
    muzzleLight: 0xffa040,
    heat: 0xff6a10,
    camo: null,
  },
  /** Tier 2: violet rift energy – violet accents and faint, slow veins of rift light. */
  forge2: {
    id: 'forge2',
    name: 'Rissenergie',
    accent: 0xa24dff,
    accentIntensity: 1.6,
    paint: 0x5a2a9a,
    bodyTint: 0xb4a8cc,
    roughnessScale: 0.75,
    metalnessOffset: 0.08,
    readout: [196, 120, 255],
    tracer: 0xb46cff,
    muzzleLight: 0xb070ff,
    heat: 0xd04cff,
    camo: {
      scale: 9,
      speed: 0.04,
      warp: 0.6,
      coverage: 0.3,
      base: 0x1a1024,
      vein: 0x9a4dff,
      veinIntensity: 2.2,
      veinShift: 0x4d7aff,
      veinWidth: 0.05,
      sharpness: 3,
      pulseRate: 1.4,
      pulseDepth: 0.35,
    },
  },
  /** Tier 3: animated white-hot rift camo – the whole body flows with bright rift veins. */
  forge3: {
    id: 'forge3',
    name: 'Weißglut-Riss',
    accent: 0xfff2e0,
    accentIntensity: 2,
    paint: 0x2a1238,
    bodyTint: 0x8a8098,
    roughnessScale: 0.65,
    metalnessOffset: 0.1,
    readout: [255, 236, 220],
    tracer: 0xffe6ff,
    muzzleLight: 0xfff0ff,
    heat: 0xffe0ff,
    camo: {
      scale: 6,
      speed: 0.22,
      warp: 1.2,
      coverage: 1,
      base: 0x0c0612,
      vein: 0xfff0ff,
      veinIntensity: 4.5,
      veinShift: 0xb24dff,
      veinWidth: 0.09,
      sharpness: 2.2,
      pulseRate: 2.6,
      pulseDepth: 0.25,
    },
  },
  /** Void-themed tier 3 overrides: void-black body, magenta-violet veins (Riss-Zerreißer, SX-0, RM-44, FW-4). */
  forgeVoid: {
    id: 'forgeVoid',
    name: 'Leerenglut',
    accent: 0xff4dff,
    accentIntensity: 2,
    paint: 0x14061e,
    bodyTint: 0x5e5070,
    roughnessScale: 0.6,
    metalnessOffset: 0.1,
    readout: [255, 110, 255],
    tracer: 0xe060ff,
    muzzleLight: 0xe070ff,
    heat: 0xff60ff,
    camo: {
      scale: 5,
      speed: 0.3,
      warp: 1.6,
      coverage: 1,
      base: 0x050208,
      vein: 0xff5cff,
      veinIntensity: 4,
      veinShift: 0x5a1cff,
      veinWidth: 0.08,
      sharpness: 2.5,
      pulseRate: 3.2,
      pulseDepth: 0.3,
    },
  },
  /** Frost-themed tier 3 overrides: glacier-blue veins through frosted metal (Kryo-Nova, LM-60 „Eiswall“). */
  forgeFrost: {
    id: 'forgeFrost',
    name: 'Ewiges Eis',
    accent: 0x9ae8ff,
    accentIntensity: 2,
    paint: 0x1c3c5a,
    bodyTint: 0xc6dcef,
    roughnessScale: 0.55,
    metalnessOffset: 0.1,
    readout: [170, 236, 255],
    tracer: 0xb8f0ff,
    muzzleLight: 0xa8e8ff,
    heat: 0x7ad8ff,
    camo: {
      scale: 7,
      speed: 0.12,
      warp: 0.9,
      coverage: 1,
      base: 0x0a1420,
      vein: 0xd8f6ff,
      veinIntensity: 4,
      veinShift: 0x4dc2ff,
      veinWidth: 0.07,
      sharpness: 3.2,
      pulseRate: 1.8,
      pulseDepth: 0.3,
    },
  },
};

/** Look def by palette id (undefined for unknown ids – the viewmodel keeps its own look). */
export function getForgeLook(id: string | null | undefined): ForgeLookDef | undefined {
  return id && Object.prototype.hasOwnProperty.call(FORGE_LOOKS, id) ? FORGE_LOOKS[id] : undefined;
}
