import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Vector3, type MeshStandardMaterial, type Object3D, type Quaternion } from 'three';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { DEG2RAD } from '../../core/math';
import { VIEWMODEL_ANIM, type ViewmodelDriverDef, type WeaponViewmodelDef } from '../../defs/viewmodels';
import { ViewmodelAnimator } from '../ViewmodelAnimator';
import {
  WeaponMaterialKit,
  createWeaponViewmodel,
  registerViewmodelBuilder,
  type WeaponViewmodelModel,
} from './index';
import { buildPistol } from './pistol';

const DT = 1 / 60;
const SPIN_RATE = 720;
const DRIVERS: readonly ViewmodelDriverDef[] = [
  // The hammer spins with weapon:spin (a stand-in for minigun barrels).
  { part: 'hammer', source: 'spin', spin: { axis: 'z', degPerSec: SPIN_RATE }, accentBoost: 2 },
  // The slide slides forward while charging (instant), the trigger opens with the beam (eased).
  { part: 'slide', source: 'charge', pose: { pos: { x: 0, y: 0, z: -0.02 } }, accentBoost: 3 },
  { part: 'trigger', source: 'beam', pose: { rot: { x: 30, y: 0, z: 0 } }, response: 12 },
  // Heat pushes the magazine down a little; an idle floor keeps a missing part's glow alive.
  { part: 'magazine', source: 'heat', pose: { pos: { x: 0, y: -0.01, z: 0 } } },
  { part: 'no-such-part', source: 'beam', accentBoost: 1, idle: 0.5 },
];

const kit = new WeaponMaterialKit();
const cache = new Map<string, WeaponViewmodelModel>();
afterAll(() => {
  for (const m of cache.values()) m.dispose();
  kit.dispose();
});

registerViewmodelBuilder('driver-test', (k) => {
  const base = buildPistol(k);
  const def: WeaponViewmodelDef = { ...base.def, drivers: DRIVERS };
  return Object.assign(Object.create(base) as WeaponViewmodelModel, { def, weaponId: 'driver-test' });
});

function getModel(id: string): WeaponViewmodelModel | null {
  let m = cache.get(id);
  if (!m) {
    const made = createWeaponViewmodel(id, kit);
    if (!made) return null;
    cache.set(id, made);
    m = made;
  }
  return m;
}

function accentOf(m: WeaponViewmodelModel): MeshStandardMaterial {
  let found: MeshStandardMaterial | null = null;
  m.root.traverse((o) => {
    const mat = (o as { material?: MeshStandardMaterial }).material;
    if (mat?.name === 'vm-accent') found = mat;
  });
  if (!found) throw new Error('no accent');
  return found;
}

/** Rotation angle (rad) of a part relative to its rest orientation. */
function angleFrom(obj: Object3D, rest: Quaternion): number {
  return obj.quaternion.angleTo(rest);
}

describe('ViewmodelAnimator – state drivers and gestures (M5)', () => {
  let events: EventBus<GameEvents>;
  let anim: ViewmodelAnimator;
  const step = (seconds: number, dt = DT): void => {
    const n = Math.max(1, Math.round(seconds / dt));
    for (let i = 0; i < n; i++) anim.update(seconds / n, 0, 0);
  };

  beforeEach(() => {
    events = new EventBus<GameEvents>();
    anim = new ViewmodelAnimator({ events, showModel: (id) => (id ? getModel(id) : null) });
  });

  it('spin drivers turn the part with weapon:spin and stop when it spins down', () => {
    anim.snapTo('driver-test');
    const hammer = getModel('driver-test')!.parts.hammer!;
    step(0.1);
    const rest = hammer.quaternion.clone();
    events.emit('weapon:spin', { weaponId: 'driver-test', amount: 1 });
    step(0.1, 1 / 240);
    // Instant response: 0.1 s at full rate.
    expect(angleFrom(hammer, rest)).toBeCloseTo(SPIN_RATE * DEG2RAD * 0.1, 3);
    // Spinning about the part's local Z: its local Z axis does not move.
    const z = new Vector3(0, 0, 1).applyQuaternion(hammer.quaternion);
    expect(z.distanceTo(new Vector3(0, 0, 1).applyQuaternion(rest))).toBeLessThan(1e-6);
    // Other weapons' spin is ignored; spin 0 stops the part where it is.
    events.emit('weapon:spin', { weaponId: 'rifle', amount: 0 });
    step(0.05);
    expect(angleFrom(hammer, rest)).toBeGreaterThan(0.5);
    events.emit('weapon:spin', { weaponId: 'driver-test', amount: 0 });
    step(DT);
    const stopped = hammer.quaternion.clone();
    step(0.3);
    expect(hammer.quaternion.angleTo(stopped)).toBeLessThan(1e-6);
  });

  it('pose drivers offset the part in its local frame, instantly or eased by `response`', () => {
    anim.snapTo('driver-test');
    const m = getModel('driver-test')!;
    const slide = m.parts.slide!;
    const trigger = m.parts.trigger!;
    step(0.1);
    const slideRest = slide.position.z;
    const triggerRest = trigger.quaternion.clone();
    events.emit('weapon:charge', { weaponId: 'driver-test', amount: 0.5 });
    events.emit('weapon:beam', { weaponId: 'driver-test', active: true });
    step(DT);
    expect(slide.position.z - slideRest).toBeCloseTo(-0.01, 6);
    // Eased: the trigger is only partly open after one frame, fully after a while.
    const early = angleFrom(trigger, triggerRest);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(30 * DEG2RAD * 0.5);
    step(1);
    expect(angleFrom(trigger, triggerRest)).toBeCloseTo(30 * DEG2RAD, 3);
    events.emit('weapon:charge', { weaponId: 'driver-test', amount: 0 });
    events.emit('weapon:beam', { weaponId: 'driver-test', active: false });
    step(1);
    expect(slide.position.z).toBeCloseTo(slideRest, 9);
    expect(angleFrom(trigger, triggerRest)).toBeLessThan(1e-3);
  });

  it('pose drivers add to the part choreography (a firing slide still cycles while charged)', () => {
    anim.snapTo('driver-test');
    const slide = getModel('driver-test')!.parts.slide!;
    step(0.1);
    const rest = slide.position.z;
    events.emit('weapon:charge', { weaponId: 'driver-test', amount: 1 });
    events.emit('weapon:fired', {
      weaponId: 'driver-test',
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      muzzle: { x: 0, y: 0, z: 0 },
      shotIndex: 0,
      ammoInMag: 5,
      ads: false,
    });
    step(0.025, 1 / 240);
    // Pistol slide pulse (+0.034 back) on top of the driver (−0.02).
    expect(slide.position.z - rest).toBeGreaterThan(0.005);
    step(0.4);
    expect(slide.position.z - rest).toBeCloseTo(-0.02, 6);
  });

  it('heat drives parts, the accent boost follows the sources, idle floors hold at rest', () => {
    anim.snapTo('driver-test');
    const m = getModel('driver-test')!;
    const mag = m.parts.magazine!;
    step(0.2);
    // The idle floor (0.5 × boost 1) glows at rest.
    expect(anim.driverAccentBoost).toBeCloseTo(0.5, 9);
    const base = accentOf(m).emissiveIntensity;
    const restY = mag.position.y;
    for (let i = 0; i < 12; i++) {
      events.emit('weapon:fired', {
        weaponId: 'driver-test',
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: -1 },
        muzzle: { x: 0, y: 0, z: 0 },
        shotIndex: i,
        ammoInMag: 10,
        ads: false,
      });
      step(0.1);
    }
    expect(anim.heatLevel).toBeGreaterThan(0.5);
    // Magazine motion is local (tilted along the grip): compare distances.
    expect(Math.abs(mag.position.y - restY)).toBeGreaterThan(0.004);
    events.emit('weapon:spin', { weaponId: 'driver-test', amount: 1 });
    events.emit('weapon:charge', { weaponId: 'driver-test', amount: 1 });
    events.emit('weapon:beam', { weaponId: 'driver-test', active: true });
    step(DT);
    expect(anim.driverAccentBoost).toBeCloseTo(2 + 3 + 1, 9);
    expect(accentOf(m).emissiveIntensity).toBeGreaterThan(base + 5);
  });

  it('a weapon swap resets the sources; unbinding restores the rest transforms', () => {
    anim.snapTo('driver-test');
    const m = getModel('driver-test')!;
    const hammer = m.parts.hammer!;
    step(0.1);
    const rest = hammer.quaternion.clone();
    events.emit('weapon:spin', { weaponId: 'driver-test', amount: 1 });
    step(0.13);
    expect(angleFrom(hammer, rest)).toBeGreaterThan(0.1);
    anim.snapTo('pistol');
    expect(angleFrom(hammer, rest)).toBeLessThan(1e-6);
    step(0.1);
    anim.snapTo('driver-test');
    step(0.2);
    expect(angleFrom(hammer, rest)).toBeLessThan(1e-6);
    expect(anim.driverAccentBoost).toBeCloseTo(0.5, 9);
    // Weapons without drivers never boost.
    anim.snapTo('pistol');
    step(DT);
    expect(anim.driverAccentBoost).toBe(0);
  });

  it('grenade:thrown dips the weapon down-right and brings it back', () => {
    anim.snapTo('rifle');
    step(0.5);
    events.emit('grenade:thrown', { grenadeId: 'frag', position: { x: 0, y: 0, z: 0 } });
    const G = VIEWMODEL_ANIM.grenadeThrow;
    let minY = 0;
    let maxX = 0;
    let minRoll = 0;
    const n = Math.round(G.duration / DT);
    for (let i = 0; i < n; i++) {
      step(DT);
      minY = Math.min(minY, anim.pose.py);
      maxX = Math.max(maxX, anim.pose.px);
      minRoll = Math.min(minRoll, anim.pose.rz);
    }
    expect(minY).toBeLessThan(-0.06);
    expect(maxX).toBeGreaterThan(0.02);
    expect(minRoll).toBeLessThan(-15 * DEG2RAD);
    step(1);
    expect(Math.abs(anim.pose.py)).toBeLessThan(2e-3);
    expect(Math.abs(anim.pose.rz)).toBeLessThan(2e-3);
  });

  it('a gesture restarted mid-way hands over without a pop; it also plays without a weapon', () => {
    anim.snapTo('pistol');
    step(0.3);
    const thrown: GameEvents['grenade:thrown'] = { grenadeId: 'frag', position: { x: 0, y: 0, z: 0 } };
    events.emit('grenade:thrown', thrown);
    step(VIEWMODEL_ANIM.grenadeThrow.duration * 0.6);
    const before = anim.pose.py;
    events.emit('grenade:thrown', thrown);
    anim.update(1e-4, 0, 0);
    expect(Math.abs(anim.pose.py - before)).toBeLessThan(0.004);
    step(1.5);
    expect(Math.abs(anim.pose.py)).toBeLessThan(2e-3);

    anim.snapTo(null);
    events.emit('grenade:thrown', thrown);
    step(0.1);
    expect(anim.pose.py).toBeLessThan(-0.03);
  });

  it('ability:used cants the weapon and surges the accents', () => {
    anim.snapTo('pistol');
    const m = getModel('pistol')!;
    // At the bottom of the accent breathing pulse the surge stands out clearly.
    step(0.5);
    const calm = accentOf(m).emissiveIntensity;
    events.emit('ability:used', { abilityId: 'shockwave', cooldown: 20, duration: 0 });
    anim.update(DT, 0, 0);
    expect(accentOf(m).emissiveIntensity).toBeGreaterThan(calm + VIEWMODEL_ANIM.accentPulse.fireFlash * 0.5);
    let minRoll = 0;
    for (let i = 0; i < 30; i++) {
      step(DT);
      minRoll = Math.min(minRoll, anim.pose.rz);
    }
    expect(minRoll).toBeLessThan(-8 * DEG2RAD);
    step(1);
    expect(Math.abs(anim.pose.rz)).toBeLessThan(2e-3);
  });

  it('dispose unsubscribes the M5 events too', () => {
    anim.dispose();
    for (const t of [
      'weapon:spin',
      'weapon:charge',
      'weapon:beam',
      'grenade:thrown',
      'ability:used',
    ] as const)
      expect(events.listenerCount(t)).toBe(0);
  });
});
