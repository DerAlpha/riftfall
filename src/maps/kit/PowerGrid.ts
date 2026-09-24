/**
 * The map's main power (PowerApi, M7 power outage): lights, machines and purchases.
 *
 * - Lights: the level's light groups (MapLevelInstance.lightGroups, else collected from level.root
 *   by collectLightGroups) dim towards emergency red – the main fixtures, their emissive panels and
 *   light cones fall to a fraction and shift red, emergency (red) lights boost and pulse, rift
 *   energy (violet) is left alone. A blackout stutters first, then ramps down; a restart stutters
 *   and ramps up (reduced flashing: smooth ramps only).
 * - Machines: the visuals of perk machines, the Rift Forge, the Rift-Kiste and wall buys (and a
 *   level's `poweredObjects`) go dark; their interactables are registered through `gate()`, which
 *   refuses every purchase while unpowered ("Kein Strom") – free actions (taking an offered box
 *   weapon) still work.
 *
 * Dimming is multiplicative and robust against the owners' own animation: the level flickers its
 * lights and the views breathe their neon by writing ABSOLUTE values every frame, others write once.
 * ScaledValues remembers what it wrote last: a value that differs was written by the owner and
 * becomes the new base; the pass writes base × factor. Run the pass after the owners' updates (Game:
 * after level.update / interactables.update). Idle (powered, no transition) it touches nothing.
 * Lights and materials are never added or removed (no shader recompiles); colors / intensities only.
 */
import {
  Color,
  Light,
  Mesh,
  MeshStandardMaterial,
  ShaderMaterial,
  type Material,
  type Object3D,
} from 'three';
import type { Interactable, PowerApi } from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { clamp01, lerp, noise1D, smoothstep } from '../../core/math';
import { POWER } from '../../defs/mapEvents';
import type { LevelLightGroup } from '../types';

type NumberGetter = () => number;
type NumberSetter = (v: number) => void;

/**
 * Values scaled by a factor on top of whatever their owner writes (see the file header). Getters /
 * setters are created once at setup; apply() is allocation-free.
 */
export class ScaledValues {
  private readonly get: NumberGetter[] = [];
  private readonly set: NumberSetter[] = [];
  private base = new Float64Array(8);
  private last = new Float64Array(8);
  private written = new Uint8Array(8);

  get size(): number {
    return this.get.length;
  }

  add(get: NumberGetter, set: NumberSetter): void {
    const i = this.get.length;
    if (i >= this.base.length) {
      const grow = (a: Float64Array): Float64Array => {
        const b = new Float64Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.base = grow(this.base);
      this.last = grow(this.last);
      const w = new Uint8Array(this.written.length * 2);
      w.set(this.written);
      this.written = w;
    }
    this.get.push(get);
    this.set.push(set);
  }

  /** Write base × k for every value (a value changed by its owner since the last write rebases). */
  apply(k: number): void {
    for (let i = 0; i < this.get.length; i++) {
      const cur = this.get[i]!();
      if (this.written[i] === 0 || cur !== this.last[i]) this.base[i] = cur;
      const v = this.base[i]! * k;
      this.set[i]!(v);
      this.last[i] = v;
      this.written[i] = 1;
    }
  }

  /** Per-value factor (emergency pulses per group share one factor: same as apply). */
  applyEach(k: (i: number) => number): void {
    for (let i = 0; i < this.get.length; i++) {
      const cur = this.get[i]!();
      if (this.written[i] === 0 || cur !== this.last[i]) this.base[i] = cur;
      const v = this.base[i]! * k(i);
      this.set[i]!(v);
      this.last[i] = v;
      this.written[i] = 1;
    }
  }

  /** Forget what was written (the next apply takes the current values as bases). */
  release(): void {
    this.written.fill(0);
  }
}

/** Light colors tinted towards a color (bases rebased like ScaledValues). */
class TintedLights {
  private readonly lights: Light[] = [];
  private base = new Float64Array(0);
  private last = new Float64Array(0);
  private written = false;

  add(light: Light): void {
    this.lights.push(light);
    this.base = new Float64Array(this.lights.length * 3);
    this.last = new Float64Array(this.lights.length * 3);
    this.written = false;
  }

  apply(tint: Color, amount: number): void {
    for (let i = 0; i < this.lights.length; i++) {
      const c = this.lights[i]!.color;
      const o = i * 3;
      if (!this.written || c.r !== this.last[o] || c.g !== this.last[o + 1] || c.b !== this.last[o + 2]) {
        this.base[o] = c.r;
        this.base[o + 1] = c.g;
        this.base[o + 2] = c.b;
      }
      c.r = lerp(this.base[o]!, tint.r, amount);
      c.g = lerp(this.base[o + 1]!, tint.g, amount);
      c.b = lerp(this.base[o + 2]!, tint.b, amount);
      this.last[o] = c.r;
      this.last[o + 1] = c.g;
      this.last[o + 2] = c.b;
    }
    this.written = true;
  }

  release(): void {
    this.written = false;
  }
}

type ColorClass = 'main' | 'emergency' | 'keep';

/** Red (emergency), violet (rift: keep) or anything else (main) – POWER.emergencyRedRatio. */
export function classifyColor(r: number, g: number, b: number): ColorClass {
  if (r > g * POWER.emergencyRedRatio && r > 1e-4) return b > r ? 'keep' : 'emergency';
  return 'main';
}

/**
 * Light groups of a level without `lightGroups`: point / spot lights (main or emergency by color;
 * POWER.keepLights untouched), emissive level meshes (POWER.emissivePrefixes) by emissive color,
 * and light cones (POWER.coneNames: their `uIntensity`).
 */
export function collectLightGroups(root: Object3D): LevelLightGroup[] {
  const main = { lights: [] as Light[], materials: new Set<Material>(), glows: new Set<Material>() };
  const emergency = { lights: [] as Light[], materials: new Set<Material>() };
  root.traverse((o) => {
    if (o instanceof Light) {
      if ((o as Light & { isAmbientLight?: boolean }).isAmbientLight) return;
      if (POWER.keepLights.includes(o.name)) return;
      const c = classifyColor(o.color.r, o.color.g, o.color.b);
      if (c === 'main') main.lights.push(o);
      else if (c === 'emergency') emergency.lights.push(o);
      return;
    }
    if (!(o instanceof Mesh)) return;
    const mats: Material[] = Array.isArray(o.material) ? o.material : [o.material];
    if (POWER.coneNames.includes(o.name)) {
      for (const m of mats) if (hasIntensityUniform(m)) main.glows.add(m);
      return;
    }
    if (!POWER.emissivePrefixes.some((p) => o.name.startsWith(p))) return;
    for (const m of mats) {
      if (!(m instanceof MeshStandardMaterial)) continue;
      const c = classifyColor(m.emissive.r, m.emissive.g, m.emissive.b);
      if (c === 'main') main.materials.add(m);
      else if (c === 'emergency') emergency.materials.add(m);
    }
  });
  return [
    { id: 'main', emergency: false, lights: main.lights, materials: [...main.materials], glows: [...main.glows] },
    { id: 'emergency', emergency: true, lights: emergency.lights, materials: [...emergency.materials] },
  ];
}

function hasIntensityUniform(m: Material): m is ShaderMaterial {
  const u = (m as ShaderMaterial).uniforms as Record<string, { value: unknown }> | undefined;
  return m instanceof ShaderMaterial && u !== undefined && typeof u.uIntensity?.value === 'number';
}

/** Emissive / uIntensity materials of props (machine visuals that go dark). */
export function collectPoweredMaterials(objects: readonly Object3D[], out = new Set<Material>()): Set<Material> {
  for (const root of objects) {
    root.traverse((o) => {
      const mat = (o as Mesh).material as Material | Material[] | undefined;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) {
        if (m instanceof MeshStandardMaterial) {
          if (m.emissiveIntensity > 0 && (m.emissive.r > 0 || m.emissive.g > 0 || m.emissive.b > 0)) out.add(m);
        } else if (hasIntensityUniform(m)) {
          out.add(m);
        }
      }
    });
  }
  return out;
}

function addMaterial(values: ScaledValues, m: Material): void {
  if (m instanceof MeshStandardMaterial) {
    values.add(
      () => m.emissiveIntensity,
      (v) => {
        m.emissiveIntensity = v;
      },
    );
  } else if (hasIntensityUniform(m)) {
    const u = m.uniforms.uIntensity as { value: number };
    values.add(
      () => u.value,
      (v) => {
        u.value = v;
      },
    );
  }
}

/** Power level over a transition: 1 = powered, 0 = blackout (pure; tested). */
export function powerLevel(
  on: boolean,
  t: number,
  reduced: boolean,
  seed: number,
  p: Pick<typeof POWER, 'stutter' | 'down' | 'up' | 'flickerRate' | 'flickerDepth'> = POWER,
): number {
  const stutter = reduced ? 0 : p.stutter;
  if (t < stutter) {
    // Relays chatter: hard on/off flicker around the old state.
    const n = noise1D(t * p.flickerRate, seed) * 0.5 + 0.5;
    const flick = n > 0.5 ? 1 : 1 - p.flickerDepth;
    return on ? (1 - p.flickerDepth) * flick : flick;
  }
  const ramp = on ? p.up : p.down;
  const x = ramp > 0 ? clamp01((t - stutter) / ramp) : 1;
  const s = smoothstep(0, 1, x);
  return on ? s : 1 - s;
}

/** An interactable behind the main power: purchases refuse while unpowered. */
export class PoweredInteractable implements Interactable {
  constructor(
    readonly inner: Interactable,
    private readonly power: { readonly powered: boolean },
  ) {}

  get id(): string {
    return this.inner.id;
  }
  get position(): Interactable['position'] {
    return this.inner.position;
  }
  get range(): number {
    return this.inner.range;
  }
  private get blocked(): boolean {
    return !this.power.powered && this.inner.cost() !== null;
  }
  prompt(): string {
    const p = this.inner.prompt();
    return p !== '' && this.blocked ? POWER.prompt : p;
  }
  cost(): number | null {
    return this.power.powered ? this.inner.cost() : null;
  }
  canInteract(): boolean {
    return !this.blocked && this.inner.canInteract();
  }
  holdTime(): number {
    return this.inner.holdTime();
  }
  repeatHold(): boolean {
    return this.inner.repeatHold?.() === true;
  }
  interact(): void {
    if (this.canInteract()) this.inner.interact();
  }
}

export interface PowerGridDeps {
  events: EventBus<GameEvents> | null;
  reduceFlashing?: boolean;
}

const _tint = new Color();

export class PowerGrid implements PowerApi {
  private _powered = true;
  /** Seconds since the last change; the transition runs while below its length. */
  private t = Number.POSITIVE_INFINITY;
  private active = false;
  private time = 0;
  private seed = 1;
  private reduced: boolean;
  private readonly mainLights = new ScaledValues();
  private readonly tinted = new TintedLights();
  private readonly mainMaterials = new ScaledValues();
  private readonly mainGlows = new ScaledValues();
  private readonly emergencyLights = new ScaledValues();
  private readonly emergencyMaterials = new ScaledValues();
  private readonly props = new ScaledValues();
  /** Every material scaled by some channel (one channel per material: no double scaling). */
  private readonly claimed = new Set<Material>();
  private readonly payload: GameEvents['power:changed'] = { powered: true };
  private readonly emergencyK = (): number => this.emergencyFactor;
  private emergencyFactor = 1;

  constructor(private readonly deps: PowerGridDeps) {
    this.reduced = deps.reduceFlashing === true;
    _tint.setRGB(POWER.emergencyColor[0], POWER.emergencyColor[1], POWER.emergencyColor[2]);
  }

  get powered(): boolean {
    return this._powered;
  }

  /** A transition or an outage is being applied (the per-frame pass runs). */
  get busy(): boolean {
    return this.active;
  }

  /** Current power level 1 (on) .. 0 (blackout). */
  get level(): number {
    return powerLevel(this._powered, this.t, this.reduced, this.seed);
  }

  setLightGroups(groups: readonly LevelLightGroup[]): void {
    const lights = new Set<Light>();
    for (const g of groups) {
      for (const l of g.lights) {
        if (lights.has(l)) continue;
        lights.add(l);
        this.addLight(g.emergency ? this.emergencyLights : this.mainLights, l);
        if (!g.emergency) this.tinted.add(l);
      }
      for (const m of g.materials) this.claim(g.emergency ? this.emergencyMaterials : this.mainMaterials, m);
      for (const m of g.glows ?? []) this.claim(this.mainGlows, m);
    }
  }

  /** Visuals that go dark while unpowered (machine views, a level's powered props). */
  addPoweredVisuals(objects: readonly Object3D[]): void {
    for (const m of collectPoweredMaterials(objects)) this.claim(this.props, m);
  }

  /** Materials of every channel (tests, debug). */
  get materialCount(): number {
    return this.claimed.size;
  }

  /** Register an interactable through this: it refuses purchases while unpowered. */
  gate(i: Interactable): Interactable {
    return new PoweredInteractable(i, this);
  }

  setReducedFlashing(reduced: boolean): void {
    this.reduced = reduced;
  }

  setPowered(on: boolean): void {
    if (on === this._powered) return;
    this._powered = on;
    this.t = 0;
    this.seed = (this.seed * 7 + 3) % 101;
    this.active = true;
    this.payload.powered = on;
    this.deps.events?.emit('power:changed', this.payload);
  }

  /** New run: power on at once (no transition), everything back to its owner's values. */
  reset(): void {
    const wasActive = this.active || !this._powered;
    this._powered = true;
    this.t = Number.POSITIVE_INFINITY;
    if (wasActive) this.applyLevel(1);
    this.active = false;
    this.releaseAll();
  }

  /**
   * Per frame, AFTER the level and the interactable views wrote their intensities. No-op while
   * powered and settled.
   */
  update(dt: number): void {
    if (!this.active) return;
    if (dt > 0) {
      this.t += dt;
      this.time += dt;
    }
    const k = this.level;
    this.applyLevel(k);
    const length = (this.reduced ? 0 : POWER.stutter) + (this._powered ? POWER.up : POWER.down);
    if (this._powered && this.t >= length) {
      // Settled back on: bases restored, the owners own their values again.
      this.applyLevel(1);
      this.active = false;
      this.releaseAll();
    }
  }

  private applyLevel(k: number): void {
    const off = 1 - k;
    this.mainLights.apply(lerp(POWER.lightDim, 1, k));
    this.tinted.apply(_tint, POWER.emergencyTint * off);
    this.mainMaterials.apply(lerp(POWER.materialDim, 1, k));
    this.mainGlows.apply(lerp(POWER.coneDim, 1, k));
    this.props.apply(lerp(POWER.propDim, 1, k));
    const P = POWER.emergencyPulse;
    const depth = this.reduced ? P.reducedDepth : P.depth;
    const pulse = 1 - depth * (0.5 + 0.5 * Math.sin(this.time * P.rate * Math.PI * 2));
    this.emergencyFactor = lerp(1, POWER.emergencyBoost * pulse, off);
    this.emergencyLights.applyEach(this.emergencyK);
    this.emergencyMaterials.applyEach(this.emergencyK);
  }

  private releaseAll(): void {
    this.mainLights.release();
    this.tinted.release();
    this.mainMaterials.release();
    this.mainGlows.release();
    this.props.release();
    this.emergencyLights.release();
    this.emergencyMaterials.release();
  }

  private claim(values: ScaledValues, m: Material): void {
    if (this.claimed.has(m)) return;
    this.claimed.add(m);
    addMaterial(values, m);
    values.release();
  }

  private addLight(values: ScaledValues, l: Light): void {
    values.add(
      () => l.intensity,
      (v) => {
        l.intensity = v;
      },
    );
  }
}
