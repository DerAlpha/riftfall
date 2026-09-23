import { describe, expect, it } from 'vitest';
import { Rng } from '../core/Rng';
import { WEAPONS, type WeaponRecoilDef } from '../defs/weapons';
import {
  burstShotIndex,
  compensateRecoil,
  createRecoilState,
  patternIndex,
  recoilKick,
  recoilMultiplier,
  recoverRecoil,
  resetRecoil,
  type RecoilKick,
} from './recoil';

const RIFLE = WEAPONS.rifle.recoil;
const noRandom = (def: WeaponRecoilDef): WeaponRecoilDef => ({ ...def, randomYaw: 0, randomPitch: 0 });

describe('recoil pattern', () => {
  it('steps through the pattern and loops from patternRepeatFrom', () => {
    const n = RIFLE.pattern.length;
    expect(patternIndex(RIFLE, 0)).toBe(0);
    expect(patternIndex(RIFLE, n - 1)).toBe(n - 1);
    expect(patternIndex(RIFLE, n)).toBe(RIFLE.patternRepeatFrom);
    expect(patternIndex(RIFLE, n + (n - RIFLE.patternRepeatFrom))).toBe(RIFLE.patternRepeatFrom);
    expect(patternIndex({ ...RIFLE, pattern: [] }, 3)).toBe(-1);
    // Single-entry patterns repeat forever.
    expect(patternIndex(WEAPONS.pistol.recoil, 50)).toBeGreaterThanOrEqual(0);
  });

  it('rifle pattern reads vertical first, then drifts right, then left', () => {
    const p = RIFLE.pattern;
    for (let i = 0; i < 5; i++) expect(Math.abs(p[i]![0])).toBeLessThan(0.1);
    const right = p.slice(7, 14).reduce((s, e) => s + e[0], 0);
    const left = p.slice(15, 22).reduce((s, e) => s + e[0], 0);
    expect(right).toBeGreaterThan(1);
    expect(left).toBeLessThan(-1);
    for (const e of p) expect(e[1]).toBeGreaterThan(0);
  });

  it('kicks accumulate the unrecovered offset; seeded randomness is deterministic', () => {
    const def = noRandom(RIFLE);
    const s = createRecoilState();
    const out: RecoilKick = { yaw: 0, pitch: 0 };
    const rng = new Rng(1);
    recoilKick(def, s, rng, 1, out);
    expect(out.pitch).toBeCloseTo(def.pattern[0]![1], 12);
    recoilKick(def, s, rng, 0.5, out);
    expect(out.pitch).toBeCloseTo(def.pattern[1]![1] * 0.5, 12);
    expect(s.pitch).toBeCloseTo(def.pattern[0]![1] + def.pattern[1]![1] * 0.5, 12);
    expect(s.shotIndex).toBe(2);

    const a = createRecoilState();
    const b = createRecoilState();
    const ra = new Rng('x');
    const rb = new Rng('x');
    const oa: RecoilKick = { yaw: 0, pitch: 0 };
    const ob: RecoilKick = { yaw: 0, pitch: 0 };
    for (let i = 0; i < 10; i++) {
      recoilKick(RIFLE, a, ra, 1, oa);
      recoilKick(RIFLE, b, rb, 1, ob);
      expect(oa).toEqual(ob);
      expect(Math.abs(oa.yaw - RIFLE.pattern[i]![0])).toBeLessThanOrEqual(RIFLE.randomYaw + 1e-12);
    }
  });

  it('pattern restarts after the reset time', () => {
    const def = noRandom(RIFLE);
    const s = createRecoilState();
    const out: RecoilKick = { yaw: 0, pitch: 0 };
    const rng = new Rng(2);
    expect(burstShotIndex(def, s)).toBe(0);
    for (let i = 0; i < 5; i++) recoilKick(def, s, rng, 1, out);
    expect(burstShotIndex(def, s)).toBe(5);
    recoverRecoil(def, s, def.resetTime + 0.01, out);
    // The next shot starts a new burst (weapon:fired reports its index before the kick).
    expect(burstShotIndex(def, s)).toBe(0);
    recoilKick(def, s, rng, 1, out);
    expect(out.pitch).toBeCloseTo(def.pattern[0]![1], 12);
    expect(burstShotIndex(def, s)).toBe(1);
  });

  it('stance multiplier blends ADS and crouch', () => {
    expect(recoilMultiplier(RIFLE, 0, false)).toBe(1);
    expect(recoilMultiplier(RIFLE, 1, false)).toBeCloseTo(RIFLE.adsMultiplier, 12);
    expect(recoilMultiplier(RIFLE, 1, true)).toBeCloseTo(RIFLE.adsMultiplier * RIFLE.crouchMultiplier, 12);
  });
});

describe('recoil recovery', () => {
  const def = noRandom(RIFLE);

  it('waits for the delay, then returns to the origin at recoveryPerSec', () => {
    const s = createRecoilState();
    const out: RecoilKick = { yaw: 0, pitch: 0 };
    recoilKick(def, s, new Rng(3), 1, out);
    const kick = s.pitch;
    recoverRecoil(def, s, def.recoveryDelay * 0.5, out);
    expect(out.pitch).toBe(0);
    let total = 0;
    for (let i = 0; i < 600; i++) {
      recoverRecoil(def, s, 1 / 60, out);
      total += out.pitch;
    }
    expect(total).toBeCloseTo(-kick, 9);
    expect(s.pitch).toBe(0);
    expect(s.yaw).toBe(0);
  });

  it('recovery rate is linear: one tick recovers recoveryPerSec·dt', () => {
    const s = createRecoilState();
    s.pitch = 10;
    s.sinceShot = def.recoveryDelay + 1;
    const out: RecoilKick = { yaw: 0, pitch: 0 };
    recoverRecoil(def, s, 0.1, out);
    expect(out.pitch).toBeCloseTo(-def.recoveryPerSec * 0.1, 9);
  });

  it('players who pull down keep their aim: compensation consumes the unrecovered part', () => {
    const s = createRecoilState();
    const out: RecoilKick = { yaw: 0, pitch: 0 };
    recoilKick(def, s, new Rng(4), 1, out);
    recoilKick(def, s, new Rng(4), 1, out);
    const kicked = s.pitch;
    // Pull down by exactly the kick: nothing left to recover.
    compensateRecoil(s, 0, -kicked);
    expect(s.pitch).toBe(0);
    let total = 0;
    for (let i = 0; i < 300; i++) {
      recoverRecoil(def, s, 1 / 60, out);
      total += out.pitch;
    }
    expect(total).toBe(0);

    // Over-compensation never flips the offset; moving with the recoil keeps it.
    const t = createRecoilState();
    t.pitch = 2;
    t.yaw = -1;
    compensateRecoil(t, 0, -5);
    expect(t.pitch).toBe(0);
    compensateRecoil(t, -3, 0);
    expect(t.yaw).toBe(-1);
    compensateRecoil(t, 0.4, 0);
    expect(t.yaw).toBeCloseTo(-0.6, 12);
    // Partial pull: only the rest is recovered.
    const u = createRecoilState();
    u.pitch = 3;
    compensateRecoil(u, 0, -1);
    expect(u.pitch).toBe(2);
  });

  it('reset clears everything', () => {
    const s = createRecoilState();
    s.pitch = 3;
    s.shotIndex = 5;
    resetRecoil(s);
    expect(s).toEqual(createRecoilState());
  });
});
