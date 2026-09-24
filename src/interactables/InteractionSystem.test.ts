import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { Interactable } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { InteractionSystem } from './InteractionSystem';
import { FakeEconomy, FakeInput } from './testFakes';

const DT = 1 / 60;

class Thing implements Interactable {
  uses = 0;
  text = 'Benutzen';
  price: number | null = 500;
  usable = true;
  hold = 0;
  readonly position: Vector3;

  constructor(
    readonly id: string,
    x: number,
    z: number,
    readonly range = 2.5,
  ) {
    this.position = new Vector3(x, 1.6, z);
  }

  prompt(): string {
    return this.text;
  }
  cost(): number | null {
    return this.price;
  }
  canInteract(): boolean {
    return this.usable;
  }
  holdTime(): number {
    return this.hold;
  }
  interact(): void {
    this.uses++;
  }
}

function setup(points = 1000) {
  const events = new EventBus<GameEvents>();
  const focus: GameEvents['interact:focus'][] = [];
  events.on('interact:focus', (p) => focus.push({ ...p }));
  const input = new FakeInput();
  const viewer = { eyePosition: new Vector3(0, 1.6, 0), yaw: 0, pitch: 0 };
  const economy = new FakeEconomy(points);
  const blocked = new Set<string>();
  let enabled = true;
  const sys = new InteractionSystem({
    events,
    input,
    viewer,
    economy,
    lineOfSight: (_from, to) => ![...blocked].some((id) => id === `${to.x},${to.z}`),
    enabled: () => enabled,
  });
  /** One frame: ticks, then update, then the input edges end. */
  const frame = (ticks = 1): void => {
    for (let i = 0; i < ticks; i++) sys.fixedUpdate(DT);
    sys.update(DT);
    input.endFrame();
  };
  return {
    sys,
    input,
    viewer,
    economy,
    focus,
    frame,
    block: (t: Thing) => blocked.add(`${t.position.x},${t.position.z}`),
    setEnabled: (e: boolean) => {
      enabled = e;
    },
  };
}

describe('InteractionSystem', () => {
  it('focuses the interactable in front, emits interact:focus on change only', () => {
    const t = setup();
    const a = new Thing('a', 0, -2);
    const b = new Thing('b', 2, 2);
    t.sys.register(a);
    t.sys.register(b);
    t.frame();
    expect(t.sys.focused).toBe(a);
    expect(t.focus.at(-1)).toEqual({ id: 'a', prompt: 'Benutzen', cost: 500, affordable: true });
    const n = t.focus.length;
    t.frame(3);
    expect(t.focus.length).toBe(n);
    // Turn around: b is behind-right at 135°, a leaves the cone.
    t.viewer.yaw = Math.PI;
    t.frame();
    expect(t.sys.focused).toBe(null);
    expect(t.focus.at(-1)!.id).toBe(null);
  });

  it('press interactables fire once per press, also when a frame runs several ticks', () => {
    const t = setup();
    const a = new Thing('a', 0, -2);
    t.sys.register(a);
    t.frame();
    t.input.press();
    t.frame(3);
    expect(a.uses).toBe(1);
    t.frame(2);
    expect(a.uses).toBe(1);
    t.input.release();
    t.frame();
    t.input.press();
    t.frame();
    expect(a.uses).toBe(2);
  });

  it('a press in a frame without a tick is used by the next tick', () => {
    const t = setup();
    const a = new Thing('a', 0, -2);
    t.sys.register(a);
    t.frame();
    t.input.press();
    t.frame(0);
    expect(a.uses).toBe(0);
    t.frame(1);
    expect(a.uses).toBe(1);
  });

  it('hold interactables need the button held for holdTime, once per hold', () => {
    const t = setup();
    const a = new Thing('a', 0, -2);
    a.hold = 0.5;
    t.sys.register(a);
    t.frame();
    t.input.press();
    for (let i = 0; i < 20; i++) t.frame();
    expect(a.uses).toBe(0);
    expect(t.sys.holdProgress).toBeGreaterThan(0.5);
    for (let i = 0; i < 15; i++) t.frame();
    expect(a.uses).toBe(1);
    // Still held: no second use until released.
    for (let i = 0; i < 40; i++) t.frame();
    expect(a.uses).toBe(1);
    t.input.release();
    t.frame();
    expect(t.sys.holdProgress).toBe(0);
  });

  it('skips interactables without a prompt, out of sight, or not usable', () => {
    const t = setup();
    const a = new Thing('a', 0, -2);
    const b = new Thing('b', 0.4, -2.2);
    t.sys.register(a);
    t.sys.register(b);
    a.text = '';
    t.frame();
    expect(t.sys.focused).toBe(b);
    t.block(b);
    t.frame();
    expect(t.sys.focused).toBe(null);

    // Focused but not usable: shown, never used.
    const t2 = setup();
    const c = new Thing('c', 0, -2);
    c.usable = false;
    c.text = 'Bereits aktiv';
    c.price = null;
    t2.sys.register(c);
    t2.input.press();
    t2.frame();
    expect(t2.sys.focused).toBe(c);
    expect(t2.sys.offering).toBe(false);
    expect(c.uses).toBe(0);
    expect(t2.focus.at(-1)).toEqual({ id: 'c', prompt: 'Bereits aktiv', cost: null, affordable: true });
  });

  it('reports affordability and re-emits when it changes', () => {
    const t = setup(400);
    const a = new Thing('a', 0, -2);
    t.sys.register(a);
    t.frame();
    expect(t.focus.at(-1)!.affordable).toBe(false);
    t.economy.points = 600;
    t.frame();
    expect(t.focus.at(-1)!.affordable).toBe(true);
    // Unaffordable purchases still reach the interactable (it refuses through EconomyApi.spend).
    t.economy.points = 0;
    t.input.press();
    t.frame();
    expect(a.uses).toBe(1);
  });

  it('does nothing while disabled (dead player) and drops the focus', () => {
    const t = setup();
    const a = new Thing('a', 0, -2);
    t.sys.register(a);
    t.frame();
    expect(t.sys.focused).toBe(a);
    t.setEnabled(false);
    t.input.press();
    t.frame();
    expect(t.sys.focused).toBe(null);
    expect(a.uses).toBe(0);
    t.setEnabled(true);
    t.frame();
    expect(a.uses).toBe(0);
    expect(t.sys.focused).toBe(a);
  });

  it('unregistering the focus clears it; reset emits a cleared focus', () => {
    const t = setup();
    const a = new Thing('a', 0, -2);
    t.sys.register(a);
    t.sys.register(a);
    expect(t.sys.all.length).toBe(1);
    t.frame();
    t.sys.unregister(a);
    expect(t.sys.focused).toBe(null);
    t.sys.register(a);
    t.frame();
    t.sys.reset();
    expect(t.focus.at(-1)!.id).toBe(null);
  });

  it('grows past its initial capacity', () => {
    const t = setup();
    for (let i = 0; i < 100; i++) t.sys.register(new Thing(`t${i}`, 50 + i, 50));
    const a = new Thing('near', 0, -2);
    t.sys.register(a);
    t.frame();
    expect(t.sys.focused).toBe(a);
  });
});
