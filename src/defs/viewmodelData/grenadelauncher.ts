/**
 * GL-6 „Donnerkeil“ – viewmodel poses and part choreography (M5). A six-shot revolver grenade
 * launcher: every shot indexes the drum one chamber (60°, a tween from 0 → 60 – the drum is
 * six-fold symmetric, so the jump back is invisible). Reload is shell by shell: the launcher is
 * lifted and rolled so the loading gate at the drum's rear-left faces the eye, each grenade is
 * pushed into the gate chamber ON its shellIn marker and the drum indexes to the next chamber.
 * Import runtime helpers from '../viewmodelParts' and only TYPES from '../viewmodels'.
 */
import type { PartMotionDef, WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

/** One chamber of drum indexing (the drum's local +Z roll). */
const DRUM_INDEX: PartMotionDef = {
  part: 'drum',
  type: 'tween',
  from: { rot: V(0, 0, 0) },
  pose: { rot: V(0, 0, 60) },
  duration: 0.13,
  ease: 'outBack',
};

export const GRENADELAUNCHER_VIEWMODEL: WeaponViewmodelDef | null = {
  hip: { pos: V(0.135, -0.14, -0.33), rot: V(0, 2, 0) },
  adsEyeDistance: 0.21,
  sprint: { pos: V(-0.035, -0.04, 0.03), rot: V(-14, 32, -24) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.02, -0.12),
  // A heavy, slow thump that rolls the whole launcher back.
  kickSpring: { posStiffness: 230, posDamping: 20, rotStiffness: 170, rotDamping: 16 },
  adsKickScale: 0.5,
  sustained: { perShot: 0.35, decay: 1.4, pose: { pos: V(0, 0.004, 0.012), rot: V(2.4, 0, 0) } },
  heat: { perShot: 0.22, decay: 0.3 },
  fire: [TRIGGER_PULL, { ...DRUM_INDEX, delay: 0.1 }],
  fireLast: [TRIGGER_PULL, { ...DRUM_INDEX, delay: 0.1 }],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-26, 0, 0) }, release: 0.05 }, { ...DRUM_INDEX, duration: 0.1 }],
  fireImpulses: [{ delay: 0.1, pose: { pos: V(0, 0, -0.004), rot: V(0, 0, -1.5) } }],
  lockParts: [],
  reload: {
    style: 'loop',
    // Lifted, muzzle up and rolled right: the drum's rear-left loading gate faces the eye.
    hold: { pos: V(-0.05, 0.06, 0.03), rot: V(14, 18, -36) },
    introTime: 0.3,
    outroTime: 0.28,
  },
  reloadSteps: {
    // The grenade slides into the gate chamber and seats ON the marker, then the drum indexes.
    shellIn: [
      {
        part: 'shells',
        type: 'tween',
        from: { pos: V(-0.02, -0.05, 0.06), rot: V(20, -15, 0) },
        pose: { pos: V(0, 0, -0.07) },
        lead: 0.22,
        duration: 0.24,
        ease: 'inOut',
        show: true,
        hideAtEnd: true,
      },
      { ...DRUM_INDEX, delay: 0.06 },
    ],
    // Closing the gate: a short click of the drum settling on its detent.
    pump: [
      {
        part: 'drum',
        type: 'pulse',
        pose: { rot: V(0, 0, 8) },
        duration: 0.04,
        hold: 0.02,
        release: 0.08,
        ease: 'snap',
      },
    ],
  },
  reloadImpulses: {
    shellIn: [{ delay: 0, pose: { pos: V(0, 0.006, -0.004), rot: V(-2, 0, 1.5) } }],
    pump: [{ delay: 0.02, pose: { pos: V(0, 0, -0.006), rot: V(2, 0, -2) } }],
  },
  accentLight: { pos: V(-0.06, 0.02, -0.1), color: 0xffa21c, intensity: 0.025, distance: 0.26 },
  glow: { accent: 3.1, readout: 2.5, sight: 5, heat: 5 },
};
