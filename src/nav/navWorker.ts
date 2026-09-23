/**
 * Navmesh generation worker: receives world-space triangles + the voxel config, generates the
 * navmesh with recast (wasm) and transfers the serialized navmesh (exportNavMesh) back. The main
 * thread imports it (importNavMesh) and owns queries + crowd. One build per worker instance.
 */
import { exportNavMesh } from 'recast-navigation';
import { generateNavMesh, type NavBuildRequest, type NavBuildResponse } from './navBuild';
import { ensureRecast } from './recast';

/** The dedicated-worker globals used here (the project compiles against the DOM lib). */
interface NavWorkerScope {
  onmessage: ((e: MessageEvent<NavBuildRequest>) => void) | null;
  postMessage(message: NavBuildResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as NavWorkerScope;

async function handle(req: NavBuildRequest): Promise<void> {
  const t0 = performance.now();
  const id = req.id;
  try {
    if (!(await ensureRecast())) {
      scope.postMessage({ id, ok: false, error: 'recast init failed in worker' });
      return;
    }
    const result = generateNavMesh(req.positions, req.indices, req.config);
    if (!result.navMesh) {
      scope.postMessage({ id, ok: false, error: result.error });
      return;
    }
    const data = exportNavMesh(result.navMesh);
    result.navMesh.destroy();
    scope.postMessage({ id, ok: true, data, ms: performance.now() - t0 }, [data.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

scope.onmessage = (e) => {
  void handle(e.data);
};
