/**
 * Composition root: constructs every system, wires events and owns the game loop.
 * Systems only know each other through the contracts in src/core/contracts.ts.
 */
import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents, PauseReason } from '../core/events';
import { GameLoop } from '../core/GameLoop';
import { createLogger } from '../core/log';
import type { LevelInstance, SaveData } from '../core/contracts';
import { ENGINE } from '../defs/engine';
import { GRAPHICS_PRESETS } from '../defs/graphics';
import { SaveSystem } from '../save/SaveSystem';
import { SettingsStore } from '../save/SettingsStore';
import type { QualityPreset, Settings } from '../save/settingsSchema';
import { RenderSystem } from '../render/RenderSystem';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { AssetLoader } from '../assets/AssetLoader';
import { AudioEngine } from '../audio/AudioEngine';
import { AudioEventBridge } from '../audio/AudioEventBridge';
import { InputSystem } from '../input/InputSystem';
import { MaterialLibrary } from '../render/materials/MaterialLibrary';
import { buildTestRoom } from '../world/TestRoom';
import { PlayerController } from '../player/PlayerController';
import { PlayerCamera } from '../player/PlayerCamera';
import { ViewmodelRig } from '../player/ViewmodelRig';
import { PlayerHealth } from '../player/PlayerHealth';
import { Hud } from '../ui/hud/Hud';
import { DebugOverlay, type DebugSnapshot } from '../ui/debug/DebugOverlay';
import { DevConsole } from '../ui/console/DevConsole';
import { LoadingScreen } from '../ui/LoadingScreen';
import { mountMenus, type MenuController } from '../ui/menus';
import { registerDevCommands } from './devCommands';

const log = createLogger('Game');

export interface GameOptions {
  /** Skip the start screen (automated tests). */
  autostart: boolean;
  /** Do not require pointer lock to play (automated tests / environments without lock). */
  noPointerLock: boolean;
  /** Expose a debug handle on window (smoke tests). */
  exposeHandle: boolean;
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in index.html`);
  return node;
}

export class Game {
  readonly events = new EventBus<GameEvents>();
  readonly loop: GameLoop;

  private started = false;
  private pausedFor = new Set<PauseReason>();
  private time = 0;
  private readonly _yawDir = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);

  private constructor(
    readonly opts: GameOptions,
    readonly save: SaveSystem,
    private saveData: SaveData,
    readonly settings: SettingsStore,
    readonly render: RenderSystem,
    readonly physics: PhysicsWorld,
    readonly assets: AssetLoader,
    readonly audio: AudioEngine,
    readonly audioBridge: AudioEventBridge,
    readonly input: InputSystem,
    readonly materials: MaterialLibrary,
    readonly level: LevelInstance,
    readonly player: PlayerController,
    readonly playerCamera: PlayerCamera,
    readonly viewmodel: ViewmodelRig,
    readonly health: PlayerHealth,
    readonly hud: Hud,
    readonly debug: DebugOverlay,
    readonly devConsole: DevConsole,
    readonly menus: MenuController,
    events: EventBus<GameEvents>,
  ) {
    this.events = events;
    this.loop = new GameLoop(
      {
        beginFrame: (dt) => this.beginFrame(dt),
        fixedUpdate: (dt) => this.fixedUpdate(dt),
        update: (dt, alpha) => this.update(dt, alpha),
        render: (dt, alpha) => this.renderFrame(dt, alpha),
      },
      { tickRate: ENGINE.tickRate, maxSubSteps: ENGINE.maxSubSteps, maxFrameDelta: ENGINE.maxFrameDelta },
    );
    this.loop.fpsLimit = settings.current.graphics.fpsLimit;
  }

  /** Boot everything with a visible loading screen. Throws only for truly fatal problems (no WebGL2). */
  static async create(opts: GameOptions): Promise<Game> {
    const events = new EventBus<GameEvents>();
    const loading = new LoadingScreen(el('loading'));
    loading.show();
    const progress = (fraction: number, label: string): void => {
      loading.setProgress(fraction, label);
      events.emit('loading:progress', { loaded: fraction, total: 1, label });
    };
    // Let the loading screen paint before heavy work starts.
    await nextFrame();

    progress(0.02, 'Lade Profil…');
    const save = await SaveSystem.create();
    const saveData = await save.load();
    let saveTimer = 0;
    const persist = (s: Settings): void => {
      saveData.settings = s;
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void save.save(saveData), 0);
    };
    const settings = new SettingsStore(events, saveData.settings, persist);

    progress(0.08, 'Initialisiere Renderer…');
    const canvas = el('game-canvas') as HTMLCanvasElement;
    const render = new RenderSystem(canvas, events, settings.current.graphics, settings.current.accessibility);

    if (!saveData.profile.qualityAutoDetected) {
      const preset = render.quality.detectPreset();
      log.info(`Auto-detected graphics preset "${preset}" for GPU: ${render.quality.gpuName}`);
      settings.update('graphics', { preset, ...GRAPHICS_PRESETS[preset] });
      saveData.profile.qualityAutoDetected = true;
    }
    render.applyGraphicsSettings(settings.current.graphics);

    progress(0.15, 'Initialisiere Physik…');
    const physics = await PhysicsWorld.create();

    const audio = new AudioEngine(events, settings.current.audio);
    const assets = new AssetLoader(render.renderer, () => audio.context ?? null);
    const audioBridge = new AudioEventBridge(events, audio);
    const input = new InputSystem(canvas, events, settings);

    progress(0.2, 'Lade Assets…');
    const { TEST_ROOM } = await import('../defs/maps');
    await assets.preload(TEST_ROOM.preload, (loaded, total, label) =>
      progress(0.2 + 0.25 * (total > 0 ? loaded / total : 1), `Lade ${label}…`),
    );

    progress(0.45, 'Generiere Materialien…');
    const materials = new MaterialLibrary(render, assets, settings);
    const level = await buildTestRoom({
      render,
      physics,
      assets,
      materials,
      settings,
      events,
      onProgress: (label, fraction) => progress(0.45 + 0.45 * fraction, label),
    });
    render.scene.add(level.root);

    progress(0.92, 'Kalibriere Umgebung…');
    const hdri = level.atmosphere.environment.hdri ? await assets.loadHDRI(level.atmosphere.environment.hdri) : null;
    render.applyAtmosphere(level.atmosphere, hdri);
    audio.setReverbZone(level.atmosphere.reverb);

    const player = new PlayerController({ physics, input, events, settings }, level.spawn, {
      // The calibration hall is a movement sandbox: all movement abilities unlocked.
      unlocks: { doubleJump: true, dash: true },
    });
    const playerCamera = new PlayerCamera({ player, input, render, events, settings });
    const viewmodel = new ViewmodelRig({ render, player, camera: playerCamera, events });
    const health = new PlayerHealth(events);

    const hud = new Hud(el('hud'), events, settings);
    const debug = new DebugOverlay(el('debug'), events);
    const devConsole = new DevConsole(el('console'), events);

    let gameRef: Game | null = null;
    const menus = mountMenus(el('ui'), {
      settings,
      input,
      events,
      onStart: () => gameRef?.startPlaying(),
      onResume: () => gameRef?.resumeFromMenu(),
      getInfo: () => ({ gpuName: render.quality.gpuName, saveBackend: save.backendName, version: __APP_VERSION__ }),
    });

    const game = new Game(
      opts,
      save,
      saveData,
      settings,
      render,
      physics,
      assets,
      audio,
      audioBridge,
      input,
      materials,
      level,
      player,
      playerCamera,
      viewmodel,
      health,
      hud,
      debug,
      devConsole,
      menus,
      events,
    );
    gameRef = game;
    registerDevCommands(game);
    game.wireEvents();

    // Warm up shaders so the first real frame does not hitch.
    render.renderer.compile(render.scene, render.camera);
    render.renderer.compile(render.viewmodelScene, render.viewmodelCamera);

    progress(1, 'Bereit');
    loading.hide();
    events.emit('loading:done', {});
    game.loop.start();
    events.emit('game:ready', {});

    if (opts.autostart) game.startPlaying();
    else {
      game.pause('menu');
      menus.showStart();
    }
    return game;
  }

  // -------------------------------------------------------------------------
  // Loop phases
  // -------------------------------------------------------------------------

  private beginFrame(realDt: number): void {
    this.input.beginFrame(realDt);
    if (this.input.pressed('pause') && this.started && this.pausedFor.size === 0) this.openPauseMenu();
  }

  private fixedUpdate(dt: number): void {
    // The player computes its kinematic move against the current world, then the world steps
    // (dynamic props react to the pushes), so everything ends the tick in a consistent state.
    this.player.fixedUpdate(dt);
    this.physics.step(dt);
    this.health.fixedUpdate(dt);
    this.level.fixedUpdate?.(dt);
  }

  private update(dt: number, alpha: number): void {
    this.time += dt;
    this.player.update(dt, alpha);
    this.playerCamera.update(dt);
    this.viewmodel.update(dt);
    this.level.update(dt, this.time);

    const cam = this.render.camera;
    cam.getWorldDirection(this._yawDir);
    this.audio.setListener(cam.position, this._yawDir, this._up);

    this.render.setAdsAmount(this.player.adsAmount);
    this.hud.setDash(this.player.dashCharges, this.player.unlocks.dash ? 2 : 0, this.player.dashRecharge);
    this.hud.update(dt, this.player.yaw);
  }

  private renderFrame(realDt: number, alpha: number): void {
    this.physics.syncVisuals(alpha);
    this.render.render(realDt);
    this.render.quality.onFrame(realDt);
    if (this.debug.visible) this.debug.update(realDt, () => this.debugSnapshot(realDt));
    this.input.endFrame();
  }

  // -------------------------------------------------------------------------
  // Pause / pointer lock flow
  // -------------------------------------------------------------------------

  private wireEvents(): void {
    this.events.on('input:pointerLock', ({ locked }) => {
      if (locked) {
        if (this.pausedFor.has('pointerlock') || this.pausedFor.has('menu')) {
          this.unpause('pointerlock');
          this.unpause('menu');
          this.menus.hide();
        }
      } else if (this.started && !this.opts.noPointerLock && !this.devConsole.open) {
        this.openPauseMenu('pointerlock');
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.started) this.openPauseMenu('visibility');
      } else {
        this.unpause('visibility');
      }
    });

    this.events.on('ui:console', ({ open }) => {
      this.input.enabled = !open && this.pausedFor.size === 0;
    });

    this.events.on('settings:changed', ({ settings, sections }) => {
      if (sections.includes('graphics')) {
        this.render.applyGraphicsSettings(settings.graphics);
        this.loop.fpsLimit = settings.graphics.fpsLimit;
      }
      if (sections.includes('audio')) this.audio.applySettings(settings.audio);
    });

    this.events.on('player:healthChanged', ({ health, maxHealth }) => {
      this.render.setHealthFraction(maxHealth > 0 ? health / maxHealth : 1);
    });
    this.events.on('player:damaged', ({ amount }) => {
      this.render.addHitPulse(Math.min(1, amount / 40));
    });
    this.events.on('fx:hitPulse', ({ strength }) => this.render.addHitPulse(strength));

    window.addEventListener('beforeunload', () => {
      this.settings.flush?.();
      void this.save.save(this.saveData);
    });
  }

  /** Called from the start screen click (a user gesture: pointer lock + audio unlock are allowed). */
  startPlaying(): void {
    void this.audio.unlock();
    this.started = true;
    this.saveData.profile.lastPlayedAt = Date.now();
    void this.save.save(this.saveData);
    if (this.opts.noPointerLock) {
      this.unpause('menu');
      this.menus.hide();
    } else {
      this.input.requestPointerLock();
    }
    void this.maybeRunBenchmark();
  }

  resumeFromMenu(): void {
    void this.audio.unlock();
    if (this.opts.noPointerLock) {
      this.pausedFor.clear();
      this.applyPauseState();
      this.menus.hide();
    } else {
      this.input.requestPointerLock();
    }
  }

  private openPauseMenu(reason: PauseReason = 'menu'): void {
    this.pause(reason);
    this.pause('menu');
    if (!this.opts.noPointerLock) this.input.exitPointerLock();
    this.menus.showPause();
  }

  pause(reason: PauseReason): void {
    this.pausedFor.add(reason);
    this.applyPauseState();
  }

  unpause(reason: PauseReason): void {
    this.pausedFor.delete(reason);
    this.applyPauseState();
  }

  private applyPauseState(): void {
    const paused = this.pausedFor.size > 0;
    if (paused === this.loop.paused) return;
    this.loop.paused = paused;
    this.input.enabled = !paused && !this.devConsole.open;
    this.audio.setPaused(paused);
    if (!paused) this.loop.resetAccumulator();
    this.events.emit(paused ? 'game:paused' : 'game:resumed', paused ? { reason: [...this.pausedFor][0] ?? 'menu' } : {});
  }

  /** First-run benchmark: may downgrade the auto-detected preset once. */
  private async maybeRunBenchmark(): Promise<void> {
    if (this.saveData.profile.qualityBenchmarked) return;
    const current = this.settings.current.graphics.preset;
    if (current === 'custom') return;
    const recommended: QualityPreset | null = await this.render.quality.runBenchmark(current);
    this.saveData.profile.qualityBenchmarked = true;
    if (recommended && recommended !== current) {
      log.info(`Benchmark: switching graphics preset ${current} → ${recommended}`);
      this.settings.update('graphics', { preset: recommended, ...GRAPHICS_PRESETS[recommended] });
      this.events.emit('quality:presetApplied', { preset: recommended, auto: true });
    }
    void this.save.save(this.saveData);
  }

  // -------------------------------------------------------------------------
  // Debug
  // -------------------------------------------------------------------------

  private debugSnapshot(realDt: number): DebugSnapshot {
    const r = this.render.stats;
    const p = this.player;
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return {
      fps: realDt > 0 ? 1 / realDt : 0,
      frameMs: realDt * 1000,
      ticksPerFrame: this.loop.stats.ticksLastFrame,
      droppedTicks: this.loop.stats.droppedTicks,
      drawCalls: r.drawCalls,
      triangles: r.triangles,
      points: r.points,
      lines: r.lines,
      geometries: r.geometries,
      textures: r.textures,
      programs: r.programs,
      width: r.width,
      height: r.height,
      pixelRatio: r.pixelRatio,
      resolutionScale: r.resolutionScale,
      gpuMs: r.gpuMs,
      gpuName: this.render.quality.gpuName,
      preset: this.settings.current.graphics.preset,
      entities: {
        bodies: this.physics.stats.bodies,
        colliders: this.physics.stats.colliders,
        dynamicBodies: this.physics.stats.dynamicBodies,
        meshes: this.level.stats.meshes,
        lights: this.level.stats.lights,
      },
      physicsMs: this.physics.stats.stepMs,
      memoryMb: mem ? mem.usedJSHeapSize / (1024 * 1024) : -1,
      audioVoices: this.audio.stats.activeVoices,
      audioState: this.audio.stats.contextState,
      player: {
        state: p.state,
        speed: Math.hypot(p.velocity.x, p.velocity.z),
        position: [p.position.x, p.position.y, p.position.z],
        velocity: [p.velocity.x, p.velocity.y, p.velocity.z],
        grounded: p.grounded,
        crouched: p.crouched,
      },
      missingAssets: [...this.assets.missing],
    };
  }

  /** Handle for automated smoke tests (window.__RIFTFALL__). */
  createDebugHandle(): Record<string, unknown> {
    return {
      ready: true,
      game: this,
      snapshot: () => {
        const p = this.player;
        return {
          position: [p.position.x, p.position.y, p.position.z],
          velocity: [p.velocity.x, p.velocity.y, p.velocity.z],
          state: p.state,
          grounded: p.grounded,
          fps: this.loop.stats.frameDelta > 0 ? 1 / this.loop.stats.frameDelta : 0,
          drawCalls: this.render.stats.drawCalls,
          triangles: this.render.stats.triangles,
          resolutionScale: this.render.stats.resolutionScale,
          missingAssets: [...this.assets.missing],
        };
      },
      setLook: (yawDeg: number, pitchDeg: number) => {
        this.player.yaw = THREE.MathUtils.degToRad(yawDeg);
        this.player.pitch = THREE.MathUtils.degToRad(pitchDeg);
      },
    };
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
