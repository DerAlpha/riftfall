/**
 * Rendered instrument samples per theme (M10). A theme's palette is rendered once (lazily, in the
 * background, limited parallelism) and cached: pitched slots at a root every
 * MUSIC.render.rootSpacing semitones over the slot's register (the sequencer resamples by at most a
 * tritone), percussion as a few seeded variants. Identical specs are shared between themes. `get`
 * never blocks: null until the theme is ready.
 */
import { createLogger } from '../../core/log';
import { INSTRUMENT_RECIPES, MUSIC, type InstrumentSlot, type MusicThemeDef } from '../../defs/music';
import { getThemeDef, rangeOf, stepDuration } from './composer';
import {
  DEFAULT_PARAMS,
  offlineSupported,
  renderInstrumentSample,
  type InstrumentRenderSpec,
  type RenderedSample,
} from './instruments';
import { midiHz } from './theory';

const log = createLogger('Music');

export interface Sample {
  readonly buffer: AudioBuffer;
  /** Rendered fundamental (Hz), 0 for unpitched samples. */
  readonly hz: number;
  /** Root note of pitched samples (nearest-root selection). */
  readonly midi: number;
  readonly loop: boolean;
}

export interface SampleSet {
  readonly slot: InstrumentSlot;
  /** Pitched: roots ascending; unpitched: variants. */
  readonly samples: readonly Sample[];
  readonly pitched: boolean;
  readonly loop: boolean;
  /** Mix gain of the instrument (InstrumentDef.gain). */
  readonly gain: number;
}

export interface ThemeSamples {
  readonly themeId: string;
  readonly slots: Readonly<Partial<Record<InstrumentSlot, SampleSet>>>;
  /** Bytes of sample data (debug). */
  readonly bytes: number;
}

/** Variants of unpitched slots (humanization; bar-long textures need one). */
const VARIANTS: Partial<Record<InstrumentSlot, number>> = {
  kick: 2,
  snare: 2,
  hat: 3,
  openHat: 1,
  metal: 2,
  perc: 2,
  fx: 2,
  scrape: 2,
};

/** Roots (MIDI) every `spacing` semitones so that every note of [lo, hi] is within spacing / 2. */
export function rootsFor(lo: number, hi: number, spacing: number = MUSIC.render.rootSpacing): number[] {
  const half = Math.floor(spacing / 2);
  const roots: number[] = [];
  for (let r = lo + half; r - half <= hi; r += spacing) roots.push(r);
  return roots;
}

/** Nearest rendered root of a pitched set (binary search not needed: ≤ 3 roots). */
export function nearestSample(set: SampleSet, note: number): Sample | null {
  let best: Sample | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const s of set.samples) {
    const d = Math.abs(s.midi - note);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

interface Job {
  readonly slot: InstrumentSlot;
  readonly spec: InstrumentRenderSpec;
  readonly midi: number;
}

function jobsFor(def: MusicThemeDef): Job[] {
  const jobs: Job[] = [];
  const bars = def.phraseBars;
  const lastBarSteps = def.meter[(bars - 1) % def.meter.length]!;
  const barSeconds = lastBarSteps * stepDuration(def);
  for (const [slot, inst] of Object.entries(def.palette) as [
    InstrumentSlot,
    NonNullable<MusicThemeDef['palette'][InstrumentSlot]>,
  ][]) {
    const info = INSTRUMENT_RECIPES[inst.recipe];
    const params = { ...DEFAULT_PARAMS, ...inst.params };
    const bar = 'bar' in info && info.bar === true;
    const key = `${inst.recipe}|${JSON.stringify(inst.params ?? {})}`;
    if (info.pitched) {
      const [lo, hi] = rangeOf(slot);
      for (const midi of rootsFor(lo, hi)) {
        jobs.push({
          slot,
          midi,
          spec: {
            recipe: inst.recipe,
            params,
            hz: midiHz(midi),
            barSeconds,
            seed: `${MUSIC.seed}:${key}:${midi}`,
          },
        });
      }
    } else {
      const variants = bar ? 1 : (VARIANTS[slot] ?? 1);
      for (let v = 0; v < variants; v++) {
        const barKey = bar ? `:${barSeconds.toFixed(4)}` : '';
        jobs.push({
          slot,
          midi: v,
          spec: {
            recipe: inst.recipe,
            params,
            hz: 0,
            barSeconds,
            seed: `${MUSIC.seed}:${key}:v${v}${barKey}`,
          },
        });
      }
    }
  }
  return jobs;
}

export class MusicBank {
  private readonly themes = new Map<string, ThemeSamples>();
  private readonly pending = new Map<string, Promise<ThemeSamples | null>>();
  private readonly samples = new Map<string, Promise<RenderedSample | null>>();
  readonly supported = offlineSupported();
  private disposed = false;

  /** Rendered samples of a theme, or null while rendering / unsupported. */
  get(themeId: string): ThemeSamples | null {
    return this.themes.get(getThemeDef(themeId).id) ?? null;
  }

  isLoading(themeId: string): boolean {
    return this.pending.has(getThemeDef(themeId).id);
  }

  /** Render (once) and cache a theme's palette. */
  load(themeId: string): Promise<ThemeSamples | null> {
    const def = getThemeDef(themeId);
    const ready = this.themes.get(def.id);
    if (ready) return Promise.resolve(ready);
    if (!this.supported) return Promise.resolve(null);
    let p = this.pending.get(def.id);
    if (!p) {
      p = this.render(def)
        .then((t) => {
          if (t && !this.disposed) this.themes.set(def.id, t);
          return t;
        })
        .catch((err: unknown) => {
          log.error(`Rendering music theme "${def.id}" failed`, err);
          return null;
        })
        .finally(() => this.pending.delete(def.id));
      this.pending.set(def.id, p);
    }
    return p;
  }

  get stats(): { themes: number; bytes: number } {
    let bytes = 0;
    for (const t of this.themes.values()) bytes += t.bytes;
    return { themes: this.themes.size, bytes };
  }

  dispose(): void {
    this.disposed = true;
    this.themes.clear();
    this.samples.clear();
  }

  private sample(spec: InstrumentRenderSpec): Promise<RenderedSample | null> {
    const key = `${spec.seed}|${spec.hz.toFixed(3)}|${spec.barSeconds.toFixed(4)}`;
    let p = this.samples.get(key);
    if (!p) {
      p = renderInstrumentSample(spec).catch((err: unknown) => {
        log.warn(`Instrument "${spec.recipe}" failed to render`, err);
        return null;
      });
      this.samples.set(key, p);
    }
    return p;
  }

  private async render(def: MusicThemeDef): Promise<ThemeSamples | null> {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const jobs = jobsFor(def);
    const results: (RenderedSample | null)[] = new Array(jobs.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < jobs.length && !this.disposed) {
        const idx = next++;
        results[idx] = await this.sample(jobs[idx]!.spec);
      }
    };
    await Promise.all(Array.from({ length: MUSIC.render.concurrency }, worker));
    if (this.disposed) return null;
    const slots: Partial<Record<InstrumentSlot, SampleSet>> = {};
    const lists = new Map<InstrumentSlot, Sample[]>();
    let bytes = 0;
    jobs.forEach((job, idx) => {
      const r = results[idx];
      if (!r) return;
      let list = lists.get(job.slot);
      if (!list) {
        list = [];
        lists.set(job.slot, list);
      }
      list.push({ buffer: r.buffer, hz: r.hz, midi: job.midi, loop: r.loop });
      bytes += r.buffer.length * r.buffer.numberOfChannels * 4;
    });
    for (const [slot, list] of lists) {
      const inst = def.palette[slot]!;
      const info = INSTRUMENT_RECIPES[inst.recipe];
      slots[slot] = { slot, samples: list, pitched: info.pitched, loop: info.loop, gain: inst.gain };
    }
    if (typeof performance !== 'undefined') {
      log.debug(
        `Music theme "${def.id}": ${jobs.length} samples, ${(bytes / 1048576).toFixed(1)} MB in ${(performance.now() - t0).toFixed(0)} ms`,
      );
    }
    return { themeId: def.id, slots, bytes };
  }
}
