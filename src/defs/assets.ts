/**
 * Downloadable CC0 assets (sources + credits) and asset loader / fetch tuning.
 *
 * Self-contained on purpose – only `import type` (erased at runtime): scripts/fetch-assets.mjs
 * imports this file directly with Node's TypeScript type stripping, so the download script, the
 * runtime manifest (src/assets/manifest.ts) and CREDITS.md all come from this one table.
 *
 * Paths are relative to the Vite base (files live in public/). Nothing here is required at
 * runtime: without downloaded files the game uses procedural textures/environment.
 */
import type { AssetType } from '../core/contracts';

/** TextureSet slots (contracts.ts) a file can fill. */
export type TextureRole =
  'map' | 'normalMap' | 'ormMap' | 'aoMap' | 'roughnessMap' | 'metalnessMap' | 'emissiveMap';
/** Role of a file inside a manifest entry: texture slots, or the single file of other asset types. */
export type AssetFileRole = TextureRole | 'hdr' | 'image' | 'model' | 'audio' | 'lut';

export const TEXTURE_ROLES: readonly TextureRole[] = [
  'map',
  'normalMap',
  'ormMap',
  'aoMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
];

/** Color maps are sRGB; all other texture roles hold linear data. */
export const SRGB_TEXTURE_ROLES: readonly TextureRole[] = ['map', 'emissiveMap'];

export type PolyHavenResolution = '1k' | '2k' | '4k';

export interface PolyHavenSourceDef {
  readonly provider: 'polyhaven';
  /** Poly Haven asset id (https://polyhaven.com/a/<assetId>). */
  readonly assetId: string;
  /** Preferred resolution; the fetch script falls back along ASSETS.fetch.resolutionFallback. */
  readonly resolution: PolyHavenResolution;
}

export interface AssetCreditDef {
  readonly title: string;
  readonly author: string;
  /** Source URL (asset page). */
  readonly source: string;
  readonly license: 'CC0';
}

export interface AssetDef {
  readonly id: string;
  readonly type: AssetType;
  /** Player-facing (German) label for the loading screen. */
  readonly label: string;
  readonly source: PolyHavenSourceDef;
  readonly credit: AssetCreditDef;
  /** Real-world size (m) of one texture repeat (Poly Haven metadata) – guidance for material uvScale. */
  readonly physicalSizeM?: number;
}

export const POLYHAVEN = {
  apiBase: 'https://api.polyhaven.com',
  assetPageBase: 'https://polyhaven.com/a/',
  /** TextureSet role → Poly Haven map key and our file suffix. `arm` = AO/rough/metal (glTF ORM layout). */
  textureMaps: {
    map: { key: 'Diffuse', suffix: 'diff' },
    normalMap: { key: 'nor_gl', suffix: 'nor_gl' },
    ormMap: { key: 'arm', suffix: 'arm' },
    roughnessMap: { key: 'Rough', suffix: 'rough' },
    metalnessMap: { key: 'Metal', suffix: 'metal' },
    aoMap: { key: 'AO', suffix: 'ao' },
  } as const satisfies Partial<Record<TextureRole, { key: string; suffix: string }>>,
  /** Always downloaded for texture sets. */
  primaryTextureRoles: ['map', 'normalMap', 'ormMap'] as const satisfies readonly TextureRole[],
  /** Downloaded only when a set has no packed `arm` map. */
  fallbackTextureRoles: ['roughnessMap', 'metalnessMap', 'aoMap'] as const satisfies readonly TextureRole[],
  textureFormat: 'jpg',
  hdriKey: 'hdri',
  hdriFormat: 'hdr',
} as const;

export type PolyHavenTextureRole = keyof typeof POLYHAVEN.textureMaps;

export const ASSETS = {
  /** Folders below the Vite base (public/ in the repo; gitignored, filled by `npm run assets`). */
  dirs: {
    hdri: 'assets/hdri',
    textures: 'assets/textures',
    models: 'assets/models',
    audio: 'assets/audio',
  },
  /** Written by scripts/fetch-assets.mjs; lists what was actually downloaded. Missing = nothing available. */
  indexFile: 'assets/available.json',
  indexVersion: 1,
  loader: {
    /** Parallel requests during preload(). */
    maxConcurrent: 4,
    /** Anisotropy for asset textures (capped by the GPU; materials may override on their clones). */
    anisotropy: 8,
    /** Sample rate used to decode audio when no AudioContext exists yet. */
    fallbackDecodeSampleRate: 48000,
    /** KTX2 transcoder worker count. */
    ktx2Workers: 2,
    /**
     * A request that reports no progress for this long fails and its fallback is used (a stalled
     * connection must not hold the loading screen). Requests without progress events (images,
     * index, audio) get this as total time.
     */
    requestTimeoutMs: 15_000,
  },
  placeholder: {
    /** Missing texture: magenta/black checker (loud on purpose). */
    checkerSize: 64,
    checkerCells: 8,
    colorA: [255, 0, 255] as const,
    colorB: [0, 0, 0] as const,
    /** Checker repeats per placeholder model face. */
    modelCheckerRepeat: 2,
    modelRoughness: 0.6,
    /** Missing model: checker cube of this edge length (m) + a wireframe marker floating above it. */
    modelSize: 0.5,
    markerSize: 0.14,
    markerGap: 0.12,
    markerColor: 0xff00ff,
    /** Missing audio: silent buffer length (s). */
    silenceSeconds: 0.05,
  },
  fetch: {
    /** Resolution tried after the preferred one when Poly Haven does not offer it. */
    resolutionFallback: ['1k', '2k'] as const satisfies readonly PolyHavenResolution[],
    requestTimeoutMs: 20_000,
    downloadTimeoutMs: 120_000,
    retries: 3,
    retryBaseDelayMs: 750,
    concurrency: 4,
    userAgent: 'riftfall-fetch-assets/1.0',
  },
  /**
   * Optional KTX2 conversion (only when `toktx` is on PATH). Both variants flip rows
   * (--lower_left_maps_to_s0t0) so KTX2 data matches the jpg + flipY=true convention of TextureLoader
   * (compressed textures ignore flipY): identical UVs and normal-map green channel for both formats.
   */
  ktx2: {
    tool: 'toktx',
    /** Albedo/emissive: ETC1S, sRGB. */
    colorArgs: [
      '--t2',
      '--encode',
      'etc1s',
      '--clevel',
      '4',
      '--qlevel',
      '255',
      '--genmipmap',
      '--assign_oetf',
      'srgb',
      '--lower_left_maps_to_s0t0',
    ],
    /** Normals and packed data maps: UASTC + zstd, linear. */
    dataArgs: [
      '--t2',
      '--encode',
      'uastc',
      '--uastc_quality',
      '2',
      '--zcmp',
      '18',
      '--genmipmap',
      '--assign_oetf',
      'linear',
      '--lower_left_maps_to_s0t0',
    ],
    timeoutMs: 180_000,
  },
} as const;

function polyHaven(assetId: string, resolution: PolyHavenResolution): PolyHavenSourceDef {
  return { provider: 'polyhaven', assetId, resolution };
}

function cc0(title: string, author: string, assetId: string): AssetCreditDef {
  return { title, author, source: `${POLYHAVEN.assetPageBase}${assetId}`, license: 'CC0' };
}

/** Every downloadable asset. Ids are referenced by defs/maps.ts and defs/materials.ts. */
export const ASSET_DEFS: readonly AssetDef[] = [
  {
    id: 'hdri.industrial',
    type: 'hdri',
    label: 'Umgebungslicht',
    // Cool fluorescent warehouse interior: dim industrial reflections for the calibration hall.
    source: polyHaven('empty_warehouse_01', '1k'),
    credit: cc0('Empty Warehouse 01', 'Sergej Majboroda', 'empty_warehouse_01'),
  },
  {
    id: 'tex.floor',
    type: 'textureSet',
    label: 'Bodenplatten',
    source: polyHaven('metal_plate', '1k'),
    credit: cc0('Metal Plate', 'Rob Tuytel', 'metal_plate'),
    physicalSizeM: 0.5,
  },
  {
    id: 'tex.concrete',
    type: 'textureSet',
    label: 'Beton',
    source: polyHaven('concrete_floor_worn_001', '1k'),
    credit: cc0('Concrete Floor Worn 001', 'Dimitrios Savva, Rico Cilliers', 'concrete_floor_worn_001'),
    physicalSizeM: 3,
  },
];

/** Base-relative path of one Poly Haven texture map (shared by the fetch script and the manifest). */
export function polyHavenTexturePath(
  assetId: string,
  role: PolyHavenTextureRole,
  resolution: PolyHavenResolution,
  ext: string = POLYHAVEN.textureFormat,
): string {
  const suffix = POLYHAVEN.textureMaps[role].suffix;
  return `${ASSETS.dirs.textures}/${assetId}/${assetId}_${suffix}_${resolution}.${ext}`;
}

/** Base-relative path of a Poly Haven HDRI. */
export function polyHavenHdriPath(assetId: string, resolution: PolyHavenResolution): string {
  return `${ASSETS.dirs.hdri}/${assetId}_${resolution}.${POLYHAVEN.hdriFormat}`;
}

/** Same file with another extension (KTX2 variants live next to their source image). */
export function withExtension(path: string, ext: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return (dot > slash ? path.slice(0, dot) : path) + '.' + ext;
}
