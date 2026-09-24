/**
 * Heiler – enemy type def (M6). Import runtime values only from '../enemyCommon' and TYPES from
 * '../enemies' (runtime cycle otherwise).
 *
 * A gaunt, hovering bio-priest that never fights at the front: it hangs back behind the pack and
 * tethers a green healing beam from the lantern organ above its head to the most injured ally
 * (the visible tether shows who is being healed; killing the healer, breaking the tether's line of
 * sight or hurting it snaps the beam). It flees when the player closes in and lashes out only when
 * cornered. Counterplay: high priority target – the glowing lantern is its weakpoint (×2.5) and
 * readable from the front; burst it down or break its line to the pack.
 */
import type { EnemyTypeDef } from '../enemies';
import { NO_ARMOR } from '../enemyCommon';

export const HEALER_ENEMY: EnemyTypeDef | null = {
  id: 'healer',
  name: 'Heiler',
  brain: 'support',
  health: 150,
  surface: 'flesh',
  // The lantern bursts in green ichor.
  zoneSurfaces: { weakpoint: 'slime' },
  movement: { walkSpeed: 2.4, runSpeed: 5.4, acceleration: 12, turnRateDeg: 260, stride: 1.8 },
  nav: { radius: 0.4, height: 2, separation: 0.8 },
  collider: { radius: 0.34, height: 1.9 },
  zoneMultipliers: { weakpoint: 2.5, head: 1.5, limb: 0.75 },
  armor: NO_ARMOR,
  resist: { poison: 0.5 },
  stagger: { threshold: 45, decayPerSecond: 35, duration: 0.8, immunity: 1.4, weakpointMultiplier: 2 },
  knockbackResistance: 0.3,
  attacks: [
    {
      // The channel: up to 5 s of tether; the brain starts it on an injured ally (range below).
      id: 'heal',
      kind: 'beam',
      minRange: 0,
      range: 90,
      windup: 0.5,
      strike: 5,
      recover: 0.55,
      cooldown: 1.4,
      damage: 0,
      priority: 2,
      usesSlot: false,
      requiresLos: false,
      trackTurnRateDeg: 0,
      shake: 0,
      sound: 'enemy.healer.heal',
      beam: {
        socket: 'lantern',
        visual: 'enemy.heal',
        heal: {
          range: 15,
          perSecond: 18,
          fractionPerSecond: 0.05,
          below: 0.92,
          bosses: false,
          searchInterval: 0.35,
          losInterval: 0.3,
          breakDistance: 6,
          interruptDamage: 45,
          interruptStagger: 0.7,
          turnRateDeg: 220,
          pulseEffect: 'enemy.heal.pulse',
          pulseInterval: 0.3,
          pulseScale: 1,
        },
      },
    },
    {
      id: 'lash',
      kind: 'melee',
      minRange: 0,
      range: 1.9,
      windup: 0.45,
      strike: 0.15,
      recover: 0.6,
      cooldown: 1.8,
      damage: 9,
      priority: 1,
      usesSlot: false,
      requiresLos: true,
      trackTurnRateDeg: 300,
      shake: 0.15,
      sound: 'enemy.healer.lash',
      melee: { reach: 1.7, coneDeg: 120, height: 1.7 },
    },
  ],
  perception: {
    sightRange: 40,
    fovDeg: 150,
    hearingRadius: 35,
    memory: 8,
    eyeSocket: 'head',
    eyeHeight: 1.8,
  },
  support: {
    bandMin: 9,
    bandPreferred: 14,
    bandMax: 22,
    packRadius: 16,
    packBehind: 5,
    fleeDistance: 7,
    fleeStep: 6,
    fleeArcDeg: 40,
    fleeTries: 5,
    replanInterval: 0.8,
    fleeReplan: 0.6,
    arriveDistance: 1.2,
    runDistance: 6,
    riftLead: 0,
    riftSearch: 0,
    riftStandoff: 0,
    riftTimeout: 0,
  },
  emergeTime: 1.2,
  death: { collapse: 0.9, linger: 0.5, dissolve: 1.1, burst: null },
  breach: { attack: 'lash', segmentTime: 2.2, segmentsPerTear: 1 },
  slotPool: 'light',
  slotCost: 1,
  points: { hit: 10, kill: 120, headshotBonus: 40, weakpointBonus: 60 },
  audio: {
    spawn: 'enemy.healer.spawn',
    alert: 'enemy.healer.alert',
    hurt: 'enemy.healer.hurt',
    death: 'enemy.healer.death',
    step: 'enemy.healer.step',
    idle: 'enemy.healer.idle',
    idleInterval: [3, 7],
  },
};
