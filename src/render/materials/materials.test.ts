import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { AssetsApi, RenderApi, SettingsStore, TextureSet } from '../../core/contracts';
import { QUALITY_LEVELS } from '../../defs/graphics';
import { createDefaultSettings } from '../../save/settingsSchema';
import { MaterialLibrary } from './MaterialLibrary';
import {
  GENERATOR_DEFAULTS,
  MATERIALS,
  REQUIRED_MATERIAL_IDS,
  getMaterialDef,
  resolveGeneratorParams,
  type MaterialDef,
} from '../../defs/materials';
import { getAssetEntry } from '../../assets/manifest';
import { proceduralCacheKey, proceduralSize } from './ProceduralTextureGenerator';
import { buildGeneratorFragment, generatorHasEmissive } from './proceduralShaders';

const defs = Object.entries(MATERIALS) as [string, MaterialDef][];
const ASSET_IDS = ['tex.floor', 'tex.concrete'];

describe('material defs', () => {
  it('contains every required material and keys match ids', () => {
    for (const id of REQUIRED_MATERIAL_IDS) expect(getMaterialDef(id)).toBeDefined();
    for (const [key, def] of defs) expect(def.id).toBe(key);
    expect(getMaterialDef('does_not_exist')).toBeUndefined();
    expect(getMaterialDef('toString')).toBeUndefined();
  });

  it('uses only known texture set asset ids and sane values', () => {
    for (const [, d] of defs) {
      if (d.textureSet) expect(ASSET_IDS).toContain(d.textureSet);
      expect(d.uvScale).toBeGreaterThan(0);
      expect(d.opacity).toBeGreaterThan(0);
      expect(d.opacity).toBeLessThanOrEqual(1);
      expect(d.resolution).toBeGreaterThan(0);
      expect(d.resolution).toBeLessThanOrEqual(1);
      // Power-of-two fractions keep procedural sizes powers of two.
      expect(Number.isInteger(Math.log2(d.resolution))).toBe(true);
      if (!d.generator) expect(d.params).toBeUndefined();
    }
  });

  it('emissive light materials bloom (HDR > 1) and never cast shadows', () => {
    for (const id of ['emissive_cyan', 'emissive_orange', 'emissive_red', 'emissive_white'] as const) {
      const d = MATERIALS[id];
      expect(d.emissiveIntensity).toBeGreaterThan(1);
      expect(d.castShadow).toBe(false);
    }
    expect(MATERIALS.glass.opacity).toBeLessThan(1);
    expect(MATERIALS.glass.surface).toBe('glass');
    expect(MATERIALS.floor_grate.surface).toBe('grate');
    expect(MATERIALS.rubber.surface).toBe('rubber');
    expect(MATERIALS.floor_concrete.surface).toBe('concrete');
  });

  it('generator params are tileable (integer layout counts)', () => {
    for (const [, d] of defs) {
      const p = resolveGeneratorParams(d);
      if (!p) continue;
      expect(Number.isInteger(p.cells[0])).toBe(true);
      expect(Number.isInteger(p.cells[1])).toBe(true);
      expect(p.reliefMm).toBeGreaterThan(0);
    }
    for (const g of Object.values(GENERATOR_DEFAULTS)) {
      for (const c of [g.colorA, g.colorB, g.colorC]) for (const v of c) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('shares GPU textures between wall_panel and wall_panel_dark (same cache key)', () => {
    const key = (d: MaterialDef): string =>
      proceduralCacheKey({
        generator: d.generator!,
        params: resolveGeneratorParams(d)!,
        size: 1024,
        uvScale: d.uvScale,
      });
    expect(key(MATERIALS.wall_panel)).toBe(key(MATERIALS.wall_panel_dark));
    expect(key(MATERIALS.wall_panel)).not.toBe(key(MATERIALS.floor_panel));
    expect(key(MATERIALS.floor_concrete)).not.toBe(key(MATERIALS.concrete_wall));
  });
});

describe('procedural generator helpers', () => {
  it('clamps sizes to powers of two within limits', () => {
    expect(proceduralSize(2048, 16384)).toBe(2048);
    expect(proceduralSize(1500, 16384)).toBe(1024);
    expect(proceduralSize(8192, 2048)).toBe(2048);
    expect(proceduralSize(1, 4096)).toBeGreaterThanOrEqual(128);
    for (const q of Object.values(QUALITY_LEVELS.textureQuality)) {
      expect(Number.isInteger(Math.log2(q.proceduralSize))).toBe(true);
    }
  });

  it('builds a fragment shader per generator with the shared pass layout', () => {
    for (const id of Object.keys(GENERATOR_DEFAULTS) as (keyof typeof GENERATOR_DEFAULTS)[]) {
      const src = buildGeneratorFragment(id);
      expect(src).toContain('float genHeight(vec2 uv)');
      expect(src).toContain('void genSurface(');
      expect(src).toContain('void main()');
    }
    expect(generatorHasEmissive('screen')).toBe(true);
    expect(generatorHasEmissive('panel')).toBe(false);
  });
});

describe('MaterialLibrary (asset path, no GPU work)', () => {
  // Minimal renderer surface used by the library + generator constructors.
  const renderer = {
    extensions: { has: () => true, get: () => null },
    capabilities: { getMaxAnisotropy: () => 16, maxTextureSize: 4096 },
  } as unknown as THREE.WebGLRenderer;
  const setup: THREE.Material[] = [];
  const render = { renderer, setupMaterial: (m: THREE.Material) => setup.push(m) } as unknown as RenderApi;
  const settings = {
    current: createDefaultSettings(),
    update() {},
    replace() {},
    resetSection() {},
  } as SettingsStore;
  const partialSet: TextureSet = {
    map: new THREE.Texture(),
    normalMap: new THREE.Texture(),
    ormMap: null,
    aoMap: null,
    roughnessMap: null,
    metalnessMap: null,
    emissiveMap: null,
  };
  const assets = {
    loadTextureSet: async () => partialSet,
  } as unknown as AssetsApi;

  it('uses scalar roughness/metalness when an asset set lacks those maps', async () => {
    const lib = new MaterialLibrary(render, assets, settings);
    await lib.preload(['floor_concrete', 'diamond_plate']);
    const concrete = lib.get('floor_concrete');
    expect(concrete.map).not.toBeNull();
    expect(concrete.map).not.toBe(partialSet.map); // per-material clone owns the repeat
    // Scanned sets tile at their physical size from the manifest, not at the generator's uvScale.
    expect(concrete.map!.repeat.x).toBeCloseTo(1 / getAssetEntry('tex.concrete')!.physicalSizeM!);
    expect(concrete.metalnessMap).toBeNull();
    // Without a map the def multiplier (1) must not turn the surface into chrome.
    expect(concrete.metalness).toBe(0);
    expect(concrete.roughness).toBeCloseTo(GENERATOR_DEFAULTS.concrete.roughness, 6);
    const panel = lib.get('diamond_plate');
    expect(panel.metalness).toBeLessThan(0.2);
    expect(setup).toContain(concrete);
    lib.dispose();
  });

  it('returns one loud placeholder for unknown ids', () => {
    const lib = new MaterialLibrary(render, assets, settings);
    const a = lib.get('nope_a');
    const b = lib.get('nope_b');
    expect(a).toBe(b);
    expect(a.name).toBe('placeholder');
    lib.dispose();
  });
});
