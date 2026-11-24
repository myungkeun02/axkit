import { describe, expect, it } from 'vitest';
import { companySpentToday, overCompanyBudget } from '../../../src/skills/company/budget.js';
import { NOW } from './helpers.js';
import { FakeUsage } from './work-helpers.js';

const ZONE = 'Asia/Seoul';

function usage(costUsd: number): FakeUsage {
  return new FakeUsage([
    { purpose: 'company.lead.plan', calls: 1, failures: 0, costUsd, inputTokens: 10, outputTokens: 10 },
  ]);
}

describe('companySpentToday', () => {
  it('sums only company purposes from the start of the owner day', async () => {
    const reader = usage(0.12);

    expect(await companySpentToday(reader, NOW, ZONE)).toBeCloseTo(0.12);
    expect(reader.queries[0]?.prefix).toBe('company.');
    expect(reader.queries[0]?.since.toISOString()).toBe('2026-11-17T15:00:00.000Z');
  });

  it('treats a missing usage reader as zero spend', async () => {
    expect(await companySpentToday(undefined, NOW, ZONE)).toBe(0);
  });
});

describe('overCompanyBudget', () => {
  it('is false under the limit and true at or over it', async () => {
    expect(await overCompanyBudget(usage(0.1), NOW, ZONE, 0.3)).toBe(false);
    expect(await overCompanyBudget(usage(0.3), NOW, ZONE, 0.3)).toBe(true);
  });

  it('treats dailyUsd 0 as no model work, even without usage', async () => {
    expect(await overCompanyBudget(undefined, NOW, ZONE, 0)).toBe(true);
  });
});
