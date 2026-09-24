import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { RENDER } from '../defs/graphics';
import { ENGINE } from '../defs/engine';
import { TEST_ROOM_LAYOUT } from '../defs/level';
import { POSTFX } from '../defs/postfx';
import { CASINGS, DECAL_KINDS, SPRITES, VFX, VFX_EFFECTS, decalCapacity, getCasingDef } from '../defs/vfx';
import { getWeaponDef } from '../defs/weapons';
import { DustParticles } from '../render/vfx/DustParticles';
import { VolumetricCone } from '../render/vfx/VolumetricCone';
import { SettingsStore } from '../save/SettingsStore';
import { createDefaultSettings } from '../save/settingsSchema';
import { CasingSystem } from './CasingSystem';
import { DecalSystem } from './DecalSystem';
import { createDecalAtlas } from './decalAtlas';
import { createEmitContext } from './emit';
import { LightPool, cutoffWindow } from './LightPool';
import { MuzzleFlash } from './MuzzleFlash';
import { ParticleSystem } from './ParticleSystem';
import { ShockwaveEffect } from './ShockwaveEffect';
import { createSpriteAtlas } from './spriteAtlas';
import { FakePhysics, FakeSockets, fakeRender, seeded } from './testFakes';
import { TracerSystem } from './TracerSystem';
import { VfxBridge, landingScale, type VfxBridgeTarget } from './VfxBridge';
import { createVfxCommands } from './vfxCommands';
import { VfxSystem, createVfxAtlases } from './VfxSystem';

const atlas = createSpriteAtlas();

function settings(): SettingsStore {
  return new SettingsStore(new EventBus<GameEvents>(), createDefaultSettings(), () => undefined);
}

describe('ParticleSystem (GPU side)', () => {
  it('draws after fog on the volumetric layer without writing depth', () => {
    const ps = new ParticleSystem(atlas, seeded(1));
    const meshes = ps.object.children as THREE.Mesh[];
    expect(meshes).toHaveLength(2);
    for (const m of meshes) {
      expect(m.layers.isEnabled(RENDER.volumetricLayer)).toBe(true);
      expect(m.layers.test(new THREE.PerspectiveCamera().layers)).toBe(false);
      const mat = m.material as THREE.ShaderMaterial;
      expect(mat.depthWrite).toBe(false);
      expect(mat.transparent).toBe(true);
      expect(mat.uniforms.fogParams).toBeDefined();
      // Velocity-stretched quads are built in a rotated basis; never cull them by winding.
      expect(mat.side).toBe(THREE.DoubleSide);
      expect(mat.vertexShader).toContain('vec2 perp = vec2(axis.y, -axis.x)');
      expect(mat.uniforms.uMinPx!.value).toBeGreaterThan(0);
    }
    ps.dispose();
  });

  it('composites lit smoke before all additive light on the volumetric layer', () => {
    const ps = new ParticleSystem(atlas, seeded(1));
    const byName = (name: string): THREE.Object3D => ps.object.getObjectByName(name)!;
    const lit = byName('VfxParticlesLit');
    const additive = byName('VfxParticlesAdditive');
    const time = { value: 0 };
    const cone = new VolumetricCone({
      apex: { x: 0, y: 5, z: 0 },
      direction: { x: 0, y: -1, z: 0 },
      angle: 0.4,
      length: 4,
      color: new THREE.Color(1, 1, 1),
      intensity: 0.3,
      floorY: 0,
      time,
    });
    const dust = new DustParticles({ regions: TEST_ROOM_LAYOUT.dust, maxCount: 8, time });
    const tracers = new TracerSystem();
    // Smoke drawn after the cones would dim a light shaft even when it is far behind it.
    for (const o of [cone.mesh, dust.points, additive, tracers.mesh]) {
      expect(lit.renderOrder, o.name).toBeLessThan(o.renderOrder);
    }
    expect(additive.renderOrder).toBeGreaterThan(Math.max(cone.mesh.renderOrder, dust.points.renderOrder));
    cone.dispose();
    dust.dispose();
    tracers.dispose();
    ps.dispose();
  });

  it('emits, simulates and uploads only the live instance range', () => {
    const ps = new ParticleSystem(atlas, seeded(2));
    const ctx = createEmitContext();
    ctx.y = 1;
    ctx.nx = 1;
    ctx.ny = 0;
    ps.emit(VFX_EFFECTS['impact.concrete'], ctx);
    expect(ps.count).toBeGreaterThan(0);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 1, 5);
    cam.updateMatrixWorld();
    ps.update(1 / 60, cam);
    const [lit, add] = ps.object.children as THREE.Mesh[];
    const litGeo = lit!.geometry as THREE.InstancedBufferGeometry;
    const addGeo = add!.geometry as THREE.InstancedBufferGeometry;
    expect(litGeo.instanceCount).toBe(ps.alphaBuffer.count);
    expect(addGeo.instanceCount).toBe(ps.additiveBuffer.count);
    const iPos = litGeo.getAttribute('iPos') as THREE.InstancedBufferAttribute;
    expect(iPos.updateRanges).toEqual([{ start: 0, count: ps.alphaBuffer.count * 4 }]);
    expect(lit!.visible).toBe(true);
    // Everything dies eventually.
    for (let i = 0; i < 300; i++) ps.update(1 / 30, cam);
    expect(ps.count).toBe(0);
    expect(lit!.visible).toBe(false);
    ps.dispose();
  });

  it('draws a new effect in its spawn state first, at any frame rate', () => {
    const at = (dt: number): number => {
      const ps = new ParticleSystem(atlas, seeded(3));
      const ctx = createEmitContext();
      ctx.nz = 1;
      ctx.ny = 0;
      ps.emit(VFX_EFFECTS['impact.metal'], ctx);
      const buf = ps.additiveBuffer;
      let star = -1;
      for (let i = 0; i < buf.count; i++) if (buf.cell[i] === SPRITES.indexOf('star')) star = i;
      const r0 = buf.r0[star]!;
      ps.update(dt, new THREE.PerspectiveCamera());
      const brightness = buf.r0[star]! === r0 && buf.age[star] === 0 ? 1 : 0;
      ps.dispose();
      return brightness;
    };
    expect(at(1 / 144)).toBe(1);
    expect(at(1 / 30)).toBe(1);
  });

  it('follows the quality budget (0 = off)', () => {
    const ps = new ParticleSystem(atlas, seeded(3));
    ps.setBudget(0);
    ps.emit(VFX_EFFECTS['explosion.frag'], createEmitContext());
    expect(ps.count).toBe(0);
    ps.setBudget(0.4);
    expect(ps.additiveBuffer.capacity).toBe(Math.round(VFX.particles.additiveCapacity * 0.4));
    ps.dispose();
  });
});

describe('DecalSystem', () => {
  const decalAtlas = createDecalAtlas();

  it('is one lit instanced mesh set up for CSM, with atlas/fade patches that compile to valid chunks', () => {
    const render = fakeRender();
    const time = { value: 0 };
    const d = new DecalSystem(decalAtlas, render, 16, 8, time);
    const mat = d.mesh.material as THREE.MeshStandardMaterial;
    expect(render.setupCalls).toContain(mat);
    expect(mat.depthWrite).toBe(false);
    expect(mat.polygonOffset).toBe(true);
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    mat.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('vDecalAlpha =');
    expect(shader.vertexShader).toContain('attribute vec4 aDecal;');
    expect(shader.fragmentShader).toContain('diffuseColor.a *= vDecalAlpha;');
    expect(shader.fragmentShader).toContain('totalEmissiveRadiance += vDecalGlow');
    expect(shader.uniforms.uDecalTime).toBe(time);
    expect(mat.customProgramCacheKey()).toBe('vfx-decals-v1');
    d.dispose();
  });

  it('writes instances into a ring, fades the soon-overwritten ones and rejects bad input', () => {
    const render = fakeRender();
    const time = { value: 5 };
    const d = new DecalSystem(decalAtlas, render, 64, 30, time);
    const n = { x: 0, y: 0, z: 1 };
    expect(d.add('bullet.metal', { x: 1, y: 2, z: 3 }, n, 1, 0, 0)).toBe(true);
    expect(d.count).toBe(1);
    expect(d.mesh.count).toBe(1);
    const m = new THREE.Matrix4();
    d.mesh.getMatrixAt(0, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    expect(p.z).toBeCloseTo(3 + VFX.decals.normalOffset, 6);
    expect(d.add('nope', { x: 0, y: 0, z: 0 }, n)).toBe(false);
    expect(d.add('blood', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(false);
    expect(d.add('blood', { x: Number.NaN, y: 0, z: 0 }, n)).toBe(false);
    const attr = d.mesh.geometry.getAttribute('aDecal') as THREE.InstancedBufferAttribute;
    for (let i = 0; i < 30; i++) d.add('scorch', { x: i, y: 0, z: 0 }, n, 1, 0, 0.5);
    expect(d.count).toBe(30);
    // Some decal ahead of the head is fading: its die time is set.
    let fading = 0;
    for (let i = 0; i < 30; i++) if ((attr.array as Float32Array)[i * 4 + 2]! < 1e8) fading++;
    expect(fading).toBeGreaterThan(0);
    d.setCapacity(decalCapacity('low'));
    expect(d.count).toBe(0);
    expect(d.mesh.visible).toBe(false);
    d.dispose();
  });
});

describe('TracerSystem', () => {
  it('spawns ribbons on the volumetric layer and expires them within 0.1 s', () => {
    const t = new TracerSystem();
    expect(t.mesh.layers.isEnabled(RENDER.volumetricLayer)).toBe(true);
    expect(t.spawn({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -30 }, 0xffffff)).toBe(true);
    expect(t.spawn({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 0xffffff)).toBe(false);
    t.update(1 / 60);
    const geo = t.mesh.geometry as THREE.InstancedBufferGeometry;
    expect(geo.instanceCount).toBe(1);
    const b = geo.getAttribute('iB') as THREE.InstancedBufferAttribute;
    expect(b.getZ(0)).toBeLessThan(0);
    expect(b.getZ(0)).toBeGreaterThanOrEqual(-30);
    for (let i = 0; i < 8; i++) t.update(1 / 60);
    expect(t.count).toBe(0);
    t.dispose();
  });
});

describe('LightPool', () => {
  it('keeps a constant light count (no recompiles) and flashes up to peak', () => {
    const scene = new THREE.Scene();
    const pool = new LightPool(scene, seeded(1));
    const count = (): number => scene.children.filter((o) => (o as THREE.PointLight).isPointLight).length;
    expect(count()).toBe(VFX.lights.count);
    const def = VFX_EFFECTS['muzzle.rifle'].light;
    expect(pool.flash(def, { x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: -1 }, 1, 0xff0000)).toBe(true);
    const lit = pool.lights.find((l) => l.intensity > 0)!;
    expect(lit.intensity).toBe(def.intensity);
    expect(lit.color.r).toBe(1);
    expect(lit.color.g).toBe(0);
    pool.update(1 / 60);
    pool.endFrame();
    expect(lit.intensity).toBe(def.intensity);
    for (let i = 0; i < 10; i++) {
      pool.update(1 / 60);
      pool.endFrame();
    }
    expect(lit.intensity).toBe(0);
    expect(lit.visible).toBe(true);
    expect(count()).toBe(VFX.lights.count);
    pool.dispose();
    expect(count()).toBe(0);
  });

  it('dims flashes with reduced flashing', () => {
    const pool = new LightPool(new THREE.Scene(), seeded(1));
    pool.setIntensityScale(0.5);
    const def = VFX_EFFECTS['muzzle.pistol'].light;
    pool.flash(def, { x: 0, y: 0, z: 0 }, null);
    expect(Math.max(...pool.lights.map((l) => l.intensity))).toBeCloseTo(def.intensity * 0.5, 5);
  });
});

describe('MuzzleFlash', () => {
  it('shows an HDR flash on the socket for its duration', () => {
    const flash = new MuzzleFlash(atlas, seeded(4));
    const anchor = new THREE.Object3D();
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0.1, 0.1, 0.5);
    cam.updateMatrixWorld();
    flash.attach(anchor);
    const def = VFX_EFFECTS['muzzle.shotgun'].flash;
    flash.fire(def, false);
    expect(flash.visible).toBe(true);
    flash.root.traverse((o) => expect(o.layers.isEnabled(ENGINE.viewmodelLayer)).toBe(true));
    const mat = (flash.root.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    expect(mat.color.r).toBeGreaterThan(POSTFX.bloom.luminanceThreshold);
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    flash.update(def.duration * 0.5, cam);
    expect(flash.visible).toBe(true);
    flash.update(def.duration, cam);
    expect(flash.visible).toBe(false);
    // Detached flashes never show.
    flash.attach(null);
    flash.fire(def, true);
    expect(flash.visible).toBe(false);
    flash.dispose();
  });
});

describe('CasingSystem', () => {
  it('ejects pooled instanced casings that land on the probed floor and clink', () => {
    const physics = new FakePhysics();
    const clinks: string[] = [];
    const render = fakeRender();
    const cs = new CasingSystem(8, render, physics.asApi(), seeded(5), (_p, sound) => clinks.push(sound));
    expect(render.setupCalls).toHaveLength(2);
    const up = { x: 0, y: 1, z: 0 };
    const fwd = { x: 0, y: 0, z: -1 };
    const zero = { x: 0, y: 0, z: 0 };
    expect(cs.eject('casing.rifle', { x: 0, y: 1.4, z: 0 }, { x: 1, y: 0, z: 0 }, fwd, zero)).toBe(true);
    expect(cs.eject('casing.shell', { x: 0, y: 1.4, z: 0 }, up, fwd, zero)).toBe(true);
    expect(cs.eject('casing.laser', { x: 0, y: 1.4, z: 0 }, up, fwd, zero)).toBe(false);
    for (let i = 0; i < 120; i++) cs.update(1 / 60);
    expect(clinks).toContain('weapon.casing.brass');
    expect(clinks).toContain('weapon.casing.shell');
    const [brass, shell] = cs.object.children as THREE.InstancedMesh[];
    expect(brass!.count).toBe(1);
    expect(shell!.count).toBe(1);
    const m = new THREE.Matrix4();
    brass!.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).y).toBeCloseTo(0.0055, 3);
    cs.clear();
    expect(brass!.count).toBe(0);
    cs.dispose();
  });

  it('re-probes the floor while flying: casings drop off ledges instead of resting in mid-air', () => {
    const physics = new FakePhysics();
    // Mezzanine floor at 3.5 m ending at x = 0.3, the arena floor (y = 0) below it.
    physics.planes.push({
      normal: new THREE.Vector3(0, 1, 0),
      d: 3.5,
      data: { kind: 'world', surface: 'metal' },
      contains: (p) => p.x < 0.3,
    });
    const cs = new CasingSystem(4, fakeRender(), physics.asApi(), seeded(3));
    const zero = { x: 0, y: 0, z: 0 };
    const fwd = { x: 0, y: 0, z: -1 };
    expect(cs.eject('casing.rifle', { x: 0, y: 4.95, z: 0 }, { x: 1, y: 0, z: 0 }, fwd, zero)).toBe(true);
    expect(cs.sim.floorY[0]).toBeCloseTo(3.5, 5);
    for (let i = 0; i < 180; i++) cs.update(1 / 60);
    expect(cs.count).toBe(1);
    expect(cs.sim.px[0]).toBeGreaterThan(0.3);
    expect(cs.sim.rest[0]).toBeGreaterThanOrEqual(0);
    expect(cs.sim.py[0]).toBeCloseTo(CASINGS['casing.rifle'].radius, 3);
    cs.dispose();
  });
});

describe('ShockwaveEffect', () => {
  it('runs waves for their duration, projects them and skips epicenters behind the camera', () => {
    const cam = new THREE.PerspectiveCamera(70, 1, 0.05, 400);
    cam.updateMatrixWorld();
    const fx = new ShockwaveEffect(cam);
    const count = (): number => fx.uniforms.get('count')!.value as number;
    expect(fx.active).toBe(false);
    fx.trigger({ x: 0, y: 0, z: -10 }, 6, 1);
    expect(fx.active).toBe(true);
    fx.advance(0.1);
    expect(count()).toBe(1);
    const w = (fx.uniforms.get('waves')!.value as THREE.Vector4[])[0]!;
    expect(w.x).toBeCloseTo(0.5, 5);
    expect(w.y).toBeCloseTo(0.5, 5);
    expect(w.z).toBeGreaterThan(0);
    expect(w.w).toBeGreaterThan(0);
    fx.trigger({ x: 0, y: 0, z: 10 }, 6, 1); // behind
    fx.advance(0.01);
    expect(count()).toBe(1);
    fx.advance(POSTFX.shockwave.duration);
    expect(fx.active).toBe(false);
    expect(count()).toBe(0);
    // Invalid triggers are ignored; more waves than slots reuse the oldest.
    fx.trigger({ x: Number.NaN, y: 0, z: 0 }, 5);
    fx.trigger({ x: 0, y: 0, z: -5 }, 0);
    expect(fx.active).toBe(false);
    for (let i = 0; i < POSTFX.shockwave.maxWaves + 2; i++) fx.trigger({ x: 0, y: 0, z: -5 }, 3);
    fx.advance(0.01);
    expect(count()).toBe(POSTFX.shockwave.maxWaves);
    fx.dispose();
  });
});

describe('VfxSystem', () => {
  function setup(): {
    vfx: VfxSystem;
    render: ReturnType<typeof fakeRender>;
    physics: FakePhysics;
    events: EventBus<GameEvents>;
    sockets: FakeSockets;
    shocks: number[];
    shakes: number[];
  } {
    const render = fakeRender();
    const physics = new FakePhysics();
    const events = new EventBus<GameEvents>();
    const sockets = new FakeSockets(render.viewmodelCamera);
    const shocks: number[] = [];
    const shakes: number[] = [];
    events.on('camera:shake', ({ trauma }) => shakes.push(trauma));
    const vfx = new VfxSystem({
      render,
      settings: settings(),
      physics: physics.asApi(),
      events,
      sockets,
      shockwave: (_p, radius) => shocks.push(radius),
      random: seeded(7),
    });
    return { vfx, render, physics, events, sockets, shocks, shakes };
  }

  it('adds everything to the scenes up front (constant light count)', () => {
    const { vfx, render, sockets } = setup();
    let lights = 0;
    render.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) lights++;
    });
    expect(lights).toBe(VFX.lights.count);
    // One flash light in the viewmodel scene too (explosions light the weapon).
    const vmLights = (): number =>
      render.viewmodelScene.children.filter((o) => (o as THREE.Light).isLight).length;
    expect(vmLights()).toBe(1);
    expect(vfx.muzzleFlash.root.parent).toBe(sockets.anchors.muzzle);
    expect(vfx.stats).toEqual({ particles: 0, decals: 0, lights: 0 });
    vfx.dispose();
    let after = 0;
    render.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) after++;
    });
    expect(after).toBe(0);
    expect(vmLights()).toBe(0);
  });

  it('impacts spawn the surface effect, a decal (not on props) and a light', () => {
    const { vfx, physics } = setup();
    vfx.impact('metal', 'impact.bullet', 'bullet', { x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 1 }, true);
    vfx.update(1 / 60);
    expect(vfx.stats.particles).toBeGreaterThan(0);
    expect(vfx.stats.decals).toBe(1);
    expect(vfx.stats.lights).toBe(1);
    // A decal on a dynamic prop is skipped.
    physics.planes.push({
      normal: new THREE.Vector3(0, 0, 1),
      d: -8,
      data: { kind: 'prop', surface: 'metal' },
    });
    vfx.impact('metal', 'impact.bullet', 'bullet', { x: 0, y: 1, z: -8 }, { x: 0, y: 0, z: 1 }, true);
    expect(vfx.stats.decals).toBe(1);
    // decal: false (bodies) and melee profiles leave no decal; explosions are not surface impacts.
    vfx.impact('concrete', 'impact.melee', 'melee', { x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 1 }, true);
    vfx.impact('concrete', null, 'bullet', { x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 1 }, false);
    const before = vfx.stats.particles;
    vfx.impact('concrete', null, 'explosion', { x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 1 }, true);
    expect(vfx.stats.particles).toBe(before);
    expect(vfx.stats.decals).toBe(1);
    vfx.dispose();
  });

  it('flesh hits splatter blood on the wall behind the body', () => {
    const { vfx, physics } = setup();
    physics.planes.push({
      normal: new THREE.Vector3(0, 0, 1),
      d: -7,
      data: { kind: 'world', surface: 'concrete' },
    });
    for (let i = 0; i < 20; i++) {
      vfx.impact('flesh', 'impact.bullet', 'bullet', { x: 0, y: 1.2, z: -5.5 }, { x: 0, y: 0, z: 1 }, false);
    }
    expect(vfx.stats.decals).toBeGreaterThan(0);
    vfx.dispose();
  });

  it('resolves shots at the sockets in update(): flash, world light, smoke and casings', () => {
    const { vfx } = setup();
    const rifle = getWeaponDef('rifle')!;
    vfx.muzzle(
      rifle.vfx.muzzle,
      rifle.vfx.muzzleLightColor,
      rifle.vfx.casing,
      false,
      { x: 0, y: 1.5, z: -1 },
      { x: 0, y: 0, z: -1 },
    );
    expect(vfx.muzzleFlash.visible).toBe(false);
    vfx.update(1 / 60);
    expect(vfx.muzzleFlash.visible).toBe(true);
    expect(vfx.stats.lights).toBe(1);
    const light = vfx.lights.lights.find((l) => l.intensity > 0)!;
    // Socket position (not the fire-time muzzle), the light a little ahead along the aim.
    const ahead = VFX_EFFECTS['muzzle.rifle'].light.offset;
    expect(light.position.z).toBeCloseTo(-0.6 - ahead, 5);
    // Brass leaves the port on the bolt stroke, at least ejectDelay (18 ms) after the flash.
    expect(vfx.casings.count).toBe(0);
    vfx.update(1 / 60);
    expect(vfx.casings.count).toBe(0);
    vfx.update(1 / 60);
    expect(vfx.casings.count).toBe(1);
    // Shotgun hulls eject on the pump stroke.
    const sg = getWeaponDef('shotgun')!;
    vfx.muzzle(
      sg.vfx.muzzle,
      sg.vfx.muzzleLightColor,
      sg.vfx.casing,
      false,
      { x: 0, y: 1.5, z: -1 },
      { x: 0, y: 0, z: -1 },
    );
    vfx.update(1 / 60);
    expect(vfx.casings.count).toBe(1);
    for (let i = 0; i < 20; i++) vfx.update(1 / 60);
    expect(vfx.casings.count).toBe(2);
    expect(vfx.muzzleFlash.visible).toBe(false);
    vfx.dispose();
  });

  it('never ejects a delayed casing in the frame of its full-peak muzzle light, at any frame rate', () => {
    const { vfx } = setup();
    const pistol = getWeaponDef('pistol')!;
    const delay = getCasingDef(pistol.vfx.casing!)!.ejectDelay;
    const fire = (): void =>
      vfx.muzzle(
        pistol.vfx.muzzle,
        pistol.vfx.muzzleLightColor,
        pistol.vfx.casing,
        false,
        { x: 0, y: 1.5, z: -1 },
        { x: 0, y: 0, z: -1 },
      );
    // Frames longer than the delay (30 / 20 fps): the brass appears one frame after the flash.
    for (const dt of [1 / 30, 1 / 20]) {
      expect(dt).toBeGreaterThan(delay);
      vfx.clear();
      fire();
      vfx.update(dt);
      expect(vfx.muzzleFlash.visible).toBe(true);
      expect(vfx.casings.count).toBe(0);
      vfx.update(dt);
      expect(vfx.casings.count).toBe(1);
    }
    // 144 Hz: on the first frame at least `delay` after the shot's frame.
    vfx.clear();
    fire();
    let frames = 0;
    while (vfx.casings.count === 0 && frames < 30) {
      vfx.update(1 / 144);
      frames++;
    }
    expect(frames).toBe(1 + Math.ceil(delay * 144));
    vfx.dispose();
  });

  it('explosions: particles, light, distance-scaled shake + hit pulse, shockwave and a scorch mark', () => {
    const { vfx, events, shocks, shakes } = setup();
    const pulses: number[] = [];
    events.on('fx:hitPulse', ({ strength }) => pulses.push(strength));
    vfx.explosion({ x: 0, y: 0.5, z: -6 }, 4, 'fire');
    expect(vfx.stats.particles).toBeGreaterThan(50);
    expect(vfx.stats.decals).toBe(1);
    expect(shocks).toHaveLength(1);
    expect(shocks[0]).toBeCloseTo(4 * VFX_EFFECTS['explosion.frag'].shockwave.radiusScale, 6);
    expect(shakes).toHaveLength(1);
    expect(shakes[0]).toBeGreaterThan(0);
    expect(shakes[0]).toBeLessThan(1);
    expect(pulses).toHaveLength(1);
    expect(pulses[0]).toBeGreaterThan(0);
    expect(pulses[0]).toBeLessThan(VFX_EFFECTS['explosion.frag'].hitPulse.strength);
    // Elemental explosions tint their light.
    const ice = vfx.lights.lights.find((l) => l.intensity > 0)!;
    expect(ice.color.b).toBeLessThan(ice.color.r); // fire: warm
    vfx.lights.clear();
    vfx.explosion({ x: 0, y: 0.5, z: -6 }, 4, 'ice');
    const cold = vfx.lights.lights.find((l) => l.intensity > 0)!;
    expect(cold.color.b).toBeGreaterThan(cold.color.r);
    vfx.explosion({ x: 0, y: 0.5, z: -500 }, 4);
    expect(shakes).toHaveLength(2); // the far one is too far away to shake
    expect(pulses).toHaveLength(2);
    vfx.explosion({ x: Number.NaN, y: 0, z: 0 }, 4);
    vfx.explosion({ x: 0, y: 0, z: 0 }, 0);
    expect(shocks).toHaveLength(3);
    vfx.dispose();
  });

  it('keeps scorch marks off dynamic props and shrinks them to fit ledges', () => {
    const { vfx, physics } = setup();
    const up = new THREE.Vector3(0, 1, 0);
    // A crate top at 0.5 m: debris still bounces on it, but a scorch would float once it moves.
    physics.planes.push({
      normal: up,
      d: 0.5,
      data: { kind: 'prop', surface: 'metal' },
      contains: (p) => Math.abs(p.x - 5) < 0.5 && Math.abs(p.z + 6) < 0.5,
    });
    vfx.explosion({ x: 5, y: 1.2, z: -6 }, 4);
    expect(vfx.stats.particles).toBeGreaterThan(0);
    expect(vfx.stats.decals).toBe(0);
    // Mezzanine at 3.5 m ending at x = 0: near the edge the scorch shrinks, right at it there is none.
    physics.planes.push({
      normal: up,
      d: 3.5,
      data: { kind: 'world', surface: 'concrete' },
      contains: (p) => p.x < 0,
    });
    vfx.explosion({ x: -0.7, y: 4, z: -6 }, 4);
    expect(vfx.stats.decals).toBe(1);
    const m = new THREE.Matrix4();
    vfx.decals.mesh.getMatrixAt(0, m);
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    m.decompose(pos, new THREE.Quaternion(), scale);
    expect(pos.y).toBeCloseTo(3.5, 2);
    const full = VFX_EFFECTS['explosion.frag'].groundDecal.sizePerScale * DECAL_KINDS.scorch.size[0];
    expect(scale.x).toBeGreaterThan(0);
    expect(scale.x).toBeLessThan(full);
    vfx.explosion({ x: -0.05, y: 4, z: -6 }, 4);
    expect(vfx.stats.decals).toBe(1);
    // On open floor the full size fits.
    vfx.explosion({ x: -8, y: 4, z: -6 }, 4);
    expect(vfx.stats.decals).toBe(2);
    vfx.decals.mesh.getMatrixAt(1, m);
    m.decompose(pos, new THREE.Quaternion(), scale);
    expect(scale.x).toBeGreaterThanOrEqual(full);
    vfx.dispose();
  });

  it('lights the viewmodel with nearby flashes, but not with its own muzzle light', () => {
    const { vfx, render } = setup();
    const vl = vfx.lights.viewmodelLight!;
    expect(vl.parent).toBe(render.viewmodelScene);
    const rifle = getWeaponDef('rifle')!;
    vfx.muzzle(
      rifle.vfx.muzzle,
      rifle.vfx.muzzleLightColor,
      null,
      false,
      { x: 0, y: 1.5, z: -1 },
      { x: 0, y: 0, z: -1 },
    );
    vfx.update(1 / 60);
    expect(vfx.stats.lights).toBe(1);
    expect(vl.intensity).toBe(0);
    // 2 m in front of the eye (0, 1.6, 0): pulled in to maxDistance, same irradiance at the eye.
    vfx.explosion({ x: 0, y: 1.6, z: -2 }, 4);
    vfx.update(1 / 60);
    const world = vfx.lights.lights.reduce((a, b) => (b.intensity > a.intensity ? b : a));
    const d = world.position.distanceTo(new THREE.Vector3(0, 1.6, 0));
    const cfg = VFX.lights.viewmodel;
    expect(d).toBeGreaterThan(cfg.maxDistance);
    expect(vl.position.length()).toBeCloseTo(cfg.maxDistance, 5);
    expect(vl.position.z).toBeLessThan(0);
    expect(vl.color.equals(world.color)).toBe(true);
    const irradiance = (world.intensity * cutoffWindow(d, world.distance)) / d ** 2;
    expect(vl.intensity / cfg.maxDistance ** 2).toBeCloseTo(irradiance * cfg.gain, 4);
    // Dark again once the flash is over.
    for (let i = 0; i < 60; i++) vfx.update(1 / 60);
    expect(vl.intensity).toBe(0);
    vfx.dispose();
    expect(vl.parent).toBeNull();
  });

  it('follows the quality settings and clears', () => {
    const { vfx } = setup();
    const g = createDefaultSettings().graphics;
    vfx.applyGraphics({ ...g, particles: 'off' });
    vfx.spawn('impact.metal', { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(vfx.stats.particles).toBe(0);
    expect(vfx.decals.capacity).toBe(decalCapacity('off'));
    vfx.applyGraphics({ ...g, particles: 'ultra' });
    vfx.spawn('impact.metal', { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 });
    vfx.tracer({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -20 });
    vfx.update(1 / 60);
    expect(vfx.stats.particles).toBeGreaterThan(0);
    vfx.clear();
    expect(vfx.stats).toEqual({ particles: 0, decals: 0, lights: 0 });
    // Unknown ids never throw.
    vfx.spawn('does.not.exist', { x: 0, y: 0, z: 0 });
    vfx.decal('paint', { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    vfx.muzzle('muzzle.laser', 0, 'casing.laser', false, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
    vfx.update(1 / 60);
    vfx.dispose();
    vfx.update(1 / 60);
  });

  it('warms up every VFX draw call invisibly in one real render, then restores', () => {
    const { vfx, render } = setup();
    const drawn: string[] = [];
    render.onRender = () => {
      render.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.visible || !m.name.startsWith('Vfx')) return;
        const geo = m.geometry as THREE.InstancedBufferGeometry;
        const n = (m as THREE.InstancedMesh).isInstancedMesh
          ? (m as THREE.InstancedMesh).count
          : geo.instanceCount;
        if (n > 0) drawn.push(m.name);
      });
      expect(vfx.muzzleFlash.visible).toBe(true);
      const flashMat = (vfx.muzzleFlash.root.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
      expect(flashMat.color.getHex()).toBe(0);
    };
    vfx.warmup();
    expect(drawn.sort()).toEqual(
      [
        'VfxCasings:brass',
        'VfxCasings:shell',
        'VfxDecals',
        'VfxParticlesAdditive',
        'VfxParticlesLit',
        'VfxTracers',
      ].sort(),
    );
    render.scene.traverse((o) => {
      if (o.name.startsWith('Vfx') && (o as THREE.Mesh).isMesh) expect(o.visible, o.name).toBe(false);
    });
    expect(vfx.muzzleFlash.visible).toBe(false);
    expect(vfx.stats).toEqual({ particles: 0, decals: 0, lights: 0 });
    vfx.dispose();
  });

  it('reports volumetric-layer content only while particles/tracers live or the warm-up renders', () => {
    const { vfx, render } = setup();
    expect(vfx.hasVolumetricContent).toBe(false);
    let duringWarmup = false;
    render.onRender = () => {
      duringWarmup = vfx.hasVolumetricContent;
    };
    vfx.warmup();
    expect(duringWarmup).toBe(true);
    expect(vfx.hasVolumetricContent).toBe(false);

    vfx.spawn('impact.metal', { x: 0, y: 1, z: -3 }, { x: 0, y: 0, z: 1 });
    expect(vfx.hasVolumetricContent).toBe(true);
    for (let i = 0; i < 20 && vfx.hasVolumetricContent; i++) vfx.update(0.5);
    expect(vfx.hasVolumetricContent).toBe(false);

    vfx.tracer({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -20 });
    expect(vfx.hasVolumetricContent).toBe(true);
    for (let i = 0; i < 20 && vfx.hasVolumetricContent; i++) vfx.update(0.5);
    expect(vfx.hasVolumetricContent).toBe(false);
    vfx.dispose();
  });

  it('dims flash emitters and lights with reduced flashing', () => {
    const { vfx } = setup();
    const a = createDefaultSettings().accessibility;
    vfx.spawn('impact.metal', { x: 0, y: 1, z: -3 }, { x: 0, y: 0, z: 1 });
    const buf = vfx.particles.additiveBuffer;
    const star = (): number => {
      for (let i = 0; i < buf.count; i++) if (buf.cell[i] === SPRITES.indexOf('star')) return buf.r0[i]!;
      return -1;
    };
    const full = star();
    vfx.clear();
    vfx.applyAccessibility({ ...a, reduceFlashing: true });
    vfx.spawn('impact.metal', { x: 0, y: 1, z: -3 }, { x: 0, y: 0, z: 1 });
    expect(star()).toBeCloseTo(full * VFX.lights.reducedFlashingScale, 5);
    vfx.dispose();
  });

  it('keeps muzzle effects and casings in front of a wall the player hugs', () => {
    const { vfx, physics, sockets } = setup();
    // Wall 0.35 m in front of the eye (camera at z = 0 looking down -Z): the mapped muzzle socket
    // (z = -0.6) is inside it.
    physics.planes.push({
      normal: new THREE.Vector3(0, 0, 1),
      d: -0.35,
      data: { kind: 'world', surface: 'concrete' },
    });
    const rifle = getWeaponDef('rifle')!;
    vfx.muzzle(rifle.vfx.muzzle, 0, rifle.vfx.casing, false, sockets.world.muzzle, { x: 0, y: 0, z: -1 });
    vfx.update(1 / 60);
    const light = vfx.lights.lights.find((l) => l.intensity > 0)!;
    // Lights this side of the wall only, never right on it (no hotspot).
    expect(light.position.z).toBeGreaterThanOrEqual(-0.35 + VFX.socketProbe.backoff - 1e-6);
    vfx.update(1 / 60);
    vfx.update(1 / 60);
    const sim = vfx.casings.sim;
    let casing = -1;
    for (let i = 0; i < sim.capacity; i++) if (sim.alive[i]) casing = i;
    expect(sim.pz[casing]).toBeGreaterThan(-0.35);
    vfx.dispose();
  });

  it('uses the weapon impact profile for shots only (a melee bash leaves no bullet hole)', () => {
    const { vfx } = setup();
    const p = { x: 0, y: 1, z: -5 };
    const n = { x: 0, y: 0, z: 1 };
    vfx.impact('concrete', 'impact.bullet', 'melee', p, n, true);
    expect(vfx.stats.decals).toBe(0);
    vfx.impact('concrete', 'impact.bullet', 'bullet', p, n, true);
    expect(vfx.stats.decals).toBe(1);
    vfx.dispose();
  });

  it('can get its viewmodel sockets after construction', () => {
    const render = fakeRender();
    const vfx = new VfxSystem({ render, settings: settings(), random: seeded(2) });
    expect(vfx.muzzleFlash.root.parent).toBeNull();
    // Without sockets a shot uses the fire-time muzzle.
    vfx.muzzle('muzzle.pistol', 0, null, false, { x: 1, y: 1, z: -2 }, { x: 0, y: 0, z: -1 });
    vfx.update(1 / 60);
    expect(vfx.muzzleFlash.visible).toBe(false);
    expect(vfx.lights.lights.find((l) => l.intensity > 0)!.position.x).toBeCloseTo(1, 5);
    const sockets = new FakeSockets(render.viewmodelCamera);
    vfx.setSockets(sockets);
    expect(vfx.muzzleFlash.root.parent).toBe(sockets.anchors.muzzle);
    vfx.muzzle('muzzle.pistol', 0, null, false, { x: 1, y: 1, z: -2 }, { x: 0, y: 0, z: -1 });
    vfx.update(1 / 60);
    expect(vfx.muzzleFlash.visible).toBe(true);
    vfx.setSockets(null);
    expect(vfx.muzzleFlash.root.parent).toBeNull();
    expect(vfx.muzzleFlash.visible).toBe(false);
    vfx.dispose();
  });

  it('dims the muzzle flash sprite with reduced flashing and scales the shockwave by screen shake', () => {
    const { vfx, shocks, sockets } = setup();
    const a = createDefaultSettings().accessibility;
    const mat = (vfx.muzzleFlash.root.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    const fire = (): number => {
      vfx.muzzle('muzzle.pistol', 0, null, false, sockets.world.muzzle, { x: 0, y: 0, z: -1 });
      vfx.update(1 / 60);
      const r = mat.color.r;
      vfx.clear();
      return r;
    };
    const full = fire();
    vfx.applyAccessibility({ ...a, reduceFlashing: true });
    expect(fire()).toBeCloseTo(full * VFX.lights.reducedFlashingScale, 4);

    const strengths: number[] = [];
    const render = fakeRender();
    const v2 = new VfxSystem({
      render,
      settings: settings(),
      shockwave: (_p, _r, strength) => strengths.push(strength),
    });
    v2.applyAccessibility({ ...a, screenShake: 0.5 });
    v2.explosion({ x: 0, y: 0.5, z: -6 }, 4);
    v2.applyAccessibility({ ...a, screenShake: 0 });
    v2.explosion({ x: 0, y: 0.5, z: -6 }, 4);
    expect(strengths).toEqual([VFX_EFFECTS['explosion.frag'].shockwave.strength * 0.5]);
    expect(shocks).toHaveLength(0);
    v2.dispose();
    vfx.dispose();
  });

  it('can be created with pre-generated atlases', async () => {
    const atlases = await createVfxAtlases(() => Promise.resolve());
    const render = fakeRender();
    const vfx = new VfxSystem({ render, settings: settings(), atlases });
    vfx.spawn('land.heavy', { x: 0, y: 0, z: 0 });
    vfx.update(1 / 60);
    expect(vfx.stats.particles).toBeGreaterThan(0);
    vfx.dispose();
  });
});

describe('VfxBridge', () => {
  it('routes weapon and combat events through the weapon defs', () => {
    const events = new EventBus<GameEvents>();
    const calls: string[] = [];
    const target: VfxBridgeTarget = {
      muzzle: (preset, color, casing) => calls.push(`muzzle ${preset} ${color} ${casing}`),
      impact: (surface, profile, kind) => calls.push(`impact ${surface} ${profile} ${kind}`),
      muzzleTracer: (_t, color) => calls.push(`tracer ${color}`),
      tracer: (_f, _t, color) => calls.push(`segment ${color}`),
      beamShot: (style) => calls.push(`beam ${style}`),
      explosion: (_p, r, el, preset) => calls.push(`explosion ${r} ${el} ${preset}`),
      spawn: (id, _p, _n, scale) => calls.push(`spawn ${id} ${scale}`),
      applyGraphics: (g) => calls.push(`graphics ${g.particles}`),
      applyAccessibility: (a) => calls.push(`access ${a.reduceFlashing}`),
      hideMuzzleFlash: () => calls.push('hide'),
    };
    const bridge = new VfxBridge({ events, vfx: target });
    const v = { x: 0, y: 0, z: 0 };
    const pistol = getWeaponDef('pistol')!;
    events.emit('weapon:fired', {
      weaponId: 'pistol',
      origin: v,
      direction: v,
      muzzle: v,
      shotIndex: 0,
      ammoInMag: 3,
      ads: false,
    });
    events.emit('weapon:fired', {
      weaponId: 'nope',
      origin: v,
      direction: v,
      muzzle: v,
      shotIndex: 0,
      ammoInMag: 0,
      ads: false,
    });
    events.emit('combat:impact', {
      point: v,
      normal: v,
      surface: 'glass',
      kind: 'pellet',
      weaponId: 'shotgun',
      decal: true,
    });
    events.emit('combat:impact', {
      point: v,
      normal: v,
      surface: 'metal',
      kind: 'bullet',
      weaponId: 'trap',
      decal: true,
    });
    events.emit('combat:tracer', { from: v, to: v, weaponId: 'rifle' });
    // M5: effective colour, ricochet segments, ray-style muzzles (railgun), ExplosionDef presets.
    events.emit('combat:tracer', { from: v, to: v, weaponId: 'rifle', color: 0x123456 });
    events.emit('combat:tracer', { from: v, to: v, weaponId: 'rifle', segment: true });
    events.emit('combat:tracer', { from: v, to: v, weaponId: 'railgun' });
    events.emit('combat:explosion', { position: v, radius: 5, element: 'shock' });
    events.emit('combat:explosion', { position: v, radius: 1.4, element: 'physical', vfx: 'impact.plasma' });
    events.emit('player:land', { impactSpeed: 20, heavy: true, position: v, surface: 'metal' });
    events.emit('player:land', { impactSpeed: 5, heavy: false, position: v, surface: 'metal' });
    events.emit('weapon:holsterStart', { weaponId: 'pistol', slot: 0, duration: 0.2, next: 'rifle' });
    const s = createDefaultSettings();
    events.emit('settings:changed', { settings: s, sections: ['graphics', 'accessibility'] });
    expect(calls).toEqual([
      `muzzle ${pistol.vfx.muzzle} ${pistol.vfx.muzzleLightColor} ${pistol.vfx.casing}`,
      `impact glass ${getWeaponDef('shotgun')!.vfx.impact} pellet`,
      'impact metal null bullet',
      `tracer ${getWeaponDef('rifle')!.tracer.color}`,
      `tracer ${0x123456}`,
      `segment ${getWeaponDef('rifle')!.tracer.color}`,
      'beam beam.rail',
      'explosion 5 shock undefined',
      'explosion 1.4 physical impact.plasma',
      `spawn land.heavy ${landingScale(20)}`,
      'hide',
      `graphics ${s.graphics.particles}`,
      `access ${s.accessibility.reduceFlashing}`,
    ]);
    bridge.dispose();
    events.emit('combat:explosion', { position: v, radius: 5, element: 'shock' });
    expect(calls).toHaveLength(13);
  });

  it('gives shot impacts of the last fired weapon their travel direction', () => {
    const events = new EventBus<GameEvents>();
    const dirs: ({ x: number; y: number; z: number } | null)[] = [];
    const noop = (): void => undefined;
    const target: VfxBridgeTarget = {
      muzzle: noop,
      impact: (_s, _p, _k, _pt, _n, _d, direction) => dirs.push(direction ? { ...direction } : null),
      muzzleTracer: noop,
      tracer: noop,
      beamShot: noop,
      explosion: noop,
      spawn: noop,
      applyGraphics: noop,
      applyAccessibility: noop,
      hideMuzzleFlash: noop,
    };
    const bridge = new VfxBridge({ events, vfx: target });
    const impact = (weaponId: string, kind: 'bullet' | 'melee'): void =>
      events.emit('combat:impact', {
        point: { x: 1, y: 1.6, z: -10 },
        normal: { x: 0, y: 0, z: 1 },
        surface: 'metal',
        kind,
        weaponId,
        decal: true,
      });
    impact('rifle', 'bullet'); // no shot fired yet
    events.emit('weapon:fired', {
      weaponId: 'rifle',
      origin: { x: 1, y: 1.6, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      muzzle: { x: 1.2, y: 1.4, z: -0.5 },
      shotIndex: 0,
      ammoInMag: 10,
      ads: false,
    });
    impact('rifle', 'bullet');
    impact('rifle', 'melee'); // bashes are no shots
    impact('pistol', 'bullet'); // another source
    expect(dirs).toEqual([null, { x: 0, y: 0, z: -10 }, null, null]);
    bridge.dispose();
  });

  it('scales landing dust with the impact speed', () => {
    expect(landingScale(0)).toBe(VFX.landing.minScale);
    expect(landingScale(1000)).toBe(VFX.landing.maxScale);
    expect(landingScale(Number.NaN)).toBe(VFX.landing.minScale);
  });
});

describe('vfx dev commands', () => {
  it('spawn presets and explosions at the aim point', async () => {
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 1.6, 0);
    cam.lookAt(0, 0, -3);
    cam.updateMatrixWorld();
    const physics = new FakePhysics();
    const spawned: string[] = [];
    const events = new EventBus<GameEvents>();
    // Explosions go through the event bus (VfxBridge → VFX, AudioEventBridge → sound).
    events.on('combat:explosion', ({ position, radius, element }) =>
      spawned.push(`boom ${radius} ${element} ${position.y > 0}`),
    );
    const cmds = createVfxCommands({
      vfx: {
        spawn: (id, p) => spawned.push(`${id}@${p.y.toFixed(2)}`),
        clear: () => spawned.push('clear'),
        stats: { particles: 1, decals: 2, lights: 3 },
      },
      events,
      physics: physics.asApi(),
      camera: cam,
    });
    const run = (name: string, args: string[]): unknown => cmds.find((c) => c.name === name)!.run(args);
    expect(String(run('vfx', []))).toContain('impact.metal');
    run('vfx', ['impact.metal']);
    expect(spawned[0]).toBe('impact.metal@0.00');
    expect(() => run('vfx', ['nope'])).toThrow();
    run('explode', ['3', 'ice']);
    expect(spawned[1]).toBe('boom 3 ice true');
    expect(() => run('explode', ['-1'])).toThrow();
    expect(await run('decals', [])).toContain('Decals 2');
    run('decals', ['clear']);
    expect(spawned).toContain('clear');
    expect(cmds.find((c) => c.name === 'vfx')!.complete!(['impact.s'])).toEqual([
      'impact.slime',
      'impact.shield',
    ]);
  });
});
