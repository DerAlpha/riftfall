import { describe, expect, it } from 'vitest';
import { AUTO_DETECT } from '../defs/graphics';
import { detectPresetFromHardware, lowerPreset, presetFromGpu, type HardwareInfo } from './qualityDetect';

const DESKTOP: HardwareInfo = { gpu: '', cores: 12, memoryGb: 16, screenPixels: 1920 * 1080, mobile: false };
const hw = (patch: Partial<HardwareInfo>): HardwareInfo => ({ ...DESKTOP, ...patch });

describe('presetFromGpu', () => {
  it.each([
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ultra'],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
    ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (NVIDIA, NVIDIA GeForce MX450 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
    ['ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ultra'],
    ['ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
    ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)', 'high'],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)', 'ultra'],
    ['Apple GPU', 'medium'],
    ['Mali-G78', 'low'],
    ['Adreno (TM) 740', 'low'],
    ['Google SwiftShader', 'low'],
    ['llvmpipe (LLVM 15.0.7, 256 bits)', 'low'],
  ] as const)('%s → %s', (gpu, expected) => {
    expect(presetFromGpu(gpu)).toBe(expected);
  });

  it('returns null for unknown or empty strings', () => {
    expect(presetFromGpu('')).toBeNull();
    expect(presetFromGpu('Some Future GPU 9000')).toBeNull();
  });
});

describe('detectPresetFromHardware', () => {
  it('uses the GPU rule on a capable desktop', () => {
    expect(detectPresetFromHardware(hw({ gpu: 'NVIDIA GeForce RTX 4080' }))).toBe('ultra');
    expect(detectPresetFromHardware(hw({ gpu: 'NVIDIA GeForce RTX 2070' }))).toBe('high');
  });

  it('falls back for unknown GPUs', () => {
    expect(detectPresetFromHardware(hw({ gpu: 'unknown' }))).toBe(AUTO_DETECT.fallbackPreset);
  });

  it('caps mobile devices', () => {
    expect(detectPresetFromHardware(hw({ gpu: 'Apple GPU', mobile: true }))).toBe(
      AUTO_DETECT.mobileMaxPreset,
    );
    expect(detectPresetFromHardware(hw({ gpu: 'NVIDIA GeForce RTX 4080', mobile: true }))).toBe('low');
  });

  it('caps low-end and mid-range CPUs / memory', () => {
    expect(detectPresetFromHardware(hw({ gpu: 'NVIDIA GeForce RTX 4080', cores: 2 }))).toBe('low');
    expect(detectPresetFromHardware(hw({ gpu: 'NVIDIA GeForce RTX 4080', memoryGb: 2 }))).toBe('low');
    expect(detectPresetFromHardware(hw({ gpu: 'NVIDIA GeForce RTX 4080', cores: 4 }))).toBe('medium');
    expect(detectPresetFromHardware(hw({ gpu: 'NVIDIA GeForce RTX 4080', memoryGb: 4 }))).toBe('medium');
  });

  it('treats unknown cores / memory (0) as no information', () => {
    expect(detectPresetFromHardware(hw({ gpu: 'NVIDIA GeForce RTX 4080', cores: 0, memoryGb: 0 }))).toBe(
      'ultra',
    );
  });

  it('steps down one preset on very large screens', () => {
    const fourK = 3840 * 2160;
    expect(detectPresetFromHardware(hw({ gpu: 'NVIDIA GeForce RTX 4080', screenPixels: fourK }))).toBe(
      'high',
    );
    expect(detectPresetFromHardware(hw({ gpu: 'Intel(R) UHD Graphics 630', screenPixels: fourK }))).toBe(
      'low',
    );
  });

  it('accepts custom rules', () => {
    const rules = { ...AUTO_DETECT, gpuRules: [{ match: ['potato'], preset: 'low' as const }] };
    expect(detectPresetFromHardware(hw({ gpu: 'Potato Graphics' }), rules)).toBe('low');
  });
});

describe('lowerPreset', () => {
  it('steps down and stops at low', () => {
    expect(lowerPreset('ultra')).toBe('high');
    expect(lowerPreset('high')).toBe('medium');
    expect(lowerPreset('medium')).toBe('low');
    expect(lowerPreset('low')).toBeNull();
  });
});
