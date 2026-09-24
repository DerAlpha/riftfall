/**
 * M7 map quests / easter eggs (src/quests): a data-driven step machine per map. Steps: shoot
 * hidden targets, collect (carry) items, interact with objects (in order, optionally consuming a
 * carried item), kill N enemies (inside a volume / zone, with an element / weapon / enemy type),
 * defend a point for T seconds, activate traps. Hints are subtle audio / visual cues (flicker,
 * hums, pulses) – no UI text until the reward. Progress resets with every run.
 *
 * Rewards: a weapon handed out directly (wonder weapon), a free perk, points, and the map's quest
 * achievement (defs/achievements.ts: metric 'questComplete' filtered by the map id).
 *
 * The map's QuestDef comes from the level (MapLevelInstance.questDef) or QUESTS[mapId].
 * Meters, seconds; colors linear RGB.
 */
import type { DamageElement } from '../core/events';
import type { Rgb } from './interactables';
import type { Facing, Vec3Tuple } from './level';

/** A world point with the direction its face looks to (targets and objects on surfaces). */
export interface QuestAnchorDef {
  readonly position: Vec3Tuple;
  /** Surface normal: a wall facing, 'up' (floor / top) or 'down' (ceiling). */
  readonly normal: Facing | 'up' | 'down';
}

/** Hidden target (a flickering specimen tag): one hit from the player counts. */
export interface QuestTargetDef extends QuestAnchorDef {
  readonly id: string;
}

/** Collectible item (walk into it). */
export interface QuestItemDef {
  readonly id: string;
  /** Hover point of the item. */
  readonly position: Vec3Tuple;
}

/** Interactable quest object (socket, console, relic). */
export interface QuestObjectDef extends QuestAnchorDef {
  readonly id: string;
  /** German prompt (shown only while the step wants it). */
  readonly prompt: string;
  /** Hold time (s, 0 = press). */
  readonly hold: number;
  readonly style: 'socket' | 'console';
}

/** Kill volume: a sphere or an axis-aligned box. */
export type QuestVolumeDef =
  | { readonly center: Vec3Tuple; readonly radius: number }
  | { readonly min: Vec3Tuple; readonly max: Vec3Tuple };

export type QuestStepDef =
  | {
      readonly kind: 'shoot';
      readonly id: string;
      readonly targets: readonly QuestTargetDef[];
      /** Must be shot in the listed order (a wrong one resets the order, not the hits). */
      readonly ordered?: boolean;
    }
  | {
      readonly kind: 'collect';
      readonly id: string;
      readonly items: readonly QuestItemDef[];
      /** Item id the player carries afterwards (an `interact` step may consume it). */
      readonly carry: string;
    }
  | {
      readonly kind: 'interact';
      readonly id: string;
      readonly objects: readonly QuestObjectDef[];
      readonly ordered?: boolean;
      /** Carried item needed (and consumed by the last object). */
      readonly requires?: string;
    }
  | {
      readonly kind: 'kill';
      readonly id: string;
      readonly count: number;
      readonly volume?: QuestVolumeDef;
      /** Map zone the kill must happen in. */
      readonly zone?: string;
      readonly element?: DamageElement;
      readonly weapon?: string;
      readonly enemy?: string;
    }
  | {
      readonly kind: 'defend';
      readonly id: string;
      /** Floor point to hold. */
      readonly point: Vec3Tuple;
      readonly radius: number;
      readonly duration: number;
      /** Outside the radius: progress pauses for `grace` s, then drains at `decay` s per s. */
      readonly grace: number;
      readonly decay: number;
    }
  | {
      readonly kind: 'trap';
      readonly id: string;
      readonly count: number;
      /** Trap slot ids that count (default: every trap). */
      readonly traps?: readonly string[];
    };

export type QuestStepKind = QuestStepDef['kind'];

export type QuestRewardDef =
  | { readonly kind: 'weapon'; readonly weapon: string }
  /** A free perk: `perk` or, without one, the first perk of the table the player does not own. */
  | { readonly kind: 'perk'; readonly perk?: string }
  | { readonly kind: 'points'; readonly amount: number };

export interface QuestDef {
  readonly id: string;
  /** German name (completion banner, dev console). */
  readonly name: string;
  readonly steps: readonly QuestStepDef[];
  readonly rewards: readonly QuestRewardDef[];
  /** Achievement id (defs/achievements.ts) unlocked through the 'questComplete' signal. */
  readonly achievement?: string;
  /** German reward line of the completion banner. */
  readonly rewardText: string;
}

/** Look and sound of quest objects (shared by every map). */
export const QUEST_VISUALS = {
  /** Damageable ids of hidden targets (outside the enemy and training-dummy ranges: no points). */
  idBase: 3_000_000,
  tag: {
    size: [0.2, 0.12] as readonly [number, number],
    depth: 0.015,
    /** Hit sphere radius (m) – a little forgiving. */
    hitRadius: 0.16,
    color: [0.55, 0.3, 1.0] as Rgb,
    intensity: 5,
    /** Irregular flicker (value noise rate Hz, depth); reduced flashing: depth × reducedScale. */
    flickerRate: 7,
    flickerDepth: 0.85,
    reducedScale: 0.3,
    /** A shot tag burns out: flash then dark. */
    burnFlash: 3,
    burnDecay: 2.5,
    hitEffect: 'impact.shock',
    material: 'trim_metal',
  },
  core: {
    radius: 0.2,
    color: [0.62, 0.22, 1.0] as Rgb,
    hotColor: [0.85, 0.7, 1.0] as Rgb,
    intensity: 6,
    /** Pickup distance (horizontal m) and max height difference to the player's feet. */
    pickupRadius: 1.2,
    pickupHeight: 2.4,
    spin: 1.3,
    bob: 0.08,
    bobRate: 1.1,
    /** Materialize burst when the step before completes. */
    appearEffect: 'rift.spawn',
    appearScale: 0.6,
    pulseRate: 1.4,
    /** Corona shell radius (× crystal radius) and its fresnel power. */
    coronaScale: 2.4,
    coronaRim: 1.6,
  },
  socket: {
    /** Pedestal (m): radius, height; cradle ring. */
    radius: 0.34,
    height: 1.05,
    ring: 0.2,
    color: [0.55, 0.25, 1.0] as Rgb,
    idleIntensity: 0.4,
    wantIntensity: 3.5,
    activeIntensity: 7,
    material: 'pillar_metal',
    trim: 'trim_metal',
    range: 2.3,
    anchorY: 1.1,
  },
  defend: {
    /** Floor ring (additive) and the containment column over the socket. */
    ringColor: [0.55, 0.3, 1.0] as Rgb,
    ringIntensity: 1.6,
    ringWidth: 0.18,
    columnHeight: 6,
    columnIntensity: 1.4,
    /** Progress tone pitch at 0 → 1. */
    pitch: [0.8, 1.6] as readonly [number, number],
  },
  completeEffect: 'rift.spawn',
  completeScale: 1.4,
  completeShockwave: 0.9,
  completeShockwaveRadius: 6,
  completeShake: 0.35,
  banner: { kicker: 'GEHEIMNIS ENTSCHLÜSSELT', color: 0xc07bff, seconds: 4.2 },
  audio: {
    tagHum: 'quest.tag.hum',
    tagHit: 'quest.tag.hit',
    step: 'quest.step',
    coreHum: 'quest.core.hum',
    pickup: 'quest.core.pickup',
    socket: 'quest.socket',
    defend: 'quest.defend',
    complete: 'quest.complete',
    humGain: 0.5,
    /** Carrying an item: the item hum as a quiet 2D loop (gain × humGain, pitch). */
    carryGain: 0.5,
    carryPitch: 0.8,
    hitGain: 0.8,
    stepGain: 0.7,
    defendGain: 0.5,
    /** The defend drone while the player is outside the radius (× defendGain). */
    outsideGain: 0.5,
    completeGain: 1,
    /** Positional hums start within this distance (m). */
    humDistance: 14,
  },
} as const;

/**
 * "Protokoll Kepler" (research lab): three flickering specimen tags hide in the reception, the
 * specimen hall and the cryo store; shooting all three tears a rift core out of the anomaly over
 * the atrium dais; fed into the socket beside the Rift Forge it destabilizes – hold the dock for 60 s
 * while the invasion pours in. Reward: the Riss-Zerreißer.
 */
export const LAB_QUEST: QuestDef = {
  id: 'kepler',
  name: 'Protokoll Kepler',
  steps: [
    {
      kind: 'shoot',
      id: 'tags',
      targets: [
        { id: 'tag_reception', position: [-7.6, 0.32, 26.41], normal: 'pz' },
        { id: 'tag_specimen', position: [-31.9, 0.42, -25.99], normal: 'pz' },
        { id: 'tag_cryo', position: [34.99, 0.4, -26.9], normal: 'nx' },
      ],
    },
    {
      kind: 'collect',
      id: 'core',
      items: [{ id: 'rift_core', position: [0, 1.55, -1] }],
      carry: 'rift_core',
    },
    {
      kind: 'interact',
      id: 'feed',
      requires: 'rift_core',
      objects: [
        {
          id: 'kepler_socket',
          position: [-7.2, 0, -25.8],
          normal: 'up',
          prompt: 'Riss-Kern einspeisen',
          hold: 1.2,
          style: 'socket',
        },
      ],
    },
    {
      kind: 'defend',
      id: 'containment',
      point: [-7.2, 0, -25.8],
      radius: 7,
      duration: 60,
      grace: 3,
      decay: 0.5,
    },
  ],
  rewards: [{ kind: 'weapon', weapon: 'riftripper' }],
  achievement: 'quest_lab',
  rewardText: 'Riss-Zerreißer erhalten',
};

/** Quests of maps without level data (the level's `questDef` wins). */
export const QUESTS: Readonly<Record<string, QuestDef>> = {
  lab: LAB_QUEST,
};
