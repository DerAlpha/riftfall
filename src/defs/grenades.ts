/**
 * Grenades (M5 "Granaten: Frag, Brand, Kryo, Singularität"): data for src/grenades/GrenadeSystem.
 *
 * How a throw plays (GRENADE_RULES):
 * - Pressing 'grenade' pulls the pin; the throw leaves on RELEASE. Its strength ramps from a lob
 *   (a tap: `lobSpeedScale` of the grenade's speed, pitched up by `lobPitchDeg`) to a full throw
 *   after `windup` s of holding (`throwPitchDeg`). Holding longer keeps it primed (aim with it),
 *   `maxHold` s throws by itself. No cooking: the fuse starts at the throw (no self-kills by
 *   holding too long).
 * - The flight starts at the RENDERED camera (WYSIWYG, like every shot) along the view pitched up,
 *   plus the thrower's velocity × `inheritVelocity`; it is drawn from the off hand (`hand`,
 *   camera space) and converges onto the true arc (ARSENAL.projectiles.convergeTime).
 * - Grenades are ProjectileApi projectiles: they bounce (`bounces`, `restitution`), rest on floors,
 *   explode on their fuse – or at once on a direct enemy hit.
 * - Counts per type, capped at `max`; the Max-Ammo power-up refills every carried type. The run
 *   starts with `start` (map loadouts may override it: LoadoutDef.grenade). When the selected type
 *   runs dry, the next carried type with grenades left is selected.
 *
 * Damage ids: blasts and fields carry weaponId `grenade.<id>` (kill credit, stats, audio).
 * Glyphs are stroke-only SVG path data in a 24×24 box (like defs/perks PERK_GLYPHS), colours sRGB.
 * Units: meters, seconds, m/s, degrees where noted.
 */
import type { DamageElement } from '../core/events';
import { explosion, field } from './weaponData/common';
import type { WeaponProjectileDef } from './weapons';

export const GRENADE_GLYPHS = {
  /** Frag: ribbed body, spoon lever and pin ring. */
  frag: 'M12 9.5C15.6 9.5 17.5 12.3 17.5 15.3 17.5 18.8 15.2 21.5 12 21.5 8.8 21.5 6.5 18.8 6.5 15.3 6.5 12.3 8.4 9.5 12 9.5Z M10 9.5V7.3H14V9.5 M14 7.3 18.3 5 M8.8 5.6A1.6 1.6 0 1 0 8.9 5.5 M7 15.5H17 M12 9.8V21.2',
  /** Incendiary: canister with a flame. */
  brand:
    'M7.5 9H16.5V21H7.5Z M10 9V6.5H14V9 M12 18.8C10.4 18.8 9.7 17.5 10.3 16.2 10.8 15.2 11.8 14.6 11.8 12.8 13.9 14.2 14.3 15.8 14.2 16.8 14.1 18 13.3 18.8 12 18.8Z',
  /** Cryo: canister with a snowflake. */
  kryo: 'M7.5 8.5H16.5V21H7.5Z M10 8.5V6H14V8.5 M12 11.2V18.3 M9.2 12.9 14.8 16.6 M14.8 12.9 9.2 16.6',
  /** Singularity: a core inside a tilted orbit. */
  singularity:
    'M8.5 12A3.5 3.5 0 1 0 15.5 12 3.5 3.5 0 1 0 8.5 12 M2.6 14.8C1.6 12.6 6.2 9.4 12.6 8 18.9 6.6 22.3 7.3 21.5 9.4 M21.5 9.4C22.4 11.5 17.8 14.6 11.4 16 5 17.4 1.8 16.9 2.6 14.8',
} as const satisfies Record<string, string>;

export type GrenadeGlyphId = keyof typeof GRENADE_GLYPHS;

export interface GrenadeDef {
  readonly id: string;
  /** Player-facing (German). */
  readonly name: string;
  /** HUD label (German, upper case). */
  readonly shortName: string;
  readonly description: string;
  readonly icon: GrenadeGlyphId;
  /** HUD colour (sRGB hex). */
  readonly color: number;
  /** Most carried at once. */
  readonly max: number;
  /** DamageInfo.weaponId of its blasts and fields (`grenade.<id>`). */
  readonly weaponId: string;
  /** Flight, fuse, blast and field; `speed` is the full throw speed. */
  readonly projectile: WeaponProjectileDef;
  /**
   * Extra status build-up on every enemy within `radius` (line of sight) of the detonation, on top
   * of the blast's own build-up (kryo: enough to freeze on the spot). null = none.
   */
  readonly detonationStatus: {
    readonly element: DamageElement;
    readonly amount: number;
    readonly radius: number;
  } | null;
}

/** Visual/audio conventions of the arsenal (defs/arsenalVfx PROJECTILE_VISUALS, package D). */
const GRENADE_FLIGHT = {
  radius: 0.06,
  lifetime: 8,
  homing: 0,
  pierce: 0,
} as const;

export const GRENADES = {
  frag: {
    id: 'frag',
    name: 'Splittergranate',
    shortName: 'SPLITTER',
    description: 'Prallt ab und detoniert nach kurzer Zündzeit – oder sofort bei Feindkontakt.',
    icon: 'frag',
    color: 0xffb347,
    max: 4,
    weaponId: 'grenade.frag',
    projectile: {
      ...GRENADE_FLIGHT,
      speed: 20,
      gravity: 12,
      bounces: 4,
      restitution: 0.42,
      fuse: 1.9,
      explosion: explosion('physical', 6, 450, {
        minFalloff: 0.25,
        impulse: 10,
        propImpulse: 460,
        selfDamage: 0.12,
        shake: 0.65,
      }),
      field: null,
      visual: 'projectile.frag',
      trail: null,
      flightAudio: null,
    },
    detonationStatus: null,
  },
  brand: {
    id: 'brand',
    name: 'Brandgranate',
    shortName: 'BRAND',
    description: 'Zerplatzt beim Aufprall und setzt den Boden für Sekunden in Flammen.',
    icon: 'brand',
    color: 0xff6a2a,
    max: 3,
    weaponId: 'grenade.brand',
    projectile: {
      ...GRENADE_FLIGHT,
      speed: 18,
      gravity: 12,
      // Bursts on the first surface it meets (no bounce): the pool lands where it was aimed.
      bounces: 0,
      restitution: 0,
      fuse: 0,
      explosion: explosion('fire', 3.5, 70, { small: true, minFalloff: 0.5, shake: 0.3 }),
      field: field('damage', 'fire', 4, 7, 55, 0),
      visual: 'projectile.incendiary',
      trail: 'trail.fire',
      flightAudio: null,
    },
    detonationStatus: null,
  },
  kryo: {
    id: 'kryo',
    name: 'Kryogranate',
    shortName: 'KRYO',
    description: 'Schockfrostet alles im Umkreis und hinterlässt ein lähmendes Frostfeld.',
    icon: 'kryo',
    color: 0x8fe6ff,
    max: 3,
    weaponId: 'grenade.kryo',
    projectile: {
      ...GRENADE_FLIGHT,
      speed: 19,
      gravity: 12,
      bounces: 2,
      restitution: 0.35,
      fuse: 1.3,
      explosion: explosion('ice', 5.5, 160, { minFalloff: 0.4, impulse: 4, propImpulse: 260, shake: 0.4 }),
      field: field('slow', 'ice', 5.5, 6, 15, 0.4),
      visual: 'projectile.cryo',
      trail: 'trail.frost',
      flightAudio: null,
    },
    // Blast build-up + this ≥ 4 ice thresholds (defs/elements: three chill stacks, then frozen) –
    // anywhere in the blast for regular enemies, near the center even for a Koloss (ice ×0.6).
    detonationStatus: { element: 'ice', amount: 420, radius: 5.5 },
  },
  singularity: {
    id: 'singularity',
    name: 'Singularitätsgranate',
    shortName: 'SINGULARITÄT',
    description: 'Reißt ein Schwarzes Loch auf, das Gegner einsaugt und dann implodiert.',
    icon: 'singularity',
    color: 0xb07cff,
    max: 2,
    weaponId: 'grenade.singularity',
    projectile: {
      ...GRENADE_FLIGHT,
      speed: 18,
      gravity: 12,
      bounces: 1,
      restitution: 0.3,
      fuse: 1.1,
      explosion: explosion('void', 2.5, 60, { small: true, minFalloff: 0.5, shake: 0.25 }),
      field: field(
        'pull',
        'void',
        8,
        3.2,
        30,
        24,
        explosion('void', 6, 750, {
          minFalloff: 0.35,
          impulse: 11,
          propImpulse: 520,
          selfDamage: 0.1,
          shake: 0.7,
        }),
      ),
      visual: 'projectile.singularity',
      trail: 'trail.void',
      flightAudio: null,
    },
    detonationStatus: null,
  },
} as const satisfies Record<string, GrenadeDef>;

export type GrenadeId = keyof typeof GRENADES;

/** Every grenade type, in HUD / selection order. */
export const GRENADE_IDS: readonly GrenadeId[] = ['frag', 'brand', 'kryo', 'singularity'];

export function getGrenadeDef(id: string): GrenadeDef | undefined {
  return Object.prototype.hasOwnProperty.call(GRENADES, id)
    ? (GRENADES as Record<string, GrenadeDef>)[id]
    : undefined;
}

/** The grenade whose blasts/fields carry `weaponId` (`grenade.<id>`), if any. */
export function grenadeByWeaponId(weaponId: string): GrenadeDef | undefined {
  for (const id of GRENADE_IDS) {
    const def = GRENADES[id] as GrenadeDef;
    if (def.weaponId === weaponId) return def;
  }
  return undefined;
}

export const GRENADE_RULES = {
  /** A new run starts with these (LoadoutDef.grenade overrides per map). */
  start: { id: 'frag', count: 2 },
  /** A tap throws at this fraction of the grenade's speed; full strength after `windup` s held. */
  lobSpeedScale: 0.5,
  windup: 0.35,
  /** Launch pitched up above the view (deg): lob → full throw. */
  lobPitchDeg: 16,
  throwPitchDeg: 6,
  /** The launch pitch never exceeds this (deg): looking straight up never throws backwards. */
  maxPitchDeg: 80,
  /** Fraction of the thrower's velocity the grenade inherits. */
  inheritVelocity: 1,
  /** Holding a primed grenade this long throws it (s). */
  maxHold: 4,
  /** Minimum time between two throws (s). */
  interval: 0.5,
  /** Drawn from the off hand: camera-space offset (m; right, up, forward). */
  hand: { right: 0.2, up: -0.16, forward: 0.3 },
  /** Detonation status bursts queued per tick at most (pool; extra ones are dropped). */
  maxPendingBursts: 8,
  /** Enemies considered per detonation status burst. */
  maxBurstTargets: 48,
} as const;

/** CSS colour (sRGB) of a grenade's HUD glyph. */
export function grenadeCssColor(def: Pick<GrenadeDef, 'color'>): string {
  return `#${def.color.toString(16).padStart(6, '0')}`;
}
