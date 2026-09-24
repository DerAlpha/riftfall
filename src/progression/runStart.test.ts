/**
 * The skill tree's stat modifiers at run start: game/runReset re-applies them right after the stat
 * table's reset – before health and the loadout read the stats.
 */
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { STAT_DEFS } from '../defs/stats';
import { resetRunSystems, type RunResetSystems } from '../game/runReset';
import { StatSystem } from '../stats/StatSystem';
import { createHarness } from './testFakes';

function stubSystems(calls: string[], stats: StatSystem, extra: Partial<RunResetSystems>): RunResetSystems {
  const rec = (name: string) => (): void => {
    calls.push(name);
  };
  return {
    enemies: { clear: rec('enemies'), timeScale: 1, instakill: false },
    waves: { reset: rec('waves.reset'), start: rec('waves.start') },
    vfx: { clear: rec('vfx') },
    powerUps: { clear: rec('powerUps'), reseed: rec('powerUps.reseed') },
    perks: { clear: rec('perks') },
    stats: {
      reset: () => {
        calls.push('stats.reset');
        stats.reset();
      },
    },
    economy: { reset: rec('economy') },
    pointsRules: { reset: rec('pointsRules') },
    health: {
      reset: () => calls.push(`health.reset maxHealth=${stats.value('maxHealth')}`),
    },
    player: { teleport: rec('teleport'), pitch: 0 },
    level: { id: 'lab', spawn: { position: new Vector3(), yaw: 0 } },
    map: { waves: true },
    nav: { setRandomSeed: rec('nav') },
    zones: { reset: rec('zones') },
    interactables: { reset: rec('interactables') },
    interaction: { reset: rec('interaction') },
    seals: null,
    weapons: { setLoadout: rec('setLoadout'), refillAmmo: rec('refill') },
    viewmodel: { setVisible: rec('viewmodel') },
    hud: { resetRun: rec('hud') },
    audioBridge: { resetRun: rec('audio') },
    loop: { timeScale: 1 },
    ...extra,
  };
}

describe('skill modifiers at run start', () => {
  it('are re-applied right after the stat reset, before health and the loadout', () => {
    const h = createHarness();
    const stats = new StatSystem();
    h.system.setLiveStats(stats);
    h.system.setLevel(10);
    h.system.skills.unlock('sur_tough');
    h.system.skills.unlock('sur_tough');
    // A perk of the previous run is on the table too.
    stats.addModifier({ source: 'perk:titan', stat: 'maxHealth', op: 'mul', value: 1.8 });
    const calls: string[] = [];
    resetRunSystems(
      stubSystems(calls, stats, {
        progression: {
          applyRunStart: () => {
            calls.push('progression');
            h.system.applyRunStart();
          },
        },
      }),
      { seed: 's', startWaves: true },
    );
    const i = (name: string): number => calls.findIndex((c) => c.startsWith(name));
    expect(i('progression')).toBe(i('stats.reset') + 1);
    expect(i('progression')).toBeLessThan(i('health.reset'));
    expect(i('progression')).toBeLessThan(i('setLoadout'));
    expect(calls[i('health.reset')]).toBe(`health.reset maxHealth=${STAT_DEFS.maxHealth.base + 10}`);
    expect(stats.hasSource('perk:titan')).toBe(false);
  });

  it('a reset without the hook (tools, older tests) still works', () => {
    const calls: string[] = [];
    const stats = new StatSystem();
    resetRunSystems(stubSystems(calls, stats, {}), { seed: 's', startWaves: false });
    expect(calls).toContain('stats.reset');
    expect(calls).not.toContain('waves.start');
  });
});
