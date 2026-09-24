/**
 * Dev console commands for the run flow (register next to registerDevCommands):
 *   run           status + live statistics
 *   run kill      die now (death sequence → game over screen)
 *   run restart   restart the run (run:restart; not from the start screen – no run to restart)
 */
import type { ConsoleCommand } from '../core/contracts';
import type { RunFlow } from './RunFlow';

export interface RunCommandDeps {
  run: Pick<RunFlow, 'state' | 'mapId' | 'mode' | 'stats' | 'kill' | 'restart'>;
}

const SUBCOMMANDS = ['kill', 'restart'];

export function formatClock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function runStatus(deps: RunCommandDeps): string {
  const r = deps.run;
  const s = r.stats;
  return [
    `Lauf: ${r.state} · Karte ${r.mapId || '—'} · Modus ${r.mode}`,
    `Welle ${s.wave} (${s.wavesCompleted} überstanden) · Zeit ${formatClock(s.timeSurvived)}`,
    `Abschüsse ${s.kills} (Kopf ${s.headshots}, Kern ${s.weakpointKills}) · Präzision ${Math.round(s.accuracy * 100)} % (${s.shotsHit}/${s.shotsFired})`,
    `Schaden ausgeteilt ${Math.round(s.damageDealt)} · erlitten ${Math.round(s.damageTaken)}`,
    `Punkte verdient ${s.pointsEarned} · Wertung ${s.score}`,
  ].join('\n');
}

export function createRunCommands(deps: RunCommandDeps): ConsoleCommand[] {
  return [
    {
      name: 'run',
      aliases: ['lauf'],
      description: 'Lauf: Statistik, sterben (Game Over testen), neu starten',
      usage: 'run [kill | restart]',
      run: ([sub]) => {
        const r = deps.run;
        if (sub === undefined) return runStatus(deps);
        if (sub === 'kill') {
          if (r.state !== 'running') return `Kein laufender Lauf (${r.state})`;
          r.kill();
          return 'Spieler gefallen';
        }
        if (sub === 'restart') {
          // Idle = start screen: a "restart" would begin a map-less run behind it.
          if (r.state === 'idle') return 'Kein Lauf aktiv (Hauptmenü) – Start über das Menü';
          r.restart();
          return 'Lauf neu gestartet';
        }
        throw new Error(`Unbekannt: "${sub}" (kill | restart)`);
      },
      complete: ([prefix = '']) => SUBCOMMANDS.filter((s) => s.startsWith(prefix)),
    },
  ];
}
