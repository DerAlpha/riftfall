/**
 * Global game event map. Add new events here (one place = discoverable API).
 * Payloads are plain data; handlers must not keep references to mutable vectors
 * passed in payloads (copy if needed) because emitters may reuse them.
 */
import type { Settings, SettingsSection } from '../save/settingsSchema';
import type { QualityPreset } from '../save/settingsSchema';

export type Vec3Like = { x: number; y: number; z: number };

export type PauseReason = 'pointerlock' | 'visibility' | 'menu' | 'console' | 'loading';

export type MovementState = 'ground' | 'air' | 'slide' | 'dash' | 'mantle' | 'noclip';

export type SurfaceType = 'metal' | 'concrete' | 'grate' | 'rubber' | 'glass' | 'default';

export interface GameEvents {
  // --- lifecycle ---
  'game:ready': Record<string, never>;
  'game:paused': { reason: PauseReason };
  'game:resumed': Record<string, never>;
  'loading:progress': { loaded: number; total: number; label: string };
  'loading:done': Record<string, never>;

  // --- settings ---
  'settings:changed': { settings: Readonly<Settings>; sections: SettingsSection[] };
  'quality:presetApplied': { preset: QualityPreset | 'custom'; auto: boolean };
  'quality:resolutionScale': { scale: number };

  // --- input ---
  'input:deviceChanged': { device: 'kbm' | 'gamepad' };
  'input:pointerLock': { locked: boolean };

  // --- player movement (emitted from fixed tick) ---
  'player:jump': { double: boolean; position: Vec3Like };
  'player:land': { impactSpeed: number; heavy: boolean; position: Vec3Like; surface: SurfaceType };
  'player:footstep': {
    position: Vec3Like;
    speed: number;
    sprinting: boolean;
    crouched: boolean;
    surface: SurfaceType;
  };
  'player:slideStart': { speed: number; position: Vec3Like };
  'player:slideEnd': Record<string, never>;
  'player:dash': { direction: Vec3Like; chargesLeft: number; position: Vec3Like };
  'player:mantle': { height: number; position: Vec3Like };
  'player:crouch': { crouched: boolean };
  'player:stateChanged': { from: MovementState; to: MovementState };
  'player:teleported': { position: Vec3Like };

  // --- combat feedback (M1: driven by dev console `hurt`) ---
  /** `direction`: world space, from the player TOWARDS the damage source (HUD indicator uses x/z only). */
  'player:damaged': { amount: number; healthFraction: number; direction?: Vec3Like };
  'player:healthChanged': { health: number; maxHealth: number; armor: number; maxArmor: number };

  // --- camera / fx ---
  'camera:shake': { trauma: number };
  'fx:hitPulse': { strength: number };

  // --- ui ---
  'ui:console': { open: boolean };
  'ui:debugOverlay': { visible: boolean };
  'ui:menu': { open: boolean; menu: string };
}
