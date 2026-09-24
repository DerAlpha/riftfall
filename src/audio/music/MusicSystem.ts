/**
 * Dynamic procedural music (M10, MusicApi). The conductor (pure) turns game events into a state,
 * an intensity and sting / cue requests; this class realizes them on the audio engine's context:
 *
 *   ThemePlayer ×2 (crossfades) ─┐           ┌→ mixGame → engine music bus (pause-faded, voice duck)
 *   StingPlayer ─────────────────┼─ routes ──┼→ mixMenu → music volume → master (plays while paused)
 *                                            └→ mixUi   → engine ui bus
 *
 * Scheduling: a setTimeout lookahead loop (MUSIC.scheduler) runs only while the context runs and
 * something plays – no per-frame work (update() only feeds the intensity model in game time).
 * Music at volume 0 (master × music) stops the loop, the players and all theme renders.
 *
 * Pause: the game route fades with the engine's pause and the context suspends as before; the
 * menu route (start screen theme, game over drone) and stings on the menu / ui route hold the
 * context awake (AudioEngine.setMusicHold) until they are done – the pause sting plays out, then
 * the menus are silent and cost no audio CPU.
 *
 * Browsers only start audio from a user gesture: the start screen theme begins with the first click
 * or key press there (Game wires the unlock), before that everything is a silent no-op – as it is
 * without Web Audio at all.
 */
import type { MusicApi, PlayOptions } from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type { GameEvents, Vec3Like } from '../../core/events';
import { createLogger } from '../../core/log';
import {
  MUSIC,
  MUSIC_LAYERS,
  MUSIC_STINGS,
  MUSIC_THEMES,
  type MusicIntensitySource,
  type MusicRoute,
  type MusicState,
  type MusicStingId,
} from '../../defs/music';
import type { AudioSettings } from '../../save/settingsSchema';
import { composeTheme, getThemeDef } from './composer';
import { MusicConductor, type ConductorSink } from './conductor';
import { renderCues } from './cues';
import { layerMask, type ThreatEnemy } from './intensity';
import { MusicBank } from './MusicBank';
import { StingPlayer, ThemePlayer, type PlayerPolicy } from './playback';
import { resolveSting } from './stings';

const log = createLogger('Music');
const S = MUSIC.scheduler;

/** The engine surface the music needs (AudioEngine implements it; tests pass fakes). */
export interface MusicHost {
  /** Null until the first user gesture unlocked audio. */
  readonly context: AudioContext | null;
  /** Where each route connects (null before unlock / without the M10 engine additions). */
  musicOutput?(route: MusicRoute): AudioNode | null;
  /** Keep the context running while the game is paused (menu music, stings on the menu / ui route). */
  setMusicHold?(hold: boolean): void;
  registerBuffer?(id: string, buffer: AudioBuffer): void;
  play?(id: string, opts?: PlayOptions): void;
}

export interface MusicSystemDeps {
  events: EventBus<GameEvents>;
  host: MusicHost;
  settings: Readonly<AudioSettings>;
  /** Map whose theme plays (unknown ids: MUSIC.fallbackTheme). */
  mapId: string;
  /** Wall clock (s) for sting / cue rate limits. */
  now?: () => number;
  /** Boss enemy types (default: defs/enemies `boss: true`). */
  isBoss?: (type: string) => boolean;
  /** Rendered theme samples (tests inject a fake). */
  bank?: MusicBankLike;
  /** Timers (tests inject fakes). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** What the system needs of the sample bank (MusicBank; tests pass a fake). */
export type MusicBankLike = Pick<MusicBank, 'get' | 'load' | 'stats' | 'supported' | 'dispose'>;

export interface MusicStatus {
  enabled: boolean;
  volume: number;
  context: string;
  state: MusicState;
  autoState: MusicState;
  forced: MusicState | null;
  theme: string;
  playing: string | null;
  route: 'game' | 'menu' | null;
  tempo: number;
  bar: number;
  intensity: number;
  source: MusicIntensitySource;
  model: number;
  layers: string[];
  voices: number;
  dropped: number;
  timer: boolean;
  hold: boolean;
  renderedThemes: number;
  megabytes: number;
  pendingTheme: string | null;
}

interface Graph {
  ctx: AudioContext;
  mixGame: GainNode;
  mixMenu: GainNode;
  mixUi: GainNode;
  players: [ThemePlayer, ThemePlayer];
  stings: StingPlayer;
}

function effectiveVolume(a: Readonly<AudioSettings>): number {
  const v = a.master * a.music;
  return Number.isFinite(v) ? v : 0;
}

export class MusicSystem implements MusicApi, ConductorSink {
  readonly conductor: MusicConductor;
  readonly bank: MusicBankLike;
  private graph: Graph | null = null;
  private current: ThemePlayer | null = null;
  private volume: number;
  private _enabled: boolean;
  private timer: unknown = null;
  private pollTimer: unknown = null;
  private pendingTheme: string | null = null;
  private hold = false;
  /** Context time until which stings on the menu / ui route need the context awake. */
  private holdUntil = 0;
  private fireDucked = false;
  private lastFire = Number.NEGATIVE_INFINITY;
  private dangerTimer = 0;
  private cuesStarted = false;
  private cuesReady = false;
  private prepared = false;
  private disposed = false;
  private readonly offs: (() => void)[] = [];
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly policy: PlayerPolicy;
  private readonly cueOpts: PlayOptions & { position: Vec3Like } = { position: { x: 0, y: 0, z: 0 } };
  private readonly fallbackOpts: PlayOptions = {};
  private readonly onContextState = (): void => this.ensureTimer();
  private readonly tick = (): void => this.run();

  constructor(private readonly deps: MusicSystemDeps) {
    this.bank = deps.bank ?? new MusicBank();
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.volume = effectiveVolume(deps.settings);
    this._enabled = this.volume > MUSIC.minVolume;
    this.policy = {
      intensity: () => this.conductor.intensity,
      allowed: () => layerMask(this.conductor.policy.layers),
    };
    this.conductor = new MusicConductor(deps.events, this, {
      mapId: deps.mapId,
      now: deps.now,
      isBoss: deps.isBoss,
    });
    this.offs.push(
      deps.events.on('settings:changed', (e) => {
        if (e.sections.includes('audio')) this.setVolume(e.settings.audio);
      }),
      deps.events.on('game:ready', () => this.prepare()),
      deps.events.on('weapon:fired', () => this.duckForFire()),
    );
    this.pollContext();
  }

  // -------------------------------------------------------------------------
  // MusicApi
  // -------------------------------------------------------------------------

  get enabled(): boolean {
    return this._enabled;
  }

  get state(): MusicState {
    return this.conductor.state;
  }

  get themeId(): string {
    return this.conductor.themeId;
  }

  get intensity(): number {
    return this.conductor.intensity;
  }

  setIntensity(value: number | null, source: MusicIntensitySource = 'director'): void {
    this.conductor.setIntensity(value, source);
  }

  setBossTheme(themeId: string | null): void {
    this.conductor.setBossTheme(themeId === null ? null : getThemeDef(themeId).id);
  }

  setMapTheme(mapId: string): void {
    this.conductor.setMap(mapId);
  }

  sting(id: MusicStingId, transpose = 0): boolean {
    return this.conductor.sting(id, transpose);
  }

  forceState(state: MusicState | null): void {
    this.conductor.force(state);
  }

  /** Enemies the intensity model reads (EnemyManager fits). */
  setEnemySource(source: { readonly enemies: readonly ThreatEnemy[] } | null): void {
    this.conductor.setEnemySource(source);
  }

  /**
   * Per frame while the game runs (game dt): intensity model, listener for the hint cues, and
   * the low-health darkening of the game route (a few times per second).
   */
  update(dt: number, listener?: Vec3Like): void {
    this.conductor.update(dt, listener);
    if (!(dt > 0) || !this.graph || !this.current) return;
    this.dangerTimer -= dt;
    if (this.dangerTimer > 0) return;
    this.dangerTimer = MUSIC.intensity.pollInterval;
    const p = this.conductor.policy;
    if (p.lowpass > 0 || this.current.route !== 'game') return;
    const D = MUSIC.danger;
    const danger = this.conductor.danger;
    const cutoff = danger > 0 ? D.open * Math.pow(D.cutoff / D.open, danger) : 0;
    this.current.setLowpass(cutoff, this.graph.ctx.currentTime, D.response);
  }

  get status(): MusicStatus {
    const g = this.graph;
    const cur = this.current;
    const now = g?.ctx.currentTime ?? 0;
    let voices = 0;
    let dropped = 0;
    if (g) {
      for (const p of g.players) {
        voices += p.pool.active(now);
        dropped += p.pool.dropped;
      }
      voices += g.stings.pool.active(now);
    }
    const bank = this.bank.stats;
    return {
      enabled: this._enabled,
      volume: this.volume,
      context: g ? g.ctx.state : (this.deps.host.context?.state ?? 'locked'),
      state: this.conductor.state,
      autoState: this.conductor.autoState,
      forced: this.conductor.forcedState,
      theme: this.conductor.themeId,
      playing: cur?.themeId ?? null,
      route: cur?.route ?? null,
      tempo: cur?.theme?.def.tempo ?? 0,
      bar: cur?.bars ?? 0,
      intensity: this.conductor.intensity,
      source: this.conductor.intensitySource,
      model: this.conductor.model.modelValue,
      layers: cur ? MUSIC_LAYERS.filter((_, k) => cur.mixer.on[k]) : [],
      voices,
      dropped,
      timer: this.timer !== null,
      hold: this.hold,
      renderedThemes: bank.themes,
      megabytes: bank.bytes / 1048576,
      pendingTheme: this.pendingTheme,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.conductor.dispose();
    this.stopTimer();
    if (this.pollTimer !== null) this.clearTimer(this.pollTimer);
    this.pollTimer = null;
    const g = this.graph;
    if (g) {
      const now = g.ctx.currentTime;
      for (const p of g.players) p.halt(now);
      g.stings.stopAll(now, 0.05);
      g.ctx.removeEventListener('statechange', this.onContextState);
      g.mixGame.disconnect();
      g.mixMenu.disconnect();
      g.mixUi.disconnect();
    }
    this.setHold(false);
    this.graph = null;
    this.current = null;
    this.bank.dispose();
  }

  // -------------------------------------------------------------------------
  // ConductorSink
  // -------------------------------------------------------------------------

  applyState(state: MusicState): void {
    const g = this.graph;
    if (!g || !this._enabled || this.disposed) {
      this.updateHold();
      return;
    }
    const now = g.ctx.currentTime;
    if (state === 'off') {
      this.current?.stop(now, MUSIC.fades.stop);
      this.current = null;
      this.pendingTheme = null;
      this.updateHold();
      return;
    }
    const policy = MUSIC.states[state];
    const themeId = this.conductor.themeFor(state);
    const cur = this.current;
    if (cur && cur.active && !cur.stopping && cur.themeId === themeId) {
      this.pendingTheme = null;
      cur.setRoute(policy.route, now, MUSIC.fades.route);
      cur.setLowpass(policy.lowpass, now, MUSIC.fades.filter);
      this.updateHold();
      this.ensureTimer();
      return;
    }
    const samples = this.bank.get(themeId);
    if (!samples) {
      // Keep the old theme until the new one is rendered (a boss theme takes a moment).
      this.pendingTheme = themeId;
      void this.bank.load(themeId).then((ready) => {
        // A failed render (null) is not retried: the old theme plays on, stings use their fallback.
        if (ready && !this.disposed && this.pendingTheme === themeId) this.applyState(this.conductor.state);
      });
      this.updateHold();
      return;
    }
    this.pendingTheme = null;
    let start = now + S.startDelay;
    if (cur && cur.active && !cur.stopping) {
      // Land the new theme on the old one's beat, then let the old one fade under it.
      const grid = cur.nextGrid(start, 'beat');
      if (grid - start <= cur.beatSeconds) start = grid;
      cur.stop(start, MUSIC.fades.theme);
    }
    const next = g.players[0] === cur ? g.players[1] : g.players[0];
    if (next.active) next.halt(now);
    next.start(composeTheme(themeId), samples, start, policy.route, MUSIC.fades.themeIn);
    next.setLowpass(policy.lowpass, start, MUSIC.fades.filter);
    this.current = next;
    this.updateHold();
    this.ensureTimer();
  }

  playSting(id: MusicStingId, transpose: number): void {
    const g = this.graph;
    const def = MUSIC_STINGS[id];
    if (!g || this.disposed || !def) return;
    // The tab went to the background (visibility pause): nobody hears a pause sting.
    if (id === 'pause' && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const now = g.ctx.currentTime;
    const earliest = now + S.startDelay * 0.5;
    if (def.route === 'ui') {
      const kit = this.bank.get(MUSIC.uiTheme);
      if (!kit) return;
      const notes = resolveSting(def, MUSIC_THEMES[MUSIC.uiTheme]!, earliest, earliest, transpose);
      this.extendHold(g.stings.play(notes, kit, 'ui', def.gain));
      return;
    }
    if (!this._enabled) return;
    const cur = this.current && this.current.active && !this.current.stopping ? this.current : null;
    const samples = cur?.samples ?? null;
    const theme = cur?.theme ?? null;
    if (!cur || !samples || !theme) {
      const fb = def.fallback;
      if (fb && this.deps.host.play) {
        const o = this.fallbackOpts;
        o.bus = fb.bus;
        o.volume = def.gain;
        o.pitch = Math.pow(2, transpose / 12);
        o.pitchVariance = 0;
        this.deps.host.play(fb.id, o);
      }
      return;
    }
    let at = earliest;
    if (def.quantize !== 'none') {
      const grid = cur.nextGrid(earliest, def.quantize);
      if (grid - earliest <= def.maxWait) at = grid;
      else {
        const half = cur.nextGrid(earliest, 'half');
        if (half - earliest <= def.maxWait) at = half;
      }
    }
    const notes = resolveSting(def, theme.def, at, earliest, transpose);
    const end = g.stings.play(notes, samples, def.route, def.gain);
    if (def.drop) cur.drop(at, def.drop.beats * cur.beatSeconds, def.drop.gain);
    if (def.route === 'menu') this.extendHold(end);
    this.ensureTimer();
  }

  playCue(id: string, position: Vec3Like, gain: number, pitchVariance: number): void {
    const play = this.deps.host.play;
    if (!play || !this.cuesReady) return;
    const o = this.cueOpts;
    o.position.x = position.x;
    o.position.y = position.y;
    o.position.z = position.z;
    o.volume = gain;
    o.pitchVariance = pitchVariance;
    o.pitch = 1;
    o.bus = 'sfx';
    play.call(this.deps.host, id, o);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Background renders after loading: the hint cues and the UI kit always (small), the menu and
   * map themes while music is on.
   */
  private prepare(): void {
    // After the synchronous start-up that follows game:ready (autostart / start screen): the
    // theme the state needs now renders first, one theme at a time, the small kits after.
    queueMicrotask(() => {
      if (this.disposed) return;
      let chain: Promise<unknown> = Promise.resolve();
      if (this._enabled && !this.prepared) {
        this.prepared = true;
        const state = this.conductor.state;
        const map = this.conductor.themeFor('intermission');
        const first = state === 'off' || state === 'menu' ? MUSIC.menuTheme : this.conductor.themeId;
        chain = this.bank.load(first).then(() => this.bank.load(first === MUSIC.menuTheme ? map : MUSIC.menuTheme));
      }
      if (!this.cuesStarted && this.bank.supported) {
        this.cuesStarted = true;
        void chain
          .then(() => this.bank.load(MUSIC.uiTheme))
          .then(() => renderCues())
          .then((cues) => {
            if (this.disposed) return;
            for (const [id, buf] of cues) this.deps.host.registerBuffer?.(id, buf);
            this.cuesReady = cues.size > 0;
          });
      }
    });
  }

  private setVolume(a: Readonly<AudioSettings>): void {
    this.volume = effectiveVolume(a);
    const enabled = this.volume > MUSIC.minVolume;
    if (enabled === this._enabled) return;
    this._enabled = enabled;
    const g = this.graph;
    if (!enabled) {
      if (g) {
        const now = g.ctx.currentTime;
        for (const p of g.players) if (p.active) p.stop(now, MUSIC.fades.stop);
        g.stings.stopAll(now, MUSIC.fades.stop);
      }
      this.current = null;
      this.pendingTheme = null;
      this.holdUntil = 0;
      this.updateHold();
      log.info('Music off (volume 0): scheduler stopped');
      return;
    }
    this.prepare();
    this.applyState(this.conductor.state);
  }

  /** Wait for the engine's AudioContext (created by the first user gesture). */
  private pollContext(): void {
    if (this.disposed || this.graph) return;
    const ctx = this.deps.host.context;
    if (ctx) {
      this.attach(ctx);
      return;
    }
    this.pollTimer = this.setTimer(() => {
      this.pollTimer = null;
      this.pollContext();
    }, S.contextPoll * 1000);
  }

  private attach(ctx: AudioContext): void {
    const out = (route: MusicRoute): AudioNode | null => this.deps.host.musicOutput?.(route) ?? null;
    const game = out('game');
    const menu = out('menu');
    const ui = out('ui');
    if (!game || !menu || !ui) {
      log.warn('Audio engine without music outputs – music disabled');
      return;
    }
    try {
      const mixGame = ctx.createGain();
      const mixMenu = ctx.createGain();
      const mixUi = ctx.createGain();
      mixGame.gain.value = MUSIC.mix.master;
      mixMenu.gain.value = MUSIC.mix.master;
      mixUi.gain.value = 1;
      mixGame.connect(game);
      mixMenu.connect(menu);
      mixUi.connect(ui);
      const outs = { game: mixGame, menu: mixMenu };
      this.graph = {
        ctx,
        mixGame,
        mixMenu,
        mixUi,
        players: [new ThemePlayer(ctx, outs, this.policy), new ThemePlayer(ctx, outs, this.policy)],
        stings: new StingPlayer(ctx, { game: mixGame, menu: mixMenu, ui: mixUi }),
      };
    } catch (err) {
      log.error('Building the music graph failed – music disabled', err);
      this.graph = null;
      return;
    }
    ctx.addEventListener('statechange', this.onContextState);
    this.prepare();
    this.applyState(this.conductor.state);
  }

  private duckForFire(): void {
    const g = this.graph;
    if (!g || !this._enabled) return;
    const now = g.ctx.currentTime;
    this.lastFire = now;
    if (this.fireDucked) return;
    this.fireDucked = true;
    const D = MUSIC.mix.fireDuck;
    g.mixGame.gain.setTargetAtTime(MUSIC.mix.master * D.gain, now, D.attack / 3);
    this.ensureTimer();
  }

  private releaseFireDuck(now: number): void {
    const g = this.graph;
    if (!g || !this.fireDucked || now - this.lastFire < MUSIC.mix.fireDuck.release) return;
    this.fireDucked = false;
    g.mixGame.gain.setTargetAtTime(MUSIC.mix.master, now, MUSIC.mix.fireDuck.release / 3);
  }

  private extendHold(end: number): void {
    if (end > this.holdUntil) this.holdUntil = end;
    this.updateHold();
    this.ensureTimer();
  }

  /**
   * The context must stay awake while paused when the state plays on the menu route (start screen,
   * game over) – requested before the context even exists, so the engine never suspends it in
   * between – or while a sting on the menu / ui route still sounds.
   */
  private updateHold(): void {
    const g = this.graph;
    const state = this.conductor.state;
    const menuRoute = this._enabled && state !== 'off' && MUSIC.states[state].route === 'menu';
    const stings = g !== null && g.ctx.currentTime < this.holdUntil;
    this.setHold(!this.disposed && (menuRoute || stings));
  }

  private setHold(hold: boolean): void {
    if (hold === this.hold) return;
    this.hold = hold;
    this.deps.host.setMusicHold?.(hold);
  }

  private get busy(): boolean {
    const g = this.graph;
    if (!g) return false;
    return (
      g.players[0].active || g.players[1].active || this.fireDucked || g.ctx.currentTime < this.holdUntil
    );
  }

  private ensureTimer(): void {
    const g = this.graph;
    if (this.timer !== null || this.disposed || !g || g.ctx.state !== 'running' || !this.busy) return;
    this.timer = this.setTimer(this.tick, S.interval * 1000);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Scheduler tick: pump the players a lookahead ahead on the audio clock. */
  private run(): void {
    this.timer = null;
    const g = this.graph;
    if (!g || this.disposed) return;
    const now = g.ctx.currentTime;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const horizon = now + (hidden ? S.hiddenLookahead : S.lookahead);
    for (const p of g.players) {
      p.update(now);
      if (p.active) p.pump(now, horizon);
    }
    if (this.current && !this.current.active) this.current = null;
    this.releaseFireDuck(now);
    this.updateHold();
    this.ensureTimer();
  }
}
