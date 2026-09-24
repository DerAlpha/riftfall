import { describe, expect, it } from 'vitest';
import type { PlayOptions } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { Rng } from '../core/Rng';
import { AUDIO } from '../defs/audio';
import { PERK_IDS } from '../defs/perks';
import { POWERUP_IDS, POWERUPS } from '../defs/powerups';
import type { LoopOptions } from './AudioEngine';
import { AudioEventBridge, type AudioBridgeTarget } from './AudioEventBridge';
import {
  doorSoundId,
  perkJingleId,
  pickupLifetime,
  pickupLoopSeconds,
  pointsTickPitch,
  powerUpStingerId,
} from './economyAudio';
import { ECONOMY_SYNTH_DEFS, boxNoteInterval, composeJingle, midiHz } from './economySynth';
import { ENEMY_SYNTH_DEFS } from './enemySynth';
import { SYNTH_DEFS, resolveSynthId, type SynthGraph } from './synth';
import { WEAPON_SYNTH_DEFS } from './weaponSynth';

const EA = AUDIO.economy;
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

describe('economy sound ids', () => {
  it('resolves every id AUDIO.economy and the mapping helpers can produce', () => {
    const ids = [
      EA.purchase.id,
      EA.denied.id,
      EA.pointsTick.id,
      EA.focus.id,
      EA.door.id,
      EA.door.blastId,
      EA.box.open,
      EA.box.roll,
      EA.box.resolve,
      EA.box.anomaly,
      EA.box.arrive,
      EA.perks.acquire.id,
      EA.perks.lost.id,
      EA.perks.revive.id,
      EA.perks.hum.id,
      EA.powerUps.spawn.id,
      EA.powerUps.loop.id,
      EA.powerUps.defaultStinger,
      EA.powerUps.tick.id,
      EA.powerUps.expire.id,
      EA.seals.break,
      EA.seals.repair,
      EA.zone.id,
      ...Object.values(EA.powerUps.stingers),
      ...PERK_IDS.map(perkJingleId),
      ...POWERUP_IDS.map(powerUpStingerId),
    ];
    for (const id of ids) expect(resolveSynthId(id), id).toBe(id);
  });

  it('maps every power-up type to its own stinger, every perk to its own jingle', () => {
    const stingers = POWERUP_IDS.map(powerUpStingerId);
    expect(new Set(stingers).size).toBe(POWERUP_IDS.length);
    expect(powerUpStingerId('unknown')).toBe(EA.powerUps.defaultStinger);
    expect(new Set(PERK_IDS.map(perkJingleId)).size).toBe(16);
    expect(doorSoundId(false)).toBe(EA.door.id);
    expect(doorSoundId(true)).toBe(EA.door.blastId);
  });

  it('is merged into the bank without colliding with the weapon / enemy sounds', () => {
    for (const id of Object.keys(ECONOMY_SYNTH_DEFS)) {
      expect(has(WEAPON_SYNTH_DEFS, id), id).toBe(false);
      expect(has(ENEMY_SYNTH_DEFS, id), id).toBe(false);
      expect((SYNTH_DEFS as Record<string, unknown>)[id]).toBe(
        (ECONOMY_SYNTH_DEFS as Record<string, unknown>)[id],
      );
    }
  });

  it('renders positional sounds mono, 2D stings stereo, and the hum / shimmer as loops', () => {
    const positional = /^(door|box|seal)\.|^perk\.(hum|jingle)|^powerup\.(spawn|loop)$/;
    for (const [id, def] of Object.entries(ECONOMY_SYNTH_DEFS)) {
      if (positional.test(id)) expect(def.channels, id).toBe(1);
      expect(def.level, id).toBeGreaterThan(0);
      expect(def.level, id).toBeLessThanOrEqual(1);
    }
    for (const id of ['perk.acquire', 'perk.revive', 'zone.unlock', ...Object.values(EA.powerUps.stingers)]) {
      expect((ECONOMY_SYNTH_DEFS as Record<string, { channels: number }>)[id]!.channels, id).toBe(2);
    }
    expect(ECONOMY_SYNTH_DEFS['perk.hum']).toMatchObject({ loop: true });
    expect(ECONOMY_SYNTH_DEFS['powerup.loop']).toMatchObject({ loop: true });
  });

  it('pitches the points tick a little higher for bigger earnings', () => {
    expect(pointsTickPitch(10)).toBe(1);
    expect(pointsTickPitch(100)).toBeGreaterThan(1);
    expect(pointsTickPitch(1e9)).toBeCloseTo(1 + 2 * EA.pointsTick.pitchPerDecade);
    expect(pickupLoopSeconds('ammoScrap')).toBeLessThan(pickupLoopSeconds('nuke'));
    expect(pickupLoopSeconds('nuke')).toBeGreaterThanOrEqual(POWERUPS.pickup.lifetime);
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
  ) {
    super(log);
  }
  start(t: number): void {
    if (!Number.isFinite(t) || t < 0) this.log.push(`start(${t})`);
    this.starts.push(t);
  }
  stop(t: number): void {
    if (!Number.isFinite(t)) this.log.push(`stop(${t})`);
  }
}

class FakeOfflineContext {
  readonly sampleRate = 48000;
  readonly errors: string[] = [];
  readonly starts: number[] = [];
  readonly params: FakeParam[] = [];
  readonly destination: FakeNode & { channelCount: number };
  constructor(channels: number) {
    this.destination = Object.assign(new FakeNode(this.errors), { channelCount: channels });
  }
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
    return Object.assign(new FakeSource(this.errors, this.starts), { type: 'sine', frequency: this.param() });
  }
  createBufferSource() {
    return Object.assign(new FakeSource(this.errors, this.starts), {
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

describe('economy synth recipes', () => {
  it('schedule valid Web Audio graphs that start inside the rendered duration', () => {
    for (const [id, def] of Object.entries(ECONOMY_SYNTH_DEFS)) {
      for (let v = 0; v < def.variants; v++) {
        const ctx = new FakeOfflineContext(def.channels);
        def.recipe({ ctx, rng: new Rng(`test:${id}:${v}`) } as unknown as SynthGraph, 0);
        expect(ctx.errors, id).toEqual([]);
        expect(ctx.starts.length, id).toBeGreaterThan(0);
        for (const t of ctx.starts) expect(t, id).toBeLessThan(def.duration);
        for (const p of ctx.params) expect(Number.isFinite(p.value), id).toBe(true);
      }
    }
  });

  it('composes one deterministic jingle per perk that fits its render and resolves on the root', () => {
    const melodies = new Set<string>();
    for (const id of PERK_IDS) {
      const a = composeJingle(id);
      expect(composeJingle(id)).toEqual(a);
      expect(a.notes.length).toBeGreaterThanOrEqual(6);
      const last = a.notes[a.notes.length - 1]!;
      expect(last.semis).toBe(12);
      expect(a.length).toBeLessThan(ECONOMY_SYNTH_DEFS[`perk.jingle.${id}`].duration);
      melodies.add(`${a.mode}:${a.root}:${a.timbre}:${a.notes.map((n) => n.semis).join(',')}`);
    }
    expect(melodies.size).toBe(PERK_IDS.length);
  });

  it('winds the music box down over the roll', () => {
    expect(boxNoteInterval(0.5)).toBeLessThan(boxNoteInterval(1));
    expect(boxNoteInterval(0)).toBeGreaterThan(boxNoteInterval(0.3));
    expect(midiHz(69)).toBeCloseTo(440);
    expect(midiHz(81)).toBeCloseTo(880);
  });

  it('uses whole cycles per loop for the tonal hum / shimmer layers (seamless loop point)', () => {
    for (const hz of [50, 100, 150, 5]) expect((hz * EA.synth.humLoopSeconds) % 1).toBeCloseTo(0, 6);
    for (const hz of [880, 882.5, 1320]) expect((hz * EA.synth.shimmerLoopSeconds) % 1).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

interface Played {
  id: string;
  opts: PlayOptions;
}

class FakeAudio implements AudioBridgeTarget {
  readonly plays: Played[] = [];
  readonly loops = new Map<number, { id: string; opts: LoopOptions }>();
  readonly stopped: { handle: number; fade: number | undefined }[] = [];
  unlocked = true;
  private next = 1;
  play(id: string, opts?: PlayOptions): void {
    this.plays.push({ id, opts: { ...opts, position: opts?.position ? { ...opts.position } : undefined } });
  }
  startLoop(id: string, opts?: LoopOptions): number {
    if (!this.unlocked) return 0;
    const h = this.next++;
    this.loops.set(h, { id, opts: { ...opts, position: opts?.position ? { ...opts.position } : undefined } });
    return h;
  }
  stopLoop(handle: number, fadeSeconds?: number): void {
    this.stopped.push({ handle, fade: fadeSeconds });
    this.loops.delete(handle);
  }
  ids(): string[] {
    return this.plays.map((p) => p.id);
  }
  find(id: string): Played | undefined {
    return this.plays.find((p) => p.id === id);
  }
  loopIds(): string[] {
    return [...this.loops.values()].map((l) => l.id);
  }
  /** Handles of the running pickup loops (without the machine hums). */
  pickupLoops(): number[] {
    return [...this.loops.entries()].filter(([, l]) => l.id === EA.powerUps.loop.id).map(([h]) => h);
  }
  clear(): void {
    this.plays.length = 0;
  }
}

function setup() {
  const events = new EventBus<GameEvents>();
  const audio = new FakeAudio();
  let now = 100;
  const bridge = new AudioEventBridge(
    events,
    audio,
    () => now,
    () => 0.5,
  );
  const listener = { x: 0, y: 1.6, z: 0 };
  const timed = { active: [] as string[], left: new Map<string, number>() };
  const box = { location: { position: { x: 20, y: 0, z: -4 } } };
  bridge.setEconomySources({
    doors: [
      { id: 'door_a', position: { x: 5, y: 0, z: 0 }, blast: false },
      { id: 'gate', position: { x: -8, y: 0, z: 3 }, blast: true },
    ],
    perkMachines: [
      { perkId: 'titan', position: { x: 3, y: 0, z: 0 } },
      { perkId: 'quickload', position: { x: 4, y: 0, z: 1 } },
      { perkId: 'phoenix', position: { x: 5, y: 0, z: -1 } },
      { perkId: 'nova', position: { x: 60, y: 0, z: 0 } },
    ],
    box,
    powerUps: {
      get activeTimed() {
        return timed.active;
      },
      remaining: (t: string) => timed.left.get(t) ?? 0,
    },
  });
  const frame = (dt = 1 / 60): void => bridge.update(dt, listener);
  return {
    events,
    audio,
    bridge,
    listener,
    timed,
    box,
    frame,
    advance: (s: number) => {
      now += s;
    },
  };
}

const at = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });

describe('AudioEventBridge – economy', () => {
  it('ticks earnings subtly on the ui bus (rate limited), never for dev grants or spending', () => {
    const { events, audio, advance } = setup();
    events.emit('economy:points', { delta: 0, total: 500, reason: 'dev' });
    events.emit('economy:points', { delta: 500, total: 1000, reason: 'dev' });
    events.emit('economy:points', { delta: -950, total: 50, reason: 'purchase' });
    expect(audio.ids()).toEqual([]);
    events.emit('economy:points', { delta: 60, total: 110, reason: 'kill' });
    events.emit('economy:points', { delta: 10, total: 120, reason: 'hit' });
    expect(audio.ids()).toEqual([EA.pointsTick.id]);
    expect(audio.plays[0]!.opts.bus).toBe('ui');
    advance(EA.pointsTick.minInterval + 0.01);
    events.emit('economy:points', { delta: 10, total: 130, reason: 'repair' });
    expect(audio.ids()).toEqual([EA.pointsTick.id, EA.pointsTick.id]);
  });

  it('plays the ka-ching for purchases and a rate-limited buzzer for refusals', () => {
    const { events, audio, advance } = setup();
    events.emit('economy:purchase', { item: 'door_a', kind: 'door', cost: 750, ok: true });
    events.emit('economy:purchase', { item: 'door_a', kind: 'door', cost: 750, ok: false });
    events.emit('economy:purchase', { item: 'door_a', kind: 'door', cost: 750, ok: false });
    expect(audio.ids()).toEqual([EA.purchase.id, EA.denied.id]);
    advance(EA.denied.minInterval + 0.01);
    events.emit('economy:purchase', { item: 'door_a', kind: 'door', cost: 750, ok: false });
    expect(audio.ids().filter((i) => i === EA.denied.id)).toHaveLength(2);
    for (const p of audio.plays) expect(p.opts.bus).toBe('ui');
  });

  it('blips once per new focus', () => {
    const { events, audio, advance } = setup();
    events.emit('interact:focus', { id: 'door_a:0', prompt: 'Tür öffnen', cost: 750, affordable: true });
    events.emit('interact:focus', { id: 'door_a:0', prompt: 'Tür öffnen', cost: 750, affordable: false });
    advance(1);
    events.emit('interact:focus', { id: null, prompt: null, cost: null, affordable: true });
    events.emit('interact:focus', { id: 'box', prompt: 'Rift-Kiste öffnen', cost: 950, affordable: true });
    expect(audio.ids()).toEqual([EA.focus.id, EA.focus.id]);
  });

  it('opens doors at the door (blast doors heavier) and swells once per unlocked area', () => {
    const { events, audio } = setup();
    events.emit('door:opened', { doorId: 'door_a', zones: ['reception', 'atrium'] });
    events.emit('zone:activated', { zone: 'atrium' });
    events.emit('zone:activated', { zone: 'reception' });
    events.emit('door:opened', { doorId: 'gate', zones: ['atrium', 'dock'] });
    expect(audio.ids()).toEqual([EA.door.id, EA.zone.id, EA.door.blastId]);
    expect(audio.find(EA.door.id)!.opts.position).toEqual(at(5, 0, 0));
    expect(audio.find(EA.door.blastId)!.opts.position).toEqual(at(-8, 0, 3));
    expect(audio.find(EA.zone.id)!.opts.bus).toBe('music');
  });

  it('plays the box at the box: open + music box, resolve / anomaly, arrival at the new place', () => {
    const { events, audio, box } = setup();
    const p = at(1, 0, 2);
    events.emit('box:opened', { boxId: 'rift_box', position: p });
    p.x = 99; // reused payload
    events.emit('box:resolved', { boxId: 'rift_box', weaponId: null });
    expect(audio.ids()).toEqual([EA.box.open, EA.box.roll, EA.box.anomaly]);
    for (const s of audio.plays) expect(s.opts.position).toEqual(at(1, 0, 2));
    events.emit('box:moved', { boxId: 'rift_box', from: 'a', to: 'b' });
    expect(audio.find(EA.box.arrive)!.opts.position).toEqual(box.location.position);
    audio.clear();
    events.emit('box:resolved', { boxId: 'rift_box', weaponId: 'kr7' });
    expect(audio.find(EA.box.resolve)!.opts.position).toEqual(box.location.position);
  });

  it('hums only at the nearest machines, with hysteresis, and follows the listener', () => {
    const { audio, listener, frame } = setup();
    listener.x = 30;
    frame(EA.perks.hum.checkInterval);
    expect(audio.loopIds()).toEqual([]);
    listener.x = 1;
    frame(EA.perks.hum.checkInterval);
    // Three machines within reach, two voices: the nearest two (titan at 2 m, quickload at 3.2 m).
    expect(audio.loopIds()).toEqual([EA.perks.hum.id, EA.perks.hum.id]);
    const positions = [...audio.loops.values()].map((l) => l.opts.position);
    expect(positions).toContainEqual(at(3, 0, 0));
    expect(positions).toContainEqual(at(4, 0, 1));
    // Between start and stop distance: keeps humming.
    listener.x = 3 - (EA.perks.hum.startDistance + EA.perks.hum.stopDistance) / 2;
    frame(EA.perks.hum.checkInterval);
    expect(audio.loops.size).toBeGreaterThan(0);
    listener.x = -40;
    frame(EA.perks.hum.checkInterval);
    expect(audio.loops.size).toBe(0);
  });

  it('retries a hum the locked engine could not start yet', () => {
    const { audio, listener, frame } = setup();
    audio.unlocked = false;
    listener.x = 1;
    frame(EA.perks.hum.checkInterval);
    expect(audio.loops.size).toBe(0);
    audio.unlocked = true;
    frame(EA.perks.hum.checkInterval);
    expect(audio.loops.size).toBe(2);
  });

  it('stings a perk purchase and plays its jingle from its machine a moment later', () => {
    const { events, audio, frame, listener } = setup();
    listener.x = 30;
    events.emit('perk:acquired', { perkId: 'titan', slot: 0 });
    expect(audio.ids()).toEqual([EA.perks.acquire.id]);
    expect(audio.plays[0]!.opts.position).toBeUndefined();
    frame(EA.perks.jingleDelay * 0.5);
    expect(audio.find('perk.jingle.titan')).toBeUndefined();
    frame(EA.perks.jingleDelay * 0.6);
    expect(audio.find('perk.jingle.titan')!.opts.position).toEqual(at(3, 0, 0));
    // A perk without a machine (dev grant): the jingle plays 2D.
    events.emit('perk:acquired', { perkId: 'bulwark', slot: 1 });
    frame(EA.perks.jingleDelay + 0.01);
    expect(audio.find('perk.jingle.bulwark')!.opts.position).toBeUndefined();
  });

  it('plays the revive, keeps the consumed implant silent, and mutes losses while dead', () => {
    const { events, audio, advance } = setup();
    events.emit('player:revived', { health: 50, chargesLeft: 0, invulnerability: 3 });
    events.emit('perk:lost', { perkId: 'phoenix' });
    expect(audio.ids()).toEqual([EA.perks.revive.id]);
    advance(EA.perks.lost.afterReviveSeconds + 0.1);
    events.emit('perk:lost', { perkId: 'titan' });
    expect(audio.ids()).toEqual([EA.perks.revive.id, EA.perks.lost.id]);
    audio.clear();
    events.emit('player:died', { position: at(0, 0, 0) });
    events.emit('perk:lost', { perkId: 'quickload' });
    events.emit('powerup:expired', { type: 'instakill' });
    expect(audio.ids()).toEqual([AUDIO.stings.gameOver.id]);
    audio.clear();
    // The new run's health reset ends the silence.
    events.emit('player:healthChanged', { health: 100, maxHealth: 100, armor: 0, maxArmor: 100 });
    events.emit('powerup:expired', { type: 'instakill' });
    expect(audio.ids()).toEqual([EA.powerUps.expire.id]);
  });

  it('shimmers pickups while they float and stings the collection per type', () => {
    const { events, audio, bridge } = setup();
    const pos = at(2, 0, 3);
    events.emit('powerup:spawned', { id: 1, type: 'nuke', position: pos });
    events.emit('powerup:spawned', { id: 2, type: 'maxAmmo', position: at(6, 0, 3) });
    expect(audio.ids()).toEqual([EA.powerUps.spawn.id, EA.powerUps.spawn.id]);
    expect(audio.find(EA.powerUps.spawn.id)!.opts.position).toEqual(pos);
    expect(audio.loopIds()).toEqual([EA.powerUps.loop.id, EA.powerUps.loop.id]);
    const first = [...audio.loops.values()][0]!;
    expect(first.opts.position).toEqual(pos);
    expect(first.opts.maxDuration).toBeCloseTo(pickupLoopSeconds('nuke'));
    events.emit('powerup:collected', { type: 'nuke', position: at(2, 0, 3), duration: 0 });
    expect(audio.loops.size).toBe(1);
    expect(audio.ids()).toContain('powerup.nuke');
    expect(audio.plays[audio.plays.length - 1]!.opts.position).toBeUndefined();
    expect(bridge.economy.activePickupLoops).toBe(1);
    // A new run stops the rest.
    events.emit('run:restart', {});
    expect(audio.loops.size).toBe(0);
  });

  it('never tracks more pickup loops than pickups can exist', () => {
    const { events, audio, bridge } = setup();
    expect(EA.powerUps.maxLoops).toBe(POWERUPS.capacity);
    for (let i = 0; i < EA.powerUps.maxLoops + 3; i++) {
      events.emit('powerup:spawned', { id: i, type: 'doublePoints', position: at(i, 0, 0) });
    }
    expect(bridge.economy.activePickupLoops).toBe(EA.powerUps.maxLoops);
    expect(audio.loops.size).toBe(EA.powerUps.maxLoops);
  });

  it('fades a pickup loop out when its pickup despawns (game time) instead of a hard cut', () => {
    const { events, audio, bridge, frame } = setup();
    events.emit('powerup:spawned', { id: 1, type: 'ammoScrap', position: at(1, 0, 0) });
    events.emit('powerup:spawned', { id: 2, type: 'nuke', position: at(2, 0, 0) });
    const [scrap, nuke] = [...audio.loops.keys()];
    // The engine's maxDuration is only a late safety net (it stops without a fade).
    expect(audio.loops.get(scrap!)!.opts.maxDuration).toBeGreaterThan(pickupLifetime('ammoScrap'));
    frame(pickupLifetime('ammoScrap') - 0.05);
    expect(audio.pickupLoops()).toEqual([scrap, nuke]);
    frame(0.1);
    expect(audio.pickupLoops()).toEqual([nuke]);
    expect(audio.stopped).toEqual([{ handle: scrap, fade: EA.powerUps.loop.fadeOut }]);
    expect(bridge.economy.activePickupLoops).toBe(1);
    frame(pickupLifetime('nuke'));
    expect(audio.pickupLoops()).toEqual([]);
  });

  it('ends a pickup loop when the power-up system says its pickup is gone (no event for that)', () => {
    const { events, audio, bridge, frame } = setup();
    const floating = new Set<number>([1, 2]);
    bridge.setEconomySources({
      powerUps: { activeTimed: [], remaining: () => 0, hasPickup: (id) => floating.has(id) },
    });
    events.emit('powerup:spawned', { id: 1, type: 'nuke', position: at(1, 0, 0) });
    events.emit('powerup:spawned', { id: 2, type: 'maxAmmo', position: at(2, 0, 0) });
    const [first, second] = audio.pickupLoops();
    frame();
    expect(audio.pickupLoops()).toEqual([first, second]);
    // Despawned early by the fixed ticks' clock (the frame time ran ahead): asked, not guessed.
    floating.delete(2);
    frame();
    expect(audio.pickupLoops()).toEqual([first]);
    expect(audio.stopped).toEqual([{ handle: second, fade: EA.powerUps.loop.fadeOut }]);
    // Still floating beyond the lifetime by the frame clock (dropped ticks): the loop stays.
    frame(pickupLifetime('nuke') + 1);
    expect(audio.pickupLoops()).toEqual([first]);
    // A full pool replaced pickup 1 for pickup 3: its loop makes room.
    floating.delete(1);
    floating.add(3);
    events.emit('powerup:spawned', { id: 3, type: 'instakill', position: at(3, 0, 0) });
    expect(audio.stopped.map((s) => s.handle)).toEqual([second, first]);
    expect(audio.pickupLoops()).toHaveLength(1);
  });

  it('replaces the loop of the pickup the power-up system replaces in a full pool (scraps first)', () => {
    const { events, audio, frame } = setup();
    events.emit('powerup:spawned', { id: 1, type: 'nuke', position: at(0, 0, 0) });
    frame(12);
    for (let i = 2; i < POWERUPS.capacity; i++) {
      events.emit('powerup:spawned', { id: i, type: 'maxAmmo', position: at(i, 0, 0) });
    }
    // Despawns after the first nuke, but a scrap goes before any real drop.
    events.emit('powerup:spawned', { id: 99, type: 'ammoScrap', position: at(9, 0, 9) });
    expect(audio.pickupLoops().length).toBe(POWERUPS.capacity);
    const scrap = [...audio.loops.entries()].find(([, l]) => l.opts.position?.z === 9)![0];
    events.emit('powerup:spawned', { id: 100, type: 'doublePoints', position: at(5, 0, 5) });
    expect(audio.stopped.map((s) => s.handle)).toEqual([scrap]);
    expect(audio.pickupLoops().length).toBe(POWERUPS.capacity);
  });

  it('ticks the last seconds of a timed power-up from its clock', () => {
    const { audio, timed, frame } = setup();
    timed.active.push('instakill');
    timed.left.set('instakill', 3.5);
    frame();
    expect(audio.ids()).toEqual([]);
    timed.left.set('instakill', 2.95);
    frame();
    timed.left.set('instakill', 2.5);
    frame();
    timed.left.set('instakill', 1.9);
    frame();
    timed.left.set('instakill', 0.4);
    frame();
    expect(audio.ids()).toEqual([EA.powerUps.tick.id, EA.powerUps.tick.id, EA.powerUps.tick.id]);
    const pitches = audio.plays.map((p) => p.opts.pitch!);
    expect(pitches[2]).toBeGreaterThan(pitches[0]!);
  });

  it('crackles and zaps at the seal bar, rate limited for the carpenter', () => {
    const { events, audio } = setup();
    for (let i = 0; i < 10; i++) {
      events.emit('seal:repaired', { sealId: `s${i}`, planks: 5, position: at(i, 1, 0) });
    }
    expect(audio.ids()).toEqual([EA.seals.repair, EA.seals.repair, EA.seals.repair]);
    expect(audio.plays[0]!.opts.position).toEqual(at(0, 1, 0));
    audio.clear();
    events.emit('seal:broken', { sealId: 's0', position: at(0, 1, 0) });
    expect(audio.ids()).toEqual([]);
  });

  it('stops its loops on dispose', () => {
    const { audio, bridge, listener, frame, events } = setup();
    listener.x = 1;
    frame(EA.perks.hum.checkInterval);
    events.emit('powerup:spawned', { id: 1, type: 'nuke', position: at(0, 0, 0) });
    expect(audio.loops.size).toBe(3);
    bridge.dispose();
    expect(audio.loops.size).toBe(0);
    events.emit('economy:purchase', { item: 'x', kind: 'door', cost: 1, ok: true });
    expect(audio.find(EA.purchase.id)).toBeUndefined();
  });
});
