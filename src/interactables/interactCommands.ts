/**
 * Dev console commands for the interactables (register next to registerDevCommands):
 *   door                 list doors (state, price, zones) and the active zones
 *   door <id>            open a door for free (unique id prefixes work)
 *   door all             open every door
 *   box                  Rift-Kiste status (location, state, uses)
 *   box roll             free roll at the current location
 *   box anomaly          free roll that reveals the Riss-Anomalie (the box moves)
 *   box move             relocate an idle box now
 */
import type { ConsoleCommand, ZoneApi } from '../core/contracts';
import type { Door } from './Door';
import type { MysteryBox } from './MysteryBox';

export interface InteractCommandDeps {
  doors: readonly Pick<Door, 'id' | 'state' | 'price' | 'slot' | 'open'>[];
  box: Pick<
    MysteryBox,
    'state' | 'location' | 'usesHere' | 'moveThreshold' | 'roll' | 'move' | 'offeredWeapon'
  > | null;
  zones?: Pick<ZoneApi, 'active'> | null;
}

const DOOR_STATE: Record<Door['state'], string> = { closed: 'zu', opening: 'öffnet', open: 'offen' };

export function doorList(deps: InteractCommandDeps): string {
  if (deps.doors.length === 0) return 'Keine Türen auf dieser Karte';
  const lines = deps.doors.map(
    (d) => `${d.id}: ${DOOR_STATE[d.state]} · ${d.price} P · ${d.slot.zoneA} ↔ ${d.slot.zoneB}`,
  );
  if (deps.zones) lines.push(`Aktive Zonen: ${deps.zones.active.join(', ') || '–'}`);
  return lines.join('\n');
}

export function boxStatus(deps: InteractCommandDeps): string {
  const b = deps.box;
  if (!b) return 'Keine Rift-Kiste auf dieser Karte';
  const offer = b.offeredWeapon ? ` · Angebot: ${b.offeredWeapon}` : '';
  const uses = `${b.usesHere}/${b.moveThreshold} Nutzungen`;
  return `Rift-Kiste @ ${b.location.id} (${b.location.zone}): ${b.state} · ${uses}${offer}`;
}

export function createInteractCommands(deps: InteractCommandDeps): ConsoleCommand[] {
  const doorIds = (): string[] => deps.doors.map((d) => d.id);
  return [
    {
      name: 'door',
      aliases: ['tuer', 'tür'],
      description: 'Türen: auflisten, kostenlos öffnen',
      usage: 'door [list | all | <id>]',
      run: ([arg]) => {
        if (arg === undefined || arg === 'list') return doorList(deps);
        if (arg === 'all') {
          let n = 0;
          for (const d of deps.doors) if (d.open()) n++;
          return n > 0 ? `${n} Tür(en) geöffnet` : 'Alle Türen sind bereits offen';
        }
        const exact = deps.doors.find((d) => d.id === arg);
        const matches = exact ? [exact] : deps.doors.filter((d) => d.id.startsWith(arg));
        if (matches.length === 0) throw new Error(`Unbekannte Tür "${arg}" (door list)`);
        if (matches.length > 1) throw new Error(`Mehrdeutig: ${matches.map((d) => d.id).join(', ')}`);
        const door = matches[0]!;
        return door.open() ? `${door.id} öffnet` : `${door.id} ist bereits ${DOOR_STATE[door.state]}`;
      },
      complete: ([prefix = '']) => ['list', 'all', ...doorIds()].filter((s) => s.startsWith(prefix)),
    },
    {
      name: 'box',
      aliases: ['kiste'],
      description: 'Rift-Kiste: Status, kostenlos drehen, Anomalie, versetzen',
      usage: 'box [roll | anomaly | move]',
      run: ([sub]) => {
        const b = deps.box;
        if (!b) return 'Keine Rift-Kiste auf dieser Karte';
        if (sub === undefined) return boxStatus(deps);
        if (sub === 'roll' || sub === 'anomaly') {
          if (!b.roll(sub === 'anomaly')) return `Rift-Kiste ist beschäftigt (${b.state})`;
          return sub === 'anomaly' ? 'Rift-Kiste dreht – Anomalie erzwungen' : 'Rift-Kiste dreht';
        }
        if (sub === 'move') {
          if (!b.move()) return `Rift-Kiste kann gerade nicht umziehen (${b.state})`;
          return `Rift-Kiste verlässt ${b.location.id}`;
        }
        throw new Error(`Unbekannter Unterbefehl "${sub}" (roll | anomaly | move)`);
      },
      complete: ([prefix = '']) => ['roll', 'anomaly', 'move'].filter((s) => s.startsWith(prefix)),
    },
  ];
}
