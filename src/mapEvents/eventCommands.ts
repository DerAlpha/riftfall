/**
 * Dev console `event`: list the map's events (trigger, running / scheduled), start one now, stop
 * every running event (the power comes back).
 */
import type { ConsoleCommand } from '../core/contracts';
import type { MapEventDirector } from './MapEventDirector';

export function createEventCommands(deps: { director: MapEventDirector }): ConsoleCommand[] {
  const { director } = deps;
  return [
    {
      name: 'event',
      description: 'Karten-Events: auflisten, auslösen, beenden',
      usage: 'event list | event trigger <id> | event stop',
      complete: (args) =>
        args.length <= 1 ? ['list', 'trigger', 'stop'] : args[0] === 'trigger' ? director.list.map((d) => d.id) : [],
      run: (args) => {
        const sub = args[0] ?? 'list';
        if (sub === 'list') {
          if (director.list.length === 0) return 'Keine Events auf dieser Karte.';
          const pending = director.pendingInfo;
          const lines = director.list.map((d) => {
            const t = d.trigger;
            const when = [
              `ab Welle ${t.minWave}`,
              t.chance > 0 ? `${Math.round(t.chance * 100)} %` : null,
              t.waves ? `fest: ${t.waves.join(',')}` : null,
              t.questStep ? `Quest: ${t.questStep}` : null,
            ]
              .filter((x) => x !== null)
              .join(', ');
            const state = director.active.includes(d.id)
              ? 'LÄUFT'
              : pending?.id === d.id
                ? `in ${pending.left.toFixed(1)} s`
                : '';
            return `${d.id.padEnd(16)} ${d.kind.padEnd(15)} ${when} ${state}`;
          });
          return lines.join('\n');
        }
        if (sub === 'trigger') {
          const id = args[1];
          if (!id) throw new Error('Usage: event trigger <id>');
          if (!director.list.some((d) => d.id === id)) throw new Error(`Unbekanntes Event "${id}"`);
          return director.trigger(id) ? `${id} gestartet.` : `${id} kann gerade nicht starten.`;
        }
        if (sub === 'stop') {
          const n = director.active.length;
          director.stop();
          return `${n} Event(s) beendet.`;
        }
        throw new Error('Usage: event list | event trigger <id> | event stop');
      },
    },
  ];
}
