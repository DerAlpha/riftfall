/**
 * Shared building blocks of the weapon roster (defs/weaponData/*): melee swings, Rift Forge tier
 * construction, convention audio ids, specials/explosions/fields reused by several weapons.
 *
 * Naming conventions (so the audio, VFX and viewmodel packages meet the data without talking):
 * - audio: weapon.<id>.fire / .mech / .equip / .<reload step>, shared weapon.tail.<size>,
 *   weapon.dry, weapon.holster, weapon.reload.start, weapon.melee, weapon.inspect; beams
 *   weapon.<id>.loop, charge weapon.<id>.charge, spin-up weapon.<id>.spin; projectile flight
 *   projectile.<visual suffix>.flight; explosions explosion.<element>[.small]; fields
 *   field.<kind>.<element>.
 * - VFX: muzzle.<family>, impact.<bullet|pellet|plasma|shock|fire|ice|poison|void>,
 *   projectile.<style>, trail.<style>, beam.<style>, charge.rail, field.<kind>.<element>,
 *   explosion.<element> (physical: the existing explosion.frag).
 * Unknown ids are silent / draw nothing, so data may land before its sounds and effects.
 */
import type { DamageElement } from '../../core/events';
import { FORGE, type ForgeTier } from '../forge';
import type {
  ExplosionDef,
  FieldDef,
  ReloadStep,
  WeaponAudioDef,
  WeaponMeleeDef,
  WeaponSpecialDef,
  WeaponStatMods,
  WeaponUpgradeTier,
} from '../weapons';

/** Shared melee swing (all M2 weapons bash with the same arm motion). */
export const MELEE_BASH = {
  damage: 60,
  range: 2.0,
  coneDeg: 32,
  duration: 0.5,
  hitTime: 0.11,
  cooldown: 0.12,
  impulse: 6,
  propImpulse: 90,
  shake: 0.28,
} as const satisfies WeaponMeleeDef;

/** Compact sidearms / SMGs: a quicker, lighter jab. */
export const MELEE_QUICK = {
  damage: 55,
  range: 1.9,
  coneDeg: 34,
  duration: 0.44,
  hitTime: 0.1,
  cooldown: 0.1,
  impulse: 5,
  propImpulse: 75,
  shake: 0.24,
} as const satisfies WeaponMeleeDef;

/** Heavy weapons (LMGs, launchers, energy rigs): a slow, crushing butt stroke. */
export const MELEE_HEAVY = {
  damage: 85,
  range: 2.1,
  coneDeg: 30,
  duration: 0.62,
  hitTime: 0.15,
  cooldown: 0.16,
  impulse: 8.5,
  propImpulse: 130,
  shake: 0.36,
} as const satisfies WeaponMeleeDef;

export type WeaponTail = 'small' | 'medium' | 'large' | 'energy' | 'explosive';

/** Reload step sets of the roster (every listed step gets its `weapon.<id>.<step>` sound). */
export const MAG_STEPS: readonly ReloadStep[] = ['magOut', 'magIn', 'boltRelease'];
export const SHELL_STEPS: readonly ReloadStep[] = ['shellIn', 'pump'];

/**
 * Convention sound ids of weapon `id`: fire = punch/body + mechanical + the shared tail of its
 * size; one `weapon.<id>.<step>` per reload step. `extraFire` adds per-shot layers with their own
 * lead-in (e.g. a bolt cycle after each shot).
 */
export function conventionAudio(
  id: string,
  tail: WeaponTail,
  steps: readonly ReloadStep[] = MAG_STEPS,
  extraFire?: readonly string[],
): WeaponAudioDef {
  const s: Partial<Record<ReloadStep, string>> = {};
  for (const step of steps) s[step] = `weapon.${id}.${step}`;
  const base: WeaponAudioDef = {
    fire: [`weapon.${id}.fire`, `weapon.${id}.mech`, `weapon.tail.${tail}`],
    dry: 'weapon.dry',
    equip: `weapon.${id}.equip`,
    holster: 'weapon.holster',
    reloadStart: 'weapon.reload.start',
    steps: s,
    melee: 'weapon.melee',
    inspect: 'weapon.inspect',
  };
  return extraFire && extraFire.length > 0 ? { ...base, extraFire } : base;
}

/** Extras of a forge tier beyond name, mods and special. */
export interface ForgeTierExtras {
  readonly tracerColor?: number;
  readonly palette?: string;
}

/** One Rift Forge tier; the price comes from FORGE.tierCosts. */
export function forgeTier(
  tier: ForgeTier,
  name: string,
  mods: WeaponStatMods,
  special: WeaponSpecialDef | null,
  extras: ForgeTierExtras = {},
): WeaponUpgradeTier {
  return {
    tier,
    name,
    cost: FORGE.tierCosts[tier - 1]!,
    mods,
    special,
    ...(extras.tracerColor !== undefined ? { tracerColor: extras.tracerColor } : {}),
    ...(extras.palette !== undefined ? { palette: extras.palette } : {}),
  };
}

/** VFX preset of an explosion of `element` (physical: the existing frag blast). */
export function explosionVfx(element: DamageElement): string {
  return element === 'physical' ? 'explosion.frag' : `explosion.${element}`;
}

/** Explosion defaults (knockback m/s, prop impulse N·s, shake trauma) for the helper below. */
export const EXPLOSION_DEFAULTS = {
  minFalloff: 0.35,
  impulse: 8,
  propImpulse: 360,
  shake: 0.5,
  smallImpulse: 3.5,
  smallPropImpulse: 120,
  smallShake: 0.14,
} as const;

/**
 * Explosion with the convention VFX/audio ids. `small` blasts (specials, splash) use the
 * `explosion.<element>.small` sound. Self damage defaults to none (forge specials never hurt the
 * shooter); launchers pass their own share.
 */
export function explosion(
  element: DamageElement,
  radius: number,
  damage: number,
  opts: {
    readonly small?: boolean;
    readonly minFalloff?: number;
    readonly impulse?: number;
    readonly propImpulse?: number;
    readonly selfDamage?: number;
    readonly shake?: number;
    readonly vfx?: string;
  } = {},
): ExplosionDef {
  const small = opts.small ?? false;
  return {
    radius,
    damage,
    minFalloffMultiplier: opts.minFalloff ?? EXPLOSION_DEFAULTS.minFalloff,
    element,
    impulse: opts.impulse ?? (small ? EXPLOSION_DEFAULTS.smallImpulse : EXPLOSION_DEFAULTS.impulse),
    propImpulse:
      opts.propImpulse ?? (small ? EXPLOSION_DEFAULTS.smallPropImpulse : EXPLOSION_DEFAULTS.propImpulse),
    selfDamageScale: opts.selfDamage ?? 0,
    shake: opts.shake ?? (small ? EXPLOSION_DEFAULTS.smallShake : EXPLOSION_DEFAULTS.shake),
    vfx: opts.vfx ?? explosionVfx(element),
    audio: small ? `explosion.${element}.small` : `explosion.${element}`,
  };
}

/** Lingering field with the convention VFX/audio id `field.<kind>.<element>`. */
export function field(
  kind: FieldDef['kind'],
  element: DamageElement,
  radius: number,
  duration: number,
  dps: number,
  strength: number,
  collapse: ExplosionDef | null = null,
): FieldDef {
  const id = `field.${kind}.${element}`;
  return { kind, radius, duration, dps, element, strength, collapse, vfx: id, audio: id };
}

// ---------------------------------------------------------------------------
// Fields reused by several specials
// ---------------------------------------------------------------------------

/** Burning pool left by a kill (Weltenbrecher, Supernova …): short, hot, small. */
export const FIRE_POOL = field('damage', 'fire', 2.4, 4, 45, 0);

/** Mini singularity left by a kill: pulls the neighbours in, then collapses. */
export const VOID_MAW = field(
  'pull',
  'void',
  4.5,
  2.2,
  25,
  16,
  explosion('void', 3.2, 220, { small: true, minFalloff: 0.4, shake: 0.22 }),
);
