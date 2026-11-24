import { z } from 'zod';
import type { SpendEntry } from '../../core/contracts/index.js';
import type { KeyValueStore } from '../../core/store/types.js';
import { minutesOfDay, weekdayOf } from '../../core/time/local-day.js';
import { minutesOfHhmm, ruleSchema } from './config.js';
import type { RuleConfig } from './config.js';

export const OWNER_RULES_KEY = 'rules';
export const MAX_OWNER_RULES = 30;

export type RuleSource = 'config' | 'owner';

export interface TaggedRule {
  rule: RuleConfig;
  source: RuleSource;
}

export type AddRuleResult = 'added' | 'duplicate' | 'full';
export type RemoveRuleResult = 'removed' | 'config' | 'missing';

export interface RuleStore {
  all(): Promise<TaggedRule[]>;
  owner(): Promise<RuleConfig[]>;
  add(rule: RuleConfig): Promise<AddRuleResult>;
  remove(id: string): Promise<RemoveRuleResult>;
}

const storedRules = z.array(ruleSchema);

export class KvRuleStore implements RuleStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly configRules: readonly RuleConfig[],
  ) {}

  async owner(): Promise<RuleConfig[]> {
    const stored = await this.kv.get<unknown>(OWNER_RULES_KEY);
    if (stored === undefined) return [];
    const parsed = storedRules.safeParse(stored);
    return parsed.success ? [...parsed.data] : [];
  }

  async all(): Promise<TaggedRule[]> {
    const ownerRules = await this.owner();
    return [
      ...this.configRules.map((rule): TaggedRule => ({ rule, source: 'config' })),
      ...ownerRules.map((rule): TaggedRule => ({ rule, source: 'owner' })),
    ];
  }

  async add(rule: RuleConfig): Promise<AddRuleResult> {
    const ownerRules = await this.owner();
    const duplicate =
      this.configRules.some((candidate) => candidate.id === rule.id) ||
      ownerRules.some((candidate) => candidate.id === rule.id);
    if (duplicate) return 'duplicate';
    if (ownerRules.length >= MAX_OWNER_RULES) return 'full';
    await this.kv.set(OWNER_RULES_KEY, [...ownerRules, rule]);
    return 'added';
  }

  async remove(id: string): Promise<RemoveRuleResult> {
    if (this.configRules.some((rule) => rule.id === id)) return 'config';
    const ownerRules = await this.owner();
    const next = ownerRules.filter((rule) => rule.id !== id);
    if (next.length === ownerRules.length) return 'missing';
    await this.kv.set(OWNER_RULES_KEY, next);
    return 'removed';
  }
}

/** True when the entry satisfies every condition the rule states. All bounds are inclusive. */
export function matchRule(entry: SpendEntry, rule: RuleConfig, timeZone: string): boolean {
  if (rule.categories !== undefined && !rule.categories.includes(entry.category)) return false;
  if (rule.merchants !== undefined) {
    const text = `${entry.merchant}\n${entry.merchantKey}`.toLowerCase();
    if (!rule.merchants.some((merchant) => text.includes(merchant.toLowerCase()))) return false;
  }
  const at = new Date(entry.at);
  const invalid = Number.isNaN(at.getTime());
  if (rule.weekdaysOnly === true) {
    if (invalid) return false;
    const weekday = weekdayOf(at, timeZone);
    if (weekday === 0 || weekday === 6) return false;
  }
  if (rule.timeFrom !== undefined || rule.timeTo !== undefined) {
    if (invalid) return false;
    const minutes = minutesOfDay(at, timeZone);
    if (rule.timeFrom !== undefined && minutes < minutesOfHhmm(rule.timeFrom)) return false;
    if (rule.timeTo !== undefined && minutes > minutesOfHhmm(rule.timeTo)) return false;
  }
  if (rule.minAmount !== undefined && entry.amount < rule.minAmount) return false;
  if (rule.maxAmount !== undefined && entry.amount > rule.maxAmount) return false;
  return true;
}
