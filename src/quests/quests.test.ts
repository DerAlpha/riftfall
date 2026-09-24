import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { DamageInfo, Damageable, Interactable } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { getAchievementDef } from '../defs/achievements';
import { LAB_QUEST, QUESTS, QUEST_VISUALS, type QuestDef } from '../defs/quests';
import { getWeaponDef } from '../defs/weapons';
import type { KitCombat } from '../maps/kit/kitTypes';
import { createQuestCommands } from './questCommands';
import { QuestMachine } from './QuestMachine';
import { QuestSystem } from './QuestSystem';

const DT = 1 / 60;

const QUEST: QuestDef = {
  id: 'test',
  name: 'Testprotokoll',
  steps: [
    {
      kind: 'shoot',
      id: 'tags',
      targets: [
        { id: 't1', position: [0, 1, 0], normal: 'pz' },
        { id: 't2', position: [5, 1, 0], normal: 'pz' },
      ],
    },
    { kind: 'collect', id: 'core', items: [{ id: 'core', position: [0, 1.4, 10] }], carry: 'core' },
    {
      kind: 'interact',
      id: 'feed',
      requires: 'core',
      objects: [{ id: 'socket', position: [0, 0, 20], normal: 'up', prompt: 'Einsetzen', hold: 1, style: 'socket' }],
    },
    { kind: 'kill', id: 'purge', count: 2, volume: { center: [0, 0, 0], radius: 10 }, element: 'fire' },
    { kind: 'trap', id: 'traps', count: 1, traps: ['fence'] },
    { kind: 'defend', id: 'hold', point: [0, 0, 20], radius: 5, duration: 3, grace: 1, decay: 2 },
  ],
  rewards: [
    { kind: 'weapon', weapon: 'riftripper' },
    { kind: 'points', amount: 500 },
    { kind: 'perk', perk: 'titan' },
  ],
  achievement: 'quest_lab',
  rewardText: 'Belohnung',
};

describe('QuestMachine', () => {
  it('walks every step kind in order and completes', () => {
    const steps: string[] = [];
    let done = 0;
    const m = new QuestMachine(QUEST, { onStep: (_i, s) => steps.push(s.id), onComplete: () => done++ });
    expect(m.current?.id).toBe('tags');
    expect(m.targetHit('nope')).toBe(false);
    expect(m.targetHit('t2')).toBe(true);
    expect(m.targetHit('t2')).toBe(false);
    expect(m.progress).toBeCloseTo(0.5, 6);
    m.targetHit('t1');
    expect(m.current?.id).toBe('core');
    expect(m.carrying).toBeNull();
    // The socket does not want anything yet (wrong step), then only with the core.
    expect(m.wantsObject('socket')).toBe(false);
    m.itemCollected('core');
    expect(m.carrying).toBe('core');
    expect(m.wantsObject('socket')).toBe(true);
    expect(m.objectUsed('socket')).toBe(true);
    expect(m.carrying).toBeNull();
    expect(m.current?.id).toBe('purge');
    const kill = { x: 1, y: 0, z: 1, zone: null, element: 'fire' as const, weapon: 'flamethrower', enemy: 'swarmer' };
    m.onKill({ ...kill, element: 'ice' });
    m.onKill({ ...kill, x: 50 });
    expect(m.progress).toBe(0);
    m.onKill(kill);
    m.onKill(kill);
    expect(m.current?.id).toBe('traps');
    m.onTrapActivated('turret');
    expect(m.current?.id).toBe('traps');
    m.onTrapActivated('fence');
    expect(m.current?.id).toBe('hold');
    // Defend: inside counts, outside pauses for the grace time then drains.
    m.tick(1, { x: 0, y: 0, z: 20 });
    expect(m.progress).toBeCloseTo(1 / 3, 3);
    m.tick(0.5, { x: 0, y: 0, z: 40 });
    expect(m.progress).toBeCloseTo(1 / 3, 3);
    m.tick(1, { x: 0, y: 0, z: 40 });
    expect(m.progress).toBeLessThan(1 / 3);
    for (let i = 0; i < 400 && !m.completed; i++) m.tick(DT, { x: 1, y: 0, z: 21 });
    expect(m.completed).toBe(true);
    expect(done).toBe(1);
    expect(steps).toEqual(['core', 'feed', 'purge', 'traps', 'hold']);
    m.reset();
    expect(m.step).toBe(0);
    expect(m.completed).toBe(false);
  });

  it('ordered shoot steps restart the order on a wrong target', () => {
    const m = new QuestMachine({
      ...QUEST,
      steps: [{ ...(QUEST.steps[0] as Extract<QuestDef['steps'][number], { kind: 'shoot' }>), ordered: true }],
    });
    expect(m.targetHit('t2')).toBe(false);
    expect(m.targetHit('t1')).toBe(true);
    expect(m.targetHit('t2')).toBe(true);
    expect(m.completed).toBe(true);
  });

  it('advance / complete (dev console) hand over collected items', () => {
    const m = new QuestMachine(QUEST);
    m.advance();
    m.advance();
    expect(m.carrying).toBe('core');
    m.advance();
    expect(m.carrying).toBeNull();
    m.complete();
    expect(m.completed).toBe(true);
    expect(m.advance()).toBe(false);
  });
});

class Combat implements KitCombat {
  readonly targets: Damageable[] = [];
  register(t: Damageable): void {
    this.targets.push(t);
  }
  unregister(t: Damageable): void {
    const i = this.targets.indexOf(t);
    if (i >= 0) this.targets.splice(i, 1);
  }
  raycast(): null {
    return null;
  }
  queryRadius(_c: unknown, _r: number, out: Damageable[]): Damageable[] {
    return out;
  }
  dealDamage(t: Damageable, info: DamageInfo) {
    return t.applyDamage(info);
  }
  lineOfSight(): boolean {
    return true;
  }
}

function shoot(t: Damageable, source: DamageInfo['source'] = 'player'): void {
  t.applyDamage({
    amount: 30,
    zone: 'body',
    point: t.aimPoint,
    direction: { x: 0, y: 0, z: -1 },
    weaponId: 'pistol',
    element: 'physical',
    source,
    kind: 'bullet',
  });
}

function rig(def: QuestDef = QUEST) {
  const events = new EventBus<GameEvents>();
  const combat = new Combat();
  const registered: Interactable[] = [];
  const player = {
    position: new Vector3(0, 0, 30),
    eyePosition: new Vector3(0, 1.6, 30),
    alive: true,
    damage: () => 0,
  };
  const given: string[] = [];
  const perks: string[] = [];
  const earned: number[] = [];
  const log: string[] = [];
  events.on('quest:step', (e) => log.push(`step:${e.stepId}`));
  events.on('quest:completed', (e) => log.push(`done:${e.questId}:${e.mapId}`));
  const banners: string[] = [];
  const quest = new QuestSystem({
    def,
    mapId: 'lab',
    events,
    combat,
    interaction: { register: (i) => registered.push(i), unregister: () => {} },
    player,
    weapons: { give: (id) => given.push(id) },
    perks: { has: (id) => perks.includes(id), grant: (id) => (perks.push(id), true) },
    economy: { earn: (a) => (earned.push(a), a) },
    banner: (k, t, s) => banners.push(`${k}|${t}|${s}`),
  });
  const tick = (s: number): void => {
    for (let t = 0; t < s - 1e-9; t += DT) {
      quest.fixedUpdate(DT);
      quest.update(DT, null);
    }
  };
  return { events, combat, registered, player, given, perks, earned, log, banners, quest, tick };
}

describe('QuestSystem', () => {
  it('registers only the running step’s hidden targets; player hits count, others do not', () => {
    const r = rig();
    expect(r.combat.targets.length).toBe(2);
    const [a, b] = r.combat.targets;
    expect(a!.team).toBe('neutral');
    expect(a!.id).toBeGreaterThanOrEqual(QUEST_VISUALS.idBase);
    shoot(a!, 'trap');
    expect(r.quest.step).toBe(0);
    shoot(a!);
    expect(a!.alive).toBe(false);
    r.tick(DT);
    expect(r.combat.targets).toEqual([b]);
    shoot(b!);
    r.tick(DT);
    expect(r.quest.step).toBe(1);
    expect(r.combat.targets.length).toBe(0);
    expect(r.log).toEqual(['step:core']);
  });

  it('collect by walking in, feed the socket (prompt only while wanted), kills, traps, defend, rewards', () => {
    const r = rig();
    const socket = r.registered.find((i) => i.id === 'quest:socket')!;
    expect(socket.prompt()).toBe('');
    r.quest.advance();
    expect(r.quest.step).toBe(1);
    r.tick(0.1);
    expect(r.quest.step).toBe(1);
    r.player.position.set(0.3, 0, 10.2);
    r.tick(DT * 2);
    expect(r.quest.step).toBe(2);
    expect(r.quest.machine!.carrying).toBe('core');
    expect(socket.prompt()).toBe('Einsetzen');
    expect(socket.holdTime()).toBe(1);
    socket.interact();
    expect(r.quest.step).toBe(3);
    expect(socket.prompt()).toBe('');
    // Kill step: player kills with fire inside the volume (combat:damage, killed).
    const kill = (element: 'fire' | 'ice', x: number): void =>
      r.events.emit('combat:damage', {
        targetId: 5,
        amount: 50,
        zone: 'body',
        point: { x, y: 1, z: 0 },
        killed: true,
        weaponId: 'flamethrower',
        element,
        source: 'player',
      });
    kill('ice', 0);
    kill('fire', 40);
    kill('fire', 1);
    kill('fire', 2);
    expect(r.quest.step).toBe(4);
    r.events.emit('trap:state', { trapId: 'fence', kind: 'fence', state: 'active', position: { x: 0, y: 0, z: 0 } });
    expect(r.quest.step).toBe(5);
    r.player.position.set(0, 0, 20);
    r.tick(3.2);
    expect(r.quest.completed).toBe(true);
    expect(r.given).toEqual(['riftripper']);
    expect(r.earned).toEqual([500]);
    expect(r.perks).toEqual(['titan']);
    expect(r.log[r.log.length - 1]).toBe('done:test:lab');
    expect(r.banners[0]).toContain('Testprotokoll');
  });

  it('resets per run: first step again, targets back, no carried item', () => {
    const r = rig();
    for (const t of [...r.combat.targets]) shoot(t);
    r.tick(DT);
    r.quest.advance();
    expect(r.quest.machine!.carrying).toBe('core');
    r.quest.reset();
    expect(r.quest.step).toBe(0);
    expect(r.quest.machine!.carrying).toBeNull();
    expect(r.combat.targets.length).toBe(2);
    expect(r.combat.targets.every((t) => t.alive)).toBe(true);
  });

  it('dev console: status, step, complete', async () => {
    const r = rig();
    const [cmd] = createQuestCommands({ quest: r.quest });
    expect(await cmd!.run(['status'])).toContain('Schritt 1/6');
    expect(await cmd!.run(['step'])).toContain('Schritt 2');
    expect(await cmd!.run(['complete'])).toBe('Quest abgeschlossen.');
    expect(r.given).toEqual(['riftripper']);
    expect(await cmd!.run(['complete'])).toContain('bereits');
  });

  it('maps without a quest have an inert system', () => {
    const r = rig({ ...QUEST, steps: [] });
    expect(r.quest.questId).toBeNull();
    expect(r.quest.advance()).toBe(false);
    r.tick(0.1);
  });
});

describe('Protokoll Kepler (lab quest data)', () => {
  it('shoot 3 tags → rift core → feed the forge socket → defend 60 s → Riss-Zerreißer + achievement', () => {
    expect(QUESTS.lab).toBe(LAB_QUEST);
    expect(LAB_QUEST.steps.map((s) => s.kind)).toEqual(['shoot', 'collect', 'interact', 'defend']);
    const shootStep = LAB_QUEST.steps[0]!;
    expect(shootStep.kind === 'shoot' && shootStep.targets.length).toBe(3);
    const defend = LAB_QUEST.steps[3]!;
    expect(defend.kind === 'defend' && defend.duration).toBe(60);
    expect(LAB_QUEST.rewards).toContainEqual({ kind: 'weapon', weapon: 'riftripper' });
    expect(getWeaponDef('riftripper')).toBeDefined();
    const ach = getAchievementDef(LAB_QUEST.achievement!)!;
    expect(ach.condition.metric).toBe('questComplete');
    expect(ach.condition.filter?.map).toBe('lab');
    expect(ach.hidden).toBe(true);
    for (const id of ['arctic', 'biodome', 'reactor', 'orbital', 'rift']) {
      expect(getAchievementDef(`quest_${id}`)?.condition.filter?.map).toBe(id);
    }
  });
});
