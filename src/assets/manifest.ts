/**
 * Runtime asset manifest (built from defs/assets.ts) and the available-asset index.
 *
 * The manifest lists every asset the game knows, with the files it expects and the credits.
 * Whether those files exist is decided solely by `assets/available.json`, which
 * scripts/fetch-assets.mjs writes after downloading – the loader never requests a file that is
 * not listed there, so a fresh clone produces no 404 spam (only the index request itself).
 */
import type { AssetType } from '../core/contracts';
import {
  ASSET_DEFS,
  ASSETS,
  POLYHAVEN,
  SRGB_TEXTURE_ROLES,
  TEXTURE_ROLES,
  polyHavenHdriPath,
  polyHavenTexturePath,
  type AssetCreditDef,
  type AssetDef,
  type AssetFileRole,
  type PolyHavenSourceDef,
  type TextureRole,
} from '../defs/assets';

export type AssetCredit = AssetCreditDef;

export interface AssetManifestEntry {
  readonly id: string;
  readonly type: AssetType;
  /** Player-facing (German) loading label. */
  readonly label: string;
  /**
   * Expected files by role, relative to the Vite base and always under `assets/`. The fetch script
   * may substitute fallbacks (e.g. separate rough/metal maps when a set has no packed ORM map);
   * the available index records what was actually downloaded.
   */
  readonly files: Readonly<Partial<Record<AssetFileRole, string>>>;
  readonly credit: AssetCredit;
  readonly source: PolyHavenSourceDef;
  readonly physicalSizeM?: number;
}

const ASSET_TYPES: readonly AssetType[] = ['hdri', 'texture', 'textureSet', 'gltf', 'audio', 'lut'];
const FILE_ROLES: ReadonlySet<string> = new Set<AssetFileRole>([
  ...TEXTURE_ROLES,
  'hdr',
  'image',
  'model',
  'audio',
  'lut',
]);
const TEXTURE_ROLE_SET: ReadonlySet<string> = new Set<string>(TEXTURE_ROLES);

function expectedFiles(def: AssetDef): Partial<Record<AssetFileRole, string>> {
  const { assetId, resolution } = def.source;
  if (def.type === 'hdri') return { hdr: polyHavenHdriPath(assetId, resolution) };
  if (def.type === 'textureSet') {
    const files: Partial<Record<AssetFileRole, string>> = {};
    for (const role of POLYHAVEN.primaryTextureRoles)
      files[role] = polyHavenTexturePath(assetId, role, resolution);
    return files;
  }
  return {};
}

export const ASSET_MANIFEST: readonly AssetManifestEntry[] = ASSET_DEFS.map((def) => ({
  id: def.id,
  type: def.type,
  label: def.label,
  files: expectedFiles(def),
  credit: def.credit,
  source: def.source,
  ...(def.physicalSizeM !== undefined ? { physicalSizeM: def.physicalSizeM } : {}),
}));

const BY_ID: ReadonlyMap<string, AssetManifestEntry> = new Map(ASSET_MANIFEST.map((e) => [e.id, e]));

export function getAssetEntry(id: string): AssetManifestEntry | undefined {
  return BY_ID.get(id);
}

/**
 * A path the loader may request: relative to the base, below `assets/`, no traversal, no scheme,
 * no query. Guards against a tampered/hand-edited index pointing anywhere else.
 */
export function isSafeAssetPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false;
  if (!p.startsWith('assets/')) return false;
  if (p.includes('..') || p.includes('\\') || p.includes('//') || p.includes(':') || /[?#\s]/.test(p))
    return false;
  return true;
}

/** Problems with the manifest (empty = valid). Used by tests. */
export function validateManifest(entries: readonly AssetManifestEntry[] = ASSET_MANIFEST): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) errors.push(`duplicate id "${e.id}"`);
    seen.add(e.id);
    if (!ASSET_TYPES.includes(e.type)) errors.push(`${e.id}: unknown type "${e.type}"`);
    if (!e.label.trim()) errors.push(`${e.id}: missing label`);
    const files = Object.entries(e.files);
    if (files.length === 0) errors.push(`${e.id}: no files`);
    for (const [role, path] of files) {
      if (!FILE_ROLES.has(role)) errors.push(`${e.id}: unknown file role "${role}"`);
      if (!isSafeAssetPath(path))
        errors.push(`${e.id}: file path "${String(path)}" must be relative and below assets/`);
    }
    const c = e.credit;
    if (!c.title.trim() || !c.author.trim()) errors.push(`${e.id}: credit needs title and author`);
    if (!/^https:\/\/\S+$/.test(c.source)) errors.push(`${e.id}: credit source must be an https URL`);
    if (c.license !== 'CC0') errors.push(`${e.id}: license must be CC0`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Available index (public/assets/available.json)
// ---------------------------------------------------------------------------

export interface AvailableAsset {
  readonly type: AssetType;
  /** Downloaded files by role (base-relative). */
  readonly files: Readonly<Partial<Record<AssetFileRole, string>>>;
  /** Converted KTX2 variants by texture role (preferred when the GPU/transcoder supports them). */
  readonly ktx2?: Readonly<Partial<Record<TextureRole, string>>>;
}

export interface AvailableIndex {
  readonly version: number;
  readonly generatedAt: string;
  readonly assets: Readonly<Record<string, AvailableAsset>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseFileMap(raw: unknown, allowed: ReadonlySet<string>): Partial<Record<string, string>> {
  const out: Partial<Record<string, string>> = {};
  if (!isRecord(raw)) return out;
  for (const [role, path] of Object.entries(raw)) {
    if (allowed.has(role) && isSafeAssetPath(path)) out[role] = path;
  }
  return out;
}

/** Validate the index written by the fetch script; invalid entries are dropped, a wrong version yields null. */
export function parseAvailableIndex(raw: unknown): AvailableIndex | null {
  if (!isRecord(raw) || raw.version !== ASSETS.indexVersion || !isRecord(raw.assets)) return null;
  const assets: Record<string, AvailableAsset> = {};
  for (const [id, entry] of Object.entries(raw.assets)) {
    if (!isRecord(entry) || typeof entry.type !== 'string' || !ASSET_TYPES.includes(entry.type as AssetType))
      continue;
    const files = parseFileMap(entry.files, FILE_ROLES);
    if (Object.keys(files).length === 0) continue;
    const ktx2 = parseFileMap(entry.ktx2, TEXTURE_ROLE_SET);
    assets[id] = {
      type: entry.type as AssetType,
      files,
      ...(Object.keys(ktx2).length > 0 ? { ktx2 } : {}),
    };
  }
  return {
    version: ASSETS.indexVersion,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    assets,
  };
}

export interface TextureLoadPlan {
  readonly role: TextureRole;
  /** Image file (jpg/png), always present. */
  readonly url: string;
  /** KTX2 variant to try first, if any. */
  readonly ktx2Url: string | null;
  readonly srgb: boolean;
}

/**
 * Which files to load for a texture set. A packed ORM map makes separate AO/rough/metal maps
 * redundant, so those are skipped when `ormMap` is present.
 */
export function planTextureSet(asset: AvailableAsset, useKtx2: boolean): TextureLoadPlan[] {
  const plan: TextureLoadPlan[] = [];
  const hasOrm = asset.files.ormMap !== undefined;
  for (const role of TEXTURE_ROLES) {
    const url = asset.files[role];
    if (!url) continue;
    if (hasOrm && (role === 'aoMap' || role === 'roughnessMap' || role === 'metalnessMap')) continue;
    plan.push({
      role,
      url,
      ktx2Url: useKtx2 ? (asset.ktx2?.[role] ?? null) : null,
      srgb: SRGB_TEXTURE_ROLES.includes(role),
    });
  }
  return plan;
}
