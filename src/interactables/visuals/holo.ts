/**
 * Additive "hologram" family of the interactables – all drawn on RENDER.volumetricLayer (after AO
 * and height fog, depth-tested against the world, no depth write) and fogged in their own shader
 * like every volumetric (CLAUDE.md render pipeline):
 * - model holograms (weapons over wall buys and in the box): fresnel rims read as a glowing
 *   outline, faint body fill, world-space scanlines, flicker and an occasional glitch band,
 * - text/icon panels (door prices, wall-buy plates, the anomaly): a canvas mask tinted by the
 *   color, frame, faint background, scanlines,
 * - floor light pools (fake light spill of neon fixtures – real lights never change at runtime),
 * - the box's light beam.
 * One shared `uTime` uniform object drives all of them (set once per frame by the placement).
 */
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  FrontSide,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  type Object3D,
  type Texture,
} from 'three';
import { HOLOGRAM, LIGHT_POOL, type Rgb } from '../../defs/interactables';
import { RENDER } from '../../defs/graphics';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_PARAMS } from '../../render/postfx/fogShared';

export interface TimeUniform {
  value: number;
}

const HASH_GLSL = /* glsl */ `
float holoHash(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
`;

const HOLO_VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
varying vec3 vNormalW;
varying vec3 vViewW;
varying vec3 vWorld;
varying vec2 vUv;
varying float vFog;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewW = cameraPosition - wp.xyz;
  vUv = uv;
  // Drawn after the height-fog pass (volumetric layer): fog to its own position.
  vFog = fogTransmittance(cameraPosition, wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const HOLO_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform float uFlash;
uniform float uFade;
uniform float uFlicker;
uniform float uSeed;
uniform float uScanDensity;
uniform float uScanSpeed;
uniform float uScanDepth;
uniform float uRimPower;
uniform float uRimStrength;
uniform float uFill;
uniform float uGlitch;
uniform float uGlitchInterval;
uniform float uFlickerRate;
#ifdef HOLO_PANEL
uniform sampler2D uMap;
uniform float uHasMap;
uniform vec3 uPanel; // text, frame, background
#endif
varying vec3 vNormalW;
varying vec3 vViewW;
varying vec3 vWorld;
varying vec2 vUv;
varying float vFog;
${HASH_GLSL}
void main() {
  float scanCoord = vWorld.y * uScanDensity - uTime * uScanSpeed * uScanDensity;
  float scan = 1.0 - uScanDepth * (0.5 + 0.5 * sin(scanCoord * 6.2831853));
  float flick = 1.0 - uFlicker * holoHash(floor(uTime * uFlickerRate) + uSeed * 17.0);
  // A thin bright band sweeps up through the hologram every uGlitchInterval seconds.
  float phase = fract(uTime / uGlitchInterval + uSeed);
  float band = uGlitch * (1.0 - smoothstep(0.0, 0.04, abs(fract(vWorld.y * 0.7 - phase * 2.0) - 0.5)));
#ifdef HOLO_PANEL
  vec4 t = uHasMap > 0.5 ? texture2D(uMap, vUv) : vec4(0.0);
  float mask = max(t.r, max(t.g, t.b)) * t.a;
  float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  float frame = 1.0 - smoothstep(0.0, 0.025, edge);
  float i = (mask * uPanel.x + frame * uPanel.y + uPanel.z) * scan * flick + band * 0.5 + uFlash * 0.6;
  // Bright text cores run white-hot (bloom reads them as light, not paint).
  vec3 col = uColor * i + vec3(pow(mask, 3.0) * uPanel.x * 0.35 * flick);
#else
  vec3 n = normalize(vNormalW);
  vec3 v = normalize(vViewW);
  float fres = pow(1.0 - abs(dot(n, v)), uRimPower);
  float i = (uFill + uRimStrength * fres) * scan * flick + band + uFlash * (0.35 + fres);
  vec3 col = uColor * i;
#endif
  gl_FragColor = vec4(col * uIntensity * uFade * vFog, 1.0);
}
`;

export interface HoloMaterialOptions {
  color: Rgb;
  intensity: number;
  time: TimeUniform;
  /** Panel: canvas mask (null = frame + background only). */
  map?: Texture | null;
  panel?: boolean;
  reduceFlashing?: boolean;
  /** Per-instance phase offset (flicker / glitch desync). */
  seed?: number;
  doubleSided?: boolean;
  /** Panels: draw the glowing frame (default true). */
  frame?: boolean;
}

export type HoloMaterial = ShaderMaterial & {
  uniforms: {
    uColor: { value: Color };
    uIntensity: { value: number };
    uFlash: { value: number };
    uFade: { value: number };
    uFlicker: { value: number };
    uGlitch: { value: number };
    uMap: { value: Texture | null };
    uHasMap: { value: number };
  };
};

export function createHoloMaterial(o: HoloMaterialOptions): HoloMaterial {
  const H = HOLOGRAM;
  const panel = o.panel === true;
  const m = new ShaderMaterial({
    name: panel ? 'holo-panel' : 'holo-model',
    defines: panel ? { HOLO_PANEL: '' } : {},
    uniforms: {
      uColor: { value: new Color(o.color[0], o.color[1], o.color[2]) },
      uIntensity: { value: o.intensity },
      uTime: o.time,
      uFlash: { value: 0 },
      uFade: { value: 1 },
      uFlicker: { value: o.reduceFlashing ? H.reducedFlickerDepth : H.flickerDepth },
      uSeed: { value: o.seed ?? 0 },
      uScanDensity: { value: H.scanDensity },
      uScanSpeed: { value: H.scanSpeed },
      uScanDepth: { value: H.scanDepth },
      uRimPower: { value: H.rimPower },
      uRimStrength: { value: H.rimStrength },
      uFill: { value: H.fill },
      uGlitch: { value: o.reduceFlashing ? 0 : H.glitchStrength },
      uGlitchInterval: { value: H.glitchInterval },
      uFlickerRate: { value: H.flickerRate },
      uMap: { value: o.map ?? null },
      uHasMap: { value: o.map ? 1 : 0 },
      uPanel: { value: [H.panel.text, o.frame === false ? 0 : H.panel.frame, H.panel.background] },
      // Shared by reference: HeightFogEffect.setFog updates it.
      fogParams: HEIGHT_FOG_PARAMS,
    },
    vertexShader: HOLO_VERTEX,
    fragmentShader: HOLO_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: o.doubleSided ? DoubleSide : FrontSide,
    toneMapped: false,
    fog: false,
  });
  return m as HoloMaterial;
}

/** Reduced flashing: calmer flicker, no glitch band. */
export function setHoloReducedFlashing(m: HoloMaterial, reduced: boolean): void {
  m.uniforms.uFlicker.value = reduced ? HOLOGRAM.reducedFlickerDepth : HOLOGRAM.flickerDepth;
  m.uniforms.uGlitch.value = reduced ? 0 : HOLOGRAM.glitchStrength;
}

/** Put an additive mesh on the volumetric layer (drawn by the volumetric pass, never shadows). */
export function toVolumetricLayer<T extends Object3D>(o: T): T {
  o.layers.set(RENDER.volumetricLayer);
  o.castShadow = false;
  o.receiveShadow = false;
  // Decoration: never part of the navmesh or of bullet tests.
  o.userData.navIgnore = true;
  return o;
}

// ---------------------------------------------------------------------------
// Floor light pool
// ---------------------------------------------------------------------------

const POOL_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uFalloff;
varying vec2 vUv;
varying float vFog;
void main() {
  vec2 d = vUv * 2.0 - 1.0;
  float r = clamp(1.0 - dot(d, d), 0.0, 1.0);
  gl_FragColor = vec4(uColor * pow(r, uFalloff) * uIntensity * vFog, 1.0);
}
`;

const POOL_VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
varying vec2 vUv;
varying float vFog;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vUv = uv;
  vFog = fogTransmittance(cameraPosition, wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export type PoolMaterial = ShaderMaterial & {
  uniforms: { uColor: { value: Color }; uIntensity: { value: number } };
};

/** Additive radial glow lying on the floor (`radius` m), centered on the returned mesh's origin. */
export function createLightPool(
  color: Rgb,
  intensity: number,
  radius: number,
): Mesh<PlaneGeometry, PoolMaterial> {
  const mat = new ShaderMaterial({
    name: 'light-pool',
    uniforms: {
      uColor: { value: new Color(color[0], color[1], color[2]) },
      uIntensity: { value: intensity },
      uFalloff: { value: LIGHT_POOL.falloff },
      fogParams: HEIGHT_FOG_PARAMS,
    },
    vertexShader: POOL_VERTEX,
    fragmentShader: POOL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false,
    fog: false,
  }) as PoolMaterial;
  const geo = new PlaneGeometry(radius * 2, radius * 2);
  geo.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geo, mat);
  mesh.position.y = LIGHT_POOL.lift;
  mesh.name = 'light-pool';
  return toVolumetricLayer(mesh);
}

// ---------------------------------------------------------------------------
// Beam
// ---------------------------------------------------------------------------

const BEAM_VERTEX = /* glsl */ `
${HEIGHT_FOG_GLSL}
varying vec3 vNormalW;
varying vec3 vViewW;
varying vec2 vUv;
varying float vFog;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vViewW = cameraPosition - wp.xyz;
  vUv = uv;
  vFog = fogTransmittance(cameraPosition, wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const BEAM_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform float uHeight;
varying vec3 vNormalW;
varying vec3 vViewW;
varying vec2 vUv;
varying float vFog;
${HASH_GLSL}
void main() {
  vec3 n = normalize(vNormalW);
  vec3 v = normalize(vViewW);
  // Bright core where the view grazes the axis, soft silhouette edges.
  float facing = abs(dot(n, v));
  float core = pow(facing, 1.6);
  float h = vUv.y * uHeight;
  // Fade in above the box, fade out towards the ceiling.
  float vertical = smoothstep(0.0, 0.8, h) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
  // Energy rising: streaks around the circumference scrolling up.
  float streak = 0.65 + 0.35 * sin(vUv.x * 37.699 + h * 1.7 - uTime * 3.1);
  float pulse = 0.85 + 0.15 * sin(uTime * 2.3 + h * 0.6);
  float i = core * vertical * streak * pulse;
  gl_FragColor = vec4(uColor * i * uIntensity * vFog, 1.0);
}
`;

export type BeamMaterial = ShaderMaterial & {
  uniforms: { uColor: { value: Color }; uIntensity: { value: number }; uHeight: { value: number } };
};

export function createBeamMaterial(color: Rgb, intensity: number, time: TimeUniform): BeamMaterial {
  return new ShaderMaterial({
    name: 'box-beam',
    uniforms: {
      uColor: { value: new Color(color[0], color[1], color[2]) },
      uIntensity: { value: intensity },
      uTime: time,
      uHeight: { value: 1 },
      fogParams: HEIGHT_FOG_PARAMS,
    },
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    fog: false,
  }) as BeamMaterial;
}
