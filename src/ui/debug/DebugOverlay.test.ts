// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { DebugOverlay, type DebugSnapshot } from './DebugOverlay';

function snapshot(): DebugSnapshot {
  return {
    fps: 60,
    frameMs: 16.7,
    ticksPerFrame: 1,
    droppedTicks: 0,
    drawCalls: 123,
    triangles: 456789,
    points: 0,
    lines: 0,
    geometries: 12,
    textures: 8,
    programs: 20,
    width: 1920,
    height: 1080,
    pixelRatio: 1,
    resolutionScale: 0.9,
    gpuMs: -1,
    gpuName: 'Test GPU',
    preset: 'high',
    entities: { bodies: 3, colliders: 40, dynamicBodies: 2, meshes: 30, lights: 4 },
    physicsMs: 0.4,
    memoryMb: -1,
    audioVoices: 2,
    audioState: 'running',
    player: {
      state: 'ground',
      speed: 6.6,
      position: [1, 2, 3],
      velocity: [0, 0, -6.6],
      grounded: true,
      crouched: false,
    },
    missingAssets: ['hdri.industrial'],
  };
}

describe('DebugOverlay', () => {
  let root: HTMLElement;
  let events: EventBus<GameEvents>;
  let overlay: DebugOverlay;

  beforeEach(() => {
    // jsdom has no 2D canvas; the overlay degrades to text only.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    root = document.createElement('div');
    events = new EventBus<GameEvents>();
    overlay = new DebugOverlay(root, events);
  });

  afterEach(() => {
    overlay.dispose();
    vi.restoreAllMocks();
  });

  it('toggles with F3, prevents the browser default and emits ui:debugOverlay', () => {
    const seen: boolean[] = [];
    events.on('ui:debugOverlay', ({ visible }) => seen.push(visible));
    const e = new KeyboardEvent('keydown', { code: 'F3', bubbles: true, cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(overlay.visible).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'F3', bubbles: true }));
    expect(overlay.visible).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('does no work while hidden and throttles the text refresh', () => {
    const provider = vi.fn(snapshot);
    overlay.update(1 / 60, provider);
    expect(provider).not.toHaveBeenCalled();

    overlay.setVisible(true);
    overlay.update(1 / 60, provider);
    expect(provider).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) overlay.update(1 / 60, provider);
    expect(provider).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++) overlay.update(1 / 60, provider);
    expect(provider).toHaveBeenCalledTimes(2);

    const text = root.querySelector('.debug-overlay__text')!.textContent!;
    expect(text).toContain('Draw Calls 123');
    expect(text).toContain('Dreiecke 456.8k');
    expect(text).toContain('Test GPU');
    expect(text).toContain('Fehlende Assets (1): hdri.industrial');
    expect(text).toContain('Pos 1.00 2.00 3.00');
  });

  it('survives a throwing snapshot provider', () => {
    overlay.setVisible(true);
    expect(() =>
      overlay.update(1 / 60, () => {
        throw new Error('kaputt');
      }),
    ).not.toThrow();
    expect(root.querySelector('.debug-overlay__text')!.textContent).toContain('kaputt');
  });
});
