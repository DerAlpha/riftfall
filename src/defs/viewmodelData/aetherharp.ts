/**
 * „Äther-Harfe“ (wonder weapon) – viewmodel poses and part choreography (M5). An automatic
 * resonance weapon: a golden harp frame on the shooter-facing flank strings six beams of light
 * over a soundboard; every shot plucks them (they shiver – the energy shader's standing wave –
 * and the string bank twitches) while the resonator crystal at the front kicks back. Reload: the
 * tuning cell drops out below, a fresh one goes in, and an empty reload re-tunes the strings with
 * a long shiver. Import runtime helpers from '../viewmodelParts' and only TYPES from '../viewmodels'.
 */
import type { WeaponViewmodelDef } from '../viewmodels';
import { TRIGGER_PULL, V } from '../viewmodelParts';

export const AETHERHARP_VIEWMODEL: WeaponViewmodelDef | null = {
  hip: { pos: V(0.14, -0.15, -0.33), rot: V(0, 2, 0) },
  adsEyeDistance: 0.2,
  sprint: { pos: V(-0.03, -0.04, 0.03), rot: V(-16, 30, -20) },
  lowered: { pos: V(0.04, -0.25, 0.06), rot: V(-22, -12, 26) },
  pivot: V(0, 0.04, -0.12),
  kickSpring: { posStiffness: 460, posDamping: 30, rotStiffness: 380, rotDamping: 27 },
  adsKickScale: 0.4,
  sustained: { perShot: 0.1, decay: 1.8, pose: { pos: V(0, 0.003, 0.008), rot: V(1.6, 0, 0) } },
  heat: { perShot: 0.06, decay: 0.25 },
  fire: [
    {
      part: 'strings',
      type: 'pulse',
      pose: { pos: V(0.0016, 0, 0) },
      duration: 0.012,
      hold: 0.004,
      release: 0.05,
      ease: 'snap',
      releaseEase: 'outBack',
    },
    {
      part: 'resonator',
      type: 'pulse',
      pose: { pos: V(0, 0, 0.01) },
      duration: 0.015,
      hold: 0.006,
      release: 0.08,
      ease: 'snap',
      releaseEase: 'in',
    },
    { ...TRIGGER_PULL, pose: { rot: V(-14, 0, 0) }, hold: 0.015, release: 0.04 },
  ],
  fireLast: [
    {
      part: 'strings',
      type: 'pulse',
      pose: { pos: V(0.0016, 0, 0) },
      duration: 0.012,
      hold: 0.004,
      release: 0.05,
      ease: 'snap',
      releaseEase: 'outBack',
    },
    { ...TRIGGER_PULL, pose: { rot: V(-14, 0, 0) } },
  ],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-18, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: [],
  reload: {
    style: 'timeline',
    tactical: {
      markers: { magOut: 0.23, magIn: 0.64 },
      keys: [
        { t: 0.12, pos: V(-0.03, 0.028, 0.03), rot: V(12, 14, -28) },
        { t: 0.23, pos: V(-0.034, 0.034, 0.034), rot: V(15, 16, -33) },
        { t: 0.45, pos: V(-0.04, 0.018, 0.03), rot: V(8, 18, -34) },
        { t: 0.64, pos: V(-0.04, 0.026, 0.03), rot: V(11, 16, -30) },
        { t: 0.84, pos: V(-0.014, 0.006, 0.01), rot: V(3, 6, -10) },
      ],
    },
    empty: {
      markers: { magOut: 0.17, magIn: 0.5, boltRelease: 0.78 },
      keys: [
        { t: 0.1, pos: V(-0.03, 0.028, 0.03), rot: V(12, 14, -28) },
        { t: 0.17, pos: V(-0.034, 0.034, 0.034), rot: V(15, 16, -33) },
        { t: 0.36, pos: V(-0.04, 0.018, 0.03), rot: V(8, 18, -34) },
        { t: 0.5, pos: V(-0.04, 0.026, 0.03), rot: V(11, 16, -30) },
        // The harp side turns up towards the eye while the strings are re-tuned.
        { t: 0.66, pos: V(-0.035, 0.034, 0.02), rot: V(8, 20, -24) },
        { t: 0.78, pos: V(-0.035, 0.036, 0.02), rot: V(9, 20, -26) },
        { t: 0.92, pos: V(-0.01, 0.008, 0.004), rot: V(2, 5, -6) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'cell',
        type: 'tween',
        pose: { pos: V(0, -0.2, 0.02), rot: V(-14, 0, 10) },
        duration: 0.24,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'cell',
        type: 'tween',
        from: { pos: V(0, -0.13, 0.012), rot: V(-10, 0, 0) },
        pose: {},
        lead: 0.13,
        duration: 0.18,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [
      {
        part: 'strings',
        type: 'pulse',
        pose: { pos: V(0.0022, 0, 0) },
        duration: 0.02,
        hold: 0.12,
        release: 0.25,
        ease: 'snap',
        releaseEase: 'outBack',
      },
      {
        part: 'resonator',
        type: 'tween',
        from: { rot: V(0, 0, 0) },
        pose: { rot: V(0, 0, 180) },
        duration: 0.35,
        ease: 'inOut',
      },
    ],
  },
  reloadImpulses: {
    magOut: [{ delay: 0, pose: { pos: V(0, 0.008, 0), rot: V(3, 0, -2) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0, 0.012, 0), rot: V(-4, 0, 3) } }],
    boltRelease: [{ delay: 0.02, pose: { pos: V(0.003, 0.002, 0), rot: V(0, 0, -2) } }],
  },
  accentLight: { pos: V(-0.05, 0.1, -0.14), color: 0xffcf7a, intensity: 0.035, distance: 0.3 },
  glow: { accent: 2.4, readout: 2.5, sight: 5, heat: 5 },
};
