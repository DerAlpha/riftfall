import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { PERKS, PERK_GLYPHS, PERK_IDS, perkCssColor, perkSource, type PerkDef } from '../defs/perks';
import { STAT_IDS, getStatDef } from '../defs/stats';
import { PlayerHealth } from '../player/PlayerHealth';
import { StatSystem } from '../stats/StatSystem';
import { EconomySystem } from './EconomySystem';
import { PerkSystem } from './PerkSystem';

function setup() {
  const events = new EventBus<GameEvents>();
  const stats = new StatSystem({ events });
  const perks = new PerkSystem({ events, stats, player: { position: { x: 0, y: 0, z: 0 } }, seed: 'test' });
  const log: string[] = [];
  events.on('perk:acquired', (e) => log.push(`+${e.perkId}@${e.slot}`));
  events.on('perk:lost', (e) => log.push(`-${e.perkId}`));
  return { events, stats, perks, log };
}

function snapshot(stats: StatSystem): number[] {
  return STAT_IDS.map((id) => stats.value(id));
}

describe('perk table', () => {
  it('has at least 13 perks with names, prices, colours, glyphs and valid modifiers', () => {
    expect(PERK_IDS.length).toBeGreaterThanOrEqual(13);
    const colors = new Set<number>();
    for (const id of PERK_IDS) {
      const d: PerkDef = PERKS[id];
      expect(d.id).toBe(id);
      expect(d.name.length, id).toBeGreaterThan(3);
      expect(d.description.length, id).toBeGreaterThan(10);
      expect(d.price, id).toBeGreaterThan(0);
      expect(d.color, id).toBeGreaterThanOrEqual(0);
      expect(d.color, id).toBeLessThanOrEqual(0xffffff);
      expect(PERK_GLYPHS[d.icon], id).toBeTruthy();
      expect(d.modifiers.length > 0 || d.hook !== null, `${id} does something`).toBe(true);
      for (const m of d.modifiers) expect(getStatDef(m.stat), `${id}.${m.stat}`).toBeDefined();
      colors.add(d.color);
    }
    expect(colors.size).toBe(PERK_IDS.length);
    expect(perkCssColor({ color: 0x00ff0a })).toBe('#00ff0a');
    // The spec's named perks exist.
    for (const name of [
      'Titanplatte',
      'Schnellladung',
      'Doppelimpuls',
      'Phoenix-Protokoll',
      'Sprinterkern',
      'Präzisionsmodul',
      'Riftläufer',
      'Dreifachhalfter',
      'Nova-Schock',
      'Aasgeier',
      'Kinetikpanzer',
      'Adrenalinschub',
      'Munitionsrecycler',
    ]) {
      expect(
        PERK_IDS.some((id) => PERKS[id].name === name),
        name,
      ).toBe(true);
    }
  });
});

describe('PerkSystem', () => {
  it('grant applies the modifiers in one batch; revoke restores every stat exactly', () => {
    const { stats, perks, log } = setup();
    const base = snapshot(stats);
    for (const id of PERK_IDS) {
      const before = snapshot(stats);
      const v = stats.version;
      expect(perks.grant(id), id).toBe(true);
      if (PERKS[id].modifiers.length > 0) expect(stats.version, id).toBe(v + 1);
      perks.revoke(id);
      expect(snapshot(stats), id).toEqual(before);
      expect(stats.hasSource(perkSource(id))).toBe(false);
    }
    expect(snapshot(stats)).toEqual(base);
    expect(log[0]).toBe(`+${PERK_IDS[0]}@0`);
    expect(log[1]).toBe(`-${PERK_IDS[0]}`);
  });

  it('stacked perks come off in any order back to base', () => {
    const { stats, perks } = setup();
    const base = snapshot(stats);
    const ids = ['precision', 'doubleimpulse', 'recycler', 'sprinter'];
    for (const id of ids) perks.grant(id);
    expect(stats.value('fireRate')).toBeCloseTo(1.33);
    expect(stats.value('spread')).toBeCloseTo(0.65);
    perks.revoke('doubleimpulse');
    perks.revoke('sprinter');
    perks.revoke('precision');
    perks.revoke('recycler');
    expect(snapshot(stats)).toEqual(base);
  });

  it('respects the perkSlots limit (4) and refuses unknown or owned perks', () => {
    const { stats, perks, log } = setup();
    expect(perks.maxPerks).toBe(4);
    expect(perks.grant('titan')).toBe(true);
    expect(perks.grant('titan')).toBe(false);
    expect(perks.grant('nope')).toBe(false);
    expect(perks.grant('quickload')).toBe(true);
    expect(perks.grant('sprinter')).toBe(true);
    expect(perks.grant('holster')).toBe(true);
    expect(perks.check('nova')).toBe('full');
    expect(perks.grant('nova')).toBe(false);
    expect(perks.owned).toEqual(['titan', 'quickload', 'sprinter', 'holster']);
    // A fifth slot (card, skill) opens the limit; losing it later keeps what is owned.
    stats.addModifier({ source: 'card:x', stat: 'perkSlots', op: 'add', value: 1 });
    expect(perks.grant('nova')).toBe(true);
    stats.removeSource('card:x');
    expect(perks.owned).toHaveLength(5);
    expect(perks.check('adrenaline')).toBe('full');
    perks.clear();
    expect(perks.owned).toEqual([]);
    expect(log.filter((l) => l.startsWith('-'))).toHaveLength(5);
    expect(stats.activeSources).toEqual([]);
  });

  it('buy charges only when the perk is granted', () => {
    const { events, stats, perks } = setup();
    const economy = new EconomySystem({ events, stats }, 2000);
    expect(perks.buy('titan', economy)).toBe('unaffordable');
    expect(economy.points).toBe(2000);
    expect(perks.buy('doubleimpulse', economy)).toBe('ok');
    expect(economy.points).toBe(0);
    expect(perks.has('doubleimpulse')).toBe(true);
    economy.adjust(5000);
    expect(perks.buy('doubleimpulse', economy)).toBe('owned');
    expect(perks.buy('nope', economy)).toBe('unknown');
    expect(economy.points).toBe(5000);
  });

  it('hooks subscribe on grant and clean up on revoke', () => {
    const { events, stats, perks } = setup();
    const before = events.listenerCount('combat:kill');
    perks.grant('adrenaline');
    expect(events.listenerCount('combat:kill')).toBe(before + 1);
    events.emit('combat:kill', {
      targetId: 1,
      zone: 'body',
      weaponId: 'rifle',
      position: { x: 0, y: 0, z: 0 },
      source: 'player',
    });
    expect(stats.value('moveSpeed')).toBeGreaterThan(1);
    perks.revoke('adrenaline');
    expect(events.listenerCount('combat:kill')).toBe(before);
    expect(stats.value('moveSpeed')).toBe(1);
    expect(stats.activeSources).toEqual([]);
  });

  it('revive: the Phoenix perk is consumed, the rest of the build stays', () => {
    const { events, stats, perks, log } = setup();
    const health = new PlayerHealth({ events });
    health.setStats(stats);
    perks.grant('titan');
    perks.grant('phoenix');
    perks.grant('quickload');
    health.fixedUpdate(1 / 60);
    expect(health.reviveCharges).toBe(1);
    expect(health.maxHealth).toBeCloseTo(180);
    health.damage(10_000);
    expect(health.dead).toBe(false);
    expect(perks.owned).toEqual(['titan', 'quickload']);
    expect(log.at(-1)).toBe('-phoenix');
    expect(health.reviveCharges).toBe(0);
    // Bought again after the revive: a fresh charge.
    expect(perks.grant('phoenix')).toBe(true);
    health.fixedUpdate(1 / 60);
    expect(health.reviveCharges).toBe(1);
  });
});
