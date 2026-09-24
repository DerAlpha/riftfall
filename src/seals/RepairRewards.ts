/**
 * Points for restored seal segments (ECONOMY.repair: `perPlank` each through EconomyApi.earn with
 * reason 'repair', at most `capPerWave` points – before the multiplier – per wave; the cap resets
 * on wave:start). Anti-farming: a player cannot stand at a seal the swarm keeps tearing and repair
 * forever for points.
 *
 * economy/PointsRules.awardRepair implements the same rule; SealSystem takes either through
 * RepairRewardsApi (use one of them, not both, or the cap applies twice).
 */
import type { EconomyApi } from '../core/contracts';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, Vec3Like } from '../core/events';
import { ECONOMY } from '../defs/economy';

export interface RepairRewardsApi {
  /** Pay for `segments` restored segments within the per-wave cap; returns the points credited. */
  awardRepair(segments: number, position?: Vec3Like): number;
  /** Points (before the multiplier) still payable this wave (prompt hint); optional. */
  readonly repairAllowance?: number;
}

export interface RepairRuleDef {
  readonly perPlank: number;
  readonly capPerWave: number;
}

export interface RepairRewardsDeps {
  events: EventBus<GameEvents>;
  economy: Pick<EconomyApi, 'earn'>;
}

export class RepairRewards implements RepairRewardsApi {
  /** Points credited for repairs this run (after the multiplier). */
  earned = 0;
  private paidThisWave = 0;
  private readonly offs: (() => void)[];

  constructor(
    private readonly deps: RepairRewardsDeps,
    private readonly def: RepairRuleDef = ECONOMY.repair,
  ) {
    this.offs = [
      deps.events.on('wave:start', () => {
        this.paidThisWave = 0;
      }),
    ];
  }

  get repairAllowance(): number {
    return Math.max(0, this.def.capPerWave - this.paidThisWave);
  }

  awardRepair(segments: number, position?: Vec3Like): number {
    if (!(segments > 0)) return 0;
    const amount = Math.min(this.repairAllowance, Math.floor(segments) * this.def.perPlank);
    if (!(amount > 0)) return 0;
    this.paidThisWave += amount;
    const got = this.deps.economy.earn(amount, 'repair', position);
    this.earned += got;
    return got;
  }

  /** New run. */
  reset(): void {
    this.paidThisWave = 0;
    this.earned = 0;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
