import { describe, expect, it } from 'vitest';
import type { PlayOptions } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { Rng } from '../core/Rng';
import { AUDIO } from '../defs/audio';
import { ENEMIES, PROJECTILES, getEnemyAttackDef } from '../defs/enemies';
import type { LoopOptions } from './AudioEngine';
import {
  AudioEventBridge,
  VoiceBudget,
  gaitStepIndex,
  type AudioBridgeTarget,
  type EnemyAudioView,
} from './AudioEventBridge';
import { ENEMY_SYNTH_ALIASES, ENEMY_SYNTH_DEFS, enemySynthAlias, resolveEnemySynthId } from './enemySynth';
import { SYNTH_DEFS, resolveSynthId, type SynthGraph } from './synth';
import { WEAPON_SYNTH_DEFS } from './weaponSynth';

const E = AUDIO.enemies;
const ST = AUDIO.stings;

/** Resolves before and after synth.ts merges the enemy bank. */
const resolves = (id: string): boolean => resolveEnemySynthId(id) !== null || resolveSynthId(id) !== null;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

describe('enemy sound ids', () => {
  it('resolves every id the enemy defs, strikes, projectile impacts and stings reference', () => {
    for (const def of Object.values(ENEMIES)) {
      const a = def.audio;
      for (const id of [a.spawn, a.alert, a.hurt, a.death, a.step, a.idle])
        expect(resolves(id), id).toBe(true);
      for (const atk of def.attacks) expect(resolves(atk.sound), atk.sound).toBe(true);
    }
    for (const [type, attacks] of Object.entries(E.strikes)) {
      for (const [attack, id] of Object.entries(attacks)) {
        expect(getEnemyAttackDef(type, attack), `${type}.${attack}`).toBeDefined();
        expect(resolves(id), id).toBe(true);
      }
    }
    for (const [weaponId, id] of Object.entries(E.projectileImpacts)) {
      expect(
        Object.values(PROJECTILES).some((p) => p.weaponId === weaponId),
        weaponId,
      ).toBe(true);
      expect(resolves(id), id).toBe(true);
    }
    for (const s of Object.values(ST)) expect(resolves(s.id), s.id).toBe(true);
  });

  it('covers the M3 sound list: chitter, screech, gurgle, splash, thuds, roar, bellow, slam, rift, stings', () => {
    for (const id of [
      'enemy.swarmer.idle',
      'enemy.swarmer.step',
      'enemy.swarmer.alert',
      'enemy.swarmer.bite',
      'enemy.spitter.idle',
      'enemy.spitter.spit.launch',
      'enemy.acid.splash',
      'enemy.tank.step',
      'enemy.tank.alert',
      'enemy.tank.charge',
      'enemy.tank.slam.impact',
      'enemy.death.squelch',
      'enemy.death.burst',
      'rift.tear',
      'sting.wave.start',
      'sting.wave.complete',
      'sting.gameover',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(ENEMY_SYNTH_DEFS, id), id).toBe(true);
    }
  });

  it('keeps aliases pointing at real defs and never collides with the other banks', () => {
    for (const [alias, target] of Object.entries(ENEMY_SYNTH_ALIASES)) {
      expect(Object.prototype.hasOwnProperty.call(ENEMY_SYNTH_DEFS, alias)).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(ENEMY_SYNTH_DEFS, target)).toBe(true);
      expect(enemySynthAlias(alias)).toBe(target);
      expect(resolveEnemySynthId(alias)).toBe(target);
    }
    expect(enemySynthAlias('enemy.nope')).toBeNull();
    expect(resolveEnemySynthId('enemy.nope')).toBeNull();
    for (const id of Object.keys(ENEMY_SYNTH_DEFS)) {
      expect(Object.prototype.hasOwnProperty.call(WEAPON_SYNTH_DEFS, id), id).toBe(false);
      // Merged into the bank (after integration) it must be this very def.
      if (Object.prototype.hasOwnProperty.call(SYNTH_DEFS, id)) {
        expect((SYNTH_DEFS as Record<string, unknown>)[id]).toBe(
          (ENEMY_SYNTH_DEFS as Record<string, unknown>)[id],
        );
      }
    }
  });

  it('renders positional sounds mono (HRTF input) and the stings in stereo', () => {
    for (const [id, def] of Object.entries(ENEMY_SYNTH_DEFS)) {
      expect(def.channels, id).toBe(id.startsWith('sting.') ? 2 : 1);
      expect(def.variants, id).toBeGreaterThanOrEqual(1);
      expect(def.level, id).toBeGreaterThan(0);
      expect(def.level, id).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Recipes against a validating fake OfflineAudioContext
// ---------------------------------------------------------------------------

class FakeParam {
  value = 0;
  constructor(private readonly log: string[]) {}
  private check(v: number, t: number, what: string): void {
    if (!Number.isFinite(v) || !Number.isFinite(t) || t < 0) this.log.push(`${what}(${v}, ${t})`);
  }
  setValueAtTime(v: number, t: number): this {
    this.check(v, t, 'setValueAtTime');
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.check(v, t, 'linearRamp');
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    if (!(v > 0)) this.log.push(`exponentialRamp to ${v}`);
    this.check(v, t, 'exponentialRamp');
    return this;
  }
  setTargetAtTime(v: number, t: number, c: number): this {
    if (!(c > 0)) this.log.push(`setTargetAtTime constant ${c}`);
    this.check(v, t, 'setTarget');
    return this;
  }
}

class FakeNode {
  constructor(protected readonly log: string[]) {}
  connect<T>(n: T): T {
    if (!n) this.log.push('connect(undefined)');
    return n;
  }
}

class FakeSource extends FakeNode {
  constructor(
    log: string[],
    private readonly starts: number[],
    private readonly stops: number[],
  ) {
    super(log);
  }
  start(t: number): void {
    if (!Number.isFinite(t) || t < 0) this.log.push(`start(${t})`);
    this.starts.push(t);
  }
  stop(t: number): void {
    if (!Number.isFinite(t)) this.log.push(`stop(${t})`);
    this.stops.push(t);
  }
}

class FakeOfflineContext {
  readonly sampleRate = 48000;
  readonly errors: string[] = [];
  readonly starts: number[] = [];
  readonly stops: number[] = [];
  readonly params: FakeParam[] = [];
  constructor(channels: number) {
    this.destination = Object.assign(new FakeNode(this.errors), { channelCount: channels });
  }
  readonly destination: FakeNode & { channelCount: number };
  private param(): FakeParam {
    const p = new FakeParam(this.errors);
    this.params.push(p);
    return p;
  }
  createGain() {
    return Object.assign(new FakeNode(this.errors), { gain: this.param() });
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(this.errors), {
      type: 'lowpass',
      frequency: this.param(),
      Q: this.param(),
    });
  }
  createOscillator() {
    return Object.assign(new FakeSource(this.errors, this.starts, this.stops), {
      type: 'sine',
      frequency: this.param(),
    });
  }
  createBufferSource() {
    return Object.assign(new FakeSource(this.errors, this.starts, this.stops), {
      buffer: null as unknown,
      loop: false,
      playbackRate: this.param(),
    });
  }
  createWaveShaper() {
    return Object.assign(new FakeNode(this.errors), { curve: null as unknown, oversample: 'none' });
  }
  createStereoPanner() {
    return Object.assign(new FakeNode(this.errors), { pan: this.param() });
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { length, duration: length / rate, copyToChannel: () => undefined };
  }
}

describe('enemy synth recipes', () => {
  it('schedule valid Web Audio graphs that start inside the rendered duration', () => {
    for (const [id, def] of Object.entries(ENEMY_SYNTH_DEFS)) {
      for (let v = 0; v < def.variants; v++) {
        const ctx = new FakeOfflineContext(def.channels);
        const graph = { ctx, rng: new Rng(`test:${id}:${v}`) } as unknown as SynthGraph;
        def.recipe(graph, 0);
        expect(ctx.errors, id).toEqual([]);
        expect(ctx.starts.length, id).toBeGreaterThan(0);
        for (const t of ctx.starts) expect(t, id).toBeLessThan(def.duration);
        for (const p of ctx.params) expect(Number.isFinite(p.value), id).toBe(true);
      }
    }
  });

  it('are deterministic per seed (same graph for the same variant)', () => {
    const def = ENEMY_SYNTH_DEFS['enemy.swarmer.idle'];
    const run = (seed: string): number[] => {
      const ctx = new FakeOfflineContext(1);
      def.recipe({ ctx, rng: new Rng(seed) } as unknown as SynthGraph, 0);
      return ctx.starts;
    };
    expect(run('a')).toEqual(run('a'));
    expect(run('a')).not.toEqual(run('b'));
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('VoiceBudget', () => {
  it('fills free voices, frees them after the hold', () => {
    const b = new VoiceBudget(2);
    expect(b.admit(0, 10, 1, 1)).toBe(true);
    expect(b.admit(0, 12, 1, 1)).toBe(true);
    expect(b.busy(0.5)).toBe(2);
    expect(b.admit(0.5, 30, 1, 1)).toBe(false);
    expect(b.admit(1.01, 30, 1, 1)).toBe(true);
    b.reset();
    expect(b.busy(1.02)).toBe(0);
  });

  it('lets nearer requests (beyond the margin) and higher priorities replace the worst voice', () => {
    const b = new VoiceBudget(2);
    b.admit(0, 20, 1, 5);
    b.admit(0, 30, 1, 5);
    expect(b.admit(0, 29, 1, 5, 2)).toBe(false); // not enough nearer than the farthest (30)
    expect(b.admit(0, 5, 1, 5, 2)).toBe(true); // replaces the 30 m voice
    expect(b.admit(0, 25, 1, 5, 2)).toBe(false); // now 5 and 20 are busy
    expect(b.admit(0, 60, 3, 5, 2)).toBe(true); // higher priority wins regardless of distance
    // Priority 1 only ever competes with the other priority-1 voice (5 m), never the priority-3 one.
    expect(b.admit(0, 0, 1, 5, 2)).toBe(true);
    expect(b.admit(0, 0, 1, 5, 2)).toBe(false);
  });
});

describe('gaitStepIndex', () => {
  it('splits a gait cycle into footfalls and tolerates garbage', () => {
    const TAU = Math.PI * 2;
    expect(gaitStepIndex(0, 2)).toBe(0);
    expect(gaitStepIndex(TAU * 0.49, 2)).toBe(0);
    expect(gaitStepIndex(TAU * 0.51, 2)).toBe(1);
    expect(gaitStepIndex(TAU * 1.25, 4)).toBe(1);
    expect(gaitStepIndex(-TAU * 0.25, 4)).toBe(3);
    expect(gaitStepIndex(Number.NaN, 2)).toBe(0);
    expect(gaitStepIndex(1, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

class FakeAudio implements AudioBridgeTarget {
  readonly plays: { id: string; opts: PlayOptions }[] = [];
  play(id: string, opts?: PlayOptions): void {
    this.plays.push({ id, opts: { ...opts, position: opts?.position ? { ...opts.position } : undefined } });
  }
  startLoop(_id: string, _opts?: LoopOptions): number {
    return 1;
  }
  stopLoop(): void {}
  ids(): string[] {
    return this.plays.map((p) => p.id);
  }
  clear(): void {
    this.plays.length = 0;
  }
}

function view(
  id: number,
  type: string,
  x: number,
  z: number,
): EnemyAudioView & {
  alive: boolean;
  position: { x: number; y: number; z: number };
  pose: { phase: number; locomotion: number };
} {
  return { id, type, alive: true, position: { x, y: 0, z }, pose: { phase: 0, locomotion: 0 } };
}

function setup() {
  const events = new EventBus<GameEvents>();
  const audio = new FakeAudio();
  let now = 100;
  let rnd = 0.5;
  const bridge = new AudioEventBridge(
    events,
    audio,
    () => now,
    () => rnd,
  );
  const enemies: ReturnType<typeof view>[] = [];
  bridge.setEnemySource({ enemies });
  const at = (x: number, z: number): Vec3Like => ({ x, y: 0, z });
  return {
    events,
    audio,
    bridge,
    enemies,
    at,
    advance: (s: number) => {
      now += s;
    },
    setRandom: (r: number) => {
      rnd = r;
    },
  };
}

function spawned(events: EventBus<GameEvents>, id: number, type: string, x: number, z: number): void {
  events.emit('enemy:spawned', { id, type, position: { x, y: 0, z }, elite: false });
}

describe('AudioEventBridge – enemies', () => {
  it('plays enemy sounds positionally, one rift tear per burst', () => {
    const { events, audio, advance } = setup();
    spawned(events, 1, 'swarmer', 10, 0);
    spawned(events, 2, 'swarmer', 11, 0.5); // same burst: merged
    expect(audio.ids()).toEqual([ENEMIES.swarmer.audio.spawn]);
    const p = audio.plays[0]!.opts;
    expect(p.position).toEqual({ x: 10, y: 0, z: 0 });
    expect(p.volume).toBeCloseTo(E.kinds.spawn.gain);
    expect(p.bus).toBe('sfx');
    spawned(events, 3, 'tank', 40, 0); // another rift
    advance(E.spawnMerge.seconds + 0.01);
    spawned(events, 4, 'swarmer', 10, 0); // same rift, next burst
    expect(audio.ids()).toEqual([
      ENEMIES.swarmer.audio.spawn,
      ENEMIES.tank.audio.spawn,
      ENEMIES.swarmer.audio.spawn,
    ]);
    // A long burst stays one tear (the window slides with its members) ...
    audio.clear();
    for (let i = 0; i < 6; i++) {
      advance(E.spawnMerge.seconds * 0.6);
      spawned(events, 10 + i, 'swarmer', 10, 0.3 * i);
    }
    expect(audio.plays.length).toBe(0);
    // ... but the tank emerging from the same rift gets its own, larger tear.
    spawned(events, 20, 'tank', 10.5, 0);
    expect(audio.ids()).toEqual([ENEMIES.tank.audio.spawn]);
  });

  it('keeps a voice budget per type and lets the nearest be heard', () => {
    const { events, audio, bridge } = setup();
    bridge.update(0, { x: 0, y: 0, z: 0 });
    const voices = E.budgets.swarmer!.voices;
    // Far ones first, then nearer ones: the nearer ones take over the busy voices.
    for (let i = 0; i < voices; i++)
      events.emit('enemy:alert', { id: i, type: 'swarmer', position: { x: 40 + i, y: 0, z: 0 } });
    expect(audio.plays.length).toBe(voices);
    audio.clear();
    events.emit('enemy:alert', { id: 99, type: 'swarmer', position: { x: 45, y: 0, z: 0 } });
    expect(audio.plays.length).toBe(0); // farther than every busy voice
    for (let i = 0; i < voices; i++)
      events.emit('enemy:alert', { id: 50 + i, type: 'swarmer', position: { x: 5 + i, y: 0, z: 0 } });
    expect(audio.plays.length).toBe(voices);
    // Other types have their own budget.
    events.emit('enemy:alert', { id: 200, type: 'tank', position: { x: 30, y: 0, z: 0 } });
    expect(audio.ids()).toContain(ENEMIES.tank.audio.alert);
    // Beyond the audible distance nothing plays.
    audio.clear();
    events.emit('enemy:alert', {
      id: 201,
      type: 'spitter',
      position: { x: E.kinds.alert.maxDistance + 1, y: 0, z: 0 },
    });
    expect(audio.plays.length).toBe(0);
  });

  it('plays the wind-up at once and the blow when the wind-up ends, where the attacker is then', () => {
    const { events, audio, bridge, enemies } = setup();
    const tank = view(7, 'tank', 10, 0);
    enemies.push(tank);
    spawned(events, 7, 'tank', 10, 0);
    audio.clear();
    const slam = getEnemyAttackDef('tank', 'slam')!;
    events.emit('enemy:attack', {
      id: 7,
      type: 'tank',
      attack: 'slam',
      position: { x: 10, y: 0, z: 0 },
      windup: slam.windup,
    });
    expect(audio.ids()).toEqual([slam.sound]);
    tank.position.x = 12;
    bridge.update(slam.windup * 0.5);
    expect(audio.plays.length).toBe(1);
    bridge.update(slam.windup * 0.6);
    expect(audio.ids()).toEqual([slam.sound, E.strikes.tank!.slam]);
    expect(audio.plays[1]!.opts.position).toEqual({ x: 12, y: 0, z: 0 });
    expect(audio.plays[1]!.opts.volume).toBeCloseTo(E.kinds.strike.gain);
  });

  it('drops the blows still pending when a new run starts (main menu → start emits no run:restart)', () => {
    const { events, audio, bridge } = setup();
    const slam = getEnemyAttackDef('tank', 'slam')!;
    // A wind-up still running when the death sequence froze the game (enemies cleared silently).
    events.emit('enemy:attack', {
      id: 9,
      type: 'tank',
      attack: 'slam',
      position: { x: 6, y: 0, z: 0 },
      windup: slam.windup,
    });
    bridge.update(slam.windup * 0.2);
    audio.clear();
    bridge.resetRun();
    bridge.update(slam.windup * 2);
    expect(audio.plays.length).toBe(0);
    // run:restart does the same.
    events.emit('enemy:attack', {
      id: 10,
      type: 'tank',
      attack: 'slam',
      position: { x: 6, y: 0, z: 0 },
      windup: slam.windup,
    });
    audio.clear();
    events.emit('run:restart', {});
    bridge.update(slam.windup * 2);
    expect(audio.plays.length).toBe(0);
  });

  it('cancels the blow when the attacker is staggered or dies during the wind-up', () => {
    const { events, audio, bridge } = setup();
    const bite = getEnemyAttackDef('swarmer', 'bite')!;
    events.emit('enemy:attack', {
      id: 3,
      type: 'swarmer',
      attack: 'bite',
      position: { x: 2, y: 0, z: 0 },
      windup: bite.windup,
    });
    events.emit('enemy:staggered', { id: 3, type: 'swarmer', position: { x: 2, y: 0, z: 0 } });
    events.emit('enemy:attack', {
      id: 4,
      type: 'swarmer',
      attack: 'bite',
      position: { x: 3, y: 0, z: 0 },
      windup: bite.windup,
    });
    events.emit('enemy:died', {
      id: 4,
      type: 'swarmer',
      position: { x: 3, y: 0, z: 0 },
      weaponId: 'rifle',
      zone: 'body',
      elite: false,
      source: 'player',
    });
    bridge.update(bite.windup + 0.1);
    const ids = audio.ids();
    expect(ids).not.toContain(E.strikes.swarmer!.bite);
    expect(ids).toContain(ENEMIES.swarmer.audio.hurt); // the stagger
    expect(ids).toContain(ENEMIES.swarmer.audio.death);
  });

  it('plays hurt sounds for hits on enemies (not for kills or other targets)', () => {
    const { events, audio } = setup();
    spawned(events, 5, 'spitter', 3, 0);
    audio.clear();
    const hit = (targetId: number, killed: boolean): void =>
      events.emit('combat:damage', {
        targetId,
        amount: 20,
        zone: 'body',
        point: { x: 3, y: 1, z: 0 },
        killed,
        weaponId: 'rifle',
        element: 'physical',
        source: 'player',
      });
    hit(5, false);
    hit(5, true);
    hit(1_000_001, false); // a training dummy
    // (The player's own hit also ticks the hitmarker on the ui bus.)
    const enemySounds = audio.plays.filter((p) => p.id.startsWith('enemy.'));
    expect(enemySounds.map((p) => p.id)).toEqual([ENEMIES.spitter.audio.hurt]);
    expect(enemySounds[0]!.opts.position).toEqual({ x: 3, y: 1, z: 0 });
  });

  it('merges the hits of one blast on one enemy into one hurt sound', () => {
    const { events, audio, advance } = setup();
    spawned(events, 5, 'swarmer', 3, 0);
    spawned(events, 6, 'swarmer', 4, 0);
    const pellet = (targetId: number): void =>
      events.emit('combat:damage', {
        targetId,
        amount: 8,
        zone: 'body',
        point: { x: 3, y: 0.4, z: 0 },
        killed: false,
        weaponId: 'shotgun',
        element: 'physical',
        source: 'player',
      });
    const hurts = (): number => audio.ids().filter((id) => id === ENEMIES.swarmer.audio.hurt).length;
    audio.clear();
    // Nine pellets over two enemies in one tick: one hurt each.
    for (let i = 0; i < 9; i++) pellet(i % 3 === 0 ? 6 : 5);
    expect(hurts()).toBe(2);
    // A stagger right after the hit still sounds (the bigger reaction), later pellets merge into it.
    events.emit('enemy:staggered', { id: 5, type: 'swarmer', position: { x: 3, y: 0, z: 0 } });
    pellet(5);
    expect(hurts()).toBe(3);
    // The next blast reacts again.
    advance(E.hurtMerge.seconds + 0.01);
    pellet(5);
    expect(hurts()).toBe(4);
  });

  it('replaces the surface impact of an acid glob with the splash', () => {
    const { events, audio } = setup();
    const glob = PROJECTILES['acid.glob'];
    events.emit('combat:impact', {
      point: { x: 1, y: 0, z: 1 },
      normal: { x: 0, y: 1, z: 0 },
      surface: glob.impactSurface,
      kind: 'projectile',
      weaponId: glob.weaponId,
      decal: true,
    });
    expect(audio.ids()).toEqual([E.projectileImpacts[glob.weaponId]]);
  });

  it('polls footsteps from the gait phase and idle vocals on their interval', () => {
    const { audio, bridge, enemies, setRandom } = setup();
    setRandom(0);
    const tank = view(9, 'tank', 5, 0);
    const lazy = view(10, 'swarmer', 6, 0);
    enemies.push(tank, lazy);
    bridge.update(1 / 60, { x: 0, y: 0, z: 0 }); // first sight: no step, idle due at once (random 0)
    audio.clear();
    const TAU = Math.PI * 2;
    tank.pose.locomotion = 1;
    lazy.pose.locomotion = 0; // standing: no footsteps
    for (let i = 1; i <= 8; i++) {
      tank.pose.phase = ((i / 8) * TAU) % TAU;
      lazy.pose.phase = ((i / 8) * TAU) % TAU;
      bridge.update(1 / 60);
    }
    const steps = audio.plays.filter((p) => p.id === ENEMIES.tank.audio.step);
    expect(steps.length).toBe(E.budgets.tank!.stepsPerCycle);
    expect(steps[0]!.opts.volume).toBeCloseTo(E.kinds.step.gain * E.budgets.tank!.stepGain);
    expect(audio.ids()).not.toContain(ENEMIES.swarmer.audio.step);
    // Idle vocals come back within the def's interval (game time).
    audio.clear();
    setRandom(1);
    const [, hi] = ENEMIES.swarmer.audio.idleInterval;
    for (let t = 0; t < hi + 0.5; t += 0.1) bridge.update(0.1);
    expect(audio.ids()).toContain(ENEMIES.swarmer.audio.idle);
    expect(audio.ids()).toContain(ENEMIES.tank.audio.idle);
  });

  it('forgets enemies cleared without death events and on run:restart', () => {
    const { events, audio, bridge, enemies } = setup();
    for (let i = 0; i < 5; i++) enemies.push(view(i + 1, 'swarmer', i, 0));
    bridge.update(1 / 60, { x: 0, y: 0, z: 0 });
    enemies.length = 0; // EnemyManager.clear()
    bridge.update(1 / 60);
    const slam = getEnemyAttackDef('tank', 'slam')!;
    events.emit('enemy:attack', {
      id: 7,
      type: 'tank',
      attack: 'slam',
      position: { x: 1, y: 0, z: 0 },
      windup: slam.windup,
    });
    events.emit('run:restart', {});
    audio.clear();
    bridge.update(slam.windup + 1);
    expect(audio.plays.length).toBe(0);
  });

  it('plays the wave stings on the music bus and the game over sting on the ui bus', () => {
    const { events, audio } = setup();
    events.emit('wave:start', { wave: 1, total: 8, kind: 'normal' });
    events.emit('wave:start', { wave: 5, total: 24, kind: 'tank' });
    events.emit('wave:complete', { wave: 5, duration: 50 });
    events.emit('player:died', { position: { x: 0, y: 0, z: 0 } });
    expect(audio.ids()).toEqual([ST.waveStart.id, ST.waveStart.id, ST.waveComplete.id, ST.gameOver.id]);
    expect(audio.plays[0]!.opts).toMatchObject({ bus: 'music', pitch: 1, volume: ST.waveStart.gain });
    expect(audio.plays[1]!.opts.pitch).toBeCloseTo(ST.waveStart.specialPitch);
    expect(audio.plays[2]!.opts.bus).toBe('music');
    expect(audio.plays[3]!.opts).toMatchObject({ bus: 'ui', volume: ST.gameOver.gain });
    for (const p of audio.plays) expect(p.opts.position).toBeUndefined();
  });

  it('opens and closes the game over screen without menu clicks', () => {
    const { events, audio } = setup();
    events.emit('ui:menu', { open: true, menu: 'gameover' });
    events.emit('ui:menu', { open: false, menu: 'gameover' });
    expect(audio.plays.length).toBe(0);
    events.emit('ui:menu', { open: true, menu: 'pause' });
    expect(audio.ids()).toEqual(['ui.click']);
  });
});
