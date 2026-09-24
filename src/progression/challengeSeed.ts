/**
 * Deterministic daily / weekly challenge sets (defs/challenges.ts): the same UTC date gives every
 * player the same challenges. Keys: `dailySeed(date)` (core/Rng) for days, the Monday of the UTC
 * week for weeks; the generator's Rng is seeded with key + CHALLENGE_RULES[period].seedSuffix.
 */
import type { ChallengePeriod } from '../core/events';
import { Rng, dailySeed } from '../core/Rng';
import {
  CHALLENGE_RULES,
  CHALLENGE_TEMPLATES,
  getChallengeTemplate,
  type ChallengeTemplateDef,
  type ChallengeVariantDef,
} from '../defs/challenges';
import type { ProgressCondition, SignalFilter } from '../defs/progression';

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;

export interface ChallengeInstance {
  /** `${period}:${key}:${index}`. */
  readonly id: string;
  readonly period: ChallengePeriod;
  readonly key: string;
  readonly index: number;
  readonly template: ChallengeTemplateDef;
  readonly variant: ChallengeVariantDef | null;
  readonly target: number;
  readonly condition: ProgressCondition;
  readonly name: string;
  readonly description: string;
  readonly xp: number;
  readonly currency: number;
  /** Cosmetic reward (id from the challenge pool), null = none. */
  readonly cosmetic: string | null;
}

/** Monday 00:00 UTC of the week containing `date`. */
export function weekStart(date: Date): Date {
  const day = Math.floor(date.getTime() / DAY_MS) * DAY_MS;
  // getUTCDay: 0 = Sunday … 6 = Saturday; Monday-based offset.
  const offset = (new Date(day).getUTCDay() + WEEK_DAYS - 1) % WEEK_DAYS;
  return new Date(day - offset * DAY_MS);
}

/** Rotation key of the period containing `date`. */
export function periodKey(period: ChallengePeriod, date: Date): string {
  if (period === 'daily') return dailySeed(date);
  return dailySeed(weekStart(date)).replace('daily', 'weekly');
}

/** When the period containing `date` ends (ms since epoch, exclusive). */
export function periodEnd(period: ChallengePeriod, date: Date): number {
  const dayStart = Math.floor(date.getTime() / DAY_MS) * DAY_MS;
  if (period === 'daily') return dayStart + DAY_MS;
  return weekStart(date).getTime() + WEEK_DAYS * DAY_MS;
}

/** German thousands separator ("1.500"). */
export function formatCount(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function fill(text: string, target: number, variant: ChallengeVariantDef | null): string {
  return text.replace('{n}', formatCount(target)).replace('{v}', variant?.label ?? '');
}

function roundTo(v: number, step: number): number {
  return step > 0 ? Math.round(v / step) * step : Math.round(v);
}

/** Build one instance (exported for tests and the dev console). */
export function buildInstance(
  period: ChallengePeriod,
  key: string,
  index: number,
  template: ChallengeTemplateDef,
  variant: ChallengeVariantDef | null,
  roll: number,
  cosmetic: string | null,
): ChallengeInstance | null {
  const range = template.targets[period];
  if (!range) return null;
  const rules = CHALLENGE_RULES[period];
  const scale = variant?.scale ?? 1;
  const step = Math.max(1, Math.round(range.step * scale));
  const raw = (range.min + (range.max - range.min) * roll) * scale;
  const target = Math.max(step, roundTo(raw, step));
  const R = CHALLENGE_RULES.rangeRewardScale;
  const rewardScale = (R.min + (R.max - R.min) * roll) * template.difficulty;
  let filter: SignalFilter | undefined = template.condition.filter;
  if (variant && template.variants) filter = { ...filter, [template.variants.tag]: variant.id };
  const c = template.condition;
  const condition: ProgressCondition =
    c.kind === 'max'
      ? { kind: 'max', metric: c.metric, target, filter }
      : { kind: 'count', metric: c.metric, target, scope: c.scope ?? 'lifetime', filter };
  return {
    id: `${period}:${key}:${index}`,
    period,
    key,
    index,
    template,
    variant,
    target,
    condition,
    name: fill(template.name, target, variant),
    description: fill(template.description, target, variant),
    xp: Math.max(
      CHALLENGE_RULES.rewardRoundTo,
      roundTo(rules.xp * rewardScale, CHALLENGE_RULES.rewardRoundTo),
    ),
    currency: Math.max(1, Math.round(rules.currency * rewardScale)),
    cosmetic,
  };
}

/**
 * The challenge set of a period key: `count` distinct templates (weighted), a variant and a
 * target each. `cosmeticPool`: ids a reward slot may grant (the same for everybody).
 */
export function generateChallengeSet(
  period: ChallengePeriod,
  key: string,
  cosmeticPool: readonly string[] = [],
  templates: readonly ChallengeTemplateDef[] = CHALLENGE_TEMPLATES,
): ChallengeInstance[] {
  const rules = CHALLENGE_RULES[period];
  const rng = new Rng(key + rules.seedSuffix);
  const pool = templates.filter((t) => t.targets[period] !== undefined && t.weight > 0);
  const out: ChallengeInstance[] = [];
  for (let i = 0; i < rules.count && pool.length > 0; i++) {
    const template = rng.weighted(pool, (t) => t.weight);
    pool.splice(pool.indexOf(template), 1);
    const variant = template.variants ? rng.pick(template.variants.values) : null;
    const roll = rng.next();
    const cosmetic = i < rules.cosmeticSlots && cosmeticPool.length > 0 ? rng.pick(cosmeticPool) : null;
    const inst = buildInstance(period, key, i, template, variant, roll, cosmetic);
    if (inst) out.push(inst);
  }
  return out;
}

/** Template ids of a set (stored to detect sets generated by other defs). */
export function templateIds(set: readonly ChallengeInstance[]): string[] {
  return set.map((c) => c.template.id);
}

/** True when every stored template id still exists (the set can be regenerated). */
export function knownTemplates(ids: readonly string[]): boolean {
  return ids.every((id) => getChallengeTemplate(id) !== undefined);
}
