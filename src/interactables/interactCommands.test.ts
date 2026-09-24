import { describe, expect, it } from 'vitest';
import { createInteractCommands, type InteractCommandDeps } from './interactCommands';

function fakeDoor(id: string) {
  const d = {
    id,
    state: 'closed' as 'closed' | 'opening' | 'open',
    price: 750,
    slot: { zoneA: 'a', zoneB: 'b' } as InteractCommandDeps['doors'][number]['slot'],
    open: () => {
      if (d.state !== 'closed') return false;
      d.state = 'opening';
      return true;
    },
  };
  return d;
}

function fakeBox() {
  const b = {
    state: 'idle' as string,
    location: { id: 'box_a', zone: 'a' },
    usesHere: 1,
    moveThreshold: 5,
    offeredWeapon: null as string | null,
    rolls: [] as boolean[],
    roll: (force = false) => {
      if (b.state !== 'idle') return false;
      b.rolls.push(force);
      b.state = 'rolling';
      return true;
    },
    move: () => {
      if (b.state !== 'idle') return false;
      b.state = 'leaving';
      return true;
    },
  };
  return b;
}

describe('interactable console commands', () => {
  it('lists and opens doors (id, prefix, all)', async () => {
    const doors = [
      fakeDoor('door_reception_atrium'),
      fakeDoor('door_reception_labs'),
      fakeDoor('door_dock_cryo'),
    ];
    const [door] = createInteractCommands({
      doors,
      box: null,
      zones: { active: ['reception'] },
    } as unknown as InteractCommandDeps);
    const list = await door!.run([]);
    expect(list).toContain('door_dock_cryo');
    expect(list).toContain('Aktive Zonen: reception');
    expect(await door!.run(['door_dock'])).toContain('öffnet');
    expect(doors[2]!.state).toBe('opening');
    expect(() => door!.run(['door_reception'])).toThrow(/Mehrdeutig/);
    expect(() => door!.run(['nope'])).toThrow(/Unbekannte/);
    expect(await door!.run(['all'])).toBe('2 Tür(en) geöffnet');
    expect(await door!.run(['all'])).toBe('Alle Türen sind bereits offen');
    expect(door!.complete!(['door_r'])).toEqual(['door_reception_atrium', 'door_reception_labs']);
  });

  it('rolls, forces the anomaly and moves the box', async () => {
    const box = fakeBox();
    const [, cmd] = createInteractCommands({ doors: [], box } as unknown as InteractCommandDeps);
    expect(await cmd!.run([])).toContain('box_a');
    expect(await cmd!.run(['roll'])).toBe('Rift-Kiste dreht');
    expect(await cmd!.run(['roll'])).toContain('beschäftigt');
    box.state = 'idle';
    expect(await cmd!.run(['anomaly'])).toContain('Anomalie');
    expect(box.rolls).toEqual([false, true]);
    box.state = 'idle';
    expect(await cmd!.run(['move'])).toContain('verlässt');
    expect(() => cmd!.run(['dance'])).toThrow();
  });

  it('reports maps without doors or box', async () => {
    const [door, box] = createInteractCommands({ doors: [], box: null });
    expect(await door!.run([])).toContain('Keine Türen');
    expect(await box!.run(['roll'])).toContain('Keine Rift-Kiste');
  });
});
