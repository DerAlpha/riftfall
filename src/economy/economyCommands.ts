/**
 * Dev console commands for the economy (register next to registerDevCommands):
 *   points                    balance and run totals
 *   points <n>                give n points ("Punkte geben"; negative takes them, never below 0)
 *   perk list                 every perk (owned ones marked) and the slots in use
 *   perk <id>                 grant a perk for free (respects the perk limit)
 *   perk revoke <id>          remove a perk
 *   perk clear                remove all perks
 *   werte [all]               modified gameplay stats (or every stat) with value, base and sources
 *                             (aliases playerstats / statmods: `stats` is the render statistics)
 */
import type { ConsoleCommand, StatModifier } from '../core/contracts';
import type { PerkDef } from '../defs/perks';
import type { StatDef } from '../defs/stats';
import type { EconomyTotals } from './EconomySystem';

export interface EconomyCommandDeps {
  economy: {
    readonly points: number;
    readonly totals: Readonly<EconomyTotals>;
    readonly multiplier: number;
    adjust(delta: number): number;
  };
  perks: {
    readonly owned: readonly string[];
    readonly maxPerks: number;
    readonly all: readonly string[];
    def(id: string): PerkDef | undefined;
    check(id: string): 'ok' | 'unknown' | 'owned' | 'full';
    grant(id: string): boolean;
    revoke(id: string): void;
    clear(): void;
  };
  stats: {
    readonly ids: readonly string[];
    value(id: string): number;
    def(id: string): StatDef | undefined;
    modified(): string[];
    modifiers(id: string): readonly StatModifier[];
  };
}

const PERK_MODES = ['list', 'clear', 'revoke'];

/** "×1.25", "3", "4.5 s" – a stat value as the readout shows it. */
export function formatStat(def: StatDef, value: number): string {
  const n = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
  if (def.format === 'multiplier') return `×${n}`;
  return def.unit ? `${n} ${def.unit}` : n;
}

function formatModifier(m: StatModifier): string {
  const v = Number.isInteger(m.value) ? String(m.value) : m.value.toFixed(2).replace(/\.?0+$/, '');
  return `${m.source} ${m.op === 'add' ? (m.value >= 0 ? '+' : '') + v : '×' + v}`;
}

export function createEconomyCommands(deps: EconomyCommandDeps): ConsoleCommand[] {
  const { economy, perks, stats } = deps;

  const perkLine = (id: string): string => {
    const d = perks.def(id);
    if (!d) return id;
    const mark = perks.owned.includes(id) ? '■' : '□';
    return `${mark} ${id.padEnd(14)} ${d.name} (${d.price}) – ${d.description}`;
  };

  const statLine = (id: string): string => {
    const d = stats.def(id);
    if (!d) return id;
    const mods = stats.modifiers(id);
    const src = mods.length > 0 ? ` [${mods.map(formatModifier).join(', ')}]` : '';
    return `${d.label}: ${formatStat(d, stats.value(id))} (Basis ${formatStat(d, d.base)})${src}`;
  };

  return [
    {
      name: 'points',
      aliases: ['punkte'],
      description: 'Punkte anzeigen / geben (negativ: abziehen)',
      usage: 'points [n]',
      run: ([arg]) => {
        if (arg === undefined) {
          const t = economy.totals;
          return (
            `Punkte: ${economy.points} (Multiplikator ×${economy.multiplier}) · ` +
            `verdient ${t.earned}, ausgegeben ${t.spent} (${t.purchases} Käufe)`
          );
        }
        const n = Number(arg);
        if (!Number.isFinite(n)) throw new Error(`Ungültige Zahl "${arg}"`);
        const applied = economy.adjust(Math.round(n));
        return `${applied >= 0 ? '+' : ''}${applied} → ${economy.points} Punkte`;
      },
    },
    {
      name: 'perk',
      aliases: ['perks'],
      description: 'Perks: Liste, vergeben, entfernen',
      usage: 'perk list | <id> | revoke <id> | clear',
      run: ([mode, arg]) => {
        if (mode === undefined || mode === 'list') {
          return [
            `Perks ${perks.owned.length}/${perks.maxPerks}: ${perks.owned.join(', ') || '–'}`,
            ...perks.all.map(perkLine),
          ].join('\n');
        }
        if (mode === 'clear') {
          const n = perks.owned.length;
          perks.clear();
          return `${n} Perks entfernt`;
        }
        if (mode === 'revoke') {
          if (!arg || !perks.owned.includes(arg)) throw new Error(`Perk "${arg ?? ''}" nicht aktiv`);
          perks.revoke(arg);
          return `${perks.def(arg)?.name ?? arg} entfernt`;
        }
        switch (perks.check(mode)) {
          case 'unknown':
            throw new Error(`Unbekannter Perk "${mode}" (${perks.all.join(', ')})`);
          case 'owned':
            return `${perks.def(mode)!.name} ist bereits aktiv`;
          case 'full':
            return `Perk-Limit erreicht (${perks.maxPerks}) – erst "perk revoke <id>" oder "perk clear"`;
          case 'ok':
            perks.grant(mode);
            return `${perks.def(mode)!.name} erhalten`;
        }
      },
      complete: (args) => {
        if (args.length <= 1) {
          const p = args[0] ?? '';
          return [...PERK_MODES, ...perks.all].filter((m) => m.startsWith(p));
        }
        if (args.length === 2 && args[0] === 'revoke') {
          return perks.owned.filter((id) => id.startsWith(args[1] ?? ''));
        }
        return [];
      },
    },
    {
      name: 'werte',
      aliases: ['playerstats', 'statmods'],
      description: 'Veränderte Spielwerte (Perks, Buffs) – "werte all" zeigt alle',
      usage: 'werte [all]',
      run: ([mode]) => {
        const ids = mode === 'all' ? stats.ids : stats.modified();
        if (ids.length === 0) return 'Alle Werte auf Basis';
        return ids.map(statLine).join('\n');
      },
      complete: (args) => (args.length <= 1 && 'all'.startsWith(args[0] ?? '') ? ['all'] : []),
    },
  ];
}
