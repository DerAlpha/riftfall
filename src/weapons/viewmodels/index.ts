/**
 * Viewmodel model registry: model id → procedural builder. Model ids equal weapon ids in M2;
 * later weapons register a builder (or a glTF-backed factory) here – the rig and animator never
 * branch on ids. Unknown ids return null (the rig then shows the placeholder device).
 */
import { createLogger } from '../../core/log';
import type { WeaponMaterialKit } from './materials';
import { buildPistol } from './pistol';
import { buildRifle } from './rifle';
import { buildShotgun } from './shotgun';
import type { WeaponViewmodelModel } from './WeaponModel';

export type { WeaponViewmodelModel, ViewmodelFxState } from './WeaponModel';
export type { SocketName } from './ModelBuilder';
export { WeaponMaterialKit } from './materials';

const log = createLogger('viewmodel');

export type ViewmodelBuilder = (kit: WeaponMaterialKit) => WeaponViewmodelModel;

const BUILDERS = new Map<string, ViewmodelBuilder>([
  ['pistol', buildPistol],
  ['rifle', buildRifle],
  ['shotgun', buildShotgun],
]);

/** Register (or replace) a model builder – future weapons / modded content. */
export function registerViewmodelBuilder(modelId: string, builder: ViewmodelBuilder): void {
  BUILDERS.set(modelId, builder);
}

export function hasViewmodel(modelId: string): boolean {
  return BUILDERS.has(modelId);
}

export function viewmodelIds(): string[] {
  return [...BUILDERS.keys()];
}

/** Build a model; never throws (a failing builder logs and yields null → placeholder). */
export function createWeaponViewmodel(modelId: string, kit: WeaponMaterialKit): WeaponViewmodelModel | null {
  const build = BUILDERS.get(modelId);
  if (!build) {
    log.warn(`no viewmodel for "${modelId}" – showing the placeholder`);
    return null;
  }
  try {
    return build(kit);
  } catch (err) {
    log.error(`viewmodel "${modelId}" failed to build`, err);
    return null;
  }
}
