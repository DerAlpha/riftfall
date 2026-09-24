/**
 * A new run on the current map ("Neu starten", `run restart`, "Hauptmenü" → start): every run
 * system back to its start state – nothing of the previous run survives (Game.resetRunSystems).
 *
 * The order is binding:
 * 1. enemies (no AI tick, breach or blow reaches into the reset), the wave director, VFX, the
 *    arsenal (M5: projectiles, fields, arc flashes – no detonation or collapse);
 * 2. timed power-ups before the perks before the stat table: each removes its own stat sources
 *    (the power-ups also end their enemy effects: Zeitdehnung's time scale, Instakill), then the
 *    table drops whatever is left – health resets after it (start health at the base max health,
 *    no perk bonus, revives unused; the economy audio stays silent after a death until that
 *    health reset, so the cleared perks and power-ups play no loss / expiry sounds);
 * 3. economy (announces the start balance), points rules (repair cap, console-spawn flags);
 * 4. player at the spawn, looking level; zones before the interactables (closed doors re-block
 *    their navmesh areas), the interaction focus after them, seals intact;
 * 5. per-run seeds (navmesh samples, Rift-Kiste, power-up drops), loadout after the stat table
 *    (magazine sizes), the HUD after the economy announced its balance, the audio bridge;
 * 6. the wave director starts last: its intermission shows on the fresh HUD.
 * RunFlow resets its own statistics (begin / restart) and the loop time scale on its own too.
 */
import type { LevelInstance, PlayerApi } from '../core/contracts';
import { getLoadout } from '../defs/weapons';

/** What a run reset touches (structural: Game passes its GameSystems + the loop). */
export interface RunResetSystems {
  enemies: { clear(): void; timeScale: number; instakill: boolean };
  waves: { reset(): void; start(wave?: number): void };
  vfx: { clear(): void };
  /** M5 fire kinds (weapons/fire Arsenal); optional for tools and tests. */
  arsenal?: { clear(): void } | null;
  powerUps: { clear(): void; reseed(seed: string | number): void };
  perks: { clear(): void };
  stats: { reset(): void };
  economy: { reset(): void };
  pointsRules: { reset(): void };
  health: { reset(): void };
  player: Pick<PlayerApi, 'teleport' | 'pitch'>;
  level: Pick<LevelInstance, 'id' | 'spawn'>;
  map: { readonly waves: boolean };
  nav: { setRandomSeed(seed: string | number): void };
  zones: { reset(): void };
  interactables: { reset(seed?: string | number): void };
  interaction: { reset(): void };
  seals: { reset(): void } | null;
  weapons: {
    setLoadout(ids: readonly string[], slots?: number): void;
    refillAmmo(fillMagazines?: boolean): void;
  };
  viewmodel: { setVisible(visible: boolean): void };
  hud: { resetRun(): void };
  audioBridge: { resetRun(): void };
  loop: { timeScale: number };
}

export interface RunResetOptions {
  /** Seed of the new run's gameplay randomness (M8 daily challenge runs pass a fixed one). */
  seed: string;
  /** Start the wave director (restart: the run goes on); false for the main menu. */
  startWaves: boolean;
}

export function resetRunSystems(s: RunResetSystems, opts: RunResetOptions): void {
  s.enemies.clear();
  s.waves.reset();
  s.vfx.clear();
  s.arsenal?.clear();
  s.powerUps.clear();
  s.perks.clear();
  s.stats.reset();
  // powerUps.clear() ended Zeitdehnung / Instakill; a value left behind any other way (console,
  // a later effect) must not slow or one-shot the next run's enemies.
  s.enemies.timeScale = 1;
  s.enemies.instakill = false;
  s.economy.reset();
  s.pointsRules.reset();
  s.health.reset();
  s.player.teleport(s.level.spawn.position, s.level.spawn.yaw);
  s.player.pitch = 0;
  s.zones.reset();
  s.interactables.reset(`box:${opts.seed}`);
  s.interaction.reset();
  s.seals?.reset();
  s.nav.setRandomSeed(opts.seed);
  s.powerUps.reseed(`powerups:${opts.seed}`);
  const loadout = getLoadout(s.level.id);
  s.weapons.setLoadout(loadout.weapons, loadout.slots);
  s.weapons.refillAmmo(true);
  s.viewmodel.setVisible(true);
  s.hud.resetRun();
  s.audioBridge.resetRun();
  s.loop.timeScale = 1;
  if (opts.startWaves && s.map.waves) s.waves.start(1);
}
