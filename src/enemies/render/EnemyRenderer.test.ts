import {
  Color,
  InstancedMesh,
  Scene,
  Vector3,
  type InstancedBufferAttribute,
  type Material,
  type Vector4,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Hitbox } from '../../core/contracts';
import { onLog } from '../../core/log';
import { ENEMY_VISUALS, type EnemyVisualDef } from '../../defs/enemyVisuals';
import { createEnemyPose, type EnemyPose } from '../types';
import { EnemyRenderer, cullReach } from './EnemyRenderer';
import { buildTypeGeometry } from './partGeometry';
import { BONE_STRIDE, SLOT, SLOT_STRIDE, compileRig, evaluateRig } from './poseMath';

function make(capacities?: Record<string, number>): {
  r: EnemyRenderer;
  scene: Scene;
  setup: ReturnType<typeof vi.fn<(m: Material) => void>>;
} {
  const scene = new Scene();
  const setup = vi.fn<(m: Material) => void>();
  const r = new EnemyRenderer({ scene, render: { setupMaterial: setup }, capacities, surfaceTexture: false });
  return { r, scene, setup };
}

function mesh(r: EnemyRenderer, type: string): InstancedMesh {
  return r.root.children.find((c) => c.name === `enemies:${type}`) as InstancedMesh;
}

function pose(p: Partial<EnemyPose> = {}): EnemyPose {
  return Object.assign(createEnemyPose(new Color(1, 0.5, 0)), p);
}

const quiet = (): (() => void) => onLog(() => undefined);

describe('EnemyRenderer: instances', () => {
  it('builds one instanced mesh per type, registers its material for shadows, adds itself to the scene', () => {
    const { r, scene, setup } = make();
    expect(scene.children).toContain(r.root);
    for (const type of Object.keys(ENEMY_VISUALS)) {
      const m = mesh(r, type);
      expect(m).toBeInstanceOf(InstancedMesh);
      expect(m.castShadow).toBe(true);
      expect(m.customDepthMaterial).toBeDefined();
      expect(setup).toHaveBeenCalledWith(m.material);
    }
    expect(setup).toHaveBeenCalledTimes(Object.keys(ENEMY_VISUALS).length);
    r.dispose();
    expect(scene.children).not.toContain(r.root);
  });

  it('hands out unique handles up to the default capacities', () => {
    const { r } = make();
    for (const [type, def] of Object.entries(ENEMY_VISUALS)) {
      const cap = def.capacity;
      const handles = new Set<number>();
      for (let i = 0; i < cap; i++) handles.add(r.acquire(type));
      expect(handles.size).toBe(cap);
      expect([...handles].every((h) => h >= 0 && h < cap)).toBe(true);
      expect(r.acquire(type)).toBe(-1);
      expect(r.available(type)).toBe(0);
    }
    r.dispose();
  });

  it('release frees a slot; double / invalid releases are ignored; unknown types return -1', () => {
    const { r } = make({ spitter: 2 });
    const a = r.acquire('spitter');
    const b = r.acquire('spitter');
    expect(r.acquire('spitter')).toBe(-1);
    r.release('spitter', a);
    r.release('spitter', a);
    r.release('spitter', 99);
    r.release('spitter', -1);
    r.release('nope', 0);
    expect(r.available('spitter')).toBe(1);
    const c = r.acquire('spitter');
    expect(c).toBe(a);
    expect(c).not.toBe(b);
    const off = quiet();
    expect(r.acquire('boss_unknown')).toBe(-1);
    off();
    r.dispose();
  });

  it('draws only committed instances, densely packed, uploading only the used range', () => {
    const { r } = make();
    const handles = [r.acquire('swarmer'), r.acquire('swarmer'), r.acquire('swarmer')];
    handles.forEach((h, i) => r.setTransform('swarmer', h, new Vector3(i, 0, 0), 0));
    r.update(0.016, 1);
    expect(mesh(r, 'swarmer').count).toBe(0);
    r.commitTick();
    r.release('swarmer', handles[1]!);
    r.update(0.016, 1);
    const m = mesh(r, 'swarmer');
    expect(m.count).toBe(2);
    expect(m.visible).toBe(true);
    expect(m.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 32 }]);
    const pose0 = m.geometry.getAttribute('rfPose0') as InstancedBufferAttribute;
    expect(pose0.updateRanges).toEqual([{ start: 0, count: 8 }]);
    const xs = [m.instanceMatrix.array[12], m.instanceMatrix.array[28]].sort();
    expect(xs).toEqual([0, 2]);
    expect(r.stats.instances).toBe(2);
    expect(r.stats.drawCalls).toBe(1);
    expect(mesh(r, 'tank').visible).toBe(false);
    r.dispose();
  });

  it('interpolates transforms between tick snapshots and snaps new / teleported instances', () => {
    const { r } = make();
    const h = r.acquire('tank');
    r.setTransform('tank', h, new Vector3(10, 0, 0), 0);
    r.commitTick();
    r.update(0.016, 0);
    const m = mesh(r, 'tank');
    // First commit: no interpolation from the slot's stale data.
    expect(m.instanceMatrix.array[12]).toBeCloseTo(10, 5);
    r.setTransform('tank', h, new Vector3(11, 0, 0), Math.PI / 2);
    r.commitTick();
    r.update(0.016, 0.5);
    expect(m.instanceMatrix.array[12]).toBeCloseTo(10.5, 5);
    // Yaw π/4 → cos in element 0.
    expect(m.instanceMatrix.array[0]).toBeCloseTo(Math.cos(Math.PI / 4), 5);
    r.setTransform('tank', h, new Vector3(50, 0, 0), Math.PI / 2);
    r.commitTick();
    r.update(0.016, 0.5);
    expect(m.instanceMatrix.array[12]).toBeCloseTo(50, 5);
    r.dispose();
  });

  it('interpolates the gait phase across the 2π wrap and keeps it in range', () => {
    const { r } = make();
    const h = r.acquire('swarmer');
    r.setPose('swarmer', h, pose({ phase: Math.PI * 2 - 0.1, locomotion: 1 }));
    r.commitTick();
    r.setPose('swarmer', h, pose({ phase: 0.1, locomotion: 1 }));
    r.commitTick();
    r.update(0.016, 0.5);
    const p0 = mesh(r, 'swarmer').geometry.getAttribute('rfPose0');
    const phase = p0.getY(0);
    expect(phase < 0.01 || phase > Math.PI * 2 - 0.01).toBe(true);
    r.dispose();
  });

  it('attack progress interpolates forward only (a restarted attack does not replay the strike)', () => {
    const { r } = make();
    const h = r.acquire('swarmer');
    const p0 = (): number => mesh(r, 'swarmer').geometry.getAttribute('rfPose0').getW(0);
    r.setPose('swarmer', h, pose({ attackId: 0, attack: 0.2 }));
    r.commitTick();
    r.setPose('swarmer', h, pose({ attackId: 0, attack: 0.4 }));
    r.commitTick();
    r.update(0.016, 0.5);
    expect(p0()).toBeCloseTo(0.3, 5);
    // Finished and restarted within one tick: start at the new progress, no sweep back from 1.
    r.setPose('swarmer', h, pose({ attackId: 0, attack: 0.95 }));
    r.commitTick();
    r.setPose('swarmer', h, pose({ attackId: 0, attack: 0.05 }));
    r.commitTick();
    r.update(0.016, 0.5);
    expect(p0()).toBeCloseTo(0.05, 5);
    // A different attack also starts at its own progress.
    r.setPose('swarmer', h, pose({ attackId: 1, attack: 0.1 }));
    r.commitTick();
    r.update(0.016, 0.5);
    expect(p0()).toBeCloseTo(0.1, 5);
    r.dispose();
  });

  it('skips fully dissolved instances and shows rift tears while emerging', () => {
    const { r } = make();
    const a = r.acquire('spitter');
    const b = r.acquire('spitter');
    r.setPose('spitter', a, pose({ death: 1, dissolve: 1 }));
    r.setPose('spitter', b, pose({ emerge: 0.4 }));
    r.commitTick();
    r.update(0.016, 1);
    expect(mesh(r, 'spitter').count).toBe(1);
    expect(r.hasVolumetricContent).toBe(true);
    expect(r.stats.drawCalls).toBe(2);
    r.setPose('spitter', b, pose({ emerge: 1 }));
    r.commitTick();
    r.commitTick();
    r.update(0.016, 1);
    expect(r.hasVolumetricContent).toBe(false);
    r.dispose();
  });

  it('sanitizes non-finite pose values', () => {
    const { r } = make();
    const h = r.acquire('swarmer');
    r.setPose('swarmer', h, pose({ locomotion: Number.NaN, scale: Number.POSITIVE_INFINITY }));
    r.setTransform('swarmer', h, new Vector3(Number.NaN, 0, 0), Number.NaN);
    r.commitTick();
    r.update(0.016, 1);
    const m = mesh(r, 'swarmer');
    expect(Array.from(m.instanceMatrix.array.slice(0, 16)).every(Number.isFinite)).toBe(true);
    const boxes: Hitbox[] = [];
    const n = r.computeHitboxes('swarmer', h, boxes);
    expect(boxes.slice(0, n).every((b) => Number.isFinite(b.a.x + b.b.y + b.radius))).toBe(true);
    r.dispose();
  });
});

describe('EnemyRenderer: CPU pose mirror', () => {
  it('computes world hitboxes for the latest pose (grows and reuses `out`)', () => {
    const { r } = make();
    const h = r.acquire('swarmer');
    r.setTransform('swarmer', h, new Vector3(3, 0, -4), Math.PI / 2);
    r.setPose('swarmer', h, pose({ scale: 1.5 }));
    const out: Hitbox[] = [];
    const n = r.computeHitboxes('swarmer', h, out);
    expect(n).toBeGreaterThan(5);
    expect(out.length).toBe(n);
    const head = out.find((b) => b.zone === 'head')!;
    // Model +Z (the head) faces world +X at yaw 90°.
    expect(head.a.x).toBeGreaterThan(3.4);
    expect(Math.abs(head.a.z + 4)).toBeLessThan(0.1);
    expect(head.radius).toBeCloseTo(0.14 * 1.5, 1);
    const kept = out[0];
    r.computeHitboxes('swarmer', h, out);
    expect(out[0]).toBe(kept);
    expect(out.length).toBe(n);
    r.dispose();
  });

  it('bounds contain all hitboxes; aim point and sockets lie inside the bounds', () => {
    const { r } = make();
    for (const [type, sockets] of [
      ['swarmer', ['jaws', 'chest']],
      ['spitter', ['mouth', 'sac']],
      ['tank', ['fists', 'fistL', 'core']],
    ] as const) {
      const h = r.acquire(type);
      r.setTransform(type, h, new Vector3(1, 0.5, 2), 0.7);
      r.setPose(type, h, pose({ locomotion: 1.5, phase: 2, attackId: 0, attack: 0.5 }));
      const out: Hitbox[] = [];
      const n = r.computeHitboxes(type, h, out);
      const c = new Vector3();
      const radius = r.computeBounds(type, h, c);
      for (let i = 0; i < n; i++) {
        const b = out[i]!;
        expect(b.a.distanceTo(c) + b.radius, type).toBeLessThanOrEqual(radius + 1e-5);
        expect(b.b.distanceTo(c) + b.radius, type).toBeLessThanOrEqual(radius + 1e-5);
      }
      const aim = r.computeAimPoint(type, h, new Vector3());
      expect(aim.distanceTo(c), type).toBeLessThan(radius);
      for (const s of sockets)
        expect(r.computeSocket(type, h, s, new Vector3()).distanceTo(c), `${type}:${s}`).toBeLessThan(
          radius + 0.3,
        );
    }
    r.dispose();
  });

  it('the fists socket is the midpoint of both fists and drops to the floor at the slam strike', () => {
    const { r } = make();
    const h = r.acquire('tank');
    r.setTransform('tank', h, new Vector3(0, 0, 0), 0);
    const slam = ENEMY_VISUALS.tank.attacks.findIndex((a) => a.id === 'slam');
    r.setPose('tank', h, pose({ attackId: slam, attack: ENEMY_VISUALS.tank.attacks[slam]!.strike }));
    const fists = r.computeSocket('tank', h, 'fists', new Vector3());
    const l = r.computeSocket('tank', h, 'fistL', new Vector3());
    const rr = r.computeSocket('tank', h, 'fistR', new Vector3());
    expect(fists.distanceTo(l.clone().add(rr).multiplyScalar(0.5))).toBeLessThan(1e-5);
    expect(fists.y).toBeLessThan(0.8);
    expect(fists.z).toBeGreaterThan(0.2);
    r.dispose();
  });

  it('unknown sockets fall back to the aim point; invalid handles leave outputs untouched', () => {
    const { r } = make();
    const h = r.acquire('spitter');
    const aim = r.computeAimPoint('spitter', h, new Vector3());
    const off = quiet();
    expect(r.computeSocket('spitter', h, 'tail', new Vector3()).distanceTo(aim)).toBeLessThan(1e-6);
    off();
    const out = new Vector3(7, 7, 7);
    expect(r.computeSocket('spitter', 15, 'mouth', out)).toBe(out);
    expect(out.x).toBe(7);
    expect(r.computeHitboxes('spitter', 15, [])).toBe(0);
    expect(r.computeBounds('tank', 0, new Vector3())).toBe(0);
    r.dispose();
  });

  it('hitboxes follow the latest pose, not the interpolated frame', () => {
    const { r } = make();
    const h = r.acquire('swarmer');
    r.setPose('swarmer', h, pose({ death: 0 }));
    const out: Hitbox[] = [];
    r.computeHitboxes('swarmer', h, out);
    const aliveY = out.find((b) => b.zone === 'body')!.a.y;
    r.setPose('swarmer', h, pose({ death: 1 }));
    r.computeHitboxes('swarmer', h, out);
    expect(out.find((b) => b.zone === 'body')!.a.y).toBeLessThan(aliveY - 0.1);
    r.dispose();
  });
});

describe('EnemyRenderer: culling', () => {
  it('culls single instances in the vertex shaders with the type reach (color, depth, distance)', () => {
    const { r } = make();
    for (const [id, def] of Object.entries(ENEMY_VISUALS) as [string, EnemyVisualDef][]) {
      const m = mesh(r, id);
      const reach = cullReach(buildTypeGeometry(compileRig(id, def).parts), def.cullMargin);
      expect(reach).toBeGreaterThan(0);
      // One uniform object shared by the lit material and both shadow materials.
      let radius: { value: number } | undefined;
      for (const mat of [m.material as Material, m.customDepthMaterial!, m.customDistanceMaterial!]) {
        const shader = {
          vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
          fragmentShader:
            '#include <common>\n#include <clipping_planes_fragment>\n#include <color_fragment>\n' +
            '#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <normal_fragment_maps>\n' +
            '#include <emissivemap_fragment>\n#include <lights_physical_fragment>\n#include <dithering_fragment>',
          uniforms: {} as Record<string, { value: number }>,
        };
        mat.onBeforeCompile(shader as never, null as never);
        const u = shader.uniforms.rfCullRadius;
        expect(u?.value, `${id} ${mat.type}`).toBeCloseTo(reach, 6);
        radius ??= u;
        expect(u).toBe(radius);
      }
    }
    r.dispose();
  });

  it("hands the level's sunlit box to the sun shadow passes (off without one)", () => {
    const sunMin = (r: EnemyRenderer): { value: Vector4 } => {
      const shader = {
        vertexShader: '#include <common>\n#include <begin_vertex>',
        fragmentShader:
          '#include <common>\n#include <clipping_planes_fragment>\n#include <dithering_fragment>',
        uniforms: {} as Record<string, { value: Vector4 }>,
      };
      mesh(r, 'swarmer').customDepthMaterial!.onBeforeCompile(shader as never, null as never);
      return shader.uniforms.rfSunMin!;
    };
    const plain = make().r;
    expect(sunMin(plain).value.w).toBe(0);
    plain.dispose();
    const bounds = { min: { x: -11, y: 0, z: -7 }, max: { x: 6, y: 17.7, z: 10.3 } };
    const r = new EnemyRenderer({
      scene: new Scene(),
      render: { setupMaterial: () => {} },
      surfaceTexture: false,
      sunCasterBounds: bounds,
    });
    expect(sunMin(r).value.toArray()).toEqual([-11, 0, -7, 1]);
    r.setSunCasterBounds(null);
    expect(sunMin(r).value.w).toBe(0);
    r.dispose();
  });

  it('the cull reach covers every visible vertex of every pose (no popping at the screen edge)', () => {
    for (const [id, def] of Object.entries(ENEMY_VISUALS) as [string, EnemyVisualDef][]) {
      const rig = compileRig(id, def);
      const geo = buildTypeGeometry(rig.parts);
      const reach = cullReach(geo, def.cullMargin);
      const pos = geo.getAttribute('position');
      const part = geo.getAttribute('partId');
      const mats = new Float32Array(rig.bones.length * BONE_STRIDE);
      const poses: Float32Array[] = [];
      const slot = (): Float32Array => {
        const s = new Float32Array(SLOT_STRIDE);
        s[SLOT.scale] = 1;
        s[SLOT.attackId] = -1;
        s[SLOT.emerge] = 1;
        poses.push(s);
        return s;
      };
      // Every attack through its envelope while running flat out, staggered, looking to the limits.
      for (let a = -1; a < rig.attackIds.length; a++)
        for (let t = 0.05; t < 1; t += 0.05)
          for (let k = 0; k < 4; k++) {
            const s = slot();
            s[SLOT.attackId] = a;
            s[SLOT.attack] = t;
            s[SLOT.locomotion] = 2;
            s[SLOT.phase] = (k * Math.PI) / 2 + t;
            s[SLOT.stagger] = k % 2;
            s[SLOT.lookYaw] = k < 2 ? 9 : -9;
            s[SLOT.lookPitch] = k % 2 ? 9 : -9;
          }
      // Random mixes (death, emergence, partial drivers).
      for (let i = 0; i < 200; i++) {
        const r = (k: number): number => {
          const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
          return x - Math.floor(x);
        };
        const s = slot();
        s[SLOT.attackId] = Math.floor(r(1) * (rig.attackIds.length + 1)) - 1;
        s[SLOT.attack] = r(2);
        s[SLOT.locomotion] = r(3) * 2;
        s[SLOT.phase] = r(4) * Math.PI * 2;
        s[SLOT.stagger] = r(5) > 0.5 ? r(6) : 0;
        s[SLOT.death] = r(7) > 0.6 ? r(8) : 0;
        s[SLOT.emerge] = r(9) > 0.7 ? r(10) : 1;
        s[SLOT.lookYaw] = (r(11) - 0.5) * 4;
        s[SLOT.lookPitch] = (r(12) - 0.5) * 3;
      }
      let worst = 0;
      for (const [i, s] of poses.entries()) {
        evaluateRig(rig, s, 0, i * 0.37, 0.3, mats);
        for (let v = 0; v < pos.count; v++) {
          const m = rig.parts[Math.round(part.getX(v))]!.bone * BONE_STRIDE;
          const x = pos.getX(v);
          const y = pos.getY(v);
          const z = pos.getZ(v);
          const wy = mats[m + 4]! * x + mats[m + 5]! * y + mats[m + 6]! * z + mats[m + 7]!;
          // Emerging enemies are clipped at the rift plane (nothing below the feet is drawn).
          if (s[SLOT.emerge]! < 1 && wy < 0) continue;
          const wx = mats[m]! * x + mats[m + 1]! * y + mats[m + 2]! * z + mats[m + 3]!;
          const wz = mats[m + 8]! * x + mats[m + 9]! * y + mats[m + 10]! * z + mats[m + 11]!;
          worst = Math.max(worst, Math.hypot(wx, wy, wz));
        }
      }
      // Headroom for driver mixes the sampling misses (m at scale 1).
      expect(worst + 0.15, id).toBeLessThan(reach);
    }
  });
});
