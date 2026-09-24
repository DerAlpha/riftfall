import { describe, expect, it } from 'vitest';
import { CombatWorld } from '../combat/CombatWorld';
import { FakeTarget, buildTestLevel } from '../combat/testFakes';
import { EventBus } from '../core/EventBus';
import type { GameEvents, HitZone } from '../core/events';
import { ECONOMY, waveBonus } from '../defs/economy';
import { ENEMY_AI, getEnemyDef } from '../defs/enemies';
import { WEAPONS } from '../defs/weapons';
import { fakeSettings } from '../player/testHelpers';
import { StatSystem } from '../stats/StatSystem';
import { FakeCamera, FakePlayer, FakeWeaponInput, fakeRenderCamera } from '../weapons/testFakes';
import { WeaponSystem } from '../weapons/WeaponSystem';
import { TARGET_ID_BASE } from '../world/TrainingTargets';
import { EconomySystem } from './EconomySystem';
import { PointsRules, isRewardableId, killPoints, type PointsRulesDeps } from './PointsRules';

const P = ECONOMY.points;
const DT = 1 / 60;

function setup(deps: Partial<Pick<PointsRulesDeps, 'rewardOf'>> = {}) {
  const events = new EventBus<GameEvents>();
  const stats = new StatSystem({ events });
  const economy = new EconomySystem({ events, stats }, 0);
  const rules = new PointsRules({ events, economy, ...deps });
  const reasons: string[] = [];
  events.on('economy:points', (e) => reasons.push(`${e.reason}:${e.delta}`));
  const damage = (targetId: number, opts: Partial<GameEvents['combat:damage']> = {}): void => {
    events.emit('combat:damage', {
      targetId,
      amount: 20,
      zone: 'body',
      point: { x: 0, y: 1, z: 0 },
      killed: false,
      weaponId: 'rifle',
      element: 'physical',
      source: 'player',
      ...opts,
    });
  };
  const kill = (targetId: number, zone: HitZone = 'body', source: 'player' | 'enemy' = 'player'): void => {
    damage(targetId, { zone, source, killed: true });
    events.emit('combat:kill', { targetId, zone, weaponId: 'rifle', position: { x: 0, y: 1, z: 0 }, source });
  };
  const died = (id: number, opts: Partial<GameEvents['enemy:died']> = {}): void => {
    events.emit('enemy:died', {
      id,
      type: 'swarmer',
      position: { x: 0, y: 0, z: 0 },
      weaponId: 'rifle',
      zone: 'body',
      elite: false,
      source: 'player',
      ...opts,
    });
  };
  const impact = (kind: GameEvents['combat:impact']['kind']): void => {
    events.emit('combat:impact', {
      point: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      surface: 'flesh',
      kind,
      weaponId: 'rifle',
      decal: false,
    });
  };
  return { events, stats, economy, rules, reasons, damage, kill, died, impact };
}

describe('PointsRules: pure rules', () => {
  it('kill points: body 60, head/weakpoint 100, melee 130', () => {
    expect(killPoints('body', false)).toBe(60);
    expect(killPoints('limb', false)).toBe(60);
    expect(killPoints('head', false)).toBe(100);
    expect(killPoints('weakpoint', false)).toBe(100);
    expect(killPoints('head', true)).toBe(130);
    expect(killPoints(null, false)).toBe(60);
    expect(P.hit).toBe(10);
  });

  it('only enemy ids pay (training dummies start at 1_000_000)', () => {
    expect(isRewardableId(1)).toBe(true);
    expect(isRewardableId(ENEMY_AI.maxId)).toBe(true);
    expect(isRewardableId(0)).toBe(false);
    expect(isRewardableId(TARGET_ID_BASE)).toBe(false);
    expect(isRewardableId(1.5)).toBe(false);
  });
});

describe('PointsRules: events', () => {
  it('pays 10 per non-lethal player hit and the kill value for the killing blow only', () => {
    const t = setup();
    t.damage(5);
    t.damage(5);
    expect(t.economy.points).toBe(20);
    t.kill(5);
    expect(t.economy.points).toBe(20 + P.kill);
    t.kill(6, 'head');
    expect(t.economy.points).toBe(20 + P.kill + P.headshotKill);
    expect(t.reasons).toEqual(['hit:10', 'hit:10', `kill:${P.kill}`, `headshot:${P.headshotKill}`]);
    // Zero-damage hits (immune shields) pay nothing.
    t.damage(7, { amount: 0 });
    expect(t.reasons).toHaveLength(4);
  });

  it('pays nothing for dummies, enemy/trap damage or flagged dev spawns', () => {
    const t = setup();
    t.damage(TARGET_ID_BASE + 3);
    t.kill(TARGET_ID_BASE + 3, 'head');
    t.damage(9, { source: 'enemy' });
    t.kill(9, 'body', 'enemy');
    t.damage(10, { source: 'trap' });
    t.rules.flagNoReward(11);
    t.damage(11);
    t.kill(11);
    t.died(11, { elite: true });
    expect(t.economy.points).toBe(0);
    // The flag is cleared with the death: a recycled id pays again.
    t.damage(11);
    expect(t.economy.points).toBe(P.hit);
  });

  it('detects melee kills from the melee impact that precedes the blow', () => {
    const t = setup();
    t.impact('melee');
    t.kill(3);
    expect(t.reasons.at(-1)).toBe(`melee:${P.meleeKill}`);
    // A melee bash that only hit the world must not turn the next (non-impact) kill into melee.
    t.impact('melee');
    t.events.emit('weapon:fired', {
      weaponId: 'rifle',
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      muzzle: { x: 0, y: 0, z: 0 },
      shotIndex: 0,
      ammoInMag: 1,
      ads: false,
    });
    t.impact('bullet');
    t.kill(4);
    expect(t.reasons.at(-1)).toBe(`kill:${P.kill}`);
    t.impact('melee');
    t.events.emit('weapon:reloadStart', { weaponId: 'rifle', empty: false, duration: 1 });
    t.kill(5);
    expect(t.reasons.at(-1)).toBe(`kill:${P.kill}`);
    // A non-lethal melee hit consumes the flag too.
    t.impact('melee');
    t.damage(6);
    t.kill(6);
    expect(t.reasons.slice(-2)).toEqual(['hit:10', `kill:${P.kill}`]);
  });

  it('elite bonus, nuke kills and the wave bonus', () => {
    const t = setup();
    t.kill(20);
    t.died(20, { elite: true });
    expect(t.economy.points).toBe(P.kill + P.eliteKillBonus);
    // Nuke kills have no combat:kill; the nuke's flat bonus is the power-up's.
    t.died(21, { weaponId: ENEMY_AI.nukeWeaponId, elite: true });
    expect(t.economy.points).toBe(P.kill + P.eliteKillBonus + P.nukeKill);
    t.events.emit('wave:complete', { wave: 3, duration: 60 });
    expect(t.economy.points).toBe(P.kill + P.eliteKillBonus + P.nukeKill + waveBonus(3));
    expect(t.rules.stats.wave).toBe(waveBonus(3));
  });

  it('double points doubles every reward', () => {
    const t = setup();
    t.stats.addModifier({ source: 'powerup:double', stat: 'pointsMultiplier', op: 'mul', value: 2 });
    t.damage(1);
    t.kill(1, 'head');
    expect(t.economy.points).toBe(2 * (P.hit + P.headshotKill));
  });

  it('repair points are capped per wave and reset on wave:start', () => {
    const t = setup();
    const r = ECONOMY.repair;
    let total = 0;
    for (let i = 0; i < 200; i++) total += t.rules.awardRepair(1);
    expect(total).toBe(r.capPerWave);
    expect(t.rules.repairAllowance).toBe(0);
    expect(t.rules.awardRepair(3)).toBe(0);
    t.events.emit('wave:start', { wave: 2, total: 10 });
    expect(t.rules.awardRepair(3)).toBe(3 * r.perPlank);
    expect(t.rules.awardRepair(0)).toBe(0);
  });

  it('reset clears flags, counters and the repair cap; dispose unsubscribes', () => {
    const t = setup();
    t.rules.flagNoReward(1);
    t.rules.awardRepair(10);
    t.rules.reset();
    t.damage(1);
    expect(t.economy.points).toBe(10 * ECONOMY.repair.perPlank + P.hit);
    expect(t.rules.repairAllowance).toBe(ECONOMY.repair.capPerWave);
    t.rules.dispose();
    t.kill(2);
    expect(t.economy.points).toBe(10 * ECONOMY.repair.perPlank + P.hit);
  });
});

describe('PointsRules: kill credit per enemy kind (defs/enemies points)', () => {
  const kinds = new Map<number, string>([
    [1, 'swarmer'],
    [2, 'spitter'],
    [3, 'tank'],
    [4, 'tank'],
    [5, 'spitter'],
    [6, 'tank'],
  ]);
  const rewardOf = (id: number) => getEnemyDef(kinds.get(id) ?? '')?.points ?? null;

  it('each kind pays its own kill value and precision bonus', () => {
    const t = setup({ rewardOf });
    const swarmer = getEnemyDef('swarmer')!.points;
    const spitter = getEnemyDef('spitter')!.points;
    const tank = getEnemyDef('tank')!.points;
    expect(tank.kill).toBeGreaterThan(spitter.kill);
    expect(spitter.kill).toBeGreaterThan(swarmer.kill);
    t.kill(1);
    t.kill(2, 'head');
    t.kill(3);
    t.kill(4, 'weakpoint');
    t.kill(5, 'weakpoint');
    expect(t.reasons).toEqual([
      `kill:${swarmer.kill}`,
      `headshot:${spitter.kill + spitter.headshotBonus}`,
      `kill:${tank.kill}`,
      `headshot:${tank.kill + tank.weakpointBonus}`,
      `headshot:${spitter.kill + spitter.weakpointBonus}`,
    ]);
    // Melee: the kind's kill value plus the melee bonus.
    t.impact('melee');
    t.kill(6);
    expect(t.reasons.at(-1)).toBe(`melee:${tank.kill + P.meleeKillBonus}`);
  });

  it('hits pay the kind\'s hit value; unknown ids fall back to the default table', () => {
    const t = setup({ rewardOf: (id) => (id === 7 ? { hit: 15, kill: 80, headshotBonus: 0, weakpointBonus: 0 } : null) });
    t.damage(7);
    t.damage(8);
    t.kill(8, 'head');
    expect(t.reasons).toEqual(['hit:15', `hit:${P.fallback.hit}`, `headshot:${P.fallback.kill + P.fallback.headshotBonus}`]);
  });
});

describe('PointsRules with the real weapon system', () => {
  function rig() {
    const t = setup();
    const input = new FakeWeaponInput();
    const player = new FakePlayer();
    const camera = new FakeCamera(player);
    const combat = new CombatWorld({ events: t.events, physics: null });
    combat.setLevel(
      buildTestLevel([
        { material: 'concrete_wall', center: { x: 0, y: 1.5, z: -30 }, size: { x: 20, y: 3, z: 0.5 } },
      ]),
    );
    const weapons = new WeaponSystem(
      {
        events: t.events,
        input,
        settings: fakeSettings(),
        player,
        camera,
        render: fakeRenderCamera({ x: 0, y: 1.6, z: 0 }),
        combat,
        getMuzzleWorld: (o) => o.set(0.2, 1.45, -0.5),
      },
      { loadout: ['pistol'], slots: 2, seed: 'points' },
    );
    const frame = (n = 1): void => {
      for (let i = 0; i < n; i++) {
        weapons.fixedUpdate(DT);
        weapons.update(DT);
        input.endFrame();
      }
    };
    frame(60);
    return { ...t, input, player, combat, weapons, frame };
  }

  it('shots pay hit points, a head kill pays the headshot value', () => {
    const r = rig();
    const target = new FakeTarget({ x: 0, y: 0, z: -6 }, 1000);
    r.combat.register(target);
    r.input.tap('fire');
    r.frame(20);
    expect(r.economy.points).toBe(P.hit);
    // Aim at the head (eye 1.6 m, head 1.62 m) and finish it.
    target.health = 1;
    r.player.pitch = Math.atan2(0.02, 6);
    r.input.tap('fire');
    r.frame(20);
    expect(r.reasons.at(-1)).toBe(`headshot:${P.headshotKill}`);
  });

  it('a melee kill pays the melee value', () => {
    const r = rig();
    const target = new FakeTarget({ x: 0, y: 0, z: -1.2 }, WEAPONS.pistol.melee.damage);
    r.combat.register(target);
    r.input.tap('melee');
    r.frame(Math.ceil(WEAPONS.pistol.melee.hitTime / DT) + 2);
    expect(target.alive).toBe(false);
    expect(r.reasons).toEqual([`melee:${P.meleeKill}`]);
  });
});
