/**
 * Dev console `gravity`: the gravity zones (permanent + anomalies), the scale at the player, and a
 * wireframe debug view of every zone (`gravity show|hide`; rebuilt on each show – dev only).
 */
import {
  Box3,
  Box3Helper,
  Color,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  SphereGeometry,
  Vector3,
  type Object3D,
} from 'three';
import type { ConsoleCommand } from '../../core/contracts';
import type { Vec3Like } from '../../core/events';
import { GRAVITY } from '../../defs/mapEvents';
import type { GravityZones } from './GravityZones';

export function createGravityCommands(deps: {
  gravity: GravityZones;
  scene: Object3D;
  player: () => Vec3Like;
}): ConsoleCommand[] {
  let debug: Group | null = null;
  const clear = (): void => {
    if (!debug) return;
    debug.traverse((o) => {
      const l = o as LineSegments;
      l.geometry?.dispose();
      (l.material as LineBasicMaterial | undefined)?.dispose();
    });
    debug.removeFromParent();
    debug = null;
  };
  const show = (): number => {
    clear();
    const g = new Group();
    g.name = 'gravity-debug';
    const color = new Color(GRAVITY.debugColor);
    for (const z of deps.gravity.list()) {
      if (z.shape === 'box') {
        const box = new Box3(new Vector3(...z.a), new Vector3(...z.b));
        g.add(new Box3Helper(box, color));
      } else {
        const edges = new EdgesGeometry(new SphereGeometry(z.b[0], 16, 8));
        const line = new LineSegments(edges, new LineBasicMaterial({ color }));
        line.position.set(z.a[0], z.a[1], z.a[2]);
        g.add(line);
      }
    }
    deps.scene.add(g);
    debug = g;
    return g.children.length;
  };
  return [
    {
      name: 'gravity',
      description: 'Schwerkraftzonen: Liste + Faktor am Spieler, Drahtgitter ein/aus',
      usage: 'gravity [show|hide]',
      complete: () => ['show', 'hide'],
      run: (args) => {
        if (args[0] === 'show') return `${show()} Zone(n) sichtbar.`;
        if (args[0] === 'hide') {
          clear();
          return 'Zonen ausgeblendet.';
        }
        const p = deps.player();
        const zones = deps.gravity.list();
        const lines = zones.map(
          (z) =>
            `${z.id.padEnd(18)} ${z.shape.padEnd(6)} ×${z.scale.toFixed(2)} ` +
            `${z.temporary ? `temporär ${Math.round(z.strength * 100)} %` : 'permanent'}`,
        );
        const scale = deps.gravity.scaleAt(p.x, p.y + GRAVITY.sampleHeight, p.z);
        return [
          zones.length === 0 ? 'Keine Schwerkraftzonen.' : `${zones.length} Zone(n):`,
          ...lines,
          `Faktor am Spieler: ×${scale.toFixed(2)}`,
        ].join('\n');
      },
    },
  ];
}
