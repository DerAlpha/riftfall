import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents, HitZone } from '../core/events';
import { ENEMIES } from '../defs/enemies';
import { RUN } from '../defs/waves';
import { RunStats, accuracyOf, computeScore, killScore } from './RunStats';

const O = { x: 0, y: 0, z: 0 };

function setup() {
  const events = new EventBus<GameEvents>();
  const stats = new RunStats(events);
  stats.active = true;
  const fire = (weaponId = 'rifle'): void =>
    events.emit('weapon:fired', {
      weaponId,
      origin: O,
      direction: { x: 0, y: 0, z: -1 },
      muzzle: O,
      shotIndex: 0,
      ammoInMag: 10,
      ads: false,
    });
  const damage = (amount: number, source: 'player' | 'enemy' = 'player', zone: HitZone = 'body'): void =>
    events.emit('combat:damage', {
      targetId: 1,
      amount,
      zone,
      point: O,
      killed: false,
      weaponId: 'rifle',
      element: 'physical',
      source,
    });
  const died = (type: string, zone: HitZone | null, source: 'player' | 'environment' = 'player'): void =>
    events.emit('enemy:died', { id: 1, type, position: O, weaponId: 'rifle', zone, elite: false, source });
  return { events, stats, fire, damage, died };
}

describe('RunStats', () => {
  it('counts a shotgun blast as one hit however many pellets land', () => {
    const { stats, fire, damage } = setup();
    fire('shotgun');
    for (let i = 0; i < 9; i++) damage(12);
    expect(stats.shotsFired).toBe(1);
    expect(stats.shotsHit).toBe(1);
    expect(stats.damageDealt).toBe(9 * 12);
    fire('shotgun'); // miss
    fire('shotgun');
    damage(12);
    damage(12);
    expect(stats.shotsFired).toBe(3);
    expect(stats.shotsHit).toBe(2);
    expect(stats.accuracy).toBeCloseTo(2 / 3);
  });

  it('ignores melee blows, enemy damage and damage without a shot', () => {
    const { events, stats, fire, damage } = setup();
    damage(50); // e.g. an explosion before any shot
    expect(stats.shotsHit).toBe(0);
    fire(); // miss
    events.emit('weapon:melee', { weaponId: 'rifle', duration: 0.5, hit: true });
    damage(40); // the melee blow
    expect(stats.shotsHit).toBe(0);
    expect(stats.damageDealt).toBe(90);
    fire();
    damage(20, 'enemy');
    expect(stats.shotsHit).toBe(0);
    damage(20);
    expect(stats.shotsHit).toBe(1);
  });

  it('counts player kills with head / weakpoint bonus points from the enemy defs', () => {
    const { stats, died } = setup();
    died('swarmer', 'head');
    died('spitter', 'weakpoint');
    died('tank', 'body');
    died('swarmer', 'body', 'environment'); // kill plane: no credit
    died('unknownthing', null);
    expect(stats.kills).toBe(4);
    expect(stats.headshots).toBe(1);
    expect(stats.weakpointKills).toBe(1);
    const P = ENEMIES;
    const expected =
      P.swarmer.points.kill +
      P.swarmer.points.headshotBonus +
      P.spitter.points.kill +
      P.spitter.points.weakpointBonus +
      P.tank.points.kill +
      RUN.score.defaultKill;
    expect(stats.snapshot().killPoints).toBe(expected);
  });

  it('tracks damage taken, time, waves; counts nothing while inactive', () => {
    const { events, stats, fire, died } = setup();
    events.emit('player:damaged', { amount: 25, healthFraction: 0.75 });
    events.emit('wave:start', { wave: 3, total: 10 });
    events.emit('wave:complete', { wave: 3, duration: 40 });
    events.emit('wave:start', { wave: 4, total: 12 });
    stats.tick(1.5);
    stats.tick(Number.NaN);
    expect(stats.damageTaken).toBe(25);
    expect(stats.wave).toBe(4);
    expect(stats.wavesCompleted).toBe(3);
    expect(stats.timeSurvived).toBeCloseTo(1.5);
    stats.active = false;
    fire();
    died('swarmer', 'head');
    stats.tick(10);
    events.emit('player:damaged', { amount: 25, healthFraction: 0.5 });
    expect(stats.shotsFired).toBe(0);
    expect(stats.kills).toBe(0);
    expect(stats.timeSurvived).toBeCloseTo(1.5);
    expect(stats.damageTaken).toBe(25);
    stats.reset();
    expect(stats.snapshot()).toMatchObject({ kills: 0, wave: 0, damageTaken: 0, score: 0 });
  });
});

describe('score', () => {
  it('adds kill points, waves, time and an accuracy bonus', () => {
    const S = RUN.score;
    const base = { killPoints: 1000, kills: 10, wavesCompleted: 2, timeSurvived: 60.9, accuracy: 0.5 };
    expect(computeScore(base)).toBe(
      1000 + 2 * S.waveBonus + 60 * S.perSecond + Math.round(10 * S.accuracyPerKill * 0.5),
    );
    expect(computeScore({ ...base, accuracy: 1 })).toBeGreaterThan(computeScore(base));
    expect(
      computeScore({ killPoints: Number.NaN, kills: -1, wavesCompleted: 0, timeSurvived: 0, accuracy: 2 }),
    ).toBe(0);
  });

  it('computes accuracy and kill points safely', () => {
    expect(accuracyOf(0, 0)).toBe(0);
    expect(accuracyOf(4, 1)).toBe(0.25);
    expect(accuracyOf(1, 5)).toBe(1);
    const pts = { kill: 60, headshotBonus: 40, weakpointBonus: 30 };
    expect(killScore(pts, 'head')).toBe(100);
    expect(killScore(pts, 'weakpoint')).toBe(90);
    expect(killScore(pts, null)).toBe(60);
  });
});
