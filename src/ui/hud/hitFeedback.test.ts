import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera } from 'three';
import { HUD } from '../../defs/ui';
import {
  DamageNumberModel,
  HitmarkerState,
  KillStreak,
  ammoPrompt,
  damageNumberMotion,
  distanceScale,
  formatDamage,
  hitmarkerVariant,
  isLowAmmo,
  projectToScreen,
  type MarkerSample,
} from './hitFeedback';

const V = HUD.hitmarker.variants;

describe('hitmarker', () => {
  it('maps damage events to variants: kill > crit > hit, shield reads as blocked', () => {
    expect(hitmarkerVariant('body', false)).toBe('hit');
    expect(hitmarkerVariant('limb', false)).toBe('hit');
    expect(hitmarkerVariant('head', false)).toBe('crit');
    expect(hitmarkerVariant('weakpoint', false)).toBe('crit');
    expect(hitmarkerVariant('shield', false)).toBe('shield');
    expect(hitmarkerVariant('limb', true)).toBe('kill');
    expect(hitmarkerVariant('shield', true)).toBe('kill');
  });

  it('pops, holds and fades out', () => {
    const m = new HitmarkerState();
    const s: MarkerSample = { scale: 0, opacity: 0 };
    expect(m.active).toBe(false);
    expect(m.sample(false, s).opacity).toBe(0);
    m.trigger('hit');
    m.sample(false, s);
    expect(s.scale).toBeCloseTo(V.hit.popScale * V.hit.size, 5);
    expect(s.opacity).toBe(1);
    m.step(V.hit.popTime);
    expect(m.sample(false, s).scale).toBeCloseTo(V.hit.size, 5);
    m.step(V.hit.duration - V.hit.popTime - V.hit.fade / 2);
    const mid = m.sample(false, s).opacity;
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    m.step(V.hit.fade);
    expect(m.active).toBe(false);
    expect(m.sample(false, s).opacity).toBe(0);
  });

  it('keeps a kill marker during its hold, then lets lower hits replace it', () => {
    const m = new HitmarkerState();
    m.trigger('kill');
    m.step(V.kill.hold / 2);
    m.trigger('hit');
    expect(m.variant).toBe('kill');
    m.step(V.kill.hold);
    m.trigger('hit');
    expect(m.variant).toBe('hit');
    expect(m.age).toBe(0);
    // Higher ranks always win immediately.
    m.trigger('crit');
    expect(m.variant).toBe('crit');
  });

  it('is gentler with reduce flashing', () => {
    const m = new HitmarkerState();
    const s: MarkerSample = { scale: 0, opacity: 0 };
    m.trigger('kill');
    m.sample(true, s);
    expect(s.scale).toBeCloseTo(HUD.hitmarker.reducedPopScale * V.kill.size, 5);
    expect(s.opacity).toBeCloseTo(HUD.hitmarker.reducedOpacity, 5);
  });
});

describe('damage numbers', () => {
  const W = HUD.damageNumbers.mergeWindow;

  it('merges hits on one target within the merge window (pellets) and pops again', () => {
    const model = new DamageNumberModel(8, W, 1, () => 0.5);
    const a = model.add(7, 14, 'body', false, 1, 2, 3)!;
    model.step(W / 2);
    const b = model.add(7, 14, 'head', false, 9, 9, 9)!;
    expect(b).toBe(a);
    expect(a.amount).toBe(28);
    expect(a.crit).toBe(true);
    expect(a.sinceAdd).toBe(0);
    // The anchor stays at the first hit (no jumping numbers).
    expect([a.x, a.y, a.z]).toEqual([1, 2, 3]);
    expect(model.activeCount).toBe(1);
  });

  it('starts a new number after the window or for another target', () => {
    const model = new DamageNumberModel(8, W, 1, () => 0.5);
    const a = model.add(1, 10, 'body', false, 0, 0, 0)!;
    model.step(W * 1.5);
    const b = model.add(1, 10, 'body', false, 0, 0, 0)!;
    const c = model.add(2, 10, 'body', false, 0, 0, 0)!;
    expect(b).not.toBe(a);
    expect(c).not.toBe(b);
    expect(model.activeCount).toBe(3);
  });

  it('marks kills, keeps shield-only numbers flagged and ignores zero damage', () => {
    const model = new DamageNumberModel(4, W, 1, () => 0.5);
    expect(model.add(1, 0, 'body', false, 0, 0, 0)).toBeNull();
    expect(model.add(1, Number.NaN, 'body', false, 0, 0, 0)).toBeNull();
    const s = model.add(3, 20, 'shield', false, 0, 0, 0)!;
    expect(s.shield).toBe(true);
    model.add(3, 20, 'body', true, 0, 0, 0);
    expect(s.shield).toBe(false);
    expect(s.kill).toBe(true);
    // A killed target's number is final.
    const next = model.add(3, 5, 'body', false, 0, 0, 0)!;
    expect(next).not.toBe(s);
  });

  it('recycles the oldest number when the pool is full and expires after the lifetime', () => {
    const model = new DamageNumberModel(2, W, 1, () => 0.5);
    const a = model.add(1, 1, 'body', false, 0, 0, 0)!;
    model.step(0.2);
    const b = model.add(2, 1, 'body', false, 0, 0, 0)!;
    model.step(0.2);
    const c = model.add(3, 1, 'body', false, 0, 0, 0)!;
    expect(c).toBe(a);
    expect(c.targetId).toBe(3);
    model.step(1);
    expect(b.active).toBe(false);
    expect(model.activeCount).toBe(0);
  });

  it('formats whole numbers and animates rise, pop and fade', () => {
    expect(formatDamage(27.6)).toBe('28');
    expect(formatDamage(0.2)).toBe('1');
    const model = new DamageNumberModel(1, W, HUD.damageNumbers.lifetime, () => 0);
    const n = model.add(1, 10, 'head', false, 0, 0, 0)!;
    const m = { scale: 0, rise: 0, opacity: 0 };
    damageNumberMotion(n, m);
    expect(m.scale).toBeCloseTo(HUD.damageNumbers.critScale * HUD.damageNumbers.popScale, 5);
    expect(m.rise).toBe(0);
    expect(m.opacity).toBe(1);
    model.step(HUD.damageNumbers.lifetime - 0.01);
    damageNumberMotion(n, m);
    expect(m.rise).toBeCloseTo(HUD.damageNumbers.risePx, 0);
    expect(m.opacity).toBeLessThan(0.1);
    expect(m.scale).toBeCloseTo(HUD.damageNumbers.critScale, 5);
  });
});

describe('kill streak', () => {
  it('counts kills within the window and resets after it', () => {
    const k = new KillStreak(2);
    expect(k.onKill()).toBe(1);
    k.step(1.5);
    expect(k.onKill()).toBe(2);
    k.step(1.9);
    expect(k.onKill()).toBe(3);
    k.step(2.5);
    expect(k.count).toBe(0);
    expect(k.onKill()).toBe(1);
  });
});

describe('projection', () => {
  const cam = new PerspectiveCamera(70, 16 / 9, 0.05, 500);
  cam.position.set(0, 1.7, 0);
  cam.updateMatrixWorld();
  const vp = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const out = { x: 0, y: 0, w: 0 };

  it('maps a point straight ahead to the viewport center with its depth', () => {
    expect(projectToScreen(vp.elements, 0, 1.7, -10, 1600, 900, out)).toBe(true);
    expect(out.x).toBeCloseTo(800, 3);
    expect(out.y).toBeCloseTo(450, 3);
    expect(out.w).toBeCloseTo(10, 3);
  });

  it('puts higher points above and right points right (screen y grows downwards)', () => {
    projectToScreen(vp.elements, 1, 2.7, -10, 1600, 900, out);
    expect(out.x).toBeGreaterThan(800);
    expect(out.y).toBeLessThan(450);
  });

  it('rejects points behind the camera or far off-screen', () => {
    expect(projectToScreen(vp.elements, 0, 1.7, 10, 1600, 900, out)).toBe(false);
    expect(projectToScreen(vp.elements, 100, 1.7, -1, 1600, 900, out)).toBe(false);
  });

  it('scales labels down with distance, never below the minimum', () => {
    const D = HUD.damageNumbers;
    expect(distanceScale(1)).toBe(1);
    expect(distanceScale(D.refDistance * 1.5)).toBeCloseTo(1 / 1.5, 5);
    expect(distanceScale(1000)).toBe(D.minScale);
    expect(distanceScale(Number.NaN)).toBe(1);
  });
});

describe('ammo state', () => {
  it('prompts NACHLADEN on an empty magazine, KEINE MUNITION when fully out, nothing while reloading', () => {
    expect(ammoPrompt(5, 20, false)).toBe('none');
    expect(ammoPrompt(0, 20, false)).toBe('reload');
    expect(ammoPrompt(0, 0, false)).toBe('empty');
    expect(ammoPrompt(0, 20, true)).toBe('none');
  });

  it('warns at a quarter of the magazine', () => {
    expect(isLowAmmo(8, 32)).toBe(true);
    expect(isLowAmmo(9, 32)).toBe(false);
    expect(isLowAmmo(0, 32)).toBe(false);
    expect(isLowAmmo(2, 8)).toBe(true);
    expect(isLowAmmo(1, 1)).toBe(false);
  });
});
