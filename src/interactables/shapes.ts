/**
 * Placement math of the interactables (pure): facings → yaw / normals, and the axis-aligned world
 * boxes of doors (collider, bullets, nav area) and free-standing / wall-standing props.
 * Maps are axis-aligned: every yaw here is a multiple of 90°.
 */
import type { Vec3Like } from '../core/events';
import { BLOCKERS, DOORS } from '../defs/interactables';
import type { Facing, Vec3Tuple } from '../defs/level';
import { NAV } from '../defs/nav';
import type { DoorSlotDef } from '../maps/types';
import { axisHalf, type BoxShape } from './SolidBlocker';

/** Unit interior normal of a facing. */
export function facingNormal(f: Facing): { x: number; z: number } {
  switch (f) {
    case 'px':
      return { x: 1, z: 0 };
    case 'nx':
      return { x: -1, z: 0 };
    case 'pz':
      return { x: 0, z: 1 };
    case 'nz':
      return { x: 0, z: -1 };
  }
}

/** Object yaw whose local +Z points along the facing (atan2(n.x, n.z)). */
export function facingYaw(f: Facing): number {
  const n = facingNormal(f);
  return Math.atan2(n.x, n.z);
}

/** Door leaf thickness of a slot. */
export function doorLeafThickness(slot: DoorSlotDef): number {
  return slot.blast ? DOORS.blast.thickness : DOORS.service.thickness;
}

/** Player collider of a closed door: the whole passage between the two wall faces. */
export function doorColliderBox(slot: DoorSlotDef): BoxShape {
  const p = slot.position;
  return {
    center: { x: p.x, y: p.y + slot.height / 2, z: p.z },
    half: axisHalf(slot.yaw, slot.width, slot.height, slot.depth),
  };
}

/** Bullet / line-of-sight volume of the closed leaves. */
export function doorBulletBox(slot: DoorSlotDef): BoxShape {
  const p = slot.position;
  return {
    center: { x: p.x, y: p.y + slot.height / 2, z: p.z },
    half: axisHalf(slot.yaw, slot.width, slot.height, doorLeafThickness(slot)),
  };
}

/**
 * Navmesh area of a closed door: the passage, extended through the doorway by the agent radius
 * on both sides (no agent parks in the doorway mouth), floor level ± a meter.
 */
export function doorNavBox(slot: DoorSlotDef): BoxShape {
  const p = slot.position;
  const through = slot.depth + 2 * (NAV.build.agentRadius + DOORS.navExtra);
  const across = slot.width + 2 * NAV.build.agentRadius;
  return {
    center: { x: p.x, y: p.y + BLOCKERS.navLift, z: p.z },
    half: axisHalf(slot.yaw, across, BLOCKERS.navHalfHeight * 2, through),
  };
}

/**
 * World box of a prop standing on the floor at `floor` (center of its footprint), `width` across
 * its front, `depth` front-to-back, `height` tall, front facing `yaw`.
 */
export function propBox(
  floor: Vec3Like,
  yaw: number,
  width: number,
  height: number,
  depth: number,
): BoxShape {
  return {
    center: { x: floor.x, y: floor.y + height / 2, z: floor.z },
    half: axisHalf(yaw, width, height, depth),
  };
}

/** Nav area of a prop: its footprint grown by the agent radius (agents keep their body out). */
export function propNavBox(box: BoxShape): BoxShape {
  const r = NAV.build.agentRadius;
  return {
    center: { x: box.center.x, y: box.center.y - box.half.y + BLOCKERS.navLift, z: box.center.z },
    half: { x: box.half.x + r, y: BLOCKERS.navHalfHeight, z: box.half.z + r },
  };
}

/** `box` grown by `margin` on every side. */
export function grownBox(box: BoxShape, margin: number): BoxShape {
  const h = box.half;
  return {
    center: { x: box.center.x, y: box.center.y, z: box.center.z },
    half: { x: h.x + margin, y: h.y + margin, z: h.z + margin },
  };
}

export function tupleToVec(t: Vec3Tuple): Vec3Like {
  return { x: t[0], y: t[1], z: t[2] };
}
