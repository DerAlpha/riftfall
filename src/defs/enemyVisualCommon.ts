/**
 * Shared palette pieces of enemy visuals (src/defs/enemyVisuals.ts and the per-type files in
 * src/defs/enemyVisualData). A separate module so the per-type files can use them without importing
 * defs/enemyVisuals.ts (runtime cycle). Import only TYPES from './enemyVisuals' in
 * defs/enemyVisualData/*; add new shared values here.
 */
import type { EnemyZoneDef, Rgb } from './enemyVisuals';

export const PI = Math.PI;
export const HALF_PI = Math.PI / 2;

/** Rift energy (linear): emergence seams, ground tears, spawn bursts. */
export const RIFT_VIOLET: Rgb = [0.62, 0.3, 1];

/** Ivory bone darkening to black-red tips (spikes, claws, mandibles). */
export const BONE: EnemyZoneDef = {
  color: [0.42, 0.37, 0.29],
  color2: [0.3, 0.25, 0.19],
  tip: [0.035, 0.02, 0.02],
  tipAmount: 0.85,
  roughness: 0.42,
  metalness: 0,
  clearcoat: 0.55,
  emissive: [0, 0, 0],
  emissiveIntensity: 0,
  glow: 0,
  pulse: 0,
  veins: 0,
  bump: 0.35,
  cells: 0.15,
  scale: 3,
};
