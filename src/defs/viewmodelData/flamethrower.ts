/**
 * FW-4 „Inferno“ – viewmodel poses and part choreography (M5). A beam weapon: while it burns the
 * swirl vanes in the nozzle whirl and a flare tongue pushes out of the bell (beam drivers); the
 * pilot flame under the nozzle flickers all the time and dies when the tank runs dry.
 * Reload: the fuel tank is unhooked from the left flank (the pilot starves and dies) and a full
 * one hooked on (magOut/magIn); then the pilot re-ignites with a puff (boltRelease, both reloads).
 * Import runtime helpers from '../viewmodelParts' and only TYPES from '../viewmodels'.
 */
import type { WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

export const FLAMETHROWER_VIEWMODEL: WeaponViewmodelDef | null = {
  hip: { pos: V(0.135, -0.15, -0.33), rot: V(0, 2, 0) },
  adsEyeDistance: 0.19,
  sprint: { pos: V(-0.035, -0.04, 0.03), rot: V(-14, 32, -24) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.03, -0.14),
  kickSpring: { posStiffness: 300, posDamping: 24, rotStiffness: 240, rotDamping: 20 },
  adsKickScale: 0.5,
  sustained: { perShot: 0.04, decay: 1.2, pose: { pos: V(0, 0.002, 0.006), rot: V(0.8, 0, 0) } },
  heat: { perShot: 0.03, decay: 0.16 },
  fire: [{ ...TRIGGER_PULL, pose: { rot: V(-18, 0, 0) } }],
  // The tank ran dry: the pilot flame gutters out until the empty reload re-ignites it.
  fireLast: [
    { ...TRIGGER_PULL, pose: { rot: V(-18, 0, 0) } },
    {
      part: 'pilot',
      type: 'tween',
      pose: { pos: V(0, 0, 0.012) },
      delay: 0.12,
      duration: 0.2,
      ease: 'in',
      hideAtEnd: true,
    },
  ],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-22, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: ['pilot'],
  reload: {
    style: 'timeline',
    // Rolled right: the left-flank tank (and its gauge) turn towards the camera, then the nozzle
    // comes up: unhooking the tank starves the pilot, both reloads re-ignite it (boltRelease).
    tactical: {
      markers: { magOut: 0.19, magIn: 0.6, boltRelease: 0.81 },
      keys: [
        { t: 0.1, pos: V(-0.035, 0.035, 0.03), rot: V(10, 16, -30) },
        { t: 0.19, pos: V(-0.04, 0.04, 0.034), rot: V(13, 18, -35) },
        { t: 0.42, pos: V(-0.045, 0.026, 0.03), rot: V(6, 20, -37) },
        { t: 0.6, pos: V(-0.045, 0.034, 0.03), rot: V(9, 18, -33) },
        { t: 0.72, pos: V(-0.04, 0.045, 0.02), rot: V(14, 20, -8) },
        { t: 0.81, pos: V(-0.04, 0.048, 0.022), rot: V(16, 20, -10) },
        { t: 0.93, pos: V(-0.01, 0.008, 0.004), rot: V(3, 4, -2) },
      ],
    },
    empty: {
      markers: { magOut: 0.17, magIn: 0.55, boltRelease: 0.81 },
      keys: [
        { t: 0.09, pos: V(-0.035, 0.035, 0.03), rot: V(10, 16, -30) },
        { t: 0.17, pos: V(-0.04, 0.04, 0.034), rot: V(13, 18, -35) },
        { t: 0.38, pos: V(-0.045, 0.026, 0.03), rot: V(6, 20, -37) },
        { t: 0.55, pos: V(-0.045, 0.034, 0.03), rot: V(9, 18, -33) },
        // Nozzle up and in: the pilot re-ignites in front of the eye.
        { t: 0.7, pos: V(-0.04, 0.045, 0.02), rot: V(14, 20, -8) },
        { t: 0.81, pos: V(-0.04, 0.048, 0.022), rot: V(16, 20, -10) },
        { t: 0.93, pos: V(-0.01, 0.008, 0.004), rot: V(3, 4, -2) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'pilot',
        type: 'tween',
        pose: { pos: V(0, 0, 0.012) },
        duration: 0.18,
        ease: 'in',
        hideAtEnd: true,
      },
      {
        part: 'tank',
        type: 'tween',
        pose: { pos: V(-0.05, -0.19, 0.05), rot: V(-20, 10, 25) },
        duration: 0.3,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'tank',
        type: 'tween',
        from: { pos: V(-0.04, -0.12, 0.03), rot: V(-12, 6, 14) },
        pose: {},
        lead: 0.16,
        duration: 0.21,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [
      {
        part: 'pilot',
        type: 'tween',
        from: { pos: V(0, 0, 0.01) },
        pose: {},
        duration: 0.12,
        ease: 'outBack',
        show: true,
      },
      {
        part: 'flare',
        type: 'pulse',
        pose: { pos: V(0, 0, -0.03) },
        duration: 0.05,
        hold: 0.03,
        release: 0.18,
        ease: 'out',
        releaseEase: 'inOut',
      },
    ],
  },
  reloadImpulses: {
    magOut: [{ delay: 0.03, pose: { pos: V(0, 0.01, 0), rot: V(3, 0, -3) } }],
    magIn: [{ delay: 0.06, pose: { pos: V(0, 0.014, 0), rot: V(-5, 0, 4) } }],
    boltRelease: [{ delay: 0.02, pose: { pos: V(0, 0.002, 0.008), rot: V(2, 0, 1) } }],
  },
  accentLight: { pos: V(0, 0.03, -0.46), color: 0xff7a2a, intensity: 0.04, distance: 0.3 },
  glow: { accent: 4, readout: 2.5, sight: 5, heat: 5.5 },
  drivers: [
    // Burning: the flare tongue pushes out of the bell, the swirl vanes whirl, the slots glow.
    { part: 'flare', source: 'beam', pose: { pos: V(0, 0, -0.045) }, accentBoost: 3, response: 14 },
    { part: 'swirl', source: 'beam', spin: { axis: 'z', degPerSec: 1440 }, accentBoost: 0.5, response: 6 },
  ],
};
