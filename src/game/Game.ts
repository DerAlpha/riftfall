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
import type { ArsenalVfxApi, LevelInstance, SaveData } from '../core/contracts';
import { BOOT_PROGRESS, ENGINE } from '../defs/engine';
import { MOVEMENT } from '../defs/movement';
import { POWERUPS } from '../defs/powerups';
import { GRAPHICS_PRESETS, RENDER } from '../defs/graphics';
import { COLLISION_GROUP, interactionGroups } from '../defs/physics';
import { POSTFX } from '../defs/postfx';
import { TEST_ROOM } from '../defs/maps';
import { RUN } from '../defs/waves';
import { startPointsFor } from '../defs/economy';
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
import { PlayerController } from '../player/PlayerController';
import { PlayerCamera } from '../player/PlayerCamera';
import { ViewmodelRig } from '../player/ViewmodelRig';
import { PlayerHealth } from '../player/PlayerHealth';
import { Hud } from '../ui/hud/Hud';
import { DebugOverlay, type DebugCombatSnapshot, type DebugSnapshot } from '../ui/debug/DebugOverlay';
import { DevConsole } from '../ui/console/DevConsole';
import type { LoadingScreen } from '../ui/LoadingScreen';
import { mountMenus, type MenuController } from '../ui/menus';
import { CombatWorld } from '../combat/CombatWorld';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { Arsenal } from '../weapons/fire/Arsenal';
import { createFireCommands } from '../weapons/fire/fireCommands';
import type { ProjectileSystem } from '../weapons/fire/ProjectileSystem';
import type { FieldSystem } from '../combat/FieldSystem';
import type { Explosions } from '../combat/Explosions';
import { StatusEffectSystem } from '../combat/status/StatusEffectSystem';
import { createStatusCommands } from '../combat/status/statusCommands';
import { statusResistFor } from '../defs/elements';
import { getLoadout } from '../defs/weapons';
import { VFX } from '../defs/vfx';
import { VfxSystem } from '../vfx/VfxSystem';
import { VfxBridge } from '../vfx/VfxBridge';
import { createVfxCommands } from '../vfx/vfxCommands';
import { createArsenalCommands } from '../vfx/arsenal/arsenalCommands';
import { TrainingTargets } from '../world/TrainingTargets';
import { registerDevCommands } from './devCommands';
import { runFixedTick } from './fixedTick';
import { resetRunSystems } from './runReset';
import { Rng } from '../core/Rng';
import type { EnemyTargetApi } from '../core/contracts';
import { getMap, listMaps, type MapEntry } from '../maps/registry';
import { isMapLevel } from '../maps/types';
import { NavSystem } from '../nav/NavSystem';
import { collectNavSources } from '../nav/navGeometry';
import { createNavCommands } from '../nav/navCommands';
import { createPhysicsGroundProbe } from '../nav/groundProbe';
import { EnemyRenderer } from '../enemies/render/EnemyRenderer';
import { EnemyManager } from '../enemies/EnemyManager';
import { createEnemyCommands } from '../enemies/enemyCommands';
import { WaveDirector } from '../spawning/WaveDirector';
import { createWaveCommands } from '../spawning/waveCommands';
import { RunFlow } from '../modes/RunFlow';
import { createRunCommands } from '../modes/runCommands';
import { deathCameraOffset } from '../modes/deathCamera';
import { StatSystem } from '../stats/StatSystem';
import { EconomySystem } from '../economy/EconomySystem';
import { PointsRules } from '../economy/PointsRules';
import { PerkSystem } from '../economy/PerkSystem';
import { createEconomyCommands } from '../economy/economyCommands';
import { createPerkBlastFx } from '../economy/perkHooks';
import { ZoneSystem } from '../interactables/ZoneSystem';
import { InteractionSystem } from '../interactables/InteractionSystem';
import { placeInteractables, type InteractablesHandle } from '../interactables/placeInteractables';
import { createWeaponAdapter } from '../interactables/types';
import { createInteractCommands } from '../interactables/interactCommands';
import { SealSystem } from '../seals/SealSystem';
import { PowerUpSystem } from '../powerups/PowerUpSystem';
import { createPowerUpCommands } from '../powerups/powerupCommands';
import { GrenadeSystem } from '../grenades/GrenadeSystem';
import { createGrenadeCommands } from '../grenades/grenadeCommands';
import { AbilitySystem } from '../abilities/AbilitySystem';
import { AbilityVisuals } from '../abilities/AbilityVisuals';
import { createAbilityCommands } from '../abilities/abilityCommands';
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
  /** Map to build (`?map=`, else the last played map); unknown ids fall back to the default. */
  mapId: string | null;
}

/** Enemy records built up front (no allocation when a wave ramps up). */
const ENEMY_PREWARM: readonly (readonly [string, number])[] = [
  ['swarmer', 48],
  ['spitter', 16],
  ['tank', 8],
];

/** localStorage key of the last selected map (the start screen switches maps via a reload). */
const LAST_MAP_KEY = 'riftfall.lastMap';

/** Death camera offset scratch (re-applied every frame on top of the camera rig). */
const _deathOff = { drop: 0, roll: 0, pitch: 0 };

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in index.html`);
  return node;
}

/** Every system the composition root builds. Grows with each milestone – add fields here. */
export interface GameSystems {
  events: EventBus<GameEvents>;
  save: SaveSystem;
  persistence: GamePersistence;
  settings: SettingsStore;
  render: RenderSystem;
  physics: PhysicsWorld;
  assets: AssetLoader;
  audio: AudioEngine;
  audioBridge: AudioEventBridge;
  input: InputSystem;
  materials: MaterialLibrary;
  level: LevelInstance;
  player: PlayerController;
  playerCamera: PlayerCamera;
  viewmodel: ViewmodelRig;
  health: PlayerHealth;
  hud: Hud;
  debug: DebugOverlay;
  devConsole: DevConsole;
  menus: MenuController;
  // M2
  combat: CombatWorld;
  weapons: WeaponSystem;
  vfx: VfxSystem;
  vfxBridge: VfxBridge;
  /** M5 arsenal visuals (projectiles, trails, beams, fields, charge glow) – part of the VFX system. */
  arsenalVfx: ArsenalVfxApi;
  targets: TrainingTargets | null;
  // M3
  map: MapEntry;
  nav: NavSystem;
  enemyVisuals: EnemyRenderer;
  enemies: EnemyManager;
  waves: WaveDirector;
  runFlow: RunFlow;
  // M4
  stats: StatSystem;
  economy: EconomySystem;
  pointsRules: PointsRules;
  perks: PerkSystem;
  zones: ZoneSystem;
  interaction: InteractionSystem;
  interactables: InteractablesHandle;
  /** Rift seals at the spawn points (wave maps only). */
  seals: SealSystem | null;
  powerUps: PowerUpSystem;
  // M5 fire kinds (weapons/fire Arsenal): the parts are exposed for grenades, abilities, elements.
  arsenal: Arsenal;
  projectiles: ProjectileSystem;
  fields: FieldSystem;
  explosions: Explosions;
  /** M5 elements: status effects (build-up from CombatWorld hits, slow/halt/rim read by enemies). */
  status: StatusEffectSystem;
  /** M5 grenades ('grenade' action) and abilities ('ability' action) with their in-world looks. */
  grenades: GrenadeSystem;
  abilities: AbilitySystem;
  abilityVisuals: AbilityVisuals;
}

export class Game {
  readonly loop: GameLoop;
  readonly pauseState: PauseController;
  readonly padNav: MenuPadNavigator;

  private time = 0;
  /** A run touched the run systems since the last resetRunSystems (startPlaying resets them). */
  private runDirty = false;
  /** Runs started this session (per-run random seeds). */
  private runSeq = 0;
  private benchmarkRunning = false;
  private readonly _yawDir = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);
  private readonly _toSun = new THREE.Vector3();
  /** Frames and combat raycast total at the last debug snapshot (per-frame raycast rate). */
  private readonly debugRate = { frames: 0, raycasts: 0 };

  private constructor(
    readonly opts: GameOptions,
    readonly sys: GameSystems,
  ) {
    const { input, menus, audio, events, devConsole, settings } = sys;
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
    return this.sys.persistence.data;
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
    // No explicit/remembered map: the recommended one (listMaps sorts it first).
    const map = opts.mapId ? getMap(opts.mapId) : (listMaps()[0] ?? getMap(null));
    await assets.preload(map.atmosphere.preload, (loaded, total, label) =>
      progress(A.start + A.span * (total > 0 ? loaded / total : 1), `Lade ${label}…`),
    );
    await registerAudioAssets(map.atmosphere.preload, assets, audio);

    const L = BOOT_PROGRESS.level;
    progress(L.start, 'Generiere Materialien…');
    const materials = new MaterialLibrary(render, assets, settings, events);
    const level = await map.build({
      render,
      physics,
      assets,
      materials,
      settings,
      events,
      onProgress: (label, fraction) => progress(L.start + L.span * fraction, label),
    });
    render.scene.add(level.root);

    // Navmesh in a worker while VFX, atmosphere and shader warm-up run on the main thread.
    const nav = new NavSystem({ groundProbe: createPhysicsGroundProbe(physics) });
    const navBuilt = nav.build(level.navSources ?? collectNavSources(level.root));

    // Combat world + VFX before the atmosphere: VFX adds a constant pool of flash lights, and lit
    // materials would compile twice if those lights appeared after applyAtmosphere's warm-up.
    const combat = new CombatWorld({ events, physics });
    combat.setLevel(level.root);
    const vfx = await VfxSystem.create({
      render,
      settings,
      physics,
      events,
      shockwave: (p, r, s) => render.addShockwave(p, r, s),
      lens: (slot, p, r, s) => render.setLens(slot, p, r, s),
      onClink: audioBridge.onCasingClink,
    });
    const vfxBridge = new VfxBridge({ events, vfx });
    const targets =
      TEST_ROOM.id === level.id
        ? new TrainingTargets({
            scene: render.scene,
            combat,
            events,
            physics,
            render,
            reduceFlashing: settings.current.accessibility.reduceFlashing,
          })
        : null;
    // Particles/tracers and target barriers share the volumetric layer: its pass runs only while
    // they or level volumetrics draw.
    const enemyVisuals = new EnemyRenderer({
      scene: render.scene,
      render,
      reduceFlashing: settings.current.accessibility.reduceFlashing,
    });

    progress(BOOT_PROGRESS.environment, 'Kalibriere Umgebung…');
    const hdri = level.atmosphere.environment.hdri
      ? await assets.loadHDRI(level.atmosphere.environment.hdri)
      : null;
    render.applyAtmosphere(level.atmosphere, hdri);
    audio.setReverbZone(level.atmosphere.reverb);

    // Unlocks come from the profile; a movement sandbox (the calibration hall) grants everything.
    const unlocks = map.movementSandbox ? { doubleJump: true, dash: true } : saveData.profile.unlocks;
    const player = new PlayerController({ physics, input, events, settings }, level.spawn, {
      unlocks: { doubleJump: unlocks.doubleJump, dash: unlocks.dash },
    });
    const playerCamera = new PlayerCamera({ player, input, render, events, settings });
    const viewmodel = new ViewmodelRig({
      render,
      player,
      camera: playerCamera,
      events,
      reduceFlashing: settings.current.accessibility.reduceFlashing,
    });
    vfx.setSockets(viewmodel);
    const health = new PlayerHealth({ events, player });
    // M5 fire kinds: projectiles, explosions, fields and weapon specials, shared with grenades and
    // abilities, drawn by the VFX system's arsenal visuals; the player hook (self damage, blast
    // shake) is attached once the enemy target exists.
    const arsenal = new Arsenal({
      events,
      combat,
      physics,
      vfx: vfx.arsenal,
      heal: (amount) => health.heal(amount),
      seed: `arsenal:${level.id}:${Date.now()}`,
    });
    const weapons = new WeaponSystem({
      events,
      input,
      settings,
      player,
      camera: playerCamera,
      render,
      combat,
      physics,
      getMuzzleWorld: (out) => viewmodel.getSocketWorldPosition('muzzle', out),
      arsenal,
    });
    viewmodel.setAdsSource(weapons);

    // M4 stats: every consumer re-reads them on its next tick/frame/damage call.
    const runSeed = `run:${level.id}:${Date.now()}`;
    const stats = new StatSystem({ events });
    player.setStats(stats);
    health.setStats(stats);
    weapons.setStats(stats);
    // The calibration hall starts with a sandbox budget (economy.reset() restores it).
    const economy = new EconomySystem({ events, stats }, startPointsFor(map));
    const perks = new PerkSystem({
      events,
      stats,
      combat,
      player,
      seed: `perks:${runSeed}`,
      // Nova / Kinetik / Phoenix blasts: their own floor-level VFX, screen shockwave and sound.
      blastFx: createPerkBlastFx({
        vfx,
        audio,
        shockwave: (p, r, s) => render.addShockwave(p, r, s),
        shockwaveScale: () => settings.current.accessibility.screenShake,
      }),
    });

    let gameRef: Game | null = null;
    const runFlow = new RunFlow({
      events,
      setTimeScale: (scale) => {
        if (gameRef) gameRef.loop.timeScale = scale;
      },
      getPlayerPosition: () => player.position,
      // Bypasses revives and damage stats (Phoenix, damageTaken): `run kill` always ends the run.
      killPlayer: () => void health.kill(),
      showGameOver: (summary) => gameRef?.showGameOver(summary),
    });

    // The player as seen by enemies and the wave director: dead for the whole death sequence,
    // also when the run died without health reaching 0 (`run kill` in god mode) – no spawns, no
    // attacks on the corpse.
    const enemyTarget: EnemyTargetApi = {
      position: player.position,
      eyePosition: player.eyePosition,
      velocity: player.velocity,
      get alive() {
        return !health.dead && runFlow.state !== 'dying' && runFlow.state !== 'over';
      },
      get yaw() {
        return player.yaw;
      },
      damage: (amount, direction, kind) => health.damage(amount, direction, kind),
    };
    arsenal.setPlayer(enemyTarget);
    const enemies = new EnemyManager({
      events,
      combat,
      nav,
      visuals: enemyVisuals,
      target: enemyTarget,
      physics,
      vfx,
      scene: render.scene,
      seed: runSeed,
    });
    for (const [type, count] of ENEMY_PREWARM) enemies.prewarm(type, count);
    // Kill credit per enemy kind: the def's point table (a killed enemy is still found at combat:kill).
    const pointsRules = new PointsRules({
      events,
      economy,
      rewardOf: (id) => enemies.getEnemy(id)?.def.points,
    });
    const zones = ZoneSystem.forLevel(level, events);
    const waves = new WaveDirector({
      events,
      enemies,
      spawnPoints: level.spawnPoints ?? [],
      target: enemyTarget,
      camera: render.camera,
      rng: new Rng(`waves:${runSeed}`),
      lineOfSight: (a, b) => combat.lineOfSight(a, b),
      randomPoint: (c, r, out) => nav.randomPointAround(c, r, out),
      isZoneActive: (z) => zones.isActive(z),
    });
    audioBridge.setEnemySource(enemies);
    // M5 elements: CombatWorld reports every hit (build-up, void mark), the arsenal's element procs
    // build up directly, enemies read slow / halt / rim tint and the fields' pull and slow.
    const status = new StatusEffectSystem({
      events,
      combat,
      vfx,
      explosions: arsenal.explosions,
      fields: arsenal.fields,
      arcs: arsenal.specials,
      // Resistances by enemy kind; damage over time scales with its toughness (wave health, elite).
      profile: (t, out) => {
        const e = enemies.getEnemy(t.id);
        if (!e) return false;
        out.resist = statusResistFor(e.type, e.def.boss);
        out.healthScale = e.def.health > 0 ? e.maxHealth / e.def.health : 1;
        return true;
      },
      seed: `status:${runSeed}`,
    });
    combat.setStatus(status);
    arsenal.setStatus(status);
    enemies.setStatus(status);
    enemies.setFields(arsenal.fields);

    // M4 economy world: interaction focus, doors/wall buys/box/perk machines, rift seals, power-ups.
    const playing = (): boolean => !health.dead && runFlow.state !== 'dying' && runFlow.state !== 'over';
    const interaction = new InteractionSystem({
      events,
      input,
      viewer: player,
      economy,
      lineOfSight: (a, b) => combat.lineOfSight(a, b),
      enabled: playing,
    });
    // Pad X is shared by reload and interact: at a purchase it buys instead of reloading. Hold
    // interactions (seal repairs) keep the tap for reloading – they are where the fighting is.
    weapons.setReloadSuppressor(
      () => input.device === 'gamepad' && interaction.offering && (interaction.focused?.holdTime() ?? 0) <= 0,
    );
    const reduceFlashing = settings.current.accessibility.reduceFlashing;
    const interactables = placeInteractables({
      level,
      events,
      economy,
      weapons: createWeaponAdapter(weapons),
      perks,
      zones,
      interaction,
      physics,
      combat,
      nav,
      rng: new Rng(`box:${runSeed}`),
      vfx,
      decals: vfx.decals,
      player: { position: player.position, radius: MOVEMENT.collider.radius },
      visuals: { scene: render.scene, materials, render, reduceFlashing },
      mapId: map.id,
    });
    const seals =
      map.waves && (level.spawnPoints?.length ?? 0) > 0
        ? new SealSystem({
            events,
            spawnPoints: level.spawnPoints ?? [],
            scene: render.scene,
            setupMaterial: (m) => render.setupMaterial(m),
            vfx,
            rewards: pointsRules,
            probe: (o, d, max) => physics.raycast(o, d, max, { groups: SUN_PROBE_GROUPS })?.distance ?? max,
            reduceFlashing,
          })
        : null;
    seals?.attach(interaction);
    enemies.setBreach(seals);
    const nukeFx = POWERUPS.effects.nuke;
    const powerUps = new PowerUpSystem({
      events,
      player: player,
      canCollect: playing,
      stats,
      economy,
      enemies,
      weapons,
      seals,
      armor: health,
      snapToFloor: (p, out) => nav.closestPoint(p, out),
      vfx,
      fx: {
        nuke: (p) => {
          render.addShockwave(p, nukeFx.radius, 1);
          events.emit('fx:hitPulse', { strength: nukeFx.pulse });
          events.emit('camera:shake', { trauma: nukeFx.shake });
        },
        // Zeitdehnung: the HUD's cold, desaturating tint overlay.
        timeTint: (amount) => gameRef?.sys.hud.setTimeTint(amount),
      },
      scene: render.scene,
      seed: `powerups:${runSeed}`,
      reduceFlashing,
    });
    perks.setAmmoDropHandler(powerUps.dropAmmo);
    // Economy sounds play at their world objects; the power-up clock drives the expiry ticks.
    audioBridge.setEconomySources({
      doors: interactables.doors.map((d) => ({ id: d.id, position: d.slot.position, blast: d.slot.blast })),
      perkMachines: interactables.perkMachines,
      box: interactables.box,
      powerUps,
    });

    // M5 grenades and abilities (fixed tick right after the weapons): throws start at the rendered
    // camera like every shot and fly as arsenal projectiles; ability blasts and fields go through
    // the arsenal too, their stat modifiers through the stat table. The map loadout picks the
    // starting grenades and the equipped ability (defaults in defs/grenades, defs/abilities).
    const m5Loadout = getLoadout(level.id);
    const grenades = new GrenadeSystem({
      events,
      input,
      projectiles: arsenal.projectiles,
      player,
      eye: () => render.camera.position,
      aimPitchOffset: () => playerCamera.aimPitchOffset,
      combat,
      status,
      enabled: playing,
      onDeny: () => gameRef?.sys.hud.arsenal.deny('grenade'),
      start: m5Loadout.grenade ?? null,
    });
    const abilityVisuals = new AbilityVisuals({
      parent: render.scene,
      anchor: () => render.camera.position,
      physics,
      shockwave: (p, r, s) =>
        render.addShockwave(p, r, s * Math.min(1, Math.max(0, settings.current.accessibility.screenShake))),
      reduceFlashing,
    });
    const abilities = new AbilitySystem({
      events,
      input,
      stats,
      explosions: arsenal.explosions,
      fields: arsenal.fields,
      player,
      visuals: abilityVisuals,
      enabled: playing,
      onDeny: () => gameRef?.sys.hud.arsenal.deny('ability'),
      ability: m5Loadout.ability,
    });

    // Particles/tracers, target barriers, holograms, seals and pickups share the volumetric layer:
    // its pass runs only while one of them (or the level's volumetrics) draws.
    render.setVolumetricContentProbe(
      () =>
        vfx.hasVolumetricContent ||
        (targets?.hasVolumetricContent ?? false) ||
        (isMapLevel(level) && level.hasVolumetricContent) ||
        enemyVisuals.hasVolumetricContent ||
        interactables.hasVolumetricContent ||
        (seals?.hasVolumetricContent ?? false) ||
        powerUps.hasVolumetricContent ||
        abilityVisuals.hasVolumetricContent,
    );

    const hud = new Hud(el('hud'), events, settings);
    hud.setCamera(render.camera);
    // The countdown shows the director's clock (fixed ticks; frozen while the player is dead).
    hud.setWaveCountdownSource(() => waves.intermissionLeft);
    // M4: power-up timers read the system's clock; zone names for the unlock banner; prompt key cap.
    hud.setPowerUpSource(powerUps);
    // M5: ability ring + grenade wind-up read per frame; the grenade chip starts from announce().
    hud.arsenal.setSources(abilities, grenades);
    grenades.announce();
    // M5: the HUD names a forged weapon by its tier.
    hud.setWeaponNameSource((id) => weapons.effectiveDef(id)?.name);
    hud.setZoneNames(isMapLevel(level) ? level.zones : []);
    hud.setInputDevice(input.device);
    health.announce();
    economy.announce();
    const debug = new DebugOverlay(el('debug'), events);
    const devConsole = new DevConsole(el('console'), events);

    const menus = mountMenus(el('ui'), {
      settings,
      input,
      events,
      maps: listMaps(),
      onStart: (o) => gameRef?.startPlaying(o?.lockless, o?.mapId),
      onResume: (o) => gameRef?.resumeFromMenu(o?.lockless),
      onRestart: (o) => gameRef?.restartRun(o?.lockless),
      onMainMenu: () => gameRef?.toMainMenu(),
      getInfo: () => ({
        gpuName: render.quality.gpuName,
        saveBackend: save.backendName,
        version: __APP_VERSION__,
        mapName: map.name,
        mapId: map.id,
      }),
    });

    const game = new Game(opts, {
      events,
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
      combat,
      weapons,
      vfx,
      vfxBridge,
      arsenalVfx: vfx.arsenal,
      targets,
      map,
      nav,
      enemyVisuals,
      enemies,
      waves,
      runFlow,
      stats,
      economy,
      pointsRules,
      perks,
      zones,
      interaction,
      interactables,
      seals,
      powerUps,
      arsenal,
      projectiles: arsenal.projectiles,
      fields: arsenal.fields,
      explosions: arsenal.explosions,
      status,
      grenades,
      abilities,
      abilityVisuals,
    });
    gameRef = game;
    game.registerCommands();
    game.wireEvents();

    // Every weapon-event listener (animator, audio, VFX, HUD) exists now: hand out the loadout.
    const loadout = getLoadout(level.id);
    weapons.setLoadout(loadout.weapons, loadout.slots);

    // Warm up shaders so the first real frame does not hitch. VFX renders one invisible frame
    // through the composer; the world and weapon models are compiled against a render target.
    compileForPostChain(render.renderer, render.scene, render.camera);
    viewmodel.warmupWeapons(render.renderer);
    enemyVisuals.warmup(render.renderer, render.camera);
    vfx.warmup();

    // Enemies need the navmesh (false = direct steering fallback, already logged).
    progress(BOOT_PROGRESS.navigation, 'Berechne Navigationsnetz…');
    await navBuilt;

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
    const { input, menus, devConsole, playerCamera, runFlow } = this.sys;
    const wasCapturing = input.capturing;
    input.beginFrame(realDt);
    // No moving, looking, firing or pausing during the death sequence (before the pause binding
    // is read); a restart out of it (dev console, smoke handle) hands the input back.
    this.pauseState.setInputLocked(runFlow.state === 'dying');
    this.pauseState.onFrame(wasCapturing);
    if (menus.isOpen && !devConsole.open && !wasCapturing && !input.capturing) {
      this.padNav.update(realDt);
    } else {
      this.padNav.reset();
    }
    // Look before the ticks: wish/dash/mantle directions use the yaw the camera shows this frame.
    // applyLook also runs the weapon look hook (ADS sensitivity, gamepad aim assist).
    if (!this.loop.paused) playerCamera.applyLook();
  }

  private fixedUpdate(dt: number): void {
    // player → weapons → targets → kill plane → physics.step → health → level. Weapons fire before
    // the targets move: shots resolve against the previous tick's hitboxes (what was rendered).
    runFixedTick(this.sys, dt);
  }

  private update(dt: number, alpha: number): void {
    const {
      player,
      weapons,
      playerCamera,
      viewmodel,
      vfx,
      level,
      targets,
      render,
      audio,
      physics,
      hud,
      enemies,
      runFlow,
      audioBridge,
      interaction,
      interactables,
      seals,
      powerUps,
      arsenal,
      grenades,
      abilities,
      abilityVisuals,
    } = this.sys;
    this.time += dt;
    player.update(dt, alpha);
    // Every frame: advances the once-per-frame press latch of the interact binding.
    interaction.update(dt);
    // Weapons before the camera: ADS blend, recoil counter-pull and FOV zoom of this frame.
    weapons.update(dt);
    // Grenade / ability presses of frames that ran no tick.
    grenades.update(dt);
    abilities.update(dt);
    playerCamera.update(dt);
    if (runFlow.deathTime > 0) {
      // The rig re-sets the camera every frame, so the death offset never accumulates.
      deathCameraOffset(runFlow.deathTime, RUN.death.cameraDropSeconds, _deathOff);
      render.camera.position.y -= _deathOff.drop;
      render.camera.rotateZ(_deathOff.roll);
      render.camera.rotateX(_deathOff.pitch);
    }
    viewmodel.update(dt);
    // VFX after the viewmodel: muzzle flashes and casings use this frame's socket positions.
    vfx.update(dt);
    // Arsenal visuals too: projectiles converge from the muzzle as shown, beams start there; the
    // arsenal VFX rebuild their draw batches after the simulation's frame update (every frame).
    arsenal.update(dt, alpha);
    weapons.updateVisuals(dt);
    vfx.arsenal.update(dt);
    // Ability looks follow this frame's camera (the Chronofeld dome).
    abilityVisuals.update(dt);
    interactables.update(dt, alpha);
    seals?.update(dt);
    powerUps.update(dt);
    // Shockwaves age on game time with their explosion (frozen while paused, slowed by timeScale).
    render.advanceWorldTime(dt);
    level.update(dt, this.time);
    targets?.update(dt, alpha);
    enemies.update(dt, alpha);

    const cam = render.camera;
    cam.getWorldDirection(this._yawDir);
    audio.setListener(cam.position, this._yawDir, this._up);
    audioBridge.update(dt, cam.position);

    // Is the eye in direct sunlight? One ray per frame towards the sun (static world only).
    this._toSun.copy(render.sunDirection).negate();
    const blocked = physics.raycast(cam.position, this._toSun, RENDER.viewmodelSunProbeDistance, {
      groups: SUN_PROBE_GROUPS,
      excludeCollider: player.collider,
    });
    render.setViewmodelSunVisibility(blocked ? 0 : 1, dt);

    hud.setDash(player.dashCharges, player.unlocks.dash ? player.maxDashCharges : 0, player.dashRecharge);
    hud.setMovement(Math.hypot(player.velocity.x, player.velocity.z), player.state);
    // The crosshair gap shows the real cone: projected with this frame's FOV (after playerCamera).
    hud.setSpreadCone(weapons.spreadDegrees, render.camera.fov);
    hud.setAds(weapons.adsAmount);
    // The prompt's hold ring (seal repairs): progress of the focus, drawn for hold interactions only.
    const focus = interaction.focused;
    hud.setInteractHold(interaction.holdProgress, focus !== null && focus.holdTime() > 0);
    hud.update(dt, player.yaw);
  }

  private renderFrame(realDt: number, alpha: number): void {
    const { physics, render, debug, input } = this.sys;
    physics.syncVisuals(alpha);
    render.render(realDt);
    // Menu frames (backdrop blur, frozen scene) would skew dynamic resolution and the benchmark.
    if (!this.loop.paused) {
      render.quality.onFrame(realDt);
      // Death slow motion eases on real time.
      this.sys.runFlow.update(realDt);
    }
    if (debug.visible) {
      this.debugRate.frames++;
      debug.update(realDt, () => this.debugSnapshot(realDt));
    } else {
      this.debugRate.frames = 0;
      this.debugRate.raycasts = this.sys.combat.stats.raycasts;
    }
    input.endFrame();
  }

  /** Dev console: core commands (devCommands.ts) plus per-system command sets. */
  private registerCommands(): void {
    const { devConsole, vfx, physics, render, weapons, targets } = this.sys;
    registerDevCommands({
      ...this.sys,
      loop: this.loop,
      weapons,
      targets,
      persistUnlocks: () => this.persistUnlocks(),
      resetSave: () => this.resetSave(),
      movementSandbox: this.movementSandbox,
    });
    for (const c of createVfxCommands({ vfx, events: this.sys.events, physics, camera: render.camera }))
      devConsole.register(c);
    // `fx`: arsenal visual previews (projectiles, beams, fields, charge) without a weapon.
    const sockets = this.sys.viewmodel;
    for (const c of createArsenalCommands({
      arsenal: vfx.arsenal,
      vfx,
      physics,
      camera: render.camera,
      sockets: () => sockets,
    }))
      devConsole.register(c);
    const { nav, level, enemies, waves, runFlow, player } = this.sys;
    const commands = [
      ...createNavCommands({
        nav,
        scene: render.scene,
        sources: () => level.navSources ?? collectNavSources(level.root),
      }),
      ...createEnemyCommands({
        manager: enemies,
        player: () => ({ position: player.position, yaw: player.yaw }),
        // Console spawns are test subjects: no points, no power-up drops.
        onSpawned: (id) => {
          this.sys.pointsRules.flagNoReward(id);
          this.sys.powerUps.flagNoDrop(id);
        },
      }),
      ...createWaveCommands({ waves }),
      ...createRunCommands({ run: runFlow }),
      ...createEconomyCommands({ economy: this.sys.economy, perks: this.sys.perks, stats: this.sys.stats }),
      ...createInteractCommands({
        doors: this.sys.interactables.doors,
        box: this.sys.interactables.box,
        zones: this.sys.zones,
      }),
      ...createPowerUpCommands({
        powerups: this.sys.powerUps,
        seals: this.sys.seals,
        player: () => ({ position: player.position, yaw: player.yaw }),
      }),
      ...createFireCommands({ weapons, arsenal: this.sys.arsenal }),
      ...createGrenadeCommands({ grenades: this.sys.grenades }),
      ...createAbilityCommands({ abilities: this.sys.abilities }),
      ...createStatusCommands({
        status: this.sys.status,
        combat: this.sys.combat,
        player: () => player.position,
      }),
    ];
    for (const c of commands) devConsole.register(c);
  }

  // -------------------------------------------------------------------------
  // Events / pause flow
  // -------------------------------------------------------------------------

  private wireEvents(): void {
    const pause = this.pauseState;
    this.sys.events.on('input:pointerLock', ({ locked }) => pause.onPointerLock(locked));
    document.addEventListener('visibilitychange', () => pause.onVisibility(document.hidden));
    this.sys.events.on('ui:console', ({ open }) => pause.onConsole(open));
    // Capture phase after InputSystem's: a key swallowed by a rebinding capture never arrives here.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Escape') pause.noteEscape();
      },
      true,
    );
    this.sys.render.canvas.addEventListener('mousedown', () => pause.onCanvasPointerDown());

    this.sys.events.on('settings:changed', ({ settings, sections }) => {
      if (sections.includes('graphics')) {
        this.sys.render.applyGraphicsSettings(settings.graphics);
        this.loop.fpsLimit = settings.graphics.fpsLimit;
      }
      if (sections.includes('audio')) this.sys.audio.applySettings(settings.audio);
      // The camera rig only runs while playing: preview FOV changes behind the pause menu.
      if (sections.includes('controls') && this.loop.paused) this.sys.playerCamera.snapFov();
    });

    this.sys.events.on('player:healthChanged', ({ health, maxHealth }) => {
      this.sys.render.setHealthFraction(maxHealth > 0 ? health / maxHealth : 1);
    });
    this.sys.events.on('player:damaged', ({ amount }) => {
      this.sys.render.addHitPulse(Math.min(1, amount / POSTFX.chromaticAberration.damageForFullPulse));
    });
    this.sys.events.on('fx:hitPulse', ({ strength }) => this.sys.render.addHitPulse(strength));
    this.sys.events.on('settings:changed', ({ settings, sections }) => {
      if (!sections.includes('accessibility')) return;
      const reduce = settings.accessibility.reduceFlashing;
      this.sys.enemyVisuals.setReducedFlashing(reduce);
      this.sys.interactables.setReducedFlashing(reduce);
      this.sys.seals?.setReducedFlashing(reduce);
      this.sys.powerUps.setReducedFlashing(reduce);
      this.sys.abilityVisuals.setReducedFlashing(reduce);
    });
    this.sys.events.on('player:died', () => {
      this.sys.viewmodel.setVisible(false);
      // Now, not next frame: the remaining ticks of this frame must not move or fire either.
      this.pauseState.setInputLocked(true);
    });
    // Covers "Neu starten" and the dev console `run restart`.
    this.sys.events.on('run:restart', () => {
      this.resetRunSystems();
      // `run restart` typed behind the game over screen: the restarted run waits behind the pause
      // menu ("Fortsetzen" takes the lock) instead of a stale game over screen.
      if (this.sys.menus.view === 'gameover') {
        this.sys.menus.hide();
        this.pauseState.openMenu();
      }
    });

    // Only pending settings are written on unload: profile changes are saved when they happen, and
    // an unconditional write would resurrect a wiped save or let a stale tab overwrite newer data.
    const persistNow = (): void => this.sys.settings.flush();
    // pagehide is the reliable signal on mobile Safari; beforeunload covers desktop browsers.
    window.addEventListener('pagehide', persistNow);
    window.addEventListener('beforeunload', persistNow);
  }

  /**
   * Start screen activated: a click (pointer lock + audio unlock allowed) or a gamepad press.
   * `lockless`: the menu asks to play without pointer lock (the API is missing or was refused).
   */
  startPlaying(lockless = false, mapId?: string): void {
    const { map, level, runFlow } = this.sys;
    if (mapId && getMap(mapId).id !== map.id) {
      // Maps are switched by rebuilding the whole game (a reload): every system holds level state.
      this.switchMap(getMap(mapId).id);
      return;
    }
    this.saveData.profile.lastPlayedAt = Date.now();
    void this.sys.persistence.saveNow();
    rememberMap(map.id);
    // "Hauptmenü" already reset everything: resetting again would re-issue the loadout.
    if (this.runDirty) this.resetRunSystems(false);
    this.runDirty = true;
    runFlow.begin(level.id);
    // Fresh gameplay randomness per run (a reset reseeds the box and the drops as well).
    this.sys.nav.setRandomSeed(this.nextRunSeed());
    if (map.waves) this.sys.waves.start(1);
    this.pauseState.start(lockless || this.padNav.activating);
    void this.maybeRunBenchmark();
  }

  /** Game over "Neu starten" (user gesture): same map, fresh run. */
  restartRun(lockless = false): void {
    this.sys.runFlow.restart();
    this.pauseState.resume(lockless || this.padNav.activating);
  }

  /** Game over "Hauptmenü": abandon the run and show the start screen (map selection). */
  toMainMenu(): void {
    this.sys.runFlow.abandon();
    this.resetRunSystems(false);
    this.pause('menu');
    this.sys.menus.showStart();
  }

  /** RunFlow: the death sequence ended – pause behind the game over screen. */
  showGameOver(summary: Parameters<MenuController['showGameOver']>[0]): void {
    this.pause('menu');
    if (!this.opts.noPointerLock) this.sys.input.exitPointerLock();
    this.sys.menus.showGameOver(summary);
  }

  /**
   * Back to a clean run state on the current map (game/runReset.ts: order and coverage);
   * `startWaves` restarts the wave director (the run goes on: restart). Also the HUD and enemy
   * audio: main menu → start emits no run:restart.
   */
  private resetRunSystems(startWaves = true): void {
    resetRunSystems({ ...this.sys, loop: this.loop }, { seed: this.nextRunSeed(), startWaves });
    this.runDirty = startWaves;
  }

  /** Seed of a new run's gameplay randomness (daily challenge runs pass a fixed one in M8). */
  private nextRunSeed(): string {
    return `run:${this.sys.level.id}:${++this.runSeq}:${Date.now()}`;
  }

  private switchMap(mapId: string): void {
    rememberMap(mapId);
    const url = new URL(location.href);
    url.searchParams.set('map', mapId);
    location.assign(url.toString());
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
    const u = this.sys.player.unlocks;
    this.saveData.profile.unlocks = { doubleJump: u.doubleJump, dash: u.dash };
    void this.sys.persistence.saveNow();
  }

  /** Dev console `resetsave`: wipe storage and continue with defaults (applied live). */
  resetSave(): Promise<void> {
    return this.sys.persistence.reset(this.sys.settings);
  }

  /** True when the current level grants every movement ability regardless of the profile. */
  get movementSandbox(): boolean {
    return this.sys.map.movementSandbox === true;
  }

  /** First-run benchmark: may downgrade the auto-detected preset once. */
  private async maybeRunBenchmark(): Promise<void> {
    if (this.opts.forcePreset || this.benchmarkRunning || this.saveData.profile.qualityBenchmarked) return;
    const current = this.sys.settings.current.graphics.preset;
    if (current === 'custom') return;
    const graphicsBefore = this.sys.settings.current.graphics;
    this.benchmarkRunning = true;
    const recommended: QualityPreset | null = await this.sys.render.quality.runBenchmark(current);
    this.benchmarkRunning = false;
    this.saveData.profile.qualityBenchmarked = true;
    // Sections are replaced on every change: a new object means the player (or the console)
    // changed graphics while it measured – their choice wins over the measurement.
    if (this.sys.settings.current.graphics !== graphicsBefore) {
      log.info('Benchmark result discarded: graphics settings changed during the measurement');
    } else if (recommended && recommended !== current) {
      log.info(`Benchmark: switching graphics preset ${current} → ${recommended}`);
      this.sys.settings.update('graphics', { preset: recommended, ...GRAPHICS_PRESETS[recommended] });
      this.sys.events.emit('quality:presetApplied', { preset: recommended, auto: true });
    }
    void this.sys.persistence.saveNow();
  }

  // -------------------------------------------------------------------------
  // Debug
  // -------------------------------------------------------------------------

  private debugSnapshot(realDt: number): DebugSnapshot {
    const r = this.sys.render.stats;
    const p = this.sys.player;
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
      gpuName: this.sys.render.quality.gpuName,
      preset: this.sys.settings.current.graphics.preset,
      entities: {
        bodies: this.sys.physics.stats.bodies,
        colliders: this.sys.physics.stats.colliders,
        dynamicBodies: this.sys.physics.stats.dynamicBodies,
        meshes: this.sys.level.stats.meshes,
        lights: this.sys.level.stats.lights,
      },
      physicsMs: this.sys.physics.stats.stepMs,
      memoryMb: mem ? mem.usedJSHeapSize / (1024 * 1024) : -1,
      audioVoices: this.sys.audio.stats.activeVoices,
      audioState: this.sys.audio.stats.contextState,
      player: {
        state: p.state,
        speed: Math.hypot(p.velocity.x, p.velocity.z),
        position: [p.position.x, p.position.y, p.position.z],
        velocity: [p.velocity.x, p.velocity.y, p.velocity.z],
        grounded: p.grounded,
        crouched: p.crouched,
      },
      missingAssets: [...this.sys.assets.missing],
      combat: this.debugCombatSnapshot(),
    };
  }

  private debugCombatSnapshot(): DebugCombatSnapshot {
    const { combat, vfx, weapons } = this.sys;
    const rate = this.debugRate;
    const raycasts = combat.stats.raycasts;
    const raycastsPerFrame = rate.frames > 0 ? (raycasts - rate.raycasts) / rate.frames : 0;
    rate.frames = 0;
    rate.raycasts = raycasts;
    const fx = vfx.stats;
    const id = weapons.currentWeaponId;
    const ammo = weapons.ammo;
    return {
      raycastsPerFrame,
      targets: combat.stats.targets,
      staticMeshes: combat.stats.staticMeshes,
      particles: fx.particles,
      particleCapacity: vfx.particles.additiveBuffer.capacity + vfx.particles.alphaBuffer.capacity,
      decals: fx.decals,
      decalCapacity: vfx.decals.capacity,
      flashLights: fx.lights,
      flashLightCapacity: VFX.lights.count,
      casings: vfx.casings.count,
      weapon:
        id === null
          ? null
          : {
              id,
              state: weapons.state,
              spreadDeg: weapons.spreadDegrees,
              mag: ammo?.mag ?? 0,
              magSize: ammo?.magSize ?? 0,
              reserve: ammo?.reserve ?? 0,
            },
    };
  }

  /** Handle for automated smoke tests (window.__RIFTFALL__). */
  createDebugHandle(): Record<string, unknown> {
    return {
      ready: true,
      game: this,
      snapshot: () => {
        const p = this.sys.player;
        return {
          position: [p.position.x, p.position.y, p.position.z],
          velocity: [p.velocity.x, p.velocity.y, p.velocity.z],
          state: p.state,
          grounded: p.grounded,
          fps: this.loop.stats.frameDelta > 0 ? 1 / this.loop.stats.frameDelta : 0,
          drawCalls: this.sys.render.stats.drawCalls,
          triangles: this.sys.render.stats.triangles,
          resolutionScale: this.sys.render.stats.resolutionScale,
          missingAssets: [...this.sys.assets.missing],
        };
      },
      teleport: (x: number, y: number, z: number, yawDeg = 0, pitchDeg = 0) => {
        this.sys.player.teleport({ x, y, z }, THREE.MathUtils.degToRad(yawDeg));
        this.sys.player.pitch = THREE.MathUtils.degToRad(pitchDeg);
      },
      exec: (line: string) => this.sys.devConsole.execute(line),
      setLook: (yawDeg: number, pitchDeg: number) => {
        this.sys.player.yaw = THREE.MathUtils.degToRad(yawDeg);
        this.sys.player.pitch = THREE.MathUtils.degToRad(pitchDeg);
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

/**
 * Compile `scene`'s programs for the post chain's buffers. The world is only ever drawn into the
 * composer's render targets, and three keys programs on the output color space (canvas: sRGB,
 * render target: working space): compiling with no target bound would build canvas variants that
 * are never drawn (like ViewmodelRig.warmupWeapons).
 */
function compileForPostChain(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
  const target = new THREE.WebGLRenderTarget(1, 1);
  const previous = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target);
    renderer.compile(scene, camera);
  } catch (err) {
    log.warn('World shader warm-up failed', err);
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
  }
}

function rememberMap(mapId: string): void {
  try {
    localStorage.setItem(LAST_MAP_KEY, mapId);
  } catch {
    /* storage blocked: the URL parameter carries the choice */
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
