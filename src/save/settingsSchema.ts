/**
 * Settings data model + defaults. Persisted inside the save file (see SaveSystem).
 * Keep this file free of browser APIs so it can be unit-tested and used in workers.
 */
import { DEFAULT_BINDINGS, type BindingMap } from '../defs/input';
import { CAMERA } from '../defs/camera';

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';
export type QualityLevel = 'off' | 'low' | 'medium' | 'high' | 'ultra';

export interface GraphicsSettings {
  preset: QualityPreset | 'custom';
  /** Upper bound of the render scale (0.5..1). With dynamic resolution the actual scale floats below it. */
  renderScale: number;
  /** Cap for window.devicePixelRatio. */
  maxPixelRatio: number;
  dynamicResolution: boolean;
  targetFps: number;
  /** Frame limiter, 0 = unlimited. */
  fpsLimit: number;
  shadows: QualityLevel;
  ambientOcclusion: QualityLevel;
  bloom: QualityLevel;
  volumetrics: QualityLevel;
  antialiasing: 'off' | 'fxaa' | 'smaa';
  motionBlur: boolean;
  depthOfField: boolean;
  filmGrain: boolean;
  chromaticAberration: boolean;
  vignette: boolean;
  particles: QualityLevel;
  textureQuality: 'low' | 'medium' | 'high';
  anisotropy: number;
  toneMapping: 'agx' | 'aces' | 'neutral';
  /** Exposure multiplier (brightness slider). */
  exposure: number;
  showFps: boolean;
}

export interface AudioSettings {
  master: number;
  music: number;
  sfx: number;
  voice: number;
  ui: number;
  /** Mute all audio when the tab is not focused. */
  muteInBackground: boolean;
}

export interface ControlSettings {
  /** Multiplier on CAMERA.mouseRadiansPerCount. */
  mouseSensitivity: number;
  /** Multiplier applied while aiming down sights. */
  adsSensitivityMultiplier: number;
  invertY: boolean;
  fov: number;
  toggleSprint: boolean;
  toggleCrouch: boolean;
  /** Auto-sprint when pushing forward (gamepad-friendly). */
  autoSprint: boolean;
  gamepadSensitivityX: number;
  gamepadSensitivityY: number;
  gamepadInvertY: boolean;
  gamepadDeadzone: number;
  /** Aim assist – only ever applied to gamepad input. */
  aimAssist: boolean;
  vibration: boolean;
  bindings: BindingMap;
}

export interface AccessibilitySettings {
  colorblindMode: 'none' | 'protanopia' | 'deuteranopia' | 'tritanopia';
  subtitles: boolean;
  /** 0..1 multiplier on all screen shake. */
  screenShake: number;
  /** Reduces full-screen flashes, chromatic aberration pulses and strobing. */
  reduceFlashing: boolean;
  /** 0..1 multiplier on head bob / camera roll (motion sickness). */
  cameraMotion: number;
  hudScale: number;
}

export interface GameplaySettings {
  damageNumbers: boolean;
  minimap: boolean;
  crosshair: 'dot' | 'cross' | 'circle' | 'chevron';
  crosshairColor: string;
  hitmarkers: boolean;
}

export interface Settings {
  graphics: GraphicsSettings;
  audio: AudioSettings;
  controls: ControlSettings;
  accessibility: AccessibilitySettings;
  gameplay: GameplaySettings;
}

export type SettingsSection = keyof Settings;

export function cloneBindings(b: BindingMap): BindingMap {
  return JSON.parse(JSON.stringify(b)) as BindingMap;
}

export function createDefaultSettings(): Settings {
  return {
    graphics: {
      preset: 'high',
      renderScale: 1,
      maxPixelRatio: 1.5,
      dynamicResolution: true,
      targetFps: 60,
      fpsLimit: 0,
      shadows: 'high',
      ambientOcclusion: 'medium',
      bloom: 'high',
      volumetrics: 'medium',
      antialiasing: 'smaa',
      motionBlur: false,
      depthOfField: true,
      filmGrain: true,
      chromaticAberration: true,
      vignette: true,
      particles: 'high',
      textureQuality: 'high',
      anisotropy: 8,
      toneMapping: 'agx',
      exposure: 1,
      showFps: false,
    },
    audio: {
      master: 0.8,
      music: 0.6,
      sfx: 0.9,
      voice: 1,
      ui: 0.7,
      muteInBackground: true,
    },
    controls: {
      mouseSensitivity: 1.6,
      adsSensitivityMultiplier: 0.8,
      invertY: false,
      fov: CAMERA.defaultFov,
      toggleSprint: false,
      toggleCrouch: false,
      autoSprint: false,
      gamepadSensitivityX: 1,
      gamepadSensitivityY: 0.8,
      gamepadInvertY: false,
      gamepadDeadzone: 0.15,
      aimAssist: true,
      vibration: true,
      bindings: cloneBindings(DEFAULT_BINDINGS),
    },
    accessibility: {
      colorblindMode: 'none',
      subtitles: true,
      screenShake: 1,
      reduceFlashing: false,
      cameraMotion: 1,
      hudScale: 1,
    },
    gameplay: {
      damageNumbers: true,
      minimap: false,
      crosshair: 'cross',
      crosshairColor: '#e8f6ff',
      hitmarkers: true,
    },
  };
}
