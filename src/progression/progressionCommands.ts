/**
 * Dev console commands of the meta progression:
 *   xp [n]                               status / grant n XP
 *   level <n>                            jump to level n
 *   prestige                             prestige (at the max level)
 *   achievement list [text]|unlock <id>  achievements (aliases: achievements, erfolg)
 *   challenge list|complete <id|n>|claim <id>   daily / weekly challenges (alias herausforderung)
 *   skill list [branch]|unlock <id>|reset|respec|loadout grenade|ability <id|none>
 *   profile                              level, points, currency, lifetime stats (alias profil)
 *   leaderboard [map] [mode]             local leaderboard (alias bestenliste)
 *   weaponlevel <weaponId> <n>           weapon level (camo unlocks) (alias waffenstufe)
 */
import type { ConsoleCommand } from '../core/contracts';
import { ACHIEVEMENTS } from '../defs/achievements';
import { PROGRESSION } from '../defs/progression';
import { SKILL_BRANCHES, SKILL_BRANCH_IDS, SKILL_NODES, type SkillBranchId } from '../defs/skills';
import { WEAPON_IDS } from '../defs/weapons';
import { formatCount } from './challengeSeed';
import type { ProgressionSystem } from './ProgressionSystem';

export interface ProgressionCommandDeps {
  progression: ProgressionSystem;
  /** Map id of the current level (leaderboard default). */
  mapId: () => string;
}

function int(v: string | undefined, name: string): number {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n)) throw new Error(`${name}: Zahl erwartet`);
  return Math.floor(n);
}

function pct(v: number): string {
  return `${Math.round(v * 100)} %`;
}

export function createProgressionCommands(deps: ProgressionCommandDeps): ConsoleCommand[] {
  const p = deps.progression;

  const status = (): string => {
    const toNext = p.xpToNext;
    const xp = toNext > 0 ? `${formatCount(p.xp)} / ${formatCount(toNext)} XP` : 'Maximalstufe';
    return `Stufe ${p.level} (Prestige ${p.prestigeRank}) – ${xp} – ${p.skills.available} Fertigkeitspunkte`;
  };

  const skillLine = (id: string): string => {
    const n = SKILL_NODES.find((x) => x.id === id)!;
    const r = p.skills.rank(id);
    const check = p.skills.check(id);
    const state = check === 'ok' ? 'kaufbar' : check === 'maxed' ? 'max' : check;
    return `${n.id.padEnd(16)} T${n.tier} ${r}/${n.maxRank} (${n.cost} P) ${n.name} – ${state}`;
  };

  return [
    {
      name: 'xp',
      description: 'Erfahrung anzeigen oder vergeben',
      usage: 'xp [menge]',
      run: ([v]) => {
        if (v === undefined) return status();
        const got = p.addXp(int(v, 'xp'), 'dev');
        return `+${formatCount(got)} XP – ${status()}`;
      },
    },
    {
      name: 'level',
      aliases: ['stufe'],
      description: 'Spielerstufe setzen',
      usage: `level <1-${PROGRESSION.maxLevel}>`,
      run: ([v]) => {
        p.setLevel(int(v, 'level'));
        return status();
      },
    },
    {
      name: 'prestige',
      description: 'Prestige-Aufstieg (auf Maximalstufe)',
      run: () => {
        if (!p.prestige()) {
          return p.prestigeRank >= PROGRESSION.prestige.maxRank
            ? 'Höchster Prestige-Rang erreicht'
            : `Erst Stufe ${PROGRESSION.maxLevel} erreichen (level ${PROGRESSION.maxLevel})`;
        }
        return `Prestige ${p.prestigeRank}! ${status()}`;
      },
    },
    {
      name: 'achievement',
      aliases: ['achievements', 'erfolg'],
      description: 'Erfolge auflisten oder freischalten',
      usage: 'achievement list [text] | unlock <id>',
      complete: (args) => (args.length <= 1 ? ['list', 'unlock'] : ACHIEVEMENTS.map((a) => a.id)),
      run: ([mode, arg]) => {
        if (mode === 'unlock') {
          if (!arg) throw new Error('achievement unlock <id>');
          if (!p.achievementTracker.unlock(arg)) throw new Error(`Unbekannt oder bereits freigeschaltet: ${arg}`);
          return `Erfolg freigeschaltet: ${arg}`;
        }
        const filter = (mode === 'list' ? arg : mode)?.toLowerCase();
        const lines = p
          .achievements()
          .filter((a) => !filter || a.id.includes(filter) || a.name.toLowerCase().includes(filter))
          .map(
            (a) =>
              `${a.unlockedAt > 0 ? '[x]' : '[ ]'} ${a.id.padEnd(20)} ${a.name} – ${formatCount(a.progress)}/${formatCount(a.target)}${a.hidden ? ' (versteckt)' : ''}`,
          );
        return [`${p.achievementTracker.unlockedCount}/${p.achievementTracker.total} Erfolge`, ...lines].join('\n');
      },
    },
    {
      name: 'challenge',
      aliases: ['challenges', 'herausforderung'],
      description: 'Tägliche / wöchentliche Herausforderungen',
      usage: 'challenge list | complete <id|nr> | claim <id>',
      complete: (args) => (args.length <= 1 ? ['list', 'complete', 'claim'] : []),
      run: ([mode, arg]) => {
        const views = p.challenges();
        if (mode === 'complete' || mode === 'claim') {
          if (!arg) throw new Error(`challenge ${mode} <id|nr>`);
          const target = /^\d+$/.test(arg) ? views[Number(arg)]?.id : arg;
          if (!target) throw new Error(`Unbekannt: ${arg}`);
          const ok = mode === 'complete' ? p.challengeTracker.complete(target) : p.claimChallenge(target);
          if (!ok) throw new Error(`Nicht möglich: ${target}`);
          return `${mode === 'complete' ? 'Abgeschlossen' : 'Belohnung erhalten'}: ${target}`;
        }
        return views
          .map(
            (c, i) =>
              `${i} ${c.period === 'daily' ? 'Täglich ' : 'Wöchentl'} ${c.completed ? '[x]' : '[ ]'} ${c.name}: ${c.description} ` +
              `${formatCount(c.progress)}/${formatCount(c.target)} – ${formatCount(c.xp)} XP, ${c.currency} Splitter` +
              `${c.cosmetic ? `, ${c.cosmetic}` : ''}${c.claimed ? ' (erhalten)' : ''}`,
          )
          .join('\n');
      },
    },
    {
      name: 'skill',
      aliases: ['skills', 'fertigkeit'],
      description: 'Fertigkeitsbaum',
      usage: 'skill list [ast] | unlock <id> | reset | respec | loadout grenade|ability <id|none>',
      complete: (args) =>
        args.length <= 1 ? ['list', 'unlock', 'reset', 'respec', 'loadout'] : SKILL_NODES.map((n) => n.id),
      run: ([mode, a, b]) => {
        const s = p.skills;
        switch (mode) {
          case 'unlock': {
            if (!a) throw new Error('skill unlock <id>');
            const check = s.check(a);
            if (!s.unlock(a)) throw new Error(`Nicht möglich (${check}): ${a}`);
            return skillLine(a);
          }
          case 'reset':
            s.reset();
            return `Fertigkeiten zurückgesetzt – ${s.available} Punkte`;
          case 'respec':
            if (!s.respec()) throw new Error(`Umverteilen nicht möglich (Kosten ${s.respecCost} Splitter, nicht im Run)`);
            return `Umverteilt – ${s.available} Punkte`;
          case 'loadout': {
            if ((a !== 'grenade' && a !== 'ability') || !b) throw new Error('skill loadout grenade|ability <id|none>');
            const id = b === 'none' ? null : b;
            if (!s.setLoadout(a, id)) throw new Error(`Nicht freigeschaltet: ${b}`);
            p.saveNow();
            return `Startausrüstung (${a}): ${id ?? 'Karten-Standard'} – ab dem nächsten Run`;
          }
          default: {
            const branch = (mode === 'list' ? a : mode) as SkillBranchId | undefined;
            const branches = branch && SKILL_BRANCH_IDS.includes(branch) ? [branch] : SKILL_BRANCH_IDS;
            const lines = [`${s.available} verfügbar / ${s.earned} verdient / ${s.spent} ausgegeben`];
            for (const br of branches) {
              lines.push(`— ${SKILL_BRANCHES[br].name} (${s.branchSpent(br)} P)`);
              for (const n of SKILL_NODES) if (n.branch === br) lines.push(skillLine(n.id));
            }
            return lines.join('\n');
          }
        }
      },
    },
    {
      name: 'profile',
      aliases: ['profil'],
      description: 'Profil: Stufe, Währung, Lebenszeit-Statistik',
      run: () => {
        const st = p.stats;
        const c = st.counters;
        const fav = st.favouriteWeapon;
        const waves = Object.entries(p.lifetime.highestWaves)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ');
        return [
          status(),
          `Rift-Splitter: ${formatCount(p.cosmetics.currency)} – Erfolge ${p.achievementTracker.unlockedCount}/${p.achievementTracker.total}`,
          `Runs ${formatCount(c.runs ?? 0)} – Kills ${formatCount(c.kills ?? 0)} – Kopfschüsse ${formatCount(c.headshots ?? 0)} – Genauigkeit ${pct(st.accuracy)}`,
          `Lieblingswaffe: ${fav ?? '–'} – Spielzeit ${Math.round((c.timePlayed ?? 0) / 60)} min`,
          `Höchste Wellen: ${waves || '–'}`,
        ].join('\n');
      },
    },
    {
      name: 'leaderboard',
      aliases: ['bestenliste'],
      description: 'Lokale Bestenliste',
      usage: 'leaderboard [map] [modus]',
      run: ([map, mode]) => {
        const list = p.leaderboard(map ?? deps.mapId(), mode);
        if (list.length === 0) return 'Noch keine Einträge';
        return list
          .map(
            (e, i) =>
              `${i + 1}. Welle ${e.wave} – ${formatCount(e.score)} Punkte – ${e.kills} Kills – ${Math.round(e.time)} s – ${new Date(e.date).toISOString().slice(0, 10)}`,
          )
          .join('\n');
      },
    },
    {
      name: 'weaponlevel',
      aliases: ['waffenstufe'],
      description: 'Waffenstufe setzen (Tarnungen)',
      usage: `weaponlevel <waffe> <1-${PROGRESSION.weapon.maxLevel}>`,
      complete: () => [...WEAPON_IDS],
      run: ([id, v]) => {
        if (!id) throw new Error('weaponlevel <waffe> <stufe>');
        if (v === undefined) {
          const w = p.weapon(id);
          if (!w) throw new Error(`Unbekannte Waffe: ${id}`);
          return `${id}: Stufe ${w.level} – Tarnungen: ${w.camos.join(', ') || '–'}`;
        }
        if (!p.weaponProgress.setLevel(id, int(v, 'stufe'))) throw new Error(`Unbekannte Waffe: ${id}`);
        const w = p.weapon(id)!;
        return `${id}: Stufe ${w.level} – Tarnungen: ${w.camos.join(', ') || '–'}`;
      },
    },
  ];
}
