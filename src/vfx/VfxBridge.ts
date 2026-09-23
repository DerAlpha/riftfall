/**
 * Event → VFX wiring: weapon shots (muzzle flash, world flash light, smoke, casing), combat
 * impacts (surface effect + decal / splatter), tracers, explosions, heavy landings and the
 * graphics / accessibility settings. Weapon specifics come from the weapon defs (vfx + tracer
 * sections) – nothing here branches on a weapon id.
 * Event payloads are reused by their emitters; the VFX system copies what it keeps.
 *
 * Shot direction: combat:impact carries none, but a weapon emits weapon:fired right before it
 * traces that shot's bullets (same tick, same call chain), so shot-kind impacts of that weapon
 * travel from the fired `origin` to the impact point (ricochet sparks, splatter behind bodies).
 */
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { getWeaponDef } from '../defs/weapons';
import { IMPACT_USES_WEAPON_PROFILE, VFX } from '../defs/vfx';
import type { VfxSystem } from './VfxSystem';

const UP = { x: 0, y: 1, z: 0 };
const _shotDir = { x: 0, y: 0, z: 0 };

/** The part of VfxSystem the bridge drives (tests pass a recorder). */
export type VfxBridgeTarget = Pick<
  VfxSystem,
  | 'muzzle'
  | 'impact'
  | 'tracer'
  | 'explosion'
  | 'spawn'
  | 'applyGraphics'
  | 'applyAccessibility'
  | 'hideMuzzleFlash'
>;

export interface VfxBridgeDeps {
  events: EventBus<GameEvents>;
  vfx: VfxBridgeTarget;
}

/** Scale of the heavy-landing dust for an impact speed (m/s). */
export function landingScale(impactSpeed: number): number {
  const l = VFX.landing;
  const s = impactSpeed / l.referenceSpeed;
  return Math.min(l.maxScale, Math.max(l.minScale, Number.isFinite(s) ? s : l.minScale));
}

export class VfxBridge {
  private readonly offs: (() => void)[] = [];
  /** Last player shot (weapon + eye origin) for impact directions. */
  private shotWeapon: string | null = null;
  private readonly shotOrigin = { x: 0, y: 0, z: 0 };

  constructor(deps: VfxBridgeDeps) {
    const { events, vfx } = deps;
    this.offs.push(
      events.on('weapon:fired', (e) => {
        this.shotWeapon = e.weaponId;
        this.shotOrigin.x = e.origin.x;
        this.shotOrigin.y = e.origin.y;
        this.shotOrigin.z = e.origin.z;
        const def = getWeaponDef(e.weaponId);
        if (!def) return;
        vfx.muzzle(def.vfx.muzzle, def.vfx.muzzleLightColor, def.vfx.casing, e.ads, e.muzzle, e.direction);
      }),
      events.on('combat:impact', (e) => {
        const profile = getWeaponDef(e.weaponId)?.vfx.impact ?? null;
        vfx.impact(e.surface, profile, e.kind, e.point, e.normal, e.decal, this.shotDirection(e));
      }),
      events.on('combat:tracer', (e) => {
        const color = getWeaponDef(e.weaponId)?.tracer.color;
        vfx.tracer(e.from, e.to, color ?? VFX.tracers.defaultColor);
      }),
      events.on('combat:explosion', (e) => vfx.explosion(e.position, e.radius, e.element)),
      events.on('player:land', (e) => {
        if (e.heavy) vfx.spawn(VFX.landing.effect, e.position, UP, landingScale(e.impactSpeed));
      }),
      events.on('weapon:holsterStart', () => vfx.hideMuzzleFlash()),
      events.on('settings:changed', ({ settings, sections }) => {
        if (sections.includes('graphics')) vfx.applyGraphics(settings.graphics);
        if (sections.includes('accessibility')) vfx.applyAccessibility(settings.accessibility);
      }),
    );
  }

  /** Travel direction of a shot-kind impact of the last fired weapon (not normalized), or null. */
  private shotDirection(e: GameEvents['combat:impact']): { x: number; y: number; z: number } | null {
    if (e.weaponId !== this.shotWeapon || !IMPACT_USES_WEAPON_PROFILE[e.kind]) return null;
    _shotDir.x = e.point.x - this.shotOrigin.x;
    _shotDir.y = e.point.y - this.shotOrigin.y;
    _shotDir.z = e.point.z - this.shotOrigin.z;
    const len = Math.hypot(_shotDir.x, _shotDir.y, _shotDir.z);
    return len > 1e-6 && Number.isFinite(len) ? _shotDir : null;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
