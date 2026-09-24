/**
 * Narrow dependencies shared by the map-kit systems (traps, map events, quests): audio with loops,
 * VFX, the player, combat, the prop visuals context and the HUD banner sink. Game passes the real
 * systems (AudioEngine, VfxSystem, CombatWorld, …); tests pass fakes.
 */
import type { Material, Object3D, Vector3 } from 'three';
import type {
  MaterialLibraryApi,
  PlayOptions,
  PlayerDamageKind,
  WeaponCombatApi,
} from '../../core/contracts';
import type { Vec3Like } from '../../core/events';
import type { LightFlashDef, Rgb } from '../../defs/vfx';
import type { SolidBlockerDeps } from '../../interactables/SolidBlocker';

/**
 * Solid kit props (generator cabinets, the quest socket, fan housings): player collider, bullet
 * blocker (`level:<material>` mesh) and a blocked nav area, like the machines (SolidBlocker).
 * Null: nothing is solid (tests, headless).
 */
export type KitBlockers = SolidBlockerDeps;

/** AudioEngine subset: one-shots and positional loops. */
export interface KitAudio {
  play(id: string, opts?: PlayOptions): void;
  startLoop(id: string, opts?: PlayOptions & { fadeIn?: number }): number;
  stopLoop(handle: number, fadeSeconds?: number): void;
  updateLoop?(
    handle: number,
    u: { volume?: number; pitch?: number; position?: Vec3Like },
    seconds?: number,
  ): boolean;
}

/** VfxSystem subset (effect presets, world tracers, pooled flash lights). */
export interface KitVfx {
  spawn(effect: string, position: Vec3Like, normal?: Vec3Like, scale?: number): void;
  tracer(from: Vec3Like, to: Vec3Like, color?: number): void;
  readonly lights?: {
    flash(
      def: LightFlashDef,
      position: Vec3Like,
      normal: Vec3Like | null,
      scale?: number,
      color?: Rgb | number,
    ): boolean;
  };
}

/** The player as the kit sees it (feet position, eye, alive, damage). */
export interface KitPlayer {
  readonly position: Vector3;
  readonly eyePosition: Vector3;
  readonly alive: boolean;
  /** `direction`: from the player towards the source (HUD damage indicator). */
  damage(amount: number, direction?: Vec3Like, kind?: PlayerDamageKind): number;
}

export type KitCombat = Pick<
  WeaponCombatApi,
  'raycast' | 'queryRadius' | 'dealDamage' | 'lineOfSight' | 'register' | 'unregister' | 'targets'
>;

/** Where kit props live and how they are lit (null in tests / headless: logic only). */
export interface KitVisuals {
  /** Parent group in the world scene (never level.root: not nav / level geometry). */
  readonly root: Object3D;
  readonly materials: MaterialLibraryApi;
  setupMaterial(m: Material): void;
  /** Shared time uniform (additive shaders). */
  readonly time: { value: number };
  reduceFlashing: boolean;
}

/** HUD banner (EconomyBanners pattern: kicker, title, sub, sRGB hex color, seconds). */
export interface KitBanner {
  (kicker: string, title: string, sub: string, color: number, seconds: number): void;
}

/**
 * A positional loop that runs while wanted and the listener is within `maxDistance` (10 % hysteresis)
 * – traps, generators and quest hums keep dozens of potential loops, only the near ones play.
 */
export class PositionalLoop {
  private handle = 0;
  private readonly retune = { volume: 1, pitch: 1 };
  constructor(
    private readonly audio: KitAudio | null,
    private readonly id: string,
    private readonly gain: number,
    private readonly position: Vec3Like,
    private readonly maxDistance: number,
  ) {}

  get playing(): boolean {
    return this.handle > 0;
  }

  update(want: boolean, listener: Vec3Like | null): void {
    const audio = this.audio;
    if (!audio) return;
    let near = false;
    if (want && listener) {
      const d = Math.hypot(
        listener.x - this.position.x,
        listener.y - this.position.y,
        listener.z - this.position.z,
      );
      near = d < this.maxDistance * (this.handle > 0 ? 1.1 : 1);
    }
    if (near && this.handle <= 0) {
      this.handle = audio.startLoop(this.id, { position: this.position, volume: this.gain, bus: 'sfx' });
    } else if (!near && this.handle > 0) {
      this.stop();
    }
  }

  /** Retune the running loop (volume multiplier on the base gain, pitch). */
  set(volume: number, pitch = 1): void {
    if (this.handle <= 0) return;
    this.retune.volume = this.gain * volume;
    this.retune.pitch = pitch;
    this.audio?.updateLoop?.(this.handle, this.retune);
  }

  stop(fade?: number): void {
    if (this.handle > 0) this.audio?.stopLoop(this.handle, fade);
    this.handle = 0;
  }
}
