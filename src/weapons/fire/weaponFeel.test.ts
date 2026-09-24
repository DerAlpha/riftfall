/**
 * Weapon feel & balance regressions (M5 review): trigger-rate exploits, forge tier self damage,
 * the suppressor's report and the forged muzzle light on weapon:fired, time-to-kill sanity per
 * wave through the real WeaponSystem + arsenal.
 */
import { describe, expect, it } from 'vitest';
import type { ArsenalVfxApi } from '../../core/contracts';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { CombatWorld } from '../../combat/CombatWorld';
import { FakeTarget, buildTestLevel } from '../../combat/testFakes';
import { WEAPONS, getWeaponDef, type WeaponDef } from '../../defs/weapons';
import { fakeSettings } from '../../player/testHelpers';
import { FakeCamera, FakePlayer, FakeWeaponInput, fakeRenderCamera } from '../testFakes';
import { WeaponSystem } from '../WeaponSystem';
import { resolveWeapon } from '../resolveWeapon';
import { Arsenal } from './Arsenal';
import { AudioEventBridge, type AudioBridgeTarget } from '../../audio/AudioEventBridge';
import { AUDIO } from '../../defs/audio';
import { FORGE_LOOKS, forgePaletteId, getForgeLook } from '../../defs/forge';
import { VfxBridge } from '../../vfx/VfxBridge';
import { VfxSystem } from '../../vfx/VfxSystem';
import { FakeSockets, fakeRender } from '../../vfx/testFakes';
import { WeaponMaterialKit, createWeaponViewmodel } from '../viewmodels';

const DT = 1 / 60;
const EYE = { x: 0, y: 1.6, z: 0 };
const O3 = { x: 0, y: 1.5, z: -1 };
const FWD = { x: 0, y: 0, z: -1 };

/** Deterministic aim: no spread, no random recoil, no pattern climb. */
function precise(def: WeaponDef): WeaponDef {
  return {
    ...def,
    spread: { ...def.spread, hip: 0, ads: 0, moveAdd: 0, airAdd: 0, perShotBloom: 0 },
    recoil: { ...def.recoil, randomYaw: 0, randomPitch: 0, pattern: [[0, 0]], patternRepeatFrom: 0 },
  };
}

const NULL_VFX: ArsenalVfxApi = {
  projectileStart: () => 1,
  projectileMove: () => {},
  projectileEnd: () => {},
  beam: () => {},
  fieldStart: () => 1,
  fieldEnd: () => {},
  charge: () => {},
  update: () => {},
  clear: () => {},
};

function setup(defs: Record<string, WeaponDef>, loadout: string[]) {
  const events = new EventBus<GameEvents>();
  const input = new FakeWeaponInput();
  const player = new FakePlayer();
  const combat = new CombatWorld({ events, physics: null });
  combat.setLevel(
    buildTestLevel([
      { material: 'concrete_wall', center: { x: 0, y: 1.5, z: -40 }, size: { x: 40, y: 3, z: 0.5 } },
    ]),
  );
  const arsenal = new Arsenal({ events, combat, vfx: NULL_VFX, seed: 'feel' });
  const weapons = new WeaponSystem(
    {
      events,
      input,
      settings: fakeSettings(),
      player,
      camera: new FakeCamera(player),
      render: fakeRenderCamera(EYE),
      combat,
      arsenal,
      getMuzzleWorld: (o) => o.set(0.2, 1.45, -0.5),
    },
    { loadout, slots: loadout.length, seed: 'feel', defs: (id) => defs[id] ?? getWeaponDef(id) },
  );
  const fired: GameEvents['weapon:fired'][] = [];
  events.on('weapon:fired', (e) => fired.push({ ...e }));
  const frame = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      weapons.fixedUpdate(DT);
      arsenal.fixedUpdate(DT);
      weapons.update(DT);
      arsenal.update(DT, 1);
      weapons.updateVisuals(DT);
      input.endFrame();
    }
  };
  const equip = (): void => {
    for (let i = 0; i < 300 && weapons.state !== 'idle'; i++) frame();
  };
  return { events, input, player, combat, arsenal, weapons, fired, frame, equip };
}

describe('beam trigger rate', () => {
  for (const id of ['chainlightning', 'flamethrower'] as const) {
    it(`${id}: tapping the trigger never ticks faster than holding it`, () => {
      const def = precise(WEAPONS[id]);
      const t = setup({ [id]: def }, [id]);
      t.equip();
      t.combat.register(new FakeTarget({ x: 0, y: 0.35, z: -6 }, 1e9));
      const second = Math.round(1 / DT);
      // A macro / wheel-bound trigger: 2 ticks held, 1 released (20 presses/s) for one second.
      for (let i = 0; i < second; i++) {
        if (i % 3 === 2) t.input.release('fire');
        else if (i % 3 === 0) t.input.press('fire');
        t.frame();
      }
      t.input.release('fire');
      const ticks = t.fired.length;
      expect(ticks).toBeLessThanOrEqual(def.beam!.tickRate + 1);
    });
  }
});

describe('self damage of forged launchers', () => {
  it('a forge tier never raises the blast damage the shooter takes per trigger pull', () => {
    let checked = 0;
    for (const base of Object.values(WEAPONS) as WeaponDef[]) {
      const b = base.projectile?.explosion;
      if (!b || !(b.selfDamageScale > 0)) continue;
      const own = b.damage * b.selfDamageScale;
      for (const tier of [1, 2, 3]) {
        const d = resolveWeapon(base, { tier });
        const e = d.projectile!.explosion!;
        const split = d.special?.kind === 'splitShot' ? 1 + d.special.count : 1;
        expect(e.damage * e.selfDamageScale * split, `${base.id} t${tier}`).toBeLessThanOrEqual(own + 1e-6);
        // …while the blast itself hits enemies harder.
        expect(e.damage, `${base.id} t${tier}`).toBeGreaterThan(b.damage);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('suppressor and forged muzzle light (weapon:fired → VFX / audio)', () => {
  it('resolveWeapon: a suppressor marks the def; a forge tier tints the muzzle light by its look', () => {
    const rifle = WEAPONS.rifle as WeaponDef;
    expect(resolveWeapon(rifle, { attachments: ['suppressor'] }).suppressed).toBe(true);
    expect(resolveWeapon(rifle, { attachments: ['compensator'] }).suppressed).toBe(false);
    expect(resolveWeapon(rifle).suppressed).toBeUndefined();
    expect(resolveWeapon(rifle).vfx.muzzleLightColor).toBe(rifle.vfx.muzzleLightColor);
    for (const tier of [1, 2, 3]) {
      const look = getForgeLook(forgePaletteId(rifle, tier))!;
      expect(resolveWeapon(rifle, { tier }).vfx.muzzleLightColor, `t${tier}`).toBe(look.muzzleLight);
    }
    // A tier naming its own palette (RM-44 tier 3: void).
    const revolver = WEAPONS.revolver as WeaponDef;
    expect(resolveWeapon(revolver, { tier: 3 }).vfx.muzzleLightColor).toBe(FORGE_LOOKS.forgeVoid!.muzzleLight);
  });

  it('weapon:fired carries the effective light color and the suppressor', () => {
    const t = setup({}, ['pistol']);
    t.equip();
    t.input.tap('fire');
    t.frame(2);
    expect(t.fired.at(-1)!.suppressed).toBe(false);
    expect(t.fired.at(-1)!.muzzleLightColor).toBe(WEAPONS.pistol.vfx.muzzleLightColor);
    t.weapons.setWeaponMods('pistol', { tier: 1, attachments: ['suppressor'] });
    t.frame(30);
    t.input.tap('fire');
    t.frame(2);
    expect(t.fired.at(-1)!.suppressed).toBe(true);
    expect(t.fired.at(-1)!.muzzleLightColor).toBe(FORGE_LOOKS.forge1!.muzzleLight);
  });

  it('VfxBridge hands both to the muzzle effect', () => {
    const events = new EventBus<GameEvents>();
    const calls: [number, boolean | undefined][] = [];
    const noop = (): void => undefined;
    const bridge = new VfxBridge({
      events,
      vfx: {
        muzzle: (_p, color, _c, _a, _m, _d, suppressed) => void calls.push([color, suppressed]),
        impact: noop,
        muzzleTracer: noop,
        tracer: noop,
        beamShot: noop,
        explosion: noop,
        spawn: noop,
        applyGraphics: noop,
        applyAccessibility: noop,
        hideMuzzleFlash: noop,
      },
    });
    const O = { x: 0, y: 0, z: 0 };
    const shot = { weaponId: 'rifle', origin: O, direction: O, muzzle: O, shotIndex: 0, ammoInMag: 9, ads: false };
    events.emit('weapon:fired', shot);
    events.emit('weapon:fired', { ...shot, muzzleLightColor: 0x123456, suppressed: true });
    expect(calls).toEqual([
      [WEAPONS.rifle.vfx.muzzleLightColor, false],
      [0x123456, true],
    ]);
    bridge.dispose();
  });

  it('VfxSystem: a suppressed shot draws a smaller flash and a dimmer world light', () => {
    const rifle = WEAPONS.rifle;
    const shoot = (suppressed: boolean): { size: number; light: number } => {
      const render = fakeRender();
      const sockets = new FakeSockets(render.viewmodelCamera);
      const vfx = new VfxSystem({ render, settings: fakeSettings(), sockets });
      vfx.muzzle(rifle.vfx.muzzle, rifle.vfx.muzzleLightColor, null, false, O3, FWD, suppressed);
      vfx.update(1 / 60);
      const star = sockets.anchors.muzzle.children[0]!.children[0]!;
      const light = Math.max(...vfx.lights.lights.map((l) => l.intensity));
      vfx.dispose();
      return { size: star.scale.x, light };
    };
    const loud = shoot(false);
    const quiet = shoot(true);
    expect(quiet.size).toBeLessThan(loud.size * 0.8);
    expect(quiet.light).toBeGreaterThan(0);
    expect(quiet.light).toBeLessThan(loud.light * 0.5);
  });

  it('audio: a suppressed shot drops the tail, quiets the body and adds the can layer', () => {
    const events = new EventBus<GameEvents>();
    const plays: { id: string; volume: number; pitch: number }[] = [];
    const audio: AudioBridgeTarget = {
      unlocked: true,
      play: (id, o) => void plays.push({ id, volume: o?.volume ?? 1, pitch: o?.pitch ?? 1 }),
      startLoop: () => 1,
      stopLoop: () => {},
      has: () => true,
    } as unknown as AudioBridgeTarget;
    const bridge = new AudioEventBridge(
      events,
      audio,
      () => 100,
      () => 0.5,
    );
    const O = { x: 0, y: 0, z: 0 };
    const shot = { weaponId: 'rifle', origin: O, direction: O, muzzle: O, shotIndex: 0, ammoInMag: 20, ads: false };
    events.emit('weapon:fired', shot);
    const loud = plays.splice(0);
    events.emit('weapon:fired', { ...shot, suppressed: true });
    const quiet = plays.splice(0);
    const fire = WEAPONS.rifle.audio.fire;
    expect(loud.map((p) => p.id)).toEqual([...fire]);
    const tail = fire.find((id) => id.startsWith('weapon.tail'))!;
    expect(quiet.map((p) => p.id)).not.toContain(tail);
    expect(quiet.map((p) => p.id)).toContain(AUDIO.weapons.suppressed.id);
    const body = (list: typeof plays) => list.find((p) => p.id === fire[0])!;
    expect(body(quiet).volume).toBeLessThan(body(loud).volume * 0.5);
    expect(body(quiet).pitch).toBeGreaterThan(body(loud).pitch);
    bridge.dispose();
  });
});

describe('attachment mounts', () => {
  it('every weapon with a stock slot mounts stocks at its receiver, not the rear fallback', () => {
    const kit = new WeaponMaterialKit();
    const missing: string[] = [];
    for (const def of Object.values(WEAPONS) as WeaponDef[]) {
      if (!def.attachmentSlots.includes('stock')) continue;
      const m = createWeaponViewmodel(def.model, kit);
      if (!m) continue;
      if (!m.mounts.stock) missing.push(def.id);
      m.dispose();
    }
    expect(missing).toEqual([]);
    kit.dispose();
  });
});
