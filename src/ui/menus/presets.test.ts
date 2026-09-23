import { describe, expect, it } from 'vitest';
import { GRAPHICS_PRESETS } from '../../defs/graphics';
import { createDefaultSettings } from '../../save/settingsSchema';
import { individualPatch, presetPatch, resolvePreset } from './presets';

describe('graphics presets', () => {
  it('recognises the default settings as the "high" preset', () => {
    expect(resolvePreset(createDefaultSettings().graphics)).toBe('high');
  });

  it('applies full presets', () => {
    const g = { ...createDefaultSettings().graphics, ...presetPatch('low') };
    expect(g.preset).toBe('low');
    expect(g.shadows).toBe(GRAPHICS_PRESETS.low.shadows);
    expect(resolvePreset(g)).toBe('low');
  });

  it('switches to custom on individual preset-relevant changes and back when values match again', () => {
    const g = createDefaultSettings().graphics;
    const p = individualPatch(g, { shadows: 'low' });
    expect(p).toEqual({ shadows: 'low', preset: 'custom' });
    const changed = { ...g, ...p };
    expect(individualPatch(changed, { shadows: 'high' }).preset).toBe('high');
  });

  it('keeps the preset for user-only fields', () => {
    const g = createDefaultSettings().graphics;
    expect(individualPatch(g, { exposure: 1.3 })).toEqual({ exposure: 1.3 });
    expect(individualPatch(g, { fpsLimit: 144, showFps: true })).toEqual({ fpsLimit: 144, showFps: true });
  });
});
