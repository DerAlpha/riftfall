/**
 * Skill tree (defs/skills.ts) on ProfileData.skills: point accounting, purchase rules
 * (prerequisites, tier gates, points), respec, the stat modifiers of every bought rank and the
 * run bonuses. The tree never holds more than it may: attach() repairs loaded allocations
 * (unknown nodes, ranks above max, missing prerequisites / tier gates, overspending).
 *
 * Stat modifiers use the source `skill:<nodeId>`: applyTo() removes the sources it applied last
 * time and adds the current ones, so it can run after every StatSystem.reset() and after changes.
 */
import type {
  PlayerProgressData,
  SkillCheck,
  SkillRunBonuses,
  SkillTreeApi,
  SkillTreeData,
  StatModifier,
  StatsApi,
} from '../core/contracts';
import { PROGRESSION } from '../defs/progression';
import {
  SKILL_BRANCH_IDS,
  SKILL_NODES,
  SKILL_RULES,
  getSkillNode,
  skillSource,
  type SkillBranchId,
  type SkillNodeDef,
} from '../defs/skills';

export interface SkillTreeContext {
  /** Level / prestige state the points derive from. */
  progress(): Readonly<PlayerProgressData>;
  /** Rift-Splitter for paid respecs. */
  spendCurrency(amount: number): boolean;
  /** A run is going (respecs are refused, SKILL_RULES.respec.duringRun). */
  inRun(): boolean;
  /** Something changed (`nodeId` null: respec / reset / repair). */
  onChange(nodeId: string | null, rank: number): void;
}

/** Points from levels (highest ever) and prestige ranks. */
export function skillPointsEarned(p: Readonly<PlayerProgressData>): number {
  const S = PROGRESSION.skillPoints;
  const levels = Math.max(0, Math.min(PROGRESSION.maxLevel, Math.floor(p.highestLevel)) - 1);
  return levels * S.perLevel + Math.max(0, Math.floor(p.prestige)) * S.perPrestige;
}

function rankValue(op: 'add' | 'mul', value: number, rank: number): number {
  return op === 'add' ? value * rank : Math.pow(value, rank);
}

function emptyBonuses(): SkillRunBonuses {
  return {
    startPoints: 0,
    startGrenades: 0,
    boxCashback: 0,
    dash: false,
    doubleJump: false,
    grenades: [...SKILL_RULES.defaultGrenades],
    abilities: [...SKILL_RULES.defaultAbilities],
  };
}

/** Max fraction a cashback may reach (a free box would break the economy). */
const MAX_CASHBACK = 0.9;

export class SkillTree implements SkillTreeApi {
  private data!: SkillTreeData;
  private _bonuses: SkillRunBonuses = emptyBonuses();
  private readonly applied = new Set<string>();

  constructor(
    data: SkillTreeData,
    private readonly ctx: SkillTreeContext,
    private readonly nodes: readonly SkillNodeDef[] = SKILL_NODES,
  ) {
    this.attach(data);
  }

  /** Bind to (another) profile's skill data and repair it. */
  attach(data: SkillTreeData): void {
    this.data = data;
    this.repair();
    this.recomputeBonuses();
  }

  get earned(): number {
    return skillPointsEarned(this.ctx.progress());
  }

  get spent(): number {
    let sum = 0;
    for (const n of this.nodes) sum += this.rank(n.id) * n.cost;
    return sum;
  }

  get available(): number {
    return Math.max(0, this.earned - this.spent);
  }

  /** Total ranks bought. */
  get ranksBought(): number {
    let sum = 0;
    for (const n of this.nodes) sum += this.rank(n.id);
    return sum;
  }

  get respecs(): number {
    return this.data.respecs;
  }

  /** Rift-Splitter the next respec costs (0 while free ones are left). */
  get respecCost(): number {
    return this.data.respecs < SKILL_RULES.respec.free ? 0 : SKILL_RULES.respec.currency;
  }

  get bonuses(): Readonly<SkillRunBonuses> {
    return this._bonuses;
  }

  get loadout(): Readonly<SkillTreeData['loadout']> {
    return this.data.loadout;
  }

  rank(nodeId: string): number {
    const r = this.data.ranks[nodeId];
    return typeof r === 'number' && r > 0 ? r : 0;
  }

  branchSpent(branch: SkillBranchId): number {
    let sum = 0;
    for (const n of this.nodes) if (n.branch === branch) sum += this.rank(n.id) * n.cost;
    return sum;
  }

  /** Every node of the branch at its max rank. */
  branchComplete(branch: SkillBranchId): boolean {
    return this.nodes.every((n) => n.branch !== branch || this.rank(n.id) >= n.maxRank);
  }

  check(nodeId: string): SkillCheck {
    const node = this.node(nodeId);
    if (!node) return 'unknown';
    if (this.rank(nodeId) >= node.maxRank) return 'maxed';
    if (!node.requires.every((id) => this.rank(id) > 0)) return 'locked';
    if (this.branchSpent(node.branch) < tierGate(node.tier)) return 'tier';
    if (this.available < node.cost) return 'points';
    return 'ok';
  }

  unlock(nodeId: string): boolean {
    if (this.check(nodeId) !== 'ok') return false;
    const rank = this.rank(nodeId) + 1;
    this.data.ranks[nodeId] = rank;
    this.recomputeBonuses();
    this.ctx.onChange(nodeId, rank);
    return true;
  }

  respec(): boolean {
    if (!SKILL_RULES.respec.duringRun && this.ctx.inRun()) return false;
    if (this.spent === 0) return false;
    const cost = this.respecCost;
    if (cost > 0 && !this.ctx.spendCurrency(cost)) return false;
    this.data.respecs++;
    this.clearRanks();
    return true;
  }

  /** Dev console `skill reset`: refund everything, no rules, no respec counted. */
  reset(): void {
    this.clearRanks();
  }

  /** Choose the run's start grenade / ability (must be licensed; null = the map loadout). */
  setLoadout(kind: 'grenade' | 'ability', id: string | null): boolean {
    const allowed = kind === 'grenade' ? this._bonuses.grenades : this._bonuses.abilities;
    if (id !== null && !allowed.includes(id)) return false;
    this.data.loadout[kind] = id;
    return true;
  }

  modifiers(): StatModifier[] {
    const out: StatModifier[] = [];
    for (const n of this.nodes) {
      const rank = this.rank(n.id);
      if (rank <= 0) continue;
      for (const e of n.effects) {
        if (e.kind !== 'stat') continue;
        out.push({ source: skillSource(n.id), stat: e.stat, op: e.op, value: rankValue(e.op, e.value, rank) });
      }
    }
    return out;
  }

  /** Replace the tree's modifiers on the stat table (run start, after a change). */
  applyTo(stats: Pick<StatsApi, 'addModifier' | 'removeSource'>): void {
    for (const source of this.applied) stats.removeSource(source);
    this.applied.clear();
    for (const m of this.modifiers()) {
      stats.addModifier(m);
      this.applied.add(m.source);
    }
  }

  // -------------------------------------------------------------------------

  private node(id: string): SkillNodeDef | undefined {
    return this.nodes === SKILL_NODES ? getSkillNode(id) : this.nodes.find((n) => n.id === id);
  }

  private clearRanks(): void {
    for (const k of Object.keys(this.data.ranks)) delete this.data.ranks[k];
    this.recomputeBonuses();
    this.ctx.onChange(null, 0);
  }

  /**
   * Keep only allocations the rules allow: known nodes, ranks within 1..maxRank, prerequisites
   * and tier gates met (tier by tier), and never more points than earned (else a full refund).
   */
  private repair(): void {
    const ranks = this.data.ranks;
    const clean: Record<string, number> = {};
    const spentIn: Record<SkillBranchId, number> = { offensive: 0, survival: 0, tactics: 0 };
    const tiers = [...new Set(this.nodes.map((n) => n.tier))].sort((a, b) => a - b);
    for (const tier of tiers) {
      const gateSpent = { ...spentIn };
      for (const n of this.nodes) {
        if (n.tier !== tier) continue;
        const raw = ranks[n.id];
        if (typeof raw !== 'number' || !(raw >= 1)) continue;
        const rank = Math.min(n.maxRank, Math.floor(raw));
        if (!n.requires.every((id) => (clean[id] ?? 0) > 0)) continue;
        if (gateSpent[n.branch] < tierGate(n.tier)) continue;
        clean[n.id] = rank;
        spentIn[n.branch] += rank * n.cost;
      }
    }
    let total = 0;
    for (const b of SKILL_BRANCH_IDS) total += spentIn[b];
    for (const k of Object.keys(ranks)) delete ranks[k];
    if (total <= this.earned) Object.assign(ranks, clean);
    // Licences may have gone with the repair.
    const b = this.computeBonuses();
    if (this.data.loadout.grenade !== null && !b.grenades.includes(this.data.loadout.grenade)) {
      this.data.loadout.grenade = null;
    }
    if (this.data.loadout.ability !== null && !b.abilities.includes(this.data.loadout.ability)) {
      this.data.loadout.ability = null;
    }
  }

  private recomputeBonuses(): void {
    this._bonuses = this.computeBonuses();
  }

  private computeBonuses(): SkillRunBonuses {
    const b = emptyBonuses();
    const grenades = b.grenades as string[];
    const abilities = b.abilities as string[];
    for (const n of this.nodes) {
      const rank = this.rank(n.id);
      if (rank <= 0) continue;
      for (const e of n.effects) {
        switch (e.kind) {
          case 'startPoints':
            b.startPoints += e.value * rank;
            break;
          case 'startGrenades':
            b.startGrenades += e.value * rank;
            break;
          case 'boxCashback':
            b.boxCashback = Math.min(MAX_CASHBACK, b.boxCashback + e.value * rank);
            break;
          case 'movement':
            b[e.ability] = true;
            break;
          case 'grenade':
            if (!grenades.includes(e.id)) grenades.push(e.id);
            break;
          case 'ability':
            if (!abilities.includes(e.id)) abilities.push(e.id);
            break;
          case 'stat':
            break;
        }
      }
    }
    return b;
  }
}

export function tierGate(tier: number): number {
  const gates = SKILL_RULES.tierGates;
  return gates[Math.min(gates.length, Math.max(1, Math.floor(tier))) - 1] ?? 0;
}
