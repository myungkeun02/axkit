import type { SpendEntry } from '../../core/contracts/index.js';
import type { DecisionLookup, DecisionRecord } from './decisions.js';
import { matchRule } from './rules.js';
import type { TaggedRule } from './rules.js';

export type CandidateStatus = 'candidate' | 'unsure' | 'personal';
export type CandidateReason = 'entry_decision' | 'merchant_decision' | 'rule' | 'first_seen' | 'no_rule';

export interface Candidate {
  entry: SpendEntry;
  status: CandidateStatus;
  ruleId?: string;
  ruleName?: string;
  reason: CandidateReason;
}

export interface RuleTotal {
  ruleId?: string;
  name?: string;
  count: number;
  total: number;
  cap?: number;
  overCap: boolean;
}

export interface CandidateReport {
  month: string;
  currency: string;
  items: Candidate[];
  totals: RuleTotal[];
  candidateCount: number;
  unsureCount: number;
  grandTotal: number;
}

export interface EvaluateOptions {
  entries: readonly SpendEntry[];
  rules: readonly TaggedRule[];
  decisions: DecisionLookup;
  timeZone: string;
  month: string;
  currency: string;
}

// First-seen AI/infra/other charges are work tools in practice, but the owner must say yes once.
const FIRST_SEEN_CATEGORIES = new Set<SpendEntry['category']>(['ai', 'infra', 'other']);

function ruleOf(id: string | undefined, rules: readonly TaggedRule[]): TaggedRule['rule'] | undefined {
  if (id === undefined) return undefined;
  return rules.find((tagged) => tagged.rule.id === id)?.rule;
}

function fromDecision(
  entry: SpendEntry,
  record: DecisionRecord,
  reason: CandidateReason,
  rules: readonly TaggedRule[],
): Candidate {
  const rule = ruleOf(record.ruleId, rules);
  return {
    entry,
    status: record.decision === 'claim' ? 'candidate' : 'personal',
    ...(record.ruleId !== undefined ? { ruleId: record.ruleId } : {}),
    ...(rule !== undefined ? { ruleName: rule.name } : {}),
    reason,
  };
}

async function decide(entry: SpendEntry, options: EvaluateOptions): Promise<Candidate> {
  const entryDecision = await options.decisions.entry(entry.id);
  if (entryDecision !== undefined) return fromDecision(entry, entryDecision, 'entry_decision', options.rules);
  const merchantDecision = await options.decisions.merchant(entry.merchantKey);
  if (merchantDecision !== undefined) {
    return fromDecision(entry, merchantDecision, 'merchant_decision', options.rules);
  }
  const matched = options.rules.find((tagged) => matchRule(entry, tagged.rule, options.timeZone));
  if (matched === undefined) return { entry, status: 'personal', reason: 'no_rule' };
  const base = { entry, ruleId: matched.rule.id, ruleName: matched.rule.name };
  return FIRST_SEEN_CATEGORIES.has(entry.category)
    ? { ...base, status: 'unsure', reason: 'first_seen' }
    : { ...base, status: 'candidate', reason: 'rule' };
}

function buildTotals(items: readonly Candidate[], rules: readonly TaggedRule[]): RuleTotal[] {
  const byId = new Map<string, { count: number; total: number; name?: string; cap?: number }>();
  let directCount = 0;
  let directTotal = 0;
  for (const item of items) {
    if (item.status !== 'candidate') continue;
    if (item.ruleId === undefined) {
      directCount += 1;
      directTotal += item.entry.amount;
      continue;
    }
    const rule = ruleOf(item.ruleId, rules);
    const current = byId.get(item.ruleId) ?? { count: 0, total: 0 };
    current.count += 1;
    current.total += item.entry.amount;
    if (item.ruleName !== undefined) current.name = item.ruleName;
    if (rule?.monthlyCap !== undefined) current.cap = rule.monthlyCap;
    byId.set(item.ruleId, current);
  }

  const totals: RuleTotal[] = [];
  for (const tagged of rules) {
    const value = byId.get(tagged.rule.id);
    if (value === undefined) continue;
    totals.push({
      ruleId: tagged.rule.id,
      name: tagged.rule.name,
      count: value.count,
      total: value.total,
      ...(tagged.rule.monthlyCap !== undefined
        ? { cap: tagged.rule.monthlyCap, overCap: value.total > tagged.rule.monthlyCap }
        : { overCap: false }),
    });
    byId.delete(tagged.rule.id);
  }
  for (const [ruleId, value] of byId) {
    totals.push({
      ruleId,
      ...(value.name !== undefined ? { name: value.name } : {}),
      count: value.count,
      total: value.total,
      ...(value.cap !== undefined ? { cap: value.cap, overCap: value.total > value.cap } : { overCap: false }),
    });
  }
  if (directCount > 0) {
    totals.push({ count: directCount, total: directTotal, overCap: false });
  }
  return totals;
}

/** Classifies one month's entries: entry decision > merchant decision > first matching rule. */
export async function evaluateEntries(options: EvaluateOptions): Promise<CandidateReport> {
  const usable = options.entries
    .filter((entry) => entry.amount > 0 && entry.excluded !== true)
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  const items: Candidate[] = [];
  for (const entry of usable) items.push(await decide(entry, options));

  const candidateItems = items.filter((item) => item.status === 'candidate');
  return {
    month: options.month,
    currency: options.currency,
    items,
    totals: buildTotals(items, options.rules),
    candidateCount: candidateItems.length,
    unsureCount: items.filter((item) => item.status === 'unsure').length,
    grandTotal: candidateItems.reduce((sum, item) => sum + item.entry.amount, 0),
  };
}
