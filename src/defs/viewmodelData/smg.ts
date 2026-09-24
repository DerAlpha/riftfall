/**
 * SK-5 „Viper“ – viewmodel poses and part choreography (M5). Import runtime helpers from
 * '../viewmodelParts' and only TYPES from '../viewmodels' (runtime cycle otherwise).
 *
 * The part named `bolt` is the left-side cocking handle on the receiver nose: it reciprocates with
 * every shot (850 rpm: the pulse fits the ~70 ms interval), locks back on the last round and is
 * slapped home on the empty reload's boltRelease marker (the SK-5 "slap").
 */
import type { PartMotionDef, WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

const HANDLE_BACK = { pos: V(0, 0, 0.032) } as const;

const HANDLE_CYCLE: PartMotionDef = {
  part: 'bolt',
  type: 'pulse',
  pose: HANDLE_BACK,
  duration: 0.014,
  hold: 0.003,
  release: 0.04,
  ease: 'snap',
  releaseEase: 'in',
};

const TRIGGER: PartMotionDef = { ...TRIGGER_PULL, pose: { rot: V(-16, 0, 0) }, hold: 0.06, release: 0.05 };

export const SMG_VIEWMODEL: WeaponViewmodelDef = {
  hip: { pos: V(0.13, -0.148, -0.33), rot: V(0, 2, 0) },
  adsEyeDistance: 0.19,
  sprint: { pos: V(-0.03, -0.035, 0.03), rot: V(-12, 32, -22) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.03, -0.08),
  kickSpring: { posStiffness: 500, posDamping: 30, rotStiffness: 400, rotDamping: 27 },
  adsKickScale: 0.4,
  sustained: { perShot: 0.05, decay: 2.2, pose: { pos: V(0, 0.004, 0.012), rot: V(2.2, 0.5, 0) } },
  heat: { perShot: 0.03, decay: 0.2 },
  fire: [HANDLE_CYCLE, TRIGGER],
  fireLast: [{ part: 'bolt', type: 'tween', pose: HANDLE_BACK, duration: 0.014, ease: 'snap' }, TRIGGER],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-18, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: ['bolt'],
  reload: {
    style: 'timeline',
    // Rolled left and lifted so the magwell (and the magazine swinging in from below) is in view.
    tactical: {
      markers: { magOut: 0.2125, magIn: 0.625 },
      keys: [
        { t: 0.12, pos: V(-0.03, 0.024, 0.026), rot: V(10, 14, -28) },
        { t: 0.2125, pos: V(-0.032, 0.03, 0.03), rot: V(13, 16, -33) },
        { t: 0.44, pos: V(-0.04, 0.012, 0.026), rot: V(6, 18, -35) },
        { t: 0.625, pos: V(-0.04, 0.02, 0.026), rot: V(9, 16, -31) },
        { t: 0.84, pos: V(-0.014, 0.006, 0.008), rot: V(3, 6, -10) },
      ],
    },
    empty: {
      markers: { magOut: 0.156, magIn: 0.478, boltRelease: 0.771 },
      keys: [
        { t: 0.09, pos: V(-0.03, 0.024, 0.026), rot: V(10, 14, -28) },
        { t: 0.156, pos: V(-0.032, 0.03, 0.03), rot: V(13, 16, -33) },
        { t: 0.34, pos: V(-0.04, 0.012, 0.026), rot: V(6, 18, -35) },
        { t: 0.478, pos: V(-0.04, 0.02, 0.026), rot: V(9, 16, -31) },
        // Roll the left flank up: the locked handle is slapped home in view.
        { t: 0.64, pos: V(-0.048, 0.026, 0.01), rot: V(6, 28, 14) },
        { t: 0.771, pos: V(-0.05, 0.03, 0.012), rot: V(8, 28, 17) },
        { t: 0.9, pos: V(-0.014, 0.006, 0.004), rot: V(2, 8, 4) },
      ],
    },
  },
  // The magazine seats 55 ms after the magIn marker; the slap lands on the boltRelease marker.
  reloadSteps: {
    magOut: [
      {
        part: 'magazine',
        type: 'tween',
        pose: { pos: V(0, -0.21, -0.02), rot: V(12, 0, -8) },
        duration: 0.22,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'magazine',
        type: 'tween',
        from: { pos: V(0, -0.14, -0.018), rot: V(9, 0, 0) },
        pose: {},
        lead: 0.12,
        duration: 0.175,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [{ part: 'bolt', type: 'tween', pose: {}, lead: 0.03, duration: 0.035, ease: 'in' }],
  },
  reloadImpulses: {
    magOut: [{ delay: 0, pose: { pos: V(0, 0.008, 0), rot: V(3, 0, -2) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0, 0.012, 0), rot: V(-4, 0, 3) } }],
    boltRelease: [{ delay: 0, pose: { pos: V(0.004, -0.005, -0.012), rot: V(3, -2, -5) } }],
  },
  accentLight: { pos: V(-0.04, 0.07, -0.12), color: 0x46e6ff, intensity: 0.015, distance: 0.22 },
  glow: { accent: 2.2, readout: 2.4, sight: 4.5, heat: 5 },
};
