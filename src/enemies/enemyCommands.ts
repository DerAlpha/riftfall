/**
 * Dev console command for enemies (register next to registerDevCommands):
 *   enemy spawn <typ> [anzahl] [distanz]   spawn in front of the player (elite: `enemy elite <typ>`)
 *   enemy elite <typ> [anzahl] [distanz]   same, with an elite affix (rim light, more HP/damage)
 *   enemy kill                              kill all (with credit, like the nuke power-up)
 *   enemy clear                             remove all without effects
 *   enemy freeze                            toggle the AI (frozen enemies still take damage)
 *   enemy stats                             counts per type, AI cost, projectiles
 */
import type { ConsoleCommand, EnemySpawnOptions } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import { ENEMY_AI, enemyTypeIds, getEnemyDef } from '../defs/enemies';
import type { EnemyManagerStats } from './EnemyManager';

export interface EnemyCommandDeps {
  manager: {
    readonly alive: number;
    readonly capacity: number;
    readonly stats: Readonly<EnemyManagerStats>;
    aiEnabled: boolean;
    spawn(type: string, position: Vec3Like, opts?: EnemySpawnOptions): number | null;
    killAll(credit: boolean): number;
    clear(): void;
    readonly projectiles: { readonly stats: Readonly<{ active: number; puddles: number }> } | null;
  };
  /** Player feet + look yaw (PlayerApi convention: 0 looks down −Z). */
  player: () => { position: Vec3Like; yaw: number };
}

const MODES = ['spawn', 'elite', 'kill', 'clear', 'freeze', 'stats'];
/** Console spawn layout: default distance in front of the player, lateral spacing of a group (m). */
export const ENEMY_COMMANDS = {
  defaultDistance: 8,
  spacing: 1.2,
  maxCount: 60,
  eliteAffix: 'debug',
} as const;

function parseCount(v: string | undefined, fallback: number, max: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Ungültige Zahl "${v}"`);
  return Math.min(max, Math.floor(n));
}

export function createEnemyCommands(deps: EnemyCommandDeps): ConsoleCommand[] {
  const spawn = (args: string[], elite: boolean): string => {
    const [type, countArg, distArg] = args;
    if (!type || !getEnemyDef(type))
      throw new Error(`Unbekannter Gegnertyp "${type ?? ''}" (${enemyTypeIds().join(', ')})`);
    const count = parseCount(countArg, 1, ENEMY_COMMANDS.maxCount);
    const dist = distArg === undefined ? ENEMY_COMMANDS.defaultDistance : Number(distArg);
    if (!Number.isFinite(dist)) throw new Error(`Ungültige Distanz "${distArg}"`);
    const { position, yaw } = deps.player();
    // Camera forward (−sin yaw, −cos yaw); lateral (cos yaw, −sin yaw).
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const opts: EnemySpawnOptions = elite ? { affixes: [ENEMY_COMMANDS.eliteAffix] } : {};
    let ok = 0;
    for (let i = 0; i < count; i++) {
      const side = (i - (count - 1) / 2) * ENEMY_COMMANDS.spacing;
      const p = {
        x: position.x + fx * dist - fz * side,
        y: position.y,
        z: position.z + fz * dist + fx * side,
      };
      if (deps.manager.spawn(type, p, opts) !== null) ok++;
    }
    return ok === count
      ? `${ok} × ${getEnemyDef(type)!.name}${elite ? ' (Elite)' : ''} gespawnt`
      : `${ok}/${count} gespawnt (Kapazität ${deps.manager.alive}/${deps.manager.capacity} oder Instanzen erschöpft)`;
  };

  return [
    {
      name: 'enemy',
      aliases: ['enemies'],
      description: 'Gegner spawnen / töten / einfrieren / Statistik',
      usage: 'enemy spawn|elite <typ> [anzahl] [distanz] | kill | clear | freeze | stats',
      run: ([mode, ...rest]) => {
        const m = deps.manager;
        switch (mode) {
          case 'spawn':
            return spawn(rest, false);
          case 'elite':
            return spawn(rest, true);
          case 'kill':
            return `${m.killAll(true)} Gegner getötet`;
          case 'clear':
            m.clear();
            return 'Alle Gegner entfernt';
          case 'freeze':
            m.aiEnabled = !m.aiEnabled;
            return m.aiEnabled ? 'KI läuft' : 'KI eingefroren';
          case undefined:
          case 'stats': {
            const s = m.stats;
            const types = Object.entries(s.byType)
              .map(([k, v]) => `${k} ${v}`)
              .join(', ');
            const p = m.projectiles?.stats;
            return (
              `Gegner: ${s.alive}/${m.capacity} (${types}), Datensätze ${s.records}\n` +
              `KI ${s.aiMs.toFixed(3)} ms (Ø ${s.aiMsAvg.toFixed(3)}), LOS-Strahlen ${s.losRays}/${ENEMY_AI.budget.losPerTick}` +
              (p ? `\nProjektile ${p.active}, Pfützen ${p.puddles}` : '')
            );
          }
          default:
            throw new Error(`Unbekannte Option "${mode}" (${MODES.join(', ')})`);
        }
      },
      complete: (args) => {
        if (args.length <= 1) return MODES.filter((m) => m.startsWith(args[0] ?? ''));
        if (args.length === 2 && (args[0] === 'spawn' || args[0] === 'elite')) {
          return enemyTypeIds().filter((t) => t.startsWith(args[1] ?? ''));
        }
        return [];
      },
    },
  ];
}
