/**
 * Dev console `trap`: list the map's traps (state, time left, kills) and start one for free.
 */
import type { ConsoleCommand } from '../core/contracts';
import type { TrapSystem } from './TrapSystem';

export function createTrapCommands(deps: { traps: TrapSystem }): ConsoleCommand[] {
  const { traps } = deps;
  return [
    {
      name: 'trap',
      description: 'Fallen: auflisten oder kostenlos aktivieren',
      usage: 'trap list | trap activate <id|all>',
      complete: (args) =>
        args.length <= 1
          ? ['list', 'activate']
          : args[0] === 'activate'
            ? ['all', ...traps.list.map((t) => t.id)]
            : [],
      run: (args) => {
        const sub = args[0] ?? 'list';
        if (sub === 'list') {
          if (traps.list.length === 0) return 'Keine Fallen auf dieser Karte.';
          const lines = traps.list.map(
            (t) =>
              `${t.id.padEnd(22)} ${t.kind.padEnd(7)} ${t.state.padEnd(9)} ` +
              `${t.remaining > 0 ? `${t.remaining.toFixed(1)} s` : ''.padEnd(3)} kills ${t.kills} · ${t.price} P`,
          );
          return [...lines, `Fallen-Kills (Lauf): ${traps.kills}`].join('\n');
        }
        if (sub === 'activate') {
          const id = args[1];
          if (!id) throw new Error('Usage: trap activate <id|all>');
          if (id === 'all') {
            const n = traps.list.filter((t) => t.activate()).length;
            return `${n} Falle(n) aktiviert.`;
          }
          const t = traps.get(id);
          if (!t) throw new Error(`Unbekannte Falle "${id}"`);
          if (!t.activate()) return `${id} ist nicht bereit (${t.state}).`;
          return `${id} aktiviert (${t.timer.duration} s).`;
        }
        throw new Error('Usage: trap list | trap activate <id|all>');
      },
    },
  ];
}
