/**
 * KV-9 „Kolibri“ – viewmodel poses and part choreography (M5). Import runtime helpers from
 * '../viewmodelParts' and only TYPES from '../viewmodels' (runtime cycle otherwise).
 *
 * The recoil-mitigating action: the part named `bolt` is the counter-mass carrier behind the left
 * window of the lower receiver – every shot throws it DOWN and back instead of into the shoulder
 * (1150 rpm: the pulse fits the ~52 ms interval), so the whole weapon barely kicks. It stays down
 * on the last round and snaps back up on the empty reload's boltRelease marker.
 */
import type { PartMotionDef, WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

const CARRIER_DOWN = { pos: V(0, -0.0075, 0.004) } as const;

const CARRIER_CYCLE: PartMotionDef = {
  part: 'bolt',
  type: 'pulse',
  pose: CARRIER_DOWN,
  duration: 0.011,
  hold: 0.002,
  release: 0.03,
  ease: 'snap',
  releaseEase: 'in',
};

const TRIGGER: PartMotionDef = { ...TRIGGER_PULL, pose: { rot: V(-16, 0, 0) }, hold: 0.06, release: 0.05 };

export const VECTOR_VIEWMODEL: WeaponViewmodelDef = {
  hip: { pos: V(0.13, -0.152, -0.33), rot: V(0, 2, 0) },
  adsEyeDistance: 0.2,
  sprint: { pos: V(-0.03, -0.035, 0.03), rot: V(-12, 32, -22) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.035, -0.08),
  // Tight and damped: the counter-mass swallows most of the kick.
  kickSpring: { posStiffness: 560, posDamping: 34, rotStiffness: 450, rotDamping: 30 },
  adsKickScale: 0.35,
  sustained: { perShot: 0.03, decay: 2.6, pose: { pos: V(0, 0.002, 0.008), rot: V(1.1, 0, 0) } },
  heat: { perShot: 0.028, decay: 0.22 },
  fire: [CARRIER_CYCLE, TRIGGER],
  fireLast: [{ part: 'bolt', type: 'tween', pose: CARRIER_DOWN, duration: 0.011, ease: 'snap' }, TRIGGER],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-18, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: ['bolt'],
  reload: {
    style: 'timeline',
    // Lifted and rolled right: the magwell and the magazine coming up from below face the eye.
    tactical: {
      markers: { magOut: 0.213, magIn: 0.613 },
      keys: [
        { t: 0.12, pos: V(-0.03, 0.024, 0.026), rot: V(10, 14, -28) },
        { t: 0.213, pos: V(-0.032, 0.03, 0.03), rot: V(13, 16, -33) },
        { t: 0.43, pos: V(-0.04, 0.014, 0.026), rot: V(6, 18, -35) },
        { t: 0.613, pos: V(-0.04, 0.02, 0.026), rot: V(9, 16, -31) },
        { t: 0.84, pos: V(-0.014, 0.006, 0.008), rot: V(3, 6, -10) },
      ],
    },
    empty: {
      markers: { magOut: 0.158, magIn: 0.474, boltRelease: 0.768 },
      keys: [
        { t: 0.09, pos: V(-0.03, 0.024, 0.026), rot: V(10, 14, -28) },
        { t: 0.158, pos: V(-0.032, 0.03, 0.03), rot: V(13, 16, -33) },
        { t: 0.33, pos: V(-0.04, 0.014, 0.026), rot: V(6, 18, -35) },
        { t: 0.474, pos: V(-0.04, 0.02, 0.026), rot: V(9, 16, -31) },
        // Left flank towards the eye: the carrier snaps back up in its window.
        { t: 0.63, pos: V(-0.05, 0.024, 0.01), rot: V(5, 30, 14) },
        { t: 0.768, pos: V(-0.05, 0.028, 0.012), rot: V(7, 29, 16) },
        { t: 0.9, pos: V(-0.014, 0.006, 0.004), rot: V(2, 8, 4) },
      ],
    },
  },
  // The magazine seats 55 ms after the magIn marker.
  reloadSteps: {
    magOut: [
      {
        part: 'magazine',
        type: 'tween',
        pose: { pos: V(0, -0.2, -0.01), rot: V(8, 0, -8) },
        duration: 0.2,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'magazine',
        type: 'tween',
        from: { pos: V(0, -0.13, -0.008), rot: V(6, 0, 0) },
        pose: {},
        lead: 0.12,
        duration: 0.175,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [{ part: 'bolt', type: 'tween', pose: {}, lead: 0.03, duration: 0.03, ease: 'in' }],
  },
  reloadImpulses: {
    magOut: [{ delay: 0, pose: { pos: V(0, 0.008, 0), rot: V(3, 0, -2) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0, 0.012, 0), rot: V(-4, 0, 3) } }],
    boltRelease: [{ delay: 0, pose: { pos: V(0, 0.004, -0.008), rot: V(2.5, 0, -2) } }],
  },
  accentLight: { pos: V(-0.035, 0.03, -0.13), color: 0x46e6ff, intensity: 0.015, distance: 0.22 },
  glow: { accent: 2.3, readout: 2.5, sight: 4.5, heat: 5 },
};
