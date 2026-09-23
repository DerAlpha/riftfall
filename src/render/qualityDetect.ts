/**
 * Hardware → graphics preset heuristics (pure; the browser probing lives in QualityManager).
 */
import { AUTO_DETECT } from '../defs/graphics';
import type { QualityPreset } from '../save/settingsSchema';

export const PRESET_ORDER: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra'];

export interface HardwareInfo {
  /** Unmasked GPU renderer string (any case); empty if unknown. */
  gpu: string;
  /** Logical CPU cores (navigator.hardwareConcurrency); 0 if unknown. */
  cores: number;
  /** Device memory in GB (navigator.deviceMemory, Chromium only); 0 if unknown. */
  memoryGb: number;
  /** Physical screen pixels (width * height * dpr²); 0 if unknown. */
  screenPixels: number;
  mobile: boolean;
}

interface HardwareCap {
  maxCores: number;
  maxMemoryGb: number;
  maxPreset: QualityPreset;
}

/** Structural subset of AUTO_DETECT used by the heuristic (tests may pass their own). */
export interface AutoDetectRules {
  gpuRules: readonly { match: readonly string[]; preset: QualityPreset }[];
  fallbackPreset: QualityPreset;
  mobileMaxPreset: QualityPreset;
  lowEnd: HardwareCap;
  midRange: HardwareCap;
  largeScreenPixels: number;
}

function rank(p: QualityPreset): number {
  return PRESET_ORDER.indexOf(p);
}

function minPreset(a: QualityPreset, b: QualityPreset): QualityPreset {
  return rank(a) <= rank(b) ? a : b;
}

/** One step down, or null if already at the lowest preset. */
export function lowerPreset(p: QualityPreset): QualityPreset | null {
  const i = rank(p);
  return i > 0 ? (PRESET_ORDER[i - 1] ?? null) : null;
}

/** First GPU rule whose substring occurs in the renderer string, or null if nothing matches. */
export function presetFromGpu(gpu: string, rules: AutoDetectRules = AUTO_DETECT): QualityPreset | null {
  const s = gpu.toLowerCase();
  if (!s) return null;
  for (const rule of rules.gpuRules) {
    for (const m of rule.match) {
      if (s.includes(m)) return rule.preset;
    }
  }
  return null;
}

export function detectPresetFromHardware(
  info: HardwareInfo,
  rules: AutoDetectRules = AUTO_DETECT,
): QualityPreset {
  let preset: QualityPreset = presetFromGpu(info.gpu, rules) ?? rules.fallbackPreset;

  if (info.mobile) preset = minPreset(preset, rules.mobileMaxPreset);

  const lowCores = info.cores > 0 && info.cores <= rules.lowEnd.maxCores;
  const lowMem = info.memoryGb > 0 && info.memoryGb <= rules.lowEnd.maxMemoryGb;
  if (lowCores || lowMem) preset = minPreset(preset, rules.lowEnd.maxPreset);

  const midCores = info.cores > 0 && info.cores <= rules.midRange.maxCores;
  const midMem = info.memoryGb > 0 && info.memoryGb <= rules.midRange.maxMemoryGb;
  if (midCores || midMem) preset = minPreset(preset, rules.midRange.maxPreset);

  if (info.screenPixels > rules.largeScreenPixels) preset = lowerPreset(preset) ?? preset;

  return preset;
}
