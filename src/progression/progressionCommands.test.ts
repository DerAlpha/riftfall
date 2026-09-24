import { describe, expect, it } from 'vitest';
import type { ConsoleCommand } from '../core/contracts';
import { PROGRESSION } from '../defs/progression';
import { createProgressionCommands } from './progressionCommands';
import { beginLabRun, createHarness, killEnemy, runOver } from './testFakes';

function setup() {
  const h = createHarness();
  const cmds = new Map<string, ConsoleCommand>();
  for (const c of createProgressionCommands({ progression: h.system, mapId: () => 'lab' }))
    cmds.set(c.name, c);
  const run = async (line: string): Promise<string> => {
    const [name, ...args] = line.split(' ');
    return String((await cmds.get(name!)!.run(args)) ?? '');
  };
  return { h, cmds, run };
}

describe('progression console commands', () => {
  it('registers every required command', () => {
    const { cmds } = setup();
    for (const n of [
      'xp',
      'level',
      'prestige',
      'achievement',
      'challenge',
      'skill',
      'profile',
      'leaderboard',
      'weaponlevel',
    ]) {
      expect(cmds.has(n), n).toBe(true);
    }
  });

  it('xp / level / prestige', async () => {
    const { h, run } = setup();
    expect(await run('xp')).toContain('Stufe 1');
    expect(await run('xp 5000')).toContain('+5.000 XP');
    expect(h.system.level).toBeGreaterThan(1);
    expect(await run('prestige')).toContain(`Stufe ${PROGRESSION.maxLevel}`);
    await run(`level ${PROGRESSION.maxLevel}`);
    expect(await run('prestige')).toContain('Prestige 1');
    await expect(run('level abc')).rejects.toThrow();
  });

  it('achievement list / unlock', async () => {
    const { h, run } = setup();
    expect(await run('achievement list erstes')).toContain('first_blood');
    expect(await run('achievement unlock first_blood')).toContain('first_blood');
    expect(h.system.achievementTracker.isUnlocked('first_blood')).toBe(true);
    await expect(run('achievement unlock first_blood')).rejects.toThrow();
  });

  it('challenge list / complete', async () => {
    const { h, run } = setup();
    const list = await run('challenge list');
    expect(list.split('\n')).toHaveLength(6);
    expect(await run('challenge complete 0')).toContain('Abgeschlossen');
    expect(h.profile.challenges.completedDaily).toBe(1);
    await expect(run('challenge complete 0')).rejects.toThrow();
  });

  it('skill list / unlock / reset / loadout', async () => {
    const { h, run } = setup();
    await run('level 20');
    expect(await run('skill unlock tac_dash')).toContain('tac_dash');
    expect(h.system.skills.rank('tac_dash')).toBe(1);
    await expect(run('skill unlock off_deadeye')).rejects.toThrow(/locked|tier/);
    expect(await run('skill list tactics')).toContain('Rift-Dash');
    await expect(run('skill loadout grenade brand')).rejects.toThrow();
    expect(await run('skill loadout ability schockwelle')).toContain('schockwelle');
    expect(await run('skill reset')).toContain('19 Punkte');
  });

  it('profile, leaderboard and weapon level', async () => {
    const { h, run } = setup();
    beginLabRun(h.system);
    killEnemy(h.events, { weaponId: 'smg' });
    runOver(h.events, { wave: 6, score: 1234 });
    expect(await run('profile')).toContain('Lieblingswaffe: smg');
    expect(await run('leaderboard')).toContain('Welle 6');
    expect(await run('weaponlevel smg 8')).toContain('camo.digital');
    await expect(run('weaponlevel nope 3')).rejects.toThrow();
  });
});
