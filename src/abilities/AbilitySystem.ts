/**
 * Active abilities with cooldown (AbilityApi, M5): Schockwelle, Phasenbarriere, Überladung,
 * Chronofeld (defs/abilities.ts). One ability is equipped (the map loadout's, else
 * ABILITY_RULES.defaultAbility); the 'ability' action uses it when it is ready.
 *
 * A use applies whatever parts the def carries – the system never branches on an ability id:
 * - `blast`: ExplosionApi blast around the player (center `centerHeight` above the feet, source
 *   'player', weaponId `ability.<id>`, the element's status build-up; the player is spared),
 * - `modifiers`: StatModifiers with source `ability:<id>` for `duration` s (removed when the effect
 *   ends, on equip changes and on run resets),
 * - `field`: a FieldApi field at the feet; `follow` moves it with the player every tick,
 * - looks: `world` (AbilityVisuals: shock ring, time dome), `screen` / `weaponGlow` are read by the
 *   HUD and the viewmodel animator from the events.
 * The cooldown starts with the use. Events: ability:used (cooldown, duration), ability:ended
 * (effects with a duration only), ability:ready (the cooldown ran out).
 *
 * Timing: fixedUpdate after the weapons (input edges latched once per frame; update() latches the
 * presses of frames that ran no tick). Paused games freeze the cooldown (no ticks).
 */
import { Vector3 } from 'three';
import type { AbilityApi, DamageInfo, ExplosionApi, FieldApi, InputApi, StatsApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { ABILITY_IDS, ABILITY_RULES, getAbilityDef, type AbilityDef, type AbilityWorldFx } from '../defs/abilities';
import type { WeaponSpecialDef } from '../defs/weapons';
import { statusBuildupFor } from '../weapons/fire/WeaponSpecials';

/** In-world ability looks (AbilityVisuals implements it). */
export interface AbilityVisualsApi {
  /** Start `fx` at `position` (feet) for an effect of `radius` m lasting `duration` s (0 = one shot). */
  start(fx: AbilityWorldFx, position: Vec3Like, radius: number, duration: number): void;
  /** Fade `fx` out now (its effect ended early). */
  stop(fx: AbilityWorldFx): void;
  clear(): void;
}

export interface AbilitySystemDeps {
  events: EventBus<GameEvents>;
  input: Pick<InputApi, 'pressed'>;
  /** Stat modifiers of timed abilities; null = none apply. */
  stats?: Pick<StatsApi, 'addModifier' | 'removeSource'> | null;
  explosions?: Pick<ExplosionApi, 'explode'> | null;
  fields?: Pick<FieldApi, 'spawn' | 'move' | 'end'> | null;
  /** The player's feet (live vector). */
  player: { readonly position: Vec3Like };
  visuals?: AbilityVisualsApi | null;
  /** Using abilities allowed (alive, not in the death sequence); default always. */
  enabled?: () => boolean;
  /** A press while cooling down (HUD denial flash). */
  onDeny?: () => void;
  /** Equipped at start and by reset() (default ABILITY_RULES.defaultAbility; null = none). */
  ability?: string | null;
}

/** Per-ability ids (built once: no string building per use). */
const WEAPON_IDS = new Map<string, string>(ABILITY_IDS.map((id) => [id, `ability.${id}`]));
const STAT_SOURCES = new Map<string, string>(ABILITY_IDS.map((id) => [id, `ability:${id}`]));

const _at = new Vector3();

export class AbilitySystem implements AbilityApi {
  readonly stats = { used: 0, denied: 0 };

  private readonly events: EventBus<GameEvents>;
  private readonly deps: AbilitySystemDeps;
  private def: AbilityDef | null = null;
  private startAbility: string | null;
  private _cooldownLeft = 0;
  /** The running effect (null = none) and its time left. */
  private running: AbilityDef | null = null;
  private activeLeft = 0;
  private fieldId = 0;
  private modsApplied = false;

  // --- input (edges latched once per frame) ---
  private latched = false;
  private edgeFrame = -1;
  private inputFrame = 0;

  private readonly from: {
    weaponId: string;
    source: DamageInfo['source'];
    statusBuildup: number;
    special: WeaponSpecialDef | null;
    areaScale: number;
  } = { weaponId: '', source: 'player', statusBuildup: 0, special: null, areaScale: 1 };
  private readonly mod = { source: '', stat: '', op: 'mul' as 'add' | 'mul', value: 1 };
  private readonly usedPayload: GameEvents['ability:used'] = { abilityId: '', cooldown: 0, duration: 0 };
  private readonly readyPayload: GameEvents['ability:ready'] = { abilityId: '' };
  private readonly endedPayload: GameEvents['ability:ended'] = { abilityId: '' };

  constructor(deps: AbilitySystemDeps) {
    this.deps = deps;
    this.events = deps.events;
    this.startAbility = deps.ability === undefined ? ABILITY_RULES.defaultAbility : deps.ability;
    this.equip(this.startAbility);
  }

  // -------------------------------------------------------------------------
  // AbilityApi
  // -------------------------------------------------------------------------

  get equipped(): string | null {
    return this.def?.id ?? null;
  }

  /** The equipped ability's def (HUD). */
  get equippedDef(): AbilityDef | null {
    return this.def;
  }

  get cooldownLeft(): number {
    return this._cooldownLeft;
  }

  get cooldown(): number {
    return this.def?.cooldown ?? 0;
  }

  get active(): boolean {
    return this.running !== null;
  }

  /** Seconds left of the running effect (0 = none) and its full duration (HUD ring). */
  get activeTimeLeft(): number {
    return this.running ? this.activeLeft : 0;
  }

  get activeDuration(): number {
    return this.running?.duration ?? 0;
  }

  /** The def of the running effect (null = none). */
  get runningDef(): AbilityDef | null {
    return this.running;
  }

  equip(abilityId: string | null): void {
    const def = abilityId === null ? null : (getAbilityDef(abilityId) ?? null);
    if (def === this.def) return;
    this.endEffect();
    this.def = def;
    this._cooldownLeft = 0;
  }

  use(): boolean {
    const def = this.def;
    if (!def || this._cooldownLeft > 0) return false;
    if (this.deps.enabled && !this.deps.enabled()) return false;
    this.endEffect();
    this._cooldownLeft = Math.max(0, def.cooldown);
    this.stats.used++;
    const feet = this.deps.player.position;
    const blast = def.blast;
    const explosions = this.deps.explosions;
    if (blast && explosions) {
      const from = this.from;
      from.weaponId = WEAPON_IDS.get(def.id) ?? def.id;
      from.source = 'player';
      from.statusBuildup = statusBuildupFor(blast.explosion.element);
      from.special = null;
      from.areaScale = 1;
      _at.set(feet.x, feet.y + blast.centerHeight, feet.z);
      explosions.explode(_at, blast.explosion, from);
    }
    const duration = Math.max(0, def.duration);
    if (def.world && this.deps.visuals) {
      const radius = blast?.explosion.radius ?? def.field?.field.radius ?? 0;
      this.deps.visuals.start(def.world, feet, radius, duration);
    }
    if (duration > 0) {
      this.running = def;
      this.activeLeft = duration;
      this.applyModifiers(def);
      const f = def.field;
      const fields = this.deps.fields;
      if (f && fields) {
        const from = this.from;
        from.weaponId = WEAPON_IDS.get(def.id) ?? def.id;
        from.source = 'player';
        from.statusBuildup = statusBuildupFor(f.field.element);
        from.special = null;
        from.areaScale = 1;
        this.fieldId = fields.spawn(feet, f.field, from);
      }
    }
    const e = this.usedPayload;
    e.abilityId = def.id;
    e.cooldown = def.cooldown;
    e.duration = duration;
    this.events.emit('ability:used', e);
    return true;
  }

  fixedUpdate(dt: number): void {
    if (!(dt > 0)) return;
    this.sampleInput();
    const pressed = this.latched;
    this.latched = false;
    if (pressed && this.def && !this.use()) {
      this.stats.denied++;
      this.deps.onDeny?.();
    }
    if (this.running) {
      this.activeLeft -= dt;
      if (this.activeLeft <= 0) this.endEffect();
      else if (this.fieldId > 0 && this.running.field?.follow) {
        this.deps.fields?.move?.(this.fieldId, this.deps.player.position);
      }
    }
    if (this._cooldownLeft > 0) {
      this._cooldownLeft = Math.max(0, this._cooldownLeft - dt);
      if (this._cooldownLeft === 0 && this.def) {
        this.readyPayload.abilityId = this.def.id;
        this.events.emit('ability:ready', this.readyPayload);
      }
    }
  }

  /** Per frame: latches presses of frames that ran no tick. */
  update(_dt: number): void {
    this.sampleInput();
    this.inputFrame++;
  }

  /** Clear the cooldown (dev console). */
  makeReady(): void {
    this._cooldownLeft = 0;
  }

  /** New run: effect ended (stat sources removed), cooldown cleared, the loadout's ability equipped. */
  reset(): void {
    this.endEffect();
    this.latched = false;
    this.equip(this.startAbility);
    this._cooldownLeft = 0;
  }

  /** Ability of the next run (map loadout; null = none); applied by reset(). */
  setStartAbility(abilityId: string | null): void {
    this.startAbility = abilityId;
  }

  dispose(): void {
    this.endEffect();
    this.deps.visuals?.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private sampleInput(): void {
    if (this.edgeFrame === this.inputFrame) return;
    if (!this.deps.input.pressed('ability')) return;
    this.edgeFrame = this.inputFrame;
    this.latched = true;
  }

  private applyModifiers(def: AbilityDef): void {
    const stats = this.deps.stats;
    if (!stats || def.modifiers.length === 0) return;
    const m = this.mod;
    m.source = STAT_SOURCES.get(def.id) ?? def.id;
    for (const mod of def.modifiers) {
      m.stat = mod.stat;
      m.op = mod.op;
      m.value = mod.value;
      stats.addModifier(m);
    }
    this.modsApplied = true;
  }

  /** End the running effect: stat sources, field, looks; ability:ended. No-op when none runs. */
  private endEffect(): void {
    const def = this.running;
    if (!def) return;
    this.running = null;
    this.activeLeft = 0;
    if (this.modsApplied) {
      this.modsApplied = false;
      this.deps.stats?.removeSource(STAT_SOURCES.get(def.id) ?? def.id);
    }
    if (this.fieldId > 0) {
      this.deps.fields?.end?.(this.fieldId);
      this.fieldId = 0;
    }
    if (def.world) this.deps.visuals?.stop(def.world);
    this.endedPayload.abilityId = def.id;
    this.events.emit('ability:ended', this.endedPayload);
  }
}
