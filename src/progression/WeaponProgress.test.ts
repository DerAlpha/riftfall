import { describe, expect, it } from 'vitest';
import type { WeaponProgressData } from '../core/contracts';
import { CAMOS, type CamoDef } from '../defs/cosmetics';
import { PROGRESSION } from '../defs/progression';
import { WEAPON_IDS } from '../defs/weapons';
import { createSignal, type ProgressSignal } from './signals';
import { WeaponProgress, type GlobalCamoSink } from './WeaponProgress';
import { xpToNext } from './xpCurve';

const W = PROGRESSION.weapon;

function setup() {
  const data: Record<string, WeaponProgressData> = {};
  const owned = new Set<string>();
  const globals: GlobalCamoSink = {
    has: (id) => owned.has(id),
    unlock: (id) => (owned.has(id) ? false : (owned.add(id), true)),
    globalCamos: () => [...owned],
  };
  const log = { levels: [] as string[], camos: [] as string[], mastered: [] as string[] };
  const wp = new WeaponProgress(
    data,
    {
      onLevelUp: (w, l) => log.levels.push(`${w}:${l}`),
      onCamo: (w, c: CamoDef) => log.camos.push(`${w ?? '*'}:${c.id}`),
      onMastered: (w) => log.mastered.push(w),
    },
    globals,
  );
  return { wp, data, log, owned };
}

function killSignal(
  weapon: string | null,
  zone: 'head' | 'body' | 'weakpoint' = 'body',
  elite = false,
): ProgressSignal {
  const s = createSignal();
  s.metric = 'kill';
  s.amount = 1;
  s.tags.weapon = weapon;
  s.tags.zone = zone;
  s.tags.elite = elite;
  return s;
}

describe('WeaponProgress', () => {
  it('earns weapon XP from kills (headshot bonus, elite multiplier) and hits', () => {
    const { wp, data } = setup();
    wp.signal(killSignal('rifle'));
    expect(data.rifle!.xp).toBe(W.xpPerKill);
    wp.signal(killSignal('rifle', 'head'));
    expect(data.rifle!.xp).toBe(2 * W.xpPerKill + W.headshotBonus);
    wp.signal(killSignal('rifle', 'body', true));
    expect(data.rifle!.xp).toBe(2 * W.xpPerKill + W.headshotBonus + W.xpPerKill * W.eliteMultiplier);
    const hit = createSignal();
    hit.metric = 'shotHit';
    hit.amount = 1;
    hit.tags.weapon = 'rifle';
    wp.signal(hit);
    expect(data.rifle!.xp).toBe(
      2 * W.xpPerKill + W.headshotBonus + W.xpPerKill * W.eliteMultiplier + W.xpPerHit,
    );
    expect(data.rifle!.counters).toEqual({ kills: 3, headshots: 1, elites: 1 });
  });

  it('ignores non-roster weapons (grenades, abilities, the nuke)', () => {
    const { wp, data } = setup();
    expect(wp.signal(killSignal(null))).toBe(false);
    expect(wp.addXp('grenade.frag', 100)).toBe(-1);
    expect(wp.view('grenade.frag')).toBeNull();
    expect(Object.keys(data)).toEqual([]);
  });

  it('levels up with the curve and unlocks level camos', () => {
    const { wp, data, log } = setup();
    const need =
      xpToNext(W.curve, W.maxLevel, 1) + xpToNext(W.curve, W.maxLevel, 2) + xpToNext(W.curve, W.maxLevel, 3);
    expect(wp.addXp('smg', need)).toBe(3);
    expect(data.smg!.level).toBe(4);
    expect(log.levels).toEqual(['smg:2', 'smg:3', 'smg:4']);
    expect(data.smg!.camos).toContain('camo.urban');
    expect(log.camos).toContain('smg:camo.urban');
  });

  it('unlocks counter camos ("50 Kopfschuss-Kills") per weapon', () => {
    const { wp, data } = setup();
    for (let i = 0; i < 49; i++) wp.signal(killSignal('pistol', 'head'));
    expect(data.pistol!.camos).not.toContain('camo.gold');
    wp.signal(killSignal('pistol', 'head'));
    expect(data.pistol!.camos).toContain('camo.gold');
    expect(data.rifle).toBeUndefined();
  });

  it('masters a weapon (animated camo) and unlocks global camos for mastered weapons', () => {
    const { wp, data, log, owned } = setup();
    const master = (id: string): void => {
      const e = wp.entry(id)!;
      e.counters = { kills: 500, headshots: 150, weakpoints: 50 };
      wp.setLevel(id, W.maxLevel);
    };
    master('rifle');
    expect(data.rifle!.camos).toEqual(
      expect.arrayContaining(['camo.gold', 'camo.platinum', 'camo.diamond', 'camo.riftflow']),
    );
    expect(log.mastered).toEqual(['rifle']);
    const nebula = CAMOS.find((c) => c.id === 'camo.nebula')!;
    const needed = nebula.unlock.kind === 'weaponsMastered' ? nebula.unlock.count : 0;
    for (const id of WEAPON_IDS.filter((w) => w !== 'rifle').slice(0, needed - 1)) master(id);
    expect(owned.has('camo.nebula')).toBe(true);
    expect(log.camos).toContain('*:camo.nebula');
    expect(wp.view('shotgun')!.camos).toContain('camo.nebula');
    expect(wp.masteredCount()).toBe(needed);
  });

  it('equips only usable camos', () => {
    const { wp, owned } = setup();
    wp.setLevel('lmg', 8);
    expect(wp.equipCamo('lmg', 'camo.digital')).toBe(true);
    expect(wp.equipCamo('lmg', 'camo.gold')).toBe(false);
    expect(wp.equipCamo('lmg', 'camo.aurora')).toBe(false);
    owned.add('camo.aurora');
    expect(wp.equipCamo('lmg', 'camo.aurora')).toBe(true);
    expect(wp.equipCamo('lmg', null)).toBe(true);
    expect(wp.equipCamo('nope', null)).toBe(false);
  });
});
