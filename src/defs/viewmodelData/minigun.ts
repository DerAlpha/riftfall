/**
 * RX-6 „Kreissäge“ – viewmodel poses and part choreography (M5). Handheld rotary cannon: the barrel
 * cluster spins with the weapon's spin-up (`weapon:spin` → spin driver, eased), the motor coils
 * flare with it (accent boost), the barrels glow with sustained heat and the whole gun shoves back
 * while firing (sustained drift). Reload: the ammo box drops out, a fresh one clicks in, the feed
 * chute is pressed home and (empty) the motor lever is primed. Import runtime helpers from '../viewmodelParts'
 * and only TYPES from '../viewmodels'.
 */
import type { WeaponViewmodelDef } from '../viewmodels';
import { TRIGGER_PULL, V } from '../viewmodelParts';

/**
 * Visual barrel speed at full spin (deg/s). Deliberately below the real ~2400°/s: at 60 fps a step of
 * ~25° reads as forward rotation of the six-barrel cluster (and of its single marked barrel) instead
 * of strobing backwards.
 */
export const MINIGUN_SPIN_DEG_PER_SEC = 1500;

export const MINIGUN_VIEWMODEL: WeaponViewmodelDef = {
  // Carried low at the hip.
  hip: { pos: V(0.15, -0.192, -0.37), rot: V(0, 3, 0) },
  adsEyeDistance: 0.2,
  sprint: { pos: V(-0.03, -0.035, 0.03), rot: V(-10, 24, -18) },
  lowered: { pos: V(0.05, -0.27, 0.07), rot: V(-16, -12, 24) },
  pivot: V(0, 0.04, -0.06),
  kickSpring: { posStiffness: 640, posDamping: 38, rotStiffness: 520, rotDamping: 34 },
  adsKickScale: 0.5,
  // Held fire shoves the gun back and up and keeps it there, shuddering.
  sustained: { perShot: 0.018, decay: 1.3, pose: { pos: V(0.002, 0.006, 0.018), rot: V(2, -0.6, 1) } },
  heat: { perShot: 0.009, decay: 0.12 },
  fire: [{ ...TRIGGER_PULL, pose: { rot: V(-16, 0, 0) }, hold: 0.06, release: 0.08 }],
  fireLast: [{ ...TRIGGER_PULL, pose: { rot: V(-16, 0, 0) }, hold: 0.06, release: 0.08 }],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-20, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: [],
  reload: {
    style: 'timeline',
    // The box hangs on the left: turned and rolled so it stays in view while it is swapped.
    tactical: {
      markers: { magOut: 0.25, magIn: 0.62 },
      keys: [
        { t: 0.12, pos: V(-0.025, 0.035, 0.02), rot: V(8, 10, -16) },
        { t: 0.25, pos: V(-0.03, 0.042, 0.025), rot: V(11, 12, -21) },
        { t: 0.45, pos: V(-0.036, 0.03, 0.02), rot: V(6, 14, -23) },
        { t: 0.62, pos: V(-0.036, 0.036, 0.02), rot: V(9, 12, -20) },
        { t: 0.85, pos: V(-0.01, 0.006, 0.006), rot: V(2, 4, -6) },
      ],
    },
    empty: {
      markers: { magOut: 0.2, magIn: 0.52, boltRelease: 0.78 },
      keys: [
        { t: 0.1, pos: V(-0.025, 0.035, 0.02), rot: V(8, 10, -16) },
        { t: 0.2, pos: V(-0.03, 0.042, 0.025), rot: V(11, 12, -21) },
        { t: 0.38, pos: V(-0.036, 0.03, 0.02), rot: V(6, 14, -23) },
        { t: 0.52, pos: V(-0.036, 0.036, 0.02), rot: V(9, 12, -20) },
        { t: 0.66, pos: V(-0.03, 0.03, 0.012), rot: V(6, 16, -8) },
        { t: 0.78, pos: V(-0.03, 0.032, 0.012), rot: V(8, 16, -6) },
        { t: 0.92, pos: V(-0.008, 0.006, 0.004), rot: V(2, 4, -2) },
      ],
    },
  },
  reloadSteps: {
    magOut: [
      {
        part: 'magazine',
        type: 'tween',
        pose: { pos: V(-0.03, -0.2, 0.02), rot: V(8, 0, 22) },
        duration: 0.28,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'magazine',
        type: 'tween',
        from: { pos: V(-0.02, -0.15, 0.012), rot: V(6, 0, 14) },
        pose: {},
        lead: 0.16,
        duration: 0.22,
        ease: 'inOut',
        show: true,
      },
      // The feed chute is pressed home once the box is seated.
      {
        part: 'chute',
        type: 'pulse',
        pose: { pos: V(0.005, -0.005, 0), rot: V(0, 0, -8) },
        delay: 0.1,
        duration: 0.05,
        hold: 0.03,
        release: 0.1,
        ease: 'out',
      },
    ],
    // The motor lever is thrown and springs back.
    boltRelease: [
      {
        part: 'lever',
        type: 'pulse',
        pose: { rot: V(-55, 0, 0) },
        delay: 0.06,
        duration: 0.07,
        hold: 0.05,
        release: 0.12,
        ease: 'out',
        releaseEase: 'inOut',
      },
    ],
  },
  reloadImpulses: {
    magOut: [{ delay: 0.02, pose: { pos: V(0, 0.012, 0), rot: V(3, 0, -3) } }],
    magIn: [{ delay: 0.06, pose: { pos: V(0, 0.015, 0), rot: V(-4, 0, 4) } }],
    boltRelease: [
      { delay: 0, pose: { pos: V(0.004, 0.004, 0), rot: V(0, 0, -2) } },
      { delay: 0.12, pose: { pos: V(0, 0, 0.008), rot: V(-2.5, 0, 1.5) } },
    ],
  },
  accentLight: { pos: V(-0.05, 0.05, 0.05), color: 0x46e6ff, intensity: 0.018, distance: 0.26 },
  glow: { accent: 2.2, readout: 2.4, sight: 5, heat: 6 },
  drivers: [
    {
      part: 'barrels',
      source: 'spin',
      spin: { axis: 'z', degPerSec: MINIGUN_SPIN_DEG_PER_SEC },
      accentBoost: 3,
      response: 10,
    },
  ],
};
