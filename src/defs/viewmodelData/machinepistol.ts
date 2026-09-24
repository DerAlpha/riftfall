/**
 * MP-3 „Hornisse“ – viewmodel poses and part choreography (M5). Import runtime helpers from
 * '../viewmodelParts' and only TYPES from '../viewmodels' (runtime cycle otherwise).
 *
 * 1100 rpm: the slide cycle (pulse) fits inside one shot interval (~55 ms) and a restarted pulse
 * continues from where it is, so full auto reads as a buzzing slide; the muzzle climbs with the
 * sustained-fire drift. Reload like the VX-9 (lifted, rolled, the long magazine drops out below
 * and slides back in), plus a slide release on empty.
 */
import type { PartMotionDef, WeaponViewmodelDef } from '../viewmodels';
import { TRIGGER_PULL, V } from '../viewmodelParts';

const SLIDE_BACK = { pos: V(0, 0, 0.028) } as const;

const SLIDE_CYCLE: PartMotionDef = {
  part: 'slide',
  type: 'pulse',
  pose: SLIDE_BACK,
  duration: 0.012,
  hold: 0.002,
  release: 0.032,
  ease: 'snap',
  releaseEase: 'in',
};

/** Held through automatic fire (each restart continues from the current value). */
const TRIGGER: PartMotionDef = { ...TRIGGER_PULL, hold: 0.06, release: 0.06 };

export const MACHINEPISTOL_VIEWMODEL: WeaponViewmodelDef = {
  hip: { pos: V(0.125, -0.128, -0.315), rot: V(0, 3, 0) },
  adsEyeDistance: 0.215,
  sprint: { pos: V(-0.01, -0.035, 0.03), rot: V(-32, 12, -10) },
  pivot: V(0, 0.014, -0.03),
  kickSpring: { posStiffness: 430, posDamping: 26, rotStiffness: 340, rotDamping: 22 },
  adsKickScale: 0.42,
  // Sustained fire: the muzzle climbs and pulls a little right.
  sustained: { perShot: 0.06, decay: 2.4, pose: { pos: V(0, 0.004, 0.009), rot: V(2.6, -0.8, -0.6) } },
  heat: { perShot: 0.035, decay: 0.26 },
  fire: [SLIDE_CYCLE, TRIGGER],
  fireLast: [{ part: 'slide', type: 'tween', pose: SLIDE_BACK, duration: 0.012, ease: 'snap' }, TRIGGER],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-26, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: ['slide'],
  reload: {
    style: 'timeline',
    tactical: {
      markers: { magOut: 0.207, magIn: 0.62 },
      keys: [
        { t: 0.11, pos: V(-0.035, 0.062, -0.02), rot: V(5, 12, -30) },
        { t: 0.207, pos: V(-0.04, 0.072, -0.025), rot: V(9, 14, -36) },
        { t: 0.44, pos: V(-0.045, 0.068, -0.03), rot: V(3, 16, -40) },
        { t: 0.62, pos: V(-0.045, 0.072, -0.03), rot: V(6, 14, -38) },
        { t: 0.84, pos: V(-0.012, 0.012, -0.006), rot: V(2, 4, -10) },
      ],
    },
    empty: {
      markers: { magOut: 0.156, magIn: 0.478, boltRelease: 0.778 },
      keys: [
        { t: 0.1, pos: V(-0.035, 0.062, -0.02), rot: V(5, 12, -30) },
        { t: 0.156, pos: V(-0.04, 0.072, -0.025), rot: V(9, 14, -36) },
        { t: 0.34, pos: V(-0.045, 0.068, -0.03), rot: V(3, 16, -40) },
        { t: 0.478, pos: V(-0.045, 0.072, -0.03), rot: V(6, 14, -38) },
        // Roll over to the left flank: the locked slide slams home in view.
        { t: 0.64, pos: V(-0.045, 0.046, -0.012), rot: V(4, 26, 16) },
        { t: 0.778, pos: V(-0.04, 0.05, -0.012), rot: V(7, 22, 13) },
        { t: 0.9, pos: V(-0.01, 0.006, 0.0), rot: V(2, 6, 3) },
      ],
    },
  },
  // The extended magazine needs a longer drop; it seats 55 ms after the magIn marker.
  reloadSteps: {
    magOut: [
      {
        part: 'magazine',
        type: 'tween',
        pose: { pos: V(0, -0.21, 0.012), rot: V(-12, 0, 8) },
        duration: 0.22,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'magazine',
        type: 'tween',
        from: { pos: V(0, -0.14, 0.006), rot: V(-7, 0, 0) },
        pose: {},
        lead: 0.12,
        duration: 0.175,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [{ part: 'slide', type: 'tween', pose: {}, lead: 0.035, duration: 0.035, ease: 'in' }],
  },
  reloadImpulses: {
    magOut: [{ delay: 0, pose: { pos: V(0, 0.006, 0), rot: V(3, 0, -2) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0, 0.011, 0), rot: V(-4.5, 0, 2) } }],
    boltRelease: [{ delay: 0, pose: { pos: V(0, 0, -0.008), rot: V(3, 0, -2) } }],
  },
  accentLight: { pos: V(-0.02, 0.03, -0.08), color: 0x46e6ff, intensity: 0.013, distance: 0.2 },
  glow: { accent: 2.3, readout: 2.6, sight: 3.5, heat: 5.5 },
};
