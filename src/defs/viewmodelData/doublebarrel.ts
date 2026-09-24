/**
 * DB-2 „Zwilling“ – viewmodel poses and part choreography (M5). Side-by-side break-action shotgun:
 * a hammer falls on every shot; the last one stays down (lock) until the gun is broken open.
 * Reload (both kinds): magOut = top lever swings, barrels drop open on the hinge and the extractor
 * flings both shells out, magIn = two fresh shells pushed into the chambers, boltRelease = the
 * barrels snap shut with a flick of the wrist. Import runtime helpers from '../viewmodelParts' and
 * only TYPES from '../viewmodels'.
 */
import type { PoseKeyDef, ReloadTrackDef, WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

/** Barrels open this far around the hinge pin (deg, muzzle down). */
const BREAK_ANGLE = -34;
const HAMMER_FALL = -48;

const RELOAD_KEYS: readonly PoseKeyDef[] = [
  { t: 0.08, pos: V(-0.03, 0.03, 0.02), rot: V(-6, 12, -20) },
  // Broken open: the stock rises, the open chambers turn towards the eye.
  { t: 0.2, pos: V(-0.045, 0.05, 0.03), rot: V(-12, 18, -30) },
  { t: 0.42, pos: V(-0.048, 0.056, 0.036), rot: V(-15, 20, -32) },
  { t: 0.58, pos: V(-0.05, 0.058, 0.034), rot: V(-13, 20, -33) },
  // Snap shut: the muzzle flicks up.
  { t: 0.74, pos: V(-0.03, 0.03, 0.018), rot: V(-4, 12, -18) },
  { t: 0.8, pos: V(-0.024, 0.026, 0.012), rot: V(5, 9, -12) },
  { t: 0.92, pos: V(-0.008, 0.006, 0.004), rot: V(1, 3, -3) },
];

/** Both reload kinds break the gun open (a tactical reload swaps both shells as well). */
const RELOAD_TRACK: ReloadTrackDef = {
  markers: { magOut: 0.2, magIn: 0.58, boltRelease: 0.78 },
  keys: RELOAD_KEYS,
};

export const DOUBLEBARREL_VIEWMODEL: WeaponViewmodelDef = {
  hip: { pos: V(0.14, -0.16, -0.345), rot: V(0, 2, 0) },
  adsEyeDistance: 0.16,
  sprint: { pos: V(-0.035, -0.04, 0.03), rot: V(-14, 34, -26) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.035, -0.1),
  kickSpring: { posStiffness: 260, posDamping: 22, rotStiffness: 200, rotDamping: 18 },
  adsKickScale: 0.5,
  sustained: { perShot: 0.6, decay: 1.5, pose: { pos: V(0, 0.005, 0.012), rot: V(2.5, 0, 0) } },
  heat: { perShot: 0.42, decay: 0.28 },
  fire: [
    {
      part: 'hammers',
      type: 'pulse',
      pose: { rot: V(HAMMER_FALL, 0, 0) },
      duration: 0.02,
      hold: 0.16,
      release: 0.22,
      ease: 'snap',
      releaseEase: 'inOut',
    },
    { ...TRIGGER_PULL, hold: 0.05 },
  ],
  fireLast: [
    { part: 'hammers', type: 'tween', pose: { rot: V(HAMMER_FALL, 0, 0) }, duration: 0.02, ease: 'snap' },
    { ...TRIGGER_PULL, hold: 0.05 },
  ],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-26, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: ['hammers'],
  reload: { style: 'timeline', tactical: RELOAD_TRACK, empty: RELOAD_TRACK },
  reloadSteps: {
    magOut: [
      {
        part: 'lever',
        type: 'tween',
        pose: { rot: V(0, -38, 0) },
        lead: 0.04,
        duration: 0.06,
        ease: 'out',
      },
      {
        part: 'barrels',
        type: 'tween',
        pose: { rot: V(BREAK_ANGLE, 0, 0) },
        duration: 0.16,
        ease: 'outBack',
      },
      // Opening re-cocks the hammers.
      { part: 'hammers', type: 'tween', pose: {}, delay: 0.03, duration: 0.12, ease: 'inOut' },
      {
        part: 'shells',
        type: 'tween',
        from: {},
        pose: { pos: V(0.01, 0.07, 0.13), rot: V(75, 20, 0) },
        delay: 0.14,
        duration: 0.2,
        ease: 'out',
        show: true,
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'shells',
        type: 'tween',
        from: { pos: V(0.004, 0.018, 0.085), rot: V(12, 0, 0) },
        pose: {},
        lead: 0.15,
        duration: 0.2,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [
      { part: 'barrels', type: 'tween', pose: {}, lead: 0.07, duration: 0.07, ease: 'in' },
      { part: 'lever', type: 'tween', pose: {}, duration: 0.05, ease: 'out' },
    ],
  },
  reloadImpulses: {
    magOut: [
      { delay: 0.02, pose: { pos: V(0, -0.006, 0), rot: V(-4, 0, 2) } },
      { delay: 0.16, pose: { pos: V(0, 0.004, 0.004), rot: V(2, 0, -1) } },
    ],
    magIn: [{ delay: 0.05, pose: { pos: V(0, 0.006, -0.004), rot: V(-2, 0, 1.5) } }],
    boltRelease: [{ delay: 0, pose: { pos: V(0, 0.01, -0.006), rot: V(6, 0, -3) } }],
  },
  accentLight: { pos: V(-0.05, 0.06, -0.12), color: 0x46e6ff, intensity: 0.015, distance: 0.22 },
  glow: { accent: 2.2, readout: 2.4, sight: 5, heat: 5.5 },
};
