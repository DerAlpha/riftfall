import { describe, expect, it } from 'vitest';
import { MeshStandardMaterial, Texture } from 'three';
import type { MaterialLibraryApi } from '../../core/contracts';
import { KitMaterials } from './KitMaterials';

function library(): MaterialLibraryApi & { made: string[]; preloaded: string[] } {
  const cache = new Map<string, MeshStandardMaterial>();
  const made: string[] = [];
  const preloaded: string[] = [];
  return {
    made,
    preloaded,
    get(id: string) {
      let m = cache.get(id);
      if (!m) {
        m = new MeshStandardMaterial({ name: id, color: 0x808080, roughness: 0.8, metalness: 0.5 });
        cache.set(id, m);
        made.push(id);
      }
      return m;
    },
    async preload(ids) {
      preloaded.push(...ids);
    },
    dispose() {},
  };
}

describe('KitMaterials', () => {
  const DEFS = {
    'wall_panel#ice': {
      tint: [2, 1, 1] as const,
      roughness: 0.5,
      emissive: [0, 0, 1] as const,
      emissiveIntensity: 3,
    },
    'glass#frost': { opacity: 0.5 },
    'concrete_wall#ceiling': { navIgnore: true },
  };

  it('resolves variants to tuned clones, plain ids and aliases to the base', () => {
    const base = library();
    const setup: string[] = [];
    const mats = new KitMaterials(base, DEFS, (m) => setup.push(m.name));
    const plain = mats.get('wall_panel');
    const ice = mats.get('wall_panel#ice');
    expect(ice).not.toBe(plain);
    expect(ice).toBe(mats.get('wall_panel#ice'));
    expect(ice.color.r).toBeCloseTo(plain.color.r * 2, 5);
    expect(ice.roughness).toBeCloseTo(0.4, 6);
    expect(ice.emissiveIntensity).toBe(3);
    expect(setup).toEqual(['wall_panel#ice']);
    const frost = mats.get('glass#frost');
    expect(frost.transparent).toBe(true);
    expect(frost.depthWrite).toBe(false);
    expect(mats.get('concrete_wall#ceiling')).toBe(base.get('concrete_wall'));
    expect(mats.isNavIgnored('concrete_wall#ceiling')).toBe(true);
    expect(mats.isNavIgnored('wall_panel#ice')).toBe(false);
    // Unknown variants fall back to the base (never a crash).
    expect(mats.get('wall_panel#nope')).toBe(plain);
  });

  it('preloads base ids once and follows texture maps the base swaps', async () => {
    const base = library();
    const mats = new KitMaterials(base, DEFS);
    await mats.preload(['wall_panel#ice', 'wall_panel', 'glass#frost']);
    expect(base.preloaded).toEqual(['wall_panel', 'glass']);
    const ice = mats.get('wall_panel#ice');
    const tex = new Texture();
    base.get('wall_panel').map = tex;
    const version = ice.version;
    mats.update();
    expect(ice.map).toBe(tex);
    expect(ice.version).toBeGreaterThan(version);
    mats.dispose();
  });
});
