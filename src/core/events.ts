/**
 * Global game event map. Add new events here (one place = discoverable API).
 * Payloads are plain data; handlers must not keep references to mutable vectors
 * passed in payloads (copy if needed) because emitters may reuse them.
 */
import type { Settings, SettingsSection } from '../save/settingsSchema';
import type { QualityPreset } from '../save/settingsSchema';

export type Vec3Like = { x: number; y: number; z: number };

/** Why the simulation is paused (several can hold at once; the game runs when none is left). */
export type PauseReason = 'pointerlock' | 'visibility' | 'menu';

export type MovementState = 'ground' | 'air' | 'slide' | 'dash' | 'mantle' | 'noclip';

export type SurfaceType = 'metal' | 'concrete' | 'grate' | 'rubber' | 'glass' | 'default';

/** Surfaces of damageable things (enemies, dummies, shields) – drive impact VFX/SFX. */
export type FleshSurface = 'flesh' | 'slime' | 'armor' | 'shield';

/** Where a hit landed. Multipliers per zone come from the weapon / target defs. */
export type HitZone = 'head' | 'body' | 'limb' | 'weakpoint' | 'shield';

/** Damage elements (M5 elemental mods). 'physical' is the default for bullets. */
export type DamageElement = 'physical' | 'fire' | 'ice' | 'shock' | 'poison' | 'void';

export type ImpactKind = 'bullet' | 'pellet' | 'projectile' | 'melee' | 'explosion' | 'beam';

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
  /** Hit pulse from sources other than player damage (M2 weapons: hit markers, explosions). */
  'fx:hitPulse': { strength: number };

  // --- weapons (M2) – emitted by WeaponSystem, consumed by viewmodel animator, VFX, audio, HUD ---
  'weapon:equipStart': { weaponId: string; slot: number; duration: number; previous: string | null };
  'weapon:equipped': { weaponId: string; slot: number };
  /** `muzzle` is the world-space muzzle position (viewmodel socket mapped into the world camera). */
  'weapon:fired': {
    weaponId: string;
    origin: Vec3Like;
    direction: Vec3Like;
    muzzle: Vec3Like;
    shotIndex: number;
    ammoInMag: number;
    ads: boolean;
  };
  'weapon:dryFire': { weaponId: string };
  'weapon:reloadStart': { weaponId: string; empty: boolean; duration: number };
  /** Reload keyframe markers for animation/audio sync (mag out/in, bolt/slide/pump, shell insert). */
  'weapon:reloadStep': { weaponId: string; step: 'magOut' | 'magIn' | 'boltRelease' | 'shellIn' | 'pump' };
  'weapon:reloadEnd': { weaponId: string; completed: boolean };
  'weapon:ammoChanged': { weaponId: string; mag: number; reserve: number; magSize: number };
  'weapon:adsChanged': { aiming: boolean; weaponId: string };
  'weapon:inspect': { weaponId: string; duration: number };
  'weapon:melee': { weaponId: string; duration: number; hit: boolean };
  'weapon:inventoryChanged': { slots: (string | null)[]; current: number };

  // --- combat (M2+) ---
  /** A shot/blast hit a surface: drives impact particles, decals and impact sounds. */
  'combat:impact': {
    point: Vec3Like;
    normal: Vec3Like;
    surface: SurfaceType | FleshSurface;
    kind: ImpactKind;
    weaponId: string;
    /** Leave a decal (false for flesh exit wounds, penetration exits on thin surfaces, etc.). */
    decal: boolean;
  };
  'combat:tracer': { from: Vec3Like; to: Vec3Like; weaponId: string };
  /** Damage dealt to a Damageable (targets, enemies). */
  'combat:damage': {
    targetId: number;
    amount: number;
    zone: HitZone;
    point: Vec3Like;
    killed: boolean;
    weaponId: string;
    element: DamageElement;
    source: 'player' | 'enemy' | 'trap' | 'environment';
  };
  'combat:kill': {
    targetId: number;
    zone: HitZone;
    weaponId: string;
    position: Vec3Like;
    source: 'player' | 'enemy' | 'trap' | 'environment';
  };
  /** Generic explosion (grenades, explosive enemies, barrels) for VFX/SFX/shake. */
  'combat:explosion': { position: Vec3Like; radius: number; element: DamageElement };

  // --- ui ---
  'ui:console': { open: boolean };
  'ui:debugOverlay': { visible: boolean };
  'ui:menu': { open: boolean; menu: string };
}
