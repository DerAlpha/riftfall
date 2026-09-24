import { describe, expect, it } from 'vitest';
import { MUSIC } from '../../defs/music';
import { IntensityModel, LayerMixer, layerMask, threatOf } from './intensity';

const I = MUSIC.intensity;
const at = (x: number, z = 0) => ({ x, y: 0, z });

function run(m: IntensityModel, seconds: number, dt = 1 / 60): number {
  for (let t = 0; t < seconds; t += dt) m.update(dt);
  return m.value;
}

describe('music intensity model', () => {
  it('weighs nearby enemies by distance, type and elite', () => {
    const origin = at(0);
    expect(threatOf([], origin)).toBe(0);
    const near = threatOf([{ alive: true, type: 'spitter', position: at(2) }], origin);
    const mid = threatOf([{ alive: true, type: 'spitter', position: at((I.near + I.radius) / 2) }], origin);
    const far = threatOf([{ alive: true, type: 'spitter', position: at(I.radius + 1) }], origin);
    expect(near).toBeCloseTo(1);
    expect(mid).toBeCloseTo(0.5);
    expect(far).toBe(0);
    expect(threatOf([{ alive: false, type: 'tank', position: at(1) }], origin)).toBe(0);
    expect(threatOf([{ alive: true, type: 'tank', position: at(1) }], origin)).toBeCloseTo(
      I.typeWeight.tank!,
    );
    expect(threatOf([{ alive: true, type: 'spitter', elite: true, position: at(1) }], origin)).toBeCloseTo(
      I.eliteWeight,
    );
  });

  it('rises with threat, damage, kills and low health, fast up and slowly down', () => {
    const m = new IntensityModel();
    expect(run(m, 2)).toBe(0);
    m.setThreat(8);
    const up = run(m, 3);
    expect(up).toBeGreaterThan(0.3);
    m.setThreat(0);
    const oneSecondLater = run(m, 1);
    // Falls slower than it rose.
    expect(up - oneSecondLater).toBeLessThan(up * 0.3);
    expect(run(m, 40)).toBeLessThan(0.05);

    m.addDamage(I.fullDamage);
    expect(run(m, 2)).toBeGreaterThan(0.1);
    expect(run(m, 40)).toBeLessThan(0.05);

    for (let k = 0; k < 6; k++) {
      m.addKill();
      run(m, 0.5);
    }
    expect(m.value).toBeGreaterThan(0.08);

    const hurt = new IntensityModel();
    hurt.setHealth(0.1);
    expect(hurt.danger).toBeGreaterThan(0.5);
    expect(run(hurt, 5)).toBeGreaterThan(0.1);
  });

  it('pushes the start of a wave and raises the base with the wave number', () => {
    const m = new IntensityModel();
    m.waveStarted(1);
    const start = run(m, 3);
    expect(start).toBeGreaterThan(0.2);
    expect(run(m, I.wave.startSeconds + 30)).toBeLessThan(0.05);
    const late = new IntensityModel();
    late.waveStarted(12);
    run(late, I.wave.startSeconds + 30);
    expect(late.value).toBeCloseTo(Math.min(I.wave.perWaveMax, I.wave.perWave * 11), 2);
    late.waveEnded();
    expect(run(late, 40)).toBeLessThan(0.02);
  });

  it('lets the spawn director win while it keeps sending, and the dev console win over both', () => {
    const m = new IntensityModel();
    m.setThreat(20);
    run(m, 5);
    expect(m.source).toBe('model');
    m.setOverride(0.1, 'director');
    expect(m.source).toBe('director');
    expect(run(m, 3)).toBeCloseTo(0.1, 1);
    // The director went quiet: the model takes over again.
    run(m, I.directorTimeout);
    expect(m.source).toBe('model');
    m.setOverride(0.9, 'director');
    m.setOverride(0.3, 'dev');
    m.update(1 / 60);
    expect(m.source).toBe('dev');
    expect(m.value).toBe(0.3);
    m.setOverride(null, 'dev');
    expect(m.source).toBe('director');
    m.setOverride(null, 'director');
    expect(m.source).toBe('model');
    // Invalid values release the override instead of poisoning the value.
    m.setOverride(Number.NaN, 'dev');
    expect(m.source).toBe('model');
  });
});

describe('layer mixer', () => {
  const ALL = layerMask(['ambient', 'low', 'mid', 'high', 'peak']);
  const T = MUSIC.layers.thresholds;

  it('switches layers with hysteresis and a minimum dwell in bars', () => {
    const mix = new LayerMixer();
    mix.evaluate(0, 0, ALL);
    expect(mix.on).toEqual([true, false, false, false, false]);
    mix.evaluate(T.mid.on + 0.01, 1, ALL);
    expect(mix.on).toEqual([true, true, true, false, false]);
    // Just below `on` but above `off`: stays on.
    mix.evaluate(T.mid.on - 0.02, 5, ALL);
    expect(mix.on[2]).toBe(true);
    // Below `off`, but it only just turned on: it waits for minBars.
    const fresh = new LayerMixer();
    fresh.evaluate(T.mid.on + 0.01, 0, ALL);
    fresh.evaluate(T.mid.off - 0.05, 1, ALL);
    expect(fresh.on[2]).toBe(true);
    fresh.evaluate(T.mid.off - 0.05, MUSIC.layers.minBars, ALL);
    expect(fresh.on[2]).toBe(false);
    // Full intensity: everything.
    mix.evaluate(1, 10, ALL);
    expect(mix.on.every(Boolean)).toBe(true);
  });

  it('drops layers the state does not allow at once and reports changes as a mask', () => {
    const mix = new LayerMixer();
    mix.evaluate(1, 0, ALL);
    const changed = mix.evaluate(1, 1, layerMask(['ambient']));
    expect(mix.on).toEqual([true, false, false, false, false]);
    expect(changed).toBe(layerMask(['low', 'mid', 'high', 'peak']));
    expect(mix.evaluate(1, 2, layerMask(['ambient']))).toBe(0);
  });

  it('plays a layer partially just above its threshold and fully above the span', () => {
    const mix = new LayerMixer();
    mix.evaluate(1, 0, ALL);
    expect(mix.share(1, T.low.on)).toBeCloseTo(MUSIC.layers.partialGain);
    expect(mix.share(1, T.low.on + MUSIC.layers.span)).toBeCloseTo(1);
    mix.reset();
    expect(mix.share(1, 1)).toBe(0);
  });
});
