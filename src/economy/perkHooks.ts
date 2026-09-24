/**
 * Special perk behaviour beyond stat modifiers (defs/perks.ts `hook`, tuning in PERK_TUNING). A hook
 * is created when its perk is granted and disposed on revoke: it subscribes to events, may own
 * temporary stat modifiers (source `perk:<id>:<tag>`) and ticks in PerkSystem.fixedUpdate. Hooks
 * never allocate per tick; blasts reuse module scratch.
 *
 * - nova (Nova-Schock): weapon:reloadStart → shock blast around the player, radius/damage by the
 *   magazine's missing fraction (the last weapon:ammoChanged of that weapon), with a cooldown.
 * - kinetic (Kinetikpanzer): player:land at ≥ minImpactSpeed → shock wave around the landing point
 *   (the immunity itself is plain stats).
 * - scavenger (Aasgeier): enemy:died by the player → chance (× dropChance stat) to call the
 *   `dropAmmo` hook (the power-up system spawns a small ammo pickup), with a cooldown.
 * - adrenaline (Adrenalinschub): combat:kill by the player → +1 stack of moveSpeed; stacks fall off
 *   one by one after `duration`.
 * - phoenix (Phoenix-Protokoll): a revive (PerkSystem calls `onRevived` before the perk is consumed)
 *   → a full-strength fire burst around the player, deferred to the next perk tick (the revive
 *   happens inside an enemy attack: no damage/raycasts nested in the enemy tick).
 *
 * Blasts damage enemies only (team 'enemy', static line of sight from the blast center), as
 * source 'player' – they pay points like any other player damage – and show themselves through
 * `blastFx`: Game wires createPerkBlastFx (the blast's own VFX preset, screen shockwave and sound,
 * PerkBlastDef.fx); without it a combat:explosion event (frag explosion tinted by fxElement).
 */
import type {
  AudioApi,
  CombatWorldApi,
  Damageable,
  DamageInfo,
  PlayOptions,
  StatsApi,
  VfxApi,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import type { Rng } from '../core/Rng';
import { clamp01, lerp } from '../core/math';
import { PERK_TUNING, perkSource, type PerkBlastDef, type PerkHookId } from '../defs/perks';
import type { StatSystem } from '../stats/StatSystem';

/** Stats as the perk system uses them (StatSystem satisfies it). */
export type PerkStatsApi = StatsApi & Pick<StatSystem, 'batch' | 'setSource'>;

export type PerkCombatApi = Pick<CombatWorldApi, 'queryRadius' | 'dealDamage' | 'lineOfSight'>;

/** Shows a blast of `radius` m at `position` (scratch: copy it). */
export type PerkBlastFx = (position: Vec3Like, radius: number, def: PerkBlastDef, hook: PerkHookId) => void;

export interface PerkHookContext {
  readonly events: EventBus<GameEvents>;
  readonly stats: PerkStatsApi;
  /** Blast damage; null = blasts only show their VFX. */
  readonly combat: PerkCombatApi | null;
  /** Player feet (live vector); null = no position-based effects. */
  readonly player: { readonly position: Vec3Like } | null;
  readonly rng: Rng;
  /** Blast VFX + sound (position is a scratch vector: copy it). */
  readonly blastFx: PerkBlastFx;
  /**
   * Aasgeier: the current ammo pickup spawner (the power-up system; `position` is scratch: copy
   * it), null = not wired.
   */
  readonly ammoDrop: () => ((position: Vec3Like) => void) | null;
  /** Run `fn` at the start of the next perk tick (outlives the hook: a consumed perk's last act). */
  readonly defer: (fn: () => void) => void;
}

export interface PerkHook {
  fixedUpdate?(dt: number): void;
  /** A revive charge saved the player (called before perks lost on revive are revoked). */
  onRevived?(): void;
  dispose(): void;
}

export type PerkHookFactory = (ctx: PerkHookContext, perkId: string) => PerkHook;

// ---------------------------------------------------------------------------
// Pure blast math (exported for tests)
// ---------------------------------------------------------------------------

/** Radius and damage of a blast at strength t (0..1). */
export function blastSize(def: PerkBlastDef, t: number, out: { radius: number; damage: number }): void {
  const k = clamp01(t);
  out.radius = lerp(def.radius.min, def.radius.max, k);
  out.damage = lerp(def.damage.min, def.damage.max, k);
}

/** Damage factor at `distance` from the center (full inside innerFraction × radius, minFalloff at the edge). */
export function blastFalloff(def: PerkBlastDef, distance: number, radius: number): number {
  if (!(distance <= radius) || !(radius > 0)) return 0;
  const inner = radius * def.innerFraction;
  if (distance <= inner) return 1;
  const t = (distance - inner) / (radius - inner);
  return 1 + (def.minFalloff - 1) * t;
}

/** Missing fraction of a magazine (0 = full, 1 = empty). */
export function missingFraction(mag: number, magSize: number): number {
  if (!(magSize > 0)) return 1;
  return clamp01(1 - mag / magSize);
}

const _size = { radius: 0, damage: 0 };
const _center = { x: 0, y: 0, z: 0 };
const _fx = { x: 0, y: 0, z: 0 };
const _feet = { x: 0, y: 0, z: 0 };
const _drop = { x: 0, y: 0, z: 0 };
const _hits: Damageable[] = [];
const _info: DamageInfo = {
  amount: 0,
  zone: 'body',
  point: { x: 0, y: 0, z: 0 },
  direction: { x: 0, y: 0, z: -1 },
  weaponId: '',
  element: 'physical',
  source: 'player',
  kind: 'explosion',
  impulse: 0,
};

/**
 * Damage every enemy within the blast (strength t) around `feet` + centerHeight and play its VFX at
 * `feet` + fxHeight. Returns the number of enemies hit.
 */
export function perkBlast(
  ctx: PerkHookContext,
  hook: PerkHookId,
  def: PerkBlastDef,
  feet: Vec3Like,
  t: number,
): number {
  const center = _center;
  center.x = feet.x;
  center.y = feet.y + def.centerHeight;
  center.z = feet.z;
  blastSize(def, t, _size);
  const radius = _size.radius;
  let hits = 0;
  const combat = ctx.combat;
  if (combat) {
    const list = combat.queryRadius(center, radius, _hits);
    for (let i = 0; i < list.length; i++) {
      const target = list[i]!;
      if (!target.alive || target.team !== 'enemy') continue;
      const c = target.boundsCenter;
      const dx = c.x - center.x;
      const dy = c.y - center.y;
      const dz = c.z - center.z;
      const len = Math.hypot(dx, dy, dz);
      const f = blastFalloff(def, Math.max(0, len - target.boundsRadius), radius);
      if (f <= 0 || !combat.lineOfSight(center, c)) continue;
      const info = _info;
      info.amount = _size.damage * f;
      info.zone = 'body';
      info.point.x = c.x;
      info.point.y = c.y;
      info.point.z = c.z;
      const inv = len > 1e-6 ? 1 / len : 0;
      info.direction.x = inv > 0 ? dx * inv : 0;
      info.direction.y = inv > 0 ? dy * inv : 1;
      info.direction.z = inv > 0 ? dz * inv : 0;
      info.weaponId = def.weaponId;
      info.element = def.element;
      info.source = 'player';
      info.kind = 'explosion';
      info.impulse = def.impulse * f;
      combat.dealDamage(target, info);
      hits++;
    }
    list.length = 0;
  }
  const fx = _fx;
  fx.x = feet.x;
  fx.y = feet.y + def.fxHeight;
  fx.z = feet.z;
  ctx.blastFx(fx, radius, def, hook);
  return hits;
}

export interface PerkBlastFxDeps {
  vfx: Pick<VfxApi, 'spawn'> | null;
  audio: Pick<AudioApi, 'play'> | null;
  /** Screen-space shockwave (RenderApi.addShockwave); null = none. */
  shockwave: ((position: Vec3Like, radius: number, strength: number) => void) | null;
  /**
   * Shockwave strength factor, read per blast: accessibility.screenShake (0..1, like VfxSystem's
   * explosions). Default 1.
   */
  shockwaveScale?: (() => number) | null;
}

const UP: Vec3Like = { x: 0, y: 1, z: 0 };

/** The blasts' own look and sound (PerkBlastDef.fx): VFX preset, screen shockwave, positional sound. */
export function createPerkBlastFx(deps: PerkBlastFxDeps): PerkBlastFx {
  const sound: PlayOptions & { position: Vec3Like } = {
    position: { x: 0, y: 0, z: 0 },
    volume: 1,
    pitch: 1,
    pitchVariance: 0,
    bus: 'sfx',
  };
  return (position, radius, def) => {
    const fx = def.fx;
    const scale = fx.referenceRadius > 0 ? radius / fx.referenceRadius : 1;
    deps.vfx?.spawn(fx.effect, position, UP, scale);
    const k = deps.shockwaveScale ? clamp01(deps.shockwaveScale()) : 1;
    if (fx.shockwave > 0 && k > 0) deps.shockwave?.(position, radius * fx.shockwaveRadius, fx.shockwave * k);
    if (fx.sound && deps.audio) {
      copyTo(position, sound.position);
      sound.volume = fx.volume;
      sound.pitch = fx.pitch;
      sound.pitchVariance = fx.pitchVariance;
      deps.audio.play(fx.sound, sound);
    }
  };
}

function copyTo(from: Vec3Like, to: Vec3Like): void {
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function unsubscribeAll(offs: (() => void)[]): void {
  for (const off of offs) off();
  offs.length = 0;
}

/** Nova-Schock: reload → shock blast scaled by the missing ammo. */
export const novaHook: PerkHookFactory = (ctx) => {
  const def = PERK_TUNING.nova;
  // Last known magazine per weapon (one record per weapon id, created on first sight).
  const ammo = new Map<string, { mag: number; magSize: number }>();
  let cooldown = 0;
  const offs = [
    ctx.events.on('weapon:ammoChanged', (e) => {
      const rec = ammo.get(e.weaponId);
      if (rec) {
        rec.mag = e.mag;
        rec.magSize = e.magSize;
      } else ammo.set(e.weaponId, { mag: e.mag, magSize: e.magSize });
    }),
    ctx.events.on('weapon:reloadStart', (e) => {
      const player = ctx.player;
      if (cooldown > 0 || !player) return;
      const rec = ammo.get(e.weaponId);
      const missing = e.empty || !rec ? 1 : missingFraction(rec.mag, rec.magSize);
      cooldown = def.cooldown;
      perkBlast(ctx, 'nova', def, player.position, missing);
    }),
  ];
  return {
    fixedUpdate(dt) {
      if (cooldown > 0) cooldown = Math.max(0, cooldown - dt);
    },
    dispose() {
      unsubscribeAll(offs);
      ammo.clear();
    },
  };
};

/** Kinetikpanzer: hard landings release a shock wave. */
export const kineticHook: PerkHookFactory = (ctx) => {
  const def = PERK_TUNING.kinetic;
  let cooldown = 0;
  const offs = [
    ctx.events.on('player:land', (e) => {
      if (cooldown > 0 || !(e.impactSpeed >= def.minImpactSpeed)) return;
      const t =
        (e.impactSpeed - def.minImpactSpeed) / Math.max(1e-6, def.fullImpactSpeed - def.minImpactSpeed);
      cooldown = def.cooldown;
      // The payload position is shared: copy before handlers of the blast emit again.
      _feet.x = e.position.x;
      _feet.y = e.position.y;
      _feet.z = e.position.z;
      perkBlast(ctx, 'kinetic', def, _feet, t);
    }),
  ];
  return {
    fixedUpdate(dt) {
      if (cooldown > 0) cooldown = Math.max(0, cooldown - dt);
    },
    dispose() {
      unsubscribeAll(offs);
    },
  };
};

/** Aasgeier: player kills may drop small ammo pickups (through the power-up system's hook). */
export const scavengerHook: PerkHookFactory = (ctx) => {
  const def = PERK_TUNING.scavenger;
  let cooldown = 0;
  const offs = [
    ctx.events.on('enemy:died', (e) => {
      const drop = ctx.ammoDrop();
      if (!drop || cooldown > 0 || e.source !== 'player') return;
      const chance = def.chance * Math.max(0, ctx.stats.value('dropChance'));
      if (!ctx.rng.chance(chance)) return;
      cooldown = def.cooldown;
      _drop.x = e.position.x;
      _drop.y = e.position.y;
      _drop.z = e.position.z;
      drop(_drop);
    }),
  ];
  return {
    fixedUpdate(dt) {
      if (cooldown > 0) cooldown = Math.max(0, cooldown - dt);
    },
    dispose() {
      unsubscribeAll(offs);
    },
  };
};

/** Adrenalinschub: kills stack a short move-speed buff. */
export const adrenalineHook: PerkHookFactory = (ctx, perkId) => {
  const def = PERK_TUNING.adrenaline;
  const source = `${perkSource(perkId)}:buff`;
  const mods = [{ stat: 'moveSpeed', op: 'mul' as const, value: 1 }];
  let stacks = 0;
  let timer = 0;
  const apply = (): void => {
    if (stacks <= 0) {
      ctx.stats.removeSource(source);
      return;
    }
    mods[0]!.value = 1 + def.perStack * stacks;
    ctx.stats.setSource(source, mods);
  };
  const offs = [
    ctx.events.on('combat:kill', (e) => {
      if (e.source !== 'player') return;
      const next = Math.min(def.maxStacks, stacks + 1);
      timer = def.duration;
      if (next === stacks) return;
      stacks = next;
      apply();
    }),
  ];
  return {
    fixedUpdate(dt) {
      if (stacks <= 0) return;
      timer -= dt;
      if (timer > 0) return;
      stacks--;
      timer = stacks > 0 ? def.decayInterval : 0;
      apply();
    },
    dispose() {
      unsubscribeAll(offs);
      stacks = 0;
      ctx.stats.removeSource(source);
    },
  };
};

/** Phoenix-Protokoll: the revive bursts out of the player (deferred to the perk tick). */
export const phoenixHook: PerkHookFactory = (ctx) => {
  const def = PERK_TUNING.phoenix;
  const burst = (): void => {
    const player = ctx.player;
    if (player) perkBlast(ctx, 'phoenix', def, player.position, 1);
  };
  return {
    onRevived() {
      ctx.defer(burst);
    },
    dispose() {},
  };
};

export const PERK_HOOKS: Readonly<Record<PerkHookId, PerkHookFactory>> = {
  nova: novaHook,
  kinetic: kineticHook,
  scavenger: scavengerHook,
  adrenaline: adrenalineHook,
  phoenix: phoenixHook,
};
