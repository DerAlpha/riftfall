/**
 * Dev console commands for abilities (register next to registerDevCommands):
 *   ability                       equipped ability, cooldown, running effect
 *   ability list                  every ability with its name, cooldown and duration
 *   ability <id>                  equip it (ready at once)
 *   ability use                   use the equipped ability (respects the cooldown)
 *   ability ready                 clear the cooldown
 *   ability none                  unequip
 */
import type { ConsoleCommand } from '../core/contracts';
import { ABILITY_IDS, getAbilityDef } from '../defs/abilities';

export interface AbilityCommandDeps {
  abilities: {
    readonly equipped: string | null;
    readonly cooldownLeft: number;
    readonly active: boolean;
    readonly activeTimeLeft: number;
    equip(id: string | null): void;
    use(): boolean;
    makeReady(): void;
  };
}

const MODES = ['list', 'use', 'ready', 'none', ...ABILITY_IDS];

export function createAbilityCommands(deps: AbilityCommandDeps): ConsoleCommand[] {
  const a = deps.abilities;
  const status = (): string => {
    const id = a.equipped;
    if (id === null) return 'Keine Fähigkeit ausgerüstet';
    const def = getAbilityDef(id);
    const cd = a.cooldownLeft > 0 ? `Abklingzeit ${a.cooldownLeft.toFixed(1)} s` : 'bereit';
    const running = a.active ? ` · aktiv noch ${a.activeTimeLeft.toFixed(1)} s` : '';
    return `${def?.name ?? id}: ${cd}${running}`;
  };
  return [
    {
      name: 'ability',
      aliases: ['faehigkeit'],
      description: 'Fähigkeiten: Status, ausrüsten, auslösen, Abklingzeit zurücksetzen',
      usage: 'ability [list | <id> | use | ready | none]',
      run(args) {
        const mode = args[0];
        if (mode === undefined) return status();
        switch (mode) {
          case 'list':
            return ABILITY_IDS.map((id) => {
              const def = getAbilityDef(id)!;
              const dur = def.duration > 0 ? `, ${def.duration} s` : '';
              return `${id} – ${def.name} (Abklingzeit ${def.cooldown} s${dur})`;
            }).join('\n');
          case 'use':
            if (a.equipped === null) return 'Keine Fähigkeit ausgerüstet';
            return a.use() ? `${getAbilityDef(a.equipped)?.name ?? a.equipped} ausgelöst` : status();
          case 'ready':
            a.makeReady();
            return status();
          case 'none':
            a.equip(null);
            return status();
        }
        if (!getAbilityDef(mode))
          throw new Error(`Unbekannte Fähigkeit "${mode}" (${ABILITY_IDS.join(', ')})`);
        a.equip(mode);
        a.makeReady();
        return `${getAbilityDef(mode)!.name} ausgerüstet (bereit)`;
      },
      complete: (args) => (args.length <= 1 ? MODES.filter((m) => m.startsWith(args[0] ?? '')) : []),
    },
  ];
}
