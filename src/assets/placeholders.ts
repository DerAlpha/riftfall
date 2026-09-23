/**
 * Loud stand-ins for content that failed to load: a magenta/black checker texture, a checker
 * cube with a floating wireframe marker for models, and silence for audio. They make missing
 * content obvious in-game without ever crashing. Shared GPU resources are created lazily once.
 */
import * as THREE from 'three';
import { ASSETS } from '../defs/assets';

const P = ASSETS.placeholder;

/** RGBA checker pixels (pure; exported for tests). */
export function createCheckerData(
  size: number,
  cells: number,
  colorA: readonly [number, number, number],
  colorB: readonly [number, number, number],
): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const cell = Math.max(1, Math.floor(size / Math.max(1, cells)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? colorA : colorB;
      const i = (y * size + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return data;
}

/** New magenta/black checker texture (sRGB, nearest filtering so it stays crisp and obvious). */
export function createPlaceholderTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    createCheckerData(P.checkerSize, P.checkerCells, P.colorA, P.colorB),
    P.checkerSize,
    P.checkerSize,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  tex.name = 'placeholder.checker';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapNearestFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

interface ModelResources {
  texture: THREE.DataTexture;
  boxGeometry: THREE.BoxGeometry;
  boxMaterial: THREE.MeshStandardMaterial;
  markerGeometry: THREE.WireframeGeometry;
  markerMaterial: THREE.LineBasicMaterial;
}

let modelResources: ModelResources | null = null;

function getModelResources(): ModelResources {
  if (modelResources) return modelResources;
  const texture = createPlaceholderTexture();
  texture.repeat.set(P.modelCheckerRepeat, P.modelCheckerRepeat);
  const octahedron = new THREE.OctahedronGeometry(P.markerSize, 0);
  modelResources = {
    texture,
    boxGeometry: new THREE.BoxGeometry(P.modelSize, P.modelSize, P.modelSize),
    boxMaterial: new THREE.MeshStandardMaterial({
      name: 'placeholder.model',
      map: texture,
      roughness: P.modelRoughness,
      metalness: 0,
    }),
    markerGeometry: new THREE.WireframeGeometry(octahedron),
    markerMaterial: new THREE.LineBasicMaterial({ name: 'placeholder.marker', color: P.markerColor }),
  };
  octahedron.dispose();
  return modelResources;
}

/**
 * Checker cube standing on the origin (like most props) with a wireframe marker above it.
 * Geometry/materials are shared between all placeholder instances – do not dispose them per instance.
 */
export function createPlaceholderModel(name = 'placeholder'): THREE.Group {
  const r = getModelResources();
  const group = new THREE.Group();
  group.name = name;
  const box = new THREE.Mesh(r.boxGeometry, r.boxMaterial);
  box.position.y = P.modelSize / 2;
  box.castShadow = true;
  box.receiveShadow = true;
  const marker = new THREE.LineSegments(r.markerGeometry, r.markerMaterial);
  marker.position.y = P.modelSize + P.markerGap + P.markerSize;
  group.add(box, marker);
  group.userData.placeholder = true;
  return group;
}

/** Releases the shared placeholder model resources (AssetLoader.dispose). */
export function disposePlaceholderResources(): void {
  if (!modelResources) return;
  modelResources.texture.dispose();
  modelResources.boxGeometry.dispose();
  modelResources.boxMaterial.dispose();
  modelResources.markerGeometry.dispose();
  modelResources.markerMaterial.dispose();
  modelResources = null;
}

/** Silent buffer (also used to unlock audio on iOS, which needs a buffer played in the gesture). */
export function createSilentBuffer(ctx: BaseAudioContext, seconds: number = P.silenceSeconds): AudioBuffer {
  const length = Math.max(1, Math.round(ctx.sampleRate * seconds));
  return ctx.createBuffer(1, length, ctx.sampleRate);
}
