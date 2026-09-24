/**
 * DM-8 „Falke“ – viewmodel poses and part choreography (M5). Sleek semi-auto marksman rifle with a
 * compact 2.5× prism optic: a crisp, fast-settling kick; the bolt carrier flashes in the ejection
 * port and the dust cover pops open on the first shot. Empty reloads end with a slap on the bolt
 * catch (left side, in view). Import runtime helpers from '../viewmodelParts' and only TYPES from
 * '../viewmodels' (runtime cycle otherwise).
 */
import type { WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

const CARRIER_TRAVEL = 0.042;

export const MARKSMAN_VIEWMODEL: WeaponViewmodelDef = {
  hip: { pos: V(0.135, -0.16, -0.36), rot: V(0, 2, 0) },
  // Eye relief of a prism scope: the ocular sits a hand's width in front of the eye.
  adsEyeDistance: 0.085,
  sprint: { pos: V(-0.035, -0.037, 0.03), rot: V(-12, 34, -24) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.03, -0.11),
  kickSpring: { posStiffness: 470, posDamping: 30, rotStiffness: 380, rotDamping: 27 },
  adsKickScale: 0.36,
  sustained: { perShot: 0.22, decay: 2, pose: { pos: V(0, 0.003, 0.01), rot: V(2, 0, 0) } },
  heat: { perShot: 0.08, decay: 0.2 },
  fire: [
    {
      part: 'bolt',
      type: 'pulse',
      pose: { pos: V(0, 0, CARRIER_TRAVEL) },
      duration: 0.02,
      hold: 0.005,
      release: 0.05,
      ease: 'snap',
      releaseEase: 'in',
    },
    { part: 'dustCover', type: 'tween', pose: { rot: V(0, 0, -115) }, duration: 0.07, ease: 'outBack' },
    { ...TRIGGER_PULL, pose: { rot: V(-15, 0, 0) }, hold: 0.02, release: 0.05 },
  ],
  fireLast: [
    { part: 'bolt', type: 'tween', pose: { pos: V(0, 0, CARRIER_TRAVEL) }, duration: 0.02, ease: 'snap' },
    { part: 'dustCover', type: 'tween', pose: { rot: V(0, 0, -115) }, duration: 0.07, ease: 'outBack' },
    { ...TRIGGER_PULL, pose: { rot: V(-15, 0, 0) } },
  ],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-19, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: ['bolt'],
  reload: {
    style: 'timeline',
    tactical: {
      markers: { magOut: 0.23, magIn: 0.66 },
      keys: [
        { t: 0.13, pos: V(-0.03, 0.02, 0.03), rot: V(10, 14, -28) },
        { t: 0.23, pos: V(-0.033, 0.026, 0.036), rot: V(13, 16, -33) },
        { t: 0.46, pos: V(-0.04, 0.008, 0.03), rot: V(6, 18, -34) },
        { t: 0.66, pos: V(-0.04, 0.016, 0.03), rot: V(9, 16, -30) },
        { t: 0.84, pos: V(-0.014, 0.005, 0.01), rot: V(3, 6, -10) },
      ],
    },
    empty: {
      markers: { magOut: 0.18, magIn: 0.52, boltRelease: 0.78 },
      keys: [
        { t: 0.1, pos: V(-0.03, 0.02, 0.03), rot: V(10, 14, -28) },
        { t: 0.18, pos: V(-0.033, 0.026, 0.036), rot: V(13, 16, -33) },
        { t: 0.38, pos: V(-0.04, 0.008, 0.03), rot: V(6, 18, -34) },
        { t: 0.52, pos: V(-0.04, 0.016, 0.03), rot: V(9, 16, -30) },
        // Left flank to the eye: the palm slaps the bolt catch.
        { t: 0.66, pos: V(-0.045, 0.018, 0.012), rot: V(4, 26, 12) },
        { t: 0.78, pos: V(-0.045, 0.022, 0.014), rot: V(6, 26, 15) },
        { t: 0.92, pos: V(-0.013, 0.006, 0.004), rot: V(2, 7, 4) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'magazine',
        type: 'tween',
        pose: { pos: V(0, -0.2, -0.025), rot: V(15, 0, -8) },
        duration: 0.22,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'magazine',
        type: 'tween',
        from: { pos: V(0, -0.13, -0.018), rot: V(11, 0, 0) },
        pose: {},
        lead: 0.12,
        duration: 0.175,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [
      {
        part: 'boltCatch',
        type: 'pulse',
        pose: { rot: V(-18, 0, 0) },
        lead: 0.03,
        duration: 0.03,
        hold: 0.03,
        release: 0.08,
        ease: 'out',
      },
      { part: 'bolt', type: 'tween', pose: {}, duration: 0.035, ease: 'in' },
    ],
  },
  reloadImpulses: {
    magOut: [{ delay: 0, pose: { pos: V(0, 0.008, 0), rot: V(3, 0, -2) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0, 0.012, 0), rot: V(-4, 0, 3) } }],
    boltRelease: [
      { delay: 0, pose: { pos: V(0.004, 0, 0), rot: V(0, -1.5, 3) } },
      { delay: 0.035, pose: { pos: V(0, 0, -0.009), rot: V(2.5, 0, -2) } },
    ],
  },
  accentLight: { pos: V(-0.05, 0.08, -0.25), color: 0x46e6ff, intensity: 0.015, distance: 0.22 },
  // The chevron reticle and the fibre on top glow amber.
  glow: { accent: 2.2, readout: 2.4, sight: 4.5, heat: 5 },
};
