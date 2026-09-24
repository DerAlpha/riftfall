import { describe, expect, it } from 'vitest';
import { Group, Vector3, type Mesh, type ShaderMaterial } from 'three';
import { ABILITY_VISUALS } from '../defs/abilities';
import { RENDER } from '../defs/graphics';
import { AbilityVisuals } from './AbilityVisuals';

function setup() {
  const parent = new Group();
  const anchor = new Vector3(0, 1.7, 0);
  const shockwaves: number[] = [];
  const v = new AbilityVisuals({
    parent,
    anchor: () => anchor,
    physics: {
      raycast: () =>
        ({ point: new Vector3(anchor.x, 0, anchor.z), normal: new Vector3(0, 1, 0), distance: 1.7 }) as never,
    },
    shockwave: (_p, _r, s) => void shockwaves.push(s),
  });
  const mesh = (name: string): Mesh => parent.getObjectByName(name) as Mesh;
  return { parent, anchor, shockwaves, v, mesh };
}

describe('AbilityVisuals', () => {
  it('builds hidden meshes on the volumetric layer (compiled with the scene at boot)', () => {
    const t = setup();
    expect(t.parent.children).toHaveLength(4);
    for (const c of t.parent.children) {
      expect(c.visible).toBe(false);
      expect(c.layers.isEnabled(RENDER.volumetricLayer)).toBe(true);
      expect(c.layers.isEnabled(0)).toBe(false);
    }
    expect(t.v.hasVolumetricContent).toBe(false);
  });

  it('the shock ring races out to the blast radius and ends by itself', () => {
    const t = setup();
    t.v.start('shockRing', { x: 2, y: 0, z: 3 }, 7, 0);
    expect(t.shockwaves).toEqual([ABILITY_VISUALS.shockRing.shockwave]);
    expect(t.v.hasVolumetricContent).toBe(true);
    t.v.update(ABILITY_VISUALS.shockRing.duration * 0.4);
    const disc = t.mesh('ability-shockRing-disc');
    const wall = t.mesh('ability-shockRing-wall');
    expect(disc.visible).toBe(true);
    expect(disc.position.x).toBe(2);
    expect(disc.scale.x).toBe(7);
    const progress = (disc.material as ShaderMaterial).uniforms.uProgress!.value as number;
    expect(progress).toBeGreaterThan(0.5);
    expect(progress).toBeLessThan(1);
    expect(wall.scale.x).toBeCloseTo(7 * progress, 6);
    t.v.update(ABILITY_VISUALS.shockRing.duration);
    expect(disc.visible).toBe(false);
    expect(t.v.hasVolumetricContent).toBe(false);
  });

  it('the time dome follows the anchor over the floor and fades out after stop()', () => {
    const t = setup();
    t.v.start('chronoDome', { x: 0, y: 0, z: 0 }, 8, 7);
    t.v.update(1);
    const disc = t.mesh('ability-chronoDome-disc');
    expect(disc.visible).toBe(true);
    expect(disc.scale.x).toBeCloseTo(8, 6);
    expect((disc.material as ShaderMaterial).uniforms.uFade!.value).toBe(1);
    t.anchor.set(5, 1.7, -4);
    t.v.update(0.1);
    expect(disc.position.x).toBe(5);
    expect(disc.position.z).toBe(-4);
    expect(disc.position.y).toBeCloseTo(0.03, 6);
    t.v.stop('chronoDome');
    t.v.update(ABILITY_VISUALS.chronoDome.fadeOut * 0.5);
    const fade = (disc.material as ShaderMaterial).uniforms.uFade!.value as number;
    expect(fade).toBeGreaterThan(0);
    expect(fade).toBeLessThan(1);
    t.v.update(ABILITY_VISUALS.chronoDome.fadeOut);
    expect(disc.visible).toBe(false);
  });

  it('clear() hides everything; dispose() removes the meshes', () => {
    const t = setup();
    t.v.start('chronoDome', { x: 0, y: 0, z: 0 }, 8, 7);
    t.v.start('shockRing', { x: 0, y: 0, z: 0 }, 7, 0);
    expect(t.v.activeLooks).toBe(2);
    t.v.clear();
    expect(t.v.activeLooks).toBe(0);
    t.v.dispose();
    expect(t.parent.children).toHaveLength(0);
  });
});
