/**
 * Global game event map. Add new events here (one place = discoverable API).
 * Payloads are plain data, and hot-path emitters (weapons, combat, VFX) reuse one payload object
 * per event: handlers must not keep references to a payload or its vectors (copy what you keep),
 * and must read everything they need before doing anything that may emit or raycast again.
 */
import type { Settings, SettingsSection } from '../save/settingsSchema';
import type { QualityPreset } from '../save/settingsSchema';

export type Vec3Like = { x: number; y: number; z: number };

/** Why the simulation is paused (several can hold at once; the game runs when none is left). */
export type PauseReason = 'pointerlock' | 'visibility' | 'menu';

export type MovementState = 'ground' | 'air' | 'slide' | 'dash' | 'mantle' | 'noclip';

export type SurfaceType = 'metal' | 'concrete' | 'grate' | 'rubber' | 'glass' | 'default';

/** Surfaces of damageable things (enemies, dummies, shields) – drive impact VFX/SFX. */
export type FleshSurface = 'flesh' | 'slime' | 'armor' | 'shield';

/** Where a hit landed. Multipliers per zone come from the weapon / target defs. */
export type HitZone = 'head' | 'body' | 'limb' | 'weakpoint' | 'shield';

/** Damage elements (M5 elemental mods). 'physical' is the default for bullets. */
export type DamageElement = 'physical' | 'fire' | 'ice' | 'shock' | 'poison' | 'void';

/** Why points changed (HUD popup text, stats). */
export type PointsReason =
  | 'hit'
  | 'kill'
  | 'headshot'
  | 'melee'
  | 'repair'
  | 'wave'
  | 'nuke'
  | 'carpenter'
  | 'purchase'
  | 'refund'
  | 'dev';

export type PurchaseKind = 'weapon' | 'ammo' | 'door' | 'perk' | 'box' | 'forge' | 'repair' | 'other';

/** Status effects (M5 elemental mods, defs/elements.ts). */
export type StatusId = 'burn' | 'chill' | 'frozen' | 'shocked' | 'poisoned' | 'voidMark';

export type ImpactKind = 'bullet' | 'pellet' | 'projectile' | 'melee' | 'explosion' | 'beam';

/** Where player XP came from (M9 meta progression, defs/progression.ts). */
export type XpSource = 'kill' | 'wave' | 'survival' | 'challenge' | 'achievement' | 'dev';

/** Achievement rarity tier (reward size, frame colour). */
export type AchievementTier = 'bronze' | 'silver' | 'gold' | 'platinum';

/** Challenge rotation period (UTC day / UTC week starting Monday). */
export type ChallengePeriod = 'daily' | 'weekly';

/** Kinds of cosmetic unlocks (defs/cosmetics.ts). */
export type UnlockKind = 'camo' | 'charm' | 'crosshair' | 'killEffect' | 'emblem';

export interface GameEvents {
  // --- lifecycle ---
  'game:ready': Record<string, never>;
  'game:paused': { reason: PauseReason };
  'game:resumed': Record<string, never>;
  'loading:progress': { loaded: number; total: number; label: string };
  'loading:done': Record<string, never>;

  // --- settings ---
  'settings:changed': { settings: Readonly<Settings>; sections: SettingsSection[] };
  'quality:presetApplied': { preset: QualityPreset | 'custom'; auto: boolean };
  'quality:resolutionScale': { scale: number };

  // --- input ---
  'input:deviceChanged': { device: 'kbm' | 'gamepad' };
  'input:pointerLock': { locked: boolean };

  // --- player movement (emitted from fixed tick) ---
  'player:jump': { double: boolean; position: Vec3Like };
  'player:land': { impactSpeed: number; heavy: boolean; position: Vec3Like; surface: SurfaceType };
  'player:footstep': {
    position: Vec3Like;
    speed: number;
    sprinting: boolean;
    crouched: boolean;
    surface: SurfaceType;
  };
  'player:slideStart': { speed: number; position: Vec3Like };
  'player:slideEnd': Record<string, never>;
  'player:dash': { direction: Vec3Like; chargesLeft: number; position: Vec3Like };
  'player:mantle': { height: number; position: Vec3Like };
  'player:crouch': { crouched: boolean };
  'player:stateChanged': { from: MovementState; to: MovementState };
  'player:teleported': { position: Vec3Like };

  // --- combat feedback (M1: driven by dev console `hurt`) ---
  /** `direction`: world space, from the player TOWARDS the damage source (HUD indicator uses x/z only). */
  'player:damaged': { amount: number; healthFraction: number; direction?: Vec3Like };
  'player:healthChanged': { health: number; maxHealth: number; armor: number; maxArmor: number };

  // --- camera / fx ---
  'camera:shake': { trauma: number };
  /**
   * Chromatic-aberration / hit-flash pulse (0..1) from sources other than player damage: VfxSystem
   * emits it for effect presets with a `hitPulse` def (explosions), scaled by proximity. Game
   * forwards it to RenderApi.addHitPulse, which applies accessibility.reduceFlashing.
   */
  'fx:hitPulse': { strength: number };

  // --- weapons (M2) – emitted by WeaponSystem, consumed by viewmodel animator, VFX, audio, HUD ---
  /** The current weapon starts lowering (switch); `next` is equipped when it is done. */
  'weapon:holsterStart': { weaponId: string; slot: number; duration: number; next: string | null };
  /**
   * A raise is announced. For a switch this comes when the HOLSTER begins (`duration` = rest of
   * the holster + equip, `previous` = the weapon going down) – the viewmodel animator plans the
   * whole switch from it. Equip sound / HUD use `weapon:raiseStart`.
   */
  'weapon:equipStart': { weaponId: string; slot: number; duration: number; previous: string | null };
  /** The weapon in hand starts coming up now (initial equip, after a switch's holster, re-raise). */
  'weapon:raiseStart': { weaponId: string; slot: number; duration: number };
  'weapon:equipped': { weaponId: string; slot: number };
  /** `muzzle` is the world-space muzzle position (viewmodel socket mapped into the world camera). */
  'weapon:fired': {
    weaponId: string;
    origin: Vec3Like;
    direction: Vec3Like;
    muzzle: Vec3Like;
    shotIndex: number;
    ammoInMag: number;
    ads: boolean;
    /**
     * M5 effective def (Rift Forge / attachments): muzzle-flash light color (linear hex, the forge
     * look's tint) and a suppressing muzzle device (smaller flash, quieter report). Absent = the
     * base def's color, unsuppressed.
     */
    muzzleLightColor?: number;
    suppressed?: boolean;
  };
  'weapon:dryFire': { weaponId: string };
  'weapon:reloadStart': { weaponId: string; empty: boolean; duration: number };
  /** Reload keyframe markers for animation/audio sync (mag out/in, bolt/slide/pump, shell insert). */
  'weapon:reloadStep': { weaponId: string; step: 'magOut' | 'magIn' | 'boltRelease' | 'shellIn' | 'pump' };
  'weapon:reloadEnd': { weaponId: string; completed: boolean };
  'weapon:ammoChanged': { weaponId: string; mag: number; reserve: number; magSize: number };
  'weapon:adsChanged': { aiming: boolean; weaponId: string };
  'weapon:inspect': { weaponId: string; duration: number };
  /**
   * The inspect ended in the weapon system (`cancelled`: early, by fire/ADS/sprint – also a dry
   * trigger pull that fires no shot). Melee, reload and switches end it with their own events.
   */
  'weapon:inspectEnd': { weaponId: string; cancelled: boolean };
  'weapon:melee': { weaponId: string; duration: number; hit: boolean };
  'weapon:inventoryChanged': { slots: (string | null)[]; current: number };

  // --- combat (M2+) ---
  /** A shot/blast hit a surface: drives impact particles, decals and impact sounds. */
  'combat:impact': {
    point: Vec3Like;
    normal: Vec3Like;
    surface: SurfaceType | FleshSurface;
    kind: ImpactKind;
    weaponId: string;
    /** Leave a decal (false for flesh exit wounds, penetration exits on thin surfaces, etc.). */
    decal: boolean;
  };
  /**
   * A player tracer. `color` (M5): the effective color (Rift Forge tier, crit shot), else the
   * def's. `segment` (M5 ricochets): a world-space segment `from` → `to` (not from the muzzle).
   */
  'combat:tracer': { from: Vec3Like; to: Vec3Like; weaponId: string; color?: number; segment?: boolean };
  /** Damage dealt to a Damageable (targets, enemies). */
  'combat:damage': {
    targetId: number;
    amount: number;
    zone: HitZone;
    point: Vec3Like;
    killed: boolean;
    weaponId: string;
    element: DamageElement;
    source: 'player' | 'enemy' | 'trap' | 'environment';
    /** How it was delivered (DamageInfo.kind); absent from emitters that predate it. */
    kind?: ImpactKind;
  };
  'combat:kill': {
    targetId: number;
    zone: HitZone;
    weaponId: string;
    position: Vec3Like;
    source: 'player' | 'enemy' | 'trap' | 'environment';
  };
  /**
   * Generic explosion (grenades, explosive enemies, barrels): VfxBridge → VFX (+ camera shake,
   * shockwave, hit pulse), AudioEventBridge → one positional blast. Deals no damage by itself.
   */
  'combat:explosion': {
    position: Vec3Like;
    radius: number;
    element: DamageElement;
    /**
     * M5 (ExplosionDef): the blast's VFX preset and sound id – small splashes (plasma) name an
     * impact preset instead of a full explosion. Absent: by element and radius.
     */
    vfx?: string;
    audio?: string;
  };

  // --- enemies (M3) ---
  'enemy:spawned': { id: number; type: string; position: Vec3Like; elite: boolean };
  /** First time an enemy notices the player (audio roar / screech cue). */
  'enemy:alert': { id: number; type: string; position: Vec3Like };
  /** Attack wind-up started (telegraph) – audio/VFX cue; `attack` is the attack id from defs/enemies. */
  'enemy:attack': { id: number; type: string; attack: string; position: Vec3Like; windup: number };
  'enemy:staggered': { id: number; type: string; position: Vec3Like };
  'enemy:died': {
    id: number;
    type: string;
    position: Vec3Like;
    weaponId: string | null;
    zone: HitZone | null;
    elite: boolean;
    source: 'player' | 'enemy' | 'trap' | 'environment';
  };

  // --- waves / run flow (M3) ---
  'wave:intermission': { nextWave: number; duration: number };
  /** `kind` (optional): 'normal', 'swarm' or an announced special type id ('tank') – HUD banner. */
  'wave:start': { wave: number; total: number; kind?: string };
  'wave:progress': { wave: number; remaining: number; alive: number };
  'wave:complete': { wave: number; duration: number };
  'player:died': { position: Vec3Like };
  /**
   * Lethal damage consumed a revive charge (reviveCharges stat): the player is back up at `health`,
   * invulnerable for `invulnerability` s. Emitted by PlayerHealth instead of dying.
   */
  'player:revived': { health: number; chargesLeft: number; invulnerability: number };
  'run:over': {
    mapId: string;
    mode: string;
    wave: number;
    kills: number;
    headshots: number;
    shotsFired: number;
    shotsHit: number;
    timeSurvived: number;
    score: number;
  };
  'run:restart': Record<string, never>;

  // --- economy / interactables (M4) ---
  'economy:points': { delta: number; total: number; reason: PointsReason; position?: Vec3Like };
  'economy:purchase': { item: string; kind: PurchaseKind; cost: number; ok: boolean };
  'stats:changed': { stats: readonly string[] };
  'perk:acquired': { perkId: string; slot: number };
  'perk:lost': { perkId: string };
  'powerup:spawned': { id: number; type: string; position: Vec3Like };
  'powerup:collected': { type: string; position: Vec3Like; duration: number };
  'powerup:expired': { type: string };
  'door:opened': { doorId: string; zones: readonly string[] };
  'zone:activated': { zone: string };
  'box:opened': { boxId: string; position: Vec3Like };
  'box:resolved': { boxId: string; weaponId: string | null };
  'box:moved': { boxId: string; from: string; to: string };
  'seal:broken': { sealId: string; position: Vec3Like };
  'seal:repaired': { sealId: string; planks: number; position: Vec3Like };
  /** The interactable in focus changed (HUD prompt). */
  'interact:focus': { id: string | null; prompt: string | null; cost: number | null; affordable: boolean };

  // --- arsenal (M5) ---
  /** Charge weapons: charge level changed (0..1; 0 after a release or fizzle). Reused payload. */
  'weapon:charge': { weaponId: string; amount: number };
  /** Beam weapons started / stopped emitting. */
  'weapon:beam': { weaponId: string; active: boolean };
  /** Spin-up weapons: barrel spin (0..1). Reused payload. */
  'weapon:spin': { weaponId: string; amount: number };
  /**
   * An arsenal projectile started flying (ProjectileApi; its drawn position per frame:
   * `positionOf(id)`). `flightAudio`: the def's positional loop (null = silent). Reused payload.
   */
  'projectile:spawned': {
    id: number;
    weaponId: string;
    visual: string;
    flightAudio: string | null;
    position: Vec3Like;
  };
  /** It detonated, stopped or expired (always follows its spawn; also on clear()). */
  'projectile:ended': { id: number };
  /** A projectile hit something or detonated. Reused payload. */
  'projectile:impact': {
    weaponId: string;
    position: Vec3Like;
    normal: Vec3Like;
    /** It exploded (the explosion also emits combat:explosion). */
    detonated: boolean;
  };
  /** A lingering field (singularity, fire pool, poison cloud, frost field) started. */
  'field:spawned': {
    id: number;
    kind: string;
    element: DamageElement;
    position: Vec3Like;
    radius: number;
    duration: number;
  };
  'field:ended': { id: number };
  /** A status effect was applied/raised on a damageable (reused payload). */
  'combat:status': { targetId: number; status: StatusId; stacks: number; position: Vec3Like };
  /** Two statuses reacted (elemental combo) on a damageable. */
  'combat:combo': { targetId: number; combo: string; position: Vec3Like };
  /** Rift Forge upgrade of a carried weapon. */
  'forge:upgraded': { weaponId: string; tier: number; name: string };
  /** Attachment (or element module) fitted to / removed from a carried weapon. */
  'weapon:modsChanged': {
    weaponId: string;
    tier: number;
    attachments: readonly string[];
    element: DamageElement | null;
  };
  'grenade:thrown': { grenadeId: string; position: Vec3Like };
  'grenade:changed': { grenadeId: string; count: number; max: number };
  'ability:used': { abilityId: string; cooldown: number; duration: number };
  'ability:ready': { abilityId: string };
  'ability:ended': { abilityId: string };

  // --- meta progression (M9, src/progression) ---
  /** XP credited (after the prestige bonus). Reused payload: fires per kill. */
  'progression:xp': { amount: number; source: XpSource; level: number; xp: number; xpToNext: number };
  'progression:levelUp': { level: number; previous: number; prestige: number; skillPoints: number };
  'progression:prestige': { prestige: number; xpBonus: number };
  'progression:weaponLevelUp': { weaponId: string; level: number; maxLevel: number };
  /** The skill tree changed: a node gained a rank (`nodeId`), or a respec / reset (`nodeId` null). */
  'progression:skills': { nodeId: string | null; rank: number; available: number };
  /** A cosmetic was unlocked; camos name their weapon (`weaponId`, null = every weapon). */
  'progression:unlock': { kind: UnlockKind; id: string; name: string; weaponId: string | null };
  'achievement:unlocked': {
    id: string;
    name: string;
    description: string;
    tier: AchievementTier;
    hidden: boolean;
    xp: number;
  };
  'challenge:completed': { id: string; period: ChallengePeriod; name: string; xp: number; currency: number };
  /** A new daily / weekly challenge set is active (UTC day / week boundary). */
  'challenge:rotated': { period: ChallengePeriod; key: string };

  // --- map kit (M7): traps, map events, power, quests ---
  /** A trap changed state: activated (purchase / console / quest), ended, cooled down. */
  'trap:state': { trapId: string; kind: string; state: 'ready' | 'active' | 'cooldown'; position: Vec3Like };
  /** A map event started (`position`: its center, null = map-wide; `duration` 0 = until resolved). */
  'mapEvent:started': { eventId: string; kind: string; position: Vec3Like | null; duration: number };
  'mapEvent:ended': { eventId: string; kind: string };
  /** The map's main power went off (power outage) or came back (generator restart, reset). */
  'power:changed': { powered: boolean };
  /** A quest step began (0-based `step` of `steps`). */
  'quest:step': { questId: string; stepId: string; step: number; steps: number };
  /** The map quest (easter egg) was completed; rewards are handed out. */
  'quest:completed': { questId: string; mapId: string };

  // --- ui ---
  'ui:console': { open: boolean };
  'ui:debugOverlay': { visible: boolean };
  'ui:menu': { open: boolean; menu: string };
}
