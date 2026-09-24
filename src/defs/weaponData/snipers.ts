/**
 * Sniper and marksman rifles. Angles in DEGREES, times in seconds, distances in meters, rates in
 * rpm. Precision weapons: tiny ADS cones, heavy hip-fire penalties, long reach, deep penetration.
 *
 * Feel targets:
 * - HX-50 „Richtfeuer“: bolt action (fire mode 'pump' = one bolt cycle per shot, ~1.4 s), 5 rounds,
 *   180 dmg (a 450 headshot deletes a wave-15 Spucker), punches through a line of four. High-zoom
 *   scope, slow to aim, hopeless from the hip. The bolt cycle is an extra per-shot sound layer
 *   (`weapon.sniper.pump`, its lead-in matches the viewmodel's lift-pull-push).
 *   Forge: Scharfrichter (kills heal) → Todesurteil (rounds ricochet on to the next target) →
 *   Himmelsgericht (every hit calls lightning down on five more).
 * - DM-8 „Falke“: semi-auto marksman rifle with a built-in 2.5× optic. 80 dmg, 15 rounds, a snappy
 *   kick that settles fast: the "one tap per Schwärmer head" rhythm at mid range.
 *   Forge: Wanderfalke (ricochets) → Sturmfalke (shock build-up) → Horusauge (void rounds that mark
 *   everything they touch – marked prey takes more damage from everyone).
 */
import type { WeaponDef } from '../weapons';
import { MAG_STEPS, MELEE_BASH, conventionAudio, forgeTier } from './common';

export const SNIPERS = {
  sniper: {
    id: 'sniper',
    name: 'HX-50 „Richtfeuer“',
    shortName: 'HX-50',
    description: 'Repetier-Scharfschützengewehr. Ein Schuss, ein Urteil – durch vier Körper hindurch.',
    category: 'sniper',
    kind: 'hitscan',
    // One bolt cycle per shot (lift, pull, push – the viewmodel's fire choreography).
    fireMode: 'pump',
    burst: null,
    damage: {
      base: 180,
      headMultiplier: 2.5,
      limbMultiplier: 0.8,
      weakpointMultiplier: 3,
      falloffStart: 120,
      falloffEnd: 300,
      minFalloffMultiplier: 0.9,
      element: 'physical',
      impulse: 4,
      propImpulse: 160,
    },
    pellets: 1,
    rpm: 42,
    magazine: 5,
    reserve: 30,
    chambered: true,
    reload: {
      tactical: 2.6,
      empty: 3.2,
      tacticalSteps: [
        { step: 'magOut', at: 0.5 },
        { step: 'magIn', at: 1.5 },
      ],
      emptySteps: [
        { step: 'magOut', at: 0.48 },
        { step: 'magIn', at: 1.45 },
        { step: 'boltRelease', at: 2.5 },
      ],
      perShell: null,
    },
    spread: {
      // No-scope penalty: the hip cone is a coin toss past 10 m.
      hip: 5,
      ads: 0.02,
      moveAdd: 3,
      airAdd: 6,
      crouchMultiplier: 0.7,
      perShotBloom: 1.5,
      bloomMax: 3,
      recoveryPerSec: 6,
      recoveryDelay: 0.2,
    },
    recoil: {
      pattern: [[0, 4.5]],
      patternRepeatFrom: 0,
      randomYaw: 0.8,
      randomPitch: 0.4,
      recoveryPerSec: 12,
      recoveryDelay: 0.15,
      resetTime: 1.2,
      adsMultiplier: 0.55,
      crouchMultiplier: 0.8,
      kickTime: 0.07,
      viewPunch: { pitch: 3.8, yaw: 0.8, roll: 2 },
      visualKick: { back: 0.12, up: 0.035, side: 0.008, pitch: 12, yaw: 2, roll: 4 },
      shake: 0.4,
    },
    ads: {
      // ~3.5× scope (horizontal FOV × 0.35 at 90°).
      zoom: 0.35,
      inTime: 0.38,
      outTime: 0.22,
      moveSpeedMultiplier: 0.45,
      sensitivityMultiplier: 0.5,
    },
    // Four bodies, a grate and glass; armor plates cost 2.
    penetration: { power: 5, damageKeep: 0.85 },
    range: 400,
    equipTime: 0.7,
    holsterTime: 0.4,
    sprintToFireTime: 0.3,
    inspectTime: 3.2,
    melee: MELEE_BASH,
    tracer: { everyNth: 1, color: 0xfff0c0, pellets: 1 },
    vfx: {
      muzzle: 'muzzle.sniper',
      impact: 'impact.bullet',
      casing: 'casing.rifle',
      muzzleLightColor: 0xffb870,
    },
    audio: conventionAudio('sniper', 'large', MAG_STEPS, ['weapon.sniper.pump']),
    rumble: { strong: 0.7, weak: 0.8, ms: 150 },
    model: 'sniper',
    cost: 1500,
    carrySpeedMultiplier: 0.95,
    attachmentSlots: ['optic', 'muzzle', 'magazine', 'stock', 'laser'],
    upgrades: [
      forgeTier(
        1,
        'HX-50 „Scharfrichter“',
        { damage: 1.7, magazine: 1.4, reserve: 1.6 },
        { kind: 'lifesteal', fraction: 0.02 },
      ),
      forgeTier(
        2,
        'HX-50 „Todesurteil“',
        { damage: 1.35, rpm: 1.25, adsTime: 0.85 },
        { kind: 'ricochet', bounces: 2, damageKeep: 0.85 },
      ),
      forgeTier(
        3,
        'HX-50 „Himmelsgericht“',
        { damage: 1.3, penetration: 1.5, reloadTime: 0.85 },
        { kind: 'chainArc', chance: 1, count: 5, range: 10, damage: 200 },
        { tracerColor: 0xbfe8ff },
      ),
    ],
  },

  marksman: {
    id: 'marksman',
    name: 'DM-8 „Falke“',
    shortName: 'DM-8',
    description: 'Halbautomatisches Präzisionsgewehr mit 2,5-fach-Optik. Ein Kopf, ein Schuss, der nächste.',
    category: 'marksman',
    kind: 'hitscan',
    fireMode: 'semi',
    burst: null,
    damage: {
      base: 80,
      headMultiplier: 2.2,
      limbMultiplier: 0.8,
      weakpointMultiplier: 2.5,
      falloffStart: 60,
      falloffEnd: 150,
      minFalloffMultiplier: 0.75,
      element: 'physical',
      impulse: 2.6,
      propImpulse: 90,
    },
    pellets: 1,
    rpm: 300,
    magazine: 15,
    reserve: 105,
    chambered: true,
    reload: {
      tactical: 2.2,
      empty: 2.7,
      tacticalSteps: [
        { step: 'magOut', at: 0.46 },
        { step: 'magIn', at: 1.34 },
      ],
      emptySteps: [
        { step: 'magOut', at: 0.44 },
        { step: 'magIn', at: 1.3 },
        { step: 'boltRelease', at: 2.1 },
      ],
      perShell: null,
    },
    spread: {
      hip: 2.6,
      ads: 0.05,
      moveAdd: 1.8,
      airAdd: 4,
      crouchMultiplier: 0.75,
      perShotBloom: 0.5,
      bloomMax: 2.4,
      recoveryPerSec: 7,
      recoveryDelay: 0.2,
    },
    recoil: {
      // A snappy kick per shot with an alternating lean, settling before the next tap.
      pattern: [
        [0, 1.9],
        [0.3, 1.8],
        [-0.25, 1.85],
        [0.2, 1.8],
      ],
      patternRepeatFrom: 1,
      randomYaw: 0.25,
      randomPitch: 0.15,
      recoveryPerSec: 12,
      recoveryDelay: 0.08,
      resetTime: 0.45,
      adsMultiplier: 0.6,
      crouchMultiplier: 0.85,
      kickTime: 0.05,
      viewPunch: { pitch: 2, yaw: 0.5, roll: 1.2 },
      visualKick: { back: 0.06, up: 0.014, side: 0.004, pitch: 7, yaw: 1.2, roll: 2.4 },
      shake: 0.22,
    },
    ads: {
      // Built-in 2.5× optic (horizontal FOV × 0.48 at 90°).
      zoom: 0.48,
      inTime: 0.28,
      outTime: 0.18,
      moveSpeedMultiplier: 0.6,
      sensitivityMultiplier: 0.7,
    },
    penetration: { power: 2.6, damageKeep: 0.75 },
    range: 300,
    equipTime: 0.6,
    holsterTime: 0.34,
    sprintToFireTime: 0.22,
    inspectTime: 3,
    melee: MELEE_BASH,
    tracer: { everyNth: 1, color: 0xffd890, pellets: 1 },
    vfx: {
      muzzle: 'muzzle.sniper',
      impact: 'impact.bullet',
      casing: 'casing.rifle',
      muzzleLightColor: 0xffb468,
    },
    audio: conventionAudio('marksman', 'large'),
    rumble: { strong: 0.4, weak: 0.6, ms: 90 },
    model: 'marksman',
    cost: 1400,
    attachmentSlots: ['optic', 'muzzle', 'underbarrel', 'magazine', 'stock', 'laser'],
    upgrades: [
      forgeTier(
        1,
        'DM-8 „Wanderfalke“',
        { damage: 1.7, magazine: 1.34, reserve: 1.6 },
        { kind: 'ricochet', bounces: 1, damageKeep: 0.75 },
      ),
      forgeTier(
        2,
        'DM-8 „Sturmfalke“',
        { damage: 1.35, rpm: 1.2, reloadTime: 0.85 },
        { kind: 'elementProc', element: 'shock', chance: 0.3, amount: 20 },
      ),
      forgeTier(
        3,
        'DM-8 „Horusauge“',
        { damage: 1.3, penetration: 1.5, element: 'void' },
        { kind: 'elementProc', element: 'void', chance: 1, amount: 30 },
        { tracerColor: 0xd080ff },
      ),
    ],
  },
} as const satisfies Record<string, WeaponDef>;
