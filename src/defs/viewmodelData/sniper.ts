/**
 * HX-50 „Richtfeuer“ – viewmodel poses and part choreography (M5). Bolt-action anti-materiel rifle
 * (fireMode 'pump': one bolt cycle per shot). After the shot the gun rocks back, then the bolt
 * handle lifts, the bolt runs back and slams home, the handle drops – all after `BOLT_CYCLE_DELAY`,
 * so the cycle reads after the recoil settled. The last round leaves the bolt open; the empty
 * reload closes it. Import runtime helpers from '../viewmodelParts' and only TYPES from '../viewmodels'.
 */
import type { PartMotionDef, WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

/** Seconds after the shot the bolt cycle starts (recoil peak + settle). */
export const BOLT_CYCLE_DELAY = 0.3;
/** Handle lift / bolt stroke / stop / return phases (s). */
const LIFT = 0.06;
const STROKE = 0.08;
const STOP = 0.03;
const HANDLE_LIFT_DEG = 62;
const BOLT_TRAVEL = 0.1;

const HANDLE_UP: PartMotionDef = {
  part: 'boltHandle',
  type: 'pulse',
  pose: { rot: V(0, 0, HANDLE_LIFT_DEG) },
  delay: BOLT_CYCLE_DELAY,
  duration: LIFT,
  hold: STROKE + STOP + STROKE,
  release: LIFT,
  ease: 'out',
  releaseEase: 'in',
};

const BOLT_STROKE: PartMotionDef = {
  part: 'bolt',
  type: 'pulse',
  pose: { pos: V(0, 0, BOLT_TRAVEL) },
  delay: BOLT_CYCLE_DELAY + LIFT,
  duration: STROKE,
  hold: STOP,
  release: STROKE,
  ease: 'inOut',
  releaseEase: 'in',
};

export const SNIPER_VIEWMODEL: WeaponViewmodelDef = {
  hip: { pos: V(0.14, -0.172, -0.37), rot: V(0, 2, 0) },
  // The eye sits right behind the eyecup: the ocular fills the view (a real scope picture).
  adsEyeDistance: 0.042,
  sprint: { pos: V(-0.035, -0.045, 0.035), rot: V(-12, 32, -24) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.035, -0.12),
  // Big, slow, heavy kick.
  kickSpring: { posStiffness: 230, posDamping: 19, rotStiffness: 180, rotDamping: 16 },
  adsKickScale: 0.3,
  sustained: { perShot: 0.5, decay: 1.1, pose: { pos: V(0, 0.004, 0.012), rot: V(2, 0, 0) } },
  heat: { perShot: 0.34, decay: 0.12 },
  fire: [{ ...TRIGGER_PULL, hold: 0.05, release: 0.1 }, HANDLE_UP, BOLT_STROKE],
  // Last round: the bolt is run back and left open (lock parts).
  fireLast: [
    { ...TRIGGER_PULL, hold: 0.05, release: 0.1 },
    {
      part: 'boltHandle',
      type: 'tween',
      pose: { rot: V(0, 0, HANDLE_LIFT_DEG) },
      delay: BOLT_CYCLE_DELAY,
      duration: LIFT,
      ease: 'out',
    },
    {
      part: 'bolt',
      type: 'tween',
      pose: { pos: V(0, 0, BOLT_TRAVEL) },
      delay: BOLT_CYCLE_DELAY + LIFT,
      duration: STROKE,
      ease: 'inOut',
    },
  ],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-24, 0, 0) }, release: 0.05 }],
  // The pull rocks the gun back and rolls it towards the handle, the push drives it forward.
  fireImpulses: [
    { delay: BOLT_CYCLE_DELAY + LIFT * 0.5, pose: { pos: V(0, 0.002, 0), rot: V(0, 0, -2.5) } },
    { delay: BOLT_CYCLE_DELAY + LIFT + STROKE, pose: { pos: V(0, 0, 0.01), rot: V(-2, 0.6, -1.5) } },
    {
      delay: BOLT_CYCLE_DELAY + LIFT + STROKE * 2 + STOP,
      pose: { pos: V(0, 0, -0.008), rot: V(1.6, 0, 1.2) },
    },
  ],
  lockParts: ['bolt', 'boltHandle'],
  reload: {
    style: 'timeline',
    // Magwell in front of the trigger: lifted, pulled in and rolled so it faces the shooter.
    tactical: {
      markers: { magOut: 0.25, magIn: 0.66 },
      keys: [
        { t: 0.13, pos: V(-0.035, 0.03, 0.035), rot: V(12, 16, -30) },
        { t: 0.25, pos: V(-0.038, 0.036, 0.04), rot: V(15, 18, -35) },
        { t: 0.46, pos: V(-0.045, 0.018, 0.035), rot: V(8, 20, -36) },
        { t: 0.66, pos: V(-0.045, 0.026, 0.035), rot: V(11, 18, -32) },
        { t: 0.85, pos: V(-0.015, 0.006, 0.012), rot: V(3, 6, -10) },
      ],
    },
    // Bolt open from the last shot: magazine swap, then rolled over (top towards the eye) so the
    // right-hand bolt is driven home in view.
    empty: {
      markers: { magOut: 0.2, magIn: 0.55, boltRelease: 0.8 },
      keys: [
        { t: 0.11, pos: V(-0.035, 0.03, 0.035), rot: V(12, 16, -30) },
        { t: 0.2, pos: V(-0.038, 0.036, 0.04), rot: V(15, 18, -35) },
        { t: 0.4, pos: V(-0.045, 0.018, 0.035), rot: V(8, 20, -36) },
        { t: 0.55, pos: V(-0.045, 0.026, 0.035), rot: V(11, 18, -32) },
        { t: 0.68, pos: V(-0.06, 0.03, 0.02), rot: V(6, 12, 30) },
        { t: 0.8, pos: V(-0.06, 0.034, 0.024), rot: V(8, 12, 34) },
        { t: 0.93, pos: V(-0.016, 0.008, 0.006), rot: V(2, 4, 8) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'magazine',
        type: 'tween',
        pose: { pos: V(0, -0.18, -0.02), rot: V(14, 0, -10) },
        duration: 0.22,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'magazine',
        type: 'tween',
        from: { pos: V(0, -0.12, -0.016), rot: V(10, 0, 0) },
        pose: {},
        lead: 0.13,
        duration: 0.185,
        ease: 'inOut',
        show: true,
      },
    ],
    // Bolt forward ON the marker, the handle drops a beat later (two clacks).
    boltRelease: [
      { part: 'bolt', type: 'tween', pose: {}, lead: 0.07, duration: 0.07, ease: 'in' },
      { part: 'boltHandle', type: 'tween', pose: {}, delay: 0.06, duration: 0.06, ease: 'in' },
    ],
  },
  reloadImpulses: {
    magOut: [{ delay: 0, pose: { pos: V(0, 0.008, 0), rot: V(3, 0, -2) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0, 0.013, 0), rot: V(-4.5, 0, 3) } }],
    boltRelease: [
      { delay: 0, pose: { pos: V(0, 0, -0.01), rot: V(2.5, 0, -2) } },
      { delay: 0.1, pose: { pos: V(0, -0.004, 0), rot: V(-1.5, 0, 2.5) } },
    ],
  },
  accentLight: { pos: V(-0.05, 0.12, -0.1), color: 0x46e6ff, intensity: 0.015, distance: 0.24 },
  glow: { accent: 2.2, readout: 2.4, sight: 7, heat: 5 },
};
