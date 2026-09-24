/**
 * BR-3 „Triade“ – viewmodel poses and part choreography (M5). Bullpup burst rifle: every shot of
 * the three-round burst flicks the bolt in the port (near the cheek) and the forward charging
 * handle; the burst sums into one clean rock. The magazine sits behind the grip, so reloads lift
 * the muzzle and push the gun forward until the rear magwell is in plain view. Import runtime helpers
 * from '../viewmodelParts' and only TYPES from '../viewmodels'.
 */
import type { PartMotionDef, WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

const CARRIER_TRAVEL = 0.04;

const cycle = (part: string): PartMotionDef => ({
  part,
  type: 'pulse',
  pose: { pos: V(0, 0, CARRIER_TRAVEL) },
  duration: 0.016,
  hold: 0.004,
  release: 0.04,
  ease: 'snap',
  releaseEase: 'in',
});

export const BURSTRIFLE_VIEWMODEL: WeaponViewmodelDef = {
  // Bullpup: short, so it sits a little further out and higher than the KR-7.
  hip: { pos: V(0.13, -0.15, -0.37), rot: V(0, 2, 0) },
  adsEyeDistance: 0.2,
  sprint: { pos: V(-0.03, -0.035, 0.03), rot: V(-12, 32, -22) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.035, -0.05),
  kickSpring: { posStiffness: 500, posDamping: 31, rotStiffness: 400, rotDamping: 28 },
  adsKickScale: 0.4,
  sustained: { perShot: 0.12, decay: 2, pose: { pos: V(0, 0.004, 0.012), rot: V(2.4, 0, 0) } },
  heat: { perShot: 0.06, decay: 0.2 },
  fire: [cycle('bolt'), cycle('chargingHandle'), { ...TRIGGER_PULL, pose: { rot: V(-15, 0, 0) }, hold: 0.06 }],
  fireLast: [
    { part: 'bolt', type: 'tween', pose: { pos: V(0, 0, CARRIER_TRAVEL) }, duration: 0.016, ease: 'snap' },
    {
      part: 'chargingHandle',
      type: 'tween',
      pose: { pos: V(0, 0, CARRIER_TRAVEL) },
      duration: 0.016,
      ease: 'snap',
    },
    { ...TRIGGER_PULL, pose: { rot: V(-15, 0, 0) } },
  ],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-19, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: ['bolt', 'chargingHandle'],
  reload: {
    style: 'timeline',
    tactical: {
      markers: { magOut: 0.24, magIn: 0.66 },
      keys: [
        { t: 0.12, pos: V(-0.05, 0.045, -0.035), rot: V(18, 20, -22) },
        { t: 0.24, pos: V(-0.056, 0.052, -0.045), rot: V(22, 22, -26) },
        { t: 0.46, pos: V(-0.062, 0.04, -0.045), rot: V(16, 25, -28) },
        { t: 0.66, pos: V(-0.062, 0.048, -0.045), rot: V(20, 23, -25) },
        { t: 0.85, pos: V(-0.018, 0.01, -0.01), rot: V(5, 7, -8) },
      ],
    },
    empty: {
      markers: { magOut: 0.18, magIn: 0.52, boltRelease: 0.79 },
      keys: [
        { t: 0.1, pos: V(-0.05, 0.045, -0.035), rot: V(18, 20, -22) },
        { t: 0.18, pos: V(-0.056, 0.052, -0.045), rot: V(22, 22, -26) },
        { t: 0.37, pos: V(-0.062, 0.04, -0.045), rot: V(16, 25, -28) },
        { t: 0.52, pos: V(-0.062, 0.048, -0.045), rot: V(20, 23, -25) },
        // Forward handle on the left: rolled over, pulled back and let go.
        { t: 0.67, pos: V(-0.05, 0.022, 0.0), rot: V(5, 28, 16) },
        { t: 0.79, pos: V(-0.05, 0.026, 0.004), rot: V(7, 28, 19) },
        { t: 0.92, pos: V(-0.014, 0.006, 0.002), rot: V(2, 8, 5) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'magazine',
        type: 'tween',
        pose: { pos: V(0, -0.19, 0.03), rot: V(-12, 0, -10) },
        duration: 0.22,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'magazine',
        type: 'tween',
        from: { pos: V(0, -0.13, 0.024), rot: V(-9, 0, 0) },
        pose: {},
        lead: 0.12,
        duration: 0.175,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [
      {
        part: 'chargingHandle',
        type: 'pulse',
        pose: { pos: V(0, 0, 0.012) },
        duration: 0.03,
        hold: 0.04,
        release: 0.03,
        ease: 'out',
        releaseEase: 'in',
      },
      { part: 'chargingHandle', type: 'tween', pose: {}, delay: 0.07, duration: 0.03, ease: 'in' },
      { part: 'bolt', type: 'tween', pose: {}, delay: 0.07, duration: 0.03, ease: 'in' },
    ],
  },
  reloadImpulses: {
    magOut: [{ delay: 0, pose: { pos: V(0, 0.008, 0), rot: V(3, 0, -2) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0, 0.012, 0), rot: V(-4, 0, 3) } }],
    boltRelease: [
      { delay: 0, pose: { pos: V(0, 0, 0.006), rot: V(0, 0, 2) } },
      { delay: 0.1, pose: { pos: V(0, 0, -0.01), rot: V(3, 0, -3) } },
    ],
  },
  accentLight: { pos: V(-0.05, 0.07, -0.18), color: 0x46e6ff, intensity: 0.015, distance: 0.22 },
  glow: { accent: 2.2, readout: 2.4, sight: 5.5, heat: 5 },
};
