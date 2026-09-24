/**
 * AS-20 „Mahlstrom“ – viewmodel poses and part choreography (M5). Drum-fed automatic shotgun: the
 * bolt flashes in the port, and the rotor behind the drum window turns one chamber (360°/16) per
 * shot – its 16 swirl blades make each step read as a continuous whirl. The heavy drum drops out and
 * a fresh one is slammed in from below; empty reloads rack the left charging handle. Import runtime
 * helpers from '../viewmodelParts' and only TYPES from '../viewmodels'.
 */
import type { WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

/** Rotor step per shot (deg): one of the 16 chambers. */
export const DRUM_STEP_DEG = 22.5;
const BOLT_TRAVEL = 0.05;

export const AUTOSHOTGUN_VIEWMODEL: WeaponViewmodelDef = {
  hip: { pos: V(0.14, -0.165, -0.355), rot: V(0, 2, 0) },
  adsEyeDistance: 0.19,
  sprint: { pos: V(-0.035, -0.045, 0.03), rot: V(-14, 33, -26) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.03, -0.1),
  kickSpring: { posStiffness: 330, posDamping: 25, rotStiffness: 260, rotDamping: 21 },
  adsKickScale: 0.48,
  sustained: { perShot: 0.22, decay: 1.6, pose: { pos: V(0, 0.005, 0.014), rot: V(3, 0, 0) } },
  heat: { perShot: 0.11, decay: 0.22 },
  fire: [
    {
      part: 'bolt',
      type: 'pulse',
      pose: { pos: V(0, 0, BOLT_TRAVEL) },
      duration: 0.03,
      hold: 0.01,
      release: 0.07,
      ease: 'snap',
      releaseEase: 'in',
    },
    {
      part: 'drum',
      type: 'tween',
      from: {},
      pose: { rot: V(-DRUM_STEP_DEG, 0, 0) },
      delay: 0.03,
      duration: 0.09,
      ease: 'outBack',
    },
    { ...TRIGGER_PULL, hold: 0.04, release: 0.06 },
  ],
  fireLast: [
    { part: 'bolt', type: 'tween', pose: { pos: V(0, 0, BOLT_TRAVEL) }, duration: 0.03, ease: 'snap' },
    {
      part: 'drum',
      type: 'tween',
      from: {},
      pose: { rot: V(-DRUM_STEP_DEG, 0, 0) },
      delay: 0.03,
      duration: 0.09,
      ease: 'outBack',
    },
    { ...TRIGGER_PULL, hold: 0.04 },
  ],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-24, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: ['bolt'],
  reload: {
    style: 'timeline',
    // The drum hangs low: the gun is lifted, turned and rolled so the drum stays on screen.
    tactical: {
      markers: { magOut: 0.24, magIn: 0.64 },
      keys: [
        { t: 0.12, pos: V(-0.035, 0.04, 0.03), rot: V(12, 16, -28) },
        { t: 0.24, pos: V(-0.04, 0.05, 0.036), rot: V(16, 19, -34) },
        { t: 0.46, pos: V(-0.046, 0.034, 0.03), rot: V(9, 21, -36) },
        { t: 0.64, pos: V(-0.046, 0.042, 0.03), rot: V(13, 19, -32) },
        { t: 0.84, pos: V(-0.016, 0.008, 0.01), rot: V(3, 6, -10) },
      ],
    },
    empty: {
      markers: { magOut: 0.18, magIn: 0.5, boltRelease: 0.78 },
      keys: [
        { t: 0.1, pos: V(-0.035, 0.04, 0.03), rot: V(12, 16, -28) },
        { t: 0.18, pos: V(-0.04, 0.05, 0.036), rot: V(16, 19, -34) },
        { t: 0.36, pos: V(-0.046, 0.034, 0.03), rot: V(9, 21, -36) },
        { t: 0.5, pos: V(-0.046, 0.042, 0.03), rot: V(13, 19, -32) },
        { t: 0.65, pos: V(-0.05, 0.024, 0.012), rot: V(4, 28, 16) },
        { t: 0.78, pos: V(-0.05, 0.028, 0.014), rot: V(6, 28, 19) },
        { t: 0.92, pos: V(-0.014, 0.006, 0.004), rot: V(2, 8, 5) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'magazine',
        type: 'tween',
        pose: { pos: V(0.01, -0.22, -0.01), rot: V(14, 0, -16) },
        duration: 0.26,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'magazine',
        type: 'tween',
        from: { pos: V(0.004, -0.15, -0.012), rot: V(10, 0, -6) },
        pose: {},
        lead: 0.14,
        duration: 0.2,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [
      {
        part: 'chargingHandle',
        type: 'pulse',
        pose: { pos: V(0, 0, 0.06) },
        lead: 0.06,
        duration: 0.06,
        hold: 0.02,
        release: 0.045,
        ease: 'out',
        releaseEase: 'in',
      },
      { part: 'bolt', type: 'tween', pose: {}, delay: 0.02, duration: 0.045, ease: 'in' },
    ],
  },
  reloadImpulses: {
    magOut: [{ delay: 0.02, pose: { pos: V(0, 0.012, 0), rot: V(4, 0, -3) } }],
    magIn: [{ delay: 0.06, pose: { pos: V(0, 0.016, 0), rot: V(-5, 0, 4) } }],
    boltRelease: [
      { delay: 0, pose: { pos: V(0, 0, 0.008), rot: V(0, 0, 2) } },
      { delay: 0.065, pose: { pos: V(0, 0, -0.012), rot: V(3, 0, -3) } },
    ],
  },
  accentLight: { pos: V(-0.06, 0.02, -0.1), color: 0x46e6ff, intensity: 0.016, distance: 0.24 },
  glow: { accent: 2.2, readout: 2.4, sight: 4.5, heat: 5 },
};
