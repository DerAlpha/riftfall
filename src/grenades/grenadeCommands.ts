/**
 * Dev console commands for grenades (register next to registerDevCommands):
 *   grenade                       selected type and counts of every carried type
 *   grenade list                  every grenade type with its name and max
 *   grenade <typ> [n]             add n grenades (default: fill up) and select the type
 *   grenade throw [lob|voll]      throw the selected grenade now (lob = a tap, voll = full strength)
 *   grenade refill                every carried type to its max (like Max Munition)
 */
import type { ConsoleCommand } from '../core/contracts';
import { GRENADE_IDS, getGrenadeDef } from '../defs/grenades';

export interface GrenadeCommandDeps {
  grenades: {
    readonly selected: string;
    readonly carriedTypes: readonly string[];
    count(id: string): number;
    max(id: string): number;
    add(id: string, n: number): number;
    select(id: string): void;
    refill(): void;
    throwNow(strength?: number): boolean;
  };
}

const MODES = ['list', 'throw', 'refill', ...GRENADE_IDS];
const LOB = ['lob', 'tap'];

export function createGrenadeCommands(deps: GrenadeCommandDeps): ConsoleCommand[] {
  const g = deps.grenades;
  const status = (): string => {
    const lines = g.carriedTypes.map((id) => {
      const def = getGrenadeDef(id);
      const mark = id === g.selected ? '▶ ' : '  ';
      return `${mark}${def?.name ?? id}: ${g.count(id)}/${g.max(id)}`;
    });
    return lines.length > 0 ? lines.join('\n') : 'Keine Granaten';
  };
  return [
    {
      name: 'grenade',
      aliases: ['granate'],
      description: 'Granaten: Status, auffüllen, Typ wählen, werfen',
      usage: 'grenade [list | <typ> [n] | throw [lob|voll] | refill]',
      run(args) {
        const mode = args[0];
        if (mode === undefined) return status();
        if (mode === 'list') {
          return GRENADE_IDS.map((id) => {
            const def = getGrenadeDef(id)!;
            return `${id} – ${def.name} (max ${def.max})`;
          }).join('\n');
        }
        if (mode === 'refill') {
          g.refill();
          return status();
        }
        if (mode === 'throw') {
          const strength = LOB.includes(args[1] ?? '') ? 0 : 1;
          const def = getGrenadeDef(g.selected);
          return g.throwNow(strength)
            ? `${def?.name ?? g.selected} geworfen (${g.count(g.selected)} übrig)`
            : 'Keine Granate zum Werfen';
        }
        const def = getGrenadeDef(mode);
        if (!def) throw new Error(`Unbekannte Granate "${mode}" (${GRENADE_IDS.join(', ')})`);
        const n = args[1] !== undefined ? Number(args[1]) : def.max;
        if (!Number.isFinite(n) || n < 0) throw new Error(`Ungültige Anzahl "${args[1]}"`);
        g.select(mode);
        g.add(mode, Math.floor(n));
        return `${def.name}: ${g.count(mode)}/${def.max} (ausgewählt)`;
      },
      complete: (args) => (args.length <= 1 ? MODES.filter((m) => m.startsWith(args[0] ?? '')) : []),
    },
  ];
}
