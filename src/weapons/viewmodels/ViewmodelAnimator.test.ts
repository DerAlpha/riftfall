import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { VIEWMODELS, VIEWMODEL_ANIM } from '../../defs/viewmodels';
import { WEAPONS } from '../../defs/weapons';
import { ViewmodelAnimator } from '../ViewmodelAnimator';
import { WeaponMaterialKit, createWeaponViewmodel, type WeaponViewmodelModel } from './index';

const DT = 1 / 60;
const kit = new WeaponMaterialKit();
const cache = new Map<string, WeaponViewmodelModel>();
afterAll(() => {
  for (const m of cache.values()) m.dispose();
  kit.dispose();
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

const V0 = { x: 0, y: 0, z: 0 };
function fired(weaponId: string, ammoInMag: number): GameEvents['weapon:fired'] {
  return {
    weaponId,
    origin: V0,
    direction: { x: 0, y: 0, z: -1 },
    muzzle: V0,
    shotIndex: 0,
    ammoInMag,
    ads: false,
  };
}

describe('ViewmodelAnimator', () => {
  let events: EventBus<GameEvents>;
  let shown: (string | null)[];
  let anim: ViewmodelAnimator;

  const step = (seconds: number, dt = DT, ads = 0): void => {
    const n = Math.max(1, Math.round(seconds / dt));
    for (let i = 0; i < n; i++) anim.update(seconds / n, ads, 0);
  };

  beforeEach(() => {
    events = new EventBus<GameEvents>();
    shown = [];
    anim = new ViewmodelAnimator({
      events,
      showModel: (id) => {
        shown.push(id);
        return id ? getModel(id) : null;
      },
    });
  });

  it('equips with a raise from the lowered pose and settles at rest', () => {
    events.emit('weapon:equipStart', { weaponId: 'pistol', slot: 0, duration: 0.32, previous: null });
    expect(shown).toEqual(['pistol']);
    expect(anim.currentWeaponId).toBe('pistol');
    step(DT);
    expect(anim.lowering).toBeGreaterThan(0.5);
    expect(anim.pose.py).toBeLessThan(-0.05);
    step(0.4);
    expect(anim.lowering).toBe(0);
    step(1.5);
    expect(Math.abs(anim.pose.py)).toBeLessThan(1e-3);
    expect(Math.abs(anim.pose.rx)).toBeLessThan(1e-3);
  });

  it('holsters the previous weapon before swapping when the switch covers it', () => {
    anim.snapTo('pistol');
    shown.length = 0;
    const duration = WEAPONS.pistol.holsterTime + WEAPONS.rifle.equipTime;
    events.emit('weapon:equipStart', { weaponId: 'rifle', slot: 1, duration, previous: 'pistol' });
    expect(shown).toEqual([]);
    step(WEAPONS.pistol.holsterTime * 0.5);
    expect(anim.currentWeaponId).toBe('pistol');
    expect(anim.lowering).toBeGreaterThan(0.05);
    step(WEAPONS.pistol.holsterTime * 0.6);
    expect(shown).toEqual(['rifle']);
    expect(anim.currentWeaponId).toBe('rifle');
    step(WEAPONS.rifle.equipTime + 0.05);
    expect(anim.lowering).toBe(0);
    // A short switch (no room for the holster) swaps immediately.
    shown.length = 0;
    events.emit('weapon:equipStart', { weaponId: 'shotgun', slot: 2, duration: 0.1, previous: 'rifle' });
    expect(shown).toEqual(['shotgun']);
  });

  it('follows the weapon system switch sequence: holsterStart + equipStart, retarget, change of mind', () => {
    anim.snapTo('pistol');
    shown.length = 0;
    const holster = WEAPONS.pistol.holsterTime;
    // Switch pistol → rifle (both events in the same tick).
    events.emit('weapon:holsterStart', { weaponId: 'pistol', slot: 0, duration: holster, next: 'rifle' });
    events.emit('weapon:equipStart', {
      weaponId: 'rifle',
      slot: 1,
      duration: holster + WEAPONS.rifle.equipTime,
      previous: 'pistol',
    });
    step(holster * 0.5);
    expect(anim.currentWeaponId).toBe('pistol');
    // Retarget to the shotgun while lowering (equipStart only).
    events.emit('weapon:equipStart', {
      weaponId: 'shotgun',
      slot: 2,
      duration: holster * 0.5 + WEAPONS.shotgun.equipTime,
      previous: 'pistol',
    });
    step(holster * 0.5 + 0.02);
    expect(shown).toEqual(['shotgun']);
    expect(anim.lowering).toBeGreaterThan(0.9);
    step(WEAPONS.shotgun.equipTime);
    expect(anim.lowering).toBe(0);
    // Switch away, then change of mind halfway: the shotgun comes back up without a swap.
    shown.length = 0;
    const sh = WEAPONS.shotgun.holsterTime;
    events.emit('weapon:holsterStart', { weaponId: 'shotgun', slot: 2, duration: sh, next: 'pistol' });
    events.emit('weapon:equipStart', {
      weaponId: 'pistol',
      slot: 0,
      duration: sh + WEAPONS.pistol.equipTime,
      previous: 'shotgun',
    });
    step(sh * 0.5);
    const lowered = anim.lowering;
    expect(lowered).toBeGreaterThan(0.05);
    events.emit('weapon:equipStart', {
      weaponId: 'shotgun',
      slot: 2,
      duration: WEAPONS.shotgun.equipTime * 0.5,
      previous: 'shotgun',
    });
    step(DT);
    expect(anim.lowering).toBeLessThanOrEqual(lowered);
    step(WEAPONS.shotgun.equipTime);
    expect(shown).toEqual([]);
    expect(anim.currentWeaponId).toBe('shotgun');
    expect(anim.lowering).toBe(0);
  });

  it('a switch while the raise is still running lowers from where the weapon is', () => {
    events.emit('weapon:equipStart', { weaponId: 'rifle', slot: 0, duration: 0.5, previous: null });
    step(0.25);
    const partial = anim.lowering;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(0.5);
    shown.length = 0;
    // The weapon system scales the holster by the equip progress.
    const d = WEAPONS.rifle.holsterTime * 0.5;
    events.emit('weapon:holsterStart', { weaponId: 'rifle', slot: 0, duration: d, next: 'pistol' });
    events.emit('weapon:equipStart', {
      weaponId: 'pistol',
      slot: 1,
      duration: d + WEAPONS.pistol.equipTime,
      previous: 'rifle',
    });
    step(DT);
    expect(Math.abs(anim.lowering - partial)).toBeLessThan(0.1);
    step(d);
    expect(shown).toEqual(['pistol']);
    step(WEAPONS.pistol.equipTime);
    expect(anim.lowering).toBe(0);
  });

  it('the muzzle light peaks on the frame of the shot, then decays', () => {
    anim.snapTo('pistol');
    step(0.2);
    events.emit('weapon:fired', fired('pistol', 5));
    anim.update(DT, 0, 0);
    expect(anim.muzzleFlash).toBe(1);
    anim.update(DT, 0, 0);
    expect(anim.muzzleFlash).toBeLessThan(1);
    expect(anim.muzzleFlash).toBeGreaterThan(0);
  });

  it('kicks back and up on fire and recovers; ADS reduces the kick', () => {
    anim.snapTo('rifle');
    step(0.5);
    events.emit('weapon:fired', fired('rifle', 20));
    let maxZ = 0;
    let maxPitch = 0;
    for (let i = 0; i < 20; i++) {
      step(DT);
      maxZ = Math.max(maxZ, anim.pose.pz);
      maxPitch = Math.max(maxPitch, anim.pose.rx);
    }
    const kick = WEAPONS.rifle.recoil.visualKick;
    expect(maxZ).toBeGreaterThan(kick.back * 0.6);
    expect(maxPitch).toBeGreaterThan(kick.pitch * (Math.PI / 180) * 0.5);
    expect(anim.muzzleFlash).toBeLessThan(0.1);
    step(2);
    expect(Math.abs(anim.pose.pz)).toBeLessThan(1e-3);

    step(0.5, DT, 1);
    events.emit('weapon:fired', fired('rifle', 19));
    let adsZ = 0;
    for (let i = 0; i < 20; i++) {
      anim.update(DT, 1, 0);
      adsZ = Math.max(adsZ, anim.pose.pz);
    }
    expect(adsZ).toBeLessThan(maxZ * 0.8);
  });

  it('cycles the slide per shot and locks it back on the last round until the slide release', () => {
    anim.snapTo('pistol');
    const slide = getModel('pistol')!.parts.slide!;
    const restZ = slide.position.z;
    events.emit('weapon:ammoChanged', { weaponId: 'pistol', mag: 5, reserve: 30, magSize: 12 });
    events.emit('weapon:fired', fired('pistol', 4));
    step(0.025, 1 / 240);
    expect(slide.position.z - restZ).toBeGreaterThan(0.02);
    step(0.3);
    expect(slide.position.z).toBeCloseTo(restZ, 6);

    events.emit('weapon:fired', fired('pistol', 0));
    events.emit('weapon:ammoChanged', { weaponId: 'pistol', mag: 0, reserve: 30, magSize: 12 });
    step(0.5);
    expect(slide.position.z - restZ).toBeGreaterThan(0.02);
    events.emit('weapon:reloadStart', { weaponId: 'pistol', empty: true, duration: 1.6 });
    events.emit('weapon:reloadStep', { weaponId: 'pistol', step: 'magOut' });
    step(0.5);
    expect(getModel('pistol')!.parts.magazine!.visible).toBe(false);
    events.emit('weapon:reloadStep', { weaponId: 'pistol', step: 'magIn' });
    step(DT);
    expect(getModel('pistol')!.parts.magazine!.visible).toBe(true);
    events.emit('weapon:ammoChanged', { weaponId: 'pistol', mag: 12, reserve: 18, magSize: 12 });
    expect(slide.position.z - restZ).toBeGreaterThan(0.02);
    events.emit('weapon:reloadStep', { weaponId: 'pistol', step: 'boltRelease' });
    step(0.3);
    expect(slide.position.z).toBeCloseTo(restZ, 6);
    events.emit('weapon:reloadEnd', { weaponId: 'pistol', completed: true });
    step(1);
    expect(Math.abs(anim.pose.rz)).toBeLessThan(1e-2);
  });

  it('a cancelled reload brings the magazine back and blends the pose out', () => {
    anim.snapTo('rifle');
    const mag = getModel('rifle')!.parts.magazine!;
    const rest = mag.position.clone();
    events.emit('weapon:reloadStart', { weaponId: 'rifle', empty: false, duration: 1.85 });
    step(0.45);
    events.emit('weapon:reloadStep', { weaponId: 'rifle', step: 'magOut' });
    step(0.4);
    expect(mag.visible).toBe(false);
    expect(Math.abs(anim.pose.rz)).toBeGreaterThan(0.2);
    events.emit('weapon:reloadEnd', { weaponId: 'rifle', completed: false });
    step(0.6);
    expect(mag.visible).toBe(true);
    expect(mag.position.distanceTo(rest)).toBeLessThan(1e-6);
    step(1);
    expect(Math.abs(anim.pose.rz)).toBeLessThan(0.01);
  });

  it('shell-by-shell reload holds the loading pose until the tube is full, then closes', () => {
    anim.snapTo('shotgun');
    const ps = WEAPONS.shotgun.reload.perShell;
    const shell = getModel('shotgun')!.parts.shell!;
    events.emit('weapon:ammoChanged', { weaponId: 'shotgun', mag: 5, reserve: 10, magSize: 8 });
    // Two shells + end, like the weapon system announces it.
    events.emit('weapon:reloadStart', {
      weaponId: 'shotgun',
      empty: false,
      duration: ps.start + 3 * ps.shell + ps.end,
    });
    step(ps.start);
    const hold = Math.abs(anim.pose.rz);
    expect(hold).toBeGreaterThan(0.3);
    // The first shell is already on its way (lead) before its marker, and seated by the marker.
    step(ps.insertAt - 0.05);
    expect(shell.visible).toBe(true);
    for (let i = 0; i < 3; i++) {
      step(0.05, 1 / 240);
      events.emit('weapon:reloadStep', { weaponId: 'shotgun', step: 'shellIn' });
      events.emit('weapon:ammoChanged', { weaponId: 'shotgun', mag: 6 + i, reserve: 9 - i, magSize: 8 });
      if (i < 2) {
        step(ps.shell - 0.05);
        // Held while shells keep coming, the next shell is travelling again.
        expect(Math.abs(anim.pose.rz)).toBeGreaterThan(hold * 0.8);
        expect(shell.visible).toBe(true);
      }
    }
    step(ps.shell - ps.insertAt + VIEWMODELS.shotgun.reload.outroTime + 0.4);
    expect(Math.abs(anim.pose.rz)).toBeLessThan(0.05);
    expect(shell.visible).toBe(false);
  });

  it('an interrupted shell reload drops the pending shell and blends out fast', () => {
    anim.snapTo('shotgun');
    const ps = WEAPONS.shotgun.reload.perShell;
    const shell = getModel('shotgun')!.parts.shell!;
    events.emit('weapon:ammoChanged', { weaponId: 'shotgun', mag: 2, reserve: 20, magSize: 8 });
    events.emit('weapon:reloadStart', { weaponId: 'shotgun', empty: false, duration: 3 });
    step(ps.start + ps.insertAt);
    events.emit('weapon:reloadStep', { weaponId: 'shotgun', step: 'shellIn' });
    events.emit('weapon:ammoChanged', { weaponId: 'shotgun', mag: 3, reserve: 19, magSize: 8 });
    step(0.1);
    // Fire interrupt: the weapon system closes, then ends the reload and shoots.
    events.emit('weapon:reloadEnd', { weaponId: 'shotgun', completed: false });
    events.emit('weapon:fired', fired('shotgun', 2));
    step(VIEWMODEL_ANIM.cancelOutroTime + 0.35);
    expect(Math.abs(anim.pose.rz)).toBeLessThan(0.08);
    step(0.6);
    expect(shell.visible).toBe(false);
  });

  it('lead motions land on their marker sound; a scaled reload scales the schedule', () => {
    anim.snapTo('rifle');
    const mag = getModel('rifle')!.parts.magazine!;
    const rest = mag.position.clone();
    const def = WEAPONS.rifle.reload;
    const magIn = def.tacticalSteps.find((m) => m.step === 'magIn')!.at;
    const magOut = def.tacticalSteps.find((m) => m.step === 'magOut')!.at;
    const lead = VIEWMODELS.rifle.reloadSteps.magIn[0].lead;
    const seat = VIEWMODELS.rifle.reloadSteps.magIn[0].duration - lead;
    for (const scale of [1, 2]) {
      events.emit('weapon:reloadStart', { weaponId: 'rifle', empty: false, duration: def.tactical * scale });
      step(magOut * scale, 1 / 240);
      events.emit('weapon:reloadStep', { weaponId: 'rifle', step: 'magOut' });
      step(magIn * scale - lead - magOut * scale - 0.02, 1 / 240);
      expect(mag.visible, `scale ${scale}: still out`).toBe(false);
      step(0.04, 1 / 240);
      expect(mag.visible, `scale ${scale}: on its way`).toBe(true);
      expect(mag.position.distanceTo(rest)).toBeGreaterThan(0.05);
      step(lead - 0.02, 1 / 240);
      events.emit('weapon:reloadStep', { weaponId: 'rifle', step: 'magIn' });
      // Not restarted by the marker: it keeps travelling and seats `seat` s later.
      expect(mag.position.distanceTo(rest)).toBeLessThan(0.03);
      step(seat + 0.004, 1 / 240);
      expect(mag.position.distanceTo(rest)).toBeLessThan(1e-6);
      step(def.tactical * scale, 1 / 240);
      events.emit('weapon:reloadEnd', { weaponId: 'rifle', completed: true });
      step(0.5);
    }
  });

  it('inspect is cancelled by firing; melee swings and lands a hit impulse', () => {
    anim.snapTo('rifle');
    events.emit('weapon:inspect', { weaponId: 'rifle', duration: 2.8 });
    step(0.8);
    expect(Math.abs(anim.pose.ry)).toBeGreaterThan(0.3);
    events.emit('weapon:fired', fired('rifle', 10));
    step(0.6);
    expect(Math.abs(anim.pose.ry)).toBeLessThan(0.1);

    step(1);
    events.emit('weapon:melee', { weaponId: 'rifle', duration: 0.5, hit: true });
    let maxForward = 0;
    for (let i = 0; i < 20; i++) {
      step(DT);
      maxForward = Math.max(maxForward, -anim.pose.pz);
    }
    expect(maxForward).toBeGreaterThan(0.05);
    step(1.5);
    expect(Math.abs(anim.pose.pz)).toBeLessThan(2e-3);
  });

  it('the bash key lands on the weapon melee hit time; cancelInspect blends an inspect out', () => {
    anim.snapTo('pistol');
    step(0.3);
    const m = WEAPONS.pistol.melee;
    events.emit('weapon:melee', { weaponId: 'pistol', duration: m.duration, hit: false });
    step(m.hitTime, 1 / 240);
    const strike = VIEWMODEL_ANIM.melee.find((k) => k.t === VIEWMODEL_ANIM.meleeStrike)!;
    expect(anim.pose.pz).toBeCloseTo(strike.pos.z, 2);
    step(m.duration + 0.5);

    events.emit('weapon:inspect', { weaponId: 'pistol', duration: 2.2 });
    step(0.6);
    expect(Math.abs(anim.pose.ry)).toBeGreaterThan(0.3);
    anim.cancelInspect();
    step(0.6);
    expect(Math.abs(anim.pose.ry)).toBeLessThan(0.05);
  });

  it('a cancelled inspect end (and a dry trigger pull) blends the inspect out; a completed one does not cut it', () => {
    anim.snapTo('shotgun');
    step(0.3);
    events.emit('weapon:inspect', { weaponId: 'shotgun', duration: 2.6 });
    step(0.8);
    expect(Math.abs(anim.pose.ry)).toBeGreaterThan(0.3);
    events.emit('weapon:inspectEnd', { weaponId: 'shotgun', cancelled: true });
    step(0.6);
    expect(Math.abs(anim.pose.ry)).toBeLessThan(0.05);

    events.emit('weapon:inspect', { weaponId: 'shotgun', duration: 2.6 });
    step(0.8);
    events.emit('weapon:dryFire', { weaponId: 'shotgun' });
    step(0.6);
    expect(Math.abs(anim.pose.ry)).toBeLessThan(0.05);

    events.emit('weapon:inspect', { weaponId: 'shotgun', duration: 2.6 });
    step(0.8);
    events.emit('weapon:inspectEnd', { weaponId: 'shotgun', cancelled: false });
    events.emit('weapon:inspectEnd', { weaponId: 'pistol', cancelled: true });
    step(DT);
    expect(Math.abs(anim.pose.ry)).toBeGreaterThan(0.3);
  });

  it('reduce flashing tones down the shot flash and muzzle light (initial value and live setting)', () => {
    const settingsChanged = (reduceFlashing: boolean): void => {
      const settings = {
        accessibility: { reduceFlashing },
      } as unknown as GameEvents['settings:changed']['settings'];
      events.emit('settings:changed', { settings, sections: ['accessibility'] });
    };
    anim.snapTo('rifle');
    step(0.2);
    settingsChanged(true);
    events.emit('weapon:fired', fired('rifle', 20));
    anim.update(DT, 0, 0);
    expect(anim.muzzleFlash).toBeCloseTo(VIEWMODEL_ANIM.reducedFlashScale, 9);
    settingsChanged(false);
    events.emit('weapon:fired', fired('rifle', 19));
    anim.update(DT, 0, 0);
    expect(anim.muzzleFlash).toBe(1);

    const reduced = new ViewmodelAnimator({
      events,
      showModel: (id) => (id ? getModel(id) : null),
      reduceFlashing: true,
    });
    reduced.snapTo('rifle');
    events.emit('weapon:fired', fired('rifle', 18));
    reduced.update(DT, 0, 0);
    expect(reduced.muzzleFlash).toBeCloseTo(VIEWMODEL_ANIM.reducedFlashScale, 9);
    reduced.dispose();
  });

  it('ignores events of other weapons and survives unknown weapons', () => {
    anim.snapTo('pistol');
    events.emit('weapon:fired', fired('rifle', 3));
    step(DT);
    expect(anim.pose.pz).toBeCloseTo(0, 9);
    events.emit('weapon:equipStart', {
      weaponId: 'laser-banana',
      slot: 0,
      duration: 0.3,
      previous: 'pistol',
    });
    step(0.35);
    expect(anim.currentWeaponId).toBe('laser-banana');
    expect(anim.currentModel).toBeNull();
    events.emit('weapon:fired', fired('laser-banana', 1));
    events.emit('weapon:reloadStart', { weaponId: 'laser-banana', empty: true, duration: 1 });
    events.emit('weapon:reloadStep', { weaponId: 'laser-banana', step: 'magOut' });
    events.emit('weapon:inspect', { weaponId: 'laser-banana', duration: 1 });
    expect(() => step(1)).not.toThrow();
  });

  it('heat builds with sustained fire and cools down', () => {
    anim.snapTo('rifle');
    const interval = 60 / WEAPONS.rifle.rpm;
    for (let i = 0; i < 30; i++) {
      events.emit('weapon:fired', fired('rifle', 30 - i));
      step(interval, 1 / 240);
    }
    expect(anim.heatLevel).toBeGreaterThan(0.5);
    step(10);
    expect(anim.heatLevel).toBe(0);
  });

  it('is frame-rate independent', () => {
    const sample = (dt: number): number => {
      const a = new ViewmodelAnimator({
        events: new EventBus<GameEvents>(),
        showModel: (id) => getModel(id!),
      });
      a.snapTo('shotgun');
      a.update(1e-4, 0, 0);
      // Deterministic kick: drive the dry-fire impulse (no random signs).
      (a as unknown as { onDryFire(id: string): void }).onDryFire('shotgun');
      const n = Math.round(0.05 / dt);
      for (let i = 0; i < n; i++) a.update(0.05 / n, 0, 0);
      const v = a.pose.rx;
      a.dispose();
      return v;
    };
    // Springs sub-step at CAMERA.maxSpringStep: every frame rate integrates (nearly) the same curve.
    const ref = sample(1 / 240);
    expect(Math.abs(ref)).toBeGreaterThan(1e-3);
    for (const fps of [20, 30, 60, 144])
      expect(Math.abs(sample(1 / fps) - ref)).toBeLessThan(Math.abs(ref) * 0.1);
  });

  it('dispose unsubscribes from every event', () => {
    expect(events.listenerCount('weapon:fired')).toBe(1);
    anim.dispose();
    for (const t of ['weapon:fired', 'weapon:equipStart', 'weapon:reloadStep', 'weapon:melee'] as const) {
      expect(events.listenerCount(t)).toBe(0);
    }
    expect(VIEWMODEL_ANIM.cancelLambda).toBeGreaterThan(0);
  });
});
