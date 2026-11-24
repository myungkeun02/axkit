import { describe, expect, it } from 'vitest';
import type { TestContext } from '../../support/context.js';
import type { TestContextOptions } from '../../support/context.js';
import type { SubscriptionsView } from '../../../src/skills/spending/tools-insights.js';
import type { MonthPatterns } from '../../../src/skills/spending/patterns.js';
import { NOW, registeredTool, setupSpending, spendReader } from './helpers.js';

async function setup(options: TestContextOptions = {}): Promise<TestContext> {
  return setupSpending({ now: NOW, ...options });
}

async function add(
  context: TestContext,
  merchant: string,
  amount: number,
  date: string,
): Promise<void> {
  const outcome = await context.ctx.tools.execute('spending.add', { merchant, amount, date });
  if (outcome.status !== 'done') throw new Error(JSON.stringify(outcome));
}

async function patterns(context: TestContext, input: unknown = {}): Promise<MonthPatterns> {
  const outcome = await context.ctx.tools.execute('spending.patterns', input);
  if (outcome.status !== 'done') throw new Error(JSON.stringify(outcome));
  return outcome.output as MonthPatterns;
}

async function subscriptions(context: TestContext): Promise<SubscriptionsView> {
  const outcome = await context.ctx.tools.execute('subscriptions.list', {});
  if (outcome.status !== 'done') throw new Error(JSON.stringify(outcome));
  return outcome.output as SubscriptionsView;
}

describe('spending.patterns tool', () => {
  it('analyzes the current month by default', async () => {
    const context = await setup();
    await add(context, '스타벅스', 12_300, '2026-11-02');
    await add(context, '이마트', 50_000, '2026-11-05');

    const result = await patterns(context);

    expect(result.month).toBe('2026-11');
    expect(result.currency).toBe('KRW');
    expect(result.total).toBe(62_300);
    expect(result.byCategory.map((category) => category.category)).toEqual(['groceries', 'cafe']);
    expect(result.topMerchants[0]).toMatchObject({ merchant: '이마트', total: 50_000 });
  });

  it('analyzes an explicit month', async () => {
    const context = await setup();
    await add(context, '이마트', 30_000, '2026-10-03');
    await add(context, '이마트', 50_000, '2026-11-05');

    const result = await patterns(context, { month: '2026-10' });

    expect(result.month).toBe('2026-10');
    expect(result.total).toBe(30_000);
    expect(result.count).toBe(1);
  });

  it('rejects a malformed month', async () => {
    const context = await setup();
    const outcome = await context.ctx.tools.execute('spending.patterns', { month: '2026-13' });
    expect(outcome.status).toBe('invalid_input');
  });

  it('is a read-only tool', async () => {
    const context = await setup();
    expect(registeredTool(context, 'spending.patterns')?.effects).toEqual(['read']);
  });
});

describe('subscriptions.list tool', () => {
  async function seed(context: TestContext): Promise<void> {
    for (const date of ['2026-09-15', '2026-10-15', '2026-11-15']) {
      await add(context, '넷플릭스', 10_000, date);
    }
    await add(context, 'Spotify', 120_000, '2025-11-20');
    await add(context, 'Spotify', 120_000, '2026-11-15');
  }

  it('lists detected subscriptions with the next date and a monthly-equivalent total', async () => {
    const context = await setup();
    await seed(context);

    const result = await subscriptions(context);

    expect(result.currency).toBe('KRW');
    expect(result.monthlyEquivalentTotal).toBe(20_000);
    expect(result.subscriptions.map((sub) => [sub.key, sub.cadence, sub.nextDate])).toEqual([
      ['넷플릭스:monthly', 'monthly', '2026-12-15'],
      ['spotify:yearly', 'yearly', '2027-11-15'],
    ]);
    expect(result.subscriptions[1]).toMatchObject({ amount: 120_000, charges: 2, lapsed: false });
  });

  it('leaves excluded entries out', async () => {
    const context = await setup();
    await seed(context);
    const entries = await spendReader(context).entries({
      from: new Date('2026-09-01T00:00:00+09:00'),
      to: new Date('2026-12-01T00:00:00+09:00'),
    });
    for (const entry of entries.filter((found) => found.merchant === '넷플릭스')) {
      await context.ctx.tools.execute('spending.exclude', { entryId: entry.id, excluded: true });
    }

    const result = await subscriptions(context);
    expect(result.subscriptions.map((sub) => sub.key)).toEqual(['spotify:yearly']);
  });

  it('is a read-only tool', async () => {
    const context = await setup();
    expect(registeredTool(context, 'subscriptions.list')?.effects).toEqual(['read']);
  });

  it('is not registered when subscriptions are off', async () => {
    const context = await setup({ config: { subscriptions: false } });
    expect(registeredTool(context, 'subscriptions.list')).toBeUndefined();
    expect(registeredTool(context, 'spending.patterns')).toBeDefined();
  });
});
