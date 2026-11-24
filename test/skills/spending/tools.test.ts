import { describe, expect, it } from 'vitest';
import type { SpendEntryView, SpendingSummary } from '../../../src/skills/spending/tools.js';
import type { TestContext } from '../../support/context.js';
import { notice, registeredTool, setupSpending } from './helpers.js';

async function execute(context: TestContext, name: string, input: Record<string, unknown>): Promise<unknown> {
  const outcome = await context.ctx.tools.execute(name, input);
  if (outcome.status !== 'done') throw new Error(`${name}: ${JSON.stringify(outcome)}`);
  return outcome.output;
}

async function add(context: TestContext, input: Record<string, unknown>): Promise<SpendEntryView> {
  return (await execute(context, 'spending.add', input)) as SpendEntryView;
}

async function list(context: TestContext, input: Record<string, unknown> = {}): Promise<SpendEntryView[]> {
  return (await execute(context, 'spending.list', input)) as SpendEntryView[];
}

async function summary(context: TestContext, input: Record<string, unknown> = {}): Promise<SpendingSummary> {
  return (await execute(context, 'spending.summary', input)) as SpendingSummary;
}

interface Seeded {
  context: TestContext;
  cafe: SpendEntryView;
  grocery: SpendEntryView;
  october: SpendEntryView;
}

async function seeded(): Promise<Seeded> {
  const context = await setupSpending();
  const cafe = await add(context, { merchant: '스타벅스', amount: 12_300, date: '2026-11-02', time: '09:30' });
  const grocery = await add(context, { merchant: '이마트', amount: 50_000, date: '2026-11-05' });
  await context.bus.emit('money.notice', notice({
    text: '신한카드(1234)취소 5,000원 11/10 10:00 스타벅스',
  }));
  const october = await add(context, { merchant: '쿠팡', amount: 30_000, date: '2026-10-20' });
  return { context, cafe, grocery, october };
}

describe('spending.list', () => {
  it('lists the current month newest first with home-currency views', async () => {
    const { context } = await seeded();
    const found = await list(context);

    expect(found.map((entry) => entry.merchant)).toEqual(['스타벅스', '이마트', '스타벅스']);
    expect(found[0]).toMatchObject({
      merchant: '스타벅스',
      amount: -5_000,
      currency: 'KRW',
      category: '카페',
      date: '2026-11-10',
      time: '10:00',
    });
    expect(found[2]).toMatchObject({ amount: 12_300, category: '카페', time: '09:30' });
  });

  it('filters by category, merchant text and limit', async () => {
    const { context } = await seeded();

    expect((await list(context, { category: 'cafe' })).map((entry) => entry.amount)).toEqual([-5_000, 12_300]);
    expect(await list(context, { merchant: '이마트' })).toHaveLength(1);
    expect(await list(context, { merchant: '스타벅스' })).toHaveLength(2);
    expect(await list(context, { limit: 1 })).toHaveLength(1);
  });

  it('accepts an explicit month and returns nothing for an empty one', async () => {
    const { context } = await seeded();

    const found = await list(context, { month: '2026-10' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ merchant: '쿠팡', amount: 30_000, category: '쇼핑' });
    expect(await list(context, { month: '2026-09' })).toHaveLength(0);
  });

  it('rejects an invalid month', async () => {
    const { context } = await seeded();
    const outcome = await context.ctx.tools.execute('spending.list', { month: '2026-13' });

    expect(outcome.status).toBe('invalid_input');
  });

  it('hides excluded entries and shows them again after restore', async () => {
    const { context, grocery } = await seeded();

    await execute(context, 'spending.exclude', { entryId: grocery.id });
    expect((await list(context)).map((entry) => entry.merchant)).toEqual(['스타벅스', '스타벅스']);

    await execute(context, 'spending.exclude', { entryId: grocery.id, excluded: false });
    expect(await list(context)).toHaveLength(3);
  });
});

describe('spending.summary', () => {
  it('nets cancellations and compares with the previous month', async () => {
    const { context } = await seeded();
    const found = await summary(context);

    expect(found).toMatchObject({
      month: '2026-11',
      currency: 'KRW',
      total: 57_300,
      count: 3,
      previousMonth: '2026-10',
      previousTotal: 30_000,
      changePercent: 91,
    });
    expect(found.byCategory.map((category) => [category.category, category.total, category.count])).toEqual([
      ['groceries', 50_000, 1],
      ['cafe', 7_300, 2],
    ]);
    expect(found.topMerchants.map((merchant) => [merchant.merchant, merchant.total])).toEqual([
      ['이마트', 50_000],
      ['스타벅스', 7_300],
    ]);
  });

  it('reports a null change when the previous month had no spending', async () => {
    const context = await setupSpending();
    await add(context, { merchant: '스타벅스', amount: 12_300, date: '2026-11-02' });

    expect(await summary(context)).toMatchObject({ previousTotal: 0, changePercent: null });
  });

  it('leaves excluded entries out of the totals', async () => {
    const { context, grocery } = await seeded();
    await execute(context, 'spending.exclude', { entryId: grocery.id });

    const found = await summary(context);
    expect(found.total).toBe(7_300);
    expect(found.count).toBe(2);
  });
});

describe('spending.add', () => {
  it('adds a home-currency entry with the default time and a rule category', async () => {
    const context = await setupSpending();
    const view = await add(context, { merchant: '스타벅스', amount: 12_300, date: '2026-11-02' });

    expect(view).toMatchObject({
      merchant: '스타벅스',
      amount: 12_300,
      currency: 'KRW',
      category: '카페',
      date: '2026-11-02',
      time: '00:00',
      hasReceipt: false,
      estimated: false,
    });
    expect(view.original).toBeUndefined();
  });

  it('takes an owner category over a rule', async () => {
    const context = await setupSpending();
    const view = await add(context, {
      merchant: '동네가게',
      amount: 4_000,
      date: '2026-11-03',
      category: 'living',
    });

    expect(view.category).toBe('생활·공과금');
  });

  it('converts a foreign amount into the home currency', async () => {
    const context = await setupSpending();
    const view = await add(context, {
      merchant: 'Example Shop',
      amount: 12.34,
      currency: 'USD',
      date: '2026-11-12',
    });

    expect(view).toMatchObject({ amount: 17_276, currency: 'KRW', estimated: true });
    expect(view.original).toEqual({ amount: 12.34, currency: 'USD' });
  });

  it('refuses a non-positive amount', async () => {
    const context = await setupSpending();
    const outcome = await context.ctx.tools.execute('spending.add', {
      merchant: '스타벅스',
      amount: 0,
      date: '2026-11-02',
    });

    expect(outcome.status).toBe('invalid_input');
  });
});

describe('spending.set_category', () => {
  it('changes one entry and can leave the merchant label alone', async () => {
    const context = await setupSpending();
    const view = await add(context, { merchant: '스타벅스', amount: 12_300, date: '2026-11-02' });

    const result = (await execute(context, 'spending.set_category', {
      entryId: view.id,
      category: 'food',
      remember: false,
    })) as { updated: number; entries: SpendEntryView[] };

    expect(result.updated).toBe(1);
    expect(result.entries[0]?.category).toBe('식비');
    const next = await add(context, { merchant: '스타벅스', amount: 5_000, date: '2026-11-04' });
    expect(next.category).toBe('카페');
  });

  it('updates the merchant entries and remembers the choice', async () => {
    const { context } = await seeded();

    const result = (await execute(context, 'spending.set_category', {
      merchant: '스타벅스',
      category: 'food',
    })) as { updated: number; entries: SpendEntryView[] };

    expect(result.updated).toBe(2);
    expect(result.entries.every((entry) => entry.category === '식비')).toBe(true);
    const next = await add(context, { merchant: '스타벅스', amount: 5_000, date: '2026-11-04' });
    expect(next.category).toBe('식비');
  });

  it('requires an entry or a merchant', async () => {
    const context = await setupSpending();
    const outcome = await context.ctx.tools.execute('spending.set_category', { category: 'food' });

    expect(outcome.status).toBe('invalid_input');
  });
});

describe('spending.exclude', () => {
  it('hides an entry and reports what changed', async () => {
    const context = await setupSpending();
    const view = await add(context, { merchant: '스타벅스', amount: 12_300, date: '2026-11-02' });

    const result = (await execute(context, 'spending.exclude', { entryId: view.id })) as {
      id: string;
      merchant: string;
      excluded: boolean;
    };

    expect(result).toEqual({ id: view.id, merchant: '스타벅스', excluded: true });
  });

  it('fails for an unknown entry', async () => {
    const context = await setupSpending();
    const outcome = await context.ctx.tools.execute('spending.exclude', { entryId: 'missing' });

    expect(outcome.status).toBe('failed');
  });
});

describe('tool metadata', () => {
  it('declares read effects for lookups and write effects for changes', async () => {
    const context = await setupSpending();
    expect(registeredTool(context, 'spending.list')?.effects).toEqual(['read']);
    expect(registeredTool(context, 'spending.summary')?.effects).toEqual(['read']);
    expect(registeredTool(context, 'spending.add')?.effects).toEqual(['write']);
    expect(registeredTool(context, 'spending.set_category')?.effects).toEqual(['write']);
    expect(registeredTool(context, 'spending.exclude')?.effects).toEqual(['write']);
  });

  it('describes what each write will do before it runs', async () => {
    const context = await setupSpending();
    const view = await add(context, { merchant: '스타벅스', amount: 12_300, date: '2026-11-02' });

    expect(registeredTool(context, 'spending.add')?.describe?.({
      merchant: '스타벅스',
      amount: 12_300,
      date: '2026-11-02',
      category: 'cafe',
    })).toBe('지출 추가: 스타벅스 12,300원 · 카페');

    expect(registeredTool(context, 'spending.set_category')?.describe?.({
      merchant: '스타벅스',
      category: 'food',
    })).toBe('분류 변경: 스타벅스 → 식비');

    expect(registeredTool(context, 'spending.exclude')?.describe?.({ entryId: view.id, excluded: true }))
      .toBe('지출에서 제외: 스타벅스 12,300원');
  });

  it('uses the same descriptions in English', async () => {
    const context = await setupSpending({ assistant: { language: 'en' } });
    const view = await add(context, { merchant: 'Example Shop', amount: 12.34, date: '2026-11-12' });

    expect(view).toMatchObject({ currency: 'USD', amount: 12.34, category: 'Other' });
    expect(registeredTool(context, 'spending.add')?.describe?.({
      merchant: 'Example Shop',
      amount: 12.34,
      date: '2026-11-12',
    })).toBe('Add spend: Example Shop USD 12.34');
  });
});
