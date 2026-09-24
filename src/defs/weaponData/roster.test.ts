import { describe, expect, it } from 'vitest';
import type { DamageElement } from '../../core/events';
import {
  ATTACHMENTS,
  ATTACHMENT_IDS,
  ATTACHMENT_SLOTS,
  attachmentMods,
  attachmentsFor,
  getAttachmentDef,
  isAttachmentCompatible,
  type AttachmentDef,
} from '../attachments';
import { COMBAT } from '../combat';
import { MYSTERY_BOX, WALL_BUYS } from '../interactables';
import { FORGE, FORGE_LOOKS, forgePaletteId, forgeTierCost, getForgeLook, nextForgeTier } from '../forge';
import {
  WEAPONS,
  WEAPON_IDS,
  type ExplosionDef,
  type FieldDef,
  type WeaponDef,
  type WeaponSpecialDef,
} from '../weapons';

const defs: WeaponDef[] = WEAPON_IDS.map((id) => WEAPONS[id]);
const byId = (id: string): WeaponDef => defs.find((d) => d.id === id)!;
/** The M2 weapons keep their established (pre-convention) sound ids. */
const M2 = new Set(['pistol', 'rifle', 'shotgun']);
const ELEMENTS: readonly DamageElement[] = ['physical', 'fire', 'ice', 'shock', 'poison', 'void'];
const MUZZLES = [
  'pistol',
  'rifle',
  'shotgun',
  'smg',
  'lmg',
  'sniper',
  'plasma',
  'energy',
  'flame',
  'launcher',
  'void',
  'shock',
  'ice',
].map((s) => `muzzle.${s}`);
const IMPACTS = ['bullet', 'pellet', 'plasma', 'shock', 'fire', 'ice', 'poison', 'void'].map(
  (s) => `impact.${s}`,
);
const PROJECTILES = [
  'plasma',
  'grenade',
  'frag',
  'incendiary',
  'cryo',
  'singularity',
  'voidorb',
  'shockorb',
  'cryoorb',
].map((s) => `projectile.${s}`);
const TRAILS = ['plasma', 'smoke', 'void', 'frost', 'shock', 'fire'].map((s) => `trail.${s}`);
const BEAMS = ['lightning', 'flame', 'void'].map((s) => `beam.${s}`);
const FIELDS = ['pull.void', 'damage.fire', 'damage.poison', 'slow.ice'].map((s) => `field.${s}`);
const TAILS = ['small', 'medium', 'large', 'energy', 'explosive'].map((s) => `weapon.tail.${s}`);

const ROSTER = [
  'pistol',
  'revolver',
  'machinepistol',
  'smg',
  'pdw',
  'vector',
  'rifle',
  'burstrifle',
  'battlerifle',
  'shotgun',
  'autoshotgun',
  'doublebarrel',
  'lmg',
  'minigun',
  'sniper',
  'marksman',
  'plasma',
  'chainlightning',
  'railgun',
  'flamethrower',
  'grenadelauncher',
  'blackhole',
  'riftripper',
  'aetherharp',
  'cryonova',
];

/** Every numeric leaf of a def (path → value). */
function numbers(obj: unknown, path = '', out: [string, number][] = []): [string, number][] {
  if (typeof obj === 'number') out.push([path, obj]);
  else if (Array.isArray(obj)) obj.forEach((v, i) => numbers(v, `${path}[${i}]`, out));
  else if (obj && typeof obj === 'object')
    for (const [k, v] of Object.entries(obj)) numbers(v, path ? `${path}.${k}` : k, out);
  return out;
}

function explosionsOf(d: WeaponDef): ExplosionDef[] {
  const out: ExplosionDef[] = [];
  const fromField = (f: FieldDef | null | undefined): void => {
    if (f?.collapse) out.push(f.collapse);
  };
  const fromSpecial = (s: WeaponSpecialDef | null | undefined): void => {
    if (s?.kind === 'explosiveRounds') out.push(s.explosion);
    if (s?.kind === 'fieldOnKill') fromField(s.field);
  };
  if (d.projectile?.explosion) out.push(d.projectile.explosion);
  fromField(d.projectile?.field);
  fromSpecial(d.special);
  for (const u of d.upgrades) fromSpecial(u.special);
  return out;
}

function fieldsOf(d: WeaponDef): FieldDef[] {
  const out: FieldDef[] = [];
  if (d.projectile?.field) out.push(d.projectile.field);
  for (const s of [d.special, ...d.upgrades.map((u) => u.special)])
    if (s?.kind === 'fieldOnKill') out.push(s.field);
  return out;
}

function checkSpecial(id: string, s: WeaponSpecialDef): void {
  switch (s.kind) {
    case 'explosiveRounds':
      expect(s.chance, id).toBeGreaterThan(0);
      expect(s.chance, id).toBeLessThanOrEqual(1);
      break;
    case 'ricochet':
      expect(s.bounces, id).toBeGreaterThanOrEqual(1);
      expect(s.damageKeep, id).toBeGreaterThan(0);
      expect(s.damageKeep, id).toBeLessThanOrEqual(1);
      break;
    case 'chainArc':
      expect(s.chance, id).toBeGreaterThan(0);
      expect(s.chance, id).toBeLessThanOrEqual(1);
      expect(s.count, id).toBeGreaterThanOrEqual(1);
      expect(s.range, id).toBeGreaterThan(0);
      expect(s.damage, id).toBeGreaterThan(0);
      break;
    case 'elementProc':
      expect(ELEMENTS, id).toContain(s.element);
      expect(s.element, id).not.toBe('physical');
      expect(s.chance, id).toBeGreaterThan(0);
      expect(s.chance, id).toBeLessThanOrEqual(1);
      expect(s.amount, id).toBeGreaterThan(0);
      break;
    case 'lifesteal':
      // A fraction of the damage dealt: small, or the player becomes unkillable.
      expect(s.fraction, id).toBeGreaterThan(0);
      expect(s.fraction, id).toBeLessThanOrEqual(0.05);
      break;
    case 'splitShot':
      expect(s.count, id).toBeGreaterThanOrEqual(1);
      expect(s.angleDeg, id).toBeGreaterThan(0);
      break;
    case 'critBurst':
      expect(s.everyNth, id).toBeGreaterThanOrEqual(2);
      expect(s.multiplier, id).toBeGreaterThan(1);
      break;
    case 'fieldOnKill':
      expect(s.chance, id).toBeGreaterThan(0);
      expect(s.chance, id).toBeLessThanOrEqual(1);
      break;
  }
}

describe('weapon roster (M5 arsenal)', () => {
  it('ships at least 24 weapons with the final, unique ids', () => {
    expect(defs.length).toBeGreaterThanOrEqual(24);
    expect([...WEAPON_IDS]).toEqual(ROSTER);
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
    for (const d of defs) expect(d.model, d.id).toBe(d.id);
    // Every category of the spec is represented.
    const cats = new Set(defs.map((d) => d.category));
    for (const c of ['pistol', 'smg', 'rifle', 'shotgun', 'lmg', 'sniper', 'energy', 'wonder'] as const)
      expect(cats.has(c), c).toBe(true);
  });

  it('has hitscan and projectile weapons, beams and a charge weapon, each with its kind data', () => {
    for (const d of defs) {
      expect(!!d.projectile, `${d.id} projectile`).toBe(d.kind === 'projectile');
      expect(!!d.beam, `${d.id} beam`).toBe(d.kind === 'beam');
      expect(!!d.charge, `${d.id} charge`).toBe(d.kind === 'charge');
      if (d.spinUp) expect(d.fireMode, d.id).toBe('auto');
    }
    for (const k of ['hitscan', 'projectile', 'beam', 'charge'] as const)
      expect(
        defs.some((d) => d.kind === k),
        k,
      ).toBe(true);
  });

  it('every number is finite and non-negative; core stats are positive', () => {
    for (const d of defs) {
      for (const [path, v] of numbers(d)) {
        expect(Number.isFinite(v), `${d.id}.${path}`).toBe(true);
        // Recoil pattern yaw is signed (+ = right).
        if (!path.startsWith('recoil.pattern')) expect(v, `${d.id}.${path}`).toBeGreaterThanOrEqual(0);
      }
      for (const v of [
        d.damage.base,
        d.rpm,
        d.magazine,
        d.reserve,
        d.range,
        d.equipTime,
        d.holsterTime,
        d.inspectTime,
        d.cost,
        d.melee.damage,
        d.damage.headMultiplier,
        d.penetration.damageKeep,
      ])
        expect(v, d.id).toBeGreaterThan(0);
      if (d.carrySpeedMultiplier !== undefined) {
        expect(d.carrySpeedMultiplier, d.id).toBeGreaterThan(0.5);
        expect(d.carrySpeedMultiplier, d.id).toBeLessThanOrEqual(1);
      }
      // Nothing pierces a training shield.
      expect(d.penetration.power, d.id).toBeLessThan(COMBAT.penetrationCost.shield);
    }
  });

  it('kind data is sane (projectile flight, beam drain, charge curve, spin-up)', () => {
    for (const d of defs) {
      const p = d.projectile;
      if (p) {
        expect(p.speed, d.id).toBeGreaterThan(0);
        expect(p.radius, d.id).toBeGreaterThan(0);
        expect(p.lifetime, d.id).toBeGreaterThan(0);
        expect(p.restitution, d.id).toBeLessThanOrEqual(1);
        if (p.fuse > 0) expect(p.fuse, d.id).toBeLessThan(p.lifetime);
        if (p.bounces > 0) expect(p.restitution, d.id).toBeGreaterThan(0);
        // Something must happen when it lands: a direct hit, a blast or a field.
        expect(d.damage.base > 0 || p.explosion !== null || p.field !== null, d.id).toBe(true);
      }
      const b = d.beam;
      if (b) {
        expect(b.range, d.id).toBeGreaterThan(0);
        expect(b.tickRate, d.id).toBeGreaterThan(0);
        expect(b.ammoPerSecond, d.id).toBeGreaterThan(0);
        // At least a few seconds of beam per magazine.
        expect(d.magazine / b.ammoPerSecond, d.id).toBeGreaterThanOrEqual(3);
        expect(d.rpm, d.id).toBe(b.tickRate * 60);
        if (b.chain) expect(b.chain.damageKeep, d.id).toBeLessThanOrEqual(1);
      }
      const c = d.charge;
      if (c) {
        expect(c.time, d.id).toBeGreaterThan(0);
        expect(c.minCharge, d.id).toBeGreaterThan(0);
        expect(c.minCharge, d.id).toBeLessThan(1);
        expect(c.damageAtMin, d.id).toBeLessThanOrEqual(1);
      }
      const s = d.spinUp;
      if (s) {
        expect(s.startFraction, d.id).toBeGreaterThan(0);
        expect(s.startFraction, d.id).toBeLessThan(1);
        expect(s.time, d.id).toBeGreaterThan(0);
        expect(s.spinDown, d.id).toBeGreaterThan(0);
      }
      for (const e of explosionsOf(d)) {
        expect(e.radius, d.id).toBeGreaterThan(0);
        expect(e.damage, d.id).toBeGreaterThan(0);
        expect(e.minFalloffMultiplier, d.id).toBeLessThanOrEqual(1);
        expect(e.selfDamageScale, d.id).toBeLessThanOrEqual(1);
        expect(ELEMENTS, d.id).toContain(e.element);
      }
      for (const f of fieldsOf(d)) {
        expect(f.radius, d.id).toBeGreaterThan(0);
        expect(f.duration, d.id).toBeGreaterThan(0);
        if (f.kind === 'slow') expect(f.strength, d.id).toBeLessThan(1);
        if (f.kind === 'pull') expect(f.strength, d.id).toBeGreaterThan(0);
      }
    }
  });

  it('reload markers are ordered, inside the reload and follow the roster choreography', () => {
    for (const d of defs) {
      const r = d.reload;
      if (r.perShell) {
        expect(r.perShell.insertAt, d.id).toBeLessThan(r.perShell.shell);
        expect(r.perShell.pumpAt, d.id).toBeLessThan(r.perShell.emptyEnd);
        continue;
      }
      for (const [steps, total] of [
        [r.tacticalSteps, r.tactical],
        [r.emptySteps, r.empty],
      ] as const) {
        expect(steps.map((s) => s.step).slice(0, 2), d.id).toEqual(['magOut', 'magIn']);
        for (let i = 0; i < steps.length; i++) {
          expect(steps[i]!.at, d.id).toBeGreaterThan(0);
          expect(steps[i]!.at, d.id).toBeLessThan(total);
          if (i > 0) expect(steps[i]!.at, d.id).toBeGreaterThan(steps[i - 1]!.at);
        }
      }
      expect(
        r.emptySteps.map((s) => s.step),
        d.id,
      ).toContain('boltRelease');
    }
    // Crane / break action / feed cover / pilot light close on every reload, not only from empty.
    for (const id of ['revolver', 'doublebarrel', 'lmg', 'flamethrower'])
      expect(
        byId(id).reload.tacticalSteps.map((s) => s.step),
        id,
      ).toContain('boltRelease');
    expect(byId('grenadelauncher').reload.perShell).not.toBeNull();
  });

  it('three Rift Forge tiers each: German names, forge prices rising, a special per tier', () => {
    for (const d of defs) {
      expect(
        d.upgrades.map((u) => u.tier),
        d.id,
      ).toEqual([1, 2, 3]);
      const names = new Set([d.name, ...d.upgrades.map((u) => u.name)]);
      expect(names.size, `${d.id} unique tier names`).toBe(4);
      for (let i = 0; i < d.upgrades.length; i++) {
        const u = d.upgrades[i]!;
        expect(u.name.length, d.id).toBeGreaterThan(3);
        // German quotes like the base names.
        expect(u.name, d.id).toMatch(/„.+“/);
        expect(u.cost, d.id).toBe(forgeTierCost(u.tier));
        if (i > 0) expect(u.cost, d.id).toBeGreaterThan(d.upgrades[i - 1]!.cost);
        expect(u.special, `${d.id} tier ${u.tier} special`).toBeTruthy();
        checkSpecial(`${d.id} t${u.tier}`, u.special!);
        for (const [k, v] of Object.entries(u.mods)) {
          if (k === 'element') expect(ELEMENTS, d.id).toContain(v);
          else if (k === 'extraPellets') expect(v, d.id).toBeGreaterThanOrEqual(0);
          else {
            expect(v as number, `${d.id} t${u.tier} ${k}`).toBeGreaterThan(0.3);
            expect(v as number, `${d.id} t${u.tier} ${k}`).toBeLessThan(3);
          }
        }
        if (u.palette !== undefined) expect(getForgeLook(u.palette), `${d.id} palette`).toBeDefined();
        const palette = forgePaletteId(d, u.tier);
        expect(palette && getForgeLook(palette), `${d.id} t${u.tier} look`).toBeTruthy();
      }
      // Every tier raises the damage; together roughly ×2.4–4 (the late waves need it).
      const total = d.upgrades.reduce((k, u) => k * (u.mods.damage ?? 1), 1);
      for (const u of d.upgrades) expect(u.mods.damage ?? 1, d.id).toBeGreaterThan(1);
      expect(total, d.id).toBeGreaterThan(2.4);
      expect(total, d.id).toBeLessThan(4);
      if (d.special) checkSpecial(`${d.id} base`, d.special);
    }
  });

  it('forge rules: costs, tier lookup, palettes', () => {
    expect(FORGE.tierCosts.length).toBe(FORGE.maxTier);
    for (let i = 1; i < FORGE.tierCosts.length; i++)
      expect(FORGE.tierCosts[i]!).toBeGreaterThan(FORGE.tierCosts[i - 1]!);
    expect(forgeTierCost(0)).toBe(0);
    expect(forgeTierCost(4)).toBe(0);
    const pistol = byId('pistol');
    expect(nextForgeTier(pistol, 0)?.tier).toBe(1);
    expect(nextForgeTier(pistol, 2)?.tier).toBe(3);
    expect(nextForgeTier(pistol, 3)).toBeNull();
    expect(forgePaletteId(pistol, 0)).toBeNull();
    expect(forgePaletteId(pistol, 1)).toBe('forge1');
    expect(forgePaletteId(pistol, 3)).toBe('forge3');
    for (const id of ['forge1', 'forge2', 'forge3']) expect(getForgeLook(id)?.id).toBe(id);
    expect(FORGE_LOOKS.forge3!.camo).not.toBeNull();
    expect(getForgeLook('nope')).toBeUndefined();
    expect(getForgeLook('toString')).toBeUndefined();
    for (const [key, look] of Object.entries(FORGE_LOOKS)) {
      expect(look.id).toBe(key);
      if (look.camo) {
        expect(look.camo.coverage).toBeGreaterThan(0);
        expect(look.camo.coverage).toBeLessThanOrEqual(1);
      }
    }
  });

  it('audio ids follow the naming convention', () => {
    for (const d of defs) {
      const a = d.audio;
      const pre = `weapon.${d.id}.`;
      if (!M2.has(d.id)) {
        expect(a.fire, d.id).toEqual([`${pre}fire`, `${pre}mech`, a.fire[2]]);
        expect(TAILS, d.id).toContain(a.fire[2]);
        expect(a.equip, d.id).toBe(`${pre}equip`);
        expect(a.dry, d.id).toBe('weapon.dry');
        expect(a.holster, d.id).toBe('weapon.holster');
        expect(a.reloadStart, d.id).toBe('weapon.reload.start');
        expect(a.melee, d.id).toBe('weapon.melee');
        expect(a.inspect, d.id).toBe('weapon.inspect');
        for (const [step, id] of Object.entries(a.steps)) expect(id, d.id).toBe(`${pre}${step}`);
        for (const id of a.extraFire ?? []) expect(id.startsWith(pre), id).toBe(true);
      }
      // Every reload marker has a sound.
      const steps = new Set([...d.reload.tacticalSteps, ...d.reload.emptySteps].map((s) => s.step));
      if (d.reload.perShell) {
        steps.add('shellIn');
        steps.add('pump');
      }
      for (const s of steps) expect(a.steps[s], `${d.id} ${s}`).toBeTruthy();
      if (d.beam) expect(d.beam.loopAudio).toBe(`${pre}loop`);
      if (d.charge) expect(d.charge.chargeAudio).toBe(`${pre}charge`);
      if (d.spinUp) expect(d.spinUp.loopAudio).toBe(`${pre}spin`);
      if (d.projectile?.flightAudio)
        expect(d.projectile.flightAudio).toBe(`projectile.${d.projectile.visual.split('.')[1]}.flight`);
      for (const e of explosionsOf(d))
        expect(e.audio, d.id).toMatch(new RegExp(`^explosion\\.${e.element}(\\.small)?$`));
      for (const f of fieldsOf(d)) expect(f.audio, d.id).toBe(`field.${f.kind}.${f.element}`);
    }
  });

  it('VFX ids follow the naming convention', () => {
    for (const d of defs) {
      expect(MUZZLES, `${d.id} muzzle`).toContain(d.vfx.muzzle);
      expect(IMPACTS, `${d.id} impact`).toContain(d.vfx.impact);
      if (d.vfx.casing) expect(d.vfx.casing, d.id).toMatch(/^casing\.(pistol|rifle|shell)$/);
      if (d.projectile) {
        expect(PROJECTILES, d.id).toContain(d.projectile.visual);
        if (d.projectile.trail) expect(TRAILS, d.id).toContain(d.projectile.trail);
      }
      if (d.beam) expect(BEAMS, d.id).toContain(d.beam.visual);
      if (d.charge) expect(d.charge.visual, d.id).toBe('charge.rail');
      for (const f of fieldsOf(d)) expect(FIELDS, d.id).toContain(f.vfx);
      for (const e of explosionsOf(d))
        expect([`explosion.${e.element}`, 'explosion.frag', 'impact.plasma'], d.id).toContain(e.vfx);
      // Energy weapons eject no brass.
      if (d.category === 'energy' || d.category === 'wonder') expect(d.vfx.casing, d.id).toBeNull();
    }
  });

  it('economy: wall guns cost 500–1500, energy/launcher/wonder weapons are box only', () => {
    for (const d of defs) {
      if (d.category === 'wonder' || d.category === 'energy' || d.category === 'launcher')
        expect(d.boxOnly, d.id).toBe(true);
      if (!d.boxOnly) {
        expect(d.cost, d.id).toBeGreaterThanOrEqual(500);
        expect(d.cost, d.id).toBeLessThanOrEqual(1500);
      }
    }
    for (const d of defs.filter((w) => w.category === 'wonder')) {
      expect(d.attachmentSlots, d.id).toEqual([]);
      expect(d.special, d.id).toBeTruthy();
    }
  });

  it('every weapon is obtainable: wall buys sell only wall guns, the box knows the roster', () => {
    const inPool = new Map(MYSTERY_BOX.pool.map((e) => [e.weapon, e.weight]));
    for (const e of MYSTERY_BOX.pool) expect(WEAPON_IDS as readonly string[], e.weapon).toContain(e.weapon);
    for (const d of defs) expect(inPool.get(d.id) ?? (d.boxOnly ? 1 : 0), d.id).toBeGreaterThan(0);
    // Wonder weapons are the rarest rolls.
    const wallWeight = Math.min(
      ...defs.filter((d) => !d.boxOnly && d.id !== 'pistol').map((d) => inPool.get(d.id)!),
    );
    for (const d of defs.filter((w) => w.category === 'wonder'))
      expect(inPool.get(d.id) ?? MYSTERY_BOX.boxOnlyWeight, d.id).toBeLessThan(wallWeight);
    const walls = [
      ...Object.values(WALL_BUYS.offers),
      ...Object.values(WALL_BUYS.placements).flatMap((list) => list.map((p) => p.weapon)),
    ];
    expect(walls.length).toBeGreaterThan(0);
    for (const id of walls) {
      const d = byId(id);
      expect(d, id).toBeDefined();
      expect(d.boxOnly ?? false, id).toBe(false);
      expect(d.kind, id).toBe('hitscan');
    }
  });

  it('balance: automatics deliver 250–700 body DPS; box weapons out-hit wall weapons', () => {
    const bodyDps = (d: WeaponDef): number => (d.damage.base * d.pellets * d.rpm) / 60;
    for (const d of defs.filter((w) => w.kind === 'hitscan' && w.fireMode === 'auto')) {
      expect(bodyDps(d), d.id).toBeGreaterThan(250);
      expect(bodyDps(d), d.id).toBeLessThan(700);
    }
    const wallBest = Math.max(...defs.filter((d) => !d.boxOnly).map((d) => d.damage.base * d.pellets));
    for (const d of defs.filter((w) => w.category === 'wonder')) {
      const blast = d.projectile?.explosion?.damage ?? 0;
      expect(d.damage.base + blast, d.id).toBeGreaterThanOrEqual(Math.min(wallBest, 200) * 0.5);
    }
    // The sniper one-shots a wave-10 Spucker (110 HP × 1.9) with a headshot, the revolver a
    // wave-10 Schwärmer (60 × 1.9) in the head.
    const sniper = byId('sniper');
    expect(sniper.damage.base * sniper.damage.headMultiplier).toBeGreaterThan(110 * 1.9);
    const revolver = byId('revolver');
    expect(revolver.damage.base * revolver.damage.headMultiplier).toBeGreaterThan(60 * 1.9);
  });
});

describe('attachments', () => {
  const atts: AttachmentDef[] = ATTACHMENT_IDS.map((id) => ATTACHMENTS[id]);

  it('at least 20, unique ids and models, German names, sane prices', () => {
    expect(atts.length).toBeGreaterThanOrEqual(20);
    expect(new Set(ATTACHMENT_IDS).size).toBe(atts.length);
    expect(new Set(atts.map((a) => a.model)).size).toBe(atts.length);
    for (const [key, a] of Object.entries(ATTACHMENTS)) expect(a.id).toBe(key);
    for (const a of atts) {
      expect(a.name.length, a.id).toBeGreaterThan(3);
      expect(a.description.length, a.id).toBeGreaterThan(20);
      expect(a.cost, a.id).toBeGreaterThanOrEqual(500);
      expect(a.cost, a.id).toBeLessThanOrEqual(2000);
      expect(
        ATTACHMENT_SLOTS.map((s) => s.slot),
        a.id,
      ).toContain(a.slot);
      expect(Object.keys(a.mods).length, a.id).toBeGreaterThan(0);
      for (const [k, v] of Object.entries(a.mods)) {
        expect(typeof v, `${a.id}.${k}`).toBe('number');
        expect(v as number, `${a.id}.${k}`).toBeGreaterThan(0.3);
        expect(v as number, `${a.id}.${k}`).toBeLessThan(3);
      }
      if (a.optic?.zoom != null) {
        expect(a.optic.zoom, a.id).toBeGreaterThan(0.2);
        expect(a.optic.zoom, a.id).toBeLessThanOrEqual(1);
      }
    }
    // The spec's families: optics, muzzles/barrels, magazines, grips.
    for (const slot of ['optic', 'muzzle', 'magazine', 'underbarrel', 'stock', 'laser'] as const)
      expect(atts.filter((a) => a.slot === slot).length, slot).toBeGreaterThanOrEqual(2);
    expect(getAttachmentDef('reddot')).toBe(ATTACHMENTS.reddot);
    expect(getAttachmentDef('toString')).toBeUndefined();
  });

  it('every attachment fits a weapon that has its slot; every weapon slot has attachments', () => {
    for (const a of atts) {
      const fits = defs.filter((d) => isAttachmentCompatible(a, d));
      expect(fits.length, a.id).toBeGreaterThan(0);
      for (const d of fits) expect(d.attachmentSlots, `${a.id} on ${d.id}`).toContain(a.slot);
    }
    for (const d of defs)
      for (const slot of d.attachmentSlots)
        expect(attachmentsFor(d, slot).length, `${d.id} ${slot}`).toBeGreaterThan(0);
    // Kind and category gates.
    expect(isAttachmentCompatible(ATTACHMENTS.suppressor, byId('plasma'))).toBe(false);
    expect(isAttachmentCompatible(ATTACHMENTS.choke, byId('rifle'))).toBe(false);
    expect(isAttachmentCompatible(ATTACHMENTS.choke, byId('shotgun'))).toBe(true);
    expect(attachmentsFor(byId('riftripper'))).toEqual([]);
  });

  it('optics set an absolute zoom through the adsZoom factor', () => {
    const rifle = byId('rifle');
    const m = attachmentMods(ATTACHMENTS.scope4x, rifle);
    expect(rifle.ads.zoom * m.adsZoom!).toBeCloseTo(ATTACHMENTS.scope4x.optic.zoom, 6);
    expect(m.adsTime).toBe(ATTACHMENTS.scope4x.mods.adsTime);
    const sniper = byId('sniper');
    expect(sniper.ads.zoom * attachmentMods(ATTACHMENTS.scope4x, sniper).adsZoom!).toBeCloseTo(0.31, 6);
    // No zoom: the attachment's mods as they are (no allocation).
    expect(attachmentMods(ATTACHMENTS.reddot, rifle)).toBe(ATTACHMENTS.reddot.mods);
  });
});
