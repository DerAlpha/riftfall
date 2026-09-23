/**
 * Dev console commands for the VFX (register them next to registerDevCommands):
 *   vfx <preset> [scale]        spawn an effect preset where the crosshair points
 *   explode [radius] [element]  explosion where the crosshair points (emits combat:explosion, so
 *                               it runs the same VFX / SFX path as grenades and barrels will)
 *   decals [clear]              decal / particle stats, or clear all effects
 */
import * as THREE from 'three';
import type { ConsoleCommand, PhysicsApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { DamageElement, GameEvents } from '../core/events';
import { COLLISION_GROUP, interactionGroups } from '../defs/physics';
import { ELEMENT_TINTS, VFX, VFX_EFFECTS } from '../defs/vfx';
import type { VfxSystem } from './VfxSystem';

export interface VfxCommandDeps {
  vfx: Pick<VfxSystem, 'spawn' | 'clear' | 'stats'>;
  /** `explode` emits combat:explosion (VfxBridge → VFX, AudioEventBridge → sound). */
  events: Pick<EventBus<GameEvents>, 'emit'>;
  physics: Pick<PhysicsApi, 'raycast'>;
  camera: THREE.Camera;
}

const C = VFX.devCommands;
const AIM_GROUPS = interactionGroups(COLLISION_GROUP.DEBRIS, COLLISION_GROUP.WORLD | COLLISION_GROUP.PROP);

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

function aim(deps: VfxCommandDeps): { point: THREE.Vector3; normal: THREE.Vector3 } {
  deps.camera.getWorldPosition(_o);
  deps.camera.getWorldDirection(_d);
  const hit = deps.physics.raycast(_o, _d, C.aimRange, { groups: AIM_GROUPS });
  if (hit) return { point: hit.point.clone(), normal: hit.normal.clone() };
  return { point: _o.clone().addScaledVector(_d, C.missDistance), normal: _d.clone().negate() };
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Positive Zahl erwartet');
  return n;
}

export function createVfxCommands(deps: VfxCommandDeps): ConsoleCommand[] {
  const presets = Object.keys(VFX_EFFECTS);
  const elements = Object.keys(ELEMENT_TINTS) as DamageElement[];
  return [
    {
      name: 'vfx',
      description: 'Effekt-Preset am Fadenkreuz abspielen',
      usage: 'vfx <preset> [scale]',
      run: ([id, scale]) => {
        if (!id) return `Presets: ${presets.join(', ')}`;
        if (!presets.includes(id)) throw new Error(`Unbekanntes Preset "${id}"`);
        const { point, normal } = aim(deps);
        deps.vfx.spawn(id, point, normal, num(scale, 1));
        return `${id} bei ${point.x.toFixed(1)} ${point.y.toFixed(1)} ${point.z.toFixed(1)}`;
      },
      complete: ([prefix = '']) => presets.filter((p) => p.startsWith(prefix)),
    },
    {
      name: 'explode',
      description: 'Explosion am Fadenkreuz auslösen',
      usage: 'explode [radius] [element]',
      run: ([radius, element]) => {
        const el = (element ?? 'physical') as DamageElement;
        if (!elements.includes(el)) throw new Error(`Element: ${elements.join(', ')}`);
        const { point, normal } = aim(deps);
        const r = num(radius, C.explosionRadius);
        // Lift the blast off the surface so it does not sit inside the wall.
        point.addScaledVector(normal, Math.min(r * C.liftPerRadius, C.maxLift));
        deps.events.emit('combat:explosion', { position: point, radius: r, element: el });
        return `Explosion (${el}, r=${r})`;
      },
      complete: ([, prefix = '']) => elements.filter((e) => e.startsWith(prefix)),
    },
    {
      name: 'decals',
      description: 'VFX-Statistik anzeigen oder alle Effekte entfernen',
      usage: 'decals [clear]',
      run: ([cmd]) => {
        if (cmd === 'clear') {
          deps.vfx.clear();
          return 'Alle Effekte entfernt';
        }
        const s = deps.vfx.stats;
        return `Partikel ${s.particles} · Decals ${s.decals} · Lichter ${s.lights}`;
      },
    },
  ];
}
