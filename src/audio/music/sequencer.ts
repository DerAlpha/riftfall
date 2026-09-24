/**
 * Lookahead sequencer cursor (pure, no Web Audio): walks a composed theme bar by bar on the audio
 * clock. `pump(now, horizon)` hands every event starting before `horizon` to the sink exactly once,
 * announces each bar (`onBar`) before its first event – bar-quantized decisions (layers, density)
 * happen there – and skips what a stalled timer missed by more than `maxLate` instead of bursting
 * it. Also answers "when is the next beat / bar" for quantized stings and theme starts.
 */
import { MUSIC } from '../../defs/music';
import type { ComposedBar, ComposedPhrase, ComposedTheme, NoteEvent } from './composer';

export interface BarInfo {
  /** Bars since start(). */
  readonly index: number;
  /** Bar inside its phrase, and whether the phrase starts here. */
  readonly phraseBar: number;
  readonly phrase: ComposedPhrase;
  readonly bar: ComposedBar;
  /** Audio time of the bar line and the bar's length (s). */
  readonly time: number;
  readonly duration: number;
  /** Whole bars were skipped before this one (a stalled timer): sustained notes must be re-struck. */
  readonly afterSkip: boolean;
}

export interface SequencerSink {
  onBar(info: BarInfo): void;
  /** `time` (s, audio clock) and `duration` (s) of the event. */
  onEvent(e: NoteEvent, time: number, duration: number): void;
}

export type GridUnit = 'bar' | 'beat' | 'half' | 'step';

export class Sequencer {
  private barTime = 0;
  private barIndex = 0;
  private orderIdx = 0;
  private phraseBar = 0;
  private eventIdx = 0;
  private announced = false;
  private started = false;
  private jumped = false;
  /** Events skipped because the timer came too late (debug). */
  skipped = 0;
  private readonly info = {
    index: 0,
    phraseBar: 0,
    phrase: null as unknown as ComposedPhrase,
    bar: null as unknown as ComposedBar,
    time: 0,
    duration: 0,
    afterSkip: false,
  };

  constructor(
    readonly theme: ComposedTheme,
    private readonly maxLate: number = MUSIC.scheduler.maxLate,
  ) {}

  get running(): boolean {
    return this.started;
  }

  /** Bar 0 of the first phrase starts at `time`. */
  start(time: number): void {
    this.barTime = time;
    this.barIndex = 0;
    this.orderIdx = 0;
    this.phraseBar = 0;
    this.eventIdx = 0;
    this.announced = false;
    this.started = true;
    this.jumped = false;
    this.skipped = 0;
  }

  stop(): void {
    this.started = false;
  }

  get stepDur(): number {
    return this.theme.stepDur;
  }

  get beatDur(): number {
    return this.theme.stepDur * this.theme.def.beatSteps;
  }

  get currentBarTime(): number {
    return this.barTime;
  }

  get bars(): number {
    return this.barIndex;
  }

  private get phrase(): ComposedPhrase {
    const t = this.theme;
    return t.phrases[t.order[this.orderIdx % t.order.length]!]!;
  }

  private get bar(): ComposedBar {
    return this.phrase.bars[this.phraseBar]!;
  }

  /** Audio time of `step` in the current bar (swing delays odd 16ths). */
  stepTime(step: number): number {
    const sw = this.theme.def.swing;
    return this.barTime + (step + (sw > 0 && step % 2 === 1 ? sw : 0)) * this.theme.stepDur;
  }

  private barDuration(bar: ComposedBar = this.bar): number {
    return bar.steps * this.theme.stepDur;
  }

  private advanceBar(): void {
    this.barTime += this.barDuration();
    this.barIndex++;
    this.phraseBar++;
    if (this.phraseBar >= this.phrase.bars.length) {
      this.phraseBar = 0;
      this.orderIdx = (this.orderIdx + 1) % this.theme.order.length;
    }
    this.eventIdx = 0;
    this.announced = false;
  }

  /**
   * Schedule everything starting before `horizon`. Returns the number of events handed out.
   * Events more than `maxLate` behind `now` are skipped (counted in `skipped`).
   */
  pump(now: number, horizon: number, sink: SequencerSink): number {
    if (!this.started) return 0;
    let count = 0;
    // A long stall (hidden tab, debugger): jump whole bars without announcing them.
    let guard = 0;
    while (this.barTime + this.barDuration() < now - this.maxLate && guard++ < 10000) {
      this.skipped += this.bar.events.length - this.eventIdx;
      this.advanceBar();
      this.jumped = true;
    }
    for (guard = 0; guard < 100000; guard++) {
      const bar = this.bar;
      if (!this.announced) {
        if (this.barTime >= horizon) break;
        const info = this.info;
        info.index = this.barIndex;
        info.phraseBar = this.phraseBar;
        info.phrase = this.phrase;
        info.bar = bar;
        info.time = this.barTime;
        info.duration = this.barDuration(bar);
        info.afterSkip = this.jumped;
        this.jumped = false;
        this.announced = true;
        sink.onBar(info);
      }
      if (this.eventIdx < bar.events.length) {
        const e = bar.events[this.eventIdx]!;
        const t = this.stepTime(e.step);
        if (t >= horizon) break;
        this.eventIdx++;
        if (t < now - this.maxLate) {
          this.skipped++;
          continue;
        }
        sink.onEvent(e, t, e.dur * this.theme.stepDur);
        count++;
        continue;
      }
      if (this.barTime + this.barDuration(bar) >= horizon) break;
      this.advanceBar();
    }
    return count;
  }

  /**
   * First grid point at or after `t` (bar lines, felt beats, half beats or steps), following the
   * meter of the coming bars. Before start(): `t`.
   */
  nextGrid(t: number, unit: GridUnit): number {
    if (!this.started) return t;
    const theme = this.theme;
    const unitSteps =
      unit === 'step' ? 1 : unit === 'half' ? Math.max(1, theme.def.beatSteps / 2) : theme.def.beatSteps;
    let barTime = this.barTime;
    let orderIdx = this.orderIdx;
    let phraseBar = this.phraseBar;
    for (let guard = 0; guard < 4096; guard++) {
      const phrase = theme.phrases[theme.order[orderIdx % theme.order.length]!]!;
      const bar = phrase.bars[phraseBar]!;
      const dur = bar.steps * theme.stepDur;
      if (barTime + dur > t || unit === 'bar') {
        if (unit === 'bar') {
          if (barTime >= t - 1e-9) return barTime;
        } else {
          for (let s = 0; s < bar.steps; s += unitSteps) {
            const at = barTime + s * theme.stepDur;
            if (at >= t - 1e-9) return at;
          }
        }
      }
      barTime += dur;
      phraseBar++;
      if (phraseBar >= phrase.bars.length) {
        phraseBar = 0;
        orderIdx++;
      }
    }
    return t;
  }

  /** Move the whole timeline by `dt` s (re-anchoring after a pause without suspension). */
  shift(dt: number): void {
    if (Number.isFinite(dt)) this.barTime += dt;
  }
}
