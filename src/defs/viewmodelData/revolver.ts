/**
 * RM-44 „Richter“ – viewmodel poses and part choreography (M5). Import runtime helpers from
 * '../viewmodelParts' and only TYPES from '../viewmodels' (runtime cycle otherwise).
 *
 * A heavy hex-cylinder revolver: every shot drops the hammer and indexes the cylinder 60° (the
 * cylinder, its rounds and ejector star are 60°-symmetric, so each tween restarts from 0 unseen).
 * Reload (magOut / magIn / boltRelease, same markers for tactical and empty): the crane swings the
 * cylinder out to the left, muzzle up – the ejector punches the six rounds out the back – muzzle
 * down, a speedloader seats six fresh rounds and pulls away, then a wrist flick snaps the crane
 * shut on the boltRelease marker.
 */
import type { PartMotionDef, PoseKeyDef, ReloadTrackDef, WeaponViewmodelDef } from '../viewmodels';
import { TRIGGER_PULL, V } from '../viewmodelParts';

/** The hammer snaps back to full cock at the shot and falls (the strike reads with the flash). */
const HAMMER_FALL: PartMotionDef = {
  part: 'hammer',
  type: 'pulse',
  pose: { rot: V(40, 0, 0) },
  duration: 0.004,
  hold: 0.014,
  release: 0.05,
  ease: 'linear',
  releaseEase: 'in',
};

/** Index the next chamber once the hammer has fallen (60° – restarting from 0 is invisible). */
const CYLINDER_INDEX: PartMotionDef = {
  part: 'cylinder',
  type: 'tween',
  from: {},
  pose: { rot: V(0, 0, -60) },
  delay: 0.07,
  duration: 0.11,
  ease: 'inOut',
};

const TRIGGER: PartMotionDef = { ...TRIGGER_PULL, pose: { rot: V(-26, 0, 0) }, hold: 0.06, release: 0.09 };

/**
 * Lift to the center and roll left (crane out), muzzle up to dump the rounds, muzzle down to load,
 * then the flick back to the right that shuts the crane on the boltRelease marker.
 */
const RELOAD_KEYS: readonly PoseKeyDef[] = [
  { t: 0.1, pos: V(-0.04, 0.05, -0.01), rot: V(6, 10, 30) },
  { t: 0.19, pos: V(-0.045, 0.056, -0.012), rot: V(9, 12, 38) },
  { t: 0.29, pos: V(-0.04, 0.05, 0.004), rot: V(40, 10, 30) },
  { t: 0.37, pos: V(-0.04, 0.052, 0.004), rot: V(44, 10, 28) },
  { t: 0.47, pos: V(-0.05, 0.058, -0.02), rot: V(-18, 14, 44) },
  { t: 0.595, pos: V(-0.05, 0.06, -0.022), rot: V(-15, 14, 42) },
  { t: 0.71, pos: V(-0.046, 0.056, -0.016), rot: V(-6, 12, 44) },
  { t: 0.81, pos: V(-0.028, 0.03, -0.008), rot: V(3, 7, 2) },
  { t: 0.92, pos: V(-0.008, 0.008, 0), rot: V(1, 2, 0.5) },
];
const RELOAD_TRACK: ReloadTrackDef = {
  markers: { magOut: 0.19, magIn: 0.595, boltRelease: 0.81 },
  keys: RELOAD_KEYS,
};

/** Speedloader approach (its local frame = the swung-out cylinder axis): from behind, twisted. */
const LOADER_FROM = { pos: V(0.004, -0.008, 0.1), rot: V(0, 0, -24) } as const;

export const REVOLVER_VIEWMODEL: WeaponViewmodelDef = {
  hip: { pos: V(0.13, -0.13, -0.33), rot: V(0, 3, 0) },
  adsEyeDistance: 0.23,
  sprint: { pos: V(-0.01, -0.04, 0.03), rot: V(-34, 14, -12) },
  // Close to the hand: the heavy round flips the muzzle up around the wrist.
  pivot: V(0, 0.006, 0.0),
  kickSpring: { posStiffness: 290, posDamping: 19, rotStiffness: 220, rotDamping: 15.5 },
  adsKickScale: 0.42,
  sustained: { perShot: 0.36, decay: 1.8, pose: { pos: V(0, 0.004, 0.008), rot: V(2.4, 0, 0) } },
  heat: { perShot: 0.2, decay: 0.32 },
  fire: [HAMMER_FALL, CYLINDER_INDEX, TRIGGER],
  fireLast: [HAMMER_FALL, CYLINDER_INDEX, TRIGGER],
  // An empty chamber: the action still cycles – click.
  dryFire: [{ ...TRIGGER, release: 0.06 }, HAMMER_FALL, CYLINDER_INDEX],
  fireImpulses: [],
  lockParts: [],
  reload: { style: 'timeline', tactical: RELOAD_TRACK, empty: RELOAD_TRACK },
  reloadSteps: {
    magOut: [
      { part: 'crane', type: 'tween', pose: { rot: V(0, 0, 95) }, lead: 0.03, duration: 0.2, ease: 'outBack' },
      {
        part: 'ejector',
        type: 'pulse',
        pose: { pos: V(0, 0, 0.022) },
        delay: 0.24,
        duration: 0.07,
        hold: 0.08,
        release: 0.14,
        ease: 'out',
        releaseEase: 'inOut',
      },
      // Punched out with the star, then falling out of the upturned cylinder.
      {
        part: 'rounds',
        type: 'pulse',
        pose: { pos: V(0, 0, 0.022) },
        delay: 0.24,
        duration: 0.07,
        hold: 0.29,
        release: 0,
        ease: 'out',
        hideAtEnd: true,
      },
      {
        part: 'rounds',
        type: 'tween',
        pose: { pos: V(0, 0, 0.15), rot: V(0, 0, 25) },
        delay: 0.3,
        duration: 0.3,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    // Loader and rounds travel as one and seat 10 ms after the marker click; the loader twists off.
    magIn: [
      {
        part: 'speedloader',
        type: 'tween',
        from: LOADER_FROM,
        pose: {},
        lead: 0.17,
        duration: 0.18,
        ease: 'out',
        show: true,
      },
      {
        part: 'rounds',
        type: 'tween',
        from: LOADER_FROM,
        pose: {},
        lead: 0.17,
        duration: 0.18,
        ease: 'out',
        show: true,
      },
      {
        part: 'speedloader',
        type: 'pulse',
        pose: { pos: V(0, 0.006, 0.09), rot: V(0, 0, 35) },
        delay: 0.12,
        duration: 0.15,
        hold: 0,
        release: 0,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    boltRelease: [{ part: 'crane', type: 'tween', pose: {}, lead: 0.06, duration: 0.065, ease: 'in' }],
  },
  reloadImpulses: {
    magOut: [{ delay: 0.03, pose: { pos: V(0, 0.004, 0), rot: V(2, 0, 3) } }],
    magIn: [{ delay: 0.01, pose: { pos: V(0, 0.008, -0.004), rot: V(-3, 0, 1.5) } }],
    boltRelease: [{ delay: 0, pose: { pos: V(0.008, 0.002, 0), rot: V(1, -2, -6) } }],
  },
  accentLight: { pos: V(-0.03, 0.045, -0.06), color: 0x46e6ff, intensity: 0.014, distance: 0.2 },
  glow: { accent: 2.4, readout: 2.4, sight: 3.5, heat: 5 },
};
