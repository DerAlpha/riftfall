/**
 * Draws the additive volumetrics (light cones, skylight shafts, dust – everything on
 * RENDER.volumetricLayer, which the main camera does not see) after AO and height fog. In the world
 * pass N8AO would multiply them by the AO of the wall behind the beam and the fog would dim them by
 * that wall's distance; here they are added on top and fog themselves (fogShared.ts).
 *
 * Depth: which ping-pong buffer still holds the world depth depends on how many passes swapped
 * before this one (AO on/off), so the current buffer's depth is first primed from the composer's
 * stable depth copy; the beams are then depth-tested against the world as usual (no depth write).
 *
 * The world scene is rendered through a separate root object: three keys its light state by the
 * scene passed to render(). Rendering the world scene itself with a light-less layer mask would
 * flip that state twice per frame and push every lit material through program revalidation.
 */
import * as THREE from 'three';
import { Pass } from 'postprocessing';

const primeVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

const primeFragment = /* glsl */ `
uniform highp sampler2D depthBuffer;
varying vec2 vUv;
void main() {
  gl_FragDepth = texture2D(depthBuffer, vUv).r;
}
`;

export class VolumetricPass extends Pass {
  /** View of the world scene (holds it as a child without becoming its parent). */
  private readonly root = new THREE.Scene();
  private readonly primeMaterial: THREE.ShaderMaterial;

  constructor(
    worldScene: THREE.Scene,
    private readonly worldCamera: THREE.Camera,
    private readonly layer: number,
  ) {
    super('Volumetrics');
    this.needsSwap = false;
    this.needsDepthTexture = true;
    this.primeMaterial = new THREE.ShaderMaterial({
      name: 'VolumetricDepthPrime',
      uniforms: { depthBuffer: new THREE.Uniform<THREE.Texture | null>(null) },
      vertexShader: primeVertex,
      fragmentShader: primeFragment,
      // GL only writes depth while the depth test is enabled.
      depthTest: true,
      depthFunc: THREE.AlwaysDepth,
      depthWrite: true,
      colorWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.fullscreenMaterial = this.primeMaterial;
    // The world pass already updated every matrix this frame.
    this.root.matrixWorldAutoUpdate = false;
    this.root.children.push(worldScene);
  }

  private get depthUniform(): THREE.IUniform<THREE.Texture | null> {
    return this.primeMaterial.uniforms.depthBuffer as THREE.IUniform<THREE.Texture | null>;
  }

  override getDepthTexture(): THREE.Texture {
    // The composer compares this with its stable depth texture when it deletes that texture.
    return this.depthUniform.value as THREE.Texture;
  }

  override setDepthTexture(depthTexture: THREE.Texture | null): void {
    this.depthUniform.value = depthTexture;
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget | null): void {
    // Without the world depth the beams would draw through walls: skip rather than mislead.
    if (!this.depthUniform.value) return;
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
    renderer.render(this.scene, this.camera);

    const camera = this.worldCamera;
    const mask = camera.layers.mask;
    camera.layers.set(this.layer);
    try {
      renderer.render(this.root, camera);
    } finally {
      camera.layers.mask = mask;
    }
  }

  override dispose(): void {
    this.root.children.length = 0;
    super.dispose();
  }
}
