/**
 * Small box level for the nav tests (world space, meters):
 * - floor 20 × 20 (top at y = 0),
 * - a 12 m wall across the middle (z = 0, x ∈ [-6, 6]) – paths must go around it,
 * - platform A (top y = 2, x ∈ [5, 9], z ∈ [5, 9]) reached by a ramp along x = 7 (z 0 → 5, ~22°),
 * - platform B (top y = 1, x ∈ [-9, -5], z ∈ [5, 9]) reached by 5 stairs of 0.2 m rise,
 * - block C (top y = 1.2, x ∈ [5.5, 8.5], z ∈ [-8.5, -5.5]): too high to climb, an island,
 * - a floating slab flagged navIgnore (would otherwise be a walkable island at y ≈ 3.1).
 */
import { BoxGeometry, Mesh } from 'three';

export const TEST_LEVEL = {
  wallHalfLength: 6,
  platformA: { x: 7, z: 7, top: 2 },
  platformB: { x: -7, z: 7, top: 1 },
  blockC: { x: 7, z: -7, top: 1.2 },
  ignored: { x: -7, y: 3.1, z: -7 },
} as const;

function box(w: number, h: number, d: number, x: number, y: number, z: number, rotX = 0): Mesh {
  const m = new Mesh(new BoxGeometry(w, h, d));
  m.name = 'level:concrete';
  m.position.set(x, y, z);
  m.rotation.x = rotX;
  m.updateMatrixWorld(true);
  return m;
}

export function buildTestLevelMeshes(): Mesh[] {
  const meshes: Mesh[] = [];
  meshes.push(box(20, 0.2, 20, 0, -0.1, 0));
  meshes.push(box(TEST_LEVEL.wallHalfLength * 2, 2.5, 0.4, 0, 1.25, 0));
  // Platform A + ramp (thin slab whose top face runs from (z 0, y 0) to (z 5, y 2)).
  meshes.push(box(4, 2, 4, 7, 1, 7));
  const rise = 2;
  const run = 5;
  const angle = Math.atan2(rise, run);
  const len = Math.hypot(rise, run);
  const t = 0.2;
  meshes.push(
    box(3, t, len, 7, rise / 2 - (t / 2) * Math.cos(angle), run / 2 + (t / 2) * Math.sin(angle), -angle),
  );
  // Platform B + stairs (0.2 m rise, 0.5 m run) from z = 2.5 up to its front edge at z = 5.
  meshes.push(box(4, 1, 4, -7, 0.5, 7));
  for (let i = 0; i < 5; i++) {
    const top = 0.2 * (i + 1);
    meshes.push(box(3, top, 0.5, -7, top / 2, 2.5 + 0.5 * i + 0.25));
  }
  meshes.push(box(3, TEST_LEVEL.blockC.top, 3, 7, TEST_LEVEL.blockC.top / 2, -7));
  const ignored = box(4, 0.2, 4, TEST_LEVEL.ignored.x, TEST_LEVEL.ignored.y - 0.1, TEST_LEVEL.ignored.z);
  ignored.userData.navIgnore = true;
  meshes.push(ignored);
  return meshes;
}

export function disposeMeshes(meshes: readonly Mesh[]): void {
  for (const m of meshes) m.geometry.dispose();
}
