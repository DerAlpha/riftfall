import { describe, expect, it } from 'vitest';
import { ENGINE } from '../defs/engine';
import { GRAPHICS_PRESETS, PRESET_ORDER, QUALITY_LEVELS, RENDER } from '../defs/graphics';
import { MATERIALS, type MaterialDef } from '../defs/materials';
import { POSTFX } from '../defs/postfx';

/** Rec. 709 luminance, as used by postprocessing's luminance (bloom threshold) shader. */
function luminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

describe('graphics presets', () => {
  it('leave the user-only target frame rate and dynamic resolution alone', () => {
    for (const p of PRESET_ORDER) {
      const keys = Object.keys(GRAPHICS_PRESETS[p]);
      expect(keys).not.toContain('targetFps');
      expect(keys).not.toContain('dynamicResolution');
    }
  });
});

describe('shadow quality levels', () => {
  it('keep the PCF radius within what three’s fixed 5-tap kernel resolves (≤ 2 texels)', () => {
    for (const level of Object.values(QUALITY_LEVELS.shadows)) {
      if (level) expect(level.radius).toBeLessThanOrEqual(2);
    }
  });
});

describe('bloom', () => {
  // Threshold bloom on the pre-exposure HDR buffer: every light material has to clear the whole
  // smoothstep band so emissives bloom fully (hot specular glints may bloom too, by design).
  it('every emissive material peaks above threshold + smoothing', () => {
    const { luminanceThreshold, luminanceSmoothing } = POSTFX.bloom;
    const emissive = Object.values(MATERIALS as Record<string, MaterialDef>).filter(
      (m) => m.emissiveIntensity > 0,
    );
    expect(emissive.length).toBeGreaterThan(0);
    for (const m of emissive) {
      expect(luminance(m.emissive) * m.emissiveIntensity, m.id).toBeGreaterThanOrEqual(
        luminanceThreshold + luminanceSmoothing,
      );
    }
  });
});

describe('render layers', () => {
  it('the volumetric layer is neither the default nor the viewmodel layer', () => {
    expect(RENDER.volumetricLayer).not.toBe(0);
    expect(RENDER.volumetricLayer).not.toBe(ENGINE.viewmodelLayer);
    expect(RENDER.volumetricLayer).toBeLessThan(32);
  });
});
