import { Euler, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { onLog } from '../../core/log';
import { ENEMY_RENDER, ENEMY_VISUALS, type EnemyVisualDef } from '../../defs/enemyVisuals';
import {
  BONE_STRIDE,
  CHANNEL_CODE,
  CODE_STRIDE,
  DRIVER_CODE,
  RARE_DRIVER_MASK,
  SLOT,
  SLOT_STRIDE,
  activeDriverMask,
  attackEnvelope,
  boneScale,
  boneTransformPoint,
  HITBOX_STRIDE,
  boundsOfHitboxes,
  boundsOfPacked,
  compileRig,
  computeDrivers,
  createDrivers,
  evaluateRig,
  motionValue,
  slotModelToWorld,
  yawToward,
  type CompiledRig,
} from './poseMath';

type PoseInit = Partial<Record<keyof typeof SLOT, number>>;

function slot(init: PoseInit = {}): Float32Array {
  const s = new Float32Array(SLOT_STRIDE);
  s[SLOT.scale] = 1;
  s[SLOT.attackId] = -1;
  s[SLOT.emerge] = 1;
  for (const [k, v] of Object.entries(init)) s[SLOT[k as keyof typeof SLOT]] = v;
  return s;
}

interface Box {
  a: Vector3;
  b: Vector3;
  radius: number;
  zone: string;
}

/** World hitboxes via the CPU mirror (same path as EnemyRenderer.computeHitboxes). */
function hitboxes(rig: CompiledRig, s: Float32Array, time = 0, seed = 0): Box[] {
  const mats = new Float32Array(rig.bones.length * BONE_STRIDE);
  evaluateRig(rig, s, 0, time, seed, mats);
  return rig.hitboxes.map((h) => ({
    a: slotModelToWorld(s, 0, boneTransformPoint(mats, 0, h.bone, h.a, new Vector3())),
    b: slotModelToWorld(s, 0, boneTransformPoint(mats, 0, h.bone, h.b, new Vector3())),
    radius: h.radius * s[SLOT.scale]! * boneScale(mats, 0, h.bone),
    zone: h.zone,
  }));
}

function boxIndex(rig: CompiledRig, bone: string, zone?: string): number {
  const b = rig.boneIndex.get(bone)!;
  return rig.hitboxes.findIndex((h) => h.bone === b && (zone === undefined || h.zone === zone));
}

const RIGS = Object.fromEntries(
  Object.entries(ENEMY_VISUALS).map(([id, def]) => [id, compileRig(id, def as EnemyVisualDef)]),
) as Record<keyof typeof ENEMY_VISUALS, CompiledRig>;

/** Deterministic pseudo-random poses. */
function randomPose(rig: CompiledRig, i: number): Float32Array {
  const r = (k: number): number => {
    const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const attackId = Math.floor(r(1) * (rig.attackIds.length + 1)) - 1;
  return slot({
    locomotion: r(2) * 2,
    phase: r(3) * 20,
    attackId,
    attack: r(4),
    stagger: r(5) > 0.7 ? r(6) : 0,
    death: r(7) > 0.7 ? r(8) : 0,
    emerge: r(9) > 0.8 ? r(10) : 1,
    lookYaw: (r(11) - 0.5) * 3,
    lookPitch: (r(12) - 0.5) * 2,
    yaw: r(13) * 7,
    x: (r(14) - 0.5) * 20,
    z: (r(15) - 0.5) * 20,
    scale: 0.8 + r(16) * 0.5,
  });
}

describe('compileRig', () => {
  it('compiles every visual def without warnings, within the shader limits', () => {
    const warnings: string[] = [];
    const off = onLog((e) => e.level === 'warn' && warnings.push(e.message));
    for (const [id, def] of Object.entries(ENEMY_VISUALS)) {
      const rig = compileRig(id, def);
      expect(rig.bones.length, id).toBeLessThanOrEqual(ENEMY_RENDER.maxBones);
      expect(rig.maxDepth, id).toBeLessThanOrEqual(ENEMY_RENDER.maxDepth);
      expect(rig.zoneNames.length, id).toBeLessThanOrEqual(ENEMY_RENDER.maxZones);
      for (const b of rig.bones)
        expect(b.motionCount, `${id}:${b.name}`).toBeLessThanOrEqual(ENEMY_RENDER.maxMotionsPerBone);
      expect(rig.layout.texels).toBeLessThanOrEqual(rig.layout.width * rig.layout.height);
    }
    off();
    expect(warnings).toEqual([]);
  });

  it('orders bones parents-first and builds mirrored twins', () => {
    const rig = RIGS.swarmer;
    rig.bones.forEach((b, i) => expect(b.parent).toBeLessThan(i));
    const l = rig.bones[rig.boneIndex.get('legF_L')!]!;
    const r = rig.bones[rig.boneIndex.get('legF_R')!]!;
    expect(r.pivot).toEqual([-l.pivot[0], l.pivot[1], l.pivot[2]]);
    // The right shin hangs off the right thigh; centerline parts mirrored onto the same bone.
    expect(rig.bones[rig.boneIndex.get('shinF_R')!]!.parent).toBe(rig.boneIndex.get('legF_R'));
    expect(rig.boneIndex.has('body_R')).toBe(false);
    const d = rig.data;
    const motion = (bone: { motionStart: number }, k: number): Float32Array =>
      d.subarray(
        (rig.layout.motionBase + (bone.motionStart + k) * 2) * 4,
        (rig.layout.motionBase + (bone.motionStart + k) * 2) * 4 + 8,
      );
    // First leg motion: ry gait swing – mirrored twin negates the amplitude and shifts the phase by π.
    const ml = motion(l, 0);
    const mr = motion(r, 0);
    expect(ml[0]).toBe(DRIVER_CODE.gait * CODE_STRIDE + CHANNEL_CODE.ry);
    expect(mr[2]).toBeCloseTo(-ml[2]!, 6);
    expect(ml[2]).toBeCloseTo((16 * Math.PI) / 180, 6);
    expect(mr[5]! - ml[5]!).toBeCloseTo(Math.PI, 6);
  });

  it('packs the header, attack timings and look limits', () => {
    for (const [id, rig] of Object.entries(RIGS)) {
      const def = ENEMY_VISUALS[id as keyof typeof ENEMY_VISUALS];
      const d = rig.data;
      expect([d[0], d[1], d[2], d[3]]).toEqual([
        rig.bones.length,
        rig.parts.length,
        def.attacks.length,
        rig.motionCount,
      ]);
      expect(d[4]).toBeCloseTo((def.look.yawMaxDeg * Math.PI) / 180, 6);
      def.attacks.forEach((a, i) => {
        const o = (rig.layout.attackBase + i) * 4;
        expect(d[o]).toBeCloseTo(a.windup, 6);
        expect(d[o + 1]).toBeCloseTo(a.strike, 6);
        expect(a.windup).toBeLessThan(a.strike);
        expect(a.strike).toBeLessThan(1);
      });
      // Every part points at a valid bone and zone.
      rig.parts.forEach((p, i) => {
        const o = (rig.layout.partBase + i) * 4;
        expect(d[o]).toBe(p.bone);
        expect(d[o + 1]).toBe(p.zone);
      });
    }
  });

  it('uses whole gait cycles and ordered windows (seamless GPU phase wrap)', () => {
    for (const [id, def] of Object.entries(ENEMY_VISUALS)) {
      for (const b of def.bones) {
        for (const m of b.motions ?? []) {
          if (m.drive === 'gait') expect(Number.isInteger(m.freq ?? 1), `${id}:${b.name}`).toBe(true);
          if (m.window) expect(m.window[0], `${id}:${b.name}`).toBeLessThan(m.window[1]);
        }
      }
    }
  });

  it('survives broken content (unknown bones, zones, attacks, parent cycles)', () => {
    const base = ENEMY_VISUALS.swarmer;
    const broken: EnemyVisualDef = {
      ...base,
      bones: [
        { name: 'a', parent: 'b', pivot: [0, 0, 0] },
        {
          name: 'b',
          parent: 'a',
          pivot: [0, 1, 0],
          motions: [{ ch: 'rx', drive: 'attack', attack: 'nope', amp: 10 }],
        },
        { name: 'c', parent: 'missing', pivot: [0, 1, 0] },
      ],
      parts: [
        { shape: 'ellipsoid', bone: 'ghost', zone: 'nowhere', center: [0, 1, 0], radii: [0.2, 0.2, 0.2] },
      ],
      hitboxes: [{ bone: 'ghost', shape: 'sphere', zone: 'body', a: [0, 1, 0], radius: 0.2 }],
      sockets: {},
      aimSocket: 'missing',
    };
    const off = onLog(() => undefined);
    const rig = compileRig('broken', broken);
    off();
    expect(rig.bones.length).toBe(3);
    expect(rig.motionCount).toBe(0);
    expect(rig.parts[0]!.bone).toBe(0);
    const mats = new Float32Array(rig.bones.length * BONE_STRIDE);
    expect(() => evaluateRig(rig, slot({ locomotion: 1 }), 0, 0, 0, mats)).not.toThrow();
    expect(mats.every(Number.isFinite)).toBe(true);
  });
});

describe('compileRig: driver masks, windows, mirroring', () => {
  const base = ENEMY_VISUALS.swarmer;
  const minimal = (bones: EnemyVisualDef['bones']): EnemyVisualDef => ({
    ...base,
    bones,
    parts: [
      { shape: 'ellipsoid', bone: bones[0]!.name, zone: 'flesh', center: [0, 1, 0], radii: [0.2, 0.2, 0.2] },
    ],
    hitboxes: [],
    sockets: {},
  });

  it("packs each bone's driver mask (the OR of its motions' drivers)", () => {
    for (const rig of Object.values(RIGS)) {
      rig.bones.forEach((b, i) => {
        let mask = 0;
        for (let k = 0; k < b.motionCount; k++) mask |= 1 << rig.motionDrv[b.motionStart + k]!;
        expect(rig.data[(rig.layout.boneBase + i * 2 + 1) * 4 + 2], b.name).toBe(mask);
      });
    }
  });

  it('stores each bone common motions first; the rare block holds attack/stagger/death/emerge', () => {
    for (const rig of Object.values(RIGS)) {
      rig.bones.forEach((b, i) => {
        const t1 = (rig.layout.boneBase + i * 2 + 1) * 4;
        expect(rig.data[t1 + 3], b.name).toBe(b.commonCount);
        for (let k = 0; k < b.motionCount; k++) {
          const rare = ((1 << rig.motionDrv[b.motionStart + k]!) & RARE_DRIVER_MASK) !== 0;
          expect(rare, `${b.name}#${k}`).toBe(k >= b.commonCount);
        }
      });
    }
    for (const d of ['attack', 'stagger', 'death', 'emerge'] as const)
      expect(RARE_DRIVER_MASK & (1 << DRIVER_CODE[d])).not.toBe(0);
    expect(RARE_DRIVER_MASK & ((1 << DRIVER_CODE.gait) | (1 << DRIVER_CODE.idle))).toBe(0);
  });

  it('active driver mask: only drivers that can move anything this pose', () => {
    const rig = RIGS.swarmer;
    const d = createDrivers();
    const mask = (init: PoseInit): number => {
      computeDrivers(rig, slot(init), 0, 0, 0, d);
      return activeDriverMask(d);
    };
    const bit = (k: keyof typeof DRIVER_CODE): number => 1 << DRIVER_CODE[k];
    expect(mask({})).toBe(bit('rest') | bit('idle'));
    expect(mask({ locomotion: 1, lookYaw: 0.2, attackId: 0 })).toBe(
      bit('rest') | bit('idle') | bit('gait') | bit('loco') | bit('lookYaw') | bit('attack'),
    );
    // Dying: only death (and emergence / rest) still move bones.
    expect(mask({ death: 1, locomotion: 2, stagger: 1, lookYaw: 1 })).toBe(bit('rest') | bit('death'));
    expect(mask({ emerge: 0.5 })).toBe(bit('rest') | bit('idle') | bit('emerge'));
  });

  it('normalizes windows: ordered, never degenerate, a driver at 0 yields 0 and at 1 the full amplitude', () => {
    const def = minimal([
      {
        name: 'root',
        parent: null,
        pivot: [0, 1, 0],
        motions: [
          { ch: 'ty', drive: 'death', amp: 1, window: [0, 0] },
          { ch: 'ty', drive: 'stagger', amp: 1, window: [1, 1] },
          { ch: 'ty', drive: 'emerge', amp: 1, window: [0.8, 0.2] },
        ],
      },
    ]);
    const rig = compileRig('win', def);
    const d = createDrivers();
    for (let k = 0; k < 3; k++) {
      const t = rig.layout.motionBase + k * 2;
      const w0 = rig.data[(t + 1) * 4 + 2]!;
      const w1 = rig.data[(t + 1) * 4 + 3]!;
      expect(w0).toBeGreaterThanOrEqual(0);
      expect(w1).toBeLessThanOrEqual(1);
      expect(w1 - w0).toBeGreaterThan(0);
      for (const [v, want] of [
        [0, 0],
        [1, 1],
      ] as const) {
        computeDrivers(rig, slot({ death: v, stagger: v, emerge: 1 - v }), 0, 0, 0, d);
        // Stagger fades with death: test it alive.
        if (k === 1) computeDrivers(rig, slot({ stagger: v }), 0, 0, 0, d);
        expect(motionValue(rig.data, t, d), `motion ${k} at ${v}`).toBeCloseTo(want, 6);
      }
    }
  });

  it('mirrored twins flip swings but look the same way; mirrored bones must be named _L', () => {
    const def = minimal([
      { name: 'root', parent: null, pivot: [0, 1, 0] },
      {
        name: 'eye_L',
        parent: 'root',
        pivot: [0.1, 1.2, 0.2],
        mirror: true,
        motions: [
          { ch: 'ry', drive: 'lookYaw', amp: 1 },
          { ch: 'ry', drive: 'gait', amp: 10 },
        ],
      },
    ]);
    const rig = compileRig('eyes', def);
    const l = rig.bones[rig.boneIndex.get('eye_L')!]!;
    const r = rig.bones[rig.boneIndex.get('eye_R')!]!;
    const amp = (b: typeof l, k: number): number =>
      rig.data[(rig.layout.motionBase + (b.motionStart + k) * 2) * 4 + 2]!;
    expect(amp(r, 0)).toBeCloseTo(amp(l, 0), 6);
    expect(amp(r, 1)).toBeCloseTo(-amp(l, 1), 6);

    const warnings: string[] = [];
    const off = onLog((e) => e.level === 'warn' && warnings.push(e.message));
    compileRig('badmirror', minimal([{ name: 'root', parent: null, pivot: [0, 1, 0], mirror: true }]));
    off();
    expect(warnings.some((w) => w.includes('_L'))).toBe(true);
  });
});

describe('drivers and motions', () => {
  it('attack envelope: rest at both ends, wind-up pose, strike pose', () => {
    const e = { eW: 0, eS: 0 };
    attackEnvelope(0, 0.4, 0.6, e);
    expect([e.eW, e.eS]).toEqual([0, 0]);
    attackEnvelope(0.4, 0.4, 0.6, e);
    expect(e.eW).toBeCloseTo(1, 6);
    attackEnvelope(0.6, 0.4, 0.6, e);
    expect(e.eS).toBeCloseTo(1, 6);
    attackEnvelope(1, 0.4, 0.6, e);
    expect(e.eW + e.eS).toBeCloseTo(0, 6);
    // Continuous.
    let prev = { eW: 0, eS: 0 };
    for (let t = 0; t <= 1; t += 0.001) {
      const cur = { eW: 0, eS: 0 };
      attackEnvelope(t, 0.4, 0.6, cur);
      expect(Math.abs(cur.eW - prev.eW)).toBeLessThan(0.02);
      expect(Math.abs(cur.eS - prev.eS)).toBeLessThan(0.02);
      prev = cur;
    }
  });

  it('gait amplitude follows locomotion (0 idle, amp walking, amp2 running) and fades with death', () => {
    const rig = RIGS.swarmer;
    const leg = rig.bones[rig.boneIndex.get('legF_L')!]!;
    const texel = rig.layout.motionBase + leg.motionStart * 2;
    const d = createDrivers();
    const at = (loc: number, death = 0): number => {
      computeDrivers(rig, slot({ locomotion: loc, phase: Math.PI / 2, death }), 0, 0, 0, d);
      return motionValue(rig.data, texel, d);
    };
    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(1)).toBeCloseTo((16 * Math.PI) / 180, 5);
    expect(at(2)).toBeCloseTo((24 * Math.PI) / 180, 5);
    expect(at(2, 1)).toBeCloseTo(0, 6);
  });

  it('attack motions only play for their own attack id; look angles are clamped', () => {
    const rig = RIGS.swarmer;
    const d = createDrivers();
    computeDrivers(rig, slot({ attackId: 7, attack: 0.5 }), 0, 0, 0, d);
    expect(d.attack).toBe(-1);
    computeDrivers(rig, slot({ lookYaw: 10, lookPitch: -10 }), 0, 0, 0, d);
    expect(d.lookYaw).toBeCloseTo(rig.lookYawMax, 6);
    expect(d.lookPitch).toBeCloseTo(-rig.lookPitchMax, 6);
  });
});

describe('evaluateRig', () => {
  it('matches an independent three.js hierarchy (Euler YXZ about pivots, parents first)', () => {
    for (const [id, rig] of Object.entries(RIGS)) {
      for (let i = 0; i < 12; i++) {
        const s = randomPose(rig, i);
        const time = i * 0.37;
        const seed = (i * 0.618) % 1;
        const mats = new Float32Array(rig.bones.length * BONE_STRIDE);
        evaluateRig(rig, s, 0, time, seed, mats);
        const d = createDrivers();
        computeDrivers(rig, s, 0, time, seed, d);
        const world: Matrix4[] = [];
        rig.bones.forEach((b, bi) => {
          const rot = new Vector3();
          const move = new Vector3();
          const scl = new Vector3(1, 1, 1);
          for (let k = 0; k < b.motionCount; k++) {
            const texel = rig.layout.motionBase + (b.motionStart + k) * 2;
            const v = motionValue(rig.data, texel, d);
            const ch = Math.round(rig.data[texel * 4]!) % CODE_STRIDE;
            if (ch < 3) rot.setComponent(ch, rot.getComponent(ch) + v);
            else if (ch < 6) move.setComponent(ch - 3, move.getComponent(ch - 3) + v);
            else if (ch < 9) scl.setComponent(ch - 6, scl.getComponent(ch - 6) + v);
            else scl.addScalar(v);
          }
          scl.max(new Vector3(0.05, 0.05, 0.05));
          const c = new Vector3(...b.pivot);
          const local = new Matrix4()
            .makeTranslation(c.x + move.x, c.y + move.y, c.z + move.z)
            .multiply(new Matrix4().makeRotationFromEuler(new Euler(rot.x, rot.y, rot.z, 'YXZ')))
            .multiply(new Matrix4().makeScale(scl.x, scl.y, scl.z))
            .multiply(new Matrix4().makeTranslation(-c.x, -c.y, -c.z));
          world[bi] = b.parent < 0 ? local : world[b.parent]!.clone().multiply(local);
        });
        for (let bi = 0; bi < rig.bones.length; bi++) {
          const p = new Vector3(0.1 * bi, 0.3, -0.2).applyMatrix4(world[bi]!);
          const q = boneTransformPoint(mats, 0, bi, [0.1 * bi, 0.3, -0.2], new Vector3());
          expect(q.distanceTo(p), `${id}:${rig.bones[bi]!.name}`).toBeLessThan(1e-4);
        }
      }
    }
  });

  it('an idle, alive enemy stays at its rest pose apart from idle breathing', () => {
    const rig = RIGS.swarmer;
    const mats = new Float32Array(rig.bones.length * BONE_STRIDE);
    evaluateRig(rig, slot(), 0, 0, 0, mats);
    const leg = rig.boneIndex.get('legF_L')!;
    const pivot = rig.bones[leg]!.pivot;
    const p = boneTransformPoint(mats, 0, leg, pivot, new Vector3());
    // Only the body's idle oscillators (a few mm / 1-2 degrees) move the hip.
    expect(p.distanceTo(new Vector3(...pivot))).toBeLessThan(0.03);
  });

  it('the CPU fast path (only needed bones, inactive drivers skipped) matches the full evaluation', () => {
    for (const rig of Object.values(RIGS)) {
      for (let i = 0; i < 20; i++) {
        const s = randomPose(rig, i + 100);
        const full = new Float32Array(rig.bones.length * BONE_STRIDE);
        const fast = new Float32Array(rig.bones.length * BONE_STRIDE);
        evaluateRig(rig, s, 0, i * 0.2, 0.4, full);
        evaluateRig(rig, s, 0, i * 0.2, 0.4, fast, 0, true);
        for (let b = 0; b < rig.bones.length; b++) {
          if (rig.cpuBones[b] === 0) continue;
          for (let k = 0; k < BONE_STRIDE; k++) {
            expect(fast[b * BONE_STRIDE + k]).toBeCloseTo(full[b * BONE_STRIDE + k]!, 6);
          }
        }
      }
    }
  });
});

describe('hitboxes follow the pose', () => {
  it('locomotion swings the legs; idle does not', () => {
    const rig = RIGS.swarmer;
    const shin = boxIndex(rig, 'shinF_L');
    const idle0 = hitboxes(rig, slot({ phase: 0 }))[shin]!;
    const idle1 = hitboxes(rig, slot({ phase: Math.PI / 2 }))[shin]!;
    expect(idle0.b.distanceTo(idle1.b)).toBeLessThan(1e-4);
    const walk0 = hitboxes(rig, slot({ locomotion: 1, phase: -Math.PI / 2 }))[shin]!;
    const walk1 = hitboxes(rig, slot({ locomotion: 1, phase: Math.PI / 2 }))[shin]!;
    // Foot swings forward/back by roughly stride length.
    expect(Math.abs(walk0.b.z - walk1.b.z)).toBeGreaterThan(0.15);
  });

  it('attacks move the striking parts (bite lunges the head, spit rears up, slam lifts the fists)', () => {
    const sw = RIGS.swarmer;
    const head = boxIndex(sw, 'head', 'head');
    const bite = sw.attackIds.indexOf('bite');
    const strike = ENEMY_VISUALS.swarmer.attacks[bite]!.strike;
    const rest = hitboxes(sw, slot())[head]!;
    const lunge = hitboxes(sw, slot({ attackId: bite, attack: strike }))[head]!;
    expect(lunge.a.z - rest.a.z).toBeGreaterThan(0.1);

    const sp = RIGS.spitter;
    const spit = sp.attackIds.indexOf('spit');
    const spHead = boxIndex(sp, 'head', 'head');
    const sac = boxIndex(sp, 'sac', 'weakpoint');
    const windup = ENEMY_VISUALS.spitter.attacks[spit]!.windup;
    const spRest = hitboxes(sp, slot());
    const reared = hitboxes(sp, slot({ attackId: spit, attack: windup }));
    expect(reared[spHead]!.a.y).toBeGreaterThan(spRest[spHead]!.a.y + 0.05);
    // The sac inflates during the wind-up – its weakpoint grows with it.
    expect(reared[sac]!.radius).toBeGreaterThan(spRest[sac]!.radius * 1.2);

    const tk = RIGS.tank;
    const slam = tk.attackIds.indexOf('slam');
    const fist = { bone: 'forearm_L', point: [0.76, 0.22, 0.46] as const };
    const fistY = (s: Float32Array): number => {
      const mats = new Float32Array(tk.bones.length * BONE_STRIDE);
      evaluateRig(tk, s, 0, 0, 0, mats);
      return boneTransformPoint(mats, 0, tk.boneIndex.get(fist.bone)!, fist.point, new Vector3()).y;
    };
    const raised = fistY(slot({ attackId: slam, attack: ENEMY_VISUALS.tank.attacks[slam]!.windup }));
    expect(raised).toBeGreaterThan(2.2);
    expect(fistY(slot({ attackId: slam, attack: ENEMY_VISUALS.tank.attacks[slam]!.strike }))).toBeLessThan(
      0.8,
    );
  });

  it('death collapses the body towards the floor', () => {
    for (const [id, rig] of Object.entries(RIGS)) {
      const alive = hitboxes(rig, slot());
      const dead = hitboxes(rig, slot({ death: 1 }));
      const avgY = (b: Box[]): number => b.reduce((s, h) => s + (h.a.y + h.b.y) / 2, 0) / b.length;
      expect(avgY(dead), id).toBeLessThan(avgY(alive) - 0.15);
    }
  });

  it('emerge 0 keeps every hitbox inside the rift (below the floor)', () => {
    for (const [id, rig] of Object.entries(RIGS)) {
      for (const h of hitboxes(rig, slot({ emerge: 0 }))) {
        expect(Math.max(h.a.y, h.b.y) + h.radius, `${id}:${h.zone}`).toBeLessThan(0.02);
      }
    }
  });

  it('bounds contain every hitbox for random poses', () => {
    for (const [id, rig] of Object.entries(RIGS)) {
      for (let i = 0; i < 40; i++) {
        const boxes = hitboxes(rig, randomPose(rig, i), i * 0.1, 0.3);
        const c = new Vector3();
        const r = boundsOfHitboxes(boxes, boxes.length, c);
        for (const h of boxes) {
          expect(h.a.distanceTo(c) + h.radius, id).toBeLessThanOrEqual(r + 1e-6);
          expect(h.b.distanceTo(c) + h.radius, id).toBeLessThanOrEqual(r + 1e-6);
        }
      }
    }
  });

  it('packed bounds (renderer cache) equal the object bounds', () => {
    const rig = RIGS.tank;
    const boxes = hitboxes(rig, randomPose(rig, 7));
    const packed = new Float32Array(boxes.length * HITBOX_STRIDE);
    boxes.forEach((b, i) =>
      packed.set([b.a.x, b.a.y, b.a.z, b.b.x, b.b.y, b.b.z, b.radius], i * HITBOX_STRIDE),
    );
    const c = new Vector3();
    const r = boundsOfHitboxes(boxes, boxes.length, c);
    const out = new Float32Array(4);
    expect(boundsOfPacked(packed, 0, boxes.length, out, 0)).toBeCloseTo(r, 4);
    expect(out[0]).toBeCloseTo(c.x, 4);
    expect(out[1]).toBeCloseTo(c.y, 4);
    expect(out[2]).toBeCloseTo(c.z, 4);
  });

  it('instance transform: yaw turns the model front (+Z) towards the facing direction', () => {
    const rig = RIGS.swarmer;
    const head = boxIndex(rig, 'head', 'head');
    const yaw = yawToward(1, 0);
    const h = hitboxes(rig, slot({ yaw, x: 5, z: -2, scale: 2 }))[head]!;
    const r = hitboxes(rig, slot())[head]!;
    expect(h.a.x).toBeCloseTo(5 + r.a.z * 2, 4);
    expect(h.a.z).toBeCloseTo(-2 - r.a.x * 2, 4);
    expect(h.radius).toBeCloseTo(r.radius * 2, 5);
  });
});
