import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import type { LevelInstance } from '../core/contracts';
import { ZoneSystem } from './ZoneSystem';

function bus() {
  const events = new EventBus<GameEvents>();
  const activated: string[] = [];
  events.on('zone:activated', ({ zone }) => activated.push(zone));
  return { events, activated };
}

describe('ZoneSystem', () => {
  it('starts with the start zones, activates once per zone and resets', () => {
    const { events, activated } = bus();
    const z = new ZoneSystem({ events, zones: ['a', 'b', 'c'], startZones: ['a'] });
    expect(z.gated).toBe(true);
    expect(z.active).toEqual(['a']);
    expect(z.isActive('a')).toBe(true);
    expect(z.isActive('b')).toBe(false);
    z.activate('b');
    z.activate('b');
    z.activate('a');
    expect(activated).toEqual(['b']);
    expect(z.active).toEqual(['a', 'b']);
    z.activate('nope');
    expect(z.isActive('nope')).toBe(false);
    z.reset();
    expect(z.active).toEqual(['a']);
    expect(z.isActive('b')).toBe(false);
  });

  it('is not gated on maps without zones', () => {
    const { events, activated } = bus();
    const z = ZoneSystem.forLevel({ id: 'testroom' } as LevelInstance, events);
    expect(z.gated).toBe(false);
    expect(z.isActive('hall')).toBe(true);
    expect(z.isActive('anything')).toBe(true);
    z.activate('hall');
    expect(activated).toEqual([]);
  });

  it('opens everything when a gated map has no valid start zone', () => {
    const { events } = bus();
    const z = new ZoneSystem({ events, zones: ['x', 'y'], startZones: ['missing'] });
    expect(z.isActive('x')).toBe(true);
    expect(z.isActive('y')).toBe(true);
  });

  it('reads the lab start zones from the defs', () => {
    const { events } = bus();
    const level = {
      id: 'lab',
      zones: [
        { id: 'reception', name: 'Empfang' },
        { id: 'atrium', name: 'Atrium' },
      ],
      doorSlots: [],
      wallBuySlots: [],
      zoneAt: () => null,
    } as unknown as LevelInstance;
    const z = ZoneSystem.forLevel(level, events);
    expect(z.active).toEqual(['reception']);
  });
});
