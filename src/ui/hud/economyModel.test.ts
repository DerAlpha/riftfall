import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, PAD, type BindingMap } from '../../defs/input';
import { ECONOMY_HUD } from '../../defs/ui';
import { cloneBindingMap } from '../../input/bindings';
import {
  BannerQueue,
  PointsPopupModel,
  PointsRoll,
  costState,
  formatPoints,
  formatPopup,
  interactKeyCap,
  popupMotion,
  popupTone,
  rollDuration,
  timerRing,
  type EconomyBanner,
} from './economyModel';

const PO = ECONOMY_HUD.popups;

describe('points formatting', () => {
  it('groups thousands the German way and marks signs', () => {
    expect(formatPoints(0)).toBe('0');
    expect(formatPoints(950)).toBe('950');
    expect(formatPoints(1500)).toBe('1.500');
    expect(formatPoints(12340)).toBe('12.340');
    expect(formatPoints(1234567)).toBe('1.234.567');
    expect(formatPoints(-2500)).toBe('−2.500');
    expect(formatPoints(Number.NaN)).toBe('0');
    expect(formatPopup(60)).toBe('+60');
    expect(formatPopup(-950)).toBe('−950');
    expect(formatPopup(1200)).toBe('+1.200');
  });

  it('colours popups by reason; spending is always red', () => {
    expect(popupTone(10, 'hit')).toBe('normal');
    expect(popupTone(60, 'kill')).toBe('normal');
    expect(popupTone(100, 'headshot')).toBe('head');
    expect(popupTone(10, 'repair')).toBe('repair');
    expect(popupTone(400, 'nuke')).toBe('bonus');
    expect(popupTone(200, 'carpenter')).toBe('bonus');
    expect(popupTone(-950, 'purchase')).toBe('spend');
    expect(popupTone(-500, 'dev')).toBe('spend');
  });
});

describe('PointsRoll', () => {
  it('rolls with ease-out towards the balance, longer for bigger changes', () => {
    expect(rollDuration(0)).toBe(0);
    expect(rollDuration(10)).toBeLessThan(rollDuration(1000));
    expect(rollDuration(1e9)).toBe(ECONOMY_HUD.points.roll.maxSeconds);
    const r = new PointsRoll();
    r.set(500, false);
    expect(r.shown).toBe(500);
    expect(r.rolling).toBe(false);
    r.set(1500, true);
    expect(r.rolling).toBe(true);
    expect(r.shown).toBe(500);
    const dur = rollDuration(1000);
    r.update(dur * 0.25);
    const quarter = r.shown;
    // Ease-out: past the linear quarter point after a quarter of the time.
    expect(quarter).toBeGreaterThan(750);
    expect(quarter).toBeLessThan(1500);
    r.update(dur);
    expect(r.shown).toBe(1500);
    expect(r.rolling).toBe(false);
  });

  it('continues from the shown value when the target changes mid-roll, and snaps when told', () => {
    const r = new PointsRoll();
    r.set(0, false);
    r.set(1000, true);
    r.update(rollDuration(1000) * 0.5);
    const mid = r.shown;
    r.set(0, true);
    expect(r.shown).toBe(mid);
    r.update(0.001);
    expect(r.shown).toBeLessThanOrEqual(mid);
    r.set(777, false);
    expect(r.shown).toBe(777);
    expect(r.target).toBe(777);
  });
});

describe('PointsPopupModel', () => {
  it('pools popups, reuses the oldest when full and ignores zero deltas', () => {
    const m = new PointsPopupModel(3);
    expect(m.push(0, 'dev')).toBeNull();
    const a = m.push(60, 'kill')!;
    m.update(PO.mergeWindow + 0.01);
    const b = m.push(100, 'headshot')!;
    m.update(PO.mergeWindow + 0.01);
    const c = m.push(-950, 'purchase')!;
    expect(new Set([a, b, c]).size).toBe(3);
    expect(m.activeCount).toBe(3);
    m.update(PO.mergeWindow + 0.01);
    const d = m.push(10, 'repair')!;
    // The pool is full: the oldest popup (a) is reused, nothing is allocated.
    expect(d).toBe(a);
    expect(m.items).toHaveLength(3);
    expect(d.amount).toBe(10);
    expect(d.tone).toBe('repair');
    expect(d.age).toBe(0);
  });

  it('merges earnings of one tone within the merge window (a shotgun blast)', () => {
    const m = new PointsPopupModel(4);
    const first = m.push(10, 'hit')!;
    const v = first.version;
    expect(m.push(10, 'hit')).toBe(first);
    expect(m.push(10, 'kill')).toBe(first);
    expect(first.amount).toBe(30);
    expect(first.version).toBeGreaterThan(v);
    // Another tone does not merge.
    expect(m.push(100, 'headshot')).not.toBe(first);
    m.update(PO.mergeWindow + 0.05);
    const later = m.push(10, 'hit')!;
    expect(later).not.toBe(first);
  });

  it('alternates lanes, expires after its lifetime and clears', () => {
    const m = new PointsPopupModel(4);
    const a = m.push(10, 'hit')!;
    m.update(PO.mergeWindow + 0.01);
    const b = m.push(-10, 'purchase')!;
    expect(a.lane).not.toBe(b.lane);
    m.update(PO.lifetime);
    expect(m.activeCount).toBe(0);
    m.push(10, 'hit');
    m.clear();
    expect(m.activeCount).toBe(0);
  });

  it('rises, pops and fades over its lifetime', () => {
    const out = { rise: 0, scale: 0, opacity: 0 };
    popupMotion(0, out);
    expect(out.rise).toBe(0);
    expect(out.scale).toBeCloseTo(PO.popScale);
    expect(out.opacity).toBe(1);
    popupMotion(PO.lifetime * 0.5, out);
    expect(out.rise).toBeGreaterThan(PO.risePx * 0.5);
    expect(out.scale).toBe(1);
    expect(out.opacity).toBe(1);
    popupMotion(PO.lifetime, out);
    expect(out.rise).toBeCloseTo(PO.risePx);
    expect(out.opacity).toBe(0);
  });
});

describe('interaction key caps and cost states', () => {
  it('uses the first binding of the active device family', () => {
    const cap = interactKeyCap(DEFAULT_BINDINGS, 'kbm');
    expect(cap).toEqual({ label: 'F', pad: false, face: '' });
    const pad = interactKeyCap(DEFAULT_BINDINGS, 'gamepad');
    expect(pad).toEqual({ label: 'X', pad: true, face: 'x' });
  });

  it('follows rebinding, the keyboard layout, mouse / pad buttons and unbound actions', () => {
    const map: BindingMap = cloneBindingMap(DEFAULT_BINDINGS);
    map.interact = [
      { device: 'key', code: 'KeyZ' },
      { device: 'pad', button: PAD.A },
    ];
    expect(interactKeyCap(map, 'kbm').label).toBe('Z');
    // German layout: the physical KeyZ prints "y".
    expect(interactKeyCap(map, 'kbm', new Map([['KeyZ', 'y']])).label).toBe('Y');
    expect(interactKeyCap(map, 'gamepad')).toEqual({ label: 'A', pad: true, face: 'a' });
    map.interact = [
      { device: 'mouse', button: 3 },
      { device: 'pad', button: PAD.RB },
    ];
    expect(interactKeyCap(map, 'kbm').label).toBe(ECONOMY_HUD.prompt.mouseLabels[3]);
    expect(interactKeyCap(map, 'gamepad')).toEqual({ label: 'RB', pad: true, face: '' });
    map.interact = [{ device: 'key', code: 'Space' }];
    expect(interactKeyCap(map, 'kbm').label).toBe('Leertaste');
    expect(interactKeyCap(map, 'gamepad')).toEqual({
      label: ECONOMY_HUD.prompt.unbound,
      pad: true,
      face: '',
    });
    expect(interactKeyCap(null, 'kbm').label).toBe(ECONOMY_HUD.prompt.unbound);
  });

  it('writes into the given object (no allocation per refresh)', () => {
    const out = { label: '', pad: false, face: '' };
    expect(interactKeyCap(DEFAULT_BINDINGS, 'gamepad', undefined, out)).toBe(out);
  });

  it('distinguishes free, affordable and unaffordable prices', () => {
    expect(costState(null, true)).toBe('free');
    expect(costState(0, false)).toBe('free');
    expect(costState(750, true)).toBe('ok');
    expect(costState(750, false)).toBe('short');
    expect(costState(Number.NaN, true)).toBe('free');
  });
});

describe('timerRing', () => {
  it('shrinks with the time left and flashes during the warning window', () => {
    const r = timerRing(30, 30, 3);
    expect(r).toEqual({ fraction: 1, seconds: 30, ending: false });
    timerRing(15, 30, 3, r);
    expect(r.fraction).toBeCloseTo(0.5);
    expect(r.seconds).toBe(15);
    timerRing(2.4, 30, 3, r);
    expect(r.ending).toBe(true);
    expect(r.seconds).toBe(3);
    timerRing(0, 30, 3, r);
    expect(r).toEqual({ fraction: 0, seconds: 0, ending: false });
    timerRing(5, 0, 3, r);
    expect(r.fraction).toBe(0);
  });
});

describe('BannerQueue', () => {
  const banner = (kind: EconomyBanner['kind'], title: string, seconds = 2): EconomyBanner => ({
    kind,
    kicker: '',
    title,
    sub: '',
    color: '#fff',
    glyph: null,
    seconds,
  });

  it('shows one banner at a time and shortens it while others wait', () => {
    const q = new BannerQueue(4, 1, 0.25);
    expect(q.push(banner('perk', 'A'))).toBe('shown');
    q.update(0.5);
    expect(q.current?.title).toBe('A');
    expect(q.push(banner('powerUp', 'B'))).toBe('queued');
    q.update(0.49);
    expect(q.current?.title).toBe('A');
    q.update(0.02);
    expect(q.current?.title).toBe('B');
    q.update(2);
    expect(q.current).toBeNull();
  });

  it('merges zone banners of one door and drops the oldest waiting one when full', () => {
    const q = new BannerQueue(2, 1, 0.25);
    q.push(banner('zone', 'Atrium'));
    expect(q.push(banner('zone', 'Laborflügel'))).toBe('merged');
    expect(q.current?.title).toBe('Atrium · Laborflügel');
    q.push(banner('perk', '1'));
    q.push(banner('perk', '2'));
    q.push(banner('perk', '3'));
    expect(q.pending).toBe(2);
    q.update(1);
    expect(q.current?.title).toBe('2');
    const v = q.version;
    q.clear();
    expect(q.current).toBeNull();
    expect(q.pending).toBe(0);
    expect(q.version).toBeGreaterThan(v);
  });
});
