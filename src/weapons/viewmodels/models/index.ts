/**
 * Procedural viewmodel builders of the M5 weapons, one file per weapon. The registry
 * (weapons/viewmodels/index.ts) registers every non-null entry; null = placeholder device.
 */
import type { ViewmodelBuilder } from '../index';
import { buildRevolver } from './revolver';
import { buildMachinepistol } from './machinepistol';
import { buildSmg } from './smg';
import { buildPdw } from './pdw';
import { buildVector } from './vector';
import { buildBurstrifle } from './burstrifle';
import { buildBattlerifle } from './battlerifle';
import { buildAutoshotgun } from './autoshotgun';
import { buildDoublebarrel } from './doublebarrel';
import { buildLmg } from './lmg';
import { buildMinigun } from './minigun';
import { buildSniper } from './sniper';
import { buildMarksman } from './marksman';
import { buildPlasma } from './plasma';
import { buildChainlightning } from './chainlightning';
import { buildRailgun } from './railgun';
import { buildFlamethrower } from './flamethrower';
import { buildGrenadelauncher } from './grenadelauncher';
import { buildBlackhole } from './blackhole';
import { buildRiftripper } from './riftripper';
import { buildAetherharp } from './aetherharp';
import { buildCryonova } from './cryonova';

export const M5_BUILDERS: Readonly<Record<string, ViewmodelBuilder | null>> = {
  revolver: buildRevolver,
  machinepistol: buildMachinepistol,
  smg: buildSmg,
  pdw: buildPdw,
  vector: buildVector,
  burstrifle: buildBurstrifle,
  battlerifle: buildBattlerifle,
  autoshotgun: buildAutoshotgun,
  doublebarrel: buildDoublebarrel,
  lmg: buildLmg,
  minigun: buildMinigun,
  sniper: buildSniper,
  marksman: buildMarksman,
  plasma: buildPlasma,
  chainlightning: buildChainlightning,
  railgun: buildRailgun,
  flamethrower: buildFlamethrower,
  grenadelauncher: buildGrenadelauncher,
  blackhole: buildBlackhole,
  riftripper: buildRiftripper,
  aetherharp: buildAetherharp,
  cryonova: buildCryonova,
};
