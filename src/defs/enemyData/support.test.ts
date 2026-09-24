/**
 * M6 support package defs (Heiler, Beschwörer, Späher): type defs, visuals and the VFX / beam
 * styles they reference – the same invariants defs/enemies.test.ts and enemyVisuals.test.ts check
 * for the M3 types, plus the beam / summon / support data.
 */
import { describe, expect, it } from 'vitest';
import { onLog } from '../../core/log';
import { getBrain } from '../../enemies/ai/brains';
import { getAttackExecutor } from '../../enemies/ai/attackKinds';
import { compileRig } from '../../enemies/render/poseMath';
import { getBeamStyle } from '../arsenalVfx';
import { ENEMY_AI, enemyTypeIds, getEnemyDef, type EnemyTypeDef } from '../enemies';
import { ENEMY_RENDER, attackAnimIndex, enemyVisualTypeIds, getEnemyVisualDef } from '../enemyVisuals';
import { NAV } from '../nav';
import { POSTFX } from '../postfx';
import { getEffectPreset } from '../vfx';

const IDS = ['healer', 'summoner', 'sniper'] as const;
const luminance = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
const bloom = POSTFX.bloom.luminanceThreshold + POSTFX.bloom.luminanceSmoothing;

function def(id: string): EnemyTypeDef {
  const d = getEnemyDef(id);
  if (!d) throw new Error(`no def ${id}`);
  return d;
}

describe('M6 support enemies: type defs', () => {
  it('are built, registered and spawnable (brain, executors, visuals)', () => {
    for (const id of IDS) {
      const d = def(id);
      expect(d.id).toBe(id);
      expect(enemyTypeIds()).toContain(id);
      expect(enemyVisualTypeIds()).toContain(id);
      expect(getBrain(d.brain), id).toBeDefined();
      for (const a of d.attacks) {
        if (a.kind === 'beam' || a.kind === 'summon') expect(getAttackExecutor(a.kind), a.id).not.toBeNull();
      }
    }
    expect(def('healer').name).toBe('Heiler');
    expect(def('summoner').name).toBe('Beschwörer');
    expect(def('sniper').name).toBe('Späher');
  });

  it('attacks carry their kind params, sane timings, animations and sockets', () => {
    for (const id of IDS) {
      const d = def(id);
      const vis = getEnemyVisualDef(id)!;
      const ids = new Set<string>();
      for (const a of d.attacks) {
        const tag = `${id}.${a.id}`;
        expect(ids.has(a.id), tag).toBe(false);
        ids.add(a.id);
        expect(a.windup, tag).toBeGreaterThan(0);
        expect(a.strike, tag).toBeGreaterThan(0);
        expect(a.cooldown, tag).toBeGreaterThanOrEqual(a.windup);
        expect(a.range, tag).toBeGreaterThanOrEqual(a.minRange);
        expect(attackAnimIndex(id, a.id), tag).toBeGreaterThanOrEqual(0);
        if (a.kind === 'melee') {
          expect(a.melee!.reach + ENEMY_AI.player.radius, tag).toBeGreaterThanOrEqual(a.range);
        }
        if (a.kind === 'beam') {
          const B = a.beam!;
          expect(Number(!!B.heal) + Number(!!B.laser), `${tag}: exactly one of heal / laser`).toBe(1);
          expect(vis.sockets[B.socket], tag).toBeDefined();
          expect(getBeamStyle(B.visual), tag).toBeDefined();
          if (B.heal) expect(getEffectPreset(B.heal.pulseEffect), tag).toBeDefined();
          if (B.laser) {
            const L = B.laser;
            for (const v of [L.lockVisual, L.shotVisual])
              expect(getBeamStyle(v), `${tag} ${v}`).toBeDefined();
            for (const fx of [L.glintEffect, L.lockEffect, L.fireEffect, L.impactEffect]) {
              expect(getEffectPreset(fx), `${tag} ${fx}`).toBeDefined();
            }
            // The dodge window lies inside the telegraph and the line tracks a running player.
            expect(L.lockTime, tag).toBeLessThan(a.windup);
            expect(a.windup - L.lockTime, tag).toBeGreaterThanOrEqual(0.8);
            expect(L.lockTime, tag).toBeGreaterThanOrEqual(0.3);
            expect(a.requiresLos, tag).toBe(true);
          }
        }
        if (a.kind === 'summon') {
          const S = a.summon!;
          expect(vis.sockets[S.socket], tag).toBeDefined();
          if (S.visual !== '') expect(getBeamStyle(S.visual), tag).toBeDefined();
          expect(getEffectPreset(S.channelEffect), tag).toBeDefined();
          expect(getEffectPreset(S.burstEffect), tag).toBeDefined();
          expect(S.count).toBeLessThanOrEqual(S.maxAlive);
          expect(getEnemyDef(S.fallbackType), `${tag} fallback`).toBeDefined();
          // A summon is worth interrupting but not a one-shot: it survives the interrupt damage.
          expect(S.interruptDamage).toBeLessThan(d.health / 2);
        }
      }
      expect(vis.sockets[d.perception.eyeSocket], `${id} eye socket`).toBeDefined();
    }
  });

  it('behaviour blocks match the brains; fairness knobs are bounded', () => {
    for (const id of IDS) {
      const d = def(id);
      expect(d.nav.radius).toBeLessThanOrEqual(NAV.crowd.maxAgentRadius);
      expect(d.movement.walkSpeed).toBeLessThanOrEqual(d.movement.runSpeed);
      if (d.brain === 'support') {
        const S = d.support!;
        expect(S).toBeDefined();
        expect(S.bandMin).toBeLessThan(S.bandPreferred);
        expect(S.bandPreferred).toBeLessThan(S.bandMax);
        expect(S.fleeDistance).toBeLessThan(S.bandMin);
      }
      if (d.brain === 'sniper') {
        expect(d.ranged).toBeDefined();
        expect(d.sniper).toBeDefined();
        const laser = d.attacks.find((a) => a.beam?.laser)!;
        expect(laser.range).toBeGreaterThanOrEqual(d.ranged!.bandMax);
        expect(laser.beam!.laser!.maxRange).toBeGreaterThanOrEqual(laser.range);
      }
    }
    // The heal channel breaks before the healer would flee (it keeps healing at the band edge).
    const heal = def('healer').attacks.find((a) => a.beam?.heal)!.beam!.heal!;
    expect(heal.breakDistance).toBeLessThan(def('healer').support!.bandMin);
    expect(heal.range).toBeGreaterThan(def('healer').support!.packBehind);
  });
});

describe('M6 support enemies: visuals', () => {
  it('compile without warnings, within the shader limits', () => {
    const warnings: string[] = [];
    const off = onLog((e) => e.level === 'warn' && warnings.push(e.message));
    for (const id of IDS) {
      const rig = compileRig(id, getEnemyVisualDef(id)!);
      expect(rig.bones.length, id).toBeLessThanOrEqual(ENEMY_RENDER.maxBones);
      expect(rig.maxDepth, id).toBeLessThanOrEqual(ENEMY_RENDER.maxDepth);
      expect(rig.zoneNames.length, id).toBeLessThanOrEqual(ENEMY_RENDER.maxZones);
      for (const b of rig.bones)
        expect(b.motionCount, `${id}:${b.name}`).toBeLessThanOrEqual(ENEMY_RENDER.maxMotionsPerBone);
    }
    off();
    expect(warnings).toEqual([]);
  });

  it('glowing organs, eyes, rifts and dissolve edges bloom; effects exist; zones and sockets', () => {
    for (const id of IDS) {
      const v = getEnemyVisualDef(id)!;
      for (const [name, z] of Object.entries(v.zones)) {
        if (z.glow > 0.5)
          expect(luminance(z.emissive) * z.emissiveIntensity * z.glow, `${id}:${name}`).toBeGreaterThan(
            bloom,
          );
        if (z.veins > 0.4)
          expect(luminance(z.emissive) * z.emissiveIntensity * z.veins, `${id}:${name}`).toBeGreaterThan(
            bloom * 0.5,
          );
      }
      expect(luminance(v.rift.color) * v.rift.intensity, id).toBeGreaterThan(bloom);
      expect(luminance(v.dissolve.edgeColor) * v.dissolve.edgeIntensity, id).toBeGreaterThan(bloom);
      expect(getEffectPreset(v.effects.spawn), id).toBeDefined();
      expect(getEffectPreset(v.effects.death), id).toBeDefined();
      expect(v.sockets[v.aimSocket], id).toBeDefined();
      expect(v.sockets[v.effects.deathSocket], id).toBeDefined();
      const zones = v.hitboxes.map((h) => h.zone);
      expect(zones, id).toContain('body');
      expect(zones, id).toContain('weakpoint');
      expect(zones, id).toContain('head');
    }
  });

  it('oscillators complete whole cycles per animation clock wrap', () => {
    for (const id of IDS) {
      for (const b of getEnemyVisualDef(id)!.bones) {
        for (const m of b.motions ?? []) {
          if (m.drive === 'gait' || !m.freq) continue;
          const cycles = m.freq * ENEMY_RENDER.timeWrap;
          expect(Math.abs(cycles - Math.round(cycles)), `${id}:${b.name}:${m.ch}`).toBeLessThan(1e-6);
        }
      }
    }
  });

  it('weakpoints read where the counterplay needs them', () => {
    // Healer: the lantern above the head (visible from the front); sniper: the lens at the lance
    // tip in front of everything; summoner: the heart at the front of the chest.
    const wp = (id: string) => getEnemyVisualDef(id)!.hitboxes.find((h) => h.zone === 'weakpoint')!;
    expect(wp('healer').a[1]).toBeGreaterThan(2);
    expect(wp('sniper').a[2]).toBeGreaterThan(1);
    expect(wp('summoner').a[2]).toBeGreaterThan(0.05);
  });
});
