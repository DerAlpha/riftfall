/**
 * Pooled world flash lights (muzzle flashes, impacts, explosions). All lights are created up
 * front and stay in the scene at intensity 0: three keys shader programs on the light count, so
 * adding/removing (or hiding) lights at runtime would recompile every lit material mid-game.
 *
 * Allocation: a flash takes a dark slot, else the dimmest slot of lower or equal priority; low
 * priority flashes (impacts) are capped per frame so a shotgun blast cannot steal every light.
 * The slot bookkeeping (LightSlots) is pure and unit-tested; LightPool maps it onto PointLights.
 *
 * The weapon is drawn in its own scene (viewmodel pass), which these lights never reach: one more
 * pooled light there carries the flash with the most irradiance at the eye (updateViewmodel).
 */
import * as THREE from 'three';
import type { Vec3Like } from '../core/events';
import { VFX, type LightFlashDef, type Rgb } from '../defs/vfx';

/** Envelope of a flash at normalized time t (1 at the start, 0 at the end, quadratic decay). */
export function flashEnvelope(t: number): number {
  if (!(t < 1)) return 0;
  if (t <= 0) return 1;
  const k = 1 - t;
  return k * k;
}

export class LightSlots {
  readonly age: Float32Array;
  readonly duration: Float32Array;
  readonly peak: Float32Array;
  readonly priority: Int8Array;
  readonly flicker: Float32Array;
  readonly phase: Float32Array;
  /** Current intensity (peak × envelope × flicker), 0 when dark. */
  readonly intensity: Float32Array;
  /** Started since the last endFrame(): shown at full peak for the frame it started in. */
  readonly fresh: Uint8Array;
  /** Bumped by every start(): a sustain handle (see handleOf) is only valid for its own flash. */
  readonly gen: Uint32Array;
  private lowThisFrame = 0;

  constructor(
    readonly size: number,
    private readonly lowPriorityPerFrame: number,
  ) {
    this.age = new Float32Array(size);
    this.duration = new Float32Array(size);
    this.peak = new Float32Array(size);
    this.priority = new Int8Array(size).fill(-1);
    this.flicker = new Float32Array(size);
    this.phase = new Float32Array(size);
    this.intensity = new Float32Array(size);
    this.fresh = new Uint8Array(size);
    this.gen = new Uint32Array(size);
  }

  /** Handle of the flash currently in `slot` (> 0). */
  handleOf(slot: number): number {
    return this.gen[slot]! * (this.size + 1) + slot + 1;
  }

  /** Slot of a handle whose flash is still lit, else -1 (stolen, finished or cleared). */
  slotOf(handle: number): number {
    if (!(handle > 0)) return -1;
    const slot = (handle % (this.size + 1)) - 1;
    if (slot < 0 || slot >= this.size) return -1;
    const gen = Math.floor(handle / (this.size + 1));
    return this.gen[slot] === gen && this.intensity[slot]! > 0 ? slot : -1;
  }

  /** Pick a slot for a flash; -1 when none may be taken. Does not start the flash. */
  acquire(priority: number, peak: number): number {
    if (priority <= 0 && this.lowThisFrame >= this.lowPriorityPerFrame) return -1;
    let best = -1;
    let bestValue = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.size; i++) {
      const cur = this.intensity[i]!;
      if (cur <= 0) {
        best = i;
        break;
      }
      if (this.priority[i]! > priority) continue;
      // Only steal a light that is currently dimmer than the new flash.
      if (cur < bestValue && cur < peak) {
        bestValue = cur;
        best = i;
      }
    }
    if (best >= 0 && priority <= 0) this.lowThisFrame++;
    return best;
  }

  start(
    slot: number,
    peak: number,
    duration: number,
    priority: number,
    flicker: number,
    phase: number,
  ): void {
    this.age[slot] = 0;
    this.duration[slot] = Math.max(1e-3, duration);
    this.peak[slot] = peak;
    this.priority[slot] = priority;
    this.flicker[slot] = flicker;
    this.phase[slot] = phase;
    this.intensity[slot] = peak;
    this.fresh[slot] = 1;
    this.gen[slot] = (this.gen[slot]! + 1) >>> 0;
  }

  /**
   * Advance all flashes; `flickerRate` in Hz. Flashes started since the last endFrame() (this
   * frame's ticks) are not aged: every flash renders exactly one frame at its peak, whether it
   * started in a tick or later in the frame, at any frame rate.
   */
  update(dt: number, flickerRate: number): void {
    this.lowThisFrame = 0;
    for (let i = 0; i < this.size; i++) {
      if (this.intensity[i]! <= 0 || this.fresh[i]) continue;
      const age = this.age[i]! + dt;
      this.age[i] = age;
      const env = flashEnvelope(age / this.duration[i]!);
      if (env <= 0) {
        this.intensity[i] = 0;
        this.priority[i] = -1;
        continue;
      }
      const fl = this.flicker[i]!;
      const wobble =
        fl > 0 ? 1 - fl * (0.5 + 0.5 * Math.sin((age * flickerRate + this.phase[i]!) * Math.PI * 2)) : 1;
      this.intensity[i] = this.peak[i]! * env * wobble;
    }
  }

  /** The frame's flashes are all started: they age from the next update() on. */
  endFrame(): void {
    this.fresh.fill(0);
  }

  get active(): number {
    let n = 0;
    for (let i = 0; i < this.size; i++) if (this.intensity[i]! > 0) n++;
    return n;
  }

  clear(): void {
    this.intensity.fill(0);
    this.priority.fill(-1);
    this.fresh.fill(0);
  }
}

export class LightPool {
  readonly lights: THREE.PointLight[] = [];
  readonly slots: LightSlots;
  /** Flash light in the viewmodel scene (null without one); intensity 0 while nothing flashes. */
  readonly viewmodelLight: THREE.PointLight | null;
  /** Per slot: the flash may light the viewmodel (LightFlashDef.viewmodel). */
  private readonly litViewmodel: Uint8Array;
  private intensityScale = 1;

  /**
   * `viewmodelScene`: construct before the viewmodel materials compile – the extra light there
   * changes that scene's light count once, at boot.
   */
  constructor(
    scene: THREE.Object3D,
    private readonly rand: () => number = Math.random,
    viewmodelScene: THREE.Object3D | null = null,
  ) {
    const c = VFX.lights;
    this.slots = new LightSlots(c.count, c.lowPriorityPerFrame);
    this.litViewmodel = new Uint8Array(c.count);
    for (let i = 0; i < c.count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 1, c.decay);
      light.name = `VfxFlashLight${i}`;
      light.castShadow = false;
      // Parked far below the level while dark (intensity 0 already contributes nothing).
      light.position.set(0, -1e4, 0);
      scene.add(light);
      this.lights.push(light);
    }
    if (viewmodelScene) {
      // No cutoff distance: updateViewmodel applies the world light's cutoff itself.
      const light = new THREE.PointLight(0xffffff, 0, 0, c.decay);
      light.name = 'VfxViewmodelFlashLight';
      light.castShadow = false;
      viewmodelScene.add(light);
      this.viewmodelLight = light;
    } else {
      this.viewmodelLight = null;
    }
  }

  /** Accessibility (reduce flashing) multiplier on new flash peaks. */
  setIntensityScale(scale: number): void {
    this.intensityScale = Math.max(0, scale);
  }

  /** Start a flash at `position` (+ normal · def.offset). Returns false when no light was free. */
  flash(
    def: LightFlashDef,
    position: Vec3Like,
    normal: Vec3Like | null,
    scale = 1,
    color?: Rgb | number,
  ): boolean {
    const peak = def.intensity * scale * this.intensityScale;
    if (!(peak > 0)) return false;
    const slot = this.slots.acquire(def.priority, peak);
    if (slot < 0) return false;
    this.startFlash(slot, def, position, normal, scale, peak, color);
    return true;
  }

  private startFlash(
    slot: number,
    def: LightFlashDef,
    position: Vec3Like,
    normal: Vec3Like | null,
    scale: number,
    peak: number,
    color: Rgb | number | undefined,
  ): void {
    const light = this.lights[slot]!;
    const off = (def.offset ?? 0) * scale;
    light.position.set(
      position.x + (normal ? normal.x * off : 0),
      position.y + (normal ? normal.y * off : 0),
      position.z + (normal ? normal.z * off : 0),
    );
    light.distance = def.range * Math.max(1, scale);
    // Colors are linear (defs and weapon hex values alike).
    const col = light.color;
    if (typeof color === 'number') col.setHex(color, THREE.LinearSRGBColorSpace);
    else if (color) col.setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace);
    else col.setRGB(def.color[0], def.color[1], def.color[2], THREE.LinearSRGBColorSpace);
    this.slots.start(slot, peak, def.duration, def.priority, def.flicker ?? 0, this.rand());
    this.litViewmodel[slot] = def.viewmodel === false ? 0 : 1;
    light.intensity = peak;
  }

  /**
   * Keep a light going for a lasting effect (beam, field, charge): re-flash the slot of `handle`
   * in place while it still carries that effect's last flash (no slot hopping – a re-flashed beam
   * never occupies two lights), else start a new flash like flash(). Call it every
   * def.duration-fraction; returns the new handle (0 = no light free).
   */
  sustain(
    handle: number,
    def: LightFlashDef,
    position: Vec3Like,
    normal: Vec3Like | null,
    scale = 1,
    color?: Rgb | number,
  ): number {
    const peak = def.intensity * scale * this.intensityScale;
    if (!(peak > 0)) return 0;
    let slot = this.slots.slotOf(handle);
    if (slot < 0) slot = this.slots.acquire(def.priority, peak);
    if (slot < 0) return 0;
    this.startFlash(slot, def, position, normal, scale, peak, color);
    return this.slots.handleOf(slot);
  }

  /** Age the flashes (start of the VFX update; flashes of this frame's ticks stay at peak). */
  update(dt: number): void {
    this.slots.update(dt, VFX.lights.flickerRate);
    for (let i = 0; i < this.lights.length; i++) this.lights[i]!.intensity = this.slots.intensity[i]!;
  }

  /** After the last flash of the frame started (end of the VFX update). */
  endFrame(): void {
    this.slots.endFrame();
  }

  /**
   * Put the flash with the most irradiance at `eye` (world camera position) onto the viewmodel
   * light, × VFX.lights.viewmodel.gain. The viewmodel camera sits at the origin with the world
   * camera's rotation, so the flash's offset from the eye is its position there; farther than
   * maxDistance it is pulled in along that direction and the intensity scaled by
   * (pulled / real)^decay so the irradiance at the eye stays the same. Call after the frame's
   * flashes started.
   */
  updateViewmodel(eye: Vec3Like): void {
    const vl = this.viewmodelLight;
    if (!vl) return;
    const cfg = VFX.lights.viewmodel;
    const decay = VFX.lights.decay;
    const minFalloff = cfg.minDistance ** decay;
    let best = -1;
    let bestE = 0;
    let bestWindow = 0;
    let bestD = 0;
    for (let i = 0; i < this.lights.length; i++) {
      const intensity = this.slots.intensity[i]!;
      if (!(intensity > 0) || !this.litViewmodel[i]) continue;
      const l = this.lights[i]!;
      const d = Math.hypot(l.position.x - eye.x, l.position.y - eye.y, l.position.z - eye.z);
      const window = cutoffWindow(d, l.distance);
      const e = (intensity * window) / Math.max(d ** decay, minFalloff);
      if (e > bestE) {
        bestE = e;
        best = i;
        bestWindow = window;
        bestD = d;
      }
    }
    if (best < 0) {
      vl.intensity = 0;
      return;
    }
    const l = this.lights[best]!;
    const k = bestD > cfg.maxDistance ? cfg.maxDistance / bestD : 1;
    vl.position.set((l.position.x - eye.x) * k, (l.position.y - eye.y) * k, (l.position.z - eye.z) * k);
    vl.color.copy(l.color);
    vl.intensity = this.slots.intensity[best]! * bestWindow * k ** decay * cfg.gain;
  }

  /** Copy the current flashes into particle lighting uniforms (color premultiplied by intensity · scale). */
  writeUniforms(pos: THREE.Vector4[], color: THREE.Vector3[], scale: number): void {
    for (let i = 0; i < this.lights.length && i < pos.length; i++) {
      const l = this.lights[i]!;
      const k = this.slots.intensity[i]! * scale;
      pos[i]!.set(l.position.x, l.position.y, l.position.z, l.distance);
      color[i]!.set(l.color.r * k, l.color.g * k, l.color.b * k);
    }
  }

  get active(): number {
    return this.slots.active;
  }

  clear(): void {
    this.slots.clear();
    for (const l of this.lights) l.intensity = 0;
    if (this.viewmodelLight) this.viewmodelLight.intensity = 0;
  }

  dispose(): void {
    for (const l of this.lights) {
      l.removeFromParent();
      l.dispose();
    }
    this.lights.length = 0;
    this.viewmodelLight?.removeFromParent();
    this.viewmodelLight?.dispose();
  }
}

/** three's point light range window at distance d: (1 − (d / cutoff)⁴)² clamped, 1 without cutoff. */
export function cutoffWindow(d: number, cutoff: number): number {
  if (!(cutoff > 0)) return 1;
  const r = d / cutoff;
  const w = Math.min(1, Math.max(0, 1 - r * r * r * r));
  return w * w;
}
