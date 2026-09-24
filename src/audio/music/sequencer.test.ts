import { describe, expect, it } from 'vitest';
import { MUSIC } from '../../defs/music';
import { composeTheme, type NoteEvent } from './composer';
import { Sequencer, type BarInfo, type SequencerSink } from './sequencer';

class Recorder implements SequencerSink {
  readonly bars: { index: number; time: number; duration: number; steps: number }[] = [];
  readonly skips: boolean[] = [];
  readonly events: { e: NoteEvent; time: number; bar: number }[] = [];
  onBar(info: BarInfo): void {
    this.bars.push({ index: info.index, time: info.time, duration: info.duration, steps: info.bar.steps });
    this.skips.push(info.afterSkip);
  }
  onEvent(e: NoteEvent, time: number): void {
    this.events.push({ e, time, bar: this.bars.length - 1 });
  }
}

const LOOKAHEAD = MUSIC.scheduler.lookahead;
const INTERVAL = MUSIC.scheduler.interval;

describe('music sequencer', () => {
  it('schedules only inside the lookahead window and every event exactly once', () => {
    const theme = composeTheme('lab');
    const seq = new Sequencer(theme);
    const rec = new Recorder();
    seq.start(1);
    for (let now = 1; now < 1 + 30; now += INTERVAL) {
      const before = rec.events.length;
      seq.pump(now, now + LOOKAHEAD, rec);
      for (const ev of rec.events.slice(before)) {
        expect(ev.time).toBeLessThan(now + LOOKAHEAD);
        expect(ev.time).toBeGreaterThanOrEqual(now - MUSIC.scheduler.maxLate);
      }
    }
    // Everything of the complete bars was handed out once, in time order.
    const barDur = 16 * theme.stepDur;
    const fullBars = Math.floor(30 / barDur) - 1;
    let expected = 0;
    for (let b = 0; b < fullBars; b++) {
      const phrase = theme.phrases[theme.order[Math.floor(b / 8) % theme.order.length]!]!;
      expected += phrase.bars[b % 8]!.events.length;
    }
    const inFull = rec.events.filter((ev) => ev.time < 1 + fullBars * barDur - 1e-6);
    expect(inFull).toHaveLength(expected);
    for (let k = 1; k < rec.events.length; k++) {
      expect(rec.events[k]!.time).toBeGreaterThanOrEqual(rec.events[k - 1]!.time - 1e-9);
    }
    expect(seq.skipped).toBe(0);
  });

  it('announces each bar once on the bar line, before its events (bar-quantized decisions)', () => {
    const theme = composeTheme('rift');
    const seq = new Sequencer(theme);
    const rec = new Recorder();
    seq.start(0);
    for (let now = 0; now < 20; now += INTERVAL) seq.pump(now, now + LOOKAHEAD, rec);
    const meter = theme.def.meter;
    let t = 0;
    rec.bars.forEach((b, i) => {
      expect(b.index).toBe(i);
      expect(b.steps).toBe(meter[i % meter.length]);
      expect(b.time).toBeCloseTo(t, 9);
      t += b.steps * theme.stepDur;
    });
    for (const ev of rec.events) {
      const bar = rec.bars[ev.bar]!;
      expect(ev.time).toBeGreaterThanOrEqual(bar.time - 1e-9);
      expect(ev.time).toBeLessThan(bar.time + bar.duration);
    }
  });

  it('skips what a stalled timer missed instead of bursting it', () => {
    const seq = new Sequencer(composeTheme('lab'));
    const rec = new Recorder();
    seq.start(0);
    seq.pump(0, LOOKAHEAD, rec);
    const first = rec.events.length;
    // The timer comes back 5 s late.
    seq.pump(5, 5 + LOOKAHEAD, rec);
    const late = rec.events.slice(first);
    expect(seq.skipped).toBeGreaterThan(0);
    for (const ev of late) expect(ev.time).toBeGreaterThanOrEqual(5 - MUSIC.scheduler.maxLate);
    // The first bar after the jump asks for its sustained notes to be re-struck.
    expect(rec.skips.at(-1)).toBe(true);
    const bars = rec.skips.length;
    for (let now = 5; rec.skips.length === bars; now += INTERVAL) seq.pump(now, now + LOOKAHEAD, rec);
    expect(rec.skips.at(-1)).toBe(false);
  });

  it('finds the next beat / half beat / bar line for quantized stings and theme starts', () => {
    const theme = composeTheme('lab');
    const seq = new Sequencer(theme);
    expect(seq.nextGrid(3.3, 'beat')).toBe(3.3);
    seq.start(2);
    const beat = 4 * theme.stepDur;
    expect(seq.nextGrid(2, 'beat')).toBeCloseTo(2);
    expect(seq.nextGrid(2 + 0.1, 'beat')).toBeCloseTo(2 + beat);
    expect(seq.nextGrid(2 + beat + 0.01, 'half')).toBeCloseTo(2 + beat * 1.5);
    expect(seq.nextGrid(2 + 0.01, 'bar')).toBeCloseTo(2 + 16 * theme.stepDur);
    // 6/8: the felt beat is a dotted quarter (6 steps).
    const arctic = new Sequencer(composeTheme('arctic'));
    arctic.start(0);
    expect(arctic.nextGrid(0.01, 'beat')).toBeCloseTo(6 * arctic.stepDur);
  });

  it('delays odd 16ths by the swing amount', () => {
    const t = composeTheme('biodome');
    const seq = new Sequencer(t);
    seq.start(0);
    expect(seq.stepTime(2)).toBeCloseTo(2 * t.stepDur);
    expect(seq.stepTime(3)).toBeCloseTo((3 + t.def.swing) * t.stepDur);
  });
});
