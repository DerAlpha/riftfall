import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { RENDER } from '../../defs/graphics';
import { TEST_ROOM } from '../../defs/maps';
import { DustParticles } from '../vfx/DustParticles';
import { VolumetricCone, VolumetricShafts } from '../vfx/VolumetricCone';
import { HEIGHT_FOG_PARAMS } from './fogShared';
import { HeightFogEffect } from './HeightFogEffect';
import { VolumetricPass } from './VolumetricPass';

const time = { value: 0 };

function volumetrics(): { objects: THREE.Object3D[]; materials: THREE.ShaderMaterial[]; dispose(): void } {
  const cone = new VolumetricCone({
    apex: { x: 0, y: 8, z: 0 },
    direction: { x: 0, y: -1, z: 0 },
    angle: 0.4,
    length: 7,
    color: new THREE.Color(1, 1, 1),
    intensity: 0.3,
    floorY: 0,
    time,
  });
  const shafts = new VolumetricShafts(
    [
      {
        origin: { x: 0, y: 10, z: 0 },
        edgeA: { x: 2, y: 0, z: 0 },
        edgeB: { x: 0, y: 0, z: 1 },
        extrude: { x: 0, y: -8, z: 0 },
        fadeU0: true,
        fadeU1: true,
      },
    ],
    new THREE.Color(1, 1, 1),
    1,
    time,
  );
  const dust = new DustParticles({
    regions: [{ min: [-1, 0, -1], max: [1, 2, 1], share: 1 }],
    maxCount: 16,
    time,
  });
  const objects = [cone.mesh, shafts.mesh, dust.points];
  return {
    objects,
    materials: objects.map((o) => (o as THREE.Mesh).material as THREE.ShaderMaterial),
    dispose: () => {
      cone.dispose();
      shafts.dispose();
      dust.dispose();
    },
  };
}

describe('additive volumetrics', () => {
  it('live only on the volumetric layer (invisible to the main camera, AO and fog)', () => {
    const v = volumetrics();
    const mainCamera = new THREE.PerspectiveCamera();
    for (const o of v.objects) {
      expect(o.layers.isEnabled(RENDER.volumetricLayer), o.name).toBe(true);
      expect(o.layers.test(mainCamera.layers), o.name).toBe(false);
    }
    v.dispose();
  });

  it('share the height-fog parameters with the fog effect by reference', () => {
    const v = volumetrics();
    for (const m of v.materials) expect(m.uniforms.fogParams, m.name).toBe(HEIGHT_FOG_PARAMS);
    const fog = new HeightFogEffect(new THREE.PerspectiveCamera(), 0);
    fog.setFog(TEST_ROOM.fog);
    expect(HEIGHT_FOG_PARAMS.value.x).toBe(TEST_ROOM.fog.density);
    expect(HEIGHT_FOG_PARAMS.value.z).toBe(TEST_ROOM.fog.baseHeight);
    fog.dispose();
    v.dispose();
  });
});

describe('VolumetricPass', () => {
  it('draws into the current buffer with the world depth and restores the camera layers', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const pass = new VolumetricPass(scene, camera, RENDER.volumetricLayer);
    expect(pass.needsSwap).toBe(false);
    expect(pass.needsDepthTexture).toBe(true);
    let renders = 0;
    let maskDuringRender = -1;
    const renderer = {
      setRenderTarget: () => undefined,
      render: (_scene: THREE.Object3D, c: THREE.Camera) => {
        renders++;
        if (c === camera) maskDuringRender = c.layers.mask;
      },
    } as unknown as THREE.WebGLRenderer;
    // Without the stable depth it must not draw (beams would show through walls).
    pass.render(renderer, null);
    expect(renders).toBe(0);

    const depth = new THREE.DepthTexture(4, 4);
    pass.setDepthTexture(depth);
    expect(pass.getDepthTexture()).toBe(depth);
    const before = camera.layers.mask;
    pass.render(renderer, null);
    expect(renders).toBe(2); // depth prime + volumetric layer
    expect(maskDuringRender).toBe(1 << RENDER.volumetricLayer);
    expect(camera.layers.mask).toBe(before);
    // The world scene is viewed, not adopted.
    expect(scene.parent).toBeNull();
    pass.dispose();
    depth.dispose();
  });
});
