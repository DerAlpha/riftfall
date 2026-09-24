/**
 * M7 map events (src/mapEvents): an event director starts data-driven events during waves – by
 * wave number, chance, or a quest step – and the kit's gravity zones (src/maps/kit/GravityZones):
 * - POWER OUTAGE: the level's lights dim to emergency red, perk machines, the Rift Forge, the
 *   Rift-Kiste, wall buys and trap panels lose power until the player restores it at a generator
 *   (hold interact) – a mini objective under pressure;
 * - ENEMY INVASION: a burst of extra enemies from every open rift, alarm + HUD banner;
 * - GRAVITY ANOMALY: a temporary low-gravity sphere (player jumps / falls, arsenal projectiles and
 *   grenades float; enemies walk the navmesh unaffected) with floating debris.
 *
 * Event defs come from the level (MapLevelInstance.eventDefs / generators) or, for maps without
 * level data, from MAP_EVENT_DEFS / GENERATORS[mapId]. Meters, seconds; colors linear RGB unless
 * marked "sRGB hex".
 */
import type { Rgb } from './interactables';
import type { Facing, Vec3Tuple } from './level';

export type MapEventKind = 'powerOutage' | 'invasion' | 'gravityAnomaly';

/** When an event starts. Wave rolls use the run's seeded rng (daily challenge determinism). */
export interface MapEventTriggerDef {
  /** First wave it may roll in (inclusive) and the last (optional). */
  readonly minWave: number;
  readonly maxWave?: number;
  /** Chance per wave start from minWave on (0 = never rolled). */
  readonly chance: number;
  /** Waves it always starts in (still subject to its requirements). */
  readonly waves?: readonly number[];
  /** A quest step (step id of the map's QuestDef) that starts it when the step begins. */
  readonly questStep?: string;
  /** Waves to skip after it ran before it may roll again. */
  readonly cooldownWaves: number;
  /** Seconds after the wave start before it begins: uniform in [min, max]. */
  readonly delay: readonly [number, number];
}

interface MapEventBase {
  readonly id: string;
  readonly trigger: MapEventTriggerDef;
}

export interface PowerOutageEventDef extends MapEventBase {
  readonly kind: 'powerOutage';
  /** Generator ids that may restore it (default: every generator of the map). */
  readonly generators?: readonly string[];
}

export interface InvasionEventDef extends MapEventBase {
  readonly kind: 'invasion';
  /** Extra enemies: base + perWave × wave, at most max. */
  readonly count: { readonly base: number; readonly perWave: number; readonly max: number };
  /** Weighted enemy types (defs/enemies ids) and the first wave each may appear in. */
  readonly types: readonly { readonly type: string; readonly weight: number; readonly minWave?: number }[];
  /** The burst emerges over this long (s), spread over every open rift. */
  readonly spread: number;
}

export interface GravityAnomalyEventDef extends MapEventBase {
  readonly kind: 'gravityAnomaly';
  /** Candidate centers (floor points in zones); empty = around the player. */
  readonly points: readonly { readonly position: Vec3Tuple; readonly zone: string }[];
  readonly radius: number;
  /** Gravity multiplier inside (0.3 = 30 %). */
  readonly scale: number;
  readonly duration: number;
}

export type MapEventDef = PowerOutageEventDef | InvasionEventDef | GravityAnomalyEventDef;

/** Wall-mounted generator panel (power outage objective): wall-face point at floor level. */
export interface GeneratorSpotDef {
  readonly id: string;
  readonly position: Vec3Tuple;
  readonly facing: Facing;
  readonly zone: string;
}

/** Gravity volume (permanent: MapLevelInstance.gravityZones; temporary: anomalies). */
export type GravityZoneDef =
  | {
      readonly id: string;
      readonly shape: 'box';
      readonly min: Vec3Tuple;
      readonly max: Vec3Tuple;
      readonly scale: number;
      /** Blend width inside the border (m, default GRAVITY.feather). */
      readonly feather?: number;
    }
  | {
      readonly id: string;
      readonly shape: 'sphere';
      readonly center: Vec3Tuple;
      readonly radius: number;
      readonly scale: number;
      readonly feather?: number;
    };

export const EVENT_DIRECTOR = {
  /** Rolled events never overlap; quest-step events start regardless. */
  maxConcurrent: 1,
  /** Wave rolls wait this long after the previous event ended (s). */
  minGap: 20,
  /** Only during an active wave (the intermission stays calm). */
  wavesOnly: true,
} as const;

export const POWER = {
  prompt: 'Kein Strom',
  /** Blackout: lights stutter for `stutter` s, then fall to emergency over `down` s. */
  stutter: 0.7,
  down: 1.1,
  /** Restore: a stutter, then everything ramps up over `up` s. */
  up: 1.6,
  /** Stutter flicker rate (Hz) and depth (reduced flashing: a smooth ramp instead). */
  flickerRate: 16,
  flickerDepth: 0.85,
  /** Remaining fraction of the main fixtures, emissive panels, light cones, machine visuals. */
  lightDim: 0.07,
  materialDim: 0.04,
  coneDim: 0,
  propDim: 0.03,
  /** Main lights shift towards the emergency color by this much at full blackout. */
  emergencyColor: [1.0, 0.1, 0.05] as Rgb,
  emergencyTint: 0.9,
  /** Emergency (red) lights: boosted and pulsing during the outage. */
  emergencyBoost: 2.2,
  emergencyPulse: { rate: 0.55, depth: 0.45, reducedDepth: 0.12 },
  /**
   * Auto light groups (levels without `lightGroups`): lights and emissive materials count as
   * emergency lighting (kept, boosted) when red > green × this; lights named in `keepLights`
   * (rift energy) are never touched; meshes named in `coneNames` are dimmable light cones.
   */
  emergencyRedRatio: 2,
  keepLights: ['RiftLight'] as readonly string[],
  coneNames: ['VolumetricCone'] as readonly string[],
  /** Emissive level meshes (auto groups): names starting with these prefixes. */
  emissivePrefixes: ['level:emissive_', 'panel:emissive_'] as readonly string[],
  generator: {
    name: 'Notstromgenerator',
    prompt: 'Generator neu starten',
    /** Hold interact this long (s) to restore the power. */
    hold: 3.2,
    range: 2.4,
    /** Cabinet (m): width, height, depth off the wall; lever and lamps. */
    size: { width: 1.2, height: 1.75, depth: 0.5 },
    wallGap: 0.03,
    anchor: { y: 1.2, offset: 0.35 },
    materials: { body: 'pillar_metal', panel: 'wall_panel_dark', trim: 'trim_metal', hazard: 'painted_hazard' },
    /** Status lamp / beacon colors: waiting for a restart (red), running (green). */
    alarmColor: [1.0, 0.12, 0.04] as Rgb,
    okColor: [0.2, 1.0, 0.4] as Rgb,
    lampIntensity: 7,
    /** Beacon beam over the generator during an outage (additive, volumetric layer). */
    beacon: { radius: 0.3, height: 5, intensity: 1.2, color: [1.0, 0.16, 0.06] as Rgb },
    /** Warning pulse rate (Hz) of the lamp and beacon; reduced flashing: slower, shallower. */
    pulseRate: 1.6,
    reducedPulseRate: 0.5,
    glowPool: { radius: 1.8, intensity: 0.8 },
    /** Hold progress sound ticks (s). */
    crankInterval: 0.45,
  },
  banners: {
    outage: { kicker: 'STROMAUSFALL', title: 'Notstrom', sub: 'Starte den Generator neu: {zone}' },
    restored: { kicker: 'ENERGIE', title: 'Strom wiederhergestellt', sub: '' },
    /** Kicker colors (sRGB hex). */
    color: 0xff3b1f,
    restoredColor: 0x33ff88,
    seconds: 3.4,
  },
  audio: {
    down: 'event.power.down',
    up: 'event.power.up',
    alarm: 'event.power.alarm',
    crank: 'event.generator.crank',
    hum: 'event.generator.hum',
    downGain: 1,
    upGain: 0.9,
    alarmGain: 0.35,
    crankGain: 0.6,
    humGain: 0.4,
  },
} as const;

export const INVASION = {
  banner: { kicker: 'WARNUNG', title: 'Invasion', sub: 'Aus allen Rissen strömen Gegner', color: 0xff2a55 },
  bannerSeconds: 3,
  /** Alarm klaxon repeats (2D). */
  alarm: { id: 'event.invasion.alarm', gain: 0.75, repeats: 3, interval: 1.05 },
  shake: 0.25,
  /** Spawn jitter around a rift (m). */
  jitter: 1.2,
  /** Retries of a failed spawn (full pool) before it is dropped (s between tries). */
  retryDelay: 0.5,
  maxRetries: 6,
} as const;

export const GRAVITY = {
  /** Clamp of the combined scale (products of overlapping zones). */
  minScale: 0.05,
  maxScale: 3,
  /** Default blend width inside zone borders (m). */
  feather: 1.2,
  /** Player: terminal velocity scales with sqrt(scale) (air drag). */
  anomaly: {
    /** Scale ramps in / out over this long (s). */
    fade: 1.5,
    banner: { kicker: 'ANOMALIE', title: 'Schwerkraft gestört', sub: '', color: 0x7ad7ff },
    bannerSeconds: 2.6,
    audio: { start: 'event.gravity.start', loop: 'event.gravity.loop', end: 'event.gravity.end' },
    startGain: 0.9,
    loopGain: 0.6,
    /** Screen shockwave at the start (strength) and camera shake. */
    shockwave: 0.6,
    shake: 0.2,
    /** Floating debris: pieces, size range (m), lift height range (m), bob and spin. */
    debris: {
      count: 46,
      size: [0.08, 0.34] as readonly [number, number],
      lift: [0.6, 3.2] as readonly [number, number],
      bob: 0.25,
      bobRate: 0.45,
      spin: 0.9,
      /** Rise / fall time (s) at the start / end. */
      rise: 2.2,
      fall: 0.9,
      material: 'pillar_metal',
    },
    /** Additive shell + floor ring (volumetric layer). */
    shell: { color: [0.35, 0.75, 1.0] as Rgb, intensity: 0.55, ring: 1.1, rimPower: 2.6 },
    /** Motes drifting upwards inside. */
    motes: { count: 140, speed: 0.35, size: 0.035, color: [0.55, 0.85, 1.0] as Rgb, intensity: 2.2 },
  },
  /** Dev console `gravity`: wireframe color of the zone debug view (sRGB hex). */
  debugColor: 0x55ddff,
} as const;

/** HUD banner of a started event (German). */
export const MAP_EVENT_NAMES: Readonly<Record<MapEventKind, string>> = {
  powerOutage: 'Stromausfall',
  invasion: 'Invasion',
  gravityAnomaly: 'Schwerkraftanomalie',
};

/** Events of maps without level data (the level's `eventDefs` win). */
export const MAP_EVENT_DEFS: Readonly<Record<string, readonly MapEventDef[]>> = {
  lab: [
    {
      id: 'lab_blackout',
      kind: 'powerOutage',
      trigger: { minWave: 4, chance: 0.3, waves: [6], cooldownWaves: 4, delay: [8, 20] },
    },
    {
      id: 'lab_invasion',
      kind: 'invasion',
      trigger: {
        minWave: 7,
        chance: 0.25,
        cooldownWaves: 3,
        delay: [10, 25],
        questStep: 'containment',
      },
      count: { base: 6, perWave: 1.2, max: 24 },
      types: [
        { type: 'swarmer', weight: 0.75 },
        { type: 'spitter', weight: 0.2, minWave: 5 },
        { type: 'tank', weight: 0.05, minWave: 12 },
      ],
      spread: 6,
    },
    {
      id: 'lab_gravity',
      kind: 'gravityAnomaly',
      trigger: { minWave: 3, chance: 0.3, cooldownWaves: 3, delay: [5, 15] },
      points: [
        { position: [0, 0, -1], zone: 'atrium' },
        { position: [0, 0, 24.5], zone: 'reception' },
        { position: [-27, 0, -8], zone: 'labs' },
        { position: [27, 0, 3], zone: 'server' },
        { position: [27, 0, -19], zone: 'cryo' },
        { position: [0, 0, -24], zone: 'dock' },
      ],
      radius: 8.5,
      scale: 0.3,
      duration: 35,
    },
  ],
};

/** Generators of maps without level data (the level's `generators` win). */
export const GENERATORS: Readonly<Record<string, readonly GeneratorSpotDef[]>> = {
  lab: [
    { id: 'gen_reception', position: [3.6, 0, 30], facing: 'nz', zone: 'reception' },
    { id: 'gen_dock', position: [9.5, 0, -18.6], facing: 'nz', zone: 'dock' },
  ],
};

/**
 * M6 boss arenas of maps without level data (the level's `bossArena` wins): the open floor a boss
 * fight uses. Reserved for milestone 6 (spawn director, bosses) – nothing reads it yet but the kit.
 */
export const BOSS_ARENAS: Readonly<
  Record<string, { readonly center: Vec3Tuple; readonly radius: number; readonly zone: string }>
> = {
  lab: { center: [0, 0, -1], radius: 11, zone: 'atrium' },
};
