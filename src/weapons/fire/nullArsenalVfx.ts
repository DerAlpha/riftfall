/**
 * No-op ArsenalVfxApi: the fire-kinds engine runs (and is unit tested) without arsenal visuals.
 * Game swaps in the real implementation (vfx/arsenal) through `Arsenal.setVfx`.
 */
import type { ArsenalVfxApi } from '../../core/contracts';

export const NULL_ARSENAL_VFX: ArsenalVfxApi = {
  projectileStart: () => 0,
  projectileMove: () => {},
  projectileEnd: () => {},
  beam: () => {},
  fieldStart: () => 0,
  fieldEnd: () => {},
  charge: () => {},
  update: () => {},
  clear: () => {},
};
