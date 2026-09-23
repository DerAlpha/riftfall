import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSET_DEFS, ASSETS, POLYHAVEN, withExtension } from '../defs/assets';
import { MAPS } from '../defs/maps';
import { MATERIALS } from '../defs/materials';
import { AssetLoader, withStallTimeout } from './AssetLoader';
import {
  ASSET_MANIFEST,
  getAssetEntry,
  isSafeAssetPath,
  parseAvailableIndex,
  planTextureSet,
  validateManifest,
  type AvailableAsset,
} from './manifest';
import { createCheckerData, createPlaceholderModel, createPlaceholderTexture } from './placeholders';

const REQUIRED_IDS = ['hdri.industrial', 'tex.floor', 'tex.concrete'];

describe('asset manifest', () => {
  it('is valid (unique ids, relative paths below assets/, CC0 credits)', () => {
    expect(validateManifest()).toEqual([]);
  });

  it('has unique ids', () => {
    const ids = ASSET_MANIFEST.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only uses relative file paths below assets/', () => {
    for (const e of ASSET_MANIFEST) {
      for (const path of Object.values(e.files)) {
        expect(path).toMatch(/^assets\//);
        expect(path.startsWith('/')).toBe(false);
        expect(path).not.toContain('..');
        expect(path).not.toMatch(/^[a-z]+:/i);
      }
    }
  });

  it('credits every asset with title, author, https source and CC0', () => {
    for (const e of ASSET_MANIFEST) {
      expect(e.credit.title.length).toBeGreaterThan(0);
      expect(e.credit.author.length).toBeGreaterThan(0);
      expect(e.credit.source).toMatch(/^https:\/\//);
      expect(e.credit.license).toBe('CC0');
    }
  });

  it('contains every required id with the right type and files', () => {
    for (const id of REQUIRED_IDS) expect(getAssetEntry(id), id).toBeDefined();
    expect(getAssetEntry('hdri.industrial')?.type).toBe('hdri');
    expect(getAssetEntry('hdri.industrial')?.files.hdr).toMatch(/\.hdr$/);
    for (const id of REQUIRED_IDS.filter((i) => i.startsWith('tex.'))) {
      const e = getAssetEntry(id);
      expect(e?.type).toBe('textureSet');
      expect(Object.keys(e?.files ?? {}).sort()).toEqual([...POLYHAVEN.primaryTextureRoles].sort());
    }
  });

  it('covers every asset id referenced by materials and maps', () => {
    for (const def of Object.values(MATERIALS)) {
      if (def.textureSet) expect(getAssetEntry(def.textureSet)?.type, def.id).toBe('textureSet');
    }
    for (const map of Object.values(MAPS)) {
      if (map.environment.hdri) expect(getAssetEntry(map.environment.hdri)?.type).toBe('hdri');
      for (const id of map.preload) expect(getAssetEntry(id), id).toBeDefined();
    }
  });

  it('keeps loading labels and ids consistent with the defs', () => {
    expect(ASSET_MANIFEST.map((e) => e.id)).toEqual(ASSET_DEFS.map((d) => d.id));
    for (const e of ASSET_MANIFEST) expect(e.label.trim()).not.toBe('');
  });

  it('rejects unsafe paths', () => {
    for (const bad of [
      '/assets/x.jpg',
      'assets/../x',
      'https://evil/x.jpg',
      'textures/x.jpg',
      'assets//x',
      'assets/x.jpg?v=1',
      '',
    ]) {
      expect(isSafeAssetPath(bad), bad).toBe(false);
    }
    expect(isSafeAssetPath('assets/textures/a/a_diff_1k.jpg')).toBe(true);
  });

  it('replaces the extension of a path', () => {
    expect(withExtension('assets/textures/a/a_diff_1k.jpg', 'ktx2')).toBe('assets/textures/a/a_diff_1k.ktx2');
    expect(withExtension('assets/v1.0/file', 'ktx2')).toBe('assets/v1.0/file.ktx2');
  });
});

describe('available index', () => {
  it('parses a valid index and drops invalid entries', () => {
    const idx = parseAvailableIndex({
      version: ASSETS.indexVersion,
      generatedAt: '2026-01-01T00:00:00Z',
      assets: {
        'tex.floor': {
          type: 'textureSet',
          files: { map: 'assets/textures/a/a_diff_1k.jpg', bogus: 'assets/x.jpg', normalMap: '/etc/passwd' },
          ktx2: { map: 'assets/textures/a/a_diff_1k.ktx2', hdr: 'assets/x.ktx2' },
        },
        'hdri.industrial': { type: 'hdri', files: { hdr: 'assets/hdri/h_1k.hdr' } },
        broken: { type: 'spaceship', files: { map: 'assets/x.jpg' } },
        empty: { type: 'textureSet', files: {} },
      },
    });
    expect(idx).not.toBeNull();
    expect(Object.keys(idx?.assets ?? {}).sort()).toEqual(['hdri.industrial', 'tex.floor']);
    expect(idx?.assets['tex.floor']?.files).toEqual({ map: 'assets/textures/a/a_diff_1k.jpg' });
    expect(idx?.assets['tex.floor']?.ktx2).toEqual({ map: 'assets/textures/a/a_diff_1k.ktx2' });
  });

  it('rejects unknown versions and garbage', () => {
    expect(parseAvailableIndex({ version: 999, assets: {} })).toBeNull();
    expect(parseAvailableIndex('nope')).toBeNull();
    expect(parseAvailableIndex(null)).toBeNull();
  });

  it('plans texture loads: ORM supersedes separate maps, KTX2 only when enabled', () => {
    const asset: AvailableAsset = {
      type: 'textureSet',
      files: {
        map: 'assets/t/d.jpg',
        normalMap: 'assets/t/n.jpg',
        ormMap: 'assets/t/arm.jpg',
        roughnessMap: 'assets/t/r.jpg',
      },
      ktx2: { map: 'assets/t/d.ktx2' },
    };
    const plan = planTextureSet(asset, true);
    expect(plan.map((p) => p.role)).toEqual(['map', 'normalMap', 'ormMap']);
    expect(plan.find((p) => p.role === 'map')).toMatchObject({ srgb: true, ktx2Url: 'assets/t/d.ktx2' });
    expect(plan.find((p) => p.role === 'normalMap')).toMatchObject({ srgb: false, ktx2Url: null });
    expect(planTextureSet(asset, false).every((p) => p.ktx2Url === null)).toBe(true);

    const noOrm = planTextureSet(
      { type: 'textureSet', files: { map: 'assets/d.jpg', roughnessMap: 'assets/r.jpg' } },
      false,
    );
    expect(noOrm.map((p) => p.role)).toEqual(['map', 'roughnessMap']);
  });
});

describe('placeholders', () => {
  it('generates a two-color checker', () => {
    const data = createCheckerData(4, 2, [255, 0, 255], [0, 0, 0]);
    expect(data.length).toBe(4 * 4 * 4);
    expect([...data.slice(0, 4)]).toEqual([255, 0, 255, 255]);
    expect([...data.slice(2 * 4, 3 * 4)]).toEqual([0, 0, 0, 255]);
    expect([...data.slice((2 * 4 + 2) * 4, (2 * 4 + 3) * 4)]).toEqual([255, 0, 255, 255]);
  });

  it('creates a visible placeholder texture and model', () => {
    const tex = createPlaceholderTexture();
    expect(tex.image.width).toBe(ASSETS.placeholder.checkerSize);
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace);
    const model = createPlaceholderModel('x');
    expect(model.children.length).toBe(2);
    expect(model.userData.placeholder).toBe(true);
  });
});

describe('AssetLoader (no downloaded assets)', () => {
  const fakeRenderer = { capabilities: { getMaxAnisotropy: () => 4 } } as unknown as THREE.WebGLRenderer;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('requests only the index, falls back everywhere and never rejects', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const loader = new AssetLoader(fakeRenderer, () => null, './');
    const progress: [number, number, string][] = [];
    await loader.preload(REQUIRED_IDS, (l, t, label) => progress.push([l, t, label]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([
      './' + ASSETS.indexFile,
      { cache: 'no-cache', signal: expect.any(AbortSignal) },
    ]);
    expect(progress[0]).toEqual([0, REQUIRED_IDS.length, getAssetEntry(REQUIRED_IDS[0] as string)?.label]);
    expect(progress.at(-1)?.[0]).toBe(REQUIRED_IDS.length);
    expect([...loader.missing].sort()).toEqual([...REQUIRED_IDS].sort());

    expect(await loader.loadHDRI('hdri.industrial')).toBeNull();
    expect(await loader.loadTextureSet('tex.floor')).toBeNull();
    expect(loader.has('tex.floor')).toBe(false);
    const tex = await loader.loadTexture('tex.unknown');
    expect(tex.name).toBe('placeholder.checker');
    const model = await loader.loadModel('model.unknown');
    expect(model.placeholder).toBe(true);
    expect(await loader.loadAudio('sfx.unknown')).toBeNull();
    expect(loader.missing).toContain('model.unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    loader.dispose();
  });

  it('treats an HTML answer (dev server fallback) as a missing index', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200 })),
    );
    const loader = new AssetLoader(fakeRenderer, () => null, '/');
    expect(await loader.loadTextureSet('tex.floor')).toBeNull();
    expect(loader.availableIndex).toBeNull();
  });

  it('de-duplicates concurrent loads and reports failed files as missing', async () => {
    const index = {
      version: ASSETS.indexVersion,
      generatedAt: 'now',
      assets: { 'tex.floor': { type: 'textureSet', files: { map: 'assets/textures/x/x_diff_1k.jpg' } } },
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(index), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const loader = new AssetLoader(fakeRenderer, () => null, '/');
    const [a, b] = await Promise.all([
      loader.loadTextureSet('tex.floor'),
      loader.loadTextureSet('tex.floor'),
    ]);
    // No DOM image decoding in Node: the image fails, so the set falls back (null) instead of throwing.
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(loader.missing).toEqual(['tex.floor']);
    expect(loader.availableIndex?.assets['tex.floor']).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up on a stalled index request and aborts it', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal;
        return new Promise<Response>(() => undefined);
      }),
    );
    const loader = new AssetLoader(fakeRenderer, () => null, '/');
    const pending = loader.loadTextureSet('tex.floor');
    await vi.advanceTimersByTimeAsync(ASSETS.loader.requestTimeoutMs);
    expect(await pending).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(loader.missing).toEqual(['tex.floor']);
  });

  it('falls back when a texture request stalls and disposes the late texture', async () => {
    vi.useFakeTimers();
    const index = {
      version: ASSETS.indexVersion,
      generatedAt: 'now',
      assets: { 'tex.floor': { type: 'textureSet', files: { map: 'assets/textures/x/x_diff_1k.jpg' } } },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(index), { status: 200 })),
    );
    let deliver: (tex: THREE.Texture<HTMLImageElement>) => void = () => undefined;
    vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockImplementation(
      () =>
        new Promise<THREE.Texture<HTMLImageElement>>((resolve) => {
          deliver = resolve;
        }),
    );
    const loader = new AssetLoader(fakeRenderer, () => null, '/');
    const pending = loader.loadTextureSet('tex.floor');
    await vi.advanceTimersByTimeAsync(ASSETS.loader.requestTimeoutMs);
    expect(await pending).toBeNull();
    expect(loader.missing).toEqual(['tex.floor']);

    const late = new THREE.Texture<HTMLImageElement>();
    const dispose = vi.spyOn(late, 'dispose');
    deliver(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled HDRI download and uses the fallback', async () => {
    vi.useFakeTimers();
    const index = {
      version: ASSETS.indexVersion,
      generatedAt: 'now',
      assets: { 'hdri.industrial': { type: 'hdri', files: { hdr: 'assets/hdri/h_1k.hdr' } } },
    };
    let hdrSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (input instanceof Request) {
          hdrSignal = input.signal;
          return new Promise<Response>(() => undefined);
        }
        return Promise.resolve(new Response(JSON.stringify(index), { status: 200 }));
      }),
    );
    const loader = new AssetLoader(fakeRenderer, () => null, 'http://localhost/');
    const pending = loader.loadHDRI('hdri.industrial');
    await vi.advanceTimersByTimeAsync(ASSETS.loader.requestTimeoutMs);
    expect(await pending).toBeNull();
    expect(hdrSignal?.aborted).toBe(true);
    expect(loader.missing).toEqual(['hdri.industrial']);
  });
});

describe('withStallTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('extends the deadline while progress is reported', async () => {
    vi.useFakeTimers();
    const ms = ASSETS.loader.requestTimeoutMs;
    let progress: () => void = () => undefined;
    let finish: (v: string) => void = () => undefined;
    const p = withStallTimeout('x', ms, (onProgress) => {
      progress = onProgress;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(ms - 1);
      progress();
    }
    expect(settled).toBe(false);
    finish('done');
    await expect(p).resolves.toBe('done');
  });

  it('rejects after a stall, aborts, and disposes a late result', async () => {
    vi.useFakeTimers();
    const ms = ASSETS.loader.requestTimeoutMs;
    const abort = vi.fn();
    const dispose = vi.fn();
    let finish: (v: string) => void = () => undefined;
    const p = withStallTimeout(
      'x',
      ms,
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      dispose,
      abort,
    );
    const outcome = p.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(ms);
    expect(await outcome).toMatchObject({ name: 'TimeoutError' });
    expect(abort).toHaveBeenCalledTimes(1);
    finish('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(dispose).toHaveBeenCalledWith('late');
  });
});
