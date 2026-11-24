import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { receiptsSkill } from '../../../src/skills/receipts/plugin.js';
import { addEntry } from '../../../src/skills/receipts/store.js';
import { createTestContext } from '../../support/context.js';
import { FakeNotifier, FakeSpend, FakeVaultFs, MONTH_END, spendEntry, docEntry } from './helpers.js';

const LAST_DAY = MONTH_END;
const NOT_LAST_DAY = new Date('2026-11-29T20:30:00+09:00');

async function setup(options: {
  config?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  language?: string;
} = {}) {
  const context = createTestContext({
    now: LAST_DAY,
    config: options.config ?? {},
    capabilities: options.capabilities ?? {},
    ...(options.language !== undefined ? { assistant: { language: options.language } } : {}),
  });
  await receiptsSkill({ fs: new FakeVaultFs() }).setup(context.ctx);
  return context;
}

describe('receipts.monthend scheduling', () => {
  it('registers a daily check at 20:30 by default', async () => {
    const { scheduler } = await setup();
    expect(scheduler.jobs.get('receipts.monthend')?.schedule).toEqual({ kind: 'daily', at: '20:30' });
  });

  it('reads the configured time', async () => {
    const { scheduler } = await setup({ config: { monthEndAt: '21:00' } });
    expect(scheduler.jobs.get('receipts.monthend')?.schedule).toEqual({ kind: 'daily', at: '21:00' });
  });

  it('does nothing on any day except the last local day of the month', async () => {
    const notifier = new FakeNotifier();
    const { ctx, scheduler } = await setup({ capabilities: { [Contracts.notifier.id]: notifier } });
    await addEntry(ctx.kv, '2026-11', docEntry());

    await scheduler.run('receipts.monthend', NOT_LAST_DAY);
    expect(notifier.notices).toHaveLength(0);
  });
});

describe('receipts.monthend summary', () => {
  it('reports counts, receipt sums and charges with no matching document', async () => {
    const notifier = new FakeNotifier();
    const spend = new FakeSpend([
      spendEntry({
        id: 'e1',
        at: '2026-11-03T12:00:00+09:00',
        merchant: '카페 예시',
        merchantKey: '카페예시',
        amount: 99_000,
        originalAmount: 99_000,
      }),
      spendEntry({
        id: 'e2',
        at: '2026-11-06T12:00:00+09:00',
        merchant: '편의점',
        merchantKey: '편의점',
        amount: 50_000,
        originalAmount: 50_000,
      }),
      spendEntry({
        id: 'e3',
        at: '2026-11-12T12:00:00+09:00',
        merchant: '서점',
        merchantKey: '서점',
        amount: 40_000,
        originalAmount: 40_000,
      }),
      spendEntry({ id: 'e4', at: '2026-11-13T12:00:00+09:00', amount: 20_000, originalAmount: 20_000 }),
      spendEntry({
        id: 'e5',
        at: '2026-11-14T12:00:00+09:00',
        amount: 50_000,
        originalAmount: 50_000,
        hasReceipt: true,
      }),
    ]);
    const { ctx, scheduler } = await setup({
      capabilities: { [Contracts.notifier.id]: notifier, [Contracts.spendRead.id]: spend },
    });
    await addEntry(
      ctx.kv,
      '2026-11',
      docEntry({ at: '2026-11-03T12:00:00+09:00', amount: 12_345, merchantKey: '카페예시' }),
    );
    await addEntry(
      ctx.kv,
      '2026-11',
      docEntry({ id: 'doc-2', mailId: 'mail-2', at: '2026-11-05T12:00:00+09:00', amount: 20_000, merchantKey: '서점' }),
    );
    await addEntry(
      ctx.kv,
      '2026-11',
      docEntry({
        id: 'doc-3',
        mailId: 'mail-3',
        kind: 'invoice',
        at: '2026-11-06T12:00:00+09:00',
        amount: 50_000,
        merchantKey: '호스팅',
      }),
    );

    await scheduler.run('receipts.monthend', LAST_DAY);

    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0]!;
    expect(notice.kind).toBe('receipts.monthend');
    expect(notice.dedupeKey).toBe('2026-11');
    expect(notice.text).toContain('2026-11 서류 정리');
    expect(notice.text).toContain('영수증 2건');
    expect(notice.text).toContain('인보이스 1건');
    expect(notice.text).toContain('영수증 합계: 32,345원');
    expect(notice.text).toContain('메일 영수증을 못 찾은 결제');
    expect(notice.text).toContain('- 11/12 서점 40,000원');
    expect(notice.text).toContain('오프라인 결제라 메일 영수증이 없을 수 있어요.');
    expect(notice.text).not.toContain('99,000원');
  });

  it('matches merchant keys in either direction', async () => {
    const notifier = new FakeNotifier();
    const spend = new FakeSpend([
      spendEntry({
        id: 'e1',
        at: '2026-11-10T12:00:00+09:00',
        merchantKey: '카페',
        amount: 50_000,
        originalAmount: 50_000,
      }),
      spendEntry({
        id: 'e2',
        at: '2026-11-11T12:00:00+09:00',
        merchantKey: '카페예시',
        amount: 60_000,
        originalAmount: 60_000,
      }),
    ]);
    const { ctx, scheduler } = await setup({
      capabilities: { [Contracts.notifier.id]: notifier, [Contracts.spendRead.id]: spend },
    });
    await addEntry(ctx.kv, '2026-11', docEntry({ at: '2026-11-10T12:00:00+09:00', amount: 100, merchantKey: '카페예시' }));
    await addEntry(
      ctx.kv,
      '2026-11',
      docEntry({ id: 'doc-2', mailId: 'mail-2', at: '2026-11-11T12:00:00+09:00', amount: 100, merchantKey: '카페' }),
    );

    await scheduler.run('receipts.monthend', LAST_DAY);

    expect(notifier.notices[0]?.text).not.toContain('메일 영수증을 못 찾은 결제');
  });

  it('only looks within three days of the charge', async () => {
    const notifier = new FakeNotifier();
    const spend = new FakeSpend([
      spendEntry({
        id: 'inside',
        at: '2026-11-06T12:00:00+09:00',
        merchant: '마트',
        merchantKey: '마트',
        amount: 70_000,
        originalAmount: 70_000,
      }),
      spendEntry({
        id: 'outside',
        at: '2026-11-05T12:00:00+09:00',
        merchant: '문구점',
        merchantKey: '문구점',
        amount: 80_000,
        originalAmount: 80_000,
      }),
    ]);
    const { ctx, scheduler } = await setup({
      capabilities: { [Contracts.notifier.id]: notifier, [Contracts.spendRead.id]: spend },
    });
    await addEntry(ctx.kv, '2026-11', docEntry({ at: '2026-11-09T12:00:00+09:00', amount: 100, merchantKey: '마트' }));

    await scheduler.run('receipts.monthend', LAST_DAY);

    const text = notifier.notices[0]?.text ?? '';
    expect(text).toContain('- 11/05 문구점 80,000원');
    expect(text).not.toContain('11/06 마트');
  });

  it('lists at most ten missing charges', async () => {
    const notifier = new FakeNotifier();
    const spend = new FakeSpend(
      Array.from({ length: 12 }, (_, index) =>
        spendEntry({
          id: `missing-${index}`,
          at: `2026-11-${String(index + 1).padStart(2, '0')}T12:00:00+09:00`,
          merchant: `가게${index}`,
          merchantKey: `가게${index}`,
          amount: 40_000,
          originalAmount: 40_000,
        }),
      ),
    );
    const { scheduler } = await setup({
      capabilities: { [Contracts.notifier.id]: notifier, [Contracts.spendRead.id]: spend },
    });

    await scheduler.run('receipts.monthend', LAST_DAY);

    const lines = (notifier.notices[0]?.text ?? '').split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(10);
  });

  it('uses a configured minimum and the home-currency default', async () => {
    const notifier = new FakeNotifier();
    const spend = new FakeSpend([
      spendEntry({ id: 'custom', at: '2026-11-12T12:00:00+09:00', amount: 5_000, originalAmount: 5_000 }),
    ]);
    const { ctx, scheduler } = await setup({
      config: { missingMin: 100 },
      capabilities: { [Contracts.notifier.id]: notifier, [Contracts.spendRead.id]: spend },
    });
    await addEntry(ctx.kv, '2026-11', docEntry({ at: '2026-11-01T12:00:00+09:00', amount: 100, merchantKey: '다른곳' }));

    await scheduler.run('receipts.monthend', LAST_DAY);
    expect(notifier.notices[0]?.text).toContain('- 11/12 카페 예시 5,000원');

    const usdNotifier = new FakeNotifier();
    const usdSpend = new FakeSpend(
      [
        spendEntry({
          id: 'forty',
          at: '2026-11-12T12:00:00+09:00',
          amount: 40,
          originalAmount: 40,
          currency: 'USD',
        }),
        spendEntry({
          id: 'twenty',
          at: '2026-11-13T12:00:00+09:00',
          merchant: '작은 가게',
          merchantKey: '작은가게',
          amount: 20,
          originalAmount: 20,
          currency: 'USD',
        }),
      ],
      'USD',
    );
    const second = await setup({
      capabilities: { [Contracts.notifier.id]: usdNotifier, [Contracts.spendRead.id]: usdSpend },
    });
    await addEntry(
      second.ctx.kv,
      '2026-11',
      docEntry({ at: '2026-11-01T12:00:00+09:00', amount: 1, merchantKey: '다른곳' }),
    );
    await second.scheduler.run('receipts.monthend', LAST_DAY);

    expect(usdNotifier.notices[0]?.text).toContain('- 11/12 카페 예시 40 USD');
    expect(usdNotifier.notices[0]?.text).not.toContain('작은 가게');
  });

  it('deduplicates once per month', async () => {
    const notifier = new FakeNotifier();
    const { ctx, scheduler } = await setup({ capabilities: { [Contracts.notifier.id]: notifier } });
    await addEntry(ctx.kv, '2026-11', docEntry());

    await scheduler.run('receipts.monthend', LAST_DAY);
    await scheduler.run('receipts.monthend', LAST_DAY);

    expect(notifier.notices).toHaveLength(1);
    expect(await ctx.kv.get('monthEndSent:2026-11')).toBe(true);
  });

  it('says nothing when there are no documents and no missing charges', async () => {
    const notifier = new FakeNotifier();
    const { scheduler } = await setup({ capabilities: { [Contracts.notifier.id]: notifier } });

    await scheduler.run('receipts.monthend', LAST_DAY);
    expect(notifier.notices).toHaveLength(0);
  });

  it('still reports documents when spending data is unavailable', async () => {
    const notifier = new FakeNotifier();
    const spend = new FakeSpend([], 'KRW', true);
    const { ctx, scheduler } = await setup({
      capabilities: { [Contracts.notifier.id]: notifier, [Contracts.spendRead.id]: spend },
    });
    await addEntry(ctx.kv, '2026-11', docEntry());

    await scheduler.run('receipts.monthend', LAST_DAY);

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.text).toContain('영수증 1건');
    expect(notifier.notices[0]?.text).not.toContain('메일 영수증을 못 찾은 결제');
  });

  it('uses English text for an English assistant', async () => {
    const notifier = new FakeNotifier();
    const { ctx, scheduler } = await setup({
      language: 'en',
      capabilities: { [Contracts.notifier.id]: notifier },
    });
    await addEntry(ctx.kv, '2026-11', docEntry({ amount: 12_345 }));

    await scheduler.run('receipts.monthend', LAST_DAY);

    const text = notifier.notices[0]?.text ?? '';
    expect(text).toContain('Documents for 2026-11');
    expect(text).toContain('Receipts: 1');
    expect(text).toContain('Receipts total: 12,345 KRW');
  });
});
