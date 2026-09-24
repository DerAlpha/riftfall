/**
 * Shared building blocks of enemy type defs (src/defs/enemies.ts and the per-type files in
 * src/defs/enemyData). A separate module so the per-type files can use them without importing
 * defs/enemies.ts (which imports them – a runtime cycle). Import only TYPES from './enemies' in
 * defs/enemyData/*; add new shared values here.
 */
import type { HitZone } from '../core/events';

export const NO_ARMOR = { flat: 0, minFraction: 1, zones: [] as readonly HitZone[] } as const;
