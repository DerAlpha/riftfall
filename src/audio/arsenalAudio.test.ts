import { describe, expect, it } from 'vitest';
import type { PlayOptions } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { AUDIO } from '../defs/audio';
import { WEAPONS, getWeaponDef } from '../defs/weapons';
import type { LoopOptions, LoopUpdate } from './AudioEngine';
import { AudioEventBridge, fireLayerGain, type AudioBridgeTarget } from './AudioEventBridge';
import {
  PositionalLoopSet,
  chargePitch,
  dopplerPitch,
  fieldSoundId,
  roomTail,
  spinPitch,
  type PositionOut,
} from './arsenalAudio';
import { resolveSynthId } from './synth';

const AR = AUDIO.arsenal;
const W = AUDIO.weapons;

interface LoopRec {
  id: string;
  opts: LoopOptions;
  stopped: boolean;
  updates: LoopUpdate[];
}

class FakeAudio implements AudioBridgeTarget {
  readonly plays: { id: string; opts: PlayOptions }[] = [];
  readonly loops = new Map<number, LoopRec>();
  private next = 1;
  unlocked = true;
  activeReverbZone: 'small' | 'medium' | 'large' | 'hangar' | null = null;
  play(id: string, opts?: PlayOptions): void {
    this.plays.push({ id, opts: { ...opts, position: opts?.position ? { ...opts.position } : undefined } });
  }
  startLoop(id: string, opts?: LoopOptions): number {
    const h = this.next++;
    this.loops.set(h, {
      id,
      opts: { ...opts, position: opts?.position ? { ...opts.position } : undefined },
      stopped: false,
      updates: [],
    });
    return h;
  }
  stopLoop(handle: number): void {
    const l = this.loops.get(handle);
    if (l) l.stopped = true;
  }
  updateLoop(handle: number, u: LoopUpdate): boolean {
    const l = this.loops.get(handle);
    if (!l || l.stopped) return false;
    l.updates.push({ ...u, position: u.position ? { ...u.position } : undefined });
    return true;
  }
  has(id: string): boolean {
    return resolveSynthId(id) !== null;
  }
  ids(): string[] {
    return this.plays.map((p) => p.id);
  }
  running(): LoopRec[] {
    return [...this.loops.values()].filter((l) => !l.stopped);
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
  return {
    events,
    audio,
    bridge,
    advance: (s: number) => {
      now += s;
    },
  };
}

const O = { x: 0, y: 0, z: 0 };

function fired(events: EventBus<GameEvents>, weaponId: string, ammoInMag = 10): void {
  events.emit('weapon:fired', {
    weaponId,
    origin: O,
    direction: { x: 0, y: 0, z: -1 },
    muzzle: O,
    shotIndex: 0,
    ammoInMag,
    ads: false,
  });
}

describe('arsenal audio – pure helpers', () => {
  it('maps charge and spin to rising pitch, Doppler to receding/approaching', () => {
    expect(chargePitch(0)).toBeCloseTo(AR.charge.pitch[0]);
    expect(chargePitch(1)).toBeCloseTo(AR.charge.pitch[1]);
    expect(chargePitch(0.5)).toBeGreaterThan(chargePitch(0.2));
    expect(spinPitch(2)).toBeCloseTo(AR.spin.pitch[1]);
    expect(spinPitch(Number.NaN)).toBeCloseTo(AR.spin.pitch[0]);
    expect(dopplerPitch(0)).toBe(1);
    expect(dopplerPitch(40)).toBeLessThan(1);
    expect(dopplerPitch(-40)).toBeGreaterThan(1);
    expect(dopplerPitch(1e6)).toBe(AR.flight.doppler.range[0]);
    expect(dopplerPitch(-1e6)).toBe(AR.flight.doppler.range[1]);
    expect(roomTail('small').gain).toBeLessThan(roomTail('hangar').gain);
    expect(roomTail(null)).toEqual({ gain: 1, pitch: 1 });
    expect(fieldSoundId('pull', 'void')).toBe('field.pull.void');
  });
});

describe('arsenal audio – weapon loops', () => {
  it('beam: ignition + loop while firing, ticks absorbed, release layers on stop', () => {
    const { events, audio } = setup();
    const def = getWeaponDef('flamethrower')!;
    events.emit('weapon:beam', { weaponId: 'flamethrower', active: true });
    expect(audio.ids()).toEqual([def.audio.fire[0]]);
    const loops = audio.running();
    expect(loops.length).toBe(1);
    expect(loops[0]!.id).toBe(def.beam!.loopAudio);
    expect(loops[0]!.opts.position).toBeUndefined();
    // Damage ticks play no gunshot layers and no low-ammo tick.
    audio.plays.length = 0;
    for (let i = 0; i < 12; i++) fired(events, 'flamethrower', 1);
    expect(audio.plays.length).toBe(0);
    events.emit('weapon:beam', { weaponId: 'flamethrower', active: false });
    expect(audio.running().length).toBe(0);
    expect(audio.ids()).toEqual(def.audio.fire.slice(1));
    expect(audio.plays[0]!.opts.volume).toBeCloseTo(W.fireGain * AR.beam.stopGain * fireLayerGain(1));
  });

  it('beam: a watchdog stops a loop whose ticks stopped (no stop event)', () => {
    const { events, audio, bridge } = setup();
    events.emit('weapon:beam', { weaponId: 'chainlightning', active: true });
    for (let i = 0; i < 5; i++) {
      fired(events, 'chainlightning');
      bridge.update(0.1);
    }
    expect(audio.running().length).toBe(1);
    bridge.update(AR.beam.watchdog + 0.05);
    expect(audio.running().length).toBe(0);
    // Silently: no release layers from the watchdog.
    expect(audio.ids()).toEqual([getWeaponDef('chainlightning')!.audio.fire[0]]);
  });

  it('charge: one loop rising in pitch, the full cue once, no fizzle after a shot, a fizzle without', () => {
    const { events, audio, bridge } = setup();
    const charge = (amount: number): void => events.emit('weapon:charge', { weaponId: 'railgun', amount });
    for (const a of [0.1, 0.4, 0.8, 1, 1]) {
      charge(a);
      bridge.update(1 / 60);
    }
    const loops = [...audio.loops.values()];
    expect(loops.length).toBe(1);
    expect(loops[0]!.id).toBe(WEAPONS.railgun.charge.chargeAudio);
    const pitches = loops[0]!.updates.map((u) => u.pitch!);
    for (let i = 1; i < pitches.length; i++) expect(pitches[i]!).toBeGreaterThanOrEqual(pitches[i - 1]!);
    expect(audio.ids().filter((id) => id === AR.charge.full.id).length).toBe(1);
    // Release: the shot, then the charge falls to 0 – no fizzle.
    fired(events, 'railgun', 5);
    charge(0);
    expect(loops[0]!.stopped).toBe(true);
    expect(audio.ids()).not.toContain(AR.charge.fizzle.id);
    // A second charge released below the minimum: no shot → fizzle.
    charge(0.2);
    charge(0);
    expect(audio.ids()).toContain(AR.charge.fizzle.id);
    // A tap too short to be heard fizzles silently.
    audio.plays.length = 0;
    charge(AR.charge.fizzle.min / 2);
    charge(0);
    expect(audio.ids()).not.toContain(AR.charge.fizzle.id);
  });

  it('spin: loop follows the spin up and down, stops at 0', () => {
    const { events, audio } = setup();
    const spin = (amount: number): void => events.emit('weapon:spin', { weaponId: 'minigun', amount });
    spin(0.2);
    spin(0.6);
    spin(1);
    spin(0.5);
    const [loop] = [...audio.loops.values()];
    expect(loop!.id).toBe(WEAPONS.minigun.spinUp.loopAudio);
    expect(loop!.opts.pitch).toBeCloseTo(spinPitch(0.2));
    expect(loop!.updates.map((u) => u.pitch)).toEqual([spinPitch(0.6), spinPitch(1), spinPitch(0.5)]);
    spin(0);
    expect(loop!.stopped).toBe(true);
    expect(audio.loops.size).toBe(1);
  });

  it('a weapon switch and a new run stop every weapon loop', () => {
    const { events, audio } = setup();
    events.emit('weapon:beam', { weaponId: 'flamethrower', active: true });
    events.emit('weapon:spin', { weaponId: 'minigun', amount: 0.5 });
    events.emit('weapon:holsterStart', { weaponId: 'flamethrower', slot: 0, duration: 0.3, next: 'pistol' });
    expect(audio.running().length).toBe(0);
    events.emit('weapon:charge', { weaponId: 'railgun', amount: 0.5 });
    events.emit('run:restart', {});
    expect(audio.running().length).toBe(0);
  });
});

describe('arsenal audio – gunshots', () => {
  it('tails follow the room; mechanics and tails thin out at very high rates', () => {
    const { events, audio, advance } = setup();
    audio.activeReverbZone = 'small';
    fired(events, 'rifle');
    const tail = audio.plays.find((p) => p.id.startsWith(AR.tailPrefix))!;
    expect(tail.opts.volume).toBeCloseTo(W.fireGain * fireLayerGain(2) * AR.roomTails.small.gain);
    expect(tail.opts.pitch).toBeCloseTo(audio.plays[0]!.opts.pitch! * AR.roomTails.small.pitch);
    // Minigun: 2400 rpm for one second.
    audio.plays.length = 0;
    audio.activeReverbZone = null;
    for (let i = 0; i < 40; i++) {
      fired(events, 'minigun', 100);
      advance(1 / 40);
    }
    const count = (id: string): number => audio.plays.filter((p) => p.id === id).length;
    const [body, mech, tailId] = WEAPONS.minigun.audio.fire;
    expect(count(body!)).toBe(40);
    expect(count(mech!)).toBeLessThanOrEqual(Math.ceil(1 / AR.fireLayerMinInterval[1]!) + 1);
    expect(count(tailId!)).toBeLessThanOrEqual(Math.ceil(1 / AR.fireLayerMinInterval[2]!) + 1);
    expect(count(tailId!)).toBeGreaterThan(5);
  });

  it('energy weapons hit with their impact profile; beam impacts are spaced', () => {
    const { events, audio, advance } = setup();
    const impact = (weaponId: string, kind: 'bullet' | 'projectile' | 'beam'): void =>
      events.emit('combat:impact', {
        point: { x: 1, y: 0, z: 0 },
        normal: { x: 0, y: 1, z: 0 },
        surface: 'metal',
        kind,
        weaponId,
        decal: true,
      });
    impact('plasma', 'projectile');
    impact('rifle', 'bullet');
    expect(audio.ids()).toEqual(['impact.plasma', 'impact.metal']);
    audio.plays.length = 0;
    advance(10);
    for (let i = 0; i < 6; i++) impact('flamethrower', 'beam');
    expect(audio.ids()).toEqual(['impact.fire']);
    advance(AR.impacts.beamMinInterval + 0.01);
    impact('flamethrower', 'beam');
    expect(audio.plays.length).toBe(2);
  });

  it('explosions play their own audio id, else the element blast, through a token bucket', () => {
    const { events, audio } = setup();
    const boom = (element: 'fire' | 'void' | 'physical', audioId?: string): void =>
      events.emit('combat:explosion', {
        position: { x: 3, y: 0, z: 0 },
        radius: 4,
        element,
        ...(audioId ? { audio: audioId } : {}),
      });
    boom('void', 'explosion.void.small');
    boom('fire');
    boom('physical', 'explosion.nothing-like-this');
    // Unknown ids of the convention play through their alias (the engine resolves them).
    expect(audio.ids().map((id) => resolveSynthId(id))).toEqual([
      'explosion.void.small',
      'explosion.fire',
      'explosion.physical',
    ]);
    expect(audio.plays[0]!.opts.position).toEqual({ x: 3, y: 0, z: 0 });
    audio.plays.length = 0;
    for (let i = 0; i < 20; i++) boom('physical');
    expect(audio.plays.length).toBe(AR.explosions.burst - 3);
  });
});

describe('arsenal audio – projectiles and fields', () => {
  it('flight loops: nearest projectiles get the voices, follow the source, stop on end', () => {
    const { events, audio, bridge } = setup();
    const positions = new Map<number, Vec3Like>();
    bridge.setArsenalSources({
      projectiles: {
        positionOf(id: number, out: PositionOut): boolean {
          const p = positions.get(id);
          if (!p) return false;
          out.set(p.x, p.y, p.z);
          return true;
        },
      },
    });
    bridge.update(1 / 60, O);
    const spawn = (id: number, x: number): void => {
      positions.set(id, { x, y: 0, z: 0 });
      events.emit('projectile:spawned', {
        id,
        weaponId: 'blackhole',
        visual: 'projectile.voidorb',
        flightAudio: 'projectile.voidorb.flight',
        position: { x, y: 0, z: 0 },
      });
    };
    const n = AR.flight.maxVoices + 3;
    for (let i = 1; i <= n; i++) spawn(i, i * 3);
    expect(audio.running().length).toBe(AR.flight.maxVoices);
    // A silent flight loop (null) or unknown id never starts.
    events.emit('projectile:spawned', { id: 99, weaponId: 'x', visual: 'v', flightAudio: null, position: O });
    expect(audio.running().length).toBe(AR.flight.maxVoices);
    // The voiced ones fly out of range, the waiting ones come close: after a re-rank they swap.
    for (let i = 1; i <= n; i++) positions.set(i, { x: i <= AR.flight.maxVoices ? 100 : 1, y: 0, z: 0 });
    bridge.update(AR.flight.checkInterval + 0.01, O);
    expect(audio.running().length).toBe(n - AR.flight.maxVoices);
    expect(audio.running().every((l) => l.opts.position!.x === 1)).toBe(true);
    // Positions are followed every frame, receding sources drop in pitch (Doppler).
    const loop = audio.running()[0]!;
    const before = loop.updates.length;
    for (let i = 1; i <= n; i++) positions.set(i, { x: positions.get(i)!.x + 1, y: 0, z: 0 });
    bridge.update(1 / 60, O);
    expect(loop.updates.length).toBe(before + 1);
    expect(loop.updates[loop.updates.length - 1]!.pitch!).toBeLessThan(1);
    for (let i = 1; i <= n; i++) events.emit('projectile:ended', { id: i });
    expect(audio.running().length).toBe(0);
    expect(bridge.arsenal.flights.tracked).toBe(0);
  });

  it('field loops: field.<kind>.<element>, positional, stopped on field:ended, budgeted', () => {
    const { events, audio, bridge } = setup();
    bridge.update(1 / 60, O);
    const field = (id: number, kind: string, element: 'void' | 'fire' | 'physical', x: number): void =>
      events.emit('field:spawned', {
        id,
        kind,
        element,
        position: { x, y: 0, z: 0 },
        radius: 3,
        duration: 4,
      });
    field(1, 'pull', 'void', 2);
    field(2, 'slow', 'physical', 1);
    const loops = audio.running();
    expect(loops.map((l) => l.id)).toEqual(['field.pull.void', 'field.slow.physical']);
    expect(resolveSynthId('field.slow.physical')).toBe('field.slow.void');
    expect(loops[0]!.opts.position).toEqual({ x: 2, y: 0, z: 0 });
    expect(loops[0]!.opts.maxDuration).toBeCloseTo(4 + AR.fields.overrun);
    for (let i = 3; i < 3 + AR.fields.maxVoices + 2; i++) field(i, 'damage', 'fire', 5 + i);
    expect(audio.running().length).toBe(AR.fields.maxVoices);
    events.emit('field:ended', { id: 1 });
    expect(audio.running().some((l) => l.id === 'field.pull.void')).toBe(false);
    // A freed voice goes to a waiting field at the next re-rank.
    bridge.update(AR.fields.checkInterval + 0.01, O);
    expect(audio.running().length).toBe(AR.fields.maxVoices);
    events.emit('run:restart', {});
    expect(audio.running().length).toBe(0);
    expect(bridge.arsenal.fields.tracked).toBe(0);
  });

  it('bounces clunk; stops on a surface / body (combat:impact first) and detonations do not', () => {
    const { events, audio, bridge } = setup();
    const impact = (detonated: boolean): void =>
      events.emit('projectile:impact', {
        weaponId: 'grenade.frag',
        position: { x: 1, y: 0, z: 2 },
        normal: { x: 0, y: 1, z: 0 },
        detonated,
      });
    impact(false);
    expect(audio.ids()).toEqual([AR.impacts.bounce.id]);
    expect(audio.plays[0]!.opts.position).toEqual({ x: 1, y: 0, z: 2 });
    impact(true);
    events.emit('combat:impact', {
      point: O,
      normal: O,
      surface: 'concrete',
      kind: 'projectile',
      weaponId: 'grenade.frag',
      decal: true,
    });
    impact(false);
    expect(audio.ids().filter((id) => id === AR.impacts.bounce.id).length).toBe(1);
    bridge.update(1 / 60);
    impact(false);
    expect(audio.ids().filter((id) => id === AR.impacts.bounce.id).length).toBe(2);
  });

  it('a positional loop set is bounded and never tracks an id twice', () => {
    const audio = new FakeAudio();
    const set = new PositionalLoopSet(audio, { ...AR.flight, maxTracked: 3, maxVoices: 2 }, false);
    for (let i = 1; i <= 5; i++) set.add(i, 'projectile.plasma.flight', O, 5, O);
    set.add(1, 'projectile.plasma.flight', O, 5, O);
    expect(set.tracked).toBe(3);
    expect(set.voiced).toBe(2);
    set.remove(2);
    set.remove(42);
    expect(set.tracked).toBe(2);
    set.clear();
    expect(set.tracked).toBe(0);
    expect(audio.running().length).toBe(0);
  });
});

describe('arsenal audio – elements, gear, forge', () => {
  it('statuses and combos: positional, distance culled, rate limited, stacks raise the pitch', () => {
    const { events, audio, bridge } = setup();
    bridge.update(1 / 60, O);
    const status = (stacks: number, x = 3): void =>
      events.emit('combat:status', { targetId: 1, status: 'poisoned', stacks, position: { x, y: 0, z: 0 } });
    status(1);
    status(3);
    expect(audio.ids()).toEqual(['status.poisoned', 'status.poisoned']);
    expect(audio.plays[1]!.opts.pitch!).toBeGreaterThan(audio.plays[0]!.opts.pitch!);
    status(1, AR.status.maxDistance + 5);
    for (let i = 0; i < 10; i++) status(1);
    expect(audio.plays.length).toBe(AR.status.burst);
    audio.plays.length = 0;
    events.emit('combat:combo', { targetId: 1, combo: 'thermoshock', position: { x: 2, y: 0, z: 0 } });
    expect(audio.ids()).toEqual(['combo.thermoshock']);
    expect(audio.plays[0]!.opts.position).toEqual({ x: 2, y: 0, z: 0 });
    for (const id of new Set(audio.ids())) expect(resolveSynthId(id), id).not.toBeNull();
  });

  it('grenades, abilities, forge upgrades, bench menus, attachments and element modules', () => {
    const { events, audio } = setup();
    events.emit('grenade:changed', { grenadeId: 'frag', count: 2, max: 4 });
    events.emit('grenade:thrown', { grenadeId: 'frag', position: O });
    events.emit('grenade:changed', { grenadeId: 'frag', count: 1, max: 4 });
    expect(audio.ids()).toEqual([AR.grenades.pin.id, AR.grenades.throw.id]);
    events.emit('grenade:changed', { grenadeId: 'kryo', count: 2, max: 3 });
    expect(audio.plays[2]!.opts.pitch).toBe(AR.grenades.select.pitch);
    audio.plays.length = 0;
    events.emit('ability:used', { abilityId: 'chronofeld', cooldown: 30, duration: 7 });
    events.emit('ability:used', { abilityId: 'schockwelle', cooldown: 20, duration: 0 });
    events.emit('ability:used', { abilityId: 'brandneu', cooldown: 20, duration: 0 });
    events.emit('ability:ended', { abilityId: 'schockwelle' });
    events.emit('ability:ended', { abilityId: 'chronofeld' });
    events.emit('ability:ready', { abilityId: 'chronofeld' });
    expect(audio.ids().map((id) => resolveSynthId(id))).toEqual([
      'ability.chronofeld',
      'ability.schockwelle',
      AR.abilities.fallback,
      AR.abilities.end.id,
      AR.abilities.ready.id,
    ]);
    audio.plays.length = 0;
    // An upgrade: modsChanged (tier up) is silent, forge:upgraded plays the forge sequence.
    events.emit('weapon:modsChanged', { weaponId: 'rifle', tier: 1, attachments: [], element: null });
    events.emit('forge:upgraded', { weaponId: 'rifle', tier: 1, name: 'x' });
    events.emit('weapon:modsChanged', { weaponId: 'rifle', tier: 1, attachments: ['red'], element: null });
    events.emit('weapon:modsChanged', { weaponId: 'rifle', tier: 1, attachments: ['red'], element: 'fire' });
    events.emit('weapon:modsChanged', { weaponId: 'rifle', tier: 1, attachments: [], element: 'fire' });
    events.emit('economy:purchase', { item: 'rifle', kind: 'forge', cost: 5000, ok: false });
    events.emit('economy:purchase', { item: 'door', kind: 'door', cost: 750, ok: false });
    // (The economy's denial buzzer plays on every refused purchase; the forge adds its machine.)
    expect(audio.ids().filter((id) => !id.startsWith('econ.'))).toEqual([
      AR.forge.upgrade.id,
      AR.bench.attach.id,
      AR.bench.element.id,
      AR.bench.attach.id,
      AR.forge.deny.id,
    ]);
    expect(audio.plays[3]!.opts.pitch).toBe(AR.bench.detachPitch);
    // Bench menus: drawer sounds instead of the generic menu click.
    audio.plays.length = 0;
    events.emit('ui:menu', { open: true, menu: AR.bench.menus[0]! });
    events.emit('ui:menu', { open: false, menu: AR.bench.menus[0]! });
    events.emit('ui:menu', { open: true, menu: 'pause' });
    expect(audio.ids()).toEqual([AR.bench.open.id, AR.bench.close.id, 'ui.click']);
    for (const id of new Set(audio.ids())) expect(resolveSynthId(id), id).not.toBeNull();
  });
});
