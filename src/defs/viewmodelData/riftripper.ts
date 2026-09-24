/**
 * „Riss-Zerreißer“ (wonder weapon) – viewmodel poses and part choreography (M5). An organic
 * rift-tech ray: two mandibles hold a flickering tear in reality open at the front; every shot
 * snaps them apart for a moment. Reload: the spent void shard is plucked out of its cage on the
 * shooter-facing flank, a fresh one slides in, and an empty reload tears the rift open again with
 * a mandible snap. Import runtime helpers from '../viewmodelParts' and only TYPES from '../viewmodels'.
 */
import type { PartMotionDef, WeaponViewmodelDef } from '../viewmodels';
import { TRIGGER_PULL, V } from '../viewmodelParts';

const JAW_OPEN: readonly PartMotionDef[] = [
  {
    part: 'prongL',
    type: 'pulse',
    pose: { rot: V(0, 13, 0) },
    duration: 0.035,
    hold: 0.03,
    release: 0.2,
    ease: 'snap',
    releaseEase: 'inOut',
  },
  {
    part: 'prongR',
    type: 'pulse',
    pose: { rot: V(0, -13, 0) },
    duration: 0.035,
    hold: 0.03,
    release: 0.2,
    ease: 'snap',
    releaseEase: 'inOut',
  },
];

export const RIFTRIPPER_VIEWMODEL: WeaponViewmodelDef | null = {
  hip: { pos: V(0.13, -0.14, -0.32), rot: V(0, 2, 0) },
  adsEyeDistance: 0.2,
  sprint: { pos: V(-0.03, -0.04, 0.03), rot: V(-16, 30, -22) },
  lowered: { pos: V(0.03, -0.24, 0.06), rot: V(-24, -14, 26) },
  pivot: V(0, 0.03, -0.1),
  kickSpring: { posStiffness: 330, posDamping: 25, rotStiffness: 260, rotDamping: 21 },
  adsKickScale: 0.45,
  sustained: { perShot: 0.3, decay: 1.5, pose: { pos: V(0, 0.004, 0.01), rot: V(2, 0, 0) } },
  heat: { perShot: 0.2, decay: 0.3 },
  fire: [
    ...JAW_OPEN,
    {
      part: 'prongs',
      type: 'pulse',
      pose: { pos: V(0, 0, 0.01) },
      duration: 0.02,
      hold: 0.02,
      release: 0.14,
      ease: 'snap',
    },
    { ...TRIGGER_PULL, pose: { rot: V(-20, 0, 0) } },
  ],
  fireLast: [...JAW_OPEN, { ...TRIGGER_PULL, pose: { rot: V(-20, 0, 0) } }],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-24, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: [],
  reload: {
    style: 'timeline',
    // Rolled so the shard cage on the left flank faces the eye.
    tactical: {
      markers: { magOut: 0.25, magIn: 0.65 },
      keys: [
        { t: 0.12, pos: V(-0.035, 0.035, 0.02), rot: V(8, 20, -18) },
        { t: 0.25, pos: V(-0.04, 0.04, 0.024), rot: V(10, 22, -22) },
        { t: 0.47, pos: V(-0.045, 0.028, 0.02), rot: V(5, 24, -24) },
        { t: 0.65, pos: V(-0.045, 0.034, 0.02), rot: V(8, 22, -21) },
        { t: 0.85, pos: V(-0.014, 0.008, 0.006), rot: V(2, 7, -7) },
      ],
    },
    empty: {
      markers: { magOut: 0.19, magIn: 0.52, boltRelease: 0.8 },
      keys: [
        { t: 0.1, pos: V(-0.035, 0.035, 0.02), rot: V(8, 20, -18) },
        { t: 0.19, pos: V(-0.04, 0.04, 0.024), rot: V(10, 22, -22) },
        { t: 0.38, pos: V(-0.045, 0.028, 0.02), rot: V(5, 24, -24) },
        { t: 0.52, pos: V(-0.045, 0.034, 0.02), rot: V(8, 22, -21) },
        // Maw up towards the eye: the mandibles tear the rift open again.
        { t: 0.68, pos: V(-0.03, 0.04, 0.015), rot: V(16, 14, 6) },
        { t: 0.8, pos: V(-0.03, 0.044, 0.016), rot: V(18, 14, 8) },
        { t: 0.93, pos: V(-0.008, 0.008, 0.004), rot: V(4, 3, 2) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'cell',
        type: 'tween',
        pose: { pos: V(-0.06, 0.07, 0.04), rot: V(0, -30, 60) },
        duration: 0.28,
        ease: 'out',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'cell',
        type: 'tween',
        from: { pos: V(-0.05, 0.03, 0.03), rot: V(0, -20, 30) },
        pose: {},
        lead: 0.15,
        duration: 0.2,
        ease: 'inOut',
        show: true,
      },
    ],
    boltRelease: JAW_OPEN.map((m) => ({ ...m, pose: { rot: V(0, (m.pose.rot?.y ?? 0) * 1.6, 0) }, hold: 0.08 })),
  },
  reloadImpulses: {
    magOut: [{ delay: 0.02, pose: { pos: V(0.004, 0.006, 0), rot: V(2, 0, 3) } }],
    magIn: [{ delay: 0.05, pose: { pos: V(0.006, 0.004, 0), rot: V(-2, 0, -4) } }],
    boltRelease: [{ delay: 0.03, pose: { pos: V(0, 0.003, 0.008), rot: V(-2, 0, 0) } }],
  },
  accentLight: { pos: V(0, 0.05, -0.3), color: 0xff3ad8, intensity: 0.04, distance: 0.3 },
  glow: { accent: 2.5, readout: 2.5, sight: 5, heat: 5 },
};
