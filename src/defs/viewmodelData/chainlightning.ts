/**
 * EX-1 „Kettenblitz“ – viewmodel poses and part choreography (M5). A beam weapon: while it fires
 * the copper rotor spins up and the three emitter prongs claw open around the arc (beam drivers).
 * Reload: the Leyden-jar cell drops out of the magwell, a fresh one is pushed in, and on an empty
 * reload the rotor is cranked a quarter turn while the prongs snap once.
 * Import runtime helpers from '../viewmodelParts' and only TYPES from '../viewmodels'.
 */
import type { PartMotionDef, WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

/** Prong open/close (in each prong's own frame: +X swings the tip radially outward). */
const PRONG_SNAP: readonly PartMotionDef[] = (['prongA', 'prongB', 'prongC'] as const).map((part) => ({
  part,
  type: 'pulse',
  pose: { rot: V(16, 0, 0) },
  duration: 0.05,
  hold: 0.05,
  release: 0.09,
  ease: 'out',
  releaseEase: 'in',
}));

export const CHAINLIGHTNING_VIEWMODEL: WeaponViewmodelDef | null = {
  hip: { pos: V(0.13, -0.15, -0.33), rot: V(0, 2, 0) },
  adsEyeDistance: 0.2,
  sprint: { pos: V(-0.03, -0.04, 0.03), rot: V(-13, 32, -22) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.035, -0.09),
  kickSpring: { posStiffness: 420, posDamping: 30, rotStiffness: 340, rotDamping: 26 },
  adsKickScale: 0.4,
  sustained: { perShot: 0.05, decay: 1.4, pose: { pos: V(0, 0.003, 0.008), rot: V(1.2, 0, 0) } },
  heat: { perShot: 0.03, decay: 0.2 },
  fire: [{ ...TRIGGER_PULL, pose: { rot: V(-16, 0, 0) } }],
  fireLast: [{ ...TRIGGER_PULL, pose: { rot: V(-16, 0, 0) } }],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-20, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: [],
  reload: {
    style: 'timeline',
    tactical: {
      markers: { magOut: 0.23, magIn: 0.64 },
      keys: [
        { t: 0.12, pos: V(-0.03, 0.028, 0.03), rot: V(12, 14, -30) },
        { t: 0.23, pos: V(-0.034, 0.034, 0.034), rot: V(15, 16, -35) },
        { t: 0.45, pos: V(-0.04, 0.018, 0.03), rot: V(8, 18, -36) },
        { t: 0.64, pos: V(-0.04, 0.026, 0.03), rot: V(11, 16, -32) },
        { t: 0.84, pos: V(-0.014, 0.006, 0.01), rot: V(3, 6, -10) },
      ],
    },
    empty: {
      markers: { magOut: 0.17, magIn: 0.5, boltRelease: 0.78 },
      keys: [
        { t: 0.1, pos: V(-0.03, 0.028, 0.03), rot: V(12, 14, -30) },
        { t: 0.17, pos: V(-0.034, 0.034, 0.034), rot: V(15, 16, -35) },
        { t: 0.36, pos: V(-0.04, 0.018, 0.03), rot: V(8, 18, -36) },
        { t: 0.5, pos: V(-0.04, 0.026, 0.03), rot: V(11, 16, -32) },
        // Muzzle up and towards the eye: the rotor crank and the prong snap play in view.
        { t: 0.66, pos: V(-0.035, 0.036, 0.02), rot: V(16, 18, 10) },
        { t: 0.78, pos: V(-0.035, 0.04, 0.02), rot: V(18, 18, 12) },
        { t: 0.92, pos: V(-0.01, 0.008, 0.004), rot: V(4, 4, 3) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'cell',
        type: 'tween',
        pose: { pos: V(0, -0.2, -0.03), rot: V(18, 0, -8) },
        duration: 0.24,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'cell',
        type: 'tween',
        from: { pos: V(0, -0.13, -0.02), rot: V(12, 0, 0) },
        pose: {},
        lead: 0.13,
        duration: 0.18,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [
      // A quarter crank of the four-fin rotor (symmetric: the jump back to 0 is invisible).
      {
        part: 'coils',
        type: 'tween',
        from: { rot: V(0, 0, 0) },
        pose: { rot: V(0, 0, -90) },
        duration: 0.16,
        ease: 'outBack',
      },
      ...PRONG_SNAP.map((m) => ({ ...m, delay: 0.1 })),
    ],
  },
  reloadImpulses: {
    magOut: [{ delay: 0, pose: { pos: V(0, 0.008, 0), rot: V(3, 0, -2) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0, 0.012, 0), rot: V(-4, 0, 3) } }],
    boltRelease: [
      { delay: 0.02, pose: { pos: V(0.004, 0, 0), rot: V(0, 0, -4) } },
      { delay: 0.12, pose: { pos: V(0, 0.004, -0.006), rot: V(2, 0, 2) } },
    ],
  },
  accentLight: { pos: V(0, 0.05, -0.33), color: 0x6f9dff, intensity: 0.035, distance: 0.3 },
  glow: { accent: 4.2, readout: 2.5, sight: 5, heat: 5 },
  drivers: [
    // Beam on: the rotor whirls up, the prongs claw open around the arc, everything burns brighter.
    { part: 'coils', source: 'beam', spin: { axis: 'z', degPerSec: 1080 }, accentBoost: 4, response: 5 },
    { part: 'prongA', source: 'beam', pose: { rot: V(14, 0, 0) }, accentBoost: 0.5, response: 14 },
    { part: 'prongB', source: 'beam', pose: { rot: V(14, 0, 0) }, accentBoost: 0.5, response: 14 },
    { part: 'prongC', source: 'beam', pose: { rot: V(14, 0, 0) }, accentBoost: 0.5, response: 14 },
  ],
};
