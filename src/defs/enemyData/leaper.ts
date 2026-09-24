/**
 * Springer – enemy type def (M6). Import runtime values only from '../enemyCommon' and TYPES from
 * '../enemies' (runtime cycle otherwise).
 *
 * Lanky long-legged hunter (swarm brain with a wide ring): circles the player at mid range, pounces
 * from far – a long arcing leap after a deep, readable crouch (eye glint + screech) that clears and
 * lands on low cover (arc lane) – and rakes with its sickle claws right after landing (combo).
 * Low health, high mobility. Counterplay: shoot it out of the crouch (a stagger cancels the
 * pounce), dash sideways during the flight, head shots (long skull, ×1.75).
 */
import type { EnemyTypeDef } from '../enemies';
import { NO_ARMOR } from '../enemyCommon';

export const LEAPER_ENEMY: EnemyTypeDef | null = {
  id: 'leaper',
  name: 'Springer',
  brain: 'swarm',
  health: 90,
  surface: 'flesh',
  zoneSurfaces: {},
  movement: { walkSpeed: 3.4, runSpeed: 8.6, acceleration: 30, turnRateDeg: 620, stride: 2.1 },
  nav: { radius: 0.4, height: 1.5, separation: 0.6 },
  collider: null,
  zoneMultipliers: { head: 1.75, limb: 0.7 },
  armor: NO_ARMOR,
  resist: {},
  stagger: { threshold: 38, decayPerSecond: 45, duration: 0.5, immunity: 1.2, weakpointMultiplier: 1.5 },
  knockbackResistance: 0.15,
  attacks: [
    {
      id: 'pounce',
      kind: 'leap',
      minRange: 4.5,
      range: 14,
      windup: 0.75,
      strike: 0.7,
      recover: 0.2,
      cooldown: 5.5,
      damage: 16,
      priority: 2,
      usesSlot: true,
      requiresLos: true,
      trackTurnRateDeg: 280,
      shake: 0.35,
      sound: 'enemy.leaper.pounce',
      combo: 'slash',
      telegraph: { effect: 'enemy.telegraph.pounce', socket: 'eyes', scale: 1 },
      leap: {
        maxDistance: 13,
        arcHeight: 2,
        stopShort: 1,
        leadFactor: 0.55,
        bodyHeight: 0.8,
        hitRadius: 0.8,
        arcSegments: 4,
      },
    },
    {
      id: 'slash',
      kind: 'melee',
      minRange: 0,
      range: 2.1,
      windup: 0.24,
      strike: 0.12,
      recover: 0.5,
      cooldown: 1.1,
      damage: 11,
      priority: 1,
      usesSlot: true,
      requiresLos: true,
      trackTurnRateDeg: 420,
      shake: 0.2,
      sound: 'enemy.leaper.slash',
      melee: { reach: 1.9, coneDeg: 120, height: 1.4 },
    },
  ],
  perception: {
    sightRange: 36,
    fovDeg: 150,
    hearingRadius: 32,
    memory: 7,
    eyeSocket: 'head',
    eyeHeight: 1.35,
  },
  // Wide ring: it circles out of reach; token holders hold at pounce distance (standoff inside the
  // pounce range) and come in only with the pounce – then slash (combo) and fall back to the ring.
  swarm: {
    ringRadius: 9,
    standoff: 6,
    engageDistance: 14,
    orbitAmplitudeDeg: 38,
    orbitHz: 0.16,
    slotInterval: 1.6,
  },
  emergeTime: 1,
  death: { collapse: 0.6, linger: 0.5, dissolve: 1, burst: null },
  breach: { attack: 'slash', segmentTime: 1.6, segmentsPerTear: 1 },
  slotPool: 'light',
  slotCost: 1,
  points: { hit: 10, kill: 80, headshotBonus: 40, weakpointBonus: 40 },
  audio: {
    spawn: 'enemy.leaper.spawn',
    alert: 'enemy.leaper.alert',
    hurt: 'enemy.leaper.hurt',
    death: 'enemy.leaper.death',
    step: 'enemy.leaper.step',
    idle: 'enemy.leaper.idle',
    idleInterval: [2.5, 6],
  },
};
