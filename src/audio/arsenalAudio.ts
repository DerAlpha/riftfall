/**
 * M5 arsenal sounds – the part of AudioEventBridge that maps arsenal events to the procedural bank
 * (audio/arsenalSynth.ts + energy/element/gear synths, AUDIO.arsenal). AudioEventBridge constructs
 * it, forwards update / resetRun / dispose / setArsenalSources and asks it about beam shots and
 * energy impact profiles.
 *
 * - weapon:beam: the def's first fire layer ignites, `beam.loopAudio` loops (2D) while it fires, the
 *   other fire layers (release + tail) play when it stops; the beam's per-tick weapon:fired is
 *   absorbed (`absorbsFire`) and keeps a watchdog alive (the loop stops by itself without ticks).
 * - weapon:charge: `charge.chargeAudio` loops while charging, pitch and level rising with the
 *   charge; a full-charge cue; a fizzle when the charge ends without a shot.
 * - weapon:spin: `spinUp.loopAudio` loops while the barrels turn, pitched and leveled by the spin.
 * - projectile:spawned/ended: positional flight loops (`flightAudio`) for the nearest projectiles
 *   (voice budget, hysteresis), moved every frame from the projectile source, with Doppler.
 * - projectile:impact (not detonated, no surface impact in the same tick): a bounce clunk.
 * - field:spawned/ended: positional `field.<kind>.<element>` loops for the nearest fields.
 * - combat:status / combat:combo: positional cues (token buckets, distance culled).
 * - grenade:thrown / changed, ability:used / ready / ended, forge:upgraded, weapon:modsChanged
 *   (attachments / element modules), a denied forge purchase, bench menus (ui:menu).
 *
 * Payloads are reused by their emitters: positions are copied at once, nothing is kept by
 * reference. No allocation per event or frame after warm-up (fixed tables, cached id strings).
 */
import type { PlayOptions } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, StatusId, Vec3Like } from '../core/events';
import { AUDIO } from '../defs/audio';
import { getWeaponDef } from '../defs/weapons';
import type { LoopOptions, LoopUpdate } from './AudioEngine';
import type { AudioBridgeTarget } from './AudioEventBridge';
import { TokenBucket } from './tokenBucket';

const AR = AUDIO.arsenal;
const W = AUDIO.weapons;

/** Out parameter of a position query (THREE.Vector3 fits). */
export interface PositionOut {
  set(x: number, y: number, z: number): unknown;
}

/** World sources of the arsenal loops (Game wires them from the arsenal). */
export interface ArsenalAudioSources {
  /** Drawn projectile positions per frame (ProjectileApi fits). */
  projectiles?: { positionOf(id: number, out: PositionOut): boolean } | null;
  /** Live field positions (fields that follow the player move); optional – static otherwise. */
  fields?: { positionOf?(id: number, out: PositionOut): boolean } | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Loop pitch of a charge 0..1. */
export function chargePitch(amount: number): number {
  const [lo, hi] = AR.charge.pitch;
  return lo + (hi - lo) * clamp01(amount);
}

/** Loop pitch of a barrel spin 0..1. */
export function spinPitch(amount: number): number {
  const [lo, hi] = AR.spin.pitch;
  return lo + (hi - lo) * clamp01(amount);
}

/** Doppler pitch for a source receding at `radialSpeed` m/s (negative = approaching), clamped. */
export function dopplerPitch(radialSpeed: number): number {
  const D = AR.flight.doppler;
  if (!Number.isFinite(radialSpeed)) return 1;
  const p = D.speedOfSound / Math.max(1, D.speedOfSound + radialSpeed * D.scale);
  return Math.min(D.range[1], Math.max(D.range[0], p));
}

/** Gain and pitch of a gunshot tail layer in `zone` (unknown zones: unchanged). */
export function roomTail(zone: string | null | undefined): { readonly gain: number; readonly pitch: number } {
  const R = AR.roomTails as Readonly<Record<string, { gain: number; pitch: number }>>;
  return zone && Object.prototype.hasOwnProperty.call(R, zone) ? R[zone]! : NEUTRAL_ROOM;
}

const NEUTRAL_ROOM = { gain: 1, pitch: 1 } as const;

/** Field loop id: `field.<kind>.<element>`. */
export function fieldSoundId(kind: string, element: string): string {
  return `field.${kind}.${element}`;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

// ---------------------------------------------------------------------------
// Positional loop set: tracked sources, the nearest get a voice
// ---------------------------------------------------------------------------

interface LoopSetConfig {
  readonly gain: number;
  readonly maxVoices: number;
  readonly maxTracked: number;
  readonly maxDistance: number;
  readonly margin: number;
  readonly fadeIn: number;
  readonly fadeOut: number;
  readonly checkInterval: number;
}

/**
 * Positional loops of many sources (projectiles, fields) through a small voice budget: the
 * nearest `maxVoices` within `maxDistance` sound; a voiced source keeps its voice until another is
 * `margin` m nearer (hysteresis). Fixed tables, swap-remove, no allocation.
 */
export class PositionalLoopSet {
  private readonly ids: Int32Array;
  private readonly handles: Int32Array;
  private readonly sounds: string[];
  private readonly pos: Float64Array;
  private readonly dist: Float64Array;
  private readonly prevDist: Float64Array;
  private readonly pitch: Float32Array;
  private readonly maxSeconds: Float32Array;
  private readonly picked: Uint8Array;
  private count = 0;
  private checkTimer = 0;
  private readonly startOpts: LoopOptions & { position: Vec3Like } = { position: { x: 0, y: 0, z: 0 } };
  private readonly upd: LoopUpdate & { position: Vec3Like } = { position: { x: 0, y: 0, z: 0 } };
  private readonly out = {
    x: 0,
    y: 0,
    z: 0,
    set(x: number, y: number, z: number): void {
      this.x = x;
      this.y = y;
      this.z = z;
    },
  };

  constructor(
    private readonly audio: AudioBridgeTarget,
    private readonly cfg: LoopSetConfig,
    /** Doppler on moving sources (flight loops). */
    private readonly doppler: boolean,
  ) {
    const n = Math.max(1, cfg.maxTracked);
    this.ids = new Int32Array(n);
    this.handles = new Int32Array(n);
    this.sounds = new Array<string>(n).fill('');
    this.pos = new Float64Array(n * 3);
    this.dist = new Float64Array(n);
    this.prevDist = new Float64Array(n);
    this.pitch = new Float32Array(n).fill(1);
    this.maxSeconds = new Float32Array(n);
    this.picked = new Uint8Array(n);
  }

  get tracked(): number {
    return this.count;
  }

  /** Voiced sources right now. */
  get voiced(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (this.handles[i]! > 0) n++;
    return n;
  }

  /** Track a new source (ignored when the table is full); it starts at once when a voice is free. */
  add(id: number, sound: string, position: Vec3Like, maxSeconds: number, listener: Vec3Like | null): void {
    if (this.count >= this.ids.length || this.indexOf(id) >= 0) return;
    const i = this.count++;
    this.ids[i] = id;
    this.handles[i] = 0;
    this.sounds[i] = sound;
    this.pos[i * 3] = position.x;
    this.pos[i * 3 + 1] = position.y;
    this.pos[i * 3 + 2] = position.z;
    const d = listener ? distanceTo(this.pos, i, listener) : 0;
    this.dist[i] = d;
    this.prevDist[i] = d;
    this.pitch[i] = 1;
    this.maxSeconds[i] = maxSeconds;
    if (d <= this.cfg.maxDistance && this.voiced < this.cfg.maxVoices) this.start(i);
  }

  /** Stop tracking `id` (its loop fades out). */
  remove(id: number): void {
    const i = this.indexOf(id);
    if (i < 0) return;
    this.stop(i);
    const last = --this.count;
    if (i !== last) {
      this.ids[i] = this.ids[last]!;
      this.handles[i] = this.handles[last]!;
      this.sounds[i] = this.sounds[last]!;
      this.pos[i * 3] = this.pos[last * 3]!;
      this.pos[i * 3 + 1] = this.pos[last * 3 + 1]!;
      this.pos[i * 3 + 2] = this.pos[last * 3 + 2]!;
      this.dist[i] = this.dist[last]!;
      this.prevDist[i] = this.prevDist[last]!;
      this.pitch[i] = this.pitch[last]!;
      this.maxSeconds[i] = this.maxSeconds[last]!;
    }
    this.sounds[last] = '';
  }

  /**
   * Per frame: voiced sources follow their source's position (and Doppler); every
   * `checkInterval` s every source is re-measured and the voices go to the nearest.
   */
  update(dt: number, listener: Vec3Like | null, source: ((id: number, out: PositionOut) => boolean) | null): void {
    if (this.count === 0) return;
    this.checkTimer -= dt;
    const rank = this.checkTimer <= 0;
    if (rank) this.checkTimer = this.cfg.checkInterval;
    for (let i = 0; i < this.count; i++) {
      const voiced = this.handles[i]! > 0;
      if (!voiced && !rank) continue;
      if (source && source(this.ids[i]!, this.out)) {
        this.pos[i * 3] = this.out.x;
        this.pos[i * 3 + 1] = this.out.y;
        this.pos[i * 3 + 2] = this.out.z;
      }
      const d = listener ? distanceTo(this.pos, i, listener) : 0;
      if (voiced) {
        const u = this.upd;
        u.position.x = this.pos[i * 3]!;
        u.position.y = this.pos[i * 3 + 1]!;
        u.position.z = this.pos[i * 3 + 2]!;
        u.pitch = undefined;
        if (this.doppler && dt > 0) {
          const target = dopplerPitch((d - this.prevDist[i]!) / dt);
          const k = Math.min(1, dt / Math.max(1e-3, AR.flight.doppler.response));
          this.pitch[i] = this.pitch[i]! + (target - this.pitch[i]!) * k;
          u.pitch = this.pitch[i]!;
        }
        // A loop that ended by itself (maxDuration, stolen) gives its voice back.
        if (this.audio.updateLoop && !this.audio.updateLoop(this.handles[i]!, u)) this.handles[i] = 0;
      }
      this.prevDist[i] = d;
      this.dist[i] = d;
    }
    if (rank) this.rank();
  }

  /** Stop every loop and forget every source. */
  clear(): void {
    for (let i = 0; i < this.count; i++) {
      this.stop(i);
      this.sounds[i] = '';
    }
    this.count = 0;
  }

  private rank(): void {
    const C = this.cfg;
    const picked = this.picked;
    picked.fill(0, 0, this.count);
    for (let v = 0; v < C.maxVoices; v++) {
      let best = -1;
      let bestD = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.count; i++) {
        if (picked[i]) continue;
        const d = this.dist[i]! - (this.handles[i]! > 0 ? C.margin : 0);
        if (this.dist[i]! <= C.maxDistance && d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0) break;
      picked[best] = 1;
    }
    for (let i = 0; i < this.count; i++) if (!picked[i] && this.handles[i]! > 0) this.stop(i);
    for (let i = 0; i < this.count; i++) if (picked[i] && this.handles[i] === 0) this.start(i);
  }

  private start(i: number): void {
    const o = this.startOpts;
    o.position.x = this.pos[i * 3]!;
    o.position.y = this.pos[i * 3 + 1]!;
    o.position.z = this.pos[i * 3 + 2]!;
    o.volume = this.cfg.gain;
    o.pitch = this.pitch[i]!;
    o.pitchVariance = 0;
    o.bus = 'sfx';
    o.fadeIn = this.cfg.fadeIn;
    o.maxDuration = this.maxSeconds[i]!;
    this.handles[i] = Math.max(0, this.audio.startLoop(this.sounds[i]!, o));
  }

  private stop(i: number): void {
    const h = this.handles[i]!;
    if (h > 0) this.audio.stopLoop(h, this.cfg.fadeOut);
    this.handles[i] = 0;
  }

  private indexOf(id: number): number {
    for (let i = 0; i < this.count; i++) if (this.ids[i] === id) return i;
    return -1;
  }
}

function distanceTo(pos: Float64Array, i: number, l: Vec3Like): number {
  return Math.hypot(pos[i * 3]! - l.x, pos[i * 3 + 1]! - l.y, pos[i * 3 + 2]! - l.z);
}

// ---------------------------------------------------------------------------

interface ModState {
  tier: number;
  element: string | null;
  attachments: string[];
}

export class ArsenalAudio {
  private readonly offs: (() => void)[] = [];
  private readonly opts: PlayOptions = {};
  private readonly posOpts: PlayOptions & { position: Vec3Like } = { position: { x: 0, y: 0, z: 0 } };
  private readonly loopOpts: LoopOptions = {};
  private readonly upd: LoopUpdate = {};
  private sources: ArsenalAudioSources = {};
  private readonly listener = { x: 0, y: 0, z: 0 };
  private hasListener = false;
  private gameTime = 0;

  // Beam (weapon:beam).
  private beamHandle = 0;
  private beamWeapon = '';
  private beamLastTick = 0;
  // Charge (weapon:charge).
  private chargeHandle = 0;
  private chargeWeapon = '';
  private chargePeak = 0;
  private chargeEventAt = 0;
  private chargeFull = false;
  private firedSinceCharge = false;
  // Spin (weapon:spin).
  private spinHandle = 0;
  private spinWeapon = '';

  readonly flights: PositionalLoopSet;
  readonly fields: PositionalLoopSet;
  private readonly fieldPosition = (id: number, out: PositionOut): boolean =>
    this.sources.fields?.positionOf?.(id, out) ?? false;
  private readonly projectilePosition = (id: number, out: PositionOut): boolean =>
    this.sources.projectiles?.positionOf(id, out) ?? false;

  /** Weapon whose projectile hit a surface / body this frame (combat:impact) – no bounce clunk for it. */
  private projectileImpactWeapon = '';
  private readonly bounceBucket = new TokenBucket(AR.impacts.bounce.burst, AR.impacts.bounce.refillPerSecond);
  private readonly explosionBucket = new TokenBucket(AR.explosions.burst, AR.explosions.refillPerSecond);
  private readonly comboBucket = new TokenBucket(AR.combos.burst, AR.combos.refillPerSecond);
  private readonly statusBuckets = new Map<StatusId, TokenBucket>();
  private lastBeamImpactAt = Number.NEGATIVE_INFINITY;
  /** Cached ids (built once per key): no string building per event. */
  private readonly comboIds = new Map<string, string>();
  private readonly abilityIds = new Map<string, string>();
  private readonly explosionIds = new Map<string, string>();
  private readonly fieldIds = new Map<string, string>();
  private readonly energyImpacts = new Map<string, string | null>();
  private readonly mods = new Map<string, ModState>();
  private grenadeSelected = '';
  private readonly timedAbilities = new Set<string>();

  constructor(
    events: EventBus<GameEvents>,
    private readonly audio: AudioBridgeTarget,
    private readonly now: () => number,
  ) {
    this.flights = new PositionalLoopSet(audio, AR.flight, true);
    this.fields = new PositionalLoopSet(audio, AR.fields, false);
    this.offs.push(
      events.on('weapon:beam', (e) => (e.active ? this.startBeam(e.weaponId) : this.stopBeam(true))),
      events.on('weapon:charge', (e) => this.onCharge(e.weaponId, e.amount)),
      events.on('weapon:spin', (e) => this.onSpin(e.weaponId, e.amount)),
      events.on('weapon:fired', (e) => {
        if (e.weaponId === this.chargeWeapon) this.firedSinceCharge = true;
      }),
      events.on('weapon:holsterStart', () => this.stopWeaponLoops()),
      events.on('projectile:spawned', (e) => {
        if (e.flightAudio === null || !this.known(e.flightAudio)) return;
        this.flights.add(e.id, e.flightAudio, e.position, AR.flight.maxSeconds, this.listenerOrNull());
      }),
      events.on('projectile:ended', (e) => this.flights.remove(e.id)),
      events.on('projectile:impact', (e) => {
        const surfaced = this.projectileImpactWeapon === e.weaponId;
        this.projectileImpactWeapon = '';
        if (e.detonated || surfaced) return;
        const B = AR.impacts.bounce;
        if (!this.bounceBucket.take(this.now())) return;
        this.playAt(B.id, e.position, B.gain, B.pitchVariance);
      }),
      events.on('field:spawned', (e) => {
        const id = this.fieldId(e.kind, e.element);
        if (!this.known(id)) return;
        this.fields.add(e.id, id, e.position, e.duration + AR.fields.overrun, this.listenerOrNull());
      }),
      events.on('field:ended', (e) => this.fields.remove(e.id)),
      events.on('combat:status', (e) => {
        const S = AR.status;
        if (!this.near(e.position, S.maxDistance)) return;
        if (!this.statusBucket(e.status).take(this.now())) return;
        const pitch = 1 + S.stackPitch * Math.max(0, e.stacks - 1);
        this.playAt(S.ids[e.status], e.position, S.gain, S.pitchVariance, pitch);
      }),
      events.on('combat:combo', (e) => {
        const C = AR.combos;
        if (!this.near(e.position, C.maxDistance) || !this.comboBucket.take(this.now())) return;
        this.playAt(this.comboId(e.combo), e.position, C.gain, C.pitchVariance);
      }),
      events.on('grenade:thrown', () => {
        const G = AR.grenades;
        this.play(G.pin.id, G.pin.gain, G.pitchVariance);
        this.play(G.throw.id, G.throw.gain, G.pitchVariance);
      }),
      events.on('grenade:changed', (e) => {
        const prev = this.grenadeSelected;
        this.grenadeSelected = e.grenadeId;
        if (prev !== '' && prev !== e.grenadeId) {
          const G = AR.grenades;
          this.play(G.pin.id, G.select.gain, 0, 'sfx', G.select.pitch);
        }
      }),
      events.on('ability:used', (e) => {
        const A = AR.abilities;
        if (e.duration > 0) this.timedAbilities.add(e.abilityId);
        this.play(this.abilityId(e.abilityId), A.gain, 0);
      }),
      events.on('ability:ended', (e) => {
        if (!this.timedAbilities.delete(e.abilityId)) return;
        const A = AR.abilities.end;
        this.play(A.id, A.gain, 0);
      }),
      events.on('ability:ready', () => {
        const A = AR.abilities.ready;
        this.play(A.id, A.gain, 0);
      }),
      events.on('forge:upgraded', (e) => {
        const F = AR.forge.upgrade;
        this.play(F.id, F.gain, 0);
        const m = this.modState(e.weaponId);
        m.tier = Math.max(m.tier, e.tier);
      }),
      events.on('weapon:modsChanged', (e) => this.onModsChanged(e)),
      events.on('economy:purchase', (e) => {
        if (e.ok || e.kind !== AR.forge.purchaseKind) return;
        const F = AR.forge.deny;
        this.play(F.id, F.gain, 0);
      }),
      events.on('ui:menu', (e) => {
        if (!isBenchMenu(e.menu)) return;
        const B = e.open ? AR.bench.open : AR.bench.close;
        this.play(B.id, B.gain, 0, 'ui');
      }),
      events.on('run:restart', () => this.resetRun()),
    );
  }

  setSources(sources: ArsenalAudioSources): void {
    this.sources = sources;
  }

  /**
   * weapon:fired of a beam weapon is one damage tick (10–12/s): the loop is its sound, so the
   * bridge plays no gunshot layers (and no low-ammo tick); the tick keeps the loop's watchdog fed.
   */
  absorbsFire(weaponId: string): boolean {
    if (getWeaponDef(weaponId)?.kind !== 'beam') return false;
    if (weaponId === this.beamWeapon) this.beamLastTick = this.gameTime;
    return true;
  }

  /**
   * Impact sound of an energy weapon (its VFX impact profile when that names a sound, e.g.
   * impact.plasma) instead of the surface sound; null for ballistic weapons and unknown ids.
   */
  impactSoundFor(weaponId: string): string | null {
    let id = this.energyImpacts.get(weaponId);
    if (id === undefined) {
      const vfx = getWeaponDef(weaponId)?.vfx.impact ?? null;
      id = vfx !== null && vfx !== AR.impacts.bulletImpact && this.known(vfx) ? vfx : null;
      this.energyImpacts.set(weaponId, id);
    }
    return id;
  }

  /** Beam impacts sound at most every AR.impacts.beamMinInterval (wall clock). */
  takeBeamImpact(): boolean {
    const now = this.now();
    if (now - this.lastBeamImpactAt < AR.impacts.beamMinInterval) return false;
    this.lastBeamImpactAt = now;
    return true;
  }

  /** A projectile of `weaponId` hit a surface or body (combat:impact kind 'projectile'): no bounce. */
  noteProjectileImpact(weaponId: string): void {
    this.projectileImpactWeapon = weaponId;
  }

  /** Explosion token bucket (chain reactions of small blasts). */
  takeExplosion(): boolean {
    return this.explosionBucket.take(this.now());
  }

  /**
   * Sound of a combat:explosion: its `audio` id when it resolves, else `explosion.<element>`
   * (the M5 set), else the generic blast.
   */
  explosionSound(audio: string | undefined, element: string): string {
    if (audio !== undefined && this.known(audio)) return audio;
    let id = this.explosionIds.get(element);
    if (id === undefined) {
      const conv = `${AR.explosions.prefix}${element}`;
      id = this.known(conv) ? conv : W.explosion.id;
      this.explosionIds.set(element, id);
    }
    return id;
  }

  /** Per frame (game dt): loop watchdogs, flight and field loop positions / voices. */
  update(dt: number, listener: Vec3Like | null): void {
    if (listener) {
      this.listener.x = listener.x;
      this.listener.y = listener.y;
      this.listener.z = listener.z;
      this.hasListener = true;
    }
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this.gameTime += dt;
    this.projectileImpactWeapon = '';
    if (this.beamHandle !== 0 && this.gameTime - this.beamLastTick > AR.beam.watchdog) this.stopBeam(false);
    if (this.chargeHandle !== 0 && this.gameTime - this.chargeEventAt > AR.charge.watchdog) this.endCharge(false);
    const l = this.listenerOrNull();
    this.flights.update(dt, l, this.sources.projectiles ? this.projectilePosition : null);
    this.fields.update(dt, l, this.sources.fields?.positionOf ? this.fieldPosition : null);
  }

  /** A new run: every loop stops, every tracked source and mod state is forgotten. */
  resetRun(): void {
    this.stopWeaponLoops();
    this.flights.clear();
    this.fields.clear();
    this.mods.clear();
    this.timedAbilities.clear();
    this.grenadeSelected = '';
    this.projectileImpactWeapon = '';
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.resetRun();
    this.sources = {};
  }

  // -------------------------------------------------------------------------
  // Weapon loops
  // -------------------------------------------------------------------------

  private startBeam(weaponId: string): void {
    this.stopBeam(false);
    const def = getWeaponDef(weaponId);
    const loop = def?.beam?.loopAudio;
    if (!def || !loop) return;
    const B = AR.beam;
    const ignite = def.audio.fire[0];
    if (ignite !== undefined) this.play(ignite, W.fireGain * B.startGain, W.firePitchVariance);
    this.beamWeapon = weaponId;
    this.beamLastTick = this.gameTime;
    const o = this.loopOpts;
    o.volume = B.gain;
    o.pitch = 1;
    o.pitchVariance = 0;
    o.bus = 'sfx';
    o.fadeIn = B.fadeIn;
    o.maxDuration = B.maxSeconds;
    this.beamHandle = Math.max(0, this.audio.startLoop(loop, o));
  }

  /** `release`: the beam really stopped (play the release layers); false: silently (watchdog, switch). */
  private stopBeam(release: boolean): void {
    const weaponId = this.beamWeapon;
    if (this.beamHandle !== 0) this.audio.stopLoop(this.beamHandle, AR.beam.fadeOut);
    const wasActive = this.beamHandle !== 0 || weaponId !== '';
    this.beamHandle = 0;
    this.beamWeapon = '';
    if (!release || !wasActive) return;
    const layers = getWeaponDef(weaponId)?.audio.fire;
    if (!layers) return;
    for (let i = 1; i < layers.length; i++) {
      this.play(layers[i]!, W.fireGain * AR.beam.stopGain * fireLayerGainOf(i), W.handlingPitchVariance);
    }
  }

  private onCharge(weaponId: string, amount: number): void {
    const C = AR.charge;
    this.chargeEventAt = this.gameTime;
    if (!(amount > 0)) {
      if (this.chargeWeapon !== '') this.endCharge(true);
      return;
    }
    if (this.chargeWeapon !== weaponId || this.chargeHandle === 0) {
      if (this.chargeWeapon !== weaponId) this.endCharge(false);
      const loop = getWeaponDef(weaponId)?.charge?.chargeAudio;
      this.chargeWeapon = weaponId;
      this.firedSinceCharge = false;
      this.chargeFull = false;
      this.chargePeak = 0;
      if (loop && this.chargeHandle === 0) {
        const o = this.loopOpts;
        o.volume = C.gain * chargeVolume(amount);
        o.pitch = chargePitch(amount);
        o.pitchVariance = 0;
        o.bus = 'sfx';
        o.fadeIn = C.fadeIn;
        o.maxDuration = C.maxSeconds;
        this.chargeHandle = Math.max(0, this.audio.startLoop(loop, o));
      }
    }
    this.chargePeak = Math.max(this.chargePeak, amount);
    if (this.chargeHandle !== 0) {
      const u = this.upd;
      u.volume = C.gain * chargeVolume(amount);
      u.pitch = chargePitch(amount);
      u.position = undefined;
      this.audio.updateLoop?.(this.chargeHandle, u);
    }
    if (amount >= 1 && !this.chargeFull) {
      this.chargeFull = true;
      this.play(C.full.id, C.full.gain, 0);
    }
  }

  /** The charge ended: the loop stops; without a shot (fizzle) from a noticeable charge, a power-down. */
  private endCharge(audible: boolean): void {
    const C = AR.charge;
    if (this.chargeHandle !== 0) this.audio.stopLoop(this.chargeHandle, C.fadeOut);
    const fizzled = audible && !this.firedSinceCharge && this.chargePeak >= C.fizzle.min;
    this.chargeHandle = 0;
    this.chargeWeapon = '';
    this.chargePeak = 0;
    this.chargeFull = false;
    this.firedSinceCharge = false;
    if (fizzled) this.play(C.fizzle.id, C.fizzle.gain, W.handlingPitchVariance);
  }

  private onSpin(weaponId: string, amount: number): void {
    const S = AR.spin;
    if (!(amount > 0)) {
      if (this.spinHandle !== 0) this.audio.stopLoop(this.spinHandle, S.fadeOut);
      this.spinHandle = 0;
      this.spinWeapon = '';
      return;
    }
    if (this.spinHandle === 0 || this.spinWeapon !== weaponId) {
      if (this.spinHandle !== 0) this.audio.stopLoop(this.spinHandle, S.fadeOut);
      this.spinHandle = 0;
      this.spinWeapon = weaponId;
      const loop = getWeaponDef(weaponId)?.spinUp?.loopAudio;
      if (loop) {
        const o = this.loopOpts;
        o.volume = S.gain * spinVolume(amount);
        o.pitch = spinPitch(amount);
        o.pitchVariance = 0;
        o.bus = 'sfx';
        o.fadeIn = S.fadeIn;
        o.maxDuration = S.maxSeconds;
        this.spinHandle = Math.max(0, this.audio.startLoop(loop, o));
      }
      return;
    }
    const u = this.upd;
    u.volume = S.gain * spinVolume(amount);
    u.pitch = spinPitch(amount);
    u.position = undefined;
    if (this.audio.updateLoop && !this.audio.updateLoop(this.spinHandle, u)) {
      // Ended by its safety stop while still spinning: restart on the next change.
      this.spinHandle = 0;
    }
  }

  /** Switching weapons: no loop of the old weapon may linger (the system also reports 0s). */
  private stopWeaponLoops(): void {
    this.stopBeam(false);
    this.endCharge(false);
    if (this.spinHandle !== 0) this.audio.stopLoop(this.spinHandle, AR.spin.fadeOut);
    this.spinHandle = 0;
    this.spinWeapon = '';
  }

  // -------------------------------------------------------------------------
  // Forge / bench
  // -------------------------------------------------------------------------

  private onModsChanged(e: GameEvents['weapon:modsChanged']): void {
    const m = this.modState(e.weaponId);
    const upgraded = e.tier > m.tier;
    const elementChanged = e.element !== m.element;
    const added = countNew(e.attachments, m.attachments);
    const removed = countNew(m.attachments, e.attachments);
    m.tier = e.tier;
    m.element = e.element;
    m.attachments.length = 0;
    for (const a of e.attachments) m.attachments.push(a);
    // An upgrade sounds through forge:upgraded (emitted right after this event).
    if (upgraded) return;
    const B = AR.bench;
    if (elementChanged && e.element !== null) this.play(B.element.id, B.element.gain, 0);
    else if (added > 0 || (elementChanged && e.element === null)) this.play(B.attach.id, B.attach.gain, W.handlingPitchVariance);
    else if (removed > 0) this.play(B.attach.id, B.attach.gain, 0, 'sfx', B.detachPitch);
  }

  private modState(weaponId: string): ModState {
    let m = this.mods.get(weaponId);
    if (!m) {
      m = { tier: 0, element: null, attachments: [] };
      this.mods.set(weaponId, m);
    }
    return m;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private known(id: string): boolean {
    return this.audio.has ? this.audio.has(id) : true;
  }

  private listenerOrNull(): Vec3Like | null {
    return this.hasListener ? this.listener : null;
  }

  private near(p: Vec3Like, maxDistance: number): boolean {
    if (!this.hasListener) return true;
    const l = this.listener;
    return Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z) <= maxDistance;
  }

  private statusBucket(status: StatusId): TokenBucket {
    let b = this.statusBuckets.get(status);
    if (!b) {
      b = new TokenBucket(AR.status.burst, AR.status.refillPerSecond);
      this.statusBuckets.set(status, b);
    }
    return b;
  }

  private comboId(combo: string): string {
    let id = this.comboIds.get(combo);
    if (id === undefined) {
      id = `${AR.combos.prefix}${combo}`;
      this.comboIds.set(combo, id);
    }
    return id;
  }

  private abilityId(ability: string): string {
    let id = this.abilityIds.get(ability);
    if (id === undefined) {
      const conv = `${AR.abilities.prefix}${ability}`;
      id = this.known(conv) ? conv : AR.abilities.fallback;
      this.abilityIds.set(ability, id);
    }
    return id;
  }

  private fieldId(kind: string, element: string): string {
    const key = `${kind}|${element}`;
    let id = this.fieldIds.get(key);
    if (id === undefined) {
      id = fieldSoundId(kind, element);
      this.fieldIds.set(key, id);
    }
    return id;
  }

  private play(id: string, volume: number, pitchVariance: number, bus: PlayOptions['bus'] = 'sfx', pitch = 1): void {
    const o = this.opts;
    o.volume = volume;
    o.pitchVariance = pitchVariance;
    o.bus = bus;
    o.pitch = pitch;
    this.audio.play(id, o);
  }

  private playAt(id: string, position: Vec3Like, volume: number, pitchVariance: number, pitch = 1): void {
    const o = this.posOpts;
    o.position.x = position.x;
    o.position.y = position.y;
    o.position.z = position.z;
    o.volume = volume;
    o.pitchVariance = pitchVariance;
    o.pitch = pitch;
    o.bus = 'sfx';
    this.audio.play(id, o);
  }
}

function chargeVolume(amount: number): number {
  const [lo, hi] = AR.charge.volume;
  return lo + (hi - lo) * clamp01(amount);
}

function spinVolume(amount: number): number {
  const [lo, hi] = AR.spin.volume;
  return lo + (hi - lo) * clamp01(amount);
}

function fireLayerGainOf(index: number): number {
  const g = W.fireLayerGains;
  return g.length === 0 ? 1 : g[Math.min(index, g.length - 1)]!;
}

/** Entries of `a` missing from `b`. */
function countNew(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  for (const x of a) if (!b.includes(x)) n++;
  return n;
}

/** Bench menus play their own open/close sounds (the bridge skips its generic click for them). */
export function isBenchMenu(menu: string): boolean {
  return AR.bench.menus.includes(menu);
}
