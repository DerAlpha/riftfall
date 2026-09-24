/**
 * PDW-50 „Sturmwind“ – viewmodel poses and part choreography (M5). Import runtime helpers from
 * '../viewmodelParts' and only TYPES from '../viewmodels' (runtime cycle otherwise).
 *
 * Top-loaded bullpup: the 50-round magazine lies on the receiver under the reflex housing. Reload:
 * the weapon comes up and cants so the top faces the eye, the magazine is lifted at its rear and
 * pulled back out, the new one drops in front-first and slides forward to click (magIn); on empty
 * the left-side charging handle, locked back since the last shot, snaps forward (boltRelease).
 */
import type { PartMotionDef, WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

const HANDLE_BACK = { pos: V(0, 0, 0.034) } as const;

const HANDLE_CYCLE: PartMotionDef = {
  part: 'bolt',
  type: 'pulse',
  pose: { pos: V(0, 0, 0.012) },
  duration: 0.012,
  hold: 0.002,
  release: 0.035,
  ease: 'snap',
  releaseEase: 'in',
};

const TRIGGER: PartMotionDef = { ...TRIGGER_PULL, pose: { rot: V(-16, 0, 0) }, hold: 0.06, release: 0.05 };

export const PDW_VIEWMODEL: WeaponViewmodelDef = {
  hip: { pos: V(0.122, -0.16, -0.34), rot: V(0, 2, 0) },
  adsEyeDistance: 0.2,
  sprint: { pos: V(-0.03, -0.04, 0.03), rot: V(-12, 30, -22) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.04, -0.06),
  kickSpring: { posStiffness: 480, posDamping: 30, rotStiffness: 380, rotDamping: 26 },
  adsKickScale: 0.4,
  sustained: { perShot: 0.045, decay: 2.2, pose: { pos: V(0, 0.003, 0.01), rot: V(1.8, 0.3, 0) } },
  heat: { perShot: 0.025, decay: 0.2 },
  fire: [HANDLE_CYCLE, TRIGGER],
  fireLast: [{ part: 'bolt', type: 'tween', pose: HANDLE_BACK, duration: 0.02, ease: 'snap' }, TRIGGER],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-18, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: ['bolt'],
  reload: {
    style: 'timeline',
    // Up, closer and canted left: the magazine on top turns towards the eye.
    tactical: {
      markers: { magOut: 0.21, magIn: 0.64 },
      keys: [
        { t: 0.12, pos: V(-0.035, 0.03, 0.03), rot: V(8, 12, 16) },
        { t: 0.21, pos: V(-0.04, 0.036, 0.034), rot: V(10, 14, 20) },
        { t: 0.42, pos: V(-0.045, 0.03, 0.03), rot: V(5, 16, 24) },
        { t: 0.64, pos: V(-0.045, 0.036, 0.03), rot: V(8, 15, 22) },
        { t: 0.84, pos: V(-0.014, 0.008, 0.008), rot: V(2, 5, 6) },
      ],
    },
    empty: {
      markers: { magOut: 0.163, magIn: 0.51, boltRelease: 0.796 },
      keys: [
        { t: 0.1, pos: V(-0.035, 0.03, 0.03), rot: V(8, 12, 16) },
        { t: 0.163, pos: V(-0.04, 0.036, 0.034), rot: V(10, 14, 20) },
        { t: 0.36, pos: V(-0.045, 0.03, 0.03), rot: V(5, 16, 24) },
        { t: 0.51, pos: V(-0.045, 0.036, 0.03), rot: V(8, 15, 22) },
        // Left flank up: the charging handle is released in view.
        { t: 0.68, pos: V(-0.05, 0.026, 0.012), rot: V(5, 28, 12) },
        { t: 0.796, pos: V(-0.05, 0.03, 0.014), rot: V(7, 28, 15) },
        { t: 0.92, pos: V(-0.014, 0.006, 0.004), rot: V(2, 8, 4) },
      ],
    },
  },
  // The magazine drops front-first and clicks home 60 ms after the magIn marker.
  reloadSteps: {
    magOut: [
      {
        part: 'magazine',
        type: 'tween',
        pose: { pos: V(0, 0.11, 0.12), rot: V(-20, 0, 10) },
        duration: 0.28,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'magazine',
        type: 'tween',
        from: { pos: V(0, 0.07, 0.07), rot: V(-14, 0, 5) },
        pose: {},
        lead: 0.14,
        duration: 0.2,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [{ part: 'bolt', type: 'tween', pose: {}, lead: 0.03, duration: 0.04, ease: 'in' }],
  },
  reloadImpulses: {
    magOut: [{ delay: 0.02, pose: { pos: V(0, 0.008, 0.004), rot: V(3, 0, -2) } }],
    magIn: [{ delay: 0.06, pose: { pos: V(0, -0.009, 0), rot: V(-3.5, 0, 1.5) } }],
    boltRelease: [{ delay: 0, pose: { pos: V(0, 0, -0.01), rot: V(3, 0, -3) } }],
  },
  accentLight: { pos: V(-0.035, 0.07, -0.1), color: 0x46e6ff, intensity: 0.016, distance: 0.24 },
  glow: { accent: 2.2, readout: 2.6, sight: 4, heat: 5 },
};
