/**
 * SX-0 „Ereignishorizont“ – viewmodel poses and part choreography (M5). A slow, heavy singularity
 * projector: a contained micro black hole floats between three claws inside a spinning
 * containment ring. Each shot throws the core forward (it collapses and re-forms – the model
 * animates that itself), the ring spins faster as the weapon heats up. Reload: the void cell
 * drops out of the magwell, a fresh one goes in, and an empty reload re-primes the containment
 * with a ring jolt. Import runtime helpers from '../viewmodelParts' and only TYPES from '../viewmodels'.
 */
import type { WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

export const BLACKHOLE_VIEWMODEL: WeaponViewmodelDef | null = {
  hip: { pos: V(0.135, -0.145, -0.34), rot: V(0, 2, 0) },
  adsEyeDistance: 0.21,
  sprint: { pos: V(-0.035, -0.04, 0.03), rot: V(-14, 32, -24) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.04, -0.14),
  // Massive: a slow shove that hangs for a moment before it settles.
  kickSpring: { posStiffness: 190, posDamping: 17, rotStiffness: 150, rotDamping: 15 },
  adsKickScale: 0.5,
  sustained: { perShot: 0.5, decay: 1, pose: { pos: V(0, 0.004, 0.014), rot: V(2.8, 0, 0) } },
  heat: { perShot: 0.4, decay: 0.2 },
  fire: [
    {
      part: 'core',
      type: 'pulse',
      pose: { pos: V(0, 0, -0.03) },
      duration: 0.05,
      hold: 0.02,
      release: 0.5,
      ease: 'out',
      releaseEase: 'inOut',
    },
    {
      part: 'ring',
      type: 'pulse',
      pose: { pos: V(0, 0, 0.012) },
      duration: 0.03,
      hold: 0.03,
      release: 0.35,
      ease: 'snap',
      releaseEase: 'inOut',
    },
    { ...TRIGGER_PULL, pose: { rot: V(-20, 0, 0) }, hold: 0.06, release: 0.12 },
  ],
  fireLast: [
    {
      part: 'core',
      type: 'pulse',
      pose: { pos: V(0, 0, -0.03) },
      duration: 0.05,
      hold: 0.02,
      release: 0.5,
      ease: 'out',
      releaseEase: 'inOut',
    },
    { ...TRIGGER_PULL, pose: { rot: V(-20, 0, 0) }, hold: 0.06, release: 0.12 },
  ],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-24, 0, 0) }, release: 0.05 }],
  fireImpulses: [{ delay: 0.12, pose: { pos: V(0, 0.002, -0.008), rot: V(1.5, 0, -1) } }],
  lockParts: [],
  reload: {
    style: 'timeline',
    tactical: {
      markers: { magOut: 0.24, magIn: 0.64 },
      keys: [
        { t: 0.12, pos: V(-0.03, 0.028, 0.03), rot: V(12, 14, -30) },
        { t: 0.24, pos: V(-0.034, 0.034, 0.034), rot: V(15, 16, -35) },
        { t: 0.46, pos: V(-0.04, 0.018, 0.03), rot: V(8, 18, -36) },
        { t: 0.64, pos: V(-0.04, 0.026, 0.03), rot: V(11, 16, -32) },
        { t: 0.85, pos: V(-0.014, 0.006, 0.01), rot: V(3, 6, -10) },
      ],
    },
    empty: {
      markers: { magOut: 0.18, magIn: 0.5, boltRelease: 0.78 },
      keys: [
        { t: 0.1, pos: V(-0.03, 0.028, 0.03), rot: V(12, 14, -30) },
        { t: 0.18, pos: V(-0.034, 0.034, 0.034), rot: V(15, 16, -35) },
        { t: 0.37, pos: V(-0.04, 0.018, 0.03), rot: V(8, 18, -36) },
        { t: 0.5, pos: V(-0.04, 0.026, 0.03), rot: V(11, 16, -32) },
        // Lifted towards the eye: the containment ring jolts back to life.
        { t: 0.66, pos: V(-0.03, 0.04, 0.02), rot: V(12, 16, 4) },
        { t: 0.78, pos: V(-0.03, 0.044, 0.022), rot: V(14, 16, 6) },
        { t: 0.93, pos: V(-0.008, 0.008, 0.004), rot: V(3, 3, 1) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'cell',
        type: 'tween',
        pose: { pos: V(0, -0.2, 0.02), rot: V(-14, 0, 12) },
        duration: 0.26,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'cell',
        type: 'tween',
        from: { pos: V(0, -0.13, 0.012), rot: V(-10, 0, 0) },
        pose: {},
        lead: 0.14,
        duration: 0.19,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [
      {
        part: 'ring',
        type: 'tween',
        from: { rot: V(0, 0, 0) },
        pose: { rot: V(0, 0, 120) },
        duration: 0.3,
        ease: 'outBack',
      },
      {
        part: 'core',
        type: 'pulse',
        pose: { pos: V(0, 0.004, 0.01) },
        delay: 0.08,
        duration: 0.05,
        hold: 0.04,
        release: 0.25,
        ease: 'out',
      },
    ],
  },
  reloadImpulses: {
    magOut: [{ delay: 0, pose: { pos: V(0, 0.008, 0), rot: V(3, 0, -2) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0, 0.014, 0), rot: V(-4, 0, 3) } }],
    boltRelease: [{ delay: 0.05, pose: { pos: V(0, -0.004, 0.008), rot: V(-2, 0, 2) } }],
  },
  accentLight: { pos: V(0, 0.05, -0.3), color: 0x9a4dff, intensity: 0.045, distance: 0.32 },
  glow: { accent: 2.4, readout: 2.5, sight: 5, heat: 5 },
  drivers: [
    // Heat spins the containment ring up (it also idles on its own, see the model).
    { part: 'ring', source: 'heat', spin: { axis: 'z', degPerSec: 540 }, accentBoost: 1.5, response: 3 },
  ],
};
