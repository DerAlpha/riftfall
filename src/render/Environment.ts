/**
 * Image-based lighting: PMREM from an equirectangular HDRI, or – when no HDRI is available –
 * from a small procedural "room" (gradient sky dome + emissive panels), so PBR materials always
 * get plausible reflections. Also sets the visible background (solid color or blurred env).
 */
import * as THREE from 'three';
import { createLogger } from '../core/log';
import { DEG2RAD } from '../core/math';
import type { EnvironmentDef } from '../defs/maps';
import { ENVIRONMENT } from '../defs/graphics';

const log = createLogger('Environment');

const domeVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const domeFragment = /* glsl */ `
uniform vec3 skyColor;
uniform vec3 horizonColor;
uniform vec3 groundColor;
uniform vec2 exponents;
varying vec3 vDir;
void main() {
  float y = normalize(vDir).y;
  vec3 c = y >= 0.0
    ? mix(horizonColor, skyColor, pow(clamp(y, 0.0, 1.0), exponents.x))
    : mix(horizonColor, groundColor, pow(clamp(-y, 0.0, 1.0), exponents.y));
  // Linear HDR output straight into the PMREM (half-float) target.
  gl_FragColor = vec4(c, 1.0);
}
`;

export class EnvironmentManager {
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly backgroundColor = new THREE.Color();
  /** True if the current environment came from the procedural fallback. */
  procedural = false;

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  /** The current PMREM texture (null before the first apply). */
  get texture(): THREE.Texture | null {
    return this.target?.texture ?? null;
  }

  /**
   * Build the environment and apply it to all given scenes (world + viewmodel share the IBL).
   * Background is only set on `backgroundScene` (the viewmodel pass ignores backgrounds anyway).
   */
  apply(
    def: EnvironmentDef,
    hdri: THREE.Texture | null,
    scenes: readonly THREE.Scene[],
    backgroundScene: THREE.Scene,
  ): void {
    const next = this.generate(def, hdri);
    if (next) {
      this.target?.dispose();
      this.target = next;
    }
    const envTex = this.target?.texture ?? null;
    const rotY = def.rotationDeg * DEG2RAD;

    for (const scene of scenes) {
      scene.environment = envTex;
      scene.environmentIntensity = def.intensity;
      scene.environmentRotation.set(0, rotY, 0);
    }

    if (def.background === 'environment' && envTex) {
      backgroundScene.background = envTex;
      backgroundScene.backgroundBlurriness = def.backgroundBlurriness;
      backgroundScene.backgroundIntensity = def.backgroundIntensity;
      backgroundScene.backgroundRotation.set(0, rotY, 0);
    } else {
      this.backgroundColor.setRGB(def.backgroundColor[0], def.backgroundColor[1], def.backgroundColor[2]);
      backgroundScene.background = this.backgroundColor;
    }
  }

  private generate(def: EnvironmentDef, hdri: THREE.Texture | null): THREE.WebGLRenderTarget | null {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    try {
      if (hdri) {
        try {
          const rt = pmrem.fromEquirectangular(hdri);
          this.procedural = false;
          return rt;
        } catch (err) {
          log.warn('PMREM from HDRI failed, using procedural environment', err);
        }
      }
      const rt = this.fromProcedural(pmrem, def);
      this.procedural = true;
      return rt;
    } catch (err) {
      log.error('Environment generation failed; keeping previous environment', err);
      return null;
    } finally {
      pmrem.dispose();
    }
  }

  private fromProcedural(pmrem: THREE.PMREMGenerator, def: EnvironmentDef): THREE.WebGLRenderTarget {
    const fb = def.fallback;
    const cfg = ENVIRONMENT;
    const scene = new THREE.Scene();
    const disposables: { dispose(): void }[] = [];

    const domeGeo = new THREE.SphereGeometry(
      cfg.dome.radius,
      cfg.dome.widthSegments,
      cfg.dome.heightSegments,
    );
    const domeMat = new THREE.ShaderMaterial({
      vertexShader: domeVertex,
      fragmentShader: domeFragment,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        skyColor: { value: new THREE.Color(fb.sky[0], fb.sky[1], fb.sky[2]) },
        horizonColor: { value: new THREE.Color(fb.horizon[0], fb.horizon[1], fb.horizon[2]) },
        groundColor: { value: new THREE.Color(fb.ground[0], fb.ground[1], fb.ground[2]) },
        exponents: { value: new THREE.Vector2(cfg.dome.skyExponent, cfg.dome.groundExponent) },
      },
    });
    scene.add(new THREE.Mesh(domeGeo, domeMat));
    disposables.push(domeGeo, domeMat);

    const box = new THREE.BoxGeometry(1, 1, 1);
    disposables.push(box);
    for (const p of cfg.panels) {
      const k = fb.panelIntensity * p.intensity;
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(fb.panel[0] * k, fb.panel[1] * k, fb.panel[2] * k),
        toneMapped: false,
      });
      disposables.push(mat);
      const mesh = new THREE.Mesh(box, mat);
      mesh.position.set(p.position[0], p.position[1], p.position[2]);
      mesh.scale.set(p.scale[0], p.scale[1], p.scale[2]);
      scene.add(mesh);
    }

    try {
      return pmrem.fromScene(scene, cfg.fallbackSigma, cfg.fallbackNear, cfg.fallbackFar);
    } finally {
      for (const d of disposables) d.dispose();
    }
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
  }
}
