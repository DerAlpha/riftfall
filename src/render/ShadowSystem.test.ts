import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import * as CSMShaderModule from 'three/examples/jsm/csm/CSMShader.js';
import { QUALITY_LEVELS } from '../defs/graphics';
import { buildCsmLightsChunk, ShadowSystem } from './ShadowSystem';

// @types/three only declares CSMShader as an interface; the module exports the object at runtime.
const CSMShader = (CSMShaderModule as unknown as { CSMShader: { lights_fragment_begin: string } }).CSMShader;

// Captured at import, before any test below constructs a CSM (which swaps the global chunk).
const STOCK = THREE.ShaderChunk.lights_fragment_begin;

describe('buildCsmLightsChunk', () => {
  const patched = buildCsmLightsChunk(STOCK, CSMShader.lights_fragment_begin);

  it('builds a chunk from the stock r186 source', () => {
    expect(patched).not.toBeNull();
  });

  it('keeps the r186 PBR setup the stale addon chunk lacks (DFG LUT / multi-scattering)', () => {
    expect(STOCK).toContain('material.dfg');
    expect(CSMShader.lights_fragment_begin).not.toContain('material.dfg');
    expect(patched).toContain('material.dfg');
    expect(patched).toContain('multiScatteringCompensation');
  });

  it('contains the cascaded directional block and gates the stock block to non-CSM materials', () => {
    expect(patched).toContain('defined( USE_CSM ) && defined( CSM_CASCADES )');
    expect(patched).toContain('!defined( USE_CSM ) && !defined( CSM_CASCADES )');
    expect(patched).toContain('CSM_cascades');
    // Exactly one ungated directional block remains: the non-CSM one.
    expect(patched!.match(/#if \( NUM_DIR_LIGHTS > 0 \) && defined\( RE_Direct \)\s*\n/g)).toBeNull();
  });

  it('keeps balanced preprocessor conditionals', () => {
    const opens = patched!.match(/^\s*#if(def|ndef)?\b/gm)?.length ?? 0;
    const closes = patched!.match(/^\s*#endif\b/gm)?.length ?? 0;
    expect(opens).toBe(closes);
  });

  it('refuses unexpected inputs', () => {
    expect(buildCsmLightsChunk(CSMShader.lights_fragment_begin, CSMShader.lights_fragment_begin)).toBeNull();
    expect(buildCsmLightsChunk(STOCK, 'nothing here')).toBeNull();
  });
});

describe('ShadowSystem material registry (no WebGL needed)', () => {
  const make = (): { shadows: ShadowSystem; scene: THREE.Scene } => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 400);
    return { shadows: new ShadowSystem(scene, camera), scene };
  };
  const shaderStub = (): THREE.WebGLProgramParametersWithUniforms =>
    ({ uniforms: {} }) as unknown as THREE.WebGLProgramParametersWithUniforms;

  it('uses one plain sun light without shadows and cascaded lights with shadows', () => {
    const { shadows, scene } = make();
    const dirLights = (): number =>
      scene.children.filter((c) => (c as THREE.DirectionalLight).isDirectionalLight).length;
    expect(shadows.cascades).toBe(0);
    expect(dirLights()).toBe(1);
    shadows.setQuality('high');
    expect(shadows.cascades).toBe(QUALITY_LEVELS.shadows.high.cascades);
    expect(dirLights()).toBe(QUALITY_LEVELS.shadows.high.cascades);
    shadows.setQuality('off');
    expect(shadows.cascades).toBe(0);
    expect(dirLights()).toBe(1);
    shadows.dispose();
    expect(dirLights()).toBe(0);
  });

  it('chains an existing onBeforeCompile hook and restores it when CSM is torn down', () => {
    const { shadows } = make();
    const calls: string[] = [];
    const own = (): void => void calls.push('own');
    const mat = new THREE.MeshStandardMaterial();
    mat.onBeforeCompile = own;
    shadows.setupMaterial(mat);
    shadows.setQuality('medium');
    expect(mat.defines?.USE_CSM).toBe(1);
    expect(mat.defines?.CSM_CASCADES).toBe(QUALITY_LEVELS.shadows.medium.cascades);
    const shader = shaderStub();
    mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(calls).toEqual(['own']);
    expect(shader.uniforms.CSM_cascades).toBeDefined();
    expect(mat.customProgramCacheKey()).toContain('|csm');
    shadows.setQuality('off');
    expect(mat.defines?.USE_CSM).toBeUndefined();
    expect(mat.onBeforeCompile).toBe(own);
    shadows.dispose();
  });

  it('forgets disposed materials and restores their own state', () => {
    const { shadows } = make();
    shadows.setQuality('low');
    const mat = new THREE.MeshStandardMaterial();
    shadows.setupMaterial(mat);
    expect(mat.defines?.USE_CSM).toBe(1);
    mat.dispose();
    expect(mat.defines?.USE_CSM).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(mat, 'onBeforeCompile')).toBe(false);
    // A rebuild (cascade count change) must not touch it any more.
    shadows.setQuality('ultra');
    expect(mat.defines?.USE_CSM).toBeUndefined();
    shadows.dispose();
  });
});
