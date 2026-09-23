/**
 * Procedural placeholder viewmodel: a compact sci-fi "rift scanner" sidearm.
 * Origin = grip pivot (where the hand would hold it), barrel points down -Z.
 * Parts are merged per material → 7 draw calls. Dimensions/colors below are model content,
 * not gameplay tuning (emissive intensities come from VIEWMODEL.glow).
 */
import {
  BoxGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  DataTexture,
  Euler,
  Group,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  Object3D,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  LinearFilter,
  type BufferGeometry,
  type Material,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createLogger } from '../core/log';
import { VIEWMODEL } from '../defs/camera';

const log = createLogger('viewmodel');

type MatKey = 'body' | 'shroud' | 'accent' | 'grip' | 'core' | 'strip' | 'screen';

interface Part {
  mat: MatKey;
  geo: () => BufferGeometry;
  pos: readonly [number, number, number];
  rot?: readonly [number, number, number];
}

const HALF_PI = Math.PI / 2;

/** Model content (meters). */
const PARTS: readonly Part[] = [
  // Receiver body + top cover + screen bezel
  { mat: 'body', geo: () => new RoundedBoxGeometry(0.062, 0.075, 0.22, 3, 0.012), pos: [0, 0.035, -0.07] },
  {
    mat: 'body',
    geo: () => new RoundedBoxGeometry(0.052, 0.036, 0.012, 2, 0.004),
    pos: [0, 0.07, 0.035],
    rot: [-0.5, 0, 0],
  },
  { mat: 'accent', geo: () => new BoxGeometry(0.034, 0.012, 0.15), pos: [0, 0.078, -0.085] },
  // Grip, trigger guard, trigger
  {
    mat: 'grip',
    geo: () => new RoundedBoxGeometry(0.045, 0.12, 0.058, 2, 0.01),
    pos: [0, -0.045, 0.012],
    rot: [-0.28, 0, 0],
  },
  { mat: 'accent', geo: () => new BoxGeometry(0.01, 0.008, 0.065), pos: [0, -0.02, -0.05] },
  {
    mat: 'accent',
    geo: () => new BoxGeometry(0.008, 0.026, 0.008),
    pos: [0, -0.006, -0.038],
    rot: [-0.3, 0, 0],
  },
  // Barrel: glowing core visible between shroud rings
  {
    mat: 'core',
    geo: () => new CylinderGeometry(0.011, 0.011, 0.19, 14),
    pos: [0, 0.035, -0.27],
    rot: [HALF_PI, 0, 0],
  },
  {
    mat: 'shroud',
    geo: () => new CylinderGeometry(0.025, 0.025, 0.022, 20),
    pos: [0, 0.035, -0.195],
    rot: [HALF_PI, 0, 0],
  },
  {
    mat: 'shroud',
    geo: () => new CylinderGeometry(0.024, 0.024, 0.02, 20),
    pos: [0, 0.035, -0.24],
    rot: [HALF_PI, 0, 0],
  },
  {
    mat: 'shroud',
    geo: () => new CylinderGeometry(0.023, 0.023, 0.02, 20),
    pos: [0, 0.035, -0.283],
    rot: [HALF_PI, 0, 0],
  },
  {
    mat: 'shroud',
    geo: () => new CylinderGeometry(0.022, 0.022, 0.02, 20),
    pos: [0, 0.035, -0.326],
    rot: [HALF_PI, 0, 0],
  },
  { mat: 'shroud', geo: () => new BoxGeometry(0.012, 0.01, 0.16), pos: [0, 0.061, -0.265] },
  { mat: 'shroud', geo: () => new BoxGeometry(0.01, 0.008, 0.16), pos: [0, 0.009, -0.265] },
  // Muzzle ring + inner glow ring
  { mat: 'accent', geo: () => new TorusGeometry(0.025, 0.0055, 10, 28), pos: [0, 0.035, -0.362] },
  { mat: 'core', geo: () => new TorusGeometry(0.017, 0.0028, 8, 24), pos: [0, 0.035, -0.366] },
  // Heat-sink fins
  ...[-0.125, -0.14, -0.155].flatMap((z): Part[] => [
    { mat: 'shroud', geo: () => new BoxGeometry(0.004, 0.034, 0.009), pos: [0.034, 0.035, z] },
    { mat: 'shroud', geo: () => new BoxGeometry(0.004, 0.034, 0.009), pos: [-0.034, 0.035, z] },
  ]),
  // Side energy cells + warning strips
  {
    mat: 'accent',
    geo: () => new CapsuleGeometry(0.011, 0.05, 4, 10),
    pos: [-0.037, 0.03, -0.03],
    rot: [HALF_PI, 0, 0],
  },
  { mat: 'strip', geo: () => new BoxGeometry(0.002, 0.005, 0.11), pos: [0.0315, 0.052, -0.085] },
  { mat: 'strip', geo: () => new BoxGeometry(0.002, 0.005, 0.11), pos: [-0.0315, 0.052, -0.085] },
  // Screen (faces the camera, tilted back)
  { mat: 'screen', geo: () => new PlaneGeometry(0.042, 0.027), pos: [0, 0.072, 0.0418], rot: [-0.5, 0, 0] },
];

const COLORS = {
  body: 0x2b313a,
  shroud: 0x15181c,
  accent: 0xc9ced4,
  grip: 0x1a1c1f,
  coreBase: 0x061418,
  coreGlow: 0x37e6ff,
  stripBase: 0x100804,
  stripGlow: 0xff6a1a,
} as const;

/** Where the core light should sit (barrel center), in model space. */
export const PLACEHOLDER_CORE_POSITION = { x: 0, y: 0.035, z: -0.27 } as const;

/**
 * Effect sockets (model space, rotation in degrees; local −Z = effect direction) so muzzle flash,
 * tracers and casings also work while no weapon model is shown.
 */
export const PLACEHOLDER_SOCKETS = {
  muzzle: { pos: [0, 0.035, -0.372], rot: [0, 0, 0] },
  ejectPort: { pos: [0.034, 0.06, -0.06], rot: [-40, -110, 0] },
  sight: { pos: [0, 0.084, -0.05], rot: [0, 0, 0] },
} as const;

export type PlaceholderSocket = keyof typeof PLACEHOLDER_SOCKETS;

export interface PlaceholderDevice {
  root: Group;
  /** Materials whose emissive intensity the rig animates. */
  coreMaterial: MeshStandardMaterial;
  stripMaterial: MeshStandardMaterial;
  screenMaterial: MeshStandardMaterial;
  screenTexture: DataTexture;
  sockets: Record<PlaceholderSocket, Object3D>;
  dispose(): void;
}

/** Small procedural "scanner" readout: grid, waveform and bar graph. Tiles horizontally. */
function createScreenTexture(): DataTexture {
  const w = 128;
  const h = 64;
  const data = new Uint8Array(w * h * 4);
  const set = (x: number, y: number, r: number, g: number, b: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = Math.max(data[i]!, r);
    data[i + 1] = Math.max(data[i + 1]!, g);
    data[i + 2] = Math.max(data[i + 2]!, b);
    data[i + 3] = 255;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, 2, 10, 14);
  for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 2) set(x, y, 8, 40, 50);
  for (let x = 0; x < w; x += 16) for (let y = 0; y < h; y += 2) set(x, y, 8, 40, 50);
  // Waveform: sum of sines that tiles over the texture width.
  for (let x = 0; x < w; x++) {
    const u = (x / w) * Math.PI * 2;
    const v = Math.sin(u * 2) * 0.45 + Math.sin(u * 5 + 1.3) * 0.25 + Math.sin(u * 11) * 0.12;
    const y = Math.round(h * 0.62 + v * h * 0.22);
    for (let d = -1; d <= 1; d++) set(x, y + d, 60, 230, 255);
  }
  // Bars along the bottom.
  for (let b = 0; b < 16; b++) {
    const bh = Math.round(4 + ((Math.sin(b * 1.7) + 1) / 2) * 12);
    for (let x = b * 8 + 1; x < b * 8 + 6; x++) for (let y = 2; y < 2 + bh; y++) set(x, y, 255, 120, 40);
  }
  const tex = new DataTexture(data, w, h);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function createPlaceholderDevice(): PlaceholderDevice {
  const screenTexture = createScreenTexture();
  const materials: Record<MatKey, MeshStandardMaterial> = {
    body: new MeshPhysicalMaterial({
      color: COLORS.body,
      metalness: 0.6,
      roughness: 0.36,
      clearcoat: 0.7,
      clearcoatRoughness: 0.2,
    }),
    shroud: new MeshStandardMaterial({ color: COLORS.shroud, metalness: 0.9, roughness: 0.28 }),
    accent: new MeshStandardMaterial({ color: COLORS.accent, metalness: 1, roughness: 0.18 }),
    grip: new MeshStandardMaterial({ color: COLORS.grip, metalness: 0, roughness: 0.88 }),
    core: new MeshStandardMaterial({
      color: COLORS.coreBase,
      emissive: COLORS.coreGlow,
      emissiveIntensity: VIEWMODEL.glow.coreIntensity,
      metalness: 0,
      roughness: 0.25,
    }),
    strip: new MeshStandardMaterial({
      color: COLORS.stripBase,
      emissive: COLORS.stripGlow,
      emissiveIntensity: VIEWMODEL.glow.stripIntensity,
      metalness: 0,
      roughness: 0.4,
    }),
    screen: new MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xffffff,
      emissiveMap: screenTexture,
      emissiveIntensity: VIEWMODEL.glow.screenIntensity,
      metalness: 0,
      roughness: 0.12,
    }),
  };

  const byMat = new Map<MatKey, BufferGeometry[]>();
  const m = new Matrix4();
  const q = new Quaternion();
  const e = new Euler();
  const p = new Vector3();
  const one = new Vector3(1, 1, 1);
  for (const part of PARTS) {
    let g = part.geo();
    if (part.rot) e.set(part.rot[0], part.rot[1], part.rot[2]);
    else e.set(0, 0, 0);
    q.setFromEuler(e);
    p.set(part.pos[0], part.pos[1], part.pos[2]);
    g.applyMatrix4(m.compose(p, q, one));
    // Mixed indexed/non-indexed inputs cannot be merged; normalise to non-indexed.
    if (g.index) {
      const ni = g.toNonIndexed();
      g.dispose();
      g = ni;
    }
    const list = byMat.get(part.mat) ?? [];
    list.push(g);
    byMat.set(part.mat, list);
  }

  const root = new Group();
  root.name = 'placeholder-rift-scanner';
  const geometries: BufferGeometry[] = [];
  for (const [key, list] of byMat) {
    const merged = list.length === 1 ? list[0]! : mergeGeometries(list, false);
    if (list.length > 1) for (const g of list) g.dispose();
    if (!merged) {
      log.warn(`could not merge viewmodel part geometry for "${key}"`);
      continue;
    }
    geometries.push(merged);
    const mesh = new Mesh(merged, materials[key]);
    mesh.name = `vm-${key}`;
    root.add(mesh);
  }

  const DEG = Math.PI / 180;
  const sockets = {} as Record<PlaceholderSocket, Object3D>;
  for (const key of Object.keys(PLACEHOLDER_SOCKETS) as PlaceholderSocket[]) {
    const def = PLACEHOLDER_SOCKETS[key];
    const socket = new Object3D();
    socket.name = `socket-${key}`;
    socket.position.set(def.pos[0], def.pos[1], def.pos[2]);
    socket.rotation.set(def.rot[0] * DEG, def.rot[1] * DEG, def.rot[2] * DEG);
    root.add(socket);
    sockets[key] = socket;
  }

  return {
    root,
    sockets,
    coreMaterial: materials.core,
    stripMaterial: materials.strip,
    screenMaterial: materials.screen,
    screenTexture,
    dispose(): void {
      for (const g of geometries) g.dispose();
      for (const mat of Object.values(materials) as Material[]) mat.dispose();
      screenTexture.dispose();
    },
  };
}
