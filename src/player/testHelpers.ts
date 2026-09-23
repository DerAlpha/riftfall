/**
 * Test doubles for player/physics tests (imported by *.test.ts only; never by game code).
 */
import { PerspectiveCamera, Scene } from 'three';
import type { InputApi, LookOut, RenderApi, SettingsStore, Vec2Out } from '../core/contracts';
import type { Action } from '../defs/input';
import { createDefaultSettings, type Settings, type SettingsSection } from '../save/settingsSchema';

export class FakeInput implements InputApi {
  readonly device = 'kbm' as const;
  readonly pointerLocked = true;
  enabled = true;
  readonly down = new Set<Action>();
  private readonly edges = new Set<Action>();
  readonly move = { x: 0, y: 0 };
  /** Look delta returned by the next getLook() calls (radians; yaw > 0 = turn right). */
  readonly look = { yaw: 0, pitch: 0 };
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
    out.x = this.move.x;
    out.y = this.move.y;
    return out;
  }
  getLook(out: LookOut): LookOut {
    out.yaw = this.look.yaw;
    out.pitch = this.look.pitch;
    return out;
  }
  /** Hold an action and raise its pressed edge for this frame. */
  press(a: Action): void {
    this.down.add(a);
    this.edges.add(a);
  }
  release(a: Action): void {
    this.down.delete(a);
  }
  /** Pressed edge without holding (press + release within one frame). */
  tap(a: Action): void {
    this.edges.add(a);
  }
  requestPointerLock(): void {}
  exitPointerLock(): void {}
  captureBinding(): Promise<null> {
    return Promise.resolve(null);
  }
  rumble(): void {}
  dispose(): void {}
}

export function fakeSettings(): SettingsStore {
  const current = createDefaultSettings();
  return {
    current,
    update<S extends SettingsSection>(section: S, patch: Partial<Settings[S]>): void {
      Object.assign(current[section], patch);
    },
    replace(): void {},
    resetSection(): void {},
  };
}

/** The subset of RenderApi the player systems use, recording the calls. */
export interface FakeRender {
  api: RenderApi;
  camera: PerspectiveCamera;
  viewmodelCamera: PerspectiveCamera;
  viewmodelScene: Scene;
  fovCalls: number[];
  ads: number;
  focus: number;
}

export function fakeRender(): FakeRender {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.05, 400);
  const viewmodelCamera = new PerspectiveCamera(62, 16 / 9, 0.01, 10);
  const scene = new Scene();
  const viewmodelScene = new Scene();
  const rec: FakeRender = {
    api: undefined as unknown as RenderApi,
    camera,
    viewmodelCamera,
    viewmodelScene,
    fovCalls: [],
    ads: 0,
    focus: -1,
  };
  const partial: Partial<RenderApi> = {
    camera,
    viewmodelCamera,
    scene,
    viewmodelScene,
    setFov: (v: number) => {
      rec.fovCalls.push(v);
      camera.fov = v;
    },
    setAdsAmount: (t: number) => {
      rec.ads = t;
    },
    setFocusDistance: (m: number) => {
      rec.focus = m;
    },
  };
  // Only the members above are used by PlayerCamera/ViewmodelRig; WebGL parts are absent in node.
  rec.api = partial as RenderApi;
  return rec;
}
