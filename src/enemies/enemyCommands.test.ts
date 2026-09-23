import { describe, expect, it } from 'vitest';
import { createEnemyCommands } from './enemyCommands';
import { createEnemyHarness } from './testFakes';

describe('enemy console command', () => {
  it('spawns in front of the player, kills, freezes, prints stats', async () => {
    const h = createEnemyHarness();
    const [cmd] = createEnemyCommands({
      manager: h.manager,
      player: () => ({ position: h.player.position, yaw: 0 }),
    });
    expect(await cmd!.run(['spawn', 'swarmer', '3', '10'])).toContain('3 × Schwärmer');
    expect(h.manager.alive).toBe(3);
    // yaw 0 looks down −Z.
    for (const e of h.manager.enemies) expect(e.position.z).toBeCloseTo(-10);
    expect(await cmd!.run(['elite', 'tank'])).toContain('Elite');
    expect(h.manager.enemies.some((e) => e.elite && e.pose.rim > 0 && e.pose.scale > 1)).toBe(true);
    expect(await cmd!.run(['stats'])).toContain('Gegner: 4/');
    expect(await cmd!.run(['freeze'])).toBe('KI eingefroren');
    expect(h.manager.aiEnabled).toBe(false);
    expect(await cmd!.run(['kill'])).toBe('4 Gegner getötet');
    expect(() => cmd!.run(['spawn', 'nope'])).toThrow(/Unbekannter Gegnertyp/);
    expect(() => cmd!.run(['bogus'])).toThrow(/Unbekannte Option/);
    expect(cmd!.complete!(['sp'])).toEqual(['spawn']);
    expect(cmd!.complete!(['spawn', 't'])).toEqual(['tank']);
  });
});
