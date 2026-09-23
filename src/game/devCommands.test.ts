import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { ConsoleCommand } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { DEV_COMMANDS } from '../defs/engine';
import { GRAPHICS_PRESETS, PRESET_ORDER } from '../defs/graphics';
import { PLAYER } from '../defs/player';
import { PlayerHealth } from '../player/PlayerHealth';
import { SettingsStore } from '../save/SettingsStore';
import { createDefaultSettings } from '../save/settingsSchema';
import { registerDevCommands, type DevCommandHost } from './devCommands';

function makeHost() {
  const commands = new Map<string, ConsoleCommand>();
  const events = new EventBus<GameEvents>();
  const settings = new SettingsStore(events, createDefaultSettings(), () => {}, 60_000);
  const health = new PlayerHealth(events);
  const player = {
    godMode: false,
    noclip: false,
    unlocks: { doubleJump: true, dash: true },
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    state: 'ground' as const,
    teleport: vi.fn(),
  };
  const host = {
    devConsole: {
      register: (cmd: ConsoleCommand) => {
        commands.set(cmd.name, cmd);
        for (const a of cmd.aliases ?? []) commands.set(a, cmd);
      },
    },
    player,
    health,
    level: { spawn: { position: new THREE.Vector3(1, 0, 2), yaw: 0.5 } },
    loop: { timeScale: 1 },
    settings,
    events,
    render: {
      stats: {
        drawCalls: 1,
        triangles: 2,
        points: 0,
        lines: 0,
        geometries: 0,
        textures: 0,
        programs: 0,
        width: 640,
        height: 360,
        pixelRatio: 1,
        resolutionScale: 1,
        gpuMs: -1,
      },
      quality: { gpuName: 'test-gpu' },
    },
    physics: { stats: { bodies: 0, colliders: 0, dynamicBodies: 0, stepMs: 0 } },
    save: { backendName: 'memory', lastLoad: null },
    movementSandbox: false,
    persistUnlocks: vi.fn(),
    resetSave: vi.fn(() => Promise.resolve()),
  } satisfies DevCommandHost;
  registerDevCommands(host);
  const run = async (line: string): Promise<string | void> => {
    const [name, ...args] = line.split(' ');
    const cmd = commands.get(name!);
    if (!cmd) throw new Error(`unknown ${name}`);
    return cmd.run(args);
  };
  return { host, run, events, settings, health };
}

describe('dev console commands', () => {
  let h: ReturnType<typeof makeHost>;
  beforeEach(() => {
    h = makeHost();
  });

  it('heal revives a dead player and reports real HP (low-HP effect clears)', async () => {
    const changes: number[] = [];
    h.events.on('player:healthChanged', ({ health }) => changes.push(health));
    await h.run('hurt 200');
    expect(h.health.dead).toBe(true);
    const out = await h.run('heal');
    expect(h.health.dead).toBe(false);
    expect(h.health.health).toBe(PLAYER.health.startHealth);
    expect(out).toBe(`HP ${PLAYER.health.startHealth} / Rüstung ${PLAYER.health.startArmor}`);
    expect(changes.at(-1)).toBe(PLAYER.health.startHealth);
    // Alive: heal tops up.
    await h.run('hurt');
    expect(h.health.health).toBeLessThan(PLAYER.health.maxHealth);
    await h.run('heal');
    expect(h.health.health).toBe(PLAYER.health.maxHealth);
  });

  it('hurt and shake use the defs defaults', async () => {
    const trauma: number[] = [];
    h.events.on('camera:shake', (e) => trauma.push(e.trauma));
    await h.run('shake');
    expect(trauma).toEqual([DEV_COMMANDS.shakeTrauma]);
    const before = h.health.health + h.health.armor;
    await h.run('hurt');
    expect(before - (h.health.health + h.health.armor)).toBeCloseTo(DEV_COMMANDS.hurtDamage, 6);
  });

  it('resetsave goes through the game reset (in-place wipe, not just storage)', async () => {
    const out = await h.run('resetsave');
    expect(h.host.resetSave).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/gelöscht/);
  });

  it('unlock changes the player and persists the profile; unknown abilities change nothing', async () => {
    await h.run('unlock dash off');
    expect(h.host.player.unlocks).toEqual({ doubleJump: true, dash: false });
    expect(h.host.persistUnlocks).toHaveBeenCalledTimes(1);
    await expect(h.run('unlock jetpack off')).rejects.toThrow();
    expect(h.host.player.unlocks).toEqual({ doubleJump: true, dash: false });
    expect(h.host.persistUnlocks).toHaveBeenCalledTimes(1);
  });

  it('preset accepts every preset of PRESET_ORDER and rejects others', async () => {
    for (const p of PRESET_ORDER) {
      await h.run(`preset ${p}`);
      expect(h.settings.current.graphics.preset).toBe(p);
      expect(h.settings.current.graphics.shadows).toBe(GRAPHICS_PRESETS[p].shadows);
    }
    await expect(h.run('preset extreme')).rejects.toThrow();
  });

  it('rscale disables dynamic resolution and switches to custom; timescale is clamped', async () => {
    await h.run('rscale 0.6');
    expect(h.settings.current.graphics.dynamicResolution).toBe(false);
    expect(h.settings.current.graphics.preset).toBe('custom');
    await h.run('rscale auto');
    expect(h.settings.current.graphics.dynamicResolution).toBe(true);
    await h.run('timescale 100');
    expect(h.host.loop.timeScale).toBe(DEV_COMMANDS.timeScaleMax);
    await h.run('timescale 0');
    expect(h.host.loop.timeScale).toBe(DEV_COMMANDS.timeScaleMin);
  });

  it('tp spawn uses the level spawn; stats include the save backend', async () => {
    await h.run('tp spawn');
    expect(h.host.player.teleport).toHaveBeenCalledWith(h.host.level.spawn.position, 0.5);
    const stats = await h.run('stats');
    expect(stats).toContain('Speicher: memory');
  });
});
