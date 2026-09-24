/**
 * LM-60 „Bollwerk“ – viewmodel poses and part choreography (M5). Belt-fed light machine gun: the belt
 * jerks one link into the feed tray per shot. Reload (both kinds): magOut = the feed cover swings
 * open, the ammo box drops away; magIn = a fresh box clicks in and the belt is laid into the tray;
 * boltRelease = the cover slams shut and the charging handle is racked. Import runtime helpers from
 * '../viewmodelParts' and only TYPES from '../viewmodels'.
 */
import type { ReloadTrackDef, WeaponViewmodelDef } from '../viewmodels';
import { LONG_GUN_LOWERED, TRIGGER_PULL, V } from '../viewmodelParts';

/** Feed cover opening angle around its rear hinge (deg). */
const COVER_OPEN = 74;
/** One belt link: the belt jumps back by this and is pulled in again per shot (m). */
const LINK = V(-0.0095, -0.0035, 0);

/** Box on the left flank first, then the top rolls towards the eye for the belt and the cover. */
const RELOAD_TRACK: ReloadTrackDef = {
  markers: { magOut: 0.22, magIn: 0.55, boltRelease: 0.8 },
  keys: [
    { t: 0.1, pos: V(-0.03, 0.028, 0.03), rot: V(8, 14, -18) },
    { t: 0.22, pos: V(-0.036, 0.034, 0.035), rot: V(11, 16, -23) },
    { t: 0.42, pos: V(-0.045, 0.02, 0.03), rot: V(6, 18, -25) },
    { t: 0.55, pos: V(-0.05, 0.028, 0.03), rot: V(9, 18, -21) },
    { t: 0.67, pos: V(-0.055, 0.04, 0.02), rot: V(11, 20, 10) },
    { t: 0.8, pos: V(-0.055, 0.044, 0.02), rot: V(13, 20, 14) },
    { t: 0.93, pos: V(-0.015, 0.008, 0.005), rot: V(3, 6, 3) },
  ],
};

export const LMG_VIEWMODEL: WeaponViewmodelDef = {
  hip: { pos: V(0.14, -0.172, -0.36), rot: V(0, 2, 0) },
  adsEyeDistance: 0.2,
  sprint: { pos: V(-0.035, -0.05, 0.035), rot: V(-12, 30, -24) },
  lowered: LONG_GUN_LOWERED,
  pivot: V(0, 0.03, -0.12),
  kickSpring: { posStiffness: 520, posDamping: 33, rotStiffness: 410, rotDamping: 29 },
  adsKickScale: 0.4,
  sustained: { perShot: 0.05, decay: 1.4, pose: { pos: V(0, 0.005, 0.016), rot: V(3, 0, 0) } },
  heat: { perShot: 0.03, decay: 0.1 },
  fire: [
    { part: 'belt', type: 'tween', from: { pos: LINK }, pose: {}, duration: 0.045, ease: 'out' },
    { ...TRIGGER_PULL, pose: { rot: V(-14, 0, 0) }, hold: 0.03, release: 0.05 },
  ],
  fireLast: [
    { part: 'belt', type: 'tween', from: { pos: LINK }, pose: {}, duration: 0.045, ease: 'out' },
    { ...TRIGGER_PULL, pose: { rot: V(-14, 0, 0) } },
  ],
  dryFire: [{ ...TRIGGER_PULL, pose: { rot: V(-18, 0, 0) }, release: 0.05 }],
  fireImpulses: [],
  lockParts: [],
  reload: { style: 'timeline', tactical: RELOAD_TRACK, empty: RELOAD_TRACK },
  reloadSteps: {
    magOut: [
      {
        part: 'cover',
        type: 'tween',
        pose: { rot: V(COVER_OPEN, 0, 0) },
        lead: 0.14,
        duration: 0.16,
        ease: 'outBack',
      },
      {
        part: 'magazine',
        type: 'tween',
        pose: { pos: V(-0.02, -0.2, 0.01), rot: V(10, 0, 18) },
        delay: 0.03,
        duration: 0.26,
        ease: 'in',
        hideAtEnd: true,
      },
    ],
    magIn: [
      {
        part: 'magazine',
        type: 'tween',
        from: { pos: V(-0.012, -0.14, 0.006), rot: V(6, 0, 10) },
        pose: {},
        lead: 0.14,
        duration: 0.2,
        ease: 'inOut',
        show: true,
      },
      // The left hand lays the belt into the open tray.
      {
        part: 'belt',
        type: 'tween',
        from: { pos: V(-0.012, -0.03, 0.004), rot: V(0, 0, 28) },
        pose: {},
        delay: 0.08,
        duration: 0.22,
        ease: 'inOut',
      },
    ],
    boltRelease: [
      { part: 'cover', type: 'tween', pose: {}, lead: 0.08, duration: 0.08, ease: 'in' },
      {
        part: 'bolt',
        type: 'pulse',
        pose: { pos: V(0, 0, 0.075) },
        delay: 0.1,
        duration: 0.07,
        hold: 0.03,
        release: 0.05,
        ease: 'out',
        releaseEase: 'in',
      },
    ],
  },
  reloadImpulses: {
    magOut: [
      { delay: 0, pose: { pos: V(0, 0.004, 0), rot: V(-2, 0, 1.5) } },
      { delay: 0.04, pose: { pos: V(0, 0.01, 0), rot: V(3.5, 0, -3) } },
    ],
    magIn: [
      { delay: 0.06, pose: { pos: V(0, 0.014, 0), rot: V(-4.5, 0, 3.5) } },
      { delay: 0.3, pose: { pos: V(0, 0.004, 0), rot: V(-1.5, 0, 1) } },
    ],
    boltRelease: [
      { delay: 0, pose: { pos: V(0, -0.01, 0.004), rot: V(-3.5, 0, 2) } },
      { delay: 0.17, pose: { pos: V(0, 0, 0.01), rot: V(0, 0, 2.5) } },
      { delay: 0.25, pose: { pos: V(0, 0, -0.012), rot: V(3, 0, -3) } },
    ],
  },
  accentLight: { pos: V(-0.06, 0.06, -0.12), color: 0x46e6ff, intensity: 0.016, distance: 0.24 },
  glow: { accent: 2.2, readout: 2.4, sight: 8, heat: 5.5 },
};
