/** Player vitals and misc player tuning (movement lives in defs/movement.ts). */
export interface PlayerHealthDef {
  readonly maxHealth: number;
  readonly maxArmor: number;
  readonly startHealth: number;
  readonly startArmor: number;
  /** Seconds without taking damage before health starts regenerating. */
  readonly regenDelay: number;
  /** Health per second while regenerating. */
  readonly regenRate: number;
  /** Health regenerates up to this fraction of maxHealth (1 = full). */
  readonly regenCapFraction: number;
  /** Fraction of incoming damage absorbed by armor while armor lasts (0..1). */
  readonly armorAbsorb: number;
}

export const PLAYER = {
  health: {
    maxHealth: 100,
    maxArmor: 100,
    startHealth: 100,
    startArmor: 50,
    regenDelay: 4.5,
    regenRate: 22,
    regenCapFraction: 1,
    armorAbsorb: 0.6,
  } satisfies PlayerHealthDef,
  /** Aim-down-sights blend rates (1/s) for the smoothed adsAmount. */
  ads: {
    lambdaIn: 14,
    lambdaOut: 10,
  },
  /** Movement unlocks used when the caller does not pass any (M1 test room shows everything). */
  defaultUnlocks: {
    doubleJump: true,
    dash: true,
  },
} as const;
