/**
 * PL-2 „Sonnenwind“ – viewmodel poses and part choreography (M5). An automatic plasma carbine:
 * every bolt kicks the accelerator coils back in their cage; the vent louvre on top lifts with
 * barrel heat. Reload: the spent plasma cell pops out of its cradle on the shooter-facing left
 * flank, a fresh one is pressed in, and on an empty reload the vent louvre blows off the heat.
 * Import runtime helpers from '../viewmodelParts' and only TYPES from '../viewmodels'.
 */
import type { WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

export const PLASMA_VIEWMODEL: WeaponViewmodelDef | null = {
  hip: { pos: V(0.13, -0.148, -0.33), rot: V(0, 2, 0) },
  adsEyeDistance: 0.2,
  sprint: { pos: V(-0.03, -0.035, 0.03), rot: V(-12, 32, -22) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.03, -0.1),
  kickSpring: { posStiffness: 520, posDamping: 32, rotStiffness: 420, rotDamping: 29 },
  adsKickScale: 0.4,
  sustained: { perShot: 0.07, decay: 1.8, pose: { pos: V(0, 0.004, 0.012), rot: V(2.2, 0, 0) } },
  heat: { perShot: 0.045, decay: 0.2 },
  fire: [
    {
      part: 'coils',
      type: 'pulse',
      pose: { pos: V(0, 0, 0.012) },
      duration: 0.016,
      hold: 0.006,
      release: 0.06,
      ease: 'snap',
      releaseEase: 'in',
    },
    { ...TRIGGER_PULL, pose: { rot: V(-14, 0, 0) }, hold: 0.015, release: 0.04 },
  ],
  fireLast: [
    {
      part: 'coils',
      type: 'pulse',
      pose: { pos: V(0, 0, 0.012) },
      duration: 0.016,
      hold: 0.006,
      release: 0.06,
      ease: 'snap',
      releaseEase: 'in',
    },
    // The emptied cell unlatches: it rides up out of its cradle until the reload pulls it.
    {
      part: 'cell',
      type: 'tween',
      pose: { pos: V(-0.004, 0.003, 0) },
      delay: 0.05,
      duration: 0.08,
      ease: 'outBack',
    },
    { ...TRIGGER_PULL, pose: { rot: V(-14, 0, 0) } },
  ],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-18, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: ['cell'],
  reload: {
    style: 'timeline',
    // Rolled right so the left-flank cradle faces the camera and the cell leaves up-left.
    tactical: {
      markers: { magOut: 0.24, magIn: 0.64 },
      keys: [
        { t: 0.12, pos: V(-0.035, 0.03, 0.02), rot: V(8, 20, -14) },
        { t: 0.24, pos: V(-0.04, 0.036, 0.024), rot: V(11, 22, -18) },
        { t: 0.46, pos: V(-0.045, 0.024, 0.02), rot: V(5, 24, -20) },
        { t: 0.64, pos: V(-0.045, 0.03, 0.02), rot: V(8, 22, -17) },
        { t: 0.84, pos: V(-0.014, 0.008, 0.006), rot: V(2, 7, -6) },
      ],
    },
    empty: {
      markers: { magOut: 0.18, magIn: 0.5, boltRelease: 0.78 },
      keys: [
        { t: 0.1, pos: V(-0.035, 0.03, 0.02), rot: V(8, 20, -14) },
        { t: 0.18, pos: V(-0.04, 0.036, 0.024), rot: V(11, 22, -18) },
        { t: 0.36, pos: V(-0.045, 0.024, 0.02), rot: V(5, 24, -20) },
        { t: 0.5, pos: V(-0.045, 0.03, 0.02), rot: V(8, 22, -17) },
        // Muzzle up, top towards the eye: the vent louvre blows off the heat.
        { t: 0.66, pos: V(-0.02, 0.03, 0.01), rot: V(14, 8, 6) },
        { t: 0.78, pos: V(-0.02, 0.034, 0.012), rot: V(16, 8, 8) },
        { t: 0.92, pos: V(-0.006, 0.008, 0.004), rot: V(4, 2, 2) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'cell',
        type: 'tween',
        pose: { pos: V(-0.07, 0.06, 0.03), rot: V(10, -20, 50) },
        duration: 0.26,
        ease: 'out',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'cell',
        type: 'tween',
        from: { pos: V(-0.06, 0.018, 0.02), rot: V(0, -12, 12) },
        pose: {},
        lead: 0.14,
        duration: 0.19,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [
      {
        part: 'vents',
        type: 'pulse',
        pose: { rot: V(38, 0, 0) },
        duration: 0.06,
        hold: 0.16,
        release: 0.14,
        ease: 'outBack',
        releaseEase: 'inOut',
      },
      {
        part: 'coils',
        type: 'pulse',
        pose: { pos: V(0, 0, 0.01) },
        delay: 0.04,
        duration: 0.03,
        hold: 0.04,
        release: 0.12,
        ease: 'snap',
      },
    ],
  },
  reloadImpulses: {
    magOut: [{ delay: 0.02, pose: { pos: V(0.004, 0.006, 0), rot: V(2, 0, 3) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0.006, 0.004, 0), rot: V(-2, 0, -4) } }],
    boltRelease: [{ delay: 0, pose: { pos: V(0, -0.004, 0.006), rot: V(-2, 0, 0) } }],
  },
  accentLight: { pos: V(-0.04, 0.05, -0.08), color: 0x3dffc0, intensity: 0.03, distance: 0.26 },
  glow: { accent: 2.3, readout: 2.5, sight: 5, heat: 5 },
  drivers: [
    // Sustained fire lifts the vent louvre, showing the glowing heat sink below it.
    { part: 'vents', source: 'heat', pose: { rot: V(24, 0, 0) }, accentBoost: 0.8, response: 6 },
  ],
};
