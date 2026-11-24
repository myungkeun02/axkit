import { describe, expect, it } from 'vitest';
import type { SpendEntry } from '../../../src/core/contracts/index.js';
import type { PatternInput } from '../../../src/skills/spending/patterns.js';
import { monthPatterns, timeBandOf } from '../../../src/skills/spending/patterns.js';

let sequence = 0;

function entry(overrides: Partial<SpendEntry> & { at: string; amount: number }): SpendEntry {
  sequence += 1;
  return {
    id: `e${sequence}`,
    merchant: '동네가게',
    merchantKey: '동네가게',
    currency: 'KRW',
    originalAmount: overrides.amount,
    source: 'sms',
    category: 'food',
    categorySource: 'rule',
    ...overrides,
    at: overrides.at,
    amount: overrides.amount,
  };
}

function patterns(overrides: Partial<PatternInput> = {}) {
  return monthPatterns({
    month: '2026-11',
    entries: [],
    previous: [],
    history: [],
    timeZone: 'Asia/Seoul',
    currency: 'KRW',
    largeAmount: 100_000,
    ...overrides,
  });
}

describe('monthPatterns totals', () => {
  it('nets cancellations, sums by category and lists top merchants', () => {
    const result = patterns({
      entries: [
        entry({ at: '2026-11-02T10:00:00+09:00', amount: 12_000, category: 'cafe', merchant: '스타벅스', merchantKey: '스타벅스' }),
        entry({ at: '2026-11-05T19:00:00+09:00', amount: 50_000, category: 'groceries', merchant: '이마트', merchantKey: '이마트' }),
        entry({ at: '2026-11-10T12:00:00+09:00', amount: -5_000, category: 'cafe', merchant: '스타벅스', merchantKey: '스타벅스' }),
      ],
      previous: [
        entry({ at: '2026-10-04T10:00:00+09:00', amount: 30_000, category: 'groceries', merchant: '이마트', merchantKey: '이마트' }),
        entry({ at: '2026-10-05T10:00:00+09:00', amount: 10_000, category: 'cafe', merchant: '스타벅스', merchantKey: '스타벅스' }),
      ],
    });

    expect(result.total).toBe(57_000);
    expect(result.count).toBe(3);
    expect(result.previousTotal).toBe(40_000);
    expect(result.totalChangePercent).toBe(42.5);
    expect(result.byCategory.map((category) => [category.category, category.total, category.count])).toEqual([
      ['groceries', 50_000, 1],
      ['cafe', 7_000, 2],
    ]);
    expect(result.topMerchants.map((merchant) => [merchant.merchant, merchant.total, merchant.count])).toEqual([
      ['이마트', 50_000, 1],
      ['스타벅스', 7_000, 2],
    ]);
  });

  it('reports a null change when the previous month had nothing', () => {
    const result = patterns({ entries: [entry({ at: '2026-11-02T10:00:00+09:00', amount: 1_000 })] });
    expect(result.previousTotal).toBe(0);
    expect(result.totalChangePercent).toBeNull();
  });
});

describe('monthPatterns weekday and time bands', () => {
  it('marks a weekend share in the owner zone', () => {
    const result = patterns({
      entries: [
        entry({ at: '2026-11-04T10:00:00+09:00', amount: 4_000 }),
        entry({ at: '2026-11-07T10:00:00+09:00', amount: 6_000 }),
      ],
    });

    expect(result.weekday).toEqual({ total: 4_000, share: 40 });
    expect(result.weekend).toEqual({ total: 6_000, share: 60 });
  });

  it.each([
    ['10:59', 'morning'],
    ['11:00', 'lunch'],
    ['13:59', 'lunch'],
    ['14:00', 'afternoon'],
    ['17:59', 'afternoon'],
    ['18:00', 'evening'],
    ['21:59', 'evening'],
    ['22:00', 'night'],
  ])('maps %s to %s', (time, band) => {
    expect(timeBandOf(new Date(`2026-11-02T${time}:00-05:00`), 'America/New_York')).toBe(band);
  });

  it('uses the owner zone, not UTC, for bands in New York', () => {
    const result = patterns({
      timeZone: 'America/New_York',
      entries: [
        entry({ at: '2026-11-02T10:30:00-05:00', amount: 1_000 }),
        entry({ at: '2026-11-02T11:30:00-05:00', amount: 1_000 }),
        entry({ at: '2026-11-02T15:00:00-05:00', amount: 1_000 }),
        entry({ at: '2026-11-02T19:00:00-05:00', amount: 1_000 }),
        entry({ at: '2026-11-02T23:30:00-05:00', amount: 1_000 }),
      ],
    });

    expect(result.bands.map((band) => [band.band, band.total, band.share])).toEqual([
      ['morning', 1_000, 20],
      ['lunch', 1_000, 20],
      ['afternoon', 1_000, 20],
      ['evening', 1_000, 20],
      ['night', 1_000, 20],
    ]);
  });
});

describe('monthPatterns category changes', () => {
  it('keeps only categories at least 5% of the month or changing at least 2x', () => {
    const result = patterns({
      entries: [
        entry({ at: '2026-11-02T10:00:00+09:00', amount: 100_000, category: 'food' }),
        entry({ at: '2026-11-03T10:00:00+09:00', amount: 1_000, category: 'cafe' }),
      ],
      previous: [
        entry({ at: '2026-10-02T10:00:00+09:00', amount: 50_000, category: 'food' }),
        entry({ at: '2026-10-03T10:00:00+09:00', amount: 1_000, category: 'cafe' }),
      ],
    });

    expect(result.changes.map((change) => change.category)).toEqual(['food']);
    expect(result.changes[0]).toMatchObject({ direction: 'up', change: 50_000, changePercent: 100 });
  });

  it('keeps a small category whose spending doubled', () => {
    const result = patterns({
      entries: [
        entry({ at: '2026-11-02T10:00:00+09:00', amount: 100_000, category: 'food' }),
        entry({ at: '2026-11-03T10:00:00+09:00', amount: 3_000, category: 'education' }),
      ],
      previous: [
        entry({ at: '2026-10-02T10:00:00+09:00', amount: 100_000, category: 'food' }),
        entry({ at: '2026-10-03T10:00:00+09:00', amount: 1_000, category: 'education' }),
      ],
    });

    expect(result.changes.map((change) => [change.category, change.direction])).toEqual([
      ['education', 'up'],
    ]);
  });
});

describe('monthPatterns unusual entries', () => {
  const history = [
    entry({ at: '2026-08-10T10:00:00+09:00', amount: 5_000, category: 'cafe' }),
    entry({ at: '2026-09-10T10:00:00+09:00', amount: 5_000, category: 'cafe' }),
    entry({ at: '2026-10-10T10:00:00+09:00', amount: 5_000, category: 'cafe' }),
  ];

  it('flags an amount at least three times the category median and above the config threshold', () => {
    const result = patterns({
      history,
      largeAmount: 10_000,
      entries: [entry({ at: '2026-11-10T10:00:00+09:00', amount: 20_000, category: 'cafe' })],
    });

    expect(result.unusual).toHaveLength(1);
    expect(result.unusual[0]).toMatchObject({ median: 5_000 });
  });

  it('does not flag a large amount below the configured threshold', () => {
    const result = patterns({
      history,
      largeAmount: 100_000,
      entries: [entry({ at: '2026-11-10T10:00:00+09:00', amount: 20_000, category: 'cafe' })],
    });

    expect(result.unusual).toEqual([]);
  });

  it('does not flag a category with no history', () => {
    const result = patterns({
      history,
      largeAmount: 10_000,
      entries: [entry({ at: '2026-11-10T10:00:00+09:00', amount: 50_000, category: 'travel' })],
    });

    expect(result.unusual).toEqual([]);
  });
});

describe('monthPatterns duplicates and FX', () => {
  it('flags the same merchant, amount and local day seen from two card sources', () => {
    const result = patterns({
      entries: [
        entry({ at: '2026-11-03T10:00:00+09:00', amount: 5_000, merchant: '카페 예시', merchantKey: '카페예시', source: 'sms' }),
        entry({ at: '2026-11-03T15:00:00+09:00', amount: 5_000, merchant: '카페 예시', merchantKey: '카페예시', source: 'app' }),
        entry({ at: '2026-11-03T16:00:00+09:00', amount: 5_000, merchant: '카페 예시', merchantKey: '카페예시', source: 'manual' }),
      ],
    });

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]).toMatchObject({ amount: 5_000, ymd: '2026-11-03' });
    expect(result.duplicates[0]?.entries.map((found) => found.source)).toEqual(['sms', 'app']);
  });

  it('does not flag a manual entry or a different amount', () => {
    const result = patterns({
      entries: [
        entry({ at: '2026-11-03T10:00:00+09:00', amount: 5_000, source: 'sms' }),
        entry({ at: '2026-11-03T11:00:00+09:00', amount: 6_000, source: 'app' }),
        entry({ at: '2026-11-04T10:00:00+09:00', amount: 5_000, source: 'sms' }),
        entry({ at: '2026-11-04T11:00:00+09:00', amount: 5_000, source: 'mail' }),
      ],
    });

    expect(result.duplicates).toEqual([]);
  });

  it('counts FX-estimated entries', () => {
    const result = patterns({
      entries: [
        entry({ at: '2026-11-03T10:00:00+09:00', amount: 5_000, fxEstimated: true }),
        entry({ at: '2026-11-04T10:00:00+09:00', amount: 5_000 }),
      ],
    });

    expect(result.fxEstimatedCount).toBe(1);
  });
});
