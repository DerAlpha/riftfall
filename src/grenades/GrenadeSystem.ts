/**
 * Grenades (GrenadeApi, M5): Frag, Brand, Kryo and Singularität (defs/grenades.ts).
 *
 * Throwing (GRENADE_RULES): pressing 'grenade' primes the selected type (pin pulled), RELEASE
 * throws – a tap lobs it short and high, holding for `windup` s throws it at full strength (the
 * strength eases in between); `maxHold` s throws it by itself. No cooking: the fuse starts at the
 * throw. Throws are at least `interval` apart (a press during it primes, the throw waits).
 * Weapons stay usable meanwhile (an off-hand throw: the viewmodel animator plays its dip on
 * grenade:thrown).
 *
 * The flight is a ProjectileApi projectile simulated from the RENDERED camera (WYSIWYG like every
 * shot) along the view pitched up (grenadeMath.throwLaunch), with the thrower's velocity added,
 * and drawn from the off hand (`visualFrom`). Its blasts and fields carry weaponId `grenade.<id>`
 * (source 'player'); a direct enemy hit detonates it at once (ProjectileSystem rule).
 * `detonationStatus` (kryo): on its projectile:impact detonation the grenade queues a status
 * burst – every enemy within its radius with line of sight gets the build-up on the next tick
 * (StatusEffectsApi; outside the projectile step, no nested raycasts in its event).
 *
 * Counts per type (≤ max). The run starts with the loadout's grenades; the Max-Ammo power-up
 * (powerup:collected of a def with a 'maxAmmo' effect) refills every carried type. When the
 * selected type runs dry, the next carried type with grenades left is selected.
 *
 * Timing: fixedUpdate after the weapons (input edges latched once per frame, like the weapons –
 * update() latches the presses of frames that ran no tick). Events: grenade:thrown (the hand
 * position), grenade:changed (selection or count). Nothing allocates per tick.
 */
import { Vector3 } from 'three';
import type {
  CombatWorldApi,
  DamageSource,
  Damageable,
  GrenadeApi,
  InputApi,
  ProjectileApi,
  ProjectileSpawnOptions,
  StatusEffectsApi,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { DamageElement, GameEvents, Vec3Like } from '../core/events';
import { createLogger } from '../core/log';
import { GRENADE_IDS, GRENADE_RULES, getGrenadeDef, grenadeByWeaponId, type GrenadeDef } from '../defs/grenades';
import { getPowerUpDef } from '../defs/powerups';
import { handPosition, throwLaunch, throwStrength } from './grenadeMath';

const log = createLogger('grenades');

export interface GrenadeThrower {
  /** Look (rad; yaw 0 looks down −Z, + = up). */
  readonly yaw: number;
  readonly pitch: number;
  /** m/s (live vector). */
  readonly velocity: Vec3Like;
}

export interface GrenadeStart {
  readonly id: string;
  readonly count: number;
}

export interface GrenadeSystemDeps {
  events: EventBus<GameEvents>;
  input: Pick<InputApi, 'isDown' | 'pressed'>;
  projectiles: Pick<ProjectileApi, 'spawn'>;
  player: GrenadeThrower;
  /** The rendered camera position (throws start where the player sees from). */
  eye: () => Vec3Like;
  /** Movement-driven view pitch (landing dip, mantle) the camera adds to the aim (rad). */
  aimPitchOffset?: () => number;
  /** Detonation status bursts (kryo): enemies in reach and their build-up. */
  combat?: Pick<CombatWorldApi, 'queryRadius' | 'lineOfSight'> | null;
  status?: Pick<StatusEffectsApi, 'applyElement'> | null;
  /** Throwing allowed (alive, not in the death sequence); default always. */
  enabled?: () => boolean;
  /** A press with nothing to throw (HUD denial flash). */
  onDeny?: () => void;
  /** Grenades of a new run (default GRENADE_RULES.start). */
  start?: GrenadeStart | null;
}

interface Burst {
  active: boolean;
  readonly position: Vector3;
  def: GrenadeDef | null;
}

const _eye = new Vector3();
const _dir = { x: 0, y: 0, z: -1 };
const _hand = new Vector3();
const _inherit = new Vector3();

export class GrenadeSystem implements GrenadeApi {
  readonly stats = { thrown: 0, refused: 0, bursts: 0 };

  private readonly events: EventBus<GameEvents>;
  private readonly deps: GrenadeSystemDeps;
  /** Counts by GRENADE_IDS index. */
  private readonly counts: number[] = GRENADE_IDS.map(() => 0);
  private readonly carried: boolean[] = GRENADE_IDS.map(() => false);
  private selectedIndex = 0;
  private start: GrenadeStart;

  // --- throw state ---
  private primed = false;
  private releasing = false;
  private holdTime = 0;
  private cooldown = 0;

  // --- input (edges latched once per frame) ---
  private held = false;
  private latched = false;
  private edgeFrame = -1;
  private inputFrame = 0;

  private readonly bursts: Burst[] = [];
  private readonly targets: Damageable[] = [];
  private readonly source: DamageSource = {
    weaponId: '',
    source: 'player',
    damage: 0,
    element: 'physical',
    headMultiplier: 1,
    weakpointMultiplier: 1,
    statusBuildup: 0,
    special: null,
    areaScale: 1,
  };
  private readonly spawnOpts: ProjectileSpawnOptions;
  private readonly thrownPayload: GameEvents['grenade:thrown'] = { grenadeId: '', position: { x: 0, y: 0, z: 0 } };
  private readonly changedPayload: GameEvents['grenade:changed'] = { grenadeId: '', count: 0, max: 0 };
  private readonly unsubs: (() => void)[] = [];

  constructor(deps: GrenadeSystemDeps) {
    this.deps = deps;
    this.events = deps.events;
    this.start = validStart(deps.start) ?? GRENADE_RULES.start;
    const first = getGrenadeDef(GRENADE_IDS[0]!)!;
    this.spawnOpts = {
      origin: _eye,
      direction: _dir,
      def: first.projectile,
      damage: this.source,
      inherit: _inherit,
      speedScale: 1,
      visualFrom: _hand,
    };
    for (let i = 0; i < GRENADE_RULES.maxPendingBursts; i++) {
      this.bursts.push({ active: false, position: new Vector3(), def: null });
    }
    this.unsubs.push(
      this.events.on('projectile:impact', (e) => {
        if (!e.detonated) return;
        const def = grenadeByWeaponId(e.weaponId);
        if (def?.detonationStatus) this.queueBurst(def, e.position);
      }),
      this.events.on('powerup:collected', (e) => {
        if (getPowerUpDef(e.type)?.effect.kind === 'maxAmmo') this.refill();
      }),
    );
    this.applyStart();
  }

  // -------------------------------------------------------------------------
  // GrenadeApi
  // -------------------------------------------------------------------------

  get selected(): string {
    return GRENADE_IDS[this.selectedIndex]!;
  }

  count(grenadeId: string): number {
    const i = indexOf(grenadeId);
    return i < 0 ? 0 : this.counts[i]!;
  }

  max(grenadeId: string): number {
    return getGrenadeDef(grenadeId)?.max ?? 0;
  }

  /** Types the player carries this run (picked up or started with), in HUD order. Allocates. */
  get carriedTypes(): string[] {
    return GRENADE_IDS.filter((_, i) => this.carried[i]);
  }

  /** 0..1 strength of the primed throw (0 while not primed): HUD wind-up. */
  get primeAmount(): number {
    return this.primed ? throwStrength(this.holdTime, GRENADE_RULES.windup) : 0;
  }

  get isPrimed(): boolean {
    return this.primed;
  }

  add(grenadeId: string, n: number): number {
    const i = indexOf(grenadeId);
    if (i < 0 || !(n > 0)) return 0;
    const def = getGrenadeDef(grenadeId)!;
    const room = Math.max(0, def.max - this.counts[i]!);
    const added = Math.min(room, Math.floor(n));
    this.carried[i] = true;
    this.counts[i] = this.counts[i]! + added;
    // Nothing left of the selected type: the new grenades are the ones in hand.
    if (i !== this.selectedIndex && this.counts[this.selectedIndex]! <= 0 && this.counts[i]! > 0) {
      this.selectedIndex = i;
    }
    this.emitChanged();
    return added;
  }

  refill(): void {
    for (let i = 0; i < GRENADE_IDS.length; i++) {
      if (!this.carried[i]) continue;
      this.counts[i] = getGrenadeDef(GRENADE_IDS[i]!)!.max;
    }
    this.emitChanged();
  }

  select(grenadeId: string): void {
    const i = indexOf(grenadeId);
    if (i < 0) return;
    this.carried[i] = true;
    if (i === this.selectedIndex) return;
    this.selectedIndex = i;
    // A primed grenade of the old type goes back unthrown.
    this.primed = false;
    this.releasing = false;
    this.emitChanged();
  }

  fixedUpdate(dt: number): void {
    if (!(dt > 0)) return;
    this.flushBursts();
    this.sampleInput();
    const pressed = this.latched;
    this.latched = false;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.deps.enabled && !this.deps.enabled()) {
      this.primed = false;
      this.releasing = false;
      return;
    }
    if (pressed && !this.primed) {
      if (this.counts[this.selectedIndex]! > 0) {
        this.primed = true;
        this.releasing = false;
        this.holdTime = 0;
      } else this.deps.onDeny?.();
    }
    if (!this.primed) return;
    if (this.held && !this.releasing) this.holdTime += dt;
    if (!this.held || this.holdTime >= GRENADE_RULES.maxHold) this.releasing = true;
    if (this.releasing && this.cooldown <= 0) this.throwPrimed();
  }

  /** Per frame: latches presses of frames that ran no tick. */
  update(_dt: number): void {
    this.sampleInput();
    this.inputFrame++;
  }

  /**
   * Throw the selected grenade now at `strength` (0 lob .. 1 full; dev console, tests), ignoring
   * the throw interval. False when none is left or the projectile pool refused it.
   */
  throwNow(strength = 1): boolean {
    return this.launch(strength);
  }

  /** New run: the loadout's grenades, nothing primed, no pending bursts. */
  reset(): void {
    this.primed = false;
    this.releasing = false;
    this.holdTime = 0;
    this.cooldown = 0;
    this.latched = false;
    for (const b of this.bursts) {
      b.active = false;
      b.def = null;
    }
    this.applyStart();
  }

  /** Grenades of the next run (map loadout); applied by reset(). null = GRENADE_RULES.start. */
  setStart(start: GrenadeStart | null): void {
    this.start = validStart(start) ?? GRENADE_RULES.start;
  }

  /** Re-announce the selection (HUD after it was built). */
  announce(): void {
    this.emitChanged();
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private applyStart(): void {
    this.counts.fill(0);
    this.carried.fill(false);
    const i = indexOf(this.start.id);
    this.selectedIndex = Math.max(0, i);
    if (i >= 0) {
      this.carried[i] = true;
      this.counts[i] = Math.min(getGrenadeDef(this.start.id)!.max, Math.max(0, Math.floor(this.start.count)));
    }
    this.emitChanged();
  }

  private sampleInput(): void {
    const input = this.deps.input;
    this.held = input.isDown('grenade');
    if (this.edgeFrame === this.inputFrame) return;
    if (!input.pressed('grenade')) return;
    this.edgeFrame = this.inputFrame;
    this.latched = true;
  }

  private throwPrimed(): void {
    const strength = throwStrength(this.holdTime, GRENADE_RULES.windup);
    this.primed = false;
    this.releasing = false;
    this.holdTime = 0;
    if (this.launch(strength)) this.cooldown = GRENADE_RULES.interval;
  }

  private launch(strength: number): boolean {
    const i = this.selectedIndex;
    const id = GRENADE_IDS[i]!;
    const def = getGrenadeDef(id);
    if (!def || this.counts[i]! <= 0) return false;
    const R = GRENADE_RULES;
    const p = this.deps.player;
    const eye = this.deps.eye();
    if (!Number.isFinite(eye.x) || !Number.isFinite(eye.y) || !Number.isFinite(eye.z)) return false;
    _eye.set(eye.x, eye.y, eye.z);
    const offset = this.deps.aimPitchOffset?.() ?? 0;
    const pitch = p.pitch + (Number.isFinite(offset) ? offset : 0);
    const speedScale = throwLaunch(p.yaw, pitch, strength, R, _dir);
    handPosition(_eye, p.yaw, pitch, R.hand, _hand);
    const v = p.velocity;
    _inherit.set(v.x, v.y, v.z).multiplyScalar(R.inheritVelocity);
    if (!Number.isFinite(_inherit.x) || !Number.isFinite(_inherit.y) || !Number.isFinite(_inherit.z)) {
      _inherit.set(0, 0, 0);
    }
    const src = this.source;
    src.weaponId = def.weaponId;
    src.element = blastElement(def);
    const opts = this.spawnOpts;
    opts.def = def.projectile;
    opts.speedScale = speedScale;
    if (this.deps.projectiles.spawn(opts) === 0) {
      this.stats.refused++;
      log.warn(`Grenade "${id}" refused (projectile pool full)`);
      return false;
    }
    this.stats.thrown++;
    this.counts[i] = this.counts[i]! - 1;
    const e = this.thrownPayload;
    e.grenadeId = id;
    e.position.x = _hand.x;
    e.position.y = _hand.y;
    e.position.z = _hand.z;
    this.events.emit('grenade:thrown', e);
    if (this.counts[i]! <= 0) this.selectNextCarried();
    this.emitChanged();
    return true;
  }

  /** The next carried type with grenades left (after the selected one), if any. */
  private selectNextCarried(): void {
    const n = GRENADE_IDS.length;
    for (let k = 1; k < n; k++) {
      const j = (this.selectedIndex + k) % n;
      if (this.carried[j] && this.counts[j]! > 0) {
        this.selectedIndex = j;
        return;
      }
    }
  }

  private emitChanged(): void {
    const id = GRENADE_IDS[this.selectedIndex]!;
    const e = this.changedPayload;
    e.grenadeId = id;
    e.count = this.counts[this.selectedIndex]!;
    e.max = getGrenadeDef(id)?.max ?? 0;
    this.events.emit('grenade:changed', e);
  }

  private queueBurst(def: GrenadeDef, at: Vec3Like): void {
    if (!this.deps.status || !this.deps.combat) return;
    for (const b of this.bursts) {
      if (b.active) continue;
      b.active = true;
      b.def = def;
      b.position.set(at.x, at.y, at.z);
      return;
    }
  }

  /** Detonation status bursts queued since the last tick. */
  private flushBursts(): void {
    const status = this.deps.status;
    const combat = this.deps.combat;
    for (const b of this.bursts) {
      if (!b.active) continue;
      b.active = false;
      const def = b.def;
      b.def = null;
      const ds = def?.detonationStatus;
      if (!ds || !status || !combat || !def) continue;
      this.stats.bursts++;
      const list = combat.queryRadius(b.position, ds.radius, this.targets);
      const n = Math.min(list.length, GRENADE_RULES.maxBurstTargets);
      for (let k = 0; k < n; k++) {
        const t = list[k]!;
        if (!t.alive || t.team !== 'enemy') continue;
        if (t.boundsCenter.distanceTo(b.position) - t.boundsRadius > ds.radius) continue;
        if (!combat.lineOfSight(b.position, t.aimPoint)) continue;
        status.applyElement(t, ds.element, ds.amount, 'player', def.weaponId);
      }
      list.length = 0;
    }
  }
}

function indexOf(id: string): number {
  return (GRENADE_IDS as readonly string[]).indexOf(id);
}

function validStart(start: GrenadeStart | null | undefined): GrenadeStart | null {
  return start && indexOf(start.id) >= 0 ? start : null;
}

/** Element a grenade's damage is credited with (its blast, else its field). */
function blastElement(def: GrenadeDef): DamageElement {
  return def.projectile.explosion?.element ?? def.projectile.field?.element ?? 'physical';
}
