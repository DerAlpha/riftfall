/**
 * Post-processing chain (pmndrs/postprocessing, HalfFloat HDR buffers, no MSAA):
 *
 *   RenderPass(world)
 *   → N8AO                                          (off: pass absent)
 *   → EffectPass[MotionBlur?, HeightFog]            (world-space; MB is CONVOLUTION|DEPTH → sorted first)
 *   → EffectPass[DepthOfField]                      (own pass: its bokeh reads the pass input, so fog
 *                                                    must already be in it; enabled only while aiming)
 *   → RenderPass(viewmodel, clear depth only)       (never fogged/blurred, never clips into walls)
 *   → EffectPass[CA?, Bloom?, Exposure, ToneMapping, LUT3D]
 *   → EffectPass[SMAA|FXAA, ScreenStatus, Vignette?, Grain?]
 *     (AA off: the AA pass is absent and ScreenStatus/Vignette/Grain close the grade pass)
 *
 * Rules honoured: at most one CONVOLUTION effect per EffectPass (CA, SMAA, motion blur; FXAA
 * samples neighbours too although it is not flagged) and it comes first so it reads the pass input
 * directly; depth consumers run before the viewmodel pass (which clears depth and does not blit it
 * into the stable depth texture).
 * With AA enabled the grade pass keeps the LUT's sRGB-encoded output and AA runs on it: SMAA/FXAA
 * edge thresholds are tuned for perceptual values; on linear values most edges in a dark scene
 * stay below the threshold and remain aliased. The AA effect declares sRGB output, so EffectPass
 * decodes back to linear before the remaining effects and the final output encoding.
 * Disabled features are removed from the pass list (no GPU cost); the structure is rebuilt only
 * when the set of features changes, everything else is updated in place via uniforms.
 */
import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  EdgeDetectionMode,
  type Effect,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  LUT3DEffect,
  NoiseEffect,
  type Pass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { createLogger } from '../../core/log';
import { QUALITY_LEVELS } from '../../defs/graphics';
import type { ColorGradingDef, FogDef } from '../../defs/maps';
import { POSTFX } from '../../defs/postfx';
import type { AccessibilitySettings, GraphicsSettings, QualityLevel } from '../../save/settingsSchema';
import { daltonizationMatrix } from './colorblind';
import { ExposureEffect } from './ExposureEffect';
import { HeightFogEffect } from './HeightFogEffect';
import { createLUTTexture, IDENTITY_GRADING, updateLUTTexture } from './lut';
import { MotionBlurEffect } from './MotionBlurEffect';
import { ScreenStatusEffect } from './ScreenStatusEffect';

const log = createLogger('PostFX');

/** EffectPass that can drop its effects without disposing them (effects survive pass rebuilds). */
class OwnedEffectPass extends EffectPass {
  release(): void {
    this.setEffects([]);
    this.fullscreenMaterial.dispose();
  }
}

/** LUT3DEffect whose sRGB-encoded result can be kept for a following perceptual-space AA pass. */
class GradingLUTEffect extends LUT3DEffect {
  setEncodedOutput(encoded: boolean): void {
    // Declaring the (sRGB-encoded) result as linear stops EffectPass from decoding it at the end
    // of the pass; the AA effect of the next pass declares sRGB output and the decode happens there.
    const cs = encoded ? THREE.LinearSRGBColorSpace : THREE.NoColorSpace;
    if (this.outputColorSpace !== cs) this.outputColorSpace = cs;
  }
}

/** Make an AA effect read the sRGB-encoded grade output as-is and hand sRGB values on. */
function readEncodedInput(effect: SMAAEffect | FXAAEffect): void {
  // postprocessing types these setters as protected; at runtime they are plain accessors that
  // EffectPass reads when inserting color-space conversions (null input = no conversion).
  const io = effect as unknown as {
    inputColorSpace: THREE.ColorSpace | null;
    outputColorSpace: THREE.ColorSpace;
  };
  io.inputColorSpace = null;
  io.outputColorSpace = THREE.SRGBColorSpace;
}

export interface PostFXFrameState {
  /** Real frame delta (s). */
  dt: number;
  /** Smoothed 0..1 ADS blend. */
  adsAmount: number;
  /** Smoothed focus distance (m). */
  focusDistance: number;
  /** 0..1 CA pulse (already scaled for reduceFlashing). */
  caPulse: number;
  /** 0..1 red edge flash (already scaled). */
  hitFlash: number;
  /** 0..1 low-health factor. */
  lowHealth: number;
  /** 0..1 heartbeat pulse value (1 = peak; constant when reduceFlashing). */
  heartbeat: number;
}

export interface PostFXInfo {
  passes: string[];
  frameBufferType: 'half-float' | 'unsigned-byte';
  aoLevel: QualityLevel;
  bloomLevel: QualityLevel;
  fogSteps: number;
  dofActive: boolean;
}

interface Structure {
  ao: boolean;
  motionBlur: boolean;
  dof: boolean;
  bloom: boolean;
  ca: boolean;
  vignette: boolean;
  grain: boolean;
  aa: GraphicsSettings['antialiasing'];
}

const TONE_MAPPING: Record<GraphicsSettings['toneMapping'], ToneMappingMode> = {
  agx: ToneMappingMode.AGX,
  aces: ToneMappingMode.ACES_FILMIC,
  neutral: ToneMappingMode.NEUTRAL,
};

function structureKey(s: Structure): string {
  return `${s.ao}|${s.motionBlur}|${s.dof}|${s.bloom}|${s.ca}|${s.vignette}|${s.grain}|${s.aa}`;
}

/** n8ao keeps its fullscreen quads outside Pass.dispose()'s reach; free their materials too. */
function disposeN8AO(pass: N8AOPostPass): void {
  pass.dispose();
  for (const value of Object.values(pass as object)) {
    if (value && typeof value === 'object' && 'material' in value) {
      const mat = (value as { material: unknown }).material;
      if (mat instanceof THREE.Material) mat.dispose();
    }
  }
}

export class PostFXPipeline {
  readonly composer: EffectComposer;
  private readonly frameBufferType: THREE.TextureDataType;

  // Persistent passes / effects (created once).
  private readonly worldPass: RenderPass;
  private readonly viewmodelPass: RenderPass;
  private readonly fog: HeightFogEffect;
  private readonly exposure: ExposureEffect;
  private readonly toneMapping: ToneMappingEffect;
  private readonly lut: GradingLUTEffect;
  private readonly lutTexture: THREE.Data3DTexture;
  private readonly status: ScreenStatusEffect;

  // Optional (created on demand, disposed when the feature is switched off).
  private ao: N8AOPostPass | null = null;
  private motionBlur: MotionBlurEffect | null = null;
  private dof: DepthOfFieldEffect | null = null;
  private bloom: BloomEffect | null = null;
  private ca: ChromaticAberrationEffect | null = null;
  private vignette: VignetteEffect | null = null;
  private grain: NoiseEffect | null = null;
  private aaEffect: SMAAEffect | FXAAEffect | null = null;
  private aaMode: GraphicsSettings['antialiasing'] = 'off';

  // Current effect passes (rebuilt on structure changes).
  private effectPasses: OwnedEffectPass[] = [];
  private dofPass: OwnedEffectPass | null = null;

  private structure: string | null = null;
  private aoLevel: QualityLevel = 'off';
  private bloomLevel: QualityLevel = 'off';
  private fogSteps = 0;
  private baseExposure = 1;
  private userExposure = 1;
  private readonly caOffset = new THREE.Vector2();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly worldScene: THREE.Scene,
    private readonly worldCamera: THREE.PerspectiveCamera,
    viewmodelScene: THREE.Scene,
    viewmodelCamera: THREE.PerspectiveCamera,
  ) {
    const ext = renderer.extensions;
    const halfFloat = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    if (!halfFloat)
      log.warn('No float color buffer support – falling back to 8-bit post buffers (reduced HDR/bloom).');
    this.frameBufferType = halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.composer = new EffectComposer(renderer, {
      frameBufferType: this.frameBufferType,
      multisampling: 0,
      stencilBuffer: false,
      depthBuffer: true,
    });

    this.worldPass = new RenderPass(worldScene, worldCamera);

    this.viewmodelPass = new RenderPass(viewmodelScene, viewmodelCamera);
    this.viewmodelPass.clearPass.color = false;
    this.viewmodelPass.clearPass.depth = true;
    this.viewmodelPass.ignoreBackground = true;
    this.viewmodelPass.skipShadowMapUpdate = true;
    // Keep the world depth in the composer's stable depth texture (nothing after this reads depth anyway).
    this.viewmodelPass.needsDepthBlit = false;

    this.fog = new HeightFogEffect(worldCamera, 0);
    this.exposure = new ExposureEffect(1);
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
    this.lutTexture = createLUTTexture(IDENTITY_GRADING);
    this.lut = new GradingLUTEffect(this.lutTexture);
    const lh = POSTFX.lowHealth;
    this.status = new ScreenStatusEffect(lh.tint, lh.edgeInner, lh.edgeOuter);
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  applyGraphics(g: GraphicsSettings): void {
    const aoParams = QUALITY_LEVELS.ambientOcclusion[g.ambientOcclusion];
    const bloomParams = QUALITY_LEVELS.bloom[g.bloom];
    const structure: Structure = {
      ao: aoParams !== null,
      motionBlur: g.motionBlur,
      dof: g.depthOfField,
      bloom: bloomParams !== null,
      ca: g.chromaticAberration,
      vignette: g.vignette,
      grain: g.filmGrain,
      aa: g.antialiasing,
    };

    this.syncOptionalEffects(structure, g);

    // In-place parameter updates (no pass rebuild).
    if (this.ao && aoParams && this.aoLevel !== g.ambientOcclusion) this.configureAO(this.ao, aoParams);
    this.aoLevel = g.ambientOcclusion;
    if (this.bloom && bloomParams && this.bloomLevel !== g.bloom) {
      this.bloom.mipmapBlurPass.levels = bloomParams.levels;
      this.bloom.luminancePass.resolution.scale = bloomParams.resolutionScale;
    }
    this.bloomLevel = g.bloom;

    const vol = QUALITY_LEVELS.volumetrics[g.volumetrics];
    this.fogSteps = vol ? vol.fogSteps : 0;
    this.fog.setSteps(this.fogSteps);

    const tm = TONE_MAPPING[g.toneMapping] ?? ToneMappingMode.AGX;
    if (this.toneMapping.mode !== tm) this.toneMapping.mode = tm;

    this.userExposure = g.exposure;
    this.updateExposure();

    const key = structureKey(structure);
    if (key !== this.structure) {
      this.structure = key;
      this.rebuildPasses();
    }
  }

  applyAccessibility(a: AccessibilitySettings): void {
    this.status.setColorMatrix(
      daltonizationMatrix(a.colorblindMode, POSTFX.accessibility.colorblindStrength),
    );
  }

  setFog(def: FogDef): void {
    this.fog.setFog(def);
  }

  setSun(travelDir: THREE.Vector3, radiance: THREE.Color): void {
    this.fog.setSun(travelDir, radiance);
  }

  /** Grading LUT is regenerated in place (same size => no recompile). Exposure goes pre-tonemap. */
  setGrading(def: ColorGradingDef): void {
    updateLUTTexture(this.lutTexture, { ...def, exposure: 1 });
    this.baseExposure = def.exposure;
    this.updateExposure();
  }

  resetMotionHistory(): void {
    this.motionBlur?.resetHistory();
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }

  get info(): PostFXInfo {
    return {
      passes: this.composer.passes.map((p) => (p.enabled ? p.name : `(${p.name})`)),
      frameBufferType: this.frameBufferType === THREE.HalfFloatType ? 'half-float' : 'unsigned-byte',
      aoLevel: this.aoLevel,
      bloomLevel: this.bloomLevel,
      fogSteps: this.fogSteps,
      dofActive: this.dofPass?.enabled ?? false,
    };
  }

  // ---------------------------------------------------------------------------
  // Per frame
  // ---------------------------------------------------------------------------

  render(s: PostFXFrameState): void {
    if (this.motionBlur) this.motionBlur.setFrameDelta(s.dt);

    if (this.dof && this.dofPass) {
      const active = s.adsAmount > POSTFX.depthOfField.minAmount;
      this.dofPass.enabled = active;
      if (active) {
        this.dof.blendMode.opacity.value = s.adsAmount;
        this.dof.cocMaterial.focusDistance = s.focusDistance;
      }
    }

    if (this.ca) {
      const c = POSTFX.chromaticAberration;
      const amount = c.baseOffset + c.hitOffset * s.caPulse;
      this.caOffset.set(amount, amount);
    }
    if (this.vignette) {
      this.vignette.darkness = POSTFX.vignette.darkness + POSTFX.vignette.lowHealthDarkness * s.lowHealth;
    }

    const lh = POSTFX.lowHealth;
    const pulse = lh.pulseMin + (1 - lh.pulseMin) * s.heartbeat;
    this.status.setState(
      s.lowHealth,
      s.lowHealth * lh.tintStrength * pulse,
      s.lowHealth * lh.desaturation,
      s.hitFlash,
    );

    this.composer.render(s.dt);
  }

  /** Render one frame with every optional pass enabled so all post shaders compile up front. */
  warmup(): void {
    const dofWasEnabled = this.dofPass?.enabled ?? false;
    if (this.dofPass) this.dofPass.enabled = true;
    try {
      this.composer.render(0);
    } finally {
      if (this.dofPass) this.dofPass.enabled = dofWasEnabled;
    }
  }

  dispose(): void {
    this.composer.removeAllPasses();
    for (const p of this.effectPasses) p.release();
    this.effectPasses = [];
    this.dofPass = null;
    const effects: (Effect | null)[] = [
      this.fog,
      this.exposure,
      this.toneMapping,
      this.lut,
      this.status,
      this.motionBlur,
      this.dof,
      this.bloom,
      this.ca,
      this.vignette,
      this.grain,
      this.aaEffect,
    ];
    for (const e of effects) e?.dispose();
    this.lutTexture.dispose();
    if (this.ao) disposeN8AO(this.ao);
    this.ao = null;
    this.worldPass.dispose();
    this.viewmodelPass.dispose();
    this.composer.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private updateExposure(): void {
    this.exposure.exposure = POSTFX.toneMapping.exposure * this.userExposure * this.baseExposure;
  }

  private configureAO(
    pass: N8AOPostPass,
    p: NonNullable<(typeof QUALITY_LEVELS.ambientOcclusion)[QualityLevel]>,
  ): void {
    const cfg = pass.configuration;
    pass.setQualityMode(p.mode);
    // The configuration is a Proxy that recompiles on every assignment – only assign changes.
    if (cfg.halfRes !== p.halfRes) cfg.halfRes = p.halfRes;
    if (cfg.aoRadius !== p.radius) cfg.aoRadius = p.radius;
    if (cfg.intensity !== p.intensity) cfg.intensity = p.intensity;
    if (cfg.distanceFalloff !== p.distanceFalloff) cfg.distanceFalloff = p.distanceFalloff;
  }

  private createAO(): N8AOPostPass {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const pass = new N8AOPostPass(this.worldScene, this.worldCamera, size.x, size.y);
    // Transparency awareness re-renders the scene twice per frame; we accept AO under transparent FX.
    pass.autoDetectTransparency = false;
    const cfg = pass.configuration;
    if (cfg.transparencyAware) cfg.transparencyAware = false;
    cfg.gammaCorrection = false; // we stay linear HDR until the final pass
    if (cfg.screenSpaceRadius) cfg.screenSpaceRadius = false;
    if (!cfg.depthAwareUpsampling) cfg.depthAwareUpsampling = true;
    if (cfg.accumulate) cfg.accumulate = false;
    cfg.color.setRGB(0, 0, 0);
    pass.name = 'N8AO';
    return pass;
  }

  private syncOptionalEffects(s: Structure, g: GraphicsSettings): void {
    // Ambient occlusion
    if (s.ao && !this.ao) {
      this.ao = this.createAO();
      this.aoLevel = 'off'; // force configureAO below
    } else if (!s.ao && this.ao) {
      this.composer.removePass(this.ao);
      disposeN8AO(this.ao);
      this.ao = null;
    }

    if (s.motionBlur && !this.motionBlur) this.motionBlur = new MotionBlurEffect(this.worldCamera);
    else if (!s.motionBlur && this.motionBlur) this.motionBlur = this.drop(this.motionBlur);

    if (s.dof && !this.dof) {
      const d = POSTFX.depthOfField;
      this.dof = new DepthOfFieldEffect(this.worldCamera, {
        blendFunction: BlendFunction.NORMAL,
        focusDistance: d.defaultFocusDistance,
        focusRange: d.focusRange,
        bokehScale: d.bokehScale,
        resolutionScale: d.resolutionScale,
      });
    } else if (!s.dof && this.dof) this.dof = this.drop(this.dof);

    if (s.bloom && !this.bloom) {
      const b = POSTFX.bloom;
      const levels = QUALITY_LEVELS.bloom[g.bloom]?.levels;
      this.bloom = new BloomEffect({
        // Created with the right mip count (changing it later rebuilds the mip chain).
        ...(levels !== undefined ? { levels } : {}),
        // ADD, not the default SCREEN: screen blending is wrong for HDR values above 1.
        blendFunction: BlendFunction.ADD,
        mipmapBlur: true,
        luminanceThreshold: b.luminanceThreshold,
        luminanceSmoothing: b.luminanceSmoothing,
        intensity: b.intensity,
        radius: b.radius,
      });
      this.bloomLevel = 'off'; // force level/scale update
    } else if (!s.bloom && this.bloom) this.bloom = this.drop(this.bloom);

    if (s.ca && !this.ca) {
      const c = POSTFX.chromaticAberration;
      this.caOffset.set(c.baseOffset, c.baseOffset);
      this.ca = new ChromaticAberrationEffect({
        offset: this.caOffset,
        radialModulation: c.radialModulation,
        modulationOffset: c.modulationOffset,
      });
    } else if (!s.ca && this.ca) this.ca = this.drop(this.ca);

    if (s.vignette && !this.vignette) {
      this.vignette = new VignetteEffect({
        offset: POSTFX.vignette.offset,
        darkness: POSTFX.vignette.darkness,
      });
    } else if (!s.vignette && this.vignette) this.vignette = this.drop(this.vignette);

    if (s.grain && !this.grain) {
      // Overlay with uniform noise is mean-neutral and strongest in midtones (film-like), unlike
      // premultiplied SCREEN/ADD which brightens the image.
      this.grain = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
      this.grain.blendMode.opacity.value = POSTFX.filmGrain.opacity;
    } else if (!s.grain && this.grain) this.grain = this.drop(this.grain);

    if (s.aa !== this.aaMode) {
      if (this.aaEffect) this.aaEffect = this.drop(this.aaEffect);
      if (s.aa === 'smaa') {
        const smaa = new SMAAEffect({
          preset: SMAAPreset[POSTFX.smaaPreset],
          edgeDetectionMode: EdgeDetectionMode.COLOR,
        });
        readEncodedInput(smaa);
        this.aaEffect = smaa;
      } else if (s.aa === 'fxaa') {
        const fxaa = new FXAAEffect();
        readEncodedInput(fxaa);
        this.aaEffect = fxaa;
      }
      this.aaMode = s.aa;
    }
  }

  private drop(effect: Effect): null {
    effect.dispose();
    return null;
  }

  private rebuildPasses(): void {
    const composer = this.composer;
    composer.removeAllPasses();
    for (const p of this.effectPasses) p.release();
    this.effectPasses = [];
    this.dofPass = null;

    const cam = this.worldCamera;
    const add = (pass: Pass): void => composer.addPass(pass);
    const effectPass = (name: string, effects: Effect[]): OwnedEffectPass => {
      const pass = new OwnedEffectPass(cam, ...effects);
      pass.name = name;
      this.effectPasses.push(pass);
      add(pass);
      return pass;
    };

    add(this.worldPass);
    if (this.ao) add(this.ao);

    const worldEffects: Effect[] = [];
    if (this.motionBlur) worldEffects.push(this.motionBlur);
    worldEffects.push(this.fog);
    effectPass('WorldFX', worldEffects);

    if (this.dof) {
      this.dofPass = effectPass('DepthOfField', [this.dof]);
      this.dofPass.enabled = false;
    }

    add(this.viewmodelPass);

    const aa = this.aaEffect;
    // With AA the LUT output stays sRGB-encoded for the AA pass (see the header comment).
    this.lut.setEncodedOutput(aa !== null);
    const grade: Effect[] = [];
    if (this.ca) grade.push(this.ca);
    if (this.bloom) grade.push(this.bloom);
    grade.push(this.exposure, this.toneMapping, this.lut);
    // Player-state treatment, vignette and grain always come last (after AA when enabled).
    const screen: Effect[] = aa ? [aa] : grade;
    screen.push(this.status);
    if (this.vignette) screen.push(this.vignette);
    if (this.grain) screen.push(this.grain);
    let last = effectPass('Grade', grade);
    if (aa) last = effectPass('AA', screen);
    // Dither the final 8-bit output: dark fog gradients band without it (grain may be off).
    last.dithering = true;

    this.motionBlur?.resetHistory();
    log.debug(`Post chain: ${composer.passes.map((p) => p.name).join(' → ')}`);
  }
}
