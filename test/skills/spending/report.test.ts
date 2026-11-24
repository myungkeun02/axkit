import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { TestContext } from '../../support/context.js';
import type { TestContextOptions } from '../../support/context.js';
import { FakeNotifier, setupSpending } from './helpers.js';

const DEC_FIRST = new Date('2026-12-01T09:00:00+09:00');

async function setup(
  options: TestContextOptions = {},
): Promise<{ context: TestContext; notifier: FakeNotifier }> {
  const notifier = new FakeNotifier();
  const context = await setupSpending({
    ...options,
    now: options.now ?? DEC_FIRST,
    capabilities: { [Contracts.notifier.id]: notifier, ...(options.capabilities ?? {}) },
  });
  return { context, notifier };
}

async function add(
  context: TestContext,
  input: { merchant: string; amount: number; date: string; currency?: string; category?: string },
): Promise<void> {
  const outcome = await context.ctx.tools.execute('spending.add', input);
  if (outcome.status !== 'done') throw new Error(JSON.stringify(outcome));
}

async function seedNovember(context: TestContext): Promise<void> {
  await add(context, { merchant: '스타벅스', amount: 12_300, date: '2026-11-02' });
  await add(context, { merchant: '이마트', amount: 50_000, date: '2026-11-05' });
  await add(context, { merchant: '이마트', amount: 30_000, date: '2026-10-20' });
}

describe('spending.report job', () => {
  it('reports the previous month on the first local day', async () => {
    const { context, notifier } = await setup();
    await seedNovember(context);

    await context.scheduler.run('spending.report', DEC_FIRST);

    expect(context.scheduler.jobs.has('spending.report')).toBe(true);
    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice).toMatchObject({ kind: 'spending.report', dedupeKey: '2026-11' });
    const text = notice?.text ?? '';
    expect(text).toContain('11월 지출');
    expect(text).toContain('총 62,300원');
    expect(text).toContain('지난달보다 107.7% 늘었어요');
    expect(text).toContain('많이 쓴 분류: 장보기 50,000원 · 카페 12,300원');
    expect(text).toContain('많이 쓴 곳: 이마트 50,000원 · 스타벅스 12,300원');
  });

  it('sends only once per month', async () => {
    const { context, notifier } = await setup();
    await seedNovember(context);

    await context.scheduler.run('spending.report', DEC_FIRST);
    await context.scheduler.run('spending.report', DEC_FIRST);

    expect(notifier.notices).toHaveLength(1);
  });

  it('says nothing when the month has no entries', async () => {
    const { context, notifier } = await setup();

    await context.scheduler.run('spending.report', DEC_FIRST);

    expect(notifier.notices).toEqual([]);
  });

  it('says nothing on any other day', async () => {
    const second = new Date('2026-12-02T09:00:00+09:00');
    const { context, notifier } = await setup({ now: second });
    await seedNovember(context);

    await context.scheduler.run('spending.report', second);

    expect(notifier.notices).toEqual([]);
  });

  it('counts FX-estimated charges and large entries', async () => {
    const { context, notifier } = await setup({ config: { largeAmount: 10_000 } });
    await add(context, { merchant: 'Example Shop', amount: 12.34, currency: 'USD', date: '2026-11-12' });
    for (const month of ['08', '09', '10']) {
      await add(context, { merchant: '스타벅스', amount: 5_000, date: `2026-${month}-10` });
    }
    await add(context, { merchant: '스타벅스', amount: 20_000, date: '2026-11-10' });

    await context.scheduler.run('spending.report', DEC_FIRST);

    const text = notifier.notices[0]?.text ?? '';
    expect(text).toContain('큰 지출: 11/10 스타벅스 20,000원');
    expect(text).toContain('환율로 계산한 지출 1건');
  });

  it('uses English text for an English assistant', async () => {
    const { context, notifier } = await setup({ assistant: { language: 'en' } });
    await seedNovember(context);

    await context.scheduler.run('spending.report', DEC_FIRST);

    const text = notifier.notices[0]?.text ?? '';
    expect(text).toContain('November 2026 spending');
    expect(text).toContain('Total USD');
  });
});
