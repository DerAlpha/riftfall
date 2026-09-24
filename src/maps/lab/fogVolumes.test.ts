import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { RENDER } from '../../defs/graphics';
import { FOG_VOLUME, LAB_LAYOUT as L } from '../../defs/labLayout';
import { FogVolume } from './fogVolumes';

function cameraAt(x: number, y: number, z: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera();
  c.position.set(x, y, z);
  c.updateMatrixWorld();
  return c;
}

describe('FogVolume', () => {
  it('insets the proxy box and draws on the volumetric layer', () => {
    const def = L.fogVolumes[0]!;
    const v = new FogVolume(def, { value: 0 });
    v.mesh.geometry.computeBoundingBox();
    const size = v.mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(def.max[0] - def.min[0] - 2 * FOG_VOLUME.faceInset, 6);
    expect(size.y).toBeCloseTo(def.max[1] - def.min[1] - 2 * FOG_VOLUME.faceInset, 6);
    expect(v.mesh.layers.isEnabled(RENDER.volumetricLayer)).toBe(true);
    expect(v.mesh.layers.isEnabled(0)).toBe(false);
    v.dispose();
  });

  it('depth-tests its entry faces from outside, never its exit faces from inside (no pop at a face)', () => {
    const def = L.fogVolumes.find((f) => f.id === 'cryo_mist')!;
    const v = new FogVolume(def, { value: 0 });
    const material = v.mesh.material as THREE.ShaderMaterial;
    const render = (x: number, y: number, z: number): boolean => {
      const cam = cameraAt(x, y, z);
      v.mesh.onBeforeRender(
        {} as THREE.WebGLRenderer,
        new THREE.Scene(),
        cam,
        v.mesh.geometry,
        material,
        null as unknown as THREE.Group,
      );
      return material.depthTest;
    };
    const cx = (def.min[0] + def.max[0]) / 2;
    const cz = (def.min[2] + def.max[2]) / 2;
    const top = def.max[1] - FOG_VOLUME.faceInset;
    // Standing eye above the mist, crouched eye inside it.
    expect(render(cx, top + 0.3, cz)).toBe(true);
    expect(render(cx, top - 0.3, cz)).toBe(false);
    expect(render(cx, top + 0.01, cz)).toBe(true);
    // Beside the box (next room) at mist height.
    expect(render(def.min[0] - 1, top - 0.3, cz)).toBe(true);
    v.dispose();
  });
});
