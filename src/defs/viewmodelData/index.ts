/**
 * Viewmodel defs of the M5 weapons, one file per weapon (parallel authoring without a shared file).
 * getViewmodelDef (defs/viewmodels.ts) looks here after VIEWMODELS; null entries are not built yet.
 */
import type { WeaponViewmodelDef } from '../viewmodels';
import { REVOLVER_VIEWMODEL } from './revolver';
import { MACHINEPISTOL_VIEWMODEL } from './machinepistol';
import { SMG_VIEWMODEL } from './smg';
import { PDW_VIEWMODEL } from './pdw';
import { VECTOR_VIEWMODEL } from './vector';
import { BURSTRIFLE_VIEWMODEL } from './burstrifle';
import { BATTLERIFLE_VIEWMODEL } from './battlerifle';
import { AUTOSHOTGUN_VIEWMODEL } from './autoshotgun';
import { DOUBLEBARREL_VIEWMODEL } from './doublebarrel';
import { LMG_VIEWMODEL } from './lmg';
import { MINIGUN_VIEWMODEL } from './minigun';
import { SNIPER_VIEWMODEL } from './sniper';
import { MARKSMAN_VIEWMODEL } from './marksman';
import { PLASMA_VIEWMODEL } from './plasma';
import { CHAINLIGHTNING_VIEWMODEL } from './chainlightning';
import { RAILGUN_VIEWMODEL } from './railgun';
import { FLAMETHROWER_VIEWMODEL } from './flamethrower';
import { GRENADELAUNCHER_VIEWMODEL } from './grenadelauncher';
import { BLACKHOLE_VIEWMODEL } from './blackhole';
import { RIFTRIPPER_VIEWMODEL } from './riftripper';
import { AETHERHARP_VIEWMODEL } from './aetherharp';
import { CRYONOVA_VIEWMODEL } from './cryonova';

export const M5_VIEWMODELS: Readonly<Record<string, WeaponViewmodelDef | null>> = {
  revolver: REVOLVER_VIEWMODEL,
  machinepistol: MACHINEPISTOL_VIEWMODEL,
  smg: SMG_VIEWMODEL,
  pdw: PDW_VIEWMODEL,
  vector: VECTOR_VIEWMODEL,
  burstrifle: BURSTRIFLE_VIEWMODEL,
  battlerifle: BATTLERIFLE_VIEWMODEL,
  autoshotgun: AUTOSHOTGUN_VIEWMODEL,
  doublebarrel: DOUBLEBARREL_VIEWMODEL,
  lmg: LMG_VIEWMODEL,
  minigun: MINIGUN_VIEWMODEL,
  sniper: SNIPER_VIEWMODEL,
  marksman: MARKSMAN_VIEWMODEL,
  plasma: PLASMA_VIEWMODEL,
  chainlightning: CHAINLIGHTNING_VIEWMODEL,
  railgun: RAILGUN_VIEWMODEL,
  flamethrower: FLAMETHROWER_VIEWMODEL,
  grenadelauncher: GRENADELAUNCHER_VIEWMODEL,
  blackhole: BLACKHOLE_VIEWMODEL,
  riftripper: RIFTRIPPER_VIEWMODEL,
  aetherharp: AETHERHARP_VIEWMODEL,
  cryonova: CRYONOVA_VIEWMODEL,
};
