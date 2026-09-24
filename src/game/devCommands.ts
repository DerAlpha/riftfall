/**
 * Developer console commands (toggle with ^ / `). Commands for systems that do not exist yet
 * are registered as stubs so the console surface matches the design from day one.
 */
import type {
  DevConsoleApi,
  LevelInstance,
  PhysicsApi,
  PlayerApi,
  RenderApi,
  SettingsStore,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { CAMERA } from '../defs/camera';
import { DEV_COMMANDS } from '../defs/engine';
import { GRAPHICS_PRESETS, PRESET_ORDER } from '../defs/graphics';
import type { PlayerHealth } from '../player/PlayerHealth';
import type { MigrationResult } from '../save/migrations';
import type { QualityPreset } from '../save/settingsSchema';
import { WEAPONS } from '../defs/weapons';

/** What the commands need from the game (Game satisfies it; tests pass stubs). */
export interface DevCommandHost {
  readonly devConsole: Pick<DevConsoleApi, 'register'>;
  readonly player: Pick<
    PlayerApi,
    'godMode' | 'noclip' | 'unlocks' | 'teleport' | 'position' | 'velocity' | 'state'
  >;
  readonly health: Pick<PlayerHealth, 'godMode' | 'damage' | 'heal' | 'reset' | 'dead' | 'health' | 'armor'>;
  readonly level: Pick<LevelInstance, 'spawn'>;
  readonly loop: { timeScale: number };
  readonly settings: SettingsStore;
  readonly events: EventBus<GameEvents>;
  readonly render: { readonly stats: RenderApi['stats']; readonly quality: { readonly gpuName: string } };
  readonly physics: { readonly stats: PhysicsApi['stats'] };
  readonly save: { readonly backendName: string; readonly lastLoad: Readonly<MigrationResult> | null };
  /** The current level unlocks every movement ability regardless of the profile. */
  readonly movementSandbox: boolean;
  persistUnlocks(): void;
  resetSave(): Promise<void>;
  /** M2: weapons + training targets (optional so older test hosts keep working). */
  readonly weapons?: {
    give(id: string): void;
    refillAmmo(fillMagazines?: boolean): void;
    infiniteAmmo: boolean;
    readonly currentWeaponId: string | null;
  };
  readonly targets?: { resetAll(): void } | null;
}

function num(v: string | undefined, name: string): number {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n)) throw new Error(`${name}: Zahl erwartet`);
  return n;
}

function onOff(v: string | undefined, current: boolean): boolean {
  if (v === undefined) return !current;
  if (['1', 'on', 'true', 'an', 'ein'].includes(v.toLowerCase())) return true;
  if (['0', 'off', 'false', 'aus'].includes(v.toLowerCase())) return false;
  throw new Error('on/off erwartet');
}

export function registerDevCommands(game: DevCommandHost): void {
  const c = game.devConsole;
  const p = game.player;
  const hpText = (): string =>
    `HP ${Math.round(game.health.health)} / Rüstung ${Math.round(game.health.armor)}`;

  c.register({
    name: 'god',
    description: 'God Mode umschalten',
    usage: 'god [on|off]',
    run: ([v]) => {
      p.godMode = onOff(v, p.godMode);
      game.health.godMode = p.godMode;
      return `God Mode: ${p.godMode ? 'AN' : 'AUS'}`;
    },
  });
  c.register({
    name: 'noclip',
    description: 'Durch Wände fliegen',
    usage: 'noclip [on|off]',
    run: ([v]) => {
      p.noclip = onOff(v, p.noclip);
      return `Noclip: ${p.noclip ? 'AN' : 'AUS'}`;
    },
  });
  c.register({
    name: 'unlock',
    description: 'Bewegungsfähigkeit freischalten/sperren (wird im Profil gespeichert)',
    usage: 'unlock <doublejump|dash|all> [on|off]',
    complete: () => ['doublejump', 'dash', 'all'],
    run: ([what, v]) => {
      if (!['doublejump', 'dash', 'all'].includes(what ?? '')) throw new Error('unbekannte Fähigkeit');
      const on = v === undefined ? true : onOff(v, true);
      if (what === 'doublejump' || what === 'all') p.unlocks.doubleJump = on;
      if (what === 'dash' || what === 'all') p.unlocks.dash = on;
      game.persistUnlocks();
      const state = `Doppelsprung: ${p.unlocks.doubleJump ? 'AN' : 'AUS'}, Dash: ${p.unlocks.dash ? 'AN' : 'AUS'}`;
      return game.movementSandbox ? `${state} (Kalibrierungshalle: nach Neustart wieder alles frei)` : state;
    },
  });
  c.register({
    name: 'tp',
    aliases: ['teleport'],
    description: 'Teleportieren',
    usage: 'tp <x> <y> <z> | tp spawn',
    run: (args) => {
      if (args[0] === 'spawn') {
        p.teleport(game.level.spawn.position, game.level.spawn.yaw);
        return 'Zum Spawn teleportiert';
      }
      const [x, y, z] = [num(args[0], 'x'), num(args[1], 'y'), num(args[2], 'z')];
      p.teleport({ x, y, z });
      return `Teleportiert nach ${x} ${y} ${z}`;
    },
  });
  c.register({
    name: 'pos',
    description: 'Position und Geschwindigkeit ausgeben',
    run: () => {
      const { x, y, z } = p.position;
      const v = p.velocity;
      return `pos ${x.toFixed(2)} ${y.toFixed(2)} ${z.toFixed(2)} | vel ${v.x.toFixed(2)} ${v.y.toFixed(2)} ${v.z.toFixed(2)} | ${p.state}`;
    },
  });
  c.register({
    name: 'timescale',
    description: 'Simulationsgeschwindigkeit',
    usage: `timescale <${DEV_COMMANDS.timeScaleMin}..${DEV_COMMANDS.timeScaleMax}>`,
    run: ([v]) => {
      game.loop.timeScale = Math.min(
        DEV_COMMANDS.timeScaleMax,
        Math.max(DEV_COMMANDS.timeScaleMin, num(v, 'timescale')),
      );
      return `Timescale ${game.loop.timeScale}`;
    },
  });
  c.register({
    name: 'fov',
    description: 'Sichtfeld (horizontal, 16:9)',
    usage: `fov <${CAMERA.minFov}..${CAMERA.maxFov}>`,
    run: ([v]) => {
      game.settings.update('controls', { fov: num(v, 'fov') });
      return `FOV ${game.settings.current.controls.fov}`;
    },
  });
  c.register({
    name: 'sens',
    description: 'Mausempfindlichkeit',
    usage: 'sens <wert>',
    run: ([v]) => {
      game.settings.update('controls', { mouseSensitivity: num(v, 'sens') });
      return `Empfindlichkeit ${game.settings.current.controls.mouseSensitivity}`;
    },
  });
  c.register({
    name: 'preset',
    aliases: ['quality'],
    description: 'Grafik-Preset setzen',
    usage: `preset <${PRESET_ORDER.join('|')}>`,
    complete: () => [...PRESET_ORDER],
    run: ([v]) => {
      const preset = PRESET_ORDER.find((q): q is QualityPreset => q === v);
      if (!preset) throw new Error(PRESET_ORDER.join('|'));
      game.settings.update('graphics', { preset, ...GRAPHICS_PRESETS[preset] });
      return `Preset ${preset}`;
    },
  });
  c.register({
    name: 'rscale',
    description: 'Render-Skalierung (0.5..1), deaktiviert dynamische Auflösung',
    usage: 'rscale <0.5..1> | rscale auto',
    run: ([v]) => {
      if (v === 'auto') {
        game.settings.update('graphics', { dynamicResolution: true, preset: 'custom' });
        return 'Dynamische Auflösung AN';
      }
      game.settings.update('graphics', {
        renderScale: num(v, 'rscale'),
        dynamicResolution: false,
        preset: 'custom',
      });
      return `Render-Skalierung ${game.settings.current.graphics.renderScale}`;
    },
  });
  c.register({
    name: 'fpslimit',
    description: 'Framerate begrenzen (0 = aus)',
    usage: 'fpslimit <fps>',
    run: ([v]) => {
      game.settings.update('graphics', { fpsLimit: Math.max(0, num(v, 'fps')) });
      return `FPS-Limit ${game.settings.current.graphics.fpsLimit || 'aus'}`;
    },
  });
  c.register({
    name: 'hurt',
    description: 'Dem Spieler Schaden zufügen (Test für Treffer-Effekte)',
    usage: 'hurt [menge]',
    run: ([v]) => {
      game.health.damage(v === undefined ? DEV_COMMANDS.hurtDamage : num(v, 'menge'));
      return hpText();
    },
  });
  c.register({
    name: 'heal',
    aliases: ['revive'],
    description: 'Vollständig heilen (belebt nach dem Tod wieder)',
    run: () => {
      // heal() ignores dead players; reset() revives with start values and re-announces
      // (HUD and low-HP effect update).
      if (game.health.dead) game.health.reset();
      else game.health.heal(Number.POSITIVE_INFINITY);
      return hpText();
    },
  });
  c.register({
    name: 'shake',
    description: 'Screen Shake testen',
    usage: 'shake [trauma 0..1]',
    run: ([v]) => {
      game.events.emit('camera:shake', {
        trauma: v === undefined ? DEV_COMMANDS.shakeTrauma : num(v, 'trauma'),
      });
    },
  });
  c.register({
    name: 'stats',
    description: 'Render-/Physik-/Speicher-Statistik ausgeben',
    run: () => {
      const r = game.render.stats;
      const ph = game.physics.stats;
      const load = game.save.lastLoad;
      const migrated = load?.migratedFrom != null ? `, migriert von v${load.migratedFrom}` : '';
      return [
        `${r.width}x${r.height} @${r.pixelRatio.toFixed(2)} scale ${r.resolutionScale.toFixed(2)}`,
        `draw calls ${r.drawCalls}, tris ${r.triangles}, programs ${r.programs}, textures ${r.textures}`,
        `bodies ${ph.bodies}, colliders ${ph.colliders}, step ${ph.stepMs.toFixed(2)} ms`,
        `GPU: ${game.render.quality.gpuName}`,
        `Speicher: ${game.save.backendName}, Laden: ${load?.status ?? '–'}${migrated}`,
      ].join('\n');
    },
  });
  c.register({
    name: 'resetsave',
    description: 'Spielstand löschen und mit Standardwerten weiterspielen',
    run: async () => {
      await game.resetSave();
      return 'Spielstand gelöscht – Standardeinstellungen aktiv (Neu laden startet die Hardware-Erkennung).';
    },
  });

  // Stubs for later milestones – keeps the console API stable.
  const later = (name: string, usage: string, description: string, milestone: number): void =>
    c.register({
      name,
      usage,
      description,
      run: () => `„${name}“ ist ab Meilenstein ${milestone} verfügbar.`,
    });
  const weapons = game.weapons;
  if (weapons) {
    const ids = Object.keys(WEAPONS);
    c.register({
      name: 'give',
      description: 'Waffe geben',
      usage: `give <${ids.join('|')}>`,
      complete: () => ids,
      run: ([id]) => {
        if (!id || !ids.includes(id)) throw new Error(`unbekannte Waffe – ${ids.join(', ')}`);
        weapons.give(id);
        return `${WEAPONS[id as keyof typeof WEAPONS].name} ausgerüstet`;
      },
    });
    c.register({
      name: 'ammo',
      description: 'Munition auffüllen (inkl. Magazine)',
      run: () => {
        weapons.refillAmmo(true);
        return 'Munition aufgefüllt';
      },
    });
    c.register({
      name: 'infammo',
      description: 'Unendlich Munition umschalten',
      usage: 'infammo [on|off]',
      run: ([v]) => {
        weapons.infiniteAmmo = onOff(v, weapons.infiniteAmmo);
        return `Unendlich Munition: ${weapons.infiniteAmmo ? 'AN' : 'AUS'}`;
      },
    });
  } else {
    later('give', 'give <waffe>', 'Waffe geben', 2);
  }
  const targets = game.targets;
  if (targets) {
    c.register({
      name: 'targets',
      description: 'Trainingsziele zurücksetzen',
      run: () => {
        targets.resetAll();
        return 'Trainingsziele zurückgesetzt';
      },
    });
  }
}
