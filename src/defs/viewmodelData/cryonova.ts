/**
 * „Kryo-Nova“ (wonder weapon) – viewmodel poses and part choreography (M5). A slow cryo cannon: a
 * star of ice crystals glows in front of the emitter (it shatters on every shot and grows back –
 * the model animates that) inside a ring of frosted radiator fins that slam back per shot.
 * Reload: the cryo canister is pulled out of its frosted cradle on the shooter-facing flank, a
 * fresh one is pushed in, and an empty reload vents the fins with a frost flash.
 * Import runtime helpers from '../viewmodelParts' and only TYPES from '../viewmodels'.
 */
import type { WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

export const CRYONOVA_VIEWMODEL: WeaponViewmodelDef | null = {
  hip: { pos: V(0.135, -0.145, -0.33), rot: V(0, 2, 0) },
  adsEyeDistance: 0.21,
  sprint: { pos: V(-0.035, -0.04, 0.03), rot: V(-14, 32, -24) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.04, -0.12),
  kickSpring: { posStiffness: 220, posDamping: 19, rotStiffness: 170, rotDamping: 16 },
  adsKickScale: 0.5,
  sustained: { perShot: 0.45, decay: 1.2, pose: { pos: V(0, 0.004, 0.012), rot: V(2.6, 0, 0) } },
  heat: { perShot: 0.3, decay: 0.3 },
  fire: [
    {
      part: 'fins',
      type: 'pulse',
      pose: { pos: V(0, 0, 0.014) },
      duration: 0.03,
      hold: 0.02,
      release: 0.3,
      ease: 'snap',
      releaseEase: 'inOut',
    },
    { ...TRIGGER_PULL, pose: { rot: V(-20, 0, 0) }, hold: 0.05, release: 0.1 },
  ],
  fireLast: [
    {
      part: 'fins',
      type: 'pulse',
      pose: { pos: V(0, 0, 0.014) },
      duration: 0.03,
      hold: 0.02,
      release: 0.3,
      ease: 'snap',
      releaseEase: 'inOut',
    },
    { ...TRIGGER_PULL, pose: { rot: V(-20, 0, 0) }, hold: 0.05, release: 0.1 },
  ],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-24, 0, 0) }, release: 0.05 }],
  fireImpulses: [{ delay: 0.1, pose: { pos: V(0, 0.002, -0.006), rot: V(1.2, 0, -1) } }],
  lockParts: [],
  reload: {
    style: 'timeline',
    // Rolled so the canister cradle on the left flank faces the eye.
    tactical: {
      markers: { magOut: 0.25, magIn: 0.66 },
      keys: [
        { t: 0.12, pos: V(-0.035, 0.035, 0.02), rot: V(8, 20, -16) },
        { t: 0.25, pos: V(-0.04, 0.04, 0.024), rot: V(10, 22, -20) },
        { t: 0.47, pos: V(-0.045, 0.028, 0.02), rot: V(5, 24, -22) },
        { t: 0.66, pos: V(-0.045, 0.034, 0.02), rot: V(8, 22, -19) },
        { t: 0.86, pos: V(-0.014, 0.008, 0.006), rot: V(2, 7, -6) },
      ],
    },
    empty: {
      markers: { magOut: 0.19, magIn: 0.52, boltRelease: 0.8 },
      keys: [
        { t: 0.1, pos: V(-0.035, 0.035, 0.02), rot: V(8, 20, -16) },
        { t: 0.19, pos: V(-0.04, 0.04, 0.024), rot: V(10, 22, -20) },
        { t: 0.38, pos: V(-0.045, 0.028, 0.02), rot: V(5, 24, -22) },
        { t: 0.52, pos: V(-0.045, 0.034, 0.02), rot: V(8, 22, -19) },
        // Emitter up towards the eye: the fins vent a frost flash.
        { t: 0.68, pos: V(-0.03, 0.04, 0.015), rot: V(15, 14, 4) },
        { t: 0.8, pos: V(-0.03, 0.044, 0.016), rot: V(17, 14, 6) },
        { t: 0.93, pos: V(-0.008, 0.008, 0.004), rot: V(4, 3, 1) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'canister',
        type: 'tween',
        pose: { pos: V(-0.03, 0.08, 0.1), rot: V(30, -10, 20) },
        duration: 0.28,
        ease: 'out',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'canister',
        type: 'tween',
        from: { pos: V(-0.02, 0.04, 0.07), rot: V(18, -6, 10) },
        pose: {},
        lead: 0.15,
        duration: 0.2,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: [
      {
        part: 'fins',
        type: 'pulse',
        pose: { pos: V(0, 0, 0.01), rot: V(0, 0, 22.5) },
        duration: 0.06,
        hold: 0.08,
        release: 0.25,
        ease: 'outBack',
        releaseEase: 'inOut',
      },
    ],
  },
  reloadImpulses: {
    magOut: [{ delay: 0.02, pose: { pos: V(0.004, 0.006, 0), rot: V(2, 0, 3) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0.006, 0.004, 0), rot: V(-2, 0, -4) } }],
    boltRelease: [{ delay: 0.03, pose: { pos: V(0, -0.003, 0.008), rot: V(-2, 0, 0) } }],
  },
  accentLight: { pos: V(0, 0.05, -0.31), color: 0x8fe4ff, intensity: 0.04, distance: 0.3 },
  glow: { accent: 2.4, readout: 2.5, sight: 5, heat: 5 },
};
