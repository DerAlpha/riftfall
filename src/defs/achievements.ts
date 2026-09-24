/**
 * Achievements (M9): conditions over progress signals (defs/progression METRICS), tracked by
 * src/progression/AchievementTracker.ts with persisted progress. Rewards come from the tier
 * (ACHIEVEMENT_REWARDS: XP + Rift-Splitter); cosmetics name the achievement that unlocks them
 * (defs/cosmetics unlock kind 'achievement').
 *
 * Hidden achievements show "???" until unlocked. Ids are stable save keys – never rename one.
 * Content-extensible: M6 enemies / bosses, M7 maps and M8 modes add entries keyed by their ids
 * (e.g. `{ metric: 'waveReached', filter: { map: '<mapId>' } }`).
 * Names and descriptions are German.
 */
import type { AchievementTier } from '../core/events';
import { ABILITY_IDS } from './abilities';
import { COMBOS } from './elements';
import { GRENADE_IDS } from './grenades';
import { PERK_IDS } from './perks';
import { POWERUP_IDS } from './powerups';
import type { MetricId, ProgressCondition, ProgressionGlyphId, SignalFilter } from './progression';
import { WEAPON_IDS } from './weapons';

export type AchievementCategory =
  | 'combat'
  | 'waves'
  | 'economy'
  | 'arsenal'
  | 'elements'
  | 'progression'
  | 'secret';

export const ACHIEVEMENT_CATEGORIES: Readonly<Record<AchievementCategory, string>> = {
  combat: 'Kampf',
  waves: 'Wellen',
  economy: 'Wirtschaft',
  arsenal: 'Arsenal',
  elements: 'Elemente',
  progression: 'Aufstieg',
  secret: 'Geheim',
};

export interface AchievementDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: AchievementCategory;
  readonly tier: AchievementTier;
  readonly icon: ProgressionGlyphId;
  readonly hidden?: boolean;
  readonly condition: ProgressCondition;
}

type Base = Omit<AchievementDef, 'condition'>;

function count(
  base: Base,
  metric: MetricId,
  target: number,
  filter?: SignalFilter,
  scope?: 'lifetime' | 'run' | 'wave',
): AchievementDef {
  return { ...base, condition: { kind: 'count', metric, target, filter, scope } };
}

function best(base: Base, metric: MetricId, target: number, filter?: SignalFilter): AchievementDef {
  return { ...base, condition: { kind: 'max', metric, target, filter } };
}

function distinct(
  base: Base,
  metric: MetricId,
  tag: 'weapon' | 'grenade' | 'ability' | 'combo' | 'perk' | 'powerup',
  values: readonly string[],
  target: number = values.length,
): AchievementDef {
  return { ...base, condition: { kind: 'distinct', metric, tag, values, target } };
}

const C = (
  id: string,
  name: string,
  description: string,
  tier: AchievementTier,
  icon: ProgressionGlyphId,
  hidden = false,
): Base => ({ id, name, description, category: 'combat', tier, icon, hidden });

function inCategory(category: AchievementCategory, list: readonly AchievementDef[]): AchievementDef[] {
  return list.map((a) => ({ ...a, category }));
}

const COMBAT: readonly AchievementDef[] = [
  count(C('first_blood', 'Erstes Blut', 'Töte deinen ersten Gegner.', 'bronze', 'skull'), 'kill', 1),
  count(C('kills_100', 'Säuberung', 'Töte 100 Gegner.', 'bronze', 'skull'), 'kill', 100),
  count(C('kills_1000', 'Kammerjäger', 'Töte 1.000 Gegner.', 'silver', 'skull'), 'kill', 1000),
  count(C('kills_10000', 'Riftfall-Veteran', 'Töte 10.000 Gegner.', 'gold', 'skull'), 'kill', 10000),
  count(C('kills_50000', 'Auslöschung', 'Töte 50.000 Gegner.', 'platinum', 'skull'), 'kill', 50000),
  count(C('headshots_100', 'Kopfsache', '100 Kopfschuss-Kills.', 'bronze', 'crosshair'), 'kill', 100, {
    zone: 'head',
  }),
  count(C('headshots_1000', 'Kopfgeldjäger', '1.000 Kopfschuss-Kills.', 'silver', 'crosshair'), 'kill', 1000, {
    zone: 'head',
  }),
  best(
    C('headshot_streak_10', 'Chirurg', '10 Kopfschuss-Kills in Folge.', 'silver', 'crosshair'),
    'headshotStreak',
    10,
  ),
  best(
    C('headshot_streak_25', 'Präzisionsinstrument', '25 Kopfschuss-Kills in Folge.', 'gold', 'crosshair'),
    'headshotStreak',
    25,
  ),
  count(
    C('weakpoints_250', 'Schwachstellenanalyse', '250 Kills durch Treffer auf Schwachstellen.', 'silver', 'eye'),
    'kill',
    250,
    { zone: 'weakpoint' },
  ),
  count(C('melee_50', 'Handarbeit', '50 Nahkampf-Kills.', 'bronze', 'fist'), 'kill', 50, { kind: 'melee' }),
  best(C('multikill_5', 'Kettenreaktion', '5 Kills innerhalb eines Augenblicks.', 'silver', 'burst'), 'multiKill', 5),
  best(C('multikill_10', 'Massenvernichtung', '10 Kills innerhalb eines Augenblicks.', 'gold', 'burst'), 'multiKill', 10),
  count(C('swarmers_1000', 'Schwarmbrecher', 'Töte 1.000 Schwärmer.', 'silver', 'skull'), 'kill', 1000, {
    enemy: 'swarmer',
  }),
  count(C('spitters_250', 'Säureneutralisierung', 'Töte 250 Spucker.', 'silver', 'drop'), 'kill', 250, {
    enemy: 'spitter',
  }),
  count(C('tanks_50', 'Panzerknacker', 'Töte 50 Koloss-Gegner.', 'silver', 'shield'), 'kill', 50, {
    enemy: 'tank',
  }),
  count(C('tank_headshot', 'Riese gefällt', 'Erledige einen Koloss mit einem Kopfschuss.', 'bronze', 'crosshair'), 'kill', 1, {
    enemy: 'tank',
    zone: 'head',
  }),
  count(C('elites_25', 'Elitejäger', 'Töte 25 Elite-Gegner.', 'silver', 'star'), 'kill', 25, { elite: true }),
  best(C('killstreak_50', 'Unantastbar', '50 Kills, ohne Schaden zu nehmen.', 'gold', 'shield'), 'killStreak', 50),
  count(C('run_kills_500', 'Blutbad', '500 Kills in einem Run.', 'gold', 'skull'), 'kill', 500, undefined, 'run'),
  count(C('wave_kills_60', 'Fleischwolf', '60 Kills in einer einzigen Welle.', 'silver', 'burst'), 'kill', 60, undefined, 'wave'),
];

const WAVES: readonly AchievementDef[] = inCategory('waves', [
  best(C('wave_5', 'Überlebender', 'Erreiche Welle 5.', 'bronze', 'wave'), 'waveReached', 5),
  best(C('lab_wave_10', 'Laborratte', 'Erreiche Welle 10 im Forschungslabor.', 'silver', 'wave'), 'waveReached', 10, {
    map: 'lab',
  }),
  best(C('lab_wave_20', 'Forschungsleiter', 'Erreiche Welle 20 im Forschungslabor.', 'gold', 'wave'), 'waveReached', 20, {
    map: 'lab',
  }),
  best(C('lab_wave_30', 'Rift-Direktor', 'Erreiche Welle 30 im Forschungslabor.', 'platinum', 'wave'), 'waveReached', 30, {
    map: 'lab',
  }),
  best(C('lab_wave_50', 'Ewige Schicht', 'Erreiche Welle 50 im Forschungslabor.', 'platinum', 'crown', true), 'waveReached', 50, {
    map: 'lab',
  }),
  count(C('no_damage_wave', 'Unberührt', 'Schließe ab Welle 3 eine Welle ohne Schaden ab.', 'silver', 'shield'), 'noDamageWave', 1),
  count(C('no_damage_waves_25', 'Geist', 'Schließe 25 Wellen ohne Schaden ab.', 'gold', 'shield'), 'noDamageWave', 25),
  count(C('waves_100', 'Wellenreiter', 'Schließe 100 Wellen ab.', 'silver', 'wave'), 'waveComplete', 100),
  count(C('waves_1000', 'Gezeitenkraft', 'Schließe 1.000 Wellen ab.', 'gold', 'wave'), 'waveComplete', 1000),
  best(C('survive_30min', 'Durchhalter', 'Überlebe 30 Minuten in einem Run.', 'gold', 'clock'), 'survived', 1800),
  count(C('runs_10', 'Stammgast', 'Beende 10 Runs.', 'bronze', 'calendar'), 'runEnd', 10),
  count(C('runs_100', 'Dauerschicht', 'Beende 100 Runs.', 'gold', 'calendar'), 'runEnd', 100),
  count(C('seals_50', 'Siegelmeister', 'Repariere 50 Rift-Siegel.', 'silver', 'hex'), 'sealRepaired', 50),
]);

const ECONOMY_LIST: readonly AchievementDef[] = inCategory('economy', [
  count(C('points_100k', 'Kleingeld', 'Verdiene insgesamt 100.000 Punkte.', 'bronze', 'coin'), 'pointsEarned', 100000),
  count(C('points_1m', 'Millionär', 'Verdiene insgesamt 1.000.000 Punkte.', 'gold', 'coin'), 'pointsEarned', 1000000),
  count(C('run_points_50k', 'Großverdiener', 'Verdiene 50.000 Punkte in einem Run.', 'silver', 'coin'), 'pointsEarned', 50000, undefined, 'run'),
  count(C('door_first', 'Tür auf', 'Öffne deine erste Tür.', 'bronze', 'door'), 'doorOpened', 1),
  count(C('doors_all', 'Hausmeister', 'Öffne in einem Run jede Tür der Karte.', 'gold', 'door'), 'allDoors', 1),
  count(C('perk_first', 'Implantiert', 'Kaufe dein erstes Perk.', 'bronze', 'hex'), 'perkBought', 1),
  count(C('perks_full', 'Vollausstattung', 'Belege in einem Run jeden Perk-Platz.', 'silver', 'hex'), 'perkSlotsFull', 1),
  distinct(C('perks_all', 'Implantat-Sammler', 'Kaufe jedes Perk mindestens einmal.', 'gold', 'hex'), 'perkBought', 'perk', PERK_IDS),
  count(C('box_first', 'Glücksspiel', 'Öffne zum ersten Mal die Rift-Kiste.', 'bronze', 'box'), 'boxRoll', 1),
  count(C('box_50', 'Spielsüchtig', 'Öffne die Rift-Kiste 50-mal.', 'silver', 'box'), 'boxRoll', 50),
  count(C('box_wonder', 'Wunderkind', 'Erhalte eine Wunderwaffe aus der Rift-Kiste.', 'gold', 'star'), 'boxWonder', 1),
  count(C('powerups_50', 'Beutegreifer', 'Sammle 50 Power-ups.', 'silver', 'star'), 'powerUp', 50),
  distinct(C('powerups_all', 'Glückssträhne', 'Sammle jede Art von Power-up.', 'gold', 'star'), 'powerUp', 'powerup', POWERUP_IDS),
]);

const ARSENAL: readonly AchievementDef[] = inCategory('arsenal', [
  count(C('forge_first', 'Geschmiedet', 'Verbessere eine Waffe in der Rift-Schmiede.', 'bronze', 'anvil'), 'forgeUpgrade', 1),
  best(C('forge_tier3', 'Rift-Schmied', 'Schmiede eine Waffe auf Stufe III.', 'gold', 'anvil'), 'forgeTier', 3),
  distinct(C('grenades_all', 'Sprengstoffexperte', 'Wirf jede Granatenart.', 'silver', 'grenade'), 'grenadeThrown', 'grenade', GRENADE_IDS),
  count(C('grenade_kills_100', 'Granatenhagel', '100 Kills mit Granaten.', 'silver', 'grenade'), 'kill', 100, {
    category: 'grenade',
  }),
  distinct(C('abilities_all', 'Vielseitig', 'Setze jede Fähigkeit ein.', 'silver', 'orbit'), 'abilityUsed', 'ability', ABILITY_IDS),
  count(C('ability_uses_100', 'Kraftquelle', 'Setze Fähigkeiten 100-mal ein.', 'silver', 'orbit'), 'abilityUsed', 100),
  distinct(C('weapons_10', 'Waffenkenner', 'Töte Gegner mit 10 verschiedenen Waffen.', 'silver', 'crosshair'), 'kill', 'weapon', WEAPON_IDS, 10),
  distinct(C('weapons_all', 'Arsenal komplett', 'Töte Gegner mit jeder Waffe.', 'platinum', 'crosshair'), 'kill', 'weapon', WEAPON_IDS),
  count(C('wonder_kills_100', 'Wunderwirkung', '100 Kills mit Wunderwaffen.', 'gold', 'star'), 'kill', 100, {
    category: 'wonder',
  }),
  best(C('weapon_level_30', 'Meisterschütze', 'Bringe eine Waffe auf Stufe 30.', 'gold', 'medal'), 'weaponLevel', 30),
  count(C('weapons_mastered_5', 'Waffenmeister', 'Bringe 5 Waffen auf Stufe 30.', 'platinum', 'medal'), 'weaponMastered', 5),
  count(C('camo_animated', 'Glanzstück', 'Schalte eine animierte Tarnung frei.', 'gold', 'rune'), 'animatedCamo', 1),
]);

const COMBO_IDS = COMBOS.map((c) => c.id);

const ELEMENTS: readonly AchievementDef[] = inCategory('elements', [
  count(C('combo_first', 'Reaktion', 'Löse eine Elementarkombo aus.', 'bronze', 'flask'), 'combo', 1),
  distinct(C('combos_all', 'Elementarist', 'Löse jede Elementarkombo aus.', 'gold', 'flask'), 'combo', 'combo', COMBO_IDS),
  count(C('combos_500', 'Kettenreaktor', 'Löse 500 Elementarkombos aus.', 'gold', 'flask'), 'combo', 500),
  count(C('fire_kills', 'Brandstifter', '250 Kills mit Feuerschaden.', 'silver', 'flame'), 'kill', 250, { element: 'fire' }),
  count(C('ice_kills', 'Permafrost', '250 Kills mit Eisschaden.', 'silver', 'snow'), 'kill', 250, { element: 'ice' }),
  count(C('shock_kills', 'Hochspannung', '250 Kills mit Schockschaden.', 'silver', 'nova'), 'kill', 250, { element: 'shock' }),
  count(C('poison_kills', 'Giftmischer', '250 Kills mit Giftschaden.', 'silver', 'drop'), 'kill', 250, { element: 'poison' }),
  count(C('void_kills', 'Leere', '250 Kills mit Void-Schaden.', 'silver', 'orbit'), 'kill', 250, { element: 'void' }),
]);

const PROGRESSION_LIST: readonly AchievementDef[] = inCategory('progression', [
  best(C('level_10', 'Aufstieg', 'Erreiche Stufe 10.', 'bronze', 'medal'), 'playerLevel', 10),
  best(C('level_25', 'Bewährt', 'Erreiche Stufe 25.', 'silver', 'medal'), 'playerLevel', 25),
  best(C('level_50', 'Veteran', 'Erreiche Stufe 50.', 'gold', 'medal'), 'playerLevel', 50),
  best(C('level_100', 'Legende', 'Erreiche Stufe 100.', 'platinum', 'crown'), 'playerLevel', 100),
  best(C('prestige_1', 'Neubeginn', 'Steige zum ersten Mal im Prestige auf.', 'gold', 'crown'), 'prestige', 1),
  best(C('prestige_5', 'Rift-Wandler', 'Erreiche Prestige 5.', 'platinum', 'crown'), 'prestige', 5),
  best(C('prestige_max', 'Unsterblich', 'Erreiche den höchsten Prestige-Rang.', 'platinum', 'crown', true), 'prestige', 10),
  best(C('skill_first', 'Erste Fertigkeit', 'Kaufe deinen ersten Fertigkeitsrang.', 'bronze', 'rune'), 'skillRanks', 1),
  best(C('skill_25', 'Spezialisiert', 'Kaufe 25 Fertigkeitsränge.', 'silver', 'rune'), 'skillRanks', 25),
  count(C('skill_branch', 'Meister eines Asts', 'Schließe einen Fertigkeitsast vollständig ab.', 'gold', 'rune'), 'skillBranchComplete', 1),
  count(C('dailies_10', 'Tagwerk', 'Schließe 10 tägliche Herausforderungen ab.', 'silver', 'calendar'), 'challengeCompleted', 10, {
    period: 'daily',
  }),
  count(C('weeklies_5', 'Wochenziel', 'Schließe 5 wöchentliche Herausforderungen ab.', 'gold', 'calendar'), 'challengeCompleted', 5, {
    period: 'weekly',
  }),
  best(C('achievements_30', 'Trophäenjäger', 'Schalte 30 Erfolge frei.', 'gold', 'trophy'), 'achievementsUnlocked', 30),
]);

const SECRET: readonly AchievementDef[] = inCategory('secret', [
  count(C('revived', 'Zweite Chance', 'Werde nach tödlichem Schaden wiederbelebt.', 'bronze', 'phoenix', true), 'revive', 1),
  count(C('early_death', 'Fehlstart', 'Stirb in der ersten Welle.', 'bronze', 'skull', true), 'earlyDeath', 1),
  best(C('pacifist', 'Pazifist', 'Schließe Welle 3 ab, ohne einen Schuss abzufeuern.', 'gold', 'eye', true), 'pacifistWave', 3),
  count(C('melee_tank', 'Faustrecht', 'Erledige einen Koloss im Nahkampf.', 'gold', 'fist', true), 'kill', 1, {
    enemy: 'tank',
    kind: 'melee',
  }),
  count(C('nuke', 'Rote Taste', 'Sammle einen Riss-Kollaps ein.', 'bronze', 'burst', true), 'powerUp', 1, {
    powerup: 'nuke',
  }),
]);

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  ...COMBAT,
  ...WAVES,
  ...ECONOMY_LIST,
  ...ARSENAL,
  ...ELEMENTS,
  ...PROGRESSION_LIST,
  ...SECRET,
];

const INDEX: ReadonlyMap<string, AchievementDef> = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

export function getAchievementDef(id: string): AchievementDef | undefined {
  return INDEX.get(id);
}

/** Target of a condition (count / level / distinct values). */
export function conditionTarget(c: ProgressCondition): number {
  return c.target;
}
