import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PointLight,
  ShaderMaterial,
  SpotLight,
} from 'three';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { POWER } from '../../defs/mapEvents';
import { PowerGrid, ScaledValues, classifyColor, collectLightGroups, powerLevel } from './PowerGrid';

function settle(grid: PowerGrid, seconds = 5, dt = 1 / 60): void {
  for (let t = 0; t < seconds; t += dt) grid.update(dt);
}

describe('PowerGrid pieces', () => {
  it('ScaledValues scales on top of the owner: absolute writes rebase, untouched values keep their base', () => {
    const state = { a: 10, b: 4 };
    const v = new ScaledValues();
    v.add(
      () => state.a,
      (x) => (state.a = x),
    );
    v.add(
      () => state.b,
      (x) => (state.b = x),
    );
    v.apply(0.5);
    expect(state).toEqual({ a: 5, b: 2 });
    v.apply(0.5);
    expect(state).toEqual({ a: 5, b: 2 });
    // The owner animates `a` (absolute write each frame): the new value becomes the base.
    state.a = 8;
    v.apply(0.25);
    expect(state.a).toBe(2);
    expect(state.b).toBe(1);
    v.apply(1);
    expect(state).toEqual({ a: 8, b: 4 });
  });

  it('classifies red as emergency, violet as rift (kept), the rest as main lighting', () => {
    expect(classifyColor(1, 0.1, 0.05)).toBe('emergency');
    expect(classifyColor(0.62, 0.16, 1)).toBe('keep');
    expect(classifyColor(0.72, 0.86, 1)).toBe('main');
    expect(classifyColor(1, 0.5, 0.1)).toBe('main');
    expect(classifyColor(0, 0, 0)).toBe('main');
  });

  it('collects lights, emissive level meshes and light cones from a level root', () => {
    const root = new Group();
    const white = new SpotLight(0xffffff, 10);
    const red = new PointLight(0xff1008, 3);
    const rift = new PointLight(0x9c29ff, 5);
    rift.name = POWER.keepLights[0]!;
    root.add(white, red, rift);
    const panel = new MeshStandardMaterial({ emissive: 0xbbddff, emissiveIntensity: 4 });
    const alarm = new MeshStandardMaterial({ emissive: 0xff0000, emissiveIntensity: 5 });
    const wall = new MeshStandardMaterial({ color: 0x888888 });
    const cone = new ShaderMaterial({ uniforms: { uIntensity: { value: 0.8 } } });
    const geo = new BoxGeometry();
    const add = (name: string, m: MeshStandardMaterial | ShaderMaterial): void => {
      const mesh = new Mesh(geo, m);
      mesh.name = name;
      root.add(mesh);
    };
    add('level:emissive_white', panel);
    add('level:emissive_red', alarm);
    add('level:wall_panel', wall);
    add(POWER.coneNames[0]!, cone);
    const [main, emergency] = collectLightGroups(root);
    expect(main!.lights).toEqual([white]);
    expect(main!.materials).toEqual([panel]);
    expect(main!.glows).toEqual([cone]);
    expect(emergency!.emergency).toBe(true);
    expect(emergency!.lights).toEqual([red]);
    expect(emergency!.materials).toEqual([alarm]);
  });

  it('power level: blackout stutters then falls, restore ramps up; reduced flashing skips the stutter', () => {
    expect(powerLevel(false, 100, false, 1)).toBe(0);
    expect(powerLevel(true, 100, false, 1)).toBe(1);
    const mid = powerLevel(false, POWER.stutter + POWER.down / 2, false, 1);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(powerLevel(false, POWER.down, true, 1)).toBe(0);
    for (let t = 0; t < POWER.stutter; t += 0.01) {
      const k = powerLevel(false, t, false, 3);
      expect(k).toBeGreaterThanOrEqual(1 - POWER.flickerDepth - 1e-9);
      expect(k).toBeLessThanOrEqual(1);
    }
  });
});

describe('PowerGrid', () => {
  it('dims the main lights towards emergency red, boosts emergency lights, restores exactly', () => {
    const events = new EventBus<GameEvents>();
    const seen: boolean[] = [];
    events.on('power:changed', (e) => seen.push(e.powered));
    const grid = new PowerGrid({ events });
    const white = new SpotLight(0xffffff, 10);
    const red = new PointLight(0xff0000, 2);
    const panel = new MeshStandardMaterial({ emissive: 0xffffff, emissiveIntensity: 6 });
    grid.setLightGroups([
      { id: 'main', emergency: false, lights: [white], materials: [panel] },
      { id: 'em', emergency: true, lights: [red], materials: [] },
    ]);
    const prop = new MeshStandardMaterial({ emissive: 0x00ff00, emissiveIntensity: 3 });
    const propGroup = new Group();
    propGroup.add(new Mesh(new BoxGeometry(), prop));
    grid.addPoweredVisuals([propGroup]);
    expect(grid.materialCount).toBe(2);

    grid.update(1 / 60);
    expect(white.intensity).toBe(10);
    grid.setPowered(false);
    expect(grid.powered).toBe(false);
    settle(grid);
    expect(white.intensity).toBeCloseTo(10 * POWER.lightDim, 6);
    expect(white.color.g).toBeLessThan(0.5);
    expect(white.color.r).toBeGreaterThan(white.color.g);
    expect(panel.emissiveIntensity).toBeCloseTo(6 * POWER.materialDim, 6);
    expect(prop.emissiveIntensity).toBeCloseTo(3 * POWER.propDim, 6);
    expect(red.intensity).toBeGreaterThan(2);

    // An owner rewrites a value during the outage (flicker): it is scaled from the new base.
    white.intensity = 5;
    grid.update(1 / 60);
    expect(white.intensity).toBeCloseTo(5 * POWER.lightDim, 6);

    grid.setPowered(true);
    settle(grid);
    expect(grid.busy).toBe(false);
    expect(white.intensity).toBeCloseTo(5, 6);
    expect(white.color.getHex()).toBe(0xffffff);
    expect(panel.emissiveIntensity).toBeCloseTo(6, 6);
    expect(prop.emissiveIntensity).toBeCloseTo(3, 6);
    expect(red.intensity).toBeCloseTo(2, 6);
    expect(seen).toEqual([false, true]);
  });

  it('reset brings everything back at once and is idle afterwards', () => {
    const grid = new PowerGrid({ events: null, reduceFlashing: true });
    const light = new PointLight(0xffffff, 4);
    grid.setLightGroups([{ id: 'main', emergency: false, lights: [light], materials: [] }]);
    grid.setPowered(false);
    settle(grid, 3);
    expect(light.intensity).toBeLessThan(1);
    grid.reset();
    expect(grid.powered).toBe(true);
    expect(grid.busy).toBe(false);
    expect(light.intensity).toBeCloseTo(4, 6);
    // Idle: nothing is written any more.
    light.intensity = 7;
    grid.update(1 / 60);
    expect(light.intensity).toBe(7);
  });
});
