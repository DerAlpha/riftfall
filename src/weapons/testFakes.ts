/**
 * Test doubles for weapon tests (imported by *.test.ts only; never by game code).
 */
import { PerspectiveCamera, Vector3 } from 'three';
import type { InputApi, LookOut, Vec2Out } from '../core/contracts';
import type { MovementState } from '../core/events';
import type { Action } from '../defs/input';
import type { AdsProvider } from '../player/PlayerController';
import type { LookModifier } from '../player/PlayerCamera';
import type { WeaponCamera, WeaponPlayer } from './WeaponSystem';

/** Input fake with a switchable device (aim assist is gamepad-only). */
export class FakeWeaponInput implements InputApi {
  device: 'kbm' | 'gamepad' = 'kbm';
  readonly pointerLocked = true;
  enabled = true;
  readonly down = new Set<Action>();
  private readonly edges = new Set<Action>();
  readonly look = { yaw: 0, pitch: 0 };
  readonly rumbles: number[] = [];
  beginFrame(): void {}
  endFrame(): void {
    this.edges.clear();
  }
  isDown(a: Action): boolean {
    return this.down.has(a);
  }
  pressed(a: Action): boolean {
    return this.edges.has(a);
  }
  released(): boolean {
    return false;
  }
  value(a: Action): number {
    return this.down.has(a) ? 1 : 0;
  }
  getMove(out: Vec2Out): Vec2Out {
    out.x = 0;
    out.y = 0;
    return out;
  }
  getLook(out: LookOut): LookOut {
    out.yaw = this.look.yaw;
    out.pitch = this.look.pitch;
    return out;
  }
  press(a: Action): void {
    this.down.add(a);
    this.edges.add(a);
  }
  release(a: Action): void {
    this.down.delete(a);
  }
  tap(a: Action): void {
    this.edges.add(a);
  }
  requestPointerLock(): void {}
  exitPointerLock(): void {}
  captureBinding(): Promise<null> {
    return Promise.resolve(null);
  }
  rumble(strong: number): void {
    this.rumbles.push(strong);
  }
  dispose(): void {}
}

export class FakePlayer implements WeaponPlayer {
  readonly position = new Vector3(0, 0, 0);
  yaw = 0;
  pitch = 0;
  state: MovementState = 'ground';
  sprinting = false;
  crouched = false;
  grounded = true;
  horizontalSpeed = 0;
  currentEyeHeight = 1.6;
  adsProvider: AdsProvider | null = null;
}

export interface RecoilCall {
  pitch: number;
  yaw: number;
  duration: number;
}

/** Recovery steps are eased over one fixed tick; aim kicks over the weapon's (longer) kickTime. */
const RECOVERY_DURATION_MAX = 1 / 60 + 1e-9;

/** Records recoil; applies it to the fake player's aim at once when `applyRecoil` (so shots see it). */
export class FakeCamera implements WeaponCamera {
  readonly lookDelta = { yaw: 0, pitch: 0 };
  lookModifier: LookModifier | null = null;
  /** Landing dip / mantle view pitch (rad) the real camera adds on top of the player's pitch. */
  aimPitchOffset = 0;
  readonly recoil: RecoilCall[] = [];
  punches = 0;
  applyRecoil = false;
  constructor(private readonly player: FakePlayer) {}
  addRecoil(pitch: number, yaw: number, duration = 0): void {
    this.recoil.push({ pitch, yaw, duration });
    if (this.applyRecoil) {
      this.player.pitch += pitch;
      this.player.yaw += yaw;
    }
  }
  addViewPunch(): void {
    this.punches++;
  }
  /** Recoil pitch swallowed by a pitch limit (tests set it). */
  pitchLoss = 0;
  takeRecoilPitchLoss(): number {
    const l = this.pitchLoss;
    this.pitchLoss = 0;
    return l;
  }
  /** Aim kicks (eased over kickTime), without the per-tick recovery steps. */
  get kicks(): RecoilCall[] {
    return this.recoil.filter((r) => r.duration > RECOVERY_DURATION_MAX);
  }
  /** Recovery steps (eased over at most one tick). */
  get recoveries(): RecoilCall[] {
    return this.recoil.filter((r) => r.duration <= RECOVERY_DURATION_MAX);
  }
  /** Total kick pitch in radians. */
  get kickPitch(): number {
    return this.kicks.reduce((s, r) => s + r.pitch, 0);
  }
}

export function fakeRenderCamera(eye: { x: number; y: number; z: number }): { camera: PerspectiveCamera } {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.05, 400);
  camera.position.set(eye.x, eye.y, eye.z);
  return { camera };
}
