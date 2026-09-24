/**
 * Dev console commands for power-ups and rift seals (register next to registerDevCommands):
 *   powerup                       active timers, pickups, drop counters
 *   powerup list                  every power-up id with its name
 *   powerup <typ> [jetzt]         place a pickup in front of the player (`jetzt`/`now`: apply at once)
 *   powerup clear                 remove pickups, end every timed power-up
 *   seal                          seal status (bars standing / broken)
 *   seal break [all]              break one bar of the nearest seal (`all`: every bar of every seal)
 *   seal repair [all]             restore one bar of the nearest seal, free (`all`: every seal)
 */
import type { ConsoleCommand } from '../core/contracts';
import type { Vec3Like } from '../core/events';
import { POWERUP_IDS, POWERUPS, getPowerUpDef } from '../defs/powerups';
import type { DropState } from './dropRules';

export interface PowerUpCommandDeps {
  powerups: {
    spawn(type: string, position: Vec3Like): number;
    activate(type: string, position?: Vec3Like): boolean;
    clear(): void;
    remaining(type: string): number;
    readonly activeTimed: readonly string[];
    readonly pickupCount: number;
    readonly drops: Readonly<DropState>;
  };
  seals?: {
    readonly seals: readonly { readonly id: string; readonly up: number; readonly segments: number }[];
    readonly brokenSegments: number;
    nearest(p: Vec3Like): { readonly id: string } | null;
    breakSeal(id: string, count?: number): number;
    repair(id: string, count?: number, pay?: boolean): number;
    breakAll(): number;
    repairAll(): number;
  } | null;
  /** Player feet + look yaw (PlayerApi convention: 0 looks down −Z). */
  player: () => { position: Vec3Like; yaw: number };
}

const POWERUP_MODES = ['list', 'clear', ...POWERUP_IDS];
const SEAL_MODES = ['break', 'repair'];
const NOW = ['jetzt', 'now'];

function unknownType(type: string): Error {
  return new Error(`Unbekanntes Power-up "${type}" (${POWERUP_IDS.join(', ')})`);
}

export function createPowerUpCommands(deps: PowerUpCommandDeps): ConsoleCommand[] {
  const powerupStatus = (): string => {
    const p = deps.powerups;
    const timers = p.activeTimed.map(
      (id) => `${getPowerUpDef(id)?.name ?? id} ${p.remaining(id).toFixed(1)} s`,
    );
    const d = p.drops;
    return (
      `Aktiv: ${timers.length > 0 ? timers.join(', ') : '—'}\n` +
      `Pickups: ${p.pickupCount} · Drops diese Welle ${d.dropsThisWave}/${POWERUPS.drops.maxPerWave}, ` +
      `seit dem letzten Drop ${d.killsSinceDrop} Kills / ${d.timeSinceDrop.toFixed(0)} s`
    );
  };

  const place = (type: string, now: boolean): string => {
    const def = getPowerUpDef(type);
    if (!def) throw unknownType(type);
    const { position, yaw } = deps.player();
    if (now) {
      deps.powerups.activate(type, position);
      return `${def.name} ausgelöst`;
    }
    const dist = POWERUPS.consoleDistance;
    const p = { x: position.x - Math.sin(yaw) * dist, y: position.y, z: position.z - Math.cos(yaw) * dist };
    return deps.powerups.spawn(type, p) >= 0 ? `${def.name} erscheint vor dir` : `${def.name}: kein Platz`;
  };

  const sealCommand = (mode: string | undefined, all: boolean): string => {
    const s = deps.seals;
    if (!s || s.seals.length === 0) return 'Keine Riss-Siegel auf dieser Karte';
    if (mode === undefined) {
      const lines = s.seals.map((x) => `${x.id} ${x.up}/${x.segments}`);
      return `Riss-Siegel (${s.brokenSegments} Segmente zerstört):\n${lines.join('\n')}`;
    }
    if (mode !== 'break' && mode !== 'repair') {
      throw new Error(`Unbekannte Option "${mode}" (${SEAL_MODES.join(', ')})`);
    }
    if (all) {
      return mode === 'break'
        ? `${s.breakAll()} Segmente zerstört`
        : `${s.repairAll()} Segmente wiederhergestellt`;
    }
    const seal = s.nearest(deps.player().position);
    if (!seal) return 'Kein Riss-Siegel gefunden';
    const n = mode === 'break' ? s.breakSeal(seal.id, 1) : s.repair(seal.id, 1, false);
    return n > 0
      ? `${seal.id}: ${mode === 'break' ? 'Segment zerstört' : 'Segment repariert'}`
      : `${seal.id}: ${mode === 'break' ? 'bereits offen' : 'bereits intakt'}`;
  };

  return [
    {
      name: 'powerup',
      aliases: ['powerups', 'pu'],
      description: 'Power-ups platzieren / auslösen / Status',
      usage: `powerup [list | clear | <typ> [jetzt]]  (${POWERUP_IDS.join(', ')})`,
      run: ([mode, arg]) => {
        switch (mode) {
          case undefined:
            return powerupStatus();
          case 'list':
            return POWERUP_IDS.map((id) => `${id} – ${getPowerUpDef(id)!.name}`).join('\n');
          case 'clear':
            deps.powerups.clear();
            return 'Power-ups entfernt';
          default:
            return place(mode, arg !== undefined && NOW.includes(arg));
        }
      },
      complete: (args) => {
        if (args.length <= 1) return POWERUP_MODES.filter((m) => m.startsWith(args[0] ?? ''));
        if (args.length === 2 && getPowerUpDef(args[0] ?? ''))
          return NOW.filter((m) => m.startsWith(args[1] ?? ''));
        return [];
      },
    },
    {
      name: 'seal',
      aliases: ['seals'],
      description: 'Riss-Siegel zerstören / reparieren / Status',
      usage: 'seal [break|repair [all]]',
      run: ([mode, all]) => sealCommand(mode, all === 'all'),
      complete: (args) => {
        if (args.length <= 1) return SEAL_MODES.filter((m) => m.startsWith(args[0] ?? ''));
        if (args.length === 2) return ['all'].filter((m) => m.startsWith(args[1] ?? ''));
        return [];
      },
    },
  ];
}
