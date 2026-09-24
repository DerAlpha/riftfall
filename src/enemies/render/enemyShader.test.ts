import { DataTexture, FloatType, RGBAFormat, ShaderLib } from 'three';
import { describe, expect, it } from 'vitest';
import { ENEMY_RENDER, ENEMY_VISUALS, GAIT_WAVES, RIG_DRIVERS } from '../../defs/enemyVisuals';
import { patchDissolveFragment } from '../../render/materials/dissolve';
import {
  RIG_GLSL,
  ZONE_VEC4,
  createEnemyMaterials,
  createSharedUniforms,
  packZones,
  patchEnemyDepthFragment,
  patchEnemyFragment,
  patchEnemyVertex,
  rigDefines,
  setFlashScale,
  setSunCasterBounds,
} from './enemyShader';
import { CODE_STRIDE, DRIVER_CODE, MIN_SCALE, RARE_DRIVER_MASK, WAVE_CODE, compileRig } from './poseMath';

describe('enemy shader ↔ CPU pose math consistency', () => {
  it('generates the driver / wave codes from the tables the CPU evaluator uses', () => {
    const defs = rigDefines();
    for (const d of RIG_DRIVERS)
      expect(defs).toContain(`#define RF_DRV_${d.toUpperCase()} ${DRIVER_CODE[d]}\n`);
    for (const w of GAIT_WAVES) expect(defs).toContain(`#define RF_WAVE_${w.toUpperCase()} ${WAVE_CODE[w]}`);
    expect(defs).toContain(`#define RF_CODE_STRIDE ${CODE_STRIDE}`);
    expect(defs).toContain(`#define RF_MIN_SCALE ${MIN_SCALE}`);
    expect(defs).toContain(`#define RF_MAX_DEPTH ${ENEMY_RENDER.maxDepth}`);
    expect(defs).toContain(`#define RF_MAX_MOTIONS ${ENEMY_RENDER.maxMotionsPerBone}`);
  });

  it('handles every driver the CPU handles (no driver silently ignored on the GPU)', () => {
    const body = RIG_GLSL.slice(RIG_GLSL.indexOf('float rfMotion('));
    for (const d of RIG_DRIVERS) {
      if (d === 'rest' || d === 'idle' || d === 'gait' || d === 'attack') {
        expect(body, d).toContain(`RF_DRV_${d.toUpperCase()}`);
      } else {
        expect(body, d).toMatch(new RegExp(`drv == RF_DRV_${d.toUpperCase()}\\b`));
      }
    }
  });

  it('skips inactive drivers, other attacks and idle bones like poseMath.evaluateRig', () => {
    const setup = RIG_GLSL.slice(RIG_GLSL.indexOf('void rfSetup()'), RIG_GLSL.indexOf('float rfMotion('));
    // Every driver can switch on (rest always), with the same conditions as activeDriverMask.
    expect(setup).toContain('rfActive = 1 << RF_DRV_REST;');
    for (const d of RIG_DRIVERS) {
      if (d === 'rest') continue;
      expect(setup, d).toMatch(new RegExp(`1 << RF_DRV_${d.toUpperCase()}\\b`));
    }
    for (const cond of [
      'rfLoc > 0.0',
      'rfAttack >= 0.0',
      'rfStagger > 0.0',
      'rfDeath > 0.0',
      'rfEmergeInv > 0.0',
    ])
      expect(setup, cond).toContain(cond);
    const bone = RIG_GLSL.slice(RIG_GLSL.indexOf('int rfApplyBone('));
    expect(bone).toContain('( int( h1.z + 0.5 ) & rfActive ) == 0');
    expect(bone).toContain('( ( rfActive >> drv ) & 1 ) == 0');
    expect(bone).toContain('drv == RF_DRV_ATTACK && abs( m0.y - rfAttack ) >= 0.5');
    expect(bone).toContain('( ( rfActive & RF_RARE_MASK ) == 0 ? h1.w : h1.y )');
    expect(rigDefines()).toContain(`#define RF_RARE_MASK ${RARE_DRIVER_MASK}`);
    // The second motion texel is only fetched for motions that contribute.
    expect(bone.indexOf('vec4 m1 = rfTex( mt + 1 )')).toBeGreaterThan(bone.indexOf('continue;'));
  });

  it('binds the CPU rig table itself as the GPU rig texture, with matching layout uniforms', () => {
    for (const [id, def] of Object.entries(ENEMY_VISUALS)) {
      const rig = compileRig(id, def);
      const tex = new DataTexture(rig.data, rig.layout.width, rig.layout.height, RGBAFormat, FloatType);
      const set = createEnemyMaterials(id, rig, def, tex, createSharedUniforms(null));
      const u = set.uniforms;
      expect(u.rfRig.value.image.data).toBe(rig.data);
      expect(u.rfLayout.value.toArray()).toEqual([
        rig.layout.attackBase,
        rig.layout.boneBase,
        rig.layout.partBase,
        rig.layout.motionBase,
      ]);
      expect(u.rfCounts.value.x).toBe(rig.attackIds.length);
      expect(u.rfLook.value.x).toBeCloseTo(rig.lookYawMax, 6);
      expect(u.rfLook.value.y).toBeCloseTo(rig.lookPitchMax, 6);
      // No reach given: per-instance culling is off.
      expect(u.rfCullRadius.value).toBe(0);
      expect(
        createEnemyMaterials(id, rig, def, tex, createSharedUniforms(null), 2.5).uniforms.rfCullRadius.value,
      ).toBe(2.5);
      expect(set.material.customProgramCacheKey()).toBe(
        createEnemyMaterials(id, rig, def, tex, createSharedUniforms(null)).material.customProgramCacheKey(),
      );
      set.dispose();
    }
  });

  it('packs the zone palette in the rig zone order', () => {
    const rig = compileRig('tank', ENEMY_VISUALS.tank);
    const z = packZones(rig, ENEMY_VISUALS.tank);
    expect(z.length).toBe(ENEMY_RENDER.maxZones * ZONE_VEC4 * 4);
    const core = rig.zoneNames.indexOf('core');
    const def = ENEMY_VISUALS.tank.zones.core;
    const o = core * ZONE_VEC4 * 4;
    expect(z[o]).toBeCloseTo(def.color[0], 6);
    expect(z[o + 8]).toBeCloseTo(def.emissive[0] * def.emissiveIntensity, 5);
    expect(z[o + 20]).toBeCloseTo(def.glow, 6);
  });

  it('reduce flashing scales the hit flash', () => {
    const shared = createSharedUniforms(null);
    const full = shared.rfFlash.value.x;
    setFlashScale(shared, ENEMY_RENDER.hitFlash.reducedFlashingScale);
    expect(shared.rfFlash.value.x).toBeCloseTo(full * ENEMY_RENDER.hitFlash.reducedFlashingScale, 6);
  });
});

describe('shader patches (three r186 chunks)', () => {
  it('patch the physical, depth and distance programs', () => {
    const v = patchEnemyVertex(ShaderLib.physical.vertexShader, false);
    expect(v).not.toBeNull();
    expect(v!).toContain('rfDeform( position, objectNormal');
    expect(v!).toContain('transformed = rfPos;');
    // Deformation happens before three's instancing / projection.
    expect(v!.indexOf('transformed = rfPos;')).toBeLessThan(v!.indexOf('#include <project_vertex>'));
    for (const lib of [ShaderLib.depth, ShaderLib.distance]) {
      const dv = patchEnemyVertex(lib.vertexShader, true);
      expect(dv).not.toBeNull();
      expect(dv!).toContain('rfDeform( position, vec3( 0.0, 1.0, 0.0 ), transformed');
      const df = patchEnemyDepthFragment(lib.fragmentShader);
      expect(df).not.toBeNull();
      expect(df!).toContain('(vRfFx.z)');
      expect(df!).toContain('vRfLocalY < 0.0');
    }
  });

  it('fragment: surface, emissive, clearcoat, per-instance dissolve; declarations before use', () => {
    const f = patchEnemyFragment(ShaderLib.physical.fragmentShader);
    expect(f).not.toBeNull();
    const src = f!;
    for (const s of [
      'rfSurface()',
      'roughnessFactor = rfS.roughness',
      'metalnessFactor = rfS.metalness',
      'rfPerturbNormal(',
      'rfEmissive( rfS, nonPerturbedNormal )',
      'material.clearcoat = saturate( rfS.clearcoat )',
    ]) {
      expect(src, s).toContain(s);
    }
    // The dissolve threshold is the per-instance varying, not the uniform.
    expect(src).toContain('rfDissolveField() - (vRfFx.z)');
    expect(src.indexOf('varying vec3 vRfDissolvePos')).toBeLessThan(src.indexOf('RfSurface rfSurface()'));
  });

  it('dissolve hook keeps the default (uniform) behaviour', () => {
    const plain = patchDissolveFragment(ShaderLib.physical.fragmentShader, true)!;
    expect(plain).toContain('rfDissolveField() - uDissolve');
    const inst = patchDissolveFragment(ShaderLib.physical.fragmentShader, true, 'vAmount')!;
    expect(inst).toContain('rfDissolveField() - (vAmount)');
    // Only the bare identifier is replaced (uDissolveEdge / uDissolveColor stay uniforms).
    expect(inst).toContain('uDissolveEdge');
    expect(inst).toContain('uDissolveColor');
  });

  it('cull single instances outside the drawing camera frustum before running the rig (color and shadows)', () => {
    const color = patchEnemyVertex(ShaderLib.physical.vertexShader, false)!;
    const depth = [ShaderLib.depth, ShaderLib.distance].map((l) => patchEnemyVertex(l.vertexShader, true)!);
    expect(color).toContain('if ( rfInstanceVisible() ) rfDeform( position, objectNormal, rfPos, rfNrm );');
    // A culled instance collapses onto its feet (zero-area triangles) with defined varyings.
    expect(color).toContain('vec3 rfPos = vec3( 0.0 );');
    expect(color).toContain('rfZone = 0.0;');
    for (const d of depth) {
      expect(d).toContain('transformed = vec3( 0.0 );');
      expect(d).toContain(
        'if ( rfInstanceVisible() ) rfDeform( position, vec3( 0.0, 1.0, 0.0 ), transformed',
      );
    }
    for (const src of [color, ...depth]) {
      expect(src.indexOf('bool rfInstanceVisible()')).toBeLessThan(src.indexOf('if ( rfInstanceVisible() )'));
      expect(src.indexOf('bool rfInsidePlane(')).toBeLessThan(src.indexOf('bool rfInstanceVisible()'));
    }
    // Instancing only (instanceMatrix): the planes of all six frustum sides, radius × instance scale.
    expect(RIG_GLSL).toMatch(/#ifdef USE_INSTANCING[\s\S]*instanceMatrix[\s\S]*#else\s*return true;/);
    expect(RIG_GLSL.match(/rfInsidePlane\( r3 [+-] r[012], c, r \)/g)).toHaveLength(6);
    expect(RIG_GLSL).toContain('float r = rfCullRadius * length( instanceMatrix[ 0 ].xyz );');
  });

  it('sun shadow passes (orthographic) also skip enemies outside the sunlit box; color passes never do', () => {
    const color = patchEnemyVertex(ShaderLib.physical.vertexShader, false)!;
    const depth = patchEnemyVertex(ShaderLib.depth.vertexShader, true)!;
    expect(depth).toContain('if ( rfInstanceVisible() && rfSunCaster() ) rfDeform(');
    expect(color).not.toContain('rfSunCaster() )');
    expect(RIG_GLSL).toContain('projectionMatrix[ 3 ][ 3 ] != 1.0');
    expect(RIG_GLSL).toContain('rfSunMin.w <= 0.0');
    const shared = createSharedUniforms(null);
    expect(shared.rfSunMin.value.w).toBe(0);
    setSunCasterBounds(shared, { min: { x: -11, y: 0, z: -7 }, max: { x: 6, y: 17.7, z: 10.3 } });
    expect(shared.rfSunMin.value.toArray()).toEqual([-11, 0, -7, 1]);
    expect(shared.rfSunMax.value.toArray()).toEqual([6, 17.7, 10.3]);
    setSunCasterBounds(shared, null);
    expect(shared.rfSunMin.value.w).toBe(0);
  });

  it('refuses shaders without the anchors (renders undeformed instead of crashing)', () => {
    expect(patchEnemyVertex('void main() {}', false)).toBeNull();
    expect(patchEnemyFragment('void main() {}')).toBeNull();
  });
});
