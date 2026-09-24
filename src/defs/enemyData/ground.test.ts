/**
 * M6 ground package defs: Springer (leaper), Berserker, Milbe (mite), Explodierer (exploder) – type
 * and visual defs are registered, consistent with each other and with the shared systems (brains,
 * attack kinds, VFX presets, shader limits), and match the spec's roles.
 */
import { describe, expect, it } from 'vitest';
import { onLog } from '../../core/log';
import { getBrain } from '../../enemies/ai/brains';
import { compileRig } from '../../enemies/render/poseMath';
import { POSTFX } from '../postfx';
import {
  ENEMIES,
  ENEMY_AI,
  enemyTypeIds,
  getEnemyDef,
  type EnemyAttackDef,
  type EnemyTypeDef,
} from '../enemies';
import { ENEMY_RENDER, attackAnimIndex, enemyVisualTypeIds, getEnemyVisualDef } from '../enemyVisuals';
import { NAV } from '../nav';
import { getEffectPreset } from '../vfx';
import { WEAPONS, type WeaponDef } from '../weapons';
import { BERSERKER_ENEMY } from './berserker';
import { EXPLODER_ENEMY } from './exploder';
import { LEAPER_ENEMY } from './leaper';
import { MITE_ENEMY } from './mite';

const IDS = ['leaper', 'berserker', 'mite', 'exploder'] as const;
const def = (id: string): EnemyTypeDef => getEnemyDef(id)!;
const attack = (id: string, a: string): EnemyAttackDef => def(id).attacks.find((x) => x.id === a)!;
const luminance = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
const bloom = POSTFX.bloom.luminanceThreshold + POSTFX.bloom.luminanceSmoothing;

describe('M6 ground types: registration', () => {
  it('every type is built and registered with its visual', () => {
    expect(getEnemyDef('leaper')).toBe(LEAPER_ENEMY);
    expect(getEnemyDef('berserker')).toBe(BERSERKER_ENEMY);
    expect(getEnemyDef('mite')).toBe(MITE_ENEMY);
    expect(getEnemyDef('exploder')).toBe(EXPLODER_ENEMY);
    for (const id of IDS) {
      expect(def(id).id, id).toBe(id);
      expect(enemyTypeIds(), id).toContain(id);
      expect(enemyVisualTypeIds(), id).toContain(id);
      expect(getEnemyVisualDef(id), id).toBeDefined();
    }
    expect(def('leaper').name).toBe('Springer');
    expect(def('mite').name).toBe('Milbe');
    expect(def('exploder').name).toBe('Explodierer');
  });
});

describe('M6 ground types: defs are consistent', () => {
  it('brains, behaviour blocks, attack anims, sockets', () => {
    for (const id of IDS) {
      const d = def(id);
      const vis = getEnemyVisualDef(id)!;
      expect(getBrain(d.brain), id).toBeDefined();
      if (d.brain === 'swarm') expect(d.swarm, id).toBeDefined();
      if (d.brain === 'brute') expect(d.brute, id).toBeDefined();
      const animIds = new Set(vis.attacks.map((a) => a.id));
      for (const a of d.attacks) expect(animIds.has(a.id), `${id}.${a.id}`).toBe(true);
      vis.attacks.forEach((a, i) => expect(attackAnimIndex(id, a.id)).toBe(i));
      expect(vis.sockets[d.perception.eyeSocket], `${id} eye`).toBeDefined();
      expect(vis.sockets[vis.aimSocket], `${id} aim`).toBeDefined();
      expect(vis.sockets[vis.effects.deathSocket], `${id} death`).toBeDefined();
      if (d.death.burst) expect(vis.sockets[d.death.burst.socket], `${id} burst`).toBeDefined();
      expect(getEffectPreset(vis.effects.spawn), id).toBeDefined();
      expect(getEffectPreset(vis.effects.death), id).toBeDefined();
      expect(
        vis.hitboxes.map((h) => h.zone),
        id,
      ).toContain('body');
      if (d.breach)
        expect(
          d.attacks.some((a) => a.id === d.breach!.attack),
          id,
        ).toBe(true);
    }
  });

  it('attacks carry the parameters of their kind, sane timings, valid combos and telegraphs', () => {
    for (const id of IDS) {
      const d = def(id);
      const vis = getEnemyVisualDef(id)!;
      const ids = new Set(d.attacks.map((a) => a.id));
      expect(ids.size, id).toBe(d.attacks.length);
      for (const a of d.attacks) {
        const tag = `${id}.${a.id}`;
        expect(a.windup, tag).toBeGreaterThan(0);
        expect(a.strike, tag).toBeGreaterThan(0);
        expect(a.range, tag).toBeGreaterThanOrEqual(a.minRange);
        expect(a.cooldown, tag).toBeGreaterThanOrEqual(a.windup);
        if (a.kind === 'melee') {
          expect(a.melee, tag).toBeDefined();
          expect(a.melee!.reach + ENEMY_AI.player.radius, tag).toBeGreaterThanOrEqual(a.range);
        }
        if (a.kind === 'leap') expect(a.leap, tag).toBeDefined();
        if (a.kind === 'charge') expect(a.charge, tag).toBeDefined();
        if (a.kind === 'slam') {
          expect(a.slam, tag).toBeDefined();
          expect(vis.sockets[a.slam!.socket], tag).toBeDefined();
          expect(getEffectPreset(a.slam!.effect), tag).toBeDefined();
        }
        if (a.combo) {
          const next = d.attacks.find((x) => x.id === a.combo);
          expect(next, `${tag} → ${a.combo}`).toBeDefined();
          // A chain is one attack for the token pool: scripted links never take their own token.
          if (next!.scripted) expect(next!.usesSlot, tag).toBe(false);
        }
        if (a.telegraph) {
          expect(getEffectPreset(a.telegraph.effect), tag).toBeDefined();
          expect(vis.sockets[a.telegraph.socket], tag).toBeDefined();
        }
        expect(a.sound, tag).toMatch(new RegExp(`^enemy\\.${id}\\.`));
      }
      // Something the brain can pick.
      expect(
        d.attacks.some((a) => !a.scripted),
        id,
      ).toBe(true);
      for (const s of Object.values(d.audio)) if (typeof s === 'string') expect(s).toMatch(/^enemy\./);
    }
  });

  it('nav agents, token pools and behaviour data fit the shared systems', () => {
    for (const id of IDS) {
      const d = def(id);
      expect(d.nav.radius, id).toBeLessThanOrEqual(NAV.crowd.maxAgentRadius);
      expect(d.movement.walkSpeed, id).toBeLessThanOrEqual(d.movement.runSpeed);
      expect(d.slotCost, id).toBeLessThanOrEqual(ENEMY_AI.slots.pools[d.slotPool]);
      const melee = d.attacks.filter((a) => a.usesSlot && a.kind !== 'leap');
      const standoff = d.swarm?.standoff ?? d.brute?.standoff;
      if (standoff !== undefined && melee.length > 0) {
        expect(Math.max(...melee.map((a) => a.range)), id).toBeGreaterThan(standoff);
      }
    }
    const B = def('berserker').brute!;
    const lunge = attack('berserker', 'lunge');
    expect(B.waitRadius - B.waitSlack).toBeGreaterThanOrEqual(lunge.minRange);
    expect(B.waitRadius + B.waitSlack).toBeLessThanOrEqual(lunge.range);
    expect(B.engageDistance).toBeGreaterThan(B.waitRadius + B.waitSlack);
  });
});

describe('M6 ground types: the spec roles', () => {
  it('Springer: low health, high mobility, pounces from far, slashes after landing, clears low cover', () => {
    const d = def('leaper');
    expect(d.health).toBeLessThan(ENEMIES.spitter.health);
    expect(d.movement.runSpeed).toBeGreaterThan(ENEMIES.swarmer.movement.runSpeed);
    const pounce = attack('leaper', 'pounce');
    expect(pounce.kind).toBe('leap');
    expect(pounce.range).toBeGreaterThan(ENEMIES.swarmer.attacks.find((a) => a.kind === 'leap')!.range);
    expect(pounce.leap!.arcSegments).toBeGreaterThan(0);
    expect(pounce.combo).toBe('slash');
    expect(pounce.telegraph).toBeDefined();
    // Readable crouch.
    expect(pounce.windup).toBeGreaterThanOrEqual(0.6);
    // Circles outside its own slash reach.
    expect(d.swarm!.ringRadius).toBeGreaterThan(pounce.minRange);
  });

  it('Berserker: enrages below half health; cleave combo; slower than a leaper, far faster than a tank', () => {
    const d = def('berserker');
    const r = d.enrage!;
    expect(r.healthFraction).toBe(0.5);
    expect(r.staggerImmune).toBe(true);
    expect(r.speedMultiplier).toBeGreaterThan(1);
    expect(r.attackRate).toBeGreaterThan(1);
    expect(r.glow).toBeGreaterThan(0);
    const roar = attack('berserker', r.roar);
    expect(roar.scripted).toBe(true);
    expect(roar.damage).toBe(0);
    // cleave → backhand → crush.
    expect(attack('berserker', 'cleave').combo).toBe('backhand');
    expect(attack('berserker', 'backhand').combo).toBe('crush');
    expect(attack('berserker', 'crush').combo).toBeUndefined();
    expect(d.movement.runSpeed).toBeLessThan(def('leaper').movement.runSpeed);
    expect(d.movement.runSpeed).toBeGreaterThan(ENEMIES.tank.movement.runSpeed * 1.4);
    // The heart is the weakpoint; the plates block like armor.
    expect(d.zoneMultipliers.weakpoint).toBeGreaterThan(1);
    expect(d.zoneMultipliers.shield).toBeLessThan(1);
    expect(d.zoneSurfaces.shield).toBe('armor');
  });

  it('Milbe: dies to any bullet or pellet of the roster, pays few points, costs little', () => {
    const d = def('mite');
    for (const w of Object.values(WEAPONS) as WeaponDef[]) {
      if (w.kind !== 'hitscan') continue;
      const worst = w.damage.base * Math.min(1, w.damage.limbMultiplier);
      expect(worst, w.id).toBeGreaterThanOrEqual(d.health * (d.zoneMultipliers.limb ?? 1));
    }
    expect(d.points.kill).toBeLessThan(ENEMIES.swarmer.points.kill);
    expect(d.collider).toBeNull();
    expect(d.nav.radius).toBeLessThan(ENEMIES.swarmer.nav.radius);
    // A mite swarm may fill the whole alive cap (+ the dying) and still render in one draw.
    const vis = getEnemyVisualDef('mite')!;
    expect(vis.capacity).toBeGreaterThanOrEqual(ENEMY_AI.capacity + Math.ceil(ENEMY_AI.capacity * 0.2));
    const rig = compileRig('mite', vis);
    expect(rig.parts.length).toBeLessThan(compileRig('swarmer', getEnemyVisualDef('swarmer')!).parts.length);
  });

  it('Explodierer: rushes, telegraphs, self-destructs; its burst is a real explosion that hurts enemies too', () => {
    const d = def('exploder');
    expect(d.swarm!.rush).toBe(true);
    const fuse = attack('exploder', 'fuse');
    expect(fuse.selfDestruct).toBe(true);
    expect(fuse.usesSlot).toBe(false);
    expect(fuse.telegraph).toBeDefined();
    expect(fuse.windup).toBeGreaterThanOrEqual(1);
    const b = d.death.burst!;
    expect(b.explosion).toBe(true);
    expect(b.enemyDamage).toBeGreaterThanOrEqual(d.health);
    // Fair: backing off out of the burst during the fuse is possible at walk speed.
    expect(b.radius - fuse.range).toBeLessThan(fuse.windup * 5.5);
    expect(d.warningPulse!.distance).toBeGreaterThan(b.radius);
    // The sac is the weakpoint.
    const vis = getEnemyVisualDef('exploder')!;
    expect(vis.hitboxes.find((h) => h.zone === 'weakpoint')?.bone).toBe('sac');
    expect(d.zoneMultipliers.weakpoint).toBeGreaterThan(1);
  });
});

describe('M6 ground visuals', () => {
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

  it('glowing organs and eyes bloom; veins can bloom when pulsing; seams and edges bloom', () => {
    for (const id of IDS) {
      const def = getEnemyVisualDef(id)!;
      for (const [name, z] of Object.entries(def.zones)) {
        if (z.glow > 0.5)
          expect(luminance(z.emissive) * z.emissiveIntensity * z.glow, `${id}:${name}`).toBeGreaterThan(
            bloom,
          );
        if (z.veins > 0.4)
          expect(luminance(z.emissive) * z.emissiveIntensity * z.veins, `${id}:${name}`).toBeGreaterThan(
            bloom * 0.5,
          );
      }
      expect(luminance(def.rift.color) * def.rift.intensity, id).toBeGreaterThan(bloom);
      expect(luminance(def.dissolve.edgeColor) * def.dissolve.edgeIntensity, id).toBeGreaterThan(bloom);
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
});
