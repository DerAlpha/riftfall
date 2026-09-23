/**
 * Dev console commands for the wave director (register next to registerDevCommands):
 *   wave                 status (wave, state, remaining, plan)
 *   wave <n>             jump to wave n (clears the current enemies)
 *   wave skip            end the intermission now
 *   wave start [n]       (re)start the run at wave n after the first intermission
 *   wave stop            stop spawning
 */
import type { ConsoleCommand } from '../core/contracts';
import type { WaveDirector } from './WaveDirector';

export interface WaveCommandDeps {
  waves: Pick<
    WaveDirector,
    | 'wave'
    | 'state'
    | 'remaining'
    | 'queued'
    | 'nextWave'
    | 'intermissionLeft'
    | 'plan'
    | 'start'
    | 'setWave'
    | 'skipIntermission'
    | 'stop'
  >;
}

const SUBCOMMANDS = ['skip', 'start', 'stop'];

function waveArg(v: string | undefined): number {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n) || n < 1) throw new Error('Welle: Zahl ≥ 1 erwartet');
  return Math.floor(n);
}

export function waveStatus(deps: WaveCommandDeps): string {
  const w = deps.waves;
  if (w.state === 'intermission') {
    return `Pause vor Welle ${w.nextWave}: noch ${w.intermissionLeft.toFixed(1)} s`;
  }
  if (w.state !== 'active') return `Wellen: ${w.state === 'idle' ? 'nicht gestartet' : 'gestoppt'}`;
  const p = w.plan;
  const mix = p.typeIds
    .map((id, i) => (p.counts[i]! > 0 ? `${id}×${p.counts[i]}` : ''))
    .filter((s) => s !== '')
    .join(' ');
  return [
    `Welle ${w.wave} (${p.kind}): ${w.remaining} übrig, ${w.queued} in der Warteschlange`,
    `Mix: ${mix} · max. gleichzeitig ${p.maxAlive}`,
    `Multiplikatoren: Leben ×${p.health.toFixed(2)} Tempo ×${p.speed.toFixed(2)} Schaden ×${p.damage.toFixed(2)}`,
    `Takt: alle ${p.interval.toFixed(2)} s, Gruppen ${p.burstMin}–${p.burstMax}`,
  ].join('\n');
}

export function createWaveCommands(deps: WaveCommandDeps): ConsoleCommand[] {
  return [
    {
      name: 'wave',
      aliases: ['welle'],
      description: 'Wellen: Status, zu Welle n springen, Pause überspringen',
      usage: 'wave [n | skip | start [n] | stop]',
      run: ([sub, arg]) => {
        const w = deps.waves;
        if (sub === undefined) return waveStatus(deps);
        if (sub === 'skip') {
          if (w.state !== 'intermission') return 'Keine Pause aktiv';
          w.skipIntermission();
          return `Welle ${w.wave} gestartet`;
        }
        if (sub === 'stop') {
          w.stop();
          return 'Wellen gestoppt';
        }
        if (sub === 'start') {
          const n = arg === undefined ? 1 : waveArg(arg);
          w.start(n);
          return `Lauf startet mit Welle ${n}`;
        }
        const n = waveArg(sub);
        w.setWave(n);
        return `Welle ${n} gestartet (${w.remaining} Gegner)`;
      },
      complete: ([prefix = '']) => SUBCOMMANDS.filter((s) => s.startsWith(prefix)),
    },
  ];
}
