/**
 * Dev console `quest`: the map quest's progress, finish the current step, finish everything.
 */
import type { ConsoleCommand } from '../core/contracts';
import type { QuestSystem } from './QuestSystem';

export function createQuestCommands(deps: { quest: QuestSystem }): ConsoleCommand[] {
  const { quest } = deps;
  return [
    {
      name: 'quest',
      description: 'Karten-Quest (Easter Egg): Stand, Schritt abschließen, alles abschließen',
      usage: 'quest status | quest step | quest complete',
      complete: () => ['status', 'step', 'complete'],
      run: (args) => {
        const m = quest.machine;
        if (!m) return 'Keine Quest auf dieser Karte.';
        const sub = args[0] ?? 'status';
        if (sub === 'status') {
          const lines = m.def.steps.map((s, i) => {
            const mark = i < m.step ? '✔' : i === m.step ? '▶' : '·';
            const extra = i === m.step ? ` ${Math.round(m.progress * 100)} %` : '';
            return `${mark} ${i + 1}. ${s.id} (${s.kind})${extra}`;
          });
          const head = `${m.def.name} – ${m.completed ? 'abgeschlossen' : `Schritt ${m.step + 1}/${m.steps}`}`;
          const carry = m.carrying ? `\nträgt: ${m.carrying}` : '';
          return [head, ...lines].join('\n') + carry;
        }
        if (sub === 'step') {
          if (!quest.advance()) return 'Quest bereits abgeschlossen.';
          return quest.completed ? 'Quest abgeschlossen.' : `Weiter mit Schritt ${quest.step + 1}.`;
        }
        if (sub === 'complete') {
          if (quest.completed) return 'Quest bereits abgeschlossen.';
          quest.complete();
          return 'Quest abgeschlossen.';
        }
        throw new Error('Usage: quest status | quest step | quest complete');
      },
    },
  ];
}
