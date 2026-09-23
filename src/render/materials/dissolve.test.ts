import { describe, expect, it } from 'vitest';
import {
  MeshDepthMaterial,
  MeshDistanceMaterial,
  MeshStandardMaterial,
  ShaderLib,
  type WebGLRenderer,
} from 'three';
import type { WebGLProgramParametersWithUniforms } from 'three';
import {
  DISSOLVE_CACHE_KEY,
  applyDissolve,
  configureDissolve,
  createDissolveDepthMaterial,
  createDissolveDistanceMaterial,
  createDissolveUniforms,
  patchDissolveFragment,
  patchDissolveVertex,
  setDissolveEdgeColor,
  setDissolveProgress,
  type DissolveOptions,
} from './dissolve';

const OPTS: DissolveOptions = {
  edgeWidth: 0.08,
  edgeColor: [1, 0.5, 0.25],
  edgeIntensity: 10,
  noiseScale: 5,
  sweep: 0.4,
  sweepAxis: [0, -0.5, 0],
  sweepOffset: 1,
  seed: [1, 2, 3],
};

function fakeShader(vertexShader: string, fragmentShader: string): WebGLProgramParametersWithUniforms {
  return { vertexShader, fragmentShader, uniforms: {} } as unknown as WebGLProgramParametersWithUniforms;
}

const RENDERER = {} as WebGLRenderer;

describe('dissolve shader patch', () => {
  it('adds the object-space position varying after begin_vertex', () => {
    const vs = patchDissolveVertex(ShaderLib.standard.vertexShader)!;
    expect(vs).not.toBeNull();
    expect(vs).toContain('varying vec3 vRfDissolvePos;');
    expect(vs.indexOf('vRfDissolvePos = transformed;')).toBeGreaterThan(
      vs.indexOf('#include <begin_vertex>'),
    );
  });

  it('clips below the threshold and adds the HDR edge to the emissive radiance', () => {
    const fs = patchDissolveFragment(ShaderLib.standard.fragmentShader, true)!;
    expect(fs).not.toBeNull();
    expect(fs).toContain('discard');
    const clip = fs.indexOf('rfDissolveD = rfDissolveField() - uDissolve');
    expect(clip).toBeGreaterThan(fs.indexOf('#include <clipping_planes_fragment>'));
    const edge = fs.indexOf('totalEmissiveRadiance += uDissolveColor');
    expect(edge).toBeGreaterThan(fs.indexOf('#include <emissivemap_fragment>'));
    // Uniform declarations come before main().
    expect(fs.indexOf('uniform float uDissolve;')).toBeLessThan(fs.indexOf('void main()'));
  });

  it('patches the shadow depth / distance shaders without the emissive edge', () => {
    for (const lib of [ShaderLib.depth, ShaderLib.distance]) {
      const vs = patchDissolveVertex(lib.vertexShader);
      const fs = patchDissolveFragment(lib.fragmentShader, false);
      expect(vs).not.toBeNull();
      expect(fs).not.toBeNull();
      expect(fs).toContain('discard');
      expect(fs).not.toContain('totalEmissiveRadiance');
    }
  });

  it('returns null when a chunk anchor is missing (never a broken shader)', () => {
    expect(patchDissolveVertex('void main() {}')).toBeNull();
    expect(patchDissolveFragment('#include <common>\nvoid main() {}', true)).toBeNull();
  });
});

describe('dissolve materials', () => {
  it('binds the shared uniform objects in onBeforeCompile with a constant cache key', () => {
    const u = createDissolveUniforms(OPTS);
    const a = applyDissolve(new MeshStandardMaterial(), u);
    const b = applyDissolve(new MeshStandardMaterial(), createDissolveUniforms(OPTS));
    expect(a.customProgramCacheKey()).toBe(DISSOLVE_CACHE_KEY);
    expect(b.customProgramCacheKey()).toBe(a.customProgramCacheKey());
    const shader = fakeShader(ShaderLib.standard.vertexShader, ShaderLib.standard.fragmentShader);
    a.onBeforeCompile(shader, RENDERER);
    expect(shader.uniforms.uDissolve).toBe(u.uDissolve);
    expect(shader.fragmentShader).toContain('rfDissolveField');
    // Animating is a uniform write: the compiled program sees it without a recompile.
    setDissolveProgress(u, 0.4);
    expect((shader.uniforms.uDissolve as { value: number }).value).toBe(0.4);
  });

  it('leaves the shader untouched when anchors are missing', () => {
    const m = applyDissolve(new MeshStandardMaterial(), createDissolveUniforms(OPTS));
    const shader = fakeShader('void main() {}', 'void main() {}');
    m.onBeforeCompile(shader, RENDERER);
    expect(shader.vertexShader).toBe('void main() {}');
    expect(shader.uniforms.uDissolve).toBeUndefined();
  });

  it('creates matching shadow materials', () => {
    const u = createDissolveUniforms(OPTS);
    const depth = createDissolveDepthMaterial(u);
    const dist = createDissolveDistanceMaterial(u);
    expect(depth).toBeInstanceOf(MeshDepthMaterial);
    expect(dist).toBeInstanceOf(MeshDistanceMaterial);
    expect(depth.customProgramCacheKey()).not.toBe(DISSOLVE_CACHE_KEY);
    const shader = fakeShader(ShaderLib.depth.vertexShader, ShaderLib.depth.fragmentShader);
    depth.onBeforeCompile(shader, RENDERER);
    expect(shader.uniforms.uDissolve).toBe(u.uDissolve);
  });

  it('clamps progress and configures edge / sweep / seed', () => {
    const u = createDissolveUniforms(OPTS);
    setDissolveProgress(u, 2);
    expect(u.uDissolve.value).toBe(1);
    setDissolveProgress(u, -1);
    expect(u.uDissolve.value).toBe(0);
    setDissolveProgress(u, Number.NaN);
    expect(u.uDissolve.value).toBe(0);
    expect(u.uDissolveColor.value.r).toBeCloseTo(10, 5);
    expect(u.uDissolveColor.value.g).toBeCloseTo(5, 5);
    expect(u.uDissolveSweep.value.toArray()).toEqual([0, -0.5, 0, 1]);
    expect(u.uDissolveSeed.value.toArray()).toEqual([1, 2, 3]);
    setDissolveEdgeColor(u, [0, 1, 0], 3);
    expect(u.uDissolveColor.value.toArray()).toEqual([0, 3, 0]);
    configureDissolve(u, { ...OPTS, edgeWidth: 0, sweep: 5 });
    expect(u.uDissolveEdge.value).toBeGreaterThan(0);
    expect(u.uDissolveSweepWeight.value).toBe(1);
  });
});
