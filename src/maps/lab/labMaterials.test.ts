import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { MaterialLibraryApi } from '../../core/contracts';
import { LAB_MATERIALS } from '../../defs/labLayout';
import { LabMaterials, isAliasVariant, isNavIgnoredMaterial, labVariantDef, mapMask } from './labMaterials';

function stubLibrary(): MaterialLibraryApi & { made: Map<string, THREE.MeshStandardMaterial> } {
  const made = new Map<string, THREE.MeshStandardMaterial>();
  return {
    made,
    get(id: string) {
      let m = made.get(id);
      if (!m) {
        m = new THREE.MeshStandardMaterial({ name: id, roughness: 0.5, metalness: 0.2 });
        made.set(id, m);
      }
      return m;
    },
    async preload() {},
    dispose() {},
  };
}

/** Runs a material's onBeforeCompile on the stock standard shader (anchors must exist in r186). */
function compile(m: THREE.Material): { vertexShader: string; fragmentShader: string } {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  m.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe('LabMaterials', () => {
  it('resolves variants to tinted clones of the base and plain ids to the base itself', () => {
    const base = stubLibrary();
    const setup: THREE.Material[] = [];
    const lib = new LabMaterials(base, (m) => setup.push(m));
    expect(lib.get('wall_panel')).toBe(base.made.get('wall_panel'));
    const white = lib.get('wall_panel#white');
    expect(white).not.toBe(base.made.get('wall_panel'));
    expect(white.name).toBe('wall_panel#white');
    expect(white.color.r).toBeCloseTo(LAB_MATERIALS['wall_panel#white'].tint[0], 6);
    expect(white.roughness).toBeCloseTo(Math.min(1, 0.5 * LAB_MATERIALS['wall_panel#white'].roughness), 6);
    expect(lib.get('wall_panel#white')).toBe(white);
    expect(setup).toEqual([white]);
    // Alias variants (only a nav / bucket marker) and unknown variants use the base material.
    expect(isAliasVariant(labVariantDef('concrete_wall#ceiling')!)).toBe(true);
    expect(lib.get('concrete_wall#ceiling')).toBe(base.made.get('concrete_wall'));
    expect(lib.get('concrete_wall#nope')).toBe(base.made.get('concrete_wall'));
    expect(isNavIgnoredMaterial('concrete_wall#ceiling')).toBe(true);
    expect(isNavIgnoredMaterial('wall_panel#white')).toBe(false);
    expect(isNavIgnoredMaterial('toString')).toBe(false);
    lib.dispose();
  });

  it('makes translucent variants blend without writing depth', () => {
    const lib = new LabMaterials(stubLibrary());
    const tank = lib.get('glass#tank');
    expect(tank.transparent).toBe(true);
    expect(tank.depthWrite).toBe(false);
    expect(tank.opacity).toBeCloseTo(LAB_MATERIALS['glass#tank'].opacity, 6);
    lib.dispose();
  });

  it('follows texture swaps of the base and recompiles only when a map appears or disappears', () => {
    const base = stubLibrary();
    const lib = new LabMaterials(base);
    const v = lib.get('floor_panel#gloss');
    const b = base.made.get('floor_panel')!;
    const version = v.version;
    lib.update(0);
    expect(v.version).toBe(version);
    const t1 = new THREE.Texture();
    b.map = t1;
    b.roughnessMap = t1;
    lib.update(0);
    expect(v.map).toBe(t1);
    expect(v.roughnessMap).toBe(t1);
    expect(mapMask(v)).toBe(mapMask(b));
    expect(v.version).toBeGreaterThan(version);
    // Same maps, new textures (quality change): no recompile.
    const after = v.version;
    const t2 = new THREE.Texture();
    b.map = t2;
    b.roughnessMap = t2;
    lib.update(0);
    expect(v.map).toBe(t2);
    expect(v.version).toBe(after);
    // A map added later on its own also recompiles.
    b.metalnessMap = t2;
    lib.update(0);
    expect(v.metalnessMap).toBe(t2);
    expect(v.version).toBeGreaterThan(after);
    lib.dispose();
  });

  it('patches the LED and fluid emissive effects into the stock shader with shared animation uniforms', () => {
    const lib = new LabMaterials(stubLibrary());
    for (const id of ['emissive_cyan#led', 'emissive_cyan#fluid']) {
      const m = lib.get(id);
      const s = compile(m);
      expect(s.vertexShader, id).toContain('vLabUv = uv;');
      expect(s.fragmentShader, id).toContain('varying vec2 vLabUv;');
      expect(s.fragmentShader, id).toContain('uniform float uLabTime;');
      expect(s.fragmentShader, id).toMatch(/#include <emissivemap_fragment>\s*\{/);
      const uniforms = (s as unknown as { uniforms: Record<string, THREE.IUniform> }).uniforms;
      expect(uniforms.uLabTime).toBe(lib.time);
      expect(m.customProgramCacheKey()).toContain(id.slice(id.indexOf('#') + 1));
    }
    lib.update(3.5);
    expect(lib.time.value).toBe(3.5);
    const led = compile(lib.get('emissive_cyan#led')) as unknown as {
      uniforms: Record<string, THREE.IUniform<number>>;
    };
    lib.setReducedFlashing(true);
    expect(led.uniforms.uLabReduce!.value).toBe(1);
    lib.setReducedFlashing(false);
    expect(led.uniforms.uLabReduce!.value).toBe(0);
    lib.dispose();
  });

  it('disposes only its own clones', () => {
    const base = stubLibrary();
    const lib = new LabMaterials(base);
    const v = lib.get('wall_panel#white');
    let disposed = 0;
    v.addEventListener('dispose', () => disposed++);
    let baseDisposed = 0;
    base.made.get('wall_panel')!.addEventListener('dispose', () => baseDisposed++);
    lib.dispose();
    expect(disposed).toBe(1);
    expect(baseDisposed).toBe(0);
  });
});
