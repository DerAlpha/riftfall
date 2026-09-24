/**
 * Meta progression (M9, ProgressionApi): player level + prestige, skill tree, weapon levels and
 * camos, achievements, daily / weekly challenges, cosmetics, lifetime stats and local
 * leaderboards on top of the loaded ProfileData (mutated in place; GamePersistence writes it).
 *
 * Flow:
 * - RunRecorder turns gameplay events into progress signals while a ranked run is recorded
 *   (beginRun … run:over). Each signal feeds the run's lifetime-stat record, the achievement and
 *   challenge trackers and weapon progression, and pays XP (kills, waves). Signals raised while
 *   one is dispatched (a level up during a kill) are queued and dispatched afterwards.
 * - XP is credited live (× the prestige bonus); progression:xp / levelUp / prestige,
 *   achievement:unlocked, challenge:completed, progression:unlock / weaponLevelUp / skills are
 *   emitted for the HUD toasts and the M11 screens.
 * - run:over: final run signals, survival XP, lifetime stats committed, leaderboard entry, save.
 * - Persistence: progress marks the profile dirty; level ups, unlocks, skill changes and challenge
 *   completions schedule one coalesced save (PROGRESSION.saveDebounceMs), the run end and flush()
 *   (page unload) save at once. Nothing is written per frame.
 */
import type {
  AchievementView,
  ChallengeView,
  LeaderboardEntry,
  LifetimeStatsView,
  ProfileData,
  ProgressionApi,
  ProgressionRunInfo,
  StatsApi,
  WeaponProgressView,
} from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { ChallengePeriod, GameEvents, UnlockKind, XpSource } from '../core/events';
import { ACHIEVEMENT_REWARDS, PROGRESSION, PROGRESSION_LIMITS, type MetricId } from '../defs/progression';
import { CHALLENGE_RULES } from '../defs/challenges';
import { getCosmeticDef, isAnimatedCamo, type CamoDef } from '../defs/cosmetics';
import type { AchievementDef } from '../defs/achievements';
import { getSkillNode } from '../defs/skills';
import { AchievementTracker } from './AchievementTracker';
import { ChallengeTracker } from './ChallengeTracker';
import type { ChallengeInstance } from './challengeSeed';
import { CosmeticInventory, challengeCosmeticPool } from './CosmeticInventory';
import { Leaderboards } from './Leaderboards';
import { LifetimeStats } from './LifetimeStats';
import { RunRecorder } from './RunRecorder';
import { SkillTree } from './SkillTree';
import { WeaponProgress } from './WeaponProgress';
import { clearTags, copySignal, createSignal, type ProgressSignal, type SignalTags } from './signals';
import { addLevelXp, xpToNext } from './xpCurve';

export interface ProgressionScheduler {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

export interface ProgressionDeps {
  events: EventBus<GameEvents>;
  /** The loaded profile (mutated in place). */
  profile: ProfileData;
  /** Persist the save now (GamePersistence.saveNow). */
  save(): void;
  scheduler?: ProgressionScheduler;
  /** Wall clock, ms since epoch (timestamps, challenge rotation). */
  now?: () => number;
  /** Real-time seconds (multi-kill window). */
  clock?: () => number;
  /** Doors of the level (all doors in one run). */
  doorCount?: () => number;
  /** Perk slots used / available. */
  perkSlots?: () => { owned: number; max: number };
  /** Seconds survived in the current run. */
  runTime?: () => number;
  /** Carried weapons and owned perks at the run end (leaderboard entries). */
  loadout?: () => { weapons: readonly string[]; perks: readonly string[] };
  /** Pay back points (skill box cashback): EconomyApi.earn(amount, 'refund'). */
  refund?: (amount: number) => void;
}

/** What the last finished run earned (M11 game over screen). */
export interface RunProgressReport {
  xp: number;
  levelBefore: number;
  levelAfter: number;
  prestige: number;
  /** Leaderboard rank (1-based), 0 = not placed. */
  rank: number;
  achievements: string[];
  challenges: string[];
}

const defaultScheduler: ProgressionScheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const MAX_RUN_REPORT_IDS = 32;

export class ProgressionSystem implements ProgressionApi {
  readonly skills: SkillTree;
  readonly weaponProgress: WeaponProgress;
  readonly achievementTracker: AchievementTracker;
  readonly challengeTracker: ChallengeTracker;
  readonly cosmetics: CosmeticInventory;
  readonly lifetime: LifetimeStats;
  readonly boards: Leaderboards;
  readonly recorder: RunRecorder;

  private profile: ProfileData;
  private readonly events: EventBus<GameEvents>;
  private readonly scheduler: ProgressionScheduler;
  private readonly now: () => number;
  private readonly offs: (() => void)[] = [];
  private runInfo: ProgressionRunInfo | null = null;
  private saveTimer: unknown = null;
  private _dirty = false;
  private dispatching = 0;
  private readonly pending: ProgressSignal[] = [];
  private readonly metaSignal = createSignal();
  private liveStats: Pick<StatsApi, 'addModifier' | 'removeSource'> | null = null;
  private report: RunProgressReport | null = null;
  private runXp = 0;
  private runLevelBefore = 1;
  private readonly runAchievements: string[] = [];
  private readonly runChallenges: string[] = [];
  private readonly xpPayload: GameEvents['progression:xp'] = {
    amount: 0,
    source: 'kill',
    level: 1,
    xp: 0,
    xpToNext: 0,
  };

  constructor(private readonly deps: ProgressionDeps) {
    this.events = deps.events;
    this.profile = deps.profile;
    this.scheduler = deps.scheduler ?? defaultScheduler;
    this.now = deps.now ?? Date.now;
    const p = deps.profile;

    this.cosmetics = new CosmeticInventory(p.cosmetics, {
      onUnlock: (kind, id, name) => this.onCosmeticUnlock(kind, id, name, null),
    });
    this.skills = new SkillTree(p.skills, {
      progress: () => this.profile.progression,
      spendCurrency: (n) => this.cosmetics.spendCurrency(n),
      inRun: () => this.recorder.active,
      onChange: (nodeId, rank) => this.onSkillChange(nodeId, rank),
    });
    this.weaponProgress = new WeaponProgress(
      p.weaponProgress,
      {
        onLevelUp: (weaponId, level) => this.onWeaponLevelUp(weaponId, level),
        onCamo: (weaponId, camo) => this.onCamo(weaponId, camo),
        onMastered: (weaponId) => this.meta('weaponMastered', 1, (t) => (t.weapon = weaponId)),
      },
      this.cosmetics,
    );
    this.achievementTracker = new AchievementTracker(
      p.achievements,
      { onUnlock: (def) => this.onAchievement(def) },
      this.now,
    );
    this.challengeTracker = new ChallengeTracker(
      p.challenges,
      {
        onComplete: (c) => this.onChallengeComplete(c),
        onClaim: (c) => this.onChallengeClaim(c),
        onRotate: (period, key) => {
          this.events.emit('challenge:rotated', { period, key });
          this.scheduleSave();
        },
      },
      this.now,
      challengeCosmeticPool(),
    );
    this.lifetime = new LifetimeStats(p.lifetimeStats);
    this.boards = new Leaderboards(p.leaderboards);
    this.recorder = new RunRecorder({
      events: deps.events,
      sink: {
        signal: (s) => this.signal(s),
        waveStart: () => this.achievementTracker.beginWave(),
      },
      clock: deps.clock,
      doorCount: deps.doorCount,
      perkSlots: deps.perkSlots,
      runTime: deps.runTime,
    });
    this.offs.push(
      deps.events.on('run:over', (e) => this.onRunOver(e)),
      deps.events.on('economy:purchase', (e) => {
        const cashback = this.skills.bonuses.boxCashback;
        if (e.ok && e.kind === 'box' && e.cost > 0 && cashback > 0) {
          const amount = Math.floor(e.cost * cashback);
          if (amount > 0) this.deps.refund?.(amount);
        }
      }),
    );
    this.reconcile();
  }

  // -------------------------------------------------------------------------
  // ProgressionApi – level / XP / prestige
  // -------------------------------------------------------------------------

  get level(): number {
    return this.profile.progression.level;
  }

  get prestigeRank(): number {
    return this.profile.progression.prestige;
  }

  get xp(): number {
    return this.profile.progression.xp;
  }

  get xpToNext(): number {
    return xpToNext(PROGRESSION.curve, PROGRESSION.maxLevel, this.profile.progression.level);
  }

  get xpMultiplier(): number {
    return 1 + PROGRESSION.prestige.xpBonusPerRank * this.profile.progression.prestige;
  }

  get dirty(): boolean {
    return this._dirty || this.saveTimer !== null;
  }

  /** The last finished run's rewards (null before the first). */
  get lastRun(): Readonly<RunProgressReport> | null {
    return this.report;
  }

  get currentRun(): Readonly<ProgressionRunInfo> | null {
    return this.runInfo;
  }

  addXp(amount: number, source: XpSource): number {
    if (!(amount > 0) || !Number.isFinite(amount)) return 0;
    const p = this.profile.progression;
    const credited = Math.max(1, Math.round(amount * this.xpMultiplier));
    p.lifetimeXp = Math.min(PROGRESSION_LIMITS.maxCounter, p.lifetimeXp + credited);
    if (this.recorder.active) this.runXp += credited;
    const before = p.level;
    const gained = addLevelXp(p, credited, PROGRESSION.curve, PROGRESSION.maxLevel);
    this._dirty = true;
    const e = this.xpPayload;
    e.amount = credited;
    e.source = source;
    e.level = p.level;
    e.xp = p.xp;
    e.xpToNext = this.xpToNext;
    this.events.emit('progression:xp', e);
    if (gained > 0) this.onLevelUp(before);
    return credited;
  }

  canPrestige(): boolean {
    const p = this.profile.progression;
    return p.level >= PROGRESSION.maxLevel && p.prestige < PROGRESSION.prestige.maxRank;
  }

  prestige(): boolean {
    if (!this.canPrestige()) return false;
    const p = this.profile.progression;
    p.prestige++;
    p.level = 1;
    p.xp = 0;
    this.cosmetics.addCurrency(PROGRESSION.prestige.currency);
    this.events.emit('progression:prestige', {
      prestige: p.prestige,
      xpBonus: PROGRESSION.prestige.xpBonusPerRank * p.prestige,
    });
    this.meta('prestige', p.prestige);
    this.evaluateCosmetics();
    this.events.emit('progression:skills', { nodeId: null, rank: 0, available: this.skills.available });
    this.scheduleSave();
    return true;
  }

  /** Dev console `level <n>`: jump to a level (XP into it reset). */
  setLevel(level: number): void {
    const p = this.profile.progression;
    const target = Math.min(PROGRESSION.maxLevel, Math.max(1, Math.floor(level)));
    const before = p.level;
    p.level = target;
    p.xp = 0;
    if (target > before) this.onLevelUp(before);
    else {
      this._dirty = true;
      this.scheduleSave();
    }
  }

  // -------------------------------------------------------------------------
  // ProgressionApi – views
  // -------------------------------------------------------------------------

  weapon(weaponId: string): WeaponProgressView | null {
    return this.weaponProgress.view(weaponId);
  }

  achievements(): AchievementView[] {
    return this.achievementTracker.views();
  }

  challenges(): ChallengeView[] {
    this.challengeTracker.refresh();
    return this.challengeTracker.views();
  }

  claimChallenge(id: string): boolean {
    return this.challengeTracker.claim(id);
  }

  get stats(): LifetimeStatsView {
    return this.lifetime;
  }

  leaderboard(mapId: string, mode?: string): readonly LeaderboardEntry[] {
    return this.boards.get(mapId, mode);
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  beginRun(info: ProgressionRunInfo): void {
    // A run replaced before it ended (console restart): its stats count, it is no finished run.
    if (this.lifetime.recording) this.commitReplacedRun();
    this.runInfo = { ...info };
    this.challengeTracker.refresh();
    this.runXp = 0;
    this.runLevelBefore = this.profile.progression.level;
    this.runAchievements.length = 0;
    this.runChallenges.length = 0;
    if (!info.ranked) {
      this.recorder.stop();
      return;
    }
    this.recorder.start(info.mapId, info.mode);
    this.lifetime.beginRun();
    this.achievementTracker.beginRun();
    this.challengeTracker.beginRun();
  }

  /** Main menu: stop recording (the run already ended with run:over, or it is dropped). */
  endRun(): void {
    if (this.lifetime.recording) this.commitReplacedRun();
    this.recorder.stop();
    this.runInfo = null;
  }

  applySkillModifiers(stats: Pick<StatsApi, 'addModifier' | 'removeSource'>): void {
    this.skills.applyTo(stats);
  }

  /**
   * The game's stat table: applyRunStart() re-applies the skill modifiers to it, skill changes
   * apply at once.
   */
  setLiveStats(stats: Pick<StatsApi, 'addModifier' | 'removeSource'> | null): void {
    this.liveStats = stats;
  }

  /** Run start / after StatsApi.reset (game/runReset.ts): the skill tree's modifiers again. */
  applyRunStart(): void {
    if (this.liveStats) this.skills.applyTo(this.liveStats);
  }

  /** Dev-console spawns: kills never count. */
  flagNoReward(id: number): void {
    this.recorder.flagNoReward(id);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  flush(): void {
    if (this.dirty) this.saveNow();
  }

  saveNow(): void {
    if (this.saveTimer !== null) {
      this.scheduler.cancel(this.saveTimer);
      this.saveTimer = null;
    }
    this._dirty = false;
    this.deps.save();
  }

  /** Bind to a replaced profile (`resetsave`): every part re-reads its data. */
  attach(profile: ProfileData): void {
    this.recorder.stop();
    this.runInfo = null;
    this.profile = profile;
    this.cosmetics.attach(profile.cosmetics);
    this.skills.attach(profile.skills);
    this.weaponProgress.attach(profile.weaponProgress);
    this.achievementTracker.attach(profile.achievements);
    this.challengeTracker.attach(profile.challenges);
    this.lifetime.attach(profile.lifetimeStats);
    this.boards.attach(profile.leaderboards);
    this.pending.length = 0;
    this.reconcile();
    if (this.liveStats) this.skills.applyTo(this.liveStats);
  }

  dispose(): void {
    if (this.saveTimer !== null) this.scheduler.cancel(this.saveTimer);
    this.saveTimer = null;
    this.recorder.dispose();
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  // -------------------------------------------------------------------------
  // Signal dispatch
  // -------------------------------------------------------------------------

  /** Dispatch a progress signal (RunRecorder sink, meta signals). */
  signal(sig: ProgressSignal): void {
    if (this.dispatching > 0) {
      this.pending.push(sig === this.metaSignal ? sig : copySignal(sig));
      return;
    }
    this.dispatch(sig);
    while (this.pending.length > 0) this.dispatch(this.pending.shift()!);
  }

  private dispatch(sig: ProgressSignal): void {
    this.dispatching++;
    try {
      this.lifetime.signal(sig);
      if (this.achievementTracker.signal(sig)) this._dirty = true;
      if (this.challengeTracker.signal(sig)) this._dirty = true;
      if (this.weaponProgress.signal(sig)) this._dirty = true;
      if (sig.metric === 'kill') this.addXp(killXp(sig.tags) * sig.amount, 'kill');
      else if (sig.metric === 'waveComplete') this.addXp(waveXp(sig.tags.wave), 'wave');
    } finally {
      this.dispatching--;
    }
  }

  /** A signal raised by progression itself (level ups, unlocks, skills). */
  private meta(metric: MetricId, amount: number, tag?: (t: SignalTags) => void): void {
    // While dispatching, the queued signal must be its own object.
    const s = this.dispatching > 0 ? createSignal() : this.metaSignal;
    clearTags(s.tags);
    s.tags.map = this.runInfo?.mapId ?? '';
    s.tags.mode = this.runInfo?.mode ?? '';
    s.metric = metric;
    s.amount = amount;
    tag?.(s.tags);
    if (this.dispatching > 0) this.pending.push(s);
    else this.signal(s);
  }

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------

  private onLevelUp(before: number): void {
    const p = this.profile.progression;
    p.highestLevel = Math.max(p.highestLevel, p.level);
    this.events.emit('progression:levelUp', {
      level: p.level,
      previous: before,
      prestige: p.prestige,
      skillPoints: this.skills.available,
    });
    this.meta('playerLevel', p.level);
    this.evaluateCosmetics();
    this.scheduleSave();
  }

  private onWeaponLevelUp(weaponId: string, level: number): void {
    this.events.emit('progression:weaponLevelUp', {
      weaponId,
      level,
      maxLevel: PROGRESSION.weapon.maxLevel,
    });
    this.meta('weaponLevel', level, (t) => (t.weapon = weaponId));
    this.scheduleSave();
  }

  private onCamo(weaponId: string | null, camo: CamoDef): void {
    this.onCosmeticUnlock('camo', camo.id, camo.name, weaponId);
    if (isAnimatedCamo(camo)) this.meta('animatedCamo', 1, (t) => (t.camo = camo.id));
  }

  private onCosmeticUnlock(kind: UnlockKind, id: string, name: string, weaponId: string | null): void {
    this.events.emit('progression:unlock', { kind, id, name, weaponId });
    this.scheduleSave();
  }

  private onAchievement(def: AchievementDef): void {
    const reward = ACHIEVEMENT_REWARDS[def.tier];
    if (this.runAchievements.length < MAX_RUN_REPORT_IDS) this.runAchievements.push(def.id);
    this.events.emit('achievement:unlocked', {
      id: def.id,
      name: def.name,
      description: def.description,
      tier: def.tier,
      hidden: def.hidden === true,
      xp: Math.round(reward.xp * this.xpMultiplier),
    });
    this.cosmetics.addCurrency(reward.currency);
    this.addXp(reward.xp, 'achievement');
    this.meta('achievementsUnlocked', this.achievementTracker.unlockedCount);
    this.evaluateCosmetics();
    this.scheduleSave();
  }

  private onChallengeComplete(c: ChallengeInstance): void {
    if (this.runChallenges.length < MAX_RUN_REPORT_IDS) this.runChallenges.push(c.id);
    this.events.emit('challenge:completed', {
      id: c.id,
      period: c.period,
      name: c.name,
      xp: Math.round(c.xp * this.xpMultiplier),
      currency: c.currency,
    });
    const period: ChallengePeriod = c.period;
    this.meta('challengeCompleted', 1, (t) => (t.period = period));
    this.scheduleSave();
  }

  private onChallengeClaim(c: ChallengeInstance): void {
    this.cosmetics.addCurrency(c.currency);
    if (c.cosmetic !== null && !this.cosmetics.unlock(c.cosmetic)) {
      this.cosmetics.addCurrency(CHALLENGE_RULES.duplicateCurrency);
    }
    this.addXp(c.xp, 'challenge');
    this.scheduleSave();
  }

  private onSkillChange(nodeId: string | null, rank: number): void {
    this.events.emit('progression:skills', { nodeId, rank, available: this.skills.available });
    this.meta('skillRanks', this.skills.ranksBought);
    const branch = nodeId !== null ? getSkillNode(nodeId)?.branch : undefined;
    if (branch && this.skills.branchComplete(branch)) this.meta('skillBranchComplete', 1, (t) => (t.branch = branch));
    if (this.liveStats) this.skills.applyTo(this.liveStats);
    this.scheduleSave();
  }

  private onRunOver(e: GameEvents['run:over']): void {
    if (!this.recorder.active) return;
    this.recorder.finish({ wave: e.wave, timeSurvived: e.timeSurvived, died: true });
    const minutes = Math.floor(Math.max(0, e.timeSurvived) / 60);
    if (minutes > 0) this.addXp(minutes * PROGRESSION.survivalPerMinute, 'survival');
    const points = this.lifetime.runValue('pointsEarned');
    this.lifetime.commit({
      mapId: e.mapId,
      mode: e.mode,
      wave: e.wave,
      score: e.score,
      timeSurvived: e.timeSurvived,
      died: true,
    });
    const loadout = this.deps.loadout?.();
    const p = this.profile.progression;
    const rank = this.boards.submit(e.mapId, e.mode, {
      wave: Math.max(0, Math.floor(e.wave)),
      kills: Math.max(0, Math.floor(e.kills)),
      score: Math.max(0, Math.floor(e.score)),
      points: Math.max(0, Math.floor(points)),
      time: Math.max(0, Math.round(e.timeSurvived)),
      date: Math.floor(this.now()),
      weapons: loadout ? loadout.weapons.slice(0, PROGRESSION_LIMITS.maxEntryIds) : [],
      perks: loadout ? loadout.perks.slice(0, PROGRESSION_LIMITS.maxEntryIds) : [],
      level: p.level,
      prestige: p.prestige,
      seed: this.runInfo?.seed ?? null,
    });
    this.report = {
      xp: this.runXp,
      levelBefore: this.runLevelBefore,
      levelAfter: p.level,
      prestige: p.prestige,
      rank,
      achievements: [...this.runAchievements],
      challenges: [...this.runChallenges],
    };
    this.saveNow();
  }

  private commitReplacedRun(): void {
    const info = this.runInfo;
    this.recorder.finish({ wave: 0, timeSurvived: this.deps.runTime?.() ?? 0, died: false });
    this.lifetime.commit({
      mapId: info?.mapId ?? '',
      mode: info?.mode ?? '',
      wave: 0,
      score: 0,
      timeSurvived: this.deps.runTime?.() ?? 0,
      died: false,
    });
    this._dirty = true;
  }

  /** Unlocks whose sources are already met (loaded saves, rebalanced defs). */
  private reconcile(): void {
    this.achievementTracker.reconcile();
    this.evaluateCosmetics();
    this.weaponProgress.evaluateGlobalCamos();
  }

  private evaluateCosmetics(): void {
    const p = this.profile.progression;
    this.cosmetics.evaluate({
      highestLevel: p.highestLevel,
      prestige: p.prestige,
      hasAchievement: (id) => this.achievementTracker.isUnlocked(id),
    });
  }

  private scheduleSave(): void {
    this._dirty = true;
    if (this.saveTimer !== null) return;
    this.saveTimer = this.scheduler.schedule(() => {
      this.saveTimer = null;
      this.saveNow();
    }, PROGRESSION.saveDebounceMs);
  }
}

/** XP of one kill (enemy type, zone bonus, elite multiplier). */
export function killXp(t: Readonly<SignalTags>): number {
  const P = PROGRESSION;
  const table = P.killXp;
  let xp = t.enemy !== null && Object.prototype.hasOwnProperty.call(table, t.enemy) ? table[t.enemy]! : P.killDefault;
  if (t.zone === 'head') xp += P.headshotBonus;
  else if (t.zone === 'weakpoint') xp += P.weakpointBonus;
  if (t.kind === 'melee') xp += P.meleeBonus;
  if (t.elite) xp *= P.eliteMultiplier;
  return xp;
}

/** XP of a completed wave. */
export function waveXp(wave: number): number {
  const W = PROGRESSION.wave;
  const w = Number.isFinite(wave) && wave > 0 ? Math.floor(wave) : 1;
  return Math.min(W.max, W.base + W.perWave * w);
}

/** Cosmetic display name (toasts, console). */
export function cosmeticName(id: string): string {
  return getCosmeticDef(id)?.name ?? id;
}
