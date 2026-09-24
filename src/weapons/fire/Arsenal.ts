/**
 * The fire-kinds engine (M5) as one unit: Explosions (ExplosionApi), FieldSystem (FieldApi),
 * ProjectileSystem (ProjectileApi) and WeaponSpecials, wired to each other (projectile
 * detonations → explosions / fields; every damage of a special-carrying source → the specials;
 * specials → explosions / fields / arc flashes).
 *
 * Game builds one and hands it to the WeaponSystem (grenades and abilities use its projectiles,
 * explosions and fields too). Ticks: `fixedUpdate` after the enemies (projectiles, then fields),
 * `update` per frame after the VFX (projectile visuals, arc flashes). The arsenal visuals start as
 * the no-op stub; `setVfx` switches every part to the real ArsenalVfxApi.
 */
import type { ArsenalVfxApi, StatusEffectsApi, WeaponCombatApi } from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { Explosions, type ExplosionPhysics, type ExplosionPlayer } from '../../combat/Explosions';
import { FieldSystem } from '../../combat/FieldSystem';
import { NULL_ARSENAL_VFX } from './nullArsenalVfx';
import { ProjectileSystem } from './ProjectileSystem';
import { WeaponSpecials } from './WeaponSpecials';

export interface ArsenalDeps {
  events: EventBus<GameEvents>;
  combat: WeaponCombatApi;
  /** Explosions push dynamic props (optional). */
  physics?: ExplosionPhysics | null;
  /** Self damage / camera shake (optional; setPlayer later). */
  player?: ExplosionPlayer | null;
  vfx?: ArsenalVfxApi | null;
  /** Lifesteal (PlayerHealth.heal). */
  heal?: ((amount: number) => number | void) | null;
  seed?: string | number;
  /** Pool sizes (default ARSENAL.*.capacity). */
  projectileCapacity?: number;
  fieldCapacity?: number;
}

export class Arsenal {
  readonly explosions: Explosions;
  readonly fields: FieldSystem;
  readonly projectiles: ProjectileSystem;
  readonly specials: WeaponSpecials;
  private _vfx: ArsenalVfxApi;

  constructor(deps: ArsenalDeps) {
    this._vfx = deps.vfx ?? NULL_ARSENAL_VFX;
    this.explosions = new Explosions({
      events: deps.events,
      combat: deps.combat,
      physics: deps.physics ?? null,
      player: deps.player ?? null,
    });
    this.fields = new FieldSystem({
      events: deps.events,
      combat: deps.combat,
      explosions: this.explosions,
      vfx: this._vfx,
      capacity: deps.fieldCapacity,
    });
    this.specials = new WeaponSpecials({
      combat: deps.combat,
      explosions: this.explosions,
      fields: this.fields,
      vfx: this._vfx,
      heal: deps.heal ?? null,
      seed: deps.seed ?? 'arsenal',
    });
    this.projectiles = new ProjectileSystem({
      events: deps.events,
      combat: deps.combat,
      explosions: this.explosions,
      fields: this.fields,
      vfx: this._vfx,
      specials: this.specials,
      capacity: deps.projectileCapacity,
    });
    this.explosions.setSpecials(this.specials);
    this.fields.setSpecials(this.specials);
  }

  /** The arsenal visuals in use (the stub until setVfx). */
  get vfx(): ArsenalVfxApi {
    return this._vfx;
  }

  /** Switch every part to `vfx` (package A3's ArsenalVfx); null = the no-op stub. */
  setVfx(vfx: ArsenalVfxApi | null): void {
    this._vfx = vfx ?? NULL_ARSENAL_VFX;
    this.fields.setVfx(this._vfx);
    this.projectiles.setVfx(this._vfx);
    this.specials.setVfx(this._vfx);
  }

  setPlayer(player: ExplosionPlayer | null): void {
    this.explosions.setPlayer(player);
  }

  /** Package B: status effects for elementProc specials. */
  setStatus(status: Pick<StatusEffectsApi, 'applyElement'> | null): void {
    this.specials.setStatus(status);
  }

  /** Fixed tick, after the enemies (their hitboxes are this tick's), before physics.step. */
  fixedUpdate(dt: number): void {
    this.projectiles.fixedUpdate(dt);
    this.fields.fixedUpdate(dt);
  }

  /** Per frame, after vfx.update: interpolated projectile visuals, arc flashes. */
  update(dt: number, alpha: number): void {
    this.projectiles.update(dt, alpha);
    this.fields.update(dt);
    this.specials.update(dt);
  }

  /** Run reset: every projectile, field and arc goes (no detonations, no collapses). */
  clear(): void {
    this.projectiles.clear();
    this.fields.clear();
    this.specials.clear();
  }

  dispose(): void {
    this.projectiles.dispose();
    this.fields.dispose();
    this.explosions.dispose();
    this.specials.clear();
  }
}
