/**
 * Späher – enemy type def (M6). Import runtime values only from '../enemyCommon' and TYPES from
 * '../enemies' (runtime cycle otherwise).
 *
 * A tall, spindly stilt-walker with a lance-like head ending in one big red lens. It keeps long
 * range from spots with sight and cover (ranged positioning), then charges a laser: a red aim line
 * tracks the player's chest for ~1 s, locks (brighter line, glint, lock tone) 0.38 s before it
 * fires one heavy instant shot at the locked point. Counterplay: strafe after the lock or break
 * the line of sight; the glinting lens is its weakpoint (×2.5) – the telegraph shows where to aim.
 * After a shot it ducks behind cover or moves to a new spot.
 */
import type { EnemyTypeDef } from '../enemies';
import { NO_ARMOR } from '../enemyCommon';

export const SNIPER_ENEMY: EnemyTypeDef | null = {
  id: 'sniper',
  name: 'Späher',
  brain: 'sniper',
  health: 170,
  surface: 'flesh',
  // The chitin stilts spark, the thorax and the lens bleed.
  zoneSurfaces: { limb: 'armor' },
  movement: { walkSpeed: 2.6, runSpeed: 5.6, acceleration: 14, turnRateDeg: 220, stride: 2.2 },
  nav: { radius: 0.45, height: 2, separation: 0.9 },
  collider: { radius: 0.4, height: 1.9 },
  zoneMultipliers: { weakpoint: 2.5, head: 1.5, limb: 0.6 },
  armor: NO_ARMOR,
  resist: {},
  stagger: { threshold: 55, decayPerSecond: 35, duration: 0.8, immunity: 1.6, weakpointMultiplier: 2 },
  knockbackResistance: 0.45,
  attacks: [
    {
      id: 'snipe',
      kind: 'beam',
      minRange: 7,
      range: 48,
      windup: 1.35,
      strike: 0.12,
      recover: 0.9,
      cooldown: 6.5,
      damage: 38,
      priority: 2,
      usesSlot: false,
      requiresLos: true,
      trackTurnRateDeg: 150,
      shake: 0.55,
      sound: 'enemy.sniper.aim',
      beam: {
        socket: 'scope',
        visual: 'enemy.laser.aim',
        laser: {
          aimDrop: 0.5,
          startError: 2.2,
          trackSpeed: 7.5,
          lockTime: 0.38,
          lostAbort: 0.6,
          hitRadius: 0.22,
          maxRange: 60,
          endShort: 0.9,
          lockVisual: 'enemy.laser.lock',
          shotVisual: 'enemy.laser.shot',
          glintEffect: 'enemy.sniper.glint',
          lockEffect: 'enemy.sniper.lock',
          fireEffect: 'enemy.sniper.muzzle',
          impactEffect: 'enemy.laser.impact',
          effectScale: 1,
        },
      },
    },
    {
      // Cornered: rears up and stabs down with a foreleg.
      id: 'stab',
      kind: 'melee',
      minRange: 0,
      range: 2.2,
      windup: 0.5,
      strike: 0.15,
      recover: 0.7,
      cooldown: 2,
      damage: 16,
      priority: 3,
      usesSlot: false,
      requiresLos: true,
      trackTurnRateDeg: 240,
      shake: 0.3,
      sound: 'enemy.sniper.stab',
      melee: { reach: 2, coneDeg: 110, height: 1.9 },
    },
  ],
  perception: {
    sightRange: 60,
    fovDeg: 110,
    hearingRadius: 40,
    memory: 10,
    eyeSocket: 'scope',
    eyeHeight: 1.8,
  },
  ranged: {
    bandMin: 14,
    bandPreferred: 24,
    bandMax: 36,
    losLostTime: 1.5,
    searchCandidates: 7,
    searchArcDeg: 80,
    searchJitter: 4,
    coverProbe: 1.8,
    peekLead: 0.8,
    hideTimeout: 2.5,
    weights: { los: 10, cover: 3, travel: 0.08, band: 0.25, crowd: 2 },
    crowdRadius: 6,
    repositionTimeout: 9,
    strafeTimeout: 3,
    runDistance: 6,
    strafeDistance: 2.2,
    strafeInterval: [2, 4],
    arriveDistance: 0.5,
  },
  sniper: { relocateChance: 0.45 },
  emergeTime: 1.3,
  death: { collapse: 1, linger: 0.6, dissolve: 1.2, burst: null },
  breach: { attack: 'stab', segmentTime: 2.2, segmentsPerTear: 1 },
  slotPool: 'light',
  slotCost: 1,
  points: { hit: 10, kill: 120, headshotBonus: 50, weakpointBonus: 60 },
  audio: {
    spawn: 'enemy.sniper.spawn',
    alert: 'enemy.sniper.alert',
    hurt: 'enemy.sniper.hurt',
    death: 'enemy.sniper.death',
    step: 'enemy.sniper.step',
    idle: 'enemy.sniper.idle',
    idleInterval: [4, 9],
  },
};
