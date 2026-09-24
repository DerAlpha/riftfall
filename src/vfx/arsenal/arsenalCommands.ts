/**
 * Dev console previews of the arsenal visuals (no weapon needed):
 *   fx projectile <visual>             fire a projectile visual along the crosshair (+ its trail,
 *                                      impact, blast and field from the preview table)
 *   fx beam <visual> [seconds]         fire a beam from the muzzle to the crosshair (lightning
 *                                      also jumps on to fake chain targets)
 *   fx field <visual> [radius] [s]     a lingering field where the crosshair points
 *   fx charge [visual]                 charge at the muzzle, then a railgun slug
 *   fx shot <visual>                   one-shot ray (beam.rail, beam.void) to the crosshair
 *   fx clear                           remove every arsenal visual
 * The preview driver runs inside ArsenalVfx.update (setPreviewDriver), so it pauses with the game.
 */
import * as THREE from 'three';
import type { ConsoleCommand, PhysicsApi, VfxSocketSource } from '../../core/contracts';
import type { Vec3Like } from '../../core/events';
import {
  ARSENAL_VFX,
  BEAM_STYLES,
  CHARGE_STYLES,
  FIELD_VISUALS,
  PROJECTILE_VISUALS,
  type PreviewProjectileDef,
} from '../../defs/arsenalVfx';
import { COLLISION_GROUP, interactionGroups } from '../../defs/physics';
import type { VfxSystem } from '../VfxSystem';
import type { ArsenalVfx } from './ArsenalVfx';

export interface ArsenalCommandDeps {
  arsenal: Pick<
    ArsenalVfx,
    | 'projectileStart'
    | 'projectileMove'
    | 'projectileEnd'
    | 'beam'
    | 'fieldStart'
    | 'charge'
    | 'shot'
    | 'clear'
    | 'setPreviewDriver'
    | 'stats'
  >;
  vfx: Pick<VfxSystem, 'spawn' | 'explosion'>;
  physics: Pick<PhysicsApi, 'raycast'>;
  camera: THREE.Camera;
  /** Viewmodel sockets (beam / charge start at the displayed muzzle). */
  sockets: () => VfxSocketSource | null;
}

const P = ARSENAL_VFX.preview;
const AIM_GROUPS = interactionGroups(COLLISION_GROUP.DEBRIS, COLLISION_GROUP.WORLD | COLLISION_GROUP.PROP);
const MAX_PROJECTILES = 12;
/** Default trail per projectile visual in the preview (the weapon data pairs them). */
const PREVIEW_TRAILS: Record<string, string> = {
  'projectile.plasma': 'trail.plasma',
  'projectile.grenade': 'trail.smoke',
  'projectile.frag': 'trail.smoke',
  'projectile.incendiary': 'trail.fire',
  'projectile.cryo': 'trail.frost',
  'projectile.singularity': 'trail.void',
  'projectile.voidorb': 'trail.void',
  'projectile.shockorb': 'trail.shock',
  'projectile.cryoorb': 'trail.frost',
};

interface PreviewProjectile {
  handle: number;
  readonly pos: THREE.Vector3;
  readonly vel: THREE.Vector3;
  life: number;
  def: PreviewProjectileDef | null;
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _step = new THREE.Vector3();
const _prev = new THREE.Vector3();

export function createArsenalCommands(deps: ArsenalCommandDeps): ConsoleCommand[] {
  const projectiles: PreviewProjectile[] = [];
  for (let i = 0; i < MAX_PROJECTILES; i++) {
    projectiles.push({ handle: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, def: null });
  }
  const beam = {
    visual: '',
    time: 0,
    arcTimer: 0,
    arcCount: 0,
    arcs: [] as THREE.Vector3[],
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
  };
  for (let i = 0; i < ARSENAL_VFX.beams.maxArcs * 2; i++) beam.arcs.push(new THREE.Vector3());
  const charge = { visual: '', time: -1 };

  /** Crosshair ray hit (or the point `range` m ahead) into `out`; returns the normal-ish direction. */
  const aim = (out: THREE.Vector3, normal?: THREE.Vector3): boolean => {
    deps.camera.getWorldPosition(_o);
    deps.camera.getWorldDirection(_d);
    const hit = deps.physics.raycast(_o, _d, P.range, { groups: AIM_GROUPS });
    if (hit) {
      out.copy(hit.point);
      normal?.copy(hit.normal);
      return true;
    }
    out.copy(_o).addScaledVector(_d, P.range);
    normal?.copy(_d).negate();
    return false;
  };
  /** The displayed muzzle, else a point ahead of and below the eye. */
  const muzzle = (out: THREE.Vector3): void => {
    const s = deps.sockets();
    if (s) s.getSocketWorldPosition('muzzle', out);
    if (!s || !Number.isFinite(out.x + out.y + out.z)) {
      deps.camera.getWorldPosition(out);
      deps.camera.getWorldDirection(_d);
      out.addScaledVector(_d, P.ahead).y -= 0.15;
    }
  };

  const impact = (p: PreviewProjectile, at: Vec3Like, normal: Vec3Like): void => {
    const def = p.def;
    if (!def) return;
    if (def.effect) deps.vfx.spawn(def.effect, at, normal, 1);
    if (def.explosion && def.radius) deps.vfx.explosion(at, def.radius, def.explosion);
    if (def.field) deps.arsenal.fieldStart(def.field, at, def.fieldRadius ?? P.fieldRadius, P.fieldSeconds);
  };

  const driver = (dt: number): void => {
    for (const p of projectiles) {
      if (p.handle === 0) continue;
      p.life -= dt;
      _prev.copy(p.pos);
      p.vel.y -= (p.def?.gravity ?? 0) * dt;
      _step.copy(p.vel).multiplyScalar(dt);
      const len = _step.length();
      const hit =
        len > 1e-6 ? deps.physics.raycast(_prev, _step.normalize(), len, { groups: AIM_GROUPS }) : null;
      if (hit || p.life <= 0) {
        if (hit) p.pos.copy(hit.point).addScaledVector(hit.normal, 0.05);
        deps.arsenal.projectileMove(p.handle, p.pos, p.vel);
        deps.arsenal.projectileEnd(p.handle);
        p.handle = 0;
        if (hit) impact(p, p.pos, hit.normal);
        continue;
      }
      p.pos.addScaledVector(p.vel, dt);
      deps.arsenal.projectileMove(p.handle, p.pos, p.vel);
    }
    if (beam.time > 0) {
      beam.time -= dt;
      muzzle(beam.from);
      aim(beam.to);
      beam.arcTimer -= dt;
      if (beam.arcTimer <= 0 && BEAM_STYLES[beam.visual as keyof typeof BEAM_STYLES]?.kind === 'lightning') {
        beam.arcTimer = P.arcInterval;
        beam.arcCount = P.arcHops;
      }
      if (beam.arcCount > 0) {
        // Chain: beam end → hop → hop …, each hop a random point around the previous one.
        let prev = beam.to;
        for (let i = 0; i < beam.arcCount; i++) {
          const a = beam.arcs[i * 2]!;
          const b = beam.arcs[i * 2 + 1]!;
          if (beam.arcTimer === P.arcInterval) {
            b.set(
              prev.x + (Math.random() * 2 - 1) * P.arcSpread,
              prev.y + Math.random() * 1.2,
              prev.z + (Math.random() * 2 - 1) * P.arcSpread,
            );
          }
          a.copy(prev);
          prev = b;
        }
      }
      deps.arsenal.beam(beam.visual, beam.from, beam.to, beam.arcs, beam.arcCount);
    }
    if (charge.time >= 0) {
      charge.time += dt;
      const amount = Math.min(1, charge.time / P.chargeSeconds);
      if (charge.time < P.chargeSeconds + P.chargeHold) {
        deps.arsenal.charge(charge.visual, amount);
      } else {
        charge.time = -1;
        muzzle(beam.from);
        const hit = aim(beam.to, _d);
        deps.arsenal.shot('beam.rail', beam.to, beam.from);
        if (hit) deps.vfx.spawn('impact.plasma', beam.to, _d, 1.4);
      }
    }
  };
  deps.arsenal.setPreviewDriver(driver);

  const kinds = ['projectile', 'beam', 'field', 'charge', 'shot', 'clear'];
  const ids: Record<string, string[]> = {
    projectile: Object.keys(PROJECTILE_VISUALS),
    beam: Object.keys(BEAM_STYLES),
    field: Object.keys(FIELD_VISUALS),
    charge: Object.keys(CHARGE_STYLES),
    shot: Object.keys(BEAM_STYLES).filter((k) => BEAM_STYLES[k as keyof typeof BEAM_STYLES].kind === 'ray'),
  };
  const full = (kind: string, id: string | undefined): string => {
    if (!id) throw new Error(`fx ${kind} <${ids[kind]!.join('|')}>`);
    const prefix = kind === 'shot' ? 'beam' : kind;
    return id.includes('.') && id.startsWith(`${prefix}.`) ? id : `${prefix}.${id}`;
  };
  const num = (v: string | undefined, fallback: number): number => {
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error('Positive Zahl erwartet');
    return n;
  };

  return [
    {
      name: 'fx',
      description: 'Arsenal-Effekte ansehen (Projektile, Strahlen, Felder, Aufladung)',
      usage: 'fx <projectile|beam|field|charge|shot|clear> [id] …',
      run: ([kind, id, a, b]) => {
        if (!kind) {
          const s = deps.arsenal.stats;
          return `Projektile ${s.projectiles} · Spuren ${s.trails} · Strahlen ${s.beams} · Felder ${s.fields}`;
        }
        switch (kind) {
          case 'projectile': {
            const visual = full(kind, id);
            const slot = projectiles.find((p) => p.handle === 0);
            if (!slot) throw new Error('Zu viele Vorschau-Projektile');
            const def = P.projectiles[visual] ?? null;
            deps.camera.getWorldPosition(slot.pos);
            deps.camera.getWorldDirection(_d);
            slot.pos.addScaledVector(_d, P.ahead).y -= 0.1;
            slot.vel.copy(_d).multiplyScalar(def?.speed ?? 20);
            slot.life = P.projectileSeconds;
            slot.def = def;
            slot.handle = deps.arsenal.projectileStart(
              visual,
              PREVIEW_TRAILS[visual] ?? null,
              slot.pos,
              slot.vel,
            );
            return slot.handle ? `${visual} abgefeuert` : 'Pool voll';
          }
          case 'beam':
            beam.visual = full(kind, id);
            beam.time = num(a, P.beamSeconds);
            beam.arcTimer = 0;
            beam.arcCount = 0;
            return `${beam.visual} für ${beam.time} s`;
          case 'field': {
            const visual = full(kind, id);
            const at = new THREE.Vector3();
            const n = new THREE.Vector3();
            aim(at, n);
            at.addScaledVector(n, 0.2);
            const h = deps.arsenal.fieldStart(visual, at, num(a, P.fieldRadius), num(b, P.fieldSeconds));
            return h ? `${visual} bei ${at.x.toFixed(1)} ${at.y.toFixed(1)} ${at.z.toFixed(1)}` : 'Pool voll';
          }
          case 'charge':
            charge.visual = id ? full(kind, id) : 'charge.rail';
            charge.time = 0;
            return `${charge.visual} lädt`;
          case 'shot': {
            const visual = full(kind, id);
            const from = new THREE.Vector3();
            const to = new THREE.Vector3();
            const n = new THREE.Vector3();
            muzzle(from);
            if (aim(to, n)) deps.vfx.spawn('impact.plasma', to, n, 1);
            deps.arsenal.shot(visual, to, from);
            return `${visual} abgefeuert`;
          }
          case 'clear':
            for (const p of projectiles) p.handle = 0;
            beam.time = 0;
            charge.time = -1;
            deps.arsenal.clear();
            return 'Arsenal-Effekte entfernt';
          default:
            throw new Error(`fx ${kinds.join('|')}`);
        }
      },
      complete: ([kind = '', prefix = '']) => {
        if (!ids[kind]) return kinds.filter((k) => k.startsWith(kind));
        return ids[kind]!.map((i) => i.slice(i.indexOf('.') + 1)).filter((i) => i.startsWith(prefix));
      },
    },
  ];
}
