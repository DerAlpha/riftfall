/**
 * RG-9 „Lanze“ – viewmodel poses and part choreography (M5). A charge weapon: while the trigger is
 * held the twin rails spread apart and the coil stack brightens (charge drivers); the release
 * slams both rails back. Reload: the capacitor cell drops out of the magwell, a fresh one is
 * pushed in, and on an empty reload the priming lever is racked while the coils flash.
 * Import runtime helpers from '../viewmodelParts' and only TYPES from '../viewmodels'.
 */
import type { WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

export const RAILGUN_VIEWMODEL: WeaponViewmodelDef | null = {
  hip: { pos: V(0.13, -0.15, -0.34), rot: V(0, 2, 0) },
  adsEyeDistance: 0.2,
  sprint: { pos: V(-0.035, -0.04, 0.03), rot: V(-13, 34, -24) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.04, -0.14),
  // Heavy: slow, deep kick that settles with a little wobble.
  kickSpring: { posStiffness: 240, posDamping: 20, rotStiffness: 190, rotDamping: 17 },
  adsKickScale: 0.45,
  sustained: { perShot: 0.45, decay: 1.2, pose: { pos: V(0, 0.004, 0.012), rot: V(2.4, 0, 0) } },
  heat: { perShot: 0.34, decay: 0.22 },
  fire: [
    {
      part: 'rails',
      type: 'pulse',
      pose: { pos: V(0, 0, 0.022) },
      duration: 0.02,
      hold: 0.012,
      release: 0.16,
      ease: 'snap',
      releaseEase: 'inOut',
    },
    {
      part: 'coils',
      type: 'pulse',
      pose: { pos: V(0, 0, 0.012) },
      duration: 0.025,
      hold: 0.02,
      release: 0.2,
      ease: 'snap',
      releaseEase: 'inOut',
    },
    { ...TRIGGER_PULL, pose: { rot: V(-18, 0, 0) }, hold: 0.05, release: 0.1 },
  ],
  fireLast: [
    {
      part: 'rails',
      type: 'pulse',
      pose: { pos: V(0, 0, 0.022) },
      duration: 0.02,
      hold: 0.012,
      release: 0.16,
      ease: 'snap',
      releaseEase: 'inOut',
    },
    { ...TRIGGER_PULL, pose: { rot: V(-18, 0, 0) }, hold: 0.05, release: 0.1 },
  ],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-20, 0, 0) }, release: 0.05 }],
  fireImpulses: [
    // The rails' rebound shoves the gun forward again a moment after the slam.
    { delay: 0.09, pose: { pos: V(0, 0.002, -0.008), rot: V(1.5, 0, -1) } },
  ],
  lockParts: [],
  reload: {
    style: 'timeline',
    tactical: {
      markers: { magOut: 0.22, magIn: 0.64 },
      keys: [
        { t: 0.12, pos: V(-0.03, 0.03, 0.03), rot: V(12, 14, -30) },
        { t: 0.22, pos: V(-0.034, 0.036, 0.036), rot: V(15, 16, -35) },
        { t: 0.45, pos: V(-0.04, 0.018, 0.03), rot: V(8, 18, -36) },
        { t: 0.64, pos: V(-0.04, 0.026, 0.03), rot: V(11, 16, -32) },
        { t: 0.84, pos: V(-0.014, 0.006, 0.01), rot: V(3, 6, -10) },
      ],
    },
    empty: {
      markers: { magOut: 0.17, magIn: 0.5, boltRelease: 0.78 },
      keys: [
        { t: 0.1, pos: V(-0.03, 0.03, 0.03), rot: V(12, 14, -30) },
        { t: 0.17, pos: V(-0.034, 0.036, 0.036), rot: V(15, 16, -35) },
        { t: 0.36, pos: V(-0.04, 0.018, 0.03), rot: V(8, 18, -36) },
        { t: 0.5, pos: V(-0.04, 0.026, 0.03), rot: V(11, 16, -32) },
        // Roll the right flank up: the priming lever is racked in view.
        { t: 0.66, pos: V(-0.03, 0.03, 0.01), rot: V(6, 8, 26) },
        { t: 0.78, pos: V(-0.03, 0.034, 0.012), rot: V(8, 8, 30) },
        { t: 0.92, pos: V(-0.01, 0.008, 0.004), rot: V(2, 3, 8) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'cell',
        type: 'tween',
        pose: { pos: V(0, -0.2, 0.02), rot: V(-16, 0, 10) },
        duration: 0.24,
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
        lead: 0.13,
        duration: 0.18,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [
      {
        part: 'primer',
        type: 'pulse',
        pose: { pos: V(0, 0, 0.05) },
        duration: 0.07,
        hold: 0.03,
        release: 0.05,
        ease: 'out',
        releaseEase: 'in',
      },
      {
        part: 'coils',
        type: 'pulse',
        pose: { pos: V(0, 0, 0.008) },
        delay: 0.1,
        duration: 0.03,
        hold: 0.05,
        release: 0.2,
        ease: 'snap',
      },
    ],
  },
  reloadImpulses: {
    magOut: [{ delay: 0, pose: { pos: V(0, 0.008, 0), rot: V(3, 0, -2) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0, 0.014, 0), rot: V(-4, 0, 3) } }],
    boltRelease: [
      { delay: 0.02, pose: { pos: V(0, 0, 0.008), rot: V(-1, 0, 2) } },
      { delay: 0.12, pose: { pos: V(0, 0, -0.01), rot: V(3, 0, -3) } },
    ],
  },
  accentLight: { pos: V(0, 0.07, -0.36), color: 0x4fd8ff, intensity: 0.03, distance: 0.3 },
  glow: { accent: 2.4, readout: 2.6, sight: 6, heat: 5 },
  drivers: [
    // Charging: the rails part from their roots (the tips open wider) and the coils burn brighter.
    { part: 'railL', source: 'charge', pose: { pos: V(-0.004, 0.001, 0), rot: V(0, 1.2, 0) }, response: 12 },
    { part: 'railR', source: 'charge', pose: { pos: V(0.004, 0.001, 0), rot: V(0, -1.2, 0) }, response: 12 },
    { part: 'coils', source: 'charge', accentBoost: 5, response: 10 },
  ],
};
