import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { VFX } from '../defs/vfx';
import { SettingsStore } from '../save/SettingsStore';
import { createDefaultSettings } from '../save/settingsSchema';
import { FakePhysics, FakeSockets, fakeRender, seeded } from './testFakes';
import { VfxSystem } from './VfxSystem';

function setup(withSockets: boolean): { vfx: VfxSystem; sockets: FakeSockets } {
  const render = fakeRender();
  const sockets = new FakeSockets(render.viewmodelCamera);
  const vfx = new VfxSystem({
    render,
    settings: new SettingsStore(new EventBus<GameEvents>(), createDefaultSettings(), () => undefined),
    physics: new FakePhysics().asApi(),
    sockets: withSockets ? sockets : null,
    random: seeded(3),
  });
  return { vfx, sockets };
}

describe('VfxSystem.muzzleTracer', () => {
  it('starts player tracers at the muzzle as displayed this frame, not the fire-time muzzle', () => {
    const { vfx, sockets } = setup(true);
    const spawn = vi.spyOn(vfx.tracers, 'spawn');
    // Traced in the tick with last frame's camera: a stale muzzle 0.25 m to the side.
    vfx.muzzleTracer({ x: 0, y: 1.4, z: -5 }, 0xffaa00, { x: -0.05, y: 1.4, z: -0.6 });
    expect(spawn).not.toHaveBeenCalled();
    // This frame's camera/viewmodel moved the socket.
    sockets.world.muzzle.set(0.3, 1.38, -0.62);
    vfx.update(1 / 60);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [from, to, color] = spawn.mock.calls[0]!;
    expect({ x: from.x, y: from.y, z: from.z }).toEqual({ x: 0.3, y: 1.38, z: -0.62 });
    expect(to).toEqual({ x: 0, y: 1.4, z: -5 });
    expect(color).toBe(0xffaa00);
    // The queue is consumed; clear() drops anything still queued.
    vfx.update(1 / 60);
    expect(spawn).toHaveBeenCalledTimes(1);
    vfx.muzzleTracer({ x: 0, y: 1.4, z: -5 }, 0xffaa00, { x: 0, y: 1.4, z: -0.6 });
    vfx.clear();
    vfx.update(1 / 60);
    expect(spawn).toHaveBeenCalledTimes(1);
    vfx.dispose();
  });

  it('without sockets spawns at once from the fire-time muzzle; the queue is bounded', () => {
    const { vfx } = setup(false);
    const spawn = vi.spyOn(vfx.tracers, 'spawn');
    vfx.muzzleTracer({ x: 0, y: 1, z: -9 }, 0x123456, { x: 1, y: 1, z: -1 });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![0]).toEqual({ x: 1, y: 1, z: -1 });
    vfx.dispose();

    const withSockets = setup(true).vfx;
    const queued = vi.spyOn(withSockets.tracers, 'spawn');
    for (let i = 0; i < VFX.queue.tracers + 5; i++) {
      withSockets.muzzleTracer({ x: 0, y: 1, z: -9 }, 0x123456, { x: 1, y: 1, z: -1 });
    }
    withSockets.update(1 / 60);
    expect(queued).toHaveBeenCalledTimes(VFX.queue.tracers);
    withSockets.dispose();
  });
});
