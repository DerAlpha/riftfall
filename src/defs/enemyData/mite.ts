/**
 * Milbe – enemy type def (M6). Import runtime values only from '../enemyCommon' and TYPES from
 * '../enemies' (runtime cycle otherwise).
 *
 * Tiny, fast skittering parasite that comes in numbers (summoned by the Beschwörer, brood events,
 * mite swarm waves): swarm brain with a tight ring, one quick bite, dies to anything (8 HP – a
 * single pellet, fragment or burn tick). Cheap everywhere: few parts, no collider, small nav agent,
 * few points and XP (no farming via summoners). Counterplay: splash / pellets / beams, keep moving
 * (only a few bite at once – light token pool).
 */
import type { EnemyTypeDef } from '../enemies';
import { NO_ARMOR } from '../enemyCommon';

export const MITE_ENEMY: EnemyTypeDef | null = {
  id: 'mite',
  name: 'Milbe',
  brain: 'swarm',
  health: 8,
  surface: 'flesh',
  zoneSurfaces: {},
  movement: { walkSpeed: 3, runSpeed: 7.8, acceleration: 40, turnRateDeg: 900, stride: 0.5 },
  nav: { radius: 0.22, height: 0.4, separation: 0.35 },
  collider: null,
  zoneMultipliers: {},
  armor: NO_ARMOR,
  resist: {},
  stagger: { threshold: 6, decayPerSecond: 20, duration: 0.3, immunity: 0.6, weakpointMultiplier: 1 },
  knockbackResistance: 0,
  attacks: [
    {
      id: 'bite',
      kind: 'melee',
      minRange: 0,
      range: 1.25,
      windup: 0.28,
      strike: 0.1,
      recover: 0.4,
      cooldown: 0.9,
      damage: 4,
      priority: 1,
      usesSlot: true,
      requiresLos: true,
      trackTurnRateDeg: 540,
      shake: 0.05,
      sound: 'enemy.mite.bite',
      melee: { reach: 1.05, coneDeg: 140, height: 1 },
    },
  ],
  perception: {
    sightRange: 24,
    fovDeg: 180,
    hearingRadius: 22,
    memory: 5,
    eyeSocket: 'head',
    eyeHeight: 0.18,
  },
  swarm: {
    ringRadius: 2.6,
    standoff: 0.7,
    engageDistance: 4.5,
    orbitAmplitudeDeg: 40,
    orbitHz: 0.45,
    slotInterval: 0.9,
  },
  emergeTime: 0.5,
  death: { collapse: 0.25, linger: 0.2, dissolve: 0.5, burst: null },
  breach: { attack: 'bite', segmentTime: 2.4, segmentsPerTear: 1 },
  slotPool: 'light',
  slotCost: 1,
  points: { hit: 5, kill: 20, headshotBonus: 0, weakpointBonus: 0 },
  audio: {
    spawn: 'enemy.mite.spawn',
    alert: 'enemy.mite.alert',
    hurt: 'enemy.mite.hurt',
    death: 'enemy.mite.death',
    step: 'enemy.mite.step',
    idle: 'enemy.mite.idle',
    idleInterval: [3, 7],
  },
};
