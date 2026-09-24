/**
 * Explodierer – enemy type def (M6). Import runtime values only from '../enemyCommon' and TYPES from
 * '../enemies' (runtime cycle otherwise).
 *
 * Bloated creature carrying a huge glowing bile sac in front of it (swarm brain, `rush`: no ring, no
 * token). Waddles straight at the player; within 12 m its sac blinks faster and brighter (warning
 * pulse), close by it stops, swells and screams (fuse: 1.1 s wind-up, amber light) and detonates –
 * the self-destruct strike leaves only its death burst, a fire blast that hurts EVERYTHING around
 * it. Any death bursts the sac, so a hit in the sac (×2, the weapon's weakpoint bonus on top) blows
 * it up early – in the middle of its friends: chain reactions (other exploders go up too).
 * Counterplay: shoot the sac at range, back off during the fuse, never kill it at arm's length.
 */
import type { EnemyTypeDef } from '../enemies';
import { NO_ARMOR } from '../enemyCommon';

export const EXPLODER_ENEMY: EnemyTypeDef | null = {
  id: 'exploder',
  name: 'Explodierer',
  brain: 'swarm',
  health: 70,
  surface: 'flesh',
  zoneSurfaces: {},
  movement: { walkSpeed: 2.2, runSpeed: 5, acceleration: 16, turnRateDeg: 320, stride: 1.25 },
  nav: { radius: 0.5, height: 1.6, separation: 0.7 },
  collider: null,
  zoneMultipliers: { weakpoint: 2, head: 1.25, limb: 0.8 },
  armor: NO_ARMOR,
  // Its own bile burns: fire barely hurts it (the chain reaction comes from its death burst).
  resist: { fire: 0.5 },
  stagger: { threshold: 40, decayPerSecond: 40, duration: 0.55, immunity: 1.5, weakpointMultiplier: 1 },
  knockbackResistance: 0.35,
  attacks: [
    {
      id: 'fuse',
      kind: 'melee',
      minRange: 0,
      range: 2.6,
      windup: 1.1,
      strike: 0.1,
      recover: 0.1,
      cooldown: 1.1,
      // The blow is the death burst (death.burst): the melee strike itself deals nothing.
      damage: 0,
      priority: 2,
      usesSlot: false,
      requiresLos: true,
      trackTurnRateDeg: 200,
      shake: 0,
      sound: 'enemy.exploder.fuse',
      selfDestruct: true,
      telegraph: { effect: 'enemy.telegraph.fuse', socket: 'sac', scale: 1 },
      melee: { reach: 2.3, coneDeg: 360, height: 2 },
    },
    // Seal tearing only (rams the lattice; hugging the seal gets a shove, not the fuse).
    {
      id: 'ram',
      kind: 'melee',
      minRange: 0,
      range: 1.8,
      windup: 0.4,
      strike: 0.12,
      recover: 0.45,
      cooldown: 1.2,
      damage: 6,
      priority: 0,
      usesSlot: false,
      requiresLos: true,
      trackTurnRateDeg: 240,
      shake: 0.15,
      sound: 'enemy.exploder.ram',
      scripted: true,
      melee: { reach: 1.6, coneDeg: 110, height: 1.4 },
    },
  ],
  perception: {
    sightRange: 30,
    fovDeg: 140,
    hearingRadius: 30,
    memory: 8,
    eyeSocket: 'head',
    eyeHeight: 1.3,
  },
  swarm: {
    ringRadius: 3,
    standoff: 1,
    engageDistance: 30,
    orbitAmplitudeDeg: 0,
    orbitHz: 0,
    slotInterval: 2,
    rush: true,
  },
  warningPulse: { distance: 12, minHz: 1.2, maxHz: 4.5, glow: 2.4, sharpness: 3 },
  emergeTime: 1.1,
  death: {
    collapse: 0.35,
    linger: 0.25,
    dissolve: 0.7,
    burst: {
      radius: 4.5,
      innerRadius: 1.6,
      minFactor: 0.25,
      playerDamage: 45,
      enemyDamage: 150,
      element: 'fire',
      socket: 'sac',
      puddle: null,
      // The blast preset shakes (combat:explosion).
      shake: 0,
      explosion: true,
    },
  },
  breach: { attack: 'ram', segmentTime: 2.4, segmentsPerTear: 1 },
  slotPool: 'light',
  slotCost: 1,
  points: { hit: 10, kill: 70, headshotBonus: 30, weakpointBonus: 50 },
  audio: {
    spawn: 'enemy.exploder.spawn',
    alert: 'enemy.exploder.alert',
    hurt: 'enemy.exploder.hurt',
    death: 'enemy.exploder.death',
    step: 'enemy.exploder.step',
    // A wet, beeping gurgle – the sac's pulse is audible before it is visible.
    idle: 'enemy.exploder.idle',
    idleInterval: [0.9, 1.8],
  },
};
