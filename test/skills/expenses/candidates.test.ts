import { describe, expect, it } from 'vitest';
import type { SpendEntry } from '../../../src/core/contracts/index.js';
import { evaluateEntries } from '../../../src/skills/expenses/candidates.js';
import type { RuleConfig } from '../../../src/skills/expenses/config.js';
import { DecisionStore } from '../../../src/skills/expenses/decisions.js';
import type { MarkDecisionInput } from '../../../src/skills/expenses/decisions.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { NOW, entry, rule } from './helpers.js';

const TZ = 'Asia/Seoul';

async function evaluate(
  entries: SpendEntry[],
  rules: RuleConfig[],
  decisions: MarkDecisionInput[] = [],
) {
  const store = new DecisionStore(new MapKeyValueStore());
  for (const decision of decisions) await store.mark(decision);
  return evaluateEntries({
    entries,
    rules: rules.map((value) => ({ rule: value, source: 'owner' as const })),
    decisions: store,
    timeZone: TZ,
    month: '2026-11',
    currency: 'KRW',
  });
}

describe('evaluateEntries', () => {
  it('uses entry decision over merchant decision over the first matching rule', async () => {
    const report = await evaluate(
      [
        entry({ id: 'e1', amount: 5_000 }),
        entry({ id: 'e2', amount: 7_000 }),
        entry({ id: 'e3', amount: 9_000, category: 'transport', merchant: '택시 예시' }),
      ],
      [rule({ categories: ['food'] })],
      [
        { entryId: 'e1', decision: 'personal', at: NOW },
        { merchantKey: '카페 예시', decision: 'claim', ruleId: 'lunch', at: NOW },
      ],
    );

    const byId = new Map(report.items.map((item) => [item.entry.id, item]));
    expect(byId.get('e1')?.status).toBe('personal');
    expect(byId.get('e1')?.reason).toBe('entry_decision');
    expect(byId.get('e2')?.status).toBe('candidate');
    expect(byId.get('e2')?.reason).toBe('merchant_decision');
    expect(byId.get('e2')?.ruleId).toBe('lunch');
    expect(byId.get('e3')?.status).toBe('personal');
    expect(byId.get('e3')?.reason).toBe('no_rule');
    expect(report.candidateCount).toBe(1);
    expect(report.grandTotal).toBe(7_000);
    expect(report.totals).toEqual([
      { ruleId: 'lunch', name: '평일 점심 식대', count: 1, total: 7_000, overCap: false },
    ]);
  });

  it('asks about first-seen AI spend instead of claiming it', async () => {
    const entries = [
      entry({ id: 'ai1', merchant: 'OpenAI', category: 'ai', amount: 20_000, at: '2026-11-05T10:00:00+09:00' }),
    ];
    const rules = [rule({ id: 'ai_tools', name: '업무용 AI', categories: ['ai'] })];

    const first = await evaluate(entries, rules);
    expect(first.items[0]?.status).toBe('unsure');
    expect(first.items[0]?.reason).toBe('first_seen');
    expect(first.items[0]?.ruleId).toBe('ai_tools');
    expect(first.unsureCount).toBe(1);
    expect(first.candidateCount).toBe(0);
    expect(first.totals).toEqual([]);

    const after = await evaluate(entries, rules, [
      { merchantKey: 'openai', decision: 'claim', ruleId: 'ai_tools', at: NOW },
    ]);
    expect(after.items[0]?.status).toBe('candidate');
    expect(after.items[0]?.reason).toBe('merchant_decision');
    expect(after.totals).toEqual([
      { ruleId: 'ai_tools', name: '업무용 AI', count: 1, total: 20_000, overCap: false },
    ]);
  });

  it('keeps only positive, included amounts', async () => {
    const report = await evaluate(
      [
        entry({ id: 'neg', amount: -5_000 }),
        entry({ id: 'zero', amount: 0 }),
        entry({ id: 'excluded', amount: 5_000, excluded: true }),
        entry({ id: 'ok', amount: 5_000 }),
      ],
      [rule({})],
    );
    expect(report.items.map((item) => item.entry.id)).toEqual(['ok']);
    expect(report.candidateCount).toBe(1);
  });

  it('flags a rule total above its monthly cap but still lists the entries', async () => {
    const report = await evaluate(
      [entry({ id: 'a', amount: 5_000 }), entry({ id: 'b', amount: 4_000, at: '2026-11-12T12:00:00+09:00' })],
      [rule({ monthlyCap: 8_000 })],
    );
    expect(report.items.every((item) => item.status === 'candidate')).toBe(true);
    expect(report.totals[0]).toEqual({
      ruleId: 'lunch',
      name: '평일 점심 식대',
      count: 2,
      total: 9_000,
      cap: 8_000,
      overCap: true,
    });
    expect(report.grandTotal).toBe(9_000);
  });

  it('counts entries the owner claimed directly without a rule', async () => {
    const report = await evaluate(
      [entry({ id: 'taxi', category: 'transport', merchant: '택시 예시', amount: 9_000 })],
      [rule({ categories: ['food'] })],
      [{ entryId: 'taxi', decision: 'claim', at: NOW }],
    );
    expect(report.items[0]?.status).toBe('candidate');
    expect(report.items[0]?.ruleId).toBeUndefined();
    expect(report.totals).toEqual([{ count: 1, total: 9_000, overCap: false }]);
  });

  it('lists entries in time order', async () => {
    const report = await evaluate(
      [
        entry({ id: 'late', at: '2026-11-10T12:00:00+09:00' }),
        entry({ id: 'early', at: '2026-11-03T12:00:00+09:00' }),
      ],
      [rule({})],
    );
    expect(report.items.map((item) => item.entry.id)).toEqual(['early', 'late']);
  });
});
