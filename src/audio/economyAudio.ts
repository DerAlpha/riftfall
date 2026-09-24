/**
 * M4 economy sounds – the part of AudioEventBridge that maps economy/interactable events to the
 * procedural bank of audio/economySynth.ts (AUDIO.economy). AudioEventBridge constructs it and
 * forwards update / resetRun / dispose / setEconomySources.
 *
 * - economy:points: a subtle tick per earning (rate limited, pitch rises with the amount; not for
 *   dev grants, the start balance or spending), economy:purchase: ka-ching / denial buzzer (ui bus),
 *   interact:focus: a quiet blip when a new interactable comes into focus.
 * - door:opened: the hydraulic door at the door (positional; blast doors heavier), zone:activated:
 *   a distant swell (music bus, merged per door).
 * - box:opened: lid + music-box roll at the box; box:resolved: resolve or anomaly sting there;
 *   box:moved: the arrival burst at the new location (read from the box source).
 * - perk machines: a quiet positional hum loop for the nearest machines only (hysteresis), now and
 *   then their jingle when the player stands close; perk:acquired: the acquire sting (2D) and the
 *   perk's jingle from its machine a moment later; perk:lost: a glitch; player:revived: the
 *   Phoenix revive.
 * - powerup:spawned: a positional shimmer + a quiet loop while the pickup floats (faded out when
 *   it is collected or despawns); powerup:collected: a stinger per type;
 *   the last seconds of timed power-ups tick (polled from the power-up source), powerup:expired:
 *   a power-down.
 * - seal:broken / seal:repaired: crackle / zap at the bar (token bucket: the carpenter restores
 *   every seal in one tick).
 * Losses (perk:lost, powerup:expired, ticks) are silent while the player is dead: a run reset
 * clears perks and power-ups behind the game over screen. Payloads are reused: positions are
 * copied, nothing is kept by reference. No allocation per event or frame (fixed tables).
 */
import type { PlayOptions } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { AUDIO } from '../defs/audio';
import { POWERUPS, getPowerUpDef } from '../defs/powerups';
import type { LoopOptions } from './AudioEngine';
import type { AudioBridgeTarget } from './AudioEventBridge';

const EA = AUDIO.economy;

/** World anchors the economy sounds play at (Game wires them from the interactables). */
export interface EconomyAudioSources {
  doors?: readonly { readonly id: string; readonly position: Vec3Like; readonly blast: boolean }[];
  perkMachines?: readonly { readonly perkId: string; readonly position: Vec3Like }[];
  /** The Rift-Kiste: its current location (box:moved plays the arrival there). */
  box?: { readonly location: { readonly position: Vec3Like } } | null;
  /** Timed power-up clock (expiry ticks); PowerUpSystem fits. */
  powerUps?: { readonly activeTimed: readonly string[]; remaining(type: string): number } | null;
}

// ---------------------------------------------------------------------------
// Id mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

export function powerUpStingerId(type: string): string {
  return EA.powerUps.stingers[type] ?? EA.powerUps.defaultStinger;
}

export function perkJingleId(perkId: string): string {
  return `${EA.perks.jinglePrefix}${perkId}`;
}

export function doorSoundId(blast: boolean): string {
  return blast ? EA.door.blastId : EA.door.id;
}

/** Points tick pitch: a little higher for bigger earnings (+pitchPerDecade per ×10 over pitchFrom). */
export function pointsTickPitch(delta: number): number {
  const T = EA.pointsTick;
  if (!(delta > T.pitchFrom)) return 1;
  return 1 + T.pitchPerDecade * Math.min(T.pitchMaxDecades, Math.log10(delta / T.pitchFrom));
}

/** Seconds a pickup of `type` floats before it despawns (game time). */
export function pickupLifetime(type: string): number {
  const def = getPowerUpDef(type);
  return def && def.lifetime > 0 ? def.lifetime : POWERUPS.pickup.lifetime;
}

/**
 * The engine's safety stop of a pickup loop (maxDuration, audio clock – a hard cut). A loop fades
 * out when its pickup is collected or despawns (game time, update()); the safety stop only ends
 * one whose pickup vanished without an event, and it is generous because game time can run slower
 * than the audio clock (capped frame time, slow motion).
 */
export function pickupLoopSeconds(type: string): number {
  return pickupLifetime(type) * EA.powerUps.loop.safetyScale + POWERUPS.pickup.collectTime;
}

// ---------------------------------------------------------------------------

interface PickupLoop {
  handle: number;
  type: string;
  /** An uncounted perk scrap: replaced before real drops when the pool is full. */
  scrap: boolean;
  x: number;
  y: number;
  z: number;
  /** Game time the pickup despawns (the loop fades out then). */
  ends: number;
}

export class EconomyAudio {
  private readonly offs: (() => void)[] = [];
  private readonly opts: PlayOptions = {};
  private readonly posOpts: PlayOptions & { position: Vec3Like } = { position: { x: 0, y: 0, z: 0 } };
  private readonly loopOpts: LoopOptions & { position: Vec3Like } = { position: { x: 0, y: 0, z: 0 } };
  private doors: NonNullable<EconomyAudioSources['doors']> = [];
  private machines: NonNullable<EconomyAudioSources['perkMachines']> = [];
  private box: EconomyAudioSources['box'] = null;
  private powerUps: EconomyAudioSources['powerUps'] = null;

  private gameTime = 0;
  private dead = false;
  private revivedAt = Number.NEGATIVE_INFINITY;
  private lastTickAt = Number.NEGATIVE_INFINITY;
  private lastDeniedAt = Number.NEGATIVE_INFINITY;
  private lastFocusAt = Number.NEGATIVE_INFINITY;
  private lastZoneAt = Number.NEGATIVE_INFINITY;
  private focusId: string | null = null;
  private readonly boxPos = { x: 0, y: 0, z: 0, known: false };
  // Seal token bucket (wall clock).
  private sealTokens: number = EA.seals.burst;
  private sealLast = Number.NaN;
  // Perk machine hums.
  private humHandles = new Int32Array(0);
  private humDist = new Float64Array(0);
  private nextIdle = new Float64Array(0);
  private humCheck = 0;
  // Pending jingle after a purchase.
  private jingleId = '';
  private jingleDue = Number.POSITIVE_INFINITY;
  private readonly jinglePos = { x: 0, y: 0, z: 0 };
  private jingleAt = false;
  // Pickup loops.
  private readonly loops: PickupLoop[] = [];
  /** Last ticked second per timed power-up type (0 = none). */
  private readonly tickSecond = new Map<string, number>();
  private readonly listener = { x: 0, y: 0, z: 0 };
  private hasListener = false;

  constructor(
    events: EventBus<GameEvents>,
    private readonly audio: AudioBridgeTarget,
    private readonly now: () => number,
    private readonly random: () => number,
  ) {
    for (let i = 0; i < EA.powerUps.maxLoops; i++) {
      this.loops.push({ handle: 0, type: '', scrap: false, x: 0, y: 0, z: 0, ends: 0 });
    }
    this.offs.push(
      events.on('economy:points', (e) => {
        if (!(e.delta > 0) || e.reason === 'dev' || e.reason === 'purchase') return;
        const now = this.now();
        const T = EA.pointsTick;
        if (now - this.lastTickAt < T.minInterval) return;
        this.lastTickAt = now;
        this.play(T.id, T.gain, T.pitchVariance, 'ui', pointsTickPitch(e.delta));
      }),
      events.on('economy:purchase', (e) => {
        if (e.ok) {
          this.play(EA.purchase.id, EA.purchase.gain, 0, 'ui');
          return;
        }
        const now = this.now();
        if (now - this.lastDeniedAt < EA.denied.minInterval) return;
        this.lastDeniedAt = now;
        this.play(EA.denied.id, EA.denied.gain, 0, 'ui');
      }),
      events.on('interact:focus', (e) => {
        const id = e.prompt ? e.id : null;
        if (id === this.focusId) return;
        this.focusId = id;
        if (id === null) return;
        const now = this.now();
        if (now - this.lastFocusAt < EA.focus.minInterval) return;
        this.lastFocusAt = now;
        this.play(EA.focus.id, EA.focus.gain, 0, 'ui');
      }),
      events.on('door:opened', (e) => {
        const D = EA.door;
        const door = this.doors.find((d) => d.id === e.doorId);
        if (door) this.playAt(doorSoundId(door.blast), door.position, D.gain, D.pitchVariance);
        else this.play(D.id, D.gain, D.pitchVariance);
      }),
      events.on('zone:activated', () => {
        const now = this.now();
        if (now - this.lastZoneAt < EA.zone.mergeSeconds) return;
        this.lastZoneAt = now;
        this.play(EA.zone.id, EA.zone.gain, 0, 'music');
      }),
      events.on('box:opened', (e) => {
        const b = this.boxPos;
        b.x = e.position.x;
        b.y = e.position.y;
        b.z = e.position.z;
        b.known = true;
        const B = EA.box;
        this.playAt(B.open, b, B.gain, 0);
        this.playAt(B.roll, b, B.rollGain, 0);
      }),
      events.on('box:resolved', (e) => {
        const B = EA.box;
        const id = e.weaponId === null ? B.anomaly : B.resolve;
        if (this.boxPos.known) this.playAt(id, this.boxPos, B.gain, 0);
        else this.play(id, B.gain, 0);
      }),
      events.on('box:moved', () => {
        const p = this.box?.location.position;
        if (!p) return;
        const b = this.boxPos;
        b.x = p.x;
        b.y = p.y;
        b.z = p.z;
        b.known = true;
        this.playAt(EA.box.arrive, b, EA.box.gain, 0);
      }),
      events.on('perk:acquired', (e) => {
        const P = EA.perks;
        this.play(P.acquire.id, P.acquire.gain, 0);
        this.scheduleJingle(e.perkId);
      }),
      events.on('perk:lost', () => {
        // The revive plays its own sound for the consumed Phoenix implant.
        if (this.dead || this.now() - this.revivedAt < EA.perks.lost.afterReviveSeconds) return;
        this.play(EA.perks.lost.id, EA.perks.lost.gain, 0);
      }),
      events.on('player:revived', () => {
        this.revivedAt = this.now();
        this.play(EA.perks.revive.id, EA.perks.revive.gain, 0);
      }),
      events.on('player:died', () => {
        this.dead = true;
      }),
      // A new run's health reset (after its perks and power-ups were cleared) ends the silence.
      events.on('player:healthChanged', (e) => {
        if (this.dead && e.health > 0) this.dead = false;
      }),
      events.on('powerup:spawned', (e) => this.onPickupSpawned(e.type, e.position)),
      events.on('powerup:collected', (e) => {
        this.stopPickupLoop(e.type, e.position);
        this.play(powerUpStingerId(e.type), EA.powerUps.stingerGain, 0);
        this.tickSecond.delete(e.type);
      }),
      events.on('powerup:expired', (e) => {
        this.tickSecond.delete(e.type);
        if (this.dead) return;
        this.play(EA.powerUps.expire.id, EA.powerUps.expire.gain, 0);
      }),
      events.on('seal:broken', (e) => {
        const S = EA.seals;
        if (this.takeSealToken()) this.playAt(S.break, e.position, S.breakGain, S.pitchVariance);
      }),
      events.on('seal:repaired', (e) => {
        const S = EA.seals;
        if (this.takeSealToken()) this.playAt(S.repair, e.position, S.repairGain, S.pitchVariance);
      }),
    );
  }

  setSources(s: EconomyAudioSources): void {
    this.stopHums();
    if (s.doors !== undefined) this.doors = s.doors;
    if (s.perkMachines !== undefined) {
      this.machines = s.perkMachines;
      const n = s.perkMachines.length;
      this.humHandles = new Int32Array(n);
      this.humDist = new Float64Array(n);
      this.nextIdle = new Float64Array(n).fill(Number.NaN);
    }
    if (s.box !== undefined) this.box = s.box;
    if (s.powerUps !== undefined) this.powerUps = s.powerUps;
    this.humCheck = 0;
  }

  /** Per frame (game dt) with the listener position: hums, idle/pending jingles, expiry ticks. */
  update(dt: number, listener: Vec3Like | null): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this.gameTime += dt;
    if (listener) {
      this.listener.x = listener.x;
      this.listener.y = listener.y;
      this.listener.z = listener.z;
      this.hasListener = true;
    }
    if (this.gameTime >= this.jingleDue) this.playPendingJingle();
    this.humCheck -= dt;
    if (this.humCheck <= 0) {
      this.humCheck = EA.perks.hum.checkInterval;
      this.updateHums();
    }
    this.updateTicks();
    // Pickups that despawned uncollected (no event): their loops fade out with them.
    for (const l of this.loops) {
      if (l.handle === 0 || this.gameTime < l.ends) continue;
      this.audio.stopLoop(l.handle, EA.powerUps.loop.fadeOut);
      l.handle = 0;
    }
  }

  /**
   * New run (the bridge forwards run:restart and Game's reset): pickup loops stopped, pending
   * sounds dropped; the machine hums stay.
   */
  resetRun(): void {
    for (const l of this.loops) {
      if (l.handle !== 0) this.audio.stopLoop(l.handle, EA.powerUps.loop.fadeOut);
      l.handle = 0;
    }
    this.jingleDue = Number.POSITIVE_INFINITY;
    this.tickSecond.clear();
    this.focusId = null;
    this.revivedAt = Number.NEGATIVE_INFINITY;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.resetRun();
    this.stopHums();
  }

  /** Machine hums playing right now (tests / debug). */
  get activeHums(): number {
    let n = 0;
    for (let i = 0; i < this.humHandles.length; i++) if (this.humHandles[i]! > 0) n++;
    return n;
  }

  /** Pickup loops playing right now (tests / debug). */
  get activePickupLoops(): number {
    let n = 0;
    for (const l of this.loops) if (l.handle !== 0) n++;
    return n;
  }

  // -------------------------------------------------------------------------

  private scheduleJingle(perkId: string): void {
    this.jingleId = perkJingleId(perkId);
    this.jingleDue = this.gameTime + EA.perks.jingleDelay;
    const m = this.machines.find((x) => x.perkId === perkId);
    this.jingleAt = m !== undefined;
    if (m) {
      this.jinglePos.x = m.position.x;
      this.jinglePos.y = m.position.y;
      this.jinglePos.z = m.position.z;
    }
  }

  private playPendingJingle(): void {
    this.jingleDue = Number.POSITIVE_INFINITY;
    const P = EA.perks;
    if (this.jingleAt) this.playAt(this.jingleId, this.jinglePos, P.jingleGain, 0);
    else this.play(this.jingleId, P.jingleGain, 0);
  }

  private updateHums(): void {
    const n = this.machines.length;
    if (n === 0 || !this.hasListener) return;
    const H = EA.perks.hum;
    const L = this.listener;
    for (let i = 0; i < n; i++) {
      const p = this.machines[i]!.position;
      this.humDist[i] = Math.hypot(p.x - L.x, p.y - L.y, p.z - L.z);
    }
    // The `maxVoices` nearest within reach may hum: playing ones up to stopDistance, new ones
    // from startDistance on (hysteresis).
    for (let i = 0; i < n; i++) {
      const d = this.humDist[i]!;
      const playing = this.humHandles[i]! > 0;
      let nearer = 0;
      for (let k = 0; k < n; k++)
        if (k !== i && (this.humDist[k]! < d || (this.humDist[k] === d && k < i))) nearer++;
      const keep = nearer < H.maxVoices && d <= (playing ? H.stopDistance : H.startDistance);
      if (playing && !keep) {
        this.audio.stopLoop(this.humHandles[i]!, H.fadeOut);
        this.humHandles[i] = 0;
      } else if (!playing && keep) {
        const o = this.loopOpts;
        o.position.x = this.machines[i]!.position.x;
        o.position.y = this.machines[i]!.position.y;
        o.position.z = this.machines[i]!.position.z;
        o.volume = H.gain;
        o.bus = 'sfx';
        o.fadeIn = H.fadeIn;
        o.maxDuration = 0;
        o.pitch = 1;
        o.pitchVariance = 0;
        // 0 while the engine cannot play yet: retried on the next check.
        this.humHandles[i] = this.audio.startLoop(H.id, o);
      }
      this.updateIdleJingle(i, d);
    }
  }

  private updateIdleJingle(i: number, d: number): void {
    const J = EA.perks.idleJingle;
    if (d > J.distance) {
      this.nextIdle[i] = Number.NaN;
      return;
    }
    const [lo, hi] = J.interval;
    // Coming close starts a random wait, so walking past does not trigger it at once.
    if (Number.isNaN(this.nextIdle[i]!)) {
      this.nextIdle[i] = this.gameTime + lo * J.firstWait + (hi - lo) * this.random();
      return;
    }
    if (this.gameTime < this.nextIdle[i]!) return;
    this.nextIdle[i] = this.gameTime + lo + (hi - lo) * this.random();
    const m = this.machines[i]!;
    this.playAt(perkJingleId(m.perkId), m.position, J.gain, 0);
  }

  private stopHums(): void {
    for (let i = 0; i < this.humHandles.length; i++) {
      if (this.humHandles[i]! > 0) this.audio.stopLoop(this.humHandles[i]!, EA.perks.hum.fadeOut);
      this.humHandles[i] = 0;
    }
  }

  private updateTicks(): void {
    const src = this.powerUps;
    if (!src || this.dead) return;
    const T = EA.powerUps.tick;
    const list = src.activeTimed;
    for (let i = 0; i < list.length; i++) {
      const type = list[i]!;
      const left = src.remaining(type);
      if (!(left > 0) || left > T.seconds) {
        if (left > T.seconds) this.tickSecond.delete(type);
        continue;
      }
      const s = Math.ceil(left - 1e-6);
      if (this.tickSecond.get(type) === s) continue;
      this.tickSecond.set(type, s);
      this.play(T.id, T.gain, 0, 'ui', 1 + (T.seconds - s) * T.pitchStep);
    }
  }

  private onPickupSpawned(type: string, position: Vec3Like): void {
    const P = EA.powerUps;
    this.playAt(P.spawn.id, position, P.spawn.gain, 0);
    // A free slot, else the pickup the power-up system replaces in its full pool (it sends no
    // event for it): a scrap before a real drop, then the one closest to despawning.
    let slot: PickupLoop | null = null;
    for (const l of this.loops) {
      if (l.handle === 0) {
        slot = l;
        break;
      }
      if (!slot || (l.scrap && !slot.scrap) || (l.scrap === slot.scrap && l.ends < slot.ends)) slot = l;
    }
    if (!slot) return;
    if (slot.handle !== 0) this.audio.stopLoop(slot.handle, P.loop.fadeOut);
    const o = this.loopOpts;
    o.position.x = position.x;
    o.position.y = position.y;
    o.position.z = position.z;
    o.volume = P.loop.gain;
    o.bus = 'sfx';
    o.fadeIn = P.loop.fadeIn;
    o.pitch = 1;
    o.pitchVariance = 0;
    o.maxDuration = pickupLoopSeconds(type);
    slot.handle = this.audio.startLoop(P.loop.id, o);
    slot.type = type;
    slot.scrap = getPowerUpDef(type)?.counted === false;
    slot.x = position.x;
    slot.y = position.y;
    slot.z = position.z;
    slot.ends = this.gameTime + pickupLifetime(type);
  }

  private stopPickupLoop(type: string, p: Vec3Like): void {
    const r = EA.powerUps.matchDistance;
    for (const l of this.loops) {
      if (l.handle === 0 || l.type !== type) continue;
      if (Math.abs(l.x - p.x) > r || Math.abs(l.y - p.y) > r || Math.abs(l.z - p.z) > r) continue;
      this.audio.stopLoop(l.handle, EA.powerUps.loop.fadeOut);
      l.handle = 0;
      return;
    }
  }

  private takeSealToken(): boolean {
    const S = EA.seals;
    const now = this.now();
    if (Number.isFinite(this.sealLast) && now > this.sealLast) {
      this.sealTokens = Math.min(S.burst, this.sealTokens + (now - this.sealLast) * S.refillPerSecond);
    }
    this.sealLast = now;
    if (this.sealTokens < 1) return false;
    this.sealTokens -= 1;
    return true;
  }

  private play(
    id: string,
    volume: number,
    pitchVariance: number,
    bus: PlayOptions['bus'] = 'sfx',
    pitch = 1,
  ): void {
    const o = this.opts;
    o.volume = volume;
    o.pitchVariance = pitchVariance;
    o.bus = bus;
    o.pitch = pitch;
    this.audio.play(id, o);
  }

  private playAt(id: string, position: Vec3Like, volume: number, pitchVariance: number): void {
    const o = this.posOpts;
    o.position.x = position.x;
    o.position.y = position.y;
    o.position.z = position.z;
    o.volume = volume;
    o.pitchVariance = pitchVariance;
    o.pitch = 1;
    o.bus = 'sfx';
    this.audio.play(id, o);
  }
}
