import { describe, expect, it } from 'vitest';
import { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { MUSIC, MUSIC_CUES, MUSIC_STINGS } from '../../defs/music';
import { MusicConductor, StingLimiter, type ConductorSink } from './conductor';

const at = (x: number) => ({ x, y: 0, z: 0 });

function setup(mapId = 'lab') {
  const events = new EventBus<GameEvents>();
  const log: string[] = [];
  let clock = 100;
  const sink: ConductorSink = {
    applyState: (s) => log.push(`state:${s}`),
    playSting: (id, transpose) => log.push(transpose ? `sting:${id}:${transpose}` : `sting:${id}`),
    playCue: (id, p) => log.push(`cue:${id}@${p.x}`),
  };
  const c = new MusicConductor(events, sink, { mapId, now: () => clock, isBoss: (t) => t === 'overlord' });
  const take = (): string[] => log.splice(0);
  return {
    events,
    c,
    take,
    advance: (s: number) => {
      clock += s;
    },
  };
}

describe('music conductor (state machine)', () => {
  it('follows a whole run: menu → intermission → wave → boss → wave → intermission → game over → restart → menu', () => {
    const { events, c, take, advance } = setup();
    expect(c.state).toBe('off');
    events.emit('ui:menu', { open: true, menu: 'start' });
    expect(c.state).toBe('menu');
    expect(c.themeId).toBe(MUSIC.menuTheme);
    events.emit('game:paused', { reason: 'menu' });
    // Start: the wave director's first intermission, then the game resumes.
    events.emit('wave:intermission', { nextWave: 1, duration: 14 });
    events.emit('game:resumed', {});
    expect(c.state).toBe('intermission');
    expect(c.themeId).toBe('lab');
    expect(take()).toEqual(['state:menu', 'state:intermission']);

    events.emit('wave:start', { wave: 1, total: 12, kind: 'normal' });
    expect(c.state).toBe('wave');
    expect(take()).toEqual(['sting:waveStart', 'state:wave']);

    events.emit('enemy:spawned', { id: 7, type: 'overlord', position: at(5), elite: false });
    expect(c.state).toBe('boss');
    expect(c.themeId).toBe(MUSIC.bossTheme);
    expect(take()).toEqual([`cue:${MUSIC_CUES.boss.id}@5`, 'sting:bossAppear', 'state:boss']);
    // Other deaths keep the boss music.
    events.emit('enemy:died', { id: 3, type: 'swarmer', position: at(1), weaponId: null, zone: null, elite: false, source: 'player' });
    expect(c.state).toBe('boss');
    events.emit('enemy:died', { id: 7, type: 'overlord', position: at(5), weaponId: null, zone: null, elite: false, source: 'player' });
    expect(c.state).toBe('wave');
    expect(take()).toEqual(['sting:bossDefeated', 'state:wave']);

    advance(5);
    events.emit('wave:complete', { wave: 1, duration: 60 });
    events.emit('wave:intermission', { nextWave: 2, duration: 14 });
    expect(c.state).toBe('intermission');
    expect(take()).toEqual(['sting:waveComplete', 'state:intermission']);

    advance(5);
    events.emit('wave:start', { wave: 2, total: 20, kind: 'swarm' });
    expect(take()).toEqual([`sting:waveStart:${MUSIC.specialWaveSemis}`, 'state:wave']);

    events.emit('player:died', { position: at(0) });
    expect(c.state).toBe('gameover');
    // The game over state keeps the theme that played.
    expect(c.themeId).toBe('lab');
    expect(take()).toEqual(['sting:gameOver', 'state:gameover']);
    // The game over screen: no pause sting.
    events.emit('game:paused', { reason: 'menu' });
    events.emit('ui:menu', { open: true, menu: 'gameover' });
    expect(take()).toEqual([]);

    events.emit('run:restart', {});
    expect(c.state).toBe('intermission');
    events.emit('ui:menu', { open: true, menu: 'start' });
    expect(c.state).toBe('menu');
    expect(take()).toEqual(['state:intermission', 'state:menu']);
  });

  it('plays the pause sting, power-up accents and the quiet UI stings', () => {
    const { events, take, advance } = setup();
    events.emit('ui:menu', { open: true, menu: 'pause' });
    events.emit('powerup:collected', { type: 'nuke', position: at(0), duration: 0 });
    advance(2);
    events.emit('powerup:collected', { type: 'instakill', position: at(0), duration: 20 });
    events.emit('powerup:collected', { type: 'maxAmmo', position: at(0), duration: 0 });
    advance(2);
    events.emit('progression:levelUp', { level: 5, previous: 4, prestige: 0, skillPoints: 1 });
    events.emit('achievement:unlocked', { id: 'a', name: 'A', description: '', tier: 'gold', hidden: false, xp: 10 });
    expect(take()).toEqual([
      'sting:pause',
      'sting:nuke',
      'sting:instakill',
      'sting:levelUp',
      `sting:achievement:${MUSIC.achievementTierSemis.gold}`,
    ]);
  });

  it('rate-limits stings per id and in bursts, but never drops the game over sting', () => {
    const { events, c, take, advance } = setup();
    expect(c.sting('waveComplete')).toBe(true);
    expect(c.sting('waveComplete')).toBe(false);
    advance(MUSIC_STINGS.waveComplete.minInterval + 0.01);
    expect(c.sting('waveComplete')).toBe(true);
    take();
    // A burst of achievements at the run's end: the global bucket lets a few through.
    let played = 0;
    for (let k = 0; k < 10; k++) {
      advance(MUSIC_STINGS.achievement.minInterval + 0.01);
      if (c.sting('achievement')) played++;
    }
    expect(played).toBeLessThan(10);
    expect(played).toBeGreaterThanOrEqual(MUSIC.stingLimit.burst - 1);
    take();
    // The bucket is empty now – the game over sting still plays.
    events.emit('player:died', { position: at(0) });
    expect(take()).toContain('sting:gameOver');

    const limiter = new StingLimiter();
    expect(limiter.allow('x', 1, 0)).toBe(true);
    expect(limiter.allow('x', 1, 0.5)).toBe(false);
    expect(limiter.allow('x', 1, 1.01)).toBe(true);
  });

  it('gives elites a positional tell on spawn and on alert, culled by distance and rate', () => {
    const { events, c, take, advance } = setup();
    c.update(1 / 60, at(0));
    events.emit('enemy:spawned', { id: 1, type: 'swarmer', position: at(10), elite: false });
    events.emit('enemy:spawned', { id: 2, type: 'spitter', position: at(12), elite: true });
    expect(take()).toEqual([`cue:${MUSIC_CUES.elite.spawn.id}@12`]);
    // Same kind right away: merged.
    events.emit('enemy:spawned', { id: 3, type: 'spitter', position: at(13), elite: true });
    expect(take()).toEqual([]);
    events.emit('enemy:alert', { id: 1, type: 'swarmer', position: at(10) });
    events.emit('enemy:alert', { id: 2, type: 'spitter', position: at(9) });
    expect(take()).toEqual([`cue:${MUSIC_CUES.elite.alert.id}@9`]);
    advance(5);
    // Too far away to hear.
    events.emit('enemy:spawned', { id: 4, type: 'tank', position: at(MUSIC_CUES.elite.spawn.maxDistance + 5), elite: true });
    expect(take()).toEqual([]);
    // Dead elites forget their tell.
    events.emit('enemy:died', { id: 2, type: 'spitter', position: at(9), weaponId: null, zone: null, elite: true, source: 'player' });
    advance(5);
    events.emit('enemy:alert', { id: 2, type: 'spitter', position: at(9) });
    expect(take()).toEqual([]);
  });

  it('offers the M6 hooks: a scripted boss theme and forced states for the dev console', () => {
    const { events, c, take } = setup('arctic');
    events.emit('game:resumed', {});
    expect(c.themeId).toBe('arctic');
    c.setBossTheme('boss');
    expect(c.state).toBe('boss');
    expect(c.themeId).toBe('boss');
    c.setBossTheme(null);
    expect(c.state).toBe('intermission');
    take();
    c.force('wave');
    expect(c.state).toBe('wave');
    expect(c.autoState).toBe('intermission');
    events.emit('wave:start', { wave: 1, total: 5 });
    expect(c.state).toBe('wave');
    events.emit('player:died', { position: at(0) });
    // Forced: the game over does not take over the music …
    expect(c.state).toBe('wave');
    c.force(null);
    // … until the console lets go.
    expect(c.state).toBe('gameover');
    c.setMap('nowhere');
    expect(c.themeFor('intermission')).toBe(MUSIC.fallbackTheme);
  });

  it('clamps the intensity per state (calm cap, boss floor, fixed menu) and honours theme overrides', () => {
    const { events, c } = setup();
    c.setIntensity(1, 'dev');
    c.update(1 / 60);
    events.emit('game:resumed', {});
    expect(c.intensity).toBeCloseTo(MUSIC.states.intermission.max);
    events.emit('wave:start', { wave: 1, total: 5 });
    expect(c.intensity).toBe(1);
    c.setIntensity(0, 'dev');
    c.update(1 / 60);
    expect(c.intensity).toBeCloseTo(MUSIC.states.wave.min);
    c.setBossTheme('boss');
    expect(c.intensity).toBeCloseTo(MUSIC.states.boss.min);
    events.emit('ui:menu', { open: true, menu: 'start' });
    expect(c.intensity).toBeCloseTo(MUSIC.states.menu.min);
    // The calibration hall lets shooting bring in the groove.
    const hall = setup('testroom');
    hall.c.setIntensity(1, 'dev');
    hall.c.update(1 / 60);
    hall.events.emit('game:resumed', {});
    expect(hall.c.intensity).toBeCloseTo(0.66);
  });

  it('feeds the model from the game: kills, damage, health, nearby enemies', () => {
    const { events, c } = setup();
    events.emit('game:resumed', {});
    const enemies = [{ alive: true, type: 'tank', elite: true, position: at(3) }];
    c.setEnemySource({ enemies });
    for (let k = 0; k < 120; k++) c.update(1 / 60, at(0));
    const withThreat = c.model.value;
    expect(withThreat).toBeGreaterThan(0.2);
    events.emit('player:damaged', { amount: 30, healthFraction: 0.2 });
    events.emit('player:healthChanged', { health: 20, maxHealth: 100, armor: 0, maxArmor: 0 });
    events.emit('combat:kill', { targetId: 1, zone: 'head', weaponId: 'rifle', position: at(3), source: 'player' });
    for (let k = 0; k < 120; k++) c.update(1 / 60, at(0));
    expect(c.model.value).toBeGreaterThan(withThreat);
    expect(c.danger).toBeGreaterThan(0);
    events.emit('run:restart', {});
    expect(c.model.modelValue).toBe(0);
    c.dispose();
  });
});
