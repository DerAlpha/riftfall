/**
 * Dev console command for status effects (register next to registerDevCommands):
 *   status                               slots, statuses per kind, trigger / combo counters
 *   status <element> [menge] [radius]    build up <element> on every enemy within radius (m) of
 *                                        the player (default: one trigger's worth, 30 m)
 *   status clear                         remove every status (no effects)
 */
import type { ConsoleCommand, Damageable } from '../../core/contracts';
import type { DamageElement, Vec3Like } from '../../core/events';
import { ELEMENTS, STATUS_ELEMENTS, STATUS_IDS, STATUS_NAMES, type StatusElement } from '../../defs/elements';
import type { StatusEffectSystem } from './StatusEffectSystem';

export interface StatusCommandDeps {
  status: Pick<StatusEffectSystem, 'applyElement' | 'reset' | 'has' | 'stacksOf' | 'stats' | 'slots' | 'capacity'>;
  combat: { readonly targets: readonly Damageable[] };
  /** Player feet position. */
  player: () => Vec3Like;
}

/** Default reach of `status <element>` (m). */
export const STATUS_COMMANDS = { defaultRadius: 30 } as const;

export function createStatusCommands(deps: StatusCommandDeps): ConsoleCommand[] {
  const { status, combat } = deps;
  const overview = (): string => {
    const counts = STATUS_IDS.map((id) => {
      let n = 0;
      for (const t of combat.targets) if (t.alive && status.has(t.id, id)) n++;
      return `${STATUS_NAMES[id]} ${n}`;
    });
    const s = status.stats;
    return (
      `Status-Slots ${status.slots}/${status.capacity}: ${counts.join(', ')}\n` +
      `Auslöser ${s.triggers}, Kombos ${s.combos}, Zersplittert ${s.shatters}, Implosionen ${s.implosions}, ` +
      `Giftwolken ${s.clouds}, DoT-Ticks ${s.dotTicks}, Bögen ${s.arcs}, abgewiesen ${s.refused}`
    );
  };
  return [
    {
      name: 'status',
      description: 'Statuseffekte: Übersicht / Element auf Gegner in der Nähe aufbauen / entfernen',
      usage: `status [${STATUS_ELEMENTS.join('|')} [menge] [radius] | clear]`,
      complete: ([arg = '']) => [...STATUS_ELEMENTS, 'clear'].filter((e) => e.startsWith(arg)),
      run: ([arg, amountArg, radiusArg]) => {
        if (arg === undefined) return overview();
        if (arg === 'clear') {
          status.reset();
          return 'Alle Statuseffekte entfernt';
        }
        if (!(STATUS_ELEMENTS as readonly string[]).includes(arg)) {
          throw new Error(`Unbekanntes Element "${arg}" (${STATUS_ELEMENTS.join(', ')}, clear)`);
        }
        const element = arg as StatusElement;
        const amount = amountArg === undefined ? ELEMENTS.buildup.threshold[element] : Number(amountArg);
        const radius = radiusArg === undefined ? STATUS_COMMANDS.defaultRadius : Number(radiusArg);
        if (!(amount > 0) || !Number.isFinite(amount)) throw new Error(`Ungültige Menge "${amountArg}"`);
        if (!(radius > 0) || !Number.isFinite(radius)) throw new Error(`Ungültiger Radius "${radiusArg}"`);
        const p = deps.player();
        let n = 0;
        for (const t of combat.targets) {
          if (!t.alive || t.team !== ELEMENTS.team) continue;
          const dx = t.boundsCenter.x - p.x;
          const dz = t.boundsCenter.z - p.z;
          if (dx * dx + dz * dz > radius * radius) continue;
          status.applyElement(t, element as DamageElement, amount, 'player', 'dev');
          n++;
        }
        return `${element}: ${amount} Aufbau auf ${n} Ziel(e)`;
      },
    },
  ];
}
