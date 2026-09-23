/**
 * Ambient typings for n8ao 2.x (the package ships no .d.ts). Derived from
 * node_modules/n8ao/src/N8AOPostPass.js – only the surface we rely on plus the documented
 * configuration fields. N8AOPostPass extends pmndrs/postprocessing's Pass.
 */
declare module 'n8ao' {
  import type { Pass } from 'postprocessing';
  import type { Camera, Color, Scene, Texture } from 'three';

  export type N8AOQualityMode =
    'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra' | 'Neural-Low' | 'Neural-Medium' | 'Neural-High';

  export type N8AODisplayMode = 'Combined' | 'AO' | 'No AO' | 'Split' | 'Split AO';

  export const DepthType: { readonly Default: 1; readonly Log: 2; readonly Reverse: 3 };

  /**
   * Live configuration (a Proxy: assigning a field reconfigures/recompiles the affected
   * internal passes, so only assign when a value actually changes).
   */
  export interface N8AOConfiguration {
    aoSamples: number;
    /** World-space radius (or pixels when screenSpaceRadius is true). */
    aoRadius: number;
    aoTones: number;
    denoiseSamples: number;
    denoiseRadius: number;
    denoiseIterations: number;
    distanceFalloff: number;
    intensity: number;
    /** 0 Combined, 1 AO, 2 No AO, 3 Split, 4 Split AO. */
    renderMode: 0 | 1 | 2 | 3 | 4;
    biasOffset: number;
    biasMultiplier: number;
    /** AO tint (sRGB). */
    color: Color;
    /** Apply sRGB encoding to the output. Setting it disables auto-detection (renderToScreen). */
    gammaCorrection: boolean;
    depthBufferType: 1 | 2 | 3;
    screenSpaceRadius: boolean;
    halfRes: boolean;
    depthAwareUpsampling: boolean;
    colorMultiply: boolean;
    /** Renders the scene twice more to handle transparent objects – expensive. */
    transparencyAware: boolean;
    /** Temporal accumulation while the camera is still. */
    accumulate: boolean;
    neuralDenoise: boolean;
  }

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: N8AOConfiguration;
    /** When true, gammaCorrection follows renderToScreen. */
    autosetGamma: boolean;
    /** When true, the scene is traversed every frame and transparencyAware is switched on if any material is transparent. */
    autoDetectTransparency: boolean;
    /** Rolling GPU time in ms (only updated in debug mode). */
    lastTime: number;
    width: number;
    height: number;
    setQualityMode(mode: N8AOQualityMode): void;
    setDisplayMode(mode: N8AODisplayMode): void;
    override setSize(width: number, height: number): void;
    override setDepthTexture(depthTexture: Texture): void;
    enableDebugMode(): void;
    disableDebugMode(): void;
    /** Resets temporal accumulation. */
    firstFrame(): void;
  }
}
