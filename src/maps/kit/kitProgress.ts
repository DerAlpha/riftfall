/**
 * Map-kit progress signals (M7 → M9 progression): a completed map quest signals 'questComplete'
 * (tag map: the map's quest achievement, defs/achievements.ts MAPS) and every enemy killed by a
 * trap signals 'trapKill' (tags map + weapon `trap:<kind>`). RunRecorder only records player-source
 * events, so the kit feeds these two itself. Returns the unsubscribe.
 */
import type { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { ECONOMY } from '../../defs/economy';
import { clearTags, createSignal, type ProgressSignal } from '../../progression/signals';

export interface KitProgressDeps {
  events: EventBus<GameEvents>;
  sink: { signal(sig: ProgressSignal): void };
  mapId: string;
  /** Current run mode (RunFlow.mode). */
  mode(): string;
}

export function wireKitProgress(deps: KitProgressDeps): () => void {
  const sig = createSignal();
  const emit = (metric: ProgressSignal['metric'], weapon: string | null): void => {
    clearTags(sig.tags);
    sig.tags.map = deps.mapId;
    sig.tags.mode = deps.mode();
    sig.tags.weapon = weapon;
    sig.metric = metric;
    sig.amount = 1;
    deps.sink.signal(sig);
  };
  const P = ECONOMY.points;
  const offs = [
    deps.events.on('quest:completed', (e) => {
      if (e.mapId === deps.mapId) emit('questComplete', null);
    }),
    deps.events.on('combat:kill', (e) => {
      // Enemies only (training dummies and quest targets live outside the enemy id range).
      if (e.source !== 'trap' || e.targetId < P.rewardIdMin || e.targetId > P.rewardIdMax) return;
      emit('trapKill', e.weaponId);
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
}
