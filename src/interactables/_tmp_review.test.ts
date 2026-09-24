import { it } from 'vitest';
import * as THREE from 'three';
import { NavSystem } from '../nav/NavSystem';
import { buildTestLevelMeshes } from '../nav/testLevel';

const w = (...a: unknown[]) => process.stderr.write('\n' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
it('debug overlap', async () => {
  const meshes = buildTestLevelMeshes();
  const nav = new NavSystem({ createWorker: null });
  await nav.build(meshes);
  const door = { c: { x: 5, y: 0.5, z: -1.9 }, h: { x: 1.2, y: 1, z: 0.9 } };
  const machine = { c: { x: 5, y: 0.5, z: -3.5 }, h: { x: 0.8, y: 1, z: 0.9 } };
  if (process.env.REV) { nav.setAreaBlocked(machine.c, machine.h, true); nav.setAreaBlocked(door.c, door.h, true); }
  else { nav.setAreaBlocked(door.c, door.h, true); nav.setAreaBlocked(machine.c, machine.h, true); }
  nav.flushAreas();
  const n: any = nav as any;
  w('areas', n.areas.map((a: any) => [a.areaId, a.mode, a.blocked]));
  const q = n.query; const nm = n.navMesh;
  const cnt = q.queryBoxPolys({ x: 5, y: 0.5, z: -2.5 }, { x: 2, y: 1, z: 2.5 });
  for (let i = 0; i < cnt; i++) {
    const ref = q.boxPoly(i);
    const { tile, poly } = nm.getTileAndPolyByRef(ref);
    const vs: number[][] = [];
    for (let k = 0; k < poly.vertCount(); k++) { const vi = poly.verts(k); vs.push([+tile.verts(vi*3).toFixed(2), +tile.verts(vi*3+2).toFixed(2)]); }
    w('poly', ref, 'area', nm.getPolyArea(ref).area, 'flags', nm.getPolyFlags(ref).flags, vs);
  }
  nav.setAreaBlocked(door.c, door.h, false);
  const out = new THREE.Vector3();
  nav.closestPoint({ x: 5, y: 0, z: -3.5 }, out);
  w('snap', out.x, out.z);
  nav.dispose();
}, 60000);
