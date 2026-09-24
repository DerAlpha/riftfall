import { describe, expect, it } from 'vitest';
import type { ConsoleCommand } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { STAT_DEFS } from '../defs/stats';
import { StatSystem } from '../stats/StatSystem';
import { EconomySystem } from './EconomySystem';
import { createEconomyCommands, formatStat } from './economyCommands';
import { PerkSystem } from './PerkSystem';

function setup() {
  const events = new EventBus<GameEvents>();
  const stats = new StatSystem({ events });
  const economy = new EconomySystem({ events, stats });
  const perks = new PerkSystem({ events, stats });
  const cmds = createEconomyCommands({ economy, perks, stats });
  const cmd = (name: string): ConsoleCommand => cmds.find((c) => c.name === name)!;
  const run = (line: string): string => {
    const [name, ...args] = line.split(' ');
    return String(cmd(name!).run(args) ?? '');
  };
  return { economy, perks, stats, cmd, run };
}

describe('economy console commands', () => {
  it('points: show, give (unscaled), take (clamped at 0)', () => {
    const t = setup();
    expect(t.run('points')).toContain('Punkte: 500');
    t.stats.addModifier({ source: 'x', stat: 'pointsMultiplier', op: 'mul', value: 2 });
    expect(t.run('points 1000')).toBe('+1000 → 1500 Punkte');
    expect(t.run('points -5000')).toBe('-1500 → 0 Punkte');
    expect(() => t.run('points lots')).toThrow();
  });

  it('perk: list, grant, limit, revoke, clear, completion', () => {
    const t = setup();
    expect(t.run('perk list')).toContain('Perks 0/4');
    expect(t.run('perk titan')).toBe('Titanplatte erhalten');
    expect(t.run('perk titan')).toContain('bereits aktiv');
    expect(t.run('perk list')).toContain('■ titan');
    for (const id of ['quickload', 'sprinter', 'holster']) t.run(`perk ${id}`);
    expect(t.run('perk nova')).toContain('Perk-Limit');
    expect(() => t.run('perk nope')).toThrow(/Unbekannter Perk/);
    expect(t.run('perk revoke titan')).toBe('Titanplatte entfernt');
    expect(() => t.run('perk revoke titan')).toThrow();
    expect(t.run('perk clear')).toBe('3 Perks entfernt');
    expect(t.perks.owned).toEqual([]);
    const perk = t.cmd('perk');
    expect(perk.complete!(['ti'])).toEqual(['titan']);
    t.run('perk nova');
    expect(perk.complete!(['revoke', ''])).toEqual(['nova']);
  });

  it('werte: modified stats with value, base and sources (not the render `stats`)', () => {
    const t = setup();
    expect(t.cmd('werte').aliases).toContain('playerstats');
    expect(t.cmd('stats')).toBeUndefined();
    expect(t.run('werte')).toBe('Alle Werte auf Basis');
    t.run('perk doubleimpulse');
    const out = t.run('werte');
    expect(out).toContain('Feuerrate: ×1.33 (Basis ×1) [perk:doubleimpulse ×1.33]');
    expect(out).toContain('Waffenschaden: ×1.25');
    expect(out.split('\n')).toHaveLength(2);
    expect(t.run('werte all').split('\n').length).toBe(Object.keys(STAT_DEFS).length);
    expect(formatStat(STAT_DEFS.regenDelay, 2.7)).toBe('2.7 s');
    expect(formatStat(STAT_DEFS.perkSlots, 5)).toBe('5');
  });
});
