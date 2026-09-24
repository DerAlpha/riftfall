import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { POWERUPS } from '../defs/powerups';
import { SealSystem } from '../seals/SealSystem';
import { createPowerUpCommands } from './powerupCommands';
import { PowerUpSystem } from './PowerUpSystem';

function setup() {
  const events = new EventBus<GameEvents>();
  const player = { position: new Vector3(0, 0, 0), yaw: 0 };
  const seals = new SealSystem({
    events,
    spawnPoints: [
      { id: 'near', position: new Vector3(0, 0, -6), yaw: 0, zone: 'z', kind: 'rift' },
      { id: 'far', position: new Vector3(40, 0, 0), yaw: 0, zone: 'z', kind: 'vent' },
    ],
  });
  const enemies = { killAll: () => 0, timeScale: 1, instakill: false };
  const powerups = new PowerUpSystem({ events, player, enemies, seals });
  const spawned: GameEvents['powerup:spawned'][] = [];
  events.on('powerup:spawned', (e) => void spawned.push({ ...e, position: { ...e.position } }));
  const [pu, seal] = createPowerUpCommands({ powerups, seals, player: () => player });
  return { powerups, seals, enemies, player, spawned, pu: pu!, seal: seal! };
}

describe('powerup / seal console commands', () => {
  it('powerup: place in front of the player, apply at once, list, status, clear', async () => {
    const t = setup();
    expect(await t.pu.run(['nuke'])).toContain('Riss-Kollaps');
    // yaw 0 looks down −Z.
    expect(t.spawned[0]!.position.z).toBeCloseTo(-POWERUPS.consoleDistance);
    expect(t.powerups.pickupCount).toBe(1);
    expect(await t.pu.run(['slowmo', 'jetzt'])).toContain('ausgelöst');
    expect(t.enemies.timeScale).toBe(0.4);
    expect(await t.pu.run([])).toContain('Zeitdehnung');
    expect(await t.pu.run(['list'])).toContain('doublePoints – Doppelte Punkte');
    expect(await t.pu.run(['clear'])).toBe('Power-ups entfernt');
    expect(t.enemies.timeScale).toBe(1);
    expect(t.powerups.pickupCount).toBe(0);
    expect(() => t.pu.run(['bogus'])).toThrow(/Unbekanntes Power-up/);
    expect(t.pu.complete!(['ma'])).toEqual(['maxAmmo']);
    expect(t.pu.complete!(['nuke', 'j'])).toEqual(['jetzt']);
  });

  it('seal: status, break / repair the nearest one or all', async () => {
    const t = setup();
    expect(await t.seal.run([])).toContain('near 5/5');
    expect(await t.seal.run(['break'])).toBe('seal:near: Segment zerstört');
    expect(t.seals.seal('near')!.up).toBe(4);
    expect(t.seals.seal('far')!.up).toBe(5);
    expect(await t.seal.run(['repair'])).toBe('seal:near: Segment repariert');
    expect(await t.seal.run(['repair'])).toBe('seal:near: bereits intakt');
    expect(await t.seal.run(['break', 'all'])).toBe('10 Segmente zerstört');
    expect(t.seals.brokenSegments).toBe(10);
    expect(await t.seal.run(['repair', 'all'])).toBe('10 Segmente wiederhergestellt');
    expect(() => t.seal.run(['explode'])).toThrow(/Unbekannte Option/);
    expect(t.seal.complete!(['b'])).toEqual(['break']);
    const [, noSeals] = createPowerUpCommands({ powerups: t.powerups, seals: null, player: () => t.player });
    expect(await noSeals!.run(['break'])).toBe('Keine Riss-Siegel auf dieser Karte');
  });
});
