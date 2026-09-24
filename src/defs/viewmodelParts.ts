/**
 * Shared viewmodel motion building blocks (poses, trigger pull, pump stroke). A separate module so
 * the per-weapon def files in defs/viewmodelData can use them without importing defs/viewmodels
 * (which imports them – a runtime cycle). Import only TYPES from './viewmodels' here and in
 * defs/viewmodelData/*.
 */
import type { PartMotionDef, PoseDef, Vec3Def } from './viewmodels';

export const V = (x: number, y: number, z: number): Vec3Def => ({ x, y, z });

export const TRIGGER_PULL: PartMotionDef = {
  part: 'trigger',
  type: 'pulse',
  pose: { rot: V(-22, 0, 0) },
  duration: 0.025,
  hold: 0.03,
  release: 0.07,
  ease: 'snap',
  releaseEase: 'out',
};

/** Holster pose of rifles/shotguns: dropped and rolled away, the stock stays behind the eye. */
export const LONG_GUN_LOWERED: PoseDef = { pos: V(0.04, -0.26, 0.06), rot: V(-18, -14, 28) };

/**
 * SG-12 pump stroke, synced to the pump sound (audio/weaponSynth `pump`): back stop 55 ms and
 * forward slam 140 ms after the stroke starts. After a shot it starts PUMP_FIRE_DELAY later,
 * matching the fire layer's lead-in.
 */
export const PUMP_FIRE_DELAY = 0.16;
export const PUMP_CYCLE: PartMotionDef = {
  part: 'pump',
  type: 'pulse',
  pose: { pos: V(0, 0, 0.085) },
  delay: PUMP_FIRE_DELAY,
  duration: 0.055,
  hold: 0.03,
  release: 0.055,
  ease: 'inOut',
  releaseEase: 'in',
};
