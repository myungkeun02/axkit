import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { monthRange } from '../../../src/core/time/local-day.js';
import { LABEL_JOB, MAIL_JOB } from '../../../src/skills/spending/intake.js';
import { ScriptedLlm } from '../../support/context.js';
import { FakeMailReader, mailMessage, notice, setupSpending, spendReader, TIME_ZONE } from './helpers.js';

async function entries(context: Awaited<ReturnType<typeof setupSpending>>) {
  return spendReader(context).entries(monthRange('2026-11', TIME_ZONE));
}

describe('money.notice intake', () => {
  it('turns a card SMS into a classified ledger entry', async () => {
    const context = await setupSpending();
    await context.bus.emit('money.notice', notice({
      text: '[Web발신] 신한카드(1234)승인 12,300원(일시불)11/02 12:34 스타벅스 누적 456,780원',
    }));

    const [entry] = await entries(context);
    expect(entry).toMatchObject({
      merchant: '스타벅스',
      amount: 12_300,
      currency: 'KRW',
      originalAmount: 12_300,
      card: '신한카드',
      source: 'sms',
      category: 'cafe',
      categorySource: 'rule',
    });
    expect(entry?.at).toBe(new Date('2026-11-02T12:34:00+09:00').toISOString());
  });

  it('converts an overseas charge with the stated home amount', async () => {
    const context = await setupSpending();
    await context.bus.emit('money.notice', notice({
      text: '신한카드(1234)승인 해외 USD 12.34 (원화 17,276원) 11/02 12:34 스타벅스',
    }));

    const [entry] = await entries(context);
    expect(entry).toMatchObject({
      amount: 17_276,
      currency: 'USD',
      originalAmount: 12.34,
      fxEstimated: false,
    });
  });

  it('estimates the home amount from the configured rate', async () => {
    const context = await setupSpending();
    await context.bus.emit('money.notice', notice({
      text: '신한카드(1234)승인 해외 USD 12.34 11/02 12:34 스타벅스',
    }));

    const [entry] = await entries(context);
    expect(entry).toMatchObject({ amount: 17_276, fxEstimated: true });
  });

  it('stores a cancellation as a negative entry', async () => {
    const context = await setupSpending();
    await context.bus.emit('money.notice', notice({
      text: '신한카드(1234)취소 12,300원 11/02 12:34 스타벅스',
    }));

    const [entry] = await entries(context);
    expect(entry).toMatchObject({ amount: -12_300, originalAmount: -12_300 });
  });

  it('never stores the card number that arrived in the message', async () => {
    const context = await setupSpending();
    await context.bus.emit('money.notice', notice({
      text: '[Web발신] 신한카드(1234)승인 12,300원(일시불)11/02 12:34 스타벅스 1234-****-****-5678',
    }));

    const stored = JSON.stringify(await context.kv.get('entries:2026-11'));
    expect(stored).not.toContain('****');
    expect((await entries(context))[0]).toMatchObject({ merchant: '스타벅스', card: '신한카드' });
  });

  it('ignores text that is not a payment notice', async () => {
    const context = await setupSpending();
    await context.bus.emit('money.notice', notice({ text: '오늘 저녁에 봐요' }));

    expect(await entries(context)).toHaveLength(0);
  });
});

describe('receipt mail scan', () => {
  it('scans with a first-run wide window, then a short one, and skips seen mail', async () => {
    const mail = new FakeMailReader([
      mailMessage(),
      mailMessage({
        id: 'm2',
        from: 'Shop <news@example.com>',
        subject: 'Newsletter',
        body: 'order confirmation for our newsletter',
      }),
    ]);
    const context = await setupSpending({
      capabilities: { [Contracts.mailRead.id]: mail },
    });

    await context.scheduler.run(MAIL_JOB, new Date('2026-11-17T10:00:00+09:00'));
    await context.scheduler.run(MAIL_JOB, new Date('2026-11-17T11:00:00+09:00'));

    expect(mail.queries[0]?.sinceHours).toBe(720);
    expect(mail.queries[0]?.limit).toBe(30);
    expect(mail.queries[0]?.text).toContain('영수증');
    expect(mail.queries[1]?.sinceHours).toBe(72);

    const found = await entries(context);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ merchant: '카페 예시', amount: 12_300, source: 'mail', category: 'cafe' });
    expect(await context.kv.get('mail:lastScan')).toBe('2026-11-17T02:00:00.000Z');
  });

  it('merges a receipt mail into the card entry it matches', async () => {
    const mail = new FakeMailReader([
      mailMessage({
        id: 'm1',
        from: '스타벅스 <receipts@example.com>',
        subject: '주문 완료',
        body: '합계 12,300원',
        receivedAt: new Date('2026-11-02T12:34:00+09:00'),
      }),
    ]);
    const context = await setupSpending({ capabilities: { [Contracts.mailRead.id]: mail } });
    await context.bus.emit('money.notice', notice({
      text: '신한카드(1234)승인 12,300원 11/02 12:34 스타벅스',
    }));

    await context.scheduler.run(MAIL_JOB, new Date('2026-11-17T10:00:00+09:00'));

    const found = await entries(context);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ source: 'sms', hasReceipt: true, card: '신한카드' });
  });

  it('does nothing when no mail reader is available', async () => {
    const context = await setupSpending();

    await context.scheduler.run(MAIL_JOB, new Date('2026-11-17T10:00:00+09:00'));

    expect(await entries(context)).toHaveLength(0);
    expect(await context.kv.get('mail:lastScan')).toBeUndefined();
  });
});

describe('job wiring', () => {
  it('registers the mail and label jobs by default', async () => {
    const context = await setupSpending();

    expect(context.scheduler.jobs.has(MAIL_JOB)).toBe(true);
    expect(context.scheduler.jobs.has(LABEL_JOB)).toBe(true);
  });

  it('registers no scan job when the owner turned both off', async () => {
    const context = await setupSpending({ config: { mailScan: false, modelLabels: false } });

    expect(context.scheduler.jobs.has(MAIL_JOB)).toBe(false);
    expect(context.scheduler.jobs.has(LABEL_JOB)).toBe(false);
  });

  it('runs the model labeler through its job', async () => {
    const llm = new ScriptedLlm(['{"items":[{"merchant":"별빛상회","category":"shopping"}]}']);
    const context = await setupSpending({ llm });
    await context.bus.emit('money.notice', notice({
      text: '신한카드(1234)승인 12,300원 11/02 12:34 별빛상회',
    }));

    await context.scheduler.run(LABEL_JOB);

    expect(llm.requests).toHaveLength(1);
    expect((await entries(context))[0]).toMatchObject({ category: 'shopping', categorySource: 'model' });
  });
});
