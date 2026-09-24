/**
 * Dev console commands of the fire-kinds engine (register them next to registerDevCommands):
 *   wmod                          mod state of the weapon in hand (tier, attachments, element)
 *   wmod tier <0-3>               Rift Forge tier of the weapon in hand (refills on upgrade)
 *   wmod attach [ids…|none]       attachments (no ids: list the ones that fit)
 *   wmod element <el|none>        elemental mod
 *   arsenal                       projectiles / fields / explosions / specials counters
 * They go through WeaponSystem.setWeaponMods like the forge and the workbench (events included).
 */
import type { ConsoleCommand } from '../../core/contracts';
import type { DamageElement } from '../../core/events';
import { attachmentsFor } from '../../defs/attachments';
import type { Arsenal } from './Arsenal';
import type { WeaponSystem } from '../WeaponSystem';

export interface FireCommandDeps {
  weapons: Pick<WeaponSystem, 'currentWeaponId' | 'currentDef' | 'modsOf' | 'setWeaponMods' | 'effectiveDef'>;
  arsenal: Pick<Arsenal, 'projectiles' | 'fields' | 'explosions' | 'specials'>;
}

const ELEMENTS: readonly DamageElement[] = ['physical', 'fire', 'ice', 'shock', 'poison', 'void'];
const SUBS = ['tier', 'attach', 'element'] as const;

export function createFireCommands(deps: FireCommandDeps): ConsoleCommand[] {
  const { weapons, arsenal } = deps;
  const held = (): string => {
    const id = weapons.currentWeaponId;
    if (!id) throw new Error('Keine Waffe in der Hand');
    return id;
  };
  const describe = (id: string): string => {
    const m = weapons.modsOf(id);
    const name = weapons.effectiveDef(id)?.name ?? id;
    const att = m?.attachments?.length ? m.attachments.join(', ') : '–';
    return `${name}: Stufe ${m?.tier ?? 0}, Aufsätze ${att}, Element ${m?.element ?? '–'}`;
  };
  return [
    {
      name: 'wmod',
      description: 'Rift-Forge-Stufe / Aufsätze / Element der Waffe in der Hand setzen',
      usage: 'wmod [tier <0-3> | attach <ids…|none> | element <element|none>]',
      complete: ([sub = '', arg = '']) => {
        if (sub === 'element') return [...ELEMENTS, 'none'].filter((e) => e.startsWith(arg));
        if (sub === 'attach') {
          const def = weapons.currentDef;
          return def ? attachmentsFor(def).map((a) => a.id).filter((a) => a.startsWith(arg)) : [];
        }
        return SUBS.filter((s) => s.startsWith(sub));
      },
      run: ([sub, ...args]) => {
        const id = held();
        const current = weapons.modsOf(id) ?? {};
        switch (sub) {
          case undefined:
            return describe(id);
          case 'tier': {
            const tier = Number(args[0]);
            if (!Number.isInteger(tier) || tier < 0) throw new Error('Stufe 0–3 erwartet');
            weapons.setWeaponMods(id, { ...current, tier });
            return describe(id);
          }
          case 'attach': {
            if (args.length === 0) {
              const def = weapons.currentDef;
              const fits = def ? attachmentsFor(def).map((a) => `${a.id} (${a.slot})`) : [];
              return fits.length ? `Passend: ${fits.join(', ')}` : 'Keine Aufsätze für diese Waffe';
            }
            const ids = args[0] === 'none' ? [] : args;
            weapons.setWeaponMods(id, { ...current, attachments: ids });
            return describe(id);
          }
          case 'element': {
            const el = args[0];
            if (el === 'none' || el === undefined) {
              weapons.setWeaponMods(id, { ...current, element: null });
              return describe(id);
            }
            if (!ELEMENTS.includes(el as DamageElement)) throw new Error(`Element: ${ELEMENTS.join(', ')}, none`);
            weapons.setWeaponMods(id, { ...current, element: el as DamageElement });
            return describe(id);
          }
          default:
            throw new Error(`Unbekannt: ${sub} – ${SUBS.join(', ')}`);
        }
      },
    },
    {
      name: 'arsenal',
      description: 'Projektile / Felder / Explosionen / Spezialeffekte (Zähler)',
      run: () => {
        const p = arsenal.projectiles.stats;
        const f = arsenal.fields.stats;
        const e = arsenal.explosions.stats;
        const s = arsenal.specials.stats;
        return [
          `Projektile: ${arsenal.projectiles.active}/${arsenal.projectiles.capacity} aktiv, ${p.spawned} gestartet, ${p.detonations} Detonationen, ${p.bounces} Abpraller, ${p.refused} abgewiesen`,
          `Felder: ${arsenal.fields.active}/${arsenal.fields.capacity} aktiv, ${f.spawned} erzeugt, ${f.refused} abgewiesen`,
          `Explosionen: ${e.explosions} (${e.hits} Treffer, ${e.props} Objekte gestoßen)`,
          `Spezial: ${s.procs} Procs, ${s.arcs} Bögen, ${s.explosions} Explosionen, ${s.fields} Felder, ${s.heals} Heilungen`,
        ].join('\n');
      },
    },
  ];
}
