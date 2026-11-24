import { describe, expect, it } from 'vitest';
import { ymdOf } from '../../../src/core/time/local-day.js';
import type { SubscriptionCharge } from '../../../src/skills/spending/subscriptions.js';
import { addMonthsLocal, detectSubscriptions } from '../../../src/skills/spending/subscriptions.js';

const TZ = 'Asia/Seoul';

function charge(at: string, amount: number, merchant = '넷플릭스'): SubscriptionCharge {
  return {
    at: new Date(at),
    merchant,
    merchantKey: merchant,
    amount,
    currency: 'KRW',
  };
}

function detect(charges: SubscriptionCharge[], now = '2026-04-01T00:00:00+09:00') {
  return detectSubscriptions(charges, new Date(now), TZ);
}

describe('detectSubscriptions', () => {
  it('detects a monthly plan and keeps a price rise as the same subscription', () => {
    const found = detect([
      charge('2026-01-15T10:00:00+09:00', 10_000),
      charge('2026-02-15T10:00:00+09:00', 10_000),
      charge('2026-03-15T10:00:00+09:00', 13_000),
    ], '2026-03-20T00:00:00+09:00');

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      key: '넷플릭스:monthly',
      merchant: '넷플릭스',
      cadence: 'monthly',
      amount: 13_000,
      prevAmount: 10_000,
      charges: 3,
      lapsed: false,
    });
    expect(ymdOf(found[0]?.nextAt ?? new Date(0), TZ)).toBe('2026-04-15');
  });

  it('detects a yearly plan and adds twelve months', () => {
    const found = detect([
      charge('2025-03-10T09:00:00+09:00', 120_000),
      charge('2026-03-10T09:00:00+09:00', 120_000),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ cadence: 'yearly', charges: 2, prevAmount: 120_000 });
    expect(ymdOf(found[0]?.nextAt ?? new Date(0), TZ)).toBe('2027-03-10');
  });

  it('drops the same amount announced twice within three days', () => {
    const found = detect([
      charge('2026-01-10T09:00:00+09:00', 10_000),
      charge('2026-01-12T09:00:00+09:00', 10_000),
      charge('2026-02-10T09:00:00+09:00', 10_000),
    ], '2026-02-20T00:00:00+09:00');

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ charges: 2, cadence: 'monthly' });
    expect(found[0]?.firstAt.toISOString()).toBe(new Date('2026-01-10T09:00:00+09:00').toISOString());
  });

  it('ignores irregular gaps', () => {
    const found = detect([
      charge('2026-01-01T09:00:00+09:00', 10_000),
      charge('2026-01-11T09:00:00+09:00', 10_000),
      charge('2026-03-01T09:00:00+09:00', 10_000),
    ]);
    expect(found).toEqual([]);
  });

  it('ignores a single charge, even in an AI or infra category', () => {
    expect(detect([charge('2026-03-01T09:00:00+09:00', 30_000, 'OpenAI')])).toEqual([]);
  });

  it('marks a subscription whose next date is long past as lapsed', () => {
    const found = detect([
      charge('2026-01-15T10:00:00+09:00', 10_000),
      charge('2026-02-15T10:00:00+09:00', 10_000),
    ], '2026-04-01T00:00:00+09:00');

    expect(found[0]?.lapsed).toBe(true);
  });

  it('clamps a 31st charge to the end of February', () => {
    const found = detect([
      charge('2025-12-31T10:00:00+09:00', 10_000),
      charge('2026-01-31T10:00:00+09:00', 10_000),
    ], '2026-02-01T00:00:00+09:00');

    expect(found[0]?.cadence).toBe('monthly');
    expect(ymdOf(found[0]?.nextAt ?? new Date(0), TZ)).toBe('2026-02-28');
  });

  it('clamps a 31st charge to 29 February in a leap year', () => {
    const found = detect([
      charge('2027-12-31T10:00:00+09:00', 10_000),
      charge('2028-01-31T10:00:00+09:00', 10_000),
    ], '2028-02-01T00:00:00+09:00');

    expect(ymdOf(found[0]?.nextAt ?? new Date(0), TZ)).toBe('2028-02-29');
  });
});

describe('addMonthsLocal', () => {
  it('keeps the wall-clock time and clamps the day in the owner zone', () => {
    const from = new Date('2026-01-31T23:30:00+09:00');
    const next = addMonthsLocal(from, 1, TZ);
    expect(ymdOf(next, TZ)).toBe('2026-02-28');
    expect(next.toISOString()).toBe(new Date('2026-02-28T23:30:00+09:00').toISOString());
  });

  it('adds twelve months for a yearly plan', () => {
    const next = addMonthsLocal(new Date('2026-03-10T09:00:00+09:00'), 12, TZ);
    expect(next.toISOString()).toBe(new Date('2027-03-10T09:00:00+09:00').toISOString());
  });
});
