/**
 * Renderer, scenes and cameras + frame orchestration (shadows → post chain → stats).
 *
 * World and viewmodel are separate scenes: the viewmodel camera sits at the origin of its own
 * scene and copies the main camera's world rotation every frame, so world-space lighting and
 * environment reflections on the weapon match the world while it can never clip into walls.
 * Tone mapping is a post effect (renderer uses NoToneMapping); the composer works in HalfFloat
 * linear HDR and only the last pass encodes to sRGB.
 */
import * as THREE from 'three';
import type { RenderApi, RenderStats } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { clamp, clamp01, damp, DEG2RAD, RAD2DEG } from '../core/math';
import { CAMERA } from '../defs/camera';
import { ENGINE } from '../defs/engine';
import { ENVIRONMENT, RENDER } from '../defs/graphics';
import type { MapAtmosphereDef } from '../defs/maps';
import { POSTFX } from '../defs/postfx';
import type { AccessibilitySettings, GraphicsSettings } from '../save/settingsSchema';
import { EnvironmentManager } from './Environment';
import { heartbeatPulse } from './postfx/heartbeat';
import { PostFXPipeline, type PostFXFrameState, type PostFXInfo } from './postfx/PostFXPipeline';
import { QualityManager } from './QualityManager';
import { ShadowSystem } from './ShadowSystem';

const log = createLogger('Render');

const _q = new THREE.Quaternion();
const _size = new THREE.Vector2();
const _radiance = new THREE.Color();

/** EXT_disjoint_timer_query_webgl2 (not in lib.dom). */
interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** Non-blocking GPU frame timer: a small ring of queries, results are read a few frames late. */
class GpuTimer {
  private readonly ext: TimerQueryExt | null;
  private readonly queries: (WebGLQuery | null)[];
  private readonly pending: boolean[];
  private next = 0;
  private active = false;
  /** Smoothed GPU frame time in ms, -1 when unsupported / not yet measured. */
  ms = -1;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    size: number,
  ) {
    let ext: TimerQueryExt | null;
    try {
      ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
    } catch {
      ext = null;
    }
    this.ext = ext;
    this.queries = new Array<WebGLQuery | null>(size).fill(null);
    this.pending = new Array<boolean>(size).fill(false);
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  begin(): void {
    const ext = this.ext;
    if (!ext || this.active) return;
    const slot = this.next;
    if (this.pending[slot]) return; // GPU is far behind; skip timing this frame.
    let q = this.queries[slot];
    if (!q) {
      q = this.gl.createQuery();
      this.queries[slot] = q;
    }
    if (!q) return;
    this.gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.active = true;
    this.pending[slot] = true;
    this.next = (slot + 1) % this.queries.length;
  }

  end(): void {
    const ext = this.ext;
    if (!ext) return;
    if (this.active) {
      this.gl.endQuery(ext.TIME_ELAPSED_EXT);
      this.active = false;
    }
    const gl = this.gl;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    for (let i = 0; i < this.queries.length; i++) {
      const q = this.queries[i];
      if (!this.pending[i] || !q) continue;
      if (!(gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean)) continue;
      this.pending[i] = false;
      if (disjoint) continue;
      const ms = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      this.ms = this.ms < 0 ? ms : this.ms + RENDER.gpuTimeEmaAlpha * (ms - this.ms);
    }
  }

  dispose(): void {
    for (const q of this.queries) if (q) this.gl.deleteQuery(q);
    this.queries.fill(null);
  }
}

/** Convert a horizontal FOV to the vertical FOV three.js expects. */
function horizontalToVerticalFov(hFovDeg: number, aspect: number): number {
  return 2 * Math.atan(Math.tan((hFovDeg * DEG2RAD) / 2) / Math.max(aspect, 1e-3)) * RAD2DEG;
}

export class RenderSystem implements RenderApi {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly viewmodelScene = new THREE.Scene();
  readonly viewmodelCamera: THREE.PerspectiveCamera;
  readonly quality: QualityManager;

  private readonly shadows: ShadowSystem;
  private readonly environment: EnvironmentManager;
  private readonly post: PostFXPipeline;
  private readonly hemi: THREE.HemisphereLight;
  private readonly vmSun: THREE.DirectionalLight;
  /** Smoothed 0..1 sun visibility at the eye (see setViewmodelSunVisibility). */
  private vmSunVisibility = 0;
  private readonly vmHemi: THREE.HemisphereLight;
  /** Replaced after a WebGL context restore (its queries belong to the lost context). */
  private gpuTimer: GpuTimer;
  /** Last map atmosphere, re-applied after a WebGL context restore. */
  private lastAtmosphere: MapAtmosphereDef | null = null;
  private contextLost = false;
  private readonly _stats: RenderStats = {
    drawCalls: 0,
    triangles: 0,
    points: 0,
    lines: 0,
    geometries: 0,
    textures: 0,
    programs: 0,
    width: 0,
    height: 0,
    pixelRatio: 1,
    resolutionScale: 1,
    gpuMs: -1,
  };

  /** Reused every frame (no per-frame allocation). */
  private readonly fxState: PostFXFrameState = {
    dt: 0,
    adsAmount: 0,
    focusDistance: POSTFX.depthOfField.defaultFocusDistance,
    caPulse: 0,
    hitFlash: 0,
    lowHealth: 0,
    heartbeat: 0,
  };
  private graphics: GraphicsSettings | null = null;
  private accessibility: AccessibilitySettings;

  // Smoothed per-frame FX state.
  private adsTarget = 0;
  private ads = 0;
  private focusTarget: number = POSTFX.depthOfField.defaultFocusDistance;
  private focus: number = POSTFX.depthOfField.defaultFocusDistance;
  private hitPulse = 0;
  private healthTarget = 1;
  private lowHealth = 0;
  private time = 0;

  // Resize bookkeeping (applied lazily in render(), throttled).
  private resizeDirty = true;
  private lastResizeAt = -Infinity;
  private width = 0;
  private height = 0;
  private appliedScale = -1;
  private appliedPixelRatio = -1;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly unsubscribe: (() => void)[] = [];
  private disposed = false;

  /** WebGL2 probe without creating a renderer (used before booting the game). */
  static isWebGL2Available(): boolean {
    try {
      if (typeof document === 'undefined') return false;
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2');
      if (!gl) return false;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return true;
    } catch {
      return false;
    }
  }

  constructor(
    canvas: HTMLCanvasElement,
    events: EventBus<GameEvents>,
    graphics: Readonly<GraphicsSettings>,
    accessibility: Readonly<AccessibilitySettings>,
  ) {
    this.canvas = canvas;
    this.accessibility = { ...accessibility };

    try {
      // postprocessing renders into its own buffers: no default depth/stencil/MSAA needed.
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        powerPreference: 'high-performance',
        antialias: false,
        stencil: false,
        depth: false,
        alpha: false,
        preserveDrawingBuffer: false,
      });
    } catch (err) {
      log.error('WebGL renderer creation failed', err);
      throw new Error(
        'WebGL2-Kontext konnte nicht erstellt werden. Bitte Hardwarebeschleunigung aktivieren.',
        {
          cause: err,
        },
      );
    }
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.info.autoReset = false;

    const initialSize = this.measure();
    const initialAspect = initialSize.w / initialSize.h;
    this.camera = new THREE.PerspectiveCamera(
      horizontalToVerticalFov(CAMERA.defaultFov, initialAspect),
      initialAspect,
      ENGINE.cameraNear,
      ENGINE.cameraFar,
    );
    this.camera.name = 'MainCamera';

    this.viewmodelCamera = new THREE.PerspectiveCamera(
      CAMERA.viewmodelFov,
      initialAspect,
      ENGINE.viewmodelNear,
      ENGINE.viewmodelFar,
    );
    this.viewmodelCamera.name = 'ViewmodelCamera';
    this.viewmodelCamera.layers.enable(ENGINE.viewmodelLayer);
    this.viewmodelScene.add(this.viewmodelCamera);
    this.scene.name = 'World';
    this.viewmodelScene.name = 'Viewmodel';

    // Colors/intensities of these lights come from the map atmosphere (applyAtmosphere).
    this.hemi = new THREE.HemisphereLight();
    this.hemi.name = 'Hemisphere';
    this.scene.add(this.hemi);

    this.vmSun = new THREE.DirectionalLight();
    this.vmSun.name = 'ViewmodelSun';
    this.vmSun.castShadow = false;
    this.viewmodelScene.add(this.vmSun, this.vmSun.target);
    this.vmHemi = new THREE.HemisphereLight();
    this.vmHemi.name = 'ViewmodelHemisphere';
    this.viewmodelScene.add(this.vmHemi);

    // three r163+ is WebGL2-only, the context is always a WebGL2RenderingContext.
    this.gpuTimer = new GpuTimer(r.getContext() as WebGL2RenderingContext, RENDER.gpuTimerQueries);
    this.quality = new QualityManager(r, events);
    this.shadows = new ShadowSystem(this.scene, this.camera);
    this.environment = new EnvironmentManager(r);
    this.post = new PostFXPipeline(r, this.scene, this.camera, this.viewmodelScene, this.viewmodelCamera);

    this.applyGraphicsSettings(graphics);
    this.applyAccessibility(accessibility);

    // Resize: observe the canvas parent (layout changes) and the window (DPR / zoom changes).
    const parent = canvas.parentElement;
    if (parent && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(parent);
    }
    window.addEventListener('resize', this.onResize);
    // three registered its own listeners in the WebGLRenderer constructor, so on restore its GL
    // state is already rebuilt when ours runs.
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.unsubscribe.push(
      events.on('settings:changed', ({ settings, sections }) => {
        // Graphics are applied by the composition root via applyGraphicsSettings().
        if (sections.includes('accessibility')) this.applyAccessibility(settings.accessibility);
      }),
      events.on('player:teleported', () => this.post.resetMotionHistory()),
      events.on('game:resumed', () => this.post.resetMotionHistory()),
    );

    this.applySize();
    log.info(
      `Renderer ready (GPU: ${this.quality.gpuName}, timer queries: ${this.gpuTimer.supported ? 'yes' : 'no'})`,
    );
  }

  get stats(): Readonly<RenderStats> {
    return this._stats;
  }

  /** Debug info about the post chain / shadows / environment. */
  get composerInfo(): PostFXInfo & { shadowCascades: number; proceduralEnvironment: boolean } {
    return {
      ...this.post.info,
      shadowCascades: this.shadows.cascades,
      proceduralEnvironment: this.environment.procedural,
    };
  }

  // ---------------------------------------------------------------------------
  // RenderApi
  // ---------------------------------------------------------------------------

  setupMaterial(material: THREE.Material): void {
    this.shadows.setupMaterial(material);
  }

  /**
   * 0 = the eye is occluded from the sun, 1 = standing in direct sunlight. The viewmodel scene has
   * no shadows, so the caller probes occlusion (physics ray towards the sun) and we fade the
   * viewmodel's sun copy accordingly – weapons light up when stepping into a skylight shaft.
   */
  setViewmodelSunVisibility(visibility: number, dt: number): void {
    const target = THREE.MathUtils.clamp(visibility, 0, 1);
    this.vmSunVisibility = damp(this.vmSunVisibility, target, RENDER.viewmodelSunLambda, dt);
    this.applyViewmodelSun();
  }

  /** Normalized world direction the sunlight travels (from the sun towards the scene). */
  get sunDirection(): Readonly<THREE.Vector3> {
    return this.shadows.sunDirection;
  }

  private applyViewmodelSun(): void {
    const scale = THREE.MathUtils.lerp(
      RENDER.viewmodelSunShadowedScale,
      RENDER.viewmodelSunScale,
      this.vmSunVisibility,
    );
    this.vmSun.intensity = this.shadows.sunIntensity * scale;
  }

  applyAtmosphere(def: MapAtmosphereDef, hdri: THREE.Texture | null): void {
    this.lastAtmosphere = def;
    this.environment.apply(def.environment, hdri, [this.scene, this.viewmodelScene], this.scene);
    this.shadows.setSun(def.sun);
    this.applyHemisphere(def);

    const sunDir = this.shadows.sunDirection;
    this.vmSun.color.copy(this.shadows.sunColor);
    this.applyViewmodelSun();
    // Viewmodel camera shares the world orientation, so the world light direction applies as-is
    // (a directional light only uses position - target).
    this.vmSun.position.copy(sunDir).negate();
    this.vmSun.target.position.set(0, 0, 0);
    this.vmSun.updateMatrixWorld();
    this.vmSun.target.updateMatrixWorld();

    _radiance.copy(this.shadows.sunColor).multiplyScalar(this.shadows.sunIntensity);
    this.post.setFog(def.fog);
    this.post.setSun(sunDir, _radiance);
    this.post.setGrading(def.grading);

    this.warmup();
  }

  applyGraphicsSettings(g: GraphicsSettings): void {
    const prev = this.graphics;
    this.graphics = { ...g };
    this.quality.configure(g);
    if (
      !prev ||
      prev.renderScale !== g.renderScale ||
      prev.maxPixelRatio !== g.maxPixelRatio ||
      prev.dynamicResolution !== g.dynamicResolution
    ) {
      this.resizeDirty = true;
      this.lastResizeAt = -Infinity;
    }
    this.shadows.setQuality(g.shadows);
    try {
      this.post.applyGraphics(g);
    } catch (err) {
      // A failing optional effect must not take the renderer down; keep the previous chain.
      log.error('Applying post-processing settings failed', err);
    }
  }

  applyAccessibility(a: Readonly<AccessibilitySettings>): void {
    this.accessibility = { ...a };
    this.post.applyAccessibility(this.accessibility);
  }

  setFov(fovDeg: number): void {
    if (!Number.isFinite(fovDeg)) return;
    const fov = clamp(fovDeg, 1, 179);
    if (fov === this.camera.fov) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.shadows.onProjectionChanged();
  }

  setAdsAmount(t: number): void {
    this.adsTarget = clamp01(t);
  }

  setFocusDistance(meters: number): void {
    if (!Number.isFinite(meters)) return;
    this.focusTarget = clamp(meters, this.camera.near, this.camera.far);
  }

  addHitPulse(strength: number): void {
    if (!(strength > 0)) return;
    this.hitPulse = Math.min(1, this.hitPulse + strength);
  }

  /**
   * Screen-space shockwave (explosions): a distortion ring around the world `position` that grows
   * to `radius` meters over POSTFX.shockwave.duration; `strength` scales the displacement.
   */
  addShockwave(position: Vec3Like, radius: number, strength = 1): void {
    if (this.disposed) return;
    this.post.addShockwave(position, radius, strength);
  }

  setHealthFraction(f: number): void {
    if (!Number.isFinite(f)) return;
    this.healthTarget = clamp01(f);
  }

  render(realDt: number): void {
    // While the context is lost nothing reaches the screen and GPU timings would be garbage.
    if (this.disposed || this.contextLost) return;
    const dt = clamp(Number.isFinite(realDt) ? realDt : 0, 0, ENGINE.maxFrameDelta);
    this.time += dt;
    this.maybeResize();

    this.renderer.info.reset();
    this.gpuTimer.begin();
    try {
      this.renderFrame(dt);
    } finally {
      // Always close the timer query, otherwise a single failing frame would stall GPU timing forever.
      this.gpuTimer.end();
    }
    this.quality.reportGpuTime(this.gpuTimer.ms);
    this.updateStats();
  }

  private renderFrame(dt: number): void {
    // Camera matrices must be final before CSM, fog/motion-blur uniforms and the viewmodel copy.
    this.camera.updateWorldMatrix(true, false);
    this.camera.getWorldQuaternion(_q);
    this.viewmodelCamera.position.set(0, 0, 0);
    this.viewmodelCamera.quaternion.copy(_q);
    this.viewmodelCamera.updateMatrixWorld();

    const dof = POSTFX.depthOfField;
    this.ads = damp(this.ads, this.adsTarget, dof.blendLambda, dt);
    if (this.ads < 1e-4 && this.adsTarget === 0) this.ads = 0;
    this.focus = damp(this.focus, this.focusTarget, dof.focusLambda, dt);
    this.hitPulse *= Math.exp(-POSTFX.chromaticAberration.pulseDecay * dt);
    if (this.hitPulse < 1e-3) this.hitPulse = 0;
    const lh = POSTFX.lowHealth;
    const lowTarget = clamp01((lh.threshold - this.healthTarget) / Math.max(lh.threshold, 1e-4));
    this.lowHealth = damp(this.lowHealth, lowTarget, RENDER.lowHealthLambda, dt);

    const reduce = this.accessibility.reduceFlashing;
    const flashScale = reduce ? POSTFX.accessibility.reduceFlashingScale : 1;
    const heartbeat = reduce
      ? POSTFX.accessibility.steadyHeartbeat
      : heartbeatPulse(this.time, lh.pulseFrequency, lh);

    this.shadows.update(dt);
    const fx = this.fxState;
    fx.dt = dt;
    fx.adsAmount = this.ads;
    fx.focusDistance = this.focus;
    fx.caPulse = this.hitPulse * flashScale;
    fx.hitFlash = this.hitPulse * POSTFX.hitFlash.strength * flashScale;
    fx.lowHealth = this.lowHealth;
    fx.heartbeat = heartbeat;
    this.post.render(fx);
  }

  resize(): void {
    this.resizeDirty = true;
    this.lastResizeAt = -Infinity;
    this.maybeResize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.post.dispose();
    this.shadows.dispose();
    this.environment.dispose();
    this.quality.dispose();
    this.gpuTimer.dispose();
    this.vmSun.dispose();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private readonly onResize = (): void => {
    this.resizeDirty = true;
  };

  private readonly onContextLost = (): void => {
    this.contextLost = true;
    log.warn('WebGL context lost');
  };

  /**
   * three rebuilds its own GL state on restore, but two things of ours stay tied to the old context:
   * the PMREM environment (a render-target texture three never re-uploads → black IBL) and the GPU
   * timer (its queries never report again → dynamic resolution would act on a frozen GPU time).
   */
  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    log.warn('WebGL context restored: rebuilding environment and GPU timer');
    // The old timer is abandoned, not disposed: deleting foreign queries only raises GL errors.
    this.gpuTimer = new GpuTimer(
      this.renderer.getContext() as WebGL2RenderingContext,
      RENDER.gpuTimerQueries,
    );
    this.quality.reportGpuTime(-1);
    this.quality.notifyResize(); // drops the stale GPU-time average
    try {
      this.environment.restore();
      if (this.lastAtmosphere) this.applyHemisphere(this.lastAtmosphere);
    } catch (err) {
      log.error('Rebuilding the environment after a context restore failed', err);
    }
    this.warmup();
  };

  /** Hemisphere fill for world + viewmodel; takes over the IBL ambient term when IBL is unavailable. */
  private applyHemisphere(def: MapAtmosphereDef): void {
    const h = def.hemi;
    const intensity = this.environment.texture
      ? h.intensity
      : h.intensity + def.environment.intensity * ENVIRONMENT.noIblHemiScale;
    this.hemi.color.setRGB(h.sky[0], h.sky[1], h.sky[2]);
    this.hemi.groundColor.setRGB(h.ground[0], h.ground[1], h.ground[2]);
    this.hemi.intensity = intensity;
    this.vmHemi.color.copy(this.hemi.color);
    this.vmHemi.groundColor.copy(this.hemi.groundColor);
    this.vmHemi.intensity = intensity * RENDER.viewmodelHemiScale;
  }

  /** Compile every shader of the current scenes + post chain now (loading screen), not mid-game. */
  private warmup(): void {
    try {
      this.resizeDirty = true;
      this.lastResizeAt = -Infinity;
      this.maybeResize();
      this.camera.updateWorldMatrix(true, false);
      this.viewmodelCamera.updateMatrixWorld();
      this.shadows.update(0);
      this.renderer.info.reset();
      this.post.warmup();
    } catch (err) {
      log.warn('Warm-up render failed', err);
    }
  }

  private measure(): { w: number; h: number } {
    const parent = this.canvas.parentElement;
    let w = parent ? parent.clientWidth : 0;
    let h = parent ? parent.clientHeight : 0;
    if (w < 2 || h < 2) {
      w = window.innerWidth;
      h = window.innerHeight;
    }
    return { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) };
  }

  private maybeResize(): void {
    if (this.quality.resolutionScale !== this.appliedScale) this.resizeDirty = true;
    if (!this.resizeDirty) return;
    const now = performance.now();
    if (now - this.lastResizeAt < RENDER.resizeThrottleMs) return;
    this.lastResizeAt = now;
    this.resizeDirty = false;
    this.applySize();
  }

  private applySize(): void {
    const g = this.graphics;
    const { w, h } = this.measure();
    const dpr = Math.min(window.devicePixelRatio || 1, g ? g.maxPixelRatio : 1);
    const scale = this.quality.resolutionScale;
    const pixelRatio = Math.max(0.1, dpr * scale);
    const sizeChanged = w !== this.width || h !== this.height;
    if (!sizeChanged && pixelRatio === this.appliedPixelRatio) {
      this.appliedScale = scale;
      return;
    }

    this.renderer.setPixelRatio(pixelRatio);
    this.post.setSize(w, h);
    this.width = w;
    this.height = h;
    this.appliedScale = scale;
    this.appliedPixelRatio = pixelRatio;

    const aspect = w / h;
    if (aspect !== this.camera.aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
      this.viewmodelCamera.aspect = aspect;
      this.viewmodelCamera.updateProjectionMatrix();
      this.shadows.onProjectionChanged();
    }
    if (sizeChanged) this.quality.notifyResize();
  }

  private updateStats(): void {
    const info = this.renderer.info;
    const s = this._stats;
    s.drawCalls = info.render.calls;
    s.triangles = info.render.triangles;
    s.points = info.render.points;
    s.lines = info.render.lines;
    s.geometries = info.memory.geometries;
    s.textures = info.memory.textures;
    s.programs = info.programs?.length ?? 0;
    this.renderer.getDrawingBufferSize(_size);
    s.width = _size.x;
    s.height = _size.y;
    s.pixelRatio = this.renderer.getPixelRatio();
    s.resolutionScale = this.quality.resolutionScale;
    s.gpuMs = this.gpuTimer.ms;
  }
}
