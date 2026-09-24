/**
 * SR-17 „Hammerschlag“ – viewmodel poses and part choreography (M5). Heavy semi-auto battle rifle:
 * every shot slams the bolt and the forward charging handle back, the gun rocks hard and settles;
 * the 20-round box goes out and in with a two-handed rock. Import runtime helpers from
 * '../viewmodelParts' and only TYPES from '../viewmodels' (runtime cycle otherwise).
 */
import type { PartMotionDef, WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

/** Bolt carrier + reciprocating charging handle travel (m). */
const CARRIER_TRAVEL = 0.058;

const carrierPulse = (part: string): PartMotionDef => ({
  part,
  type: 'pulse',
  pose: { pos: V(0, 0, CARRIER_TRAVEL) },
  duration: 0.022,
  hold: 0.008,
  release: 0.06,
  ease: 'snap',
  releaseEase: 'in',
});

const carrierLock = (part: string): PartMotionDef => ({
  part,
  type: 'tween',
  pose: { pos: V(0, 0, CARRIER_TRAVEL) },
  duration: 0.022,
  ease: 'snap',
});

export const BATTLERIFLE_VIEWMODEL: WeaponViewmodelDef = {
  hip: { pos: V(0.135, -0.162, -0.36), rot: V(0, 2, 0) },
  adsEyeDistance: 0.2,
  sprint: { pos: V(-0.035, -0.04, 0.03), rot: V(-13, 34, -25) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.03, -0.12),
  // Softer, heavier springs than the KR-7: the kick is big and settles with weight.
  kickSpring: { posStiffness: 400, posDamping: 28, rotStiffness: 320, rotDamping: 24 },
  adsKickScale: 0.42,
  sustained: { perShot: 0.3, decay: 1.7, pose: { pos: V(0, 0.004, 0.012), rot: V(2.4, 0, 0) } },
  heat: { perShot: 0.12, decay: 0.2 },
  fire: [
    carrierPulse('bolt'),
    carrierPulse('chargingHandle'),
    { ...TRIGGER_PULL, pose: { rot: V(-16, 0, 0) }, hold: 0.02, release: 0.06 },
  ],
  fireLast: [
    carrierLock('bolt'),
    carrierLock('chargingHandle'),
    { ...TRIGGER_PULL, pose: { rot: V(-16, 0, 0) } },
  ],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-20, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: ['bolt', 'chargingHandle'],
  reload: {
    style: 'timeline',
    tactical: {
      markers: { magOut: 0.24, magIn: 0.66 },
      keys: [
        { t: 0.13, pos: V(-0.03, 0.022, 0.03), rot: V(11, 15, -30) },
        { t: 0.24, pos: V(-0.034, 0.028, 0.036), rot: V(14, 17, -35) },
        { t: 0.46, pos: V(-0.042, 0.01, 0.03), rot: V(7, 19, -36) },
        { t: 0.66, pos: V(-0.042, 0.018, 0.03), rot: V(10, 17, -32) },
        { t: 0.84, pos: V(-0.014, 0.005, 0.01), rot: V(3, 6, -10) },
      ],
    },
    empty: {
      markers: { magOut: 0.17, magIn: 0.5, boltRelease: 0.78 },
      keys: [
        { t: 0.1, pos: V(-0.03, 0.022, 0.03), rot: V(11, 15, -30) },
        { t: 0.17, pos: V(-0.034, 0.028, 0.036), rot: V(14, 17, -35) },
        { t: 0.36, pos: V(-0.042, 0.01, 0.03), rot: V(7, 19, -36) },
        { t: 0.5, pos: V(-0.042, 0.018, 0.03), rot: V(10, 17, -32) },
        // Rolled onto the left flank: the forward charging handle is racked in plain view.
        { t: 0.65, pos: V(-0.052, 0.02, 0.0), rot: V(5, 28, 18) },
        { t: 0.78, pos: V(-0.052, 0.024, 0.004), rot: V(7, 28, 21) },
        { t: 0.92, pos: V(-0.014, 0.006, 0.002), rot: V(2, 8, 5) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'magazine',
        type: 'tween',
        pose: { pos: V(0, -0.21, -0.02), rot: V(16, 0, -10) },
        duration: 0.23,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'magazine',
        type: 'tween',
        from: { pos: V(0, -0.14, -0.018), rot: V(12, 0, 0) },
        pose: {},
        lead: 0.13,
        duration: 0.185,
        ease: 'inOut',
        show: true,
      },
    ],
    // The left hand yanks the forward handle to its rear stop, lets go: carrier slams home.
    boltRelease: [
      {
        part: 'chargingHandle',
        type: 'pulse',
        pose: { pos: V(0, 0, 0.016) },
        duration: 0.035,
        hold: 0.045,
        release: 0.03,
        ease: 'out',
        releaseEase: 'in',
      },
      { part: 'chargingHandle', type: 'tween', pose: {}, delay: 0.08, duration: 0.035, ease: 'in' },
      { part: 'bolt', type: 'tween', pose: {}, delay: 0.08, duration: 0.035, ease: 'in' },
    ],
  },
  reloadImpulses: {
    magOut: [{ delay: 0, pose: { pos: V(0, 0.009, 0), rot: V(3.5, 0, -2) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0, 0.014, 0), rot: V(-5, 0, 3) } }],
    boltRelease: [
      { delay: 0, pose: { pos: V(0, 0, 0.007), rot: V(0, 0, 2) } },
      { delay: 0.11, pose: { pos: V(0, 0, -0.012), rot: V(3.5, 0, -3) } },
    ],
  },
  accentLight: { pos: V(-0.05, 0.08, -0.25), color: 0x46e6ff, intensity: 0.015, distance: 0.24 },
  glow: { accent: 2.2, readout: 2.4, sight: 9, heat: 5 },
};
