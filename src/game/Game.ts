/**
 * Composition root: constructs every system, wires events and owns the game loop.
 * Game wires the concrete systems; cross-system consumers depend on the contracts in
 * src/core/contracts.ts where possible. Pause/pointer-lock flow lives in PauseController,
 * save wiring in GamePersistence, gamepad menu navigation in MenuPadNavigator.
 */
import * as THREE from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents, PauseReason } from '../core/events';
import { GameLoop } from '../core/GameLoop';
import { createLogger } from '../core/log';
import type { LevelInstance, SaveData } from '../core/contracts';
import { BOOT_PROGRESS, ENGINE } from '../defs/engine';
import { MOVEMENT } from '../defs/movement';
import { GRAPHICS_PRESETS, RENDER } from '../defs/graphics';
import { COLLISION_GROUP, PHYSICS, interactionGroups } from '../defs/physics';
import { POSTFX } from '../defs/postfx';
import { TEST_ROOM } from '../defs/maps';
import { SaveSystem } from '../save/SaveSystem';
import { SettingsStore } from '../save/SettingsStore';
import type { QualityPreset } from '../save/settingsSchema';
import { RenderSystem } from '../render/RenderSystem';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { AssetLoader } from '../assets/AssetLoader';
import { getAssetEntry } from '../assets/manifest';
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
import type { LoadingScreen } from '../ui/LoadingScreen';
import { mountMenus, type MenuController } from '../ui/menus';
import { registerDevCommands } from './devCommands';
import { GamePersistence } from './GamePersistence';
import { MenuPadNavigator } from './MenuPadNavigator';
import { PauseController } from './PauseController';

const log = createLogger('Game');

/** Sun occlusion probe: a ray that only hits static world geometry. */
const SUN_PROBE_GROUPS = interactionGroups(COLLISION_GROUP.WORLD, COLLISION_GROUP.WORLD);

export interface GameOptions {
  /** Skip the start screen (automated tests). */
  autostart: boolean;
  /** Do not require pointer lock to play (automated tests / environments without lock). */
  noPointerLock: boolean;
  /** Expose a debug handle on window (smoke tests). */
  exposeHandle: boolean;
  /**
   * Force a graphics preset for this session only (`?preset=ultra`): not saved, no auto-detect,
   * no benchmark, profile flags untouched.
   */
  forcePreset: QualityPreset | null;
}

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in index.html`);
  return node;
}

export class Game {
  readonly loop: GameLoop;
  readonly pauseState: PauseController;
  readonly padNav: MenuPadNavigator;

  private time = 0;
  private benchmarkRunning = false;
  private readonly _yawDir = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _toSun = new THREE.Vector3();

  private constructor(
    readonly opts: GameOptions,
    readonly save: SaveSystem,
    readonly persistence: GamePersistence,
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
    readonly events: EventBus<GameEvents>,
  ) {
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
    this.pauseState = new PauseController({
      input,
      menus,
      loop: this.loop,
      audio,
      events,
      consoleOpen: () => devConsole.open,
      noPointerLock: opts.noPointerLock,
    });
    this.padNav = new MenuPadNavigator(el('ui'), input, () => {
      // B on the pause menu's main view (no sub-view took the "back"): resume.
      if (menus.current === 'pause') this.pauseState.resume(true);
    });
  }

  private get saveData(): SaveData {
    return this.persistence.data;
  }

  /**
   * Boot everything behind `loading` (already shown by main.ts). Throws only for truly fatal
   * problems (no WebGL2 context, failed engine chunks).
   */
  static async create(opts: GameOptions, loading: LoadingScreen): Promise<Game> {
    const events = new EventBus<GameEvents>();
    const progress = (fraction: number, label: string): void => {
      loading.setProgress(fraction, label);
      events.emit('loading:progress', { loaded: fraction, total: 1, label });
    };
    // Let the loading screen paint before heavy work starts.
    await nextFrame();

    progress(BOOT_PROGRESS.profile, 'Lade Profil…');
    const save = await SaveSystem.create();
    const persistence = new GamePersistence(await save.load(), save);
    const saveData = persistence.data;
    // SettingsStore debounces; the callback runs once per burst of changes.
    const settings = new SettingsStore(events, saveData.settings, persistence.persistSettings);
    loading.setReducedFlashing(settings.current.accessibility.reduceFlashing);

    progress(BOOT_PROGRESS.renderer, 'Initialisiere Renderer…');
    const canvas = el('game-canvas') as HTMLCanvasElement;
    const render = new RenderSystem(
      canvas,
      events,
      settings.current.graphics,
      settings.current.accessibility,
    );

    if (opts.forcePreset) {
      persistence.overrideGraphicsForSession(settings, {
        preset: opts.forcePreset,
        ...GRAPHICS_PRESETS[opts.forcePreset],
      });
    } else if (!saveData.profile.qualityAutoDetected) {
      const preset = render.quality.detectPreset();
      log.info(`Auto-detected graphics preset "${preset}" for GPU: ${render.quality.gpuName}`);
      settings.update('graphics', { preset, ...GRAPHICS_PRESETS[preset] });
      saveData.profile.qualityAutoDetected = true;
      // The settings write is skipped when the detected preset equals the stored one.
      void persistence.saveNow();
    }
    render.applyGraphicsSettings(settings.current.graphics);

    progress(BOOT_PROGRESS.physics, 'Initialisiere Physik…');
    const physics = await PhysicsWorld.create();

    const audio = new AudioEngine(events, settings.current.audio);
    const assets = new AssetLoader(render.renderer, () => audio.context ?? null);
    const audioBridge = new AudioEventBridge(events, audio);
    const input = new InputSystem(canvas, events, settings);

    const A = BOOT_PROGRESS.assets;
    progress(A.start, 'Lade Assets…');
    await assets.preload(TEST_ROOM.preload, (loaded, total, label) =>
      progress(A.start + A.span * (total > 0 ? loaded / total : 1), `Lade ${label}…`),
    );
    await registerAudioAssets(TEST_ROOM.preload, assets, audio);

    const L = BOOT_PROGRESS.level;
    progress(L.start, 'Generiere Materialien…');
    const materials = new MaterialLibrary(render, assets, settings, events);
    const level = await buildTestRoom({
      render,
      physics,
      assets,
      materials,
      settings,
      events,
      onProgress: (label, fraction) => progress(L.start + L.span * fraction, label),
    });
    render.scene.add(level.root);

    progress(BOOT_PROGRESS.environment, 'Kalibriere Umgebung…');
    const hdri = level.atmosphere.environment.hdri
      ? await assets.loadHDRI(level.atmosphere.environment.hdri)
      : null;
    render.applyAtmosphere(level.atmosphere, hdri);
    audio.setReverbZone(level.atmosphere.reverb);

    // Unlocks come from the profile; a movement sandbox (the calibration hall) grants everything.
    const unlocks = TEST_ROOM.movementSandbox ? { doubleJump: true, dash: true } : saveData.profile.unlocks;
    const player = new PlayerController({ physics, input, events, settings }, level.spawn, {
      unlocks: { doubleJump: unlocks.doubleJump, dash: unlocks.dash },
    });
    const playerCamera = new PlayerCamera({ player, input, render, events, settings });
    const viewmodel = new ViewmodelRig({ render, player, camera: playerCamera, events });
    const health = new PlayerHealth({ events, player });

    const hud = new Hud(el('hud'), events, settings);
    health.announce();
    const debug = new DebugOverlay(el('debug'), events);
    const devConsole = new DevConsole(el('console'), events);

    let gameRef: Game | null = null;
    const menus = mountMenus(el('ui'), {
      settings,
      input,
      events,
      onStart: (o) => gameRef?.startPlaying(o?.lockless),
      onResume: (o) => gameRef?.resumeFromMenu(o?.lockless),
      getInfo: () => ({
        gpuName: render.quality.gpuName,
        saveBackend: save.backendName,
        version: __APP_VERSION__,
      }),
    });

    const game = new Game(
      opts,
      save,
      persistence,
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
    const wasCapturing = this.input.capturing;
    this.input.beginFrame(realDt);
    this.pauseState.onFrame(wasCapturing);
    if (this.menus.isOpen && !this.devConsole.open && !wasCapturing && !this.input.capturing) {
      this.padNav.update(realDt);
    } else {
      this.padNav.reset();
    }
    // Look before the ticks: wish/dash/mantle directions use the yaw the camera shows this frame.
    if (!this.loop.paused) this.playerCamera.applyLook();
  }

  private fixedUpdate(dt: number): void {
    // The player computes its kinematic move against the current world, then the world steps
    // (dynamic props react to the pushes), so everything ends the tick in a consistent state.
    this.player.fixedUpdate(dt);
    if (!this.player.noclip && this.player.position.y < PHYSICS.killPlaneY) {
      // Fell out of the world (tp/noclip outside the hall, or a collision bug): back to spawn.
      log.warn(`Player below kill plane (y ${this.player.position.y.toFixed(1)}) – respawn`);
      this.player.teleport(this.level.spawn.position, this.level.spawn.yaw);
    }
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

    // Is the eye in direct sunlight? One ray per frame towards the sun (static world only).
    this._toSun.copy(this.render.sunDirection).negate();
    const blocked = this.physics.raycast(cam.position, this._toSun, RENDER.viewmodelSunProbeDistance, {
      groups: SUN_PROBE_GROUPS,
      excludeCollider: this.player.collider,
    });
    this.render.setViewmodelSunVisibility(blocked ? 0 : 1, dt);

    const p = this.player;
    this.hud.setDash(p.dashCharges, p.unlocks.dash ? MOVEMENT.dash.charges : 0, p.dashRecharge);
    this.hud.setMovement(Math.hypot(p.velocity.x, p.velocity.z), p.state);
    this.hud.update(dt, p.yaw);
  }

  private renderFrame(realDt: number, alpha: number): void {
    this.physics.syncVisuals(alpha);
    this.render.render(realDt);
    // Menu frames (backdrop blur, frozen scene) would skew dynamic resolution and the benchmark.
    if (!this.loop.paused) this.render.quality.onFrame(realDt);
    if (this.debug.visible) this.debug.update(realDt, () => this.debugSnapshot(realDt));
    this.input.endFrame();
  }

  // -------------------------------------------------------------------------
  // Events / pause flow
  // -------------------------------------------------------------------------

  private wireEvents(): void {
    const pause = this.pauseState;
    this.events.on('input:pointerLock', ({ locked }) => pause.onPointerLock(locked));
    document.addEventListener('visibilitychange', () => pause.onVisibility(document.hidden));
    this.events.on('ui:console', ({ open }) => pause.onConsole(open));
    // Capture phase after InputSystem's: a key swallowed by a rebinding capture never arrives here.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Escape') pause.noteEscape();
      },
      true,
    );
    this.render.canvas.addEventListener('mousedown', () => pause.onCanvasPointerDown());

    this.events.on('settings:changed', ({ settings, sections }) => {
      if (sections.includes('graphics')) {
        this.render.applyGraphicsSettings(settings.graphics);
        this.loop.fpsLimit = settings.graphics.fpsLimit;
      }
      if (sections.includes('audio')) this.audio.applySettings(settings.audio);
      // The camera rig only runs while playing: preview FOV changes behind the pause menu.
      if (sections.includes('controls') && this.loop.paused) this.playerCamera.snapFov();
    });

    this.events.on('player:healthChanged', ({ health, maxHealth }) => {
      this.render.setHealthFraction(maxHealth > 0 ? health / maxHealth : 1);
    });
    this.events.on('player:damaged', ({ amount }) => {
      this.render.addHitPulse(Math.min(1, amount / POSTFX.chromaticAberration.damageForFullPulse));
    });
    this.events.on('fx:hitPulse', ({ strength }) => this.render.addHitPulse(strength));

    // Only pending settings are written on unload: profile changes are saved when they happen, and
    // an unconditional write would resurrect a wiped save or let a stale tab overwrite newer data.
    const persistNow = (): void => this.settings.flush();
    // pagehide is the reliable signal on mobile Safari; beforeunload covers desktop browsers.
    window.addEventListener('pagehide', persistNow);
    window.addEventListener('beforeunload', persistNow);
  }

  /**
   * Start screen activated: a click (pointer lock + audio unlock allowed) or a gamepad press.
   * `lockless`: the menu asks to play without pointer lock (the API is missing or was refused).
   */
  startPlaying(lockless = false): void {
    this.saveData.profile.lastPlayedAt = Date.now();
    void this.persistence.saveNow();
    this.pauseState.start(lockless || this.padNav.activating);
    void this.maybeRunBenchmark();
  }

  /** Pause menu "Fortsetzen" (click, Enter, or gamepad A); `lockless` as in startPlaying. */
  resumeFromMenu(lockless = false): void {
    this.pauseState.resume(lockless || this.padNav.activating);
  }

  pause(reason: PauseReason): void {
    this.pauseState.pause(reason);
  }

  unpause(reason: PauseReason): void {
    this.pauseState.unpause(reason);
  }

  // -------------------------------------------------------------------------
  // Profile / save
  // -------------------------------------------------------------------------

  /** Store the player's current movement unlocks in the profile (dev console `unlock`). */
  persistUnlocks(): void {
    const u = this.player.unlocks;
    this.saveData.profile.unlocks = { doubleJump: u.doubleJump, dash: u.dash };
    void this.persistence.saveNow();
  }

  /** Dev console `resetsave`: wipe storage and continue with defaults (applied live). */
  resetSave(): Promise<void> {
    return this.persistence.reset(this.settings);
  }

  /** True when the current level grants every movement ability regardless of the profile. */
  get movementSandbox(): boolean {
    return TEST_ROOM.movementSandbox === true;
  }

  /** First-run benchmark: may downgrade the auto-detected preset once. */
  private async maybeRunBenchmark(): Promise<void> {
    if (this.opts.forcePreset || this.benchmarkRunning || this.saveData.profile.qualityBenchmarked) return;
    const current = this.settings.current.graphics.preset;
    if (current === 'custom') return;
    const graphicsBefore = this.settings.current.graphics;
    this.benchmarkRunning = true;
    const recommended: QualityPreset | null = await this.render.quality.runBenchmark(current);
    this.benchmarkRunning = false;
    this.saveData.profile.qualityBenchmarked = true;
    // Sections are replaced on every change: a new object means the player (or the console)
    // changed graphics while it measured – their choice wins over the measurement.
    if (this.settings.current.graphics !== graphicsBefore) {
      log.info('Benchmark result discarded: graphics settings changed during the measurement');
    } else if (recommended && recommended !== current) {
      log.info(`Benchmark: switching graphics preset ${current} → ${recommended}`);
      this.settings.update('graphics', { preset: recommended, ...GRAPHICS_PRESETS[recommended] });
      this.events.emit('quality:presetApplied', { preset: recommended, auto: true });
    }
    void this.persistence.saveNow();
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
      teleport: (x: number, y: number, z: number, yawDeg = 0, pitchDeg = 0) => {
        this.player.teleport({ x, y, z }, THREE.MathUtils.degToRad(yawDeg));
        this.player.pitch = THREE.MathUtils.degToRad(pitchDeg);
      },
      exec: (line: string) => this.devConsole.execute(line),
      setLook: (yawDeg: number, pitchDeg: number) => {
        this.player.yaw = THREE.MathUtils.degToRad(yawDeg);
        this.player.pitch = THREE.MathUtils.degToRad(pitchDeg);
      },
    };
  }
}

/** Hand decoded audio assets of the level to the audio engine (it falls back to synth sounds). */
async function registerAudioAssets(
  ids: readonly string[],
  assets: AssetLoader,
  audio: AudioEngine,
): Promise<void> {
  for (const id of ids) {
    if (getAssetEntry(id)?.type !== 'audio') continue;
    const buffer = await assets.loadAudio(id); // cached by preload
    if (buffer) audio.registerBuffer(id, buffer);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
