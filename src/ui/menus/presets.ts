/** Pure helpers for the graphics settings tab (unit-tested). */
import { GRAPHICS_PRESETS, type PresetValues } from '../../defs/graphics';
import type { GraphicsSettings, QualityPreset } from '../../save/settingsSchema';

export const PRESET_ORDER: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra'];

/** Graphics fields that belong to a preset (all others – fps limit, tone mapping, … – are user-only). */
export const PRESET_KEYS: ReadonlySet<string> = new Set(Object.keys(GRAPHICS_PRESETS.high));

/** The preset whose values all match `g`, or 'custom'. */
export function resolvePreset(g: Readonly<GraphicsSettings>): QualityPreset | 'custom' {
  for (const p of PRESET_ORDER) {
    const values = GRAPHICS_PRESETS[p];
    let match = true;
    for (const k of Object.keys(values) as (keyof PresetValues)[]) {
      if (values[k] !== g[k]) {
        match = false;
        break;
      }
    }
    if (match) return p;
  }
  return 'custom';
}

/** Patch for applying a whole preset. */
export function presetPatch(p: QualityPreset): Partial<GraphicsSettings> {
  return { preset: p, ...GRAPHICS_PRESETS[p] };
}

/**
 * Patch for changing individual options: preset-relevant changes switch the preset to 'custom'
 * (or back to a preset whose values match exactly); user-only fields keep the preset.
 */
export function individualPatch(
  current: Readonly<GraphicsSettings>,
  patch: Partial<GraphicsSettings>,
): Partial<GraphicsSettings> {
  const touchesPreset = Object.keys(patch).some((k) => PRESET_KEYS.has(k));
  if (!touchesPreset) return patch;
  return { ...patch, preset: resolvePreset({ ...current, ...patch }) };
}
